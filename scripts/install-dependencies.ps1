param(
    [switch]$WithPlugin,
    [ValidateSet('claude', 'codex', 'gemini', 'grok', 'none')]
    [string]$AgentCommand = 'claude'
)

$ErrorActionPreference = 'Stop'

function Update-MoeInstallPath([switch]$PreferInstalledNode) {
    # Package installers update the registry, but this PowerShell session keeps its old PATH.
    $knownPaths = @(
        (Join-Path $env:ProgramFiles 'nodejs'),
        (Join-Path $env:ProgramFiles 'Git\cmd'),
        (Join-Path $env:APPDATA 'npm'),
        (Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Links'),
        (Join-Path $env:USERPROFILE '.local\bin')
    ) | Where-Object { Test-Path -LiteralPath $_ -PathType Container }
    $paths = @($env:Path) + $knownPaths + @(
        [Environment]::GetEnvironmentVariable('Path', 'Machine'),
        [Environment]::GetEnvironmentVariable('Path', 'User')
    )
    if ($PreferInstalledNode) { $paths = @((Join-Path $env:ProgramFiles 'nodejs')) + $paths }
    $env:Path = (($paths -join ';') -split ';' | Where-Object { $_ } | Select-Object -Unique) -join ';'
}

function Add-MoeUserPath([string]$Directory) {
    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    $persistentPaths = @($userPath, [Environment]::GetEnvironmentVariable('Path', 'Machine')) -join ';'
    $expandedPaths = $persistentPaths -split ';' | ForEach-Object { [Environment]::ExpandEnvironmentVariables($_).TrimEnd('\') }
    if ($expandedPaths -contains $Directory.TrimEnd('\')) { return }
    $updatedPath = (@($userPath, $Directory) | Where-Object { $_ }) -join ';'
    # Registry cmdlet is mockable by the isolated installer harness; do not use setx (it truncates long PATH values).
    $changed = Set-ItemProperty -LiteralPath 'HKCU:\Environment' -Name Path -Value $updatedPath -PassThru
    if ($changed) {
        if (-not ('MoeInstaller.EnvironmentChange' -as [type])) {
            Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
namespace MoeInstaller {
    public static class EnvironmentChange {
        [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        public static extern IntPtr SendMessageTimeout(IntPtr window, uint message, UIntPtr wParam,
            string lParam, uint flags, uint timeout, out UIntPtr result);
    }
}
'@
        }
        $notificationResult = [UIntPtr]::Zero
        [MoeInstaller.EnvironmentChange]::SendMessageTimeout([IntPtr]0xffff, 0x001a, [UIntPtr]::Zero, 'Environment', 2, 1000, [ref]$notificationResult) | Out-Null
    }
    Write-Host 'Updated user PATH. Restart terminals and IDEs opened before this installation.'
}

function Test-MoeNodeVersion {
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) { return $false }
    try { $versionText = (node --version 2>$null | Out-String).Trim() } catch { return $false }
    if ($LASTEXITCODE -ne 0 -or $versionText -notmatch '^v?(\d+)\.(\d+)\.(\d+)$') { return $false }
    $major = [int]$Matches[1]
    $minor = [int]$Matches[2]
    return (($major -eq 22 -and $minor -ge 12) -or $major -eq 24 -or $major -eq 26)
}

function Install-MoeWinGetPackage([string]$Id) {
    if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
        throw "Installing $Id requires WinGet. Install or update Microsoft's App Installer from https://aka.ms/getwinget, reopen PowerShell, and rerun this installer."
    }
    Write-Host "Installing $Id with WinGet..."
    winget install --id $Id --exact --source winget --accept-package-agreements --accept-source-agreements --silent --disable-interactivity | Out-Host
    if ($LASTEXITCODE -ne 0) { throw "WinGet failed to install $Id (exit $LASTEXITCODE). Resolve the package-manager error above and rerun the installer." }
    Update-MoeInstallPath -PreferInstalledNode:($Id -eq 'OpenJS.NodeJS.LTS')
}

function Assert-MoeCommand([string]$Name) {
    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) { throw "$Name is still unavailable after installation. Reopen PowerShell and rerun the installer to refresh PATH." }
    & $Name --version | Out-Host
    if ($LASTEXITCODE -ne 0) { throw "$Name --version failed (exit $LASTEXITCODE). Repair that dependency and rerun the installer." }
}

function Find-MoeJdk17 {
    $candidates = @($env:JAVA_HOME)
    $javac = Get-Command javac -ErrorAction SilentlyContinue
    if ($javac -and $javac.Source) { $candidates += Split-Path -Parent (Split-Path -Parent $javac.Source) }
    foreach ($vendor in @('Eclipse Adoptium', 'Java', 'Microsoft', 'Zulu')) {
        $vendorPath = Join-Path $env:ProgramFiles $vendor
        if (Test-Path -LiteralPath $vendorPath) { $candidates += (Get-ChildItem -LiteralPath $vendorPath -Directory).FullName }
    }
    foreach ($candidate in ($candidates | Where-Object { $_ } | Select-Object -Unique)) {
        $release = Join-Path $candidate 'release'
        if ((Test-Path -LiteralPath $release) -and
            (Test-Path -LiteralPath (Join-Path $candidate 'bin\java.exe')) -and
            (Test-Path -LiteralPath (Join-Path $candidate 'bin\javac.exe')) -and
            ((Get-Content -LiteralPath $release -Raw) -match '(?m)^JAVA_VERSION="17(?:\.|\")')) {
            return $candidate
        }
    }
    return $null
}

function Install-MoeAgent([string]$Name) {
    if ($Name -eq 'none') { return }
    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        if ($Name -eq 'claude') {
            # Anthropic's native Windows package: https://code.claude.com/docs/en/setup
            Install-MoeWinGetPackage 'Anthropic.ClaudeCode'
        } else {
            $packages = @{ codex = '@openai/codex'; gemini = '@google/gemini-cli'; grok = '@xai-official/grok' }
            $package = $packages[$Name]
            Write-Host "Installing $Name..."
            npm install --global $package | Out-Host
            if ($LASTEXITCODE -ne 0) { throw "npm installation of $Name failed (exit $LASTEXITCODE). Check your npm global prefix permissions and rerun." }
            Update-MoeInstallPath
        }
    }
    Assert-MoeCommand $Name
    $loginCommand = @{ claude = 'claude auth login'; codex = 'codex login'; gemini = 'gemini'; grok = 'grok login' }[$Name]
    Write-Host "Agent CLI ready. Sign in to your account once: $loginCommand"
}

Write-Host 'Checking and installing Moe dependencies...'
Update-MoeInstallPath
if (-not (Test-MoeNodeVersion) -or -not (Get-Command npm -ErrorAction SilentlyContinue)) {
    Install-MoeWinGetPackage 'OpenJS.NodeJS.LTS'
}
if (-not (Test-MoeNodeVersion)) { throw 'A supported Node.js version is required (22.12+, 24 LTS, or 26). Reopen PowerShell after installation, or update your Node version manager to Node 24.' }
Assert-MoeCommand 'node'
Assert-MoeCommand 'npm'
$npmPrefix = (npm config get prefix | Out-String).Trim()
if ($LASTEXITCODE -ne 0) { throw "Could not read npm global prefix (exit $LASTEXITCODE)." }
if ($npmPrefix) {
    $env:Path = $npmPrefix + ';' + $env:Path
    Add-MoeUserPath $npmPrefix
}
if (-not (Get-Command git -ErrorAction SilentlyContinue)) { Install-MoeWinGetPackage 'Git.Git' }
Assert-MoeCommand 'git'
if ($WithPlugin) {
    $jdkHome = Find-MoeJdk17
    if (-not $jdkHome) {
        Install-MoeWinGetPackage 'EclipseAdoptium.Temurin.17.JDK'
        $jdkHome = Find-MoeJdk17
    }
    if (-not $jdkHome) { throw 'JDK 17 is required by the plugin build. Set JAVA_HOME to your JDK 17 installation and rerun.' }
    $env:JAVA_HOME = $jdkHome
    $env:Path = (Join-Path $jdkHome 'bin') + ';' + $env:Path
    Write-Host 'JDK 17 toolchain ready.'
}
Install-MoeAgent $AgentCommand
Write-Host 'Dependencies ready.'
