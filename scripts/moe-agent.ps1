param(
    [ValidateSet("architect", "worker", "qa")]
    [string]$Role = "worker",

    [string]$Project,
    [string]$ProjectName,
    [string]$WorkerId,

    [string]$Command = "claude",
    [string[]]$CommandArgs = @(),

    [switch]$ListProjects,
    [switch]$NoStartDaemon,
    [switch]$AutoClaim = $true
)

function Load-Registry {
    $path = Join-Path $env:USERPROFILE ".moe\\projects.json"
    if (-not (Test-Path $path)) { return @() }
    try {
        return Get-Content -Raw -Path $path | ConvertFrom-Json
    } catch {
        return @()
    }
}

if ($ListProjects) {
    $projects = Load-Registry
    if (-not $projects -or $projects.Count -eq 0) {
        Write-Host "No Moe projects registered."
        exit 0
    }
    $projects | Sort-Object lastOpenedAt -Descending | Format-Table name, path, lastOpenedAt -AutoSize
    exit 0
}

if (-not $Project) {
    if ($ProjectName) {
        $projects = Load-Registry
        $match = $projects | Where-Object { $_.name -eq $ProjectName } | Select-Object -First 1
        if ($null -eq $match) {
            Write-Error "Project name not found in registry: $ProjectName"
            exit 1
        }
        $Project = $match.path
    } else {
        Write-Error "Provide -Project or -ProjectName. Use -ListProjects to see registered projects."
        exit 1
    }
}

$projectPath = Resolve-Path -Path $Project -ErrorAction SilentlyContinue
if (-not $projectPath) {
    Write-Error "Project path not found: $Project"
    exit 1
}

$moeDir = Join-Path $projectPath ".moe"
if (-not (Test-Path $moeDir)) {
    Write-Error "Project is not initialized for Moe: $projectPath"
    exit 1
}

$env:MOE_PROJECT_PATH = $projectPath
if (-not $WorkerId) {
    $WorkerId = "$Role"
}
$env:MOE_WORKER_ID = $WorkerId

if (-not $NoStartDaemon) {
    $daemonInfoPath = Join-Path $moeDir "daemon.json"
    $running = $false
    if (Test-Path $daemonInfoPath) {
        try {
            $info = Get-Content -Raw -Path $daemonInfoPath | ConvertFrom-Json
            $proc = Get-Process -Id $info.pid -ErrorAction SilentlyContinue
            if ($proc) { $running = $true }
        } catch {
            $running = $false
        }
    }

    if (-not $running) {
        $root = Resolve-Path (Join-Path $PSScriptRoot "..")
        $daemonScript = Join-Path $root "packages\\moe-daemon\\dist\\index.js"
        if (-not (Test-Path $daemonScript)) {
            Write-Error "Moe daemon script not found: $daemonScript"
            exit 1
        }
        Write-Host "Starting Moe daemon for $projectPath..."
        Start-Process -FilePath "node" -ArgumentList "`"$daemonScript`" start --project `"$projectPath`"" -WindowStyle Hidden
        Start-Sleep -Seconds 1
    }
}

$statusMap = @{
    architect = @("PLANNING")
    worker    = @("WORKING")
    qa        = @("REVIEW")
}
$statuses = $statusMap[$Role]

Write-Host "Role: $Role"
Write-Host "Project: $projectPath"
Write-Host "WorkerId: $WorkerId"
Write-Host "AutoClaim: $AutoClaim"
Write-Host "Suggested first call:"
$claimJson = ConvertTo-Json @{ statuses = $statuses; workerId = $WorkerId } -Compress
Write-Host ("moe.claim_next_task " + $claimJson)
Write-Host ""

if ($AutoClaim) {
    $systemAppend = "Role: $Role. Always use Moe MCP tools. Start by claiming the next task for your role."
    $prompt = "Call moe.claim_next_task $claimJson. If hasNext is false, say: 'No tasks in $Role queue' and wait."
    & $Command @CommandArgs --append-system-prompt $systemAppend $prompt
} else {
    & $Command @CommandArgs
}
