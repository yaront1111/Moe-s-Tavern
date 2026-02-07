# Moe - MCP Server Specification (Current)

## Overview

The Moe MCP interface is served by the **moe-daemon** and exposed to AI CLIs via the **moe-proxy** stdio shim.

Flow:
```
AI CLI (MCP over stdio) → moe-proxy → WebSocket /mcp → moe-daemon
```

**Source of truth rule:** AI CLIs must read tasks from Moe and write all progress/status updates back to Moe via MCP tools.

---

## Server Configuration

### MCP Config (Claude Code example)

**File:** `~/.config/claude/mcp_servers.json`

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

### Project Registry

Moe keeps a local project registry for quick switching:

**File:** `~/.moe/projects.json`

This registry is updated when you open a Moe project in the JetBrains plugin.

---

### Environment Variables

| Variable | Used By | Description |
|----------|---------|-------------|
| `MOE_PROJECT_PATH` | daemon + proxy | Project root (daemon defaults to cwd; proxy uses this to locate `.moe/daemon.json`) |
| `MOE_TASK_ID` | daemon | Optional default task for `moe.get_context` |
| `MOE_WORKER_ID` | daemon | Optional fallback worker for `moe.get_context` |
| `LOG_LEVEL` | daemon | Logging level: `debug`, `info` (default), `warn`, `error`, `fatal` |

For a complete list of environment variables, project settings, and platform-specific examples, see [CONFIGURATION.md](./CONFIGURATION.md).

---

## Agent Wrapper (Windows)

Use the PowerShell wrapper to run a role-based CLI agent:

```powershell
.\scripts\moe-agent.ps1 -Role architect -Project "D:\path\to\project"
.\scripts\moe-agent.ps1 -Role worker -ProjectName "MyProject"
.\scripts\moe-agent.ps1 -Role qa -ListProjects
.\scripts\moe-agent.ps1 -Role architect -Project "D:\path\to\project" -AutoClaim:$false
```

Notes:
- `-AutoClaim` is on by default and sends an initial prompt to claim the next task for the role.
- Disable with `-AutoClaim:$false`.

### Daemon Lifecycle

Start the daemon before using the proxy:

```bash
moe-daemon start --project /path/to/project
```

Optional:
- `--port <port>` to force a port (otherwise 9876 + scan).

The daemon writes `.moe/daemon.json` with `{ port, pid, startedAt, projectPath }`. The proxy reads this file to locate the daemon.

---

## MCP Protocol Notes

- The daemon implements JSON-RPC 2.0 `tools/list` and `tools/call`.
- Tool results are returned as `content: [{ type: "text", text: "<json>" }]`.
- Errors are JSON-RPC errors with `code: -32000` and `message` set to the error string.
- Rails violations include details in `error.data`.

---

## Tools (Implemented)

### moe.get_context

Get current project/epic/task context and rails.

**Parameters:**
```typescript
{ taskId?: string }
```

**Resolution order:**
1. `taskId` param
2. `MOE_TASK_ID` env
3. `MOE_WORKER_ID` env (uses worker.currentTaskId)

**Returns:**
```typescript
{
  project: { id, name, globalRails, settings },
  epic: { id, title, description, architectureNotes, epicRails } | null,
  task: { id, title, description, definitionOfDone, taskRails, status, implementationPlan } | null,
  worker: null,
  allRails: {
    global: string[], // currently project.globalRails.requiredPatterns
    epic: string[],
    task: string[]
  }
}
```

---

### moe.submit_plan

Submit an implementation plan. Sets task status to `AWAITING_APPROVAL`.

**Parameters:**
```typescript
{
  taskId: string,
  steps: { description: string; affectedFiles?: string[] }[]
}
```

**Notes:**
- **Enforced rails:** Only `forbiddenPatterns` and global `requiredPatterns` are strictly enforced.
- **Guidance rails:** `epicRails` and `taskRails` are provided as guidance to AI agents but are NOT enforced in plan text. This allows agents to address the intent of rails without requiring verbatim quoting. Humans verify compliance during plan approval.
- On violation, returns JSON-RPC error with `message: "RAIL_VIOLATION"` and `error.data` set to the violation string.

**Returns:**
```typescript
{ success: true, taskId, status: "AWAITING_APPROVAL", stepCount, message }
```

---

### moe.check_approval

Check if a plan was approved.

**Parameters:**
```typescript
{ taskId: string }
```

**Returns:**
```typescript
{
  taskId,
  approved: boolean,   // true when status is WORKING
  status,
  rejected?: boolean,  // true when status is PLANNING and reopenReason is set
  rejectionReason?: string
}
```

---

### moe.start_step

Mark a step as `IN_PROGRESS` and set task status to `WORKING`.

**Parameters:**
```typescript
{ taskId: string, stepId: string }
```

**Returns:**
```typescript
{ success: true, taskId, stepId, stepNumber, totalSteps }
```

---

### moe.complete_step

Mark a step as `COMPLETED`.

**Parameters:**
```typescript
{ taskId: string, stepId: string, modifiedFiles?: string[], note?: string }
```

