param(
    [string]$ProjectRoot = (Split-Path -Parent $PSScriptRoot)
)

$ErrorActionPreference = "Stop"

$ProjectRoot = $ProjectRoot.Trim('"')
if ($ProjectRoot.EndsWith("\") -and $ProjectRoot.Length -gt 3) {
    $ProjectRoot = $ProjectRoot.TrimEnd("\")
}

$wrapperDir = Join-Path $ProjectRoot "gradle\wrapper"
$props = Join-Path $wrapperDir "gradle-wrapper.properties"
$dest = Join-Path $wrapperDir "gradle-wrapper.jar"

if (Test-Path $dest) {
    try {
        Add-Type -AssemblyName System.IO.Compression.FileSystem
        $jarZip = [System.IO.Compression.ZipFile]::OpenRead($dest)
        $hasMain = $false
        $hasDownload = $false
        foreach ($e in $jarZip.Entries) {
            if ($e.FullName -eq "org/gradle/wrapper/GradleWrapperMain.class") {
                $hasMain = $true
                break
            }
            if ($e.FullName -eq "org/gradle/wrapper/IDownload.class") {
                $hasDownload = $true
            }
        }
        $jarZip.Dispose()
        if ($hasMain -and $hasDownload) {
            exit 0
        }
        if ($hasMain) {
            $sharedOk = $false
            $shared = Join-Path $wrapperDir "gradle-wrapper-shared.jar"
            if (Test-Path $shared) {
                try {
                    $sharedZip = [System.IO.Compression.ZipFile]::OpenRead($shared)
                    foreach ($e in $sharedZip.Entries) {
                        if ($e.FullName -eq "org/gradle/wrapper/IDownload.class") {
                            $sharedOk = $true
                            break
                        }
                    }
                    $sharedZip.Dispose()
                } catch {
                    # ignore
                }
            }

            $cliOk = $false
            $cli = Join-Path $wrapperDir "gradle-cli.jar"
            if (Test-Path $cli) {
                try {
                    $cliZip = [System.IO.Compression.ZipFile]::OpenRead($cli)
                    foreach ($e in $cliZip.Entries) {
                        if ($e.FullName -eq "org/gradle/cli/CommandLineParser.class") {
                            $cliOk = $true
                            break
                        }
                    }
                    $cliZip.Dispose()
                } catch {
                    # ignore
                }
            }

            if ($sharedOk -and $cliOk) {
                exit 0
            }
        }
    } catch {
        # If inspection fails, re-download
    }
    Remove-Item -Force $dest
}

if (-not (Test-Path $props)) {
    throw "gradle-wrapper.properties not found at $props"
}

$line = Select-String -Path $props -Pattern '^distributionUrl=' | Select-Object -First 1
if (-not $line) {
    throw "distributionUrl not found in gradle-wrapper.properties"
}

$url = $line.Line.Substring($line.Line.IndexOf('=') + 1)
$url = $url -replace '\\', ''

$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("moe-gradle-" + [System.Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $tmp | Out-Null
$zip = Join-Path $tmp "gradle.zip"

Invoke-WebRequest -Uri $url -OutFile $zip

Add-Type -AssemblyName System.IO.Compression.FileSystem
$extractDir = Join-Path $tmp "extract"
New-Item -ItemType Directory -Path $extractDir | Out-Null

try {
    [System.IO.Compression.ZipFile]::ExtractToDirectory($zip, $extractDir)
} catch {
    # Fallback to Expand-Archive if ExtractToDirectory is not available
    Expand-Archive -Path $zip -DestinationPath $extractDir -Force
}

$jars = Get-ChildItem -Path $extractDir -Recurse -Filter "*.jar"
if (-not $jars -or $jars.Count -eq 0) {
    throw "No jars found in $url"
}

$mainJar = $null
$sharedJar = $null
$cliJar = $null
foreach ($j in $jars) {
    try {
        $jarZip = [System.IO.Compression.ZipFile]::OpenRead($j.FullName)
        foreach ($e in $jarZip.Entries) {
            if ($e.FullName -eq "org/gradle/wrapper/GradleWrapperMain.class") {
                $mainJar = $j
            }
            if ($e.FullName -eq "org/gradle/wrapper/IDownload.class") {
                $sharedJar = $j
            }
            if ($e.FullName -eq "org/gradle/cli/CommandLineParser.class") {
                $cliJar = $j
            }
        }
        $jarZip.Dispose()
    } catch {
        # ignore
    }
}

if (-not $mainJar) {
    $mainJar = $jars | Where-Object { $_.Name -match 'gradle-wrapper' -and $_.Name -notmatch 'shared' } | Select-Object -First 1
}
if (-not $mainJar) {
    $mainJar = $jars | Select-Object -First 1
}

if (-not $sharedJar) {
    $sharedJar = $jars | Where-Object { $_.Name -match 'gradle-wrapper-shared' } | Select-Object -First 1
}
if (-not $cliJar) {
    $cliJar = $jars | Where-Object { $_.Name -match 'gradle-cli' } | Select-Object -First 1
}

New-Item -ItemType Directory -Path $wrapperDir -Force | Out-Null
Copy-Item -Path $mainJar.FullName -Destination $dest -Force
if ($sharedJar) {
    Copy-Item -Path $sharedJar.FullName -Destination (Join-Path $wrapperDir "gradle-wrapper-shared.jar") -Force
}
if ($cliJar) {
    Copy-Item -Path $cliJar.FullName -Destination (Join-Path $wrapperDir "gradle-cli.jar") -Force
}

Remove-Item -Recurse -Force $tmp
Write-Host "Installed gradle-wrapper.jar"
