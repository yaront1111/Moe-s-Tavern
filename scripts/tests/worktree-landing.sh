#!/usr/bin/env bash
# Held-out acceptance cases for worktree completion landing (WT-08T): they pin
# docs/plans/2026-10-30-per-task-worktrees.md §2.2, §2.3, §2.6, §2.7 and §2.9 plus the
# WT-S comments on task-c12f9463. WT-08 must pass the `local` cases and WT-09 the
# `remote` ones, unchanged; WT-09 also registers this file in CI. Until then it is red
# by design and stays out of CI.
#   bash scripts/tests/worktree-landing.sh [--list] [--only local|remote]
# One PASS/FAIL/ERROR <tag> <case> line per case, then a summary. Exit 0: all pass;
# 1: a landing expectation failed; 2: a harness fault, a bad argument or a missing
# prerequisite (git 2.38+). It never skips: unrun must not read as green.
# Seams the cases rely on:
#   S1 MOE_POSTFLIGHT_TEST_HOOK_PRE_UPDATE_REF fires once per landing, after the L8
#      journal and before L9's publication;
#   S2 the receipt journal lives under <git common dir>/moe/receipt/;
#   S3 ps1 fetch and push call bare `git`;
#   S4 the ledger rows: record_commit completion (sha C, ref refs/heads/main, pushed
#      only on remote proof) and finalize_attempt landed with C;
#   S5 the log codes the design names.
# worktree-landing.ps1 runs the node suite between the WTJS markers below.
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WRAPPER="$ROOT_DIR/scripts/moe-agent.sh"
NODE="${MOE_NODE_COMMAND:-$(command -v node || true)}"
if [ -z "$NODE" ]; then echo "ERROR harness: node not found"; exit 2; fi
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/moe-wl-XXXXXX")"
trap 'rm -rf "$TMP_DIR"' EXIT
FAKE_PROXY="$TMP_DIR/fake-proxy.js"
SUITE="$TMP_DIR/suite.cjs"
cp "$ROOT_DIR/scripts/tests/postflight-fake-proxy.js" "$FAKE_PROXY"
cat > "$SUITE" <<'WTJS'
'use strict';
// <suite> <sh|ps1> <wrapper> <fake-proxy> <tmp> <engine> [--list] [--only local|remote]
// runs the cases. `<suite> cli <dir>` is the fake CLI and `<suite> hook <dir>` the
// PRE_UPDATE_REF hook: both act on <dir>/case.json and write <dir>/<mode>-out.json.
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),util=require('node:util'),
  assert=require('node:assert/strict');
const [MODE,WRAPPER,PROXY,ROOT,ENGINE,...FLAGS]=process.argv.slice(2);
const TASK='task-postflight',WID='worker-wt',MAIN='refs/heads/main',BR='refs/heads/moe/task/'+TASK,
  TRACK='refs/remotes/origin/main',win=MODE==='ps1',winHost=process.platform==='win32',SUITE=__filename;
const LIMIT=Number(process.env.MOE_POSTFLIGHT_TIMEOUT_SEC||180)*1000;
const CONFIG=[['user.name','Moe Test'],['user.email','moe@test.local'],['core.autocrlf','false'],
  ['commit.gpgsign','false'],['core.logAllRefUpdates','always']];
// A seat's own MOE_*/CLAUDE* session, fake-proxy knobs and a hook's GIT_* never leak in.
const inherited=Object.fromEntries(Object.entries(process.env).filter(([k])=>!/^(MOE_|CLAUDE|GIT_|FAKE_|BASH_ENV$)/i.test(k)));
const pathKey=Object.keys(inherited).find(k=>k.toUpperCase()==='PATH')||'PATH';
let GIT=null,names={},lastLog='',caseNo=0,shimFault,plainRun;
const read=f=>fs.readFileSync(f,'utf8');
const write=(f,b)=>{fs.mkdirSync(path.dirname(f),{recursive:true});fs.writeFileSync(f,b);};
const present=f=>{try{fs.lstatSync(f);return true;}catch{return false;}};
const readJson=f=>present(f)?JSON.parse(read(f)):null;
const fwd=s=>s.replace(/\\/g,'/');
const shared=(o={})=>Array.from({length:10},(_,i)=>(o[i+1]||'line '+(i+1))+'\n').join('');
const TASK9={'shared.txt':shared({9:'task 9'})},PEER2={'shared.txt':shared({2:'peer 2'})};
// Messages name known commits (B0, C, ...) instead of raw shas.
const nm=o=>{for(const [k,v] of Object.entries(o))if(/^[0-9a-f]{40}$/.test(String(v))&&!names[v])names[v]=k;};
const lbl=s=>s.replace(/[0-9a-f]{40}/g,h=>names[h]||h.slice(0,10));
const eq=(got,want,what)=>assert.deepEqual(got,want,lbl(`${what}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`));

// Harness git, the real binary by absolute path: git() throws a plain Error (a harness
// fault); the probes never throw, so a missing commit is an answer to assert on.
const run=(d,a,o={})=>cp.spawnSync(GIT,['-C',d,...a],{encoding:'utf8',input:o.input,env:{...inherited,GIT_OPTIONAL_LOCKS:'0',...o.env}});
function git(d,...a){
  const o=typeof a[a.length-1]==='object'?a.pop():{},r=run(d,a,o);
  if(r.status!==0)throw new Error(`git ${a.join(' ')}: exit ${r.status} ${r.stderr}`);
  return r.stdout.trim();
}
const rev=(d,ref)=>{const r=run(d,['rev-parse','--verify','--quiet',ref+'^{commit}']);return r.status===0?r.stdout.trim():null;};
const parents=(d,x)=>{const r=run(d,['rev-list','--parents','-n','1',String(x)]);return r.status===0?r.stdout.trim().split(' ').slice(1):null;};
const show=(d,spec)=>{const r=run(d,['show',spec]);return r.status===0?r.stdout:null;};
const isAnc=(d,a,b)=>run(d,['merge-base','--is-ancestor',String(a),String(b)]).status===0;
const reflog=(d,ref)=>git(d,'log','-g','--format=%H',ref).split('\n');
const rescues=c=>git(c.P,'for-each-ref','--format=%(refname)',`refs/moe/rescue/${TASK}/`).split('\n').filter(Boolean);
// The journals (S2), parsed; cases only check that one exists (WT-S comment fbfe90b3).
function journal(P){
  const d=path.join(git(P,'rev-parse','--path-format=absolute','--git-common-dir'),'moe','receipt');
  return present(d)?fs.readdirSync(d).filter(f=>f.endsWith('.json')).map(f=>JSON.parse(read(path.join(d,f)))):[];
}

