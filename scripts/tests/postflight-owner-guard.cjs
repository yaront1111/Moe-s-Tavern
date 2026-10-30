// Owner guard (scripts/CLAUDE.md): a session whose task another worker now owns
// lands none of its bytes while that owner is protected or finalizing; an
// unassigned or dead-owner task still checkpoints. One case list for both wrappers:
//   node postflight-owner-guard.cjs <sh|ps1> <wrapper> <fake-proxy> <parent-tmp> <engine>
// Each case is a fresh repository and real wrapper run(s) against the fake's
// ownership knobs. MOE_OWNER_GUARD_ONLY=<case,...> runs a subset,
// MOE_KEEP_OWNER_GUARD_FIXTURE=1 keeps the fixture; `<this file> cli` is the fake CLI.
'use strict';
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),cp=require('node:child_process'),
  crypto=require('node:crypto'),assert=require('node:assert/strict');
const TASK='task-postflight',OWNED='owned-a.txt',BYTES='live owner bytes\n';
const ACTIVE='MOE_COMMIT_REFUSED_ACTIVE_ASSIGNEE',UNKNOWN='MOE_COMMIT_REFUSED_OWNER_UNKNOWN';
const read=f=>fs.readFileSync(f,'utf8');
const write=(f,b)=>{fs.mkdirSync(path.dirname(f),{recursive:true});fs.writeFileSync(f,b);};
const rows=f=>fs.existsSync(f)?read(f).trim().split('\n').filter(Boolean).map(JSON.parse):[];
function git(dir,...a){
  const r=cp.spawnSync('git',['-C',dir,...a],{encoding:'utf8',env:{...process.env,GIT_OPTIONAL_LOCKS:'0'}});
  assert.equal(r.status,0,`git ${a.join(' ')}: ${r.stderr}`);return r.stdout;
}
// Everything a refused landing must leave exactly as it found it.
function snapshot(dir){
  const baseline=path.join(dir,'.git','moe','baseline',TASK+'.tsv');
  return {refs:git(dir,'for-each-ref','--format=%(refname) %(objectname)'),head:git(dir,'symbolic-ref','HEAD'),
    index:git(dir,'ls-files','-s'),status:git(dir,'status','--porcelain=v1','-uall','--','.',':(exclude).moe'),
    owned:crypto.createHash('sha256').update(fs.readFileSync(path.join(dir,OWNED))).digest('hex'),
    baseline:fs.existsSync(baseline)?read(baseline):null};
}

if(process.argv[2]==='cli'){
  // OG_CLI=write: the owner's bytes appear while this session runs, and the
  // session records what its exit must not change. OG_CLI=hold: signal ready and
  // wait for the go file; OG_WRITE=1 writes the bytes first, OG_FINALIZE=1 then
  // leaves this seat's attempt finalizing, as complete_task does.
  const dir=process.env.MOE_PROJECT_PATH,wid=process.env.OG_WID,moe=f=>path.join(dir,'.moe',f);
  if(process.env.OG_CLI==='write'||process.env.OG_WRITE==='1')fs.writeFileSync(path.join(dir,OWNED),BYTES);
  if(process.env.OG_CLI==='write')write(moe('og-cli-'+wid+'.json'),JSON.stringify(snapshot(dir)));
  if(process.env.OG_CLI==='hold'){
    write(moe('og-ready-'+wid),'ready');
    for(const end=Date.now()+150000;!fs.existsSync(moe('og-go-'+wid))&&Date.now()<end;)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,100);
    const file=moe('attempts/attempt-postflight.json'),a=process.env.OG_FINALIZE==='1'?JSON.parse(read(file)):null;
    if(a&&a.workerId===wid&&a.phase==='running'){a.phase='finalizing';fs.writeFileSync(file,JSON.stringify(a));}
  }
  process.exit(0);
}

