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
    [switch]$AutoClaim = $true,

    # Delay in seconds before starting (useful when launching multiple agents)
    [int]$Delay = 0
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

function Get-MoeInstallPath {
    $configPath = Join-Path $env:USERPROFILE ".moe\\config.json"
    if (-not (Test-Path $configPath)) { return $null }
    try {
        $config = Get-Content -Raw -Path $configPath | ConvertFrom-Json
        $installPath = $config.installPath
        if (-not $installPath) { return $null }
        $canary = Join-Path $installPath "packages\\moe-daemon\\dist\\index.js"
        if (-not (Test-Path $canary)) { return $null }
        return $installPath
    } catch {
        return $null
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

# Build MCP config for moe-proxy
$proxyScript = $env:MOE_PROXY_PATH
if ($proxyScript) { $proxyScript = $proxyScript.Trim('"') }
if (-not $proxyScript) {
    $root = Resolve-Path (Join-Path $PSScriptRoot "..")
    $proxyScript = Join-Path $root "packages\\moe-proxy\\dist\\index.js"
}
if (-not (Test-Path $proxyScript)) {
    # Fall back to global install config
    $globalInstall = Get-MoeInstallPath
    if ($globalInstall) {
        $proxyScript = Join-Path $globalInstall "packages\\moe-proxy\\dist\\index.js"
    }
}
if (-not (Test-Path $proxyScript)) {
    Write-Error "Moe proxy script not found: $proxyScript. Run: cd packages/moe-proxy && npm run build"
    exit 1
}

# Write MCP config to a temp file (more reliable than inline JSON on Windows)
$mcpConfigObj = @{
    mcpServers = @{
        moe = @{
            command = "node"
            args = @($proxyScript)
            env = @{
                MOE_PROJECT_PATH = $projectPath.ToString()
            }
        }
    }
}
# Use unique temp file to prevent collision when multiple agents run
$mcpConfigFile = Join-Path $env:TEMP "moe-mcp-config-$Role-$PID.json"
$mcpConfigObj | ConvertTo-Json -Depth 4 | Set-Content -Path $mcpConfigFile -Encoding UTF8

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
        $daemonScript = $env:MOE_DAEMON_PATH
        if ($daemonScript) { $daemonScript = $daemonScript.Trim('"') }
        if (-not $daemonScript) {
            $root = Resolve-Path (Join-Path $PSScriptRoot "..")
            $daemonScript = Join-Path $root "packages\\moe-daemon\\dist\\index.js"
        }
        if (-not (Test-Path $daemonScript)) {
            # Fall back to global install config
            $globalInstall = Get-MoeInstallPath
            if ($globalInstall) {
                $daemonScript = Join-Path $globalInstall "packages\\moe-daemon\\dist\\index.js"
            }
        }
        if (-not (Test-Path $daemonScript)) {
            Write-Error "Moe daemon script not found: $daemonScript"
            exit 1
        }
        Write-Host "Starting Moe daemon for $projectPath..."
        Start-Process -FilePath "node" -ArgumentList "`"$daemonScript`" start --project `"$projectPath`"" -WindowStyle Hidden

        # Wait for daemon to be ready (poll for up to 10 seconds)
        $maxWait = 10
        $waited = 0
        while ($waited -lt $maxWait) {
            Start-Sleep -Seconds 1
            $waited++

            if (Test-Path $daemonInfoPath) {
                try {
                    $newInfo = Get-Content -Raw -Path $daemonInfoPath | ConvertFrom-Json
                    $proc = Get-Process -Id $newInfo.pid -ErrorAction SilentlyContinue
                    if ($proc) {
                        Write-Host "Daemon started (waited ${waited}s)"
                        break
                    }
                } catch {
                    # Continue waiting
                }
            }
            Write-Host "Waiting for daemon... (${waited}/${maxWait}s)"
        }

        if ($waited -ge $maxWait) {
            Write-Error "Daemon failed to start within ${maxWait}s"
            exit 1
        }
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

# Load role-specific instructions from .moe/roles/
$roleDoc = ""
$roleDocPath = Join-Path $moeDir "roles\\$Role.md"
if (Test-Path $roleDocPath) {
    $roleDoc = Get-Content -Raw -Path $roleDocPath
    Write-Host "Loaded role guide from $roleDocPath"
}

Write-Host "MCP config written to: $mcpConfigFile"

if ($Delay -gt 0) {
    Write-Host "Waiting $Delay seconds before starting..."
    Start-Sleep -Seconds $Delay
}

Write-Host "Launching Claude CLI..."

if ($AutoClaim) {
    $systemAppend = @"
Role: $Role. Always use Moe MCP tools. Start by claiming the next task for your role.

$roleDoc
"@
    $prompt = "Call moe.claim_next_task $claimJson. If hasNext is false, say: 'No tasks in $Role queue' and wait."
    Write-Host "Command: $Command --mcp-config $mcpConfigFile --append-system-prompt <...> `"$prompt`""
    & $Command @CommandArgs --mcp-config $mcpConfigFile --append-system-prompt $systemAppend $prompt
} else {
    $systemAppend = @"
Role: $Role. Always use Moe MCP tools.

$roleDoc
"@
    Write-Host "Command: $Command --mcp-config $mcpConfigFile --append-system-prompt <...>"
    & $Command @CommandArgs --mcp-config $mcpConfigFile --append-system-prompt $systemAppend
}