**Returns:**
```typescript
{
  success: true,
  taskId,
  stepId,
  progress: { completed, total, percentage },
  nextStep: { stepId, description } | null
}
```

---

### moe.complete_task

Mark a task as `REVIEW` (complete) and optionally attach a PR link.

**Parameters:**
```typescript
{ taskId: string, prLink?: string, summary?: string }
```

**Returns:**
```typescript
{ success: true, taskId, status: "REVIEW", stats: { stepsCompleted, filesModified, duration } }
```

---

### moe.report_blocked

Report a worker as blocked on a task.

**Parameters:**
```typescript
{ taskId: string, reason: string, needsFrom?: string, currentStepId?: string }
```

**Notes:**
- Updates the assigned worker status to `BLOCKED` (task status is not changed).

**Returns:**
```typescript
{ success: true, taskId, status: "BLOCKED", message }
```

---

### moe.propose_rail

Create a rail change proposal and store it in `.moe/proposals/`.

**Parameters:**
```typescript
{
  taskId: string,
  proposalType: "ADD_RAIL" | "MODIFY_RAIL" | "REMOVE_RAIL",
  targetScope: "GLOBAL" | "EPIC" | "TASK",
  currentValue?: string,
  proposedValue: string,
  reason: string
}
```

**Returns:**
```typescript
{ success: true, proposalId, status: "PENDING", message }
```

---

### moe.list_tasks

List tasks for an epic (optionally filtered by status).

**Parameters:**
```typescript
{ epicId?: string, status?: string[] }
```

**Returns:**
```typescript
{
  epicId: string | null,
  epicTitle: string | null,
  tasks: { id, title, status, order, hasWorker }[],
  counts: { backlog, inProgress, review, done }
}
```

**Note:** counts only include WORKING for `inProgress`.

---

### moe.search_tasks

Search tasks by query and filters with relevance ranking.

**Parameters:**
```typescript
{
  query?: string,           // Search query (searches title and description)
  filters?: {
    status?: string,        // Filter by task status
    epicId?: string,        // Filter by epic ID
    assignedWorkerId?: string  // Filter by assigned worker ID
  },
  limit?: number            // Maximum results (default: 20)
}
```

**Returns:**
```typescript
{
  tasks: Task[],            // Matching tasks (full task objects)
  totalMatches: number,     // Number of results returned
  query: string | null,     // The search query used
  filters: object           // Filters that were applied
}
```

**Notes:**
- Title matches are weighted 2x higher than description matches
- Results are sorted by relevance score (highest first)
- Filters are applied before search query
- If no query is provided, returns filtered tasks up to limit

---

### moe.get_next_task

Return the next BACKLOG task by order.

**Parameters:**
```typescript
{ epicId?: string }
```

**Returns:**
```typescript
{ hasNext: boolean, task?: { id, title, description, definitionOfDone } }
```

---

### moe.claim_next_task

Claim the next task by status (optionally filtered by epic). Assigns `assignedWorkerId` if provided.

**Parameters:**
```typescript
{
  statuses: string[],
  epicId?: string,
  workerId?: string,
  replaceExisting?: boolean  // Take over from existing worker
}
```

**Returns:**
```typescript
{
  hasNext: boolean,
  project?: { id, name, globalRails, settings },
  epic?: { id, title, description, architectureNotes, epicRails } | null,
  task?: { id, epicId, title, description, definitionOfDone, taskRails, status, assignedWorkerId, implementationPlan },
  allRails?: { global: string[], epic: string[], task: string[] }
}
```

**Worker Constraint:**
Only one worker can work on tasks of the same status type per epic at a time:
- Architects (PLANNING) and workers (WORKING) can work in parallel on the same epic
- Two workers cannot both claim WORKING tasks in the same epic
- Use `replaceExisting: true` to take over from an existing worker

**Errors:**
- `Epic already has an active worker on <status> tasks: <workerId>` - if another worker is active

---

### moe.set_task_status

Set task status (optionally with a reopen reason).

**Parameters:**
```typescript
{ taskId: string, status: string, reason?: string }
```

**Returns:**
```typescript
{ success: true, taskId, status }
```

---

### moe.create_task

Create a new task in an epic.

**Parameters:**
```typescript
{
  epicId: string,
  title: string,
  description?: string,
  definitionOfDone?: string[],
  taskRails?: string[],
  status?: string,
  parentTaskId?: string,
  order?: number,
  createdBy?: "HUMAN" | "WORKER"
}
```

**Returns:**
```typescript
{ success: true, task }
```

---

### moe.create_epic

Create a new epic.

**Parameters:**
```typescript
{
  title: string,
  description?: string,
  architectureNotes?: string,
  epicRails?: string[],
  status?: string,
  order?: number
}
```

**Returns:**
```typescript
{ success: true, epic }
```

---

### moe.update_epic

Update an existing epic.

**Parameters:**
```typescript
{
  epicId: string,               // Required
  title?: string,
  description?: string,
  architectureNotes?: string,
  epicRails?: string[],
  status?: "ACTIVE" | "COMPLETED" | "ARCHIVED",
  order?: number
}
```

