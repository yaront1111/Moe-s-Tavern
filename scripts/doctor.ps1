param(
    [switch]$Full
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot

function Require-Command([string]$Name) {
    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw "Missing required command: $Name"
    }
}

function Run-Native([string]$Cmd, [string[]]$Args) {
    $nativePref = $null
    if (Get-Variable -Name PSNativeCommandUseErrorActionPreference -ErrorAction SilentlyContinue) {
        $nativePref = $PSNativeCommandUseErrorActionPreference
        Set-Variable -Name PSNativeCommandUseErrorActionPreference -Value $false -Scope Local
    }
    $errorPref = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        & $Cmd @Args 2>&1 | Out-Host
        if ($LASTEXITCODE -ne 0) {
            throw "$Cmd exited with code $LASTEXITCODE"
        }
    } finally {
        $ErrorActionPreference = $errorPref
        if ($null -ne $nativePref) {
            Set-Variable -Name PSNativeCommandUseErrorActionPreference -Value $nativePref -Scope Local
        }
    }
}

Write-Host "== Moe Doctor =="

Write-Host "Checking Node + npm..."
Require-Command "node"
Require-Command "npm"
node -v | Out-Host
npm -v | Out-Host

Write-Host "Checking Java..."
Require-Command "java"
Run-Native "java" @("-version")

Write-Host "Checking Gradle..."
$ensureGradle = Join-Path $root "moe-jetbrains\scripts\ensure-gradle.ps1"
if (-not (Test-Path $ensureGradle)) { throw "Missing ensure-gradle.ps1" }
$gradleBin = & $ensureGradle -ProjectRoot (Join-Path $root "moe-jetbrains")
Run-Native $gradleBin @("--version")

if ($Full) {
    Write-Host "Running full builds..."

    Write-Host "Building moe-daemon..."
    Set-Location "$root\packages\moe-daemon"
    npm install
    npm run build

    Write-Host "Building moe-proxy..."
    Set-Location "$root\packages\moe-proxy"
    npm install
    npm run build

    Write-Host "Building moe-jetbrains plugin..."
    Set-Location "$root\moe-jetbrains"
    Run-Native $gradleBin @("buildPlugin")

    $zip = Get-ChildItem "$root\moe-jetbrains\build\distributions\*.zip" | Sort-Object LastWriteTime -Desc | Select-Object -First 1
    if (-not $zip) { throw "Plugin zip not found in build\\distributions" }
    Write-Host "Plugin zip: $($zip.FullName)"
}

Write-Host "Doctor check complete."
