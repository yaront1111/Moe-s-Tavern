param(
    [string]$PyCharmVersion = "PyCharm2025.2",
    [string]$PluginZip = ""
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot

# Ensure daemon/proxy are built
Set-Location "$root\packages\moe-daemon"
npm install
npm run build

Set-Location "$root\packages\moe-proxy"
npm install
npm run build

# Build plugin unless a prebuilt zip is provided
$zip = $null
if ($PluginZip) {
    if (-not (Test-Path $PluginZip)) {
        throw "Plugin zip not found at $PluginZip"
    }
    $zip = Get-Item $PluginZip
} else {
    Set-Location "$root\moe-jetbrains"
    $ensureGradle = Join-Path $root "moe-jetbrains\\scripts\\ensure-gradle.ps1"
    if (Test-Path $ensureGradle) {
        $gradleBin = & $ensureGradle -ProjectRoot (Join-Path $root "moe-jetbrains")
        & $gradleBin buildPlugin
    } elseif (Test-Path .\gradlew.bat) {
        .\gradlew.bat buildPlugin
    } else {
        gradle buildPlugin
    }

    $zip = Get-ChildItem "$root\moe-jetbrains\build\distributions\*.zip" | Sort-Object LastWriteTime -Desc | Select-Object -First 1
    if (-not $zip) {
        throw "Plugin zip not found."
    }
}

$assets = "$root\installer\assets"
if (-not (Test-Path $assets)) { New-Item -ItemType Directory -Path $assets | Out-Null }

# Copy daemon/proxy dist
$daemonDest = Join-Path $assets "moe-daemon"
$proxyDest = Join-Path $assets "moe-proxy"

if (Test-Path $daemonDest) { Remove-Item -Recurse -Force $daemonDest }
if (Test-Path $proxyDest) { Remove-Item -Recurse -Force $proxyDest }

Copy-Item "$root\packages\moe-daemon\dist" $daemonDest -Recurse
Copy-Item "$root\packages\moe-proxy\dist" $proxyDest -Recurse

# Both dists are ESM with bare-specifier imports: without package.json
# ("type": "module") node < 22.7 can't even parse them, and without
# node_modules no node version can resolve ws/chokidar/pino.
Copy-Item "$root\packages\moe-daemon\package.json" $daemonDest
Copy-Item "$root\packages\moe-proxy\package.json" $proxyDest
Copy-Item "$root\packages\moe-daemon\node_modules" (Join-Path $daemonDest "node_modules") -Recurse -Exclude ".bin"
Copy-Item "$root\packages\moe-proxy\node_modules" (Join-Path $proxyDest "node_modules") -Recurse -Exclude ".bin"

# Add a helper start script for daemon
$startScript = @"
param([string]$ProjectPath)
if (-not $ProjectPath) { $ProjectPath = (Get-Location).Path }
node \"$PSScriptRoot\index.js\" start --project \"$ProjectPath\"
"@
$startScript | Out-File -FilePath (Join-Path $daemonDest "start-daemon.ps1") -Encoding UTF8

$startCmd = @"
@echo off
setlocal
set DIR=%~dp0
node \"%DIR%index.js\" %*
"@
$startCmd | Out-File -FilePath (Join-Path $daemonDest "start-daemon.cmd") -Encoding ASCII

Copy-Item $zip.FullName (Join-Path $assets "moe-jetbrains.zip") -Force

Write-Host "Installer assets prepared in $assets"
Write-Host "Build installer with: ISCC .\installer\moe-installer.iss"
