param(
    [ValidateSet("architect", "worker", "qa", "governor")]
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

    # Explicitly enable polling loop mode (default when auto-claim is enabled)
    [switch]$Loop,

    # Disable polling loop - run once and exit
    [switch]$NoLoop,

    # Team name to auto-create/join (enables parallel same-role workers)
    [string]$Team,

    # Use codex exec mode (non-interactive, headless) instead of interactive TUI
    [switch]$CodexExec,

    # Use gemini headless mode (non-interactive, --yolo) instead of interactive
    [switch]$GeminiExec,

    # Force claude into interactive TUI mode (no --print, no stream-json parser).
    # Use when you want to drive the agent yourself — typing into the REPL after
    # the pre-flight has claimed a task and loaded the role/MCP context.
    # The polling loop is unaffected: each loop iteration spawns a fresh CLI
    # invocation, so per-task cache replay is the same as --print mode (no
    # multi-turn replay cost compounding). Architect defaults to interactive
    # because planning benefits from clarifying questions; worker and qa stay
    # opt-in (JetBrains opts the worker in for hands-on coding sessions).
    [switch]$Interactive,

    # Explicit model override (e.g. "claude-opus-4-8", "claude-sonnet-4-6").
    # When empty, the launcher picks a per-role default — all roles → Opus 4.8.
    # Per-project overrides via .moe/project.json settings.models.{role}. Only
    # applies to the `claude` CLI; codex/gemini pick their own model.
    [string]$Model = ""
)

# Fail fast on unhandled cmdlet errors. Per-call `-ErrorAction SilentlyContinue`
# overrides this for spots that intentionally rely on non-terminating errors
# (Resolve-Path with missing paths, Get-Process for stale PIDs, etc.).
$ErrorActionPreference = 'Stop'

if ($Loop -and $NoLoop) {
    Write-Error "Conflicting switches: -Loop and -NoLoop cannot be used together. Choose -Loop for polling mode or -NoLoop for single-shot mode."
    exit 2
}

