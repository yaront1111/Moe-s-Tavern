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
// WT-13: after a landing (L13) the control checkout follows main: HEAD stays on its branch, holds main's
// tip, and the status is what it was.
const controlFollowed=(p,before)=>{const now=control(p.top);
  assert.deepEqual([now.head,revOf(p.top,'HEAD'),now.status],[before.head,revOf(p.top,'refs/heads/main'),before.status],'the control checkout did not follow main, or its status changed');};
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
function commitOn(p,ref,files,base='HEAD'){
  const env={GIT_INDEX_FILE:path.join(root,p.name+'.index')};
  git(p.top,'read-tree',base,{env});
  for(const [f,b] of Object.entries(files)){
    const blob=git(p.top,'hash-object','-w','--stdin',{input:b}).trim();
    git(p.top,'update-index','--add','--cacheinfo',`100644,${blob},${f}`,{env});
  }
  const c=git(p.top,'commit-tree',git(p.top,'write-tree',{env}).trim(),'-p',base,'-m','fixture '+ref).trim();
  git(p.top,'update-ref',ref,c);return c;
}

// PATH-first git stub: WT_GIT_VERSION answers a version probe at any argv position,
// WT_GIT_FAIL fails any call with that argv element, the first fetch moves WT_GIT_SWAP over
// WT_GIT_SWAP_TO, and the first call with the argv element WT_GIT_HOLD writes WT_GIT_HOLD_FILE,
// then waits (at most 120s) for <WT_GIT_HOLD_FILE>.sent before it runs. While the count in the file
// WT_GIT_CONFIG_LOCK is above 0, a config write of extensions.worktreeConfig (no --get) takes one and fails
// as git's config-lock collision does. The rest runs the real git. sh
// engines find `git`; PowerShell finds git.ps1 (a .cmd would mangle `%` in --format).
function stub(){
  const dir=path.join(root,'git-stub');
  if(present(dir))return dir;
  write(path.join(dir,'git'),`#!/bin/sh
if [ -n "$WT_GIT_CONFIG_LOCK" ]; then
  c=; k=; g=
  for a in "$@"; do case "$a" in config) c=c ;; extensions.worktreeConfig) k=k ;; --get) g=g ;; esac; done
  n=$(cat "$WT_GIT_CONFIG_LOCK" 2>/dev/null)
  case "$c$k$g:$n" in
    ck:[1-9]*) w=$WT_GIT_CONFIG_LOCK_WHY; [ -n "$w" ] || w='File exists'
      echo $((n - 1)) > "$WT_GIT_CONFIG_LOCK"; echo "error: could not lock config file .git/config: $w" >&2; exit 255 ;;
  esac
fi
for a in "$@"; do
  if [ -n "$WT_GIT_VERSION" ] && { [ "$a" = --version ] || [ "$a" = version ]; }; then echo "git version $WT_GIT_VERSION"; exit 0; fi
  if [ -n "$WT_GIT_FAIL" ] && [ "$a" = "$WT_GIT_FAIL" ]; then echo "fatal: wt stub fails $a" >&2; exit 1; fi
  if [ "$a" = fetch ] && [ -n "$WT_GIT_SWAP" ] && [ -f "$WT_GIT_SWAP" ]; then mv -f "$WT_GIT_SWAP" "$WT_GIT_SWAP_TO"; fi
  if [ -n "$WT_GIT_HOLD" ] && [ "$a" = "$WT_GIT_HOLD" ] && [ ! -e "$WT_GIT_HOLD_FILE" ]; then
    : > "$WT_GIT_HOLD_FILE"; i=0
    while [ ! -e "$WT_GIT_HOLD_FILE.sent" ] && [ $i -lt 1200 ]; do sleep 0.1; i=$((i + 1)); done
  fi
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
  // The collision goes through Write-Error: the wrapper's 2>&1 captures the error stream of an in-process script,
  // never a [Console]::Error line.
  write(path.join(dir,'git.ps1'),`$ErrorActionPreference = 'Continue'
if ($env:WT_GIT_CONFIG_LOCK -and $args -ccontains 'config' -and $args -ccontains 'extensions.worktreeConfig' -and $args -cnotcontains '--get') {
  $n = 0
  if ([int]::TryParse([IO.File]::ReadAllText($env:WT_GIT_CONFIG_LOCK).Trim(), [ref]$n) -and $n -gt 0) {
    $why = 'File exists'
    if ($env:WT_GIT_CONFIG_LOCK_WHY) { $why = $env:WT_GIT_CONFIG_LOCK_WHY }
    [IO.File]::WriteAllText($env:WT_GIT_CONFIG_LOCK, [string]($n - 1))
    Write-Error "error: could not lock config file .git/config: $why"
    exit 255
  }
}
foreach ($a in $args) {
  if ($env:WT_GIT_VERSION -and ($a -ceq '--version' -or $a -ceq 'version')) { "git version $env:WT_GIT_VERSION"; exit 0 }
  if ($env:WT_GIT_FAIL -and $a -ceq $env:WT_GIT_FAIL) { [Console]::Error.WriteLine("fatal: wt stub fails $a"); exit 1 }
  if ($a -ceq 'fetch' -and $env:WT_GIT_SWAP -and (Test-Path -LiteralPath $env:WT_GIT_SWAP)) { Move-Item -LiteralPath $env:WT_GIT_SWAP -Destination $env:WT_GIT_SWAP_TO -Force }
  if ($env:WT_GIT_HOLD -and $a -ceq $env:WT_GIT_HOLD -and -not (Test-Path -LiteralPath $env:WT_GIT_HOLD_FILE)) {
    [IO.File]::WriteAllText($env:WT_GIT_HOLD_FILE, 'held')
    for ($i = 0; $i -lt 1200 -and -not (Test-Path -LiteralPath "$($env:WT_GIT_HOLD_FILE).sent"); $i++) { Start-Sleep -Milliseconds 100 }
  }
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
// postflight.ps1's owned-console supervisor: the wrapper runs on its own hidden console; once <ready> appears, one real
// Ctrl+C goes to that console alone, then <ready>.sent. It prints the wrapper's output, exits with its code, and prints
// `[supervisor] FAILED: <why>` when the barrier never held, the wrapper outlived the limit, or a child of it outlived it.
function consoleSupervisor(){
  const f=path.join(root,'console-supervisor.ps1');
  if(!present(f))write(f,`param([string]$Engine,[string]$ArgsFile,[string]$Ready,[string]$Log,[int]$LimitMs)
$ErrorActionPreference='Stop'
$arguments=([IO.File]::ReadAllText($ArgsFile)|ConvertFrom-Json)|ForEach-Object {'"'+$_+'"'}
$p=Start-Process -FilePath $Engine -ArgumentList $arguments -WindowStyle Hidden -PassThru -RedirectStandardOutput $Log -RedirectStandardError "$Log.err"
$null=$p.Handle;$start=$p.StartTime;$rc=98;$why=''
try {
  $until=[DateTime]::UtcNow.AddMilliseconds($LimitMs)
  while(-not (Test-Path -LiteralPath $Ready)){if($p.HasExited -or [DateTime]::UtcNow -gt $until){throw 'the barrier never held'};Start-Sleep -Milliseconds 100}
  Add-Type 'using System; using System.Runtime.InteropServices; public static class WtSignal {
    [DllImport("kernel32.dll")] public static extern bool FreeConsole();
    [DllImport("kernel32.dll")] public static extern bool AttachConsole(uint pid);
    [DllImport("kernel32.dll")] public static extern bool SetConsoleCtrlHandler(IntPtr h,bool add);
    [DllImport("kernel32.dll")] public static extern bool GenerateConsoleCtrlEvent(uint code,uint group);
  }'
  [WtSignal]::FreeConsole()|Out-Null
  if(-not [WtSignal]::AttachConsole($p.Id)){throw 'AttachConsole to the owned wrapper failed'}
  [WtSignal]::SetConsoleCtrlHandler([IntPtr]::Zero,$true)|Out-Null
  if(-not [WtSignal]::GenerateConsoleCtrlEvent(0,0)){throw 'the owned Ctrl+C failed'}
  [IO.File]::WriteAllText("$Ready.sent",'sent')
  if(-not $p.WaitForExit($LimitMs)){throw 'the wrapper outlived its interrupt'}
  $left=@(Get-CimInstance Win32_Process -Filter "ParentProcessId=$($p.Id)"|Where-Object {$_.Name -ne 'conhost.exe' -and $_.CreationDate -ge $start})
  if($left.Count){throw "a child outlived the wrapper: $(($left|ForEach-Object {$_.Name+' '+$_.ProcessId}) -join ', ')"}
  $rc=$p.ExitCode
} catch { $why="$_" } finally {
  if(-not $p.HasExited){& taskkill /T /F /PID $p.Id|Out-Null;$p.WaitForExit(5000)|Out-Null}
  foreach($o in @($Log,"$Log.err")){if(Test-Path -LiteralPath $o){Get-Content -LiteralPath $o}}
}
if($why){"[supervisor] FAILED: $why"}
exit $rc
`);
  return f;
}
// One worker-seat run. A null knob is unset; WT_GIT_* knobs put the stub first on PATH.
// opts.type launches typeShim(type) instead of the default CLI; opts.args extend the wrapper argv;
// opts.role replaces the worker role; opts.wrapper runs that wrapper copy; opts.signal SIGTERMs the wrapper once the fake logs that tool, or once
// that function answers true (sh); opts.keep keeps .moe/attempts (the same seat restarting).
// opts.ready interrupts the wrapper once that barrier file appears, then writes <ready>.sent: a SIGTERM (sh, which
// must then leave no process in its group), or a real Ctrl+C on its own console (ps1, consoleSupervisor);
// opts.kill hard-kills the tree once that file appears.
async function launch(p,run,knobs={},opts={}){
  const moe=f=>path.join(p.dir,'.moe',f),role=opts.role||'worker';
  for(const f of ['wt-cli.log','evidence-rpcs.jsonl','record_commit.jsonl','context-count'])fs.rmSync(moe(f),{force:true});
  if(!opts.keep)fs.rmSync(moe('attempts'),{recursive:true,force:true});
  const cli=opts.type?typeShim(opts.type):cliShim(),w=opts.wrapper||wrapper;
  const args=win?['-NoProfile','-ExecutionPolicy','Bypass','-File',w,'-Project',p.dir,'-WorkerId',WID,'-Role',role,'-Team','Smoke','-NoStartDaemon','-Command',cli,'-NoLoop','-PollInterval','0']
    :[w,'--project',p.dir,'--worker-id',WID,'--role',role,'--team','Smoke','--no-start-daemon','--command',cli,'--no-loop','--poll-interval','0'];
  args.push(...(opts.args||[]));
  // The suite's own wrapper gets WT-13's harness seam (a worker may run this suite from its task worktree, and
  // `inherited` scrubs MOE_*); an opts.wrapper copy never does, so wt-guard's refusals stay real (task-3c4be125).
  const env={...inherited,MOE_PROXY_PATH:proxy,MOE_NODE_COMMAND:process.execPath,MOE_DISABLE_HEARTBEAT:'1',
    HOME:path.join(root,'home'),USERPROFILE:path.join(root,'home'),TMPDIR:wrapperTmp,TMP:wrapperTmp,TEMP:wrapperTmp,
    FAKE_TASK_STATUS:'WORKING',FAKE_CLAIM_WORKSPACE:p.ws(),MOE_POSTFLIGHT_TEST_ALLOW_WORKTREE_WRAPPER:opts.wrapper?null:'1',...knobs};
  for(const k of Object.keys(env))if(env[k]==null)delete env[k];
  if(env.WT_GIT_VERSION||env.WT_GIT_FAIL||env.WT_GIT_SWAP||env.WT_GIT_HOLD||env.WT_GIT_CONFIG_LOCK){
    env[pathKey]=stub()+path.delimiter+(inherited[pathKey]||'');
    if(!win)env.BASH_ENV=path.join(stub(),'env.sh');
  }
  const sup=win&&opts.ready,argsFile=path.join(root,`${p.name}-${run}.args.json`);
  if(sup)write(argsFile,JSON.stringify(args));
  const child=cp.spawn(engine,sup?['-NoProfile','-ExecutionPolicy','Bypass','-File',consoleSupervisor(),engine,argsFile,opts.ready,argsFile+'.log',String(LIMIT-15000)]:args,
    {env,stdio:['ignore','pipe','pipe'],detached:!winHost,windowsHide:true});
  let log='',timedOut=false;child.stdout.on('data',d=>{log+=d;});child.stderr.on('data',d=>{log+=d;});
  const timer=setTimeout(()=>{timedOut=true;killTree(child);},LIMIT);
  const at=opts.kill||(!sup&&opts.ready);
  const hit=typeof opts.signal==='function'?opts.signal:at?()=>present(at):()=>(readOr(moe('evidence-rpcs.jsonl'))||'').includes(`"tool":"${opts.signal}"`);
  const poll=(opts.signal||at)&&setInterval(()=>{
    if(!hit())return;
    clearInterval(poll);
    if(opts.kill)return killTree(child);
    try{process.kill(child.pid,'SIGTERM');}catch{}
    if(opts.ready)write(opts.ready+'.sent','sent');
  },100);
  const code=await new Promise((res,rej)=>{child.on('error',rej);child.on('close',c=>res(c));}).finally(()=>{clearTimeout(timer);clearInterval(poll);});
  log=util.stripVTControlCharacters(log);write(path.join(root,`${p.name}-${run}.log`),log);
  assert.ok(!timedOut,`${run}: the wrapper outlived ${LIMIT/1000}s and was killed`+tail(log));
  let left=false;if(opts.ready&&!winHost)try{process.kill(-child.pid,0);left=true;}catch{}
  assert.ok(!left&&!log.includes('[supervisor] FAILED'),`${run}: the supervisor failed, or a process outlived the wrapper`+tail(log));
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
  // A feature branch: since WT-13, main at the target's commit switches to moe/control (wt-follow).
  ['control','MOE_CONTROL_NOT_FOLLOWING',()=>({}),p=>{git(p.top,'switch','-q','-c','feature');}],
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
  // task-31187ec1: a worktree claim whose get_context fails cannot run the §7.2 ledger guard.
  ['ctx-unread','MOE_WORKTREE_CONTEXT_FAILED',()=>({FAKE_GET_CONTEXT_FAIL:'error'}),
    ()=>p=>assert.equal(revOf(p.top,p.branch),null,'a task branch was created')],
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
// task-31187ec1, shape 1: a resume (no workspace on the claim) whose get_context read fails, answers {}
// or answers for another task, on moe/control, refuses: no W, no task branch, the control untouched.
async function resumeUnread(){
  const p=repo('resume-unread',{task:'task-resume'}),before=control(p.top);
  for(const fail of ['error','empty','mismatch']){
    try{
      refused(await launch(p,'resume-unread-'+fail,{FAKE_CLAIM_MODE:'resume',FAKE_CLAIM_WORKSPACE:null,FAKE_GET_CONTEXT_FAIL:fail}),
        'MOE_WORKTREE_CONTEXT_FAILED','task-resume');
      controlSame(p,before);
      assert.ok(!entry(p)&&!present(p.W),'W is registered or exists');
      assert.equal(revOf(p.top,p.branch),null,'a task branch was created');
    }catch(e){e.message=`${fail}: ${e.message}`;throw e;}
  }
}
// task-31187ec1, shape 2: moe/task/<id> holds nothing HEAD lacks (so it reads as landed) and W is
// dirty. A resume whose get_context fails refuses; W stays registered, locked and dirty; the branch stays.
async function resumeDirty(){
  const p=repo('resume-dirty',{task:'task-resume'}),before=control(p.top),main=revOf(p.top,'refs/heads/main');
  const knobs={FAKE_CLAIM_MODE:'resume',FAKE_CLAIM_WORKSPACE:null};
  provisioned(p,await launch(p,'resume-dirty-add',{...knobs,FAKE_CTX_WORKSPACE:p.ws()}),'created',before,main);
  write(path.join(p.W,'dirt.txt'),'dirt\n');write(path.join(p.W,'src','a.txt'),'task edit\n');
  if(git(p.top,'rev-list','--count','HEAD..'+p.branch).trim()!=='0')throw new Error('fixture: the task branch holds commits HEAD lacks');
  refused(await launch(p,'resume-dirty-unread',{...knobs,FAKE_GET_CONTEXT_FAIL:'error'}),'MOE_WORKTREE_CONTEXT_FAILED','task-resume');
  const e=entry(p);
  assert.ok(e,'W was unregistered');
  assert.deepEqual([e.branch,e.locked],[p.branch,'moe task-resume'],`W's worktree record ${JSON.stringify(e)}`);
  assert.deepEqual([readOr(path.join(p.W,'dirt.txt')),readOr(path.join(p.W,'src','a.txt'))],['dirt\n','task edit\n'],"W's dirt changed");
  assert.equal(revOf(p.top,p.branch),main,'the task branch moved');
  controlSame(p,before);
}
// task-31187ec1, epic rail 4: the same failed resume read off moe/control is today's shared run.
async function resumeSharedUnread(){
  const p=repo('resume-shared-unread',{task:'task-resume'});git(p.top,'switch','-q','-c','moe/work-2026-10-24');
  const before=control(p.top);
  const r=await launch(p,'resume-shared-unread',{FAKE_CLAIM_MODE:'resume',FAKE_CLAIM_WORKSPACE:null,FAKE_GET_CONTEXT_FAIL:'error'});
  assert.ok(r.cliRan,'the CLI did not run'+tail(r.log));
  assert.equal(r.blocked.length,0,'report_blocked was called'+tail(r.log));
  assert.ok(!r.log.includes('MOE_WORKTREE_'),'a MOE_WORKTREE_ line in a shared-mode run'+tail(r.log));
  assert.ok(!present(p.W),'shared mode made a worktree');
  controlSame(p,before);
  assert.equal(r.code,0,`exit code ${r.code}`+tail(r.log));
}

// task-c7ca56e6: before W's first sparse-checkout the seat sets extensions.worktreeConfig in the common
// config itself, retrying only a config-lock collision (5 attempts), so two seats provisioning at once never
// race on .git/config.lock. WT_GIT_CONFIG_LOCK=<count file> forces that many collisions.
const RETRY=/^\[info\] MOE_WORKTREE_CONFIG_RETRY attempt=[1-4]\/5: \.git\/config is locked by another git process\r?$/gm;
const retries=log=>(log.match(RETRY)||[]).length;
const extOn=p=>probe(p.top,'config','--local','--get','extensions.worktreeConfig');
const lockCount=(p,n)=>{const f=path.join(root,p.name+'.config-lock');write(f,String(n));return f;};
const unprovisioned=(p,before)=>{controlSame(p,before);assert.ok(!entry(p),'W is registered');assert.ok(!present(p.W),'W exists');};
async function wtConfigLock(){
  const p=repo('wt-config-lock'),before=control(p.top),f=lockCount(p,1);
  if(extOn(p)!=='1:')throw new Error('fixture: the extension is already set');
  const r=await launch(p,'wt-config-lock',{WT_GIT_CONFIG_LOCK:f});
  provisioned(p,r,'created',before,revOf(p.top,'refs/heads/main'));
  assert.equal(retries(r.log),1,'expected exactly one MOE_WORKTREE_CONFIG_RETRY line'+tail(r.log));
  assert.equal(read(f).trim(),'0','the forced collision was never hit');
  assert.equal(extOn(p),'0:true\n','extensions.worktreeConfig is not true in the common config');
  assert.deepEqual(git(p.W,'sparse-checkout','list').trim().split(/\r?\n/),['/*','!/.moe/'],"W's sparse patterns");
}
async function wtConfigLockExhausted(){
  const p=repo('wt-config-lock-exhausted'),before=control(p.top),f=lockCount(p,99);
  const r=await launch(p,'wt-config-lock-exhausted',{WT_GIT_CONFIG_LOCK:f});
  refused(r,'MOE_WORKTREE_CREATE_FAILED');
  assert.match(r.blocked[0].args.reason,/^MOE_WORKTREE_CREATE_FAILED: git config extensions\.worktreeConfig true failed 5 times: \.git\/config stayed locked/,'the refusal reason');
  assert.equal(retries(r.log),4,'expected 4 MOE_WORKTREE_CONFIG_RETRY lines (5 attempts)'+tail(r.log));
  assert.equal(read(f).trim(),'94','expected exactly 5 config writes');
  assert.equal(extOn(p),'1:','the extension was set anyway');
  unprovisioned(p,before);
}
// Any other failure, a config-lock one with another errno (EACCES) included, refuses at once with git's own line.
async function wtConfigOther(){
  for(const [name,why] of [['wt-config-other',null],['wt-config-eacces','Permission denied']]){
    const p=repo(name),before=control(p.top),f=lockCount(p,99);
    const r=await launch(p,name,why?{WT_GIT_CONFIG_LOCK:f,WT_GIT_CONFIG_LOCK_WHY:why}:{WT_GIT_FAIL:'extensions.worktreeConfig'});
    try{
      refused(r,'MOE_WORKTREE_CREATE_FAILED');
      assert.match(r.blocked[0].args.reason,/^MOE_WORKTREE_CREATE_FAILED: git config extensions\.worktreeConfig true failed: /,'the refusal reason');
      assert.equal(retries(r.log),0,'a failure other than a config-lock collision was retried'+tail(r.log));
      if(why)assert.deepEqual([read(f).trim(),r.blocked[0].args.reason.endsWith(': '+why)],['98',true],"expected one config write, refused with git's own line");
      unprovisioned(p,before);
    }catch(e){e.message=`${name}: ${e.message}`;throw e;}
  }
}
// Already true: no config write at all (one would take a forced collision), so .git/config stays byte-identical.
async function wtConfigPreset(){
  const p=repo('wt-config-preset');git(p.top,'config','extensions.worktreeConfig','true');
  const cfg=path.join(p.top,'.git','config'),bytes=fs.readFileSync(cfg),before=control(p.top),f=lockCount(p,99);
  const r=await launch(p,'wt-config-preset',{WT_GIT_CONFIG_LOCK:f});
  provisioned(p,r,'created',before,revOf(p.top,'refs/heads/main'));
  assert.equal(retries(r.log)+'/'+read(f).trim(),'0/99','a config write was attempted'+tail(r.log));
  assert.ok(fs.readFileSync(cfg).equals(bytes),'.git/config changed');
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
  assert.deepEqual([revOf(p.top,'refs/heads/main'),revOf(p.top,BOARD)],[main,null],'the target moved, or a checkpoint snapshotted the board');
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
    // The board ref is WT-12's (wt-board): only the QA seat writes it.
    const rel='src/'+role+'.txt',f=path.join(p.top,'src',role+'.txt'),refs=()=>git(p.top,'for-each-ref','--format=%(refname) %(objectname)').split('\n').filter(l=>!l.startsWith(BOARD+' '));
    write(path.join(p.dir,'.moe','tasks',TASK+'.json'),JSON.stringify({id:TASK,title:'Worktree smoke',status:'WORKING',declaredFiles:[rel]}));
    const before=refs();
    const r=await landRun(p,'wt-control-'+role,{[f]:role+'\n'},{FAKE_CLAIM_WORKSPACE:null,FAKE_SCOPE_DECLARED_FIELD:'1',...landed(revOf(p.top,'HEAD'))},{role});
    assert.ok(r.code===0&&r.log.includes('MOE_COMMIT_NOTHING_TO_COMMIT'),`${role}: exit code ${r.code}, or no MOE_COMMIT_NOTHING_TO_COMMIT line`+tail(r.log));
    const rec=ledger(p);
    assert.deepEqual(rec.map(x=>[x.outcome,x.kind,x.code,x.sha,x.ref]),[['nothing','checkpoint','MOE_COMMIT_NOTHING_TO_COMMIT',undefined,undefined]],`${role}: the record_commit rows`);
    assert.deepEqual([refs(),probe(p.top,'symbolic-ref','-q','HEAD'),readOr(f),!!revOf(p.top,BOARD)],[before,'0:refs/heads/moe/control\n',role+'\n',role==='qa'],
      `${role}: a ref moved, HEAD left moe/control, the write changed, or the board ref is wrong`);
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
  assert.deepEqual([finals(p),probe(p.top,'merge-base','--is-ancestor',c,p.branch),present(journal(p)),leases(p)],[[['landed',c]],'0:',false,[]],
    'finalize, the task branch lacks C, the journal stayed, or a lease call with no qualityGate'+tail(r.log));
  assert.match(r.log,new RegExp(`^\\[OK\\] MOE_CONTROL_ADVANCED ${main}\\.\\.${c}\\r?$`,'m'),'no L13 MOE_CONTROL_ADVANCED line'+tail(r.log));
  controlFollowed(p,before);
  assert.equal(probe(p.top,'status','--porcelain','--','src'),'0:','src/ on disk is not HEAD after L13');
}
// A project that TRACKS .serena/project.yml: WT-06 rewrites W's copy (project_name <name>@<taskId>) at every
// launch, so W shows it as ' M'. That copy is tooling's, never task bytes: neither the checkpoint nor the
// completion may carry the renamed name (task-f977d76e).
async function wtSerenaYml(){
  const p=repo('wt-serena-yml',{settings:LANDS}),f='.serena/project.yml',yml='project_name: fixture\nlanguages: [x]\n';
  write(path.join(p.dir,f),yml);git(p.top,'add','-f','--',f);git(p.top,'commit','-qm','track project.yml');git(p.top,'update-ref','refs/heads/main','HEAD');
  const main=mainOf(p);
  let r=await landRun(p,'wt-serena-yml-1',{'src/a.txt':'task a\n'});
  const head=revOf(p.top,p.branch);
  assert.ok(r.code===0&&head!==main,`exit code ${r.code}; no checkpoint on the task branch`+tail(r.log));
  assert.equal(readOr(path.join(p.W,f)),'project_name: "fixture@'+TASK+'"\nlanguages: [x]\n','W lacks the WT-06 copy: the premise of this case');
  assert.equal(git(p.top,'show',head+':'+f),yml,'the checkpoint carried the WT-06 copy to the task branch');
  assert.equal(git(p.top,'show',head+':src/a.txt'),'task a\n','the checkpoint lost the task bytes');
  assert.match(r.log,/MOE_ATTR_EXCLUDED/,'no MOE_ATTR_EXCLUDED line'+tail(r.log));
  assert.match(git(p.W,'status','--porcelain','--',f),/^ M /,'the WT-06 copy is not W dirt, or was landed and refreshed');
  r=await landRun(p,'wt-serena-yml-2',{'src/a.txt':'done\n'},REVIEW);
  const c=mainOf(p);
  assert.ok(r.code===0&&c!==main,`exit code ${r.code}, or main did not move`+tail(r.log));
  assert.deepEqual([git(p.top,'show',c+':'+f),git(p.top,'show',c+':src/a.txt')],[yml,'done\n'],'the completion carried the WT-06 copy to the target');
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
  controlFollowed(p,before);
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
  assert.ok(r.log.includes('MOE_PUSH_OUTCOME_UNKNOWN')&&j1&&!finals(p).length,'no unknown push outcome, no kept journal, or a finalize'+tail(r.log));
  // WT-11: still unknown at the same seat's restart (origin unreachable): no finalize, no CLI, the attempt stays finalizing.
  r=await landRun(p,'wt-replay-remote-down',{},{...net,WT_GIT_FAIL:'fetch',FAKE_CLAIM_MODE:'finalizing',MOE_TASKLESS_WAIT_SEC:'5'},{keep:true});
  assert.deepEqual([readOr(journal(p)),finals(p),r.cliRan,phase(p),/MOE_PUSH_OUTCOME_UNKNOWN: task \S+ -- /.test(r.log)],[j1,[],false,'finalizing',true],
    'a restart settled an unknown push'+tail(r.log));
  const j2=JSON.stringify({...JSON.parse(j1.replace(/^﻿/,'')),targetBefore:peer});
  git(p.top,'push','-q','origin',peer+':refs/heads/main');write(swap,j2);
  r=await landRun(p,'wt-replay-remote-2',{},{...net,WT_GIT_SWAP:swap,WT_GIT_SWAP_TO:journal(p)});
  assert.deepEqual([present(swap),readOr(journal(p)),r.log.includes('rewritten or removed meanwhile'),/MOE_PUSH_FAILED/.test(r.log)],[false,j2,true,false],
    'no swap, or the replay dropped a journal rewritten meanwhile'+tail(r.log));
  write(journal(p),j1);r=await landRun(p,'wt-replay-remote-3',{},net);
  assert.deepEqual([present(journal(p)),/MOE_PUSH_FAILED: task \S+ -- origin moved past/.test(r.log),revOf(bare,'refs/heads/main'),done(p).length,finals(p).filter(x=>x[0]==='landed')],
    [false,true,peer,0,[]],'the journal stayed, origin moved, or C was recorded or finalized'+tail(r.log));
  // WT-11: a journaled attempt still finalizing is routed unlanded 'remote' under the journal's identity, T rescued.
  const t=revOf(p.top,p.branch);write(journal(p),j1);r=await landRun(p,'wt-replay-remote-4',{},{...net,FAKE_ATTEMPT_PHASE:'finalizing'});
  assert.deepEqual([present(journal(p)),done(p).map(x=>[x.outcome,x.code,x.pushed]),unlanded(p).map(x=>[x.outcome,x.unlandedReason,x.targetTip]),revOf(p.top,(retryOf(p)||{}).rescueRef)],
    [false,[['failed','MOE_PUSH_FAILED',false]],[['unlanded','remote',JSON.parse(j1.replace(/^﻿/,'')).targetBefore]],t],'the replay did not route the attempt unlanded'+tail(r.log));
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
// Fail closed, main unmoved: a remote whose fetch fails (WT-09), a merge-tree failure that is no conflict
// (exit 1 without a tree), an unwritable journal, three lost CAS rounds. No qualityGate: no lease call (WT-10).
async function wtFails(){
  const bare=n=>{const b=path.join(root,n+'.git');git(root,'init','-q','--bare',b);return b;};
  for(const [n,settings,knobs,setup,code,why] of [
    ['wt-merge-tree',{},{WT_GIT_FAIL:'merge-tree'},null,'MOE_COMMIT_FAILED',/merge-tree exited/],
    ['wt-remote',{},{MOE_LAND_NET_BACKOFF_SEC:'0'},async p=>{await landRun(p,'wt-remote-0',{});git(p.top,'remote','add','origin',bare('wt-remote'));},
      'MOE_LAND_FETCH_FAILED',/git fetch origin main failed 3 times/],
    ['wt-journal',{},{},p=>write(path.dirname(journal(p)),'x\n'),'MOE_COMMIT_FAILED',/receipt journal .* could not be written/],
    ['wt-exhausted',{},{WT_GIT_FAIL:'update-ref'},p=>landRun(p,'wt-exhausted-0',{'src/a.txt':'done\n'}),'MOE_COMMIT_FAILED_REF_CONTENTION',/all 3 rounds/]]){
    const p=repo(n,{settings:{...LANDS,...settings}}),main=mainOf(p);
    if(setup)await setup(p);
    const r=await landRun(p,n,setup&&knobs.WT_GIT_FAIL?{}:{'src/a.txt':'done\n'},{...REVIEW,...knobs}),row=done(p);
    assert.deepEqual([mainOf(p),row.map(x=>[x.outcome,x.code]),why.test(row[0]&&row[0].message),present(journal(p)),leases(p),revOf(p.top,BOARD)],
      [main,[['failed',code]],true,false,[],null],`${n}: main moved, the row, a journal stayed, a lease call, or a board snapshot`+tail(r.log));
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

// WT-10 (design §2.2 L3, L6, L14, §2.3): with a qualityGate set, every worktree completion, whatever
// qualityGateScope says, takes the git-land-<target> lease under ONE deadline (each call carries it as the
// proxy's MOE_PROXY_ONESHOT_DEADLINE_MS), gates exactly M = merge(B,T) with parent B in a .moe-free
// worktree, re-gates each new merge for at most 2 rounds, then releases. Checkpoints take no lease.
const LEASE=['acquire_resource','wait_for_resource','release_resource'];
const rpcs=p=>rows(path.join(p.dir,'.moe','evidence-rpcs.jsonl')),leases=p=>rpcs(p).filter(x=>LEASE.includes(x.tool));
// The gate logs each run (HEAD's tree and parent, src/a.txt, src/peer.txt, .moe) to WT_GATE_LOG, with
// WT_GATE_MOE writes .moe/x, sleeps WT_GATE_SLEEP_MS and exits WT_GATE_EXIT.
function gateCmd(){
  const f=path.join(root,'gate.cjs'),fwd=s=>win?s:s.replace(/\\/g,'/');
  if(!present(f))write(f,"const fs=require('fs'),cp=require('child_process'),e=process.env,rd=f=>fs.existsSync(f)?fs.readFileSync(f,'utf8'):null,\n"+
    "  g=a=>cp.execFileSync('git',a,{encoding:'utf8'}).trim();\nfs.appendFileSync(e.WT_GATE_LOG,JSON.stringify({tree:g(['rev-parse','HEAD^{tree}']),"+
    "parent:g(['rev-parse','HEAD^']),a:rd('src/a.txt'),peer:rd('src/peer.txt'),moe:fs.existsSync('.moe')})+'\\n');\n"+
    "if(e.WT_GATE_MOE){fs.mkdirSync('.moe');fs.writeFileSync('.moe/x','x\\n');}\n"+
    "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,Number(e.WT_GATE_SLEEP_MS||0));process.exit(Number(e.WT_GATE_EXIT||0));\n");
  return `"${fwd(process.execPath)}" "${fwd(f)}"`;
}
// One lease around the gate: acquire, then waits on the acquire's deadline, before any candidate; the
// release(s), each on its own deadline, after the last check run and before the seat deregisters.
function leased(p,r,releases=1,gates='+'){
  const L=leases(p),seq=rpcs(p).map(x=>x.tool).filter(t=>LEASE.includes(t)||/^(record_candidate|record_check_run|deregister_worker)$/.test(t)).map(t=>t+' ').join('');
  assert.match(seq,new RegExp(`^acquire_resource (wait_for_resource )*(record_candidate record_check_run )${gates}(release_resource ){${releases}}(deregister_worker )?$`),'the call order'+tail(r.log));
  for(const x of L)assert.deepEqual([x.args.resourceId,x.args.taskId,x.args.workerId,/^\d+$/.test(x.deadline)],['git-land-main',TASK,WID,true],'a lease call '+JSON.stringify(x));
  assert.ok(L.filter(x=>x.tool!=='release_resource').every(x=>x.deadline===L[0].deadline),'the acquire and its waits carry different deadlines');
}
async function wtGate(){
  const log=path.join(root,'wt-gate-gate.jsonl'),runs=()=>rows(log),mid={FAKE_CTX_IS_EPIC_FINAL:'false',WT_GATE_LOG:log},k={...REVIEW,...mid};
  const p=repo('wt-gate',{settings:{...LANDS,qualityGate:gateCmd(),qualityGateScope:'epicFinal'}}),b=mainOf(p);
  let r=await landRun(p,'wt-gate-0',{'src/a.txt':'task\n'},mid);
  assert.deepEqual([leases(p),runs()],[[],[]],'a checkpoint took the lease or ran the gate'+tail(r.log));
  // Queued past the old proxy's 2s cutoff, then one race: the first CAS loses to a peer, so the second
  // round re-gates the new merge (non-overlapping peer and task hunks) and lands exactly that.
  const t=revOf(p.top,p.branch),peer=commitOn(p,'refs/wt-gate/peer',{'src/peer.txt':'peer\n'});
  r=await landRun(p,'wt-gate-race',{},{...k,FAKE_LEASE_MODE:'queued',MOE_POSTFLIGHT_TEST_HOOK_PRE_UPDATE_REF:`git update-ref refs/heads/main ${peer}`});
  const c=mainOf(p),m=[b,peer].map(x=>git(p.top,'merge-tree','--write-tree',x,t).trim());
  assert.deepEqual(runs().map(x=>[x.tree,x.parent,x.a,x.peer,x.moe]),[[m[0],b,'task\n',null,false],[m[1],peer,'task\n','peer\n',false]],'the gate runs'+tail(r.log));
  assert.deepEqual([parents(p.top,c),git(p.top,'rev-parse',c+'^{tree}').trim(),done(p).map(x=>[x.outcome,x.sha])],[[peer],m[1],[['committed',c]]],'C is not the gated M on B');
  leased(p,r,1,'{2}');
  // A failing gate and a gate writing .moe/x (MOE_WORKTREE_GATE_INTEGRITY) land nothing; a refused
  // release is retried once at exit.
  for(const [n,writes,knobs] of [['fail',{'src/a.txt':'two\n'},{WT_GATE_EXIT:'3'}],['moe',{},{WT_GATE_MOE:'1'}],['release',{},{FAKE_LEASE_MODE:'release-fail-once'}]]){
    fs.rmSync(log,{force:true});
    const before=mainOf(p),fail=n!=='release';r=await landRun(p,'wt-gate-'+n,writes,{...k,...knobs});
    assert.deepEqual([mainOf(p)===before,done(p).map(x=>[x.outcome,x.code]),runs().length,r.log.includes('MOE_COMMIT_FAILED_GATE'),
      r.log.includes('MOE_WORKTREE_GATE_INTEGRITY'),present(path.join(p.W,'.moe'))],
      [fail,[fail?['failed','MOE_COMMIT_FAILED_GATE']:['committed',undefined]],1,fail,n==='moe',false],`${n}: main, the row, the gate runs, a code or W/.moe`+tail(r.log));
    leased(p,r,fail?1:2);
  }
  assert.ok(r.log.split('MOE_LAND_LEASE_RELEASE_FAILED').length===2&&JSON.parse(read(path.join(p.dir,'.moe','resources','git-land-main.json'))).holders.length===0,
    'no single MOE_LAND_LEASE_RELEASE_FAILED, or the exit did not release'+tail(r.log));
  // Two lost rounds: contention after exactly two gate runs, nothing published.
  await landRun(p,'wt-gate-exhausted-0',{'src/a.txt':'four\n'},mid);
  fs.rmSync(log,{force:true});const c2=mainOf(p);
  r=await landRun(p,'wt-gate-exhausted',{},{...k,WT_GIT_FAIL:'update-ref'});
  assert.deepEqual([mainOf(p),done(p).map(x=>[x.outcome,x.code,/all 2 rounds/.test(x.message)]),runs().length],[c2,[['failed','MOE_COMMIT_FAILED_REF_CONTENTION',true]],2],
    'main, the contention row or the gate runs'+tail(r.log));
  leased(p,r,1,'{2}');
}
// L3 fails closed with MOE_COMMIT_FAILED_LAND_LEASE: no candidate, gate or landing, and the lease or queue
// entry is still released, as the lease is after a merge-tree failure. A refused wait value, and
// MOE_DISABLE_QUALITY_GATE=1 (MOE_COMMIT_FAILED_GATE: it never skips a worktree gate), refuse before any lease call.
async function wtLeaseFails(){
  const LEASED='MOE_COMMIT_FAILED_LAND_LEASE';
  for(const [n,knobs,code,why] of [['timeout',{FAKE_LEASE_MODE:'timeout',MOE_LAND_LEASE_WAIT_SEC:'3'},LEASED,/^no lease on git-land-main within 3s/],
    ['withheld',{FAKE_LEASE_MODE:'withheld',MOE_LAND_LEASE_WAIT_SEC:'2'},LEASED,/^wait_for_resource for git-land-main was refused/],
    ['late',{FAKE_LEASE_MODE:'late',MOE_LAND_LEASE_WAIT_SEC:'2'},LEASED,/^the lease on git-land-main came after the 2s deadline/],
    ['refuse',{FAKE_LEASE_MODE:'refuse'},LEASED,/^acquire_resource for git-land-main was refused/],['malformed',{FAKE_LEASE_MODE:'malformed'},LEASED,/^acquire_resource for/],
    ['budget',{MOE_LAND_LEASE_WAIT_SEC:'0'},LEASED,/^MOE_LAND_LEASE_WAIT_SEC=0 is not/],['merge',{WT_GIT_FAIL:'merge-tree'},'MOE_COMMIT_FAILED',/^git merge-tree exited/],
    ['disabled',{MOE_DISABLE_QUALITY_GATE:'1'},'MOE_COMMIT_FAILED_GATE',/^MOE_DISABLE_QUALITY_GATE=1 never skips/]]){
    const log=path.join(root,`wt-lease-${n}-gate.jsonl`),p=repo('wt-lease-'+n,{settings:{...LANDS,qualityGate:gateCmd()}}),main=mainOf(p);
    const r=await landRun(p,'wt-lease-'+n,{'src/a.txt':'done\n'},{...REVIEW,WT_GATE_LOG:log,...knobs}),row=done(p);
    assert.deepEqual([mainOf(p),row.map(x=>[x.outcome,x.code]),why.test(row[0]&&row[0].message),rows(log).length,present(journal(p)),r.log.includes(code)],
      [main,[['failed',code]],true,0,false,true],`${n}: main, the row, a gate run, a journal or the code`+tail(r.log));
    if(n==='budget'||n==='disabled')assert.deepEqual(leases(p),[],'a lease call before the refusal');
    else leased(p,r,1,'{0}');
  }
}
// A handled exit while queued or while the gate runs (SIGTERM; sh only, as Windows has no signal to send)
// still releases; T keeps the bytes.
async function wtLeaseSignal(){
  for(const [n,knobs,signal,tools] of [['queued',{FAKE_LEASE_MODE:'queued'},'wait_for_resource',LEASE],['gating',{WT_GATE_SLEEP_MS:'5000'},null,[LEASE[0],LEASE[2]]]]){
    const log=path.join(root,`wt-lease-signal-${n}-gate.jsonl`),p=repo('wt-lease-signal-'+n,{settings:{...LANDS,qualityGate:gateCmd()}}),main=mainOf(p);
    const r=await landRun(p,'wt-lease-signal-'+n,{'src/a.txt':'done\n'},{...REVIEW,...knobs,WT_GATE_LOG:log},{signal:signal||(()=>present(log))});
    assert.deepEqual([mainOf(p),git(p.top,'show',p.branch+':src/a.txt'),leases(p).map(x=>x.tool),rows(log).length,r.log.includes('Agent stopped.')],
      [main,'done\n',tools,signal?0:1,true],`${n}: main moved, T lost the bytes, the lease calls, the gate runs, or no handled exit`+tail(r.log));
  }
}
// A function of this wrapper, by name (sh one-liners included).
function wrapperFn(n){
  const m=new RegExp(win?`^function ${n}\\b[\\s\\S]*?^\\}`:`^${n}\\(\\) \\{(?: .*; \\}$|[\\s\\S]*?^\\})`,'m').exec(read(wrapper));
  assert.ok(m,'no function '+n);return m[0];
}
const py=win?null:['python3','python'].find(c=>cp.spawnSync(c,['-c','import sys;sys.exit(sys.version_info[0]!=3)']).status===0);
// The lease id (slash, Unicode, astral and over-long targets) and the MOE_LAND_LEASE_WAIT_SEC parser, from
// this wrapper's own functions.
function leaseUnits(){
  const fn=wrapperFn,ids=['main','rel/x.y','rel/\u00fcn\u00ef-'+'x'.repeat(70),'a\u{1f600}b'],waits=['1800','2.5','0.001','86400','0','-1','abc','1e3','0.0001','86400.001',' 5'];
  const want=[...ids.map(t=>('git-land-'+t).replace(/[^A-Za-z0-9._-]/gu,'-').slice(0,64)),'1800000','2500','1','86400000',...waits.slice(4).map(()=>'bad')],q=s=>"'"+s.replace(/'/g,"''")+"'";
  const r=win?cp.spawnSync(engine,['-NoProfile','-NonInteractive','-Command',[fn('Get-MoeLandLeaseId'),fn('Get-MoeLandLeaseBudget'),...ids.map(t=>'Get-MoeLandLeaseId '+q(t)),
      ...waits.map(w=>`$b = Get-MoeLandLeaseBudget ${q(w)}; if ($null -eq $b) { 'bad' } else { $b }`)].join('\n')],{encoding:'utf8'})
    :cp.spawnSync(engine,['-c',`${fn('land_lease_id')}\n${fn('land_lease_budget')}\nfor t in "\${@:1:${ids.length}}"; do land_lease_id "$t"; echo; done\n`+
      `for w in "\${@:${ids.length+1}}"; do land_lease_budget "$w" || echo bad; done`,'_',...ids,...waits],{encoding:'utf8',env:{...inherited,PYTHON_CMD:py}});
  assert.deepEqual(String(r.stdout).trim().split(/\r?\n/),want,'the lease id or the wait parser: '+r.stderr);
}
// An earlier landing's failed release gets its one retry, as its own task and pinned to its grant, before the
// next acquire replaces it; a retry that fails again warns and the new lease still proceeds.
function leaseRetry(){
  const grant='{"success":true,"granted":true,"lease":{"taskId":"task-new","acquiredAt":"t2"}}';
  const r=win?cp.spawnSync(engine,['-NoProfile','-NonInteractive','-Command',[...['Get-MoeLandLeaseId','Get-MoeLandLeaseBudget','Invoke-MoeLandLeaseRpc','Acquire-MoeLandLease','Release-MoeLandLease'].map(wrapperFn),
      "$log = [System.Collections.Generic.List[string]]::new(); $preflightTaskId = 'task-new'; $WorkerId = 'w'; function Write-Host([object]$Object, $ForegroundColor) { $log.Add([string]$Object) }",
      `function Invoke-MoeRpc {\n param([Parameter()][string]$Tool, [object]$Args)\n $log.Add("rpc $Tool $($Args.taskId) $(if ($Args.ifAcquiredAt) { $Args.ifAcquiredAt } else { '-' })")\n if ($Tool -cne 'release_resource') { '${grant}' | ConvertFrom-Json }\n}`,
      "$script:MoeLandLease = @{ Id = 'git-land-main'; TaskId = 'task-old'; At = 't1' }; $ok = Acquire-MoeLandLease 'main' @{ configuredGate = 'gate' } @{} @{}",
      '$log; "rc=$(if ($ok) { 0 } else { 1 }) $($script:MoeLandLease.TaskId) $($script:MoeLandLease.At)"'].join('\n')],{encoding:'utf8'})
    :cp.spawnSync(engine,['-c',[...['land_now_ms','land_lease_id','land_lease_budget','land_lease_rpc','land_lease_read','acquire_land_lease','release_land_lease'].map(wrapperFn),
      'exec 3>&1; WORKER_ID=w QUALITY_GATE=gate LAND_TASK_ID=task-new LAND_LEASE_RID=git-land-main LAND_LEASE_TASK=task-old LAND_LEASE_AT=t1',
      `moe_rpc() { $PYTHON_CMD -c 'import json,sys; a=json.loads(sys.argv[2]); print("rpc",sys.argv[1],a["taskId"],a.get("ifAcquiredAt","-"))' "$1" "$2" >&3; [ "$1" != release_resource ] && echo '${grant}'; }`,
      'acquire_land_lease main; echo "rc=$? $LAND_LEASE_TASK $LAND_LEASE_AT"'].join('\n')],{encoding:'utf8',env:{...inherited,PYTHON_CMD:py}});
  assert.deepEqual(String(r.stdout).trim().split(/\r?\n/).map(l=>l.replace(/ -- .*/,'')),['rpc release_resource task-old t1','[WARN] MOE_LAND_LEASE_RELEASE_FAILED: task task-old',
    'rpc acquire_resource task-new -','[OK] task task-new holds the land lease git-land-main.','rc=0 task-new t2'],'the retry before the next lease: '+r.stderr);
}

// WT-11 (design §2.5): a completion that publishes nothing parks T on a rescue ref, records its failed row pushed:false
// and finalizes 'unlanded' with its reason, conflict paths and B (null before L4 reads one); an unknown push finalizes
// nothing. The next session merges the target (origin's, fetched, in remote mode) into W first: its prompt starts
// LANDING-CONFLICT: <paths> (markers, MERGE_HEAD) or LANDING-RETRY: <reason> (a clean merge); a failed fetch stops it.
const retryOf=p=>JSON.parse(readOr(path.join(p.dir,'.moe','landing-retry.json'))||'null');
const unlanded=p=>rpcs(p).filter(x=>x.tool==='finalize_attempt').map(x=>x.args),promptOf=f=>((rows(f).pop()||{}).context||'').split('\n')[0];
async function wtUnlanded(){
  const bare=(p,n,push=true)=>{const b=path.join(root,n+'.git');git(root,'init','-q','--bare',b);git(p.top,'remote','add','origin',b);if(push)git(p.top,'push','-q','origin','main');return b;};
  const origin=p=>revOf(p.top,'refs/remotes/origin/main'),none=()=>null,hook=path.join(root,'wt-unlanded-rejected.git','hooks','pre-receive'),ps={};
  for(const [n,settings,knobs,setup,code,reason,tipOf,next,mhOf] of [
    ['conflict',{},{},p=>commitOn(p,'refs/heads/main',{'src/a.txt':'main a\n'}),'MOE_COMMIT_FAILED_CONFLICT','conflict',mainOf,'LANDING-CONFLICT: src/a.txt',mainOf],
    ['contention',{},{WT_GIT_FAIL:'-m',FAKE_EVIDENCE_MODE:'finalize-loss-once'},null,'MOE_COMMIT_FAILED_REF_CONTENTION','contention',mainOf,'LANDING-RETRY: contention',none],
    ['gate',{qualityGate:gateCmd()},{WT_GATE_EXIT:'3'},null,'MOE_COMMIT_FAILED_GATE','gate',mainOf,'LANDING-RETRY: gate',none],
    ['lease',{qualityGate:gateCmd()},{FAKE_LEASE_MODE:'timeout',MOE_LAND_LEASE_WAIT_SEC:'3'},null,'MOE_COMMIT_FAILED_LAND_LEASE','contention',none,'LANDING-RETRY: contention',none],
    ['diverged',{},{},p=>{bare(p,'wt-unlanded-diverged');commitOn(p,'refs/heads/main',{'src/l.txt':'local\n'});},'MOE_LAND_TARGET_DIVERGED','diverged',origin,'LANDING-RETRY: diverged',none],
    ['fetch',{},{},p=>bare(p,'wt-unlanded-fetch',false),'MOE_LAND_FETCH_FAILED','remote',none,null,none],
    // The resume merges origin's main as fetched now (a peer push), never the local main.
    ['rejected',{},{},p=>{bare(p,'wt-unlanded-rejected');write(hook,'#!/bin/sh\nexit 1\n');fs.chmodSync(hook,0o755);},'MOE_PUSH_FAILED','remote',origin,'LANDING-RETRY: remote',
      p=>{fs.rmSync(hook);const peer=commitOn(p,'refs/wt-unlanded/peer',{'src/peer.txt':'peer\n'});git(p.top,'push','-q','origin',peer+':refs/heads/main');return peer;}]]){
    const p=ps[n]=repo('wt-unlanded-'+n,{settings:{...LANDS,...settings}}),rec=path.join(root,`wt-unlanded-${n}.jsonl`),net={MOE_LAND_NET_BACKOFF_SEC:'0'};
    await landRun(p,`wt-unlanded-${n}-0`,{'src/a.txt':'task a\n'});
    if(setup)setup(p);
    const main=mainOf(p),t=revOf(p.top,p.branch),tip=tipOf(p);
    let r=await landRun(p,'wt-unlanded-'+n,{},{...REVIEW,...net,WT_GATE_LOG:path.join(root,`wt-unlanded-${n}-gate.jsonl`),...knobs});
    const f=unlanded(p),ref=f.length?f[0].rescueRef:null;
    assert.deepEqual([mainOf(p),done(p).map(x=>[x.outcome,x.code,x.pushed]),f.map(x=>[x.outcome,x.unlandedReason,x.conflictPaths,x.targetTip,x.landedRevision])],
      [main,[['failed',code,false]],Array(knobs.FAKE_EVIDENCE_MODE?2:1).fill(['unlanded',reason,n==='conflict'?['src/a.txt']:[],tip,null])],`${n}: main moved, the row or the finalize`+tail(r.log));
    assert.deepEqual([revOf(p.top,ref),retryOf(p)&&[retryOf(p).rescueRef,retryOf(p).count]],[t,[ref,1]],`${n}: the rescue ref ${ref} or the stored landingRetry (a replayed finalize counts once)`);
    // A typed CLI: only typeShim forwards the prompt argv to WT_CLI_RECORD.
    const mh=mhOf(p);r=await launch(p,`wt-unlanded-${n}-resume`,{WT_CLI_RECORD:rec,...net,...(n==='conflict'?{MOE_DISABLE_CHECKPOINT:'1'}:{})},{type:'claude'});
    if(!next){refused(r,'MOE_WORKTREE_RESUME_FAILED');assert.equal(readOr(path.join(p.W,'src','a.txt')),'task a\n','W lost the bytes');continue;}
    assert.deepEqual([promptOf(rec),revOf(p.W,'MERGE_HEAD'),mainOf(p)],[next,mh,main],`${n}: the resume prompt, MERGE_HEAD or main`+tail(r.log));
  }
  // Resolved to T itself: still ONE task-branch commit [T, B] on T's tree, then C on main; the merge is quit.
  let p=ps.conflict;const t=revOf(p.top,p.branch),b=mainOf(p);
  let r=await landRun(p,'wt-unlanded-conflict-done',{'src/a.txt':'task a\n'},{...REVIEW,MOE_DISABLE_CHECKPOINT:'1'});
  const l2=parents(p.top,revOf(p.top,p.branch))[0],tree=x=>git(p.top,'rev-parse',x+'^{tree}');
  assert.deepEqual([parents(p.top,l2),tree(l2),git(p.top,'show',mainOf(p)+':src/a.txt'),revOf(p.W,'MERGE_HEAD')],[[t,b],tree(t),'task a\n',null],'resolved to T'+tail(r.log));
  // An unknown push publishes nothing provable: no finalize of any outcome, no landingRetry.
  p=repo('wt-unlanded-unknown',{settings:LANDS});bare(p,'wt-unlanded-unknown');
  r=await landRun(p,'wt-unlanded-unknown',{'src/a.txt':'done\n'},{...REVIEW,MOE_LAND_NET_BACKOFF_SEC:'0',WT_GIT_FAIL:'push'});
  assert.deepEqual([r.log.includes('MOE_PUSH_OUTCOME_UNKNOWN'),finals(p),retryOf(p)],[true,[],null],'an unknown push finalized'+tail(r.log));
}
// The conflict chain: the resume leaves markers and MERGE_HEAD; its checkpoint is one commit on T keeping MERGE_HEAD and
// the unmerged stages; a completion with markers lands nothing (MOE_WORKTREE_UNRESOLVED_CONFLICT, routed conflict again);
// resolved, C lands B's other change and the partial edit, keeps B's change to a DENY path the task never stages, the
// task-branch commit is [T', B] and the merge is quit.
async function wtResume(){
  const p=repo('wt-resume',{settings:LANDS}),rec=path.join(root,'wt-resume-cli.jsonl'),mh=()=>revOf(p.W,'MERGE_HEAD');
  await landRun(p,'wt-resume-0',{'src/a.txt':'task a\n'});
  const b=commitOn(p,'refs/heads/main',{'src/a.txt':'main a\n','src/m.txt':'main m\n','.gemini/g.md':'main g\n'});
  await landRun(p,'wt-resume-1',{},REVIEW);
  const t=revOf(p.top,p.branch);
  let r=await landRun(p,'wt-resume-2',{'src/p.txt':'partial\n'},{WT_CLI_RECORD:rec},{type:'claude'}),t2=revOf(p.top,p.branch);
  assert.deepEqual([promptOf(rec),mh(),/^<<<<<<< /m.test(read(path.join(p.W,'src','a.txt'))),parents(p.top,t2),git(p.W,'ls-files','-u','--','src/a.txt').trim().split('\n').length],
    ['LANDING-CONFLICT: src/a.txt',b,true,[t],3],'the prompt, MERGE_HEAD, the markers, the one-parent checkpoint or the unmerged stages'+tail(r.log));
  r=await landRun(p,'wt-resume-3',{},REVIEW);
  assert.deepEqual([mainOf(p),mh(),r.log.includes('[WARN] MOE_WORKTREE_UNRESOLVED_CONFLICT'),unlanded(p).map(x=>[x.outcome,x.unlandedReason,x.conflictPaths])],
    [b,b,true,[['unlanded','conflict',['src/a.txt']]]],'a completion with markers'+tail(r.log));
  r=await landRun(p,'wt-resume-4',{'src/a.txt':'resolved\n'},REVIEW);
  const c=mainOf(p),l2=parents(p.top,revOf(p.top,p.branch))[0];
  assert.deepEqual([parents(p.top,c),['src/a.txt','src/m.txt','src/p.txt','.gemini/g.md'].map(f=>git(p.top,'show',`${c}:${f}`)),parents(p.top,l2)[1],mh(),retryOf(p),finals(p)],
    [[b],['resolved\n','main m\n','partial\n','main g\n'],b,null,null,[['landed',c]]],'the resolved landing'+tail(r.log));
}
// The marker scan, from this wrapper's own function: each marker shape (CRLF too), a path out of W and a linked parent
// (out of W, or in W over a missing file) are hits, as are a file link and a FIFO (never opened) under sh and a name
// Windows cannot parse under ps1; a resolved deletion (absent) and marker look-alikes are not. sh builds under the suite's
// temp dir because a FIFO needs a filesystem that supports one, and drvfs (/mnt/<drive>) does not.
function markerScan(){
  const base=win?root:path.join(wrapperTmp,'marker scan'),w=path.join(base,'marker-scan'),out=path.join(base,'marker-scan-out'),q=s=>"'"+s.replace(/'/g,"''")+"'";
  const files={'lt.txt':'a\n<<<<<<< HEAD\n','gt.txt':'>>>>>>> theirs\r\n','eq.txt':'a\r\n=======\r\nb\r\n','ok.txt':'<<<<<<<x\n ======= \n=======x\n','sub/ok.txt':'b\n'};
  for(const [f,b] of Object.entries(files))write(path.join(w,f),b);
  write(path.join(out,'x.txt'),'clean\n');fs.symlinkSync(out,path.join(w,'out'),'junction');fs.symlinkSync(path.join(w,'sub'),path.join(w,'in'),'junction');
  if(!win){fs.symlinkSync('ok.txt',path.join(w,'fl.txt'));
    try{cp.execFileSync('mkfifo',[path.join(w,'fifo.txt')],{stdio:'pipe'});}catch(e){throw new Error(`mkfifo under ${base} failed; point TMPDIR at a filesystem that supports FIFOs: ${String(e.stderr||e.message).trim()}`);}}
  const more=['../x','in/gone.txt','out/x.txt',...(win?(winHost?['a<b.txt']:[]):['fifo.txt','fl.txt'])],args=[...Object.keys(files),'gone.txt',...more],o={encoding:'utf8',timeout:60000};
  const r=win?cp.spawnSync(engine,['-NoProfile','-NonInteractive','-Command',`${wrapperFn('Find-MoeConflictMarkers')}\nFind-MoeConflictMarkers ${q(w)} @(${args.map(q).join(',')})`],o)
    :cp.spawnSync(engine,['-c',`${wrapperFn('wt_marker_scan')}\nwt_marker_scan "$@"`,'_',w,...args],{...o,env:{...inherited,PYTHON_CMD:py}});
  assert.deepEqual(String(r.stdout).trim().split(/\r?\n/).sort(),['eq.txt','gt.txt','lt.txt',...more].sort(),'the marker scan: '+r.stderr);
}
// Teardown (§2.6). An interrupt before the CAS abandons the landing: main unmoved, no journal, T keeps the bytes, one
// finalize 'failed', never unlanded. One from the CAS through the ledger row and finalize waits for both, then stops.
// Either way the lease is released before the seat deregisters, the session is cut short and no process outlives it.
// sh sends SIGTERM; ps1 sends a real Ctrl+C to the wrapper's own console.
const phase=p=>JSON.parse(readOr(path.join(p.dir,'.moe','attempts','attempt-postflight.json'))||'{}').phase;
const ended=p=>rows(path.join(p.dir,'.moe','messages','chan-general.jsonl')).some(m=>String(m.content).includes('worker session ended: task='));
async function wtTeardown(){
  for(const [n,hold,knobs] of [['pre','merge-tree',{}],['sync','--ff-only',{}],['ledger',null,{FAKE_EVIDENCE_MODE:'teardown-landed',FAKE_HOLD_DRAIN:'1'}]]){
    const p=repo('wt-teardown-'+n,{settings:{...LANDS,qualityGate:gateCmd()}}),b=mainOf(p),held=path.join(root,`wt-teardown-${n}.held`),pre=n==='pre';
    const ready=hold?held:path.join(p.dir,'.moe','gate-ready'),hk=hold?{WT_GIT_HOLD:hold,WT_GIT_HOLD_FILE:held}:{};
    const r=await landRun(p,'wt-teardown-'+n,{'src/a.txt':'done\n'},{...REVIEW,WT_GATE_LOG:path.join(root,`wt-teardown-${n}-gate.jsonl`),...hk,...knobs},{ready}),c=mainOf(p);
    assert.ok(present(ready+'.sent')&&!ended(p)&&(pre||r.log.includes('Agent stopped.')),`${n}: no interrupt, or the session was not cut short`+tail(r.log));
    assert.deepEqual([pre?c:parents(p.top,c),git(p.top,'show',p.branch+':src/a.txt'),probe(p.top,'merge-base','--is-ancestor',c,p.branch),present(journal(p))],
      [pre?b:[b],'done\n','0:',false],`${n}: main, T's bytes or ancestry, or a journal stayed`+tail(r.log));
    assert.deepEqual([done(p).map(x=>[x.outcome,x.sha]),finals(p),phase(p)],[pre?[]:[['committed',c]],[pre?['failed',undefined]:['landed',c]],'closed'],
      `${n}: the completion row, the one finalize or the attempt`+tail(r.log));
    const seq=rpcs(p).map(x=>x.tool).filter(t=>['finalize_attempt',...LEASE,'deregister_worker'].includes(t));
    assert.deepEqual([seq.filter(t=>t!=='finalize_attempt'),seq.indexOf('finalize_attempt')<seq.indexOf('deregister_worker'),
      JSON.parse(read(path.join(p.dir,'.moe','resources','git-land-main.json'))).holders],[[LEASE[0],LEASE[2],'deregister_worker'],true,[]],
      `${n}: the lease was not released, or the finalize or release came after the deregister`+tail(r.log));
  }
}
// A hard death is not deferrable: the same seat's next pre-flight replays the journal while its claim is refused (the
// attempt is still finalizing), launches no CLI and moves no ref. Killed at the CAS, C never published: routed unlanded
// 'contention', T rescued. Killed after it, before the sync: C's exact row and finalize landed, no second landing.
async function wtCrash(){
  for(const [n,hold] of [['cas','-m'],['sync','--ff-only']]){
    const p=repo('wt-crash-'+n,{settings:LANDS}),b=mainOf(p),held=path.join(root,`wt-crash-${n}.held`),cas=n==='cas';
    let r=await landRun(p,'wt-crash-'+n,{'src/a.txt':'done\n'},{...REVIEW,WT_GIT_HOLD:hold,WT_GIT_HOLD_FILE:held},{kill:held});
    const c=mainOf(p),t=revOf(p.top,p.branch);
    assert.deepEqual([present(held),present(journal(p)),cas?c:parents(p.top,c),done(p),finals(p),phase(p)],[true,true,cas?b:[b],[],[],'finalizing'],
      `${n}: the kill missed its point, or the journal, main, a row or a finalize`+tail(r.log));
    r=await launch(p,`wt-crash-${n}-2`,{FAKE_CLAIM_MODE:'finalizing',MOE_TASKLESS_WAIT_SEC:'5'},{keep:true});
    assert.deepEqual([mainOf(p),revOf(p.top,p.branch),present(journal(p)),r.cliRan,phase(p)],[c,t,false,false,'closed'],
      `${n}: a ref moved, the journal stayed, a CLI ran, or the attempt is open`+tail(r.log));
    assert.deepEqual(cas?[done(p).map(x=>[x.outcome,x.code,x.pushed]),unlanded(p).map(x=>[x.outcome,x.unlandedReason,x.conflictPaths,x.targetTip]),revOf(p.top,(retryOf(p)||{}).rescueRef)]
      :[done(p).map(x=>[x.outcome,x.sha]),finals(p)],cas?[[['failed','MOE_COMMIT_FAILED_REF_CONTENTION',false]],[['unlanded','contention',[],b]],t]:[[['committed',c]],[['landed',c]]],
      `${n}: the replay`+tail(r.log));
  }
}

// WT-12 (design §4): board history on refs/moe/board, never main. The board-* cases run the
// snapshot program straight from the wrappers under test, which must carry one identical text.
const BOARD='refs/moe/board',MARK=/^\/\/ moe board snapshot program[^\n]*\n[\s\S]*?^\/\/ end of the moe board snapshot program$/m;
function boardJs(){
  const [a,b]=['moe-agent.sh','moe-agent.ps1'].map(f=>(MARK.exec(read(path.join(path.dirname(wrapper),f)))||[''])[0]);
  assert.ok(a&&a===b,'the wrappers do not carry one identical board snapshot program');
  const f=path.join(root,'board-snapshot.js');write(f,a+'\n');return f;
}
// --require shim: WT_BOARD_SHIM=race1|race3 lands a competing commit on the board ref just before
// the first (race1) or every (race3) update-ref, logging each to WT_BOARD_LOG; fail-<sub> fails that git call.
function boardShim(){
  const f=path.join(root,'board-shim.js');
  if(!present(f))write(f,`const cp=require('child_process'),fs=require('fs'),real=cp.spawnSync,mode=process.env.WT_BOARD_SHIM||'';let n=0;
cp.spawnSync=function(cmd,a,o){
  if(mode==='fail-'+a[2])return {status:1,stdout:'',stderr:'wt shim fails '+a[2],output:[],pid:0,signal:null};
  if(a[2]==='update-ref'&&(mode==='race3'||(mode==='race1'&&n++<1))){
    const g=x=>real(cmd,['-C',a[1],...x],{encoding:'utf8'}).stdout.trim(),tip=g(['rev-parse','${BOARD}']),c=g(['commit-tree',tip+'^{tree}','-p',tip,'-m','competitor']);
    g(['update-ref','${BOARD}',c,tip]);fs.appendFileSync(process.env.WT_BOARD_LOG,c+'\\n');
  }
  return real.apply(this,arguments);
};\n`);
  return f;
}
// One program run; it never changes .moe, the control index, a branch or HEAD (sig).
function snap(p,status,env={}){
  const before=sig(p),r=cp.spawnSync(process.execPath,[...(env.WT_BOARD_SHIM?['--require',boardShim()]:[]),boardJs(),p.top,TASK,status],
    {encoding:'utf8',env:{...inherited,TMPDIR:wrapperTmp,TMP:wrapperTmp,TEMP:wrapperTmp,...env},timeout:LIMIT});
  assert.equal(r.status,0,`the snapshot program exited ${r.status}: ${r.stderr}${r.stdout}`);
  assert.equal(sig(p),before,'the snapshot changed .moe, the control index, a branch or HEAD: '+r.stdout);return r.stdout;
}
const boardTree=p=>Object.fromEntries(git(p.top,'ls-tree','-r','-z','--full-tree',BOARD).split('\0').filter(Boolean).map(l=>{const m=/^\S+ \S+ (\S+)\t(.*)$/s.exec(l);return [m[2],m[1]];}));
// The control checkout's board files, hashed byte for byte (no filters).
function boardFiles(p){
  const fl=['.moe/project.json'];
  for(const d of ['tasks','epics'])if(present(path.join(p.dir,'.moe',d)))fl.push(...fs.readdirSync(path.join(p.dir,'.moe',d)).filter(n=>n.endsWith('.json')).map(n=>`.moe/${d}/${n}`));
  const ids=git(p.top,'hash-object','--no-filters','--',...fl).trim().split('\n');return Object.fromEntries(fl.map((f,i)=>[f,ids[i]]));
}
// Every path, mode, size, mtime and byte under .moe, the control index file and the branches: what a snapshot never changes.
function sig(p){
  const out=[],walk=d=>{for(const n of fs.readdirSync(d).sort()){const f=path.join(d,n),s=fs.lstatSync(f);
    out.push([path.relative(p.dir,f),s.mode,s.size,s.mtimeMs,s.isFile()?fs.readFileSync(f).toString('base64'):'']);if(s.isDirectory())walk(f);}};
  walk(path.join(p.dir,'.moe'));const ix=path.join(git(p.top,'rev-parse','--absolute-git-dir').trim(),'index');
  return JSON.stringify([out,fs.statSync(ix).mtimeMs,fs.readFileSync(ix).toString('base64'),probe(p.top,'for-each-ref','refs/heads'),probe(p.top,'symbolic-ref','HEAD')]);
}
// A full first snapshot (exact CRLF and UTF-8 bytes under autocrlf, nothing else), an unchanged board, then a torn,
// a new torn, a deleted and an edited file, then a linked directory; read-only throughout.
async function boardSnapshot(){
  const p=repo('board-snapshot'),m=f=>path.join(p.dir,'.moe',f);
  git(p.top,'config','core.autocrlf','true');
  write(m('epics/epic-a.json'),'{\r\n  "title": "café 日本"\r\n}\r\n');write(m('tasks/task-b.json'),'{"id":"task-b"}');
  for(const f of ['tasks/notes.txt','tasks/sub/task-c.json','workers/w.json','tasks/task-d.json.1.tmp'])write(m(f),'{}');
  let out=snap(p,'REVIEW');const c1=revOf(p.top,BOARD),t1=boardTree(p);
  assert.ok(c1&&out.includes('[OK] board snapshot '+c1),'no first snapshot: '+out);
  assert.deepEqual([parents(p.top,c1),git(p.top,'log','-1','--format=%B',c1).trim(),t1,Object.keys(t1).length],[[],`board: ${TASK} REVIEW`,boardFiles(p),4],
    'the first snapshot: parents, message, or a tree that is not exactly the 4 board files');
  assert.match(out,/MOE_BOARD_UNPUSHED: no origin remote/,'no MOE_BOARD_UNPUSHED line without a remote');
  out=snap(p,'DONE');
  assert.ok(revOf(p.top,BOARD)===c1&&out.includes('unchanged'),'an unchanged board wrote a commit: '+out);
  write(m('tasks/task-b.json'),'{"id":');write(m('tasks/task-new.json'),'{');fs.rmSync(m(`tasks/${TASK}.json`));write(m('epics/epic-a.json'),'{"t":2}');
  out=snap(p,'DONE');const c2=revOf(p.top,BOARD),want=boardFiles(p);
  delete want['.moe/tasks/task-new.json'];want['.moe/tasks/task-b.json']=t1['.moe/tasks/task-b.json'];
  assert.deepEqual([parents(p.top,c2),boardTree(p)],[[c1],want],'torn files keep their parent blob, a deleted one goes, an edit lands');
  assert.match(out,/\[WARN\] MOE_BOARD_FILE_KEPT: 2 .*"\.moe\/tasks\/task-b\.json".*"\.moe\/tasks\/task-new\.json"/,'the torn files are not named');
  fs.renameSync(m('epics'),m('epics-real'));fs.symlinkSync(m('epics-real'),m('epics'),winHost?'junction':'dir');
  try{out=snap(p,'DONE');}finally{unlinkOnly(m('epics'));}
  assert.ok(revOf(p.top,BOARD)===c2&&/\[WARN\] MOE_BOARD_SNAPSHOT_SKIPPED: \.moe\/epics is not a plain directory/.test(out),'a linked board directory: '+out);
}
// One lost CAS retries on the winner; three lost CASes skip and keep every competing commit; a failed
// write-tree or commit-tree skips.
async function boardRace(){
  const p=repo('board-race'),m=f=>path.join(p.dir,'.moe',f),log=path.join(root,'board-race.log'),lost=()=>read(log).trim().split('\n');
  snap(p,'REVIEW');const c1=revOf(p.top,BOARD);
  write(m('tasks/task-b.json'),'{"id":"b"}');
  let out=snap(p,'REVIEW',{WT_BOARD_SHIM:'race1',WT_BOARD_LOG:log});const w=lost(),c2=revOf(p.top,BOARD);
  assert.deepEqual([w.length,parents(p.top,w[0]),parents(p.top,c2),boardTree(p)],[1,[c1],w,boardFiles(p)],'one lost CAS, then a snapshot on the winner: '+out);
  fs.rmSync(log);write(m('tasks/task-b.json'),'{"id":"b2"}');
  out=snap(p,'REVIEW',{WT_BOARD_SHIM:'race3',WT_BOARD_LOG:log});const l=lost();
  assert.deepEqual([l.length,revOf(p.top,BOARD),l.map(c=>parents(p.top,c)[0])],[3,l[2],[c2,l[0],l[1]]],'three lost CASes: the competing commits');
  assert.match(out,/\[WARN\] MOE_BOARD_SNAPSHOT_SKIPPED: .*3 /,'no MOE_BOARD_SNAPSHOT_SKIPPED line after three lost CASes');
  for(const sub of ['write-tree','commit-tree']){
    out=snap(p,'REVIEW',{WT_BOARD_SHIM:'fail-'+sub});
    assert.ok(revOf(p.top,BOARD)===l[2]&&out.includes('[WARN] MOE_BOARD_SNAPSHOT_SKIPPED: git '+sub),`a failed ${sub}: `+out);
  }
}
// The push is plain (no force): pushed when it fast-forwards, MOE_BOARD_UNPUSHED and both refs kept when rejected.
async function boardPush(){
  const p=repo('board-push'),bare=path.join(root,'board-push.git');
  git(root,'init','-q','--bare',bare);git(p.top,'remote','add','origin',bare);
  let out=snap(p,'REVIEW');const c1=revOf(p.top,BOARD);
  assert.ok(c1&&revOf(bare,BOARD)===c1&&!out.includes('MOE_BOARD_UNPUSHED'),'the first snapshot was not pushed: '+out);
  const div=git(p.top,'commit-tree',c1+'^{tree}','-m','divergent').trim();git(p.top,'push','-q','--force',bare,`${div}:${BOARD}`);
  write(path.join(p.dir,'.moe','tasks','task-b.json'),'{}');out=snap(p,'REVIEW');const c2=revOf(p.top,BOARD);
  assert.deepEqual([parents(p.top,c2),revOf(bare,BOARD),/\[WARN\] MOE_BOARD_UNPUSHED: .*rejected/.test(out)],[[c1],div,true],'a rejected push: '+out);
  git(p.top,'remote','set-url','origin',path.join(root,'board-missing.git'));write(path.join(p.dir,'.moe','tasks','task-b.json'),'{"u":1}');out=snap(p,'REVIEW');
  assert.deepEqual([parents(p.top,revOf(p.top,BOARD)),revOf(bare,BOARD),out.includes('[WARN] MOE_BOARD_UNPUSHED: ')],[[c2],div,true],'an unreachable remote: '+out);
}
// The wrappers: a worktree completion snapshots after L12 and C changes no .moe path; a QA post-flight in the
// control checkout snapshots; commitBoardState=false snapshots nothing; a snapshot failure leaves the landing landed.
async function wtBoard(){
  const p=repo('wt-board',{settings:LANDS}),m=f=>path.join(p.dir,'.moe',f),main=mainOf(p),set=s=>write(m('project.json'),JSON.stringify({id:'proj-worktree',settings:{...LANDS,...s}}));
  write(m('epics/epic-a.json'),'{"id":"epic-a"}\r\n');write(m('tasks/task-b.json'),'{"id":"task-b"}');
  let r=await landRun(p,'wt-board-1',{'src/a.txt':'done\n'},REVIEW);const c=mainOf(p),b1=revOf(p.top,BOARD);
  assert.ok(c!==main&&b1,'main did not move, or no board snapshot'+tail(r.log));
  assert.deepEqual([boardTree(p),git(p.top,'diff','--name-only',main,c).split('\n').filter(f=>f.startsWith('.moe')),git(p.top,'log','-1','--format=%B',b1).trim(),done(p).map(x=>x.outcome)],
    [boardFiles(p),[],`board: ${TASK} REVIEW`,['committed']],'the board tree, a .moe path on main, the message or the completion row'+tail(r.log));
  write(m(`tasks/${TASK}.json`),JSON.stringify({id:TASK,title:'Worktree smoke',status:'DONE'}));
  r=await launch(p,'wt-board-qa',{FAKE_CLAIM_WORKSPACE:null,FAKE_TASK_STATUS:'DONE',...landed(c)},{role:'qa'});const b2=revOf(p.top,BOARD);
  assert.deepEqual([r.code,parents(p.top,b2),git(p.top,'log','-1','--format=%B',b2).trim(),boardTree(p)],[0,[b1],`board: ${TASK} DONE`,boardFiles(p)],'the QA snapshot'+tail(r.log));
  set({commitBoardState:false});
  r=await launch(p,'wt-board-off',{FAKE_CLAIM_WORKSPACE:null,FAKE_TASK_STATUS:'DONE',...landed(c)},{role:'qa'});
  assert.ok(r.code===0&&revOf(p.top,BOARD)===b2&&!/MOE_BOARD_|board snapshot/.test(r.log),'commitBoardState=false still snapshotted'+tail(r.log));
  set({});const blob=git(p.top,'hash-object','-w','--stdin',{input:'not a commit'}).trim();git(p.top,'update-ref',BOARD,blob);
  r=await landRun(p,'wt-board-skip',{'src/b.txt':'b\n'},REVIEW);const c2=mainOf(p);
  assert.deepEqual([r.code,parents(p.top,c2),done(p).map(x=>[x.outcome,x.sha]),finals(p),probe(p.top,'rev-parse',BOARD).trim()],[0,[c],[['committed',c2]],[['landed',c2]],'0:'+blob],
    'a failed snapshot changed the landing or the board ref'+tail(r.log));
  assert.match(r.log,/\[WARN\] MOE_BOARD_SNAPSHOT_SKIPPED: /,'no MOE_BOARD_SNAPSHOT_SKIPPED line');
}

// WT-13 §6.1: a wrapper copy in a registered task worktree, or reached through a link to one, refuses with
// MOE_WRAPPER_IN_WORKTREE before any RPC or CLI, though --project names the control checkout and the cwd is
// outside W. A copy under .worktrees-other/task-* and a non-Git (bundled) copy launch. The root holds a space.
// Copies never get the harness seam MOE_POSTFLIGHT_TEST_ALLOW_WORKTREE_WRAPPER (task-3c4be125): exactly '1'
// lets the registered-W copy launch; 'true', ' 1' and '0' keep the refusal.
async function wtGuard(){
  const p=repo('wt-guard'),g=p.top+'/.worktrees/task-guard',src=path.dirname(wrapper),alias=path.join(root,'wt-guard alias');
  const copy=d=>{
    fs.mkdirSync(d,{recursive:true});
    for(const f of fs.readdirSync(src,{withFileTypes:true}))if(f.isFile())fs.copyFileSync(path.join(src,f.name),path.join(d,f.name));
    return path.join(d,path.basename(wrapper));
  };
  git(p.top,'worktree','add','-q','--detach',g);copy(g+'/scripts');fs.symlinkSync(g,alias,'junction');
  for(const [run,w] of [['wt-guard-in',g+'/scripts/'+path.basename(wrapper)],['wt-guard-alias',path.join(alias,'scripts',path.basename(wrapper))]]){
    const r=await launch(p,run,{FAKE_CLAIM_WORKSPACE:null},{wrapper:w});
    assert.ok(r.code===1&&r.log.includes('[ERROR] MOE_WRAPPER_IN_WORKTREE:'),`${run}: exit ${r.code}, no MOE_WRAPPER_IN_WORKTREE refusal`+tail(r.log));
    assert.ok(!r.cliRan&&!present(path.join(p.dir,'.moe','evidence-rpcs.jsonl')),`${run}: an RPC or the CLI ran`+tail(r.log));
  }
  for(const [run,d] of [['wt-guard-other',p.top+'/.worktrees-other/task-guard/scripts'],['wt-guard-bundled',path.join(root,'wt-guard bundled','scripts')]]){
    const r=await launch(p,run,{FAKE_CLAIM_WORKSPACE:null},{wrapper:copy(d)});
    assert.ok(r.code===0&&r.cliRan&&!r.log.includes('MOE_WRAPPER_IN_WORKTREE'),`${run}: exit ${r.code}, or the copy did not launch`+tail(r.log));
  }
  const inW=g+'/scripts/'+path.basename(wrapper),seam=v=>({FAKE_CLAIM_WORKSPACE:null,MOE_POSTFLIGHT_TEST_ALLOW_WORKTREE_WRAPPER:v});
  let r=await launch(p,'wt-guard-optout',seam('1'),{wrapper:inW});
  assert.ok(r.code===0&&r.cliRan&&!r.log.includes('MOE_WRAPPER_IN_WORKTREE'),`wt-guard-optout: seam '1', exit ${r.code}, or the W copy did not launch`+tail(r.log));
  for(const v of ['true',' 1','0']){
    r=await launch(p,'wt-guard-optout-strict',seam(v),{wrapper:inW});
    assert.ok(r.code===1&&r.log.includes('[ERROR] MOE_WRAPPER_IN_WORKTREE:'),`wt-guard-optout-strict: seam '${v}', exit ${r.code}, no MOE_WRAPPER_IN_WORKTREE refusal`+tail(r.log));
    assert.ok(!r.cliRan&&!present(path.join(p.dir,'.moe','evidence-rpcs.jsonl')),`wt-guard-optout-strict: seam '${v}', an RPC or the CLI ran`+tail(r.log));
  }
}

// WT-13 §6.2/§6.5: the branch states at a worker pre-flight's follow (the one caller that may switch). Each
// setup returns {code, head, sha, switched, refused, detail, check}: code is the one MOE_CONTROL_ code the run
// prints (none: no such line), head/sha the control HEAD after. main never moves; refused is WT-04's stop.
const MC='refs/heads/moe/control';
// The fake proxy's get_context task.landing, a recorded completion at sha (FAKE_CTX_LANDING).
const landed=sha=>({FAKE_CTX_LANDING:JSON.stringify({lastCompletion:{sha,ref:'refs/heads/main',pushed:false,recordedAt:'2026-11-02T00:00:00.000Z'}})});
const commitHere=(p,f,b)=>{write(path.join(p.top,f),b);git(p.top,'add','--',f);git(p.top,'commit','-qm','local '+f);return revOf(p.top,'HEAD');};
const advanced=(p,files,extra={})=>{const old=mainOf(p),c=commitOn(p,'refs/heads/main',files);return {code:'MOE_CONTROL_ADVANCED',line:`${old}..${c}`,head:MC,sha:c,...extra};};
const behind=(p,files,extra={})=>{const old=mainOf(p);commitOn(p,'refs/heads/main',files);return {code:'MOE_CONTROL_CHECKOUT_BEHIND',head:MC,sha:old,...extra};};
const follows=[
  ['switch-new',p=>{git(p.top,'switch','-q','main');git(p.top,'branch','-q','-D','moe/control');return {head:MC,sha:mainOf(p),switched:true};}],
  ['switch-same',p=>{git(p.top,'switch','-q','main');return {head:MC,sha:mainOf(p),switched:true};}],
  ['detached',p=>{git(p.top,'switch','-q','--detach','main');return {head:MC,sha:mainOf(p),switched:true};}],
  ['current',p=>({head:MC,sha:mainOf(p)})],
  ['advance',p=>advanced(p,{'scripts/tool.sh':'echo landed\n'},{check:()=>assert.deepEqual(
    [readOr(path.join(p.top,'scripts','tool.sh')),probe(p.top,'status','--porcelain','--','scripts')],['echo landed\n','0:'],'scripts/ on disk is not HEAD')})],
  ['moe-dirt',p=>{const t=path.join(p.dir,'.moe','tasks',TASK+'.json'),s=path.join(p.dir,'.moe','sentinel.json');write(t,'{"dirty":1}');write(s,'keep');
    return advanced(p,{'src/b.txt':'b\n'},{check:()=>assert.deepEqual([read(t),read(s)],['{"dirty":1}','keep'],'the .moe dirt changed')});}],
  ['feature',p=>{git(p.top,'switch','-q','-c','feature');return {code:'MOE_CONTROL_NOT_FOLLOWING',head:'refs/heads/feature',sha:mainOf(p),refused:true};}],
  ['mc-elsewhere',p=>{git(p.top,'switch','-q','main');const m=commitOn(p,MC,{'src/m.txt':'m\n'});
    return {code:'MOE_CONTROL_NOT_FOLLOWING',head:'refs/heads/main',sha:mainOf(p),refused:true,check:()=>assert.equal(revOf(p.top,MC),m,'moe/control moved')};}],
  ['ahead',p=>({code:'MOE_CONTROL_CHECKOUT_DIVERGED',head:MC,sha:commitHere(p,'src/l.txt','local\n')})],
  ['diverged',p=>{commitOn(p,'refs/heads/main',{'src/m.txt':'m\n'});return {code:'MOE_CONTROL_CHECKOUT_DIVERGED',head:MC,sha:commitHere(p,'src/l.txt','local\n')};}],
  ['edit',p=>{const f=path.join(p.top,'src','a.txt');write(f,'human edit\n');
    return behind(p,{'src/a.txt':'landed\n'},{detail:/src\/a\.txt/,check:()=>assert.equal(read(f),'human edit\n','the local edit was lost')});}],
  ['untracked',p=>{const f=path.join(p.top,'src','u.txt');write(f,'mine\n');
    return behind(p,{'src/u.txt':'landed\n'},{detail:/src\/u\.txt/,check:()=>assert.equal(read(f),'mine\n','the untracked file was lost')});}],
  ['lock',p=>{const l=path.join(git(p.top,'rev-parse','--absolute-git-dir').trim(),'index.lock');write(l,'');
    return behind(p,{'src/b.txt':'b\n'},{check:()=>{assert.ok(present(l),'the index.lock was deleted');fs.rmSync(l);}});}],
  ['moe-landed',p=>behind(p,{'.moe/project.json':'{}'},{detail:/daemon-owned/})],
];
follows.push(['shared-work',p=>{git(p.top,'switch','-q','-c','moe/work-2026-11-02');const old=mainOf(p);commitOn(p,'refs/heads/main',{'src/b.txt':'b\n'});
  return {head:'refs/heads/moe/work-2026-11-02',sha:old,knobs:{FAKE_CLAIM_WORKSPACE:null}};}]);
// Hooks never run during a switch or a fast-forward (core.hooksPath is an empty directory).
async function wtFollow(){
  for(const [name,setup] of follows){
    const p=repo('wt-follow-'+name),x=setup(p),main=mainOf(p),hooked=path.join(root,`wt-follow-${name}.hooks`);
    for(const h of ['post-checkout','post-merge']){
      const f=path.join(p.top,'.git','hooks',h);write(f,`#!/bin/sh\necho ${h} >> "${hooked.replace(/\\/g,'/')}"\n`);fs.chmodSync(f,0o755);
    }
    const r=await launch(p,'wt-follow-'+name,x.knobs||{});
    const codes=[...new Set(r.log.match(/MOE_CONTROL_[A-Z_]+/g)||[])];
    try{
      assert.equal(readOr(hooked),null,'a hook ran');
      assert.deepEqual(codes,x.code?[x.code]:[],'the MOE_CONTROL_ codes');
      if(x.line)assert.match(r.log,new RegExp(`^\\[OK\\] MOE_CONTROL_ADVANCED ${x.line}\\r?$`,'m'),'no ADVANCED old..new line');
      else if(x.code)assert.match(r.log,new RegExp(`^\\[WARN\\] ${x.code}: [\\s\\S]*${x.detail?x.detail.source:''}`,'m'),`no [WARN] ${x.code} line`);
      assert.equal(/control checkout switched from /.test(r.log),!!x.switched,'the switch line');
      assert.deepEqual([probe(p.top,'symbolic-ref','-q','HEAD').trim(),revOf(p.top,'HEAD'),mainOf(p)],[(x.head===null?'1:':'0:'+x.head),x.sha,main],'HEAD, its commit, or main');
      if(x.refused)refused(r,'MOE_CONTROL_NOT_FOLLOWING');
      else assert.ok(r.code===0&&r.cliRan,`exit ${r.code}; the CLI ran: ${r.cliRan}`);
      if(x.check)x.check();
    }catch(e){e.message=`${name}: ${e.message}`+tail(r.log);throw e;}
  }
}
// WT-13 §6.2-§6.4: an L13 refusal (a human edit on the landed file) leaves C landed and the control as it
// was; an alert reaches #general once an hour per code for every seat (a stamp backdated past the hour lets
// the next through; a held lock is skipped, a 10-minute-old one is removed); a QA claim in remote mode syncs
// origin's main (landed from another clone) before its follow.
async function wtFollowSites(){
  let p=repo('wt-l13',{settings:LANDS});const old=mainOf(p),f=path.join(p.top,'src','a.txt');write(f,'human edit\n');
  let r=await landRun(p,'wt-l13',{'src/a.txt':'done\n'},REVIEW);const c=mainOf(p);
  assert.ok(c!==old&&/^\[WARN\] MOE_CONTROL_CHECKOUT_BEHIND: [\s\S]*src\/a\.txt/m.test(r.log),'no landing, or no L13 refusal'+tail(r.log));
  assert.deepEqual([done(p).map(x=>[x.outcome,x.sha]),finals(p),revOf(p.top,'HEAD'),read(f)],[[['committed',c]],[['landed',c]],old,'human edit\n'],
    'L13 changed the landed outcome, the control HEAD or the human edit'+tail(r.log));
  p=repo('wt-alert');commitHere(p,'src/l.txt','local\n');
  const dir=path.join(git(p.top,'rev-parse','--absolute-git-dir').trim(),'moe'),stamp=path.join(dir,'control-alert-MOE_CONTROL_CHECKOUT_DIVERGED'),lock=path.join(dir,'control-alert.lock');
  const alerts=()=>rows(path.join(p.dir,'.moe','messages','chan-general.jsonl')).filter(m=>String(m.content).startsWith('MOE_CONTROL_CHECKOUT_DIVERGED: ')).length;
  const old1=()=>write(stamp,Math.floor(Date.now()/1000)-3601+'\n'),seen=[];
  for(const [run,before] of [['1',()=>{}],['2',()=>{}],['3',old1],['held',()=>{old1();write(lock,'');}],['stale',()=>{const t=new Date(Date.now()-11*60000);fs.utimesSync(lock,t,t);}]]){
    before();r=await launch(p,'wt-alert-'+run);
    seen.push([run,(r.log.match(/^\[WARN\] MOE_CONTROL_CHECKOUT_DIVERGED: /gm)||[]).length,alerts()]);
  }
  assert.deepEqual(seen,[['1',2,1],['2',2,1],['3',2,2],['held',2,2],['stale',2,3]],'[WARN] lines per run (loop top, pre-flight) and #general alerts so far');
  p=repo('wt-qa-remote');const bare=path.join(root,'wt-qa-remote.git'),seed=mainOf(p);
  git(root,'init','-q','--bare',bare);git(p.top,'remote','add','origin',bare);
  const o=commitOn(p,'refs/heads/wt-qa-other',{'src/o.txt':'another clone\n'});git(p.top,'push','-q','origin','wt-qa-other:main');git(p.top,'update-ref','-d','refs/heads/wt-qa-other');
  r=await launch(p,'wt-qa-remote',{FAKE_CLAIM_WORKSPACE:null,FAKE_TASK_STATUS:'REVIEW',MOE_LAND_NET_BACKOFF_SEC:'0',...landed(o)},{role:'qa'});
  assert.deepEqual([r.code,mainOf(p),revOf(p.top,'HEAD'),probe(p.top,'symbolic-ref','-q','HEAD'),read(path.join(p.top,'src','o.txt'))],[0,o,o,'0:'+MC+'\n','another clone\n'],
    'the QA pre-flight did not sync origin, mirror main and follow it'+tail(r.log));
  assert.match(r.log,new RegExp(`^\\[OK\\] MOE_CONTROL_ADVANCED ${seed}\\.\\.${o}\\r?$`,'m'),'no ADVANCED line'+tail(r.log));
}
// The follow merges the tip it checked, never a target that moved since: a .moe path landed while the loop
// top's merge waits (the git stub holds the first --ff-only) stays out of the control HEAD, and the
// pre-flight's follow then refuses it as daemon-owned.
async function wtFollowRace(){
  const p=repo('wt-follow-race'),old=mainOf(p),tip=commitOn(p,'refs/heads/main',{'src/b.txt':'b\n'}),held=path.join(root,'wt-follow-race.held');
  let later=null;
  const land=()=>{if(!later&&present(held)){later=commitOn(p,'refs/heads/main',{'.moe/landed.json':'{}'},tip);write(held+'.sent','sent');}return false;};
  const r=await launch(p,'wt-follow-race',{WT_GIT_HOLD:'--ff-only',WT_GIT_HOLD_FILE:held},{signal:land});
  assert.ok(later,'the follow never reached its merge'+tail(r.log));
  assert.match(r.log,new RegExp(`^\\[OK\\] MOE_CONTROL_ADVANCED ${old}\\.\\.${tip}\\r?$`,'m'),'no ADVANCED old..tip line'+tail(r.log));
  assert.match(r.log,/^\[WARN\] MOE_CONTROL_CHECKOUT_BEHIND: [\s\S]*daemon-owned/m,'the next follow did not refuse the .moe path'+tail(r.log));
  assert.deepEqual([revOf(p.top,'HEAD'),present(path.join(p.top,'.moe','landed.json')),mainOf(p)],[tip,false,later],
    'the control HEAD went past the checked tip'+tail(r.log));
}
// Real git (no PATH stub): count follow merges and release the lock relative to its first try.
async function wtFollowLock(){
  const merges=f=>(readOr(f)||'').split('\n').filter(l=>/trace: built-in: git merge .*--no-autostash/.test(l)).length;
  const behinds=r=>(r.log.match(/^\[WARN\] MOE_CONTROL_CHECKOUT_BEHIND: /gm)||[]).length;
  const lockOf=p=>path.join(git(p.top,'rev-parse','--absolute-git-dir').trim(),'index.lock');
  for(const name of ['released','held','other']){
    const p=repo('wt-follow-lock-'+name),old=mainOf(p),edit=path.join(p.top,'src','a.txt');
    if(name==='other')write(edit,'human edit\n');
    const tip=commitOn(p,'refs/heads/main',name==='other'?{'src/a.txt':'landed\n'}:{'src/b.txt':'b\n'});
    const lock=lockOf(p),trace=path.join(root,'wt-follow-lock-'+name+'.trace');
    if(name!=='other')write(lock,'');
    let started=0,removed=false,gone=false;
    const signal=()=>{
      if(!started&&merges(trace)>=1)started=Date.now();
      if(name==='released'&&started&&!removed&&Date.now()-started>=3000){
        gone=!present(lock);fs.rmSync(lock,{force:true});removed=true;
      }
      return false;
    };
    try{
      const r=await launch(p,'wt-follow-lock-'+name,{GIT_TRACE:trace},{signal});
      const why=s=>name+': '+s+tail(r.log);
      if(name==='released'){
        assert.deepEqual([...new Set(r.log.match(/MOE_CONTROL_[A-Z_]+/g)||[])],['MOE_CONTROL_ADVANCED'],why('the MOE_CONTROL_ codes'));
        assert.deepEqual(r.log.match(/^\[OK\] MOE_CONTROL_ADVANCED .*$/gm),[`[OK] MOE_CONTROL_ADVANCED ${old}..${tip}`],why('no single ADVANCED old..tip line'));
        assert.ok(removed&&!gone,why('the lock was not released, or the wrapper deleted index.lock'));
        assert.ok(merges(trace)>=2,why('no merge retry'));
        assert.deepEqual([probe(p.top,'symbolic-ref','-q','HEAD').trim(),revOf(p.top,'HEAD'),mainOf(p)],['0:'+MC,tip,tip],why('HEAD, its commit, or main'));
      }else{
        assert.ok(behinds(r)>=1,why('no BEHIND warning'));
        assert.equal(merges(trace),(name==='held'?5:1)*behinds(r),why('wrong merge tries per follow'));
        assert.ok(!r.log.includes('MOE_CONTROL_ADVANCED'),why('unexpected ADVANCED line'));
        assert.equal(revOf(p.top,'HEAD'),old,why('HEAD moved'));
        if(name==='held')assert.ok(present(lock),why('the wrapper deleted index.lock'));
        else assert.equal(read(edit),'human edit\n',why('the local edit was lost'));
      }
      assert.ok(r.code===0&&r.cliRan,why(`exit ${r.code}; the CLI ran: ${r.cliRan}`));
    }finally{if(name!=='other')fs.rmSync(lock,{force:true});}
  }
}
// WT-13 §6.4: a QA claim in the control checkout launches only once the task's recorded completion C
// (get_context task.landing.lastCompletion, never its checkpoint) is in the control HEAD after the follow;
// otherwise MOE_CONTROL_CHECKOUT_BEHIND, one report_blocked and no CLI. The prompt names C's own diff, since
// HEAD may be later. A QA seat off moe/control (shared mode) has no gate.
async function wtQaGate(){
  const run=async(p,name,knobs)=>{
    const rec=path.join(root,name+'.cli.jsonl');
    const r=await launch(p,name,{FAKE_CLAIM_WORKSPACE:null,FAKE_TASK_STATUS:'REVIEW',WT_CLI_RECORD:rec,...knobs},{role:'qa',type:'claude'});
    return {...r,prompt:(rows(rec).pop()||{}).context||''};
  };
  const reviewed=(r,c,head)=>{
    assert.ok(r.code===0&&r.cliRan&&r.blocked.length===0,`exit ${r.code}; the CLI ran: ${r.cliRan}; report_blocked calls: ${r.blocked.length}`+tail(r.log));
    assert.equal(r.prompt.split(`Review commit ${c}: `).length,2,'the prompt does not name the review commit once'+tail(r.log));
    assert.ok(r.prompt.includes(`git diff ${c}^ ${c}`),"the prompt does not name the review commit's diff");
    assert.equal(revOf(r.top,'HEAD'),head,'the control HEAD');
  };
  const why=(r,re)=>{refused(r,'MOE_CONTROL_CHECKOUT_BEHIND');assert.match(r.blocked[0].args.reason,re,'the report_blocked reason');};
  // The follow is refused (a human edit to the landed file), so C stays out of the control HEAD.
  let p=repo('wt-qa-behind');write(path.join(p.top,'src','a.txt'),'human edit\n');
  const old=mainOf(p),cb=commitOn(p,'refs/heads/main',{'src/a.txt':'landed\n'});
  let r=await run(p,'wt-qa-behind',landed(cb));
  why(r,new RegExp(`^MOE_CONTROL_CHECKOUT_BEHIND: task ${TASK}: completion ${cb} is not in the control HEAD ${old} `));
  assert.equal(revOf(p.top,'HEAD'),old,'the control HEAD moved');
  // The follow fast-forwards onto C, then onto a later D: both launch, both prompts name C.
  p=repo('wt-qa-ff');const c=commitOn(p,'refs/heads/main',{'src/b.txt':'b\n'});
  r=await run(p,'wt-qa-ff',landed(c));reviewed({...r,top:p.top},c,c);
  const d=commitOn(p,'refs/heads/main',{'src/d.txt':'d\n'});
  r=await run(p,'wt-qa-later',landed(c));reviewed({...r,top:p.top},c,d);
  // No usable completion: none recorded, a checkpoint at HEAD only, a malformed sha, a sha no object has, and a
  // failing ancestry check (the git stub fails every --is-ancestor; HEAD is already at C, so the follow skips it).
  const head=revOf(p.top,'HEAD'),none=/no recorded completion commit/;
  for(const [name,knobs,re] of [['wt-qa-none',{},none],
    ['wt-qa-checkpoint',{FAKE_CTX_LANDING:JSON.stringify({lastCheckpoint:{sha:head,recordedAt:'2026-11-02T00:00:00.000Z'}})},none],
    ['wt-qa-malformed',landed(head.slice(0,12)),none],['wt-qa-upper',landed(head.toUpperCase()),none],
    ['wt-qa-unknown',landed('0123456789abcdef0123456789abcdef01234567'),/completion 0123456789abcdef0123456789abcdef01234567 is not a commit/],
    ['wt-qa-git-fail',{...landed(head),WT_GIT_FAIL:'--is-ancestor'},new RegExp(`completion ${head} is not in the control HEAD ${head} `)]]){
    r=await run(p,name,knobs);
    try{why(r,re);}catch(e){e.message=`${name}: ${e.message}`;throw e;}
  }
  // Shared mode: no follow, no gate, no review line.
  git(p.top,'switch','-q','-c','moe/work-2026-11-02');
  r=await run(p,'wt-qa-shared',{});
  assert.ok(r.code===0&&r.cliRan&&!/MOE_CONTROL_/.test(r.log)&&!r.prompt.includes('Review commit '),'shared mode QA changed'+tail(r.log));
}

// task-e3e81c45: each Serena launch runs scripts/moe-serena-ignore.mjs on Serena's root, which hands
// Serena git's own ignore sources with its startup .gitignore walk off. UnAI's shape: big/ (many nested
// .gitignore files) and .serena/ are excluded only in .git/info/exclude, which Serena's walk never reads.
const SERENA_USER="# my own local settings\nread_only: false\n";
// '/.git', project.yml's own ignored_paths, info/exclude, the root .gitignore; then each tree's, breadth-first.
const SERENA_PATS=['/.git','keep-me/','big/','.serena/','.worktrees/','.mcp.json','logs/'];
const serenaBlock=pats=>["# >>> moe serena-ignore (managed by Moe's scripts/moe-serena-ignore.mjs; edits inside are overwritten) >>>",
  "# Serena's own .gitignore walk ignores .git/info/exclude and core.excludesFile, and walks every",
  "# directory they exclude. Moe turns that walk off and lists the same patterns, plus git's, below.",
  '# To opt out, set MOE_SERENA_IGNORE_OVERRIDE=0, or set ignore_all_files_in_gitignore or ignored_paths',
  '# yourself outside this block; Moe then removes this block.','ignore_all_files_in_gitignore: false','ignored_paths:',
  ...pats.map(x=>`  - "${x}"`),'# <<< moe serena-ignore <<<',''].join('\n');
// No real ~/.config/git/ignore or global config reaches the fixture's git (HOME is already the fixture's).
const SERENA_KNOBS={XDG_CONFIG_HOME:path.join(root,'xdg'),GIT_CONFIG_GLOBAL:null};
// Returns the control's .serena/project.local.yml. src/.gitignore is tracked on main and moe/control.
function serenaFixture(p){
  for(let i=0;i<30;i++)write(path.join(p.dir,'big','t'+String(i).padStart(2,'0'),'.gitignore'),`n${i}\n`);
  write(path.join(p.top,'.git','info','exclude'),'# excluded here only\nbig/\n.serena/\n');
  write(path.join(p.dir,'src','.gitignore'),'*.tmp\n');
  git(p.top,'add','--','src/.gitignore');git(p.top,'commit','-qm','src ignore');git(p.top,'update-ref','refs/heads/main','HEAD');
  write(path.join(p.dir,'.serena','project.yml'),"project_name: 'fixture'\nignored_paths:\n  - keep-me/\n");
  const f=path.join(p.dir,'.serena','project.local.yml');write(f,SERENA_USER);
  return f;
}
// The wrapper's MOE_SERENA_IGNORE_* lines, each written or up-to-date file as its comparable path.
const serenaSaid=log=>[...log.matchAll(/^\[(\w+)\] MOE_SERENA_IGNORE_(\w+): (.*?)\r?$/gm)].map(([,tag,code,rest])=>{
  const m=/^(?:wrote (.+) \((\d+) patterns; Serena's \.gitignore walk is off\)|(.+) is up to date \((\d+) patterns\))$/.exec(rest);
  return `${tag} ${code}: `+(m?`${m[1]?'wrote':'up to date'} ${norm(m[1]||m[3])} ${m[2]||m[4]}`:rest);
});
const inode=f=>fs.statSync(f,{bigint:true}).ino;
async function serenaIgnore(){
  const p=repo('serena-ignore'),f=serenaFixture(p),want=SERENA_USER+serenaBlock([...SERENA_PATS,'src/**/*.tmp']);
  const run=async n=>{
    const r=await launch(p,'serena-ignore-'+n,{...SERENA_KNOBS,FAKE_CLAIM_WORKSPACE:null,MOE_SERENA_PATH:process.execPath},{type:'claude'});
    assert.ok(r.cliRan&&r.code===0&&r.blocked.length===0,`run ${n}: exit code ${r.code}, CLI ran: ${r.cliRan}`+tail(r.log));
    return r;
  };
  let r=await run(1);
  assert.equal(readOr(f),want,'run 1: .serena/project.local.yml');
  assert.deepEqual(serenaSaid(r.log),[`OK OVERRIDE: wrote ${norm(f)} 8`],'run 1: the MOE_SERENA_IGNORE_ lines'+tail(r.log));
  const ino=inode(f);
  r=await run(2);
  assert.deepEqual([readOr(f),inode(f)],[want,ino],'run 2 rewrote .serena/project.local.yml');
  assert.deepEqual(serenaSaid(r.log),[`info OVERRIDE: up to date ${norm(f)} 8`],'run 2: the MOE_SERENA_IGNORE_ lines'+tail(r.log));
}
// Fail-open: no Serena, the opt-out, a Serena root outside any repository and one whose .git names a
// missing gitdir each change nothing, and the CLI runs as today.
async function serenaIgnoreOff(){
  const p=repo('serena-ignore-off'),f=serenaFixture(p),record=path.join(root,'serena-ignore-off.jsonl'),cfg=path.join(p.dir,'.moe-agent.json');
  const run=async(n,k)=>{
    const r=await launch(p,'serena-ignore-off-'+n,{...SERENA_KNOBS,FAKE_CLAIM_WORKSPACE:null,WT_CLI_RECORD:record,MOE_SERENA_PATH:process.execPath,...k},{type:'claude'});
    assert.ok(r.cliRan&&r.code===0&&r.blocked.length===0,`${n}: exit code ${r.code}, CLI ran: ${r.cliRan}`+tail(r.log));
    assert.equal(readOr(f),SERENA_USER,`${n}: .serena/project.local.yml changed`);
    return r;
  };
  const exe=['serena','serena.exe','serena.cmd','serena.bat','serena.ps1'];
  const noSerena=String(inherited[pathKey]||'').split(path.delimiter).filter(d=>!d||!exe.some(x=>present(path.join(d,x)))).join(path.delimiter);
  let r=await run('none',{MOE_SERENA_PATH:null,[pathKey]:noSerena});
  const rec=rows(record).pop();
  assert.equal(serenaOf(win?rec.mcpConfig.replace(/^﻿/,''):cfgText(path.join(p.dir,'.mcp.json'))),null,'none: Serena is still configured');
  assert.deepEqual(serenaSaid(r.log),[],'none: a MOE_SERENA_IGNORE_ line without Serena'+tail(r.log));
  r=await run('opt-out',{MOE_SERENA_IGNORE_OVERRIDE:'0'});
  assert.deepEqual(serenaSaid(r.log),['info SKIPPED: MOE_SERENA_IGNORE_OVERRIDE=0; Serena keeps its own .gitignore walk'],'opt-out: the MOE_SERENA_IGNORE_ lines'+tail(r.log));
  const out=fs.mkdtempSync(path.join(os.tmpdir(),'moe-serena-off-'));
  const files=d=>fs.readdirSync(d,{recursive:true}).map(x=>String(x).replace(/\\/g,'/')).sort();
  try{
    for(const [n,dot] of [['plain',null],['broken','gitdir: '+path.join(root,'no such gitdir')+'\n']]){
      const d=path.join(out,n+' serena');write(path.join(d,'.serena','project.yml'),'project_name: x\n');
      if(dot)write(path.join(d,'.git'),dot);
      write(cfg,JSON.stringify({serenaProject:d}));
      const before=files(d);r=await run(n,{});
      assert.deepEqual(files(d),before,`${n}: the Serena root changed`);
      const said=serenaSaid(r.log);
      assert.ok(said.length===1&&/^info SKIPPED: .+ is not (a git work tree|the top level of its git work tree)\b.*; Serena keeps its own \.gitignore walk$/.test(said[0]),
        `${n}: the MOE_SERENA_IGNORE_ lines ${JSON.stringify(said)}`+tail(r.log));
    }
  }finally{fs.rmSync(cfg,{force:true});fs.rmSync(out,{recursive:true,force:true});}
}
// Worktree mode: W gets its own block (the control's extra/ is not in W), after WT-06's project.yml copy.
async function serenaIgnoreWt(){
  const c=wtCase('serena-ignore-wt','claude'),{p}=c,f=serenaFixture(p),wf=path.join(p.W,'.serena','project.local.yml');
  write(path.join(p.dir,'extra','.gitignore'),'*.log\n');
  try{
    const r=await c.run(SERENA_KNOBS),rec=rows(c.record).pop();
    assert.ok(r.code===0&&rec,`exit code ${r.code}, CLI launched: ${!!rec}`+tail(r.log));
    assert.ok(same(serenaOf(claudeCfg(p,rec)),p.W),'Serena is not rooted at W');
    assert.equal(readOr(f),SERENA_USER+serenaBlock([...SERENA_PATS,'extra/**/*.log','src/**/*.tmp']),"the control's .serena/project.local.yml");
    assert.equal(readOr(wf),serenaBlock([...SERENA_PATS,'src/**/*.tmp']),'W/.serena/project.local.yml');
    assert.equal(readOr(path.join(p.W,'.serena','project.yml')),"project_name: 'fixture@task-postflight'\nignored_paths:\n  - keep-me/\n",
      "W/.serena/project.yml lost WT-06's project_name rewrite");
    assert.deepEqual(serenaSaid(r.log),[`OK OVERRIDE: wrote ${norm(f)} 9`,`OK OVERRIDE: wrote ${norm(wf)} 8`],'the MOE_SERENA_IGNORE_ lines'+tail(r.log));
  }finally{for(const l of LINKS)unlinkOnly(path.join(p.W,l));}
}

// DoD: both wrappers carry the same MOE_WORKTREE_/MOE_LAND_/MOE_CONTROL_/MOE_BOARD_/MOE_MIGRATION_/MOE_SERENA_IGNORE_ codes.
function codes(){
  const set=f=>[...new Set(read(path.join(path.dirname(wrapper),f)).match(/MOE_(?:WORKTREE|LAND|CONTROL|BOARD|MIGRATION|SERENA_IGNORE)_[A-Z0-9_]+/g))].sort();
  assert.deepEqual(set('moe-agent.sh'),set('moe-agent.ps1'),'the wrappers carry different worktree code families');
}

const cases={lifecycle,resume,'half-made':halfMade,
  ...Object.fromEntries(refusals.map(c=>[c[0],()=>refusal(...c)])),'shared-landed':sharedLanded,
  'wt-config-lock':wtConfigLock,'wt-config-lock-exhausted':wtConfigLockExhausted,'wt-config-other':wtConfigOther,'wt-config-preset':wtConfigPreset};
Object.assign(cases,{'resume-unread':resumeUnread,'resume-dirty':resumeDirty,'resume-shared-unread':resumeSharedUnread});
for(const t of ['claude','codex','gemini','grok'])cases['launch-'+t]=()=>launchAs(t);
Object.assign(cases,{'config-fail':configFail,tooling,'link-fail':linkFail,'link-partial':linkPartial,'project-yml':projectYml,'serena-outside':serenaOutside,
  'wt-checkpoint':wtCheckpoint,'wt-deny':wtDeny,'wt-recover':wtRecover,'wt-recover-moe':wtRecoverMoe,'wt-control-seats':wtControlSeats,
  'wt-stray':wtStray,'wt-push':wtPush,'wt-completion':wtCompletion,'wt-hooks':wtHooks,'wt-replay':wtReplay,'wt-replay-remote':wtReplayRemote,'wt-sync':wtSync,'wt-fails':wtFails,
  'wt-serena-yml':wtSerenaYml,'serena-ignore':serenaIgnore,'serena-ignore-off':serenaIgnoreOff,'serena-ignore-wt':serenaIgnoreWt,
  'wt-contention':wtContention,'lease-units':leaseUnits,'lease-retry':leaseRetry,'wt-gate':wtGate,'wt-lease-fails':wtLeaseFails,'wt-lease-signal':wtLeaseSignal,
  'wt-unlanded':wtUnlanded,'wt-resume':wtResume,'marker-scan':markerScan,'wt-teardown':wtTeardown,'wt-crash':wtCrash,
  'board-snapshot':boardSnapshot,'board-race':boardRace,'board-push':boardPush,'wt-board':wtBoard,'wt-guard':wtGuard,'wt-follow':wtFollow,'wt-follow-sites':wtFollowSites,'wt-follow-race':wtFollowRace,'wt-qa-gate':wtQaGate,codes});
cases['wt-follow-lock']=wtFollowLock;
const only=process.env.MOE_WORKTREE_ONLY?process.env.MOE_WORKTREE_ONLY.split(',').map(s=>s.trim()).filter(Boolean):null;
(async()=>{
  let ok=0,failed=0;
  for(const n of only||[])if(!(n in cases)){failed++;console.log(`[worktree] ${n} FAILED: Error: no such case`);}
  for(const [name,fn] of Object.entries(cases)){
    if(only&&!only.includes(name))continue;
    if(name==='path-long'&&!winHost){console.log('[worktree] path-long n/a off win32');continue;}
    if(name==='wt-lease-signal'&&win){console.log('[worktree] wt-lease-signal n/a for ps1 (no signal to send on Windows)');continue;}
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
