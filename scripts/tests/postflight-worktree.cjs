// Worktree provisioning at worker pre-flight (docs/plans/2026-10-30-per-task-worktrees.md
// §1.1-§1.6): a worker seat makes, reuses or re-adds its task worktree W, or refuses with
// one report_blocked and no CLI. Held out from WT-04: one case list for both wrappers.
//   node postflight-worktree.cjs <sh|ps1> <wrapper> <fake-proxy> <parent-tmp> <engine>
// Each case is a fresh repository and real wrapper run(s) against the fake proxy's
// FAKE_CLAIM_WORKSPACE / FAKE_CTX_WORKSPACE / FAKE_CTX_COMMITS knobs. Every selected case
// runs and prints `[worktree] <case> ok` or `[worktree] <case> FAILED: <error name>: <why>`
// (a harness fault is an Error, a wrong wrapper an AssertionError); any failure exits 1.
// MOE_WORKTREE_ONLY=<case,...> runs a subset, MOE_KEEP_WORKTREE_FIXTURE=1 keeps the
// fixture; `<this file> cli` is the fake CLI.
'use strict';
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),cp=require('node:child_process'),
  util=require('node:util'),assert=require('node:assert/strict');
const TASK='task-postflight',WID='worker-wt';
const read=f=>fs.readFileSync(f,'utf8');
const write=(f,b)=>{fs.mkdirSync(path.dirname(f),{recursive:true});fs.writeFileSync(f,b);};
const rows=f=>fs.existsSync(f)?read(f).trim().split('\n').filter(Boolean).map(JSON.parse):[];
// lstat, so a dangling link counts as present.
const present=f=>{try{fs.lstatSync(f);return true;}catch{return false;}};
const readOr=f=>present(f)?read(f):null;

if(process.argv[2]==='cli'){
  // A version probe is not a launch.
  if(process.argv.includes('--version')){console.log('0.0.0-fake');process.exit(0);}
  fs.appendFileSync(path.join(process.env.MOE_PROJECT_PATH,'.moe','wt-cli.log'),process.cwd()+'\n');
  // WT_CLI_RECORD: one JSON line per launch (cwd, argv, the four worktree env values, --mcp-config text,
  // and the prompt: the last argv, or the private session context file it points at).
  const argv=process.argv.slice(3),at=argv.indexOf('--mcp-config'),last=argv[argv.length-1]||'',
    ctx=/private session context file at (.+?)\. It contains/.exec(last);
  if(process.env.WT_CLI_RECORD)fs.appendFileSync(process.env.WT_CLI_RECORD,JSON.stringify({cwd:process.cwd(),argv,
    env:Object.fromEntries(['MOE_PROJECT_PATH','MOE_WORKTREE_PATH','MOE_TASK_BRANCH','MOE_LAND_TARGET'].map(k=>[k,process.env[k]??null])),
    mcpConfig:at>=0&&argv[at+1]?readOr(argv[at+1]):null,context:ctx?readOr(ctx[1]):last})+'\n');
  // WT_CLI_WRITE: {path: bytes}; a relative path is under W (MOE_WORKTREE_PATH), else the cwd.
  for(const [f,b] of Object.entries(JSON.parse(process.env.WT_CLI_WRITE||'{}')))write(path.resolve(process.env.MOE_WORKTREE_PATH||process.cwd(),f),b);
  process.exit(0);
}

const [platform,wrapper,proxy,parent,engine]=process.argv.slice(2),win=platform==='ps1',winHost=process.platform==='win32';
if(!['sh','ps1'].includes(platform)||!engine){
  console.error('usage: node postflight-worktree.cjs <sh|ps1> <wrapper> <fake-proxy> <parent-tmp> <engine>');process.exit(2);
}
const LIMIT=Number(process.env.MOE_POSTFLIGHT_TIMEOUT_SEC||180)*1000;
// Hermetic: a seat's own MOE_*/CLAUDE* session vars and a hook's GIT_* never reach the
// wrapper under test or the fixture's git; launch() sets the MOE_* the wrapper needs.
const inherited=Object.fromEntries(Object.entries(process.env)
  .filter(([k])=>!/^(FAKE_|WT_|OG_|MOE_|CLAUDE|BASH_ENV$|GIT_(DIR|WORK_TREE|INDEX_FILE|COMMON_DIR|OBJECT_DIRECTORY)$)/i.test(k)));
const pathKey=Object.keys(inherited).find(k=>k.toUpperCase()==='PATH')||'PATH';
const realGit=(()=>{
  for(const d of String(inherited[pathKey]||'').split(path.delimiter)){const f=d&&path.join(d,winHost?'git.exe':'git');if(f&&fs.existsSync(f))return f;}
  throw new Error('no git on PATH');
})();
const root=fs.mkdtempSync(path.join(parent,'worktree '));
// Wrapper temp files go to a dir this suite deletes, never the shared temp dir.
const wrapperTmp=fs.mkdtempSync(path.join(os.tmpdir(),'moe-worktree-wrapper-'));

// Harness git: a failed fixture step throws a plain Error. A trailing {env,input}
// object sets extra env (GIT_INDEX_FILE) or stdin.
function gitRun(dir,a){
  const o=a.length&&typeof a[a.length-1]==='object'?a.pop():{};
  return cp.spawnSync(realGit,['-C',dir,...a],{encoding:'utf8',input:o.input,env:{...inherited,GIT_OPTIONAL_LOCKS:'0',...o.env}});
}
function git(dir,...a){const r=gitRun(dir,a);if(r.status!==0)throw new Error(`git ${a.join(' ')}: exit ${r.status} ${r.stderr}`);return r.stdout;}
// State probes never throw: a missing ref or a detached HEAD is an answer to assert on.
const probe=(dir,...a)=>{const r=gitRun(dir,a);return r.status+':'+r.stdout;};
const revOf=(dir,ref)=>{const r=gitRun(dir,['rev-parse','--verify','--quiet',ref+'^{commit}']);return r.status===0?r.stdout.trim():null;};
// Comparable path: real path when it exists, forward slashes, case-folded on win32.
const norm=p=>{let r=p;try{r=fs.realpathSync.native(p);}catch{}r=r.replace(/\\/g,'/').replace(/\/+$/,'');return winHost?r.toLowerCase():r;};
// `worktree list --porcelain -z`: NUL-terminated fields, each record ends with an empty one.
function wt(top){
  const list=[];let cur=null;
  for(const f of git(top,'worktree','list','--porcelain','-z').split('\0')){
    if(!f){cur=null;continue;}
    const i=f.indexOf(' '),k=i<0?f:f.slice(0,i),v=i<0?'':f.slice(i+1);
    if(k==='worktree')list.push(cur={path:norm(v),branch:null,locked:null});
    else if(cur&&(k==='branch'||k==='locked'))cur[k]=v;
  }
  return list;
}
const entry=p=>wt(p.top).find(e=>e.path===norm(p.W));
// What provisioning must never change in the control checkout (its .moe runtime aside).
// ls-files -t tags skip-worktree entries S: a sparse-checkout run in the control checkout
// deletes its tracked .moe yet leaves `status` clean.
const control=top=>({head:probe(top,'symbolic-ref','-q','HEAD'),sha:probe(top,'rev-parse','HEAD'),index:probe(top,'ls-files','-s','-t'),
  status:probe(top,'status','--porcelain=v1','-uall','--','.',':(exclude,glob)**/.moe/**')});
const controlSame=(p,before)=>assert.deepEqual(control(p.top),before,"the control checkout's HEAD, index or status changed");
const tail=log=>'\n'+log.split(/\r?\n/).slice(-25).join('\n');

// The fixture: main holds the seed, the control checkout follows moe/control, .moe
// runtime is untracked, and autoCommit:false, so no launch lands anything. Like the real
// project, .gitignore also holds what every wrapper run writes (.mcp.json, logs/).
function repo(name,{task=TASK,sub='',settings={}}={}){
  const top0=path.join(root,name),dir=sub?path.join(top0,sub):top0,moe=f=>path.join(dir,'.moe',f);
  write(path.join(top0,'.gitignore'),'.worktrees/\n.mcp.json\nlogs/\n');write(path.join(top0,'src','a.txt'),'seed a\n');
  write(moe('project.json'),JSON.stringify({id:'proj-worktree',name:'Worktree',settings:{autoCommit:false,...settings}}));
  write(moe('tasks/'+task+'.json'),JSON.stringify({id:task,title:'Worktree smoke',status:'WORKING'}));
  git(top0,'init','-q');git(top0,'symbolic-ref','HEAD','refs/heads/main');
  for(const [k,v] of [['core.autocrlf','false'],['user.name','Moe Test'],['user.email','moe@test.local']])git(top0,'config',k,v);
  git(top0,'add','--','.');git(top0,'commit','-qm','seed');git(top0,'switch','-q','-c','moe/control');
  write(moe('messages/chan-general.jsonl'),'');write(moe('daemon.json'),JSON.stringify({port:9876,projectPath:dir}));
  const top=git(top0,'rev-parse','--show-toplevel').trim(),W=top+'/.worktrees/'+task;
  return {name,top,dir,task,W,branch:'refs/heads/moe/task/'+task,
    ws:(o={})=>JSON.stringify({mode:'worktree',path:W,branch:'moe/task/'+task,target:'main',...o})};
}
// A commit made with plumbing (HEAD's tree plus files), so the control checkout never moves.
function commitOn(p,ref,files){
  const env={GIT_INDEX_FILE:path.join(root,p.name+'.index')};
  git(p.top,'read-tree','HEAD',{env});
  for(const [f,b] of Object.entries(files)){
    const blob=git(p.top,'hash-object','-w','--stdin',{input:b}).trim();
    git(p.top,'update-index','--add','--cacheinfo',`100644,${blob},${f}`,{env});
  }
  const c=git(p.top,'commit-tree',git(p.top,'write-tree',{env}).trim(),'-p','HEAD','-m','fixture '+ref).trim();
  git(p.top,'update-ref',ref,c);return c;
}