const [platform,wrapper,proxy,parent,engine]=process.argv.slice(2),win=platform==='ps1',winHost=process.platform==='win32';
const LIMIT=Number(process.env.MOE_POSTFLIGHT_TIMEOUT_SEC||180)*1000;
const root=fs.mkdtempSync(path.join(parent,'owner guard '));
// Wrapper temp files go to a dir this suite deletes, never the shared temp dir.
const wrapperTmp=fs.mkdtempSync(path.join(os.tmpdir(),'moe-owner-guard-wrapper-'));
const inherited=Object.fromEntries(Object.entries(process.env).filter(([k])=>!/^(FAKE|OG)_/i.test(k)));
const ledger=(dir,wid)=>rows(path.join(dir,'.moe','record_commit.jsonl')).filter(r=>r.workerId===wid);
const ended=(dir,wid)=>fs.readdirSync(path.join(dir,'.moe','messages')).flatMap(f=>rows(path.join(dir,'.moe','messages',f)))
  .filter(m=>m.sender===wid&&String(m.content).includes(' session ended: task='+TASK)).map(m=>String(m.content));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

function project(name,record,attempts){
  const dir=path.join(root,name),remote=path.join(root,name+'-remote.git'),moe=f=>path.join(dir,'.moe',f);
  write(moe('project.json'),JSON.stringify({id:'proj-owner-guard',name:'Owner guard',settings:{}}));
  write(moe('tasks/'+TASK+'.json'),JSON.stringify({id:TASK,title:'Postflight smoke',status:'WORKING',filesModified:[OWNED],...record}));
  write(moe('messages/chan-general.jsonl'),'');
  write(moe('daemon.json'),JSON.stringify({port:9876,projectPath:dir}));
  write(path.join(dir,'seed.txt'),'seed\n');write(path.join(dir,OWNED),'base\n');
  git(dir,'init','-q');git(dir,'symbolic-ref','HEAD','refs/heads/master');
  for(const [k,v] of [['core.autocrlf','false'],['user.name','Moe Test'],['user.email','moe@test.local']])git(dir,'config',k,v);
  git(dir,'add','--','seed.txt',OWNED,'.moe/project.json','.moe/tasks/'+TASK+'.json');git(dir,'commit','-qm','seed');
  git(root,'init','-q','--bare',remote);git(dir,'remote','add','origin',remote);
  // A peer's staged entry: no landing may drop it from the shared index.
  write(path.join(dir,'peer-staged.txt'),'peer staged\n');git(dir,'add','--','peer-staged.txt');
  const stamp=new Date().toISOString();
  for(const a of attempts)write(moe('attempts/'+a.id+'.json'),JSON.stringify({generation:3,taskId:TASK,runnerId:a.workerId,
    workspace:dir,startedAt:stamp,lastPhaseAt:stamp,...a}));
  return {dir,remote,seed:git(dir,'rev-parse','HEAD').trim()};
}

