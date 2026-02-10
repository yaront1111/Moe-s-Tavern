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
    [int]$Delay = 0,

    # Seconds to wait between polling for new tasks (0 or -NoLoop to disable)
    [int]$PollInterval = 30,

    # Disable polling loop - run once and exit
    [switch]$NoLoop,

    # Team name to auto-create/join (enables parallel same-role workers)
    [string]$Team,

    # Use codex exec mode (non-interactive, headless) instead of interactive TUI
    [switch]$CodexExec
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

function Split-CommandLine {
    param([string]$Line)
    if (-not $Line) { return @() }

    $tokens = @()
    $current = ""
    $inSingle = $false
    $inDouble = $false
    $escapeNext = $false

    foreach ($ch in $Line.ToCharArray()) {
        if ($escapeNext) {
            $current += $ch
            $escapeNext = $false
            continue
        }
        if ($inDouble -and $ch -eq '`') {
            $escapeNext = $true
            continue
        }
        if (-not $inSingle -and $ch -eq '"') {
            $inDouble = -not $inDouble
            continue
        }
        if (-not $inDouble -and $ch -eq "'") {
            $inSingle = -not $inSingle
            continue
        }
        if (-not $inSingle -and -not $inDouble -and [char]::IsWhiteSpace($ch)) {
            if ($current.Length -gt 0) {
                $tokens += $current
                $current = ""
            }
            continue
        }
        $current += $ch
    }

    if ($current.Length -gt 0) { $tokens += $current }
    return $tokens
}

