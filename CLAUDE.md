# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Moe is an AI Workforce Command Center - a JetBrains IDE plugin + daemon system for managing AI task execution with human oversight. The daemon manages `.moe/` state files, and clients (plugin, CLI) interact via WebSocket.

## Build Commands

### Daemon & Proxy (Node/TypeScript)
```bash
# Build daemon
cd packages/moe-daemon && npm install && npm run build

# Build proxy
cd packages/moe-proxy && npm install && npm run build

# Development with hot reload
cd packages/moe-daemon && npm run dev
```

### JetBrains Plugin (Kotlin)
```bash
cd moe-jetbrains
./gradlew runIde        # Launch sandbox IDE with plugin
./gradlew buildPlugin   # Build distributable zip
```

### Windows Full Install
```powershell
.\scripts\install-all.ps1
```

## Running the System

```bash
# Start daemon
node packages/moe-daemon/dist/index.js start --project <path>

# Check daemon status
node packages/moe-daemon/dist/index.js status --project <path>

# Stop daemon
node packages/moe-daemon/dist/index.js stop --project <path>

# Run proxy (for MCP/CLI usage)
node packages/moe-proxy/dist/index.js
```

## Architecture

```
JetBrains Plugin ── WS (/ws) ──▶ Moe Daemon ◀── WS (/mcp) ── moe-proxy ◀── CLI (MCP stdio)
                                     │
                                     ▼
                                  .moe/  (source of truth)
```

**Key principle**: The daemon is the **sole writer** of `.moe/` files. All clients send actions to the daemon; they never write files directly.

### Component Locations

| Component | Location | Language |
|-----------|----------|----------|
| Daemon | `packages/moe-daemon/src/` | TypeScript |
| Proxy | `packages/moe-proxy/src/` | TypeScript |
| Plugin | `moe-jetbrains/src/main/kotlin/com/moe/` | Kotlin |

### Daemon Internal Structure

- `src/index.ts` - CLI entry point (start/stop/status commands)
- `src/server/WebSocketServer.ts` - Serves `/ws` (plugin) and `/mcp` (proxy) endpoints
- `src/server/McpAdapter.ts` - JSON-RPC handler for MCP protocol
- `src/state/StateManager.ts` - Loads/writes `.moe/` files, maintains in-memory state
- `src/state/FileWatcher.ts` - chokidar-based file watching with debounce
- `src/tools/*.ts` - Individual MCP tool implementations
- `src/types/schema.ts` - Canonical TypeScript types matching SCHEMA.md

### Plugin Internal Structure

- `services/MoeProjectService.kt` - WebSocket connection, state management
- `toolwindow/MoeToolWindowPanel.kt` - Main board UI with 6 columns
- `toolwindow/board/TaskCard.kt` & `TaskColumn.kt` - Kanban components
- `toolwindow/TaskDetailDialog.kt` - Task detail with approve/reject/reopen
- `util/MoeProjectInitializer.kt` - Creates `.moe/` folder structure
- `listeners/MoeProjectOpenListener.kt` - Auto-connects on project open

## WebSocket Protocols

### Plugin ↔ Daemon (`/ws`)
- **Server → Plugin**: `STATE_SNAPSHOT`, `TASK_UPDATED`, `TASK_CREATED`, `EPIC_UPDATED`, `EPIC_CREATED`
- **Plugin → Server**: `PING`, `GET_STATE`, `CREATE_TASK`, `UPDATE_TASK`, `REORDER_TASK`, `APPROVE_TASK`, `REJECT_TASK`, `REOPEN_TASK`

### MCP (`/mcp`)
MCP JSON-RPC 2.0. Tools: `moe.get_context`, `moe.submit_plan`, `moe.check_approval`, `moe.start_step`, `moe.complete_step`, `moe.complete_task`, `moe.report_blocked`, `moe.propose_rail`, `moe.list_tasks`, `moe.get_next_task`

## Data Files

```
.moe/
├── project.json     # Project metadata
├── daemon.json      # Runtime: { port, pid, startedAt, projectPath }
├── epics/*.json     # Epic definitions
├── tasks/*.json     # Task definitions with status, plan, steps
├── workers/*.json   # Worker registrations
├── proposals/*.json # Pending proposals
└── activity.log     # Append-only event log
```

## Key Documentation

| Document | Purpose |
|----------|---------|
| `docs/SCHEMA.md` | Data schema (matches daemon types) |
| `docs/MCP_SERVER.md` | MCP tool contracts |
| `docs/ARCHITECTURE.md` | Full system architecture |
| `docs/DEVELOPMENT.md` | Extended build/run guide |