function launch(dir,role,wid,knobs){
  const cli=path.join(root,'og-cli'+(win?'.cmd':'.sh'));
  if(!fs.existsSync(cli)){
    write(cli,win?`@echo off\r\nchcp 65001 >nul\r\nnode "${__filename}" cli\r\nexit /b %errorlevel%\r\n`
      :`#!/usr/bin/env bash\nexec node "${__filename.replaceAll('\\','/')}" cli\n`);
    fs.chmodSync(cli,0o700);
  }
  const args=win?['-NoProfile','-File',wrapper,'-Project',dir,'-WorkerId',wid,'-Role',role,'-Team','Smoke','-NoStartDaemon','-Command',cli,'-NoLoop','-PollInterval','0']
    :[wrapper,'--project',dir,'--worker-id',wid,'--role',role,'--team','Smoke','--no-start-daemon','--command',cli,'--no-loop','--poll-interval','0'];
  const env={...inherited,MOE_PROXY_PATH:proxy,MOE_NODE_COMMAND:process.execPath,MOE_DISABLE_HEARTBEAT:'1',
    HOME:path.join(root,'home'),USERPROFILE:path.join(root,'home'),TMPDIR:wrapperTmp,TMP:wrapperTmp,TEMP:wrapperTmp,
    FAKE_TASK_STATUS:'WORKING',OG_CLI:'write',OG_WID:wid,...knobs};
  const child=cp.spawn(engine,args,{env,stdio:['ignore','pipe','pipe'],detached:!winHost,windowsHide:true});
  let log='';child.stdout.on('data',d=>{log+=d;});child.stderr.on('data',d=>{log+=d;});
  const exited=new Promise(res=>child.on('close',(code,signal)=>res({code,signal})));
  return {child,exited,log:()=>log};
}
function killTree(run){
  if(run.child.exitCode!==null||run.child.signalCode!==null)return;
  if(winHost)cp.spawnSync('taskkill',['/T','/F','/PID',String(run.child.pid)],{stdio:'ignore'});
  else{try{process.kill(-run.child.pid,'SIGKILL');}catch{}}
}
async function finish(run,name){
  const timer=setTimeout(()=>killTree(run),LIMIT),{code,signal}=await run.exited;clearTimeout(timer);
  write(path.join(root,name+'.log'),run.log());
  assert.ok(code===0&&signal===null,`[${name}] wrapper exited ${code} (${signal})\n${run.log()}`);
  return run.log();
}
async function untilFile(file,run,name){
  for(const end=Date.now()+LIMIT;!fs.existsSync(file);await sleep(100)){
    assert.ok(Date.now()<end&&run.child.exitCode===null,`[${name}] no ${path.basename(file)}\n${run.log()}`);
  }
}

// A refusal moves no ref, commits, rescues and pushes nothing, keeps the tree,
// the shared index and the baseline, and says why: on the log, in the ledger
// (one refused row per landing it refused) and on the session-ended line.
function assertRefused(name,p,wid,role,code,before,log,landings=1){
  assert.deepEqual(snapshot(p.dir),before,`[${name}] a refused exit leaves refs, tree, index and baseline as they were\n${log}`);
  assert.equal(git(p.dir,'rev-parse','HEAD').trim(),p.seed,`[${name}] nothing is committed\n${log}`);
  assert.equal(git(p.remote,'for-each-ref'),'',`[${name}] nothing is pushed\n${log}`);
  const rec=ledger(p.dir,wid);
  assert.equal(rec.length,landings,`[${name}] one refused row per refused landing\n${JSON.stringify(rec)}\n${log}`);
  for(const r of rec){
    assert.deepEqual([r.taskId,r.outcome,r.kind,r.code,r.role],[TASK,'refused','checkpoint',code,role],`[${name}] ${JSON.stringify(r)}`);
    assert.ok(typeof r.sessionId==='string'&&r.sessionId.startsWith(wid+'@'),`[${name}] sessionId ${r.sessionId}`);
    assert.ok(!r.sha&&!r.ref&&r.pushed!==true,`[${name}] a refusal reports no commit: ${JSON.stringify(r)}`);
    for(const k of ['paths','inferredPaths','touchedPaths','unattributedPaths','skipped','contested'])
      assert.deepEqual(r[k]??[],[],`[${name}] a refusal reports no ${k}: ${JSON.stringify(r)}`);
  }
  assert.ok(log.includes(code),`[${name}] the log names ${code}\n${log}`);
  const line=ended(p.dir,wid);
  assert.ok(line.length===1&&line[0].includes(' commit=none ')&&line[0].includes(` outcome=refused code=${code}`),
    `[${name}] session-ended line: ${JSON.stringify(line)}`);
}
function assertLanded(name,p,wid,role,log){
  assert.equal(git(p.dir,'rev-list','--count',p.seed+'..HEAD').trim(),'1',`[${name}] one checkpoint\n${log}`);
  assert.equal(git(p.dir,'log','-1','--format=%s').trim(),`wip(${TASK}): Postflight smoke [status=WORKING role=${role} cli-exit=0]`,log);
  assert.equal(git(p.dir,'show','HEAD:'+OWNED),BYTES,`[${name}] the orphan checkpoint holds the bytes\n${log}`);
  assert.ok(!git(p.dir,'show','--name-only','--format=','HEAD').includes('peer-staged.txt'),`[${name}] a peer's staged bytes stay out\n${log}`);
  assert.notEqual(git(p.dir,'ls-files','-s','--','peer-staged.txt'),'',`[${name}] the peer's staged entry survives\n${log}`);
  const head=git(p.dir,'rev-parse','HEAD').trim(),rec=ledger(p.dir,wid);
  assert.equal(rec.length,1,`[${name}] ${JSON.stringify(rec)}`);
  assert.deepEqual([rec[0].outcome,rec[0].kind,rec[0].sha],['committed','checkpoint',head],`[${name}] ${JSON.stringify(rec[0])}`);
  assert.ok(rec[0].paths.includes(OWNED),`[${name}] ${JSON.stringify(rec[0])}`);
  assert.notEqual(git(p.remote,'for-each-ref'),'',`[${name}] the checkpoint is pushed\n${log}`);
  for(const code of [ACTIVE,UNKNOWN])assert.ok(!log.includes(code),`[${name}] ${code} on an exit that may land\n${log}`);
}

