// WT-19b, WT-19 step 2: the pre-flip worktree dry run (docs/plans/2026-10-30-per-task-worktrees.md §2, §6).
// The real wrapper lands real seats on a slash-named, non-main target (moe/work-e2e) in a fixture whose first
// commit is the wrapper checkout's HEAD tree, against a bare origin, with the candidate qualityGate.
//   node worktree-e2e.cjs <sh|ps1> <wrapper> <fake-proxy> <parent-tmp> <engine>
// Each scenario prints `[worktree-e2e] <name> ok (<s> s)` or `[worktree-e2e] <name> FAILED: <why>` plus the
// failing session logs' tails; any failure exits 1. MOE_POSTFLIGHT_TIMEOUT_SEC caps each wrapper run
// (default 900); MOE_KEEP_E2E_FIXTURE=1 keeps the fixture root. Two helper modes come first:
// `<this file> cli` is the fake CLI, and with E2E_SEAT_STATE set this file is a seat's MOE_PROXY_PATH. That
// interposer owns the land lease (the fake's grants every caller) and delegates every other tool to the
// shared fake in a private state dir, translating the seat's ids to the fake's fixed ones and back.
// The ps1 leg runs under Windows node only (engine: powershell.exe or pwsh.exe). cmd.exe runs its gate, and
// Windows `bash` can be the WSL launcher, so its gate is the sh gate's Windows twin: the same .moe refusal and
// gate-runs.log line, then parity-check.ps1 under the engine, with no lint.
'use strict';
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),util=require('node:util'),
  assert=require('node:assert/strict');
const read=f=>fs.readFileSync(f,'utf8');
const write=(f,b)=>{fs.mkdirSync(path.dirname(f),{recursive:true});fs.writeFileSync(f,b);};
const present=f=>{try{fs.lstatSync(f);return true;}catch{return false;}};
const readOr=f=>present(f)?read(f):null;
const rows=f=>present(f)?read(f).trim().split('\n').filter(Boolean).map(l=>JSON.parse(l)):[];
const sleep=ms=>Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,Math.max(0,ms));
// win32: a peer's open handle or a pending delete answers EPERM/EBUSY/EACCES for a moment. Retry 2 s, then throw.
const winRetry=fn=>{
  for(let i=0;;i++){try{return fn();}catch(err){if(process.platform!=='win32'||i>=80||!['EPERM','EBUSY','EACCES'].includes(err.code))throw err;sleep(25);}}
};
const sha=v=>typeof v==='string'&&/^[0-9a-f]{40}$/.test(v);
const LEASE=['acquire_resource','wait_for_resource','release_resource'];

// ---- cli mode: one JSON record per launch (cwd, argv, the prompt or the context file it points at, MERGE_HEAD
// and conflict markers in W at start), then E2E_CLI_WRITE's {relpath: bytes} under W. No git write.
function cliMode(){
  if(process.argv.includes('--version')){console.log('0.0.0-e2e');process.exit(0);}
  const e=process.env,argv=process.argv.slice(3),last=argv[argv.length-1]||'',W=e.MOE_WORKTREE_PATH||process.cwd();
  const ctx=/private session context file at (.+?)\. It contains/.exec(last);
  const marked=f=>/^(<<<<<<< |>>>>>>> |=======$)/m.test((readOr(path.join(W,f))||'').replace(/\r/g,''));
  fs.appendFileSync(e.E2E_CLI_RECORD,JSON.stringify({cwd:process.cwd(),worktree:W,argv,context:ctx?readOr(ctx[1]):last,
    mergeHead:cp.spawnSync('git',['-C',W,'rev-parse','-q','--verify','MERGE_HEAD']).status===0,
    markers:Object.fromEntries(String(e.E2E_CLI_EXPECT_MARKERS||'').split(',').filter(Boolean).map(f=>[f,marked(f)]))})+'\n');
  for(const [f,b] of Object.entries(JSON.parse(e.E2E_CLI_WRITE||'{}')))write(path.join(W,f),b);
  process.exit(0);
}

