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

The plugin can initialize `.moe/` automatically, or use the IDE action:
- `Tools → Moe → Initialize Moe`

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
./gradlew runIde     # launches a sandbox IDE
./gradlew buildPlugin
```

The plugin:
- Connects to `ws://127.0.0.1:<port>/ws`
- Auto-starts the daemon if `MOE_DAEMON_COMMAND` is set or an installer shim exists
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

- Daemon not running: start with `node packages/moe-daemon/dist/index.js start --project <path>`.
- Proxy says daemon not running: check `.moe/daemon.json` and port.
- Plugin shows "Disconnected": check daemon status and port in `.moe/daemon.json`.
- "Start Agents" says Terminal plugin not available: enable the **Terminal** plugin in `Settings > Plugins` and restart the IDE.

---

## Where to Look in Code

- Daemon: `packages/moe-daemon/src/`
- Proxy: `packages/moe-proxy/src/`
- Plugin: `moe-jetbrains/src/main/kotlin/com/moe/`
