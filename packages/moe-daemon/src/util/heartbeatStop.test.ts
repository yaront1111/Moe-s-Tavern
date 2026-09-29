import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const sh = fs.readFileSync(path.join(root, 'scripts/moe-agent.sh'), 'utf8');
const psPath = path.join(root, 'scripts/moe-agent.ps1');
const ps = fs.readFileSync(psPath, 'utf8');
const shFunctions = sh.slice(sh.indexOf('HEARTBEAT_PID=""'), sh.indexOf('\npost_flight()'));
const hasBash = process.platform !== 'win32' && spawnSync('bash', ['--version']).status === 0;
const hasPwsh = spawnSync('pwsh', ['-NoProfile', '-Command', 'exit 0']).status === 0;

// Every process in this new group is created by this fixture. On RED, kill
// that group before returning: a hung cleanup must not leak test sidecars.
function run(command: string, args: string[], timeout = 8000) {
  return new Promise<{ output: string; code: number | null; timedOut: boolean }>((resolve, reject) => {
    const child = spawn(command, args, { detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', timedOut = false;
    child.stdout.on('data', b => { output += b.toString(); });
    child.stderr.on('data', b => { output += b.toString(); });
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid) {
        if (process.platform === 'win32') child.kill('SIGKILL');
        else { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already exited */ } }
      }
    }, timeout);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => { clearTimeout(timer); resolve({ output, code, timedOut }); });
  });
}

const psFunctions = `
$ast = [System.Management.Automation.Language.Parser]::ParseFile('${psPath.replaceAll("'", "''")}', [ref]$null, [ref]$null)
foreach ($name in @('Start-HeartbeatSidecar', 'Stop-HeartbeatSidecar')) {
  $def = $ast.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name }, $true)
  Invoke-Expression $def.Extent.Text
}
`;