// [case, role, fake knobs, task-record fields, seeded attempts, refusal code ('' = it lands)].
// FAKE_SCOPE_ASSIGNEE_ALIVE=down is a value the fake rejects: its get_commit_scope
// exits 1, the daemon failure that sends the wrapper to its disk fallback.
const live={FAKE_SCOPE_ASSIGNEE:'worker-live'},dead={FAKE_SCOPE_ASSIGNEE:'worker-dead',FAKE_SCOPE_ASSIGNEE_ALIVE:'0',FAKE_SCOPE_ASSIGNEE_PROTECTED:'0'};
const cases=[
  ['own','architect',{},{},[],''],
  ['active','architect',live,{},[],ACTIVE],
  ['quiet','qa',{...live,FAKE_SCOPE_ASSIGNEE_ALIVE:'0',FAKE_SCOPE_ASSIGNEE_PROTECTED:'1'},{},[],ACTIVE],
  ['omitted','architect',{...live,FAKE_SCOPE_OWNERSHIP_MODE:'omit'},{},[],UNKNOWN],
  ['malformed','qa',{...dead,FAKE_SCOPE_OWNERSHIP_MODE:'malformed'},{},[],UNKNOWN],
  ['fallback-owner','architect',{FAKE_SCOPE_ASSIGNEE_ALIVE:'down'},{assignedWorkerId:'worker-live'},[],UNKNOWN],
  ['finalizing','architect',{FAKE_SCOPE_ASSIGNEE:'none'},{},[{id:'attempt-done',workerId:'worker-done',phase:'finalizing'}],ACTIVE],
  ['recovered','architect',live,{},[],ACTIVE],
  ['dead','architect',dead,{},[{id:'attempt-dead',workerId:'worker-dead',phase:'closed'}],''],
  ['unassigned','qa',{FAKE_SCOPE_ASSIGNEE:'none'},{},[],''],
  ['fallback-unassigned','qa',{FAKE_SCOPE_ASSIGNEE_ALIVE:'down'},{assignedWorkerId:null},[],''],
];
const only=process.env.MOE_OWNER_GUARD_ONLY?process.env.MOE_OWNER_GUARD_ONLY.split(','):null;
const runs=c=>!only||only.includes(c);

