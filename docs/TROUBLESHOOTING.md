# Troubleshooting Guide

Common issues and solutions for Moe's Tavern.

---

## Table of Contents

1. [Daemon Issues](#daemon-issues)
2. [Plugin Issues](#plugin-issues). The protected execution profile has its own entries:
   - [Protected profile: daemon was not started by this IDE](#protected-profile-daemon-was-not-started-by-this-ide)
   - [Protected profile: project stays protected after a legacy declaration](#protected-profile-project-stays-protected-after-a-legacy-declaration)
   - [Restart Daemon refuses or starts nothing](#restart-daemon-refuses-or-starts-nothing)
   - [Protected profile: path is not a plain local Windows path](#protected-profile-path-is-not-a-plain-local-windows-path)
   - [Protected profile in VS Code](#protected-profile-in-vs-code)
   - Wrapper refusal codes (`MOE_RUNTIME_PROTECTED_PATH_MISSING`, `MOE_PROTECTED_*`) are in the [Local Runner Issues](#local-runner-issues) table.
3. [MCP/Proxy Issues](#mcpproxy-issues)
4. [Task Sync Issues](#task-sync-issues)
5. [Claude Account Rotation Issues](#claude-account-rotation-issues)
6. [Local Runner Issues](#local-runner-issues)
7. [Performance Issues](#performance-issues)
8. [Worktree Mode](#worktree-mode)
9. [Diagnostic Commands](#diagnostic-commands)

---

## Daemon Issues

### Daemon won't start

**Symptom:** `moe-daemon start` fails or exits immediately.

**Possible causes and solutions:**

#### Port already in use

```bash
# Check if port 9876 is in use
# Windows
netstat -ano | findstr :9876

# Mac/Linux
lsof -i :9876
```

**Solution:** Kill the existing process or use a different port:
```bash
node dist/index.js start --project /path --port 3142
```

#### Permission denied

**Symptom:** `EACCES` error when starting daemon.

**Solution:** Ensure you have write permissions to the project's `.moe/` directory:
```bash
# Check permissions
ls -la .moe/

# Fix permissions (Mac/Linux)
chmod -R 755 .moe/
```

#### Wrong Node.js version

**Symptom:** Syntax errors or missing features.

**Solution:** Use Node.js 22.22+, 24 LTS (recommended), or 26. Node.js 18/20 and
Node.js 22.12–22.21 cannot run the current daemon dependencies:
```bash
node --version  # Use v22.22+ on the 22.x line, v24.x (recommended), or v26.x
```

#### daemon.json is stale

**Symptom:** Daemon reports "already running" but isn't.

**Solution:** Remove stale lock file:
```bash
rm .moe/daemon.json
```

---

### Daemon crashes on startup

**Symptom:** Daemon starts but immediately crashes.

**Possible causes:**

#### Corrupted .moe/ files

**Solution:** Validate JSON files:
```bash
# Check for JSON syntax errors
node -e "require('./.moe/project.json')"
```

#### Missing project.json

**Solution:** Initialize the project:
```bash
# From JetBrains plugin: Tools > Moe > Initialize Project
# Or manually create .moe/project.json
```

### `submit_plan` refusal ends with `spawn git ENOENT` (Windows, JetBrains)

**Symptom:** On Windows, `moe.submit_plan` refuses an affected path that is missing from a stale checkout,
and the refusal ends with ``The cached-origin fallback also failed: `git rev-parse --show-toplevel: ENOENT:
spawn git ENOENT` ``, although `git` runs fine in a terminal. Handoff notes also lose their disk-state
fingerprint, because `util/diskState.ts` reads the same failure as "unknown".

**Cause:** Plugin builds before 2026-10-29 started the daemon with a PATH holding only Node's directory.
Windows names the variable `Path`, and `ProcessBuilder.environment()` keys stay case-sensitive there, so
the plugin read no `PATH` and added a second `PATH` key beside `Path`. Node keeps the lexicographically
first spelling, so every `git` the daemon spawned failed to resolve.

**Fix:** rebuild and reinstall the plugin (`.\scripts\install-all.ps1 -BuildPlugin -InstallPlugin
-IdeVersion <IDE folder>`), then restart the IDE. A running daemon keeps the environment it started with,
and the plugin reuses any daemon whose `.moe/daemon.json` pid and port are still live. That pid is the
`_run` child, which can outlive the IDE, so after closing the IDE confirm that no
`node.exe … moe-jetbrains\daemon\index.js` process is left before reopening the project.

### `moe-daemon stop` sends no signal: `bindHost not local`

**Symptom:** `moe-daemon stop` exits 1 with "daemon.json names a bindHost that is not an address of this
machine, so its pid cannot be verified here: no signal sent and nothing removed. Check what that process is
and stop it yourself if it is a Moe daemon". `moe-daemon status` shows `stopped` with reason
`bindHost not local`. In JetBrains, **Stop and Replace** starts nothing, or **Restart Daemon** reports "the
stop request failed".

**Cause:** `.moe/daemon.json` is repository content, and the CLI probes its `bindHost` for `/health` before
it signals the recorded pid. It dials that `bindHost` only when the address it resolves to is loopback or
held by one of this machine's network interfaces, because a `/health` answer from another host could name
any pid. A zoned IPv6 literal such as `fe80::a%eth1` never counts: its zone picks the link that is dialed,
which can reach a peer even when another interface holds that address. A pull, a hand edit, or a DNS
change for a daemon started with `--host <name>` can point it elsewhere.

**Solution:** Check what the pid is (`ps -p <pid> -o pid,lstart,args`, or Task Manager's Details tab). If it
is this project's Moe daemon, stop it yourself. Otherwise leave that process alone and remove
`.moe/daemon.json` as in [daemon.json is stale](#daemonjson-is-stale). Then start the daemon again (in
JetBrains, **Restart Daemon**). A `--host` value should name this machine, with no `%zone`.

---

## Plugin Issues

### Plugin can't connect to daemon

**Symptom:** "Disconnected" status in plugin, red indicator.

**Possible causes and solutions:**

#### Daemon not running

**Solution:** Start the daemon:
```bash
node packages/moe-daemon/dist/index.js start --project /your/project
```
`moe-daemon init --project /your/project` also starts the daemon.

#### Wrong port

**Solution:** Check daemon.json for actual port:
```bash
cat .moe/daemon.json
# Shows: { "port": 3141, ... }
```

#### Firewall blocking localhost

**Solution:** Ensure localhost connections are allowed. On Windows, check Windows Defender Firewall.

#### Plugin looking at wrong project

**Solution:** Ensure the IDE project root contains `.moe/` folder.

---

### WSL agents cannot reach the Windows daemon

**Solution:** Start the Windows daemon with `--host wsl` (or `MOE_BIND_HOST=wsl`). This binds loopback plus the IPv4 addresses of its WSL adapters, not every interface. In NAT mode agents reach it through the WSL gateway, which is the Windows adapter address; mirrored networking uses loopback. Without a WSL adapter, only loopback is bound.

- Allow the daemon's `node.exe` through Windows Firewall for the WSL adapter/subnet; do not open it to the whole LAN.
- Restart the daemon after WSL restarts: the adapter address can change, and listeners are resolved only at daemon startup.
- If automatic host discovery fails, set `MOE_DAEMON_HOST` in the WSL agent environment to the reachable Windows host address (gateway in NAT mode, `127.0.0.1` in mirrored mode). This overrides the client's destination, not the daemon's bind addresses.

---

### WebSocket upgrade refused with HTTP 403

**Symptom:** A client's WebSocket handshake to `/ws`, `/mcp` or `/runner` gets `HTTP/1.1 403 Forbidden`. The daemon log shows a warning: `Refused WebSocket upgrade: Origin not allowed`, with the remote address, the path and a truncated origin.

**Cause:** The client sent an `Origin` (or `Sec-WebSocket-Origin`) header. Browser-hosted clients always send one, and some custom clients do too. The daemon refuses every such upgrade before any message is processed (see `docs/CONFIGURATION.md`, **WebSocket Origin rule**). The bundled clients never send it: the IDE plugins, moe-proxy, the Claude plugin hook and the local runner.

**Solution:** Connect from a non-browser client that sends no `Origin` header. Browser clients are not supported, and there is no setting that allows an origin.

---

### Plugin shows stale data

**Symptom:** Tasks don't update after changes.

**Solution:**
1. Click "Refresh" in the Moe tool window
2. Restart the plugin connection (disconnect/reconnect)
3. Check daemon logs for WebSocket errors

---

### Plugin UI is blank

**Symptom:** Moe tool window shows nothing.

**Possible causes:**

#### Project not initialized

**Solution:** Initialize via Tools > Moe > Initialize Project

#### Plugin not loaded

**Solution:**
1. Check IDE logs: Help > Show Log in Explorer/Finder
2. Search for "Moe" errors
3. Try reinstalling the plugin

---

### Protected profile: daemon was not started by this IDE

**Symptom (JetBrains):** The plugin stays disconnected and shows "Protected execution profile: the running Moe daemon (pid N) was not started by this IDE from the installed Moe runtime. Stop it, then use Restart Daemon." Or it asks first, in the **Moe: Unverified Daemon** dialog.

**Cause:** The project declares `executionProfile` `verified-local`, so the plugin runs it under the protected profile. Under that profile it attaches only to a daemon that it started itself from the installed plugin runtime and recorded by pid and start time. The record comes from this IDE session or, after an IDE restart, from the IDE's protected state store (see `docs/CONFIGURATION.md`, **File Structure**), and it must name the daemon installed now. Any other daemon is refused: one started from a terminal, by an agent wrapper, by VS Code, by another IDE product or by an earlier plugin install, and also any daemon whose store record cannot be read. The reasons are in the [protected-profile threat model](design/protected-profile-threat-model.md), which assumes a single-user host.

**Solution:**
- After an IDE restart, the daemon this IDE started before is recognized, and there is nothing to do.
- Otherwise the plugin asks when it connects. **Keep It** (the default) leaves that daemon running and the plugin disconnected, because VS Code or a terminal agent may be using it. **Stop and Replace** runs the installed CLI's `stop`, waits up to 15 s until the process, its parent and `.moe/daemon.json` have cleared, and then starts the installed daemon. If the stop fails or a process outlives the wait, nothing new starts until those captured processes have exited. This `stop` signals nothing when daemon.json's `bindHost` is not an address of this machine (see [`moe-daemon stop` sends no signal](#moe-daemon-stop-sends-no-signal-bindhost-not-local)).
- When no dialog appears, stop that process yourself, then use **Restart Daemon**. Restart Daemon never signals a daemon it cannot verify (see [Restart Daemon refuses or starts nothing](#restart-daemon-refuses-or-starts-nothing)).

---

### Protected profile: project stays protected after a legacy declaration

**Symptom (JetBrains):** `.moe/project.json` no longer declares `verified-local`, yet the plugin keeps the protected profile and asks once per IDE session, in **Moe: Execution Profile Downgrade**: "<project> now declares the legacy execution profile, but it was confirmed protected. Moe keeps it protected until you allow the downgrade. An allowed downgrade takes effect after you restart the IDE."

**Cause:** The plugin pinned the project as protected when it read `verified-local`. A repository change (a pull or a branch switch) must never turn the profile off silently.

**Solution:**
- If the downgrade is intended, choose **Allow Downgrade**, then restart the IDE. **Keep Protected** (the default) changes nothing, and the question comes back next session. If the plugin reads `verified-local` again before the restart, the allowed downgrade is withdrawn, and the question comes back next session once the project declares legacy again.
- The question also comes back after every restart when the IDE cannot write its store: a store that is not owner-only, or a project or store root it cannot place (a share, a mapped or subst drive it cannot resolve, or a device path). There an allowed downgrade lasts one session.
- A pin record the IDE would not have written (edited, a link, not owner-only, over 64 KiB, or for another project) also reads as protected. As a last resort a human may delete that one record: the `<sha-256>.json` file in the store whose `"project"` field names this project and which has a `"profile"` field. Never edit it.

---

### Restart Daemon refuses or starts nothing

**Symptom (JetBrains):** **Restart Daemon** leaves the plugin disconnected with one of these:
- "Restart Daemon is already stopping the old Moe daemon. Wait for it to finish." (Windows)
- "Restart Daemon did not start a new Moe daemon: pid N is still running after the stop, and it could restart the old one. Check what that process is and stop it yourself, then use Restart Daemon." (Windows)
- "Restart Daemon did not start a new Moe daemon: it could not confirm that the old one stopped. Use Restart Daemon again." (Windows)
- "Protected execution profile: Restart Daemon did not stop pid N, which .moe/daemon.json names: this IDE did not start it from the installed Moe runtime." (or "the stop request failed"), followed by "Check what that process is and stop it yourself if it is a Moe daemon, then use Restart Daemon."
- "Restart Daemon did not stop pid N, which .moe/daemon.json names on the other side of the Windows/WSL boundary: …"

**Cause:** On Windows, ending a process is `TerminateProcess`, which the old supervisor takes for a crash of its `_run` child and restarts. So Restart Daemon first runs the installed CLI's `stop`. It then ends the old process tree within one 15 s wait, the roots before their children: the supervisor this IDE spawned and, under the protected profile, the daemon's verified parent. It starts nothing while one of those processes still runs, or while an earlier attempt left a tree unresolved, and the plugin's automatic start waits too. On any host the protected profile never signals a `.moe/daemon.json` pid it cannot verify. A pid that is absent, dead or 0 is never signalled, so a stale `.moe/daemon.json` alone does not block a restart. The IDE cannot see processes on the other side of the WSL boundary. The installed `stop` signals nothing when daemon.json's `bindHost` is not an address of this machine (see [`moe-daemon stop` sends no signal](#moe-daemon-stop-sends-no-signal-bindhost-not-local)).

**Solution:** Wait for a running stop to finish. Otherwise look up the pid (Task Manager's Details tab, or `tasklist /fi "PID eq N"`), end it if it is a Moe `node` process, then use Restart Daemon again. For the WSL case, stop the process on that side.

---

### Protected profile: path is not a plain local Windows path

**Symptom:** Under the protected profile on Windows nothing starts, and the IDE shows "Protected execution profile: the project directory is not a plain local Windows path. Project and PATH copies of the Moe daemon are not used." An agent launch gives the same reason and ends "Agents only use the wrapper, daemon and proxy installed with the Moe plugin." (in VS Code, "…with the Moe extension."). Other forms name `installed daemon/index.js` or `node executable` instead of the project directory.

**Cause:** The protected profile accepts only paths it can prove are outside the project: drive-qualified (`X:\`, optionally behind `\\?\`), on a drive that maps to a local volume, with no segment ending in `.` or a space. It refuses a share (`\\localhost\C$` included), `\\wsl$` and `\\wsl.localhost`, a device or volume path, a mapped network drive and a subst drive it cannot resolve. JetBrains also refuses an unknown device family (VeraCrypt, ImDisk, WinFsp). PATH entries of these kinds are skipped, so a node reachable only through one is not found. `docs/ARCHITECTURE.md` (**Security Notes**) lists these accepted costs.

**Solution:** Clone the project to a local drive that is not mapped, and install the IDE plugin and node on a local drive. For a WSL project, run the IDE inside the distro. Otherwise stay on the legacy profile.

---

### Protected profile in VS Code

**Symptom:** Under the protected profile, VS Code shows "Protected execution profile: <reason>. Project and PATH copies of the Moe daemon are not used." when it would start the daemon. When it would launch an agent, it shows "Protected execution profile: <reason>. Agents only use the wrapper, daemon and proxy installed with the Moe extension." and opens no terminal.

**Cause:** VS Code takes the wrapper, daemon and proxy only from `<extensionPath>/bundled`. It takes node only as a regular file outside the project: `MOE_NODE_COMMAND`, the managed runtime, an absolute PATH entry outside the project, or a standard install location. Two JetBrains protections are missing: VS Code attaches to any daemon that serves this project (task-648a5916), and its `verified-local` pin lasts one window session and has no downgrade dialog (task-98c81a27).

**Solution:** Reinstall the extension if a bundled file is missing, and install node outside the project. For a Windows path reason, see [Protected profile: path is not a plain local Windows path](#protected-profile-path-is-not-a-plain-local-windows-path).

---

## MCP/Proxy Issues

### MCP tools not responding

**Symptom:** Claude/agent hangs when calling Moe tools.

**Possible causes and solutions:**

#### Proxy not running

**Solution:** Start the proxy:
```bash
node packages/moe-proxy/dist/index.js
```

#### Daemon not running

**Solution:** The proxy requires daemon to be running. Start daemon first.

#### Wrong project path

**Solution:** Ensure MOE_PROJECT_PATH points to correct directory:
```bash
export MOE_PROJECT_PATH=/path/to/project
node packages/moe-proxy/dist/index.js
```

---

### MCP tools return errors

**Symptom:** Tools return error responses.

**Common errors:**

#### "Task not found"

**Solution:** Verify task ID exists:
```bash
ls .moe/tasks/
```

#### "Worker not registered"

**Solution:** Register the worker first using `moe.claim_next_task`.

#### "[CONSTRAINT_VIOLATION] Rail violation: …" (moe.submit_plan)

**Solution:**
- Forbidden pattern: reword the step description, path or contract text that contains it (case-insensitive substring).
- Required pattern missing: add the global phrase to the step text. Contract text does not count.
- Epic and task rails are guidance and never produce this refusal.
- A rail that is genuinely wrong for the task goes to `moe.propose_rail`, as the message spells out. Never loop on resubmits.

---

### Grok CLI cannot see `moe.*` tools

**Symptom:** A `--command grok` agent launches (`Grok MCP config written to: <project>/.grok/config.toml`,
`Grok mode: headless (--prompt-file --yolo)` or `Grok mode: interactive`) but never calls a `moe.*`
tool, reports them as unknown, or fails before the first call.

**Diagnose in this order:**

1. **Is the server registered?** From the project root, `grok mcp list` must show `moe` (and `serena`
   when it is installed); `grok mcp doctor moe` starts the proxy and reports the failure verbatim.
   `grok inspect` shows the effective configuration — the wrapper-written project `.grok/config.toml`
   beats anything grok auto-merges from `~/.claude.json`, `.cursor/mcp.json` or the project
   `.mcp.json` (the wrapper also sets `GROK_CLAUDE_MCPS_ENABLED=0` / `GROK_CURSOR_MCPS_ENABLED=0` for
   the spawned process, so those merges are off for agents; a hand-run `grok` may still see them).
   - **Healthy in `grok mcp doctor moe` but `MCP servers that failed to connect: - moe` in the session:**
     the session's `events.jsonl` (`~/.grok/sessions/<project>/<sid>/`) shows `mcp_server_connected`
     for `moe` with `"tool_count":0`. Two causes, both handled by the wrapper since 2026-09-05: grok
     drops tools whose name contains a dot, so the proxy must run with `MOE_TOOL_NAME_STYLE=underscore`
     (check `[mcp_servers.moe.env]` in `.grok/config.toml` — a config written by an older wrapper lacks
     it; the `underscore` style exposes `moe_<name>`); and grok refuses project MCP servers in a folder
     missing from `~/.grok/trusted_folders.toml` (doctor prints `folder untrusted`) — the wrapper adds the
     project (`Grok folder trust granted: <path>`; the key carries the on-disk casing grok compares
     against, and lives under `GROK_HOME` when that is set), or accept the prompt once in the TUI. A
     `trusted = false` entry is a decline made in the TUI: the wrapper warns and never overturns it. Grok itself
     only ever offers `search_tool`/`use_tool`; a moe tool is called as `use_tool` with
     `tool_name: "moe__moe_<name>"`.
   - **A moe call spins for minutes in the TUI (`Run (Moe) … 5m58s`):** grok logged
     `mcp_transport_decode_error` for `moe` and dropped the response (seen once on a 68 KB `list_tasks`
     result; the same call succeeds headless). Since 2026-09-05 the wrapper pins `tool_timeout_sec = 120`
     on the `moe` entry (`MOE_GROK_MCP_TOOL_TIMEOUT_SEC`) so the call fails fast and the model retries;
     `Esc` cancels the stuck call in the TUI. Prefer `limit`/`epicId` filters on `list_tasks` to keep results small.
2. **Proxy stderr:** `~/.grok/logs/mcp/moe.stderr.log` holds the proxy's own output. A
   `.moe/daemon.json` project-path mismatch or a dead daemon shows up here, not in the agent's
   transcript — the proxy reads `MOE_PROJECT_PATH` from `[mcp_servers.moe.env]`, and in WSL mode the
   wrapper upserts `MOE_DAEMON_HOST` into the same table after host discovery.
3. **`MOE_WORKER_ID` is empty:** the config carries the literal `MOE_WORKER_ID = "${MOE_WORKER_ID:-}"`,
   expanded by grok per process. Under the wrapper it becomes the launched worker's id; a human running
   `grok` by hand gets `""`, which the proxy treats as unset (no `workerId` injection) — pass `workerId`
   explicitly in tool calls.
4. **Auth:** `[WARN] XAI_API_KEY is not set and ~/.grok/auth.json is missing - grok will fail to
   authenticate.` at launch means neither credential exists. When both exist the cached `grok login`
   token (`~/.grok/auth.json`) wins over `XAI_API_KEY` — a stale or wrong-account cached login fails
   every request while the MCP config looks fine; re-run `grok login` (or remove the cached file to fall
   back to the key).
5. **Wrong `grok` binary:** the community `grok-cli` npm package installs a binary of the same name.
   `grok --version` must identify xAI Grok Build; otherwise reinstall (`irm https://x.ai/cli/install.ps1 | iex`
   on Windows, `curl -fsSL https://x.ai/cli/install.sh | bash` on Mac/Linux/WSL) or point
   `-Command`/`--command` at the full path. The wrapper detects grok by basename — a differently named
   binary is treated as a custom CLI and gets no `.grok/config.toml` at all.

The config is rewritten idempotently on every launch: other `[mcp_servers.*]` sections you added by
hand survive, but a project `.grok/config.toml` may not carry top-level keys (only `[mcp_servers.*]`,
`[plugins]`, `[permission]`, `[mcp]`) — put model/effort choices in `MOE_GROK_MODEL` / `MOE_GROK_EFFORT`
instead. `.grok/config.toml` is on the attribution DENY list (`.grok/**`), so the wrapper never lands it
in a task commit; this repo also gitignores it — add it to your own project's `.gitignore` (it holds
machine-local absolute paths).

### Codex agent relaunch-loops at launch: `unexpected argument '--full-auto' found`

**Symptom:** A `--command codex` worker or QA prints `Command: codex -c … exec -C "<project>" …`, codex
exits at once with

```
error: unexpected argument '--full-auto' found
```

and the wrapper reports `[launch-failure] CLI exited 2 after 0s, before doing any work (streak N)` and backs
off (60 s, 120 s, … up to 15 min). From the third failure in a row a claiming worker or QA seat enters
launch outage mode (`[launch-outage]`): once that iteration's post-flight has landed the checkpoint, it
releases the held task once, with a handoff that names the seat outage. The task stays claimable in place
(WORKING stays WORKING), so another seat resumes it; a BLOCKED task, or a release the daemon refuses, stays
held. The seat then claims no new task and relaunches only as a taskless launch probe on the same backoff;
the first launch that runs ends the outage and claiming resumes. A governor seat, or one with auto-claim
off, relaunches on the backoff with its task still held. Either way this seat writes no code until the fix
below.

**Cause:** codex-cli 0.147.0 (August 2026) hard-removed `--full-auto`
([openai/codex#36054](https://github.com/openai/codex/pull/36054), after the
[#20133](https://github.com/openai/codex/pull/20133) deprecation of 2026-04-29; 0.130–0.146 still accepted
it with a warning). The standalone codex installer auto-updates (`~/.codex/packages/standalone/releases/<version>/`),
so any box on 0.147+ hits this the first time a seat runs headless. On the Moe side that moment came with
8b632b5 (2026-09-06): worker/QA codex seats default to one-shot `codex exec` — before it the JetBrains
launcher never passed `-CodexExec`, so the `exec … --full-auto` branch never ran and the removal stayed
invisible for a month. A wrapper built before 2026-09-07 still passes the flag. `codex exec --help` lists
what the installed version accepts.

**Fix:** rebuild and reinstall the plugin — the live wrapper is the installed plugin's copy, not the repo's:
JetBrains on Windows `.\scripts\install-all.ps1 -BuildPlugin -InstallPlugin -IdeVersion <IDE folder, e.g. PyCharm2026.1>`;
JetBrains on macOS/Linux `scripts/install-mac.sh --with-plugin`; VS Code/Antigravity `cd moe-vscode && npm run package`
(re-bundles `scripts/`) and reinstall the `.vsix`. Then restart the affected agent terminals (a running
wrapper keeps the argv it parsed at start). Since 2026-09-07 the headless launch is
`codex -c <seat overrides> -c approvals_reviewer=user exec -C <project> --sandbox <mode>` with `mode` from
`MOE_CODEX_SANDBOX` (default `danger-full-access` since the fix below; `inherit` drops the flag so the merged `~/.codex` +
`<project>/.codex` `sandbox_mode` decides — read-only when neither sets it; on Windows `workspace-write`
needs `[windows] sandbox = "unelevated"` in `~/.codex/config.toml`, see `MOE_CODEX_SANDBOX` in
CONFIGURATION.md). `codex exec` already runs with `approval_policy = never`, and the reviewer pin keeps
that override even when the operator's config says `approvals_reviewer = "auto_review"` — together they
carry what `--full-auto` meant. The launch-failure line now names this case
(`… or an argv the installed CLI version rejects (exit 2 from codex; run the printed Command by hand)`),
and `scripts/tests/parity-check.{sh,ps1}` fail if `--full-auto` ever comes back. The wrapper also probes its own
argv once per process (`… --help`) before the first headless launch: a codex that rejects a flag now stops the
seat with `[ERROR] MOE_CLI_ARGV_REJECTED: the installed codex (<version>) rejects the wrapper's launch argv -- <codex's
error line>` plus a `@governors` line in `#general`, instead of relaunch-looping (`MOE_DISABLE_ARGV_PROBE=1` skips it).

### Codex worker stalls: `CreateProcessAsUserW failed: 5 (Access is denied.)` and `MCP tool call requires approval, but approval policy is never`

**Symptom:** a headless codex seat (`codex … exec … --sandbox workspace-write`, the wrapper default between the
`--full-auto` fix and this one) launches fine, then every shell command fails with

```
ERROR codex_core::tools::router: error=exec_command failed: CreateProcess { message: "Rejected(\"Failed to create unified exec process: CreateProcessAsUserW failed: 5 (Access is denied.) | cwd=… | cmd=C:\\Users\\<you>\\AppData\\Local\\Microsoft\\WindowsApps\\pwsh.exe …
```

and every `moe.*` / `serena.write_memory` call fails with `MCP tool call requires approval, but approval policy is
never` (`moe.start_step`, `moe.report_blocked` …). The model gives up ("Unable to proceed: runtime permissions
deny process execution and Moe/Serena writes"), the wrapper lands a checkpoint and idles. Interactive TUI seats
on the same box keep working.

**Cause:** two codex 0.148+ behaviors, both tied to running under a sandbox with `approval_policy = never`
(`codex exec` forces `never`; measured on 0.153.4, 2026-09-07): (1) codex refuses any MCP tool it deems
approval-worthy — every tool without a `readOnlyHint` annotation, i.e. all of Moe's — instead of asking, unless
the server is configured with `default_tools_approval_mode = "approve"`; under `danger-full-access` codex bypasses
approvals entirely, which is why TUI seats (the operator's global `sandbox_mode = "danger-full-access"`) never
saw it. (2) On Windows, `[windows] sandbox = "unelevated"` runs commands under a restricted token, and that token
cannot execute a Microsoft Store (MSIX) PowerShell 7 — the `WindowsApps\pwsh.exe` alias codex picks from PATH.
`codex sandbox -- "$env:LOCALAPPDATA\Microsoft\WindowsApps\pwsh.exe" -NoProfile -Command exit` reproduces it with no
model call; `codex sandbox -- cmd /c exit` (and System32 `powershell.exe`, `node`, `git`) succeeds.

**Fix:** rebuild and reinstall the plugin (see above). Since this fix the headless default is
`--sandbox danger-full-access` and the config writer pins `default_tools_approval_mode = "approve"` on the `moe`
and `serena` servers in `<project>/.codex/config.toml`. Interim, with an older wrapper: launch with
`MOE_CODEX_SANDBOX=danger-full-access` (or `inherit`), or use the interactive TUI (`-Interactive` / `--interactive`).
To keep a real sandbox on Windows, install the MSI PowerShell 7 (`winget install --id Microsoft.PowerShell --source winget`)
so codex finds `C:\Program Files\PowerShell\7\pwsh.exe`, then set `MOE_CODEX_SANDBOX=workspace-write`. Codex seats are interactive (TUI) by default again since 0.8.0; headless
stays opt-in via `-CodexExec` / `--codex-exec`.

---

## Task Sync Issues

### Tasks not appearing in plugin

**Symptom:** Created tasks don't show in IDE.

**Possible causes:**

#### WebSocket disconnected

**Solution:** Check plugin connection status, reconnect if needed.

#### File watcher not triggering

**Solution:** Restart daemon to reinitialize file watcher.

---

### Task status not updating

**Symptom:** Status changes aren't reflected.

**Solution:**
1. Check daemon logs for errors
2. Verify file permissions on `.moe/tasks/`
3. Restart daemon

---

### Duplicate tasks appearing

**Symptom:** Same task shows multiple times.

**Solution:** This is usually a UI bug. Refresh the board or restart the plugin.

---

### Worker finished but nothing was committed

**Symptom:** A task reached REVIEW/DONE on the board, but no `feat|fix(task-<id>)` commit appears on
`moe/work-<date>` (or the literal `consolidationBranch`), `task.commits` is empty, and `qa_approve`
answered `NO-COMPLETION-COMMIT`. Historically this failure was completely silent; today every landing
attempt is logged by the wrapper and recorded on the task (`task.lastCommitOutcome`), so start there:

```bash
scripts/moe-call.sh get_context '{"taskId":"task-<id>"}' --project <path>   # commits, landing, lastCommitOutcome, unattributedPaths
git log --all --grep 'Moe-Task: task-<id>' --format='%h %s'
git for-each-ref refs/moe/rescue/task-<id>/
```

**Read `lastCommitOutcome` first.**

- **Absent** — the post-flight never ran: causes 1 and 2 below (interactive TUI, or the fleet still
  runs an older installed wrapper), or the session was killed before post-flight (window close /
  SIGKILL). In the latter case the persisted baseline `<gitdir>/moe/baseline/task-<id>.tsv` makes the
  task's next session land a recovery checkpoint (`MOE_CHECKPOINT_RECOVERED`) before any CLI starts —
  relaunch an agent of the right role, or see "Task went BLOCKED … and its files never reached git".
- **`{ outcome: "refused", code: "MOE_COMMIT_REFUSED_NO_OWNED_PATHS" }`** — nothing was attributable
  to the task: no completed step reported `modifiedFiles`, the plan had no `affectedFiles`, nothing was
  declared, no tool write was harvested. Fix: `moe.declare_files { taskId, paths }` for the paths that
  belong to it, then let the task's next session exit land them.
- **`{ outcome: "refused", code: "MOE_COMMIT_REFUSED_OWNED_PATH_MISSING" }`** — every asserted path is
  absent from disk and from HEAD (renamed, deleted, or edited inside a `.worktrees/` checkout the
  post-flight cannot see). Move the edits into the project root and re-declare.
- **`MOE_COMMIT_REFUSED_ACTIVE_ASSIGNEE` | `MOE_COMMIT_REFUSED_OWNER_UNKNOWN`** (not a
  `lastCommitOutcome` value) — expected, nothing lost: the exiting session was not the task's assignee
  (an architect or QA seat whose task moved on), and the owner was live or held an open attempt, another
  seat's attempt was still finalizing (ACTIVE), or ownership could not be confirmed (UNKNOWN: daemon
  unreachable, older daemon). It moved nothing; the owner's own landing commits those bytes. See
  **Owner guard** in `scripts/CLAUDE.md`. `lastCommitOutcome` keeps the owner's own last landing (only a
  row recorded by an older daemon can still show one of these codes); the refusal shows only in the task
  channel (`⛔ … landing REFUSED …`) and on the refusing seat's session-ended line.
- **`{ outcome: "nothing", code: "MOE_COMMIT_NOTHING_TO_COMMIT" }`** — the candidates were already in
  HEAD (a resume relaunch after a successful landing, or the agent committed mid-session). Nothing lost.
- **`{ outcome: "failed", code: … }`** — `MOE_COMMIT_FAILED_REF_CONTENTION` (three CAS losses to
  peers) or a hook/identity failure under `commitHooks=true`: the bytes are in
  `refs/moe/rescue/task-<id>/<ts>` — see "Recovering from `refs/moe/rescue/*`" below.
- **`{ outcome: "committed", kind: "checkpoint" }` and no completion** — the session exited at
  WORKING/BLOCKED, so the task never reached REVIEW from it; the `wip(...)` checkpoint holds the bytes
  and the next session continues from there.
- **`committed` with `pushed: false`** — `PUSH FAILED for task … committed locally only; do not review
  until pushed` (or `CHECKPOINT-UNPUSHED task=<id>`) in `#general`: the commit exists on the local
  branch. Push by hand once the remote divergence is resolved — the wrapper never `pull --rebase`s
  the checkout it lands in (that checkout is shared with every other seat; `MOE_PUSH_REBASE=1` opts a
  private checkout back into the one retry). Visibility problem, not a loss.

**Two older causes, both fixed — check whether you still have one.**

**1. The worker was launched into the interactive TUI.** The wrapper blocks inside the CLI call for
that process's entire lifetime, and the post-flight (session-end announce, auto-commit+push) runs
strictly *after* it — a TUI that never exits means a post-flight that never runs. Diagnostic: grep
`#general` for session-end messages. If you see `qa session ended: task=…` lines but never
`worker session ended: …`, this is it. Confirm with the launch argv:

```powershell
Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" |
  Where-Object { $_.CommandLine -like '*moe-agent.ps1*' } |
  Select-Object ProcessId, CommandLine
```

A `-Interactive` on a `-Role worker` line is the bug. Only architect and governor take the TUI now
(`TerminalAgentLauncher.shouldLaunchClaudeInteractive`); worker and QA run one-shot `--print`, which
exits at end_turn so the post-flight is reached. You still see every tool call — the wrapper's
stream-json parser prints them live.

**2. The post-flight could not resolve the task's final status.** It used to answer "is this task in
REVIEW?" with an *unscoped* `list_tasks`, filtered client-side. The daemon caps that call at
`DEFAULT_TASK_LIST_LIMIT` (100), so once a project outgrows one page the just-completed task simply
is not among the rows that come back: the status reads empty, the `= REVIEW` guard is false, and the
entire auto-commit block — including every diagnostic line inside it and the PUSH-BLOCKED escalation
— is skipped in silence. Diagnostic you can run yourself:

```bash
scripts/moe-call.sh list_tasks '{}' --project <path>
```

If `tasks` comes back with exactly 100 entries while `pagination.total` is larger, you have hit it.

The lookup now goes through `get_context { taskId }`, which keys on the task id and cannot be
paginated away; the epic-final check that drives `qualityGate` scope uses a separate **epic-scoped**
`list_tasks { epicId, limit }`, which is bounded legitimately because it asks about one epic's
siblings. Raising the unscoped limit is *not* a fix — `MAX_TASK_LIST_LIMIT` is 500, so that only
moves the same silent cliff further out.

Two sharp edges worth knowing if you touch this code: `get_context`'s task projection carries no
`epicId` and no `order` (the resolved `epic` object comes back alongside it), and an unresolvable
`taskId` **falls back to the caller's own current task** rather than erroring — so the wrapper checks
`task.id` against the id it asked for and treats a mismatch as a failed lookup.

A failed lookup is no longer indistinguishable from "the task genuinely isn't in REVIEW". It now
prints `[WARN] post-flight status lookup failed for task <id>: …` and posts a
`PUSH-BLOCKED: post-flight status lookup failed for task <id>` message to `#general` — and still lands
a `wip(… status=UNKNOWN …)` checkpoint, because the task id is certain even when its status is not. A
real non-REVIEW status lands a `wip(...)` checkpoint instead of the old quiet no-op.

**Note:** the fleet runs the wrapper scripts and launcher bundled into the **installed** plugin, not
the ones in your working tree. Fixing this in the repo does nothing until you rebuild and reinstall:

```bash
cd packages/moe-daemon && npm run build     # buildPlugin hard-fails on a stale daemon dist
cd moe-jetbrains && ./gradlew buildPlugin
.\scripts\install-all.ps1                   # then restart the IDE
```

Regression coverage for both causes lives in `scripts/tests/postflight.sh` and its `.ps1` sibling
(`FAKE_LIST_TASKS_TRUNCATED`, `FAKE_GET_CONTEXT_FAIL=empty|mismatch`) plus
`TerminalAgentLauncherTest`.

---

### Task went BLOCKED/AWAITING_APPROVAL and its files never reached git

**Symptom:** A task is BLOCKED (or an architect's task sits in AWAITING_APPROVAL) and the files its
session edited exist only in one machine's dirty checkout. A sibling task that depends on them
reports "prerequisite absent at HEAD" and blocks too — the cascade that used to strand whole epics.

**What happens now:** every session exit that holds a task lands a `wip(task-<id>): <title>
[status=<STATUS> role=<role> cli-exit=<N>]` checkpoint on the shared branch (pushed when
`settings.checkpointPush`, default on) — worker, architect and qa sessions alike. A BLOCKED hold the
wrapper refuses to relaunch still lands: the idle path runs the recovery landing for
`alreadyAssigned.taskId` before parking, so a blocked task's files reach the branch with no CLI
launched.

**If a checkpoint is missing:**

1. Look for a lingering baseline: `ls "$(git rev-parse --absolute-git-dir)/moe/baseline/"`. A
   `task-<id>.tsv` there means a session ended without landing; the next pre-flight of that task
   lands it (`MOE_CHECKPOINT_RECOVERED task=<id> sha=<sha>` in the wrapper log). Relaunch any agent of
   the right role — the recovery runs even on the BLOCKED-hold and resume-cap idle paths.
2. `git for-each-ref refs/moe/rescue/task-<id>/` — a rescue ref holds the bytes when the landing
   itself failed (next section).
3. `settings.checkpointCommits=false`, `MOE_DISABLE_CHECKPOINT=1` or `settings.autoCommit=false` turn
   checkpoints off — the wrapper logs `[info] settings.autoCommit=false — no git activity` when that is
   the reason.
4. The edits were made inside a `.worktrees/` checkout — invisible to the post-flight, which only ever
   runs against the project root. Copy them into the root and `moe.declare_files` them.

Prerequisite checks belong on HEAD, not on a dirty tree: `get_context.epicSiblings[*].landed` or
`git log <branch> --grep 'Moe-Task: task-<sibling>'` is the test. BLOCKED is a wait state, never a
terminal: a `report_blocked` with every step already COMPLETED gets an `ALL_STEPS_COMPLETE` warning
pointing at `complete_task`.

---

### `[skip] <path> MOE_ATTR_*` lines and `MOE_ATTRIBUTION_UNRESOLVED`

**Symptom:** The wrapper landed a commit but printed `[skip] <path> <code>` for some paths, or
`MOE_ATTRIBUTION_UNRESOLVED task=<id>: <paths…>` (also posted to the task channel and, rate-limited to
once per task per 24h, to `#governors`), and those paths are still dirty.

Each dirty path is classified once per landing, in this order: **BOARD** (own task record) →
**DENY** → **ASSERTED**/**TOOL** (an asserted path must also carry bytes this task produced) →
**PEER** → baseline diff → **PLANNED** → **MEASURED** → unattributed. The codes:

| Code | Meaning | What to do |
|---|---|---|
| `MOE_ATTR_EXCLUDED` | On the DENY list: `.moe/**` (except board records), `.mcp.json`, `.codex/**`, `.gemini/**`, `.grok/**`, `.claude/agents/**`, `.claude/settings.local.json`, untracked `.serena/**`, `.worktrees/**`, `.moe-worktree*`, `settings.attribution.exclude` | Nothing — these never belong in a task commit. |
| `MOE_ATTR_PEER_DECLARED(task-<peer>)` | Another nonterminal task declares this path, with no ASSERTED or TOOL scope here | Resolve which task owns the changes. Declaring the path on this task makes it contested while the peer declaration still applies; the declaration alone does not supply a TOOL witness. |
| `MOE_ATTR_CONTESTED_UNTOUCHED(task-<peer>)` | Asserted by this task **and** declared by another nonterminal task, without a supported TOOL witness from this session (default policy `skip-untouched`). It still fires when the path was dirty at this session's pre-flight, when any contesting task had a session since then (`peerActive` is not `false`), on a crash-recovery landing, and without the daemon's `peerActive` field; a path clean at pre-flight whose every contesting task is idle lands instead. The session-ended `#general` line names each held path as `held=<path>(task-<peer>)`, then a `MOE_CONTESTED_HELD remedy:` sentence. `<peer>`, here and in the code, is the first of the path's contesting tasks in cause order: editing, then active (`activeTaskIds`), then the rest | `moe.declare_files` does not release it. Verify the bytes are this task's and coordinate any live peer. The path then lands once a one-shot Claude or `codex exec` session of this task edits it with a supported editing tool, once a later session of this task that found it clean at its pre-flight edits it while every contesting peer stays idle, or once the stale peer task is legitimately completed or archived. A Codex TUI, Gemini, Grok or interactive Claude session's edits, Serena's included, leave no TOOL witness. An extra edit lands the whole file, so it does not prove ownership of hunks already in it: verify first. Never change the policy as the fix. |
| `MOE_ATTR_CONTESTED_EDITING(task-<peer>)` | Default policy `skip-untouched`: a contesting peer task was mid-step on the path with an active session (an IN_PROGRESS plan step naming it, `moe.get_commit_scope` `editingTaskIds`; the disk-fallback scope counts any IN_PROGRESS step), so the path is held even though this session edited it. `<peer>` is the first editing task. The file can carry that peer's unfinished hunks | Coordinate that peer and let its step finish, then have a one-shot Claude or `codex exec` session of this task re-edit the path before its next exit; or let the peer's own landing carry the bytes, and name that commit. `moe.declare_files`, unblocking or a shell touch does not release it. Never change the policy as the fix. |
| `MOE_ATTR_CONTESTED` | In this task's ASSERTED or TOOL scope **and** declared by another nonterminal task, with `settings.attribution.contested: "skip"`. Its `held=` peer is the first contesting task in the same cause order | No editing tool and no `moe.declare_files` releases it; only resolving, completing or archiving the peer task does. Resolve ownership before choosing an applicable policy. An explicit `"commit"` permits whole-path landing with one `Moe-Contested: <path> (task-<a>, task-<b>)` trailer per path, naming every contesting task in cause order; it does not establish ownership of the file's changes. |
| `MOE_ATTR_IMPORTEE_MISSING(<specifier>)` | A supported literal relative import has no matching path in the resulting commit. This checks path presence, including TypeScript source candidates for emitted module paths; it does not certify compiler or runtime validity | If this task owns the importee, declare it so both paths can pass attribution together; otherwise wait for its owner to land it; the path is re-attempted at the next exit and is reported as `MOE_ATTRIBUTION_UNRESOLVED` meanwhile. |
| `MOE_ATTR_PREEXISTING` | Dirty before this task's first session and byte-identical now — the hard constraint: a path the task never asserted and never changed is never committed | Nothing for this task. Debris left by a DONE task → "Dirty paths owned only by DONE tasks" below. |
| `MOE_ATTR_ASSERTED_FOREIGN` | Asserted by this task only through its history (`filesModified`, a completed step's `modifiedFiles`/`affectedFiles`, an earlier commit, an earlier session's tool writes; never `moe.declare_files`), but the bytes were already dirty when the landing session's pre-flight ran and are untouched since, so this task did not produce them. A crash recovery compares against the dead session's own pre-flight. The 2026-09-30 shape: someone's uncommitted edit to a file a task delivered days earlier | Find who made the edit (`git diff -- <path>`, chat, the other live tasks). If those bytes really are this task's, `moe.declare_files { taskId, paths }` and the next exit lands them; otherwise leave the path for its owner. The task's next edit to the path also lands it (whole file, including the existing hunks). |
| `MOE_ATTR_MISSING` | An asserted path exists neither on disk nor in HEAD (renamed / deleted / edited in a worktree), or is gitignored | Fix the path or the plan's `affectedFiles`. Deletions of tracked files stage naturally and never hit this. |
| `MOE_ATTR_CONCURRENT` | The staged blob no longer matched the snapshot — a peer wrote the file between the snapshot and `add` | Nothing — retried at the next exit. |
| `MOE_ATTRIBUTION_UNRESOLVED` | Changed since the baseline, not asserted, not planned, not tool-written, and `attribution.undeclared` forbade a MEASURED commit (default `solo` while another worker is live) | Persisted in `task.unattributedPaths` and shown to the resuming session. Claim it with `moe.declare_files { taskId, paths }` (governor or worker) so the next exit lands it — or set `attribution.undeclared: "always"` on a single-seat project. |

With `commitHooks: true`, `hooked-commit-config-mismatch` means the private commit context
resolved different signing or author settings. Landing is held as `MOE_COMMIT_FAILED` and
parked on a rescue ref before any commit hook or signing attempt. Review conditional Git
configuration so both contexts resolve the intended settings; do not disable required signing
to clear the refusal. Hooked completion on an unborn branch is also held until HEAD exists.

**Current witness limit:** only Claude one-shot `stream-json` editing events and
`codex exec --json` events (a completed `file_change`, a successful Serena editing call)
feed the wrapper's per-session TOOL set today, after an editing call receives its matching
successful result. Failed calls, calls without results and shell writes supply no witness.
Codex TUI, Gemini, Grok and interactive Claude can perform real edits without producing that
witness. A dirty tree, baseline difference, declaration, `complete_step.modifiedFiles`, or
historical task touch record cannot substitute for it. Completed-step reports remain ASSERTED
scope; they do not prove this session edited the path. Under the default, such a seat's
contested path lands only from a later session whose pre-flight found it clean while every
contesting peer stays idle. Otherwise hand the edit to a one-shot Claude or `codex exec`
session of the task, or let the peer task complete or be archived; never change the policy as
the fix. See [Session touch evidence](CONFIGURATION.md#session-touch-evidence).

Also printed once per landing: `[attribution] <K> pre-session dirty path(s) untouched` — the count of
foreign / pre-existing dirt the wrapper deliberately left alone. It is informational, never an error
and never a stop condition for an agent.

---

### Recovering from `refs/moe/rescue/*`

**Symptom:** `MOE_RESCUE_REF task=<id> ref=refs/moe/rescue/<id>/<ts> sha=<sha> reason=<r>` in
`#general` or the wrapper log, `[rescue] N rescue ref(s)` at a pre-flight, or `task.commits` carries a
`kind: "rescue"` entry.

A rescue ref is a `rescue(task-<id>): <title> [reason=…]` commit parented on HEAD that holds the task's
attributed bytes when the branch could not be advanced: `gate-failed` (`qualityGate` non-zero — code
that failed the gate must not reach origin through a peer's push), `peel-failed` (could not leave
`main`/`master`/detached HEAD), `commit-failed` (a hook rejected the porcelain commit under
`commitHooks=true`, or a plumbing/identity error), `ref-contention` (three CAS losses), or `teardown`
(Ctrl+C / SIGTERM during the CLI). HEAD, the branch and the shared index are untouched; the ref is
never pushed; the baseline is kept, so the task's **next session lands the same bytes as a normal
checkpoint** if they are still on disk. The ref exists for the case where they are not:

```bash
git for-each-ref --format='%(refname:short) %(objectname:short) %(subject)' refs/moe/rescue/task-<id>/
git show <ref> --stat                              # what it holds
git checkout <ref> -- <path>                       # restore one path into the working tree
git update-ref -d refs/moe/rescue/task-<id>/<ts>   # only after the work is on the branch
```

`scripts/analyze-task-metrics.mjs --commits` lists unrecovered rescue refs; review them weekly. For
`gate-failed`, fix the gate failure in a new session — the loop stopped on purpose (`PUSH-BLOCKED:`
chat + the output tail as a task comment).

---

### Dirty paths owned only by DONE tasks (foreign-WIP stop condition)

**Symptom:** A worker refuses to proceed because the checkout has dirty tracked paths "belonging to
someone else", or a governor finds modified sources whose only owner (`grep -l '<path>'
.moe/tasks/*.json`) is a task that is already DONE. These are pre-existing debris from before
land-on-every-exit: the wrapper classifies them `MOE_ATTR_PREEXISTING` for every later task and will
never sweep them.

**Runbook (governor or human — never the wrapper):**

1. For each path, `grep -l '<path>' .moe/tasks/*.json` to find the task that edited it.
2. A **live** task (not DONE/ARCHIVED) edited it → `moe.declare_files { taskId, paths, note }`; its
   next session exit commits them as ASSERTED.
3. Only DONE tasks name it → a human pathspec commit:
   `git add -- ':(literal)<path>' && git commit -m 'chore(debris:<taskId>): <what>'` — never
   `git add -A`, never under an agent's identity.
4. Untracked sources nobody declares → one `chore(debris): pre-fix untracked sources` commit after a
   typecheck.

Do **not** hand-land another task's sources as a governor `chore` sweep — it hides attribution and the
task record never learns about the commit. And never treat foreign dirt as a stop condition: the
pre-flight notice tells agents to note it in the step and continue.

---

### `unblock_worker` no longer clears the block (RE-BLOCK)

**Symptom:** After `moe.unblock_worker { workerId, resolution }` the worker is IDLE but its task is
still BLOCKED with `blockedReason` intact, and the response lists it in `stillBlockedTaskIds`.

That is the new default — **seat-only**. Freeing a seat is not an assertion that the blocker is gone;
the old behaviour wiped `blockedReason` and the next claimant re-blocked on the same wall minutes
later. To actually resolve the block, say so explicitly:

```bash
scripts/moe-call.sh unblock_worker '{"workerId":"<id>","resolution":"<what changed>","resolveBlocks":true}' --project <path>
# or, for the task alone (no worker involved):
scripts/moe-call.sh set_task_status '{"taskId":"task-<id>","status":"WORKING"}' --project <path>
```

`retryTask: true` without `resolveBlocks` leaves a BLOCKED task completely untouched (still assigned,
still BLOCKED). Unassigned BLOCKED tasks are not auto-parked — they stay visible in the Working column
until a human or governor acts; triage them with `list_tasks { status: "BLOCKED" }`.

---

### Worker wrapper stopped after a blocked or handed-back task

**Symptom:** a worker wrapper exited after a task's post-flight instead of claiming more work, for
example right after its agent called `moe.report_blocked` or a human moved the task with
`set_task_status`.

A hand-back does not end the loop by itself. When `report_blocked` frees the seat (or
`set_task_status`, a seat-only `unblock_worker` or a sweep releases the task), the daemon closes that
seat's attempt; the post-flight checkpoints the task, acknowledges nothing and claims again. These
lines are benign:

- `[finalize] no finalizing attempt for this seat on task <id>; nothing to acknowledge.` The pinned
  attempt was missing, parked `reconciling`, or no longer matched the pin. A closed or running
  attempt prints no line at all.
- `[WARN] Missing/stale attempt identity; candidate completion will fail closed.` at pre-flight. A
  resumed session found no single open attempt to pin. A checkpoint exit still lands; a completion
  that must run a quality gate is parked on a rescue ref instead (`qualityGate not run: candidate
  evidence unavailable`), and the loop still goes on.

These lines mean the wrapper stopped on purpose:

- `[WARN] finalize_attempt acknowledgement exhausted; stopping new-task loop (no repeated Git effect).`
  The seat's finalizing attempt (a completion's landing hold) was not acknowledged after three tries.
- `[WARN] finalize refused: finalizing attempt <id> on task <id> has no pinned identity; not acknowledging.`
  The seat holds a finalizing attempt it never pinned. The wrapper never acknowledges an identity it
  did not pin, and the daemon refuses the seat's next claim while that hold stands.

A stop after a failed quality gate (`PUSH-BLOCKED: qualityGate failed`) or a refused branch peel is a
landing failure, not a finalize one: see **Worker finished but nothing was committed** above.

**Fix:** relaunch the seat. The stopped wrapper deregistered its worker on exit, and
`deregister_worker` closes that worker's own finalizing attempts, so the landing hold is already gone.
If a wrapper died without deregistering, first confirm it is really gone, then close the hold by hand:
find the record with `grep -l '"phase": "finalizing"' .moe/attempts/*.json` and call
`moe.finalize_attempt` with its exact `taskId`, `attemptId` and `generation` (`outcome: "failed"`
when nothing landed) — see **Escape for a runner that is gone** under `moe.finalize_attempt` in
`docs/MCP_SERVER.md`.

---

### `qa_approve` returned `NO-COMPLETION-COMMIT`

**Symptom:** `warnings: ["NO-COMPLETION-COMMIT: task <id> has no completion commit recorded yet (the
wrapper lands it seconds after REVIEW) — verify task.commits / git log before merging"]` — also posted
to `#governors`. The approval still landed (DONE).

The warning is advisory. It fires when `settings.autoCommit` is on and no `task.commits` entry of kind
`completion` was recorded in the current work round: at or after the latest rejection, else the first
step start (`task.workStartedAt`), else `task.reviewStartedAt` (`completionCommitsForReview` in
`delivery/policy.ts`). Causes, in order of likelihood:

1. **The race**: QA approved within seconds of REVIEW, before the worker's CLI exited and the wrapper
   ran `record_commit`. Re-check `task.commits` a minute later — the wrapper lands the completion
   commit with `Moe-Status: DONE` even after the approval.
2. The worker's landing was refused or failed — read `task.lastCommitOutcome` and the first section.
3. The fleet still runs an older installed wrapper that never calls `record_commit` (rebuild +
   reinstall, note below).

Policy for QA: an empty `task.commits` at REVIEW (no completion entry for the round) is a bounded
wait, then a `moe.qa_reject` citing the landing evidence (`task.lastCommitOutcome`), never a QA
commit: the agent Git-write guard refuses one ([Agent Git-write refusal](#agent-git-write-refusal)),
and the reopened row's worker session lands it through its wrapper. The full rule is in
`docs/roles/qa.md` and `docs/roles/qa.reference.md` ("Empty `task.commits` at REVIEW"). A DONE task
with no completion commit from anyone is still a merge with no reviewed diff.

---

### Agent Git-write refusal

`MOE_AGENT_GIT_REFUSED: the wrapper lands the work` means an ordinary commit/push came from an agent CLI (or descendant shell) in the shared control checkout. Report the task's paths with `moe.complete_step`; let the wrapper land them. Do not repair this by bypassing the guard or committing peers' staged files. Scratch commands must use `cd /absolute/scratch && git ...` or `git -C /absolute/scratch ...`.

The temporary, inherited Git configuration matches only that checkout's exact gitdir, not separate scratch repositories or linked worktrees. The wrapper and sidecars do not inherit it; `settings.commitHooks` is unchanged, and existing human hooks/configuration remain untouched. `MOE_AGENT_GIT_GUARD_FAILED` stops CLI launch rather than falling back unprotected: **Git 2.31 or newer is required** for `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_<n>`/`GIT_CONFIG_VALUE_<n>` and `git rev-parse --path-format=absolute`. On older Git, every launch in a Git project stops with that code (Ubuntu 20.04, for example, ships Git 2.25). Check `git --version` for the Git on the seat's PATH, then check Git/repository access, inherited `GIT_CONFIG_*` overrides and temporary-directory permissions before relaunching. Non-Git projects remain supported without Git protection.

If every Git command inside a seat fails with `error: missing config key GIT_CONFIG_KEY_0` followed by `fatal: unable to parse command-line config` (exit 128), the CLI's environment policy may have stripped names containing `KEY` while retaining `GIT_CONFIG_COUNT` and `GIT_CONFIG_VALUE_<n>`. Measured with codex-cli 0.166: all three pass through by default, but `shell_environment_policy.ignore_default_excludes = false` strips the keys. Remove that setting or set it to `true` (the default), wherever configured: `~/.codex/config.toml`, the project's `.codex/config.toml`, or a `-c` override. Measured with gemini-cli 0.64: it keeps `GIT_CONFIG_*` even under redaction; Grok is unverified. Keep or drop the whole `GIT_CONFIG_*` family together: dropping all of it leaves Git working but runs the seat **without this guard**. The wrapper never rewrites a CLI's environment policy.

This prevents accidents, not hostile agents: `--no-verify`, explicitly replacing `core.hooksPath`, or removing inherited Git configuration defeats it. For a **deliberately reviewed human operation only**, the following one-command override delegates to the original hook (including its failures). It is not an agent recovery procedure:

```bash
MOE_ALLOW_AGENT_GIT_WRITES=1 git -C /absolute/control commit --only reviewed-file.txt -m 'Reviewed human change'
```

```powershell
$previous = $env:MOE_ALLOW_AGENT_GIT_WRITES
try {
    $env:MOE_ALLOW_AGENT_GIT_WRITES = '1'
    git -C 'C:/absolute/control' commit --only reviewed-file.txt -m 'Reviewed human change'
} finally { [Environment]::SetEnvironmentVariable('MOE_ALLOW_AGENT_GIT_WRITES', $previous) }
```

A human outside the agent session needs no override. Do not persist it in a profile or weaken Git configuration to make agent writes routine.

---

### `MOE_COMMIT_INDEX_REFRESH_FAILED`

**Symptom:** `[WARN] MOE_COMMIT_INDEX_REFRESH_FAILED` after an `[OK] Committed …` banner; `git status`
still shows the landed paths as modified/untracked even though `git log` has the commit.

The landing writes the commit through a temporary index, then refreshes the **shared** index for
exactly the landed paths with `git reset -q -- ':(literal)<path>'` (five 2-second retries on
`index.lock`). When a peer held `index.lock` throughout, the commit exists but the shared index still
has the old entries — harmless: the next landing (or `git reset -q -- <paths>` by hand) reconciles it.
Nothing was lost and nothing of a peer's was touched.

---

### One-time moe-next reconciliation

Runbook for a project that ran the pre-fix wrappers (moe-next is the reference case: hundreds of
untracked/modified `.moe/tasks/*.json`, 19 dirty tracked sources owned only by DONE tasks, two stale
`codex/direct-review-fixes*` worktrees). Human or governor, never the wrapper, in this order:

1. **Board records**: `git add -- .moe/tasks .moe/epics && git commit -m 'chore(board): land task/epic records'`
   — one wholesale commit; from then on each landing stages its own task record (`commitBoardState`).
2. **DONE-owned dirty sources**: per path, `grep -l '<path>' .moe/tasks/*.json`; a live task →
   `moe.declare_files` onto it (its next exit commits); DONE-only → a human
   `chore(debris:<taskId>)` pathspec commit (see "Dirty paths owned only by DONE tasks").
3. **Untracked sources nobody declares**: one `chore(debris): pre-fix untracked sources` commit after
   a typecheck.
4. **Stale worktrees**: merge or delete the `codex/direct-review-fixes*` worktrees by hand
   (`git worktree remove <path>` / `git branch -d`), then `git worktree prune` — only after that.
5. **Verify**: `scripts/analyze-task-metrics.mjs --commits` shows zero tasks with a non-`nothing`
   outcome and no commit; `git for-each-ref refs/moe/rescue` is empty or reviewed.

Rollout compatibility while the fleet catches up: a new wrapper against an old daemon falls back to
disk/declared-only attribution; an old wrapper against the new daemon keeps its old behaviour plus
`qa_approve` warnings — both expected until the plugin is rebuilt and reinstalled (note above).

---

### moe-next board doctrine rewrite (after the dependency-fields reinstall)

Runbook for retiring a board's free-text "verify-or-block" gate doctrine once the plugin build carrying
`dependsOn`/`blockedOnTaskIds` is installed (moe-next is the reference case: 17 stale BLOCKED rows whose
free-text reasons pointed at tasks that were long DONE, 119/632 meta evidence rows, 24 `customRules`
rails at ~20KB per `get_context`). The rails existed because dependencies were prose, not fields — with
the fields live, rewrite the rails. Apply via `moe.update_settings` / `scripts/moe-call.sh`, never by
hand-editing `.moe/`:

1. **Rewrite `customRules[13]`** (the verify-or-block DoD gate rule): "declare
   `blockedOnTaskIds`/`dependsOn`; read the prerequisite's `verification` from `epicSiblings`; DoD grep
   gates only for code the prerequisite does not own."
2. **Collapse duplicate rules 7/8**; restore truncated content and delete scar-tissue rules 10/11;
   soften rules 22/23 (spinoffs may go to BACKLOG again once deps gate claims); add the consolidation
   rule (fold meta evidence rows into the epic-final hardening task — `create_task` now warns on
   meta-titled duplicates). Net: 24 rails → ~18, ~20KB → ~14KB per `get_context`.
3. **One-shot backfill**: re-file the stale BLOCKED rows' referenced task ids into `blockedOnTaskIds`
   (`report_blocked` auto-parses `task-…` ids out of the reason on the next report; the sweep backstop
   then clears every row whose deps are all DONE).

---

## Claude Account Rotation Issues

Moe can run claude seats across several Claude subscription accounts. The accounts are managed in the Moe tool
window, **Accounts** tab, or with `node packages/moe-daemon/dist/index.js accounts …`; the rules are in
`docs/MCP_SERVER.md` (**Claude Account Rotation**). Wrapper lines below start with `[account]`.

### A worker ends its session with steps left: `ACCOUNT-SWITCH`

**Symptom:** a worker's `complete_step` reply carries `accountSwitch`, or `start_step` fails with `NOT_ALLOWED` and a
message starting `ACCOUNT-SWITCH:`. The session ends early, and the wrapper relaunches the same task with
`MOE_ACCOUNT_SWITCHED from=<a> to=<b>`. #governors gets a 🔁 post.

**Cause:** expected. The seat's account reached the switch point (default 90% of any usage window), hit its limit,
was signed out or was removed, and another signed-in account is free. Completed steps stay completed and the
refused step stays PENDING, so the new session starts the next step on the next account. A refused launch
(`MOE_ACCOUNT_REFUSED account=<id> exit=<n>`) is expected too: the wrapper relaunches on the next account at once,
with no back-off and no resume attempt spent.

**Fix:** none needed. To switch later, raise "Switch to the next account at" in the Accounts tab.

### An architect or governor session ends and restarts on its own

**Symptom:** an interactive claude seat (an architect or governor TUI) shows the toast
`Moe: Claude account <label> is at <n>% of its usage limit (Moe switches at <m>%). This session ends in 10 s and restarts
on the next account.` After that, the TUI exits by itself. The wrapper relaunches it with
`MOE_ACCOUNT_SWITCHED from=<a> to=<b>`, and #governors gets a 🔁 post. It happens:
- for an architect, right after a `submit_plan`;
- for a governor, at a `chat_wait`.

The toast reads `this Claude account reached its usage limit` instead when claude stopped the session at the limit
itself.

**Cause:** expected. The wrapper loads the `moe-account-switch` mod (`scripts/mods/`) into a claude TUI whose loop
relaunches it. The mod ends the session once the turn is over, after either of these:
- the daemon put `accountSwitch` in a `submit_plan` or `chat_wait` reply, for the same reasons as a worker's switch
  above;
- claude stopped at the usage limit (100%).

The architect's plan is recorded first. The governor's unread chat stays unread for the new session. A call the
model makes after the switch (a claim, another `chat_wait`) is refused, and its turn is ended.

**Fix:** none needed. To keep a TUI on one account until you exit it, set `MOE_DISABLE_ACCOUNT_SWITCH_MOD=1` for that
seat; it then moves at its next launch, as before. A `--no-loop`/`-NoLoop` or one-shot (`--print`) seat never loads
the mod. If `/exit` has not ended the session 60 s later (claude opens a `Background work is running` dialog over
running background work), the mod ends its own CLI; the session-ended line then shows `CLI exit=143` on Linux and
macOS. A seat left with the toast `Type /exit and Moe relaunches it.` means claude refused the mod's `/exit` (a person
pressed Esc) or the termination failed. Exit it by hand.

### An interactive seat will not launch: `MOE_ACCOUNT_UNTRUSTED`

**Symptom:** an interactive claude seat prints `[account] MOE_ACCOUNT_UNTRUSTED account=<id> project=<project> (<reason>) -
not launching into Claude's folder-trust dialog; retry in <n>s, the held task stays held.` and launches nothing.
#general gets one `@governors` line per account per lease loop, naming the account and the project, never the folder.
When Moe did set the trust it prints `MOE_ACCOUNT_TRUST_GRANTED account=<id> project=<project>` instead and launches;
an account that already trusts the project is quiet.

**Cause:** an interactive claude stops at "Do you trust the files in this folder?" until the launch directory is
trusted in the leased account's `.claude.json` (`claude -p` never asks). Before an interactive launch the wrapper helper
`scripts/moe-account-lease.mjs trust` sets `projects[<key>].hasTrustDialogAccepted` there. `MOE_ACCOUNT_UNTRUSTED` means
it could not, and `<reason>` is one of these:
- `no .claude.json in the account folder`
- `the account's .claude.json is not a regular file`
- `the account's .claude.json is over 16 MiB`
- `the account's .claude.json is not a JSON object`
- `the account's .claude.json is locked by another claude`
- `the account's .claude.json could not be rewritten`
- `the trust entry did not read back`
- `the launch directory is outside the project`

The seat does not launch into the dialog. It waits `MOE_ACCOUNT_RETRY_SEC` (default 300) with the task held, then leases
again. Headless `-p` seats never run this step.

**Fix:** start claude once in the project under that account (its folder is `claude-accounts/<id>` next to the account
list) and accept the trust dialog. The next lease finds the project trusted and launches.

### An architect session ends after it finds nothing to plan

**Symptom:** an interactive claude architect shows the toast `Moe: this seat holds no task. This session ends in 10 s
and the wrapper claims the next one.` and exits. The wrapper then prints `[no-task] No claimable task for role
architect; not launching a CLI without one` until a PLANNING task appears, and launches a fresh session for it.

**Cause:** expected. The wrapper claims the next task only once the CLI exits, and a TUI stays open after the model
stops, so a seat that ran out of work used to park until someone typed `/exit`. Where the wrapper's loop claims for
the seat (auto-claim on, not a governor), the `moe-account-switch` mod ends the session when a main turn ends with
the seat holding no task: a claim found nothing, the session planned `MOE_ARCHITECT_TASKS_PER_SESSION` tasks, or
the session only answered notifications. An interrupted turn (Esc) keeps the session. A claim made after the toast
is refused, so the task goes to the fresh session.

**Fix:** none needed. To keep such a TUI open, run the seat with `--no-auto-claim`, or set
`MOE_DISABLE_ACCOUNT_SWITCH_MOD=1`, which also stops its account switching. A codex, gemini or grok TUI has no mod:
exit it by hand.

### `MOE_ACCOUNT_WAIT retry_in=…`

**Symptom:** a claude seat prints `[account] MOE_ACCOUNT_WAIT retry_in=<s>s next_reset=<iso> - every signed-in
account is spent; …` and launches nothing. Its task stays held. #governors gets one ⏸️ post per episode.

**Cause:** every account signed in with a subscription is at the switch point, or Anthropic refused it at its limit.
The wrapper asks again at the earliest reset, and at least every `MOE_ACCOUNT_RETRY_SEC` seconds (default 300).

**Fix:** wait for the reset, or add and sign in another account. Raising the switch point frees accounts that only
Moe's threshold holds back, not ones Anthropic refused. Ctrl+C stops the seat; the task stays assigned to it until
the seat deregisters or the task is released.

### Seats launch without rotation: `MOE_ACCOUNT_LEASE_UNAVAILABLE` or `MOE_ACCOUNT_SKIPPED`

**Symptom:** `[account] MOE_ACCOUNT_LEASE_UNAVAILABLE (<why>) - launching without rotation.`, or a line starting
`MOE_ACCOUNT_SKIPPED:`. The seat runs on the default claude login (`~/.claude`), exactly as before rotation existed.

**Cause:**
- `LEASE_UNAVAILABLE`: the wrapper could not get an answer from `moe.lease_account` (daemon down or restarting, or a
  daemon older than the wrapper). Rotation never stops a launch.
- `SKIPPED: CLAUDE_CODE_USE_BEDROCK is set` (or `_VERTEX`, `_FOUNDRY`): claude then uses that cloud provider, not a
  claude.ai login.
- `SKIPPED: none of the N Claude accounts is signed in with a subscription …`: sign one in (next entry).
- `SKIPPED: the Claude account list cannot be used (…)`: see `MOE_ACCOUNT_REGISTRY_INVALID` below.

**Fix:** restart the daemon after updating Moe, and rebuild and reinstall the plugin so the wrapper and daemon match.
Unset the provider switch for claude seats that should rotate. `MOE_ACCOUNT_ROTATION=off` turns rotation off on purpose.

### Sign-in fails: `MOE_ACCOUNT_NOT_SUBSCRIPTION`, `MOE_ACCOUNT_LOGIN_FAILED`, `MOE_ACCOUNT_LOGOUT_FAILED`, `MOE_CLAUDE_NOT_FOUND`

**Symptom:** the terminal tab that **Sign in**, **Check sign-ins** or **Sign out** opened ends with one of these
tokens, and the account's Sign-in column does not read Subscription (or, after a sign-out, Signed out).

**Cause and fix:**
- `MOE_ACCOUNT_NOT_SUBSCRIPTION`: the login worked, but `claude auth status` reports a method other than `claude.ai`
  (a Console or API login). Moe never uses that account. Run **Sign in** again and choose the Claude subscription.
- `MOE_ACCOUNT_LOGIN_FAILED`: `claude auth login --claudeai` ended and the account is still signed out (browser closed,
  code not pasted, timeout). Run **Sign in** again.
- `MOE_ACCOUNT_LOGOUT_FAILED`: the account still reports a login after `claude auth logout`. **Sign out and remove**
  then keeps the account in the list. Run **Sign out** again.
- `MOE_CLAUDE_NOT_FOUND`: that terminal cannot run claude. Install Claude Code where the agents run (inside the WSL
  distro under "Run Agents in WSL") and put it on PATH, or set `MOE_CLAUDE_BIN`. The account's state is unchanged.

### `MOE_ACCOUNT_SIGNED_OUT account=<id> state=…`

**Symptom:** a seat prints it after claude exits with an error, then relaunches at once on the next account.
#governors gets a 🔑 post, and the account's Sign-in column reads Signed out or Not a subscription.

**Cause:** the wrapper checked the account's folder (`claude auth status`) after the failed run and found the login
gone (expired, revoked, or signed out elsewhere) or replaced by a non-subscription login. The daemon stops using
that account.

**Fix:** Accounts tab → select the account → **Sign in**.

### `MOE_ACCOUNT_REGISTRY_INVALID` or "account file error"

**Symptom:** the Accounts tab says "Moe cannot use the account file, so agents start without account rotation: …",
the header reads `account file error`, every `accounts` command exits with `MOE_ACCOUNT_REGISTRY_INVALID`, and seats
print `MOE_ACCOUNT_SKIPPED: the Claude account list cannot be used (…)`.

**Cause:** `~/.moe/claude-accounts.json` (or `MOE_ACCOUNTS_FILE`) is not valid JSON or breaks the schema in
`docs/SCHEMA.md` (**Claude Accounts**): an unknown key, a bad or duplicate id, more than 32 accounts, or
`switchAtPercent` outside 1–100. It is almost always a hand edit.

**Fix:** correct the field the message names. Prefer that to starting over: the logins live in
`~/.moe/claude-accounts/<id>`, which Moe never deletes, and a fresh list never reuses a folder that exists, so
re-added accounts get new ids (`acct-7`, …) and must sign in again.

### The Accounts tab shows no usage (`-`)

**Symptom:** an account is signed in and in use, but its 5-hour and Weekly columns stay `-`.

**Cause:** usage comes only from claude's own output in seats the Moe wrapper launched, and only after the seat's
first model response. A claude session started by hand reports nothing.

**Fix:** none while no seat has answered yet. If the columns stay empty after a seat has worked on the account,
claude's output format may have changed. Rotation then keeps using the current account (the safe fallback); file a
task with the wrapper's output.

---

## Local Runner Issues

`node scripts/local-runner/cli.mjs certify` ([CERTIFICATION.md](CERTIFICATION.md)) and the check runner fail closed with
one fixed code. A certify report names the failing check and its code, and every later check is `not-run`. A check run
reports `infra-failure` with the code as its `failure`, unless its row says otherwise.

| Code (where) | Cause | Fix |
|---|---|---|
| `PROVIDER_NOT_FOUND` (`prerequisites`, `doctor`) | Moe runs only the pinned Multipass client, never one on `PATH`: `%ProgramFiles%\Multipass\bin\multipass.exe`, `/snap/bin/multipass` or `/usr/local/bin/multipass`. It is not there, for example after a Windows install into another folder. | Reinstall Multipass 1.17.0 at the installer's default location, then re-run `prerequisites`. |
| `CERTIFY_PROVISION_UNAVAILABLE` (`provision`) | A host prerequisite is unmet. On Linux that includes the image cache, `<work-dir>/images`: the strictly confined Multipass snap reads only paths under your home directory with no hidden segment. | Run `node scripts/local-runner/cli.mjs prerequisites --cache-dir <work-dir>/images` and do each unmet item's `action` until it exits 0. On Linux, use a work dir under your home directory with no segment starting with `.`. |
| `IMAGE_PROVIDER_HASH_MISMATCH` (`provision`) | Windows only. After the launch of `release:<pin sha256>`, `multipass info` did not report the pin as the guest's `image_hash`, so Moe refused the guest before readiness. | Re-run certify: its teardown has already deleted the refused VM. Never launch `moe-vm-*` instances by hand, and never edit the pin. If it repeats, attach the report to the CQ-R13 row. |
| `PROVISION_TRANSPORT_UNAVAILABLE` (`provision`) | Moe opens every guest stream with the in-box OpenSSH client at a pinned path, never one on `PATH`: `%SystemRoot%\System32\OpenSSH\ssh.exe` on Windows, `/usr/bin/ssh` on Linux and macOS. That client is missing (or is not a regular file), so nothing was downloaded, reserved or launched. Check runs report this code as their failure too. | On Windows, add the optional feature "OpenSSH Client" (Settings > System > Optional features). On Linux, install the distro's `openssh-client` package. Then re-run. |
| `PROVISION_TRANSPORT_FAILED` (`provision`) | Moe could not write the new VM's client key or its pinned host-key line under `~/.moe/guest-ssh` (`%USERPROFILE%\.moe\guest-ssh`). It never writes through or over an existing file or link there. The VM stays owned until cleanup deletes it together with its two files; certify's teardown already has. Check runs report this code as their failure too. | Make sure that directory belongs to you and is writable, and that nothing outside Moe creates `moe-vm-*` entries in it. Then re-run. |
| `LIFECYCLE_RETRY_EXHAUSTED` (`provision`), on Windows | All three launches of `release:<pin sha256>` failed: there is no HTTPS route to cloud-images.ubuntu.com, the pin is no longer in the Ubuntu release stream, or the first 621 MB download is slower than the 15-minute launch window. | Check that cloud-images.ubuntu.com is reachable over HTTPS, then re-run once: Multipass keeps a finished download. Never fall back to a `file://` or URL launch. |
| `BOOTSTRAP_FAILED` (`readiness`) | cloud-init did not end in a clean `done`/`done`: an error, a `degraded` status (even one with only recoverable warnings), or a guest that stopped. Readiness accepts no degraded boot. | Re-run certify once. If a healthy host repeats it, the pinned user-data boots degraded on the pinned image: attach the report to the CQ-R13 row. Never loosen readiness locally. |
| `BOOTSTRAP_TIMEOUT` (`readiness`) | cloud-init was still running after 15 minutes. | Free host CPU and memory, then re-run. |
| `MOUNTS_PRESENT` (`readiness`), `TRANSFER_MOUNTS_PRESENT` (`no-mounts`) | The run's VM had a host-sharing mount (a Multipass mount, 9p, virtiofs, fuse, NFS or SMB). Moe never mounts. | Stop whatever runs `multipass mount` against `moe-vm-*` instances, then re-run. `MOUNTS_UNKNOWN` means the mount table was unreadable: re-run. |
| `CERTIFY_GUEST_NETWORK_REACHABLE` (`guest-network`) | A guest identity connected to the VM gateway, at the default daemon port 9876 or at certify's own loopback listener. The usual cause is a Moe daemon bound beyond loopback: `--host 0.0.0.0`, `MOE_BIND_HOST`, or WSL agent mode (`--host wsl`). | Stop that daemon, restart it on the default loopback bind (turn off "Run Agents in WSL" for the run), and re-run. If no daemon listens on 9876, a loopback-only listener was reachable from the guest: attach the report to the CQ-R13 row. |
| `DEPENDENCY_SOURCE_UNSUPPORTED`, `DEPENDENCY_INTEGRITY_INVALID` (a check's dependency phase) | A lockfile entry the guest must install lacks the canonical registry.npmjs.org tarball `resolved` URL or one canonical `sha512-` `integrity`: for example an entry with neither field, a link, or a git or `file:` source. The runner installs admitted registry tarballs only. | Regenerate the lockfile against registry.npmjs.org so every installed entry has both fields, then re-run the check. |
| `MOE_DEPENDENCY_CANDIDATE_INVALID` (a check's output tail: a `code-failure`, exit code 82) | The guest refused the candidate's own package files before any install: a lockfile directory's `package.json` is missing, linked, malformed or oversized, its install metadata differs from the lockfile's root entry, it sets `overrides`, bundled dependencies or `workspaces`, or an `npm-shrinkwrap.json` or `.npmrc` sits beside it. | Remove the `npm-shrinkwrap.json` or `.npmrc` and any overrides, bundling or workspaces, regenerate `package-lock.json` from that `package.json`, then re-run the check. |
| `MOE_RUNTIME_PROTECTED_PATH_MISSING` (`moe-agent.{sh,ps1}`, `moe-call.sh`) | `MOE_RUNTIME_PROTECTED=1`, which the JetBrains launcher sets for a protected seat, and the named variable (`MOE_PROXY_PATH` or `MOE_DAEMON_PATH`) is not an absolute path to an existing file. The scripts never fall back to another copy. | Reinstall or update the plugin so its bundled daemon and proxy exist, then relaunch the seat. A legacy seat refuses too when it inherits `MOE_RUNTIME_PROTECTED=1` from the IDE's or the shell's own environment: unset it there. |
| `MOE_PROTECTED_AGENT_COMMAND_REFUSED` (`moe-agent.{sh,ps1}`) | `MOE_RUNTIME_PROTECTED=1`, and the agent command is not exactly `claude`, `codex`, `gemini` or `grok` with no arguments. The protected runtime starts only these CLIs, by name. The line quotes the refused value (control characters as `?`, at most 200 characters). The JetBrains launcher refuses the same value earlier, in a dialog. | Set `agentCommand` (or the seat's command) to one of the four names, or run the seat under the legacy profile. |
| `MOE_PROTECTED_AGENT_CLI_NOT_FOUND` (`moe-agent.{sh,ps1}`) | `MOE_RUNTIME_PROTECTED=1`, and the named CLI is on no absolute PATH entry outside the project. A relative, `.` or in-project PATH entry never counts. | Install the CLI outside the project, put its directory on PATH as an absolute entry, then relaunch the seat. |
| `MOE_PROTECTED_INTERPRETER_NOT_FOUND` (`moe-agent.{sh,ps1}`) | `MOE_RUNTIME_PROTECTED=1`, and no trusted `node` (sh: also `python3`) is on an absolute PATH entry outside the project. sh also accepts an absolute `MOE_NODE_COMMAND`, or the managed runtime `~/.local/share/moe/node/current/bin/node`, when the file is named `node` and lies outside the project. | Install node (sh: and python3) outside the project and put it on PATH. With sh you can instead set `MOE_NODE_COMMAND` to node's absolute path. |

---

## Performance Issues

### Large activity.log slowing things down

**Symptom:** Daemon startup is slow, high memory usage.

**Solution:** The log rotator should handle this automatically. To manually rotate:
```bash
# Logs rotate automatically at 10MB
# Check current size
ls -lh .moe/activity.log

# View rotated logs
ls .moe/activity.log.*
```

To adjust rotation settings:
```bash
export LOG_MAX_SIZE_MB=5
export LOG_RETENTION_COUNT=3
```

---

### Too many tasks causing slowdown

**Symptom:** Board is slow to render, daemon uses high CPU.

**Solution:**
1. Archive completed epics
2. Delete old done tasks
3. Use pagination (if available)

---

### WebSocket reconnection storms

**Symptom:** Multiple rapid connect/disconnect messages.

**Solution:**
1. Check network stability
2. Increase reconnection delay in plugin settings
3. Restart both daemon and plugin

---

## Worktree Mode

### Worktree mode: flip on / roll back

With `settings.worktreeMode: 'on'`, every WORKING claim runs in its own `.worktrees/task-<id>` on branch
`moe/task/<id>`, and the wrapper lands it on the **target**: the literal `consolidationBranch`, else `main`. Both
switches below are stop-the-world and human-run (design: `docs/plans/2026-10-30-per-task-worktrees.md` §7.3, §7.4).
No Moe seat ever merges a `moe/work-*` branch into `main`: the only `main` move is the human-run migration landing.
Change settings through the daemon (the plugin's `UPDATE_SETTINGS`), never by editing `.moe/project.json` by hand.

**Readiness.** `node packages/moe-daemon/dist/index.js doctor --project <path>` is offline and read-only: it never
fetches, prunes, removes or writes Git or `.moe/` state. While `worktreeMode` resolves to `'on'` its `worktree …`
lines are hard checks (`[OK]`/`[FAIL]`, exit 1 on any fail). While it is `'off'` they are `[INFO]` and never change
the exit code.

| Line | Ready when |
|---|---|
| `worktree mode` | `project.json` is readable and `worktreeMode` is `'off'` or `'on'`. An unreadable file or another value is `[FAIL]` in either mode, never a silent `'off'`. |
| `worktree git version` | git is 2.38 or newer (`merge-tree --write-tree`). |
| `worktree project root` | The project is its repository's top level. |
| `worktree control branch` | The control checkout's HEAD is exactly `refs/heads/moe/control`. |
| `worktree target` | The target is an existing local branch that no worktree has checked out, the control checkout included. |
| `worktree quality gate` | `settings.qualityGate` is non-blank: every worktree landing runs it, whatever `qualityGateScope` says. Doctor never runs it. |
| `worktree stale task worktrees` | Soft `[WARN]` only: a registered `.worktrees/task-<id>` whose task is DONE or ARCHIVED and was last updated over 24 h ago (the cleanup is falling behind). Doctor removes nothing. |

**Flip on.**

1. **Drain.** Stop every seat once no task is WORKING or REVIEW with an open attempt. Let each REVIEW land and finalize first.
2. **Rescue refs.** `git for-each-ref refs/moe/rescue` must show no rescue ref of a live task still waiting for shared-mode recovery ([Recovering from `refs/moe/rescue/*`](#recovering-from-refsmoerescue)). Land or archive those tasks first.
3. **Settings.** Set a `qualityGate` if none is set, fast enough to run on every landing. Declare the land lease:
   `resources: { "git-land-main": { "capacity": 1, "maxLeaseMs": 7200000, "releaseOnDeregister": true } }`.
   The id is `git-land-<target>` with every character outside `[A-Za-z0-9._-]` made `-` (target `moe/work-2026-10-24` → `git-land-moe-work-2026-10-24`).
4. **Migration landing (the human-only merge step).** First `git merge-base --is-ancestor origin/main moe/work-2026-10-24` must hold (`main` instead of `origin/main` when there is no remote). If it does not, merge `main` **into the branch** (never into `main`) and check again. Then a human runs, from the control checkout:
   ```bash
   scripts/moe-agent.sh --project <path> --land-branch moe/work-2026-10-24
   ```
   ```powershell
   .\scripts\moe-agent.ps1 -Project <path> -LandBranch moe/work-2026-10-24
   ```
   It merges the branch onto the fetched `main` in an isolated tree, runs the `qualityGate` on exactly that tree in a `.moe`-free gate worktree, and publishes one two-parent merge commit by compare-and-swap (a non-forced push when there is a remote). It owns no task, so it takes no lease (the drain leaves no other lander), starts no daemon and records no ledger row. Exit 0 with `MOE_MIGRATION_LANDED` or `MOE_COMMIT_NOTHING_TO_COMMIT` means `main` contains the branch. Any other result stops the flip, with `main` untouched:

   | Code | Cause | Then |
   |---|---|---|
   | `MOE_MIGRATION_BAD_ARGS` (exit 2) | The branch is missing, is `main`, or is not a local branch. | Fix the argument. |
   | `MOE_MIGRATION_NO_GATE` | `qualityGate` is blank, or `MOE_DISABLE_QUALITY_GATE=1`. | Step 3, then re-run. |
   | `MOE_LAND_TARGET_CHECKED_OUT` | Some worktree has `main` checked out. | Switch it off `main`, then re-run. |
   | `MOE_LAND_FETCH_FAILED` | `git fetch origin main` failed 3 times. | Fix the network, then re-run. |
   | `MOE_LAND_TARGET_DIVERGED` | Local `main` holds commits `origin/main` lacks. | Find out where they came from. Never force-push or reset `main`. |
   | `MOE_COMMIT_FAILED_CONFLICT` | The merge conflicts in the listed paths. | Merge `main` into the branch, then re-run. |
   | `MOE_COMMIT_FAILED_GATE` | The merged tree failed the gate. | Fix it on the branch, then re-run. |
   | `MOE_PUSH_FAILED` | The remote refused the push, for example a review ruleset on `main`. | Fix the remote side, or use a branch target (below). |
   | `MOE_PUSH_OUTCOME_UNKNOWN` | The push outcome is unsettled; no local ref moved. | Re-run: it settles, ending in `MOE_COMMIT_NOTHING_TO_COMMIT` once `main` holds the branch. |
   | `MOE_COMMIT_FAILED_REF_CONTENTION` | `main` moved under both rounds. | Finish the drain, then re-run. |
   | `MOE_COMMIT_FAILED` | Not a git repository, or a git plumbing step failed. | Read the message. |
5. In the control checkout: `git switch -c moe/control main`. `main`'s tree is now the branch tip's, so the switch changes no file and the daemon's dirty `.moe/` files stay as they are.
6. **Settings:** `worktreeMode: 'on'` and `consolidationBranch: 'main'`. Optionally run `git config extensions.worktreeConfig true` in the control checkout, so the first seats do not race to set it. Run doctor; it must exit 0. Then relaunch the seats.

**A branch target instead of `main`.** When `main` stays PR-only and `consolidationBranch` names a branch that
already holds the work, skip step 4. Name the step 3 lease after that branch. In step 5, run
`git switch -c moe/control <branch>`. In step 6, keep `consolidationBranch: '<branch>'`. This project switched this
way on 2026-11-02, with `moe/work-2026-10-24`. The human keeps merging that branch into `main` by pull request.

**Roll back.**

1. Drain as above. Land every `moe/task/<id>` the target does not fully contain (preferred), or have a human merge it into the shared branch, never into `main`.
2. Set `worktreeMode: 'off'` and **unset** `consolidationBranch`. Left at `main`, it is `ensure_safe_branch`'s main-direct opt-in, and shared seats would commit on `main`.
3. In the control checkout, run `git switch -c moe/work-<date> main` with a branch name that does not exist yet. The peel reuses any non-default branch it finds, `moe/control` included. For a branch target, run `git switch <branch>` instead.
4. Run doctor, then relaunch the seats. A task still pinned to worktree mode stops with `MOE_WORKTREE_MODE_MISMATCH` and blocks for a human instead of losing bytes.

Keep the `.worktrees/task-*` checkouts (the wrapper creates them locked) and the `refs/moe/rescue/*` refs until every
task is recovered. The wrappers' worktree removal at DONE and its orphan sweep (WT-14) handle terminal tasks only
where your wrappers include them. Doctor's stale line lists the leftovers. Never remove the worktree of a task that is
not DONE or ARCHIVED, or one whose `moe/task/<id>` the target does not contain. Rollback never moves `main`.

---

## Diagnostic Commands

### Check daemon status

```bash
# Via CLI
node packages/moe-daemon/dist/index.js status --project /path

# Via HTTP (default port 9876 — actual port is in .moe/daemon.json)
curl http://localhost:9876/health
```

### View daemon logs

```bash
# Daemon logs to stdout by default
# For structured logs, set:
export LOG_LEVEL=debug
```

### Check .moe/ structure

```bash
# List all Moe files
find .moe -type f -name "*.json" | head -20

# Validate project.json
cat .moe/project.json | jq .
```

### Test WebSocket connection

```bash
# Using websocat (install separately)
websocat ws://localhost:9876/ws

# Send ping
{"type":"PING"}
```

### Check MCP proxy

```bash
# Test proxy responds
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | node packages/moe-proxy/dist/index.js
```

---

## Getting Help

If these solutions don't resolve your issue:

1. **Check existing issues:** [GitHub Issues](https://github.com/yaront1111/Moe-s-Tavern/issues)
2. **Open a new issue** with:
   - OS and version
   - Node.js version
   - IDE and version
   - Steps to reproduce
   - Relevant log output
3. **Join discussions:** [GitHub Discussions](https://github.com/yaront1111/Moe-s-Tavern/discussions)
