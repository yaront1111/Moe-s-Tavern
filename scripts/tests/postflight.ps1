param()
$ErrorActionPreference = 'Stop'

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

    # Fake daemon+proxy: one node process per RPC, steered only by FAKE_* env
    # vars. Twin of the script in postflight.sh — keep the two in step.
    #   FAKE_CLAIM_MODE=resume|blocked   claim_next_task returns alreadyAssigned
    #   FAKE_TASK_STATUS                 status get_context/list_tasks report
    #   FAKE_GET_CONTEXT_FAIL=empty|mismatch
    #   FAKE_SIBLING_ORDER, FAKE_LIST_TASKS_TRUNCATED   (epic-final / pagination)
    #   FAKE_CTX_IS_EPIC_FINAL=true|false                daemon-computed
    #                                    isEpicFinal in get_context (unset =
    #                                    old daemon); FAKE_CTX_IS_EPIC_FINAL_AT=top
    #                                    serves it top-level instead of task-level
    #   FAKE_SCOPE_ASSERTED / FAKE_SCOPE_PLANNED         comma lists overriding
    #                                    the on-disk record's declared sets
    #   FAKE_SCOPE_PEER_DECLARED         "path:taskId,..." overriding the peer
    #                                    union read from the other records
    #   FAKE_SCOPE_PEERS_ACTIVE=1        another worker is live (livePeerIds)
    #   FAKE_SCOPE_ASSIGNED              assignedWorkerId reported by the scope
    # Side effects: chat_send -> .moe/messages/<channel>.jsonl, heartbeat ->
    # .moe/heartbeat.log, record_commit -> .moe/record_commit.jsonl.
    $fakeProxy = Join-Path $tempRoot 'fake-proxy.js'
    Set-Content -Path $fakeProxy -Encoding UTF8 -Value @'
const fs = require('fs');
const path = require('path');
const raw = fs.readFileSync(0, 'utf8').trim();
const req = raw ? JSON.parse(raw) : { id: 1, params: { name: '', arguments: {} } };
const tool = String(req.params?.name || '').replace(/^moe\./, '');
const args = req.params?.arguments || {};
const project = process.env.MOE_PROJECT_PATH || process.cwd();
const moe = path.join(project, '.moe');
function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); }
function ok(payload) {
  process.stdout.write(JSON.stringify({
    jsonrpc: '2.0',
    id: req.id || 1,
    result: { content: [{ type: 'text', text: JSON.stringify(payload) }] }
  }) + '\n');
}
function readTask(id) {
  // Set-Content -Encoding UTF8 on Windows PowerShell 5.1 writes a BOM, which
  // JSON.parse rejects — strip it.
  try { return JSON.parse(fs.readFileSync(path.join(moe, 'tasks', `${id}.json`), 'utf8').replace(/^﻿/, '')); } catch { return null; }
}
function strList(v) { return Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x) : []; }
function declaredSets(task) {
  const asserted = new Set();
  const planned = new Set();
  for (const s of (task.implementationPlan || [])) {
    if (!s) continue;
    if (s.status === 'COMPLETED') for (const p of (s.modifiedFiles || s.affectedFiles || [])) asserted.add(p);
    for (const p of [...strList(s.affectedFiles), ...strList(s.newFiles), ...strList(s.modifiedFiles)]) planned.add(p);
  }
  for (const p of [...strList(task.filesModified), ...strList(task.declaredFiles), ...strList(task.touchedFiles)]) asserted.add(p);
  for (const p of strList(task.inferredPaths)) planned.add(p);
  for (const p of asserted) planned.delete(p);
  return { asserted: [...asserted], planned: [...planned] };
}
function csv(v) { return String(v || '').split(',').map((s) => s.trim()).filter(Boolean); }

