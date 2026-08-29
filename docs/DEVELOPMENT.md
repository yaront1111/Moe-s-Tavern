# Moe - Development Guide (Current)

This guide describes how to build and run the current implementation in this repo.

---

## Prereqs

- Node.js 18+ (Node 20/24 also works)
- Java 17+ (for JetBrains plugin build/run)
- Git

---

## Build the Daemon + Proxy

```bash
cd packages/moe-daemon
npm install
npm run build

cd ../moe-proxy
npm install
npm run build
```

Windows helper (build + optional plugin install):
```powershell
.\scripts\install-all.ps1
```

---

## Initialize a Project

**Using the CLI (recommended):**
```bash
# Initialize current directory
node packages/moe-daemon/dist/index.js init

# Initialize a specific path
node packages/moe-daemon/dist/index.js init --project /path/to/project

# Specify a custom project name
node packages/moe-daemon/dist/index.js init --project /path/to/project --name "My Project"
```

`init` now starts the daemon and keeps running. Stop it with `Ctrl+C` or:
```bash
node packages/moe-daemon/dist/index.js stop --project /path/to/project
```

**Using the JetBrains plugin:**
- The plugin can initialize `.moe/` automatically when opening a project
- Or use the IDE action: `Tools → Moe → Initialize Moe`

**Using MCP (programmatic):**
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "moe.init_project",
    "arguments": {
      "projectPath": "/path/to/project",
      "name": "My Project"
    }
  }
}
```

Manual setup is also possible using the schema in `docs/SCHEMA.md`.

---

## Run the Daemon

```bash
node packages/moe-daemon/dist/index.js start --project <path>
```

Optional:
- `--port <port>` to force a port (otherwise 9876 + scan)

Other commands:
```bash
node packages/moe-daemon/dist/index.js status --project <path>
node packages/moe-daemon/dist/index.js stop --project <path>
```

The daemon writes `.moe/daemon.json` with `{ port, pid, startedAt, projectPath }`.

---

## Run the MCP Proxy

The proxy reads `.moe/daemon.json` and forwards MCP JSON-RPC over stdio.

```bash
node packages/moe-proxy/dist/index.js
```

Claude Code config example:
```json
{
  "moe": {
    "command": "moe-proxy",
    "env": {
      "MOE_PROJECT_PATH": "/path/to/project"
    }
  }
}
```

---

## Run the JetBrains Plugin

Open `moe-jetbrains` in IntelliJ/PyCharm and run one of:

```bash
cd packages/moe-daemon
npm run build

./gradlew runIde     # launches a sandbox IDE
./gradlew buildPlugin
```

The plugin:
- Connects to `ws://127.0.0.1:<port>/ws`
- Auto-starts the daemon (bundled with the plugin) or uses a local repo daemon if available
- Auto-initializes `.moe/` if missing

Notes:
- For local development in this repo, open the repo root (the folder containing `packages/`) so the plugin can auto-start the local daemon.
- If you install the plugin ZIP manually, extract it so the plugin folder contains `lib/` at the top level (e.g., `.../plugins/moe-jetbrains/lib`). If you end up with `.../plugins/moe-jetbrains/moe-jetbrains/lib`, PyCharm will not load the plugin.
- Gradle wrapper maintenance: the committed wrapper targets Gradle 8.10.2. Keep `moe-jetbrains/gradlew` with LF endings and `moe-jetbrains/gradlew.bat` with CRLF endings; `.gitattributes` enforces this. If the wrapper is regenerated, use Gradle's `wrapper --gradle-version 8.10.2 --distribution-type bin` flow from a trusted Gradle install/distribution, do not hand-edit the binary jar, and validate with `.\gradlew.bat test` on Windows plus `bash -lc 'cd moe-jetbrains && ./gradlew --version'` when bash is available.

---

## Seed Data for the UI

The current UI does not create epics or tasks yet. To see data in the board:
- Create epic and task JSON files under `.moe/epics/` and `.moe/tasks/`.
- Use the examples in `docs/SCHEMA.md` as templates.
- The daemon file watcher will load them and broadcast to the UI.

---

## Running Agents

The agent scripts handle daemon startup, MCP config, role documentation injection, and polling:

**Windows (PowerShell):**
```powershell
.\scripts\moe-agent.ps1 -Role architect -Project "C:\your\project"
.\scripts\moe-agent.ps1 -Role worker -ProjectName "MyProject"
.\scripts\moe-agent.ps1 -Role qa -Project "C:\your\project"
```

