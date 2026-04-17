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

## Ownership & Ordering

Phase 3 introduced server-side guards on six tools: `moe.submit_plan`, `moe.start_step`, `moe.complete_step`, `moe.complete_task`, `moe.qa_approve`, and `moe.qa_reject`. Each accepts an optional `workerId` parameter. The `moe-proxy` auto-injects it from the `MOE_WORKER_ID` env var — set identically by `scripts/moe-agent.sh` and `scripts/moe-agent.ps1`, so the same rules apply on Linux, macOS, and Windows. Clients that supply an explicit `workerId` (or human-driven actions on tasks with `assignedWorkerId=null`) are never overwritten.

Three guards are checked in order. Each failure throws `MoeError` with JSON-RPC code `-32003` (`NOT_ALLOWED`):

| Guard | Applies to | Fires when | Fix |
|---|---|---|---|
| Worker owns task | `submit_plan`, `start_step`, `complete_step`, `complete_task`, `qa_approve`, `qa_reject` | `task.assignedWorkerId` is set and does not match `workerId` | Only the claiming worker may act; a second agent must claim a different task. |
| Context fetched | `start_step` | Caller has never invoked `moe.get_context` for this task | Call `moe.get_context { taskId, workerId }` first. |
| All steps complete | `complete_task` | Any `implementationPlan` step is still `PENDING` or `IN_PROGRESS` | Finish remaining steps, then retry. The error message includes the count of incomplete steps. |

Bookkeeping fields on `Task`:
- `contextFetchedBy?: string[]` — de-duplicated workerIds that invoked `moe.get_context`.
- `stepsCompleted?: string[]` — ordered stepIds already marked `COMPLETED`, populated by `moe.complete_step`.

All guards are no-ops when `task.assignedWorkerId` is `null`, preserving `--no-auto-claim` interactive flows and the JetBrains plugin `/ws` path (which never carries a `workerId`).

---

## Tools (Implemented)

### moe.get_context

Get current project/epic/task context and rails.

**Parameters:**
```typescript
{ taskId?: string, workerId?: string }
```

**Resolution order:**
1. `taskId` param
2. `MOE_TASK_ID` env
3. `MOE_WORKER_ID` env (uses worker.currentTaskId)

When a `workerId` is supplied (or inherited from `MOE_WORKER_ID`), it is appended to the task's `contextFetchedBy` list so that `moe.start_step` can later verify the caller has seen the plan. See **Ownership & Ordering** below.

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
  workerId?: string,    // Optional; auto-injected by moe-proxy from MOE_WORKER_ID
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
{ taskId: string, stepId: string, workerId?: string }
```

> `moe.get_context` must be called by `workerId` before `moe.start_step` — see **Ownership & Ordering** below.

**Returns:**
```typescript
{ success: true, taskId, stepId, stepNumber, totalSteps }
```

---

### moe.complete_step

Mark a step as `COMPLETED`. Appends `stepId` to `task.stepsCompleted` (de-duplicated).

**Parameters:**
```typescript
{ taskId: string, stepId: string, modifiedFiles?: string[], note?: string, workerId?: string }
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

Mark a task as `REVIEW` (complete) and optionally attach a PR link. Requires task to be in `WORKING` status, caller to own the task, and every implementation step to be `COMPLETED`.

