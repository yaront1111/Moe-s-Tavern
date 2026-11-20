// Measured 2026-11-20: an interactive architect seat on a spent Claude account
// relaunched five times; claude stopped at its usage limit each time, and
// moe-account-switch ended every session with /exit, so each one exited 0 after
// ~49 s. The launch-failure guard only counted non-zero exits, so all five
// burned the resume budget: "pausing auto-resume" went to @governors and the
// seat idled for 2.5 h after the limit had reset. A run claude stopped at the
// limit (a `rejected` window in the leased account's usage sample, written by the
// stream parser or by moe-account-switch) must count as a launch failure
// whatever its exit code, and keep its task; any other fast exit 0 that leaves
// the task where it was must still trip the cap, once.
//
// The REAL pre-flight resume cap, usage-sample, account and launch-failure
// blocks are cut out of moe-agent.{sh,ps1} and run in a pass loop shaped like
// the main loop: every pass resumes the held task, "launches" a ~49 s run on
// the leased account (the worst case: the daemon hands back the same account)
// and classifies its exit. The scripted daemon logs every RPC.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
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
// No account, token or seat variable of the seat running this test may reach the cut.
function cleanEnv(extra) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(MOE_|CLAUDE_|ANTHROPIC_)/i.test(name)));
  return { ...env, ...extra };
}

const CAP = 2;

function shScript(dir) {
  const src = source('sh');
  return [
    'set -e',
    `WORKER_ID=architect-limit ROLE=architect AUTO_CLAIM=true GENERAL_CHANNEL_ID=chan-general VM_ROUTE=false PYTHON_CMD=${PYTHON}`,
    // The sign-in probe never runs claude here: a no-op "node" prints no state.
    "NODE_CMD=true ACCOUNT_HELPER=unused COMMAND_BIN=claude COMMAND_ARGV=() YELLOW='' GREEN='' RED='' NC=''",
    `RESUME_MAX_ATTEMPTS=${CAP} LAUNCH_FAIL_SEC=120 LAUNCH_BACKOFF_BASE_SEC=60 LAUNCH_BACKOFF_MAX_SEC=900`,
    'RESUME_TRACK_TASK_ID="" RESUME_ATTEMPTS=0 RESUME_ESCALATED=false LAUNCH_FAIL_STREAK=0 LAUNCH_FAIL_BACKOFF_SEC=0 LAUNCH_FAIL_HEAD=""',
    'LAUNCH_OUTAGE=false LAUNCH_OUTAGE_HELD_TASK_ID="" LAUNCH_OUTAGE_RELEASE_TRIED="" LAUNCH_OUTAGE_ANNOUNCE=false LAUNCH_OUTAGE_RELEASE_CODE=""',
    `ACCOUNT_SAMPLE_FILE=${shQuote(fwd(path.join(dir, 'sample.json')))}`,
    'ACCOUNT_LEASED_ID="" ACCOUNT_LEASED_DIR="" ACCOUNT_SAMPLE_SENT="" ACCOUNT_SAMPLE_REFUSED=false ACCOUNT_LIMIT_HIT=false',
    'ACCOUNT_RELAUNCH=false ACCOUNT_LAST_FAILED="" ACCOUNT_ARGS=()',
    // The scripted daemon: every call is logged; REPORT_FAILS=1 leaves report_account_usage unanswered.
    'moe_rpc() {',
    '    printf \'%s\\t%s\\n\' "$1" "$2" >> "$RPC_LOG"',
    '    if [ "$1" = report_account_usage ] && [ "${REPORT_FAILS:-}" = 1 ]; then return 1; fi',
    '    printf \'{"success":true}\'',
    '}',
    'preflight_landing() { :; }',
    between(src, '# printf, not echo -e: a reason from the daemon is printed as is.', '# announce_account_untrusted ACCOUNT_ID REASON'),
    between(src, '# Sends the latest usage sample (written by the stream parser, the statusline,', '# --- Verified-local seat VM (CQ-M07m3)'),
    'PASS=0',
    'while [ "$PASS" -lt "$PASSES" ]; do',
    '    PASS=$((PASS + 1))',
    // Pre-flight: claim_next_task answers alreadyAssigned with the held task.
    '    RESUME_TASK_ID=task-held RESUME_TASK_TITLE=held RESUME_TASK_STATUS=PLANNING',
    between(src, '            if [ -n "$RESUME_TASK_ID" ]; then\n                if [ "$RESUME_TRACK_TASK_ID" != "$RESUME_TASK_ID" ]; then',
      '            if [ "$HAS_NEXT" = "true" ] || [ -n "$RESUME_TASK_ID" ]; then'),
    '    if [ -z "$RESUME_TASK_ID" ]; then echo "PASS $PASS idle"; continue; fi',
    // The launch: a fresh lease on the same account, a ~49 s run, its exit code and its sample.
    '    PREFLIGHT_TASK_ID=task-held PREFLIGHT_HELD_TASK_ID=task-held MOE_SKIP_LAUNCH=false CURRENT_LAUNCH_FAILED=false ACCOUNT_RELAUNCH=false',
    '    clear_account_lease',
    `    ACCOUNT_LEASED_ID=acct-2 ACCOUNT_LEASED_DIR=${shQuote(fwd(dir))}`,
    '    CLI_LAUNCHED_AT=$(( $(date +%s) - 49 )) CLI_EXIT_CODE=$CLI_EXIT',
    '    if [ -n "${SAMPLE:-}" ]; then printf \'%s\' "$SAMPLE" > "$ACCOUNT_SAMPLE_FILE"; fi',
    between(src, '    # Launch-failure classification (tracker declared above the main loop).', '    # -------- Post-flight: shutdown rituals after CLI exits --------'),
    '    echo "PASS $PASS launched failed=$CURRENT_LAUNCH_FAILED relaunch=$ACCOUNT_RELAUNCH attempts=$RESUME_ATTEMPTS streak=$LAUNCH_FAIL_STREAK outage=$LAUNCH_OUTAGE"',
    'done',
  ].join('\n');
}