// ---- proxy mode (E2E_SEAT_STATE): one RPC from the wrapper's moe_rpc on stdin, one answer on stdout.
function seatMode(){
  const e=process.env,dir=e.E2E_SEAT_STATE,moe=path.join(dir,'.moe'),T='task-'+e.E2E_SEAT,A='attempt-'+e.E2E_SEAT+e.E2E_SESSION;
  const swap=(s,pairs)=>pairs.reduce((t,[a,b])=>t.replace(new RegExp(`(?<![\\w-])${a}(?![\\w-])`,'g'),b),s);
  const fwd=s=>swap(s,[[T,'task-postflight'],[A,'attempt-postflight']]),back=s=>swap(s,[['task-postflight',T],['attempt-postflight',A]]);
  const raw=fs.readFileSync(0,'utf8'),start=Date.now();
  let req=null;try{req=JSON.parse(raw);}catch{}
  const params=req&&typeof req.params==='object'&&req.params||{},name=String(params.name||'').replace(/^moe\./,''),args=params.arguments||{};
  const id=req&&req.id!==undefined?req.id:1;
  const log=o=>fs.appendFileSync(path.join(dir,'rpcs.jsonl'),JSON.stringify({session:Number(e.E2E_SESSION),tool:name,args,...o,start,end:Date.now()})+'\n');
  const reply=payload=>{log({reply:payload});process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,result:{content:[{type:'text',text:JSON.stringify(payload)}]}})+'\n');};
  try{
    if(!req||!name)throw new Error('malformed request: '+raw.slice(0,200));
    if(path.resolve(e.E2E_FAKE)===__filename)throw new Error('E2E_FAKE names the interposer itself');
    if(/(?<![\w-])(task|attempt)-postflight(?![\w-])/.test(raw))throw new Error('the request already names a fake id; ids cannot be translated back');
    if(args.taskId!==undefined&&args.taskId!==T)throw new Error(`a foreign task id ${args.taskId} on seat ${T}`);
    if(LEASE.includes(name)){reply(leaseRpc(e,name,args));}
    else {
      if(name==='record_check_run')checkBeforeCas(moe,e.E2E_CONTROL,args);
      const r=cp.spawnSync(process.execPath,[e.E2E_FAKE],{input:fwd(raw),encoding:'utf8',maxBuffer:1<<26,
        env:{...e,MOE_PROJECT_PATH:dir,GIT_CEILING_DIRECTORIES:e.E2E_ROOT}});
      if(r.status!==0)throw new Error(`the fake proxy exited ${r.status}: ${String(r.stderr).trim().split('\n').pop()}`);
      const msg=JSON.parse(String(r.stdout).trim().split('\n').pop());
      // The wrapper reads attempts from <control>/.moe/attempts (moe_attempt_read): mirror this seat's.
      const src=path.join(moe,'attempts','attempt-postflight.json'),dst=path.join(e.E2E_CONTROL,'.moe','attempts',A+'.json');
      if(present(src)){const tmp=path.join(path.dirname(dst),`.${A}.${process.pid}.tmp`);write(tmp,back(read(src)));winRetry(()=>fs.renameSync(tmp,dst));}
      const out=JSON.parse(back(JSON.stringify(msg)));
      log(out.error?{error:out.error.message}:{reply:JSON.parse(out.result.content[0].text)});
      process.stdout.write(JSON.stringify(out)+'\n');
    }
  }catch(err){
    const message=String(err&&err.message||err);log({error:message});
    process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,error:{code:-32002,message,data:{codeName:'E2E_REFUSED'}}})+'\n');
  }
  process.exit(0);
}
// The daemon's capacity-1 land lease: an O_EXCL lock file under the e2e root, keyed by task; lease.jsonl
// logs each grant and release (the release before the unlink), so the hold intervals can be compared.
function leaseRpc(e,name,args){
  const rid=String(args.resourceId),lock=path.join(e.E2E_ROOT,'lease-'+rid+'.lock'),llog=path.join(e.E2E_ROOT,'lease.jsonl');
  assert.match(rid,/^[A-Za-z0-9._-]{1,64}$/,'resourceId');
  assert.deepEqual([args.taskId,args.workerId],['task-'+e.E2E_SEAT,'worker-e2e-'+e.E2E_SEAT],'the lease caller');
  // A peer's release can unlink the lock mid-read (no holder) and a grant can be mid-write (retry).
  const holder=()=>{
    for(let i=0;i<40;i++){
      let t;try{t=winRetry(()=>read(lock));}catch(err){if(err.code==='ENOENT')return null;throw err;}
      try{if(t)return JSON.parse(t);}catch{}
      sleep(25);
    }
    throw new Error('unreadable lease lock');
  };
  const take=()=>{
    for(let i=0;i<3;i++){
      let fd;
      try{fd=winRetry(()=>fs.openSync(lock,'wx'));}catch(err){
        if(err.code!=='EEXIST')throw err;
        const h=holder();if(h)return h.taskId===args.taskId?h:null;continue;
      }
      const now=Date.now(),l={taskId:args.taskId,workerId:args.workerId,acquiredAt:new Date(now).toISOString(),expiresAt:new Date(now+7200000).toISOString()};
      fs.writeSync(fd,JSON.stringify(l));fs.closeSync(fd);
      fs.appendFileSync(llog,JSON.stringify({task:args.taskId,event:'grant',at:now})+'\n');
      return l;
    }
    return null; // the lock changed hands under every try: another task holds it now
  };
  if(name==='release_resource'){
    assert.equal(args.force,undefined,'a forced release');
    const h=holder(),mine=Boolean(h&&h.taskId===args.taskId);
    if(mine&&args.ifAcquiredAt!==undefined)assert.equal(args.ifAcquiredAt,h.acquiredAt,'ifAcquiredAt names no held grant');
    if(mine){fs.appendFileSync(llog,JSON.stringify({task:args.taskId,event:'release',at:Date.now()})+'\n');winRetry(()=>fs.rmSync(lock));}
    return {success:true,resourceId:rid,released:mine?[args.taskId]:[],removedFromQueue:[],grantedTo:[]};
  }
  if(name==='acquire_resource'){
    const l=take();
    return l?{success:true,granted:true,resourceId:rid,lease:l}:{success:true,granted:false,resourceId:rid,position:1,queueLength:1,holders:[]};
  }
  assert.ok(Number.isSafeInteger(args.timeoutMs)&&args.timeoutMs>=1000&&args.timeoutMs<=600000,'timeoutMs '+args.timeoutMs);
  for(const until=Date.now()+args.timeoutMs;;sleep(200)){
    const l=take();
    if(l)return {granted:true,resourceId:rid,lease:l};
    if(Date.now()>=until)return {granted:false,timedOut:true,resourceId:rid,position:1};
  }
}
// The fake's CheckRun-before-CAS check, against the control repo (the fake skips it: its project is no repo).
function checkBeforeCas(moe,control,args){
  assert.match(String(args.candidateId),/^[A-Za-z0-9_-]{1,128}$/,'candidateId');
  const c=JSON.parse(read(path.join(moe,'candidates',args.candidateId+'.json')));
  const tip=cp.spawnSync('git',['-C',control,'rev-parse','--verify',c.deliveryTarget],{encoding:'utf8'});
  if(tip.status===0)assert.equal(tip.stdout.trim(),c.baseRevision,'CheckRun must persist before CAS');
}