// P: main holds the seed B0 and the control checkout follows moe/control, which WT-04
// requires of a worktree-mode worker (§6.5). No qualityGate, so no case takes the land
// lease (e07af02f). The .moe runtime is ignored, like .worktrees/ and what wrappers write.
function fixture(remote){
  // The space tests the landing's quoting. TMP stays space-free: PS 5.1 passes the guard's
  // GetTempPath() (a trailing \) as `...tmp"` once it holds a space (bug task-54fe1615).
  const dir=path.join(ROOT,`c${++caseNo} x`),P=path.join(dir,'project'),moe=f=>path.join(P,'.moe',f),tmp=path.join(ROOT,'tmp'+caseNo);
  for(const s of [path.join(dir,'home'),tmp,path.join(dir,'state')])fs.mkdirSync(s,{recursive:true});
  write(path.join(P,'shared.txt'),shared());
  write(path.join(P,'.gitignore'),'/.moe/*\n!/.moe/project.json\n!/.moe/tasks/\n/.worktrees/\n.mcp.json\nlogs/\n');
  write(moe('project.json'),JSON.stringify({id:'proj-wt',name:'worktree-landing',settings:{}}));
  write(moe(`tasks/${TASK}.json`),JSON.stringify({id:TASK,title:'Worktree landing',status:'WORKING'})+'\n');
  git(dir,'init','-q','-b','main',P);
  for(const [k,v] of CONFIG)git(P,'config',k,v);
  git(P,'add','-A');git(P,'commit','-qm','seed');git(P,'switch','-q','-c','moe/control');
  write(moe('daemon.json'),JSON.stringify({port:9876,projectPath:P}));write(moe('messages/chan-general.jsonl'),'');
  const c={dir,P,W:git(P,'rev-parse','--show-toplevel')+'/.worktrees/'+TASK,B0:rev(P,MAIN),O:null,home:path.join(dir,'home'),
    tmp,state:path.join(dir,'state'),fail:path.join(dir,'fail'),glog:path.join(dir,'git.log')};
  nm({B0:c.B0});
  if(remote){
    c.O=path.join(dir,'origin.git');git(dir,'init','-q','--bare','-b','main',c.O);
    git(c.O,'config','receive.denyNonFastForwards','true');git(c.O,'config','core.logAllRefUpdates','always');
    git(P,'remote','add','origin',c.O);git(P,'push','-q','origin','main');git(P,'fetch','-q','origin');
  }
  return c;
}
// A peer's plumbing commit on ref (its tip's tree plus files), so no checkout moves.
function peerCommit(c,ref,files){
  const env={GIT_INDEX_FILE:path.join(c.dir,'peer.index')},old=rev(c.P,ref);
  git(c.P,'read-tree',old,{env});
  for(const [f,b] of Object.entries(files))
    git(c.P,'update-index','--add','--cacheinfo',`100644,${git(c.P,'hash-object','-w','--stdin',{input:b})},${f}`,{env});
  const n=git(c.P,'commit-tree',git(c.P,'write-tree',{env}),'-p',old,'-m','peer commit on '+ref);
  git(c.P,'update-ref',ref,n,old);fs.rmSync(env.GIT_INDEX_FILE,{force:true});
  return n;
}
// Another clone lands on origin with a plain push.
function peerPush(c,files){
  const d=fs.mkdtempSync(path.join(c.dir,'peer'));
  git(c.dir,'clone','-q','-c','core.autocrlf=false','-b','main',c.O,d);
  for(const [k,v] of CONFIG)git(d,'config',k,v);
  for(const [f,b] of Object.entries(files))write(path.join(d,f),b);
  git(d,'commit','-qam','peer push');git(d,'push','-q','origin','main');
  return rev(d,'HEAD');
}
// What a hook (once, between L8 and L9) or the fake CLI (after its edits) does, by name.
// Their git is the real one by absolute path, so the shim never logs or fails it.
const ACTS={
  peer2:c=>({A:peerCommit(c,MAIN,PEER2)}),
  peer9:c=>({A:peerCommit(c,MAIN,{'shared.txt':shared({9:'peer 9'})})}),
  // C without journal field names (fbfe90b3): the one journaled commit whose parents are
  // [main] and that the task branch lacks (L2's T is on it already; C joins it at L11).
  cas:c=>{
    const B=rev(c.P,MAIN),seen=new Set();
    const walk=v=>{if(typeof v==='string'&&/^[0-9a-f]{40}$/.test(v))seen.add(v);else if(v&&typeof v==='object')Object.values(v).forEach(walk);};
    journal(c.P).forEach(walk);
    const Cs=[...seen].filter(s=>rev(c.P,s)===s&&String(parents(c.P,s))===B&&!isAnc(c.P,s,BR));
    assert.equal(Cs.length,1,`before L9 the receipt journal names ${Cs.length} commits off the task branch whose parents are [main]; L8 must journal C`);
    const C=Cs[0];git(c.P,'update-ref',MAIN,C,B);
    const D=git(c.P,'commit-tree',C+'^{tree}','-p',C,'-m','peer commit on C');git(c.P,'update-ref',MAIN,D,C);
    return {C,D};
  },
  // A .moe change committed onto the task branch: W is sparse without .moe, so plumbing.
  board:c=>{const N=peerCommit(c,BR,{[`.moe/tasks/${TASK}.json`]:'{"id":"task-postflight","status":"DONE"}\n'});git(c.W,'reset','-q');return {N};},
  // Seat A of QA's race: it publishes C1 and mirrors it after W was cut; then every fetch fails.
  race:c=>{const C1=peerPush(c,PEER2);git(c.P,'fetch','-q','origin');git(c.P,'update-ref',MAIN,C1,c.B0);write(c.fail,'fetch');return {C1};},
  'peer-push':c=>({P1:peerPush(c,PEER2)}),
  'peer-push-once':c=>{const P1=peerPush(c,PEER2);write(c.fail,'push-once');return {P1};},
};
function act(){
  const dir=process.argv[3],out=path.join(dir,MODE+'-out.json');
  if(MODE==='hook'&&present(out))return;
  const c=JSON.parse(read(path.join(dir,'case.json'))),res={};GIT=c.git;
  try{
    if(MODE==='cli')for(const [f,b] of Object.entries(c.edits))write(path.join(c.W,f),b);
    const name=MODE==='cli'?c.during:c.hook;
    if(name)Object.assign(res,ACTS[name](c));
  }catch(e){Object.assign(res,{error:String(e&&e.message||e),assertion:!!e&&e.code==='ERR_ASSERTION'});}
  write(out,JSON.stringify(res));
}
// The hook's result. One that never fired means no worktree landing reached L8-L9 (S1).
function hookOut(c){
  const h=readJson(path.join(c.dir,'hook-out.json'));
  assert.ok(h,'the PRE_UPDATE_REF hook never fired: no worktree landing reached its L8-L9 seam (S1)');
  if(h.error){if(h.assertion)assert.fail(h.error);throw new Error('hook: '+h.error);}
  nm(h);return h;
}
const cliOut=c=>{const o=readJson(path.join(c.dir,'cli-out.json'))||{};nm(o);return o;};

