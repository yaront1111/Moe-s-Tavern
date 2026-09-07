# Troubleshooting Guide

Common issues and solutions for Moe's Tavern.

---

## Table of Contents

1. [Daemon Issues](#daemon-issues)
2. [Plugin Issues](#plugin-issues)
3. [MCP/Proxy Issues](#mcpproxy-issues)
4. [Task Sync Issues](#task-sync-issues)
5. [Performance Issues](#performance-issues)
6. [Diagnostic Commands](#diagnostic-commands)

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

**Solution:** Ensure Node.js 18+ is installed:
```bash
node --version  # Should be v18.x or higher
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

#### "RAIL_VIOLATION"

**Solution:** Ensure plan includes all required rail phrases. Check epic and task rails.

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

and the wrapper reports `[launch-failure] CLI exited 2 after 0s, before doing any work (streak N)`, backs
off (60 s, 120 s, … up to 15 min) and relaunches forever. The held task stays WORKING (correct — nothing
was lost, the checkpoint landed), but no code gets written.

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
  branch. Push by hand once the remote divergence is resolved — `pull --rebase` refuses in a tree with
  unstaged tracked changes, which is the normal state of a busy shared checkout, so the automatic retry
  usually fails. Visibility problem, not a loss.

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
**DENY** → **ASSERTED**/**TOOL** → **PEER** → baseline diff → **PLANNED** → **MEASURED** →
unattributed. The codes:

| Code | Meaning | What to do |
|---|---|---|
| `MOE_ATTR_EXCLUDED` | On the DENY list: `.moe/**` (except board records), `.mcp.json`, `.codex/**`, `.gemini/**`, `.grok/**`, `.claude/agents/**`, `.claude/settings.local.json`, untracked `.serena/**`, `.worktrees/**`, `.moe-worktree*`, `settings.attribution.exclude` | Nothing — these never belong in a task commit. |
| `MOE_ATTR_PEER_DECLARED(task-<peer>)` | Another nonterminal task declares this path, with no ASSERTED or TOOL scope here | Resolve which task owns the changes. Declaring the path on this task makes it contested while the peer declaration still applies; the declaration alone does not supply a TOOL witness. |
| `MOE_ATTR_CONTESTED_UNTOUCHED(task-<peer>)` | Asserted by this task **and** declared by another nonterminal task, without a supported TOOL witness from this session (default policy `skip-untouched`) | Keep the path held while the peer declaration applies. Coordinate the task ownership until that declaration no longer applies, or use an explicitly chosen project policy appropriate to the reviewed ownership arrangement. An extra edit does not prove ownership of existing hunks. |
| `MOE_ATTR_CONTESTED` | In this task's ASSERTED or TOOL scope **and** declared by another nonterminal task, with `settings.attribution.contested: "skip"` | Resolve ownership before choosing an applicable policy. An explicit `"commit"` permits whole-path landing with a `Moe-Contested: <path> (task-<peer>)` trailer; it does not establish ownership of the file's changes. |
| `MOE_ATTR_IMPORTEE_MISSING(<specifier>)` | A supported literal relative import has no matching path in the resulting commit. This checks path presence, including TypeScript source candidates for emitted module paths; it does not certify compiler or runtime validity | If this task owns the importee, declare it so both paths can pass attribution together; otherwise wait for its owner to land it; the path is re-attempted at the next exit and is reported as `MOE_ATTRIBUTION_UNRESOLVED` meanwhile. |
| `MOE_ATTR_PREEXISTING` | Dirty before this task's first session and byte-identical now — the hard constraint: a path the task never asserted and never changed is never committed | Nothing for this task. Debris left by a DONE task → "Dirty paths owned only by DONE tasks" below. |
| `MOE_ATTR_MISSING` | An asserted path exists neither on disk nor in HEAD (renamed / deleted / edited in a worktree), or is gitignored | Fix the path or the plan's `affectedFiles`. Deletions of tracked files stage naturally and never hit this. |
| `MOE_ATTR_CONCURRENT` | The staged blob no longer matched the snapshot — a peer wrote the file between the snapshot and `add` | Nothing — retried at the next exit. |
| `MOE_ATTRIBUTION_UNRESOLVED` | Changed since the baseline, not asserted, not planned, not tool-written, and `attribution.undeclared` forbade a MEASURED commit (default `solo` while another worker is live) | Persisted in `task.unattributedPaths` and shown to the resuming session. Claim it with `moe.declare_files { taskId, paths }` (governor or worker) so the next exit lands it — or set `attribution.undeclared: "always"` on a single-seat project. |

With `commitHooks: true`, `hooked-commit-config-mismatch` means the private commit context
resolved different signing or author settings. Landing is held as `MOE_COMMIT_FAILED` and
parked on a rescue ref before any commit hook or signing attempt. Review conditional Git
configuration so both contexts resolve the intended settings; do not disable required signing
to clear the refusal. Hooked completion on an unborn branch is also held until HEAD exists.

**Current witness limit:** only Claude one-shot `stream-json` editing events feed the wrapper's
per-session TOOL set today, after an editing call receives its matching successful
`tool_result`. Failed calls and calls without results supply no witness. Codex, Gemini, Grok
and interactive Claude can perform real edits without producing that witness. A dirty tree,
baseline difference, declaration,
`complete_step.modifiedFiles`, or historical task touch record cannot substitute for it.
Completed-step reports remain ASSERTED scope; they do not prove this session edited the path.
The default therefore keeps their contested paths held, even after the peer becomes idle or
its CLI exits, until its nonterminal task declaration no longer applies or an applicable
explicit policy permits landing. See [Session touch evidence](CONFIGURATION.md#session-touch-evidence).

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

### `qa_approve` returned `NO-COMPLETION-COMMIT`

**Symptom:** `warnings: ["NO-COMPLETION-COMMIT: task <id> has no completion commit recorded yet (the
wrapper lands it seconds after REVIEW) — verify task.commits / git log before merging"]` — also posted
to `#governors`. The approval still landed (DONE).

The warning is advisory. It fires when `settings.autoCommit` is on and no `task.commits` entry of kind
`completion` was recorded at or after `task.reviewStartedAt`. Causes, in order of likelihood:

1. **The race**: QA approved within seconds of REVIEW, before the worker's CLI exited and the wrapper
   ran `record_commit`. Re-check `task.commits` a minute later — the wrapper lands the completion
   commit with `Moe-Status: DONE` even after the approval.
2. The worker's landing was refused or failed — read `task.lastCommitOutcome` and the first section.
3. The fleet still runs an older installed wrapper that never calls `record_commit` (rebuild +
   reinstall, note below).

Policy for QA: treat the warning as a reject unless you verified HEAD yourself (`git show <sha>`); a
DONE task without a completion commit is a merge with no reviewed diff.

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