if(process.argv[2]==='cli')cliMode();
if(process.env.E2E_SEAT_STATE)seatMode();

// ---- main
const [platform,wrapperArg,proxyArg,parent,engine]=process.argv.slice(2),win=platform==='ps1',winHost=process.platform==='win32';
if(!['sh','ps1'].includes(platform)||!wrapperArg||!proxyArg||!parent||!engine){
  console.error('usage: node worktree-e2e.cjs <sh|ps1> <wrapper> <fake-proxy> <parent-tmp> <engine>');process.exit(2);
}
if(win&&!winHost){console.error(`[worktree-e2e] the ps1 leg runs under Windows node; this node is ${process.platform}.`);process.exit(2);}
const WRAPPER=path.resolve(wrapperArg),FAKE=path.resolve(proxyArg),LIMIT=Number(process.env.MOE_POSTFLIGHT_TIMEOUT_SEC||900)*1000;
// Hermetic: a seat's own MOE_*/CLAUDE*/E2E_* and a hook's GIT_* never reach the wrappers or the fixture's git.
const inherited=Object.fromEntries(Object.entries(process.env)
  .filter(([k])=>!/^(FAKE_|WT_|OG_|MOE_|E2E_|CLAUDE|BASH_ENV$|GIT_(DIR|WORK_TREE|INDEX_FILE|COMMON_DIR|OBJECT_DIRECTORY|CEILING_DIRECTORIES)$)/i.test(k)));