// The PATH-first git shim of the remote cases. It logs every call; the comma list in
// MOE_TEST_GIT_FAIL_FILE, re-read per call, fails fetch, fetch-after-push, push,
// push-once or push-after-apply (the real push applies, then the client fails).
function shimEnv(c){
  const d=path.join(c.dir,'shim'),p=win?s=>s:fwd;
  if(!present(d)){
    write(path.join(d,'git'),`#!/usr/bin/env bash
real="$MOE_TEST_REAL_GIT" log="$MOE_TEST_GIT_LOG" st="$MOE_TEST_GIT_STATE" sub= pre=() args=("$@")
for ((i = 0; i < \${#args[@]}; i++)); do
  case "\${args[i]}" in -C|-c) pre+=("\${args[i]}" "\${args[i+1]}"); i=$((i + 1)) ;; -*) pre+=("\${args[i]}") ;; *) sub="\${args[i]}"; break ;; esac
done
printf 'call %s %s %s\\n' "$$" "$sub" "$*" >> "$log"
fail=",$(cat "$MOE_TEST_GIT_FAIL_FILE" 2> /dev/null | tr -d ' \\r\\n'),"
die() { printf '%s %s\\n' "$1" "$$" >> "$log"; echo "fatal: moe test shim fails git $sub" >&2; exit 128; }
if [ "$sub" = push ]; then
  : > "$st/pushed"
  case "$fail" in *,push,*) die FAILED ;; esac
  case "$fail" in *,push-once,*) [ -e "$st/push-once" ] || { : > "$st/push-once"; die FAILED; } ;; esac
  case "$fail" in *,push-after-apply,*)
    snap=$("$real" "\${pre[@]}" for-each-ref --format='%(refname) %(objectname)' refs/remotes/)
    "$real" "$@" > /dev/null 2>&1
    "$real" "\${pre[@]}" for-each-ref --format='%(refname)' refs/remotes/ | while read -r r; do "$real" "\${pre[@]}" update-ref -d "$r"; done
    printf '%s\\n' "$snap" | while read -r r s; do [ -z "$r" ] || "$real" "\${pre[@]}" update-ref "$r" "$s"; done
    die APPLIED-FAILED ;;
  esac
elif [ "$sub" = fetch ]; then
  case "$fail" in *,fetch,*) die FAILED ;; esac
  case "$fail" in *,fetch-after-push,*) [ ! -e "$st/pushed" ] || die FAILED ;; esac
fi
exec "$real" "$@"
`);
    fs.chmodSync(path.join(d,'git'),0o755);
    write(path.join(d,'env.sh'),`PATH='${winHost?fwd(d).replace(/^([A-Za-z]):/,(m,x)=>'/'+x.toLowerCase()):d}':"$PATH"\n`);
    // PowerShell 5.1 resolves a PATH-first git.ps1 ahead of git.exe with args intact (a .cmd
    // mangles ^ and %). No [CmdletBinding()]: -C must stay a plain arg.
    write(path.join(d,'git.ps1'),`$ErrorActionPreference = 'Continue'
$real = $env:MOE_TEST_REAL_GIT; $log = $env:MOE_TEST_GIT_LOG; $st = $env:MOE_TEST_GIT_STATE; $sub = ''; $pre = @(); $i = 0
while ($i -lt $args.Count) {
  $a = [string]$args[$i]
  if ($a -ceq '-C' -or $a -ceq '-c') { $pre += $a, [string]$args[$i + 1]; $i += 2 }
  elseif ($a.StartsWith('-')) { $pre += $a; $i++ }
  else { $sub = $a; break }
}
[IO.File]::AppendAllText($log, "call $PID $sub $($args -join ' ')\`n")
$fail = ',' + ((Get-Content -LiteralPath $env:MOE_TEST_GIT_FAIL_FILE -Raw -ErrorAction SilentlyContinue) -replace '\\s', '') + ','
function Stop-Shim($tag) { [IO.File]::AppendAllText($log, "$tag $PID\`n"); [Console]::Error.WriteLine("fatal: moe test shim fails git $sub"); exit 128 }
if ($sub -ceq 'push') {
  [IO.File]::WriteAllText("$st/pushed", '')
  if ($fail.Contains(',push,')) { Stop-Shim 'FAILED' }
  if ($fail.Contains(',push-once,') -and -not (Test-Path -LiteralPath "$st/push-once")) { [IO.File]::WriteAllText("$st/push-once", ''); Stop-Shim 'FAILED' }
  if ($fail.Contains(',push-after-apply,')) {
    $snap = @(& $real @pre for-each-ref '--format=%(refname) %(objectname)' refs/remotes/)
    & $real @args *> $null
    foreach ($r in @(& $real @pre for-each-ref '--format=%(refname)' refs/remotes/)) { & $real @pre update-ref -d $r }
    foreach ($l in $snap) { $r, $s = $l -split ' ', 2; & $real @pre update-ref $r $s }
    Stop-Shim 'APPLIED-FAILED'
  }
} elseif ($sub -ceq 'fetch') {
  if ($fail.Contains(',fetch,') -or ($fail.Contains(',fetch-after-push,') -and (Test-Path -LiteralPath "$st/pushed"))) { Stop-Shim 'FAILED' }
}
if ($MyInvocation.ExpectingInput) { $input | & $real @args } else { & $real @args }
exit $LASTEXITCODE
`);
  }
  const e={[pathKey]:d+path.delimiter+inherited[pathKey],MOE_TEST_REAL_GIT:p(GIT),MOE_TEST_GIT_LOG:p(c.glog),
    MOE_TEST_GIT_FAIL_FILE:p(c.fail),MOE_TEST_GIT_STATE:p(c.state),MOE_LAND_NET_BACKOFF_SEC:'0'};
  // Git Bash's bash.exe puts /mingw64/bin first again; BASH_ENV re-prepends the shim.
  if(!win&&winHost)e.BASH_ENV=path.join(d,'env.sh');
  return e;
}
// Before the first remote case: `git fetch nowhere` through the shim, resolved the way
// the wrapper resolves git, must be intercepted. Otherwise every remote case is an ERROR.
function shimCheck(){
  if(shimFault!==undefined)return shimFault;
  const dir=path.join(ROOT,'shim check'),c={dir,fail:path.join(dir,'fail'),glog:path.join(dir,'git.log'),state:dir};
  write(c.fail,'fetch');
  const o={cwd:dir,env:{...inherited,...shimEnv(c)},encoding:'utf8'};
  const r=win?cp.spawnSync(ENGINE,['-NoProfile','-ExecutionPolicy','Bypass','-Command','git fetch nowhere; exit $LASTEXITCODE'],o)
    :cp.spawnSync(ENGINE,['-c','git fetch nowhere'],o);
  const lg=present(c.glog)?read(c.glog):'';
  return shimFault=r.status===128&&/^FAILED /m.test(lg)?'':
    `git shim self-check failed: exit ${r.status}, log ${JSON.stringify(lg)}, ${String(r.stderr||r.error||'').trim()}`;
}
// Shim log entries: {sub, argv tokens, failed: null|'FAILED'|'APPLIED-FAILED'}.
function gitLog(c){
  const out=[];
  for(const l of (present(c.glog)?read(c.glog):'').split(/\r?\n/)){
    const m=/^call (\d+) (\S*) ?(.*)$/.exec(l),f=/^(FAILED|APPLIED-FAILED) (\d+)$/.exec(l);
    if(m)out.push({pid:m[1],sub:m[2],argv:m[3].split(' '),failed:null});
    else if(f){const e=out.findLast(x=>x.pid===f[2]);if(e)e.failed=f[1];}
  }
  return out;
}
// A wrapper push names a <sha>:refs/heads/main refspec (planner note 2); peers use the real git.
const WP=/^([0-9a-f]{40}):refs\/heads\/main$/;
const pushes=r=>r.git.map((e,i)=>({e,i})).filter(({e})=>e.sub==='push'&&e.argv.some(t=>WP.test(t)))
  .map(({e,i})=>({i,sha:WP.exec(e.argv.find(t=>WP.test(t)))[1],failed:e.failed}));

