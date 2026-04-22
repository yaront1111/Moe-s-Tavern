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
    [switch]$CodexExec,

    # Use gemini headless mode (non-interactive, --yolo) instead of interactive
    [switch]$GeminiExec
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
# $PID is only available in PowerShell 7+; fall back for Windows PowerShell 5.1
$myPid = if ($PID) { $PID } else { [System.Diagnostics.Process]::GetCurrentProcess().Id }
$mcpConfigFile = Join-Path $env:TEMP "moe-mcp-config-$Role-$myPid.json"
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

# Load shared agent context (.moe/ first, then fallback to install docs/)
$agentContext = ""
$agentContextPath = Join-Path $moeDir "agent-context.md"
if (-not (Test-Path $agentContextPath)) {
    $agentContextPath = if ($pluginRoot) { Join-Path $pluginRoot "docs\agent-context.md" } else { $null }
}
if ($agentContextPath -and (Test-Path $agentContextPath)) {
    $agentContext = Get-Content -Raw -Path $agentContextPath
    Write-Host "Loaded agent context from $agentContextPath"
}

# Read approval mode from project.json
$approvalMode = ""
$projConfig = $null
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

# Read enableAgentTeams from project.json
$enableAgentTeams = $false
if ($projConfig -and $projConfig.settings.enableAgentTeams -eq $true) {
    $enableAgentTeams = $true
    Write-Host "Agent Teams: enabled"
}

# Load known issues if present
$knownIssues = ""
$knownIssuesPath = Join-Path $moeDir "KNOWN_ISSUES.md"
if (Test-Path $knownIssuesPath) {
    $knownIssues = Get-Content -Raw -Path $knownIssuesPath
    Write-Host "Loaded known issues from $knownIssuesPath"
}

# Expose Moe-vendored skills to the Claude Code Skill tool by mirroring
# <project>/.moe/skills/<name>/ into <project>/.claude/skills/<name>/. Claude
# Code only discovers project skills under .claude/skills/; it does not scan
# .moe/skills/. Prefer a directory junction (Windows) or symlink (Unix under
# pwsh) so updates in .moe/skills/ take effect immediately; fall back to copy
# when symlink creation fails (no dev mode / no permissions).
$moeSkillsDir = Join-Path $moeDir "skills"
if (Test-Path $moeSkillsDir) {
    $claudeSkillsDir = Join-Path $projectPath ".claude\skills"
    $claudeDir = Split-Path $claudeSkillsDir -Parent
    if (-not (Test-Path $claudeDir)) {
        New-Item -ItemType Directory -Force -Path $claudeDir | Out-Null
    }
    if (-not (Test-Path $claudeSkillsDir)) {
        New-Item -ItemType Directory -Force -Path $claudeSkillsDir | Out-Null
    }

    $mirrored = 0
    $skipped  = 0
    Get-ChildItem -Path $moeSkillsDir -Directory -ErrorAction SilentlyContinue | ForEach-Object {
        $src  = $_.FullName
        $dest = Join-Path $claudeSkillsDir $_.Name
        if (Test-Path $dest) { $skipped++; return }

        # Skill loader requires SKILL.md at dest root; skip skill dirs that lack one
        if (-not (Test-Path (Join-Path $src "SKILL.md"))) { return }

        $linked = $false
        try {
            # mklink /J creates a directory junction (no admin required on Windows)
            $null = & cmd.exe /c mklink /J "`"$dest`"" "`"$src`"" 2>&1
            if ($LASTEXITCODE -eq 0 -and (Test-Path $dest)) { $linked = $true }
        } catch { }
        if (-not $linked) {
            try {
                New-Item -ItemType SymbolicLink -Path $dest -Target $src -ErrorAction Stop | Out-Null
                $linked = $true
            } catch { }
        }
        if (-not $linked) {
            Copy-Item -Recurse -Force -Path $src -Destination $dest
        }
        $mirrored++
    }
    if ($mirrored -gt 0 -or $skipped -gt 0) {
        Write-Host "Mirrored $mirrored skill(s) from .moe/skills/ to .claude/skills/ ($skipped already present)"
    }
}