const root=fs.realpathSync(fs.mkdtempSync(path.join(path.resolve(parent),'wt-e2e-')));
const C=path.join(root,'control'),ORIGIN=path.join(root,'origin.git'),TARGET='moe/work-e2e',TREF='refs/heads/'+TARGET;
const GATE_LOG=path.join(root,'gate-runs.log'),SEATS=['a','b','c'],seatDir=s=>path.join(root,'seat-'+s);
const SHIM=path.join(root,'shim-claude','claude'+(win?'.cmd':''));
const GATE=win?winGate():`test ! -e .moe && test ! -L .moe && printf '%s\\n' "$PWD" >> '${GATE_LOG}' && bash scripts/tests/parity-check.sh && npm run lint`;
// The ps1 leg's gate (see the header), a command line for cmd.exe.
function winGate(){
  const f=path.join(root,'gate.cjs'),ps1=path.join('scripts','tests','parity-check.ps1');
  write(f,"'use strict';\nconst fs=require('fs'),cp=require('child_process');\n"+
    "try{fs.lstatSync('.moe');console.error('[gate] .moe in the gate tree');process.exit(1);}catch(err){if(err.code!=='ENOENT')throw err;}\n"+
    `fs.appendFileSync(${JSON.stringify(GATE_LOG)},process.cwd()+'\\n');\n`+
    `const r=cp.spawnSync(${JSON.stringify(engine)},['-NoProfile','-ExecutionPolicy','Bypass','-File',${JSON.stringify(ps1)}],{stdio:'inherit'});\n`+
    "process.exit(r.status===null?1:r.status);\n");
  return `"${process.execPath}" "${f}"`;
}
const BAD=['MOE_CONTROL_NOT_FOLLOWING','MOE_CONTROL_CHECKOUT_BEHIND','MOE_CONTROL_CHECKOUT_DIVERGED'];
const SHARED=Array.from({length:10},(_,i)=>`line ${i+1}\n`).join('');
const edit=(s,n,v)=>s.split('\n').map((l,i)=>i===n-1?v:l).join('\n');
const live=new Set(),ALL=[];
let TIP0=null,MAIN=null,TOPC=null;
// A seat's W. ps1 spells it from `git rev-parse --show-toplevel` (forward slashes), as its wrapper does.
const wOf=s=>win?TOPC+'/.worktrees/task-'+s:path.join(C,'.worktrees','task-'+s);

function gitRun(dir,a){return cp.spawnSync('git',['-C',dir,...a],{encoding:'utf8',maxBuffer:1<<26,env:{...inherited,GIT_OPTIONAL_LOCKS:'0'}});}
function git(dir,...a){const r=gitRun(dir,a);if(r.status!==0)throw new Error(`git ${a.join(' ')}: exit ${r.status} ${String(r.stderr).trim()}`);return r.stdout;}
const probe=(dir,...a)=>{const r=gitRun(dir,a);return r.status+':'+r.stdout;};
const revOf=(dir,ref)=>{const r=gitRun(dir,['rev-parse','--verify','--quiet',ref+'^{commit}']);return r.status===0?r.stdout.trim():null;};
// Comparable path: the real path when it exists, no trailing slash; on win32 also forward slashes, case-folded.
const norm=p=>{let r=p;try{r=fs.realpathSync.native(p);}catch{}if(winHost)r=r.replace(/\\/g,'/').toLowerCase();return r.replace(/\/+$/,'');};
const killTree=child=>{
  if(child.exitCode!==null||child.signalCode!==null)return;
  if(winHost)cp.spawnSync('taskkill',['/T','/F','/PID',String(child.pid)],{stdio:'ignore'});
  else{try{process.kill(-child.pid,'SIGKILL');}catch{}}
};
function cleanup(){
  for(const child of live)killTree(child);
  if(process.env.MOE_KEEP_E2E_FIXTURE==='1')console.log(`[worktree-e2e] fixture kept at ${root}`);
  else fs.rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:200});
}
for(const [sig,code] of [['SIGINT',130],['SIGTERM',143]])process.on(sig,()=>{console.log(`[worktree-e2e] ${sig}: stopping`);cleanup();process.exit(code);});

