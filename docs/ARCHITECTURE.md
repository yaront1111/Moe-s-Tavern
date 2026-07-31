# Moe - Technical Architecture (Current)

## System Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              DEVELOPER MACHINE                               │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                     JETBRAINS IDE (Plugin)                           │   │
│  │  ┌─────────────────────────────────────────────────────────────┐     │   │
│  │  │   Moe Tool Window (Swing)                                    │     │   │
│  │  │   - 5-column board                                           │     │   │
│  │  │   - drag/drop status                                         │     │   │
│  │  │   - task detail dialog (approve/reject/reopen)               │     │   │
│  │  └─────────────────────────────────────────────────────────────┘     │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                    │ WebSocket (/ws)                       │
│                                    ▼                                        │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                      SUPERVISOR (Auto-restart)                      │   │
│  │   Spawns daemon, restarts on crash (exponential backoff 1s-30s)     │   │
│  │   Max 5 restarts per 60s window. Signal forwarding.                 │   │
│  ├─────────────────────────────────────────────────────────────────────┤   │
│  │                         MOE DAEMON (Node.js)                        │   │
│  │                                                                     │   │
│  │   Interfaces:                     State:                            │   │
│  │   - WebSocket (/ws)               - StateManager (loads .moe/)       │   │
│  │   - WebSocket (/mcp)              - MentionRouter (chat @mentions)   │   │
│  │   - HTTP (/health)                - FileWatcher (watches .moe/)      │   │
│  │                                                                     │   │
│  │   Cross-session memory is delegated to the Serena MCP server.       │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                    │                                        │
│                                    ▼                                        │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                      .moe/ FOLDER (Source of Truth)                 │   │
│  │   project.json  epics/*.json  tasks/*.json  workers/*.json          │   │
│  │   channels/*.json  messages/*.jsonl  proposals/*.json  activity.log │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                    ▲                                        │
│                                    │ WebSocket (/mcp)                       │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                      moe-proxy (MCP stdio)                          │   │
│  │   MCP JSON-RPC over stdio ↔ WebSocket to daemon                      │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Component Architecture

### 1) JetBrains Plugin (Kotlin) — primary IDE

Swing tool window: epic-grouped 5-column board, task/epic/plan dialogs, chat / metrics / activity / worker / proposal panels, settings dialog, IDE notifications, and a terminal agent launcher (incl. WSL mode). Full class inventory: `docs/PLUGIN_SPEC.md`.

Key behaviors:
- Connects to daemon WebSocket at `/ws` (port from `.moe/daemon.json`).
- Auto-initializes `.moe` on first connect if missing; force-syncs bundled role docs/skills.
- Auto-starts the bundled daemon (or `MOE_DAEMON_COMMAND`/installer shims); kills it on close if it is the last project using that PID.
- UI is Swing-based; no JCEF/webview.

A VS Code / Antigravity extension (`moe-vscode/`) is a secondary client speaking the same `/ws` protocol.

### 2) Moe Daemon (Node.js/TypeScript)

```
packages/moe-daemon/
├── src/index.ts                # CLI entry + supervisor (start/stop/status/doctor/_run)
├── src/commands/               # doctor (offline health check)
├── src/server/
│   ├── McpAdapter.ts           # JSON-RPC handler for MCP
│   └── WebSocketServer.ts      # /ws and /mcp endpoints
├── src/state/
│   ├── StateManager.ts         # Loads/writes .moe, mutex-protected (+ extracted modules)
│   ├── FileWatcher.ts          # chokidar watch with debounce
│   └── backfills/              # idempotent start-time backfills (e.g. task metrics)
├── src/migrations/             # project.json schemaVersion migrations
├── src/tools/                  # MCP tools (registry: tools/index.ts getTools())
├── src/util/                   # shared helpers + generated initFiles/skillFiles
└── src/types/schema.ts         # Canonical types
```

Key behaviors:
- **Supervisor**: `start` spawns daemon as child process with auto-restart (exponential backoff, max 5 restarts/60s).
- **Port selection**: Picks an available port (default 9876, scans a range of 50) and writes `.moe/daemon.json`.
- **Cross-session memory**: Not handled by the daemon — delegated to the Serena MCP server (injected by the agent launchers). See `docs/MEMORY.md`.
- Watches `.moe` for changes and broadcasts state snapshots.
- Handles plugin actions (create/update/reorder/approve/reject/reopen).

### 3) Moe Proxy (Node.js/TypeScript)

```
packages/moe-proxy/
└── src/index.ts                # MCP stdio → WebSocket bridge
```

Key behaviors:
- Reads `.moe/daemon.json` to discover port.
- Forwards newline-delimited MCP JSON-RPC from stdin to daemon `/mcp`.

---

## Communication Protocols

### Plugin ↔ Daemon (WebSocket /ws)

Server → Plugin events:
- `STATE_SNAPSHOT`
- `TASK_CREATED` / `TASK_UPDATED` / `TASK_DELETED`
- `EPIC_CREATED` / `EPIC_UPDATED` / `EPIC_DELETED`
- `WORKER_CREATED` / `WORKER_UPDATED` / `WORKER_DELETED`
- `PROPOSAL_CREATED` / `PROPOSAL_UPDATED` / `PROPOSAL_DELETED`
- `METRICS`, `ACTIVITY_LOG`

Plugin → Server commands:
- `PING`, `GET_STATE`
- `CREATE_TASK` / `UPDATE_TASK` / `DELETE_TASK` / `REORDER_TASK`
- `CREATE_EPIC` / `UPDATE_EPIC` / `DELETE_EPIC`
- `APPROVE_TASK` / `REJECT_TASK` / `REOPEN_TASK`
- `APPROVE_PROPOSAL` / `REJECT_PROPOSAL`, `APPROVE_DECISION` / `REJECT_DECISION`
- `UPDATE_SETTINGS`

### CLI ↔ Proxy ↔ Daemon (MCP)

MCP JSON-RPC 2.0 over stdio (proxy) → WebSocket `/mcp` (daemon).
See `docs/MCP_SERVER.md` for tool definitions.

---

## File System Layout (.moe)

```
.moe/
├── project.json       # settings + rails (tracked)
├── daemon.json        # runtime port/pid (gitignored)
├── activity.log       # event log + rotations (gitignored)
├── epics/  tasks/  proposals/            # tracked task-state
├── workers/  teams/  messages/  memory/  # runtime (gitignored)
├── channels/  decisions/
├── roles/             # role guides (sha-stamped, auto-upgraded)
├── agents/            # Claude Code subagent defs (mirrored to .claude/agents/)
└── skills/            # vendored skill pack
```

The daemon is the only writer; all clients send actions to the daemon.

---

## Data Flow Examples

### Task Status Change (Plugin Drag/Drop)

1. User drags a task card between columns.
2. Plugin sends `UPDATE_TASK` with new `status` and `order`.
3. Daemon writes task file and appends activity log.
4. Daemon broadcasts `TASK_UPDATED`.
5. Plugin updates UI state.

### Plan Approval (Plugin)

1. AI submits plan via MCP tool `moe.submit_plan` (status → AWAITING_APPROVAL).
2. Plugin opens task detail dialog.
3. User clicks Approve.
4. Plugin sends `APPROVE_TASK`.
5. Daemon updates task status → WORKING and broadcasts.

---

## Error Handling (Current)

- Missing `.moe` → plugin initializes or daemon throws on start.
- Invalid JSON files → daemon ignores invalid entities during load.
- WebSocket disconnects → plugin shows status in header.

---

## Performance Notes

- File watcher debounces writes (chokidar awaitWriteFinish).
- State snapshots are full state; diffs are per-event only for updates.
