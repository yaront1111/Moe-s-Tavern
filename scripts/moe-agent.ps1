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

    # Use gemini headless mode (non-interactive, --dangerously-skip-permissions) instead of interactive
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
    # When empty, the launcher picks a per-role default — all roles → Opus 5.5.
    # Per-project overrides via .moe/project.json settings.models.{role}. Only
    # applies to the `claude` CLI; codex/gemini pick their own model. Grok gets
    # `-m <model>` only when one is explicit (-Model, settings.models.<role>,
    # MOE_GROK_MODEL) - the per-role default below is never passed to grok.
    [string]$Model = ""
)

# ---- Hot-reload supervisor --------------------------------------------------
# One process and one console per seat, however many reloads. The first
# invocation in a process runs every pass of this file with `&` and loops while
# a pass asks for a reload (the restart check in the main loop, then the
# hand-over at the bottom of this file). `&` re-reads the file, so each pass
# runs the bytes on disk now, and the previous pass has fully returned (its
# finally ran, its seat deregistered) before the next one starts. df42861
# relaunched through `& <exe> <args>` instead: the seat kept its console, but
# the old wrapper stayed blocked on its child for the child's whole life, one
# more process per seat per edit -- 45 wrappers / 6.2 GB after one night of
# launcher landings, 38 of them blocked parents holding 5.5 GB (measured
# 2026-09-19). An `exit N` anywhere in a pass returns N here and the process
# exits with it; Ctrl+C stops the whole pipeline, so it never reloads.
if (-not $global:MoeWrapperSupervised -and $PSCommandPath) {
    $global:MoeWrapperSupervised = $true
    $moeReloaded = $false
    try {
        do {
            $global:MoeWrapperReload = $false; $global:LASTEXITCODE = 0
            & $PSCommandPath @PSBoundParameters
            $moeRc = $LASTEXITCODE
            $moeReloaded = $global:MoeWrapperReload
        } while ($moeReloaded)
    } catch {
        # The restart check refuses changed bytes that fail to parse, so a parse
        # error reaches here only when the file changed again after that check.
        # That, a file that rejects the bound parameters, or one that is gone
        # stops the seat, as a failed child relaunch did before.
        if ($moeReloaded) { Write-Host "wrapper relaunch failed; the seat is stopped, relaunch it by hand: $_" -ForegroundColor Yellow }
        throw
    } finally { $global:MoeWrapperSupervised = $false }
    exit $moeRc
}

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

# This seat's `mcp_servers.moe=<inline table>` codex override: the
# [mcp_servers.moe] and [mcp_servers.moe.env] tables of $ConfigPath
# (.codex/config.toml) plus, when set, the seat's execution identity
# (MOE_SESSION_ID and the MOE_ATTEMPT_ID/MOE_ATTEMPT_GENERATION pair, both or
# neither, which moe-proxy stamps) and MOE_WORKER_TYPE, then MOE_WORKER_ID and
# the seat's runner identity (MOE_RUNNER_PROCESS_STARTED_AT/MOE_RUNNER_HOST):
# codex hands an MCP server only the env its table names. The override must be a
# complete server definition: codex 0.163 TUI bootstrap rejects a partial dotted one
# (`-c mcp_servers.moe.env.MOE_WORKER_ID=...`) with "account/read failed:
# failed to load workspace requirements (code -32603)", exit 1 before any work.
# The writer emits one-line values with forward-slashed paths and no escapes, so
# basic strings become TOML literal strings ('...'): no double quote reaches the
# native argv, which PS < 7.3 would mangle. Falls back to the dotted form.
function Get-CodexMoeServerOverride([string]$ConfigPath, [string]$WorkerId) {
    $fallback = "mcp_servers.moe.env.MOE_WORKER_ID=$WorkerId"
    if (-not (Test-Path $ConfigPath)) { return $fallback }
    $server = @(); $envPairs = @(); $section = ''
    foreach ($line in [System.IO.File]::ReadAllLines($ConfigPath)) {
        $s = $line.Trim().TrimStart([char]0xFEFF)
        if ($s.StartsWith('[')) { $section = $s; continue }
        if (-not $s -or $s.StartsWith('#') -or -not $s.Contains('=')) { continue }
        $key, $value = $s.Split('=', 2) | ForEach-Object { $_.Trim() }
        if ($key -in @('MOE_WORKER_ID', 'MOE_RUNNER_PROCESS_STARTED_AT', 'MOE_RUNNER_HOST', 'MOE_SESSION_ID', 'MOE_ATTEMPT_ID', 'MOE_ATTEMPT_GENERATION', 'MOE_WORKER_TYPE')) { continue }
        if (-not $value.Contains("'") -and -not $value.Contains('\')) { $value = $value.Replace('"', "'") }
        if ($section -eq '[mcp_servers.moe]') { $server += "$key=$value" }
        elseif ($section -eq '[mcp_servers.moe.env]') { $envPairs += "$key=$value" }
    }
    if (-not ($server | Where-Object { $_.StartsWith('command=') })) { return $fallback }
    $sid = $env:MOE_SESSION_ID; $aid = $env:MOE_ATTEMPT_ID; $gen = $env:MOE_ATTEMPT_GENERATION
    if ($sid -and -not $sid.Contains("'")) { $envPairs += "MOE_SESSION_ID='$sid'" }
    if ($aid -and $gen -and -not "$aid$gen".Contains("'")) { $envPairs += "MOE_ATTEMPT_ID='$aid'", "MOE_ATTEMPT_GENERATION='$gen'" }
    $type = $env:MOE_WORKER_TYPE
    if ($type -and -not $type.Contains("'")) { $envPairs += "MOE_WORKER_TYPE='$type'" }
    $envPairs += "MOE_WORKER_ID='$WorkerId'"
    foreach ($key in @('MOE_RUNNER_PROCESS_STARTED_AT', 'MOE_RUNNER_HOST')) {
        $value = [Environment]::GetEnvironmentVariable($key)
        if ($value -and -not $value.Contains("'")) { $envPairs += "$key='$value'" }
    }
    return 'mcp_servers.moe={' + (($server + @('env={' + ($envPairs -join ',') + '}')) -join ',') + '}'
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

# CQ-R13c2: the JetBrains launcher sets MOE_RUNTIME_PROTECTED=1 beside both paths.
# Only exactly '1' protects: run exactly those files or refuse, never a fallback.
$script:MoeRuntimeProtected = ($env:MOE_RUNTIME_PROTECTED -ceq '1')
# Protected agent command: under MOE_RUNTIME_PROTECTED=1 the command can come
# from repository content (settings.agentCommand), so only claude, codex, gemini
# or grok runs, by bare name and with no -CommandArgs, resolved by
# Resolve-MoeProtectedCli below. Lines are byte-identical in moe-agent.sh.
function Stop-MoeProtectedAgent([string]$Line) { [Console]::Error.WriteLine($Line); exit 1 }
if ($script:MoeRuntimeProtected -and ($CommandArgs.Count -ne 0 -or $Command -cnotin @('claude', 'codex', 'gemini', 'grok'))) {
    $moeShown = ((@($Command) + @($CommandArgs)) -join ' ') -replace '\p{Cc}', '?'
    if ($moeShown.Length -gt 200) { $moeShown = $moeShown.Substring(0, 200) }
    Stop-MoeProtectedAgent "[ERROR] MOE_PROTECTED_AGENT_COMMAND_REFUSED: '$moeShown' is not one of claude, codex, gemini, grok; the protected runtime runs only these agent CLIs by name. Refusing to start."
}
# Protected runtime gate, before the exit handler, any MCP config, daemon, proxy
# RPC or CLI. The refusal names the variable, never its value; byte-identical in
# moe-agent.sh. Not Write-Error: under EAP Stop it throws instead of exiting 1.
function Stop-MoeProtectedRuntime([string]$Name) {
    [Console]::Error.WriteLine("[ERROR] MOE_RUNTIME_PROTECTED_PATH_MISSING: $Name must be an absolute path to an existing file when MOE_RUNTIME_PROTECTED=1; refusing to start.")
    exit 1
}
if ($script:MoeRuntimeProtected) {
    foreach ($moeProtectedName in @('MOE_PROXY_PATH', 'MOE_DAEMON_PATH')) {
        $moeProtectedPath = "$([Environment]::GetEnvironmentVariable($moeProtectedName))".Trim('"')
        $moeProtectedAbsolute = $moeProtectedPath -match '^[A-Za-z]:[\\/]' -or $moeProtectedPath -match '^[\\/]{2}[^\\/]' -or
            ($PSVersionTable.PSEdition -eq 'Core' -and -not $IsWindows -and $moeProtectedPath.StartsWith('/', [StringComparison]::Ordinal))
        if (-not ($moeProtectedAbsolute -and (Test-Path -LiteralPath $moeProtectedPath -PathType Leaf))) { Stop-MoeProtectedRuntime $moeProtectedName }
    }
}
# The full path with every symlink/junction component followed (GetFullPath
# alone keeps them), so a link into the project cannot pass for an outside dir.
function Get-MoeRealPath([string]$Path) {
    $full = [IO.Path]::GetFullPath($Path)
    for ($hop = 0; $hop -lt 40; $hop++) {
        $root = [IO.Path]::GetPathRoot($full)
        $parts = @($full.Substring($root.Length).Split([char[]]@([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)) | Where-Object { $_ })
        $dir = $root
        $relinked = $false
        for ($i = 0; $i -lt $parts.Count; $i++) {
            $here = [IO.Path]::Combine($dir, $parts[$i])
            $item = Get-Item -LiteralPath $here -Force -ErrorAction Stop
            $target = @($item.Target | Where-Object { $_ }) | Select-Object -First 1
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -and $target) {
                $rest = if ($i + 1 -lt $parts.Count) { @($parts[($i + 1)..($parts.Count - 1)]) } else { @() }
                $full = [IO.Path]::GetFullPath([IO.Path]::Combine(@($dir, "$target") + $rest))
                $relinked = $true
                break
            }
            $dir = $here
        }
        if (-not $relinked) { return $full }
    }
    throw "symlink loop at $Path"
}
# A protected CLI name resolves only from an absolute PATH entry outside the
# project's real path (empty, '.', relative and in-project entries skipped) by
# this manual scan, never Get-Command. Windows tries .ps1 first, then PATHEXT,
# PowerShell's own order. ponytail: 8.3 short-name aliases of the project and a
# file-level link inside a trusted dir are not followed; resolve them if needed.
function Resolve-MoeProtectedCli([string]$Name) {
    $onWindows = $PSVersionTable.PSEdition -ne 'Core' -or $IsWindows
    $cmp = if ($onWindows) { [StringComparison]::OrdinalIgnoreCase } else { [StringComparison]::Ordinal }
    $exts = if ($onWindows) { @('.ps1') + @("$env:PATHEXT".Split(';') | Where-Object { $_ } | ForEach-Object { $_.ToLowerInvariant() }) } else { @('') }
    $sep = [IO.Path]::DirectorySeparatorChar
    try { $project = (Get-MoeRealPath $projectPath.ProviderPath).TrimEnd('\', '/') } catch { $project = $null }
    foreach ($entry in "$env:PATH".Split([IO.Path]::PathSeparator)) {
        if (-not $project) { break }
        $entry = $entry.Trim('"')
        $absolute = if ($onWindows) { $entry -match '^[A-Za-z]:[\\/]' -or $entry -match '^[\\/]{2}[^\\/]' } else { $entry.StartsWith('/', [StringComparison]::Ordinal) }
        if (-not $absolute) { continue }
        try {
            $realFull = Get-MoeRealPath $entry
            $real = $realFull.TrimEnd('\', '/')
            if ($real.Equals($project, $cmp) -or "$real$sep".StartsWith("$project$sep", $cmp)) { continue }
            foreach ($ext in $exts) {
                # The untrimmed path: a root entry trimmed to 'C:' or '' would join drive- or cwd-relative.
                $file = [IO.Path]::Combine($realFull, "$Name$ext")
                if (Test-Path -LiteralPath $file -PathType Leaf) {
                    Write-Host "[INFO] MOE_PROTECTED_AGENT_CLI: $Name -> $file"
                    return $file
                }
            }
        } catch { continue }
    }
    Stop-MoeProtectedAgent "[ERROR] MOE_PROTECTED_AGENT_CLI_NOT_FOUND: $Name was not found on an absolute PATH entry outside the project; refusing to start."
}
$script:MoeProtectedCli = $null
if ($script:MoeRuntimeProtected) {
    $Command = Resolve-MoeProtectedCli $Command
    $script:MoeProtectedCli = $Command
}

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
$script:HeartbeatStopper = $null
function Invoke-MoeDeregister {
    # $Reason reaches the daemon verbatim. The self-restart path below passes
    # 'wrapper_restart' (sh twin parity) so a hand-over is distinguishable in
    # the activity log from an operator closing the terminal.
    param([string]$Reason = 'terminal_closed')
    # Kill any live heartbeat sidecar first — it's an unmanaged background
    # process (Start-Job's child powershell.exe) that outlives this one unless
    # explicitly stopped; unconditional and idempotent, so it runs even when
    # the deregister-proper half below is skipped by MoeDeregistered.
    if ($script:CurrentHeartbeatJob) {
        Stop-HeartbeatSidecar
    }
    if ($script:MoeDeregistered) { return }
    $script:MoeDeregistered = $true
    if (-not $WorkerId) { return }
    try { Invoke-MoeRpc -Tool "deregister_worker" -Args @{ workerId = $WorkerId; reason = $Reason } | Out-Null } catch {}
}
# PowerShell.Exiting fires for normal exits AND console-window close in 5.1.
# Its action resolves Invoke-MoeDeregister only while this pass is on the stack
# (measured 2026-09-19: at process exit after the pass returned, the name is not
# recognized), so the outer finally stays the deregister of record. A reload
# reruns this file in the same process (the supervisor at the top): drop the
# previous pass's subscriber and its job first so exactly one exists, and touch
# only ours (a -Command launch that loads a profile may own others).
try {
    Get-EventSubscriber -SourceIdentifier PowerShell.Exiting -ErrorAction SilentlyContinue |
        Where-Object { "$($_.Action.Command)" -match 'Invoke-MoeDeregister' } |
        ForEach-Object { Unregister-Event -SubscriptionId $_.SubscriptionId; Remove-Job -Id $_.Action.Id -Force -ErrorAction SilentlyContinue }
} catch {}
try { Register-EngineEvent -SourceIdentifier ([System.Management.Automation.PsEngineEvent]::Exiting) -Action { Invoke-MoeDeregister } | Out-Null } catch {}
# Do not attach a PowerShell scriptblock to Console.CancelKeyPress: its foreign
# thread has no runspace. In 5.1 it was inert; in 7.x it aborts the process before
# rescue/finally. Let the host cancel the pipeline and unwind the outer finally,
# where owned gates stop, bytes are rescued, then the worker deregisters.
try { [Console]::TreatControlCAsInput = $false } catch {}

# Build MCP config for moe-proxy
$proxyScript = $env:MOE_PROXY_PATH
if ($proxyScript) { $proxyScript = $proxyScript.Trim('"') }
if (-not $proxyScript) {
    if ($script:MoeRuntimeProtected) { Stop-MoeProtectedRuntime 'MOE_PROXY_PATH' }
    $root = Resolve-Path (Join-Path $PSScriptRoot "..")
    $proxyScript = Join-Path $root "packages\\moe-proxy\\dist\\index.js"
}
if (-not (Test-Path $proxyScript)) {
    if ($script:MoeRuntimeProtected) { Stop-MoeProtectedRuntime 'MOE_PROXY_PATH' }
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

# daemon.json is repository content: read at most 64 KiB + 1 byte so a huge or
# never-ending file cannot stall pre-flight; the callers' catch treats the throw
# like unparseable JSON. Same cap as moe-agent.sh's daemon_json_field.
# Convert-Path: a UNC project resolves provider-qualified, which [IO.File] rejects.
function Read-MoeDaemonJsonText([string]$Path) {
    $stream = [IO.File]::OpenRead((Convert-Path -LiteralPath $Path))
    try {
        $buffer = New-Object byte[] 65537
        $total = 0
        while ($total -lt $buffer.Length) {
            $read = $stream.Read($buffer, $total, $buffer.Length - $total)
            if ($read -le 0) { break }
            $total += $read
        }
        if ($total -gt 65536) { throw 'daemon.json is larger than 64 KiB' }
        return [Text.Encoding]::UTF8.GetString($buffer, 0, $total).TrimStart([char]0xFEFF)
    } finally { $stream.Dispose() }
}

# moe-proxy's comparableProjectPath rule: D:\x == D:/x == /mnt/d/x, drive and
# UNC paths case-insensitive, '.', '..' and trailing separators normalized.
# String operations only, so Windows PowerShell 5.1 and pwsh on Linux agree.
# Twin: comparable() in moe-agent.sh's probe_daemon_health.
function Get-MoeComparableProjectPath([string]$Path) {
    $p = $Path.Trim()
    $windows = $p -match '^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/])'
    if ($windows) { $p = $p.Replace('\', '/') }
    # '..' never climbs past a drive or a UNC server/share.
    $root = if (-not $windows) { 0 } elseif ($p.StartsWith('//')) { 2 } else { 1 }
    $kept = New-Object System.Collections.Generic.List[string]
    foreach ($segment in $p.Split('/')) {
        if ($segment.Length -eq 0 -or $segment.Equals('.')) { continue }
        if (-not $segment.Equals('..')) { $kept.Add($segment) }
        elseif ($kept.Count -gt $root) { $kept.RemoveAt($kept.Count - 1) }
    }
    $joined = $kept -join '/'
    if ($windows) { return $(if ($root -eq 2) { "//$joined" } else { $joined }).ToLowerInvariant() }
    if ("/$joined" -cmatch '^/mnt/([A-Za-z])(?:/(.*))?$') {
        return $(if ($Matches[2]) { "$($Matches[1]):/$($Matches[2])" } else { "$($Matches[1]):" }).ToLowerInvariant()
    }
    return "/$joined"
}

# Which project the daemon on 127.0.0.1:$Port serves, by its /health
# projectPath: 'same', 'foreign <served>' or 'unknown'. Once this project's
# daemon dies, another project's daemon can take its port (task-e7f4026a).
# Only a 200 or 503 reply naming another ABSOLUTE project is foreign; every
# failure is unknown, which keeps the old verdict. A raw HTTP/1.0 socket, like
# the JetBrains probe: one 3 s deadline covers connect, headers and body (a
# per-read timeout restarts on every trickled byte), no proxy, no redirect, and
# at most 64 KiB of body. Twin: probe_daemon_health in moe-agent.sh.
function Get-MoeDaemonIdentity($Port, [string]$ProjectPath) {
    $client = $null
    try {
        $deadline = [DateTime]::UtcNow.AddMilliseconds(3000)
        $client = New-Object Net.Sockets.TcpClient
        $client.SendTimeout = 3000
        $connect = $client.ConnectAsync('127.0.0.1', [int]$Port)
        # WaitAny, not Wait: a refused connect (the usual stale port) is an
        # answer, not an exception to log.
        $connected = [Threading.Tasks.Task]::WaitAny([Threading.Tasks.Task[]]@($connect), 3000) -ge 0
        if (-not $connected -or $connect.Status -ne 'RanToCompletion') { return 'unknown' }
        $stream = $client.GetStream()
        $request = [Text.Encoding]::ASCII.GetBytes("GET /health HTTP/1.0`r`nHost: 127.0.0.1:$([int]$Port)`r`nConnection: close`r`n`r`n")
        $stream.Write($request, 0, $request.Length)
        # 64 KiB of body plus 8 KiB of status line and headers; one byte more is oversize.
        $buffer = New-Object byte[] 73729
        $total = 0
        while ($total -lt $buffer.Length) {
            $left = [int]($deadline - [DateTime]::UtcNow).TotalMilliseconds
            if ($left -le 0) { return 'unknown' }
            $client.ReceiveTimeout = $left
            $read = $stream.Read($buffer, $total, $buffer.Length - $total)
            if ($read -le 0) { break }
            $total += $read
        }
        # ISO-8859-1 maps byte n to char n, so a header offset is a byte offset.
        $head = [Text.Encoding]::GetEncoding(28591).GetString($buffer, 0, $total)
        $split = $head.IndexOf("`r`n`r`n")
        if ($total -ge $buffer.Length -or $split -lt 0 -or $total - $split - 4 -gt 65536) { return 'unknown' }
        if ($head -notmatch '^HTTP/1\.[01] (200|503)[ \r]') { return 'unknown' }
        $health = [Text.Encoding]::UTF8.GetString($buffer, $split + 4, $total - $split - 4) | ConvertFrom-Json
        $served = $health.projectPath
        # Resolve-Path makes a UNC project provider-qualified.
        $ProjectPath = $ProjectPath -replace '^Microsoft\.PowerShell\.Core\\FileSystem::', ''
        $absolute = '^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/]|/)'
        if ($served -isnot [string] -or $served -notmatch $absolute -or $ProjectPath -notmatch $absolute) { return 'unknown' }
        # -eq and -ceq are culture-aware: distinct Unicode directory names can compare equal.
        if ([string]::Equals((Get-MoeComparableProjectPath $served), (Get-MoeComparableProjectPath $ProjectPath), [StringComparison]::Ordinal)) { return 'same' }
        $shown = $served -replace '[\x00-\x1f\x7f]', '?'
        if ($shown.Length -gt 300) { $shown = $shown.Substring(0, 300) + '...' }
        return "foreign $shown"
    } catch {
        return 'unknown'
    } finally {
        if ($client) { $client.Close() }
    }
}

if (-not $NoStartDaemon) {
    $daemonInfoPath = Join-Path $moeDir "daemon.json"
    $running = $false
    if (Test-Path $daemonInfoPath) {
        try {
            $info = Read-MoeDaemonJsonText $daemonInfoPath | ConvertFrom-Json
            $proc = Get-Process -Id $info.pid -ErrorAction SilentlyContinue
            if ($proc) {
                # A live PID proves a process, not which project it serves.
                # exit, not throw: the catch below would start a daemon instead.
                $identity = Get-MoeDaemonIdentity $info.port $projectPath
                if ($identity.StartsWith('foreign ')) {
                    Write-Host "[ERROR] MOE_DAEMON_FOREIGN_PROJECT: the daemon at 127.0.0.1:$($info.port) serves $($identity.Substring(8)), not this project ($projectPath)." -ForegroundColor Red
                    Write-Host "$daemonInfoPath is stale: this project's daemon is not running. Start it (the IDE's Restart Daemon, or moe-daemon start --project $projectPath); it takes the next free port."
                    Write-Host "Refusing to register, claim or bridge to another project's daemon."
                    exit 1
                }
                $running = $true
            }
        } catch {
            $running = $false
        }
    }

    if (-not $running) {
        $daemonScript = $env:MOE_DAEMON_PATH
        if ($daemonScript) { $daemonScript = $daemonScript.Trim('"') }
        if (-not $daemonScript) {
            if ($script:MoeRuntimeProtected) { Stop-MoeProtectedRuntime 'MOE_DAEMON_PATH' }
            $root = Resolve-Path (Join-Path $PSScriptRoot "..")
            $daemonScript = Join-Path $root "packages\\moe-daemon\\dist\\index.js"
        }
        if (-not (Test-Path $daemonScript)) {
            if ($script:MoeRuntimeProtected) { Stop-MoeProtectedRuntime 'MOE_DAEMON_PATH' }
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
                    $newInfo = Read-MoeDaemonJsonText $daemonInfoPath | ConvertFrom-Json
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
    # The daemon writes role docs as BOM-less UTF-8; Windows PowerShell 5.1 decodes a BOM-less file as ANSI unless told. -Encoding UTF8 is right on 5.1 and 7, BOM or not.
    if (Test-Path $p) { return Get-Content -Raw -Encoding UTF8 -Path $p }
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
# Every role defaults to Opus 5.5, launched
# with --effort max below unless the claimed task carries a launch tier. Override
# per role via project.json settings.models.{role}.
$defaultModels = @{
    architect = "claude-opus-5-5"
    worker    = "claude-opus-5-5"
    qa        = "claude-opus-5-5"
    governor  = "claude-opus-5-5"
}
$resolvedModel = ""
if (-not [string]::IsNullOrWhiteSpace($Model)) {
    $resolvedModel = $Model
} elseif ($projConfig -and $projConfig.settings -and $projConfig.settings.models) {
    $configured = $projConfig.settings.models.$Role
    if ($configured) { $resolvedModel = [string]$configured }
}
# The operator-pinned model (flag or settings.models.<role>); a task's launch tier never overrides it.
$explicitModel = $resolvedModel
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
# A protected CLI path is never re-split (a space in it is not an argument).
if ($script:MoeProtectedCli) { $Command = $script:MoeProtectedCli; $CommandArgs = @() }

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
# The seat's worker.type: moe-proxy forwards it on claim_next_task/join_team.
# Replaces an inherited value (the in-process hot reload keeps env).
$env:MOE_WORKER_TYPE = $cliType.ToUpperInvariant()

# Shared policy applies to every project, before a task is claimed or a model is called.
$promptCacheHelper = Join-Path $PSScriptRoot 'prompt-cache.mjs'
function Start-MoeUsageReceipt([string]$Provider, [string]$LaunchMode) {
    $env:MOE_USAGE_RECEIPT_FILE = $null
    $env:MOE_USAGE_CONTEXT_JSON = $null
    if ($env:MOE_USAGE_REPORTING -eq 'off' -or $Provider -notin @('claude', 'codex')) { return }
    $savedExitCode = $global:LASTEXITCODE
    try {
        $requestedModel = if ($Provider -eq 'claude') { if ($iterModel) { $iterModel } else { $resolvedModel } } elseif ($iterCodexModel) { $iterCodexModel } else { $null }
        $requestedEffort = if ($Provider -eq 'claude') { if ($iterEffort) { $iterEffort } else { 'max' } } elseif ($iterCodexEffort) { $iterCodexEffort } elseif ($env:MOE_CODEX_REASONING_EFFORT) { $env:MOE_CODEX_REASONING_EFFORT } else { 'xhigh' }
        $env:MOE_USAGE_CONTEXT_JSON = @{ taskId=$preflightTaskId; workerId=$WorkerId; role=$Role
            attemptId=$script:MoeAttemptId; requestedModel=$requestedModel; requestedEffort=$requestedEffort
            launchMode=$LaunchMode } | ConvertTo-Json -Compress
        $sessionHelper = Join-Path (Split-Path -Parent $promptCacheHelper) 'usage-session.mjs'
        $prepared = (& node $sessionHelper "$projectPath" 2>$null | Out-String).Trim()
        if (-not $prepared) { throw 'unavailable' }
        $usageSession = $prepared | ConvertFrom-Json -ErrorAction Stop
        if (-not $usageSession.file -or -not $usageSession.context.launchId) { throw 'invalid' }
        $env:MOE_USAGE_RECEIPT_FILE = [string]$usageSession.file
        $env:MOE_USAGE_CONTEXT_JSON = $usageSession.context | ConvertTo-Json -Compress
        # Pending survives a crash or interactive session with no usage stream;
        # a later reported/missing receipt supersedes only this pending marker.
        & node $promptCacheHelper usage-start $Provider | Out-Null
    } catch {
        $env:MOE_USAGE_RECEIPT_FILE = $null
        $env:MOE_USAGE_CONTEXT_JSON = $null
        Write-Warning 'MOE_USAGE_REPORT_UNAVAILABLE'
    } finally { $global:LASTEXITCODE = $savedExitCode }
}
# End usage receipt helpers.
if ($cliType -in @('claude', 'codex')) {
    & node $promptCacheHelper check $cliType "$projectPath" @CommandArgs
    if ($LASTEXITCODE -ne 0) { exit 1 }
    # Native stream filters must not turn Unicode task/tool text into '?' on PS 5.1.
    $global:OutputEncoding = [System.Text.UTF8Encoding]::new($false)
    [Console]::OutputEncoding = $global:OutputEncoding
}
# Codex is interactive (TUI) for every role unless -CodexExec opts the seat
# into one-shot `codex exec`. 8b632b5 (2026-09-06) had made worker/qa seats
# default to exec because the codex TUI never exits on its own and this wrapper
# blocks inside the CLI call for its whole lifetime, so an interactive worker
# reaches the post-flight (checkpoint/completion commit, record_commit,
# session-end line) only when the operator closes the TUI. Reverted 2026-09-07
# at the operator's request; pass -CodexExec when per-task landing matters.
# The sh twin resolves --codex-exec the same way.
# Worker/qa codex seats default to one-shot `codex exec` (restores 8b632b5,
# reverted 2026-09-07; re-requested by the operator 2026-09-24 as "make sure
# codex not stopping between tasks"). The codex TUI never exits on its own, so
# an interactive worker/qa seat both misses the post-flight AND has its loop
# forced off below -- it lands one row and then sits idle forever. Exec mode
# exits per row, so the post-flight lands it and the relaunch loop takes the
# next one. Architect/governor keep the TUI: planning and governance are
# conversations, and neither is a byte-landing path. -Interactive still forces
# the TUI back for a worker/qa seat. The sh twin resolves this identically.
if (($cliType -eq "codex") -and (-not $CodexExec) -and (-not $Interactive) -and
    (($Role -eq "worker") -or ($Role -eq "qa"))) {
    $CodexExec = $true
}
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
# (-Root: the control or the task worktree; MOE_PROJECT_PATH stays the control)
function Write-MoeCodexConfig {
    param([string]$Root, [string]$SerenaProject)
    Write-Host "Writing project-scoped Codex MCP config..."
    $codexConfigDir = Join-Path $Root ".codex"
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
developer_instructions = """`nYou are an agent in the Moe AI Workforce system. Your role is supplied in the private model instructions. You MUST use Moe MCP tools (moe.*) for ALL task operations. Follow the Moe workflow strictly. Never edit .moe/ files directly unless the project's CLAUDE.md or AGENTS.md explicitly permits that path.`n"""
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
        # default_tools_approval_mode: codex 0.148+ refuses every MCP tool it deems
        # approval-worthy (no readOnlyHint annotation -- every moe.* tool) whenever
        # approval_policy = never meets a sandbox ("MCP tool call requires approval,
        # but approval policy is never"). `approve` pre-approves the server's tools
        # (enum auto | prompt | writes | approve, codex 0.147+; older versions ignore
        # the key), so headless seats can call start_step under any MOE_CODEX_SANDBOX
        # and TUI seats never see a prompt. Written on the serena server too.
        # Cover Moe's 600s blocking polls and the proxy's 660s response budget.
        $moeTomlBlock = @"

[mcp_servers.moe]
command = "node"
args = ["$proxyScriptForToml"]
startup_timeout_sec = $codexMcpStartupTimeout
default_tools_approval_mode = "approve"
tool_timeout_sec = 720

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
default_tools_approval_mode = "approve"
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
        throw
    }
}
function Write-MoeGeminiConfig {
    param([string]$Root, [string]$SerenaProject)
    # For gemini: write project-scoped .gemini/settings.json with MCP config
    Write-Host "Writing project-scoped Gemini MCP config..."
    $geminiConfigDir = Join-Path $Root ".gemini"
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
        throw
    }
}
function Write-MoeGrokConfig {
    param([string]$Root, [string]$SerenaProject)
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
    $grokConfigDir = Join-Path $Root ".grok"
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
        # The same for the runner identity, set for architect/QA/governor seats
        # only; empty (unset, to the proxy) for a worker or a human run.
        $grokRunnerStartedLine = 'MOE_RUNNER_PROCESS_STARTED_AT = "${MOE_RUNNER_PROCESS_STARTED_AT:-}"'
        $grokRunnerHostLine = 'MOE_RUNNER_HOST = "${MOE_RUNNER_HOST:-}"'
        # The seat's execution identity, which moe-proxy stamps onto
        # get_context/start_step/complete_step/complete_task (the attempt pair only on
        # the last three); empty (unset, to the proxy) outside a task.
        $grokSessionIdLine = 'MOE_SESSION_ID = "${MOE_SESSION_ID:-}"'
        $grokAttemptIdLine = 'MOE_ATTEMPT_ID = "${MOE_ATTEMPT_ID:-}"'
        $grokAttemptGenerationLine = 'MOE_ATTEMPT_GENERATION = "${MOE_ATTEMPT_GENERATION:-}"'
        # The seat's CLI (the wrapper exports GROK), forwarded on registration.
        $grokWorkerTypeLine = 'MOE_WORKER_TYPE = "${MOE_WORKER_TYPE:-}"'
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
            $grokRunnerStartedLine,
            $grokRunnerHostLine,
            $grokSessionIdLine,
            $grokAttemptIdLine,
            $grokAttemptGenerationLine,
            $grokWorkerTypeLine,
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
        Grant-GrokFolderTrust -ProjectPath $Root
    } catch {
        Write-Error "Failed to write Grok MCP config: $_"
        throw
    }
}
if ($cliType -eq "codex") {
    Write-MoeCodexConfig -Root "$projectPath" -SerenaProject $serenaProject
} elseif ($cliType -eq "gemini") {
    Write-MoeGeminiConfig -Root "$projectPath" -SerenaProject $serenaProject
} elseif ($cliType -eq "grok") {
    Write-MoeGrokConfig -Root "$projectPath" -SerenaProject $serenaProject
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
# $teamJoined is the wrapper's view of this seat's membership. It starts false
# and turns true only on a join the daemon answered without an error; while it
# is false, Invoke-MoeTeamJoinRetry re-runs the join before every claim poll.
$teamId = ""
$teamJoined = $false
$teamJoinLastError = ""
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
            # Read the answer. A refused join (e.g. "Team X is full (max N members)")
            # leaves this seat SOLO, and claim_next_task then skips every epic a live
            # worker already holds: the seat reports "no claimable task" while the
            # board is full of work. Never print success blind. Twin: moe-agent.sh.
            $joinResult = Invoke-MoeRpcRaw -RpcJson $joinRpc
            if ($joinResult -and $joinResult.PSObject.Properties['error'] -and $joinResult.error) {
                $teamJoinLastError = [string]$joinResult.error.message
                Write-Host "[WARN] moe.join_team refused: $($joinResult.error.message) - this seat has NO team, so claim_next_task skips every epic a live worker already holds. Raise the team's maxSize or free a seat; a claiming seat retries the join before every claim." -ForegroundColor Yellow
            } elseif ($null -eq $joinResult) {
                $teamJoinLastError = "no answer"
                Write-Host "[WARN] moe.join_team got no answer; team membership is unconfirmed." -ForegroundColor Yellow
            } else {
                $teamJoined = $true
                Write-Host "Worker $WorkerId joined team '$Team'"
                $teamContext = "You are part of team '$Team' (id: $teamId, role: $Role). Team members can work in parallel on the same epic."
            }
        } else {
            $teamJoinLastError = "moe.create_team got no answer"
            Write-Host "WARNING: Could not parse team creation response (daemon may not be running)" -ForegroundColor Yellow
        }
    } catch {
        $teamJoinLastError = "team setup failed: $_"
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

    $script:MoeRpcFailure = "transport"
    $script:MoeRpcCodeName = ''
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
    # PS 5.1's nested native pipeline reads the GLOBAL OutputEncoding, not
    # this function's local value (local UTF-8 still sends '?' bytes).
    $previousOutputEncoding=$global:OutputEncoding
    $previousConsoleEncoding=[Console]::OutputEncoding
    $global:OutputEncoding=New-Object Text.UTF8Encoding($false)
    [Console]::OutputEncoding=$global:OutputEncoding
    try {
        $raw = ($rpc | & node $proxyScript 2>&1) | ForEach-Object { "$_" }
        if ($LASTEXITCODE -ne 0) { $raw = $null }
    } catch {
        $env:MOE_PROJECT_PATH = $prevEnv
        $ErrorActionPreference = $prevEAP
        return $null
    } finally {
        $global:OutputEncoding=$previousOutputEncoding
        [Console]::OutputEncoding=$previousConsoleEncoding
    }
    $ErrorActionPreference = $prevEAP
    $env:MOE_PROJECT_PATH = $prevEnv
    if (-not $raw) { return $null }

    $script:MoeRpcFailure = "invalid payload"
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
            if ($d.result.isError -eq $true) { $script:MoeRpcFailure="daemon refusal"; return $null }
            if ($d.error) {
                $script:MoeRpcFailure = "daemon refusal"
                $script:MoeRpcCodeName = [string]$d.error.data.codeName
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

# A wrapper-only read the CLI is never served: without MOE_SESSION_ID the
# spawned moe-proxy stamps no sessionId, so it mints no receipt. The seat's
# value comes back even when the call throws. Twin: moe_rpc_unserved.
function Invoke-MoeRpcUnserved {
    param(
        [Parameter(Mandatory = $true)][string]$Tool,
        [object]$Args
    )
    $sessionId = $env:MOE_SESSION_ID
    Remove-Item Env:MOE_SESSION_ID -ErrorAction SilentlyContinue
    try { return Invoke-MoeRpc -Tool $Tool -Args $Args }
    finally { if ($sessionId) { $env:MOE_SESSION_ID = $sessionId } }
}

# Test-MoeClaimNoTeam CLAIM: $true when a claim answer is the daemon's
# NO_TEAM_MEMBERSHIP refusal (claimNextTask.ts noTeamMembershipRefusal): the
# seat is SOLO and every claimable candidate sits in an epic+status a live
# worker already holds.
function Test-MoeClaimNoTeam($Claim) {
    return [bool]($Claim -and $Claim.PSObject.Properties['code'] -and $Claim.code -eq 'NO_TEAM_MEMBERSHIP')
}

# Test-MoeSeatTeamless: $true when this claiming seat meant to join a team and has not.
function Test-MoeSeatTeamless {
    return [bool]($Team -and $Role -ne 'governor' -and -not $script:teamJoined)
}

# Invoke-MoeTeamJoinRetry [-Force]
# The startup join is one shot. A seat it left SOLO (the team was full, or the
# daemon did not answer) stayed solo until someone relaunched it: raising the
# team's maxSize or freeing a seat changed nothing, and the seat logged
# "No claimable task ... MOE_TASKLESS_NO_LAUNCH reason=idle" every poll while
# claim_next_task skipped every epic+status a live worker held. So a claiming
# seat re-runs the join (and the create, if that never answered) before each
# claim until the daemon accepts it; join_team is idempotent for a member.
# -Force re-joins even a seat the wrapper believes joined, governors included:
# the daemon may have pruned the seat's record (stale) or left it DEAD (a hot
# reload deregisters), and chat then refuses it as an unknown sender. A join
# re-registers it. Only an answer listing this seat as a member counts.
# Returns $true once joined. Twin: moe-agent.sh retry_team_join.
function Invoke-MoeTeamJoinRetry {
    param([switch]$Force)
    if ($script:teamJoined -and -not $Force) { return $true }
    if (-not $Team -or ($Role -eq 'governor' -and -not $Force)) { return $false }
    $wasJoined = $script:teamJoined
    $previousError = $script:teamJoinLastError
    $failure = ''
    $script:teamJoined = $false
    if (-not $script:teamId) {
        # enter_governance requires a role-bound governor team (see the startup create).
        $createArgs = if ($Role -eq 'governor') { @{ name = $Team; role = 'governor' } } else { @{ name = $Team } }
        $createRpc = '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"moe.create_team","arguments":' + (ConvertTo-Json $createArgs -Compress) + '}}'
        $created = Invoke-MoeRpcRaw -RpcJson $createRpc
        try { $script:teamId = [string](($created.result.content[0].text | ConvertFrom-Json -ErrorAction Stop).team.id) } catch { $script:teamId = '' }
        if (-not $script:teamId) {
            $failure = if ($null -eq $created) { 'moe.create_team got no answer' } else { 'no team id in the moe.create_team answer' }
        }
    }
    if (-not $failure) {
        $joinRpc = '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"moe.join_team","arguments":' + (ConvertTo-Json @{ teamId = $script:teamId; workerId = $WorkerId } -Compress) + '}}'
        $joined = Invoke-MoeRpcRaw -RpcJson $joinRpc
        $joinedTeam = $null
        try { $joinedTeam = ($joined.result.content[0].text | ConvertFrom-Json -ErrorAction Stop).team } catch { $joinedTeam = $null }
        if ($joined -and $joined.PSObject.Properties['error'] -and $joined.error) {
            $failure = [string]$joined.error.message
            if (-not $failure) { $failure = 'refused' }
        } elseif ($null -eq $joined) {
            $failure = 'no answer'
        } elseif ($joined.result.isError -eq $true) {
            $failure = 'MCP daemon refusal'
        } elseif (-not $joinedTeam -or [string]$joinedTeam.id -cne $script:teamId -or @($joinedTeam.memberIds) -cnotcontains $WorkerId) {
            $failure = 'the moe.join_team answer does not list this seat as a member'
        } else {
            $script:teamJoined = $true
            $script:teamJoinLastError = ''
            $script:teamContext = "You are part of team '$Team' (id: $($script:teamId), role: $Role). Team members can work in parallel on the same epic."
            # A healthy seat's forced re-join each pre-flight stays quiet.
            if (-not $wasJoined) { Write-Host "[OK] Worker $WorkerId joined team '$Team' on retry; this seat is no longer teamless." -ForegroundColor Green }
            return $true
        }
    }
    $script:teamJoinLastError = $failure
    # A team deleted under the seat: drop its id so the next retry re-creates it by name.
    if ($failure.StartsWith('Team not found: ')) { $script:teamId = '' }
    # Warn when the refusal changes, not on every poll: the per-poll banners
    # already name a teamless seat.
    if ($failure -ne $previousError) {
        if ($Force) {
            Write-Host "[WARN] MOE_SEAT_UNREGISTERED worker=$WorkerId team=$Team - moe.join_team: $failure; this seat's chat stays unread until a pre-flight join succeeds." -ForegroundColor Yellow
        } else {
            Write-Host "[WARN] moe.join_team retry refused: $failure - this seat is still TEAMLESS; the wrapper retries before the next claim." -ForegroundColor Yellow
        }
    }
    return $false
}

# Immutable claim tokens belong to the runner, not the mutable CLI context.
function Test-MoeGeneration($Value) {
    return (($Value -is [int] -or $Value -is [long]) -and $Value -gt 0 -and $Value -le 9007199254740991)
}
function Read-MoeAttempt([string]$TaskId, [string]$AttemptId = '', $Generation = $null) {
    try {
        $all = @(Get-ChildItem -LiteralPath (Join-Path $projectPath '.moe/attempts') -Filter '*.json' -ErrorAction Stop |
            ForEach-Object { [IO.File]::ReadAllText($_.FullName) | ConvertFrom-Json -ErrorAction Stop } |
            Where-Object { $_.taskId -ceq $TaskId })
        $open = @($all | Where-Object { $_.phase -ne 'closed' })
        if ($open.Count -ne 1) { throw 'ambiguous or missing open attempt' }
        $a = $open[0]
        if ($a.workerId -cne $WorkerId -or -not (Test-MoeGeneration $a.generation)) { throw 'identity' }
        if ($a.id -cnotmatch '^[A-Za-z0-9_-]{1,128}$' -or $a.phase -cnotin @('running','finalizing')) { throw 'phase or id' }
        if ($AttemptId -and ($a.id -cne $AttemptId -or $a.generation -ne $Generation)) { throw 'stale identity' }
        return $a
    } catch {
        $script:MoeAttemptReadError = "Attempt identity unavailable: $_"
        Write-Host "[WARN] $script:MoeAttemptReadError" -ForegroundColor Yellow; return $null
    }
}
# Exported for the CLI's moe-proxy, which stamps the pair onto
# start_step/complete_step/complete_task (CQ-F09, F12a). The
# pair moves together: only an identity verified against the store is kept.
# The same verified record pins its execution profile and plan revision (CQ-V07)
# in $script:PinnedAttemptProfile / $script:PinnedAttemptPlanRevision: script
# variables, never env, so no CLI can set or read them, and reset with the pair.
# Twin: pin_attempt_identity.
function Set-MoeAttemptIdentity($Claim, [string]$TaskId) {
    $script:MoeAttemptId = ''; $script:MoeAttemptGeneration = $null
    $script:PinnedAttemptProfile = ''; $script:PinnedAttemptPlanRevision = $null
    Remove-Item Env:MOE_ATTEMPT_ID, Env:MOE_ATTEMPT_GENERATION -ErrorAction SilentlyContinue
    $id = Get-MoeProp $Claim 'attemptId'; $g = Get-MoeProp $Claim 'generation'
    if ($null -eq $id -and $null -eq $g -and (Get-MoeProp $Claim 'alreadyAssigned')) {
        $a = Read-MoeAttempt $TaskId
        if ($a) { $id = $a.id; $g = $a.generation }
    }
    $record = $null
    if ($id -is [string] -and $id -cmatch '^[A-Za-z0-9_-]{1,128}$' -and (Test-MoeGeneration $g)) { $record = Read-MoeAttempt $TaskId $id $g }
    if (-not $record) {
        Write-Host '[WARN] Missing/stale attempt identity; candidate completion will fail closed.' -ForegroundColor Yellow
        return
    }
    $script:MoeAttemptId = $id; $script:MoeAttemptGeneration = $g
    $env:MOE_ATTEMPT_ID = $id; $env:MOE_ATTEMPT_GENERATION = [string]$g
    # A missing or malformed snapshot pins nothing: that attempt lands as legacy.
    $snapshot = Get-MoeProp $record 'executionPolicySnapshot'
    $pinProfile = Get-MoeProp $snapshot 'profile'; $revision = Get-MoeProp $snapshot 'planRevision'
    if ($pinProfile -is [string] -and $pinProfile -cmatch '\A[a-z][a-z-]{0,31}\z') { $script:PinnedAttemptProfile = $pinProfile }
    if (Test-MoeGeneration $revision) { $script:PinnedAttemptPlanRevision = $revision }
}
# A daemon restart parked this seat's attempt in `reconciling`: present its id
# and generation with THIS process's identity so it runs again instead of being
# given up after the reconcile window. 'running' again; 'refused', which never
# heals (the same values are refused again), so callers stop asking; 'none' when
# no usable answer came back, ask again later. One line either way, never a
# throw. Twin: moe_reattach.
function Invoke-MoeReattach([string]$TaskId, [string]$AttemptId, $Generation) {
    $r = $null
    try {
        $r = Invoke-MoeRpc -Tool 'reattach_attempt' -Args @{ taskId = $TaskId; workerId = $WorkerId; runnerId = $script:MoeRunnerId
            attemptId = $AttemptId; generation = $Generation; processStartedAt = $script:MoeProcessStartedAt; host = $script:MoeHost }
    } catch { $script:MoeRpcFailure = 'transport' }
    if ($r -and (Get-MoeProp $r 'success') -eq $true -and (Get-MoeProp $r 'phase') -ceq 'running') {
        Write-Host "[reattach] attempt $AttemptId (generation $Generation) on task $TaskId is running again after a daemon restart." -ForegroundColor Green
        return 'running'
    }
    if ($null -eq $r -and $script:MoeRpcFailure -eq 'daemon refusal' -and $script:MoeRpcCodeName) {
        Write-Host "[reattach] moe.reattach_attempt refused for attempt $AttemptId ($($script:MoeRpcCodeName)); not retrying it." -ForegroundColor Yellow
        return 'refused'
    }
    Write-Host "[WARN] moe.reattach_attempt got no answer for attempt $AttemptId; retrying later." -ForegroundColor Yellow
    return 'none'
}
# The main loop's half, for what the sidecar cannot see: the pre-flight (a
# restart between two sessions leaves a resumed attempt parked, and the pin
# would fail closed on it) and the moment the CLI exits (a restart inside a
# session that ended before the sidecar's next ping). Every attempt this seat
# owns in `reconciling` is reattached once; a refusal is remembered for the life
# of this wrapper. Twin: reattach_own_attempts.
$script:MoeReattachRefused = [Collections.Generic.HashSet[string]]::new()
function Invoke-MoeReattachOwnAttempts {
    if (-not $script:MoeProcessStartedAt) { return }
    foreach ($f in @(Get-ChildItem -LiteralPath (Join-Path $projectPath '.moe/attempts') -Filter '*.json' -ErrorAction SilentlyContinue | Sort-Object Name)) {
        try { $a = [IO.File]::ReadAllText($f.FullName) | ConvertFrom-Json -ErrorAction Stop } catch { continue }
        $id = [string](Get-MoeProp $a 'id'); $tid = [string](Get-MoeProp $a 'taskId'); $g = Get-MoeProp $a 'generation'
        if ((Get-MoeProp $a 'workerId') -cne $WorkerId -or (Get-MoeProp $a 'phase') -cne 'reconciling' -or -not (Test-MoeGeneration $g) -or
            $id -cnotmatch '^[A-Za-z0-9_-]{1,128}$' -or $tid -cnotmatch '^[A-Za-z0-9_-]{1,128}$' -or $script:MoeReattachRefused.Contains($id)) { continue }
        if ((Invoke-MoeReattach $tid $id $g) -eq 'refused') { [void]$script:MoeReattachRefused.Add($id) }
    }
}
function Send-MoeEvidence([string]$Tool, [hashtable]$Payload, [int]$Tries = 1) {
    for ($i = 0; $i -lt $Tries; $i++) {
        try {
            $r = Invoke-MoeRpc -Tool $Tool -Args $Payload
            if ($null -eq $r) { throw "transport failure or daemon refusal ($script:MoeRpcFailure)" }
            if ((Get-MoeProp $r 'success') -isnot [bool] -or $r.success -ne $true) { throw 'invalid payload acknowledgement' }
            if ($Tool -eq 'finalize_attempt') {
                if ($r.phase -cne 'closed') { throw 'invalid final phase' }
                $record = $r; $keys = @('taskId','attemptId','generation','outcome','landedRevision')
            } else {
                $field = if ($Tool -eq 'record_candidate') { 'candidate' } elseif ($Tool -eq 'record_delivery_receipt') { 'receipt' } else { 'checkRun' }
                $record = Get-MoeProp $r $field
                if ($null -eq $record -or (Get-MoeProp $r 'duplicate') -isnot [bool]) { throw 'invalid persisted record' }
                $keys = @($Payload.Keys | Where-Object { $_ -cnotin @('workerId','generation') })
            }
            foreach ($key in $keys) {
                $actual = Get-MoeProp $record $key
                $expected = $Payload[$key]
                if (($actual | ConvertTo-Json -Compress) -cne ($expected | ConvertTo-Json -Compress)) { throw "invalid $key acknowledgement" }
            }
            return $true
        } catch { Write-Host "[WARN] $Tool : $_; not persisted evidence." -ForegroundColor Yellow }
    }
    return $false
}
# Candidate evidence needs this seat's CURRENT attempt. When the pinned attempt is
# missing, closed or superseded by another claim, or parked, no gate result can
# be bound to it: MoeEvidenceUnavailable tells the landing to park the frozen
# bytes without running the gate and without announcing a gate failure.
function Send-MoeCandidate([string]$TaskId, [hashtable]$Frozen, [string]$Branch) {
    $script:MoeEvidenceUnavailable = ''
    if (-not $script:MoeAttemptId -or $null -eq $script:MoeAttemptGeneration) { $script:MoeEvidenceUnavailable = 'no pinned attempt identity'; return $false }
    if (-not (Read-MoeAttempt $TaskId $script:MoeAttemptId $script:MoeAttemptGeneration)) { $script:MoeEvidenceUnavailable = $script:MoeAttemptReadError; return $false }
    $payload = @{ taskId=$TaskId; attemptId=$script:MoeAttemptId; generation=$script:MoeAttemptGeneration
        workerId=$WorkerId; id=$Frozen.CandidateId; baseRevision=$Frozen.BaseRevision
        treeSha=$Frozen.Tree; deliveryTarget="refs/heads/$Branch" }
    if (Send-MoeEvidence 'record_candidate' $payload) { return $true }
    # A claim can supersede the attempt between the read above and the RPC.
    if (-not (Read-MoeAttempt $TaskId $script:MoeAttemptId $script:MoeAttemptGeneration)) { $script:MoeEvidenceUnavailable = $script:MoeAttemptReadError }
    return $false
}
function Read-MoeGateTail([string]$Path) {
    $stream = [IO.File]::OpenRead($Path)
    try {
        $count = [int][Math]::Min(16384, $stream.Length)
        $null = $stream.Seek(-$count, [IO.SeekOrigin]::End)
        $buffer = New-Object byte[] $count
        $offset = 0
        while ($offset -lt $count) {
            $read = $stream.Read($buffer, $offset, $count-$offset)
            if ($read -le 0) { throw 'truncated gate log' }; $offset += $read
        }
        # Skip only a partial UTF-8 prefix; never transmit half a character.
        $start = 0
        while ($start -lt $count -and ($buffer[$start] -band 0xC0) -eq 0x80) { $start++ }
        $text = [Text.Encoding]::UTF8.GetString($buffer,$start,$count-$start)
        while ([Text.Encoding]::UTF8.GetByteCount($text) -gt 16384) {
            $cut = if ([char]::IsHighSurrogate($text[0])) { 2 } else { 1 }
            $text = $text.Substring($cut)
        }
        return $text
    } finally { $stream.Dispose() }
}
function Send-MoeCheckRun([hashtable]$Frozen, [hashtable]$Gate) {
    $payload = @{ id=$Gate.CheckId; candidateId=$Frozen.CandidateId; treeSha=$Frozen.Tree
        command=$Gate.Command; exitCode=$Gate.ExitCode; outputTail=(Read-MoeGateTail $Gate.Log)
        runnerId=$script:MoeRunnerId; source='runner-observed'; workerId=$WorkerId }
    return (Send-MoeEvidence 'record_check_run' $payload)
}
# The delivery receipt: the landing's last daemon call, from a journaled report
# (Get-MoeReceiptJournalPath). Bookkeeping only: $false (a refusal, a lost
# answer) never rolls back, re-lands or stops the loop, and keeps the journal
# for the next pre-flight to replay. DELIVERY_RECEIPT_CONFLICT means a receipt
# already records this candidate's landing: logged, never retried. $true on
# either answer. A strong journal (its own profile verified-local) outlives an
# accepted receipt until its attempt is closed (CQ-V08b): Complete-MoePostflight
# or the next replay drops it. Twin: receipt_send.
function Send-MoeReceipt([string]$Path, $Report) {
    $payload = @{ candidateId=[string]$Report.candidateId; target=[string]$Report.target; targetBefore=[string]$Report.targetBefore
        targetAfter=[string]$Report.targetAfter; landedRevision=[string]$Report.landedRevision; workerId=$WorkerId }
    if ($null -ne $Report.pushResult) { $payload.pushResult = [string]$Report.pushResult }
    $ok = Send-MoeEvidence 'record_delivery_receipt' $payload
    $keep = $ok -and (Get-MoeProp $Report 'profile') -ceq 'verified-local'
    if (-not $ok -and $script:MoeRpcCodeName -ceq 'DELIVERY_RECEIPT_CONFLICT') {
        Write-Host "[WARN] candidate $($payload.candidateId) already has a delivery receipt that differs from this report; keeping the recorded one, not retrying." -ForegroundColor Yellow
        $ok = $true
    }
    if ($ok) {
        if ($Path -and -not $keep) { Remove-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue }
        return $true
    }
    Write-Host "[WARN] delivery receipt not recorded for candidate $($payload.candidateId); journal kept at $Path for the next pre-flight to replay." -ForegroundColor Yellow
    return $false
}
# The post-flight acknowledges only this seat's own FINALIZING attempt, under the
# identity pinned at claim time. A closed, running, reconciling, missing or
# no-longer-matching attempt is nothing to acknowledge: no RPC, and the loop
# goes on. A finalizing attempt with no pinned identity is never acknowledged,
# and it stops the loop, as an exhausted acknowledgement does: the daemon
# refuses this seat's next claim while an attempt of it is finalizing. The
# receipt replay passes a journal's attempt and worker instead.
function Get-MoePinnedAttemptPhase([string]$AttemptId = $script:MoeAttemptId, [string]$TaskId = $preflightTaskId, $Generation = $script:MoeAttemptGeneration, [string]$Worker = $WorkerId) {
    try {
        $a=[IO.File]::ReadAllText((Join-Path $projectPath ('.moe/attempts/'+$AttemptId+'.json'))) | ConvertFrom-Json -ErrorAction Stop
        if ($a.id -ceq $AttemptId -and $a.taskId -ceq $TaskId -and $a.workerId -ceq $Worker -and
            (Test-MoeGeneration $a.generation) -and $a.generation -eq $Generation -and $a.phase -is [string]) { return $a.phase }
    } catch { }
    return 'mismatch'
}
# This seat's finalizing attempts on the task. A sibling file that cannot be
# parsed is skipped, never fatal.
function Find-MoeSeatFinalizingAttempts {
    $ids = New-Object 'System.Collections.Generic.List[string]'
    try { $files = @(Get-ChildItem -LiteralPath (Join-Path $projectPath '.moe/attempts') -Filter '*.json' -ErrorAction Stop | Sort-Object Name) } catch { return @() }
    foreach ($f in $files) {
        try { $a = [IO.File]::ReadAllText($f.FullName) | ConvertFrom-Json -ErrorAction Stop } catch { continue }
        if ($a.taskId -ceq $preflightTaskId -and $a.workerId -ceq $WorkerId -and $a.phase -ceq 'finalizing') { $ids.Add([string]$a.id) }
    }
    return @($ids)
}
function Send-MoeFinalize([string]$Outcome, [string]$Sha = '') {
    if ($Role -ne 'worker' -or -not $preflightTaskId) { return $true }
    if (-not $script:MoeAttemptId -or $null -eq $script:MoeAttemptGeneration) {
        $ids = @(Find-MoeSeatFinalizingAttempts)
        if ($ids.Count -gt 0) {
            Write-Host "[WARN] finalize refused: finalizing attempt $($ids -join ' ') on task $preflightTaskId has no pinned identity; not acknowledging." -ForegroundColor Yellow
            return $false
        }
        Write-Host "[finalize] no finalizing attempt for this seat on task $preflightTaskId; nothing to acknowledge."
        return $true
    }
    $phase = Get-MoePinnedAttemptPhase
    if ($phase -ceq 'closed' -or $phase -ceq 'running') { return $true }
    if ($phase -cne 'finalizing') {
        Write-Host "[finalize] no finalizing attempt for this seat on task $preflightTaskId; nothing to acknowledge."
        return $true
    }
    $payload = @{ taskId=$preflightTaskId; attemptId=$script:MoeAttemptId; generation=$script:MoeAttemptGeneration
        workerId=$WorkerId; runnerId=$script:MoeRunnerId; outcome=$Outcome }
    if ($Outcome -eq 'landed') { $payload.landedRevision=$Sha }
    if (Send-MoeEvidence 'finalize_attempt' $payload 3) { return $true }
    Write-Host '[WARN] finalize_attempt acknowledgement exhausted; stopping new-task loop (no repeated Git effect).' -ForegroundColor Yellow
    return $false
}

# A journal's owed ledger row: absent, or {sessionId, role, status?} inside the
# bounds moe.record_commit takes. Twin: receipt_replay's validator.
function Test-MoeOwedLedger($Ledger) {
    if ($null -eq $Ledger) { return $true }
    return [bool]($Ledger -is [System.Management.Automation.PSCustomObject] -and
        $Ledger.sessionId -is [string] -and $Ledger.sessionId.Trim() -and $Ledger.sessionId.Length -le 255 -and
        $Ledger.role -is [string] -and $Ledger.role.Trim() -and $Ledger.role.Length -le 64 -and
        ($null -eq $Ledger.status -or $Ledger.status -is [string]))
}
# A worktree landing's journal (WT-08 local, WT-09 remote): no candidate, and its
# ledger is the exact committed row. Twin: receipt_journal_fields' wt field.
function Test-MoeWorktreeJournal($J) { return [bool]($null -ne $J -and $J.workspaceMode -ceq 'worktree' -and $J.publicationMode -cin 'local', 'remote') }
# Is $J, read from the journal file named $Name, well formed? Twin: receipt_journal_fields.
function Test-MoeReceiptJournal([string]$GitDir, [string]$Name, $J) {
    $rev = '^[0-9a-fA-F]{40}$'; $id = '^[A-Za-z0-9_-]{1,128}$'; $wt = Test-MoeWorktreeJournal $J; $l = $J.ledger
    return -not ($null -eq $J -or $Name -cne "$($J.taskId).json" -or -not (Get-MoeReceiptJournalPath $GitDir ([string]$J.taskId)) -or
        (-not $wt -and [string]$J.candidateId -cnotmatch $id) -or [string]$J.attemptId -cnotmatch $id -or -not (Test-MoeGeneration $J.generation) -or
        -not $J.workerId -or -not $J.target -or [string]$J.targetBefore -notmatch $rev -or
        [string]$J.targetAfter -notmatch $rev -or [string]$J.landedRevision -notmatch $rev -or -not (Test-MoeOwedLedger $l) -or
        ($J.profile -ceq 'verified-local' -and -not ($J.treeSha -is [string] -and $J.treeSha -match $rev)) -or
        ($wt -and -not ($(if ($J.publicationMode -ceq 'remote') { $null -eq $l.pushed } else { $l.pushed -is [bool] -and -not $l.pushed }) -and
            [string]$l.sha -ceq [string]$J.targetAfter -and [string]$l.ref -ceq [string]$J.target -and
            [string]$l.taskId -ceq [string]$J.taskId -and $l.outcome -ceq 'committed' -and $l.kind -ceq 'completion' -and
            $l.paths -is [array] -and $l.inferredPaths -is [array] -and $l.unattributedPaths -is [array])))
}
# Where a journal's target shows its landing: targetAfter itself, or the copy a
# pull --rebase in the push rewrote it into -- a commit after the CAS base that
# carries the landing's own Moe-Session and Moe-Kind: completion trailers (a
# session lands at most one completion, and its pre-flight recovery checkpoint
# is a wip commit already under the base). '' = the ref never moved; throws
# when git cannot answer. Twin: receipt_landed_as.
function Find-MoeJournaledLanding([string]$Top, $Journal) {
    $tip = Invoke-MoeGit -Top $Top -GitArgs @('rev-parse', '-q', '--verify', "$($Journal.target)^{commit}")
    if ($tip.Rc -eq 1) { return '' }
    if ($tip.Rc -ne 0) { throw "git rev-parse exited $($tip.Rc)" }
    $tipSha = ($tip.Out -join '').Trim()
    $anc = Invoke-MoeGit -Top $Top -GitArgs @('merge-base', '--is-ancestor', [string]$Journal.targetAfter, $tipSha)
    if ($anc.Rc -eq 0) { return [string]$Journal.targetAfter }
    if ($anc.Rc -ne 1) { throw "git merge-base --is-ancestor exited $($anc.Rc)" }
    $msg = Invoke-MoeGit -Top $Top -GitArgs @('log', '-1', '--format=%B', [string]$Journal.targetAfter)
    if ($msg.Rc -ne 0) { throw "git log exited $($msg.Rc)" }
    $sid = ''
    foreach ($line in $msg.Out) {
        if ($line.StartsWith('Moe-Session: ', [StringComparison]::Ordinal)) { $sid = $line.Substring(13).TrimEnd("`r"); break }
    }
    if (-not $sid) { return '' }
    $range = if ([string]$Journal.targetBefore -eq ('0' * 40)) { $tipSha } else { "$($Journal.targetBefore)..$tipSha" }
    $hit = Invoke-MoeGit -Top $Top -GitArgs @('log', '-n1', '--format=%H', '--fixed-strings', '--all-match', "--grep=Moe-Session: $sid", '--grep=Moe-Kind: completion', $range)
    if ($hit.Rc -ne 0) { throw "git log exited $($hit.Rc)" }
    $copy = ($hit.Out -join '').Trim()
    if ($copy) { Write-Host "[receipt] a pull --rebase rewrote $($Journal.targetAfter); $($Journal.target) carries it as $copy." -ForegroundColor Cyan }
    return $copy
}
# The committed ledger row a journal still owes, recorded for the commit git
# shows on the target (the daemon merges a repeated sha). pushed follows the
# journaled push result and is omitted while that is unknown. A worktree
# journal's ledger is the exact row, sent as it is but for workerId (the
# recording seat) and, once a remote one says 'pushed ', pushed. $true once
# moe.record_commit acknowledged it. Twin: receipt_ledger_send.
function Send-MoeOwedLedgerRow($Journal, [string]$Sha) {
    $l = $Journal.ledger; $push = $Journal.pushResult
    if (Test-MoeWorktreeJournal $Journal) {
        $row = @{}; foreach ($p in $l.PSObject.Properties) { $row[$p.Name] = $p.Value }
        $row.workerId = $WorkerId
        if ("$push" -clike 'pushed *') { $row.pushed = $true }
        $reply = Send-MoeRecordCommit $row
        return ($null -ne $reply -and (Get-MoeProp $reply 'success') -eq $true)
    }
    $t = [string]$Journal.target; $p = 'refs/heads/'
    $ownedRef = if ($t.StartsWith($p, [StringComparison]::Ordinal) -and $t.Length -gt $p.Length) { $t.Substring($p.Length) } else { $t }
    $row = @{ taskId=[string]$Journal.taskId; outcome='committed'; kind='completion'; sha=$Sha; ref=$ownedRef
        role=[string]$l.role; sessionId=[string]$l.sessionId; workerId=$WorkerId }
    if ($l.status) { $row.status = [string]$l.status }
    if ($null -eq $push -or "$push" -clike 'push failed: *') { $row.pushed = $false } elseif ("$push" -clike 'pushed *') { $row.pushed = $true }
    Write-Host "[receipt] recording the owed ledger row of task $($Journal.taskId): $Sha on $($Journal.target)" -ForegroundColor Cyan
    $reply = Send-MoeRecordCommit $row
    return ($null -ne $reply -and (Get-MoeProp $reply 'success') -eq $true)
}

# Crash replay of delivery receipts, run right AFTER the pre-flight claim: a
# seat's still-finalizing attempt makes that claim refuse (ATTEMPT_FINALIZING),
# which also keeps a single-shot run out of the taskless wait -- close the
# attempt first and the claim would answer "nothing claimable" and wait. For
# each journal whose task no other live session holds: git shows its revision
# on the target, or the copy a pull --rebase rewrote it into -> record the
# ledger row the journal still owes (then drop it from the journal, so a
# receipt refused from there on never re-sends it), re-send the journaled
# report verbatim, and close the journaled attempt as landed while it is still finalizing
# under the journal's worker, whichever seat replays (finalize_attempt is
# fenced by attempt id + generation); git shows neither -> the ref never
# moved, drop the journal (the baseline recovery owns those bytes). Reads git,
# never moves a ref, never re-freezes or re-gates. Each step is safe to
# repeat. Best-effort: a failure logs and keeps that journal. Twin: receipt_replay.
function Invoke-MoeReceiptReplay {
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        if (-not (Read-MoeCommitSettings).autoCommit) { return }
        $git = Get-MoeGitTop
        if ($null -eq $git) { return }
        $dir = Join-Path $git.GitDir 'moe/receipt'
        if (-not (Test-Path -LiteralPath $dir)) { return }
        foreach ($f in @(Get-ChildItem -LiteralPath $dir -Filter '*.json' -File)) {
            try {
                $j = $null
                try { $j = [IO.File]::ReadAllText($f.FullName) | ConvertFrom-Json -ErrorAction Stop } catch { }
                if (-not (Test-MoeReceiptJournal $git.GitDir $f.Name $j)) {
                    Write-Host "[WARN] receipt journal $($f.FullName) kept: malformed journal" -ForegroundColor Yellow
                    continue
                }
                $wt = Test-MoeWorktreeJournal $j
                if (Test-MoeLiveMarkerForeignLive $git.GitDir $j.taskId) { continue }
                if ($wt -and $j.publicationMode -ceq 'remote') {
                    # WT-09 (§2.6): origin settles the journaled C; nothing is merged, gated or built.
                    $t = ([string]$j.target) -creplace '^refs/heads/', ''; $after = [string]$j.targetAfter
                    $rc = Resolve-MoePushOutcome $git.Top $t ([string]$j.targetBefore) $after
                    if ($rc -eq 2) { Write-Host "[WARN] MOE_PUSH_OUTCOME_UNKNOWN: task $($j.taskId) -- $after is still unsettled on origin ($($script:MoePushDetail)); $($f.FullName) kept." -ForegroundColor Yellow; continue }
                    if ($rc -eq 1) {
                        # Drop only the journal read above: a live lander's next round may have rewritten it meanwhile (ponytail: the re-read and delete leave a millisecond window; a per-journal lock closes it).
                        $now = $null; try { $now = [IO.File]::ReadAllText($f.FullName) | ConvertFrom-Json -ErrorAction Stop } catch { }
                        if ($null -eq $now -or [string]$now.targetAfter -cne $after -or [string]$now.targetBefore -cne [string]$j.targetBefore) { Write-Host "[receipt] $($f.FullName) was rewritten or removed meanwhile; left to its lander." -ForegroundColor Cyan; continue }
                        Remove-Item -LiteralPath $f.FullName -Force
                        Write-Host "[WARN] MOE_PUSH_FAILED: task $($j.taskId) -- origin moved past $($j.targetBefore) without $after, which can never apply; dropped $($f.FullName) (attempt $($j.attemptId) stays finalizing)." -ForegroundColor Yellow; continue
                    }
                    Update-MoeLandTargetMirror $git.Top $t $after; $landedAs = $after
                } else { $landedAs = Find-MoeJournaledLanding $git.Top $j }
                # A worktree journal (WT-08) whose C is absent stays for the task's next
                # worktree landing to supersede; one whose C is there owes its exact row.
                if ($wt -and -not $landedAs) {
                    Write-Host "[receipt] $($j.target) does not contain $($j.targetAfter); $($f.FullName) kept until task $($j.taskId) lands again." -ForegroundColor Cyan
                    continue
                } elseif ($wt -and ($landedAs -cne [string]$j.targetAfter -or -not (Send-MoeOwedLedgerRow $j $landedAs))) {
                    Write-Host "[WARN] receipt journal $($f.FullName) kept: the completion row of $($j.targetAfter) on $($j.target) is not recorded" -ForegroundColor Yellow
                    continue
                }
                if (-not $landedAs) {
                    Write-Host "[receipt] $($j.target) does not contain $($j.targetAfter): that landing never moved the ref; dropping $($f.FullName)." -ForegroundColor Cyan
                    Remove-Item -LiteralPath $f.FullName -Force
                    continue
                }
                # CQ-V08: a strong journal's proof binds to its verified tree. A copy on
                # another tree is not that landing: keep the journal, send nothing. Twin: receipt_replay.
                if ($j.profile -ceq 'verified-local') {
                    $lt = Invoke-MoeGit -Top $git.Top -GitArgs @('rev-parse', "$landedAs^{tree}")
                    if ($lt.Rc -ne 0) {
                        Write-Host "[WARN] receipt journal $($f.FullName) kept: git rev-parse $landedAs^{tree} failed" -ForegroundColor Yellow; continue
                    }
                    $ltree = ($lt.Out -join '').Trim(); $tree = ([string]$j.treeSha).ToLowerInvariant()
                    if ($ltree -cne $tree) {
                        Write-Host "[WARN] MOE_DELIVERY_PROOF_NOT_TRANSFERRED: task $($j.taskId) -- $($j.target) carries the landing as $landedAs, whose tree $ltree is not the verified tree $tree; receipt journal $($f.FullName) kept, nothing recorded or finalized." -ForegroundColor Yellow
                        continue
                    }
                }
                Write-Host "[receipt] replaying the delivery receipt of task $($j.taskId) from $($f.FullName)" -ForegroundColor Cyan
                if ($null -ne $j.ledger -and -not $wt) {
                    if (-not (Send-MoeOwedLedgerRow $j $landedAs)) {
                        Write-Host "[WARN] receipt journal $($f.FullName) kept: moe.record_commit did not record the owed ledger row" -ForegroundColor Yellow; continue
                    }
                    $j.PSObject.Properties.Remove('ledger'); Write-MoeReceiptJournal $f.FullName $j
                }
                if (-not $wt -and -not (Send-MoeReceipt $f.FullName $j)) { continue }
                $phase = Get-MoePinnedAttemptPhase $j.attemptId $j.taskId $j.generation $j.workerId
                if ($phase -ceq 'finalizing') {
                    $closed = Send-MoeEvidence 'finalize_attempt' @{ taskId=[string]$j.taskId; attemptId=[string]$j.attemptId; generation=$j.generation
                        workerId=[string]$j.workerId; runnerId=$script:MoeRunnerId; outcome='landed'; landedRevision=$landedAs } 3
                    if (-not $closed) { Write-Host "[WARN] attempt $($j.attemptId) is still finalizing after its replayed receipt; its finalizing holds stay until it closes." -ForegroundColor Yellow; continue }
                    $phase = 'closed'
                }
                # CQ-V08b: a strong journal (kept past its accepted receipt) goes only
                # once its attempt is closed. Twin: receipt_replay.
                $strong = $j.profile -ceq 'verified-local'
                if ($strong -and -not $wt -and $phase -cne 'closed' -and (Test-Path -LiteralPath $f.FullName)) {
                    Write-Host "[WARN] receipt journal $($f.FullName) kept: attempt $($j.attemptId) of task $($j.taskId) is $phase, not closed; nothing finalized." -ForegroundColor Yellow
                    continue
                }
                if ($wt) { Remove-Item -LiteralPath $f.FullName -Force }
                elseif ($strong) { Remove-Item -LiteralPath $f.FullName -Force -ErrorAction SilentlyContinue }
            } catch {
                Write-Host "[WARN] receipt journal $($f.FullName) kept: $_" -ForegroundColor Yellow
            }
        }
    } catch {
        Write-Host "[WARN] receipt journal replay failed: $_; continuing." -ForegroundColor Yellow
    } finally {
        $ErrorActionPreference = $prev
    }
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
                    # PowerShell 6+ auto-converts ISO strings to DateTime. Read
                    # the original token with its bundled JSON reader so the
                    # canonical offset/precision survives on old 7.x too.
                    if ($rec.timestamp -is [datetime]) {
                        $reader = [Newtonsoft.Json.JsonTextReader]::new([System.IO.StringReader]::new($line))
                        try {
                            $reader.DateParseHandling = [Newtonsoft.Json.DateParseHandling]::None
                            $raw = [Newtonsoft.Json.Linq.JObject]::Load($reader)
                            $rec.timestamp = [string]$raw['timestamp']
                        } finally { $reader.Close() }
                    }
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
    return @{ ok = $true; content = $rec.content; sender = $rec.sender; channel = $rec.channel; timestamp = $rec.timestamp }
}

function New-MoeVerifiedMention {
    param([string]$ProjectPath, $Message)
    $stored = Get-MoeStoredMentionRecord -ProjectPath $ProjectPath -Channel $Message.channel -MessageId $Message.id
    # Identity comes from the store too, not just the body. An RPC response that
    # lied about `sender` could otherwise put words in a named teammate's mouth
    # while every byte of the body verified clean.
    $senderOut = if ($stored.ok -and $stored.sender -is [string]) { $stored.sender } else { $Message.sender }
    $channelOut = if ($stored.ok -and $stored.channel -is [string]) { $stored.channel } else { $Message.channel }
    # Historical messages need their stored time, never the RPC's claim of
    # freshness. Unavailable/non-string metadata remains explicitly unknown.
    $timestampOut = if ($stored.ok -and $stored.timestamp -is [string]) { $stored.timestamp } else { $null }
    if ($stored.ok) {
        $body = $stored.content
        $rpcBody = if ($Message.content -is [string]) { $Message.content } else { '' }
        # The daemon ends a cut copy with U+2026 and sets contentTruncated, so only
        # the copy without that mark can be a prefix of the stored body.
        $cutBody = if ($Message.contentTruncated -eq $true -and $rpcBody.EndsWith([string][char]0x2026, [System.StringComparison]::Ordinal)) { $rpcBody.Substring(0, $rpcBody.Length - 1) } else { $rpcBody }
        if ($body -eq $rpcBody) {
            $prov = 'VERIFIED'
        } elseif ($cutBody.Length -gt 0 -and $body.StartsWith($cutBody, [System.StringComparison]::Ordinal)) {
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
        timestamp  = $timestampOut
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
    # A timed-out stop retains the exact job object. Never overwrite it with
    # another helper, even though post-flight/CLI dispatch may continue.
    if ($script:CurrentHeartbeatJob) {
        Stop-HeartbeatSidecar
        if ($script:CurrentHeartbeatJob) { return $null }
    }
    $intervalSec = 60
    if ($env:MOE_HEARTBEAT_INTERVAL_SEC -match '^\d+$') { $intervalSec = [int]$env:MOE_HEARTBEAT_INTERVAL_SEC }
    # Default 24h, and the loop below also stops the moment this wrapper
    # process is gone. The old 2h ceiling silently ended the heartbeat under
    # every long LIVE session (a governor's chat_wait loop, an architect
    # planning several rows in one CLI, a QA mid-review): measured 2026-09-06,
    # two architects' lastActivityAt froze at exactly launch+2h and the
    # governor seat was deleted by the stale sweep twice while its CLI was
    # running. The daemon never auto-releases WORKING/PLANNING on idle, so a
    # longer heartbeat defeats nothing; it only stops live seats being reaped.
    $maxDurationSec = 86400
    if ($env:MOE_HEARTBEAT_MAX_DURATION_SEC -match '^\d+$') { $maxDurationSec = [int]$env:MOE_HEARTBEAT_MAX_DURATION_SEC }

    # This runner's identity, for the reattach below: the job is a separate
    # process and sees none of this script's variables.
    $pin = @{ RunnerId = [string]$script:MoeRunnerId; ProcessStartedAt = [string]$script:MoeProcessStartedAt; Host = [string]$script:MoeHost
        AccountId = [string]$script:AccountLeasedId; AccountSampleFile = [string]$script:AccountSampleFile }
    try {
        $script:CurrentHeartbeatJob = Start-Job -Name "moe-heartbeat-$WorkerId" -ScriptBlock {
            param($ProxyScript, $ProjectPath, $WorkerId, $IntervalSec, $MaxDurationSec, $WrapperPid, $Pin)
            $env:MOE_PROJECT_PATH = $ProjectPath
            # One tools/call through a fresh proxy: @{ Value = <parsed reply> }, or
            # @{ Refused = <codeName> } for a daemon refusal, or $null.
            function Send-SidecarRpc([string]$Name, [hashtable]$Arguments) {
                $rpc = @{ jsonrpc = "2.0"; id = 1; method = "tools/call"; params = @{ name = $Name; arguments = $Arguments } } | ConvertTo-Json -Depth 8 -Compress
                $lines = @($rpc | & node $ProxyScript 2>&1 | ForEach-Object { "$_" })
                for ($i = $lines.Count - 1; $i -ge 0; $i--) {
                    try { $d = $lines[$i] | ConvertFrom-Json -ErrorAction Stop } catch { continue }
                    if ($d.error) { if ($d.error.data.codeName) { return @{ Refused = [string]$d.error.data.codeName } }; return $null }
                    if ($d.result.content) { return @{ Value = ($d.result.content[0].text | ConvertFrom-Json -ErrorAction Stop) } }
                }
                return $null
            }
            $refused = [Collections.Generic.HashSet[string]]::new(); $noted = @{}; $sentSample = ''
            $deadline = (Get-Date).AddSeconds($MaxDurationSec)
            while ((Get-Date) -lt $deadline) {
                Start-Sleep -Seconds $IntervalSec
                # The wrapper that owns this job is gone (TerminateProcess leaves
                # no finally): stop heartbeating on behalf of a dead seat.
                if ($WrapperPid -and -not (Get-Process -Id $WrapperPid -ErrorAction SilentlyContinue)) { break }
                # Mid-run usage of the leased account, so the next lease sees a
                # window crossing the switch percent before this run ends.
                if ($Pin.AccountId) {
                    try {
                        $sample = [IO.File]::ReadAllText($Pin.AccountSampleFile)
                        if ($sample -and $sample -cne $sentSample) {
                            $usage = $sample | ConvertFrom-Json -ErrorAction Stop
                            if ([string]$usage.accountId -ceq $Pin.AccountId) {
                                $sent = Send-SidecarRpc 'moe.report_account_usage' @{ workerId = $WorkerId; accountId = $Pin.AccountId
                                    windows = $usage.windows; refused = ($usage.refused -eq $true) }
                                if ($sent -and $sent.Value) { $sentSample = $sample }
                            }
                        }
                    } catch {}
                }
                # A daemon restart parked this seat's attempt: the one the
                # wrapper pinned at claim time, or one the agent claimed inside
                # its session (moe-proxy stamps that claim with this wrapper's
                # identity). Reattach the attempt the answer names, with the
                # generation its record carries (the answer has none); the
                # daemon's identity check decides whether it is this process's.
                # Any other reason, or no identity to present, names nothing this
                # process may reattach: say so once. A refusal never heals, so it
                # is not asked again on every later ping. Lines surface when
                # Stop-HeartbeatSidecar receives the job.
                try {
                    $beat = Send-SidecarRpc 'moe.heartbeat' @{ workerId = $WorkerId }
                    if (-not ($beat -and $beat.Value -and $beat.Value.reattachRequired -eq $true)) { continue }
                    $reason = [string]$beat.Value.reason
                    if ($reason -ceq 'attempt-reconciling' -and $Pin.ProcessStartedAt) {
                        $id = [string]$beat.Value.attemptId
                        if ($id -cnotmatch '^[A-Za-z0-9_-]{1,128}$' -or $refused.Contains($id)) { continue }
                        $a = [IO.File]::ReadAllText((Join-Path $ProjectPath ".moe/attempts/$id.json")) | ConvertFrom-Json -ErrorAction Stop
                        $tid = [string]$a.taskId; $g = $a.generation
                        if ([string]$a.id -cne $id -or [string]$a.workerId -cne $WorkerId -or [string]$a.phase -cne 'reconciling' -or
                            -not (($g -is [int] -or $g -is [long]) -and $g -gt 0 -and $g -le 9007199254740991) -or $tid -cnotmatch '^[A-Za-z0-9_-]{1,128}$') { continue }
                        $r = Send-SidecarRpc 'moe.reattach_attempt' @{ taskId = $tid; workerId = $WorkerId; runnerId = $Pin.RunnerId
                            attemptId = $id; generation = $g; processStartedAt = $Pin.ProcessStartedAt; host = $Pin.Host }
                        if ($r -and $r.Value -and $r.Value.success -eq $true -and $r.Value.phase -ceq 'running') {
                            "[reattach] attempt $id (generation $g) on task $tid is running again after a daemon restart."
                        } elseif ($r -and $r.Refused) {
                            [void]$refused.Add($id)
                            "[reattach] moe.reattach_attempt refused for attempt $id ($($r.Refused)); not retrying it."
                        } else { "[WARN] moe.reattach_attempt got no answer for attempt $id; retrying later." }
                    } elseif (-not $noted.ContainsKey($reason)) {
                        $noted[$reason] = $true
                        "[reattach] heartbeat asks for reattachment ($reason) but this seat owns no reconciling attempt this wrapper can reattach; nothing to reattach."
                    }
                } catch {}
            }
        } -ArgumentList $ProxyScript, $ProjectPath, $WorkerId, $intervalSec, $maxDurationSec, $PID, $pin
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
    $ownedJob = $script:CurrentHeartbeatJob
    # PSRemotingJob has no StopJobAsync (including pwsh 7). Run its synchronous
    # StopJob in a dedicated runspace and bound OUR wait. Keep the pipeline
    # and exact job object on timeout: disposing/removing a live job can block
    # too, and spawning a new stop thread on each retry leaks threads.
    if (-not $script:HeartbeatStopper) {
        $pipeline = [PowerShell]::Create()
        try {
            $null = $pipeline.AddScript('param($ownedJob) $ownedJob.StopJob()').AddArgument($ownedJob)
            $pending = $pipeline.BeginInvoke()
            $script:HeartbeatStopper = @{ Job = $ownedJob; Pipeline = $pipeline; Pending = $pending }
        } catch {
            $pipeline.Dispose()
            Write-Host "[WARN] MOE_HEARTBEAT_STOP_TIMEOUT: could not request owned job stop; retaining ownership. $_" -ForegroundColor Yellow
            return
        }
    }
    $stopper = $script:HeartbeatStopper
    if ($stopper.Job -ne $ownedJob) {
        Write-Host '[WARN] MOE_HEARTBEAT_STOP_TIMEOUT: job ownership changed; no unrelated job will be stopped.' -ForegroundColor Yellow
        return
    }
    if (-not $stopper.Pending.AsyncWaitHandle.WaitOne(2000)) {
        Write-Host '[WARN] MOE_HEARTBEAT_STOP_TIMEOUT: owned job stop pending; retaining ownership, not blocking post-flight or starting a duplicate. Task and lease unchanged.' -ForegroundColor Yellow
        return
    }
    try { $null = $stopper.Pipeline.EndInvoke($stopper.Pending) } catch {}
    $stopper.Pipeline.Dispose()
    $script:HeartbeatStopper = $null
    if ([string]$ownedJob.State -notin @('Completed', 'Failed', 'Stopped')) {
        Write-Host '[WARN] MOE_HEARTBEAT_STOP_TIMEOUT: owned job is not terminal; retaining ownership.' -ForegroundColor Yellow
        return
    }
    # The sidecar's own lines (a reattach and its outcome) are buffered in the job.
    # Read the child job's output, not Receive-Job: on Windows PowerShell 5.1 that
    # throws "The Persistence Path does not exist" when the profile path is absent.
    try { @($ownedJob.ChildJobs | ForEach-Object { $_.Output }) | ForEach-Object { Write-Host ([string]$_) } } catch {}
    try { Remove-Job -Job $ownedJob -ErrorAction SilentlyContinue | Out-Null } catch {}
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
            # Own contested paths the landing held back (sh twin): visible before QA.
            if ($ll.Held) { $landingSummary += " held=$($ll.Held)" }
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
$script:MoeToolPending = [hashtable]::new([StringComparer]::Ordinal)
$script:MoeToolSettled = [hashtable]::new([StringComparer]::Ordinal)
$script:MoeToolHarvestSaturated = $false
# This session's pre-flight P rows (Invoke-MoePreflightBaseline); $null = none.
$script:MoePreflightEvidence = $null
# This session's whole pre-flight dirty snapshot as a key set; $null = none.
$script:MoePreflightDirty = $null

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
        undeclared = 'solo'; contested = 'skip-untouched'; exclude = @()
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
                    if ($c -is [string] -and (@('commit', 'skip', 'skip-untouched') -contains $c)) { $s.contested = $c }
                    $s.exclude = @(Get-MoeStringList (Get-MoeProp $attr 'exclude'))
                }
                $qg = Get-MoeProp $st 'qualityGate'
                # Trimmed here and only here, as the sh twin's settings reader and
                # delivery/policy.ts do: a blank value is no gate, and the command the
                # gate runs and records is the canonical one the policy matches on.
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
    $encoding = [Console]::OutputEncoding
    $ErrorActionPreference = 'Continue'
    try {
        [Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
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
        # Moe's delivery records hold SHA-1 ids only: a sha256 repository lands
        # nothing, exactly as a no-git one, and the wrapper says so once (a hot
        # reload starts over). See docs/CONFIGURATION.md autoCommit. Any other
        # answer proceeds: a git older than 2.29 echoes the unknown flag back,
        # and it cannot open a sha256 repository anyway. Twin: git_top.
        $format = & git -C $projectPath rev-parse --show-object-format 2>$null
        if ("$format".Trim() -ceq 'sha256') {
            if (-not $script:MoeObjectFormatWarned) {
                $script:MoeObjectFormatWarned = $true
                Write-Host "[WARN] MOE_COMMIT_REFUSED_OBJECT_FORMAT: $top uses the sha256 object format; Moe's delivery records hold SHA-1 ids only, so this seat lands nothing there, as in a no-git project." -ForegroundColor Yellow
            }
            return $null
        }
        return @{ Top = $top; GitDir = "$gitDir".Trim(); Rel = $rel }
    } catch {
        return $null
    } finally {
        [Console]::OutputEncoding = $encoding
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
    $encoding = [Console]::OutputEncoding
    if ($IndexFile) { $env:GIT_INDEX_FILE = $IndexFile }
    $out = @()
    $rc = 255
    try {
        [Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
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
        [Console]::OutputEncoding = $encoding
        $ErrorActionPreference = $prev
    }
    return @{ Out = $out; Rc = $rc }
}

# $true when refs/heads/moe/task/$TaskId is fully landed in $Ref: merging it
# into $Ref writes $Ref's own tree (design §1.7). Ancestry cannot be the test,
# because a worktree completion lands as a squash commit. Any failure (git <
# 2.38, an unknown ref, a conflict) is $false, not landed. WT-14 reuses it with
# $Ref = refs/heads/<target>. Twin: task_branch_landed.
function Test-MoeTaskBranchLanded([string]$Top, [string]$Ref, [string]$TaskId) {
    $merged = Invoke-MoeGit -Top $Top -GitArgs @('merge-tree', '--write-tree', $Ref, "refs/heads/moe/task/$TaskId")
    if ($merged.Rc -ne 0) { return $false }
    $tree = Invoke-MoeGit -Top $Top -GitArgs @('rev-parse', '--verify', '--quiet', "$Ref^{tree}")
    if ($tree.Rc -ne 0) { return $false }
    $t = "$(@($tree.Out) | Select-Object -First 1)"
    return ($t.Length -gt 0 -and "$(@($merged.Out) | Select-Object -First 1)" -ceq $t)
}

# Refuse this worker seat before any CLI launch: print the code, park the task
# with one moe.report_blocked, stop the sidecar and exit 1 (the pass's finally
# deregisters, as for MOE_CLI_ARGV_REJECTED). `exit` is flow control, so no
# catch swallows it. Twin: worktree_stop.
function Stop-MoeWorktreeSeat([string]$Code, [string]$Detail) {
    Write-Host "[ERROR] ${Code}: $Detail" -ForegroundColor Red
    $blocked = $null
    try { $blocked = Invoke-MoeRpc -Tool 'report_blocked' -Args @{ taskId = $preflightTaskId; workerId = $WorkerId; reason = "${Code}: $Detail" } } catch { $blocked = $null }
    if ($null -eq $blocked) { Write-Host "[WARN] moe.report_blocked failed for $preflightTaskId; the seat stops anyway." -ForegroundColor Yellow }
    Stop-HeartbeatSidecar
    exit 1
}

# The seat's workspace from the fresh claim (WT-01), else get_context (WT-02):
# @{ Mode = worktree|shared; Target; Foreign }. Foreign lists the task's
# checkpoint/completion commits recorded on any ref but its own branch and the
# target, the ref reduced to [A-Za-z0-9._/@-] for the refusal line. Twin: the
# python parse in provision_worktree, whose strip() also drops \x1c-\x1f.
function Get-MoeWorkspaceClaim($Claim, $Context, [string]$TaskId) {
    $ws = Get-MoeProp $Claim 'workspace'
    if ($ws -isnot [System.Management.Automation.PSCustomObject]) { $ws = Get-MoeProp $Context 'workspace' }
    if ($ws -isnot [System.Management.Automation.PSCustomObject]) { $ws = $null }
    $mode = Get-MoeProp $ws 'mode'
    $target = Get-MoeProp $ws 'target'
    $target = if ($target -is [string]) { $target -replace '^[\s\x1c-\x1f]+|[\s\x1c-\x1f]+\z', '' } else { '' }
    if ($target -match '[\x00-\x1f\x7f]') { $target = '?' }
    $own = @("moe/task/$TaskId", "refs/heads/moe/task/$TaskId", $target, "refs/heads/$target")
    $foreign = @()
    $task = Get-MoeProp $Context 'task'
    $commits = if ($task -is [System.Management.Automation.PSCustomObject]) { $task.PSObject.Properties['commits'] } else { $null }
    if ($commits -and $commits.Value -is [array]) {
        foreach ($r in $commits.Value) {
            if ($r -isnot [System.Management.Automation.PSCustomObject]) { continue }
            $kind = Get-MoeProp $r 'kind'; $sha = Get-MoeProp $r 'sha'; $ref = Get-MoeProp $r 'ref'
            if ($kind -isnot [string] -or @('checkpoint', 'completion') -cnotcontains $kind) { continue }
            if ($ref -isnot [string]) { $ref = '' }
            if ($sha -is [string] -and $sha -cmatch '^[0-9a-fA-F]{40}\z' -and $own -cnotcontains $ref) {
                $safe = $ref -creplace '[^A-Za-z0-9._/@-]', '_'
                $foreign += @{ Sha = $sha.ToLowerInvariant(); Ref = $(if ($safe) { $safe } else { '-' }) }
            }
        }
    }
    $isWorktree = $mode -is [string] -and $mode -ceq 'worktree'
    return @{ Mode = $(if ($isWorktree) { 'worktree' } else { 'shared' }); Target = $target; Foreign = $foreign }
}

# Worker pre-flight, design §1.1-§1.6. Shared mode refuses only an unlanded
# moe/task/<id> branch and touches nothing else (epic rail 4). Worktree mode
# runs the guards in order, then Install-MoeTaskWorktree; there is no fallback
# to the shared checkout. Any PowerShell error in worktree mode refuses too, so
# a throw never reaches the CLI launch. Twin: provision_worktree.
function Initialize-MoeWorktree([string]$TaskId, $Claim, $Context) {
    $ws = Get-MoeWorkspaceClaim $Claim $Context $TaskId
    if ($ws.Mode -cne 'worktree') {
        $git = Get-MoeGitTop
        if (-not $git) { return }
        $task = Invoke-MoeGit -Top $git.Top -GitArgs @('rev-parse', '--verify', '--quiet', "refs/heads/moe/task/$TaskId")
        if ($task.Rc -eq 0 -and -not (Test-MoeTaskBranchLanded $git.Top 'HEAD' $TaskId)) {
            Stop-MoeWorktreeSeat 'MOE_WORKTREE_MODE_MISMATCH' "shared-mode claim, but moe/task/$TaskId holds worktree bytes HEAD lacks; land or rescue that branch first"
        }
        return
    }
    try {
        $v = Invoke-MoeGit -Top $projectPath -GitArgs @('--version')
        $ver = if ($v.Rc -eq 0) { "$(@($v.Out) | Select-Object -First 1)" -creplace '^git version ', '' } else { '' }
        if (-not ($ver -cmatch '^([0-9]+)\.([0-9]+)') -or [long]$Matches[1] -lt 2 -or ([long]$Matches[1] -eq 2 -and [long]$Matches[2] -lt 38)) {
            Stop-MoeWorktreeSeat 'MOE_WORKTREE_UNSUPPORTED_GIT' "git $(if ($ver) { $ver } else { '(no version)' }) is older than 2.38; worktree mode needs git merge-tree --write-tree"
        }
        $git = Get-MoeGitTop
        if (-not $git -or $git.Rel) {
            Stop-MoeWorktreeSeat 'MOE_WORKTREE_PROJECT_NOT_TOP' "$projectPath is not the top level of a git work tree; worktree mode needs the project at the repository root"
        }
        $top = $git.Top; $target = $ws.Target
        $h = Invoke-MoeGit -Top $top -GitArgs @('symbolic-ref', '-q', 'HEAD')
        $head = if ($h.Rc -eq 0) { "$(@($h.Out) | Select-Object -First 1)".Trim() } else { '' }
        if ($head -cne 'refs/heads/moe/control') {
            Stop-MoeWorktreeSeat 'MOE_CONTROL_NOT_FOLLOWING' "the control checkout is on $(if ($head) { $head } else { 'a detached HEAD' }), not refs/heads/moe/control; switch it to moe/control first"
        }
        if (-not $target -or "$(@((Invoke-MoeGit -Top $top -GitArgs @('check-ref-format', '--branch', $target)).Out) | Select-Object -First 1)" -cne $target -or
            (Invoke-MoeGit -Top $top -GitArgs @('rev-parse', '--verify', '--quiet', "refs/heads/$target^{commit}")).Rc -ne 0) {
            Stop-MoeWorktreeSeat 'MOE_WORKTREE_CREATE_FAILED' "the claim's target '$target' is not a local branch"
        }
        foreach ($f in $ws.Foreign) {
            if ((Invoke-MoeGit -Top $top -GitArgs @('merge-base', '--is-ancestor', $f.Sha, "refs/heads/$target")).Rc -ne 0) {
                Stop-MoeWorktreeSeat 'MOE_WORKTREE_MODE_MISMATCH' "task commit $($f.Sha) on $($f.Ref) is not in $target; land or rescue the shared-mode bytes first"
            }
        }
        $w = "$top/.worktrees/$TaskId"
        if ($PSVersionTable.PSVersion.Major -le 5 -or $IsWindows) {
            # A failed ls-tree refuses: the budget is never assumed to fit.
            $ls = Invoke-MoeGit -Top $top -GitArgs @('ls-tree', '-r', '-z', '--name-only', "refs/heads/$target")
            if ($ls.Rc -ne 0) { Stop-MoeWorktreeSeat 'MOE_WORKTREE_CREATE_FAILED' "git ls-tree failed on $target; the Windows path budget cannot be checked" }
            $longest = 0
            foreach ($n in ($ls.Out -join "`n").Split([char]0)) { if ($n.Length -gt $longest) { $longest = $n.Length } }
            $lp = Invoke-MoeGit -Top $top -GitArgs @('config', '--bool', 'core.longpaths')
            if ($w.Length + 1 + $longest -gt 240 -and "$(@($lp.Out) | Select-Object -First 1)".Trim() -cne 'true') {
                Stop-MoeWorktreeSeat 'MOE_WORKTREE_PATH_TOO_LONG' "$w plus its longest path ($longest characters) is over 240 characters and core.longpaths is off"
            }
        }
        Install-MoeTaskWorktree $top $w "moe/task/$TaskId" $target $TaskId
    } catch {
        Stop-MoeWorktreeSeat 'MOE_WORKTREE_CREATE_FAILED' "worktree provisioning failed in PowerShell: $_"
    }
}

# Reuse, re-add or create the locked sparse worktree $W on $Branch, cut from the
# target (origin's in remote mode), then refuse a W holding .moe. It never deletes
# a branch, W/.moe, or a W it did not add in this session. Sets
# $script:MoeWt{Mode,Path,Branch,Target}. Twin: the second half of provision_worktree.
function Install-MoeTaskWorktree([string]$Top, [string]$W, [string]$Branch, [string]$Target, [string]$TaskId) {
    $last = { param($r) "$(@($r.Out) | Select-Object -Last 1)" }
    # W's registration, matched under Get-MoeComparableProjectPath (D:/x is /mnt/d/x).
    $list = Invoke-MoeGit -Top $Top -GitArgs @('worktree', 'list', '--porcelain', '-z')
    if ($list.Rc -ne 0) { Stop-MoeWorktreeSeat 'MOE_WORKTREE_CREATE_FAILED' "git worktree list failed in $Top" }
    $want = Get-MoeComparableProjectPath $W
    $recs = New-Object System.Collections.Generic.List[hashtable]
    foreach ($field in ($list.Out -join "`n").Split([char]0)) {
        if ($field.StartsWith('worktree ', [StringComparison]::Ordinal)) { $recs.Add(@{ Path = $field.Substring(9); Ref = '' }) }
        elseif ($field.StartsWith('branch ', [StringComparison]::Ordinal) -and $recs.Count) { $recs[$recs.Count - 1].Ref = $field.Substring(7) }
    }
    $hit = @($recs | Where-Object { [string]::Equals((Get-MoeComparableProjectPath $_.Path), $want, [StringComparison]::Ordinal) }) | Select-Object -First 1
    $added = $false; $finish = $false; $base = "refs/heads/$Target"
    if ($hit) {
        $verb = 'reused'
        if ($hit.Ref -cne "refs/heads/$Branch") {
            Stop-MoeWorktreeSeat 'MOE_WORKTREE_CREATE_FAILED' "$W is registered on $(if ($hit.Ref) { $hit.Ref } else { 'a detached HEAD' }), not refs/heads/$Branch"
        }
        if (-not [string]::Equals($hit.Path, $W, [StringComparison]::Ordinal)) {
            $r = Invoke-MoeGit -Top $Top -GitArgs @('worktree', 'repair', $W) -MergeStderr
            if ($r.Rc -ne 0) { Stop-MoeWorktreeSeat 'MOE_WORKTREE_CREATE_FAILED' "git worktree repair failed: $(& $last $r)" }
        }
        # No index file: a session died between the add and read-tree. Finish it, but
        # only a W holding nothing but .git: with no index, a sparse read-tree overwrites
        # a file already in W with HEAD's bytes and still exits 0.
        # An empty index proves nothing: an agent's `git rm -r .` empties one on purpose.
        $r = Invoke-MoeGit -Top $W -GitArgs @('rev-parse', '--path-format=absolute', '--git-path', 'index')
        $index = "$(@($r.Out) | Select-Object -First 1)"
        if ($r.Rc -ne 0 -or -not $index) { Stop-MoeWorktreeSeat 'MOE_WORKTREE_CREATE_FAILED' "git rev-parse failed in $W" }
        if (-not (Test-Path -LiteralPath $index)) {
            # -Force: Git for Windows marks .git Hidden, and a plain listing leaves it out.
            $names = @(Get-ChildItem -LiteralPath $W -Force -ErrorAction Stop | ForEach-Object { $_.Name })
            if ($names.Count -ne 1 -or $names[0] -cne '.git') {
                Stop-MoeWorktreeSeat 'MOE_WORKTREE_CREATE_FAILED' "$W has no index file but holds more than .git; a human must inspect it"
            }
            $finish = $true
        }
    } elseif ((Test-Path -LiteralPath $W) -or (Test-MoeSymlink $W)) {
        Stop-MoeWorktreeSeat 'MOE_WORKTREE_CREATE_FAILED' "$W exists but is not a registered worktree; a human must inspect it"
    } else {
        $added = $true
        if ((Invoke-MoeGit -Top $Top -GitArgs @('rev-parse', '--verify', '--quiet', "refs/heads/$Branch")).Rc -eq 0) {
            $verb = 're-added'
            $r = Invoke-MoeGit -Top $Top -GitArgs @('worktree', 'add', '--lock', '--reason', "moe $TaskId", '--no-checkout', $W, $Branch) -MergeStderr
        } else {
            $verb = 'created'
            if (-not (Test-MoeNoRemote $Top)) {
                # §1.2: remote mode cuts W from origin's target, fetched now (else as last fetched).
                if (-not (Invoke-MoeLandFetch $Top $Target)) { Write-Host "[WARN] MOE_LAND_FETCH_FAILED: git fetch origin $Target failed 3 times ($($script:MoeLandFetchErr)); W is cut from origin's $Target as last fetched." -ForegroundColor Yellow }
                $base = "refs/remotes/origin/$Target"
                if ((Invoke-MoeGit -Top $Top -GitArgs @('rev-parse', '-q', '--verify', "$base^{commit}")).Rc -ne 0) { Stop-MoeWorktreeSeat 'MOE_WORKTREE_CREATE_FAILED' "$base does not exist, so W cannot be cut from origin's $Target" }
            }
            $r = Invoke-MoeGit -Top $Top -GitArgs @('worktree', 'add', '--lock', '--reason', "moe $TaskId", '--no-checkout', '--no-track', '-b', $Branch, $W, $base) -MergeStderr
        }
        if ($r.Rc -ne 0) { Stop-MoeWorktreeSeat 'MOE_WORKTREE_CREATE_FAILED' "git worktree add failed: $(& $last $r)" }
    }
    if ($added -or $finish) {
        $r = Invoke-MoeGit -Top $W -GitArgs @('sparse-checkout', 'set', '--no-cone', '/*', '!/.moe/') -MergeStderr
        if ($r.Rc -eq 0) { $r = Invoke-MoeGit -Top $W -GitArgs @('read-tree', '-mu', 'HEAD') -MergeStderr }
        if ($r.Rc -ne 0) {
            if ($added) {
                $ahead = Invoke-MoeGit -Top $Top -GitArgs @('rev-list', '--count', "$base..refs/heads/$Branch")
                if ($ahead.Rc -eq 0 -and "$(@($ahead.Out) | Select-Object -First 1)".Trim() -ceq '0') { $null = Invoke-MoeGit -Top $Top -GitArgs @('worktree', 'remove', '--force', '--force', $W) }
            }
            Stop-MoeWorktreeSeat 'MOE_WORKTREE_CREATE_FAILED' "git sparse-checkout or read-tree failed in ${W}: $(& $last $r)"
        }
    }
    $dotMoe = Join-Path $W '.moe'
    if ((Test-Path -LiteralPath $dotMoe) -or (Test-MoeSymlink $dotMoe)) {
        Stop-MoeWorktreeSeat 'MOE_WORKTREE_MOE_PRESENT' "$W/.moe exists; a worktree never holds .moe files, so a human must inspect it"
    }
    $script:MoeWtMode = 'worktree'; $script:MoeWtPath = $W; $script:MoeWtBranch = $Branch; $script:MoeWtTarget = $Target
    Write-Host "[worktree] $verb $W on $Branch"
}

# Worktree mode, design §5.1/§5.2: the CLI runs in $script:cliRoot = W. Writes
# into W what the pre-flight writes into the control for this CLI (claude keeps
# its temp --mcp-config; the grok writer also trusts W), mirrors
# .moe/agents/*.md into W/.claude/agents and exports the worktree names;
# MOE_PROJECT_PATH stays the control. A failed write refuses the seat: nothing
# falls back to the control. Twin: prepare_worktree_launch.
function Initialize-MoeWorktreeLaunch([ref]$Context) {
    $script:cliRoot = $script:MoeWtPath
    $env:MOE_WORKTREE_PATH = $script:MoeWtPath; $env:MOE_TASK_BRANCH = $script:MoeWtBranch; $env:MOE_LAND_TARGET = $script:MoeWtTarget
    # Design §5.2-§5.4, §1.10: one node program, the same text in both wrappers (no
    # shell or PowerShell link primitives, so Windows gets junctions). It maps the
    # Serena root (the control becomes W; an override is kept, outside the control
    # with MOE_WORKTREE_SERENA_OUTSIDE), links W/.serena/memories and W/.claude/skills
    # to the control's, each recorded in <common gitdir>/moe/worktree/<taskId>.links
    # before it is made (MOE_WORKTREE_LINK_FAILED leaves every byte as it is), copies
    # .serena/project.yml with project_name <name>@<taskId>, and names each tracked
    # package-lock.json directory of W without node_modules (MOE_WORKTREE_DEPS_MISSING).
    # Prints those lines, then W, KEEP or OFF (no Serena: its memories link failed);
    # any other failure exits 1 with the detail as its last line.
    $js = @'
const fs = require('fs'), path = require('path'), cp = require('child_process');
const [ctl, w, sp, tid] = process.argv.slice(-4), win = process.platform === 'win32', out = [];
const key = p => { try { p = fs.realpathSync.native(p); } catch { p = path.resolve(p); } return win ? p.toLowerCase() : p; };
const within = (p, top) => { const r = path.relative(key(top), key(p)); return r !== '' && r !== '..' && !r.startsWith('..' + path.sep) && !path.isAbsolute(r); };
const lstat = f => { try { return fs.lstatSync(f); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } };
const git = (...a) => { const r = cp.spawnSync('git', a, { encoding: 'utf8' }); if (r.status !== 0) throw Error('git ' + a[2] + ' failed: ' + String(r.stderr || r.error).trim()); return r.stdout; };
const local = d => { if (!lstat(d)) fs.mkdirSync(d); if (!within(d, w)) throw Error(d + ' resolves outside ' + w); };
try {
    const mode = key(sp) === key(ctl) ? 'W' : 'KEEP', failed = [];
    if (mode === 'KEEP' && !within(sp, ctl)) out.push('MOE_WORKTREE_SERENA_OUTSIDE ' + sp + ' is outside ' + ctl + ', so Serena does not see this worktree');
    const man = path.join(git('-C', ctl, 'rev-parse', '--path-format=absolute', '--git-common-dir').trim(), 'moe', 'worktree', tid + '.links');
    for (const rel of ['.serena/memories', '.claude/skills']) {
        try {
            const src = path.resolve(ctl, rel), dst = path.join(w, rel);
            if (!fs.statSync(src).isDirectory()) throw Error(src + ' is not a directory');
            local(path.dirname(dst));
            const st = lstat(dst);
            if (st && !(st.isSymbolicLink() && key(dst) === key(src))) throw Error(dst + ' exists and is not a link to ' + src);
            if (!(lstat(man) ? fs.readFileSync(man, 'utf8').split('\n') : []).includes(rel)) {
                fs.mkdirSync(path.dirname(man), { recursive: true }); fs.appendFileSync(man, rel + '\n');
            }
            if (!st) fs.symlinkSync(src, dst, win ? 'junction' : 'dir');
            if (key(dst) !== key(src)) throw Error(dst + ' does not resolve to ' + src);
        } catch (e) { failed.push(rel); out.push('MOE_WORKTREE_LINK_FAILED ' + rel + ': ' + e.message); }
    }
    const yml = path.join(ctl, '.serena', 'project.yml'), text = lstat(yml) ? fs.readFileSync(yml, 'utf8') : null;
    if (text !== null) {
        const base = path.basename(path.resolve(ctl)), m = /^project_name:[ \t]*([^\r\n]*)/m.exec(text);
        const qualify = v => {
            let q = /^"((?:[^"\\]|\\.)*)"(\s*(?:#.*)?)$/.exec(v);
            if (q) return '"' + (q[1] || JSON.stringify(base).slice(1, -1)) + '@' + tid + '"' + q[2];
            q = /^'((?:[^']|'')*)'(\s*(?:#.*)?)$/.exec(v);
            if (q) return "'" + (q[1] || base.replace(/'/g, "''")) + '@' + tid + "'" + q[2];
            q = /^(.*?)(\s+#.*)?$/.exec(v);
            const name = q[1].trim();
            if (/^["'[\]{}&*!|>%@`]/.test(name)) throw Error('project_name in ' + yml + ' is not a plain or quoted scalar');
            return JSON.stringify((['', '~', 'null'].includes(name) ? base : name) + '@' + tid) + (q[2] || '');
        };
        const line = 'project_name: ' + (m ? qualify(m[1]) : JSON.stringify(base + '@' + tid));
        const body = m ? text.slice(0, m.index) + line + text.slice(m.index + m[0].length) : line + (text.includes('\r\n') ? '\r\n' : '\n') + text;
        const dst = path.join(w, '.serena', 'project.yml'), tmp = dst + '.' + process.pid + '.tmp';
        local(path.dirname(dst));
        const st = lstat(dst);
        if (st && !st.isFile()) throw Error(dst + ' is not a regular file');
        try { fs.writeFileSync(tmp, body, { flag: 'wx' }); fs.renameSync(tmp, dst); } catch (e) { fs.rmSync(tmp, { force: true }); throw e; }
    }
    const locks = git('-C', w, 'ls-files', '-z', '--cached', '--', 'package-lock.json', ':(glob)**/package-lock.json').split('\0');
    for (const d of new Set(locks.filter(f => path.posix.basename(f) === 'package-lock.json' && lstat(path.join(w, f))).map(f => path.posix.dirname(f)))) {
        const nm = lstat(path.join(w, d, 'node_modules'));
        if (!nm || !nm.isDirectory()) out.push('MOE_WORKTREE_DEPS_MISSING ' + d);
    }
    out.push(mode === 'W' && failed.includes('.serena/memories') ? 'OFF' : mode);
    process.stdout.write(out.join('\n'));
} catch (e) {
    process.stdout.write(out.concat(String((e && e.message) || e).replace(/\s+/g, ' ')).join('\n'));
    process.exit(1);
}
'@
    # Windows PowerShell 5.1 quotes a spaced argument without escaping, so a trailing \ would eat the quote: \. names the same directory.
    $nodeArgs = @("$projectPath", $script:cliRoot, $serenaProject, $preflightTaskId) | ForEach-Object { $_ -replace '\\$', '\.' }
    $out = @($js | & node - @nodeArgs)
    if ($LASTEXITCODE -ne 0) { Stop-MoeWorktreeSeat -Code MOE_WORKTREE_CREATE_FAILED -Detail "cannot prepare Serena, the shared links and the dependency check in $($script:cliRoot): $(@($out)[-1])" }
    if ($out.Count -gt 1) { $out[0..($out.Count - 2)] | ForEach-Object { Write-Host "[WARN] $_" -ForegroundColor Yellow } }
    $serenaProject = switch -CaseSensitive ($out[-1]) { 'W' { $script:cliRoot } 'KEEP' { $serenaProject } default { '' } }
    if (-not $serenaProject) {
        # No Serena (the writers below see this local $serenaPath), so no memory names to read through it.
        $serenaPath = $null
        $Context.Value = $Context.Value -replace '(?m)^memory_total=.*\r?\nmemory_this_task=.*\r?\nmemory_recent=.*', 'memory_total=0 (Serena is off for this launch: MOE_WORKTREE_LINK_FAILED .serena/memories)'
    }
    $Context.Value += "`n`nBefore testing a package in this worktree, run npm ci --prefer-offline in that package, plus npm run build where its tests require dist/."
    $what = "cannot write the $cliType config"; $at = Join-Path $script:cliRoot ".$cliType"
    try {
        switch ($cliType) {
            'codex' { Write-MoeCodexConfig -Root $script:cliRoot -SerenaProject $serenaProject }
            'gemini' { Write-MoeGeminiConfig -Root $script:cliRoot -SerenaProject $serenaProject }
            'grok' { Write-MoeGrokConfig -Root $script:cliRoot -SerenaProject $serenaProject }
        }
        # Claude's temp --mcp-config, for this launch only: the loop top writes the shared one back.
        $what = 'cannot write the claude MCP config'; $at = $mcpConfigFile
        $servers = @{ moe = $mcpConfigObj.mcpServers.moe }; $s = $mcpConfigObj.mcpServers.serena
        if ($serenaProject -and $s) {
            $a = $s.args.Clone(); $a[[array]::IndexOf($a, '--project') + 1] = $serenaProject
            $servers.serena = @{ command = $s.command; args = $a }
        }
        $script:MoeMcpConfigDirty = $true
        @{ mcpServers = $servers } | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $mcpConfigFile -Encoding UTF8
        $agentsSrc = Join-Path $moeDir 'agents'
        if ($enableAgentTeams -and (Test-Path -LiteralPath $agentsSrc)) {
            $what = 'cannot copy the subagents'; $at = Join-Path (Join-Path $script:cliRoot '.claude') 'agents'
            New-Item -ItemType Directory -Force -Path $at | Out-Null
            Get-ChildItem -LiteralPath $agentsSrc -File -Filter '*.md' | ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination $at -Force }
        }
    } catch {
        Stop-MoeWorktreeSeat -Code MOE_WORKTREE_CREATE_FAILED -Detail "$what (${at}): $($_.Exception.Message)"
    }
}

# $true only for a symbolic link (to a file, a directory or nothing). The
# attribute check comes first, so an ordinary file never pays for the link
# lookup; [IO.FileInfo] reads LinkType from the link itself, so a dangling link
# needs no provider existence check. Junctions and other reparse points keep
# the plain-path handling.
function Test-MoeSymlink([string]$FullPath) {
    try {
        if (-not ([IO.File]::GetAttributes($FullPath) -band [IO.FileAttributes]::ReparsePoint)) { return $false }
        return (([IO.FileInfo]$FullPath).LinkType -eq 'SymbolicLink')
    } catch {
        return $false   # GetAttributes throws on a missing path
    }
}

# The snapshot blob of TOP-relative $Path, the blob `git add` would store; ''
# when it cannot be hashed. A symlink is hashed by its link text: hash-object
# follows a link to its target's bytes, so a retarget to identical bytes read as
# unchanged, an edit to the target as a change to the link, and a dangling link
# failed the whole --stdin-paths batch. `update-index --add --info-only` into a
# throwaway index runs git's own add path (readlink; Git for Windows turns
# backslashes into slashes, which .Target keeps, so never hash .Target) and
# writes no object. Twin: moe_snapshot_hash.
function Get-MoeSnapshotBlob([string]$Top, [string]$Path) {
    if (-not (Test-MoeSymlink (Join-Path $Top $Path))) {
        $r = Invoke-MoeGit -Top $Top -GitArgs @('hash-object', '--', $Path)
        if ($r.Rc -ne 0) { return '' }
        return "$(@($r.Out) | Select-Object -First 1)".Trim()
    }
    # git rejects an empty index file, so the scratch path must not exist yet.
    $idx = Join-Path ([IO.Path]::GetTempPath()) ('moe-link-' + [guid]::NewGuid().ToString('N'))
    try {
        $u = Invoke-MoeGit -Top $Top -IndexFile $idx -GitArgs @('update-index', '--add', '--info-only', '--', $Path)
        if ($u.Rc -ne 0) { return '' }
        $ls = Invoke-MoeGit -Top $Top -IndexFile $idx -GitArgs @('ls-files', '-s', '--', ":(literal)$Path")
        if ($ls.Rc -ne 0) { return '' }
        $fields = @("$(@($ls.Out) | Select-Object -First 1)" -split '\s+')
        if ($fields.Count -lt 2) { return '' }
        return $fields[1]
    } catch {
        return ''
    } finally {
        Remove-Item -LiteralPath $idx -Force -ErrorAction SilentlyContinue
    }
}

# git status --porcelain=v1 -z (NUL-split, no quoting, no renames) + ONE
# hash-object --stdin-paths; a symlink is hashed alone, by its link text
# (Get-MoeSnapshotBlob). Returns hashtable pathKey -> @{Path; XY; Blob}
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
        $hashMap = @{}
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
            if (Test-MoeSymlink $full) {
                # Before Test-Path, which follows a link (a dangling one read as
                # deleted, one to a directory as a directory); never in the batch.
                $blob = ''
                $linkBlob = Get-MoeSnapshotBlob $Top $p
                if ($linkBlob) { $hashMap[(Get-MoePathKey $p)] = $linkBlob }
            } elseif (Test-Path -LiteralPath $full -PathType Leaf) {
                $blob = ''
                $toHash.Add($p)
            } elseif (Test-Path -LiteralPath $full) {
                # Directory / submodule entry: never attributable to a task.
                continue
            }
            $records += @{ Path = $p; XY = $xy; Blob = $blob }
        }
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

# TSV: header `#moe-baseline v1 task=<id> at=<iso> head=<sha> landed=<0|1> session=<sid>`,
# then `B<TAB><blob|D><TAB><path>` rows (dirty-before-the-task) and
# `U<TAB><blob><TAB><path>` rows (locally persisted unattributed set).
# `session` is the Moe-Session id (<workerId>@<pre-flight UTC second>) of the
# pre-flight that took this baseline. `landed=1` marks that session's
# completed landing (committed/nothing/refused), so the next pre-flight does
# not replay a "recovered" checkpoint; an absent field (older twin) means
# recover. Only three writers may put landed=1: that session's own landing, a
# recovery landing, or a landing that found no baseline
# (Get-MoeBaselineLandedFlag). A header with no session= (older twin) belongs
# to nobody. Twin: baseline_path / baseline_landed_flag.
# Evidence for MOE_ATTR_ASSERTED_FOREIGN (older readers skip both kinds):
# `P<TAB><blob|D><TAB><path>` = dirty at that session's pre-flight and not this
# task's own -- the snapshot a recovery landing judges its bytes against (no P
# rows at all = a baseline an older twin wrote: every byte counts as changed,
# as before). `C<TAB><blob|D><TAB><path>` = this task's own bytes a session
# left unlanded (importee-held, contested, checkpoints off); the next
# pre-flight reads them as the task's, not as foreign dirt, and drops the rows.
function Read-MoeBaseline([string]$Path) {
    if (-not $Path -or -not (Test-Path -LiteralPath $Path)) { return $null }
    $b = @{}
    $u = @{}
    $pre = @{}
    $carry = @{}
    $head = ''
    $at = ''
    $landed = $false
    $session = ''
    try {
        $utf8 = New-Object System.Text.UTF8Encoding($false)
        foreach ($line in [System.IO.File]::ReadAllLines($Path, $utf8)) {
            if (-not $line) { continue }
            if ($line.StartsWith('#')) {
                if ($line -match 'head=([0-9a-fA-F]+)') { $head = $matches[1] }
                if ($line -match 'at=(\S+)') { $at = $matches[1] }
                if ($line -match ' landed=1') { $landed = $true }
                if ($line -match ' session=(\S+)') { $session = $matches[1] }
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
            elseif ($kind -ceq 'P') { $pre[$k] = @{ Path = $p; Blob = $blob } }
            elseif ($kind -ceq 'C') { $carry[$k] = @{ Path = $p; Blob = $blob } }
        }
    } catch {
        return $null
    }
    return @{ Head = $head; At = $at; B = $b; U = $u; P = $pre; C = $carry; Landed = $landed; Session = $session }
}

function Write-MoeBaseline([string]$Path, [string]$TaskId, [string]$Head, [hashtable]$B, [hashtable]$U, [int]$Landed = 0, [string]$Session = '', [hashtable]$P = $null, [hashtable]$C = $null) {
    if (-not $Path) { return $false }
    try {
        $dir = Split-Path -Parent $Path
        if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
        $at = (Get-Date).ToUniversalTime().ToString("yyyy-MM-dd'T'HH:mm:ss'Z'")
        $sb = New-Object System.Text.StringBuilder
        [void]$sb.Append("#moe-baseline v1 task=$TaskId at=$at head=$Head landed=$Landed session=$Session`n")
        if ($B) { foreach ($k in ($B.Keys | Sort-Object)) { $r = $B[$k]; [void]$sb.Append("B`t$($r.Blob)`t$($r.Path)`n") } }
        if ($U) { foreach ($k in ($U.Keys | Sort-Object)) { $r = $U[$k]; [void]$sb.Append("U`t$($r.Blob)`t$($r.Path)`n") } }
        if ($P) { foreach ($k in ($P.Keys | Sort-Object)) { $r = $P[$k]; [void]$sb.Append("P`t$($r.Blob)`t$($r.Path)`n") } }
        if ($C) { foreach ($k in ($C.Keys | Sort-Object)) { $r = $C[$k]; [void]$sb.Append("C`t$($r.Blob)`t$($r.Path)`n") } }
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

# Delivery-receipt journal, beside the baseline. A gated completion writes its
# whole receipt report here BEFORE update-ref can move the target, rewrites it
# once the push resolved, and deletes it once moe.record_delivery_receipt holds
# the receipt. A crash between the ref move and that answer leaves the journal
# for Invoke-MoeReceiptReplay to re-send verbatim: a recomputed report is exactly
# what a replay conflicts on. Until moe.record_commit acknowledges the landing's
# committed ledger row, the journal also carries that owed row (`ledger`), for
# the replay to record before the receipt. Twin: receipt_journal_path / receipt_journal_write.
function Get-MoeReceiptJournalPath([string]$GitDir, [string]$TaskId) {
    if (-not $TaskId -or ($TaskId -notmatch '^[A-Za-z0-9_.-]+$')) { return '' }
    return (Join-Path $GitDir "moe/receipt/$TaskId.json")
}
# Atomic (temp + rename) and best-effort: an unwritable journal never blocks a landing.
function Write-MoeReceiptJournal([string]$Path, $Report) {
    if (-not $Path) { return }
    try {
        $dir = Split-Path -Parent $Path
        if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
        $tmp = "$Path.tmp.$PID"
        [IO.File]::WriteAllText($tmp, ($Report | ConvertTo-Json -Depth 5 -Compress), (New-Object Text.UTF8Encoding($false)))
        Move-Item -LiteralPath $tmp -Destination $Path -Force
    } catch {
        Remove-Item -LiteralPath "$Path.tmp.$PID" -Force -ErrorAction SilentlyContinue
        Write-Host "[WARN] receipt journal not written ($Path): $_; a crash before the receipt would leave this landing without one." -ForegroundColor Yellow
    }
}
# The strong profile's durable journal (CQ-V07): a WriteThrough tmp file flushed
# to disk, then an atomic rename over $Path (File.Replace when it exists: Move-Item
# -Force deletes first). .NET cannot fsync a directory; the rename's durability
# rests on the file system (NTFS journals it). A crash before the rename leaves
# only a *.tmp.* file, which nothing reads. $false on any failure, with the tmp
# file removed and $Path untouched: the caller then moves no ref.
# Twin: intent_journal_write.
function Write-MoeIntentJournal([string]$Path, $Report) {
    if (-not $Path) { return $false }
    $tmp = "$Path.tmp.$PID"
    try {
        [void][IO.Directory]::CreateDirectory((Split-Path -Parent $Path))
        $bytes = (New-Object Text.UTF8Encoding($false)).GetBytes(($Report | ConvertTo-Json -Depth 5 -Compress))
        $fs = New-Object IO.FileStream($tmp, [IO.FileMode]::Create, [IO.FileAccess]::Write, [IO.FileShare]::None, 4096, [IO.FileOptions]::WriteThrough)
        try { $fs.Write($bytes, 0, $bytes.Length); $fs.Flush($true) } finally { $fs.Dispose() }
        if ([IO.File]::Exists($Path)) { [IO.File]::Replace($tmp, $Path, $null) } else { [IO.File]::Move($tmp, $Path) }
        return $true
    } catch {
        Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
        return $false
    }
}

# The landed flag a landing writes back. It belongs to the session whose
# pre-flight took the baseline: on 2026-09-17 (task-49ec8755) QA's exit landing
# rewrote a live rework session's baseline to landed=1, and that session's
# crash was never recovered. So 1 only for that session's own landing, a
# recovery (the idle paths recover under a fresh sid per poll and would replay
# it forever) or a landing that found no baseline; any other landing keeps the
# header's flag. Twin: baseline_landed_flag.
function Get-MoeBaselineLandedFlag($Bl, [string]$Sid, [bool]$Recovered) {
    if ($null -eq $Bl -or $Recovered) { return 1 }
    if ($Bl.Session -and $Bl.Session -ceq $Sid) { return 1 }
    return [int]$Bl.Landed
}

# Flip an existing baseline's header to landed=1 in place. Called on the
# DELIBERATE mode='none' post-flight exit (checkpointCommits=false or a role
# with no landing) so the next pre-flight does not replay this session's edits
# as a "recovered" checkpoint the operator turned off. A sibling's deliberate
# exit must not mark another session's baseline landed, so the flag goes
# through Get-MoeBaselineLandedFlag. Twin: baseline_mark_landed. $Own (the
# session's own bytes, left dirty on purpose) becomes the C rows its next
# session lands; $null keeps the C rows the baseline has.
function Set-MoeBaselineLanded([string]$GitDir, [string]$TaskId, [string]$Sid, $Own = $null) {
    $p = Get-MoeBaselinePath $GitDir $TaskId
    if (-not $p -or -not (Test-Path -LiteralPath $p)) { return }
    $bl = Read-MoeBaseline $p
    if ($null -eq $bl) { return }
    $carry = if ($null -ne $Own) { Get-MoeCarryRows $Own @() } else { $bl.C }
    Write-MoeBaseline $p $TaskId $bl.Head $bl.B $bl.U (Get-MoeBaselineLandedFlag $bl $Sid $false) $bl.Session $bl.P $carry | Out-Null
}

# The C rows a baseline rewrite writes: $Own (Resolve-MoeAttribution's Own,
# Get-MoeOwnPaths) minus the paths this landing committed. Twin:
# baseline_extra_rows.
function Get-MoeCarryRows($Own, $LandedPaths) {
    $landedKeys = @{}
    foreach ($lp in @($LandedPaths)) { if ($lp) { $landedKeys[(Get-MoePathKey $lp)] = $true } }
    $carry = @{}
    foreach ($o in @($Own)) {
        if ($null -eq $o) { continue }
        $k = Get-MoePathKey $o.Path
        if (-not $landedKeys.ContainsKey($k)) { $carry[$k] = @{ Path = $o.Path; Blob = $o.Blob } }
    }
    return $carry
}

# ---- live-session marker ----------------------------------------------------
# `<gitdir>/moe/baseline/<taskId>.live`, a sibling of the per-task baseline,
# written by the pre-flight that takes that baseline and removed by every exit
# that ends this session's ownership of the task.
#
# It exists because the recovery predicate ("a baseline that never reached a
# completed landing") is true in TWO different worlds: the previous session
# crashed, and the previous session is STILL RUNNING and about to commit. On
# 2026-09-11 the second world cost two tasks their completion diffs — a QA seat
# claimed a REVIEW task inside the window between complete_task and the worker
# wrapper's post-flight, and its pre-flight landed the live worker's whole
# implementation as a `role=qa ... recovered` checkpoint. The marker is the
# only local fact that discriminates them: is the process that wrote it still
# running in this checkout.
#
# One header line, same shape as the baseline header:
#   #moe-live v1 task=<id> pid=<n> host=<h> ns=<n> worker=<id> session=<sid> start=<tok>
# `start` is a per-process start token, which is what makes the probe safe
# against process-id REUSE on a long-lived box. `ns` names the pid NAMESPACE
# the id belongs to: a Git Bash pid is invisible to Get-Process and vice versa,
# and a WSL seat and a Windows seat share this checkout through a mount with
# the SAME host name — without it a foreign-namespace id would be probed
# against the wrong process table and a live owner could read as dead, which is
# the byte-loss direction. Twin: the sh live_marker_* family.
function Get-MoeLiveMarkerPath([string]$GitDir, [string]$TaskId) {
    # The id reaches a path join: whitelist, never sanitise (same rule as
    # Get-MoeBaselinePath, whose sibling this is).
    if (-not $TaskId -or ($TaskId -notmatch '^[A-Za-z0-9_.-]+$')) { return '' }
    return (Join-Path $GitDir "moe/baseline/$TaskId.live")
}

function Get-MoeLiveMarkerHost { return ([string]$env:COMPUTERNAME).ToLowerInvariant() }
function Get-MoeLiveMarkerNs { return 'win32' }

# A stable per-process start token, or '' when it cannot be read (a protected
# process, or one that exited between the lookup and the property read). An
# empty token degrades the probe to identity alone — see Get-MoeLiveMarkerState.
function Get-MoeProcStartToken([int]$ProcId) {
    try {
        $p = Get-Process -Id $ProcId -ErrorAction SilentlyContinue
        if ($null -eq $p) { return '' }
        return ([string]$p.StartTime.ToUniversalTime().Ticks)
    } catch { return '' }
}

# Runner process identity: which process opened an attempt. Every claim this
# wrapper makes records it, so moe.reattach_attempt can match it after a daemon
# restart parks that attempt in `reconciling`. It is THIS wrapper process (it
# outlives every CLI respawn): <pid>@<start token> plus the host, the same pair
# the live-session marker names, computed ONCE -- the daemon compares exact
# strings, so a value this process could spell differently later would refuse
# every reattach. Both are sent or neither: a partial identity records something
# no reattach can ever reproduce. A match narrows WHICH process; it is never
# evidence that the process is alive. Twin: the same block in moe-agent.sh.
$script:MoeProcessStartedAt = ''; $script:MoeHost = ''; $claimRpcArgs = $claimJson | ConvertFrom-Json
$moeToken = Get-MoeProcStartToken $PID
$moeHostName = Get-MoeLiveMarkerHost
$moeIdentityWhy = if (-not $moeToken) { 'process start time unreadable' } elseif (-not $moeHostName) { 'hostname empty' } else { '' }
if (-not $moeIdentityWhy) {
    $moeToken = "$PID@$moeToken"
    if (@(($moeToken + $moeHostName).ToCharArray() | Where-Object { [char]::IsControl($_) }).Count -gt 0) { $moeIdentityWhy = 'control characters' }
    elseif ($moeToken.Length -gt 200 -or $moeHostName.Length -gt 255) { $moeIdentityWhy = 'too long' }
}
if ($moeIdentityWhy) {
    Write-Host "[WARN] Runner identity unavailable ($moeIdentityWhy); claims carry no processStartedAt/host, so this seat cannot reattach after a daemon restart." -ForegroundColor Yellow
} else {
    $script:MoeProcessStartedAt = $moeToken; $script:MoeHost = $moeHostName
    $claimRpcArgs | Add-Member -NotePropertyName processStartedAt -NotePropertyValue $moeToken
    $claimRpcArgs | Add-Member -NotePropertyName host -NotePropertyValue $moeHostName
    Write-Host "Runner identity: processStartedAt=$moeToken host=$moeHostName"
}
# Architect, QA and governor seats hand the identity to the CLI as well:
# moe-proxy adds it to a moe.claim_next_task that names none, so a row the
# agent claims inside its session (an architect plans several per CLI) records
# it too and the heartbeat sidecar can reattach that attempt after a daemon
# restart. Never for a worker: an identity on its attempt hands the finalize to
# this wrapper, which finalizes only the attempt it pinned, so an in-session
# worker claim would be left `finalizing`. Removed otherwise, so a value
# inherited from an outer seat never reaches this one. Twin: the same block in
# moe-agent.sh.
if ($script:MoeProcessStartedAt -and $Role -ne 'worker') {
    $env:MOE_RUNNER_PROCESS_STARTED_AT = $script:MoeProcessStartedAt; $env:MOE_RUNNER_HOST = $script:MoeHost
} else {
    Remove-Item Env:MOE_RUNNER_PROCESS_STARTED_AT, Env:MOE_RUNNER_HOST -ErrorAction SilentlyContinue
}

# Claim the task's dirty bytes for THIS session. Best-effort by design: a
# marker that cannot be written is a warning and the session proceeds. The
# marker prevents a misattributed commit; refusing to run without one would be
# strictly worse than the defect it prevents. Twin: live_marker_write.
$script:MoeLiveMarkerLine = ''
function Write-MoeLiveMarker([string]$GitDir, [string]$TaskId, [string]$Sid) {
    $script:MoeLiveMarkerLine = ''
    $f = Get-MoeLiveMarkerPath $GitDir $TaskId
    if (-not $f) { return }
    try {
        $dir = Split-Path -Parent $f
        if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
        $line = "#moe-live v1 task=$TaskId pid=$PID host=$(Get-MoeLiveMarkerHost) ns=$(Get-MoeLiveMarkerNs) worker=$WorkerId session=$Sid start=$(Get-MoeProcStartToken $PID)"
        # Per-process temp name (like the sh twin's `$f.tmp.$$`): two seats
        # claiming the same task in the same instant must not collide on it.
        $tmp = "$f.tmp.$PID"
        [System.IO.File]::WriteAllText($tmp, ($line + "`n"), (New-Object System.Text.UTF8Encoding($false)))
        Move-Item -LiteralPath $tmp -Destination $f -Force
        $script:MoeLiveMarkerLine = $line
    } catch {
        Remove-Item -LiteralPath "$f.tmp.$PID" -Force -ErrorAction SilentlyContinue
        Write-Host "[WARN] [attribution] could not write the live-session marker for ${TaskId}: $_ — a peer's pre-flight may recover this session's work as a checkpoint." -ForegroundColor Yellow
    }
}

# Drop OUR claim. Only ours: a byte-identical match against the line this
# session wrote. A peer that claimed the same task after us owns the file, and
# deleting its marker would re-arm the exact theft this mechanism prevents.
# Twin: live_marker_remove.
function Remove-MoeLiveMarker([string]$GitDir, [string]$TaskId) {
    if (-not $script:MoeLiveMarkerLine) { return }
    $f = Get-MoeLiveMarkerPath $GitDir $TaskId
    if (-not $f -or -not (Test-Path -LiteralPath $f)) { return }
    try {
        if ((Get-MoeLiveMarkerFirstLine $f) -eq $script:MoeLiveMarkerLine) {
            Remove-Item -LiteralPath $f -Force -ErrorAction SilentlyContinue
            $script:MoeLiveMarkerLine = ''
        }
    } catch {}
}

# Unconditional delete, ignoring ownership. Only two callers may use it: the
# DONE/ARCHIVED prune (the task is over — nothing left to protect) and the
# `stale` branch of the recovery gate (the owner is PROVEN gone). Never call it
# on a live owner. Guards the empty path a rejected task id produces, because
# Remove-Item -LiteralPath '' is a binding error -ErrorAction cannot swallow.
# Twin: live_marker_clear.
function Clear-MoeLiveMarkerFile([string]$GitDir, [string]$TaskId) {
    $f = Get-MoeLiveMarkerPath $GitDir $TaskId
    if (-not $f) { return }
    Remove-Item -LiteralPath $f -Force -ErrorAction SilentlyContinue
}

function Get-MoeLiveMarkerFirstLine([string]$Path) {
    try {
        foreach ($l in [System.IO.File]::ReadAllLines($Path)) { return $l }
    } catch { return '' }
    return ''
}

# Get-MoeLiveMarkerState — exactly one of:
#   none    no marker, or one we cannot parse -> recover (this is also every
#           task already in flight when this change lands)
#   self    our own process wrote it -> recover (the idle/resume paths re-enter
#           the pre-flight for a task this session already holds)
#   live    someone else's process is RUNNING and still matches its recorded
#           start token -> stand down
#   foreign the marker belongs to a host or pid namespace we cannot probe from
#           here -> stand down and say so; refusing to steal is recoverable by
#           a human, a wrong recovery is not
#   stale   the owner's process is gone, or the id was recycled (start token
#           mismatch) -> delete the marker and recover, exactly as before
# Also sets $script:MoeLiveOwner for the caller's message. Twin: live_marker_state.
$script:MoeLiveOwner = $null
function Get-MoeLiveMarkerState([string]$GitDir, [string]$TaskId) {
    $script:MoeLiveOwner = $null
    $f = Get-MoeLiveMarkerPath $GitDir $TaskId
    if (-not $f -or -not (Test-Path -LiteralPath $f)) { return 'none' }
    $line = Get-MoeLiveMarkerFirstLine $f
    if ($line -notlike '#moe-live v1 *') { return 'none' }
    $o = @{ ProcId = ''; MarkerHost = ''; Ns = ''; Worker = ''; Start = '' }
    if ($line -match ' pid=(\S+)')     { $o.ProcId = $matches[1] }
    if ($line -match ' host=(\S+)')    { $o.MarkerHost = $matches[1] }
    if ($line -match ' ns=(\S+)')      { $o.Ns = $matches[1] }
    if ($line -match ' worker=(\S+)')  { $o.Worker = $matches[1] }
    if ($line -match ' start=(\S+)')   { $o.Start = $matches[1] }
    if ($o.ProcId -notmatch '^\d+$') { return 'none' }
    $script:MoeLiveOwner = $o
    if ($o.MarkerHost -ne (Get-MoeLiveMarkerHost) -or $o.Ns -ne (Get-MoeLiveMarkerNs)) { return 'foreign' }
    if ([int]$o.ProcId -eq $PID) { return 'self' }
    $proc = $null
    try { $proc = Get-Process -Id ([int]$o.ProcId) -ErrorAction SilentlyContinue }
    catch {
        # The probe failed to ANSWER (a dead id returns $null instead). Treat
        # that as ALIVE: a needless stand-down is recoverable by a human, a
        # wrong recovery is the byte-loss class this exists to prevent.
        return 'live'
    }
    if ($null -eq $proc) { return 'stale' }
    # Same id, different process: a recycled id is not the owner. When either
    # side has no token the probe is identity-only and a running id counts as
    # the owner — the safe side.
    $now = ''
    try { $now = ([string]$proc.StartTime.ToUniversalTime().Ticks) } catch { return 'live' }
    if ($o.Start -and $now -and $o.Start -ne $now) { return 'stale' }
    return 'live'
}

# $true when SOMEONE ELSE still holds the task's bytes (running here, or on a
# host/namespace we cannot probe). Twin: live_marker_foreign_live.
function Test-MoeLiveMarkerForeignLive([string]$GitDir, [string]$TaskId) {
    $s = Get-MoeLiveMarkerState $GitDir $TaskId
    return ($s -eq 'live' -or $s -eq 'foreign')
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
        OwnerSet = $false; Owner = $null; Protected = $null; FinalizingSet = $false; Finalizing = $null
        Asserted = @(); Declared = @(); Planned = @(); TouchedFiles = @(); InferredPaths = @(); UnattributedPaths = @()
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
        # Raw, for Get-MoeOwnerGuard: an absent key is an unknown owner.
        $aw = $own.PSObject.Properties['assignedWorkerId']; if ($aw) { $scope.OwnerSet = $true; $scope.Owner = $aw.Value }
        $sets = Get-MoeTaskDeclaredSets $own
        $scope.Asserted = @($sets.Asserted)
        $scope.Declared = @(Get-MoeStringList (Get-MoeProp $own 'declaredFiles'))
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
            # TaskId: a path's first claimant; TaskIds: every contributing open
            # task in enumeration order; Editing: those with an IN_PROGRESS step
            # naming it. No activity data here, so any IN_PROGRESS step counts
            # (fail closed; sh twin).
            $editKeys = @()
            $steps2 = @()
            $plan2 = Get-MoeProp $peer 'implementationPlan'
            if ($plan2) { $steps2 = @($plan2) }
            foreach ($s in $steps2) {
                if ($null -eq $s -or (Get-MoeProp $s 'status') -ne 'IN_PROGRESS') { continue }
                foreach ($q in @(Get-MoeStringList (Get-MoeProp $s 'affectedFiles')) + @(Get-MoeStringList (Get-MoeProp $s 'newFiles')) + @(Get-MoeStringList (Get-MoeProp $s 'modifiedFiles'))) {
                    $editKeys += Get-MoePathKey (ConvertTo-MoeNormalPath $q)
                }
            }
            foreach ($p in @($psets.Asserted) + @($psets.Planned) + @(Get-MoeStringList (Get-MoeProp $peer 'touchedFiles'))) {
                $n = ConvertTo-MoeNormalPath $p
                if (-not $n) { continue }
                $k = Get-MoePathKey $n
                if (-not $scope.PeerDeclared.ContainsKey($k)) { $scope.PeerDeclared[$k] = @{ Path = $n; TaskId = $pid2; TaskIds = @(); Editing = @() } }
                $d = $scope.PeerDeclared[$k]
                if ($d.TaskIds -cnotcontains $pid2) {
                    $d.TaskIds += $pid2
                    if ($editKeys -ccontains $k) { $d.Editing += $pid2 }
                }
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
            OwnerSet = $false; Owner = $null; Protected = $null; FinalizingSet = $false; Finalizing = $null
            Asserted = @(); Declared = $null; Planned = @(); TouchedFiles = @(); InferredPaths = @(); UnattributedPaths = @()
            PeerDeclared = @{}; LivePeerIds = @(); LivePeerIdsKnown = $true; PeersActive = $false; ForceNever = $false
        }
        $t = Get-MoeProp $resp 'title'; if ($t -is [string]) { $scope.Title = $t }
        $st = Get-MoeProp $resp 'status'; if ($st -is [string]) { $scope.Status = $st }
        $rc = Get-MoeProp $resp 'reopenCount'; if ($rc) { try { $scope.ReopenCount = [int]$rc } catch {} }
        # Raw, for Get-MoeOwnerGuard: JSON null (unassigned) and an absent key differ.
        $aw = $resp.PSObject.Properties['assignedWorkerId']; if ($aw) { $scope.OwnerSet = $true; $scope.Owner = $aw.Value }
        $ap = $resp.PSObject.Properties['assigneeProtected']; if ($ap) { $scope.Protected = $ap.Value }
        # Raw, for Get-MoeOwnerGuard: JSON null (nothing finalizing) and an absent key (older daemon) differ.
        $fp = $resp.PSObject.Properties['finalizingAttempt']; if ($fp) { $scope.FinalizingSet = $true; $scope.Finalizing = $fp.Value }
        $scope.Asserted = @(Get-MoeStringList (Get-MoeProp $resp 'asserted'))
        # moe.declare_files, the part of asserted committed regardless of the
        # baseline. Absent (a daemon older than the field) stays $null, which
        # keeps that behaviour for every asserted path (sh twin: DECLARED).
        $declaredProp = $resp.PSObject.Properties['declared']
        if ($declaredProp -and $declaredProp.Value -is [array]) { $scope.Declared = @(Get-MoeStringList $declaredProp.Value) }
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
                # Idle: every entry for the key reports peerActive as a JSON
                # false. Absent or anything else (an older daemon) is active;
                # disk-scope entries carry no Idle at all (sh twin: PEER_IDLE).
                $pa2 = Get-MoeProp $e 'peerActive'
                $idle = ($pa2 -is [bool]) -and ($pa2 -eq $false)
                if (-not $scope.PeerDeclared.ContainsKey($k)) { $scope.PeerDeclared[$k] = @{ Path = $n; TaskId = [string]$pt; Idle = $idle; TaskIds = @([string]$pt); Editing = @() } }
                else { $scope.PeerDeclared[$k].Idle = ($scope.PeerDeclared[$k].Idle -and $idle) }
                # TaskIds: every contesting task (the first entry's taskId, then
                # each entry's taskIds); Editing: those mid-step on the path
                # (editingTaskIds). Read raw: Get-MoeProp unrolls ["x"] to "x"
                # and [] to $null. A missing or non-list field (an older daemon)
                # adds nothing, so it lands byte-for-byte as before (sh twin).
                $d = $scope.PeerDeclared[$k]
                $tp = $e.PSObject.Properties['taskIds']
                foreach ($t in @(if ($tp -and $tp.Value -is [array]) { Get-MoeStringList $tp.Value })) {
                    if ($t -and $d.TaskIds -cnotcontains $t) { $d.TaskIds += $t }
                }
                $ep = $e.PSObject.Properties['editingTaskIds']
                foreach ($t in @(if ($ep -and $ep.Value -is [array]) { Get-MoeStringList $ep.Value })) {
                    if ($d.Editing -cnotcontains $t) { $d.Editing += $t }
                }
                # Active: those with a session (activeTaskIds), set only when an
                # entry for the key carries that list (sh twin: PEER_ACTIVE_IDS).
                $ap = $e.PSObject.Properties['activeTaskIds']
                if ($ap -and $ap.Value -is [array]) {
                    if ($null -eq $d.Active) { $d.Active = @() }
                    foreach ($t in @(Get-MoeStringList $ap.Value)) {
                        if ($d.Active -cnotcontains $t) { $d.Active += $t }
                    }
                }
            }
        }
        return $scope
    }
    $disk = Get-MoeDiskScope $TaskId
    Write-Host "[attribution] moe.get_commit_scope unavailable; using the on-disk task records (declared paths only, peers presumed active)." -ForegroundColor Yellow
    return $disk
}

# May this session land the task's bytes? Fetches the postflight scope and
# returns @{ Code; Detail; Scope }, Code '' = it may; a failure in here is
# OWNER_UNKNOWN. Twin: landing_owner_guard; rule: **Owner guard** in scripts/CLAUDE.md.
# ponytail: the scope read and the landing CAS are two steps, not one atomic check.
function Get-MoeOwnerGuard([string]$TaskId, [string]$Sid) {
    $active = 'MOE_COMMIT_REFUSED_ACTIVE_ASSIGNEE'
    $g = @{ Code = 'MOE_COMMIT_REFUSED_OWNER_UNKNOWN'; Detail = 'the ownership check did not run'; Scope = $null }
    try {
        $s = Get-MoeCommitScope $TaskId 'postflight' $Sid
        $g.Scope = $s
        $owner = $s.Owner
        if (-not $s.OwnerSet -or $s.TaskId -cne $TaskId) { $g.Detail = 'its commit scope names no owner'; return $g }
        if ($null -ne $owner -and $owner -isnot [string]) { $g.Detail = 'its commit scope has a malformed owner'; return $g }
        if ($WorkerId -and $owner -ceq $WorkerId) { $g.Code = ''; $g.Detail = ''; return $g }
        if ($null -ne $owner) {
            if ($s.Source -ne 'rpc') { $g.Detail = "it is assigned to $owner and the daemon is unreachable"; return $g }
            if ($s.Protected -is [bool] -and $s.Protected) { $g.Code = $active; $g.Detail = "it is assigned to $owner, a live seat or one holding an open attempt"; return $g }
            if ($s.Protected -isnot [bool]) { $g.Detail = "it is assigned to $owner with no assigneeProtected answer"; return $g }
        }
        # get_commit_scope.finalizingAttempt decides when it is null or well-formed; an absent or
        # malformed field (older daemon) or the disk scope falls back to the records scan below.
        $fa = $s.Finalizing; $faId = Get-MoeProp $fa 'attemptId'; $faW = Get-MoeProp $fa 'workerId'
        if ($s.Source -eq 'rpc' -and $s.FinalizingSet -and ($null -eq $fa -or ($fa -is [System.Management.Automation.PSCustomObject] -and
                $faId -is [string] -and $faId.Trim() -and $faW -is [string] -and $faW.Trim() -and (Test-MoeGeneration (Get-MoeProp $fa 'generation'))))) {
            if ($null -ne $fa -and $faW -cne $WorkerId) { $g.Code = $active; $g.Detail = "attempt $faId of $faW is still finalizing"; return $g }
            $g.Code = ''; $g.Detail = ''; return $g
        }
        $files = @()
        try { $files = @(Get-ChildItem -LiteralPath (Join-Path $projectPath '.moe/attempts') -Filter '*.json' -ErrorAction Stop | Sort-Object Name) } catch { }
        foreach ($f in $files) {
            try { $a = [IO.File]::ReadAllText($f.FullName) | ConvertFrom-Json -ErrorAction Stop } catch { continue }
            if ($a -isnot [System.Management.Automation.PSCustomObject] -or $a.phase -isnot [string] -or $a.phase -cne 'finalizing' -or
                $a.taskId -isnot [string] -or $a.taskId -cne $TaskId) { continue }
            $aid = $a.id; $w = $a.workerId
            if ($aid -is [string] -and $aid.Trim() -and $w -is [string] -and $w.Trim() -and $w -cne $WorkerId -and (Test-MoeGeneration $a.generation)) {
                $g.Code = $active; $g.Detail = "attempt $aid of $w is still finalizing"; return $g
            }
        }
        $g.Code = ''; $g.Detail = ''
    } catch { $g.Code = 'MOE_COMMIT_REFUSED_OWNER_UNKNOWN'; $g.Detail = "the ownership check failed: $_" }
    return $g
}

# Record Get-MoeOwnerGuard's refusal (no sha, ref, push or path field); no byte,
# index entry, ref or baseline row is touched. Twin: landing_refuse_owner.
function Send-MoeOwnerRefusal([string]$TaskId, [string]$Kind, [string]$Status, [string]$Sid, [hashtable]$Guard, $CliExit = $null) {
    Write-Host "[WARN] $($Guard.Code): task $TaskId -- $($Guard.Detail); this session is not its owner, so it lands none of the task's bytes (tree and baseline left as they are)." -ForegroundColor Yellow
    $rec = @{ taskId = $TaskId; outcome = 'refused'; kind = $Kind; status = $Status; role = $Role; workerId = $WorkerId; sessionId = $Sid; code = $Guard.Code; message = $Guard.Detail }
    if ($null -ne $CliExit) { $rec.cliExitCode = $CliExit }
    Send-MoeRecordCommit $rec | Out-Null
}

# True when a wrapper- or daemon-written record names the task's profile
# verified-local (CQ-V08b): this session's pinned profile for its own task, the
# newest readable .moe/attempts record of the task (highest generation; an
# unreadable record is skipped, never trusted), or the task's receipt journal's
# own profile. Never an environment variable a CLI can set. Twin: strong_landing_task.
function Test-MoeStrongLandingTask([string]$TaskId, [string]$GitDir) {
    if ($TaskId -ceq $preflightTaskId -and $script:PinnedAttemptProfile -ceq 'verified-local') { return $true }
    $newest = $null; $strong = $false; $files = @()
    try { $files = @(Get-ChildItem -LiteralPath (Join-Path $projectPath '.moe/attempts') -Filter '*.json' -ErrorAction Stop) } catch { }
    foreach ($f in $files) {
        try { $a = [IO.File]::ReadAllText($f.FullName) | ConvertFrom-Json -ErrorAction Stop } catch { continue }
        $g = Get-MoeProp $a 'generation'
        if ((Get-MoeProp $a 'taskId') -cne $TaskId -or -not ($g -is [int] -or $g -is [long])) { continue }
        $s = (Get-MoeProp (Get-MoeProp $a 'executionPolicySnapshot') 'profile') -ceq 'verified-local'
        # A generation tie counts as strong: fail closed.
        if ($null -eq $newest -or $g -gt $newest -or ($g -eq $newest -and $s)) { $newest = $g; $strong = $s }
    }
    if ($strong) { return $true }
    $journal = Get-MoeReceiptJournalPath $GitDir $TaskId
    try { return [bool]($journal -and (Get-MoeProp ([IO.File]::ReadAllText($journal) | ConvertFrom-Json -ErrorAction Stop) 'profile') -ceq 'verified-local') } catch { return $false }
}

# Under the strong profile only a verified completion moves the target: record
# the checkpoint's refusal. No byte, index entry, ref, rescue ref or baseline
# row is touched, so the bytes stay for that completion. Twin: landing_refuse_strong.
function Send-MoeStrongRefusal([string]$TaskId, [string]$Kind, [string]$Status, [string]$Sid, [string]$Top, $CliExit = $null) {
    $branch = ''
    $r = Invoke-MoeGit -Top $Top -GitArgs @('symbolic-ref', '--short', '-q', 'HEAD')
    if ($r.Rc -eq 0) { $branch = ($r.Out -join '').Trim() }
    if (-not $branch) {
        $r = Invoke-MoeGit -Top $Top -GitArgs @('rev-parse', '--abbrev-ref', 'HEAD')
        if ($r.Rc -eq 0) { $branch = ($r.Out -join '').Trim() }
    }
    $detail = "it runs under the strong profile (verified-local), where only a verified completion moves $branch"
    Write-Host "[WARN] MOE_COMMIT_REFUSED_STRONG_CHECKPOINT: task $TaskId -- $detail; its bytes and baseline stay for that completion (no ref, rescue ref or index written)." -ForegroundColor Yellow
    $rec = @{ taskId = $TaskId; outcome = 'refused'; kind = $Kind; status = $Status; role = $Role; workerId = $WorkerId; sessionId = $Sid; code = 'MOE_COMMIT_REFUSED_STRONG_CHECKPOINT'; message = $detail }
    if ($null -ne $CliExit) { $rec.cliExitCode = $CliExit }
    Send-MoeRecordCommit $rec | Out-Null
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
        foreach ($pre in @('.codex/', '.gemini/', '.grok/', '.claude/agents/', '.worktrees/', '.moe-worktree', 'logs/moe-usage/')) {
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
# Resolve a relative import specifier against the importer's TOP-relative
# directory; '' when it escapes the repository.
function Resolve-MoeRelativeSpecifier([string]$Dir, [string]$Spec) {
    $parts = New-Object System.Collections.Generic.List[string]
    foreach ($seg in @($Dir -split '/')) { if ($seg) { $parts.Add($seg) } }
    foreach ($seg in @($Spec -split '/')) {
        if ($seg -eq '' -or $seg -eq '.') { continue }
        if ($seg -eq '..') {
            if ($parts.Count -eq 0) { return '' }
            $parts.RemoveAt($parts.Count - 1)
            continue
        }
        $parts.Add($seg)
    }
    return ($parts -join '/')
}

# TypeScript/Node resolution of one relative target: the literal path, the
# `.js -> .ts/.tsx/.mts/.cts` source behind an ESM bridge specifier, and the
# extensionless/index forms. Present when HEAD has it or it lands beside the
# importer in this same commit.
function Test-MoeImporteePresent([string]$Target, [hashtable]$Head, [hashtable]$Landing) {
    $ext = [System.IO.Path]::GetExtension($Target).ToLowerInvariant()
    $stem = if ($ext) { $Target.Substring(0, $Target.Length - $ext.Length) } else { $Target }
    $cands = @($Target)
    if ($ext -eq '.js') { $cands += @("$stem.ts", "$stem.tsx", "$stem.mts", "$stem.cts") }
    elseif ($ext -eq '.mjs') { $cands += @("$stem.mts") }
    elseif ($ext -eq '.cjs') { $cands += @("$stem.cts") }
    elseif ($ext -eq '.jsx') { $cands += @("$stem.tsx") }
    elseif ($ext -eq '') { $cands += @("$Target.ts", "$Target.tsx", "$Target.js", "$Target.mjs", "$Target.mts", "$Target/index.ts", "$Target/index.tsx", "$Target/index.js") }
    foreach ($c in $cands) {
        $k = Get-MoePathKey $c
        if ($Head.ContainsKey($k) -or $Landing.ContainsKey($k)) { return $true }
    }
    return $false
}

# Lex only literal module edges, without executing source or needing a project
# compiler. Strings/comments/regex/template text are opaque; ${...} is code.
# This is not a type checker: computed specifiers remain runtime expressions.
function Read-MoeJsxImportTokens([string]$Text, [ref]$Offset) {
    $items = New-Object 'System.Collections.Generic.List[object]'
    $depth = 0
    do {
        if ($Offset.Value -ge $Text.Length) { throw 'unparseable-source' }
        $ch = $Text[$Offset.Value]
        if ($ch -eq '{') {
            $Offset.Value++; $items.Add(@{ Kind='punct'; Value='(' })
            foreach ($token in @(Read-MoeImportTokens $Text $Offset $true $true)) { $items.Add($token) }
            $items.Add(@{ Kind='punct'; Value=')' }); continue
        }
        if ($ch -ne '<') { $Offset.Value++; continue }
        $Offset.Value++
        $closing = $Offset.Value -lt $Text.Length -and $Text[$Offset.Value] -eq '/'
        if ($closing) { $Offset.Value++ }
        $last = ''; $ended = $false
        while ($Offset.Value -lt $Text.Length) {
            $ch = $Text[$Offset.Value]; $Offset.Value++
            if ($ch -eq '"' -or $ch -eq "'") {
                $quote = $ch; $quoteClosed = $false
                while ($Offset.Value -lt $Text.Length) {
                    $ch = $Text[$Offset.Value]; $Offset.Value++
                    if ($ch -eq $quote) { $quoteClosed = $true; break }
                }
                if (-not $quoteClosed) { throw 'unparseable-source' }
            } elseif ($ch -eq '{') {
                $items.Add(@{ Kind='punct'; Value='(' })
                foreach ($token in @(Read-MoeImportTokens $Text $Offset $true $true)) { $items.Add($token) }
                $items.Add(@{ Kind='punct'; Value=')' })
            } elseif ($ch -eq '>') {
                if ($closing) { $depth-- } elseif ($last -ne '/') { $depth++ }
                $ended = $true; break
            }
            if (-not [char]::IsWhiteSpace($ch)) { $last = [string]$ch }
        }
        if (-not $ended) { throw 'unparseable-source' }
    } while ($depth -gt 0)
    $items.Add(@{ Kind='opaque'; Value='jsx' })
    return $items.ToArray()
}

function Read-MoeImportTokens([string]$Text, [ref]$Offset, [bool]$TemplateExpression = $false, [bool]$Jsx = $false) {
    $items = New-Object 'System.Collections.Generic.List[object]'
    $depth = 0
    while ($Offset.Value -lt $Text.Length) {
        $i = $Offset.Value; $ch = $Text[$i]
        if ([char]::IsWhiteSpace($ch)) { $Offset.Value++; continue }
        if ($TemplateExpression -and $ch -eq '}' -and $depth -eq 0) { $Offset.Value++; return $items.ToArray() }
        if ($ch -eq '/' -and $i + 1 -lt $Text.Length -and $Text[$i + 1] -eq '/') {
            while ($Offset.Value -lt $Text.Length -and $Text[$Offset.Value] -notin @("`r", "`n")) { $Offset.Value++ }
            continue
        }
        if ($ch -eq '/' -and $i + 1 -lt $Text.Length -and $Text[$i + 1] -eq '*') {
            $end = $Text.IndexOf('*/', $i + 2, [StringComparison]::Ordinal)
            if ($end -lt 0) { throw 'unparseable-source' }
            $Offset.Value = $end + 2; continue
        }
        if ($ch -eq '"' -or $ch -eq "'") {
            $quote = $ch; $value = New-Object Text.StringBuilder; $closed = $false; $Offset.Value++
            while ($Offset.Value -lt $Text.Length) {
                $ch = $Text[$Offset.Value]; $Offset.Value++
                if ($ch -eq $quote) { $closed = $true; break }
                if ($ch -eq "`r" -or $ch -eq "`n") { throw 'unparseable-source' }
                if ($ch -eq '\') {
                    if ($Offset.Value -ge $Text.Length) { throw 'unparseable-source' }
                    $ch = $Text[$Offset.Value]; $Offset.Value++
                    if ($ch -eq "`r" -or $ch -eq "`n") {
                        if ($ch -eq "`r" -and $Offset.Value -lt $Text.Length -and $Text[$Offset.Value] -eq "`n") { $Offset.Value++ }
                        continue
                    }
                    if ($ch -ceq 'x' -or $ch -ceq 'u') {
                        $count = if ($ch -ceq 'x') { 2 } else { 4 }
                        $start = $Offset.Value
                        if ($ch -ceq 'u' -and $start -lt $Text.Length -and $Text[$start] -eq '{') {
                            $start++; $end = $Text.IndexOf('}', $start); $count = $end - $start
                            if ($count -lt 1 -or $count -gt 6) { throw 'unparseable-source' }
                            $Offset.Value = $end + 1
                        } else { $Offset.Value += $count }
                        if ($start + $count -gt $Text.Length) { throw 'unparseable-source' }
                        $hex = $Text.Substring($start, $count)
                        if ($hex -notmatch '^[0-9a-fA-F]+$') { throw 'unparseable-source' }
                        $codepoint = [Convert]::ToInt32($hex, 16)
                        if ($codepoint -le 65535) { [void]$value.Append([char]$codepoint) }
                        else { [void]$value.Append([char]::ConvertFromUtf32($codepoint)) }
                        continue
                    }
                    $escaped = switch -CaseSensitive ([string]$ch) {
                        'n' { "`n" }; 'r' { "`r" }; 't' { "`t" }; 'b' { [string][char]8 }
                        'f' { [string][char]12 }; 'v' { [string][char]11 }; '0' { [string][char]0 }; default { [string]$ch }
                    }
                    [void]$value.Append($escaped); continue
                }
                [void]$value.Append($ch)
            }
            if (-not $closed) { throw 'unparseable-source' }
            $items.Add(@{ Kind='string'; Value=$value.ToString() }); continue
        }
        if ($ch -eq '`') {
            $Offset.Value++; $closed = $false
            while ($Offset.Value -lt $Text.Length) {
                $ch = $Text[$Offset.Value]; $Offset.Value++
                if ($ch -eq '\') { $Offset.Value++; continue }
                if ($ch -eq '`') { $closed = $true; break }
                if ($ch -eq '$' -and $Offset.Value -lt $Text.Length -and $Text[$Offset.Value] -eq '{') {
                    $Offset.Value++; $items.Add(@{ Kind='punct'; Value='(' })
                    foreach ($token in @(Read-MoeImportTokens $Text $Offset $true $Jsx)) { $items.Add($token) }
                    $items.Add(@{ Kind='punct'; Value=')' })
                }
            }
            if (-not $closed) { throw 'unparseable-source' }
            $items.Add(@{ Kind='opaque'; Value='template' }); continue
        }
        $prior = if ($items.Count) { $items[$items.Count - 1].Value } else { '' }
        if ($Jsx -and $ch -eq '<') {
            $remaining = $Text.Substring($i)
            $tag = [regex]::Match($remaining, '^<([A-Za-z][A-Za-z0-9_.:-]*)(?=[\s/>])')
            $isElement = $remaining.StartsWith('<>')
            if ($tag.Success) {
                $name = [regex]::Escape($tag.Groups[1].Value)
                $isElement = [regex]::IsMatch($remaining, ('</' + $name + '\s*>')) -or [regex]::IsMatch($remaining, '^<[^<>]*?/\s*>')
            }
            if ($isElement) {
                foreach ($token in @(Read-MoeJsxImportTokens $Text $Offset)) { $items.Add($token) }
                continue
            }
        }
        # '>' also ends an arrow (=>): its expression body may start with a
        # regex. Match the sh lexer; otherwise a quote inside /["]/ is read
        # as a string opener and valid asserted source is held as unparseable.
        if ($ch -eq '/' -and ($prior -eq '' -or $prior -cin @('(', '[', '{', '=', ',', ':', ';', '!', '?', '&', '|', '>', '+', '-', '*', 'return', 'throw', 'case', 'yield', 'await', 'void', 'typeof', 'delete', 'else', 'do'))) {
            $Offset.Value++; $inClass = $false; $closed = $false
            while ($Offset.Value -lt $Text.Length) {
                $ch = $Text[$Offset.Value]; $Offset.Value++
                if ($ch -eq '\') { $Offset.Value++; continue }
                if ($ch -eq "`r" -or $ch -eq "`n") { throw 'unparseable-source' }
                if ($ch -eq '[') { $inClass = $true }
                if ($ch -eq ']') { $inClass = $false }
                if ($ch -eq '/' -and -not $inClass) { $closed = $true; break }
            }
            if (-not $closed) { throw 'unparseable-source' }
            while ($Offset.Value -lt $Text.Length -and $Text[$Offset.Value] -match '[A-Za-z]') { $Offset.Value++ }
            $items.Add(@{ Kind='opaque'; Value='regex' }); continue
        }
        if ($ch -match '[A-Za-z_$]') {
            $Offset.Value++
            while ($Offset.Value -lt $Text.Length -and $Text[$Offset.Value] -match '[A-Za-z0-9_$]') { $Offset.Value++ }
            $items.Add(@{ Kind='id'; Value=$Text.Substring($i, $Offset.Value - $i) }); continue
        }
        if ($ch -eq '{') { $depth++ }
        if ($ch -eq '}') { $depth-- }
        $items.Add(@{ Kind='punct'; Value=[string]$ch }); $Offset.Value++
    }
    if ($TemplateExpression) { throw 'unparseable-source' }
    return $items.ToArray()
}

function Get-MoeRelativeImports([string]$Text, [bool]$Jsx = $false) {
    $offset = 0; $tokens = @(Read-MoeImportTokens $Text ([ref]$offset) $false $Jsx)
    for ($i = 0; $i -lt $tokens.Count; $i++) {
        $token = $tokens[$i]; $kind = $token.Value; $specifier = $null
        if ($token.Kind -ne 'id' -or $kind -cnotin @('import', 'export', 'require')) { continue }
        if ($i -gt 0 -and $tokens[$i - 1].Value -eq '.') { continue }
        if ($i + 1 -ge $tokens.Count) { continue }
        $next = $tokens[$i + 1]
        if ($kind -ceq 'import' -and $next.Kind -eq 'string') { $specifier = $next.Value }
        elseif ($kind -cin @('import', 'require') -and $next.Value -eq '(') {
            if ($i + 3 -lt $tokens.Count -and $tokens[$i + 2].Kind -eq 'string' -and $tokens[$i + 3].Value -in @(')', ',')) { $specifier = $tokens[$i + 2].Value }
        } elseif ($kind -cne 'require' -and ($kind -ceq 'import' -or $next.Value -cin @('{', '*', 'type'))) {
            for ($j = $i + 1; $j + 1 -lt $tokens.Count; $j++) {
                $current = $tokens[$j]
                if ($current.Value -cin @(';', '=', 'const', 'let', 'var', 'function', 'class', 'return', 'import', 'export')) { break }
                if ($current.Kind -eq 'id' -and $current.Value -ceq 'from' -and $tokens[$j + 1].Kind -eq 'string') { $specifier = $tokens[$j + 1].Value; break }
            }
        }
        if ($null -ne $specifier -and ($specifier.StartsWith('./') -or $specifier.StartsWith('../'))) { Write-Output $specifier }
    }
}

# IMPORTEE GUARD. For every landing source file, every relative `from "./x"`,
# `import("./x")` and `require("./x")` must resolve against HEAD plus the
# files landing in this same commit. Returns @{ <pathKey> = <first unresolved
# specifier> }. Measured 2026-09-06: five whole-file landings in one afternoon
# committed an importer whose importee was still untracked (a peer's in-flight
# module, or the task's own file left off the declaration), so HEAD stopped
# resolving for every clean checkout while every worktree looked fine.
function Get-MoeMissingImportees([hashtable]$Git, [array]$Candidates, [string]$BaseRef = 'HEAD', [string]$IndexFile = '') {
    $out = @{}
    $srcExt = @('.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs', '.jsx')
    $src = @()
    $landing = @{}
    foreach ($c in @($Candidates)) {
        if (-not $c -or $c.Blob -eq 'D') { continue }
        $landing[(Get-MoePathKey $c.Path)] = $true
        if ($c.Reason -eq 'BOARD') { continue }
        $e = [System.IO.Path]::GetExtension($c.Path).ToLowerInvariant()
        if ($srcExt -contains $e) { $src += $c }
    }
    if ($src.Count -eq 0) { return $out }
    $head = @{}
    if ($BaseRef) {
        $ls = Invoke-MoeGit -Top $Git.Top -GitArgs @('ls-tree', '-r', '--name-only', '-z', $BaseRef)
        if ($ls.Rc -ne 0) {
            # A proven unborn branch has an empty base; other read failures
            # cannot establish which imports the prospective tree will contain.
            $unborn = $false
            if ($BaseRef -eq 'HEAD') {
                $symbolic = Invoke-MoeGit -Top $Git.Top -GitArgs @('symbolic-ref', '--quiet', 'HEAD')
                if ($symbolic.Rc -eq 0 -and $symbolic.Out.Count -eq 1) {
                    $ref = Invoke-MoeGit -Top $Git.Top -GitArgs @('show-ref', '--verify', '--quiet', $symbolic.Out[0])
                    $unborn = $ref.Rc -eq 1
                }
            }
            if (-not $unborn) {
                foreach ($c in $src) { $out[(Get-MoePathKey $c.Path)] = '<head-unavailable>' }
                return $out
            }
        } else {
            foreach ($n in @(($ls.Out -join '').Split([char]0))) { if ($n) { $head[(Get-MoePathKey $n)] = $true } }
        }
    }
    foreach ($c in @($Candidates)) { if ($c -and $c.Blob -eq 'D') { $head.Remove((Get-MoePathKey $c.Path)) } }
    $imports = @{}
    foreach ($c in $src) {
        $full = Join-Path $Git.Top $c.Path
        $key = Get-MoePathKey $c.Path
        $jsx = [System.IO.Path]::GetExtension($c.Path).ToLowerInvariant() -in @('.tsx', '.jsx')
        try {
            if ($IndexFile) {
                $encoding = [Console]::OutputEncoding
                try {
                    [Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
                    $blob = Invoke-MoeGit -Top $Git.Top -IndexFile $IndexFile -GitArgs @('show', ":0:$($c.Path)")
                } finally { [Console]::OutputEncoding = $encoding }
                if ($blob.Rc -ne 0) { throw 'unparseable-source' }
                $text = $blob.Out -join "`n"
            } else { $text = [System.IO.File]::ReadAllText($full) }
            $imports[$key] = @(Get-MoeRelativeImports $text $jsx)
        }
        catch { $out[$key] = '<unparseable-source>'; $landing.Remove($key) }
    }
    # Removing an untracked dependency can invalidate earlier importers. Repeat
    # until stable; valid cycles remain intact, and a held tracked edit may fall
    # back to the version already in HEAD. Selected deletions never count.
    do {
        $removed = $false
        foreach ($c in $src) {
            $key = Get-MoePathKey $c.Path
            if ($out.ContainsKey($key)) { continue }
            $dir = ([System.IO.Path]::GetDirectoryName($c.Path) -replace '\\', '/')
            foreach ($spec in $imports[$key]) {
                $target = Resolve-MoeRelativeSpecifier $dir $spec
                if ($target -and (Test-MoeImporteePresent $target $head $landing)) { continue }
                $out[$key] = $spec; $landing.Remove($key); $removed = $true; break
            }
        }
    } while ($removed)
    return $out
}

# This task produced a dirty path's bytes: its session's editing tools wrote
# them, or they differ from what was already dirty when the session whose
# bytes land started ($Evidence = that session's P rows, pathKey -> @{Path;
# Blob}; unlike B, whose blobs can be days older than the session, these are
# its own pre-flight snapshot). $null evidence (a pre-flight that could not
# snapshot) fails closed: only TOOL counts. Twin: resolve_attribution own_bytes.
function Test-MoeOwnBytes([string]$Key, [string]$Blob, [hashtable]$Tool, $Evidence) {
    if ($Tool -and $Tool.ContainsKey($Key)) { return $true }
    if ($null -eq $Evidence) { return $false }
    return (-not $Evidence.ContainsKey($Key)) -or ($Evidence[$Key].Blob -cne $Blob)
}

# The dirty paths outside the DENY list whose bytes this task can vouch for
# (Test-MoeOwnBytes). A baseline rewrite carries the unlanded ones to the
# task's next session as C rows. Twin: resolve_attribution's `own`.
function Get-MoeOwnPaths([hashtable]$S, [hashtable]$Tool, $Evidence, [string]$Rel, [hashtable]$Settings) {
    foreach ($k in ($S.Keys | Sort-Object)) {
        $e = $S[$k]
        if ((Test-MoeDenyPath $e.Path $e.XY $Rel $Settings) -or -not (Test-MoeOwnBytes $k $e.Blob $Tool $Evidence)) { continue }
        Write-Output @{ Path = $e.Path; Blob = $e.Blob }
    }
}

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
        [string]$PolicyOverride = '',
        $Evidence = $null,
        $PreflightDirty = $null
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
    # moe.declare_files: the part of ASSERTED committed regardless of the
    # baseline. $null = a daemon older than the field, which keeps that
    # behaviour for every ASSERTED path (sh twin: DECLARED).
    $declared = $null
    if ($null -ne $Scope.Declared) {
        $declared = @{}
        foreach ($p in @($Scope.Declared)) { $tp = ConvertTo-MoeTopPath $p $rel; if ($tp) { $declared[(Get-MoePathKey $tp)] = $true } }
    }
    $planned = @{}
    foreach ($p in @($Scope.Planned)) { $tp = ConvertTo-MoeTopPath $p $rel; if ($tp) { $k = Get-MoePathKey $tp; if (-not $asserted.ContainsKey($k)) { $planned[$k] = $tp } } }
    $peer = @{}
    $peerIdle = @{}
    # $peerIds: every contesting task, the first claimant first; $peerEditing:
    # those mid-step on the path with a live session. An entry without the
    # keys (a hand-built scope) acts as @(TaskId) and @(): test $null before
    # @(...), since @($null) is one element (sh twin: PEER_IDS, PEER_EDITING).
    # $peerOrder: $peerIds in cause order -- editing, then active, then the
    # rest, each in $peerIds order -- so contested rows, trailers and held=
    # name the cause first (at 8f62fa0f held= named idle task-001d8ab3 while
    # live task-1e7f5a2d held the path). Built from $peerIds only; without
    # Active (an older daemon, the disk fallback) $peerIds order (sh twin:
    # peer_order). Explicit passes: Sort-Object is not stable in PS 5.1.
    $peerIds = @{}
    $peerEditing = @{}
    $peerOrder = @{}
    foreach ($k in $Scope.PeerDeclared.Keys) {
        $d = $Scope.PeerDeclared[$k]
        $tk = Get-MoePathKey "$rel$($d.Path)"
        $peer[$tk] = $d.TaskId
        $peerIdle[$tk] = ($d.Idle -eq $true)
        $peerIds[$tk] = @($d.TaskId)
        if ($null -ne $d.TaskIds) { $peerIds[$tk] = @($d.TaskIds) }
        $peerEditing[$tk] = @()
        if ($null -ne $d.Editing) { $peerEditing[$tk] = @($d.Editing) }
        $ids = $peerIds[$tk]; $ed = $peerEditing[$tk]
        $peerOrder[$tk] = $ids
        if ($null -ne $d.Active) {
            $ac = @($d.Active)
            $peerOrder[$tk] = @(@($ids | Where-Object { $ed -ccontains $_ }) +
                @($ids | Where-Object { $ed -cnotcontains $_ -and $ac -ccontains $_ }) +
                @($ids | Where-Object { $ed -cnotcontains $_ -and $ac -cnotcontains $_ }))
        }
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
    $assertedForeign = 0
    $own = @(Get-MoeOwnPaths $S $Tool $Evidence $rel $Settings)

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
                $order = $peerOrder[$k]
                foreach ($t in $order) { $contested += @{ Path = $p; TaskId = $t } }
                if ($contestedPolicy -eq 'skip') {
                    $skipped += @{ Path = $p; Code = 'MOE_ATTR_CONTESTED' }
                    continue
                }
                # A contesting task mid-step on the path holds it even when this
                # session's tool wrote it: completion e67ca0e swept such a peer's
                # unfinished hunks. This only adds holds (sh twin).
                if ($contestedPolicy -eq 'skip-untouched' -and $peerEditing[$k].Count -gt 0) {
                    $skipped += @{ Path = $p; Code = "MOE_ATTR_CONTESTED_EDITING($($peerEditing[$k][0]))" }
                    continue
                }
                # 'skip-untouched' (the default since 2026-09-06): a contested
                # path lands only when THIS session's editing tools wrote it. A
                # declared path a live peer also declares, that nobody here
                # touched, carries the PEER's unlanded hunks -- whole-file
                # landings of exactly that shape tore the shared branch five
                # times in one afternoon. Left dirty, it lands at the peer's
                # exit or at this task's next session that edits it.
                # Idle-peer exception: a path clean at this session's pre-flight,
                # whose every contesting task has had no session since (no active
                # assignee, open attempt or attempt phase change), holds only this
                # session's bytes (a Bash or python edit leaves no TOOL witness).
                # A path already dirty at pre-flight stays held even if this
                # session rewrote it: it can carry the peer's earlier hunks.
                $idleClean = ($null -ne $PreflightDirty) -and -not $PreflightDirty.ContainsKey($k) -and ($peerIdle[$k] -eq $true)
                if ($contestedPolicy -eq 'skip-untouched' -and -not $Tool.ContainsKey($k) -and -not $idleClean) {
                    $skipped += @{ Path = $p; Code = "MOE_ATTR_CONTESTED_UNTOUCHED($($order[0]))" }
                    continue
                }
            }
            # Asserted only by history (filesModified, completed steps, prior
            # commits, touchedFiles -- never declare_files): a claim on the
            # PATH, not on whatever bytes sit in it now. Bytes that were already
            # dirty when the session started and are untouched since are
            # someone else's (2026-09-30: a foreign edit to a delivered file
            # landed under the task whose filesModified named it) -- skipped,
            # never staged. Twin: resolve_attribution.
            if ($null -ne $declared -and $asserted.ContainsKey($k) -and -not $declared.ContainsKey($k) -and -not $isOwnMemory -and
                -not (Test-MoeOwnBytes $k $blob $Tool $Evidence)) {
                $skipped += @{ Path = $p; Code = 'MOE_ATTR_ASSERTED_FOREIGN' }
                $assertedForeign++
                continue
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

    # IMPORTEE GUARD: never land a source file whose relative imports HEAD
    # cannot resolve after this commit (see Get-MoeMissingImportees). The
    # path stays dirty, is reported as unattributed so the governors see it,
    # and lands at the next exit once its importee is in HEAD or declared.
    $importeeMissing = Get-MoeMissingImportees -Git $Git -Candidates $candidates
    if ($importeeMissing.Count -gt 0) {
        $keep = @()
        foreach ($c in @($candidates)) {
            $ck = Get-MoePathKey $c.Path
            if ($importeeMissing.ContainsKey($ck)) {
                $skipped += @{ Path = $c.Path; Code = "MOE_ATTR_IMPORTEE_MISSING($($importeeMissing[$ck]))" }
                $unattributed += @{ Path = $c.Path; Blob = $c.Blob }
            } else {
                $keep += $c
            }
        }
        $candidates = @($keep)
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
        Undeclared = $undeclared; Own = @($own); AssertedForeignCount = $assertedForeign
    }
}

# The own contested paths a landing held back, as `<path>(<peer>)` joined by
# ',', at most 5 then `,+<N> more`, then one MOE_CONTESTED_HELD remedy: the
# strict sentence, else one clause per held kind (untouched, then editing),
# then which sessions leave a TOOL witness, before the closing sentence (sh
# twin: attr_held_list). Feeds the session-ended line's held= suffix; a
# missing Skipped/Contested gives ''.
function Get-MoeHeldList($Attr) {
    $held = @()
    $strict = $false
    $untouched = $false
    $editing = $false
    foreach ($sk in @($Attr.Skipped)) {
        if ($null -eq $sk) { continue }
        if ($sk.Code -match '^MOE_ATTR_CONTESTED_UNTOUCHED\((.*)\)$') {
            $untouched = $true
            $held += "$($sk.Path)($($matches[1]))"
        } elseif ($sk.Code -match '^MOE_ATTR_CONTESTED_EDITING\((.*)\)$') {
            $editing = $true
            $held += "$($sk.Path)($($matches[1]))"
        } elseif ($sk.Code -eq 'MOE_ATTR_CONTESTED') {
            $strict = $true
            $c = @($Attr.Contested) | Where-Object { $null -ne $_ -and $_.Path -ceq $sk.Path } | Select-Object -First 1
            $held += "$($sk.Path)($(if ($c) { $c.TaskId } else { '' }))"
        }
    }
    $out = ($held | Select-Object -First 5) -join ','
    if ($held.Count -gt 5) { $out += ",+$($held.Count - 5) more" }
    # Neither a declaration nor an idle peer releases a path dirty at
    # pre-flight, so name what does. Strict skip wins: no editing tool
    # releases MOE_ATTR_CONTESTED.
    if ($strict) {
        $out += " MOE_CONTESTED_HELD remedy: attribution.contested=skip holds these paths whatever this session edits; only resolving, completing or archiving the peer task releases them. declare_files, unblocking or a shell touch alone does not release a hold."
    } elseif ($held.Count -gt 0) {
        $out += " MOE_CONTESTED_HELD remedy:"
        if ($untouched) { $out += " verify the bytes are this task's and coordinate any live peer; a held path then lands once a one-shot Claude or codex exec session of this task edits it, once a later session of this task that found it clean at pre-flight edits it while every contesting peer stays idle, or once the stale peer task is completed or archived." }
        if ($editing) { $out += " the named peer was mid-step on each MOE_ATTR_CONTESTED_EDITING path with a live session, so this session's edit did not release it (the file can carry that peer's unfinished hunks); coordinate that peer and let its step finish, then have a one-shot Claude or codex exec session of this task re-edit the path, or let the peer's own landing carry the bytes." }
        # Twin: recordCommit.ts HELD_REMEDY_WITNESS (task-7cc959e9 brings it to this sentence).
        $out += " Only a one-shot Claude (claude -p) or codex exec session's editing call (Claude Edit/Write, Codex apply_patch, or a Serena editor) leaves a TOOL witness; a Codex TUI, Gemini, Grok or interactive Claude session's edits, Serena's included, leave none."
        $out += " declare_files, unblocking or a shell touch alone does not release a hold."
    }
    return $out
}

# Today's branch-safety peel lifted into a helper. Returns the branch name the
# commit may land on, or '' when the tree must not be committed (peel failed).
# A consolidationBranch naming main/master is the main-direct opt-in: a tree
# already on it stays there and no checkout runs. Twin: ensure_safe_branch.
function Ensure-MoeSafeBranch([string]$Top, [hashtable]$Settings) {
    $currentBranch = ''
    $r = Invoke-MoeGit -Top $Top -GitArgs @('symbolic-ref', '--short', '-q', 'HEAD')
    if ($r.Rc -eq 0 -and $r.Out.Count -gt 0) { $currentBranch = ($r.Out -join '').Trim() }
    if (-not $currentBranch) {
        $r = Invoke-MoeGit -Top $Top -GitArgs @('rev-parse', '--abbrev-ref', 'HEAD')
        if ($r.Rc -eq 0 -and $r.Out.Count -gt 0) { $currentBranch = ($r.Out -join '').Trim() }
    }
    $moeBranch = "moe/work-" + (Get-Date -Format "yyyy-MM-dd")
    $explicitBranch = [bool]($Settings -and $Settings.consolidationBranch)
    if ($explicitBranch) { $moeBranch = $Settings.consolidationBranch }
    # An EXPLICIT consolidationBranch is honoured from ANY branch, so a checkout
    # parked on a stale moe/work-* is returned to it. Twin: ensure_safe_branch.
    if ($currentBranch -eq 'main' -or $currentBranch -eq 'master' -or $currentBranch -eq 'HEAD' -or -not $currentBranch -or ($explicitBranch -and $currentBranch -ne $moeBranch)) {
        $shownBranch = if ($currentBranch) { $currentBranch } else { 'detached/unborn' }
        if ($moeBranch -ceq 'main' -or $moeBranch -ceq 'master') {
            if ($moeBranch -ceq $currentBranch) {
                Write-Host "[branch] staying on ${currentBranch}: settings.consolidationBranch names the default branch (main-direct project)." -ForegroundColor Yellow
                return $currentBranch
            }
            Write-Host "[branch] on $shownBranch; checking out ${moeBranch}: settings.consolidationBranch names the default branch (main-direct project)." -ForegroundColor Yellow
        } else {
            Write-Host "[branch] on $currentBranch; switching to $moeBranch so we don't commit to the default branch." -ForegroundColor Yellow
        }
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
            Write-Host "[WARN] [branch] failed to switch off $shownBranch onto $moeBranch; refusing to commit to the default branch." -ForegroundColor Yellow
            return ''
        }
        $currentBranch = $moeBranch
    }
    return $currentBranch
}

# Stage the candidates into a TEMP index seeded from $OldSha (or empty) and
# verify each staged blob equals the snapshot blob, else that a fresh
# snapshot-style hash still does (a path that changed under us is dropped with
# MOE_ATTR_CONCURRENT and re-attempted at the next exit).
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
        if (-not $match -and $c.Blob -ne 'D' -and $stagedBlob) {
            # Never compare across conversion paths. `git add` reads the temp
            # index (seeded from $OldSha), so git's safer-autocrlf rule keeps a
            # CRLF blob $OldSha already holds; the snapshot's `hash-object` loads
            # no index and normalizes it to LF (core.autocrlf=true/input,
            # text=auto). So re-run the snapshot's own hash (Get-MoeSnapshotBlob,
            # which reads a symlink's link text, never its target; no -IndexFile):
            # unchanged since the snapshot keeps the blob git add staged; anything
            # else, a failed hash included, moved.
            # ponytail: the re-hash runs after `git add`, so an edit reverted in
            # that window (ABA) keeps the intermediate staged blob. Hashing the
            # staged bytes through the same conversion would close it, but needs a
            # binary pipe this twin cannot do safely.
            $rehash = Get-MoeSnapshotBlob $Top $c.Path
            $match = ($rehash -and $rehash -eq $c.Blob)
        }
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
    # Staging may drop a dependency for concurrent edits. Validate the actual
    # private index, not mutable worktree text or the earlier candidate list.
    $missing = Get-MoeMissingImportees -Git @{ Top=$Top } -Candidates $landed -BaseRef $OldSha -IndexFile $IndexFile
    if ($missing.Count) {
        $keep = @()
        foreach ($c in $landed) {
            $key = Get-MoePathKey $c.Path
            if (-not $missing.ContainsKey($key)) { $keep += $c; continue }
            $spec = ":(literal)$($c.Path)"
            $resetArgs = if ($OldSha) { @('reset', '-q', $OldSha, '--', $spec) } else { @('rm', '--cached', '-q', '--force', '--', $spec) }
            $reset = Invoke-MoeGit -Top $Top -IndexFile $IndexFile -GitArgs $resetArgs
            if ($reset.Rc -ne 0) { return $res }
            $dropped += @{ Path=$c.Path; Code="MOE_ATTR_IMPORTEE_MISSING($($missing[$key]))" }
        }
        $landed = $keep
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

# Hooks run against a detached private HEAD and the already validated index.
# Ordinary commit (no pathspec) does not re-add later worktree bytes. Only a
# commit with the exact expected tree/parent can reach the caller's branch CAS.
# $Worktree (WT-08) runs them in that helper instead: sparse without .moe/,
# $Tree read into its own index while HEAD stays $OldSha, and a hook that
# leaves unstaged edits or a .moe path behind refuses the commit.
function New-MoeHookedCommit([string]$Top, [string]$GitDir, [string]$OldSha, [string]$Tree, [string]$IndexFile, [string]$MessageFile, [bool]$Worktree = $false) {
    $result = @{ Rc=1; Out=@('hooked-commit-failed') }
    if (-not $OldSha) { $result.Out = @('hooked-commit-unborn-unsupported'); return $result }
    $temporaryRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
    $scratch = Join-Path $temporaryRoot ('moe-hook-commit-' + [guid]::NewGuid().ToString('N'))
    $added = $false
    try {
        $add = Invoke-MoeGit -Top $Top -GitArgs @('worktree', 'add', '--detach', '--no-checkout', $scratch, $OldSha)
        if ($add.Rc -ne 0) { throw 'hooked-commit-worktree-failed' }
        $added = $true
        $dir = Invoke-MoeGit -Top $scratch -GitArgs @('rev-parse', '--absolute-git-dir')
        if ($dir.Rc -ne 0 -or $dir.Out.Count -ne 1) { throw 'hooked-commit-worktree-failed' }
        $root = $Top; $dotMoe = Join-Path $scratch '.moe'
        if ($Worktree) {
            $root = $scratch; $IndexFile = Join-Path $dir.Out[0] 'index'
            if ((Invoke-MoeGit -Top $scratch -GitArgs @('sparse-checkout', 'set', '--no-cone', '/*', '!/.moe/')).Rc -ne 0 -or
                (Invoke-MoeGit -Top $scratch -GitArgs @('read-tree', '-mu', $Tree)).Rc -ne 0 -or (Test-Path -LiteralPath $dotMoe) -or (Test-MoeSymlink $dotMoe)) {
                throw 'hooked-commit-worktree-failed'
            }
        }
        $privateArgs = @('--git-dir', $dir.Out[0], '--work-tree', $root)
        $worktreeConfig = Join-Path $GitDir 'config.worktree'
        if (Test-Path -LiteralPath $worktreeConfig -PathType Leaf) { $privateArgs += @('-c', "include.path=$worktreeConfig") }
        $hooks = Invoke-MoeGit -Top $Top -GitArgs @('rev-parse', '--path-format=absolute', '--git-path', 'hooks')
        if ($hooks.Rc -ne 0 -or $hooks.Out.Count -ne 1) { throw 'hooked-commit-hooks-unavailable' }
        $privateArgs += @('-c', "core.hooksPath=$($hooks.Out[0])")
        # includeIf (gitdir/onbranch) can select different signing or identity
        # policy in a detached worktree. Never silently change it or copy config
        # values into logs/argv: refuse a mismatch before any hook or signer.
        foreach ($key in @('commit.gpgSign', 'user.signingKey', 'gpg.format', 'gpg.program', 'gpg.openpgp.program', 'gpg.ssh.program', 'gpg.ssh.defaultKeyCommand', 'gpg.x509.program', 'user.name', 'user.email')) {
            $query = @('config')
            if ($key -eq 'commit.gpgSign') { $query += @('--type=bool') }
            $query += @('--get', $key)
            $original = Invoke-MoeGit -Top $Top -GitArgs $query
            $private = Invoke-MoeGit -Top $Top -GitArgs ($privateArgs + $query)
            if ($original.Rc -notin @(0, 1) -or $private.Rc -notin @(0, 1)) { throw 'hooked-commit-signing-config-unavailable' }
            $default = if ($key -eq 'commit.gpgSign') { 'false' } elseif ($key -eq 'gpg.format') { 'openpgp' } else { $null }
            $originalValue = if ($original.Rc -eq 1) { $default } else { $original.Out -join "`n" }
            $privateValue = if ($private.Rc -eq 1) { $default } else { $private.Out -join "`n" }
            if ($originalValue -cne $privateValue) { throw 'hooked-commit-config-mismatch' }
        }
        $commit = Invoke-MoeGit -Top $Top -IndexFile $IndexFile -GitArgs ($privateArgs + @('commit', '-F', $MessageFile))
        if ($commit.Rc -ne 0) { throw 'hooked-commit-hook-failed' }
        $head = Invoke-MoeGit -Top $Top -IndexFile $IndexFile -GitArgs ($privateArgs + @('rev-parse', '--verify', 'HEAD'))
        if ($head.Rc -ne 0 -or $head.Out.Count -ne 1) { throw 'hooked-commit-head-unavailable' }
        $sha = $head.Out[0].Trim()
        $parent = Invoke-MoeGit -Top $Top -GitArgs @('rev-list', '--parents', '-n1', $sha)
        $treeResult = Invoke-MoeGit -Top $Top -GitArgs @('rev-parse', "$sha^{tree}")
        $parents = @(($parent.Out -join '').Trim() -split '\s+')
        if ($parent.Rc -ne 0 -or $parents.Count -ne 2 -or $parents[1] -cne $OldSha -or $treeResult.Rc -ne 0 -or ($treeResult.Out -join '').Trim() -cne $Tree -or
            ($Worktree -and ((Invoke-MoeGit -Top $scratch -GitArgs @('diff', '--quiet')).Rc -ne 0 -or (Test-Path -LiteralPath $dotMoe) -or (Test-MoeSymlink $dotMoe)))) {
            throw 'hooked-commit-snapshot-mismatch'
        }
        $result.Rc = 0; $result.Out = @($sha)
    } catch {
        $reason = $_.Exception.Message
        $known = @('hooked-commit-worktree-failed', 'hooked-commit-hook-failed', 'hooked-commit-head-unavailable', 'hooked-commit-snapshot-mismatch',
            'hooked-commit-hooks-unavailable', 'hooked-commit-signing-config-unavailable', 'hooked-commit-config-mismatch')
        $result.Out = if ($reason -cin $known) { @($reason) } else { @('hooked-commit-refused') }
    }
    finally {
        if ($added) {
            $resolved = [IO.Path]::GetFullPath($scratch)
            $prefix = $temporaryRoot.TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
            if (-not $resolved.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase) -or (Split-Path $resolved -Leaf) -notlike 'moe-hook-commit-*') {
                $result.Rc = 1; $result.Out = @('hooked-commit-cleanup-refused')
            } else {
                $removed = Invoke-MoeGit -Top $Top -GitArgs @('worktree', 'remove', '--force', $resolved)
                if ($removed.Rc -ne 0) { $result.Rc = 1; $result.Out = @('hooked-commit-cleanup-failed') }
            }
        }
    }
    return $result
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
        # A path's rows are adjacent, so its ONE trailer names every
        # contesting task (sh twin: write_commit_message).
        $groups = @()
        foreach ($c in @($Contested)) {
            if (-not $c) { continue }
            if ($groups.Count -gt 0 -and $groups[-1].Path -ceq $c.Path) { $groups[-1].Ids += $c.TaskId }
            else { $groups += @{ Path = $c.Path; Ids = @($c.TaskId) } }
        }
        foreach ($g in $groups) { $lines += "Moe-Contested: $($g.Path) ($($g.Ids -join ', '))" }
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

# The `skipped` and `contested` lists of every landing record that follows
# attribution, so a held contested path reaches the daemon's MOE_CONTESTED_HELD
# alert whatever the outcome (twin: sh record_commit_rpc). MOE_ATTR_EXCLUDED
# skips (.moe/**, tool config) are static noise that would crowd the 100-entry
# cap out of meaningful skips; staging-time drops count as skips. Paths go back
# ROOT-relative. Both lists are always arrays, empty when nothing is held.
function Get-MoeRecordHeldFields($Attr, [array]$Dropped, [string]$Rel) {
    $sk = @(@($Attr.Skipped) | Where-Object { $null -ne $_ -and $_.Code -ne 'MOE_ATTR_EXCLUDED' }) + @(@($Dropped) | Where-Object { $null -ne $_ })
    return @{
        skipped = @($sk | Select-Object -First 100 | ForEach-Object { @{ path = (ConvertTo-MoeRootRelative $_.Path $Rel); code = $_.Code } })
        contested = @(@($Attr.Contested) | Where-Object { $null -ne $_ } | Select-Object -First 100 | ForEach-Object { @{ path = (ConvertTo-MoeRootRelative $_.Path $Rel); taskId = $_.TaskId } })
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
        [string]$Sha = '',
        [hashtable]$Scope = $null
    )
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $idx = Join-Path (Join-Path $Git.GitDir 'moe') "idx-$TaskId-$myPid-rescue"
    $msgFile = ''
    try {
        $pathCount = 0
        if (-not $Sha) {
            if ($script:MoeFrozen -and $script:MoeFrozen.TaskId -ceq $TaskId) {
                $head=$script:MoeFrozen.Base
                $built=@{ Ok=$true; Changed=$true; Tree=$script:MoeFrozen.Tree; Landed=@($script:MoeFrozen.Landed) }
                $Attr=@{ Candidates=@($script:MoeFrozen.Landed) }
            } else {
            if ($null -eq $Attr) {
                $s = Get-MoeDirtySnapshot $Git.Top
                if ($null -eq $s) { Write-Host "[rescue] git status failed; nothing rescued for task $TaskId (reason=$Reason)." -ForegroundColor Yellow; return $null }
                $bl = Read-MoeBaseline (Get-MoeBaselinePath $Git.GitDir $TaskId)
                $b = if ($bl) { $bl.B } else { @{} }
                $u = if ($bl) { $bl.U } else { @{} }
                $scope = if ($Scope) { $Scope } else { Get-MoeCommitScope $TaskId 'postflight' $Sid }
                $settings = Read-MoeCommitSettings
                $Attr = Resolve-MoeAttribution -Git $Git -S $s -B $b -U $u -Tool $script:MoeToolWritten -Scope $scope -Settings $settings -TaskId $TaskId -Mode 'checkpoint' -PolicyOverride 'never' -Evidence $script:MoePreflightEvidence -PreflightDirty $script:MoePreflightDirty
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
        Send-MoeRecordCommit (@{
            taskId = $TaskId; outcome = 'committed'; kind = 'rescue'; sha = $Sha; ref = $ref; status = $Status; role = $Role
            workerId = $WorkerId; sessionId = $Sid; pushed = $false; paths = $recPaths; inferredPaths = $recInferred; code = $Reason
            message = $line
        } + (Get-MoeRecordHeldFields $Attr @() $Git.Rel)) | Out-Null
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

# $true only when git positively reports no remote at all. A probe that fails
# is "remote unknown" ($false), so it can never silently stop a push. Twin: no_git_remote.
function Test-MoeNoRemote([string]$Top) {
    $r = Invoke-MoeGit -Top $Top -GitArgs @('remote')
    return ($r.Rc -eq 0 -and -not ($r.Out -join '').Trim())
}

# Today's push with per-kind banners; the one pull --rebase retry is opt-in
# (MOE_PUSH_REBASE=1, sh twin parity). Returns $true
# when the branch is on the remote afterwards. $script:MoePushResult is what a
# delivery receipt reports: $null when no push was attempted (no remote), else
# one bounded line.
function Push-MoeBranch([string]$Top, [string]$Branch, [string]$Kind, [string]$TaskId) {
    $script:MoePushResult = $null
    $p2 = $null
    if (Test-MoeNoRemote $Top) {
        Write-Host "[info] no git remote configured; push skipped, the commit stays local on $Branch." -ForegroundColor Cyan
        return $false
    }
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
        $script:MoePushResult = "pushed $Branch"
        return $true
    }
    # A rejected push is announced, never repaired: the launcher does not
    # `pull --rebase` the checkout it lands in, because that checkout is shared
    # with every other seat — a rebase replays peers' unlanded commits, rewrites
    # the working tree under their concurrent landings and drops the files a
    # replayed commit stops tracking. MOE_PUSH_REBASE=1 restores the one retry
    # for a seat that owns a private checkout (sh twin parity).
    $pushOk = $false
    # CQ-V08: a pull --rebase rewrites the verified commit onto another tree.
    $rebase = ($env:MOE_PUSH_REBASE -eq '1')
    if ($rebase -and $script:PinnedAttemptProfile -ceq 'verified-local') {
        $rebase = $false
        Write-Host "[info] strong delivery is exact: MOE_PUSH_REBASE=1 is ignored, a rejected push is never rebased, so $Branch keeps the verified commit." -ForegroundColor Cyan
    }
    if ($rebase) {
        Write-Host "[WARN] git push failed; MOE_PUSH_REBASE=1: trying git pull --rebase then re-push..." -ForegroundColor Yellow
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
    } else {
        Write-Host "[WARN] git push rejected (the remote moved?) — not rebasing a shared checkout: a pull --rebase here replays peers' unlanded commits under their landings (MOE_PUSH_REBASE=1 opts a private checkout back in); sync it by hand or deliver from an isolated clone." -ForegroundColor Yellow
    }
    if ($pushOk) {
        Write-Host "[OK] Pushed task $TaskId to $Branch (after rebase)." -ForegroundColor Green
        $script:MoePushResult = "pushed $Branch"
        return $true
    }
    # One line from git's own diagnosis, never raw push output: the receipt
    # refuses more than 2000 chars rather than truncating them.
    $last = if ($p2) { $p2 } else { $p }
    $why = @($last.Out | ForEach-Object { "$_".Trim() } | Where-Object { $_ -match '^(fatal|error): ' } | Select-Object -First 1)
    $script:MoePushResult = 'push failed: ' + $(if ($why.Count) { $why[0] } else { 'git push failed' })
    if ($script:MoePushResult.Length -gt 500) { $script:MoePushResult = $script:MoePushResult.Substring(0, 500) }
    Write-Host "[WARN] git push still failing (auth? network? conflict?) — resolve and push manually." -ForegroundColor Yellow
    if ($Kind -eq 'completion') {
        # Completion also syncs after nothing/refused landings; an isolated
        # delivery may already be remote. A failed push alone cannot decide it.
        Send-MoeGeneralChat "PUSH FAILED for task $TaskId — branch sync failed; task delivery is not established by this push. Verify recorded task SHAs against the remote before review; existing local commits may still need pushing."
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


# .NET, not Get-FileHash: Windows PowerShell 5.1 started by node under pwsh (the
# CI 5.1 leg) inherits pwsh's PSModulePath and cannot resolve Get-FileHash at
# all, which silently turned the hot reload below off there.
function Get-MoeSha256Hex([byte[]]$Bytes) {
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($sha.ComputeHash($Bytes)) -replace '-', '') } finally { $sha.Dispose() }
}

# Suspended launch + an owned kill-on-close job closes the child-registration
# race. One inherited log handle captures both streams without memory buffering.
$script:MoeGateProcessDefinition = @"
using System;
using System.Runtime.InteropServices;
public sealed class MoeFrozenGateProcess : IDisposable {
    [StructLayout(LayoutKind.Sequential)] struct SA { public int size; public IntPtr descriptor; public int inherit; }
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct SI {
        public int size; public string reserved, desktop, title; public int x,y,w,h,xc,yc,fill,flags;
        public short show, reservedSize; public IntPtr reservedPtr, stdin, stdout, stderr;
    }
    [StructLayout(LayoutKind.Sequential)] struct PI { public IntPtr process, thread; public uint pid, tid; }
    [StructLayout(LayoutKind.Sequential)] struct Basic {
        public long processTime, jobTime; public uint flags; public UIntPtr min,max; public uint active;
        public UIntPtr affinity; public uint priority, scheduling;
    }
    [StructLayout(LayoutKind.Sequential)] struct Limits {
        public Basic basic; public ulong ro,wo,oo,rb,wb,ob; public UIntPtr pm,jm,peakp,peakj;
    }
    [StructLayout(LayoutKind.Sequential)] struct Counts {
        public long user,kernel,periodUser,periodKernel; public uint faults,total,active,terminated;
    }
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr a,string n);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr j,int c,ref Limits l,uint s);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr j,int c,out Counts a,uint s,IntPtr length);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateFile(string n,uint a,uint share,ref SA s,uint disposition,uint f,IntPtr t);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcess(string app,System.Text.StringBuilder cmd,IntPtr pa,IntPtr ta,bool inherit,uint flags,IntPtr env,string cwd,ref SI si,out PI pi);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr j,IntPtr p);
    [DllImport("kernel32.dll")] static extern uint ResumeThread(IntPtr t);
    [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr h,uint ms);
    [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr h,out uint code);
    [DllImport("kernel32.dll")] static extern bool TerminateJobObject(IntPtr h,uint code);
    [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr h,uint code);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
    IntPtr job, process;
    static void Require(bool ok) { if(!ok) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error()); }
    public MoeFrozenGateProcess(string exe,string command,string cwd,string environment,string log) {
        IntPtr output=IntPtr.Zero,input=IntPtr.Zero,block=IntPtr.Zero; PI pi=new PI();
        try {
            job=CreateJobObject(IntPtr.Zero,null); Require(job!=IntPtr.Zero);
            Limits limits=new Limits(); limits.basic.flags=0x2000;
            Require(SetInformationJobObject(job,9,ref limits,(uint)Marshal.SizeOf(typeof(Limits))));
            SA sa=new SA(); sa.size=Marshal.SizeOf(typeof(SA)); sa.inherit=1;
            output=CreateFile(log,0x40000000,3,ref sa,2,0x80,IntPtr.Zero); Require(output.ToInt64()!=-1);
            input=CreateFile("NUL",0x80000000,3,ref sa,3,0x80,IntPtr.Zero); Require(input.ToInt64()!=-1);
            SI si=new SI(); si.size=Marshal.SizeOf(typeof(SI)); si.flags=0x101; si.stdin=input; si.stdout=output; si.stderr=output;
            block=Marshal.StringToHGlobalUni(environment);
            Require(CreateProcess(exe,new System.Text.StringBuilder("\""+exe+"\" /d /s /c \""+command+"\""),
                IntPtr.Zero,IntPtr.Zero,true,0x08000404,block,cwd,ref si,out pi));
            process=pi.process; Require(AssignProcessToJobObject(job,process)); Require(ResumeThread(pi.thread)!=0xffffffff);
        } catch { if(pi.process!=IntPtr.Zero) TerminateProcess(pi.process,125); Dispose(); throw; }
        finally { if(pi.thread!=IntPtr.Zero) CloseHandle(pi.thread); if(output!=IntPtr.Zero&&output.ToInt64()!=-1) CloseHandle(output);
            if(input!=IntPtr.Zero&&input.ToInt64()!=-1) CloseHandle(input); if(block!=IntPtr.Zero) Marshal.FreeHGlobal(block); }
    }
    public bool Wait(int milliseconds) { uint r=WaitForSingleObject(process,(uint)milliseconds); Require(r!=0xffffffff); return r==0; }
    public int ExitCode { get { uint code; Require(GetExitCodeProcess(process,out code)); return unchecked((int)code); } }
    public void Stop() {
        if(job==IntPtr.Zero) return;
        Require(TerminateJobObject(job,143));
        if(process!=IntPtr.Zero&&!Wait(5000)) throw new TimeoutException("Owned gate process did not stop");
        for(int i=0;i<500;i++) {
            Counts c; Require(QueryInformationJobObject(job,1,out c,(uint)Marshal.SizeOf(typeof(Counts)),IntPtr.Zero));
            if(c.active==0) return;
            System.Threading.Thread.Sleep(10);
        }
        throw new TimeoutException("Owned gate descendants did not stop");
    }
    public void Dispose() { if(job!=IntPtr.Zero) {CloseHandle(job);job=IntPtr.Zero;} if(process!=IntPtr.Zero){CloseHandle(process);process=IntPtr.Zero;} }
}
"@
# A compiled type lives as long as the process, and a hot reload reruns this
# file in the same process: the class is named after its source, so a changed
# definition compiles under a new name instead of silently keeping the old code.
$script:MoeGateTypeName = 'MoeFrozenGateProcess' + (Get-MoeSha256Hex ([Text.Encoding]::UTF8.GetBytes($script:MoeGateProcessDefinition))).Substring(0, 12)
function Initialize-MoeGateProcess {
    if ($script:MoeGateTypeName -as [type]) { return }
    Add-Type -TypeDefinition $script:MoeGateProcessDefinition.Replace('MoeFrozenGateProcess', $script:MoeGateTypeName) -ErrorAction Stop
}
function Test-MoeGateIntegrity([hashtable]$Frozen) {
    $top = $script:MoeGate.Workspace
    $head = Invoke-MoeGit -Top $top -GitArgs @('rev-parse','HEAD')
    $tree = Invoke-MoeGit -Top $top -GitArgs @('write-tree')
    if ($head.Rc -ne 0 -or ($head.Out -join '').Trim() -cne $Frozen.Commit -or $tree.Rc -ne 0 -or ($tree.Out -join '').Trim() -cne $Frozen.Tree) { return $false }
    # One ls-files | update-index --stdin pair, as in the sh twin: a git spawn per
    # tracked file cost about 31 s per probe on a 1000-file tree.
    if (-not (Clear-MoeGateIndexFlags $top)) { return $false }
    $diff = Invoke-MoeGit -Top $top -GitArgs @('diff-files','--quiet','--ignore-submodules=none','--')
    return ($diff.Rc -eq 0)
}
function Clear-MoeGateIndexFlags([string]$Top) {
    # The cmd pipe carries raw bytes. A .NET StandardInput writer does not: under
    # a UTF-8 console it writes a BOM first, corrupting the first NUL-separated path.
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        Push-Location -LiteralPath $Top
        try {
            & $env:ComSpec /d /s /c 'git ls-files -z | git update-index --no-assume-unchanged --no-skip-worktree -z --stdin' 2>&1 | Out-Null
            return ($LASTEXITCODE -eq 0)
        } finally { Pop-Location }
    } catch { return $false }
    finally { $ErrorActionPreference = $prev }
}
function Stop-MoeGateChild {
    $gate = $script:MoeGate
    if (-not $gate -or -not $gate.Process) { return }
    try {
        $gate.Process.Stop()
        if (-not $gate.Finished) { $gate.ExitCode=$gate.Process.ExitCode; $gate.Finished=$true }
    } finally { $gate.Process.Dispose(); $gate.Process=$null }
}
# Removes every owned gate checkout this run still holds: the current one and any
# earlier one whose removal failed. A failure is reported and kept for the next
# cleanup point (the next gate, the end of the landing, the outer finally); it
# never changes a landing decision and never stops the loop.
$script:MoeGatePending = New-Object 'System.Collections.Generic.List[hashtable]'
function Remove-MoeGateRoot([hashtable]$Entry) {
    $root=[IO.Path]::GetFullPath($Entry.Root)
    $temp=[IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\','/')+[IO.Path]::DirectorySeparatorChar
    if (-not $root.StartsWith($temp,[StringComparison]::OrdinalIgnoreCase) -or
        (Split-Path -Leaf $root) -notmatch '^moe-gate-[0-9a-f]{32}$' -or
        [IO.Path]::GetFullPath($Entry.Workspace) -cne (Join-Path $root 'tree')) { throw 'invalid owned gate path' }
    if (Test-Path -LiteralPath (Join-Path $Entry.Workspace '.git')) {
        $r=Invoke-MoeGit -Top $Entry.Top -GitArgs @('worktree','remove','--force',$Entry.Workspace)
        if ($r.Rc -ne 0) { throw 'owned worktree removal failed' }
    }
    if (Test-Path -LiteralPath $root) { Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction Stop }
}
function Remove-MoeGateWorkspace {
    $gate = $script:MoeGate
    if ($gate) {
        try { Stop-MoeGateChild } catch { Write-Host "[WARN] Cannot stop owned qualityGate process: $_" -ForegroundColor Yellow }
        $script:MoeGatePending.Add(@{ Root=$gate.Root; Top=$gate.Top; Workspace=$gate.Workspace })
        $script:MoeGate = $null
    }
    $kept = New-Object 'System.Collections.Generic.List[hashtable]'
    foreach ($entry in @($script:MoeGatePending)) {
        try { Remove-MoeGateRoot $entry }
        catch {
            $kept.Add($entry)
            Write-Host "[WARN] Cannot remove owned qualityGate workspace: $($entry.Root); cleanup will be retried. ($_)" -ForegroundColor Yellow
        }
    }
    $script:MoeGatePending = $kept
    return ($kept.Count -eq 0)
}
function New-MoeFrozenCandidate([hashtable]$Git,[string]$Tree,[string]$Base) {
    $args=@('commit-tree',$Tree,'-m','Moe frozen candidate snapshot')
    if ($Base) { $args+=@('-p',$Base) }
    $r=Invoke-MoeGit -Top $Git.Top -GitArgs $args
    if ($r.Rc -ne 0 -or -not $r.Out.Count) { throw 'candidate snapshot commit failed' }
    $baseRevision=$Base
    if (-not $Base) {
        # Unborn uses the real empty-tree object, not a fictitious parent.
        $file=[IO.Path]::GetTempFileName()
        try {
            $empty=Invoke-MoeGit -Top $Git.Top -GitArgs @('hash-object','-t','tree','-w',$file)
            if ($empty.Rc -ne 0) { throw 'empty-tree sentinel failed' }
            $baseRevision=($empty.Out -join '').Trim()
        } finally { Remove-Item -LiteralPath $file -Force -ErrorAction Stop }
    }
    return @{ Tree=$Tree; Base=$Base; BaseRevision=$baseRevision; Commit=($r.Out -join '').Trim()
        CandidateId=('cand-'+[guid]::NewGuid().ToString('N')) }
}
function Invoke-MoeFrozenGate([hashtable]$Git,[hashtable]$Frozen,[string]$Command) {
    if (-not $Command) { return $true }
    $null = Remove-MoeGateWorkspace # an earlier leftover never blocks this candidate's gate
    $root=Join-Path ([IO.Path]::GetTempPath()) ('moe-gate-'+[guid]::NewGuid().ToString('N'))
    $script:MoeGate=@{ Root=$root; Top=$Git.Top; Workspace=(Join-Path $root 'tree'); Log=(Join-Path $root 'output.log')
        Command=$Command; CheckId=('check-'+[guid]::NewGuid().ToString('N')); Started=$false; Finished=$false; Recorded=$false; ExitCode=0; Process=$null }
    $gate=$script:MoeGate
    try {
        New-Item -ItemType Directory -Path $root -ErrorAction Stop | Out-Null
        $r=Invoke-MoeGit -Top $Git.Top -GitArgs @('-c','core.hooksPath=NUL','-c','core.sparseCheckout=false',
            '-c','core.sparseCheckoutCone=false','worktree','add','--detach',$gate.Workspace,$Frozen.Commit)
        if ($r.Rc -ne 0) { throw 'qualityGate workspace materialization failed' }
        if (-not (Test-MoeGateIntegrity $Frozen)) { throw 'qualityGate initial tree integrity failed' }
        $cwd=if ($Git.Rel) { Join-Path $gate.Workspace $Git.Rel } else { $gate.Workspace }
        if (-not (Test-Path -LiteralPath $cwd -PathType Container)) { throw 'qualityGate project cwd missing' }
        Initialize-MoeGateProcess
        $vars=[Environment]::GetEnvironmentVariables()
        foreach ($key in @('GIT_INDEX_FILE','GIT_DIR','GIT_WORK_TREE','GIT_COMMON_DIR')) { $vars.Remove($key) }
        $vars['MOE_PROJECT_PATH']=$cwd
        $block=(@($vars.Keys | Sort-Object | ForEach-Object { "$_=$($vars[$_])" }) -join [char]0)+[char]0+[char]0
        Write-Host "Post-flight: quality gate: $Command" -ForegroundColor Cyan
        $gate.Process=New-Object -TypeName $script:MoeGateTypeName -ArgumentList @($env:ComSpec,$Command,$cwd,$block,$gate.Log)
        $gate.Started=$true
        while (-not $gate.Process.Wait(100)) { } # No idle-output timeout.
        $gate.ExitCode=$gate.Process.ExitCode; $gate.Finished=$true
        Stop-MoeGateChild
        $gate.Recorded=$true
        if (-not (Send-MoeCheckRun $Frozen $gate)) { throw 'qualityGate check persistence failed' }
        if ($gate.ExitCode -ne 0) { throw "qualityGate failed (exit $($gate.ExitCode))" }
        if (-not (Test-MoeGateIntegrity $Frozen)) { throw 'qualityGate tracked tree/index/HEAD mutation' }
        Write-Host '[OK] qualityGate passed.' -ForegroundColor Green
        # Landing is decided by the exit code and integrity above; a failed removal
        # of the disposable checkout is reported and retried, never a gate failure.
        $null = Remove-MoeGateWorkspace
        return $true
    } catch { Write-Host "[WARN] $_; refusing branch commit." -ForegroundColor Yellow; return $false }
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
        [bool]$IsEpicFinal = $true,
        [bool]$LaunchFailed = $false
    )
    # 'pending' is the interruption sentinel: EVERY return below sets a real
    # outcome, so an Outcome still reading 'pending' in the finally means the
    # pipeline was stopped (Ctrl+C) before this landing reached one.
    $res = @{
        Outcome = 'pending'; Kind = $Kind; Sha = ''; Ref = ''; Code = ''; Branch = ''
        PathCount = 0; InferredCount = 0; SkippedCount = 0; UnattributedCount = 0
        Pushed = $false; StopLoop = $false; Held = ''
    }
    $recovered = ($Reason -eq 'recovered')
    $script:MoeFrozen=$null
    # A `recovered` landing lands a PREVIOUS session's bytes from the pre-flight
    # or an idle path: it is not this session's landing, so it must not become
    # the finalize outcome nor suppress the teardown rescue. Same rule as the sh
    # twin, which resets LAND_OUTCOME/MOE_LANDING_DONE after preflight_landing.
    if (-not $recovered) { $script:MoeLandingResult=$res }
    $casOk=$false
    $recorded=$false
    # Read by the catch/finally sends: set here so a throw before attribution
    # yields empty held lists, never an outer scope's same-named variable.
    $attr=$null
    $dropped=@()
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $idx = Join-Path (Join-Path $Git.GitDir 'moe') "idx-$TaskId-$myPid"
    $msgFile = ''
    $statusText = if ($Status) { $Status } else { 'UNKNOWN' }
    try {
        # The owner guard first, before anything reads or writes the task's
        # bytes, baseline or refs. Twin: run_landing.
        $guard = Get-MoeOwnerGuard $TaskId $Sid
        $scope = $guard.Scope
        if ($guard.Code) {
            $res.Outcome = 'refused'; $res.Code = $guard.Code
            Send-MoeOwnerRefusal $TaskId $Kind $Status $Sid $guard $CliExit
            return $res
        }
        # CQ-V08b: every checkpoint path (post-flight exit, pre-flight and idle
        # recoveries) lands through here, so this one gate holds them all. Twin: run_landing.
        if ($Kind -eq 'checkpoint' -and (Test-MoeStrongLandingTask $TaskId $Git.GitDir)) {
            $res.Outcome = 'refused'; $res.Code = 'MOE_COMMIT_REFUSED_STRONG_CHECKPOINT'
            Send-MoeStrongRefusal $TaskId $Kind $Status $Sid $Git.Top $CliExit
            return $res
        }
        if (-not $Title -and $scope.Title) { $Title = $scope.Title }
        $baselinePath = Get-MoeBaselinePath $Git.GitDir $TaskId
        $bl = Read-MoeBaseline $baselinePath
        $B = if ($bl) { $bl.B } else { @{} }
        $U = if ($bl) { $bl.U } else { @{} }
        # Every baseline write below keeps the header's session: a landing never
        # takes over another session's baseline, it only prunes B and replaces U.
        $landedFlag = Get-MoeBaselineLandedFlag $bl $Sid $recovered
        $blSession = if ($bl) { $bl.Session } else { $Sid }
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

        $gate = ''
        if ($Kind -eq 'completion' -and $RunGate -and $Settings.qualityGate) {
            if ($Settings.qualityGateScope -ne 'everyTask' -and -not $IsEpicFinal) {
                Write-Host "[info] qualityGate deferred: task $TaskId is mid-epic (scope=epicFinal; the epic-final task runs the full gate)." -ForegroundColor Cyan
            } else { $gate = $Settings.qualityGate }
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
        # MOE_ATTR_ASSERTED_FOREIGN evidence: a recovery lands the crashed
        # session's bytes against the P rows ITS pre-flight persisted; every
        # other landing uses the evidence this session's own pre-flight kept in
        # memory, never the file, which a peer's pre-flight may have rewritten
        # meanwhile. Twin: run_landing.
        $evidence = $script:MoePreflightEvidence
        if ($recovered) { $evidence = if ($bl) { $bl.P } else { $null } }
        # A recovery lands a dead session's bytes, whose window predates
        # `since`: no pre-flight snapshot, so the idle-peer exception stays off.
        $preflightDirty = if ($recovered) { $null } else { $script:MoePreflightDirty }
        $attr = Resolve-MoeAttribution -Git $Git -S $S -B $B -U $U -Tool $script:MoeToolWritten -Scope $scope -Settings $Settings -TaskId $TaskId -Mode $Kind -PolicyOverride $policyOverride -Evidence $evidence -PreflightDirty $preflightDirty
        $res.Held = Get-MoeHeldList $attr
        $blP = if ($bl) { $bl.P } else { $null }
        if ($attr.ForeignCount -gt 0) {
            Write-Host "[attribution] $($attr.ForeignCount) pre-session dirty path(s) untouched" -ForegroundColor Cyan
        }
        if ($attr.ExcludedCount -gt 0) {
            Write-Host "[attribution] $($attr.ExcludedCount) excluded path(s) untouched (MOE_ATTR_EXCLUDED: .moe/, tool config, worktrees)" -ForegroundColor Cyan
        }
        if ($attr.AssertedForeignCount -gt 0) {
            Write-Host "[attribution] $($attr.AssertedForeignCount) path(s) this task asserted earlier were already dirty when the session started and are untouched since -- held as MOE_ATTR_ASSERTED_FOREIGN; moe.declare_files them only if those bytes are this task's." -ForegroundColor Yellow
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

        # A failed launch has no work to checkpoint when every resolved path is
        # BOARD. Defer those bytes, but handle this session's baseline normally
        # so the next retry cannot recover the skipped checkpoint. Recovery and
        # completions never use this exception; unknown attribution is no proof.
        $deferBoard = $Kind -eq 'checkpoint' -and -not $recovered -and $LaunchFailed -and
            $attr.Candidates.Count -gt 0 -and @($attr.Candidates | Where-Object { $_.Reason -cne 'BOARD' }).Count -eq 0
        # Other board-only sessions still land. Share the no-landing bookkeeping
        # without peeling a branch or pruning the deferred BOARD baseline bytes.
        if ($deferBoard -or ($attr.Candidates.Count -eq 0 -and ($Kind -ne 'completion' -or
            ($attr.AssertedCount + $attr.PlannedCount) -eq 0 -or
            ($attr.AssertedCount -gt 0 -and $attr.Missing.Count -ge $attr.AssertedCount -and $attr.ToolCount -eq 0)))) {
            $code = 'MOE_COMMIT_NOTHING_TO_COMMIT'
            $outcome = 'nothing'
            if ($deferBoard) {
                $code = 'MOE_CHECKPOINT_SKIPPED_LAUNCH_FAILURE_BOARD_ONLY'
            } elseif ($Kind -eq 'completion' -and ($attr.AssertedCount + $attr.PlannedCount) -eq 0) {
                $code = 'MOE_COMMIT_REFUSED_NO_OWNED_PATHS'
                $outcome = 'refused'
            } elseif ($attr.AssertedCount -gt 0 -and $attr.Missing.Count -ge $attr.AssertedCount -and $attr.ToolCount -eq 0) {
                $code = 'MOE_COMMIT_REFUSED_OWNED_PATH_MISSING'
                $outcome = 'refused'
            }
            if ($deferBoard) {
                Write-Host "[skip] ${code}: task $TaskId - launch failed; dirty BOARD state deferred until a real landing." -ForegroundColor Cyan
            } elseif ($outcome -eq 'refused') {
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
                    Send-MoeRecordCommit (@{ taskId = $TaskId; outcome = 'failed'; kind = $Kind; status = $Status; role = $Role; workerId = $WorkerId; sessionId = $Sid; cliExitCode = $CliExit; code = 'MOE_COMMIT_FAILED_PEEL'; message = 'branch peel failed' } + (Get-MoeRecordHeldFields $attr @() $Git.Rel)) | Out-Null
                    return $res
                }
                $res.Branch = $branch
            }
            $res.Outcome = $outcome
            $res.Code = $code
            if ($bl) { Write-MoeBaseline $baselinePath $TaskId $bl.Head $B $newU $landedFlag $blSession $blP (Get-MoeCarryRows $attr.Own @()) | Out-Null }
            # Any commits the worker made mid-session are already pathspec-scoped
            # and must still reach the remote (today's behaviour for completions).
            if ($Kind -eq 'completion') { $res.Pushed = Push-MoeBranch $Git.Top $res.Branch $Kind $TaskId }
            # No build ran yet, so there are no staging-time drops.
            Send-MoeRecordCommit (@{
                taskId = $TaskId; outcome = $outcome; kind = $Kind; status = $Status; role = $Role; workerId = $WorkerId
                sessionId = $Sid; cliExitCode = $CliExit; pushed = $res.Pushed; code = $code
                unattributedPaths = $unattrRecPaths
            } + (Get-MoeRecordHeldFields $attr @() $Git.Rel)) | Out-Null
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
            Send-MoeRecordCommit (@{ taskId = $TaskId; outcome = 'failed'; kind = $Kind; status = $Status; role = $Role; workerId = $WorkerId; sessionId = $Sid; cliExitCode = $CliExit; code = 'MOE_COMMIT_FAILED_PEEL'; message = 'branch peel failed' } + (Get-MoeRecordHeldFields $attr @() $Git.Rel)) | Out-Null
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

        # One validated private index + exact commit + update-ref CAS, 3 attempts.
        # Hooked completions create the commit on a private detached HEAD.
        $new = ''
        $landed = @()
        $casOk = $false
        $journal = ''
        $receipt = $null
        $stale = if ($Kind -eq 'completion' -and $script:PinnedAttemptProfile -ceq 'verified-local') { Get-MoeReceiptJournalPath $Git.GitDir $TaskId } else { '' }
        if ($stale -and (Test-Path -LiteralPath $stale)) {
            # CQ-V08: a journal still on disk is an earlier landing of this task whose
            # effect the pre-flight replay could not settle. Landing again would
            # double-land and overwrite that intent: refuse, leave it untouched. Twin: land_plumbing.
            $refusal = 'MOE_COMMIT_REFUSED_UNRECONCILED_INTENT'; $why = "the receipt journal $stale of an earlier landing is unreconciled"
            Write-Host "[WARN] ${refusal}: task $TaskId -- $why; no ref moves until a pre-flight replay settles it (no update-ref, no rescue ref, no push). The bytes and baseline stay for the next session." -ForegroundColor Yellow
            $res.Outcome = 'refused'; $res.Code = $refusal
            if ($bl) { Write-MoeBaseline $baselinePath $TaskId $bl.Head $B $newU $landedFlag $blSession $blP (Get-MoeCarryRows $attr.Own @()) | Out-Null }
            Send-MoeRecordCommit (@{
                taskId = $TaskId; outcome = 'refused'; kind = $Kind; status = $Status; role = $Role; workerId = $WorkerId
                sessionId = $Sid; cliExitCode = $CliExit; code = $refusal; message = $why; ref = $branch
                unattributedPaths = $unattrRecPaths
            } + (Get-MoeRecordHeldFields $attr @() $Git.Rel)) | Out-Null
            return $res
        }
        for ($attempt = 1; $attempt -le 3; $attempt++) {
            $old = ''
            $o = Invoke-MoeGit -Top $Git.Top -GitArgs @('rev-parse', '-q', '--verify', "refs/heads/$branch")
            if ($o.Rc -eq 0 -and $o.Out.Count -gt 0) { $old = ($o.Out -join '').Trim() }
            $built = Build-MoeTempIndexTree -Top $Git.Top -IndexFile $idx -OldSha $old -Candidates $candidates
            if (-not $built.Ok) {
                Write-Host "[WARN] temp-index build failed for task $TaskId; nothing committed, baseline kept." -ForegroundColor Yellow
                $res.Outcome = 'failed'; $res.Code = 'MOE_COMMIT_FAILED_ATTRIBUTION'
                Send-MoeRecordCommit (@{ taskId = $TaskId; outcome = 'failed'; kind = $Kind; status = $Status; role = $Role; workerId = $WorkerId; sessionId = $Sid; cliExitCode = $CliExit; code = 'MOE_COMMIT_FAILED_ATTRIBUTION' } + (Get-MoeRecordHeldFields $attr $dropped $Git.Rel)) | Out-Null
                return $res
            }
            $dropped = @($built.Dropped)
            $landed = @($built.Landed)
            # Only a completion that will actually run a gate freezes and records a
            # candidate. A completion with no gate to run (unset, disabled, deferred)
            # lands exactly as before, whoever owns the attempt by now.
            if ($Kind -eq 'completion' -and $gate) {
                # The legacy builder omits Tree on unchanged/empty candidates.
                $treeResult=Invoke-MoeGit -Top $Git.Top -IndexFile $idx -GitArgs @('write-tree')
                if ($treeResult.Rc -ne 0 -or -not $treeResult.Out.Count) { throw 'candidate write-tree failed' }
                $built.Tree=($treeResult.Out -join '').Trim()
                # A retry whose rebuilt tree AND base both equal the gated candidate's IS
                # that candidate, so its passed gate stands. Any other difference, or a
                # pair that cannot be read back, re-freezes a new candidate and reruns
                # the gate: a result from another tree or base is never evidence here.
                $reuse=($attempt -gt 1 -and $script:MoeFrozen -and $script:MoeFrozen.CandidateId -and
                    $script:MoeFrozen.Tree -ceq $built.Tree -and $script:MoeFrozen.Base -ceq $old)
                if ($reuse) { Write-Host '[info] qualityGate result reused: the rebuilt candidate has the same tree and base.' -ForegroundColor Cyan } else {
                    $script:MoeFrozen=@{Tree=$built.Tree;Base=$old;TaskId=$TaskId;Landed=@($built.Landed)}
                    $snapshot=New-MoeFrozenCandidate $Git $built.Tree $old
                    $snapshot.TaskId=$TaskId; $snapshot.Landed=@($built.Landed)
                    $script:MoeFrozen=$snapshot
                }
                if (-not $reuse -and (-not (Send-MoeCandidate $TaskId $script:MoeFrozen $branch) -or
                    -not (Invoke-MoeFrozenGate $Git $script:MoeFrozen $gate))) {
                    $res.Outcome='failed'; $res.Code='MOE_COMMIT_FAILED_GATE'
                    $rescue=Invoke-MoeRescueRef -Git $Git -TaskId $TaskId -Reason 'gate-failed' -Title $Title -Status $Status -Sid $Sid -Attr $attr
                    if ($rescue) { $res.Ref=$rescue.Ref; $res.Sha=$rescue.Sha }
                    if ($script:MoeEvidenceUnavailable) {
                        # No gate ran, so no gate failed: this seat no longer holds a
                        # current attempt (a QA claim superseded it, or none was
                        # pinned). The frozen bytes stay parked for the task's next
                        # session; finalize decides whether the loop goes on.
                        $evidenceMsg="qualityGate not run: candidate evidence unavailable ($($script:MoeEvidenceUnavailable))"
                        $parked=if ($res.Ref) { $res.Ref } else { 'no rescue ref (nothing to rescue)' }
                        Write-Host "[WARN] qualityGate not run: candidate evidence unavailable for task $TaskId ($($script:MoeEvidenceUnavailable)); the completion is parked on $parked." -ForegroundColor Yellow
                        Send-MoeRecordCommit (@{taskId=$TaskId;outcome='failed';kind=$Kind;status=$Status;workerId=$WorkerId;
                            role=$Role;sessionId=$Sid;code=$res.Code;message=$evidenceMsg} + (Get-MoeRecordHeldFields $attr @() $Git.Rel)) | Out-Null
                        return $res
                    }
                    $res.StopLoop=$true
                    $gateRc=if ($script:MoeGate -and $script:MoeGate.Finished) { $script:MoeGate.ExitCode } else { 125 }
                    $gateMsg="🚫 PUSH-BLOCKED: qualityGate failed for task $($TaskId): $gate (exit $gateRc)"
                    Send-MoeGeneralChat $gateMsg
                    $tail=''
                    if ($script:MoeGate -and (Test-Path -LiteralPath $script:MoeGate.Log)) {
                        $tail=Read-MoeGateTail $script:MoeGate.Log
                        if ($tail.Length -gt 8000) { $tail=$tail.Substring($tail.Length-8000) }
                        if ($tail.Length -and [char]::IsLowSurrogate($tail[0])) { $tail=$tail.Substring(1) }
                    }
                    Invoke-MoeRpc -Tool 'add_comment' -Args @{taskId=$TaskId;workerId=$WorkerId;content="$gateMsg`n`n$tail"} | Out-Null
                    Send-MoeRecordCommit (@{taskId=$TaskId;outcome='failed';kind=$Kind;status=$Status;workerId=$WorkerId;
                        role=$Role;sessionId=$Sid;code=$res.Code;message=$gateMsg} + (Get-MoeRecordHeldFields $attr @() $Git.Rel)) | Out-Null
                    return $res
                }
            }
            if (-not $built.Changed) {
                foreach ($d in $dropped) { Write-Host "[skip] $($d.Path) $($d.Code)" -ForegroundColor Yellow }
                Write-Host "[info] MOE_COMMIT_NOTHING_TO_COMMIT: task $TaskId — the attributable paths already match $branch." -ForegroundColor Cyan
                $res.Outcome = 'nothing'; $res.Code = 'MOE_COMMIT_NOTHING_TO_COMMIT'
                if ($bl) { Write-MoeBaseline $baselinePath $TaskId $bl.Head $B $newU $landedFlag $blSession $blP (Get-MoeCarryRows $attr.Own @()) | Out-Null }
                if ($Kind -eq 'completion') { $res.Pushed = Push-MoeBranch $Git.Top $branch $Kind $TaskId }
                Send-MoeRecordCommit (@{ taskId = $TaskId; outcome = 'nothing'; kind = $Kind; status = $Status; role = $Role; workerId = $WorkerId; sessionId = $Sid; cliExitCode = $CliExit; pushed = $res.Pushed; code = 'MOE_COMMIT_NOTHING_TO_COMMIT'; unattributedPaths = $unattrRecPaths } + (Get-MoeRecordHeldFields $attr $dropped $Git.Rel)) | Out-Null
                return $res
            }
            $landedInferred = @($landed | Where-Object { $_.Inferred }).Count
            # A trailer claims a landed contested path, so a held one (still in
            # Contested for the ledger) gets none (sh twin: write_commit_message).
            $landedPaths = @($landed | ForEach-Object { $_.Path })
            $landedContested = @(@($attr.Contested) | Where-Object { $null -ne $_ -and $landedPaths -ccontains $_.Path })
            $msg = New-MoeCommitMessage -Kind $Kind -TaskId $TaskId -Title $Title -Status $Status -ReopenCount $ReopenCount -Role $Role -Sid $Sid -CliExit $CliExit -Recovered $recovered -PathCount $landed.Count -InferredCount $landedInferred -Contested $landedContested -Reason ''
            if ($msgFile) { Remove-Item -LiteralPath $msgFile -Force -ErrorAction SilentlyContinue }
            $msgFile = Write-MoeMessageFile $Git.GitDir $TaskId $msg
            if ($usePorcelain) {
                $ct = New-MoeHookedCommit -Top $Git.Top -GitDir $Git.GitDir -OldSha $old -Tree $built.Tree -IndexFile $idx -MessageFile $msgFile
            } else {
                $ctArgs = @('commit-tree', $built.Tree)
                if ($old) { $ctArgs += @('-p', $old) }
                $ctArgs += @('-F', $msgFile)
                $ct = Invoke-MoeGit -Top $Git.Top -GitArgs $ctArgs -MergeStderr
            }
            if ($ct.Rc -ne 0 -or $ct.Out.Count -eq 0) {
                ($ct.Out | Select-Object -Last 3) | ForEach-Object { Write-Host "  $_" }
                Write-Host "[WARN] commit creation failed (hooks, identity or signing) — parking the edits on a rescue ref; baseline kept." -ForegroundColor Yellow
                $res.Outcome = 'failed'; $res.Code = 'MOE_COMMIT_FAILED'
                $rescue = Invoke-MoeRescueRef -Git $Git -TaskId $TaskId -Reason 'commit-failed' -Title $Title -Status $Status -Sid $Sid -Attr $attr
                if ($rescue) { $res.Ref = $rescue.Ref; $res.Sha = $rescue.Sha }
                Send-MoeRecordCommit (@{ taskId = $TaskId; outcome = 'failed'; kind = $Kind; status = $Status; role = $Role; workerId = $WorkerId; sessionId = $Sid; cliExitCode = $CliExit; code = 'MOE_COMMIT_FAILED'; message = (($ct.Out | Select-Object -Last 3) -join ' '); ref = $res.Ref } + (Get-MoeRecordHeldFields $attr $dropped $Git.Rel)) | Out-Null
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
            if ($Kind -eq 'completion' -and $script:PinnedAttemptProfile -ceq 'verified-local') {
                # CQ-V07: under the strong profile this journal IS the landing's
                # intent, mandatory and on disk before the ref can move. No frozen
                # candidate of this very tree, or a journal that did not reach the
                # disk, refuses the completion: no update-ref, no rescue ref and no
                # push, so no ref moves at all; the bytes and baseline stay for the
                # next session. The expected-old CAS below is unchanged. Twin: land_plumbing.
                $journal = Get-MoeReceiptJournalPath $Git.GitDir $TaskId
                $pending = if (Test-MoeNoRemote $Git.Top) { $null } else { 'push result unknown: the landing stopped before its push finished' }
                $refusal = ''; $why = ''; $f = $script:MoeFrozen
                if (-not $f -or -not $f.CandidateId -or -not $f.Tree -or $f.Tree -cne $built.Tree -or
                    -not $script:PinnedAttemptPlanRevision -or -not $script:MoeAttemptId) {
                    $refusal = 'MOE_COMMIT_REFUSED_INTENT_INCOMPLETE'
                    $why = 'no frozen candidate of this tree, or no pinned attempt and plan revision, to journal'
                } else {
                    $receipt = [ordered]@{ taskId=$TaskId; workerId=$WorkerId; attemptId=$script:MoeAttemptId; generation=$script:MoeAttemptGeneration
                        candidateId=$f.CandidateId; target="refs/heads/$branch"; targetBefore=$oldArg; targetAfter=$new
                        landedRevision=$new; pushResult=$pending; ledger=[ordered]@{ sessionId=$Sid; role=$Role; status=$Status }
                        treeSha=$f.Tree; baseRevision=$oldArg; planRevision=$script:PinnedAttemptPlanRevision; profile=$script:PinnedAttemptProfile }
                    if (-not (Write-MoeIntentJournal $journal $receipt)) {
                        $refusal = 'MOE_COMMIT_REFUSED_INTENT_UNWRITABLE'
                        $why = "the intent journal $(if ($journal) { $journal } else { '<none>' }) could not be made durable"
                    }
                }
                if ($refusal) {
                    $receipt = $null
                    Write-Host "[WARN] ${refusal}: task $TaskId -- $why; the strong profile moves no ref without it (no update-ref, no rescue ref, no push). The bytes and baseline stay for the next session." -ForegroundColor Yellow
                    $res.Outcome = 'refused'; $res.Code = $refusal
                    if ($bl) { Write-MoeBaseline $baselinePath $TaskId $bl.Head $B $newU $landedFlag $blSession $blP (Get-MoeCarryRows $attr.Own @()) | Out-Null }
                    Send-MoeRecordCommit (@{
                        taskId = $TaskId; outcome = 'refused'; kind = $Kind; status = $Status; role = $Role; workerId = $WorkerId
                        sessionId = $Sid; cliExitCode = $CliExit; code = $refusal; message = $why; ref = $branch
                        unattributedPaths = $unattrRecPaths
                    } + (Get-MoeRecordHeldFields $attr @() $Git.Rel)) | Out-Null
                    return $res
                }
            } elseif ($Kind -eq 'completion' -and $gate) {
                # The receipt report is journaled BEFORE the ref can move. targetBefore
                # is the CAS base: the candidate's baseRevision, git's zero id if unborn.
                # `ledger` is the committed ledger row this landing owes until
                # moe.record_commit acknowledges it.
                $journal = Get-MoeReceiptJournalPath $Git.GitDir $TaskId
                $pending = if (Test-MoeNoRemote $Git.Top) { $null } else { 'push result unknown: the landing stopped before its push finished' }
                $receipt = [ordered]@{ taskId=$TaskId; workerId=$WorkerId; attemptId=$script:MoeAttemptId; generation=$script:MoeAttemptGeneration
                    candidateId=$script:MoeFrozen.CandidateId; target="refs/heads/$branch"; targetBefore=$oldArg; targetAfter=$new
                    landedRevision=$new; pushResult=$pending; ledger=[ordered]@{ sessionId=$Sid; role=$Role; status=$Status } }
                Write-MoeReceiptJournal $journal $receipt
            }
            $ur = Invoke-MoeGit -Top $Git.Top -GitArgs @('update-ref', "refs/heads/$branch", $new, $oldArg) -MergeStderr
            if ($ur.Rc -eq 0) {
                # The branch now carries this commit. Say so IMMEDIATELY: a Ctrl+C
                # in the push or the ledger record below must not leave the result
                # reading 'pending'/'nothing' and report a landed commit as unlanded.
                $casOk = $true
                $res.Outcome = 'committed'; $res.Sha = $new; $res.Ref = "refs/heads/$branch"; $res.ReceiptJournal = $journal
                break
            }
            # The ref never moved, so this attempt's report describes nothing.
            if ($journal) { Remove-Item -LiteralPath $journal -Force -ErrorAction SilentlyContinue }
            $receipt = $null
            Write-Host "[branch] $branch moved under us (attempt $attempt/3); rebuilding the commit on the new tip." -ForegroundColor Yellow
        }
        if (-not $casOk) {
            Write-Host "[WARN] MOE_COMMIT_FAILED_REF_CONTENTION: $branch kept moving during 3 attempts; parking the built commit on a rescue ref, baseline kept." -ForegroundColor Yellow
            $rescue = Invoke-MoeRescueRef -Git $Git -TaskId $TaskId -Reason 'ref-contention' -Title $Title -Status $Status -Sid $Sid -Attr $attr -Sha $new
            $res.Outcome = 'failed'; $res.Code = 'MOE_COMMIT_FAILED_REF_CONTENTION'
            if ($rescue) { $res.Ref = $rescue.Ref; $res.Sha = $rescue.Sha }
            Send-MoeRecordCommit (@{ taskId = $TaskId; outcome = 'failed'; kind = $Kind; status = $Status; role = $Role; workerId = $WorkerId; sessionId = $Sid; cliExitCode = $CliExit; code = 'MOE_COMMIT_FAILED_REF_CONTENTION'; ref = $res.Ref } + (Get-MoeRecordHeldFields $attr $dropped $Git.Rel)) | Out-Null
            return $res
        }
        foreach ($d in $dropped) { Write-Host "[skip] $($d.Path) $($d.Code)" -ForegroundColor Yellow }
        $sha = $new
        $landedPaths = @($landed | ForEach-Object { $_.Path })
        $inferredCount = @($landed | Where-Object { $_.Inferred }).Count
        $inferredPaths = @($landed | Where-Object { $_.Inferred } | ForEach-Object { $_.Path })
        Update-MoeSharedIndex $Git.Top $landedPaths | Out-Null


        # AFTER SUCCESS: prune landed paths from B (and from P, like the sh
        # twin's baseline_extra_rows), persist U, keep the baseline until the
        # task is DONE/ARCHIVED.
        foreach ($p in $landedPaths) { $B.Remove((Get-MoePathKey $p)) }
        if ($blP) { foreach ($p in $landedPaths) { $blP.Remove((Get-MoePathKey $p)) } }
        if ($Status -eq 'DONE' -or $Status -eq 'ARCHIVED') {
            Remove-MoeBaseline $baselinePath
        } else {
            $head = if ($bl) { $bl.Head } else { $sha }
            Write-MoeBaseline $baselinePath $TaskId $head $B $newU $landedFlag $blSession $blP (Get-MoeCarryRows $attr.Own $landedPaths) | Out-Null
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
        $found = if ($lg.Rc -eq 0 -and $lg.Out.Count -gt 0) { ($lg.Out -join '').Trim() } else { '' }
        # CQ-V08: under the strong profile the proof binds to the verified tree, so
        # a trailer-matched commit stands for this landing only on that tree. Twin: the sh Record block.
        if ($found -and $receipt -and $script:PinnedAttemptProfile -ceq 'verified-local') {
            $ft = Invoke-MoeGit -Top $Git.Top -GitArgs @('rev-parse', "$found^{tree}")
            if ($ft.Rc -ne 0 -or ($ft.Out -join '').Trim() -cne [string]$script:MoeFrozen.Tree) {
                $res.ProofUntransferred = $true
                Write-Host "[WARN] MOE_DELIVERY_PROOF_NOT_TRANSFERRED: task $TaskId -- $branch carries this landing's trailers on $found, whose tree is not the verified candidate's; the proof stays with candidate $($script:MoeFrozen.CandidateId), no receipt is sent and the journal stays." -ForegroundColor Yellow
                $found = ''
            }
        }
        if ($found) { $sha = $found; $res.Sha = $sha }
        $treeId = ''
        $tr = Invoke-MoeGit -Top $Git.Top -GitArgs @('rev-parse', "$sha^{tree}")
        if ($tr.Rc -eq 0 -and $tr.Out.Count -gt 0) { $treeId = ($tr.Out -join '').Trim() }
        # Truncation is computed daemon-side. Every path list goes back
        # ROOT-relative (REL stripped), like record_commit_rpc.
        $recArgs = @{
            taskId = $TaskId; outcome = 'committed'; kind = $Kind; sha = $sha; treeId = $treeId; ref = $branch
            status = $Status; role = $Role; workerId = $WorkerId; sessionId = $Sid; cliExitCode = $CliExit; pushed = $res.Pushed
            paths = @($landedPaths | Select-Object -First 500 | ForEach-Object { ConvertTo-MoeRootRelative $_ $Git.Rel })
            inferredPaths = @($inferredPaths | Select-Object -First 500 | ForEach-Object { ConvertTo-MoeRootRelative $_ $Git.Rel })
            touchedPaths = @($script:MoeToolWritten.Values | Select-Object -First 500 | ForEach-Object { ConvertTo-MoeRootRelative $_ $Git.Rel })
            unattributedPaths = $unattrRecPaths
        } + (Get-MoeRecordHeldFields $attr $dropped $Git.Rel)
        $recReply = Send-MoeRecordCommit $recArgs
        $ledgerAcked = ($null -ne $recReply -and (Get-MoeProp $recReply 'success') -eq $true)
        $recorded=$true
        if ($receipt) {
            # Only an acknowledged row leaves the journal; a lost one is replayed.
            if ($ledgerAcked) { $receipt.Remove('ledger') }
            $receipt.pushResult = $script:MoePushResult
            Write-MoeReceiptJournal $journal $receipt
            if (-not $res.ProofUntransferred) { $res.ReceiptAcked = Send-MoeReceipt $journal $receipt }
        }
        return $res
    } catch {
        Write-Host "[WARN] landing failed for task $($TaskId): $_; baseline kept." -ForegroundColor Yellow
        if ($casOk) {
            $res.Outcome='committed'; $res.Sha=$new
            Send-MoeRecordCommit (@{taskId=$TaskId;outcome='committed';kind=$Kind;sha=$new;ref=$branch;
                workerId=$WorkerId;role=$Role;sessionId=$Sid;status=$Status} + (Get-MoeRecordHeldFields $attr $dropped $Git.Rel)) | Out-Null
            $recorded=$true
        } else { $res.Outcome='failed'; $res.Code='MOE_COMMIT_FAILED' }
        $res.StopLoop=$true
        return $res
    } finally {
        try {
            $interrupted=$script:MoeGate -and $script:MoeGate.Started -and -not $script:MoeGate.Finished
            Stop-MoeGateChild
            if ($interrupted) {
                $res.Outcome='failed'; $res.Code='MOE_COMMIT_FAILED_GATE'; $res.StopLoop=$true
                $script:MoeGate.Recorded=$true
                Send-MoeCheckRun $script:MoeFrozen $script:MoeGate | Out-Null
            }
            if ($casOk -and -not $recorded) {
                # Interrupted after the CAS, in the push or the ledger record.
                # The commit is on the branch: re-send its ledger row (the daemon
                # is idempotent by sha) and never park it on a rescue ref.
                Send-MoeRecordCommit (@{taskId=$TaskId;outcome='committed';kind=$Kind;sha=$res.Sha;ref=$branch;
                    workerId=$WorkerId;role=$Role;sessionId=$Sid;status=$Status} + (Get-MoeRecordHeldFields $attr $dropped $Git.Rel)) | Out-Null
                $recorded=$true
            }
            if ($res.Outcome -eq 'failed' -and -not $res.Ref) {
                $reason=if ($interrupted) { 'teardown' } else { 'commit-failed' }
                $rescue=Invoke-MoeRescueRef -Git $Git -TaskId $TaskId -Reason $reason -Title $Title -Status $Status -Sid $Sid -Attr $attr
                if ($rescue) { $res.Ref=$rescue.Ref; $res.Sha=$rescue.Sha }
                Send-MoeRecordCommit (@{taskId=$TaskId;outcome='failed';kind=$Kind;workerId=$WorkerId;role=$Role;
                    sessionId=$Sid;status=$Status;code=$res.Code} + (Get-MoeRecordHeldFields $attr $dropped $Git.Rel)) | Out-Null
            }
            # A `recovered` landing is not this session's, and an Outcome still
            # reading 'pending' means Ctrl+C hit before this one reached any
            # outcome (attribution, a commit hook, the peel): leave the flag off
            # so the outer teardown parks the bytes, as the sh twin's EXIT trap does.
            if (-not $recovered -and $res.Outcome -ne 'pending') { $script:moeLandingDone=$true }
        } catch { Write-Host "[WARN] landing cleanup evidence failed: $_" -ForegroundColor Yellow; $res.StopLoop=$true }
        $null = Remove-MoeGateWorkspace
        Remove-Item -LiteralPath $idx -Force -ErrorAction SilentlyContinue
        if ($msgFile) { Remove-Item -LiteralPath $msgFile -Force -ErrorAction SilentlyContinue }
        $ErrorActionPreference = $prev
    }
}

# ---- worktree landing (design §2.2 L0-L2, §2.4, §3) ----
# $true when this checkout is a worktree-mode control checkout: its HEAD is
# refs/heads/moe/control (design §7.2). HEAD only, so WT-13 can reuse it.
# Twin: control_worktree_mode.
function Test-MoeControlWorktreeMode {
    $g = Get-MoeGitTop
    if ($null -eq $g) { return $false }
    $h = Invoke-MoeGit -Top $g.Top -GitArgs @('symbolic-ref', '-q', 'HEAD')
    return ($h.Rc -eq 0 -and ($h.Out -join '').Trim() -ceq 'refs/heads/moe/control')
}

# Test-MoeDenyPath plus .claude/skills/** (the wrapper's skill mirror), with no
# BOARD exception: a task worktree never lands .moe (design §2.2). Twin: denied_wt.
function Test-MoeDenyPathWorktree([string]$TopPath, [string]$XY, [string]$Rel, [hashtable]$Settings) {
    if (Test-MoeDenyPath $TopPath $XY $Rel $Settings) { return $true }
    $k = Get-MoePathKey $TopPath
    $r = Get-MoePathKey $Rel
    $roots = @($r)
    if ($r) { $roots += '' }
    foreach ($dr in $roots) {
        if ($k -ceq "$dr.claude/skills" -or $k.StartsWith("$dr.claude/skills/")) { return $true }
    }
    return $false
}

# W's snapshot split into WORKTREE candidates and MOE_ATTR_EXCLUDED skips: every
# dirty path but DENY lands (design §2.2 L0). Twin: resolve_attribution worktree.
function Get-MoeWorktreeAttribution([hashtable]$S, [string]$Rel, [hashtable]$Settings) {
    $c = New-Object System.Collections.ArrayList
    $sk = New-Object System.Collections.ArrayList
    foreach ($k in @($S.Keys | Sort-Object)) {
        $e = $S[$k]
        if (Test-MoeDenyPathWorktree $e.Path $e.XY $Rel $Settings) { [void]$sk.Add(@{ Path = $e.Path; Code = 'MOE_ATTR_EXCLUDED' }) }
        else { [void]$c.Add(@{ Path = $e.Path; Blob = $e.Blob; Inferred = $false; Reason = 'WORKTREE' }) }
    }
    return @{ Candidates = @($c); Skipped = @($sk); Contested = @(); Unattributed = @() }
}

# Push refs/heads/<Branch> to the same name on origin: no force, no upstream,
# no rebase (design §2.4). $true = pushed. A missing remote is said once; a
# rejected or unreachable push is CHECKPOINT-UNPUSHED and moves no ref.
# Twin: push_task_branch.
function Push-MoeTaskBranch([string]$Worktree, [string]$Branch, [string]$TaskId) {
    $script:MoePushResult = $null
    if (Test-MoeNoRemote $Worktree) {
        Write-Host "[info] no git remote configured; push skipped, the checkpoint stays local on $Branch." -ForegroundColor Cyan
        return $false
    }
    $p = Invoke-MoeGit -Top $Worktree -GitArgs @('push', '--porcelain', 'origin', "refs/heads/${Branch}:refs/heads/$Branch") -MergeStderr
    if ($p.Rc -eq 0) {
        Write-Host "[OK] Pushed task $TaskId to $Branch." -ForegroundColor Green
        $script:MoePushResult = "pushed $Branch"
        return $true
    }
    $p.Out | Select-Object -Last 3 | ForEach-Object { Write-Host "  $_" }
    $msg = "CHECKPOINT-UNPUSHED task=$TaskId — checkpoint committed locally only on $Branch; push when the remote is reachable"
    Write-Host "[WARN] $msg" -ForegroundColor Yellow
    Send-MoeGeneralChat $msg
    return $false
}

# The commit half of Invoke-MoeWorktreeCheckpoint (design §2.2 L1-L2): a temp
# index from the tip T, commit-tree -p T, ONE update-ref CAS, W's index
# refresh. Never Ensure-MoeSafeBranch, never the 3-attempt loop: a moved tip is
# contention (a rescue ref), never a rebuild. Sets $Res Outcome/Code/Sha/Ref/
# PathCount/Landed and returns the staging-time drops. Twin: land_plumbing
# under LAND_ONE_CAS.
function Invoke-MoeWorktreeCommit([hashtable]$Wt, [string]$Ref, [hashtable]$Attr, [hashtable]$Res, [hashtable]$M) {
    $o = Invoke-MoeGit -Top $Wt.Top -GitArgs @('rev-parse', '-q', '--verify', $Ref)
    $old = if ($o.Rc -eq 0 -and $o.Out.Count -gt 0) { ($o.Out -join '').Trim() } else { '' }
    if (-not $old) {
        # No tip T to build on: never an orphan commit from an empty tree.
        $Res.Outcome = 'failed'; $Res.Code = 'MOE_COMMIT_FAILED_REF_CONTENTION'
        Write-Host "[WARN] MOE_COMMIT_FAILED_REF_CONTENTION: $Ref does not resolve; nothing committed for task $($M.TaskId), its bytes stay in $($Wt.Top)." -ForegroundColor Yellow
        return
    }
    $idx = Join-Path (Join-Path $Wt.GitDir 'moe') "idx-$($M.TaskId)-$myPid"
    $msgFile = ''
    try {
        $built = Build-MoeTempIndexTree -Top $Wt.Top -IndexFile $idx -OldSha $old -Candidates $Attr.Candidates
        if (-not $built.Ok) {
            $Res.Outcome = 'failed'; $Res.Code = 'MOE_COMMIT_FAILED'
            Write-Host "[WARN] MOE_COMMIT_FAILED: could not build the landing index for task $($M.TaskId)." -ForegroundColor Yellow
            return
        }
        foreach ($d in @($built.Dropped)) { Write-Host "[skip] $($d.Path) $($d.Code)" -ForegroundColor Yellow; $d }
        if (-not $built.Changed) { $Res.Outcome = 'nothing'; return }
        $landed = @($built.Landed | ForEach-Object { $_.Path })
        $msg = New-MoeCommitMessage -Kind 'checkpoint' -TaskId $M.TaskId -Title $M.Title -Status $M.Status -ReopenCount $M.ReopenCount -Role $Role -Sid $M.Sid -CliExit $M.CliExit -Recovered $M.Recovered -PathCount $landed.Count -InferredCount 0 -Contested @() -Reason ''
        $msgFile = Write-MoeMessageFile $Wt.GitDir $M.TaskId $msg
        $ct = Invoke-MoeGit -Top $Wt.Top -GitArgs @('commit-tree', $built.Tree, '-p', $old, '-F', $msgFile) -MergeStderr
        if ($ct.Rc -ne 0 -or $ct.Out.Count -eq 0) {
            ($ct.Out | Select-Object -Last 3) | ForEach-Object { Write-Host "  $_" }
            Write-Host "[WARN] MOE_COMMIT_FAILED: commit creation failed (identity or signing) for task $($M.TaskId); parking the edits on a rescue ref." -ForegroundColor Yellow
            $Res.Outcome = 'failed'; $Res.Code = 'MOE_COMMIT_FAILED'
            $rescue = Invoke-MoeRescueRef -Git $Wt -TaskId $M.TaskId -Reason 'commit-failed' -Title $M.Title -Status $M.Status -Sid $M.Sid -Attr $Attr
            if ($rescue) { $Res.Ref = $rescue.Ref; $Res.Sha = $rescue.Sha }
            return
        }
        $new = ($ct.Out -join '').Trim()
        if ($env:MOE_POSTFLIGHT_TEST_HOOK_PRE_UPDATE_REF) {
            # Test seam: lets the harness move the task branch between
            # commit-tree and update-ref to prove the single CAS.
            Push-Location $Wt.Top
            try { & $env:ComSpec /d /s /c $env:MOE_POSTFLIGHT_TEST_HOOK_PRE_UPDATE_REF 2>&1 | Out-Null } catch {} finally { Pop-Location }
        }
        $ur = Invoke-MoeGit -Top $Wt.Top -GitArgs @('update-ref', $Ref, $new, $old) -MergeStderr
        if ($ur.Rc -ne 0) {
            Write-Host "[WARN] MOE_COMMIT_FAILED_REF_CONTENTION: $Ref kept moving; keeping the snapshot on a rescue ref." -ForegroundColor Yellow
            $Res.Outcome = 'failed'; $Res.Code = 'MOE_COMMIT_FAILED_REF_CONTENTION'
            $rescue = Invoke-MoeRescueRef -Git $Wt -TaskId $M.TaskId -Reason 'ref-contention' -Title $M.Title -Status $M.Status -Sid $M.Sid -Attr $Attr -Sha $new
            if ($rescue) { $Res.Ref = $rescue.Ref; $Res.Sha = $rescue.Sha }
            return
        }
        $Res.Outcome = 'committed'; $Res.Sha = $new; $Res.Ref = $Ref; $Res.PathCount = $landed.Count; $Res.Landed = $landed
        Update-MoeSharedIndex $Wt.Top $landed | Out-Null
    } finally {
        Remove-Item -LiteralPath $idx -Force -ErrorAction SilentlyContinue
        if ($msgFile) { Remove-Item -LiteralPath $msgFile -Force -ErrorAction SilentlyContinue }
    }
}

# Commit every dirty path of the task worktree W except DENY to
# refs/heads/<Branch> as a checkpoint (design §2.2 L0-L2): the owner guard, W's
# snapshot, Invoke-MoeWorktreeCommit, the push when settings.checkpointPush,
# and the ledger row with the full ref. No baseline, tier, peel or shared push:
# the target and the control checkout are never touched. A recovery with
# nothing to land records nothing and never marks this session's landing done.
# -Internal is a completion's own L2 (Invoke-MoeWorktreeCompletion): no ledger
# row, push or test hook, and an owner refusal is the completion's.
# Returns Invoke-MoeLanding's result shape. Twin: land_worktree_checkpoint.
function Invoke-MoeWorktreeCheckpoint {
    param(
        [Parameter(Mandatory = $true)][string]$TaskId,
        [Parameter(Mandatory = $true)][string]$WorktreePath,
        [Parameter(Mandatory = $true)][string]$Branch,
        [Parameter(Mandatory = $true)][hashtable]$Settings,
        [string]$Rel = '', [string]$Title = '', [string]$Status = '',
        [int]$ReopenCount = 0, [int]$CliExit = 0, [string]$Sid = '', [bool]$Recovered = $false, [bool]$Internal = $false
    )
    $res = @{ Outcome = 'pending'; Kind = 'checkpoint'; Sha = ''; Ref = ''; Code = ''; Branch = $Branch; Landed = @()
        PathCount = 0; InferredCount = 0; SkippedCount = 0; UnattributedCount = 0; Pushed = $false; StopLoop = $false; Held = '' }
    if (-not $Recovered) { $script:MoeLandingResult = $res }
    $ref = "refs/heads/$Branch"
    $rec = @{ taskId = $TaskId; kind = 'checkpoint'; status = $Status; role = $Role; workerId = $WorkerId; sessionId = $Sid; cliExitCode = $CliExit }
    $attr = @{ Candidates = @(); Skipped = @(); Contested = @() }
    $dropped = @(); $recorded = $Internal
    $hook = $env:MOE_POSTFLIGHT_TEST_HOOK_PRE_UPDATE_REF
    if ($Internal) { $env:MOE_POSTFLIGHT_TEST_HOOK_PRE_UPDATE_REF = $null }
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $guard = Get-MoeOwnerGuard $TaskId $Sid
        if ($guard.Code) {
            $res.Outcome = 'refused'; $res.Code = $guard.Code
            Send-MoeOwnerRefusal $TaskId $(if ($Internal) { 'completion' } else { 'checkpoint' }) $Status $Sid $guard $CliExit
            return $res
        }
        if (-not $Title -and $guard.Scope -and $guard.Scope.Title) { $Title = $guard.Scope.Title }
        $gd = Invoke-MoeGit -Top $WorktreePath -GitArgs @('rev-parse', '--absolute-git-dir')
        $wt = @{ Top = $WorktreePath; GitDir = $(if ($gd.Rc -eq 0) { ($gd.Out -join '').Trim() } else { '' }); Rel = $Rel }
        $S = if ($wt.GitDir) { Get-MoeDirtySnapshot $WorktreePath } else { $null }
        if ($null -eq $S) {
            $res.Outcome = 'failed'; $res.Code = 'MOE_COMMIT_FAILED_ATTRIBUTION'
            Write-Host "[WARN] MOE_COMMIT_FAILED_ATTRIBUTION: git status failed in $WorktreePath; nothing committed for task $TaskId, its bytes stay in the worktree." -ForegroundColor Yellow
        } else {
            $attr = Get-MoeWorktreeAttribution $S $Rel $Settings
            if ($Recovered -and $attr.Candidates.Count -eq 0) { $res.Outcome = 'nothing'; return $res }
            if ($attr.Skipped.Count -gt 0) { Write-Host "[attribution] $($attr.Skipped.Count) excluded path(s) untouched (MOE_ATTR_EXCLUDED: .moe/, tool config, worktrees)" -ForegroundColor Cyan }
            $res.Outcome = 'nothing'
            if ($attr.Candidates.Count -gt 0) {
                $m = @{ TaskId = $TaskId; Title = $Title; Status = $Status; ReopenCount = $ReopenCount; CliExit = $CliExit; Sid = $Sid; Recovered = $Recovered }
                $dropped = @(Invoke-MoeWorktreeCommit $wt $ref $attr $res $m)
            }
        }
        if ($res.Outcome -eq 'nothing') { $res.Code = 'MOE_COMMIT_NOTHING_TO_COMMIT' }
        if ($Internal) {
            if ($res.Outcome -eq 'committed') { Write-Host "[OK] task ${TaskId}: $($res.PathCount) path(s) committed to $Branch as $($res.Sha)" -ForegroundColor Green }
            return $res
        }
        if ($res.Outcome -ne 'committed') {
            if ($res.Outcome -eq 'nothing') { Write-Host "[info] MOE_COMMIT_NOTHING_TO_COMMIT: task $TaskId -- nothing to land from $WorktreePath." -ForegroundColor Cyan }
            $code = if ($res.Code) { $res.Code } else { 'MOE_COMMIT_FAILED' }
            Send-MoeRecordCommit ($rec + @{ outcome = $res.Outcome; ref = $ref; code = $code } + (Get-MoeRecordHeldFields $attr $dropped $Rel)) | Out-Null
            return $res
        }
        Write-Host "[OK] Committed checkpoint for task $TaskId on ${Branch}: $($res.Sha) ($($res.PathCount) paths)" -ForegroundColor Green
        if (-not $Settings.checkpointPush) {
            Write-Host "[info] settings.checkpointPush=false -- checkpoint kept local on $Branch." -ForegroundColor Cyan
        } else { $res.Pushed = Push-MoeTaskBranch $WorktreePath $Branch $TaskId }
        $tr = Invoke-MoeGit -Top $WorktreePath -GitArgs @('rev-parse', "$($res.Sha)^{tree}")
        $treeId = if ($tr.Rc -eq 0 -and $tr.Out.Count -gt 0) { ($tr.Out -join '').Trim() } else { '' }
        Send-MoeRecordCommit ($rec + @{ outcome = 'committed'; sha = $res.Sha; treeId = $treeId; ref = $ref; pushed = $res.Pushed
            paths = @($res.Landed | Select-Object -First 500 | ForEach-Object { ConvertTo-MoeRootRelative $_ $Rel })
            inferredPaths = @(); unattributedPaths = @() } + (Get-MoeRecordHeldFields $attr $dropped $Rel)) | Out-Null
        $recorded = $true
        return $res
    } catch {
        Write-Host "[WARN] worktree landing failed for task $($TaskId): $_; its bytes stay in $WorktreePath." -ForegroundColor Yellow
        if ($res.Outcome -ne 'committed') { $res.Outcome = 'failed'; $res.Code = 'MOE_COMMIT_FAILED' }
        $res.StopLoop = $true
        return $res
    } finally {
        # Interrupted after the CAS (push or ledger record): the commit is on
        # the task branch, so re-send its row; record_commit is idempotent by sha.
        if ($res.Outcome -eq 'committed' -and -not $recorded) {
            Send-MoeRecordCommit ($rec + @{ outcome = 'committed'; sha = $res.Sha; ref = $ref }) | Out-Null
        }
        if (-not $Recovered -and $res.Outcome -ne 'pending') { $script:moeLandingDone = $true }
        if ($Internal -and $null -ne $hook) { $env:MOE_POSTFLIGHT_TEST_HOOK_PRE_UPDATE_REF = $hook }
        $ErrorActionPreference = $prev
    }
}

# ---- worktree completion (WT-08; design §2.2 L4-L12, §2.3, §2.7, §2.9) -------
# 0 when refs/heads/<Target> is checked out in any worktree (the control
# checkout included), 1 when not, 2 when git cannot tell. Twin: wt_target_checked_out.
function Test-MoeTargetCheckedOut([string]$Top, [string]$Target) {
    $l = Invoke-MoeGit -Top $Top -GitArgs @('worktree', 'list', '--porcelain', '-z')
    if ($l.Rc -ne 0) { return 2 }
    if (@(($l.Out -join "`n").Split([char]0)) -ccontains "branch refs/heads/$Target") { return 0 }
    return 1
}

# Sleep MOE_LAND_NET_BACKOFF_SEC between network tries: digits only and no floor
# (0 = no wait); anything else is 5. Twin: land_backoff.
function Wait-MoeLandBackoff {
    $v = [string]$env:MOE_LAND_NET_BACKOFF_SEC; $n = 0
    if ($v -cnotmatch '^[0-9]+\z' -or -not [int]::TryParse($v, [ref]$n)) { $n = 5 }
    if ($n -gt 0) { Start-Sleep -Seconds $n }
}

# L4's fetch of origin's $T into refs/remotes/origin/$T (git from PATH, no '+': a
# refused non-fast-forward is a failed try), 3 tries the backoff apart. $false when
# all fail, with git's last stderr line in $script:MoeLandFetchErr. Twin: land_fetch.
function Invoke-MoeLandFetch([string]$Top, [string]$T) {
    for ($try = 1; $try -le 3; $try++) {
        if ($try -gt 1) { Wait-MoeLandBackoff }
        $r = Invoke-MoeGit -Top $Top -GitArgs @('fetch', '--no-write-fetch-head', 'origin', "refs/heads/${T}:refs/remotes/origin/$T") -MergeStderr
        if ($r.Rc -eq 0) { return $true }
        $e = "$(@($r.Out) | Select-Object -Last 1)"; $script:MoeLandFetchErr = $e.Substring(0, [Math]::Min(200, $e.Length))
    }
    return $false
}

# L4 (design §2.2): this round's base B. Local mode: the local target. Remote mode
# ($L.Remote): L, the local target, is read BEFORE the fetch, and B is
# refs/remotes/origin/$T, never the local target; an L that B lacks is
# MOE_LAND_TARGET_DIVERGED, else L mirrors to B. '' with $Res.Code/$L.Msg set and
# nothing moved. Twin: sync_land_target.
function Sync-MoeLandTarget([string]$Top, [string]$T, [hashtable]$Res, [hashtable]$L) {
    $tip = { param($r) $x = Invoke-MoeGit -Top $Top -GitArgs @('rev-parse', '-q', '--verify', "$r^{commit}"); if ($x.Rc -eq 0) { ($x.Out -join '').Trim() } else { '' } }
    $localTip = & $tip "refs/heads/$T"   # never $l: PowerShell names are case-insensitive, and $L is the hashtable
    if (-not $L.Remote) { if (-not $localTip) { $L.Msg = "refs/heads/$T does not resolve" }; return $localTip }
    if (-not (Invoke-MoeLandFetch $Top $T)) { $Res.Code = 'MOE_LAND_FETCH_FAILED'; $L.Why = 'remote'; $L.Msg = "git fetch origin $T failed 3 times: $($script:MoeLandFetchErr)"; return '' }
    $b = & $tip "refs/remotes/origin/$T"
    if (-not $b) { $L.Msg = "refs/remotes/origin/$T does not resolve"; return '' }
    $rc = if ($localTip) { (Invoke-MoeGit -Top $Top -GitArgs @('merge-base', '--is-ancestor', $localTip, $b)).Rc } else { 0 }
    if ($rc -eq 1) { $Res.Code = 'MOE_LAND_TARGET_DIVERGED'; $L.Why = 'diverged'; $L.Msg = "refs/heads/$T holds commits origin's $T lacks"; return '' }
    if ($rc -ne 0) { $L.Msg = "git merge-base --is-ancestor exited $rc"; return '' }
    Update-MoeLandTargetMirror $Top $T $b
    return $b
}

# L10's rule (also L4's and the replay's): move refs/heads/$T to $New only while it
# is absent or an ancestor of $New and not checked out, re-read after a lost CAS (3
# tries); one holding $New needs nothing. Else MOE_LAND_MIRROR_SKIPPED, never a
# failure. Twin: mirror_land_target.
function Update-MoeLandTargetMirror([string]$Top, [string]$T, [string]$New) {
    for ($try = 1; $try -le 3; $try++) {
        $o = Invoke-MoeGit -Top $Top -GitArgs @('rev-parse', '-q', '--verify', "refs/heads/$T^{commit}")
        $old = if ($o.Rc -eq 0) { ($o.Out -join '').Trim() } else { '' }
        if ($old -and (Invoke-MoeGit -Top $Top -GitArgs @('merge-base', '--is-ancestor', $New, $old)).Rc -eq 0) { return }
        if (($old -and (Invoke-MoeGit -Top $Top -GitArgs @('merge-base', '--is-ancestor', $old, $New)).Rc -ne 0) -or (Test-MoeTargetCheckedOut $Top $T) -ne 1) { break }
        # Zeros, not '': PowerShell 5.1 drops an empty native argument, and the CAS with it.
        $was = if ($old) { $old } else { '0' * 40 }
        if ((Invoke-MoeGit -Top $Top -GitArgs @('update-ref', '-m', "moe: mirror origin/$T", "refs/heads/$T", $New, $was)).Rc -eq 0) { return }
    }
    Write-Host "[WARN] MOE_LAND_MIRROR_SKIPPED: refs/heads/$T stays at $(if ($old) { $old } else { 'nothing' }): it does not fast-forward to $New, is checked out in a worktree, or kept moving." -ForegroundColor Yellow
}

# §2.6: settle a push of $C that got no definite answer; after the backoff L4's
# fetch decides, never a push's answer. 0 the tip holds $C (published); 1 the tip
# is neither $B nor holds $C, which can then never apply; a tip still at $B
# re-pushes the SAME $C, 3 pushes in all; 2 unknown (a failed fetch, or still $B),
# with $script:MoePushDetail. Twin: reconcile_push.
function Resolve-MoePushOutcome([string]$Top, [string]$T, [string]$B, [string]$C) {
    for ($n = 1; $n -le 3; $n++) {
        Wait-MoeLandBackoff
        if (-not (Invoke-MoeLandFetch $Top $T)) { $script:MoePushDetail = "git fetch failed: $($script:MoeLandFetchErr)"; return 2 }
        $r = Invoke-MoeGit -Top $Top -GitArgs @('rev-parse', '-q', '--verify', "refs/remotes/origin/$T^{commit}")
        if ($r.Rc -ne 0) { $script:MoePushDetail = "refs/remotes/origin/$T does not resolve"; return 2 }
        $tip = ($r.Out -join '').Trim()
        $rc = (Invoke-MoeGit -Top $Top -GitArgs @('merge-base', '--is-ancestor', $C, $tip)).Rc
        if ($rc -eq 0) { return 0 }
        if ($rc -ne 1) { $script:MoePushDetail = "git merge-base --is-ancestor exited $rc"; return 2 }
        if ($tip -cne $B) { return 1 }
        if ($n -lt 3) { $null = Invoke-MoeGit -Top $Top -GitArgs @('push', '--porcelain', 'origin', "${C}:refs/heads/$T") }
    }
    $script:MoePushDetail = "origin's $T is still at $B after 3 pushes"
    return 2
}

# L11: T' = commit-tree C^{tree} -p T -p C, and W fast-forwards onto it with
# hooks off: never a reset, never over new dirt. A failure is
# MOE_WORKTREE_SYNC_FAILED only: the landing stands and the next pre-flight
# retries. Twin: worktree_sync_branch.
function Sync-MoeTaskBranch([string]$W, [string]$Branch, [string]$C, [string]$TaskId) {
    $hooks = Join-Path ([IO.Path]::GetTempPath()) ('moe-wt-no-hooks-' + [guid]::NewGuid().ToString('N'))
    try {
        [void][IO.Directory]::CreateDirectory($hooks)
        $t = Invoke-MoeGit -Top $W -GitArgs @('rev-parse', '-q', '--verify', "refs/heads/$Branch^{commit}")
        $tp = if ($t.Rc -eq 0) { Invoke-MoeGit -Top $W -GitArgs @('commit-tree', "$C^{tree}", '-p', ($t.Out -join '').Trim(), '-p', $C, '-m', "sync(${TaskId}): $Branch takes the landed $C") } else { $null }
        if ($tp -and $tp.Rc -eq 0 -and (Invoke-MoeGit -Top $W -GitArgs @('-c', "core.hooksPath=$hooks", 'merge', '-q', '--ff-only', ($tp.Out -join '').Trim())).Rc -eq 0) { return $true }
    } catch {} finally { Remove-Item -LiteralPath $hooks -Recurse -Force -ErrorAction SilentlyContinue }
    Write-Host "[WARN] MOE_WORKTREE_SYNC_FAILED: task $TaskId -- $Branch did not take the landed $C; the landing stands and the next pre-flight retries." -ForegroundColor Yellow
    return $false
}

# L8, the strict worktree journal: identity, target, B, C, W, the task branch
# and the exact completion row it owes (no candidate, no delivery receipt).
# $false on any write or read-back failure, and then no journal describes C.
# Twin: wt_journal_write.
function Write-MoeWorktreeJournal([string]$Path, [string]$Ref, [string]$B, [string]$C, [array]$Paths, [hashtable]$M, [bool]$Remote) {
    $g = $script:MoeAttemptGeneration
    if ([string]$script:MoeAttemptId -cnotmatch '^[A-Za-z0-9_-]{1,128}$' -or -not (Test-MoeGeneration $g)) { return $false }
    $row = [ordered]@{ taskId = $preflightTaskId; outcome = 'committed'; kind = 'completion'; sha = $C; ref = $Ref; role = $Role; sessionId = $M.Sid
        workerId = $WorkerId; paths = @($Paths | Select-Object -First 500); inferredPaths = @(); unattributedPaths = @() }
    if (-not $Remote) { $row.pushed = $false }   # remote: unknown until the push is confirmed
    if ($M.Status) { $row.status = $M.Status }
    $j = [ordered]@{ taskId = $preflightTaskId; workerId = $WorkerId; attemptId = $script:MoeAttemptId; generation = $g; sessionId = $M.Sid
        workspaceMode = 'worktree'; publicationMode = $(if ($Remote) { 'remote' } else { 'local' }); target = $Ref; targetBefore = $B; targetAfter = $C; landedRevision = $C
        worktree = $script:MoeWtPath; taskBranch = "refs/heads/$($script:MoeWtBranch)"; ledger = $row }
    if (-not (Write-MoeIntentJournal $Path $j)) { return $false }
    try { if ([IO.File]::ReadAllText($Path) -ceq ($j | ConvertTo-Json -Depth 5 -Compress)) { return $true } } catch {}
    Remove-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
    return $false
}

# The journal's pushResult, best-effort. Twin: wt_journal_push_result.
function Set-MoeJournalPushResult([string]$Path, [string]$Result) {
    try {
        $j = [IO.File]::ReadAllText($Path) | ConvertFrom-Json -ErrorAction Stop
        $j | Add-Member -NotePropertyName pushResult -NotePropertyValue $Result -Force; Write-MoeReceiptJournal $Path $j
    } catch {}
}

# L9 (design §2.2): ONE non-forced push of $C, never via Push-MoeBranch (so no
# MOE_PUSH_REBASE), read from the porcelain line for the target whatever git's exit
# code; no definite answer goes to Resolve-MoePushOutcome. 0 published (the journal
# says 'pushed …', L10 mirrored $C); 1 the round ends; 2 final: [remote rejected]
# (MOE_PUSH_FAILED), or unknown (§2.6): the journal kept as 'push unknown: …', $C on
# a push-unknown rescue ref, and no row or finalize. Twin: wt_publish.
function Publish-MoeWorktreeLanding([hashtable]$Git, [string]$Journal, [hashtable]$Res, [hashtable]$L, [hashtable]$M, [string]$B, [string]$C) {
    $t = $Res.Branch; $ref = "refs/heads/$t"; $rc = 3; $sum = ''
    foreach ($line in @((Invoke-MoeGit -Top $Git.Top -GitArgs @('push', '--porcelain', 'origin', "${C}:$ref")).Out)) {
        $f = @("$line" -split "`t", 3)
        if ($f.Count -lt 2 -or $f[1].Substring($f[1].LastIndexOf([char]':') + 1) -cne $ref) { continue }
        $sum = if ($f.Count -gt 2) { $f[2] } else { '' }; $k = $f[0] + $sum
        if ($k -cmatch '^[ *=]') { $rc = 0 } elseif ($k -cmatch '^!\[rejected\]') { $rc = 1 } elseif ($k -cmatch '^!\[remote rejected\]') { $rc = 2 }
        break
    }
    if ($rc -eq 3) {
        $rc = Resolve-MoePushOutcome $Git.Top $t $B $C
        if ($rc -eq 1) {
            $L.Why = 'remote'; Write-Host "[WARN] MOE_PUSH_FAILED: task $preflightTaskId -- origin's $t moved past $B without $C, which can never apply." -ForegroundColor Yellow
        } elseif ($rc -eq 2) {
            Write-Host "[WARN] MOE_PUSH_OUTCOME_UNKNOWN: task $preflightTaskId -- the push of $C to origin's $t is unsettled ($($script:MoePushDetail)); no ref moves, and the attempt stays finalizing until a pre-flight replay settles it." -ForegroundColor Yellow
            Set-MoeJournalPushResult $Journal "push unknown: $($script:MoePushDetail)"
            $r = Invoke-MoeRescueRef -Git $Git -TaskId $preflightTaskId -Reason 'push-unknown' -Title $M.Title -Status $M.Status -Sid $M.Sid -Sha $C
            if ($r) { $Res.Ref = $r.Ref; $Res.Sha = $r.Sha }
            $script:MoeFinalizeDone = $true; $script:MoeFinalizeRc = $true; $Res.Code = 'MOE_PUSH_OUTCOME_UNKNOWN'; $L.Msg = $script:MoePushDetail
        }
    } elseif ($rc -eq 2) {
        Remove-Item -LiteralPath $Journal -Force -ErrorAction SilentlyContinue; $Res.Code = 'MOE_PUSH_FAILED'; $L.Why = 'remote'; $L.Msg = "origin refused ${C}: $sum"
    }
    if ($rc -ne 0) { return $rc }
    Set-MoeJournalPushResult $Journal "pushed $C to origin/$t"
    Update-MoeLandTargetMirror $Git.Top $t $C
    $Res.Pushed = $true
    return 0
}

# Ctrl+C waits from the CAS through the ledger row and finalize_attempt: while
# TreatControlCAsInput is on it is a key, which the release finds and then
# stops the agent on. A hard kill there is the journal replay's.
# Twin: wt_defer_signals / wt_release_signals.
function Set-MoeCtrlCDeferred([bool]$On) {
    $hit = $false
    try {
        [Console]::TreatControlCAsInput = $On
        while (-not $On -and [Console]::KeyAvailable) {
            $k = [Console]::ReadKey($true)
            if ($k.Key -eq 'C' -and ($k.Modifiers -band [ConsoleModifiers]::Control)) { $hit = $true }
        }
    } catch {}
    if ($hit) { Write-Host ''; Write-Host 'Agent stopped.'; exit 0 }
}

# L4-L9 onto $Ref from the task tip $L.T, at most three rounds (§2.3): B read
# fresh each round, merge-tree, the .moe guard, C, the strict journal, the S1
# test hook, ONE CAS. $true with $Res.Outcome committed (this C, or a journaled
# C the target holds while T adds nothing, §2.9; Ctrl+C stays deferred) or
# nothing; $false with $Res.Code and $L.Msg set and no ref moved by this
# session. Twin: wt_land_rounds.
function Invoke-MoeWorktreeRounds([hashtable]$Git, [string]$Ref, [hashtable]$Res, [hashtable]$L, [hashtable]$Settings, [hashtable]$Meta) {
    $top = $Git.Top; $journal = $L.Journal; $jc = ''; $rev = '^[0-9a-f]{40}$'
    if (Test-Path -LiteralPath $journal) {
        $j = $null
        try { $j = [IO.File]::ReadAllText($journal) | ConvertFrom-Json -ErrorAction Stop } catch {}
        if (-not (Test-MoeReceiptJournal $Git.GitDir (Split-Path -Leaf $journal) $j)) { $L.Msg = "receipt journal $journal is malformed; kept"; return $false }
        try { $jc = Find-MoeJournaledLanding $top $j } catch { $jc = $null }
        if (-not (Test-MoeWorktreeJournal $j) -or $null -eq $jc -or ($jc -and $jc -cne [string]$j.targetAfter)) {
            $L.Msg = "receipt journal $journal kept: its landing cannot be confirmed"; return $false
        }
        if (-not $jc -and $j.publicationMode -ceq 'remote') {   # a replay settles it (§2.6)
            $Res.Outcome = 'refused'; $Res.Code = 'MOE_COMMIT_REFUSED_UNRECONCILED_INTENT'; $L.Msg = "receipt journal $journal holds an unsettled push of $($j.targetAfter)"; return $false
        }
        if (-not $jc) { Remove-Item -LiteralPath $journal -Force }   # its C never reached the target: this fresh round supersedes it
    }
    for ($round = 1; $round -le 3; $round++) {
        $Res.Outcome = 'failed'; $Res.Code = 'MOE_COMMIT_FAILED'; $L.Msg = ''; $L.Why = ''
        $b = Sync-MoeLandTarget $top $Res.Branch $Res $L
        $bt = if ($b) { Invoke-MoeGit -Top $top -GitArgs @('rev-parse', '-q', '--verify', "$b^{tree}") } else { $null }
        if (-not $bt -or $bt.Rc -ne 0) { if (-not $L.Msg) { $L.Msg = "$Ref does not resolve" }; return $false }
        $bt = ($bt.Out -join '').Trim()
        $mt = Invoke-MoeGit -Top $top -GitArgs @('merge-tree', '--write-tree', '-z', '--name-only', $b, $L.T)
        $z = @(($mt.Out -join "`n").Split([char]0)); $m = $z[0]
        if ($mt.Rc -eq 1 -and $m -cmatch $rev) {
            $names = @(); for ($i = 1; $i -lt $z.Count -and $z[$i]; $i++) { $names += $z[$i] }
            $Res.Code = 'MOE_COMMIT_FAILED_CONFLICT'; $L.Msg = "merging $($L.T) into $Ref conflicts in: $($names -join ' ')"; return $false
        }
        if ($mt.Rc -ne 0 -or $m -cnotmatch $rev -or ((Invoke-MoeGit -Top $top -GitArgs @('cat-file', '-t', $m)).Out -join '').Trim() -cne 'tree') {
            $L.Msg = "git merge-tree exited $($mt.Rc)"; return $false
        }
        $d = (Invoke-MoeGit -Top $top -GitArgs @('diff-tree', '--quiet', $bt, $m, '--', '.moe')).Rc
        if ($d -eq 1) { $Res.Code = 'MOE_WORKTREE_BOARD_PATH'; $L.Msg = "the merged tree changes .moe/ on $Ref"; return $false }
        if ($d -ne 0) { $L.Msg = "git diff-tree exited $d"; return $false }
        if ($m -ceq $bt) {
            $Res.Outcome = 'nothing'; $Res.Code = 'MOE_COMMIT_NOTHING_TO_COMMIT'
            if (-not $jc) { return $true }
            Set-MoeCtrlCDeferred $true; $Res.Sha = $jc; $Res.Outcome = 'committed'; $Res.Code = ''; return $true
        } elseif ($jc) {
            $Res.Outcome = 'refused'; $Res.Code = 'MOE_COMMIT_REFUSED_UNRECONCILED_INTENT'
            $L.Msg = "receipt journal $journal still owes the completion row of $jc"; return $false
        }
        $dt = Invoke-MoeGit -Top $top -GitArgs @('diff-tree', '-r', '-z', '--name-only', '--no-renames', $bt, $m)
        if ($dt.Rc -ne 0) { $L.Msg = 'git diff-tree failed'; return $false }
        $paths = @(($dt.Out -join "`n").Split([char]0) | Where-Object { $_ })
        $Res.PathCount = $paths.Count
        $msgFile = Write-MoeMessageFile $Git.GitDir $preflightTaskId (New-MoeCommitMessage -Kind 'completion' -TaskId $preflightTaskId -Title $Meta.Title -Status $Meta.Status -ReopenCount $Meta.ReopenCount -Role $Role -Sid $Meta.Sid -CliExit $Meta.CliExit -Recovered $false -PathCount $paths.Count -InferredCount 0 -Contested @() -Reason '')
        try {
            $ct = if ($Settings.commitHooks) { New-MoeHookedCommit $top $Git.GitDir $b $m '' $msgFile $true } else { Invoke-MoeGit -Top $top -GitArgs @('commit-tree', $m, '-p', $b, '-F', $msgFile) -MergeStderr }
        } finally { Remove-Item -LiteralPath $msgFile -Force -ErrorAction SilentlyContinue }
        $c = if ($ct.Rc -eq 0 -and $ct.Out.Count -gt 0) { ([string]$ct.Out[-1]).Trim() } else { '' }
        if ($c -cnotmatch $rev) { $L.Msg = "the completion commit was refused: $(@($ct.Out | Select-Object -Last 2) -join ' ')"; return $false }
        if (-not (Write-MoeWorktreeJournal $journal $Ref $b $c @($paths | ForEach-Object { ConvertTo-MoeRootRelative $_ $Git.Rel }) $Meta $L.Remote)) {
            $L.Msg = "the receipt journal $journal could not be written"; return $false
        }
        if ($env:MOE_POSTFLIGHT_TEST_HOOK_PRE_UPDATE_REF) {
            $hook = $env:MOE_POSTFLIGHT_TEST_HOOK_PRE_UPDATE_REF; $env:MOE_POSTFLIGHT_TEST_HOOK_PRE_UPDATE_REF = $null
            Push-Location $top
            try { & $env:ComSpec /d /s /c $hook 2>&1 | Out-Null } catch {} finally { Pop-Location }
        }
        Set-MoeCtrlCDeferred $true
        $co = Test-MoeTargetCheckedOut $top $Res.Branch
        if ($co -ne 1) {
            Remove-Item -LiteralPath $journal -Force -ErrorAction SilentlyContinue; Set-MoeCtrlCDeferred $false
            if ($co -eq 0) { $Res.Code = 'MOE_LAND_TARGET_CHECKED_OUT' }
            $L.Msg = "$Ref is checked out in a worktree, or git worktree list failed"; return $false
        }
        $rc = 0
        if ($L.Remote) { $rc = Publish-MoeWorktreeLanding $Git $journal $Res $L $Meta $b $c }
        elseif ((Invoke-MoeGit -Top $top -GitArgs @('update-ref', '-m', "moe: land $preflightTaskId", $Ref, $c, $b)).Rc -ne 0) {
            $tip = Invoke-MoeGit -Top $top -GitArgs @('rev-parse', '-q', '--verify', "$Ref^{commit}")
            $rc = if ($tip.Rc -ne 0) { 2 } else { (Invoke-MoeGit -Top $top -GitArgs @('merge-base', '--is-ancestor', $c, ($tip.Out -join '').Trim())).Rc }
        }
        if ($rc -eq 0) { $Res.Sha = $c; $Res.Outcome = 'committed'; $Res.Code = ''; return $true }
        Set-MoeCtrlCDeferred $false
        if ($rc -ne 1) { if (-not $L.Msg) { $L.Msg = "$Ref could not be read after a lost CAS; receipt journal $journal kept" }; return $false }
        Remove-Item -LiteralPath $journal -Force -ErrorAction SilentlyContinue
        Write-Host "[branch] $Ref moved while landing task $preflightTaskId (round $round/3); rebuilding on the new tip." -ForegroundColor Yellow
    }
    $Res.Code = 'MOE_COMMIT_FAILED_REF_CONTENTION'; $L.Msg = "$Ref moved under all 3 rounds"
    return $false
}

# L11-L12 once C is on the target (Ctrl+C deferred): sync the task branch
# (best-effort), send the journal's exact completion row and finalize_attempt
# landed; the journal goes once both answered. Twin: wt_land_published.
function Complete-MoeWorktreeLanding([hashtable]$Res, [string]$Journal) {
    $ok = $false
    try {
        $script:MoeWtCompletion = $false
        Write-Host "[OK] Landed task $preflightTaskId on $($Res.Branch): $($Res.Sha) ($($Res.PathCount) paths)" -ForegroundColor Green
        $w = $script:MoeWtPath; $br = $script:MoeWtBranch
        if ((Invoke-MoeGit -Top $w -GitArgs @('merge-base', '--is-ancestor', $Res.Sha, "refs/heads/$br")).Rc -ne 0) { Sync-MoeTaskBranch $w $br $Res.Sha $preflightTaskId | Out-Null }
        $j = [IO.File]::ReadAllText($Journal) | ConvertFrom-Json -ErrorAction Stop
        $ok = Send-MoeOwedLedgerRow $j $Res.Sha
        $ok = (Complete-MoePostflight) -and $ok
    } catch { $ok = $false }
    if ($ok) { Remove-Item -LiteralPath $Journal -Force -ErrorAction SilentlyContinue }
    else { Write-Host "[WARN] receipt journal $Journal kept: the completion row or finalize_attempt got no answer; the next pre-flight replays it." -ForegroundColor Yellow }
    Set-MoeCtrlCDeferred $false
}

# A worktree completion exit (design §2.2): L0-L2 commit W's dirt to its
# branch (owner guard, no ledger row of its own), then the net change lands
# on the target (literal consolidationBranch, else main) as ONE squash commit:
# a local CAS without a remote, else (any remote, or a failed probe) the
# non-forced push of WT-09. Any qualityGate fails closed here (WT-10 owns it).
# Never Ensure-MoeSafeBranch, the peel or the shared push. Twin: land_worktree_completion.
function Invoke-MoeWorktreeCompletion([hashtable]$Settings, [hashtable]$M) {
    $tid = $preflightTaskId; $branch = $script:MoeWtBranch
    $git = Get-MoeGitTop; $rel = if ($git) { $git.Rel } else { '' }
    $l2 = Invoke-MoeWorktreeCheckpoint -TaskId $tid -WorktreePath $script:MoeWtPath -Branch $branch -Settings $Settings -Rel $rel -Title $M.Title `
        -Status $M.Status -ReopenCount $M.ReopenCount -CliExit $M.CliExit -Sid $M.Sid -Internal $true
    if ($l2.Outcome -eq 'refused') { return $l2 }
    $cb = [string]$Settings.consolidationBranch
    $target = if ($cb -and $cb -notmatch '[?\[]') { $cb } else { 'main' }
    $ref = "refs/heads/$target"; $rescue = $false
    $res = @{ Outcome = 'failed'; Kind = 'completion'; Sha = ''; Ref = ''; Code = 'MOE_COMMIT_FAILED'; Branch = $target; Landed = @()
        PathCount = 0; InferredCount = 0; SkippedCount = 0; UnattributedCount = 0; Pushed = $false; StopLoop = [bool]$l2.StopLoop; Held = '' }
    $script:MoeLandingResult = $res
    $L = @{ Msg = ''; T = ''; Journal = $(if ($git) { Get-MoeReceiptJournalPath $git.GitDir $tid } else { '' }); Why = ''
        Remote = [bool]($git -and -not (Test-MoeNoRemote $git.Top)) }
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $t = if ($L.Journal) { Invoke-MoeGit -Top $git.Top -GitArgs @('rev-parse', '-q', '--verify', "refs/heads/$branch^{commit}") } else { $null }
        if ($l2.Outcome -eq 'failed') {
            if ($l2.Code) { $res.Code = $l2.Code }
            $res.Ref = $l2.Ref; $res.Sha = $l2.Sha; $L.Msg = 'the task-branch commit failed'
        } elseif (-not $t -or $t.Rc -ne 0) { $L.Msg = "refs/heads/$branch does not resolve" }
        elseif ((Invoke-MoeGit -Top $git.Top -GitArgs @('check-ref-format', $ref)).Rc -ne 0 -or
            (-not $L.Remote -and (Invoke-MoeGit -Top $git.Top -GitArgs @('rev-parse', '-q', '--verify', "$ref^{commit}")).Rc -ne 0)) {
            $L.Msg = "the target $ref is not an existing branch"
        } elseif ($Settings.qualityGate) { $L.Msg = 'settings.qualityGate is set and gated worktree landing is not available yet' }
        else {
            $L.T = ($t.Out -join '').Trim()
            $co = Test-MoeTargetCheckedOut $git.Top $target
            if ($co -eq 0) { $res.Code = 'MOE_LAND_TARGET_CHECKED_OUT'; $L.Msg = "$ref is checked out in a worktree" }
            elseif ($co -ne 1) { $L.Msg = 'git worktree list failed' }
            elseif (-not (Invoke-MoeWorktreeRounds $git $ref $res $L $Settings $M)) { $rescue = $true }
        }
        $row = @{ taskId = $tid; kind = 'completion'; ref = $ref; status = $M.Status; role = $Role; workerId = $WorkerId; sessionId = $M.Sid; cliExitCode = $M.CliExit }
        if ($res.Outcome -eq 'committed') { Complete-MoeWorktreeLanding $res $L.Journal }
        elseif ($res.Outcome -eq 'nothing') {
            Write-Host "[info] $($res.Code): task $tid -- $target already holds everything on $branch." -ForegroundColor Cyan
            Send-MoeRecordCommit ($row + @{ outcome = 'nothing'; code = $res.Code }) | Out-Null
        } elseif ($res.Code -cne 'MOE_PUSH_OUTCOME_UNKNOWN') {   # unknown: the publish kept the journal and parked C
            Write-Host "[WARN] $($res.Code): task $tid -- $($L.Msg); $target did not move and the task's bytes stay on $branch." -ForegroundColor Yellow
            # A refusal (an owed journal row) moves nothing, a rescue ref included.
            if ($rescue -and $res.Outcome -ne 'refused') {
                $why = if ($L.Why) { $L.Why } elseif ($res.Code -eq 'MOE_COMMIT_FAILED_REF_CONTENTION') { 'ref-contention' } else { 'commit-failed' }
                $r = Invoke-MoeRescueRef -Git $git -TaskId $tid -Reason $why -Title $M.Title -Status $M.Status -Sid $M.Sid -Sha $L.T
                if ($r) { $res.Ref = $r.Ref; $res.Sha = $r.Sha }
            }
            Send-MoeRecordCommit ($row + @{ outcome = $res.Outcome; code = $res.Code; message = $L.Msg }) | Out-Null
        }
    } catch {
        Write-Host "[WARN] worktree completion landing failed for task ${tid}: $_; its bytes stay on $branch." -ForegroundColor Yellow
        $res.StopLoop = $true
        Set-MoeCtrlCDeferred $false
    } finally {
        $ErrorActionPreference = $prev
    }
    return $res
}

# The control checkout's dirty paths minus Test-MoeDenyPathWorktree (so never
# .moe/), as an array; $null when git status fails. Twin: worktree_control_dirt.
function Get-MoeWorktreeControlDirt([hashtable]$Git, [hashtable]$Settings) {
    $S = Get-MoeDirtySnapshot $Git.Top
    if ($null -eq $S) { return $null }
    return ,@((Get-MoeWorktreeAttribution $S $Git.Rel $Settings).Candidates | ForEach-Object { $_.Path })
}

# A worktree worker's pre-flight after Initialize-MoeWorktree's W/.moe guard
# (design §3.3, §3.7): dirt a crashed session left in W becomes a recovery
# checkpoint on the task branch (MOE_CHECKPOINT_RECOVERED; a failure leaves it
# in W), then the control checkout's dirt is listed, NUL-terminated, in
# <common gitdir>/moe/worktree/<id>.control-dirt for the stray-edit check. No
# baseline, rescue replay or notice. First of all, L11's retry (WT-08): the
# task's last recorded completion that its branch lacks is synced in; git
# refuses over W's dirt, which then stays. Only a C on the target that the
# branch adds nothing to: a C^{tree} sync over newer work would drop it, and
# that work lands from the older base instead. Twin: worktree_preflight.
function Invoke-MoeWorktreePreflight([string]$TaskId, [string]$Title, [string]$Status, [string]$Sid) {
    $settings = Read-MoeCommitSettings
    $git = Get-MoeGitTop
    $done = @(@(Get-MoeProp (Get-MoeProp $preflightContext 'task') 'commits') | Where-Object { $_ -and $_.kind -ceq 'completion' -and
        ($null -eq $_.outcome -or $_.outcome -ceq 'committed') -and [string]$_.sha -cmatch '^[0-9a-f]{40}$' } | ForEach-Object { [string]$_.sha })
    if ($settings.autoCommit -and $git -and $done.Count -gt 0 -and (Invoke-MoeGit -Top $git.Top -GitArgs @('cat-file', '-e', "$($done[-1])^{commit}")).Rc -eq 0 -and
        (Invoke-MoeGit -Top $git.Top -GitArgs @('merge-base', '--is-ancestor', $done[-1], "refs/heads/$($script:MoeWtBranch)")).Rc -ne 0 -and
        (Invoke-MoeGit -Top $git.Top -GitArgs @('merge-base', '--is-ancestor', $done[-1], "refs/heads/$($script:MoeWtTarget)")).Rc -eq 0) {
        if (Test-MoeTaskBranchLanded $git.Top $done[-1] $TaskId) { Sync-MoeTaskBranch $script:MoeWtPath $script:MoeWtBranch $done[-1] $TaskId | Out-Null }
        else { Write-Host "[WARN] MOE_WORKTREE_SYNC_FAILED: task $TaskId -- $($script:MoeWtBranch) holds work its landed $($done[-1]) lacks; not synced, the next landing merges it from the older base." -ForegroundColor Yellow }
    }
    if ($settings.autoCommit -and $settings.checkpointCommits) {
        $st = if ($Status) { $Status } else { 'UNKNOWN' }
        $rel = if ($git) { $git.Rel } else { '' }
        $r = Invoke-MoeWorktreeCheckpoint -TaskId $TaskId -WorktreePath $script:MoeWtPath -Branch $script:MoeWtBranch -Settings $settings -Rel $rel -Title $Title -Status $st -Sid $Sid -Recovered $true
        if ($r.Outcome -eq 'committed') {
            Write-Host "[OK] MOE_CHECKPOINT_RECOVERED task=$TaskId sha=$($r.Sha)" -ForegroundColor Green
        } elseif ($r.Outcome -eq 'failed') {
            Write-Host "[WARN] recovery checkpoint for $TaskId did not complete ($(if ($r.Code) { $r.Code } else { '?' })); its bytes stay in $($script:MoeWtPath)." -ForegroundColor Yellow
        }
    }
    $list = ''
    try {
        $cd = if ($git) { Invoke-MoeGit -Top $git.Top -GitArgs @('rev-parse', '--path-format=absolute', '--git-common-dir') } else { $null }
        if ($cd -and $cd.Rc -eq 0 -and $cd.Out.Count -gt 0) { $list = Join-Path ($cd.Out -join '').Trim() "moe/worktree/$TaskId.control-dirt" }
        $paths = if ($list) { Get-MoeWorktreeControlDirt $git $settings } else { $null }
        if ($null -ne $paths) {
            New-Item -ItemType Directory -Force -Path (Split-Path -Parent $list) | Out-Null
            [IO.File]::WriteAllText("$list.tmp", (@($paths | ForEach-Object { "$_$([char]0)" }) -join ''), (New-Object Text.UTF8Encoding($false)))
            Move-Item -LiteralPath "$list.tmp" -Destination $list -Force
            $script:MoeWtDirtList = $list
            return
        }
    } catch {}
    Write-Host "[WARN] could not write the control-checkout dirt list $(if ($list) { $list } else { '<no git dir>' }); the stray-edit check is off for this session." -ForegroundColor Yellow
}

# Design §3.7: a control-checkout path dirty now but absent from the pre-flight
# list prints MOE_WORKTREE_STRAY_EDIT and becomes ONE task comment naming up to
# 20 paths. Never landed, never reverted. Any failure is one [WARN] and leaves
# the landing outcome alone. Twin: worktree_stray_check.
function Invoke-MoeWorktreeStrayCheck([string]$TaskId) {
    if (-not $script:MoeWtDirtList) { return }
    $stray = $null; $git = $null
    try {
        $pre = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::Ordinal)
        foreach ($p in [IO.File]::ReadAllText($script:MoeWtDirtList).Split([char]0)) { if ($p) { [void]$pre.Add((Get-MoePathKey $p)) } }
        $git = Get-MoeGitTop
        $now = if ($git) { Get-MoeWorktreeControlDirt $git (Read-MoeCommitSettings) } else { $null }
        if ($null -ne $now) { $stray = @($now | Where-Object { -not $pre.Contains((Get-MoePathKey $_)) }) }
    } catch { $stray = $null }
    if ($null -eq $stray) {
        Write-Host "[WARN] the stray-edit check for task $TaskId could not run (control-dirt list or git status unreadable)." -ForegroundColor Yellow
        return
    }
    $n = $stray.Count
    if ($n -eq 0) { return }
    Write-Host "[WARN] MOE_WORKTREE_STRAY_EDIT count=$n task=${TaskId}: written into the control checkout $($git.Top), not $($script:MoeWtPath); never landed or reverted, a human decides: $(@($stray | Select-Object -First 5) -join ' ')" -ForegroundColor Yellow
    $content = "MOE_WORKTREE_STRAY_EDIT: this session wrote $n path(s) into the control checkout instead of its worktree $($script:MoeWtPath). They were neither landed nor reverted; a human decides.`n" + (@($stray | Select-Object -First 20 | ForEach-Object { "- $_" }) -join "`n")
    if ($n -gt 20) { $content += "`n+$($n - 20) more" }
    $r = $null
    try { $r = Invoke-MoeRpc -Tool 'add_comment' -Args @{ taskId = $TaskId; workerId = $WorkerId; content = $content } } catch {}
    if ($null -eq $r) { Write-Host "[WARN] moe.add_comment failed for the MOE_WORKTREE_STRAY_EDIT note on $TaskId." -ForegroundColor Yellow }
}

# A worktree worker's exit (design §2.4, §3): a checkpoint exit commits W's
# bytes to the task branch only, a completion lands them on the target
# (Invoke-MoeWorktreeCompletion), then the stray-edit check. Never
# Invoke-MoeLanding, the peel, the shared push or a baseline. Twin: worktree_postflight.
function Invoke-MoeWorktreePostflight([hashtable]$Settings, [string]$Status, [int]$ReopenCount, [int]$CliExit, [string]$Sid) {
    $completion = ($Status -eq 'REVIEW' -or $Status -eq 'DONE')
    $script:MoeWtCompletion = $completion
    $res = $null
    if (-not $Settings.autoCommit) {
        Write-Host "[info] settings.autoCommit=false -- no git activity for task $preflightTaskId; its bytes stay in $($script:MoeWtPath)." -ForegroundColor Cyan
    } elseif ($completion) {
        $res = Invoke-MoeWorktreeCompletion $Settings @{ Title = $preflightTaskTitle; Status = $Status; ReopenCount = $ReopenCount; CliExit = $CliExit; Sid = $Sid }
    } elseif ($Settings.checkpointCommits) {
        $git = Get-MoeGitTop
        $rel = if ($git) { $git.Rel } else { '' }
        $res = Invoke-MoeWorktreeCheckpoint -TaskId $preflightTaskId -WorktreePath $script:MoeWtPath -Branch $script:MoeWtBranch -Settings $Settings -Rel $rel -Title $preflightTaskTitle -Status $Status -ReopenCount $ReopenCount -CliExit $CliExit -Sid $Sid
    } else {
        $dc = if ($env:MOE_DISABLE_CHECKPOINT) { $env:MOE_DISABLE_CHECKPOINT } else { '0' }
        Write-Host "[info] no landing for task $preflightTaskId (checkpointCommits=$($Settings.checkpointCommits) MOE_DISABLE_CHECKPOINT=$dc); its bytes stay in $($script:MoeWtPath)." -ForegroundColor Cyan
    }
    Invoke-MoeWorktreeStrayCheck $preflightTaskId
    return $res
}

# Design §3.6: an architect or QA seat in a worktree-mode control checkout
# lands nothing (it carries daemon and human bytes only) and records
# MOE_COMMIT_NOTHING_TO_COMMIT; no ref moves. Twin: control_seat_postflight.
function Invoke-MoeControlSeatPostflight([string]$Status, [int]$CliExit, [string]$Sid) {
    $code = 'MOE_COMMIT_NOTHING_TO_COMMIT'
    $res = @{ Outcome = 'nothing'; Kind = 'checkpoint'; Sha = ''; Ref = ''; Code = $code; Branch = ''
        PathCount = 0; InferredCount = 0; SkippedCount = 0; UnattributedCount = 0; Pushed = $false; StopLoop = $false; Held = '' }
    $script:MoeLandingResult = $res
    Write-Host "[info] ${code}: task $preflightTaskId -- a $Role seat in the worktree-mode control checkout lands nothing." -ForegroundColor Cyan
    Send-MoeRecordCommit @{ taskId = $preflightTaskId; outcome = 'nothing'; kind = 'checkpoint'; status = $Status; role = $Role
        workerId = $WorkerId; sessionId = $Sid; cliExitCode = $CliExit; code = $code } | Out-Null
    return $res
}

# Section 4 steps 1-3 (shared by the pre-flight and the idle paths): scope,
# DONE/ARCHIVED cleanup, recovery landing of a lingering baseline.
function Invoke-MoeRecoveryCheck([hashtable]$Git, [hashtable]$Settings, [string]$TaskId, [string]$Status, [string]$Title, [string]$Sid) {
    $out = @{ Scope = $null; Skip = $false; Recovered = $null }
    $scope = Get-MoeCommitScope $TaskId 'preflight' $Sid
    $out.Scope = $scope
    $baselinePath = Get-MoeBaselinePath $Git.GitDir $TaskId
    # A task that is over (or gone) has no bytes left to protect, so its
    # live-session marker goes with its baseline — otherwise a hard-killed
    # session would leave one behind under <gitdir>/moe/baseline/ forever.
    if (-not $scope.Found) {
        Write-Host "[WARN] task $TaskId not found by moe.get_commit_scope or on disk — dropping its baseline." -ForegroundColor Yellow
        Remove-MoeBaseline $baselinePath
        Clear-MoeLiveMarkerFile $Git.GitDir $TaskId
        $out.Skip = $true
        return $out
    }
    if ($scope.Status -eq 'DONE' -or $scope.Status -eq 'ARCHIVED') {
        Remove-MoeBaseline $baselinePath
        Clear-MoeLiveMarkerFile $Git.GitDir $TaskId
        $out.Skip = $true
        return $out
    }
    if (-not $Status -and $scope.Status) { $Status = $scope.Status }
    if (-not $Title -and $scope.Title) { $Title = $scope.Title }
    # A baseline whose header says landed=1 belongs to a session that finished
    # a landing (committed/nothing/refused); replaying a "recovered" checkpoint
    # from it would only re-land board-state noise on every poll. Only the
    # session named in its header, a recovery, or a landing that found no
    # baseline sets that flag (Get-MoeBaselineLandedFlag): a sibling session's
    # landing keeps it, so a live rework session's crash stays recoverable.
    $blPrev = Read-MoeBaseline $baselinePath
    # The predicate above is true for a crashed session AND for one still
    # running and about to commit. Ask the live-session marker which it is
    # before touching anything. Four outcomes; each one is load-bearing:
    #   none/self -> recover exactly as before (no marker is every task already
    #                in flight when this landed; self is the idle/resume paths
    #                re-entering the pre-flight for a task we ourselves hold)
    #   live      -> stand down: the owner is running and WILL land these bytes
    #   foreign   -> stand down: the owner is on a host or pid namespace we
    #                cannot probe from here (a WSL seat and a Windows seat
    #                sharing this checkout through a mount). Refusing to steal
    #                is recoverable by a human; recovering across a boundary we
    #                cannot probe is not.
    #   stale     -> the owner crashed, or its id was recycled: drop the marker
    #                and recover, unchanged. This is the 2026-08-28 lost-code
    #                path and it must not weaken.
    $liveState = 'none'
    if ($blPrev -and -not $blPrev.Landed) { $liveState = Get-MoeLiveMarkerState $Git.GitDir $TaskId }
    $owner = $script:MoeLiveOwner
    if ($liveState -eq 'live') {
        Write-Host "[attribution] MOE_CHECKPOINT_SKIPPED_LIVE_OWNER task=$TaskId pid=$($owner.ProcId) host=$($owner.MarkerHost) worker=$($owner.Worker) reason=live" -ForegroundColor Yellow
        Write-Host "[attribution] $TaskId is still held by a RUNNING session — leaving its baseline and its dirty paths untouched so that session can land them itself." -ForegroundColor Yellow
    } elseif ($liveState -eq 'foreign') {
        Write-Host "[attribution] MOE_CHECKPOINT_SKIPPED_LIVE_OWNER task=$TaskId pid=$($owner.ProcId) host=$($owner.MarkerHost) worker=$($owner.Worker) reason=foreign-host" -ForegroundColor Yellow
        Write-Host "[attribution] the live-session marker for $TaskId was written on $($owner.MarkerHost)/$($owner.Ns), whose process ids are not visible here — not recovering. Delete $(Get-MoeLiveMarkerPath $Git.GitDir $TaskId) by hand if that session is known to be gone." -ForegroundColor Yellow
    } elseif ($liveState -eq 'stale') {
        Write-Host "[attribution] the session that held $TaskId (pid=$($owner.ProcId)) is gone — dropping its stale marker and recovering its work." -ForegroundColor Cyan
        Clear-MoeLiveMarkerFile $Git.GitDir $TaskId
    }
    if ($blPrev -and -not $blPrev.Landed -and $liveState -ne 'live' -and $liveState -ne 'foreign') {
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
    # Worktree mode keeps no baseline (design §3): a worktree worker's
    # pre-flight is Invoke-MoeWorktreePreflight, and a control seat lands nothing.
    if ($script:MoeWtMode -eq 'worktree') { return $result }
    if ($Role -ne 'worker' -and (Test-MoeControlWorktreeMode)) { return $result }
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
        # This session's P rows (MOE_ATTR_ASSERTED_FOREIGN evidence, see
        # Read-MoeBaseline): the dirty snapshot minus the C rows, whose bytes a
        # previous session of this task left as its own. A recovery that ran
        # above and did not complete hands the crashed session's bytes to THIS
        # session's landing, as the kept B rows do, so its P rows stay the
        # evidence instead (a fresh snapshot would read those bytes as
        # foreign). Twin: preflight_landing step 4.
        $pre = @{}
        if ($null -ne $chk.Recovered -and $bl -and -not $bl.Landed) {
            $pre = $bl.P
        } else {
            $carry = if ($bl) { $bl.C } else { @{} }
            foreach ($k in $sPre.Keys) {
                if ($carry.ContainsKey($k) -and $carry[$k].Blob -ceq $sPre[$k].Blob) { continue }
                $pre[$k] = @{ Path = $sPre[$k].Path; Blob = $sPre[$k].Blob }
            }
        }
        # This session's landings judge against this copy, never the file a
        # peer's pre-flight may rewrite meanwhile (Invoke-MoeLanding, teardown).
        $script:MoePreflightEvidence = $pre
        # The whole dirty snapshot of THIS pre-flight, even when the P rows above
        # were inherited: the skip-untouched idle-peer exception
        # (Resolve-MoeAttribution) lands a contested path only when it was clean
        # here. A crashed session's unlanded bytes are dirty in it, so they stay
        # held. Twin: MOE_PREFLIGHT_DIRTY in preflight_landing.
        $dirty = @{}
        foreach ($k in $sPre.Keys) { $dirty[$k] = $true }
        $script:MoePreflightDirty = $dirty
        $head = ''
        $h = Invoke-MoeGit -Top $Git.Top -GitArgs @('rev-parse', '-q', '--verify', 'HEAD')
        if ($h.Rc -eq 0 -and $h.Out.Count -gt 0) { $head = ($h.Out -join '').Trim() }
        Write-MoeBaseline $baselinePath $TaskId $head $B $uLocal 0 $Sid $pre @{} | Out-Null
        # Claim the bytes this baseline arms: a session gets both or neither.
        # This runs on the launch path AND the resume path (a resumed session
        # is exactly as live as a fresh one). A marker already held by a LIVE
        # peer is left alone — overwriting it would hand the next seat a dead
        # owner to steal from once we exit.
        if (Test-MoeLiveMarkerForeignLive $Git.GitDir $TaskId) {
            Write-Host "[attribution] leaving the live-session marker of $TaskId to its current owner ($($script:MoeLiveOwner.Worker) pid=$($script:MoeLiveOwner.ProcId))." -ForegroundColor Cyan
        } else {
            Write-MoeLiveMarker $Git.GitDir $TaskId $Sid
        }

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
        # Same worktree-mode skip as Invoke-MoePreflightBaseline (sh: preflight_landing).
        if ($script:MoeWtMode -eq 'worktree' -or ($Role -ne 'worker' -and (Test-MoeControlWorktreeMode))) { return }
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

# The landing result this session actually produced, acknowledged on the pinned
# finalizing attempt: committed -> landed, a deliberate no-landing exit (no
# result at all: autoCommit=false, no git, a role that does not land) or an empty
# one -> nothing-to-commit, parked bytes -> rescued, everything else -> failed.
# Idempotent, and a running or closed attempt stays silent inside Send-MoeFinalize.
function Complete-MoePostflight {
    # Memoized with its answer: a worktree completion finalizes inside its
    # landing (Ctrl+C deferred), and the later calls repeat that answer.
    if ($script:MoeFinalizeDone) { return [bool]$script:MoeFinalizeRc }
    $script:MoeFinalizeDone=$true; $script:MoeFinalizeRc=$false
    $r=$script:MoeLandingResult
    $outcome='nothing-to-commit'; $sha=''
    if ($r) {
        # A worktree completion is landed only once its C is on the target
        # (Complete-MoeWorktreeLanding clears MoeWtCompletion then); until then a
        # committed outcome is its task-branch commit, even after an interrupt.
        if ($r.Outcome -eq 'committed' -and $script:MoeWtCompletion) { $outcome='failed' }
        elseif ($r.Outcome -eq 'committed') { $outcome='landed'; $sha=$r.Sha }
        elseif ($r.Outcome -eq 'nothing') { $outcome='nothing-to-commit' }
        elseif ($r.Ref -and $r.Sha) { $outcome='rescued' }
        else { $outcome='failed' }
        # CQ-V08: a strong landing finalizes only once its receipt is recorded. While
        # its journal waits on an unacknowledged receipt (or its proof did not
        # transfer) the attempt stays finalizing, which holds qa_approve and every
        # claim of the task, so nothing reaches DONE and no dependent is released
        # before the replay settles it. Twin: finalize_postflight.
        if ($outcome -eq 'landed' -and $script:PinnedAttemptProfile -ceq 'verified-local' -and
            ($r.ProofUntransferred -or (-not $r.ReceiptAcked -and $r.ReceiptJournal -and (Test-Path -LiteralPath $r.ReceiptJournal)))) {
            Write-Host "[WARN] MOE_FINALIZE_DEFERRED_RECEIPT: task $preflightTaskId -- the delivery receipt of $sha is not recorded; the attempt stays finalizing until a pre-flight replay records it, then finalizes." -ForegroundColor Yellow
            $script:MoeFinalizeRc=$true
            return $true
        }
    }
    $script:MoeFinalizeRc=[bool](Send-MoeFinalize $outcome $sha)
    # CQ-V08b: the strong journal goes only once its attempt is closed; a lost
    # finalize or an attempt still open keeps it for the next replay. Twin: finalize_postflight.
    if ($script:MoeFinalizeRc -and $outcome -eq 'landed' -and $script:PinnedAttemptProfile -ceq 'verified-local' -and $r.ReceiptJournal -and
        (Get-MoePinnedAttemptPhase) -ceq 'closed') {
        Remove-Item -LiteralPath $r.ReceiptJournal -Force -ErrorAction SilentlyContinue
    }
    return $script:MoeFinalizeRc
}

# Section 5 row C1: best-effort rescue ref from the outer finally when a
# session tears down (Ctrl+C, terminating error, exit 1) before its
# post-flight landed. Idempotent; the baseline stays so the next session's
# pre-flight lands the work on the branch.
#
# It also leaves the landing result for the Complete-MoePostflight call that
# follows it, with the same mapping as the sh twin's teardown_rescue:
#   bytes parked on a rescue ref                       -> rescued
#   deliberate autoCommit=false, or no git repo at all -> nothing-to-commit
#   anything else (no baseline, nothing parked)        -> failed
# (A landing that already reached an outcome sets $moeLandingDone and returns
# above -- a branch commit included, even one interrupted in its push or ledger
# record -- so that outcome is what gets acknowledged.)
function Invoke-MoeTeardownRescue {
    if ($script:MoeTeardownDone) { return }
    $script:MoeTeardownDone = $true
    try {
        if (-not $preflightTaskId -or $moeLandingDone) { return }
        $teardown = @{ Outcome = 'nothing'; Kind = 'rescue'; Sha = ''; Ref = ''; Code = '' }
        $script:MoeLandingResult = $teardown
        $settings = if ($null -ne $moeSettings) { $moeSettings } else { Read-MoeCommitSettings }
        if (-not $settings.autoCommit) { return }
        if ($null -eq $moeGit -and $null -eq (Get-MoeGitTop)) { return }
        $teardown.Outcome = 'failed'
        if ($null -eq $moeGit -or $null -eq $moeSettings) { return }
        if ($script:MoeWtMode -eq 'worktree' -or ($Role -ne 'worker' -and (Test-MoeControlWorktreeMode))) {
            $wtWhere = if ($script:MoeWtPath) { $script:MoeWtPath } else { $moeGit.Top }
            Write-Host "[rescue] worktree mode: bytes stay in $wtWhere for the next pre-flight; no rescue ref for task $preflightTaskId." -ForegroundColor Cyan
            return
        }
        $baselinePath = Get-MoeBaselinePath $moeGit.GitDir $preflightTaskId
        if (-not $baselinePath -or -not (Test-Path -LiteralPath $baselinePath)) { return }
        # The owner guard first: a session that does not own the task parks
        # nothing, an interrupted gate's frozen tree included.
        $guard = Get-MoeOwnerGuard $preflightTaskId $moeSid
        if ($guard.Code) {
            $teardown.Outcome = 'refused'; $teardown.Code = $guard.Code
            Send-MoeOwnerRefusal $preflightTaskId 'rescue' '' $moeSid $guard
            return
        }
        Write-Host "[rescue] session ended before landing task $preflightTaskId — parking its changes on a rescue ref." -ForegroundColor Yellow
        $rescue = Invoke-MoeRescueRef -Git $moeGit -TaskId $preflightTaskId -Reason 'teardown' -Title $preflightTaskTitle -Status '' -Sid $moeSid -Scope $guard.Scope
        if ($rescue) { $teardown.Ref = $rescue.Ref; $teardown.Sha = $rescue.Sha }
    } catch {}
}

# A tool_result's text: its string content, or the text parts of a
# [{type:text}] list (how Claude Code reports MCP results), unwrapping the
# {"result": ...} envelope Serena returns when an edit added diagnostics.
function Get-MoeToolResultText($Result) {
    $content = Get-MoeProp $Result 'content'
    $text = ''
    if ($content -is [string]) {
        $text = $content
    } elseif ($null -ne $content) {
        $parts = foreach ($part in @($content)) {
            $t = Get-MoeProp $part 'text'
            if ((Get-MoeProp $part 'type') -ceq 'text' -and $t -is [string]) { $t }
        }
        $text = @($parts) -join "`n"
    }
    $text = $text.Trim()
    if ($text.StartsWith('{', [StringComparison]::Ordinal)) {
        try {
            $inner = Get-MoeProp ($text | ConvertFrom-Json -ErrorAction Stop) 'result'
            if ($inner -is [string]) { $text = $inner.Trim() }
        } catch {}
    }
    return $text
}

# The Serena-relative paths a result-gated Serena editor changed, failing
# closed (a TOOL witness beats a peer's declaration): safe_delete_symbol only
# on 'OK' (a 'Cannot delete' answer changed nothing), rename_symbol only its
# declaring file on 'Successfully renamed' (the result names no referencing
# file: documented gap), replace_in_files exactly the files its applied summary
# lists (a dry run or a failed guard lists none). Twin of the sh parser's
# serena_changed.
function Get-MoeSerenaResultPaths([string]$Tool, $RelativePath, $Result) {
    $text = Get-MoeToolResultText $Result
    if ($Tool -eq 'safe_delete_symbol' -or $Tool -eq 'rename_symbol') {
        $ok = if ($Tool -eq 'safe_delete_symbol') { $text -ceq 'OK' } else { $text.StartsWith('Successfully renamed', [StringComparison]::Ordinal) }
        if ($ok -and $RelativePath -is [string] -and $RelativePath) { Write-Output $RelativePath }
        return
    }
    $lines = @($text -split "`n")
    if ($lines[0] -cnotmatch ('^Replaced \d+ ' + [regex]::Escape('occurrence(s) in') + ' \d+ ' + [regex]::Escape('file(s):') + '$')) { return }
    foreach ($ln in ($lines | Select-Object -Skip 1)) {
        if ($ln -cmatch '^  (.+): \d+$') { Write-Output $Matches[1] } else { break }
    }
}

# Stream-json harvest (claude only): record the paths the CLI's tools wrote.
# The result-gated Serena editors name what they changed only in their tool
# result: they yield paths only when Complete-MoeToolWrite passes $Result.
function Get-MoeToolWrittenPaths([string]$ToolName, $ToolInput, $Result = $null) {
    if (-not $ToolName -or $null -eq $ToolInput) { return }
    if ($null -eq $moeGit) { return }
    $paths = @()
    $kind = ''
    if ($ToolName -match '^(Edit|Write|MultiEdit|NotebookEdit)$') {
        $kind = 'abs'
        foreach ($k in @('file_path', 'notebook_path')) { $v = Get-MoeProp $ToolInput $k; if ($v -is [string] -and $v) { $paths += $v } }
    } elseif ($ToolName -match '(^|__)(replace_symbol_body|insert_after_symbol|insert_before_symbol|create_text_file|replace_regex|replace_content|delete_lines|replace_lines|insert_at_line)$') {
        $kind = 'serena'
        $v = Get-MoeProp $ToolInput 'relative_path'; if ($v -is [string] -and $v) { $paths += $v }
    } elseif ($ToolName -match '(^|__)(rename_symbol|safe_delete_symbol|replace_in_files)$') {
        $kind = 'serena'
        $paths = @(Get-MoeSerenaResultPaths $Matches[2] (Get-MoeProp $ToolInput 'relative_path') $Result)
    } else {
        return
    }
    foreach ($p in $paths) {
        $tp = ''
        if (Test-MoeAbsolutePath $p) {
            $tp = ConvertTo-MoeTopPathFromAbsolute $p $moeGit.Top
        } elseif ($kind -eq 'serena') {
            $tp = ConvertTo-MoeTopPathFromAbsolute (Join-Path $serenaProject $p) $moeGit.Top
        }
        if (-not $tp) {
            Write-Host "  [attribution] tool path outside the repo dropped: $p" -ForegroundColor DarkYellow
            continue
        }
        Write-Output $tp
    }
}

# A tool invocation is an intention, not proof of an edit. Keep only normalized
# paths (never tool input/result content), and publish them after its successful
# matching result. Terminal IDs prevent duplicate streamed/full messages from
# resurrecting a failed write. Overflow holds further evidence for this session.
# A result-gated Serena call keeps only its tool name (tagged by a NUL, which no
# path contains) and relative_path; Complete-MoeToolWrite resolves its paths.
function Register-MoeToolWrite([string]$Id, [string]$ToolName, $ToolInput) {
    if (-not $Id -or $Id.Length -gt 256 -or $script:MoeToolHarvestSaturated -or $script:MoeToolSettled.ContainsKey($Id)) { return }
    if ($null -ne $ToolInput -and $ToolName -match '(^|__)(rename_symbol|safe_delete_symbol|replace_in_files)$') {
        $rp = Get-MoeProp $ToolInput 'relative_path'
        $paths = @("`0$ToolName", $(if ($rp -is [string]) { $rp } else { '' }))
    } else {
        $paths = @(Get-MoeToolWrittenPaths $ToolName $ToolInput | Select-Object -First 501)
    }
    if ($paths.Count -eq 0) { return }
    if ($paths.Count -gt 500 -or $script:MoeToolPending.Count -ge 2048 -or $script:MoeToolSettled.Count -ge 8192) {
        $script:MoeToolHarvestSaturated = $true; $script:MoeToolPending.Clear(); return
    }
    if ($script:MoeToolPending.ContainsKey($Id) -and (($script:MoeToolPending[$Id] -join "`n") -ne ($paths -join "`n"))) {
        $script:MoeToolPending.Remove($Id); $script:MoeToolSettled[$Id] = $true; return
    }
    $script:MoeToolPending[$Id] = $paths
}

function Complete-MoeToolWrite($Result) {
    $id = Get-MoeProp $Result 'tool_use_id'
    if ($id -isnot [string] -or -not $id -or $id.Length -gt 256 -or $script:MoeToolHarvestSaturated -or $script:MoeToolSettled.ContainsKey($id)) { return }
    if ($script:MoeToolSettled.Count -ge 8192) { $script:MoeToolHarvestSaturated = $true; $script:MoeToolPending.Clear(); return }
    $script:MoeToolSettled[$id] = $true
    if (-not $script:MoeToolPending.ContainsKey($id)) { return }
    $paths = $script:MoeToolPending[$id]; $script:MoeToolPending.Remove($id)
    $failed = Get-MoeProp $Result 'is_error'
    $hasFlag = if ($Result -is [System.Collections.IDictionary]) { $Result.Contains('is_error') } else { $null -ne $Result.PSObject.Properties['is_error'] }
    if ($hasFlag -and ($failed -isnot [bool] -or $failed)) { return }
    if ($paths[0].StartsWith("`0", [StringComparison]::Ordinal)) {
        # A malformed result witnesses nothing and never throws into the stream loop.
        try { $paths = @(Get-MoeToolWrittenPaths $paths[0].Substring(1) @{ relative_path = $paths[1] } $Result | Select-Object -First 501) } catch { $paths = @() }
        if ($paths.Count -gt 500) { $script:MoeToolHarvestSaturated = $true; $script:MoeToolPending.Clear(); return }
    }
    foreach ($path in $paths) { $script:MoeToolWritten[(Get-MoePathKey $path)] = $path }
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
        Write-Host "Gemini mode: headless (--dangerously-skip-permissions)"
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
# How long a SINGLE-SHOT wrapper run keeps re-claiming before it gives up and
# exits without launching anything. A looping run does not use this: its outer
# relaunch loop is the wait. Same name and same default in moe-agent.sh.
$moeTasklessWaitSec = 300
if ($env:MOE_TASKLESS_WAIT_SEC -match '^\d+$') { $moeTasklessWaitSec = [int]$env:MOE_TASKLESS_WAIT_SEC }
if ($moeTasklessWaitSec -lt 5) { $moeTasklessWaitSec = 5 }
if ($moeTasklessWaitSec -gt 600) { $moeTasklessWaitSec = 600 }
$moeTasklessPollSec = 5
if ($moeTasklessPollSec -gt $moeTasklessWaitSec) { $moeTasklessPollSec = $moeTasklessWaitSec }
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

# Resume budget vs real progress (sh twin: plan_progress_mark /
# rearm_resume_on_progress). The budget is for a CLI that keeps dying without
# moving its task; a session that COMPLETED a plan step was not dying.
# Measured 2026-10-14: a seat on a long multi-session task had five sessions
# counted, two of which ran ~1 h and completed seven steps between them before
# a provider usage limit or a SIGTERM ended them (past MOE_LAUNCH_FAIL_SEC, so
# not launch failures). The wrapper posted "pausing auto-resume" and would have
# idled on its held task, leases and all, after the limit reset. Progress is
# the COMPLETED step count in get_context before the launch vs after the exit;
# a missing, unparseable or foreign payload proves nothing and keeps the count.
$script:PreflightProgressMark = $null
function Get-PlanProgressMark {
    param($Context, [string]$TaskId)
    if (-not $Context -or -not $TaskId -or -not $Context.PSObject.Properties['task']) { return $null }
    $task = $Context.task
    if (-not $task -or -not $task.PSObject.Properties['id'] -or [string]$task.id -ne $TaskId) { return $null }
    $completed = 0
    if ($task.PSObject.Properties['implementationPlan'] -and $task.implementationPlan) {
        foreach ($step in @($task.implementationPlan)) {
            if ($step -and $step.PSObject.Properties['status'] -and [string]$step.status -eq 'COMPLETED') { $completed++ }
        }
    }
    return $completed
}
function Update-ResumeBudgetOnProgress {
    param($Context, [string]$TaskId)
    $after = Get-PlanProgressMark -Context $Context -TaskId $TaskId
    if ($null -eq $script:PreflightProgressMark -or $null -eq $after) { return }
    if ($after -le $script:PreflightProgressMark) { return }
    if ($script:ResumeAttempts -gt 0 -or $script:ResumeEscalated) {
        Write-Host "[resume] $TaskId completed $($after - $script:PreflightProgressMark) plan step(s) this session ($($script:PreflightProgressMark) -> $after) -- resume budget re-armed." -ForegroundColor Green
    }
    $script:ResumeAttempts = 0
    $script:ResumeEscalated = $false
}

# Launch-failure tracking. A CLI that exits non-zero within MOE_LAUNCH_FAIL_SEC
# of starting never did any work: provider usage limit, expired credential, a
# crash at launch. Measured 2026-09-06: an account usage limit made every
# claude seat exit 1 at launch; each wrapper burned its resume budget in about
# three minutes, posted "pausing auto-resume" and then idled for hours after
# the limit had reset -- twice in one night. Such exits are NOT counted against
# the resume budget; the relaunch backs off exponentially instead (the held
# task stays held until the third one, when launch outage mode below releases it).
$script:LaunchFailStreak = 0
$script:LaunchFailBackoffSec = 0
$script:CliLaunchedAt = $null
$launchFailSec = 120
if ($env:MOE_LAUNCH_FAIL_SEC -match '^\d+$') { $launchFailSec = [int]$env:MOE_LAUNCH_FAIL_SEC }
$launchBackoffBaseSec = 60
if ($env:MOE_LAUNCH_BACKOFF_BASE_SEC -match '^\d+$') { $launchBackoffBaseSec = [int]$env:MOE_LAUNCH_BACKOFF_BASE_SEC }
$launchBackoffMaxSec = 900
if ($env:MOE_LAUNCH_BACKOFF_MAX_SEC -match '^\d+$') { $launchBackoffMaxSec = [int]$env:MOE_LAUNCH_BACKOFF_MAX_SEC }

# Launch outage mode (sh twin: the LAUNCH_OUTAGE block). Measured 2026-10-29: a
# codex seat whose credit was spent kept a HIGH task with 0/4 steps done behind
# the backoff above while an idle healthy seat waited, and earlier that day
# three codex tabs held two rows from ~01:53Z to 08:43Z, each ending a "CLI
# exit=1" session every ~15 min, until a human closed the tabs. Keeping the
# task assumed a launch failure clears in minutes; a spent credit or a broken
# credential lasts hours. So at the third launch failure in a row a claiming
# seat (AutoClaim, never a governor) enters outage mode: once that iteration's
# post-flight has landed and finalized the task as it was, the seat releases it
# for another seat (never with force: a refusal, or a BLOCKED hold, keeps it),
# claims no new task, and relaunches as a taskless launch probe on the same
# backoff. The first launch that runs ends the outage and claiming resumes.
# Claude seats that rotate accounts relaunch on the next account instead
# ($script:AccountRelaunch resets the streak).
$script:LaunchOutage = $false
# The task the seat still holds in outage, '' for none: pre-flight then skips
# claim_next_task, which CLAIMS a task for a worker that holds none.
$script:LaunchOutageHeldTaskId = ''
# The last task this outage tried to release: a held task gets one attempt.
$script:LaunchOutageReleaseTried = ''
# Set on the iteration that enters the outage, for the line its post-flight posts.
$script:LaunchOutageAnnounce = $false
$script:LaunchOutageReleaseCode = ''
$script:LaunchFailHead = ''

# Invoke-MoeLaunchOutageRelease TASK_ID -- moe.release_task with an outage
# handoff, fenced by the pinned attempt when there is one. $true = released;
# $false = refused or unanswered, with the daemon's codeName (else NO_ANSWER)
# in $script:LaunchOutageReleaseCode. Never force: RELEASE_NOT_ASSIGNEE,
# STEP_LEASE_HELD or ATTEMPT_SUPERSEDED mean the row is not this seat's to
# drop. whatIsDone must not read as an empty-progress handoff (releaseTask.ts
# isEmptyProgressHandoff: "nothing", "none", "no progress ..."): three of those
# in 24h park the task in BACKLOG, and a seat outage is not a task refusal.
# Twin: launch_outage_release.
function Invoke-MoeLaunchOutageRelease([string]$TaskId) {
    $script:LaunchOutageReleaseCode = 'NO_ANSWER'
    $note = @{
        whatIsDone  = "Seat outage, not a task refusal: this seat's CLI exited within ${launchFailSec}s of launch $($script:LaunchFailStreak) times in a row (last exit code $cliExitForLaunch), so this seat did no work in those launches; earlier progress on the task (completed steps, commits, handoff notes) is untouched."
        whatRemains = 'Everything the task had left before those launches: continue from its context, completed steps and earlier handoffs.'
    }
    $releaseArgs = @{ taskId = $TaskId; workerId = $WorkerId; reason = 'seat launch outage'; handoffNote = $note }
    if ($script:MoeAttemptId -and (Test-MoeGeneration $script:MoeAttemptGeneration)) {
        $releaseArgs.attemptId = $script:MoeAttemptId
        $releaseArgs.generation = $script:MoeAttemptGeneration
    }
    $released = $null
    try { $released = Invoke-MoeRpc -Tool 'release_task' -Args $releaseArgs } catch { $script:MoeRpcFailure = 'transport' }
    if ($null -ne $released) { return $true }
    # Invoke-MoeRpc keeps a daemon refusal's data.codeName.
    if ($script:MoeRpcFailure -eq 'daemon refusal' -and $script:MoeRpcCodeName) { $script:LaunchOutageReleaseCode = [string]$script:MoeRpcCodeName }
    return $false
}

# Invoke-MoeLaunchOutagePostflight -- runs once the iteration's post-flight is
# done, so the landing and finalize saw the task as it was. A failed launch that
# held a task this outage has not tried yet releases it (a BLOCKED one keeps its
# seat), and the iteration that entered the outage posts the @governors line
# with what actually happened. Twin: launch_outage_postflight.
function Invoke-MoeLaunchOutagePostflight {
    $what = ''
    if ($moeCurrentLaunchFailed -and $preflightTaskId -and [string]$preflightTaskId -ne $script:LaunchOutageReleaseTried) {
        if ([string]$finalStatus -eq 'BLOCKED') {
            $script:LaunchOutageHeldTaskId = [string]$preflightTaskId
            $what = "Kept ${preflightTaskId}: it is BLOCKED, and a resource-blocked task keeps its seat"
        } else {
            $script:LaunchOutageReleaseTried = [string]$preflightTaskId
            if (Invoke-MoeLaunchOutageRelease ([string]$preflightTaskId)) {
                $script:LaunchOutageHeldTaskId = ''
                $what = "Released $preflightTaskId for another seat"
            } else {
                $script:LaunchOutageHeldTaskId = [string]$preflightTaskId
                $what = "Could not release $preflightTaskId ($($script:LaunchOutageReleaseCode)), so this seat still holds it"
            }
        }
        Write-Host "[launch-outage] $what." -ForegroundColor Yellow
    }
    if (-not $script:LaunchOutageAnnounce) { return }
    $script:LaunchOutageAnnounce = $false
    if (-not $what) { $what = 'No task was bound to these launches, so none was released' }
    if (-not $generalChannelId) { return }
    $msg = "$($script:LaunchFailHead) $what; this seat claims no new task until a launch probe succeeds (probes back off up to ${launchBackoffMaxSec}s, next in $($script:LaunchFailBackoffSec)s)."
    try { Invoke-MoeRpc -Tool 'chat_send' -Args @{ channel = $generalChannelId; workerId = $WorkerId; content = $msg } | Out-Null } catch {}
}

# --- Claude account rotation (docs/TROUBLESHOOTING.md "Claude Account Rotation
# Issues"). Twin of the moe-agent.sh block of the same name. Before every claude
# launch the wrapper leases a subscription account from the daemon
# (moe.lease_account) and runs claude under that account's config directory.
# The directory, MOE_ACCOUNT_ID and MOE_ACCOUNT_SAMPLE_FILE enter this process's
# environment only around the spawn (Set-MoeAccountEnv / Restore-MoeAccountEnv),
# with the token variables removed for that spawn. The only file opened inside
# a config directory is an interactive seat's .claude.json, where
# moe-account-lease.mjs `trust` sets the launch directory's folder-trust key
# (human sign-off 2026-10-26, task-7a0b1881): -p seats never see Claude's trust
# dialog, a TUI on a never-trusted account would park at it. Every other
# failure mode launches unrotated; "every signed-in account is spent" and "the
# account could not be trusted" wait, holding the task.
$accountHelper = Join-Path $PSScriptRoot 'moe-account-lease.mjs'
$script:AccountSampleFile = Join-Path $env:TEMP "moe-account-sample-$Role-$myPid.json"
$script:AccountSettingsFile = Join-Path $env:TEMP "moe-account-settings-$Role-$myPid.json"
$script:AccountLeasedId = ''
$script:AccountLeasedDir = ''
$script:AccountPrevId = ''
$script:AccountSampleSent = ''
$script:AccountWindows = [ordered]@{}
$script:AccountSampleRefused = $false
$script:AccountRelaunch = $false
$script:AccountLastFailed = ''
$script:AccountSavedEnv = $null
$accountArgs = @()
# TOKEN_ENV and PROVIDER_ENV in moe-account-lease.mjs: a token outranks the
# account's login, and the gate already stood down for a set provider switch.
$moeAccountChildEnvDrop = @('ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN',
    'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY')

# One line from moe-account-lease.mjs ('' when it printed nothing), or $null
# when node or the helper failed.
function Invoke-MoeAccountHelper {
    param([string[]]$HelperArgs, [string]$InputText)
    $prevEAP = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        if ($PSBoundParameters.ContainsKey('InputText')) { $out = @($InputText | & node $accountHelper @HelperArgs 2>$null) }
        else { $out = @(& node $accountHelper @HelperArgs 2>$null) }
        if ($LASTEXITCODE -ne 0) { return $null }
        return [string]($out | Select-Object -First 1)
    } catch { return $null } finally { $ErrorActionPreference = $prevEAP }
}

function Clear-MoeAccountLease {
    $script:AccountLeasedId = ''
    $script:AccountLeasedDir = ''
    $script:AccountSampleSent = ''
    $script:AccountWindows = [ordered]@{}
    $script:AccountSampleRefused = $false
    $script:accountArgs = @()
    Remove-Item -LiteralPath $script:AccountSampleFile -Force -ErrorAction SilentlyContinue
}

function Get-MoeAccountLease {
    if (-not (Test-Path -LiteralPath $accountHelper)) {
        Write-Host "[account] MOE_ACCOUNT_LEASE_UNAVAILABLE (moe-account-lease.mjs is missing next to this wrapper) - launching without rotation." -ForegroundColor Yellow
        return
    }
    $gate = @("$(Invoke-MoeAccountHelper -HelperArgs @('gate'))" -split "`t")
    if ($gate[0] -ceq 'off') { return }
    if ($gate[0] -ceq 'skip') { Write-Host "[account] $($gate[1])" -ForegroundColor Yellow; return }
    if ($gate[0] -cne 'go') {
        Write-Host "[account] MOE_ACCOUNT_LEASE_UNAVAILABLE (the account helper failed) - launching without rotation." -ForegroundColor Yellow
        return
    }
    # One #general line per account per call.
    $escalated = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
    while ($true) {
        $reply = Invoke-MoeRpc -Tool 'lease_account' -Args @{ workerId = $WorkerId }
        $replyJson = if ($null -ne $reply) { $reply | ConvertTo-Json -Depth 5 -Compress } else { '' }
        $f = @("$(Invoke-MoeAccountHelper -HelperArgs @('pick') -InputText $replyJson)" -split "`t")
        if ($f[0] -ceq 'leased' -and $f.Count -ge 4) {
            if ($script:AccountPrevId -and $script:AccountPrevId -cne $f[1]) {
                Write-Host "[account] MOE_ACCOUNT_SWITCHED from=$($script:AccountPrevId) to=$($f[1])" -ForegroundColor Yellow
            }
            $script:AccountPrevId = $f[1]
            $script:AccountLeasedId = $f[1]
            $script:AccountLeasedDir = $f[3]
            $usage = if ($f[2] -ceq '?') { 'unknown' } else { "$($f[2])%" }
            Write-Host "[account] MOE_ACCOUNT_LEASED account=$($f[1]) usage=$usage" -ForegroundColor Green
            # Only the TUI asks "Do you trust the files in this folder?"; a ps1
            # claude runs in this launcher's cwd, so that is the launch directory.
            if (-not $claudeInteractive) { return }
            $trust = Invoke-MoeAccountHelper -HelperArgs @('trust', $f[3], $projectPath, (Get-Location).ProviderPath)
            if ($trust -ceq 'trusted') { return }
            if ($trust -ceq 'granted') {
                Write-Host "[account] MOE_ACCOUNT_TRUST_GRANTED account=$($f[1]) project=$projectPath" -ForegroundColor Green
                return
            }
            $t = @("$trust" -split "`t")
            if ($t[0] -cne 'refused' -or $t.Count -lt 3) {
                Clear-MoeAccountLease
                Write-Host "[account] MOE_ACCOUNT_LEASE_UNAVAILABLE (the account helper failed) - launching without rotation." -ForegroundColor Yellow
                return
            }
            $trustSec = 0
            if (-not [int]::TryParse($t[1], [ref]$trustSec) -or $trustSec -lt 1) { $trustSec = 300 }
            Clear-MoeAccountLease
            Write-Host "[account] MOE_ACCOUNT_UNTRUSTED account=$($f[1]) project=$projectPath ($($t[2])) - not launching into Claude's folder-trust dialog; retry in ${trustSec}s, the held task stays held. (Ctrl+C to stop)" -ForegroundColor Yellow
            # Never the config directory: no account folder may reach the daemon.
            if ($escalated.Add($f[1])) {
                Send-MoeGeneralChat "@governors ${WorkerId}: MOE_ACCOUNT_UNTRUSTED - account $($f[1]) does not trust project $projectPath and Moe could not grant it ($($t[2])). The interactive seat waits instead of parking at Claude's folder-trust dialog. Fix: start claude once in $projectPath under that account's folder (claude-accounts/$($f[1])) and accept the trust dialog."
            }
            Start-Sleep -Seconds $trustSec
            continue
        }
        if ($f[0] -ceq 'wait' -and $f.Count -ge 3) {
            $waitSec = 0
            if (-not [int]::TryParse($f[1], [ref]$waitSec) -or $waitSec -lt 1) { $waitSec = 60 }
            Write-Host "[account] MOE_ACCOUNT_WAIT retry_in=${waitSec}s next_reset=$($f[2]) - every signed-in account is spent; the held task stays held. (Ctrl+C to stop)" -ForegroundColor Yellow
            Start-Sleep -Seconds $waitSec
            continue
        }
        if ($f[0] -ceq 'off') {
            if ($f.Count -gt 1 -and $f[1]) { Write-Host "[account] $($f[1])" -ForegroundColor Yellow }
            return
        }
        $why = if ($f[0] -ceq 'unavailable' -and $f.Count -gt 1 -and $f[1]) { $f[1] } else { 'the account helper failed' }
        Write-Host "[account] MOE_ACCOUNT_LEASE_UNAVAILABLE ($why) - launching without rotation." -ForegroundColor Yellow
        return
    }
}

# Process-scoped Git hooks: only the native CLI call owns the appended entries.
function Initialize-MoeAgentGitGuard {
    $program = @'
const fs = require('fs'), path = require('path'), cp = require('child_process');
const [project, temp] = process.argv.slice(-2), win = process.platform === 'win32';
const native = p => win ? p.replaceAll('\\', '/') : p;
const env = { ...process.env, LC_ALL: 'C' };
const git = (cwd, args, e = env) => cp.spawnSync('git', ['-C', cwd, ...args], { env: e, encoding: 'utf8', timeout: 10000, maxBuffer: 1048576 });
const value = r => { if (r.status !== 0) throw Error('git'); return r.stdout.replace(/\n$/, ''); };
const shell = s => "'" + s.replaceAll("'", "'\\''") + "'";
let root;
try {
    const count = process.env.GIT_CONFIG_COUNT || '', n = Number(count);
    if (!/^\d*$/.test(count) || !Number.isSafeInteger(n) || n > 2147483646) throw Error('config');
    const identity = git(project, ['rev-parse', '--absolute-git-dir']);
    if (identity.status === 128 && /^fatal: not a git repository\b/.test(identity.stderr || '')) {
        // A broken/redirected repository is not an ordinary non-Git project.
        if (['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR'].some(k => process.env[k])) throw Error('identity');
        for (let dir = path.resolve(project);;) {
            try { fs.lstatSync(path.join(dir, '.git')); throw Error('identity'); }
            catch (e) { if (e.code !== 'ENOENT') throw e; }
            const parent = path.dirname(dir); if (parent === dir) break; dir = parent;
        }
        process.exit(0); // No Git protection is claimed.
    }
    const gitdir = native(value(identity));
    const top = value(git(project, ['rev-parse', '--is-bare-repository'])) === 'true'
        ? gitdir : value(git(project, ['rev-parse', '--show-toplevel']));
    const original = native(value(git(top, ['rev-parse', '--path-format=absolute', '--git-path', 'hooks'])));
    for (const p of [gitdir, original, temp]) if (!path.isAbsolute(p) || /[\x00-\x1f\x7f]/.test(p)) throw Error('path');
    root = fs.mkdtempSync(path.join(temp, 'moe-git-guard-'));
    fs.chmodSync(root, 0o700);
    if (win) {
        const acl = "$ErrorActionPreference='Stop'; $p='" + root.replaceAll("'", "''") + "'; $a=Get-Acl -LiteralPath $p; $a.SetAccessRuleProtection($true,$false); " +
            "$a.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.WindowsIdentity]::GetCurrent().User,'FullControl','ContainerInherit,ObjectInherit','None','Allow')); Set-Acl -LiteralPath $p -AclObject $a";
        // pwsh 7 lists its own modules first in PSModulePath, and a Windows PowerShell 5.1 child that inherits it cannot load Get-Acl.
        const psenv = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.toUpperCase() !== 'PSMODULEPATH'));
        value(cp.spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(acl, 'utf16le').toString('base64')], { env: psenv, encoding: 'utf8', timeout: 10000, maxBuffer: 1048576 }));
    }
    const hooks = native(path.join(root, 'hooks')), config = native(path.join(root, 'config'));
    fs.mkdirSync(hooks, { mode: 0o700 });
    let names;
    try { names = fs.readdirSync(original); } catch (e) { if (e.code !== 'ENOENT') throw e; names = []; }
    for (const name of new Set(['pre-commit', 'pre-push', ...names])) {
        const target = shell(native(path.join(original, name)));
        const deny = ['pre-commit', 'pre-push'].includes(name)
            ? 'if [ "${MOE_ALLOW_AGENT_GIT_WRITES:-}" != 1 ]; then\n  echo "MOE_AGENT_GIT_REFUSED: the wrapper lands the work" >&2\n  exit 1\nfi\n' : '';
        fs.writeFileSync(path.join(hooks, name), '#!/bin/sh\n' + deny + `if [ -x ${target} ] && [ ! -d ${target} ]; then exec ${target} "$@"; fi\nexit 0\n`, { mode: 0o700 });
    }
    // Wildmatch, config-value quoting and shell quoting are independent layers.
    fs.writeFileSync(config, '[core]\n hooksPath = "' + hooks.replace(/[\\"]/g, '\\$&') + '"\n', { mode: 0o600 });
    const key = `includeIf.gitdir${win ? '/i' : ''}:${gitdir.replace(/[\\*?[]/g, '\\$&')}.path`;
    const added = { [`GIT_CONFIG_KEY_${n}`]: key, [`GIT_CONFIG_VALUE_${n}`]: config, GIT_CONFIG_COUNT: String(n + 1) };
    if (native(value(git(top, ['rev-parse', '--path-format=absolute', '--git-path', 'hooks'], { ...env, ...added }))) !== hooks) throw Error('validation');
    fs.writeFileSync(path.join(root, "env.json"), JSON.stringify(added), { mode: 0o600 });
    fs.writeFileSync(path.join(root, "env"), Object.entries(added).map(([k,v]) => k+"="+v+"\0").join(""), { mode: 0o600 });
    process.stdout.write(root);
} catch {
    try { if (root) fs.rmSync(root, { recursive: true, force: true }); } catch {}
    process.stderr.write('MOE_AGENT_GIT_GUARD_FAILED: refusing to launch an unprotected CLI\n'); process.exit(1);
}
'@
    $script:AgentGitGuardRoot = $program | & node - $projectPath ([IO.Path]::GetTempPath())
    if ($LASTEXITCODE -ne 0) { throw 'MOE_AGENT_GIT_GUARD_FAILED: refusing to launch an unprotected CLI' }
    $script:AgentGitGuard = if ($script:AgentGitGuardRoot) {
        [IO.File]::ReadAllText((Join-Path $script:AgentGitGuardRoot "env.json")) | ConvertFrom-Json
    } else { $null }
}
function Invoke-MoeGuardedCommand {
    $saved = @{}
    try {
        foreach ($p in $script:AgentGitGuard.PSObject.Properties) {
            $saved[$p.Name] = [Environment]::GetEnvironmentVariable($p.Name)
            [Environment]::SetEnvironmentVariable($p.Name, $p.Value)
        }
        & $Command @args
        $code = $LASTEXITCODE
    } finally {
        foreach ($name in $saved.Keys) { [Environment]::SetEnvironmentVariable($name, $saved[$name]) }
    }
    $global:LASTEXITCODE = $code
}
function Remove-MoeAgentGitGuard {
    if ($script:AgentGitGuardRoot) { Remove-Item -LiteralPath $script:AgentGitGuardRoot -Recurse -Force }
    $script:AgentGitGuardRoot = $null
    $script:AgentGitGuard = $null
}

# The values never leave this process: they are held in memory only to put
# back right after the spawn, so an unrotated launch later still sees them.
function Set-MoeAccountEnv {
    $script:AccountSavedEnv = $null
    if (-not $script:AccountLeasedId) { return }
    $saved = @{}
    foreach ($name in @('CLAUDE_CONFIG_DIR', 'MOE_ACCOUNT_ID', 'MOE_ACCOUNT_SAMPLE_FILE') + $moeAccountChildEnvDrop) {
        $saved[$name] = [Environment]::GetEnvironmentVariable($name)
    }
    $script:AccountSavedEnv = $saved
    $env:CLAUDE_CONFIG_DIR = $script:AccountLeasedDir
    $env:MOE_ACCOUNT_ID = $script:AccountLeasedId
    $env:MOE_ACCOUNT_SAMPLE_FILE = $script:AccountSampleFile
    foreach ($name in $moeAccountChildEnvDrop) { [Environment]::SetEnvironmentVariable($name, $null) }
}

function Restore-MoeAccountEnv {
    if (-not $script:AccountSavedEnv) { return }
    foreach ($name in @($script:AccountSavedEnv.Keys)) { [Environment]::SetEnvironmentVariable($name, $script:AccountSavedEnv[$name]) }
    $script:AccountSavedEnv = $null
}

# Sends the latest usage sample once. $false only when the daemon did not take it.
function Send-MoeAccountSample {
    if (-not $script:AccountLeasedId -or -not (Test-Path -LiteralPath $script:AccountSampleFile)) { return $true }
    $body = try { [IO.File]::ReadAllText($script:AccountSampleFile) } catch { '' }
    if (-not $body -or $body -ceq $script:AccountSampleSent) { return $true }
    $sample = try { $body | ConvertFrom-Json -ErrorAction Stop } catch { $null }
    if (-not $sample -or [string]$sample.accountId -cne $script:AccountLeasedId) { return $true }
    $sent = Invoke-MoeRpc -Tool 'report_account_usage' -Args @{ workerId = $WorkerId; accountId = $script:AccountLeasedId
        windows = $sample.windows; refused = ($sample.refused -eq $true) }
    if ($null -eq $sent) { return $false }
    $script:AccountSampleSent = $body
    return $true
}

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
# restart: the reloaded pass captures the new hash and cannot thrash if the
# file is touched again mid-flight.
# Only load committed bytes: on 2026-10-30 three seats re-exec'd onto
# task-e7f4026a's uncommitted, unreviewed +79/-8 wrapper edit.
$script:MoeWrapperPath = $PSCommandPath
$script:MoeWrapperLaunchHash = $null
$script:MoeWrapperRefusedHash = $null
$script:MoeWrapperDeferredHash = $null
# Twin: wrapper_reload_deferred. Return true to defer, false to reload.
function Test-MoeWrapperReloadDeferred([string]$Hash) {
    $reason = ''
    try {
        $top = Split-Path -Parent $script:MoeWrapperPath
        if (-not $top) { throw 'wrapper directory is empty' }
        $leaf = Split-Path -Leaf $script:MoeWrapperPath
        $gitCmd = 'ls-files'
        $result = Invoke-MoeGit -Top $top -GitArgs @('ls-files', '--error-unmatch', '--', $leaf)
        if ($result.Rc -eq 0) {
            $gitCmd = 'diff'
            $result = Invoke-MoeGit -Top $top -GitArgs @('diff', '--quiet', 'HEAD', '--', $leaf)
            if ($result.Rc -eq 0) { return $false }
        }
        if ($result.Rc -ne 1) { $reason = "git $gitCmd exited $($result.Rc)" }
    } catch {
        $reason = "git check failed: $($_.Exception.Message)"
    }
    if ($Hash -ne $script:MoeWrapperDeferredHash) {
        $script:MoeWrapperDeferredHash = $Hash
        if (-not $reason) {
            Write-Host '[INFO] MOE_WRAPPER_RELOAD_DEFERRED: wrapper has uncommitted edits; staying on the current bytes until they are committed'
        } else {
            Write-Host "[WARN] MOE_WRAPPER_RELOAD_DEFERRED: cannot confirm the wrapper bytes are committed ($reason); staying on the current bytes" -ForegroundColor Yellow
        }
    }
    return $true
}
# Set by the restart check below and read once, past the outer finally, by the
# hand-over at the very bottom of this file.
$script:MoeWrapperRelaunchRequested = $false
try {
    if ($script:MoeWrapperPath -and (Test-Path -LiteralPath $script:MoeWrapperPath)) {
        $script:MoeWrapperLaunchHash = Get-MoeSha256Hex ([IO.File]::ReadAllBytes($script:MoeWrapperPath))
    }
} catch {
    # FAIL-OPEN. A wrapper that dies because it could not stat itself is a fleet
    # outage; a stale wrapper is merely the status quo this guard improves on.
    $script:MoeWrapperLaunchHash = $null
}

# PowerShell parses this whole file before running it: an in-place save cannot
# shift a running seat onto a stale offset, so no grouping is needed here.
# The sh twin groups its main loop and tail as { ... exit } (task-f31d415d).
try {
do {
    # Receipt metadata belongs to one actual CLI launch, never a prior task.
    $env:MOE_USAGE_RECEIPT_FILE = $null
    $env:MOE_USAGE_CONTEXT_JSON = $null
    if (-not $firstRun) {
        Write-Host ""
        if ($script:LaunchFailBackoffSec -gt 0) {
            if ($script:LaunchOutage -and -not $script:LaunchOutageHeldTaskId) {
                Write-Host "[launch-outage] Backing off $($script:LaunchFailBackoffSec)s before the next launch probe (streak $($script:LaunchFailStreak)); this seat holds no task and claims none until a probe launches. (Ctrl+C to stop)" -ForegroundColor Yellow
            } else {
                Write-Host "[launch-failure] Backing off $($script:LaunchFailBackoffSec)s before relaunching (streak $($script:LaunchFailStreak)); the held task stays held. (Ctrl+C to stop)" -ForegroundColor Yellow
            }
            Start-Sleep -Seconds $script:LaunchFailBackoffSec
        } elseif ($script:AccountRelaunch) {
            Write-Host "[account] Relaunching now on the next account." -ForegroundColor Yellow
        } else {
            Write-Host "Agent idle, checking for tasks in ${PollInterval} seconds... (Ctrl+C to stop)"
            Start-Sleep -Seconds $PollInterval
        }
        Write-Host "Relaunching agent..."
    }
    # Read once, just above: an iteration that skipped the poll sleep for an
    # account relaunch must not skip it again (the reload deferral below
    # `continue`s straight back here).
    $script:AccountRelaunch = $false

    # Top of the iteration, AFTER the poll sleep and BEFORE any task dispatch, so
    # a restart can never interleave with a half-done completion.
    if ($script:MoeWrapperLaunchHash) {
        $moeCurrentHash = $null
        try {
            $moeCurrentHash = Get-MoeSha256Hex ([IO.File]::ReadAllBytes($script:MoeWrapperPath))
        } catch {
            $moeCurrentHash = $null   # FAIL-OPEN: keep running the current bytes
        }
        if ($moeCurrentHash -and $moeCurrentHash -ne $script:MoeWrapperLaunchHash -and $moeCurrentHash -ne $script:MoeWrapperRefusedHash -and -not (Test-MoeWrapperReloadDeferred $moeCurrentHash)) {
            # A seat launched from the shared checkout reloads every edit of
            # this file, and a half-applied edit used to cost it its
            # registration and then its process (the supervisor's `&` threw).
            # So parse the new bytes first, with the engine's own reader:
            # bytes that fail are refused once per hash, and the seat keeps
            # serving the bytes it already parsed. A failed parse call is a
            # refusal too, never a reload.
            $moeParseReason = ''
            try {
                $moeParseErrors = $null
                $null = [System.Management.Automation.Language.Parser]::ParseFile($script:MoeWrapperPath, [ref]$null, [ref]$moeParseErrors)
                if ($moeParseErrors.Count -gt 0) { $moeParseReason = "line $($moeParseErrors[0].Extent.StartLineNumber): $($moeParseErrors[0].Message)" }
            } catch {
                $moeParseReason = "ParseFile failed: $($_.Exception.Message)"
            }
            if ($moeParseReason) {
                $script:MoeWrapperRefusedHash = $moeCurrentHash
                Write-Host "[WARN] MOE_WRAPPER_RELOAD_REFUSED: wrapper source changed on disk but does not parse; staying on the current bytes until it changes again: $moeParseReason" -ForegroundColor Yellow
            } else {
                Write-Host "wrapper source changed on disk; restarting to load it"
                # The hand-over itself happens past the outer finally, IN THIS
                # PROCESS AND CONSOLE (the supervisor at the top of this file runs
                # the file again). Until 2026-09-18 this was a `Start-Process`,
                # which gives the relaunched wrapper its OWN console window and
                # leaves the launching terminal at a prompt: the operator reads that
                # as a dead seat and relaunches the same worker id, so two wrapper
                # loops share it and both resume the held task. Measured that day on
                # qa-a36819c3 (two CLIs reviewing one REVIEW row, one deleting the
                # other's harness log) and on worker-d0c3b06e. The sh twin `exec`s
                # in place for the same reason.
                # Deregister BEFORE handing over (sh twin parity, same reason
                # string): the next pass registers afresh, and the post-flight
                # above has already landed this session's work.
                Stop-HeartbeatSidecar
                if ($script:CurrentHeartbeatJob) {
                    Write-Host '[WARN] MOE_HEARTBEAT_STOP_TIMEOUT: deferring wrapper reload to preserve the pending helper handle.' -ForegroundColor Yellow
                    continue
                }
                Invoke-MoeDeregister -Reason 'wrapper_restart'
                $script:MoeWrapperRelaunchRequested = $true
                break
            }
        }
    }

    $isFirstIteration = $firstRun
    $firstRun = $false

    $script:CliExitCode = 0

    # -------- Pre-flight: perform startup rituals BEFORE spawning the CLI --------
    $script:MoeFrozen=$null; $script:MoeLandingResult=$null; $script:MoeFinalizeDone=$false; $script:MoeFinalizeRc=$false
    $script:MoeEvidenceUnavailable=''; $script:MoeAttemptReadError=''
    # The env pair too: no CLI inherits a previous task's attempt (the ps1 hot-reload supervisor keeps env).
    $script:MoeAttemptId = ""; $script:MoeAttemptGeneration = $null; Remove-Item Env:MOE_ATTEMPT_ID, Env:MOE_ATTEMPT_GENERATION -ErrorAction SilentlyContinue
    $script:PinnedAttemptProfile = ''; $script:PinnedAttemptPlanRevision = $null
    $script:MoeRunnerId ="runner-" + [guid]::NewGuid().ToString("N")
    $preflightTaskId = ""
    $script:MoeWtMode = 'shared'; $script:MoeWtPath = ''; $script:MoeWtBranch = ''; $script:MoeWtTarget = ''; $script:MoeWtDirtList = ''; $script:MoeWtCompletion = $false
    $script:cliRoot = "$projectPath"; Remove-Item Env:MOE_WORKTREE_PATH, Env:MOE_TASK_BRANCH, Env:MOE_LAND_TARGET -ErrorAction SilentlyContinue
    if ($script:cliRootPushed) { Pop-Location; $script:cliRootPushed = $false }
    if ($script:MoeMcpConfigDirty) { $mcpConfigObj | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $mcpConfigFile -Encoding UTF8; $script:MoeMcpConfigDirty = $false }
    # Per-task launch hint from claim_next_task (reset so a tier never leaks into the next task).
    $taskLaunchTier = ""; $taskLaunchModel = ""; $taskLaunchEffort = ""; $taskLaunchCodexModel = ""; $taskLaunchCodexEffort = ""
    $preflightHeldTaskId = ""
    $preflightTaskTitle = ""
    $preflightTaskChannel = ""
    $preflightContext = $null
    $script:PreflightProgressMark = $null
    $preflightGeneralUnread = $null
    $preflightRoutedUnread = $null
    $preflightTaskUnread = $null
    $preflightPending = $null
    $preflightSkillName = $null
    $preflightSkillReason = $null
    $preflightSkillNextTool = $null
    $preflightOk = $false
    $preflightNoTask = $false
    $preflightIsResume = $false
    $preflightRoutedMentions = @()
    # Taskless-launch state. A CLI that can edit code is only ever launched
    # with a task already bound, so these three record WHY a taskless
    # iteration happened and decide between "launch nothing" and "launch a
    # chat-only session". Spelled identically in moe-agent.sh.
    $preflightClaimFailed = $false
    $preflightHasUnreadMention = $false
    # Land-on-every-exit state. Reset per iteration so nothing leaks across
    # tasks: the session id, the repo probe, the baseline path, the
    # "bytes handled" flag the teardown rescue keys on, and the stream-json
    # tool-write harvest.
    # The pre-flight instant, `<workerId>@<preflight-iso>`: the Moe-Session id of this
    # iteration's landing, computed once here (not only under autoCommit) and exported for
    # the seat, because moe.record_commit requires it as `sessionId` and an isolated-clone
    # delivery can read it from nowhere else (no preflight scope.json when
    # settings.autoCommit is false). Twin: moe-agent.sh MOE_SID / MOE_SESSION_ID.
    $moeSid = "$WorkerId@" + (Get-Date).ToUniversalTime().ToString("yyyy-MM-dd'T'HH:mm:ss'Z'")
    # moe-proxy (CQ-F09/F12a) also stamps it onto the CLI's get_context/start_step/complete_step/complete_task,
    # and the attempt pair onto the last three.
    $env:MOE_SESSION_ID = $moeSid
    $moeGit = $null
    $moeSettings = $null
    $moeBaselinePath = ""
    $moeLandingDone = $false
    $moeStopLoop = $false
    $moeCurrentLaunchFailed = $false
    # This iteration's launch is a taskless launch probe (launch outage mode).
    $moeLaunchProbe = $false
    $script:MoeToolWritten = @{}
    $script:MoeToolPending = [hashtable]::new([StringComparer]::Ordinal)
    $script:MoeToolSettled = [hashtable]::new([StringComparer]::Ordinal)
    $script:MoeToolHarvestSaturated = $false
    $script:MoePreflightEvidence = $null
    $script:MoePreflightDirty = $null
    $script:MoeLastLanding = $null

    if ($AutoClaim) {
        Write-Host "Pre-flight: joining chat, claiming task, loading context..." -ForegroundColor Cyan

        # Re-register before any chat call. A pruned or DEAD worker record makes
        # chat refuse this seat's reply as an unknown sender and keeps no read
        # cursor, so a mention would relaunch it in vain on every idle pass.
        # While the join fails the seat reads no chat; its mentions stay unread.
        $seatRegistered = Invoke-MoeTeamJoinRetry -Force

        # Resolve #general channel id (chat tools take channel id, not name)
        $generalChannelId = $null
        $channelsResp = if ($seatRegistered) { Invoke-MoeRpc -Tool "chat_channels" -Args @{} } else { $null }
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
            if ($script:LaunchOutage -and -not $script:LaunchOutageHeldTaskId) {
                # Launch outage, nothing held: claim_next_task CLAIMS a task for a
                # worker that holds none, and the next fast exit would strand it.
                # Answer it the empty way, as the governor branch above does; the
                # launch below is a taskless launch probe.
                Write-Host "[launch-outage] Launch outage (streak $($script:LaunchFailStreak)): this seat holds no task, so it calls no claim_next_task until a launch probe succeeds." -ForegroundColor Yellow
                $claim = [pscustomobject]@{ hasNext = $false }
            } else {
                $claim = Invoke-MoeRpc -Tool "claim_next_task" -Args $claimRpcArgs
            }
            # A teamless seat is refused with code NO_TEAM_MEMBERSHIP, which is not an
            # empty queue: say so, or the [no-task] banner below reads as "no work".
            # The daemon is the authority on membership, so the next claim poll
            # re-joins even a seat whose earlier join had succeeded.
            if (Test-MoeClaimNoTeam $claim) {
                $script:teamJoined = $false
                if (-not $teamJoinLastError) { $script:teamJoinLastError = 'claim_next_task answered NO_TEAM_MEMBERSHIP' }
                Write-Host "[WARN] claim_next_task refused with NO_TEAM_MEMBERSHIP - this seat has NO team, so claim_next_task skips every epic a live worker already holds; the queue is not empty." -ForegroundColor Yellow
            }
            Invoke-MoeReceiptReplay
            # Before the pin below reads the attempt: a restart may have parked it.
            if ($claim) { Invoke-MoeReattachOwnAttempts }
        }

        # Role-group tag for @architects/@workers/@qa routing. Computed HERE
        # rather than beside the mention extraction below because the
        # wrapper-side wait needs it first.
        $roleGroupTag = switch ($Role) { "architect" { "architects" } "worker" { "workers" } "qa" { "qa" } "governor" { "governors" } default { "" } }
        # #general/current-task reads miss routed mentions in role or peer
        # channels. Ask the daemon for its routed backlog (loop guard intact).
        # This SHORT poll fits the proxy's 2s stdin-EOF grace; never use the
        # normal long-poll default here. Governors own their live chat waiter.
        if ($Role -ne 'governor' -and $seatRegistered) {
            $preflightRoutedUnread = Invoke-MoeRpc -Tool "chat_wait" -Args @{ workerId = $WorkerId; channels = @(); timeoutMs = 1000 }
        }
        # Does anything ALREADY unread tag this worker? moe.wait_for_task only
        # wakes on NEW messages, so entering the wait with an unanswered
        # mention in hand would sit on it for the whole timeout.
        foreach ($unread in @($preflightGeneralUnread, $preflightRoutedUnread)) {
            foreach ($msg in @($unread.messages)) {
                if (-not $msg -or -not $msg.mentions) { continue }
                foreach ($m in $msg.mentions) {
                    if ($m -eq $WorkerId -or $m -eq "all" -or ($roleGroupTag -and $m -eq $roleGroupTag)) { $preflightHasUnreadMention = $true; break }
                }
                if ($preflightHasUnreadMention) { break }
            }
        }

        # -------- Wrapper-side task wait (bind the task BEFORE the launch) ----
        # NOT moe.wait_for_task, and that is measured rather than preferred:
        # Invoke-MoeRpc pipes ONE json line into a fresh moe-proxy and closes
        # stdin, and the proxy treats stdin EOF as shutdown, erroring every
        # still-open request after a flat 2s grace ("Proxy shutting down before
        # response received" -- reproduced against a real daemon on
        # 2026-09-12). A blocking long-poll therefore cannot survive this
        # transport in either wrapper, so the wait is a bounded CLAIM poll over
        # the same non-blocking RPC the pre-flight already uses.
        # The per-task baseline, the live-session marker and the post-flight
        # landing all key on $preflightTaskId. A CLI told to claim inside
        # itself therefore edits with no snapshot of what was already dirty
        # and lands nothing at all, silently. So the WRAPPER does the waiting
        # and the claiming; the claimed session then falls through the
        # EXISTING baseline block and the EXISTING launch, with no second
        # delivery path and no hand-made baseline anywhere.
        #
        # Skipped for: a claim that already succeeded or that reported a held
        # task (the resume path owns that), the governor (never claims;
        # taskless is its normal state), AutoClaim=false (the operator opted
        # out of the whole claim/baseline/landing path), a pending unread
        # mention (answered by a chat-only session below instead of waited on),
        # and a launch outage (the seat claims no new task until a probe launches).
        if ($AutoClaim -and $Role -ne 'governor' -and -not $script:LaunchOutage -and -not $preflightHasUnreadMention -and $null -ne $claim) {
            $claimHeldTaskId = ""
            if ($claim.PSObject.Properties['alreadyAssigned'] -and $claim.alreadyAssigned -and $claim.alreadyAssigned.taskId) {
                $claimHeldTaskId = [string]$claim.alreadyAssigned.taskId
            }
            if (-not $claim.hasNext -and -not $claimHeldTaskId -and $loopEnabled) {
                # The outer relaunch loop IS the wait: it sleeps $PollInterval
                # and re-runs this pre-flight. Adding a second loop here would
                # duplicate it; the launch below is suppressed instead.
                Write-Host "[no-task] No claimable task for role $Role; not launching a CLI without one - the wrapper polls again in ${PollInterval}s." -ForegroundColor DarkGray
            } elseif (-not $claim.hasNext -and -not $claimHeldTaskId) {
                # Single-shot run (-NoLoop / -PollInterval 0): there is no next
                # iteration, so the waiting happens HERE rather than in a CLI
                # told to claim itself. Idle waiting is NOT a resume attempt --
                # the resume budget counts relaunches at a HELD task -- so no
                # resume counter is touched.
                Write-Host "[no-task] No claimable task for role $Role; waiting up to ${moeTasklessWaitSec}s in the wrapper (single-shot run) rather than launching a CLI without one." -ForegroundColor DarkGray
                $tasklessWaited = 0
                while ($tasklessWaited -lt $moeTasklessWaitSec) {
                    Start-Sleep -Seconds $moeTasklessPollSec
                    $tasklessWaited += $moeTasklessPollSec
                    if (-not $teamJoined) { [void](Invoke-MoeTeamJoinRetry) }
                    $claim = Invoke-MoeRpc -Tool "claim_next_task" -Args $claimRpcArgs
                    if (Test-MoeClaimNoTeam $claim) { $script:teamJoined = $false }
                    if ($null -eq $claim) {
                        # Unreachable daemon/proxy. Falling through to a launch
                        # is exactly the hole being closed, so stop waiting and
                        # let the seat exit without an unbound CLI.
                        Write-Host "[WARN] claim_next_task stopped answering during the wait; not launching an unbound CLI." -ForegroundColor Yellow
                        $preflightClaimFailed = $true
                        break
                    }
                    $claimHeldTaskId = ""
                    if ($claim.PSObject.Properties['alreadyAssigned'] -and $claim.alreadyAssigned -and $claim.alreadyAssigned.taskId) {
                        $claimHeldTaskId = [string]$claim.alreadyAssigned.taskId
                    }
                    if ($claim.hasNext -or $claimHeldTaskId) {
                        Write-Host "[no-task] A claimable task appeared after ${tasklessWaited}s; claimed in the wrapper." -ForegroundColor Green
                        break
                    }
                }
            }
        }
        # -------- End wrapper-side task wait --------
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
            # Remember the observed binding even when resume is suppressed.
            # This is diagnostic evidence only, never a task baseline.
            $preflightHeldTaskId = if ($resumeInfo) { [string]$resumeInfo.taskId } else { "" }
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

                Set-MoeAttemptIdentity $claim $preflightTaskId

                # Per-task tier: claim_next_task (claim or alreadyAssigned resume)
                # may carry launch {tier, effort, model}. Unknown effort values and
                # odd model strings are dropped, leaving the seat defaults.
                if ($claim.PSObject.Properties['launch'] -and $claim.launch) {
                    $launch = $claim.launch
                    if ($launch.PSObject.Properties['tier'] -and [string]$launch.tier -in @('light', 'standard', 'heavy')) {
                        $taskLaunchTier = [string]$launch.tier
                        if ($launch.PSObject.Properties['effort'] -and [string]$launch.effort -in @('low', 'medium', 'high', 'xhigh', 'max')) { $taskLaunchEffort = [string]$launch.effort }
                        if ($launch.PSObject.Properties['model'] -and [string]$launch.model -match '^[A-Za-z0-9._:/@-]{1,128}$') { $taskLaunchModel = [string]$launch.model }
                        if ($launch.PSObject.Properties['codex'] -and $launch.codex) {
                            $codexLaunch = $launch.codex
                            if ($codexLaunch.PSObject.Properties['model'] -and [string]$codexLaunch.model -match '^[A-Za-z0-9._:/@-]{1,128}$') { $taskLaunchCodexModel = [string]$codexLaunch.model }
                            if ($codexLaunch.PSObject.Properties['effort'] -and [string]$codexLaunch.effort -in @('low', 'medium', 'high', 'xhigh', 'max')) { $taskLaunchCodexEffort = [string]$codexLaunch.effort }
                        }
                    }
                }
                # The one context read the CLI is served: it names this session, so the daemon records its receipt.
                if ($preflightTaskId) {
                    $preflightContextArgs = @{ taskId = $preflightTaskId }
                    if ($env:MOE_SESSION_ID) { $preflightContextArgs.sessionId = $env:MOE_SESSION_ID }
                    $preflightContext = Invoke-MoeRpc -Tool "get_context" -Args $preflightContextArgs
                    $script:PreflightProgressMark = Get-PlanProgressMark -Context $preflightContext -TaskId $preflightTaskId
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
                if ($script:LaunchOutage) {
                    # No wait ran: the launch decision below names the launch probe.
                } elseif (Test-MoeSeatTeamless) {
                    Write-Host "[WARN] No task claimed for role $Role after the wrapper-side wait, and this seat is TEAMLESS (moe.join_team: $teamJoinLastError), so claims skip every epic+status a live worker already holds." -ForegroundColor Yellow
                } else {
                    Write-Host "[INFO] No claimable task for role $Role after the wrapper-side wait." -ForegroundColor Yellow
                }
            }
            # Launch outage: whenever a claim answered, keep what it says the seat
            # holds (its task, a suppressed BLOCKED or capped hold, or nothing),
            # so a seat the daemon left holding nothing stops claiming.
            if ($script:LaunchOutage -and $claim -isnot [string]) {
                $script:LaunchOutageHeldTaskId = if ($preflightTaskId) { [string]$preflightTaskId } else { [string]$preflightHeldTaskId }
            }
        } elseif ($AutoClaim -and $Role -ne 'governor') {
            # Same hole as the taskless prompt, different trigger: an
            # unanswered claim RPC used to render the in-agent claim chain,
            # which is a CLI editing with no baseline and no landing. Back off
            # and let the outer loop retry instead.
            $preflightClaimFailed = $true
            # In a launch outage this is an iteration with no task, so every CLI
            # branch gets the launch probe prompt, never a legacy claim chain.
            if ($script:LaunchOutage) { $preflightNoTask = $true }
            Write-Host "[WARN] Pre-flight claim RPC failed; not falling back to an in-agent claim (that session would have no baseline and would land nothing)." -ForegroundColor Yellow
        } else {
            Write-Host "[WARN] Pre-flight claim RPC failed; falling back to in-agent claim." -ForegroundColor Yellow
        }

        # Filter unread messages for ones routed at THIS worker. Claude otherwise
        # sees a wall of <general_unread> and tends to skip replying. The
        # <routed_mentions> banner injected below gives the model a focused list.
        # Match directly on workerId, on @all, or on the role-group tag this
        # worker belongs to (architects/workers/qa).
        $buckets = @()
        if ($preflightGeneralUnread -and $preflightGeneralUnread.messages) { $buckets += ,$preflightGeneralUnread.messages }
        if ($preflightRoutedUnread  -and $preflightRoutedUnread.messages)  { $buckets += ,$preflightRoutedUnread.messages }
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
    $dynamicContext = ""
    $dynamicContext += $systemAppendPost
    # A headless loop may launch without a claim solely to answer routed
    # mentions. Claiming later inside that CLI bypasses the task baseline and
    # postflight, both keyed to the preflight task id. Return to the wrapper.
    $notificationPrompt = $null
    if ($AutoClaim -and ($preflightNoTask -or $preflightClaimFailed) -and -not $preflightOk -and $Role -ne 'governor') {
        if ($script:LaunchOutage) {
            # Launch outage: this taskless session is the launch probe (see the
            # single taskless launch decision below); it only has to start and answer.
            $notificationPrompt = "This is a launch probe for workerId=$WorkerId after repeated launch failures: the wrapper launched it to see whether this CLI starts at all, and no task is bound to it (no task baseline or delivery tracking). If routed mentions are supplied, reply to each via moe.chat_send; otherwise reply OK. Then end your turn immediately. Do NOT call moe.wait_for_task or moe.claim_next_task, edit project files, run task gates, or perform task work in this session, even if a reply or nextAction recommends claiming."
        } else {
            $notificationPrompt = "This is a notification-only session for workerId=$WorkerId. No task was claimed at preflight and this session has no task baseline or delivery tracking. Reply to the supplied routed mentions via moe.chat_send FIRST; answer any supplied pending questions via moe.add_comment. Then end your turn immediately so the wrapper can claim and baseline a task in a fresh session. Do NOT call moe.wait_for_task or moe.claim_next_task, edit project files, run task gates, or perform task work in this session, even if a reply or nextAction recommends claiming."
        }
    }
    if ($preflightOk) {
        # get_context owns role scoping and bounded sections. Preserve its
        # payload, including scope, architecture, evidence and omitted hints.
        $ctxJson = if ($preflightContext) {
            $preflightContext | ConvertTo-Json -Depth 20 -Compress
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

Do not repeat moe.chat_join or moe.claim_next_task at session start. The daemon-scoped moe.get_context payload is below; re-fetch it if it is missing or stale. Use view:"full" only if you need a section listed in omitted.

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
    } elseif ($notificationPrompt) {
        $dynamicContext += $notificationPrompt
    } elseif ($preflightNoTask) {
        $dynamicContext += @"
# Pre-flight Complete: no claimable task
The daemon reports no claimable task for role $Role right now.
Start with moe.wait_for_task with statuses=$(ConvertTo-Json @($statuses) -Compress), workerId=$WorkerId.
When it returns hasNext:true, call moe.claim_next_task, then moe.get_context.
If moe.wait_for_task returns hasChatMessage:true, call moe.chat_read on chatMessage.channel and reply with moe.chat_send before calling moe.wait_for_task again. Do not claim a new task while a routed mention is unanswered.
"@
    }

    # -------- Worktree provisioning (worker seats; design §1) --------
    # Before the pre-flight baseline, so a refusal leaves no fresh baseline; not
    # gated on autoCommit. Provisions W or stops the seat (Initialize-MoeWorktree).
    if ($AutoClaim -and $preflightOk -and $preflightTaskId -and $Role -eq 'worker') { Initialize-MoeWorktree $preflightTaskId $claim $preflightContext }

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
    if ($script:MoeWtMode -eq 'worktree') {
        # Recovery checkpoint + control-dirt list (twin: worktree_preflight).
        $moeWtStatus = ''
        if ($preflightContext -and $preflightContext.task -and $preflightContext.task.PSObject.Properties['status']) { $moeWtStatus = [string]$preflightContext.task.status }
        Invoke-MoeWorktreePreflight $preflightTaskId $preflightTaskTitle $moeWtStatus $moeSid
        Initialize-MoeWorktreeLaunch ([ref]$dynamicContext)
    }

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
    # Codex uses a separate private user-context file; Gemini folds context into its instructions.
    # PowerShell 5.1's `&` operator doesn't escape embedded double quotes when
    # forwarding native-command args on Windows. Task JSON serialized into $dynamicContext routinely
    # contains "..." substrings (e.g. `\"audit.read\"`), which causes codex/gemini to word-split the
    # prompt argv (e.g. "unexpected argument 'VERIFICATION' found"). Claude reads its system prompt
    # from --append-system-prompt-file, so its bug surface is the (mostly quote-free) role directive.
    $codexUsesFileContext = $false
    if ($cliType -eq "codex") {
        # Shared fallback stays role-neutral; otherwise a sibling role can change
        # the prefix. Private stable instructions and private task context remain
        # separate: task text must never enter model_instructions_file.
        $agentInstructionsPath = Join-Path (Join-Path $script:cliRoot ".codex") "agent-instructions.md"
        $codexDir = Split-Path $agentInstructionsPath -Parent
        if (-not (Test-Path $codexDir)) { New-Item -ItemType Directory -Force -Path $codexDir | Out-Null }
        [System.IO.File]::WriteAllText($agentInstructionsPath, 'Moe role instructions are supplied by the launcher. Follow the user message for this session context.', [System.Text.UTF8Encoding]::new($false))
        $script:CodexSeatInstructionsFile = Join-Path $env:TEMP "moe-codex-instructions-$Role-$PID.md"
        $fileBody = $systemAppend
        $script:CodexSessionContextFile = Join-Path $env:TEMP ("moe-codex-context-" + [guid]::NewGuid().ToString('N') + '.md')
        if ($dynamicContext) {
            [System.IO.File]::WriteAllText($script:CodexSessionContextFile, $dynamicContext, [System.Text.UTF8Encoding]::new($false))
            $codexUsesFileContext = $true
        }
        [System.IO.File]::WriteAllText($script:CodexSeatInstructionsFile, $fileBody, [System.Text.UTF8Encoding]::new($false))
        Write-Host "Agent instructions written to: $($script:CodexSeatInstructionsFile) (shared role doc: $agentInstructionsPath)"
    } elseif ($cliType -eq "gemini") {
        $geminiInstructionsDir = Join-Path $script:cliRoot ".gemini"
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
            "architect" {
                # An interactive planner may claim more PLANNING rows in-session:
                # submit_plan clears its seat and closes its attempt, and a plan's
                # only bytes are board records the landing commits anyway. A codex/
                # gemini/grok TUI does not loop, so without this every planned row
                # costs an operator exit plus a seat relaunch. Headless planners
                # keep one task per CLI; MOE_ARCHITECT_TASKS_PER_SESSION=1 restores
                # that for TUIs too. The sh twin resolves this identically.
                $architectSessionTasks = 0
                if (-not ("$env:MOE_ARCHITECT_TASKS_PER_SESSION" -match '^\d+$' -and [int]::TryParse("$env:MOE_ARCHITECT_TASKS_PER_SESSION", [ref]$architectSessionTasks)) -or $architectSessionTasks -lt 1) { $architectSessionTasks = 10 }
                if ((($cliType -eq 'claude' -and $Interactive) -or $codexInteractive -or $geminiInteractive -or $grokInteractive) -and $architectSessionTasks -gt 1) {
                    "Task $preflightTaskId is claimed and its daemon-scoped context is above (<claimed_task_context>). If a <routed_mentions> block is present, reply to each tagged message via moe.chat_send FIRST. Read the recent task comments before acting; if absent or truncated, call moe.get_context with commentsMaxChars: 0 for them. Read prior knowledge via Serena read_memory on the memory names preloaded in <inbox> (call list_memories only if they don't cover your area). Then study the implementationPlan, rails, and definitionOfDone, and call moe.submit_plan with a complete plan. After each moe.submit_plan, use Serena write_memory to record a 'task-<taskId>-handoff' note (and any reusable 'decision-<area>' learnings). This interactive session may plan up to $architectSessionTasks tasks, this one included: after each plan and its handoff note, call moe.claim_next_task with statuses ['PLANNING'] and workerId '$WorkerId'; on hasNext:true call moe.get_context for the claimed task and plan it the same way. Stop claiming once you have planned $architectSessionTasks tasks or a claim returns hasNext:false. Then output a one-line text summary naming every task you planned and STOP. Do NOT poll moe.check_approval — approval is a human gate. Do NOT call moe.wait_for_task — the wrapper will pick up the next task in a fresh session."
                } else {
                    "Task $preflightTaskId is claimed and its daemon-scoped context is above (<claimed_task_context>). If a <routed_mentions> block is present, reply to each tagged message via moe.chat_send FIRST. Read the recent task comments before acting; if absent or truncated, call moe.get_context with commentsMaxChars: 0 for them. Read prior knowledge via Serena read_memory on the memory names preloaded in <inbox> (call list_memories only if they don't cover your area). Then study the implementationPlan, rails, and definitionOfDone, and call moe.submit_plan with a complete plan. Before you STOP, use Serena write_memory to record a 'task-$preflightTaskId-handoff' note (and any reusable 'decision-<area>' learnings). Then output a one-line text summary of what you planned and STOP. Do NOT poll moe.check_approval — approval is a human gate. Do NOT call moe.wait_for_task — the wrapper will pick up the next task in a fresh session."
                }
            }
            "worker"    { "Task $preflightTaskId is claimed and its daemon-scoped context is above (<claimed_task_context>). If a <routed_mentions> block is present, reply to each tagged message via moe.chat_send FIRST. Read the recent task comments before acting; if absent or truncated, call moe.get_context with commentsMaxChars: 0 for them. Read prior knowledge via Serena read_memory on the memory names preloaded in <inbox> (call list_memories only if they don't cover your area). Then execute the approved implementationPlan: call moe.start_step for step 0, implement it (write/edit code and run only verification permitted by the current rails; if a required check is prohibited rather than explicitly deferred, call moe.report_blocked and never treat an unrun check as passing), call moe.complete_step, and repeat through the final step. Then call moe.complete_task. Before you STOP, use Serena write_memory to record a 'task-$preflightTaskId-handoff' note plus any non-obvious 'gotcha-<area>' learnings. Then output a one-line text summary and STOP. Do NOT call moe.wait_for_task — the wrapper will pick up the next task in a fresh session." }
            "qa"        { "Task $preflightTaskId is claimed and its daemon-scoped context is above (<claimed_task_context>). If a <routed_mentions> block is present, reply to each tagged message via moe.chat_send FIRST. Read the recent task comments before acting; if absent or truncated, call moe.get_context with commentsMaxChars: 0 for them. Read prior knowledge via Serena read_memory on the memory names preloaded in <inbox> (call list_memories only if they don't cover your area). Then verify the implementation against definitionOfDone and rails. Run only verification permitted by the current rails; if a required check is prohibited rather than explicitly deferred, call moe.report_blocked and never treat an unrun check as passing. If it passes, call moe.qa_approve. If it fails, call moe.qa_reject with a detailed list of issues. Before you STOP, use Serena write_memory to record a 'task-$preflightTaskId-handoff' note (and any 'gotcha-<area>' failure pattern). Then output a one-line text summary and STOP. Do NOT call moe.wait_for_task — the wrapper will pick up the next task in a fresh session." }
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
    } elseif ($notificationPrompt) {
        $claimPromptBody = $notificationPrompt
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
    # Use each CLI's resolved mode: an explicit *Exec override can differ
    # from the generic role default, and an explicit TUI must get the exit hint.
    $oneShotSession = switch ($cliType) {
        'codex' { -not $codexInteractive }
        'gemini' { -not $geminiInteractive }
        'grok' { -not $grokInteractive }
        default { -not $Interactive }
    }
    if ($claimPromptBody -and $oneShotSession -and $Role -ne 'governor' -and -not $notificationPrompt) {
        $claimPromptBody += " One-shot session: this CLI process exits when you end your turn, and any background jobs/builds/tests die with it, so a completion notification cannot arrive after you stop. Never end your turn to 'wait for' a background task: run it in the foreground or poll it to completion first. End your turn only after your terminal moe.* call for this task (submit_plan / complete_task / qa_approve / qa_reject / report_blocked) has succeeded."
    } elseif ($cliType -in @('claude', 'grok', 'codex', 'gemini') -and $AutoClaim -and $preflightOk -and $claimPromptBody -and $Role -ne 'governor' -and -not $notificationPrompt) {
        # An interactive TUI stays open after the agent stops, and the wrapper
        # claims the next task only once the CLI exits: without this line the
        # seat parks after every task until the operator notices.
        $claimPromptBody += " INTERACTIVE session: this TUI stays open after you stop, and the wrapper claims the next task only once the CLI exits. End your one-line summary with: 'Exit this CLI session (e.g. /exit; keep the terminal tab open) to start the next task.'"
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

    $script:CliLaunchedAt = Get-Date

    # -------- Single taskless launch decision (all CLI types) --------
    # No task bound means no baseline, no live-session marker and no landing,
    # so the ONLY thing such a session may do is answer chat. With nothing to
    # answer there is nothing for a CLI to do at all: skip the spawn and let
    # the outer loop (or this single-shot run) end. Deliberately NOT gated on
    # $loopEnabled -- a -NoLoop run has already done its waiting in the
    # wrapper, so launching an unbound CLI here would be the very defect this
    # closes rather than a fallback. Governor keeps its terminal; AutoClaim=false
    # is the operator owning the session. A launch outage is the one taskless
    # launch with nothing to answer: the probe (its prompt is $notificationPrompt
    # above) shows whether the CLI starts again, and the outer loop's
    # launch-failure backoff paces the probes.
    $moeSkipLaunch = $false
    if ($AutoClaim -and ($preflightNoTask -or $preflightClaimFailed) -and -not $preflightOk -and $Role -ne 'governor') {
        if ($script:LaunchOutage) {
            $moeLaunchProbe = $true
            Write-Host "MOE_LAUNCH_PROBE role=$Role worker=$WorkerId streak=$($script:LaunchFailStreak) - launch outage: launching a taskless launch probe; claiming resumes once a launch succeeds." -ForegroundColor Yellow
        } elseif ($preflightRoutedMentions.Count -eq 0) {
            $moeSkipLaunch = $true
        }
    }
    if (-not $moeSkipLaunch -and $cliType -in @('claude', 'codex')) {
        # Settings can change between tasks in a long-lived wrapper.
        & node $promptCacheHelper check $cliType "$projectPath" @CommandArgs
        if ($LASTEXITCODE -ne 0) { exit 1 }
    }
    # Claude account rotation: a fresh lease for every claude launch. The check
    # above stays on the operator's own config directory; nothing reads inside
    # an account's except an interactive seat's folder-trust key (the lease
    # sets it).
    if ($script:MoeWtMode -eq 'worktree') { Push-Location -LiteralPath $script:cliRoot; $script:cliRootPushed = $true }
    Clear-MoeAccountLease
    if (-not $moeSkipLaunch -and $cliType -eq 'claude') {
        Get-MoeAccountLease
        # A wait for a free or trusted account is not launch time.
        $script:CliLaunchedAt = Get-Date
    }
    if (-not $moeSkipLaunch) { Initialize-MoeAgentGitGuard }
    if ($moeSkipLaunch) {
        if ($preflightClaimFailed) {
            Write-Host "MOE_TASKLESS_NO_LAUNCH reason=claim-failed role=$Role worker=$WorkerId - the claim RPC is unreachable; no CLI is launched without a task bound." -ForegroundColor Yellow
        } elseif (Test-MoeSeatTeamless) {
            Write-Host "MOE_TASKLESS_NO_LAUNCH reason=teamless role=$Role worker=$WorkerId - no task claimed and this seat has NO team (moe.join_team: $teamJoinLastError), so claims skip every epic+status a live worker already holds; the join is retried before the next claim." -ForegroundColor Yellow
        } else {
            Write-Host "MOE_TASKLESS_NO_LAUNCH reason=idle role=$Role worker=$WorkerId - no claimable task and nothing to answer." -ForegroundColor DarkGray
        }
        if ($cliType -eq 'codex' -and $script:CodexSessionContextFile) {
            Remove-Item -LiteralPath $script:CodexSessionContextFile -Force -ErrorAction SilentlyContinue
        }
        $script:CliExitCode = 0
    } elseif ($cliType -eq "codex") {
        # Check codex is available
        $codexCheck = Get-Command $Command -ErrorAction SilentlyContinue
        if (-not $codexCheck) {
            Write-Error "Codex command not found: $Command. Install codex CLI first."
            exit 1
        }

        if ($AutoClaim -and ($preflightOk -or $preflightNoTask)) {
            # Pre-flight wrote a private session-context file. When it includes
            # $dynamicContext (see $codexUsesFileContext branch above), argv carries ONLY
            # a short quote-free directive — PS < 7.3 forwards native args without escaping embedded
            # double quotes, so any raw task JSON or chat text on argv word-splits the prompt
            # (codex: "unrecognized subcommand"). This must hold even when $claimPromptBody is null
            # (no-task-with-mentions pre-flight): never fall back to $claimPrompt here, because that
            # IS the dynamic context (routed mention text = arbitrary quotes) that just crashed on argv.
            if ($codexUsesFileContext) {
                if ($claimPromptBody) {
                    $shortPrompt = $claimPromptBody
                } else {
                    $shortPrompt = "If a routed_mentions block is present, reply to each tagged message via moe.chat_send as workerId $WorkerId. Then follow your role doc."
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

        if ($codexUsesFileContext) {
            $shortPrompt = "First read the private session context file at $($script:CodexSessionContextFile). It contains your task binding, inbox and routed mentions. " + $shortPrompt
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
            # Per-seat config overrides, passed on argv so they can never be
            # clobbered by a sibling seat writing the shared .codex/config.toml:
            # this seat's instructions file, and its workerId for the proxy's
            # injection (codex does not forward the wrapper's environment to
            # MCP servers). The instructions path is not valid TOML, so codex
            # keeps it as a string; forward slashes keep it free of TOML escapes.
            # The workerId rides a complete moe server table (Get-CodexMoeServerOverride).
            $codexSeatArgs = @()
            if ($script:CodexSeatInstructionsFile) {
                $codexSeatArgs += @('-c', "model_instructions_file=$($script:CodexSeatInstructionsFile.Replace('\', '/'))")
            }
            $codexSeatArgs += @('-c', (Get-CodexMoeServerOverride (Join-Path (Join-Path $script:cliRoot '.codex') 'config.toml') $WorkerId))
            # Per-task model/effort (launch.codex hint). An operator pin wins:
            # --model / settings.models.<role> keeps the model, MOE_CODEX_REASONING_EFFORT
            # keeps the effort; with no hint, config.toml's model_reasoning_effort applies.
            $iterCodexModel = ""; $iterCodexEffort = ""
            if (-not $explicitModel -and $taskLaunchCodexModel) { $iterCodexModel = $taskLaunchCodexModel; $codexSeatArgs += @('-m', $iterCodexModel) }
            if (-not $env:MOE_CODEX_REASONING_EFFORT -and $taskLaunchCodexEffort) { $iterCodexEffort = $taskLaunchCodexEffort; $codexSeatArgs += @('-c', "model_reasoning_effort=$iterCodexEffort") }
            if ($taskLaunchTier) {
                $codexModelLabel = if ($iterCodexModel) { $iterCodexModel } else { 'default' }
                $codexEffortLabel = if ($iterCodexEffort) { $iterCodexEffort } elseif ($env:MOE_CODEX_REASONING_EFFORT) { $env:MOE_CODEX_REASONING_EFFORT } else { 'xhigh' }
                Write-Host "[OK] Task tier: $taskLaunchTier (model $codexModelLabel, effort $codexEffortLabel)" -ForegroundColor Green
            }
            if ($CodexExec) {
                # Non-interactive exec mode: codex -c <seat overrides> -c approvals_reviewer=user exec -C <project> [--sandbox <mode>] "<prompt>"
                # Never pass --full-auto here: codex-cli 0.147+ rejects it (`error: unexpected
                # argument '--full-auto' found`, exit 2 before any work -- a relaunch loop the
                # launch-failure backoff misreads as a provider/credential problem). openai/codex
                # #20133 (2026-04-29) deprecated it in `exec` and dropped it from the TUI; #36054
                # hard-removed it in 0.147.0 (0.130-0.146 accepted it with a warning), and the
                # standalone codex installer auto-updates. The fleet only hit it on 2026-09-07
                # because 8b632b5 (2026-09-06) made worker/qa seats default to `codex exec`; before
                # that this branch never ran. `codex exec` already runs with approval_policy = never
                # in headless mode (kept by the reviewer pin below), so the sandbox flag alone carries
                # what --full-auto meant. MOE_CODEX_SANDBOX picks the sandbox (read-only |
                # workspace-write | danger-full-access; default danger-full-access); `inherit` omits
                # the flag so the merged ~/.codex + <project>/.codex config decides -- read-only when
                # neither sets sandbox_mode. The default is full access, not workspace-write, because
                # of two codex behaviors measured 2026-09-07 on 0.153.4 (both absent under full
                # access, which codex treats as bypass-everything): (1) since 0.148 `approval_policy =
                # never` plus any sandbox makes codex refuse every MCP tool it deems approval-worthy
                # -- every moe.* tool, none carry a readOnlyHint -- with `MCP tool call requires
                # approval, but approval policy is never`, so a headless worker cannot even
                # start_step (the config writer also pins default_tools_approval_mode = "approve" on
                # the moe and serena servers, so an explicit workspace-write keeps MCP working);
                # (2) on Windows the unelevated sandbox (`[windows] sandbox = "unelevated"` in
                # ~/.codex/config.toml) spawns commands under a restricted token that cannot execute
                # a Microsoft Store pwsh.exe (the WindowsApps alias codex picks from PATH): every
                # command fails `CreateProcessAsUserW failed: 5 (Access is denied.)`. `codex sandbox
                # -- pwsh -NoProfile -Command exit` reproduces that offline; an MSI PowerShell 7 or
                # MOE_CODEX_SANDBOX=danger-full-access avoids it. Without `[windows] sandbox` at all,
                # workspace-write silently runs read-only on Windows.
                # The sh twin resolves the same env the same way; parity-check pins the vocabulary.
                $codexSandboxMode = if ($env:MOE_CODEX_SANDBOX) { $env:MOE_CODEX_SANDBOX.Trim().ToLowerInvariant() } else { 'danger-full-access' }
                $codexSandboxArgs = @()
                if ($codexSandboxMode -eq 'inherit') {
                    $codexSandboxArgs = @()
                } elseif (@('read-only', 'workspace-write', 'danger-full-access') -contains $codexSandboxMode) {
                    $codexSandboxArgs = @('--sandbox', $codexSandboxMode)
                } else {
                    Write-Host "[WARN] MOE_CODEX_SANDBOX='$($env:MOE_CODEX_SANDBOX)' is not one of read-only | workspace-write | danger-full-access | inherit; using danger-full-access." -ForegroundColor Yellow
                    $codexSandboxArgs = @('--sandbox', 'danger-full-access')
                }
                $codexSandboxBanner = if ($codexSandboxArgs.Count -gt 0) { ' ' + ($codexSandboxArgs -join ' ') } else { '' }
                # --full-auto also kept approval_policy = never when the operator's config resolves
                # approvals_reviewer = "auto_review" (codex 0.130-0.146 set
                # preserve_headless_approval_policy for it; 0.147+ does so only for
                # --dangerously-bypass-approvals-and-sandbox). Pin the reviewer to `user` for the
                # headless seat so exec keeps its never override: under auto_review escalations go
                # to the guardian reviewer, approved commands run outside the sandbox, and any
                # approval that reaches the exec client is rejected (exit 1). `user` is not valid
                # TOML, so codex keeps the literal string; pre-0.130 ignores the unknown key.
                $codexExecOverrides = @('-c', 'approvals_reviewer=user')
                # Argv pre-flight, once per wrapper process. The standalone codex installer
                # auto-updates, and a flag it stops accepting fails at parse with exit 2 before
                # any work -- the launch-failure backoff would then relaunch forever (measured
                # 2026-09-07 with --full-auto, removed in codex-cli 0.147). `--help` makes clap
                # short-circuit before any model call, so the real argv plus --help proves the
                # flags parse for free. A parse error is permanent for this install: escalate
                # once and exit (the exit path deregisters the seat and returns the task to the
                # queue) instead of looping. MOE_DISABLE_ARGV_PROBE=1 skips the probe.
                if (-not $script:CodexArgvProbed -and $env:MOE_DISABLE_ARGV_PROBE -ne '1') {
                    $script:CodexArgvProbed = $true
                    # PS 5.1 turns a native command's redirected stderr into ErrorRecords and,
                    # under $ErrorActionPreference = 'Stop', throws on the first one before the
                    # exit code is observable -- probe under 'Continue' and restore.
                    $probeOut = ''
                    $probeExit = 0
                    $probePrevEap = $ErrorActionPreference
                    $ErrorActionPreference = 'Continue'
                    try {
                        $probeOut = (Invoke-MoeGuardedCommand @CommandArgs @codexSeatArgs @codexExecOverrides exec --json -C "$script:cliRoot" @codexSandboxArgs --help 2>&1 | Out-String)
                        $probeExit = if ($null -ne $LASTEXITCODE) { [int]$LASTEXITCODE } else { 0 }
                    } catch { $probeOut = "$_"; if ($probeExit -eq 0) { $probeExit = 1 } } finally { $ErrorActionPreference = $probePrevEap }
                    if ($probeExit -ne 0 -and $probeOut -match 'unexpected argument|unrecognized subcommand|unexpected value') {
                        $probeLine = @(($probeOut -split "`r?`n") | Where-Object { $_ -match 'error' } | Select-Object -First 1)
                        $probeLine = if ($probeLine.Count -gt 0) { $probeLine[0].Trim() } else { "exit $probeExit" }
                        $codexVersion = 'unknown'
                        $ErrorActionPreference = 'Continue'
                        try { $codexVersion = (Invoke-MoeGuardedCommand --version 2>&1 | Out-String).Trim() } catch {} finally { $ErrorActionPreference = $probePrevEap }
                        Write-Host "[ERROR] MOE_CLI_ARGV_REJECTED: the installed codex ($codexVersion) rejects the wrapper's launch argv -- $probeLine. Rebuild and reinstall the Moe plugin (or pin the codex version); relaunching cannot succeed, so this seat exits instead of looping. MOE_DISABLE_ARGV_PROBE=1 skips this check." -ForegroundColor Red
                        if ($generalChannelId) {
                            $argvMsg = "@governors ${WorkerId}: MOE_CLI_ARGV_REJECTED - the installed codex ($codexVersion) rejects the wrapper's launch argv ($probeLine). Seat exiting and deregistering (the task returns to the queue); rebuild and reinstall the Moe plugin or pin codex before relaunching."
                            try { Invoke-MoeRpc -Tool "chat_send" -Args @{ channel = $generalChannelId; workerId = $WorkerId; content = $argvMsg } | Out-Null } catch {}
                        }
                        Stop-HeartbeatSidecar
                        exit 1
                    }
                }
                Write-Host "Command: $Command $($codexSeatArgs -join ' ') $($codexExecOverrides -join ' ') exec --json -C `"$script:cliRoot`"$codexSandboxBanner `"<prompt>`""
                Start-MoeUsageReceipt 'codex' 'headless'
                & {
                    Invoke-MoeGuardedCommand @CommandArgs @codexSeatArgs @codexExecOverrides exec --json -C "$script:cliRoot" @codexSandboxArgs "$shortPrompt"
                    $script:CliExitCode = $LASTEXITCODE
                } | ForEach-Object -Begin {
                    # PS 5.1 holds a native-to-native pipe until the producer exits, so
                    # feed the helper line by line; its stdout stays the console.
                    $psi = [System.Diagnostics.ProcessStartInfo]::new('node', "`"$promptCacheHelper`" codex-stream")
                    $psi.UseShellExecute = $false
                    $psi.RedirectStandardInput = $true
                    # The helper alone gets the TOOL-witness env (prompt-cache-witness.mjs):
                    # $psi's dictionary reaches that child, never codex or its MCP servers.
                    # No `else` here: the launcher test cuts this block at the first one.
                    $script:CodexToolWritesFile = $null
                    $psi.EnvironmentVariables.Remove('MOE_TOOL_WRITES_FILE')
                    if ($null -ne $moeGit) {
                        $script:CodexToolWritesFile = Join-Path ([IO.Path]::GetTempPath()) ('moe-codex-tool-writes-' + [guid]::NewGuid().ToString('N') + '.txt')
                        $psi.EnvironmentVariables['MOE_TOOL_WRITES_FILE'] = $script:CodexToolWritesFile
                        $psi.EnvironmentVariables['MOE_GIT_TOP'] = $moeGit.Top
                        $psi.EnvironmentVariables['MOE_GIT_REL'] = $moeGit.Rel
                        $psi.EnvironmentVariables['MOE_SERENA_PROJECT_ROOT'] = $serenaProject
                    }
                    $cacheStream = [System.Diagnostics.Process]::Start($psi)
                } -Process {
                    $cacheBytes = [System.Text.Encoding]::UTF8.GetBytes("$_`n")
                    $cacheStream.StandardInput.BaseStream.Write($cacheBytes, 0, $cacheBytes.Length)
                    $cacheStream.StandardInput.BaseStream.Flush()
                } -End {
                    $cacheStream.StandardInput.Close()
                    $cacheStream.WaitForExit()
                    # Merge the helper's TOP-relative witnesses into the TOOL tier, as
                    # Complete-MoeToolWrite does; an unreadable file merges nothing.
                    if ($script:CodexToolWritesFile) {
                        try {
                            $codexWitnessed = @()
                            if (Test-Path -LiteralPath $script:CodexToolWritesFile) {
                                $codexWitnessed = [IO.File]::ReadAllLines($script:CodexToolWritesFile, [Text.Encoding]::UTF8)
                            }
                            foreach ($line in $codexWitnessed) {
                                $p = ConvertTo-MoeNormalPath $line
                                if ($p) { $script:MoeToolWritten[(Get-MoePathKey $p)] = $p }
                            }
                        } catch {
                            Write-Host "  [WARN] codex exec tool witnesses not read: $($_.Exception.Message)" -ForegroundColor Yellow
                        } finally {
                            Remove-Item -LiteralPath $script:CodexToolWritesFile -Force -ErrorAction SilentlyContinue
                        }
                    }
                }
            } else {
                # Interactive TUI mode: codex -c <seat overrides> -C <project> "<prompt>"
                Write-Host "Command: $Command $($codexSeatArgs -join ' ') -C `"$script:cliRoot`" `"<prompt>`""
                Start-MoeUsageReceipt 'codex' 'interactive'
                Invoke-MoeGuardedCommand @CommandArgs @codexSeatArgs -C "$script:cliRoot" "$shortPrompt"
                $script:CliExitCode = $LASTEXITCODE
            }
        } finally {
            Stop-HeartbeatSidecar
            foreach ($cacheFile in @($script:CodexSeatInstructionsFile, $script:CodexSessionContextFile, $script:CodexToolWritesFile)) {
                if ($cacheFile) { Remove-Item -LiteralPath $cacheFile -Force -ErrorAction SilentlyContinue }
            }
        }
    } elseif ($cliType -eq "gemini") {
        if ($Command -eq "gemini") {
            if (Get-Command agy -ErrorAction SilentlyContinue) {
                $Command = "agy"
            }
        }
        $geminiCheck = Get-Command $Command -ErrorAction SilentlyContinue
        if (-not $geminiCheck) {
            Write-Error "Antigravity command not found: $Command. Please ensure Antigravity CLI (agy) is installed."
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
                Write-Host "Command: $Command --print `"<prompt>`" --dangerously-skip-permissions"
                try {
                    Push-Location $script:cliRoot
                    Invoke-MoeGuardedCommand @CommandArgs --print "$shortPrompt" --dangerously-skip-permissions
                    $script:CliExitCode = $LASTEXITCODE
                } finally { Pop-Location }
            } else {
                # Interactive mode
                Write-Host "Command: $Command --prompt-interactive `"<prompt>`""
                try {
                    Push-Location $script:cliRoot
                    Invoke-MoeGuardedCommand @CommandArgs --prompt-interactive "$shortPrompt"
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
        # used here: its claude-opus-5-5 per-role fallback is a claude model and
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

        # The taskless launch decision is taken ONCE for every CLI type
        # before this dispatch ($moeSkipLaunch), so this branch only runs when
        # a CLI really is launching.
        $grokLaunchSkipped = $false

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
                    Write-Host "Command: $Command --cwd `"$script:cliRoot`" $($grokModelArgs -join ' ') `"<prompt>`""
                    try {
                        Push-Location $script:cliRoot
                        Invoke-MoeGuardedCommand @CommandArgs --cwd "$script:cliRoot" @grokModelArgs "$grokPointerPrompt"
                        $script:CliExitCode = $LASTEXITCODE
                    } finally { Pop-Location }
                } else {
                    # Headless: --prompt-file carries the whole prompt, --yolo
                    # auto-approves tool calls (the fleet equivalent of claude's
                    # bypassPermissions), --output-format plain keeps the
                    # transcript greppable. The prompt body is never echoed.
                    Write-Host "Command: $Command --prompt-file `"$($script:GrokPromptFile)`" --yolo --cwd `"$script:cliRoot`" --no-auto-update --output-format plain $($grokModelArgs -join ' ') $($grokEffortArgs -join ' ')"
                    try {
                        Push-Location $script:cliRoot
                        Invoke-MoeGuardedCommand @CommandArgs --prompt-file "$($script:GrokPromptFile)" --yolo --cwd "$script:cliRoot" --no-auto-update --output-format plain @grokModelArgs @grokEffortArgs
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

        # Per-task tier (launch hint) overrides the seat default model unless the
        # operator pinned one (-Model / settings.models.<role>); effort defaults to max.
        $iterModel = $resolvedModel
        if (-not $explicitModel -and $taskLaunchModel) { $iterModel = $taskLaunchModel }
        $iterEffort = if ($taskLaunchEffort) { $taskLaunchEffort } else { 'max' }
        if ($taskLaunchTier) {
            $iterModelLabel = if ($iterModel) { $iterModel } else { 'default' }
            Write-Host "[OK] Task tier: $taskLaunchTier (model $iterModelLabel, effort $iterEffort)" -ForegroundColor Green
        }
        $modelArgs = @()
        if ($iterModel) { $modelArgs = @("--model", $iterModel) }

        # The taskless launch decision is taken ONCE for every CLI type before
        # this dispatch ($moeSkipLaunch), so this branch only runs when a CLI
        # really is launching.
        $launchSkipped = $false
        if (-not $launchSkipped) {
            # Windows CreateProcess caps the total command line at ~32K UTF-16 chars
            # (~8K through cmd.exe). $claimPrompt — claimed_task_context + inbox +
            # routed_mentions + role directive — can blow past that for workers
            # whose tasks carry a fat implementationPlan. Put the whole user prompt
            # in a private context file and pass a short read directive. The stable
            # system prompt must remain identical across tasks, including overflow.
            #
            # The same file route also covers prompts with embedded double quotes,
            # regardless of length. Windows PowerShell 5.1 forwards native-command
            # args WITHOUT escaping internal quotes, so a quote-bearing prompt
            # (routed_mentions JSON, claimed_task_context JSON under the 6000-char
            # threshold) word-splits into hundreds of argv tokens; the first
            # '-'-leading fragment then kills the CLI as an unknown option
            # (observed: `claude.exe : error: unknown option '-1'` on the
            # no-task + routed-mentions launch). File delivery preserves exact text.
            $userPromptForCli = $claimPrompt
            $sessionContextFile = $null
            $WIN_CMD_SAFE_THRESHOLD = 6000
            $isWin = ($env:OS -eq "Windows_NT")
            $promptHasQuote = $claimPrompt -and $claimPrompt.IndexOf('"') -ge 0
            if ($isWin -and $claimPrompt -and ($claimPrompt.Length -gt $WIN_CMD_SAFE_THRESHOLD -or $promptHasQuote)) {
                $sessionContextFile = Join-Path $env:TEMP ("moe-claude-context-" + [guid]::NewGuid().ToString('N') + '.md')
                [System.IO.File]::WriteAllText($sessionContextFile, $claimPrompt, [System.Text.UTF8Encoding]::new($false))
                $userPromptForCli = "First read the private session context file at $sessionContextFile. It contains your daemon-scoped task context, claimed_task_context, routed mentions, and role directive. Treat that role directive as your active user request."
                $overflowReason = if ($claimPrompt.Length -gt $WIN_CMD_SAFE_THRESHOLD) { "length $($claimPrompt.Length) > $WIN_CMD_SAFE_THRESHOLD chars" } else { "embedded double quotes (PS 5.1 argv word-split)" }
                Write-Host "[prompt-overflow] claimPrompt routed via private session context file: $overflowReason." -ForegroundColor Yellow
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
            # An interactive seat prints no stream-json, so its account usage
            # comes from claude's statusline (moe-account-lease.mjs statusline).
            if ($script:AccountLeasedId -and -not $usePrintMode) {
                if ($null -ne (Invoke-MoeAccountHelper -HelperArgs @('statusline-settings', $script:AccountSettingsFile))) {
                    $accountArgs = @('--settings', $script:AccountSettingsFile)
                }
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

            # Cache TTL: the API offers 5m (default) or 1h, nothing longer. A
            # seat that waits on a long tool call (gradle, full vitest,
            # postflight) or on a usage-limit backoff loses the 5m cache and
            # re-reads the whole prefix; 1h keeps it warm. Operator env wins;
            # FORCE_PROMPT_CACHING_5M still overrides both. Claude Code
            # < 2.1.242 ignores the variables.
            # Auto-compact window: native-1M models compact at ~967K by default
            # and a long session re-reads that context on every turn (measured:
            # 700-1300 turns at 500-950K). Per role, since a flat 300K made
            # architects compact every ~116 turns and QA mid-review (fleet
            # audit 2026-10-09): worker 300K (its state lives on the board), qa
            # 500K, architect and governor 600K; compaction fires ~32K under the
            # window. A reload pass inherits this process env, so
            # MOE_COMPACT_WINDOW_DEFAULT marks the value as the wrapper's own and
            # a reload re-derives it; an unmarked value is the operator's and
            # wins, except 300000, the flat default of the wrappers before this
            # one, inherited by the reload that installs it. Older Claude Code
            # ignores the variable.
            # moe-compaction-keeper (scripts/mods/) carries the seat's task
            # state through each compaction; MOE_DISABLE_COMPACTION_KEEPER=1
            # leaves it out.
            # moe-account-switch (scripts/mods/) ends a TUI session once Moe
            # says its Claude account is spent, so this loop relaunches the seat
            # on the next one. Only for an interactive seat whose loop relaunches
            # it (a --print run already ends per task; a -NoLoop seat would end
            # for good); MOE_DISABLE_ACCOUNT_SWITCH_MOD=1 leaves it out. Where
            # this loop also claims for the seat (auto-claim, not a governor) it
            # sets MOE_SESSION_ENDS_WHEN_IDLE, and the mod ends a session whose
            # seat holds no task once a turn is over instead of parking until an
            # operator /exit.
            if (-not $env:CLAUDE_CODE_PROMPT_CACHE_TTL) { $env:CLAUDE_CODE_PROMPT_CACHE_TTL = '1h' }
            if (-not $env:CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL) { $env:CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL = '1h' }
            $moeCompactWindow = switch ($Role) { 'qa' { '500000' } 'architect' { '600000' } 'governor' { '600000' } default { '300000' } }
            $moeOwnCompactWindow = if ($env:MOE_COMPACT_WINDOW_DEFAULT) { $env:MOE_COMPACT_WINDOW_DEFAULT } else { '300000' }
            if (-not $env:CLAUDE_CODE_AUTO_COMPACT_WINDOW -or $env:CLAUDE_CODE_AUTO_COMPACT_WINDOW -eq $moeOwnCompactWindow) {
                $env:CLAUDE_CODE_AUTO_COMPACT_WINDOW = $moeCompactWindow
                $env:MOE_COMPACT_WINDOW_DEFAULT = $moeCompactWindow
            }
            $moeKeeperDir = Join-Path $PSScriptRoot 'mods\moe-compaction-keeper'
            if (-not $env:MOE_DISABLE_COMPACTION_KEEPER -and (Test-Path -LiteralPath $moeKeeperDir -PathType Container)) {
                $moePluginDirs = @("$env:CLAUDE_CODE_PLUGIN_DIRS" -split [regex]::Escape([IO.Path]::PathSeparator) | Where-Object { $_ })
                if ($moePluginDirs -notcontains $moeKeeperDir) {
                    $env:CLAUDE_CODE_PLUGIN_DIRS = (@($moePluginDirs) + $moeKeeperDir) -join [IO.Path]::PathSeparator
                }
            }
            $moeSwitchDir = Join-Path $PSScriptRoot 'mods\moe-account-switch'
            $env:MOE_SESSION_ENDS_WHEN_IDLE = $null
            if ($claudeInteractive -and $loopEnabled -and -not $env:MOE_DISABLE_ACCOUNT_SWITCH_MOD -and (Test-Path -LiteralPath $moeSwitchDir -PathType Container)) {
                $moePluginDirs = @("$env:CLAUDE_CODE_PLUGIN_DIRS" -split [regex]::Escape([IO.Path]::PathSeparator) | Where-Object { $_ })
                if ($moePluginDirs -notcontains $moeSwitchDir) {
                    $env:CLAUDE_CODE_PLUGIN_DIRS = (@($moePluginDirs) + $moeSwitchDir) -join [IO.Path]::PathSeparator
                }
                if ($AutoClaim -and $Role -ne 'governor') { $env:MOE_SESSION_ENDS_WHEN_IDLE = '1' }
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
                                    # Partial deltas are display-only: nested
                                    # agent streams may interleave. Authority
                                    # comes from complete assistant blocks.
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
                        if ($evt.isReplay) { break }
                        # Non-streamed assistant messages carry the full
                        # tool_use.input — queue those too (same IDs/tier).
                        try {
                            if ($evt.message -and $evt.message.content) {
                                foreach ($blk in @($evt.message.content)) {
                                    if ($blk -and $blk.type -eq "tool_use") { Register-MoeToolWrite $blk.id $blk.name $blk.input }
                                }
                            }
                        } catch {}
                    }
                    "user" {
                        if ($evt.isReplay) { break }
                        try {
                            foreach ($blk in @($evt.message.content)) {
                                if ($blk -and $blk.type -eq 'tool_result') { Complete-MoeToolWrite $blk }
                            }
                        } catch {}
                    }
                    "rate_limit_event" {
                        $rl = $evt.rate_limit_info
                        if ($rl) {
                            $resets = if ($rl.resetsAt) { [DateTimeOffset]::FromUnixTimeSeconds($rl.resetsAt).LocalDateTime.ToString('MM-dd HH:mm') } else { "?" }
                            $tag = if ($rl.isUsingOverage) { "OVERAGE" } else { $rl.status }
                            Write-Host "  [rate-limit $tag $($rl.rateLimitType) resets=$resets]" -ForegroundColor Yellow
                            # Usage of the leased account, for moe.report_account_usage (twin:
                            # the stream parser in moe-agent.sh). utilization is a 0-1 fraction
                            # per unifiedWindows entry; status (overage while isUsingOverage)
                            # belongs to the rateLimitType window. Best-effort.
                            if ($script:AccountLeasedId) {
                                try {
                                    if ($rl.unifiedWindows) {
                                        foreach ($p in $rl.unifiedWindows.PSObject.Properties) {
                                            $u = $p.Value.utilization
                                            if ($u -is [double] -or $u -is [int] -or $u -is [long] -or $u -is [decimal]) {
                                                if (-not $script:AccountWindows.Contains($p.Name)) { $script:AccountWindows[$p.Name] = [ordered]@{} }
                                                $script:AccountWindows[$p.Name]['utilization'] = $u
                                                if ($null -ne $p.Value.resetsAt) { $script:AccountWindows[$p.Name]['resetsAt'] = $p.Value.resetsAt }
                                            }
                                        }
                                    }
                                    $status = if ($rl.isUsingOverage) { 'overage' } else { $rl.status }
                                    if ($rl.rateLimitType -is [string] -and $status -is [string]) {
                                        if (-not $script:AccountWindows.Contains($rl.rateLimitType)) { $script:AccountWindows[$rl.rateLimitType] = [ordered]@{} }
                                        $acctWin = $script:AccountWindows[$rl.rateLimitType]
                                        $acctWin['status'] = $status
                                        if (-not $acctWin.Contains('resetsAt') -and $null -ne $rl.resetsAt) { $acctWin['resetsAt'] = $rl.resetsAt }
                                        if (@('rejected', 'overage') -ccontains $status) { $script:AccountSampleRefused = $true }
                                    }
                                    $json = [ordered]@{ accountId = $script:AccountLeasedId; windows = $script:AccountWindows; refused = [bool]$script:AccountSampleRefused } | ConvertTo-Json -Depth 5 -Compress
                                    $tmp = "$($script:AccountSampleFile).tmp"
                                    [IO.File]::WriteAllText($tmp, $json)
                                    Move-Item -LiteralPath $tmp -Destination $script:AccountSampleFile -Force
                                } catch {}
                            }
                        }
                    }
                    "result" {
                        $script:MoeUsageResultSeen = $true
                        $dur = if ($evt.duration_ms) { "$([math]::Round($evt.duration_ms/1000.0,1))s" } else { "?" }
                        $color = if ($evt.is_error) { "Red" } else { "Green" }
                        Write-Host "  [result] turns=$($evt.num_turns) dur=$dur stop=$($evt.stop_reason)" -ForegroundColor $color
                        # Only the result line goes through the helper: piping the
                        # whole stream into node stalls the console on PS 5.1.
                        $line | & node $promptCacheHelper claude-stream | Select-Object -Skip 1 | ForEach-Object { Write-Host $_ }
                    }
                }
            }

            # Usage receipt launch boundary.
            $script:MoeUsageResultSeen = $false
            $usageLaunchMode = if ($usePrintMode) { 'headless' } else { 'interactive' }
            Start-MoeUsageReceipt 'claude' $usageLaunchMode
            Start-HeartbeatSidecar -ProxyScript $proxyScript -ProjectPath $projectPath -WorkerId $WorkerId | Out-Null
            try {
            Set-MoeAccountEnv
            if ($userPromptForCli) {
                Write-Host "Command: $Command $($modelArgs -join ' ') --mcp-config `"$mcpConfigFile`" --append-system-prompt-file `"$systemPromptFile`" $($cacheArgs -join ' ') $($accountArgs -join ' ') --effort $iterEffort $($printArgs -join ' ') `"<prompt>`""
                if ($usePrintMode) {
                    # Stream output through the parser. ForEach-Object processes
                    # lines as they arrive (no buffering), so the user sees
                    # activity in real time.
                    $script:moeToolJson = ""
                    $script:moeToolName = $null
                    $script:moeInText = $false
                    & {
                        Invoke-MoeGuardedCommand @CommandArgs @modelArgs --mcp-config "$mcpConfigFile" --append-system-prompt-file "$systemPromptFile" @cacheArgs @accountArgs --effort $iterEffort @printArgs "$userPromptForCli" 2>&1
                        $script:CliExitCode = $LASTEXITCODE
                    } | ForEach-Object { & $parseStreamJson $_ }
                } else {
                    Invoke-MoeGuardedCommand @CommandArgs @modelArgs --mcp-config "$mcpConfigFile" --append-system-prompt-file "$systemPromptFile" @cacheArgs @accountArgs --effort $iterEffort @printArgs "$userPromptForCli"
                    $script:CliExitCode = $LASTEXITCODE
                }
            } else {
                Write-Host "Command: $Command $($modelArgs -join ' ') --mcp-config `"$mcpConfigFile`" --append-system-prompt-file `"$systemPromptFile`" $($cacheArgs -join ' ') $($accountArgs -join ' ') --effort $iterEffort $($printArgs -join ' ')"
                if ($usePrintMode) {
                    $script:moeToolJson = ""
                    & {
                        Invoke-MoeGuardedCommand @CommandArgs @modelArgs --mcp-config "$mcpConfigFile" --append-system-prompt-file "$systemPromptFile" @cacheArgs @accountArgs --effort $iterEffort @printArgs 2>&1
                        $script:CliExitCode = $LASTEXITCODE
                    } | ForEach-Object { & $parseStreamJson $_ }
                } else {
                    Invoke-MoeGuardedCommand @CommandArgs @modelArgs --mcp-config "$mcpConfigFile" --append-system-prompt-file "$systemPromptFile" @cacheArgs @accountArgs --effort $iterEffort @printArgs
                    $script:CliExitCode = $LASTEXITCODE
                }
            }
            } finally {
                Restore-MoeAccountEnv
                if ($usePrintMode -and -not $script:MoeUsageResultSeen -and $env:MOE_USAGE_RECEIPT_FILE) {
                    try { '' | & node $promptCacheHelper claude-stream | Out-Null }
                    catch { Write-Warning 'MOE_USAGE_REPORT_UNAVAILABLE' }
                }
                Stop-HeartbeatSidecar
                if ($sessionContextFile) { Remove-Item -LiteralPath $sessionContextFile -Force -ErrorAction SilentlyContinue }
            }
        }
    }

    Remove-MoeAgentGitGuard

    # Launch-failure classification (tracker declared above the main loop).
    $cliElapsedSec = if ($script:CliLaunchedAt) { [int]((Get-Date) - $script:CliLaunchedAt).TotalSeconds } else { -1 }
    $cliExitForLaunch = if ($null -ne $script:CliExitCode) { [int]$script:CliExitCode } else { 0 }
    # Claude account rotation, after a leased run: report its last usage sample,
    # then ask whether the run failed because of its account. A refusal needs
    # both signals (the CLI said the account is spent, and the run failed); any
    # other failure checks the account's sign-in. Once the daemon has answered,
    # the account is parked, so the relaunch is immediate and lands on the next
    # one. An unanswered report, or the account the previous account relaunch
    # moved away from failing again (a daemon that hands it back would
    # otherwise relaunch with no backoff forever), falls through to the
    # launch-failure classes below.
    if ($script:AccountLeasedId) {
        $moeAccountReported = Send-MoeAccountSample
        if ($cliExitForLaunch -eq 0) {
            $script:AccountLastFailed = ''
        } elseif ($script:AccountLeasedId -cne $script:AccountLastFailed) {
            if ($script:AccountSampleRefused -and $moeAccountReported) {
                Write-Host "[account] MOE_ACCOUNT_REFUSED account=$($script:AccountLeasedId) exit=$cliExitForLaunch - relaunching on the next account; the held task stays held." -ForegroundColor Yellow
                $script:AccountRelaunch = $true
            } else {
                $moeProbeWords = @($Command) + @($CommandArgs | Where-Object { $null -ne $_ })
                # A protected CLI probes extensionless, so the helper resolves PATHEXT in the
                # trusted dir only: a .ps1 handed to cmd would open by its file association.
                if ($script:MoeProtectedCli) { $moeProbeWords = @([IO.Path]::Combine([IO.Path]::GetDirectoryName($Command), [IO.Path]::GetFileNameWithoutExtension($Command))) }
                $moeSignIn = Invoke-MoeAccountHelper -HelperArgs (@('signin-state', $script:AccountLeasedDir) + $moeProbeWords)
                if (($moeSignIn -ceq 'signed_out' -or $moeSignIn -ceq 'other') -and
                    $null -ne (Invoke-MoeRpc -Tool 'report_account_usage' -Args @{ workerId = $WorkerId; accountId = $script:AccountLeasedId; signIn = $moeSignIn })) {
                    Write-Host "[account] MOE_ACCOUNT_SIGNED_OUT account=$($script:AccountLeasedId) state=$moeSignIn - relaunching on the next account; the held task stays held." -ForegroundColor Yellow
                    $script:AccountRelaunch = $true
                }
            }
        }
    }
    if ($moeSkipLaunch) {
        # No CLI ran (MOE_TASKLESS_NO_LAUNCH above set CliExitCode=0): neither
        # a launch that ran nor a launch failure. Read as a success it zeroed the
        # streak and its backoff, and after three failures it posted a false
        # "CLI launches again" line. The streak, its backoff and the launch
        # outage state stay as they were.
    } elseif ($script:AccountRelaunch) {
        # The account ran out or signed out, not the session: give the resume
        # attempt back and skip the launch-failure backoff. A fast exit is still
        # a launch that did no work, which is what the landing reads the flag for.
        $script:AccountLastFailed = $script:AccountLeasedId
        if ($cliElapsedSec -ge 0 -and $cliElapsedSec -lt $launchFailSec) { $moeCurrentLaunchFailed = $true }
        if ($script:ResumeAttempts -gt 0) { $script:ResumeAttempts-- }
        $script:LaunchFailStreak = 0
        $script:LaunchFailBackoffSec = 0
    } elseif ($cliExitForLaunch -ne 0 -and $cliElapsedSec -ge 0 -and $cliElapsedSec -lt $launchFailSec) {
        $moeCurrentLaunchFailed = $true
        $script:LaunchFailStreak++
        # Not a mid-task death: give the resume attempt back.
        if ($script:ResumeAttempts -gt 0) { $script:ResumeAttempts-- }
        $launchBackoffPow = [math]::Min($script:LaunchFailStreak - 1, 10)
        $script:LaunchFailBackoffSec = [int][math]::Min($launchBackoffMaxSec, $launchBackoffBaseSec * [math]::Pow(2, $launchBackoffPow))
        Write-Host "[launch-failure] CLI exited $cliExitForLaunch after ${cliElapsedSec}s, before doing any work (streak $($script:LaunchFailStreak)): provider usage limit, credential, a crash at launch, or an argv the installed CLI version rejects (exit 2 from codex; run the printed Command by hand). Not counted against the resume budget; next relaunch in $($script:LaunchFailBackoffSec)s." -ForegroundColor Yellow
        if ($script:LaunchFailStreak -eq 3) {
            $script:LaunchFailHead = "@governors ${WorkerId}: CLI exits within ${launchFailSec}s of launch (exit $cliExitForLaunch, $($script:LaunchFailStreak) in a row) - provider usage limit, credential problem, or an argv the installed CLI rejects (exit 2: a CLI auto-update dropped a flag the wrapper passes), not a task problem."
            if ($AutoClaim -and $Role -ne 'governor') {
                # Launch outage mode (declared above the loop). The release and
                # its @governors line wait for this iteration's post-flight
                # (Invoke-MoeLaunchOutagePostflight), so the landing and finalize
                # see the task as it was.
                if (-not $script:LaunchOutage) {
                    $script:LaunchOutage = $true
                    $script:LaunchOutageAnnounce = $true
                    $script:LaunchOutageReleaseTried = ''
                    $script:LaunchOutageHeldTaskId = if ($preflightTaskId) { [string]$preflightTaskId } else { [string]$preflightHeldTaskId }
                    Write-Host "[launch-outage] $($script:LaunchFailStreak) launch failures in a row: entering launch outage mode. After this post-flight the held task is released for another seat, and this seat claims no new task until a launch probe succeeds." -ForegroundColor Yellow
                }
            } elseif ($generalChannelId) {
                $launchFailMsg = "$($script:LaunchFailHead) Wrapper is backing off up to ${launchBackoffMaxSec}s between relaunches and keeps its task; no release needed."
                try { Invoke-MoeRpc -Tool "chat_send" -Args @{ channel = $generalChannelId; workerId = $WorkerId; content = $launchFailMsg } | Out-Null } catch {}
            }
        }
    } else {
        if (($script:LaunchFailStreak -ge 3 -or $script:LaunchOutage) -and $generalChannelId) {
            $launchOkMsg = "${WorkerId}: CLI launches again (ran ${cliElapsedSec}s, exit $cliExitForLaunch) after $($script:LaunchFailStreak) launch failures."
            if ($script:LaunchOutage) { $launchOkMsg += ' Launch outage over: claiming resumes.' }
            try { Invoke-MoeRpc -Tool "chat_send" -Args @{ channel = $generalChannelId; workerId = $WorkerId; content = $launchOkMsg } | Out-Null } catch {}
        }
        if ($script:LaunchOutage) {
            Write-Host "[launch-outage] The CLI launches again (ran ${cliElapsedSec}s, exit $cliExitForLaunch): launch outage over, claiming resumes." -ForegroundColor Green
        }
        $script:LaunchFailStreak = 0
        $script:LaunchFailBackoffSec = 0
        $script:LaunchOutage = $false
        $script:LaunchOutageHeldTaskId = ''
        $script:LaunchOutageReleaseTried = ''
        $script:LaunchOutageAnnounce = $false
    }

    if ($script:cliRootPushed) { Pop-Location; $script:cliRootPushed = $false }
    # -------- Post-flight: shutdown rituals after CLI exits --------
    # Status resolution first; the landing + session-ended chat line follow.
    $script:MoeLastLanding = $null
    $moeStopLoop = $false
    # A restart inside the session the sidecar did not catch in time: reattach
    # before the landing reads the attempt, or its evidence would fail closed.
    if ($AutoClaim -and $preflightTaskId) { Invoke-MoeReattachOwnAttempts }

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
            $ctxResp = Invoke-MoeRpcUnserved -Tool "get_context" -Args @{ taskId = $preflightTaskId }
            $matched = if ($ctxResp) { $ctxResp.task } else { $null }
            if (-not $matched -or -not $matched.id) {
                $statusLookupError = "get_context returned no task"
            } elseif ([string]$matched.id -ne $preflightTaskId) {
                # Daemons before the explicit-taskId NOT_FOUND fix fell back to
                # the CALLER's currentTaskId when the requested id resolved to
                # nothing (deleted/archived/wrong project), and moe-proxy injects
                # MOE_WORKER_ID on every call — so a stale id came back as some
                # OTHER task's status. Committing on that would be worse than not
                # committing at all. Current daemons refuse (the no-task branch
                # above); the check stays for launcher/daemon version skew.
                $statusLookupError = "get_context resolved a different task ($($matched.id)) — the requested id no longer exists"
            } else {
                $finalStatus = $matched.status
                if ($matched.PSObject.Properties['reopenCount'] -and $matched.reopenCount) {
                    $finalReopenCount = [int]$matched.reopenCount
                }
                Update-ResumeBudgetOnProgress -Context $ctxResp -TaskId $preflightTaskId
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
        # Worktree mode (design §3) never reaches the shared landing below.
        $moeWtExit = ''
        if ($script:MoeWtMode -eq 'worktree') { $moeWtExit = 'worktree' }
        elseif (($Role -eq 'architect' -or $Role -eq 'qa') -and (Test-MoeControlWorktreeMode)) { $moeWtExit = 'control' }
        if ($moeWtExit) {
            if (-not $moeSid) { $moeSid = "$WorkerId@" + (Get-Date).ToUniversalTime().ToString("yyyy-MM-dd'T'HH:mm:ss'Z'") }
            $moeExitForCommit = if ($null -ne $script:CliExitCode) { [int]$script:CliExitCode } else { 0 }
            $moeWtStatus = if ($statusLookupError -or -not $finalStatus) { 'UNKNOWN' } else { [string]$finalStatus }
            if ($moeWtExit -eq 'worktree') {
                $moeLanding = Invoke-MoeWorktreePostflight $moeSettings $moeWtStatus ([int]$finalReopenCount) $moeExitForCommit $moeSid
            } else {
                $moeLanding = Invoke-MoeControlSeatPostflight $moeWtStatus $moeExitForCommit $moeSid
            }
            $script:MoeLastLanding = $moeLanding
            if ($moeLanding -and $moeLanding.StopLoop) { $moeStopLoop = $true }
        } elseif (-not $moeSettings.autoCommit) {
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
            # turned off. The bytes it leaves dirty on purpose are still this
            # task's: they travel as C rows so its next session does not read
            # them as foreign (MOE_ATTR_ASSERTED_FOREIGN). Twin: the same branch
            # in moe-agent.sh.
            if ($null -eq $moeGit) { $moeGit = Get-MoeGitTop }
            if ($moeGit) {
                $markOwn = $null
                $markS = Get-MoeDirtySnapshot $moeGit.Top
                if ($null -ne $markS) { $markOwn = @(Get-MoeOwnPaths $markS $script:MoeToolWritten $script:MoePreflightEvidence $moeGit.Rel $moeSettings) }
                Set-MoeBaselineLanded $moeGit.GitDir $preflightTaskId $moeSid $markOwn
            }
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
                    -Sid $moeSid -RunGate $true -IsEpicFinal $isEpicFinal -LaunchFailed $moeCurrentLaunchFailed
                $script:MoeLastLanding = $moeLanding
                if ($moeLanding.StopLoop) { $moeStopLoop = $true }
            }
        }
        # Whatever happened above, this session's bytes have been handled
        # (committed, parked on a rescue ref, refused, or nothing to land): the
        # teardown rescue in the outer finally must not run a second pass.
        if (-not (Complete-MoePostflight)) { $moeStopLoop=$true }
        $moeLandingDone = $true
        # ...and this session no longer holds the task's bytes, so drop the
        # claim beside the baseline prune. On a rescue/refusal the baseline is
        # deliberately KEPT for the next pre-flight to recover — which only
        # works if the marker is gone. Same as the sh twin.
        if ($moeGit) { Remove-MoeLiveMarker $moeGit.GitDir $preflightTaskId }
    } elseif ($AutoClaim -and -not $moeSkipLaunch) {
        # -------- Adoption boundary (the alarm, not the fix) --------
        # This session launched WITHOUT a task baseline. It may still retain
        # a BLOCKED hold seen at preflight; that is NOT a newly adopted task.
        # Neither binding nor shared dirt proves this session edited anything.
        # Keep the loud attribution refusal, but report only observed facts.
        # Never fabricate a baseline or invite a human to discard peer work.
        # get_context with only a
        # workerId resolves the caller's held task and has no side effects;
        # claim_next_task would CLAIM one, so it must never be used here.
        $adoptedTaskId = ""
        try {
            $adoptResp = Invoke-MoeRpcUnserved -Tool "get_context" -Args @{ workerId = $WorkerId }
            if ($adoptResp -and $adoptResp.task -and $adoptResp.task.PSObject.Properties['id'] -and $adoptResp.task.id) {
                $adoptedTaskId = [string]$adoptResp.task.id
            }
        } catch { $adoptedTaskId = "" }
        if ($adoptedTaskId) {
            $adoptedBinding = if ($adoptedTaskId -eq $preflightHeldTaskId) { "retained" } else { "unverified" }
            if ($null -eq $moeGit) { $moeGit = Get-MoeGitTop }
            $adoptedDirty = @()
            if ($moeGit) {
                try {
                    $adoptedStatus = & git -C $moeGit.Top status --porcelain=v1 -z --untracked-files=all --no-renames 2>$null
                    $adoptedDirty = @(($adoptedStatus -join "") -split "`0" | Where-Object { $_ -and $_.Length -gt 3 })
                } catch { $adoptedDirty = @() }
            }
            if ($adoptedDirty.Count -eq 0) {
                Write-Host "[adoption] Task $adoptedTaskId binding=$adoptedBinding has no session baseline, but the tree is clean - nothing to land." -ForegroundColor Cyan
            } else {
                # No baseline means no safe attribution, and the task rails
                # forbid inventing one or staging the tree. Say what that costs.
                Write-Host "MOE_COMMIT_REFUSED_ADOPTED_NO_BASELINE task=$adoptedTaskId worker=$WorkerId binding=$adoptedBinding dirty=$($adoptedDirty.Count) - no session baseline exists; refusing to guess attribution or land. Shared dirty paths do not establish this session's ownership. Preserve them and identify their owners before any delivery action." -ForegroundColor Red
                # A retained hold is the seat's own BLOCKED task, seen at
                # pre-flight: a notification-only relaunch onto it edits nothing
                # and finds only foreign shared dirt, so paging #governors on
                # every relaunch says nothing new (7 pages in one hour on
                # 2026-09-30, all binding=retained, all the same paths). The
                # local line above still names it; only an UNVERIFIED binding
                # -- a task this seat did not hold at pre-flight -- pages.
                if ($generalChannelId -and $adoptedBinding -ne "retained") {
                    $adoptMsg = "@governors ${WorkerId}: MOE_COMMIT_REFUSED_ADOPTED_NO_BASELINE task=$adoptedTaskId binding=$adoptedBinding - no session baseline; refusing to land $($adoptedDirty.Count) unattributed shared dirty path(s). Shared dirty paths do not establish this session's ownership. Preserve them and identify their owners."
                    try { Invoke-MoeRpc -Tool "chat_send" -Args @{ channel = $generalChannelId; workerId = $WorkerId; content = $adoptMsg } | Out-Null } catch {}
                }
            }
        }
        # -------- End adoption boundary --------
    }
    # Session-ended chat line carries the landing summary, so it runs AFTER
    # the landing; the loop `break` for gate/peel failures happens after it.
    Invoke-PostFlight
    if ($moeStopLoop) { break }
    # Launch outage: the release and the outage line, now that this iteration's
    # post-flight is done (a stopping seat above deregisters on exit instead).
    if ($script:LaunchOutage) { Invoke-MoeLaunchOutagePostflight }
    # -------- End post-flight --------
    # A launch failure never started a session, so even a single-shot seat
    # (codex/gemini/grok TUI) relaunches after the backoff it just announced,
    # unless the caller asked for one run with -NoLoop. A launch probe never
    # started one either: once it launches, the seat goes on to claim the
    # session it is for. An account relaunch (the account ran out or signed
    # out) never finished its session either, so it relaunches too, at once,
    # even under -NoLoop.
} while ($loopEnabled -or (($moeCurrentLaunchFailed -or $moeLaunchProbe) -and -not $NoLoop) -or $script:AccountRelaunch)
} finally {
    # Teardown rescue FIRST (before the deregister releases the task): when
    # this session ends without its post-flight having landed (Ctrl+C during
    # the CLI, a terminating error, exit 1 after the claim), park the task's
    # attributable edits on refs/moe/rescue/<taskId>/<ts>. Best-effort,
    # idempotent, single snapshot, no CAS loop, no push. The baseline stays so
    # the next session's pre-flight lands the work on the branch. This finally
    # is SKIPPED on console-window close / SIGKILL (nothing runs; the
    # persisted baseline is the recovery there).
    try { if ($script:cliRootPushed) { Pop-Location; $script:cliRootPushed = $false } } catch {}
    try { Remove-MoeAgentGitGuard } catch {}
    try { Stop-MoeGateChild } catch {}
    try { Invoke-MoeTeardownRescue } catch {}
    try { Complete-MoePostflight | Out-Null } catch {}
    try { Remove-MoeGateWorkspace | Out-Null } catch {}
    # Drop this session's live-session marker. Measured on Windows PowerShell
    # 5.1 (see the CancelKeyPress note at the top), THIS finally is what
    # actually runs on Ctrl+C, on a terminating error and on an `exit 1` after
    # the claim — the console event handlers are inert — so it is the union of
    # every abnormal exit path the process still observes. Leaving a marker
    # behind would suppress the next seat's legitimate crash recovery until a
    # human deleted the file. (A console-window close / SIGKILL runs nothing;
    # there the marker's own process probe is what reports it dead.)
    try { if ($moeGit) { Remove-MoeLiveMarker $moeGit.GitDir $preflightTaskId } } catch {}
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
    foreach ($moeAccountFile in @($script:AccountSampleFile, $script:AccountSettingsFile)) {
        if ($moeAccountFile) { Remove-Item -LiteralPath $moeAccountFile -Force -ErrorAction SilentlyContinue }
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

# ---- Self-restart hand-over (see the restart check inside the loop) ---------
# Runs only after the finally above has released this session's temp files,
# gate workspace, live marker and seat, so the next pass starts from a clean
# slate. The supervisor at the top of this file runs that pass IN THIS PROCESS
# AND CONSOLE: one process and one console per seat however many reloads, the
# operator's terminal still shows the seat, Ctrl+C still reaches it, and nobody
# mistakes a hand-over for a dead seat and launches a second loop on the same
# worker id. The runner identity (<pid>@<start token>) belongs to the process,
# so it survives the reload and a held attempt can still reattach afterwards.
if ($script:MoeWrapperRelaunchRequested) { $global:MoeWrapperReload = $true }
# A one-shot run that ends teamless says so in its exit code instead of
# looking like an idle seat; a looping seat keeps re-joining each pre-flight.
if (-not $loopEnabled -and $moeSkipLaunch -and (Test-MoeSeatTeamless)) {
    Write-Host "MOE_SEAT_UNREGISTERED worker=$WorkerId team=$Team - this one-shot run ends without a team (moe.join_team: $teamJoinLastError); exit 1."
    exit 1
}
# Explicit, so the supervisor never reads a stale native exit code.
exit 0