async function single([name,role,knobs,record,attempts,code]){
  const p=project(name,record,attempts),wid=role+'-og';
  // recovered: a crashed session of the task left its bytes and an unlanded
  // baseline; this pre-flight's recovery must not land them for another owner.
  if(name==='recovered'){write(path.join(p.dir,OWNED),BYTES);
    write(path.join(p.dir,'.git','moe','baseline',TASK+'.tsv'),`#moe-baseline v1 task=${TASK} at=2026-01-01T00:00:00Z head=${p.seed} landed=0\n`);}
  const log=await finish(launch(p.dir,role,wid,knobs),name);
  if(!code)return assertLanded(name,p,wid,role,log);
  assertRefused(name,p,wid,role,code,JSON.parse(read(path.join(p.dir,'.moe','og-cli-'+wid+'.json'))),log,name==='recovered'?2:1);
  assert.ok(!log.includes('MOE_CHECKPOINT_RECOVERED'),`[${name}] ${log}`);
}

// The parent bug in one repository: the architect's session predates the
// worker's, the worker's bytes appear while both run, the architect exits first
// and refuses, and the worker's completion then lands those bytes itself.
async function sequential(){
  const name='sequential',p=project(name,{},[]),moe=f=>path.join(p.dir,'.moe',f);
  const arch=launch(p.dir,'architect','architect-seq',{...live,OG_CLI:'hold'});
  let worker=null;
  try{
    await untilFile(moe('og-ready-architect-seq'),arch,name);
    // The daemon opens the worker its own attempt; its pre-flight read comes first.
    fs.rmSync(moe('attempts/attempt-postflight.json'));fs.rmSync(moe('context-count'),{force:true});
    worker=launch(p.dir,'worker','worker-live',{FAKE_SCOPE_ASSIGNEE:'none',FAKE_TASK_STATUS:'REVIEW',OG_CLI:'hold',OG_WRITE:'1',OG_FINALIZE:'1'});
    await untilFile(moe('og-ready-worker-live'),worker,name);
    const before=snapshot(p.dir);
    write(moe('og-go-architect-seq'),'go');
    assertRefused(name,p,'architect-seq','architect',ACTIVE,before,await finish(arch,name+'-architect'));
    write(moe('og-go-worker-live'),'go');
    const log=await finish(worker,name+'-worker'),head=git(p.dir,'rev-parse','HEAD').trim(),rec=ledger(p.dir,'worker-live');
    assert.equal(git(p.dir,'rev-list','--count',p.seed+'..HEAD').trim(),'1',log);
    assert.match(git(p.dir,'log','-1','--format=%s').trim(),/^(feat|fix)\(task-postflight\): Postflight smoke$/,log);
    assert.equal(git(p.dir,'show','HEAD:'+OWNED),BYTES,'the completion commit holds the worker\'s bytes\n'+log);
    // The row landing metadata (task.landing.lastCompletion) is built from.
    // Both wrappers record the bare branch name as ref.
    const done=rec.filter(r=>r.kind==='completion');
    assert.equal(done.length,1,JSON.stringify(rec));
    assert.deepEqual([done[0].outcome,done[0].sha,done[0].ref,done[0].role,done[0].pushed],
      ['committed',head,git(p.dir,'symbolic-ref','--short','HEAD').trim(),'worker',true],JSON.stringify(done[0]));
    assert.ok(done[0].sessionId.startsWith('worker-live@')&&done[0].paths.includes(OWNED),JSON.stringify(done[0]));
    assert.ok(!log.includes('MOE_COMMIT_NOTHING_TO_COMMIT'),log);
  }finally{killTree(arch);if(worker)killTree(worker);}
}

(async()=>{
  let count=0;
  for(const c of cases.filter(c=>runs(c[0]))){console.log('[owner guard] '+c[0]);await single(c);count++;}
  if(runs('sequential')){console.log('[owner guard] sequential');await sequential();count++;}
  if(!only)assert.equal(count,cases.length+1,'every owner guard case ran');
  console.log('PASS owner guard scenarios: '+count);
})().catch(e=>{console.error('OWNER GUARD FIXTURE '+root);console.error(e);process.exitCode=1;})
  .finally(()=>{if(!process.env.MOE_KEEP_OWNER_GUARD_FIXTURE)for(const d of [root,wrapperTmp])fs.rmSync(d,{recursive:true,force:true,maxRetries:10,retryDelay:200});});