// PATH-first git stub: WT_GIT_VERSION answers a version probe at any argv position,
// WT_GIT_FAIL fails any call with that argv element, the first fetch moves WT_GIT_SWAP over
// WT_GIT_SWAP_TO; the rest runs the real git. sh
// engines find `git`; PowerShell finds git.ps1 (a .cmd would mangle `%` in --format).
function stub(){
  const dir=path.join(root,'git-stub');
  if(present(dir))return dir;
  write(path.join(dir,'git'),`#!/bin/sh
for a in "$@"; do
  if [ -n "$WT_GIT_VERSION" ] && { [ "$a" = --version ] || [ "$a" = version ]; }; then echo "git version $WT_GIT_VERSION"; exit 0; fi
  if [ -n "$WT_GIT_FAIL" ] && [ "$a" = "$WT_GIT_FAIL" ]; then echo "fatal: wt stub fails $a" >&2; exit 1; fi
  if [ "$a" = fetch ] && [ -n "$WT_GIT_SWAP" ] && [ -f "$WT_GIT_SWAP" ]; then mv -f "$WT_GIT_SWAP" "$WT_GIT_SWAP_TO"; fi
done
exec "${realGit.replace(/\\/g,'/')}" "$@"
`);
  fs.chmodSync(path.join(dir,'git'),0o755);
  // Git Bash's bin/bash.exe puts /mingw64/bin ahead of the inherited PATH; launch()
  // points BASH_ENV here so bash itself puts the stub first again.
  write(path.join(dir,'env.sh'),`PATH='${winHost?dir.replace(/^([A-Za-z]):/,(m,d)=>'/'+d.toLowerCase()).replace(/\\/g,'/'):dir}':"$PATH"\n`);
  const real=`'${realGit.replace(/'/g,"''")}'`;
  // No [CmdletBinding()]: -C must bind as a plain arg. Piped input (hash-object
  // --stdin-paths) is forwarded; exit carries git's code to $LASTEXITCODE.
  write(path.join(dir,'git.ps1'),`$ErrorActionPreference = 'Continue'
foreach ($a in $args) {
  if ($env:WT_GIT_VERSION -and ($a -ceq '--version' -or $a -ceq 'version')) { "git version $env:WT_GIT_VERSION"; exit 0 }
  if ($env:WT_GIT_FAIL -and $a -ceq $env:WT_GIT_FAIL) { [Console]::Error.WriteLine("fatal: wt stub fails $a"); exit 1 }
  if ($a -ceq 'fetch' -and $env:WT_GIT_SWAP -and (Test-Path -LiteralPath $env:WT_GIT_SWAP)) { Move-Item -LiteralPath $env:WT_GIT_SWAP -Destination $env:WT_GIT_SWAP_TO -Force }
}
if ($MyInvocation.ExpectingInput) { $input | & ${real} @args } else { & ${real} @args }
exit $LASTEXITCODE
`);
  return dir;
}

function cliShim(){
  const f=path.join(root,'wt-cli'+(win?'.cmd':'.sh')),fwd=s=>s.replace(/\\/g,'/');
  if(!present(f)){
    write(f,win?`@echo off\r\n"${process.execPath}" "${__filename}" cli\r\nexit /b %errorlevel%\r\n`
      :`#!/usr/bin/env bash\nexec "${fwd(process.execPath)}" "${fwd(__filename)}" cli\n`);
    fs.chmodSync(f,0o700);
  }
  return f;
}
// A fake CLI named <type> in its own directory (the wrappers take the CLI type from
// the --command basename), forwarding its argv.
function typeShim(type){
  const f=path.join(root,'shim-'+type,type+(win?'.cmd':'')),fwd=s=>s.replace(/\\/g,'/');
  if(!present(f)){
    write(f,win?`@echo off\r\n"${process.execPath}" "${__filename}" cli %*\r\nexit /b %errorlevel%\r\n`
      :`#!/usr/bin/env bash\nexec "${fwd(process.execPath)}" "${fwd(__filename)}" cli "$@"\n`);
    fs.chmodSync(f,0o700);
  }
  return f;
}
function killTree(child){
  if(child.exitCode!==null||child.signalCode!==null)return;
  if(winHost)cp.spawnSync('taskkill',['/T','/F','/PID',String(child.pid)],{stdio:'ignore'});
  else{try{process.kill(-child.pid,'SIGKILL');}catch{}}
}
// One worker-seat run. A null knob is unset; WT_GIT_* knobs put the stub first on PATH.
// opts.type launches typeShim(type) instead of the default CLI; opts.args extend the wrapper argv;
// opts.role replaces the worker role.
async function launch(p,run,knobs={},opts={}){
  const moe=f=>path.join(p.dir,'.moe',f),role=opts.role||'worker';
  for(const f of ['wt-cli.log','evidence-rpcs.jsonl','record_commit.jsonl','context-count'])fs.rmSync(moe(f),{force:true});
  fs.rmSync(moe('attempts'),{recursive:true,force:true});
  const cli=opts.type?typeShim(opts.type):cliShim();
  const args=win?['-NoProfile','-ExecutionPolicy','Bypass','-File',wrapper,'-Project',p.dir,'-WorkerId',WID,'-Role',role,'-Team','Smoke','-NoStartDaemon','-Command',cli,'-NoLoop','-PollInterval','0']
    :[wrapper,'--project',p.dir,'--worker-id',WID,'--role',role,'--team','Smoke','--no-start-daemon','--command',cli,'--no-loop','--poll-interval','0'];
  args.push(...(opts.args||[]));
  const env={...inherited,MOE_PROXY_PATH:proxy,MOE_NODE_COMMAND:process.execPath,MOE_DISABLE_HEARTBEAT:'1',
    HOME:path.join(root,'home'),USERPROFILE:path.join(root,'home'),TMPDIR:wrapperTmp,TMP:wrapperTmp,TEMP:wrapperTmp,
    FAKE_TASK_STATUS:'WORKING',FAKE_CLAIM_WORKSPACE:p.ws(),...knobs};
  for(const k of Object.keys(env))if(env[k]==null)delete env[k];
  if(env.WT_GIT_VERSION||env.WT_GIT_FAIL||env.WT_GIT_SWAP){
    env[pathKey]=stub()+path.delimiter+(inherited[pathKey]||'');
    if(!win)env.BASH_ENV=path.join(stub(),'env.sh');
  }
  const child=cp.spawn(engine,args,{env,stdio:['ignore','pipe','pipe'],detached:!winHost,windowsHide:true});
  let log='',timedOut=false;child.stdout.on('data',d=>{log+=d;});child.stderr.on('data',d=>{log+=d;});
  const timer=setTimeout(()=>{timedOut=true;killTree(child);},LIMIT);
  const code=await new Promise((res,rej)=>{child.on('error',rej);child.on('close',c=>res(c));}).finally(()=>clearTimeout(timer));
  log=util.stripVTControlCharacters(log);write(path.join(root,`${p.name}-${run}.log`),log);
  assert.ok(!timedOut,`${run}: the wrapper outlived ${LIMIT/1000}s and was killed`+tail(log));
  return {code,log,cliRan:present(moe('wt-cli.log')),blocked:rows(moe('evidence-rpcs.jsonl')).filter(r=>r.tool==='report_blocked')};
}

// A refusal: one [ERROR] line, exactly one report_blocked naming the task, the seat and
// the code, no CLI, exit 1.
function refused(r,code,task=TASK){
  assert.ok(r.log.includes(`[ERROR] ${code}:`),`no "[ERROR] ${code}:" line`+tail(r.log));
  assert.equal(r.blocked.length,1,`${r.blocked.length} report_blocked calls, expected 1`+tail(r.log));
  const a=r.blocked[0].args||{};
  assert.deepEqual([a.taskId,a.workerId],[task,WID],`report_blocked args ${JSON.stringify(a)}`);
  assert.ok(typeof a.reason==='string'&&a.reason.startsWith(code),`report_blocked reason ${JSON.stringify(a.reason)} does not start with ${code}`);
  assert.ok(!r.cliRan,'the CLI ran after a refusal'+tail(r.log));
  assert.equal(r.code,1,`exit code ${r.code}, expected 1`+tail(r.log));
}
// A provisioned W: the success line names it; registered, locked `moe <task>`, on its
// branch at tip; sparse without .moe; the control checkout untouched; the CLI ran.
function provisioned(p,r,verb,before,tip){
  const lines=[...r.log.matchAll(new RegExp(`^\\[worktree\\] ${verb} (.+) on moe/task/${p.task}\\r?$`,'gm'))];
  assert.equal(lines.length,1,`no single "[worktree] ${verb} <W> on moe/task/${p.task}" line`+tail(r.log));
  assert.equal(norm(lines[0][1]),norm(p.W),`the ${verb} line names ${lines[0][1]}, not ${p.W}`);
  const e=entry(p);
  assert.ok(e,'W is not a registered worktree');
  assert.deepEqual([e.branch,e.locked],[p.branch,'moe '+p.task],`W's worktree record ${JSON.stringify(e)}`);
  assert.equal(revOf(p.top,p.branch),tip,'the task branch tip');
  assert.equal(revOf(p.W,'HEAD'),tip,"W's HEAD is not the task branch tip");
  assert.ok(present(path.join(p.W,'src','a.txt')),'W/src/a.txt is not checked out');
  assert.ok(!present(path.join(p.W,'.moe')),'W/.moe exists');
  controlSame(p,before);
  assert.ok(r.cliRan&&r.blocked.length===0,`the CLI ran: ${r.cliRan}; report_blocked calls: ${r.blocked.length}`+tail(r.log));
  assert.equal(r.code,0,`exit code ${r.code}`+tail(r.log));
}

