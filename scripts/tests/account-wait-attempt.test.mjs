// task-a7d02ec3: a launcher whose account lease WAITED re-verifies the attempt its pre-flight
// pinned before the wait, and launches nothing on a closed or superseded one. The REAL lease
// loop, attempt-store reader, pin and launch lines are cut out of moe-agent.{sh,ps1} and run in a
// pass loop shaped like the main loop of a --no-loop / -NoLoop run, against a scripted daemon.
// Pass 1 claims task-wait (attempt-a, generation 6). A scenario may close attempt-a and open a
// peer's attempt-b on that task while the lease waits (the REVIEW self-heal, then a peer's claim).
// A stale pin must re-run pre-flight, whose pass 2 claims task-next (attempt-c). Before the fix
// the launch line ran on attempt-a, and every fenced call was then refused ATTEMPT_SUPERSEDED.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const HELPER = path.join(ROOT, 'scripts', 'moe-account-lease.mjs');
const source = (ext) => fs.readFileSync(path.join(ROOT, 'scripts', `moe-agent.${ext}`), 'utf8')
  .replace(/^\uFEFF/, '').replaceAll('\r\n', '\n');
function between(src, start, end) {
  const from = src.indexOf(start);
  const to = src.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `missing boundaries: ${start} / ${end}`);
  return src.slice(from, to);
}
const PYTHON = ['python3', 'python'].find((cmd) => spawnSync(cmd, ['-c', 'import sys; sys.exit(sys.version_info[0] != 3)']).status === 0);
const ENGINES = process.platform === 'win32'
  ? [['ps1', 'powershell.exe'], ['ps1', 'pwsh.exe'], ['sh', 'C:/Program Files/Git/bin/bash.exe']]
  : [['sh', '/bin/bash']];
const runs = (ext, engine) => spawnSync(engine, ext === 'ps1' ? ['-NoProfile', '-Command', 'exit 0'] : ['-c', 'exit 0']).status === 0;
const shQuote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;
const psQuote = (value) => `'${String(value).replaceAll("'", "''")}'`;
const fwd = (file) => file.replaceAll('\\', '/');
// No account, token, provider or seat variable of the seat running this test may reach the cut.
function cleanEnv(extra) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(MOE_|CLAUDE_|ANTHROPIC_)/i.test(name)));
  return { ...env, ...extra };
}