// Candidate/check/finalize recorder: reject invalid payloads instead of green
// mocks accepting arbitrary calls. This fixture never calls the live daemon.
const assert = require('node:assert/strict');
const rpcLog = path.join(moe, 'evidence-rpcs.jsonl');
const appendRpc = () => fs.appendFileSync(rpcLog, JSON.stringify({tool,args}) + '\n');
function readRows(file) {
  try { return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse); }
  catch (e) { if (e.code === 'ENOENT') return []; throw e; }
}
function attemptFixture() {
  const id = 'attempt-postflight', generation = 7;
  const taskId = process.env.FAKE_CLAIM_MODE === 'resume' ? 'task-resume' : 'task-postflight';
  ensureDir(path.join(moe, 'attempts'));
  const file = path.join(moe, 'attempts', id + '.json');
  // openAttempt records the runner's pair exactly as the claim sent it.
  // FAKE_ATTEMPT_PHASE=reconciling: a daemon restart parked the attempt before
  // the wrapper pinned it (the window a resume after a restart lands in).
  if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify({
    id, generation, taskId, workerId: args.workerId, runnerId: args.workerId,
    phase: process.env.FAKE_ATTEMPT_PHASE || 'running', workspace: project, startedAt: new Date().toISOString(), lastPhaseAt: new Date().toISOString(),
    ...(args.processStartedAt === undefined ? {} : {processStartedAt: args.processStartedAt, host: args.host})
  }));
  if (process.env.FROZEN_MODE === 'claim-missing' || process.env.FAKE_CLAIM_TOKENS === 'missing') return {};
  return {attemptId: id, generation: process.env.FROZEN_MODE === 'claim-malformed' ? '7' : generation};
}
const safeId = v => typeof v === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(v);
const sha = v => typeof v === 'string' && /^[a-f0-9]{40}$/.test(v);
function candidateReply() {
  let payload;
  const a = JSON.parse(fs.readFileSync(path.join(moe,'attempts',args.attemptId+'.json'),'utf8'));
  assert.equal(args.taskId,a.taskId); assert.equal(args.workerId,a.workerId);
  assert.equal(args.generation,a.generation); assert.notEqual(a.phase,'closed');
  assert.ok(safeId(args.id)); assert.ok(sha(args.treeSha)); assert.ok(sha(args.baseRevision));
  assert.match(args.deliveryTarget,/^refs\/heads\/.+/);
  const {generation,workerId,...candidate} = args;
  payload = {success:true,candidate:{...candidate,createdAt:new Date().toISOString()},duplicate:false};
  ensureDir(path.join(moe,'candidates'));
  const file = path.join(moe,'candidates',args.id+'.json');
  if (fs.existsSync(file)) {
    payload.candidate = JSON.parse(fs.readFileSync(file,'utf8')); payload.duplicate = true;
    for (const key of Object.keys(candidate)) assert.deepEqual(payload.candidate[key],candidate[key]);
  } else fs.writeFileSync(file,JSON.stringify(payload.candidate));
  return payload;
}
function checkReply() {
  let payload;
  const c = JSON.parse(fs.readFileSync(path.join(moe,'candidates',args.candidateId+'.json'),'utf8'));
  assert.equal(args.treeSha,c.treeSha); assert.ok(safeId(args.id)); assert.ok(safeId(args.runnerId));
  const tip = require('node:child_process').spawnSync('git',['-C',project,'rev-parse','--verify',c.deliveryTarget],{encoding:'utf8'});
  if(tip.status===0) assert.equal(tip.stdout.trim(),c.baseRevision,'CheckRun must persist before CAS');

  assert.equal(args.source,'runner-observed'); assert.ok(Number.isSafeInteger(args.exitCode));
  assert.ok(typeof args.command === 'string' && args.command.trim() && args.command.length <= 500);
  assert.ok(typeof args.outputTail === 'string' && Buffer.byteLength(args.outputTail,'utf8') <= 16384);
  assert.ok(!args.outputTail.includes('\ufffd'));
  const {workerId,...checkRun} = args;
  payload = {success:true,checkRun:{...checkRun,createdAt:new Date().toISOString()},duplicate:false};
  ensureDir(path.join(moe,'checks'));
  fs.writeFileSync(path.join(moe,'checks',args.id+'.json'),JSON.stringify(payload.checkRun));
  return payload;
}
function finalizeReply() {
  let payload;
  const mode = process.env.FAKE_EVIDENCE_MODE || '';
  const file = path.join(moe,'attempts',args.attemptId+'.json');
  const a = JSON.parse(fs.readFileSync(file,'utf8'));
  assert.equal(args.taskId,a.taskId); assert.equal(args.workerId,a.workerId);
  assert.equal(args.generation,a.generation); assert.ok(safeId(args.runnerId));
  assert.ok(['finalizing','closed'].includes(a.phase));
  assert.ok(['landed','nothing-to-commit','rescued','failed'].includes(args.outcome));
  if (args.outcome === 'landed') {
    assert.ok(sha(args.landedRevision));
    const rows = readRows(rpcLog);
    assert.ok(rows.some(r => r.tool === 'record_commit' && r.args.outcome === 'committed'
      && r.args.kind === 'completion' && r.args.sha === args.landedRevision));
  } else assert.equal(args.landedRevision,undefined);
  a.phase = 'closed'; fs.writeFileSync(file,JSON.stringify(a));
  payload = {success:true,taskId:a.taskId,attemptId:a.id,generation:a.generation,phase:'closed',
    outcome:args.outcome,landedRevision:args.landedRevision || null};
  if (mode === 'finalize-loss' || (mode === 'finalize-loss-once'
    && readRows(rpcLog).filter(r=>r.tool === tool).length === 1)) return null;
  return payload;
}
// receiptStore.ts in miniature: one receipt per candidate, an identical replay
// writes nothing (duplicate), a differing one is DELIVERY_RECEIPT_CONFLICT.
function receiptReply() {
  assert.ok(safeId(args.candidateId));
  assert.ok(typeof args.target === 'string' && args.target && args.target === args.target.trim() && args.target.length <= 255
    && [...args.target].every(ch => ch.charCodeAt(0) > 31 && ch.charCodeAt(0) !== 127));
  for (const key of ['targetBefore','targetAfter','landedRevision']) assert.ok(sha(args[key]), key);
  const receipt = {candidateId:args.candidateId,target:args.target,targetBefore:args.targetBefore,
    targetAfter:args.targetAfter,landedRevision:args.landedRevision,pushResult:args.pushResult ?? null};
  if (receipt.pushResult !== null) assert.ok(typeof receipt.pushResult === 'string' && receipt.pushResult.trim() && receipt.pushResult.length <= 2000);
  const file = path.join(moe,'receipts',args.candidateId+'.json');
  if (fs.existsSync(file)) {
    const stored = JSON.parse(fs.readFileSync(file,'utf8'));
    const differing = Object.keys(receipt).filter(key => stored[key] !== receipt[key]);
    if (differing.length) throw Object.assign(new Error('receipt differs in '+differing.join(', ')),{codeName:'DELIVERY_RECEIPT_CONFLICT'});
    return {success:true,receipt:stored,duplicate:true};
  }
  assert.ok(fs.existsSync(path.join(moe,'candidates',args.candidateId+'.json')),'CANDIDATE_NOT_FOUND');
  ensureDir(path.join(moe,'receipts'));
  fs.writeFileSync(file,JSON.stringify({id:'receipt-'+args.candidateId,...receipt}));
  return {success:true,receipt:{id:'receipt-'+args.candidateId,...receipt},duplicate:false};
}
// reattachAttempt.ts in miniature: the attempt id, generation, recorded process
// start time and host must all match exactly (nothing recorded never matches),
// and only a reconciling or already-running attempt returns to running.
// FAKE_REATTACH_REFUSE=1 refuses even a matching identity, as a stranger's.
function reattachReply() {
  for (const key of ['taskId','workerId','runnerId','attemptId','processStartedAt','host'])
    assert.ok(typeof args[key] === 'string' && args[key].trim(), key);
  assert.ok(Number.isSafeInteger(args.generation) && args.generation > 0, 'generation');
  const file = path.join(moe,'attempts',args.attemptId+'.json');
  if (!fs.existsSync(file)) throw Object.assign(new Error('Attempt not found: '+args.attemptId),{codeName:'ATTEMPT_NOT_FOUND'});
  const a = JSON.parse(fs.readFileSync(file,'utf8'));
  if (a.taskId !== args.taskId) throw Object.assign(new Error('Attempt '+a.id+' belongs to '+a.taskId),{codeName:'ATTEMPT_ID_TASK_MISMATCH'});
  const field = process.env.FAKE_REATTACH_REFUSE === '1' ? 'processStartedAt'
    : ['generation','processStartedAt','host'].find(key => a[key] === undefined || a[key] !== args[key]);
  if (field) throw Object.assign(new Error('Attempt '+a.id+' does not match the presented identity ('+field+' differs)'),{codeName:'ATTEMPT_IDENTITY_MISMATCH'});
  if (!['reconciling','running'].includes(a.phase)) throw Object.assign(new Error('Attempt '+a.id+' is in phase '+a.phase),{codeName:'ATTEMPT_NOT_REATTACHABLE'});
  a.phase = 'running'; fs.writeFileSync(file,JSON.stringify(a));
  return {success:true,attemptId:a.id,taskId:a.taskId,generation:a.generation,phase:'running'};
}
// Teardown arms hold ONE call until the supervisor has interrupted the wrapper:
// the post-flight landing's get_commit_scope (teardown-scope: no outcome yet), or
// the completion's ledger row once it reached one (teardown-landed: a branch CAS,
// teardown-nothing: nothing to commit). A proxy the interrupt kills never got its
// call through, so a held call is logged only once its hold is over.
function holdForInterrupt() {
  const mode = process.env.FAKE_EVIDENCE_MODE, ready = path.join(moe, 'gate-ready');
  const scope = mode === 'teardown-scope' && tool === 'get_commit_scope' && args.phase === 'postflight';
  const ledger = tool === 'record_commit' && args.kind === 'completion'
    && args.outcome === {'teardown-landed': 'committed', 'teardown-nothing': 'nothing'}[mode];
  if (!(scope || ledger) || fs.existsSync(ready)) return;
  fs.writeFileSync(ready, 'ready');
  for (let i = 0; i < 1200 && !fs.existsSync(ready + '.sent'); i++) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
}
// receipt-ledger-replay: the FIRST committed completion row is never recorded;
// the supervisor hard-kills the wrapper tree while its landing waits on it (a
// crash between update-ref and record_commit), so no log shows the call.
function holdLedgerForCrash() {
  const held = path.join(moe, 'ledger-held');
  if (process.env.FAKE_EVIDENCE_MODE !== 'receipt-ledger-replay' || tool !== 'record_commit' || args.outcome !== 'committed'
    || args.kind !== 'completion' || fs.existsSync(held)) return;
  fs.writeFileSync(held, 'held');
  for (let i = 0; i < 1200; i++) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  process.exit(1);
}
function evidenceRpc() {
  appendRpc();
  if (['record_commit','deregister_worker','add_comment'].includes(tool)) return false;
  const refusal = (message, codeName) => process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:req.id,
    error:{code:-32002,message,data:{codeName:codeName || 'FIXTURE_REFUSED'}}}) + '\n');
  const mode = process.env.FAKE_EVIDENCE_MODE || '';
  if (mode === tool + '-refuse') { refusal('fixture persistence refused'); return true; }
  if (mode === tool + '-null') { ok(null); return true; }
  if (mode === tool + '-malformed') { ok({success:true}); return true; }
  if (tool === 'record_delivery_receipt' && mode === 'receipt-refused') { refusal('fixture receipt refused'); return true; }
  if (tool === 'record_delivery_receipt' && mode === 'receipt-conflict') { refusal('fixture receipt conflict', 'DELIVERY_RECEIPT_CONFLICT'); return true; }
  // receipt-replay, receipt-rebase-replay, receipt-foreign-replay: the FIRST
  // receipt is never answered; the supervisor hard-kills the wrapper tree while
  // it waits (acceptance case 6's crash).
  const held = path.join(moe, 'receipt-held');
  if (['receipt-replay','receipt-rebase-replay','receipt-foreign-replay'].includes(mode) && tool === 'record_delivery_receipt' && !fs.existsSync(held)) {
    fs.writeFileSync(held, 'held');
    for (let i = 0; i < 1200; i++) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    process.exit(1);
  }
  try {
    const payload = tool === 'record_candidate' ? candidateReply() : tool === 'record_check_run' ? checkReply()
      : tool === 'record_delivery_receipt' ? receiptReply() : tool === 'reattach_attempt' ? reattachReply() : finalizeReply();
    if (payload !== null) ok(payload);
  } catch(e) { refusal(e.message, e.codeName); }
  return true;
}
holdForInterrupt();
holdLedgerForCrash();
if (['record_candidate','record_check_run','record_delivery_receipt','finalize_attempt','record_commit','deregister_worker','add_comment','reattach_attempt'].includes(tool)) {
  if (evidenceRpc()) process.exit(0);
}
// claimNextTask.ts readProcessIdentity in miniature: the runner's pair is
// both-or-neither, non-blank, bounded (200 / 255) and free of control
// characters, and a refused claim assigns nobody. Every claim is logged with
// the pair it sent.
if (tool === 'claim_next_task') {
  appendRpc();
  const bad = [['processStartedAt', 200], ['host', 255]].find(([key, max]) => args[key] !== undefined && !(typeof args[key] === 'string'
    && args[key].trim() && args[key].length <= max && [...args[key]].every(ch => ch.charCodeAt(0) > 31 && ch.charCodeAt(0) !== 127)));
  if (bad || (args.processStartedAt === undefined) !== (args.host === undefined)) {
    console.log(JSON.stringify({jsonrpc:'2.0',id:req.id,error:{code:-32602,message:'Invalid '+(bad ? bad[0] : 'runner identity: send processStartedAt and host together'),
      data:{tool:'moe.claim_next_task',codeName:'INVALID_INPUT'}}}));
    process.exit(0);
  }
}
// FAKE_HEARTBEAT_REATTACH mirrors heartbeat.ts's reattach-required answer: `1`
// reads the caller's attempt (attempt-reconciling while a restart has it parked,
// a plain ack otherwise); `other` alternates the two reasons that name no
// attempt. .moe/heartbeat-count counts the pings.
if (tool === 'heartbeat' && process.env.FAKE_HEARTBEAT_REATTACH) {
  const counter = path.join(moe, 'heartbeat-count');
  const n = Number(fs.existsSync(counter) ? fs.readFileSync(counter, 'utf8') : 0) + 1;
  fs.writeFileSync(counter, String(n));
  const reattach = (reason, a) => ({ok:false,reattachRequired:true,reason,reattachWith:'moe.reattach_attempt',...(a ? {attemptId:a.id,phase:a.phase} : {})});
  let a = null;
  try { a = JSON.parse(fs.readFileSync(path.join(moe,'attempts','attempt-postflight.json'),'utf8')); } catch {}
  if (process.env.FAKE_HEARTBEAT_REATTACH === 'other') ok(reattach(n % 2 ? 'no-worker-record' : 'no-open-attempt'));
  else ok(a && a.workerId === args.workerId && a.phase === 'reconciling' ? reattach('attempt-reconciling', a) : {ok:true});
  process.exit(0);
}
// FAKE_CLAIM_MODE=finalizing: claimNextTask.ts refuses a seat whose own attempt
// is still finalizing (ATTEMPT_FINALIZING); with none, nothing is claimable.
if (tool === 'claim_next_task' && process.env.FAKE_CLAIM_MODE === 'finalizing') {
  const dir = path.join(moe, 'attempts');
  const open = (fs.existsSync(dir) ? fs.readdirSync(dir) : []).map(f => { try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { return {}; } })
    .find(a => a.workerId === args.workerId && a.phase === 'finalizing');
  if (open) process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:req.id,error:{code:-32002,message:'Attempt '+open.id+' is still finalizing',
    data:{tool:'moe.claim_next_task',codeName:'ATTEMPT_FINALIZING'}}}) + '\n');
  else ok({ hasNext: false });
  process.exit(0);
}
// FAKE_CLAIM_ONCE=1: only the first claim hands out the task. Every later claim
// answers idle and leaves .moe/second-claim, the proof that a --loop wrapper
// went on claiming after its post-flight instead of stopping.
// FAKE_CLAIM_LIMIT=N: the same, but the first N claims hand out the task.
let claimOnceIdle = false;
const claimLimit = process.env.FAKE_CLAIM_ONCE === '1' ? 1 : Number(process.env.FAKE_CLAIM_LIMIT || 0);
if (tool === 'claim_next_task' && claimLimit > 0) {
  const claimCount = path.join(moe, 'claim-count');
  const claimN = Number(fs.existsSync(claimCount) ? fs.readFileSync(claimCount, 'utf8') : 0) + 1;
  fs.writeFileSync(claimCount, String(claimN));
  if (claimN > claimLimit) { claimOnceIdle = true; fs.writeFileSync(path.join(moe, 'second-claim'), String(claimN)); }
}
if (tool === 'claim_next_task' && !claimOnceIdle && !['idle','blocked'].includes(process.env.FAKE_CLAIM_MODE)) attemptFixture();
if (tool === 'get_context' && args.taskId) {
  const countFile = path.join(moe,'context-count');
  const count = Number(fs.existsSync(countFile) ? fs.readFileSync(countFile,'utf8') : 0) + 1;
  fs.writeFileSync(countFile,String(count));
  const file = path.join(moe,'attempts','attempt-postflight.json');
  if (count > 1 && ['REVIEW','DONE','ARCHIVED'].includes(process.env.FAKE_TASK_STATUS) && fs.existsSync(file)) {
    const a = JSON.parse(fs.readFileSync(file,'utf8'));
    if (a.phase === 'running') { a.phase = 'finalizing'; fs.writeFileSync(file,JSON.stringify(a)); }
  }
}

