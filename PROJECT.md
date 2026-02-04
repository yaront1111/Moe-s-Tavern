# Moe - JetBrains Plugin + Daemon

## Vision
Build a JetBrains IDE plugin that embeds a Jira-style board inside the IDE while using native IDE capabilities for terminal, file explorer, and editor. The plugin syncs tasks with the Moe daemon so any change in the board is reflected in the .moe data store (and vice versa) via MCP integration.

## Current State (MVP)
- moe-daemon (Node/TypeScript) manages .moe state, watches files, exposes WebSocket + MCP bridge.
- moe-proxy (Node/TypeScript) provides MCP stdio and forwards to the daemon WebSocket.
- moe-jetbrains (Kotlin/Swing) shows a 6-column board, supports drag/drop status changes, and task detail actions (approve/reject/reopen) via WebSocket.
- The plugin auto-initializes .moe if missing and can auto-start the daemon.
- Epic/task creation is currently manual (edit `.moe` JSON or use daemon APIs).

## Goals
- Jira-style board inside JetBrains (tool window).
- Native IDE UX for terminal + files + editor (no fake terminal).
- Single source of truth: .moe directory.
- Bidirectional sync: UI actions update .moe through the daemon; daemon broadcasts updates to UI.
- MCP-enabled task execution pipeline.

## Non-goals (Current)
- Standalone web app.
- Custom terminal or file explorer.
- External SaaS dependency for the board.

## Target IDEs
- Primary: JetBrains IDEs (IntelliJ Platform).
- Current testing focus: PyCharm and IntelliJ IDEA.

## Locked Decisions
- MCP lifecycle: daemon + stdio proxy (CLI points to proxy).
- Project routing: one daemon per project; port stored in .moe/daemon.json.
- Plugin UI: Swing-based tool window.

## Data + Sync
- Source of truth: .moe JSON files (project.json, epics/*.json, tasks/*.json, workers/*.json, proposals/*.json, activity.log).
- Moe daemon is the only writer of .moe state.
- Plugin is a client that sends actions to the daemon; the daemon writes files and broadcasts updates.
- CLI uses moe-proxy (stdio) which forwards MCP calls to the daemon.
- File watcher runs inside the daemon; plugin does not watch files.

## MCP + CLI Contract (Current)
- create/update/reorder tasks via daemon tools and WebSocket actions.
- AI submits plans via MCP and waits for human approval.
- activity.log is appended for every state change.

## UI Surface (Current)
- JetBrains Tool Window: "Moe".
- Views:
  - Board: six columns (Backlog, Planning, Awaiting Approval, Working, Review, Done).
  - Task detail dialog with approve/reject/reopen actions where applicable.

## Repo Layout (Current)
```
moe/
├── packages/
│   ├── moe-daemon/          # Core daemon (Node/TS)
│   └── moe-proxy/           # MCP stdio shim (Node/TS)
├── moe-jetbrains/           # JetBrains plugin (Kotlin)
├── docs/
├── installer/               # Windows installer assets
└── scripts/
```

## Definition of Done (MVP)
- Board state matches .moe state at all times.
- Drag/drop and edits update .moe and are visible in CLI immediately.
- No mock data anywhere.
