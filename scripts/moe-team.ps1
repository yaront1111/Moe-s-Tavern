param(
    [string]$Project,
    [string]$ProjectName,

    # Delay in seconds BETWEEN launching each window
    [int]$DelayBetween = 1,

    # Agent command and args (claude, codex, gemini, or custom path)
    [string]$Command = "claude",
    [string[]]$CommandArgs = @(),
    [string]$Team = "",

    # Which roles to start (default: all)
    [switch]$NoWorker,
    [switch]$NoQa,
    [switch]$NoArchitect
)

$scriptDir = $PSScriptRoot
$agentScript = Join-Path $scriptDir "moe-agent.ps1"

if (-not (Test-Path $agentScript)) {
    Write-Error "moe-agent.ps1 not found at $agentScript"
    exit 1
}

function Load-Registry {
    $path = Join-Path $env:USERPROFILE ".moe\\projects.json"
    if (-not (Test-Path $path)) { return @() }
    try {
        return Get-Content -Raw -Path $path | ConvertFrom-Json
    } catch {
        return @()
    }
}

function Quote-ForCommand {
    param([string]$Value)
    if ($null -eq $Value) { return '""' }
    $escaped = $Value -replace '`', '``' -replace '"', '``"'
    return "`"$escaped`""
}

# Build project argument
$projectArg = ""
if ($Project) {
    $projectArg = "-Project `"$Project`""
} elseif ($ProjectName) {
    $projectArg = "-ProjectName `"$ProjectName`""
} else {
    Write-Error "Provide -Project or -ProjectName"
    exit 1
}

$commandArg = "-Command " + (Quote-ForCommand $Command)
if ($CommandArgs -and $CommandArgs.Count -gt 0) {
    $argsQuoted = $CommandArgs | ForEach-Object { Quote-ForCommand $_ }
    $commandArg += " -CommandArgs " + ($argsQuoted -join " ")
}

if (-not $Team) {
    $teamPath = $null
    if ($Project) {
        $teamPath = Resolve-Path -Path $Project -ErrorAction SilentlyContinue
    } elseif ($ProjectName) {
        $projects = Load-Registry
        $match = $projects | Where-Object { $_.name -eq $ProjectName } | Select-Object -First 1
        if ($match) { $teamPath = $match.path }
    }
    if ($teamPath) {
        $teamLeaf = Split-Path -Leaf $teamPath
        if ([string]::IsNullOrWhiteSpace($teamLeaf)) {
            $teamLeaf = "Moe Team"
        }
        $Team = $teamLeaf
    } else {
        $Team = "Moe Team"
    }
}

$teamArg = "-Team " + (Quote-ForCommand $Team)

Write-Host "=== Moe Agent Team Launcher ===" -ForegroundColor Cyan
Write-Host "Delay between windows: ${DelayBetween}s"
Write-Host "Team: $Team"
Write-Host ""

$launched = 0

# Launch Worker
if (-not $NoWorker) {
    Write-Host "Starting WORKER agent..." -ForegroundColor Green
    $workerCmd = "cd `"$scriptDir`"; .\moe-agent.ps1 -Role worker $projectArg $commandArg $teamArg"
    Start-Process powershell -ArgumentList "-NoExit", "-Command", $workerCmd
    $launched++

    if ((-not $NoQa) -or (-not $NoArchitect)) {
        Write-Host "Waiting ${DelayBetween}s before next agent..." -ForegroundColor DarkGray
        Start-Sleep -Seconds $DelayBetween
    }
}

# Launch QA
if (-not $NoQa) {
    Write-Host "Starting QA agent..." -ForegroundColor Yellow
    $qaCmd = "cd `"$scriptDir`"; .\moe-agent.ps1 -Role qa $projectArg $commandArg $teamArg"
    Start-Process powershell -ArgumentList "-NoExit", "-Command", $qaCmd
    $launched++

    if (-not $NoArchitect) {
        Write-Host "Waiting ${DelayBetween}s before next agent..." -ForegroundColor DarkGray
        Start-Sleep -Seconds $DelayBetween
    }
}

# Launch Architect
if (-not $NoArchitect) {
    Write-Host "Starting ARCHITECT agent..." -ForegroundColor Magenta
    $archCmd = "cd `"$scriptDir`"; .\moe-agent.ps1 -Role architect $projectArg $commandArg $teamArg"
    Start-Process powershell -ArgumentList "-NoExit", "-Command", $archCmd
    $launched++
}

Write-Host ""
Write-Host "Launched $launched agent(s) in separate windows." -ForegroundColor Cyan
