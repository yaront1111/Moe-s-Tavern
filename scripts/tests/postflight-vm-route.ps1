# CQ-M07n1: twin of postflight-vm-route.sh, without the sh-only WSL rows.
# Run alone with powershell.exe or pwsh.exe -NoProfile -File this-file.ps1.
# Exit 0 = all rows passed, 1 = assertion failed, 2 = harness fault; never SKIP.
param()
$ErrorActionPreference = 'Stop'
$savedEnv = @{}
Get-ChildItem Env: | ForEach-Object { $savedEnv[$_.Name] = $_.Value }
Get-ChildItem Env: | Where-Object {
    $_.Name -match '^(MOE_|CLAUDE|FAKE_)' -and $_.Name -notin @('MOE_POSTFLIGHT_TIMEOUT_SEC', 'MOE_POSTFLIGHT_KEEP_TEMP')
} | Remove-Item
$env:MOE_ACCOUNT_ROTATION = 'off'
$env:MOE_POSTFLIGHT_TEST_ALLOW_WORKTREE_WRAPPER = '1'
$root = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$wrapper = Join-Path $root 'scripts\moe-agent.ps1'
$psExe = if ($PSVersionTable.PSVersion.Major -ge 6) { 'pwsh' } else { 'powershell' }
$tempRoot = Join-Path ([IO.Path]::GetTempPath()) ('moe-vm-route-' + [guid]::NewGuid().ToString('N'))
$project = Join-Path $tempRoot 'project'
$runTmp = Join-Path $tempRoot 'tmp'
$homeDir = Join-Path $tempRoot 'home'
$rec = Join-Path $tempRoot 'cli-record.json'
$calls = Join-Path $tempRoot 'calls.jsonl'
$out = Join-Path $tempRoot 'wrapper.out'
$fakeProxy = Join-Path $tempRoot 'fake-proxy.js'
$wrapperTimeoutSec = 60
if ($env:MOE_POSTFLIGHT_TIMEOUT_SEC -match '^\d+$') { $wrapperTimeoutSec = [int]$env:MOE_POSTFLIGHT_TIMEOUT_SEC }