**Mac / Linux (Bash):**
```bash
./scripts/moe-agent.sh --role architect --project /your/project
./scripts/moe-agent.sh --role worker --project-name "MyProject"
./scripts/moe-agent.sh --role qa --project /your/project
```

Key flags:
- `-Role` / `--role`: `architect`, `worker`, or `qa`
- `-Project` / `--project`: Path to your project
- `-ProjectName` / `--project-name`: Look up project from `~/.moe/projects.json` registry
- `-Command` / `--command`: Agent CLI to run (`claude`, `codex`, `gemini`, or custom path)
- `-NoLoop` / `--no-loop`: Run once and exit (default: poll for new tasks every 30s)
- `-PollInterval` / `--poll-interval`: Seconds between polls (default: 30)
- `-ListProjects` / `--list-projects`: Show registered projects
- `-AutoClaim:$false` / `--no-auto-claim`: Don't auto-claim a task on start
- `-Team <name>` / `--team <name>`: Auto-create/join a team for parallel agent work

### Wrapper post-flight

`moe-agent.sh` and `moe-agent.ps1` run a post-flight block after each agent CLI exit; it is the fleet's only git actor (the daemon is state-only and never runs git). Both wrappers stay in lock-step — same helper names, reason codes, banners and settings keys — and `scripts/tests/parity-check.{sh,ps1}` fails on any asymmetry. In order:

1. **Status**: `get_context { taskId }` by exact id (a failed lookup is loud — `[WARN]` + `PUSH-BLOCKED: post-flight status lookup failed …` in `#general` — and still lands a checkpoint with `status=UNKNOWN`), plus the epic-final lookup for the gate.
2. **Mode**: `completion` for a worker at `REVIEW`/`DONE`; `checkpoint` for any other exit of a worker/architect/qa session that holds a task (`settings.checkpointCommits`, `MOE_DISABLE_CHECKPOINT`); `none` when `settings.autoCommit=false` (logged, never silent).
3. **Gate**: `settings.qualityGate` (epic-final by default) before a completion — failure → rescue ref `[reason=gate-failed]`, `PUSH-BLOCKED:` chat + comment tail, `break`.
4. **Branch**: `Ensure-MoeSafeBranch` / `ensure_safe_branch` — never `main`/`master`/detached/unborn; peel onto a literal `settings.consolidationBranch` else `moe/work-<yyyy-MM-dd>` — failure → rescue ref `[reason=peel-failed]`, `break` in both wrappers.
5. **Attribution**: `Resolve-MoeAttribution` / `resolve_attribution` joins the post-CLI dirty snapshot (`git status --porcelain=v1 -z --untracked-files=all --no-renames`, blobs via one `hash-object --stdin-paths`) with the persisted baseline `<gitdir>/moe/baseline/<taskId>.tsv` and `moe.get_commit_scope` → BOARD/ASSERTED/PLANNED/MEASURED candidates, `[skip] <path> MOE_ATTR_*` drops, `[attribution] <K> pre-session dirty path(s) untouched`, `MOE_ATTRIBUTION_UNRESOLVED` leftovers (§ "Attribution" in `docs/CONFIGURATION.md` → `autoCommit`).
6. **Landing**: `Invoke-MoeLanding` / `land_commit` — temp index `GITDIR/moe/idx-<taskId>-<pid>` (`GIT_INDEX_FILE` set per plumbing call only, removed in `finally`), `read-tree` old → `add -- :(literal)p` per candidate (staged blob verified against the snapshot, else `MOE_ATTR_CONCURRENT`) → `write-tree` → `commit-tree` → `update-ref refs/heads/<branch> new old` CAS, 3 attempts, then rescue ref `[reason=ref-contention]` + `MOE_COMMIT_FAILED_REF_CONTENTION`; afterwards `git reset -q -- :(literal)p` for exactly the landed paths (5×2s `index.lock` retry; `MOE_COMMIT_INDEX_REFRESH_FAILED` warn). Hooks only run with `settings.commitHooks=true`, and then only for completion commits (porcelain `git commit -- <specs>`, rescue `[reason=commit-failed]` on rejection).
7. **Push**: `Push-MoeBranch` / `push_branch` — completion as before (`-u` on first push, one `pull --rebase` retry, `rebase --abort` on conflict, `PUSH FAILED for task <id> — committed locally only; do not review until pushed`); checkpoints only when `settings.checkpointPush` (`CHECKPOINT-UNPUSHED task=<id>` on failure). Note `pull --rebase` refuses in a tree with unstaged tracked changes, so in a busy fleet the retry usually fails and the commit stays local — a visibility problem, never a loss.
8. **Record**: `sha = git log -n1 --grep="Moe-Session: <SID>" <branch>` (rebase-safe) → `moe.record_commit` for **every** outcome (committed/nothing/refused/failed), then the one-line session-ended `moe.chat_send` to `#general` carrying `commit=<sha|none> kind=<k> paths=<n> inferred=<m> unattributed=<u>`.

