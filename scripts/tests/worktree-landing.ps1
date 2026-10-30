# Windows twin of worktree-landing.sh: the same held-out worktree-landing cases, run against
# scripts/moe-agent.ps1 on the engine running this script (powershell = 5.1, pwsh = 7.x).
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\tests\worktree-landing.ps1 [--list] [--only local|remote]
# It extracts the node suite embedded in worktree-landing.sh (between its WTJS markers), so
# every case is written once. $expectedCases pins the case list in this file too: a suite
# whose --list differs is a harness ERROR (exit 2). Exit codes as in the .sh: 0 all pass,
# 1 a landing expectation failed, 2 a harness fault.
$ErrorActionPreference = 'Stop'
$expectedCases = @(
    'local hunks-merge'
    'local conflict'
    'local reflog-linear'
    'local cas-contains-c'
    'local relanding-idempotent'
    'local branch-sync'
    'local target-checked-out'
    'local board-path'
    'remote push-first-no-force'
    'remote race-fetch-fails'
    'remote push-transport-fails'
    'remote push-applied-client-fails'
    'remote push-outcome-unknown'
    'remote push-rejected-retry'
    'remote diverged'
    'remote push-unanswered-repush'
    'remote push-remote-rejected'
    'remote push-unanswered-peer-lands'
)
$root = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$wrapper = Join-Path $root 'scripts\moe-agent.ps1'
$node = if ($env:MOE_NODE_COMMAND) { $env:MOE_NODE_COMMAND } else { (Get-Command node -ErrorAction SilentlyContinue).Source }
if (-not $node) { Write-Output 'ERROR harness: node not found'; exit 2 }
$prefix = Join-Path ([IO.Path]::GetTempPath()) 'moe-wl-'
$tempRoot = $prefix + [guid]::NewGuid().ToString('N').Substring(0, 8)
New-Item -ItemType Directory -Force -Path $tempRoot | Out-Null
$code = 2
try {
    $lines = [IO.File]::ReadAllLines((Join-Path $PSScriptRoot 'worktree-landing.sh'))
    $start = [Array]::IndexOf($lines, 'cat > "$SUITE" <<''WTJS''')
    $end = if ($start -ge 0) { [Array]::IndexOf($lines, 'WTJS', $start + 1) } else { -1 }
    if ($end -lt 0) { Write-Output 'ERROR harness: suite markers not found'; exit 2 }
    $suite = Join-Path $tempRoot 'suite.cjs'
    [IO.File]::WriteAllText($suite, (($lines[($start + 1)..($end - 1)] -join "`n") + "`n"), [Text.UTF8Encoding]::new($false))
    # Copy-Item keeps the shared proxy's bytes, as postflight.ps1 installs it.
    $fakeProxy = Join-Path $tempRoot 'fake-proxy.js'
    Copy-Item -LiteralPath (Join-Path $root 'scripts\tests\postflight-fake-proxy.js') -Destination $fakeProxy -ErrorAction Stop
    $engine = (Get-Process -Id $PID).Path
    $listed = @(& $node $suite ps1 $wrapper $fakeProxy $tempRoot $engine --list)
    if ($LASTEXITCODE -ne 0 -or ($listed -join "`n") -cne ($expectedCases -join "`n")) {
        Write-Output 'ERROR harness: case list drift'
        exit 2
    }
    & $node $suite ps1 $wrapper $fakeProxy $tempRoot $engine @args
    $code = $LASTEXITCODE
} finally {
    if ($tempRoot.StartsWith($prefix)) { Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue }
}
exit $code
