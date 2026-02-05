param(
    [switch]$InstallPlugin,
    [string]$PyCharmVersion = "PyCharm2025.2",
    [string]$PluginZip = ""
)

$ErrorActionPreference = "Stop"

$shouldInstallPlugin = if ($PSBoundParameters.ContainsKey('InstallPlugin')) { $InstallPlugin.IsPresent } else { $true }

$root = Split-Path -Parent $PSScriptRoot

Write-Host "Installing Moe daemon..."
Set-Location "$root\packages\moe-daemon"
npm install
npm run build

Write-Host "Installing Moe proxy..."
Set-Location "$root\packages\moe-proxy"
npm install
npm run build

function Resolve-PyCharmVersion([string]$Preferred) {
    $jbRoot = Join-Path $env:APPDATA "JetBrains"
    if ($Preferred -and (Test-Path (Join-Path $jbRoot $Preferred))) {
        return $Preferred
    }

    if (Test-Path $jbRoot) {
        $dirs = Get-ChildItem -Path $jbRoot -Directory -Filter "PyCharm*"
        if ($dirs) {
            return ($dirs | Sort-Object Name -Descending | Select-Object -First 1).Name
        }
    }

    return $Preferred
}

if ($shouldInstallPlugin) {
    $zip = $null
    if ($PluginZip) {
        if (-not (Test-Path $PluginZip)) {
            Write-Host "Plugin zip not found at $PluginZip"
            exit 1
        }
        $zip = Get-Item $PluginZip
    } elseif (Test-Path "$root\installer\assets\moe-jetbrains.zip") {
        $zip = Get-Item "$root\installer\assets\moe-jetbrains.zip"
    } else {
        Write-Host "Building Moe plugin..."
        $ensureGradle = Join-Path $root "moe-jetbrains\\scripts\\ensure-gradle.ps1"
        if (Test-Path $ensureGradle) {
            $gradleBin = & $ensureGradle -ProjectRoot (Join-Path $root "moe-jetbrains")
            Set-Location "$root\moe-jetbrains"
            & $gradleBin buildPlugin
        } else {
            $gradlew = Join-Path $root "moe-jetbrains\\gradlew.bat"
            if (-not (Test-Path $gradlew)) {
                Write-Host "Gradle wrapper not found at $gradlew"
                Write-Host "Open moe-jetbrains in PyCharm and run Gradle task buildPlugin once."
                Write-Host "Then re-run this script with -InstallPlugin."
                exit 0
            }
            Set-Location "$root\\moe-jetbrains"
            & $gradlew buildPlugin
        }

        $zip = Get-ChildItem "$root\moe-jetbrains\build\distributions\*.zip" | Sort-Object LastWriteTime -Desc | Select-Object -First 1
        if (-not $zip) {
            Write-Host "Plugin zip not found in build\\distributions."
            exit 1
        }
    }

    $jbRoot = Join-Path $env:APPDATA "JetBrains"
    $PyCharmVersion = Resolve-PyCharmVersion $PyCharmVersion
    $pluginRoot = Join-Path $jbRoot $PyCharmVersion
    if (-not (Test-Path $pluginRoot)) {
        Write-Host "PyCharm config not found at $pluginRoot"
        Write-Host "Set -PyCharmVersion to match your config folder (e.g., PyCharm2025.2)."
        exit 1
    }

    $pluginsDir = Join-Path $pluginRoot "plugins"
    if (-not (Test-Path $pluginsDir)) {
        New-Item -ItemType Directory -Path $pluginsDir | Out-Null
    }

    $destDir = Join-Path $pluginsDir "moe-jetbrains"
    if (Test-Path $destDir) {
        Remove-Item -Recurse -Force $destDir
    }

    $tmp = Join-Path $env:TEMP "moe-jetbrains-install"
    if (Test-Path $tmp) {
        Remove-Item -Recurse -Force $tmp
    }
    New-Item -ItemType Directory -Path $tmp | Out-Null
    Expand-Archive -Path $zip.FullName -DestinationPath $tmp -Force

    if (Test-Path (Join-Path $tmp "lib")) {
        Move-Item -Path $tmp -Destination $destDir
    } else {
        $inner = Get-ChildItem -Path $tmp -Directory |
            Where-Object { Test-Path (Join-Path $_.FullName "lib") } |
            Select-Object -First 1
        if (-not $inner) {
            throw "Plugin zip layout unexpected. Expected lib/ at root."
        }
        Move-Item -Path $inner.FullName -Destination $destDir
        Remove-Item -Recurse -Force $tmp
    }

    Write-Host "Installed plugin to $destDir"
    Write-Host "Restart PyCharm to load the plugin."
}

# Write global install config (~/.moe/config.json)
$moeHome = Join-Path $env:USERPROFILE ".moe"
if (-not (Test-Path $moeHome)) {
    New-Item -ItemType Directory -Path $moeHome | Out-Null
}
$globalConfig = @{
    installPath = $root
    version = "0.1.0"
    updatedAt = (Get-Date -Format "o")
}
$globalConfig | ConvertTo-Json | Set-Content -Path (Join-Path $moeHome "config.json") -Encoding UTF8
Write-Host "Wrote global config to $moeHome\config.json"

Write-Host "Done."
Write-Host "Next steps:"
Write-Host "1) Start daemon: node packages/moe-daemon/dist/index.js start --project <path>"
Write-Host "2) Configure Claude to use moe-proxy (see docs/MCP_SERVER.md)"
Write-Host "3) Plugin auto-starts the daemon when PyCharm opens a project (if installed)."