Every helper returns values instead of `break`/`continue`, every git call runs with `-C <toplevel>` (porcelain paths are toplevel-relative even under `git -C <subdir>`; `show-prefix` converts declared project-relative paths) and `GIT_TERMINAL_PROMPT=0`. Ctrl+C / SIGTERM run a best-effort teardown rescue (`Invoke-MoeTeardownRescue` / `teardown_rescue`: one snapshot, rescue ref `[reason=teardown]`, no push, idempotent) from the ps1 outer `finally` / bash `EXIT` trap **before** deregister — the ps1 `Console.CancelKeyPress` / `PowerShell.Exiting` handlers are inert on PowerShell 5.1. A console-window close, SIGKILL or OOM runs nothing; the persisted baseline makes the next pre-flight of that task (or the BLOCKED-hold / resume-cap idle paths) land a recovery checkpoint first (`MOE_CHECKPOINT_RECOVERED task=<id> sha=<sha>`). Pre-flight also lists lingering `refs/moe/rescue/<taskId>/*` (`[rescue] N rescue ref(s)`) into the agent's dynamic context, and injects the shared-checkout notice (K foreign dirty paths; never revert/stash/`git add -A` them; report every touched path in `complete_step.modifiedFiles`; BLOCKED is a wait state). End-of-session continuity is the agent's responsibility — it writes a Serena `task-<id>-handoff` memory before stopping (see `docs/MEMORY.md`). Post-flight RPC failures are logged as warnings and never block the next wrapper iteration.

Loop flags are now explicit on both platforms:
- Bash: `--loop` explicitly opts into polling loop mode; `--no-loop` forces one run and exit.
- PowerShell: `-Loop` explicitly opts into polling loop mode; `-NoLoop` forces one run and exit.
- Default behavior is preserved for back-compat: auto-claiming agents poll for new tasks when the poll interval is positive; interactive/no-loop modes stay single-shot. Passing both loop and no-loop flags is a usage error (exit 2).

Smoke tests:
```bash
# Mac / Linux / WSL bash path
bash scripts/tests/postflight.sh
```

```powershell
# Windows PowerShell path
pwsh -NoProfile -File scripts\tests\postflight.ps1
```

```bash
# Wrapper string parity (codes, chat/log prefixes, settings keys, env names) — .ps1 sibling for PowerShell
bash scripts/tests/parity-check.sh
```

Both smoke tests verify the same contract through a fake proxy (env knobs `FAKE_TASK_STATUS`, `FAKE_CLAIM_MODE=resume|blocked`, `FAKE_SIBLING_ORDER`, `FAKE_LIST_TASKS_TRUNCATED`, `FAKE_GET_CONTEXT_FAIL`, `FAKE_SCOPE_ASSERTED` / `FAKE_SCOPE_PLANNED` / `FAKE_SCOPE_PEER_DECLARED` / `FAKE_SCOPE_PEERS_ACTIVE` / `FAKE_SCOPE_ASSIGNED` for `get_commit_scope`, and a `<project>/.moe/record_commit.jsonl` ledger written by the fake `record_commit`): the session-ended message reaches `#general`; scenarios A–E (pathspec-only completion commits, the two `MOE_COMMIT_REFUSED_*` refusals, peer index entries surviving) stay green; and the landing scenarios F–X cover BLOCKED / WORKING / `role=architect` checkpoints, baseline-based `MOE_ATTR_PREEXISTING` skips, peer-declared and asserted-but-unchanged paths, tool-written files (stream-json fixture), `MOE_CHECKPOINT_RECOVERED` recovery of a lingering baseline, CAS retry via `MOE_POSTFLIGHT_TEST_HOOK_PRE_UPDATE_REF`, own-task-record staging, gate / peel / rejecting-hook failures landing in `refs/moe/rescue/task-postflight/*` with HEAD unchanged, unborn HEAD, `status=UNKNOWN`, and (bash only) `kill -INT` teardown. (The wrapper no longer writes a session-summary file — cross-session memory moved to the Serena MCP server, where the agent writes a `task-<id>-handoff` note before stopping.) They are self-contained and skip with exit 0 when an integration prerequisite such as a runnable Node.js is unavailable.

