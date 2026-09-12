# Routed-@mention delivery provenance harness (PowerShell twin).
#
# scripts/moe-agent.ps1 is what actually runs the fleet (live agents are
# launched from the installed PyCharm plugin copy of it), so this twin is the
# load-bearing one. It assembles a REAL session context in a disposable
# throwaway project -- never a live board -- and asserts that every body
# delivered in <routed_mentions> is byte-identical to the record stored in
# .moe/messages/<channel>.jsonl.
#
# Cases, assertions and the independent store read live in
# mention-provenance-seed.py, shared with the bash twin so the two cannot drift.
param([ValidateSet('powershell', 'pwsh')][string]$PowerShell)

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$wrapper = Join-Path $root 'scripts\moe-agent.ps1'
$seedPy = Join-Path $root 'scripts\tests\mention-provenance-seed.py'
$fakeProxy = Join-Path $root 'scripts\tests\mention-provenance-proxy.js'
$channel = 'chan-provenance'
$workerId = 'worker-provenance'

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host 'SKIP mention-provenance.ps1: node is not available'
    exit 0
}
$py = $null
foreach ($candidate in @('python', 'python3')) {
    $cmd = Get-Command $candidate -ErrorAction SilentlyContinue
    if (-not $cmd) { continue }
    # Windows ships an App Execution Alias stub for python3.exe that fails to
    # run at all; a bare invocation must not abort the harness.
    try {
        $ver = (& $cmd.Source --version 2>&1 | Out-String)
    } catch { continue }
    if ($ver -match 'Python 3\.') { $py = $cmd.Source; break }
}
if (-not $py) {
    Write-Host 'SKIP mention-provenance.ps1: python 3 is not available'
    exit 0
}
$psExe = if ($PowerShell) { $PowerShell } elseif (Get-Command pwsh -ErrorAction SilentlyContinue) { 'pwsh' } else { 'powershell' }
Write-Host "[child] $psExe"

# The stored-timestamp guard lives in Get-MoeStoredMentionRecord and runs in the
# CHILD host, not in this one. On PowerShell 6+ ConvertFrom-Json coerces an ISO
# string to [datetime], so the guard has to re-read the RAW token -- and if the
# reader type does not resolve THERE it throws on precisely the record it exists
# to fix. Probe the selected child and record what actually answered; a host
# that cannot be probed is not a host this harness may report green on.
$probeScript = '$ErrorActionPreference = ''Stop''; "PROBE_HOST exe=" + (Get-Process -Id $PID).Path + " version=" + $PSVersionTable.PSVersion.ToString(); if ($PSVersionTable.PSVersion.Major -ge 6) { "PROBE_TYPES reader=" + [Newtonsoft.Json.JsonTextReader].Assembly.FullName + " jobject=" + [Newtonsoft.Json.Linq.JObject].Assembly.FullName } else { "PROBE_TYPES not-required host=WindowsPowerShell-" + $PSVersionTable.PSVersion.ToString() + " ConvertFrom-Json leaves ISO strings as [string] here" }'
# Printed single-quoted with inner quotes doubled, so the line above is a
# literally re-runnable command rather than an approximation of one.
$probeDisplay = "$psExe -NoProfile -Command '" + ($probeScript -replace "'", "''") + "'"
Write-Host "[probe] $probeDisplay"
$probeOut = @()
$probeRc = 1
try {
    $prevProbeEap = $ErrorActionPreference
    # Continue, not Stop: a child that writes to stderr must be REPORTED with
    # its own output below, not turned into an opaque terminating error here.
    $ErrorActionPreference = 'Continue'
    $probeOut = @(& $psExe -NoProfile -Command $probeScript 2>&1 | ForEach-Object { "$_" })
    $probeRc = $LASTEXITCODE
} catch {
    $probeOut = @("probe could not be launched: $_")
    $probeRc = 1
} finally {
    $ErrorActionPreference = $prevProbeEap
}
$probeHostLine = @($probeOut | Where-Object { $_ -like 'PROBE_HOST *' })[0]
$probeTypeLine = @($probeOut | Where-Object { $_ -like 'PROBE_TYPES *' })[0]
if ($probeRc -ne 0 -or -not $probeHostLine -or -not $probeTypeLine) {
    $probeOut | ForEach-Object { Write-Host "  $_" }
    Write-Host "FAIL: child host probe failed (exit $probeRc); the stored-timestamp guard cannot be trusted on $psExe" -ForegroundColor Red
    exit 1
}
Write-Host ("PROVENANCE_HOST " + ($probeHostLine -replace '^PROBE_HOST ', ''))
Write-Host ("PROVENANCE_JSON_TYPES " + ($probeTypeLine -replace '^PROBE_TYPES ', ''))
$childMajor = 0
if ($probeHostLine -match 'version=(\d+)\.') { $childMajor = [int]$Matches[1] }
if ($childMajor -lt 1) {
    Write-Host "FAIL: child host reported no parseable version: $probeHostLine" -ForegroundColor Red
    exit 1
}
# PS5 never reaches the raw-token branch, so it must NOT be made to depend on a
# Core-only assembly; PS6+ does reach it, so an unresolved reader is a failure.
if ($childMajor -ge 6 -and $probeTypeLine -notmatch 'reader=\S+.*jobject=\S+') {
    Write-Host "FAIL: PowerShell $childMajor coerces ISO strings to [datetime] but resolved no raw-token JSON reader: $probeTypeLine" -ForegroundColor Red
    exit 1
}