function killTree(child){
  if(child.exitCode!==null||child.signalCode!==null)return;
  if(winHost)cp.spawnSync('taskkill',['/T','/F','/PID',String(child.pid)],{stdio:'ignore'});
  else{try{process.kill(-child.pid,'SIGKILL');}catch{}}
}
// One worker-seat run of the real wrapper against the fake proxy, in worktree mode.
// Returns this run's log, evidence rows and shim log entries.
async function seat(c,run,o={}){
  const moe=f=>path.join(c.P,'.moe',f),ws=JSON.stringify({mode:'worktree',path:c.W,branch:'moe/task/'+TASK,target:'main'});
  if(!o.keep)for(const f of ['attempts','context-count'])fs.rmSync(moe(f),{recursive:true,force:true});
  for(const f of ['cli-out.json','hook-out.json'])fs.rmSync(path.join(c.dir,f),{force:true});
  write(path.join(c.dir,'case.json'),JSON.stringify({...c,git:GIT,edits:o.edits||{},during:o.during||null,hook:o.hook||null}));
  if(o.fail!==undefined)write(c.fail,o.fail);
  const cli=path.join(c.dir,win?'cli.cmd':'cli.sh');
  write(cli,win?`@echo off\r\n"${process.execPath}" "${SUITE}" cli "${c.dir}"\r\nexit /b %errorlevel%\r\n`
    :`#!/usr/bin/env bash\nexec "${fwd(process.execPath)}" "${fwd(SUITE)}" cli "${fwd(c.dir)}"\n`);
  fs.chmodSync(cli,0o700);
  const args=win?['-NoProfile','-ExecutionPolicy','Bypass','-File',WRAPPER,'-Project',c.P,'-WorkerId',WID,'-Role','worker','-Team','Smoke',
    '-NoStartDaemon','-Command',cli,'-NoLoop','-PollInterval','0']
    :[WRAPPER,'--project',c.P,'--worker-id',WID,'--role','worker','--team','Smoke','--no-start-daemon','--command',cli,'--no-loop','--poll-interval','0'];
  const env={...inherited,MOE_PROXY_PATH:PROXY,MOE_NODE_COMMAND:process.execPath,MOE_DISABLE_HEARTBEAT:'1',MOE_ACCOUNT_ROTATION:'off',
    HOME:c.home,USERPROFILE:c.home,TMPDIR:c.tmp,TMP:c.tmp,TEMP:c.tmp,FAKE_TASK_STATUS:'REVIEW',FAKE_CLAIM_WORKSPACE:ws,FAKE_CTX_WORKSPACE:ws,
    ...(c.O?shimEnv(c):{}),...o.env};
  if(o.hook){
    const h=path.join(c.dir,'hook.cjs');
    write(h,`process.argv.splice(2,0,'hook',__dirname);require(${JSON.stringify(SUITE)});\n`);
    env.MOE_POSTFLIGHT_TEST_HOOK_PRE_UPDATE_REF=`node "${fwd(h)}"`;
  }
  const rowsOf=()=>{const f=moe('evidence-rpcs.jsonl');return present(f)?read(f).split('\n').filter(Boolean).map(l=>JSON.parse(l)):[];};
  const nRows=rowsOf().length,nGit=gitLog(c).length;
  const child=cp.spawn(ENGINE,args,{env,stdio:['ignore','pipe','pipe'],detached:!winHost,windowsHide:true});
  let log='',timedOut=false;child.stdout.on('data',d=>{log+=d;});child.stderr.on('data',d=>{log+=d;});
  const timer=setTimeout(()=>{timedOut=true;killTree(child);},LIMIT);
  await new Promise((res,rej)=>{child.on('error',rej);child.on('close',res);}).finally(()=>clearTimeout(timer));
  lastLog=log=util.stripVTControlCharacters(log);
  assert.ok(!timedOut,`${run}: the wrapper outlived ${LIMIT/1000}s and was killed`);
  const out=readJson(path.join(c.dir,'cli-out.json'));
  if(out&&out.error)throw new Error('fake CLI: '+out.error);
  return {log,rows:rowsOf().slice(nRows),git:gitLog(c).slice(nGit)};
}