# Same timeout/owned-PID cleanup and 5.1 exit-code handling as postflight.ps1.
function Invoke-WrapperProcess([string[]]$WrapperArgs, [string]$OutFile, [int]$TimeoutSec = 0) {
    if ($TimeoutSec -le 0) { $TimeoutSec = $wrapperTimeoutSec }
    $quoted = @('-NoProfile', '-File', ('"' + $wrapper + '"'))
    foreach ($a in $WrapperArgs) {
        if ($a -match '[\s"]') { $quoted += ('"' + ($a -replace '"', '\"') + '"') } else { $quoted += $a }
    }
    $errFile = "$OutFile.err"
    Remove-Item -LiteralPath $OutFile, $errFile -Force -ErrorAction SilentlyContinue
    $p = Start-Process -FilePath $psExe -ArgumentList $quoted -RedirectStandardOutput $OutFile -RedirectStandardError $errFile -PassThru -NoNewWindow
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
function Invoke-VmrRow([string]$Row, [string]$Role, [string]$Cli, [string]$Readiness, [string]$Mode) {
    Remove-Item -LiteralPath $project, $runTmp, $homeDir, $rec, "$rec.context", $calls -Recurse -Force -ErrorAction SilentlyContinue
    New-Item -ItemType Directory -Force -Path (Join-Path $project '.moe\messages'), $runTmp, $homeDir | Out-Null
    $settings = '"autoCommit":false'
    switch -CaseSensitive ($Mode) {
        '-' {} 'gate' { $settings += ',"qualityGate":"true"' }
        'on' { $settings += ',"worktreeMode":"on"' } 'off' { $settings += ',"worktreeMode":"off"' }
        default { $settings += ',"worktreeMode":' + $Mode }
    }
    [IO.File]::WriteAllText((Join-Path $project '.moe\project.json'), ('{"id":"proj-vmr","name":"postflight-vm-route","settings":{' + $settings + '}}'))
    [IO.File]::WriteAllText((Join-Path $project '.moe\messages\chan-general.jsonl'), '')
    [IO.File]::WriteAllText((Join-Path $project '.moe\daemon.json'), ('{"port":9876,"projectPath":' + (ConvertTo-Json $project) + '}'))
    $env:FAKE_READINESS = $Readiness; $env:FAKE_CALL_LOG = $calls; $env:MOE_PROXY_PATH = $fakeProxy
    $env:MOE_DISABLE_HEARTBEAT = '1'; $env:MOE_TASKLESS_WAIT_SEC = '5'
    $env:USERPROFILE = $homeDir; $env:TEMP = $runTmp; $env:TMP = $runTmp
    Push-Location $project
    try {
        $code = Invoke-WrapperProcess @('-Project', $project, '-WorkerId', "$Role-vmr", '-Role', $Role, '-Team', 'Smoke', '-NoStartDaemon', '-Command', (Join-Path $tempRoot "$Cli.cmd"), '-NoLoop', '-PollInterval', '0') $out
    } finally { Pop-Location }
    $tools = @(if (Test-Path -LiteralPath $calls) { Get-Content -LiteralPath $calls | ForEach-Object { ($_ | ConvertFrom-Json).tool } })
    [pscustomobject]@{ Row = $Row; Code = $code; Text = [IO.File]::ReadAllText($out); Tools = $tools; Ran = (Test-Path -LiteralPath $rec) }
}
function Stop-Vmr($R, [string]$Why) { Write-Host $R.Text; throw "VM ROUTE FAILED ($($R.Row)): $Why" }
function Assert-VmrLaunched($R) {
    if ($R.Code -ne 0 -or -not $R.Ran) { Stop-Vmr $R "exit $($R.Code), CLI ran=$($R.Ran)" }
    if ($R.Text.Contains('MOE_VERIFIED_LOCAL_') -or $R.Text.Contains('[moe_rpc error:')) { Stop-Vmr $R 'today path printed a readiness error' }
    $read = [Array]::IndexOf($R.Tools, 'get_execution_readiness')
    $claim = [Array]::IndexOf($R.Tools, 'claim_next_task')
    if ($read -lt 0 -or $claim -le $read -or @($R.Tools | Where-Object { $_ -ceq 'get_execution_readiness' }).Count -ne 1) {
        Stop-Vmr $R ('not one readiness read before the claim: ' + ($R.Tools -join ' '))
    }
}
function Assert-VmrRefused($R, [string]$Code, [string]$Detail) {
    if ($R.Code -ne 1 -or $R.Ran) { Stop-Vmr $R "exit $($R.Code), CLI ran=$($R.Ran)" }
    $lines = @($R.Text -split '\r?\n' | Where-Object { $_.Contains('MOE_VERIFIED_LOCAL_') })
    if ($lines.Count -ne 1 -or $lines[0] -cne "[ERROR] ${Code}: $Detail") { Stop-Vmr $R "expected one exact $Code line" }
    $read = [Array]::IndexOf($R.Tools, 'get_execution_readiness')
    if ($read -lt 0 -or @($R.Tools | Where-Object { $_ -ceq 'get_execution_readiness' }).Count -ne 1) { Stop-Vmr $R 'not one readiness read' }
    for ($i = 0; $i -lt $read; $i++) {
        if ($R.Tools[$i] -match '^(chat_|get_pending_questions$|claim_next_task$)') { Stop-Vmr $R 'pre-flight RPC before readiness' }
    }
    if ($read -eq $R.Tools.Count - 1) { Stop-Vmr $R 'no deregister_worker after refusal' }
    for ($i = $read + 1; $i -lt $R.Tools.Count; $i++) {
        if ($R.Tools[$i] -cne 'deregister_worker') { Stop-Vmr $R "$($R.Tools[$i]) after refusal" }
    }
}
function Get-VmrNormalized {
    $normalized = & node $recorder normalize $rec $runTmp
    if ($LASTEXITCODE -ne 0) { throw 'record normalization failed' }
    return ($normalized -join "`n")
}

$exitCode = 2
try {
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'node is not available' }
    New-Item -ItemType Directory -Force -Path $tempRoot | Out-Null
    Copy-Item -LiteralPath (Join-Path $root 'scripts\tests\postflight-fake-proxy.js') -Destination $fakeProxy -ErrorAction Stop
    $recorder = Join-Path $tempRoot 'rec.cjs'
    # Per-run masks only: session, UUIDs and wrapper temporary names. FAKE_READINESS
    # is the varied input itself (m1's sole removed entry). Compare legacy twice.
    $body = @'
const fs = require('node:fs');
const [cli, ...argv] = process.argv.slice(2);
if (cli !== 'normalize') {
  fs.writeFileSync(RECORD, JSON.stringify({cli, argv, cwd:process.cwd(), env:process.env}));
  // PS 5.1 routes a quoted prompt through a private context file, not argv.
  const pointer = argv.join(' ').match(/First read the private session context file at (.+?)\. It contains/);
  if (pointer) fs.copyFileSync(pointer[1], RECORD + '.context');
} else {
  const rec = JSON.parse(fs.readFileSync(argv[0], 'utf8'));
  delete rec.env.FAKE_READINESS;
  const sid = rec.env.MOE_SESSION_ID || '\u0000';
  const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const mask = s => s.split(sid).join('<session>')
    .replace(new RegExp(esc(argv[1]) + '[\\\\/][^\\\\/\\s"\x27]+', 'g'), argv[1] + '\\<tmp>')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<uuid>');
  const walk = v => typeof v === 'string' ? mask(v) : Array.isArray(v) ? v.map(walk)
    : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, walk(v[k])])) : v;
  process.stdout.write(JSON.stringify(walk(rec), null, 1));
}
'@
    [IO.File]::WriteAllText($recorder, ('const RECORD = ' + (ConvertTo-Json $rec) + ";`n" + $body))
    foreach ($cli in @('claude', 'codex', 'gemini', 'grok')) {
        Set-Content -LiteralPath (Join-Path $tempRoot "$cli.cmd") -Encoding ASCII -Value "@echo off`r`nnode `"$recorder`" $cli %*`r`nexit /b %errorlevel%"
    }
    $bytes = [IO.File]::ReadAllBytes($wrapper)
    if ($bytes[0] -ne 239 -or $bytes[1] -ne 187 -or $bytes[2] -ne 191) { throw 'wrapper lost its UTF-8 BOM' }
    $legacy = '{"profile":"legacy","ready":true,"missingCapabilities":[],"evaluatedAt":"2026-11-01T00:00:00.000Z"}'
    $r = Invoke-VmrRow T-legacy worker claude $legacy '-'; Assert-VmrLaunched $r
    $raw = Get-Content -Raw -LiteralPath $rec | ConvertFrom-Json
    $context = if (Test-Path -LiteralPath "$rec.context") { [IO.File]::ReadAllText("$rec.context") } else { '' }
    if ((-not ($raw.argv -match 'task-postflight') -and -not $context.Contains('task-postflight')) -or $raw.env.MOE_WORKER_ID -cne 'worker-vmr') { Stop-Vmr $r 'record lacks task and worker identity' }
    $baseline = Get-VmrNormalized
    $tRows = @(
        "legacy2|$legacy",
        'observe|{"profile":"observe","ready":false,"missingCapabilities":["x"],"evaluatedAt":"2026-11-01T00:00:00.000Z"}',
        'unreadable|{"profile":"unreadable","ready":false,"missingCapabilities":[],"evaluatedAt":null}',
        'refuse|refuse', 'unknown|unknown', 'fail|fail',
        'malformed-ready|{"profile":"verified-local","ready":"true","missingCapabilities":[]}',
        'malformed-string|"not an object"',
        'malformed-number|{"profile":"verified-local","ready":1,"missingCapabilities":[]}',
        'malformed-missing|{"profile":"verified-local","ready":false,"missingCapabilities":"x"}',
        'malformed-id|{"profile":"verified-local","ready":false,"missingCapabilities":[null]}',
        'Verified-Local|{"profile":"Verified-Local","ready":true,"missingCapabilities":[]}'
    )
    foreach ($t in $tRows) {
        $a = $t -split '\|', 2
        $r = Invoke-VmrRow "T-$($a[0])" worker claude $a[1] '-'; Assert-VmrLaunched $r
        $normalized = Get-VmrNormalized
        if ($normalized -cne $baseline) {
            [IO.File]::WriteAllText((Join-Path $tempRoot 'baseline.json'), $baseline)
            [IO.File]::WriteAllText((Join-Path $tempRoot 'different.json'), $normalized)
            Stop-Vmr $r "CLI launch differs from legacy; records in $tempRoot"
        }
    }
    Write-Host '[vm route] ok today path (legacy x2, observe, unreadable, refuse, unknown, fail, malformed, case trap)'
    $vl = 'this project runs verified-local'
    $vlFalse = '{"profile":"verified-local","ready":false,"missingCapabilities":["isolated-check-vm"],"evaluatedAt":"2026-11-01T00:00:00.000Z"}'
    $vlTrue = '{"profile":"verified-local","ready":true,"missingCapabilities":[],"evaluatedAt":"2026-11-01T00:00:00.000Z"}'
    $shared = "$vl, whose worker and QA seats run only in worktree mode; settings.worktreeMode"
    $notReady = "$vl, which is not ready; missing:"
    # Drift guard: the landed WT-19 resolver defaults on only for a non-blank gate.
    $validators = [IO.File]::ReadAllText((Join-Path $root 'packages\moe-daemon\src\state\validators.ts'))
    foreach ($line in @("if (mode !== undefined) return validateEnumValue(mode, 'worktreeMode', WORKTREE_MODES);", "const WORKTREE_MODES: readonly WorktreeMode[] = ['off', 'on'];", "return typeof gate === 'string' && gate.trim() !== '' ? 'on' : 'off';")) {
        if (-not $validators.Contains($line)) { throw 'resolveWorktreeMode moved; re-mirror the gate' }
    }
    $rows = @(
        "C1|worker|gemini|$vlFalse|off|CLI_UNSUPPORTED|$vl, whose worker and QA seats run only claude or codex; this seat runs gemini; refusing to start this seat.",
        "C2|qa|grok|$vlFalse|off|CLI_UNSUPPORTED|$vl, whose worker and QA seats run only claude or codex; this seat runs grok; refusing to start this seat.",
        "S1|worker|claude|$vlFalse|off|SHARED_MODE_UNSUPPORTED|$shared is 'off'; refusing to start this seat.",
        "S2|worker|claude|$vlFalse|`"ON`"|SHARED_MODE_UNSUPPORTED|$shared is invalid (`"ON`"); refusing to start this seat.",
        "S3|worker|claude|$vlFalse|-|SHARED_MODE_UNSUPPORTED|$shared is unset, which resolves to 'off' while settings.qualityGate is blank; refusing to start this seat.",
        "S4|worker|claude|$vlFalse|gate|NOT_READY|$notReady isolated-check-vm; refusing to start this seat.",
        "S5|worker|claude|$vlFalse|null|SHARED_MODE_UNSUPPORTED|$shared is invalid (null); refusing to start this seat.",
        "S6|worker|claude|$vlFalse|`"<&'`"|SHARED_MODE_UNSUPPORTED|$shared is invalid (`"<&'`"); refusing to start this seat.",
        ('N1|worker|codex|{"profile":"verified-local","ready":false,"missingCapabilities":["revision-bound-local-delivery","isolated-check-vm","authenticated-runner-evidence"],"evaluatedAt":"2026-11-01T00:00:00.000Z"}|on|NOT_READY|' + "$notReady revision-bound-local-delivery, isolated-check-vm, authenticated-runner-evidence; refusing to start this seat."),
        ('N2|worker|claude|{"profile":"verified-local","ready":false,"missingCapabilities":[],"evaluatedAt":"2026-11-01T00:00:00.000Z"}|on|NOT_READY|' + "$notReady (none named); refusing to start this seat."),
        "N3|worker|claude|$vlFalse|on|NOT_READY|$notReady isolated-check-vm; refusing to start this seat.",
        ('N4|worker|claude|{"profile":"verified-local","ready":false,"missingCapabilities":["line\n\t\u00a0end","ok"],"evaluatedAt":"2026-11-01T00:00:00.000Z"}|on|NOT_READY|' + "$notReady line???end, ok; refusing to start this seat."),
        "R1|worker|claude|$vlTrue|on|VM_ROUTE_UNAVAILABLE|$vl and is ready, but this wrapper has no VM route yet and never runs the agent CLI on the host; refusing to start this seat.",
        "R2|qa|codex|$vlTrue|on|VM_ROUTE_UNAVAILABLE|$vl and is ready, but this wrapper has no VM route yet and never runs the agent CLI on the host; refusing to start this seat."
    )
    foreach ($row in $rows) {
        $a = $row -split '\|', 7
        $r = Invoke-VmrRow $a[0] $a[1] $a[2] $a[3] $a[4]
        Assert-VmrRefused $r "MOE_VERIFIED_LOCAL_$($a[5])" $a[6]
    }
    Write-Host '[vm route] ok refusals (C1/C2, S1-S6, N1-N4, R1/R2)'
    foreach ($seat in @('A1|architect', 'G1|governor')) {
        $a = $seat -split '\|'
        $r = Invoke-VmrRow $a[0] $a[1] claude $vlFalse off
        if ($r.Code -ne 0 -or -not $r.Ran -or $r.Text.Contains('MOE_VERIFIED_LOCAL_') -or $r.Tools -contains 'get_execution_readiness') {
            Stop-Vmr $r 'architect/governor path changed or read readiness'
        }
    }
    Write-Host '[vm route] ok architect and governor'
    Write-Host 'PASS postflight-vm-route.ps1'
    $exitCode = 0
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    if ($_.Exception.Message.StartsWith('VM ROUTE FAILED')) { $exitCode = 1 }
} finally {
    if ($env:MOE_POSTFLIGHT_KEEP_TEMP -ne '1') { Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue }
    Get-ChildItem Env: | Where-Object { -not $savedEnv.ContainsKey($_.Name) } | Remove-Item
    foreach ($n in $savedEnv.Keys) { [Environment]::SetEnvironmentVariable($n, $savedEnv[$n]) }
}
exit $exitCode