function shScript(fx) {
  const src = source('sh');
  return [
    'set -e',
    `WORKER_ID=qa-wait PROJECT=${shQuote(fwd(fx.project))} GENERAL_CHANNEL_ID=chan-general`,
    `NODE_CMD=${shQuote(fwd(process.execPath))} PYTHON_CMD=${PYTHON} ACCOUNT_HELPER=${shQuote(fwd(HELPER))}`,
    `CLAUDE_INTERACTIVE=${fx.interactive} YELLOW='' GREEN='' NC=''`,
    `ACCOUNT_SAMPLE_FILE=${shQuote(fwd(path.join(fx.dir, 'sample.json')))}`,
    'ACCOUNT_LEASED_ID="" ACCOUNT_LEASED_DIR="" ACCOUNT_PREV_ID="" ACCOUNT_SAMPLE_SENT="" ACCOUNT_ARGS=()',
    // A previous lease's wait must not leak into this one: the lease loop resets the flag first.
    'MOE_SKIP_LAUNCH=false CLI_TYPE=claude RESUME_ATTEMPTS=1 ACCOUNT_RELAUNCH=false ACCOUNT_LEASE_WAITED=true',
    // The scripted daemon: lease_account call n answers line n of $REPLIES; call $CLOSE_AT first
    // moves $AFTER's records into the store (the claim changed while the wrapper slept).
    'moe_rpc() {',
    '    printf \'%s\\t%s\\n\' "$1" "$2" >> "$RPC_LOG"',
    '    [ "$1" = lease_account ] || return 0',
    '    local n line',
    '    n=$(grep -c "^lease_account" "$RPC_LOG")',
    '    if [ "$n" = "$CLOSE_AT" ]; then cp "$AFTER"/*.json "$PROJECT/.moe/attempts/"; fi',
    '    line=$(sed -n "${n}p" "$REPLIES")',
    '    printf \'%s\' "${line:-{\\"rotation\\":false,\\"reason\\":null\\}}"',
    '}',
    'sleep() { printf \'%s\\n\' "$1" >> "$SLEEP_LOG"; }',
    between(src, '# An externally killed idle/backoff sleep must not end the seat under set -e', '# moe_rpc TOOL ARGS_JSON'),
    between(src, "# Candidate evidence is pinned outside the CLI's mutable context projection.", 'moe_evidence_rpc() {'),
    between(src, '# printf, not echo -e: a reason from the daemon is printed as is.', "# Runs inside the CLI's subshell"),
    'prepare_agent_git_guard() { :; }',
    'live_marker_remove() { printf \'%s\\n\' "$1" >> "$MARKER_LOG"; }',
    'PASS=0',
    'while :; do',
    '    PASS=$((PASS + 1))',
    '    [ "$PASS" -le 3 ] || { echo RUNAWAY; exit 3; }',
    '    printf \'PREFLIGHT %s relaunch=%s\\n\' "$PASS" "$ACCOUNT_RELAUNCH"',
    '    ACCOUNT_RELAUNCH=false',
    '    export MOE_ATTEMPT_ID="" MOE_ATTEMPT_GENERATION=""',
    '    if [ "$PASS" = 1 ]; then PREFLIGHT_TASK_ID=task-wait; CLAIM_RESULT=\'{"attemptId":"attempt-a","generation":6}\'',
    '    else PREFLIGHT_TASK_ID=task-next; CLAIM_RESULT=\'{"attemptId":"attempt-c","generation":1}\'; cp "$NEXT" "$PROJECT/.moe/attempts/"; fi',
    '    pin_attempt_identity || echo "PIN FAILED"',
    between(src, '    clear_account_lease\n    if [ "$MOE_SKIP_LAUNCH" != true ] && [ "$CLI_TYPE" = claude ]; then', '    CLI_LAUNCHED_AT=$(date +%s)'),
    '    printf \'LAUNCH task=%s attempt=%s generation=%s resume=%s\\n\' "$PREFLIGHT_TASK_ID" "$MOE_ATTEMPT_ID" "$MOE_ATTEMPT_GENERATION" "$RESUME_ATTEMPTS"',
    '    break',
    'done',
  ].join('\n');
}