function ps1Script(dir) {
  const src = source('ps1');
  return [
    '\ufeff$ErrorActionPreference = \'Stop\'',
    '[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)',
    '$utf8 = [Text.UTF8Encoding]::new($false)',
    // The scripted daemon: every call is logged; REPORT_FAILS=1 leaves report_account_usage unanswered.
    'function Invoke-MoeRpc {',
    '    param([Parameter(Mandatory = $true)][string]$Tool, [object]$Args)',
    '    [IO.File]::AppendAllText($env:RPC_LOG, "$Tool`t$($Args | ConvertTo-Json -Compress -Depth 6)`n", $utf8)',
    "    if ($Tool -eq 'report_account_usage' -and $env:REPORT_FAILS -eq '1') { return $null }",
    '    return [pscustomobject]@{ success = $true }',
    '}',
    'function Invoke-MoeIdleRecovery { param($TaskId, $Status) }',
    // The sign-in probe never runs claude here.
    "function Invoke-MoeAccountHelper { param([string[]]$HelperArgs, [string]$InputText) return 'subscription' }",
    "$WorkerId = 'architect-limit'; $Role = 'architect'; $AutoClaim = $true; $generalChannelId = 'chan-general'",
    "$Command = 'claude'; $CommandArgs = @(); $script:MoeProtectedCli = $false; $script:MoeVmRoute = $false",
    `$resumeMaxAttempts = ${CAP}; $launchFailSec = 120; $launchBackoffBaseSec = 60; $launchBackoffMaxSec = 900`,
    "$script:ResumeTrackTaskId = ''; $script:ResumeAttempts = 0; $script:ResumeEscalated = $false",
    "$script:LaunchFailStreak = 0; $script:LaunchFailBackoffSec = 0; $script:LaunchFailHead = ''; $script:LaunchOutage = $false",
    "$script:LaunchOutageHeldTaskId = ''; $script:LaunchOutageReleaseTried = ''; $script:LaunchOutageAnnounce = $false; $script:LaunchOutageReleaseCode = ''",
    `$script:AccountSampleFile = ${psQuote(path.join(dir, 'sample.json'))}`,
    "$script:AccountLeasedId = ''; $script:AccountLeasedDir = ''; $script:AccountSampleSent = ''; $script:AccountWindows = [ordered]@{}",
    "$script:AccountSampleRefused = $false; $script:AccountLimitHit = $false; $script:AccountRelaunch = $false; $script:AccountLastFailed = ''; $accountArgs = @()",
    between(src, 'function Clear-MoeAccountLease {', 'function Get-MoeAccountLease {'),
    between(src, '# Sends the latest usage sample (written by the stream parser, the statusline,', '# --- Verified-local seat VM (CQ-M07n3)'),
    'for ($pass = 1; $pass -le [int]$env:PASSES; $pass++) {',
    // Pre-flight: claim_next_task answers alreadyAssigned with the held task.
    "    $resumeInfo = [pscustomobject]@{ taskId = 'task-held'; status = 'PLANNING' }",
    between(src, '            if ($resumeInfo) {\n                if ($script:ResumeTrackTaskId -ne [string]$resumeInfo.taskId) {',
      '            # Worker is registered by team-setup join_team (above) when teams are'),
    '    if (-not $resumeInfo) { [Console]::Out.WriteLine("PASS $pass idle"); continue }',
    // The launch: a fresh lease on the same account, a ~49 s run, its exit code and its sample.
    "    $preflightTaskId = 'task-held'; $preflightHeldTaskId = 'task-held'; $moeSkipLaunch = $false; $moeCurrentLaunchFailed = $false; $script:AccountRelaunch = $false",
    '    Clear-MoeAccountLease',
    `    $script:AccountLeasedId = 'acct-2'; $script:AccountLeasedDir = ${psQuote(dir)}`,
    '    $script:CliLaunchedAt = (Get-Date).AddSeconds(-49); $script:CliExitCode = [int]$env:CLI_EXIT',
    '    if ($env:SAMPLE) { [IO.File]::WriteAllText($script:AccountSampleFile, $env:SAMPLE, $utf8) }',
    between(src, '    # Launch-failure classification (tracker declared above the main loop).', '    if ($script:cliRootPushed) { Pop-Location; $script:cliRootPushed = $false }'),
    '    [Console]::Out.WriteLine(\'PASS \' + "$pass launched failed=$moeCurrentLaunchFailed relaunch=$($script:AccountRelaunch) attempts=$($script:ResumeAttempts) streak=$($script:LaunchFailStreak) outage=$($script:LaunchOutage)".ToLowerInvariant())',
    '}',
  ].join('\n');
}

