param([string]$Case = '')
# Exercise the production commit helper against disposable repositories only.
# No wrapper launch, daemon, model, network, or shared checkout mutation.
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
if (-not (Get-Command New-MoeHookedCommit -ErrorAction SilentlyContinue)) {
    Write-Host 'FAIL hooked-commit: production-helper-missing'
    Write-Host 'hooked-commit.ps1: 0 passed, 1 failed'
    exit 1
}
$fixtureRoot = Join-Path ([IO.Path]::GetTempPath()) ('moe-hooked-commit-' + [guid]::NewGuid().ToString('N'))
$priorGitEnvironment = @{}
foreach ($variable in @(Get-ChildItem Env: | Where-Object { $_.Name -like 'GIT_*' })) {
    $priorGitEnvironment[$variable.Name] = $variable.Value
    Remove-Item -LiteralPath ('Env:' + $variable.Name)
}
$env:GIT_CONFIG_NOSYSTEM = '1'
$env:GIT_CONFIG_GLOBAL = if ($env:OS -eq 'Windows_NT') { 'NUL' } else { '/dev/null' }
$env:GIT_TERMINAL_PROMPT = '0'
$script:MoeCaseFoldPaths = ($env:OS -eq 'Windows_NT')
$script:myPid = $PID
$passed = 0
$failures = New-Object 'System.Collections.Generic.List[string]'
$utf8 = New-Object System.Text.UTF8Encoding($false)
function Write-FixtureText([string]$Path, [string]$Text) { [IO.File]::WriteAllText($Path, $Text, $utf8) }
function Read-FixtureGit([string]$Root, [string[]]$Command, [string]$Index = '') {
    $result = Invoke-MoeGit -Top $Root -GitArgs $Command -IndexFile $Index -MergeStderr
    if ($result.Rc -ne 0) { throw 'fixture-git-operation-failed' }
    return (($result.Out -join "`n").Trim())
}
function Assert-Fixture([bool]$Condition, [string]$Code) {
    if (-not $Condition) { throw $Code }
}
try {
    New-Item -ItemType Directory -Path $fixtureRoot | Out-Null
    foreach ($name in @('success', 'failed-hook', 'changed-tree', 'branch-race', 'conditional-hook', 'conditional-signing', 'conditional-identity', 'conditional-default-key', 'unborn')) {
        if ($Case -and $name -notlike $Case) { continue }
        try {
            $root = Join-Path $fixtureRoot $name
            $hooks = Join-Path $fixtureRoot ('hooks-' + $name)
            New-Item -ItemType Directory -Path $root, $hooks | Out-Null
            Read-FixtureGit $root @('init', '-q', '-b', 'review') | Out-Null
            Read-FixtureGit $root @('config', 'user.name', 'Fixture') | Out-Null
            Read-FixtureGit $root @('config', 'user.email', 'fixture@example.invalid') | Out-Null
            Read-FixtureGit $root @('config', 'commit.gpgSign', 'false') | Out-Null
            Read-FixtureGit $root @('config', 'core.autocrlf', 'false') | Out-Null
            Read-FixtureGit $root @('config', 'core.hooksPath', ($hooks -replace '\\','/')) | Out-Null
            $gitDir = Join-Path $root '.git'
            $old = ''
            if ($name -ne 'unborn') {
                Write-FixtureText (Join-Path $root 'owned.txt') "base`n"
                Write-FixtureText (Join-Path $root 'peer.txt') "base`n"
                Read-FixtureGit $root @('add', '--', 'owned.txt', 'peer.txt') | Out-Null
                Read-FixtureGit $root @('commit', '-qm', 'fixture base') | Out-Null
                $old = Read-FixtureGit $root @('rev-parse', 'HEAD')
            }
            # Exercise original worktree config and a relative include, not only
            # the common repository config inherited by every linked worktree.
            Read-FixtureGit $root @('config', 'extensions.worktreeConfig', 'true') | Out-Null
            $include = Join-Path $gitDir 'fixture-hook-config'
            Read-FixtureGit $root @('config', '-f', $include, 'core.hooksPath', ($hooks -replace '\\','/')) | Out-Null
            Read-FixtureGit $root @('config', '-f', $include, 'moe.fixtureWitness', 'original-worktree') | Out-Null
            if ($name -in @('conditional-hook', 'conditional-signing', 'conditional-identity', 'conditional-default-key')) {
                Read-FixtureGit $root @('config', ('includeIf.gitdir:' + ($gitDir -replace '\\','/') + '.path'), 'fixture-hook-config') | Out-Null
            } else {
                Read-FixtureGit $root @('config', '--worktree', 'include.path', 'fixture-hook-config') | Out-Null
            }
            Read-FixtureGit $root @('config', '--unset', 'core.hooksPath') | Out-Null
            Assert-Fixture ((Read-FixtureGit $root @('config', '--get', 'core.hooksPath')) -eq ($hooks -replace '\\','/')) 'original-hook-config-not-selected'
            if ($name -eq 'conditional-signing') {
                # An original-only condition must not silently disable required
                # signing in the private context. No real key or signer is used.
                Read-FixtureGit $root @('config', '-f', $include, 'commit.gpgSign', 'true') | Out-Null
                Read-FixtureGit $root @('config', '-f', $include, 'gpg.format', 'ssh') | Out-Null
                Read-FixtureGit $root @('config', '-f', $include, 'gpg.ssh.program', 'moe-fixture-signer-must-not-run') | Out-Null
                Assert-Fixture ((Read-FixtureGit $root @('config', '--get', 'commit.gpgSign')) -eq 'true') 'original-signing-condition-not-selected'
            }
            if ($name -eq 'conditional-identity') {
                Read-FixtureGit $root @('config', '-f', $include, 'user.name', 'ConditionalFixture') | Out-Null
                Read-FixtureGit $root @('config', '-f', $include, 'user.email', 'conditional-fixture@example.invalid') | Out-Null
                Assert-Fixture ((Read-FixtureGit $root @('config', '--get', 'user.name')) -eq 'ConditionalFixture') 'original-identity-condition-not-selected'
            }
            if ($name -eq 'conditional-default-key') {
                # Only key-selection policy differs. Signing remains disabled,
                # so even the unfixed helper cannot execute a real signer.
                Read-FixtureGit $root @('config', 'gpg.format', 'ssh') | Out-Null
                Read-FixtureGit $root @('config', '-f', $include, 'gpg.ssh.defaultKeyCommand', 'moe-fixture-key-selection-must-not-run') | Out-Null
                Assert-Fixture ((Read-FixtureGit $root @('config', '--get', 'gpg.ssh.defaultKeyCommand')) -eq 'moe-fixture-key-selection-must-not-run') 'original-key-selection-condition-not-selected'
            }
            Write-FixtureText (Join-Path $root 'peer.txt') "peer staged bytes`n"
            Read-FixtureGit $root @('add', '--', 'peer.txt') | Out-Null
            $sharedIndex = [Convert]::ToBase64String([IO.File]::ReadAllBytes((Join-Path $gitDir 'index')))
            Write-FixtureText (Join-Path $root 'owned.txt') "validated bytes`n"
            $index = Join-Path $gitDir 'fixture-private-index'
            $seed = if ($old) { @('read-tree', $old) } else { @('read-tree', '--empty') }
            Read-FixtureGit $root $seed $index | Out-Null
            Read-FixtureGit $root @('add', '--', 'owned.txt') $index | Out-Null
            $tree = Read-FixtureGit $root @('write-tree') $index
            $message = Join-Path $gitDir 'fixture-message'
            Write-FixtureText $message "fixture reviewed commit`n"
            $hookBody = @'
#!/bin/sh
test "$(git config --get moe.fixtureWitness)" = original-worktree || exit 29
printf x >> .git/fixture-hook-marker
'@
            if ($name -in @('conditional-hook', 'conditional-signing', 'conditional-identity', 'conditional-default-key')) { $hookBody = "#!/bin/sh`nprintf x >> .git/fixture-hook-marker`n" }
            if ($name -eq 'failed-hook') { $hookBody += "`nexit 23`n" }
            if ($name -eq 'changed-tree') { $hookBody += "`nprintf 'hook bytes\n' > owned.txt`ngit add -- owned.txt`n" }
            $hook = Join-Path $hooks 'pre-commit'
            Write-FixtureText $hook ($hookBody.Replace("`r`n", "`n") + "`n")
            if ($env:OS -ne 'Windows_NT') { & chmod 755 $hook; if ($LASTEXITCODE -ne 0) { throw 'fixture-hook-mode-failed' } }
            if ($name -in @('success', 'branch-race', 'conditional-hook')) {
                Write-FixtureText (Join-Path $root 'owned.txt') "later working bytes`n"
            }
            $expectedHead = $old
            if ($name -eq 'branch-race') {
                $expectedHead = Read-FixtureGit $root @('commit-tree', "$old`^{tree}", '-p', $old, '-m', 'fixture peer advance')
                Read-FixtureGit $root @('update-ref', 'refs/heads/review', $expectedHead, $old) | Out-Null
            }
            $worktreesBefore = Read-FixtureGit $root @('worktree', 'list', '--porcelain')
            $result = New-MoeHookedCommit -Top $root -GitDir $gitDir -OldSha $old -Tree $tree -IndexFile $index -MessageFile $message
            Assert-Fixture ($sharedIndex -eq [Convert]::ToBase64String([IO.File]::ReadAllBytes((Join-Path $gitDir 'index')))) 'shared-index-changed'
            Assert-Fixture ((Read-FixtureGit $root @('worktree', 'list', '--porcelain')) -eq $worktreesBefore) 'scratch-worktree-leaked'
            Assert-Fixture (-not $env:GIT_DIR -and -not $env:GIT_WORK_TREE -and -not $env:GIT_INDEX_FILE) 'git-environment-leaked'
            if ($name -eq 'unborn') {
                Assert-Fixture ($result.Rc -ne 0) 'unborn-hook-commit-not-refused'
                $head = Invoke-MoeGit -Top $root -GitArgs @('rev-parse', '--verify', 'HEAD')
                Assert-Fixture ($head.Rc -ne 0) 'unborn-head-was-published'
                Assert-Fixture (-not (Test-Path -LiteralPath (Join-Path $gitDir 'fixture-hook-marker'))) 'unborn-hook-ran'
            } else {
                Assert-Fixture ((Read-FixtureGit $root @('rev-parse', 'HEAD')) -eq $expectedHead) 'real-head-changed'
                if ($name -in @('conditional-signing', 'conditional-identity', 'conditional-default-key')) {
                    Assert-Fixture ($result.Rc -ne 0) 'conditional-config-mismatch-not-refused'
                    Assert-Fixture (@($result.Out) -contains 'hooked-commit-config-mismatch') 'conditional-config-refusal-code-missing'
                    Assert-Fixture (-not (Test-Path -LiteralPath (Join-Path $gitDir 'fixture-hook-marker'))) 'hook-ran-before-config-mismatch-refusal'
                    $passed++
                    continue
                }
                Assert-Fixture (([IO.File]::ReadAllText((Join-Path $gitDir 'fixture-hook-marker'))) -eq 'x') 'hook-did-not-run-once-with-worktree-config'
                if ($name -eq 'failed-hook' -or $name -eq 'changed-tree') {
                    Assert-Fixture ($result.Rc -ne 0) 'failed-or-tree-changing-hook-not-refused'
                } else {
                    Assert-Fixture ($result.Rc -eq 0) 'valid-hook-commit-refused'
                    $new = ($result.Out -join '').Trim()
                    Assert-Fixture ((Read-FixtureGit $root @('rev-list', '--parents', '-n', '1', $new)) -eq "$new $old") 'candidate-parent-not-exact'
                    Assert-Fixture ((Read-FixtureGit $root @('rev-parse', "$new`^{tree}")) -eq $tree) 'candidate-tree-not-reviewed-snapshot'
                    $publication = Invoke-MoeGit -Top $root -GitArgs @('update-ref', 'refs/heads/review', $new, $old)
                    if ($name -eq 'branch-race') {
                        Assert-Fixture ($publication.Rc -ne 0) 'concurrent-publication-not-refused'
                        Assert-Fixture ((Read-FixtureGit $root @('rev-parse', 'HEAD')) -eq $expectedHead) 'peer-commit-not-preserved'
                    } else {
                        Assert-Fixture ($publication.Rc -eq 0) 'validated-publication-failed'
                        Assert-Fixture ((Read-FixtureGit $root @('rev-parse', 'HEAD')) -eq $new) 'published-head-mismatch'
                    }
                    Assert-Fixture (([IO.File]::ReadAllText((Join-Path $root 'owned.txt'))) -eq "later working bytes`n") 'later-worktree-edit-not-preserved'
                }
            }
            $passed++
        } catch {
            $failures.Add($name)
            # Exception values can contain Git/hook output; report only the case.
            Write-Host "FAIL hooked-commit: $name"
        }
    }
    Write-Host "hooked-commit.ps1: $passed passed, $($failures.Count) failed"
    if ($failures.Count -or $passed -eq 0) { exit 1 }
} finally {
    try {
        $resolved = [IO.Path]::GetFullPath($fixtureRoot)
        $tempParent = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\','/') + [IO.Path]::DirectorySeparatorChar
        if (-not $resolved.StartsWith($tempParent, [StringComparison]::OrdinalIgnoreCase) -or (Split-Path $resolved -Leaf) -notlike 'moe-hooked-commit-*') {
            throw 'fixture cleanup refused outside owned temporary root'
        }
        Remove-Item -LiteralPath $resolved -Recurse -Force
    } finally {
        foreach ($variable in @(Get-ChildItem Env: | Where-Object { $_.Name -like 'GIT_*' })) { Remove-Item -LiteralPath ('Env:' + $variable.Name) }
        foreach ($entry in $priorGitEnvironment.GetEnumerator()) { Set-Item -LiteralPath ('Env:' + $entry.Key) -Value $entry.Value }
    }
}