// Ledger rows (S4), log codes (S5) and the landing's commit.
const comp=r=>r.rows.filter(x=>x.tool==='record_commit'&&x.args.kind==='completion').map(x=>x.args);
const fin=r=>r.rows.filter(x=>x.tool==='finalize_attempt').map(x=>x.args);
const has=(r,code)=>assert.ok(new RegExp(`\\b${code}\\b`).test(r.log),`the log lacks ${code}`);
const lacks=(r,code)=>assert.ok(!new RegExp(`\\b${code}\\b`).test(r.log),`the log has ${code}`);
function moved(c){const C=rev(c.P,MAIN);assert.notEqual(C,c.B0,'main is still B0: nothing landed');nm({C});return C;}
function published(c){const C=rev(c.O,MAIN);assert.notEqual(C,c.B0,'origin main is still B0: nothing was published');nm({C});return C;}
// One committed completion row for C on main (pushed true when asked) and a landed finalize with C.
function landed(r,C,pushed){
  const rows=comp(r).filter(a=>a.outcome==='committed');
  eq(rows.map(a=>[a.sha,a.ref]),[[C,MAIN]],'committed completion rows [sha, ref]');
  if(pushed)eq(rows[0].pushed,true,'pushed on the completion row');
  eq(fin(r).filter(a=>a.outcome==='landed').map(a=>a.landedRevision),[C],'landed finalize_attempt calls');
}
// Nothing claims a landing (of sha, when given): local, no committed completion row;
// remote, no record_commit with pushed true. The unlanded finalize is WT-11's (e07af02f).
function notLanded(r,{local,sha}={}){
  const mine=a=>!sha||a.sha===sha||a.landedRevision===sha;
  if(local)eq(comp(r).filter(a=>a.outcome==='committed').length,0,'committed completion rows');
  else eq(r.rows.filter(x=>x.tool==='record_commit'&&x.args.pushed===true&&mine(x.args)).length,0,'record_commit rows with pushed: true');
  eq(fin(r).filter(a=>a.outcome==='landed'&&mine(a)).length,0,'landed finalize_attempt calls');
}