function ps1Script(fx) {
  const src = source('ps1');
  return [
    '\ufeff$ErrorActionPreference = \'Stop\'',
    '[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)',
    '$utf8 = [Text.UTF8Encoding]::new($false)',
    'function Invoke-MoeRpc {',
    '    param([Parameter(Mandatory = $true)][string]$Tool, [object]$Args)',
    '    [IO.File]::AppendAllText($env:RPC_LOG, "$Tool`t$($Args | ConvertTo-Json -Compress -Depth 5)`n", $utf8)',
    "    if ($Tool -ne 'lease_account') { return $null }",
    "    $n = @([IO.File]::ReadAllLines($env:RPC_LOG) | Where-Object { $_ -like \"lease_account`t*\" }).Count",
    "    if ([string]$n -eq $env:CLOSE_AT) { Copy-Item -Path (Join-Path $env:AFTER '*.json') -Destination (Join-Path $projectPath '.moe/attempts') -Force }",
    '    $replies = @([IO.File]::ReadAllLines($env:REPLIES) | Where-Object { $_ })',
    "    if ($n -le $replies.Count) { return ($replies[$n - 1] | ConvertFrom-Json) }",
    "    return ('{\"rotation\":false,\"reason\":null}' | ConvertFrom-Json)",
    '}',
    'function Start-Sleep { param([int]$Seconds) [IO.File]::AppendAllText($env:SLEEP_LOG, "$Seconds`n", $utf8) }',
    'function Send-MoeGeneralChat([string]$Content) { [IO.File]::AppendAllText($env:RPC_LOG, "chat_send`t$Content`n", $utf8) }',
    `$WorkerId = 'qa-wait'; $projectPath = ${psQuote(fx.project)}`,
    `$accountHelper = ${psQuote(HELPER)}; $claudeInteractive = $${fx.interactive}`,
    `$script:AccountSampleFile = ${psQuote(path.join(fx.dir, 'sample.json'))}`,
    "$script:AccountLeasedId = ''; $script:AccountLeasedDir = ''; $script:AccountPrevId = ''; $script:AccountSampleSent = ''",
    '$script:AccountWindows = [ordered]@{}; $script:AccountSampleRefused = $false; $accountArgs = @()',
    "$moeSkipLaunch = $false; $cliType = 'claude'; $script:ResumeAttempts = 1; $script:AccountRelaunch = $false; $script:AccountLeaseWaited = $true",
    "$moeGit = @{ GitDir = 'gitdir' }",
    between(src, 'function Get-MoeProp($Obj, [string]$Name) {', '# Emits the strings one by one'),
    between(src, '# Immutable claim tokens belong to the runner, not the mutable CLI context.', "# A daemon restart parked this seat's attempt in `reconciling`"),
    between(src, "# One line from moe-account-lease.mjs ('' when it printed nothing)", '# The values never leave this process'),
    'function Initialize-MoeAgentGitGuard { }',
    'function Remove-MoeLiveMarker([string]$GitDir, [string]$TaskId) { [IO.File]::AppendAllText($env:MARKER_LOG, "$TaskId`n", $utf8) }',
    'Set-Location -LiteralPath $projectPath',
    '$pass = 0',
    'do {',
    '    $pass++',
    "    if ($pass -gt 3) { Write-Output 'RUNAWAY'; exit 3 }",
    '    Write-Output "PREFLIGHT $pass relaunch=$(([string]$script:AccountRelaunch).ToLowerInvariant())"',
    '    $script:AccountRelaunch = $false',
    "    $script:MoeAttemptId = ''; $script:MoeAttemptGeneration = $null",
    "    if ($pass -eq 1) { $preflightTaskId = 'task-wait'; $claim = '{\"attemptId\":\"attempt-a\",\"generation\":6}' | ConvertFrom-Json }",
    "    else { $preflightTaskId = 'task-next'; $claim = '{\"attemptId\":\"attempt-c\",\"generation\":1}' | ConvertFrom-Json; Copy-Item -LiteralPath $env:NEXT -Destination (Join-Path $projectPath '.moe/attempts') -Force }",
    '    Set-MoeAttemptIdentity $claim $preflightTaskId',
    between(src, "    Clear-MoeAccountLease\n    if (-not $moeSkipLaunch -and $cliType -eq 'claude') {", '    if ($moeSkipLaunch) {'),
    '    Write-Output "LAUNCH task=$preflightTaskId attempt=$($script:MoeAttemptId) generation=$($script:MoeAttemptGeneration) resume=$($script:ResumeAttempts)"',
    // The main loop's -NoLoop condition: only an account relaunch runs another pass.
    '} while ($script:AccountRelaunch)',
  ].join('\n');
}

const WAIT = { rotation: true, accountId: null, retryAt: '2026-11-03T11:30:00.000Z', retryInSec: 3600, switchAtPercent: 90 };
const OFF = { rotation: false, reason: null };
const record = (id, taskId, workerId, generation, phase) => JSON.stringify({ id, taskId, workerId, generation, phase });

function run(t, ext, engine, { replies, closeAt = 0, interactive = false }) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'moe-account-wait-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const project = path.join(dir, 'proj');
  const store = path.join(project, '.moe', 'attempts');
  const after = path.join(dir, 'after');
  fs.mkdirSync(store, { recursive: true });
  fs.mkdirSync(after);
  fs.mkdirSync(path.join(dir, 'acct-1'));
  fs.writeFileSync(path.join(store, 'attempt-a.json'), record('attempt-a', 'task-wait', 'qa-wait', 6, 'running'));
  fs.writeFileSync(path.join(after, 'attempt-a.json'), record('attempt-a', 'task-wait', 'qa-wait', 6, 'closed'));
  fs.writeFileSync(path.join(after, 'attempt-b.json'), record('attempt-b', 'task-wait', 'qa-peer', 7, 'running'));
  const next = path.join(dir, 'attempt-c.json');
  fs.writeFileSync(next, record('attempt-c', 'task-next', 'qa-wait', 1, 'running'));
  const leased = { rotation: true, accountId: 'acct-1', label: 'acct-1', configDir: path.join(dir, 'acct-1'), peakPercent: 10 };
  const files = { RPC_LOG: path.join(dir, 'rpc.log'), REPLIES: path.join(dir, 'replies.jsonl'),
    SLEEP_LOG: path.join(dir, 'sleep.log'), MARKER_LOG: path.join(dir, 'marker.log') };
  fs.writeFileSync(files.REPLIES, `${replies.map((r) => JSON.stringify(r === 'LEASED' ? leased : r)).join('\n')}\n`);
  const script = path.join(dir, `wait.${ext}`);
  const fx = { dir, project, interactive };
  fs.writeFileSync(script, ext === 'ps1' ? ps1Script(fx) : shScript(fx));
  const env = cleanEnv({ MOE_ACCOUNT_RETRY_SEC: '2', CLOSE_AT: String(closeAt), AFTER: fwd(after), NEXT: fwd(next),
    ...Object.fromEntries(Object.entries(files).map(([name, file]) => [name, fwd(file)])) });
  const result = spawnSync(engine, ext === 'ps1' ? ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script] : [fwd(script)],
    { encoding: 'utf8', timeout: 60_000, env });
  assert.ifError(result.error);
  const out = result.stdout.replaceAll('\r\n', '\n');
  assert.equal(result.status, 0, out + result.stderr);
  const read = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean) : []);
  const lines = out.split('\n');
  return {
    out,
    passes: lines.filter((line) => line.startsWith('PREFLIGHT ')),
    launches: lines.filter((line) => line.startsWith('LAUNCH ')),
    leases: read(files.RPC_LOG).filter((line) => line.startsWith('lease_account\t')).length,
    sleeps: read(files.SLEEP_LOG),
    markers: read(files.MARKER_LOG),
  };
}

