param([string]$Case = '')
# Drill: one landing records at most one failed moe.record_commit row, as the sh
# twin's run_landing does (task-4fdc7590). Invoke-MoeLanding is loaded from the
# wrapper by AST (the hooked-commit.ps1 pattern) and every collaborator that
# touches git, the daemon or a gate is a stub below. The real Invoke-MoeLanding,
# Get-MoeRecordHeldFields, Get-MoeHeldList, Read-MoeBaseline and
# Stop-MoeGateChild run, so the finally block's fallback and the held fields of
# the row it sends are exercised as shipped. No wrapper launch, daemon, model,
# network or git process runs.
$ErrorActionPreference = 'Stop'
$tokens = $null; $parseErrors = $null
$wrapper = Join-Path $PSScriptRoot '../moe-agent.ps1'
$ast = [System.Management.Automation.Language.Parser]::ParseFile($wrapper, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw 'wrapper parse failed' }
foreach ($statement in $ast.EndBlock.Statements) {
    if ($statement -is [System.Management.Automation.Language.FunctionDefinitionAst]) {
        . ([scriptblock]::Create($statement.Extent.Text))
    }
}
if (-not (Get-Command Invoke-MoeLanding -ErrorAction SilentlyContinue)) {
    Write-Host 'FAIL landing-ledger: production-function-missing'
    Write-Host 'landing-ledger.ps1: 0 passed, 1 failed'
    exit 1
}
$script:MoeCaseFoldPaths = ($env:OS -eq 'Windows_NT')
$script:myPid = $PID
$script:Rows = New-Object 'System.Collections.Generic.List[hashtable]'
$script:Rescues = New-Object 'System.Collections.Generic.List[string]'
$script:CheckRuns = 0
$script:CaseAttr = $null
$script:CaseMode = ''

# ---- stubs: defined AFTER the load loop so they replace the production ones.
# Each declares every parameter name its call sites pass, and none writes to the
# pipeline (List[T].Add returns void), so Invoke-MoeLanding still returns one
# hashtable.
function Get-MoeOwnerGuard { param($TaskId, $Sid) return @{ Code = ''; Detail = ''; Scope = @{ Title = 'Ledger drill' } } }
function Get-MoeDirtySnapshot { param($Top) if ($script:CaseMode -eq 'status-failure') { return $null }; return @{} }
function Resolve-MoeAttribution {
    param($Git, $S, $B, $U, $Tool, $Scope, $Settings, $TaskId, $Mode, $PolicyOverride, $Evidence, $PreflightDirty)
    return $script:CaseAttr
}
function Ensure-MoeSafeBranch {
    param($Top, $Settings)
    if ($script:CaseMode -eq 'throw') { throw 'drill: the branch peel threw' }
    if ($script:CaseMode -eq 'gate-exception') {
        # The gate child is started and not yet recorded when the exception hits.
        $script:MoeGate = @{ Started = $true; Finished = $false; Process = $null; Recorded = $false }
        throw 'drill: an exception while the gate child runs'
    }
    return ''
}
# Nothing to park, as for an empty candidate list or an unchanged tree.
function Invoke-MoeRescueRef { param($Git, $TaskId, $Reason, $Title, $Status, $Sid, $Attr, $Sha, $Scope) $script:Rescues.Add([string]$Reason); return $null }
function Send-MoeRecordCommit { param($Record) $script:Rows.Add($Record); return @{ success = $true } }
function Push-MoeBranch { param($Top, $Branch, $Kind, $TaskId) return $false }
function Write-MoeBaseline { return $true }
function Send-MoeCheckRun { param($Frozen, $Gate) $script:CheckRuns++; return $true }
function Remove-MoeGateWorkspace { $script:MoeGate = $null; return $true }

function New-DrillAttr([int]$Candidates) {
    $cands = @()
    if ($Candidates -gt 0) { $cands = @(@{ Path = 'owned.txt'; Reason = 'ASSERTED'; Inferred = $false }) }
    return @{
        Candidates = $cands
        Skipped = @(@{ Path = 'held.txt'; Code = 'MOE_ATTR_CONTESTED' })
        Contested = @(@{ Path = 'held.txt'; TaskId = 'task-peer' })
        Unattributed = @(); Missing = @(); Own = @{}
        ForeignCount = 0; ExcludedCount = 0; AssertedForeignCount = 0; PlannedCount = 0; ToolCount = 0
        AssertedCount = $Candidates
    }
}
function Assert-Drill([bool]$Condition, [string]$Detail) { if (-not $Condition) { throw $Detail } }
function Assert-HeldFields($Row) {
    $sk = @($Row.skipped); $ct = @($Row.contested)
    Assert-Drill ($sk.Count -eq 1 -and $sk[0].path -ceq 'held.txt' -and $sk[0].code -ceq 'MOE_ATTR_CONTESTED') 'row lacks the held skipped entry'
    Assert-Drill ($ct.Count -eq 1 -and $ct[0].path -ceq 'held.txt' -and $ct[0].taskId -ceq 'task-peer') 'row lacks the held contested entry'
}

