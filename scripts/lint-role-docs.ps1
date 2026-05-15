[CmdletBinding()]
param(
    [switch]$SelfTest,
    [int]$MaxLines = $(if ($env:ROLE_DOC_MAX_LINES) { [int]$env:ROLE_DOC_MAX_LINES } else { 40 }),
    [string]$Root = $(if ($env:ROLE_DOC_ROOT) { $env:ROLE_DOC_ROOT } else { (Resolve-Path (Join-Path $PSScriptRoot "..")).Path })
)

function Test-RoleDocs {
    param(
        [Parameter(Mandatory = $true)][string]$RootDir,
        [Parameter(Mandatory = $true)][int]$Limit,
        [switch]$Quiet
    )

    $failed = $false
    foreach ($role in @("architect", "worker", "qa")) {
        $relative = "docs/roles/$role.md"
        $path = Join-Path $RootDir $relative
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
            if (-not $Quiet) {
                [Console]::Error.WriteLine("Missing role doc: $relative")
            }
            $failed = $true
            continue
        }

        $lines = (Get-Content -LiteralPath $path).Count
        if ($lines -gt $Limit) {
            if (-not $Quiet) {
                [Console]::Error.WriteLine("Role doc too long: $relative has $lines lines (max $Limit)")
            }
            $failed = $true
        } else {
            if (-not $Quiet) {
                [Console]::Out.WriteLine("OK: $relative has $lines lines (max $Limit)")
            }
        }
    }

    return -not $failed
}

if ($SelfTest) {
    $tmpDir = Join-Path ([IO.Path]::GetTempPath()) ("moe-role-docs-" + [Guid]::NewGuid())
    try {
        New-Item -ItemType Directory -Force -Path (Join-Path $tmpDir "docs/roles") | Out-Null
        foreach ($role in @("architect", "worker", "qa")) {
            Copy-Item -LiteralPath (Join-Path $Root "docs/roles/$role.md") -Destination (Join-Path $tmpDir "docs/roles/$role.md")
        }

        if (-not (Test-RoleDocs -RootDir $tmpDir -Limit $MaxLines -Quiet)) {
            exit 1
        }

        $padding = 1..($MaxLines + 1) | ForEach-Object { "padding" }
        Add-Content -LiteralPath (Join-Path $tmpDir "docs/roles/architect.md") -Value $padding
        if (Test-RoleDocs -RootDir $tmpDir -Limit $MaxLines -Quiet) {
            [Console]::Error.WriteLine("Self-test failed: padded architect.md unexpectedly passed")
            exit 1
        }

        Write-Output "Self-test passed: valid docs pass and padded docs fail"
        exit 0
    } finally {
        Remove-Item -LiteralPath $tmpDir -Recurse -Force -ErrorAction SilentlyContinue
    }
}

if (Test-RoleDocs -RootDir $Root -Limit $MaxLines) {
    exit 0
}
exit 1
