param(
    [switch]$InstallPlugin,
    [switch]$BuildPlugin,
    [Alias('PyCharmVersion')]
    [string]$IdeVersion = "",
    [string]$PluginZip = "",
    [ValidateSet('claude', 'codex', 'gemini', 'grok', 'none')]
    [string]$AgentCommand = 'claude'
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
# Resolve a supplied relative archive before entering the package directories.
if ($PluginZip) { $PluginZip = (Resolve-Path -LiteralPath $PluginZip).Path }

function Install-NodePackage([string]$Name) {
    Write-Host "Installing $Name..."
    Set-Location -LiteralPath (Join-Path $root "packages\$Name")
    npm install
    if ($LASTEXITCODE -ne 0) { throw "npm install failed for $Name (exit $LASTEXITCODE)" }
    npm run build
    if ($LASTEXITCODE -ne 0) { throw "npm run build failed for $Name (exit $LASTEXITCODE)" }
    npm link
    if ($LASTEXITCODE -ne 0) { throw "npm link failed for $Name (exit $LASTEXITCODE). Check your npm global prefix permissions." }
}

function Resolve-IdeDirectory {
    $jbRoot = Join-Path $env:APPDATA "JetBrains"
    if ($IdeVersion) {
        if ($IdeVersion -notmatch '^[A-Za-z][A-Za-z0-9.\-]*$') { throw "-IdeVersion must be a JetBrains config folder name." }
        $preferred = Join-Path $jbRoot $IdeVersion
        if (-not (Test-Path -LiteralPath $preferred -PathType Container)) { throw "JetBrains config not found at $preferred. Open the IDE once, then retry." }
        return $preferred
    }
    $ide = if (Test-Path -LiteralPath $jbRoot) {
        Get-ChildItem -LiteralPath $jbRoot -Directory |
            Where-Object { $_.Name -match '^(IntelliJIdea|IdeaIC|PyCharm|PyCharmCE|WebStorm|GoLand|CLion|Rider|RubyMine|PhpStorm|DataGrip|RustRover|Aqua)\d' } |
            Sort-Object LastWriteTime -Descending | Select-Object -First 1
    }
    if (-not $ide) { throw "No JetBrains IDE config found. Open your IDE once, or install without -InstallPlugin and use Plugins > Install Plugin from Disk." }
    Write-Host "Using JetBrains config $($ide.Name); select another with -IdeVersion."
    return $ide.FullName
}

function Resolve-PluginArchive {
    if ($PluginZip) { return Get-Item -LiteralPath $PluginZip }
    $bundled = Join-Path $root "installer\assets\moe-jetbrains.zip"
    if (Test-Path -LiteralPath $bundled) { return Get-Item -LiteralPath $bundled }
    Write-Host "Building Moe plugin..."
    $project = Join-Path $root "moe-jetbrains"
    $ensureGradle = Join-Path $project "scripts\ensure-gradle.ps1"
    if (Test-Path -LiteralPath $ensureGradle) {
        $gradleBin = & $ensureGradle -ProjectRoot $project
        if ($LASTEXITCODE -ne 0) { throw "Gradle setup failed (exit $LASTEXITCODE)." }
    } else {
        $gradleBin = Join-Path $project "gradlew.bat"
    }
    if (-not $gradleBin -or -not (Test-Path -LiteralPath $gradleBin)) { throw "Gradle wrapper not found. Build the plugin in your IDE or provide -PluginZip." }
    Set-Location -LiteralPath $project
    & $gradleBin buildPlugin | Out-Host
    if ($LASTEXITCODE -ne 0) { throw "Gradle buildPlugin failed (exit $LASTEXITCODE). Existing plugin was preserved." }
    $zip = Get-ChildItem -Path (Join-Path $project "build\distributions\*.zip") |
        Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if (-not $zip) { throw "Plugin zip not found in build\distributions." }
    return $zip
}

function Assert-InstallChild([string]$Path, [string]$Parent) {
    $parentPath = [IO.Path]::GetFullPath($Parent).TrimEnd('\') + '\'
    if (-not [IO.Path]::GetFullPath($Path).StartsWith($parentPath, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Installer path is outside its target directory: $Path"
    }
}

function Install-JetBrainsPlugin {
    $pluginRoot = Resolve-IdeDirectory
    $zip = Resolve-PluginArchive
    $pluginsDir = Join-Path $pluginRoot "plugins"
    New-Item -ItemType Directory -Path $pluginsDir -Force | Out-Null
    $destDir = Join-Path $pluginsDir "moe-jetbrains"
    $backup = Join-Path $pluginsDir ("moe-jetbrains-backup-" + [guid]::NewGuid().ToString('N'))
    $tmp = Join-Path $env:TEMP ("moe-jetbrains-install-" + [guid]::NewGuid().ToString('N'))
    Assert-InstallChild $destDir $pluginsDir
    Assert-InstallChild $backup $pluginsDir
    Assert-InstallChild $tmp $env:TEMP
    New-Item -ItemType Directory -Path $tmp | Out-Null
    try {
        Expand-Archive -LiteralPath $zip.FullName -DestinationPath $tmp
        $payload = if (Test-Path -LiteralPath (Join-Path $tmp 'lib') -PathType Container) { $tmp } else {
            (Get-ChildItem -LiteralPath $tmp -Directory | Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'lib') -PathType Container } | Select-Object -First 1).FullName
        }
        if (-not $payload) { throw "Plugin zip layout unexpected. Expected lib/ at root or within the plugin folder. Existing plugin was preserved." }
        if ($payload -ne $tmp) { Assert-InstallChild $payload $tmp }
        if (Test-Path -LiteralPath $destDir) { Move-Item -LiteralPath $destDir -Destination $backup }
        try { Move-Item -LiteralPath $payload -Destination $destDir } catch {
            if (Test-Path -LiteralPath $backup) {
                if (Test-Path -LiteralPath $destDir) { Remove-Item -LiteralPath $destDir -Recurse -Force }
                Move-Item -LiteralPath $backup -Destination $destDir
            }
            throw
        }
        if (Test-Path -LiteralPath $backup) { Remove-Item -LiteralPath $backup -Recurse -Force }
    } finally {
        if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Recurse -Force }
    }
    Write-Host "Installed plugin to $destDir"
    Write-Host "Restart your JetBrains IDE to load the plugin."
}