# Expected: the exact outcome/code/kind row sequence, the rescue reasons in
# order, the check-run sends, the result Code and StopLoop ($null: unasserted),
# and whether every row carries the held fields.
$cases = @(
    @{ Name = 'no-candidate-peel'; Mode = 'peel'; Candidates = 0; Rows = 'failed/MOE_COMMIT_FAILED_PEEL/completion'; Rescues = 'peel-failed'
       Checks = 0; Code = 'MOE_COMMIT_FAILED_PEEL'; StopLoop = $true; Held = $true }
    @{ Name = 'candidates-peel'; Mode = 'peel'; Candidates = 1; Rows = 'failed/MOE_COMMIT_FAILED_PEEL/completion'; Rescues = 'peel-failed'
       Checks = 0; Code = 'MOE_COMMIT_FAILED_PEEL'; StopLoop = $true; Held = $true }
    @{ Name = 'throw-after-attribution'; Mode = 'throw'; Candidates = 1; Rows = 'failed/MOE_COMMIT_FAILED/completion'; Rescues = 'commit-failed'
       Checks = 0; Code = 'MOE_COMMIT_FAILED'; StopLoop = $true; Held = $true }
    @{ Name = 'mid-gate-exception'; Mode = 'gate-exception'; Candidates = 1; Rows = 'failed/MOE_COMMIT_FAILED_GATE/completion'; Rescues = 'teardown'
       Checks = 1; Code = 'MOE_COMMIT_FAILED_GATE'; StopLoop = $true; Held = $true }
    @{ Name = 'status-failure'; Mode = 'status-failure'; Candidates = 1; Rows = 'failed/MOE_COMMIT_FAILED_ATTRIBUTION/completion'; Rescues = ''
       Checks = 0; Code = 'MOE_COMMIT_FAILED_ATTRIBUTION'; StopLoop = $null; Held = $false }
)

$passed = 0
$failures = New-Object 'System.Collections.Generic.List[string]'
$fixtureRoot = Join-Path ([IO.Path]::GetTempPath()) ('moe-landing-ledger-' + [guid]::NewGuid().ToString('N'))
try {
    New-Item -ItemType Directory -Path $fixtureRoot | Out-Null
    $git = @{ Top = $fixtureRoot; GitDir = (Join-Path $fixtureRoot '.git'); Rel = '' }
    foreach ($c in $cases) {
        if ($Case -and $c.Name -notlike $Case) { continue }
        try {
            $script:Rows.Clear(); $script:Rescues.Clear(); $script:CheckRuns = 0
            $script:MoeGate = $null; $script:MoeFrozen = $null
            $script:CaseMode = $c.Mode; $script:CaseAttr = New-DrillAttr $c.Candidates
            $r = Invoke-MoeLanding -Kind completion -TaskId 'task-drill' -Git $git -Settings @{} -Status 'REVIEW' -Sid 'sess-drill' 6>$null
            Assert-Drill ($r -is [hashtable]) 'result is not a single hashtable (a stub wrote to the pipeline?)'
            # Not $rows/$rescues: variable names are case-insensitive, so those
            # would overwrite $script:Rows/$script:Rescues.
            $gotRows = (@($script:Rows | ForEach-Object { "$($_.outcome)/$($_.code)/$($_.kind)" }) -join ';')
            Assert-Drill ($gotRows -ceq $c.Rows) "ledger rows [$gotRows], want [$($c.Rows)]"
            $gotRescues = (@($script:Rescues) -join ';')
            Assert-Drill ($gotRescues -ceq $c.Rescues) "rescue reasons [$gotRescues], want [$($c.Rescues)]"
            Assert-Drill ($script:CheckRuns -eq $c.Checks) "check-run sends $($script:CheckRuns), want $($c.Checks)"
            Assert-Drill ($r.Outcome -ceq 'failed' -and $r.Code -ceq $c.Code) "result $($r.Outcome)/$($r.Code), want failed/$($c.Code)"
            if ($null -ne $c.StopLoop) { Assert-Drill ([bool]$r.StopLoop -eq $c.StopLoop) "StopLoop $($r.StopLoop), want $($c.StopLoop)" }
            if ($c.Held) { foreach ($row in $script:Rows) { Assert-HeldFields $row } }
            $passed++
            Write-Host "PASS landing-ledger: $($c.Name)"
        } catch {
            $failures.Add($c.Name)
            Write-Host "FAIL landing-ledger: $($c.Name) $($_.Exception.Message)"
        }
    }
} finally {
    Remove-Item -LiteralPath $fixtureRoot -Recurse -Force -ErrorAction SilentlyContinue
}
Write-Host "landing-ledger.ps1: $passed passed, $($failures.Count) failed"
if ($failures.Count -gt 0 -or $passed -eq 0) { exit 1 }
exit 0