$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("moe-mention-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
$projectDir = Join-Path $tempRoot 'project'
$homeDir = Join-Path $tempRoot 'home'
New-Item -ItemType Directory -Force -Path (Join-Path $projectDir '.moe\messages') | Out-Null
New-Item -ItemType Directory -Force -Path $homeDir | Out-Null
[System.IO.File]::WriteAllText(
    (Join-Path $projectDir '.moe\project.json'),
    '{"id":"proj-provenance","name":"provenance","settings":{"autoCommit":false}}' + "`n",
    [System.Text.UTF8Encoding]::new($false))

$caseCount = (& $py -B $seedPy seed $projectDir $channel $workerId | Select-Object -Last 1)
if ([int]$caseCount -lt 8) {
    Write-Host "Seed produced $caseCount cases; a sweep that generates nothing must not pass" -ForegroundColor Red
    exit 1
}
Write-Host "[seed] $caseCount stored cases + 2 synthetic delivery-failure cases"

# Capture stands in for the CLI. With a fat prompt the wrapper takes its Windows
# overflow path and embeds the assembled context in the --append-system-prompt-file
# file (case-d is sized to guarantee that), so the capture copies that file --
# the exact bytes a real worker session is handed.
$captureCmd = Join-Path $tempRoot 'claude.cmd'
$captureBody = @'
@echo off
setlocal
set "prev="
:loop
if "%~1"=="" goto done
if /I "%prev%"=="--append-system-prompt-file" (
  type "%~1" > "%MOE_PROVENANCE_CAPTURE%"
  goto done
)
set "prev=%~1"
shift
goto loop
:done
exit /b 0
'@
[System.IO.File]::WriteAllText($captureCmd, $captureBody, [System.Text.ASCIIEncoding]::new())

function Invoke-ProvenanceMode {
    param([string]$Mode)
    $capture = Join-Path $tempRoot "capture-$Mode.txt"
    $wrapperOut = Join-Path $tempRoot "wrapper-$Mode.out"
    # Re-seed per mode: the wrapper's post-flight appends its own session-ended
    # message to the same #general jsonl, so a second run would otherwise read a
    # fixture the first run had already grown.
    & $py -B $seedPy seed $projectDir $channel $workerId | Out-Null
    $saved = @{
        proxy = $env:MOE_PROXY_PATH; profile = $env:USERPROFILE; temp = $env:TEMP
        mode = $env:MOE_PROVENANCE_MODE; worker = $env:MOE_PROVENANCE_WORKER
        chan = $env:MOE_PROVENANCE_CHANNEL; cap = $env:MOE_PROVENANCE_CAPTURE
    }
    try {
        $env:MOE_PROXY_PATH = $fakeProxy
        $env:USERPROFILE = $homeDir
        $env:TEMP = $tempRoot
        $env:MOE_PROVENANCE_MODE = $Mode
        $env:MOE_PROVENANCE_WORKER = $workerId
        $env:MOE_PROVENANCE_CHANNEL = $channel
        $env:MOE_PROVENANCE_CAPTURE = $capture
        $prevEap = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        & $psExe -NoProfile -File $wrapper `
            -Project $projectDir `
            -WorkerId $workerId `
            -Role worker `
            -NoStartDaemon `
            -Command $captureCmd `
            -Loop `
            -PollInterval 0 `
            *> $wrapperOut
        $rc = $LASTEXITCODE
        $ErrorActionPreference = $prevEap
    } finally {
        $env:MOE_PROXY_PATH = $saved.proxy; $env:USERPROFILE = $saved.profile
        $env:TEMP = $saved.temp; $env:MOE_PROVENANCE_MODE = $saved.mode
        $env:MOE_PROVENANCE_WORKER = $saved.worker; $env:MOE_PROVENANCE_CHANNEL = $saved.chan
        $env:MOE_PROVENANCE_CAPTURE = $saved.cap
    }
    if ($rc -ne 0) {
        Get-Content $wrapperOut -Tail 40 | ForEach-Object { Write-Host "  $_" }
        Write-Host "FAIL mode=${Mode}: wrapper exited $rc" -ForegroundColor Red
        return 1
    }
    if (-not (Test-Path $capture) -or (Get-Item $capture).Length -eq 0) {
        Get-Content $wrapperOut -Tail 40 | ForEach-Object { Write-Host "  $_" }
        Write-Host "FAIL mode=${Mode}: CLI was never launched, nothing captured" -ForegroundColor Red
        return 1
    }
    # Route the verifier's own output through Write-Host: anything left on the
    # pipeline would be folded into this function's return value, and the
    # caller's `-ne 0` test would then compare an ARRAY of report lines instead
    # of the exit code -- a green/red decision made on the wrong operand.
    & $py -B $seedPy verify $projectDir $channel $capture $Mode 2>&1 |
        ForEach-Object { Write-Host "  $_" }
    return $LASTEXITCODE
}

$status = 0
try {
    # faithful: the RPC carries the true bodies, truncated at maxContentChars
    # like the real chat_read. substitute: the RPC carries the impersonation
    # payload, reproducing the reported defect while the store stays correct.
    foreach ($mode in @('faithful', 'substitute')) {
        Write-Host "== mode=$mode =="
        if ((Invoke-ProvenanceMode -Mode $mode) -ne 0) { $status = 1 }
    }
} finally {
    if (-not $env:MOE_PROVENANCE_KEEP) {
        Remove-Item -Recurse -Force $tempRoot -ErrorAction SilentlyContinue
    } else {
        Write-Host "[keep] $tempRoot"
    }
}

if ($status -ne 0) {
    Write-Host 'mention-provenance.ps1 FAILED' -ForegroundColor Red
    exit 1
}
Write-Host "mention-provenance.ps1 PASSED ($caseCount stored cases + 2 synthetic delivery-failure cases, 2 modes)" -ForegroundColor Green
exit 0
