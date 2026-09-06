param([switch]$HarvestOnly, [string]$Case = '')
# Real Git attribution/tree regression drills. Load functions through the AST;
# never execute the wrapper's launch code or contact a daemon/provider.
$ErrorActionPreference = 'Stop'
$wrapper = Join-Path $PSScriptRoot '../moe-agent.ps1'
$tokens = $null; $parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($wrapper, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw 'wrapper parse failed' }
foreach ($statement in $ast.EndBlock.Statements) {
    if ($statement -is [System.Management.Automation.Language.FunctionDefinitionAst]) {
        . ([scriptblock]::Create($statement.Extent.Text))
    }
}
$script:MoeCaseFoldPaths = ($env:OS -eq 'Windows_NT')
$fixtureRoot = Join-Path ([IO.Path]::GetTempPath()) ('moe-importee-guard-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $fixtureRoot | Out-Null
$failures = New-Object 'System.Collections.Generic.List[string]'
$passed = 0
$priorGitEnvironment = @{}
foreach ($variable in @(Get-ChildItem Env: | Where-Object { $_.Name -like 'GIT_*' })) {
    $priorGitEnvironment[$variable.Name] = $variable.Value
    Remove-Item -LiteralPath ("Env:" + $variable.Name)
}
$env:GIT_CONFIG_NOSYSTEM = '1'
$env:GIT_CONFIG_GLOBAL = Join-Path $fixtureRoot 'empty.gitconfig'
[IO.File]::WriteAllText($env:GIT_CONFIG_GLOBAL, '')
function Assert-GuardCase([string]$Name, [hashtable]$Files, [string[]]$Expected, [hashtable]$HeadFiles = @{}, [string[]]$Deleted = @(), [string]$ConcurrentPath = '', [switch]$Unborn) {
    if ($Case -and $Name -notlike $Case) { return }
    $root = Join-Path $fixtureRoot $Name
    New-Item -ItemType Directory -Path $root | Out-Null
    & git -C $root init -q -b review
    & git -C $root config --local user.name Review
    & git -C $root config --local user.email review@example.invalid
    & git -C $root config --local commit.gpgsign false
    [IO.File]::WriteAllText((Join-Path $root 'README'), 'base')
    foreach ($entry in $HeadFiles.GetEnumerator()) {
        $path = Join-Path $root $entry.Key
        New-Item -ItemType Directory -Force -Path ([IO.Path]::GetDirectoryName($path)) | Out-Null
        [IO.File]::WriteAllText($path, $entry.Value)
    }
    if (-not $Unborn) {
        & git -C $root add -- README @($HeadFiles.Keys)
        & git -C $root commit -qm base
        if ($LASTEXITCODE -ne 0) { throw 'fixture Git preparation failed' }
    }
    foreach ($path in $Deleted) { Remove-Item -LiteralPath (Join-Path $root $path) }
    foreach ($entry in $Files.GetEnumerator()) { [IO.File]::WriteAllText((Join-Path $root $entry.Key), $entry.Value) }
    $scope = @{ Asserted=@($Files.Keys)+$Deleted; Planned=@(); PeerDeclared=@{}; PeersActive=$false; ForceNever=$false }
    $settings = @{ undeclared='never'; contested='skip-untouched'; commitBoardState=$false; exclude=@() }
    $gitInfo = @{ Top=$root; Rel=''; GitDir=(Join-Path $root '.git') }
    $selection = Resolve-MoeAttribution -Git $gitInfo -S (Get-MoeDirtySnapshot $root) -B @{} -U @{} -Tool @{} -Scope $scope -Settings $settings -TaskId 'task-review'
    $actual = @($selection.Candidates | ForEach-Object { $_.Path } | Sort-Object)
    if (($actual -join '|') -ne (($Expected | Sort-Object) -join '|')) {
        $script:failures.Add($Name)
        Write-Host "FAIL importee-guard: $Name (candidate selection)"
        return
    }
    if ($actual.Count) {
        $old = if ($Unborn) { '' } else { (& git -C $root rev-parse HEAD).Trim() }
        if ($ConcurrentPath) { [IO.File]::AppendAllText((Join-Path $root $ConcurrentPath), "`n// changed after attribution") }
        $tree = Build-MoeTempIndexTree $root (Join-Path $root '.git/review-index') $old $selection.Candidates
        if (-not $tree.Ok) { throw 'fixture tree construction failed' }
        if ($ConcurrentPath) {
            if ($tree.Landed.Count -ne 0 -or $tree.Changed -or $tree.Tree) {
                $script:failures.Add($Name); Write-Host "FAIL importee-guard: $Name (staged dependency closure)"; return
            }
            $script:passed++; return
        }
        if (-not $tree.Tree) { throw 'fixture tree construction failed' }
        $landed = @(& git -C $root ls-tree -r --name-only $tree.Tree)
        foreach ($path in $Files.Keys) {
            if (($landed -contains $path) -ne ($Expected -contains $path -or $HeadFiles.ContainsKey($path))) {
                throw 'candidate tree differs from selection'
            }
        }
    }
    $script:passed += 1
}
try {
    if (-not $HarvestOnly) {
    Assert-GuardCase 'literal-examples' @{
        'a.mjs'="import { example } from './b.mjs';"
        'b.mjs'=@'
// import ignored from './missing-line.mjs';
/* export * from './missing-block.mjs'; */
export const example = 'import value from "./missing-string.mjs"';
const template = `import value from './missing-template.mjs'`;
const pattern = /import value from '.\/missing-regex.mjs'/;
const from = './ordinary-string.mjs';
'@
    } @('a.mjs','b.mjs')
    Assert-GuardCase 'transitive' @{'a.mjs'="import './b.mjs';";'b.mjs'="import './missing.mjs';"} @()
    Assert-GuardCase 'cycles' @{'a.mjs'="import './b.mjs';";'b.mjs'="import './a.mjs';"} @('a.mjs','b.mjs')
    Assert-GuardCase 'side-effect' @{'a.mjs'="import './missing.mjs';"} @()
    Assert-GuardCase 'comment-separated' @{'a.mjs'="import /* gap */ './missing.mjs';"} @()
    Assert-GuardCase 'static-from' @{'a.mjs'="import { value } from './missing.mjs';"} @()
    Assert-GuardCase 're-export' @{'a.mjs'="export { value } from './missing.mjs';"} @()
    Assert-GuardCase 'dynamic' @{'a.mjs'="await import(/* gap */ './missing.mjs');"} @()
    Assert-GuardCase 'require' @{'a.cjs'="require(/* gap */ './missing.cjs');"} @()
    Assert-GuardCase 'property-call' @{'a.mjs'="obj.require('./not-a-module'); obj.import('./not-a-module');"} @('a.mjs')
    Assert-GuardCase 'computed-import' @{'a.mjs'="import('./prefix-' + name);"} @('a.mjs')
    Assert-GuardCase 'template-expression' @{'a.mjs'='const result = `${await import("./missing.mjs")}`;'} @()
    Assert-GuardCase 'nested-template-expression' @{'a.mjs'='const result = `${{ value: `${await import("./missing.mjs")}` }.value}`;'} @()
    Assert-GuardCase 'escaped-specifier' @{'a.mjs'='import ".\x2fmissing.mjs";'} @()
    Assert-GuardCase 'ts-bridge' @{'a.ts'="import { value } from './b.js';"} @('a.ts') @{'b.ts'='export const value = 1;'}
    Assert-GuardCase 'module-bridges' @{'a.mts'="import './b.mjs'; import './c.cjs';"} @('a.mts') @{'b.mts'='export {}';'c.cts'='export {}'}
    Assert-GuardCase 'index-bridge' @{'a.ts'="import './nested';"} @('a.ts') @{'nested/index.ts'='export {}'}
    Assert-GuardCase 'deleted-importee' @{'a.mjs'="import './b.mjs';"} @('b.mjs') @{'b.mjs'='export {}'} @('b.mjs')
    Assert-GuardCase 'head-fallback' @{'a.mjs'="import './b.mjs';";'b.mjs'="import './missing.mjs';"} @('a.mjs') @{'b.mjs'='export {}'}
    Assert-GuardCase 'unclosed-literal' @{'a.mjs'='const invalid = "unterminated'} @()
    Assert-GuardCase 'jsx-literal-text' @{'a.tsx'=@'
export const element = <div title="import './fake-attribute'">Don't import './fake-child'</div>;
'@} @('a.tsx')
    Assert-GuardCase 'jsx-expression' @{'a.tsx'='export const element = <section>{import("./missing.mjs")}</section>;'} @()
    Assert-GuardCase 'jsx-nested-expression' @{'a.tsx'='export const element = <><section value={<i>{import("./missing.mjs")}</i>} /></>;'} @()
    Assert-GuardCase 'jsx-generics' @{'a.tsx'='export const identity = <T,>(value: T) => value; export const constrained = <T extends object>(value: T) => value;'} @('a.tsx')
    Assert-GuardCase 'lexical-keyword-case' @{'a.mjs'="Require('./ordinary-value'); Import('./ordinary-value');"} @('a.mjs')
    Assert-GuardCase 'lexical-utf16-escapes' @{'a.mjs'='export const emoji = "\ud83d\ude00";'} @('a.mjs')
    Assert-GuardCase 'final-concurrent-dependency' @{'a.mjs'="import './b.mjs';";'b.mjs'='export {}'} @('a.mjs','b.mjs') @{} @() 'b.mjs'
    Assert-GuardCase 'final-unborn-missing' @{'a.mjs'="import './missing.mjs';"} @() -Unborn
    Assert-GuardCase 'final-unborn-cycle' @{'a.mjs'="import './b.mjs';";'b.mjs'="import './a.mjs';"} @('a.mjs','b.mjs') -Unborn
    if (-not $Case -or 'final-staged-source' -like $Case) {
        $root = Join-Path $fixtureRoot 'final-staged-source'; New-Item -ItemType Directory -Path $root | Out-Null
        & git -C $root init -q -b review
        [IO.File]::WriteAllText((Join-Path $root 'a.mjs'), "import './missing.mjs';")
        $snap = Get-MoeDirtySnapshot $root
        $candidate = @{ Path='a.mjs'; Blob=$snap['a.mjs'].Blob; Reason='ASSERTED'; XY='??' }
        $indexFile = Join-Path $root '.git/review-index'
        Invoke-MoeGit -Top $root -IndexFile $indexFile -GitArgs @('add', '--', 'a.mjs') | Out-Null
        [IO.File]::WriteAllText((Join-Path $root 'a.mjs'), 'export {};')
        $missing = Get-MoeMissingImportees -Git @{ Top=$root } -Candidates @($candidate) -BaseRef '' -IndexFile $indexFile
        if (-not $missing.ContainsKey('a.mjs')) { $failures.Add('final-staged-source'); Write-Host 'FAIL importee-guard: final-staged-source' } else { $passed++ }
    }
    }
    $moeGit = @{ Top=$fixtureRoot; Rel='' }
    $script:MoeToolWritten = @{}
    $script:MoeToolPending = [hashtable]::new([StringComparer]::Ordinal)
    $script:MoeToolSettled = [hashtable]::new([StringComparer]::Ordinal); $script:MoeToolHarvestSaturated = $false
    $scope = @{ Asserted=@('owned.txt'); Planned=@(); PeerDeclared=@{ 'owned.txt'=@{ Path='owned.txt'; TaskId='task-peer' } }; PeersActive=$true; ForceNever=$false }
    $settings = @{ undeclared='never'; contested='skip-untouched'; commitBoardState=$false; exclude=@() }
    $snapshot = @{ 'owned.txt'=@{ Path='owned.txt'; XY='??'; Blob='fixture-blob' } }
    Register-MoeToolWrite 'claim-only' 'moe__complete_step' @{ modifiedFiles=@('owned.txt') }
    Complete-MoeToolWrite @{ tool_use_id='claim-only'; is_error=$false }
    $claimed = Resolve-MoeAttribution -Git $moeGit -S $snapshot -B @{} -U @{} -Tool $script:MoeToolWritten -Scope $scope -Settings $settings -TaskId 'task-review'
    Register-MoeToolWrite 'actual-write' 'Write' @{ file_path=(Join-Path $fixtureRoot 'owned.txt') }
    Complete-MoeToolWrite @{ tool_use_id='actual-write'; is_error=$false }
    Register-MoeToolWrite 'claim-after-write' 'moe__complete_step' @{ modifiedFiles=@('owned.txt') }
    Complete-MoeToolWrite @{ tool_use_id='claim-after-write'; is_error=$false }
    $edited = Resolve-MoeAttribution -Git $moeGit -S $snapshot -B @{} -U @{} -Tool $script:MoeToolWritten -Scope $scope -Settings $settings -TaskId 'task-review'
    if ($claimed.Candidates.Count -ne 0 -or $claimed.Skipped[0].Code -ne 'MOE_ATTR_CONTESTED_UNTOUCHED(task-peer)' -or $edited.Candidates.Count -ne 1) {
        $failures.Add('declaration-is-not-editing-evidence')
        Write-Host 'FAIL importee-guard: declaration-is-not-editing-evidence'
    } else { $passed++ }
    $parserAssignment = $ast.FindAll({ param($node)
        $node -is [System.Management.Automation.Language.AssignmentStatementAst] -and $node.Left.Extent.Text -eq '$parseStreamJson'
    }, $true) | Select-Object -First 1
    $streamParser = & ([scriptblock]::Create($parserAssignment.Right.Extent.Text))
    $script:MoeToolWritten = @{}; $script:MoeToolPending = [hashtable]::new([StringComparer]::Ordinal)
    $script:MoeToolSettled = [hashtable]::new([StringComparer]::Ordinal); $script:MoeToolHarvestSaturated = $false
    $writeInput = @{ file_path=(Join-Path $fixtureRoot 'owned.txt') }
    function Send-ReviewStreamEvent($Event) { & $streamParser ($Event | ConvertTo-Json -Depth 12 -Compress) }
    function Send-ReviewToolUse([string]$Id, [string]$Name, $InputValue) {
        Send-ReviewStreamEvent @{ type='assistant'; message=@{ content=@(@{ type='tool_use'; id=$Id; name=$Name; input=$InputValue }) } }
    }
    function Send-ReviewToolResult([string]$Id, $Failed) {
        Send-ReviewStreamEvent @{ type='user'; message=@{ content=@(@{ type='tool_result'; tool_use_id=$Id; is_error=$Failed; content='fixture result' }) } }
    }
    function Assert-ReviewWitnessCount([string]$Name, [int]$Count) {
        if ($script:MoeToolWritten.Count -ne $Count) { $script:failures.Add($Name); Write-Host "FAIL importee-guard: $Name" } else { $script:passed++ }
    }
    Send-ReviewToolUse 'failed-write' 'Write' $writeInput
    Assert-ReviewWitnessCount 'no-result-is-not-editing-evidence' 0
    Send-ReviewToolResult 'failed-write' $true
    Assert-ReviewWitnessCount 'failed-result-is-not-editing-evidence' 0
    Send-ReviewToolUse 'failed-write' 'Write' $writeInput
    Send-ReviewToolResult 'failed-write' $false
    Assert-ReviewWitnessCount 'duplicate-failed-id-cannot-resurrect' 0
    Send-ReviewToolUse 'declaration' 'moe__complete_step' @{ modifiedFiles=@('owned.txt') }
    Send-ReviewToolResult 'declaration' $false
    Assert-ReviewWitnessCount 'successful-declaration-is-not-editing-evidence' 0
    Send-ReviewToolUse 'successful-write' 'Write' $writeInput
    Send-ReviewToolResult 'unrelated-result' $false
    Assert-ReviewWitnessCount 'unmatched-result-is-not-editing-evidence' 0
    Send-ReviewToolResult 'successful-write' $false
    Assert-ReviewWitnessCount 'successful-matched-write-is-editing-evidence' 1
    Send-ReviewToolUse 'later-failure' 'Write' $writeInput
    Send-ReviewToolResult 'later-failure' $true
    Assert-ReviewWitnessCount 'failure-preserves-earlier-success' 1
    $otherInput = @{ file_path=(Join-Path $fixtureRoot 'other.txt') }
    Send-ReviewToolUse 'malformed-result' 'Write' $otherInput
    Send-ReviewToolResult 'malformed-result' 'false'
    Assert-ReviewWitnessCount 'malformed-result-is-not-editing-evidence' 1
    Send-ReviewToolUse 'null-result' 'Write' $otherInput
    Send-ReviewToolResult 'null-result' $null
    Assert-ReviewWitnessCount 'null-result-is-not-editing-evidence' 1
    Send-ReviewStreamEvent @{ type='assistant'; isReplay=$true; message=@{ content=@(@{ type='tool_use'; id='replay-use'; name='Write'; input=$otherInput }) } }
    Send-ReviewToolResult 'replay-use' $false
    Assert-ReviewWitnessCount 'replayed-invocation-is-not-current-editing-evidence' 1
    Send-ReviewToolUse 'replay-result' 'Write' $otherInput
    Send-ReviewStreamEvent @{ type='user'; isReplay=$true; message=@{ content=@(@{ type='tool_result'; tool_use_id='replay-result'; is_error=$false }) } }
    Assert-ReviewWitnessCount 'replayed-result-is-not-current-editing-evidence' 1
    Send-ReviewToolUse 'CaseSensitive' 'Write' $otherInput
    Send-ReviewToolResult 'casesensitive' $false
    Assert-ReviewWitnessCount 'result-id-must-match-exactly' 1
    Send-ReviewToolUse 'optional-flag' 'Write' $otherInput
    Send-ReviewStreamEvent @{ type='user'; message=@{ content=@(@{ type='tool_result'; tool_use_id='optional-flag'; content='fixture result' }) } }
    Assert-ReviewWitnessCount 'omitted-error-flag-success-is-supported' 2
    $partialInput = @{ file_path=(Join-Path $fixtureRoot 'partial.txt') }
    Send-ReviewStreamEvent @{ type='stream_event'; event=@{ type='content_block_start'; content_block=@{ type='tool_use'; id='partial-write'; name='Write' } } }
    Send-ReviewStreamEvent @{ type='stream_event'; event=@{ type='content_block_delta'; delta=@{ type='input_json_delta'; partial_json=($partialInput | ConvertTo-Json -Compress) } } }
    Send-ReviewStreamEvent @{ type='stream_event'; event=@{ type='content_block_stop' } }
    Send-ReviewToolResult 'partial-write' $false
    Assert-ReviewWitnessCount 'partial-events-are-display-only' 2
    Write-Host "importee-guard.ps1: $passed passed, $($failures.Count) failed"
    if ($failures.Count) { exit 1 }
} finally {
    try {
    $resolved = [IO.Path]::GetFullPath($fixtureRoot)
    $tempParent = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\','/') + [IO.Path]::DirectorySeparatorChar
    if (-not $resolved.StartsWith($tempParent, [StringComparison]::OrdinalIgnoreCase) -or (Split-Path $resolved -Leaf) -notlike 'moe-importee-guard-*') {
        throw 'fixture cleanup refused outside owned temporary root'
    }
    Remove-Item -LiteralPath $resolved -Recurse -Force
    } finally {
        foreach ($variable in @(Get-ChildItem Env: | Where-Object { $_.Name -like 'GIT_*' })) { Remove-Item -LiteralPath ("Env:" + $variable.Name) }
        foreach ($entry in $priorGitEnvironment.GetEnumerator()) { Set-Item -LiteralPath ("Env:" + $entry.Key) -Value $entry.Value }
    }
}