**Returns:**
```typescript
{ success: true, epic }
```

**Errors:**
- `epicId is required` - if epicId parameter is missing
- `Epic not found: <epicId>` - if epic does not exist

---

### moe.delete_task

Delete a task by ID.

**Parameters:**
```typescript
{ taskId: string }
```

**Returns:**
```typescript
{ success: true, task }
```

**Errors:**
- `taskId is required` - if taskId parameter is missing
- `Task not found: <taskId>` - if task does not exist

---

### moe.delete_epic

Delete an epic and optionally its tasks.

**Parameters:**
```typescript
{
  epicId: string,
  cascadeDelete?: boolean  // If true, delete all tasks in epic. Default: false
}
```

**Returns:**
```typescript
{
  success: true,
  deletedEpic: Epic,
  deletedTaskCount: number
}
```

**Notes:**
- By default, fails if epic has tasks (use `cascadeDelete: true` to delete anyway)
- When cascading, deletes all tasks in the epic before deleting the epic

**Errors:**
- `epicId is required` - if epicId parameter is missing
- `Epic not found: <epicId>` - if epic does not exist
- `Epic "<epicId>" has N task(s)...` - if epic has tasks and cascadeDelete is false

---

### moe.get_activity_log

Query the activity log for task history, decisions, and events.

**Parameters:**
```typescript
{
  taskId?: string,        // Filter by task ID
  epicId?: string,        // Filter by epic ID
  workerId?: string,      // Filter by worker ID
  eventTypes?: string[],  // Filter by event types (e.g. STEP_COMPLETED, TASK_STATUS_CHANGED)
  limit?: number          // Max events to return (default 50)
}
```

**Returns:**
```typescript
{
  events: ActivityLogEntry[],
  count: number,
  filters: { taskId, epicId, workerId, eventTypes, limit }
}
```

---

### moe.unblock_worker

Clear BLOCKED status on a worker, setting it back to IDLE.

**Parameters:**
```typescript
{
  workerId: string,       // Required: the worker ID to unblock
  resolution: string,     // Required: what was done to resolve the block
  retryTask?: boolean     // If true, worker keeps currentTaskId to retry (default false)
}
```

**Returns:**
```typescript
{
  success: true,
  workerId: string,
  status: "IDLE",
  currentTaskId: string | null,
  resolution: string,
  retryTask: boolean,
  message: string
}
```

**Errors:**
- `workerId is required`
- `resolution is required`
- `Worker not found: <workerId>`
- `Worker must be in BLOCKED status` - if worker is not BLOCKED

---

### moe.qa_approve

QA approves a task in REVIEW status, moving it to DONE.

**Parameters:**
```typescript
{ taskId: string, summary?: string }
```

**Returns:**
```typescript
{ success: true, taskId, status: "DONE", summary, message }
```

**Errors:**
- `taskId is required`
- `Task not found: <taskId>`
- `Task must be in REVIEW status to approve`

---

### moe.qa_reject

QA rejects a task in REVIEW status, moving it back to WORKING for fixes.

**Parameters:**
```typescript
{ taskId: string, reason: string }
```

**Returns:**
```typescript
{ success: true, taskId, status: "WORKING", reopenCount, reason, message }
```

**Notes:**
- Increments `reopenCount`
- Sets `reopenReason` so the worker knows what to fix
- Worker should address the feedback and call `moe.complete_task` again

**Errors:**
- `taskId is required`
- `reason is required - explain which DoD items failed and why`
- `Task not found: <taskId>`
- `Task must be in REVIEW status to reject`

---

## Team Management Tools

Teams allow multiple agents of the same role to work in parallel within an epic. Team members bypass the per-epic per-status constraint.

### moe.create_team

Create a team or return an existing team with the same name+role (idempotent).

**Parameters:**
```typescript
{
  name: string,          // Required: team display name (e.g. "Coders")
  role: 'architect' | 'worker' | 'qa',  // Required: team role
  maxSize?: number       // Maximum members (default 10)
}
```

**Returns:**
```typescript
{
  team: Team,            // The created or existing team
  created: boolean       // true if newly created, false if already existed
}
```

---

### moe.join_team

Add a worker to a team. Auto-registers the worker if it doesn't exist.

**Parameters:**
```typescript
{
  teamId: string,        // Required: the team ID to join
  workerId: string       // Required: the worker ID
}
```

**Returns:**
```typescript
{ team: Team }           // Updated team with new member
```

**Errors:**
- `Team not found: <teamId>`
- `Team is full (max N members)`

---

### moe.leave_team

Remove a worker from a team.

**Parameters:**
```typescript
{
  teamId: string,        // Required: the team ID to leave
  workerId: string       // Required: the worker ID
}
```

**Returns:**
```typescript
{ team: Team }           // Updated team without the member
```

---

### moe.list_teams

List all teams, optionally filtered by role.

**Parameters:**
```typescript
{
  role?: string          // Optional: filter by role (architect, worker, qa)
}
```

**Returns:**
```typescript
{
  teams: Array<Team & {
    members: Array<{ id: string, type: string, status: string }>
  }>
}
```
