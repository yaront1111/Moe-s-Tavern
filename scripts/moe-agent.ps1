param(
    [ValidateSet("architect", "worker", "qa", "governor")]
    [string]$Role = "worker",

    [string]$Project,
    [string]$ProjectName,
    [string]$WorkerId,

    # Agent CLI: claude (default), codex, gemini, grok, or a custom command path.
    # The basename (extension stripped) selects the launch branch and the
    # per-CLI MCP config writer.
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

    # Force grok into headless mode (non-interactive, --prompt-file --yolo).
    # Unlike codex/gemini, grok's default polarity is role-based exactly like
    # claude's: architect/governor open the TUI, worker/qa run headless, and an
    # explicit -Interactive / -Interactive:$false wins. -GrokExec overrides all
    # of that to headless (JetBrains passes it for hands-off fleet launches).
    [switch]$GrokExec,

    # Force claude into interactive TUI mode (no --print, no stream-json parser).
    # Use when you want to drive the agent yourself — typing into the REPL after
    # the pre-flight has claimed a task and loaded the role/MCP context.
    # The polling loop is unaffected: each loop iteration spawns a fresh CLI
    # invocation, so per-task cache replay is the same as --print mode (no
    # multi-turn replay cost compounding). Architect defaults to interactive
    # because planning benefits from clarifying questions; worker and qa stay
    # opt-in (JetBrains opts the worker in for hands-on coding sessions).
    [switch]$Interactive,

    # Explicit model override (e.g. "claude-sonnet-5", "claude-opus-4-8").
    # When empty, the launcher picks a per-role default — all roles → Opus 5.
    # Per-project overrides via .moe/project.json settings.models.{role}. Only
    # applies to the `claude` CLI; codex/gemini pick their own model. Grok gets
    # `-m <model>` only when one is explicit (-Model, settings.models.<role>,
    # MOE_GROK_MODEL) - the per-role default below is never passed to grok.
    [string]$Model = ""
)

# Fail fast on unhandled cmdlet errors. Per-call `-ErrorAction SilentlyContinue`
# overrides this for spots that intentionally rely on non-terminating errors
# (Resolve-Path with missing paths, Get-Process for stale PIDs, etc.).
$ErrorActionPreference = 'Stop'