// The local cases: P has no remote, so main is the local target B (§2.2 L4).
// One plain landing (the CLI edits line 9), shared by reflog-linear and branch-sync only.
async function plain(){
  plainRun=plainRun||(async()=>{const c=fixture(false);return {c,r:await seat(c,'run',{edits:TASK9})};})();
  const p=await plainRun;nm({B0:p.c.B0});lastLog=p.r.log;return p;
}
// Non-overlapping hunks of one file both land, one linear commit each (§2.2 L5, L7).
async function hunksMerge(){
  const c=fixture(false),r=await seat(c,'run',{edits:TASK9,hook:'peer2'}),{A}=hookOut(c),C2=rev(c.P,MAIN);nm({C2});
  eq(parents(c.P,C2),[A],"main's parents");eq(parents(c.P,A),[c.B0],"A's parents");
  eq(show(c.P,MAIN+':shared.txt'),shared({2:'peer 2',9:'task 9'}),'shared.txt on main');
  eq(git(c.P,'rev-list','--min-parents=2',MAIN),'','merge commits on main');
  landed(r,C2);
}
// Overlapping hunks never land over the conflict; the task's bytes survive (§2.2 L5).
async function conflict(){
  const c=fixture(false),r=await seat(c,'run',{edits:TASK9,hook:'peer9'}),{A}=hookOut(c);
  eq(rev(c.P,MAIN),A,'main');
  eq(git(c.P,'log','--format=%H','-G','task 9',MAIN),'','commits on main carrying the task line');
  assert.ok([BR,...rescues(c)].some(x=>(show(c.P,x+':shared.txt')||'').includes('task 9')),
    "neither the task branch nor a rescue ref keeps the task's line 9");
  has(r,'MOE_COMMIT_FAILED_CONFLICT');notLanded(r,{local:true});
}
async function reflogLinear(){
  const {c,r}=await plain(),C=moved(c);
  eq(reflog(c.P,MAIN),[C,c.B0],"main's reflog");eq(parents(c.P,C),[c.B0],"C's parents");
  eq(git(c.P,'rev-list','--count',MAIN),git(c.P,'rev-list','--first-parent','--count',MAIN),'commits on main vs its first-parent chain');
  landed(r,C);
}
// A lost CAS whose main already contains C is a success, not contention (§2.3).
async function casContainsC(){
  const c=fixture(false),r=await seat(c,'run',{edits:TASK9,hook:'cas'}),{C,D}=hookOut(c);
  eq(rev(c.P,MAIN),D,'main');eq(parents(c.P,D),[C],"D's parents");eq(parents(c.P,C),[c.B0],"C's parents");
  eq(rescues(c),[],'rescue refs');landed(r,C);lacks(r,'MOE_COMMIT_FAILED_REF_CONTENTION');
}
// A crash after L9 but before the task-branch sync: re-landing is a no-op (§2.9).
async function relanding(){
  const c=fixture(false);await seat(c,'run1',{edits:TASK9});
  const C=moved(c),T=rev(c.P,BR),ps=parents(c.P,T)||[];
  eq(ps.length,2,"parents of the synced task-branch tip (L11's T')");
  git(c.P,'update-ref',BR,ps[0],T);
  const n=git(c.P,'rev-list','--count',MAIN),r=await seat(c,'run2');
  eq(rev(c.P,MAIN),C,'main after the re-run');eq(git(c.P,'rev-list','--count',MAIN),n,'commits on main');
  eq(comp(r).filter(a=>a.outcome==='committed').length,0,"run 2's committed completion rows");
  assert.ok(comp(r).some(a=>a.outcome==='nothing'&&a.code==='MOE_COMMIT_NOTHING_TO_COMMIT'),
    'run 2 sent no completion row "nothing" with MOE_COMMIT_NOTHING_TO_COMMIT');
}
// L11: the task branch fast-forwards to C's tree and W is clean on it (§2.2).
async function branchSync(){
  const {c}=await plain(),C=moved(c),T=rev(c.P,BR);nm({T});
  assert.ok(isAnc(c.P,C,T),lbl(`C ${C} is not in the task branch ${T}`));
  eq(git(c.P,'rev-parse',T+'^{tree}'),git(c.P,'rev-parse',C+'^{tree}'),"the task branch tip's tree vs C's");
  const lg=reflog(c.P,BR);
  for(let i=0;i+1<lg.length;i++)assert.ok(isAnc(c.P,lg[i+1],lg[i]),lbl(`the task branch moved ${lg[i+1]} -> ${lg[i]}, not a fast-forward`));
  eq(git(c.W,'status','--porcelain','--untracked-files=all'),'','status of W');eq(git(c.W,'symbolic-ref','HEAD'),BR,"W's HEAD");
}
// A target checked out in any worktree is never moved under it (§2.7).
async function checkedOut(){
  const c=fixture(false),mw=path.join(c.dir,'main-wt');git(c.P,'worktree','add','-q',mw,'main');
  const r=await seat(c,'run',{edits:TASK9});
  eq(rev(c.P,MAIN),c.B0,'main');eq(read(path.join(mw,'shared.txt')),shared(),"main-wt's shared.txt");
  has(r,'MOE_LAND_TARGET_CHECKED_OUT');notLanded(r,{local:true});
}
// A .moe change on the task branch is never published (§2.2 L5b).
async function boardPath(){
  const c=fixture(false),r=await seat(c,'run',{edits:TASK9,during:'board'});
  eq(rev(c.P,MAIN),c.B0,'main');assert.ok(rescues(c).length>0,'no refs/moe/rescue/task-postflight/* ref');
  has(r,'MOE_WORKTREE_BOARD_PATH');notLanded(r,{local:true});
}

