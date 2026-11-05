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
$script:VmrCommand = ''; $script:VmrTimeoutSec = 0 # one-row overrides for Invoke-VmrRow; the row that sets one clears it
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
    # A gemini seat would run agy: MOE_AGY_COMMAND points it at the fake, never the machine's real Antigravity.
    $env:MOE_AGY_COMMAND = Join-Path $tempRoot 'gemini.cmd'
    $env:USERPROFILE = $homeDir; $env:TEMP = $runTmp; $env:TMP = $runTmp
    if ($script:VmrSetup) { & $script:VmrSetup }
    Push-Location $project
    try {
        $command = if ($script:VmrCommand) { $script:VmrCommand } elseif ($env:MOE_RUNTIME_PROTECTED -eq '1') { $Cli } else { Join-Path $tempRoot "$Cli.cmd" }
        $code = Invoke-WrapperProcess (@('-Project', $project, '-WorkerId', "$Role-vmr", '-Role', $Role, '-Team', 'Smoke', '-NoStartDaemon', '-Command', $command) + $script:VmrLoop + $script:VmjExtraArgs) $out $script:VmrTimeoutSec
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
    Remove-Item -LiteralPath "$tempRoot\accounts\acct-1\.credentials.json" -Force -ErrorAction SilentlyContinue
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
# A background poller that writes CONTENT to FILE (the minted token by default) once the
# wrapper output holds N MOE_VM_CREDENTIAL_UNAVAILABLE matches, or N whole lines equal to
# LINE. It replaces FILE in one rename, and writes $tempRoot\restore.state:
# 'seat-job-before-credential' when the seat had already run a job by then, else 'restored'
# (a file, not job output: 5.1's Receive-Job throws 'The Persistence Path does not exist.'
# once USERPROFILE points at the run's home).
function Start-VmeTokenRestore([int]$N, [string]$File = "$tempRoot\accounts\claude-vm-tokens\acct-1.token", [string]$Content = $vmjToken, [string]$Line = '') {
    Remove-Item -LiteralPath $out, "$tempRoot\restore.state" -ErrorAction SilentlyContinue
    $pattern = if ($Line) { '(?m)^' + [regex]::Escape($Line) + '\r?$' } else { 'MOE_VM_CREDENTIAL_UNAVAILABLE' }
    Start-Job -ArgumentList $out, $File, $Content, $N, $pattern, "$project\.moe\evidence-rpcs.jsonl", "$tempRoot\restore.state" -ScriptBlock {
        param($o, $f, $t, $n, $p, $ev, $st)
        function Read-Shared([string]$Path) {
            try { $s = [IO.File]::Open($Path, 'Open', 'Read', 'ReadWrite'); try { return (New-Object IO.StreamReader($s)).ReadToEnd() } finally { $s.Dispose() } } catch { return '' }
        }
        for ($i = 0; $i -lt 3000; $i++) {
            if ([regex]::Matches((Read-Shared $o), $p).Count -ge $n) {
                $early = (Read-Shared $ev).Contains('"cmd":"seat-job"')
                [IO.File]::WriteAllText("$f.tmp", $t)
                try { if (Test-Path -LiteralPath $f) { [IO.File]::Replace("$f.tmp", $f, $null) } else { [IO.File]::Move("$f.tmp", $f) } } catch { [IO.File]::WriteAllText($f, $t) }
                [IO.File]::WriteAllText($st, $(if ($early) { 'seat-job-before-credential' } else { 'restored' })); return
            }
            Start-Sleep -Milliseconds 100
        }
    }
}
# --- [seat sign-in] task-98053b89, the twin of postflight-vm-route.sh: no minted token, so
# the job runs on the leased account's own sign-in (slice A's real helper), renewed only by
# the host claude. Canaries live in files, never in an environment variable (seats log env).
# Get-SiJson ACCESS REFRESH SECONDS-LEFT: claude's sign-in file shape.
function Get-SiJson([string]$Access, [string]$Refresh, [int]$Seconds) {
    $exp = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() + [long]1000 * $Seconds
    return '{"claudeAiOauth":{"accessToken":"' + $Access + '","refreshToken":"' + $Refresh + '","expiresAt":' + $exp + ',"scopes":["user:inference"],"subscriptionType":"max"}}'
}
# Test-SiClean ROW CANARY...: no canary in the wrapper output, the RPC, seat and chat records,
# the project, the run's temp or home. It names the file, never the value, and runs before
# any Stop-Vmr, which prints the output.
function Test-SiClean([string]$Row, [string[]]$Canary) {
    $files = @($out, $calls, "$tempRoot\renew.jsonl") + @(Get-ChildItem -LiteralPath $project, $runTmp, $homeDir -Recurse -File -Force -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName })
    $hits = @(foreach ($f in $files) {
        if (-not (Test-Path -LiteralPath $f -PathType Leaf)) { continue }
        $text = [IO.File]::ReadAllText($f)
        if (@($Canary | Where-Object { $text.Contains($_) }).Count) { $f }
    })
    if ($hits.Count) { throw "VM ROUTE FAILED ($Row): a credential canary appears in: $($hits -join ' ')" }
}
# Assert-SiWait R STATE LINE NEEDLE: LINE at least twice and no seat-job before the credential
# came (STATE from Start-VmeTokenRestore), then the job; one escalation holding NEEDLE and the
# remedy, one claim, a re-lease per wait.
function Assert-SiWait($R, [string]$State, [string]$Line, [string]$Needle) {
    if ($R.Code -ne 0) { Stop-Vmr $R "retry failed: exit $($R.Code)" }
    if ($State -cne 'restored') { Stop-Vmr $R "credential restore: '$State'" }
    if ([regex]::Matches($R.Text, '(?m)^' + [regex]::Escape($Line) + '\r?$').Count -lt 2) { Stop-Vmr $R "fewer than two lines '$Line'" }
    Assert-VmjRows $R happy; $c = Read-VmeJsonl $calls
    $sent = @($c | Where-Object { $_.tool -ceq 'chat_send' -and "$($_.args.content)".Contains('MOE_VM_CREDENTIAL_UNAVAILABLE') })
    if ($sent.Count -ne 1 -or -not $sent[0].args.content.Contains($Needle) -or -not $sent[0].args.content.Contains('sign the account in again') -or
        (Get-VmeCount $c claim_next_task) -ne 1 -or (Get-VmeCount $c lease_account) -lt 3) { Stop-Vmr $R 'escalation, claim or re-lease count' }
}
function Invoke-SiRows {
    Write-Host '[seat sign-in] a claude VM seat with no minted token uses the leased account sign-in'
    $siRefresh = 'sk-ant-ort01-vmRefreshCanaryNeverLeavesTheFile0123'
    $siOld = 'sk-ant-oat01-vmOldAccessCanaryNeverReachesAJob01234'
    $siRefresh2 = 'sk-ant-ort01-vmRenewedRefreshCanaryNeverLeaves012'
    $siFile = "$tempRoot\accounts\acct-1\.credentials.json"; $renewLog = "$tempRoot\renew.jsonl"; $renewPair = "$tempRoot\renew-pair.json"
    # $siSeed = @(ACCESS, SECONDS-LEFT) seeds a sign-in file holding $siRefresh too; $null seeds none.
    $script:VmrSetup = {
        Initialize-VmjFixture; Remove-Item -LiteralPath "$tempRoot\accounts\claude-vm-tokens\acct-1.token", $renewLog -ErrorAction SilentlyContinue
        if ($siSeed) { [IO.File]::WriteAllText($siFile, (Get-SiJson $siSeed[0] $siRefresh $siSeed[1])); $script:SiSha = Get-VmcSha256 $siFile }
    }
    try {
        Write-Host '[seat sign-in] SI-signin: the job gets the sign-in access token; no host claude, file unchanged'
        $siSeed = @($vmjToken, 7200)
        $r = Invoke-VmrRow SI-signin worker claude $ready on
        Test-SiClean SI-signin @($vmjToken, $siRefresh)
        if ($r.Code -ne 0) { Stop-Vmr $r "exit $($r.Code)" }; Assert-VmjRows $r happy
        if ((Get-VmcSha256 $siFile) -cne $script:SiSha) { Stop-Vmr $r 'the sign-in file changed' }
        if ($r.Text -cnotmatch '(?m)^\[seat\] VM credential account=acct-1 source=signin expires=[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:]{8}\.[0-9]{3}Z\r?$') { Stop-Vmr $r 'no source=signin line' }
        if (Test-Path -LiteralPath $renewLog) { Stop-Vmr $r 'a renewal ran' }

        Write-Host '[seat sign-in] SI-renew: a token 60 s from expiry is renewed by one host claude run first'
        [IO.File]::WriteAllText($renewPair, ('{"accessToken":"' + $vmjToken + '","refreshToken":"' + $siRefresh2 + '"}'))
        $siSeed = @($siOld, 60); $env:FAKE_RENEW_FILE = $renewPair
        try { $r = Invoke-VmrRow SI-renew worker claude $ready on } finally { Remove-Item Env:\FAKE_RENEW_FILE }
        Test-SiClean SI-renew @($vmjToken, $siOld, $siRefresh, $siRefresh2)
        if ($r.Code -ne 0) { Stop-Vmr $r "exit $($r.Code)" }; Assert-VmjRows $r happy
        $renew = @(Read-VmeJsonl $renewLog); $argv = if ($renew.Count) { @($renew[0].argv) } else { @() }; $t = [Array]::IndexOf($argv, '--tools')
        $cwd = if ($renew.Count) { [IO.Path]::GetFullPath($renew[0].cwd).TrimEnd('\') } else { $project }
        if ($renew.Count -ne 1 -or -not ($argv -ccontains '-p') -or $t -lt 0 -or $argv.Count -le $t + 1 -or "$($argv[$t + 1])" -cne '' -or
            @($argv | Where-Object { "$_".Contains('task-postflight') }).Count -or $cwd -ieq $project -or $cwd.StartsWith("$project\", [StringComparison]::OrdinalIgnoreCase) -or
            [IO.Path]::GetFullPath($renew[0].configDir).TrimEnd('\') -ine "$tempRoot\accounts\acct-1" -or $renew[0].hasMoeWorkerId -ne $false -or $renew[0].hasPluginDirs -ne $false) {
            Stop-Vmr $r 'not one renewal run with the renewal argv, cwd and env'
        }

        $env:MOE_ACCOUNT_RETRY_SEC = '1'
        foreach ($c in @('SI-none|no-signin-file|', "SI-short|short-life|600")) {
            $a = $c -split '\|'
            Write-Host $(if ($a[0] -ceq 'SI-none') { '[seat sign-in] SI-none: no credential holds the task with one escalation; a sign-in then runs it' }
                else { '[seat sign-in] SI-short: under an hour left waits; no renewal at 10 minutes, the job never gets it' })
            $siSeed = if ($a[2]) { @($siOld, [int]$a[2]) } else { $null }
            $warn = "[WARN] MOE_VM_CREDENTIAL_UNAVAILABLE account=acct-1 reason=$($a[1]); retrying in 1s (Ctrl+C to stop)"
            $job = Start-VmeTokenRestore 2 $siFile (Get-SiJson $vmjToken $siRefresh 7200) $warn
            try { $r = Invoke-VmrRow $a[0] worker claude $ready on } finally { Stop-Job $job; Remove-Job $job -Force }
            $state = if (Test-Path -LiteralPath "$tempRoot\restore.state") { [IO.File]::ReadAllText("$tempRoot\restore.state") } else { 'never restored' }
            Test-SiClean $a[0] @($vmjToken, $siOld, $siRefresh)
            Assert-SiWait $r $state $warn "reason=$($a[1])"
            if (Test-Path -LiteralPath $renewLog) { Stop-Vmr $r 'a renewal ran' }
        }
        Write-Host '[seat sign-in] ok SI-signin, SI-renew, SI-none, SI-short'
    } finally { Remove-Item Env:\MOE_ACCOUNT_RETRY_SEC, Env:\FAKE_RENEW_FILE -ErrorAction SilentlyContinue; $script:VmrSetup = { Initialize-VmjFixture } }
}
function Invoke-VmeRows {
    $noToken ={ Initialize-VmjFixture; Remove-Item "$tempRoot\accounts\claude-vm-tokens\acct-1.token" }
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
    Write-Host '[seat credentials] ok OPENAI_API_KEY and CODEX_API_KEY canaries, no-key'
    Invoke-SiRows
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
    # task-bbd7ad2d (ps1 twin of postflight-vm-route.sh VR-outage, task-cc4213c0): a launch
    # outage carried over from legacy iterations of one wrapper process ends on the first
    # VM-route iteration. Three legacy iterations launch the notification-only host CLI,
    # which fails fast; the third enters the outage; the 4th readiness read is verified-local.
    $vmoLine = "[launch-outage] The verified-local VM route runs this seat's sessions in its VM, never the host CLI: launch outage over, claiming resumes."
    $vmoPost = "worker-vmr: the verified-local VM route runs this seat's sessions in its VM, never the host CLI, after 3 host launch failures. Launch outage over: claiming resumes."
    $vmoLegacy = '{"profile":"legacy","ready":true,"missingCapabilities":[],"evaluatedAt":"2026-11-01T00:00:00.000Z"}'
    New-Item -ItemType Directory -Force -Path "$tempRoot\outage-bin" | Out-Null
    [IO.File]::WriteAllText("$tempRoot\outage-bin\outage-cli.cmd", "@echo off`r`n>>`"$calls`" echo {`"tool`":`"host-cli`",`"args`":{}}`r`nexit /b 1`r`n")
    # Rotation off: a failed rotated claude run relaunches and zeroes the streak.
    $vmoEnv = [ordered]@{ FAKE_CLAIM_MODE = 'idle'; FAKE_MENTION = '1'; FAKE_READINESS_AFTER = "3:$ready"; MOE_ACCOUNT_ROTATION = 'off'; MOE_LAUNCH_BACKOFF_BASE_SEC = '1'; MOE_LAUNCH_BACKOFF_MAX_SEC = '1' }
    $vmoPrev = @{}; foreach ($n in $vmoEnv.Keys) { $vmoPrev[$n] = [Environment]::GetEnvironmentVariable($n) }
    $vmoLoop = $script:VmrLoop
    try {
        foreach ($n in $vmoEnv.Keys) { [Environment]::SetEnvironmentVariable($n, $vmoEnv[$n]) }
        # No -NoLoop (sh: --poll-interval 0): the loop relaunches only after a launch failure or probe.
        $script:VmrLoop = @('-PollInterval', '0'); $script:VmrCommand = "$tempRoot\outage-bin\outage-cli.cmd"; $script:VmrTimeoutSec = 4 * $wrapperTimeoutSec
        $r = Invoke-VmrRow VR-outage worker claude $vmoLegacy on
    } finally {
        foreach ($n in $vmoPrev.Keys) { [Environment]::SetEnvironmentVariable($n, $vmoPrev[$n]) }
        $script:VmrLoop = $vmoLoop; $script:VmrCommand = ''; $script:VmrTimeoutSec = 0
    }
    $vmoCalls = Read-VmeJsonl $calls
    $vmoAt = { param([string]$Tool) @(for ($i = 0; $i -lt $vmoCalls.Count; $i++) { if ($vmoCalls[$i].tool -ceq $Tool) { $i } }) }
    $vmoReads = @(& $vmoAt get_execution_readiness); $vmoHost = @(& $vmoAt host-cli); $vmoClaims = @(& $vmoAt claim_next_task)
    $vmoFlip = if ($vmoReads.Count -ge 4) { $vmoReads[3] } else { -1 }
    $vmoSent = @(& $vmoAt chat_send | Where-Object { $vmoCalls[$_].args.content -ceq $vmoPost })
    $vmoBefore = @($vmoClaims | Where-Object { $_ -lt $vmoFlip }); $vmoAfter = @($vmoClaims | Where-Object { $_ -gt $vmoFlip })
    $vmoSeat = @(Read-VmeJsonl "$project\.moe\evidence-rpcs.jsonl" | Where-Object { $_.tool -ceq 'agent-seat' }).args.cmd -join ','
    $why = if ($r.Code -ne 0) { "exit $($r.Code)" }
    elseif (-not $r.Text.Contains('entering launch outage mode')) { 'the legacy iterations never entered the outage' }
    elseif ($vmoReads.Count -lt 4) { "only $($vmoReads.Count) readiness reads, expected at least 4" }
    elseif ($vmoHost.Count -ne 3 -or @($vmoHost | Where-Object { $_ -gt $vmoFlip }).Count) { "expected exactly 3 host CLI launches, all before the flip, saw $($vmoHost.Count)" }
    elseif ($r.Text.Contains('MOE_LAUNCH_PROBE')) { 'printed MOE_LAUNCH_PROBE: the carried-over outage suppressed the claim' }
    elseif (-not $vmoAfter.Count -or @($vmoAfter | Where-Object { $vmoCalls[$_].args.executionRoute -cne 'vm' }).Count) { 'no claim after the flip, or one without executionRoute vm' }
    elseif (-not $vmoBefore.Count -or @($vmoBefore | Where-Object { $vmoCalls[$_].args.PSObject.Properties.Name -ccontains 'executionRoute' }).Count) { 'no legacy claim, or one marked executionRoute' }
    elseif ([regex]::Matches($r.Text, [regex]::Escape('launch outage over, claiming resumes.')).Count -ne 1 -or -not $r.Text.Contains($vmoLine)) { 'expected exactly one outage-over line, the VM-route one' }
    elseif ($vmoSent.Count -ne 1 -or $vmoSent[0] -le $vmoFlip -or $vmoCalls[$vmoSent[0]].args.channel -cne 'chan-general' -or $vmoCalls[$vmoSent[0]].args.workerId -cne 'worker-vmr') { "expected one #general outage-over post after the flip, saw $($vmoSent.Count)" }
    elseif ($vmoSeat -cne 'seat-start,seat-stop') { "seat rows: $vmoSeat" }
    if ($why) { Stop-Vmr $r $why }
    Assert-VmrOneReason $r vm-route
    # The run ends before the backoff, streak or held/release/announce resets could show, so run the block itself.
    & {
        $vmoIfs = @([Management.Automation.Language.Parser]::ParseFile($wrapper, [ref]$null, [ref]$null).FindAll({
            param($ast) $ast -is [Management.Automation.Language.IfStatementAst] -and $ast.Clauses[0].Item1.Extent.Text -ceq '$script:MoeVmRoute -and $script:LaunchOutage' }, $true))
        if ($vmoIfs.Count -ne 1) { throw "VM ROUTE FAILED (VR-outage block): expected exactly one guarded if block, found $($vmoIfs.Count)" }
        $vmoBlock = [scriptblock]::Create($vmoIfs[0].Extent.Text)
        $WorkerId = 'worker-vmr'; $vmoRec = New-Object Collections.ArrayList; $vmoRefuse = $false
        # [Alias('Args')], not a param named $Args: in this stub $Args reads as the automatic array.
        function Invoke-MoeRpc { param([string]$Tool, [Alias('Args')][object]$RpcArgs) [void]$vmoRec.Add(@{ Tool = $Tool; Args = $RpcArgs }); if ($vmoRefuse) { throw 'chat down' } }
        foreach ($vmoCase in @('sent|chan-general|', 'refused|chan-general|1', 'no-channel||')) {
            $pp = $vmoCase -split '\|'; $generalChannelId = $pp[1]; $vmoRefuse = ($pp[2] -eq '1'); $vmoRec.Clear()
            $script:MoeVmRoute = $true; $script:LaunchOutage = $true; $script:LaunchFailStreak = 3; $script:LaunchFailBackoffSec = 8
            $script:LaunchOutageHeldTaskId = 'task-held'; $script:LaunchOutageReleaseTried = 'task-held'; $script:LaunchOutageAnnounce = $true
            $vmoText = @(& { . $vmoBlock } 6>&1 | ForEach-Object { "$_" }) -join "`n"
            $vmoState = (@($script:LaunchFailStreak, $script:LaunchFailBackoffSec, $script:LaunchOutage, $script:LaunchOutageHeldTaskId, $script:LaunchOutageReleaseTried, $script:LaunchOutageAnnounce) | ForEach-Object { "[$_]" }) -join ''
            $vmoPosts = @($vmoRec | Where-Object { $_.Tool -ceq 'chat_send' })
            $vmoBad = if ($vmoState -cne '[0][0][False][][][False]') { "reset state $vmoState" }
            elseif ($vmoText -cne $vmoLine) { "printed: $vmoText" }
            elseif ($vmoPosts.Count -ne $(if ($pp[1]) { 1 } else { 0 })) { "chat_send count $($vmoPosts.Count)" }
            elseif ($vmoPosts.Count -and ($vmoPosts[0].Args.channel -cne 'chan-general' -or $vmoPosts[0].Args.workerId -cne 'worker-vmr' -or $vmoPosts[0].Args.content -cne $vmoPost)) { 'chat_send args: ' + ($vmoPosts[0].Args | ConvertTo-Json -Compress) }
            if ($vmoBad) { throw "VM ROUTE FAILED (VR-outage block, $($pp[0])): $vmoBad" }
        }
    }
    $script:MoeVmRoute = $false
    Write-Host '[seat outage] ok VR-outage: a carried-over legacy launch outage ends on the first VM-route iteration, which claims again with no host CLI; the block resets all six launch-success variables (sent, refused, no-channel)'
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
# SHA-256 of a file as upper-case hex, through .NET only: Windows PowerShell 5.1
# started by node under pwsh (CI's 5.1 leg) inherits pwsh's PSModulePath and cannot
# autoload the Utility module's file-hash cmdlet. Same as postflight.ps1
# Get-Sha256Hex, sharing-violation retry included.
function Get-VmcSha256([string]$Path) {
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        for ($attempt = 1; ; $attempt++) {
            try { return ([BitConverter]::ToString($sha.ComputeHash([IO.File]::ReadAllBytes($Path))) -replace '-', '') }
            catch [IO.IOException] { if ($attempt -ge 5) { throw }; Start-Sleep -Milliseconds 300 }
        }
    } finally { $sha.Dispose() }
}
function Get-VmcControl([hashtable]$V) {
    return (@((Invoke-VmcGit $V.R @('symbolic-ref', '-q', 'HEAD')), (Invoke-VmcGit $V.R @('rev-parse', 'HEAD', 'refs/heads/main')),
        (Get-VmcSha256 (Join-Path $V.R '.git\index')),
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
        ForEach-Object { $_.FullName.Substring($base.Length) + ' ' + (Get-VmcSha256 $_.FullName) })
    return ((@((Invoke-VmcGit $V.W @('symbolic-ref', '-q', 'HEAD') -NoThrow), (Invoke-VmcGit $V.W @('ls-files', '-s', '-t'))) + $files) -join "`n")
}
function Get-VmcWIndex([hashtable]$V) {
    return (Get-VmcSha256 (Join-Path (Invoke-VmcGit $V.W @('rev-parse', '--absolute-git-dir')) 'index'))
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
    # Known answer (SHA-256 of 'abc'): every caller compares two snapshots from this helper.
    $kat = Join-Path $dir 'kat.txt'; [IO.File]::WriteAllText($kat, 'abc')
    if ((Get-VmcSha256 $kat) -cne 'BA7816BF8F01CFEA414140DE5DAE2223B00361A396177A9CB410FF61F20015AD') { throw 'VM ROUTE FAILED ([vm candidate] sha256): Get-VmcSha256 is not the upper-case SHA-256 of abc' }
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

# --- [strong gate] CQ-M07s: twin of postflight-vm-route.sh's [strong gate] (CQ-M07r).
# Under verified-local a worktree completion's L6 runs the task's owed checks in check
# VMs: R's fake dispatch CLI on the frozen candidate commit (tree M, sole parent B),
# never the qualityGate on this host, whose canary writes $sgWitness. SGV, SGU, SG8
# and G run the wrapper's functions in process. The port's Windows deviation: the
# wrapper never signals the dispatch; it stops it by creating its --stop-file (task-e444f6ae),
# so where sh expects one check-dispatch-term row these rows expect one check-dispatch-stop
# row, no term row, and a dead fake. Runs in Invoke-SgSections' scope.
function Initialize-SgFixture {
    Initialize-VmjFixture; Remove-Item Env:\FAKE_CTX_LANDING
    $p = Get-Content -Raw "$project\.moe\project.json" | ConvertFrom-Json
    $p.settings | Add-Member -NotePropertyName qualityGate -NotePropertyValue "echo ran>`"$sgWitness`""
    [IO.File]::WriteAllText("$project\.moe\project.json", ($p | ConvertTo-Json -Depth 8))
    Remove-Item -LiteralPath $sgWitness -ErrorAction SilentlyContinue
    $env:FAKE_TASK_STATUS = 'REVIEW'
}
# Initialize-PeFixture: Initialize-SgFixture plus the protected-entries files (task-ee10405f)
# on moe/control and main; $script:PeGitlink adds a gitlink under tests/. The U+00E9 name is
# built from [char]0xE9, never a literal.
function Initialize-PeFixture {
    Initialize-SgFixture; $seed = $script:VmjBase
    New-Item -ItemType Directory -Force -Path "$project\scripts", "$project\tests\sub" | Out-Null
    foreach ($f in @('package-lock.json', 'scripts/lint.sh', 'scripts/other.sh', 'tests/B.txt', 'tests/a b.txt', 'tests/a.txt', 'tests/sub/c.txt', "tests/$([char]0xE9).txt", 'unprotected.txt')) {
        [IO.File]::WriteAllText((Join-Path $project $f), "$f`n"); Invoke-VmcGit $project @('add', '--', $f) | Out-Null
    }
    if ($script:PeGitlink) { Invoke-VmcGit $project @('update-index', '--add', '--cacheinfo', "160000,$seed,tests/mod") | Out-Null }
    Invoke-VmcGit $project @('commit', '-qm', 'protected') | Out-Null; Invoke-VmcGit $project @('branch', '-f', 'main', 'HEAD') | Out-Null
    $script:VmjBase = Invoke-VmcGit $project @('rev-parse', 'HEAD')
}
function Assert-Sg($R, [bool]$Ok, [string]$Why) { if (-not $Ok) { Stop-Vmr $R $Why } }
# A probe only, it never kills: no handle holds the logged pid, so Windows may have reused it. A fake that survives ends itself after 300 s.
function Assert-SgDead([string]$Row, [int]$Id) {
    $p = Get-Process -Id $Id -ErrorAction SilentlyContinue
    if ($p -and $p.ProcessName -ceq 'node') { throw "VM ROUTE FAILED ([strong gate] $Row): the dispatch $Id outlived its stop" }
}
# Assert-SgRow R KIND [CODE [ENV]] -- sg_check: KIND pass (the check VMs passed, main
# moved to C), host (legacy, observe: the host qualityGate ran, no dispatch) or refused
# (the line names CODE, plus ' environment=ENV' for a well-formed stop id; nothing published).
# PAYLOAD (task-ee10405f), the record_candidate args: today (today's 8 names, no protected-entries
# WARN), unmeasured (today's names, one 'non-blob entry' WARN) or entries (protectedEntries names
# exactly PATHS, in order; none for []). A hashtable's key order is not stable in pwsh 7, so the
# names are compared as a set.
function Assert-SgRow($R, [string]$Kind, [string]$Code = '', [string]$EnvId = '', [string]$Payload = 'today', [string[]]$Paths = @()) {
    $ev = "$project\.moe\evidence-rpcs.jsonl"; $raw = if (Test-Path -LiteralPath $ev) { [IO.File]::ReadAllText($ev) } else { '' }
    $rows = @(Read-VmeJsonl $ev); $tools = @(Read-VmeJsonl $calls | ForEach-Object { $_.tool })
    $text = $R.Text -replace '\x1b\[[0-9;]*m', ''; $lines = @($text -split '\r?\n')
    $of = { param($t) @($rows | Where-Object { $_.tool -ceq $t }) }; $n = { param($l) @($lines | Where-Object { $_ -ceq $l }).Count }
    $B = $script:VmjBase; $main = Invoke-VmcGit $project @('rev-parse', 'refs/heads/main')
    # @() at each call: a one-row answer unrolls to a bare PSCustomObject, which has no .Count on 5.1.
    $cand = @(& $of record_candidate); $d = @(& $of check-dispatch); $fin = @(& $of finalize_attempt); $done = @(& $of record_commit | Where-Object { $_.args.kind -ceq 'completion' })
    Assert-Sg $R ($R.Code -eq 0 -and -not $R.Ran) "exit $($R.Code), host CLI ran=$($R.Ran)"
    Assert-Sg $R (-not $raw.Contains('DISPATCH-CANARY') -and -not $text.Contains('DISPATCH-CANARY')) 'the dispatch reply or stderr leaked'
    Assert-Sg $R (-not $text.Contains('MOE_CHECK_DISPATCH_PATH_IGNORED')) 'an unprotected override was ignored'
    Assert-Sg $R ($cand.Count -eq 1 -and $cand[0].args.baseRevision -ceq $B -and @(& $of record_delivery_receipt).Count -eq $(if ($Kind -eq 'pass') { 1 } else { 0 })) 'not one record_candidate on B, or not the record_delivery_receipt rows of this kind'
    $M = $cand[0].args.treeSha
    # Read as UTF-8: 5.1's Get-Content (Read-VmeJsonl) would decode the U+00E9 path as ANSI.
    $ca = @([IO.File]::ReadAllLines($ev) | Where-Object { $_.Trim() } | ForEach-Object { $_ | ConvertFrom-Json } | Where-Object { $_.tool -ceq 'record_candidate' })[0].args
    [string[]]$names = @($ca.PSObject.Properties.Name | Where-Object { $_ -cne 'protectedEntries' }); [Array]::Sort($names, [StringComparer]::Ordinal)
    $pe = $ca.PSObject.Properties['protectedEntries']; $warn = @($lines | Where-Object { $_.Contains('record_candidate: the protected check files') })
    Assert-Sg $R (($names -join ',') -ceq 'attemptId,baseRevision,deliveryTarget,generation,id,taskId,treeSha,workerId' -and $ca.taskId -ceq 'task-postflight' -and
        $ca.attemptId -ceq 'attempt-postflight' -and $ca.generation -eq 7 -and $ca.workerId -ceq 'worker-vmr' -and $ca.id -cmatch '^\S+$' -and
        $ca.baseRevision -ceq $B -and $ca.treeSha -ceq $M -and $ca.deliveryTarget -ceq 'refs/heads/main') "record_candidate args: $($ca | ConvertTo-Json -Compress -Depth 4)"
    if ($Payload -ceq 'entries') {
        $got = @($pe.Value)
        Assert-Sg $R ($pe -and $pe.Value -is [array] -and $got.Count -eq $Paths.Count -and $warn.Count -eq 0) "protectedEntries: $($ca | ConvertTo-Json -Compress -Depth 4), expected $($Paths.Count) entries, or a WARN: $($warn -join ' | ')"
        for ($i = 0; $i -lt $Paths.Count; $i++) {
            $e = $got[$i]; $oid = Invoke-VmcGit $project @('rev-parse', "${M}:$($Paths[$i])")
            Assert-Sg $R ((@($e.PSObject.Properties.Name) -join ',') -ceq 'path,oid' -and $e.path -ceq $Paths[$i] -and $e.oid -ceq $oid) "protectedEntries[$i]: $($e | ConvertTo-Json -Compress), expected $($Paths[$i]) $oid"
        }
    } else {
        $want = if ($Payload -ceq 'unmeasured') { "[WARN] record_candidate: the protected check files of task task-postflight were not measured on tree $M (non-blob entry); the candidate is recorded without protectedEntries, so qa_approve will report protected-checks-unmeasured." } else { '' }
        Assert-Sg $R (-not $pe -and ($warn -join "`n") -ceq $want) "protectedEntries sent, or protected-entries WARN lines: $($warn -join ' | ')"
    }
    if ($Kind -eq 'host') {
        $runs = @(& $of record_check_run)
        Assert-Sg $R ($d.Count -eq 0 -and (Test-Path -LiteralPath $sgWitness) -and [IO.File]::ReadAllText($sgWitness).Trim() -ceq 'ran') 'the dispatch ran, or the host qualityGate did not'
        Assert-Sg $R ($runs.Count -eq 1 -and $runs[0].args.outcome -ceq 'passed' -and (& $n '[OK] qualityGate passed.') -eq 1) 'not one passed host CheckRun'
    } else {
        Assert-Sg $R (-not (Test-Path -LiteralPath $sgWitness) -and @(& $of record_check_run).Count -eq 0 -and -not $text.Contains('Post-flight: quality gate:')) 'the qualityGate ran on the host'
        if ($Code -ceq 'MOE_CHECK_DISPATCH_UNAVAILABLE') { Assert-Sg $R ($d.Count -eq 0) 'a missing CLI ran' }
        else {
            Assert-Sg $R ($d.Count -eq 1) "$($d.Count) check-dispatch rows"
            $x = $d[0].args; $cx = "$($x.argv[5])"; $sf = "$($x.argv[7])"   # PowerShell names are case-blind: never $X beside $x
            Assert-Sg $R ($cx -cmatch '^[0-9a-f]{40}$' -and ($x.argv -join "`n") -ceq (@('--project', $project, '--task', 'task-postflight', '--commit', $cx, '--stop-file', $sf) -join "`n")) "dispatch argv: $($x.argv -join ' ')"
            Assert-Sg $R ([IO.Path]::IsPathRooted($sf) -and -not (Test-Path -LiteralPath $sf) -and $x.stopAtStart -is [bool] -and -not $x.stopAtStart) "the stop file '$sf' is not rooted, outlived the row, or existed at the start ($($x.stopAtStart))"
            $stops = @(& $of check-dispatch-stop | ForEach-Object { "$($_.args.pid)" }) -join ','; $want = if ($Code -ceq 'MOE_CHECK_DISPATCH_TIMEOUT') { "$($x.pid)" } else { '' }
            Assert-Sg $R ($stops -ceq $want) "stop rows '$stops', expected '$want'"
            Assert-Sg $R ($x.entry -ceq $sgFake -and $x.tree -ceq $M -and (@($x.parents) -join ' ') -ceq $B -and $x.heads.'refs/heads/main' -ceq $B) 'dispatch entry, tree, parents or main'
            Assert-Sg $R ($x.candidateId -ceq $cand[0].args.id -and @($x.credentials).Count -eq 0) 'dispatch candidate, or a credential reached it'
            Assert-Sg $R (-not (Invoke-VmcGit $project @('for-each-ref', '--contains', $cx)) -and @(& $of check-dispatch-term).Count -eq 0) 'a ref holds the frozen candidate commit, or the wrapper signalled the dispatch'
            Assert-SgDead $R.Row $x.pid
        }
    }
    if ($Kind -eq 'refused') {
        $v = $Code + $(if ($EnvId) { " environment=$EnvId" } else { '' })
        Assert-Sg $R ($main -ceq $B -and $done.Count -eq 1 -and $done[0].args.outcome -ceq 'failed' -and $done[0].args.code -ceq 'MOE_COMMIT_FAILED_GATE' -and $done[0].args.pushed -eq $false) 'main moved, or not one failed MOE_COMMIT_FAILED_GATE completion record'
        Assert-Sg $R ($fin.Count -eq 1 -and $fin[0].args.outcome -ceq 'unlanded' -and $fin[0].args.unlandedReason -ceq 'gate' -and $fin[0].args.targetTip -ceq $B -and
            $fin[0].args.PSObject.Properties.Name -ccontains 'landedRevision' -and $null -eq $fin[0].args.landedRevision) 'not one unlanded gate finalize on B'
        $retry = Get-Content -Raw -LiteralPath "$project\.moe\landing-retry.json" | ConvertFrom-Json
        Assert-Sg $R ($retry.reason -ceq 'gate' -and $retry.count -eq 1 -and (Invoke-VmcGit $project @('rev-parse', "$($retry.rescueRef)") -NoThrow) -ceq (Invoke-VmcGit $project @('rev-parse', 'refs/heads/moe/task/task-postflight'))) 'landing-retry or its rescue ref'
        Assert-Sg $R ((Get-Content -Raw -LiteralPath "$project\.moe\attempts\attempt-postflight.json" | ConvertFrom-Json).phase -ceq 'closed') 'the attempt is not closed'
        Assert-Sg $R (@($tools | Where-Object { $_ -cin @('set_task_status', 'complete_task', 'release_task', 'report_blocked', 'qa_approve', 'qa_reject') }).Count -eq 0) "a status RPC: $($tools -join ' ')"
        Assert-Sg $R (@($lines | Where-Object { $_.Contains('MOE_CHECK_DISPATCH_REFUSED') }).Count -eq 1 -and (& $n "[WARN] MOE_CHECK_DISPATCH_REFUSED: $v") -eq 1) "not one REFUSED line naming $v"
        Assert-Sg $R ((& $n "[WARN] MOE_COMMIT_FAILED_GATE: task task-postflight -- the merged tree $M on $B was not frozen, recorded and passed by the check VMs ($v); main did not move and the task's bytes stay on moe/task/task-postflight.") -eq 1) 'not one exact MOE_COMMIT_FAILED_GATE line'
    } else {
        Assert-Sg $R ($main -cne $B -and (Invoke-VmcGit $project @('rev-parse', "$main^@")) -ceq $B -and (Invoke-VmcGit $project @('rev-parse', "$main^{tree}")) -ceq $M) 'main is not one commit of M on B'
        Assert-Sg $R ($done.Count -eq 1 -and $done[0].args.outcome -ceq 'committed' -and $done[0].args.sha -ceq $main -and $fin.Count -eq 1 -and $fin[0].args.outcome -ceq 'landed' -and $fin[0].args.landedRevision -ceq $main) 'the landing records'
        if ($Kind -eq 'pass') {
            $pos = { param($t, $k) for ($i = 0; $i -lt $rows.Count; $i++) { if ($rows[$i].tool -ceq $t -and (-not $k -or $rows[$i].args.kind -ceq $k)) { return $i } }; return -1 }
            Assert-Sg $R ($main -cne $d[0].args.argv[5] -and (& $pos check-dispatch) -lt (& $pos record_commit completion) -and (& $pos record_commit completion) -lt (& $pos finalize_attempt)) 'dispatch order'
            Assert-Sg $R ((& $n "[OK] check VMs passed every owed check of candidate $($cand[0].args.id).") -eq 1 -and -not $text.Contains('MOE_CHECK_DISPATCH_REFUSED')) 'not one [OK] line'
            Assert-Sg $R (-not (Test-Path -LiteralPath "$project\.git\moe\receipt\task-postflight.json")) 'the receipt journal stayed'
        }
    }
}
function Invoke-SgRow([string]$Row, [hashtable]$Set, [string]$Cli = 'codex', [string]$Readiness = $ready) {
    foreach ($k in $Set.Keys) { Set-Item -LiteralPath "Env:\$k" -Value $Set[$k] }
    try { return (Invoke-VmrRow $Row worker $Cli $Readiness on) } finally { foreach ($k in $Set.Keys) { Remove-Item -LiteralPath "Env:\$k" -ErrorAction SilentlyContinue } }
}
function Invoke-SgRows {
    $strong = @{ FAKE_ATTEMPT_PROFILE = 'verified-local'; MOE_CHECK_DISPATCH_PATH = $sgFake }
    Write-Host '[strong gate] SG-pass: the check VMs pass the frozen candidate; main moves to C; the host qualityGate never runs'
    Assert-SgRow (Invoke-SgRow SG-pass ($strong + @{ FAKE_CHECK_DISPATCH = 'pass' })) pass
    Write-Host '[strong gate] SG-legacy, SG-observe: the host qualityGate runs (Invoke-MoeFrozenGate -WorktreeMode), the override unused'
    # The protected-entries contract (task-ee10405f): served to SG-legacy and SG-observe, whose
    # record_candidate must still send today's 8 names, and to PE-pass and PE-unmeasured below.
    $pe = '{"requiredChecks":[{"id":"gate","command":"npm test","configs":["package-lock.json","vm-job.txt"],"assertionRoots":["tests"]},{"id":"lint","command":"npm run lint","configs":["package-lock.json"],"scripts":["scripts/lint.sh","scripts/gone.sh"]}]}'
    Assert-SgRow (Invoke-SgRow SG-legacy @{ MOE_CHECK_DISPATCH_PATH = $sgFake; FAKE_CHECK_DISPATCH = 'pass'; FAKE_CTX_CONTRACT = $pe }) host
    Assert-SgRow (Invoke-SgRow SG-observe @{ FAKE_ATTEMPT_PROFILE = 'observe'; MOE_CHECK_DISPATCH_PATH = $sgFake; FAKE_CHECK_DISPATCH = 'pass'; FAKE_CTX_CONTRACT = $pe }) host
    Write-Host "[strong gate] PE-pass, PE-empty, PE-unmeasured: a strong record_candidate carries the candidate tree's protected entries"
    $script:VmrSetup = { Initialize-PeFixture }
    try {
        $want = @('package-lock.json', 'scripts/lint.sh', 'tests/B.txt', 'tests/a b.txt', 'tests/a.txt', 'tests/sub/c.txt', "tests/$([char]0xE9).txt", 'vm-job.txt')
        Assert-SgRow (Invoke-SgRow PE-pass ($strong + @{ FAKE_CHECK_DISPATCH = 'pass'; FAKE_CTX_CONTRACT = $pe })) pass '' '' entries $want
        $script:PeGitlink = $true
        Assert-SgRow (Invoke-SgRow PE-unmeasured ($strong + @{ FAKE_CHECK_DISPATCH = 'pass'; FAKE_CTX_CONTRACT = $pe })) pass '' '' unmeasured
    } finally { $script:PeGitlink = $false; $script:VmrSetup = { Initialize-SgFixture } }
    Assert-SgRow (Invoke-SgRow PE-empty ($strong + @{ FAKE_CHECK_DISPATCH = 'pass'; FAKE_CTX_CONTRACT = '{"requiredChecks":[{"id":"gate","command":"true"}]}' })) pass '' '' entries
    Write-Host '[strong gate] every non-pass fails the round as MOE_COMMIT_FAILED_GATE: main stays at B, one fixed-code line'
    $stop = { param($c, $e) $h = @{ FAKE_CHECK_DISPATCH = 'stopped'; FAKE_CHECK_DISPATCH_CODE = $c }; if ($e) { $h.FAKE_CHECK_DISPATCH_ENVIRONMENT = $e }; $h }
    foreach ($c in @(@('SG-nonzero', 'MOE_CHECK_DISPATCH_NOT_PASSED', '', @{ FAKE_CHECK_DISPATCH = 'not-passed' }),
        @('SG-stopped', 'RUNNER_VM_DELETE_FAILED', '', (& $stop RUNNER_VM_DELETE_FAILED)), @('SG-nothing-owed', 'RUNNER_NOTHING_OWED', '', (& $stop RUNNER_NOTHING_OWED)),
        @('SG-undeclared', 'RUNNER_DEPENDENCIES_UNDECLARED', '', (& $stop RUNNER_DEPENDENCIES_UNDECLARED)),
        @('SG-crash', 'MOE_CHECK_DISPATCH_NO_REPORT', '', @{ FAKE_CHECK_DISPATCH = 'crash' }), @('SG-unparsable', 'MOE_CHECK_DISPATCH_REPLY_INVALID', '', @{ FAKE_CHECK_DISPATCH = 'garbage' }),
        @('SG-env', 'RUNNER_ENVIRONMENT_NOT_APPROVED', $sgEnvId, (& $stop RUNNER_ENVIRONMENT_NOT_APPROVED $sgEnvId)),
        @('SG-env-malformed', 'RUNNER_ENVIRONMENT_NOT_APPROVED', '', (& $stop RUNNER_ENVIRONMENT_NOT_APPROVED $sgEnvUpper)))) {
        Assert-SgRow (Invoke-SgRow $c[0] ($strong + $c[3])) refused $c[1] $c[2]
    }
    Assert-SgRow (Invoke-SgRow SG-missing @{ FAKE_ATTEMPT_PROFILE = 'verified-local'; MOE_CHECK_DISPATCH_PATH = "$tempRoot\no-such-dispatch.js" }) refused MOE_CHECK_DISPATCH_UNAVAILABLE
    $clock = [Diagnostics.Stopwatch]::StartNew()
    $r = Invoke-SgRow SG-timeout ($strong + @{ FAKE_CHECK_DISPATCH = 'hang'; MOE_CHECK_DISPATCH_TIMEOUT_SEC = '2' })
    Assert-Sg $r ($clock.Elapsed.TotalSeconds -lt 60) "the timed-out dispatch took $([int]$clock.Elapsed.TotalSeconds)s to stop"
    Assert-SgRow $r refused MOE_CHECK_DISPATCH_TIMEOUT
    Write-Host '[strong gate] SG-protected: MOE_CHECK_DISPATCH_PATH is ignored under MOE_RUNTIME_PROTECTED=1, and never printed'
    [IO.File]::WriteAllText("$tempRoot\daemon.cjs", '// never invoked')
    $r = Invoke-SgRow SG-protected @{ MOE_RUNTIME_PROTECTED = '1'; MOE_DAEMON_PATH = "$tempRoot\daemon.cjs"; MOE_CHECK_DISPATCH_PATH = $sgFake } claude '{"profile":"verified-local","ready":false,"missingCapabilities":[]}'
    Assert-Sg $r ($r.Code -eq 1 -and [regex]::Matches($r.Text, 'MOE_CHECK_DISPATCH_PATH_IGNORED').Count -eq 1 -and @($r.Text -split '\r?\n' | Where-Object { $_ -ceq $sgIgnored }).Count -eq 1) 'the override was not ignored with one warning'
    Assert-Sg $r (-not $r.Text.Contains($sgFake)) 'the override value was printed'
    Write-Host '[strong gate] ok SG-pass, legacy, observe, PE-pass, PE-unmeasured, PE-empty, nonzero, stopped, nothing-owed, undeclared, crash, unparsable, env, env-malformed, missing, timeout, protected'
}
# --- [strong receipt] CQ-M07t: twin of postflight-vm-route.sh's [strong receipt]. A strong
# worktree landing sends its delivery receipt after the publish and before finalize_attempt;
# an unanswered one defers the finalize to the next pre-flight replay. The port's one
# deviation: a hashtable's key order is not stable across pwsh processes, so the replay's
# receipt is compared field by field in sorted-key form, not as wire bytes.
# Assert-SrRow R KIND -- sr_check: KIND pass (T1), conflict (T3), deferred (T2's landing,
# the receipt refused), replay (T2's next pre-flight, run 1's RPC rows first), legacy
# (T4: finalize_attempt refused, so the journal it wrote today stays to be read), lost
# (T5: a conflict, then every finalize lost), lost-replay (T5's next pre-flight), or
# refused / running (T2's next pre-flight with the replayed finalize refused, or the kept
# attempt read as running; the journal stays either way).
function Assert-SrRow($R, [string]$Kind) {
    $rows = @(Read-VmeJsonl "$project\.moe\evidence-rpcs.jsonl"); $lines = @(($R.Text -replace '\x1b\[[0-9;]*m', '') -split '\r?\n')
    $i = 0; foreach ($x in $rows) { $x | Add-Member -NotePropertyName ix -NotePropertyValue $i; $i++ }
    $of = { param($t) @($rows | Where-Object { $_.tool -ceq $t }) }; $n = { param($f) @($lines | Where-Object $f).Count }
    $canon = { param($a) @($a.PSObject.Properties | Sort-Object Name | ForEach-Object { "$($_.Name)=$($_.Value)" }) -join ';' }
    $B = $script:VmjBase; $C = Invoke-VmcGit $project @('rev-parse', 'refs/heads/main'); $jf = "$project\.git\moe\receipt\task-postflight.json"
    $phase = (Get-Content -Raw -LiteralPath "$project\.moe\attempts\attempt-postflight.json" | ConvertFrom-Json).phase
    $cand = @(& $of record_candidate); $rec = @(& $of record_delivery_receipt); $fin = @(& $of finalize_attempt); $done = @(& $of record_commit | Where-Object { $_.args.kind -ceq 'completion' })
    $today = @('taskId', 'workerId', 'attemptId', 'generation', 'sessionId', 'workspaceMode', 'publicationMode', 'target', 'targetBefore', 'targetAfter', 'landedRevision', 'worktree', 'taskBranch', 'ledger')
    Assert-Sg $R ($R.Code -eq 0 -and $cand.Count -eq 1 -and $C -cne $B -and $done.Count -gt 0 -and $done[0].args.outcome -ceq 'committed' -and $done[0].args.sha -ceq $C) "exit $($R.Code), or not one candidate landed as main"
    $deferred = & $n { $_.Contains('MOE_FINALIZE_DEFERRED_RECEIPT') }; $kept = & $n { $_.StartsWith('[WARN] receipt journal ') -and $_.Contains(' kept: ') }
    if ($Kind -eq 'legacy') {
        Assert-Sg $R ($rec.Count -eq 0 -and $fin.Count -gt 0 -and @($fin | Where-Object { $_.args.outcome -cne 'landed' }).Count -eq 0 -and $deferred -eq 0) 'a non-strong landing sent a receipt, or did not finalize landed'
        Assert-Sg $R ((& $n { $_.StartsWith('[WARN] receipt journal ') -and $_.EndsWith(' kept: the completion row or finalize_attempt got no answer; the next pre-flight replays it.') }) -eq 1) 'not one legacy journal-kept line'
        $keys = @((Get-Content -Raw -LiteralPath $jf | ConvertFrom-Json).PSObject.Properties.Name) -join ','
        Assert-Sg $R ($keys -ceq ($today -join ',')) "the legacy journal keys: $keys"
        return
    }
    $id = [string]$cand[0].args.id
    $want = [pscustomobject]@{ candidateId = $id; target = 'refs/heads/main'; targetBefore = $B; targetAfter = $C; landedRevision = $C; workerId = 'worker-vmr' }
    Assert-Sg $R ($rec.Count -gt 0 -and (& $canon $rec[0].args) -ceq (& $canon $want) -and $done[0].ix -lt $rec[0].ix) "the receipt, or it precedes the completion row: $(& $canon $rec[0].args)"
    $conflict = "[WARN] candidate $id already has a delivery receipt that differs from this report; keeping the recorded one, not retrying."
    Assert-Sg $R ((& $n { $_ -ceq $conflict }) -eq $(if ($Kind -in @('conflict', 'lost', 'lost-replay')) { 1 } else { 0 })) 'conflict lines'
    $strongJournal = {
        $j = Get-Content -Raw -LiteralPath $jf | ConvertFrom-Json; $keys = @($j.PSObject.Properties.Name) -join ','
        Assert-Sg $R ($keys -ceq (($today + @('candidateId', 'treeSha', 'baseRevision', 'planRevision', 'profile')) -join ',')) "the strong journal keys: $keys"
        Assert-Sg $R ($j.candidateId -ceq $id -and $j.treeSha -ceq $cand[0].args.treeSha -and $j.baseRevision -ceq $B -and ($j.planRevision -is [int] -or $j.planRevision -is [long]) -and $j.planRevision -eq 1 -and
            $j.profile -ceq 'verified-local' -and $j.targetBefore -ceq $B -and $j.targetAfter -ceq $C -and $j.landedRevision -ceq $C -and $j.target -ceq 'refs/heads/main') 'the strong journal fields'
    }
    if ($Kind -eq 'deferred') {
        Assert-Sg $R ($rec.Count -eq 1 -and $fin.Count -eq 0 -and $phase -ceq 'finalizing' -and $deferred -eq 1 -and $kept -eq 1) "receipts $($rec.Count), finalizes $($fin.Count), phase $phase, deferral lines $deferred, kept lines $kept"
        Assert-Sg $R ((& $n { $_ -ceq "[WARN] MOE_FINALIZE_DEFERRED_RECEIPT: task task-postflight -- the delivery receipt of $C is not recorded; the attempt stays finalizing until a pre-flight replay records it, then finalizes." }) -eq 1) 'not one exact MOE_FINALIZE_DEFERRED_RECEIPT line'
        Assert-Sg $R ((& $n { $_.StartsWith("[WARN] delivery receipt not recorded for candidate $id; journal kept at ") }) -eq 1) 'not one receipt-not-recorded line'
        & $strongJournal
        return
    }
    # refused / running (task-9194f182): T2's next pre-flight with the replayed finalize refused, or the kept
    # attempt read as running. The receipt is re-sent and the strong journal stays byte for byte.
    if ($Kind -eq 'refused' -or $Kind -eq 'running') {
        $jKeep = [IO.File]::ReadAllText("$tempRoot\sr-keep\.git\moe\receipt\task-postflight.json")
        $lost = '[WARN] attempt attempt-postflight is still finalizing after its replayed receipt; its finalizing holds stay until it closes.'
        $open = & $n { $_.StartsWith('[WARN] receipt journal ') -and $_.EndsWith(' kept: attempt attempt-postflight of task task-postflight is running, not closed; nothing finalized.') }
        Assert-Sg $R ($rec.Count -eq 2 -and (& $canon $rec[1].args) -ceq (& $canon $rec[0].args)) "receipts $($rec.Count), or the replay did not re-send the journaled receipt"
        Assert-Sg $R (@(& $of check-dispatch).Count -eq 1 -and $deferred -eq 0) 'the replay dispatched again, or deferred'
        Assert-Sg $R ((& $n { $_.StartsWith('[receipt] replaying the delivery receipt of task task-postflight from ') }) -eq 1) 'not one replay line'
        Assert-Sg $R ((Test-Path -LiteralPath $jf) -and [IO.File]::ReadAllText($jf) -ceq $jKeep) 'the strong journal was not kept byte for byte'
        if ($Kind -eq 'refused') {
            Assert-Sg $R ($fin.Count -eq 3 -and @($fin | Where-Object { $_.args.outcome -cne 'landed' -or $_.args.landedRevision -cne $C }).Count -eq 0) "finalize tries $($fin.Count), or not all landed"
            Assert-Sg $R ($phase -ceq 'finalizing' -and (& $n { $_ -ceq $lost }) -eq 1 -and (& $n { $_.Contains(' not closed; nothing finalized.') }) -eq 0 -and $kept -eq 0) "phase $phase, or not one still-finalizing line and no not-closed line"
        } else {
            Assert-Sg $R ($fin.Count -eq 0 -and $phase -ceq 'running' -and $open -eq 1 -and $kept -eq 1 -and (& $n { $_ -ceq $lost }) -eq 0) "finalizes $($fin.Count), phase $phase, not-closed lines $open, kept lines $kept"
        }
        return
    }
    # lost (T5): a receipt conflict, then every finalize lost; the strong journal stays (task-a1f3723f).
    if ($Kind -eq 'lost') {
        Assert-Sg $R ($rec.Count -eq 1 -and $fin.Count -eq 3 -and @($fin | Where-Object { $_.args.outcome -cne 'landed' -or $_.args.landedRevision -cne $C }).Count -eq 0 -and $rec[0].ix -lt $fin[0].ix) "receipts $($rec.Count), finalizes $($fin.Count), or not three landed finalizes after the receipt"
        Assert-Sg $R ($phase -ceq 'finalizing' -and $deferred -eq 0) "phase $phase, deferral lines $deferred"
        Assert-Sg $R ((& $n { $_.StartsWith('[WARN] receipt journal ') -and $_.EndsWith(' kept: its completion row, delivery receipt or closed attempt is not recorded yet; the next pre-flight replays it.') }) -eq 1) 'not one strong journal-kept line'
        Assert-Sg $R ((& $n { $_ -ceq '[WARN] finalize_attempt acknowledgement exhausted; stopping new-task loop (no repeated Git effect).' }) -eq 1) 'not one exhausted-finalize line'
        & $strongJournal
        Assert-Sg $R (-not (Test-Path -LiteralPath "$project\.moe\receipts\$id.json")) 'a conflict stored a receipt'
        return
    }
    # lost-replay (T5's next pre-flight): the conflict again, the finalize answered; the attempt closes and the journal goes.
    if ($Kind -eq 'lost-replay') {
        Assert-Sg $R ($rec.Count -eq 2 -and (& $canon $rec[1].args) -ceq (& $canon $rec[0].args)) "receipts $($rec.Count), or the replay did not re-send the journaled receipt"
        Assert-Sg $R ((& $n { $_.StartsWith('[receipt] replaying the delivery receipt of task task-postflight from ') }) -eq 1) 'not one replay line'
        $first = $fin[0].args; $last = $fin[-1].args
        Assert-Sg $R ($fin.Count -eq 4 -and $last.outcome -ceq 'landed' -and $last.landedRevision -ceq $C -and $last.attemptId -ceq $first.attemptId -and $last.generation -eq $first.generation -and
            $last.workerId -ceq $first.workerId -and $rec[-1].ix -lt $fin[-1].ix) "finalizes $($fin.Count), or the last is not the attempt's landed finalize after the last receipt"
        Assert-Sg $R ($phase -ceq 'closed' -and -not (Test-Path -LiteralPath $jf) -and $deferred -eq 0 -and $kept -eq 0 -and @(& $of check-dispatch).Count -eq 1) "phase $phase, the journal stayed, a deferral or kept line, or the replay dispatched again"
        Assert-Sg $R (-not (Test-Path -LiteralPath "$project\.moe\receipts\$id.json")) 'a conflict stored a receipt'
        return
    }
    Assert-Sg $R ($rec.Count -eq $(if ($Kind -eq 'replay') { 2 } else { 1 }) -and $fin.Count -eq 1 -and $fin[0].args.outcome -ceq 'landed' -and $fin[0].args.landedRevision -ceq $C -and $rec[-1].ix -lt $fin[0].ix) "receipts $($rec.Count), or not one landed finalize after the last"
    Assert-Sg $R ($phase -ceq 'closed' -and -not (Test-Path -LiteralPath $jf) -and $deferred -eq 0 -and $kept -eq 0) "phase $phase, the journal stayed, or a deferral or kept line"
    if ($Kind -eq 'replay') {
        Assert-Sg $R ((& $canon $rec[1].args) -ceq (& $canon $rec[0].args) -and @(& $of check-dispatch).Count -eq 1) 'the replay did not re-send the journaled receipt, or dispatched again'
        Assert-Sg $R ((& $n { $_.StartsWith('[receipt] replaying the delivery receipt of task task-postflight from ') }) -eq 1) 'not one replay line'
    }
    $sf = "$project\.moe\receipts\$id.json"
    if ($Kind -ne 'conflict') { Assert-Sg $R ((Test-Path -LiteralPath $sf) -and $null -eq (Get-Content -Raw -LiteralPath $sf | ConvertFrom-Json).pushResult) 'no stored receipt, or it carries a pushResult' }
}
function Invoke-SrRows {
    $strong = @{ FAKE_ATTEMPT_PROFILE = 'verified-local'; MOE_CHECK_DISPATCH_PATH = $sgFake; FAKE_CHECK_DISPATCH = 'pass' }
    Write-Host '[strong receipt] T1-T5: the receipt between the completion row and finalize_attempt, the deferral and its replay, the replay with its finalize refused or its attempt running, a conflict, the legacy control, a conflict with every finalize lost and its replay'
    Assert-SrRow (Invoke-SgRow SR-T1 $strong) pass
    Assert-SrRow (Invoke-SgRow SR-T2 ($strong + @{ FAKE_EVIDENCE_MODE = 'receipt-refused' })) deferred
    # The replay is the same seat's next run on the same project: its claim is refused
    # while the attempt is finalizing, and its pre-flight replays the kept journal.
    $keep = "$tempRoot\sr-keep"; Remove-Item -LiteralPath $keep -Recurse -Force -ErrorAction SilentlyContinue
    Copy-Item -LiteralPath $project -Destination $keep -Recurse -Force
    $script:VmrSetup = { Remove-Item -LiteralPath $project -Recurse -Force; Copy-Item -LiteralPath $keep -Destination $project -Recurse -Force }
    try { $r = Invoke-SgRow SR-T2-replay @{ FAKE_ATTEMPT_PROFILE = 'verified-local'; MOE_CHECK_DISPATCH_PATH = $sgFake; FAKE_CLAIM_MODE = 'finalizing' } }
    finally { $script:VmrSetup = { Initialize-SgFixture } }
    Assert-SrRow $r replay
    # SR-T2-refuse and SR-T2-running (task-9194f182): the same kept project replayed with the
    # finalize lost. Refused: the replay warns 'still finalizing' and continues. Running: the kept
    # attempt reads running, so the replay reaches the CQ-V08b keep and sends no finalize.
    $script:VmrSetup = { Remove-Item -LiteralPath $project -Recurse -Force; Copy-Item -LiteralPath $keep -Destination $project -Recurse -Force }
    try { $r = Invoke-SgRow SR-T2-refuse @{ FAKE_ATTEMPT_PROFILE = 'verified-local'; MOE_CHECK_DISPATCH_PATH = $sgFake; FAKE_CLAIM_MODE = 'finalizing'; FAKE_EVIDENCE_MODE = 'finalize_attempt-refuse' } }
    finally { $script:VmrSetup = { Initialize-SgFixture } }
    Assert-SrRow $r refused
    $script:VmrSetup = {
        Remove-Item -LiteralPath $project -Recurse -Force; Copy-Item -LiteralPath $keep -Destination $project -Recurse -Force
        $af = "$project\.moe\attempts\attempt-postflight.json"; $t = [IO.File]::ReadAllText($af)
        if ([regex]::Matches($t, '"phase":"finalizing"').Count -ne 1) { throw "the kept attempt is not finalizing: $t" }
        [IO.File]::WriteAllText($af, $t.Replace('"phase":"finalizing"', '"phase":"running"'))
    }
    try { $r = Invoke-SgRow SR-T2-running @{ FAKE_ATTEMPT_PROFILE = 'verified-local'; MOE_CHECK_DISPATCH_PATH = $sgFake; FAKE_CLAIM_MODE = 'finalizing' } }
    finally { $script:VmrSetup = { Initialize-SgFixture } }
    Assert-SrRow $r running
    Assert-SrRow (Invoke-SgRow SR-T3 ($strong + @{ FAKE_EVIDENCE_MODE = 'receipt-conflict' })) conflict
    Assert-SrRow (Invoke-SgRow SR-T4 @{ FAKE_EVIDENCE_MODE = 'finalize_attempt-refuse' }) legacy
    Assert-SrRow (Invoke-SgRow SR-T5 ($strong + @{ FAKE_EVIDENCE_MODE = 'receipt-conflict-finalize-lost' })) lost
    Remove-Item -LiteralPath $keep -Recurse -Force -ErrorAction SilentlyContinue
    Copy-Item -LiteralPath $project -Destination $keep -Recurse -Force
    $script:VmrSetup = { Remove-Item -LiteralPath $project -Recurse -Force; Copy-Item -LiteralPath $keep -Destination $project -Recurse -Force }
    try { $r = Invoke-SgRow SR-T5-replay @{ FAKE_ATTEMPT_PROFILE = 'verified-local'; MOE_CHECK_DISPATCH_PATH = $sgFake; FAKE_CLAIM_MODE = 'finalizing'; FAKE_EVIDENCE_MODE = 'receipt-conflict' } }
    finally { $script:VmrSetup = { Initialize-SgFixture } }
    Assert-SrRow $r lost-replay
    # M1-M2 (task-edf2162b): an observe pin whose task's newest attempt record ties at
    # generation 7 as verified-local, so Test-MoeStrongLandingTask journals the landing strong.
    # The finalize keys on that journal, not on the pin. The record is closed, so no
    # open-attempt or finalizing scan reads it.
    Write-Host '[strong receipt] M1, M1-replay, M2: an observe pin with a strong journal finalizes as a strong landing'
    $mixed = @{ FAKE_ATTEMPT_PROFILE = 'observe'; MOE_CHECK_DISPATCH_PATH = $sgFake; FAKE_CHECK_DISPATCH = 'pass' }
    $mixedSetup = {
        Initialize-SgFixture; New-Item -ItemType Directory -Force -Path "$project\.moe\attempts" | Out-Null
        [IO.File]::WriteAllText("$project\.moe\attempts\attempt-tie.json", '{"id":"attempt-tie","taskId":"task-postflight","generation":7,"workerId":"worker-old","phase":"closed","executionPolicySnapshot":{"version":2,"profile":"verified-local","planRevision":1}}')
    }
    $mKeep = "$tempRoot\sr-mkeep"; Remove-Item -LiteralPath $mKeep -Recurse -Force -ErrorAction SilentlyContinue
    $script:VmrSetup = $mixedSetup
    try {
        Assert-SrRow (Invoke-SgRow SR-M1 ($mixed + @{ FAKE_EVIDENCE_MODE = 'receipt-refused' })) deferred
        Copy-Item -LiteralPath $project -Destination $mKeep -Recurse -Force
        $script:VmrSetup = { Remove-Item -LiteralPath $project -Recurse -Force; Copy-Item -LiteralPath $mKeep -Destination $project -Recurse -Force }
        Assert-SrRow (Invoke-SgRow SR-M1-replay @{ FAKE_ATTEMPT_PROFILE = 'observe'; MOE_CHECK_DISPATCH_PATH = $sgFake; FAKE_CLAIM_MODE = 'finalizing' }) replay
        $script:VmrSetup = $mixedSetup
        Assert-SrRow (Invoke-SgRow SR-M2 $mixed) pass
    } finally { $script:VmrSetup = { Initialize-SgFixture } }
    Write-Host '[strong receipt] ok T1, T2, T2-replay, T2-refuse, T2-running, T3, T4, T5, T5-replay, M1, M1-replay, M2'
}
function Test-SgvRow([string]$Row, [int]$Rc, [string]$Want, [byte[]]$Bytes) {
    $file = "$tempRoot\sgv.reply"; [IO.File]::WriteAllBytes($file, $Bytes)
    $got = @(Get-MoeCheckDispatchVerdict $file $Rc 'task-v' 'cand-v')
    if ($got.Count -ne 1 -or $got[0] -cne $Want) { throw "VM ROUTE FAILED ([strong gate] $Row): got '$($got -join ',')', expected '$Want'" }
}
# SGV: Get-MoeCheckDispatchVerdict returns PASS or one fixed code, never the reply (sh's
# table, plus R's round-2 D and E rows, ported from their descriptions, and V-missing).
function Invoke-SgvRows {
    $bad = 'MOE_CHECK_DISPATCH_REPLY_INVALID'; $id = $sgEnvId; $nl = "`n"
    $pass = '{"taskId":"task-v","candidateId":"cand-v","results":[{"command":"qualityGate","dispatchId":"dispatch-v","outcome":"passed","vm":"deleted","failure":null}]}'
    $stopEnv = { param($e) '{"taskId":"task-v","candidateId":"cand-v","results":[],"stopped":{"code":"RUNNER_ENVIRONMENT_NOT_APPROVED","environment":' + $e + '}}' + "`n" }
    $rows = @(@('V-empty', 0, 'MOE_CHECK_DISPATCH_NO_REPORT', ''), @('V-empty-rc3', 3, 'MOE_CHECK_DISPATCH_NO_REPORT', ''), @('V-not-json', 0, $bad, "not json$nl"),
        @('V-array', 0, $bad, "[1]$nl"), @('V-pass', 0, 'PASS', "$pass$nl"), @('V-pass-bare', 0, 'PASS', $pass), @('V-pass-rc2', 2, 'MOE_CHECK_DISPATCH_NOT_PASSED', "$pass$nl"),
        @('V-two-newlines', 0, $bad, "$pass$nl$nl"), @('V-results-object', 0, $bad, ('{"taskId":"task-v","candidateId":"cand-v","results":{"outcome":"passed"}}' + $nl)),
        @('V-other-candidate', 0, $bad, ($pass.Replace('cand-v', 'cand-other') + $nl)), @('V-other-task', 0, $bad, ($pass.Replace('task-v', 'task-other') + $nl)),
        @('V-no-results', 0, $bad, ('{"taskId":"task-v","candidateId":"cand-v","results":[]}' + $nl)), @('V-log-line', 0, $bad, "dispatch log$nl$pass$nl"),
        @('V-indented', 0, $bad, ($pass.Replace(',"candidateId"', ",$nl`"candidateId`"") + $nl)), @('V-crlf', 0, $bad, "$pass`r$nl"),
        @('V-stop-beats-rc0', 0, 'RUNNER_NOTHING_OWED', ('{"taskId":"task-v","candidateId":"cand-v","results":[],"stopped":{"code":"RUNNER_NOTHING_OWED"}}' + $nl)),
        @('V-stop-lower', 2, $bad, ('{"stopped":{"code":"lower case"}}' + $nl)), @('V-code', 2, 'RUNNER_SEAM_UNAVAILABLE', ('{"code":"RUNNER_SEAM_UNAVAILABLE"}' + $nl)),
        @('V-code-bad', 2, $bad, ('{"code":"bad code"}' + $nl)), @('V-stop-and-code', 2, 'RUNNER_CHECK_FAILED', ('{"code":"RUNNER_SEAM_UNAVAILABLE","stopped":{"code":"RUNNER_CHECK_FAILED"}}' + $nl)),
        @('V-env', 2, "RUNNER_ENVIRONMENT_NOT_APPROVED environment=$id", (& $stopEnv "`"$id`"")),
        @('V-at-limit', 0, 'PASS', ($pass + (' ' * (1048575 - $pass.Length)) + $nl)), @('V-oversize', 0, $bad, ($pass + (' ' * (1048576 - $pass.Length)) + $nl)))
    foreach ($e in @("`"x$id`"", "`"$id\n`"", "`"$sgEnvUpper`"", "`"moe-local-vm-v1:$($sgHex.Substring(1))`"", '7', 'null')) {
        $rows += , @("V-env-malformed $e", 2, 'RUNNER_ENVIRONMENT_NOT_APPROVED', (& $stopEnv $e))
    }
    foreach ($r in $rows) {
        if ($r.Count -ne 4) { throw "harness: SGV row $($r[0]) has $($r.Count) fields, not 4" }   # a bare + in a row splices the array
        Test-SgvRow $r[0] $r[1] $r[2] ([Text.Encoding]::UTF8.GetBytes($r[3]))
    }
    Test-SgvRow V-not-utf8 0 $bad ([byte[]](0xFF, 0x0A))
    $got = Get-MoeCheckDispatchVerdict "$tempRoot\sgv-absent.reply" 0 'task-v' 'cand-v'
    if ($got -cne 'MOE_CHECK_DISPATCH_NO_REPORT') { throw "VM ROUTE FAILED ([strong gate] V-missing): got '$got'" }
}
# Invoke-SguRow ROW EXPECTED [SET [REL [PROTECTED [GRACE]]]] -- run_check_dispatch's
# twin in process; the last output line must be EXPECTED, and the credentials restored.
function Invoke-SguRow([string]$Row, [string]$Want, [hashtable]$Set = @{}, [string]$Rel = '', [bool]$Protected = $false, [int]$Grace = 120) {
    Remove-Item -LiteralPath $sguEv -ErrorAction SilentlyContinue
    $err = New-Object IO.StringWriter; $prevErr = [Console]::Error; $text = @()
    foreach ($k in $Set.Keys) { Set-Item -LiteralPath "Env:\$k" -Value $Set[$k] }
    try {
        [Console]::SetError($err); $script:MoeRuntimeProtected = $Protected; $script:CheckDispatchGraceSec = $Grace
        $text = @(& { Resolve-MoeCheckDispatchCli; $ok = Invoke-MoeCheckDispatch @{ Rel = $Rel } $sguFrozen; "rc=$([int](-not $ok)) code=$script:CheckDispatchCode" } 6>&1 | ForEach-Object { "$_" })
    } finally {
        [Console]::SetError($prevErr); $script:MoeRuntimeProtected = $false
        foreach ($k in $Set.Keys) { Remove-Item -LiteralPath "Env:\$k" -ErrorAction SilentlyContinue }
    }
    $script:SguOut = @($text) + @($err.ToString() -split '\r?\n' | Where-Object { $_ })
    if ($text[-1] -cne $Want) { throw "VM ROUTE FAILED ([strong gate] $Row): got '$($text[-1])', expected '$Want': $($script:SguOut -join ' | ')" }
    foreach ($n in $vmjCredentials) { if ([Environment]::GetEnvironmentVariable($n) -cne "outer-$n") { throw "VM ROUTE FAILED ([strong gate] $Row): $n not restored" } }
}
function Get-SguCount([string]$Line) { return @($script:SguOut | Where-Object { $_ -ceq $Line }).Count }
# Assert-SguDispatch ROW ENTRY [STOPPED] -- exactly one dispatch ran, from ENTRY, on the frozen commit, with no credential and a
# rooted --stop-file absent at its start and after; one stop row from it when STOPPED, else none, and never a term row; its pid.
function Assert-SguDispatch([string]$Row, [string]$Entry, [bool]$Stopped = $false) {
    $rows = @(Read-VmeJsonl $sguEv); $d = @($rows | Where-Object { $_.tool -ceq 'check-dispatch' }); $sf = if ($d.Count) { "$($d[0].args.argv[7])" } else { '' }
    $stops = @($rows | Where-Object { $_.tool -ceq 'check-dispatch-stop' } | ForEach-Object { "$($_.args.pid)" }) -join ','
    if ($d.Count -ne 1 -or $d[0].args.entry -cne $Entry -or @($d[0].args.credentials).Count -or $d[0].args.candidateId -cne 'cand-sgu' -or
        ($d[0].args.argv -join "`n") -cne (@('--project', $sguProject, '--task', 'task-sgu', '--commit', $sguC, '--stop-file', $sf) -join "`n") -or
        -not [IO.Path]::IsPathRooted($sf) -or (Test-Path -LiteralPath $sf) -or $d[0].args.stopAtStart -isnot [bool] -or $d[0].args.stopAtStart -or
        $stops -cne $(if ($Stopped) { "$($d[0].args.pid)" } else { '' }) -or (Get-SguTerms) -ne 0) { throw "VM ROUTE FAILED ([strong gate] $Row): stop rows '$stops', $(Get-SguTerms) TERMs, dispatch rows $(ConvertTo-Json $d -Compress -Depth 5)" }
    return (Get-SguPid)
}
function Get-SguPid { return [int]@(Read-VmeJsonl $sguEv | Where-Object { $_.tool -ceq 'check-dispatch' })[0].args.pid }
function Get-SguTerms { return @(Read-VmeJsonl $sguEv | Where-Object { $_.tool -ceq 'check-dispatch-term' }).Count }
# Wait-SguDispatch -- until the fake's row exists (bounded), so a stop lands mid-dispatch.
function Wait-SguDispatch([string]$Row) {
    for ($i = 0; $i -lt 300 -and -not @(Read-VmeJsonl $sguEv | Where-Object { $_.tool -ceq 'check-dispatch' }).Count; $i++) { Start-Sleep -Milliseconds 100 }
    if (-not @(Read-VmeJsonl $sguEv | Where-Object { $_.tool -ceq 'check-dispatch' }).Count) { throw "VM ROUTE FAILED ([strong gate] $Row): the dispatch never started" }
}
function Invoke-SguRows {
    Write-Host '[strong gate] SGU: Invoke-MoeCheckDispatch in process: the bundled CLI, the override, the bound, the stop, the project top'
    Invoke-SguRow U1 'rc=1 code=RUNNER_SEAM_UNAVAILABLE' @{ FAKE_CHECK_DISPATCH = 'code'; FAKE_CHECK_DISPATCH_CODE = 'RUNNER_SEAM_UNAVAILABLE' }
    $null = Assert-SguDispatch U1 $sguStub; if ($script:SguOut -match 'MOE_CHECK_DISPATCH_PATH_IGNORED') { throw 'VM ROUTE FAILED ([strong gate] U1): an IGNORED line without an override' }
    Invoke-SguRow U2 'rc=0 code=' @{ MOE_CHECK_DISPATCH_PATH = $sgFake; FAKE_CHECK_DISPATCH = 'pass' }
    $null = Assert-SguDispatch U2 $sgFake; if ((Get-SguCount '[OK] check VMs passed every owed check of candidate cand-sgu.') -ne 1) { throw 'VM ROUTE FAILED ([strong gate] U2): not one [OK] line' }
    Invoke-SguRow U3 'rc=0 code=' @{ MOE_CHECK_DISPATCH_PATH = $sgFake; FAKE_CHECK_DISPATCH = 'pass' } '' $true
    $null = Assert-SguDispatch U3 $sguStub
    if (@($script:SguOut -match 'MOE_CHECK_DISPATCH_PATH_IGNORED').Count -ne 1 -or (Get-SguCount $sgIgnored) -ne 1 -or ($script:SguOut -join "`n").Contains($sgFake)) { throw 'VM ROUTE FAILED ([strong gate] U3): not exactly one IGNORED line, or the override path printed' }
    foreach ($bound in @('0', '-1', 'abc', '86401', '1.0001')) {
        Invoke-SguRow "U4 $bound" 'rc=1 code=MOE_CHECK_DISPATCH_TIMEOUT_INVALID' @{ MOE_CHECK_DISPATCH_TIMEOUT_SEC = $bound; FAKE_CHECK_DISPATCH = 'pass' }
        if (Test-Path -LiteralPath $sguEv) { throw "VM ROUTE FAILED ([strong gate] U4 $bound): the dispatch ran" }
    }
    $clock = [Diagnostics.Stopwatch]::StartNew()
    Invoke-SguRow U5 'rc=1 code=MOE_CHECK_DISPATCH_TIMEOUT' @{ MOE_CHECK_DISPATCH_TIMEOUT_SEC = '1'; FAKE_CHECK_DISPATCH = 'hang-hard' } '' $false 1
    Assert-SgDead U5 (Assert-SguDispatch U5 $sguStub $true)
    if ($clock.Elapsed.TotalSeconds -gt 15 -or (Get-SguTerms) -ne 0) { throw "VM ROUTE FAILED ([strong gate] U5): $([int]$clock.Elapsed.TotalSeconds)s and $(Get-SguTerms) TERMs, expected at most 15 s and none" }
    # U8: a dispatch that honours the stop exits by itself: its stop row comes 1 s after it saw the file, so no kill came first, and well inside the 30 s grace.
    $clock = [Diagnostics.Stopwatch]::StartNew()
    Invoke-SguRow U8 'rc=1 code=MOE_CHECK_DISPATCH_TIMEOUT' @{ MOE_CHECK_DISPATCH_TIMEOUT_SEC = '1'; FAKE_CHECK_DISPATCH = 'hang' } '' $false 30
    Assert-SgDead U8 (Assert-SguDispatch U8 $sguStub $true)
    if ($clock.Elapsed.TotalSeconds -ge 15) { throw "VM ROUTE FAILED ([strong gate] U8): $([int]$clock.Elapsed.TotalSeconds)s, expected under 15 s (the wrapper waited out the grace)" }
    Invoke-SguRow U6 'rc=1 code=MOE_WORKTREE_PROJECT_NOT_TOP' @{ FAKE_CHECK_DISPATCH = 'pass' } 'sub'
    if ((Test-Path -LiteralPath $sguEv) -or (Get-SguCount '[WARN] MOE_WORKTREE_PROJECT_NOT_TOP: a worktree-mode qualityGate needs the project at the repository top; refusing branch commit.') -ne 1) { throw 'VM ROUTE FAILED ([strong gate] U6): the dispatch ran, or not one NOT_TOP line' }
    Invoke-SguStopRows
}
# U7: a runspace Stop() mid-dispatch, the PipelineStoppedException a Ctrl+C raises: the
# invoker's finally creates the stop file, waits the grace, ends the fake and clears the record.
# U9: a Stop() inside the timeout's grace interrupts that stop before it clears the record,
# so the invoker's finally stops the fake again. SG-interrupt: the outer
# finally line (the twin of sh's EXIT-trap stop) sits right after Stop-MoeGateChild and
# stops a still-recorded dispatch by itself.
function Invoke-SguStopRows {
    Remove-Item -LiteralPath $sguEv -ErrorAction SilentlyContinue; $done = "$sgu\u7.done"; $env:FAKE_CHECK_DISPATCH = 'hang-hard'; $env:MOE_CHECK_DISPATCH_TIMEOUT_SEC = '60'
    $body = "param(`$P, `$F, `$Fz, `$Done, `$Grace)`n$sgDefs`n" + @'
$projectPath = $P; $preflightTaskId = 'task-sgu'; $script:MoeNode = $null; $script:CheckDispatchCli = $F; $script:CheckDispatchGraceSec = $Grace; $script:CheckDispatchProcess = $null
try { Invoke-MoeCheckDispatch @{ Rel = '' } $Fz } finally { [IO.File]::WriteAllText($Done, "record=$([bool]$script:CheckDispatchProcess)") }
'@
    $ps = [powershell]::Create()
    try {
        $null = $ps.AddScript($body).AddArgument($sguProject).AddArgument($sgFake).AddArgument($sguFrozen).AddArgument($done).AddArgument(3)
        $h = $ps.BeginInvoke(); Wait-SguDispatch U7
        $clock = [Diagnostics.Stopwatch]::StartNew(); $ps.Stop(); $took = $clock.Elapsed.TotalSeconds
        Assert-SgDead U7 (Assert-SguDispatch U7 $sgFake $true)
        $rec = if (Test-Path -LiteralPath $done) { [IO.File]::ReadAllText($done) } else { 'no finally' }
        if ($took -lt 2.5 -or $took -gt 20 -or $rec -cne 'record=False' -or (Get-SguTerms) -ne 0) { throw "VM ROUTE FAILED ([strong gate] U7): stop took $([int]$took)s, $rec, $(Get-SguTerms) TERMs; expected the 3 s grace, record=False and none" }
    } finally { $ps.Dispose() }
    Remove-Item -LiteralPath $sguEv, $done -ErrorAction SilentlyContinue; $env:MOE_CHECK_DISPATCH_TIMEOUT_SEC = '1'
    $ps = [powershell]::Create()
    try {
        $null = $ps.AddScript($body).AddArgument($sguProject).AddArgument($sgFake).AddArgument($sguFrozen).AddArgument($done).AddArgument(5)
        $h = $ps.BeginInvoke()
        for ($i = 0; $i -lt 300 -and -not @(Read-VmeJsonl $sguEv | Where-Object { $_.tool -ceq 'check-dispatch-stop' }).Count; $i++) { Start-Sleep -Milliseconds 100 }
        $ps.Stop()
        Assert-SgDead U9 (Assert-SguDispatch U9 $sgFake $true)
        $rec = if (Test-Path -LiteralPath $done) { [IO.File]::ReadAllText($done) } else { 'no finally' }
        if ($rec -cne 'record=False') { throw "VM ROUTE FAILED ([strong gate] U9): a Stop() in the timeout's grace left $rec, expected record=False" }
    } finally { $ps.Dispose() }
    $lines = [IO.File]::ReadAllLines($wrapper)
    $g = @('    try { Stop-MoeGateChild } catch {}', '    try { Stop-MoeCheckDispatch $script:CheckDispatchGraceSec } catch {}', '    try { Invoke-MoeTeardownRescue } catch {}', '    try { Complete-MoePostflight | Out-Null } catch {}')
    $at = @(foreach ($l in $g) { $hit = @(for ($i = 0; $i -lt $lines.Count; $i++) { if ($lines[$i] -ceq $l) { $i } }); if ($hit.Count -eq 1) { $hit[0] } else { -1 } })
    if ($at[0] -lt 0 -or ($at -join ',') -cne (@(0..3 | ForEach-Object { $at[0] + $_ }) -join ',')) { throw "VM ROUTE FAILED ([strong gate] SG-interrupt): outer finally lines at $($at -join ','), expected four consecutive, each once" }
    Remove-Item -LiteralPath $sguEv -ErrorAction SilentlyContinue
    $script:CheckDispatchProcess = Start-Process -FilePath node -ArgumentList (ConvertTo-MoeArgumentLine @($sgFake, '--project', $sguProject, '--task', 'task-sgu', '--commit', $sguC)) -RedirectStandardOutput "$sgu\g.out" -RedirectStandardError "$sgu\g.err" -NoNewWindow -PassThru
    $script:CheckDispatchGraceSec = 1; Wait-SguDispatch SG-interrupt
    & ([scriptblock]::Create($g[1].Trim()))
    Assert-SgDead SG-interrupt (Get-SguPid)
    if ($script:CheckDispatchProcess -or @(Read-VmeJsonl $sguEv | Where-Object { $_.tool -ceq 'check-dispatch-stop' }).Count) { throw 'VM ROUTE FAILED ([strong gate] SG-interrupt): the outer finally kept the record, or a dispatch with no stop file wrote a stop row' }
    Remove-Item Env:\FAKE_CHECK_DISPATCH, Env:\MOE_CHECK_DISPATCH_TIMEOUT_SEC
}
# SG8: L6 takes the check VMs only for the strong profile, and before the legacy gate and the intent rule.
function Test-Sg8 {
    $fn = [Management.Automation.Language.Parser]::ParseFile($wrapper, [ref]$null, [ref]$null).Find({ param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq 'Invoke-MoeWorktreeRounds' }, $false)
    $lines = @("$($fn.Extent.Text)" -split '\r?\n')
    $at = { param($l, [bool]$Part) $hit = @(for ($i = 0; $i -lt $lines.Count; $i++) { if (($Part -and $lines[$i].Contains($l)) -or $lines[$i] -ceq $l) { $i } }); if ($hit.Count -eq 1) { $hit[0] } else { -1 } }
    $order = @((& $at '        if ($Settings.configuredGate -and $preflightTaskId -and (Test-MoeStrongLandingTask $preflightTaskId $Git.GitDir)) {'), (& $at 'Invoke-MoeCheckDispatch' $true),
        (& $at '        } elseif ($Settings.configuredGate) {'), (& $at 'Invoke-MoeFrozenGate' $true),
        (& $at '        if (-not (Test-MoeWorktreeStrongIntent $m $b $(if ($Settings.configuredGate) { $frozen } else { $null }) $Git.GitDir $Res $L)) { return $false }'))
    if ($order -contains -1 -or (& $at 'Test-MoeStrongLandingTask' $true) -ne $order[0] -or ($order -join ',') -cne (@($order | Sort-Object) -join ',')) {
        throw "VM ROUTE FAILED ([strong gate] SG8): strong, dispatch, legacy, gate, intent at lines $($order -join ','), expected that order, each exactly once"
    }
}
function Invoke-SgSections {
    $saved = @{}; Get-ChildItem Env: | ForEach-Object { $saved[$_.Name] = $_.Value }
    $vmjCredentials = @('ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'OPENAI_API_KEY', 'CODEX_API_KEY')
    $vmjToken = 'sk-ant-oat01-vmCanaryMustNeverEscapePipes0123456789'; $ready = '{"profile":"verified-local","ready":true,"missingCapabilities":[]}'
    $sgFake = Join-Path $root 'scripts\tests\postflight-fake-check-dispatch.js'; $sgWitness = "$tempRoot\sg-witness"; $sgHex = '0123456789abcdef' * 4
    $sgEnvId = "moe-local-vm-v1:$sgHex"; $sgEnvUpper = "moe-local-vm-v1:$($sgHex.ToUpperInvariant())"
    $sgIgnored = '[WARN] MOE_CHECK_DISPATCH_PATH_IGNORED: MOE_CHECK_DISPATCH_PATH is ignored under MOE_RUNTIME_PROTECTED=1; only the bundled local-runner/check-dispatch.mjs runs.'
    $names = @('Resolve-MoeCheckDispatchCli', 'Find-MoeReplyKey', 'Get-MoeCheckDispatchVerdict', 'Stop-MoeCheckDispatch', 'Invoke-MoeCheckDispatchChild', 'Invoke-MoeCheckDispatch', 'Get-MoeLandLeaseBudget', 'ConvertTo-MoeArgumentLine')
    $sgDefs = (@([Management.Automation.Language.Parser]::ParseFile($wrapper, [ref]$null, [ref]$null).FindAll({ param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -cin $names }, $false) | ForEach-Object { $_.Extent.Text }) -join "`n")
    . ([scriptblock]::Create($sgDefs))
    $sgu = "$tempRoot\sgu"; $sguProject = "$sgu\project"; $sguEv = "$sguProject\.moe\evidence-rpcs.jsonl"; $sguStub = "$sgu\scripts\local-runner\check-dispatch.mjs"
    try {
        Copy-Item (Join-Path $root 'scripts\tests\postflight-fake-agent-seat.js') "$tempRoot\seat.cjs"
        [IO.File]::WriteAllText("$tempRoot\sg.gitconfig", "[user]`n name = sg`n email = sg@example.invalid`n[core]`n autocrlf = false`n")
        $env:MOE_AGENT_SEAT_PATH = "$tempRoot\seat.cjs"; $env:MOE_ACCOUNT_ROTATION = 'on'; $env:MOE_ACCOUNTS_FILE = "$tempRoot\accounts\claude-accounts.json"; $env:FAKE_ACCOUNT_HOME = "$tempRoot\accounts"
        $env:GIT_CONFIG_GLOBAL = "$tempRoot\sg.gitconfig"; $env:GIT_CONFIG_NOSYSTEM = '1'; $env:PATH = "$tempRoot;$env:PATH"; $env:SGU_FAKE = $sgFake
        foreach ($n in $vmjCredentials) { Set-Item "Env:\$n" "outer-$n" }
        New-Item -ItemType Directory -Force -Path "$sguProject\.moe\candidates", (Split-Path $sguStub) | Out-Null
        [IO.File]::WriteAllText("$sguProject\a.txt", "sgu`n"); foreach ($g in @(@('init', '-q'), @('add', 'a.txt'), @('commit', '-qm', 'sgu'))) { Invoke-VmcGit $sguProject $g | Out-Null }
        $sguC = Invoke-VmcGit $sguProject @('rev-parse', 'HEAD'); $sguFrozen = @{ CandidateId = 'cand-sgu'; Commit = $sguC }
        [IO.File]::WriteAllText("$sguProject\.moe\candidates\cand-sgu.json", ('{"id":"cand-sgu","taskId":"task-sgu","treeSha":"' + (Invoke-VmcGit $sguProject @('rev-parse', 'HEAD^{tree}')) + '","createdAt":"2026-11-04T00:00:00.000Z"}'))
        [IO.File]::WriteAllText($sguStub, "import { createRequire } from 'node:module';`ncreateRequire(import.meta.url)(process.env.SGU_FAKE);`n")
        $script:MoeScriptRoot = "$sgu\scripts"; $script:MoeNode = $null; $script:CheckDispatchProcess = $null; $projectPath = $sguProject; $preflightTaskId = 'task-sgu'
        Invoke-SgvRows; Invoke-SguRows; Test-Sg8
        Write-Host '[strong gate] ok SGV, SGU U1-U9, SG8 and SG-interrupt'
        $script:VmrSetup = { Initialize-SgFixture }; $script:VmjWorkspace = 'worktree'
        Invoke-SgRows; Invoke-SrRows
    } finally {
        $script:VmrSetup = $null; $script:MoeScriptRoot = $null; $script:MoeRuntimeProtected = $false
        if ($script:CheckDispatchProcess) { try { & taskkill /T /F /PID $script:CheckDispatchProcess.Id 2>&1 | Out-Null } catch {}; $script:CheckDispatchProcess = $null }
        Get-ChildItem Env: | Where-Object { -not $saved.ContainsKey($_.Name) } | Remove-Item
        foreach ($n in $saved.Keys) { Set-Item "Env:\$n" $saved[$n] }
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
const e = process.env;
if (cli === 'claude' && e.FAKE_RENEW_FILE && argv.includes('-p') && argv.includes('--tools')) {
  // [seat sign-in] renewal: rewrite the account's .credentials.json from that file's
  // {accessToken, refreshToken}, 8 h left, as claude's refresh would; log renew.jsonl
  // beside the record and never write the record (no task CLI ran).
  const d = e.CLAUDE_CONFIG_DIR;
  fs.writeFileSync(d + '/.credentials.json', JSON.stringify({claudeAiOauth: {...JSON.parse(fs.readFileSync(e.FAKE_RENEW_FILE, 'utf8')),
    expiresAt: Date.now() + 288e5, scopes: ['user:inference'], subscriptionType: 'max'}}));
  fs.appendFileSync(require('node:path').dirname(RECORD) + '/renew.jsonl', JSON.stringify({argv, cwd: process.cwd(), configDir: d,
    hasMoeWorkerId: 'MOE_WORKER_ID' in e, hasPluginDirs: 'CLAUDE_CODE_PLUGIN_DIRS' in e}) + '\n');
} else if (cli !== 'normalize') {
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
    Invoke-SgSections
    $legacy = '{"profile":"legacy","ready":true,"missingCapabilities":[],"evaluatedAt":"2026-11-01T00:00:00.000Z"}'
    $r = Invoke-VmrRow T-legacy worker claude $legacy '-'; Assert-VmrLaunched $r
    if (@(Get-Content "$project\.moe\evidence-rpcs.jsonl" | ForEach-Object { $_ | ConvertFrom-Json } | Where-Object { $_.tool -eq 'claim_next_task' -and $_.args.PSObject.Properties.Name -contains 'executionRoute' }).Count) { Stop-Vmr $r 'legacy claim marked vm' }
    $raw = Get-Content -Raw -LiteralPath $rec | ConvertFrom-Json
    $context = if (Test-Path -LiteralPath "$rec.context") { [IO.File]::ReadAllText("$rec.context") } else { '' }
    if ((-not ($raw.argv -match 'task-postflight') -and -not $context.Contains('task-postflight')) -or $raw.env.MOE_WORKER_ID -cne 'worker-vmr') { Stop-Vmr $r 'record lacks task and worker identity' }
    # The launch's own usage receipt, printed with only timestamp and launchId masked
    # (the before/after evidence of task-cd3887fe), then pinned: the wrapper's pending
    # and missing rows land, and the CLI never inherits the receipt pair.
    $receiptFiles = @(Get-ChildItem -LiteralPath (Join-Path $project 'logs\moe-usage') -Filter '*.jsonl' -File -ErrorAction SilentlyContinue)
    if ($receiptFiles.Count -ne 1) { Stop-Vmr $r "expected one usage receipt file, saw $($receiptFiles.Count)" }
    $receiptLines = @([IO.File]::ReadAllLines($receiptFiles[0].FullName) | Where-Object { $_ })
    Write-Host ('[vm route] T-legacy usage receipt: ' + (@($receiptLines | ForEach-Object { $_ -replace '"timestamp":"[^"]*"', '"timestamp":"<ts>"' -replace '"launchId":"[^"]*"', '"launchId":"<launch>"' }) -join ' | '))
    $receiptRows = @($receiptLines | ForEach-Object { $_ | ConvertFrom-Json })
    if ($receiptRows.Count -ne 2) { Stop-Vmr $r "expected 2 receipt rows, saw $($receiptRows.Count)" }
    $coverage = @($receiptRows | ForEach-Object { $_.coverage }) -join ','
    if ($coverage -cne 'pending,missing') { Stop-Vmr $r "receipt coverage is $coverage, expected pending,missing" }
    if (-not $receiptRows[0].launchId -or $receiptRows[1].launchId -cne $receiptRows[0].launchId) { Stop-Vmr $r 'the receipt rows do not share one launchId' }
    $want = [ordered]@{ provider = 'claude'; taskId = 'task-postflight'; workerId = 'worker-vmr'; role = 'worker'; launchMode = 'headless' }
    foreach ($row in $receiptRows) { foreach ($k in $want.Keys) { if ($row.$k -cne $want[$k]) { Stop-Vmr $r "receipt $k is $($row.$k), expected $($want[$k])" } } }
    foreach ($k in @('MOE_USAGE_RECEIPT_FILE', 'MOE_USAGE_CONTEXT_JSON')) { if ($raw.env.PSObject.Properties.Name -contains $k) { Stop-Vmr $r "the CLI env carries $k" } }
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