# Load skills manifest (name/role/description/triggeredBy per skill). Bodies
# live in .moe/skills/<name>/SKILL.md and load on demand via the Skill tool.
$skillsList = ""
$skillsManifestPath = Join-Path $moeDir "skills\manifest.json"
if (Test-Path $skillsManifestPath) {
    try {
        $m = Get-Content -Raw -Path $skillsManifestPath | ConvertFrom-Json
        if ($m.skills) {
            # NOTE: do NOT use `$role` here — it collides with the script-level
            # [ValidateSet(...)] $Role parameter and silently mutates it.
            $lines = foreach ($s in $m.skills) {
                $skillRole = if ($s.role) { $s.role } else { "all" }
                $skillDesc = if ($s.description) { $s.description } else { "" }
                $entry = "- $($s.name) ($skillRole): $skillDesc"
                if ($s.triggeredBy -and $s.triggeredBy.Count -gt 0) {
                    $entry += "`n    when: " + ($s.triggeredBy -join "; ")
                }
                $entry
            }
            $skillsList = ($lines -join "`n")
            Write-Host "Loaded skill manifest from $skillsManifestPath"
        }
    } catch {
        Write-Host "WARNING: Skill manifest at $skillsManifestPath could not be parsed: $_" -ForegroundColor Yellow
    }
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
elseif ($cmdBase -eq "gemini") { $cliType = "gemini" }
# Codex is interactive by default, but -CodexExec enables non-interactive headless mode
$codexInteractive = ($cliType -eq "codex") -and (-not $CodexExec)
# Gemini is interactive by default, but -GeminiExec enables non-interactive headless mode
$geminiInteractive = ($cliType -eq "gemini") -and (-not $GeminiExec)

# For codex: write project-scoped .codex/config.toml instead of global registration
if ($cliType -eq "codex") {
    Write-Host "Writing project-scoped Codex MCP config..."
    $codexConfigDir = Join-Path $projectPath ".codex"
    $codexConfigFile = Join-Path $codexConfigDir "config.toml"
    try {
        if (-not (Test-Path $codexConfigDir)) {
            New-Item -ItemType Directory -Force -Path $codexConfigDir | Out-Null
        }

        # Build top-level config (role instructions + model instructions)
        $proxyScriptForToml = $proxyScript.ToString().Replace('\', '/')
        $projectPathForToml = $projectPath.ToString().Replace('\', '/')
        $topLevelConfig = @"
model_instructions_file = "agent-instructions.md"
developer_instructions = """`nYou are a $Role agent in the Moe AI Workforce system. You MUST use Moe MCP tools (moe.*) for ALL task operations. Follow the Moe workflow strictly. Never edit .moe/ files directly.`n"""
"@

        # Build the moe MCP server TOML block
        $moeTomlBlock = @"

[mcp_servers.moe]
command = "node"
args = ["$proxyScriptForToml"]

[mcp_servers.moe.env]
MOE_PROJECT_PATH = "$projectPathForToml"
"@

        if (Test-Path $codexConfigFile) {
            # Merge: remove existing moe MCP sections and moe-managed top-level keys
            $rawContent = Get-Content -Path $codexConfigFile -Raw

            # Remove old model_instructions_file lines
            $rawContent = $rawContent -replace '(?m)^model_instructions_file\s*=.*\r?\n?', ''

            # Remove old developer_instructions (triple-quoted multi-line)
            $rawContent = $rawContent -replace '(?s)(?m)^developer_instructions\s*=\s*""".*?"""\s*\r?\n?', ''
            # Remove old developer_instructions (single-line)
            $rawContent = $rawContent -replace '(?m)^developer_instructions\s*=\s*"[^"]*"\s*\r?\n?', ''

            # Filter out [mcp_servers.moe] and [mcp_servers.moe.env] sections line-by-line
            $lines = $rawContent -split '\r?\n'
            $cleaned = @()
            $skip = $false
            foreach ($line in $lines) {
                $stripped = $line.Trim()
                if ($stripped -match '^\[mcp_servers\.moe\]' -or $stripped -match '^\[mcp_servers\.moe\.env\]') {
                    $skip = $true
                    continue
                }
                if ($skip -and $stripped.StartsWith('[') -and $stripped -notmatch '^\[mcp_servers\.moe') {
                    $skip = $false
                }
                if (-not $skip) {
                    $cleaned += $line
                }
            }
            $cleanedText = ($cleaned -join "`n")
            # Ensure agent-instructions.md is in project_doc_fallback_filenames
            if ($cleanedText -match 'project_doc_fallback_filenames' -and $cleanedText -notmatch 'agent-instructions\.md') {
                $cleanedText = $cleanedText -replace '(project_doc_fallback_filenames\s*=\s*\[.*?)"CLAUDE\.md"(.*?\])', '$1"CLAUDE.md", ".codex/agent-instructions.md"$2'
            }
            $cleanedText = $cleanedText.TrimEnd()

            # Safety: if merge produced empty content, fall back to fresh config header
            if ([string]::IsNullOrWhiteSpace($cleanedText)) {
                $cleanedText = "# Codex project config (auto-generated by moe-agent)`nproject_doc_fallback_filenames = [""CLAUDE.md"", "".codex/agent-instructions.md""]"
            }

            # Insert top-level keys BEFORE the first [section] header to keep them at TOML root level
            $splitLines = $cleanedText -split '\r?\n'
            $firstSectionLineIdx = -1
            for ($i = 0; $i -lt $splitLines.Count; $i++) {
                if ($splitLines[$i] -match '^\[') {
                    $firstSectionLineIdx = $i
                    break
                }
            }
            if ($firstSectionLineIdx -gt 0) {
                $beforeSections = ($splitLines[0..($firstSectionLineIdx - 1)] -join "`n").TrimEnd()
                $afterSections = ($splitLines[$firstSectionLineIdx..($splitLines.Count - 1)] -join "`n").TrimEnd()
                ($beforeSections + "`n" + $topLevelConfig + "`n`n" + $afterSections + $moeTomlBlock + "`n") | Set-Content -Path $codexConfigFile -Encoding UTF8 -NoNewline
            } elseif ($firstSectionLineIdx -eq 0) {
                # Section header is the very first line - prepend top-level config
                ($topLevelConfig + "`n`n" + $cleanedText.TrimEnd() + $moeTomlBlock + "`n") | Set-Content -Path $codexConfigFile -Encoding UTF8 -NoNewline
            } else {
                # No section headers at all - just append
                ($cleanedText + "`n" + $topLevelConfig + $moeTomlBlock + "`n") | Set-Content -Path $codexConfigFile -Encoding UTF8 -NoNewline
            }
        } else {
            # Create new config with project_doc_fallback_filenames
            $newContent = @"
# Codex project config (auto-generated by moe-agent)
project_doc_fallback_filenames = ["CLAUDE.md", ".codex/agent-instructions.md"]
$topLevelConfig
$moeTomlBlock
"@
            $newContent | Set-Content -Path $codexConfigFile -Encoding UTF8
        }
        Write-Host "Codex MCP config written to: $codexConfigFile"
    } catch {
        Write-Error "Failed to write Codex MCP config: $_"
        exit 1
    }
} elseif ($cliType -eq "gemini") {
    # For gemini: write project-scoped .gemini/settings.json with MCP config
    Write-Host "Writing project-scoped Gemini MCP config..."
    $geminiConfigDir = Join-Path $projectPath ".gemini"
    $geminiConfigFile = Join-Path $geminiConfigDir "settings.json"
    try {
        if (-not (Test-Path $geminiConfigDir)) {
            New-Item -ItemType Directory -Force -Path $geminiConfigDir | Out-Null
        }

        # Build the moe MCP server entry
        $moeEntry = @{
            command = "node"
            args = @($proxyScript)
            env = @{
                MOE_PROJECT_PATH = $projectPath.ToString()
            }
        }

        # Merge with existing settings.json if present
        $geminiConfig = @{}
        if (Test-Path $geminiConfigFile) {
            try {
                $geminiConfig = Get-Content -Raw -Path $geminiConfigFile | ConvertFrom-Json -AsHashtable
            } catch {
                $geminiConfig = @{}
            }
        }
        if (-not $geminiConfig.ContainsKey('mcpServers')) {
            $geminiConfig['mcpServers'] = @{}
        }
        $geminiConfig['mcpServers']['moe'] = $moeEntry

        $jsonText = $geminiConfig | ConvertTo-Json -Depth 5
        [System.IO.File]::WriteAllText($geminiConfigFile, $jsonText, [System.Text.UTF8Encoding]::new($false))
        Write-Host "Gemini MCP config written to: $geminiConfigFile"
    } catch {
        Write-Error "Failed to write Gemini MCP config: $_"
        exit 1
    }
} else {
    Write-Host "MCP config written to: $mcpConfigFile"
}

if ($Delay -gt 0) {
    Write-Host "Waiting $Delay seconds before starting..."
    Start-Sleep -Seconds $Delay
}

# Auto-join role's default team (required for chat_send to accept the workerId)
# If -Team not specified, use role-based default name
$teamContext = ""
if (-not $Team) {
    $defaultTeams = @{ architect = "Architects"; worker = "Workers"; qa = "QA" }
    $Team = $defaultTeams[$Role]
}
if ($Team) {
    Write-Host "Setting up team '$Team' for role '$Role'..."
    $nodeExe = "node"
    $createTeamJson = ConvertTo-Json @{ name = $Team } -Compress
    $createRpc = '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"moe.create_team","arguments":' + $createTeamJson + '}}'
    try {
        $createResult = $createRpc | & $nodeExe $proxyScript 2>$null | ConvertFrom-Json
        if ($createResult -and $createResult.result -and $createResult.result.content -and $createResult.result.content.Count -gt 0) {
            $teamObj = $createResult.result.content[0].text | ConvertFrom-Json
            $teamId = $teamObj.team.id
            Write-Host "Team '$Team' ready (id: $teamId)"

            $joinJson = ConvertTo-Json @{ teamId = $teamId; workerId = $WorkerId } -Compress
            $joinRpc = '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"moe.join_team","arguments":' + $joinJson + '}}'
            $joinRpc | & $nodeExe $proxyScript 2>$null | Out-Null
            Write-Host "Worker $WorkerId joined team '$Team'"
            $teamContext = "You are part of team '$Team' (id: $teamId, role: $Role). Team members can work in parallel on the same epic."
        } else {
            Write-Host "WARNING: Could not parse team creation response (daemon may not be running)" -ForegroundColor Yellow
        }
    } catch {
        Write-Host "WARNING: Failed to set up team: $_" -ForegroundColor Yellow
    }
}

# Invoke-MoeRpc TOOL ARGS_HASHTABLE_OR_JSON
# Calls an MCP tool via the proxy and returns the parsed JSON result (the inner text block
# of the MCP content array). Returns $null on failure.
function Invoke-MoeRpc {
    param(
        [Parameter(Mandatory = $true)][string]$Tool,
        [object]$Args
    )
    $t = if ($Tool.StartsWith("moe.")) { $Tool } else { "moe.$Tool" }
    if ($null -eq $Args) { $Args = @{} }
    if ($Args -is [string]) { $argsObj = $Args | ConvertFrom-Json } else { $argsObj = $Args }
    $rpc = @{
        jsonrpc = "2.0"
        id      = 1
        method  = "tools/call"
        params  = @{ name = $t; arguments = $argsObj }
    } | ConvertTo-Json -Depth 20 -Compress

    $prevEnv = $env:MOE_PROJECT_PATH
    $env:MOE_PROJECT_PATH = $projectPath
    try {
        $raw = $rpc | & node $proxyScript 2>$null
    } catch {
        $env:MOE_PROJECT_PATH = $prevEnv
        return $null
    }
    $env:MOE_PROJECT_PATH = $prevEnv
    if (-not $raw) { return $null }

    # Take the last valid JSON line from the response
    $lines = ($raw -split "`n") | Where-Object { $_.Trim().Length -gt 0 }
    foreach ($line in ($lines | Sort-Object -Descending { [Array]::IndexOf($lines, $_) })) {
        try {
            $d = $line | ConvertFrom-Json -ErrorAction Stop
            if ($d.error) {
                Write-Host "  [moe_rpc error: $($d.error.message)]" -ForegroundColor Yellow
                return $null
            }
            if ($d.result -and $d.result.content -and $d.result.content.Count -gt 0) {
                $text = $d.result.content[0].text
                try { return ($text | ConvertFrom-Json -ErrorAction Stop) } catch { return $text }
            }
        } catch {
            continue
        }
    }
    return $null
}

Write-Host "Launching $cliType CLI..."
if ($cliType -eq "codex") {
    if ($CodexExec) {
        Write-Host "Codex mode: exec (non-interactive, headless)"
    } else {
        Write-Host "Codex mode: interactive TUI"
    }
}
if ($cliType -eq "gemini") {
    if ($GeminiExec) {
        Write-Host "Gemini mode: headless (--yolo)"
    } else {
        Write-Host "Gemini mode: interactive"
    }
}
if (-not $NoLoop -and -not $codexInteractive -and -not $geminiInteractive) {
    Write-Host "Polling mode: will check for new tasks every ${PollInterval}s after completion (Ctrl+C to stop)"
}

$loopEnabled = (-not $NoLoop) -and ($PollInterval -gt 0)
if ($codexInteractive -or $geminiInteractive) {
    $loopEnabled = $false
    if (-not $NoLoop) {
        Write-Host "Interactive mode: polling disabled"
    }
}
$firstRun = $true

# Build base system/role context (static across iterations; per-iteration pre-flight is appended inside the loop)
$systemAppendBase = "Role: $Role. Always use Moe MCP tools. "
if ($AutoClaim) {
    $systemAppendBase += "Start by claiming the next task for your role."
}
if ($agentContext) {
    $systemAppendBase += "`n`n$agentContext"
}
if ($approvalMode) {
    $systemAppendBase += "`n`n# Project Settings`nApproval mode: $approvalMode"
}
if ($roleDoc) {
    $systemAppendBase += "`n`n$roleDoc"
}
if ($skillsList) {
    $systemAppendBase += @"


# Available Skills (load via the Skill tool when the situation calls for one)
Each skill is deeper guidance for a specific phase of work. The daemon recommends one per phase via nextAction.recommendedSkill — invoke it via the host's Skill tool. Triggers below describe WHEN each applies.

$skillsList
"@
}
if ($knownIssues) {
    $systemAppendBase += "`n`n# Known Issues`n$knownIssues"
}
if ($teamContext) {
    $systemAppendBase += "`n`n# Team`n$teamContext"
}

try {
do {
    if (-not $firstRun) {
        Write-Host ""
        Write-Host "Agent idle, checking for tasks in ${PollInterval} seconds... (Ctrl+C to stop)"
        Start-Sleep -Seconds $PollInterval
        Write-Host "Relaunching agent..."
    }
    $firstRun = $false

    # -------- Pre-flight: perform startup rituals BEFORE spawning the CLI --------
    $preflightTaskId = ""
    $preflightTaskTitle = ""
    $preflightTaskChannel = ""
    $preflightContext = $null
    $preflightGeneralUnread = $null
    $preflightTaskUnread = $null
    $preflightRecall = $null
    $preflightPending = $null
    $preflightSkillName = $null
    $preflightSkillReason = $null
    $preflightSkillNextTool = $null
    $preflightOk = $false
    $preflightNoTask = $false

    if ($AutoClaim) {
        Write-Host "Pre-flight: joining chat, claiming task, loading context..." -ForegroundColor Cyan

        # Resolve #general channel id (chat tools take channel id, not name)
        $generalChannelId = $null
        $channelsResp = Invoke-MoeRpc -Tool "chat_channels" -Args @{}
        if ($channelsResp -and $channelsResp.channels) {
            foreach ($c in $channelsResp.channels) {
                if ($c.name -eq "general") { $generalChannelId = $c.id; break }
            }
        }

        if ($generalChannelId) {
            # chat_join is safe pre-claim (uses system sender); chat_send requires a registered worker so we defer announce until after claim.
            Invoke-MoeRpc -Tool "chat_join" -Args @{ channel = $generalChannelId; workerId = $WorkerId } | Out-Null
            $preflightGeneralUnread = Invoke-MoeRpc -Tool "chat_read" -Args @{ channel = $generalChannelId; workerId = $WorkerId }
        }
        $preflightPending = Invoke-MoeRpc -Tool "get_pending_questions" -Args @{}

        $claim = Invoke-MoeRpc -Tool "claim_next_task" -Args ($claimJson | ConvertFrom-Json)
        if ($null -ne $claim) {
            # Worker is auto-registered by claim_next_task; safe to announce now.
            if ($generalChannelId) {
                $announceText = if ($claim.hasNext) { "$Role online, starting $($claim.task.id): $($claim.task.title)" } else { "$Role online, waiting for tasks" }
                Invoke-MoeRpc -Tool "chat_send" -Args @{ channel = $generalChannelId; workerId = $WorkerId; content = $announceText } | Out-Null
            }
            if ($claim.hasNext) {
                $preflightTaskId = $claim.task.id
                $preflightTaskTitle = $claim.task.title
                if ($claim.task.PSObject.Properties['chatChannel']) { $preflightTaskChannel = $claim.task.chatChannel }

                if ($preflightTaskId) {
                    $preflightContext = Invoke-MoeRpc -Tool "get_context" -Args @{ taskId = $preflightTaskId }
                }
                if ($preflightTaskChannel) {
                    $preflightTaskUnread = Invoke-MoeRpc -Tool "chat_read" -Args @{ channel = $preflightTaskChannel; workerId = $WorkerId }
                }
                if ($preflightTaskTitle) {
                    $preflightRecall = Invoke-MoeRpc -Tool "recall" -Args @{ query = $preflightTaskTitle; limit = 10 }
                }

                # Extract phase-recommended skill from context.nextAction. We
                # do NOT inline the body — the agent loads it via the Skill tool.
                # We only pull name + reason + the tool it gates, to emit a short
                # JIT reminder in $systemAppend.
                if ($preflightContext -and $preflightContext.nextAction) {
                    $rec = $preflightContext.nextAction.recommendedSkill
                    if ($rec) {
                        # Accept either structured {name, reason} or legacy bare string.
                        if ($rec -is [string]) {
                            $preflightSkillName = $rec
                        } elseif ($rec.PSObject.Properties['name']) {
                            $preflightSkillName = [string]$rec.name
                            if ($rec.PSObject.Properties['reason']) { $preflightSkillReason = [string]$rec.reason }
                        }
                        if ($preflightContext.nextAction.PSObject.Properties['tool']) {
                            $preflightSkillNextTool = [string]$preflightContext.nextAction.tool
                        }
                        if ($preflightSkillName) {
                            Write-Host "[skill] Recommending '$preflightSkillName' for this phase." -ForegroundColor Cyan
                        }
                    }
                }

                $preflightOk = $true
                Write-Host "[OK] Pre-flight complete. Claimed: $preflightTaskId ($preflightTaskTitle)" -ForegroundColor Green
            } else {
                $preflightNoTask = $true
                Write-Host "[INFO] No claimable task for role $Role. Agent will wait_for_task." -ForegroundColor Yellow
            }
        } else {
            Write-Host "[WARN] Pre-flight claim RPC failed; falling back to in-agent claim." -ForegroundColor Yellow
        }
    }
    # -------- End pre-flight --------

    # Assemble per-iteration systemAppend (base + pre-flight results)
    $systemAppend = $systemAppendBase
    if ($preflightOk) {
        $ctxJson = if ($preflightContext) { $preflightContext | ConvertTo-Json -Depth 20 -Compress } else { "{}" }
        $generalJson = if ($preflightGeneralUnread) { $preflightGeneralUnread | ConvertTo-Json -Depth 20 -Compress } else { "{}" }
        $taskChatJson = if ($preflightTaskUnread) { $preflightTaskUnread | ConvertTo-Json -Depth 20 -Compress } else { "{}" }
        $recallJson = if ($preflightRecall) { $preflightRecall | ConvertTo-Json -Depth 20 -Compress } else { "{}" }
        $pendingJson = if ($preflightPending) { $preflightPending | ConvertTo-Json -Depth 20 -Compress } else { "{}" }

        $systemAppend += @"


# Pre-flight Complete (runtime-injected — do not repeat)
You ARE: $Role agent, workerId=$WorkerId.
The wrapper has ALREADY performed these steps before spawning you:
- joined #general and announced presence
- read unread #general messages (see <general_unread> below)
- claimed task ${preflightTaskId}: $preflightTaskTitle
- fetched its context (see <claimed_task_context> below)
- read its task chat backlog (see <task_chat_backlog> below)
- recalled relevant prior knowledge (see <relevant_memory> below)

DO NOT call at session start: moe.chat_join, moe.chat_send, moe.chat_read, moe.claim_next_task, moe.get_context, moe.recall. They are done.

Claimed task id: $preflightTaskId

<claimed_task_context>
$ctxJson
</claimed_task_context>

<general_unread>
$generalJson
</general_unread>

<task_chat_backlog>
$taskChatJson
</task_chat_backlog>

<relevant_memory>
$recallJson
</relevant_memory>

<pending_questions>
$pendingJson
</pending_questions>
"@

        # JIT reminder: point the agent at the phase-recommended skill. We do
        # NOT inline the body — the agent loads it itself via the Skill tool.
        if ($preflightSkillName) {
            $jitNextTool = if ($preflightSkillNextTool) { $preflightSkillNextTool } else { "your next Moe tool" }
            $jitReason   = if ($preflightSkillReason)  { $preflightSkillReason }  else { "Phase-recommended for this task." }
            $systemAppend += @"


<system-reminder>
Skill recommendation for this task's current phase: $preflightSkillName
Why: $jitReason
Before you call $jitNextTool, invoke the Skill tool:
  Skill(skill="$preflightSkillName")
This is not optional. Do not rationalize skipping it ("I'm blocking, not planning", "this is trivial", "I already know what it says"). Skills evolve — load the current version.
If after loading you decide it truly does not apply here, say so explicitly in chat — but LOAD IT FIRST.
</system-reminder>
"@
        }
    } elseif ($preflightNoTask) {
        $systemAppend += @"


# Pre-flight Complete: no claimable task
The daemon reports no claimable task for role $Role right now.
Your FIRST action MUST be moe.wait_for_task with statuses=$(($statuses | ConvertTo-Json -Compress)), workerId=$WorkerId.
When it returns hasNext:true, call moe.claim_next_task, then moe.get_context.
"@
    }

    # Write system prompt to CLI-specific instruction files (per iteration so pre-flight data is fresh)
    if ($cliType -eq "codex") {
        $agentInstructionsPath = Join-Path (Join-Path $projectPath ".codex") "agent-instructions.md"
        $codexDir = Split-Path $agentInstructionsPath -Parent
        if (-not (Test-Path $codexDir)) { New-Item -ItemType Directory -Force -Path $codexDir | Out-Null }
        $systemAppend | Set-Content -Path $agentInstructionsPath -Encoding UTF8
        Write-Host "Agent instructions written to: $agentInstructionsPath"
    } elseif ($cliType -eq "gemini") {
        $geminiInstructionsDir = Join-Path $projectPath ".gemini"
        if (-not (Test-Path $geminiInstructionsDir)) {
            New-Item -ItemType Directory -Force -Path $geminiInstructionsDir | Out-Null
        }
        $geminiInstructionsPath = Join-Path $geminiInstructionsDir "GEMINI.md"
        $systemAppend | Set-Content -Path $geminiInstructionsPath -Encoding UTF8
        Write-Host "Agent instructions written to: $geminiInstructionsPath"
    }

    # Build the user message prompt — lean when pre-flight succeeded, legacy multi-step otherwise
    $claimPrompt = $null
    if ($AutoClaim -and $preflightOk) {
        $claimPrompt = switch ($Role) {
            "architect" { "Task $preflightTaskId is claimed and its full context is in your system prompt. Study the implementationPlan, rails, and definitionOfDone, then call moe.submit_plan with a complete plan. After submission, poll moe.check_approval. Once approved, call moe.save_session_summary, then moe.wait_for_task to pick up the next PLANNING task." }
            "worker"    { "Task $preflightTaskId is claimed and its full context is in your system prompt. Execute the approved implementationPlan: call moe.start_step for step 0, implement it (write/edit code, run tests), call moe.complete_step, and repeat through the final step. Then call moe.complete_task. Before waiting for the next task, call moe.save_session_summary with what you did. Use moe.remember to save any non-obvious gotchas you discovered. Finally call moe.wait_for_task." }
            "qa"        { "Task $preflightTaskId is claimed and its full context is in your system prompt. Verify the implementation against definitionOfDone and rails. Run the tests. If it passes, call moe.qa_approve. If it fails, call moe.qa_reject with a detailed list of issues. Then moe.save_session_summary and moe.wait_for_task." }
        }
    } elseif ($AutoClaim -and $preflightNoTask) {
        $claimPrompt = "No claimable task right now. Call moe.wait_for_task with statuses=$($statuses | ConvertTo-Json -Compress), workerId=`"$WorkerId`". When it wakes with hasNext:true, call moe.claim_next_task with the same args, then moe.get_context. Handle hasChatMessage / hasPendingQuestion wakeups per your system prompt."
    } elseif ($AutoClaim) {
        # Pre-flight skipped or failed — legacy multi-step prompt
        $claimPrompt = "First call moe.chat_channels to find #general, then moe.chat_join and moe.chat_send to announce yourself as $Role. Then call moe.chat_read to catch up on any unread messages. Then call moe.claim_next_task $claimJson. After claiming a task and calling moe.get_context, always check memory.relevant in the response and use moe.recall for deeper knowledge search. Before calling moe.wait_for_task, always call moe.save_session_summary to record what you accomplished and discovered. If hasNext is false, say: 'No tasks in $Role queue' and wait."
    }

    if ($cliType -eq "codex") {
        # Check codex is available
        $codexCheck = Get-Command $Command -ErrorAction SilentlyContinue
        if (-not $codexCheck) {
            Write-Error "Codex command not found: $Command. Install codex CLI first."
            exit 1
        }

        if ($AutoClaim -and ($preflightOk -or $preflightNoTask)) {
            # Pre-flight baked context into .codex/agent-instructions.md; use the lean $claimPrompt directly
            $shortPrompt = $claimPrompt
        } else {
            # Legacy fallback — pre-flight skipped or failed
            $roleWorkflow = switch ($Role) {
                "architect" { "Workflow: join chat -> read messages -> claim task -> get_context -> recall memory -> explore codebase -> submit_plan -> save learnings -> save session summary -> announce in chat" }
                "worker"    { "Workflow: join chat -> read messages -> claim task -> read task chat -> get_context -> recall memory -> start_step -> implement -> complete_step -> save learnings -> complete_task -> save session summary -> announce in chat" }
                "qa"        { "Workflow: join chat -> read messages -> claim task -> read task chat -> get_context -> recall memory -> review code and tests -> qa_approve or qa_reject -> save learnings -> save session summary -> announce in chat" }
                default     { "Workflow: claim task -> get_context -> recall memory -> complete task -> save session summary" }
            }
            if ($claimPrompt) {
                $shortPrompt = "You are a $Role agent. Use ONLY Moe MCP tools (moe.*). $roleWorkflow. First: join #general via moe.chat_channels, moe.chat_join, and moe.chat_send. Then moe.chat_read to catch up on messages. Then call moe.claim_next_task $claimJson. If hasNext is false, say 'No tasks' and stop."
            } else {
                $shortPrompt = "You are a $Role agent. Use ONLY Moe MCP tools (moe.*). $roleWorkflow. First: join #general via moe.chat_channels, moe.chat_join, and moe.chat_send. Then moe.chat_read to catch up on messages. Then call moe.claim_next_task to get your next task."
            }
        }

        if ($CodexExec) {
            # Non-interactive exec mode: codex exec -C <project> --full-auto --sandbox workspace-write "<prompt>"
            Write-Host "Command: $Command exec -C `"$projectPath`" --full-auto --sandbox workspace-write `"<prompt>`""
            & $Command @CommandArgs exec -C "$projectPath" --full-auto --sandbox workspace-write "$shortPrompt"
        } else {
            # Interactive TUI mode: codex -C <project> "<prompt>"
            Write-Host "Command: $Command -C `"$projectPath`" `"<prompt>`""
            & $Command @CommandArgs -C "$projectPath" "$shortPrompt"
        }
    } elseif ($cliType -eq "gemini") {
        # Check gemini is available
        $geminiCheck = Get-Command $Command -ErrorAction SilentlyContinue
        if (-not $geminiCheck) {
            Write-Error "Gemini command not found: $Command. Install Gemini CLI first (npm install -g @google/gemini-cli)."
            exit 1
        }

        if ($AutoClaim -and ($preflightOk -or $preflightNoTask)) {
            # Pre-flight baked context into .gemini/GEMINI.md; use the lean $claimPrompt directly
            $shortPrompt = $claimPrompt
        } else {
            $roleWorkflow = switch ($Role) {
                "architect" { "Workflow: join chat -> read messages -> claim task -> get_context -> recall memory -> explore codebase -> submit_plan -> save learnings -> save session summary -> announce in chat" }
                "worker"    { "Workflow: join chat -> read messages -> claim task -> read task chat -> get_context -> recall memory -> start_step -> implement -> complete_step -> save learnings -> complete_task -> save session summary -> announce in chat" }
                "qa"        { "Workflow: join chat -> read messages -> claim task -> read task chat -> get_context -> recall memory -> review code and tests -> qa_approve or qa_reject -> save learnings -> save session summary -> announce in chat" }
                default     { "Workflow: claim task -> get_context -> recall memory -> complete task -> save session summary" }
            }
            if ($claimPrompt) {
                $shortPrompt = "You are a $Role agent. Use ONLY Moe MCP tools (moe.*). $roleWorkflow. First: join #general via moe.chat_channels, moe.chat_join, and moe.chat_send. Then moe.chat_read to catch up on messages. Then call moe.claim_next_task $claimJson. If hasNext is false, say 'No tasks' and stop."
            } else {
                $shortPrompt = "You are a $Role agent. Use ONLY Moe MCP tools (moe.*). $roleWorkflow. First: join #general via moe.chat_channels, moe.chat_join, and moe.chat_send. Then moe.chat_read to catch up on messages. Then call moe.claim_next_task to get your next task."
            }
        }

        if ($GeminiExec) {
            # Non-interactive headless mode
            Write-Host "Command: $Command --prompt `"<prompt>`" --yolo"
            try { Push-Location $projectPath; & $Command @CommandArgs --prompt "$shortPrompt" --yolo } finally { Pop-Location }
        } else {
            # Interactive mode
            Write-Host "Command: $Command --prompt-interactive `"<prompt>`""
            try { Push-Location $projectPath; & $Command @CommandArgs --prompt-interactive "$shortPrompt" } finally { Pop-Location }
        }
    } else {
        # Clean slate for agent teams env var
        if ($env:CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS) {
            Remove-Item Env:\CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS -ErrorAction SilentlyContinue
        }
        # Enable CC Agent Teams for Claude workers when setting is on
        if ($Role -eq "worker" -and $enableAgentTeams) {
            $env:CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = "1"
            Write-Host "Agent Teams enabled for this worker session"
        }

        # Claude Code: use --mcp-config and --append-system-prompt-file
        # Write system prompt to a temp file to avoid command-line quoting issues
        # (the system prompt contains XML tags, backticks, JSON, and newlines that
        # break PowerShell's argument passing to native commands)
        $systemPromptFile = Join-Path $env:TEMP "moe-system-prompt-$Role-$myPid.md"
        [System.IO.File]::WriteAllText($systemPromptFile, $systemAppend, [System.Text.UTF8Encoding]::new($false))
        if ($claimPrompt) {
            Write-Host "Command: $Command --mcp-config `"$mcpConfigFile`" --append-system-prompt-file `"$systemPromptFile`" --effort max `"<prompt>`""
            & $Command @CommandArgs --mcp-config "$mcpConfigFile" --append-system-prompt-file "$systemPromptFile" --effort max "$claimPrompt"
        } else {
            Write-Host "Command: $Command --mcp-config `"$mcpConfigFile`" --append-system-prompt-file `"$systemPromptFile`" --effort max"
            & $Command @CommandArgs --mcp-config "$mcpConfigFile" --append-system-prompt-file "$systemPromptFile" --effort max
        }
    }

    # -------- Post-flight: shutdown rituals after CLI exits --------
    # Save session summary + announce outcome in #general. Best-effort.
    if ($AutoClaim -and $preflightTaskId) {
        Write-Host "Post-flight: saving session summary, announcing outcome..." -ForegroundColor Cyan

        # Look up final task status AND reopenCount (the latter drives
        # commit-message wording in the auto-commit block below).
        $finalStatus = $null
        $finalReopenCount = 0
        $listResp = Invoke-MoeRpc -Tool "list_tasks" -Args @{}
        if ($listResp -and $listResp.tasks) {
            $matched = $listResp.tasks | Where-Object { $_.id -eq $preflightTaskId } | Select-Object -First 1
            if ($matched) {
                $finalStatus = $matched.status
                if ($matched.PSObject.Properties['reopenCount'] -and $matched.reopenCount) {
                    $finalReopenCount = [int]$matched.reopenCount
                }
            }
        }

        # Save session summary (best-effort; dedup-safe if agent already saved one)
        Invoke-MoeRpc -Tool "save_session_summary" -Args @{
            workerId = $WorkerId
            taskId   = $preflightTaskId
            summary  = "wrapper post-flight: session ended with task status=$(if ($finalStatus) { $finalStatus } else { 'unknown' })"
        } | Out-Null

        # Announce in #general
        if ($generalChannelId -and $finalStatus) {
            $announceText = switch -Regex ($finalStatus) {
                '^(DONE|REVIEW)$'                { "$Role completed $preflightTaskId (now $finalStatus)" }
                '^(WORKING|AWAITING_APPROVAL)$'  { "$Role paused $preflightTaskId (still $finalStatus)" }
                default                          { "$Role exited $preflightTaskId (status: $finalStatus)" }
            }
            Invoke-MoeRpc -Tool "chat_send" -Args @{
                channel  = $generalChannelId
                workerId = $WorkerId
                content  = $announceText
            } | Out-Null
        }

        # Auto-commit + push on worker completion. Runs when:
        #   - role is worker
        #   - task is now REVIEW (worker just called moe.complete_task — first
        #     pass OR retry after qa_reject)
        #   - project.json settings.autoCommit is not explicitly false
        #   - $projectPath is a git repo
        # Best-effort: failures log a warning but never abort the wrapper loop.
        # Commits use the user's configured git identity (no Claude attribution).
        if ($Role -eq "worker" -and $finalStatus -eq "REVIEW") {
            $autoCommit = $true
            $projJsonPath = Join-Path $moeDir "project.json"
            if (Test-Path $projJsonPath) {
                try {
                    $cfg = Get-Content -Raw -Path $projJsonPath | ConvertFrom-Json
                    if ($cfg.settings -and $cfg.settings.PSObject.Properties['autoCommit']) {
                        # Explicit `false` disables; any other value keeps default (true).
                        if ($cfg.settings.autoCommit -eq $false) { $autoCommit = $false }
                    }
                } catch {
                    # Malformed project.json — fall through with default true.
                }
            }
            if ($autoCommit) {
                & git -C $projectPath rev-parse --git-dir 2>$null | Out-Null
                if ($LASTEXITCODE -eq 0) {
                    Write-Host "Post-flight: auto-commit+push (settings.autoCommit=true)..." -ForegroundColor Cyan

                    # Never commit/push directly to main or master. If the worker
                    # finished on the default branch, peel off onto a shared Moe
                    # working branch (moe/work-<YYYY-MM-DD>) before committing.
                    # Uncommitted/staged changes follow the checkout. Existing
                    # non-default branches are reused as-is — this is not
                    # branch-per-task.
                    $currentBranch = (& git -C $projectPath rev-parse --abbrev-ref HEAD 2>$null).Trim()
                    if ($currentBranch -eq "main" -or $currentBranch -eq "master") {
                        $moeBranch = "moe/work-" + (Get-Date -Format "yyyy-MM-dd")
                        Write-Host "[branch] on $currentBranch; switching to $moeBranch so we don't commit to the default branch." -ForegroundColor Yellow
                        # Local exists?
                        & git -C $projectPath rev-parse --verify --quiet "refs/heads/$moeBranch" 2>$null | Out-Null
                        if ($LASTEXITCODE -eq 0) {
                            & git -C $projectPath checkout $moeBranch 2>&1 | Select-Object -Last 2 | ForEach-Object { Write-Host "  $_" }
                        } else {
                            # Try tracking a remote branch of the same name; else create fresh.
                            & git -C $projectPath rev-parse --verify --quiet "refs/remotes/origin/$moeBranch" 2>$null | Out-Null
                            if ($LASTEXITCODE -eq 0) {
                                & git -C $projectPath checkout -b $moeBranch "origin/$moeBranch" 2>&1 | Select-Object -Last 2 | ForEach-Object { Write-Host "  $_" }
                            } else {
                                & git -C $projectPath checkout -b $moeBranch 2>&1 | Select-Object -Last 2 | ForEach-Object { Write-Host "  $_" }
                            }
                        }
                        if ($LASTEXITCODE -ne 0) {
                            Write-Host "[WARN] failed to switch off $currentBranch; aborting auto-commit to avoid writing to the default branch." -ForegroundColor Yellow
                            return
                        }
                        $currentBranch = $moeBranch
                    }

                    $commitType = if ($finalReopenCount -gt 0) { "fix" } else { "feat" }
                    $commitSuffix = if ($finalReopenCount -gt 0) { " (retry after qa_reject #$finalReopenCount)" } else { "" }
                    $titleText = if ($preflightTaskTitle) { $preflightTaskTitle } else { "completed task" }
                    $commitMsg = "$commitType($preflightTaskId): $titleText$commitSuffix`n`nCompleted via Moe worker session."
                    # Stage everything. Worker may have already committed mid-session;
                    # in that case commit is a no-op and we still push any local
                    # commits ahead of upstream.
                    & git -C $projectPath add -A 2>$null | Out-Null
                    & git -C $projectPath diff --cached --quiet 2>$null
                    $nothingStaged = ($LASTEXITCODE -eq 0)
                    if (-not $nothingStaged) {
                        & git -C $projectPath commit -m $commitMsg 2>&1 | Select-Object -Last 3 | ForEach-Object { Write-Host "  $_" }
                        if ($LASTEXITCODE -eq 0) {
                            Write-Host "[OK] Committed task $preflightTaskId on $currentBranch." -ForegroundColor Green
                        } else {
                            Write-Host "[WARN] git commit failed (pre-commit hook? detached HEAD?); skipping push." -ForegroundColor Yellow
                        }
                    } else {
                        Write-Host "[info] No staged changes to commit (worker may have already committed mid-session)." -ForegroundColor Cyan
                    }
                    # Check whether the current branch already has an upstream; if not,
                    # push with -u so subsequent `git push` calls succeed without args.
                    & git -C $projectPath rev-parse --abbrev-ref --symbolic-full-name "@{upstream}" 2>$null | Out-Null
                    $hasUpstream = ($LASTEXITCODE -eq 0)
                    if ($hasUpstream) {
                        & git -C $projectPath push 2>&1 | Select-Object -Last 5 | ForEach-Object { Write-Host "  $_" }
                    } else {
                        & git -C $projectPath push -u origin $currentBranch 2>&1 | Select-Object -Last 5 | ForEach-Object { Write-Host "  $_" }
                    }
                    if ($LASTEXITCODE -eq 0) {
                        Write-Host "[OK] Pushed task $preflightTaskId to $currentBranch." -ForegroundColor Green
                    } else {
                        Write-Host "[WARN] git push failed (no upstream? auth? network?) — resolve and push manually." -ForegroundColor Yellow
                    }
                } else {
                    Write-Host "[info] $projectPath is not a git repo — skipping auto-commit+push." -ForegroundColor Cyan
                }
            }
        }
    }
    # -------- End post-flight --------
} while ($loopEnabled)
} finally {
    # Clean up temp files
    if ($mcpConfigFile -and (Test-Path $mcpConfigFile)) {
        Remove-Item -Path $mcpConfigFile -Force -ErrorAction SilentlyContinue
    }
    if ($systemPromptFile -and (Test-Path $systemPromptFile)) {
        Remove-Item -Path $systemPromptFile -Force -ErrorAction SilentlyContinue
    }
    # Clean up agent teams env var so it doesn't leak to parent session
    Remove-Item Env:\CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS -ErrorAction SilentlyContinue
}