function Resolve-CommandParts {
    param(
        [string]$Cmd,
        [string[]]$CmdArgs
    )

    $resolvedCmd = $Cmd
    $resolvedArgs = $CmdArgs

    $hasArgs = $CmdArgs -and $CmdArgs.Count -gt 0
    if (-not $hasArgs -and $Cmd -match '\s') {
        # Only split if the full string isn't an existing path (e.g., "C:\Program Files\...").
        if (-not (Test-Path $Cmd)) {
            $split = Split-CommandLine $Cmd
            if ($split.Count -gt 0) {
                $resolvedCmd = $split[0]
                if ($split.Count -gt 1) {
                    $resolvedArgs = $split[1..($split.Count - 1)]
                    Write-Host "Parsed -Command into executable + args. Prefer -CommandArgs for clarity." -ForegroundColor Yellow
                }
            }
        }
    }

    return [pscustomobject]@{
        Command     = $resolvedCmd
        CommandArgs = $resolvedArgs
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

if ($PSBoundParameters.ContainsKey('Team') -and [string]::IsNullOrWhiteSpace($Team)) {
    $projectLeaf = Split-Path -Leaf $projectPath
    if ([string]::IsNullOrWhiteSpace($projectLeaf)) {
        $projectLeaf = "Moe Team"
    }
    $Team = $projectLeaf
}

$moeDir = Join-Path $projectPath ".moe"
if (-not (Test-Path $moeDir)) {
    Write-Error "Project is not initialized for Moe: $projectPath"
    exit 1
}

$env:MOE_PROJECT_PATH = $projectPath
if (-not $WorkerId) {
    $shortId = [guid]::NewGuid().ToString().Substring(0, 4)
    $WorkerId = "$Role-$shortId"
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

# Plugin/install root is always the parent of the scripts/ folder
$pluginRoot = Resolve-Path (Join-Path $PSScriptRoot "..") -ErrorAction SilentlyContinue

# Load role-specific instructions (.moe/roles/ with fallback to plugin docs/roles/)
$roleDoc = ""
$roleDocPath = Join-Path $moeDir "roles\$Role.md"
if (-not (Test-Path $roleDocPath)) {
    if ($pluginRoot) {
        $roleDocPath = Join-Path $pluginRoot "docs\roles\$Role.md"
    }
}
if (Test-Path $roleDocPath) {
    $roleDoc = Get-Content -Raw -Path $roleDocPath
    Write-Host "Loaded role guide from $roleDocPath"
} else {
    Write-Host "WARNING: Role documentation not found: $Role.md" -ForegroundColor Yellow
}

# Load shared agent context
$agentContext = ""
$agentContextPath = if ($pluginRoot) { Join-Path $pluginRoot "docs\agent-context.md" } else { $null }
if ($agentContextPath -and (Test-Path $agentContextPath)) {
    $agentContext = Get-Content -Raw -Path $agentContextPath
    Write-Host "Loaded agent context from $agentContextPath"
}

# Read approval mode from project.json
$approvalMode = ""
$projectJsonPath = Join-Path $moeDir "project.json"
if (Test-Path $projectJsonPath) {
    try {
        $projConfig = Get-Content -Raw -Path $projectJsonPath | ConvertFrom-Json
        if ($projConfig.settings.approvalMode) {
            $approvalMode = $projConfig.settings.approvalMode
            Write-Host "Approval mode: $approvalMode"
        }
    } catch {
        Write-Host "WARNING: Could not parse project.json" -ForegroundColor Yellow
    }
}

# Load known issues if present
$knownIssues = ""
$knownIssuesPath = Join-Path $moeDir "KNOWN_ISSUES.md"
if (Test-Path $knownIssuesPath) {
    $knownIssues = Get-Content -Raw -Path $knownIssuesPath
    Write-Host "Loaded known issues from $knownIssuesPath"
}

# Normalize Command + CommandArgs (allow custom command strings with args)
$resolvedCommand = Resolve-CommandParts -Cmd $Command -CmdArgs $CommandArgs
$Command = $resolvedCommand.Command
$CommandArgs = $resolvedCommand.CommandArgs

# Detect CLI type from command name
$cliType = "claude"
$cmdForDetect = $Command
if ($cmdForDetect) {
    $cmdForDetect = $cmdForDetect.Trim().Trim('"').Trim("'")
}
$cmdBase = [System.IO.Path]::GetFileNameWithoutExtension($cmdForDetect)
if ($cmdBase -eq "codex") { $cliType = "codex" }
# Codex is interactive by default, but -CodexExec enables non-interactive headless mode
$codexInteractive = ($cliType -eq "codex") -and (-not $CodexExec)

# For codex: write project-scoped .codex/config.toml instead of global registration
if ($cliType -eq "codex") {
    Write-Host "Writing project-scoped Codex MCP config..."
    $codexConfigDir = Join-Path $projectPath ".codex"
    $codexConfigFile = Join-Path $codexConfigDir "config.toml"
    try {
        if (-not (Test-Path $codexConfigDir)) {
            New-Item -ItemType Directory -Force -Path $codexConfigDir | Out-Null
        }

        # Build the moe MCP server TOML block
        $proxyScriptForToml = $proxyScript.ToString().Replace('\', '/')
        $projectPathForToml = $projectPath.ToString().Replace('\', '/')
        $moeTomlBlock = @"

[mcp_servers.moe]
command = "node"
args = ["$proxyScriptForToml"]

[mcp_servers.moe.env]
MOE_PROJECT_PATH = "$projectPathForToml"
"@

        if (Test-Path $codexConfigFile) {
            # Merge: remove existing moe MCP sections and append new ones
            $existingContent = Get-Content -Raw -Path $codexConfigFile
            # Remove old moe MCP server blocks (both [mcp_servers.moe] and [mcp_servers.moe.env])
            $cleaned = $existingContent -replace '(?m)^\s*\[mcp_servers\.moe\][\s\S]*?(?=^\s*\[(?!mcp_servers\.moe)|$)', ''
            $cleaned = $cleaned.TrimEnd()
            $cleaned + "`n" + $moeTomlBlock | Set-Content -Path $codexConfigFile -Encoding UTF8
        } else {
            # Create new config with project_doc_fallback_filenames
            $newContent = @"
# Codex project config (auto-generated by moe-agent)
project_doc_fallback_filenames = ["CLAUDE.md"]
$moeTomlBlock
"@
            $newContent | Set-Content -Path $codexConfigFile -Encoding UTF8
        }
        Write-Host "Codex MCP config written to: $codexConfigFile"
    } catch {
        Write-Error "Failed to write Codex MCP config: $_"
        exit 1
    }
} else {
    Write-Host "MCP config written to: $mcpConfigFile"
}

if ($Delay -gt 0) {
    Write-Host "Waiting $Delay seconds before starting..."
    Start-Sleep -Seconds $Delay
}

# Auto-create/join team if -Team specified
$teamContext = ""
if ($Team) {
    Write-Host "Setting up team '$Team' for role '$Role'..."
    $nodeExe = "node"
    $createTeamJson = ConvertTo-Json @{ name = $Team } -Compress
    $createRpc = '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"moe.create_team","arguments":' + $createTeamJson + '}}'
    try {
        $createResult = $createRpc | & $nodeExe $proxyScript 2>$null | ConvertFrom-Json
        $teamObj = $createResult.result.content[0].text | ConvertFrom-Json
        $teamId = $teamObj.team.id
        Write-Host "Team '$Team' ready (id: $teamId)"

        $joinJson = ConvertTo-Json @{ teamId = $teamId; workerId = $WorkerId } -Compress
        $joinRpc = '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"moe.join_team","arguments":' + $joinJson + '}}'
        $joinRpc | & $nodeExe $proxyScript 2>$null | Out-Null
        Write-Host "Worker $WorkerId joined team '$Team'"
        $teamContext = "You are part of team '$Team' (id: $teamId, role: $Role). Team members can work in parallel on the same epic."
    } catch {
        Write-Host "WARNING: Failed to set up team: $_" -ForegroundColor Yellow
    }
}

Write-Host "Launching $cliType CLI..."
if ($cliType -eq "codex") {
    if ($CodexExec) {
        Write-Host "Codex mode: exec (non-interactive, headless)"
    } else {
        Write-Host "Codex mode: interactive TUI"
    }
}
if (-not $NoLoop -and -not $codexInteractive) {
    Write-Host "Polling mode: will check for new tasks every ${PollInterval}s after completion (Ctrl+C to stop)"
}

$loopEnabled = (-not $NoLoop) -and ($PollInterval -gt 0)
if ($codexInteractive) {
    $loopEnabled = $false
    if (-not $NoLoop) {
        Write-Host "Interactive mode: polling disabled"
    }
}
$firstRun = $true

# Build system/role context (shared across loop iterations)
$systemAppend = "Role: $Role. Always use Moe MCP tools. "
if ($AutoClaim) {
    $systemAppend += "Start by claiming the next task for your role."
}
if ($agentContext) {
    $systemAppend += "`n`n$agentContext"
}
if ($approvalMode) {
    $systemAppend += "`n`n# Project Settings`nApproval mode: $approvalMode"
}
if ($roleDoc) {
    $systemAppend += "`n`n$roleDoc"
}
if ($knownIssues) {
    $systemAppend += "`n`n# Known Issues`n$knownIssues"
}
if ($teamContext) {
    $systemAppend += "`n`n# Team`n$teamContext"
}

do {
    if (-not $firstRun) {
        Write-Host ""
        Write-Host "Agent idle, checking for tasks in ${PollInterval} seconds... (Ctrl+C to stop)"
        Start-Sleep -Seconds $PollInterval
        Write-Host "Relaunching agent..."
    }
    $firstRun = $false

    $claimPrompt = if ($AutoClaim) {
        "Call moe.claim_next_task $claimJson. If hasNext is false, say: 'No tasks in $Role queue' and wait."
    } else { $null }

    if ($cliType -eq "codex") {
        # Check codex is available
        $codexCheck = Get-Command $Command -ErrorAction SilentlyContinue
        if (-not $codexCheck) {
            Write-Error "Codex command not found: $Command. Install codex CLI first."
            exit 1
        }

        # Build full prompt with system context + claim command
        $fullPrompt = $systemAppend
        if ($claimPrompt) { $fullPrompt += "`n`n$claimPrompt" }

        if ($CodexExec) {
            # Non-interactive exec mode: codex exec -C <project> --full-auto --sandbox workspace-write "<prompt>"
            Write-Host "Command: $Command exec -C `"$projectPath`" --full-auto --sandbox workspace-write `"<prompt>`""
            & $Command @CommandArgs exec -C "$projectPath" --full-auto --sandbox workspace-write $fullPrompt
        } else {
            # Interactive TUI mode: codex -C <project> "<prompt>"
            Write-Host "Command: $Command -C `"$projectPath`" `"<prompt>`""
            & $Command @CommandArgs -C "$projectPath" $fullPrompt
        }
    } else {
        # Claude Code: use --mcp-config and --append-system-prompt
        if ($claimPrompt) {
            Write-Host "Command: $Command --mcp-config $mcpConfigFile --append-system-prompt <...> `"$claimPrompt`""
            & $Command @CommandArgs --mcp-config $mcpConfigFile --append-system-prompt $systemAppend $claimPrompt
        } else {
            Write-Host "Command: $Command --mcp-config $mcpConfigFile --append-system-prompt <...>"
            & $Command @CommandArgs --mcp-config $mcpConfigFile --append-system-prompt $systemAppend
        }
    }
} while ($loopEnabled)