### Running a Team (Parallel Agents)

Launch a full team of agents (architect + worker + QA) working on the same epic:

**Windows (PowerShell):**
```powershell
.\scripts\moe-team.ps1 -Project "C:\your\project"
.\scripts\moe-team.ps1 -Project "C:\your\project" -NoQa       # Skip QA agent
.\scripts\moe-team.ps1 -Project "C:\your\project" -NoArchitect # Skip architect
```

**Mac / Linux (Bash):**
```bash
./scripts/moe-team.sh --project /your/project
./scripts/moe-team.sh --project /your/project --no-qa
./scripts/moe-team.sh --project /your/project --no-architect
```

Each agent runs in its own terminal window and claims tasks matching its role.

The script loads role-specific documentation from `.moe/roles/<role>.md` (project-level) with fallback to `docs/roles/<role>.md` (bundled with plugin or install).

---

## Plugin Bundling

The JetBrains plugin bundles everything needed to run agents:

```
moe-jetbrains/          (installed plugin directory)
├── lib/                # Plugin JARs
├── daemon/             # Bundled moe-daemon (dist + node_modules)
├── proxy/              # Bundled moe-proxy (dist + node_modules)
├── scripts/            # moe-agent.ps1, moe-agent.sh
└── docs/roles/         # Role documentation (architect.md, worker.md, qa.md)
```

The `build.gradle.kts` copies these from the repo during `prepareSandbox` and `buildPlugin`. When building from source, ensure daemon and proxy are built first:

```bash
cd packages/moe-daemon && npm install && npm run build
cd ../moe-proxy && npm install && npm run build
cd ../../moe-jetbrains && ./gradlew buildPlugin
```

---

## Current Feature Coverage

Implemented now:
- Board UI with 5 columns (Awaiting Approval displays in Planning)
- Drag/drop status change
- Task detail dialog (approve/reject/reopen)
- Daemon state manager + file watcher
- MCP tools: `get_context`, `submit_plan`, `check_approval`, `start_step`, `complete_step`, `complete_task`, `report_blocked`, `propose_rail`, `list_tasks`, `get_next_task`, `claim_next_task`, `search_tasks`, `qa_approve`, `qa_reject`, `create_task`, `create_epic`, `update_epic`, `delete_task`, `delete_epic`, `get_activity_log`, `unblock_worker` (seat-only; `resolveBlocks: true` clears the block), `set_task_status`, `get_commit_scope`, `record_commit`, `declare_files`

Not yet implemented (planned):
- Epic CRUD UI
- Task creation UI
- Worker status UI
- Notifications/settings/status bar

See `docs/PLUGIN_SPEC.md` and `docs/UI_SPEC.md` for the roadmap.

---

## Troubleshooting

### Common Issues

- **Daemon not running**: Start with `node packages/moe-daemon/dist/index.js start --project <path>`.
- **Proxy says daemon not running**: Check `.moe/daemon.json` and port.
- **Plugin shows "Disconnected"**: Check daemon status and port in `.moe/daemon.json`.
- **"Start Agents" says Terminal plugin not available**: Enable the **Terminal** plugin in `Settings > Plugins` and restart the IDE.

### Mac-Specific Issues

- **Permission denied on scripts**: Run `chmod +x scripts/*.sh`
- **python3 not found**: Install via `brew install python3`
- **Port 3141 in use**: Daemon will scan for next available port, check daemon.json for actual port
- **Apple Silicon vs Intel**: Both work identically; verify Node.js architecture with `node -p process.arch`

For detailed Mac setup and verification checklist, see [MAC_INSTALL.md](./MAC_INSTALL.md).

### WSL (Windows Subsystem for Linux) Issues

When running Moe in WSL:

**Path Conversion**
- Windows paths like `C:\Users\...` need conversion to `/mnt/c/Users/...`
- The `moe-agent.sh` script handles this automatically
- For manual commands, use the WSL path format

**Setup**
```bash
# Access Windows project from WSL
cd /mnt/c/Users/yourname/projects/myproject

# Or use wslpath to convert
wslpath -u "C:\Users\yourname\projects\myproject"
```