// The fixture: commit 1 is exactly the wrapper checkout's HEAD tree (so the gate's scripts exist), commit 2
// the e2e settings and e2e/shared.txt. main and the target are pushed to a bare origin; task-c's branch is cut
// before any landing; the control checkout follows moe/control. extensions.worktreeConfig is set before any
// seat starts, as the switch checklist does (governor ruling on this row; task-c7ca56e6 lands after the switch).
function fixture(){
  const top=git(path.dirname(WRAPPER),'rev-parse','--show-toplevel').trim(),head=git(top,'rev-parse','HEAD').trim();
  console.log(`[worktree-e2e] wrapper checkout ${top} at HEAD ${head}`);
  assert.ok(!/\s/.test(root),'the fixture root holds whitespace: '+root);
  git(root,'init','-q','--bare',ORIGIN);git(root,'init','-q','-b','main',C);
  for(const [k,v] of [['core.autocrlf','false'],['user.name','Moe Test'],['user.email','moe@test.local']])git(C,'config',k,v);
  git(C,'fetch','-q','--depth=1',(winHost?'file:///':'file://')+top,head);
  const tree=git(top,'rev-parse',head+'^{tree}').trim();
  assert.equal(git(C,'rev-parse','FETCH_HEAD^{tree}').trim(),tree,"commit 1's tree is not the wrapper checkout's HEAD tree");
  git(C,'update-ref','refs/heads/main',git(C,'commit-tree',tree,'-m','e2e seed: the tree of '+head).trim());
  git(C,'reset','-q','--hard');
  write(path.join(C,'.moe','project.json'),JSON.stringify({id:'proj-e2e',name:'E2E',
    settings:{worktreeMode:'on',consolidationBranch:TARGET,autoCommit:true,qualityGate:GATE}},null,2)+'\n');
  write(path.join(C,'e2e','shared.txt'),SHARED);
  git(C,'add','--','.moe/project.json','e2e/shared.txt');git(C,'commit','-qm','e2e: settings and shared.txt');
  git(C,'branch',TARGET,'main');git(C,'branch','moe/task/task-c',TARGET);git(C,'switch','-q','-c','moe/control',TARGET);
  git(C,'remote','add','origin',ORIGIN);git(C,'push','-q','origin','main',TARGET);
  git(C,'config','extensions.worktreeConfig','true');
  assert.equal(git(C,'config','--get','extensions.worktreeConfig').trim(),'true','extensions.worktreeConfig did not read back');
  write(path.join(C,'.moe','daemon.json'),JSON.stringify({port:9876,projectPath:C}));
  write(path.join(C,'.moe','messages','chan-general.jsonl'),'');
  // The live checkout's ignored subagent mirror: two seats mirroring at once race (task-b6a3d41e).
  for(const f of fs.readdirSync(path.join(C,'.moe','agents')).filter(f=>f.endsWith('.md')))
    write(path.join(C,'.claude','agents',f),read(path.join(C,'.moe','agents',f)));
  for(const s of SEATS){
    const m=path.join(seatDir(s),'.moe');
    write(path.join(m,'project.json'),JSON.stringify({id:'proj-e2e-'+s,name:'E2E seat '+s,settings:{}}));
    write(path.join(m,'tasks','task-postflight.json'),JSON.stringify({id:'task-postflight',title:'E2E task '+s,status:'WORKING'}));
    for(const d of ['home-','tmp-'])fs.mkdirSync(path.join(root,d+s),{recursive:true});
  }
  write(SHIM,win?`@echo off\r\n"${process.execPath}" "${__filename}" cli %*\r\nexit /b %errorlevel%\r\n`
    :`#!/usr/bin/env bash\nexec "${process.execPath}" "${__filename}" cli "$@"\n`);
  fs.chmodSync(SHIM,0o700);
  [TIP0,MAIN,TOPC]=[revOf(C,TREF),revOf(C,'refs/heads/main'),git(C,'rev-parse','--show-toplevel').trim()];
}

