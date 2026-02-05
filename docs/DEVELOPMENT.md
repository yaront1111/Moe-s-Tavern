# Moe - Development Guide (Current)

This guide describes how to build and run the current implementation in this repo.

---

## Prereqs

- Node.js 18+ (Node 20/24 also works)
- Java 17+ (for JetBrains plugin build/run)
- Git

---

## Quick Install (Mac)

If you just want to use Moe without building from source:

```bash
brew tap yaront1111/moe
brew install moe
```

This installs `moe-daemon` and `moe-proxy` globally.

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

## Run with Docker

Build and run using Docker:

```bash
# Build the image
cd packages/moe-daemon
docker build -t moe-daemon .

# Run with your project mounted
docker run -p 3141:3141 -v /path/to/project:/project moe-daemon
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

See [CONFIGURATION.md](./CONFIGURATION.md#docker) for environment variables.

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

---

## Seed Data for the UI

The current UI does not create epics or tasks yet. To see data in the board:
- Create epic and task JSON files under `.moe/epics/` and `.moe/tasks/`.
- Use the examples in `docs/SCHEMA.md` as templates.
- The daemon file watcher will load them and broadcast to the UI.

---

## Current Feature Coverage

Implemented now:
- Board UI with 6 columns
- Drag/drop status change
- Task detail dialog (approve/reject/reopen)
- Daemon state manager + file watcher
- MCP tools: `get_context`, `submit_plan`, `check_approval`, `start_step`, `complete_step`, `complete_task`, `report_blocked`, `propose_rail`, `list_tasks`, `get_next_task`

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
