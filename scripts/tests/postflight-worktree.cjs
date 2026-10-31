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
  // WT_CLI_RECORD: one JSON line per launch (cwd, argv, the four worktree env values, --mcp-config text).
  const argv=process.argv.slice(3),at=argv.indexOf('--mcp-config');
  if(process.env.WT_CLI_RECORD)fs.appendFileSync(process.env.WT_CLI_RECORD,JSON.stringify({cwd:process.cwd(),argv,
    env:Object.fromEntries(['MOE_PROJECT_PATH','MOE_WORKTREE_PATH','MOE_TASK_BRANCH','MOE_LAND_TARGET'].map(k=>[k,process.env[k]??null])),
    mcpConfig:at>=0&&argv[at+1]?readOr(argv[at+1]):null})+'\n');
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
function repo(name,{task=TASK,sub=''}={}){
  const top0=path.join(root,name),dir=sub?path.join(top0,sub):top0,moe=f=>path.join(dir,'.moe',f);
  write(path.join(top0,'.gitignore'),'.worktrees/\n.mcp.json\nlogs/\n');write(path.join(top0,'src','a.txt'),'seed a\n');
  write(moe('project.json'),JSON.stringify({id:'proj-worktree',name:'Worktree',settings:{autoCommit:false}}));
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
// WT_GIT_FAIL fails any call with that argv element; the rest runs the real git. sh
// engines find `git`; PowerShell finds git.ps1 (a .cmd would mangle `%` in --format).
function stub(){
  const dir=path.join(root,'git-stub');
  if(present(dir))return dir;
  write(path.join(dir,'git'),`#!/bin/sh
for a in "$@"; do
  if [ -n "$WT_GIT_VERSION" ] && { [ "$a" = --version ] || [ "$a" = version ]; }; then echo "git version $WT_GIT_VERSION"; exit 0; fi
  if [ -n "$WT_GIT_FAIL" ] && [ "$a" = "$WT_GIT_FAIL" ]; then echo "fatal: wt stub fails $a" >&2; exit 1; fi
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
// opts.type launches typeShim(type) instead of the default CLI; opts.args extend the wrapper argv.
async function launch(p,run,knobs={},opts={}){
  const moe=f=>path.join(p.dir,'.moe',f);
  for(const f of ['wt-cli.log','evidence-rpcs.jsonl','context-count'])fs.rmSync(moe(f),{force:true});
  fs.rmSync(moe('attempts'),{recursive:true,force:true});
  const cli=opts.type?typeShim(opts.type):cliShim();
  const args=win?['-NoProfile','-ExecutionPolicy','Bypass','-File',wrapper,'-Project',p.dir,'-WorkerId',WID,'-Role','worker','-Team','Smoke','-NoStartDaemon','-Command',cli,'-NoLoop','-PollInterval','0']
    :[wrapper,'--project',p.dir,'--worker-id',WID,'--role','worker','--team','Smoke','--no-start-daemon','--command',cli,'--no-loop','--poll-interval','0'];
  args.push(...(opts.args||[]));
  const env={...inherited,MOE_PROXY_PATH:proxy,MOE_NODE_COMMAND:process.execPath,MOE_DISABLE_HEARTBEAT:'1',
    HOME:path.join(root,'home'),USERPROFILE:path.join(root,'home'),TMPDIR:wrapperTmp,TMP:wrapperTmp,TEMP:wrapperTmp,
    FAKE_TASK_STATUS:'WORKING',FAKE_CLAIM_WORKSPACE:p.ws(),...knobs};
  for(const k of Object.keys(env))if(env[k]==null)delete env[k];
  if(env.WT_GIT_VERSION||env.WT_GIT_FAIL){
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
  const p=repo('shared-landed');git(p.top,'branch','moe/task/'+TASK,'HEAD');
  const before=control(p.top),r=await launch(p,'shared-landed',{FAKE_CLAIM_WORKSPACE:null});
  assert.ok(r.cliRan,'the CLI did not run'+tail(r.log));
  assert.equal(r.blocked.length,0,'report_blocked was called'+tail(r.log));
  assert.ok(!r.log.includes('MOE_WORKTREE_'),'a MOE_WORKTREE_ line in a shared-mode run'+tail(r.log));
  assert.ok(!present(p.W),'shared mode made a worktree');
  controlSame(p,before);
  assert.equal(r.code,0,`exit code ${r.code}`+tail(r.log));
}

// WT-05 (design §5.1-§5.2): in worktree mode every CLI runs against W, with W's own
// configs naming the control as the moe server's MOE_PROJECT_PATH.
const same=(a,b)=>typeof a==='string'&&typeof b==='string'&&norm(a)===norm(b);
const execFlag=t=>win?'-'+t[0].toUpperCase()+t.slice(1)+'Exec':'--'+t+'-exec';
const cfgText=f=>{assert.ok(present(f),`${f} is missing`);return read(f).replace(/^\uFEFF/,'');};
const jsonMoe=s=>JSON.parse(s).mcpServers.moe.env.MOE_PROJECT_PATH;
const tomlMoe=f=>{const m=/^MOE_PROJECT_PATH = (".*")\r?$/m.exec(cfgText(f));assert.ok(m,`${f} has no MOE_PROJECT_PATH line`);return JSON.parse(m[1]);};
// [banner, config path under its root]; the sh Gemini writer prints its banner twice.
const BANNERS={codex:['Codex MCP config written to:','.codex/config.toml'],gemini:['Gemini MCP config written to:','.gemini/settings.json'],
  grok:['Grok MCP config written to:','.grok/config.toml']};
// A fresh fixture whose control holds an untracked .moe/agents/x.md, and its headless launch.
function wtCase(name,type){
  const p=repo(name),dir=path.join(root,name+'-case'),record=path.join(dir,'record.jsonl'),grokHome=path.join(dir,'grok-home');
  fs.mkdirSync(dir,{recursive:true});write(path.join(p.dir,'.moe','agents','x.md'),'agent x\r\nbytes\n');
  return {p,record,grokHome,run:()=>launch(p,name,{MOE_DISABLE_ARGV_PROBE:'1',WT_CLI_RECORD:record,GROK_HOME:grokHome},
    {type,args:type==='claude'?[]:[execFlag(type)]})};
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
  const inW=f=>path.join(p.W,...f.split('/')),named=[];
  if(!win)named.push(['W/.mcp.json',jsonMoe(cfgText(inW('.mcp.json')))]);
  if(win&&type==='claude'){assert.ok(rec.mcpConfig,'no --mcp-config text recorded');named.push(['the temp --mcp-config',jsonMoe(rec.mcpConfig.replace(/^\uFEFF/,''))]);}
  if(type==='codex'||type==='grok')named.push([BANNERS[type][1],tomlMoe(inW(BANNERS[type][1]))]);
  if(type==='gemini')named.push(['W/.gemini/settings.json',jsonMoe(cfgText(inW('.gemini/settings.json')))]);
  for(const [what,v] of named)assert.ok(same(v,p.dir),`${what} names ${v} as MOE_PROJECT_PATH, not the control`);
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
  git(p.top,'worktree','add','--lock','--reason','moe '+TASK,'--no-checkout','--no-track','-b','moe/task/'+TASK,p.W,'main');
  git(p.W,'sparse-checkout','set','--no-cone','/*','!/.moe/');git(p.W,'read-tree','-mu','HEAD');
  fs.mkdirSync(path.join(p.W,'.codex','config.toml'),{recursive:true});
  refused(await c.run(),'MOE_WORKTREE_CREATE_FAILED');
  assert.ok(!present(c.record),'a CLI launch was recorded');
}

const cases={lifecycle,resume,'half-made':halfMade,
  ...Object.fromEntries(refusals.map(c=>[c[0],()=>refusal(...c)])),'shared-landed':sharedLanded};
for(const t of ['claude','codex','gemini','grok'])cases['launch-'+t]=()=>launchAs(t);
cases['config-fail']=configFail;
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
    if(process.env.MOE_KEEP_WORKTREE_FIXTURE)console.log('[worktree] fixture kept: '+root);
    else for(const d of [root,wrapperTmp])fs.rmSync(d,{recursive:true,force:true,maxRetries:10,retryDelay:200});
  });