// One worker seat session through the forwarding `claude` shim (cliShim would drop argv, hence the prompt).
async function launch(s,n,o={}){
  const sd=seatDir(s),W=wOf(s),ws=JSON.stringify({mode:'worktree',path:W,branch:'moe/task/task-'+s,target:TARGET});
  const env={...inherited,MOE_PROXY_PATH:__filename,MOE_NODE_COMMAND:process.execPath,MOE_DISABLE_HEARTBEAT:'1',MOE_ACCOUNT_ROTATION:'off',
    MOE_DISABLE_ARGV_PROBE:'1',HOME:path.join(root,'home-'+s),USERPROFILE:path.join(root,'home-'+s),
    TMPDIR:path.join(root,'tmp-'+s),TMP:path.join(root,'tmp-'+s),TEMP:path.join(root,'tmp-'+s),
    FAKE_TASK_STATUS:'REVIEW',FAKE_CLAIM_WORKSPACE:ws,FAKE_CTX_WORKSPACE:ws,
    E2E_SEAT:s,E2E_SESSION:String(n),E2E_SEAT_STATE:sd,E2E_FAKE:FAKE,E2E_ROOT:root,E2E_CONTROL:C,
    E2E_CLI_RECORD:path.join(sd,`cli-${n}.jsonl`),E2E_CLI_WRITE:JSON.stringify(o.writes||{}),E2E_CLI_EXPECT_MARKERS:(o.markers||[]).join(',')};
  env.MOE_POSTFLIGHT_TEST_ALLOW_WORKTREE_WRAPPER='1'; // `inherited` drops MOE_*: WT-13's guard refuses WRAPPER when it sits in a task worktree (task-86431c31)
  const args=win?['-NoProfile','-ExecutionPolicy','Bypass','-File',WRAPPER,'-Project',C,'-WorkerId','worker-e2e-'+s,'-Role','worker',
    '-Team','E2E','-NoStartDaemon','-Command',SHIM,'-NoLoop','-PollInterval','0']
    :[WRAPPER,'--project',C,'--worker-id','worker-e2e-'+s,'--role','worker','--team','E2E','--no-start-daemon',
      '--command',SHIM,'--no-loop','--poll-interval','0'];
  const child=cp.spawn(engine,args,{env,stdio:['ignore','pipe','pipe'],detached:!winHost,windowsHide:true});
  live.add(child);
  let log='',timedOut=false;child.stdout.on('data',d=>{log+=d;});child.stderr.on('data',d=>{log+=d;});
  const timer=setTimeout(()=>{timedOut=true;killTree(child);},LIMIT);
  const code=await new Promise((res,rej)=>{child.on('error',rej);child.on('close',c=>res(c));}).finally(()=>{clearTimeout(timer);live.delete(child);});
  log=util.stripVTControlCharacters(log);write(path.join(root,`${s}-${n}.log`),log);
  const run={seat:s,session:n,code,log,timedOut,W,name:s+n};ALL.push(run);
  assert.ok(!timedOut,`${run.name}: the wrapper outlived ${LIMIT/1000}s and was killed`);
  return run;
}
const seatRpcs=(s,n)=>rows(path.join(seatDir(s),'rpcs.jsonl')).filter(x=>x.session===n);
// The session printed "[worktree] created <W> on moe/task/task-<seat>"; ps1 ends it CRLF and spells W its own way.
const createdW=r=>{
  if(!win)return r.log.includes(`[worktree] created ${r.W} on moe/task/task-${r.seat}\n`);
  const m=new RegExp(`^\\[worktree\\] created (.+) on moe/task/task-${r.seat}\\r?$`,'m').exec(r.log);
  return Boolean(m)&&norm(m[1])===norm(r.W);
};
const gateLines=()=>(readOr(GATE_LOG)||'').split('\n').filter(Boolean);
const added=from=>git(C,'rev-list',`${from}..${TREF}`).trim().split('\n').filter(Boolean);
// The target only fast-forwards: no merge commit since the fixture, every reflog entry descends from the one
// before it, origin's target is the local one, and main never moves (local or origin).
function linear(){
  assert.equal(git(C,'rev-list','--merges',`${TIP0}..${TREF}`).trim(),'','a merge commit on the target');
  const entries=git(C,'log','-g','--format=%H',TREF).trim().split('\n');
  assert.ok(entries.length>1,'the target has no reflog to check');
  for(let i=0;i+1<entries.length;i++)assert.equal(probe(C,'merge-base','--is-ancestor',entries[i+1],entries[i]),'0:',
    `reflog entry ${entries[i]} is not a fast-forward of ${entries[i+1]}`);
  assert.equal(revOf(ORIGIN,TREF),revOf(C,TREF),"origin's target is not the local target");
  assert.deepEqual([revOf(C,'refs/heads/main'),revOf(ORIGIN,'refs/heads/main')],[MAIN,MAIN],'main moved');
}
// The seat session's one finalize: 'landed' on C, with a committed completion row for C. Returns C.
function landed(s,n){
  const r=seatRpcs(s,n),fin=r.filter(x=>x.tool==='finalize_attempt');
  assert.deepEqual(fin.map(x=>[x.args.outcome,x.error||null]),[['landed',null]],`${s}${n}: the finalize_attempt calls`);
  const c=fin[0].args.landedRevision;
  assert.ok(sha(c)&&r.some(x=>x.tool==='record_commit'&&x.args.kind==='completion'&&x.args.outcome==='committed'&&x.args.sha===c&&!x.error),
    `${s}${n}: no committed completion row for ${c}`);
  return c;
}
// After every landing: the control checkout followed (on moe/control, HEAD = the target, clean), each landing
// session printed MOE_CONTROL_ADVANCED and the gate pass, no session printed a control refusal, and every gate
// run since g0 logged one line from a wrapper gate workspace (never the control or a W).
function afterLanding(runs,g0){
  for(const r of runs)assert.ok(r.log.includes('[OK] qualityGate passed.'),`${r.name}: no "[OK] qualityGate passed." line`);
  const lines=gateLines().slice(g0),gated=runs.reduce((k,r)=>k+r.log.split('Post-flight: quality gate:').length-1,0);
  assert.ok(lines.length>=runs.length&&lines.length===gated,`${lines.length} gate-runs.log lines for ${gated} gate runs`);
  const own=[C,...SEATS.map(wOf)].map(norm),ws=win?/\/moe-gate-[0-9a-f]{32}\/tree$/:/\/moe-gate\.[^/]+\/tree\/?$/;
  for(const l of lines)assert.ok(ws.test(win?norm(l):l)&&!own.includes(norm(l)),'a gate ran outside a gate workspace: '+l);
  for(const r of ALL)for(const code of BAD)assert.ok(!r.log.includes(code),`${r.name} printed ${code}`);
  for(const r of runs)assert.ok(r.log.includes('MOE_CONTROL_ADVANCED'),`${r.name}: no MOE_CONTROL_ADVANCED line`);
  assert.equal(probe(C,'symbolic-ref','-q','HEAD'),'0:refs/heads/moe/control\n','the control checkout left moe/control');
  assert.equal(revOf(C,'HEAD'),revOf(C,TREF),"the control checkout's HEAD is not the target");
  assert.equal(git(C,'status','--porcelain'),'','the control checkout is not clean');
}
// Lease hold intervals [grant, release] per task: every grant released, no two tasks' holds overlapping.
function holds(tasks){
  const ev=rows(path.join(root,'lease.jsonl')).filter(x=>tasks.includes(x.task)),open={},out=[];
  for(const x of ev){
    if(x.event==='grant'){assert.ok(!open[x.task],`${x.task} granted twice`);open[x.task]=x.at;}
    else{assert.ok(open[x.task],`${x.task} released without a grant`);out.push({task:x.task,from:open[x.task],to:x.at});delete open[x.task];}
  }
  assert.deepEqual(Object.keys(open),[],'a lease never released');
  return out;
}