const STALE = '[account] MOE_ACCOUNT_WAIT_STALE_ATTEMPT task=task-wait attempt=attempt-a generation=6 '
  + '(Attempt identity unavailable: identity) - the claim ended while this seat waited for an account; '
  + 'not launching the pre-wait prompt, re-running pre-flight now.';
const ON_A = 'LAUNCH task=task-wait attempt=attempt-a generation=6 resume=1';
const ON_C = 'LAUNCH task=task-next attempt=attempt-c generation=1 resume=0';

for (const [ext, engine] of ENGINES) {
  const skip = (ext === 'sh' && !PYTHON && 'no python 3') || (!runs(ext, engine) && `${engine} is not available`);

  test(`${engine}: a pin closed during the account wait launches nothing and re-runs pre-flight`, { skip }, (t) => {
    const run1 = run(t, ext, engine, { replies: [WAIT, 'LEASED', 'LEASED'], closeAt: 2 });
    assert.deepEqual(run1.launches, [ON_C], run1.out);
    assert.deepEqual(run1.passes, ['PREFLIGHT 1 relaunch=false', 'PREFLIGHT 2 relaunch=true'], run1.out);
    assert.ok(run1.out.includes(`${STALE}\n`), run1.out);
    assert.deepEqual(run1.markers, ['task-wait'], 'only the stale session drops its live-session marker');
    assert.deepEqual(run1.sleeps, ['2']);
    assert.equal(run1.leases, 3);
  });

  test(`${engine}: an untrusted-account wait re-verifies the pin the same way`, { skip }, (t) => {
    const run1 = run(t, ext, engine, { replies: ['LEASED', OFF, OFF], closeAt: 2, interactive: true });
    assert.match(run1.out, /MOE_ACCOUNT_UNTRUSTED account=acct-1 /);
    assert.deepEqual(run1.launches, [ON_C], run1.out);
    assert.ok(run1.out.includes(`${STALE}\n`), run1.out);
    assert.deepEqual(run1.sleeps, ['2']);
  });

  test(`${engine}: a pin still current after the wait launches on it`, { skip }, (t) => {
    const run1 = run(t, ext, engine, { replies: [WAIT, 'LEASED'] });
    assert.deepEqual(run1.launches, [ON_A], run1.out);
    assert.deepEqual(run1.passes, ['PREFLIGHT 1 relaunch=false']);
    assert.doesNotMatch(run1.out, /MOE_ACCOUNT_WAIT_STALE_ATTEMPT/);
    assert.deepEqual(run1.markers, []);
    assert.deepEqual(run1.sleeps, ['2']);
  });

  test(`${engine}: a lease that did not wait keeps the launch path unchanged`, { skip }, (t) => {
    // The record closes at the first lease call, but nothing waited: no re-check, as before.
    const run1 = run(t, ext, engine, { replies: ['LEASED'], closeAt: 1 });
    assert.deepEqual(run1.launches, [ON_A], run1.out);
    assert.doesNotMatch(run1.out, /MOE_ACCOUNT_WAIT_STALE_ATTEMPT/);
    assert.deepEqual(run1.sleeps, []);
    assert.equal(run1.leases, 1);
  });
}