describe('heartbeat cleanup cannot strand the wrapper after the CLI exits', () => {
  it.skipIf(!hasBash)('does not re-exec and lose a pending Bash sidecar handle', async () => {
    const from = sh.indexOf('\n    if [ -n "$MOE_WRAPPER_LAUNCH_HASH" ]; then');
    const body = sh.slice(from, sh.indexOf('\n    IS_FIRST_ITERATION=', from));
    const r = await run('bash', ['-c', `
set -e
MOE_WRAPPER_LAUNCH_HASH=old; MOE_WRAPPER_PATH=unused; HEARTBEAT_PID=123
MOE_WRAPPER_ARGV=(); WORKER_ID=''; PROJECT=''; SECURE_TEMP_DIR=''
sha256sum() { echo 'new unused'; }
stop_heartbeat_sidecar() { :; }
exec() { echo BAD_REEXEC; }
for once in 1; do
${body}
done
echo RETAINED_HANDLE
`]);
    expect(r.code, r.output).toBe(0);
    expect(r.output).not.toContain('BAD_REEXEC');
    expect(r.output).toContain('RETAINED_HANDLE');
  });

  it.skipIf(!hasPwsh)('does not reload and lose a pending PowerShell job handle', async () => {
    const from = ps.indexOf('\n    if ($script:MoeWrapperLaunchHash) {');
    const body = ps.slice(from, ps.indexOf('\n    $isFirstIteration', from));
    const r = await run('pwsh', ['-NoProfile', '-Command', `
$ErrorActionPreference = 'Stop'
$script:MoeWrapperLaunchHash = 'old'
$script:MoeWrapperPath = '${psPath.replaceAll("'", "''")}'
$script:CurrentHeartbeatJob = [pscustomobject]@{ State = 'Running' }
function Get-MoeSha256Hex { 'new' }
function Stop-HeartbeatSidecar {}
function Invoke-MoeDeregister { throw 'BAD_RELOAD' }
for ($once=0; $once -lt 1; $once++) {
${body}
}
Write-Output RETAINED_HANDLE
`]);
    expect(r.code, r.output).toBe(0);
    expect(r.output).not.toContain('BAD_RELOAD');
    expect(r.output).toContain('RETAINED_HANDLE');
    // A cold pwsh start on a loaded CI runner under coverage can pass 5s; run()
    // itself allows 8s, so give vitest more than that (matches the bash sibling).
  }, 12000);

  it.skipIf(!hasBash).each(['ignore', 'stopped'])('bounds a %s TERM-resistant owned helper without killing a peer', async mode => {
    const r = await run('bash', ['-c', `
set -e
${shFunctions}
(trap '' TERM; while :; do sleep 0.05; done) &
HEARTBEAT_PID=$!; helper=$HEARTBEAT_PID
(while :; do sleep 0.05; done) &
peer=$!
trap 'kill -KILL "$helper" "$peer" 2>/dev/null || true; wait 2>/dev/null || true' EXIT
sleep 0.1
${mode === 'stopped' ? 'kill -STOP "$helper"' : ':'}
stop_heartbeat_sidecar
[ -z "$HEARTBEAT_PID" ]
! kill -0 "$helper" 2>/dev/null
kill -0 "$peer"
stop_heartbeat_sidecar
echo CLEANED_OWN_HELPER_PEER_ALIVE
`]);
    expect(r.timedOut, r.output).toBe(false);
    expect(r.code, r.output).toBe(0);
    expect(r.output).toContain('CLEANED_OWN_HELPER_PEER_ALIVE');
  }, 12000);

  it.skipIf(!hasBash)('does not signal an unrelated PID stored in a stale slot', async () => {
    const r = await run('bash', ['-c', `
set -e
${shFunctions}
HEARTBEAT_PID=$PPID
kill() { echo UNEXPECTED_KILL "$*"; return 1; }
stop_heartbeat_sidecar
[ -z "$HEARTBEAT_PID" ]
echo STALE_SLOT_CLEARED
`]);
    expect(r.code, r.output).toBe(0);
    expect(r.output).not.toContain('UNEXPECTED_KILL');
    expect(r.output).toContain('STALE_SLOT_CLEARED');
  });

  it.skipIf(!hasBash)('does not interpret a corrupt PID as a wait option', async () => {
    const r = await run('bash', ['-c', `
set -e
${shFunctions}
sleep 30 &
peer=$!
trap 'kill "$peer" 2>/dev/null || true; wait 2>/dev/null || true' EXIT
HEARTBEAT_PID=-n
stop_heartbeat_sidecar
[ -z "$HEARTBEAT_PID" ]
kill -0 "$peer"
echo INVALID_SLOT_IGNORED
`], 3000);
    expect(r.timedOut, r.output).toBe(false);
    expect(r.code, r.output).toBe(0);
    expect(r.output).toContain('INVALID_SLOT_IGNORED');
  }, 5000);

  it.skipIf(!hasBash)('retains ownership and refuses a duplicate when even KILL cannot finish the helper', async () => {
    const r = await run('bash', ['-c', `
set -e
${shFunctions}
(trap '' TERM; while :; do sleep 0.05; done) &
HEARTBEAT_PID=$!; helper=$HEARTBEAT_PID
trap 'builtin kill -KILL "$helper" 2>/dev/null || true; wait 2>/dev/null || true' EXIT
# Only the fixture's signal operation is suppressed; this models a helper
# that cannot exit promptly without putting any real process in D state.
kill() { return 0; }
sleep 0.1
stop_heartbeat_sidecar
[ "$HEARTBEAT_PID" = "$helper" ]
unset MOE_DISABLE_HEARTBEAT
start_heartbeat_sidecar fixture
[ "$HEARTBEAT_PID" = "$helper" ]
[ "$(jobs -pr | wc -l)" -eq 1 ]
echo OWNERSHIP_RETAINED_NO_DUPLICATE
`], 12000);
    expect(r.timedOut, r.output).toBe(false);
    expect(r.code, r.output).toBe(0);
    expect(r.output).toContain('MOE_HEARTBEAT_STOP_TIMEOUT');
    expect(r.output).toContain('OWNERSHIP_RETAINED_NO_DUPLICATE');
  }, 15000);

  it.skipIf(!hasPwsh)('bounds a slow PowerShell job stop and retains its handle until cleanup finishes', async () => {
    const r = await run('pwsh', ['-NoProfile', '-Command', `${psFunctions}
$ErrorActionPreference = 'Stop'
# A slow .NET stop is represented by an object method; unlike a peer process,
# it only belongs to this fixture. The legacy cmdlet shim calls the same method.
function Stop-Job { param($Job) $Job.StopJob() }
function Remove-Job { param($Job, [switch]$Force) if ($Job.State -ne 'Stopped') { throw 'removed live job' } }
function Start-Job { throw 'duplicate sidecar' }
$script:CurrentHeartbeatJob = [pscustomobject]@{ State = 'Running'; ChildJobs = @(); Calls = 0 }
$script:CurrentHeartbeatJob | Add-Member ScriptMethod StopJob { $this.Calls++; Start-Sleep -Seconds 7; $this.State = 'Stopped' }
$owned = $script:CurrentHeartbeatJob
$watch = [Diagnostics.Stopwatch]::StartNew()
Stop-HeartbeatSidecar
$elapsed = $watch.ElapsedMilliseconds
if ($elapsed -ge 3000) { throw "unbounded stop: $elapsed ms" }
if ($script:CurrentHeartbeatJob -ne $owned) { throw 'lost pending ownership' }
$env:MOE_DISABLE_HEARTBEAT = $null
$null = Start-HeartbeatSidecar -ProxyScript unused -ProjectPath unused -WorkerId fixture
if ($script:CurrentHeartbeatJob -ne $owned) { throw 'replaced pending ownership' }
Start-Sleep -Seconds 4
Stop-HeartbeatSidecar
if ($script:CurrentHeartbeatJob) { throw 'finished job retained' }
if ($owned.Calls -ne 1) { throw 'duplicate stop worker' }
Write-Output BOUNDED_STOP_REAPED
`], 12000);
    expect(r.timedOut, r.output).toBe(false);
    expect(r.code, r.output).toBe(0);
    expect(r.output).toContain('BOUNDED_STOP_REAPED');
  }, 15000);

  it.skipIf(!hasPwsh)('stops a real PowerShell background job, preserving an unrelated job', async () => {
    const r = await run('pwsh', ['-NoProfile', '-Command', `${psFunctions}
$ErrorActionPreference = 'Stop'
$script:CurrentHeartbeatJob = Start-Job { Start-Sleep -Seconds 30 }
$ownedId = $script:CurrentHeartbeatJob.Id
$peer = Start-Job { Start-Sleep -Seconds 30 }
try {
  Stop-HeartbeatSidecar
  if ($script:CurrentHeartbeatJob) { throw 'owned job not cleaned' }
  if (Get-Job -Id $ownedId -ErrorAction SilentlyContinue) { throw 'owned job remains registered' }
  if ($peer.State -ne 'Running') { throw 'peer job touched' }
  Stop-HeartbeatSidecar
  Write-Output OWNED_JOB_ONLY
} finally { Stop-Job $peer; Remove-Job $peer }
`]);
    expect(r.timedOut, r.output).toBe(false);
    expect(r.code, r.output).toBe(0);
    expect(r.output).toContain('OWNED_JOB_ONLY');
  }, 12000);
});