// (a) Two seats at once, non-adjacent hunks of ONE file plus a file each: both land, +2 commits, serialized gates.
async function parallel(){
  const g0=gateLines().length,ea=edit(SHARED,2,'line 2: task-a'),eb=edit(SHARED,8,'line 8: task-b');
  const runs=await Promise.all([['a',{'e2e/a.txt':'task a\n','e2e/shared.txt':ea}],['b',{'e2e/b.txt':'task b\n','e2e/shared.txt':eb}]]
    .map(([s,writes])=>launch(s,1,{writes})));
  for(const r of runs){
    assert.equal(r.code,0,`${r.name}: exit code ${r.code}`);
    assert.deepEqual(seatRpcs(r.seat,1).filter(x=>x.tool==='report_blocked').map(x=>x.args.reason),[],`${r.name}: report_blocked`);
    assert.ok(createdW(r),`${r.name}: no "[worktree] created ${r.W}" line`);
    assert.ok(!present(path.join(r.W,'.moe')),`${r.name}: W holds .moe`);
  }
  const tip=revOf(C,TREF),news=added(TIP0);
  assert.equal(news.length,2,`the target gained ${news.length} commits, expected 2`);
  linear();
  assert.deepEqual(['e2e/a.txt','e2e/b.txt','e2e/shared.txt'].map(f=>git(C,'show',`${tip}:${f}`)),['task a\n','task b\n',edit(ea,8,'line 8: task-b')],
    "the target's tree lacks a landing's bytes");
  assert.deepEqual(runs.map(r=>landed(r.seat,1)).sort(),[...news].sort(),'the finalized landings are not the two new commits');
  const h=holds(['task-a','task-b']);
  assert.deepEqual(h.map(x=>x.task).sort(),['task-a','task-b'],'not one lease hold per landing: '+JSON.stringify(h));
  assert.ok(h[0].to<=h[1].from||h[1].to<=h[0].from,'the two lease holds overlap: '+JSON.stringify(h));
  afterLanding(runs,g0);
}
// (b) task-c's branch predates (a); its line 2 conflicts with task-a's. c1 ends unlanded; c2 resumes in W from
// LANDING-CONFLICT (markers, MERGE_HEAD), resolves the file and lands +1 commit.
async function conflictResume(){
  if(!passed.has('parallel'))throw new Error('needs parallel');
  const tipA=revOf(C,TREF),W=wOf('c'),TB='refs/heads/moe/task/task-c';
  const c1=await launch('c',1,{writes:{'e2e/c.txt':'task c\n','e2e/shared.txt':edit(SHARED,2,'line 2: task-c')}});
  assert.ok(c1.log.includes('MOE_COMMIT_FAILED_CONFLICT'),'c1: no MOE_COMMIT_FAILED_CONFLICT line');
  assert.equal(revOf(C,TREF),tipA,'c1 moved the target');
  linear();
  const r1=seatRpcs('c',1),fin=r1.filter(x=>x.tool==='finalize_attempt');
  assert.deepEqual(fin.map(x=>[x.args.outcome,x.error||null]),[['unlanded',null]],'c1: the finalize_attempt calls');
  const f=fin[0].args;
  assert.deepEqual([f.unlandedReason,(f.conflictPaths||[]).includes('e2e/shared.txt'),f.landedRevision??null],['conflict',true,null],'c1: the unlanded finalize '+JSON.stringify(f));
  assert.ok(/^refs\/moe\/rescue\/task-c\//.test(f.rescueRef)&&revOf(C,f.rescueRef)===revOf(C,TB),`c1: the rescue ref ${f.rescueRef} is not task-c's tip`);
  assert.ok(r1.some(x=>x.tool==='record_commit'&&x.args.kind==='completion'&&x.args.outcome==='failed'&&x.args.code==='MOE_COMMIT_FAILED_CONFLICT'),
    'c1: no failed completion row with MOE_COMMIT_FAILED_CONFLICT');
  // Session 2 claims a new attempt (the fake keeps one per state dir); the stored landingRetry stays.
  fs.rmSync(path.join(seatDir('c'),'.moe','attempts'),{recursive:true,force:true});fs.rmSync(path.join(seatDir('c'),'.moe','context-count'),{force:true});
  const g0=gateLines().length,resolved=edit(edit(SHARED,2,'line 2: task-a + task-c'),8,'line 8: task-b');
  const c2=await launch('c',2,{writes:{'e2e/shared.txt':resolved},markers:['e2e/shared.txt']});
  assert.equal(c2.code,0,`c2: exit code ${c2.code}`);
  assert.ok(!c2.log.includes('MOE_WORKTREE_UNRESOLVED_CONFLICT'),'c2: the marker scan refused a clean resolution');
  const rec=rows(path.join(seatDir('c'),'cli-2.jsonl'));
  assert.equal(rec.length,1,`c2: ${rec.length} CLI launches recorded, expected 1`);
  const prompt=(rec[0].context||'')+'\n'+rec[0].argv.join('\n');
  assert.ok(prompt.includes('LANDING-CONFLICT:')&&prompt.includes('e2e/shared.txt'),'c2: the prompt carries no "LANDING-CONFLICT: ... e2e/shared.txt"');
  assert.deepEqual([rec[0].mergeHead,rec[0].markers['e2e/shared.txt']],[true,true],'c2: MERGE_HEAD and the markers at CLI start');
  const tip=revOf(C,TREF);
  assert.deepEqual(added(tipA),[tip],'the resolution did not land as exactly one commit');
  assert.deepEqual([git(C,'show',tip+':e2e/shared.txt'),git(C,'show',tip+':e2e/c.txt')],[resolved,'task c\n'],"the target's tree after c2");
  linear();
  assert.equal(landed('c',2),tip,'c2 finalized another commit');
  assert.ok(!probe(W,'rev-parse','-q','--verify','MERGE_HEAD').startsWith('0:'),'MERGE_HEAD survived in W');
  afterLanding([c2],g0);
}

const SCENARIOS=[['parallel',parallel],['conflict-resume',conflictResume]],passed=new Set();
(async()=>{
  let failed=0,setup=null;
  try{fixture();}catch(err){setup=err;}
  for(const [name,fn] of SCENARIOS){
    const t0=Date.now(),from=ALL.length;
    try{
      if(setup)throw new Error('fixture: '+setup.message);
      await fn();passed.add(name);
      console.log(`[worktree-e2e] ${name} ok (${((Date.now()-t0)/1000).toFixed(1)} s)`);
    }catch(err){
      failed++;
      console.log(`[worktree-e2e] ${name} FAILED (${((Date.now()-t0)/1000).toFixed(1)} s): ${err.name}: ${err.message}`);
      for(const r of ALL.slice(from))console.log(`  | --- ${r.name} (exit ${r.code})\n`+r.log.split(/\r?\n/).slice(-25).map(l=>'  | '+l).join('\n'));
    }
  }
  console.log(`[worktree-e2e] ${SCENARIOS.length-failed} ok, ${failed} failed`);
  cleanup();
  process.exit(failed?1:0);
})();