Push-Location
try {
    $buildsPlugin = ($InstallPlugin -or $BuildPlugin) -and -not $PluginZip -and -not (Test-Path -LiteralPath (Join-Path $root 'installer\assets\moe-jetbrains.zip'))
    & (Join-Path $PSScriptRoot 'install-dependencies.ps1') -AgentCommand $AgentCommand -WithPlugin:$buildsPlugin
    Install-NodePackage 'moe-daemon'
    Install-NodePackage 'moe-proxy'
    if ($InstallPlugin) { Install-JetBrainsPlugin }
    elseif ($BuildPlugin) {
        $builtArchive = Resolve-PluginArchive
        Write-Host "Plugin archive: $($builtArchive.FullName)"
        Write-Host 'In your JetBrains IDE: Settings > Plugins > Install Plugin from Disk, then select that archive.'
    }

    $moeHome = Join-Path $env:USERPROFILE '.moe'
    New-Item -ItemType Directory -Path $moeHome -Force | Out-Null
    $daemonPkg = Get-Content -LiteralPath (Join-Path $root 'packages\moe-daemon\package.json') -Raw | ConvertFrom-Json
    $configJson = @{
        installPath = $root
        version = $daemonPkg.version
        updatedAt = (Get-Date -Format 'o')
    } | ConvertTo-Json
    [IO.File]::WriteAllText((Join-Path $moeHome 'config.json'), $configJson, (New-Object System.Text.UTF8Encoding($false)))
    Write-Host "Wrote global config to $moeHome\config.json"
} finally {
    Pop-Location
}

Write-Host 'Done. Next steps:'
Write-Host '1) Initialize your project: moe-daemon init --project <path>'
if ($AgentCommand -ne 'none') {
    Write-Host "2) Launch an architect in another terminal: powershell -NoProfile -ExecutionPolicy Bypass -File `"$PSScriptRoot\moe-agent.ps1`" -Role architect -Command $AgentCommand -Project <path>"
}
Write-Host '3) Optional JetBrains plugin: re-run with -BuildPlugin to build its ZIP (JDK 17 is installed automatically), then install it through your IDE.'
