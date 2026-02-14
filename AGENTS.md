# AGENTS.md

This file provides guidance to Codex CLI when working with code in this repository.

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
JetBrains Plugin -- WS (/ws) --> Moe Daemon <-- WS (/mcp) -- moe-proxy <-- CLI (MCP stdio)
                                     |
                                     v
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

### Plugin to Daemon (`/ws`)
- **Server to Plugin**: `STATE_SNAPSHOT`, `TASK_UPDATED`, `TASK_CREATED`, `EPIC_UPDATED`, `EPIC_CREATED`
- **Plugin to Server**: `PING`, `GET_STATE`, `CREATE_TASK`, `UPDATE_TASK`, `REORDER_TASK`, `APPROVE_TASK`, `REJECT_TASK`, `REOPEN_TASK`

### MCP (`/mcp`)
MCP JSON-RPC 2.0. Tools: `moe.get_context`, `moe.submit_plan`, `moe.check_approval`, `moe.start_step`, `moe.complete_step`, `moe.complete_task`, `moe.report_blocked`, `moe.propose_rail`, `moe.list_tasks`, `moe.get_next_task`, `moe.claim_next_task`, `moe.create_task`, `moe.create_epic`, `moe.update_epic`, `moe.delete_epic`, `moe.delete_task`, `moe.set_task_status`, `moe.search_tasks`, `moe.qa_approve`, `moe.qa_reject`, `moe.init_project`, `moe.get_activity_log`, `moe.unblock_worker`, `moe.create_team`, `moe.join_team`, `moe.leave_team`, `moe.list_teams`

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

## Error Handling

- All daemon tool calls return structured JSON responses with success/error fields
- Handle MCP connection failures gracefully - the daemon may not be running
- Validate task status transitions before attempting them (e.g., only WORKING tasks can move to REVIEW)
- Check `hasNext` field in claim responses before proceeding

## Testing

- Test runner: `vitest` (for daemon and proxy packages)
- Run tests: `cd packages/moe-daemon && npx vitest run`
- Run specific test: `cd packages/moe-daemon && npx vitest run <test-file>`
- Always run tests before and after making changes to verify no regressions

## Moe Agent Workflow

You are a Moe agent. Your role-specific instructions are loaded separately via model instructions. This section covers the shared workflow all roles follow.

### Task Lifecycle
```
BACKLOG → PLANNING → AWAITING_APPROVAL → WORKING → REVIEW → DONE
```

### Core Tool Patterns

**Always start with context:**
```
moe.get_context { taskId: "task-xxx" }
```
Returns project rails, epic details, task description, Definition of Done, and implementation plan.

**Claim your next task:**
```
moe.claim_next_task { statuses: ["WORKING"], workerId: "worker-abc" }
```
Each role claims different statuses: architects claim PLANNING, workers claim WORKING, QA claims REVIEW.

**Track progress (workers):**
```
moe.start_step { taskId: "task-xxx", stepId: "step-1" }
// ... implement ...
moe.complete_step { taskId: "task-xxx", stepId: "step-1", modifiedFiles: ["src/foo.ts"], note: "Added validation" }
```

**Submit work:**
```
moe.complete_task { taskId: "task-xxx", summary: "Implemented feature X" }
```

Tool calls return structured JSON with success/error fields. Always check response before proceeding.

## Common Mistakes (Avoid These)

- **Never edit `.moe/` files directly** - The daemon is the sole writer. Use MCP tools to modify state.
- **Never skip `get_context`** - Always call it after claiming a task. It loads rails, DoD, and the implementation plan.
- **Never skip steps** - Workers must call `start_step` before working and `complete_step` when done.
- **Never use the wrong tools for your role** - Architects use `submit_plan`, workers use `start_step`/`complete_step`, QA uses `qa_approve`/`qa_reject`.
- **Never complete a task without satisfying all DoD items** - Check `definitionOfDone` in the task context.
- **Never ignore reopenReason** - If `reopenCount > 0`, read `rejectionDetails` and fix those specific issues first.

## Role Quick Reference

| Role | Claims Status | Key Tools | Output |
|------|---------------|-----------|--------|
| architect | PLANNING | `get_context`, `submit_plan`, `check_approval` | Implementation plan |
| worker | WORKING | `get_context`, `start_step`, `complete_step`, `complete_task` | Code changes |
| qa | REVIEW | `get_context`, `qa_approve`, `qa_reject` | Approval/rejection |

Your specific role and detailed instructions are provided in your model instructions file. Follow them precisely.

## Key Documentation

| Document | Purpose |
|----------|---------|
| `docs/SCHEMA.md` | Data schema (matches daemon types) |
| `docs/MCP_SERVER.md` | MCP tool contracts |
| `docs/ARCHITECTURE.md` | Full system architecture |
| `docs/DEVELOPMENT.md` | Extended build/run guide |
