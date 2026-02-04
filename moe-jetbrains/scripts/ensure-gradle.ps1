param(
    [string]$ProjectRoot = (Split-Path -Parent $PSScriptRoot)
)

$ErrorActionPreference = "Stop"

$ProjectRoot = $ProjectRoot.Trim('"')
if ($ProjectRoot.EndsWith("\") -and $ProjectRoot.Length -gt 3) {
    $ProjectRoot = $ProjectRoot.TrimEnd("\")
}

function Resolve-GradleFromEnv {
    if ($env:MOE_GRADLE_BIN -and (Test-Path $env:MOE_GRADLE_BIN)) {
        return (Resolve-Path $env:MOE_GRADLE_BIN).Path
    }

    $gradleHome = $env:MOE_GRADLE_HOME
    if (-not $gradleHome) { $gradleHome = $env:GRADLE_HOME }
    if ($gradleHome) {
        $candidate = Join-Path $gradleHome "bin\gradle.bat"
        if (Test-Path $candidate) {
            return (Resolve-Path $candidate).Path
        }
    }

    $cmd = Get-Command gradle -ErrorAction SilentlyContinue
    if ($cmd) {
        return $cmd.Source
    }

    return $null
}

$envGradle = Resolve-GradleFromEnv
if ($envGradle) {
    Write-Output $envGradle
    exit 0
}

$props = Join-Path $ProjectRoot "gradle\wrapper\gradle-wrapper.properties"
if (-not (Test-Path $props)) {
    throw "gradle-wrapper.properties not found at $props"
}

$line = Select-String -Path $props -Pattern '^distributionUrl=' | Select-Object -First 1
if (-not $line) { throw "distributionUrl not found in gradle-wrapper.properties" }

$url = $line.Line.Substring($line.Line.IndexOf('=') + 1)
$url = $url -replace '\\', ''

$distFile = [System.IO.Path]::GetFileName($url)
$version = $distFile
if ($distFile -match '^gradle-(.+)-bin\.zip$') {
    $version = $Matches[1]
}

$distRoot = Join-Path $ProjectRoot ".gradle-dist"
$distDir = Join-Path $distRoot "gradle-$version"
$gradleBin = Join-Path $distDir "bin\gradle.bat"

if (Test-Path $gradleBin) {
    Write-Output $gradleBin
    exit 0
}

$gradleUserHome = $env:GRADLE_USER_HOME
if (-not $gradleUserHome) {
    $gradleUserHome = Join-Path $env:USERPROFILE ".gradle"
}
$wrapperRoot = Join-Path $gradleUserHome "wrapper\dists"
$wrapperDistRoot = Join-Path $wrapperRoot "gradle-$version-bin"
if (Test-Path $wrapperDistRoot) {
    $cached = Get-ChildItem -Recurse -Filter gradle.bat $wrapperDistRoot -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if ($cached) {
        Write-Output $cached.FullName
        exit 0
    }
}

if (-not (Test-Path $distRoot)) {
    New-Item -ItemType Directory -Path $distRoot | Out-Null
}

$tmpZip = Join-Path $distRoot $distFile
$localZip = $env:MOE_GRADLE_ZIP
if ($localZip -and (Test-Path $localZip)) {
    Copy-Item -Path $localZip -Destination $tmpZip -Force
} else {
    try {
        Invoke-WebRequest -Uri $url -OutFile $tmpZip
    } catch {
        throw @"
Gradle download failed.

Provide a local Gradle install or zip and retry:
- Set MOE_GRADLE_BIN to gradle.bat
- or set MOE_GRADLE_HOME / GRADLE_HOME
- or set MOE_GRADLE_ZIP to a local gradle-$version-bin.zip

Alternative: build the plugin elsewhere and pass -PluginZip to scripts/install-all.ps1.
"@
    }
}

Add-Type -AssemblyName System.IO.Compression.FileSystem
try {
    [System.IO.Compression.ZipFile]::ExtractToDirectory($tmpZip, $distRoot)
} catch {
    Expand-Archive -Path $tmpZip -DestinationPath $distRoot -Force
}

if (-not (Test-Path $gradleBin)) {
    throw "Gradle not found at $gradleBin"
}

Write-Output $gradleBin
