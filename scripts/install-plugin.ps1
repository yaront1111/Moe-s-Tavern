param(
    [string]$PluginZip,
    [string]$PyCharmVersion = "PyCharm2025.2"
)

if (-not $PluginZip) {
    Write-Host "Usage: .\scripts\install-plugin.ps1 -PluginZip <path>"
    exit 1
}

$jbRoot = Join-Path $env:APPDATA "JetBrains"
$candidates = @()
if (Test-Path $jbRoot) {
    $candidates = Get-ChildItem -Path $jbRoot -Directory -Filter "PyCharm*"
}
if (-not (Test-Path (Join-Path $jbRoot $PyCharmVersion)) -and $candidates.Count -gt 0) {
    $PyCharmVersion = ($candidates | Sort-Object Name -Descending | Select-Object -First 1).Name
}
$pluginRoot = Join-Path $jbRoot $PyCharmVersion
if (-not (Test-Path $pluginRoot)) {
    Write-Host "PyCharm config not found at $pluginRoot"
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

Expand-Archive -Path $PluginZip -DestinationPath $destDir -Force

# If the zip contained a top-level folder, flatten it into $destDir.
$libDir = Join-Path $destDir "lib"
if (-not (Test-Path $libDir)) {
    $childDirs = Get-ChildItem -Path $destDir -Directory -Force
    if ($childDirs.Count -eq 1) {
        $nested = $childDirs[0].FullName
        Get-ChildItem -Path $nested -Force | ForEach-Object {
            Move-Item -Path $_.FullName -Destination $destDir -Force
        }
        Remove-Item -Recurse -Force $nested
    }
}
Write-Host "Installed plugin to $destDir"
Write-Host "Restart PyCharm to load the plugin."