**Parameters:**
```typescript
{ taskId: string, prLink?: string, summary?: string, workerId?: string }
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
{ taskId: string, summary?: string, workerId?: string }
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
{ taskId: string, reason: string, workerId?: string }
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

Teams allow multiple agents to work in parallel within an epic. Teams can be role-based or project-wide (role omitted), and team members bypass the per-epic per-status constraint.

### moe.create_team

Create a team or return an existing team with the same name+role (idempotent). If `role` is omitted, idempotency is name-only and the team is project-wide.

**Parameters:**
```typescript
{
  name: string,          // Required: team display name (e.g. "Coders")
  role?: 'architect' | 'worker' | 'qa', // Optional: team role (omit for project team)
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

---

## Chat Tools

Real-time multi-agent chat communication. Ported from [agentchattr](https://github.com/bcurts/agentchattr).

### moe.chat_send

Send a chat message to a channel. Parses @mentions and returns routing info.

**Parameters:**
```typescript
{
  channel: string,      // Required: channel ID
  content: string,      // Required: message text (max 10KB)
  workerId?: string,    // Sender worker ID (defaults to "human")
  replyTo?: string      // Message ID for threading
}
```

**Returns:**
```typescript
{ success: true, messageId, channel, timestamp, routed: string[] }
```

**Notes:**
- @mentions are parsed from content (e.g., `@worker-abc123`)
- `routed` array contains all mentioned worker IDs

---

### moe.chat_read

Read chat messages with cursor-based pagination. Auto-tracks read position per worker.

**Parameters:**
```typescript
{
  channel?: string,     // Channel ID (omit to read from all channels)
  workerId?: string,    // Worker ID for auto-cursor tracking
  sinceId?: string,     // Return messages after this message ID
  limit?: number        // Max messages (default 20, max 200)
}
```

**Returns:**
```typescript
{ messages: ChatMessage[], cursor: string | null }
```

**Notes:**
- If `workerId` provided without `sinceId`, uses the worker's saved cursor for incremental reads
- After reading, the worker's cursor is automatically updated
- When no `channel` specified, reads from all channels merged by timestamp

---

### moe.chat_channels

List all chat channels in the project.

**Parameters:**
```typescript
{}  // No required parameters
```

**Returns:**
```typescript
{ channels: ChatChannel[] }
```

---

### moe.chat_join

Join a chat channel. Posts a system message and returns online workers.

**Parameters:**
```typescript
{
  channel: string,      // Required: channel ID
  workerId: string      // Required: your worker ID
}
```

**Returns:**
```typescript
{ channel, channelName, onlineWorkers: Array<{ id, status }> }
```

**Notes:**
- Posts a system message: `{workerId} joined #{channelName}`
- Online workers are those with activity within the last 120 seconds

---

### moe.chat_who

List online workers. Optionally filter by channel participation.

**Parameters:**
```typescript
{
  channel?: string      // Optional: filter by channel participation
}
```

**Returns:**
```typescript
{
  online: Array<{
    workerId: string,
    status: string,
    lastActivity: string,
    currentTaskId: string | null
  }>
}
```

**Notes:**
- Uses 120-second presence timeout (matching agentchattr)
- Channel filter checks worker's chatCursors for participation

---

### moe.chat_wait

Long-poll for chat messages mentioning this worker or from humans.

**Parameters:**
```typescript
{
  workerId: string,     // Required: your worker ID
  channels?: string[],  // Optional: channel filter
  timeoutMs?: number    // Max wait (default 300000, max 600000)
}
```

**Returns:**
```typescript
{ hasMessage: true, messages: [ChatMessage] }  // on match
{ hasMessage: false, timedOut: true }           // on timeout
{ hasMessage: false, cancelled: true }          // if cancelled
```

**Notes:**
- Follows the same long-poll pattern as `moe.wait_for_task`
- Only wakes for messages where `workerId` is in `mentions` or `sender` is "human"
- Cancels any previous wait for the same worker

### moe.chat_decision

Propose a decision for human approval. Optionally posts a system message to a chat channel linking to the decision.

**Parameters:**
```typescript
{
  content: string,      // Required: decision text (max 10KB)
  channel?: string,     // Optional: channel ID to post decision message
  workerId?: string     // Optional: proposing worker ID (defaults to "human")
}
```

**Returns:**
```typescript
{
  success: true,
  decision: Decision,   // The created decision entity
  messageId?: string    // System message ID (if channel was specified)
}
```

**Notes:**
- Creates a Decision entity in `.moe/decisions/{id}.json`
- If `channel` is provided, posts a system message with `decisionId` set on the ChatMessage
- Decision starts in `proposed` status
- Humans approve/reject from IDE UI (GET_DECISIONS → APPROVE_DECISION / REJECT_DECISION WebSocket messages)
- Emits `DECISION_PROPOSED` state change event

---

### moe.chat_resync

Clear chat cursors and return full message history for resync. Useful when a worker loses context or wants to re-read all messages.

**Parameters:**
```typescript
{
  workerId: string,   // Required: worker whose cursors to reset
  channel?: string,   // Optional: specific channel to resync (omit for all)
  limit?: number      // Max messages per channel (default 50, max 200)
}
```

**Returns:**
```typescript
{ success: true, messagesCount: number, messages: ChatMessage[], cursorsReset: true }
```

**Notes:**
- Clears the worker's chatCursors for the specified channel (or all channels)
- Returns messages from the beginning of history
- Updates cursors to the latest message after resync

## Memory Tools

Persistent project knowledge base that grows smarter with every task. See [Memory System Guide](MEMORY.md) for architecture details.

### moe.remember

Save a learning to the project knowledge base.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `content` | string | Yes | The knowledge to save (max 2000 chars) |
| `type` | string | Yes | `convention`, `gotcha`, `pattern`, `decision`, `procedure`, or `insight` |
| `tags` | string[] | No | Searchable tags (auto-generated from content if omitted) |
| `workerId` | string | Yes | Your worker ID |
| `taskId` | string | No | Current task ID |
| `files` | string[] | No | Related file paths |

**Returns:** `{ memoryId, message, wasDuplicate, mergedWith?, tags }`

**Notes:**
- Automatically deduplicates: if similar content exists (>70% Jaccard similarity), merges instead of creating a new entry
- Auto-generates tags from content using tokenization if none provided
- Memories start with confidence 1.0

### moe.recall

Search the project knowledge base for relevant memories.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `query` | string | Yes | Natural language search query |
| `types` | string[] | No | Filter by memory type |
| `tags` | string[] | No | Filter by tags |
| `epicId` | string | No | Scope to memories from a specific epic |
| `files` | string[] | No | Match by related file paths (boosts relevance) |
| `limit` | number | No | Max results (default 10, max 30) |
| `minConfidence` | number | No | Minimum confidence threshold (default 0.3) |

**Returns:** `{ memories: [{ id, type, content, tags, confidence, score, source, createdAt }], totalCount }`

**Notes:**
- Uses BM25 ranking algorithm with composite scoring (text relevance + tags + file overlap + recency + quality)
- Automatically updates access counts on returned memories
- Memories also auto-surface in `moe.get_context` responses (top 5 relevant)

### moe.reflect

Rate a memory as helpful or unhelpful. Adjusts confidence for future relevance.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `memoryId` | string | Yes | The memory ID to rate |
| `helpful` | boolean | Yes | `true` if useful, `false` if not |
| `workerId` | string | Yes | Your worker ID |

**Returns:** `{ memoryId, helpful, newConfidence, message }`

**Notes:**
- Helpful: confidence +0.15 (capped at 2.0)
- Unhelpful: confidence -0.25 (floor at 0.0)
- Memories below 0.3 confidence are excluded from search results
- Over time, the best knowledge rises and bad knowledge fades

### moe.save_session_summary

Save a summary of your session before ending. The next agent on this task will see it.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `workerId` | string | Yes | Your worker ID |
| `taskId` | string | Yes | The task ID you worked on |
| `summary` | string | Yes | What you accomplished and key findings (max 5000 chars) |
| `memoriesCreated` | string[] | No | IDs of memories saved this session |

**Returns:** `{ sessionId, message }`

**Notes:**
- Stored in `.moe/memory/sessions/{workerId}_{taskId}.json`
- Visible in `moe.get_context` response as `memory.lastSession`
- Enables session continuity when agents are relaunched
