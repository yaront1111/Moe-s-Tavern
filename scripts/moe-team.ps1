param(
    [string]$Project,
    [string]$ProjectName,

    # Delay in seconds BETWEEN launching each window
    [int]$DelayBetween = 1,

    # Agent command and args (claude, codex, gemini, grok, or custom path)
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

if (-not (Test-Path -LiteralPath $agentScript)) {
    Write-Error "moe-agent.ps1 not found at $agentScript"
    exit 1
}

function Load-Registry {
    $path = Join-Path $env:USERPROFILE ".moe\\projects.json"
    if (-not (Test-Path -LiteralPath $path)) { return @() }
    try {
        return Get-Content -Raw -LiteralPath $path | ConvertFrom-Json
    } catch {
        return @()
    }
}

function Quote-ForCommand {
    param([string]$Value)
    # A single-quoted PowerShell literal: nothing in it expands, and the escape
    # doubles every character PowerShell reads as a single quote (the ASCII one
    # and the four curly ones), so no value can close the literal early.
    return "'" + [System.Management.Automation.Language.CodeGeneration]::EscapeSingleQuotedStringContent($Value) + "'"
}

# Build project argument. The agent windows do not start in this caller's
# location (see Start-AgentWindow), so a relative -Project is made absolute
# here. A path that does not exist goes as given: moe-agent.ps1 reports it.
$projectArg = ""
$projectDir = $null
if ($Project) {
    $resolvedProject = Resolve-Path -LiteralPath $Project -ErrorAction Ignore
    if ($resolvedProject) {
        $Project = $resolvedProject.ProviderPath
        $projectDir = $Project
    }
    $projectArg = "-Project " + (Quote-ForCommand $Project)
} elseif ($ProjectName) {
    $projectArg = "-ProjectName " + (Quote-ForCommand $ProjectName)
    $projects = Load-Registry
    $match = $projects | Where-Object { $_.name -eq $ProjectName } | Select-Object -First 1
    if ($match) { $projectDir = $match.path }
} else {
    Write-Error "Provide -Project or -ProjectName"
    exit 1
}

$commandArg = "-Command " + (Quote-ForCommand $Command)
if ($CommandArgs -and $CommandArgs.Count -gt 0) {
    # Comma-separated: a [string[]] parameter takes one argument, so a second
    # space-separated entry bound to the agent's next positional parameter.
    $argsQuoted = $CommandArgs | ForEach-Object { Quote-ForCommand $_ }
    $commandArg += " -CommandArgs " + ($argsQuoted -join ",")
}

if (-not $Team) {
    $teamPath = $projectDir
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

# Start-Process joins -ArgumentList with single spaces and quotes nothing, and
# the child's argv parser drops embedded double quotes, so a value with a space
# was split across moe-agent.ps1's positional parameters (task-c4f17045).
# -EncodedCommand (Base64 of UTF-16LE) reaches the child's PowerShell parser
# intact. The child starts in the project directory, where moe-agent.sh's
# agents run: a ps1 claude runs in its window's location, and the account
# trust step accepts only a launch inside the project. With no project
# directory on disk it starts in the scripts dir, never in the caller's location.
# Windows PowerShell started in a directory whose path has [ or ] takes $PSHOME
# as its location instead, so the command first sets it again, literally. Its
# text comes from a script block, which keeps the cmdlet in code for the G1
# scan in literal-project-path.test.mjs.
$launchDir = $scriptDir
if ($projectDir -and (Test-Path -LiteralPath $projectDir -PathType Container)) { $launchDir = $projectDir }
$enterLaunchDir = { Set-Location -LiteralPath $args[0] }
function Start-AgentWindow {
    param([string]$RoleName)
    $line = "& {$enterLaunchDir} $(Quote-ForCommand $launchDir); & $(Quote-ForCommand $agentScript) -Role $RoleName $projectArg $commandArg $teamArg"
    $encoded = [Convert]::ToBase64String([System.Text.Encoding]::Unicode.GetBytes($line))
    try {
        Start-Process powershell -ArgumentList "-NoExit", "-EncodedCommand", $encoded -WorkingDirectory ([System.Management.Automation.WildcardPattern]::Escape($launchDir)) -ErrorAction Stop
        return $true
    } catch {
        Write-Host "Failed to start the $RoleName agent: $($_.Exception.Message)" -ForegroundColor Red
        return $false
    }
}

Write-Host "=== Moe Agent Team Launcher ===" -ForegroundColor Cyan
Write-Host "Delay between windows: ${DelayBetween}s"
Write-Host "Team: $Team"
Write-Host ""

$launched = 0
$failed = 0

# Launch Worker
if (-not $NoWorker) {
    Write-Host "Starting WORKER agent..." -ForegroundColor Green
    if (Start-AgentWindow "worker") { $launched++ } else { $failed++ }

    if ((-not $NoQa) -or (-not $NoArchitect)) {
        Write-Host "Waiting ${DelayBetween}s before next agent..." -ForegroundColor DarkGray
        Start-Sleep -Seconds $DelayBetween
    }
}

# Launch QA
if (-not $NoQa) {
    Write-Host "Starting QA agent..." -ForegroundColor Yellow
    if (Start-AgentWindow "qa") { $launched++ } else { $failed++ }

    if (-not $NoArchitect) {
        Write-Host "Waiting ${DelayBetween}s before next agent..." -ForegroundColor DarkGray
        Start-Sleep -Seconds $DelayBetween
    }
}

# Launch Architect
if (-not $NoArchitect) {
    Write-Host "Starting ARCHITECT agent..." -ForegroundColor Magenta
    if (Start-AgentWindow "architect") { $launched++ } else { $failed++ }
}

Write-Host ""
Write-Host "Launched $launched agent(s) in separate windows." -ForegroundColor Cyan
if ($failed -gt 0) {
    Write-Host "$failed agent(s) failed to start." -ForegroundColor Red
    exit 1
}