function run(t, ext, engine, { passes, exit = 0, sample = '', reportFails = false }) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'moe-usage-limit-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const rpcLog = path.join(dir, 'rpc.log');
  fs.writeFileSync(rpcLog, '');
  const script = path.join(dir, `passes.${ext}`);
  fs.writeFileSync(script, ext === 'sh' ? shScript(dir) : ps1Script(dir));
  const args = ext === 'sh' ? ['--noprofile', '--norc', fwd(script)] : ['-NoProfile', '-NonInteractive', '-File', script];
  const r = spawnSync(engine, args, {
    encoding: 'utf8', timeout: 120000,
    env: cleanEnv({ RPC_LOG: ext === 'sh' ? fwd(rpcLog) : rpcLog, PASSES: String(passes), CLI_EXIT: String(exit),
      SAMPLE: sample, REPORT_FAILS: reportFails ? '1' : '' }),
  });
  assert.equal(r.status, 0, `${engine} exited ${r.status}\n${r.stdout}\n${r.stderr}`);
  const rpcs = fs.readFileSync(rpcLog, 'utf8').split('\n').filter(Boolean).map((line) => line.split('\t'));
  const chats = rpcs.filter(([tool]) => tool === 'chat_send').map(([, body]) => body);
  const passLines = r.stdout.split(/\r?\n/).filter((line) => line.startsWith('PASS '));
  return { out: r.stdout, passLines, rpcs, chats };
}

const count = (lines, text) => lines.filter((line) => line.includes(text)).length;
const RESET = '2026-11-20T18:30:00.000Z';
// What moe-account-switch writes when claude stops at the limit; the -p stream
// parser writes the same window status from a rejected rate_limit_event.
const LIMIT = JSON.stringify({ accountId: 'acct-2', windows: { five_hour: { percent: 100, status: 'rejected', resetsAt: RESET } }, refused: true });

