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
$script:VmjExtraArgs = @(); $script:VmrLoop = @('-NoLoop', '-PollInterval', '0')
if ($env:MOE_POSTFLIGHT_TIMEOUT_SEC -match '^\d+$') { $wrapperTimeoutSec = [int]$env:MOE_POSTFLIGHT_TIMEOUT_SEC }

# Same timeout/owned-PID cleanup and 5.1 exit-code handling as postflight.ps1.
function Invoke-WrapperProcess([string[]]$WrapperArgs, [string]$OutFile, [int]$TimeoutSec = 0) {
    if ($TimeoutSec -le 0) { $TimeoutSec = $wrapperTimeoutSec }
    $quoted = @('-NoProfile', '-File', ('"' + $wrapper + '"'))
    foreach ($a in $WrapperArgs) {
        if ($a -match '[\s"]') { $quoted += ('"' + ($a -replace '"', '\"') + '"') } else { $quoted += $a }
    }
    if ($WrapperArgs -contains '-AutoClaim:$false') {
        # 5.1 -File cannot bind an explicit false switch; use a literal command.
        $words = @($wrapper) + @($WrapperArgs | Where-Object { $_ -cne '-AutoClaim:$false' })
        $invoke = '& ' + (($words | ForEach-Object { if ($_ -match '^-[A-Za-z]+$') { $_ } else { "'" + $_.Replace("'", "''") + "'" } }) -join ' ') + ' -AutoClaim:$false; exit $LASTEXITCODE'
        $quoted = @('-NoProfile', '-EncodedCommand', [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($invoke)))
    }
    if ($script:VmjInterrupt) {
        [IO.File]::WriteAllText((Join-Path $tempRoot 'signal-args.json'), (ConvertTo-Json $quoted))
        $quoted = @('-NoProfile', '-File', ('"' + (Join-Path $tempRoot 'signal.ps1') + '"'), '-Engine', $psExe, '-Root', ('"' + $tempRoot + '"'))
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
    if ($script:VmrSetup) { & $script:VmrSetup }
    Push-Location $project
    try {
        $command = if ($env:MOE_RUNTIME_PROTECTED -eq '1') { $Cli } else { Join-Path $tempRoot "$Cli.cmd" }
        $code = Invoke-WrapperProcess (@('-Project', $project, '-WorkerId', "$Role-vmr", '-Role', $Role, '-Team', 'Smoke', '-NoStartDaemon', '-Command', $command) + $script:VmrLoop + $script:VmjExtraArgs) $out
    } finally { Pop-Location }
    $tools = @(if (Test-Path -LiteralPath $calls) { Get-Content -LiteralPath $calls | ForEach-Object { ($_ | ConvertFrom-Json).tool } })
    [pscustomobject]@{ Row = $Row; Code = $code; Text = [IO.File]::ReadAllText($out); Tools = $tools; Ran = (Test-Path -LiteralPath $rec) }
}
function Stop-Vmr($R, [string]$Why) { Write-Host $R.Text; throw "VM ROUTE FAILED ($($R.Row)): $Why" }
# Assert-VmrOneReason R REASON: a skipped taskless iteration prints exactly ONE
# MOE_TASKLESS_NO_LAUNCH line, and it names REASON. Contains, not an anchored
# match: the idle, teamless and claim-failed lines are Write-Host -ForegroundColor.
function Assert-VmrOneReason($R, [string]$Reason) {
    $lines = @($R.Text -split '\r?\n' | Where-Object { $_.Contains('MOE_TASKLESS_NO_LAUNCH reason=') })
    if ($lines.Count -ne 1 -or -not $lines[0].Contains("MOE_TASKLESS_NO_LAUNCH reason=$Reason role=")) {
        Stop-Vmr $R "expected exactly one MOE_TASKLESS_NO_LAUNCH reason=$Reason line, saw $($lines.Count)"
    }
}
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

# --- [vm seat] CQ-M07n3: port of af8ca2bb's seat-job rows; shared stub only. ---
function Initialize-VmjFixture {
    New-Item -ItemType Directory -Force -Path "$tempRoot\accounts\claude-vm-tokens", "$tempRoot\accounts\acct-1" | Out-Null
    [IO.File]::WriteAllText("$tempRoot\accounts\claude-vm-tokens\acct-1.token", $vmjToken)
    [IO.File]::WriteAllText("$project\.gitignore", ".moe/`n.worktrees/`n.mcp.json`n")
    [IO.File]::WriteAllText("$project\seed.txt", "seed`n")
    Invoke-VmcGit $project @('init', '-q', '-b', 'main') | Out-Null
    Invoke-VmcGit $project @('add', '.gitignore', 'seed.txt') | Out-Null
    Invoke-VmcGit $project @('commit', '-qm', 'seed') | Out-Null
    Invoke-VmcGit $project @('checkout', '-qb', 'moe/control') | Out-Null
    $script:VmjBase = Invoke-VmcGit $project @('rev-parse', 'HEAD')
    $p = Get-Content -Raw "$project\.moe\project.json" | ConvertFrom-Json
    $p.settings.autoCommit = $true
    $p.settings | Add-Member -NotePropertyName checkpointPush -NotePropertyValue $false
    $p.settings | Add-Member -NotePropertyName commitBoardState -NotePropertyValue $false
    [IO.File]::WriteAllText("$project\.moe\project.json", ($p | ConvertTo-Json -Depth 8))
    $env:FAKE_CLAIM_WORKSPACE = @{ mode = $script:VmjWorkspace; target = 'main' } | ConvertTo-Json -Compress
    $env:FAKE_CTX_WORKSPACE = $env:FAKE_CLAIM_WORKSPACE # alreadyAssigned resumes recover this from get_context.
    $env:FAKE_CTX_LANDING = @{ lastCompletion = @{ sha = $script:VmjBase } } | ConvertTo-Json -Compress
}
function Assert-VmjRows($R, [string]$Mode) {
    $raw = if (Test-Path "$project\.moe\evidence-rpcs.jsonl") { [IO.File]::ReadAllText("$project\.moe\evidence-rpcs.jsonl") } else { '' }
    $rows = @($raw -split "`n" | Where-Object { $_.Trim() } | ForEach-Object { $_ | ConvertFrom-Json })
    $seats = @($rows | Where-Object { $_.tool -ceq 'agent-seat' }); $claims = @($rows | Where-Object { $_.tool -ceq 'claim_next_task' })
    if ($R.Ran -or $raw.Contains($vmjToken) -or $R.Text.Contains($vmjToken)) { Stop-Vmr $R 'host CLI ran or token escaped stdin' }
    $expected = if ($Mode -eq 'none') { '' } elseif ($Mode -in @('shared', 'taskless')) { 'seat-start,seat-stop' } else { 'seat-start,seat-job,seat-stop' }
    if (($seats.args.cmd -join ',') -cne $expected) { Stop-Vmr $R ('seat order: ' + ($seats.args.cmd -join ',')) }
    foreach ($s in $seats) { foreach ($n in $vmjCredentials) {
        if ($s.args.env.PSObject.Properties.Name -ccontains $n) { Stop-Vmr $R "credential environment leaked: $n" }
    } }
    if ($Mode -eq 'none') { if ($claims.Count) { Stop-Vmr $R 'claimed before refusal' }; return }
    if (-not $claims.Count -or @($claims | Where-Object { $_.args.executionRoute -cne 'vm' }).Count) { Stop-Vmr $R 'unmarked claim' }
    $deregister = @($rows | Where-Object { $_.tool -ceq 'deregister_worker' })
    if ([Array]::IndexOf($rows, $seats[0]) -ge [Array]::IndexOf($rows, $claims[0]) -or -not $deregister.Count -or
        [Array]::IndexOf($rows, $seats[-1]) -ge [Array]::IndexOf($rows, $deregister[0])) { Stop-Vmr $R 'start/claim/stop/deregister order' }
    $job = $seats | Where-Object { $_.args.cmd -ceq 'seat-job' }
    if (-not $job) { return }
    $role = if ($Mode -eq 'qa') { 'qa' } else { 'worker' }
    $checkout = if ($role -eq 'qa') { $project } else { (Join-Path $project '.worktrees\task-postflight').Replace('\', '/') }
    $id = $claims[0].args
    $argv = @('seat-job', '--project', $project, '--worker', "$role-vmr", '--runner', $id.processStartedAt, '--host', $id.host,
        '--instance', $seats[0].args.instance, '--role', $role, '--task', 'task-postflight', '--attempt', 'attempt-postflight', '--generation', '7',
        '--checkout', $checkout, '--commit', $script:VmjBase, '--cli', 'claude')
    if (($job.args.argv -join "`0") -cne ($argv -join "`0") -or -not $R.Text.Contains("Runner identity: processStartedAt=$($id.processStartedAt) host=$($id.host)")) { Stop-Vmr $R 'job argv/runner identity mismatch' }
    if ($job.args.stdinName -cne 'CLAUDE_CODE_OAUTH_TOKEN' -or $job.args.stdinSha256 -cne $vmjHash) { Stop-Vmr $R 'stdin token mismatch' }
    if ($role -eq 'worker' -and $job.args.clean -ne $true) { Stop-Vmr $R 'host tooling dirtied W' }
    if ($Mode -in @('happy', 'nonzero')) {
        $tip = Invoke-VmcGit $project @('rev-parse', 'moe/task/task-postflight')
        if ((Invoke-VmcGit $project @('rev-parse', "$tip^")) -cne $script:VmjBase -or
            (Invoke-VmcGit $project @('rev-parse', "$tip^{tree}")) -cne $job.args.tree) { Stop-Vmr $R 'candidate tree/parent mismatch' }
        $exit = if ($Mode -eq 'nonzero') { 17 } else { 0 }
        if (-not (Invoke-VmcGit $project @('log', '-1', '--format=%B', $tip)).Contains("cli-exit=$exit") -or
            @($rows | Where-Object { $_.tool -ceq 'record_commit' -and $_.args.outcome -ceq 'committed' }).Count -ne 1 -or
            -not $R.Text.Contains('guest stdout') -or -not $R.Text.Contains('guest stderr') -or
            ([regex]::Matches($R.Text, 'MOE_VM_CANDIDATE_COMMITTED')).Count -ne 1 -or $R.Text.Contains('Committed checkpoint')) { Stop-Vmr $R 'candidate/relay evidence mismatch' }
    } elseif ($Mode -eq 'qa' -and (Invoke-VmcGit $project @('rev-parse', '--verify', 'moe/task/task-postflight') -NoThrow)) { Stop-Vmr $R 'QA landed a commit' }
}
function Test-VmjOutcome {
    $ast = [Management.Automation.Language.Parser]::ParseFile($wrapper, [ref]$null, [ref]$null)
    foreach ($fn in $ast.FindAll({ param($a) $a -is [Management.Automation.Language.FunctionDefinitionAst] -and $a.Name -cin @('Get-MoeSeatJobOutcome', 'ConvertFrom-MoeSeatReply') }, $true)) { . ([scriptblock]::Create($fn.Extent.Text)) }
    $Role = 'worker'; $commit = 'a' * 40
    $good = @{ seatJob = 1; ok = $true; role = $Role; commit = $commit; baseTree = ('b' * 40); tree = ('c' * 40); exitCode = 0 }
    foreach ($line in @('[]', 'null', ('[' + ($good | ConvertTo-Json -Compress) + ']'), 'not JSON')) {
        if (Get-MoeSeatJobOutcome $line $commit) { throw 'VM ROUTE FAILED (outcome): non-object accepted' }
    }
    foreach ($patch in @(@{}, @{seatJob=$true}, @{seatJob=0}, @{ok='true'}, @{role=@('worker')}, @{commit=@($commit)}, @{tree='bad'})) {
        $o = $good.Clone(); foreach ($n in $patch.Keys) { $o[$n] = $patch[$n] }
        $got = Get-MoeSeatJobOutcome ($o | ConvertTo-Json -Compress) $commit
        if ([bool]$got -ne ($patch.Count -eq 0)) { throw 'VM ROUTE FAILED (outcome): marker/types mismatch' }
    }
    foreach ($exit in @($null, -1, 256, $true, 1.5)) {
        $o = $good.Clone(); $o.exitCode = $exit
        if ((Get-MoeSeatJobOutcome ($o | ConvertTo-Json -Compress) $commit).exitCode -ne 1) { throw 'VM ROUTE FAILED (outcome): bad exit not clamped' }
    }
    $o = $good.Clone(); $o.Remove('exitCode')
    if ((Get-MoeSeatJobOutcome ($o | ConvertTo-Json -Compress) $commit).exitCode -ne 1) { throw 'VM ROUTE FAILED (outcome): missing exit not clamped' }
}
function Test-VmjEnvironment {
    $ast = [Management.Automation.Language.Parser]::ParseFile($wrapper, [ref]$null, [ref]$null)
    foreach ($fn in $ast.FindAll({ param($a) $a -is [Management.Automation.Language.FunctionDefinitionAst] -and
        $a.Name -cin @('Invoke-MoeSeatCli', 'ConvertTo-MoeArgumentLine', 'Stop-MoeSeatVm', 'Get-MoeSeatResultCode', 'ConvertFrom-MoeSeatReply') }, $true)) { . ([scriptblock]::Create($fn.Extent.Text)) }
    $script:AgentSeatCli = $env:MOE_AGENT_SEAT_PATH; $projectPath = $project; $WorkerId = 'worker-vmr'
    $script:MoeProcessStartedAt = '123@runner token with spaces'; $script:MoeHost = 'host'
    $script:SeatVmInstance = 'moe-vm-00000000000000000001'
    Invoke-MoeSeatCli -SeatArgs @('seat-stop', '--project', $project) | Out-Null
    foreach ($n in $vmjCredentials) { if ([Environment]::GetEnvironmentVariable($n) -cne "outer-$n") { throw "VM ROUTE FAILED (env): $n not restored" } }
    $before = @(Get-Content "$project\.moe\evidence-rpcs.jsonl").Count
    Stop-MoeSeatVm; Stop-MoeSeatVm
    $rows = @(Get-Content "$project\.moe\evidence-rpcs.jsonl")
    $last = $rows[-1] | ConvertFrom-Json
    if ($rows.Count -ne $before + 1 -or $last.args.argv[6] -cne $script:MoeProcessStartedAt -or $script:SeatVmInstance) { throw 'VM ROUTE FAILED (stop): idempotence/runner argv' }
    foreach ($n in $vmjCredentials) { if ($last.args.env.PSObject.Properties.Name -ccontains $n -or [Environment]::GetEnvironmentVariable($n) -cne "outer-$n") { throw "VM ROUTE FAILED (env): background $n" } }
    Remove-Item Env:\OPENAI_API_KEY
    $threw = $false; $node = $script:MoeNode; $script:MoeNode = "$tempRoot\no-such-node.exe"
    try { Invoke-MoeSeatCli -BackgroundOut "$tempRoot\absent-node.out" -SeatArgs @('seat-stop', '--project', $project) | Out-Null } catch { $threw = $true } finally { $script:MoeNode = $node }
    if (-not $threw -or (Test-Path Env:\OPENAI_API_KEY)) { throw 'VM ROUTE FAILED (env): absent variable/error restoration' }
    $env:OPENAI_API_KEY = 'outer-OPENAI_API_KEY'
    foreach ($n in $vmjCredentials) { if ([Environment]::GetEnvironmentVariable($n) -cne "outer-$n") { throw "VM ROUTE FAILED (env): error $n" } }
    # Both native-pipe encoders and a caller's shadowed preference may include BOMs.
    $encoding = $global:OutputEncoding; $inputEncoding = [Console]::InputEncoding; $cli = $script:AgentSeatCli
    try {
        $script:AgentSeatCli = Join-Path $tempRoot 'stdin.cjs'
        [IO.File]::WriteAllText($script:AgentSeatCli, 'let s="";process.stdin.setEncoding("utf8");process.stdin.on("data",c=>s+=c).on("end",()=>{try{if(JSON.parse(s).value!=="\u00e9")throw Error();console.log("stdin-ok")}catch{process.exitCode=1}});')
        foreach ($ambient in @([Text.ASCIIEncoding]::new(), [Text.UTF8Encoding]::new($true))) {
            $global:OutputEncoding = $ambient; $OutputEncoding = $ambient; [Console]::InputEncoding = $ambient
            $reply = @(Invoke-MoeSeatCli -InputText ('{"value":"' + [char]0xe9 + '"}') -SeatArgs @())
            if ($script:SeatCliExit -ne 0 -or ($reply -join '') -cne 'stdin-ok' -or
                -not [object]::ReferenceEquals($global:OutputEncoding, $ambient) -or
                -not [Console]::InputEncoding.Equals($ambient)) { throw 'VM ROUTE FAILED (stdin): BOM/Unicode or encoding not restored' }
        }
    } finally { $global:OutputEncoding = $encoding; [Console]::InputEncoding = $inputEncoding; $script:AgentSeatCli = $cli }
}
# --- [seat errors|credentials|failures|waits|reload] CQ-M07n: twins of CQ-M07m's
# VE-* rows, plus the ps1-only reload stop. Runs in Invoke-VmjSections' scope
# ($ready, $vmjToken, $vmjHash, $vmjCredentials); its finally restores the env.
function Read-VmeJsonl([string]$Path) { @(if (Test-Path -LiteralPath $Path) { Get-Content -LiteralPath $Path | Where-Object { $_.Trim() } | ForEach-Object { $_ | ConvertFrom-Json } }) }
function Get-VmeCount($Rows, [string]$Tool, [string]$Text = '') { @($Rows | Where-Object { $_.tool -ceq $Tool -and (-not $Text -or "$($_.args.content)".Contains($Text)) }).Count }
# Ctrl+C (signal.ps1) once COUNT seat CMD rows exist and the output holds TEXT.
function Invoke-VmeSignalRow([string]$Row, [string]$Cmd, [int]$Count, [string]$Text) {
    [IO.File]::WriteAllText("$tempRoot\signal-until.json", (@{ cmd = $Cmd; count = $Count; text = $Text } | ConvertTo-Json -Compress))
    $script:VmjInterrupt = $true
    try { $r = Invoke-VmrRow $Row worker claude $ready on } finally { $script:VmjInterrupt = $false }
    if ($r.Code -notin @(0, 130) -or $r.Ran) { Stop-Vmr $r "interrupt exit $($r.Code), CLI ran=$($r.Ran)" }
    return $r
}
# A background poller that writes the token once FILE holds N MOE_VM_CREDENTIAL_UNAVAILABLE lines.
function Start-VmeTokenRestore([int]$N) {
    Remove-Item -LiteralPath $out -ErrorAction SilentlyContinue
    Start-Job -ArgumentList $out, "$tempRoot\accounts\claude-vm-tokens\acct-1.token", $vmjToken, $N -ScriptBlock {
        param($o, $f, $t, $n)
        for ($i = 0; $i -lt 3000; $i++) {
            $text = ''; try { $s = [IO.File]::Open($o, 'Open', 'Read', 'ReadWrite'); try { $text = (New-Object IO.StreamReader($s)).ReadToEnd() } finally { $s.Dispose() } } catch {}
            if ([regex]::Matches($text, 'MOE_VM_CREDENTIAL_UNAVAILABLE').Count -ge $n) { [IO.File]::WriteAllText($f, $t); return }
            Start-Sleep -Milliseconds 100
        }
    }
}
function Invoke-VmeRows {
    $noToken = { Initialize-VmjFixture; Remove-Item "$tempRoot\accounts\claude-vm-tokens\acct-1.token" }
    $script:VmrLoop = @('-NoLoop', '-PollInterval', '1')
    foreach ($c in @('capacity|[{"exit":75,"code":"SEAT_CAPACITY_FULL"},{"exit":75,"code":"SEAT_CAPACITY_LOCK_BUSY"}]|', 'failure|[{"exit":1,"code":"SEAT_PROVISION_FAILED"}]|SEAT_PROVISION_FAILED',
        'usage|[{"exit":2,"code":"SEAT_USAGE"}]|SEAT_USAGE', 'unreadable|[{"exit":1,"code":"never echo arbitrary text"}]|exit 1')) {
        $a = $c -split '\|'; $env:FAKE_SEAT_STARTS = $a[1]
        $r = Invoke-VmrRow "VE-$($a[0])" worker claude $ready on
        $rows = Read-VmeJsonl "$project\.moe\evidence-rpcs.jsonl"; $s = @($rows | Where-Object { $_.tool -ceq 'agent-seat' })
        $claim = @($rows | Where-Object { $_.tool -ceq 'claim_next_task' }); $cmds = $s.args.cmd -join ','
        if ($r.Ran -or $r.Text.Contains('never echo')) { Stop-Vmr $r 'host CLI ran or child text echoed' }
        if ($a[0] -eq 'capacity') {
            if ($r.Code -ne 0 -or $cmds -cne 'seat-start,seat-start,seat-start,seat-job,seat-stop' -or [Array]::IndexOf($rows, $claim[0]) -lt [Array]::IndexOf($rows, $s[2]) -or
                -not $r.Text.Contains('[seat] MOE_SEAT_CAPACITY_WAIT: SEAT_CAPACITY_FULL; no task is claimed; retrying in 1s (Ctrl+C to stop)') -or
                -not $r.Text.Contains('MOE_SEAT_CAPACITY_WAIT: SEAT_CAPACITY_LOCK_BUSY')) { Stop-Vmr $r "capacity wait: $cmds" }
        } elseif ($r.Code -ne 1 -or $cmds -cne 'seat-start' -or $claim.Count -or -not $r.Text.Contains("[ERROR] MOE_SEAT_START_FAILED: $($a[2])")) { Stop-Vmr $r "start failure: $cmds" }
    }
    Remove-Item Env:\FAKE_SEAT_STARTS; $script:VmrLoop = @('-NoLoop', '-PollInterval', '0')
    Write-Host '[seat errors] ok capacity, failure, usage, unreadable'
    foreach ($key in @('OPENAI_API_KEY', 'CODEX_API_KEY')) {
        Remove-Item Env:\OPENAI_API_KEY, Env:\CODEX_API_KEY -ErrorAction SilentlyContinue; Set-Item "Env:\$key" $vmjToken
        $r = Invoke-VmrRow "VE-$key" worker codex $ready on
        $raw = [IO.File]::ReadAllText("$project\.moe\evidence-rpcs.jsonl"); $s = @(Read-VmeJsonl "$project\.moe\evidence-rpcs.jsonl" | Where-Object { $_.tool -ceq 'agent-seat' })
        $leaked = @($s | Where-Object { $e = $_.args.env.PSObject.Properties.Name; @($vmjCredentials | Where-Object { $e -ccontains $_ }).Count })
        if ($r.Code -ne 0 -or $r.Ran -or $raw.Contains($vmjToken) -or $r.Text.Contains($vmjToken) -or ($s.args.cmd -join ',') -cne 'seat-start,seat-job,seat-stop' -or $leaked.Count -or
            $s[1].args.stdinName -cne $key -or $s[1].args.stdinSha256 -cne $vmjHash -or $s[1].args.argv[-1] -cne 'codex') { Stop-Vmr $r "codex $key pipe" }
    }
    Remove-Item Env:\OPENAI_API_KEY, Env:\CODEX_API_KEY -ErrorAction SilentlyContinue
    $r = Invoke-VmrRow VE-no-key worker codex $ready on; Assert-VmjRows $r none
    if ($r.Code -ne 1 -or (Get-VmeCount (Read-VmeJsonl $calls) chat_send) -ne 1 -or
        -not $r.Text.Contains("[ERROR] MOE_VM_CREDENTIAL_UNAVAILABLE: codex needs OPENAI_API_KEY or CODEX_API_KEY in the wrapper's environment")) { Stop-Vmr $r 'codex no-key refusal' }
    $env:OPENAI_API_KEY = 'outer-OPENAI_API_KEY'; $env:CODEX_API_KEY = 'outer-CODEX_API_KEY'
    $script:VmrSetup = $noToken; $env:MOE_ACCOUNT_RETRY_SEC = '1'; $job = Start-VmeTokenRestore 2
    try { $r = Invoke-VmrRow VE-missing worker claude $ready on } finally { Stop-Job $job; Remove-Job $job -Force; $script:VmrSetup = { Initialize-VmjFixture } }
    if ($r.Code -ne 0) { Stop-Vmr $r "exit $($r.Code)" }; Assert-VmjRows $r happy; $c = Read-VmeJsonl $calls
    if ((Get-VmeCount $c chat_send 'MOE_VM_CREDENTIAL_UNAVAILABLE') -ne 1 -or (Get-VmeCount $c claim_next_task) -ne 1 -or (Get-VmeCount $c lease_account) -lt 3 -or
        [regex]::Matches($r.Text, [regex]::Escape('[WARN] MOE_VM_CREDENTIAL_UNAVAILABLE account=acct-1; retrying in 1s (Ctrl+C to stop)')).Count -lt 2) { Stop-Vmr $r 'missing-token wait' }
    Remove-Item Env:\MOE_ACCOUNT_RETRY_SEC
    Write-Host '[seat credentials] ok OPENAI_API_KEY and CODEX_API_KEY canaries, no-key, missing token'
    $script:VmrLoop = @('-Loop', '-PollInterval', '1'); $env:MOE_LAUNCH_BACKOFF_BASE_SEC = '1'; $env:MOE_LAUNCH_BACKOFF_MAX_SEC = '1'
    $fail = '{"exit":1,"outcome":{"seatJob":1,"ok":false,"code":"SEAT_JOB_SESSION_FAILED","vm":"kept"}}'
    foreach ($c in @("failed|[$fail]", 'missing|[{"exit":0}]', ('false|[' + $fail.Replace('"exit":1', '"exit":0') + ']'), "stop-failed|[$fail]", 'streak|[{"exit":1},{"exit":1},{"exit":1}]')) {
        $a = $c -split '\|', 2; $n = if ($a[0] -eq 'streak') { 4 } else { 2 }
        $env:FAKE_SEAT_JOBS = $a[1]; $env:FAKE_CLAIM_LIMIT = "$n"; if ($a[0] -eq 'stop-failed') { $env:FAKE_SEAT_STOP_FAIL = '1' }
        try { $r = Invoke-VmeSignalRow "VE-$($a[0])" seat-job $n 'MOE_VM_CANDIDATE_COMMITTED' } finally { Remove-Item Env:\FAKE_SEAT_STOP_FAIL -ErrorAction SilentlyContinue }
        $rows = Read-VmeJsonl "$project\.moe\evidence-rpcs.jsonl"; $s = @($rows | Where-Object { $_.tool -ceq 'agent-seat' }); $c2 = Read-VmeJsonl $calls
        $claims = @($rows | Where-Object { $_.tool -ceq 'claim_next_task' }); $starts = @($s | Where-Object { $_.args.cmd -ceq 'seat-start' })
        $why = if (($s.args.cmd -join ',') -cne ((@('seat-start,seat-job,seat-stop') * $n) -join ',')) { 'seat order: ' + ($s.args.cmd -join ',') }
        elseif (@($starts.args.instance | Sort-Object -Unique).Count -ne $n) { 'instances not fresh' }
        elseif (@(0..($n - 1) | Where-Object { [Array]::IndexOf($rows, $claims[$_]) -lt [Array]::IndexOf($rows, $s[3 * $_]) }).Count) { 'claim before seat-start' }
        elseif ([regex]::Matches($r.Text, 'MOE_SEAT_JOB_FAILED:').Count -ne $n - 1 -or -not $r.Text.Contains('[resume]')) { 'failure/resume lines' }
        elseif (@($rows | Where-Object { $_.tool -ceq 'record_commit' -and $_.args.outcome -ceq 'committed' }).Count -ne 1 -or (Get-VmeCount $c2 release_task)) { 'ledger or release' }
        elseif ($a[0] -eq 'streak' -and (Get-VmeCount $c2 chat_send 'CLI exits within') -ne 1) { 'streak escalation' }
        elseif ($a[0] -eq 'stop-failed' -and -not $r.Text.Contains('[WARN] MOE_SEAT_STOP_FAILED: SEAT_DELETE_FAILED instance=')) { 'stop failure line' }
        elseif ((Invoke-VmcGit $project @('rev-parse', 'moe/task/task-postflight^')) -cne $script:VmjBase) { 'candidate parent' }
        if ($why) { Stop-Vmr $r $why }
    }
    Remove-Item Env:\FAKE_SEAT_JOBS, Env:\FAKE_CLAIM_LIMIT; $script:VmrLoop = @('-NoLoop', '-PollInterval', '0')
    $env:FAKE_SEAT_DIRTY = '1'; $r = Invoke-VmrRow VE-rescue worker claude $ready on; Remove-Item Env:\FAKE_SEAT_DIRTY
    $rows = Read-VmeJsonl "$project\.moe\evidence-rpcs.jsonl"; $job = $rows | Where-Object { $_.tool -ceq 'agent-seat' -and $_.args.cmd -ceq 'seat-job' }
    $ref = Invoke-VmcGit $project @('for-each-ref', '--format=%(refname)', 'refs/moe/rescue/task-postflight/')
    if ($r.Code -ne 1 -or -not $ref -or $ref.Contains("`n") -or (Invoke-VmcGit $project @('rev-parse', "$ref^")) -cne $script:VmjBase -or
        (Invoke-VmcGit $project @('rev-parse', "$ref^{tree}")) -cne $job.args.tree -or (Invoke-VmcGit $project @('rev-parse', 'moe/task/task-postflight')) -cne $script:VmjBase -or
        [IO.File]::ReadAllText("$project\.worktrees\task-postflight\untracked.txt") -cne "preserve me`n" -or
        @($rows | Where-Object { $_.tool -ceq 'record_commit' -and $_.args.kind -ceq 'rescue' }).Count -ne 1) { Stop-Vmr $r 'helper refusal not retained on one rescue ref' }
    Write-Host '[seat failures] ok failed, missing, false, stop-failed, streak, rescue'
    foreach ($c in @('capacity|MOE_SEAT_CAPACITY_WAIT|0/0', 'credential|MOE_VM_CREDENTIAL_UNAVAILABLE|0/1', 'cap|Auto-resume cap reached|2/3')) {
        $a = $c -split '\|'; $script:VmrLoop = @('-Loop', '-PollInterval', '1')
        switch ($a[0]) {
            'capacity' { $env:FAKE_SEAT_STARTS = '[{"exit":75,"code":"SEAT_CAPACITY_LOCK_BUSY"}]'; $script:VmrLoop = @('-Loop', '-PollInterval', '20') }
            'credential' { $script:VmrSetup = $noToken; $env:MOE_ACCOUNT_RETRY_SEC = '20' }
            'cap' { $env:FAKE_SEAT_JOBS = '[{"exit":1},{"exit":1},{"exit":1}]'; $env:MOE_LAUNCH_FAIL_SEC = '0'; $env:MOE_RESUME_MAX_ATTEMPTS = '1' }
        }
        try { $r = Invoke-VmeSignalRow "VE-wait-$($a[0])" seat-start 1 $a[1] } finally {
            Remove-Item Env:\FAKE_SEAT_STARTS, Env:\MOE_ACCOUNT_RETRY_SEC, Env:\FAKE_SEAT_JOBS, Env:\MOE_LAUNCH_FAIL_SEC, Env:\MOE_RESUME_MAX_ATTEMPTS -ErrorAction SilentlyContinue
            $script:VmrSetup = { Initialize-VmjFixture }
        }
        $s = @(Read-VmeJsonl "$project\.moe\evidence-rpcs.jsonl" | Where-Object { $_.tool -ceq 'agent-seat' }); $c2 = Read-VmeJsonl $calls
        $got = "$(@($s | Where-Object { $_.args.cmd -ceq 'seat-job' }).Count)/$(@($s | Where-Object { $_.args.cmd -ceq 'seat-stop' }).Count)"
        if ($got -cne $a[2] -or (Get-VmeCount $c2 release_task) -or ($a[0] -eq 'capacity' -and (Get-VmeCount $c2 claim_next_task)) -or
            ($a[0] -eq 'cap' -and (Get-VmeCount $c2 chat_send 'pausing auto-resume') -ne 1)) { Stop-Vmr $r "Ctrl+C during the $($a[0]) wait: seat-job/seat-stop $got" }
    }
    Write-Host '[seat waits] ok Ctrl+C during capacity and credential waits; resume cap bounded'
    # ps1 only: the in-process hot reload stops the VM before its wrapper_restart deregister.
    $copy = "$tempRoot\reload"; New-Item -ItemType Directory -Force $copy | Out-Null
    Copy-Item -Path "$root\scripts\moe-agent.ps1", "$root\scripts\*.mjs" -Destination $copy
    foreach ($g in @(@('init', '-q'), @('add', '-A'), @('commit', '-qm', 'base'))) { Invoke-VmcGit $copy $g | Out-Null }
    Remove-Item -LiteralPath "$project\.moe\evidence-rpcs.jsonl" -ErrorAction SilentlyContinue
    $job = Start-Job -ArgumentList "$project\.moe\evidence-rpcs.jsonl", $copy -ScriptBlock {
        param($e, $c)
        for ($i = 0; $i -lt 3000 -and -not (Select-String -LiteralPath $e -SimpleMatch '"cmd":"seat-start"' -Quiet -ErrorAction SilentlyContinue); $i++) { Start-Sleep -Milliseconds 100 }
        [IO.File]::AppendAllText("$c\moe-agent.ps1", "# committed reload test`r`n"); & git -C $c commit -qam reload 2>&1 | Out-Null
    }
    # A routed mention on every iteration: the VM route, not the legacy nothing-to-answer rule, stops each one.
    $wrapper = "$copy\moe-agent.ps1"; $env:FAKE_CLAIM_MODE = 'idle'; $env:FAKE_MENTION = '1'; $script:VmrLoop = @('-Loop', '-PollInterval', '1')
    try { $r = Invoke-VmeSignalRow VR-reload seat-start 2 '' } finally { Stop-Job $job; Remove-Job $job -Force; Remove-Item Env:\FAKE_CLAIM_MODE, Env:\FAKE_MENTION -ErrorAction SilentlyContinue }
    $rows = Read-VmeJsonl "$project\.moe\evidence-rpcs.jsonl"; $s = @($rows | Where-Object { $_.tool -ceq 'agent-seat' })
    $dereg = @($rows | Where-Object { $_.tool -ceq 'deregister_worker' })
    $runners = @($s | ForEach-Object { $_.args.argv[[Array]::IndexOf($_.args.argv, '--runner') + 1] } | Sort-Object -Unique)
    if (($s.args.cmd -join ',') -cne 'seat-start,seat-stop,seat-start,seat-stop' -or $dereg.Count -lt 2 -or $dereg[0].args.reason -cne 'wrapper_restart' -or
        [Array]::IndexOf($rows, $s[1]) -gt [Array]::IndexOf($rows, $dereg[0]) -or [Array]::IndexOf($rows, $s[3]) -gt [Array]::IndexOf($rows, $dereg[1]) -or
        $s[0].args.instance -ceq $s[2].args.instance -or $runners.Count -ne 1) { Stop-Vmr $r ('reload: ' + ($s.args.cmd -join ',')) }
    $reasons = @([regex]::Matches($r.Text, 'MOE_TASKLESS_NO_LAUNCH reason=(\S+)') | ForEach-Object { $_.Groups[1].Value })
    if ($reasons.Count -eq 0 -or @($reasons | Where-Object { $_ -cne 'vm-route' }).Count) {
        Stop-Vmr $r ('a taskless iteration printed a reason other than vm-route: ' + ($reasons -join ','))
    }
    Write-Host '[seat reload] ok seat-stop before the wrapper_restart deregister; fresh VM after the reload; taskless mentions print only vm-route'
}
function Invoke-VmjSections {
    $saved = @{}; Get-ChildItem Env: | ForEach-Object { $saved[$_.Name] = $_.Value }
    $vmjCredentials = @('ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'OPENAI_API_KEY', 'CODEX_API_KEY')
    $vmjToken = 'sk-ant-oat01-vmCanaryMustNeverEscapePipes0123456789'
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $vmjHash = ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($vmjToken)))).Replace('-', '').ToLowerInvariant() } finally { $sha.Dispose() }
    $gcfg = Join-Path $tempRoot 'seat.gitconfig'
    [IO.File]::WriteAllText($gcfg, "[user]`n name = vmj`n email = vmj@example.invalid`n[core]`n autocrlf = false`n")
    $ready = '{"profile":"verified-local","ready":true,"missingCapabilities":[]}'
    $script:VmrSetup = { Initialize-VmjFixture }; $script:VmjWorkspace = 'worktree'
    try {
        Test-VmjOutcome
        Copy-Item (Join-Path $root 'scripts\tests\postflight-fake-agent-seat.js') "$tempRoot\seat.cjs"
        $env:MOE_AGENT_SEAT_PATH = "$tempRoot\seat.cjs"; $env:MOE_ACCOUNT_ROTATION = 'on'
        $env:MOE_ACCOUNTS_FILE = "$tempRoot\accounts\claude-accounts.json"; $env:FAKE_ACCOUNT_HOME = "$tempRoot\accounts"
        $env:GIT_CONFIG_GLOBAL = $gcfg; $env:GIT_CONFIG_NOSYSTEM = '1'; $env:PATH = "$tempRoot;$env:PATH"
        foreach ($n in $vmjCredentials) { Set-Item "Env:\$n" "outer-$n" }
        foreach ($mode in @('happy', 'nonzero')) {
            $env:FAKE_SEAT_EXIT_CODE = if ($mode -eq 'nonzero') { '17' } else { '0' }
            $r = Invoke-VmrRow "VR-$mode" worker claude $ready on
            if ($mode -eq 'happy' -and $r.Code -ne 0) { Stop-Vmr $r "exit $($r.Code)" }; Assert-VmjRows $r $mode
            if ($mode -eq 'happy') { Test-VmjEnvironment }
        }
        Remove-Item Env:\FAKE_SEAT_EXIT_CODE, Env:\OPENAI_API_KEY, Env:\CODEX_API_KEY
        $r = Invoke-VmrRow R2 qa codex $ready on; Assert-VmjRows $r none
        if ($r.Code -ne 1 -or -not $r.Text.Contains('MOE_VM_CREDENTIAL_UNAVAILABLE')) { Stop-Vmr $r 'codex not refused' }
        $env:OPENAI_API_KEY = 'outer-OPENAI_API_KEY'; $env:CODEX_API_KEY = 'outer-CODEX_API_KEY'
        $script:VmjExtraArgs = @('-AutoClaim:$false')
        $r = Invoke-VmrRow VR-noclaim worker claude $ready on; Assert-VmjRows $r none
        if ($r.Code -ne 1 -or -not $r.Text.Contains('MOE_VERIFIED_LOCAL_NO_AUTO_CLAIM')) { Stop-Vmr $r 'no-auto-claim not refused' }
        $script:VmjExtraArgs = @()
        $r = Invoke-VmrRow VR-qa-shared qa claude $ready off; Assert-VmjRows $r none
        if ($r.Code -ne 1 -or -not $r.Text.Contains('MOE_VERIFIED_LOCAL_SHARED_MODE_UNSUPPORTED')) { Stop-Vmr $r 'QA settings not refused' }
        $env:MOE_RUNTIME_PROTECTED = '1'; $env:MOE_DAEMON_PATH = "$tempRoot\daemon.cjs"
        [IO.File]::WriteAllText($env:MOE_DAEMON_PATH, '// never invoked')
        $r = Invoke-VmrRow VR-protected worker claude '{"profile":"verified-local","ready":false,"missingCapabilities":[]}' on
        Assert-VmjRows $r none
        if ($r.Code -ne 1 -or ([regex]::Matches($r.Text, 'MOE_VERIFIED_LOCAL_SEAT_PATH_IGNORED')).Count -ne 1 -or $r.Text.Contains($env:MOE_AGENT_SEAT_PATH)) { Stop-Vmr $r 'protected seam not ignored' }
        Remove-Item Env:\MOE_RUNTIME_PROTECTED, Env:\MOE_DAEMON_PATH
        $script:VmjWorkspace = 'shared'
        $r = Invoke-VmrRow VR-shared worker claude $ready on; Assert-VmjRows $r shared
        if ($r.Code -ne 1 -or ([regex]::Matches($r.Text, 'MOE_VERIFIED_LOCAL_SHARED_MODE_UNSUPPORTED')).Count -ne 1) { Stop-Vmr $r 'worker backstop not refused' }
        $env:FAKE_TASK_STATUS = 'REVIEW'
        $r = Invoke-VmrRow VR-qa qa claude $ready on; Assert-VmjRows $r qa
        if ($r.Code -ne 0) { Stop-Vmr $r "exit $($r.Code)" }
        Remove-Item Env:\FAKE_TASK_STATUS; $script:VmjWorkspace = 'worktree'
        # Separate supervisor owns the wrapper's console; signal only that child.
        [IO.File]::WriteAllText("$tempRoot\signal.ps1", @'
param($Engine,$Root)
$ErrorActionPreference='Stop'
$argsList=Get-Content -Raw "$Root\signal-args.json" | ConvertFrom-Json
$log="$Root\signal.log"; $p=Start-Process $Engine -ArgumentList $argsList -WindowStyle Hidden -PassThru -RedirectStandardOutput $log -RedirectStandardError "$log.err"
$null=$p.Handle
try {
    # signal-until.json: Ctrl+C once COUNT seat CMD rows exist and the output holds TEXT.
    $u=if(Test-Path "$Root\signal-until.json"){Get-Content -Raw "$Root\signal-until.json"|ConvertFrom-Json}else{[pscustomobject]@{cmd='seat-job';count=1;text=''}}
    $until=[DateTime]::UtcNow.AddSeconds(300); $ready=$false
    while(-not $ready) {
        $ready=@(Get-Content "$Root\project\.moe\evidence-rpcs.jsonl" -ErrorAction SilentlyContinue | Where-Object { $_ -match ('"cmd":"'+$u.cmd+'"') }).Count -ge $u.count -and
            (-not $u.text -or "$(Get-Content -Raw $log -ErrorAction SilentlyContinue)".Contains($u.text))
        if($p.HasExited -or [DateTime]::UtcNow -gt $until){throw "$($u.cmd) x$($u.count) '$($u.text)' readiness failed"}
        if(-not $ready){Start-Sleep -Milliseconds 100}
    }
    Add-Type 'using System; using System.Runtime.InteropServices; public static class SeatSignal {
      [DllImport("kernel32.dll")] public static extern bool FreeConsole();
      [DllImport("kernel32.dll")] public static extern bool AttachConsole(uint pid);
      [DllImport("kernel32.dll")] public static extern bool SetConsoleCtrlHandler(IntPtr h,bool add);
      [DllImport("kernel32.dll")] public static extern bool GenerateConsoleCtrlEvent(uint code,uint group);
    }'
    [SeatSignal]::FreeConsole()|Out-Null
    if(-not [SeatSignal]::AttachConsole($p.Id)){throw 'AttachConsole failed'}
    [SeatSignal]::SetConsoleCtrlHandler([IntPtr]::Zero,$true)|Out-Null
    if(-not [SeatSignal]::GenerateConsoleCtrlEvent(0,0)){throw 'Ctrl+C failed'}
    if(-not $p.WaitForExit(120000)){throw 'seat cancellation timed out'}
    exit $p.ExitCode
} finally {
    if(-not $p.HasExited){& taskkill /T /F /PID $p.Id|Out-Null; $p.WaitForExit(5000)|Out-Null}
    Get-Content $log; Get-Content "$log.err"
}
'@)
        $env:FAKE_SEAT_JOB_SLEEP = '3'; $script:VmjInterrupt = $true
        $r = Invoke-VmrRow VR-sigint worker claude $ready on; Assert-VmjRows $r sigint
        if ($r.Code -notin @(0, 130)) { Stop-Vmr $r "interrupt exit $($r.Code)" }
        Remove-Item Env:\FAKE_SEAT_JOB_SLEEP; $script:VmjInterrupt = $false
        $env:FAKE_CLAIM_MODE = 'idle'; $env:FAKE_MENTION = '1'
        $r = Invoke-VmrRow VR-taskless worker claude $ready on; Assert-VmjRows $r taskless
        if ($r.Code -ne 0) { Stop-Vmr $r "exit $($r.Code)" }
        Assert-VmrOneReason $r vm-route
        # A seat whose join failed reads no chat, so it has no routed mention: the legacy
        # teamless rule skipped first and its reason stands, once. The startup join and the
        # forced re-join refuse with the same text, so only the post-loop exit line prints
        # MOE_SEAT_UNREGISTERED.
        $env:FAKE_JOIN_FULL = '1'
        $r = Invoke-VmrRow VR-taskless-teamless worker claude $ready on
        if ($r.Code -ne 1 -or [regex]::Matches($r.Text, 'MOE_SEAT_UNREGISTERED').Count -ne 1) { Stop-Vmr $r "exit $($r.Code), expected the one-shot teamless exit 1" }
        Assert-VmrOneReason $r teamless; Assert-VmjRows $r taskless
        Remove-Item Env:\FAKE_JOIN_FULL, Env:\FAKE_MENTION
        $r = Invoke-VmrRow VR-taskless-idle worker claude $ready on
        if ($r.Code -ne 0) { Stop-Vmr $r "exit $($r.Code)" }
        Assert-VmrOneReason $r idle; Assert-VmjRows $r taskless
        Write-Host '[vm seat] PASS happy, nonzero, codex, noclaim, qa-shared, protected, shared, qa, sigint, taskless, taskless-teamless, taskless-idle'
        Remove-Item Env:\FAKE_CLAIM_MODE
        Invoke-VmeRows
    } finally {
        $script:VmrSetup = $null; $script:VmjInterrupt = $false; $script:VmjExtraArgs = @(); $script:VmrLoop = @('-NoLoop', '-PollInterval', '0')
        Remove-Item "$tempRoot\signal-until.json" -ErrorAction SilentlyContinue
        Get-ChildItem Env: | Where-Object { -not $saved.ContainsKey($_.Name) } | Remove-Item
        foreach ($n in $saved.Keys) { Set-Item "Env:\$n" $saved[$n] }
    }
}