// create, reuse, re-add, then refuse a W holding .moe: one repository, four runs.
async function lifecycle(){
  const p=repo('lifecycle'),before=control(p.top),main=revOf(p.top,'refs/heads/main');
  provisioned(p,await launch(p,'create'),'created',before,main);
  const admin=git(p.W,'rev-parse','--absolute-git-dir').trim();
  write(path.join(admin,'wt-marker'),'marker\n');write(path.join(p.W,'dirt.txt'),'dirt\n');
  provisioned(p,await launch(p,'reuse'),'reused',before,main);
  assert.equal(readOr(path.join(admin,'wt-marker')),'marker\n',"reuse lost the marker in W's admin dir");
  assert.equal(readOr(path.join(p.W,'dirt.txt')),'dirt\n',"reuse lost W's dirt");
  write(path.join(p.W,'src','a.txt'),'task work\n');git(p.W,'add','--','src/a.txt');git(p.W,'commit','-qm','task work');
  const work=revOf(p.top,p.branch);
  git(p.top,'worktree','unlock',p.W);git(p.top,'worktree','remove','--force',p.W);
  if(present(p.W))throw new Error('fixture: W survived worktree remove');
  provisioned(p,await launch(p,'re-add'),'re-added',before,work);
  assert.equal(readOr(path.join(p.W,'src','a.txt')),'task work\n',"re-add did not check out the branch's commit");
  write(path.join(p.W,'.moe','x'),'x\n');
  refused(await launch(p,'moe-present'),'MOE_WORKTREE_MOE_PRESENT');
  assert.equal(readOr(path.join(p.W,'.moe','x')),'x\n','W/.moe/x was touched');
  assert.ok(entry(p),'W was unregistered');
  assert.equal(revOf(p.top,p.branch),work,'the task branch moved');
  controlSame(p,before);
}
// A resumed WORKING task: the workspace comes only from get_context.
async function resume(){
  const p=repo('resume',{task:'task-resume'}),before=control(p.top);
  const r=await launch(p,'resume',{FAKE_CLAIM_MODE:'resume',FAKE_CLAIM_WORKSPACE:null,FAKE_CTX_WORKSPACE:p.ws()});
  provisioned(p,r,'created',before,revOf(p.top,'refs/heads/main'));
}
// A session died between `worktree add --no-checkout` and read-tree: an empty index.
async function halfMade(){
  const p=repo('half-made'),before=control(p.top);
  git(p.top,'worktree','add','--lock','--reason','moe '+TASK,'--no-checkout','--no-track','-b','moe/task/'+TASK,p.W,'main');
  if(git(p.W,'ls-files')!=='')throw new Error('fixture: the half-made W has a non-empty index');
  provisioned(p,await launch(p,'half-made'),'reused',before,revOf(p.top,'refs/heads/main'));
}
// [case, code, knobs(p), setup(p) returning an extra check(p,r), repo options].
// Every refusal also leaves W unregistered and, but for dir-exists, absent.
const refusals=[
  ['git-old','MOE_WORKTREE_UNSUPPORTED_GIT',()=>({WT_GIT_VERSION:'2.37.9'}),
    ()=>(p,r)=>assert.match(r.log,/\[ERROR\] MOE_WORKTREE_UNSUPPORTED_GIT:[^\n]*2\.37\.9/,'the refusal does not name git 2.37.9')],
  ['not-top','MOE_WORKTREE_PROJECT_NOT_TOP',()=>({}),
    ()=>p=>assert.ok(!present(path.join(p.dir,'.worktrees')),'a worktree under the project'),{sub:'proj'}],
  ['control','MOE_CONTROL_NOT_FOLLOWING',()=>({}),p=>{git(p.top,'switch','-q','main');}],
  ['target-missing','MOE_WORKTREE_CREATE_FAILED',p=>({FAKE_CLAIM_WORKSPACE:p.ws({target:'nosuch'})}),
    ()=>p=>assert.equal(revOf(p.top,p.branch),null,'a task branch was created')],
  ['mismatch','MOE_WORKTREE_MODE_MISMATCH',
    p=>({FAKE_CTX_COMMITS:JSON.stringify([{kind:'checkpoint',sha:p.foreign,ref:'moe/work-2026-10-24'}])}),
    p=>{p.foreign=commitOn(p,'refs/heads/moe/work-2026-10-24',{'src/w.txt':'shared-mode bytes\n'});}],
  ['dir-exists','MOE_WORKTREE_CREATE_FAILED',()=>({}),p=>{
    write(path.join(p.W,'marker.txt'),'keep\n');
    return ()=>assert.deepEqual([present(p.W)&&fs.readdirSync(p.W),readOr(path.join(p.W,'marker.txt'))],[['marker.txt'],'keep\n'],
      'the pre-existing directory was touched');}],
  ['sparse-fail','MOE_WORKTREE_CREATE_FAILED',()=>({WT_GIT_FAIL:'sparse-checkout'})],
  // win32 only: len(W)+1+L lands in 241..250 while the control's path stays under 259.
  ['path-long','MOE_WORKTREE_PATH_TOO_LONG',()=>({}),p=>{
    const L=245-p.W.length-1;
    if(L<=10)throw new Error(`fixture: W is ${p.W.length} chars, no room for a path-long file`);
    const rel='long/'+'x'.repeat(L-5);
    write(path.join(p.top,rel),'long\n');git(p.top,'add','--',rel);git(p.top,'commit','-qm','long path');
    git(p.top,'branch','-f','main','HEAD');git(p.top,'config','core.longpaths','false');}],
  ['shared-unlanded','MOE_WORKTREE_MODE_MISMATCH',()=>({FAKE_CLAIM_WORKSPACE:null}),p=>{
    const c=commitOn(p,p.branch,{'src/b.txt':'unlanded\n'});
    return ()=>assert.equal(revOf(p.top,p.branch),c,'the unlanded task branch moved');}],
];
async function refusal(name,code,knobs,setup=()=>{},opts){
  const p=repo(name,opts),extra=setup(p),before=control(p.top);
  const r=await launch(p,name,knobs(p));
  refused(r,code);
  controlSame(p,before);
  assert.ok(!entry(p),'W is registered');
  if(name!=='dir-exists')assert.ok(!present(p.W),'W exists');
  if(extra)extra(p,r);
}
// Shared mode with the task branch fully landed in HEAD: the CLI launches as before.
async function sharedLanded(){
  const p=repo('shared-landed'),record=path.join(root,'shared-landed.jsonl');git(p.top,'branch','moe/task/'+TASK,'HEAD');
  const before=control(p.top),r=await launch(p,'shared-landed',{FAKE_CLAIM_WORKSPACE:null,WT_CLI_RECORD:record,MOE_SERENA_PATH:process.execPath},{type:'claude'});
  assert.ok(r.cliRan,'the CLI did not run'+tail(r.log));
  assert.equal(r.blocked.length,0,'report_blocked was called'+tail(r.log));
  assert.ok(!r.log.includes('MOE_WORKTREE_'),'a MOE_WORKTREE_ line in a shared-mode run'+tail(r.log));
  assert.ok(!present(p.W),'shared mode made a worktree');
  const rec=rows(record).pop();
  assert.ok(rec&&rec.context.includes('memory_total=')&&!rec.context.includes(DEPS_LINE),'shared mode got the worktree dependency line, or no session context'+tail(r.log));
  assert.ok(same(serenaOf(win?rec.mcpConfig.replace(/^﻿/,''):cfgText(path.join(p.dir,'.mcp.json'))),p.dir),'shared mode no longer roots Serena at the project');
  controlSame(p,before);
  assert.equal(r.code,0,`exit code ${r.code}`+tail(r.log));
}