switch (tool) {
  case 'create_team': ok({ team: { id: 'team-smoke', name: args.name || 'Smoke' } }); break;
  case 'join_team': ok({ success: true }); break;
  case 'chat_channels': ok({ channels: [{ id: 'chan-general', name: 'general', type: 'general' }] }); break;
  case 'chat_join': ok({ success: true }); break;
  case 'chat_read': {
    // FAKE_MENTION=1 models one unread message tagging the caller. The record
    // is also appended to the store the wrapper re-reads bodies from, so the
    // mention passes provenance instead of degrading to a delivery marker.
    if (process.env.FAKE_MENTION === '1' && args.channel === 'chan-general') {
      const msg = { id: 'msg-fake-1', channel: 'chan-general', sender: 'human', content: 'ping', mentions: [args.workerId || 'all'], timestamp: new Date().toISOString() };
      const dir = path.join(moe, 'messages');
      ensureDir(dir);
      fs.appendFileSync(path.join(dir, 'chan-general.jsonl'), JSON.stringify(msg) + '\n');
      ok({ messages: [msg], cursor: null, truncated: 0 });
      break;
    }
    ok({ messages: [], cursor: null, truncated: 0 });
    break;
  }
  case 'get_pending_questions': ok({ count: 0, tasks: [] }); break;
  case 'claim_next_task': {
    if (claimOnceIdle) { ok({ hasNext: false }); break; }
    if (process.env.FAKE_CLAIM_MODE === 'resume') {
      // One-task-per-worker guard shape (claimNextTask.ts): the worker already
      // holds an active task from a CLI session that died mid-task.
      ok({
        hasNext: false,
        alreadyAssigned: { taskId: 'task-resume', title: 'Resume smoke', status: process.env.FAKE_TASK_STATUS || 'REVIEW' },
        nextAction: { tool: 'moe.get_context', args: { taskId: 'task-resume' }, reason: 'One task per worker: you already hold task-resume.' }
      });
    } else if (process.env.FAKE_CLAIM_MODE === 'blocked') {
      // BLOCKED hold: the daemon parked the held task via report_blocked; the
      // wrapper must suppress the relaunch (and land any lingering baseline).
      ok({
        hasNext: false,
        alreadyAssigned: { taskId: 'task-resume', title: 'Resume smoke', status: 'BLOCKED', blockedReason: 'waiting on a peer' },
        nextAction: { tool: 'moe.get_context', args: { taskId: 'task-resume' }, reason: 'One task per worker: you already hold task-resume (BLOCKED).' }
      });
    } else if (process.env.FAKE_CLAIM_MODE === 'idle') {
      // Nothing claimable and nothing held: the board state that used to make
      // the wrapper launch a CLI and tell it to claim itself.
      ok({ hasNext: false });
    } else {
      ok({ ...attemptFixture(), hasNext: true, task: { id: 'task-postflight', title: 'Postflight smoke', status: 'WORKING', chatChannel: 'chan-task' } });
    }
    break;
  }
  case 'get_context': {
    // Mirrors getContext.ts: the task projection carries NO epicId and NO order
    // (the resolved epic comes back alongside it instead), and an unresolvable
    // taskId falls back to the CALLER's currentTaskId rather than erroring --
    // so a stale id silently answers with a different task.
    // 'empty'    => daemon answered but carried no task.
    // 'mismatch' => the real fallback: some OTHER task comes back.
    // get_context with NO taskId is the post-flight adoption probe
    // (getContext.ts falls back to the caller's currentTaskId). Every other
    // caller passes a taskId, so this cannot disturb the other scenarios.
    if (!args.taskId) {
      const adopted = process.env.FAKE_ADOPTED_TASK_ID;
      ok(adopted ? { task: { id: adopted, status: 'WORKING' }, project: {}, epic: {} } : { project: {}, epic: {} });
      break;
    }
    if (process.env.FAKE_GET_CONTEXT_FAIL === 'empty') { ok({}); break; }
    const ctxTaskId = process.env.FAKE_GET_CONTEXT_FAIL === 'mismatch'
      ? 'task-someone-elses'
      : (args.taskId || 'task-postflight');
    const ctxPayload = {
      task: {
        id: ctxTaskId,
        status: process.env.FAKE_TASK_STATUS || 'WORKING',
        reopenCount: 0,
        implementationPlan: [],
        definitionOfDone: []
      },
      project: {}, epic: { id: 'epic-1', title: 'Smoke epic' }, nextAction: { tool: 'moe.start_step' }
    };
    // FAKE_CTX_IS_EPIC_FINAL=true|false models the newer daemon that computes
    // epic-final board-side; unset = an old daemon that doesn't serve the
    // field. FAKE_CTX_IS_EPIC_FINAL_AT=top places it top-level (beside the
    // epic) instead of on the task projection -- the wrapper accepts both.
    const fakeIef = process.env.FAKE_CTX_IS_EPIC_FINAL;
    if (fakeIef === 'true' || fakeIef === 'false') {
      const iefVal = fakeIef === 'true';
      if (process.env.FAKE_CTX_IS_EPIC_FINAL_AT === 'top') ctxPayload.isEpicFinal = iefVal;
      else ctxPayload.task.isEpicFinal = iefVal;
    }
    ok(ctxPayload);
    break;
  }
  case 'list_tasks': {
    const epicTasks = [
      { id: 'task-postflight', status: process.env.FAKE_TASK_STATUS || 'WORKING', reopenCount: 0, epicId: 'epic-1', order: 1 },
      ...(process.env.FAKE_SIBLING_ORDER
        ? [{ id: 'task-sibling', status: 'BACKLOG', reopenCount: 0, epicId: 'epic-1', order: Number(process.env.FAKE_SIBLING_ORDER) }]
        : [])
    ];
    // An epic-scoped query asks about one epic's siblings, so it is bounded by
    // construction and always answers in full.
    if (args.epicId) { ok({ tasks: epicTasks.filter((t) => t.epicId === args.epicId) }); break; }
    // FAKE_LIST_TASKS_TRUNCATED models the real daemon behaviour that made the
    // production auto-commit path inert: an UNSCOPED list_tasks is capped at
    // DEFAULT_TASK_LIST_LIMIT and, once the project outgrows one page, the
    // just-completed task is simply not in the rows that come back.
    if (process.env.FAKE_LIST_TASKS_TRUNCATED === '1') {
      ok({
        tasks: [{ id: 'task-other', status: 'BACKLOG', reopenCount: 0, epicId: 'epic-other', order: 1 }],
        pagination: { limit: 1, offset: 0, returned: 1, total: 2, hasMore: true }
      });
      break;
    }
    ok({ tasks: epicTasks });
    break;
  }
  case 'get_commit_scope': {
    // Mirrors tools/getCommitScope.ts: ASSERTED = completed steps' modifiedFiles
    // ?? affectedFiles + filesModified + declaredFiles + touchedFiles; PLANNED =
    // every step's affected/new/modified + inferredPaths minus ASSERTED; PEER =
    // the same union over every other non-DONE/ARCHIVED record on disk.
    const taskId = args.taskId || 'task-postflight';
    const rec = readTask(taskId);
    const sets = rec ? declaredSets(rec) : { asserted: [], planned: [] };
    const asserted = process.env.FAKE_SCOPE_ASSERTED !== undefined ? csv(process.env.FAKE_SCOPE_ASSERTED) : sets.asserted;
    const planned = process.env.FAKE_SCOPE_PLANNED !== undefined ? csv(process.env.FAKE_SCOPE_PLANNED) : sets.planned;
    let peerDeclared = [];
    if (process.env.FAKE_SCOPE_PEER_DECLARED !== undefined) {
      peerDeclared = csv(process.env.FAKE_SCOPE_PEER_DECLARED).map((e) => { const i = e.lastIndexOf(':'); return { path: e.slice(0, i), taskId: e.slice(i + 1) }; });
    } else {
      let files = [];
      try { files = fs.readdirSync(path.join(moe, 'tasks')).filter((f) => f.endsWith('.json')); } catch {}
      for (const f of files) {
        const other = readTask(f.replace(/\.json$/, ''));
        if (!other || other.id === taskId || other.status === 'DONE' || other.status === 'ARCHIVED') continue;
        const os = declaredSets(other);
        for (const p of [...os.asserted, ...os.planned, ...strList(other.touchedFiles)]) peerDeclared.push({ path: p, taskId: other.id });
      }
    }
    const peersActive = process.env.FAKE_SCOPE_PEERS_ACTIVE === '1';
    ok({
      taskId,
      title: rec ? rec.title : 'Postflight smoke',
      status: process.env.FAKE_TASK_STATUS || (rec ? rec.status : 'WORKING'),
      epicId: 'epic-1',
      reopenCount: rec && rec.reopenCount ? rec.reopenCount : 0,
      assignedWorkerId: process.env.FAKE_SCOPE_ASSIGNED !== undefined ? process.env.FAKE_SCOPE_ASSIGNED : (args.workerId || ''),
      assigneeAlive: true,
      asserted, planned,
      touchedFiles: rec ? strList(rec.touchedFiles) : [],
      inferredPaths: rec ? strList(rec.inferredPaths) : [],
      unattributedPaths: rec ? strList(rec.unattributedPaths) : [],
      peerDeclared,
      livePeerIds: peersActive ? ['worker-peer'] : [],
      activePeerIds: peersActive ? ['worker-peer'] : [],
      peersActive,
      alwaysInclude: [],
      excludePrefixes: [],
      policy: { autoCommit: true, checkpointCommits: true, checkpointPush: true, commitBoardState: true, commitHooks: false, undeclared: 'solo', contested: 'commit' }
    });
    break;
  }
  case 'record_commit': {
    ensureDir(moe);
    fs.appendFileSync(path.join(moe, 'record_commit.jsonl'), JSON.stringify(args) + '\n');
    ok({ success: true, taskId: args.taskId, sha: args.sha, kind: args.kind, outcome: args.outcome, commitCount: 1, filesModified: strList(args.paths), addedPaths: strList(args.paths) });
    break;
  }
  case 'declare_files': ok({ success: true, taskId: args.taskId, declaredFiles: strList(args.paths) }); break;
  case 'chat_send': {
    const dir = path.join(moe, 'messages');
    ensureDir(dir);
    fs.appendFileSync(path.join(dir, `${args.channel}.jsonl`), JSON.stringify({ sender: args.workerId, content: args.content }) + '\n');
    ok({ success: true });
    break;
  }
  case 'heartbeat': {
    fs.appendFileSync(path.join(moe, 'heartbeat.log'), `${new Date().toISOString()} ${args.workerId}\n`);
    ok({ ok: true });
    break;
  }
  default: ok({ success: true });
}
'@

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
'freed-closed','freed-generation-bump','freed-corrupt-sibling','finalizing-acked-continues','unborn','cleanup-retry','hidden-mutation',
'receipt-replay','receipt-cached-check','receipt-same-tree-race','receipt-push','receipt-push-failed','receipt-refused','receipt-conflict',
'receipt-ledger-replay','receipt-rebase-replay','receipt-foreign-replay',
'identity-claim','reattach-sidecar','reattach-refused','reattach-postflight','reattach-preflight','reattach-none',
...(win?['integrity-batch']:[]),'interrupt-int',...(win?[]:['interrupt-term']),
'teardown-finalizing','teardown-manual','teardown-no-git','teardown-sha256','teardown-no-baseline','teardown-recovered','teardown-scope','teardown-landed','teardown-nothing','teardown-running'];
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
const teardownOutcome={'teardown-finalizing':'rescued','teardown-manual':'nothing-to-commit','teardown-no-git':'nothing-to-commit','teardown-sha256':'nothing-to-commit',
  'teardown-no-baseline':'failed','teardown-recovered':'rescued','teardown-scope':'rescued','teardown-landed':'landed',
  'teardown-nothing':'nothing-to-commit','teardown-running':''};
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
if(mode==='cleanup-retry')get('worktree','lock','--reason','moe frozen cleanup retry',get('rev-parse','--show-toplevel'));
if(mode==='dirty-helper'&&!fs.existsSync('helper.txt'))process.exit(19);
if(mode==='race-fail'&&fs.existsSync('../break-gate.txt'))process.exit(23);
if(mode.startsWith('interrupt-')){fs.writeFileSync(path.join(dir,'owned.txt'),'late shared\\n');fs.writeFileSync(path.join(dir,'.moe','gate-ready'),'ready');setInterval(()=>{},1000);}
if(mode==='exit-tail'){process.stdout.write('é😀'.repeat(5000)+'TAIL');process.stderr.write('END');process.exit(37);}
`;
  write(path.join(nested,'gate.cjs'),gateSource);write(owned,'base\n');write(path.join(repo,'seed.txt'),'seed\n');
  const settings={qualityGate:'node gate.cjs',qualityGateScope:'everyTask',commitBoardState:false,attribution:{undeclared:'never'}};
  if(mode==='disabled'||mode==='nogate-qa-claimed')settings.qualityGate='';
  if(mode==='deferred')settings.qualityGateScope='epicFinal';
  // Padding is not part of the command: '   ' is no gate, and a padded one runs trimmed.
  if(mode==='gate-blank')settings.qualityGate='   ';
  if(mode==='gate-padded')settings.qualityGate='  node gate.cjs  ';
  if(mode==='manual'||mode.startsWith('manual-')||mode==='teardown-manual')settings.autoCommit=false;
  const ownedPaths=mode==='unborn'?['owned.txt','gate.cjs']:['owned.txt'];
  write(path.join(nested,'.moe','project.json'),JSON.stringify({id:'proj-frozen',name:'Frozen',settings}));
  write(path.join(nested,'.moe','tasks','task-postflight.json'),JSON.stringify({id:'task-postflight',title:'Frozen',
    status:'WORKING',filesModified:ownedPaths,implementationPlan:[{stepId:'s1',status:'COMPLETED',modifiedFiles:ownedPaths}]}));
  const noGit=mode==='no-git'||mode==='teardown-no-git',sha256=mode==='sha256-repo'||mode==='teardown-sha256';
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
    // A peer's commit is already on the remote branch: the landing's first push is
    // rejected, and its pull --rebase rewrites the landed commit before the re-push.
    if(mode==='receipt-rebase-replay'){const remote=path.join(root,mode+'-remote.git'),peer=path.join(root,mode+'-peer');
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
const qaClaimed=mode.endsWith('-qa-claimed'),exitOnly=/^(checkpoint|manual|freed)-/.test(mode)||mode==='teardown-running';
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
if(fs.existsSync(file)){const a=JSON.parse(fs.readFileSync(file,'utf8'));if(!exitOnly)a.phase='finalizing';
if(mode.endsWith('-reconciling')||mode==='reattach-postflight')a.phase='reconciling';
if(mode==='closed-attempt'||mode==='freed-closed'||qaClaimed)a.phase='closed';if(mode==='stale-attempt'||mode==='freed-generation-bump')a.generation++;if(mode==='missing-attempt')fs.unlinkSync(file);else fs.writeFileSync(file,JSON.stringify(a));}
const stamp=new Date().toISOString();
if(qaClaimed)fs.writeFileSync(path.join(dir,'.moe','attempts','attempt-qa.json'),JSON.stringify({id:'attempt-qa',generation:8,taskId:'task-postflight',
 workerId:'qa-frozen',runnerId:'qa-frozen',phase:'running',workspace:dir,startedAt:stamp,lastPhaseAt:stamp}));
if(mode.endsWith('-unpinned')||mode==='freed-corrupt-sibling')fs.writeFileSync(path.join(dir,'.moe','attempts','zzz-broken.json'),'{not json');
if(mode==='teardown-no-baseline')fs.rmSync(${JSON.stringify(baselineFile)},{force:true});
if(/^teardown-(finalizing|manual|no-git|sha256|no-baseline|recovered|running)$/.test(mode)){const ready=path.join(dir,'.moe','gate-ready');fs.writeFileSync(ready,'ready');
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
  if(mode.startsWith('race-'))env.MOE_POSTFLIGHT_TEST_HOOK_PRE_UPDATE_REF='node "'+race.replaceAll('\\','/')+'"';
  // A peer lands an EMPTY commit before the CAS: new base, identical rebuilt tree.
  if(mode==='receipt-same-tree-race'){write(race,"require('child_process').execFileSync('git',['commit','--allow-empty','-qm','peer-empty']);");
    env.MOE_POSTFLIGHT_TEST_HOOK_PRE_UPDATE_REF='node "'+race.replaceAll('\\','/')+'"';}
  const args=win?['-NoProfile','-File',wrapper,'-Project',nested,'-WorkerId','worker-frozen','-Role','worker',
    '-Team','Smoke','-NoStartDaemon','-Command',cli,'-NoLoop','-PollInterval','0']:
    [wrapper,'--project',nested,'--worker-id','worker-frozen','--role','worker','--team','Smoke','--no-start-daemon',
    '--command',cli,'--no-loop','--poll-interval','0'];

  if(/^(checkpoint|manual)-/.test(mode)||mode==='teardown-running')env.FAKE_TASK_STATUS='WORKING';
  if(mode.startsWith('freed-'))env.FAKE_TASK_STATUS='BLOCKED';
  if(mode.endsWith('-unpinned'))env.FAKE_CLAIM_TOKENS='missing';
  // Reattach arms: the sidecar pings every second against the fake heartbeat.
  if(['reattach-sidecar','reattach-refused','reattach-none'].includes(mode)){delete env.MOE_DISABLE_HEARTBEAT;env.MOE_HEARTBEAT_INTERVAL_SEC='1';
    env.FAKE_HEARTBEAT_REATTACH=mode==='reattach-none'?'other':'1';}
  if(mode==='reattach-refused')env.FAKE_REATTACH_REFUSE='1';
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
  if(['receipt-ledger-replay','receipt-rebase-replay','receipt-foreign-replay'].includes(mode)){
    env.TMPDIR=env.TMP=env.TEMP=wrapperTmp;
    const supervisor=path.join(root,'receipt-supervisor.cjs');
    write(supervisor,KILL_ON_MARKER);
    runEngine=process.execPath;
    runArgs=[supervisor,mode==='receipt-ledger-replay'?ledgerHeld:receiptHeld,String((Number(process.env.MOE_POSTFLIGHT_TIMEOUT_SEC||180)-15)*1000),engine,...args];
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
    'gate-qa-claimed','hidden-mutation'].includes(mode)||mode.startsWith('record_');
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
      'the claim recorded the pair on the attempt it opened\n'+log);}
  const reattaches=rpc.filter(r=>r.tool==='reattach_attempt').map(r=>r.args),said=s=>log.split(s).length-1;
  if(['reattach-sidecar','reattach-refused','reattach-postflight','reattach-preflight','checkpoint-reconciling','manual-reconciling'].includes(mode)){
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
      ['task-postflight',after,'refs/heads/moe/frozen','worker',sid(after),'REVIEW',false],log2);
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
  if(['dirty-helper','race-fail','tracked-mutation','exit-tail','hidden-mutation','record_candidate-refuse'].includes(mode))
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
  if(mode==='hidden-mutation'){assert.equal(checks.length,1,log);assert.equal(checks[0].args.exitCode,0,'integrity refusal keeps the actual exit code');}
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

    $trueCmd = Join-Path $tempRoot 'true.cmd'
    Set-Content -Path $trueCmd -Encoding ASCII -Value "@echo off`r`nexit /b 0`r`n"

    # A "slow" fake CLI that sleeps a few seconds before exiting, standing in
    # for a long silent verification step with no moe.* calls of its own —
    # exactly the scenario the heartbeat sidecar exists to cover.
    $slowCmd = Join-Path $tempRoot 'slow.cmd'
    Set-Content -Path $slowCmd -Encoding ASCII -Value "@echo off`r`nping -n 6 127.0.0.1 >nul`r`nexit /b 0`r`n"

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
    $createFileCmd = Join-Path $tempRoot 'create-file.cmd'
    Set-Content -Path $createFileCmd -Encoding ASCII -Value "@echo off`r`necho new> `"%MOE_PROJECT_PATH%\session-new.txt`"`r`nexit /b 0`r`n"
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
        Get-ChildItem -LiteralPath (Split-Path $wrapper) -Filter 'prompt-cache*.mjs' | ForEach-Object {
            Copy-Item -LiteralPath $_.FullName -Destination (Split-Path $reloadWrapper)
        }
        Set-Content -Path (Join-Path $reloadProject '.moe\project.json') -Value '{"id":"proj-reload","name":"postflight-reload","settings":{"autoCommit":false}}' -Encoding UTF8
        Set-Content -Path (Join-Path $reloadProject '.moe\messages\chan-general.jsonl') -Value '' -Encoding UTF8
        $reloadRpcLog = Join-Path $reloadProject '.moe\evidence-rpcs.jsonl'
        $reloadOut = Join-Path $tempRoot 'wrapper-reload.out'
        function Get-ReloadRows {
            $lines = @(); try { $lines = @(Get-Content -LiteralPath $reloadRpcLog -ErrorAction Stop) } catch {}
            foreach ($line in $lines) { try { $line | ConvertFrom-Json } catch {} }
        }
        # c = claim_next_task, r = a wrapper_restart deregister, x = any other deregister.
        function Get-ReloadSequence {
            -join @(Get-ReloadRows | ForEach-Object {
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
            Wait-ReloadSequence '^c+rc' 'claim after reload 1'
            $reloadCounts += @(Get-ReloadWrapperPids).Count
            Set-ReloadWrapperText ($reloadEdited + "# reload 2`n")
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
                # later poll replays it. The ps1 fake answers the BLOCKED hold
                # with task-resume.
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
                    foreach ($needle in @('[mcp_servers.moe]', '[mcp_servers.moe.env]', 'MOE_WORKER_ID = "${MOE_WORKER_ID:-}"', 'MOE_TOOL_NAME_STYLE = "underscore"', 'startup_timeout_sec = 120', 'tool_timeout_sec = 120', 'moe_wait_for_task = 720', '[mcp_servers.serena]', '"--context", "agent"')) {
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
                # per-seat -c overrides and never --full-auto; a worker or
                # architect without the switch gets the TUI; --sandbox
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
                    foreach ($flag in @('exec', '--json', '-C', '--sandbox', 'danger-full-access', '-c', 'mcp_servers.moe.env.MOE_WORKER_ID=worker-scope-z', 'approvals_reviewer=user')) {
                        if ($scopeZArgs -cnotcontains $flag) { Write-Host ($scopeZArgs -join ' '); throw "SCENARIO Z FAILED: headless codex argv must carry [$flag]" }
                    }
                    if ([array]::IndexOf($scopeZArgs, '--sandbox') -le [array]::IndexOf($scopeZArgs, 'exec')) { Write-Host ($scopeZArgs -join ' '); throw 'SCENARIO Z FAILED: --sandbox must follow the exec subcommand' }
                    $scopeZSeatFile = @($scopeZArgs | Where-Object { $_ -like 'model_instructions_file=*' })
                    # The fake appends argv per invocation (probe, then launch), so the override
                    # appears once per invocation; every occurrence must point under $env:TEMP.
                    $scopeZSeatBad = @($scopeZSeatFile | Where-Object { $_.IndexOf($tempRoot.Replace('\', '/'), [System.StringComparison]::OrdinalIgnoreCase) -lt 0 })
                    if ($scopeZSeatFile.Count -lt 1 -or $scopeZSeatBad.Count -gt 0) { Write-Host ($scopeZArgs -join ' '); throw 'SCENARIO Z FAILED: the per-seat model_instructions_file override must point under $env:TEMP with forward slashes' }
                    if (-not $scopeZText.Contains('--sandbox danger-full-access') -or -not $scopeZText.Contains('-c mcp_servers.moe.env.MOE_WORKER_ID=worker-scope-z') -or -not $scopeZText.Contains('-c approvals_reviewer=user exec --json -C')) { Write-Host $scopeZText; throw 'SCENARIO Z FAILED: the Command banner must show the seat override, JSON mode, the reviewer pin and --sandbox danger-full-access' }
                    if (-not $scopeZText.Contains('run the printed Command by hand')) { Write-Host $scopeZText; throw 'SCENARIO Z FAILED: a fast non-zero exit must print the launch-failure argv hint' }
                    if (-not (Test-Path -LiteralPath $scopeZConfig)) { Write-Host $scopeZText; throw 'SCENARIO Z FAILED: .codex/config.toml was not written' }
                    $scopeZToml = [System.IO.File]::ReadAllText($scopeZConfig)
                    foreach ($needle in @('[mcp_servers.moe]', '[mcp_servers.moe.env]', 'startup_timeout_sec = 120', 'model_instructions_file = "agent-instructions.md"', 'model_reasoning_effort = "xhigh"', 'default_tools_approval_mode = "approve"')) {
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

                    # Run 5b: a worker without -CodexExec gets the TUI too (codex is
                    # interactive for every role since 2026-09-07; headless is opt-in).
                    $scopeZOut5b = Join-Path $tempRoot 'scope-z-5b.out'
                    Assert-ScopeRun 'Z' (Invoke-CodexWrapper $scopeZOut5b 'worker') $scopeZOut5b
                    $scopeZArgs5b = Get-CodexArgv
                    if ($scopeZArgs5b -contains 'exec' -or $scopeZArgs5b -contains '--sandbox' -or $scopeZArgs5b -contains 'approvals_reviewer=user') { Write-Host ($scopeZArgs5b -join ' '); throw 'SCENARIO Z FAILED: a worker without -CodexExec must get the interactive codex TUI (no exec / --sandbox / reviewer pin)' }

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

                # A harness that silently generated zero scenarios exits 0 and
                # reads as green.
                Write-Host "commit-scope scenarios run: $scopeScenariosRun"
                if ($scopeScenariosRun -ne 31) {
                    throw "Expected 31 commit-scope scenarios (A-V, K2, M2, M3, P2, X-Z, AA, AB); ran $scopeScenariosRun"
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