if ($Loop -and $NoLoop) {
    # Not Write-Error: with $ErrorActionPreference='Stop' (above) it becomes a
    # terminating error and the script dies with exit 1 before reaching exit 2.
    [Console]::Error.WriteLine("Conflicting switches: -Loop and -NoLoop cannot be used together. Choose -Loop for polling mode or -NoLoop for single-shot mode.")
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

# The key grok stores a folder's trust under: the absolute path with the
# filesystem's OWN casing. Grok canonicalises its cwd before the lookup and
# compares the key case-exactly, so an entry written with a hand-typed
# 'D:\Projexts\x' never matches on-disk 'D:\projexts\x'. Resolve-Path and
# GetFullPath keep the caller's casing (Get-Item.FullName fixes it only on
# pwsh 7), so rebuild the path from the directory listings - works on
# Windows PowerShell 5.1 too. Falls back to the plain full path on any error.
function Get-GrokTrustKey {
    param([string]$ProjectPath)
    $full = [System.IO.Path]::GetFullPath($ProjectPath).TrimEnd('\', '/')
    try {
        $root = [System.IO.Path]::GetPathRoot($full)
        if ([string]::IsNullOrEmpty($root)) { return $full }
        $rest = $full.Substring($root.Length).Trim('\', '/')
        $cased = $root.TrimEnd('\', '/')
        if ($cased -match '^[a-z]:$') { $cased = $cased.ToUpperInvariant() }
        if (-not $rest) { return ($cased + '\') }
        foreach ($seg in ($rest -split '[\\/]+')) {
            if (-not $seg) { continue }
            $parent = if ($cased -match ':$') { $cased + '\' } else { $cased }
            $hit = $null
            try {
                $hit = Get-ChildItem -LiteralPath $parent -Force -ErrorAction Stop |
                    Where-Object { $_.Name -ieq $seg } | Select-Object -First 1
            } catch { $hit = $null }
            $name = if ($hit) { $hit.Name } else { $seg }
            $cased = Join-Path $parent $name
        }
        return $cased
    } catch {
        return $full
    }
}

# Grok refuses a project's .grok/config.toml MCP servers until the folder is
# trusted in <GROK_HOME|~/.grok>/trusted_folders.toml - silently: the servers
# never spawn and the session reports them as "failed to connect" (grok mcp
# doctor says "folder untrusted"). The TUI asks on first open; a headless
# worker never sees that prompt. Grant trust up front; idempotent, a present
# entry is left alone (a `trusted = false` there is a human's decline - it is
# reported, never overturned). Key format mirrors grok's own writes:
# [folders.'<absolute path, on-disk casing>'].
function Grant-GrokFolderTrust {
    param([string]$ProjectPath)
    $mutex = $null
    if ([string]::IsNullOrWhiteSpace($ProjectPath)) { return }
    try {
        $key = Get-GrokTrustKey -ProjectPath $ProjectPath
        if ($key.Contains("'")) {
            Write-Host "[WARN] Cannot pre-trust '$key' for grok (quote in path) - accept the trust prompt once in the grok TUI."
            return
        }
        # grok keeps its store under GROK_HOME when that is set, else ~/.grok.
        $grokHome = if (-not [string]::IsNullOrWhiteSpace($env:GROK_HOME)) { $env:GROK_HOME } else { Join-Path $env:USERPROFILE ".grok" }
        $trustFile = Join-Path $grokHome "trusted_folders.toml"
        # moe-team.ps1 launches every role at once and each wrapper runs this
        # pre-flight; serialise the check-then-append so two first launches
        # cannot double-append the table (grok then fails to parse the file
        # and treats the project as untrusted for good).
        $mutex = New-Object System.Threading.Mutex($false, 'Local\moe-grok-trusted-folders')
        try { [void]$mutex.WaitOne(10000) } catch [System.Threading.AbandonedMutexException] { }
        $existing = ""
        if (Test-Path -LiteralPath $trustFile) { $existing = [System.IO.File]::ReadAllText($trustFile) }
        $header = "[folders.'$key']"
        $at = $existing.IndexOf($header, [System.StringComparison]::Ordinal)
        if ($at -ge 0) {
            $tail = $existing.Substring($at + $header.Length)
            $nextTable = $tail.IndexOf("`n[", [System.StringComparison]::Ordinal)
            $table = if ($nextTable -ge 0) { $tail.Substring(0, $nextTable) } else { $tail }
            if ($table -match '(?m)^\s*trusted\s*=\s*false') {
                Write-Host "[WARN] grok trust for '$key' was declined in the grok TUI ($trustFile) - grok will not start the project's MCP servers. Set trusted = true there, or accept the prompt in the TUI."
            }
            return
        }
        if (-not (Test-Path -LiteralPath $grokHome)) { New-Item -ItemType Directory -Force -Path $grokHome | Out-Null }
        $epoch = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
        $newTable = "$header`ntrusted = true`ndecided_at = $epoch`n"
        $text = if ([string]::IsNullOrWhiteSpace($existing)) { $newTable } else { $existing.TrimEnd() + "`n`n" + $newTable }
        [System.IO.File]::WriteAllText($trustFile, $text, [System.Text.UTF8Encoding]::new($false))
        Write-Host "Grok folder trust granted: $key"
    } catch {
        Write-Host "[WARN] Could not pre-trust the project for grok: $_"
    } finally {
        if ($mutex) {
            try { $mutex.ReleaseMutex() } catch { }
            $mutex.Dispose()
        }
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
# Never let a git call (push/pull/fetch in the post-flight) block on a
# credential or host-key prompt: the wrapper is unattended for its lifetime.
$env:GIT_TERMINAL_PROMPT = '0'

# Graceful deregister, fired from multiple exit paths. The top-level `finally`
# below covers normal exits, but it is SKIPPED on a console-window close
# (CTRL_CLOSE_EVENT) and some Ctrl+C edge cases — leaving the worker holding its
# claimed task until the next daemon restart, a moe.deregister_worker, or a
# manual/governor release (there is deliberately NO idle-based auto-release for
# WORKING/PLANNING). Register the same best-effort deregister on PowerShell.Exiting and
# Ctrl+C so it runs no matter how the process tears down. $script:MoeDeregistered
# makes it idempotent (finally + handler must not double-fire). Defined here,
# before any exit can occur, so the flag/function always exist; Invoke-MoeRpc is
# resolved lazily at call time (it's defined further down).
$script:MoeDeregistered = $false
# Set by Start-HeartbeatSidecar (defined later) to whatever heartbeat job is
# CURRENTLY running, so an async Ctrl+C/exit handler firing mid-task can reach
# it — a local try/finally around one CLI invocation only covers normal
# unwinds, not this class of abrupt teardown.
$script:CurrentHeartbeatJob = $null
function Invoke-MoeDeregister {
    # Kill any live heartbeat sidecar first — it's an unmanaged background
    # process (Start-Job's child powershell.exe) that outlives this one unless
    # explicitly stopped; unconditional and idempotent, so it runs even when
    # the deregister-proper half below is skipped by MoeDeregistered.
    if ($script:CurrentHeartbeatJob) {
        try { Stop-Job -Job $script:CurrentHeartbeatJob -ErrorAction SilentlyContinue | Out-Null } catch {}
        try { Remove-Job -Job $script:CurrentHeartbeatJob -Force -ErrorAction SilentlyContinue | Out-Null } catch {}
        $script:CurrentHeartbeatJob = $null
    }
    if ($script:MoeDeregistered) { return }
    $script:MoeDeregistered = $true
    if (-not $WorkerId) { return }
    try { Invoke-MoeRpc -Tool "deregister_worker" -Args @{ workerId = $WorkerId; reason = "terminal_closed" } | Out-Null } catch {}
}
# PowerShell.Exiting fires for normal exits AND console-window close in 5.1.
try { Register-EngineEvent -SourceIdentifier ([System.Management.Automation.PsEngineEvent]::Exiting) -Action { Invoke-MoeDeregister } | Out-Null } catch {}
# Ctrl+C: hook the static Console.CancelKeyPress event directly (Register-Object
# Event can't bind a static .NET event). TreatControlCAsInput stays false so the
# default terminate-after-handler behaviour is preserved; we just deregister on
# the way out.
# Measured on Windows PowerShell 5.1: this scriptblock and the PowerShell.Exiting
# handler above are INERT (no runspace is available on the foreign thread they
# fire on). What actually runs on Ctrl+C is the outer `finally` at the bottom of
# this script — that is where the teardown rescue + deregister live. Never put
# git work in these handlers.
try {
    [Console]::TreatControlCAsInput = $false
    [Console]::add_CancelKeyPress({ Invoke-MoeDeregister })
} catch {}

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
# Grok's per-iteration prompt file (set in the grok launch branch, removed in
# the outer finally on every exit path) and the pre-launch values of the GROK_*
# env the branch overrides (restored in the same finally).
$script:GrokPromptFile = $null
$script:GrokEnvPrev = $null

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

# Load role-specific instructions (.moe/roles/ with fallback to plugin docs/roles/).
# Re-resolved and re-read every loop iteration: the daemon upgrades .moe/roles/
# in place (sha-marker convention) while this wrapper runs, and a respawned
# agent must pick up the latest guidance. Unchanged file -> identical bytes ->
# the prompt-cache prefix stays stable.
function Get-RoleDoc {
    $p = Join-Path $moeDir "roles\$Role.md"
    if (-not (Test-Path $p) -and $pluginRoot) {
        $p = Join-Path $pluginRoot "docs\roles\$Role.md"
    }
    if (Test-Path $p) { return Get-Content -Raw -Path $p }
    return ""
}
$roleDoc = Get-RoleDoc
if ($roleDoc) {
    Write-Host "Loaded role guide for $Role"
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
# All roles default to Opus 5, launched with --effort max below. Override
# per role via project.json settings.models.{role}.
$defaultModels = @{
    architect = "claude-opus-5"
    worker    = "claude-opus-5"
    qa        = "claude-opus-5"
    governor  = "claude-opus-5"
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
elseif ($cmdBase -eq "grok") { $cliType = "grok" }
# Codex is interactive by default, but -CodexExec enables non-interactive headless mode
$codexInteractive = ($cliType -eq "codex") -and (-not $CodexExec)
# Gemini is interactive by default, but -GeminiExec enables non-interactive headless mode
$geminiInteractive = ($cliType -eq "gemini") -and (-not $GeminiExec)
# Claude defaults to --print (one-shot stream); -Interactive flips it to TUI.
$claudeInteractive = ($cliType -eq "claude") -and $Interactive
# Grok follows claude's role polarity, not codex/gemini's always-interactive
# default: $Interactive is already resolved above (architect/governor true,
# worker/qa false, an explicit switch wins), and -GrokExec forces headless.
$grokInteractive = ($cliType -eq "grok") -and $Interactive -and (-not $GrokExec)

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
        $codexReasoningEffort = if ($env:MOE_CODEX_REASONING_EFFORT) { $env:MOE_CODEX_REASONING_EFFORT } else { "xhigh" }
        $topLevelConfig = @"
model_instructions_file = "agent-instructions.md"
model_reasoning_effort = "$codexReasoningEffort"
developer_instructions = """`nYou are a $Role agent in the Moe AI Workforce system. You MUST use Moe MCP tools (moe.*) for ALL task operations. Follow the Moe workflow strictly. Never edit .moe/ files directly.`n"""
"@

        # Build the moe MCP server TOML block. Codex's default MCP startup
        # timeout is 30s, which the proxy can exceed while it waits for a
        # supervised daemon (re)start to rewrite daemon.json.
        $codexMcpStartupTimeout = 120
        if ($env:MOE_CODEX_MCP_STARTUP_TIMEOUT_SEC -match '^\d+$') {
            $codexMcpStartupTimeout = [int]$env:MOE_CODEX_MCP_STARTUP_TIMEOUT_SEC
        }
        # Persist a daemon host override so the spawned proxy dials the right
        # address even if codex doesn't forward the wrapper's environment.
        $moeDaemonHostLine = if ($env:MOE_DAEMON_HOST) { "`nMOE_DAEMON_HOST = `"$($env:MOE_DAEMON_HOST)`"" } else { "" }
        $moeTomlBlock = @"

[mcp_servers.moe]
command = "node"
args = ["$proxyScriptForToml"]
startup_timeout_sec = $codexMcpStartupTimeout

[mcp_servers.moe.env]
MOE_PROJECT_PATH = "$projectPathForToml"$moeDaemonHostLine
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

            # Remove old model_instructions_file / model_reasoning_effort lines
            $rawContent = $rawContent -replace '(?m)^model_instructions_file\s*=.*\r?\n?', ''
            $rawContent = $rawContent -replace '(?m)^model_reasoning_effort\s*=.*\r?\n?', ''

            # Remove old developer_instructions (triple-quoted multi-line)
            $rawContent = $rawContent -replace '(?s)(?m)^developer_instructions\s*=\s*""".*?"""\s*\r?\n?', ''
            # Remove old developer_instructions (single-line)
            $rawContent = $rawContent -replace '(?m)^developer_instructions\s*=\s*"[^"]*"\s*\r?\n?', ''

            # Filter out the sections this writer owns and re-emits: [mcp_servers.moe],
            # [mcp_servers.moe.env], [mcp_servers.serena]. Serena SUBtables (e.g.
            # [mcp_servers.serena.tools.*], user-authored per-tool config) are kept
            # while Serena is installed, but must be stripped when it is not: an
            # orphaned [mcp_servers.serena.*] with no parent transport makes codex
            # reject the whole config ("invalid transport in mcp_servers.serena").
            $serenaInstalled = -not [string]::IsNullOrEmpty($serenaTomlBlock)
            $lines = $rawContent -split '\r?\n'
            $cleaned = @()
            $skip = $false
            foreach ($line in $lines) {
                $stripped = $line.Trim()
                if ($stripped.StartsWith('[')) {
                    $skip = ($stripped -match '^\[mcp_servers\.moe(\]|\.env\])') -or
                            ($stripped -match '^\[mcp_servers\.serena\]') -or
                            ((-not $serenaInstalled) -and $stripped -match '^\[mcp_servers\.serena\.')
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
    # Recursively convert a PSCustomObject graph (as produced by ConvertFrom-Json
    # WITHOUT -AsHashtable on Windows PowerShell 5.1, where -AsHashtable does not
    # exist) into nested hashtables, so the merge below — which relies on
    # .ContainsKey()/index assignment — behaves identically to -AsHashtable on
    # PowerShell 6+.
    function ConvertTo-MoeHashtable {
        param($InputObject)
        if ($null -eq $InputObject) { return $null }
        if ($InputObject -is [System.Collections.IDictionary]) {
            $ht = @{}
            foreach ($key in $InputObject.Keys) {
                $ht[$key] = ConvertTo-MoeHashtable $InputObject[$key]
            }
            return $ht
        }
        if ($InputObject -is [System.Management.Automation.PSCustomObject]) {
            $ht = @{}
            foreach ($prop in $InputObject.PSObject.Properties) {
                $ht[$prop.Name] = ConvertTo-MoeHashtable $prop.Value
            }
            return $ht
        }
        if ($InputObject -is [System.Collections.IEnumerable] -and $InputObject -isnot [string]) {
            $list = @()
            foreach ($item in $InputObject) {
                $list += ,(ConvertTo-MoeHashtable $item)
            }
            return ,$list
        }
        return $InputObject
    }
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

        # Merge with existing settings.json if present. -AsHashtable is PowerShell
        # 6+ only; on Windows PowerShell 5.1 it throws, so parse to a PSCustomObject
        # and convert recursively. NEVER fall back to @{} on a NON-EMPTY source file:
        # that would silently clobber the user's existing Gemini config. On a parse
        # failure of a non-empty file we preserve the file untouched and skip the
        # merge instead.
        $geminiConfig = @{}
        $geminiParseFailed = $false
        if (Test-Path $geminiConfigFile) {
            $geminiRaw = Get-Content -Raw -Path $geminiConfigFile
            if (-not [string]::IsNullOrWhiteSpace($geminiRaw)) {
                try {
                    if ($PSVersionTable.PSVersion.Major -ge 6) {
                        $geminiConfig = $geminiRaw | ConvertFrom-Json -AsHashtable
                    } else {
                        $geminiConfig = ConvertTo-MoeHashtable ($geminiRaw | ConvertFrom-Json)
                    }
                    if ($geminiConfig -isnot [System.Collections.IDictionary]) {
                        # Top-level JSON wasn't an object (array/scalar) — don't clobber.
                        $geminiParseFailed = $true
                    }
                } catch {
                    $geminiParseFailed = $true
                }
            }
        }

        if ($geminiParseFailed) {
            Write-Host "WARNING: $geminiConfigFile is not a valid JSON object; leaving it untouched and skipping the Gemini MCP config merge to avoid clobbering it." -ForegroundColor Yellow
        } else {
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
        }
    } catch {
        Write-Error "Failed to write Gemini MCP config: $_"
        exit 1
    }
} elseif ($cliType -eq "grok") {
    # For grok: write project-scoped .grok/config.toml - the same
    # [mcp_servers.<name>] TOML shape as codex, with two load-bearing
    # differences: (1) a grok PROJECT config may only carry [mcp_servers.*],
    # [plugins], [permission] and [mcp] tables, so NO top-level keys are
    # written (no model_reasoning_effort / developer_instructions /
    # project_doc_fallback_filenames); (2) grok expands ${VAR} / ${VAR:-default}
    # inside env/args/command values at load time, so MOE_WORKER_ID is written
    # as a LITERAL template that resolves per process - the launchers export
    # the real id, a human running grok by hand gets "" (which the proxy
    # treats as unset). Serena's --context is "agent" here (not "codex").
    Write-Host "Writing project-scoped Grok MCP config..."
    $grokConfigDir = Join-Path $projectPath ".grok"
    $grokConfigFile = Join-Path $grokConfigDir "config.toml"
    try {
        if (-not (Test-Path $grokConfigDir)) {
            New-Item -ItemType Directory -Force -Path $grokConfigDir | Out-Null
        }

        # Forward slashes: TOML basic strings treat backslashes as escapes.
        $proxyScriptForToml = $proxyScript.ToString().Replace('\', '/')
        $projectPathForToml = $projectPath.ToString().Replace('\', '/')
        # Same startup_timeout_sec key and the same reason as codex: the proxy
        # waits out a supervised daemon restart, which outlasts a 30s default.
        # Digits only (at most nine, so the [int] cast cannot throw and abort
        # the launch); anything else keeps 120.
        $grokMcpStartupTimeout = 120
        if ($env:MOE_GROK_MCP_STARTUP_TIMEOUT_SEC -match '^\d{1,9}$') {
            $grokMcpStartupTimeout = [int]$env:MOE_GROK_MCP_STARTUP_TIMEOUT_SEC
        }
        # Persist a daemon host override (WSL mode) so the spawned proxy dials
        # the right address even if grok doesn't forward the wrapper's env.
        $grokDaemonHostLine = if ($env:MOE_DAEMON_HOST) { "`nMOE_DAEMON_HOST = `"$($env:MOE_DAEMON_HOST)`"" } else { "" }
        # Single-quoted on purpose: ${MOE_WORKER_ID:-} is grok's template
        # syntax, and a double-quoted PowerShell string would try to expand it.
        $grokWorkerIdLine = 'MOE_WORKER_ID = "${MOE_WORKER_ID:-}"'
        # Grok drops any MCP tool whose name contains a dot (it namespaces
        # tools as <server>__<tool> and validates the result), so the daemon's
        # moe.<name> tools all vanish - the server shows as connected with 0
        # tools, then "failed to connect" (measured 2026-09-05, grok 1.0.13).
        # The proxy exposes moe_<name> instead and maps it back on tools/call.
        $grokToolNameStyleLine = 'MOE_TOOL_NAME_STYLE = "underscore"'
        # Per-call timeout on grok's side. Grok's default is 6000s, and a
        # response grok fails to decode (seen once on a 68 KB list_tasks
        # result: mcp_transport_decode_error, then the call sat for minutes
        # until cancelled by hand) is simply lost - the proxy's own 30s guard
        # only covers daemon silence. 120s fails such a call fast so the model
        # retries; the three blocking long-polls keep a budget above the
        # daemon's 10-minute park. Digits only (at most nine, so the [int]
        # cast cannot throw and abort the launch); anything else keeps 120.
        $grokMcpToolTimeout = 120
        if ($env:MOE_GROK_MCP_TOOL_TIMEOUT_SEC -match '^\d{1,9}$') {
            $grokMcpToolTimeout = [int]$env:MOE_GROK_MCP_TOOL_TIMEOUT_SEC
        }
        $grokMoeTomlBlock = (@(
            "",
            "[mcp_servers.moe]",
            "command = `"node`"",
            "args = [`"$proxyScriptForToml`"]",
            "startup_timeout_sec = $grokMcpStartupTimeout",
            "tool_timeout_sec = $grokMcpToolTimeout",
            "tool_timeouts = { moe_wait_for_task = 720, moe_chat_wait = 720, moe_wait_for_resource = 720 }",
            "",
            "[mcp_servers.moe.env]",
            "MOE_PROJECT_PATH = `"$projectPathForToml`"",
            $grokWorkerIdLine,
            ($grokToolNameStyleLine + $grokDaemonHostLine)
        ) -join "`n")

        # Serena block (LSP code intelligence + memory, pinned to this project):
        # present only while Serena is installed, stripped otherwise.
        $grokSerenaTomlBlock = ""
        if ($serenaPath -and (Test-Path $serenaPath)) {
            $serenaPathForToml = $serenaPath.ToString().Replace('\', '/')
            $serenaProjectForToml = $serenaProject.Replace('\', '/')
            $grokSerenaTomlBlock = (@(
                "",
                "[mcp_servers.serena]",
                "command = `"$serenaPathForToml`"",
                "args = [`"start-mcp-server`", `"--context`", `"agent`", `"--project`", `"$serenaProjectForToml`", `"--enable-web-dashboard`", `"false`", `"--enable-gui-log-window`", `"false`"]"
            ) -join "`n")
        }

        # Idempotent merge, same rules as the codex writer: drop the sections
        # this writer owns and re-emits ([mcp_servers.moe], [mcp_servers.moe.env],
        # [mcp_servers.serena]; orphaned [mcp_servers.serena.*] subtables too
        # when Serena is not installed), keep every other user section
        # verbatim, then append fresh blocks. A missing file starts from the
        # header only. Both routes produce the same bytes, so a re-run leaves
        # the file byte-identical.
        $grokHeader = "# Grok project config (auto-generated by moe-agent)"
        $grokCleanedText = $grokHeader
        if (Test-Path $grokConfigFile) {
            $rawContent = Get-Content -Path $grokConfigFile -Raw
            $serenaInstalled = -not [string]::IsNullOrEmpty($grokSerenaTomlBlock)
            $lines = @("$rawContent" -split '\r?\n')
            $cleaned = @()
            $skip = $false
            foreach ($line in $lines) {
                $stripped = $line.Trim()
                if ($stripped.StartsWith('[')) {
                    $skip = ($stripped -match '^\[mcp_servers\.moe(\]|\.env\])') -or
                            ($stripped -match '^\[mcp_servers\.serena\]') -or
                            ((-not $serenaInstalled) -and $stripped -match '^\[mcp_servers\.serena\.')
                }
                if (-not $skip) {
                    $cleaned += $line
                }
            }
            $grokCleanedText = ($cleaned -join "`n").TrimEnd()
            if ([string]::IsNullOrWhiteSpace($grokCleanedText)) {
                $grokCleanedText = $grokHeader
            }
        }
        $grokConfigText = $grokCleanedText + "`n" + $grokMoeTomlBlock + $grokSerenaTomlBlock + "`n"
        # No BOM: a TOML reader may choke on one, and the merge above must see
        # exactly the bytes it wrote.
        [System.IO.File]::WriteAllText($grokConfigFile, $grokConfigText, [System.Text.UTF8Encoding]::new($false))
        Write-Host "Grok MCP config written to: $grokConfigFile"
        Grant-GrokFolderTrust -ProjectPath $projectPath
    } catch {
        Write-Error "Failed to write Grok MCP config: $_"
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

# ---- Routed-@mention provenance -------------------------------------------
# A routed @mention body is text written by someone else that gets injected
# into a teammate's session context, so the delivery path is an injection
# surface. Confirmed 11+ times across distinct message ids and distinct
# receiving sessions: the body delivered inside <routed_mentions> had been
# replaced with unrelated, instruction-shaped content (a block impersonating a
# "SessionStart:startup hook success" notice), while the at-rest record in
# .moe/messages/<channel>.jsonl stayed correct every time.
#
# So the RPC response is NOT authoritative for the body -- the jsonl is. Every
# delivered body is re-read from the store BY MESSAGE ID and delivered from
# there. When the store cannot answer, the recipient gets the id, the channel
# and a stable marker instead of substitute content, and the mention is never
# silently dropped: a mention that vanishes is the same harm class as one that
# is replaced.
#
# Reason codes below are spelled IDENTICALLY in moe-agent.sh so an operator
# grepping either transcript finds the same string.
$script:MoeMentionFailedMarker = 'MOE_MENTION_DELIVERY_FAILED'
# Per-channel record cache. RESET at the top of every pre-flight, never left to
# live across wrapper iterations: a cached channel would serve iteration 1's
# bytes for a message appended during iteration 2, which is a staleness bug
# wearing this fix's clothes.
$script:MoeMentionStoreCache = @{}

function Get-MoeStoredMentionRecord {
    param([string]$ProjectPath, [string]$Channel, [string]$MessageId)
    if (-not $MessageId) { return @{ ok = $false; reason = 'MOE_MENTION_ID_MISSING' } }
    # The channel id reaches a path join. It is whitelisted rather than
    # sanitised, because sanitising invites an escape: a crafted id like
    # "../../../etc/passwd" or an absolute path must be refused outright, not
    # rewritten. Real ids are "chan-<hex>".
    if (-not $Channel -or ($Channel -notmatch '^[A-Za-z0-9_-]+$')) {
        return @{ ok = $false; reason = 'MOE_MENTION_CHANNEL_UNSAFE' }
    }
    if (-not $script:MoeMentionStoreCache.ContainsKey($Channel)) {
        $script:MoeMentionStoreCache[$Channel] = $null
        $storePath = Join-Path (Join-Path (Join-Path $ProjectPath '.moe') 'messages') "$Channel.jsonl"
        # Test-Path then read is a TOCTOU window; the try/catch is what actually
        # decides, so a file deleted in between still lands on the same code.
        if (Test-Path -LiteralPath $storePath) {
            try {
                $records = @{}
                foreach ($line in [System.IO.File]::ReadAllLines($storePath, [System.Text.UTF8Encoding]::new($false))) {
                    if (-not $line) { continue }
                    # A partial trailing line from a concurrent append simply
                    # fails to parse and is skipped -- the mention then fails
                    # CLOSED to a marker rather than being served half a body.
                    try { $rec = $line | ConvertFrom-Json -ErrorAction Stop } catch { continue }
                    if ($rec -and $rec.id -is [string]) { $records[$rec.id] = $rec }
                }
                $script:MoeMentionStoreCache[$Channel] = $records
            } catch {
                $script:MoeMentionStoreCache[$Channel] = $null
            }
        }
    }
    $store = $script:MoeMentionStoreCache[$Channel]
    if ($null -eq $store) { return @{ ok = $false; reason = 'MOE_MENTION_STORE_UNREADABLE' } }
    if (-not $store.ContainsKey($MessageId)) { return @{ ok = $false; reason = 'MOE_MENTION_ID_NOT_IN_STORE' } }
    $rec = $store[$MessageId]
    if ($rec.content -isnot [string]) {
        return @{ ok = $false; reason = 'MOE_MENTION_CONTENT_MISSING' }
    }
    return @{ ok = $true; content = $rec.content; sender = $rec.sender; channel = $rec.channel }
}

function New-MoeVerifiedMention {
    param([string]$ProjectPath, $Message)
    $stored = Get-MoeStoredMentionRecord -ProjectPath $ProjectPath -Channel $Message.channel -MessageId $Message.id
    # Identity comes from the store too, not just the body. An RPC response that
    # lied about `sender` could otherwise put words in a named teammate's mouth
    # while every byte of the body verified clean.
    $senderOut = if ($stored.ok -and $stored.sender -is [string]) { $stored.sender } else { $Message.sender }
    $channelOut = if ($stored.ok -and $stored.channel -is [string]) { $stored.channel } else { $Message.channel }
    if ($stored.ok) {
        $body = $stored.content
        $rpcBody = if ($Message.content -is [string]) { $Message.content } else { '' }
        if ($body -eq $rpcBody) {
            $prov = 'VERIFIED'
        } elseif ($rpcBody.Length -gt 0 -and $body.StartsWith($rpcBody, [System.StringComparison]::Ordinal)) {
            # chat_read truncates at maxContentChars (default 1000). That is a
            # legitimate transform, but delivering silently-truncated bytes as
            # "the message" is the same defect wearing a different hat, so the
            # DECISION is: deliver the FULL stored body and label the RPC's copy
            # as truncated. The store is being read anyway.
            $prov = 'VERIFIED_RPC_TRUNCATED'
        } else {
            $prov = 'MOE_MENTION_CONTENT_DIVERGED'
        }
    } else {
        $body = "$script:MoeMentionFailedMarker reason=$($stored.reason) id=$($Message.id) channel=$($Message.channel)"
        $prov = $stored.reason
    }
    return [ordered]@{
        id         = $Message.id
        channel    = $channelOut
        sender     = $senderOut
        content    = $body
        provenance = $prov
    }
}

function New-MoeMentionFailure {
    param([string]$Reason)
    return [ordered]@{
        id         = 'unknown'
        channel    = 'unknown'
        sender     = 'moe-agent'
        content    = "$script:MoeMentionFailedMarker reason=$Reason id=unknown channel=unknown"
        provenance = $Reason
    }
}

function ConvertTo-MoeFencedJson {
    param([string]$Json)
    # JSON's structural syntax uses no '<', no '>' and no non-ASCII, so those
    # can only have come from a string VALUE. Escaping them as \uXXXX is
    # lossless -- a JSON reader decodes them back to the same characters -- but
    # it removes two hazards from the RAW prompt text a model reads: a body
    # containing "</routed_mentions>" can no longer close the fence and land
    # instruction text OUTSIDE the block (measured: it did), and a non-ASCII
    # body can no longer be mangled by a console code page on the way out.
    $sb = [System.Text.StringBuilder]::new($Json.Length)
    foreach ($ch in $Json.ToCharArray()) {
        $code = [int]$ch
        if ($ch -eq '<' -or $ch -eq '>' -or $code -gt 126) {
            [void]$sb.AppendFormat('\u{0:x4}', $code)
        } else {
            [void]$sb.Append($ch)
        }
    }
    return $sb.ToString()
}

# The CLI invocation below blocks this process for the CLI's entire runtime
# with no interleaved activity of our own. moe-proxy opens a fresh connection
# per RPC call rather than holding one for the CLI's lifetime (see
# WebSocketServer.cleanupMcpWorkers's comment on why TCP-close can't mean
# "agent died"), so the daemon's ONLY liveness signal is "did this worker call
# a moe.* tool recently." A long silent local step (a build, a full test run)
# can go quiet longer than the 30-min REVIEW self-heal window even while the
# CLI is very much still running and about to call qa_approve/qa_reject — the
# self-heal then yanks the task out from under a live session. This sidecar
# pings moe.heartbeat on a timer from a SEPARATE process (Start-Job) so a
# genuinely-alive-but-quiet session keeps its task. Bounded by MaxDurationSec
# so a truly-hung CLI still eventually goes stale — this extends the
# self-heal's patience window, it does not defeat it.
function Start-HeartbeatSidecar {
    param(
        [Parameter(Mandatory = $true)][string]$ProxyScript,
        [Parameter(Mandatory = $true)][string]$ProjectPath,
        [Parameter(Mandatory = $true)][string]$WorkerId
    )
    if ($env:MOE_DISABLE_HEARTBEAT -eq '1') { return $null }
    $intervalSec = 60
    if ($env:MOE_HEARTBEAT_INTERVAL_SEC -match '^\d+$') { $intervalSec = [int]$env:MOE_HEARTBEAT_INTERVAL_SEC }
    $maxDurationSec = 7200
    if ($env:MOE_HEARTBEAT_MAX_DURATION_SEC -match '^\d+$') { $maxDurationSec = [int]$env:MOE_HEARTBEAT_MAX_DURATION_SEC }

    try {
        $script:CurrentHeartbeatJob = Start-Job -Name "moe-heartbeat-$WorkerId" -ScriptBlock {
            param($ProxyScript, $ProjectPath, $WorkerId, $IntervalSec, $MaxDurationSec)
            $env:MOE_PROJECT_PATH = $ProjectPath
            $rpc = (@{
                jsonrpc = "2.0"
                id      = 1
                method  = "tools/call"
                params  = @{ name = "moe.heartbeat"; arguments = @{ workerId = $WorkerId } }
            } | ConvertTo-Json -Compress)
            $deadline = (Get-Date).AddSeconds($MaxDurationSec)
            while ((Get-Date) -lt $deadline) {
                Start-Sleep -Seconds $IntervalSec
                try { $rpc | & node $ProxyScript 2>&1 | Out-Null } catch {}
            }
        } -ArgumentList $ProxyScript, $ProjectPath, $WorkerId, $intervalSec, $maxDurationSec
        return $script:CurrentHeartbeatJob
    } catch {
        Write-Host "[WARN] Failed to start heartbeat sidecar: $_ — a long silent verification step risks REVIEW self-heal eviction." -ForegroundColor Yellow
        return $null
    }
}

# Stops whatever heartbeat job is currently tracked in $script:CurrentHeartbeatJob
# (set by Start-HeartbeatSidecar). No param: this is also called from
# Invoke-MoeDeregister's async Ctrl+C/exit handler, which has no local
# reference to the job — only the script-scoped one.
function Stop-HeartbeatSidecar {
    if (-not $script:CurrentHeartbeatJob) { return }
    try { Stop-Job -Job $script:CurrentHeartbeatJob -ErrorAction SilentlyContinue | Out-Null } catch {}
    try { Remove-Job -Job $script:CurrentHeartbeatJob -Force -ErrorAction SilentlyContinue | Out-Null } catch {}
    $script:CurrentHeartbeatJob = $null
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
        # Landing summary appended so the session-ended line doubles as the
        # commit evidence: commit=<sha|none> kind=<k> paths=<n> inferred=<m>
        # unattributed=<u> (identical shape in moe-agent.sh).
        $landingSummary = "commit=none kind=none paths=0 inferred=0 unattributed=0"
        $ll = $script:MoeLastLanding
        if ($ll) {
            $llSha = if ($ll.Sha) { $ll.Sha } else { 'none' }
            $landingSummary = "commit=$llSha kind=$($ll.Kind) paths=$($ll.PathCount) inferred=$($ll.InferredCount) unattributed=$($ll.UnattributedCount)"
            if ($ll.Outcome -ne 'committed' -and $ll.Code) { $landingSummary += " outcome=$($ll.Outcome) code=$($ll.Code)" }
        }
        $content = "$Role session ended: task=$preflightTaskId (CLI exit=$exitCode) $landingSummary"
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

# ============================================================================
# Land-on-every-exit: baseline / attribution / temp-index landing helpers.
#
# Every helper RETURNS a value and never `break`s or `continue`s: PowerShell
# leaks those to the nearest loop in the CALLER (the wrapper's do/while), so a
# helper that `continue`d would silently skip the rest of the iteration. The
# loop body decides on `$result.StopLoop`. Every native git call runs inside an
# $ErrorActionPreference='Continue' region with $LASTEXITCODE read immediately
# (Windows PowerShell 5.1 turns native stderr into a terminating error under
# 'Stop', even with 2>$null). $env:GIT_INDEX_FILE is set only around one
# plumbing call at a time and removed in a finally — a leak would make every
# later git call (including the CLI's own) use the temp index.
#
# Reason codes, banners, settings keys and env names below are spelled
# IDENTICALLY in moe-agent.sh (scripts/tests/parity-check.ps1 greps both).
# ============================================================================
$script:MoeCaseFoldPaths = $true
if ($PSVersionTable.PSVersion.Major -ge 6) {
    $script:MoeCaseFoldPaths = [bool]($IsWindows -or $IsMacOS)
}
$script:MoeLastLanding = $null
$script:MoeTeardownDone = $false
$script:MoeToolWritten = @{}

function Get-MoePathKey([string]$Path) {
    if ($script:MoeCaseFoldPaths) { return $Path.ToLowerInvariant() }
    return $Path
}

function Get-MoeProp($Obj, [string]$Name) {
    if ($null -eq $Obj) { return $null }
    if ($Obj -is [System.Collections.IDictionary]) {
        if ($Obj.Contains($Name)) { return $Obj[$Name] }
        return $null
    }
    $p = $Obj.PSObject.Properties[$Name]
    if ($p) { return $p.Value }
    return $null
}

# Emits the strings one by one (normal pipeline unrolling); callers wrap the
# call in @(...) to collect. A `,$out` return + @(call) would NEST the array.
function Get-MoeStringList($Value) {
    if ($null -eq $Value) { return }
    if ($Value -is [string]) { if ($Value) { Write-Output $Value }; return }
    foreach ($v in @($Value)) { if ($v -is [string] -and $v) { Write-Output $v } }
}

# Mirrors daemon util/affectedFiles.ts normalizeAffectedFile: backslashes ->
# '/', leading './' stripped, '.'/empty segments dropped; absolute or
# traversing paths yield '' (never staged).
function ConvertTo-MoeNormalPath([string]$Raw) {
    if ($null -eq $Raw) { return '' }
    $t = $Raw.Trim()
    if (-not $t) { return '' }
    $p = $t -replace '\\', '/'
    if ($p.StartsWith('./')) { $p = $p.Substring(2) }
    if ($p.StartsWith('/') -or ($p -match '^[A-Za-z]:/')) { return '' }
    $segs = @($p -split '/' | Where-Object { $_ -ne '' -and $_ -ne '.' })
    foreach ($s in $segs) { if ($s -eq '..') { return '' } }
    return ($segs -join '/')
}

# ROOT-relative declared path -> TOP-relative (REL is `git rev-parse --show-prefix`).
function ConvertTo-MoeTopPath([string]$RootRelative, [string]$Rel) {
    $n = ConvertTo-MoeNormalPath $RootRelative
    if (-not $n) { return '' }
    return "$Rel$n"
}

function ConvertTo-MoeTopPathFromAbsolute([string]$Absolute, [string]$Top) {
    if (-not $Absolute -or -not $Top) { return '' }
    $a = ($Absolute -replace '\\', '/')
    $t = ($Top -replace '\\', '/').TrimEnd('/')
    if ($a.Length -le ($t.Length + 1)) { return '' }
    if ((Get-MoePathKey $a).StartsWith((Get-MoePathKey ($t + '/')))) {
        return (ConvertTo-MoeNormalPath $a.Substring($t.Length + 1))
    }
    return ''
}

function Test-MoeAbsolutePath([string]$P) {
    return ($P -match '^[A-Za-z]:[\\/]' -or $P.StartsWith('/') -or $P.StartsWith('\\'))
}

# TOP-relative path -> ROOT-relative for the daemon ledger (REL stripped) —
# the exact root_rel logic of the sh twin's record_commit_rpc. Declarations
# round-trip through get_commit_scope as ROOT-relative, so every path list a
# record_commit carries must be ROOT-relative too or a nested project
# (ROOT != TOP) re-prefixes REL onto an already-REL-prefixed path.
function ConvertTo-MoeRootRelative([string]$TopPath, [string]$Rel) {
    if (-not $Rel) { return $TopPath }
    if ((Get-MoePathKey $TopPath).StartsWith((Get-MoePathKey $Rel))) { return $TopPath.Substring($Rel.Length) }
    return $TopPath
}

# One project.json read. Explicit-false semantics for the booleans that
# default on (as autoCommit always had); commitHooks defaults OFF and needs an
# explicit true. Env overrides last.
function Read-MoeCommitSettings {
    $s = @{
        autoCommit = $true; checkpointCommits = $true; checkpointPush = $true
        commitBoardState = $true; commitHooks = $false
        undeclared = 'solo'; contested = 'commit'; exclude = @()
        qualityGate = ''; qualityGateScope = 'epicFinal'; consolidationBranch = ''
    }
    $projJsonPath = Join-Path $moeDir "project.json"
    if (Test-Path -LiteralPath $projJsonPath) {
        try {
            $cfg = Get-Content -Raw -LiteralPath $projJsonPath | ConvertFrom-Json
            $st = Get-MoeProp $cfg 'settings'
            if ($st) {
                foreach ($k in @('autoCommit', 'checkpointCommits', 'checkpointPush', 'commitBoardState')) {
                    $v = Get-MoeProp $st $k
                    if ($null -ne $v -and $v -eq $false) { $s[$k] = $false }
                }
                $ch = Get-MoeProp $st 'commitHooks'
                if ($null -ne $ch -and $ch -eq $true) { $s.commitHooks = $true }
                $attr = Get-MoeProp $st 'attribution'
                if ($attr) {
                    $u = Get-MoeProp $attr 'undeclared'
                    if ($u -is [string] -and (@('solo', 'never', 'always') -contains $u)) { $s.undeclared = $u }
                    $c = Get-MoeProp $attr 'contested'
                    if ($c -is [string] -and (@('commit', 'skip') -contains $c)) { $s.contested = $c }
                    $s.exclude = @(Get-MoeStringList (Get-MoeProp $attr 'exclude'))
                }
                $qg = Get-MoeProp $st 'qualityGate'
                if ($qg -is [string]) { $s.qualityGate = $qg.Trim() }
                if ((Get-MoeProp $st 'qualityGateScope') -eq 'everyTask') { $s.qualityGateScope = 'everyTask' }
                $cb = Get-MoeProp $st 'consolidationBranch'
                # A literal branch name doubles as the peel target; a pattern
                # (contains '*') is a policy glob, never a checkout target.
                if ($cb -is [string] -and $cb.Trim() -and $cb.IndexOf('*') -lt 0) { $s.consolidationBranch = $cb.Trim() }
            }
        } catch {
            # Malformed project.json — defaults stand.
        }
    }
    if ($env:MOE_ATTRIBUTION -eq 'declared') { $s.undeclared = 'never' }
    if ($env:MOE_DISABLE_QUALITY_GATE -eq '1') { $s.qualityGate = '' }
    if ($env:MOE_DISABLE_CHECKPOINT -eq '1') { $s.checkpointCommits = $false }
    return $s
}

# Probe the repo INSIDE an EAP='Continue' region (the old bare probe died on
# PS 5.1 in a non-git tree). Returns @{Top; GitDir; Rel} or $null.
function Get-MoeGitTop {
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $top = & git -C $projectPath rev-parse --show-toplevel 2>$null
        $rc = $LASTEXITCODE
        if ($rc -ne 0 -or -not $top) { return $null }
        $top = "$top".Trim()
        $gitDir = & git -C $projectPath rev-parse --absolute-git-dir 2>$null
        $rc = $LASTEXITCODE
        if ($rc -ne 0 -or -not $gitDir) { return $null }
        $rel = & git -C $projectPath rev-parse --show-prefix 2>$null
        $rc = $LASTEXITCODE
        if ($rc -ne 0) { $rel = '' }
        $rel = if ($rel) { "$rel".Trim() } else { '' }
        return @{ Top = $top; GitDir = "$gitDir".Trim(); Rel = $rel }
    } catch {
        return $null
    } finally {
        $ErrorActionPreference = $prev
    }
}

# Every git call in the landing path goes through here: -C TOP, optional
# temp index (set for THIS call only), output + rc captured separately.
function Invoke-MoeGit {
    param(
        [Parameter(Mandatory = $true)][string]$Top,
        [Parameter(Mandatory = $true)][string[]]$GitArgs,
        [string]$IndexFile = '',
        [switch]$MergeStderr
    )
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $prevIdx = $env:GIT_INDEX_FILE
    if ($IndexFile) { $env:GIT_INDEX_FILE = $IndexFile }
    $out = @()
    $rc = 255
    try {
        if ($MergeStderr) {
            $raw = & git -C $Top @GitArgs 2>&1
        } else {
            $raw = & git -C $Top @GitArgs 2>$null
        }
        $rc = $LASTEXITCODE
        $out = @($raw | ForEach-Object { "$_" })
    } catch {
        $out = @("$_")
        $rc = 255
    } finally {
        if ($IndexFile) {
            if ($null -ne $prevIdx) { $env:GIT_INDEX_FILE = $prevIdx } else { Remove-Item Env:\GIT_INDEX_FILE -ErrorAction SilentlyContinue }
        }
        $ErrorActionPreference = $prev
    }
    return @{ Out = $out; Rc = $rc }
}

# git status --porcelain=v1 -z (NUL-split, no quoting, no renames) + ONE
# hash-object --stdin-paths. Returns hashtable pathKey -> @{Path; XY; Blob}
# where Blob is 'D' for a path absent from disk. $null when git fails.
function Get-MoeDirtySnapshot([string]$Top) {
    $snap = @{}
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $prevConsole = $null
    try { $prevConsole = [Console]::OutputEncoding } catch {}
    $prevOutEnc = $OutputEncoding
    $utf8 = New-Object System.Text.UTF8Encoding($false)
    try {
        # Git emits paths as UTF-8; 5.1 decodes native stdout with the OEM
        # code page and encodes native stdin as ASCII unless told otherwise.
        try { [Console]::OutputEncoding = $utf8 } catch {}
        $OutputEncoding = $utf8
        $raw = & git -C $Top status --porcelain=v1 -z --untracked-files=all --no-renames 2>$null
        $rc = $LASTEXITCODE
        if ($rc -ne 0) { return $null }
        $joined = (@($raw | ForEach-Object { "$_" }) -join "`n")
        $entries = $joined.Split([char]0)
        $toHash = New-Object System.Collections.Generic.List[string]
        $records = @()
        foreach ($e in $entries) {
            if ($e.Length -lt 4) { continue }
            $xy = $e.Substring(0, 2)
            $p = $e.Substring(3)
            if (-not $p -or $p.EndsWith('/')) { continue }
            if ($p.IndexOf("`t") -ge 0 -or $p.IndexOf("`n") -ge 0) {
                Write-Host "[attribution] skipping a path with control characters: $p" -ForegroundColor Yellow
                continue
            }
            $full = Join-Path $Top $p
            $blob = 'D'
            if (Test-Path -LiteralPath $full -PathType Leaf) {
                $blob = ''
                $toHash.Add($p)
            } elseif (Test-Path -LiteralPath $full) {
                # Directory / submodule entry: never attributable to a task.
                continue
            }
            $records += @{ Path = $p; XY = $xy; Blob = $blob }
        }
        $hashMap = @{}
        if ($toHash.Count -gt 0) {
            $hashes = @($toHash.ToArray() | & git -C $Top hash-object --stdin-paths 2>$null | ForEach-Object { "$_".Trim() })
            $hrc = $LASTEXITCODE
            if ($hrc -eq 0 -and $hashes.Count -eq $toHash.Count) {
                for ($i = 0; $i -lt $hashes.Count; $i++) { $hashMap[(Get-MoePathKey $toHash[$i])] = $hashes[$i] }
            } else {
                # Batch failed (one unreadable file poisons it): hash one by one.
                foreach ($p in $toHash) {
                    $h = & git -C $Top hash-object -- $p 2>$null
                    if ($LASTEXITCODE -eq 0 -and $h) { $hashMap[(Get-MoePathKey $p)] = "$h".Trim() }
                }
            }
        }
        foreach ($r in $records) {
            $k = Get-MoePathKey $r.Path
            if ($r.Blob -ne 'D') {
                if (-not $hashMap.ContainsKey($k)) { continue }   # unreadable: not attributable this exit
                $r.Blob = $hashMap[$k]
            }
            $snap[$k] = $r
        }
        return $snap
    } catch {
        return $null
    } finally {
        try { if ($prevConsole) { [Console]::OutputEncoding = $prevConsole } } catch {}
        $OutputEncoding = $prevOutEnc
        $ErrorActionPreference = $prev
    }
}

function Get-MoeBaselinePath([string]$GitDir, [string]$TaskId) {
    # The id reaches a path join: whitelist, never sanitise.
    if (-not $TaskId -or ($TaskId -notmatch '^[A-Za-z0-9_.-]+$')) { return '' }
    return (Join-Path $GitDir "moe/baseline/$TaskId.tsv")
}

# TSV: header `#moe-baseline v1 task=<id> at=<iso> head=<sha> landed=<0|1>`,
# then `B<TAB><blob|D><TAB><path>` rows (dirty-before-the-task) and
# `U<TAB><blob><TAB><path>` rows (locally persisted unattributed set).
# `landed=1` marks a session that completed a landing (committed/nothing/
# refused), so the next pre-flight does not replay a "recovered" checkpoint;
# an absent field (older twin) means recover.
function Read-MoeBaseline([string]$Path) {
    if (-not $Path -or -not (Test-Path -LiteralPath $Path)) { return $null }
    $b = @{}
    $u = @{}
    $head = ''
    $at = ''
    $landed = $false
    try {
        $utf8 = New-Object System.Text.UTF8Encoding($false)
        foreach ($line in [System.IO.File]::ReadAllLines($Path, $utf8)) {
            if (-not $line) { continue }
            if ($line.StartsWith('#')) {
                if ($line -match 'head=([0-9a-fA-F]+)') { $head = $matches[1] }
                if ($line -match 'at=(\S+)') { $at = $matches[1] }
                if ($line -match ' landed=1') { $landed = $true }
                continue
            }
            $parts = $line.Split("`t")
            if ($parts.Count -lt 3) { continue }
            $kind = $parts[0]
            $blob = $parts[1]
            $p = ($parts[2..($parts.Count - 1)] -join "`t")
            if (-not $p) { continue }
            $k = Get-MoePathKey $p
            if ($kind -eq 'B') { $b[$k] = @{ Path = $p; Blob = $blob } }
            elseif ($kind -eq 'U') { $u[$k] = @{ Path = $p; Blob = $blob } }
        }
    } catch {
        return $null
    }
    return @{ Head = $head; At = $at; B = $b; U = $u; Landed = $landed }
}

function Write-MoeBaseline([string]$Path, [string]$TaskId, [string]$Head, [hashtable]$B, [hashtable]$U, [int]$Landed = 0) {
    if (-not $Path) { return $false }
    try {
        $dir = Split-Path -Parent $Path
        if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
        $at = (Get-Date).ToUniversalTime().ToString("yyyy-MM-dd'T'HH:mm:ss'Z'")
        $sb = New-Object System.Text.StringBuilder
        [void]$sb.Append("#moe-baseline v1 task=$TaskId at=$at head=$Head landed=$Landed`n")
        if ($B) { foreach ($k in ($B.Keys | Sort-Object)) { $r = $B[$k]; [void]$sb.Append("B`t$($r.Blob)`t$($r.Path)`n") } }
        if ($U) { foreach ($k in ($U.Keys | Sort-Object)) { $r = $U[$k]; [void]$sb.Append("U`t$($r.Blob)`t$($r.Path)`n") } }
        $tmp = "$Path.tmp"
        [System.IO.File]::WriteAllText($tmp, $sb.ToString(), (New-Object System.Text.UTF8Encoding($false)))
        Move-Item -LiteralPath $tmp -Destination $Path -Force
        return $true
    } catch {
        Write-Host "[WARN] could not write the baseline file ${Path}: $_" -ForegroundColor Yellow
        return $false
    }
}

function Remove-MoeBaseline([string]$Path) {
    if ($Path -and (Test-Path -LiteralPath $Path)) {
        try { Remove-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue } catch {}
    }
}

# Flip an existing baseline's header to landed=1 in place. Called on the
# DELIBERATE mode='none' post-flight exit (checkpointCommits=false or a role
# with no landing) so the next pre-flight does not replay this session's edits
# as a "recovered" checkpoint the operator turned off. Twin: baseline_mark_landed.
function Set-MoeBaselineLanded([string]$GitDir, [string]$TaskId) {
    $p = Get-MoeBaselinePath $GitDir $TaskId
    if (-not $p -or -not (Test-Path -LiteralPath $p)) { return }
    $bl = Read-MoeBaseline $p
    if ($null -eq $bl) { return }
    Write-MoeBaseline $p $TaskId $bl.Head $bl.B $bl.U 1 | Out-Null
}

# ASSERTED / PLANNED tiers of ONE task record, exactly as the daemon's
# get_commit_scope derives them (completeTask.ts semantics for asserted).
function Get-MoeTaskDeclaredSets($Task) {
    $asserted = @()
    $planned = @()
    $steps = @()
    $plan = Get-MoeProp $Task 'implementationPlan'
    if ($plan) { $steps = @($plan) }
    foreach ($s in $steps) {
        if ($null -eq $s) { continue }
        $mod = Get-MoeProp $s 'modifiedFiles'
        $aff = Get-MoeProp $s 'affectedFiles'
        $new = Get-MoeProp $s 'newFiles'
        if ((Get-MoeProp $s 'status') -eq 'COMPLETED') {
            if ($null -ne $mod) { $asserted += @(Get-MoeStringList $mod) } else { $asserted += @(Get-MoeStringList $aff) }
        }
        $planned += @(Get-MoeStringList $aff)
        $planned += @(Get-MoeStringList $new)
        $planned += @(Get-MoeStringList $mod)
    }
    $asserted += @(Get-MoeStringList (Get-MoeProp $Task 'filesModified'))
    $asserted += @(Get-MoeStringList (Get-MoeProp $Task 'declaredFiles'))
    $asserted += @(Get-MoeStringList (Get-MoeProp $Task 'touchedFiles'))
    $commits = Get-MoeProp $Task 'commits'
    if ($commits) {
        foreach ($c in @($commits)) {
            if ($null -eq $c) { continue }
            $inf = @(Get-MoeStringList (Get-MoeProp $c 'inferredPaths') | ForEach-Object { Get-MoePathKey (ConvertTo-MoeNormalPath $_) })
            foreach ($p in @(Get-MoeStringList (Get-MoeProp $c 'paths'))) {
                if ($inf -contains (Get-MoePathKey (ConvertTo-MoeNormalPath $p))) { continue }
                $asserted += $p
            }
        }
    }
    $planned += @(Get-MoeStringList (Get-MoeProp $Task 'inferredPaths'))
    return @{ Asserted = @($asserted); Planned = @($planned) }
}

# Disk fallback when moe.get_commit_scope is unavailable (old daemon, daemon
# down): own record + every other .moe/tasks/*.json. Policy is forced to
# undeclared=never and peersActive=true — without the daemon we cannot know
# who else is live, so only declared paths may land.
function Get-MoeDiskScope([string]$TaskId) {
    $scope = @{
        Source = 'disk'; Found = $false; TaskId = $TaskId; Title = ''; Status = ''; ReopenCount = 0
        AssignedWorkerId = ''; Asserted = @(); Planned = @(); TouchedFiles = @(); InferredPaths = @(); UnattributedPaths = @()
        PeerDeclared = @{}; LivePeerIds = @(); LivePeerIdsKnown = $false; PeersActive = $true; ForceNever = $true
    }
    $tasksDir = Join-Path $moeDir 'tasks'
    $ownPath = Join-Path $tasksDir "$TaskId.json"
    if (-not (Test-Path -LiteralPath $ownPath)) { $ownPath = Join-Path $tasksDir "task-$TaskId.json" }
    $own = $null
    if (Test-Path -LiteralPath $ownPath) {
        try { $own = Get-Content -Raw -LiteralPath $ownPath | ConvertFrom-Json } catch { $own = $null }
    }
    if ($own) {
        $scope.Found = $true
        $t = Get-MoeProp $own 'title'; if ($t -is [string]) { $scope.Title = $t }
        $st = Get-MoeProp $own 'status'; if ($st -is [string]) { $scope.Status = $st }
        $rc = Get-MoeProp $own 'reopenCount'; if ($rc) { try { $scope.ReopenCount = [int]$rc } catch {} }
        $aw = Get-MoeProp $own 'assignedWorkerId'; if ($aw -is [string]) { $scope.AssignedWorkerId = $aw }
        $sets = Get-MoeTaskDeclaredSets $own
        $scope.Asserted = @($sets.Asserted)
        $scope.Planned = @($sets.Planned)
        $scope.TouchedFiles = @(Get-MoeStringList (Get-MoeProp $own 'touchedFiles'))
        $scope.InferredPaths = @(Get-MoeStringList (Get-MoeProp $own 'inferredPaths'))
        $scope.UnattributedPaths = @(Get-MoeStringList (Get-MoeProp $own 'unattributedPaths'))
    }
    if (Test-Path -LiteralPath $tasksDir) {
        foreach ($f in @(Get-ChildItem -LiteralPath $tasksDir -File -Filter '*.json' -ErrorAction SilentlyContinue)) {
            if ($own -and $f.FullName -eq (Get-Item -LiteralPath $ownPath).FullName) { continue }
            $peer = $null
            try { $peer = Get-Content -Raw -LiteralPath $f.FullName | ConvertFrom-Json } catch { continue }
            if (-not $peer) { continue }
            $pid2 = Get-MoeProp $peer 'id'
            if ($pid2 -isnot [string] -or -not $pid2 -or $pid2 -eq $TaskId) { continue }
            $pst = Get-MoeProp $peer 'status'
            if ($pst -eq 'DONE' -or $pst -eq 'ARCHIVED') { continue }
            $psets = Get-MoeTaskDeclaredSets $peer
            foreach ($p in @($psets.Asserted) + @($psets.Planned) + @(Get-MoeStringList (Get-MoeProp $peer 'touchedFiles'))) {
                $n = ConvertTo-MoeNormalPath $p
                if (-not $n) { continue }
                $k = Get-MoePathKey $n
                if (-not $scope.PeerDeclared.ContainsKey($k)) { $scope.PeerDeclared[$k] = @{ Path = $n; TaskId = $pid2 } }
            }
        }
    }
    return $scope
}

# moe.get_commit_scope RPC, disk fallback on any failure. Paths in the
# returned sets are ROOT-relative (as declared); callers convert with REL.
function Get-MoeCommitScope([string]$TaskId, [string]$Phase, [string]$Sid) {
    $resp = $null
    try {
        $scopeArgs = @{ taskId = $TaskId; workerId = $WorkerId; sessionId = $Sid; phase = $Phase }
        # `since` widens the daemon's peer-liveness window to this session's
        # pre-flight instant (SID = <workerId>@<preflight-iso>); only a
        # parsable timestamp may travel or the daemon rejects the whole call.
        if ($Sid -match '@(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?)$') { $scopeArgs.since = $matches[1] }
        $resp = Invoke-MoeRpc -Tool 'get_commit_scope' -Args $scopeArgs
    } catch { $resp = $null }
    if ($resp -and ($resp -isnot [string]) -and $resp.PSObject.Properties['taskId'] -and $resp.PSObject.Properties['asserted']) {
        $scope = @{
            Source = 'rpc'; Found = $true; TaskId = [string]$resp.taskId; Title = ''; Status = ''; ReopenCount = 0
            AssignedWorkerId = ''; Asserted = @(); Planned = @(); TouchedFiles = @(); InferredPaths = @(); UnattributedPaths = @()
            PeerDeclared = @{}; LivePeerIds = @(); LivePeerIdsKnown = $true; PeersActive = $false; ForceNever = $false
        }
        $t = Get-MoeProp $resp 'title'; if ($t -is [string]) { $scope.Title = $t }
        $st = Get-MoeProp $resp 'status'; if ($st -is [string]) { $scope.Status = $st }
        $rc = Get-MoeProp $resp 'reopenCount'; if ($rc) { try { $scope.ReopenCount = [int]$rc } catch {} }
        $aw = Get-MoeProp $resp 'assignedWorkerId'; if ($aw -is [string]) { $scope.AssignedWorkerId = $aw }
        $scope.Asserted = @(Get-MoeStringList (Get-MoeProp $resp 'asserted'))
        $scope.Planned = @(Get-MoeStringList (Get-MoeProp $resp 'planned'))
        $scope.TouchedFiles = @(Get-MoeStringList (Get-MoeProp $resp 'touchedFiles'))
        $scope.InferredPaths = @(Get-MoeStringList (Get-MoeProp $resp 'inferredPaths'))
        $scope.UnattributedPaths = @(Get-MoeStringList (Get-MoeProp $resp 'unattributedPaths'))
        $scope.LivePeerIds = @(Get-MoeStringList (Get-MoeProp $resp 'livePeerIds'))
        $pa = Get-MoeProp $resp 'peersActive'
        $scope.PeersActive = [bool]($pa -eq $true)
        $pd = Get-MoeProp $resp 'peerDeclared'
        if ($pd) {
            foreach ($e in @($pd)) {
                if ($null -eq $e) { continue }
                $pp = Get-MoeProp $e 'path'
                $pt = Get-MoeProp $e 'taskId'
                if ($pp -isnot [string] -or -not $pp) { continue }
                $n = ConvertTo-MoeNormalPath $pp
                if (-not $n) { continue }
                $k = Get-MoePathKey $n
                if (-not $scope.PeerDeclared.ContainsKey($k)) { $scope.PeerDeclared[$k] = @{ Path = $n; TaskId = [string]$pt } }
            }
        }
        return $scope
    }
    $disk = Get-MoeDiskScope $TaskId
    Write-Host "[attribution] moe.get_commit_scope unavailable; using the on-disk task records (declared paths only, peers presumed active)." -ForegroundColor Yellow
    return $disk
}

function Test-MoeDenyPath([string]$TopPath, [string]$XY, [string]$Rel, [hashtable]$Settings) {
    $k = Get-MoePathKey $TopPath
    $r = Get-MoePathKey $Rel
    # When the Moe project is nested in a larger repo (ROOT != TOP) the OUTER
    # repo's .moe/tool-config paths are denied too (bare-root prefix) — another
    # fleet's board state must never be attributed to this task. Same roots
    # list as the sh twin's denied().
    $denyRoots = @($r)
    if ($r) { $denyRoots += '' }
    foreach ($dr in $denyRoots) {
        if ($k.StartsWith("$dr.moe/")) { return $true }
        if ($k -eq "$dr.mcp.json") { return $true }
        foreach ($pre in @('.codex/', '.gemini/', '.grok/', '.claude/agents/', '.worktrees/', '.moe-worktree')) {
            if ($k.StartsWith("$dr$pre")) { return $true }
        }
        if ($k -eq "$dr.claude/settings.local.json") { return $true }
        if ($XY -eq '??' -and $k.StartsWith("$dr.serena/")) { return $true }
    }
    if ($Settings -and $Settings.exclude) {
        foreach ($ex in @($Settings.exclude)) {
            $n = ConvertTo-MoeNormalPath $ex
            if (-not $n) { continue }
            if ($k.StartsWith((Get-MoePathKey "$Rel$n"))) { return $true }
        }
    }
    return $false
}

# Section 6 of the design, exactly. Inputs are TOP-relative snapshots; declared
# sets arrive ROOT-relative and are converted with REL here.
function Resolve-MoeAttribution {
    param(
        [Parameter(Mandatory = $true)][hashtable]$Git,
        [Parameter(Mandatory = $true)][hashtable]$S,
        [hashtable]$B,
        [hashtable]$U,
        [hashtable]$Tool,
        [Parameter(Mandatory = $true)][hashtable]$Scope,
        [Parameter(Mandatory = $true)][hashtable]$Settings,
        [Parameter(Mandatory = $true)][string]$TaskId,
        [string]$Mode = 'checkpoint',
        [string]$PolicyOverride = ''
    )
    $rel = $Git.Rel
    if ($null -eq $B) { $B = @{} }
    if ($null -eq $U) { $U = @{} }
    if ($null -eq $Tool) { $Tool = @{} }
    $undeclared = $Settings.undeclared
    if ($Scope.ForceNever) { $undeclared = 'never' }
    if ($PolicyOverride) { $undeclared = $PolicyOverride }
    $contestedPolicy = $Settings.contested

    $asserted = @{}
    foreach ($p in @($Scope.Asserted)) { $tp = ConvertTo-MoeTopPath $p $rel; if ($tp) { $asserted[(Get-MoePathKey $tp)] = $tp } }
    $planned = @{}
    foreach ($p in @($Scope.Planned)) { $tp = ConvertTo-MoeTopPath $p $rel; if ($tp) { $k = Get-MoePathKey $tp; if (-not $asserted.ContainsKey($k)) { $planned[$k] = $tp } } }
    $peer = @{}
    foreach ($k in $Scope.PeerDeclared.Keys) {
        $tp = "$rel$($Scope.PeerDeclared[$k].Path)"
        $peer[(Get-MoePathKey $tp)] = $Scope.PeerDeclared[$k].TaskId
    }
    $mine = @{}
    foreach ($k in $asserted.Keys) { $mine[$k] = $asserted[$k] }
    foreach ($k in $Tool.Keys) { $mine[$k] = $Tool[$k] }

    $ownRecordKey = Get-MoePathKey "$rel.moe/tasks/$TaskId.json"
    $tasksPrefix = Get-MoePathKey "$rel.moe/tasks/"
    $epicsPrefix = Get-MoePathKey "$rel.moe/epics/"
    $projectKey = Get-MoePathKey "$rel.moe/project.json"
    $memoryPrefix = Get-MoePathKey "$rel.serena/memories/"
    $taskIdKey = Get-MoePathKey $TaskId

    $candidates = @()
    $skipped = @()
    $unattributed = @()
    $contested = @()
    $foreign = 0
    $excluded = 0

    foreach ($k in ($S.Keys | Sort-Object)) {
        $entry = $S[$k]
        $p = $entry.Path
        $blob = $entry.Blob
        $changed = (-not $B.ContainsKey($k)) -or ($B[$k].Blob -ne $blob)

        # BOARD: own record ALWAYS while dirty (sh board_always; spec section 6
        # — the daemon rewrites it on every transition and it must land even
        # when a previous session's baseline already carried it); epics,
        # project.json and non-live-peer task records only when changed this
        # session.
        $isBoard = $false
        if ($Settings.commitBoardState) {
            if ($k -eq $ownRecordKey) {
                $isBoard = $true
            } elseif ($k -eq $projectKey -or ($k.StartsWith($epicsPrefix) -and $k.EndsWith('.json'))) {
                $isBoard = $changed
            } elseif ($k.StartsWith($tasksPrefix) -and $k.EndsWith('.json') -and $changed -and $Scope.LivePeerIdsKnown) {
                # Another task's record: only when its assignee is not a live
                # peer — and NEVER in disk-fallback mode (LivePeerIdsKnown is
                # false: liveness is unknowable, so no other task's record is a
                # board candidate; same rule as the sh twin's fallback scope).
                $assignee = ''
                try {
                    $recObj = Get-Content -Raw -LiteralPath (Join-Path $Git.Top $p) | ConvertFrom-Json
                    $a = Get-MoeProp $recObj 'assignedWorkerId'
                    if ($a -is [string]) { $assignee = $a }
                } catch { $assignee = '?' }
                if ($assignee -eq '' -or $assignee -eq $WorkerId) { $isBoard = $true }
                elseif ($assignee -ne '?' -and (@($Scope.LivePeerIds) -notcontains $assignee)) { $isBoard = $true }
            }
        }
        if ($isBoard) {
            $candidates += @{ Path = $p; Blob = $blob; XY = $entry.XY; Reason = 'BOARD'; Inferred = $false }
            continue
        }
        if (Test-MoeDenyPath $p $entry.XY $rel $Settings) {
            $skipped += @{ Path = $p; Code = 'MOE_ATTR_EXCLUDED' }
            $excluded++
            continue
        }
        $isOwnMemory = ($k.StartsWith($memoryPrefix) -and $entry.XY -ne '??' -and $k.IndexOf($taskIdKey) -ge 0)
        if ($mine.ContainsKey($k) -or $isOwnMemory) {
            if ($peer.ContainsKey($k)) {
                $contested += @{ Path = $p; TaskId = $peer[$k] }
                if ($contestedPolicy -eq 'skip') {
                    $skipped += @{ Path = $p; Code = 'MOE_ATTR_CONTESTED' }
                    continue
                }
            }
            $candidates += @{ Path = $p; Blob = $blob; XY = $entry.XY; Reason = 'ASSERTED'; Inferred = $false }
            continue
        }
        if ($peer.ContainsKey($k)) {
            $skipped += @{ Path = $p; Code = "MOE_ATTR_PEER_DECLARED($($peer[$k]))" }
            continue
        }
        if (-not $changed) {
            $skipped += @{ Path = $p; Code = 'MOE_ATTR_PREEXISTING' }
            $foreign++
            continue
        }
        if ($planned.ContainsKey($k)) {
            $candidates += @{ Path = $p; Blob = $blob; XY = $entry.XY; Reason = 'PLANNED'; Inferred = $false }
            continue
        }
        if ($undeclared -eq 'always' -or ($undeclared -eq 'solo' -and -not $Scope.PeersActive)) {
            $candidates += @{ Path = $p; Blob = $blob; XY = $entry.XY; Reason = 'MEASURED'; Inferred = $true }
            continue
        }
        $unattributed += @{ Path = $p; Blob = $blob }
    }

    # Asserted paths that are neither dirty nor present nor in HEAD.
    $missing = @()
    foreach ($k in $asserted.Keys) {
        if ($S.ContainsKey($k)) { continue }
        $tp = $asserted[$k]
        if (Test-Path -LiteralPath (Join-Path $Git.Top $tp)) { continue }
        $r = Invoke-MoeGit -Top $Git.Top -GitArgs @('cat-file', '-e', "HEAD:$tp")
        if ($r.Rc -eq 0) { continue }
        $missing += $tp
        $skipped += @{ Path = $tp; Code = 'MOE_ATTR_MISSING' }
    }

    return @{
        Candidates = @($candidates); Skipped = @($skipped); Unattributed = @($unattributed)
        Missing = @($missing); Contested = @($contested); ForeignCount = $foreign; ExcludedCount = $excluded
        AssertedCount = $asserted.Count; PlannedCount = $planned.Count; ToolCount = $Tool.Count
        Undeclared = $undeclared
    }
}

# Today's branch-safety peel lifted into a helper. Returns the branch name the
# commit may land on, or '' when the tree must not be committed (peel failed).
function Ensure-MoeSafeBranch([string]$Top, [hashtable]$Settings) {
    $currentBranch = ''
    $r = Invoke-MoeGit -Top $Top -GitArgs @('symbolic-ref', '--short', '-q', 'HEAD')
    if ($r.Rc -eq 0 -and $r.Out.Count -gt 0) { $currentBranch = ($r.Out -join '').Trim() }
    if (-not $currentBranch) {
        $r = Invoke-MoeGit -Top $Top -GitArgs @('rev-parse', '--abbrev-ref', 'HEAD')
        if ($r.Rc -eq 0 -and $r.Out.Count -gt 0) { $currentBranch = ($r.Out -join '').Trim() }
    }
    if ($currentBranch -eq 'main' -or $currentBranch -eq 'master' -or $currentBranch -eq 'HEAD' -or -not $currentBranch) {
        $moeBranch = "moe/work-" + (Get-Date -Format "yyyy-MM-dd")
        if ($Settings -and $Settings.consolidationBranch) { $moeBranch = $Settings.consolidationBranch }
        Write-Host "[branch] on $currentBranch; switching to $moeBranch so we don't commit to the default branch." -ForegroundColor Yellow
        $r = Invoke-MoeGit -Top $Top -GitArgs @('rev-parse', '--verify', '--quiet', "refs/heads/$moeBranch")
        if ($r.Rc -eq 0) {
            $co = Invoke-MoeGit -Top $Top -GitArgs @('checkout', $moeBranch) -MergeStderr
        } else {
            $r = Invoke-MoeGit -Top $Top -GitArgs @('rev-parse', '--verify', '--quiet', "refs/remotes/origin/$moeBranch")
            if ($r.Rc -eq 0) {
                $co = Invoke-MoeGit -Top $Top -GitArgs @('checkout', '-b', $moeBranch, "origin/$moeBranch") -MergeStderr
            } else {
                $co = Invoke-MoeGit -Top $Top -GitArgs @('checkout', '-b', $moeBranch) -MergeStderr
            }
        }
        $co.Out | Select-Object -Last 2 | ForEach-Object { Write-Host "  $_" }
        if ($co.Rc -ne 0) {
            Write-Host "[WARN] failed to switch off $currentBranch; aborting auto-commit to avoid writing to the default branch." -ForegroundColor Yellow
            return ''
        }
        $currentBranch = $moeBranch
    }
    return $currentBranch
}

# Stage the candidates into a TEMP index seeded from $OldSha (or empty) and
# verify each staged blob equals the snapshot blob (a path that changed under
# us is dropped with MOE_ATTR_CONCURRENT and re-attempted at the next exit).
function Build-MoeTempIndexTree([string]$Top, [string]$IndexFile, [string]$OldSha, [array]$Candidates) {
    $res = @{ Ok = $false; Changed = $false; Tree = ''; Landed = @(); Dropped = @() }
    $idxDir = Split-Path -Parent $IndexFile
    if (-not (Test-Path -LiteralPath $idxDir)) { New-Item -ItemType Directory -Force -Path $idxDir | Out-Null }
    Remove-Item -LiteralPath $IndexFile -Force -ErrorAction SilentlyContinue
    if ($OldSha) {
        $r = Invoke-MoeGit -Top $Top -IndexFile $IndexFile -GitArgs @('read-tree', $OldSha)
    } else {
        $r = Invoke-MoeGit -Top $Top -IndexFile $IndexFile -GitArgs @('read-tree', '--empty')
    }
    if ($r.Rc -ne 0) { return $res }
    $landed = @()
    $dropped = @()
    foreach ($c in @($Candidates)) {
        $spec = ":(literal)$($c.Path)"
        $a = Invoke-MoeGit -Top $Top -IndexFile $IndexFile -GitArgs @('add', '--', $spec)
        if ($a.Rc -ne 0) {
            $dropped += @{ Path = $c.Path; Code = 'MOE_ATTR_MISSING' }
            continue
        }
        $ls = Invoke-MoeGit -Top $Top -IndexFile $IndexFile -GitArgs @('ls-files', '-s', '-z', '--', $spec)
        $stagedBlob = ''
        $lsLine = ($ls.Out -join '').Split([char]0)[0]
        if ($lsLine) {
            $fields = @($lsLine -split '\s+')
            if ($fields.Count -ge 2) { $stagedBlob = $fields[1] }
        }
        $match = $false
        if ($c.Blob -eq 'D') { $match = (-not $stagedBlob) } else { $match = ($stagedBlob -eq $c.Blob) }
        if (-not $match) {
            if ($OldSha) {
                Invoke-MoeGit -Top $Top -IndexFile $IndexFile -GitArgs @('reset', '-q', $OldSha, '--', $spec) | Out-Null
            } else {
                Invoke-MoeGit -Top $Top -IndexFile $IndexFile -GitArgs @('rm', '--cached', '-q', '--force', '--', $spec) | Out-Null
            }
            $dropped += @{ Path = $c.Path; Code = 'MOE_ATTR_CONCURRENT' }
            continue
        }
        $landed += $c
    }
    $res.Landed = @($landed)
    $res.Dropped = @($dropped)
    $res.Ok = $true
    if ($landed.Count -eq 0) { return $res }
    if ($OldSha) {
        $d = Invoke-MoeGit -Top $Top -IndexFile $IndexFile -GitArgs @('diff-index', '--cached', '--quiet', $OldSha)
        $res.Changed = ($d.Rc -ne 0)
    } else {
        $n = Invoke-MoeGit -Top $Top -IndexFile $IndexFile -GitArgs @('ls-files', '-z')
        $res.Changed = ((($n.Out -join '').Split([char]0) | Where-Object { $_ }).Count -gt 0)
    }
    if (-not $res.Changed) { return $res }
    $w = Invoke-MoeGit -Top $Top -IndexFile $IndexFile -GitArgs @('write-tree')
    if ($w.Rc -ne 0 -or $w.Out.Count -eq 0) { $res.Ok = $false; return $res }
    $res.Tree = ($w.Out -join '').Trim()
    return $res
}

function Get-MoeCommitTitle([string]$Title, [string]$Fallback) {
    $t = if ($Title) { ($Title -replace '[\r\n]+', ' ').Trim() } else { '' }
    if (-not $t) { $t = $Fallback }
    return $t
}

# Section 8 message formats (grep-stable; identical in moe-agent.sh).
function New-MoeCommitMessage {
    param(
        [string]$Kind, [string]$TaskId, [string]$Title, [string]$Status, [int]$ReopenCount, [string]$Role,
        [string]$Sid, [int]$CliExit, [bool]$Recovered, [int]$PathCount, [int]$InferredCount, [array]$Contested, [string]$Reason
    )
    $lines = @()
    if ($Kind -eq 'completion') {
        $type = if ($ReopenCount -gt 0) { 'fix' } else { 'feat' }
        $suffix = if ($ReopenCount -gt 0) { " (retry after qa_reject #$ReopenCount)" } else { '' }
        $lines += "$type($TaskId): $(Get-MoeCommitTitle $Title 'completed task')$suffix"
        $lines += ''
        $lines += 'Completed via Moe worker session.'
    } elseif ($Kind -eq 'checkpoint') {
        $statusText = if ($Status) { $Status } else { 'UNKNOWN' }
        $rec = if ($Recovered) { ' recovered' } else { '' }
        $lines += "wip($TaskId): $(Get-MoeCommitTitle $Title 'checkpoint') [status=$statusText role=$Role cli-exit=$CliExit]$rec"
        $lines += ''
        $lines += "Checkpoint via Moe $Role session; not a completion."
    } else {
        $lines += "rescue($TaskId): $(Get-MoeCommitTitle $Title 'rescue') [reason=$Reason]"
        $lines += ''
        $lines += "Rescue snapshot via Moe $Role session; recover with git checkout <ref> -- <path>."
    }
    $lines += ''
    $lines += "Moe-Task: $TaskId"
    $lines += "Moe-Kind: $Kind"
    $lines += "Moe-Session: $Sid"
    if ($Kind -eq 'rescue') {
        $lines += "Moe-Reason: $Reason"
    } else {
        $statusText = if ($Status) { $Status } else { 'UNKNOWN' }
        $lines += "Moe-Status: $statusText"
        $lines += "Moe-Paths: $PathCount"
        $lines += "Moe-Inferred: $InferredCount"
        foreach ($c in @($Contested)) { if ($c) { $lines += "Moe-Contested: $($c.Path) ($($c.TaskId))" } }
    }
    return (($lines -join "`n") + "`n")
}

function Write-MoeMessageFile([string]$GitDir, [string]$TaskId, [string]$Message) {
    $dir = Join-Path $GitDir 'moe'
    if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    $path = Join-Path $dir "msg-$TaskId-$myPid.txt"
    [System.IO.File]::WriteAllText($path, $Message, (New-Object System.Text.UTF8Encoding($false)))
    return $path
}

# Best-effort moe.record_commit; a $null result never breaks the loop.
# NOTE: the parameter is deliberately NOT named $Args — a typed [hashtable]
# parameter of that name collides with the automatic $args array on 5.1.
function Send-MoeRecordCommit([hashtable]$Record) {
    try {
        $r = Invoke-MoeRpc -Tool 'record_commit' -Args $Record
        if ($null -eq $r) { Write-Host "[WARN] moe.record_commit returned nothing (old daemon?) — the commit is on the branch; the ledger entry is missing." -ForegroundColor Yellow }
        return $r
    } catch {
        return $null
    }
}

function Send-MoeGeneralChat([string]$Content) {
    if (-not $generalChannelId) { return }
    try {
        Invoke-MoeRpc -Tool 'chat_send' -Args @{ channel = $generalChannelId; workerId = $WorkerId; content = $Content } | Out-Null
    } catch {}
}

function ConvertTo-MoeRecordPaths([array]$Items, [int]$Cap) {
    $n = 0
    foreach ($i in @($Items)) {
        if ($null -eq $i) { continue }
        if ($i -is [string]) { Write-Output $i } else { Write-Output ([string]$i.Path) }
        $n++
        if ($n -ge $Cap) { break }
    }
}

# Section 7.4: rescue ref refs/moe/rescue/<taskId>/<utc-ts>. HEAD, branch and
# shared index untouched; never pushed. Builds the tree from the candidates
# (or a prebuilt tree) against HEAD's tree so `git show <ref> --stat` reads
# as "what this session changed".
function Invoke-MoeRescueRef {
    param(
        [Parameter(Mandatory = $true)][hashtable]$Git,
        [Parameter(Mandatory = $true)][string]$TaskId,
        [Parameter(Mandatory = $true)][string]$Reason,
        [string]$Title = '', [string]$Status = '', [string]$Sid = '',
        [hashtable]$Attr = $null,
        [string]$Sha = ''
    )
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $idx = Join-Path (Join-Path $Git.GitDir 'moe') "idx-$TaskId-$myPid-rescue"
    $msgFile = ''
    try {
        $pathCount = 0
        if (-not $Sha) {
            if ($null -eq $Attr) {
                $s = Get-MoeDirtySnapshot $Git.Top
                if ($null -eq $s) { Write-Host "[rescue] git status failed; nothing rescued for task $TaskId (reason=$Reason)." -ForegroundColor Yellow; return $null }
                $bl = Read-MoeBaseline (Get-MoeBaselinePath $Git.GitDir $TaskId)
                $b = if ($bl) { $bl.B } else { @{} }
                $u = if ($bl) { $bl.U } else { @{} }
                $scope = Get-MoeCommitScope $TaskId 'postflight' $Sid
                $settings = Read-MoeCommitSettings
                $Attr = Resolve-MoeAttribution -Git $Git -S $s -B $b -U $u -Tool $script:MoeToolWritten -Scope $scope -Settings $settings -TaskId $TaskId -Mode 'checkpoint' -PolicyOverride 'never'
            }
            if ($Attr.Candidates.Count -eq 0) {
                Write-Host "[rescue] nothing to rescue for task $TaskId (reason=$Reason)." -ForegroundColor Cyan
                return $null
            }
            $head = ''
            $h = Invoke-MoeGit -Top $Git.Top -GitArgs @('rev-parse', '-q', '--verify', 'HEAD')
            if ($h.Rc -eq 0 -and $h.Out.Count -gt 0) { $head = ($h.Out -join '').Trim() }
            $built = Build-MoeTempIndexTree -Top $Git.Top -IndexFile $idx -OldSha $head -Candidates $Attr.Candidates
            if (-not $built.Ok -or -not $built.Changed) {
                Write-Host "[rescue] nothing to rescue for task $TaskId (reason=$Reason)." -ForegroundColor Cyan
                return $null
            }
            $pathCount = $built.Landed.Count
            $msg = New-MoeCommitMessage -Kind 'rescue' -TaskId $TaskId -Title $Title -Status $Status -ReopenCount 0 -Role $Role -Sid $Sid -CliExit 0 -Recovered $false -PathCount $pathCount -InferredCount 0 -Contested @() -Reason $Reason
            $msgFile = Write-MoeMessageFile $Git.GitDir $TaskId $msg
            $ctArgs = @('commit-tree', $built.Tree)
            if ($head) { $ctArgs += @('-p', $head) }
            $ctArgs += @('-F', $msgFile)
            $ct = Invoke-MoeGit -Top $Git.Top -GitArgs $ctArgs -MergeStderr
            if ($ct.Rc -ne 0 -or $ct.Out.Count -eq 0) {
                Write-Host "[WARN] rescue commit-tree failed for task ${TaskId}: $(($ct.Out | Select-Object -Last 2) -join ' ')" -ForegroundColor Yellow
                return $null
            }
            $Sha = ($ct.Out -join '').Trim()
        }
        $ts = (Get-Date).ToUniversalTime().ToString("yyyyMMdd'T'HHmmss'Z'")
        $ref = "refs/moe/rescue/$TaskId/$ts"
        for ($n = 2; $n -le 9; $n++) {
            $ex = Invoke-MoeGit -Top $Git.Top -GitArgs @('rev-parse', '-q', '--verify', $ref)
            if ($ex.Rc -ne 0) { break }
            $ref = "refs/moe/rescue/$TaskId/$ts-$n"
        }
        $ur = Invoke-MoeGit -Top $Git.Top -GitArgs @('update-ref', $ref, $Sha) -MergeStderr
        if ($ur.Rc -ne 0) {
            Write-Host "[WARN] rescue update-ref failed for task ${TaskId}: $(($ur.Out | Select-Object -Last 2) -join ' ')" -ForegroundColor Yellow
            return $null
        }
        # Full sha (not abbreviated): identical to the sh twin and to the
        # daemon's re-emission of this line from record_commit.
        $line = "MOE_RESCUE_REF task=$TaskId ref=$ref sha=$Sha reason=$Reason"
        Write-Host "[rescue] $line" -ForegroundColor Yellow
        Write-Host "[rescue] recover with: git show $ref --stat ; git checkout $ref -- <path>" -ForegroundColor Yellow
        Send-MoeGeneralChat $line
        # ROOT-relative paths (REL stripped), and MEASURED candidates travel as
        # inferredPaths so the daemon never promotes them into filesModified —
        # same split as the sh twin's record_commit_rpc.
        $recPaths = @()
        $recInferred = @()
        if ($Attr) {
            $recPaths = @(ConvertTo-MoeRecordPaths $Attr.Candidates 500 | ForEach-Object { ConvertTo-MoeRootRelative $_ $Git.Rel })
            $recInferred = @($Attr.Candidates | Where-Object { $_.Inferred } | ForEach-Object { ConvertTo-MoeRootRelative $_.Path $Git.Rel } | Select-Object -First 500)
        }
        Send-MoeRecordCommit @{
            taskId = $TaskId; outcome = 'committed'; kind = 'rescue'; sha = $Sha; ref = $ref; status = $Status; role = $Role
            workerId = $WorkerId; sessionId = $Sid; pushed = $false; paths = $recPaths; inferredPaths = $recInferred; code = $Reason
            message = $line
        } | Out-Null
        return @{ Ref = $ref; Sha = $Sha; PathCount = $pathCount }
    } catch {
        Write-Host "[WARN] rescue ref failed for task ${TaskId}: $_" -ForegroundColor Yellow
        return $null
    } finally {
        Remove-Item -LiteralPath $idx -Force -ErrorAction SilentlyContinue
        if ($msgFile) { Remove-Item -LiteralPath $msgFile -Force -ErrorAction SilentlyContinue }
        $ErrorActionPreference = $prev
    }
}

# Today's push (+ one pull --rebase retry) with per-kind banners. Returns $true
# when the branch is on the remote afterwards.
function Push-MoeBranch([string]$Top, [string]$Branch, [string]$Kind, [string]$TaskId) {
    $r = Invoke-MoeGit -Top $Top -GitArgs @('rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}')
    $hasUpstream = ($r.Rc -eq 0)
    if ($hasUpstream) {
        $p = Invoke-MoeGit -Top $Top -GitArgs @('push') -MergeStderr
    } else {
        $p = Invoke-MoeGit -Top $Top -GitArgs @('push', '-u', 'origin', $Branch) -MergeStderr
    }
    $p.Out | Select-Object -Last 5 | ForEach-Object { Write-Host "  $_" }
    if ($p.Rc -eq 0) {
        Write-Host "[OK] Pushed task $TaskId to $Branch." -ForegroundColor Green
        return $true
    }
    # The common cause is a non-fast-forward on the shared moe/work-* branch:
    # pull --rebase then re-push once. NOTE: pull --rebase refuses in a tree
    # with unstaged tracked changes, so in a busy fleet this retry usually
    # fails — unpushed is a visibility problem, not a loss.
    Write-Host "[WARN] git push failed; trying git pull --rebase then re-push..." -ForegroundColor Yellow
    if ($hasUpstream) {
        $pr = Invoke-MoeGit -Top $Top -GitArgs @('pull', '--rebase') -MergeStderr
    } else {
        # The failed `push -u` never configured an upstream, so a bare
        # `pull --rebase` dies with "no tracking information" — name the
        # remote branch instead, exactly as the sh twin does.
        $pr = Invoke-MoeGit -Top $Top -GitArgs @('pull', '--rebase', 'origin', $Branch) -MergeStderr
    }
    $pr.Out | Select-Object -Last 5 | ForEach-Object { Write-Host "  $_" }
    $rebaseOk = ($pr.Rc -eq 0)
    $pushOk = $false
    if ($rebaseOk) {
        if ($hasUpstream) {
            $p2 = Invoke-MoeGit -Top $Top -GitArgs @('push') -MergeStderr
        } else {
            $p2 = Invoke-MoeGit -Top $Top -GitArgs @('push', '-u', 'origin', $Branch) -MergeStderr
        }
        $p2.Out | Select-Object -Last 5 | ForEach-Object { Write-Host "  $_" }
        $pushOk = ($p2.Rc -eq 0)
    } else {
        # A rebase that stopped on a conflict must not leave the tree mid-rebase.
        $st = Invoke-MoeGit -Top $Top -GitArgs @('rev-parse', '-q', '--verify', 'REBASE_HEAD')
        if ($st.Rc -eq 0) { Invoke-MoeGit -Top $Top -GitArgs @('rebase', '--abort') | Out-Null }
    }
    if ($pushOk) {
        Write-Host "[OK] Pushed task $TaskId to $Branch (after rebase)." -ForegroundColor Green
        return $true
    }
    Write-Host "[WARN] git push still failing (auth? network? conflict?) — resolve and push manually." -ForegroundColor Yellow
    if ($Kind -eq 'completion') {
        # Loud, daemon-visible warning: the task is reviewable on the board
        # but its code never reached the remote.
        Send-MoeGeneralChat "PUSH FAILED for task $TaskId — committed locally only; do not review until pushed"
    } else {
        Write-Host "[WARN] CHECKPOINT-UNPUSHED task=$TaskId — checkpoint committed locally only on $Branch; push when the remote is reachable" -ForegroundColor Yellow
        Send-MoeGeneralChat "CHECKPOINT-UNPUSHED task=$TaskId — checkpoint committed locally only on $Branch; push when the remote is reachable"
    }
    return $false
}

# Refresh the SHARED index for exactly the landed paths after a plumbing
# commit, so `git status` reads clean for them; peers' pre-staged entries
# survive because only these pathspecs are touched. index.lock is retried.
function Update-MoeSharedIndex([string]$Top, [array]$Paths) {
    if (-not $Paths -or $Paths.Count -eq 0) { return $true }
    $specs = @()
    foreach ($p in $Paths) { $specs += ":(literal)$p" }
    for ($attempt = 1; $attempt -le 5; $attempt++) {
        $r = Invoke-MoeGit -Top $Top -GitArgs (@('reset', '-q', '--') + $specs) -MergeStderr
        if ($r.Rc -eq 0) { return $true }
        $text = ($r.Out -join ' ')
        if ($text -notlike '*index.lock*') { break }
        Start-Sleep -Seconds 2
    }
    Write-Host "[WARN] MOE_COMMIT_INDEX_REFRESH_FAILED: the commit exists but the shared index was not refreshed for $($Paths.Count) path(s); run git reset -q -- <path> by hand." -ForegroundColor Yellow
    return $false
}

# Section 7: land a completion or checkpoint. Returns a result hashtable —
# never break/continue. Outcome ∈ committed|nothing|refused|failed.
function Invoke-MoeLanding {
    param(
        [Parameter(Mandatory = $true)][string]$Kind,
        [Parameter(Mandatory = $true)][string]$TaskId,
        [Parameter(Mandatory = $true)][hashtable]$Git,
        [Parameter(Mandatory = $true)][hashtable]$Settings,
        [string]$Title = '',
        [string]$Status = '',
        [int]$ReopenCount = 0,
        [int]$CliExit = 0,
        [string]$Reason = '',
        [string]$Sid = '',
        [bool]$RunGate = $false,
        [bool]$IsEpicFinal = $true
    )
    $res = @{
        Outcome = 'nothing'; Kind = $Kind; Sha = ''; Ref = ''; Code = ''; Branch = ''
        PathCount = 0; InferredCount = 0; SkippedCount = 0; UnattributedCount = 0
        Pushed = $false; StopLoop = $false
    }
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $idx = Join-Path (Join-Path $Git.GitDir 'moe') "idx-$TaskId-$myPid"
    $msgFile = ''
    $recovered = ($Reason -eq 'recovered')
    $statusText = if ($Status) { $Status } else { 'UNKNOWN' }
    try {
        $baselinePath = Get-MoeBaselinePath $Git.GitDir $TaskId
        $bl = Read-MoeBaseline $baselinePath
        $B = if ($bl) { $bl.B } else { @{} }
        $U = if ($bl) { $bl.U } else { @{} }
        # Fail CLOSED on missing evidence: with no readable baseline every
        # pre-session dirty path would read as "changed since baseline" and the
        # MEASURED tier would sweep foreign debris into this task's commit. The
        # policy is forced to 'never' for this landing (undeclared paths are
        # reported, never committed); ASSERTED/TOOL/PLANNED/BOARD still land.
        $policyOverride = ''
        if ($null -eq $bl) {
            $policyOverride = 'never'
            Write-Host "[attribution] no readable baseline for task $TaskId — measured attribution disabled for this landing (undeclared paths are reported, never committed)." -ForegroundColor Yellow
        }

        # Quality gate (completion only): a failing gate can't un-transition
        # the task, so it blocks the ship — the work goes to a RESCUE REF
        # (never a branch commit, never pushed), chat + task comment carry the
        # evidence, and the worker loop hard-stops. Opt out per-run via
        # MOE_DISABLE_QUALITY_GATE=1. The gate RUNS here (before the snapshot:
        # a gate that runs formatters rewrites files, and the snapshot must see
        # the post-gate tree), but its failure is handled AFTER attribution so
        # the rescue parks the normal-policy candidate set — same order as the
        # sh twin.
        $gateFailed = $false
        $gateRc = 0
        $gateOut = ''
        if ($Kind -eq 'completion' -and $RunGate -and $Settings.qualityGate) {
            $gate = $Settings.qualityGate
            if ($Settings.qualityGateScope -ne 'everyTask' -and -not $IsEpicFinal) {
                Write-Host "[info] qualityGate deferred: task $TaskId is mid-epic (scope=epicFinal; the epic-final task runs the full gate)." -ForegroundColor Cyan
            } else {
                Write-Host "Post-flight: quality gate: $gate" -ForegroundColor Cyan
                Push-Location $projectPath
                try {
                    $gateOut = (& $env:ComSpec /d /s /c $gate 2>&1 | Out-String)
                    $gateRc = $LASTEXITCODE
                } finally {
                    Pop-Location
                }
                if ($gateRc -ne 0) {
                    ($gateOut -split "`n" | Select-Object -Last 15) | ForEach-Object { Write-Host "  $_" }
                    Write-Host "[WARN] qualityGate failed (exit $gateRc); skipping commit+push for task $TaskId." -ForegroundColor Yellow
                    Write-Host "[WARN] task $TaskId not landed on the branch — its edits are parked on a rescue ref and the worker loop stops here so nothing lands without the gate." -ForegroundColor Yellow
                    $gateFailed = $true
                } else {
                    Write-Host "[OK] qualityGate passed." -ForegroundColor Green
                }
            }
        }

        # Snapshot + scope + attribution (section 6). The branch peel is
        # deferred until we know something must land (sh order): a checkpoint
        # with nothing to commit must not switch a human's checkout off main.
        $S = Get-MoeDirtySnapshot $Git.Top
        if ($null -eq $S) {
            Write-Host "[WARN] git status failed; cannot attribute the working tree for task $TaskId — nothing committed, baseline kept." -ForegroundColor Yellow
            $res.Outcome = 'failed'
            $res.Code = 'MOE_COMMIT_FAILED_ATTRIBUTION'
            Send-MoeRecordCommit @{ taskId = $TaskId; outcome = 'failed'; kind = $Kind; status = $Status; role = $Role; workerId = $WorkerId; sessionId = $Sid; cliExitCode = $CliExit; code = 'MOE_COMMIT_FAILED_ATTRIBUTION' } | Out-Null
            return $res
        }
        $scope = Get-MoeCommitScope $TaskId 'postflight' $Sid
        if (-not $Title -and $scope.Title) { $Title = $scope.Title }
        $attr = Resolve-MoeAttribution -Git $Git -S $S -B $B -U $U -Tool $script:MoeToolWritten -Scope $scope -Settings $Settings -TaskId $TaskId -Mode $Kind -PolicyOverride $policyOverride
        if ($attr.ForeignCount -gt 0) {
            Write-Host "[attribution] $($attr.ForeignCount) pre-session dirty path(s) untouched" -ForegroundColor Cyan
        }
        if ($attr.ExcludedCount -gt 0) {
            Write-Host "[attribution] $($attr.ExcludedCount) excluded path(s) untouched (MOE_ATTR_EXCLUDED: .moe/, tool config, worktrees)" -ForegroundColor Cyan
        }
        # Per-path [skip] lines for everything but MOE_ATTR_EXCLUDED (.moe/**
        # and tool config are static and numerous; they get the count above).
        # MOE_ATTR_PREEXISTING is capped at 20 per session (a busy shared
        # checkout carries hundreds) — same bound as the sh twin.
        $nPre = 0
        foreach ($sk in @($attr.Skipped)) {
            if ($sk.Code -eq 'MOE_ATTR_EXCLUDED') { continue }
            if ($sk.Code -eq 'MOE_ATTR_PREEXISTING') {
                $nPre++
                if ($nPre -gt 20) { continue }
            }
            Write-Host "[skip] $($sk.Path) $($sk.Code)" -ForegroundColor Yellow
        }
        if ($nPre -gt 20) { Write-Host "[skip] ... $($nPre - 20) more MOE_ATTR_PREEXISTING path(s)" -ForegroundColor Yellow }
        $res.SkippedCount = $attr.Skipped.Count
        $res.UnattributedCount = $attr.Unattributed.Count
        $unattrPaths = @(ConvertTo-MoeRecordPaths $attr.Unattributed 500)
        # Record path lists travel ROOT-relative (REL stripped) — the daemon
        # stores declarations ROOT-relative and both wrappers re-prefix REL on
        # the way back, so a TOP-relative record would double the prefix in a
        # nested checkout. Console lines stay TOP-relative (as the sh twin's).
        $unattrRecPaths = @($unattrPaths | ForEach-Object { ConvertTo-MoeRootRelative $_ $Git.Rel })
        if ($attr.Unattributed.Count -gt 0) {
            Write-Host "[attribution] MOE_ATTRIBUTION_UNRESOLVED task=${TaskId}: $($unattrPaths -join ' ')" -ForegroundColor Yellow
            Write-Host "[attribution] these changed paths were neither declared by the task nor written by its tools while other workers were active; report them via complete_step.modifiedFiles or moe.declare_files." -ForegroundColor Yellow
        }
        $newU = @{}
        foreach ($ua in @($attr.Unattributed)) { $newU[(Get-MoePathKey $ua.Path)] = @{ Path = $ua.Path; Blob = $ua.Blob } }

        # Gate failure (deferred from above so the rescue parks the FULL
        # normal-policy candidate set, MEASURED included — sh parity): rescue
        # ref, chat + task comment, unconditional failed record, hard stop.
        if ($gateFailed) {
            $rescue = Invoke-MoeRescueRef -Git $Git -TaskId $TaskId -Reason 'gate-failed' -Title $Title -Status $Status -Sid $Sid -Attr $attr
            $gateMsg = "🚫 PUSH-BLOCKED: qualityGate failed for task ${TaskId}: $($Settings.qualityGate) (exit $gateRc)"
            if ($rescue) { $gateMsg += " — edits parked on $($rescue.Ref)" }
            Send-MoeGeneralChat $gateMsg
            # Attach the output tail to the task so QA rejects with
            # evidence (add_comment caps content at 10k chars).
            try {
                $tailLines = (($gateOut -split "`n" | Select-Object -Last 50) -join "`n")
                if ($tailLines.Length -gt 8000) { $tailLines = $tailLines.Substring($tailLines.Length - 8000) }
                Invoke-MoeRpc -Tool "add_comment" -Args @{ taskId = $TaskId; workerId = $WorkerId; content = "$gateMsg`n`n$tailLines" } | Out-Null
            } catch {}
            $res.Outcome = 'failed'
            $res.Code = 'MOE_COMMIT_FAILED_GATE'
            if ($rescue) { $res.Ref = $rescue.Ref; $res.Sha = $rescue.Sha }
            $res.StopLoop = $true
            # The failed record is sent UNCONDITIONALLY (after the rescue's own
            # committed/rescue record) so task.lastCommitOutcome reads failed —
            # the sh twin records both, and triage keys on the failed one.
            Send-MoeRecordCommit @{ taskId = $TaskId; outcome = 'failed'; kind = $Kind; status = $Status; role = $Role; workerId = $WorkerId; sessionId = $Sid; cliExitCode = $CliExit; code = 'MOE_COMMIT_FAILED_GATE'; message = "qualityGate exit $gateRc" } | Out-Null
            return $res
        }

        # Outcome when nothing at all is attributable (BOARD candidates count:
        # a board-only session still lands, as the sh twin does).
        if ($attr.Candidates.Count -eq 0) {
            $code = 'MOE_COMMIT_NOTHING_TO_COMMIT'
            $outcome = 'nothing'
            if ($Kind -eq 'completion' -and ($attr.AssertedCount + $attr.PlannedCount) -eq 0) {
                $code = 'MOE_COMMIT_REFUSED_NO_OWNED_PATHS'
                $outcome = 'refused'
            } elseif ($attr.AssertedCount -gt 0 -and $attr.Missing.Count -ge $attr.AssertedCount -and $attr.ToolCount -eq 0) {
                $code = 'MOE_COMMIT_REFUSED_OWNED_PATH_MISSING'
                $outcome = 'refused'
            }
            if ($outcome -eq 'refused') {
                # Fail CLOSED. There is no whole-tree fallback: a fallback that
                # fires silently is how a peer's in-flight files reached another
                # task's commit.
                Write-Host "[WARN] ${code}: task $TaskId — refusing to auto-commit; there is no whole-tree fallback. Commit the task's own paths by hand: git commit -- <path> [<path>...]" -ForegroundColor Yellow
            } else {
                Write-Host "[info] ${code}: task $TaskId — no attributable changes to commit (already landed, or nothing changed)." -ForegroundColor Cyan
            }
            if ($Kind -eq 'completion') {
                # Peel even with nothing to stage so pre-existing local commits
                # still get pushed (today's shape, same as the sh twin).
                $branch = Ensure-MoeSafeBranch $Git.Top $Settings
                if (-not $branch) {
                    $rescue = Invoke-MoeRescueRef -Git $Git -TaskId $TaskId -Reason 'peel-failed' -Title $Title -Status $Status -Sid $Sid -Attr $attr
                    $res.Outcome = 'failed'
                    $res.Code = 'MOE_COMMIT_FAILED_PEEL'
                    if ($rescue) { $res.Ref = $rescue.Ref; $res.Sha = $rescue.Sha }
                    $res.StopLoop = $true
                    Send-MoeRecordCommit @{ taskId = $TaskId; outcome = 'failed'; kind = $Kind; status = $Status; role = $Role; workerId = $WorkerId; sessionId = $Sid; cliExitCode = $CliExit; code = 'MOE_COMMIT_FAILED_PEEL'; message = 'branch peel failed' } | Out-Null
                    return $res
                }
                $res.Branch = $branch
            }
            $res.Outcome = $outcome
            $res.Code = $code
            if ($bl) { Write-MoeBaseline $baselinePath $TaskId $bl.Head $B $newU 1 | Out-Null }
            # Any commits the worker made mid-session are already pathspec-scoped
            # and must still reach the remote (today's behaviour for completions).
            if ($Kind -eq 'completion') { $res.Pushed = Push-MoeBranch $Git.Top $res.Branch $Kind $TaskId }
            Send-MoeRecordCommit @{
                taskId = $TaskId; outcome = $outcome; kind = $Kind; status = $Status; role = $Role; workerId = $WorkerId
                sessionId = $Sid; cliExitCode = $CliExit; pushed = $res.Pushed; code = $code
                unattributedPaths = $unattrRecPaths; skipped = @(@($attr.Skipped | Where-Object { $_.Code -ne 'MOE_ATTR_EXCLUDED' } | Select-Object -First 100) | ForEach-Object { @{ path = (ConvertTo-MoeRootRelative $_.Path $Git.Rel); code = $_.Code } })
            } | Out-Null
            return $res
        }

        # 7.1 Branch safety — candidates exist, so the peel is warranted now.
        $branch = Ensure-MoeSafeBranch $Git.Top $Settings
        if (-not $branch) {
            $rescue = Invoke-MoeRescueRef -Git $Git -TaskId $TaskId -Reason 'peel-failed' -Title $Title -Status $Status -Sid $Sid -Attr $attr
            $res.Outcome = 'failed'
            $res.Code = 'MOE_COMMIT_FAILED_PEEL'
            if ($rescue) { $res.Ref = $rescue.Ref; $res.Sha = $rescue.Sha }
            $res.StopLoop = $true
            Send-MoeRecordCommit @{ taskId = $TaskId; outcome = 'failed'; kind = $Kind; status = $Status; role = $Role; workerId = $WorkerId; sessionId = $Sid; cliExitCode = $CliExit; code = 'MOE_COMMIT_FAILED_PEEL'; message = 'branch peel failed' } | Out-Null
            return $res
        }
        $res.Branch = $branch

        $candidates = @($attr.Candidates)
        $inferredCount = @($candidates | Where-Object { $_.Inferred }).Count
        $inferredPaths = @($candidates | Where-Object { $_.Inferred } | ForEach-Object { $_.Path })
        $landedPaths = @()
        $sha = ''
        $usePorcelain = ($Settings.commitHooks -and $Kind -eq 'completion')
        $dropped = @()

        if ($usePorcelain) {
            # 7.3 Hooks requested: today's porcelain path against the shared
            # index, with the same staged-blob check; rc != 0 -> rescue ref.
            $specs = @()
            $staged = @()
            foreach ($c in $candidates) {
                $spec = ":(literal)$($c.Path)"
                $a = $null
                for ($attempt = 1; $attempt -le 5; $attempt++) {
                    $a = Invoke-MoeGit -Top $Git.Top -GitArgs @('add', '--', $spec) -MergeStderr
                    if ($a.Rc -eq 0 -or (($a.Out -join ' ') -notlike '*index.lock*')) { break }
                    Start-Sleep -Seconds 2
                }
                if ($a.Rc -ne 0) { $dropped += @{ Path = $c.Path; Code = 'MOE_ATTR_MISSING' }; continue }
                $ls = Invoke-MoeGit -Top $Git.Top -GitArgs @('ls-files', '-s', '-z', '--', $spec)
                $stagedBlob = ''
                $lsLine = ($ls.Out -join '').Split([char]0)[0]
                if ($lsLine) { $f = @($lsLine -split '\s+'); if ($f.Count -ge 2) { $stagedBlob = $f[1] } }
                $ok = if ($c.Blob -eq 'D') { -not $stagedBlob } else { $stagedBlob -eq $c.Blob }
                if (-not $ok) {
                    Invoke-MoeGit -Top $Git.Top -GitArgs @('reset', '-q', '--', $spec) | Out-Null
                    $dropped += @{ Path = $c.Path; Code = 'MOE_ATTR_CONCURRENT' }
                    continue
                }
                $specs += $spec
                $staged += $c
            }
            foreach ($d in $dropped) { Write-Host "[skip] $($d.Path) $($d.Code)" -ForegroundColor Yellow }
            # Every staged candidate matching HEAD is honest NOTHING, not a
            # commit failure: `git commit -- <specs>` exits non-zero with
            # "nothing to commit" there — check first, as the sh twin does.
            $stagedMatchesHead = $false
            if ($specs.Count -gt 0) {
                $dc = Invoke-MoeGit -Top $Git.Top -GitArgs (@('diff', '--cached', '--quiet', '--') + $specs)
                $stagedMatchesHead = ($dc.Rc -eq 0)
            }
            if ($specs.Count -eq 0 -or $stagedMatchesHead) {
                Write-Host "[info] MOE_COMMIT_NOTHING_TO_COMMIT: task $TaskId — every candidate was dropped at staging time or already matches HEAD." -ForegroundColor Cyan
                $res.Outcome = 'nothing'; $res.Code = 'MOE_COMMIT_NOTHING_TO_COMMIT'
                if ($bl) { Write-MoeBaseline $baselinePath $TaskId $bl.Head $B $newU 1 | Out-Null }
                $res.Pushed = Push-MoeBranch $Git.Top $branch $Kind $TaskId
                Send-MoeRecordCommit @{ taskId = $TaskId; outcome = 'nothing'; kind = $Kind; status = $Status; role = $Role; workerId = $WorkerId; sessionId = $Sid; cliExitCode = $CliExit; pushed = $res.Pushed; code = 'MOE_COMMIT_NOTHING_TO_COMMIT'; unattributedPaths = $unattrRecPaths } | Out-Null
                return $res
            }
            $msg = New-MoeCommitMessage -Kind $Kind -TaskId $TaskId -Title $Title -Status $Status -ReopenCount $ReopenCount -Role $Role -Sid $Sid -CliExit $CliExit -Recovered $recovered -PathCount $staged.Count -InferredCount $inferredCount -Contested $attr.Contested -Reason ''
            $msgFile = Write-MoeMessageFile $Git.GitDir $TaskId $msg
            $cm = $null
            for ($attempt = 1; $attempt -le 5; $attempt++) {
                # -- <specs> is load-bearing: a BARE commit commits the SHARED
                # INDEX and sweeps a peer's pre-staged file into this task.
                $cm = Invoke-MoeGit -Top $Git.Top -GitArgs (@('commit', '-F', $msgFile, '--') + $specs) -MergeStderr
                if ($cm.Rc -eq 0 -or (($cm.Out -join ' ') -notlike '*index.lock*')) { break }
                Start-Sleep -Seconds 2
            }
            $cm.Out | Select-Object -Last 3 | ForEach-Object { Write-Host "  $_" }
            if ($cm.Rc -ne 0) {
                Write-Host "[WARN] git commit failed (pre-commit hook? identity?) — parking the edits on a rescue ref; baseline kept." -ForegroundColor Yellow
                $rescue = Invoke-MoeRescueRef -Git $Git -TaskId $TaskId -Reason 'commit-failed' -Title $Title -Status $Status -Sid $Sid -Attr $attr
                $res.Outcome = 'failed'; $res.Code = 'MOE_COMMIT_FAILED'
                if ($rescue) { $res.Ref = $rescue.Ref; $res.Sha = $rescue.Sha }
                Send-MoeRecordCommit @{ taskId = $TaskId; outcome = 'failed'; kind = $Kind; status = $Status; role = $Role; workerId = $WorkerId; sessionId = $Sid; cliExitCode = $CliExit; code = 'MOE_COMMIT_FAILED'; message = (($cm.Out | Select-Object -Last 3) -join ' '); ref = $res.Ref } | Out-Null
                # Prior local commits still need the remote (today's behaviour).
                $res.Pushed = Push-MoeBranch $Git.Top $branch $Kind $TaskId
                return $res
            }
            $landedPaths = @($staged | ForEach-Object { $_.Path })
            $h = Invoke-MoeGit -Top $Git.Top -GitArgs @('rev-parse', 'HEAD')
            if ($h.Rc -eq 0) { $sha = ($h.Out -join '').Trim() }
        } else {
            # 7.2 Plumbing: temp index + commit-tree + update-ref CAS, 3 attempts.
            $new = ''
            $landed = @()
            $casOk = $false
            for ($attempt = 1; $attempt -le 3; $attempt++) {
                $old = ''
                $o = Invoke-MoeGit -Top $Git.Top -GitArgs @('rev-parse', '-q', '--verify', "refs/heads/$branch")
                if ($o.Rc -eq 0 -and $o.Out.Count -gt 0) { $old = ($o.Out -join '').Trim() }
                $built = Build-MoeTempIndexTree -Top $Git.Top -IndexFile $idx -OldSha $old -Candidates $candidates
                if (-not $built.Ok) {
                    Write-Host "[WARN] temp-index build failed for task $TaskId; nothing committed, baseline kept." -ForegroundColor Yellow
                    $res.Outcome = 'failed'; $res.Code = 'MOE_COMMIT_FAILED_ATTRIBUTION'
                    Send-MoeRecordCommit @{ taskId = $TaskId; outcome = 'failed'; kind = $Kind; status = $Status; role = $Role; workerId = $WorkerId; sessionId = $Sid; cliExitCode = $CliExit; code = 'MOE_COMMIT_FAILED_ATTRIBUTION' } | Out-Null
                    return $res
                }
                $dropped = @($built.Dropped)
                $landed = @($built.Landed)
                if (-not $built.Changed) {
                    foreach ($d in $dropped) { Write-Host "[skip] $($d.Path) $($d.Code)" -ForegroundColor Yellow }
                    Write-Host "[info] MOE_COMMIT_NOTHING_TO_COMMIT: task $TaskId — the attributable paths already match $branch." -ForegroundColor Cyan
                    $res.Outcome = 'nothing'; $res.Code = 'MOE_COMMIT_NOTHING_TO_COMMIT'
                    if ($bl) { Write-MoeBaseline $baselinePath $TaskId $bl.Head $B $newU 1 | Out-Null }
                    if ($Kind -eq 'completion') { $res.Pushed = Push-MoeBranch $Git.Top $branch $Kind $TaskId }
                    Send-MoeRecordCommit @{ taskId = $TaskId; outcome = 'nothing'; kind = $Kind; status = $Status; role = $Role; workerId = $WorkerId; sessionId = $Sid; cliExitCode = $CliExit; pushed = $res.Pushed; code = 'MOE_COMMIT_NOTHING_TO_COMMIT'; unattributedPaths = $unattrRecPaths } | Out-Null
                    return $res
                }
                $landedInferred = @($landed | Where-Object { $_.Inferred }).Count
                $msg = New-MoeCommitMessage -Kind $Kind -TaskId $TaskId -Title $Title -Status $Status -ReopenCount $ReopenCount -Role $Role -Sid $Sid -CliExit $CliExit -Recovered $recovered -PathCount $landed.Count -InferredCount $landedInferred -Contested $attr.Contested -Reason ''
                if ($msgFile) { Remove-Item -LiteralPath $msgFile -Force -ErrorAction SilentlyContinue }
                $msgFile = Write-MoeMessageFile $Git.GitDir $TaskId $msg
                $ctArgs = @('commit-tree', $built.Tree)
                if ($old) { $ctArgs += @('-p', $old) }
                $ctArgs += @('-F', $msgFile)
                $ct = Invoke-MoeGit -Top $Git.Top -GitArgs $ctArgs -MergeStderr
                if ($ct.Rc -ne 0 -or $ct.Out.Count -eq 0) {
                    ($ct.Out | Select-Object -Last 3) | ForEach-Object { Write-Host "  $_" }
                    Write-Host "[WARN] git commit-tree failed (identity? signing?) — parking the edits on a rescue ref; baseline kept." -ForegroundColor Yellow
                    $res.Outcome = 'failed'; $res.Code = 'MOE_COMMIT_FAILED'
                    $rescue = Invoke-MoeRescueRef -Git $Git -TaskId $TaskId -Reason 'commit-failed' -Title $Title -Status $Status -Sid $Sid -Attr $attr
                    if ($rescue) { $res.Ref = $rescue.Ref; $res.Sha = $rescue.Sha }
                    Send-MoeRecordCommit @{ taskId = $TaskId; outcome = 'failed'; kind = $Kind; status = $Status; role = $Role; workerId = $WorkerId; sessionId = $Sid; cliExitCode = $CliExit; code = 'MOE_COMMIT_FAILED'; message = (($ct.Out | Select-Object -Last 3) -join ' '); ref = $res.Ref } | Out-Null
                    if ($Kind -eq 'completion') { $res.Pushed = Push-MoeBranch $Git.Top $branch $Kind $TaskId }
                    return $res
                }
                $new = ($ct.Out -join '').Trim()
                if ($attempt -eq 1 -and $env:MOE_POSTFLIGHT_TEST_HOOK_PRE_UPDATE_REF) {
                    # Test seam: lets the harness move the branch tip between
                    # commit-tree and update-ref to prove the CAS retry.
                    Push-Location $Git.Top
                    try { & $env:ComSpec /d /s /c $env:MOE_POSTFLIGHT_TEST_HOOK_PRE_UPDATE_REF 2>&1 | Out-Null } catch {} finally { Pop-Location }
                }
                $oldArg = if ($old) { $old } else { '0000000000000000000000000000000000000000' }
                $ur = Invoke-MoeGit -Top $Git.Top -GitArgs @('update-ref', "refs/heads/$branch", $new, $oldArg) -MergeStderr
                if ($ur.Rc -eq 0) { $casOk = $true; break }
                Write-Host "[branch] $branch moved under us (attempt $attempt/3); rebuilding the commit on the new tip." -ForegroundColor Yellow
            }
            if (-not $casOk) {
                Write-Host "[WARN] MOE_COMMIT_FAILED_REF_CONTENTION: $branch kept moving during 3 attempts; parking the built commit on a rescue ref, baseline kept." -ForegroundColor Yellow
                $rescue = Invoke-MoeRescueRef -Git $Git -TaskId $TaskId -Reason 'ref-contention' -Title $Title -Status $Status -Sid $Sid -Attr $attr -Sha $new
                $res.Outcome = 'failed'; $res.Code = 'MOE_COMMIT_FAILED_REF_CONTENTION'
                if ($rescue) { $res.Ref = $rescue.Ref; $res.Sha = $rescue.Sha }
                Send-MoeRecordCommit @{ taskId = $TaskId; outcome = 'failed'; kind = $Kind; status = $Status; role = $Role; workerId = $WorkerId; sessionId = $Sid; cliExitCode = $CliExit; code = 'MOE_COMMIT_FAILED_REF_CONTENTION'; ref = $res.Ref } | Out-Null
                return $res
            }
            foreach ($d in $dropped) { Write-Host "[skip] $($d.Path) $($d.Code)" -ForegroundColor Yellow }
            $sha = $new
            $landedPaths = @($landed | ForEach-Object { $_.Path })
            $inferredCount = @($landed | Where-Object { $_.Inferred }).Count
            $inferredPaths = @($landed | Where-Object { $_.Inferred } | ForEach-Object { $_.Path })
            Update-MoeSharedIndex $Git.Top $landedPaths | Out-Null
        }

        # AFTER SUCCESS: prune landed paths from B, persist U, keep the baseline
        # until the task is DONE/ARCHIVED.
        foreach ($p in $landedPaths) { $B.Remove((Get-MoePathKey $p)) }
        if ($Status -eq 'DONE' -or $Status -eq 'ARCHIVED') {
            Remove-MoeBaseline $baselinePath
        } else {
            $head = if ($bl) { $bl.Head } else { $sha }
            Write-MoeBaseline $baselinePath $TaskId $head $B $newU 1 | Out-Null
        }
        $res.Outcome = 'committed'
        $res.Sha = $sha
        $res.Ref = "refs/heads/$branch"
        $res.PathCount = $landedPaths.Count
        $res.InferredCount = $inferredCount
        # Banner count = non-excluded attribution skips (incl. MISSING) plus
        # staging-time drops — the same arithmetic as the sh twin's n_skipped.
        $res.SkippedCount = ($attr.Skipped.Count - $attr.ExcludedCount) + $dropped.Count
        $shortSha = if ($sha.Length -gt 12) { $sha.Substring(0, 12) } else { $sha }
        Write-Host "[OK] Committed $Kind for task $TaskId on ${branch}: $shortSha ($($res.PathCount) paths, $($res.InferredCount) inferred, $($res.SkippedCount) skipped, $($res.UnattributedCount) unattributed)" -ForegroundColor Green

        # 7.5 Push policy.
        if ($Kind -eq 'completion' -or $Settings.checkpointPush) {
            $res.Pushed = Push-MoeBranch $Git.Top $branch $Kind $TaskId
        } else {
            Write-Host "[info] checkpointPush=false — checkpoint kept local on $branch." -ForegroundColor Cyan
        }

        # 7.6 Record (rebase-safe sha via the session trailer).
        $lg = Invoke-MoeGit -Top $Git.Top -GitArgs @('log', '-n1', '--format=%H', '--fixed-strings', "--grep=Moe-Session: $Sid", $branch)
        if ($lg.Rc -eq 0 -and $lg.Out.Count -gt 0 -and ($lg.Out -join '').Trim()) { $sha = ($lg.Out -join '').Trim(); $res.Sha = $sha }
        $treeId = ''
        $tr = Invoke-MoeGit -Top $Git.Top -GitArgs @('rev-parse', "$sha^{tree}")
        if ($tr.Rc -eq 0 -and $tr.Out.Count -gt 0) { $treeId = ($tr.Out -join '').Trim() }
        # MOE_ATTR_EXCLUDED skips (.moe/**, tool config) are static noise and
        # would crowd the 100-entry cap out of meaningful skips — the sh twin
        # filters them too. Truncation is computed daemon-side. Every path list
        # goes back ROOT-relative (REL stripped), like record_commit_rpc.
        $recArgs = @{
            taskId = $TaskId; outcome = 'committed'; kind = $Kind; sha = $sha; treeId = $treeId; ref = "refs/heads/$branch"
            status = $Status; role = $Role; workerId = $WorkerId; sessionId = $Sid; cliExitCode = $CliExit; pushed = $res.Pushed
            paths = @($landedPaths | Select-Object -First 500 | ForEach-Object { ConvertTo-MoeRootRelative $_ $Git.Rel })
            inferredPaths = @($inferredPaths | Select-Object -First 500 | ForEach-Object { ConvertTo-MoeRootRelative $_ $Git.Rel })
            touchedPaths = @($script:MoeToolWritten.Values | Select-Object -First 500 | ForEach-Object { ConvertTo-MoeRootRelative $_ $Git.Rel })
            unattributedPaths = $unattrRecPaths
            skipped = @(@(@($attr.Skipped | Where-Object { $_.Code -ne 'MOE_ATTR_EXCLUDED' }) + @($dropped) | Select-Object -First 100) | ForEach-Object { @{ path = (ConvertTo-MoeRootRelative $_.Path $Git.Rel); code = $_.Code } })
            contested = @(@($attr.Contested) | ForEach-Object { @{ path = (ConvertTo-MoeRootRelative $_.Path $Git.Rel); taskId = $_.TaskId } })
        }
        Send-MoeRecordCommit $recArgs | Out-Null
        return $res
    } catch {
        Write-Host "[WARN] landing failed for task ${TaskId}: $_ (line $($_.InvocationInfo.ScriptLineNumber)) — nothing committed by this attempt; baseline kept." -ForegroundColor Yellow
        $res.Outcome = 'failed'
        $res.Code = 'MOE_COMMIT_FAILED'
        return $res
    } finally {
        Remove-Item -LiteralPath $idx -Force -ErrorAction SilentlyContinue
        if ($msgFile) { Remove-Item -LiteralPath $msgFile -Force -ErrorAction SilentlyContinue }
        $ErrorActionPreference = $prev
    }
}

# Section 4 steps 1-3 (shared by the pre-flight and the idle paths): scope,
# DONE/ARCHIVED cleanup, recovery landing of a lingering baseline.
function Invoke-MoeRecoveryCheck([hashtable]$Git, [hashtable]$Settings, [string]$TaskId, [string]$Status, [string]$Title, [string]$Sid) {
    $out = @{ Scope = $null; Skip = $false; Recovered = $null }
    $scope = Get-MoeCommitScope $TaskId 'preflight' $Sid
    $out.Scope = $scope
    $baselinePath = Get-MoeBaselinePath $Git.GitDir $TaskId
    if (-not $scope.Found) {
        Write-Host "[WARN] task $TaskId not found by moe.get_commit_scope or on disk — dropping its baseline." -ForegroundColor Yellow
        Remove-MoeBaseline $baselinePath
        $out.Skip = $true
        return $out
    }
    if ($scope.Status -eq 'DONE' -or $scope.Status -eq 'ARCHIVED') {
        Remove-MoeBaseline $baselinePath
        $out.Skip = $true
        return $out
    }
    if (-not $Status -and $scope.Status) { $Status = $scope.Status }
    if (-not $Title -and $scope.Title) { $Title = $scope.Title }
    # A baseline whose header says landed=1 belongs to a session that finished
    # a landing (committed/nothing/refused); replaying a "recovered" checkpoint
    # from it would only re-land board-state noise on every poll.
    $blPrev = Read-MoeBaseline $baselinePath
    if ($blPrev -and -not $blPrev.Landed) {
        Write-Host "[attribution] a previous session of task $TaskId ended without landing (baseline present) — recovering its changes now." -ForegroundColor Yellow
        $rec = Invoke-MoeLanding -Kind 'checkpoint' -TaskId $TaskId -Git $Git -Settings $Settings -Title $Title -Status $Status -ReopenCount $scope.ReopenCount -CliExit 0 -Reason 'recovered' -Sid $Sid
        $out.Recovered = $rec
        if ($rec.Outcome -eq 'committed') {
            Write-Host "MOE_CHECKPOINT_RECOVERED task=$TaskId sha=$($rec.Sha)" -ForegroundColor Green
        }
    }
    return $out
}

# Section 4 in full: recovery, baseline merge, rescue-ref discovery and the
# shared-checkout notice. Returns the text to inject into the dynamic context.
function Invoke-MoePreflightBaseline([hashtable]$Git, [hashtable]$Settings, [string]$TaskId, [string]$Status, [string]$Title, [string]$Sid) {
    $result = @{ ContextText = ''; ForeignCount = 0; RescueRefs = @() }
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $chk = Invoke-MoeRecoveryCheck $Git $Settings $TaskId $Status $Title $Sid
        if ($chk.Skip) { return $result }
        $scope = $chk.Scope
        $baselinePath = Get-MoeBaselinePath $Git.GitDir $TaskId
        $bl = Read-MoeBaseline $baselinePath
        $sPre = Get-MoeDirtySnapshot $Git.Top
        if ($null -eq $sPre) {
            Write-Host "[WARN] git status failed at pre-flight; no baseline written for task $TaskId (measured attribution disabled for this session)." -ForegroundColor Yellow
            return $result
        }
        $rel = $Git.Rel
        $known = @{}
        foreach ($p in @($scope.Asserted) + @($scope.TouchedFiles) + @($scope.UnattributedPaths) + @($scope.InferredPaths)) {
            $tp = ConvertTo-MoeTopPath $p $rel
            if ($tp) { $known[(Get-MoePathKey $tp)] = $true }
        }
        $uLocal = @{}
        if ($bl) { $uLocal = $bl.U; foreach ($k in $bl.U.Keys) { $known[$k] = $true } }
        $B = @{}
        if ($null -eq $bl) {
            foreach ($k in $sPre.Keys) { $B[$k] = @{ Path = $sPre[$k].Path; Blob = $sPre[$k].Blob } }
        } else {
            foreach ($k in $bl.B.Keys) { if ($sPre.ContainsKey($k)) { $B[$k] = $bl.B[$k] } }
            foreach ($k in $sPre.Keys) {
                if (-not $B.ContainsKey($k) -and -not $known.ContainsKey($k)) {
                    # Inter-session dirt is presumed foreign.
                    $B[$k] = @{ Path = $sPre[$k].Path; Blob = $sPre[$k].Blob }
                }
            }
        }
        $head = ''
        $h = Invoke-MoeGit -Top $Git.Top -GitArgs @('rev-parse', '-q', '--verify', 'HEAD')
        if ($h.Rc -eq 0 -and $h.Out.Count -gt 0) { $head = ($h.Out -join '').Trim() }
        Write-MoeBaseline $baselinePath $TaskId $head $B $uLocal | Out-Null

        # K = dirty paths that are neither known-mine nor tool config / .moe.
        $foreign = 0
        foreach ($k in $sPre.Keys) {
            if ($known.ContainsKey($k)) { continue }
            if (Test-MoeDenyPath $sPre[$k].Path $sPre[$k].XY $rel $Settings) { continue }
            $foreign++
        }
        $result.ForeignCount = $foreign
        Write-Host "[attribution] baseline written for task ${TaskId}: $($B.Count) dirty path(s) recorded, $foreign foreign/pre-existing." -ForegroundColor Cyan

        # Rescue-ref discovery.
        $refs = @()
        $fe = Invoke-MoeGit -Top $Git.Top -GitArgs @('for-each-ref', '--format=%(refname:short) %(objectname:short) %(subject)', "refs/moe/rescue/$TaskId/")
        if ($fe.Rc -eq 0) { $refs = @($fe.Out | Where-Object { $_ -and $_.Trim() }) }
        $result.RescueRefs = $refs
        $text = ''
        if ($refs.Count -gt 0) {
            Write-Host "[rescue] $($refs.Count) rescue ref(s) for task ${TaskId}:" -ForegroundColor Yellow
            foreach ($r in $refs) { Write-Host "  $r" -ForegroundColor Yellow }
            $refNames = @($refs | ForEach-Object { ($_ -split ' ')[0] })
            $text += "`n`nEarlier sessions of this task left rescue checkpoints: $($refNames -join ', '). Recover with `git show <ref> --stat` / `git checkout <ref> -- <path>` before redoing work."
        }
        $text += "`n`nThis checkout is shared. $foreign dirty path(s) belong to other sessions or are pre-existing debris. Never revert, stash, `git add -A`, or commit them, and never treat them as a stop condition — note them in your step note and continue. Report every path you create or modify in `complete_step.modifiedFiles`. A prerequisite task has landed iff `get_context.epicSiblings[*].landing.merged` is true or `git log <branch> --grep 'Moe-Task: <sibling>'` finds it. BLOCKED is a wait state, never a terminal — delivered work goes through `complete_task`."
        $result.ContextText = $text
        return $result
    } catch {
        Write-Host "[WARN] pre-flight baseline failed for task ${TaskId}: $_" -ForegroundColor Yellow
        return $result
    } finally {
        $ErrorActionPreference = $prev
    }
}

# Idle paths (BLOCKED hold, resume cap): land a lingering baseline for the held
# task without launching a CLI.
function Invoke-MoeIdleRecovery([string]$TaskId, [string]$Status) {
    if (-not $TaskId) { return }
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $settings = Read-MoeCommitSettings
        if (-not $settings.autoCommit) { return }
        $git = Get-MoeGitTop
        if ($null -eq $git) { return }
        $baselinePath = Get-MoeBaselinePath $git.GitDir $TaskId
        if (-not $baselinePath -or -not (Test-Path -LiteralPath $baselinePath)) { return }
        $sid = "$WorkerId@" + (Get-Date).ToUniversalTime().ToString("yyyy-MM-dd'T'HH:mm:ss'Z'")
        Invoke-MoeRecoveryCheck $git $settings $TaskId $Status '' $sid | Out-Null
    } catch {
        Write-Host "[WARN] idle-path recovery failed for task ${TaskId}: $_" -ForegroundColor Yellow
    } finally {
        $ErrorActionPreference = $prev
    }
}

# Section 5 row C1: best-effort rescue ref from the outer finally when a
# session tears down (Ctrl+C, terminating error, exit 1) before its
# post-flight landed. Idempotent; the baseline stays so the next session's
# pre-flight lands the work on the branch.
function Invoke-MoeTeardownRescue {
    if ($script:MoeTeardownDone) { return }
    $script:MoeTeardownDone = $true
    try {
        if (-not $preflightTaskId -or $moeLandingDone) { return }
        if ($null -eq $moeGit -or $null -eq $moeSettings) { return }
        if (-not $moeSettings.autoCommit) { return }
        $baselinePath = Get-MoeBaselinePath $moeGit.GitDir $preflightTaskId
        if (-not $baselinePath -or -not (Test-Path -LiteralPath $baselinePath)) { return }
        Write-Host "[rescue] session ended before landing task $preflightTaskId — parking its changes on a rescue ref." -ForegroundColor Yellow
        Invoke-MoeRescueRef -Git $moeGit -TaskId $preflightTaskId -Reason 'teardown' -Title $preflightTaskTitle -Status '' -Sid $moeSid | Out-Null
    } catch {}
}

# Stream-json harvest (claude only): record the paths the CLI's tools wrote.
function Add-MoeToolWrittenPath([string]$ToolName, $ToolInput) {
    if (-not $ToolName -or $null -eq $ToolInput) { return }
    if ($null -eq $moeGit) { return }
    $paths = @()
    $kind = ''
    if ($ToolName -match '^(Edit|Write|MultiEdit|NotebookEdit)$') {
        $kind = 'abs'
        foreach ($k in @('file_path', 'notebook_path')) { $v = Get-MoeProp $ToolInput $k; if ($v -is [string] -and $v) { $paths += $v } }
    } elseif ($ToolName -match '(^|__)(replace_symbol_body|insert_after_symbol|insert_before_symbol|create_text_file|replace_regex)$') {
        $kind = 'serena'
        $v = Get-MoeProp $ToolInput 'relative_path'; if ($v -is [string] -and $v) { $paths += $v }
    } elseif ($ToolName -match '(^|__)(moe_)?complete_step$') {
        $kind = 'root'
        $paths = @(Get-MoeStringList (Get-MoeProp $ToolInput 'modifiedFiles'))
    } else {
        return
    }
    foreach ($p in $paths) {
        $tp = ''
        if (Test-MoeAbsolutePath $p) {
            $tp = ConvertTo-MoeTopPathFromAbsolute $p $moeGit.Top
        } elseif ($kind -eq 'root') {
            $tp = ConvertTo-MoeTopPath $p $moeGit.Rel
        } elseif ($kind -eq 'serena') {
            $tp = ConvertTo-MoeTopPathFromAbsolute (Join-Path $serenaProject $p) $moeGit.Top
        }
        if (-not $tp) {
            Write-Host "  [attribution] tool path outside the repo dropped: $p" -ForegroundColor DarkYellow
            continue
        }
        $script:MoeToolWritten[(Get-MoePathKey $tp)] = $tp
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
if ($cliType -eq "grok") {
    if ($grokInteractive) {
        Write-Host "Grok mode: interactive"
    } else {
        Write-Host "Grok mode: headless (--prompt-file --yolo)"
    }
}
$loopEnabled = (($AutoClaim -or $Loop) -and (-not $NoLoop) -and ($PollInterval -gt 0))
if ($codexInteractive -or $geminiInteractive -or $grokInteractive) {
    # Codex / Gemini / Grok TUIs hold a single long-lived REPL session — looping them
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

# Build base system/role context (static across iterations; the role doc is
# re-read each iteration inside the loop so daemon-side upgrades land on the
# next task spawn; per-iteration pre-flight is appended inside the loop)
$systemAppendPre = "Role: $Role. Always use Moe MCP tools. "
if ($AutoClaim) {
    $systemAppendPre += "Start by claiming the next task for your role."
}
# Tool-name mapping, stated once in the stable (cache-friendly) prefix: role
# docs and prompts write moe.<name> as shorthand, but the wire-level MCP tool
# is moe_<name> on the server named "moe" — without this line every fresh
# per-task session burns a discovery round-trip re-learning the prefix.
$systemAppendPre += "`n`nTool naming: moe.<name> in docs/prompts is shorthand for MCP tool moe_<name> on the server named 'moe' (Claude Code exposes it as mcp__moe__moe_<name>, e.g. moe.submit_plan -> mcp__moe__moe_submit_plan). Serena tools are on the server named 'serena'. If tool schemas are deferred, batch-load every tool you need in ONE ToolSearch select call - do not guess tool names."
if ($cliType -eq "grok") {
    # Grok never lists MCP tools directly: they are reached through its
    # search_tool/use_tool dispatchers under <server>__<tool> names.
    $systemAppendPre += "`nGrok: MCP tools are not in your direct tool list - discover them with search_tool and call them with use_tool using the qualified name moe__moe_<name> (e.g. use_tool 'moe__moe_submit_plan'); Serena tools are serena__<tool>."
}
if ($approvalMode) {
    $systemAppendPre += "`n`n# Project Settings`nApproval mode: $approvalMode"
}
# The daemon surfaces a phase-recommended skill via nextAction.recommendedSkill
# on every MCP response. Full manifest is on disk at .moe/skills/manifest.json
# if the agent ever needs to browse what's available; we don't dump it into
# the prompt every turn.
$systemAppendPost = ""
if ($knownIssues) {
    $systemAppendPost += "`n`n# Known Issues`n$knownIssues"
}
if ($teamContext) {
    $systemAppendPost += "`n`n# Team`n$teamContext"
}

# Consecutive-resume tracking for the alreadyAssigned resume path (pre-flight
# below). Wrapper-scope: survives loop iterations, resets whenever the held
# task changes or clears. MOE_RESUME_MAX_ATTEMPTS caps how many fresh CLIs we
# relaunch onto the same still-assigned task before escalating to #general and
# idling — a CLI that keeps dying on one task should page the governor, not
# burn sessions forever.
$script:ResumeTrackTaskId = ""
$script:ResumeAttempts = 0
$script:ResumeEscalated = $false
$resumeMaxAttempts = 5
if ($env:MOE_RESUME_MAX_ATTEMPTS -match '^\d+$') { $resumeMaxAttempts = [int]$env:MOE_RESUME_MAX_ATTEMPTS }

# --- Self-restart when this script's own bytes change on disk -----------------
# PowerShell parses the ENTIRE script at process start, so a long-lived polling
# loop executes its ORIGINAL bytes for its whole life. A fix can therefore be
# correct, installed, and still unreachable for days. Measured 2026-08-18
# (task-965c37da): four whole-tree commits -- 9b9e44e, 76e7396, 39a1b2c and
# ceb0370, the last of which captured a peer's live mutation drill into HEAD --
# were produced by wrappers launched BEFORE the pathspec fix landed at 06:26:51,
# while every copy on disk already carried the fix.
#
# The hash is captured ONCE, here, so one on-disk change triggers exactly one
# restart: the relaunched process captures the new hash and cannot thrash if the
# file is touched again mid-flight.
$script:MoeWrapperPath = $PSCommandPath
$script:MoeWrapperLaunchHash = $null
$script:MoeWrapperHostExe = $null
$script:MoeWrapperRelaunchArgs = @()
try {
    if ($script:MoeWrapperPath -and (Test-Path -LiteralPath $script:MoeWrapperPath)) {
        $script:MoeWrapperLaunchHash =
            (Get-FileHash -Algorithm SHA256 -LiteralPath $script:MoeWrapperPath).Hash
        $script:MoeWrapperHostExe = (Get-Process -Id $PID).Path
        $script:MoeWrapperRelaunchArgs = @([Environment]::GetCommandLineArgs() | Select-Object -Skip 1)
    }
} catch {
    # FAIL-OPEN. A wrapper that dies because it could not stat itself is a fleet
    # outage; a stale wrapper is merely the status quo this guard improves on.
    $script:MoeWrapperLaunchHash = $null
}

try {
do {
    if (-not $firstRun) {
        Write-Host ""
        Write-Host "Agent idle, checking for tasks in ${PollInterval} seconds... (Ctrl+C to stop)"
        Start-Sleep -Seconds $PollInterval
        Write-Host "Relaunching agent..."
    }

    # Top of the iteration, AFTER the poll sleep and BEFORE any task dispatch, so
    # a restart can never interleave with a half-done completion.
    if ($script:MoeWrapperLaunchHash) {
        $moeCurrentHash = $null
        try {
            $moeCurrentHash =
                (Get-FileHash -Algorithm SHA256 -LiteralPath $script:MoeWrapperPath).Hash
        } catch {
            $moeCurrentHash = $null   # FAIL-OPEN: keep running the current bytes
        }
        if ($moeCurrentHash -and $moeCurrentHash -ne $script:MoeWrapperLaunchHash) {
            Write-Host "wrapper source changed on disk; restarting to load it"
            try {
                Start-Process -FilePath $script:MoeWrapperHostExe -ArgumentList $script:MoeWrapperRelaunchArgs -WorkingDirectory (Get-Location).Path | Out-Null
            } catch {
                Write-Host "wrapper relaunch failed; continuing on current bytes"
            }
            break
        }
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
    $preflightIsResume = $false
    $preflightRoutedMentions = @()
    # Land-on-every-exit state. Reset per iteration so nothing leaks across
    # tasks: the session id, the repo probe, the baseline path, the
    # "bytes handled" flag the teardown rescue keys on, and the stream-json
    # tool-write harvest.
    $moeSid = ""
    $moeGit = $null
    $moeSettings = $null
    $moeBaselinePath = ""
    $moeLandingDone = $false
    $moeStopLoop = $false
    $script:MoeToolWritten = @{}
    $script:MoeLastLanding = $null

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
            # Resume signal: hasNext:false + alreadyAssigned means THIS worker
            # still holds an active task from a previous CLI session that died
            # mid-task (one-shot --print exits at end_turn; crashes land here
            # too). Treat it as a claim and relaunch the CLI onto the held task.
            # Ignoring it strands the task: it is never claimable by anyone else
            # while this wrapper's polling keeps the worker record alive, and
            # the wrapper would idle-loop on "No claimable task" forever.
            $resumeInfo = $null
            if (-not $claim.hasNext -and $claim.PSObject.Properties['alreadyAssigned'] -and $claim.alreadyAssigned -and $claim.alreadyAssigned.taskId) {
                $resumeInfo = $claim.alreadyAssigned
            }
            # BLOCKED hold: the daemon parked this worker's task via
            # moe.report_blocked while it waits on a shared-resource lease,
            # and the grant path will auto-flip it back to its pre-block
            # status (returning it to THIS parked worker by design). With
            # daemon seat-freeing, an assignee-reported non-resource
            # report_blocked releases the seat instead (task
            # BLOCKED-unassigned, worker IDLE claims other work), so
            # alreadyAssigned{status:BLOCKED} now happens only for resource
            # blocks and third-party (workerId-less) blocks on an assigned
            # task. Relaunching a CLI onto it is pure waste — nothing can be
            # done until the lease is granted / a human clears it — and every
            # relaunch would burn one of the MOE_RESUME_MAX_ATTEMPTS budget.
            # Suppress the resume entirely (no chat escalation: a BLOCKED
            # hold is expected daemon state, not a dying CLI) and clear the
            # tracker so the eventual unblock starts the resume path fresh
            # with its full attempt budget.
            if ($resumeInfo -and $resumeInfo.PSObject.Properties['status'] -and [string]$resumeInfo.status -eq 'BLOCKED') {
                $blockedDetail = "no reason given"
                if ($resumeInfo.PSObject.Properties['blockedResourceId'] -and $resumeInfo.blockedResourceId) {
                    $blockedDetail = "resource $($resumeInfo.blockedResourceId)"
                } elseif ($resumeInfo.PSObject.Properties['blockedReason'] -and $resumeInfo.blockedReason) {
                    $blockedDetail = [string]$resumeInfo.blockedReason
                }
                Write-Host "[blocked] $($resumeInfo.taskId) is BLOCKED ($blockedDetail) — suppressing auto-resume; only resource-lease waits and third-party blocks hold a seat now (an assignee-reported non-resource block frees it), so idling until the daemon un-blocks it." -ForegroundColor DarkYellow
                # The session that called report_blocked may have left its
                # edits uncommitted (a lingering baseline says so): land them
                # now so a BLOCKED task's files reach the branch with no CLI.
                Invoke-MoeIdleRecovery ([string]$resumeInfo.taskId) 'BLOCKED'
                $script:ResumeTrackTaskId = ""
                $script:ResumeAttempts = 0
                $script:ResumeEscalated = $false
                $resumeInfo = $null
            }
            if ($resumeInfo) {
                if ($script:ResumeTrackTaskId -ne [string]$resumeInfo.taskId) {
                    $script:ResumeTrackTaskId = [string]$resumeInfo.taskId
                    $script:ResumeAttempts = 0
                    $script:ResumeEscalated = $false
                }
                $script:ResumeAttempts++
                if ($script:ResumeAttempts -gt $resumeMaxAttempts) {
                    # The CLI keeps dying on this task without finishing it.
                    # Stop burning sessions: escalate once to #general (governor
                    # or human can release_task / investigate) and idle. First
                    # land whatever the dying sessions left behind (lingering
                    # baseline) so the escalation points at committed work.
                    $resumeStatusForRecovery = if ($resumeInfo.PSObject.Properties['status']) { [string]$resumeInfo.status } else { "" }
                    Invoke-MoeIdleRecovery ([string]$resumeInfo.taskId) $resumeStatusForRecovery
                    if (-not $script:ResumeEscalated -and $generalChannelId) {
                        $resumeStatusForMsg = if ($resumeInfo.PSObject.Properties['status']) { [string]$resumeInfo.status } else { "?" }
                        $escalation = "@governors ${WorkerId}: CLI session ended $($script:ResumeAttempts - 1) times in a row while still holding $($resumeInfo.taskId) ($resumeStatusForMsg); wrapper is pausing auto-resume. release_task to reassign, or investigate why sessions keep dying mid-task."
                        Invoke-MoeRpc -Tool "chat_send" -Args @{ channel = $generalChannelId; workerId = $WorkerId; content = $escalation } | Out-Null
                        $script:ResumeEscalated = $true
                    }
                    Write-Host "[resume] Auto-resume cap reached ($resumeMaxAttempts) for $($resumeInfo.taskId) — escalated to #general; idling until released." -ForegroundColor Red
                    $resumeInfo = $null
                }
            } else {
                # No held task this iteration — clear the consecutive-resume tracker.
                $script:ResumeTrackTaskId = ""
                $script:ResumeAttempts = 0
                $script:ResumeEscalated = $false
            }

            # Worker is registered by team-setup join_team (above) when teams are
            # enabled, and re-registered by claim_next_task on a successful claim.
            # If both were skipped (no team + no claim), chat_send would fail with
            # "Unknown sender" — the caller is expected to have completed team setup.
            # Announce "online" only on the first iteration of the wrapper loop.
            # Per-task starts/completions are conveyed by post-flight session-end
            # messages and the daemon's task-state events.
            if ($generalChannelId -and $isFirstIteration) {
                $announceText = if ($claim.hasNext) { "$Role online, starting $($claim.task.id): $($claim.task.title)" } elseif ($resumeInfo) { "$Role online, resuming held task $($resumeInfo.taskId)" } else { "$Role online, waiting for tasks" }
                Invoke-MoeRpc -Tool "chat_send" -Args @{ channel = $generalChannelId; workerId = $WorkerId; content = $announceText } | Out-Null
            }
            if ($claim.hasNext -or $resumeInfo) {
                if ($claim.hasNext) {
                    $preflightTaskId = $claim.task.id
                    $preflightTaskTitle = $claim.task.title
                    if ($claim.task.PSObject.Properties['chatChannel']) { $preflightTaskChannel = $claim.task.chatChannel }
                } else {
                    $preflightIsResume = $true
                    $preflightTaskId = [string]$resumeInfo.taskId
                    if ($resumeInfo.PSObject.Properties['title'] -and $resumeInfo.title) { $preflightTaskTitle = [string]$resumeInfo.title }
                    $resumeStatus = if ($resumeInfo.PSObject.Properties['status']) { [string]$resumeInfo.status } else { "?" }
                    Write-Host "[resume] $WorkerId already holds $preflightTaskId ($resumeStatus) from a previous session (attempt $($script:ResumeAttempts)/$resumeMaxAttempts) — relaunching CLI to resume it." -ForegroundColor Yellow
                }

                if ($preflightTaskId) {
                    $preflightContext = Invoke-MoeRpc -Tool "get_context" -Args @{ taskId = $preflightTaskId }
                }
                # alreadyAssigned carries no chatChannel — recover it from the
                # fetched context on the resume path.
                if (-not $preflightTaskChannel -and $preflightContext -and $preflightContext.task -and $preflightContext.task.PSObject.Properties['chatChannel'] -and $preflightContext.task.chatChannel) {
                    $preflightTaskChannel = [string]$preflightContext.task.chatChannel
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
                $preflightVerb = if ($preflightIsResume) { "Resuming" } else { "Claimed" }
                Write-Host "[OK] Pre-flight complete. ${preflightVerb}: $preflightTaskId ($preflightTaskTitle)" -ForegroundColor Green
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
        # Whole extraction is guarded: a throw here used to leave the block
        # simply absent, which reads to the recipient as "nobody tagged you".
        # Fail CLOSED instead -- one marker entry saying delivery broke.
        try {
            $script:MoeMentionStoreCache = @{}
            $seenMentionIds = @{}
            foreach ($bucket in $buckets) {
                foreach ($msg in $bucket) {
                    if (-not $msg -or -not $msg.mentions) { continue }
                    if ($msg.id -and $seenMentionIds.ContainsKey([string]$msg.id)) { continue }
                    $hit = $false
                    foreach ($m in $msg.mentions) {
                        if ($m -eq $WorkerId) { $hit = $true; break }
                        if ($m -eq "all") { $hit = $true; break }
                        if ($roleGroupTag -and $m -eq $roleGroupTag) { $hit = $true; break }
                    }
                    if ($hit) {
                        $preflightRoutedMentions += (New-MoeVerifiedMention -ProjectPath $projectPath -Message $msg)
                        if ($msg.id) { $seenMentionIds[[string]$msg.id] = $true }
                    }
                }
            }
        } catch {
            Write-Host "[WARN] MOE_MENTION_EXTRACTION_FAILED: $_" -ForegroundColor Yellow
            $preflightRoutedMentions = @(New-MoeMentionFailure -Reason 'MOE_MENTION_EXTRACTION_FAILED')
        }
        $diverged = @($preflightRoutedMentions | Where-Object { $_.provenance -ne 'VERIFIED' -and $_.provenance -ne 'VERIFIED_RPC_TRUNCATED' })
        if ($diverged.Count -gt 0) {
            Write-Host "[mention] $($diverged.Count) mention(s) failed provenance: $(($diverged | ForEach-Object { $_.provenance }) -join ', ')" -ForegroundColor Yellow
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
    # NOT appended to the system prompt. The role doc re-read below keeps
    # identical bytes while .moe/roles/ is unchanged, so the cache still hits.
    $roleDoc = Get-RoleDoc
    $systemAppend = $systemAppendPre
    if ($roleDoc) {
        $systemAppend += "`n`n$roleDoc"
    }
    $systemAppend += $systemAppendPost
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

        # Bounded Serena memory-name preload, read straight off disk (no Serena
        # call). The corpus grows unbounded on long-running projects (1700+
        # files observed), so never inline the full list: total count, names
        # containing THIS task id (prior handoffs), and the 20 most recently
        # updated. Names only — the agent pulls content via Serena read_memory.
        $memoriesDir = Join-Path $serenaProject ".serena/memories"
        $memTotal = 0
        $memTaskNames = @()
        $memRecentNames = @()
        if (Test-Path $memoriesDir) {
            $memFiles = @(Get-ChildItem -Path $memoriesDir -Filter *.md -File -ErrorAction SilentlyContinue)
            $memTotal = $memFiles.Count
            if ($memTotal -gt 0) {
                if ($preflightTaskId) {
                    $memTaskNames = @($memFiles | Where-Object { $_.BaseName -like "*$preflightTaskId*" } | ForEach-Object { $_.BaseName })
                }
                $memRecentNames = @($memFiles | Sort-Object LastWriteTime -Descending | Select-Object -First 20 | ForEach-Object { $_.BaseName })
            }
        }
        $memTaskLine = if ($memTaskNames.Count -gt 0) { $memTaskNames -join " " } else { "none" }
        $memRecentLine = if ($memRecentNames.Count -gt 0) { $memRecentNames -join " " } else { "none" }

        $dynamicContext += @"
# Pre-flight Complete (runtime-injected — do not repeat)
You ARE: $Role agent, workerId=$WorkerId.
The wrapper has claimed your task and surfaced unread counts in <inbox> below. Fetch the full content via moe.chat_read when it is relevant; prior-knowledge memory names are preloaded in <inbox> - read the relevant ones via Serena read_memory. Routed mentions tagging you are listed verbatim further down — those are mandatory replies before any other planned tool call.

DO NOT re-call at session start: moe.chat_join, moe.claim_next_task, moe.get_context. They are done.

Claimed task id: $preflightTaskId

<claimed_task_context>
$ctxJson
</claimed_task_context>

<inbox>
unread_general=$generalCount
unread_task=$taskCount
mentions=$mentionsCount (see <routed_mentions> below if > 0)
memory_total=$memTotal Serena memories (content via read_memory; names below are preloaded from disk - call list_memories only if they don't cover your area)
memory_this_task=$memTaskLine
memory_recent=$memRecentLine
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
    } elseif ($preflightNoTask -and $Role -eq 'governor') {
        # Governors never claim, so $statusMap gives them @() and "no claimable
        # task" is their NORMAL state, not a stall. The generic branch below
        # would render `statuses=` (an empty array pipes zero objects into
        # ConvertTo-Json, which then emits nothing), and moe.wait_for_task
        # refuses that with [MISSING_REQUIRED] — so a governor's mandated FIRST
        # action failed, and it contradicted the governance $claimPromptBody
        # this same pre-flight sets. Point them at the governance loop instead.
        $dynamicContext += @"
# Pre-flight Complete: governance mode
The daemon reports no claimable task. For role governor that is the NORMAL state — you do not claim tasks, and there is nothing wrong with the board.
moe.enter_governance has already been called for you by the wrapper.
Do NOT call moe.wait_for_task (it has no status filter for your role and will refuse) and do NOT call moe.claim_next_task.
Your FIRST action is to read the backlog, then enter the moe.chat_wait loop with workerId=$WorkerId and a long timeout, exactly as the governance instructions below describe.
"@
    } elseif ($preflightNoTask) {
        $dynamicContext += @"
# Pre-flight Complete: no claimable task
The daemon reports no claimable task for role $Role right now.
Your FIRST action MUST be moe.wait_for_task with statuses=$(ConvertTo-Json @($statuses) -Compress), workerId=$WorkerId.
When it returns hasNext:true, call moe.claim_next_task, then moe.get_context.
If moe.wait_for_task returns hasChatMessage:true, your NEXT calls MUST be moe.chat_read on chatMessage.channel, then moe.chat_send with your reply, THEN moe.wait_for_task again. Do not claim a new task while a routed mention is unanswered.
"@
    }

    # -------- Pre-flight baseline (land-on-every-exit) --------
    # The task is known and nothing has run yet: this is the single point
    # (ahead of all three CLI launch sites) where the working tree can be
    # snapshotted as "dirty BEFORE this session". It sits here rather than
    # right before the launch because the rescue-ref and shared-checkout
    # notices must reach $dynamicContext before the instruction files and
    # $claimPrompt are assembled below. Recovery of a lingering baseline
    # (a previous session that never landed) happens here too.
    if ($AutoClaim -and $preflightOk -and $preflightTaskId) {
        $moeSettings = Read-MoeCommitSettings
        if ($moeSettings.autoCommit) {
            $moeGit = Get-MoeGitTop
            if ($null -eq $moeGit) {
                Write-Host "[info] $projectPath is not a git repo — no baseline, no auto-commit." -ForegroundColor Cyan
            } else {
                $moeSid = "$WorkerId@" + (Get-Date).ToUniversalTime().ToString("yyyy-MM-dd'T'HH:mm:ss'Z'")
                $moeBaselinePath = Get-MoeBaselinePath $moeGit.GitDir $preflightTaskId
                $moeClaimStatus = ""
                if ($preflightContext -and $preflightContext.task -and $preflightContext.task.PSObject.Properties['status']) {
                    $moeClaimStatus = [string]$preflightContext.task.status
                } elseif ($preflightIsResume -and $resumeInfo -and $resumeInfo.PSObject.Properties['status']) {
                    $moeClaimStatus = [string]$resumeInfo.status
                } elseif ($claim -and $claim.hasNext -and $claim.task.PSObject.Properties['status']) {
                    $moeClaimStatus = [string]$claim.task.status
                }
                $moePre = Invoke-MoePreflightBaseline $moeGit $moeSettings $preflightTaskId $moeClaimStatus $preflightTaskTitle $moeSid
                if ($moePre.ContextText -and $dynamicContext) {
                    $dynamicContext += $moePre.ContextText
                }
            }
        } else {
            Write-Host "[info] settings.autoCommit=false — no baseline, no git activity this session." -ForegroundColor Cyan
        }
    }
    # -------- End pre-flight baseline --------

    # Priority banner for unread messages routed at THIS worker. Goes LAST in
    # the dynamic context so it's the most recent text before the role-specific
    # claimPrompt — maximizes the chance the model replies before any other
    # planned tool call. Role docs back this up with the Mention Response
    # Protocol section.
    if ($preflightRoutedMentions -and $preflightRoutedMentions.Count -gt 0) {
        $mentionsJson = $preflightRoutedMentions | ConvertTo-Json -Depth 8 -Compress
        # PowerShell 5.1 unwraps a one-element array into a bare object, so a
        # single routed mention would arrive with a different shape than two.
        # -AsArray does not exist before PS6; re-wrap by hand.
        if ($preflightRoutedMentions.Count -eq 1 -and -not $mentionsJson.StartsWith('[')) {
            $mentionsJson = "[$mentionsJson]"
        }
        $mentionsJson = ConvertTo-MoeFencedJson $mentionsJson
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
    # Grok is handled in its launch branch below: its prompt file must also carry the final role
    # directive ($claimPromptBody, built after this block), so it is written right before the launch.
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
            "architect" { "Task $preflightTaskId is claimed and its full context is above (<claimed_task_context>). If a <routed_mentions> block is present, reply to each tagged message via moe.chat_send FIRST. Read prior knowledge via Serena read_memory on the memory names preloaded in <inbox> (call list_memories only if they don't cover your area). Then study the implementationPlan, rails, and definitionOfDone, and call moe.submit_plan with a complete plan. Before you STOP, use Serena write_memory to record a 'task-$preflightTaskId-handoff' note (and any reusable 'decision-<area>' learnings). Then output a one-line text summary of what you planned and STOP. Do NOT poll moe.check_approval — approval is a human gate; the wrapper will respawn you on the next PLANNING task. Do NOT call moe.wait_for_task — the wrapper handles polling between sessions." }
            "worker"    { "Task $preflightTaskId is claimed and its full context is above (<claimed_task_context>). If a <routed_mentions> block is present, reply to each tagged message via moe.chat_send FIRST. Read prior knowledge via Serena read_memory on the memory names preloaded in <inbox> (call list_memories only if they don't cover your area). Then execute the approved implementationPlan: call moe.start_step for step 0, implement it (write/edit code, run tests), call moe.complete_step, and repeat through the final step. Then call moe.complete_task. Before you STOP, use Serena write_memory to record a 'task-$preflightTaskId-handoff' note plus any non-obvious 'gotcha-<area>' learnings. Then output a one-line text summary and STOP. Do NOT call moe.wait_for_task — the wrapper will pick up the next task in a fresh session." }
            "qa"        { "Task $preflightTaskId is claimed and its full context is above (<claimed_task_context>). If a <routed_mentions> block is present, reply to each tagged message via moe.chat_send FIRST. Read prior knowledge via Serena read_memory on the memory names preloaded in <inbox> (call list_memories only if they don't cover your area). Then verify the implementation against definitionOfDone and rails. Run the tests. If it passes, call moe.qa_approve. If it fails, call moe.qa_reject with a detailed list of issues. Before you STOP, use Serena write_memory to record a 'task-$preflightTaskId-handoff' note (and any 'gotcha-<area>' failure pattern). Then output a one-line text summary and STOP. Do NOT call moe.wait_for_task — the wrapper will pick up the next task in a fresh session." }
        }
        if ($claimPromptBody -and $preflightIsResume) {
            # A previous CLI session died while holding this task (see the
            # resume path in pre-flight). Tell the fresh session to treat that
            # session's in-flight state as untrusted and finish the job.
            $claimPromptBody = "RESUME: you are workerId $WorkerId and you already claimed task $preflightTaskId in a previous CLI session that ended before the task was finished. Anything that session left running (background builds, tests, jobs) is DEAD. Do not trust its in-flight claims: re-verify current state from the task context above, the files on disk, and git, then finish the remaining work in THIS session. " + $claimPromptBody
        }
    } elseif ($AutoClaim -and $Role -eq 'governor') {
        # Governor enters governance mode and lives in a chat_wait loop on
        # #governors. They never claim tasks. The wrapper has already called
        # moe.enter_governance; the agent now subscribes to channel signals.
        $claimPromptBody = "You are in governance mode. Read the backlog: moe.chat_channels, find #governors, moe.chat_read it (last 50 messages), then moe.chat_read #general. After catching up, enter the loop: moe.chat_wait with channels=['#governors','#general'] and a long timeout. When it wakes, triage per docs/roles/governor.md (the role doc is appended to your system prompt). Reply via moe.chat_send. Use moe.set_task_status, moe.release_task, moe.propose_rail, or moe.submit_plan_critique when the signal calls for action. On stale-worker alerts: quiet is not dead (long builds/tests are silent) — ping the worker first and NEVER call moe.release_task on idle time alone; release needs a confirmed crash plus the human's nod. Loop forever. Do NOT call moe.claim_next_task."
    } elseif ($AutoClaim -and $preflightNoTask) {
        # No-task case: wrapper's outer loop handles the poll/sleep cycle at the
        # PowerShell level, so we don't launch the CLI just to call wait_for_task.
        # $claimPromptBody stays $null → branch below skips the CLI invocation.
        $claimPromptBody = $null
    } elseif ($AutoClaim) {
        # Pre-flight skipped or failed — legacy multi-step prompt
        $claimPromptBody = "First call moe.chat_channels to find #general, then moe.chat_join and moe.chat_send to announce yourself as $Role. Then call moe.chat_read to catch up on any unread messages. Then call moe.claim_next_task $claimJson. After claiming a task and calling moe.get_context, use Serena list_memories / read_memory to pick up prior knowledge for this task/area. Before calling moe.wait_for_task, use Serena write_memory to record a 'task-<id>-handoff' note (and any gotcha-<area> learnings) so the next agent benefits. If hasNext is false, say: 'No tasks in $Role queue' and wait."
    }

    # One-shot (--print) sessions exit the moment the model ends its turn,
    # killing any background jobs with the process. Observed failure mode: QA
    # agents started a background build gate, ended the turn "to wait for its
    # completion notification", and died mid-review — the notification can
    # never arrive in --print mode. Say so explicitly in the prompt. Governor
    # is excluded: its prompt is a chat_wait loop, not a finish-and-stop task.
    # Headless polarity: claude keys on -not $Interactive; grok's headless is
    # -not $grokInteractive (an architect launched with -GrokExec is one-shot
    # too), matching the sh twin's GROK_INTERACTIVE gate.
    $oneShotSession = if ($cliType -eq 'grok') { -not $grokInteractive } else { -not $Interactive }
    if ($claimPromptBody -and $oneShotSession -and $Role -ne 'governor') {
        $claimPromptBody += " CRITICAL (one-shot session): this CLI process exits the moment you end your turn, and any background jobs/builds/tests die with it — a completion notification can NEVER arrive after you stop. Never end your turn to 'wait for' a background task: run it in the foreground or poll it to completion first. End your turn only after your terminal moe.* call for this task (submit_plan / complete_task / qa_approve / qa_reject / report_blocked) has succeeded."
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
            # includes $dynamicContext (see $codexUsesFileContext branch above), argv carries ONLY
            # a short quote-free directive — PS < 7.3 forwards native args without escaping embedded
            # double quotes, so any raw task JSON or chat text on argv word-splits the prompt
            # (codex: "unrecognized subcommand"). This must hold even when $claimPromptBody is null
            # (no-task-with-mentions pre-flight): never fall back to $claimPrompt here, because that
            # IS the dynamic context (routed mention text = arbitrary quotes) that just crashed on argv.
            if ($codexUsesFileContext) {
                if ($claimPromptBody) {
                    $shortPrompt = $claimPromptBody
                } else {
                    $shortPrompt = "Session context (routed mentions, pre-flight data) is in .codex/agent-instructions.md - read it. If a routed_mentions block is present, reply to each tagged message via moe.chat_send as workerId $WorkerId. Then follow your role doc."
                }
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
                # Quote-free claim args (NOT $claimJson): embedded JSON double quotes word-split
                # native argv on PS < 7.3.
                $shortPrompt = "You are a $Role agent. Use ONLY Moe MCP tools (moe.*). $roleWorkflow. First: join #general via moe.chat_channels, moe.chat_join, and moe.chat_send. Then moe.chat_read to catch up on messages. Then call moe.claim_next_task with statuses [$($statuses -join ', ')] and workerId $WorkerId. If hasNext is false, say 'No tasks' and stop."
            } else {
                $shortPrompt = "You are a $Role agent. Use ONLY Moe MCP tools (moe.*). $roleWorkflow. First: join #general via moe.chat_channels, moe.chat_join, and moe.chat_send. Then moe.chat_read to catch up on messages. Then call moe.claim_next_task to get your next task."
            }
        }

        # Last-resort argv guard: PS < 7.3 forwards native args without escaping embedded
        # double quotes, so any that survive the routing above would word-split the prompt
        # and codex would parse a fragment as a subcommand. Prose survives the swap fine.
        if ($shortPrompt -and $PSVersionTable.PSVersion -lt [version]'7.3') {
            $shortPrompt = $shortPrompt -replace '"', "'"
        }

        # Heartbeat sidecar: the CLI call below blocks this wrapper for its whole
        # runtime with zero interleaved moe.* activity — without the sidecar a
        # long silent local step outlasts reviewStaleTimeoutMs and the REVIEW
        # self-heal steals the task from a live session (the bash wrapper starts
        # it for all CLIs; this must match).
        Start-HeartbeatSidecar -ProxyScript $proxyScript -ProjectPath $projectPath -WorkerId $WorkerId | Out-Null
        try {
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
        } finally {
            Stop-HeartbeatSidecar
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
            # $dynamicContext (see $geminiUsesFileContext branch above), argv carries ONLY a short
            # quote-free directive — PS < 7.3 forwards native args without escaping embedded double
            # quotes, so raw task JSON or chat text on argv word-splits the prompt. Never fall back
            # to $claimPrompt when the file holds the context (even with a null $claimPromptBody —
            # the no-task-with-mentions case): $claimPrompt IS that context.
            if ($geminiUsesFileContext) {
                if ($claimPromptBody) {
                    $shortPrompt = $claimPromptBody
                } else {
                    $shortPrompt = "Session context (routed mentions, pre-flight data) is in .gemini/GEMINI.md - read it. If a routed_mentions block is present, reply to each tagged message via moe.chat_send as workerId $WorkerId. Then follow your role doc."
                }
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

        # Heartbeat sidecar — same rationale as the codex branch above.
        Start-HeartbeatSidecar -ProxyScript $proxyScript -ProjectPath $projectPath -WorkerId $WorkerId | Out-Null
        try {
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
        } finally {
            Stop-HeartbeatSidecar
        }
    } elseif ($cliType -eq "grok") {
        # Check grok is available
        $grokCheck = Get-Command $Command -ErrorAction SilentlyContinue
        if (-not $grokCheck) {
            Write-Error "Grok command not found: $Command. Install Grok Build first (irm https://x.ai/cli/install.ps1 | iex  or  npm install -g @xai-official/grok)."
            exit 1
        }
        # Auth is XAI_API_KEY or the OAuth cache `grok login` leaves at
        # ~/.grok/auth.json. Neither present means the CLI will fail to
        # authenticate - warn, don't refuse: an interactive operator may be
        # about to log in from the TUI, and the message names the fix.
        $grokAuthFile = Join-Path $env:USERPROFILE ".grok\auth.json"
        if ([string]::IsNullOrEmpty($env:XAI_API_KEY) -and -not (Test-Path $grokAuthFile)) {
            Write-Host "[WARN] XAI_API_KEY is not set and ~/.grok/auth.json is missing - grok will fail to authenticate." -ForegroundColor Yellow
        }

        # Model: `-m <model>` ONLY when one is explicit - -Model, then
        # settings.models.<role>, then MOE_GROK_MODEL. $resolvedModel is NOT
        # used here: its claude-opus-5 per-role fallback is a claude model and
        # must never reach grok; with none of the three set grok picks its own
        # default. `--effort <lvl>` only when MOE_GROK_EFFORT is set.
        $grokModel = ""
        if (-not [string]::IsNullOrWhiteSpace($Model)) {
            $grokModel = $Model
        } elseif ($projConfig -and $projConfig.settings -and $projConfig.settings.models -and $projConfig.settings.models.$Role) {
            $grokModel = [string]$projConfig.settings.models.$Role
        } elseif (-not [string]::IsNullOrWhiteSpace($env:MOE_GROK_MODEL)) {
            $grokModel = $env:MOE_GROK_MODEL
        }
        $grokModelArgs = @()
        if ($grokModel) { $grokModelArgs = @("-m", $grokModel) }
        $grokEffortArgs = @()
        if (-not [string]::IsNullOrWhiteSpace($env:MOE_GROK_EFFORT)) { $grokEffortArgs = @("--effort", $env:MOE_GROK_EFFORT) }

        # No-task fast path, ported from the claude branch (same gates, same
        # reasoning): a headless session whose only job would be to park in
        # moe.wait_for_task is skipped and the outer loop polls instead.
        # Governor is excluded (it never claims and still needs its terminal),
        # -NoLoop must still launch (there is no next iteration), and routed
        # mentions already consumed by the pre-flight chat_read must reach a
        # CLI. An interactive grok TUI never loops ($loopEnabled is false), so
        # this only ever fires for headless runs.
        $grokLaunchSkipped = $false
        if ($AutoClaim -and $preflightNoTask -and $Role -ne 'governor' -and $loopEnabled -and (-not $grokInteractive) -and ($preflightRoutedMentions.Count -eq 0)) {
            Write-Host "[no-task] Skipping CLI launch — wrapper will poll again in $PollInterval s." -ForegroundColor DarkGray
            $script:CliExitCode = 0
            $grokLaunchSkipped = $true
        }

        if (-not $grokLaunchSkipped) {
            # Per-iteration prompt file. Grok has no --prompt flag and does not
            # read stdin: headless takes --prompt-file, the TUI takes a
            # positional prompt. So the role system prompt, the per-iteration
            # session context (claimed_task_context, inbox, routed_mentions,
            # skill JIT, baseline notices) and the role directive travel in ONE
            # temp file under $env:TEMP - never AGENTS.md or anything in the
            # project root (grok already auto-loads repo AGENTS.md/CLAUDE.md as
            # rules, and a project-root file would be attributable debris).
            # Argv stays quote-free, which sidesteps the PS < 7.3 native-arg
            # word-split that bit codex/gemini. The path is script-scoped so the
            # outer finally removes the file on every exit path.
            if ($claimPromptBody) {
                # Claimed / resumed task, the governor loop, or the legacy
                # multi-step prompt when the pre-flight claim RPC failed - the
                # file route carries embedded quotes fine.
                $grokDirective = $claimPromptBody
            } elseif ($AutoClaim) {
                # No task this iteration but something must be answered (routed
                # mentions) or there is no next iteration (-NoLoop): the session
                # context above already says wait_for_task first.
                $grokDirective = "If a routed_mentions block is present in the session context above, reply to each tagged message via moe.chat_send as workerId $WorkerId. Then follow your role doc."
            } else {
                $roleWorkflow = switch ($Role) {
                    "architect" { "Workflow: join chat -> read messages -> claim task -> get_context -> read Serena memory -> explore codebase -> submit_plan -> write Serena memory (handoff + learnings) -> announce in chat" }
                    "worker"    { "Workflow: join chat -> read messages -> claim task -> read task chat -> get_context -> read Serena memory -> start_step -> implement -> complete_step -> complete_task -> write Serena memory (handoff + learnings) -> announce in chat" }
                    "qa"        { "Workflow: join chat -> read messages -> claim task -> read task chat -> get_context -> read Serena memory -> review code and tests -> qa_approve or qa_reject -> write Serena memory (handoff + learnings) -> announce in chat" }
                    default     { "Workflow: claim task -> get_context -> read Serena memory -> complete task -> write Serena memory handoff" }
                }
                $grokDirective = "You are a $Role agent. Use ONLY Moe MCP tools (moe.*). $roleWorkflow. First: join #general via moe.chat_channels, moe.chat_join, and moe.chat_send. Then moe.chat_read to catch up on messages. Then call moe.claim_next_task to get your next task."
            }
            $grokFileBody = $systemAppend
            if ($dynamicContext) {
                $grokFileBody += "`n`n# Session Context (per-iteration)`n" + $dynamicContext
            }
            $grokFileBody += "`n`n" + $grokDirective
            $script:GrokPromptFile = Join-Path $env:TEMP "moe-grok-prompt-$Role-$myPid.md"
            [System.IO.File]::WriteAllText($script:GrokPromptFile, $grokFileBody, [System.Text.UTF8Encoding]::new($false))
            Write-Host "Agent prompt written to: $($script:GrokPromptFile)"

            # Grok auto-merges MCP servers from ~/.claude.json, .cursor/mcp.json
            # and the project .mcp.json unless told not to - a second `moe`
            # entry (another machine's absolute proxy path, a stale port) would
            # race the one in .grok/config.toml. Disable the merges and the
            # in-process auto-updater for this launch (the CLI also gets
            # --no-auto-update below; the env covers the interactive TUI). The
            # pre-launch values are restored by the outer finally.
            if ($null -eq $script:GrokEnvPrev) {
                $script:GrokEnvPrev = @{
                    GROK_CLAUDE_MCPS_ENABLED = $env:GROK_CLAUDE_MCPS_ENABLED
                    GROK_CURSOR_MCPS_ENABLED = $env:GROK_CURSOR_MCPS_ENABLED
                    GROK_DISABLE_AUTOUPDATER = $env:GROK_DISABLE_AUTOUPDATER
                }
            }
            $env:GROK_CLAUDE_MCPS_ENABLED = "0"
            $env:GROK_CURSOR_MCPS_ENABLED = "0"
            $env:GROK_DISABLE_AUTOUPDATER = "1"

            # Heartbeat sidecar - same rationale as the codex/gemini branches.
            Start-HeartbeatSidecar -ProxyScript $proxyScript -ProjectPath $projectPath -WorkerId $WorkerId | Out-Null
            try {
                if ($grokInteractive) {
                    # Interactive TUI: the initial prompt is a POSITIONAL argument -
                    # a short quote-free pointer at the prompt file (the path is one
                    # argv token, spaces and all); the TUI reads the role doc and
                    # session context from there.
                    $grokPointerPrompt = "Session context (routed mentions, pre-flight data) is in $($script:GrokPromptFile) - read it. If a routed_mentions block is present, reply to each tagged message via moe.chat_send as workerId $WorkerId. Then follow your role doc."
                    Write-Host "Command: $Command --cwd `"$projectPath`" $($grokModelArgs -join ' ') `"<prompt>`""
                    try {
                        Push-Location $projectPath
                        & $Command @CommandArgs --cwd "$projectPath" @grokModelArgs "$grokPointerPrompt"
                        $script:CliExitCode = $LASTEXITCODE
                    } finally { Pop-Location }
                } else {
                    # Headless: --prompt-file carries the whole prompt, --yolo
                    # auto-approves tool calls (the fleet equivalent of claude's
                    # bypassPermissions), --output-format plain keeps the
                    # transcript greppable. The prompt body is never echoed.
                    Write-Host "Command: $Command --prompt-file `"$($script:GrokPromptFile)`" --yolo --cwd `"$projectPath`" --no-auto-update --output-format plain $($grokModelArgs -join ' ') $($grokEffortArgs -join ' ')"
                    try {
                        Push-Location $projectPath
                        & $Command @CommandArgs --prompt-file "$($script:GrokPromptFile)" --yolo --cwd "$projectPath" --no-auto-update --output-format plain @grokModelArgs @grokEffortArgs
                        $script:CliExitCode = $LASTEXITCODE
                    } finally { Pop-Location }
                }
            } finally {
                Stop-HeartbeatSidecar
            }
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
        #
        # Gated on $loopEnabled: with -NoLoop (or -PollInterval 0) there is no
        # next iteration — skipping would print "will poll again" and then exit
        # without ever launching, a silent no-op. Single-shot runs must still
        # launch the CLI, which parks in moe.wait_for_task.
        #
        # Gated on routed mentions: pre-flight chat_read already consumed the
        # unread messages and baked @mentions into the prompt; skipping the
        # launch would discard them permanently. If anything tagged this
        # worker, launch so the CLI can reply.
        if ($AutoClaim -and $preflightNoTask -and $Role -ne 'governor' -and $loopEnabled -and ($preflightRoutedMentions.Count -eq 0)) {
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
            #
            # The same file route also covers prompts with embedded double quotes,
            # regardless of length. Windows PowerShell 5.1 forwards native-command
            # args WITHOUT escaping internal quotes, so a quote-bearing prompt
            # (routed_mentions JSON, claimed_task_context JSON under the 6000-char
            # threshold) word-splits into hundreds of argv tokens; the first
            # '-'-leading fragment then kills the CLI as an unknown option
            # (observed: `claude.exe : error: unknown option '-1'` on the
            # no-task + routed-mentions launch). codex/gemini already dodge this
            # via their instruction files — claude's user prompt was the gap.
            $userPromptForCli = $claimPrompt
            $WIN_CMD_SAFE_THRESHOLD = 6000
            $isWin = ($env:OS -eq "Windows_NT")
            $promptHasQuote = $claimPrompt -and $claimPrompt.IndexOf('"') -ge 0
            if ($isWin -and $claimPrompt -and ($claimPrompt.Length -gt $WIN_CMD_SAFE_THRESHOLD -or $promptHasQuote)) {
                $overflow = "`n`n# === Per-iteration runtime context (delivered as system prompt because the Windows command line cannot carry it as a user message) ===`n" + $claimPrompt
                [System.IO.File]::AppendAllText($systemPromptFile, $overflow, [System.Text.UTF8Encoding]::new($false))
                $userPromptForCli = "Begin. Your full task context, claimed_task_context, routed mentions, and role directive are at the END of the appended system prompt. Treat the role directive there as your active user request."
                $overflowReason = if ($claimPrompt.Length -gt $WIN_CMD_SAFE_THRESHOLD) { "length $($claimPrompt.Length) > $WIN_CMD_SAFE_THRESHOLD chars" } else { "embedded double quotes (PS 5.1 argv word-split)" }
                Write-Host "[prompt-overflow] claimPrompt routed via system prompt file: $overflowReason." -ForegroundColor Yellow
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
                                    # Tool-write harvest: the paths Edit/Write/
                                    # MultiEdit/NotebookEdit, Serena's edit tools
                                    # and complete_step.modifiedFiles named are
                                    # positive evidence this session touched them
                                    # (the TOOL tier of the attribution).
                                    try {
                                        $harvestInput = $script:moeToolJson | ConvertFrom-Json -ErrorAction Stop
                                        Add-MoeToolWrittenPath $script:moeToolName $harvestInput
                                    } catch {}
                                    $script:moeToolJson = ""
                                    $script:moeToolName = $null
                                } elseif ($script:moeInText) {
                                    Write-Host ""
                                    $script:moeInText = $false
                                }
                            }
                        }
                    }
                    "assistant" {
                        # Non-streamed assistant messages carry the full
                        # tool_use.input — harvest those too (same tier).
                        try {
                            if ($evt.message -and $evt.message.content) {
                                foreach ($blk in @($evt.message.content)) {
                                    if ($blk -and $blk.type -eq "tool_use") { Add-MoeToolWrittenPath $blk.name $blk.input }
                                }
                            }
                        } catch {}
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

            Start-HeartbeatSidecar -ProxyScript $proxyScript -ProjectPath $projectPath -WorkerId $WorkerId | Out-Null
            try {
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
            } finally {
                Stop-HeartbeatSidecar
            }
        }
    }

    # -------- Post-flight: shutdown rituals after CLI exits --------
    # Status resolution first; the landing + session-ended chat line follow.
    $script:MoeLastLanding = $null
    $moeStopLoop = $false

    if ($AutoClaim -and $preflightTaskId) {
        # Look up final task status AND reopenCount (the latter drives
        # commit-message wording in the auto-commit block below).
        $finalStatus = $null
        $finalReopenCount = 0
        # Epic-final = highest 'order' among this epic's tasks (ties count).
        # Drives the qualityGate scope: the epic's integration-and-hardening
        # task owns the full gate; mid-epic tasks stay lean. Newer daemons
        # compute the same rule board-side and serve it as get_context
        # isEpicFinal — prefer that value (and skip the sibling RPC); the
        # list_tasks fallback below stays for old daemons that don't serve
        # the field. Missing epicId or unparsable orders default to final
        # (gate on the safe side).
        $isEpicFinal = $true
        # Resolve the status by EXACT task id. This used to be an unscoped
        # `list_tasks @{}` filtered client-side, which the daemon caps at
        # DEFAULT_TASK_LIST_LIMIT (100) — so once the project outgrew one page
        # the completed task simply wasn't in the rows, $finalStatus stayed
        # $null, the REVIEW guard below was false, and the ENTIRE auto-commit
        # block (including every diagnostic in it) was skipped with no output.
        # get_context keys on the task id and cannot be paginated away.
        # Do NOT "fix" this by raising the limit: MAX_TASK_LIST_LIMIT is 500,
        # which only moves the same silent cliff further out.
        $statusLookupError = $null
        try {
            $ctxResp = Invoke-MoeRpc -Tool "get_context" -Args @{ taskId = $preflightTaskId }
            $matched = if ($ctxResp) { $ctxResp.task } else { $null }
            if (-not $matched -or -not $matched.id) {
                $statusLookupError = "get_context returned no task"
            } elseif ([string]$matched.id -ne $preflightTaskId) {
                # getContext.ts falls back to the CALLER's currentTaskId when the
                # requested id resolves to nothing (deleted/archived/wrong
                # project), and moe-proxy injects MOE_WORKER_ID on every call —
                # so a stale id comes back as some OTHER task's status. Committing
                # on that would be worse than not committing at all.
                $statusLookupError = "get_context resolved a different task ($($matched.id)) — the requested id no longer exists"
            } else {
                $finalStatus = $matched.status
                if ($matched.PSObject.Properties['reopenCount'] -and $matched.reopenCount) {
                    $finalReopenCount = [int]$matched.reopenCount
                }
                # Daemon-provided epic-final (get_context isEpicFinal, on the
                # task projection or top-level beside the epic): only an exact
                # JSON boolean counts — anything else means an old daemon and
                # routes to the fallback below.
                $daemonIsEpicFinal = $null
                if ($matched.PSObject.Properties['isEpicFinal'] -and $matched.isEpicFinal -is [bool]) {
                    $daemonIsEpicFinal = [bool]$matched.isEpicFinal
                } elseif ($ctxResp.PSObject.Properties['isEpicFinal'] -and $ctxResp.isEpicFinal -is [bool]) {
                    $daemonIsEpicFinal = [bool]$ctxResp.isEpicFinal
                }
                if ($null -ne $daemonIsEpicFinal) {
                    $isEpicFinal = $daemonIsEpicFinal
                } else {
                    # get_context's task projection carries no epicId/order, but it
                    # returns the resolved epic alongside it. Epic-final needs the
                    # siblings' orders anyway, so ask for ONE epic's tasks and read
                    # this task's own order out of that same page: that collection is
                    # legitimately bounded, unlike the whole project, so a limit here
                    # is not the same mistake — and the page is guaranteed to contain
                    # this task, because it is scoped to this task's epic.
                    $taskEpicId = if ($ctxResp.epic -and $ctxResp.epic.id) { [string]$ctxResp.epic.id } else { "" }
                    if ($taskEpicId) {
                        try {
                            $sibResp = Invoke-MoeRpc -Tool "list_tasks" -Args @{ epicId = $taskEpicId; limit = 500 }
                            if ($sibResp -and $sibResp.tasks) {
                                $myOrder = 0.0
                                $mine = $sibResp.tasks | Where-Object { $_.id -eq $preflightTaskId } | Select-Object -First 1
                                if ($mine -and $null -ne $mine.order) { $myOrder = [double]$mine.order }
                                $siblingMax = ($sibResp.tasks |
                                    ForEach-Object { if ($null -ne $_.order) { [double]$_.order } else { 0.0 } } |
                                    Measure-Object -Maximum).Maximum
                                if ($null -ne $siblingMax -and $myOrder -lt $siblingMax) { $isEpicFinal = $false }
                            }
                        } catch {
                            $isEpicFinal = $true
                        }
                    }
                }
            }
        } catch {
            $statusLookupError = "$_"
        }
        # A lookup that FAILED and a task that genuinely isn't in REVIEW are two
        # different things, and collapsing them into one silent no-op is what
        # made this defect invisible. A real non-REVIEW status stays quiet (the
        # agent simply didn't finish); an unresolved status is loud on stdout
        # AND in chat. Best-effort throughout: it must never abort the loop.
        if ($statusLookupError) {
            Write-Host "[WARN] post-flight status lookup failed for task ${preflightTaskId}: $statusLookupError. Cannot tell whether it reached REVIEW, so auto-commit+push is being skipped — check the working tree and commit manually." -ForegroundColor Yellow
            if ($generalChannelId) {
                try {
                    Invoke-MoeRpc -Tool "chat_send" -Args @{
                        channel  = $generalChannelId
                        workerId = $WorkerId
                        content  = "PUSH-BLOCKED: post-flight status lookup failed for task ${preflightTaskId} ($statusLookupError); auto-commit skipped and the work may be sitting uncommitted"
                    } | Out-Null
                } catch {}
            }
        }

        # Land on EVERY exit. Mode selection (identical in moe-agent.sh):
        #   statusLookupError            -> checkpoint with status=UNKNOWN (the id is
        #                                   certain; only the status is unknown)
        #   autoCommit == false          -> none (logged; baseline dropped)
        #   worker && REVIEW|DONE        -> completion (DONE = QA raced ahead)
        #   worker|architect|qa && checkpointCommits && MOE_DISABLE_CHECKPOINT != 1
        #                                -> checkpoint (wip(...) on the shared branch)
        #   else                         -> none
        # Best-effort: failures log a warning but never abort the wrapper loop;
        # helpers return values and the `break` decision is taken HERE.
        # Commits use the user's configured git identity (no Claude attribution).
        $moeSettings = Read-MoeCommitSettings
        $moeMode = 'none'
        $moeStatusForCommit = if ($finalStatus) { [string]$finalStatus } else { '' }
        if (-not $moeSettings.autoCommit) {
            Write-Host "[info] settings.autoCommit=false — no git activity for task $preflightTaskId (no completion, checkpoint or rescue); baseline deleted." -ForegroundColor Cyan
            if ($null -eq $moeGit) { $moeGit = Get-MoeGitTop }
            if ($moeGit) { Remove-MoeBaseline (Get-MoeBaselinePath $moeGit.GitDir $preflightTaskId) }
        } elseif ($statusLookupError) {
            $moeMode = 'checkpoint'
            $moeStatusForCommit = 'UNKNOWN'
        } elseif ($Role -eq 'worker' -and ($finalStatus -eq 'REVIEW' -or $finalStatus -eq 'DONE')) {
            $moeMode = 'completion'
        } elseif ((@('worker', 'architect', 'qa') -contains $Role) -and $moeSettings.checkpointCommits) {
            $moeMode = 'checkpoint'
        } else {
            Write-Host "[info] no landing for task $preflightTaskId (role=$Role status=$moeStatusForCommit checkpointCommits=$($moeSettings.checkpointCommits))." -ForegroundColor Cyan
            # A DELIBERATE no-landing exit (checkpointCommits=false / a role
            # with no landing) must not arm the recovery checkpoint: mark the
            # baseline landed so the next pre-flight does not land this
            # session's edits as a wip(...) recovered commit the operator
            # turned off.
            if ($null -eq $moeGit) { $moeGit = Get-MoeGitTop }
            if ($moeGit) { Set-MoeBaselineLanded $moeGit.GitDir $preflightTaskId }
        }
        if ($moeMode -ne 'none') {
            if ($null -eq $moeGit) { $moeGit = Get-MoeGitTop }
            if ($null -eq $moeGit) {
                Write-Host "[info] $projectPath is not a git repo — skipping auto-commit+push." -ForegroundColor Cyan
            } else {
                Write-Host "Post-flight: landing $moeMode for task $preflightTaskId (settings.autoCommit=true, status=$moeStatusForCommit)..." -ForegroundColor Cyan
                if (-not $moeSid) { $moeSid = "$WorkerId@" + (Get-Date).ToUniversalTime().ToString("yyyy-MM-dd'T'HH:mm:ss'Z'") }
                $moeExitForCommit = if ($null -ne $script:CliExitCode) { [int]$script:CliExitCode } else { 0 }
                $moeLanding = Invoke-MoeLanding -Kind $moeMode -TaskId $preflightTaskId -Git $moeGit -Settings $moeSettings `
                    -Title $preflightTaskTitle -Status $moeStatusForCommit -ReopenCount $finalReopenCount -CliExit $moeExitForCommit `
                    -Sid $moeSid -RunGate $true -IsEpicFinal $isEpicFinal
                $script:MoeLastLanding = $moeLanding
                if ($moeLanding.StopLoop) { $moeStopLoop = $true }
            }
        }
        # Whatever happened above, this session's bytes have been handled
        # (committed, parked on a rescue ref, refused, or nothing to land): the
        # teardown rescue in the outer finally must not run a second pass.
        $moeLandingDone = $true
    }
    # Session-ended chat line carries the landing summary, so it runs AFTER
    # the landing; the loop `break` for gate/peel failures happens after it.
    Invoke-PostFlight
    if ($moeStopLoop) { break }
    # -------- End post-flight --------
} while ($loopEnabled)
} finally {
    # Teardown rescue FIRST (before the deregister releases the task): when
    # this session ends without its post-flight having landed (Ctrl+C during
    # the CLI, a terminating error, exit 1 after the claim), park the task's
    # attributable edits on refs/moe/rescue/<taskId>/<ts>. Best-effort,
    # idempotent, single snapshot, no CAS loop, no push. The baseline stays so
    # the next session's pre-flight lands the work on the branch. This finally
    # is SKIPPED on console-window close / SIGKILL (nothing runs; the
    # persisted baseline is the recovery there).
    try { Invoke-MoeTeardownRescue } catch {}
    # Gracefully release any task this worker still holds so the next agent can
    # claim it immediately. Best-effort and idempotent (Invoke-MoeDeregister
    # no-ops if a Ctrl+C / window-close handler already fired). There is NO
    # idle-timeout fallback for hard crashes where none of these run: the task
    # stays assigned until daemon restart, deregister, or an explicit release.
    Invoke-MoeDeregister
    # Clean up temp files
    if ($mcpConfigFile -and (Test-Path $mcpConfigFile)) {
        Remove-Item -Path $mcpConfigFile -Force -ErrorAction SilentlyContinue
    }
    if ($systemPromptFile -and (Test-Path $systemPromptFile)) {
        Remove-Item -Path $systemPromptFile -Force -ErrorAction SilentlyContinue
    }
    if ($script:GrokPromptFile -and (Test-Path $script:GrokPromptFile)) {
        Remove-Item -Path $script:GrokPromptFile -Force -ErrorAction SilentlyContinue
    }
    # Clean up agent teams env var so it doesn't leak to parent session
    Remove-Item Env:\CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS -ErrorAction SilentlyContinue
    # Restore the grok launch env (MCP auto-merge + auto-updater opt-outs) to
    # its pre-launch values so a wrapper run with `&` in an interactive shell
    # leaves the operator's own GROK_* settings as it found them.
    if ($script:GrokEnvPrev) {
        foreach ($k in @($script:GrokEnvPrev.Keys)) {
            $v = $script:GrokEnvPrev[$k]
            if ($null -ne $v) { Set-Item -Path "Env:\$k" -Value $v } else { Remove-Item -Path "Env:\$k" -ErrorAction SilentlyContinue }
        }
    }
}