// The remote cases: B comes from a fetch of the bare origin, which refuses non-fast-forwards.
function noForce(r){
  eq(r.git.filter(e=>e.sub==='push').flatMap(e=>e.argv).filter(t=>/^(--force(-with-lease(=.*)?|-if-includes)?|-f|--mirror|\+.*)$/.test(t)),
    [],'forcing push arguments');
}
// An unknown outcome parks C on a rescue ref with reason push-unknown (§2.6).
function rescuedUnknown(r,c,C){
  const m=[...r.log.matchAll(/MOE_RESCUE_REF task=\S+ ref=(\S+) sha=([0-9a-f]{40}) reason=push-unknown/g)];
  assert.ok(m.some(x=>x[2]===C&&rev(c.P,x[1])===C),lbl(`no MOE_RESCUE_REF reason=push-unknown line whose ref resolves to C ${C}`));
}
// Push first, mirror after: P main moves only once the remote took C (§2.2 L9, L10).
async function pushFirst(){
  const c=fixture(true),r=await seat(c,'run',{edits:TASK9}),C=published(c);
  eq(rev(c.P,MAIN),C,'P main');eq(parents(c.P,C),[c.B0],"C's parents");eq(reflog(c.P,MAIN),[C,c.B0],"P main's reflog");
  landed(r,C,true);
  const ps=pushes(r),i=ps.length?ps[0].i:-1,j=r.git.findIndex(e=>e.sub==='update-ref'&&e.argv.some((t,k)=>(t===MAIN||t==='main')&&e.argv[k+1]===C));
  assert.ok(i>=0&&j>i,`the first wrapper push (call ${i}) does not precede the update-ref of main to C (call ${j})`);
  noForce(r);
}
// QA's two-seat race [1]: seat A published C1 after W was cut, then every fetch fails, so
// no stale B may be used. A is simulated (one fake task id): "A finalizes landed" is out of reach.
async function race(){
  const c=fixture(true),r=await seat(c,'run',{edits:TASK9,during:'race'}),{C1}=cliOut(c);
  eq([rev(c.O,MAIN),rev(c.P,MAIN),rev(c.P,TRACK)],[C1,C1,C1],'origin main, P main and origin/main');
  assert.ok((show(c.P,BR+':shared.txt')||'').includes('task 9'),"the task branch does not hold the task's line 9");
  has(r,'MOE_LAND_FETCH_FAILED');lacks(r,'MOE_LAND_TARGET_DIVERGED');
  assert.ok(r.git.filter(e=>e.sub==='fetch'&&e.failed).length>=3,'fewer than 3 failed fetches');
  eq(pushes(r).length,0,'wrapper pushes');notLanded(r);
}
// [2], retargeted by planner note 2: unanswered pushes of the same C, 3 in all, end unknown.
async function pushTransport(){
  const c=fixture(true),r=await seat(c,'run',{edits:TASK9,fail:'push'});
  eq([rev(c.O,MAIN),rev(c.P,MAIN),rev(c.P,TRACK)],[c.B0,c.B0,c.B0],'origin main, P main and origin/main');
  const ps=pushes(r);eq(ps.length,3,'wrapper pushes');const C=ps[0].sha;nm({C});
  eq(ps.map(p=>[p.sha,p.failed]),[[C,'FAILED'],[C,'FAILED'],[C,'FAILED']],'wrapper pushes [sha, intercepted]');
  ps.forEach((p,k)=>assert.ok(r.git.slice(p.i+1,k+1<ps.length?ps[k+1].i:undefined).some(e=>e.sub==='fetch'),
    `wrapper push ${k+1} is not followed by a fetch`));
  has(r,'MOE_PUSH_OUTCOME_UNKNOWN');lacks(r,'MOE_PUSH_FAILED');rescuedUnknown(r,c,C);
  assert.ok(journal(c.P).length>0,'no receipt journal kept under <git common dir>/moe/receipt');
  eq([comp(r).length,fin(r).length],[0,0],'completion rows and finalize_attempt calls');
}
// [3]: the remote applied C but the client saw a failure; the reconcile fetch proves it.
async function pushApplied(){
  const c=fixture(true),r=await seat(c,'run',{edits:TASK9,fail:'push-after-apply'}),C=published(c);
  eq(parents(c.P,C),[c.B0],"C's parents");eq(rev(c.P,MAIN),C,'P main');
  landed(r,C,true);lacks(r,'MOE_PUSH_FAILED');lacks(r,'MOE_PUSH_OUTCOME_UNKNOWN');
}
// [4] and 82178003 (c): applied but unprovable, then the next pre-flight's replay settles
// the journaled C itself (§2.6).
async function pushUnknown(){
  const c=fixture(true),r=await seat(c,'run',{edits:TASK9,fail:'push-after-apply,fetch-after-push'}),C=published(c);
  eq([rev(c.P,MAIN),rev(c.P,TRACK)],[c.B0,c.B0],'P main and origin/main (an unknown outcome moves no local ref)');
  has(r,'MOE_PUSH_OUTCOME_UNKNOWN');rescuedUnknown(r,c,C);assert.ok(journal(c.P).length>0,'no receipt journal kept');
  eq([comp(r).length,fin(r).length],[0,0],'completion rows and finalize_attempt calls');
  // The attempt stays finalizing, so the claim refuses and the replay runs (postflight.sh precedent).
  const r2=await seat(c,'replay',{keep:true,fail:'',env:{FAKE_CLAIM_MODE:'finalizing',MOE_TASKLESS_WAIT_SEC:'5'}});
  eq([rev(c.O,MAIN),rev(c.P,MAIN)],[C,C],'origin main and P main after the replay');
  eq(journal(c.P).length,0,'journals left after the replay');
  assert.ok(fin(r2).some(a=>a.outcome==='landed'&&a.landedRevision===C),'the replay did not finalize landed with C');
  assert.ok(comp(r2).some(a=>a.sha===C&&a.outcome==='committed'),'the replay sent no committed completion row for C');
  assert.ok(!comp(r2).some(a=>'pushed' in a),'a replayed completion row carries pushed');
}
// [5]: a peer pushed first, so [rejected] ends the round and the next one lands on P1.
async function pushRejected(){
  const c=fixture(true),r=await seat(c,'run',{edits:TASK9,hook:'peer-push'}),{P1}=hookOut(c),C2=published(c);
  eq(parents(c.O,C2),[P1],"origin main's parents");eq(rev(c.P,MAIN),C2,'P main');
  eq(show(c.O,MAIN+':shared.txt'),shared({2:'peer 2',9:'task 9'}),'shared.txt on origin main');
  eq(reflog(c.O,MAIN),[C2,P1,c.B0],"origin main's reflog");
  landed(r,C2,true);assert.ok(pushes(r).length>=2,'fewer than 2 wrapper pushes');noForce(r);
}
// [6]: a local main holding commits the remote lacks is never published over.
async function diverged(){
  const c=fixture(true),X=peerCommit(c,MAIN,{'local.txt':'local only\n'}),P1=peerPush(c,PEER2);nm({X,P1});
  const r=await seat(c,'run',{edits:TASK9});
  eq([rev(c.O,MAIN),rev(c.P,MAIN)],[P1,X],'origin main and P main');
  has(r,'MOE_LAND_TARGET_DIVERGED');eq(pushes(r).length,0,'wrapper pushes');notLanded(r);
}
// 82178003 (a): an unanswered push with the tip still B re-pushes the SAME C.
async function repush(){
  const c=fixture(true),r=await seat(c,'run',{edits:TASK9,fail:'push-once'}),C=published(c);
  eq(rev(c.P,MAIN),C,'P main');eq(parents(c.O,C),[c.B0],"C's parents");
  eq(git(c.O,'rev-list','--count',c.B0+'..'+MAIN),'1','commits on origin main past B0');
  const ps=pushes(r);eq(ps.map(p=>[p.sha,!!p.failed]),[[C,true],[C,false]],'wrapper pushes [sha, intercepted]');
  assert.ok(r.git.slice(ps[0].i+1,ps[1].i).some(e=>e.sub==='fetch'),'no fetch between the two pushes');
  landed(r,C,true);lacks(r,'MOE_PUSH_FAILED');lacks(r,'MOE_PUSH_OUTCOME_UNKNOWN');noForce(r);
}
// 82178003 (b): [remote rejected] is final: one push, no re-push, no second round.
async function remoteRejected(){
  const c=fixture(true),h=path.join(c.O,'hooks','pre-receive');
  write(h,'#!/bin/sh\necho "moe test: pre-receive refuses every push" >&2\nexit 1\n');fs.chmodSync(h,0o755);
  const r=await seat(c,'run',{edits:TASK9});
  eq([rev(c.O,MAIN),rev(c.P,MAIN),rev(c.P,TRACK)],[c.B0,c.B0,c.B0],'origin main, P main and origin/main');
  eq(pushes(r).length,1,'wrapper pushes (no re-push, no new round)');
  has(r,'MOE_PUSH_FAILED');lacks(r,'MOE_PUSH_OUTCOME_UNKNOWN');notLanded(r);
}
// 82178003 (d): the push of C1 goes unanswered while a peer lands, so C1 can never apply.
// A later round may land a new commit on P1; that is not pinned.
async function peerLands(){
  const c=fixture(true),r=await seat(c,'run',{edits:TASK9,hook:'peer-push-once'}),{P1}=hookOut(c),ps=pushes(r);
  assert.ok(ps.length>0,'no wrapper push');const C1=ps[0].sha,O=rev(c.O,MAIN);nm({C1});
  assert.ok(!isAnc(c.O,C1,O)&&!isAnc(c.P,C1,rev(c.P,MAIN)),'C1 (the unanswered push) reached main');
  assert.ok(isAnc(c.O,P1,O),"the peer's P1 is not in origin main");
  eq(git(c.O,'rev-list','--min-parents=2',c.B0+'..'+MAIN),'','merge commits on origin main');
  has(r,'MOE_PUSH_FAILED');notLanded(r,{sha:C1});noForce(r);
}