# Architect and governor default to interactive TUI: planning is a conversation,
# and governance is an interactive oversight task where the operator wants to
# steer escalation decisions in real time. Worker and QA stay opt-in. Explicit
# -Interactive:$false on the command line wins over this default.
if ($Role -in @("architect", "governor") -and -not $PSBoundParameters.ContainsKey('Interactive')) {
    $Interactive = $true
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
    # 8 hex chars (~4 billion space) — 4 chars (~65K space) collided under
    # simultaneous multi-agent launches from JetBrains.
    $shortId = [guid]::NewGuid().ToString().Substring(0, 8)
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

# Add the Serena MCP server: LSP-based symbol navigation/editing pinned to THIS
# project, so agents get exact cross-file code intelligence (callers, defs,
# refactors) instead of relying on whole-file reads. Resolve the binary; skip
# silently if Serena isn't installed (install: uv tool install -p 3.13 serena-agent).
# Override the binary with $env:MOE_SERENA_PATH.
$serenaPath = $env:MOE_SERENA_PATH
if (-not $serenaPath) {
    $serenaCandidate = Join-Path $env:USERPROFILE ".local\bin\serena.exe"
    if (Test-Path $serenaCandidate) {
        $serenaPath = $serenaCandidate
    } elseif (Get-Command serena -ErrorAction SilentlyContinue) {
        $serenaPath = (Get-Command serena).Source
    }
}

# Serena's project root is decoupled from the Moe project root: a multi-repo
# workspace root (no single language root, e.g. no root go.mod) yields near-empty
# symbol intelligence, so pin Serena at the actual code repo. Resolution order:
#   1) "serenaProject" in <project>/.moe-agent.json  (per-project, lives with the workspace)
#   2) $env:MOE_SERENA_PROJECT                        (ad-hoc / CI override)
#   3) the Moe project root                           (correct for single-repo projects)
$serenaProject = $projectPath.ToString()
$serenaProjectSource = "project root"
$serenaProjectCandidate = $null
$moeAgentConfig = Join-Path $projectPath ".moe-agent.json"
if (Test-Path $moeAgentConfig) {
    try {
        $cfg = Get-Content -Raw -Path $moeAgentConfig | ConvertFrom-Json
        if ($cfg.serenaProject) {
            $serenaProjectCandidate = $cfg.serenaProject
            $serenaProjectSource = ".moe-agent.json"
        }
    } catch {
        Write-Host "[WARN] Could not parse $moeAgentConfig; ignoring serenaProject override"
    }
}
if ((-not $serenaProjectCandidate) -and $env:MOE_SERENA_PROJECT) {
    $serenaProjectCandidate = $env:MOE_SERENA_PROJECT
    $serenaProjectSource = "MOE_SERENA_PROJECT"
}
if ($serenaProjectCandidate) {
    $serenaProjectResolved = Resolve-Path -Path $serenaProjectCandidate -ErrorAction SilentlyContinue
    if ($serenaProjectResolved) {
        $serenaProject = $serenaProjectResolved.ToString()
    } else {
        Write-Host "[WARN] Serena project '$serenaProjectCandidate' (from $serenaProjectSource) not found; using Moe project root"
        $serenaProjectSource = "project root (override not found)"
    }
}

if ($serenaPath -and (Test-Path $serenaPath)) {
    $mcpConfigObj.mcpServers.serena = @{
        command = $serenaPath
        args = @(
            "start-mcp-server",
            "--context", "claude-code",
            "--project", $serenaProject,
            "--enable-web-dashboard", "false",
            "--enable-gui-log-window", "false"
        )
    }
    Write-Host "[OK] Serena MCP enabled for project: $serenaProject (source: $serenaProjectSource)"
} else {
    Write-Host "[INFO] Serena not found; skipping Serena MCP (install: uv tool install -p 3.13 serena-agent)"
}
# Use unique temp file to prevent collision when multiple agents run
# $PID is only available in PowerShell 7+; fall back for Windows PowerShell 5.1
$myPid = if ($PID) { $PID } else { [System.Diagnostics.Process]::GetCurrentProcess().Id }
$mcpConfigFile = Join-Path $env:TEMP "moe-mcp-config-$Role-$myPid.json"
$mcpConfigObj | ConvertTo-Json -Depth 6 | Set-Content -Path $mcpConfigFile -Encoding UTF8

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
        # Pass arguments as an array so paths containing spaces or quotes survive
        # Windows command-line escaping (Start-Process re-quotes each element).
        Start-Process -FilePath "node" -ArgumentList @("$daemonScript", "start", "--project", "$projectPath") -WindowStyle Hidden

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
    # Governor doesn't claim tasks via statuses — see enter_governance branch
    # in the preflight section. Empty array keeps the $claimJson serializer
    # well-defined for the fallback/legacy code paths.
    governor  = @()
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

# Agent context is no longer auto-injected; role doc + CLAUDE.md cover the same
# ground without duplication. Per-task context comes from <claimed_task_context>.

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

# Read enableAgentTeams from project.json. Subagents are now on by default for
# every Moe role (architect/worker/qa) so explicit `false` is the only way to
# opt out. Was previously opt-in for workers only.
$enableAgentTeams = $true
if ($projConfig -and $projConfig.settings.PSObject.Properties['enableAgentTeams'] -and $projConfig.settings.enableAgentTeams -eq $false) {
    $enableAgentTeams = $false
    Write-Host "Agent Teams: disabled (project.json opt-out)"
} else {
    Write-Host "Agent Teams: enabled"
}

# Resolve the Claude model for this role.
# Precedence: -Model flag → .moe/project.json settings.models.<role> → per-role default.
# All roles default to Opus 4.8: the projects this wrapper runs against are
# large, deeply-coupled stacks where the planning/review/implementation
# quality difference dominates the per-token cost difference. Override per
# role via project.json settings.models.{role} if a cheaper model suffices.
$defaultModels = @{
    architect = "claude-opus-4-8"
    worker    = "claude-opus-4-8"
    qa        = "claude-opus-4-8"
}
$resolvedModel = ""
if (-not [string]::IsNullOrWhiteSpace($Model)) {
    $resolvedModel = $Model
} elseif ($projConfig -and $projConfig.settings -and $projConfig.settings.models) {
    $configured = $projConfig.settings.models.$Role
    if ($configured) { $resolvedModel = [string]$configured }
}
if ([string]::IsNullOrWhiteSpace($resolvedModel)) {
    $resolvedModel = $defaultModels[$Role]
}
if ($resolvedModel) {
    Write-Host "Model: $resolvedModel"
}

# Load known issues if present
$knownIssues = ""
$knownIssuesPath = Join-Path $moeDir "KNOWN_ISSUES.md"
if (Test-Path $knownIssuesPath) {
    $knownIssues = Get-Content -Raw -Path $knownIssuesPath
    Write-Host "Loaded known issues from $knownIssuesPath"
}

# Skill discovery: the daemon surfaces phase-recommended skills via
# nextAction.recommendedSkill on every MCP response. Skills live on disk under
# .moe/skills/; the agent loads them via its host's Skill tool when relevant.

# Mirror .moe/agents/<name>.md to .claude/agents/<name>.md so Claude Code's
# subagent loader discovers them. Idempotent: only writes if the destination
# is missing or matches a previous Moe-generated copy (sha marker preserved).
# Skip entirely when agent teams are disabled.
if ($enableAgentTeams) {
    $moeAgentsDir = Join-Path $moeDir "agents"
    if (Test-Path $moeAgentsDir) {
        $claudeAgentsDir = Join-Path $projectPath ".claude\agents"
        if (-not (Test-Path $claudeAgentsDir)) {
            New-Item -ItemType Directory -Force -Path $claudeAgentsDir | Out-Null
        }
        $mirrored = 0
        $skipped  = 0
        Get-ChildItem -Path $moeAgentsDir -File -Filter "*.md" -ErrorAction SilentlyContinue | ForEach-Object {
            $src  = $_.FullName
            $dest = Join-Path $claudeAgentsDir $_.Name
            if (Test-Path $dest) {
                # Preserve user customizations; only overwrite if dest is a stale Moe-mirrored copy
                # (best-effort heuristic: same first 4KB → assumed Moe-mirrored). Skip for now.
                $skipped++
                return
            }
            Copy-Item -Path $src -Destination $dest -Force
            $mirrored++
        }
        if ($mirrored -gt 0 -or $skipped -gt 0) {
            Write-Host "Subagents: mirrored $mirrored, kept $skipped existing (.moe/agents/ -> .claude/agents/)"
        }
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
# Claude defaults to --print (one-shot stream); -Interactive flips it to TUI.
$claudeInteractive = ($cliType -eq "claude") -and $Interactive

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

        # Build the serena MCP server TOML block (LSP code intelligence + memory,
        # pinned to this project). Empty when Serena isn't installed. Path is
        # forward-slashed so TOML doesn't treat Windows backslashes as escapes.
        $serenaTomlBlock = ""
        if ($serenaPath -and (Test-Path $serenaPath)) {
            $serenaPathForToml = $serenaPath.ToString().Replace('\', '/')
            $serenaProjectForToml = $serenaProject.Replace('\', '/')
            $serenaTomlBlock = @"

[mcp_servers.serena]
command = "$serenaPathForToml"
args = ["start-mcp-server", "--context", "codex", "--project", "$serenaProjectForToml", "--enable-web-dashboard", "false", "--enable-gui-log-window", "false"]
"@
        }

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
                if ($stripped -match '^\[mcp_servers\.moe\]' -or $stripped -match '^\[mcp_servers\.moe\.env\]' -or $stripped -match '^\[mcp_servers\.serena\]') {
                    $skip = $true
                    continue
                }
                if ($skip -and $stripped.StartsWith('[') -and $stripped -notmatch '^\[mcp_servers\.moe' -and $stripped -notmatch '^\[mcp_servers\.serena\]') {
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
                ($beforeSections + "`n" + $topLevelConfig + "`n`n" + $afterSections + $moeTomlBlock + $serenaTomlBlock + "`n") | Set-Content -Path $codexConfigFile -Encoding UTF8 -NoNewline
            } elseif ($firstSectionLineIdx -eq 0) {
                # Section header is the very first line - prepend top-level config
                ($topLevelConfig + "`n`n" + $cleanedText.TrimEnd() + $moeTomlBlock + $serenaTomlBlock + "`n") | Set-Content -Path $codexConfigFile -Encoding UTF8 -NoNewline
            } else {
                # No section headers at all - just append
                ($cleanedText + "`n" + $topLevelConfig + $moeTomlBlock + $serenaTomlBlock + "`n") | Set-Content -Path $codexConfigFile -Encoding UTF8 -NoNewline
            }
        } else {
            # Create new config with project_doc_fallback_filenames
            $newContent = @"
# Codex project config (auto-generated by moe-agent)
project_doc_fallback_filenames = ["CLAUDE.md", ".codex/agent-instructions.md"]
$topLevelConfig
$moeTomlBlock
$serenaTomlBlock
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

        # Serena MCP (LSP code intelligence + memory), pinned to this project.
        # Set/refresh when installed; drop a stale entry when it isn't. The JSON
        # serializer escapes the native Windows path, so no manual escaping here.
        if ($serenaPath -and (Test-Path $serenaPath)) {
            $geminiConfig['mcpServers']['serena'] = @{
                command = $serenaPath
                args = @(
                    "start-mcp-server",
                    "--context", "agent",
                    "--project", $serenaProject,
                    "--enable-web-dashboard", "false",
                    "--enable-gui-log-window", "false"
                )
            }
        } elseif ($geminiConfig['mcpServers'].ContainsKey('serena')) {
            $geminiConfig['mcpServers'].Remove('serena')
        }

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
    $defaultTeams = @{ architect = "Architects"; worker = "Workers"; qa = "QA"; governor = "Governors" }
    $Team = $defaultTeams[$Role]
}
# Local resilient RPC parser used before Invoke-MoeRpc is defined. Handles
# powershell.exe 5.1's stderr-as-ErrorRecord noise by merging streams (2>&1),
# stringifying, dropping proxy diagnostic lines, and scanning for JSON.
function Invoke-MoeRpcRaw {
    param([string]$RpcJson)
    # moe-proxy writes diagnostic lines (e.g. "[moe-proxy] Connected to daemon") to
    # stderr. The script-wide $ErrorActionPreference='Stop' otherwise turns those
    # into NativeCommandError that bubbles up as a misleading "Failed to set up team"
    # warning even when the RPC succeeded.
    $prevEAP = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $output = $RpcJson | & node $proxyScript 2>&1
    } finally {
        $ErrorActionPreference = $prevEAP
    }
    $stringLines = @()
    foreach ($entry in @($output)) {
        $stringLines += (("$entry") -split "`r?`n")
    }
    # @(...) force-wraps to an array. Where-Object returns a bare string when
    # only one line matches, and indexing a string yields a [char] not the line.
    $jsonLines = @($stringLines | Where-Object {
        $t = $_.Trim()
        $t.Length -gt 0 -and -not $t.StartsWith('[moe-proxy]')
    })
    for ($i = $jsonLines.Count - 1; $i -ge 0; $i--) {
        try {
            return ($jsonLines[$i] | ConvertFrom-Json -ErrorAction Stop)
        } catch { continue }
    }
    return $null
}

if ($Team) {
    Write-Host "Setting up team '$Team' for role '$Role'..."
    # Team creation is idempotent on (name, role). enter_governance strictly requires
    # team.role === 'governor', so the governor role gets a role-bound team. For
    # architect/worker/qa we omit role: a user-supplied $Team like "Cordum" should
    # mean ONE shared team across those roles. create_team resolves a null-role
    # request to the ROLELESS team of that name only — it will never adopt a
    # governor team that merely shares the name (doing so would route the worker to
    # enter_governance and it could never claim a task). The mention router falls
    # back to a workerId-substring match for @architects/@workers/@qa when team.role
    # isn't set, so role-based addressing still works.
    if ($Role -eq 'governor') {
        $createTeamHash = @{ name = $Team; role = 'governor' }
    } else {
        $createTeamHash = @{ name = $Team }
    }
    $createTeamJson = ConvertTo-Json $createTeamHash -Compress
    $createRpc = '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"moe.create_team","arguments":' + $createTeamJson + '}}'
    try {
        $createResult = Invoke-MoeRpcRaw -RpcJson $createRpc
        if ($createResult -and $createResult.result -and $createResult.result.content -and $createResult.result.content.Count -gt 0) {
            $teamObj = $createResult.result.content[0].text | ConvertFrom-Json
            $teamId = $teamObj.team.id
            Write-Host "Team '$Team' ready (id: $teamId)"

            $joinJson = ConvertTo-Json @{ teamId = $teamId; workerId = $WorkerId } -Compress
            $joinRpc = '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"moe.join_team","arguments":' + $joinJson + '}}'
            Invoke-MoeRpcRaw -RpcJson $joinRpc | Out-Null
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
    # Merge stderr into stdout (2>&1) and force every record to its string form.
    # Windows PowerShell 5.1's powershell.exe converts native-command stderr into
    # ErrorRecord objects that break ConvertFrom-Json on a per-pipeline-record
    # basis even when 2>$null is in place; merging + stringifying yields a clean
    # stream of lines we can scan for the JSON-RPC response.
    # Locally drop EAP from 'Stop' to 'Continue' for the node invocation: the proxy
    # writes diagnostic lines (e.g. "[moe-proxy] Connected to daemon") to stderr on
    # every spawn, which under Stop becomes a NativeCommandError that silently
    # returns $null here and surfaces as "[WARN] Pre-flight claim RPC failed".
    $prevEAP = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $raw = ($rpc | & node $proxyScript 2>&1) | ForEach-Object { "$_" }
    } catch {
        $env:MOE_PROJECT_PATH = $prevEnv
        $ErrorActionPreference = $prevEAP
        return $null
    }
    $ErrorActionPreference = $prevEAP
    $env:MOE_PROJECT_PATH = $prevEnv
    if (-not $raw) { return $null }

    # Split any embedded newlines, drop empties + the proxy's own diagnostic lines,
    # then scan from the bottom for the last valid JSON-RPC response.
    $allLines = @()
    foreach ($entry in @($raw)) {
        $allLines += ($entry -split "`r?`n")
    }
    $lines = @($allLines | Where-Object {
        $trimmed = $_.Trim()
        $trimmed.Length -gt 0 -and -not $trimmed.StartsWith('[moe-proxy]')
    })
    for ($i = $lines.Count - 1; $i -ge 0; $i--) {
        $line = $lines[$i]
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


function Invoke-PostFlight {
    $exitCode = if ($null -ne $script:CliExitCode) { [int]$script:CliExitCode } elseif ($null -ne $LASTEXITCODE) { [int]$LASTEXITCODE } else { 0 }

    if (-not $preflightOk -or [string]::IsNullOrWhiteSpace($preflightTaskId)) {
        return
    }

    # Session handoff is no longer persisted by the wrapper: cross-session memory
    # now lives in Serena (the agent writes a `task-<id>-handoff` note before it
    # stops). The post-flight chat message below remains the session-ended signal.
    if ($generalChannelId) {
        $content = "$Role session ended: task=$preflightTaskId (CLI exit=$exitCode)"
        try {
            $result = Invoke-MoeRpc -Tool "chat_send" -Args @{
                channel  = $generalChannelId
                workerId = $WorkerId
                content  = $content
            }
            if ($null -eq $result) { Write-Warning "post-flight chat_send failed" }
        } catch {
            Write-Warning "post-flight chat_send failed: $_"
        }
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
if ($cliType -eq "gemini") {
    if ($GeminiExec) {
        Write-Host "Gemini mode: headless (--yolo)"
    } else {
        Write-Host "Gemini mode: interactive"
    }
}
$loopEnabled = (($AutoClaim -or $Loop) -and (-not $NoLoop) -and ($PollInterval -gt 0))
if ($codexInteractive -or $geminiInteractive) {
    # Codex / Gemini TUIs hold a single long-lived REPL session — looping them
    # would just respawn the same TUI on top of the previous one. Claude's
    # interactive mode is fine to loop: each iteration spawns a fresh CLI
    # invocation, so per-task cache replay matches --print mode.
    $loopEnabled = $false
    if (-not $NoLoop) {
        Write-Host "Interactive mode: polling disabled"
    }
} elseif ($claudeInteractive -and $loopEnabled) {
    Write-Host "Claude interactive mode: polling enabled (each task spawns a fresh TUI)"
}
if ($loopEnabled) {
    Write-Host "Polling mode: will check for new tasks every ${PollInterval}s after completion (Ctrl+C to stop)"
}
Write-Host "Loop: $loopEnabled (use -Loop to opt in explicitly, -NoLoop to force single-shot)"
$firstRun = $true

# Build base system/role context (static across iterations; per-iteration pre-flight is appended inside the loop)
$systemAppendBase = "Role: $Role. Always use Moe MCP tools. "
if ($AutoClaim) {
    $systemAppendBase += "Start by claiming the next task for your role."
}
if ($approvalMode) {
    $systemAppendBase += "`n`n# Project Settings`nApproval mode: $approvalMode"
}
if ($roleDoc) {
    $systemAppendBase += "`n`n$roleDoc"
}
# The daemon surfaces a phase-recommended skill via nextAction.recommendedSkill
# on every MCP response. Full manifest is on disk at .moe/skills/manifest.json
# if the agent ever needs to browse what's available; we don't dump it into
# the prompt every turn.
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
    $isFirstIteration = $firstRun
    $firstRun = $false

    $script:CliExitCode = 0

    # -------- Pre-flight: perform startup rituals BEFORE spawning the CLI --------
    $preflightTaskId = ""
    $preflightTaskTitle = ""
    $preflightTaskChannel = ""
    $preflightContext = $null
    $preflightGeneralUnread = $null
    $preflightTaskUnread = $null
    $preflightPending = $null
    $preflightSkillName = $null
    $preflightSkillReason = $null
    $preflightSkillNextTool = $null
    $preflightOk = $false
    $preflightNoTask = $false
    $preflightRoutedMentions = @()

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
            # chat_join only needed once per wrapper-process lifetime (idempotent).
            # chat_read each iteration so routed mentions for THIS task surface.
            if ($isFirstIteration) {
                Invoke-MoeRpc -Tool "chat_join" -Args @{ channel = $generalChannelId; workerId = $WorkerId } | Out-Null
            }
            $preflightGeneralUnread = Invoke-MoeRpc -Tool "chat_read" -Args @{ channel = $generalChannelId; workerId = $WorkerId }
        }
        $preflightPending = Invoke-MoeRpc -Tool "get_pending_questions" -Args @{}

        if ($Role -eq 'governor') {
            # Governors do NOT claim tasks. They enter governance mode once per
            # session and then live in chat_wait / mention loops. See
            # docs/roles/governor.md — claim_next_task would 1) reject the
            # governor workerId and 2) be the wrong tool entirely.
            try {
                $govResult = Invoke-MoeRpc -Tool "enter_governance" -Args @{ workerId = $WorkerId }
                if ($null -eq $govResult) {
                    Write-Host "[WARN] enter_governance returned no result; continuing anyway." -ForegroundColor Yellow
                } else {
                    Write-Host "[OK] Entered governance mode as $WorkerId." -ForegroundColor Green
                }
            } catch {
                Write-Host "[WARN] enter_governance failed: $_ — continuing; the agent can retry from inside the CLI." -ForegroundColor Yellow
            }
            # Synthesize the claim shape downstream code expects. Governor has
            # no task to claim, so hasNext=false routes through the no-task
            # banner path (which the role doc + system prompt remap to the
            # chat_wait loop).
            $claim = [pscustomobject]@{ hasNext = $false }
        } else {
            $claim = Invoke-MoeRpc -Tool "claim_next_task" -Args ($claimJson | ConvertFrom-Json)
        }
        if ($null -ne $claim) {
            # Worker is registered by team-setup join_team (above) when teams are
            # enabled, and re-registered by claim_next_task on a successful claim.
            # If both were skipped (no team + no claim), chat_send would fail with
            # "Unknown sender" — the caller is expected to have completed team setup.
            # Announce "online" only on the first iteration of the wrapper loop.
            # Per-task starts/completions are conveyed by post-flight session-end
            # messages and the daemon's task-state events.
            if ($generalChannelId -and $isFirstIteration) {
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
                # Cross-session memory lives in Serena now: the agent pulls prior
                # knowledge with Serena list_memories / read_memory on task start.
                # The wrapper does no memory preflight.

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

        # Filter unread messages for ones routed at THIS worker. Claude otherwise
        # sees a wall of <general_unread> and tends to skip replying. The
        # <routed_mentions> banner injected below gives the model a focused list.
        # Match directly on workerId, on @all, or on the role-group tag this
        # worker belongs to (architects/workers/qa).
        $roleGroupTag = switch ($Role) { "architect" { "architects" } "worker" { "workers" } "qa" { "qa" } "governor" { "governors" } default { "" } }
        $buckets = @()
        if ($preflightGeneralUnread -and $preflightGeneralUnread.messages) { $buckets += ,$preflightGeneralUnread.messages }
        if ($preflightTaskUnread    -and $preflightTaskUnread.messages)    { $buckets += ,$preflightTaskUnread.messages }
        foreach ($bucket in $buckets) {
            foreach ($msg in $bucket) {
                if (-not $msg -or -not $msg.mentions) { continue }
                $hit = $false
                foreach ($m in $msg.mentions) {
                    if ($m -eq $WorkerId) { $hit = $true; break }
                    if ($m -eq "all") { $hit = $true; break }
                    if ($roleGroupTag -and $m -eq $roleGroupTag) { $hit = $true; break }
                }
                if ($hit) {
                    $preflightRoutedMentions += [ordered]@{
                        id      = $msg.id
                        channel = $msg.channel
                        sender  = $msg.sender
                        content = $msg.content
                    }
                }
            }
        }
        if ($preflightRoutedMentions.Count -gt 0) {
            Write-Host "[mention] $($preflightRoutedMentions.Count) unread message(s) tagging $WorkerId -- will surface in system prompt." -ForegroundColor Magenta
        }
    }
    # -------- End pre-flight --------

    # System prompt stays byte-identical across iterations so Anthropic's prompt
    # cache (5min/1h TTL) can hit on the stable prefix. Anything per-task or
    # per-iteration (claimed_task_context, inbox, routed_mentions, skill JIT)
    # is built into $dynamicContext below and prepended to the user message —
    # NOT appended to the system prompt.
    $systemAppend = $systemAppendBase
    $dynamicContext = ""
    if ($preflightOk) {
        # Curate the get_context payload before injection. The full JSON is
        # 5-30KB; agents only need a working subset. Comments are skipped
        # entirely (re-fetch via moe.get_context if needed); implementationPlan
        # notes are capped to 300 chars per step; epic.architectureNotes is
        # dropped (task.description normally covers it).
        $ctxJson = if ($preflightContext) {
            $proj = $preflightContext.project
            $epic = $preflightContext.epic
            $tk = $preflightContext.task
            $trimmedPlan = @()
            if ($tk -and $tk.implementationPlan) {
                foreach ($step in $tk.implementationPlan) {
                    $note = $step.note
                    if ($note -and $note.Length -gt 300) {
                        $note = $note.Substring(0, 300) + '...'
                    }
                    $trimmedPlan += [ordered]@{
                        stepId = $step.stepId
                        title  = $step.title
                        description = $step.description
                        status = $step.status
                        note   = $note
                        modifiedFiles = $step.modifiedFiles
                    }
                }
            }
            # planningNotes from architects can be multi-KB of considered/rejected
            # prose. Workers and QA rarely need it verbatim — cap and point them
            # at moe.get_context for the full text.
            $trimmedPlanningNotes = $preflightContext.planningNotes
            if ($trimmedPlanningNotes -and $trimmedPlanningNotes.Length -gt 1200) {
                $trimmedPlanningNotes = $trimmedPlanningNotes.Substring(0, 1200) + "...(truncated; full text via moe.get_context)"
            }
            $trimmed = [ordered]@{
                project = if ($proj) { [ordered]@{ id = $proj.id; name = $proj.name; globalRails = $proj.globalRails } } else { $null }
                epic    = if ($epic) { [ordered]@{ id = $epic.id; title = $epic.title; epicRails = $epic.epicRails } } else { $null }
                task    = if ($tk) {
                    [ordered]@{
                        id = $tk.id
                        title = $tk.title
                        description = $tk.description
                        status = $tk.status
                        reopenCount = $tk.reopenCount
                        reopenReason = $tk.reopenReason
                        rejectionDetails = $tk.rejectionDetails
                        definitionOfDone = $tk.definitionOfDone
                        implementationPlan = $trimmedPlan
                        taskRails = $tk.taskRails
                    }
                } else { $null }
                # allRails dropped: epic/task arrays are byte-identical to
                # epic.epicRails / task.taskRails above, and global is a subset
                # of project.globalRails.requiredPatterns. Pure duplication.
                planningNotes = $trimmedPlanningNotes
                nextAction = $preflightContext.nextAction
            }
            $trimmed | ConvertTo-Json -Depth 20 -Compress
        } else { "{}" }
        $pendingJson = if ($preflightPending) { $preflightPending | ConvertTo-Json -Depth 20 -Compress } else { "{}" }

        # Compute compact unread counts so we don't embed multi-KB chat-read
        # responses verbatim. Routed mentions are surfaced separately below.
        $generalCount = 0
        if ($preflightGeneralUnread -and $preflightGeneralUnread.messages) {
            $generalCount = @($preflightGeneralUnread.messages).Count
        }
        $taskCount = 0
        if ($preflightTaskUnread -and $preflightTaskUnread.messages) {
            $taskCount = @($preflightTaskUnread.messages).Count
        }
        $mentionsCount = if ($preflightRoutedMentions) { $preflightRoutedMentions.Count } else { 0 }

        $dynamicContext += @"
# Pre-flight Complete (runtime-injected — do not repeat)
You ARE: $Role agent, workerId=$WorkerId.
The wrapper has claimed your task and surfaced unread counts in <inbox> below. Fetch the full content via moe.chat_read when it is relevant; use Serena (list_memories / read_memory) to pick up prior knowledge for this task/area. Routed mentions tagging you are listed verbatim further down — those are mandatory replies before any other planned tool call.

DO NOT re-call at session start: moe.chat_join, moe.claim_next_task, moe.get_context. They are done.

Claimed task id: $preflightTaskId

<claimed_task_context>
$ctxJson
</claimed_task_context>

<inbox>
unread_general=$generalCount
unread_task=$taskCount
mentions=$mentionsCount (see <routed_mentions> below if > 0)
memory=use Serena list_memories / read_memory for prior knowledge on this task/area
</inbox>

<pending_questions>
$pendingJson
</pending_questions>
"@

        # JIT reminder: point the agent at the phase-recommended skill. We do
        # NOT inline the body — the agent loads it itself via the Skill tool.
        if ($preflightSkillName) {
            $jitNextTool = if ($preflightSkillNextTool) { $preflightSkillNextTool } else { "your next Moe tool" }
            $jitReason   = if ($preflightSkillReason)  { $preflightSkillReason }  else { "Phase-recommended for this task." }
            $dynamicContext += @"


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
        $dynamicContext += @"
# Pre-flight Complete: no claimable task
The daemon reports no claimable task for role $Role right now.
Your FIRST action MUST be moe.wait_for_task with statuses=$(($statuses | ConvertTo-Json -Compress)), workerId=$WorkerId.
When it returns hasNext:true, call moe.claim_next_task, then moe.get_context.
If moe.wait_for_task returns hasChatMessage:true, your NEXT calls MUST be moe.chat_read on chatMessage.channel, then moe.chat_send with your reply, THEN moe.wait_for_task again. Do not claim a new task while a routed mention is unanswered.
"@
    }

    # Priority banner for unread messages routed at THIS worker. Goes LAST in
    # the dynamic context so it's the most recent text before the role-specific
    # claimPrompt — maximizes the chance the model replies before any other
    # planned tool call. Role docs back this up with the Mention Response
    # Protocol section.
    if ($preflightRoutedMentions -and $preflightRoutedMentions.Count -gt 0) {
        $mentionsJson = $preflightRoutedMentions | ConvertTo-Json -Depth 8 -Compress
        $mentionCount = $preflightRoutedMentions.Count
        $dynamicContext += @"


<system-reminder>
# Incoming @mentions targeting you ($WorkerId)

You have $mentionCount unread message(s) that named you directly, via @all, or via your role group. Before ANY other planned tool call (moe.start_step, moe.submit_plan, moe.qa_approve, moe.claim_next_task, etc.), you MUST reply to each via moe.chat_send in the same channel. Replies are substantive — answer the question, confirm the handoff, or say why you can't. The Loop Guard (max 4 agent-to-agent hops per channel) is the system's throttle; you don't need your own.

<routed_mentions>
$mentionsJson
</routed_mentions>
</system-reminder>
"@
    }

    # Write system prompt to CLI-specific instruction files (per iteration so pre-flight data is fresh).
    # For codex and gemini we ALSO fold $dynamicContext (claimed_task_context, routed_mentions, skill JIT)
    # into the file. Reason: PowerShell 5.1's `&` operator doesn't escape embedded double quotes when
    # forwarding native-command args on Windows. Task JSON serialized into $dynamicContext routinely
    # contains "..." substrings (e.g. `\"audit.read\"`), which causes codex/gemini to word-split the
    # prompt argv (e.g. "unexpected argument 'VERIFICATION' found"). Claude reads its system prompt
    # from --append-system-prompt-file, so its bug surface is the (mostly quote-free) role directive.
    $codexUsesFileContext = $false
    if ($cliType -eq "codex") {
        $agentInstructionsPath = Join-Path (Join-Path $projectPath ".codex") "agent-instructions.md"
        $codexDir = Split-Path $agentInstructionsPath -Parent
        if (-not (Test-Path $codexDir)) { New-Item -ItemType Directory -Force -Path $codexDir | Out-Null }
        $fileBody = $systemAppend
        if ($dynamicContext) {
            $fileBody += "`n`n# Session Context (per-iteration)`n" + $dynamicContext
            $codexUsesFileContext = $true
        }
        $fileBody | Set-Content -Path $agentInstructionsPath -Encoding UTF8
        Write-Host "Agent instructions written to: $agentInstructionsPath"
    } elseif ($cliType -eq "gemini") {
        $geminiInstructionsDir = Join-Path $projectPath ".gemini"
        if (-not (Test-Path $geminiInstructionsDir)) {
            New-Item -ItemType Directory -Force -Path $geminiInstructionsDir | Out-Null
        }
        $geminiInstructionsPath = Join-Path $geminiInstructionsDir "GEMINI.md"
        $geminiFileBody = $systemAppend
        if ($dynamicContext) {
            $geminiFileBody += "`n`n# Session Context (per-iteration)`n" + $dynamicContext
            $geminiUsesFileContext = $true
        } else {
            $geminiUsesFileContext = $false
        }
        $geminiFileBody | Set-Content -Path $geminiInstructionsPath -Encoding UTF8
        Write-Host "Agent instructions written to: $geminiInstructionsPath"
    }

    # Build the user message prompt — lean when pre-flight succeeded, legacy multi-step otherwise.
    # $dynamicContext (built above) is prepended for cache-friendly system prompt.
    #
    # IMPORTANT: prompts NO LONGER tell the agent to call moe.wait_for_task at the end.
    # The wrapper's outer do/while loop spawns a fresh CLI process per task. Reason:
    # a single long-lived session accumulates conversation history (each turn replays
    # the full cached prefix), driving cache_read tokens into the billions. Per-task
    # respawn caps the cached context to the system prompt + one task's transcript.
    # See "session analysis" findings in this repo for cost data.
    $claimPromptBody = $null
    if ($AutoClaim -and $preflightOk) {
        $claimPromptBody = switch ($Role) {
            "architect" { "Task $preflightTaskId is claimed and its full context is above (<claimed_task_context>). If a <routed_mentions> block is present, reply to each tagged message via moe.chat_send FIRST. Read prior knowledge for this task/area with Serena list_memories / read_memory. Then study the implementationPlan, rails, and definitionOfDone, and call moe.submit_plan with a complete plan. Before you STOP, use Serena write_memory to record a 'task-$preflightTaskId-handoff' note (and any reusable 'decision-<area>' learnings). Then output a one-line text summary of what you planned and STOP. Do NOT poll moe.check_approval — approval is a human gate; the wrapper will respawn you on the next PLANNING task. Do NOT call moe.wait_for_task — the wrapper handles polling between sessions." }
            "worker"    { "Task $preflightTaskId is claimed and its full context is above (<claimed_task_context>). If a <routed_mentions> block is present, reply to each tagged message via moe.chat_send FIRST. Read prior knowledge for this task/area with Serena list_memories / read_memory. Then execute the approved implementationPlan: call moe.start_step for step 0, implement it (write/edit code, run tests), call moe.complete_step, and repeat through the final step. Then call moe.complete_task. Before you STOP, use Serena write_memory to record a 'task-$preflightTaskId-handoff' note plus any non-obvious 'gotcha-<area>' learnings. Then output a one-line text summary and STOP. Do NOT call moe.wait_for_task — the wrapper will pick up the next task in a fresh session." }
            "qa"        { "Task $preflightTaskId is claimed and its full context is above (<claimed_task_context>). If a <routed_mentions> block is present, reply to each tagged message via moe.chat_send FIRST. Read prior knowledge for this task/area with Serena list_memories / read_memory. Then verify the implementation against definitionOfDone and rails. Run the tests. If it passes, call moe.qa_approve. If it fails, call moe.qa_reject with a detailed list of issues. Before you STOP, use Serena write_memory to record a 'task-$preflightTaskId-handoff' note (and any 'gotcha-<area>' failure pattern). Then output a one-line text summary and STOP. Do NOT call moe.wait_for_task — the wrapper will pick up the next task in a fresh session." }
        }
    } elseif ($AutoClaim -and $Role -eq 'governor') {
        # Governor enters governance mode and lives in a chat_wait loop on
        # #governors. They never claim tasks. The wrapper has already called
        # moe.enter_governance; the agent now subscribes to channel signals.
        $claimPromptBody = "You are in governance mode. Read the backlog: moe.chat_channels, find #governors, moe.chat_read it (last 50 messages), then moe.chat_read #general. After catching up, enter the loop: moe.chat_wait with channels=['#governors','#general'] and a long timeout. When it wakes, triage per docs/roles/governor.md (the role doc is appended to your system prompt). Reply via moe.chat_send. Use moe.set_task_status, moe.release_task, moe.propose_rail, or moe.submit_plan_critique when the signal calls for action. Loop forever. Do NOT call moe.claim_next_task."
    } elseif ($AutoClaim -and $preflightNoTask) {
        # No-task case: wrapper's outer loop handles the poll/sleep cycle at the
        # PowerShell level, so we don't launch the CLI just to call wait_for_task.
        # $claimPromptBody stays $null → branch below skips the CLI invocation.
        $claimPromptBody = $null
    } elseif ($AutoClaim) {
        # Pre-flight skipped or failed — legacy multi-step prompt
        $claimPromptBody = "First call moe.chat_channels to find #general, then moe.chat_join and moe.chat_send to announce yourself as $Role. Then call moe.chat_read to catch up on any unread messages. Then call moe.claim_next_task $claimJson. After claiming a task and calling moe.get_context, use Serena list_memories / read_memory to pick up prior knowledge for this task/area. Before calling moe.wait_for_task, use Serena write_memory to record a 'task-<id>-handoff' note (and any gotcha-<area> learnings) so the next agent benefits. If hasNext is false, say: 'No tasks in $Role queue' and wait."
    }

    # $claimPrompt is what gets passed as the user message to the CLI.
    # Combine dynamic context (claimed_task_context, routed mentions, skill JIT,
    # etc.) with the role-specific instruction body. Order: context first, role
    # body last, so the model sees per-task content as setup and the role
    # directive as the latest user request.
    $claimPrompt = $null
    if ($claimPromptBody) {
        if ($dynamicContext) {
            $claimPrompt = $dynamicContext.TrimEnd() + "`n`n" + $claimPromptBody
        } else {
            $claimPrompt = $claimPromptBody
        }
    } elseif ($dynamicContext) {
        $claimPrompt = $dynamicContext.TrimEnd()
    }

    if ($cliType -eq "codex") {
        # Check codex is available
        $codexCheck = Get-Command $Command -ErrorAction SilentlyContinue
        if (-not $codexCheck) {
            Write-Error "Codex command not found: $Command. Install codex CLI first."
            exit 1
        }

        if ($AutoClaim -and ($preflightOk -or $preflightNoTask)) {
            # Pre-flight baked context into .codex/agent-instructions.md. When that file already
            # includes $dynamicContext (see $codexUsesFileContext branch above), we pass only the
            # short role directive on argv to avoid PS 5.1's broken native-command quote escaping
            # tripping over double quotes inside task JSON (e.g. \"audit.read\"). Falls back to the
            # combined $claimPrompt when there's no dynamic context to fold.
            if ($codexUsesFileContext -and $claimPromptBody) {
                $shortPrompt = $claimPromptBody
            } else {
                $shortPrompt = $claimPrompt
            }
        } else {
            # Legacy fallback — pre-flight skipped or failed
            $roleWorkflow = switch ($Role) {
                "architect" { "Workflow: join chat -> read messages -> claim task -> get_context -> read Serena memory -> explore codebase -> submit_plan -> write Serena memory (handoff + learnings) -> announce in chat" }
                "worker"    { "Workflow: join chat -> read messages -> claim task -> read task chat -> get_context -> read Serena memory -> start_step -> implement -> complete_step -> complete_task -> write Serena memory (handoff + learnings) -> announce in chat" }
                "qa"        { "Workflow: join chat -> read messages -> claim task -> read task chat -> get_context -> read Serena memory -> review code and tests -> qa_approve or qa_reject -> write Serena memory (handoff + learnings) -> announce in chat" }
                default     { "Workflow: claim task -> get_context -> read Serena memory -> complete task -> write Serena memory handoff" }
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
            $script:CliExitCode = $LASTEXITCODE
        } else {
            # Interactive TUI mode: codex -C <project> "<prompt>"
            Write-Host "Command: $Command -C `"$projectPath`" `"<prompt>`""
            & $Command @CommandArgs -C "$projectPath" "$shortPrompt"
            $script:CliExitCode = $LASTEXITCODE
        }
    } elseif ($cliType -eq "gemini") {
        # Check gemini is available
        $geminiCheck = Get-Command $Command -ErrorAction SilentlyContinue
        if (-not $geminiCheck) {
            Write-Error "Gemini command not found: $Command. Install Gemini CLI first (npm install -g @google/gemini-cli)."
            exit 1
        }

        if ($AutoClaim -and ($preflightOk -or $preflightNoTask)) {
            # Pre-flight baked context into .gemini/GEMINI.md. When that file already includes
            # $dynamicContext (see $geminiUsesFileContext branch above), pass only the short role
            # directive on argv to avoid PS 5.1's broken native-command quote escaping tripping over
            # double quotes inside task JSON. Falls back to combined $claimPrompt otherwise.
            if ($geminiUsesFileContext -and $claimPromptBody) {
                $shortPrompt = $claimPromptBody
            } else {
                $shortPrompt = $claimPrompt
            }
        } else {
            $roleWorkflow = switch ($Role) {
                "architect" { "Workflow: join chat -> read messages -> claim task -> get_context -> read Serena memory -> explore codebase -> submit_plan -> write Serena memory (handoff + learnings) -> announce in chat" }
                "worker"    { "Workflow: join chat -> read messages -> claim task -> read task chat -> get_context -> read Serena memory -> start_step -> implement -> complete_step -> complete_task -> write Serena memory (handoff + learnings) -> announce in chat" }
                "qa"        { "Workflow: join chat -> read messages -> claim task -> read task chat -> get_context -> read Serena memory -> review code and tests -> qa_approve or qa_reject -> write Serena memory (handoff + learnings) -> announce in chat" }
                default     { "Workflow: claim task -> get_context -> read Serena memory -> complete task -> write Serena memory handoff" }
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
            try {
                Push-Location $projectPath
                & $Command @CommandArgs --prompt "$shortPrompt" --yolo
                $script:CliExitCode = $LASTEXITCODE
            } finally { Pop-Location }
        } else {
            # Interactive mode
            Write-Host "Command: $Command --prompt-interactive `"<prompt>`""
            try {
                Push-Location $projectPath
                & $Command @CommandArgs --prompt-interactive "$shortPrompt"
                $script:CliExitCode = $LASTEXITCODE
            } finally { Pop-Location }
        }
    } else {
        # Enable Claude Code subagents for all Moe roles by default. Architects
        # benefit hugely from Explore-style parallel research during planning;
        # workers fan out test runs; QA spawns a code-reviewer subagent for
        # the diff pass. Opt-out via project.json settings.enableAgentTeams=false.
        if ($env:CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS) {
            Remove-Item Env:\CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS -ErrorAction SilentlyContinue
        }
        if ($enableAgentTeams) {
            $env:CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = "1"
        }

        # Claude Code: use --mcp-config and --append-system-prompt-file
        # Write system prompt to a temp file to avoid command-line quoting issues
        # (the system prompt contains XML tags, backticks, JSON, and newlines that
        # break PowerShell's argument passing to native commands)
        $systemPromptFile = Join-Path $env:TEMP "moe-system-prompt-$Role-$myPid.md"
        [System.IO.File]::WriteAllText($systemPromptFile, $systemAppend, [System.Text.UTF8Encoding]::new($false))

        # Token-budget telemetry. Always print a one-line summary so we can
        # spot regressions in the agent's stdout. Set MOE_DEBUG_PROMPT_SIZE=1
        # for a per-section breakdown.
        $sysBytes      = [System.Text.Encoding]::UTF8.GetByteCount($systemAppend)
        $dynBytes      = if ($dynamicContext) { [System.Text.Encoding]::UTF8.GetByteCount($dynamicContext) } else { 0 }
        $bodyBytes     = if ($claimPromptBody) { [System.Text.Encoding]::UTF8.GetByteCount($claimPromptBody) } else { 0 }
        $claimBytes    = if ($claimPrompt) { [System.Text.Encoding]::UTF8.GetByteCount($claimPrompt) } else { 0 }
        $totalBytes    = $sysBytes + $claimBytes
        $totalTokens   = [int]($totalBytes / 4)
        Write-Host "[prompt-size] sys=${sysBytes}B dyn=${dynBytes}B body=${bodyBytes}B claim=${claimBytes}B total=${totalBytes}B (~${totalTokens} tok)" -ForegroundColor Cyan
        if ($env:MOE_DEBUG_PROMPT_SIZE -eq "1") {
            Write-Host "[prompt-size:detail] systemAppend file: $systemPromptFile" -ForegroundColor DarkCyan
            Write-Host "[prompt-size:detail] role=$Role workerId=$WorkerId taskId=$preflightTaskId" -ForegroundColor DarkCyan
        }

        $modelArgs = @()
        if ($resolvedModel) { $modelArgs = @("--model", $resolvedModel) }

        # No-task fast path: when the pre-flight reports no claimable task, skip
        # launching the CLI entirely. The outer do/while loop will sleep
        # PollInterval seconds and retry pre-flight. Avoids paying for a CLI
        # session whose only job would be to call moe.wait_for_task.
        #
        # Governor is excluded: governors never claim tasks (preflightNoTask is
        # synthesized true on every iteration), but they DO need an interactive
        # Claude session so the human can drive governance decisions. Skipping
        # the launch would leave the governor terminal dead.
        if ($AutoClaim -and $preflightNoTask -and $Role -ne 'governor') {
            Write-Host "[no-task] Skipping CLI launch — wrapper will poll again in $PollInterval s." -ForegroundColor DarkGray
            $script:CliExitCode = 0
            # Jump past the launch block to the post-flight cleanup.
            $launchSkipped = $true
        } else {
            $launchSkipped = $false
        }

        if (-not $launchSkipped) {
            # Windows CreateProcess caps the total command line at ~32K UTF-16 chars
            # (~8K through cmd.exe). $claimPrompt — claimed_task_context + inbox +
            # routed_mentions + role directive — can blow past that for workers
            # whose tasks carry a fat implementationPlan. When it would, embed the
            # whole user-prompt body into the system-prompt file (Claude has no
            # --user-message-file flag) and hand the CLI a tiny sentinel.
            $userPromptForCli = $claimPrompt
            $WIN_CMD_SAFE_THRESHOLD = 6000
            $isWin = ($env:OS -eq "Windows_NT")
            if ($isWin -and $claimPrompt -and $claimPrompt.Length -gt $WIN_CMD_SAFE_THRESHOLD) {
                $overflow = "`n`n# === Per-iteration runtime context (delivered as system prompt because Windows command line cannot fit it as a user message) ===`n" + $claimPrompt
                [System.IO.File]::AppendAllText($systemPromptFile, $overflow, [System.Text.UTF8Encoding]::new($false))
                $userPromptForCli = "Begin. Your full task context, claimed_task_context, routed mentions, and role directive are at the END of the appended system prompt. Treat the role directive there as your active user request."
                Write-Host "[prompt-overflow] claimPrompt=$($claimPrompt.Length) chars > $WIN_CMD_SAFE_THRESHOLD; embedded in system prompt file to bypass Windows command-line limit." -ForegroundColor Yellow
            }

            # Per-task one-shot mode. --print runs claude non-interactively: the
            # model executes tool calls until it produces an end_turn without a
            # tool call, then the process exits. Combined with the prompt change
            # that removes the wait_for_task chain, this caps each CLI invocation
            # at one task. Drops cached-prefix replay cost dramatically vs the
            # old long-lived session that polled internally.
            #
            # We use --output-format stream-json --include-partial-messages so
            # tool calls and partial text stream out as JSON events. A small
            # PowerShell parser below pretty-prints those events so the operator
            # can see what the agent is doing in real time. Without this, --print
            # is silent during tool-call phases (sometimes minutes), which is
            # indistinguishable from a hang.
            #
            # Opt-out: -Interactive switches to the full TUI so the operator can
            # drive the agent (clarifying questions, follow-ups, etc.). Because
            # each polling-loop iteration spawns a fresh CLI invocation, the
            # cached prefix is paid once per task in either mode — there is no
            # multi-turn replay penalty for interactive mode.
            $usePrintMode = -not $Interactive
            $printArgs = @()
            if ($usePrintMode) {
                $printArgs = @(
                    "--print",
                    "--permission-mode", "bypassPermissions",
                    "--output-format", "stream-json",
                    "--include-partial-messages",
                    "--verbose"
                )
            }

            # Prompt-cache stability. The default Claude Code system prompt
            # bakes in per-launch / per-machine sections (cwd, env info, memory
            # paths, git status) AHEAD of our --append-system-prompt-file
            # content, so the volatile bits sit at the front of the prefix and
            # invalidate the cache on every launch. This flag moves them into
            # the first user message, leaving the stable default system prompt
            # + our role/CLAUDE.md/skills as a contiguous cacheable prefix.
            # Safe with --append-system-prompt-file (only ignored if
            # --system-prompt is set, which we never pass). Opt out via
            # MOE_NO_DYNAMIC_PROMPT_EXCLUDE=1 if it regresses behaviour.
            $cacheArgs = @()
            if (-not $env:MOE_NO_DYNAMIC_PROMPT_EXCLUDE) {
                $cacheArgs = @("--exclude-dynamic-system-prompt-sections")
            }

            # Inline stream-json parser. Reads one JSON line at a time, prints
            # human-readable summaries of tool_use / text / rate_limit events.
            $parseStreamJson = {
                param($line)
                if ([string]::IsNullOrWhiteSpace($line)) { return }
                $evt = $null
                try { $evt = $line | ConvertFrom-Json -ErrorAction Stop } catch {
                    # Non-JSON line (warning, banner, etc.) — pass through
                    Write-Host $line
                    return
                }
                switch ($evt.type) {
                    "system" {
                        if ($evt.subtype -eq "init") {
                            $toolCount = if ($evt.tools) { @($evt.tools).Count } else { 0 }
                            $mcpCount  = if ($evt.mcp_servers) { @($evt.mcp_servers).Count } else { 0 }
                            Write-Host "  [init] $toolCount tools, $mcpCount MCP server(s), model=$($evt.model)" -ForegroundColor DarkGray
                        }
                    }
                    "stream_event" {
                        $e = $evt.event
                        switch ($e.type) {
                            "content_block_start" {
                                $cb = $e.content_block
                                if ($cb.type -eq "tool_use") {
                                    $script:moeToolName = $cb.name
                                    $script:moeToolJson = ""
                                    Write-Host "  → $($cb.name)" -NoNewline -ForegroundColor Cyan
                                } elseif ($cb.type -eq "text") {
                                    Write-Host "  " -NoNewline
                                    $script:moeInText = $true
                                } else {
                                    $script:moeInText = $false
                                }
                            }
                            "content_block_delta" {
                                $d = $e.delta
                                if ($d.type -eq "text_delta") {
                                    Write-Host -NoNewline $d.text
                                } elseif ($d.type -eq "input_json_delta") {
                                    $script:moeToolJson += $d.partial_json
                                }
                            }
                            "content_block_stop" {
                                if ($script:moeToolJson) {
                                    # Compact the tool's input to a short summary
                                    $j = $script:moeToolJson
                                    if ($j.Length -gt 140) { $j = $j.Substring(0, 140) + "..." }
                                    Write-Host " $j" -ForegroundColor DarkGray
                                    $script:moeToolJson = ""
                                } elseif ($script:moeInText) {
                                    Write-Host ""
                                    $script:moeInText = $false
                                }
                            }
                        }
                    }
                    "rate_limit_event" {
                        $rl = $evt.rate_limit_info
                        if ($rl) {
                            $resets = if ($rl.resetsAt) { [DateTimeOffset]::FromUnixTimeSeconds($rl.resetsAt).LocalDateTime.ToString('MM-dd HH:mm') } else { "?" }
                            $tag = if ($rl.isUsingOverage) { "OVERAGE" } else { $rl.status }
                            Write-Host "  [rate-limit $tag $($rl.rateLimitType) resets=$resets]" -ForegroundColor Yellow
                        }
                    }
                    "result" {
                        $dur = if ($evt.duration_ms) { "$([math]::Round($evt.duration_ms/1000.0,1))s" } else { "?" }
                        $color = if ($evt.is_error) { "Red" } else { "Green" }
                        Write-Host "  [result] turns=$($evt.num_turns) dur=$dur stop=$($evt.stop_reason)" -ForegroundColor $color
                    }
                }
            }

            if ($userPromptForCli) {
                Write-Host "Command: $Command $($modelArgs -join ' ') --mcp-config `"$mcpConfigFile`" --append-system-prompt-file `"$systemPromptFile`" $($cacheArgs -join ' ') --effort max $($printArgs -join ' ') `"<prompt>`""
                if ($usePrintMode) {
                    # Stream output through the parser. ForEach-Object processes
                    # lines as they arrive (no buffering), so the user sees
                    # activity in real time.
                    $script:moeToolJson = ""
                    $script:moeToolName = $null
                    $script:moeInText = $false
                    & $Command @CommandArgs @modelArgs --mcp-config "$mcpConfigFile" --append-system-prompt-file "$systemPromptFile" @cacheArgs --effort max @printArgs "$userPromptForCli" 2>&1 | ForEach-Object { & $parseStreamJson $_ }
                    $script:CliExitCode = $LASTEXITCODE
                } else {
                    & $Command @CommandArgs @modelArgs --mcp-config "$mcpConfigFile" --append-system-prompt-file "$systemPromptFile" @cacheArgs --effort max @printArgs "$userPromptForCli"
                    $script:CliExitCode = $LASTEXITCODE
                }
            } else {
                Write-Host "Command: $Command $($modelArgs -join ' ') --mcp-config `"$mcpConfigFile`" --append-system-prompt-file `"$systemPromptFile`" $($cacheArgs -join ' ') --effort max $($printArgs -join ' ')"
                if ($usePrintMode) {
                    $script:moeToolJson = ""
                    & $Command @CommandArgs @modelArgs --mcp-config "$mcpConfigFile" --append-system-prompt-file "$systemPromptFile" @cacheArgs --effort max @printArgs 2>&1 | ForEach-Object { & $parseStreamJson $_ }
                    $script:CliExitCode = $LASTEXITCODE
                } else {
                    & $Command @CommandArgs @modelArgs --mcp-config "$mcpConfigFile" --append-system-prompt-file "$systemPromptFile" @cacheArgs --effort max @printArgs
                    $script:CliExitCode = $LASTEXITCODE
                }
            }
        }
    }

    # -------- Post-flight: shutdown rituals after CLI exits --------
    # Save session summary + announce session end in #general. Best-effort.
    Invoke-PostFlight

    if ($AutoClaim -and $preflightTaskId) {
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
                            # Skip THIS task's commit and keep polling — `return`
                            # here would exit the whole script and silently kill
                            # the worker's polling loop (bash uses `continue`).
                            continue
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