// WT-05 (design §5.1-§5.2): in worktree mode every CLI runs against W, with W's own
// configs naming the control as the moe server's MOE_PROJECT_PATH.
const same=(a,b)=>typeof a==='string'&&typeof b==='string'&&norm(a)===norm(b);
const execFlag=t=>win?'-'+t[0].toUpperCase()+t.slice(1)+'Exec':'--'+t+'-exec';
const cfgText=f=>{assert.ok(present(f),`${f} is missing`);return read(f).replace(/^\uFEFF/,'');};
const jsonMoe=s=>JSON.parse(s).mcpServers.moe.env.MOE_PROJECT_PATH;
const tomlMoe=s=>{const m=/^MOE_PROJECT_PATH = (".*")\r?$/m.exec(s);assert.ok(m,'no MOE_PROJECT_PATH line in\n'+s);return JSON.parse(m[1]);};
// WT-06: Serena's --project in a JSON config or a TOML [mcp_servers.serena] table; null with no Serena server.
function serenaOf(text,toml=false){
  const m=toml?/^\[mcp_servers\.serena\]\r?\n(?:(?!\[).*\r?\n)*?args = (\[.*\])\r?$/m.exec(text):null;
  const a=toml?m&&JSON.parse(m[1]):(JSON.parse(text).mcpServers.serena||{}).args;
  return a?a[a.indexOf('--project')+1]:null;
}
const DEPS_LINE='Before testing a package in this worktree, run npm ci --prefer-offline in that package, plus npm run build where its tests require dist/.';
const SERENA_OFF='memory_total=0 (Serena is off for this launch: MOE_WORKTREE_LINK_FAILED .serena/memories)';
const LINKS=['.serena/memories','.claude/skills'];
// [banner, config path under its root]; the sh Gemini writer prints its banner twice.
const BANNERS={codex:['Codex MCP config written to:','.codex/config.toml'],gemini:['Gemini MCP config written to:','.gemini/settings.json'],
  grok:['Grok MCP config written to:','.grok/config.toml']};
// A fresh fixture whose control holds an untracked .moe/agents/x.md, and its headless launch.
function wtCase(name,type){
  const p=repo(name),dir=path.join(root,name+'-case'),record=path.join(dir,'record.jsonl'),grokHome=path.join(dir,'grok-home');
  fs.mkdirSync(dir,{recursive:true});write(path.join(p.dir,'.moe','agents','x.md'),'agent x\r\nbytes\n');
  // The shared tooling W links to (WT-06): the control's Serena memories and Claude skills.
  write(path.join(p.dir,'.serena','memories','m.md'),'memory\n');write(path.join(p.dir,'.claude','skills','s','SKILL.md'),'skill\n');
  return {p,record,grokHome,run:(k={})=>launch(p,name,{MOE_DISABLE_ARGV_PROBE:'1',WT_CLI_RECORD:record,GROK_HOME:grokHome,
    MOE_SERENA_PATH:process.execPath,...k},{type,args:type==='claude'?[]:[execFlag(type)]})};
}
async function launchAs(type){
  const c=wtCase('launch-'+type,type),{p}=c,r=await c.run();
  assert.equal(r.code,0,`exit code ${r.code}`+tail(r.log));
  const recs=rows(c.record),rec=recs[0];
  assert.equal(recs.length,1,`${recs.length} CLI launches recorded, expected 1`+tail(r.log));
  if(type!=='codex')assert.ok(same(rec.cwd,p.W),`the CLI ran in ${rec.cwd}, not W`);
  const flag={codex:'-C',grok:'--cwd'}[type],at=rec.argv.indexOf(flag);
  if(flag)assert.ok(at>=0&&same(rec.argv[at+1],p.W),`${flag} ${rec.argv[at+1]} is not W: ${JSON.stringify(rec.argv)}`);
  assert.ok(same(rec.env.MOE_PROJECT_PATH,p.dir),`MOE_PROJECT_PATH ${rec.env.MOE_PROJECT_PATH} is not the control`);
  assert.ok(same(rec.env.MOE_WORKTREE_PATH,p.W),`MOE_WORKTREE_PATH ${rec.env.MOE_WORKTREE_PATH} is not W`);
  assert.deepEqual([rec.env.MOE_TASK_BRANCH,rec.env.MOE_LAND_TARGET],['moe/task/'+TASK,'main'],'MOE_TASK_BRANCH / MOE_LAND_TARGET');
  const inW=f=>path.join(p.W,...f.split('/')),named=[],ctl=[];
  if(!win){named.push(['W/.mcp.json',cfgText(inW('.mcp.json'))]);ctl.push('.mcp.json');}
  if(win&&type==='claude'){assert.ok(rec.mcpConfig,'no --mcp-config text recorded');named.push(['the temp --mcp-config',rec.mcpConfig.replace(/^\uFEFF/,'')]);}
  if(BANNERS[type]){named.push(['W/'+BANNERS[type][1],cfgText(inW(BANNERS[type][1]))]);ctl.push(BANNERS[type][1]);}
  // The moe server names the control; Serena is rooted at W in W's configs and still at the control in the control's.
  for(const [what,t] of named){
    const toml=what.endsWith('.toml'),v=toml?tomlMoe(t):jsonMoe(t);
    assert.ok(same(v,p.dir),`${what} names ${v} as MOE_PROJECT_PATH, not the control`);
    assert.ok(same(serenaOf(t,toml),p.W),`${what} roots Serena at ${serenaOf(t,toml)}, not W`);
  }
  for(const f of ctl)assert.ok(same(serenaOf(cfgText(path.join(p.dir,f)),f.endsWith('.toml')),p.dir),`the control's ${f} no longer roots Serena at the control`);
  for(const f of {codex:['.codex/agent-instructions.md'],gemini:['.gemini/GEMINI.md']}[type]||[])assert.ok(present(inW(f)),`W/${f} is missing`);
  // Each writer wrote the control once (the pre-flight) and W once: never the control twice.
  for(const [b,rel] of (win?[]:[['Wrote project MCP config:','.mcp.json']]).concat(BANNERS[type]?[BANNERS[type]]:[])){
    const n=!win&&type==='gemini'&&rel==='.gemini/settings.json'?2:1,count={W:0,control:0,other:0};
    for(const m of r.log.matchAll(new RegExp(b.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+' (.+?)\\r?$','gm'))){
      const f=m[1].replace(/\\/g,'/');count[f.endsWith(`/.worktrees/${TASK}/${rel}`)?'W':f.endsWith('/'+rel)?'control':'other']++;
    }
    assert.deepEqual(count,{W:n,control:n,other:0},`"${b}" lines by root`+tail(r.log));
  }
  const src=path.join(p.dir,'.moe','agents'),dst=inW('.claude/agents'),names=fs.readdirSync(src).filter(n=>n.endsWith('.md')).sort();
  assert.deepEqual(present(dst)?fs.readdirSync(dst).sort():null,names,'W/.claude/agents does not hold exactly .moe/agents/*.md');
  for(const n of names)assert.ok(fs.readFileSync(path.join(dst,n)).equals(fs.readFileSync(path.join(src,n))),`W/.claude/agents/${n} differs`);
  if(type==='grok'){
    const t=readOr(path.join(c.grokHome,'trusted_folders.toml'))||'';
    assert.ok([...t.matchAll(/^\[folders\.'(.+)'\]\r?$/gm)].some(m=>same(m[1],p.W)),'grok trust does not name W:\n'+t);
  }
  assert.ok(!present(inW('.moe')),'W/.moe exists');
}
// A failed config write in W refuses: W is already provisioned (index present), so the
// failure is the codex writer's, whose config.toml is a directory.
async function configFail(){
  const c=wtCase('config-fail','codex'),{p}=c;
  preProvision(p);fs.mkdirSync(path.join(p.W,'.codex','config.toml'),{recursive:true});
  refused(await c.run(),'MOE_WORKTREE_CREATE_FAILED');
  assert.ok(!present(c.record),'a CLI launch was recorded');
}
// A fully provisioned W made ahead of the launch, which then reuses it.
function preProvision(p){
  git(p.top,'worktree','add','--lock','--reason','moe '+TASK,'--no-checkout','--no-track','-b','moe/task/'+TASK,p.W,'main');
  git(p.W,'sparse-checkout','set','--no-cone','/*','!/.moe/');git(p.W,'read-tree','-mu','HEAD');
}

// WT-06 (design §5.2-§5.4, §1.10): Serena root, the shared links and their manifest,
// the task-named project.yml and the dependency notice.
const manifest=p=>path.join(git(p.top,'rev-parse','--path-format=absolute','--git-common-dir').trim(),'moe','worktree',p.task+'.links');
const warned=(log,code)=>[...log.matchAll(new RegExp(`^\\[WARN\\] ${code} (.+?)\\r?$`,'gm'))].map(m=>m[1]).sort();
const claudeCfg=(p,rec)=>win?rec.mcpConfig.replace(/^﻿/,''):cfgText(path.join(p.W,'.mcp.json'));
// Every node_modules under W (W's .git file and links are not followed).
const nodeModules=(top,rel='')=>fs.readdirSync(path.join(top,rel),{withFileTypes:true}).flatMap(d=>{const r=rel?rel+'/'+d.name:d.name;
  return d.name==='node_modules'?[r]:d.isDirectory()&&!d.isSymbolicLink()?nodeModules(top,r):[];});
// Removes a link the wrapper made, never its target: unlink, else rmdir (a Windows junction).
function unlinkOnly(f){
  if(!present(f))return;
  assert.ok(fs.lstatSync(f).isSymbolicLink(),`${f} is not a link`);
  try{fs.unlinkSync(f);}catch{fs.rmdirSync(f);}
}
async function tooling(){
  const c=wtCase('tooling','claude'),{p}=c,yml="# keep\r\nproject_name: 'fix''ture' # name\r\nlanguages: [x]\r\n";
  for(const [f,b] of [['.serena/project.yml',yml],['pkg one/node_modules/sentinel','control deps\n'],['loose/package-lock.json','{}\n']])write(path.join(p.dir,f),b);
  commitOn(p,'refs/heads/main',{'package-lock.json':'{}\n','pkg one/package-lock.json':'{}\n','inst/package-lock.json':'{}\n'});
  preProvision(p);fs.mkdirSync(path.join(p.W,'inst','node_modules'));
  try{
    for(const run of [1,2]){
      // A missing override falls back to the control, so Serena is rooted at W.
      const r=await c.run({MOE_SERENA_PROJECT:path.join(root,'no such dir')}),rec=rows(c.record).pop();
      assert.ok(r.code===0&&rec,`run ${run}: exit code ${r.code}, CLI launched: ${!!rec}`+tail(r.log));
      assert.ok(same(serenaOf(claudeCfg(p,rec)),p.W),`run ${run}: Serena is not rooted at W`);
      for(const l of LINKS){
        const f=path.join(p.W,l);
        assert.ok(present(f)&&fs.lstatSync(f).isSymbolicLink()&&norm(f)===norm(path.join(p.dir,l)),`run ${run}: W/${l} is not a link to the control's`);
      }
      assert.equal(readOr(manifest(p)),LINKS.join('\n')+'\n',`run ${run}: the link manifest`);
      assert.equal(readOr(path.join(p.W,'.serena','project.yml')),yml.replace("'fix''ture'","'fix''ture@task-postflight'"),`run ${run}: W/.serena/project.yml`);
      assert.deepEqual(warned(r.log,'MOE_WORKTREE_DEPS_MISSING'),['.','pkg one'],`run ${run}: MOE_WORKTREE_DEPS_MISSING lines`+tail(r.log));
      assert.equal(rec.context.split(DEPS_LINE).length,2,`run ${run}: the dependency line is not in the prompt exactly once`);
      assert.match(rec.context,/^memory_recent=m\r?$/m,`run ${run}: the memory preload is gone`);
      assert.deepEqual(warned(r.log,'MOE_WORKTREE_LINK_FAILED'),[],`run ${run}: a link failed`+tail(r.log));
    }
    assert.deepEqual(nodeModules(p.W),['inst/node_modules'],'node_modules made in W');
    assert.equal(readOr(path.join(p.dir,'pkg one','node_modules','sentinel')),'control deps\n',"the control's node_modules changed");
    assert.equal(readOr(path.join(p.dir,'.serena','project.yml')),yml,"the control's project.yml changed");
  }finally{for(const l of LINKS)unlinkOnly(path.join(p.W,l));}
  assert.deepEqual([readOr(path.join(p.dir,'.serena','memories','m.md')),readOr(path.join(p.dir,'.claude','skills','s','SKILL.md'))],
    ['memory\n','skill\n'],'unlinking touched a shared target');
}
// An occupied W/.serena/memories and a missing control .claude/skills: both warn, bytes stay,
// the seat launches with Moe and no Serena (a stale TOML entry included), and no inbox memory names.
async function linkFail(){
  const c=wtCase('link-fail','codex'),{p}=c;
  fs.rmSync(path.join(p.dir,'.claude','skills'),{recursive:true});preProvision(p);write(path.join(p.W,'.serena','memories','keep.md'),'keep\n');
  write(path.join(p.W,'.codex','config.toml'),`[mcp_servers.serena]\ncommand = "stale"\nargs = ["--project", "stale"]\n`);
  const r=await c.run(),rec=rows(c.record).pop();
  assert.ok(r.code===0&&rec,`exit code ${r.code}, CLI launched: ${!!rec}`+tail(r.log));
  assert.deepEqual(warned(r.log,'MOE_WORKTREE_LINK_FAILED').map(s=>s.split(':')[0]),['.claude/skills','.serena/memories'],'MOE_WORKTREE_LINK_FAILED lines'+tail(r.log));
  assert.ok(!fs.lstatSync(path.join(p.W,'.serena','memories')).isSymbolicLink(),'the occupied W/.serena/memories became a link');
  assert.equal(readOr(path.join(p.W,'.serena','memories','keep.md')),'keep\n','W/.serena/memories/keep.md changed');
  assert.ok(!present(path.join(p.W,'.claude','skills'))&&!present(path.join(p.W,'.serena','project.yml')),'a skills link or a project.yml was made');
  assert.equal(readOr(manifest(p)),null,'a link manifest for links never made');
  const toml=cfgText(path.join(p.W,'.codex','config.toml'));
  assert.deepEqual([serenaOf(toml,true),same(tomlMoe(toml),p.dir)],[null,true],'W/.codex/config.toml: a Serena server, or moe not naming the control');
  if(!win)assert.equal(serenaOf(cfgText(path.join(p.W,'.mcp.json'))),null,'W/.mcp.json has a Serena server');
  assert.ok(!/^memory_recent=/m.test(rec.context)&&rec.context.includes(SERENA_OFF),'the memory names survived in the prompt');
}
// A wrong skills link fails alone (Serena and the memory names stay); then a manifest that
// cannot be written (a directory) leaves the memories link unmade and Serena off.
async function linkPartial(){
  const c=wtCase('link-partial','claude'),{p}=c,wrong=path.join(root,'wrong skills'),W=l=>path.join(p.W,l);
  fs.mkdirSync(wrong,{recursive:true});preProvision(p);fs.mkdirSync(path.dirname(W('.claude/skills')),{recursive:true});
  fs.symlinkSync(wrong,W('.claude/skills'),win?'junction':'dir');
  try{
    let r=await c.run(),rec=rows(c.record).pop();
    assert.ok(r.code===0&&rec,`exit code ${r.code}, CLI launched: ${!!rec}`+tail(r.log));
    assert.deepEqual(warned(r.log,'MOE_WORKTREE_LINK_FAILED').map(s=>s.split(':')[0]),['.claude/skills'],'MOE_WORKTREE_LINK_FAILED lines'+tail(r.log));
    assert.ok(norm(W('.claude/skills'))===norm(wrong)&&norm(W('.serena/memories'))===norm(path.join(p.dir,'.serena','memories')),'a link was replaced or not made');
    assert.equal(readOr(manifest(p)),'.serena/memories\n','the link manifest');
    assert.ok(same(serenaOf(claudeCfg(p,rec)),p.W)&&/^memory_recent=m\r?$/m.test(rec.context),'a skills failure turned Serena off');
    unlinkOnly(W('.serena/memories'));fs.rmSync(manifest(p));fs.mkdirSync(manifest(p));
    r=await c.run();rec=rows(c.record).pop();
    assert.ok(r.code===0&&!present(W('.serena/memories')),`exit code ${r.code}, or a memories link with no manifest entry`+tail(r.log));
    assert.ok(serenaOf(claudeCfg(p,rec))===null&&rec.context.includes(SERENA_OFF),'Serena stayed on with no memories link');
  }finally{for(const l of LINKS)unlinkOnly(W(l));}
  assert.ok(present(wrong)&&present(path.join(p.dir,'.serena','memories','m.md')),'unlinking touched a link target');
}
// project_name variants through this wrapper's own node program (read from the control each
// time, so a rerun or another task never stacks suffixes); a non-scalar name refuses the seat.
async function projectYml(){
  const c=wtCase('project-yml','claude'),{p}=c,base=path.basename(p.dir),yml=path.join(p.dir,'.serena','project.yml'),
    js=(win?/\$js = @'\r?\n([\s\S]*?)^'@/m:/<<'MOE_WT_TOOLING_JS'\r?\n([\s\S]*?)^MOE_WT_TOOLING_JS$/m).exec(read(wrapper))[1];
  const copy=(text,tid=TASK)=>{
    write(yml,text);const r=cp.spawnSync(process.execPath,['-',p.dir,p.W,p.dir,tid],{input:js,encoding:'utf8'});
    assert.equal(r.status,0,`the node program failed on ${JSON.stringify(text)}: ${r.stdout}${r.stderr}`);
    return read(path.join(p.W,'.serena','project.yml'));
  };
  preProvision(p);
  for(const [text,want] of [['project_name: "fix\\"ture" # c\n','project_name: "fix\\"ture@T" # c\n'],
    ["a: 1\r\nproject_name: 'it''s'\r\nb: 2\r\n","a: 1\r\nproject_name: 'it''s@T'\r\nb: 2\r\n"],
    ['project_name: fix ture  # c\n','project_name: "fix ture@T"  # c\n'],['project_name: ~\n',`project_name: ${JSON.stringify(base+'@T')}\n`],
    ["project_name: ''\n",`project_name: '${base.replace(/'/g,"''")}@T'\n`],['b: [x]\r\n',`project_name: ${JSON.stringify(base+'@T')}\r\nb: [x]\r\n`]])
    assert.equal(copy(text),want.replace('@T','@'+TASK),`W/.serena/project.yml from ${JSON.stringify(text)}`);
  assert.deepEqual(['task-a','task-b','task-b'].map(t=>/^project_name: "(.*)"$/m.exec(copy('project_name: x\n',t))[1]),
    ['x@task-a','x@task-b','x@task-b'],'project_name across two tasks and a rerun');
  write(yml,'project_name: [x]\n');
  refused(await c.run(),'MOE_WORKTREE_CREATE_FAILED');
  assert.ok(!present(c.record)&&read(yml)==='project_name: [x]\n','a CLI launch was recorded, or the control project.yml changed');
}
// .moe-agent.json beats MOE_SERENA_PROJECT, and its spelling of the control maps to W; an
// override outside the control is kept, with MOE_WORKTREE_SERENA_OUTSIDE.
async function serenaOutside(){
  const c=wtCase('serena-outside','claude'),{p}=c,out=path.join(root,'outside serena'),cfg=path.join(p.dir,'.moe-agent.json');
  fs.mkdirSync(out,{recursive:true});write(cfg,JSON.stringify({serenaProject:p.dir+path.sep}));
  let r=await c.run({MOE_SERENA_PROJECT:out});
  assert.ok(same(serenaOf(claudeCfg(p,rows(c.record).pop())),p.W),'the control spelled with a trailing separator is not mapped to W'+tail(r.log));
  assert.deepEqual(warned(r.log,'MOE_WORKTREE_SERENA_OUTSIDE'),[],'MOE_WORKTREE_SERENA_OUTSIDE for the control');
  fs.rmSync(cfg);
  r=await c.run({MOE_SERENA_PROJECT:out});
  assert.ok(same(serenaOf(claudeCfg(p,rows(c.record).pop())),out),'the outside override was not kept'+tail(r.log));
  assert.equal(warned(r.log,'MOE_WORKTREE_SERENA_OUTSIDE').length,1,'no single MOE_WORKTREE_SERENA_OUTSIDE line'+tail(r.log));
}
// WT-07 (design §2.2 L0-L2, §2.4, §3): a worktree exit lands W's bytes on moe/task/<id>
// only, as a checkpoint; control seats land nothing. Settings land, but never push unless asked.
const LANDS={autoCommit:true,checkpointPush:false};
const ledger=p=>rows(path.join(p.dir,'.moe','record_commit.jsonl'));
const files=(p,ref)=>git(p.top,'ls-tree','-r','--name-only',ref).split('\n').filter(Boolean);
const parents=(dir,sha)=>git(dir,'rev-list','--parents','-n','1',sha).trim().split(' ').slice(1);
const noBaseline=p=>{for(const d of [p.top,p.W].filter(present)){const g=git(d,'rev-parse','--absolute-git-dir').trim();
  assert.ok(!present(path.join(g,'moe','baseline',TASK+'.tsv')),`a baseline file under ${g}`);}};
const landRun=(p,run,writes,knobs={},opts={})=>launch(p,run,{WT_CLI_WRITE:JSON.stringify(writes),...knobs},opts);
async function wtCheckpoint(){
  const p=repo('wt-checkpoint',{settings:LANDS}),main=revOf(p.top,'refs/heads/main'),before=control(p.top);
  const r=await landRun(p,'wt-checkpoint',{'src/a.txt':'task a\n','src/new.txt':'new\n'}),head=revOf(p.top,p.branch);
  assert.ok(r.code===0&&head!==main,`exit code ${r.code}; no checkpoint on the task branch`+tail(r.log));
  assert.deepEqual(parents(p.top,head),[main],'the checkpoint is not one commit on the previous tip');
  assert.deepEqual(['a','new'].map(f=>git(p.top,'show',`${head}:src/${f}.txt`)),['task a\n','new\n'],'the checkpoint tree');
  assert.equal(revOf(p.top,'refs/heads/main'),main,'the target moved');
  controlSame(p,before);
  const rec=ledger(p).pop()||{};
  assert.deepEqual({...rec,paths:rec.paths&&[...rec.paths].sort()},{...rec,outcome:'committed',kind:'checkpoint',ref:p.branch,sha:head,
    paths:['src/a.txt','src/new.txt'],inferredPaths:[],unattributedPaths:[],pushed:false},'the record_commit row');
  assert.equal(git(p.W,'status','--porcelain','--','src'),'',"W's index was not refreshed for the landed paths");
}
async function wtDeny(){
  const p=repo('wt-deny',{settings:LANDS}),deny={'.mcp.json':'{}\n','.codex/x':'x\n','.claude/skills/s.md':'s\n','.serena/f':'f\n'};
  const r=await landRun(p,'wt-deny',{'src/a.txt':'task a\n',...deny}),head=revOf(p.top,p.branch);
  assert.match(r.log,/MOE_ATTR_EXCLUDED/,'no MOE_ATTR_EXCLUDED line'+tail(r.log));
  assert.deepEqual(files(p,head).filter(f=>f in deny||f.startsWith('.claude/')),[],'a DENY path was committed');
  assert.equal(git(p.top,'show',head+':src/a.txt'),'task a\n','the landed bytes');
  for(const [f,b] of Object.entries(deny))assert.equal(readOr(path.join(p.W,f)),b,`W/${f} changed`);
  noBaseline(p);
}
// W dirt a session left (checkpoints off) becomes the next pre-flight's recovery checkpoint.
async function wtRecover(){
  const p=repo('wt-recover',{settings:LANDS}),main=revOf(p.top,'refs/heads/main');
  let r=await landRun(p,'wt-recover-1',{'src/left.txt':'left\n'},{MOE_DISABLE_CHECKPOINT:'1'});
  assert.equal(revOf(p.top,p.branch),main,'MOE_DISABLE_CHECKPOINT=1 still landed'+tail(r.log));
  r=await landRun(p,'wt-recover-2',{'src/own.txt':'own\n'});
  const m=/MOE_CHECKPOINT_RECOVERED task=(\S+) sha=([0-9a-f]{40})/.exec(r.log),head=revOf(p.top,p.branch);
  assert.ok(m&&m[1]===TASK,'no MOE_CHECKPOINT_RECOVERED line'+tail(r.log));
  assert.match(git(p.top,'log','-1','--format=%s',m[2]),/ recovered\n$/,'the recovery subject');
  assert.deepEqual([parents(p.top,m[2]),parents(p.top,head)],[[main],[m[2]]],"the recovery is not on the old tip, or not the session checkpoint's parent");
  assert.deepEqual([files(p,m[2]).includes('src/left.txt'),files(p,m[2]).includes('src/own.txt'),files(p,head).includes('src/own.txt')],
    [true,false,true],'the recovery or the session checkpoint holds the wrong bytes');
  noBaseline(p);
}
// The §1.6 guard comes first: with W/.moe present the seat refuses and recovers nothing.
async function wtRecoverMoe(){
  const p=repo('wt-recover-moe',{settings:LANDS}),main=revOf(p.top,'refs/heads/main');
  await landRun(p,'wt-recover-moe-1',{'src/left.txt':'left\n'},{MOE_DISABLE_CHECKPOINT:'1'});
  write(path.join(p.W,'.moe','x'),'x\n');
  const r=await landRun(p,'wt-recover-moe-2',{});
  refused(r,'MOE_WORKTREE_MOE_PRESENT');
  assert.ok(revOf(p.top,p.branch)===main&&!r.log.includes('MOE_CHECKPOINT_RECOVERED'),'a recovery commit despite W/.moe'+tail(r.log));
  assert.deepEqual([readOr(path.join(p.W,'src','left.txt')),readOr(path.join(p.W,'.moe','x'))],['left\n','x\n'],'the dirt or W/.moe/x changed');
}
// Architect and QA seats in the control checkout (HEAD moe/control) land nothing, not even a
// declared (ASSERTED) path, which the shared landing commits even with no baseline.
async function wtControlSeats(){
  const p=repo('wt-control',{settings:LANDS});
  for(const role of ['architect','qa']){
    const rel='src/'+role+'.txt',f=path.join(p.top,'src',role+'.txt'),refs=()=>git(p.top,'for-each-ref','--format=%(refname) %(objectname)');
    write(path.join(p.dir,'.moe','tasks',TASK+'.json'),JSON.stringify({id:TASK,title:'Worktree smoke',status:'WORKING',declaredFiles:[rel]}));
    const before=refs();
    const r=await landRun(p,'wt-control-'+role,{[f]:role+'\n'},{FAKE_CLAIM_WORKSPACE:null,FAKE_SCOPE_DECLARED_FIELD:'1'},{role});
    assert.ok(r.code===0&&r.log.includes('MOE_COMMIT_NOTHING_TO_COMMIT'),`${role}: exit code ${r.code}, or no MOE_COMMIT_NOTHING_TO_COMMIT line`+tail(r.log));
    const rec=ledger(p);
    assert.deepEqual(rec.map(x=>[x.outcome,x.kind,x.code,x.sha,x.ref]),[['nothing','checkpoint','MOE_COMMIT_NOTHING_TO_COMMIT',undefined,undefined]],`${role}: the record_commit rows`);
    assert.deepEqual([refs(),probe(p.top,'symbolic-ref','-q','HEAD'),readOr(f)],[before,'0:refs/heads/moe/control\n',role+'\n'],`${role}: a ref moved, HEAD left moe/control, or the write changed`);
    noBaseline(p);
    assert.equal(git(p.top,'log','--all','--format=%H','--',rel),'',`${role}: the declared ${rel} reached a ref`);
  }
}
// A write into the control checkout is reported once, never landed or reverted; dirt that was there before is not.
async function wtStray(){
  const p=repo('wt-stray',{settings:LANDS}),stray=path.join(p.top,'stray.txt');write(path.join(p.top,'pre.txt'),'pre\n');
  const r=await landRun(p,'wt-stray',{'src/a.txt':'task a\n',[stray]:'stray\n'});
  assert.match(r.log,/MOE_WORKTREE_STRAY_EDIT count=1 /,'no MOE_WORKTREE_STRAY_EDIT count=1 line'+tail(r.log));
  const notes=rows(path.join(p.dir,'.moe','evidence-rpcs.jsonl')).filter(x=>x.tool==='add_comment').map(x=>x.args);
  assert.ok(notes.length===1&&notes[0].taskId===TASK&&notes[0].content.includes('stray.txt')&&!notes[0].content.includes('pre.txt'),
    'not one add_comment naming stray.txt alone: '+JSON.stringify(notes));
  assert.deepEqual([readOr(stray),readOr(path.join(p.top,'pre.txt')),git(p.top,'log','--all','--format=%H','--','stray.txt','pre.txt')],['stray\n','pre\n',''],
    'the stray or pre-existing bytes changed, or were committed');
}
// checkpointPush pushes the task branch without force; a divergent remote is CHECKPOINT-UNPUSHED and keeps both refs.
// origin holds main: a remote seat cuts W from origin's target (WT-09).
async function wtPush(){
  const p=repo('wt-push',{settings:{...LANDS,checkpointPush:true}}),bare=path.join(root,'wt-push.git');
  git(root,'init','-q','--bare',bare);git(p.top,'remote','add','origin',bare);git(p.top,'push','-q','origin','main');
  let r=await landRun(p,'wt-push-1',{'src/a.txt':'one\n'});
  const one=revOf(p.top,p.branch);
  assert.deepEqual([revOf(bare,p.branch),ledger(p).pop().pushed],[one,true],'the remote task branch is not the local tip, or pushed is not true'+tail(r.log));
  const div=commitOn(p,'refs/wt-push/div',{'src/d.txt':'divergent\n'});
  git(p.top,'push','-q','--force',bare,`${div}:${p.branch}`);git(p.top,'update-ref','-d','refs/wt-push/div');
  r=await landRun(p,'wt-push-2',{'src/a.txt':'two\n'});
  const two=revOf(p.top,p.branch);
  assert.match(r.log,new RegExp(`CHECKPOINT-UNPUSHED task=${TASK}`),'no CHECKPOINT-UNPUSHED line'+tail(r.log));
  assert.deepEqual([parents(p.top,two),revOf(bare,p.branch),ledger(p).pop().pushed],[[one],div,false],'the local checkpoint, the remote ref or pushed');
}
// WT-08 (design §2.2 L4-L12): a REVIEW exit lands the net change on main as ONE squash
// commit by a local CAS, records its exact completion row, syncs the task branch, finalizes landed.
const REVIEW={FAKE_TASK_STATUS:'REVIEW'},mainOf=p=>revOf(p.top,'refs/heads/main');
const journal=p=>path.join(git(p.top,'rev-parse','--absolute-git-dir').trim(),'moe','receipt',TASK+'.json');
const finals=p=>rows(path.join(p.dir,'.moe','evidence-rpcs.jsonl')).filter(x=>x.tool==='finalize_attempt').map(x=>[x.args.outcome,x.args.landedRevision]);
const done=p=>ledger(p).filter(x=>x.kind==='completion');
async function wtCompletion(){
  const p=repo('wt-completion',{settings:LANDS}),main=mainOf(p),before=control(p.top);
  const r=await landRun(p,'wt-completion',{'src/a.txt':'done\n'},REVIEW),c=mainOf(p);
  assert.ok(r.code===0&&c!==main,`exit code ${r.code}, or main did not move`+tail(r.log));
  assert.deepEqual([parents(p.top,c),git(p.top,'show',c+':src/a.txt'),/^Moe-Kind: completion$/m.test(git(p.top,'log','-1','--format=%B',c))],
    [[main],'done\n',true],'C is not one completion commit on the old main');
  assert.deepEqual(done(p).map(x=>[x.outcome,x.sha,x.ref,x.pushed,x.paths,x.inferredPaths]),[['committed',c,'refs/heads/main',false,['src/a.txt'],[]]],'the completion row');
  assert.deepEqual([finals(p),probe(p.top,'merge-base','--is-ancestor',c,p.branch),present(journal(p))],[[['landed',c]],'0:',false],
    'finalize, the task branch lacks C, or the journal stayed'+tail(r.log));
  controlSame(p,before);
}
// commitHooks: the hook runs on the merged tree (peer and task bytes, no .moe); a staged or unstaged
// hook edit, or a hook that moves HEAD, is refused (failed, T rescued, main unmoved); a no-op hook
// lands C; no hook worktree is left behind and the control checkout is untouched.
async function wtHooks(){
  const p=repo('wt-hooks',{settings:{...LANDS,commitHooks:true}}),out=path.join(root,'wt-hooks.out'),hook=path.join(p.top,'.git','hooks','pre-commit');
  write(hook,`#!/bin/sh\n{ [ -e .moe ] && echo moe; cat src/a.txt src/peer.txt; } > "${out.replace(/\\/g,'/')}"\n`+
    'case "$WT_HOOK_MODE" in staged) echo hooked > src/a.txt && git add src/a.txt ;; unstaged) echo hooked > src/a.txt ;; parent) git reset -q --soft HEAD~1 ;; esac\n');
  fs.chmodSync(hook,0o755);
  await landRun(p,'wt-hooks-0',{'src/a.txt':'task\n'});
  const peer=commitOn(p,'refs/heads/main',{'src/peer.txt':'peer\n'}),t=revOf(p.top,p.branch),before=control(p.top);
  for(const mode of ['staged','unstaged','parent','']){
    fs.rmSync(out,{force:true});
    const r=await landRun(p,'wt-hooks-'+(mode||'ok'),{},{...REVIEW,WT_HOOK_MODE:mode}),c=mainOf(p);
    const m=/MOE_RESCUE_REF task=\S+ ref=\S+ sha=([0-9a-f]{40}) reason=commit-failed/.exec(r.log);
    assert.deepEqual([readOr(out),mode?[c,m&&m[1],done(p).map(x=>x.outcome)]:[parents(p.top,c),git(p.top,'show',c+':src/a.txt')]],
      ['task\npeer\n',mode?[peer,t,['failed']]:[[peer],'task\n']],`hook ${mode||'no-op'}: its view, main, the rescue or the row`+tail(r.log));
  }
  assert.equal(git(p.top,'worktree','list','--porcelain').match(/^worktree /gm).length,2,'a hook worktree was left behind');
  controlSame(p,before);
}
// A finalize_attempt refusal keeps the journal; the next pre-flight re-sends its exact row, closes the
// still-finalizing attempt landed and drops the journal, with no second CAS.
async function wtReplay(){
  const p=repo('wt-replay',{settings:LANDS}),main=mainOf(p);
  let r=await landRun(p,'wt-replay-1',{'src/a.txt':'done\n'},{...REVIEW,FAKE_EVIDENCE_MODE:'finalize_attempt-refuse'});
  const c=mainOf(p),row=done(p);
  assert.ok(c!==main&&row.length===1&&row[0].sha===c&&present(journal(p)),'no landing, no row, or no kept journal'+tail(r.log));
  // While the journal stays, newer task work is refused (it still owes C's row): no CAS, no rescue ref.
  r=await landRun(p,'wt-replay-owed',{'src/b.txt':'newer\n'},{...REVIEW,FAKE_ATTEMPT_PHASE:'finalizing',FAKE_EVIDENCE_MODE:'finalize_attempt-refuse'});
  assert.deepEqual([mainOf(p),present(journal(p)),done(p).map(x=>[x.outcome,x.code]),/MOE_RESCUE_REF/.test(r.log)],
    [c,true,[['committed',undefined],['refused','MOE_COMMIT_REFUSED_UNRECONCILED_INTENT']],false],'main, the journal, the rows or a rescue ref'+tail(r.log));
  r=await landRun(p,'wt-replay-2',{},{FAKE_ATTEMPT_PHASE:'finalizing'});
  assert.deepEqual([mainOf(p),parents(p.top,c),present(journal(p)),done(p),finals(p)],[c,[main],false,row,[['landed',c]]],
    'main moved again, the journal stayed, the replayed row differs, or no landed finalize'+tail(r.log));
}
// WT-09 (§2.6): a replay drops a remote journal whose C can never apply (origin moved past B without it), but never
// one rewritten while its reconcile ran (a live lander's next round; WT_GIT_SWAP rewrites it at that fetch).
async function wtReplayRemote(){
  const p=repo('wt-replay-remote',{settings:LANDS}),bare=path.join(root,'wt-replay-remote.git'),net={MOE_LAND_NET_BACKOFF_SEC:'0'};
  git(root,'init','-q','--bare',bare);git(p.top,'remote','add','origin',bare);git(p.top,'push','-q','origin','main');
  let r=await landRun(p,'wt-replay-remote-1',{'src/a.txt':'done\n'},{...REVIEW,...net,WT_GIT_FAIL:'push'});
  const j1=readOr(journal(p)),peer=commitOn(p,'refs/wt-replay-remote/peer',{'src/peer.txt':'peer\n'}),swap=path.join(root,'wt-replay-remote.j2');
  assert.ok(r.log.includes('MOE_PUSH_OUTCOME_UNKNOWN')&&j1,'no unknown push outcome, or no kept journal'+tail(r.log));
  const j2=JSON.stringify({...JSON.parse(j1.replace(/^﻿/,'')),targetBefore:peer});
  git(p.top,'push','-q','origin',peer+':refs/heads/main');write(swap,j2);
  r=await landRun(p,'wt-replay-remote-2',{},{...net,WT_GIT_SWAP:swap,WT_GIT_SWAP_TO:journal(p)});
  assert.deepEqual([present(swap),readOr(journal(p)),r.log.includes('rewritten or removed meanwhile'),/MOE_PUSH_FAILED/.test(r.log)],[false,j2,true,false],
    'no swap, or the replay dropped a journal rewritten meanwhile'+tail(r.log));
  write(journal(p),j1);r=await landRun(p,'wt-replay-remote-3',{},net);
  assert.deepEqual([present(journal(p)),/MOE_PUSH_FAILED: task \S+ -- origin moved past/.test(r.log),revOf(bare,'refs/heads/main'),done(p).length,finals(p).filter(x=>x[0]==='landed')],
    [false,true,peer,0,[]],'the journal stayed, origin moved, or C was recorded or finalized'+tail(r.log));
}
// A failed sync (MOE_WORKTREE_SYNC_FAILED) leaves the landing standing; the next pre-flight syncs the recorded C in,
// but never a C the target lacks (even one T adds nothing to), nor over newer task work (a C^{tree} sync drops it).
async function wtSync(){
  const p=repo('wt-sync',{settings:LANDS});
  const ctx=sha=>({FAKE_CTX_COMMITS:JSON.stringify([{kind:'completion',outcome:'committed',sha,ref:'refs/heads/main'}])});
  let r=await landRun(p,'wt-sync-1',{'src/a.txt':'done\n'},{...REVIEW,WT_GIT_FAIL:'--ff-only'});
  const c=mainOf(p),t=revOf(p.top,p.branch);
  assert.deepEqual([r.log.includes('MOE_WORKTREE_SYNC_FAILED'),probe(p.top,'merge-base','--is-ancestor',c,p.branch),finals(p)],[true,'1:',[['landed',c]]],
    'no sync failure, or the landing did not stand'+tail(r.log));
  const off=commitOn(p,'refs/heads/moe/work-x',{'src/a.txt':'done\n','src/x.txt':'shared\n'});
  r=await landRun(p,'wt-sync-off',{},ctx(off));
  assert.deepEqual([revOf(p.top,p.branch),r.log.includes('MOE_WORKTREE_SYNC_FAILED')],[t,false],'the pre-flight synced a C off the target'+tail(r.log));
  write(path.join(p.W,'src','b.txt'),'newer\n');git(p.W,'add','--','src/b.txt');git(p.W,'commit','-qm','newer task work');
  const n=revOf(p.top,p.branch);
  r=await landRun(p,'wt-sync-newer',{},ctx(c));
  assert.deepEqual([revOf(p.top,p.branch),r.log.includes('holds work its landed')],[n,true],'the pre-flight synced over newer work, or no warning'+tail(r.log));
  git(p.W,'reset','-q','--hard',t);
  r=await landRun(p,'wt-sync-2',{},ctx(c));
  const s=revOf(p.top,p.branch);
  assert.deepEqual([parents(p.top,s),revOf(p.W,'HEAD')],[[t,c],s],'the pre-flight did not sync C into the task branch'+tail(r.log));
}
// Fail closed, main unmoved: a qualityGate (WT-10), a remote whose fetch fails (WT-09), a merge-tree failure that is no conflict
// (exit 1 without a tree), an unwritable journal, three lost CAS rounds.
async function wtFails(){
  const bare=n=>{const b=path.join(root,n+'.git');git(root,'init','-q','--bare',b);return b;};
  for(const [n,settings,knobs,setup,code,why] of [
    ['wt-gate',{qualityGate:'node -e 0'},{},null,'MOE_COMMIT_FAILED',/qualityGate/],
    ['wt-merge-tree',{},{WT_GIT_FAIL:'merge-tree'},null,'MOE_COMMIT_FAILED',/merge-tree exited/],
    ['wt-remote',{},{MOE_LAND_NET_BACKOFF_SEC:'0'},async p=>{await landRun(p,'wt-remote-0',{});git(p.top,'remote','add','origin',bare('wt-remote'));},
      'MOE_LAND_FETCH_FAILED',/git fetch origin main failed 3 times/],
    ['wt-journal',{},{},p=>write(path.dirname(journal(p)),'x\n'),'MOE_COMMIT_FAILED',/receipt journal .* could not be written/],
    ['wt-exhausted',{},{WT_GIT_FAIL:'update-ref'},p=>landRun(p,'wt-exhausted-0',{'src/a.txt':'done\n'}),'MOE_COMMIT_FAILED_REF_CONTENTION',/all 3 rounds/]]){
    const p=repo(n,{settings:{...LANDS,...settings}}),main=mainOf(p);
    if(setup)await setup(p);
    const r=await landRun(p,n,setup&&knobs.WT_GIT_FAIL?{}:{'src/a.txt':'done\n'},{...REVIEW,...knobs}),row=done(p);
    assert.deepEqual([mainOf(p),row.map(x=>[x.outcome,x.code]),why.test(row[0]&&row[0].message),present(journal(p))],
      [main,[['failed',code]],true,false],`${n}: main moved, the row, or a journal stayed`+tail(r.log));
  }
}
// ONE CAS (design §2.2 L2): a task branch moved between commit-tree and update-ref is
// contention parked on a rescue ref, never a rebuild; the mover's tip and W's bytes stay.
async function wtContention(){
  const p=repo('wt-contention',{settings:LANDS}),main=revOf(p.top,'refs/heads/main');
  const moved=commitOn(p,'refs/wt-contention/moved',{'src/m.txt':'moved\n'});
  const r=await landRun(p,'wt-contention',{'src/a.txt':'task a\n'},{MOE_POSTFLIGHT_TEST_HOOK_PRE_UPDATE_REF:`git update-ref ${p.branch} ${moved}`});
  const m=/MOE_RESCUE_REF task=\S+ ref=(\S+) sha=([0-9a-f]{40}) reason=ref-contention/.exec(r.log);
  assert.ok(r.log.includes('MOE_COMMIT_FAILED_REF_CONTENTION')&&m&&!/rebuilding/.test(r.log),'no single-CAS contention with a rescue ref'+tail(r.log));
  assert.deepEqual([revOf(p.top,p.branch),revOf(p.top,m[1]),parents(p.top,m[2]),git(p.top,'show',m[2]+':src/a.txt')],[moved,m[2],[main],'task a\n'],
    'the task branch, the rescue ref or the rescue commit');
  assert.equal(readOr(path.join(p.W,'src','a.txt')),'task a\n','W lost the bytes');
  const rec=ledger(p).filter(x=>x.kind==='checkpoint').pop()||{};
  assert.deepEqual([rec.outcome,rec.code,rec.ref],['failed','MOE_COMMIT_FAILED_REF_CONTENTION',p.branch],'the record_commit row');
}

// DoD: both wrappers carry the same MOE_WORKTREE_/MOE_LAND_/MOE_CONTROL_/MOE_BOARD_ codes.
function codes(){
  const set=f=>[...new Set(read(path.join(path.dirname(wrapper),f)).match(/MOE_(?:WORKTREE|LAND|CONTROL|BOARD)_[A-Z0-9_]+/g))].sort();
  assert.deepEqual(set('moe-agent.sh'),set('moe-agent.ps1'),'the wrappers carry different worktree code families');
}

const cases={lifecycle,resume,'half-made':halfMade,
  ...Object.fromEntries(refusals.map(c=>[c[0],()=>refusal(...c)])),'shared-landed':sharedLanded};
for(const t of ['claude','codex','gemini','grok'])cases['launch-'+t]=()=>launchAs(t);
Object.assign(cases,{'config-fail':configFail,tooling,'link-fail':linkFail,'link-partial':linkPartial,'project-yml':projectYml,'serena-outside':serenaOutside,
  'wt-checkpoint':wtCheckpoint,'wt-deny':wtDeny,'wt-recover':wtRecover,'wt-recover-moe':wtRecoverMoe,'wt-control-seats':wtControlSeats,
  'wt-stray':wtStray,'wt-push':wtPush,'wt-completion':wtCompletion,'wt-hooks':wtHooks,'wt-replay':wtReplay,'wt-replay-remote':wtReplayRemote,'wt-sync':wtSync,'wt-fails':wtFails,
  'wt-contention':wtContention,codes});
const only=process.env.MOE_WORKTREE_ONLY?process.env.MOE_WORKTREE_ONLY.split(',').map(s=>s.trim()).filter(Boolean):null;
(async()=>{
  let ok=0,failed=0;
  for(const n of only||[])if(!(n in cases)){failed++;console.log(`[worktree] ${n} FAILED: Error: no such case`);}
  for(const [name,fn] of Object.entries(cases)){
    if(only&&!only.includes(name))continue;
    if(name==='path-long'&&!winHost){console.log('[worktree] path-long n/a off win32');continue;}
    try{await fn();ok++;console.log(`[worktree] ${name} ok`);}
    catch(e){
      failed++;const [first,...rest]=String(e&&e.message).split('\n');
      console.log(`[worktree] ${name} FAILED: ${e&&e.name}: ${first}`);
      for(const l of rest)console.log('  | '+l);
    }
  }
  console.log(`[worktree] ${ok} ok, ${failed} failed`);
  process.exitCode=failed?1:0;
})().catch(e=>{console.log('[worktree] harness FAILED: '+(e&&e.stack));process.exitCode=1;})
  .finally(()=>{
    if(process.env.MOE_KEEP_WORKTREE_FIXTURE){console.log('[worktree] fixture kept: '+root);return;}
    // The wrapper's links go first, so the recursive delete never walks a junction.
    for(const d of present(root)?fs.readdirSync(root):[])for(const l of LINKS){
      const f=path.join(root,d,'.worktrees',TASK,l);try{if(fs.lstatSync(f).isSymbolicLink())unlinkOnly(f);}catch{}
    }
    for(const d of [root,wrapperTmp])fs.rmSync(d,{recursive:true,force:true,maxRetries:10,retryDelay:200});
  });
