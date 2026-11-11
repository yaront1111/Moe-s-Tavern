param()
$ErrorActionPreference = 'Stop'
# Claude account rotation stays off unless the [accounts] scenario turns it on.
$env:MOE_ACCOUNT_ROTATION = 'off'
# A worktree-mode worker runs this harness from its own task worktree, where WT-13's guard refuses the wrapper
# copy (task-3c4be125); postflight-worktree.cjs re-adds the seam for its own wrapper only, so its refusals stay real.
$env:MOE_POSTFLIGHT_TEST_ALLOW_WORKTREE_WRAPPER = '1'
# A protected launch's marker never reaches the legacy rows; [protected runtime] sets it per row.
Remove-Item Env:MOE_RUNTIME_PROTECTED -ErrorAction SilentlyContinue

$root = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$wrapper = Join-Path $root 'scripts\moe-agent.ps1'
$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('moe-postflight-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $tempRoot | Out-Null
# Background children a scenario spawns as a GENUINE probe target (scenario M2
# needs a real live process id, not a fabricated one). Stopped in the outer
# finally so a failing case cannot leak a ten-minute sleep onto the box.
$script:M2LivePids = @()

try {
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
        Write-Host 'SKIP postflight.ps1: node is not available'
        exit 0
    }

    # The child wrapper runs on the SAME engine as this harness: run the
    # harness under `powershell` to test the wrapper on Windows PowerShell 5.1
    # (the fleet host) and under `pwsh` to test it on 7.x. Both must pass.
    $psExe = if ($PSVersionTable.PSVersion.Major -ge 6) { 'pwsh' } else { 'powershell' }
    Write-Host "postflight.ps1 host=$($PSVersionTable.PSVersion) child=$psExe"

    # Every wrapper invocation runs under a per-invocation timeout: a wrapper
    # that fails to `break` out of its loop, or hangs in a git prompt, must
    # fail the scenario (exit 124) instead of hanging the harness. The default
    # is 60 s — one invocation spawns ~10 node RPC round-trips plus git plus a
    # child PowerShell, and on a loaded box the nominal ~5 s stretches past 30
    # (same slow-spawn pattern as the claudeHook tests). Override with
    # MOE_POSTFLIGHT_TIMEOUT_SEC. stdout and stderr are captured to $OutFile
    # (stderr appended after exit) so string assertions see both streams, as
    # `*>` used to.
    $wrapperTimeoutSec = 60
    if ($env:MOE_POSTFLIGHT_TIMEOUT_SEC -match '^\d+$') { $wrapperTimeoutSec = [int]$env:MOE_POSTFLIGHT_TIMEOUT_SEC }
    function Invoke-WrapperProcess([string[]]$WrapperArgs, [string]$OutFile, [int]$TimeoutSec = 0) {
        if ($TimeoutSec -le 0) { $TimeoutSec = $wrapperTimeoutSec }
        $quoted = @('-NoProfile', '-File', ('"' + $wrapper + '"'))
        foreach ($a in $WrapperArgs) {
            if ($a -match '[\s"]') { $quoted += ('"' + ($a -replace '"', '\"') + '"') } else { $quoted += $a }
        }
        $errFile = "$OutFile.err"
        Remove-Item -LiteralPath $OutFile -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $errFile -Force -ErrorAction SilentlyContinue
        $p = Start-Process -FilePath $psExe -ArgumentList $quoted -RedirectStandardOutput $OutFile -RedirectStandardError $errFile -PassThru -NoNewWindow
        # 5.1 only caches the exit code when the handle was touched before exit.
        $null = $p.Handle
        if (-not $p.WaitForExit($TimeoutSec * 1000)) {
            try { & taskkill /T /F /PID $p.Id 2>&1 | Out-Null } catch {}
            $p.WaitForExit(5000) | Out-Null
            Add-Content -Path $OutFile -Value "HARNESS: wrapper killed after ${TimeoutSec}s timeout"
            return 124
        }
        $code = $p.ExitCode
        if (Test-Path -LiteralPath $errFile) {
            Get-Content -LiteralPath $errFile -ErrorAction SilentlyContinue | Add-Content -Path $OutFile
            Remove-Item -LiteralPath $errFile -Force -ErrorAction SilentlyContinue
        }
        return $code
    }

    $conflictOut = Join-Path $tempRoot 'conflict.out'
    # Windows PowerShell 5.1 wraps a child's stderr lines into ErrorRecords
    # when redirected, which $ErrorActionPreference='Stop' escalates to a
    # throw even though the child exited as expected. Relax EAP around child
    # invocations; exit codes are checked explicitly.
    $prevEap = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $conflictCode = Invoke-WrapperProcess @('-Loop', '-NoLoop') $conflictOut
    $ErrorActionPreference = $prevEap
    if ($conflictCode -ne 2) {
        Get-Content $conflictOut -ErrorAction SilentlyContinue | Write-Error
        throw "Expected -Loop -NoLoop to exit 2; got $conflictCode"
    }

    $projectDir = Join-Path $tempRoot 'project'
    $homeDir = Join-Path $tempRoot 'home'
    New-Item -ItemType Directory -Force -Path (Join-Path $projectDir '.moe\messages') | Out-Null
    New-Item -ItemType Directory -Force -Path $homeDir | Out-Null
    Set-Content -Path (Join-Path $projectDir '.moe\project.json') -Value '{"id":"proj-smoke","name":"postflight-smoke","settings":{"autoCommit":false}}' -Encoding UTF8
    Set-Content -Path (Join-Path $projectDir '.moe\messages\chan-general.jsonl') -Value '' -Encoding UTF8

    # The fake daemon+proxy both postflight harnesses share (knobs at its
    # handlers). Copy-Item keeps its bytes, so Windows PowerShell 5.1 adds no BOM.
    $fakeProxy = Join-Path $tempRoot 'fake-proxy.js'
    Copy-Item -LiteralPath (Join-Path $root 'scripts\tests\postflight-fake-proxy.js') -Destination $fakeProxy -ErrorAction Stop

    $frozenSuite = Join-Path $tempRoot 'frozen-candidate.cjs'
    [IO.File]::WriteAllText($frozenSuite, @'

const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),cp=require('node:child_process'),assert=require('node:assert/strict');
const [platform,wrapper,proxy,parent,engine]=process.argv.slice(2),win=platform==='ps1';
const root=fs.mkdtempSync(path.join(parent,'frozen gate é '));
// The loop supervisor hard-kills its wrapper, so that wrapper's own exit cleanup
// never runs: point its temp files (sh SECURE_TEMP_DIR, ps1 MCP config and system
// prompt) at a dir this suite owns and deletes, never the shared %TEMP%.
const wrapperTmp=fs.mkdtempSync(path.join(os.tmpdir(),'moe-frozen-wrapper-'));
const read=f=>fs.readFileSync(f,'utf8');
const write=(f,b)=>{fs.mkdirSync(path.dirname(f),{recursive:true});fs.writeFileSync(f,b);};
const rows=f=>fs.existsSync(f)?read(f).trim().split('\n').filter(Boolean).map(JSON.parse):[];
function git(d,...a){const r=cp.spawnSync('git',['-C',d,...a],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);return r.stdout.trim();}
const modes=['dirty-helper','pass','race-fail','race-pass','shared-mutation','tracked-mutation','exit-tail',
'record_candidate-refuse','record_candidate-null','record_candidate-malformed',
'record_check_run-refuse','record_check_run-null','record_check_run-malformed',
'finalize-loss-once','finalize-loss','no-change','disabled','deferred','gate-blank','gate-padded','manual','no-git','sha256-repo','missing-attempt','stale-attempt','workspace-failure','claim-missing','claim-malformed','closed-attempt',
'loop-land-twice',
'nogate-qa-claimed','gate-qa-claimed','checkpoint-reconciling','checkpoint-unpinned','manual-reconciling','manual-unpinned',
'freed-closed','freed-generation-bump','freed-corrupt-sibling','finalizing-acked-continues','unborn','cleanup-retry','hidden-mutation','skip-worktree-mutation','index-mutation','head-mutation',
'receipt-replay','receipt-cached-check','receipt-same-tree-race','receipt-push','receipt-push-failed','receipt-refused','receipt-conflict',
'receipt-ledger-replay','receipt-rebase-replay','receipt-push-rejected','receipt-foreign-replay',
'intent-strong','intent-strong-cas','intent-strong-unwritable','intent-strong-nocandidate','intent-legacy-unwritable',
'reconcile-strong-receipt-lost','reconcile-strong-unreconciled','reconcile-strong-target-moved','reconcile-strong-rewrite','reconcile-strong-rewrite-same-tree','reconcile-strong-no-rebase',
'reconcile-strong-finalize-lost','reconcile-strong-replay-running','reconcile-strong-conflict-finalize-lost','strong-checkpoint-held','strong-checkpoint-held-env','strong-checkpoint-held-forged','strong-checkpoint-held-journal',
'strong-recovery-held','strong-recovery-held-gate',
'identity-claim','reattach-sidecar','reattach-refused','reattach-postflight','reattach-preflight','reattach-none','reattach-session',
...(win?['integrity-batch']:[]),'interrupt-int',...(win?[]:['interrupt-term']),
'teardown-finalizing','teardown-manual','teardown-no-git','teardown-sha256','teardown-no-baseline','teardown-recovered','teardown-scope','teardown-landed','teardown-nothing','teardown-running','teardown-protected',
'wt-pass','wt-default','wt-moe-dir','wt-moe-file','wt-moe-link','wt-moe-link-out','wt-before','wt-tracked','wt-hidden','wt-assume','wt-nested'];
// Loop modes run --loop: the fake daemon answers the second claim idle, and the
// supervisor stops the wrapper as soon as that claim is seen. freed-* is a
// seat-freeing report_blocked (the task exits BLOCKED): whatever became of the
// pinned attempt -- closed in place by the hand-back, rewritten to a generation
// the seat never pinned, or left running beside a corrupt sibling record --
// nothing is acknowledged and the seat keeps claiming. finalizing-acked-continues
// is the control: one acknowledged finalizing attempt does not stop the loop.
// identity-claim and reattach-refused finalize too: their second claim proves
// the runner identity is one pair per wrapper and a refused reattach stops nothing.
// gate-blank lands under a whitespace-only qualityGate, which is no gate at all,
// so its loop goes on as after any ungated landing.
const loopModes=['nogate-qa-claimed','gate-qa-claimed','checkpoint-reconciling','checkpoint-unpinned','manual-reconciling','manual-unpinned',
  'freed-closed','freed-generation-bump','freed-corrupt-sibling','finalizing-acked-continues','identity-claim','reattach-refused','gate-blank'];
const identityModes=['missing-attempt','stale-attempt','claim-missing','claim-malformed','closed-attempt','gate-qa-claimed'];
// Teardown modes interrupt the wrapper once complete_task has left the attempt
// finalizing: mid-CLI, in the post-flight landing before it reached any outcome
// (teardown-scope), or once it reached one (a branch CAS, or nothing to commit)
// but before its ledger row got out. That exit must acknowledge the attempt
// exactly once, before deregister_worker, with what it actually did to the bytes.
// teardown-running is the control: its attempt is still `running` (no
// complete_task), so the very same exit path must acknowledge NOTHING.
// teardown-protected: that exit on a task another worker owns refuses instead.
const teardownOutcome={'teardown-finalizing':'rescued','teardown-manual':'nothing-to-commit','teardown-no-git':'nothing-to-commit','teardown-sha256':'nothing-to-commit',
  'teardown-no-baseline':'failed','teardown-recovered':'rescued','teardown-scope':'rescued','teardown-landed':'landed',
  'teardown-nothing':'nothing-to-commit','teardown-running':'','teardown-protected':''};
const teardownRescued=['teardown-finalizing','teardown-recovered','teardown-scope','teardown-running'];
const noFinal=['missing-attempt','stale-attempt','claim-missing','claim-malformed','closed-attempt',
  ...loopModes.filter(m=>!['finalizing-acked-continues','identity-claim','reattach-refused','gate-blank'].includes(m))];
const EMPTY_TREE='4b825dc642cb6eb9a060e54bf8d69288fbee4904',ZERO_OID='0'.repeat(40);
// Hard-kills its wrapper's whole tree (no trap, no graceful exit) once MARKER
// exists, or after LIMIT ms: the loop modes' stop and receipt-replay's crash.
const KILL_ON_MARKER=`
const cp=require('child_process'),fs=require('fs');
const [marker,limit,engine,...args]=process.argv.slice(2);
const child=cp.spawn(engine,args,{stdio:'inherit',detached:process.platform!=='win32',windowsHide:true});
let stopped=false;
const stop=()=>{if(stopped)return;stopped=true;
  if(process.platform==='win32')cp.spawnSync('taskkill',['/T','/F','/PID',String(child.pid)],{stdio:'ignore'});
  else{try{process.kill(-child.pid,'SIGKILL');}catch(e){}}};
const poll=setInterval(()=>{if(fs.existsSync(marker))stop();},100);
const deadline=setTimeout(stop,Number(limit));
child.on('exit',(code,signal)=>{clearInterval(poll);clearTimeout(deadline);
  console.log('[supervisor] marker='+fs.existsSync(marker)+' exit='+code+' signal='+signal);process.exit(0);});
`;
// An interrupted wrapper still has to stop the gate, park a rescue ref,
// acknowledge the attempt and deregister -- several node spawns on a loaded
// box -- so the Windows cancellation bound tracks MOE_POSTFLIGHT_TIMEOUT_SEC
// rather than a fixed 30 s. The outer spawnSync timeout is still the real cap.
const CANCEL_MS=Math.max(30000,(Number(process.env.MOE_POSTFLIGHT_TIMEOUT_SEC||180)-30)*1000);
// WT-10G: the worktree-mode frozen gate (sh run_frozen_gate worktree, ps1
// Invoke-MoeFrozenGate -WorktreeMode; WT-S 2.2 L6) is not wired into landing
// until WT-10, so the wt-* modes drive the wrapper's real gate functions
// directly: sh slices them out by name, ps1 imports every function through the
// AST. Only the check-run recorder is stubbed. TMPDIR/TMP/TEMP point at a
// per-mode dir this suite owns, so every gate root is owned scratch. The drivers
// read the stored index bits: git otherwise hides S on files a .moe link makes present.
const WT_GATE=`
const fs=require('fs'),path=require('path'),cp=require('child_process');
const get=(...a)=>cp.execFileSync('git',a,{encoding:'utf8'}).trim(),real=p=>fs.realpathSync.native(p);
let moe=true;try{fs.lstatSync('.moe');}catch(e){moe=false;}
fs.writeFileSync(process.env.WTG_OBS,JSON.stringify({dirs:[process.cwd(),process.env.MOE_PROJECT_PATH,get('rev-parse','--show-toplevel')].map(real),
 parent:real('..'),head:get('rev-parse','HEAD'),tree:get('write-tree'),moe,flags:get('ls-files','-t','--','.moe')}));
const mode=process.env.WTG_MODE,link=t=>fs.symlinkSync(t,'.moe',process.platform==='win32'?'junction':'dir');
if(mode==='wt-moe-dir'){fs.mkdirSync('.moe');fs.writeFileSync(path.join('.moe','x'),'gate\\n');}
if(mode==='wt-moe-file')fs.writeFileSync('.moe','gate\\n');
if(mode==='wt-moe-link')link(path.resolve('..','missing-target'));
if(mode==='wt-moe-link-out')link(process.env.WTG_CONTROL_MOE);
if(mode==='wt-tracked')fs.writeFileSync('src.txt','gate changed\\n');
if(mode==='wt-hidden'){get('update-index','--skip-worktree','src.txt');fs.unlinkSync('src.txt');}
if(mode==='wt-assume'){get('update-index','--assume-unchanged','src.txt');fs.writeFileSync('src.txt','hidden gate change\\n');}
`;
const WT_SH_FUNCS=['gate_git','gate_integrity','gate_integrity_wt','stop_gate_child','remove_gate_root','cleanup_gate_workspace','freeze_candidate','run_frozen_gate'];
function shFunctions(){const s=read(wrapper);return WT_SH_FUNCS.map(name=>{const i=s.indexOf('\n'+name+'() {');
  assert.ok(i>=0,'moe-agent.sh has no '+name);return s.slice(i+1,s.indexOf('\n}\n',i)+3);}).join('');}
const WT_SH=`set -e
record_candidate_rpc() { return 0; }
record_check_run_rpc() { printf '%s\\t%s\\n' "$GATE_RC" "$GATE_OUTCOME" >> "$WTG_CHECKS"; }
GREEN= BLUE= NC= YELLOW= GATE_PENDING_ROOTS= GATE_OUTCOME= GATE_WORKSPACE= flags=
PYTHON_CMD=$(command -v python3 || command -v python)
MOE_TOP=$WTG_REPO MOE_REL=$WTG_REL QUALITY_GATE='node gate.cjs'
freeze_candidate "$WTG_BASE" "$WTG_TREE"
if run_frozen_gate $WTG_ARM; then rc=0; else rc=1; fi
if [ -n "$GATE_WORKSPACE" ] && [ -d "$GATE_WORKSPACE" ]; then flags=$(git -C "$GATE_WORKSPACE" -c sparse.expectFilesOutsideOfPatterns=true ls-files -t -- .moe src.txt); fi
if cleanup_gate_workspace; then clean=0; else clean=1; fi
printf 'rc=%s\\nclean=%s\\ncommit=%s\\nflags=%s\\n' "$rc" "$clean" "$FROZEN_COMMIT" "$flags" > "$WTG_RESULT"
`;
// ASCII only: Windows PowerShell 5.1 reads a BOM-less script as ANSI.
const WT_PS1=`$ErrorActionPreference='Stop'
$errors=$null
$ast=[System.Management.Automation.Language.Parser]::ParseFile($env:WTG_WRAPPER,[ref]$null,[ref]$errors)
if ($errors.Count) { throw ('moe-agent.ps1 parse errors: '+($errors -join '; ')) }
foreach ($fn in $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] },$false)) { . ([ScriptBlock]::Create($fn.Extent.Text)) }
foreach ($st in $ast.EndBlock.Statements) {
  if ($st -is [System.Management.Automation.Language.AssignmentStatementAst] -and $st.Left.Extent.Text -like '$script:MoeGate*') { . ([ScriptBlock]::Create($st.Extent.Text)) }
}
function Send-MoeCheckRun([hashtable]$Frozen,[hashtable]$Gate) {
  [IO.File]::AppendAllText($env:WTG_CHECKS,[string]$Gate.ExitCode+[char]9+[string]$Gate.Outcome+[char]10)
  return $true
}
$git=@{ Top=$env:WTG_REPO; Rel=$env:WTG_REL }
$frozen=New-MoeFrozenCandidate $git $env:WTG_TREE $env:WTG_BASE
if ($env:WTG_ARM) { $ok=@(Invoke-MoeFrozenGate $git $frozen 'node gate.cjs' -WorktreeMode)[-1] }
else { $ok=@(Invoke-MoeFrozenGate $git $frozen 'node gate.cjs')[-1] }
$flags=''
if ($script:MoeGate -and (Test-Path -LiteralPath $script:MoeGate.Workspace)) {
  $flags=(Invoke-MoeGit -Top $script:MoeGate.Workspace -GitArgs @('-c','sparse.expectFilesOutsideOfPatterns=true','ls-files','-t','--','.moe','src.txt')).Out -join [char]10
}
$clean=Remove-MoeGateWorkspace
$rc=if ($ok -eq $true) { '0' } else { '1' }
$cl=if ($clean) { '0' } else { '1' }
[IO.File]::WriteAllText($env:WTG_RESULT,(@(('rc='+$rc),('clean='+$cl),('commit='+$frozen.Commit),('flags='+$flags)) -join [char]10)+[char]10)
`;
function wtGate(mode){
  const repo=path.join(root,mode),tmp=path.join(root,mode+'-tmp'),home=path.join(root,mode+'-home'),moeDir=path.join(repo,'.moe');
  const obsFile=path.join(root,mode+'-obs.json'),checksFile=path.join(root,mode+'-checks.txt'),resultFile=path.join(root,mode+'-result.txt');
  for(const d of [repo,tmp,home])fs.mkdirSync(d,{recursive:true});
  git(repo,'init','-q');
  for(const [key,value] of [['core.autocrlf','false'],['user.name','Moe Test'],['user.email','moe@test.local']])git(repo,'config',key,value);
  // '!/.moe/' excludes only a directory: a tracked FILE named .moe materializes,
  // and the before-command check must refuse it.
  if(mode==='wt-before')write(moeDir,'tracked file\n');
  else{write(path.join(moeDir,'tasks','task-a.json'),'{"id":"task-a"}\n');write(path.join(moeDir,'project.json'),'{"id":"proj-wt"}\n');}
  write(path.join(repo,'src.txt'),'source\n');write(path.join(repo,'gate.cjs'),WT_GATE);
  // A nested tracked path outside .moe: the sparse patterns must materialize it.
  write(path.join(repo,'lib','keep.txt'),'nested\n');
  git(repo,'add','--','.');git(repo,'commit','-qm','seed');
  if(mode!=='wt-before')write(path.join(moeDir,'daemon.json'),'{"sentinel":"control runtime"}\n');
  const map=p=>{let st;try{st=fs.lstatSync(p);}catch(e){return null;}
    if(st.isSymbolicLink())return 'link:'+fs.readlinkSync(p);
    if(!st.isDirectory())return read(p);
    const o={};for(const n of fs.readdirSync(p).sort())o[n]=map(path.join(p,n));return o;};
  const snap=()=>[git(repo,'rev-parse','HEAD'),git(repo,'ls-files','-s'),git(repo,'--no-optional-locks','status','--porcelain','-uall'),
    cp.spawnSync('git',['-C',repo,'config','--get','core.sparseCheckout']).status,map(moeDir)];
  const pre=snap(),env={};
  for(const [key,value] of Object.entries(process.env))if(!/^GIT_|^(HOME|USERPROFILE|TMPDIR|TMP|TEMP)$/i.test(key))env[key]=value;
  Object.assign(env,{HOME:home,USERPROFILE:home,TMPDIR:tmp,TMP:tmp,TEMP:tmp,WTG_WRAPPER:wrapper,WTG_REPO:repo,WTG_MODE:mode,
    WTG_BASE:git(repo,'rev-parse','HEAD'),WTG_TREE:git(repo,'rev-parse','HEAD^{tree}'),WTG_OBS:obsFile,WTG_CHECKS:checksFile,WTG_RESULT:resultFile,WTG_CONTROL_MOE:moeDir});
  if(mode!=='wt-default')env.WTG_ARM='worktree';
  if(mode==='wt-nested')env.WTG_REL='sub';
  const driver=path.join(root,win?'wt-driver.ps1':'wt-driver.sh');
  if(!fs.existsSync(driver))write(driver,win?WT_PS1:shFunctions()+WT_SH);
  const r=cp.spawnSync(engine,win?['-NoProfile','-File',driver]:[driver],{env,encoding:'utf8',timeout:120000,windowsHide:true});
  const log=String(r.stdout||'')+String(r.stderr||'')+(r.error?'\n'+r.error:'');
  assert.equal(r.status,0,mode+': driver failed\n'+log);
  const res=read(resultFile),field=key=>(res.match(new RegExp('^'+key+'=(.*)$','m'))||[])[1];
  const flags=res.slice(res.indexOf('flags=')+6).trim(),checks=fs.existsSync(checksFile)?read(checksFile).split('\n').filter(Boolean):[];
  const obs=fs.existsSync(obsFile)?JSON.parse(read(obsFile)):null,integrity=log.includes('MOE_WORKTREE_GATE_INTEGRITY');
  const moeFlags='S .moe/project.json\nS .moe/tasks/task-a.json';
  assert.equal(field('clean'),'0',mode+': owned cleanup\n'+log);
  assert.deepEqual(fs.readdirSync(tmp),[],mode+': owned gate scratch must be emptied\n'+log);
  assert.equal(git(repo,'worktree','list','--porcelain').split('\n').filter(l=>l.startsWith('worktree ')).length,1,mode+'\n'+log);
  assert.deepEqual(snap(),pre,mode+': the control checkout, its index and its .moe stay unchanged\n'+log);
  if(obs){
    assert.deepEqual(obs.dirs.map(d=>[path.basename(d),path.dirname(d)]),Array(3).fill(['tree',obs.parent]),mode+': cwd, MOE_PROJECT_PATH and toplevel are the gate checkout\n'+log);
    assert.equal(path.dirname(obs.parent),fs.realpathSync.native(tmp),mode+': the gate root is owned scratch\n'+log);
    assert.equal(fs.existsSync(obs.parent),false,mode+': the gate root is removed\n'+log);
    assert.deepEqual([obs.head,obs.tree],[field('commit'),git(repo,'rev-parse','HEAD^{tree}')],mode+': the gate saw the frozen commit and tree\n'+log);
  }
  if(mode==='wt-pass'||mode==='wt-default'){
    assert.equal(field('rc'),'0',log);assert.deepEqual(checks,['0\tpassed'],log);assert.equal(integrity,false,log);
    assert.equal(obs.moe,mode==='wt-default',mode+': .moe in the gate checkout\n'+log);
    assert.equal(obs.flags,mode==='wt-default'?moeFlags.replace(/^S/gm,'H'):moeFlags,mode+': .moe index entries\n'+log);
  }else if(mode==='wt-before'||mode==='wt-nested'){
    assert.equal(field('rc'),'1',log);assert.deepEqual(checks,[],log);assert.equal(obs,null,log);
    assert.equal(integrity,mode==='wt-before',log);
    if(mode==='wt-nested')assert.ok(log.includes('MOE_WORKTREE_PROJECT_NOT_TOP'),log);
  }else{
    assert.equal(field('rc'),'1',log);assert.deepEqual(checks,['0\tinconclusive'],log);
    assert.equal(integrity,mode.startsWith('wt-moe-'),log);assert.equal(obs.moe,false,log);
    assert.equal(flags,moeFlags+'\nH src.txt',mode+': index flags after the refusal\n'+log);
  }
}
let count=0;
try {
if(!win){const source=read(wrapper),stop=source.slice(source.indexOf('stop_gate_child() {'),source.indexOf('cleanup_gate_workspace() {'));
  assert.ok(stop.indexOf('kill -KILL')>=0&&stop.indexOf('kill -KILL')<stop.indexOf('if wait "$GATE_PID"'),'explicit shutdown cannot wait forever on TERM-ignoring children');}
for(const mode of modes.filter(m=>!process.env.MOE_FROZEN_TEST_ONLY||process.env.MOE_FROZEN_TEST_ONLY.split(',').includes(m))){
  console.log('[frozen candidate] '+mode);
  if(mode==='integrity-batch'){
    const source=read(wrapper),probe=source.slice(source.indexOf('function Test-MoeGateIntegrity'),source.indexOf('function Stop-MoeGateChild'));
    assert.ok(probe.length>0&&probe.includes('--stdin')&&!/foreach/i.test(probe),'ps1 integrity probe must batch ls-files into one update-index --stdin, not spawn git per tracked file');
    count++;continue;
  }
  if(mode.startsWith('wt-')){wtGate(mode);count++;continue;}
  const repo=path.join(root,mode),nested=path.join(repo,'nested project é'),owned=path.join(nested,'owned.txt');
  fs.mkdirSync(nested,{recursive:true});
  const gateSource=`
const fs=require('fs'),cp=require('child_process'),path=require('path');
const dir=process.env.FROZEN_FIXTURE,mode=process.env.FROZEN_MODE;
const get=(...a)=>cp.execFileSync('git',a,{encoding:'utf8'}).trim();
const persisted=fs.existsSync(path.join(dir,'.moe','candidates'))?
 fs.readdirSync(path.join(dir,'.moe','candidates')).map(f=>JSON.parse(fs.readFileSync(path.join(dir,'.moe','candidates',f),'utf8'))):[];
const observation={persisted,pid:process.pid,cwd:process.cwd(),project:process.env.MOE_PROJECT_PATH,tree:get('rev-parse','HEAD^{tree}'),
 helper:fs.existsSync('helper.txt'),peer:fs.existsSync('peer.txt'),denied:fs.existsSync('.codex/dirty.txt'),owned:fs.readFileSync('owned.txt','utf8')};
if(mode.startsWith('interrupt-'))observation.childPid=cp.spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}).pid;
observation.recordedAt=new Date().toISOString();
fs.appendFileSync(path.join(dir,'.moe','gate-observations.jsonl'),JSON.stringify(observation)+'\\n');
if(mode==='shared-mutation')fs.writeFileSync(path.join(dir,'owned.txt'),'late shared\\n');
fs.writeFileSync('scratch.txt','generated only\\n');
if(mode==='tracked-mutation')fs.writeFileSync('owned.txt','gate changed tracked\\n');
if(mode==='hidden-mutation'){get('update-index','--skip-worktree','owned.txt');get('update-index','--assume-unchanged','gate.cjs');
 fs.writeFileSync('owned.txt','hidden gate change\\n');fs.appendFileSync('gate.cjs','\\n// hidden gate change\\n');}
// Skip-worktree only, no assume-unchanged: an edit and a deletion hidden behind S bits.
if(mode==='skip-worktree-mutation'){get('update-index','--skip-worktree','owned.txt');fs.writeFileSync('owned.txt','hidden gate change\\n');
 get('update-index','--skip-worktree','../seed.txt');fs.unlinkSync('../seed.txt');}
if(mode==='index-mutation'){fs.writeFileSync('staged.txt','gate staged\\n');get('add','staged.txt');}
if(mode==='head-mutation')get('-c','user.name=t','-c','user.email=t@t.test','commit','--allow-empty','-qm','gate moved HEAD');
if(mode==='cleanup-retry')get('worktree','lock','--reason','moe frozen cleanup retry',get('rev-parse','--show-toplevel'));
if(mode==='dirty-helper'&&!fs.existsSync('helper.txt'))process.exit(19);
if(mode==='race-fail'&&fs.existsSync('../break-gate.txt'))process.exit(23);
if(mode==='strong-recovery-held-gate')process.exit(29);
if(mode.startsWith('interrupt-')){fs.writeFileSync(path.join(dir,'owned.txt'),'late shared\\n');fs.writeFileSync(path.join(dir,'.moe','gate-ready'),'ready');setInterval(()=>{},1000);}
if(mode==='exit-tail'){process.stdout.write('é😀'.repeat(5000)+'TAIL');process.stderr.write('END');process.exit(37);}
`;
  write(path.join(nested,'gate.cjs'),gateSource);write(owned,'base\n');write(path.join(repo,'seed.txt'),'seed\n');
  const settings={qualityGate:'node gate.cjs',qualityGateScope:'everyTask',commitBoardState:false,attribution:{undeclared:'never'}};
  if(mode==='disabled'||mode==='nogate-qa-claimed'||mode==='intent-strong-nocandidate')settings.qualityGate='';
  if(mode==='deferred')settings.qualityGateScope='epicFinal';
  // Padding is not part of the command: '   ' is no gate, and a padded one runs trimmed.
  if(mode==='gate-blank')settings.qualityGate='   ';
  if(mode==='gate-padded')settings.qualityGate='  node gate.cjs  ';
  if(mode==='manual'||mode.startsWith('manual-')||mode==='teardown-manual')settings.autoCommit=false;
  const ownedPaths=mode==='unborn'?['owned.txt','gate.cjs']:['owned.txt'];
  write(path.join(nested,'.moe','project.json'),JSON.stringify({id:'proj-frozen',name:'Frozen',settings}));
  write(path.join(nested,'.moe','tasks','task-postflight.json'),JSON.stringify({id:'task-postflight',title:'Frozen',
    status:'WORKING',filesModified:ownedPaths,implementationPlan:[{stepId:'s1',status:'COMPLETED',modifiedFiles:ownedPaths}]}));
  const noGit=mode==='no-git'||mode==='teardown-no-git',sha256=mode==='sha256-repo'||mode==='teardown-sha256';let seeded='';
  if(!noGit){
    // A sha256 repository: both wrappers refuse it at their git probe, because
    // Moe's delivery records hold SHA-1 ids only. Creating one needs git 2.29+.
    if(!sha256)git(repo,'init','-q');
    else if(cp.spawnSync('git',['-C',repo,'init','-q','--object-format=sha256']).status!==0){
      console.log('[frozen candidate] '+mode+' skipped: this git cannot create a sha256 repository (git init --object-format=sha256 needs git 2.29+)');continue;}
    git(repo,'config','core.autocrlf','false');git(repo,'config','user.name','Moe Test');git(repo,'config','user.email','moe@test.local');
    if(mode==='unborn')git(repo,'symbolic-ref','HEAD','refs/heads/moe/frozen');
    else{git(repo,'add','--','seed.txt','nested project é/owned.txt','nested project é/gate.cjs');
      git(repo,'commit','-qm','seed');git(repo,'checkout','-qb','moe/frozen');}
    if(mode==='workspace-failure'){
      write(path.join(nested,'.gitattributes'),'gate.cjs filter=fail\n');
      git(repo,'add','--','nested project é/.gitattributes');git(repo,'commit','-qm','filter');
      git(repo,'config','filter.fail.clean','cat');git(repo,'config','filter.fail.smudge','exit 41');git(repo,'config','filter.fail.required','true');
    }
    // A push is attempted only where a remote exists: a reachable bare one, or one
    // whose path does not exist. Every other arm has no remote, so no push.
    if(mode==='receipt-push'){git(root,'init','-q','--bare',mode+'-remote.git');git(repo,'remote','add','origin',path.join(root,mode+'-remote.git'));}
    if(mode==='receipt-push-failed')git(repo,'remote','add','origin',path.join(root,mode+'-missing.git'));
    // A peer's commit is already on the remote branch, so the landing's first push
    // is rejected. receipt-rebase-replay opts into the pull --rebase retry
    // (MOE_PUSH_REBASE=1), which rewrites the landed commit before the re-push;
    // receipt-push-rejected keeps the default, which announces the rejection and
    // leaves the checkout exactly as it was.
    if(mode==='receipt-rebase-replay'||mode==='receipt-push-rejected'||mode==='reconcile-strong-no-rebase'){const remote=path.join(root,mode+'-remote.git'),peer=path.join(root,mode+'-peer');
      git(root,'init','-q','--bare',mode+'-remote.git');git(repo,'remote','add','origin',remote);git(repo,'push','-q','origin','moe/frozen');
      git(root,'clone','-q','-b','moe/frozen',remote,peer);
      for(const [key,value] of [['user.name','Moe Peer'],['user.email','peer@test.local'],['core.autocrlf','false']])git(peer,'config',key,value);
      write(path.join(peer,'remote-only.txt'),'remote only\n');git(peer,'add','--','remote-only.txt');git(peer,'commit','-qm','peer-remote');
      git(peer,'push','-q','origin','moe/frozen');}
    // The branch CAS fails ONCE with the tip unchanged (git refuses the first
    // prepared update of the target), so the rebuilt tree and base are identical.
    if(mode==='receipt-cached-check'){const hook=path.join(repo,'.git','hooks','reference-transaction');
      write(hook,'#!/bin/sh\n[ "$1" = prepared ] || exit 0\ngrep -q " refs/heads/moe/frozen$" || exit 0\n'+
        'm="$(git rev-parse --git-dir)/moe-cas-refused"\n[ -e "$m" ] && exit 0\n: > "$m"\nexit 1\n');fs.chmodSync(hook,0o755);}
    // CQ-V08: an earlier strong landing of this task is on the branch, and its
    // receipt journal is still unsettled.
    if(mode==='reconcile-strong-unreconciled'){const base=git(repo,'rev-parse','HEAD');
      git(repo,'commit','--allow-empty','-qm','feat(task-postflight): earlier','-m','Moe-Session: worker-old@seed','-m','Moe-Kind: completion');
      const t=git(repo,'rev-parse','HEAD');
      seeded=JSON.stringify({taskId:'task-postflight',workerId:'worker-old',attemptId:'attempt-old',generation:1,candidateId:'cand-old',
        target:'refs/heads/moe/frozen',targetBefore:base,targetAfter:t,landedRevision:t,pushResult:null,
        treeSha:git(repo,'rev-parse',t+'^{tree}'),baseRevision:base,planRevision:3,profile:'verified-local'});
      write(path.join(repo,'.git','moe','receipt','task-postflight.json'),seeded);}
    // CQ-V07: the claim's attempt is pinned on a strong (verified-local) or a legacy
    // execution policy. The hook logs every prepared ref update -- old is the
    // expected-old git was handed, so the CAS -- with the receipt journal as it
    // stood at that instant. A regular file where the journal dir goes makes the
    // journal unwritable. CQ-V08b: strong-checkpoint-held-journal pins a legacy
    // attempt, and only the task's receipt journal says verified-local -- one the
    // pre-flight replay keeps (it cannot parse it), as it keeps an unsettled one.
    if(/^(intent|reconcile|strong)-/.test(mode)){const stamp=new Date().toISOString(),hook=path.join(repo,'.git','hooks','reference-transaction');
      write(path.join(nested,'.moe','attempts','attempt-postflight.json'),JSON.stringify({id:'attempt-postflight',generation:7,taskId:'task-postflight',
        workerId:'worker-frozen',runnerId:'worker-frozen',phase:'running',workspace:nested,startedAt:stamp,lastPhaseAt:stamp,
        executionPolicySnapshot:{version:2,profile:/^((intent|reconcile)-)?strong/.test(mode)&&mode!=='strong-checkpoint-held-journal'?'verified-local':'legacy',
          planRevision:3,deliveryPolicy:'local-branch'}}));
      if(mode==='strong-checkpoint-held-journal')write(path.join(repo,'.git','moe','receipt','task-postflight.json'),'{"profile":"verified-local"}\n');
      write(hook,['#!/bin/sh','[ "$1" = prepared ] || exit 0','d="$(git rev-parse --git-common-dir)"; j="$d/moe/receipt/task-postflight.json"',
        'while read -r old new ref; do','  if [ -f "$j" ]; then c="$(tr -d \'\\r\\n\' < "$j")"; else c=null; fi',
        '  printf \'{"ref":"%s","old":"%s","new":"%s","journal":%s}\\n\' "$ref" "$old" "$new" "$c" >> "$d/moe-intent-events.jsonl"','done',''].join('\n'));
      fs.chmodSync(hook,0o755);
      if(mode.endsWith('-unwritable')||mode==='strong-recovery-held')write(path.join(repo,'.git','moe','receipt'),'not a directory\n');}
  }
  write(path.join(nested,'helper.txt'),'dirty helper\n');write(path.join(nested,'peer.txt'),'peer bytes\n');
  write(path.join(nested,'.codex','dirty.txt'),'denied bytes\n');
  // A previous session of the task ended without landing: the pre-flight lands
  // this lingering baseline as a recovery checkpoint before the CLI starts.
  const baselineFile=path.join(repo,'.git','moe','baseline','task-postflight.tsv');
  if(mode==='teardown-recovered'){write(owned,'recovered owned\n');
    write(baselineFile,'#moe-baseline v1 task=task-postflight at=2026-01-01T00:00:00Z head='+git(repo,'rev-parse','HEAD')+' landed=0\n');}
  const cliJs=path.join(root,mode+'-cli.cjs');
  write(cliJs,`
const fs=require('fs'),path=require('path'),dir=process.env.MOE_PROJECT_PATH,mode=process.env.FROZEN_MODE;
if(mode==='loop-land-twice'){const n=Number(fs.readFileSync(path.join(dir,'.moe','claim-count'),'utf8'));
 fs.writeFileSync(path.join(dir,'owned.txt'),'frozen owned '+(n===2?1:n)+'\\n');}
else if(mode!=='no-change'&&mode!=='teardown-nothing')fs.writeFileSync(path.join(dir,'owned.txt'),'frozen owned\\n');
const file=path.join(dir,'.moe','attempts','attempt-postflight.json');
const qaClaimed=mode.endsWith('-qa-claimed'),exitOnly=/^(checkpoint|manual|freed|strong-checkpoint)-/.test(mode)||/^teardown-(running|protected)$/.test(mode)||process.env.FROZEN_RUN==='2';
// reattach-sidecar/-refused: a daemon restart parks the attempt while this
// session runs, and the session goes on once the wrapper reattached it (or once
// the wait runs out, as under a restart nobody reattached). reattach-preflight
// records the phase the session started on.
const moeFile=f=>path.join(dir,'.moe',f),count=f=>{try{return Number(fs.readFileSync(moeFile(f),'utf8'));}catch(e){return 0;}};
const phase=()=>{try{return JSON.parse(fs.readFileSync(file,'utf8')).phase;}catch(e){return '';}};
const waitFor=(test,ms)=>{for(const end=Date.now()+ms;!test()&&Date.now()<end;)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,100);};
if(mode==='reattach-preflight')fs.writeFileSync(moeFile('cli-saw-phase'),phase());
if((mode==='reattach-sidecar'||mode==='reattach-refused')&&fs.existsSync(file)){
 const a=JSON.parse(fs.readFileSync(file,'utf8'));a.phase='reconciling';fs.writeFileSync(file,JSON.stringify(a));
 // One more ping after the reattach: the sidecar is sequential, so its line is out.
 if(mode==='reattach-sidecar'){waitFor(()=>phase()==='running',60000);const seen=count('heartbeat-count');waitFor(()=>count('heartbeat-count')>seen,30000);}
 else{waitFor(()=>fs.existsSync(moeFile('evidence-rpcs.jsonl'))&&fs.readFileSync(moeFile('evidence-rpcs.jsonl'),'utf8').includes('reattach_attempt'),60000);
  const pings=count('heartbeat-count');waitFor(()=>count('heartbeat-count')>=pings+3,30000);}}
if(mode==='reattach-none')waitFor(()=>count('heartbeat-count')>=3,30000);
// reattach-session: the restart parks an attempt of this seat that the wrapper
// did not pin -- a row the agent claimed inside its session, which moe-proxy
// stamped with the wrapper's identity. The sidecar reattaches the attempt the
// heartbeat names while the session runs; the CLI records the phase it saw.
if(mode==='reattach-session'&&fs.existsSync(file)){const pinned=JSON.parse(fs.readFileSync(file,'utf8')),session=moeFile('attempts/attempt-session.json');
 const sessionPhase=()=>{try{return JSON.parse(fs.readFileSync(session,'utf8')).phase;}catch(e){return '';}};
 fs.writeFileSync(session,JSON.stringify({id:'attempt-session',generation:3,taskId:'task-session',workerId:pinned.workerId,runnerId:pinned.workerId,
  phase:'reconciling',processStartedAt:pinned.processStartedAt,host:pinned.host,workspace:dir,startedAt:new Date().toISOString(),lastPhaseAt:new Date().toISOString()}));
 waitFor(()=>sessionPhase()==='running',60000);fs.writeFileSync(moeFile('cli-saw-phase'),sessionPhase());
 // One more ping after the reattach: the sidecar is sequential, so its line is out.
 const seen=count('heartbeat-count');waitFor(()=>count('heartbeat-count')>seen,30000);}
// identity-claim: a worker CLI never gets the runner identity, not even one
// inherited from an outer seat (the harness sets one).
if(mode==='identity-claim')fs.writeFileSync(moeFile('cli-runner-env'),JSON.stringify([process.env.MOE_RUNNER_PROCESS_STARTED_AT??null,process.env.MOE_RUNNER_HOST??null]));
if(fs.existsSync(file)){const a=JSON.parse(fs.readFileSync(file,'utf8'));if(!exitOnly)a.phase='finalizing';
if(mode.endsWith('-reconciling')||mode==='reattach-postflight')a.phase='reconciling';
if(mode==='closed-attempt'||mode==='freed-closed'||qaClaimed)a.phase='closed';if(mode==='stale-attempt'||mode==='freed-generation-bump')a.generation++;if(mode==='missing-attempt')fs.unlinkSync(file);else fs.writeFileSync(file,JSON.stringify(a));}
const stamp=new Date().toISOString();
if(qaClaimed)fs.writeFileSync(path.join(dir,'.moe','attempts','attempt-qa.json'),JSON.stringify({id:'attempt-qa',generation:8,taskId:'task-postflight',
 workerId:'qa-frozen',runnerId:'qa-frozen',phase:'running',workspace:dir,startedAt:stamp,lastPhaseAt:stamp}));
// strong-checkpoint-held-forged: the CLI writes a newer, legacy attempt record of
// its task; the profile its wrapper pinned at pre-flight still holds the exit.
if(mode==='strong-checkpoint-held-forged')fs.writeFileSync(path.join(dir,'.moe','attempts','attempt-forged.json'),JSON.stringify({id:'attempt-forged',generation:8,
 taskId:'task-postflight',workerId:'worker-forged',runnerId:'worker-forged',phase:'closed',workspace:dir,startedAt:stamp,lastPhaseAt:stamp,
 executionPolicySnapshot:{version:2,profile:'legacy',planRevision:3,deliveryPolicy:'local-branch'}}));
if(mode.endsWith('-unpinned')||mode==='freed-corrupt-sibling')fs.writeFileSync(path.join(dir,'.moe','attempts','zzz-broken.json'),'{not json');
if(mode==='teardown-no-baseline')fs.rmSync(${JSON.stringify(baselineFile)},{force:true});
if(mode==='teardown-protected'||mode.startsWith('strong-checkpoint-'))fs.copyFileSync(${JSON.stringify(baselineFile)},path.join(dir,'.moe','baseline-at-cli'));
if(/^teardown-(finalizing|manual|no-git|sha256|no-baseline|recovered|running|protected)$/.test(mode)){const ready=path.join(dir,'.moe','gate-ready');fs.writeFileSync(ready,'ready');
 const until=Date.now()+120000,wait=setInterval(()=>{if(fs.existsSync(ready+'.sent')||Date.now()>until)clearInterval(wait);},100);}
`);
  const cli=path.join(root,mode+(win?'.cmd':'.sh'));
  write(cli,win?'@echo off\r\nchcp 65001 >nul\r\nnode "'+cliJs+'"\r\nexit /b %errorlevel%\r\n':
    '#!/usr/bin/env bash\nexec node "'+cliJs.replaceAll('\\','/')+'"\n');fs.chmodSync(cli,0o700);
  const race=path.join(root,mode+'-race.cjs');
  write(race,"const fs=require('fs'),cp=require('child_process');fs.writeFileSync('break-gate.txt','advanced');"+
    "cp.execFileSync('git',['add','--','break-gate.txt']);cp.execFileSync('git',['commit','-qm','peer-race','--','break-gate.txt']);");
  write(path.join(nested,'.moe','daemon.json'),JSON.stringify({port:9876,projectPath:nested}));
  const before=noGit||mode==='unborn'?'':git(repo,'rev-parse','HEAD'),index=path.join(repo,'.git','index');
  const beforeIndex=noGit||!fs.existsSync(index)?null:fs.readFileSync(index);
  const env={...process.env,MOE_PROXY_PATH:proxy,MOE_NODE_COMMAND:process.execPath,MOE_DISABLE_HEARTBEAT:'1',
    FAKE_TASK_STATUS:'REVIEW',FAKE_SCOPE_PEERS_ACTIVE:'1',FAKE_SCOPE_PEER_DECLARED:'peer.txt:task-peer',
    FROZEN_FIXTURE:nested,FROZEN_MODE:mode,HOME:path.join(root,'home'),USERPROFILE:path.join(root,'home'),
    FAKE_EVIDENCE_MODE:mode,FAKE_CTX_IS_EPIC_FINAL:mode==='deferred'?'false':'true'};
  // CQ-V08 arms reuse the fake daemon's receipt knobs: a refused receipt, or a crash at the held ledger row.
  env.FAKE_EVIDENCE_MODE={'reconcile-strong-receipt-lost':'receipt-refused','reconcile-strong-unreconciled':'receipt-refused',
    'reconcile-strong-rewrite':'receipt-ledger-replay','reconcile-strong-rewrite-same-tree':'receipt-ledger-replay',
    'reconcile-strong-finalize-lost':'finalize_attempt-null','reconcile-strong-replay-running':'finalize_attempt-null','reconcile-strong-conflict-finalize-lost':'receipt-conflict-finalize-lost'}[mode]||mode;
  if(mode.startsWith('race-')||mode==='reconcile-strong-target-moved')env.MOE_POSTFLIGHT_TEST_HOOK_PRE_UPDATE_REF='node "'+race.replaceAll('\\','/')+'"';
  // A peer lands an EMPTY commit before the CAS: new base, identical rebuilt tree.
  if(mode==='receipt-same-tree-race'||mode==='intent-strong-cas'){write(race,"require('child_process').execFileSync('git',['commit','--allow-empty','-qm','peer-empty']);");
    env.MOE_POSTFLIGHT_TEST_HOOK_PRE_UPDATE_REF='node "'+race.replaceAll('\\','/')+'"';}
  // The pull --rebase retry is opt-in; receipt-rebase-replay exercises it, and
  // reconcile-strong-no-rebase shows a strong landing ignores it.
  if(mode==='receipt-rebase-replay'||mode==='reconcile-strong-no-rebase')env.MOE_PUSH_REBASE='1';
  const args=win?['-NoProfile','-File',wrapper,'-Project',nested,'-WorkerId','worker-frozen','-Role','worker',
    '-Team','Smoke','-NoStartDaemon','-Command',cli,'-NoLoop','-PollInterval','0']:
    [wrapper,'--project',nested,'--worker-id','worker-frozen','--role','worker','--team','Smoke','--no-start-daemon',
    '--command',cli,'--no-loop','--poll-interval','0'];

  if(/^(checkpoint|manual|strong-checkpoint)-/.test(mode)||/^teardown-(running|protected)$/.test(mode))env.FAKE_TASK_STATUS='WORKING';
  // A CLI-visible variable that claims the legacy profile changes nothing: the
  // wrapper reads the profile only from wrapper- and daemon-written records.
  if(mode==='strong-checkpoint-held-env'){env.MOE_EXECUTION_PROFILE='legacy';env.PINNED_ATTEMPT_PROFILE='legacy';}
  if(mode==='teardown-protected')env.FAKE_SCOPE_ASSIGNEE='worker-live';
  if(mode.startsWith('freed-'))env.FAKE_TASK_STATUS='BLOCKED';
  if(mode.endsWith('-unpinned'))env.FAKE_CLAIM_TOKENS='missing';
  // Reattach arms: the sidecar pings every second against the fake heartbeat.
  if(['reattach-sidecar','reattach-refused','reattach-none','reattach-session'].includes(mode)){delete env.MOE_DISABLE_HEARTBEAT;env.MOE_HEARTBEAT_INTERVAL_SEC='1';
    env.FAKE_HEARTBEAT_REATTACH=mode==='reattach-none'?'other':'1';}
  if(mode==='reattach-refused')env.FAKE_REATTACH_REFUSE='1';
  if(mode==='reattach-session')env.FAKE_HEARTBEAT_ATTEMPT='attempt-session';
  if(mode==='identity-claim'){env.MOE_RUNNER_PROCESS_STARTED_AT='1@outer-seat';env.MOE_RUNNER_HOST='outer-host';}
  if(mode==='reattach-preflight')env.FAKE_ATTEMPT_PHASE='reconciling';
  if(mode==='finalize-loss'||mode==='loop-land-twice'||loopModes.includes(mode)){
    args[args.indexOf(win?'-NoLoop':'--no-loop')]=win?'-Loop':'--loop';
    args[args.indexOf(win?'-PollInterval':'--poll-interval')+1]='1';
  }
  let runEngine=engine,runArgs=args;
  const secondClaim=path.join(nested,'.moe','second-claim');
  if(loopModes.includes(mode)||mode==='loop-land-twice'){
    if(mode==='loop-land-twice')env.FAKE_CLAIM_LIMIT='3';else env.FAKE_CLAIM_ONCE='1';
    env.TMPDIR=env.TMP=env.TEMP=wrapperTmp;
    const supervisor=path.join(root,'loop-supervisor.cjs');
    write(supervisor,KILL_ON_MARKER);
    runEngine=process.execPath;
    runArgs=[supervisor,secondClaim,String((Number(process.env.MOE_POSTFLIGHT_TIMEOUT_SEC||180)-15)*1000),engine,...args];
  }
  const receiptHeld=path.join(nested,'.moe','receipt-held');
  if(mode==='receipt-replay'){
    env.TMPDIR=env.TMP=env.TEMP=wrapperTmp;
    const supervisor=path.join(root,'receipt-supervisor.cjs');
    write(supervisor,KILL_ON_MARKER);
    runEngine=process.execPath;
    runArgs=[supervisor,receiptHeld,String((Number(process.env.MOE_POSTFLIGHT_TIMEOUT_SEC||180)-15)*1000),engine,...args];
  }
  // The crash-window arms die the same way: at the held ledger row (window 1) or
  // at the held receipt (windows 2 and 3).
  const ledgerHeld=path.join(nested,'.moe','ledger-held');
  if(['receipt-ledger-replay','receipt-rebase-replay','receipt-foreign-replay'].includes(env.FAKE_EVIDENCE_MODE)){
    env.TMPDIR=env.TMP=env.TEMP=wrapperTmp;
    const supervisor=path.join(root,'receipt-supervisor.cjs');
    write(supervisor,KILL_ON_MARKER);
    runEngine=process.execPath;
    runArgs=[supervisor,env.FAKE_EVIDENCE_MODE==='receipt-ledger-replay'?ledgerHeld:receiptHeld,String((Number(process.env.MOE_POSTFLIGHT_TIMEOUT_SEC||180)-15)*1000),engine,...args];
  }
  if(/^(interrupt|teardown)-/.test(mode)){
    const supervisor=path.join(root,mode+(win?'-supervisor.ps1':'-supervisor.sh'));
    if(win){
      write(path.join(root,'interrupt-args.json'),JSON.stringify(args));
      write(supervisor,`
param([string]$Engine,[string]$ArgsFile,[string]$Ready,[string]$Log,[int]$LimitMs)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$global:OutputEncoding=[Console]::OutputEncoding
$arguments=([IO.File]::ReadAllText($ArgsFile)|ConvertFrom-Json)|ForEach-Object {'"'+$_+'"'}
$p=Start-Process -FilePath $Engine -ArgumentList $arguments -WindowStyle Hidden -PassThru -RedirectStandardOutput $Log -RedirectStandardError "$Log.err"
$null=$p.Handle
try {
  $until=[DateTime]::UtcNow.AddSeconds(120)
  while(-not (Test-Path -LiteralPath $Ready)){if($p.HasExited -or [DateTime]::UtcNow -gt $until){throw 'gate readiness failed'};Start-Sleep -Milliseconds 100}
  Add-Type 'using System; using System.Runtime.InteropServices; public static class GateSignal {
    [DllImport("kernel32.dll")] public static extern bool FreeConsole();
    [DllImport("kernel32.dll")] public static extern bool AttachConsole(uint pid);
    [DllImport("kernel32.dll")] public static extern bool SetConsoleCtrlHandler(IntPtr h,bool add);
    [DllImport("kernel32.dll")] public static extern bool GenerateConsoleCtrlEvent(uint code,uint group);
  }'
  [GateSignal]::FreeConsole()|Out-Null
  if(-not [GateSignal]::AttachConsole($p.Id)){throw 'AttachConsole to OWNED wrapper failed'}
  [GateSignal]::SetConsoleCtrlHandler([IntPtr]::Zero,$true)|Out-Null
  if(-not [GateSignal]::GenerateConsoleCtrlEvent(0,0)){throw 'owned Ctrl+C failed'}
  [IO.File]::WriteAllText("$Ready.sent",'sent')
  if(-not $p.WaitForExit($LimitMs)){throw 'gate cancellation failed to finish'}
  Get-Content -LiteralPath $Log
  Get-Content -LiteralPath "$Log.err"
  exit $p.ExitCode
} finally {
  if(Test-Path -LiteralPath $Log){Get-Content -LiteralPath $Log}
  if(Test-Path -LiteralPath "$Log.err"){Get-Content -LiteralPath "$Log.err"}
  if(-not $p.HasExited){& taskkill /T /F /PID $p.Id|Out-Null;$p.WaitForExit(5000)|Out-Null}
}
`);
      runArgs=['-NoProfile','-File',supervisor,engine,path.join(root,'interrupt-args.json'),
        path.join(nested,'.moe','gate-ready'),path.join(root,'interrupt-child.log'),String(CANCEL_MS)];
    }else{
      write(supervisor,`
#!/usr/bin/env bash
set -m
ready="$1"; signal="$2"; shift 2
"$@" &
child=$!
trap 'kill -TERM "$child" 2>/dev/null || true' EXIT
for ((i=0;i<1200;i++)); do [ ! -f "$ready" ] || break; sleep 0.1; done
[ -f "$ready" ] || exit 98
kill "-$signal" "$child" || exit 97
: > "$ready.sent"
wait "$child"
rc=$?
trap - EXIT
exit "$rc"
`);
      runArgs=[supervisor,path.join(nested,'.moe','gate-ready'),mode==='interrupt-term'?'TERM':'INT',engine,...args];
    }
  }
  const run=cp.spawnSync(runEngine,runArgs,{env,encoding:'utf8',timeout:Number(process.env.MOE_POSTFLIGHT_TIMEOUT_SEC||180)*1000,maxBuffer:4*1024*1024});
  const log=(run.stdout||'')+(run.stderr||'');write(path.join(root,mode+'.log'),log);
  assert.equal(run.signal,null,log);assert.ok(run.status!==null,log);
  const rpc=rows(path.join(nested,'.moe','evidence-rpcs.jsonl')),candidates=rpc.filter(r=>r.tool==='record_candidate'),
    checks=rpc.filter(r=>r.tool==='record_check_run'),finals=rpc.filter(r=>r.tool==='finalize_attempt'),
    seen=rows(path.join(nested,'.moe','gate-observations.jsonl'));
  const failed=['dirty-helper','race-fail','tracked-mutation','exit-tail','missing-attempt','stale-attempt','claim-missing','claim-malformed','closed-attempt','workspace-failure','interrupt-int','interrupt-term',
    'gate-qa-claimed','hidden-mutation','skip-worktree-mutation','index-mutation','head-mutation'].includes(mode)||mode.startsWith('record_');
  const after=noGit?'':git(repo,'rev-parse','HEAD');
  const lastCommit=rpc.filter(r=>r.tool==='record_commit').at(-1);
  const pushBlocked=rows(path.join(nested,'.moe','messages','chan-general.jsonl')).some(m=>String(m.content).includes('PUSH-BLOCKED'))||
    rpc.some(r=>r.tool==='add_comment'&&String(r.args.content).includes('PUSH-BLOCKED'));
  if(loopModes.includes(mode))assert.equal(fs.existsSync(secondClaim),true,'the worker loop must go on claiming after this exit\n'+log);
  // Runner identity: every claim carries this wrapper's one pair (two claims in
  // one --loop wrapper carry the same one), and the attempt a claim opened
  // records it. A reattach goes out only for a parked attempt of this seat, with
  // that attempt's id and generation and the pair its claim recorded.
  const claims=rpc.filter(r=>r.tool==='claim_next_task').map(r=>r.args),pair=a=>[a.processStartedAt,a.host];
  assert.ok(claims.length>0,log);
  for(const c of claims){assert.ok(pair(c).every(v=>typeof v==='string'&&v.trim()),'every claim carries the runner identity\n'+log);
    assert.deepEqual(pair(c),pair(claims[0]),'one identity per wrapper process\n'+log);}
  if(mode==='identity-claim'){assert.ok(claims.length>=2,log);
    assert.deepEqual(pair(JSON.parse(read(path.join(nested,'.moe','attempts','attempt-postflight.json')))),pair(claims[0]),
      'the claim recorded the pair on the attempt it opened\n'+log);
    assert.deepEqual(JSON.parse(read(path.join(nested,'.moe','cli-runner-env'))),[null,null],'a worker CLI gets no runner identity\n'+log);}
  const reattaches=rpc.filter(r=>r.tool==='reattach_attempt').map(r=>r.args),said=s=>log.split(s).length-1;
  if(mode==='reattach-session'){const r=reattaches[0]||{};
    assert.equal(reattaches.length,1,'exactly one reattach, for the attempt the heartbeat named\n'+log);
    assert.deepEqual([r.taskId,r.workerId,r.attemptId,r.generation,...pair(r)],['task-session','worker-frozen','attempt-session',3,...pair(claims[0])],log);
    assert.equal(read(path.join(nested,'.moe','cli-saw-phase')),'running','the sidecar reattached it while the session ran\n'+log);
    assert.equal(said('attempt attempt-session (generation 3) on task task-session is running again after a daemon restart.'),1,log);
  }else if(['reattach-sidecar','reattach-refused','reattach-postflight','reattach-preflight','checkpoint-reconciling','manual-reconciling'].includes(mode)){
    const r=reattaches[0]||{};
    assert.equal(reattaches.length,1,'exactly one reattach for the one parked attempt\n'+log);
    assert.deepEqual([r.taskId,r.workerId,r.attemptId,r.generation,...pair(r)],['task-postflight','worker-frozen','attempt-postflight',7,...pair(claims[0])],log);
    assert.ok(typeof r.runnerId==='string'&&r.runnerId.trim(),log);
    if(mode==='reattach-refused')assert.equal(said('moe.reattach_attempt refused for attempt attempt-postflight (ATTEMPT_IDENTITY_MISMATCH); not retrying it.'),1,
      'a refusal is logged once and not asked again\n'+log);
    else assert.equal(said('attempt attempt-postflight (generation 7) on task task-postflight is running again after a daemon restart.'),1,log);
    if(mode==='reattach-postflight')assert.ok(rpc.findIndex(x=>x.tool==='reattach_attempt')<rpc.findIndex(x=>x.tool==='record_candidate'),
      'the reattach precedes the candidate\n'+log);
    if(mode==='reattach-preflight'){assert.equal(read(path.join(nested,'.moe','cli-saw-phase')),'running','reattached before the CLI launched\n'+log);
      assert.equal(log.includes('Missing/stale attempt identity'),false,log);}
  }else assert.equal(reattaches.length,0,'nothing parked, so nothing to reattach\n'+log);
  if(mode==='reattach-none')for(const reason of ['no-worker-record','no-open-attempt'])
    assert.equal(said('heartbeat asks for reattachment ('+reason+')'),1,'each other reason is logged once\n'+log);
  const journal=path.join(repo,'.git','moe','receipt','task-postflight.json');
  if(mode==='receipt-replay'){
    // Run 1 landed and was hard-killed while its first receipt was held. Run 2 is
    // the same seat, whose claim is refused while that attempt is finalizing: it
    // replays the journaled report and closes the attempt, and never lands again.
    assert.ok(fs.existsSync(receiptHeld),'run 1 must reach its delivery receipt\n'+log);
    assert.notEqual(after,before,log);assert.ok(fs.existsSync(journal),'the crash leaves the receipt journal\n'+log);
    const reflog=git(repo,'reflog','show','--format=%H','refs/heads/moe/frozen');
    const second=cp.spawnSync(engine,args,{env:{...env,FAKE_CLAIM_MODE:'finalizing',MOE_TASKLESS_WAIT_SEC:'5'},encoding:'utf8',
      timeout:Number(process.env.MOE_POSTFLIGHT_TIMEOUT_SEC||180)*1000,maxBuffer:4*1024*1024});
    const log2=log+(second.stdout||'')+(second.stderr||'');write(path.join(root,mode+'.log'),log2);
    assert.equal(second.signal,null,log2);assert.ok(second.status!==null,log2);
    const rpc2=rows(path.join(nested,'.moe','evidence-rpcs.jsonl')),receipts=rpc2.filter(r=>r.tool==='record_delivery_receipt'),
      finals2=rpc2.filter(r=>r.tool==='finalize_attempt'),c=candidates.at(-1).args;
    assert.equal(git(repo,'rev-parse','HEAD'),after,'the replay moves no ref\n'+log2);
    assert.equal(git(repo,'reflog','show','--format=%H','refs/heads/moe/frozen'),reflog,'the replay moves no ref\n'+log2);
    assert.equal(receipts.length,2,log2);assert.deepEqual(receipts[1].args,receipts[0].args,'the replay re-sends the journaled report\n'+log2);
    assert.deepEqual([receipts[0].args.candidateId,receipts[0].args.target,receipts[0].args.targetBefore,receipts[0].args.targetAfter,
      receipts[0].args.landedRevision,receipts[0].args.pushResult],[c.id,c.deliveryTarget,c.baseRevision,after,after,undefined],log2);
    assert.equal(fs.readdirSync(path.join(nested,'.moe','receipts')).length,1,log2);
    assert.equal(finals2.length,1,'only the replay acknowledges the attempt\n'+log2);
    assert.deepEqual([finals2[0].args.attemptId,finals2[0].args.generation,finals2[0].args.outcome,finals2[0].args.landedRevision],
      ['attempt-postflight',7,'landed',after],log2);
    assert.ok(rpc2.indexOf(receipts[1])<rpc2.indexOf(finals2[0]),'the receipt precedes the finalize\n'+log2);
    assert.equal(JSON.parse(read(path.join(nested,'.moe','attempts','attempt-postflight.json'))).phase,'closed',log2);
    assert.deepEqual(fs.readdirSync(path.join(nested,'.moe','attempts')),['attempt-postflight.json'],'the replay opens no attempt\n'+log2);
    assert.equal(rpc2.filter(r=>r.tool==='record_candidate'||r.tool==='record_check_run').length,candidates.length+checks.length,
      'the replay freezes and gates nothing\n'+log2);
    assert.equal(rpc2.filter(r=>r.tool==='record_commit'&&r.args.outcome==='committed').length,1,log2);
    assert.equal(fs.existsSync(journal),false,'a recorded replay deletes its journal\n'+log2);
    count++;continue;
  }
  // The three crash windows receipt-replay does not reach. Run 2 is its
  // claim-refused pre-flight; sid() is a commit's Moe-Session trailer.
  const sid=sha=>(git(repo,'log','-1','--format=%B',sha).split('\n').find(l=>l.startsWith('Moe-Session: '))||'').slice(13).trim();
  const ledgerRows=()=>rows(path.join(nested,'.moe','record_commit.jsonl')).filter(r=>r.outcome==='committed'&&r.kind==='completion');
  const reflogOf=()=>git(repo,'reflog','show','--format=%H','refs/heads/moe/frozen');
  const replay=argv=>{const r=cp.spawnSync(engine,argv,{env:{...env,FAKE_CLAIM_MODE:'finalizing',MOE_TASKLESS_WAIT_SEC:'5'},encoding:'utf8',
      timeout:Number(process.env.MOE_POSTFLIGHT_TIMEOUT_SEC||180)*1000,maxBuffer:4*1024*1024});
    const log2=log+(r.stdout||'')+(r.stderr||'');write(path.join(root,mode+'.log'),log2);
    assert.equal(r.signal,null,log2);assert.ok(r.status!==null,log2);
    return {log2,rpc2:rows(path.join(nested,'.moe','evidence-rpcs.jsonl'))};};
  // What every replay leaves: no ref moved, nothing frozen or gated again, one
  // committed completion row, one landed finalize of the journal owner's attempt
  // after the last receipt, that attempt closed and the journal gone.
  const replayed=(rpc2,log2,reflog)=>{
    const receipts=rpc2.filter(r=>r.tool==='record_delivery_receipt'),finals2=rpc2.filter(r=>r.tool==='finalize_attempt');
    assert.equal(git(repo,'rev-parse','HEAD'),after,'the replay moves no ref\n'+log2);
    assert.equal(reflogOf(),reflog,'the replay moves no ref\n'+log2);
    assert.equal(rpc2.filter(r=>r.tool==='record_candidate'||r.tool==='record_check_run').length,candidates.length+checks.length,
      'the replay freezes and gates nothing\n'+log2);
    assert.equal(ledgerRows().length,1,'exactly one committed completion row\n'+log2);
    assert.equal(finals2.length,1,'the replay closes the attempt once\n'+log2);
    const f=finals2[0].args;
    assert.deepEqual([f.attemptId,f.generation,f.outcome,f.landedRevision,f.workerId],['attempt-postflight',7,'landed',after,'worker-frozen'],log2);
    assert.ok(rpc2.indexOf(receipts.at(-1))<rpc2.indexOf(finals2[0]),'the receipt precedes the finalize\n'+log2);
    assert.equal(JSON.parse(read(path.join(nested,'.moe','attempts','attempt-postflight.json'))).phase,'closed',log2);
    assert.deepEqual(fs.readdirSync(path.join(nested,'.moe','attempts')),['attempt-postflight.json'],'the replay opens no attempt\n'+log2);
    assert.equal(fs.existsSync(journal),false,'a recorded replay deletes its journal\n'+log2);
    return receipts;
  };
  if(mode==='receipt-ledger-replay'){
    // Window 1: run 1 moved the ref and was hard-killed inside its committed ledger
    // call, so only the journal knows that row is owed. Run 2 (same seat) records
    // it, then the receipt, then closes the attempt.
    assert.ok(fs.existsSync(ledgerHeld),'run 1 must reach its ledger row\n'+log);
    assert.notEqual(after,before,log);assert.ok(fs.existsSync(journal),'the crash leaves the receipt journal\n'+log);
    const j1=JSON.parse(read(journal)),reflog=reflogOf();
    assert.equal(ledgerRows().length,0,'the killed ledger call recorded nothing\n'+log);
    const {log2,rpc2}=replay(args),owed=ledgerRows();
    assert.equal(owed.length,1,'the replay records the owed ledger row once\n'+log2);
    assert.deepEqual([owed[0].taskId,owed[0].sha,owed[0].ref,owed[0].role,owed[0].sessionId,owed[0].status,owed[0].pushed],
      ['task-postflight',after,'moe/frozen','worker',sid(after),'REVIEW',false],log2);
    const receipts=replayed(rpc2,log2,reflog),c=candidates.at(-1).args,
      row=rpc2.find(r=>r.tool==='record_commit'&&r.args.outcome==='committed'&&r.args.kind==='completion');
    assert.equal(receipts.length,1,log2);
    assert.ok(rpc2.indexOf(row)<rpc2.indexOf(receipts[0]),'the owed row precedes the receipt\n'+log2);
    assert.deepEqual([receipts[0].args.candidateId,receipts[0].args.target,receipts[0].args.targetBefore,receipts[0].args.targetAfter,
      receipts[0].args.landedRevision,receipts[0].args.pushResult],[c.id,c.deliveryTarget,c.baseRevision,after,after,undefined],log2);
    assert.deepEqual(j1.ledger,{sessionId:sid(after),role:'worker',status:'REVIEW'},'the journal carries the owed row\n'+log2);
    count++;continue;
  }
  if(mode==='receipt-rebase-replay'){
    // Window 2: the push's pull --rebase rewrote the landed commit, then the crash
    // lost its receipt. The journal names the CAS commit; the branch carries its copy.
    assert.ok(fs.existsSync(receiptHeld),'run 1 must reach its delivery receipt\n'+log);
    const j1=JSON.parse(read(journal)),C=j1.targetAfter,remote=path.join(root,mode+'-remote.git');
    assert.notEqual(C,after,'the pull --rebase rewrote the landed commit\n'+log);
    assert.equal(cp.spawnSync('git',['-C',repo,'merge-base','--is-ancestor',C,after]).status,1,log);
    assert.equal(git(remote,'rev-parse','refs/heads/moe/frozen'),after,log);assert.equal(sid(C),sid(after),log);
    assert.deepEqual([j1.ledger,j1.pushResult],[undefined,'pushed moe/frozen'],'an acknowledged ledger row leaves the journal\n'+log);
    assert.deepEqual(ledgerRows().map(r=>r.sha),[after],'run 1 recorded the rewritten copy\n'+log);
    const reflog=reflogOf(),{log2,rpc2}=replay(args),receipts=rpc2.filter(r=>r.tool==='record_delivery_receipt');
    assert.equal(git(remote,'rev-parse','refs/heads/moe/frozen'),after,'the replay pushes nothing\n'+log2);
    assert.equal(receipts.length,2,'the rewritten copy counts as landed\n'+log2);
    assert.deepEqual(receipts[1].args,receipts[0].args,'the replay re-sends the journaled report\n'+log2);
    assert.deepEqual([receipts[0].args.targetAfter,receipts[0].args.landedRevision,receipts[0].args.pushResult],[C,C,'pushed moe/frozen'],log2);
    replayed(rpc2,log2,reflog);
    assert.equal(log2.includes('that landing never moved the ref'),false,log2);
    count++;continue;
  }
  if(mode==='receipt-foreign-replay'){
    // Window 3: the owner never comes back. Another seat's pre-flight replays the
    // journal and, git showing the landing, closes the owner's attempt.
    assert.ok(fs.existsSync(receiptHeld),'run 1 must reach its delivery receipt\n'+log);
    assert.notEqual(after,before,log);assert.ok(fs.existsSync(journal),'the crash leaves the receipt journal\n'+log);
    const reflog=reflogOf(),{log2,rpc2}=replay(args.map(a=>a==='worker-frozen'?'worker-other':a));
    const receipts=rpc2.filter(r=>r.tool==='record_delivery_receipt');
    assert.equal(rpc2.filter(r=>r.tool==='claim_next_task').at(-1).args.workerId,'worker-other',log2);
    assert.equal(receipts.length,2,log2);
    const {workerId:w0,...r0}=receipts[0].args,{workerId:w1,...r1}=receipts[1].args;
    assert.deepEqual([w0,w1,r1],['worker-frozen','worker-other',r0],'the other seat re-sends the journaled report\n'+log2);
    replayed(rpc2,log2,reflog);
    count++;continue;
  }
  if(mode.startsWith('reconcile-strong-')){
    // CQ-V08, strong profile only: no double land, no early finalize, and a proof
    // never moves to a tree other than the verified candidate's.
    const moved=rows(path.join(repo,'.git','moe-intent-events.jsonl')).filter(e=>e.ref==='refs/heads/moe/frozen'),
      receipts=rpc.filter(r=>r.tool==='record_delivery_receipt'),[c1={},c2={}]=candidates.map(r=>r.args),
      completions=()=>git(repo,'log','--format=%H','--fixed-strings','--grep=Moe-Kind: completion',before+'..moe/frozen').split('\n').filter(Boolean);
    if(mode==='reconcile-strong-receipt-lost'){
      // DoD1: a lost receipt holds the finalize; the replay records it, THEN finalizes, and never lands again.
      assert.deepEqual({deferred:said('MOE_FINALIZE_DEFERRED_RECEIPT: task task-postflight --'),finals:finals.length,journal:fs.existsSync(journal),landed:after!==before},
        {deferred:1,finals:0,journal:true,landed:true},log);
      const reflog=reflogOf();env.FAKE_EVIDENCE_MODE=mode;
      const {log2,rpc2}=replay(args),r2=replayed(rpc2,log2,reflog);
      assert.equal(r2.length,2,log2);assert.deepEqual(r2[1].args,r2[0].args,'the replay re-sends the journaled report\n'+log2);
      assert.deepEqual(completions(),[after],'no double land\n'+log2);
    }else if(mode==='reconcile-strong-unreconciled'){
      // DoD1: a journal the replay could not settle refuses the next landing before any effect.
      assert.deepEqual({warned:said('MOE_COMMIT_REFUSED_UNRECONCILED_INTENT: task task-postflight --'),moved,head:after,journal:read(journal),
        commits:rpc.filter(r=>r.tool==='record_commit').map(r=>[r.args.outcome,r.args.kind,r.args.code]),receipts:receipts.map(r=>r.args.targetAfter),
        rescue:git(repo,'for-each-ref','--format=%(refname)','refs/moe/rescue/'),owned:read(owned),baseline:fs.existsSync(baselineFile),
        evidence:candidates.length+checks.length,finals:finals.map(f=>f.args.outcome)},
        {warned:1,moved:[],head:before,journal:seeded,commits:[['refused','completion','MOE_COMMIT_REFUSED_UNRECONCILED_INTENT']],receipts:[before],
        rescue:'',owned:'frozen owned\n',baseline:true,evidence:0,finals:['failed']},log);
    }else if(mode==='reconcile-strong-target-moved'){
      // DoD2: a moved target re-freezes and rechecks; only the second candidate is journaled, received and landed, on the peer's commit.
      assert.deepEqual({ids:c1.id!==c2.id,trees:c1.treeSha!==c2.treeSha,checks:checks.map(r=>[r.args.candidateId,r.args.exitCode]),
        intent:moved.at(-1)?.journal?.candidateId,receipts:receipts.map(r=>r.args.candidateId),journal:fs.existsSync(journal),completions:completions(),
        parent:[git(repo,'rev-parse',after+'~1'),git(repo,'log','-1','--format=%s',after+'~1')],finals:finals.map(f=>[f.args.outcome,f.args.landedRevision])},
        {ids:true,trees:true,checks:[[c1.id,0],[c2.id,0]],intent:c2.id,receipts:[c2.id],journal:false,completions:[after],
        parent:[c2.baseRevision,'peer-race'],finals:[['landed',after]]},log);
    }else if(mode==='reconcile-strong-no-rebase'){
      // DoD3: a rejected strong push is never rebased; the branch keeps the verified commit.
      const r=receipts[0]?.args||{};
      assert.deepEqual({rebased:log.includes('trying git pull --rebase'),exact:said('strong delivery is exact'),tree:git(repo,'rev-parse',after+'^{tree}'),
        state:['rebase-merge','rebase-apply'].some(d=>fs.existsSync(path.join(repo,'.git',d))),receipt:[r.targetAfter,/^push failed: /.test(String(r.pushResult))],
        finals:finals.map(f=>[f.args.outcome,f.args.landedRevision])},
        {rebased:false,exact:1,tree:c1.treeSha,state:false,receipt:[after,true],finals:[['landed',after]]},log);
    }else if(mode==='reconcile-strong-finalize-lost'){
      // CQ-V08b: the receipt is accepted, then every finalize is lost. The strong journal
      // stays; the replay re-sends that receipt, THEN finalizes that landing once, and never lands again.
      const phase=()=>JSON.parse(read(path.join(nested,'.moe','attempts','attempt-postflight.json'))).phase;
      assert.deepEqual({finals:finals.map(f=>[f.args.outcome,f.args.landedRevision]),receipts:receipts.map(r=>r.args.targetAfter),
        journal:fs.existsSync(journal)&&JSON.parse(read(journal)).targetAfter,phase:phase(),exhausted:said('finalize_attempt acknowledgement exhausted'),
        deferred:said('MOE_FINALIZE_DEFERRED_RECEIPT'),completions:completions(),rows:ledgerRows().length},
        {finals:Array(3).fill(['landed',after]),receipts:[after],journal:after,phase:'finalizing',exhausted:1,deferred:0,completions:[after],rows:1},log);
      const n=rpc.length,reflog=reflogOf();env.FAKE_EVIDENCE_MODE=mode;
      const {log2,rpc2}=replay(args),tail=rpc2.slice(n).filter(r=>['record_commit','record_delivery_receipt','finalize_attempt'].includes(r.tool)),f=tail[1]?.args||{};
      assert.deepEqual({tail:tail.map(r=>r.tool),resent:tail[0]?.args,final:[f.attemptId,f.generation,f.workerId,f.outcome,f.landedRevision],
        head:git(repo,'rev-parse','moe/frozen'),reflog:reflogOf(),journal:fs.existsSync(journal),phase:phase(),completions:completions(),rows:ledgerRows().length,
        evidence:rpc2.filter(r=>r.tool==='record_candidate'||r.tool==='record_check_run').length},
        {tail:['record_delivery_receipt','finalize_attempt'],resent:receipts[0].args,final:['attempt-postflight',7,'worker-frozen','landed',after],
        head:after,reflog,journal:false,phase:'closed',completions:[after],rows:1,evidence:candidates.length+checks.length},log2);
    }else if(mode==='reconcile-strong-conflict-finalize-lost'){
      // task-a1f3723f: a receipt conflict, then every finalize lost. The strong journal stays
      // (CQ-V08b); a replay whose finalize is lost again keeps it, one whose finalize is answered closes the attempt and drops it.
      const phase=()=>JSON.parse(read(path.join(nested,'.moe','attempts','attempt-postflight.json'))).phase,
        conflict='already has a delivery receipt that differs from this report',kept=()=>fs.existsSync(journal)&&JSON.parse(read(journal)).targetAfter,
        tailOf=(rpc2,n)=>rpc2.slice(n).filter(r=>['record_commit','record_delivery_receipt','finalize_attempt'].includes(r.tool)),
        evidence=rpc2=>rpc2.filter(r=>r.tool==='record_candidate'||r.tool==='record_check_run').length;
      assert.deepEqual({finals:finals.map(f=>[f.args.outcome,f.args.landedRevision]),receipts:receipts.map(r=>r.args.targetAfter),
        journal:kept(),phase:phase(),exhausted:said('finalize_attempt acknowledgement exhausted'),deferred:said('MOE_FINALIZE_DEFERRED_RECEIPT'),
        conflict:said(conflict),completions:completions(),rows:ledgerRows().length},
        {finals:Array(3).fill(['landed',after]),receipts:[after],journal:after,phase:'finalizing',exhausted:1,deferred:0,
        conflict:1,completions:[after],rows:1},log);
      const reflog=reflogOf(),n1=rpc.length,r1=replay(args),tail1=tailOf(r1.rpc2,n1),own1=s=>r1.log2.slice(log.length).split(s).length-1;
      assert.deepEqual({tail:tail1.map(r=>r.tool),resent:tail1[0]?.args,journal:kept(),phase:phase(),conflict:own1(conflict),
        open:own1('is still finalizing after its replayed receipt'),head:git(repo,'rev-parse','moe/frozen'),reflog:reflogOf(),evidence:evidence(r1.rpc2)},
        {tail:['record_delivery_receipt','finalize_attempt','finalize_attempt','finalize_attempt'],resent:receipts[0].args,journal:after,phase:'finalizing',
        conflict:1,open:1,head:after,reflog,evidence:candidates.length+checks.length},r1.log2);
      env.FAKE_EVIDENCE_MODE='receipt-conflict';
      const n2=r1.rpc2.length,{log2,rpc2}=replay(args),tail2=tailOf(rpc2,n2),f=tail2[1]?.args||{};
      assert.deepEqual({tail:tail2.map(r=>r.tool),resent:tail2[0]?.args,final:[f.attemptId,f.generation,f.workerId,f.outcome,f.landedRevision],
        head:git(repo,'rev-parse','moe/frozen'),reflog:reflogOf(),journal:fs.existsSync(journal),phase:phase(),completions:completions(),
        rows:ledgerRows().length,evidence:evidence(rpc2)},
        {tail:['record_delivery_receipt','finalize_attempt'],resent:receipts[0].args,final:['attempt-postflight',7,'worker-frozen','landed',after],
        head:after,reflog,journal:false,phase:'closed',completions:[after],rows:1,evidence:candidates.length+checks.length},log2);
    }else if(mode==='reconcile-strong-replay-running'){
      // CQ-V08b, a shared strong journal (task-9194f182): run 1 is finalize-lost's. The replay then reads the
      // attempt as running, neither finalizing nor closed: it re-sends the receipt, sends no finalize and keeps
      // the journal byte for byte, with one 'not closed; nothing finalized.' line.
      const att=path.join(nested,'.moe','attempts','attempt-postflight.json'),at0=JSON.parse(read(att));
      assert.deepEqual({phase:at0.phase,journal:fs.existsSync(journal),receipts:receipts.length,rows:ledgerRows().length},
        {phase:'finalizing',journal:true,receipts:1,rows:1},log);
      write(att,JSON.stringify({...at0,phase:'running'}));
      const j1=read(journal),n=rpc.length,reflog=reflogOf();env.FAKE_EVIDENCE_MODE=mode;
      const {log2,rpc2}=replay(args),run2=log2.slice(log.length),n2=s=>run2.split(s).length-1,
        tail=rpc2.slice(n).filter(r=>['record_commit','record_delivery_receipt','finalize_attempt'].includes(r.tool));
      assert.deepEqual({tail:tail.map(r=>r.tool),resent:tail[0]?.args,
        kept:n2(' kept: attempt attempt-postflight of task task-postflight is running, not closed; nothing finalized.'),
        closed:n2(' not closed; nothing finalized.'),lost:n2('still finalizing after its replayed receipt'),
        journal:fs.existsSync(journal)&&read(journal),phase:JSON.parse(read(att)).phase,head:git(repo,'rev-parse','moe/frozen'),
        reflog:reflogOf(),completions:completions(),rows:ledgerRows().length,
        evidence:rpc2.filter(r=>r.tool==='record_candidate'||r.tool==='record_check_run').length},
        {tail:['record_delivery_receipt'],resent:receipts[0].args,kept:1,closed:1,lost:0,journal:j1,phase:'running',head:after,
        reflog,completions:[after],rows:1,evidence:candidates.length+checks.length},log2);
    }else{
      // DoD3: run 1 died at its ledger row; the branch then carries the landing's
      // trailers on a copy. A copy of another tree gets nothing; the same tree is that landing.
      assert.ok(fs.existsSync(ledgerHeld),'run 1 must reach its ledger row\n'+log);
      const j1=read(journal),same=mode.endsWith('-same-tree'),msg=path.join(root,mode+'-msg.txt');
      write(msg,git(repo,'log','-1','--format=%B',after)+'\n');
      const parent=same?git(repo,'commit-tree',before+'^{tree}','-p',before,'-m','peer-empty'):before;
      const copy=git(repo,'commit-tree',(same?after:before)+'^{tree}','-p',parent,'-F',msg);
      git(repo,'update-ref','refs/heads/moe/frozen',copy,after);
      const n=rpc.length,{log2,rpc2}=replay(args),run2=log2.slice(log.length).split('MOE_DELIVERY_PROOF_NOT_TRANSFERRED: task task-postflight --').length-1;
      const tail=rpc2.slice(n).filter(r=>['record_commit','record_delivery_receipt','finalize_attempt'].includes(r.tool))
        .map(r=>[r.tool,r.tool==='record_commit'?r.args.sha:r.tool==='finalize_attempt'?r.args.outcome+' '+r.args.landedRevision:r.args.targetAfter]);
      assert.deepEqual({warned:run2,tail,head:git(repo,'rev-parse','moe/frozen'),journal:fs.existsSync(journal)?read(journal):null},
        same?{warned:0,tail:[['record_commit',copy],['record_delivery_receipt',after],['finalize_attempt','landed '+copy]],head:copy,journal:null}
          :{warned:1,tail:[],head:copy,journal:j1},log2);
    }
    count++;continue;
  }
  if(mode.startsWith('strong-')){
    // CQ-V08b: under the strong profile only a verified completion moves the target.
    // A checkpoint -- this session's exit, or a later pre-flight's recovery -- is
    // refused before any effect: no ref, rescue ref, index or baseline write.
    const code='MOE_COMMIT_REFUSED_STRONG_CHECKPOINT',warned=s=>s.split(code+': task task-postflight --').length-1,
      moved=()=>rows(path.join(repo,'.git','moe-intent-events.jsonl')).filter(e=>e.ref==='refs/heads/moe/frozen'||e.ref.startsWith('refs/moe/rescue/')),
      rescues=()=>git(repo,'for-each-ref','--format=%(refname) %(objectname)','refs/moe/rescue/'),
      commits=r=>r.filter(x=>x.tool==='record_commit').map(x=>[x.args.outcome,x.args.kind,x.args.code]);
    // The exit is held by: -held the pin and the record; -env the same, its
    // environment forged; -forged the pin alone, against a newer forged legacy
    // record; -journal the receipt journal alone, under a legacy pin and record.
    if(mode.startsWith('strong-checkpoint-')){
      const line=rows(path.join(nested,'.moe','messages','chan-general.jsonl')).map(m=>String(m.content))
        .filter(s=>s.includes('worker session ended: task=task-postflight')).pop()||'';
      assert.deepEqual({warned:warned(log),commits:commits(rpc),line:line.includes(' outcome=refused code='+code),head:after,reflog:reflogOf(),moved:moved(),
        rescue:rescues(),owned:read(owned),index:fs.readFileSync(index).equals(beforeIndex),
        baseline:fs.readFileSync(baselineFile).equals(fs.readFileSync(path.join(nested,'.moe','baseline-at-cli'))),
        evidence:candidates.length+checks.length+seen.length+finals.length},
        {warned:1,commits:[['refused','checkpoint',code]],line:true,head:before,reflog:before,moved:[],
        rescue:'',owned:'frozen owned\n',index:true,baseline:true,evidence:0},log);
    }else{
      // Run 1 ends a strong completion unlanded: its journal unwritable, or its gate
      // failed and parked the bytes on a rescue ref. Run 2 (journal writable again)
      // lands nothing, and the rescue ref stays unmoved.
      const gate=mode.endsWith('-gate'),refs1=rescues(),moved1=moved().length,reflog=reflogOf(),
        phase=()=>JSON.parse(read(path.join(nested,'.moe','attempts','attempt-postflight.json'))).phase;
      assert.deepEqual({code:rpc.filter(r=>r.tool==='record_commit').at(-1)?.args.code,finals:finals.map(f=>f.args.outcome),phase:phase(),head:after,
        rescue:refs1.split('\n').filter(Boolean).length,baseline:fs.existsSync(baselineFile)},
        {code:gate?'MOE_COMMIT_FAILED_GATE':'MOE_COMMIT_REFUSED_INTENT_UNWRITABLE',finals:[gate?'rescued':'failed'],phase:'closed',head:before,
        rescue:gate?1:0,baseline:true},log);
      if(!gate)fs.rmSync(path.join(repo,'.git','moe','receipt'));
      const n=rpc.length,second=cp.spawnSync(engine,args,{env:{...env,FAKE_TASK_STATUS:'WORKING',FROZEN_RUN:'2'},encoding:'utf8',
        timeout:Number(process.env.MOE_POSTFLIGHT_TIMEOUT_SEC||180)*1000,maxBuffer:4*1024*1024});
      const log2=(second.stdout||'')+(second.stderr||'');write(path.join(root,mode+'.log'),log+log2);
      assert.equal(second.signal,null,log2);assert.ok(second.status!==null,log2);
      // The gate failure leaves its baseline lingering, so run 2 refuses twice: the
      // pre-flight recovery of those bytes, then its own exit. A V07 refusal settles
      // its baseline instead (landed=1, the bytes carried as the task's own), so run 2
      // has nothing to recover and refuses only its exit checkpoint of those bytes.
      const recovering=log2.indexOf(win?'a previous session of task task-postflight ended without landing':'lingering baseline for task-postflight');
      assert.deepEqual({recovering:recovering>=0&&recovering<log2.indexOf(code),warned:warned(log2),recovered:log2.includes('MOE_CHECKPOINT_RECOVERED'),
        commits:commits(rows(path.join(nested,'.moe','evidence-rpcs.jsonl')).slice(n)),head:git(repo,'rev-parse','moe/frozen'),reflog:reflogOf(),
        rescue:rescues(),moved:moved().length,owned:read(owned)},
        {recovering:gate,warned:gate?2:1,recovered:false,commits:Array(gate?2:1).fill(['refused','checkpoint',code]),head:before,reflog,
        rescue:refs1,moved:moved1,owned:'frozen owned\n'},log2);
    }
    count++;continue;
  }
  if(mode.startsWith('teardown-')){
    const want=teardownOutcome[mode],commits=rpc.filter(r=>r.tool==='record_commit'),at=r=>rpc.indexOf(r);
    const refs=noGit?[]:git(repo,'for-each-ref','--format=%(refname)','refs/moe/rescue/').split('\n').filter(Boolean);
    const attempt=JSON.parse(read(path.join(nested,'.moe','attempts','attempt-postflight.json')));
    const deregisterAt=rpc.findIndex(r=>r.tool==='deregister_worker');
    // Proof the interrupt really cut this session short: a post-flight that ran
    // to its end announces it, and an uninterrupted run could reach the same outcome.
    assert.equal(rows(path.join(nested,'.moe','messages','chan-general.jsonl')).some(m=>String(m.content).includes('worker session ended: task=')),
      false,'the interrupt must land before the post-flight announces a normal end\n'+log);
    assert.equal(finals.length,want?1:0,'the interrupted exit acknowledges its finalizing attempt exactly once\n'+log);
    if(want){
      assert.equal(finals[0].args.outcome,want,log);
      assert.equal(attempt.phase,'closed',log);
      assert.ok(deregisterAt>at(finals[0]),'finalize_attempt must precede deregister_worker\n'+log);
    }else assert.equal(attempt.phase,'running','a running attempt is never acknowledged\n'+log);
    if(mode==='teardown-landed'){
      assert.equal(refs.length,0,'a landed commit is never parked again on a rescue ref\n'+log);
      assert.notEqual(after,before,log);assert.equal(finals[0].args.landedRevision,after);
      assert.equal(git(repo,'rev-parse','HEAD^{tree}'),candidates.at(-1)?.args.treeSha,log);
      assert.ok(commits.some(r=>r.args.outcome==='committed'&&r.args.kind==='completion'&&r.args.sha===after),log);
      assert.equal(commits.filter(r=>r.args.outcome!=='committed').length,0,'a landed commit records no failure\n'+log);
      // Interrupted before its receipt: the journal keeps the report for the next pre-flight.
      const j=fs.existsSync(journal)?JSON.parse(read(journal)):{};
      assert.deepEqual([j.candidateId,j.targetAfter,j.landedRevision],[candidates.at(-1)?.args.id,after,after],'an interrupted landing keeps its receipt journal\n'+log);
    }else if(mode==='teardown-nothing'){
      assert.equal(refs.length,0,'a no-change landing is never parked on a rescue ref\n'+log);
      assert.equal(after,before,log);assert.equal(read(owned),'base\n');
      assert.deepEqual(checks.map(r=>r.args.exitCode),[0],'its gate ran once and passed\n'+log);
      assert.equal(commits.filter(r=>r.args.outcome!=='nothing').length,0,'a no-change landing records no failure\n'+log);
    }else if(mode==='teardown-protected'){
      // Another worker owns the task now: the interrupt parks none of its bytes
      // and leaves the tree, the index and the baseline as the session found them.
      assert.equal(refs.length+candidates.length+checks.length+seen.length,0,'nothing is parked, frozen or gated\n'+log);
      assert.deepEqual(commits.map(r=>[r.args.outcome,r.args.kind,r.args.code,r.args.sha||null]),
        [['refused','rescue','MOE_COMMIT_REFUSED_ACTIVE_ASSIGNEE',null]],'the teardown records its refusal\n'+log);
      assert.equal(after,before,log);assert.deepEqual(fs.readFileSync(index),beforeIndex);assert.equal(read(owned),'frozen owned\n');
      assert.deepEqual(fs.readFileSync(baselineFile),fs.readFileSync(path.join(nested,'.moe','baseline-at-cli')),'the baseline is untouched\n'+log);
    }else{
      assert.equal(candidates.length+checks.length+seen.length,0,'no landing ran, so no candidate and no gate\n'+log);
      if(teardownRescued.includes(mode)){
        assert.equal(refs.length,1,'the teardown parks the unlanded bytes\n'+log);
        assert.equal(git(repo,'show',refs[0]+':nested project é/owned.txt'),'frozen owned');
        const rescue=commits.find(r=>r.args.kind==='rescue');
        assert.ok(rescue&&at(rescue)<(want?at(finals[0]):deregisterAt),'the rescue is recorded before the finalize\n'+log);
      }else{assert.equal(refs.length,0,log);assert.equal(commits.length,0,'this exit reports no git activity\n'+log);}
      if(mode==='teardown-recovered'){assert.match(git(repo,'log','-1','--format=%s'),/^wip\(task-postflight\).* recovered$/);
        assert.equal(git(repo,'show','HEAD:nested project é/owned.txt'),'recovered owned');}
      else{assert.equal(after,before,log);if(!noGit)assert.deepEqual(fs.readFileSync(index),beforeIndex);}
    }
    assert.equal(read(path.join(nested,'helper.txt')),'dirty helper\n');assert.equal(read(path.join(nested,'peer.txt')),'peer bytes\n');
    if(!noGit)assert.equal(git(repo,'worktree','list','--porcelain').split('\n').filter(l=>l.startsWith('worktree ')).length,1);
    for(const o of seen)assert.equal(fs.existsSync(path.dirname(o.cwd)),false,'owned gate workspace must be deleted');
    count++;continue;
  }
  if(mode.startsWith('manual-')||mode.startsWith('checkpoint-')){
    assert.equal(candidates.length+checks.length+finals.length+seen.length,0,log);
    // A parked attempt is reattached before the landing, so the ladder finds it running and says nothing.
    assert.equal(log.includes('[finalize] no finalizing attempt for this seat on task task-postflight'),!mode.endsWith('-reconciling'),log);
    if(mode.startsWith('manual-')){assert.equal(after,before);assert.deepEqual(fs.readFileSync(index),beforeIndex);}
    else{assert.notEqual(after,before,log);assert.match(git(repo,'log','-1','--format=%s'),/^wip\(task-postflight\)/);
      assert.equal(git(repo,'show','HEAD:nested project é/owned.txt'),'frozen owned');}
    count++;continue;
  }
  if(mode==='loop-land-twice'){
    // Two landings in one --loop wrapper: claim 1 lands, claim 2 re-presents the
    // bytes claim 1 landed, claim 3 lands. Claim 2's candidate is the unchanged
    // tip and must freeze the tip's real tree: the ps1 twin once froze an empty
    // one there, threw on its commit-tree, and neither landed nor rescued.
    const completions=rpc.filter(r=>r.tool==='record_commit'&&r.args.kind==='completion');
    assert.deepEqual(finals.map(f=>f.args.outcome),['landed','nothing-to-commit','landed'],log);
    for(const f of finals){assert.equal(f.args.attemptId,'attempt-postflight',log);assert.equal(f.args.generation,7,log);}
    assert.equal(fs.existsSync(secondClaim),true,'the worker loop must go on claiming after its third post-flight\n'+log);
    assert.deepEqual(completions.map(r=>r.args.outcome),['committed','nothing','committed'],log);
    assert.equal(completions[1].args.code,'MOE_COMMIT_NOTHING_TO_COMMIT',log);
    assert.equal(candidates.length,3,log);assert.deepEqual(checks.map(r=>r.args.exitCode),[0,0,0],log);
    assert.equal(candidates[1].args.baseRevision,finals[0].args.landedRevision,log);
    assert.equal(candidates[1].args.treeSha,git(repo,'rev-parse',finals[0].args.landedRevision+'^{tree}'),log);
    assert.deepEqual(seen.map(o=>o.owned),['frozen owned 1\n','frozen owned 1\n','frozen owned 3\n'],log);
    const subjects=git(repo,'log','--format=%s',before+'..moe/frozen').split('\n');
    assert.equal(subjects.length,2,log);for(const s of subjects)assert.match(s,/^feat\(task-postflight\): /,log);
    assert.equal(finals[2].args.landedRevision,after,log);assert.equal(git(repo,'rev-parse','HEAD~1'),finals[0].args.landedRevision,log);
    assert.equal(git(repo,'show','HEAD:nested project é/owned.txt'),'frozen owned 3',log);
    assert.equal(git(repo,'for-each-ref','--format=%(refname)','refs/moe/rescue/'),'',log);
    for(const bad of ['Cannot bind argument','landing failed for task','rescue ref failed'])assert.equal(log.includes(bad),false,bad+'\n'+log);
    assert.equal(git(repo,'worktree','list','--porcelain').split('\n').filter(l=>l.startsWith('worktree ')).length,1,log);
    for(const o of seen)assert.equal(fs.existsSync(path.dirname(o.cwd)),false,'owned gate workspace must be deleted\n'+log);
    count++;continue;
  }
  if(mode.startsWith('freed-')){
    assert.equal(candidates.length+checks.length+finals.length+seen.length,0,'a seat that holds no finalizing attempt acknowledges nothing\n'+log);
    assert.equal(log.split('[finalize] no finalizing attempt for this seat on task task-postflight').length-1,mode==='freed-generation-bump'?1:0,log);
    assert.equal(log.includes('Attempt identity unavailable'),false,'finalize reads only the pinned attempt record\n'+log);
    assert.equal(git(repo,'rev-list','--count',before+'..HEAD'),'1',log);
    assert.match(git(repo,'log','-1','--format=%s'),/^wip\(task-postflight\).*\[status=BLOCKED /,log);
    assert.equal(git(repo,'show','HEAD:nested project é/owned.txt'),'frozen owned');
    count++;continue;
  }
  if(mode==='sha256-repo'){
    // Refused at the git probe, named once per wrapper process, and nothing lands:
    // no candidate, gate, commit or rescue ref, the CLI's bytes stay uncommitted,
    // and the finalize acknowledges nothing-to-commit, exactly as in no-git.
    assert.deepEqual({refused:said('MOE_COMMIT_REFUSED_OBJECT_FORMAT'),named:log.includes('uses the sha256 object format; Moe'),
      head:after===before,rescue:git(repo,'for-each-ref','--format=%(refname)','refs/moe/rescue/'),
      evidence:candidates.length+checks.length+seen.length,commits:rpc.filter(r=>r.tool==='record_commit').map(r=>r.args.outcome),
      finals:finals.map(f=>f.args.outcome),owned:read(owned),committed:git(repo,'show','HEAD:nested project é/owned.txt')},
      {refused:1,named:true,head:true,rescue:'',evidence:0,commits:[],finals:['nothing-to-commit'],owned:'frozen owned\n',committed:'base'},log);
    count++;continue;
  }
  if(mode.startsWith('intent-')){
    const moves=rows(path.join(repo,'.git','moe-intent-events.jsonl')),moved=moves.filter(e=>e.ref==='refs/heads/moe/frozen'),
      blocker=path.join(repo,'.git','moe','receipt');
    if(mode==='intent-strong-unwritable'||mode==='intent-strong-nocandidate'){
      // Refused before the effect: no ref moves, nothing is parked or pushed, and the
      // bytes, the index and the baseline stay as the session left them.
      const code=mode==='intent-strong-unwritable'?'MOE_COMMIT_REFUSED_INTENT_UNWRITABLE':'MOE_COMMIT_REFUSED_INTENT_INCOMPLETE';
      assert.deepEqual({commits:rpc.filter(r=>r.tool==='record_commit').map(r=>[r.args.outcome,r.args.kind,r.args.code]),warned:said(code+': task task-postflight --'),
        head:after,reflog:reflogOf(),moved:moves.filter(e=>e.ref==='refs/heads/moe/frozen'||e.ref.startsWith('refs/moe/rescue/')),
        rescue:git(repo,'for-each-ref','--format=%(refname)','refs/moe/rescue/'),owned:read(owned),index:fs.readFileSync(index).equals(beforeIndex),
        baseline:fs.existsSync(baselineFile),finals:finals.map(f=>[f.args.outcome,f.args.landedRevision]),
        evidence:[candidates.length,checks.map(r=>r.args.exitCode)],receipts:rpc.filter(r=>r.tool==='record_delivery_receipt').length,pushBlocked},
        {commits:[['refused','completion',code]],warned:1,head:before,reflog:before,moved:[],rescue:'',owned:'frozen owned\n',index:true,
        baseline:true,finals:[['failed',undefined]],evidence:mode==='intent-strong-unwritable'?[1,[0]]:[0,[]],receipts:0,pushBlocked:false},log);
      if(mode==='intent-strong-unwritable'){assert.equal(read(blocker),'not a directory\n',log);
        assert.deepEqual(fs.readdirSync(path.join(repo,'.git','moe')).filter(f=>f.includes('.tmp.')),[],'a failed write leaves no journal behind\n'+log);
        assert.equal(log.includes('receipt journal not written'),false,'the strong profile never falls back to the best-effort journal\n'+log);}
      count++;continue;
    }
    if(mode==='intent-legacy-unwritable'){
      // Legacy stays best-effort: it warns, and lands with no journal at all.
      assert.ok(log.includes('receipt journal not written'),log);
      assert.deepEqual(moved.map(e=>[e.old,e.journal]),[[before,null]],log);
      fs.rmSync(blocker);
    }else{
      // The intent is on disk before the target moves. It names this candidate, its
      // tree, the CAS base and the plan revision, and the CAS git ran is that same base.
      const c=candidates.at(-1).args,last=moved.at(-1)||{};
      assert.equal(moved.length,mode==='intent-strong-cas'?2:1,log);
      assert.deepEqual([last.old,last.new],[c.baseRevision,after],'the expected-old CAS is kept\n'+log);
      assert.deepEqual(last.journal,{taskId:'task-postflight',workerId:'worker-frozen',attemptId:'attempt-postflight',generation:7,candidateId:c.id,
        target:'refs/heads/moe/frozen',targetBefore:c.baseRevision,targetAfter:after,landedRevision:after,pushResult:null,
        ledger:{sessionId:sid(after),role:'worker',status:'REVIEW'},treeSha:c.treeSha,baseRevision:c.baseRevision,planRevision:3,profile:'verified-local'},
        'the intent is durable before the effect\n'+log);
      assert.equal(c.treeSha,git(repo,'rev-parse',after+'^{tree}'),log);
      if(mode==='intent-strong')assert.equal(c.baseRevision,before,log);
      else{
        // A peer moved the target first: the failed CAS left no intent behind, and
        // the retry journaled the rebuilt candidate on the peer's commit.
        assert.equal(candidates.length,2,log);assert.notEqual(candidates[0].args.id,c.id,log);
        assert.deepEqual([moved[0].old,moved[0].new,moved[0].journal],[before,c.baseRevision,null],log);
        assert.equal(git(repo,'rev-parse',after+'~1'),c.baseRevision,log);}
    }
  }
  if(['dirty-helper','race-fail','tracked-mutation','exit-tail','hidden-mutation','skip-worktree-mutation','index-mutation','head-mutation','record_candidate-refuse'].includes(mode))
    assert.equal(pushBlocked,true,'a real gate or evidence persistence failure stays PUSH-BLOCKED\n'+log);
  if(mode==='dirty-helper'){
    assert.equal(after,before,'dirty helper must not authorize a branch commit\n'+log);
    assert.equal(checks[0]?.args.exitCode,19);
    // Both twins announce a failed gate with the same marked line: the chat line,
    // and the first line of the task comment.
    const line=String.fromCodePoint(0x1f6ab)+' PUSH-BLOCKED: qualityGate failed for task task-postflight: node gate.cjs (exit 19)';
    assert.deepEqual({chat:rows(path.join(nested,'.moe','messages','chan-general.jsonl')).some(m=>m.content===line),
      comment:rpc.some(r=>r.tool==='add_comment'&&String(r.args.content).split('\n')[0]===line)},{chat:true,comment:true},log);
  }else if(mode==='race-fail'){
    assert.equal(git(repo,'log','-1','--format=%s'),'peer-race','stale candidate check must not authorize rebuilt tree\n'+log);
    assert.equal(checks.length,2);assert.deepEqual(checks.map(r=>r.args.exitCode),[0,23]);
  }
  if(mode==='manual'||mode==='no-git'){
    assert.equal(candidates.length,0);assert.equal(checks.length,0);assert.equal(finals.length,1,log);
    assert.equal(finals[0].args.outcome,'nothing-to-commit');assert.equal(after,before);count++;continue;
  }
  if(['disabled','deferred','nogate-qa-claimed','gate-blank'].includes(mode)){
    assert.equal(candidates.length,0,'a completion with no gate to run records no candidate\n'+log);assert.equal(pushBlocked,false,log);
    if(mode==='nogate-qa-claimed')assert.equal(git(repo,'show','HEAD:nested project é/owned.txt'),'frozen owned');
    // A whitespace-only qualityGate lands exactly as an unset one: no check run, no
    // rescue ref, one landed finalize -- that row also proves the rpc log was read.
    if(mode==='gate-blank')assert.deepEqual({checks:checks.length,gateRuns:seen.length,rescue:git(repo,'for-each-ref','refs/moe/rescue/'),
      finals:finals.map(f=>f.args.outcome),landed:after!==before},{checks:0,gateRuns:0,rescue:'',finals:['landed'],landed:true},log);
  }else if(identityModes.includes(mode)){
    assert.equal(after,before);assert.equal(candidates.length+checks.length+seen.length,0,'no current attempt: the gate never runs\n'+log);
    assert.ok(log.includes('qualityGate not run: candidate evidence unavailable'),log);assert.equal(pushBlocked,false,log);
    assert.ok(String(lastCommit?.args.message).includes('candidate evidence unavailable'),log);
    if(mode.startsWith('claim-'))assert.ok(log.includes('has no pinned identity; not acknowledging.'),log);
  }else{
    assert.ok(candidates.length>0,'candidate must be recorded\n'+log);
    for(const c of candidates){assert.equal(c.args.attemptId,'attempt-postflight');assert.equal(c.args.generation,7);
      assert.equal(c.args.deliveryTarget,'refs/heads/moe/frozen');}
  }
  if(mode.startsWith('race-')){
    assert.equal(candidates.length,2);assert.notEqual(candidates[0].args.id,candidates[1].args.id);
    assert.notEqual(candidates[0].args.treeSha,candidates[1].args.treeSha);
    assert.notEqual(candidates[0].args.baseRevision,candidates[1].args.baseRevision);
    if(mode==='race-pass')assert.deepEqual(checks.map(r=>r.args.candidateId),candidates.map(r=>r.args.id),'a moved target reruns the gate on the rebuilt candidate\n'+log);
  }
  // A padded qualityGate still runs, and records the trimmed command: the delivery
  // policy builds its required-check token from the trimmed string.
  if(mode==='gate-padded')assert.deepEqual({gateRuns:seen.length,recorded:checks.map(r=>[r.args.command,r.args.exitCode])},
    {gateRuns:1,recorded:[['node gate.cjs',0]]},log);
  for(const check of checks){
    const ci=rpc.findIndex(r=>r.tool==='record_candidate'&&r.args.id===check.args.candidateId);
    assert.ok(ci>=0&&ci<rpc.indexOf(check));assert.equal(check.args.treeSha,rpc[ci].args.treeSha);
    assert.equal(check.args.source,'runner-observed');assert.equal(check.args.command,'node gate.cjs');
    assert.ok(Buffer.byteLength(check.args.outputTail)<=16384);
    // The run carries its honest outcome: 'passed' only for exit 0 with the checkout
    // intact, 'inconclusive' for exit 0 after a tracked tree/index/HEAD mutation,
    // 'code-failure' for a nonzero exit, 'infra-failure' for an interrupted gate.
    // The wrapper can only know the mutation if it checked integrity BEFORE recording.
    const wantOutcome=mode.startsWith('interrupt-')?'infra-failure':
      ['tracked-mutation','hidden-mutation','skip-worktree-mutation','index-mutation','head-mutation'].includes(mode)?'inconclusive':
      check.args.exitCode!==0?'code-failure':'passed';
    assert.equal(check.args.outcome,wantOutcome,'CheckRun outcome for '+mode+' (exit '+check.args.exitCode+')\n'+log);
  }
  for(const o of seen){
    assert.notEqual(path.resolve(o.cwd),path.resolve(nested));assert.equal(path.basename(o.cwd),'nested project é');
    assert.equal(path.resolve(o.project),path.resolve(o.cwd));assert.equal(o.helper,false);assert.equal(o.peer,false);assert.equal(o.denied,false);
    assert.ok(candidates.some(r=>r.args.treeSha===o.tree));assert.ok(o.persisted.some(c=>c.treeSha===o.tree),'candidate persisted before gate execution');assert.equal(o.owned,mode==='no-change'?'base\n':'frozen owned\n');
  }
  const refs=git(repo,'for-each-ref','--format=%(refname)','refs/moe/rescue/').split('\n').filter(Boolean);
  if(failed){
    assert.equal(refs.length,1,'failure must rescue frozen bytes\n'+log);
    assert.equal(git(repo,'show',refs[0]+':nested project é/owned.txt'),'frozen owned');
    if(candidates.length)assert.equal(git(repo,'rev-parse',refs[0]+'^{tree}'),candidates.at(-1).args.treeSha,'rescue must preserve the entire frozen tree');
    if(mode!=='race-fail'){assert.equal(after,before);assert.deepEqual(fs.readFileSync(index),beforeIndex);}
    assert.equal(rpc.filter(r=>r.tool==='record_commit').at(-1)?.args.code,'MOE_COMMIT_FAILED_GATE');
  }else{
    if(mode!=='no-change')assert.notEqual(after,before,log);
    if(candidates.length)assert.equal(git(repo,'rev-parse','HEAD^{tree}'),candidates.at(-1).args.treeSha);
    assert.equal(refs.length,0);assert.equal(read(owned),mode==='shared-mutation'?'late shared\n':mode==='no-change'?'base\n':'frozen owned\n');
  }
  if(['disabled','deferred','workspace-failure'].includes(mode))assert.equal(checks.length,0);
  if(mode==='exit-tail'){assert.equal(checks.length,1,log);assert.equal(checks[0].args.exitCode,37);assert.ok(checks[0].args.outputTail.endsWith('TAILEND'));
    let expected=Buffer.from('é😀'.repeat(5000)+'TAILEND').subarray(-16384);
    while(expected.length&&(expected[0]&0xc0)===0x80)expected=expected.subarray(1);
    assert.equal(checks[0].args.outputTail,expected.toString('utf8'));
    assert.ok(rpc.some(r=>r.tool==='add_comment'&&r.args.content.includes('TAILEND')),'failure comment keeps output tail');
    assert.ok(Buffer.byteLength(checks[0].args.outputTail)>16000,'tail bytes='+Buffer.byteLength(checks[0].args.outputTail)+' prefix='+JSON.stringify(checks[0].args.outputTail.slice(0,16)));}
  if(mode==='unborn'){
    assert.equal(candidates.length,1,log);assert.equal(candidates[0].args.baseRevision,EMPTY_TREE,'unborn base is the empty tree object');
    assert.equal(git(repo,'rev-list','--parents','-n','1','HEAD'),after,'unborn landing is a parentless root commit');
    assert.equal(checks.length,1,log);assert.equal(checks[0].args.exitCode,0);
  }
  if(['tracked-mutation','hidden-mutation','skip-worktree-mutation','index-mutation','head-mutation'].includes(mode)){
    assert.equal(checks.length,1,log);assert.equal(checks[0].args.exitCode,0,'integrity refusal keeps the actual exit code');
    assert.equal(checks[0].args.outcome,'inconclusive','an exit-0 gate that mutated its checkout is never a passing run\n'+log);}
  if(mode==='pass')assert.deepEqual(checks.map(r=>[r.args.exitCode,r.args.outcome]),[[0,'passed']],log);
  if(mode==='receipt-cached-check'){
    assert.ok(fs.existsSync(path.join(repo,'.git','moe-cas-refused')),'git refused the first CAS\n'+log);
    assert.equal(candidates.length,1,log);assert.equal(checks.length,1,log);
    assert.equal(seen.length,1,'an unchanged tree and base reuse the passed check\n'+log);assert.ok(log.includes('qualityGate result reused'),log);
  }
  if(mode==='receipt-same-tree-race'){
    assert.equal(candidates.length,2,log);assert.equal(candidates[0].args.treeSha,candidates[1].args.treeSha,'the empty peer commit keeps the tree\n'+log);
    assert.notEqual(candidates[0].args.baseRevision,candidates[1].args.baseRevision,log);
    assert.deepEqual(checks.map(r=>r.args.candidateId),candidates.map(r=>r.args.id),'a new base reruns the gate even on the same tree\n'+log);
    assert.equal(log.includes('qualityGate result reused'),false,log);
  }
  const generalChat=rows(path.join(nested,'.moe','messages','chan-general.jsonl')).map(m=>String(m.content));
  if(mode==='receipt-push'){
    assert.equal(git(path.join(root,mode+'-remote.git'),'rev-parse','refs/heads/moe/frozen'),after,'the landing reached the remote\n'+log);
    assert.equal(generalChat.some(m=>m.startsWith('PUSH FAILED')),false,log);
  }
  if(mode==='receipt-push-failed')assert.ok(generalChat.some(m=>m.startsWith('PUSH FAILED for task task-postflight')),log);
  if(mode==='receipt-push-rejected'){
    // The remote moved under the landing: the push is rejected and announced, and
    // the shared checkout is left exactly as it was -- no pull --rebase, no
    // rewritten commit, no peer bytes pulled in, no rebase state left behind.
    const peerTip=git(path.join(root,mode+'-remote.git'),'rev-parse','refs/heads/moe/frozen');
    assert.ok(log.includes('not rebasing a shared checkout'),'a rejected push is announced, not repaired\n'+log);
    assert.equal(log.includes('trying git pull --rebase'),false,log);
    assert.equal(fs.existsSync(path.join(repo,'.git','rebase-merge'))||fs.existsSync(path.join(repo,'.git','rebase-apply')),false,'no rebase state is left behind\n'+log);
    assert.notEqual(peerTip,after,log);
    assert.notEqual(cp.spawnSync('git',['-C',repo,'cat-file','-e',peerTip+'^{commit}']).status,0,'the peer commit is never even fetched\n'+log);
    assert.equal(git(repo,'rev-parse','HEAD'),after,log);
    assert.ok(generalChat.some(m=>m.startsWith('PUSH FAILED for task task-postflight')),log);
  }
  if(mode==='cleanup-retry'){
    assert.equal(checks.length,1,log);assert.equal(checks[0].args.exitCode,0);assert.equal(pushBlocked,false,log);
    assert.ok(log.split('Cannot remove owned qualityGate workspace').length>2,'a failed cleanup is reported and retried\n'+log);
    const locked=git(repo,'worktree','list','--porcelain').split('\n\n').filter(b=>/\nlocked/.test(b)).map(b=>b.split('\n')[0].slice('worktree '.length));
    assert.equal(locked.length,1,'the locked gate workspace is still registered\n'+log);
    git(repo,'worktree','unlock',locked[0]);git(repo,'worktree','remove','--force',locked[0]);
    fs.rmSync(path.dirname(locked[0]),{recursive:true,force:true});
  }
  if(mode==='finalize-loss'||mode==='finalize-loss-once'){
    assert.equal(finals.length,mode==='finalize-loss'?3:2,log);
    for(const f of finals)assert.deepEqual(f.args,finals[0].args);
    assert.equal(rpc.filter(r=>r.tool==='record_commit'&&r.args.kind==='completion').length,1);
  }else assert.equal(finals.length,noFinal.includes(mode)?0:1,log);
  for(const f of finals){assert.equal(f.args.attemptId,'attempt-postflight',log);assert.equal(f.args.generation,7,log);}
  if(finals.length){assert.equal(finals[0].args.outcome,failed?'rescued':mode==='no-change'?'nothing-to-commit':'landed');
    if(!failed&&mode!=='no-change')assert.equal(finals[0].args.landedRevision,after);}
  // Delivery receipts: one per landed gated candidate -- after its ledger row,
  // before its finalize, naming that candidate and the CAS base -- none for any
  // other exit. A journal outlives its landing only while the receipt is not
  // recorded (refused); a conflicting receipt already records it. Neither
  // bookkeeping failure touches the landing, its ledger row or its finalize.
  const receipts=rpc.filter(r=>r.tool==='record_delivery_receipt'),refusedReceipt=mode==='receipt-refused';
  assert.deepEqual(fs.existsSync(path.dirname(journal))?fs.readdirSync(path.dirname(journal)):[],refusedReceipt?['task-postflight.json']:[],
    'a journal outlives its landing only while its receipt is unrecorded\n'+log);
  if(!failed&&candidates.length&&after!==before){
    const c=candidates.at(-1).args,r=receipts[0]?.args||{};
    const ledgerAt=rpc.findIndex(x=>x.tool==='record_commit'&&x.args.outcome==='committed'&&x.args.kind==='completion');
    assert.equal(receipts.length,1,'a landed gated candidate records exactly one delivery receipt\n'+log);
    assert.deepEqual([r.candidateId,r.target,r.targetBefore,r.targetAfter,r.landedRevision],
      [c.id,c.deliveryTarget,mode==='unborn'?ZERO_OID:c.baseRevision,after,after],log);
    if(mode==='receipt-push-failed'){assert.match(String(r.pushResult),/^push failed: fatal: .+$/,log);assert.ok(r.pushResult.length<=500,log);}
    else if(mode==='receipt-push-rejected'){assert.match(String(r.pushResult),/^push failed: error: failed to push some refs to /,log);assert.ok(r.pushResult.length<=500,log);}
    else assert.equal(r.pushResult,mode==='receipt-push'?'pushed moe/frozen':undefined,log);
    if(!mode.startsWith('receipt-push'))assert.ok(log.includes('no git remote configured; push skipped'),'no remote, no push attempt\n'+log);
    assert.ok(ledgerAt>=0&&ledgerAt<rpc.indexOf(receipts[0]),'the receipt follows the ledger row\n'+log);
    if(finals.length)assert.ok(rpc.indexOf(receipts[0])<rpc.indexOf(finals[0]),'the receipt precedes the finalize\n'+log);
    assert.equal(fs.existsSync(path.join(nested,'.moe','receipts',c.id+'.json')),!refusedReceipt&&mode!=='receipt-conflict',log);
    if(refusedReceipt){assert.ok(log.includes('delivery receipt not recorded for candidate '+c.id),log);
      assert.deepEqual(JSON.parse(read(journal)),{taskId:'task-postflight',workerId:'worker-frozen',attemptId:'attempt-postflight',generation:7,
        candidateId:c.id,target:c.deliveryTarget,targetBefore:c.baseRevision,targetAfter:after,landedRevision:after,pushResult:null},
        'a refused receipt stays journaled verbatim for the next pre-flight\n'+log);}
    if(mode==='receipt-conflict')assert.ok(log.includes('already has a delivery receipt that differs from this report'),log);
  }else assert.equal(receipts.length,0,'only a landed gated candidate records a delivery receipt\n'+log);
  assert.equal(read(path.join(nested,'helper.txt')),'dirty helper\n');assert.equal(read(path.join(nested,'peer.txt')),'peer bytes\n');
  assert.equal(fs.existsSync(path.join(nested,'scratch.txt')),false);
  if(mode.startsWith('interrupt-')){
    assert.equal(checks.length,1,'started interrupted command must have an observed exit');
    assert.notEqual(checks[0].args.exitCode,0);
    const rescueAt=rpc.findIndex(r=>r.tool==='record_commit'&&r.args.kind==='rescue');
    assert.ok(rescueAt>=0&&rpc.findIndex(r=>r.tool==='deregister_worker')>rescueAt,'rescue before deregister');
    assert.equal(read(owned),'late shared\n');
    for(const o of seen)for(const pid of [o.pid,o.childPid]){
      let alive=true,detail='';try{process.kill(pid,0);}catch(e){alive=false;}
      if(alive&&process.platform==='win32'){
        const ps="$p=Get-CimInstance Win32_Process -Filter 'ProcessId="+pid+"';if($p){@{created=$p.CreationDate.ToUniversalTime().ToString('o');command=$p.CommandLine}|ConvertTo-Json -Compress}";
        detail=cp.execFileSync('powershell.exe',['-NoProfile','-Command',ps],{encoding:'utf8'}).trim();
        if(!detail)alive=false;
        else if(Date.parse(JSON.parse(detail).created)>Date.parse(o.recordedAt)){console.log('[cleanup] Windows reused exited gate PID '+pid+' '+detail);alive=false;}
      }
      assert.equal(alive,false,'gate process leaked: '+pid+' '+detail);
    }
  }

  assert.equal(git(repo,'worktree','list','--porcelain').split('\n').filter(l=>l.startsWith('worktree ')).length,1);
  for(const o of seen)assert.equal(fs.existsSync(path.dirname(o.cwd)),false,'owned gate workspace must be deleted');
  count++;
}
console.log('PASS frozen candidate scenarios: '+count);
}catch(e){console.error('FROZEN FIXTURE '+root);throw e;}
finally{if(!process.env.MOE_KEEP_FROZEN_FIXTURE)for(const d of [root,wrapperTmp])fs.rmSync(d,{recursive:true,force:true,maxRetries:10,retryDelay:200});}

'@, [Text.UTF8Encoding]::new($false))
    & node $frozenSuite ps1 $wrapper $fakeProxy $tempRoot $psExe
    if ($LASTEXITCODE -ne 0) { throw 'Frozen candidate scenarios failed' }
    if ($env:MOE_FROZEN_TEST_ONLY) { exit 0 }
    # Owner guard cases (one suite shared with postflight.sh).
    & node (Join-Path $root 'scripts\tests\postflight-owner-guard.cjs') ps1 $wrapper $fakeProxy $tempRoot $psExe
    if ($LASTEXITCODE -ne 0) { throw 'Owner guard scenarios failed' }
    # Migration landing cases (one suite shared with postflight.sh).
    & node (Join-Path $root 'scripts\tests\postflight-migration.cjs') ps1 $wrapper $fakeProxy $tempRoot $psExe
    if ($LASTEXITCODE -ne 0) { throw 'Migration landing scenarios failed' }
    # Worktree provisioning cases (one suite shared with postflight.sh).
    & node (Join-Path $root 'scripts\tests\postflight-worktree.cjs') ps1 $wrapper $fakeProxy $tempRoot $psExe
    if ($LASTEXITCODE -ne 0) { throw 'Worktree provisioning scenarios failed' }

    $trueCmd = Join-Path $tempRoot 'true.cmd'
    Set-Content -Path $trueCmd -Encoding ASCII -Value "@echo off`r`nexit /b 0`r`n"

    # A "slow" fake CLI that sleeps a few seconds before exiting, standing in
    # for a long silent verification step with no moe.* calls of its own —
    # exactly the scenario the heartbeat sidecar exists to cover. It also
    # records the runner identity it was handed: a QA seat gets the wrapper's
    # own pair, which moe-proxy stamps onto a claim made inside the session.
    $slowRunnerEnv = Join-Path $tempRoot 'slow-runner-env.txt'
    $slowCmd = Join-Path $tempRoot 'slow.cmd'
    Set-Content -Path $slowCmd -Encoding ASCII -Value "@echo off`r`n(echo %MOE_RUNNER_PROCESS_STARTED_AT%&echo %MOE_RUNNER_HOST%)> `"$slowRunnerEnv`"`r`nping -n 6 127.0.0.1 >nul`r`nexit /b 0`r`n"

    # Fake Grok Build CLI, literally named grok.cmd: the wrapper strips the
    # extension before matching the basename, so this shim takes the grok
    # launch branch. It records its argv to FAKE_GROK_ARGV_FILE (and its cwd
    # to <that>.cwd), copies the --prompt-file (argv 2 in headless mode) to
    # FAKE_GROK_PROMPT_COPY when set, dirties .grok/config.toml mid-session
    # when FAKE_GROK_TOUCH_CONFIG=1 (the DENY-tier discriminator: a config
    # changed since the baseline would otherwise be MEASURED-committed), and
    # exits with FAKE_GROK_EXIT (0 by default).
    $grokCmd = Join-Path $tempRoot 'grok.cmd'
    Set-Content -Path $grokCmd -Encoding ASCII -Value ("@echo off`r`n" +
        "echo %* > `"%FAKE_GROK_ARGV_FILE%`"`r`n" +
        "echo %CD%> `"%FAKE_GROK_ARGV_FILE%.cwd`"`r`n" +
        "if defined FAKE_GROK_PROMPT_COPY copy /y `"%~2`" `"%FAKE_GROK_PROMPT_COPY%`" >nul`r`n" +
        "if defined FAKE_GROK_TOUCH_CONFIG echo # touched by the session>> `"%MOE_PROJECT_PATH%\.grok\config.toml`"`r`n" +
        "if defined FAKE_GROK_EXIT exit /b %FAKE_GROK_EXIT%`r`n" +
        "exit /b 0`r`n")

    # Fake codex CLI, literally named codex.ps1: the wrapper strips the
    # extension before matching the basename, and a .ps1 shim receives argv
    # verbatim (no cmd.exe re-quoting of the prose prompt codex gets as a
    # positional). Records argv one per line to FAKE_CODEX_ARGV_FILE and exits
    # with FAKE_CODEX_EXIT (0 by default).
    # Fake codex CLI, literally named codex.cmd (basename match). A native .cmd front
    # that runs a child powershell -File codex-impl.ps1 with the same argv: the child
    # is a real process, so its stderr and exit code reach the wrapper the way the real
    # codex.exe's do (an in-process .ps1 shim's [Console]::Error bypasses 2>&1). The
    # impl appends argv one token per line to FAKE_CODEX_ARGV_FILE (the wrapper may
    # invoke codex several times per launch: the argv probe, --version, the launch;
    # each run removes the file), answers --version, and with FAKE_CODEX_REJECT_ARGV=1
    # fails every invocation the way clap does for a flag the CLI no longer accepts.
    $codexImpl = Join-Path $tempRoot 'codex-impl.ps1'
    Set-Content -Path $codexImpl -Encoding ASCII -Value ("`$args | Add-Content -Path `$env:FAKE_CODEX_ARGV_FILE`r`n" +
        "if (`$env:FAKE_CODEX_REJECT_ARGV -eq '1') { [Console]::Error.WriteLine(`"error: unexpected argument '--sandbox' found`"); exit 2 }`r`n" +
        "if (`$args -contains '--version') { 'codex-cli 0.0.0-fake'; exit 0 }`r`n" +
        "if (`$env:FAKE_CODEX_EXIT) { exit [int]`$env:FAKE_CODEX_EXIT }`r`n" +
        "exit 0`r`n")
    $codexCmd = Join-Path $tempRoot 'codex.cmd'
    Set-Content -Path $codexCmd -Encoding ASCII -Value ("@echo off`r`n" +
        "powershell -NoProfile -ExecutionPolicy Bypass -File `"%~dp0codex-impl.ps1`" %*`r`n" +
        "exit /b %ERRORLEVEL%`r`n")

    # File-creating fake CLIs. The ps1 claude launch does NOT cd into the
    # project (it binds via MOE_PROJECT_PATH), so every path is written via
    # %MOE_PROJECT_PATH% — a relative path would land in the harness cwd.
    # create-file.cmd also writes FAKE_CLI_EXTRA_FILE when set (a Bash-style,
    # unwitnessed write of a peer-declared path).
    $createFileCmd = Join-Path $tempRoot 'create-file.cmd'
    Set-Content -Path $createFileCmd -Encoding ASCII -Value ("@echo off`r`necho new> `"%MOE_PROJECT_PATH%\session-new.txt`"`r`n" +
        "if defined FAKE_CLI_EXTRA_FILE echo extra> `"%MOE_PROJECT_PATH%\%FAKE_CLI_EXTRA_FILE%`"`r`n" +
        "exit /b 0`r`n")
    $createPeerCmd = Join-Path $tempRoot 'create-peer.cmd'
    Set-Content -Path $createPeerCmd -Encoding ASCII -Value "@echo off`r`necho new> `"%MOE_PROJECT_PATH%\session-new.txt`"`r`necho peer> `"%MOE_PROJECT_PATH%\peer-plan.txt`"`r`nexit /b 0`r`n"
    # Rewrites the task's OWN board record and a peer's record mid-session
    # (what the daemon does on every tool call).
    $touchBoardCmd = Join-Path $tempRoot 'touch-board.cmd'
    Set-Content -Path $touchBoardCmd -Encoding ASCII -Value ("@echo off`r`n" +
        "echo {`"id`":`"task-postflight`",`"title`":`"Postflight smoke`",`"status`":`"WORKING`",`"filesModified`":[`"owned-a.txt`"],`"touchedBySession`":1}> `"%MOE_PROJECT_PATH%\.moe\tasks\task-postflight.json`"`r`n" +
        "echo {`"id`":`"task-peer`",`"title`":`"Peer task`",`"status`":`"WORKING`",`"assignedWorkerId`":`"worker-peer`",`"filesModified`":[`"peer-plan.txt`"],`"touchedBySession`":1}> `"%MOE_PROJECT_PATH%\.moe\tasks\task-peer.json`"`r`n" +
        "exit /b 0`r`n")
    # Stream-json emitter: a synthetic content_block_start/delta/stop sequence
    # for a Write tool_use on tool-written.txt (absolute path, as Claude Code
    # emits it) plus a non-streamed `assistant` message carrying a full Edit
    # tool_use.input on tool-edited.txt — and it writes both files. Complete
    # assistant blocks plus successful matching results prove those writes;
    # partial display events alone must never confer attribution.
    $streamJsonCmd = Join-Path $tempRoot 'stream-json.cmd'
    Set-Content -Path $streamJsonCmd -Encoding ASCII -Value ("@echo off`r`n" +
        "echo tool> `"%MOE_PROJECT_PATH%\tool-written.txt`"`r`n" +
        "echo tool> `"%MOE_PROJECT_PATH%\tool-edited.txt`"`r`n" +
        "echo {`"type`":`"stream_event`",`"event`":{`"type`":`"content_block_start`",`"content_block`":{`"type`":`"tool_use`",`"id`":`"t1`",`"name`":`"Write`"}}}`r`n" +
        "echo {`"type`":`"stream_event`",`"event`":{`"type`":`"content_block_delta`",`"delta`":{`"type`":`"input_json_delta`",`"partial_json`":`"{\`"file_path\`":\`"%MOE_PROJECT_PATH:\=/%/tool-written.txt\`",\`"content\`":\`"tool\`"}`"}}}`r`n" +
        "echo {`"type`":`"stream_event`",`"event`":{`"type`":`"content_block_stop`"}}`r`n" +
        "echo {`"type`":`"assistant`",`"message`":{`"content`":[{`"type`":`"tool_use`",`"id`":`"t1`",`"name`":`"Write`",`"input`":{`"file_path`":`"%MOE_PROJECT_PATH:\=/%/tool-written.txt`"}}]}}`r`n" +
        "echo {`"type`":`"user`",`"message`":{`"content`":[{`"type`":`"tool_result`",`"tool_use_id`":`"t1`",`"is_error`":false,`"content`":`"ok`"}]}}`r`n" +
        "echo {`"type`":`"assistant`",`"message`":{`"content`":[{`"type`":`"tool_use`",`"id`":`"t2`",`"name`":`"Edit`",`"input`":{`"file_path`":`"%MOE_PROJECT_PATH:\=/%/tool-edited.txt`",`"old_string`":`"a`",`"new_string`":`"b`"}}]}}`r`n" +
        "echo {`"type`":`"user`",`"message`":{`"content`":[{`"type`":`"tool_result`",`"tool_use_id`":`"t2`",`"is_error`":false,`"content`":`"ok`"}]}}`r`n" +
        "exit /b 0`r`n")
    # Serena emitter (scenario K2): writes six files, then replays
    # serena-stream.jsonl, the same transcript as postflight.sh's SERENA_CLI:
    # Serena's current editing tools with Serena's own result texts, each a
    # complete tool_use plus its successful matching tool_result. refused.txt
    # is named only by calls that changed nothing.
    $serenaStreamJsonl = Join-Path $tempRoot 'serena-stream.jsonl'
    Set-Content -Path $serenaStreamJsonl -Encoding ASCII -Value @'
{"type":"system","subtype":"init","tools":[],"mcp_servers":[],"model":"fake"}
{"type":"assistant","message":{"content":[{"type":"tool_use","id":"serena-content","name":"mcp__serena__replace_content","input":{"relative_path":"contested.txt","needle":"old","repl":"serena","mode":"literal"}}]}}
{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"serena-content","is_error":false,"content":[{"type":"text","text":"OK"}]}]}}
{"type":"assistant","message":{"content":[{"type":"tool_use","id":"serena-files-text","name":"mcp__serena__replace_in_files","input":{"needle":"old","repl":"serena","mode":"literal"}}]}}
{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"serena-files-text","is_error":false,"content":"Replaced 3 occurrence(s) in 2 file(s):\n  multi-a.txt: 2\n  multi-b.txt: 1"}]}}
{"type":"assistant","message":{"content":[{"type":"tool_use","id":"serena-files-diag","name":"mcp__serena__replace_in_files","input":{"needle":"old","repl":"serena","mode":"literal","relative_path":"sub dir"}}]}}
{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"serena-files-diag","is_error":false,"content":[{"type":"text","text":"{\"result\": \"Replaced 1 occurrence(s) in 1 file(s):\\n  sub dir\\\\diag.txt: 1\", \"diagnostics[warning-or-higher]\": {\"sub dir\\\\diag.txt\": {}}}"}]}]}}
{"type":"assistant","message":{"content":[{"type":"tool_use","id":"serena-rename","name":"mcp__serena__rename_symbol","input":{"name_path":"Foo","relative_path":"rename-decl.txt","new_name":"Bar"}}]}}
{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"serena-rename","is_error":false,"content":[{"type":"text","text":"Successfully renamed 'Foo' to 'Bar' (1 changes applied)"}]}]}}
{"type":"assistant","message":{"content":[{"type":"tool_use","id":"serena-delete","name":"mcp__serena__safe_delete_symbol","input":{"name_path_pattern":"Baz","relative_path":"refused.txt"}}]}}
{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"serena-delete","is_error":false,"content":[{"type":"text","text":"Cannot delete, the symbol Baz is referenced in: {\"multi-a.txt\": [3]}"}]}]}}
{"type":"assistant","message":{"content":[{"type":"tool_use","id":"serena-dry-run","name":"mcp__serena__replace_in_files","input":{"needle":"old","repl":"serena","mode":"literal","dry_run":true}}]}}
{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"serena-dry-run","is_error":false,"content":[{"type":"text","text":"Found 1 occurrence(s) in 1 file(s). DRY RUN - no changes were applied.\n\nrefused.txt (1 occurrence(s)):\n  refused.txt: 1"}]}]}}
{"type":"assistant","message":{"content":[{"type":"tool_use","id":"serena-rename-failed","name":"mcp__serena__rename_symbol","input":{"name_path":"Baz","relative_path":"refused.txt","new_name":"Qux"}}]}}
{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"serena-rename-failed","is_error":false,"content":[{"type":"text","text":"Error executing tool: ValueError: Renaming symbol 'Baz' to 'Qux' resulted in no changes being applied"}]}]}}
{"type":"result","num_turns":1,"duration_ms":10,"stop_reason":"end_turn"}
'@
    $serenaStreamCmd = Join-Path $tempRoot 'serena-stream.cmd'
    Set-Content -Path $serenaStreamCmd -Encoding ASCII -Value ("@echo off`r`n" +
        "mkdir `"%MOE_PROJECT_PATH%\sub dir`"`r`n" +
        "for %%f in (contested.txt multi-a.txt multi-b.txt rename-decl.txt refused.txt) do echo serena> `"%MOE_PROJECT_PATH%\%%f`"`r`n" +
        "echo serena> `"%MOE_PROJECT_PATH%\sub dir\diag.txt`"`r`n" +
        "type `"%~dp0serena-stream.jsonl`"`r`n" +
        "exit /b 0`r`n")
    # CAS-contention hook (MOE_POSTFLIGHT_TEST_HOOK_PRE_UPDATE_REF): moves the
    # branch tip between commit-tree and update-ref by committing a peer file.
    $hookPeerCmd = Join-Path $tempRoot 'hook-peer.cmd'
    Set-Content -Path $hookPeerCmd -Encoding ASCII -Value ("@echo off`r`n" +
        "echo peer-hook> `"%MOE_PROJECT_PATH%\peer-hook.txt`"`r`n" +
        "git -C `"%MOE_PROJECT_PATH%`" add peer-hook.txt`r`n" +
        "git -C `"%MOE_PROJECT_PATH%`" commit -qm peer-hook`r`n" +
        "exit /b 0`r`n")

    $oldProxy = $env:MOE_PROXY_PATH
    $oldUserProfile = $env:USERPROFILE
    $oldTemp = $env:TEMP
    $env:MOE_PROXY_PATH = $fakeProxy
    $env:USERPROFILE = $homeDir
    $env:TEMP = $tempRoot
    $wrapperOut = Join-Path $tempRoot 'wrapper.out'
    $wrapperResumeOut = Join-Path $tempRoot 'wrapper-resume.out'
    try {
        $ErrorActionPreference = 'Continue'
        $wrapperCode = Invoke-WrapperProcess @('-Project', $projectDir, '-WorkerId', 'worker-postflight', '-Role', 'worker', '-Team', 'Smoke', '-NoStartDaemon', '-Command', $trueCmd, '-Loop', '-PollInterval', '0') $wrapperOut

        # --- Resume path: a worker that already holds an active task (its
        # previous CLI died mid-task) gets hasNext:false + alreadyAssigned from
        # claim_next_task. The wrapper must treat that as a claim and relaunch
        # the CLI instead of idle-looping on "No claimable task". ---
        $env:FAKE_CLAIM_MODE = 'resume'
        try {
            $resumeCode = Invoke-WrapperProcess @('-Project', $projectDir, '-WorkerId', 'qa-postflight', '-Role', 'qa', '-Team', 'Smoke', '-NoStartDaemon', '-Command', $trueCmd, '-Loop', '-PollInterval', '0') $wrapperResumeOut
        } finally {
            Remove-Item Env:FAKE_CLAIM_MODE -ErrorAction SilentlyContinue
        }

        # --- Per-task tier: a claim carrying launch {tier, effort} launches the
        # CLI with that effort and prints the tier banner (sh twin parity). ---
        $tierArgsFile = Join-Path $tempRoot 'cli-args-tier.txt'
        $tierCmd = Join-Path $tempRoot 'tier.cmd'
        Set-Content -Path $tierCmd -Encoding ASCII -Value "@echo off`r`necho %* > `"$tierArgsFile`"`r`nexit /b 0`r`n"
        $wrapperTierOut = Join-Path $tempRoot 'wrapper-tier.out'
        $env:FAKE_CLAIM_MODE = 'resume'
        $env:FAKE_CLAIM_LAUNCH = '{"tier":"light","effort":"medium"}'
        try {
            $tierCode = Invoke-WrapperProcess @('-Project', $projectDir, '-WorkerId', 'qa-postflight', '-Role', 'qa', '-Team', 'Smoke', '-NoStartDaemon', '-Command', $tierCmd, '-Loop', '-PollInterval', '0') $wrapperTierOut
        } finally {
            Remove-Item Env:FAKE_CLAIM_MODE -ErrorAction SilentlyContinue
            Remove-Item Env:FAKE_CLAIM_LAUNCH -ErrorAction SilentlyContinue
        }
        if ($tierCode -ne 0) { Get-Content $wrapperTierOut -ErrorAction SilentlyContinue | ForEach-Object { Write-Error $_ }; throw "Tier wrapper exited with $tierCode" }
        $tierArgs = if (Test-Path $tierArgsFile) { Get-Content -Raw -Path $tierArgsFile } else { '' }
        if ($tierArgs -notlike '*--effort medium*') { Write-Host $tierArgs; throw 'Expected --effort medium from the claim''s launch tier' }
        if ((Get-Content -Raw -Path $wrapperTierOut) -notlike '*Task tier: light (model*') { Get-Content $wrapperTierOut | ForEach-Object { Write-Error $_ }; throw 'Expected the task tier banner' }

        # --- Account rotation (twin of postflight.sh [accounts]). A claude
        # launch whose account is refused at its limit, or found signed out,
        # relaunches at once on the next account, even under -NoLoop and
        # without the launch-failure backoff; a lease that finds every account
        # spent waits and leases again. The fake CLI tells its account by
        # CLAUDE_CONFIG_DIR and answers `auth status --json` like claude; no
        # token may reach it, and no directory may reach the daemon. ---
        $acctHome = Join-Path $tempRoot 'acct-home'
        $acct1Dir = Join-Path $acctHome 'acct-1'
        $acct2Dir = Join-Path $acctHome 'acct-2'
        New-Item -ItemType Directory -Force -Path $acct1Dir, $acct2Dir | Out-Null
        $acctLog = Join-Path $tempRoot 'acct-cli.log'
        $acctRpcs = Join-Path $projectDir '.moe\account-rpcs.jsonl'
        $acctReset = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds() + 3600
        $spentEvent = '{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","resetsAt":' + $acctReset + ',"rateLimitType":"five_hour","overageStatus":"rejected","isUsingOverage":false,"unifiedWindows":{"five_hour":{"utilization":1,"resetsAt":' + $acctReset + '}}}}'
        $fineEvent = '{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","resetsAt":' + $acctReset + ',"rateLimitType":"five_hour","isUsingOverage":false,"unifiedWindows":{"five_hour":{"utilization":0.42,"resetsAt":' + $acctReset + '}}}}'
        $acctCmd = Join-Path $tempRoot 'acct.cmd'
        # FAKE_ACCT_MODE: unset = acct-1 is spent, signout = acct-1 is signed
        # out, fine = every account works.
        Set-Content -Path $acctCmd -Encoding ASCII -Value (@(
            '@echo off',
            'if "%~1"=="auth" goto auth',
            'if defined CLAUDE_CODE_OAUTH_TOKEN (set "ACCT_TOKEN=set") else (set "ACCT_TOKEN=unset")',
            "echo dir=%CLAUDE_CONFIG_DIR% token=%ACCT_TOKEN%>> `"$acctLog`"",
            'if "%FAKE_ACCT_MODE%"=="fine" goto fine',
            "if /I not `"%CLAUDE_CONFIG_DIR%`"==`"$acct1Dir`" goto fine",
            'if "%FAKE_ACCT_MODE%"=="signout" exit /b 1',
            "echo $spentEvent",
            'exit /b 1',
            ':fine',
            "echo $fineEvent",
            'exit /b 0',
            ':auth',
            "if /I not `"%CLAUDE_CONFIG_DIR%`"==`"$acct1Dir`" goto authok",
            'if not "%FAKE_ACCT_MODE%"=="signout" goto authok',
            'echo {"loggedIn":false,"authMethod":"none"}',
            'exit /b 1',
            ':authok',
            'echo {"loggedIn":true,"authMethod":"claude.ai"}',
            'exit /b 0'
        ) -join "`r`n")
        function Invoke-AccountScenario([string]$Name, [hashtable]$ScenarioEnv) {
            Remove-Item -LiteralPath $acctLog, $acctRpcs -Force -ErrorAction SilentlyContinue
            $out = Join-Path $tempRoot "wrapper-accounts-$Name.out"
            $vars = @{ FAKE_CLAIM_MODE = 'resume'; MOE_ACCOUNT_ROTATION = 'on'; FAKE_ACCOUNT_HOME = $acctHome; FAKE_ACCT_MODE = $null
                FAKE_ACCOUNT_WAIT_ONCE = $null; MOE_ACCOUNT_RETRY_SEC = '1'; MOE_DISABLE_HEARTBEAT = '1'; CLAUDE_CODE_OAUTH_TOKEN = 'must-not-reach-the-child'
                CLAUDE_CODE_USE_BEDROCK = $null; CLAUDE_CODE_USE_VERTEX = $null; CLAUDE_CODE_USE_FOUNDRY = $null }
            foreach ($k in $ScenarioEnv.Keys) { $vars[$k] = $ScenarioEnv[$k] }
            $saved = @{}
            foreach ($k in @($vars.Keys)) { $saved[$k] = [Environment]::GetEnvironmentVariable($k); [Environment]::SetEnvironmentVariable($k, $vars[$k]) }
            try {
                $code = Invoke-WrapperProcess @('-Project', $projectDir, '-WorkerId', "qa-accounts-$Name", '-Role', 'qa', '-Team', 'Smoke', '-NoStartDaemon', '-Command', $acctCmd, '-NoLoop') $out
            } finally {
                foreach ($k in @($saved.Keys)) { [Environment]::SetEnvironmentVariable($k, $saved[$k]) }
            }
            [pscustomobject]@{
                Name = $Name; Code = $code
                Out = $(if (Test-Path $out) { Get-Content -Raw -Path $out } else { '' })
                Launches = @($(if (Test-Path $acctLog) { Get-Content -Path $acctLog | ForEach-Object { $_.Trim() } }))
                Rpcs = @($(if (Test-Path $acctRpcs) { Get-Content -Path $acctRpcs | ForEach-Object { $_ | ConvertFrom-Json } }))
                RpcText = $(if (Test-Path $acctRpcs) { Get-Content -Raw -Path $acctRpcs } else { '' })
            }
        }
        function Assert-AccountScenario($R, [string[]]$Want, [string[]]$Launches) {
            $fail = { param($why) Write-Host $R.Out; $R.Launches | ForEach-Object { Write-Host "launch: $_" }; throw "[accounts] $($R.Name): $why" }
            if ($R.Code -ne 0) { & $fail "wrapper exited with $($R.Code)" }
            foreach ($w in $Want) { if (-not $R.Out.Contains($w)) { & $fail "expected '$w'" } }
            if ($R.Out.Contains('[launch-failure] Backing off')) { & $fail 'an account relaunch must not take the launch-failure backoff' }
            if (($R.Launches -join '|') -ne ($Launches -join '|')) { & $fail "expected launches '$($Launches -join '|')', got '$($R.Launches -join '|')'" }
            if ($R.RpcText.Contains('acct-home')) { & $fail 'an account directory reached the daemon' }
        }

        $r = Invoke-AccountScenario 'refused' @{}
        Assert-AccountScenario $r @('[account] MOE_ACCOUNT_LEASED account=acct-1 usage=12.5%',
            '[account] MOE_ACCOUNT_REFUSED account=acct-1 exit=1 - relaunching on the next account; the held task stays held.',
            '[account] Relaunching now on the next account.', '[account] MOE_ACCOUNT_SWITCHED from=acct-1 to=acct-2',
            '[account] MOE_ACCOUNT_LEASED account=acct-2 usage=unknown') @("dir=$acct1Dir token=unset", "dir=$acct2Dir token=unset")
        $reports = @($r.Rpcs | Where-Object { $_.tool -eq 'report_account_usage' } | ForEach-Object { $_.args })
        $one = @($reports | Where-Object { $_.accountId -eq 'acct-1' })
        $two = @($reports | Where-Object { $_.accountId -eq 'acct-2' })
        if ($one.Count -ne 1 -or $one[0].refused -ne $true -or $one[0].windows.five_hour.utilization -ne 1 -or $one[0].windows.five_hour.status -ne 'rejected') {
            throw "[accounts] refused: expected one refused acct-1 report: $($r.RpcText)"
        }
        if ($two.Count -ne 1 -or $two[0].refused -ne $false -or [double]$two[0].windows.five_hour.utilization -ne 0.42) {
            throw "[accounts] refused: expected one clean acct-2 report: $($r.RpcText)"
        }
        if (@($r.Rpcs | Where-Object { $_.tool -eq 'lease_account' }).Count -ne 2) { throw "[accounts] refused: expected two leases: $($r.RpcText)" }

        $r = Invoke-AccountScenario 'signout' @{ FAKE_ACCT_MODE = 'signout' }
        Assert-AccountScenario $r @('[account] MOE_ACCOUNT_SIGNED_OUT account=acct-1 state=signed_out - relaunching on the next account; the held task stays held.',
            '[account] Relaunching now on the next account.', '[account] MOE_ACCOUNT_SWITCHED from=acct-1 to=acct-2') @("dir=$acct1Dir token=unset", "dir=$acct2Dir token=unset")
        $signIn = @($r.Rpcs | Where-Object { $_.tool -eq 'report_account_usage' -and $_.args.signIn } | ForEach-Object { $_.args })
        if ($signIn.Count -ne 1 -or $signIn[0].accountId -ne 'acct-1' -or $signIn[0].signIn -ne 'signed_out') { throw "[accounts] signout: expected one signed_out report for acct-1: $($r.RpcText)" }

        $r = Invoke-AccountScenario 'wait' @{ FAKE_ACCT_MODE = 'fine'; FAKE_ACCOUNT_WAIT_ONCE = '1' }
        Assert-AccountScenario $r @('[account] MOE_ACCOUNT_WAIT retry_in=1s next_reset=',
            ' - every signed-in account is spent; the held task stays held. (Ctrl+C to stop)', '[account] MOE_ACCOUNT_LEASED account=acct-1') @("dir=$acct1Dir token=unset")
        if (@($r.Rpcs | Where-Object { $_.tool -eq 'lease_account' }).Count -ne 2) { throw "[accounts] wait: expected a spent lease, then a granted one: $($r.RpcText)" }
        Remove-Item -LiteralPath $acctRpcs -Force -ErrorAction SilentlyContinue
        Write-Host '[accounts] ok'

        # --- Heartbeat sidecar: the CLI invocation blocks the wrapper with no
        # moe.* calls of its own for the CLI's whole runtime, so a long silent
        # step (a build, a test run) risks the REVIEW self-heal sweep evicting
        # a still-alive session. $slowCmd stands in for that — it sleeps ~5s
        # making zero tool calls. With a 1s heartbeat interval the sidecar
        # should ping several times DURING that window, and stop promptly once
        # the CLI (and the wrapper) exits — not leak an orphaned process. ---
        $heartbeatLogFile = Join-Path $projectDir '.moe\heartbeat.log'
        $wrapperHeartbeatOut = Join-Path $tempRoot 'wrapper-heartbeat.out'
        $env:MOE_HEARTBEAT_INTERVAL_SEC = '1'
        $env:MOE_HEARTBEAT_MAX_DURATION_SEC = '30'
        try {
            $heartbeatWrapperCode = Invoke-WrapperProcess @('-Project', $projectDir, '-WorkerId', 'qa-heartbeat', '-Role', 'qa', '-Team', 'Smoke', '-NoStartDaemon', '-Command', $slowCmd, '-NoLoop') $wrapperHeartbeatOut
        } finally {
            Remove-Item Env:MOE_HEARTBEAT_INTERVAL_SEC -ErrorAction SilentlyContinue
            Remove-Item Env:MOE_HEARTBEAT_MAX_DURATION_SEC -ErrorAction SilentlyContinue
        }
        $countAtExit = if (Test-Path $heartbeatLogFile) { (Get-Content $heartbeatLogFile | Measure-Object -Line).Lines } else { 0 }
        # The wrapper process (and any Start-Job it spawned) has already
        # exited by the time the call above returns. If Stop-HeartbeatSidecar
        # didn't run, the job would keep pinging past that point — confirm it
        # didn't by checking the count is stable a few seconds later.
        Start-Sleep -Seconds 3
        $countAfterWait = if (Test-Path $heartbeatLogFile) { (Get-Content $heartbeatLogFile | Measure-Object -Line).Lines } else { 0 }

        # Start-Sleep is in-process: no sleep child can be killed on PowerShell.
        # Twin of [idle wait killed]'s clean/error deregistration checks.
        Write-Host '[idle wait killed] clean exit and argv refusal have distinct reasons'
        foreach ($idleMode in @('clean', 'unexpected')) {
            $idleProject = Join-Path $tempRoot "idle-$idleMode"
            $idleOut = Join-Path $tempRoot "idle-$idleMode.out"
            New-Item -ItemType Directory -Force -Path (Join-Path $idleProject '.moe\messages') | Out-Null
            Set-Content -Path (Join-Path $idleProject '.moe\project.json') -Encoding UTF8 -Value '{"id":"proj-idle","settings":{"autoCommit":false}}'
            Set-Content -Path (Join-Path $idleProject '.moe\messages\chan-general.jsonl') -Encoding UTF8 -Value ''
            Set-Content -Path (Join-Path $idleProject '.moe\daemon.json') -Encoding UTF8 -Value (@{port=9876;projectPath=$idleProject} | ConvertTo-Json -Compress)
            $idleCommand = $trueCmd
            $idleExpectedCode = 0
            $idleReason = 'terminal_closed'
            $idleSaved = @{}
            foreach ($key in @('MOE_DISABLE_HEARTBEAT', 'FAKE_CODEX_REJECT_ARGV', 'FAKE_CODEX_ARGV_FILE')) {
                $idleSaved[$key] = [Environment]::GetEnvironmentVariable($key)
            }
            try {
                $env:MOE_DISABLE_HEARTBEAT = '1'
                if ($idleMode -eq 'unexpected') {
                    $idleCommand = $codexCmd
                    $idleExpectedCode = 1
                    $idleReason = 'unexpected_exit:1'
                    $env:FAKE_CODEX_REJECT_ARGV = '1'
                    $env:FAKE_CODEX_ARGV_FILE = Join-Path $tempRoot 'idle-codex-args.txt'
                }
                $idleCode = Invoke-WrapperProcess @('-Project', $idleProject, '-WorkerId', "worker-idle-$idleMode", '-Role', 'worker', '-NoStartDaemon', '-Command', $idleCommand, '-NoLoop') $idleOut
                $idleLog = Get-Content (Join-Path $idleProject '.moe\deregister.log') -ErrorAction SilentlyContinue
                if ($idleCode -ne $idleExpectedCode -or -not ($idleLog -match " worker-idle-$idleMode $idleReason`$")) {
                    Get-Content $idleOut -ErrorAction SilentlyContinue | Write-Host
                    $idleLog | Write-Host
                    throw "IDLE WAIT FAILED: $idleMode exit=$idleCode; expected $idleExpectedCode and $idleReason"
                }
                if ($idleMode -eq 'unexpected' -and -not (Select-String -Path $idleOut -SimpleMatch 'MOE_CLI_ARGV_REJECTED' -Quiet)) {
                    throw 'IDLE WAIT FAILED: argv probe did not refuse'
                }
            } finally {
                foreach ($key in $idleSaved.Keys) { [Environment]::SetEnvironmentVariable($key, $idleSaved[$key]) }
            }
        }
        Write-Host '[idle wait killed] ok'

        function Initialize-ReloadRepo {
            $dir = Split-Path $reloadWrapper
            foreach ($gitArgs in @(@('init', '-q'), @('config', 'user.name', 'Moe Test'),
                @('config', 'user.email', 'moe@test.local'), @('config', 'commit.gpgsign', 'false'),
                @('config', 'core.autocrlf', 'false'), @('add', '-A'), @('commit', '-qm', 'base'))) {
                & git -C $dir @gitArgs 2>$null | Out-Null
                if ($LASTEXITCODE -ne 0) { throw "HOT RELOAD FAILED: git $gitArgs exited $LASTEXITCODE" }
            }
        }
        function Invoke-ReloadCommit([string]$Message) {
            for ($i = 1; $i -le 3; $i++) {
                & git -C (Split-Path $reloadWrapper) commit -qam $Message 2>$null | Out-Null
                if ($LASTEXITCODE -eq 0) { return }
                Start-Sleep -Milliseconds 200
            }
            throw "HOT RELOAD FAILED: could not commit wrapper edit (git exited $LASTEXITCODE)"
        }

        # --- Hot reload keeps ONE wrapper process. An edit to moe-agent.ps1
        # reloads every live seat at the top of its next iteration. df42861
        # handed over with `& <exe> <args>`: the seat kept its console, but the
        # old wrapper stayed blocked on its child for good, one more process
        # per seat per edit (45 wrappers / 5.5 GB after one night, 2026-09-19).
        # Two edits to a COPY (repo-launched seats reload on every edit of the
        # real file) must leave one wrapper process, one runner identity on
        # every claim, and a seat that goes on claiming. ---
        $reloadWrapper = Join-Path $tempRoot 'reload\scripts\moe-agent.ps1'
        $reloadProject = Join-Path $tempRoot 'reload\project'
        New-Item -ItemType Directory -Force -Path @((Split-Path $reloadWrapper), (Join-Path $reloadProject '.moe\messages')) | Out-Null
        Copy-Item -LiteralPath $wrapper -Destination $reloadWrapper
        # Every sibling .mjs helper, not just prompt-cache*.mjs: prompt-cache.mjs
        # imports ./usage-receipt.mjs (58fff3c) and the wrapper runs
        # usage-session.mjs, so the partial copy made the copied seat exit
        # before its first claim ("no first claim ... RPC sequence ''").
        # The sh twin copies the whole scripts/ dir.
        Get-ChildItem -LiteralPath (Split-Path $wrapper) -Filter '*.mjs' | ForEach-Object {
            Copy-Item -LiteralPath $_.FullName -Destination (Split-Path $reloadWrapper)
        }
        Set-Content -Path (Join-Path $reloadProject '.moe\project.json') -Value '{"id":"proj-reload","name":"postflight-reload","settings":{"autoCommit":false}}' -Encoding UTF8
        Set-Content -Path (Join-Path $reloadProject '.moe\messages\chan-general.jsonl') -Value '' -Encoding UTF8
        $reloadRpcLog = Join-Path $reloadProject '.moe\evidence-rpcs.jsonl'
        $reloadOut = Join-Path $tempRoot 'wrapper-reload.out'
        Initialize-ReloadRepo
        function Get-ReloadRows {
            $lines = @(); try { $lines = @(Get-Content -LiteralPath $reloadRpcLog -ErrorAction Stop) } catch {}
            foreach ($line in $lines) { try { $line | ConvertFrom-Json } catch {} }
        }
        # c = claim_next_task, r = a wrapper_restart deregister, x = any other deregister.
        # -Worker counts only that worker's rows.
        function Get-ReloadSequence([string]$Worker = '') {
            -join @(Get-ReloadRows | Where-Object { -not $Worker -or ($_.args -and $_.args.workerId -eq $Worker) } | ForEach-Object {
                if ($_.tool -eq 'claim_next_task') { 'c' }
                elseif ($_.tool -eq 'deregister_worker') { if ($_.args.reason -eq 'wrapper_restart') { 'r' } else { 'x' } }
            })
        }
        function Get-ReloadWrapperPids {
            @(Get-CimInstance Win32_Process -Filter "Name='pwsh.exe' OR Name='powershell.exe'" |
                Where-Object { $_.CommandLine -and $_.CommandLine.Contains($reloadWrapper) } | ForEach-Object { $_.ProcessId })
        }
        function Wait-ReloadSequence([string]$Pattern, [string]$What) {
            $deadline = (Get-Date).AddSeconds($wrapperTimeoutSec)
            while ((Get-Date) -lt $deadline -and -not $reloadProc.HasExited) {
                if ((Get-ReloadSequence) -match $Pattern) { return }
                Start-Sleep -Milliseconds 250
            }
            throw "HOT RELOAD FAILED: no $What (waited up to ${wrapperTimeoutSec}s; wrapper exited: $($reloadProc.HasExited); RPC sequence '$(Get-ReloadSequence)')"
        }
        # The seat hashes its own file every iteration; that read can refuse a
        # concurrent write for a moment.
        function Set-ReloadWrapperText([string]$Text) {
            for ($i = 1; ; $i++) {
                try { [IO.File]::WriteAllText($reloadWrapper, $Text, (New-Object System.Text.UTF8Encoding($true))); return }
                catch { if ($i -ge 20) { throw }; Start-Sleep -Milliseconds 100 }
            }
        }
        $reloadProc = $null
        $reloadCounts = @()
        $env:FAKE_CLAIM_MODE = 'idle'
        $env:MOE_DISABLE_HEARTBEAT = '1'
        try {
            $reloadArgs = @('-NoProfile', '-File', $reloadWrapper, '-Project', $reloadProject, '-WorkerId', 'worker-reload', '-Role', 'worker', '-NoStartDaemon', '-Command', $trueCmd, '-Loop', '-PollInterval', '1') |
                ForEach-Object { if ($_ -match '[\s"]') { '"' + ($_ -replace '"', '\"') + '"' } else { $_ } }
            $reloadProc = Start-Process -FilePath $psExe -ArgumentList $reloadArgs -RedirectStandardOutput $reloadOut -RedirectStandardError "$reloadOut.err" -PassThru -NoNewWindow
            $null = $reloadProc.Handle
            Wait-ReloadSequence '^c' 'first claim'
            # Edit 1 rewrites the restart announcement, which the SECOND reload
            # prints from the reloaded bytes: a reload runs the file on disk.
            $reloadText = [IO.File]::ReadAllText($reloadWrapper)
            $reloadEdited = $reloadText.Replace('restarting to load it"', 'restarting to load it (edit 1 loaded)"')
            if ($reloadEdited -eq $reloadText) { throw 'HOT RELOAD FAILED: the restart announcement is missing from the wrapper' }
            Set-ReloadWrapperText $reloadEdited
            Invoke-ReloadCommit 'edit 1'
            Wait-ReloadSequence '^c+rc' 'claim after reload 1'
            $reloadCounts += @(Get-ReloadWrapperPids).Count
            Set-ReloadWrapperText ($reloadEdited + "# reload 2`n")
            Invoke-ReloadCommit 'edit 2'
            Wait-ReloadSequence '^c+rc+rc' 'claim after reload 2'
            $reloadCounts += @(Get-ReloadWrapperPids).Count
        } finally {
            Remove-Item Env:FAKE_CLAIM_MODE, Env:MOE_DISABLE_HEARTBEAT -ErrorAction SilentlyContinue
            if ($reloadProc -and -not $reloadProc.HasExited) { & taskkill /T /F /PID $reloadProc.Id 2>&1 | Out-Null; $reloadProc.WaitForExit(5000) | Out-Null }
            foreach ($reloadPid in @(Get-ReloadWrapperPids)) { Stop-Process -Id $reloadPid -Force -ErrorAction SilentlyContinue }
        }
        $reloadSeq = Get-ReloadSequence
        $reloadIds = @(Get-ReloadRows | Where-Object { $_.tool -eq 'claim_next_task' } | ForEach-Object { "$($_.args.processStartedAt)|$($_.args.host)" } | Sort-Object -Unique)
        $reloadLog = [string](Get-Content -Raw -LiteralPath $reloadOut -ErrorAction SilentlyContinue) + [string](Get-Content -Raw -LiteralPath "$reloadOut.err" -ErrorAction SilentlyContinue)
        $reloadProblems = @()
        if ($reloadSeq -notmatch '^c+rc+rc+$') { $reloadProblems += "expected claims, then exactly two wrapper_restart deregisters each followed by claims; RPC sequence '$reloadSeq'" }
        if (($reloadCounts -join ',') -ne '1,1') { $reloadProblems += "expected exactly 1 wrapper process after each reload; counted $($reloadCounts -join ' then ')" }
        if ($reloadIds.Count -ne 1 -or $reloadIds[0] -like '|*') { $reloadProblems += "expected every claim to carry one runner identity; got $($reloadIds.Count): $($reloadIds -join '; ')" }
        if ($reloadLog -notlike '*restarting to load it (edit 1 loaded)*') { $reloadProblems += 'the second reload did not run the edited bytes' }
        if ($reloadProblems.Count) { Write-Host $reloadLog; throw ('HOT RELOAD FAILED: ' + ($reloadProblems -join ' | ')) }
        Write-Host '[hot reload] ok: 2 reloads, 1 wrapper process, 1 runner identity'

        # --- Hot reload hold (task-f81c85ac; twin in postflight.sh). The
        # reload's wrapper_restart deregister no longer releases the seat's task:
        # the daemon holds it for the relaunch (task-4ddbfb31), and
        # FAKE_CLAIM_MODE=reload-hold models that hold for two seats sharing one
        # fake. worker-reload claims task-postflight, then reloads in-process on
        # one committed edit, and must get the same task back (alreadyAssigned)
        # and resume it with a fresh resume counter. worker-peer polls the same
        # fake from an unedited copy, so it never reloads; it must never be
        # handed the task, and nothing is released. Only the two Start-Process
        # PIDs are ever killed. ---
        Write-Host '[hot reload hold] a reloading seat keeps its task and resumes it; a polling peer never gets it'
        $reloadWrapper = Join-Path $tempRoot 'reload-hold\scripts\moe-agent.ps1'
        $reloadProject = Join-Path $tempRoot 'reload-hold\project'
        $holdPeerWrapper = Join-Path $tempRoot 'reload-hold-peer\scripts\moe-agent.ps1'
        foreach ($holdCopy in @($reloadWrapper, $holdPeerWrapper)) {
            New-Item -ItemType Directory -Force -Path (Split-Path $holdCopy) | Out-Null
            Copy-Item -LiteralPath $wrapper -Destination $holdCopy
            Get-ChildItem -LiteralPath (Split-Path $wrapper) -Filter '*.mjs' | ForEach-Object {
                Copy-Item -LiteralPath $_.FullName -Destination (Split-Path $holdCopy)
            }
        }
        New-Item -ItemType Directory -Force -Path @((Join-Path $reloadProject '.moe\messages'), (Join-Path $reloadProject '.moe\tasks')) | Out-Null
        Set-Content -Path (Join-Path $reloadProject '.moe\project.json') -Value '{"id":"proj-reload","name":"postflight-reload","settings":{"autoCommit":false}}' -Encoding UTF8
        Set-Content -Path (Join-Path $reloadProject '.moe\messages\chan-general.jsonl') -Value '' -Encoding UTF8
        # Literal JSON: Write-TaskRecord is defined further down.
        Set-Content -Path (Join-Path $reloadProject '.moe\tasks\task-postflight.json') -Value '{"id":"task-postflight","title":"Postflight smoke","status":"WORKING","filesModified":[]}' -Encoding UTF8
        $reloadRpcLog = Join-Path $reloadProject '.moe\evidence-rpcs.jsonl'
        $reloadOut = Join-Path $tempRoot 'wrapper-reload-hold.out'
        $holdPeerOut = Join-Path $tempRoot 'wrapper-reload-hold-peer.out'
        $holdAnswers = Join-Path $reloadProject '.moe\claim-answers.jsonl'
        # The launch counter: cmd mangles a prompt with quotes, so it records no argv.
        $holdLaunches = Join-Path $reloadProject 'reload-hold-launches.txt'
        $holdCmd = Join-Path $tempRoot 'reload-hold-cli.cmd'
        Set-Content -Path $holdCmd -Encoding ASCII -Value "@echo off`r`n>>`"$holdLaunches`" echo --- launch ---`r`nexit /b 0`r`n"
        Initialize-ReloadRepo
        # One worker's answers: C claimed, R resumed, N none.
        function Get-ReloadHoldAnswers([string]$Worker) {
            $lines = @(); try { $lines = @(Get-Content -LiteralPath $holdAnswers -Encoding UTF8 -ErrorAction Stop) } catch {}
            $codes = @{ claimed = 'C'; resumed = 'R'; none = 'N' }
            -join @($lines | ForEach-Object { try { $_ | ConvertFrom-Json } catch {} } | Where-Object { $_.workerId -eq $Worker } |
                ForEach-Object { if ($codes.ContainsKey([string]$_.answer)) { $codes[[string]$_.answer] } else { '?' } })
        }
        function Get-ReloadHoldLaunches { @(Get-Content -LiteralPath $holdLaunches -ErrorAction SilentlyContinue | Where-Object { $_ -match '^--- launch ---' }).Count }
        function Get-ReloadHoldLog([string]$Path) {
            [string](Get-Content -Raw -LiteralPath $Path -ErrorAction SilentlyContinue) + [string](Get-Content -Raw -LiteralPath "$Path.err" -ErrorAction SilentlyContinue)
        }
        function Assert-ReloadHold([bool]$Ok, [string]$Why) {
            if ($Ok) { return }
            throw ("HOT RELOAD HOLD FAILED: $Why (worker-reload '$(Get-ReloadSequence 'worker-reload')' answers '$(Get-ReloadHoldAnswers 'worker-reload')'; " +
                "worker-peer '$(Get-ReloadSequence 'worker-peer')' answers '$(Get-ReloadHoldAnswers 'worker-peer')')`n--- worker-reload ---`n" +
                (Get-ReloadHoldLog $reloadOut) + "`n--- worker-peer ---`n" + (Get-ReloadHoldLog $holdPeerOut))
        }
        # (b) and (c) on every poll, so a wrong answer fails at once and by name.
        function Assert-ReloadHoldAnswers {
            $mine = Get-ReloadHoldAnswers 'worker-reload'
            $peer = Get-ReloadHoldAnswers 'worker-peer'
            Assert-ReloadHold (-not $mine -or $mine -cmatch '^CR*$') "(b) worker-reload's answers must be claimed, then only resumed"
            Assert-ReloadHold (-not $peer -or $peer -cmatch '^N+$') '(c) worker-peer was handed the held task'
        }
        # Wait-ReloadHold WHAT CHECK -- poll the CHECK scriptblock, bounded; a dead seat fails.
        function Wait-ReloadHold([string]$What, [scriptblock]$Check) {
            $deadline = (Get-Date).AddSeconds($wrapperTimeoutSec)
            while ((Get-Date) -lt $deadline) {
                Assert-ReloadHoldAnswers
                if (& $Check) { return }
                Assert-ReloadHold (-not $reloadProc.HasExited) "worker-reload exited while waiting for $What"
                Assert-ReloadHold (-not $holdPeerProc -or -not $holdPeerProc.HasExited) "worker-peer exited while waiting for $What"
                Start-Sleep -Milliseconds 500
            }
            Assert-ReloadHold $false "timed out after ${wrapperTimeoutSec}s waiting for $What"
        }
        # The launch and peer-claim counts are marked once the restart is seen, so
        # a later count is a launch and a peer claim after the reload deregister.
        $script:holdLaunchMark = $null
        $script:holdPeerMark = $null
        function Test-ReloadHoldResumed {
            $seq = Get-ReloadSequence 'worker-reload'
            Assert-ReloadHold ($seq -notmatch 'x') '(a) worker-reload deregistered with a reason other than wrapper_restart'
            $restarts = ($seq -replace '[^r]', '').Length
            Assert-ReloadHold ($restarts -le 1) '(a) worker-reload restarted more than once for one edit'
            if ($restarts -eq 0) { return $false }
            $peerClaims = ((Get-ReloadSequence 'worker-peer') -replace '[^c]', '').Length
            if ($null -eq $script:holdLaunchMark) { $script:holdLaunchMark = Get-ReloadHoldLaunches; $script:holdPeerMark = $peerClaims }
            return ($seq -match '^c+rc+$' -and (Get-ReloadHoldLaunches) -gt $script:holdLaunchMark -and $peerClaims -gt $script:holdPeerMark)
        }
        function Start-ReloadHoldSeat([string]$SeatWrapper, [string]$Worker, [string]$Cli, [string]$Out) {
            $seatArgs = @('-NoProfile', '-File', $SeatWrapper, '-Project', $reloadProject, '-WorkerId', $Worker, '-Role', 'worker', '-NoStartDaemon', '-Command', $Cli, '-Loop', '-PollInterval', '1') |
                ForEach-Object { if ($_ -match '[\s"]') { '"' + ($_ -replace '"', '\"') + '"' } else { $_ } }
            $seat = Start-Process -FilePath $psExe -ArgumentList $seatArgs -RedirectStandardOutput $Out -RedirectStandardError "$Out.err" -PassThru -NoNewWindow
            $null = $seat.Handle
            $seat
        }
        function Add-ReloadHoldText([string]$Text) {
            for ($i = 1; ; $i++) {
                try { [IO.File]::AppendAllText($reloadWrapper, $Text, (New-Object System.Text.UTF8Encoding($false))); return }
                catch { if ($i -ge 20) { throw }; Start-Sleep -Milliseconds 100 }
            }
        }
        $reloadProc = $null
        $holdPeerProc = $null
        $holdEnvKeys = @('FAKE_CLAIM_MODE', 'MOE_DISABLE_HEARTBEAT', 'MOE_RESUME_MAX_ATTEMPTS')
        $holdSaved = @{}
        foreach ($k in $holdEnvKeys) { $holdSaved[$k] = [Environment]::GetEnvironmentVariable($k) }
        try {
            $env:FAKE_CLAIM_MODE = 'reload-hold'
            $env:MOE_DISABLE_HEARTBEAT = '1'
            $env:MOE_RESUME_MAX_ATTEMPTS = '50'
            $reloadProc = Start-ReloadHoldSeat $reloadWrapper 'worker-reload' $holdCmd $reloadOut
            Wait-ReloadHold "worker-reload's first claim" { (Get-ReloadHoldAnswers 'worker-reload') -cmatch '^C' }
            $holdPeerProc = Start-ReloadHoldSeat $holdPeerWrapper 'worker-peer' $trueCmd $holdPeerOut
            # Two launches: the claim's and one resume, so the pre-reload counter is past 1.
            Wait-ReloadHold 'two launches before the edit' { (Get-ReloadHoldLaunches) -ge 2 }
            Add-ReloadHoldText "# reload hold`n"
            Invoke-ReloadCommit 'reload hold edit'
            Wait-ReloadHold 'a resume after the restart and a peer claim after it' { Test-ReloadHoldResumed }
        } finally {
            foreach ($k in $holdEnvKeys) { [Environment]::SetEnvironmentVariable($k, $holdSaved[$k]) }
            foreach ($holdProc in @($reloadProc, $holdPeerProc)) {
                if ($holdProc -and -not $holdProc.HasExited) { & taskkill /T /F /PID $holdProc.Id 2>&1 | Out-Null; $holdProc.WaitForExit(5000) | Out-Null }
            }
        }
        # Bounded: every worker-reload claim gets its answer row.
        $holdSettle = (Get-Date).AddSeconds(5)
        do {
            $holdSeq = Get-ReloadSequence 'worker-reload'
            $holdMine = Get-ReloadHoldAnswers 'worker-reload'
            $holdClaims = ($holdSeq -replace '[^c]', '').Length
            if ($holdMine.Length -eq $holdClaims) { break }
            Start-Sleep -Milliseconds 200
        } while ((Get-Date) -lt $holdSettle)
        Assert-ReloadHoldAnswers
        Assert-ReloadHold ($holdSeq -match '^c+rc+$') '(a) expected claims, one wrapper_restart deregister, then claims'
        $holdAll = Get-ReloadSequence
        Assert-ReloadHold ($holdAll -notmatch 'x' -and ($holdAll -replace '[^r]', '') -eq 'r') "(a) the RPC log must hold exactly one deregister, worker-reload's wrapper_restart"
        Assert-ReloadHold ($holdMine.Length -eq $holdClaims) "(b) $($holdMine.Length) claim answers for $holdClaims worker-reload claims"
        $holdPeerSeq = Get-ReloadSequence 'worker-peer'
        Assert-ReloadHold ($holdPeerSeq -match '^c+$' -and (Get-ReloadHoldAnswers 'worker-peer') -cmatch '^N+$') '(c) worker-peer must only claim, and every answer must be none'
        Assert-ReloadHold (@(Get-ReloadRows | Where-Object { $_.tool -eq 'release_task' }).Count -eq 0) '(c) a seat called release_task'
        # The ASCII prefix only: the redirected out file is in the OEM code page and
        # the line goes on with an em dash. Unwrapped: a console host can wrap it.
        $holdLog = (Get-ReloadHoldLog $reloadOut) -replace '\x1b\[[0-9;]*m', '' -replace '\r?\n', ''
        $holdRestartAt = $holdLog.IndexOf('restarting to load it', [StringComparison]::Ordinal)
        $holdResumeAt = if ($holdRestartAt -ge 0) { $holdLog.IndexOf('[resume] worker-reload already holds task-postflight (WORKING) from a previous session (attempt 1/', $holdRestartAt, [StringComparison]::Ordinal) } else { -1 }
        Assert-ReloadHold ($holdResumeAt -ge 0) "(d) no fresh '[resume] ... (attempt 1/' line after the restart"
        Write-Host "[hot reload hold] ok: worker-reload resumed task-postflight after its restart (sequence $holdSeq), worker-peer claimed $($holdPeerSeq.Length) times and got none"

        # --- Hot reload refused (twin: the refused-reload arm in postflight.sh).
        # Seats launched from the shared checkout reload every edit of the real
        # file, and a half-applied edit used to make each of them deregister and
        # then stop on bytes the supervisor could not parse. An unparseable
        # change must log one refusal and keep the one process registered; the
        # next parseable change reloads once. The helpers above resolve their
        # variables at call time, so they are re-pointed at a fresh copy. Edits
        # are short APPENDS after the file's final `exit 0`, so they never run:
        # a whole-file rewrite can be hashed half-written and refused twice. ---
        $reloadWrapper = Join-Path $tempRoot 'reload-refused\scripts\moe-agent.ps1'
        $reloadProject = Join-Path $tempRoot 'reload-refused\project'
        New-Item -ItemType Directory -Force -Path @((Split-Path $reloadWrapper), (Join-Path $reloadProject '.moe\messages')) | Out-Null
        Copy-Item -LiteralPath $wrapper -Destination $reloadWrapper
        Get-ChildItem -LiteralPath (Split-Path $wrapper) -Filter '*.mjs' | ForEach-Object {
            Copy-Item -LiteralPath $_.FullName -Destination (Split-Path $reloadWrapper)
        }
        Set-Content -Path (Join-Path $reloadProject '.moe\project.json') -Value '{"id":"proj-reload","name":"postflight-reload","settings":{"autoCommit":false}}' -Encoding UTF8
        Set-Content -Path (Join-Path $reloadProject '.moe\messages\chan-general.jsonl') -Value '' -Encoding UTF8
        $reloadRpcLog = Join-Path $reloadProject '.moe\evidence-rpcs.jsonl'
        $reloadOut = Join-Path $tempRoot 'wrapper-reload-refused.out'
        Initialize-ReloadRepo
        function Add-ReloadWrapperText([string]$Text) {
            for ($i = 1; ; $i++) {
                try { [IO.File]::AppendAllText($reloadWrapper, $Text, (New-Object System.Text.UTF8Encoding($false))); return }
                catch { if ($i -ge 20) { throw }; Start-Sleep -Milliseconds 100 }
            }
        }
        $reloadProc = $null
        $refusedCount = $null
        $env:FAKE_CLAIM_MODE = 'idle'
        $env:MOE_DISABLE_HEARTBEAT = '1'
        try {
            $reloadArgs = @('-NoProfile', '-File', $reloadWrapper, '-Project', $reloadProject, '-WorkerId', 'worker-reload-refused', '-Role', 'worker', '-NoStartDaemon', '-Command', $trueCmd, '-Loop', '-PollInterval', '1') |
                ForEach-Object { if ($_ -match '[\s"]') { '"' + ($_ -replace '"', '\"') + '"' } else { $_ } }
            $reloadProc = Start-Process -FilePath $psExe -ArgumentList $reloadArgs -RedirectStandardOutput $reloadOut -RedirectStandardError "$reloadOut.err" -PassThru -NoNewWindow
            $null = $reloadProc.Handle
            Wait-ReloadSequence '^c' 'first claim'
            $refusedClaims = ((Get-ReloadSequence) -replace '[^c]', '').Length
            # An open block at the end: ParseFile reports a missing closing '}'.
            Add-ReloadWrapperText "if (`$true) {`n"
            Invoke-ReloadCommit 'unparseable edit'
            # Three more claims mean at least two loop tops hashed the refused bytes.
            Wait-ReloadSequence ('^c{' + ($refusedClaims + 3) + ',}$|[rx]') 'three claims after the refused edit'
            if ((Get-ReloadSequence) -match '[rx]') { throw "HOT RELOAD REFUSED FAILED: a refused edit must not deregister; RPC sequence '$(Get-ReloadSequence)'" }
            $refusedCount = @(Get-ReloadWrapperPids).Count
            Add-ReloadWrapperText "}`n"
            Invoke-ReloadCommit 'parseable edit'
            Wait-ReloadSequence '^c+rc' 'claim after the parseable edit'
        } finally {
            Remove-Item Env:FAKE_CLAIM_MODE, Env:MOE_DISABLE_HEARTBEAT -ErrorAction SilentlyContinue
            if ($reloadProc -and -not $reloadProc.HasExited) { & taskkill /T /F /PID $reloadProc.Id 2>&1 | Out-Null; $reloadProc.WaitForExit(5000) | Out-Null }
            foreach ($reloadPid in @(Get-ReloadWrapperPids)) { Stop-Process -Id $reloadPid -Force -ErrorAction SilentlyContinue }
        }
        $reloadSeq = Get-ReloadSequence
        $reloadLog = [string](Get-Content -Raw -LiteralPath $reloadOut -ErrorAction SilentlyContinue) + [string](Get-Content -Raw -LiteralPath "$reloadOut.err" -ErrorAction SilentlyContinue)
        # A console host can wrap a long line; the reason is matched unwrapped.
        $reloadFlat = $reloadLog -replace '\r?\n', ''
        $reloadProblems = @()
        if ($reloadSeq -notmatch '^c+rc+$') { $reloadProblems += "a refused edit must not deregister; the next parseable edit reloads once; RPC sequence '$reloadSeq'" }
        $refusals = [regex]::Matches($reloadLog, 'MOE_WRAPPER_RELOAD_REFUSED').Count
        if ($refusals -ne 1) { $reloadProblems += "one refusal line per refused hash, got $refusals" }
        # The wrapper's own 'line N:' then the parser's (localized) message.
        if ($reloadFlat -notmatch 'does not parse; staying on the current bytes until it changes again: line \d+: ') { $reloadProblems += "the refusal line must carry ParseFile's reason" }
        if ($refusedCount -ne 1) { $reloadProblems += "expected exactly 1 wrapper process after the refused edit; counted $refusedCount" }
        $restarts = [regex]::Matches($reloadLog, 'restarting to load it').Count
        if ($restarts -ne 1) { $reloadProblems += "expected one restart announcement, got $restarts" }
        if ($reloadProblems.Count) { Write-Host $reloadLog; throw ('HOT RELOAD REFUSED FAILED: ' + ($reloadProblems -join ' | ')) }
        Write-Host '[hot reload refused] ok: refused once, one process, reloaded on the next parseable edit'

        # --- Hot reload deferred / unverifiable (twins in postflight.sh).
        foreach ($reloadMode in @('deferred', 'unverifiable')) {
            Write-Host "[hot reload $reloadMode] changed bytes keep serving until verified committed"
            $reloadRoot = Join-Path $tempRoot "reload-$reloadMode"
            $reloadWrapper = Join-Path $reloadRoot 'scripts\moe-agent.ps1'
            $reloadProject = Join-Path $reloadRoot 'project'
            New-Item -ItemType Directory -Force -Path @((Split-Path $reloadWrapper), (Join-Path $reloadProject '.moe\messages')) | Out-Null
            Copy-Item -LiteralPath $wrapper -Destination $reloadWrapper
            Get-ChildItem -LiteralPath (Split-Path $wrapper) -Filter '*.mjs' | ForEach-Object {
                Copy-Item -LiteralPath $_.FullName -Destination (Split-Path $reloadWrapper)
            }
            if ($reloadMode -eq 'deferred') { Initialize-ReloadRepo }
            Set-Content -Path (Join-Path $reloadProject '.moe\project.json') -Value '{"id":"proj-reload","name":"postflight-reload","settings":{"autoCommit":false}}' -Encoding UTF8
            Set-Content -Path (Join-Path $reloadProject '.moe\messages\chan-general.jsonl') -Value '' -Encoding UTF8
            $reloadRpcLog = Join-Path $reloadProject '.moe\evidence-rpcs.jsonl'
            $reloadOut = Join-Path $tempRoot "wrapper-reload-$reloadMode.out"
            $reloadEdits = if ($reloadMode -eq 'deferred') { 2 } else { 1 }
            $reloadProc = $null
            $env:FAKE_CLAIM_MODE = 'idle'
            $env:MOE_DISABLE_HEARTBEAT = '1'
            if ($reloadMode -eq 'unverifiable') { $env:GIT_CEILING_DIRECTORIES = $reloadRoot }
            try {
                $reloadArgs = @('-NoProfile', '-File', $reloadWrapper, '-Project', $reloadProject, '-WorkerId', "worker-reload-$reloadMode", '-Role', 'worker', '-NoStartDaemon', '-Command', $trueCmd, '-Loop', '-PollInterval', '1') |
                    ForEach-Object { if ($_ -match '[\s"]') { '"' + ($_ -replace '"', '\"') + '"' } else { $_ } }
                $reloadProc = Start-Process -FilePath $psExe -ArgumentList $reloadArgs -RedirectStandardOutput $reloadOut -RedirectStandardError "$reloadOut.err" -PassThru -NoNewWindow
                $null = $reloadProc.Handle
                Wait-ReloadSequence '^c' 'first claim'
                for ($edit = 1; $edit -le $reloadEdits; $edit++) {
                    $reloadClaims = (Get-ReloadSequence).Length
                    Add-ReloadWrapperText "# deferred edit $edit`n"
                    Wait-ReloadSequence ('^c{' + ($reloadClaims + 3) + ',}$|[rx]') 'three claims after the deferred edit'
                    if ((Get-ReloadSequence) -match '[rx]') { throw "HOT RELOAD FAILED: a deferred edit must not deregister; RPC sequence '$(Get-ReloadSequence)'" }
                }
                $deferredCount = @(Get-ReloadWrapperPids).Count
                if ($reloadMode -eq 'deferred') {
                    Invoke-ReloadCommit 'deferred edits'
                    Wait-ReloadSequence '^c+rc{2,}$' 'claims after committing deferred bytes'
                }
            } finally {
                Remove-Item Env:FAKE_CLAIM_MODE, Env:MOE_DISABLE_HEARTBEAT, Env:GIT_CEILING_DIRECTORIES -ErrorAction SilentlyContinue
                if ($reloadProc -and -not $reloadProc.HasExited) { & taskkill /T /F /PID $reloadProc.Id 2>&1 | Out-Null; $reloadProc.WaitForExit(5000) | Out-Null }
                foreach ($reloadPid in @(Get-ReloadWrapperPids)) { Stop-Process -Id $reloadPid -Force -ErrorAction SilentlyContinue }
            }
            $reloadSeq = Get-ReloadSequence
            $reloadLog = [string](Get-Content -Raw -LiteralPath $reloadOut -ErrorAction SilentlyContinue) + [string](Get-Content -Raw -LiteralPath "$reloadOut.err" -ErrorAction SilentlyContinue)
            $reloadFlat = $reloadLog -replace '\r?\n', ''
            $reloadProblems = @()
            if ($deferredCount -ne 1) { $reloadProblems += "expected one wrapper process, counted $deferredCount" }
            $deferrals = [regex]::Matches($reloadFlat, 'MOE_WRAPPER_RELOAD_DEFERRED').Count
            $restarts = [regex]::Matches($reloadFlat, 'restarting to load it').Count
            if ($deferrals -ne $reloadEdits) { $reloadProblems += "expected $reloadEdits deferrals, got $deferrals" }
            if ($reloadMode -eq 'deferred') {
                if ($reloadSeq -notmatch '^c+rc{2,}$' -or $restarts -ne 1) { $reloadProblems += "expected one restart after commit; sequence '$reloadSeq', announcements $restarts" }
                if ([regex]::Matches($reloadFlat, 'MOE_WRAPPER_RELOAD_DEFERRED: wrapper has uncommitted edits').Count -ne 2 -or $reloadFlat -match 'cannot confirm') { $reloadProblems += 'expected two uncommitted-edit reasons and no git failure' }
            } else {
                if ($reloadSeq -notmatch '^c+$' -or $restarts -ne 0) { $reloadProblems += "unverifiable bytes must not restart; sequence '$reloadSeq', announcements $restarts" }
                if ($reloadFlat -notmatch 'MOE_WRAPPER_RELOAD_DEFERRED: cannot confirm the wrapper bytes are committed') { $reloadProblems += 'expected git failure reason' }
            }
            if ($reloadProblems.Count) { Write-Host $reloadLog; throw ('HOT RELOAD FAILED: ' + ($reloadProblems -join ' | ')) }
            Write-Host "[hot reload $reloadMode] ok: $reloadEdits deferrals, $restarts restarts, 1 wrapper process"
        }

        # --- Hot reload follow (WT-13 §6.2; twin in postflight.sh). The project
        # is the wrapper's own checkout, on moe/control. A wrapper change
        # committed to main only (plumbing: neither HEAD nor the file moves) is
        # followed at the next loop top, BEFORE the hash check, so the file on
        # disk is HEAD's blob and the seat restarts once, with no
        # MOE_WRAPPER_RELOAD_DEFERRED line. ---
        Write-Host '[hot reload follow] a wrapper change landed on main is followed, then reloaded'
        $reloadRoot = Join-Path $tempRoot 'reload-follow'
        $reloadProject = $reloadRoot
        $reloadWrapper = Join-Path $reloadRoot 'scripts\moe-agent.ps1'
        New-Item -ItemType Directory -Force -Path @((Split-Path $reloadWrapper), (Join-Path $reloadRoot '.moe\messages')) | Out-Null
        Copy-Item -LiteralPath $wrapper -Destination $reloadWrapper
        Get-ChildItem -LiteralPath (Split-Path $wrapper) -Filter '*.mjs' | ForEach-Object {
            Copy-Item -LiteralPath $_.FullName -Destination (Split-Path $reloadWrapper)
        }
        [IO.File]::WriteAllText((Join-Path $reloadRoot '.gitignore'), ".moe/`n.mcp.json`nlogs/`n.claude/`n")
        Set-Content -Path (Join-Path $reloadRoot '.moe\project.json') -Value '{"id":"proj-reload","name":"postflight-reload","settings":{"autoCommit":false}}' -Encoding UTF8
        Set-Content -Path (Join-Path $reloadRoot '.moe\messages\chan-general.jsonl') -Value '' -Encoding UTF8
        $reloadRpcLog = Join-Path $reloadRoot '.moe\evidence-rpcs.jsonl'
        $reloadOut = Join-Path $tempRoot 'wrapper-reload-follow.out'
        function Invoke-FollowGit {
            $ErrorActionPreference = 'Continue'
            $out = & git -C $reloadRoot -c 'user.name=Moe Test' -c 'user.email=moe@test.local' -c 'commit.gpgsign=false' -c 'core.autocrlf=false' @args 2>$null
            if ($LASTEXITCODE -ne 0) { throw "HOT RELOAD FOLLOW FAILED: git $args exited $LASTEXITCODE" }
            if ($null -ne $out) { ([string]($out | Select-Object -First 1)).Trim() }
        }
        foreach ($gitArgs in @(@('init', '-q'), @('symbolic-ref', 'HEAD', 'refs/heads/main'), @('add', '-A'),
            @('commit', '-qm', 'base'), @('switch', '-q', '-c', 'moe/control'))) { Invoke-FollowGit @gitArgs | Out-Null }
        $reloadProc = $null
        $reloadMain = ''
        $env:FAKE_CLAIM_MODE = 'idle'
        $env:MOE_DISABLE_HEARTBEAT = '1'
        try {
            $reloadArgs = @('-NoProfile', '-File', $reloadWrapper, '-Project', $reloadProject, '-WorkerId', 'worker-reload-follow', '-Role', 'worker', '-NoStartDaemon', '-Command', $trueCmd, '-Loop', '-PollInterval', '1') |
                ForEach-Object { if ($_ -match '[\s"]') { '"' + ($_ -replace '"', '\"') + '"' } else { $_ } }
            $reloadProc = Start-Process -FilePath $psExe -ArgumentList $reloadArgs -RedirectStandardOutput $reloadOut -RedirectStandardError "$reloadOut.err" -PassThru -NoNewWindow
            $null = $reloadProc.Handle
            Wait-ReloadSequence '^c' 'first claim'
            # The landed bytes go through a file outside the repo: piping text to
            # a native command re-encodes it, and the BOM must survive.
            $reloadFileMode = (Invoke-FollowGit ls-files -s scripts/moe-agent.ps1) -replace ' .*$', ''
            $reloadBlobFile = Join-Path $tempRoot 'reload-follow.blob'
            Copy-Item -LiteralPath $reloadWrapper -Destination $reloadBlobFile
            [IO.File]::AppendAllText($reloadBlobFile, "# landed on main`n", (New-Object System.Text.UTF8Encoding($false)))
            $reloadBlob = Invoke-FollowGit hash-object -w --no-filters $reloadBlobFile
            $env:GIT_INDEX_FILE = Join-Path $tempRoot 'reload-follow.index'
            try {
                Invoke-FollowGit read-tree HEAD | Out-Null
                Invoke-FollowGit update-index --cacheinfo "$reloadFileMode,$reloadBlob,scripts/moe-agent.ps1" | Out-Null
                $reloadTree = Invoke-FollowGit write-tree
            } finally { Remove-Item Env:GIT_INDEX_FILE -ErrorAction SilentlyContinue }
            $reloadMain = Invoke-FollowGit commit-tree $reloadTree -p HEAD -m 'land a wrapper change on main'
            Invoke-FollowGit update-ref refs/heads/main $reloadMain | Out-Null
            Wait-ReloadSequence '^c+rc' 'claim after the followed reload'
        } finally {
            Remove-Item Env:FAKE_CLAIM_MODE, Env:MOE_DISABLE_HEARTBEAT -ErrorAction SilentlyContinue
            if ($reloadProc -and -not $reloadProc.HasExited) { & taskkill /T /F /PID $reloadProc.Id 2>&1 | Out-Null; $reloadProc.WaitForExit(5000) | Out-Null }
            foreach ($reloadPid in @(Get-ReloadWrapperPids)) { Stop-Process -Id $reloadPid -Force -ErrorAction SilentlyContinue }
        }
        $reloadSeq = Get-ReloadSequence
        $reloadLog = [string](Get-Content -Raw -LiteralPath $reloadOut -ErrorAction SilentlyContinue) + [string](Get-Content -Raw -LiteralPath "$reloadOut.err" -ErrorAction SilentlyContinue)
        $reloadFlat = $reloadLog -replace '\r?\n', ''
        $reloadProblems = @()
        if ($reloadFlat -notmatch "MOE_CONTROL_ADVANCED [0-9a-f]{40}\.\.$reloadMain") { $reloadProblems += 'no MOE_CONTROL_ADVANCED line naming the landed commit' }
        if ($reloadFlat -match 'MOE_WRAPPER_RELOAD_DEFERRED') { $reloadProblems += 'the followed bytes were deferred' }
        $restarts = [regex]::Matches($reloadFlat, 'restarting to load it').Count
        if ($restarts -ne 1) { $reloadProblems += "expected one restart announcement, got $restarts" }
        $followHead = Invoke-FollowGit rev-parse HEAD
        $followRef = Invoke-FollowGit symbolic-ref HEAD
        & git -C $reloadRoot diff --quiet HEAD -- scripts/moe-agent.ps1 2>$null
        if ($followHead -cne $reloadMain -or $followRef -cne 'refs/heads/moe/control' -or $LASTEXITCODE -ne 0) {
            $reloadProblems += "the control checkout is not on moe/control at main with the wrapper equal to HEAD (HEAD $followHead on $followRef)"
        }
        if ($reloadProblems.Count) { Write-Host $reloadLog; throw ('HOT RELOAD FOLLOW FAILED: ' + ($reloadProblems -join ' | ')) }
        Write-Host "[hot reload follow] ok: followed $reloadMain, restarted once, no deferral (sequence $reloadSeq)"

        # --- Hot reload race (task-69c02444; twin in postflight.sh). A restart
        # loads the bytes it verified as committed. The fake proxy rewrites the
        # wrapper inside the restart's own deregister (FAKE_RELOAD_RACE_SRC/_DST):
        # after the check and before the load. The seat restarts on the committed
        # bytes (a private moe-wrapper-pin.* copy) and reloads the racing write
        # only once it is committed, again from a copy. Committed bytes that no
        # longer name the MoeWrapperSourcePath hand-over (a revert) reload from
        # the checkout path, and no copy is left in the seat's temp dir. ---
        Write-Host '[hot reload race] a write after the committed check is never loaded'
        $reloadRoot = Join-Path $tempRoot 'reload-race'
        $reloadWrapper = Join-Path $reloadRoot 'scripts\moe-agent.ps1'
        $reloadProject = Join-Path $reloadRoot 'project'
        $raceTmp = Join-Path $reloadRoot 'tmp'
        $raceSrc = Join-Path $reloadRoot 'race.src'
        New-Item -ItemType Directory -Force -Path @((Split-Path $reloadWrapper), (Join-Path $reloadProject '.moe\messages'), $raceTmp) | Out-Null
        Copy-Item -LiteralPath $wrapper -Destination $reloadWrapper
        Get-ChildItem -LiteralPath (Split-Path $wrapper) -Filter '*.mjs' | ForEach-Object {
            Copy-Item -LiteralPath $_.FullName -Destination (Split-Path $reloadWrapper)
        }
        Initialize-ReloadRepo
        Set-Content -Path (Join-Path $reloadProject '.moe\project.json') -Value '{"id":"proj-reload","name":"postflight-reload","settings":{"autoCommit":false}}' -Encoding UTF8
        Set-Content -Path (Join-Path $reloadProject '.moe\messages\chan-general.jsonl') -Value '' -Encoding UTF8
        $reloadRpcLog = Join-Path $reloadProject '.moe\evidence-rpcs.jsonl'
        $reloadOut = Join-Path $tempRoot 'wrapper-reload-race.out'
        # Edit A appends '# race A'; race.src is edit A with a marked idle line.
        $raceIdle = 'Agent idle, checking for tasks in'
        $raceText = [IO.File]::ReadAllText($reloadWrapper) + "# race A`n"
        if (($raceText -csplit [regex]::Escape($raceIdle)).Count -ne 2) { throw 'HOT RELOAD RACE FAILED: the idle line is not in the wrapper exactly once' }
        [IO.File]::WriteAllText($raceSrc, $raceText.Replace($raceIdle, 'MOE_TEST_RACE_LOADED from $PSCommandPath, checking for tasks in'), (New-Object System.Text.UTF8Encoding($true)))
        # A console host can wrap a long line; the log is matched unwrapped.
        function Get-ReloadRaceLog {
            ([string](Get-Content -Raw -LiteralPath $reloadOut -ErrorAction SilentlyContinue) + [string](Get-Content -Raw -LiteralPath "$reloadOut.err" -ErrorAction SilentlyContinue)) -replace '\r?\n', ''
        }
        function Assert-ReloadRace([bool]$Ok, [string]$Why) {
            if ($Ok) { return }
            Write-Host (Get-ReloadRaceLog)
            throw "HOT RELOAD RACE FAILED: $Why; RPC sequence '$(Get-ReloadSequence)'"
        }
        $reloadProc = $null
        $raceEnv = @{ TMP = $env:TMP; TEMP = $env:TEMP }
        $env:FAKE_CLAIM_MODE = 'idle'
        $env:MOE_DISABLE_HEARTBEAT = '1'
        $env:FAKE_RELOAD_RACE_SRC = $raceSrc
        $env:FAKE_RELOAD_RACE_DST = $reloadWrapper
        $env:TMP = $raceTmp
        $env:TEMP = $raceTmp
        try {
            $reloadArgs = @('-NoProfile', '-File', $reloadWrapper, '-Project', $reloadProject, '-WorkerId', 'worker-reload-race', '-Role', 'worker', '-NoStartDaemon', '-Command', $trueCmd, '-Loop', '-PollInterval', '1') |
                ForEach-Object { if ($_ -match '[\s"]') { '"' + ($_ -replace '"', '\"') + '"' } else { $_ } }
            $reloadProc = Start-Process -FilePath $psExe -ArgumentList $reloadArgs -RedirectStandardOutput $reloadOut -RedirectStandardError "$reloadOut.err" -PassThru -NoNewWindow
            $null = $reloadProc.Handle
            Wait-ReloadSequence '^c' 'first claim'
            Add-ReloadWrapperText "# race A`n"
            Invoke-ReloadCommit 'race A'
            Wait-ReloadSequence '^c+rc{3,}$' 'three claims after the race A reload'
            Assert-ReloadRace (-not (Test-Path -LiteralPath $raceSrc)) 'the restart deregister did not write the racing bytes'
            Assert-ReloadRace ([IO.File]::ReadAllText($reloadWrapper).Contains('MOE_TEST_RACE_LOADED')) 'the racing bytes are not on disk'
            & git -C (Split-Path $reloadWrapper) diff --quiet -- moe-agent.ps1 2>$null
            Assert-ReloadRace ($LASTEXITCODE -eq 1) "the racing bytes must stay uncommitted (git diff exited $LASTEXITCODE)"
            Assert-ReloadRace ((Get-ReloadRaceLog) -notmatch 'MOE_TEST_RACE_LOADED') 'the restart loaded bytes written after the committed check'
            # Committed, the racing bytes reload once, from a private copy.
            Invoke-ReloadCommit 'race write'
            Wait-ReloadSequence '^c+rc+rc{3,}$' 'three claims after the racing write reload'
            Assert-ReloadRace ((Get-ReloadRaceLog) -match 'MOE_TEST_RACE_LOADED from [^,]*moe-wrapper-pin\.[^\\/,]+[\\/]moe-agent\.ps1,') 'the committed racing bytes did not run from a moe-wrapper-pin copy'
            Assert-ReloadRace (@(Get-ChildItem -LiteralPath $raceTmp -Filter 'moe-wrapper-pin.*' -Force -ErrorAction SilentlyContinue).Count -eq 0) 'the running copy did not delete itself once loaded'
            # Bytes without the hand-over would resolve their helpers beside a copy.
            $raceText = [IO.File]::ReadAllText($reloadWrapper)
            Assert-ReloadRace ($raceText.Contains('MoeWrapperSourcePath')) 'the wrapper does not name MoeWrapperSourcePath'
            Set-ReloadWrapperText $raceText.Replace('MoeWrapperSourcePath', 'MoeWrapperOrigin')
            Invoke-ReloadCommit 'drop hand-over'
            Wait-ReloadSequence '^c+rc+rc+rc{3,}$' 'three claims after the reload without the hand-over'
        } finally {
            Remove-Item Env:FAKE_CLAIM_MODE, Env:MOE_DISABLE_HEARTBEAT, Env:FAKE_RELOAD_RACE_SRC, Env:FAKE_RELOAD_RACE_DST -ErrorAction SilentlyContinue
            $env:TMP = $raceEnv.TMP
            $env:TEMP = $raceEnv.TEMP
            if ($reloadProc -and -not $reloadProc.HasExited) { & taskkill /T /F /PID $reloadProc.Id 2>&1 | Out-Null; $reloadProc.WaitForExit(5000) | Out-Null }
            foreach ($reloadPid in @(Get-ReloadWrapperPids)) { Stop-Process -Id $reloadPid -Force -ErrorAction SilentlyContinue }
        }
        $reloadSeq = Get-ReloadSequence
        Assert-ReloadRace ((Get-ReloadRaceLog).IndexOf("MOE_TEST_RACE_LOADED from $reloadWrapper,", [StringComparison]::OrdinalIgnoreCase) -ge 0) 'bytes without the hand-over did not reload from the checkout path'
        $raceLeft = @(Get-ChildItem -LiteralPath $raceTmp -Filter 'moe-wrapper-pin.*' -Force -ErrorAction SilentlyContinue)
        Assert-ReloadRace ($raceLeft.Count -eq 0) "private copies left behind: $(@($raceLeft | ForEach-Object { $_.Name }) -join ', ')"
        Write-Host "[hot reload race] ok: restarted on the committed bytes, loaded the racing write from a copy once committed (sequence $reloadSeq)"

        # --- Quality gate (settings.qualityGate): the post-flight runs the
        # configured command before a COMPLETION commit. Failing gate => no
        # branch commit (the edits go to a rescue ref), PUSH-BLOCKED chat
        # message, wrapper stops; passing gate => commit lands;
        # MOE_DISABLE_QUALITY_GATE=1 => gate skipped even when the command
        # would fail. Requires git in PATH. ---
        $gateAvailable = [bool](Get-Command git -ErrorAction SilentlyContinue)
        if ($gateAvailable) {
            # Writes the durable task record the post-flight (and the fake
            # get_commit_scope) reads to derive its commit pathspec. The fake
            # proxy claims `task-postflight`, and the daemon stores a task at
            # `.moe/tasks/<taskId>.json` — the id ALREADY carries the `task-`
            # prefix, so the on-disk name is `task-postflight.json` and never
            # `task-task-postflight.json`. Getting that resolution wrong is
            # silent: the record simply never loads.
            function Write-TaskRecord([string]$dir, [string[]]$filesModified, [string]$status = 'REVIEW', $implementationPlan = $null, [string]$id = 'task-postflight', [string]$title = 'Postflight smoke') {
                New-Item -ItemType Directory -Force -Path (Join-Path $dir '.moe\tasks') | Out-Null
                $rec = [ordered]@{
                    id = $id
                    title = $title
                    status = $status
                    filesModified = @($filesModified)
                }
                if ($null -ne $implementationPlan) { $rec.implementationPlan = @($implementationPlan) }
                $json = $rec | ConvertTo-Json -Depth 8
                # PS 5.1 unwraps a one-element array; keep filesModified an array.
                if ($filesModified.Count -eq 1) { $json = $json -replace '"filesModified":\s*"([^"]*)"', '"filesModified": ["$1"]' }
                Set-Content -Path (Join-Path $dir ".moe\tasks\$id.json") -Value $json -Encoding UTF8
            }
            # A LIVE peer's record: another WORKING task (assigned to
            # worker-peer) whose plan names peer-plan.txt.
            function Write-PeerTaskRecord([string]$dir) {
                New-Item -ItemType Directory -Force -Path (Join-Path $dir '.moe\tasks') | Out-Null
                $json = '{"id":"task-peer","title":"Peer task","status":"WORKING","assignedWorkerId":"worker-peer","implementationPlan":[{"stepId":"s1","title":"peer step","status":"PENDING","affectedFiles":["peer-plan.txt"]}],"filesModified":["peer-plan.txt"]}'
                Set-Content -Path (Join-Path $dir '.moe\tasks\task-peer.json') -Value $json -Encoding UTF8
            }
            function New-GateProject([string]$dir, [string]$gateCmd) {
                New-Item -ItemType Directory -Force -Path (Join-Path $dir '.moe\messages') | Out-Null
                $cfg = @{ id = 'proj-gate'; name = 'postflight-gate'; settings = @{ qualityGate = $gateCmd } } | ConvertTo-Json -Depth 5
                Set-Content -Path (Join-Path $dir '.moe\project.json') -Value $cfg -Encoding UTF8
                Write-TaskRecord $dir @('work.txt')
                Set-Content -Path (Join-Path $dir '.moe\messages\chan-general.jsonl') -Value '' -Encoding UTF8
                & git -C $dir init -q 2>$null | Out-Null
                & git -C $dir config user.email 'moe@test.local' 2>$null | Out-Null
                & git -C $dir config user.name 'Moe Test' 2>$null | Out-Null
                Set-Content -Path (Join-Path $dir 'seed.txt') -Value 'seed'
                & git -C $dir add seed.txt 2>$null | Out-Null
                & git -C $dir commit -qm init 2>$null | Out-Null
                # Leave the task's own owned path dirty for the post-flight to commit.
                Set-Content -Path (Join-Path $dir 'work.txt') -Value 'dirty'
            }
            # Used by gate AND scope cases. STATUS is what the fake daemon reports
            # for the task after the CLI exits; COMMAND is the fake CLI.
            function Invoke-GateWrapper([string]$dir, [string]$outFile, [string]$Status = 'REVIEW', [string]$Command = '', [string]$Role = 'worker', [string]$WorkerId = 'worker-gate', [switch]$LoopOneSecond) {
                if (-not $Command) { $Command = $trueCmd }
                $prevStatus = $env:FAKE_TASK_STATUS
                $env:FAKE_TASK_STATUS = $Status
                try {
                    $loopArgs = @('-NoLoop', '-PollInterval', '0')
                    if ($LoopOneSecond) { $loopArgs = @('-Loop', '-PollInterval', '1') }
                    return (Invoke-WrapperProcess (@('-Project', $dir, '-WorkerId', $WorkerId, '-Role', $Role, '-Team', 'Smoke', '-NoStartDaemon', '-Command', $Command) + $loopArgs) $outFile)
                } finally {
                    if ($null -ne $prevStatus) { $env:FAKE_TASK_STATUS = $prevStatus } else { Remove-Item Env:FAKE_TASK_STATUS -ErrorAction SilentlyContinue }
                }
            }
            function Get-RescueRefs([string]$dir, [string]$taskId = 'task-postflight') {
                return @(& git -C $dir for-each-ref --format='%(refname)' "refs/moe/rescue/$taskId/" 2>$null | Where-Object { $_ })
            }
            # SHA-256 over bytes the harness already reads. Get-FileHash threw on the GitHub
            # windows-latest runner under Windows PowerShell 5.1 (Scenario Y, first CI run of
            # this harness) while the same file had just been ReadAllText/ReadAllBytes'd.
            function Get-Sha256Hex([string]$path) {
                $sha = [System.Security.Cryptography.SHA256]::Create()
                try {
                    for ($attempt = 1; ; $attempt++) {
                        try { return ([System.BitConverter]::ToString($sha.ComputeHash([System.IO.File]::ReadAllBytes($path))) -replace '-', '') }
                        catch [System.IO.IOException] { if ($attempt -ge 5) { throw }; Start-Sleep -Milliseconds 300 }
                    }
                } finally { $sha.Dispose() }
            }
            function Get-HeadSubject([string]$dir, [string]$rev = 'HEAD') {
                return ((& git -C $dir log -1 --format=%s $rev 2>$null) -join '')
            }
            $env:FAKE_TASK_STATUS = 'REVIEW'
            try {
                $gateFailDir = Join-Path $tempRoot 'gate-fail'
                New-GateProject $gateFailDir 'exit 3'
                $wrapperGateFailOut = Join-Path $tempRoot 'wrapper-gate-fail.out'
                $gateFailCode = Invoke-GateWrapper $gateFailDir $wrapperGateFailOut

                $gatePassDir = Join-Path $tempRoot 'gate-pass'
                New-GateProject $gatePassDir 'exit 0'
                $wrapperGatePassOut = Join-Path $tempRoot 'wrapper-gate-pass.out'
                $gatePassCode = Invoke-GateWrapper $gatePassDir $wrapperGatePassOut

                $gateSkipDir = Join-Path $tempRoot 'gate-skip'
                New-GateProject $gateSkipDir 'exit 7'
                $wrapperGateSkipOut = Join-Path $tempRoot 'wrapper-gate-skip.out'
                $env:MOE_DISABLE_QUALITY_GATE = '1'
                try {
                    $gateSkipCode = Invoke-GateWrapper $gateSkipDir $wrapperGateSkipOut
                } finally {
                    Remove-Item Env:MOE_DISABLE_QUALITY_GATE -ErrorAction SilentlyContinue
                }

                # Mid-epic task (sibling with higher order) defers the gate under
                # the default scope=epicFinal — a failing gate must not block.
                $gateMidDir = Join-Path $tempRoot 'gate-midepic'
                New-GateProject $gateMidDir 'exit 9'
                $wrapperGateMidOut = Join-Path $tempRoot 'wrapper-gate-midepic.out'
                $env:FAKE_SIBLING_ORDER = '99'
                try {
                    $gateMidCode = Invoke-GateWrapper $gateMidDir $wrapperGateMidOut
                } finally {
                    Remove-Item Env:FAKE_SIBLING_ORDER -ErrorAction SilentlyContinue
                }

                # Daemon-provided isEpicFinal: newer daemons compute epic-final
                # board-side and serve it in get_context; when present the
                # wrapper must PREFER it over the list_tasks fallback (the
                # mid-epic case above, which runs with the field absent, keeps
                # pinning the fallback for old daemons). Two directions, each a
                # discriminator against silently using the fallback.
                # b1: daemon says false (task-level) with NO sibling knob — the
                # fallback would compute final=true and run the failing gate;
                # the daemon value must defer it, so the commit lands.
                $gateDaemonMidDir = Join-Path $tempRoot 'gate-daemonmid'
                New-GateProject $gateDaemonMidDir 'exit 9'
                $wrapperGateDaemonMidOut = Join-Path $tempRoot 'wrapper-gate-daemonmid.out'
                $env:FAKE_CTX_IS_EPIC_FINAL = 'false'
                try {
                    $gateDaemonMidCode = Invoke-GateWrapper $gateDaemonMidDir $wrapperGateDaemonMidOut
                } finally {
                    Remove-Item Env:FAKE_CTX_IS_EPIC_FINAL -ErrorAction SilentlyContinue
                }
                # b2: daemon says true (top-level placement) while the sibling
                # page says mid-epic — the fallback would defer; the daemon
                # value must run the failing gate, which blocks the commit.
                $gateDaemonFinalDir = Join-Path $tempRoot 'gate-daemonfinal'
                New-GateProject $gateDaemonFinalDir 'exit 3'
                $wrapperGateDaemonFinalOut = Join-Path $tempRoot 'wrapper-gate-daemonfinal.out'
                $env:FAKE_CTX_IS_EPIC_FINAL = 'true'
                $env:FAKE_CTX_IS_EPIC_FINAL_AT = 'top'
                $env:FAKE_SIBLING_ORDER = '99'
                try {
                    $gateDaemonFinalCode = Invoke-GateWrapper $gateDaemonFinalDir $wrapperGateDaemonFinalOut
                } finally {
                    Remove-Item Env:FAKE_CTX_IS_EPIC_FINAL -ErrorAction SilentlyContinue
                    Remove-Item Env:FAKE_CTX_IS_EPIC_FINAL_AT -ErrorAction SilentlyContinue
                    Remove-Item Env:FAKE_SIBLING_ORDER -ErrorAction SilentlyContinue
                }

                # REGRESSION: the post-flight must not resolve the task's final
                # status through an UNSCOPED list_tasks. The daemon caps that
                # call at DEFAULT_TASK_LIST_LIMIT, so past one page of tasks the
                # just-completed task is absent from the rows, the status comes
                # back empty, and the whole auto-commit block is skipped in total
                # silence. The lookup must key on the task id instead, which
                # cannot be paginated away.
                $gateTruncDir = Join-Path $tempRoot 'gate-truncated'
                New-GateProject $gateTruncDir ''
                $wrapperGateTruncOut = Join-Path $tempRoot 'wrapper-gate-truncated.out'
                $env:FAKE_LIST_TASKS_TRUNCATED = '1'
                try {
                    $gateTruncCode = Invoke-GateWrapper $gateTruncDir $wrapperGateTruncOut
                } finally {
                    Remove-Item Env:FAKE_LIST_TASKS_TRUNCATED -ErrorAction SilentlyContinue
                }

                # A status lookup that fails outright is an ERROR, not a quiet
                # "the task isn't in REVIEW". It must warn on stdout AND escalate
                # to chat — that distinction is the whole reason this failure
                # went unnoticed for a day. The task id itself is certain, so
                # the work still lands as a CHECKPOINT with status=UNKNOWN.
                $gateLookupDir = Join-Path $tempRoot 'gate-lookupfail'
                New-GateProject $gateLookupDir ''
                $wrapperGateLookupOut = Join-Path $tempRoot 'wrapper-gate-lookupfail.out'
                $env:FAKE_GET_CONTEXT_FAIL = 'empty'
                try {
                    $gateLookupCode = Invoke-GateWrapper $gateLookupDir $wrapperGateLookupOut
                } finally {
                    Remove-Item Env:FAKE_GET_CONTEXT_FAIL -ErrorAction SilentlyContinue
                }

                # get_context's real miss behaviour: getContext.ts falls back to
                # the caller's currentTaskId, so a stale/deleted id answers with
                # a DIFFERENT task. Treating another task's REVIEW as this one's
                # completion would be worse than not committing at all — it is
                # a status-UNKNOWN checkpoint, never a completion.
                $gateMismatchDir = Join-Path $tempRoot 'gate-mismatch'
                New-GateProject $gateMismatchDir ''
                $wrapperGateMismatchOut = Join-Path $tempRoot 'wrapper-gate-mismatch.out'
                $env:FAKE_GET_CONTEXT_FAIL = 'mismatch'
                try {
                    $gateMismatchCode = Invoke-GateWrapper $gateMismatchDir $wrapperGateMismatchOut
                } finally {
                    Remove-Item Env:FAKE_GET_CONTEXT_FAIL -ErrorAction SilentlyContinue
                }

                # --- Completion-hook COMMIT SCOPE, scenarios A-E, then the
                # land-on-every-exit scenarios F-V and X, then the grok CLI
                # scenario Y ------------------------------------------------
                # Twin of the same scenarios in postflight.sh (W is bash-only:
                # kill -INT). The twins drift easily, so these are matched case
                # by case against that scenario list rather than by reading the
                # two files side by side. Two distinct leaks are covered by A-E
                # and they are NOT the same bug: staging scope (`git add -A`
                # when the task record did not load) and commit scope (a BARE
                # `git commit` commits the SHARED INDEX, so a peer's
                # already-staged file rides along). Scenario B is the only one
                # that discriminates the second. Every scenario runs against a
                # disposable repo under $tempRoot — a post-flight test that
                # commits into a live tree reproduces the defect it is meant
                # to test.
                $scopeScenariosRun = 0
                function New-ScopeProject([string]$dir, [string[]]$filesModified, [hashtable]$Settings = $null, [switch]$NoSeed, [string]$Status = 'REVIEW', $ImplementationPlan = $null) {
                    New-Item -ItemType Directory -Force -Path (Join-Path $dir '.moe\messages') | Out-Null
                    $st = @{}
                    if ($Settings) { $st = $Settings }
                    $cfg = @{ id = 'proj-scope'; name = 'postflight-scope'; settings = $st } | ConvertTo-Json -Depth 5
                    Set-Content -Path (Join-Path $dir '.moe\project.json') -Value $cfg -Encoding UTF8
                    Write-TaskRecord $dir $filesModified $Status $ImplementationPlan
                    Set-Content -Path (Join-Path $dir '.moe\messages\chan-general.jsonl') -Value '' -Encoding UTF8
                    & git -C $dir init -q 2>$null | Out-Null
                    & git -C $dir config user.email 'moe@test.local' 2>$null | Out-Null
                    & git -C $dir config user.name 'Moe Test' 2>$null | Out-Null
                    if (-not $NoSeed) {
                        Set-Content -Path (Join-Path $dir 'seed.txt') -Value 'seed'
                        # The task's own record is TRACKED and clean at the seed,
                        # as in a real project (.moe/tasks/ is committed; the
                        # daemon rewrites records during a session). A dirty own
                        # record is ALWAYS a board candidate, so only scenarios
                        # that dirty it on purpose (P) — or skip the seed (U) —
                        # expect it in the commit. Same fixture as postflight.sh.
                        & git -C $dir add seed.txt .moe/tasks/task-postflight.json 2>$null | Out-Null
                        & git -C $dir commit -qm init 2>$null | Out-Null
                    }
                }
                function Get-CommittedPaths([string]$dir, [string]$rev = 'HEAD') {
                    return (@(& git -C $dir show --pretty=format: --name-only $rev 2>$null |
                        Where-Object { $_ } | Sort-Object) -join ' ')
                }
                function Assert-ScopeRun([string]$name, [int]$code, [string]$outFile) {
                    if ($code -ne 0) {
                        Get-Content $outFile -ErrorAction SilentlyContinue | ForEach-Object { Write-Host $_ }
                        throw "SCENARIO ${name} FAILED: wrapper exited with $code"
                    }
                }
                function Get-RecordCommitLines([string]$dir) {
                    $f = Join-Path $dir '.moe\record_commit.jsonl'
                    if (-not (Test-Path $f)) { return @() }
                    return @(Get-Content $f | Where-Object { $_ })
                }

                # Scenario A — dirty peer. Owned X and Y commit; a peer's
                # MODIFIED tracked file and a peer's UNTRACKED file must both
                # survive the completion untouched.
                Write-Host '[scenario A] dirty peer files are never captured'
                $scopeADir = Join-Path $tempRoot 'scope-a'
                New-ScopeProject $scopeADir @('owned-a.txt', 'owned-b.txt')
                Set-Content -Path (Join-Path $scopeADir 'peer-mod.txt') -Value 'peer-base'
                & git -C $scopeADir add peer-mod.txt 2>$null | Out-Null
                & git -C $scopeADir commit -qm peer-base 2>$null | Out-Null
                Set-Content -Path (Join-Path $scopeADir 'owned-a.txt') -Value 'owned-a'
                Set-Content -Path (Join-Path $scopeADir 'owned-b.txt') -Value 'owned-b'
                Set-Content -Path (Join-Path $scopeADir 'peer-mod.txt') -Value 'peer-dirty'
                Set-Content -Path (Join-Path $scopeADir 'peer-untracked.txt') -Value 'peer-new'
                $scopeAOut = Join-Path $tempRoot 'scope-a.out'
                Assert-ScopeRun 'A' (Invoke-GateWrapper $scopeADir $scopeAOut) $scopeAOut
                $scopeAFiles = Get-CommittedPaths $scopeADir
                if ($scopeAFiles -ne 'owned-a.txt owned-b.txt') {
                    Get-Content $scopeAOut -ErrorAction SilentlyContinue | ForEach-Object { Write-Host $_ }
                    throw "SCENARIO A FAILED: commit must contain EXACTLY the owned paths; got [$scopeAFiles]"
                }
                $scopeAStatus = @(& git -C $scopeADir status --porcelain 2>$null)
                if ($scopeAStatus -notcontains ' M peer-mod.txt') {
                    throw "SCENARIO A FAILED: peer-mod.txt must still be modified-and-unstaged; status was [$($scopeAStatus -join '|')]"
                }
                if ($scopeAStatus -notcontains '?? peer-untracked.txt') {
                    throw "SCENARIO A FAILED: peer-untracked.txt must still be untracked; status was [$($scopeAStatus -join '|')]"
                }
                $scopeScenariosRun++
                Write-Host '[scenario A] ok'

                # Scenario B — pre-staged foreign index. The discriminating case:
                # a peer stages Z into the SHARED INDEX before the hook runs.
                # Pathspec STAGING cannot help here; only a pathspec-scoped
                # COMMIT keeps Z out.
                Write-Host "[scenario B] a peer's pre-staged index entry never rides along"
                $scopeBDir = Join-Path $tempRoot 'scope-b'
                New-ScopeProject $scopeBDir @('owned-a.txt')
                Set-Content -Path (Join-Path $scopeBDir 'owned-a.txt') -Value 'owned-a'
                Set-Content -Path (Join-Path $scopeBDir 'peer-staged.txt') -Value 'peer-staged'
                & git -C $scopeBDir add peer-staged.txt 2>$null | Out-Null
                $scopeBOut = Join-Path $tempRoot 'scope-b.out'
                Assert-ScopeRun 'B' (Invoke-GateWrapper $scopeBDir $scopeBOut) $scopeBOut
                $scopeBFiles = Get-CommittedPaths $scopeBDir
                if ($scopeBFiles -ne 'owned-a.txt') {
                    Get-Content $scopeBOut -ErrorAction SilentlyContinue | ForEach-Object { Write-Host $_ }
                    throw "SCENARIO B FAILED: commit must contain ONLY owned-a.txt; got [$scopeBFiles]"
                }
                & git -C $scopeBDir cat-file -e HEAD:peer-staged.txt 2>$null | Out-Null
                if ($LASTEXITCODE -eq 0) {
                    Get-Content $scopeBOut -ErrorAction SilentlyContinue | ForEach-Object { Write-Host $_ }
                    throw "SCENARIO B FAILED: the peer's pre-staged file reached HEAD — the commit is still index-scoped"
                }
                if (@(& git -C $scopeBDir diff --cached --name-only 2>$null) -notcontains 'peer-staged.txt') {
                    throw "SCENARIO B FAILED: the peer's file must remain STAGED and uncommitted"
                }
                $scopeScenariosRun++
                Write-Host '[scenario B] ok'

                # Scenario C — empty filesModified. Fails CLOSED under its own
                # stable code and commits nothing. The dirty peer file is
                # load-bearing: without it a restored `git add -A` would have
                # nothing to sweep and this would pass while testing nothing.
                Write-Host '[scenario C] empty owned-path set refuses with MOE_COMMIT_REFUSED_NO_OWNED_PATHS'
                $scopeCDir = Join-Path $tempRoot 'scope-c'
                New-ScopeProject $scopeCDir @()
                Set-Content -Path (Join-Path $scopeCDir 'peer-untracked.txt') -Value 'peer-new'
                $scopeCHead = (& git -C $scopeCDir rev-parse HEAD 2>$null)
                $scopeCOut = Join-Path $tempRoot 'scope-c.out'
                Assert-ScopeRun 'C' (Invoke-GateWrapper $scopeCDir $scopeCOut) $scopeCOut
                $scopeCText = Get-Content -Raw -Path $scopeCOut
                if ($scopeCText -notlike '*MOE_COMMIT_REFUSED_NO_OWNED_PATHS*') {
                    Write-Host $scopeCText
                    throw 'SCENARIO C FAILED: expected the literal reason code MOE_COMMIT_REFUSED_NO_OWNED_PATHS'
                }
                if ($scopeCText -like '*MOE_COMMIT_REFUSED_OWNED_PATH_MISSING*') {
                    Write-Host $scopeCText
                    throw 'SCENARIO C FAILED: an empty owned-path set must NOT report the missing-path code — the two causes are distinct'
                }
                if ((& git -C $scopeCDir rev-parse HEAD 2>$null) -ne $scopeCHead) {
                    throw 'SCENARIO C FAILED: a refusal must commit NOTHING; HEAD moved'
                }
                $scopeScenariosRun++
                Write-Host '[scenario C] ok'

                # Scenario D — every declared owned path is absent from disk.
                # Distinct cause, distinct code: collapsing it into C would make
                # a later guard change invisible.
                Write-Host '[scenario D] all owned paths missing refuses with MOE_COMMIT_REFUSED_OWNED_PATH_MISSING'
                $scopeDDir = Join-Path $tempRoot 'scope-d'
                New-ScopeProject $scopeDDir @('ghost-owned.txt')
                Set-Content -Path (Join-Path $scopeDDir 'peer-untracked.txt') -Value 'peer-new'
                $scopeDHead = (& git -C $scopeDDir rev-parse HEAD 2>$null)
                $scopeDOut = Join-Path $tempRoot 'scope-d.out'
                Assert-ScopeRun 'D' (Invoke-GateWrapper $scopeDDir $scopeDOut) $scopeDOut
                $scopeDText = Get-Content -Raw -Path $scopeDOut
                if ($scopeDText -notlike '*MOE_COMMIT_REFUSED_OWNED_PATH_MISSING*') {
                    Write-Host $scopeDText
                    throw 'SCENARIO D FAILED: expected the literal reason code MOE_COMMIT_REFUSED_OWNED_PATH_MISSING'
                }
                if ($scopeDText -like '*MOE_COMMIT_REFUSED_NO_OWNED_PATHS*') {
                    Write-Host $scopeDText
                    throw 'SCENARIO D FAILED: a declared-but-absent path must NOT report the empty-set code'
                }
                if ((& git -C $scopeDDir rev-parse HEAD 2>$null) -ne $scopeDHead) {
                    throw 'SCENARIO D FAILED: a refusal must commit NOTHING; HEAD moved'
                }
                $scopeScenariosRun++
                Write-Host '[scenario D] ok'

                # Scenario E — a GLOB in filesModified. A git pathspec is a glob
                # by default, so an entry of `*` walks straight back out to a
                # whole-tree stage through the very "explicit pathspec" route
                # this fix installs. Measured on a throwaway repo:
                # `git add -- '*'` staged every file; `git add -- ':(literal)*'`
                # matched nothing. Only this scenario can catch that escape.
                Write-Host '[scenario E] a glob in filesModified cannot widen the commit'
                $scopeEDir = Join-Path $tempRoot 'scope-e'
                New-ScopeProject $scopeEDir @('*')
                Set-Content -Path (Join-Path $scopeEDir 'peer-untracked.txt') -Value 'peer-new'
                $scopeEHead = (& git -C $scopeEDir rev-parse HEAD 2>$null)
                $scopeEOut = Join-Path $tempRoot 'scope-e.out'
                Assert-ScopeRun 'E' (Invoke-GateWrapper $scopeEDir $scopeEOut) $scopeEOut
                $scopeEText = Get-Content -Raw -Path $scopeEOut
                if ($scopeEText -notlike '*MOE_COMMIT_REFUSED_OWNED_PATH_MISSING*') {
                    Write-Host $scopeEText
                    throw 'SCENARIO E FAILED: a glob must match NO literal path and refuse with MOE_COMMIT_REFUSED_OWNED_PATH_MISSING'
                }
                if ((& git -C $scopeEDir rev-parse HEAD 2>$null) -ne $scopeEHead) {
                    throw 'SCENARIO E FAILED: a glob owned path swept the tree into a commit; HEAD moved'
                }
                if (@(& git -C $scopeEDir status --porcelain 2>$null) -notcontains '?? peer-untracked.txt') {
                    throw 'SCENARIO E FAILED: peer-untracked.txt must still be untracked'
                }
                $scopeScenariosRun++
                Write-Host '[scenario E] ok'

                # Scenario F — BLOCKED exit lands a checkpoint. The stranded-
                # source pattern: report_blocked ended the session with the
                # edits uncommitted forever. Exactly one wip(...) commit on the
                # peeled branch, only owned paths, peer file untouched, no
                # refusal code, and a checkpoint-kind ledger entry.
                Write-Host '[scenario F] a BLOCKED exit lands a wip checkpoint'
                $scopeFDir = Join-Path $tempRoot 'scope-f'
                New-ScopeProject $scopeFDir @('owned-a.txt') -Status 'BLOCKED'
                Set-Content -Path (Join-Path $scopeFDir 'owned-a.txt') -Value 'owned-a'
                Set-Content -Path (Join-Path $scopeFDir 'peer-untracked.txt') -Value 'peer-new'
                $scopeFOut = Join-Path $tempRoot 'scope-f.out'
                Assert-ScopeRun 'F' (Invoke-GateWrapper $scopeFDir $scopeFOut -Status 'BLOCKED') $scopeFOut
                $scopeFText = Get-Content -Raw -Path $scopeFOut
                if ([int](& git -C $scopeFDir rev-list --count HEAD 2>$null) -ne 2) {
                    Write-Host $scopeFText
                    throw "SCENARIO F FAILED: expected exactly one checkpoint commit on top of init"
                }
                $scopeFSubject = Get-HeadSubject $scopeFDir
                if ($scopeFSubject -ne 'wip(task-postflight): Postflight smoke [status=BLOCKED role=worker cli-exit=0]') {
                    Write-Host $scopeFText
                    throw "SCENARIO F FAILED: unexpected checkpoint subject [$scopeFSubject]"
                }
                if ((& git -C $scopeFDir symbolic-ref --short HEAD 2>$null) -notlike 'moe/work-*') {
                    throw 'SCENARIO F FAILED: the checkpoint must land on the peeled moe/work-* branch'
                }
                if ((Get-CommittedPaths $scopeFDir) -ne 'owned-a.txt') {
                    Write-Host $scopeFText
                    throw "SCENARIO F FAILED: checkpoint must contain only the owned path; got [$(Get-CommittedPaths $scopeFDir)]"
                }
                if (@(& git -C $scopeFDir status --porcelain 2>$null) -notcontains '?? peer-untracked.txt') {
                    throw 'SCENARIO F FAILED: peer-untracked.txt must still be untracked'
                }
                if ($scopeFText -like '*MOE_COMMIT_REFUSED_*') {
                    Write-Host $scopeFText
                    throw 'SCENARIO F FAILED: a checkpoint must not emit a refusal code'
                }
                $scopeFRecords = Get-RecordCommitLines $scopeFDir
                if (-not ($scopeFRecords | Where-Object { $_ -like '*"kind":"checkpoint"*' -and $_ -like '*"outcome":"committed"*' })) {
                    Write-Host ($scopeFRecords -join "`n")
                    throw 'SCENARIO F FAILED: record_commit.jsonl must carry a committed checkpoint entry'
                }
                $scopeScenariosRun++
                Write-Host '[scenario F] ok'

                # Scenario G — solo measured attribution: a file the session
                # created but never reported lands alongside the owned path
                # (no other worker is live), and the ledger marks it inferred.
                Write-Host '[scenario G] a solo session-created file is committed as inferred'
                $scopeGDir = Join-Path $tempRoot 'scope-g'
                New-ScopeProject $scopeGDir @('owned-a.txt')
                Set-Content -Path (Join-Path $scopeGDir 'owned-a.txt') -Value 'owned-a'
                $scopeGOut = Join-Path $tempRoot 'scope-g.out'
                $env:FAKE_SCOPE_PEERS_ACTIVE = '0'
                try {
                    Assert-ScopeRun 'G' (Invoke-GateWrapper $scopeGDir $scopeGOut -Command $createFileCmd) $scopeGOut
                } finally { Remove-Item Env:FAKE_SCOPE_PEERS_ACTIVE -ErrorAction SilentlyContinue }
                if ((Get-CommittedPaths $scopeGDir) -ne 'owned-a.txt session-new.txt') {
                    Get-Content $scopeGOut -ErrorAction SilentlyContinue | ForEach-Object { Write-Host $_ }
                    throw "SCENARIO G FAILED: expected owned-a.txt + session-new.txt; got [$(Get-CommittedPaths $scopeGDir)]"
                }
                $scopeGRecords = Get-RecordCommitLines $scopeGDir
                if (-not ($scopeGRecords | Where-Object { $_.Contains('"inferredPaths":["session-new.txt"]') })) {
                    Write-Host ($scopeGRecords -join "`n")
                    throw 'SCENARIO G FAILED: record_commit must list session-new.txt under inferredPaths'
                }
                if ((& git -C $scopeGDir log -1 --format=%B 2>$null | Out-String) -notlike '*Moe-Inferred: 1*') {
                    throw 'SCENARIO G FAILED: the commit message must carry Moe-Inferred: 1'
                }
                $scopeScenariosRun++
                Write-Host '[scenario G] ok'

                # Scenario H — pre-existing dirt is never swept: a tracked file
                # modified and an untracked file created BEFORE the session
                # stay put even though the session itself creates a file that
                # IS committed. The baseline file records them and is pruned
                # of the landed paths.
                Write-Host '[scenario H] pre-existing dirty paths are excluded by the baseline'
                $scopeHDir = Join-Path $tempRoot 'scope-h'
                New-ScopeProject $scopeHDir @('owned-a.txt')
                Set-Content -Path (Join-Path $scopeHDir 'baseline-mod.txt') -Value 'base'
                & git -C $scopeHDir add baseline-mod.txt 2>$null | Out-Null
                & git -C $scopeHDir commit -qm baseline-mod 2>$null | Out-Null
                Set-Content -Path (Join-Path $scopeHDir 'baseline-mod.txt') -Value 'dirty-before'
                Set-Content -Path (Join-Path $scopeHDir 'baseline-new.txt') -Value 'new-before'
                Set-Content -Path (Join-Path $scopeHDir 'owned-a.txt') -Value 'owned-a'
                $scopeHOut = Join-Path $tempRoot 'scope-h.out'
                Assert-ScopeRun 'H' (Invoke-GateWrapper $scopeHDir $scopeHOut -Command $createFileCmd) $scopeHOut
                if ((Get-CommittedPaths $scopeHDir) -ne 'owned-a.txt session-new.txt') {
                    Get-Content $scopeHOut -ErrorAction SilentlyContinue | ForEach-Object { Write-Host $_ }
                    throw "SCENARIO H FAILED: expected owned-a.txt + session-new.txt; got [$(Get-CommittedPaths $scopeHDir)]"
                }
                $scopeHStatus = @(& git -C $scopeHDir status --porcelain 2>$null)
                if ($scopeHStatus -notcontains ' M baseline-mod.txt') { throw "SCENARIO H FAILED: baseline-mod.txt must stay modified; status [$($scopeHStatus -join '|')]" }
                if ($scopeHStatus -notcontains '?? baseline-new.txt') { throw "SCENARIO H FAILED: baseline-new.txt must stay untracked; status [$($scopeHStatus -join '|')]" }
                & git -C $scopeHDir cat-file -e HEAD:baseline-new.txt 2>$null | Out-Null
                if ($LASTEXITCODE -eq 0) { throw 'SCENARIO H FAILED: baseline-new.txt reached HEAD' }
                $scopeHBaseline = Join-Path $scopeHDir '.git\moe\baseline\task-postflight.tsv'
                if (-not (Test-Path $scopeHBaseline)) { throw 'SCENARIO H FAILED: the baseline file must persist under .git/moe/baseline/ until the task is DONE' }
                $scopeHBaselineText = Get-Content -Raw -Path $scopeHBaseline
                if ($scopeHBaselineText -notlike '*baseline-mod.txt*' -or $scopeHBaselineText -notlike '*baseline-new.txt*') {
                    Write-Host $scopeHBaselineText
                    throw 'SCENARIO H FAILED: the baseline must still record the pre-existing dirty paths'
                }
                if ($scopeHBaselineText -like '*owned-a.txt*') {
                    Write-Host $scopeHBaselineText
                    throw 'SCENARIO H FAILED: landed paths must be pruned from the baseline'
                }
                $scopeScenariosRun++
                Write-Host '[scenario H] ok'

                # Scenario I — a path named by another LIVE task's plan is never
                # swept, even when this session created it and would otherwise
                # be attributed by measurement.
                Write-Host "[scenario I] a peer-declared path stays untracked"
                $scopeIDir = Join-Path $tempRoot 'scope-i'
                New-ScopeProject $scopeIDir @('owned-a.txt')
                Write-PeerTaskRecord $scopeIDir
                Set-Content -Path (Join-Path $scopeIDir 'owned-a.txt') -Value 'owned-a'
                $scopeIOut = Join-Path $tempRoot 'scope-i.out'
                Assert-ScopeRun 'I' (Invoke-GateWrapper $scopeIDir $scopeIOut -Command $createPeerCmd) $scopeIOut
                if ((Get-CommittedPaths $scopeIDir) -ne 'owned-a.txt session-new.txt') {
                    Get-Content $scopeIOut -ErrorAction SilentlyContinue | ForEach-Object { Write-Host $_ }
                    throw "SCENARIO I FAILED: expected owned-a.txt + session-new.txt; got [$(Get-CommittedPaths $scopeIDir)]"
                }
                if (@(& git -C $scopeIDir status --porcelain 2>$null) -notcontains '?? peer-plan.txt') { throw 'SCENARIO I FAILED: peer-plan.txt must stay untracked' }
                & git -C $scopeIDir cat-file -e HEAD:peer-plan.txt 2>$null | Out-Null
                if ($LASTEXITCODE -eq 0) { throw 'SCENARIO I FAILED: peer-plan.txt reached HEAD' }
                if ((Get-Content -Raw -Path $scopeIOut) -notlike '*MOE_ATTR_PEER_DECLARED(task-peer)*') {
                    Get-Content $scopeIOut -ErrorAction SilentlyContinue | ForEach-Object { Write-Host $_ }
                    throw 'SCENARIO I FAILED: expected a [skip] line with MOE_ATTR_PEER_DECLARED(task-peer)'
                }
                $scopeScenariosRun++
                Write-Host '[scenario I] ok'

                # Scenario J — peers active: an undeclared, non-tool-written
                # file is reported, never staged (attribution.undeclared=solo).
                Write-Host '[scenario J] with a live peer an undeclared file is reported as unattributed'
                $scopeJDir = Join-Path $tempRoot 'scope-j'
                New-ScopeProject $scopeJDir @('owned-a.txt')
                Set-Content -Path (Join-Path $scopeJDir 'owned-a.txt') -Value 'owned-a'
                $scopeJOut = Join-Path $tempRoot 'scope-j.out'
                $env:FAKE_SCOPE_PEERS_ACTIVE = '1'
                try {
                    Assert-ScopeRun 'J' (Invoke-GateWrapper $scopeJDir $scopeJOut -Command $createFileCmd) $scopeJOut
                } finally { Remove-Item Env:FAKE_SCOPE_PEERS_ACTIVE -ErrorAction SilentlyContinue }
                if ((Get-CommittedPaths $scopeJDir) -ne 'owned-a.txt') {
                    Get-Content $scopeJOut -ErrorAction SilentlyContinue | ForEach-Object { Write-Host $_ }
                    throw "SCENARIO J FAILED: only owned-a.txt may land; got [$(Get-CommittedPaths $scopeJDir)]"
                }
                if (@(& git -C $scopeJDir status --porcelain 2>$null) -notcontains '?? session-new.txt') { throw 'SCENARIO J FAILED: session-new.txt must stay untracked' }
                if ((Get-Content -Raw -Path $scopeJOut) -notlike '*MOE_ATTRIBUTION_UNRESOLVED*') {
                    Get-Content $scopeJOut -ErrorAction SilentlyContinue | ForEach-Object { Write-Host $_ }
                    throw 'SCENARIO J FAILED: expected MOE_ATTRIBUTION_UNRESOLVED in the log'
                }
                if (-not (Get-RecordCommitLines $scopeJDir | Where-Object { $_.Contains('"unattributedPaths":["session-new.txt"]') })) {
                    Write-Host ((Get-RecordCommitLines $scopeJDir) -join "`n")
                    throw 'SCENARIO J FAILED: record_commit must carry session-new.txt under unattributedPaths'
                }
                $scopeScenariosRun++
                Write-Host '[scenario J] ok'

                # Scenario K — tool-written evidence beats the peers-active rule:
                # the stream-json harvest saw Write/Edit tool_use on the files.
                Write-Host '[scenario K] tool-written files are committed even with peers active'
                $scopeKDir = Join-Path $tempRoot 'scope-k'
                New-ScopeProject $scopeKDir @('owned-a.txt')
                Set-Content -Path (Join-Path $scopeKDir 'owned-a.txt') -Value 'owned-a'
                $scopeKOut = Join-Path $tempRoot 'scope-k.out'
                $env:FAKE_SCOPE_PEERS_ACTIVE = '1'
                try {
                    Assert-ScopeRun 'K' (Invoke-GateWrapper $scopeKDir $scopeKOut -Command $streamJsonCmd) $scopeKOut
                } finally { Remove-Item Env:FAKE_SCOPE_PEERS_ACTIVE -ErrorAction SilentlyContinue }
                if ((Get-CommittedPaths $scopeKDir) -ne 'owned-a.txt tool-edited.txt tool-written.txt') {
                    Get-Content $scopeKOut -ErrorAction SilentlyContinue | ForEach-Object { Write-Host $_ }
                    throw "SCENARIO K FAILED: expected owned-a.txt + tool-edited.txt + tool-written.txt; got [$(Get-CommittedPaths $scopeKDir)]"
                }
                $scopeScenariosRun++
                Write-Host '[scenario K] ok'

                # Scenario K2 — Serena's current editing tools are TOOL
                # evidence too (same fixture as postflight.sh). Six asserted
                # paths are also peer-declared (contested): under the default
                # attribution.contested=skip-untouched each lands only with a
                # TOOL witness. refused.txt, named only by calls that changed
                # nothing, stays out.
                Write-Host "[scenario K2] Serena's current editing tools witness contested paths; no-op results do not"
                $scopeK2Dir = Join-Path $tempRoot 'scope-k2'
                New-ScopeProject $scopeK2Dir @('owned-a.txt', 'contested.txt', 'multi-a.txt', 'multi-b.txt', 'rename-decl.txt', 'refused.txt', 'sub dir/diag.txt')
                Set-Content -Path (Join-Path $scopeK2Dir 'owned-a.txt') -Value 'owned-a'
                $scopeK2Out = Join-Path $tempRoot 'scope-k2.out'
                $env:FAKE_SCOPE_PEERS_ACTIVE = '1'
                $env:FAKE_SCOPE_PEER_DECLARED = 'contested.txt:task-peer,multi-a.txt:task-peer,multi-b.txt:task-peer,rename-decl.txt:task-peer,refused.txt:task-peer,sub dir/diag.txt:task-peer'
                try {
                    Assert-ScopeRun 'K2' (Invoke-GateWrapper $scopeK2Dir $scopeK2Out -Command $serenaStreamCmd) $scopeK2Out
                } finally {
                    Remove-Item Env:FAKE_SCOPE_PEERS_ACTIVE -ErrorAction SilentlyContinue
                    Remove-Item Env:FAKE_SCOPE_PEER_DECLARED -ErrorAction SilentlyContinue
                }
                if ((Get-CommittedPaths $scopeK2Dir) -ne 'contested.txt multi-a.txt multi-b.txt owned-a.txt rename-decl.txt sub dir/diag.txt') {
                    Get-Content $scopeK2Out -ErrorAction SilentlyContinue | ForEach-Object { Write-Host $_ }
                    throw "SCENARIO K2 FAILED: expected owned-a.txt + every Serena-witnessed contested path; got [$(Get-CommittedPaths $scopeK2Dir)]"
                }
                if (@(& git -C $scopeK2Dir status --porcelain 2>$null) -notcontains '?? refused.txt') { throw 'SCENARIO K2 FAILED: refused.txt must stay untracked' }
                if (-not (Get-Content -Raw -Path $scopeK2Out).Contains('[skip] refused.txt MOE_ATTR_CONTESTED_UNTOUCHED(task-peer)')) {
                    Get-Content $scopeK2Out -ErrorAction SilentlyContinue | ForEach-Object { Write-Host $_ }
                    throw 'SCENARIO K2 FAILED: expected [skip] refused.txt MOE_ATTR_CONTESTED_UNTOUCHED(task-peer)'
                }
                $scopeScenariosRun++
                Write-Host '[scenario K2] ok'

                # Scenario L — declaration tiers. An ASSERTED path that was
                # already dirty at baseline and never changed is still committed
                # (declaration wins); a PLANNED-only path in the same state is
                # pre-existing debris and skipped with MOE_ATTR_PREEXISTING.
                # The scope carries no `declared` field here: this pins a daemon
                # from before it, whose asserted paths all land regardless of
                # the baseline (scenario L2 is the current daemon).
                Write-Host '[scenario L] asserted-unchanged commits; planned-unchanged is pre-existing'
                $scopeLDir = Join-Path $tempRoot 'scope-l'
                $scopeLPlan = @(@{ stepId = 's1'; title = 'planned step'; status = 'PENDING'; affectedFiles = @('planned.txt') })
                New-ScopeProject $scopeLDir @('owned-a.txt') -ImplementationPlan $scopeLPlan
                Set-Content -Path (Join-Path $scopeLDir 'owned-a.txt') -Value 'owned-a'
                Set-Content -Path (Join-Path $scopeLDir 'planned.txt') -Value 'planned-before'
                $scopeLOut = Join-Path $tempRoot 'scope-l.out'
                Assert-ScopeRun 'L' (Invoke-GateWrapper $scopeLDir $scopeLOut) $scopeLOut
                if ((Get-CommittedPaths $scopeLDir) -ne 'owned-a.txt') {
                    Get-Content $scopeLOut -ErrorAction SilentlyContinue | ForEach-Object { Write-Host $_ }
                    throw "SCENARIO L FAILED: only the asserted path may land; got [$(Get-CommittedPaths $scopeLDir)]"
                }
                if (@(& git -C $scopeLDir status --porcelain 2>$null) -notcontains '?? planned.txt') { throw 'SCENARIO L FAILED: planned.txt must stay untracked' }
                if (-not (Get-Content -Raw -Path $scopeLOut).Contains('[skip] planned.txt MOE_ATTR_PREEXISTING')) {
                    Get-Content $scopeLOut -ErrorAction SilentlyContinue | ForEach-Object { Write-Host $_ }
                    throw 'SCENARIO L FAILED: expected [skip] planned.txt MOE_ATTR_PREEXISTING'
                }
                $scopeScenariosRun++
                Write-Host '[scenario L] ok'

                # Scenario L2 — a path asserted only by HISTORY (filesModified,
                # completed steps, prior commits, touchedFiles; never
                # moe.declare_files) is a claim on the path, not on whatever
                # bytes sit in it. On 2026-09-30 a foreign uncommitted edit to a
                # security guard landed under the task whose delivered
                # filesModified named it, from a session that never touched the
                # file. Same fixture as postflight.sh: two sessions of one task,
                # checkpoints off, no TOOL witness (a codex seat):
                #   foreign.txt   filesModified, dirty before both sessions,
                #                 never touched: MOE_ATTR_ASSERTED_FOREIGN
                #   declared.txt  declare_files, dirty before both sessions,
                #                 never touched: lands (explicit contract)
                #   carried.txt   edited by session 1, which exits without a
                #                 landing: a C row, landed by session 2
                #   own.txt       edited by session 2: lands
                Write-Host '[scenario L2] history-only asserted bytes this task did not produce stay out; declared, carried and own bytes land'
                $scopeL2Dir = Join-Path $tempRoot 'scope-l2'
                New-ScopeProject $scopeL2Dir @('foreign.txt', 'declared.txt', 'carried.txt', 'own.txt') -Settings @{ checkpointCommits = $false } -Status 'WORKING'
                $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
                [System.IO.File]::WriteAllText((Join-Path $scopeL2Dir '.moe\tasks\task-postflight.json'),
                    '{"id":"task-postflight","title":"Postflight smoke","status":"WORKING","filesModified":["foreign.txt","declared.txt","carried.txt","own.txt"],"declaredFiles":["declared.txt"]}', $utf8NoBom)
                foreach ($f in @('foreign.txt', 'declared.txt', 'carried.txt', 'own.txt')) { Set-Content -Path (Join-Path $scopeL2Dir $f) -Value 'base' }
                & git -C $scopeL2Dir add foreign.txt declared.txt carried.txt own.txt .moe/tasks/task-postflight.json 2>$null | Out-Null
                & git -C $scopeL2Dir commit -qm l2-base 2>$null | Out-Null
                $l2Base = ((& git -C $scopeL2Dir rev-parse HEAD 2>$null) -join '').Trim()
                Set-Content -Path (Join-Path $scopeL2Dir 'foreign.txt') -Value 'foreign-edit'
                Set-Content -Path (Join-Path $scopeL2Dir 'declared.txt') -Value 'stranded-work'
                $l2Cmd = Join-Path $tempRoot 'l2-edit.cmd'
                Set-Content -Path $l2Cmd -Encoding ASCII -Value "@echo off`r`necho session edit>> `"%MOE_PROJECT_PATH%\%FAKE_L2_EDIT%`"`r`nexit /b 0`r`n"
                $scopeL2Out1 = Join-Path $tempRoot 'scope-l2-1.out'
                $scopeL2Out2 = Join-Path $tempRoot 'scope-l2-2.out'
                $env:FAKE_SCOPE_DECLARED_FIELD = '1'
                try {
                    $env:FAKE_L2_EDIT = 'carried.txt'
                    Assert-ScopeRun 'L2' (Invoke-GateWrapper $scopeL2Dir $scopeL2Out1 -Status 'WORKING' -Command $l2Cmd) $scopeL2Out1
                    if (((& git -C $scopeL2Dir rev-parse HEAD 2>$null) -join '').Trim() -ne $l2Base) { throw 'SCENARIO L2 FAILED: checkpoints are off: session 1 must not commit' }
                    $l2Bl = [System.IO.File]::ReadAllText((Join-Path $scopeL2Dir '.git\moe\baseline\task-postflight.tsv'))
                    $l2Rows = @($l2Bl -split "`n" | ForEach-Object { $_.TrimEnd("`r") })
                    $l2Carried = ((& git -C $scopeL2Dir hash-object carried.txt 2>$null) -join '').Trim()
                    if ($l2Rows -notcontains "C`t$l2Carried`tcarried.txt") { Write-Host $l2Bl; throw "SCENARIO L2 FAILED: session 1's own unlanded edit must travel as a C row" }
                    if (@($l2Rows | Where-Object { $_ -match "^C`t[^`t]*`t(foreign|declared)\.txt$" }).Count -gt 0) { Write-Host $l2Bl; throw 'SCENARIO L2 FAILED: bytes session 1 did not produce must never be carried' }
                    $env:FAKE_L2_EDIT = 'own.txt'
                    Assert-ScopeRun 'L2' (Invoke-GateWrapper $scopeL2Dir $scopeL2Out2 -Command $l2Cmd) $scopeL2Out2
                } finally {
                    Remove-Item Env:FAKE_SCOPE_DECLARED_FIELD -ErrorAction SilentlyContinue
                    Remove-Item Env:FAKE_L2_EDIT -ErrorAction SilentlyContinue
                }
                $l2Text = Get-Content -Raw -Path $scopeL2Out2
                if ((Get-CommittedPaths $scopeL2Dir) -ne 'carried.txt declared.txt own.txt') {
                    Write-Host $l2Text
                    throw "SCENARIO L2 FAILED: expected exactly the declared, carried and own paths; got [$(Get-CommittedPaths $scopeL2Dir)]"
                }
                if (-not $l2Text.Contains('[skip] foreign.txt MOE_ATTR_ASSERTED_FOREIGN')) { Write-Host $l2Text; throw 'SCENARIO L2 FAILED: expected [skip] foreign.txt MOE_ATTR_ASSERTED_FOREIGN' }
                if (@(& git -C $scopeL2Dir status --porcelain 2>$null) -notcontains ' M foreign.txt' -or
                    (Get-Content -Raw -Path (Join-Path $scopeL2Dir 'foreign.txt')).Trim() -ne 'foreign-edit') { throw 'SCENARIO L2 FAILED: foreign.txt must stay modified-and-unstaged with its bytes untouched' }
                if (@(& git -C $scopeL2Dir log --format=%H "$l2Base..HEAD" -- foreign.txt 2>$null | Where-Object { $_ }).Count -gt 0) { throw 'SCENARIO L2 FAILED: foreign.txt reached a commit' }
                if (-not (Get-RecordCommitLines $scopeL2Dir | Where-Object { $_.Contains('"foreign.txt"') -and $_.Contains('MOE_ATTR_ASSERTED_FOREIGN') })) {
                    Get-RecordCommitLines $scopeL2Dir | ForEach-Object { Write-Host $_ }
                    throw 'SCENARIO L2 FAILED: the skip must reach the ledger'
                }
                $scopeScenariosRun++
                Write-Host '[scenario L2] ok'

                # Scenario M — a lingering baseline (the previous session never
                # landed: Ctrl+C, window close, crash) is recovered at the NEXT
                # pre-flight of the task, before the CLI launches — on the
                # resume path and on the BLOCKED-hold idle path alike.
                Write-Host '[scenario M] a lingering baseline is recovered before launch'
                $scopeMDir = Join-Path $tempRoot 'scope-m'
                New-ScopeProject $scopeMDir @('owned-a.txt')
                Write-TaskRecord $scopeMDir @('resume-owned.txt') 'WORKING' $null 'task-resume' 'Resume smoke'
                Set-Content -Path (Join-Path $scopeMDir 'resume-owned.txt') -Value 'left-behind'
                $scopeMBaselineDir = Join-Path $scopeMDir '.git\moe\baseline'
                New-Item -ItemType Directory -Force -Path $scopeMBaselineDir | Out-Null
                $scopeMHead = (& git -C $scopeMDir rev-parse HEAD 2>$null)
                # A realistic lingering baseline: the .moe/ records were already
                # dirty when the dead session started (B rows with their blobs),
                # while resume-owned.txt is that session's own unlanded edit.
                $scopeMLines = @("#moe-baseline v1 task=task-resume at=2026-01-01T00:00:00Z head=$scopeMHead")
                foreach ($p in @('.moe/project.json', '.moe/messages/chan-general.jsonl', '.moe/tasks/task-postflight.json', '.moe/tasks/task-resume.json')) {
                    $h = ((& git -C $scopeMDir hash-object -- $p 2>$null) -join '').Trim()
                    $scopeMLines += "B`t$h`t$p"
                }
                [System.IO.File]::WriteAllText((Join-Path $scopeMBaselineDir 'task-resume.tsv'), (($scopeMLines -join "`n") + "`n"), (New-Object System.Text.UTF8Encoding($false)))
                $scopeMOut = Join-Path $tempRoot 'scope-m.out'
                $env:FAKE_CLAIM_MODE = 'resume'
                try {
                    Assert-ScopeRun 'M' (Invoke-GateWrapper $scopeMDir $scopeMOut -Status 'WORKING') $scopeMOut
                } finally { Remove-Item Env:FAKE_CLAIM_MODE -ErrorAction SilentlyContinue }
                $scopeMText = Get-Content -Raw -Path $scopeMOut
                if ($scopeMText -notlike '*MOE_CHECKPOINT_RECOVERED task=task-resume sha=*') {
                    Write-Host $scopeMText
                    throw 'SCENARIO M FAILED: expected MOE_CHECKPOINT_RECOVERED before the launch'
                }
                if ($scopeMText.IndexOf('MOE_CHECKPOINT_RECOVERED') -gt $scopeMText.IndexOf('Command: ')) {
                    throw 'SCENARIO M FAILED: the recovery must run BEFORE the CLI launch'
                }
                $scopeMSubject = Get-HeadSubject $scopeMDir
                if ($scopeMSubject -ne 'wip(task-resume): Resume smoke [status=WORKING role=worker cli-exit=0] recovered') {
                    Write-Host $scopeMText
                    throw "SCENARIO M FAILED: unexpected recovered-checkpoint subject [$scopeMSubject]"
                }
                # The own record was dirty-but-baselined-unchanged: it must STILL
                # land (board: own task record always while dirty) — the exact
                # set pins the board contract in BOTH harness twins.
                if ((Get-CommittedPaths $scopeMDir) -ne '.moe/tasks/task-resume.json resume-owned.txt') { throw "SCENARIO M FAILED: recovery must land EXACTLY the own record + resume-owned.txt; got [$(Get-CommittedPaths $scopeMDir)]" }
                # Second half: the BLOCKED-hold idle path (no CLI launched for the
                # held task) recovers the same way.
                Set-Content -Path (Join-Path $scopeMDir 'resume-owned.txt') -Value 'left-behind-again'
                # Run 1's post-flight completed a landing, so the baseline header
                # now says landed=1 — and a landed baseline is deliberately NOT
                # re-recovered (same semantics as moe-agent.sh). Simulate another
                # session dying mid-task by flipping the flag back to landed=0.
                $scopeMBaselineFile = Join-Path $scopeMBaselineDir 'task-resume.tsv'
                $scopeMBlText = [System.IO.File]::ReadAllText($scopeMBaselineFile)
                if ($scopeMBlText -notlike '*landed=1*') { throw 'SCENARIO M FAILED: run 1 must have marked its baseline landed=1' }
                [System.IO.File]::WriteAllText($scopeMBaselineFile, ($scopeMBlText -replace 'landed=1', 'landed=0'), (New-Object System.Text.UTF8Encoding($false)))
                $scopeMOut2 = Join-Path $tempRoot 'scope-m-blocked.out'
                $env:FAKE_CLAIM_MODE = 'blocked'
                try {
                    Assert-ScopeRun 'M' (Invoke-GateWrapper $scopeMDir $scopeMOut2 -Status 'BLOCKED') $scopeMOut2
                } finally { Remove-Item Env:FAKE_CLAIM_MODE -ErrorAction SilentlyContinue }
                $scopeMText2 = Get-Content -Raw -Path $scopeMOut2
                if (-not $scopeMText2.Contains('[blocked] task-resume is BLOCKED')) { Write-Host $scopeMText2; throw 'SCENARIO M FAILED: the BLOCKED hold suppression must still fire' }
                if ($scopeMText2 -notlike '*MOE_CHECKPOINT_RECOVERED task=task-resume sha=*') { Write-Host $scopeMText2; throw 'SCENARIO M FAILED: the idle path must recover the lingering baseline' }
                if ((Get-HeadSubject $scopeMDir) -ne 'wip(task-resume): Resume smoke [status=BLOCKED role=worker cli-exit=0] recovered') {
                    throw "SCENARIO M FAILED: unexpected idle-path subject [$(Get-HeadSubject $scopeMDir)]"
                }
                # M-c: a FINISHED task's unlanded baseline is recovered, then
                # dropped. A task can reach DONE or ARCHIVED while its last landing
                # never reached a branch, and nothing pre-flights it again:
                # dropping that baseline unrecovered would strand the bytes for good.
                foreach ($scopeMcStatus in @('DONE', 'ARCHIVED')) {
                    $scopeMcDir = Join-Path $tempRoot "scope-mc-$scopeMcStatus"
                    New-ScopeProject $scopeMcDir @('owned-a.txt')
                    Write-TaskRecord $scopeMcDir @('resume-owned.txt') $scopeMcStatus $null 'task-resume' 'Resume smoke'
                    Set-Content -Path (Join-Path $scopeMcDir 'resume-owned.txt') -Value 'left-behind'
                    $scopeMcBaselineDir = Join-Path $scopeMcDir '.git\moe\baseline'
                    New-Item -ItemType Directory -Force -Path $scopeMcBaselineDir | Out-Null
                    [System.IO.File]::WriteAllText((Join-Path $scopeMcBaselineDir 'task-resume.tsv'), "#moe-baseline v1 task=task-resume at=2026-01-01T00:00:00Z head= landed=0`n", (New-Object System.Text.UTF8Encoding($false)))
                    $scopeMcOut = Join-Path $tempRoot "scope-mc-$scopeMcStatus.out"
                    $env:FAKE_CLAIM_MODE = 'blocked'
                    try {
                        Assert-ScopeRun 'M' (Invoke-GateWrapper $scopeMcDir $scopeMcOut -Status 'BLOCKED') $scopeMcOut
                    } finally { Remove-Item Env:FAKE_CLAIM_MODE -ErrorAction SilentlyContinue }
                    $scopeMcText = Get-Content -Raw -Path $scopeMcOut
                    if ($scopeMcText -notlike '*MOE_CHECKPOINT_RECOVERED task=task-resume sha=*') { Write-Host $scopeMcText; throw "SCENARIO M FAILED: a $scopeMcStatus task's unlanded baseline must be recovered, not dropped" }
                    if ((Get-HeadSubject $scopeMcDir) -ne "wip(task-resume): Resume smoke [status=$scopeMcStatus role=worker cli-exit=0] recovered") {
                        Write-Host $scopeMcText; throw "SCENARIO M FAILED: unexpected recovered $scopeMcStatus subject [$(Get-HeadSubject $scopeMcDir)]"
                    }
                    if (@((Get-CommittedPaths $scopeMcDir) -split ' ') -notcontains 'resume-owned.txt') { throw "SCENARIO M FAILED: the recovered $scopeMcStatus checkpoint must carry resume-owned.txt; got [$(Get-CommittedPaths $scopeMcDir)]" }
                    if (Test-Path (Join-Path $scopeMcBaselineDir 'task-resume.tsv')) { throw "SCENARIO M FAILED: a $scopeMcStatus task's baseline must go once its recovery landed" }
                }
                # M-d: a finished task whose baseline already reads landed is only dropped.
                $scopeMdDir = Join-Path $tempRoot 'scope-md'
                New-ScopeProject $scopeMdDir @('owned-a.txt')
                Write-TaskRecord $scopeMdDir @('resume-owned.txt') 'DONE' $null 'task-resume' 'Resume smoke'
                Set-Content -Path (Join-Path $scopeMdDir 'resume-owned.txt') -Value 'left-behind'
                $scopeMdBaselineDir = Join-Path $scopeMdDir '.git\moe\baseline'
                New-Item -ItemType Directory -Force -Path $scopeMdBaselineDir | Out-Null
                [System.IO.File]::WriteAllText((Join-Path $scopeMdBaselineDir 'task-resume.tsv'), "#moe-baseline v1 task=task-resume at=2026-01-01T00:00:00Z head= landed=1`n", (New-Object System.Text.UTF8Encoding($false)))
                $scopeMdOut = Join-Path $tempRoot 'scope-md.out'
                $env:FAKE_CLAIM_MODE = 'blocked'
                try {
                    Assert-ScopeRun 'M' (Invoke-GateWrapper $scopeMdDir $scopeMdOut -Status 'BLOCKED') $scopeMdOut
                } finally { Remove-Item Env:FAKE_CLAIM_MODE -ErrorAction SilentlyContinue }
                $scopeMdText = Get-Content -Raw -Path $scopeMdOut
                if ($scopeMdText -like '*MOE_CHECKPOINT_RECOVERED*' -or (Get-HeadSubject $scopeMdDir) -like 'wip(task-resume)*') { Write-Host $scopeMdText; throw 'SCENARIO M FAILED: a finished task whose baseline reads landed must land nothing' }
                if (Test-Path (Join-Path $scopeMdBaselineDir 'task-resume.tsv')) { throw "SCENARIO M FAILED: a finished task's landed baseline must be dropped" }
                $scopeScenariosRun++
                Write-Host '[scenario M] ok'

                # Scenario M2 — the live-session guard on scenario M's recovery
                # predicate. "A baseline that never reached a completed landing"
                # is true for a CRASHED session AND for one that is still
                # running and about to commit: a worker calls complete_task, the
                # task flips to REVIEW, and a QA seat claims it inside the window
                # before the worker's CLI exits and its post-flight commits. The
                # old predicate made that QA pre-flight land the live worker's
                # entire implementation as its own `... recovered` checkpoint —
                # measured twice on 2026-09-11 (ac6c9dc carried
                # util/enforcement.ts +144 and util/enforcement.test.ts +472;
                # b5925e2 carried delivery/acceptance.test.ts +2184), leaving
                # each worker's feat(...) completion holding only a board record.
                # The live-session marker beside the baseline discriminates the
                # two. Five sub-cases: (a) and (b) are the fix; (c), (d) and (e)
                # are the behaviour that must NOT move and are asserted before
                # AND after it. Twin: scenario M2 in postflight.sh.
                Write-Host '[scenario M2] a live owner''s baseline is skipped; a dead one still recovers'

                # The fixtures must spell the marker exactly as moe-agent.ps1
                # writes it, so the case proves the real probe rather than a
                # private harness format.
                function Get-M2MarkerHost { return ([string]$env:COMPUTERNAME).ToLowerInvariant() }
                function Get-M2StartToken([int]$ProcId) {
                    try {
                        $p = Get-Process -Id $ProcId -ErrorAction SilentlyContinue
                        if ($null -eq $p) { return '' }
                        return ([string]$p.StartTime.ToUniversalTime().Ticks)
                    } catch { return '' }
                }
                function Write-M2LiveMarker([string]$dir, [int]$ProcId, [string]$StartToken, [string]$MarkerHost = '', [string]$Ns = 'win32') {
                    if (-not $MarkerHost) { $MarkerHost = Get-M2MarkerHost }
                    $bdir = Join-Path $dir '.git\moe\baseline'
                    New-Item -ItemType Directory -Force -Path $bdir | Out-Null
                    $line = "#moe-live v1 task=task-resume pid=$ProcId host=$MarkerHost ns=$Ns worker=worker-owner session=worker-owner@2026-09-11T10:27:44Z start=$StartToken"
                    [System.IO.File]::WriteAllText((Join-Path $bdir 'task-resume.live'), ($line + "`n"), (New-Object System.Text.UTF8Encoding($false)))
                }
                function New-M2Project([string]$dir, [string]$RecordStatus) {
                    New-ScopeProject $dir @('ignored.txt')
                    Write-TaskRecord $dir @('impl.txt') $RecordStatus $null 'task-resume' 'Resume smoke'
                    Set-Content -Path (Join-Path $dir 'impl.txt') -Value 'impl'
                    $bdir = Join-Path $dir '.git\moe\baseline'
                    New-Item -ItemType Directory -Force -Path $bdir | Out-Null
                    $head = ((& git -C $dir rev-parse HEAD 2>$null) -join '').Trim()
                    $lines = @("#moe-baseline v1 task=task-resume at=2026-01-01T00:00:00Z head=$head landed=0")
                    foreach ($p in @('.moe/project.json', '.moe/messages/chan-general.jsonl', '.moe/tasks/task-postflight.json', '.moe/tasks/task-resume.json')) {
                        if (-not (Test-Path -LiteralPath (Join-Path $dir $p))) { continue }
                        $h = ((& git -C $dir hash-object -- $p 2>$null) -join '').Trim()
                        $lines += "B`t$h`t$p"
                    }
                    [System.IO.File]::WriteAllText((Join-Path $bdir 'task-resume.tsv'), (($lines -join "`n") + "`n"), (New-Object System.Text.UTF8Encoding($false)))
                }
                function Get-M2Subjects([string]$dir) {
                    return @(& git -C $dir log --pretty=%s --fixed-strings --grep='Moe-Task: task-resume' 2>$null | Where-Object { $_ })
                }
                function Invoke-M2Run([string]$dir, [string]$outFile, [string]$ClaimMode, [string]$Status, [string]$Role, [string]$WorkerId, [string]$Command = '', [string]$Scenario = 'M2') {
                    $env:FAKE_CLAIM_MODE = $ClaimMode
                    try {
                        Assert-ScopeRun $Scenario (Invoke-GateWrapper $dir $outFile -Status $Status -Role $Role -WorkerId $WorkerId -Command $Command) $outFile
                    } finally { Remove-Item Env:FAKE_CLAIM_MODE -ErrorAction SilentlyContinue }
                }

                # A REAL long-lived child: a fabricated id would pass against a
                # wrapper that never probes at all, or probes the wrong table.
                $m2LiveProc = Start-Process -FilePath $psExe -ArgumentList @('-NoProfile', '-Command', 'Start-Sleep -Seconds 600') -PassThru -WindowStyle Hidden
                $script:M2LivePids += $m2LiveProc.Id
                $m2LivePid = $m2LiveProc.Id
                $m2LiveStart = Get-M2StartToken $m2LivePid
                if (-not $m2LiveStart) { throw 'SCENARIO M2 FAILED: could not read the spawned probe target''s start time' }
                $m2MarkerHost = Get-M2MarkerHost
                $m2SkipLine = "MOE_CHECKPOINT_SKIPPED_LIVE_OWNER task=task-resume pid=$m2LivePid host=$m2MarkerHost worker=worker-owner reason=live"

                # M2-a — the measured race, on the real claim shape: a qa seat
                # claiming a task already at REVIEW while its worker still runs.
                $scopeM2aDir = Join-Path $tempRoot 'scope-m2a'
                New-M2Project $scopeM2aDir 'REVIEW'
                Write-M2LiveMarker $scopeM2aDir $m2LivePid $m2LiveStart
                $scopeM2aOut = Join-Path $tempRoot 'scope-m2a.out'
                Invoke-M2Run $scopeM2aDir $scopeM2aOut 'resume' 'REVIEW' 'qa' 'qa-scope-m2'
                $scopeM2aText = Get-Content -Raw -Path $scopeM2aOut
                if ($scopeM2aText.Contains('MOE_CHECKPOINT_RECOVERED task=task-resume')) {
                    Write-Host $scopeM2aText
                    throw 'SCENARIO M2 FAILED: (a) the second seat recovered a LIVE owner''s baseline'
                }
                if (-not $scopeM2aText.Contains($m2SkipLine)) {
                    Write-Host $scopeM2aText
                    throw "SCENARIO M2 FAILED: (a) expected the exact skip line [$m2SkipLine]"
                }
                if ($scopeM2aText.IndexOf($m2SkipLine) -gt $scopeM2aText.IndexOf('Command: ')) {
                    throw 'SCENARIO M2 FAILED: (a) the skip decision must be taken BEFORE the CLI launch'
                }
                # The pre-flight is the only producer of a `... recovered`
                # subject, so its absence IS the fix and its presence IS the bug.
                if (@(Get-M2Subjects $scopeM2aDir | Where-Object { $_.EndsWith(' recovered') }).Count -ne 0) {
                    throw 'SCENARIO M2 FAILED: (a) a ''... recovered'' checkpoint was landed while the owner was alive'
                }
                # The owner's claim must survive: a seat that stands down must
                # not stamp its own id over the marker, or the NEXT seat would
                # see a dead owner and steal.
                $scopeM2aMarker = Join-Path $scopeM2aDir '.git\moe\baseline\task-resume.live'
                if (-not (Test-Path -LiteralPath $scopeM2aMarker)) { throw 'SCENARIO M2 FAILED: (a) the live owner''s marker was deleted by the seat that stood down' }
                if (-not ([System.IO.File]::ReadAllText($scopeM2aMarker)).Contains("pid=$m2LivePid")) {
                    throw 'SCENARIO M2 FAILED: (a) the live owner''s marker was overwritten by the seat that stood down'
                }

                # M2-b — the same guard on the idle (BLOCKED-hold) path, where
                # the pre-flight is the ONLY git actor, so the dirty bytes and
                # the baseline are observable directly after the run instead of
                # inferred from commit subjects.
                $scopeM2bDir = Join-Path $tempRoot 'scope-m2b'
                New-M2Project $scopeM2bDir 'BLOCKED'
                Write-M2LiveMarker $scopeM2bDir $m2LivePid $m2LiveStart
                $scopeM2bOut = Join-Path $tempRoot 'scope-m2b.out'
                Invoke-M2Run $scopeM2bDir $scopeM2bOut 'blocked' 'BLOCKED' 'worker' 'worker-scope-m2b'
                $scopeM2bText = Get-Content -Raw -Path $scopeM2bOut
                if (-not $scopeM2bText.Contains('[blocked] task-resume is BLOCKED')) { Write-Host $scopeM2bText; throw 'SCENARIO M2 FAILED: (b) the BLOCKED hold suppression must still fire' }
                if ($scopeM2bText.Contains('MOE_CHECKPOINT_RECOVERED task=task-resume')) {
                    Write-Host $scopeM2bText
                    throw 'SCENARIO M2 FAILED: (b) the idle path recovered a LIVE owner''s baseline'
                }
                if (-not $scopeM2bText.Contains($m2SkipLine)) { Write-Host $scopeM2bText; throw 'SCENARIO M2 FAILED: (b) expected the named skip line on the idle path' }
                if (@(Get-M2Subjects $scopeM2bDir).Count -ne 0) { throw 'SCENARIO M2 FAILED: (b) no commit at all may be landed for a live owner''s task' }
                if (@(& git -C $scopeM2bDir status --porcelain 2>$null) -notcontains '?? impl.txt') {
                    throw 'SCENARIO M2 FAILED: (b) impl.txt must still be present AND unstaged so the real owner can land it'
                }
                $scopeM2bBaseline = Join-Path $scopeM2bDir '.git\moe\baseline\task-resume.tsv'
                if (-not (Test-Path -LiteralPath $scopeM2bBaseline)) { throw 'SCENARIO M2 FAILED: (b) the baseline must be left intact on a skip' }
                if (-not ([System.IO.File]::ReadAllText($scopeM2bBaseline)).Contains(' landed=0')) {
                    throw 'SCENARIO M2 FAILED: (b) a skip must not mark the live owner''s baseline landed'
                }

                # M2-c — THE BEHAVIOUR THAT MUST NOT MOVE. A genuine crash leaves
                # a marker whose process is gone; the 2026-08-28 lost-code path
                # must recover it exactly as before. Spawn and reap a real child
                # so the id is definitively dead rather than merely unlikely.
                $m2DeadProc = Start-Process -FilePath $psExe -ArgumentList @('-NoProfile', '-Command', 'Start-Sleep -Seconds 600') -PassThru -WindowStyle Hidden
                $m2DeadPid = $m2DeadProc.Id
                $m2DeadStart = Get-M2StartToken $m2DeadPid
                Stop-Process -Id $m2DeadPid -Force -ErrorAction SilentlyContinue
                $m2DeadProc.WaitForExit(10000) | Out-Null
                if ($null -ne (Get-Process -Id $m2DeadPid -ErrorAction SilentlyContinue)) { throw 'SCENARIO M2 FAILED: (c) the probe target did not actually die' }
                $scopeM2cDir = Join-Path $tempRoot 'scope-m2c'
                New-M2Project $scopeM2cDir 'BLOCKED'
                Write-M2LiveMarker $scopeM2cDir $m2DeadPid $m2DeadStart
                $scopeM2cOut = Join-Path $tempRoot 'scope-m2c.out'
                Invoke-M2Run $scopeM2cDir $scopeM2cOut 'blocked' 'BLOCKED' 'worker' 'worker-scope-m2c'
                $scopeM2cText = Get-Content -Raw -Path $scopeM2cOut
                if (-not $scopeM2cText.Contains('MOE_CHECKPOINT_RECOVERED task=task-resume')) {
                    Write-Host $scopeM2cText
                    throw 'SCENARIO M2 FAILED: (c) a crashed owner''s baseline MUST still be recovered'
                }
                if ((Get-CommittedPaths $scopeM2cDir) -ne '.moe/tasks/task-resume.json impl.txt') {
                    throw "SCENARIO M2 FAILED: (c) the crash recovery must carry EXACTLY the own record + impl.txt; got [$(Get-CommittedPaths $scopeM2cDir)]"
                }
                if (Test-Path -LiteralPath (Join-Path $scopeM2cDir '.git\moe\baseline\task-resume.live')) {
                    throw 'SCENARIO M2 FAILED: (c) a stale marker must be deleted once its process is proven gone'
                }

                # M2-d — process-id REUSE. A live id whose recorded start token
                # does not match the process now holding it is a recycled id,
                # not the owner: it must recover, or a long-lived box would
                # suppress crash recovery by coincidence.
                $scopeM2dDir = Join-Path $tempRoot 'scope-m2d'
                New-M2Project $scopeM2dDir 'BLOCKED'
                Write-M2LiveMarker $scopeM2dDir $m2LivePid ($m2LiveStart + '999')
                $scopeM2dOut = Join-Path $tempRoot 'scope-m2d.out'
                Invoke-M2Run $scopeM2dDir $scopeM2dOut 'blocked' 'BLOCKED' 'worker' 'worker-scope-m2d'
                if (-not (Get-Content -Raw -Path $scopeM2dOut).Contains('MOE_CHECKPOINT_RECOVERED task=task-resume')) {
                    Get-Content $scopeM2dOut -ErrorAction SilentlyContinue | ForEach-Object { Write-Host $_ }
                    throw 'SCENARIO M2 FAILED: (d) a recycled process id must NOT be mistaken for the owner'
                }

                # M2-e — BACK-COMPATIBILITY. Every task in flight when this
                # change lands has a baseline and no marker; those must keep
                # recovering exactly as today.
                $scopeM2eDir = Join-Path $tempRoot 'scope-m2e'
                New-M2Project $scopeM2eDir 'BLOCKED'
                if (Test-Path -LiteralPath (Join-Path $scopeM2eDir '.git\moe\baseline\task-resume.live')) { throw 'SCENARIO M2 FAILED: (e) fixture error — the no-marker case must have no marker' }
                $scopeM2eOut = Join-Path $tempRoot 'scope-m2e.out'
                Invoke-M2Run $scopeM2eDir $scopeM2eOut 'blocked' 'BLOCKED' 'worker' 'worker-scope-m2e'
                if (-not (Get-Content -Raw -Path $scopeM2eOut).Contains('MOE_CHECKPOINT_RECOVERED task=task-resume')) {
                    Get-Content $scopeM2eOut -ErrorAction SilentlyContinue | ForEach-Object { Write-Host $_ }
                    throw 'SCENARIO M2 FAILED: (e) a baseline with NO marker must recover exactly as before'
                }

                Stop-Process -Id $m2LivePid -Force -ErrorAction SilentlyContinue
                $scopeScenariosRun++
                Write-Host '[scenario M2] ok'

                # Scenario M3 — the baseline's landed flag belongs to the session
                # whose pre-flight took it. On 2026-09-17 (task-49ec8755) QA's
                # exit landing, minutes after a rework claim's pre-flight re-took
                # the shared baseline, rewrote it to landed=1; the rework session
                # then died and the next pre-flight skipped its recovery. A
                # sibling's landing (committed, nothing to commit, or a deliberate
                # no-landing exit) must keep the other session's flag AND session.
                # A session's own landing still sets it, and so does a recovery,
                # or an idle poll would replay the recovery the previous poll
                # landed. Twin: scenario M3 in postflight.sh.
                Write-Host '[scenario M3] a sibling session''s landing never marks another session''s baseline landed'
                # task-resume planned (not asserted) on impl.txt, its record tracked and clean.
                function New-M3Project([string]$dir, [hashtable]$Settings = $null) {
                    New-ScopeProject $dir @('ignored.txt') -Settings $Settings
                    Write-TaskRecord $dir @() 'WORKING' @(@{ stepId = 's1'; title = 'rework'; status = 'IN_PROGRESS'; affectedFiles = @('impl.txt') }) 'task-resume' 'Resume smoke'
                    & git -C $dir add .moe/tasks/task-resume.json 2>$null | Out-Null
                    & git -C $dir commit -qm record 2>$null | Out-Null
                }
                function Get-M3Header([string]$dir) {
                    $f = Join-Path $dir '.git\moe\baseline\task-resume.tsv'
                    if (-not (Test-Path -LiteralPath $f)) { return '' }
                    return [System.IO.File]::ReadAllLines($f)[0]
                }
                # The sibling CLI plays session A's pre-flight while B's CLI is
                # still running: it re-takes ONLY the header under A's session
                # (every B/U row byte-identical) and leaves B's LIVE marker alone,
                # as a real pre-flight does — the QA-reject-then-rework shape.
                # SIBLING_TOUCH_RECORD=1 also rewrites the task record the way
                # qa_reject does, so B's checkpoint has a board path to land.
                $m3SiblingJs = Join-Path $tempRoot 'sibling-cli.cjs'
                [System.IO.File]::WriteAllText($m3SiblingJs, @'
const fs = require('fs'), path = require('path');
const bl = path.join(process.env.MOE_PROJECT_PATH, '.git', 'moe', 'baseline', 'task-resume.tsv');
if (!fs.existsSync(bl)) { console.error('sibling-cli fixture fault: no baseline at ' + bl); process.exit(3); }
const text = fs.readFileSync(bl, 'utf8'), nl = text.indexOf('\n'), header = text.slice(0, nl);
fs.writeFileSync(process.env.SIBLING_HEADER_OUT, header + '\n');
const head = (/ head=(\S*)/.exec(header) || ['', ''])[1];
fs.writeFileSync(bl + '.sibling', '#moe-baseline v1 task=task-resume at=2026-09-17T17:41:53Z head=' + head + ' landed=0 session=worker-a@2026-09-17T17:41:53Z' + text.slice(nl));
fs.renameSync(bl + '.sibling', bl);
if (process.env.SIBLING_TOUCH_RECORD === '1') {
  const rec = path.join(process.env.MOE_PROJECT_PATH, '.moe', 'tasks', 'task-resume.json');
  const t = JSON.parse(fs.readFileSync(rec, 'utf8').replace(/^﻿/, ''));
  t.reopenCount = 1;
  fs.writeFileSync(rec, JSON.stringify(t) + '\n');
}
'@, (New-Object System.Text.UTF8Encoding($false)))
                $m3SiblingCmd = Join-Path $tempRoot 'sibling-cli.cmd'
                Set-Content -Path $m3SiblingCmd -Encoding ASCII -Value "@echo off`r`nnode `"%~dp0sibling-cli.cjs`"`r`nexit /b %ERRORLEVEL%`r`n"

                # M3-a — the measured trigger. B (a qa exit) lands a checkpoint
                # under the baseline A's pre-flight re-took; A edits a planned
                # path AFTER B's landing (before it, B's checkpoint would have
                # committed the edit), then A dies without landing. The next
                # pre-flight (C) must recover A's edit.
                $scopeM3aDir = Join-Path $tempRoot 'scope-m3a'
                New-M3Project $scopeM3aDir
                $scopeM3aOutB = Join-Path $tempRoot 'scope-m3a-b.out'
                $scopeM3aPre = Join-Path $tempRoot 'm3a-b-preflight.txt'
                $env:SIBLING_HEADER_OUT = $scopeM3aPre
                $env:SIBLING_TOUCH_RECORD = '1'
                try {
                    Invoke-M2Run $scopeM3aDir $scopeM3aOutB 'resume' 'WORKING' 'qa' 'qa-scope-m3a' $m3SiblingCmd 'M3'
                } finally { Remove-Item Env:SIBLING_HEADER_OUT, Env:SIBLING_TOUCH_RECORD -ErrorAction SilentlyContinue }
                $scopeM3aSubjects = @(Get-M2Subjects $scopeM3aDir)
                if ($scopeM3aSubjects.Count -ne 1) {
                    Get-Content $scopeM3aOutB -ErrorAction SilentlyContinue | ForEach-Object { Write-Host $_ }
                    throw "SCENARIO M3 FAILED: (a) B must land exactly one task-resume checkpoint; got [$($scopeM3aSubjects -join ' | ')]"
                }
                if (-not ($scopeM3aSubjects[0].StartsWith('wip(task-resume): ') -and $scopeM3aSubjects[0].EndsWith('[status=WORKING role=qa cli-exit=0]'))) {
                    Get-Content $scopeM3aOutB -ErrorAction SilentlyContinue | ForEach-Object { Write-Host $_ }
                    throw "SCENARIO M3 FAILED: (a) B's landing must be a role=qa checkpoint, not a recovery; got [$($scopeM3aSubjects[0])]"
                }
                $scopeM3aAfterB = Get-M3Header $scopeM3aDir
                # C is a new claim: the fixture attempt B's claim opened is not C's.
                Remove-Item -Recurse -Force -LiteralPath (Join-Path $scopeM3aDir '.moe\attempts') -ErrorAction SilentlyContinue
                Set-Content -Path (Join-Path $scopeM3aDir 'impl.txt') -Value 'rework'
                $scopeM3aOutC = Join-Path $tempRoot 'scope-m3a-c.out'
                Invoke-M2Run $scopeM3aDir $scopeM3aOutC 'resume' 'WORKING' 'worker' 'worker-scope-m3c' '' 'M3'
                $scopeM3aTextC = Get-Content -Raw -Path $scopeM3aOutC
                if (-not $scopeM3aTextC.Contains('MOE_CHECKPOINT_RECOVERED task=task-resume')) {
                    Write-Host $scopeM3aTextC
                    throw 'SCENARIO M3 FAILED: (a) a sibling''s landing marked session A''s baseline landed, so the next pre-flight never recovered A''s edit'
                }
                $scopeM3aRecovered = @(& git -C $scopeM3aDir log --format='%H %s' --fixed-strings --grep='Moe-Task: task-resume' 2>$null | Where-Object { $_.EndsWith(' recovered') })
                if ($scopeM3aRecovered.Count -eq 0) { throw 'SCENARIO M3 FAILED: (a) no ''... recovered'' checkpoint was landed for A''s edit' }
                $scopeM3aFiles = Get-CommittedPaths $scopeM3aDir ($scopeM3aRecovered[0].Split(' ')[0])
                if ($scopeM3aFiles -ne 'impl.txt') { throw "SCENARIO M3 FAILED: (a) the recovered checkpoint must carry EXACTLY A's edit impl.txt; got [$scopeM3aFiles]" }
                if (-not $scopeM3aAfterB.Contains(' landed=0 session=worker-a@2026-09-17T17:41:53Z')) {
                    throw "SCENARIO M3 FAILED: (a) B's landing must keep session A's landed=0 AND A's session; got [$scopeM3aAfterB]"
                }
                $scopeM3aPreLine = if (Test-Path -LiteralPath $scopeM3aPre) { [System.IO.File]::ReadAllLines($scopeM3aPre)[0] } else { '' }
                if ($scopeM3aPreLine -cnotmatch '^#moe-baseline v1 task=task-resume at=[^ ]+ head=[0-9a-f]* landed=0 session=qa-scope-m3a@[^ ]+$') {
                    throw "SCENARIO M3 FAILED: (a) B's pre-flight must write landed=0 and its own session into the header; got [$scopeM3aPreLine]"
                }
                $scopeM3aAfterC = Get-M3Header $scopeM3aDir
                if ($scopeM3aAfterC -cnotmatch '^#moe-baseline v1 task=task-resume at=[^ ]+ head=[0-9a-f]* landed=1 session=worker-scope-m3c@[^ ]+$') {
                    throw "SCENARIO M3 FAILED: (a) a session's own landing must still mark its own baseline landed; got [$scopeM3aAfterC]"
                }

                # M3-b — B's landing has nothing to commit.
                $scopeM3bDir = Join-Path $tempRoot 'scope-m3b'
                New-M3Project $scopeM3bDir
                $scopeM3bOut = Join-Path $tempRoot 'scope-m3b.out'
                $env:SIBLING_HEADER_OUT = Join-Path $tempRoot 'm3b-b-preflight.txt'
                try {
                    Invoke-M2Run $scopeM3bDir $scopeM3bOut 'resume' 'WORKING' 'qa' 'qa-scope-m3b' $m3SiblingCmd 'M3'
                } finally { Remove-Item Env:SIBLING_HEADER_OUT -ErrorAction SilentlyContinue }
                $scopeM3bText = Get-Content -Raw -Path $scopeM3bOut
                if (-not $scopeM3bText.Contains('MOE_COMMIT_NOTHING_TO_COMMIT')) { Write-Host $scopeM3bText; throw 'SCENARIO M3 FAILED: (b) B''s landing must be nothing-to-commit' }
                if (@(Get-M2Subjects $scopeM3bDir).Count -ne 0) { throw 'SCENARIO M3 FAILED: (b) a nothing-to-commit landing must land no commit' }
                $scopeM3bAfterB = Get-M3Header $scopeM3bDir
                if (-not $scopeM3bAfterB.Contains(' landed=0 session=worker-a@2026-09-17T17:41:53Z')) {
                    throw "SCENARIO M3 FAILED: (b) a sibling's nothing-to-commit landing marked another session's baseline landed; got [$scopeM3bAfterB]"
                }

                # M3-c — B's exit is a deliberate no-landing (checkpointCommits=false).
                $scopeM3cDir = Join-Path $tempRoot 'scope-m3c'
                New-M3Project $scopeM3cDir @{ checkpointCommits = $false }
                $scopeM3cOut = Join-Path $tempRoot 'scope-m3c.out'
                $env:SIBLING_HEADER_OUT = Join-Path $tempRoot 'm3c-b-preflight.txt'
                try {
                    Invoke-M2Run $scopeM3cDir $scopeM3cOut 'resume' 'WORKING' 'qa' 'qa-scope-m3c' $m3SiblingCmd 'M3'
                } finally { Remove-Item Env:SIBLING_HEADER_OUT -ErrorAction SilentlyContinue }
                $scopeM3cText = Get-Content -Raw -Path $scopeM3cOut
                if (-not $scopeM3cText.Contains('no landing for task task-resume')) { Write-Host $scopeM3cText; throw 'SCENARIO M3 FAILED: (c) B''s exit must be the deliberate no-landing branch' }
                $scopeM3cAfterB = Get-M3Header $scopeM3cDir
                if (-not $scopeM3cAfterB.Contains(' landed=0 session=worker-a@2026-09-17T17:41:53Z')) {
                    throw "SCENARIO M3 FAILED: (c) a sibling's deliberate no-landing exit marked another session's baseline landed; got [$scopeM3cAfterB]"
                }

                # M3-d — the recovery exception. The idle paths recover under a
                # fresh session id on every poll, so a recovery must set the flag
                # itself (keeping the dead session's header session), or every
                # later poll replays it. The shared fake answers the BLOCKED
                # hold with task-resume.
                $scopeM3dDir = Join-Path $tempRoot 'scope-m3d'
                New-M2Project $scopeM3dDir 'BLOCKED'
                $scopeM3dBl = Join-Path $scopeM3dDir '.git\moe\baseline\task-resume.tsv'
                $scopeM3dLines = [System.IO.File]::ReadAllLines($scopeM3dBl)
                $scopeM3dLines[0] += ' session=worker-dead@2026-09-17T18:59:00Z'
                [System.IO.File]::WriteAllText($scopeM3dBl, (($scopeM3dLines -join "`n") + "`n"), (New-Object System.Text.UTF8Encoding($false)))
                $scopeM3dOut1 = Join-Path $tempRoot 'scope-m3d-1.out'
                Invoke-M2Run $scopeM3dDir $scopeM3dOut1 'blocked' 'BLOCKED' 'worker' 'worker-scope-m3d' '' 'M3'
                if (-not (Get-Content -Raw -Path $scopeM3dOut1).Contains('MOE_CHECKPOINT_RECOVERED task=task-resume')) {
                    Get-Content $scopeM3dOut1 -ErrorAction SilentlyContinue | ForEach-Object { Write-Host $_ }
                    throw 'SCENARIO M3 FAILED: (d) run 1 must recover the dead session''s baseline'
                }
                $scopeM3dAfter1 = Get-M3Header $scopeM3dDir
                Set-Content -Path (Join-Path $scopeM3dDir 'impl.txt') -Value 'again'
                $scopeM3dOut2 = Join-Path $tempRoot 'scope-m3d-2.out'
                Invoke-M2Run $scopeM3dDir $scopeM3dOut2 'blocked' 'BLOCKED' 'worker' 'worker-scope-m3d' '' 'M3'
                $scopeM3dSubjects = @(Get-M2Subjects $scopeM3dDir)
                $scopeM3dStatus = @(& git -C $scopeM3dDir status --porcelain 2>$null)
                if (((Get-Content -Raw -Path $scopeM3dOut2).Contains('MOE_CHECKPOINT_RECOVERED')) -or ($scopeM3dSubjects.Count -ne 1) -or ($scopeM3dStatus -notcontains ' M impl.txt')) {
                    Write-Host "subjects: [$($scopeM3dSubjects -join ' | ')] status: [$($scopeM3dStatus -join ' | ')]"
                    throw 'SCENARIO M3 FAILED: (d) an idle poll replayed the recovery the previous poll already landed'
                }
                if (-not $scopeM3dAfter1.Contains(' landed=1 session=worker-dead@2026-09-17T18:59:00Z')) {
                    throw "SCENARIO M3 FAILED: (d) a recovery must set landed=1 and keep the dead session's header session; got [$scopeM3dAfter1]"
                }
                $scopeScenariosRun++
                Write-Host '[scenario M3] ok'

                # Scenario M4 — crash rescue under scenario L2's history rule.
                # A session died without landing; its baseline's P rows are ITS
                # pre-flight snapshot. own-r.txt was clean then, so its dirty
                # bytes are that session's own edit and the recovery must still
                # land them; foreign-r.txt was already dirty with the bytes it
                # still has: someone else's, never landed. Same as postflight.sh.
                Write-Host "[scenario M4] a recovery lands the dead session's own bytes, never history-only bytes that predate it"
                $scopeM4Dir = Join-Path $tempRoot 'scope-m4'
                New-ScopeProject $scopeM4Dir @('ignored.txt')
                [System.IO.File]::WriteAllText((Join-Path $scopeM4Dir '.moe\tasks\task-resume.json'),
                    '{"id":"task-resume","title":"Resume smoke","status":"WORKING","filesModified":["own-r.txt","foreign-r.txt"]}', (New-Object System.Text.UTF8Encoding($false)))
                Set-Content -Path (Join-Path $scopeM4Dir 'own-r.txt') -Value 'base'
                Set-Content -Path (Join-Path $scopeM4Dir 'foreign-r.txt') -Value 'base'
                & git -C $scopeM4Dir add own-r.txt foreign-r.txt .moe/tasks/task-resume.json 2>$null | Out-Null
                & git -C $scopeM4Dir commit -qm m4-base 2>$null | Out-Null
                $m4Base = ((& git -C $scopeM4Dir rev-parse HEAD 2>$null) -join '').Trim()
                Set-Content -Path (Join-Path $scopeM4Dir 'foreign-r.txt') -Value 'foreign-edit'
                $m4BlDir = Join-Path $scopeM4Dir '.git\moe\baseline'
                New-Item -ItemType Directory -Force -Path $m4BlDir | Out-Null
                $m4Lines = @("#moe-baseline v1 task=task-resume at=2026-09-29T20:17:00Z head=$m4Base landed=0 session=worker-dead@2026-09-29T20:17:00Z")
                foreach ($kind in @('B', 'P')) {
                    foreach ($p in @('.moe/project.json', '.moe/messages/chan-general.jsonl', 'foreign-r.txt')) {
                        $h = ((& git -C $scopeM4Dir hash-object -- $p 2>$null) -join '').Trim()
                        $m4Lines += "$kind`t$h`t$p"
                    }
                }
                [System.IO.File]::WriteAllText((Join-Path $m4BlDir 'task-resume.tsv'), (($m4Lines -join "`n") + "`n"), (New-Object System.Text.UTF8Encoding($false)))
                Set-Content -Path (Join-Path $scopeM4Dir 'own-r.txt') -Value 'own-edit'
                $scopeM4Out = Join-Path $tempRoot 'scope-m4.out'
                $env:FAKE_CLAIM_MODE = 'resume'
                $env:FAKE_SCOPE_DECLARED_FIELD = '1'
                try {
                    Assert-ScopeRun 'M4' (Invoke-GateWrapper $scopeM4Dir $scopeM4Out -Status 'WORKING' -WorkerId 'worker-scope-m4') $scopeM4Out
                } finally {
                    Remove-Item Env:FAKE_CLAIM_MODE -ErrorAction SilentlyContinue
                    Remove-Item Env:FAKE_SCOPE_DECLARED_FIELD -ErrorAction SilentlyContinue
                }
                $m4Text = Get-Content -Raw -Path $scopeM4Out
                if ($m4Text -notlike '*MOE_CHECKPOINT_RECOVERED task=task-resume sha=*') { Write-Host $m4Text; throw 'SCENARIO M4 FAILED: expected MOE_CHECKPOINT_RECOVERED for task-resume' }
                $m4Sha = (@(& git -C $scopeM4Dir log --format='%H %s' --fixed-strings --grep='Moe-Task: task-resume' 2>$null | Where-Object { $_ -like '* recovered' }) | Select-Object -First 1) -replace ' .*$', ''
                if (-not $m4Sha -or (Get-CommittedPaths $scopeM4Dir $m4Sha) -ne 'own-r.txt') {
                    Write-Host $m4Text
                    throw "SCENARIO M4 FAILED: the recovered checkpoint must carry exactly the dead session's own edit; got [$(if ($m4Sha) { Get-CommittedPaths $scopeM4Dir $m4Sha })]"
                }
                if (-not $m4Text.Contains('[skip] foreign-r.txt MOE_ATTR_ASSERTED_FOREIGN')) { Write-Host $m4Text; throw 'SCENARIO M4 FAILED: expected [skip] foreign-r.txt MOE_ATTR_ASSERTED_FOREIGN' }
                if (@(& git -C $scopeM4Dir log --format=%H "$m4Base..HEAD" -- foreign-r.txt 2>$null | Where-Object { $_ }).Count -gt 0 -or
                    @(& git -C $scopeM4Dir status --porcelain 2>$null) -notcontains ' M foreign-r.txt') { throw 'SCENARIO M4 FAILED: foreign-r.txt must never be committed and must stay modified-and-unstaged' }
                $scopeScenariosRun++
                Write-Host '[scenario M4] ok'

                # Scenario N — plumbing keeps the shared index intact: a peer's
                # pre-staged entry survives (B under plumbing) AND the landed
                # path reads clean in `git status` after the index refresh.
                Write-Host "[scenario N] peer's staged entry survives and landed paths read clean"
                $scopeNDir = Join-Path $tempRoot 'scope-n'
                New-ScopeProject $scopeNDir @('owned-a.txt')
                Set-Content -Path (Join-Path $scopeNDir 'owned-a.txt') -Value 'owned-a'
                Set-Content -Path (Join-Path $scopeNDir 'peer-staged.txt') -Value 'peer-staged'
                & git -C $scopeNDir add peer-staged.txt 2>$null | Out-Null
                $scopeNOut = Join-Path $tempRoot 'scope-n.out'
                Assert-ScopeRun 'N' (Invoke-GateWrapper $scopeNDir $scopeNOut) $scopeNOut
                if ((Get-CommittedPaths $scopeNDir) -ne 'owned-a.txt') { throw "SCENARIO N FAILED: commit must contain ONLY owned-a.txt; got [$(Get-CommittedPaths $scopeNDir)]" }
                if (@(& git -C $scopeNDir diff --cached --name-only 2>$null) -notcontains 'peer-staged.txt') { throw "SCENARIO N FAILED: the peer's file must remain STAGED" }
                & git -C $scopeNDir cat-file -e HEAD:peer-staged.txt 2>$null | Out-Null
                if ($LASTEXITCODE -eq 0) { throw "SCENARIO N FAILED: the peer's staged file reached HEAD" }
                $scopeNStatus = @(& git -C $scopeNDir status --porcelain 2>$null)
                if ($scopeNStatus | Where-Object { $_ -like '*owned-a.txt' }) {
                    Write-Host ($scopeNStatus -join '|')
                    throw 'SCENARIO N FAILED: owned-a.txt must read clean after the index refresh'
                }
                $scopeScenariosRun++
                Write-Host '[scenario N] ok'

                # Scenario O — compare-and-swap retry: a peer moves the branch
                # tip between commit-tree and update-ref (the test seam). The
                # wrapper must rebuild on the new tip: two commits, ours on top,
                # both paths present in HEAD's tree.
                Write-Host '[scenario O] update-ref CAS retries when the branch moves under us'
                $scopeODir = Join-Path $tempRoot 'scope-o'
                New-ScopeProject $scopeODir @('owned-a.txt')
                Set-Content -Path (Join-Path $scopeODir 'owned-a.txt') -Value 'owned-a'
                $scopeOOut = Join-Path $tempRoot 'scope-o.out'
                $env:MOE_POSTFLIGHT_TEST_HOOK_PRE_UPDATE_REF = $hookPeerCmd
                try {
                    Assert-ScopeRun 'O' (Invoke-GateWrapper $scopeODir $scopeOOut) $scopeOOut
                } finally { Remove-Item Env:MOE_POSTFLIGHT_TEST_HOOK_PRE_UPDATE_REF -ErrorAction SilentlyContinue }
                if ([int](& git -C $scopeODir rev-list --count HEAD 2>$null) -ne 3) {
                    Get-Content $scopeOOut -ErrorAction SilentlyContinue | ForEach-Object { Write-Host $_ }
                    throw "SCENARIO O FAILED: expected init + peer-hook + ours"
                }
                if ((Get-HeadSubject $scopeODir) -notlike 'feat(task-postflight): *') { throw "SCENARIO O FAILED: ours must be on top; HEAD is [$(Get-HeadSubject $scopeODir)]" }
                if ((Get-HeadSubject $scopeODir 'HEAD~1') -ne 'peer-hook') { throw "SCENARIO O FAILED: the peer's commit must be HEAD~1; got [$(Get-HeadSubject $scopeODir 'HEAD~1')]" }
                & git -C $scopeODir cat-file -e HEAD:peer-hook.txt 2>$null | Out-Null
                if ($LASTEXITCODE -ne 0) { throw 'SCENARIO O FAILED: peer-hook.txt must be present in HEAD (rebuilt on the new tip)' }
                & git -C $scopeODir cat-file -e HEAD:owned-a.txt 2>$null | Out-Null
                if ($LASTEXITCODE -ne 0) { throw 'SCENARIO O FAILED: owned-a.txt must be present in HEAD' }
                if ((Get-Content -Raw -Path $scopeOOut) -notlike '*moved under us*') { throw 'SCENARIO O FAILED: expected the CAS retry log line' }
                $scopeScenariosRun++
                Write-Host '[scenario O] ok'

                # Scenario P — board state: the task's OWN record (rewritten by
                # the daemon during the session) is committed with the task; a
                # live peer's record is not.
                Write-Host "[scenario P] own board record commits with the task; a live peer's does not"
                $scopePDir = Join-Path $tempRoot 'scope-p'
                New-ScopeProject $scopePDir @('owned-a.txt')
                Write-PeerTaskRecord $scopePDir
                Set-Content -Path (Join-Path $scopePDir 'owned-a.txt') -Value 'owned-a'
                $scopePOut = Join-Path $tempRoot 'scope-p.out'
                $env:FAKE_SCOPE_PEERS_ACTIVE = '1'
                try {
                    Assert-ScopeRun 'P' (Invoke-GateWrapper $scopePDir $scopePOut -Command $touchBoardCmd) $scopePOut
                } finally { Remove-Item Env:FAKE_SCOPE_PEERS_ACTIVE -ErrorAction SilentlyContinue }
                if ((Get-CommittedPaths $scopePDir) -ne '.moe/tasks/task-postflight.json owned-a.txt') {
                    Get-Content $scopePOut -ErrorAction SilentlyContinue | ForEach-Object { Write-Host $_ }
                    throw "SCENARIO P FAILED: expected the own record + owned-a.txt; got [$(Get-CommittedPaths $scopePDir)]"
                }
                & git -C $scopePDir cat-file -e HEAD:.moe/tasks/task-peer.json 2>$null | Out-Null
                if ($LASTEXITCODE -eq 0) { throw "SCENARIO P FAILED: the live peer's record reached HEAD" }
                $scopeScenariosRun++
                Write-Host '[scenario P] ok'

                # Scenario P2 -- only current launch-failure BOARD-only checkpoints defer.
                $p2Check = Join-Path $tempRoot 'p2-check.cjs'
                [IO.File]::WriteAllText($p2Check, @'
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const [action, dir, mode, logFile, round = '1'] = process.argv.slice(2);
const board = '.moe/tasks/task-postflight.json';
const stateFile = path.join(dir, '.git/p2-state.json');
const skipCode = 'MOE_CHECKPOINT_SKIPPED_LAUNCH_FAILURE_BOARD_ONLY';
const read = p => fs.readFileSync(p, 'utf8');
const bytes = p => fs.readFileSync(path.join(dir, p)).toString('base64');
function git(...args) {
  return cp.execFileSync('git', ['-C', dir, ...args], {encoding: 'utf8'}).trim();
}
function rows(file) {
  return fs.existsSync(file) ? read(file).trim().split(/\r?\n/).filter(Boolean).map(JSON.parse) : [];
}
function prepare() {
  git('config', 'core.autocrlf', 'false');
  for (const p of [board, 'seed.txt']) fs.writeFileSync(path.join(dir, p), read(path.join(dir, p)).replace(/\r\n/g, '\n'));
  git('add', board, 'seed.txt');
  git('checkout', '-B', 'main');
  fs.writeFileSync(path.join(dir, 'owned-a.txt'), 'owned-base\n');
  fs.writeFileSync(path.join(dir, 'peer-plan.txt'), 'peer-base\n');
  git('add', 'owned-a.txt', 'peer-plan.txt');
  git('commit', '-qm', 'P2 fixture');
  const remote = dir + '-remote.git';
  cp.execFileSync('git', ['init', '--bare', '-q', remote]);
  git('remote', 'add', 'origin', remote);
  git('push', '-u', 'origin', 'main');
  const before = {head: git('rev-parse', 'HEAD'), branch: git('symbolic-ref', 'HEAD'),
    remote, refs: cp.execFileSync('git', ['--git-dir', remote, 'show-ref'], {encoding: 'utf8'})};
  fs.writeFileSync(path.join(dir, 'peer-plan.txt'), 'foreign-index\n');
  git('add', 'peer-plan.txt');
  fs.writeFileSync(path.join(dir, 'peer-plan.txt'), 'foreign-worktree\n');
  if (mode !== 'empty') fs.appendFileSync(path.join(dir, board), '\n \n');
  if (mode === 'owned') own();
  if (mode === 'deleted') fs.unlinkSync(path.join(dir, 'owned-a.txt'));
  Object.assign(before, {board: bytes(board), foreign: bytes('peer-plan.txt'),
    index: git('rev-parse', ':peer-plan.txt')});
  fs.writeFileSync(stateFile, JSON.stringify(before));
}
function own() { fs.writeFileSync(path.join(dir, 'owned-a.txt'), 'real-owned-change\n'); }
function assertCommon(before, ledger, log) {
  assert.equal(bytes('peer-plan.txt'), before.foreign, 'foreign worktree bytes');
  assert.equal(git('rev-parse', ':peer-plan.txt'), before.index, 'foreign staged bytes');
  assert.equal(git('for-each-ref', '--format=%(refname)', 'refs/moe/rescue/'), '', 'no rescue refs');
  assert.equal(ledger.filter(r => r.kind === 'rescue' || r.outcome === 'failed').length, 0, 'no rescue/failure ledger');
  assert.doesNotMatch(log, /MOE_CHECKPOINT_RECOVERED/, 'no recovery backdoor');
  assert.equal(fs.existsSync(path.join(dir, '.git/moe/baseline/task-postflight.live')), false, 'live marker removed');
  const rpc = rows(path.join(dir, '.moe/evidence-rpcs.jsonl'));
  assert.match(read(path.join(dir, '.moe/messages/chan-general.jsonl')), /session ended:/, 'postflight summary sent');
  assert.equal(rpc.some(r => r.tool === 'finalize_attempt'), mode === 'completion', 'only worker completion finalizes');
  return rpc;
}
function assertSkip(before, ledger, log, rpc) {
  // Keep the behavioral assertion FIRST: old wrappers must actually commit.
  assert.equal(git('rev-parse', 'HEAD'), before.head, 'P2 BOARD-only failure must leave HEAD unchanged');
  assert.equal(git('symbolic-ref', 'HEAD'), before.branch, 'skip must not peel branch');
  assert.equal(cp.execFileSync('git', ['--git-dir', before.remote, 'show-ref'], {encoding: 'utf8'}), before.refs);
  assert.equal(ledger.filter(r => r.outcome === 'committed').length, 0, 'zero checkpoints/rescues');
  assert.doesNotMatch(read(logFile + '.trace'), /built-in: git .*push(?: |$)/m, 'no push attempt');
  assert.equal(bytes(board), before.board, 'deferred BOARD bytes unchanged');
  if (mode !== 'empty') assert.ok(git('diff', '--name-only', 'HEAD', '--', board), 'BOARD still dirty');
  const expectedCode = mode === 'empty' ? 'MOE_COMMIT_NOTHING_TO_COMMIT' : skipCode;
  const last = ledger.at(-1);
  assert.equal(ledger.length, Number(round), 'exactly one nothing record per invocation');
  assert.equal(last.outcome, 'nothing');
  assert.equal(last.kind, 'checkpoint');
  assert.equal(last.code, expectedCode);
  assert.equal(last.cliExitCode, 1);
  assert.equal(last.sha || '', '');
  assert.equal(last.ref || '', '');
  assert.equal((last.paths || []).length, 0);
  assert.notEqual(last.pushed, true);
  assert.ok(log.includes(expectedCode), 'named code in log');
  if (mode !== 'empty') assert.match(log, /\[skip\]/);
  const messages = read(path.join(dir, '.moe/messages/chan-general.jsonl'));
  assert.ok(messages.includes('outcome=nothing code=' + expectedCode), 'session summary code');
  assert.equal(rpc.filter(r => ['record_candidate', 'record_check_run', 'record_delivery_receipt'].includes(r.tool)).length, 0);
  assert.equal(rpc.filter(r => r.tool === 'finalize_attempt').length, 0, 'QA does not finalize worker attempts');
  const baseline = read(path.join(dir, '.git/moe/baseline/task-postflight.tsv'));
  assert.match(baseline.split('\n')[0], / landed=1 .*session=qa-p2@/);
  if (mode !== 'empty') assert.ok(baseline.includes(board), 'deferred BOARD baseline retained');
}
function assertLanded(before, ledger, log) {
  assert.equal(git('rev-list', '--count', before.head + '..HEAD'), '1', 'exactly one real landing');
  const commits = ledger.filter(r => r.outcome === 'committed');
  assert.equal(commits.length, 1);
  const last = commits[0], completion = mode === 'completion';
  assert.equal(last.kind, completion ? 'completion' : 'checkpoint');
  assert.equal(last.cliExitCode, ['zero', 'later'].includes(mode) ? 0 : 1);
  assert.equal(last.pushed, true);
  assert.equal(last.sha, git('rev-parse', 'HEAD'));
  assert.equal(cp.execFileSync('git', ['--git-dir', before.remote, 'rev-parse', git('symbolic-ref', 'HEAD')], {encoding: 'utf8'}).trim(), last.sha);
  assert.match(read(logFile + '.trace'), /built-in: git .*push(?: |$)/m, 'successful push attempted');
  const want = ['owned', 'deleted', 'later'].includes(mode) ? [board, 'owned-a.txt'] : [board];
  assert.deepEqual(git('diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD').split('\n').sort(), want);
  assert.deepEqual([...last.paths].sort(), want);
  assert.equal(cp.execFileSync('git', ['-C', dir, 'show', 'HEAD:' + board]).toString('base64'), before.board);
  if (['owned', 'later'].includes(mode)) assert.equal(git('show', 'HEAD:owned-a.txt'), 'real-owned-change');
  if (mode === 'deleted') assert.equal(git('ls-tree', 'HEAD', 'owned-a.txt'), '');
  if (!completion) assert.match(git('log', '-1', '--format=%s'), /^wip\(task-postflight\):/);
  assert.doesNotMatch(log, new RegExp(skipCode), 'non-skipped control');
  if (mode === 'later') assert.equal(ledger.filter(r => r.code === skipCode).length, 2, 'two deferred retries');
}
if (action === 'prepare') prepare();
else if (action === 'own') own();
else if (action === 'begin') fs.rmSync(path.join(dir, '.moe/attempts/attempt-postflight.json'), {force: true});
else {
  const before = JSON.parse(read(stateFile));
  const ledger = rows(path.join(dir, '.moe/record_commit.jsonl'));
  const log = read(logFile);
  // Old-code RED proof must name HEAD movement, not a missing marker.
  if (['board', 'retry', 'empty'].includes(mode))
    assert.equal(git('rev-parse', 'HEAD'), before.head, 'P2 BOARD-only failure must leave HEAD unchanged');
  const rpc = assertCommon(before, ledger, log);
  if (['board', 'retry', 'empty'].includes(mode)) assertSkip(before, ledger, log, rpc);
  else assertLanded(before, ledger, log);
  console.log('[scenario P2-' + mode + '-' + round + '] ok');
}
'@, [Text.UTF8Encoding]::new($false))
                $p2Fail = Join-Path $tempRoot 'p2-fail.cmd'
                Set-Content -Path $p2Fail -Encoding ASCII -Value "@echo off`r`nexit /b 1`r`n"
                $p2Env = @{}
                foreach ($key in @('MOE_LAUNCH_FAIL_SEC', 'GIT_TRACE', 'FAKE_ATTEMPT_PHASE')) { $p2Env[$key] = [Environment]::GetEnvironmentVariable($key) }
                try {
                    $env:FAKE_ATTEMPT_PHASE = 'finalizing'
                    foreach ($p2Mode in @('board', 'owned', 'retry', 'zero', 'outside', 'completion', 'empty', 'deleted')) {
                        $p2Dir = Join-Path $tempRoot "scope-p2-$p2Mode"
                        New-ScopeProject $p2Dir @('owned-a.txt') -Settings @{ checkpointPush = $true }
                        Write-PeerTaskRecord $p2Dir
                        & node $p2Check prepare $p2Dir $p2Mode
                        if ($LASTEXITCODE -ne 0) { throw "P2 fixture failed: $p2Mode" }
                        $p2Cli = $p2Fail; $p2Role = 'qa'; $env:MOE_LAUNCH_FAIL_SEC = '120'
                        if ($p2Mode -eq 'zero') { $p2Cli = $trueCmd }
                        if ($p2Mode -eq 'outside') { $env:MOE_LAUNCH_FAIL_SEC = '0' }
                        if ($p2Mode -eq 'completion') { $p2Role = 'worker' }
                        $p2Rounds = 1; if ($p2Mode -eq 'retry') { $p2Rounds = 2 }
                        for ($p2Round = 1; $p2Round -le $p2Rounds; $p2Round++) {
                            $p2Out = Join-Path $tempRoot "p2-$p2Mode-$p2Round.out"
                            $env:GIT_TRACE = "$p2Out.trace"
                            & node $p2Check begin $p2Dir
                            if ($LASTEXITCODE -ne 0) { throw 'P2 fresh attempt fixture failed' }
                            Assert-ScopeRun 'P2' (Invoke-GateWrapper $p2Dir $p2Out -Command $p2Cli -Role $p2Role -WorkerId "$p2Role-p2") $p2Out
                            & node $p2Check verify $p2Dir $p2Mode $p2Out $p2Round
                            if ($LASTEXITCODE -ne 0) { throw "SCENARIO P2 FAILED: behavior assertion ($p2Mode); log $p2Out" }
                        }
                        if ($p2Mode -eq 'retry') {
                            & node $p2Check own $p2Dir
                            if ($LASTEXITCODE -ne 0) { throw 'P2 later owned change failed' }
                            $p2Out = Join-Path $tempRoot 'p2-later.out'; $env:GIT_TRACE = "$p2Out.trace"
                            & node $p2Check begin $p2Dir
                            if ($LASTEXITCODE -ne 0) { throw 'P2 fresh attempt fixture failed' }
                            Assert-ScopeRun 'P2' (Invoke-GateWrapper $p2Dir $p2Out -Command $trueCmd -Role 'qa' -WorkerId 'qa-p2') $p2Out
                            & node $p2Check verify $p2Dir later $p2Out
                            if ($LASTEXITCODE -ne 0) { throw 'SCENARIO P2 FAILED: later owned landing' }
                        }
                    }
                } finally {
                    foreach ($key in $p2Env.Keys) {
                        if ($null -ne $p2Env[$key]) { Set-Item "Env:$key" $p2Env[$key] }
                        else { Remove-Item "Env:$key" -ErrorAction SilentlyContinue }
                    }
                }
                $scopeScenariosRun++
                Write-Host '[scenario P2] ok (10 invocations)'


                # Scenario Q — gate failure parks the work on a RESCUE REF: HEAD
                # unchanged, refs/moe/rescue/<task>/* holds the owned paths,
                # MOE_RESCUE_REF + PUSH-BLOCKED in log and chat, and the wrapper
                # STOPS (with -Loop -PollInterval 1 a non-stopping wrapper
                # would claim again and hit the 30 s timeout).
                Write-Host '[scenario Q] a failing quality gate yields a rescue ref and stops the wrapper'
                $scopeQDir = Join-Path $tempRoot 'scope-q'
                New-GateProject $scopeQDir 'exit 3'
                $scopeQHead = (& git -C $scopeQDir rev-parse HEAD 2>$null)
                $scopeQOut = Join-Path $tempRoot 'scope-q.out'
                Assert-ScopeRun 'Q' (Invoke-GateWrapper $scopeQDir $scopeQOut -LoopOneSecond) $scopeQOut
                $scopeQText = Get-Content -Raw -Path $scopeQOut
                if ((& git -C $scopeQDir rev-parse HEAD 2>$null) -ne $scopeQHead) { Write-Host $scopeQText; throw 'SCENARIO Q FAILED: HEAD must not move on a gate failure' }
                $scopeQRefs = @(Get-RescueRefs $scopeQDir)
                if ($scopeQRefs.Count -ne 1) { Write-Host $scopeQText; throw "SCENARIO Q FAILED: expected exactly one rescue ref; got [$($scopeQRefs -join ',')]" }
                # The gate project's own record is untracked-dirty (same fixture
                # as postflight.sh's make_gate_project), so the rescue parks it
                # too — the own record is always a board candidate while dirty.
                if ((Get-CommittedPaths $scopeQDir $scopeQRefs[0]) -ne '.moe/tasks/task-postflight.json work.txt') { throw "SCENARIO Q FAILED: the rescue ref must hold the own record + work.txt; got [$(Get-CommittedPaths $scopeQDir $scopeQRefs[0])]" }
                if ((Get-HeadSubject $scopeQDir $scopeQRefs[0]) -notmatch '^rescue\(task-postflight\): .* \[reason=gate-failed\]$') { throw "SCENARIO Q FAILED: unexpected rescue subject [$(Get-HeadSubject $scopeQDir $scopeQRefs[0])]" }
                if ($scopeQText -notlike '*MOE_RESCUE_REF task=task-postflight ref=refs/moe/rescue/task-postflight/*reason=gate-failed*') { Write-Host $scopeQText; throw 'SCENARIO Q FAILED: expected the MOE_RESCUE_REF log line' }
                $scopeQChat = Get-Content -Raw -Path (Join-Path $scopeQDir '.moe\messages\chan-general.jsonl')
                if ($scopeQChat -notlike '*MOE_RESCUE_REF task=task-postflight*') { Write-Host $scopeQChat; throw 'SCENARIO Q FAILED: expected MOE_RESCUE_REF in chat' }
                if ($scopeQChat -notlike '*PUSH-BLOCKED: qualityGate failed for task task-postflight*') { Write-Host $scopeQChat; throw 'SCENARIO Q FAILED: expected PUSH-BLOCKED in chat' }
                if ($scopeQText -like '*Agent idle, checking for tasks*') { throw 'SCENARIO Q FAILED: the wrapper must stop after a gate failure, not keep polling' }
                if (-not (Test-Path (Join-Path $scopeQDir '.git\moe\baseline\task-postflight.tsv'))) { throw 'SCENARIO Q FAILED: the baseline must be kept after a gate failure' }
                # Ledger: the rescue's committed/rescue record AND an
                # unconditional failed record — task.lastCommitOutcome must read
                # failed/MOE_COMMIT_FAILED_GATE on both wrappers.
                $scopeQRecords = @(Get-RecordCommitLines $scopeQDir)
                if (-not ($scopeQRecords | Where-Object { $_ -like '*"kind":"rescue"*' })) {
                    Write-Host ($scopeQRecords -join "`n")
                    throw 'SCENARIO Q FAILED: record_commit.jsonl must carry a kind=rescue entry'
                }
                if ($scopeQRecords.Count -eq 0 -or $scopeQRecords[-1] -notlike '*"outcome":"failed"*' -or $scopeQRecords[-1] -notlike '*MOE_COMMIT_FAILED_GATE*') {
                    Write-Host ($scopeQRecords -join "`n")
                    throw 'SCENARIO Q FAILED: the LAST ledger record must be outcome=failed code=MOE_COMMIT_FAILED_GATE (sent even when the rescue succeeded)'
                }
                $scopeScenariosRun++
                Write-Host '[scenario Q] ok'

                # Scenario R — peel failure (a branch literally named `moe`
                # blocks moe/work-<date>): rescue ref, `break`, exit 0. Both
                # wrappers must break here (the ps1 used to `continue`).
                Write-Host '[scenario R] a branch-peel failure yields a rescue ref and stops the wrapper'
                $scopeRDir = Join-Path $tempRoot 'scope-r'
                New-ScopeProject $scopeRDir @('owned-a.txt')
                & git -C $scopeRDir branch moe 2>$null | Out-Null
                Set-Content -Path (Join-Path $scopeRDir 'owned-a.txt') -Value 'owned-a'
                $scopeRHead = (& git -C $scopeRDir rev-parse HEAD 2>$null)
                $scopeROut = Join-Path $tempRoot 'scope-r.out'
                Assert-ScopeRun 'R' (Invoke-GateWrapper $scopeRDir $scopeROut -LoopOneSecond) $scopeROut
                $scopeRText = Get-Content -Raw -Path $scopeROut
                if ((& git -C $scopeRDir rev-parse HEAD 2>$null) -ne $scopeRHead) { Write-Host $scopeRText; throw 'SCENARIO R FAILED: HEAD must not move when the peel fails' }
                $scopeRRefs = @(Get-RescueRefs $scopeRDir)
                if ($scopeRRefs.Count -ne 1) { Write-Host $scopeRText; throw "SCENARIO R FAILED: expected exactly one rescue ref; got [$($scopeRRefs -join ',')]" }
                if ((Get-HeadSubject $scopeRDir $scopeRRefs[0]) -notmatch '\[reason=peel-failed\]$') { throw "SCENARIO R FAILED: unexpected rescue subject [$(Get-HeadSubject $scopeRDir $scopeRRefs[0])]" }
                if ($scopeRText -notlike '*MOE_RESCUE_REF task=task-postflight*reason=peel-failed*') { Write-Host $scopeRText; throw 'SCENARIO R FAILED: expected the MOE_RESCUE_REF log line' }
                if ($scopeRText -like '*Agent idle, checking for tasks*') { throw 'SCENARIO R FAILED: the wrapper must stop after a peel failure' }
                $scopeRRecords = @(Get-RecordCommitLines $scopeRDir)
                if ($scopeRRecords.Count -eq 0 -or $scopeRRecords[-1] -notlike '*"outcome":"failed"*' -or $scopeRRecords[-1] -notlike '*MOE_COMMIT_FAILED_PEEL*') {
                    Write-Host ($scopeRRecords -join "`n")
                    throw 'SCENARIO R FAILED: the LAST ledger record must be outcome=failed code=MOE_COMMIT_FAILED_PEEL (sent even when the rescue succeeded)'
                }
                $scopeScenariosRun++
                Write-Host '[scenario R] ok'

                # Scenario S — DONE at exit (QA raced ahead) is a completion, not
                # a silent skip; the baseline is dropped once the task is DONE.
                Write-Host '[scenario S] a DONE status still lands a completion commit'
                $scopeSDir = Join-Path $tempRoot 'scope-s'
                New-ScopeProject $scopeSDir @('owned-a.txt')
                Set-Content -Path (Join-Path $scopeSDir 'owned-a.txt') -Value 'owned-a'
                $scopeSOut = Join-Path $tempRoot 'scope-s.out'
                Assert-ScopeRun 'S' (Invoke-GateWrapper $scopeSDir $scopeSOut -Status 'DONE') $scopeSOut
                if ((Get-HeadSubject $scopeSDir) -ne 'feat(task-postflight): Postflight smoke') { Get-Content $scopeSOut | ForEach-Object { Write-Host $_ }; throw "SCENARIO S FAILED: expected a completion subject; got [$(Get-HeadSubject $scopeSDir)]" }
                if ((& git -C $scopeSDir log -1 --format=%B 2>$null | Out-String) -notlike '*Moe-Status: DONE*') { throw 'SCENARIO S FAILED: the trailer must carry Moe-Status: DONE' }
                if (Test-Path (Join-Path $scopeSDir '.git\moe\baseline\task-postflight.tsv')) { throw 'SCENARIO S FAILED: the baseline must be dropped once the task is DONE' }
                $scopeScenariosRun++
                Write-Host '[scenario S] ok'

                # Scenario T — architect sessions checkpoint their edits under
                # the task id with role=architect in the subject.
                Write-Host '[scenario T] an architect session lands a wip checkpoint'
                $scopeTDir = Join-Path $tempRoot 'scope-t'
                New-ScopeProject $scopeTDir @('owned-a.txt') -Status 'WORKING'
                Set-Content -Path (Join-Path $scopeTDir 'owned-a.txt') -Value 'owned-a'
                $scopeTOut = Join-Path $tempRoot 'scope-t.out'
                Assert-ScopeRun 'T' (Invoke-GateWrapper $scopeTDir $scopeTOut -Status 'WORKING' -Role 'architect' -WorkerId 'architect-gate') $scopeTOut
                if ((Get-HeadSubject $scopeTDir) -ne 'wip(task-postflight): Postflight smoke [status=WORKING role=architect cli-exit=0]') {
                    Get-Content $scopeTOut | ForEach-Object { Write-Host $_ }
                    throw "SCENARIO T FAILED: unexpected subject [$(Get-HeadSubject $scopeTDir)]"
                }
                $scopeScenariosRun++
                Write-Host '[scenario T] ok'

                # Scenario U — unborn HEAD (fresh init, zero commits): the commit
                # lands with no parent and no <old> in the CAS.
                Write-Host '[scenario U] an unborn-HEAD repo still lands the commit'
                $scopeUDir = Join-Path $tempRoot 'scope-u'
                New-ScopeProject $scopeUDir @('owned-a.txt') -NoSeed
                Set-Content -Path (Join-Path $scopeUDir 'owned-a.txt') -Value 'owned-a'
                $scopeUOut = Join-Path $tempRoot 'scope-u.out'
                Assert-ScopeRun 'U' (Invoke-GateWrapper $scopeUDir $scopeUOut) $scopeUOut
                if ([int](& git -C $scopeUDir rev-list --count HEAD 2>$null) -ne 1) { Get-Content $scopeUOut | ForEach-Object { Write-Host $_ }; throw 'SCENARIO U FAILED: expected exactly one (root) commit' }
                # No seed commit, so the own record is untracked-dirty and rides
                # as a board candidate — same exact set as postflight.sh.
                if ((Get-CommittedPaths $scopeUDir) -ne '.moe/tasks/task-postflight.json owned-a.txt') { throw "SCENARIO U FAILED: expected the owned path + board record; got [$(Get-CommittedPaths $scopeUDir)]" }
                if ((& git -C $scopeUDir log -1 --format=%P 2>$null | Out-String).Trim()) { throw 'SCENARIO U FAILED: the root commit must have no parent' }
                if ((& git -C $scopeUDir symbolic-ref --short HEAD 2>$null) -notlike 'moe/work-*') { throw 'SCENARIO U FAILED: the commit must land on the peeled moe/work-* branch' }
                $scopeScenariosRun++
                Write-Host '[scenario U] ok'

                # Scenario V — status lookup failure: the task id is certain, so
                # the work lands as a status=UNKNOWN checkpoint, and the loud
                # PUSH-BLOCKED lookup escalation is kept.
                Write-Host '[scenario V] a status lookup failure lands a status=UNKNOWN checkpoint'
                $scopeVDir = Join-Path $tempRoot 'scope-v'
                New-ScopeProject $scopeVDir @('owned-a.txt')
                Set-Content -Path (Join-Path $scopeVDir 'owned-a.txt') -Value 'owned-a'
                $scopeVOut = Join-Path $tempRoot 'scope-v.out'
                $env:FAKE_GET_CONTEXT_FAIL = 'empty'
                try {
                    Assert-ScopeRun 'V' (Invoke-GateWrapper $scopeVDir $scopeVOut) $scopeVOut
                } finally { Remove-Item Env:FAKE_GET_CONTEXT_FAIL -ErrorAction SilentlyContinue }
                if ((Get-HeadSubject $scopeVDir) -ne 'wip(task-postflight): Postflight smoke [status=UNKNOWN role=worker cli-exit=0]') {
                    Get-Content $scopeVOut | ForEach-Object { Write-Host $_ }
                    throw "SCENARIO V FAILED: unexpected subject [$(Get-HeadSubject $scopeVDir)]"
                }
                if ((Get-Content -Raw -Path (Join-Path $scopeVDir '.moe\messages\chan-general.jsonl')) -notlike '*PUSH-BLOCKED: post-flight status lookup failed for task task-postflight*') {
                    throw 'SCENARIO V FAILED: the lookup-failure chat escalation must be kept'
                }
                $scopeScenariosRun++
                Write-Host '[scenario V] ok'

                # Scenario X — commitHooks=true routes completions through
                # porcelain `git commit`; a rejecting pre-commit hook yields a
                # rescue ref [reason=commit-failed] and HEAD stays put.
                Write-Host '[scenario X] commitHooks=true + rejecting pre-commit hook yields a rescue ref'
                $scopeXDir = Join-Path $tempRoot 'scope-x'
                New-ScopeProject $scopeXDir @('owned-a.txt') -Settings @{ commitHooks = $true }
                $scopeXHook = Join-Path $scopeXDir '.git\hooks\pre-commit'
                [System.IO.File]::WriteAllText($scopeXHook, "#!/bin/sh`nexit 1`n", (New-Object System.Text.UTF8Encoding($false)))
                Set-Content -Path (Join-Path $scopeXDir 'owned-a.txt') -Value 'owned-a'
                $scopeXHead = (& git -C $scopeXDir rev-parse HEAD 2>$null)
                $scopeXOut = Join-Path $tempRoot 'scope-x.out'
                Assert-ScopeRun 'X' (Invoke-GateWrapper $scopeXDir $scopeXOut) $scopeXOut
                $scopeXText = Get-Content -Raw -Path $scopeXOut
                if ((& git -C $scopeXDir rev-parse HEAD 2>$null) -ne $scopeXHead) { Write-Host $scopeXText; throw 'SCENARIO X FAILED: HEAD must not move when the hook rejects' }
                $scopeXRefs = @(Get-RescueRefs $scopeXDir)
                if ($scopeXRefs.Count -ne 1) { Write-Host $scopeXText; throw "SCENARIO X FAILED: expected exactly one rescue ref; got [$($scopeXRefs -join ',')]" }
                if ((Get-HeadSubject $scopeXDir $scopeXRefs[0]) -notmatch '\[reason=commit-failed\]$') { throw "SCENARIO X FAILED: unexpected rescue subject [$(Get-HeadSubject $scopeXDir $scopeXRefs[0])]" }
                if ((Get-CommittedPaths $scopeXDir $scopeXRefs[0]) -ne 'owned-a.txt') { throw "SCENARIO X FAILED: the rescue ref must hold owned-a.txt; got [$(Get-CommittedPaths $scopeXDir $scopeXRefs[0])]" }
                $scopeScenariosRun++
                Write-Host '[scenario X] ok'

                # Scenario Y — grok CLI. A fake grok.cmd takes the grok launch
                # branch (-GrokExec = headless). Run 1: .grok/config.toml is
                # written (moe + serena, since MOE_SERENA_PATH resolves) with
                # the LITERAL ${MOE_WORKER_ID:-} template and no top-level
                # keys; argv carries --prompt-file/--yolo/--cwd; the prompt
                # file holds role doc + session context + directive under
                # $env:TEMP (removed on exit); the fake's exit 3 propagates
                # into the post-flight (chat line + checkpoint subject); the
                # config never lands. Run 2: byte-identical config, explicit
                # MOE_GROK_MODEL/MOE_GROK_EFFORT reach argv. Run 3: Serena
                # "uninstalled" strips its block while a user [permission]
                # table survives, and a config dirtied MID-SESSION (changed
                # since the baseline, so only the DENY tier keeps it out)
                # still never lands.
                Write-Host '[scenario Y] grok: config.toml written idempotently, headless argv, exit propagated, config never landed'
                $scopeYDir = Join-Path $tempRoot 'scope-y'
                New-ScopeProject $scopeYDir @('owned-a.txt') -Status 'WORKING'
                Set-Content -Path (Join-Path $scopeYDir 'owned-a.txt') -Value 'owned-a'
                $scopeYConfig = Join-Path $scopeYDir '.grok\config.toml'
                $scopeYArgv = Join-Path $tempRoot 'scope-y-argv.txt'
                $scopeYPrompt = Join-Path $tempRoot 'scope-y-prompt.md'
                function Invoke-GrokWrapper([string]$outFile) {
                    Remove-Item -LiteralPath $scopeYArgv -Force -ErrorAction SilentlyContinue
                    return (Invoke-WrapperProcess @('-Project', $scopeYDir, '-WorkerId', 'worker-grok', '-Role', 'worker', '-Team', 'Smoke', '-NoStartDaemon', '-Command', $grokCmd, '-GrokExec', '-NoLoop', '-PollInterval', '0') $outFile)
                }
                $scopeYPrevSerena = $env:MOE_SERENA_PATH
                $scopeYPrevKey = $env:XAI_API_KEY
                # Operator env that would change run 1's argv/TOML (documented
                # MOE_GROK_* knobs, WSL MOE_DAEMON_HOST): snapshot, clear, restore.
                $scopeYPrevOperatorEnv = @{}
                # GROK_HOME too: the wrapper writes grok's trust store under it,
                # and the harness must never touch the operator's real store.
                foreach ($name in @('MOE_GROK_MODEL', 'MOE_GROK_EFFORT', 'MOE_GROK_MCP_STARTUP_TIMEOUT_SEC', 'MOE_GROK_MCP_TOOL_TIMEOUT_SEC', 'MOE_DAEMON_HOST', 'GROK_HOME')) {
                    $scopeYPrevOperatorEnv[$name] = [Environment]::GetEnvironmentVariable($name)
                    Remove-Item "Env:$name" -ErrorAction SilentlyContinue
                }
                $env:FAKE_TASK_STATUS = 'WORKING'
                $env:FAKE_GROK_ARGV_FILE = $scopeYArgv
                $env:FAKE_GROK_PROMPT_COPY = $scopeYPrompt
                # Any existing file passes the writer's Test-Path; the shim is
                # never executed as Serena. USERPROFILE is the empty $homeDir,
                # so ~/.grok/auth.json is absent and the auth WARN must fire.
                $env:MOE_SERENA_PATH = $trueCmd
                Remove-Item Env:XAI_API_KEY -ErrorAction SilentlyContinue
                try {
                    # Run 1: fresh config, fake exit 3.
                    $env:FAKE_GROK_EXIT = '3'
                    $scopeYOut = Join-Path $tempRoot 'scope-y.out'
                    try {
                        Assert-ScopeRun 'Y' (Invoke-GrokWrapper $scopeYOut) $scopeYOut
                    } finally { Remove-Item Env:FAKE_GROK_EXIT -ErrorAction SilentlyContinue }
                    $scopeYText = Get-Content -Raw -Path $scopeYOut
                    if (-not (Test-Path -LiteralPath $scopeYConfig)) { Write-Host $scopeYText; throw 'SCENARIO Y FAILED: .grok/config.toml was not written' }
                    $scopeYToml = [System.IO.File]::ReadAllText($scopeYConfig)
                    $scopeYBytes1 = [System.IO.File]::ReadAllBytes($scopeYConfig)
                    if ($scopeYBytes1.Length -ge 3 -and $scopeYBytes1[0] -eq 0xEF -and $scopeYBytes1[1] -eq 0xBB -and $scopeYBytes1[2] -eq 0xBF) { throw 'SCENARIO Y FAILED: .grok/config.toml must be written without a BOM' }
                    foreach ($needle in @('[mcp_servers.moe]', '[mcp_servers.moe.env]', 'MOE_WORKER_ID = "${MOE_WORKER_ID:-}"', 'MOE_RUNNER_PROCESS_STARTED_AT = "${MOE_RUNNER_PROCESS_STARTED_AT:-}"', 'MOE_RUNNER_HOST = "${MOE_RUNNER_HOST:-}"', 'MOE_TOOL_NAME_STYLE = "underscore"', 'startup_timeout_sec = 120', 'tool_timeout_sec = 120', 'moe_wait_for_task = 720', '[mcp_servers.serena]', '"--context", "agent"')) {
                        if (-not $scopeYToml.Contains($needle)) { Write-Host $scopeYToml; throw "SCENARIO Y FAILED: .grok/config.toml must contain [$needle]" }
                    }
                    if ($scopeYToml -match '(?m)^(model_reasoning_effort|developer_instructions|model_instructions_file|project_doc_fallback_filenames)\s*=') { Write-Host $scopeYToml; throw 'SCENARIO Y FAILED: a grok project config must carry NO top-level keys' }
                    if ($scopeYToml.Contains('\')) { Write-Host $scopeYToml; throw 'SCENARIO Y FAILED: paths in .grok/config.toml must be forward-slashed' }
                    foreach ($banner in @('Grok MCP config written to:', 'Grok folder trust granted:', 'Grok mode: headless (--prompt-file --yolo)', '[WARN] XAI_API_KEY is not set and ~/.grok/auth.json is missing - grok will fail to authenticate.', 'Command: ')) {
                        if (-not $scopeYText.Contains($banner)) { Write-Host $scopeYText; throw "SCENARIO Y FAILED: expected [$banner] in the wrapper output" }
                    }
                    # -- folder trust (USERPROFILE is the harness home, so this is the harness store) --
                    $scopeYTrust = Join-Path $homeDir '.grok\trusted_folders.toml'
                    if (-not (Test-Path -LiteralPath $scopeYTrust)) { Write-Host $scopeYText; throw "SCENARIO Y FAILED: expected grok trust store $scopeYTrust to be written at pre-flight" }
                    $scopeYTrustText = [System.IO.File]::ReadAllText($scopeYTrust)
                    $scopeYTrustTables = ([regex]::Matches($scopeYTrustText, "(?m)^\[folders\.'")).Count
                    if ($scopeYTrustTables -ne 1 -or -not $scopeYTrustText.Contains('trusted = true')) { Write-Host $scopeYTrustText; throw "SCENARIO Y FAILED: expected exactly one trusted [folders.'…'] table in $scopeYTrust" }
                    if (-not (Test-Path -LiteralPath $scopeYArgv)) { Write-Host $scopeYText; throw 'SCENARIO Y FAILED: the fake grok was never launched (no argv file)' }
                    $scopeYArgvText = Get-Content -Raw -Path $scopeYArgv
                    foreach ($flag in @('--prompt-file', '--yolo', '--cwd', '--no-auto-update', '--output-format plain')) {
                        if (-not $scopeYArgvText.Contains($flag)) { Write-Host $scopeYArgvText; throw "SCENARIO Y FAILED: grok argv must carry $flag" }
                    }
                    if ($scopeYArgvText -match '(^|\s)-m(\s|$)' -or $scopeYArgvText.Contains('--effort') -or $scopeYArgvText.Contains('claude-opus')) { Write-Host $scopeYArgvText; throw 'SCENARIO Y FAILED: without an explicit model/effort there must be no -m / --effort on argv (and never the claude fallback model)' }
                    if ($scopeYArgvText.Contains('--prompt ') -or $scopeYArgvText.Contains('--print')) { Write-Host $scopeYArgvText; throw 'SCENARIO Y FAILED: grok has no --prompt / --print flag' }
                    if ($scopeYArgvText.IndexOf($tempRoot, [System.StringComparison]::OrdinalIgnoreCase) -lt 0) { Write-Host $scopeYArgvText; throw 'SCENARIO Y FAILED: the prompt file must live under $env:TEMP, never in the project' }
                    $scopeYCwd = (Get-Content -Raw -Path "$scopeYArgv.cwd").Trim()
                    if ((Get-Item -LiteralPath $scopeYCwd).FullName.TrimEnd('\') -ne (Get-Item -LiteralPath $scopeYDir).FullName.TrimEnd('\')) { throw "SCENARIO Y FAILED: grok must run with cwd = project; got [$scopeYCwd]" }
                    if (-not (Test-Path -LiteralPath $scopeYPrompt)) { Write-Host $scopeYText; throw 'SCENARIO Y FAILED: the --prompt-file path was not readable by the fake grok' }
                    $scopeYPromptText = Get-Content -Raw -Path $scopeYPrompt
                    foreach ($needle in @('Role: worker', '# Session Context (per-iteration)', '<claimed_task_context>', 'Task task-postflight is claimed')) {
                        if (-not $scopeYPromptText.Contains($needle)) { Write-Host $scopeYPromptText; throw "SCENARIO Y FAILED: the grok prompt file must contain [$needle]" }
                    }
                    if (@(Get-ChildItem -Path $tempRoot -Filter 'moe-grok-prompt-*.md' -File -ErrorAction SilentlyContinue).Count -ne 0) { throw 'SCENARIO Y FAILED: the wrapper must remove its grok prompt file on exit' }
                    if (Test-Path -LiteralPath (Join-Path $scopeYDir 'AGENTS.md')) { throw 'SCENARIO Y FAILED: the wrapper must not write AGENTS.md into the project' }
                    $scopeYChat = Get-Content -Raw -Path (Join-Path $scopeYDir '.moe\messages\chan-general.jsonl')
                    if ($scopeYChat -notlike '*worker session ended: task=task-postflight (CLI exit=3)*') { Write-Host $scopeYChat; throw 'SCENARIO Y FAILED: the fake grok exit 3 must propagate into the session-ended line' }
                    if ((Get-HeadSubject $scopeYDir) -ne 'wip(task-postflight): Postflight smoke [status=WORKING role=worker cli-exit=3]') { Write-Host $scopeYText; throw "SCENARIO Y FAILED: unexpected checkpoint subject [$(Get-HeadSubject $scopeYDir)]" }
                    if ((Get-CommittedPaths $scopeYDir) -ne 'owned-a.txt') { Write-Host $scopeYText; throw "SCENARIO Y FAILED: only owned-a.txt may land; got [$(Get-CommittedPaths $scopeYDir)]" }
                    $scopeYHash1 = (Get-Sha256Hex $scopeYConfig)

                    # Run 2: byte-identical re-write; an explicit model + effort
                    # reach argv; nothing new to land.
                    $env:MOE_GROK_MODEL = 'grok-4-fast'
                    $env:MOE_GROK_EFFORT = 'high'
                    $scopeYOut2 = Join-Path $tempRoot 'scope-y-2.out'
                    try {
                        Assert-ScopeRun 'Y' (Invoke-GrokWrapper $scopeYOut2) $scopeYOut2
                    } finally {
                        Remove-Item Env:MOE_GROK_MODEL -ErrorAction SilentlyContinue
                        Remove-Item Env:MOE_GROK_EFFORT -ErrorAction SilentlyContinue
                    }
                    $scopeYHash2 = (Get-Sha256Hex $scopeYConfig)
                    if ($scopeYHash1 -ne $scopeYHash2) { Write-Host ([System.IO.File]::ReadAllText($scopeYConfig)); throw 'SCENARIO Y FAILED: a second run must leave .grok/config.toml byte-identical' }
                    $scopeYArgvText2 = Get-Content -Raw -Path $scopeYArgv
                    if (-not $scopeYArgvText2.Contains('-m grok-4-fast') -or -not $scopeYArgvText2.Contains('--effort high')) { Write-Host $scopeYArgvText2; throw 'SCENARIO Y FAILED: MOE_GROK_MODEL / MOE_GROK_EFFORT must reach argv as -m / --effort' }
                    if ([int](& git -C $scopeYDir rev-list --count HEAD 2>$null) -ne 2) { Get-Content $scopeYOut2 | ForEach-Object { Write-Host $_ }; throw 'SCENARIO Y FAILED: an unchanged tree must not land a second commit' }

                    # Run 3: Serena "uninstalled" (MOE_SERENA_PATH points at
                    # nothing) strips its block, a user [permission] table
                    # survives, and the config dirtied mid-session never lands.
                    $env:MOE_SERENA_PATH = Join-Path $tempRoot 'no-such-serena.exe'
                    [System.IO.File]::AppendAllText($scopeYConfig, "`n[permission]`nmode = `"auto`"`n", (New-Object System.Text.UTF8Encoding($false)))
                    Set-Content -Path (Join-Path $scopeYDir 'owned-a.txt') -Value 'owned-a-again'
                    $env:FAKE_GROK_TOUCH_CONFIG = '1'
                    $scopeYOut3 = Join-Path $tempRoot 'scope-y-3.out'
                    try {
                        Assert-ScopeRun 'Y' (Invoke-GrokWrapper $scopeYOut3) $scopeYOut3
                    } finally { Remove-Item Env:FAKE_GROK_TOUCH_CONFIG -ErrorAction SilentlyContinue }
                    $scopeYToml3 = [System.IO.File]::ReadAllText($scopeYConfig)
                    if ($scopeYToml3.Contains('[mcp_servers.serena]')) { Write-Host $scopeYToml3; throw 'SCENARIO Y FAILED: a stale serena block must be stripped when Serena is not installed' }
                    if (-not $scopeYToml3.Contains('[permission]') -or -not $scopeYToml3.Contains('mode = "auto"')) { Write-Host $scopeYToml3; throw 'SCENARIO Y FAILED: a user [permission] table must survive the merge' }
                    if (([regex]::Matches($scopeYToml3, '\[mcp_servers\.moe\]')).Count -ne 1) { Write-Host $scopeYToml3; throw 'SCENARIO Y FAILED: exactly one [mcp_servers.moe] block must remain after the merge' }
                    if (-not $scopeYToml3.Contains('# touched by the session')) { Write-Host $scopeYToml3; throw 'SCENARIO Y FAILED: the shim did not dirty the config, so the DENY discriminator is inert' }
                    if ((Get-HeadSubject $scopeYDir) -ne 'wip(task-postflight): Postflight smoke [status=WORKING role=worker cli-exit=0]') { Get-Content $scopeYOut3 | ForEach-Object { Write-Host $_ }; throw "SCENARIO Y FAILED: unexpected run-3 subject [$(Get-HeadSubject $scopeYDir)]" }
                    if ((Get-CommittedPaths $scopeYDir) -ne 'owned-a.txt') { Get-Content $scopeYOut3 | ForEach-Object { Write-Host $_ }; throw "SCENARIO Y FAILED: a mid-session-dirtied .grok/config.toml must never land; got [$(Get-CommittedPaths $scopeYDir)]" }
                    & git -C $scopeYDir cat-file -e HEAD:.grok/config.toml 2>$null | Out-Null
                    if ($LASTEXITCODE -eq 0) { throw 'SCENARIO Y FAILED: .grok/config.toml reached HEAD' }
                    if (@(& git -C $scopeYDir status --porcelain --untracked-files=all 2>$null) -notcontains '?? .grok/config.toml') { throw 'SCENARIO Y FAILED: .grok/config.toml must still be untracked' }
                    if ((Get-Content -Raw -Path $scopeYOut3) -notlike '*MOE_ATTR_EXCLUDED*') { Get-Content $scopeYOut3 | ForEach-Object { Write-Host $_ }; throw 'SCENARIO Y FAILED: the dirtied config must be reported under MOE_ATTR_EXCLUDED' }
                } finally {
                    Remove-Item Env:FAKE_GROK_ARGV_FILE -ErrorAction SilentlyContinue
                    Remove-Item Env:FAKE_GROK_PROMPT_COPY -ErrorAction SilentlyContinue
                    Remove-Item Env:FAKE_GROK_EXIT -ErrorAction SilentlyContinue
                    Remove-Item Env:FAKE_GROK_TOUCH_CONFIG -ErrorAction SilentlyContinue
                    if ($null -ne $scopeYPrevSerena) { $env:MOE_SERENA_PATH = $scopeYPrevSerena } else { Remove-Item Env:MOE_SERENA_PATH -ErrorAction SilentlyContinue }
                    if ($null -ne $scopeYPrevKey) { $env:XAI_API_KEY = $scopeYPrevKey }
                    foreach ($name in $scopeYPrevOperatorEnv.Keys) {
                        if ($null -ne $scopeYPrevOperatorEnv[$name]) { [Environment]::SetEnvironmentVariable($name, $scopeYPrevOperatorEnv[$name]) } else { Remove-Item "Env:$name" -ErrorAction SilentlyContinue }
                    }
                    $env:FAKE_TASK_STATUS = 'REVIEW'
                }
                $scopeScenariosRun++
                Write-Host '[scenario Y] ok'

                # Scenario Z — codex CLI headless launch. A fake codex.ps1
                # records its argv. codex-cli 0.147+ rejects `--full-auto`
                # (`error: unexpected argument '--full-auto' found`, exit 2
                # before any work — which the launch-failure backoff then
                # relaunches forever); `codex exec` already runs with
                # approval_policy = never, so the wrapper passes only
                # `--sandbox <MOE_CODEX_SANDBOX|danger-full-access>`. Pins:
                # -CodexExec launches headless `exec -C <project>` with the
                # per-seat -c overrides and never --full-auto; an architect
                # without the switch gets the TUI, a worker defaults to exec
                # (b7f9570) unless -Interactive; --sandbox
                # follows `exec`; MOE_CODEX_SANDBOX reaches argv verbatim;
                # `inherit` drops the flag; an unknown value warns and falls
                # back; a fast non-zero exit propagates and prints the argv
                # hint; .codex/config.toml never lands (DENY tier); an
                # architect gets the TUI (no exec) unless -CodexExec.
                Write-Host '[scenario Z] codex: headless exec argv without --full-auto, MOE_CODEX_SANDBOX, exit propagated, config never landed, polarity'
                $scopeZDir = Join-Path $tempRoot 'scope-z'
                New-ScopeProject $scopeZDir @('owned-a.txt') -Status 'WORKING'
                Set-Content -Path (Join-Path $scopeZDir 'owned-a.txt') -Value 'owned-a'
                $scopeZConfig = Join-Path $scopeZDir '.codex\config.toml'
                $scopeZArgv = Join-Path $tempRoot 'scope-z-argv.txt'
                function Invoke-CodexWrapper([string]$outFile, [string]$role = 'worker', [string[]]$extra = @()) {
                    Remove-Item -LiteralPath $scopeZArgv -Force -ErrorAction SilentlyContinue
                    return (Invoke-WrapperProcess (@('-Project', $scopeZDir, '-WorkerId', "$role-scope-z", '-Role', $role, '-Team', 'Smoke', '-NoStartDaemon', '-Command', $codexCmd, '-NoLoop', '-PollInterval', '0') + $extra) $outFile)
                }
                function Get-CodexArgv() {
                    if (-not (Test-Path -LiteralPath $scopeZArgv)) { throw 'SCENARIO Z FAILED: the fake codex was never launched (no argv file)' }
                    return @(Get-Content -Path $scopeZArgv)
                }
                $scopeZPrevSerena = $env:MOE_SERENA_PATH
                $scopeZPrevOperatorEnv = @{}
                foreach ($name in @('MOE_CODEX_SANDBOX', 'MOE_CODEX_REASONING_EFFORT', 'MOE_CODEX_MCP_STARTUP_TIMEOUT_SEC', 'MOE_DAEMON_HOST')) {
                    $scopeZPrevOperatorEnv[$name] = [Environment]::GetEnvironmentVariable($name)
                    Remove-Item "Env:$name" -ErrorAction SilentlyContinue
                }
                $env:FAKE_TASK_STATUS = 'WORKING'
                $env:FAKE_CODEX_ARGV_FILE = $scopeZArgv
                $env:MOE_SERENA_PATH = $trueCmd
                try {
                    # Run 1: -CodexExec = headless exec, fake exit 5.
                    $env:FAKE_CODEX_EXIT = '5'
                    $scopeZOut = Join-Path $tempRoot 'scope-z.out'
                    try {
                        Assert-ScopeRun 'Z' (Invoke-CodexWrapper $scopeZOut 'worker' @('-CodexExec')) $scopeZOut
                    } finally { Remove-Item Env:FAKE_CODEX_EXIT -ErrorAction SilentlyContinue }
                    $scopeZText = Get-Content -Raw -Path $scopeZOut
                    $scopeZArgs = Get-CodexArgv
                    if ($scopeZArgs -contains '--full-auto') { Write-Host ($scopeZArgs -join ' '); throw 'SCENARIO Z FAILED: codex 0.147+ rejects --full-auto; it must never be on argv' }
                    # -cnotcontains: the default -contains is case-insensitive, so `-C` would be
                    # satisfied by the `-c` seat overrides that precede every codex launch.
                    # The workerId rides a complete moe server table: codex 0.163's TUI rejects a
                    # partial dotted `mcp_servers.moe.env.MOE_WORKER_ID=` override at bootstrap.
                    $scopeZMoe = @($scopeZArgs | Where-Object { $_ -clike "mcp_servers.moe={command=*MOE_WORKER_ID='worker-scope-z'}}" })
                    if ($scopeZMoe.Count -lt 1 -or @($scopeZArgs | Where-Object { $_ -like 'mcp_servers.moe.env.MOE_WORKER_ID=*' }).Count -gt 0) { Write-Host ($scopeZArgs -join ' '); throw 'SCENARIO Z FAILED: headless codex argv must carry the workerId inside a complete mcp_servers.moe={command=...} override' }
                    foreach ($flag in @('exec', '--json', '-C', '--sandbox', 'danger-full-access', '-c', 'approvals_reviewer=user')) {
                        if ($scopeZArgs -cnotcontains $flag) { Write-Host ($scopeZArgs -join ' '); throw "SCENARIO Z FAILED: headless codex argv must carry [$flag]" }
                    }
                    if ([array]::IndexOf($scopeZArgs, '--sandbox') -le [array]::IndexOf($scopeZArgs, 'exec')) { Write-Host ($scopeZArgs -join ' '); throw 'SCENARIO Z FAILED: --sandbox must follow the exec subcommand' }
                    $scopeZSeatFile = @($scopeZArgs | Where-Object { $_ -like 'model_instructions_file=*' })
                    # The fake appends argv per invocation (probe, then launch), so the override
                    # appears once per invocation; every occurrence must point under $env:TEMP.
                    $scopeZSeatBad = @($scopeZSeatFile | Where-Object { $_.IndexOf($tempRoot.Replace('\', '/'), [System.StringComparison]::OrdinalIgnoreCase) -lt 0 })
                    if ($scopeZSeatFile.Count -lt 1 -or $scopeZSeatBad.Count -gt 0) { Write-Host ($scopeZArgs -join ' '); throw 'SCENARIO Z FAILED: the per-seat model_instructions_file override must point under $env:TEMP with forward slashes' }
                    if (-not $scopeZText.Contains('--sandbox danger-full-access') -or -not $scopeZText.Contains("-c mcp_servers.moe={command=") -or -not $scopeZText.Contains("MOE_WORKER_ID='worker-scope-z'}}") -or -not $scopeZText.Contains('-c approvals_reviewer=user exec --json -C')) { Write-Host $scopeZText; throw 'SCENARIO Z FAILED: the Command banner must show the seat override, JSON mode, the reviewer pin and --sandbox danger-full-access' }
                    if (-not $scopeZText.Contains('run the printed Command by hand')) { Write-Host $scopeZText; throw 'SCENARIO Z FAILED: a fast non-zero exit must print the launch-failure argv hint' }
                    if (-not (Test-Path -LiteralPath $scopeZConfig)) { Write-Host $scopeZText; throw 'SCENARIO Z FAILED: .codex/config.toml was not written' }
                    $scopeZToml = [System.IO.File]::ReadAllText($scopeZConfig)
                    foreach ($needle in @('[mcp_servers.moe]', '[mcp_servers.moe.env]', 'startup_timeout_sec = 120', 'tool_timeout_sec = 720', 'model_instructions_file = "agent-instructions.md"', 'model_reasoning_effort = "xhigh"', 'default_tools_approval_mode = "approve"')) {
                        if (-not $scopeZToml.Contains($needle)) { Write-Host $scopeZToml; throw "SCENARIO Z FAILED: .codex/config.toml must contain [$needle]" }
                    }
                    # codex 0.148+ rejects un-annotated MCP tools under approval never + a sandbox;
                    # the pre-approval must be pinned on BOTH servers (moe and serena).
                    if (([regex]::Matches($scopeZToml, [regex]::Escape('default_tools_approval_mode = "approve"'))).Count -ne 2) { Write-Host $scopeZToml; throw 'SCENARIO Z FAILED: default_tools_approval_mode = "approve" must be pinned on both the moe and serena servers in .codex/config.toml' }
                    if (-not (Test-Path -LiteralPath (Join-Path $scopeZDir '.codex\agent-instructions.md'))) { throw 'SCENARIO Z FAILED: .codex/agent-instructions.md was not written' }
                    $scopeZChat = Get-Content -Raw -Path (Join-Path $scopeZDir '.moe\messages\chan-general.jsonl')
                    if ($scopeZChat -notlike '*worker session ended: task=task-postflight (CLI exit=5)*') { Write-Host $scopeZChat; throw 'SCENARIO Z FAILED: the fake codex exit 5 must propagate into the session-ended line' }
                    if ((Get-HeadSubject $scopeZDir) -ne 'wip(task-postflight): Postflight smoke [status=WORKING role=worker cli-exit=5]') { Write-Host $scopeZText; throw "SCENARIO Z FAILED: unexpected checkpoint subject [$(Get-HeadSubject $scopeZDir)]" }
                    & git -C $scopeZDir cat-file -e HEAD:.codex/config.toml 2>$null | Out-Null
                    if ($LASTEXITCODE -eq 0) { throw 'SCENARIO Z FAILED: .codex/config.toml reached HEAD' }

                    # Run 2: MOE_CODEX_SANDBOX reaches argv verbatim.
                    $env:MOE_CODEX_SANDBOX = 'workspace-write'
                    $scopeZOut2 = Join-Path $tempRoot 'scope-z-2.out'
                    try {
                        Assert-ScopeRun 'Z' (Invoke-CodexWrapper $scopeZOut2 'worker' @('-CodexExec')) $scopeZOut2
                    } finally { Remove-Item Env:MOE_CODEX_SANDBOX -ErrorAction SilentlyContinue }
                    $scopeZArgs2 = Get-CodexArgv
                    if ($scopeZArgs2 -notcontains 'workspace-write' -or $scopeZArgs2 -contains 'danger-full-access') { Write-Host ($scopeZArgs2 -join ' '); throw 'SCENARIO Z FAILED: MOE_CODEX_SANDBOX=workspace-write must reach argv as --sandbox workspace-write' }

                    # Run 3: inherit drops the flag.
                    $env:MOE_CODEX_SANDBOX = 'inherit'
                    $scopeZOut3 = Join-Path $tempRoot 'scope-z-3.out'
                    try {
                        Assert-ScopeRun 'Z' (Invoke-CodexWrapper $scopeZOut3 'worker' @('-CodexExec')) $scopeZOut3
                    } finally { Remove-Item Env:MOE_CODEX_SANDBOX -ErrorAction SilentlyContinue }
                    $scopeZArgs3 = Get-CodexArgv
                    if ($scopeZArgs3 -contains '--sandbox' -or $scopeZArgs3 -contains '--full-auto' -or $scopeZArgs3 -notcontains 'exec') { Write-Host ($scopeZArgs3 -join ' '); throw 'SCENARIO Z FAILED: MOE_CODEX_SANDBOX=inherit must launch exec with no --sandbox flag' }

                    # Run 4: an unknown value warns and falls back.
                    $env:MOE_CODEX_SANDBOX = 'yolo'
                    $scopeZOut4 = Join-Path $tempRoot 'scope-z-4.out'
                    try {
                        Assert-ScopeRun 'Z' (Invoke-CodexWrapper $scopeZOut4 'worker' @('-CodexExec')) $scopeZOut4
                    } finally { Remove-Item Env:MOE_CODEX_SANDBOX -ErrorAction SilentlyContinue }
                    $scopeZText4 = Get-Content -Raw -Path $scopeZOut4
                    if (-not $scopeZText4.Contains("MOE_CODEX_SANDBOX='yolo' is not one of read-only | workspace-write | danger-full-access | inherit; using danger-full-access.")) { Write-Host $scopeZText4; throw 'SCENARIO Z FAILED: an unknown MOE_CODEX_SANDBOX must warn and fall back' }
                    if ((Get-CodexArgv) -notcontains 'danger-full-access') { throw 'SCENARIO Z FAILED: the fallback sandbox must be danger-full-access' }

                    # Run 5: an architect defaults to the TUI (no exec / --sandbox).
                    $scopeZOut5 = Join-Path $tempRoot 'scope-z-5.out'
                    Assert-ScopeRun 'Z' (Invoke-CodexWrapper $scopeZOut5 'architect') $scopeZOut5
                    $scopeZArgs5 = Get-CodexArgv
                    if ($scopeZArgs5 -contains 'exec' -or $scopeZArgs5 -contains '--sandbox' -or $scopeZArgs5 -contains 'approvals_reviewer=user') { Write-Host ($scopeZArgs5 -join ' '); throw 'SCENARIO Z FAILED: an architect must default to the interactive codex TUI (no exec / --sandbox / reviewer pin)' }
                    if ($scopeZArgs5 -cnotcontains '-C') { Write-Host ($scopeZArgs5 -join ' '); throw 'SCENARIO Z FAILED: the codex TUI launch must still carry -C <project>' }
                    # A non-worker seat's override also carries the wrapper's runner
                    # identity (codex hands the proxy only the env its table names),
                    # so the proxy can stamp it onto the architect's in-session claims.
                    $scopeZIdentity = if ((Get-Content -Raw -Path $scopeZOut5) -cmatch '(?m)^Runner identity: processStartedAt=(\S+) host=(\S+)\r?$') { "MOE_WORKER_ID='architect-scope-z',MOE_RUNNER_PROCESS_STARTED_AT='$($Matches[1])',MOE_RUNNER_HOST='$($Matches[2])'}}" } else { '' }
                    if (-not $scopeZIdentity -or -not @($scopeZArgs5 | Where-Object { $_.EndsWith($scopeZIdentity, [StringComparison]::Ordinal) })) { Write-Host ($scopeZArgs5 -join ' '); throw "SCENARIO Z FAILED: an architect's codex override must carry the runner identity after its workerId" }

                    # Run 5b: a worker without -CodexExec defaults to headless exec
                    # (b7f9570, 2026-09-24: the codex TUI never exits on its own, so
                    # an interactive worker landed one row and then idled). Run 5c:
                    # -Interactive forces the TUI back. 5b still asserted the
                    # 2026-09-07 TUI default, which kept CI red from b7f9570 on.
                    $scopeZOut5b = Join-Path $tempRoot 'scope-z-5b.out'
                    Assert-ScopeRun 'Z' (Invoke-CodexWrapper $scopeZOut5b 'worker') $scopeZOut5b
                    $scopeZArgs5b = Get-CodexArgv
                    if ($scopeZArgs5b -notcontains 'exec') { Write-Host ($scopeZArgs5b -join ' '); throw 'SCENARIO Z FAILED: a worker without -CodexExec must default to headless codex exec (b7f9570)' }
                    $scopeZOut5c = Join-Path $tempRoot 'scope-z-5c.out'
                    Assert-ScopeRun 'Z' (Invoke-CodexWrapper $scopeZOut5c 'worker' @('-Interactive')) $scopeZOut5c
                    $scopeZArgs5c = Get-CodexArgv
                    if ($scopeZArgs5c -contains 'exec' -or $scopeZArgs5c -contains '--sandbox' -or $scopeZArgs5c -contains 'approvals_reviewer=user') { Write-Host ($scopeZArgs5c -join ' '); throw 'SCENARIO Z FAILED: a worker with -Interactive must get the interactive codex TUI (no exec / --sandbox / reviewer pin)' }

                    # Run 6: argv probe. A CLI that rejects the launch argv (the
                    # --full-auto class of break) must stop the seat with
                    # MOE_CLI_ARGV_REJECTED + a #general escalation and never
                    # launch the prompt, instead of relaunch-looping.
                    $env:FAKE_CODEX_REJECT_ARGV = '1'
                    $scopeZOut6 = Join-Path $tempRoot 'scope-z-6.out'
                    try {
                        $scopeZCode6 = Invoke-CodexWrapper $scopeZOut6 'worker' @('-CodexExec')
                    } finally { Remove-Item Env:FAKE_CODEX_REJECT_ARGV -ErrorAction SilentlyContinue }
                    $scopeZText6 = Get-Content -Raw -Path $scopeZOut6
                    if ($scopeZCode6 -eq 0) { Write-Host $scopeZText6; throw 'SCENARIO Z FAILED: a rejected argv must make the wrapper exit non-zero' }
                    if (-not $scopeZText6.Contains('MOE_CLI_ARGV_REJECTED') -or -not $scopeZText6.Contains("unexpected argument '--sandbox' found")) { Write-Host $scopeZText6; throw "SCENARIO Z FAILED: expected MOE_CLI_ARGV_REJECTED with the CLI's own error line" }
                    if ($scopeZText6.Contains('[launch-failure]')) { Write-Host $scopeZText6; throw 'SCENARIO Z FAILED: a rejected argv must not reach the launch-failure backoff' }
                    $scopeZArgs6 = Get-CodexArgv
                    if ($scopeZArgs6 -cnotcontains '--help' -or ($scopeZArgs6 | Where-Object { $_ -like '*Task task-postflight is claimed*' })) { Write-Host ($scopeZArgs6 -join ' '); throw 'SCENARIO Z FAILED: the probe must run the real argv plus --help and the prompt must never be launched' }
                    if ((Get-Content -Raw -Path (Join-Path $scopeZDir '.moe\messages\chan-general.jsonl')) -notlike '*MOE_CLI_ARGV_REJECTED*') { throw 'SCENARIO Z FAILED: a rejected argv must be escalated to #general' }

                    # Run 7: MOE_DISABLE_ARGV_PROBE=1 skips the probe; the rejection
                    # then surfaces through the ordinary launch-failure path.
                    $env:FAKE_CODEX_REJECT_ARGV = '1'
                    $env:MOE_DISABLE_ARGV_PROBE = '1'
                    $scopeZOut7 = Join-Path $tempRoot 'scope-z-7.out'
                    try {
                        Assert-ScopeRun 'Z' (Invoke-CodexWrapper $scopeZOut7 'worker' @('-CodexExec')) $scopeZOut7
                    } finally {
                        Remove-Item Env:FAKE_CODEX_REJECT_ARGV -ErrorAction SilentlyContinue
                        Remove-Item Env:MOE_DISABLE_ARGV_PROBE -ErrorAction SilentlyContinue
                    }
                    $scopeZText7 = Get-Content -Raw -Path $scopeZOut7
                    if ($scopeZText7.Contains('MOE_CLI_ARGV_REJECTED') -or -not $scopeZText7.Contains('[launch-failure]')) { Write-Host $scopeZText7; throw 'SCENARIO Z FAILED: MOE_DISABLE_ARGV_PROBE=1 must skip the probe and fall through to the launch-failure path' }
                    $scopeZArgs7 = Get-CodexArgv
                    if ($scopeZArgs7 -ccontains '--help' -or -not ($scopeZArgs7 | Where-Object { $_ -like '*Task task-postflight is claimed*' })) { Write-Host ($scopeZArgs7 -join ' '); throw 'SCENARIO Z FAILED: with the probe disabled the real prompt must be launched and no --help probe issued' }
                } finally {
                    Remove-Item Env:FAKE_CODEX_REJECT_ARGV -ErrorAction SilentlyContinue
                    Remove-Item Env:MOE_DISABLE_ARGV_PROBE -ErrorAction SilentlyContinue
                    Remove-Item Env:FAKE_CODEX_ARGV_FILE -ErrorAction SilentlyContinue
                    Remove-Item Env:FAKE_CODEX_EXIT -ErrorAction SilentlyContinue
                    Remove-Item Env:MOE_CODEX_SANDBOX -ErrorAction SilentlyContinue
                    if ($null -ne $scopeZPrevSerena) { $env:MOE_SERENA_PATH = $scopeZPrevSerena } else { Remove-Item Env:MOE_SERENA_PATH -ErrorAction SilentlyContinue }
                    foreach ($name in $scopeZPrevOperatorEnv.Keys) {
                        if ($null -ne $scopeZPrevOperatorEnv[$name]) { [Environment]::SetEnvironmentVariable($name, $scopeZPrevOperatorEnv[$name]) } else { Remove-Item "Env:$name" -ErrorAction SilentlyContinue }
                    }
                    $env:FAKE_TASK_STATUS = 'REVIEW'
                }
                $scopeScenariosRun++
                Write-Host '[scenario Z] ok'

                # Scenario AA -- the reproduction. No claimable task, single-shot
                # run (Invoke-GateWrapper always passes -NoLoop, exactly the
                # shape whose fast path used to be gated off): the wrapper must
                # do its own waiting and launch NOTHING rather than hand a CLI a
                # prompt telling it to claim. A CLI that ran here would have
                # edited with no baseline and landed nothing.
                Write-Host '[scenario AA] a taskless single-shot run never launches an unbound CLI'
                $scopeAADir = Join-Path $tempRoot 'scope-aa'
                New-ScopeProject $scopeAADir @()
                $scopeAAOut = Join-Path $tempRoot 'scope-aa.out'
                $env:FAKE_CLAIM_MODE = 'idle'
                # The single-shot wait is bounded by MOE_TASKLESS_WAIT_SEC; 5s
                # keeps the scenario inside the harness's per-wrapper timeout
                # instead of idling for the 300s production default.
                $env:MOE_TASKLESS_WAIT_SEC = '5'
                try {
                    Assert-ScopeRun 'AA' (Invoke-GateWrapper $scopeAADir $scopeAAOut 'REVIEW' $createFileCmd 'worker' 'worker-scope-aa') $scopeAAOut
                } finally {
                    Remove-Item Env:FAKE_CLAIM_MODE -ErrorAction SilentlyContinue
                    Remove-Item Env:MOE_TASKLESS_WAIT_SEC -ErrorAction SilentlyContinue
                }
                if (Test-Path (Join-Path $scopeAADir 'session-new.txt')) {
                    Get-Content $scopeAAOut -ErrorAction SilentlyContinue | ForEach-Object { Write-Host $_ }
                    throw 'SCENARIO AA FAILED: a CLI was launched with no task bound -- it would edit with no baseline and land nothing'
                }
                $scopeAAText = Get-Content -Raw -Path $scopeAAOut
                if (-not $scopeAAText.Contains('MOE_TASKLESS_NO_LAUNCH reason=idle')) {
                    Write-Host $scopeAAText
                    throw 'SCENARIO AA FAILED: the suppressed launch must be named, not silent'
                }
                $scopeScenariosRun++
                Write-Host '[scenario AA] ok'

                # Scenario AB -- the adoption alarm. The one legitimate taskless
                # launch is a chat-only session answering a routed mention; it
                # holds no task and so has no baseline by design. If it
                # nonetheless ends holding one and left the tree dirty, the
                # wrapper must REFUSE under a named code, leave the bytes alone
                # (no invented baseline, no staging) and page #governors.
                Write-Host '[scenario AB] a chat-only session that adopts a task refuses to land, loudly'
                $scopeABDir = Join-Path $tempRoot 'scope-ab'
                New-ScopeProject $scopeABDir @()
                Set-Content -Path (Join-Path $scopeABDir 'peer-mod.txt') -Value 'peer-base'
                & git -C $scopeABDir add peer-mod.txt 2>$null | Out-Null
                & git -C $scopeABDir commit -qm peer-base 2>$null | Out-Null
                Set-Content -Path (Join-Path $scopeABDir 'peer-mod.txt') -Value 'peer-dirty'
                $scopeABHead = ((& git -C $scopeABDir rev-parse HEAD 2>$null) -join '')
                $scopeABOut = Join-Path $tempRoot 'scope-ab.out'
                $env:FAKE_CLAIM_MODE = 'idle'
                $env:FAKE_MENTION = '1'
                $env:FAKE_ADOPTED_TASK_ID = 'task-adopted'
                $env:MOE_TASKLESS_WAIT_SEC = '5'
                try {
                    Assert-ScopeRun 'AB' (Invoke-GateWrapper $scopeABDir $scopeABOut 'REVIEW' $createFileCmd 'worker' 'worker-scope-ab') $scopeABOut
                } finally {
                    Remove-Item Env:FAKE_CLAIM_MODE -ErrorAction SilentlyContinue
                    Remove-Item Env:FAKE_MENTION -ErrorAction SilentlyContinue
                    Remove-Item Env:FAKE_ADOPTED_TASK_ID -ErrorAction SilentlyContinue
                    Remove-Item Env:MOE_TASKLESS_WAIT_SEC -ErrorAction SilentlyContinue
                }
                if (-not (Test-Path (Join-Path $scopeABDir 'session-new.txt'))) {
                    Get-Content $scopeABOut -ErrorAction SilentlyContinue | ForEach-Object { Write-Host $_ }
                    throw 'SCENARIO AB FAILED: the chat-only session was never launched, so the adoption path was not exercised'
                }
                $scopeABText = Get-Content -Raw -Path $scopeABOut
                if (-not $scopeABText.Contains('MOE_COMMIT_REFUSED_ADOPTED_NO_BASELINE task=task-adopted')) {
                    Write-Host $scopeABText
                    throw 'SCENARIO AB FAILED: an adopted task with a dirty tree must refuse under the named code, not exit silently'
                }
                if (((& git -C $scopeABDir rev-parse HEAD 2>$null) -join '') -ne $scopeABHead) {
                    throw 'SCENARIO AB FAILED: the refusal still moved the branch -- nothing may land without a baseline'
                }
                $scopeABStatus = @(& git -C $scopeABDir status --porcelain 2>$null)
                if ($scopeABStatus -notcontains '?? session-new.txt') {
                    throw "SCENARIO AB FAILED: the adopted session's bytes must stay in the working tree, unstaged; status was [$($scopeABStatus -join '|')]"
                }
                if ($scopeABStatus -notcontains ' M peer-mod.txt') {
                    throw "SCENARIO AB FAILED: the peer's dirty file must be untouched by the refusal; status was [$($scopeABStatus -join '|')]"
                }
                $scopeABChat = Get-Content -Raw -Path (Join-Path $scopeABDir '.moe\messages\chan-general.jsonl') -ErrorAction SilentlyContinue
                if (-not ($scopeABChat -and $scopeABChat.Contains('MOE_COMMIT_REFUSED_ADOPTED_NO_BASELINE task=task-adopted'))) {
                    throw 'SCENARIO AB FAILED: the refusal must page #governors, not just print'
                }
                $scopeScenariosRun++
                Write-Host '[scenario AB] ok'

                # Scenario AB2 -- the retained hold is not an adoption. A seat
                # whose own task is BLOCKED (a resource wait) relaunches
                # notification-only to answer a routed mention; at exit it still
                # holds that same task, so the binding is RETAINED. The refusal
                # must still print (nothing may land without a baseline) but
                # must NOT page #governors: every such relaunch found the same
                # foreign shared dirt, and the page carried no news.
                Write-Host '[scenario AB2] a notification-only relaunch onto a retained BLOCKED hold refuses quietly'
                $scopeAB2Dir = Join-Path $tempRoot 'scope-ab2'
                New-ScopeProject $scopeAB2Dir @()
                Set-Content -Path (Join-Path $scopeAB2Dir 'peer-mod.txt') -Value 'peer-base'
                & git -C $scopeAB2Dir add peer-mod.txt 2>$null | Out-Null
                & git -C $scopeAB2Dir commit -qm peer-base 2>$null | Out-Null
                Set-Content -Path (Join-Path $scopeAB2Dir 'peer-mod.txt') -Value 'peer-dirty'
                $scopeAB2Head = ((& git -C $scopeAB2Dir rev-parse HEAD 2>$null) -join '')
                $scopeAB2Out = Join-Path $tempRoot 'scope-ab2.out'
                $env:FAKE_CLAIM_MODE = 'blocked'
                $env:FAKE_MENTION = '1'
                $env:FAKE_ADOPTED_TASK_ID = 'task-resume'
                $env:MOE_TASKLESS_WAIT_SEC = '5'
                try {
                    Assert-ScopeRun 'AB2' (Invoke-GateWrapper $scopeAB2Dir $scopeAB2Out 'REVIEW' $createFileCmd 'worker' 'worker-scope-ab2') $scopeAB2Out
                } finally {
                    Remove-Item Env:FAKE_CLAIM_MODE -ErrorAction SilentlyContinue
                    Remove-Item Env:FAKE_MENTION -ErrorAction SilentlyContinue
                    Remove-Item Env:FAKE_ADOPTED_TASK_ID -ErrorAction SilentlyContinue
                    Remove-Item Env:MOE_TASKLESS_WAIT_SEC -ErrorAction SilentlyContinue
                }
                if (-not (Test-Path (Join-Path $scopeAB2Dir 'session-new.txt'))) {
                    Get-Content $scopeAB2Out -ErrorAction SilentlyContinue | ForEach-Object { Write-Host $_ }
                    throw 'SCENARIO AB2 FAILED: the notification-only session was never launched, so the retained path was not exercised'
                }
                $scopeAB2Text = Get-Content -Raw -Path $scopeAB2Out
                if (-not $scopeAB2Text.Contains('MOE_COMMIT_REFUSED_ADOPTED_NO_BASELINE task=task-resume worker=worker-scope-ab2 binding=retained')) {
                    Write-Host $scopeAB2Text
                    throw 'SCENARIO AB2 FAILED: the retained hold must still refuse under the named code with binding=retained'
                }
                if (((& git -C $scopeAB2Dir rev-parse HEAD 2>$null) -join '') -ne $scopeAB2Head) {
                    throw 'SCENARIO AB2 FAILED: the refusal still moved the branch -- nothing may land without a baseline'
                }
                $scopeAB2Status = @(& git -C $scopeAB2Dir status --porcelain 2>$null)
                if ($scopeAB2Status -notcontains ' M peer-mod.txt') {
                    throw "SCENARIO AB2 FAILED: the peer's dirty file must be untouched by the refusal; status was [$($scopeAB2Status -join '|')]"
                }
                $scopeAB2Chat = Get-Content -Raw -Path (Join-Path $scopeAB2Dir '.moe\messages\chan-general.jsonl') -ErrorAction SilentlyContinue
                if ($scopeAB2Chat -and $scopeAB2Chat.Contains('MOE_COMMIT_REFUSED_ADOPTED_NO_BASELINE')) {
                    throw 'SCENARIO AB2 FAILED: a retained hold must not page #governors -- the relaunch edited nothing and the page carries no news'
                }
                $scopeScenariosRun++
                Write-Host '[scenario AB2] ok'

                # Scenario AB3 (task-ecf78687) -- twin of postflight.sh: a seat's
                # OWN message is never its mention. (a) The only unread message
                # is one this seat sent, tagging itself, @all and its role group:
                # the pre-wait probe must not count it (the wrapper-side wait
                # runs) and the routed build must not list it (no
                # notification-only session). (b) Contrast: another sender's
                # @all + role-group tag still launches one.
                Write-Host "[scenario AB3] a seat's own role-group/@all message never wakes it"
                $scopeAB3Dir = Join-Path $tempRoot 'scope-ab3'
                New-ScopeProject $scopeAB3Dir @()
                $scopeAB3Out = Join-Path $tempRoot 'scope-ab3.out'
                $env:FAKE_CLAIM_MODE = 'idle'
                $env:FAKE_MENTION = 'self'
                $env:MOE_TASKLESS_WAIT_SEC = '5'
                try {
                    Assert-ScopeRun 'AB3' (Invoke-GateWrapper $scopeAB3Dir $scopeAB3Out 'REVIEW' $createFileCmd 'worker' 'worker-scope-ab3') $scopeAB3Out
                } finally {
                    Remove-Item Env:FAKE_CLAIM_MODE -ErrorAction SilentlyContinue
                    Remove-Item Env:FAKE_MENTION -ErrorAction SilentlyContinue
                    Remove-Item Env:MOE_TASKLESS_WAIT_SEC -ErrorAction SilentlyContinue
                }
                $scopeAB3Chat = Get-Content -Raw -Path (Join-Path $scopeAB3Dir '.moe\messages\chan-general.jsonl') -ErrorAction SilentlyContinue
                if (-not ($scopeAB3Chat -and $scopeAB3Chat.Contains('msg-fake-self'))) {
                    throw "SCENARIO AB3 FAILED: fixture: the seat's own message was never served"
                }
                $scopeAB3Text = Get-Content -Raw -Path $scopeAB3Out
                if (Test-Path (Join-Path $scopeAB3Dir 'session-new.txt')) {
                    Write-Host $scopeAB3Text
                    throw "SCENARIO AB3 FAILED: the seat's own message launched a notification-only session to answer itself"
                }
                if (-not $scopeAB3Text.Contains('[no-task] No claimable task for role worker; waiting up to 5s in the wrapper')) {
                    Write-Host $scopeAB3Text
                    throw "SCENARIO AB3 FAILED: the pre-wait probe counted the seat's own message, so the wrapper-side wait was skipped"
                }
                if (-not $scopeAB3Text.Contains('MOE_TASKLESS_NO_LAUNCH reason=idle role=worker worker=worker-scope-ab3')) {
                    Write-Host $scopeAB3Text
                    throw 'SCENARIO AB3 FAILED: the suppressed launch must be named, not silent'
                }
                $scopeAB3bDir = Join-Path $tempRoot 'scope-ab3b'
                New-ScopeProject $scopeAB3bDir @()
                $scopeAB3bOut = Join-Path $tempRoot 'scope-ab3b.out'
                $env:FAKE_CLAIM_MODE = 'idle'
                $env:FAKE_MENTION = 'group'
                $env:MOE_TASKLESS_WAIT_SEC = '5'
                try {
                    Assert-ScopeRun 'AB3' (Invoke-GateWrapper $scopeAB3bDir $scopeAB3bOut 'REVIEW' $createFileCmd 'worker' 'worker-scope-ab3b') $scopeAB3bOut
                } finally {
                    Remove-Item Env:FAKE_CLAIM_MODE -ErrorAction SilentlyContinue
                    Remove-Item Env:FAKE_MENTION -ErrorAction SilentlyContinue
                    Remove-Item Env:MOE_TASKLESS_WAIT_SEC -ErrorAction SilentlyContinue
                }
                if (-not (Test-Path (Join-Path $scopeAB3bDir 'session-new.txt'))) {
                    Get-Content $scopeAB3bOut -ErrorAction SilentlyContinue | ForEach-Object { Write-Host $_ }
                    throw "SCENARIO AB3 FAILED: (b) another sender's @all/role-group tag must still launch a notification-only session"
                }
                $scopeScenariosRun++
                Write-Host '[scenario AB3] ok'

                # Scenarios AC/AD — twin of postflight.sh: a file whose HEAD blob
                # holds CRLF, under line-ending conversion. The snapshot's
                # `hash-object` loads no index and normalizes CRLF to LF; `git add`
                # into the temp index (seeded from HEAD) keeps CRLF under git's
                # safer-autocrlf rule. Comparing the two dropped every edit to such
                # a file as MOE_ATTR_CONCURRENT (CQ-M01d, 71c7dbe). AC: the edit
                # lands, as the CRLF blob git add made, under each conversion mode;
                # crlf.mjs is a source file the importee guard re-reads from the
                # index. AD: a change after the snapshot still drops, a swap for a
                # symlink to an identical copy too. Fixtures are
                # raw bytes (Set-Content rewrites line endings on 5.1) and every
                # seeding git call pins core.autocrlf (Git for Windows defaults it
                # to true). Byte equality is `hash-object --no-filters` against the
                # blob id: PowerShell cannot pipe CR bytes out of git intact.
                function Write-CrlfBytes([string]$path, [string]$text) {
                    [IO.File]::WriteAllBytes($path, [Text.Encoding]::ASCII.GetBytes($text))
                }
                function Get-GitId([string]$dir, [string[]]$gitArgs) {
                    return ((& git -C $dir @gitArgs 2>$null) -join '').Trim()
                }
                function New-CrlfSeed([string]$dir, [string]$mode, [string]$name) {
                    foreach ($f in 'crlf.txt', 'crlf.mjs') { Write-CrlfBytes (Join-Path $dir $f) "one`r`ntwo`r`n" }
                    & git -C $dir -c core.autocrlf=false add crlf.txt crlf.mjs 2>$null | Out-Null
                    & git -C $dir -c core.autocrlf=false commit -qm crlf-seed 2>$null | Out-Null
                    switch ($mode) {
                        'autocrlf-true' { & git -C $dir config core.autocrlf true 2>$null | Out-Null }
                        'autocrlf-input' { & git -C $dir config core.autocrlf input 2>$null | Out-Null }
                        'text-auto' {
                            & git -C $dir config core.autocrlf false 2>$null | Out-Null
                            Write-CrlfBytes (Join-Path $dir '.gitattributes') "* text=auto`n"
                            & git -C $dir add .gitattributes 2>$null | Out-Null
                            & git -C $dir commit -qm text-auto 2>$null | Out-Null
                        }
                    }
                    if ((Get-GitId $dir @('rev-parse', 'HEAD:crlf.txt')) -ne (Get-GitId $dir @('hash-object', '--no-filters', '--', 'crlf.txt'))) {
                        throw "SCENARIO $name FAILED: fixture: HEAD:crlf.txt must hold the raw CRLF bytes ($mode)"
                    }
                }

                Write-Host '[scenario AC] an edit to a CRLF-committed file lands under autocrlf=true, autocrlf=input and text=auto'
                foreach ($acMode in 'autocrlf-true', 'autocrlf-input', 'text-auto') {
                    $scopeACDir = Join-Path $tempRoot "scope-ac-$acMode"
                    $scopeACOut = Join-Path $tempRoot "scope-ac-$acMode.out"
                    New-ScopeProject $scopeACDir @('crlf.txt', 'crlf.mjs')
                    New-CrlfSeed $scopeACDir $acMode 'AC'
                    foreach ($f in 'crlf.txt', 'crlf.mjs') { Write-CrlfBytes (Join-Path $scopeACDir $f) "one`r`ntwo edited`r`n" }
                    Assert-ScopeRun 'AC' (Invoke-GateWrapper $scopeACDir $scopeACOut) $scopeACOut
                    $acLedger = (Get-RecordCommitLines $scopeACDir) -join "`n"
                    if ($acLedger.Contains('MOE_ATTR_CONCURRENT') -or "$(Get-Content -Raw -Path $scopeACOut)".Contains('MOE_ATTR_CONCURRENT')) {
                        Write-Host $acLedger
                        throw "SCENARIO AC FAILED: ${acMode}: crlf.txt was dropped as MOE_ATTR_CONCURRENT"
                    }
                    if ((Get-HeadSubject $scopeACDir) -notlike 'feat(task-postflight): *') {
                        Get-Content $scopeACOut -ErrorAction SilentlyContinue | ForEach-Object { Write-Host $_ }
                        throw "SCENARIO AC FAILED: ${acMode}: HEAD is not the completion -- the edit never landed"
                    }
                    $acPaths = Get-CommittedPaths $scopeACDir
                    if ($acPaths -ne 'crlf.mjs crlf.txt') { throw "SCENARIO AC FAILED: ${acMode}: the completion must contain exactly crlf.mjs and crlf.txt; got [$acPaths]" }
                    foreach ($f in 'crlf.txt', 'crlf.mjs') {
                        if ((Get-GitId $scopeACDir @('rev-parse', "HEAD:$f")) -ne (Get-GitId $scopeACDir @('hash-object', '--no-filters', '--', $f))) {
                            throw "SCENARIO AC FAILED: ${acMode}: HEAD:$f must be the CRLF bytes git add staged, byte for byte"
                        }
                    }
                }
                $scopeScenariosRun++
                Write-Host '[scenario AC] ok'

                # Symlink support, probed once for AD's link variant and scenario
                # AE: Windows needs admin rights or Developer Mode to create one.
                # CI (windows-latest runs as admin) must run both, so a failed
                # probe there is a failure, never a skip. Every link is made by
                # node, which keeps the exact relative link text on both engines.
                $symlinkCjs = Join-Path $tempRoot 'symlink-fixture.cjs'
                Set-Content -Path $symlinkCjs -Encoding ASCII -Value @'
const fs = require('fs'), path = require('path');
const [mode, dir] = process.argv.slice(2);
const link = (target, name) => fs.symlinkSync(target, path.join(dir, name), 'file');
if (mode === 'probe') {
  fs.writeFileSync(path.join(dir, 'symlink-probe-target'), '');
  link('symlink-probe-target', 'symlink-probe');
  if (!fs.lstatSync(path.join(dir, 'symlink-probe')).isSymbolicLink()) process.exit(1);
} else if (mode === 'seed') {
  link('same-a.txt', 'retarget-link');
  link('target.txt', 'stay-link');
  link('missing.txt', 'dangling-link');
} else if (mode === 'session') {
  fs.rmSync(path.join(dir, 'retarget-link'), { force: true });
  link('same-b.txt', 'retarget-link');
  fs.writeFileSync(path.join(dir, 'target.txt'), 'v2\n');
} else {
  process.exit(2);
}
'@
                $symlinksOk = $false
                try {
                    & node $symlinkCjs probe $tempRoot 2>$null | Out-Null
                    $symlinksOk = ($LASTEXITCODE -eq 0)
                } catch { $symlinksOk = $false }
                if (-not $symlinksOk -and $env:GITHUB_ACTIONS -eq 'true') {
                    throw 'SCENARIO AE FAILED: CI must be able to create symlinks'
                }

                # AD: crlf-hook.cmd changes crlf.txt through node (cmd cannot quote
                # CR bytes), then hook-peer.cmd commits a peer file, so the CAS
                # retry rebuilds the temp index against the OLD snapshot (scenario
                # O). A rewrite re-hashes differently; a delete leaves no staged
                # entry; a directory in its place stages crlf.txt/inner while the
                # re-hash fails; a symlink to an identical copy stages the link,
                # whose link text re-hashes differently (a re-hash that followed
                # the link read the copy's bytes, and it landed). None may land.
                Set-Content -Path (Join-Path $tempRoot 'crlf-hook.cjs') -Encoding ASCII -Value @'
const fs = require('fs'), path = require('path');
const f = path.join(process.env.MOE_PROJECT_PATH, 'crlf.txt'), mode = process.env.CRLF_HOOK_MODE;
if (mode === 'link') fs.copyFileSync(f, path.join(path.dirname(f), 'crlf-copy.txt'));
fs.rmSync(f, { force: true });
if (mode === 'rewrite') fs.writeFileSync(f, 'one\r\nconcurrent\r\n');
if (mode === 'dir') { fs.mkdirSync(f); fs.writeFileSync(path.join(f, 'inner'), 'inner\n'); }
if (mode === 'link') fs.symlinkSync('crlf-copy.txt', f, 'file');
'@
                $crlfHookCmd = Join-Path $tempRoot 'crlf-hook.cmd'
                Set-Content -Path $crlfHookCmd -Encoding ASCII -Value ("@echo off`r`n" +
                    "node `"%~dp0crlf-hook.cjs`" || exit /b 1`r`n" +
                    "call `"%~dp0hook-peer.cmd`"`r`n")
                Write-Host '[scenario AD] a CRLF-committed file rewritten, deleted, or replaced by a directory or a symlink after the snapshot still drops as MOE_ATTR_CONCURRENT'
                $adVariants = @('rewrite', 'delete', 'dir')
                if ($symlinksOk) {
                    $adVariants += 'link'
                } else {
                    Write-Host '[scenario AD] link variant skipped: this host cannot create symlinks'
                }
                foreach ($adVariant in $adVariants) {
                    $scopeADDir = Join-Path $tempRoot "scope-ad-$adVariant"
                    $scopeADOut = Join-Path $tempRoot "scope-ad-$adVariant.out"
                    New-ScopeProject $scopeADDir @('owned-a.txt', 'crlf.txt')
                    New-CrlfSeed $scopeADDir 'autocrlf-true' 'AD'
                    $adSeed = Get-GitId $scopeADDir @('rev-parse', 'HEAD:crlf.txt')
                    Set-Content -Path (Join-Path $scopeADDir 'owned-a.txt') -Value 'owned-a'
                    Write-CrlfBytes (Join-Path $scopeADDir 'crlf.txt') "one`r`ntwo edited`r`n"
                    $env:CRLF_HOOK_MODE = $adVariant
                    $env:MOE_POSTFLIGHT_TEST_HOOK_PRE_UPDATE_REF = $crlfHookCmd
                    try {
                        Assert-ScopeRun 'AD' (Invoke-GateWrapper $scopeADDir $scopeADOut) $scopeADOut
                    } finally {
                        Remove-Item Env:MOE_POSTFLIGHT_TEST_HOOK_PRE_UPDATE_REF -ErrorAction SilentlyContinue
                        Remove-Item Env:CRLF_HOOK_MODE -ErrorAction SilentlyContinue
                    }
                    if ((Get-HeadSubject $scopeADDir) -notlike 'feat(task-postflight): *') { throw "SCENARIO AD FAILED: ${adVariant}: ours must be on top; HEAD is [$(Get-HeadSubject $scopeADDir)]" }
                    if ((Get-HeadSubject $scopeADDir 'HEAD~1') -ne 'peer-hook') { throw "SCENARIO AD FAILED: ${adVariant}: the hook's peer commit must be HEAD~1 (the CAS retry never ran); got [$(Get-HeadSubject $scopeADDir 'HEAD~1')]" }
                    & git -C $scopeADDir cat-file -e HEAD:owned-a.txt 2>$null | Out-Null
                    if ($LASTEXITCODE -ne 0) { throw "SCENARIO AD FAILED: ${adVariant}: owned-a.txt must be present in HEAD" }
                    if ((Get-GitId $scopeADDir @('rev-parse', 'HEAD:crlf.txt')) -ne $adSeed) {
                        throw "SCENARIO AD FAILED: ${adVariant}: crlf.txt changed after the snapshot, so HEAD must keep the seed blob"
                    }
                    $adDropped = @(Get-RecordCommitLines $scopeADDir | ForEach-Object { $_ | ConvertFrom-Json } | Where-Object { $_.outcome -eq 'committed' } |
                        ForEach-Object { @($_.skipped) } | Where-Object { $_ -and $_.path -eq 'crlf.txt' -and $_.code -eq 'MOE_ATTR_CONCURRENT' })
                    if ($adDropped.Count -eq 0) {
                        Write-Host ((Get-RecordCommitLines $scopeADDir) -join "`n")
                        throw "SCENARIO AD FAILED: ${adVariant}: the committed record_commit row must report crlf.txt as MOE_ATTR_CONCURRENT"
                    }
                }
                $scopeScenariosRun++
                Write-Host '[scenario AD] ok'

                # Scenario AE — a symlink is fingerprinted by its link text, the
                # blob `git add` stores, not by its target's bytes (hash-object
                # follows a link). Three links sit untracked in the baseline as
                # foreign dirt:
                #   retarget-link  retargeted by the session to a file with
                #                  identical bytes: its link text changed, so it
                #                  lands (MEASURED)
                #   stay-link      the session edits its target, not the link:
                #                  PREEXISTING
                #   dangling-link  points nowhere and is never touched: PREEXISTING
                if ($symlinksOk) {
                    Write-Host '[scenario AE] a retargeted symlink lands; a symlink whose target changed, and a dangling one, stay MOE_ATTR_PREEXISTING'
                    $scopeAEDir = Join-Path $tempRoot 'scope-ae'
                    $scopeAEOut = Join-Path $tempRoot 'scope-ae.out'
                    New-ScopeProject $scopeAEDir @('target.txt')
                    foreach ($f in 'same-a.txt', 'same-b.txt') { [IO.File]::WriteAllText((Join-Path $scopeAEDir $f), "same`n") }
                    [IO.File]::WriteAllText((Join-Path $scopeAEDir 'target.txt'), "v1`n")
                    & git -C $scopeAEDir add same-a.txt same-b.txt target.txt 2>$null | Out-Null
                    & git -C $scopeAEDir commit -qm ae-seed 2>$null | Out-Null
                    & node $symlinkCjs seed $scopeAEDir 2>$null | Out-Null
                    if ($LASTEXITCODE -ne 0) { throw 'SCENARIO AE FAILED: fixture: node could not create the three links' }
                    $aeCmd = Join-Path $tempRoot 'ae-session.cmd'
                    Set-Content -Path $aeCmd -Encoding ASCII -Value ("@echo off`r`n" +
                        "node `"%~dp0symlink-fixture.cjs`" session `"%MOE_PROJECT_PATH%`" || exit /b 1`r`n" +
                        "exit /b 0`r`n")
                    Assert-ScopeRun 'AE' (Invoke-GateWrapper $scopeAEDir $scopeAEOut -Command $aeCmd) $scopeAEOut
                    $aePaths = Get-CommittedPaths $scopeAEDir
                    if ($aePaths -ne 'retarget-link target.txt') {
                        Get-Content $scopeAEOut -ErrorAction SilentlyContinue | ForEach-Object { Write-Host $_ }
                        throw "SCENARIO AE FAILED: the completion must contain exactly retarget-link and target.txt; got [$aePaths]"
                    }
                    if ("$(& git -C $scopeAEDir ls-tree HEAD -- retarget-link 2>$null)" -notlike '120000 *') {
                        throw 'SCENARIO AE FAILED: HEAD:retarget-link must be a symlink (mode 120000)'
                    }
                    if ((Get-GitId $scopeAEDir @('cat-file', 'blob', 'HEAD:retarget-link')) -ne 'same-b.txt') {
                        throw 'SCENARIO AE FAILED: HEAD:retarget-link must hold the new link text same-b.txt'
                    }
                    $aeOutText = Get-Content -Raw -Path $scopeAEOut
                    $aeStatus = @(& git -C $scopeAEDir status --porcelain 2>$null)
                    foreach ($aeLink in 'stay-link', 'dangling-link') {
                        if (-not $aeOutText.Contains("[skip] $aeLink MOE_ATTR_PREEXISTING")) {
                            Write-Host $aeOutText
                            throw "SCENARIO AE FAILED: expected '[skip] $aeLink MOE_ATTR_PREEXISTING'"
                        }
                        if ($aeStatus -notcontains "?? $aeLink") { throw "SCENARIO AE FAILED: $aeLink must stay untracked" }
                    }
                    $scopeScenariosRun++
                    Write-Host '[scenario AE] ok'
                } else {
                    Write-Host '[scenario AE] skipped: this host cannot create symlinks'
                }

                # Scenario AF — the skip-untouched idle-peer exception
                # (task-c2cb5cf7; same fixture as postflight.sh). An own
                # contested path with no TOOL witness (a Bash-style write:
                # create-file.cmd's FAKE_CLI_EXTRA_FILE) lands only when it was
                # clean at this session's pre-flight AND every contesting task
                # reports peerActive:false. Another worker stays active
                # throughout (FAKE_SCOPE_PEERS_ACTIVE=1), so only the per-path
                # flag can release a path.
                #   AF1  idle peer, clean at pre-flight   -> lands, Moe-Contested trailer
                #   AF2  live peer, clean at pre-flight   -> held, named in held=
                #   AF3  idle peer, dirty at pre-flight   -> both held, named in held=
                #        (one of the two rewritten during the session)
                # K2's refused.txt covers the absent field (an older daemon): still held.
                Write-Host '[scenario AF] an unwitnessed own contested path lands only when clean at pre-flight and every contesting task is idle'
                function Get-ScopeAFEnded([string]$dir) {
                    return "$(Get-Content -Path (Join-Path $dir '.moe\messages\chan-general.jsonl') | Where-Object { $_ -like '*worker session ended: task=task-postflight*' } | Select-Object -Last 1)"
                }
                $afRuns = @(
                    @{ Name = 'AF1'; Files = @('owned-a.txt', 'contested.txt'); Pre = @('owned-a.txt'); Peers = 'contested.txt:task-peer'; Active = '0'; Extra = 'contested.txt' },
                    @{ Name = 'AF2'; Files = @('owned-a.txt', 'contested.txt'); Pre = @('owned-a.txt'); Peers = 'contested.txt:task-peer'; Active = '1'; Extra = 'contested.txt' },
                    @{ Name = 'AF3'; Files = @('owned-a.txt', 'pre-untouched.txt', 'pre-touched.txt'); Pre = @('owned-a.txt', 'pre-untouched.txt', 'pre-touched.txt')
                       Peers = 'pre-untouched.txt:task-peer,pre-touched.txt:task-peer'; Active = '0'; Extra = 'pre-touched.txt' }
                )
                foreach ($af in $afRuns) {
                    $afName = $af.Name
                    $afDir = Join-Path $tempRoot "scope-$($afName.ToLower())"
                    $afOut = Join-Path $tempRoot "scope-$($afName.ToLower()).out"
                    New-ScopeProject $afDir $af.Files
                    foreach ($f in $af.Pre) { Set-Content -Path (Join-Path $afDir $f) -Value 'pre' }
                    $env:FAKE_SCOPE_PEERS_ACTIVE = '1'
                    $env:FAKE_SCOPE_PEER_DECLARED = $af.Peers
                    $env:FAKE_SCOPE_PEER_ACTIVE = $af.Active
                    $env:FAKE_CLI_EXTRA_FILE = $af.Extra
                    try {
                        Assert-ScopeRun $afName (Invoke-GateWrapper $afDir $afOut -Command $createFileCmd) $afOut
                    } finally {
                        foreach ($v in 'FAKE_SCOPE_PEERS_ACTIVE', 'FAKE_SCOPE_PEER_DECLARED', 'FAKE_SCOPE_PEER_ACTIVE', 'FAKE_CLI_EXTRA_FILE') { Remove-Item "Env:$v" -ErrorAction SilentlyContinue }
                    }
                    $afPaths = Get-CommittedPaths $afDir
                    $afText = Get-Content -Raw -Path $afOut
                    $afStatus = @(& git -C $afDir status --porcelain 2>$null)
                    $afLine = Get-ScopeAFEnded $afDir
                    if (-not $afLine) { Write-Host $afText; throw "SCENARIO $afName FAILED: no session-ended line in #general" }
                    if ($afName -eq 'AF1') {
                        if ($afPaths -ne 'contested.txt owned-a.txt') { Write-Host $afText; throw "SCENARIO AF1 FAILED: an idle peer's clean contested path must land; got [$afPaths]" }
                        if ($afText.Contains('[skip] contested.txt')) { Write-Host $afText; throw 'SCENARIO AF1 FAILED: contested.txt must not be skipped' }
                        if ((@(& git -C $afDir log -1 --format=%B 2>$null) -join "`n") -notlike '*Moe-Contested: contested.txt (task-peer)*') { throw 'SCENARIO AF1 FAILED: the completion must keep the Moe-Contested trailer' }
                        if ($afLine -like '* held=*' -or $afLine -like '*MOE_CONTESTED_HELD*') { throw "SCENARIO AF1 FAILED: nothing was held, so no held= suffix or remedy; got [$afLine]" }
                        continue
                    }
                    if ($afPaths -ne 'owned-a.txt') { Write-Host $afText; throw "SCENARIO $afName FAILED: a live peer's or a pre-flight-dirty contested path must stay out; got [$afPaths]" }
                    $afHeld = @($af.Peers -split ',' | ForEach-Object { $_.Split(':')[0] })
                    foreach ($p in $afHeld) {
                        if (-not $afText.Contains("[skip] $p MOE_ATTR_CONTESTED_UNTOUCHED(task-peer)")) { Write-Host $afText; throw "SCENARIO $afName FAILED: expected '[skip] $p MOE_ATTR_CONTESTED_UNTOUCHED(task-peer)'" }
                        if ($afStatus -notcontains "?? $p") { throw "SCENARIO $afName FAILED: $p must stay untracked" }
                    }
                    $afWant = if ($afName -eq 'AF2') { ' held=contested.txt(task-peer)' } else { ' held=pre-touched.txt(task-peer),pre-untouched.txt(task-peer)' }
                    if (-not $afLine.Contains($afWant)) { throw "SCENARIO $afName FAILED: the session-ended line must name the held path(s) [$afWant]; got [$afLine]" }
                }
                $scopeScenariosRun++
                Write-Host '[scenario AF] ok'

                # Scenario AG — declare_files does not release a contested
                # hold, and the session-ended line names the remedy that does
                # (task-c2a900aa, option B; same fixture as postflight.sh). Six
                # paths declared onto the owner (declaredFiles, served as
                # `declared`), one with a space and a non-ASCII letter, are
                # dirty BEFORE the pre-flight and declared by a peer too, so
                # each stays held whatever the peer's state. held= shows five
                # then `+1 more`, and one remedy follows. stream-json.cmd's
                # witnessed Write of tool-written.txt (asserted, also
                # peer-declared) lands under skip-untouched and is never held.
                # Only a landed contested path gets a Moe-Contested trailer.
                #   AG1  idle peer                    -> six held, untouched remedy, witnessed path lands
                #   AG2  live peer                    -> same
                #   AG3  no peerActive (older daemon) -> same
                #   AG4  idle peer, contested=skip    -> the witnessed path is held too, strict remedy only
                # The console [skip] lines are checked for the ASCII paths
                # only: a redirected child's console encoding is the OEM code
                # page. The ledger and the chat line are UTF-8 JSON.
                Write-Host '[scenario AG] a declared, pre-flight-dirty contested path stays held and the session-ended line names the working remedy'
                $agUntouched = "MOE_CONTESTED_HELD remedy: verify the bytes are this task's and coordinate any live peer; a held path then lands once a one-shot Claude or codex exec session of this task edits it, once a later session of this task that found it clean at pre-flight edits it while every contesting peer stays idle, or once the stale peer task is completed or archived. Only a one-shot Claude (claude -p) or codex exec session's editing call (Claude Edit/Write, Codex apply_patch, or a Serena editor) leaves a TOOL witness; a Codex TUI, Gemini, Grok or interactive Claude session's edits, Serena's included, leave none. declare_files, unblocking or a shell touch alone does not release a hold."
                $agStrict = "MOE_CONTESTED_HELD remedy: attribution.contested=skip holds these paths whatever this session edits; only resolving, completing or archiving the peer task releases them. declare_files, unblocking or a shell touch alone does not release a hold."
                $agDeclared = @("held $([char]0xE9).txt", 'z1.txt', 'z2.txt', 'z3.txt', 'z4.txt', 'z5.txt')
                $agUtf8 = New-Object System.Text.UTF8Encoding($false)
                foreach ($agRun in 1..4) {
                    $agName = "AG$agRun"
                    $agDir = Join-Path $tempRoot "scope-ag$agRun"
                    $agOut = Join-Path $tempRoot "scope-ag$agRun.out"
                    $agStrictRun = ($agRun -eq 4)
                    $agSettings = if ($agStrictRun) { @{ attribution = @{ contested = 'skip' } } } else { $null }
                    New-ScopeProject $agDir @('tool-written.txt') -Settings $agSettings
                    # Literal JSON: PS 5.1's ConvertTo-Json unwraps one-element arrays.
                    [System.IO.File]::WriteAllText((Join-Path $agDir '.moe\tasks\task-postflight.json'),
                        ('{"id":"task-postflight","title":"Postflight smoke","status":"REVIEW","filesModified":["tool-written.txt"],"declaredFiles":["' + ($agDeclared -join '","') + '"]}'), $agUtf8)
                    & git -C $agDir commit -qm ag-declared .moe/tasks/task-postflight.json 2>$null | Out-Null
                    foreach ($p in $agDeclared) { [System.IO.File]::WriteAllText((Join-Path $agDir $p), "pre`n", $agUtf8) }
                    $env:FAKE_SCOPE_DECLARED_FIELD = '1'
                    $env:FAKE_SCOPE_PEERS_ACTIVE = '1'
                    $env:FAKE_SCOPE_PEER_DECLARED = ((@($agDeclared) + 'tool-written.txt' | ForEach-Object { "${_}:task-peer" }) -join ',')
                    if ($agRun -eq 2) { $env:FAKE_SCOPE_PEER_ACTIVE = '1' } elseif ($agRun -ne 3) { $env:FAKE_SCOPE_PEER_ACTIVE = '0' }
                    try {
                        Assert-ScopeRun $agName (Invoke-GateWrapper $agDir $agOut -Command $streamJsonCmd) $agOut
                    } finally {
                        foreach ($v in 'FAKE_SCOPE_DECLARED_FIELD', 'FAKE_SCOPE_PEERS_ACTIVE', 'FAKE_SCOPE_PEER_DECLARED', 'FAKE_SCOPE_PEER_ACTIVE') { Remove-Item "Env:$v" -ErrorAction SilentlyContinue }
                    }
                    $agText = Get-Content -Raw -Path $agOut
                    $agWantPaths = if ($agStrictRun) { 'tool-edited.txt' } else { 'tool-edited.txt tool-written.txt' }
                    if ((Get-CommittedPaths $agDir) -ne $agWantPaths) { Write-Host $agText; throw "SCENARIO $agName FAILED: expected [$agWantPaths] committed; got [$(Get-CommittedPaths $agDir)]" }
                    # A Moe-Contested trailer claims a landed contested path: never a held one.
                    $agTrailers = (@(& git -C $agDir log -1 --format=%B 2>$null) | Where-Object { $_ -like 'Moe-Contested:*' }) -join '|'
                    $agWantTrailers = if ($agStrictRun) { '' } else { 'Moe-Contested: tool-written.txt (task-peer)' }
                    if ($agTrailers -ne $agWantTrailers) { throw "SCENARIO $agName FAILED: Moe-Contested trailers must name only the landed contested paths; got [$agTrailers]" }
                    $agCode = if ($agStrictRun) { 'MOE_ATTR_CONTESTED' } else { 'MOE_ATTR_CONTESTED_UNTOUCHED(task-peer)' }
                    foreach ($p in $agDeclared) {
                        if ($p -match '^z' -and -not $agText.Contains("[skip] $p $agCode")) { Write-Host $agText; throw "SCENARIO $agName FAILED: expected '[skip] $p $agCode'" }
                        & git -C $agDir cat-file -e "HEAD:$p" 2>$null
                        if ($LASTEXITCODE -eq 0 -or [System.IO.File]::ReadAllText((Join-Path $agDir $p)) -ne "pre`n") { throw "SCENARIO $agName FAILED: $p must stay dirty and out of the commit" }
                    }
                    # The ledger's skipped data names every held path with its
                    # code (AG4: the witnessed path too); the daemon builds
                    # MOE_CONTESTED_HELD from it.
                    $agRow = Get-Content -Encoding UTF8 -Path (Join-Path $agDir '.moe\record_commit.jsonl') | Where-Object { $_ } | Select-Object -Last 1 | ConvertFrom-Json
                    $agGot = (@($agRow.skipped | Where-Object { $_.code -eq $agCode } | ForEach-Object { $_.path }) | Sort-Object) -join '|'
                    $agWantHeld = (@($agDeclared) + @(if ($agStrictRun) { 'tool-written.txt' }) | Sort-Object) -join '|'
                    if ($agGot -ne $agWantHeld) { throw "SCENARIO $agName FAILED: record_commit skipped under $agCode must be [$agWantHeld]; got [$agGot]" }
                    $agLine = Get-Content -Encoding UTF8 -Path (Join-Path $agDir '.moe\messages\chan-general.jsonl') |
                        Where-Object { $_ -like '*worker session ended: task=task-postflight*' } | Select-Object -Last 1 | ConvertFrom-Json
                    $agHeld = "$($agDeclared[0])(task-peer),z1.txt(task-peer),z2.txt(task-peer),z3.txt(task-peer),z4.txt(task-peer),+1 more"
                    if ($agStrictRun) { $agHeld = "$($agDeclared[0])(task-peer),tool-written.txt(task-peer),z1.txt(task-peer),z2.txt(task-peer),z3.txt(task-peer),+2 more" }
                    $agRemedy = if ($agStrictRun) { $agStrict } else { $agUntouched }
                    $agOther = if ($agStrictRun) { $agUntouched } else { $agStrict }
                    if (-not $agLine -or -not ([string]$agLine.content).EndsWith(" held=$agHeld $agRemedy", [System.StringComparison]::Ordinal)) {
                        throw "SCENARIO $agName FAILED: the session-ended line must end with the bounded held= list and its one remedy; got [$($agLine.content)]"
                    }
                    if (([string]$agLine.content).Contains($agOther)) { throw "SCENARIO $agName FAILED: the other policy's remedy must not appear; got [$($agLine.content)]" }
                }
                $scopeScenariosRun++
                Write-Host '[scenario AG] ok'

                # Scenario AH -- launch outage mode (twin: scenario AH in
                # postflight.sh). A codex TUI worker whose CLI exits 1 at once,
                # the way a spent provider credit makes it (measured 2026-10-29:
                # such seats kept their tasks for hours behind the launch-failure
                # backoff, ending a "CLI exit=1" session every ~15 min). A codex
                # TUI does not loop, so its launch failures are what keep this
                # single-shot seat running. Run 1: the third fast exit releases
                # the held task exactly once, and only AFTER that iteration's
                # landing (its record_commit comes first), unforced, fenced by
                # the pinned attempt, with a "Seat outage, not a task refusal:"
                # handoff that releaseTask.ts's refusal cascade cannot count; the
                # @governors line says the task was released; the next iteration
                # calls no claim_next_task and launches a taskless probe; that
                # probe runs past MOE_LAUNCH_FAIL_SEC and exits 0, which ends the
                # outage, and the seat claims again and runs the session it is
                # for. Run 2: a refused release keeps the task, says so with the
                # daemon's code, and the resumed launch is the probe, with no
                # second release. Run 3: a launch the wrapper skipped (nothing to
                # do) keeps the streak's backoff instead of reading as a launch
                # that ran. The launch window is 10s here, not the sh twin's 5s:
                # a Windows PowerShell child takes seconds to start, and the
                # wrapper rounds the elapsed time instead of truncating it.
                Write-Host '[scenario AH] launch outage: the third fast exit releases the held task once, then taskless probes until a launch runs'
                $outageBin = Join-Path $tempRoot 'outage-bin'
                New-Item -ItemType Directory -Force -Path $outageBin | Out-Null
                # The codex.cmd front above, in its own directory (the wrapper
                # matches the basename). Launch N of this run: 1..FAKE_OUTAGE_FAILS
                # exit 1 at once; after that a launch probe sleeps
                # FAKE_OUTAGE_PROBE_SEC (past MOE_LAUNCH_FAIL_SEC) and exits 0, and
                # any other launch exits 0 at once. Each launch is logged into the
                # fake daemon's RPC log, so its order against the claim, landing
                # and release calls is on record.
                Set-Content -Path (Join-Path $outageBin 'codex-impl.ps1') -Encoding ASCII -Value @'
$moe = Join-Path $env:MOE_PROJECT_PATH '.moe'
$countFile = Join-Path $moe 'outage-launches'
$n = 1
if (Test-Path -LiteralPath $countFile) { $n = [int]([IO.File]::ReadAllText($countFile).Trim()) + 1 }
[IO.File]::WriteAllText($countFile, [string]$n)
$prompt = if ($args.Count -gt 0) { [string]$args[$args.Count - 1] } else { '' }
$kind = if ($prompt.Contains('This is a launch probe for workerId=')) { 'probe' } else { 'task' }
[IO.File]::WriteAllText((Join-Path $moe "outage-prompt-$n.txt"), $prompt + "`n")
[IO.File]::AppendAllText((Join-Path $moe 'evidence-rpcs.jsonl'), '{"tool":"cli-launch","args":{"n":' + $n + ',"kind":"' + $kind + '"}}' + "`n")
$fails = 3
if ($env:FAKE_OUTAGE_FAILS -match '^\d+$') { $fails = [int]$env:FAKE_OUTAGE_FAILS }
if ($n -le $fails) { exit 1 }
$probeSec = 4
if ($env:FAKE_OUTAGE_PROBE_SEC -match '^\d+$') { $probeSec = [int]$env:FAKE_OUTAGE_PROBE_SEC }
if ($kind -eq 'probe') { Start-Sleep -Seconds $probeSec }
exit 0
'@
                $outageCmd = Join-Path $outageBin 'codex.cmd'
                Set-Content -Path $outageCmd -Encoding ASCII -Value ("@echo off`r`n" +
                    "powershell -NoProfile -ExecutionPolicy Bypass -File `"%~dp0codex-impl.ps1`" %*`r`n" +
                    "exit /b %ERRORLEVEL%`r`n")
                $outageCheck = Join-Path $tempRoot 'outage-check.cjs'
                [IO.File]::WriteAllText($outageCheck, @'
// One scenario AH run (twin: the same checker in postflight.ps1):
//   node outage-check.cjs <run> <exit> <wrapper out> <project dir> <worker id> <MOE_LAUNCH_FAIL_SEC>
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const [run, code, outFile, dir, worker, failSec] = process.argv.slice(2);
const read = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '');
// Windows PowerShell 5.1 seeds the chat file with a BOM and CRLF.
const lines = (file) => read(file).split('\n').map((line) => line.replace(/^\uFEFF/, '').trim()).filter(Boolean);
const out = read(outFile).replace(/\x1b\[[0-9;]*m/g, '');
const rows = lines(path.join(dir, '.moe', 'evidence-rpcs.jsonl')).map((line) => JSON.parse(line));
// c = claim_next_task, L = a task launch, P = a launch probe, k = record_commit (a landing), R = release_task
const seq = rows.map((r) => ({ claim_next_task: 'c', record_commit: 'k', release_task: 'R' })[r.tool]
  || (r.tool === 'cli-launch' ? (r.args.kind === 'probe' ? 'P' : 'L') : '')).join('');
const chat = lines(path.join(dir, '.moe', 'messages', 'chan-general.jsonl')).map((line) => JSON.parse(line).content);
const prompt = (n) => read(path.join(dir, '.moe', `outage-prompt-${n}.txt`));
const has = (text) => assert.ok(out.includes(text), `expected '${text}' in the wrapper output`);
const said = (text) => assert.ok(chat.some((c) => c.includes(text)), `expected a #general line with '${text}'`);
try {
  assert.equal(code, '0', `wrapper exited with ${code}`);
  const releases = rows.filter((r) => r.tool === 'release_task').map((r) => r.args);
  assert.equal(releases.length, 1, `expected exactly one release_task, got ${releases.length}`);
  const [rel] = releases;
  const task = run === 'released' ? 'task-postflight' : 'task-resume';
  assert.equal(rel.taskId, task);
  assert.equal(rel.workerId, worker);
  assert.equal(rel.force, undefined, 'the outage release must never force');
  assert.equal(rel.attemptId, 'attempt-postflight', 'the release must carry the pinned attempt');
  assert.equal(rel.generation, 7);
  const done = rel.handoffNote && rel.handoffNote.whatIsDone;
  assert.ok(typeof done === 'string' && done.startsWith('Seat outage, not a task refusal:'), `whatIsDone: ${done}`);
  // releaseTask.ts isEmptyProgressHandoff: these shapes feed the BACKLOG refusal cascade.
  const lowered = done.trim().toLowerCase();
  assert.ok(!['nothing', 'none', 'n/a', 'na'].includes(lowered) && !/^nothing\b/.test(lowered) && !/^no progress\b/.test(lowered),
    'whatIsDone reads as an empty-progress refusal');
  for (const text of [`exited within ${failSec}s of launch 3 times in a row (last exit code 1)`, 'did no work', 'is untouched']) {
    assert.ok(done.includes(text), `whatIsDone lacks '${text}': ${done}`);
  }
  assert.ok(typeof rel.handoffNote.whatRemains === 'string' && rel.handoffNote.whatRemains.trim(), 'whatRemains is required');
  assert.ok(!chat.some((c) => c.includes('keeps its task; no release needed')), 'the outage line still says the task is kept');
  said(`@governors ${worker}: CLI exits within ${failSec}s of launch (exit 1, 3 in a row)`);
  said('a CLI auto-update dropped a flag the wrapper passes');
  said('this seat claims no new task until a launch probe succeeds (probes back off up to 1s, next in 1s)');
  said('Launch outage over: claiming resumes.');
  has('entering launch outage mode');
  has('launch outage over, claiming resumes.');
  switch (run) {
    case 'released':
      // The landing (k) comes before the release (R); no claim (c) between the
      // release and the probe (P); claiming resumes after the probe.
      assert.equal(seq, 'cLkcLkcLkRPcLk', `RPC sequence ${seq}`);
      said(`Released ${task} for another seat; this seat claims no new task`);
      has(`[launch-outage] Released ${task} for another seat.`);
      has('so it calls no claim_next_task until a launch probe succeeds');
      has(`MOE_LAUNCH_PROBE role=worker worker=${worker} streak=3`);
      has('Backing off 1s before the next launch probe (streak 3); this seat holds no task and claims none until a probe launches.');
      assert.ok(!out.slice(out.indexOf('[launch-outage] Released')).includes('the held task stays held'),
        'a seat that holds no task printed "the held task stays held"');
      for (const text of [`This is a launch probe for workerId=${worker} after repeated launch failures`, 'otherwise reply OK. Then end your turn immediately.',
        'Do NOT call moe.wait_for_task or moe.claim_next_task, edit project files, run task gates, or perform task work in this session']) {
        assert.ok(prompt(4).includes(text), `the probe prompt lacks '${text}'`);
      }
      assert.ok(prompt(5).includes('Task task-postflight is claimed'), 'the launch after the probe must be a claimed task session');
      break;
    case 'refused':
      // The seat still holds the task, so its resumed launch is the probe: the
      // claim runs (alreadyAssigned) and nothing is released twice.
      assert.equal(seq, 'cLkcLkcLkRcLkcLk', `RPC sequence ${seq}`);
      said(`Could not release ${task} (RELEASE_NOT_ASSIGNEE), so this seat still holds it; this seat claims no new task`);
      assert.ok(!out.includes('MOE_LAUNCH_PROBE'), 'a seat that still holds its task resumes it instead of a taskless probe');
      assert.ok(prompt(4).includes(`RESUME: you are workerId ${worker}`), 'the launch after a refused release must resume the held task');
      break;
    default:
      throw new Error(`unknown run ${run}`);
  }
} catch (error) {
  console.error(out);
  console.error(`rpc sequence: ${seq}\nchat: ${JSON.stringify(chat, null, 1)}`);
  console.error(`[scenario AH] ${run}: ${error.message}`);
  process.exit(1);
}
'@, [Text.UTF8Encoding]::new($false))
                $outageFailSec = '10'
                # Invoke-OutageWrapper DIR OUT WORKER_ID [ENV] -- a codex TUI
                # worker (single-shot: neither -Loop nor -NoLoop) with a 10s
                # launch window and 1s backoffs; ENV adds the run's FAKE_* knobs.
                function Invoke-OutageWrapper([string]$dir, [string]$outFile, [string]$workerId, [hashtable]$runEnv = @{}) {
                    foreach ($key in $runEnv.Keys) { Set-Item "Env:$key" $runEnv[$key] }
                    try {
                        return (Invoke-WrapperProcess @('-Project', $dir, '-WorkerId', $workerId, '-Role', 'worker', '-Team', 'Smoke', '-NoStartDaemon', '-Command', $outageCmd, '-Interactive', '-PollInterval', '1') $outFile ($wrapperTimeoutSec * 4))
                    } finally {
                        foreach ($key in $runEnv.Keys) { Remove-Item "Env:$key" -ErrorAction SilentlyContinue }
                    }
                }
                $outagePrevEnv = @{}
                foreach ($name in @('MOE_CODEX_SANDBOX', 'MOE_CODEX_REASONING_EFFORT', 'MOE_DAEMON_HOST', 'MOE_SERENA_PATH', 'MOE_DISABLE_HEARTBEAT',
                        'MOE_LAUNCH_FAIL_SEC', 'MOE_LAUNCH_BACKOFF_BASE_SEC', 'MOE_LAUNCH_BACKOFF_MAX_SEC', 'FAKE_TASK_STATUS', 'FAKE_CLAIM_MODE',
                        'FAKE_CLAIM_LIMIT', 'FAKE_CLAIM_ONCE', 'FAKE_RELEASE_REFUSE', 'FAKE_OUTAGE_FAILS', 'FAKE_OUTAGE_PROBE_SEC')) {
                    $outagePrevEnv[$name] = [Environment]::GetEnvironmentVariable($name)
                    Remove-Item "Env:$name" -ErrorAction SilentlyContinue
                }
                $scopeAH3Proc = $null
                try {
                    $env:MOE_SERENA_PATH = $trueCmd
                    $env:MOE_DISABLE_HEARTBEAT = '1'
                    $env:MOE_LAUNCH_FAIL_SEC = $outageFailSec
                    $env:MOE_LAUNCH_BACKOFF_BASE_SEC = '1'
                    $env:MOE_LAUNCH_BACKOFF_MAX_SEC = '1'
                    $env:FAKE_TASK_STATUS = 'WORKING'
                    $env:FAKE_OUTAGE_PROBE_SEC = '11'
                    $scopeAHDir = Join-Path $tempRoot 'scope-ah'
                    New-ScopeProject $scopeAHDir @() -Status 'WORKING'
                    $scopeAHOut = Join-Path $tempRoot 'scope-ah.out'
                    $scopeAHCode = Invoke-OutageWrapper $scopeAHDir $scopeAHOut 'worker-scope-ah'
                    & node $outageCheck released $scopeAHCode $scopeAHOut $scopeAHDir worker-scope-ah $outageFailSec
                    if ($LASTEXITCODE -ne 0) { throw "SCENARIO AH FAILED: run 1 (released); log $scopeAHOut" }
                    $scopeAH2Dir = Join-Path $tempRoot 'scope-ah2'
                    New-ScopeProject $scopeAH2Dir @() -Status 'WORKING'
                    $scopeAH2Out = Join-Path $tempRoot 'scope-ah2.out'
                    $scopeAH2Code = Invoke-OutageWrapper $scopeAH2Dir $scopeAH2Out 'worker-scope-ah2' @{ FAKE_CLAIM_MODE = 'resume'; FAKE_RELEASE_REFUSE = 'RELEASE_NOT_ASSIGNEE'; FAKE_OUTAGE_FAILS = '4' }
                    & node $outageCheck refused $scopeAH2Code $scopeAH2Out $scopeAH2Dir worker-scope-ah2 $outageFailSec
                    if ($LASTEXITCODE -ne 0) { throw "SCENARIO AH FAILED: run 2 (refused); log $scopeAH2Out" }
                    # Run 3: one fast exit (streak 1, backoff 1s), then idle polls
                    # that launch nothing. The backoff must survive them: the old
                    # classifier read a skipped launch as a launch that ran, zeroed
                    # the streak and went back to idle polls. A looping claude seat,
                    # stopped once its third claim is on record (the second backoff
                    # line comes before it).
                    $outageFailCli = Join-Path $outageBin 'fail-cli.cmd'
                    Set-Content -Path $outageFailCli -Encoding ASCII -Value "@echo off`r`nexit /b 1`r`n"
                    $scopeAH3Dir = Join-Path $tempRoot 'scope-ah3'
                    New-ScopeProject $scopeAH3Dir @() -Status 'WORKING'
                    $scopeAH3Out = Join-Path $tempRoot 'scope-ah3.out'
                    $scopeAH3Rpc = Join-Path $scopeAH3Dir '.moe\evidence-rpcs.jsonl'
                    $env:FAKE_CLAIM_LIMIT = '1'
                    $env:MOE_LAUNCH_FAIL_SEC = '30'
                    $scopeAH3Args = @('-NoProfile', '-File', $wrapper, '-Project', $scopeAH3Dir, '-WorkerId', 'worker-scope-ah3', '-Role', 'worker', '-Team', 'Smoke', '-NoStartDaemon', '-Command', $outageFailCli, '-Loop', '-PollInterval', '1') |
                        ForEach-Object { if ($_ -match '[\s"]') { '"' + ($_ -replace '"', '\"') + '"' } else { $_ } }
                    Remove-Item -LiteralPath $scopeAH3Out, "$scopeAH3Out.err" -Force -ErrorAction SilentlyContinue
                    $scopeAH3Proc = Start-Process -FilePath $psExe -ArgumentList $scopeAH3Args -RedirectStandardOutput $scopeAH3Out -RedirectStandardError "$scopeAH3Out.err" -PassThru -NoNewWindow
                    $null = $scopeAH3Proc.Handle
                    $scopeAH3Deadline = (Get-Date).AddSeconds($wrapperTimeoutSec * 2)
                    while ((Get-Date) -lt $scopeAH3Deadline -and -not $scopeAH3Proc.HasExited) {
                        $scopeAH3Claims = 0
                        try { $scopeAH3Claims = @(Get-Content -LiteralPath $scopeAH3Rpc -ErrorAction Stop | Where-Object { $_ -like '*"tool":"claim_next_task"*' }).Count } catch {}
                        if ($scopeAH3Claims -ge 3) { break }
                        Start-Sleep -Milliseconds 250
                    }
                } finally {
                    if ($scopeAH3Proc -and -not $scopeAH3Proc.HasExited) { & taskkill /T /F /PID $scopeAH3Proc.Id 2>&1 | Out-Null; $scopeAH3Proc.WaitForExit(5000) | Out-Null }
                    foreach ($name in $outagePrevEnv.Keys) {
                        if ($null -ne $outagePrevEnv[$name]) { Set-Item "Env:$name" $outagePrevEnv[$name] }
                        else { Remove-Item "Env:$name" -ErrorAction SilentlyContinue }
                    }
                }
                $scopeAH3Text = [string](Get-Content -Raw -LiteralPath $scopeAH3Out -ErrorAction SilentlyContinue) + [string](Get-Content -Raw -LiteralPath "$scopeAH3Out.err" -ErrorAction SilentlyContinue)
                $scopeAH3Backoffs = ([regex]::Matches($scopeAH3Text, [regex]::Escape('Backing off 1s before relaunching (streak 1)'))).Count
                if (-not $scopeAH3Text.Contains('MOE_TASKLESS_NO_LAUNCH reason=idle')) { Write-Host $scopeAH3Text; throw 'SCENARIO AH FAILED: run 3 never reached a skipped (taskless) launch' }
                if ($scopeAH3Backoffs -lt 2) { Write-Host $scopeAH3Text; throw 'SCENARIO AH FAILED: a skipped launch reset the launch-failure streak and its backoff' }
                if ($scopeAH3Text.Contains('Agent idle, checking for tasks')) { Write-Host $scopeAH3Text; throw 'SCENARIO AH FAILED: a skipped launch read as a launch that ran: the backoff was zeroed and the seat went back to idle polls' }
                $scopeScenariosRun++
                Write-Host '[scenario AH] ok'

                # Scenario AI -- a held contested path reaches record_commit on
                # BOTH nothing landings (task-a2f243a1; twin: scenario AI in
                # postflight.sh). The task's only own path, held.txt, is
                # declared (declaredFiles), dirty BEFORE the pre-flight and
                # declared by a peer too, so it is held and nothing lands:
                #   AI1  completion, skip-untouched -> zero candidates, one declared path: the unchanged-tree nothing
                #   AI2  completion, contested=skip -> same; the strict code names no peer, only `contested` does
                #   AI3  checkpoint, contested=skip -> zero candidates: the no-candidate nothing
                # The last record_commit row carries both lists as JSON arrays
                # (the daemon refuses a non-array, and one held path is the
                # one-element case PS 5.1 can unwrap): skipped names held.txt
                # under the run's code and contested names its peer. The daemon
                # builds its MOE_CONTESTED_HELD task line and #governors alert
                # from them. The console line pins which send ran; only its
                # ASCII part is matched (the redirected child writes the OEM
                # code page).
                Write-Host '[scenario AI] a held contested path reaches record_commit on both nothing landings'
                $aiCheck = Join-Path $tempRoot 'scope-ai-check.cjs'
                [System.IO.File]::WriteAllText($aiCheck, @'
const [f,kind,code]=process.argv.slice(2),assert=require("assert");
const rows=require("fs").readFileSync(f,"utf8").trim().split("\n").map(JSON.parse),r=rows[rows.length-1];
try {
  assert.deepStrictEqual([r.outcome,r.code,r.kind],["nothing","MOE_COMMIT_NOTHING_TO_COMMIT",kind],"last row");
  assert.ok(Array.isArray(r.skipped)&&Array.isArray(r.contested),"skipped and contested must be JSON arrays");
  assert.deepStrictEqual(r.skipped.filter(s=>String(s.code).startsWith("MOE_ATTR_CONTESTED")),[{path:"held.txt",code}],"skipped");
  assert.ok(r.contested.some(c=>c.path==="held.txt"&&c.taskId==="task-peer"),"contested must name held.txt with task-peer");
} catch (e) { console.error(e.message+"\nrow: "+JSON.stringify(r)); process.exit(1); }
'@, (New-Object System.Text.UTF8Encoding($false)))
                foreach ($aiRun in 1..3) {
                    $aiName = "AI$aiRun"
                    $aiDir = Join-Path $tempRoot "scope-ai$aiRun"
                    $aiOut = Join-Path $tempRoot "scope-ai$aiRun.out"
                    $aiStatus = if ($aiRun -eq 3) { 'WORKING' } else { 'REVIEW' }
                    $aiKind = if ($aiRun -eq 3) { 'checkpoint' } else { 'completion' }
                    $aiCode = if ($aiRun -eq 1) { 'MOE_ATTR_CONTESTED_UNTOUCHED(task-peer)' } else { 'MOE_ATTR_CONTESTED' }
                    $aiLine = if ($aiRun -eq 3) { 'no attributable changes to commit' } else { 'the attributable paths already match' }
                    $aiSettings = if ($aiRun -eq 1) { $null } else { @{ attribution = @{ contested = 'skip' } } }
                    New-ScopeProject $aiDir @() -Settings $aiSettings -Status $aiStatus
                    # Literal JSON: PS 5.1's ConvertTo-Json unwraps one-element arrays.
                    [System.IO.File]::WriteAllText((Join-Path $aiDir '.moe\tasks\task-postflight.json'),
                        ('{"id":"task-postflight","title":"Postflight smoke","status":"' + $aiStatus + '","filesModified":[],"declaredFiles":["held.txt"]}'), (New-Object System.Text.UTF8Encoding($false)))
                    & git -C $aiDir commit -qm ai-declared .moe/tasks/task-postflight.json 2>$null | Out-Null
                    [System.IO.File]::WriteAllText((Join-Path $aiDir 'held.txt'), "pre`n", (New-Object System.Text.UTF8Encoding($false)))
                    $aiCommits = (& git -C $aiDir rev-list --all --count 2>$null) -join ''
                    $env:FAKE_SCOPE_DECLARED_FIELD = '1'
                    $env:FAKE_SCOPE_PEERS_ACTIVE = '1'
                    $env:FAKE_SCOPE_PEER_DECLARED = 'held.txt:task-peer'
                    $env:FAKE_SCOPE_PEER_ACTIVE = '1'
                    try {
                        Assert-ScopeRun $aiName (Invoke-GateWrapper $aiDir $aiOut -Status $aiStatus) $aiOut
                    } finally {
                        foreach ($v in 'FAKE_SCOPE_DECLARED_FIELD', 'FAKE_SCOPE_PEERS_ACTIVE', 'FAKE_SCOPE_PEER_DECLARED', 'FAKE_SCOPE_PEER_ACTIVE') { Remove-Item "Env:$v" -ErrorAction SilentlyContinue }
                    }
                    $aiText = Get-Content -Raw -Path $aiOut
                    if (((& git -C $aiDir rev-list --all --count 2>$null) -join '') -ne $aiCommits) { Write-Host $aiText; throw "SCENARIO $aiName FAILED: nothing may be committed" }
                    if (-not (@(& git -C $aiDir status --porcelain 2>$null) -contains '?? held.txt') -or [System.IO.File]::ReadAllText((Join-Path $aiDir 'held.txt')) -ne "pre`n") {
                        Write-Host $aiText; throw "SCENARIO $aiName FAILED: held.txt must stay untracked with its pre-flight bytes"
                    }
                    if (-not $aiText.Contains($aiLine)) { Write-Host $aiText; throw "SCENARIO $aiName FAILED: expected the '$aiLine' landing line" }
                    & node $aiCheck (Join-Path $aiDir '.moe\record_commit.jsonl') $aiKind $aiCode
                    if ($LASTEXITCODE -ne 0) { Write-Host $aiText; throw "SCENARIO $aiName FAILED: the $aiKind nothing row must name held.txt under $aiCode in skipped and its peer in contested" }
                }
                $scopeScenariosRun++
                Write-Host '[scenario AI] ok'

                # Scenario AJ -- held paths survive BOTH peel-failure sends
                # and the rescue row. Twin: postflight.sh (task-dfbda1a8).
                # The ledger must hold EXACTLY the expected rows on both
                # wrappers (AJ2: one failed PEEL row); the finally used to add
                # a second one (task-4fdc7590), so the whole sequence is
                # compared, never a tail of it. AJ2 owns nothing but a TOOL-witnessed
                # held.txt, so its completion refuses NO_OWNED_PATHS and takes
                # the no-candidate peel.
                Write-Host '[scenario AJ] peel failures and rescue records retain held contested paths'
                $ajCli = Join-Path $tempRoot 'aj-cli.cmd'
                Set-Content -Path $ajCli -Encoding ASCII -Value "@echo off`r`necho owned-a-session > `"%MOE_PROJECT_PATH%\owned-a.txt`"`r`nexit /b 0`r`n"
                Set-Content -Path (Join-Path $tempRoot 'aj-tool.jsonl') -Encoding ASCII -Value @'
{"type":"assistant","message":{"content":[{"type":"tool_use","id":"aj-held","name":"mcp__serena__replace_content","input":{"relative_path":"held.txt","needle":"pre","repl":"pre","mode":"literal"}}]}}
{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"aj-held","is_error":false,"content":[{"type":"text","text":"OK"}]}]}}
'@
                $ajToolCli = Join-Path $tempRoot 'aj-tool.cmd'
                Set-Content -Path $ajToolCli -Encoding ASCII -Value "@echo off`r`ntype `"%~dp0aj-tool.jsonl`"`r`nexit /b 0`r`n"
                $ajCheck = Join-Path $tempRoot 'scope-aj-check.cjs'
                [System.IO.File]::WriteAllText($ajCheck, @'
const [f,run]=process.argv.slice(2),assert=require("assert");
const rows=require("fs").readFileSync(f,"utf8").trim().split("\n").map(JSON.parse);
const expected=run==="1"?[["committed","peel-failed","rescue"],["failed","MOE_COMMIT_FAILED_PEEL","completion"]]:[["failed","MOE_COMMIT_FAILED_PEEL","completion"]];
try {
  assert.deepStrictEqual(rows.map(r=>[r.outcome,r.code,r.kind]),expected,"ledger rows: exactly one failed row per landing");
  rows.forEach(r=>{
    const label=[r.outcome,r.code,r.kind].join("/");
    assert.ok(Array.isArray(r.skipped)&&Array.isArray(r.contested),label+": skipped and contested must be JSON arrays");
    assert.deepStrictEqual(r.skipped.filter(s=>String(s.code).startsWith("MOE_ATTR_CONTESTED")),[{path:"held.txt",code:"MOE_ATTR_CONTESTED"}],label+": skipped");
    assert.ok(r.contested.some(c=>c.path==="held.txt"&&c.taskId==="task-peer"),label+": contested must name held.txt with task-peer");
  });
} catch (e) { console.error(e.message+"\nrows: "+JSON.stringify(rows)); process.exit(1); }
'@, (New-Object System.Text.UTF8Encoding($false)))
                foreach ($ajRun in 1..2) {
                    $ajName = "AJ$ajRun"
                    $ajDir = Join-Path $tempRoot "scope-aj$ajRun"
                    $ajOut = Join-Path $tempRoot "scope-aj$ajRun.out"
                    $ajFiles = @(); if ($ajRun -eq 1) { $ajFiles = @('owned-a.txt') }
                    $ajFilesJson = if ($ajRun -eq 1) { '["owned-a.txt"]' } else { '[]' }
                    $ajDeclaredJson = if ($ajRun -eq 1) { '["held.txt"]' } else { '[]' }
                    New-ScopeProject $ajDir $ajFiles -Status 'REVIEW' -Settings @{ attribution = @{ contested = 'skip' } }
                    [System.IO.File]::WriteAllText((Join-Path $ajDir '.moe\tasks\task-postflight.json'),
                        ('{"id":"task-postflight","title":"Postflight smoke","status":"REVIEW","filesModified":' + $ajFilesJson + ',"declaredFiles":' + $ajDeclaredJson + '}'), (New-Object System.Text.UTF8Encoding($false)))
                    & git -C $ajDir commit -qm aj-declared .moe/tasks/task-postflight.json 2>$null | Out-Null
                    [System.IO.File]::WriteAllText((Join-Path $ajDir 'held.txt'), "pre`n", (New-Object System.Text.UTF8Encoding($false)))
                    $ajCmd = $ajToolCli
                    if ($ajRun -eq 1) {
                        Set-Content -Path (Join-Path $ajDir 'owned-a.txt') -Value 'owned-a'
                        # declaredFiles enables the foreign-byte guard: change
                        # this own file in-session so only held.txt stays held.
                        $ajCmd = $ajCli
                    }
                    & git -C $ajDir branch moe 2>$null | Out-Null
                    $ajHead = (& git -C $ajDir rev-parse HEAD 2>$null) -join ''
                    $ajBranch = (& git -C $ajDir symbolic-ref HEAD 2>$null) -join ''
                    $env:FAKE_SCOPE_DECLARED_FIELD = '1'
                    $env:FAKE_SCOPE_PEERS_ACTIVE = '1'
                    $env:FAKE_SCOPE_PEER_DECLARED = 'held.txt:task-peer'
                    $env:FAKE_SCOPE_PEER_ACTIVE = '1'
                    try {
                        Assert-ScopeRun $ajName (Invoke-GateWrapper $ajDir $ajOut -Status 'REVIEW' -Command $ajCmd) $ajOut
                    } finally {
                        foreach ($v in 'FAKE_SCOPE_DECLARED_FIELD', 'FAKE_SCOPE_PEERS_ACTIVE', 'FAKE_SCOPE_PEER_DECLARED', 'FAKE_SCOPE_PEER_ACTIVE') { Remove-Item "Env:$v" -ErrorAction SilentlyContinue }
                    }
                    $ajText = Get-Content -Raw -Path $ajOut
                    if (((& git -C $ajDir rev-parse HEAD 2>$null) -join '') -ne $ajHead -or ((& git -C $ajDir symbolic-ref HEAD 2>$null) -join '') -ne $ajBranch) {
                        Write-Host $ajText; throw "SCENARIO $ajName FAILED: HEAD and branch must not move"
                    }
                    if ([System.IO.File]::ReadAllText((Join-Path $ajDir 'held.txt')) -ne "pre`n") { Write-Host $ajText; throw "SCENARIO $ajName FAILED: held.txt must keep its pre-flight bytes" }
                    if ($ajRun -eq 2 -and $ajText -notmatch 'MOE_COMMIT_REFUSED_NO_OWNED_PATHS') { Write-Host $ajText; throw "SCENARIO $ajName FAILED: must take the no-candidate refused completion peel" }
                    & node $ajCheck (Join-Path $ajDir '.moe\record_commit.jsonl') $ajRun
                    if ($LASTEXITCODE -ne 0) { Write-Host $ajText; throw "SCENARIO $ajName FAILED: peel-failure and rescue rows must retain held paths" }
                    Write-Host "[scenario $ajName] ok"
                }
                $scopeScenariosRun++
                Write-Host '[scenario AJ] ok'

                # Scenario AK -- get_commit_scope's per-path peer lists
                # (task-01f37ac6; twin: postflight.sh, same runs and strings).
                # A peerDeclared entry may carry taskIds (every contesting
                # task) and editingTaskIds (those mid-step on the path with a
                # live session). Under skip-untouched an editing peer holds
                # even the TOOL-witnessed tool-written.txt as
                # MOE_ATTR_CONTESTED_EDITING; every contesting task gets a
                # ledger row and is named in the path's ONE trailer.
                #   AK1  editing [task-peer]        -> held, editing remedy
                #   AK2  editing []                 -> lands, as before
                #   AK3  no fields (older daemon)   -> lands, as before
                #   AK4  taskIds [task-a, task-b]   -> lands, one trailer naming both
                #   AK5  contested=skip, as AK1     -> strict MOE_ATTR_CONTESTED
                #   AK6  contested=commit, as AK1   -> lands
                #   AK7  disk fallback: an IN_PROGRESS peer step holds its path
                #        as EDITING, a PENDING-only path lands naming both
                #        contributors, a declared pre-flight-dirty path is held UNTOUCHED
                Write-Host '[scenario AK] a contesting peer mid-step holds a witnessed path, and every contesting task is named'
                $akUntouched = "verify the bytes are this task's and coordinate any live peer; a held path then lands once a one-shot Claude or codex exec session of this task edits it, once a later session of this task that found it clean at pre-flight edits it while every contesting peer stays idle, or once the stale peer task is completed or archived."
                $akEdit = "the named peer was mid-step on each MOE_ATTR_CONTESTED_EDITING path with a live session, so this session's edit did not release it (the file can carry that peer's unfinished hunks); coordinate that peer and let its step finish, then have a one-shot Claude or codex exec session of this task re-edit the path, or let the peer's own landing carry the bytes."
                $akWitness = "Only a one-shot Claude (claude -p) or codex exec session's editing call (Claude Edit/Write, Codex apply_patch, or a Serena editor) leaves a TOOL witness; a Codex TUI, Gemini, Grok or interactive Claude session's edits, Serena's included, leave none."
                $akNever = 'declare_files, unblocking or a shell touch alone does not release a hold.'
                $akUtf8 = New-Object System.Text.UTF8Encoding($false)
                # postflight.sh's scope_ak_check, reading its expectations from
                # a file: PS 5.1 strips the quotes of a JSON native argument.
                $akCheck = Join-Path $tempRoot 'scope-ak-check.cjs'
                [System.IO.File]::WriteAllText($akCheck, @'
const [dir,out,wantFile]=process.argv.slice(2),assert=require("assert"),fs=require("fs"),path=require("path");
const {skipped,contested,held}=JSON.parse(fs.readFileSync(wantFile,"utf8"));
const rows=fs.readFileSync(path.join(dir,".moe/record_commit.jsonl"),"utf8").trim().split("\n").map(JSON.parse),r=rows[rows.length-1];
const line=fs.readFileSync(path.join(dir,".moe/messages/chan-general.jsonl"),"utf8").trim().split("\n").map(l=>String(JSON.parse(l).content)).filter(s=>s.includes("worker session ended: task=task-postflight")).pop()||"";
const status=require("child_process").execFileSync("git",["-C",dir,"status","--porcelain"],{encoding:"utf8"}).split("\n"),text=fs.readFileSync(out,"utf8");
try {
  assert.deepStrictEqual((r.skipped||[]).filter(s=>String(s.code).startsWith("MOE_ATTR_CONTESTED")),skipped,"skipped");
  assert.deepStrictEqual(r.contested||[],contested,"contested");
  assert.strictEqual(line.includes(" held=")?line.slice(line.indexOf(" held=")):"",held,"held=");
  for (const s of skipped) {
    assert.ok(text.includes("[skip] "+s.path+" "+s.code),"console [skip] "+s.path+" "+s.code);
    assert.ok(status.includes("?? "+s.path),s.path+" must stay untracked");
    assert.strictEqual(fs.readFileSync(path.join(dir,s.path),"utf8").trim(),s.path==="held.txt"?"pre":"tool",s.path+" bytes");
  }
} catch (e) { console.error(e.message+"\nrow: "+JSON.stringify(r)+"\nline: "+line); process.exit(1); }
'@, $akUtf8)
                foreach ($akRun in 1..7) {
                    $akName = "AK$akRun"
                    $akDir = Join-Path $tempRoot "scope-ak$akRun"
                    $akOut = Join-Path $tempRoot "scope-ak$akRun.out"
                    $akSettings = $null; $akPeers = 'tool-written.txt:task-peer'; $akFail = $null
                    $akFields = '{"taskIds":["task-peer"],"editingTaskIds":["task-peer"]}'
                    $akRows = '{"path":"tool-written.txt","taskId":"task-peer"}'
                    $akFiles = 'tool-edited.txt'; $akTrailer = ''
                    $akSkips = '[{"path":"tool-written.txt","code":"MOE_ATTR_CONTESTED_EDITING(task-peer)"}]'
                    $akHeld = " held=tool-written.txt(task-peer) MOE_CONTESTED_HELD remedy: $akEdit $akWitness $akNever"
                    if ($akRun -in 2, 3, 4, 6) {
                        $akFiles = 'tool-edited.txt tool-written.txt'; $akTrailer = 'Moe-Contested: tool-written.txt (task-peer)'
                        $akSkips = '[]'; $akHeld = ''
                    }
                    switch ($akRun) {
                        2 { $akFields = '{"taskIds":["task-peer"],"editingTaskIds":[]}' }
                        3 { $akFields = $null }
                        4 {
                            $akPeers = 'tool-written.txt:task-a'; $akFields = '{"taskIds":["task-a","task-b"],"editingTaskIds":[]}'
                            $akTrailer = 'Moe-Contested: tool-written.txt (task-a, task-b)'
                            $akRows = '{"path":"tool-written.txt","taskId":"task-a"},{"path":"tool-written.txt","taskId":"task-b"}'
                        }
                        5 {
                            $akSettings = @{ attribution = @{ contested = 'skip' } }
                            $akSkips = '[{"path":"tool-written.txt","code":"MOE_ATTR_CONTESTED"}]'
                            $akHeld = " held=tool-written.txt(task-peer) MOE_CONTESTED_HELD remedy: attribution.contested=skip holds these paths whatever this session edits; only resolving, completing or archiving the peer task releases them. $akNever"
                        }
                        6 { $akSettings = @{ attribution = @{ contested = 'commit' } } }
                        7 {
                            $akPeers = $null; $akFields = $null; $akFail = '1'
                            $akTrailer = 'Moe-Contested: tool-edited.txt (task-peer, task-peer2)'
                            $akSkips = '[{"path":"held.txt","code":"MOE_ATTR_CONTESTED_UNTOUCHED(task-peer2)"},{"path":"tool-written.txt","code":"MOE_ATTR_CONTESTED_EDITING(task-peer)"}]'
                            $akRows = '{"path":"held.txt","taskId":"task-peer2"},{"path":"tool-edited.txt","taskId":"task-peer"},{"path":"tool-edited.txt","taskId":"task-peer2"},' + $akRows
                            $akHeld = " held=held.txt(task-peer2),tool-written.txt(task-peer) MOE_CONTESTED_HELD remedy: $akUntouched $akEdit $akWitness $akNever"
                        }
                    }
                    New-ScopeProject $akDir @('tool-written.txt') -Settings $akSettings
                    if ($akRun -eq 7) {
                        # The fallback owner guard lands only a task the record
                        # assigns to this seat. Literal JSON: PS 5.1's
                        # ConvertTo-Json unwraps one-element arrays.
                        $akTasks = Join-Path $akDir '.moe\tasks'
                        [System.IO.File]::WriteAllText((Join-Path $akTasks 'task-postflight.json'), '{"id":"task-postflight","title":"Postflight smoke","status":"REVIEW","assignedWorkerId":"worker-gate","filesModified":["tool-written.txt"],"declaredFiles":["held.txt"]}', $akUtf8)
                        [System.IO.File]::WriteAllText((Join-Path $akTasks 'task-peer.json'), '{"id":"task-peer","status":"WORKING","implementationPlan":[{"status":"IN_PROGRESS","affectedFiles":["tool-written.txt"]},{"status":"PENDING","affectedFiles":["tool-edited.txt"]}]}', $akUtf8)
                        [System.IO.File]::WriteAllText((Join-Path $akTasks 'task-peer2.json'), '{"id":"task-peer2","status":"WORKING","implementationPlan":[{"status":"PENDING","affectedFiles":["tool-edited.txt","held.txt"]}]}', $akUtf8)
                        & git -C $akDir add .moe/tasks 2>$null | Out-Null
                        & git -C $akDir commit -qm ak-records 2>$null | Out-Null
                        [System.IO.File]::WriteAllText((Join-Path $akDir 'held.txt'), "pre`n", $akUtf8)
                    }
                    $akEnv = @{ FAKE_SCOPE_DECLARED_FIELD = '1'; FAKE_SCOPE_PEERS_ACTIVE = '1'; FAKE_SCOPE_PEER_ACTIVE = '1'
                        FAKE_SCOPE_PEER_DECLARED = $akPeers; FAKE_SCOPE_PEER_FIELDS = $akFields; FAKE_SCOPE_FAIL = $akFail }
                    foreach ($v in $akEnv.Keys) { if ($akEnv[$v]) { Set-Item -Path "Env:$v" -Value $akEnv[$v] } }
                    try {
                        Assert-ScopeRun $akName (Invoke-GateWrapper $akDir $akOut -Command $streamJsonCmd) $akOut
                    } finally {
                        foreach ($v in $akEnv.Keys) { Remove-Item "Env:$v" -ErrorAction SilentlyContinue }
                    }
                    $akText = Get-Content -Raw -Path $akOut
                    if ((Get-CommittedPaths $akDir) -ne $akFiles) { Write-Host $akText; throw "SCENARIO $akName FAILED: expected [$akFiles] committed; got [$(Get-CommittedPaths $akDir)]" }
                    $akGot = (@(& git -C $akDir log -1 --format=%B 2>$null) | Where-Object { $_ -like 'Moe-Contested:*' }) -join '|'
                    if ($akGot -ne $akTrailer) { Write-Host $akText; throw "SCENARIO $akName FAILED: expected the trailers [$akTrailer]; got [$akGot]" }
                    $akWant = Join-Path $tempRoot "scope-ak$akRun.want.json"
                    [System.IO.File]::WriteAllText($akWant, ('{"skipped":' + $akSkips + ',"contested":[' + $akRows + '],"held":' + (ConvertTo-Json $akHeld) + '}'), $akUtf8)
                    & node $akCheck $akDir $akOut $akWant
                    if ($LASTEXITCODE -ne 0) { Write-Host $akText; throw "SCENARIO $akName FAILED: ledger, held= line or held paths differ" }
                }
                $scopeScenariosRun++
                Write-Host '[scenario AK] ok'

                # Scenario AL -- a hold names the peer that caused it
                # (task-9d277494; twin: postflight.sh, same runs and strings).
                # Contesting tasks are named in cause order: editingTaskIds,
                # then activeTaskIds, then the rest, each in taskIds order.
                # That order drives the UNTOUCHED code, held=, every contested
                # row and the trailer; which paths land is unchanged. held.txt
                # is declared and dirty at pre-flight; the witnessed
                # tool-written.txt lands under skip-untouched.
                #   AL1  idle task-a first, active task-b      -> held.txt(task-b), trailer (task-b, task-a)
                #   AL2  contested=skip, as AL1                -> both held, strict label task-b
                #   AL3  no activeTaskIds (older daemon)       -> task-a, as before
                #   AL4  contested=skip, editing c, active b+c -> c, b, a
                Write-Host '[scenario AL] a contested hold names the peer that caused it: editing, then active, then idle'
                foreach ($alRun in 1..4) {
                    $alName = "AL$alRun"
                    $alDir = Join-Path $tempRoot "scope-al$alRun"
                    $alOut = Join-Path $tempRoot "scope-al$alRun.out"
                    $alFields = '{"taskIds":["task-a","task-b"],"activeTaskIds":["task-b"],"editingTaskIds":[]}'
                    $alOrder = @('task-b', 'task-a')
                    if ($alRun -eq 3) { $alFields = '{"taskIds":["task-a","task-b"]}'; $alOrder = @('task-a', 'task-b') }
                    if ($alRun -eq 4) { $alFields = '{"taskIds":["task-a","task-b","task-c"],"activeTaskIds":["task-b","task-c"],"editingTaskIds":["task-c"]}'; $alOrder = @('task-c', 'task-b', 'task-a') }
                    $alHead = $alOrder[0]
                    $alRows = (@('held.txt', 'tool-written.txt') | ForEach-Object { $alP = $_; $alOrder | ForEach-Object { '{"path":"' + $alP + '","taskId":"' + $_ + '"}' } }) -join ','
                    if ($alRun -in 2, 4) {
                        $alSettings = @{ attribution = @{ contested = 'skip' } }; $alFiles = 'tool-edited.txt'; $alTrailer = ''
                        $alSkips = '[{"path":"held.txt","code":"MOE_ATTR_CONTESTED"},{"path":"tool-written.txt","code":"MOE_ATTR_CONTESTED"}]'
                        $alHeld = " held=held.txt($alHead),tool-written.txt($alHead) $agStrict"
                    } else {
                        $alSettings = $null; $alFiles = 'tool-edited.txt tool-written.txt'
                        $alTrailer = "Moe-Contested: tool-written.txt ($($alOrder -join ', '))"
                        $alSkips = '[{"path":"held.txt","code":"MOE_ATTR_CONTESTED_UNTOUCHED(' + $alHead + ')"}]'
                        $alHeld = " held=held.txt($alHead) $agUntouched"
                    }
                    New-ScopeProject $alDir @('tool-written.txt') -Settings $alSettings
                    # Literal JSON: PS 5.1's ConvertTo-Json unwraps one-element arrays.
                    [System.IO.File]::WriteAllText((Join-Path $alDir '.moe\tasks\task-postflight.json'), '{"id":"task-postflight","title":"Postflight smoke","status":"REVIEW","filesModified":["tool-written.txt"],"declaredFiles":["held.txt"]}', $akUtf8)
                    & git -C $alDir commit -qm al-declared .moe/tasks/task-postflight.json 2>$null | Out-Null
                    [System.IO.File]::WriteAllText((Join-Path $alDir 'held.txt'), "pre`n", $akUtf8)
                    $alEnv = @{ FAKE_SCOPE_DECLARED_FIELD = '1'; FAKE_SCOPE_PEERS_ACTIVE = '1'; FAKE_SCOPE_PEER_ACTIVE = '1'
                        FAKE_SCOPE_PEER_DECLARED = 'held.txt:task-a,tool-written.txt:task-a'; FAKE_SCOPE_PEER_FIELDS = $alFields }
                    foreach ($v in $alEnv.Keys) { Set-Item -Path "Env:$v" -Value $alEnv[$v] }
                    try {
                        Assert-ScopeRun $alName (Invoke-GateWrapper $alDir $alOut -Command $streamJsonCmd) $alOut
                    } finally {
                        foreach ($v in $alEnv.Keys) { Remove-Item "Env:$v" -ErrorAction SilentlyContinue }
                    }
                    $alText = Get-Content -Raw -Path $alOut
                    if ((Get-CommittedPaths $alDir) -ne $alFiles) { Write-Host $alText; throw "SCENARIO $alName FAILED: expected [$alFiles] committed; got [$(Get-CommittedPaths $alDir)]" }
                    $alGot = (@(& git -C $alDir log -1 --format=%B 2>$null) | Where-Object { $_ -like 'Moe-Contested:*' }) -join '|'
                    if ($alGot -ne $alTrailer) { Write-Host $alText; throw "SCENARIO $alName FAILED: expected the trailers [$alTrailer]; got [$alGot]" }
                    $alWant = Join-Path $tempRoot "scope-al$alRun.want.json"
                    [System.IO.File]::WriteAllText($alWant, ('{"skipped":' + $alSkips + ',"contested":[' + $alRows + '],"held":' + (ConvertTo-Json $alHeld) + '}'), $akUtf8)
                    & node $akCheck $alDir $alOut $alWant
                    if ($LASTEXITCODE -ne 0) { Write-Host $alText; throw "SCENARIO $alName FAILED: ledger, held= line or held paths differ" }
                }
                $scopeScenariosRun++
                Write-Host '[scenario AL] ok'

                # Scenario AM -- a codex exec seat's --json stream feeds the
                # TOOL tier (task-7db14e2d; twin: postflight.sh, same runs and
                # strings). A codex.cmd front in its own directory rewrites
                # sub\held.txt in every run, then prints one item.completed
                # event shaped like prompt-cache-witness.test.mjs's captures.
                # sub/held.txt is own, dirty at pre-flight and declared by a
                # LIVE peer, so only a witness releases it. The Serena root is
                # sub\, so AM3 also proves MOE_SERENA_PROJECT_ROOT reaches the
                # helper. A worker defaults to codex exec.
                #   AM1  completed file_change of held.txt      -> lands, trailer, touchedPaths [sub/held.txt]
                #   AM2  failed file_change                     -> held UNTOUCHED, touchedPaths []
                #   AM3  completed Serena replace_content 'OK'  -> lands, as AM1
                #   AM4  failed Serena replace_content          -> held, as AM2
                #   AM5  completed file_change outside the repo -> held, as AM2, plus the helper's WARN
                Write-Host "[scenario AM] a codex exec seat's completed file_change or Serena edit witnesses its path; a failed or outside one does not"
                $amBin = Join-Path $tempRoot 'codex-witness'
                New-Item -ItemType Directory -Force -Path $amBin | Out-Null
                Set-Content -Path (Join-Path $amBin 'codex-impl.ps1') -Encoding ASCII -Value @'
[IO.File]::WriteAllText((Join-Path $env:MOE_PROJECT_PATH 'sub\held.txt'), "codex`n")
$env:FAKE_CODEX_STREAM.Replace('@ROOT@', ($env:MOE_PROJECT_PATH -replace '\\', '/'))
'{"type":"turn.completed","usage":{"input_tokens":48023,"cached_input_tokens":38912,"cache_write_input_tokens":0,"output_tokens":132,"reasoning_output_tokens":0}}'
exit 0
'@
                $amCmd = Join-Path $amBin 'codex.cmd'
                Set-Content -Path $amCmd -Encoding ASCII -Value ("@echo off`r`n" +
                    "powershell -NoProfile -ExecutionPolicy Bypass -File `"%~dp0codex-impl.ps1`" %*`r`n" +
                    "exit /b %ERRORLEVEL%`r`n")
                $amOutside = ($tempRoot -replace '\\', '/') + '/am-outside.txt'
                function Get-AmChange([string]$p, [string]$s) { '{"type":"item.completed","item":{"id":"item_1","type":"file_change","changes":[{"path":"' + $p + '","kind":"update"}],"status":"' + $s + '"}}' }
                $amSerena = '{"type":"item.completed","item":{"id":"item_2","type":"mcp_tool_call","server":"serena","tool":"replace_content","arguments":{"relative_path":"held.txt","needle":"pre","repl":"codex","mode":"literal"},'
                $amRuns = @(
                    @{ Name = 'AM1'; Lands = $true; Stream = (Get-AmChange '@ROOT@/sub/held.txt' 'completed') },
                    @{ Name = 'AM2'; Lands = $false; Stream = (Get-AmChange '@ROOT@/sub/held.txt' 'failed') },
                    @{ Name = 'AM3'; Lands = $true; Stream = ($amSerena + '"result":{"content":[{"type":"text","text":"OK"}],"structured_content":{"result":"OK"}},"error":null,"status":"completed"}}') },
                    @{ Name = 'AM4'; Lands = $false; Stream = ($amSerena + '"result":{"content":[{"type":"text","text":"Error executing tool replace_content: ValueError: No matches of the needle were found [trimmed]"}],"structured_content":null},"error":null,"status":"failed"}}') },
                    @{ Name = 'AM5'; Lands = $false; Stream = (Get-AmChange $amOutside 'completed') }
                )
                foreach ($am in $amRuns) {
                    $amName = $am.Name
                    $amDir = Join-Path $tempRoot "scope-$($amName.ToLower())"
                    $amOut = Join-Path $tempRoot "scope-$($amName.ToLower()).out"
                    New-ScopeProject $amDir @('owned-a.txt', 'sub/held.txt')
                    New-Item -ItemType Directory -Force -Path (Join-Path $amDir 'sub') | Out-Null
                    [IO.File]::WriteAllText((Join-Path $amDir 'owned-a.txt'), "owned-a`n")
                    [IO.File]::WriteAllText((Join-Path $amDir 'sub\held.txt'), "pre`n")
                    $amEnv = @{ FAKE_SCOPE_PEERS_ACTIVE = '1'; FAKE_SCOPE_PEER_DECLARED = 'sub/held.txt:task-peer'; FAKE_SCOPE_PEER_ACTIVE = '1'
                        MOE_SERENA_PROJECT = (Join-Path $amDir 'sub'); MOE_DISABLE_ARGV_PROBE = '1'; FAKE_CODEX_STREAM = $am.Stream }
                    foreach ($v in $amEnv.Keys) { Set-Item -Path "Env:$v" -Value $amEnv[$v] }
                    try {
                        Assert-ScopeRun $amName (Invoke-GateWrapper $amDir $amOut -Command $amCmd -WorkerId 'worker-scope-am') $amOut
                    } finally {
                        foreach ($v in $amEnv.Keys) { Remove-Item "Env:$v" -ErrorAction SilentlyContinue }
                    }
                    $amText = Get-Content -Raw -Path $amOut
                    $amPaths = Get-CommittedPaths $amDir
                    $amTrailers = (@(& git -C $amDir log -1 --format=%B 2>$null) | Where-Object { $_ -like 'Moe-Contested:*' }) -join '|'
                    $amRow = Get-Content -Encoding UTF8 -Path (Join-Path $amDir '.moe\record_commit.jsonl') | Where-Object { $_ } | Select-Object -Last 1 | ConvertFrom-Json
                    $amTouched = (@($amRow.touchedPaths) | Where-Object { $_ }) -join '|'
                    $amSkips = (@($amRow.skipped) | Where-Object { $_ -and ([string]$_.code).StartsWith('MOE_ATTR_CONTESTED') } | ForEach-Object { "$($_.path)=$($_.code)" }) -join '|'
                    $amLine = [string](Get-Content -Encoding UTF8 -Path (Join-Path $amDir '.moe\messages\chan-general.jsonl') |
                        Where-Object { $_ -like '*worker session ended: task=task-postflight*' } | Select-Object -Last 1 | ConvertFrom-Json).content
                    if ($am.Lands) {
                        if ($amPaths -ne 'owned-a.txt sub/held.txt') { Write-Host $amText; throw "SCENARIO $amName FAILED: a witnessed contested path must land; got [$amPaths]" }
                        if ((& git -C $amDir rev-parse HEAD:sub/held.txt 2>$null) -ne (& git -C $amDir hash-object sub/held.txt 2>$null)) { Write-Host $amText; throw "SCENARIO $amName FAILED: the codex session's bytes of sub/held.txt must land" }
                        if ($amTrailers -ne 'Moe-Contested: sub/held.txt (task-peer)') { Write-Host $amText; throw "SCENARIO $amName FAILED: expected one Moe-Contested trailer for sub/held.txt; got [$amTrailers]" }
                        if ($amText.Contains('[skip] sub/held.txt')) { Write-Host $amText; throw "SCENARIO $amName FAILED: sub/held.txt must not be skipped" }
                        if ($amTouched -ne 'sub/held.txt' -or $amSkips) { Write-Host $amText; throw "SCENARIO $amName FAILED: record_commit touchedPaths must be exactly the witnessed path; got [$amTouched], skipped [$amSkips]" }
                        if (-not $amLine -or $amLine -like '* held=*' -or $amLine -like '*MOE_CONTESTED_HELD*') { Write-Host $amText; throw "SCENARIO $amName FAILED: nothing was held, so no held= suffix or remedy; got [$amLine]" }
                        continue
                    }
                    if ($amPaths -ne 'owned-a.txt') { Write-Host $amText; throw "SCENARIO $amName FAILED: an unwitnessed contested path must stay out; got [$amPaths]" }
                    if (-not $amText.Contains('[skip] sub/held.txt MOE_ATTR_CONTESTED_UNTOUCHED(task-peer)')) { Write-Host $amText; throw "SCENARIO $amName FAILED: expected '[skip] sub/held.txt MOE_ATTR_CONTESTED_UNTOUCHED(task-peer)'" }
                    if (@(& git -C $amDir status --porcelain -uall 2>$null) -notcontains '?? sub/held.txt') { Write-Host $amText; throw "SCENARIO $amName FAILED: sub/held.txt must stay untracked" }
                    if ($amTrailers) { Write-Host $amText; throw "SCENARIO $amName FAILED: a held path gets no Moe-Contested trailer; got [$amTrailers]" }
                    if ($amTouched -or $amSkips -ne 'sub/held.txt=MOE_ATTR_CONTESTED_UNTOUCHED(task-peer)') { Write-Host $amText; throw "SCENARIO $amName FAILED: record_commit must carry no touchedPaths and the UNTOUCHED skip; got [$amTouched], skipped [$amSkips]" }
                    if ($amName -eq 'AM5' -and -not $amText.Contains("[WARN] tool write outside the repo not harvested: $amOutside")) { Write-Host $amText; throw "SCENARIO AM5 FAILED: expected the helper's WARN naming $amOutside" }
                    if (-not $amLine.EndsWith(" held=sub/held.txt(task-peer) $agUntouched", [System.StringComparison]::Ordinal)) {
                        Write-Host $amText; throw "SCENARIO $amName FAILED: the session-ended line must end with held=sub/held.txt(task-peer) and the untouched remedy; got [$amLine]"
                    }
                }
                $scopeScenariosRun++
                Write-Host '[scenario AM] ok'

                # A harness that silently generated zero scenarios exits 0 and
                # reads as green.
                Write-Host "commit-scope scenarios run: $scopeScenariosRun"
                $scopeExpectedRuns = 45
                if ($symlinksOk) { $scopeExpectedRuns = 46 }
                if ($scopeScenariosRun -ne $scopeExpectedRuns) {
                    throw "Expected $scopeExpectedRuns commit-scope scenarios (A-V, K2, L2, M2, M3, M4, P2, X-Z, AA, AB, AB2, AB3, AC, AD, AE (needs symlinks), AF, AG, AH, AI, AJ, AK, AL, AM); ran $scopeScenariosRun"
                }

                $gateFailCommits = [int](& git -C $gateFailDir rev-list --count HEAD 2>$null)
                $gateFailRescueRefs = @(Get-RescueRefs $gateFailDir)
                $gateTruncCommits = [int](& git -C $gateTruncDir rev-list --count HEAD 2>$null)
                $gateLookupCommits = [int](& git -C $gateLookupDir rev-list --count HEAD 2>$null)
                $gateLookupSubject = Get-HeadSubject $gateLookupDir
                $gateMismatchCommits = [int](& git -C $gateMismatchDir rev-list --count HEAD 2>$null)
                $gateMismatchSubject = Get-HeadSubject $gateMismatchDir
                $gateLookupMessages = Get-Content -Raw -Path (Join-Path $gateLookupDir '.moe\messages\chan-general.jsonl')
                $gatePassCommits = [int](& git -C $gatePassDir rev-list --count HEAD 2>$null)
                $gateSkipCommits = [int](& git -C $gateSkipDir rev-list --count HEAD 2>$null)
                $gateMidCommits = [int](& git -C $gateMidDir rev-list --count HEAD 2>$null)
                $gateDaemonMidCommits = [int](& git -C $gateDaemonMidDir rev-list --count HEAD 2>$null)
                $gateDaemonFinalCommits = [int](& git -C $gateDaemonFinalDir rev-list --count HEAD 2>$null)
                $gateFailMessages = Get-Content -Raw -Path (Join-Path $gateFailDir '.moe\messages\chan-general.jsonl')
            } finally {
                Remove-Item Env:FAKE_TASK_STATUS -ErrorAction SilentlyContinue
            }
        }
    } finally {
        $ErrorActionPreference = $prevEap
        $env:MOE_PROXY_PATH = $oldProxy
        $env:USERPROFILE = $oldUserProfile
        $env:TEMP = $oldTemp
    }
    if ($wrapperCode -ne 0) {
        Get-Content $wrapperOut -ErrorAction SilentlyContinue | ForEach-Object { Write-Error $_ }
        throw "Wrapper exited with $wrapperCode"
    }
    if ($resumeCode -ne 0) {
        Get-Content $wrapperResumeOut -ErrorAction SilentlyContinue | ForEach-Object { Write-Error $_ }
        throw "Resume wrapper exited with $resumeCode"
    }
    if ($heartbeatWrapperCode -ne 0) {
        Get-Content $wrapperHeartbeatOut -ErrorAction SilentlyContinue | ForEach-Object { Write-Error $_ }
        throw "Heartbeat wrapper exited with $heartbeatWrapperCode"
    }
    if ($countAtExit -lt 2) {
        Get-Content $wrapperHeartbeatOut -ErrorAction SilentlyContinue | ForEach-Object { Write-Error $_ }
        throw "Expected the heartbeat sidecar to ping at least twice during a ~5s silent CLI step; got $countAtExit"
    }
    if ($countAfterWait -ne $countAtExit) {
        throw "Heartbeat sidecar kept pinging ($countAfterWait calls) after the wrapper exited ($countAtExit at exit) - Stop-HeartbeatSidecar cleanup failed"
    }
    $identityLine = [string]@(Get-Content -LiteralPath $wrapperHeartbeatOut | Where-Object { $_ -like 'Runner identity: processStartedAt=*' })[0]
    $expectedIdentity = if ($identityLine -match '^Runner identity: processStartedAt=(.+) host=(.+)$') { "$($Matches[1])`n$($Matches[2])" } else { '' }
    $seenIdentity = @(Get-Content -LiteralPath $slowRunnerEnv -ErrorAction SilentlyContinue) -join "`n"
    if (-not $expectedIdentity -or $seenIdentity -cne $expectedIdentity) {
        Get-Content $wrapperHeartbeatOut -ErrorAction SilentlyContinue | ForEach-Object { Write-Error $_ }
        throw "Expected the QA CLI to get the wrapper's runner identity ($identityLine); it saw: $seenIdentity"
    }

    # Post-flight no longer writes a session-summary file (cross-session memory
    # moved to Serena). The post-flight chat message remains the session signal;
    # it now carries the landing summary after the CLI exit code.
    $messagesFile = Join-Path $projectDir '.moe\messages\chan-general.jsonl'
    $messages = Get-Content -Raw -Path $messagesFile
    if ($messages -notlike '*worker session ended: task=task-postflight (CLI exit=0)*') {
        throw 'Expected post-flight chat message not found'
    }
    if ($messages -notlike '*worker session ended: task=task-postflight (CLI exit=0) commit=none kind=none*') {
        Write-Host $messages
        throw 'Expected the session-ended line to carry the commit=<sha|none> kind=<k> landing summary'
    }
    # The quiet half of the same decision: this run's task resolves cleanly to a
    # non-REVIEW status, which is a legitimate no-op. It must NOT be reported as
    # a failed lookup — collapsing those two back together is what hid the defect.
    if ((Get-Content -Raw -Path $wrapperOut) -like '*post-flight status lookup failed*') {
        Get-Content $wrapperOut -ErrorAction SilentlyContinue | ForEach-Object { Write-Error $_ }
        throw 'A resolved non-REVIEW status must stay a quiet no-op, not warn as a lookup failure'
    }
    # autoCommit=false is no longer silent: the skip is logged.
    if ((Get-Content -Raw -Path $wrapperOut) -notlike '*settings.autoCommit=false*') {
        Get-Content $wrapperOut -ErrorAction SilentlyContinue | ForEach-Object { Write-Error $_ }
        throw 'Expected an [info] line naming settings.autoCommit=false'
    }

    $resumeOutText = Get-Content -Raw -Path $wrapperResumeOut
    if ($resumeOutText -notlike '*Pre-flight complete. Resuming: task-resume*') {
        Write-Host $resumeOutText
        throw 'Expected resume pre-flight banner not found'
    }
    if ($messages -notlike '*qa session ended: task=task-resume (CLI exit=0)*') {
        throw 'Expected resume post-flight chat message not found'
    }

    if ($gateAvailable) {
        if ($gateFailCode -ne 0) {
            Get-Content $wrapperGateFailOut -ErrorAction SilentlyContinue | ForEach-Object { Write-Error $_ }
            throw "Gate-fail wrapper exited with $gateFailCode"
        }
        if ((Get-Content -Raw -Path $wrapperGateFailOut) -notlike '*qualityGate failed (exit 3)*') {
            Get-Content $wrapperGateFailOut -ErrorAction SilentlyContinue | ForEach-Object { Write-Error $_ }
            throw 'Expected qualityGate failure log not found'
        }
        if ($gateFailCommits -ne 1) {
            throw "Failing qualityGate must block the branch commit (found $gateFailCommits commits)"
        }
        if ($gateFailRescueRefs.Count -ne 1) {
            Get-Content $wrapperGateFailOut -ErrorAction SilentlyContinue | ForEach-Object { Write-Error $_ }
            throw "Failing qualityGate must park the work on exactly one rescue ref (found $($gateFailRescueRefs.Count))"
        }
        if ((Get-Content -Raw -Path $wrapperGateFailOut) -notlike '*MOE_RESCUE_REF task=task-postflight*reason=gate-failed*') {
            Get-Content $wrapperGateFailOut -ErrorAction SilentlyContinue | ForEach-Object { Write-Error $_ }
            throw 'Expected the MOE_RESCUE_REF log line after a gate failure'
        }
        if ($gateFailMessages -notlike '*PUSH-BLOCKED: qualityGate failed for task task-postflight*') {
            Write-Host $gateFailMessages
            throw 'Expected PUSH-BLOCKED chat message not found'
        }
        if ($gatePassCode -ne 0) {
            Get-Content $wrapperGatePassOut -ErrorAction SilentlyContinue | ForEach-Object { Write-Error $_ }
            throw "Gate-pass wrapper exited with $gatePassCode"
        }
        if ((Get-Content -Raw -Path $wrapperGatePassOut) -notlike '*qualityGate passed*') {
            Get-Content $wrapperGatePassOut -ErrorAction SilentlyContinue | ForEach-Object { Write-Error $_ }
            throw 'Expected qualityGate pass log not found'
        }
        if ($gatePassCommits -ne 2) {
            Get-Content $wrapperGatePassOut -ErrorAction SilentlyContinue | ForEach-Object { Write-Error $_ }
            throw "Passing qualityGate should allow the auto-commit (found $gatePassCommits commits)"
        }
        if ($gateSkipCode -ne 0) {
            Get-Content $wrapperGateSkipOut -ErrorAction SilentlyContinue | ForEach-Object { Write-Error $_ }
            throw "Gate-skip wrapper exited with $gateSkipCode"
        }
        if ($gateSkipCommits -ne 2) {
            Get-Content $wrapperGateSkipOut -ErrorAction SilentlyContinue | ForEach-Object { Write-Error $_ }
            throw "MOE_DISABLE_QUALITY_GATE=1 should skip the gate and allow the commit (found $gateSkipCommits commits)"
        }
        if ($gateMidCode -ne 0) {
            Get-Content $wrapperGateMidOut -ErrorAction SilentlyContinue | ForEach-Object { Write-Error $_ }
            throw "Gate-midepic wrapper exited with $gateMidCode"
        }
        if ((Get-Content -Raw -Path $wrapperGateMidOut) -notlike '*qualityGate deferred*') {
            Get-Content $wrapperGateMidOut -ErrorAction SilentlyContinue | ForEach-Object { Write-Error $_ }
            throw 'Expected mid-epic qualityGate deferral log not found'
        }
        if ($gateMidCommits -ne 2) {
            Get-Content $wrapperGateMidOut -ErrorAction SilentlyContinue | ForEach-Object { Write-Error $_ }
            throw "Mid-epic task should commit without running the gate (found $gateMidCommits commits)"
        }
        if ($gateDaemonMidCode -ne 0) {
            Get-Content $wrapperGateDaemonMidOut -ErrorAction SilentlyContinue | ForEach-Object { Write-Error $_ }
            throw "Gate-daemonmid wrapper exited with $gateDaemonMidCode"
        }
        if ((Get-Content -Raw -Path $wrapperGateDaemonMidOut) -notlike '*qualityGate deferred*') {
            Get-Content $wrapperGateDaemonMidOut -ErrorAction SilentlyContinue | ForEach-Object { Write-Error $_ }
            throw 'A daemon isEpicFinal=false must defer the gate even when the sibling page would say epic-final'
        }
        if ($gateDaemonMidCommits -ne 2) {
            Get-Content $wrapperGateDaemonMidOut -ErrorAction SilentlyContinue | ForEach-Object { Write-Error $_ }
            throw "Daemon-deferred gate must not block the commit (found $gateDaemonMidCommits commits)"
        }
        if ($gateDaemonFinalCode -ne 0) {
            Get-Content $wrapperGateDaemonFinalOut -ErrorAction SilentlyContinue | ForEach-Object { Write-Error $_ }
            throw "Gate-daemonfinal wrapper exited with $gateDaemonFinalCode"
        }
        if ((Get-Content -Raw -Path $wrapperGateDaemonFinalOut) -notlike '*qualityGate failed (exit 3)*') {
            Get-Content $wrapperGateDaemonFinalOut -ErrorAction SilentlyContinue | ForEach-Object { Write-Error $_ }
            throw 'A daemon isEpicFinal=true must run the gate even when the sibling page says mid-epic'
        }
        if ($gateDaemonFinalCommits -ne 1) {
            Get-Content $wrapperGateDaemonFinalOut -ErrorAction SilentlyContinue | ForEach-Object { Write-Error $_ }
            throw "The daemon-final failing gate must block the commit (found $gateDaemonFinalCommits commits)"
        }
        if ($gateTruncCode -ne 0) {
            Get-Content $wrapperGateTruncOut -ErrorAction SilentlyContinue | ForEach-Object { Write-Error $_ }
            throw "Gate-truncated wrapper exited with $gateTruncCode"
        }
        if ($gateTruncCommits -ne 2) {
            Get-Content $wrapperGateTruncOut -ErrorAction SilentlyContinue | ForEach-Object { Write-Error $_ }
            throw "A truncated list_tasks page must NOT stop the auto-commit: the REVIEW status has to be resolved by exact task-id lookup (found $gateTruncCommits commits)"
        }
        if ($gateLookupCode -ne 0) {
            Get-Content $wrapperGateLookupOut -ErrorAction SilentlyContinue | ForEach-Object { Write-Error $_ }
            throw "Gate-lookupfail wrapper exited with $gateLookupCode"
        }
        if ((Get-Content -Raw -Path $wrapperGateLookupOut) -notlike '*post-flight status lookup failed for task task-postflight*') {
            Get-Content $wrapperGateLookupOut -ErrorAction SilentlyContinue | ForEach-Object { Write-Error $_ }
            throw 'Expected a [WARN] naming the task when the post-flight status lookup fails'
        }
        if ($gateLookupMessages -notlike '*PUSH-BLOCKED: post-flight status lookup failed for task task-postflight*') {
            Write-Host $gateLookupMessages
            throw 'Expected a chat escalation when the post-flight status lookup fails'
        }
        # Updated expectation (scenario V): the id is certain, so the work still
        # lands — as a status=UNKNOWN checkpoint, never as a completion.
        if ($gateLookupCommits -ne 2 -or $gateLookupSubject -notmatch '^wip\(task-postflight\): .*\[status=UNKNOWN ') {
            Get-Content $wrapperGateLookupOut -ErrorAction SilentlyContinue | ForEach-Object { Write-Error $_ }
            throw "An unresolved status must land a status=UNKNOWN checkpoint (found $gateLookupCommits commits, HEAD [$gateLookupSubject])"
        }
        if ($gateMismatchCode -ne 0) {
            Get-Content $wrapperGateMismatchOut -ErrorAction SilentlyContinue | ForEach-Object { Write-Error $_ }
            throw "Gate-mismatch wrapper exited with $gateMismatchCode"
        }
        if ((Get-Content -Raw -Path $wrapperGateMismatchOut) -notlike '*get_context resolved a different task (task-someone-elses)*') {
            Get-Content $wrapperGateMismatchOut -ErrorAction SilentlyContinue | ForEach-Object { Write-Error $_ }
            throw 'Expected the wrapper to reject a get_context fallback onto a different task'
        }
        if ($gateMismatchCommits -ne 2 -or $gateMismatchSubject -notmatch '^wip\(task-postflight\): .*\[status=UNKNOWN ') {
            Get-Content $wrapperGateMismatchOut -ErrorAction SilentlyContinue | ForEach-Object { Write-Error $_ }
            throw "A get_context fallback onto a different task must land a status=UNKNOWN checkpoint, never a completion (found $gateMismatchCommits commits, HEAD [$gateMismatchSubject])"
        }
    } else {
        Write-Host 'SKIP qualityGate cases: git not available'
    }

    # --- A refused team join (a full team) must be named, never printed as
    # success, and the teamless claim refusal must not read as an empty queue.
    # Until this case, both wrappers discarded the join_team answer and printed
    # "joined team", and 7 seats sat idle beside 35 claimable rows.
    # Twin: the [team join] case in postflight.sh. ---
    $teamFullProject = Join-Path $tempRoot 'teamfull-project'
    New-Item -ItemType Directory -Force -Path (Join-Path $teamFullProject '.moe\messages') | Out-Null
    [IO.File]::WriteAllText((Join-Path $teamFullProject '.moe\project.json'), '{"id":"proj-teamfull","name":"postflight-teamfull","settings":{"autoCommit":false}}')
    [IO.File]::WriteAllText((Join-Path $teamFullProject '.moe\messages\chan-general.jsonl'), '')
    [IO.File]::WriteAllText((Join-Path $teamFullProject '.moe\daemon.json'), ('{"port":9876,"projectPath":' + (ConvertTo-Json $teamFullProject) + '}'))
    $teamFullOut = Join-Path $tempRoot 'wrapper-teamfull.out'
    $teamFullSavedProxy = $env:MOE_PROXY_PATH
    $env:MOE_PROXY_PATH = $fakeProxy
    $env:FAKE_JOIN_FULL = '1'
    $env:FAKE_CLAIM_MODE = 'noteam'
    $env:MOE_TASKLESS_WAIT_SEC = '5'
    $env:MOE_DISABLE_HEARTBEAT = '1'
    try {
        $null = Invoke-WrapperProcess @('-Project', $teamFullProject, '-WorkerId', 'worker-teamfull', '-Role', 'worker', '-Team', 'Smoke', '-NoStartDaemon', '-Command', $trueCmd, '-NoLoop') $teamFullOut
    } finally {
        Remove-Item Env:FAKE_JOIN_FULL, Env:FAKE_CLAIM_MODE, Env:MOE_TASKLESS_WAIT_SEC, Env:MOE_DISABLE_HEARTBEAT -ErrorAction SilentlyContinue
        $env:MOE_PROXY_PATH = $teamFullSavedProxy
    }
    $teamFullText = [string](Get-Content -Raw -LiteralPath $teamFullOut -ErrorAction SilentlyContinue)
    foreach ($want in @('moe.join_team refused: Team Smoke is full (max 10 members)', 'claim_next_task refused with NO_TEAM_MEMBERSHIP')) {
        if ($teamFullText.IndexOf($want, [System.StringComparison]::Ordinal) -lt 0) {
            Write-Host $teamFullText
            throw "TEAM JOIN FAILED: expected '$want'"
        }
    }
    if ($teamFullText.IndexOf("joined team 'Smoke'", [System.StringComparison]::Ordinal) -ge 0) {
        Write-Host $teamFullText
        throw 'TEAM JOIN FAILED: a refused join was printed as success'
    }
    # The teamless seat must say so in its taskless outcome, and must have
    # retried the join rather than giving up after the startup refusal.
    if ($teamFullText.IndexOf('MOE_TASKLESS_NO_LAUNCH reason=teamless', [System.StringComparison]::Ordinal) -lt 0) {
        Write-Host $teamFullText
        throw "TEAM JOIN FAILED: a teamless seat's taskless outcome was not reason=teamless"
    }
    $teamFullJoinsFile = Join-Path $teamFullProject '.moe\join-count'
    $teamFullJoins = if (Test-Path -LiteralPath $teamFullJoinsFile) { [int]([IO.File]::ReadAllText($teamFullJoinsFile).Trim()) } else { 0 }
    if ($teamFullJoins -lt 2) {
        Write-Host $teamFullText
        throw "TEAM JOIN FAILED: the refused startup join was never retried ($teamFullJoins join call(s))"
    }
    Write-Host '[team join] ok'

    # --- A seat left teamless at startup must heal once the team has room: the
    # join is retried before every claim, and the first accepted join ends the
    # teamless state without a relaunch. Until this case, the startup join was
    # one shot, and a seat launched into a full team idled on "No claimable task
    # ... MOE_TASKLESS_NO_LAUNCH reason=idle" until someone relaunched it, even
    # after the team's maxSize was raised. Twin: the [team heal] case in
    # postflight.sh. ---
    Write-Host '[team heal] a refused startup join is retried and heals when the team has room'
    $teamHealProject = Join-Path $tempRoot 'teamheal-project'
    New-Item -ItemType Directory -Force -Path (Join-Path $teamHealProject '.moe\messages') | Out-Null
    [IO.File]::WriteAllText((Join-Path $teamHealProject '.moe\project.json'), '{"id":"proj-teamheal","name":"postflight-teamheal","settings":{"autoCommit":false}}')
    [IO.File]::WriteAllText((Join-Path $teamHealProject '.moe\messages\chan-general.jsonl'), '')
    [IO.File]::WriteAllText((Join-Path $teamHealProject '.moe\daemon.json'), ('{"port":9876,"projectPath":' + (ConvertTo-Json $teamHealProject) + '}'))
    $teamHealOut = Join-Path $tempRoot 'wrapper-teamheal.out'
    $teamHealSavedProxy = $env:MOE_PROXY_PATH
    $env:MOE_PROXY_PATH = $fakeProxy
    $env:FAKE_JOIN_FULL_UNTIL = '2'
    $env:FAKE_CLAIM_MODE = 'noteam-until-joined'
    $env:MOE_TASKLESS_WAIT_SEC = '5'
    $env:MOE_DISABLE_HEARTBEAT = '1'
    try {
        $null = Invoke-WrapperProcess @('-Project', $teamHealProject, '-WorkerId', 'worker-teamheal', '-Role', 'worker', '-Team', 'Smoke', '-NoStartDaemon', '-Command', $trueCmd, '-NoLoop') $teamHealOut
    } finally {
        Remove-Item Env:FAKE_JOIN_FULL_UNTIL, Env:FAKE_CLAIM_MODE, Env:MOE_TASKLESS_WAIT_SEC, Env:MOE_DISABLE_HEARTBEAT -ErrorAction SilentlyContinue
        $env:MOE_PROXY_PATH = $teamHealSavedProxy
    }
    $teamHealText = [string](Get-Content -Raw -LiteralPath $teamHealOut -ErrorAction SilentlyContinue)
    foreach ($want in @('moe.join_team refused: Team Smoke is full (max 10 members)', 'claim_next_task refused with NO_TEAM_MEMBERSHIP', "joined team 'Smoke' on retry; this seat is no longer teamless.", 'MOE_TASKLESS_NO_LAUNCH reason=idle')) {
        if ($teamHealText.IndexOf($want, [System.StringComparison]::Ordinal) -lt 0) {
            Write-Host $teamHealText
            throw "TEAM HEAL FAILED: expected '$want'"
        }
    }
    if ($teamHealText.IndexOf('reason=teamless', [System.StringComparison]::Ordinal) -ge 0) {
        Write-Host $teamHealText
        throw 'TEAM HEAL FAILED: a healed seat still reported itself teamless'
    }
    Write-Host '[team heal] ok'

    # --- [landing resume] WT-11's resume prompt, beyond the shared suite (twin: the [landing resume]
    # block in postflight.sh). A worktree seat whose task.landingRetry is set merges the target into
    # W before the CLI starts and leaves the merge uncommitted, so HEAD is still the pre-merge task tip.
    # Both prompt lines carry $lrRule (verify the merged working tree, not HEAD; git stays read-only)
    # instead of "no git commands"; a seat without landingRetry gets neither line. The fake CLI is a
    # .ps1, so the prompt reaches it verbatim (no cmd.exe parsing of the marker characters), and it
    # also copies the private session context file a quoted or long Windows prompt is routed through. ---
    Write-Host '[landing resume] LANDING-RETRY and LANDING-CONFLICT prompts carry the merged-tree verification rule'
    $lrRule = 'The wrapper commits this merge only when it lands, so HEAD can lack the merged target: where the verification builds a snapshot from HEAD (git archive HEAD, or a clone checked out at HEAD), build it from the tracked files of this worktree instead (the paths git ls-files lists), keep every other command unchanged, and say so in the evidence. Git stays read-only here: run only git status, git diff, git log, git show, git ls-files and git rev-parse, never a git write (commit, merge, reset, checkout, switch, restore, stash, add, rm, mv, rebase, cherry-pick, revert, apply, clean, or any other command that changes the index, HEAD, a ref or MERGE_HEAD).'
    $lrDir = Join-Path $tempRoot 'lr-project'
    $lrW = Join-Path $lrDir '.worktrees\task-postflight'
    $lrPrompt = Join-Path $tempRoot 'lr-prompt.txt'
    $lrCli = Join-Path $tempRoot 'landing-cli.ps1'
    [IO.File]::WriteAllText($lrCli, @'
$t = @($args | ForEach-Object { [string]$_ }) -join "`n"
if ($t -match 'session context file at (.+?\.md)\. ') { $t += "`n" + [IO.File]::ReadAllText($Matches[1]) }
[IO.File]::WriteAllText($env:FAKE_LR_PROMPT, $t)
exit 0
'@)
    New-Item -ItemType Directory -Force -Path (Join-Path $lrDir 'src'), (Join-Path $lrDir '.moe\messages') | Out-Null
    [IO.File]::WriteAllText((Join-Path $lrDir '.gitignore'), ".worktrees/`n.mcp.json`nlogs/`n")
    [IO.File]::WriteAllText((Join-Path $lrDir 'src\a.txt'), "seed a`n")
    [IO.File]::WriteAllText((Join-Path $lrDir '.moe\project.json'), '{"id":"proj-lr","name":"postflight-lr","settings":{"autoCommit":false}}')
    [IO.File]::WriteAllText((Join-Path $lrDir '.moe\messages\chan-general.jsonl'), '')
    Write-TaskRecord $lrDir @() 'WORKING'
    # Invoke-LrGit DIR ARGS -- one fixture git call's output lines; a failed call fails the case.
    function Invoke-LrGit([string]$Dir, [string[]]$GitArgs) {
        $ErrorActionPreference = 'Continue'
        $out = @(& git -C $Dir @GitArgs 2>$null)
        if ($LASTEXITCODE -ne 0) { throw "LANDING RESUME FAILED: fixture git $GitArgs exited $LASTEXITCODE" }
        return $out
    }
    # The repo carries its identity: the resume's own merge needs one, and the seat's profile has none.
    foreach ($a in @(@('init', '-q'), @('symbolic-ref', 'HEAD', 'refs/heads/main'), @('config', 'core.autocrlf', 'false'),
            @('config', 'user.name', 'Moe Test'), @('config', 'user.email', 'moe@test.local'), @('add', '.gitignore', 'src', '.moe/project.json', '.moe/tasks'),
            @('commit', '-qm', 'seed'), @('switch', '-q', '-c', 'moe/control'))) {
        $null = Invoke-LrGit $lrDir $a
    }
    function Stop-Lr([string]$Name, [string]$Why, $Run) { Write-Host $Run.Text; Write-Host $Run.Prompt; throw "LANDING RESUME FAILED ($Name): $Why" }
    # Set-LrMain FILE TEXT -- one commit on main; the control checkout goes back to moe/control.
    function Set-LrMain([string]$File, [string]$Text) {
        $null = Invoke-LrGit $lrDir @('switch', '-q', 'main')
        [IO.File]::WriteAllText((Join-Path $lrDir $File), "$Text`n")
        foreach ($a in @(@('add', '--', $File), @('commit', '-qm', "main $File"), @('switch', '-q', 'moe/control'))) { $null = Invoke-LrGit $lrDir $a }
    }
    # Invoke-LrRun NAME -- one worker seat whose claim says worktree mode: @{ Code; Text; Prompt }; it exits 0 and its CLI ran.
    function Invoke-LrRun([string]$Name) {
        Remove-Item -LiteralPath $lrPrompt -Force -ErrorAction SilentlyContinue
        $knobs = @{ MOE_PROXY_PATH = $fakeProxy; USERPROFILE = $homeDir; MOE_DISABLE_HEARTBEAT = '1'; FAKE_TASK_STATUS = 'WORKING'
            FAKE_CLAIM_WORKSPACE = '{"mode":"worktree","target":"main"}'; MOE_LAND_NET_BACKOFF_SEC = '0'; FAKE_LR_PROMPT = $lrPrompt }
        $saved = @{}
        foreach ($k in $knobs.Keys) { $saved[$k] = [Environment]::GetEnvironmentVariable($k); [Environment]::SetEnvironmentVariable($k, $knobs[$k]) }
        $out = Join-Path $tempRoot "wrapper-lr-$Name.out"
        try {
            $code = Invoke-WrapperProcess @('-Project', $lrDir, '-WorkerId', 'worker-lr', '-Role', 'worker', '-Team', 'Smoke', '-NoStartDaemon', '-Command', $lrCli, '-NoLoop', '-PollInterval', '0') $out
        } finally {
            foreach ($k in $saved.Keys) { [Environment]::SetEnvironmentVariable($k, $saved[$k]) }
        }
        $run = @{ Code = $code; Text = [string](Get-Content -Raw -LiteralPath $out -ErrorAction SilentlyContinue)
            Prompt = [string](Get-Content -Raw -LiteralPath $lrPrompt -ErrorAction SilentlyContinue) }
        if ($run.Code -ne 0 -or -not $run.Prompt) { Stop-Lr $Name "exit $($run.Code), or the CLI did not run" $run }
        return $run
    }
    # Assert-LrPrompt NAME HEADER RUN -- the prompt holds HEADER and $lrRule, not "no git commands"; W is mid-merge.
    function Assert-LrPrompt([string]$Name, [string]$Header, $Run) {
        if (-not $Run.Prompt.Contains($Header)) { Stop-Lr $Name "no '$Header' in the prompt" $Run }
        if (-not $Run.Prompt.Contains($lrRule)) { Stop-Lr $Name 'the prompt lacks the merged-tree verification rule' $Run }
        if ($Run.Prompt.Contains('no git commands')) { Stop-Lr $Name 'the prompt still says no git commands' $Run }
        $ErrorActionPreference = 'Continue'
        $null = & git -C $lrW rev-parse -q --verify MERGE_HEAD 2>$null
        if ($LASTEXITCODE -ne 0) { Stop-Lr $Name 'W has no pending merge' $Run }
    }
    # (a) No landingRetry: W is made and the prompt has no resume line and no rule.
    $run = Invoke-LrRun 'plain'
    if (-not (Test-Path -LiteralPath $lrW) -or $run.Prompt.Contains('LANDING-') -or $run.Prompt.Contains($lrRule)) { Stop-Lr 'plain' 'no W, or a resume line without landingRetry' $run }
    # (b) A gate retry after main moved without a conflict: LANDING-RETRY, MERGE_HEAD set.
    [IO.File]::WriteAllText((Join-Path $lrW 'src\a.txt'), "task a`n")
    $null = Invoke-LrGit $lrW @('commit', '-qam', 'task a')
    Set-LrMain 'src/m.txt' 'main m'
    [IO.File]::WriteAllText((Join-Path $lrDir '.moe\landing-retry.json'), '{"reason":"gate","count":1}')
    $run = Invoke-LrRun 'retry'
    Assert-LrPrompt 'retry' 'LANDING-RETRY: gate' $run
    if ($run.Prompt.Contains('LANDING-CONFLICT')) { Stop-Lr 'retry' 'a clean merge said LANDING-CONFLICT' $run }
    # (c) A same-line conflict: LANDING-CONFLICT, and src/a.txt stays unmerged in W.
    $null = Invoke-LrGit $lrW @('merge', '--abort')
    Set-LrMain 'src/a.txt' 'main a'
    [IO.File]::WriteAllText((Join-Path $lrDir '.moe\landing-retry.json'), '{"reason":"conflict","paths":["src/a.txt"],"count":1}')
    $run = Invoke-LrRun 'conflict'
    Assert-LrPrompt 'conflict' 'LANDING-CONFLICT: src/a.txt' $run
    if (@(Invoke-LrGit $lrW @('ls-files', '-u', '--', 'src/a.txt')).Count -eq 0) { Stop-Lr 'conflict' 'src/a.txt is not unmerged in W' $run }
    Write-Host '[landing resume] ok'

    # --- [worktree reuse] Worktree provisioning regressions beyond the shared suite
    # (twin: the [worktree reuse] block in postflight.sh). Only a missing index file
    # marks a half-made W, so a W whose agent emptied its index with `git rm` is
    # reused as is, staged deletions and all. A failed Windows path-budget probe
    # refuses with CREATE_FAILED instead of passing as length 0. ---
    Write-Host '[worktree reuse] a half-made W is finished, an emptied index is kept, a failed budget probe refuses'
    $wtrDir = Join-Path $tempRoot 'wtr-project'
    $wtrW = Join-Path $wtrDir '.worktrees\task-postflight'
    New-Item -ItemType Directory -Force -Path (Join-Path $wtrDir 'src'), (Join-Path $wtrDir '.moe\messages') | Out-Null
    [IO.File]::WriteAllText((Join-Path $wtrDir '.gitignore'), ".worktrees/`n.mcp.json`nlogs/`n")
    [IO.File]::WriteAllText((Join-Path $wtrDir 'src\a.txt'), "seed a`n")
    [IO.File]::WriteAllText((Join-Path $wtrDir '.moe\project.json'), '{"id":"proj-wtr","name":"postflight-wtr","settings":{"autoCommit":false}}')
    [IO.File]::WriteAllText((Join-Path $wtrDir '.moe\messages\chan-general.jsonl'), '')
    Write-TaskRecord $wtrDir @() 'WORKING'
    # Invoke-WtrGit ARGS -- one fixture git call's output lines; a failed call fails the case.
    function Invoke-WtrGit([string[]]$GitArgs) {
        $ErrorActionPreference = 'Continue'
        $out = @(& git @GitArgs 2>$null)
        if ($LASTEXITCODE -ne 0) { throw "WORKTREE REUSE FAILED: fixture git $GitArgs exited $LASTEXITCODE" }
        return $out
    }
    foreach ($a in @(@('init', '-q'), @('symbolic-ref', 'HEAD', 'refs/heads/main'), @('config', 'core.autocrlf', 'false'),
            @('config', 'user.name', 'Moe Test'), @('config', 'user.email', 'moe@test.local'), @('add', '.gitignore', 'src', '.moe/project.json', '.moe/tasks'),
            @('commit', '-qm', 'seed'), @('switch', '-q', '-c', 'moe/control'))) {
        $null = Invoke-WtrGit (@('-C', $wtrDir) + $a)
    }
    # Invoke-WtrRun NAME [PATHPREFIX] -- one worker seat whose claim says worktree mode: @{ Code; Text }.
    function Invoke-WtrRun([string]$Name, [string]$PathPrefix = '') {
        foreach ($f in 'session-new.txt', '.moe\evidence-rpcs.jsonl', '.moe\attempts') { Remove-Item -LiteralPath (Join-Path $wtrDir $f) -Recurse -Force -ErrorAction SilentlyContinue }
        $knobs = @{ MOE_PROXY_PATH = $fakeProxy; USERPROFILE = $homeDir; MOE_DISABLE_HEARTBEAT = '1'; FAKE_TASK_STATUS = 'WORKING'
            FAKE_CLAIM_WORKSPACE = '{"mode":"worktree","target":"main"}'; PATH = $PathPrefix + $env:PATH; MOE_LAND_NET_BACKOFF_SEC = '0' }
        $saved = @{}
        foreach ($k in $knobs.Keys) { $saved[$k] = [Environment]::GetEnvironmentVariable($k); [Environment]::SetEnvironmentVariable($k, $knobs[$k]) }
        $out = Join-Path $tempRoot "wrapper-wtr-$Name.out"
        try {
            $code = Invoke-WrapperProcess @('-Project', $wtrDir, '-WorkerId', 'worker-wtr', '-Role', 'worker', '-Team', 'Smoke', '-NoStartDaemon', '-Command', $createFileCmd, '-NoLoop', '-PollInterval', '0') $out
        } finally {
            foreach ($k in $saved.Keys) { [Environment]::SetEnvironmentVariable($k, $saved[$k]) }
        }
        return @{ Code = $code; Text = [string](Get-Content -Raw -LiteralPath $out -ErrorAction SilentlyContinue) }
    }
    function Get-WtrBlocks { @(Get-Content -LiteralPath (Join-Path $wtrDir '.moe\evidence-rpcs.jsonl') -ErrorAction SilentlyContinue | Where-Object { $_.Contains('"tool":"report_blocked"') }) }
    function Stop-Wtr([string]$Name, [string]$Why, $Run) { Write-Host $Run.Text; throw "WORKTREE REUSE FAILED ($Name): $Why" }
    # Assert-WtrReused NAME RUN -- W was reused: its line, exit 0, the CLI ran, no refusal, no W/.moe.
    function Assert-WtrReused([string]$Name, $Run) {
        if ($Run.Code -ne 0) { Stop-Wtr $Name "exit $($Run.Code), expected 0" $Run }
        if ($Run.Text -cnotmatch '(?m)^\[worktree\] reused .+ on moe/task/task-postflight\r?$') { Stop-Wtr $Name 'no [worktree] reused line' $Run }
        if (-not (Test-Path -LiteralPath (Join-Path $wtrDir 'session-new.txt')) -or @(Get-WtrBlocks).Count -ne 0) { Stop-Wtr $Name 'the CLI did not run, or report_blocked was called' $Run }
        if (Test-Path -LiteralPath (Join-Path $wtrW '.moe')) { Stop-Wtr $Name 'W/.moe exists' $Run }
    }
    # Assert-WtrKept NAME STAGED -- W's index is still empty and its staged deletions are unchanged.
    function Assert-WtrKept([string]$Name, [string]$Staged) {
        if (@(Invoke-WtrGit @('-C', $wtrW, 'ls-files')).Count -ne 0) { throw "WORKTREE REUSE FAILED ($Name): reuse refilled the emptied index" }
        if ((@(Invoke-WtrGit @('-C', $wtrW, 'diff', '--cached', '--name-status')) -join "`n") -cne $Staged) { throw "WORKTREE REUSE FAILED ($Name): the staged deletions changed" }
    }
    # (b) A session died after sparse-checkout set, before read-tree: W has no index file yet.
    $null = Invoke-WtrGit @('-C', $wtrDir, 'worktree', 'add', '-q', '--lock', '--reason', 'moe task-postflight', '--no-checkout', '--no-track', '-b', 'moe/task/task-postflight', $wtrW, 'main')
    $null = Invoke-WtrGit @('-C', $wtrW, 'sparse-checkout', 'set', '--no-cone', '/*', '!/.moe/')
    Assert-WtrReused 'half-made' (Invoke-WtrRun 'half-made')
    if (-not (Test-Path -LiteralPath (Join-Path $wtrW 'src\a.txt'))) { throw 'WORKTREE REUSE FAILED (half-made): W/src/a.txt is not checked out' }
    # (a) The agent emptied the index on purpose, first with --cached, then by deleting the files.
    $null = Invoke-WtrGit @('-C', $wtrW, 'rm', '-q', '--cached', '--sparse', '-r', '.')
    $wtrStaged = @(Invoke-WtrGit @('-C', $wtrW, 'diff', '--cached', '--name-status')) -join "`n"
    if ($wtrStaged -cnotmatch 'src/a\.txt') { throw 'WORKTREE REUSE FAILED: the fixture staged no deletion' }
    Assert-WtrReused 'emptied-cached' (Invoke-WtrRun 'emptied-cached')
    Assert-WtrKept 'emptied-cached' $wtrStaged
    $null = Invoke-WtrGit @('-C', $wtrW, 'reset', '-q')
    $null = Invoke-WtrGit @('-C', $wtrW, 'rm', '-q', '--sparse', '-r', '.')
    $wtrStaged = @(Invoke-WtrGit @('-C', $wtrW, 'diff', '--cached', '--name-status')) -join "`n"
    Assert-WtrReused 'emptied-deleted' (Invoke-WtrRun 'emptied-deleted')
    Assert-WtrKept 'emptied-deleted' $wtrStaged
    if ((Test-Path -LiteralPath (Join-Path $wtrW 'src\a.txt')) -or (Test-Path -LiteralPath (Join-Path $wtrW '.gitignore'))) { throw 'WORKTREE REUSE FAILED (emptied-deleted): reuse restored a deleted file' }
    # (c) The path-budget probe's ls-tree fails: CREATE_FAILED before any W work, no CLI.
    # The stub is a git.ps1, which PowerShell finds on PATH before git.exe.
    $null = Invoke-WtrGit @('-C', $wtrDir, 'worktree', 'remove', '--force', '--force', $wtrW)
    $wtrStub = Join-Path $tempRoot 'wtr-git-stub'
    New-Item -ItemType Directory -Force -Path $wtrStub | Out-Null
    $wtrGit = (Get-Command git -CommandType Application | Select-Object -First 1).Source -replace "'", "''"
    [IO.File]::WriteAllText((Join-Path $wtrStub 'git.ps1'), ("`$ErrorActionPreference = 'Continue'`r`n" +
        "if (`$args -ccontains 'ls-tree') { [Console]::Error.WriteLine('fatal: stub fails ls-tree'); exit 1 }`r`n" +
        "if (`$MyInvocation.ExpectingInput) { `$input | & '$wtrGit' @args } else { & '$wtrGit' @args }`r`n" +
        "exit `$LASTEXITCODE`r`n"))
    $run = Invoke-WtrRun 'budget-probe' ($wtrStub + [IO.Path]::PathSeparator)
    if ($run.Code -ne 1) { Stop-Wtr 'budget-probe' "exit $($run.Code), expected 1" $run }
    if ($run.Text -cnotmatch '\[ERROR\] MOE_WORKTREE_CREATE_FAILED: git ls-tree failed') { Stop-Wtr 'budget-probe' 'no CREATE_FAILED line from the budget probe' $run }
    $blocks = @(Get-WtrBlocks)
    if ($blocks.Count -ne 1 -or -not $blocks[0].Contains('"reason":"MOE_WORKTREE_CREATE_FAILED: git ls-tree failed')) { Stop-Wtr 'budget-probe' 'not exactly one report_blocked naming CREATE_FAILED' $run }
    if ((Test-Path -LiteralPath (Join-Path $wtrDir 'session-new.txt')) -or (Test-Path -LiteralPath $wtrW)) { Stop-Wtr 'budget-probe' 'the CLI ran, or W was made' $run }
    # (d) W holds work, then loses its index FILE (an agent's `rm <index>`, then a crash). With
    # no index a sparse read-tree overwrites the edit and still exits 0, so reuse refuses
    # with CREATE_FAILED and touches nothing. (c) left no W, so the first run re-adds it.
    $run = Invoke-WtrRun 'index-setup'
    if ($run.Code -ne 0 -or -not (Test-Path -LiteralPath (Join-Path $wtrW 'src\a.txt'))) { Stop-Wtr 'index-setup' 'W was not re-added' $run }
    [IO.File]::WriteAllText((Join-Path $wtrW 'src\a.txt'), "agent edit`n")
    [IO.File]::WriteAllText((Join-Path $wtrW 'src\new.txt'), "agent new`n")
    $wtrIndex = "$(@(Invoke-WtrGit @('-C', $wtrW, 'rev-parse', '--path-format=absolute', '--git-path', 'index')) | Select-Object -First 1)"
    Remove-Item -LiteralPath $wtrIndex -Force
    $run = Invoke-WtrRun 'index-deleted'
    if ($run.Code -ne 1) { Stop-Wtr 'index-deleted' "exit $($run.Code), expected 1" $run }
    if ($run.Text -cnotmatch '\[ERROR\] MOE_WORKTREE_CREATE_FAILED: .+ has no index file but holds more than \.git') { Stop-Wtr 'index-deleted' 'no CREATE_FAILED line for the missing index' $run }
    $blocks = @(Get-WtrBlocks)
    if ($blocks.Count -ne 1 -or -not $blocks[0].Contains('"reason":"MOE_WORKTREE_CREATE_FAILED: ') -or -not $blocks[0].Contains(' has no index file')) { Stop-Wtr 'index-deleted' 'not exactly one report_blocked naming CREATE_FAILED' $run }
    if (Test-Path -LiteralPath (Join-Path $wtrDir 'session-new.txt')) { Stop-Wtr 'index-deleted' 'the CLI ran' $run }
    if ([IO.File]::ReadAllText((Join-Path $wtrW 'src\a.txt')) -cne "agent edit`n" -or [IO.File]::ReadAllText((Join-Path $wtrW 'src\new.txt')) -cne "agent new`n") { Stop-Wtr 'index-deleted' 'the edited or the untracked file lost its bytes' $run }
    if (Test-Path -LiteralPath $wtrIndex) { Stop-Wtr 'index-deleted' "the refusal wrote W's index" $run }
    # (e) WT-09: with a remote, W is cut from refs/remotes/origin/main, fetched first (origin is
    # one commit ahead of the local main); with no such ref the seat refuses with CREATE_FAILED.
    $null = Invoke-WtrGit @('-C', $wtrDir, 'worktree', 'remove', '--force', '--force', $wtrW)
    $null = Invoke-WtrGit @('-C', $wtrDir, 'branch', '-q', '-D', 'moe/task/task-postflight')
    $wtrOrigin = Join-Path $tempRoot 'wtr-origin.git'
    $null = Invoke-WtrGit @('-C', $wtrDir, 'remote', 'add', 'origin', $wtrOrigin)
    $run = Invoke-WtrRun 'remote-no-base'
    if ($run.Code -ne 1 -or $run.Text -cnotmatch 'MOE_LAND_FETCH_FAILED' -or $run.Text -cnotmatch '\[ERROR\] MOE_WORKTREE_CREATE_FAILED: refs/remotes/origin/main does not exist') {
        Stop-Wtr 'remote-no-base' 'not exit 1 with FETCH_FAILED, then CREATE_FAILED for the missing origin base' $run
    }
    if (@(Get-WtrBlocks).Count -ne 1 -or (Test-Path -LiteralPath (Join-Path $wtrDir 'session-new.txt')) -or
        @(Invoke-WtrGit @('-C', $wtrDir, 'worktree', 'list', '--porcelain') | Where-Object { $_.StartsWith('worktree ') }).Count -ne 1) {
        Stop-Wtr 'remote-no-base' 'not one report_blocked, the CLI ran, or W was registered' $run
    }
    $null = Invoke-WtrGit @('init', '-q', '--bare', $wtrOrigin)
    $null = Invoke-WtrGit @('-C', $wtrDir, 'push', '-q', 'origin', 'main')
    $wtrO1 = "$(Invoke-WtrGit @('-C', $wtrOrigin, '-c', 'user.name=Moe Test', '-c', 'user.email=moe@test.local', 'commit-tree', 'main^{tree}', '-p', 'main', '-m', 'origin ahead'))"
    $null = Invoke-WtrGit @('-C', $wtrOrigin, 'update-ref', 'refs/heads/main', $wtrO1)
    $run = Invoke-WtrRun 'remote-base'
    if ($run.Code -ne 0 -or $run.Text -cnotmatch '(?m)^\[worktree\] created .+ on moe/task/task-postflight\r?$') { Stop-Wtr 'remote-base' "exit $($run.Code), or no [worktree] created line" $run }
    if ("$(Invoke-WtrGit @('-C', $wtrDir, 'rev-parse', 'moe/task/task-postflight'))" -cne $wtrO1 -or "$(Invoke-WtrGit @('-C', $wtrDir, 'rev-parse', 'main'))" -ceq $wtrO1) {
        Stop-Wtr 'remote-base' "W's branch does not start at origin's main tip" $run
    }
    Write-Host '[worktree reuse] ok'

    # --- [WT-14] Worktree removal at DONE and the orphan sweep (twin: the [WT-14] block
    # in postflight.sh). New-Wt14Fixture is the one builder: a control checkout on BRANCH
    # (moe/control, or a shared moe/work-* branch) whose .serena/memories and
    # .claude/skills hold sentinels, and per task a W made exactly as WT-04 makes it,
    # linked as WT-06 links it (the manifest line first, then the junction), with one
    # task commit squash-landed on main. A QA seat claims task-postflight as DONE with its
    # completion recorded at main's tip. Teardown unlinks every junction it made. ---
    Write-Host '[WT-14] a QA approval removes a fully landed W; anything else is left in place'
    $wt14Run = 0
    $wt14Links = New-Object System.Collections.Generic.List[string]
    $wt14 = @{ P = ''; Out = ''; Code = 0; Text = '' }
    function Stop-Wt14([string]$Name, [string]$Why) { Write-Host $wt14.Text; throw "WT-14 FAILED ($Name): $Why" }
    # Invoke-Wt14Git DIR ARGS -- one fixture git call's output lines; a failed call fails the case.
    function Invoke-Wt14Git([string]$Dir, [string[]]$GitArgs) {
        $ErrorActionPreference = 'Continue'
        $out = @(& git -C $Dir -c 'user.name=Moe Test' -c 'user.email=moe@test.local' -c 'commit.gpgsign=false' -c 'core.autocrlf=false' @GitArgs 2>$null)
        if ($LASTEXITCODE -ne 0) { throw "WT-14 FAILED: fixture git $GitArgs exited $LASTEXITCODE" }
        return $out
    }
    function Get-Wt14Admin { "$(Invoke-Wt14Git $wt14.P @('rev-parse', '--path-format=absolute', '--git-common-dir'))/moe/worktree" }
    function Test-Wt14Link([string]$Path) { $i = Get-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue; [bool]($i -and ($i.Attributes -band [IO.FileAttributes]::ReparsePoint)) }
    # New-Wt14Fixture NAME BRANCH [TASKS] -- a fresh control checkout $wt14.P on BRANCH, one landed W per task.
    function New-Wt14Fixture([string]$Name, [string]$Branch, [string[]]$Tasks = @()) {
        $p = Join-Path $tempRoot "wt14-$Name"
        $wt14.P = $p; $wt14.Out = Join-Path $tempRoot "wt14-$Name.out"; $wt14.Text = ''
        foreach ($d in 'src', '.moe\messages', '.serena\memories', '.claude\skills\s') { New-Item -ItemType Directory -Force -Path (Join-Path $p $d) | Out-Null }
        [IO.File]::WriteAllText((Join-Path $p '.gitignore'), ".worktrees/`n.mcp.json`nlogs/`n")
        [IO.File]::WriteAllText((Join-Path $p 'src\seed.txt'), "seed`n")
        [IO.File]::WriteAllText((Join-Path $p '.moe\project.json'), '{"id":"proj-wt14","name":"postflight-wt14","settings":{"autoCommit":false}}')
        [IO.File]::WriteAllText((Join-Path $p '.moe\messages\chan-general.jsonl'), '')
        [IO.File]::WriteAllText((Join-Path $p '.serena\memories\sentinel.md'), "memory sentinel`n")
        [IO.File]::WriteAllText((Join-Path $p '.claude\skills\s\SKILL.md'), "skill sentinel`n")
        # The repo's own identity, as the other fixtures set it: the sweep's rescue refs are commit-trees.
        foreach ($a in @(@('init', '-q'), @('config', 'user.name', 'Moe Test'), @('config', 'user.email', 'moe@test.local'), @('config', 'commit.gpgsign', 'false'),
                @('config', 'core.autocrlf', 'false'), @('symbolic-ref', 'HEAD', 'refs/heads/main'), @('add', '.gitignore', 'src', '.moe/project.json'),
                @('commit', '-qm', 'seed'), @('switch', '-q', '-c', $Branch))) { $null = Invoke-Wt14Git $p $a }
        $man = Get-Wt14Admin
        New-Item -ItemType Directory -Force -Path $man | Out-Null
        foreach ($tid in $Tasks) {
            $w = Join-Path $p ".worktrees\$tid"
            $null = Invoke-Wt14Git $p @('worktree', 'add', '-q', '--lock', '--reason', "moe $tid", '--no-checkout', '--no-track', '-b', "moe/task/$tid", $w, 'main')
            $null = Invoke-Wt14Git $w @('sparse-checkout', 'set', '--no-cone', '/*', '!/.moe/')
            $null = Invoke-Wt14Git $w @('read-tree', '-mu', 'HEAD')
            New-Item -ItemType Directory -Force -Path (Join-Path $w '.serena'), (Join-Path $w '.claude') | Out-Null
            foreach ($rel in '.serena\memories', '.claude\skills') {
                [IO.File]::AppendAllText("$man/$tid.links", $rel.Replace('\', '/') + "`n")
                $null = New-Item -ItemType Junction -Path (Join-Path $w $rel) -Target (Join-Path $p $rel)
                $wt14Links.Add((Join-Path $w $rel))
            }
            [IO.File]::WriteAllText("$man/$tid.control-dirt", '')
            [IO.File]::WriteAllText((Join-Path $w "src\$tid.txt"), "$tid work`n")
            $null = Invoke-Wt14Git $w @('add', "src/$tid.txt")
            $null = Invoke-Wt14Git $w @('commit', '-qm', "work $tid")
            $tree = "$(Invoke-Wt14Git $p @('merge-tree', '--write-tree', 'main', "moe/task/$tid"))"
            $sha = "$(Invoke-Wt14Git $p @('commit-tree', $tree, '-p', 'main', '-m', "land $tid"))"
            $null = Invoke-Wt14Git $p @('update-ref', 'refs/heads/main', $sha)
        }
    }
    # Invoke-Wt14Seat NAME ROLE KNOBS -- one wrapper run on $wt14.P with KNOBS set (a $null
    # value unsets one; the sweep interval is unset unless a case passes it); exit 0 expected.
    function Invoke-Wt14Seat([string]$Name, [string]$Role, [hashtable]$Knobs) {
        $k = @{ MOE_PROXY_PATH = $fakeProxy; USERPROFILE = $homeDir; MOE_DISABLE_HEARTBEAT = '1'; MOE_WORKTREE_SWEEP_INTERVAL_SEC = $null }
        foreach ($n in $Knobs.Keys) { $k[$n] = $Knobs[$n] }
        $saved = @{}
        foreach ($n in $k.Keys) { $saved[$n] = [Environment]::GetEnvironmentVariable($n); [Environment]::SetEnvironmentVariable($n, $k[$n]) }
        $prev = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        try {
            $wt14.Code = Invoke-WrapperProcess @('-Project', $wt14.P, '-WorkerId', "$Role-wt14", '-Role', $Role, '-Team', 'Smoke', '-NoStartDaemon', '-Command', $trueCmd, '-NoLoop', '-PollInterval', '0') $wt14.Out
        } finally {
            $ErrorActionPreference = $prev
            foreach ($n in $saved.Keys) { [Environment]::SetEnvironmentVariable($n, $saved[$n]) }
        }
        $wt14.Text = [string](Get-Content -Raw -LiteralPath $wt14.Out -ErrorAction SilentlyContinue)
        if ($wt14.Code -ne 0) { Stop-Wt14 $Name "exit $($wt14.Code), expected 0" }
    }
    # Invoke-Wt14Qa NAME -- one QA seat: task-postflight is DONE, its completion recorded at main's tip.
    function Invoke-Wt14Qa([string]$Name) {
        $land = "$(Invoke-Wt14Git $wt14.P @('rev-parse', 'main'))"
        Invoke-Wt14Seat $Name 'qa' @{ FAKE_TASK_STATUS = 'DONE'
            FAKE_CTX_LANDING = '{"lastCompletion":{"sha":"' + $land + '","ref":"refs/heads/main","pushed":false,"recordedAt":"2026-11-02T00:00:00.000Z"}}' }
    }
    function Test-Wt14Listed([string]$Tid) {
        @(Invoke-Wt14Git $wt14.P @('worktree', 'list', '--porcelain') | Where-Object { $_ -cmatch ('^worktree .*/\.worktrees/' + [regex]::Escape($Tid) + '\z') }).Count -gt 0
    }
    function Test-Wt14Branch([string]$Tid) { @(Invoke-Wt14Git $wt14.P @('for-each-ref', "refs/heads/moe/task/$Tid")).Count -gt 0 }
    # Assert-Wt14Gone NAME TASK -- W is off disk and unlisted; its branch, manifest and control-dirt are deleted.
    function Assert-Wt14Gone([string]$Name, [string]$Tid) {
        $w = Join-Path $wt14.P ".worktrees\$Tid"; $man = "$(Get-Wt14Admin)/$Tid"
        if ($null -ne (Get-Item -LiteralPath $w -Force -ErrorAction SilentlyContinue)) { Stop-Wt14 $Name "$w is still on disk" }
        if (Test-Wt14Listed $Tid) { Stop-Wt14 $Name "$w is still registered" }
        if (Test-Wt14Branch $Tid) { Stop-Wt14 $Name "moe/task/$Tid still exists" }
        if ((Test-Path -LiteralPath "$man.links") -or (Test-Path -LiteralPath "$man.control-dirt")) { Stop-Wt14 $Name "the manifest or control-dirt of $Tid is still there" }
    }
    # Assert-Wt14Kept NAME TASK -- W is on disk and registered, its branch, manifest and both links intact.
    function Assert-Wt14Kept([string]$Name, [string]$Tid) {
        $w = Join-Path $wt14.P ".worktrees\$Tid"
        if (-not (Test-Path -LiteralPath $w -PathType Container) -or -not (Test-Wt14Listed $Tid)) { Stop-Wt14 $Name "$w was removed or unregistered" }
        if (-not (Test-Wt14Branch $Tid)) { Stop-Wt14 $Name "moe/task/$Tid was deleted" }
        $man = Get-Item -LiteralPath "$(Get-Wt14Admin)/$Tid.links" -Force -ErrorAction SilentlyContinue
        if (-not $man -or $man.Length -eq 0 -or -not (Test-Wt14Link (Join-Path $w '.serena\memories')) -or -not (Test-Wt14Link (Join-Path $w '.claude\skills'))) {
            Stop-Wt14 $Name "the manifest or a link of $Tid is gone"
        }
    }
    # Assert-Wt14Bytes NAME FILE TEXT WHY -- FILE still holds exactly TEXT.
    function Assert-Wt14Bytes([string]$Name, [string]$File, [string]$Text, [string]$Why) {
        $b = try { [IO.File]::ReadAllText($File) } catch { $null }
        if ($b -cne $Text) { Stop-Wt14 $Name $Why }
    }
    function Assert-Wt14Sentinels([string]$Name) {
        Assert-Wt14Bytes $Name (Join-Path $wt14.P '.serena\memories\sentinel.md') "memory sentinel`n" 'a control sentinel changed'
        Assert-Wt14Bytes $Name (Join-Path $wt14.P '.claude\skills\s\SKILL.md') "skill sentinel`n" 'a control sentinel changed'
    }
    # Assert-Wt14Left NAME DETAIL -- W left to the sweep with DETAIL (a regex) in the reason.
    function Assert-Wt14Left([string]$Name, [string]$Detail) {
        if ($wt14.Text -cnotmatch "\[worktree\] left .*/\.worktrees/task-postflight to the orphan sweep: .*$Detail") { Stop-Wt14 $Name "no left-to-the-sweep line matching '$Detail'" }
    }
    function Get-Wt14W { Join-Path $wt14.P '.worktrees\task-postflight' }
    # Invoke-Wt14Icacls ARGS -- icacls' exit code; its output and stderr are dropped.
    function Invoke-Wt14Icacls([string[]]$IcaclsArgs) {
        $ErrorActionPreference = 'Continue'
        $null = & icacls @IcaclsArgs 2>&1
        return $LASTEXITCODE
    }

    Write-Host '[scenario WT14A] a QA approval of a fully landed task removes W and its branch'
    New-Wt14Fixture 'a' 'moe/control' @('task-postflight')
    Invoke-Wt14Qa 'WT14A'
    if ($wt14.Text -cnotmatch '(?m)^\[worktree\] removed .*/\.worktrees/task-postflight on moe/task/task-postflight\r?$') { Stop-Wt14 'WT14A' 'no [worktree] removed line' }
    Assert-Wt14Gone 'WT14A' 'task-postflight'
    Assert-Wt14Sentinels 'WT14A'
    $wt14Run++
    Write-Host '[scenario WT14A] ok'

    # Git for Windows exits 0 and leaves W on disk when W holds a junction no manifest
    # lists. pnpm's layout: real node_modules directories holding junctions, one to a
    # package inside W and one out to a store beside it.
    Write-Host '[scenario WT14N] a W holding junctions no manifest lists is removed from disk; the store a junction points at keeps its bytes'
    New-Wt14Fixture 'n' 'moe/control' @('task-postflight')
    New-Item -ItemType Directory -Force -Path (Join-Path $wt14.P '.git\info') | Out-Null
    [IO.File]::AppendAllText((Join-Path $wt14.P '.git\info\exclude'), "node_modules/`n")
    $wt14Dep = Join-Path (Get-Wt14W) 'node_modules\.pnpm\dep@1\node_modules\dep'
    New-Item -ItemType Directory -Force -Path $wt14Dep, (Join-Path (Get-Wt14W) 'src\node_modules') | Out-Null
    [IO.File]::WriteAllText((Join-Path $wt14Dep 'index.js'), "dep`n")
    $wt14Store = Join-Path $tempRoot 'wt14-n-store'
    New-Item -ItemType Directory -Force -Path $wt14Store | Out-Null
    [IO.File]::WriteAllText((Join-Path $wt14Store 'keep.js'), "store`n")
    foreach ($wt14J in @(@((Join-Path (Get-Wt14W) 'src\node_modules\dep'), $wt14Dep), @((Join-Path (Get-Wt14W) 'node_modules\store'), $wt14Store))) {
        $null = New-Item -ItemType Junction -Path $wt14J[0] -Target $wt14J[1]
        $wt14Links.Add($wt14J[0])
    }
    Invoke-Wt14Qa 'WT14N'
    if ($wt14.Text -cnotmatch '(?m)^\[worktree\] removed .*/\.worktrees/task-postflight on moe/task/task-postflight\r?$') { Stop-Wt14 'WT14N' 'no [worktree] removed line' }
    Assert-Wt14Gone 'WT14N' 'task-postflight'
    Assert-Wt14Bytes 'WT14N' (Join-Path $wt14Store 'keep.js') "store`n" 'the store behind a junction lost its bytes'
    Assert-Wt14Sentinels 'WT14N'
    $wt14Run++
    Write-Host '[scenario WT14N] ok'

    Write-Host '[scenario WT14B] a fully landed W holding .moe/x keeps W, its branch, its manifest and .moe/x'
    New-Wt14Fixture 'b' 'moe/control' @('task-postflight')
    New-Item -ItemType Directory -Force -Path (Join-Path (Get-Wt14W) '.moe') | Out-Null
    [IO.File]::WriteAllText((Join-Path (Get-Wt14W) '.moe\x'), "x`n")
    Invoke-Wt14Qa 'WT14B'
    Assert-Wt14Left 'WT14B' 'MOE_WORKTREE_MOE_PRESENT'
    Assert-Wt14Kept 'WT14B' 'task-postflight'
    Assert-Wt14Bytes 'WT14B' (Join-Path (Get-Wt14W) '.moe\x') "x`n" 'W/.moe/x lost its bytes'
    Assert-Wt14Sentinels 'WT14B'
    $wt14Run++
    Write-Host '[scenario WT14B] ok'

    Write-Host '[scenario WT14C] a W with a modified tracked file is left to the orphan sweep'
    New-Wt14Fixture 'c' 'moe/control' @('task-postflight')
    [IO.File]::WriteAllText((Join-Path (Get-Wt14W) 'src\task-postflight.txt'), "edited`n")
    Invoke-Wt14Qa 'WT14C'
    Assert-Wt14Left 'WT14C' 'non-DENY dirty path'
    Assert-Wt14Kept 'WT14C' 'task-postflight'
    Assert-Wt14Bytes 'WT14C' (Join-Path (Get-Wt14W) 'src\task-postflight.txt') "edited`n" 'the edit lost its bytes'
    Assert-Wt14Sentinels 'WT14C'
    $wt14Run++
    Write-Host '[scenario WT14C] ok'

    Write-Host '[scenario WT14U] a W whose branch holds an unlanded commit is left to the orphan sweep'
    New-Wt14Fixture 'u' 'moe/control' @('task-postflight')
    [IO.File]::WriteAllText((Join-Path (Get-Wt14W) 'src\unlanded.txt'), "unlanded`n")
    $null = Invoke-Wt14Git (Get-Wt14W) @('add', 'src/unlanded.txt')
    $null = Invoke-Wt14Git (Get-Wt14W) @('commit', '-qm', 'unlanded')
    Invoke-Wt14Qa 'WT14U'
    Assert-Wt14Left 'WT14U' 'moe/task/task-postflight is not fully landed in main'
    Assert-Wt14Kept 'WT14U' 'task-postflight'
    Assert-Wt14Sentinels 'WT14U'
    $wt14Run++
    Write-Host '[scenario WT14U] ok'

    # The unlink fails: the current user is denied DELETE on the junction itself (/L) and
    # DELETE_CHILD on its parent, both removed again before any assertion.
    Write-Host '[scenario WT14D] an unlink that fails refuses with MOE_WORKTREE_REMOVE_REFUSED and keeps W registered'
    New-Wt14Fixture 'd' 'moe/control' @('task-postflight')
    $wt14Sid = '*' + [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $wt14J = Join-Path (Get-Wt14W) '.serena\memories'
    $wt14Acl = @(@($wt14J, "${wt14Sid}:(DE)", '/L'), @((Split-Path -Parent $wt14J), "${wt14Sid}:(DC)"))
    try {
        foreach ($a in $wt14Acl) {
            $rc = Invoke-Wt14Icacls (@($a[0], '/deny') + @($a | Select-Object -Skip 1))
            if ($rc -ne 0) { throw "WT-14 FAILED (WT14D): icacls /deny on $($a[0]) exited $rc" }
        }
        Invoke-Wt14Qa 'WT14D'
    } finally {
        foreach ($a in $wt14Acl) { $null = Invoke-Wt14Icacls (@($a[0], '/remove:d', $wt14Sid) + @($a | Select-Object -Skip 2)) }
    }
    if ($wt14.Text -cnotmatch 'MOE_WORKTREE_REMOVE_REFUSED: .*/\.worktrees/task-postflight: .*\.serena/memories') { Stop-Wt14 'WT14D' 'no REMOVE_REFUSED line naming the link' }
    if ($wt14.Text.Contains('[worktree] removed')) { Stop-Wt14 'WT14D' 'a refused removal printed a removed line' }
    Assert-Wt14Kept 'WT14D' 'task-postflight'
    Assert-Wt14Sentinels 'WT14D'
    $wt14Run++
    Write-Host '[scenario WT14D] ok'

    Write-Host '[scenario WT14S] a shared-mode control checkout removes nothing and prints no worktree line'
    New-Wt14Fixture 's' 'moe/work-wt14' @('task-postflight')
    Invoke-Wt14Qa 'WT14S'
    if ($wt14.Text -cmatch 'MOE_WORKTREE_|\[worktree\]') { Stop-Wt14 'WT14S' 'shared mode printed a MOE_WORKTREE_ or [worktree] line' }
    Assert-Wt14Kept 'WT14S' 'task-postflight'
    Assert-Wt14Sentinels 'WT14S'
    $wt14Run++
    Write-Host '[scenario WT14S] ok'

    # The orphan sweep: one idle seat (no claim, a 5s taskless wait), so the loop top's sweep
    # is all a run does. The interval is unset unless a case passes it; FAKE_TASK_STATUS_MAP
    # answers the status reads.
    function Invoke-Wt14Sweep([string]$Name, [hashtable]$Knobs) { Invoke-Wt14Seat $Name 'worker' (@{ FAKE_CLAIM_MODE = 'idle'; MOE_TASKLESS_WAIT_SEC = '5' } + $Knobs) }
    function Get-Wt14Rows([string]$Pattern) { @(Get-Content -LiteralPath (Join-Path $wt14.P '.moe\messages\chan-general.jsonl') | Where-Object { $_ -cmatch $Pattern }).Count }
    function Get-Wt14Rescues([string]$Prefix) { @(Invoke-Wt14Git $wt14.P @('for-each-ref', '--format=%(objectname) %(refname)', $Prefix)) }
    function Get-Wt14Removed { [regex]::Matches($wt14.Text, '\[worktree\] removed ').Count }

    Write-Host "[scenario WT14E] the sweep parks an unlanded commit and W's dirt on rescue refs, then removes W; an unknown task's W goes too"
    New-Wt14Fixture 'e' 'moe/control' @('task-e1', 'task-e2')
    $wt14W = Join-Path $wt14.P '.worktrees\task-e1'
    [IO.File]::WriteAllText((Join-Path $wt14W 'src\unlanded.txt'), "unlanded`n")
    $null = Invoke-Wt14Git $wt14W @('add', 'src/unlanded.txt')
    $null = Invoke-Wt14Git $wt14W @('commit', '-qm', 'unlanded')
    $wt14T = "$(Invoke-Wt14Git $wt14.P @('rev-parse', 'refs/heads/moe/task/task-e1'))"
    [IO.File]::WriteAllText((Join-Path $wt14W 'src\task-e1.txt'), "edited`n")
    [IO.File]::WriteAllText((Join-Path $wt14W 'src\new.txt'), "untracked`n")
    Invoke-Wt14Sweep 'WT14E' @{ MOE_WORKTREE_SWEEP_INTERVAL_SEC = '0'; FAKE_TASK_STATUS_MAP = 'task-e1=DONE,task-e2=NOT_FOUND' }
    $wt14Refs = Get-Wt14Rescues 'refs/moe/rescue/task-e1/'
    if (@($wt14Refs | Where-Object { $_.StartsWith("$wt14T ") }).Count -ne 1) { Stop-Wt14 'WT14E' "no single rescue ref at the unlanded commit ${wt14T}: $wt14Refs" }
    if ((Get-Wt14Rows "MOE_RESCUE_REF task=task-e1 ref=refs/moe/rescue/task-e1/[^ ]+ sha=$wt14T reason=worktree-orphan") -lt 1) { Stop-Wt14 'WT14E' 'no #general MOE_RESCUE_REF row for the unlanded commit' }
    $wt14D = @($wt14Refs | Where-Object { -not $_.StartsWith("$wt14T ") } | ForEach-Object { $_.Split(' ')[1] })
    if ($wt14D.Count -ne 1) { Stop-Wt14 'WT14E' "no single second rescue ref for W's dirt: $wt14Refs" }
    if ("$(Invoke-Wt14Git $wt14.P @('rev-parse', "$($wt14D[0])^"))" -cne $wt14T -or "$(Invoke-Wt14Git $wt14.P @('show', "$($wt14D[0]):src/task-e1.txt"))" -cne 'edited' -or
            "$(Invoke-Wt14Git $wt14.P @('show', "$($wt14D[0]):src/new.txt"))" -cne 'untracked') { Stop-Wt14 'WT14E' "the dirt ref $($wt14D[0]) does not hold both dirty files on the unlanded commit" }
    if ((Get-Wt14Rescues 'refs/moe/rescue/task-e2/').Count -ne 0) { Stop-Wt14 'WT14E' 'a clean, landed W got a rescue ref' }
    if ((Get-Wt14Removed) -ne 2) { Stop-Wt14 'WT14E' 'not exactly two removed lines' }
    foreach ($wt14Tid in 'task-e1', 'task-e2') { Assert-Wt14Gone 'WT14E' $wt14Tid }
    Assert-Wt14Sentinels 'WT14E'
    $wt14Run++
    Write-Host '[scenario WT14E] ok'

    Write-Host '[scenario WT14F] at most 5 removals a pass; WORKING, an open attempt and W/.moe are kept; a held lock skips the pass, a 3h-old one is broken'
    New-Wt14Fixture 'f' 'moe/control' @('task-a1', 'task-d1', 'task-d2', 'task-d3', 'task-d4', 'task-d5', 'task-d6', 'task-m1', 'task-w1')
    $wt14Att = Join-Path $wt14.P '.moe\attempts'
    New-Item -ItemType Directory -Force -Path $wt14Att, (Join-Path $wt14.P '.worktrees\task-m1\.moe') | Out-Null
    [IO.File]::WriteAllText((Join-Path $wt14Att 'attempt-a1.json'), '{"id":"attempt-a1","taskId":"task-a1","workerId":"worker-x","generation":1,"phase":"running"}')
    [IO.File]::WriteAllText((Join-Path $wt14Att 'attempt-d0.json'), '{"id":"attempt-d0","taskId":"task-d1","workerId":"worker-x","generation":1,"phase":"closed"}')
    [IO.File]::WriteAllText((Join-Path $wt14.P '.worktrees\task-m1\.moe\x'), "m1`n")
    $wt14Map = @{ MOE_WORKTREE_SWEEP_INTERVAL_SEC = '0'; FAKE_TASK_STATUS_MAP = 'task-a1=DONE,task-d1=DONE,task-d2=DONE,task-d3=DONE,task-d4=DONE,task-d5=DONE,task-d6=ARCHIVED,task-m1=DONE,task-w1=WORKING' }
    Invoke-Wt14Sweep 'WT14F' $wt14Map
    if ((Get-Wt14Removed) -ne 5) { Stop-Wt14 'WT14F' 'not exactly five removed lines in one pass' }
    foreach ($wt14Tid in 'task-d1', 'task-d2', 'task-d3', 'task-d4', 'task-d5') { Assert-Wt14Gone 'WT14F' $wt14Tid }
    foreach ($wt14Tid in 'task-d6', 'task-a1', 'task-m1', 'task-w1') { Assert-Wt14Kept 'WT14F' $wt14Tid }
    $wt14Lock = "$(Get-Wt14Admin)/sweep.lock"
    New-Item -ItemType Directory -Path $wt14Lock | Out-Null
    Invoke-Wt14Sweep 'WT14F' $wt14Map
    if (-not $wt14.Text.Contains('[worktree] sweep skipped: lock held')) { Stop-Wt14 'WT14F' 'a held lock did not skip the pass' }
    if (-not (Test-Path -LiteralPath $wt14Lock -PathType Container)) { Stop-Wt14 'WT14F' 'a held lock was taken over' }
    Assert-Wt14Kept 'WT14F' 'task-d6'
    (Get-Item -LiteralPath $wt14Lock).LastWriteTime = (Get-Date).AddHours(-3)
    Invoke-Wt14Sweep 'WT14F' $wt14Map
    if ($wt14.Text.Contains('sweep skipped')) { Stop-Wt14 'WT14F' 'a 3h-old lock was not broken' }
    if (Test-Path -LiteralPath $wt14Lock) { Stop-Wt14 'WT14F' 'the sweep left its lock behind' }
    if ($wt14.Text -cnotmatch '\[worktree\] sweep left .*/\.worktrees/task-m1: W/\.moe exists \(MOE_WORKTREE_MOE_PRESENT\)') { Stop-Wt14 'WT14F' 'no sweep-left line for W/.moe' }
    Assert-Wt14Gone 'WT14F' 'task-d6'
    foreach ($wt14Tid in 'task-a1', 'task-m1', 'task-w1') { Assert-Wt14Kept 'WT14F' $wt14Tid }
    Assert-Wt14Bytes 'WT14F' (Join-Path $wt14.P '.worktrees\task-m1\.moe\x') "m1`n" 'W/.moe/x lost its bytes'
    if ((Get-Wt14Rescues 'refs/moe/rescue/').Count -ne 0) { Stop-Wt14 'WT14F' 'a clean, landed W got a rescue ref' }
    Assert-Wt14Sentinels 'WT14F'
    $wt14Run++
    Write-Host '[scenario WT14F] ok'

    Write-Host '[scenario WT14G] an unregistered .worktrees/task-* directory is named and alerted once a day; .worktrees/stray is not'
    New-Wt14Fixture 'g' 'moe/control'
    foreach ($wt14Nm in 'stray', 'task-ghost') {
        New-Item -ItemType Directory -Force -Path (Join-Path $wt14.P ".worktrees\$wt14Nm") | Out-Null
        [IO.File]::WriteAllText((Join-Path $wt14.P ".worktrees\$wt14Nm\f.txt"), "$wt14Nm`n")
    }
    foreach ($wt14N in 1, 2) {
        Invoke-Wt14Sweep 'WT14G' @{ MOE_WORKTREE_SWEEP_INTERVAL_SEC = '0' }
        if ($wt14.Text -cnotmatch 'MOE_WORKTREE_UNREGISTERED: .*/\.worktrees/task-ghost: not a registered worktree; left on disk') { Stop-Wt14 'WT14G' "run ${wt14N}: no MOE_WORKTREE_UNREGISTERED line for task-ghost" }
        if ($wt14.Text.Contains('stray')) { Stop-Wt14 'WT14G' "run ${wt14N}: a line names .worktrees/stray" }
    }
    if ((Get-Wt14Rows 'MOE_WORKTREE_UNREGISTERED: ') -ne 1) { Stop-Wt14 'WT14G' 'not exactly one #general alert across two runs' }
    if ((Get-Wt14Rows 'stray') -ne 0) { Stop-Wt14 'WT14G' 'an alert names .worktrees/stray' }
    foreach ($wt14Nm in 'stray', 'task-ghost') { Assert-Wt14Bytes 'WT14G' (Join-Path $wt14.P ".worktrees\$wt14Nm\f.txt") "$wt14Nm`n" 'an unregistered directory lost its bytes' }
    Assert-Wt14Sentinels 'WT14G'
    $wt14Run++
    Write-Host '[scenario WT14G] ok'

    Write-Host '[scenario WT14H] a failed status read aborts the pass; the interval holds a fresh stamp back; a bad interval warns and uses 3600'
    New-Wt14Fixture 'h' 'moe/control' @('task-h1', 'task-h2')
    $wt14Done = 'task-h1=DONE,task-h2=DONE'
    Invoke-Wt14Sweep 'WT14H' @{ MOE_WORKTREE_SWEEP_INTERVAL_SEC = '0'; FAKE_TASK_STATUS_MAP = 'task-h1=FAIL,task-h2=DONE' }
    if (-not $wt14.Text.Contains('the worktree sweep stopped')) { Stop-Wt14 'WT14H' 'a failed status read did not stop the pass' }
    foreach ($wt14Tid in 'task-h1', 'task-h2') { Assert-Wt14Kept 'WT14H' $wt14Tid }
    if ((Get-Wt14Rescues 'refs/moe/rescue/').Count -ne 0) { Stop-Wt14 'WT14H' 'an aborted pass wrote a rescue ref' }
    $wt14Now = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
    [IO.File]::WriteAllText("$(Get-Wt14Admin)/sweep.last", "$wt14Now`n")
    Invoke-Wt14Sweep 'WT14H' @{ FAKE_TASK_STATUS_MAP = $wt14Done }
    if ($wt14.Text -cmatch 'MOE_WORKTREE_|\[worktree\]') { Stop-Wt14 'WT14H' 'an unset interval swept within the hour' }
    Invoke-Wt14Sweep 'WT14H' @{ MOE_WORKTREE_SWEEP_INTERVAL_SEC = 'abc'; FAKE_TASK_STATUS_MAP = $wt14Done }
    if (-not $wt14.Text.Contains("MOE_WORKTREE_SWEEP_INTERVAL_SEC='abc'")) { Stop-Wt14 'WT14H' 'no [WARN] for an invalid interval' }
    if ($wt14.Text.Contains('[worktree]')) { Stop-Wt14 'WT14H' 'an invalid interval swept within the hour' }
    foreach ($wt14Tid in 'task-h1', 'task-h2') { Assert-Wt14Kept 'WT14H' $wt14Tid }
    [IO.File]::WriteAllText("$(Get-Wt14Admin)/sweep.last", "$($wt14Now - 3601)`n")
    Invoke-Wt14Sweep 'WT14H' @{ MOE_WORKTREE_SWEEP_INTERVAL_SEC = 'abc'; FAKE_TASK_STATUS_MAP = $wt14Done }
    foreach ($wt14Tid in 'task-h1', 'task-h2') { Assert-Wt14Gone 'WT14H' $wt14Tid }
    Assert-Wt14Sentinels 'WT14H'
    $wt14Run++
    Write-Host '[scenario WT14H] ok'

    Write-Host '[scenario WT14I] registered .worktrees/feature-x and .worktrees/task-z on their own branches and an unregistered .worktrees/scratch are never touched or named'
    New-Wt14Fixture 'i' 'moe/control'
    $null = Invoke-Wt14Git $wt14.P @('worktree', 'add', '-q', '-b', 'feature-x', (Join-Path $wt14.P '.worktrees\feature-x'), 'main')
    $null = Invoke-Wt14Git $wt14.P @('worktree', 'add', '-q', '-b', 'feature-z', (Join-Path $wt14.P '.worktrees\task-z'), 'main')
    [IO.File]::WriteAllText((Join-Path $wt14.P '.worktrees\feature-x\wip.txt'), "wip`n")
    New-Item -ItemType Directory -Force -Path (Join-Path $wt14.P '.worktrees\scratch') | Out-Null
    [IO.File]::WriteAllText((Join-Path $wt14.P '.worktrees\scratch\f.txt'), "scratch`n")
    Invoke-Wt14Sweep 'WT14I' @{ MOE_WORKTREE_SWEEP_INTERVAL_SEC = '0'; FAKE_TASK_STATUS_MAP = 'feature-x=DONE,task-z=DONE' }
    if ($wt14.Text -cmatch 'MOE_WORKTREE_|\[worktree\]') { Stop-Wt14 'WT14I' 'the sweep named something outside its candidates' }
    if ((Get-Wt14Rows 'MOE_WORKTREE_|MOE_RESCUE_REF|feature-|task-z|scratch') -ne 0) { Stop-Wt14 'WT14I' 'the sweep posted to #general' }
    foreach ($wt14B in @(@('feature-x', 'feature-x'), @('task-z', 'feature-z'))) {
        if (-not (Test-Wt14Listed $wt14B[0]) -or @(Invoke-Wt14Git $wt14.P @('for-each-ref', "refs/heads/$($wt14B[1])")).Count -ne 1) { Stop-Wt14 'WT14I' "$($wt14B[0]) or its branch $($wt14B[1]) was touched" }
    }
    Assert-Wt14Bytes 'WT14I' (Join-Path $wt14.P '.worktrees\feature-x\wip.txt') "wip`n" 'feature-x was touched'
    Assert-Wt14Bytes 'WT14I' (Join-Path $wt14.P '.worktrees\scratch\f.txt') "scratch`n" 'scratch was touched'
    if ((Get-Wt14Rescues 'refs/moe/rescue/').Count -ne 0) { Stop-Wt14 'WT14I' 'a rescue ref was written' }
    Assert-Wt14Sentinels 'WT14I'
    $wt14Run++
    Write-Host '[scenario WT14I] ok'

    foreach ($l in $wt14Links) { if (Test-Wt14Link $l) { [IO.Directory]::Delete($l) } }
    if ($wt14Run -ne 12) { throw "Expected 12 WT-14 scenarios (WT14A, WT14N, WT14B, WT14C, WT14U, WT14D, WT14S, WT14E, WT14F, WT14G, WT14H, WT14I); ran $wt14Run" }
    Write-Host "[WT-14] ok: $wt14Run scenarios"

    # --- A protected launch (MOE_RUNTIME_PROTECTED exactly '1', which the
    # JetBrains launcher sets beside MOE_PROXY_PATH and MOE_DAEMON_PATH) runs
    # exactly those files or refuses before any MCP config, daemon, proxy or
    # CLI. It never falls back to its own root or the global install; any other
    # marker value stays legacy (CQ-R13c2). Every fixture and decoy appends one
    # line to $prMarks. PowerShell cannot hold an empty variable, so P5 is unset.
    # Twin: the [protected runtime] case in postflight.sh. ---
    Write-Host '[protected runtime] a protected launch runs the exact runtime paths or refuses'
    $prRoot = Join-Path $tempRoot 'protected'
    $prProject = Join-Path $prRoot 'project'
    $prHome = Join-Path $prRoot 'home'
    $prMarks = Join-Path $prRoot 'marks'
    $prMarkedProxy = Join-Path $prRoot 'marked-proxy.js'
    $prDaemon = Join-Path $prRoot 'fake-daemon.js'
    $prDir = Join-Path $prRoot 'dir.js'
    $prNoProxy = Join-Path $prRoot 'missing\proxy.js'
    $prNoDaemon = Join-Path $prRoot 'missing\daemon.js'
    foreach ($d in @((Join-Path $prProject '.moe\messages'), (Join-Path $prHome '.moe'), $prDir)) { New-Item -ItemType Directory -Force -Path $d | Out-Null }
    [IO.File]::WriteAllText((Join-Path $prProject '.moe\project.json'), '{"id":"proj-protected","name":"postflight-protected","settings":{"autoCommit":false}}')
    [IO.File]::WriteAllText((Join-Path $prProject '.moe\messages\chan-general.jsonl'), '')
    [IO.File]::WriteAllText((Join-Path $prProject 'rel-proxy.js'), "require('fs').appendFileSync(require('path').join(__dirname,'..','marks'),'relative-proxy\n');`n")
    $prMark = "require('fs').appendFileSync(require('path').join(__dirname,'marks'),"
    $proxyBody = [IO.File]::ReadAllText($fakeProxy)
    [IO.File]::WriteAllText($prMarkedProxy, "$prMark'protected-proxy\n');`n" + $proxyBody)
    $prVanishProxy = Join-Path $prRoot 'vanish-proxy.js'
    [IO.File]::WriteAllText($prVanishProxy, "$prMark'vanish-proxy\n');require('fs').unlinkSync(__filename);`n" + $proxyBody)
    # process.ppid is the wrapper, which outlives the start poll that probes this pid.
    [IO.File]::WriteAllText($prDaemon, ("$prMark'protected-daemon '+process.argv.slice(2).join(' ')+'\n');`n" +
        "const p=process.argv[process.argv.indexOf('--project')+1];`n" +
        "require('fs').writeFileSync(require('path').join(p,'.moe','daemon.json'),JSON.stringify({port:9876,pid:process.ppid,startedAt:new Date().toISOString(),projectPath:p}));`n"))
    # The decoy global install: its proxy records, then serves, so legacy P7 runs.
    $prDecoy = "require('fs').appendFileSync(require('path').join(__dirname,'..','..','..','..','marks'),"
    foreach ($pkg in @('moe-daemon', 'moe-proxy')) {
        $prDist = Join-Path $prRoot "install\packages\$pkg\dist"
        New-Item -ItemType Directory -Force -Path $prDist | Out-Null
        $prBody = if ($pkg -eq 'moe-proxy') { "$prDecoy'decoy-proxy\n');`n" + $proxyBody } else { "$prDecoy'decoy-install-moe-daemon\n');process.exit(1);`n" }
        [IO.File]::WriteAllText((Join-Path $prDist 'index.js'), $prBody)
    }
    [IO.File]::WriteAllText((Join-Path $prHome '.moe\config.json'), ('{"installPath":' + (ConvertTo-Json (Join-Path $prRoot 'install')) + '}'))
    # A protected launch runs only a known CLI by name, from PATH outside the project.
    $prBin = Join-Path $prRoot 'bin'
    New-Item -ItemType Directory -Force -Path $prBin | Out-Null
    Set-Content -Path (Join-Path $prBin 'claude.cmd') -Encoding ASCII -Value "@echo off`r`nexit /b 0`r`n"
    $prSaved = @{}
    foreach ($n in @('MOE_RUNTIME_PROTECTED', 'MOE_PROXY_PATH', 'MOE_DAEMON_PATH', 'USERPROFILE', 'TEMP', 'TMP', 'FAKE_CLAIM_MODE', 'MOE_TASKLESS_WAIT_SEC', 'MOE_DISABLE_HEARTBEAT', 'PATH')) { $prSaved[$n] = [Environment]::GetEnvironmentVariable($n) }
    $env:PATH = $prBin + [IO.Path]::PathSeparator + $env:PATH
    # Invoke-PrRow ROW MARKER PROXY DAEMON LIVE [EXTRA] -- MARKER '-' leaves it
    # unset. LIVE 'live' writes a running daemon's daemon.json, as in a real
    # protected launch.
    function Invoke-PrRow([string]$Row, [string]$Marker, [string]$Proxy, [string]$Daemon, [string]$Live, [string[]]$Extra = @()) {
        Remove-Item -LiteralPath $prMarks, (Join-Path $prProject '.moe\daemon.json') -Force -ErrorAction SilentlyContinue
        if ($Live -eq 'live') { [IO.File]::WriteAllText((Join-Path $prProject '.moe\daemon.json'), ('{"port":9876,"projectPath":' + (ConvertTo-Json $prProject) + '}')) }
        $tmp = Join-Path $prRoot "tmp-$Row"
        New-Item -ItemType Directory -Force -Path $tmp | Out-Null
        $env:MOE_RUNTIME_PROTECTED = if ($Marker -eq '-') { $null } else { $Marker }
        $env:MOE_PROXY_PATH = $Proxy; $env:MOE_DAEMON_PATH = $Daemon
        $env:USERPROFILE = $prHome; $env:TEMP = $tmp; $env:TMP = $tmp
        $env:FAKE_CLAIM_MODE = 'idle'; $env:MOE_TASKLESS_WAIT_SEC = '5'; $env:MOE_DISABLE_HEARTBEAT = '1'
        $out = Join-Path $prRoot "$Row.out"
        $code = Invoke-WrapperProcess (@('-Project', $prProject, '-WorkerId', 'worker-protected', '-Role', 'worker', '-Command', 'claude', '-NoLoop') + $Extra) $out
        [pscustomobject]@{ Row = $Row; Code = $code; Tmp = $tmp; Text = [string](Get-Content -Raw -LiteralPath $out -ErrorAction SilentlyContinue) }
    }
    function Stop-Pr($R, [string]$Why) { Write-Host $R.Text; throw "PROTECTED RUNTIME FAILED ($($R.Row)): $Why" }
    function Get-PrMarks { if (Test-Path -LiteralPath $prMarks) { @([IO.File]::ReadAllLines($prMarks)) } else { @() } }
    # Exit 1 with one refusal line naming VAR, no value printed, nothing run
    # and no MCP temp config written.
    function Assert-PrRefused($R, [string]$Var, [string[]]$Values) {
        if ($R.Code -ne 1) { Stop-Pr $R "exit $($R.Code), expected 1" }
        $sentence = "MOE_RUNTIME_PROTECTED_PATH_MISSING: $Var must be an absolute path to an existing file when MOE_RUNTIME_PROTECTED=1; refusing to start."
        $lines = @($R.Text -split "`r?`n" | Where-Object { $_.Contains('MOE_RUNTIME_PROTECTED_PATH_MISSING') })
        if ($lines.Count -ne 1 -or -not $lines[0].Contains($sentence)) { Stop-Pr $R "not exactly one refusal line naming $Var" }
        foreach ($v in $Values) { if ($R.Text.IndexOf($v, [StringComparison]::OrdinalIgnoreCase) -ge 0) { Stop-Pr $R "the output prints $v" } }
        if (Test-Path -LiteralPath $prMarks) { Stop-Pr $R ('something ran: ' + ((Get-PrMarks) -join ' ')) }
        if (@(Get-ChildItem -LiteralPath $R.Tmp -Filter 'moe-mcp-config-*').Count -ne 0) { Stop-Pr $R 'an MCP config was written' }
    }
    # Exit 0, no refusal, and each wanted line is in the marks file.
    function Assert-PrRan($R, [string[]]$Want) {
        if ($R.Code -ne 0) { Stop-Pr $R "exit $($R.Code), expected 0" }
        if ($R.Text.Contains('MOE_RUNTIME_PROTECTED_PATH_MISSING')) { Stop-Pr $R 'refused' }
        $marks = Get-PrMarks
        foreach ($w in $Want) { if ($marks -notcontains $w) { Stop-Pr $R "marks lack '$w'" } }
    }
    try {
        Assert-PrRefused (Invoke-PrRow 'P1' '1' $prNoProxy $prDaemon 'live') 'MOE_PROXY_PATH' @($prNoProxy, $prDaemon)
        Assert-PrRefused (Invoke-PrRow 'P2' '1' $prMarkedProxy $prNoDaemon 'live') 'MOE_DAEMON_PATH' @($prMarkedProxy, $prNoDaemon)
        # Start-Process starts the wrapper in the current location, where rel-proxy.js exists.
        Push-Location -LiteralPath $prProject
        try { $r = Invoke-PrRow 'P3' '1' 'rel-proxy.js' $prDaemon 'live' } finally { Pop-Location }
        Assert-PrRefused $r 'MOE_PROXY_PATH' @('rel-proxy.js', $prDaemon)
        Assert-PrRefused (Invoke-PrRow 'P4' '1' $prMarkedProxy $prDir 'live') 'MOE_DAEMON_PATH' @($prMarkedProxy, $prDir)
        Assert-PrRefused (Invoke-PrRow 'P5' '1' '' $prDaemon 'live') 'MOE_PROXY_PATH' @($prDaemon)
        $r = Invoke-PrRow 'P6' '1' $prMarkedProxy $prDaemon 'none'
        Assert-PrRan $r @("protected-daemon start --project $prProject", 'protected-proxy')
        if (@(Get-PrMarks | Where-Object { $_.StartsWith('decoy') }).Count -ne 0) { Stop-Pr $r ('a decoy ran: ' + ((Get-PrMarks) -join ' ')) }
        Assert-PrRan (Invoke-PrRow 'P7' '-' $prNoProxy $prDaemon 'none' @('-NoStartDaemon')) @('decoy-proxy')
        Assert-PrRan (Invoke-PrRow 'P8' '01' $prMarkedProxy $prNoDaemon 'none' @('-NoStartDaemon')) @('protected-proxy')
        # P9: the protected proxy deletes itself on its first call, after the gate.
        # No later RPC, including the exit-time deregister, may fall back.
        $r = Invoke-PrRow 'P9' '1' $prVanishProxy $prDaemon 'live' @('-NoStartDaemon')
        if ((Test-Path -LiteralPath $prVanishProxy) -or (@(Get-PrMarks | Sort-Object -Unique) -join ' ') -cne 'vanish-proxy') { Stop-Pr $r ("marks are '" + ((Get-PrMarks) -join ' ') + "', not the vanished proxy alone") }
    } finally {
        foreach ($n in $prSaved.Keys) { [Environment]::SetEnvironmentVariable($n, $prSaved[$n]) }
    }
    Write-Host '[protected runtime] ok'

    & $psExe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'postflight-vm-route.ps1')
    if ($LASTEXITCODE -ne 0) { throw 'VM route scenarios failed' }
    Write-Host 'PASS postflight.ps1'
} catch {
    # CI keeps raw fixture output private. Emit only a line in this harness so
    # its safe runner can identify an assertion without exposing error values.
    if ($_.InvocationInfo.ScriptName -eq $PSCommandPath -and $_.InvocationInfo.ScriptLineNumber -gt 0) {
        [Console]::Error.WriteLine(('MOE_POSTFLIGHT_FAILURE_LINE=' + $_.InvocationInfo.ScriptLineNumber))
    }
    Write-Error $_
    exit 1
} finally {
    foreach ($m2pid in $script:M2LivePids) {
        try { Stop-Process -Id $m2pid -Force -ErrorAction SilentlyContinue } catch {}
    }
    # MOE_POSTFLIGHT_KEEP_TEMP=1 keeps the throwaway repos + wrapper logs for
    # post-mortem inspection of a failing scenario.
    if ($env:MOE_POSTFLIGHT_KEEP_TEMP -eq '1') {
        Write-Host "postflight.ps1: temp kept at $tempRoot"
    } else {
        Remove-Item -Recurse -Force -LiteralPath $tempRoot -ErrorAction SilentlyContinue
    }
}