for (const [ext, engine] of ENGINES) {
  const skip = (ext === 'sh' && !PYTHON && 'no python 3') || (!runs(ext, engine) && `${engine} is not available`);

  test(`${engine}: fast exit-0 runs claude stopped at the usage limit never pause auto-resume`, { skip }, (t) => {
    const r = run(t, ext, engine, { passes: 8, sample: LIMIT });
    assert.equal(r.passLines.length, 8, r.out);
    assert.equal(count(r.passLines, 'idle'), 0, `every pass relaunched the held task:\n${r.out}`);
    assert.ok(!r.out.includes('Auto-resume cap reached'), r.out);
    assert.equal(count(r.chats, 'pausing auto-resume'), 0, r.chats.join('\n'));
    // The refused sample reaches the daemon (it parks the account until the window resets) ...
    const reports = r.rpcs.filter(([tool]) => tool === 'report_account_usage').map(([, body]) => JSON.parse(body));
    assert.ok(reports.length >= 1 && reports.every((a) => a.refused === true && a.windows.five_hour.status === 'rejected'), JSON.stringify(reports));
    // ... the first run relaunches at once on the next account ...
    assert.ok(r.out.includes('MOE_ACCOUNT_REFUSED account=acct-2 exit=0 - relaunching on the next account'), r.out);
    assert.match(r.passLines[0], /failed=true relaunch=true attempts=0 streak=0 /);
    // ... and when the same account comes back, each run is a launch failure that backs off, keeping the task.
    for (const line of r.passLines.slice(1)) assert.match(line, /failed=true relaunch=false attempts=0 streak=\d+ outage=false/);
    assert.ok(!r.out.includes('entering launch outage mode'), r.out);
    assert.equal(count(r.chats, 'keeps its task; no release needed.'), 1, r.chats.join('\n'));
  });

  test(`${engine}: a usage-limit run whose report the daemon did not take still backs off and keeps its task`, { skip }, (t) => {
    const r = run(t, ext, engine, { passes: 4, sample: LIMIT, reportFails: true });
    assert.ok(!r.out.includes('MOE_ACCOUNT_REFUSED'), r.out);
    assert.deepEqual(r.passLines.map((line) => line.match(/streak=(\d+)/)?.[1]), ['1', '2', '3', '4'], r.out);
    for (const line of r.passLines) assert.match(line, /failed=true relaunch=false attempts=0 /);
    assert.ok(!r.out.includes('Auto-resume cap reached') && !r.out.includes('entering launch outage mode'), r.out);
    assert.equal(count(r.chats, 'pausing auto-resume'), 0, r.chats.join('\n'));
    assert.equal(count(r.chats, 'keeps its task; no release needed.'), 1, r.chats.join('\n'));
  });

  // Controls: without a rejected window a fast exit 0 that leaves the task where
  // it was is a session that died holding it, so the cap trips, once. A sample
  // that is refused only for overage (claude ran on extra usage) is no refusal.
  for (const [name, sample] of [
    ['no usage sample', ''],
    ['an ordinary statusline sample', JSON.stringify({ accountId: 'acct-2', windows: { five_hour: { percent: 40 } }, refused: false })],
    ['a sample refused for overage only', JSON.stringify({ accountId: 'acct-2', windows: { five_hour: { utilization: 0.4, status: 'overage' } }, refused: true })],
  ]) {
    test(`${engine}: fast exit-0 runs with ${name} still trip the resume cap, once`, { skip }, (t) => {
      const r = run(t, ext, engine, { passes: CAP + 3, sample });
      assert.deepEqual(r.passLines.map((line) => (line.includes('idle') ? 'idle' : 'launched')),
        ['launched', 'launched', 'idle', 'idle', 'idle'], r.out);
      for (const line of r.passLines.filter((l) => l.includes('launched'))) assert.match(line, /failed=false relaunch=false /);
      assert.equal(count(r.chats, 'pausing auto-resume'), 1, r.chats.join('\n'));
      assert.match(r.chats.find((c) => c.includes('pausing auto-resume')), new RegExp(`CLI session ended ${CAP} times in a row while still holding task-held`));
      assert.ok(r.out.includes('Auto-resume cap reached'), r.out);
    });
  }

  // Outage mode is unchanged for every other fast failure: the third one releases the task.
  test(`${engine}: three fast non-zero exits without the limit still enter launch outage mode`, { skip }, (t) => {
    const r = run(t, ext, engine, { passes: 3, exit: 1 });
    assert.deepEqual(r.passLines.map((line) => line.match(/outage=(\w+)/)?.[1]), ['false', 'false', 'true'], r.out);
    assert.ok(r.out.includes('entering launch outage mode'), r.out);
    assert.equal(count(r.chats, 'keeps its task; no release needed.'), 0, r.chats.join('\n'));
  });
}
