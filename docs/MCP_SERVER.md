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
- Enforces rails in this order: `forbiddenPatterns`, `requiredPatterns`, `epicRails`, `taskRails`.
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
{ statuses: string[], epicId?: string, workerId?: string }
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