# --- [vm candidate] CQ-M07n2: Invoke-MoeVmCandidateLanding turns a VM job's
# admitted tree into ONE checkpoint commit on moe/task/<id>; [strong intent] is
# Test-MoeWorktreeStrongIntent. Twins of postflight-vm-route.sh's two sections,
# rows R1-R9 and G1-G8 one for one (G6d is ps1-only). The wrapper's functions are
# imported through the PowerShell parser (postflight.sh's WT_PS1 approach) into
# Invoke-VmcSections' scope and run in process against a temp repo whose W is a
# real sparse linked worktree; Send-MoeRecordCommit and Send-MoeGeneralChat only
# log. Every row also proves the control checkout's HEAD, index file and status
# and refs/heads/main never move. Git runs on a private global config with the
# system config (autocrlf) off.
function Invoke-VmcGit([string]$Top, [string[]]$A, [string]$Index = '', [switch]$NoThrow) {
    $prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    $enc = [Console]::OutputEncoding; $prevIdx = $env:GIT_INDEX_FILE; $raw = @(); $rc = 255
    try {
        [Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
        if ($Index) { $env:GIT_INDEX_FILE = $Index }
        $raw = & git -C $Top @A 2>$null; $rc = $LASTEXITCODE
    } finally {
        if ($Index) { $env:GIT_INDEX_FILE = $prevIdx }
        [Console]::OutputEncoding = $enc; $ErrorActionPreference = $prev
    }
    if ($rc -ne 0 -and -not $NoThrow) { throw "harness: git $($A -join ' ') exited $rc" }
    return ((@($raw | ForEach-Object { "$_" }) -join "`n").TrimEnd("`n"))
}
function Stop-Vmc([hashtable]$V, [string]$Why) {
    Write-Host (@($V.Out) -join "`n")
    foreach ($x in @($script:vmcLog)) { Write-Host (ConvertTo-VmcJson $x) }
    throw "VM ROUTE FAILED ($($V.Section) $($V.Row)): $Why"
}
function ConvertTo-VmcJson($H) {
    $o = [ordered]@{}; foreach ($k in @($H.Keys | Sort-Object)) { $o[$k] = $H[$k] }
    return (ConvertTo-Json $o -Compress -Depth 4)
}
function Get-VmcControl([hashtable]$V) {
    return (@((Invoke-VmcGit $V.R @('symbolic-ref', '-q', 'HEAD')), (Invoke-VmcGit $V.R @('rev-parse', 'HEAD', 'refs/heads/main')),
        (Get-FileHash -LiteralPath (Join-Path $V.R '.git\index') -Algorithm SHA256).Hash,
        (Invoke-VmcGit $V.R @('--no-optional-locks', 'status', '--porcelain', '-uall', '-z'))) -join "`n")
}
function Get-VmcRefs([hashtable]$V) { return (Invoke-VmcGit $V.R @('for-each-ref', '--format=%(refname) %(objectname)')) }
function Get-VmcOthers([hashtable]$V) {
    return (@((Get-VmcRefs $V) -split "`n" | Where-Object {
        -not $_.StartsWith("refs/heads/$($V.B) ", [StringComparison]::Ordinal) -and -not $_.StartsWith('refs/moe/rescue/', [StringComparison]::Ordinal) }) -join "`n")
}
function Get-VmcWFiles([hashtable]$V) {
    $base = (Resolve-Path -LiteralPath $V.W).ProviderPath.TrimEnd('\') + '\'
    $files = @(Get-ChildItem -LiteralPath $V.W -Recurse -File -Force | Where-Object { $_.FullName -cne ($base + '.git') } | Sort-Object -Property FullName |
        ForEach-Object { $_.FullName.Substring($base.Length) + ' ' + (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash })
    return ((@((Invoke-VmcGit $V.W @('symbolic-ref', '-q', 'HEAD') -NoThrow), (Invoke-VmcGit $V.W @('ls-files', '-s', '-t'))) + $files) -join "`n")
}
function Get-VmcWIndex([hashtable]$V) {
    return (Get-FileHash -LiteralPath (Join-Path (Invoke-VmcGit $V.W @('rev-parse', '--absolute-git-dir')) 'index') -Algorithm SHA256).Hash
}
# New-VmcTree V BASE PATH CONTENT... -- BASE plus each PATH's blob (CONTENT '-'
# deletes it) through a private index, as admission.mjs writeTree builds an
# admitted tree. No stdin: 5.1 pipes ASCII.
function New-VmcTree([hashtable]$V, [string]$Base, [string[]]$Pairs) {
    $idx = Join-Path $V.Dir 'tree.idx'; $blob = Join-Path $V.Dir 'blob.txt'
    Remove-Item -LiteralPath $idx -Force -ErrorAction SilentlyContinue
    Invoke-VmcGit $V.R @('read-tree', $Base) $idx | Out-Null
    for ($i = 0; $i + 1 -lt $Pairs.Count; $i += 2) {
        if ($Pairs[$i + 1] -ceq '-') { Invoke-VmcGit $V.R @('update-index', '--force-remove', '--', $Pairs[$i]) $idx | Out-Null; continue }
        [IO.File]::WriteAllText($blob, $Pairs[$i + 1] + "`n")
        $sha = Invoke-VmcGit $V.R @('hash-object', '-w', '--no-filters', '--', $blob)
        Invoke-VmcGit $V.R @('update-index', '--add', '--cacheinfo', "100644,$sha,$($Pairs[$i])") $idx | Out-Null
    }
    return (Invoke-VmcGit $V.R @('write-tree') $idx)
}
# New-VmcFixture: a control checkout R on main and W on moe/task/<id>, sparse
# '/*' '!/.moe/' like Initialize-MoeWorktree; C/BT the job's base, T base +
# src/a.txt=a2.
function New-VmcFixture([hashtable]$V) {
    Remove-Item -LiteralPath $V.R, $V.SeamRan -Recurse -Force -ErrorAction SilentlyContinue
    foreach ($d in @('src', 'lib', '.moe\tasks')) { New-Item -ItemType Directory -Force -Path (Join-Path $V.R $d) | Out-Null }
    [IO.File]::WriteAllText((Join-Path $V.R 'src\a.txt'), "a`n"); [IO.File]::WriteAllText((Join-Path $V.R 'lib\keep.txt'), "keep`n")
    [IO.File]::WriteAllText((Join-Path $V.R ".moe\tasks\$($V.Tid).json"), "{}`n"); [IO.File]::WriteAllText((Join-Path $V.R '.gitignore'), ".worktrees/`n")
    Invoke-VmcGit $V.R @('init', '-q', '-b', 'main') | Out-Null
    Invoke-VmcGit $V.R @('add', '-A') | Out-Null; Invoke-VmcGit $V.R @('commit', '-qm', 'base') | Out-Null
    $V.W = Join-Path $V.R ".worktrees\$($V.Tid)"
    Invoke-VmcGit $V.R @('worktree', 'add', '-q', '--no-checkout', '-b', $V.B, $V.W, 'main') | Out-Null
    Invoke-VmcGit $V.W @('sparse-checkout', 'set', '--no-cone', '/*', '!/.moe/') | Out-Null
    Invoke-VmcGit $V.W @('read-tree', '-mu', 'HEAD') | Out-Null
    $V.C = Invoke-VmcGit $V.R @('rev-parse', 'main'); $V.BT = Invoke-VmcGit $V.R @('rev-parse', 'main^{tree}')
    $V.T = New-VmcTree $V $V.BT @('src/a.txt', 'a2')
}
# Invoke-VmcRow V ROW [SET] -- the function as W's worker seat on C BT T (SET
# overrides Mode, Path, Branch, C, BT, T, Protected, Hook); the control checkout
# and main must be byte-identical afterwards, and exactly one result returned.
function Invoke-VmcRow([hashtable]$V, [string]$Row, [hashtable]$Set = @{}) {
    $V.Row = $Row; $ctl = Get-VmcControl $V
    $V.Refs0 = Get-VmcRefs $V; $V.Others0 = Get-VmcOthers $V; $V.W0 = Get-VmcWFiles $V; $V.I0 = Get-VmcWIndex $V
    $a = @{ Mode = 'worktree'; Path = $V.W; Branch = $V.B; C = $V.C; BT = $V.BT; T = $V.T; Protected = $false; Hook = $null }
    foreach ($k in @($Set.Keys)) { $a[$k] = $Set[$k] }
    $script:vmcLog.Clear(); $script:vmcChat.Clear()
    $script:MoeWtMode = $a.Mode; $script:MoeWtPath = $a.Path; $script:MoeWtBranch = $a.Branch; $script:MoeRuntimeProtected = $a.Protected
    $m = @{ TaskId = $V.Tid; Title = 'vm candidate'; Status = 'WORKING'; ReopenCount = 0; CliExit = 0; Sid = $V.Sid }
    $env:MOE_POSTFLIGHT_TEST_HOOK_PRE_UPDATE_REF = $a.Hook
    try { $items = @(Invoke-MoeVmCandidateLanding $a.C $a.BT $a.T $m 6>&1) }
    finally { $env:MOE_POSTFLIGHT_TEST_HOOK_PRE_UPDATE_REF = $null }
    $V.Out = @($items | Where-Object { $_ -isnot [hashtable] } | ForEach-Object { "$_" })
    $res = @($items | Where-Object { $_ -is [hashtable] })
    if ($res.Count -ne 1 -or $V.Out.Count + 1 -ne $items.Count) { Stop-Vmc $V "the function returned $($res.Count) results and $($items.Count) items" }
    $V.Res = $res[0]
    if ((Get-VmcControl $V) -cne $ctl) { Stop-Vmc $V "the control checkout's HEAD, index, status or refs/heads/main moved" }
}
function Assert-VmcUntouched([hashtable]$V) {
    if ((Get-VmcRefs $V) -cne $V.Refs0) { Stop-Vmc $V 'a ref moved' }
    if ((Get-VmcWFiles $V) -cne $V.W0 -or (Get-VmcWIndex $V) -cne $V.I0) { Stop-Vmc $V "W's HEAD, index file, entries or files changed" }
    if ($script:vmcLog.Count -or $script:vmcChat.Count) { Stop-Vmc $V 'a ledger row or rpc was sent' }
}
# Assert-VmcCommitted V N PATHS: Rc 0, the branch at ONE new commit (parent C,
# tree T) that W's index and files match, one committed checkpoint row, no rescue.
function Assert-VmcCommitted([hashtable]$V, [int]$N, [string[]]$Paths) {
    $ref = "refs/heads/$($V.B)"; $new = Invoke-VmcGit $V.R @('rev-parse', $ref); $V.New = $new; $r = $V.Res
    if ($r.Rc -ne 0 -or $r.Outcome -cne 'committed' -or $r.Code -cne '' -or $r.Sha -cne $new -or $r.Ref -cne $ref -or $r.PathCount -ne $N -or $r.RescueRef) {
        Stop-Vmc $V "result $(ConvertTo-VmcJson $r), expected committed $new"
    }
    if ((Invoke-VmcGit $V.R @('rev-list', '--parents', '-n', '1', $new)) -cne "$new $($V.C)" -or (Invoke-VmcGit $V.R @('rev-parse', "$new^{tree}")) -cne $V.T) {
        Stop-Vmc $V "$($V.B) is not one commit with parent C and tree T"
    }
    if ((Invoke-VmcGit $V.W @('--no-optional-locks', 'status', '--porcelain', '-uall')) -or (Test-Path -LiteralPath (Join-Path $V.W '.moe'))) {
        Stop-Vmc $V 'W does not match the new commit, or holds .moe'
    }
    $want = @{ taskId = $V.Tid; outcome = 'committed'; kind = 'checkpoint'; role = 'worker'; sessionId = $V.Sid; workerId = 'worker-vmc'; sha = $new
        ref = $ref; status = 'WORKING'; treeId = $V.T; pushed = $false; cliExitCode = 0; paths = $Paths; inferredPaths = @() }
    if ($script:vmcLog.Count -ne 1 -or (ConvertTo-VmcJson $script:vmcLog[0]) -cne (ConvertTo-VmcJson $want) -or $script:vmcChat.Count) { Stop-Vmc $V 'not one committed checkpoint row' }
    if (@($V.Out | Where-Object { $_ -ceq "[OK] MOE_VM_CANDIDATE_COMMITTED task=$($V.Tid) sha=$new paths=$N branch=$($V.B)" }).Count -ne 1) { Stop-Vmc $V 'no COMMITTED line' }
    if ((Invoke-VmcGit $V.R @('for-each-ref', 'refs/moe/rescue')) -or (Get-VmcOthers $V) -cne $V.Others0) { Stop-Vmc $V 'another ref moved' }
}
# Assert-VmcParked V CODE REASON: Rc 2 with CODE, the commit (parent C, tree T) on
# exactly one rescue ref and in the only ledger row, W's entries and files as before.
function Assert-VmcParked([hashtable]$V, [string]$Code, [string]$Reason) {
    $rs = @((Invoke-VmcGit $V.R @('for-each-ref', '--format=%(refname)', "refs/moe/rescue/$($V.Tid)/")) -split "`n" | Where-Object { $_ })
    if ($rs.Count -ne 1) { Stop-Vmc $V "not one rescue ref: $($rs -join ' ')" }
    $new = Invoke-VmcGit $V.R @('rev-parse', $rs[0]); $r = $V.Res
    if ($r.Rc -ne 2 -or $r.Outcome -cne 'failed' -or $r.Code -cne "MOE_VM_CANDIDATE_$Code" -or $r.RescueRef -cne $rs[0] -or $r.RescueSha -cne $new -or $r.Sha) {
        Stop-Vmc $V "result $(ConvertTo-VmcJson $r), expected 2 with $Code"
    }
    $warn = @($V.Out | Where-Object { $_.StartsWith("[WARN] MOE_VM_CANDIDATE_${Code}: task $($V.Tid) -- ", [StringComparison]::Ordinal) })
    if ($warn.Count -ne 1 -or -not $warn[0].EndsWith("; the admitted commit $new is kept on $($rs[0]).", [StringComparison]::Ordinal)) { Stop-Vmc $V "no $Code line naming the rescue ref" }
    if ((Invoke-VmcGit $V.R @('rev-list', '--parents', '-n', '1', $new)) -cne "$new $($V.C)" -or (Invoke-VmcGit $V.R @('rev-parse', "$new^{tree}")) -cne $V.T) {
        Stop-Vmc $V 'the rescue ref is not the admitted commit'
    }
    if ((Get-VmcWFiles $V) -cne $V.W0) { Stop-Vmc $V "W's entries or files are not as before" }
    $l = $script:vmcLog
    if ($l.Count -ne 1 -or $l[0].outcome -cne 'committed' -or $l[0].kind -cne 'rescue' -or $l[0].sha -cne $new -or $l[0].ref -cne $rs[0] -or
        $l[0].code -cne $Reason -or (@($l[0].paths) -join '|') -cne 'src/a.txt' -or $script:vmcChat.Count -ne 1 -or
        $script:vmcChat[0] -cne "MOE_RESCUE_REF task=$($V.Tid) ref=$($rs[0]) sha=$new reason=$Reason") { Stop-Vmc $V 'the only row is not the rescue row' }
    if ((Get-VmcOthers $V) -cne $V.Others0) { Stop-Vmc $V 'another ref moved' }
}
function Invoke-VmcRows([hashtable]$V) {
    $V.Section = 'vm candidate'
    Write-Host '[vm candidate] R1: one changed file becomes one checkpoint commit, hooks never run'
    New-VmcFixture $V; Invoke-VmcGit $V.R @('config', 'core.hooksPath', $V.Hooks) | Out-Null
    Invoke-VmcRow $V R1
    Assert-VmcCommitted $V 1 @('src/a.txt')
    if ([IO.File]::ReadAllText((Join-Path $V.W 'src\a.txt')) -cne "a2`n") { Stop-Vmc $V "W's file does not hold the admitted bytes" }
    $msg = "wip($($V.Tid)): vm candidate [status=WORKING role=worker cli-exit=0]`n`nCheckpoint via Moe worker session; not a completion.`n`n" +
        "Moe-Task: $($V.Tid)`nMoe-Kind: checkpoint`nMoe-Session: $($V.Sid)`nMoe-Status: WORKING`nMoe-Paths: 1`nMoe-Inferred: 0"
    if ((Invoke-VmcGit $V.R @('log', '-1', '--format=%B', $V.New)) -cne $msg) { Stop-Vmc $V "the message is not WT-07's checkpoint message" }
    Write-Host '[vm candidate] R1u: a deletion and a new path with a space and Unicode'
    $nw = 'lib/n ' + [char]0xE9 + ' w.txt'
    New-VmcFixture $V; $V.T = New-VmcTree $V $V.BT @($nw, 'new', 'lib/keep.txt', '-')
    Invoke-VmcRow $V R1u
    Assert-VmcCommitted $V 2 @('lib/keep.txt', $nw)
    if ([IO.File]::ReadAllText((Join-Path $V.W $nw)) -cne "new`n" -or (Test-Path -LiteralPath (Join-Path $V.W 'lib\keep.txt'))) { Stop-Vmc $V 'W does not hold the admitted change' }
    Write-Host '[vm candidate] R2-R5: refusals write nothing'
    foreach ($r in @('R2a:NOT_WORKTREE', 'R2b:NOT_WORKTREE', 'R2c:NOT_WORKTREE', 'R3a:HEAD_MOVED', 'R3b:BASE_MISMATCH', 'R4a:DIRTY', 'R4b:DIRTY', 'R5a:TREE_INVALID', 'R5b:TREE_INVALID')) {
        $row, $code = $r -split ':'
        New-VmcFixture $V; $set = @{}
        switch -CaseSensitive ($row) {
            'R2a' { $set = @{ Mode = 'shared'; Path = '' } }
            'R2b' { $set = @{ Path = $V.R } }
            'R2c' { $set = @{ Branch = 'moe/task/task-other' } }
            'R3a' { Invoke-VmcGit $V.W @('update-ref', "refs/heads/$($V.B)", (Invoke-VmcGit $V.W @('commit-tree', $V.BT, '-p', $V.C, '-m', 'next'))) | Out-Null }
            'R3b' { $set = @{ BT = $V.T } }
            'R4a' { [IO.File]::AppendAllText((Join-Path $V.W 'src\a.txt'), "edit`n") }
            'R4b' { [IO.File]::WriteAllText((Join-Path $V.W 'untracked.txt'), "new`n") }
            'R5a' { $set = @{ T = '0123456789abcdef0123456789abcdef01234567' } }
            'R5b' { $set = @{ T = (Invoke-VmcGit $V.R @('rev-parse', 'main:src/a.txt')) } }
        }
        Invoke-VmcRow $V $row $set
        $lines = @($V.Out | Where-Object { $_.Contains('MOE_VM_CANDIDATE_') })
        if ($V.Res.Rc -ne 1 -or $V.Res.Outcome -cne 'refused' -or $V.Res.Code -cne "MOE_VM_CANDIDATE_$code" -or $lines.Count -ne 1 -or
            $lines[0] -cnotmatch "^\[WARN\] MOE_VM_CANDIDATE_${code}: task $($V.Tid) -- .*; nothing written\.\z") {
            Stop-Vmc $V "result $(ConvertTo-VmcJson $V.Res), expected 1 and one MOE_VM_CANDIDATE_$code line"
        }
        Assert-VmcUntouched $V
    }
    Write-Host '[vm candidate] R6: a lost CAS parks the commit and restores W'
    New-VmcFixture $V; $other = Invoke-VmcGit $V.R @('commit-tree', $V.BT, '-p', $V.C, '-m', 'other')
    Invoke-VmcRow $V R6 @{ Hook = "git update-ref refs/heads/$($V.B) $other" }
    Assert-VmcParked $V REF_CONTENTION vm-ref-contention
    if ((Invoke-VmcGit $V.R @('rev-parse', "refs/heads/$($V.B)")) -cne $other) { Stop-Vmc $V 'the branch is not where the race left it' }
    Write-Host '[vm candidate] R7: a failed W update parks the commit; the branch stays'
    New-VmcFixture $V; $lock = Join-Path (Invoke-VmcGit $V.W @('rev-parse', '--absolute-git-dir')) 'index.lock'
    [IO.File]::WriteAllText($lock, '')
    try { Invoke-VmcRow $V R7 } finally { Remove-Item -LiteralPath $lock -Force -ErrorAction SilentlyContinue }
    Assert-VmcParked $V SYNC_FAILED vm-sync-failed
    if ((Invoke-VmcGit $V.R @('rev-parse', "refs/heads/$($V.B)")) -cne $V.C -or (Get-VmcWIndex $V) -cne $V.I0) { Stop-Vmc $V "the branch or W's index moved" }
    Write-Host '[vm candidate] R8: an empty candidate writes nothing'
    New-VmcFixture $V; Invoke-VmcRow $V R8 @{ T = $V.BT }
    $empty = "[info] MOE_VM_CANDIDATE_EMPTY: task $($V.Tid) -- the admitted tree equals $($V.C)'s; nothing committed."
    if ($V.Res.Rc -ne 0 -or $V.Res.Outcome -cne 'nothing' -or $V.Res.Code -cne 'MOE_VM_CANDIDATE_EMPTY' -or $V.Res.Sha -or @($V.Out | Where-Object { $_ -ceq $empty }).Count -ne 1) {
        Stop-Vmc $V "result $(ConvertTo-VmcJson $V.Res), expected 0 with MOE_VM_CANDIDATE_EMPTY"
    }
    Assert-VmcUntouched $V
    Write-Host '[vm candidate] R9: the test seam never runs under MOE_RUNTIME_PROTECTED'
    New-VmcFixture $V; $other = Invoke-VmcGit $V.R @('commit-tree', $V.BT, '-p', $V.C, '-m', 'other')
    Invoke-VmcRow $V R9 @{ Protected = $true; Hook = "type nul>..\..\..\seam-ran& git update-ref refs/heads/$($V.B) $other" }
    Assert-VmcCommitted $V 1 @('src/a.txt')
    if (Test-Path -LiteralPath $V.SeamRan) { Stop-Vmc $V 'the seam ran' }
    Write-Host '[vm candidate] ok R1, R1u, R2a-R5b, R6-R9'
}
# [strong intent] Test-MoeWorktreeStrongIntent M B FROZEN GITDIR RES L on a
# scratch projectPath and git dir. G6d (ps1-only): a matching $script:MoeFrozen
# left by an earlier landing never stands in for this round's own candidate.
function Invoke-GsiRows([hashtable]$V, $Ast) {
    $V.Section = 'strong intent'; $V.Out = @()
    Write-Host '[strong intent] a no-op for legacy; the strong profile needs the frozen candidate of exactly M on B'
    $gsi = Join-Path $tempRoot 'gsi'; $projectPath = Join-Path $gsi 'project'; $gd = Join-Path $gsi 'gitdir'; $att = Join-Path $projectPath '.moe\attempts'
    New-Item -ItemType Directory -Force -Path $att, $gd | Out-Null
    $gm = 'a' * 40; $gb = 'b' * 40
    $no = "False refused MOE_COMMIT_REFUSED_INTENT_INCOMPLETE the strong profile lands only the frozen candidate of the merged tree $gm on $gb, with a pinned attempt and plan revision"
    $rows = @(
        @{ Row = 'G1'; Ok = $true }
        @{ Row = 'G1b'; Ok = $true; Pin = $true; Tid = '' }
        @{ Row = 'G2'; Pin = $true }
        @{ Row = 'G3'; Attempts = $true }
        @{ Row = 'G4'; Pin = $true; Full = $true; Tree = $gb }
        @{ Row = 'G5'; Pin = $true; Full = $true; Base = $gm }
        @{ Row = 'G6a'; Pin = $true; Full = $true; AttemptId = '' }
        @{ Row = 'G6b'; Pin = $true; Full = $true; PlanRev = $null }
        @{ Row = 'G6c'; Pin = $true; Full = $true; CandidateId = '' }
        @{ Row = 'G6d'; Pin = $true; Full = $true; Stale = $true }
        @{ Row = 'G7'; Ok = $true; Pin = $true; Full = $true }
    )
    foreach ($r in $rows) {
        $V.Row = $r.Row
        Get-ChildItem -LiteralPath $att -Filter '*.json' | Remove-Item -Force
        if ($r.Attempts) {
            [IO.File]::WriteAllText((Join-Path $att 'a1.json'), '{"taskId":"task-g","generation":1,"executionPolicySnapshot":{"profile":"legacy"}}')
            [IO.File]::WriteAllText((Join-Path $att 'a2.json'), '{"taskId":"task-g","generation":2,"executionPolicySnapshot":{"profile":"verified-local"}}')
        }
        $preflightTaskId = if ($r.ContainsKey('Tid')) { $r.Tid } else { 'task-g' }
        $script:PinnedAttemptProfile = if ($r.Pin) { 'verified-local' } else { '' }
        $f = $null; $script:MoeAttemptId = ''; $script:PinnedAttemptPlanRevision = $null; $script:MoeFrozen = $null
        if ($r.Full) { $f = @{ CandidateId = 'cand-1'; Tree = $gm; Base = $gb }; $script:MoeAttemptId = 'attempt-1'; $script:PinnedAttemptPlanRevision = 1 }
        foreach ($k in @('Tree', 'Base', 'CandidateId')) { if ($r.ContainsKey($k)) { $f[$k] = $r[$k] } }
        if ($r.ContainsKey('AttemptId')) { $script:MoeAttemptId = $r.AttemptId }
        if ($r.ContainsKey('PlanRev')) { $script:PinnedAttemptPlanRevision = $r.PlanRev }
        if ($r.Stale) { $script:MoeFrozen = $f; $f = $null }
        $res = @{ Outcome = 'untouched'; Code = 'untouched' }; $l = @{ Msg = 'untouched' }
        $got = @(Test-MoeWorktreeStrongIntent $gm $gb $f $gd $res $l)
        $line = "$($got -join ',') $($res.Outcome) $($res.Code) $($l.Msg)"
        $want = if ($r.Ok) { 'True untouched untouched untouched' } else { $no }
        if ($got.Count -ne 1 -or $got[0] -isnot [bool] -or $line -cne $want) { Stop-Vmc $V "got '$line', expected '$want'" }
    }
    # G8: Invoke-MoeWorktreeRounds calls it once per round, after the L6 gate, before L7-L9.
    $V.Row = 'G8'
    $fn = $Ast.Find({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq 'Invoke-MoeWorktreeRounds' }, $false)
    $calls = @(if ($fn) { $fn.Body.FindAll({ param($n) $n -is [System.Management.Automation.Language.CommandAst] -and $n.GetCommandName() -ceq 'Test-MoeWorktreeStrongIntent' }, $true) })
    $loop = if ($fn) { $fn.Body.Find({ param($n) $n -is [System.Management.Automation.Language.ForStatementAst] -and $n.Initializer.Extent.Text -ceq '$round = 1' }, $true) }
    $call = 'if (-not (Test-MoeWorktreeStrongIntent $m $b $(if ($Settings.configuredGate) { $frozen } else { $null }) $Git.GitDir $Res $L)) { return $false }'
    $body = if ($loop) { $loop.Body.Extent.Text } else { '' }; $at = $body.IndexOf($call, [StringComparison]::Ordinal)
    if ($calls.Count -ne 1 -or $at -lt 0) { Stop-Vmc $V "Invoke-MoeWorktreeRounds does not run '$call' exactly once inside its round loop" }
    foreach ($k in @('Invoke-MoeFrozenGate', 'MOE_COMMIT_FAILED_GATE')) {
        $i = $body.IndexOf($k, [StringComparison]::Ordinal); if ($i -lt 0 -or $i -gt $at) { Stop-Vmc $V "the call is not after '$k'" }
    }
    foreach ($k in @("'diff-tree', '-r'", "'commit-tree'", 'Write-MoeWorktreeJournal', "'update-ref'", 'Publish-MoeWorktreeLanding')) {
        $i = $body.IndexOf($k, [StringComparison]::Ordinal); if ($i -lt $at) { Stop-Vmc $V "the call is not before the first $k" }
    }
    Write-Host '[strong intent] ok G1-G7, G6d and G8'
}
function Invoke-VmcSections {
    $errors = $null
    $ast = [System.Management.Automation.Language.Parser]::ParseFile("$wrapper", [ref]$null, [ref]$errors)
    if ($errors.Count) { throw ('moe-agent.ps1 parse errors: ' + ($errors -join '; ')) }
    foreach ($fn in $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $false)) { . ([ScriptBlock]::Create($fn.Extent.Text)) }
    function Send-MoeRecordCommit([hashtable]$Record) { [void]$script:vmcLog.Add($Record); return @{ ok = $true } }
    function Send-MoeGeneralChat([string]$Content) { [void]$script:vmcChat.Add($Content) }
    function Invoke-MoeRpc { throw 'the vm candidate rows send no other RPC' }
    $Role = 'worker'; $WorkerId = 'worker-vmc'; $myPid = $PID; $preflightTaskId = ''; $projectPath = Join-Path $tempRoot 'vmc-project'
    $script:vmcLog = New-Object System.Collections.ArrayList; $script:vmcChat = New-Object System.Collections.ArrayList
    $dir = Join-Path $tempRoot 'vmc'; $hooks = Join-Path $dir 'hooks'; $gcfg = Join-Path $dir 'gitconfig'
    New-Item -ItemType Directory -Force -Path $hooks | Out-Null
    [IO.File]::WriteAllText($gcfg, "[user]`n`tname = vmc`n`temail = vmc@example.invalid`n[core]`n`tautocrlf = false`n")
    foreach ($h in @('pre-commit', 'commit-msg')) { [IO.File]::WriteAllText((Join-Path $hooks $h), "#!/bin/sh`nexit 1`n") }
    $saved = @{}
    foreach ($e in @(Get-ChildItem Env: | Where-Object { $_.Name -like 'GIT_*' })) { $saved[$e.Name] = $e.Value; Remove-Item -LiteralPath "Env:\$($e.Name)" }
    $env:GIT_CONFIG_GLOBAL = $gcfg; $env:GIT_CONFIG_NOSYSTEM = '1'
    try {
        $V = @{ Dir = $dir; Hooks = $hooks; R = (Join-Path $dir 'repo'); Tid = 'task-vmc'; B = 'moe/task/task-vmc'; SeamRan = (Join-Path $dir 'seam-ran')
            Sid = 'worker-vmc@2026-11-03T00:00:00Z'; Out = @(); Section = ''; Row = '' }
        Invoke-VmcRows $V
        Invoke-GsiRows $V $ast
    } finally {
        foreach ($n in @('GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'MOE_POSTFLIGHT_TEST_HOOK_PRE_UPDATE_REF')) { Remove-Item -LiteralPath "Env:\$n" -ErrorAction SilentlyContinue }
        foreach ($n in $saved.Keys) { Set-Item -LiteralPath "Env:\$n" -Value $saved[$n] }
        $script:MoeRuntimeProtected = $false; $script:MoeFrozen = $null; $script:PinnedAttemptProfile = ''; $script:MoeAttemptId = ''; $script:PinnedAttemptPlanRevision = $null
    }
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
    Invoke-VmcSections
    Invoke-VmjSections
    $legacy = '{"profile":"legacy","ready":true,"missingCapabilities":[],"evaluatedAt":"2026-11-01T00:00:00.000Z"}'
    $r = Invoke-VmrRow T-legacy worker claude $legacy '-'; Assert-VmrLaunched $r
    if (@(Get-Content "$project\.moe\evidence-rpcs.jsonl" | ForEach-Object { $_ | ConvertFrom-Json } | Where-Object { $_.tool -eq 'claim_next_task' -and $_.args.PSObject.Properties.Name -contains 'executionRoute' }).Count) { Stop-Vmr $r 'legacy claim marked vm' }
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
        'malformed-array|[{"profile":"verified-local","ready":true,"missingCapabilities":[]}]',
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
    # Legacy taskless lines: nothing to answer prints one reason=idle and no CLI; a routed
    # mention launches the notification-only CLI and prints no no-launch line. The knobs
    # come off on every path: the refusal rows and A1/G1 below must not inherit them.
    try {
        $env:FAKE_CLAIM_MODE = 'idle'
        $r = Invoke-VmrRow T-taskless-idle worker claude $legacy '-'
        if ($r.Code -ne 0 -or $r.Ran) { Stop-Vmr $r "exit $($r.Code) or the CLI ran" }
        Assert-VmrOneReason $r idle
        $env:FAKE_MENTION = '1'
        $r = Invoke-VmrRow T-taskless-mention worker claude $legacy '-'; Assert-VmrLaunched $r
        if ($r.Text.Contains('MOE_TASKLESS_NO_LAUNCH')) { Stop-Vmr $r 'a launching iteration printed a no-launch line' }
    } finally { Remove-Item Env:\FAKE_CLAIM_MODE, Env:\FAKE_MENTION -ErrorAction SilentlyContinue }
    Write-Host '[vm route] ok today path (legacy x2, observe, unreadable, refuse, unknown, fail, malformed, case trap, taskless idle and mention)'
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
        ('N4|worker|claude|{"profile":"verified-local","ready":false,"missingCapabilities":["line\n\t\u00a0end","ok"],"evaluatedAt":"2026-11-01T00:00:00.000Z"}|on|NOT_READY|' + "$notReady line???end, ok; refusing to start this seat.")
    )
    foreach ($row in $rows) {
        $a = $row -split '\|', 7
        $r = Invoke-VmrRow $a[0] $a[1] $a[2] $a[3] $a[4]
        Assert-VmrRefused $r "MOE_VERIFIED_LOCAL_$($a[5])" $a[6]
    }
    Write-Host '[vm route] ok refusals (C1/C2, S1-S6, N1-N4; R1/R2 in vm seat)'
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