const CASES=[
  ['local','hunks-merge',hunksMerge],['local','conflict',conflict],['local','reflog-linear',reflogLinear],
  ['local','cas-contains-c',casContainsC],['local','relanding-idempotent',relanding],['local','branch-sync',branchSync],
  ['local','target-checked-out',checkedOut],['local','board-path',boardPath],
  ['remote','push-first-no-force',pushFirst],['remote','race-fetch-fails',race],['remote','push-transport-fails',pushTransport],
  ['remote','push-applied-client-fails',pushApplied],['remote','push-outcome-unknown',pushUnknown],
  ['remote','push-rejected-retry',pushRejected],['remote','diverged',diverged],['remote','push-unanswered-repush',repush],
  ['remote','push-remote-rejected',remoteRejected],['remote','push-unanswered-peer-lands',peerLands],
];
async function main(){
  if(!['sh','ps1'].includes(MODE)||!ENGINE){
    console.log('ERROR harness: usage: <suite> <sh|ps1> <wrapper> <fake-proxy> <tmp> <engine> [--list] [--only local|remote]');return 2;
  }
  let list=false,only=null;
  for(let i=0;i<FLAGS.length;i++){
    if(FLAGS[i]==='--list')list=true;
    else if(FLAGS[i]==='--only'&&['local','remote'].includes(FLAGS[i+1]))only=FLAGS[++i];
    else{console.log(`ERROR harness: unknown argument ${FLAGS[i]} (use --list and --only local|remote)`);return 2;}
  }
  const sel=CASES.filter(([t])=>!only||t===only);
  if(list){for(const [t,n] of sel)console.log(t+' '+n);return 0;}
  GIT=String(inherited[pathKey]||'').split(path.delimiter).map(d=>d&&path.join(d,winHost?'git.exe':'git')).find(f=>f&&fs.existsSync(f));
  const v=GIT&&/git version (\d+)\.(\d+)/.exec(cp.spawnSync(GIT,['version'],{encoding:'utf8'}).stdout||'');
  if(!v||+v[1]<2||(+v[1]===2&&+v[2]<38)){
    console.log(`ERROR harness: git 2.38 or later is required (merge-tree --write-tree); found ${v?v[0]:'no git on PATH'}`);return 2;
  }
  // The harness git and every wrapper get a scratch HOME: no developer config leaks in or out.
  const home=path.join(ROOT,'home');fs.mkdirSync(home,{recursive:true});
  Object.assign(inherited,{HOME:home,USERPROFILE:home,XDG_CONFIG_HOME:home});
  let p=0,f=0,e=0;
  for(const [tag,name,fn] of sel){
    names={};lastLog='';
    try{
      if(tag==='remote'&&shimCheck())throw new Error(shimFault);
      await fn();p++;console.log(`PASS ${tag} ${name}`);
    }catch(err){
      const msg=String(err&&err.message||err).split('\n'),failed=!!err&&err.code==='ERR_ASSERTION';
      if(failed)f++;else e++;
      console.log(`${failed?'FAIL':'ERROR'} ${tag} ${name}: ${msg[0]}`);
      const more=[...msg.slice(1),...(failed?[]:String(err&&err.stack||'').split('\n').slice(1,4)),...lastLog.trim().split(/\r?\n/).slice(-6)];
      for(const l of more.filter(Boolean))console.log('  | '+l);
    }
  }
  console.log(`worktree-landing: ${p} passed, ${f} failed, ${e} errors`);
  return e?2:f?1:0;
}
if(MODE==='cli'||MODE==='hook')act();
else main().then(code=>{process.exitCode=code;},err=>{console.log('ERROR harness: '+(err&&err.stack||err));process.exitCode=2;});
WTJS
status=0
"$NODE" "$SUITE" sh "$WRAPPER" "$FAKE_PROXY" "$TMP_DIR" "$(command -v bash)" "$@" || status=$?
exit "$status"