**Common WSL Issues**
- **Path not found**: Ensure you're using `/mnt/c/...` format, not `C:\...`
- **Permission denied**: Windows filesystem permissions may differ; try `chmod +x` on scripts
- **Node not found**: Install Node.js in WSL separately: `curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt-get install -y nodejs`
- **python3 not found**: `sudo apt-get install python3`
- **Daemon can't write files**: Check Windows file has write access from WSL

**Networking**
- WSL2 uses a different IP than Windows host
- Daemon runs on `127.0.0.1` which WSL can access
- If using Docker in WSL, ensure Docker Desktop WSL integration is enabled

**IDE Integration**
- When using JetBrains IDE on Windows with WSL projects:
  - Open project via `\\wsl$\Ubuntu\...` path in Windows
  - Or use Remote Development with WSL backend
  - The plugin connects to daemon via localhost (works across WSL/Windows boundary)

### General Troubleshooting

For comprehensive troubleshooting guide, see [TROUBLESHOOTING.md](./TROUBLESHOOTING.md).

---

## Where to Look in Code

- Daemon: `packages/moe-daemon/src/`
- Proxy: `packages/moe-proxy/src/`
- JetBrains Plugin: `moe-jetbrains/src/main/kotlin/com/moe/`
- VSCode Extension: `moe-vscode/src/`

---

## Shared Patterns Between IDE Plugins

Both the JetBrains plugin and VSCode extension share common architectural patterns for consistency and maintainability.

### Daemon Communication

Both plugins communicate with the daemon via WebSocket at `ws://host:port/ws`:

| Pattern | JetBrains (Kotlin) | VSCode (TypeScript) |
|---------|-------------------|---------------------|
| Client class | `MoeProjectService` | `MoeDaemonClient` |
| Connection mgmt | `connect()`, `disconnect()` | `connect()`, `disconnect()` |
| Auto-reconnect | Yes (5s delay) | Yes (5s delay) |
| Heartbeat | PING/PONG | PING/PONG |

### Message Protocol

Both use the same JSON message format:

```json
{ "type": "MESSAGE_TYPE", "payload": { ... } }
```

Inbound messages: `STATE_SNAPSHOT`, `TASK_UPDATED`, `TASK_CREATED`, `PONG`
Outbound messages: `GET_STATE`, `UPDATE_TASK`, `APPROVE_TASK`, `REJECT_TASK`, `REOPEN_TASK`, `PING`

### UI Components

| Component | JetBrains | VSCode |
|-----------|-----------|--------|
| Board view | `MoeToolWindowPanel` (Swing) | `BoardViewProvider` (Webview) |
| Status indicator | `MoeStatusBarWidget` | `ConnectionStatusBar` |
| Task detail | `TaskDetailDialog` (modal) | Quick pick + webview panel |
| State events | `MoeStateListener` interface | `EventEmitter` pattern |

### Activation

| Trigger | JetBrains | VSCode |
|---------|-----------|--------|
| Condition | Project opened | `workspaceContains:.moe`, `onView:moe.board`, `onCommand:moe.connect` |
| Auto-connect | On project open | On activation (configurable) |
| Config location | `MoeSettings` | `vscode.workspace.getConfiguration('moe')` |

### Code Reuse Opportunities

While the platforms differ (Kotlin/Swing vs TypeScript/Webview), these areas could share code if extracted:

1. **Type definitions**: Task, Epic, Step, StateSnapshot interfaces
2. **Message protocol constants**: Message types, status values
3. **Board layout logic**: Column order, status mapping
4. **Validation rules**: Status transitions, field requirements

Currently each plugin implements these independently for simplicity, but a shared TypeScript library could be extracted to `packages/moe-common/` if the codebase grows.

---

## Docker (Optional - Advanced)

> **Note:** Docker is NOT required to use Moe. Most users should use the native installation methods above. Docker is provided as an alternative for containerized deployments, CI/CD pipelines, or isolated testing environments.

Build and run using Docker:

```bash
# Build the image
cd packages/moe-daemon
docker build -t moe-daemon .

# Run with your project mounted
docker run -p 9876:9876 -v /path/to/project:/project moe-daemon
```

Or use docker-compose:

```bash
# From repo root
docker-compose up -d

# View logs
docker-compose logs -f moe-daemon

# Stop
docker-compose down
```

See [CONFIGURATION.md](./CONFIGURATION.md) for environment variables.
