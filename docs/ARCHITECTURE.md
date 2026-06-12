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

### 1) JetBrains Plugin (Kotlin)

```
moe-jetbrains/
├── src/main/kotlin/com/moe/
│   ├── actions/
│   │   └── InitMoeAction.kt
│   ├── listeners/
│   │   └── MoeProjectOpenListener.kt
│   ├── model/
│   │   └── Models.kt
│   ├── services/
│   │   └── MoeProjectService.kt
│   ├── toolwindow/
│   │   ├── MoeToolWindowFactory.kt
│   │   ├── MoeToolWindowPanel.kt
│   │   ├── TaskDetailDialog.kt
│   │   └── board/
│   │       ├── TaskCard.kt
│   │       └── TaskColumn.kt
│   └── util/
│       ├── MoeJson.kt
│       └── MoeProjectInitializer.kt
│
└── src/main/resources/META-INF/plugin.xml
```

Key behaviors:
- Connects to daemon WebSocket at `/ws` (port from `.moe/daemon.json`).
- Auto-initializes `.moe` on first connect if missing.
- Auto-starts daemon using bundled daemon (if present) or `MOE_DAEMON_COMMAND`/installer shims.
- UI is Swing-based; no JCEF/webview.

### 2) Moe Daemon (Node.js/TypeScript)

```
packages/moe-daemon/
├── src/index.ts                # CLI entry + supervisor (start/stop/status/_run)
├── src/server/
│   ├── McpAdapter.ts           # JSON-RPC handler for MCP
│   └── WebSocketServer.ts      # /ws and /mcp endpoints
├── src/state/
│   ├── StateManager.ts         # Loads/writes .moe, mutex-protected
│   └── FileWatcher.ts          # chokidar watch with debounce
├── src/tools/                  # MCP tools
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
- `TASK_UPDATED`
- `TASK_CREATED`
- `EPIC_UPDATED`
- `EPIC_CREATED`

Plugin → Server commands:
- `PING`
- `GET_STATE`
- `CREATE_TASK`
- `UPDATE_TASK`
- `REORDER_TASK`
- `APPROVE_TASK`
- `REJECT_TASK`
- `REOPEN_TASK`

### CLI ↔ Proxy ↔ Daemon (MCP)

MCP JSON-RPC 2.0 over stdio (proxy) → WebSocket `/mcp` (daemon).
See `docs/MCP_SERVER.md` for tool definitions.

---

## File System Layout (.moe)

```
.moe/
├── project.json
├── epics/
├── tasks/
├── workers/
├── proposals/
└── activity.log
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
