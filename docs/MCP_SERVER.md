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

### moe.init_project

Initialize a Moe project and create the `.moe/` directory structure.

**Parameters:**
```typescript
{
  projectPath?: string,
  name?: string,
  force?: boolean,
  enableClaudeHook?: boolean // default false
}
```

#### Claude-Code PreToolUse hook (optional)

`enableClaudeHook: true` emits defense-in-depth Claude Code hook files:

- `.claude/settings.json`
- `.claude/hooks/moe-require-claim.sh`
- `.claude/hooks/moe-require-claim.ps1`

The hook gates only ownership-sensitive Moe MCP tools:
`mcp__moe__moe_(start_step|complete_step|complete_task|submit_plan|qa_approve|qa_reject)`.
Read-only tools such as `get_context` and `list_tasks` bypass the hook.

On each gated tool call, the hook invokes `scripts/moe-call.sh list_tasks` and verifies that
`MOE_WORKER_ID` owns a task in `PLANNING`, `WORKING`, or `REVIEW`. Missing worker ID,
missing `moe-call.sh`, daemon/proxy failure, malformed output, or timeout fail open with a
short warning; this hook supplements, but does not replace, server-side ownership/order guards.
On Windows, the PowerShell hook prefers `MOE_BASH_PATH` or Git Bash before PATH-discovered
`bash.exe` launchers so a broken WSL shim does not silently disable claim enforcement.

Disable by deleting `.claude/hooks/moe-require-claim.*` or removing the matching
`PreToolUse` entry from `.claude/settings.json`.

Manual cleanup:
```bash
rm -f .claude/hooks/moe-require-claim.sh .claude/hooks/moe-require-claim.ps1
```

### moe.get_context

Get current project/epic/task context and rails.

**Parameters:**
```typescript
{
  taskId?: string,
  workerId?: string,
  commentsLimit?: number,                  // default: 10 recent comments, max 50; 0 omits comments
  commentsMaxChars?: number                // default: 1000 per comment; 0 returns full comment text
}
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
  task: {
    id, title, description, definitionOfDone, taskRails, status, implementationPlan,
    comments: Array<{
      id: string,
      author: string,
      content: string,
      timestamp: string,
      contentTruncated?: boolean,
      contentOriginalLength?: number
    }>,
    commentSummary: { total, returned, omitted, truncated, hint?: string }
  } | null,
  worker: {
    id, type, status, currentTaskId, lastActivityAt, lastError, errorCount, teamId
  } | null, // lean: excludes chatCursors, modifiedFiles, and branch
  allRails: {
    global: string[], // currently project.globalRails.requiredPatterns
    epic: string[],
    task: string[]
  }
}
```

By default, `get_context` returns compact recent-chat previews, a lean worker object, and only the latest compact task comments to save tokens. Cross-session memory is not part of this payload — use the Serena MCP server's memory tools (`list_memories` / `read_memory`); see [MEMORY.md](MEMORY.md). Call `moe.chat_read` with `maxContentChars: 0` for full chat content; set `commentsMaxChars: 0` when full returned comment content is needed.

---

### moe.submit_plan

Submit an implementation plan. Sets task status to `AWAITING_APPROVAL`.

**Parameters:**
```typescript
{
  taskId: string,
  workerId?: string,    // Optional; auto-injected by moe-proxy from MOE_WORKER_ID
  steps: { description: string; affectedFiles?: string[] }[],
  planningNotes?: { approachesConsidered?, codebaseInsights?, risks?, keyFiles? },
  budget?: { wallClockMs?: number }  // soft cap on first-claim → DONE
}
```

`affectedFiles` paths must be project-relative (no absolute paths, no `..` traversal); the daemon normalizes separators and deduplicates. At claim time, overlapping affectedFiles across WORKING tasks surface as a `fileCollision` warning on `moe.claim_next_task` — advisory only, the claim still succeeds.

**Notes:**
- **Enforced rails:** Only `forbiddenPatterns` and global `requiredPatterns` are strictly enforced.
- **Guidance rails:** `epicRails` and `taskRails` are provided as guidance to AI agents but are NOT enforced in plan text. This allows agents to address the intent of rails without requiring verbatim quoting. Humans verify compliance during plan approval.
- On violation, returns JSON-RPC error with `message: "RAIL_VIOLATION"` and `error.data` set to the violation string.
- **Step bounds:** max 100 steps, each `description` ≤2000 chars, each `affectedFiles` ≤50 entries.
- `budget.wallClockMs` (when supplied) must be `> 0`; prior `warnedAt`/`escalatedAt` marks are preserved on resubmits. Plan submission refreshes `metrics.plannedStepCount`.
- **CONTROL mode side effect:** the daemon posts `📋 Plan ready for critique — <title> (<id>)` to `#governors` with the step count + DoD preview. If at least one registered governor exists, `task.pendingPlanCritique` is set to record who is expected to weigh in. Critique is informational; humans still own approval.

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
{
  epicId?: string,
  status?: string[],
  limit?: number,  // default: 100, max: 500
  offset?: number  // default: 0
}
```

**Returns:**
```typescript
{
  epicId: string | null,
  epicTitle: string | null,
  tasks: Array<{
    id, epicId, title, status, priority, order,
    assignedWorkerId, hasWorker, reopenCount, hasPendingQuestion,
    definitionOfDoneCount, planStepCount, completedStepCount
  }>,
  counts: { backlog, inProgress, review, done },
  pagination: { limit, offset, returned, total, hasMore }
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
  limit?: number,           // Maximum results (default: 20, max: 200)
  detail?: 'summary' | 'full', // default: 'summary'
  maxDescriptionChars?: number // summary preview budget (default: 240, max: 2000)
}
```

**Returns:**
```typescript
{
  tasks: TaskSummary[] | Task[], // summaries by default; full tasks only with detail: 'full'
  totalMatches: number,     // Matching tasks before limit
  query: string | null,     // The search query used
  filters: object,          // Filters that were applied
  detail: 'summary' | 'full'
}
```

**Notes:**
- Title matches are weighted 2x higher than description matches
- Results are sorted by relevance score (highest first)
- Filters are applied before search query
- Default `summary` responses omit full descriptions, DoD, comments, and plans. Use `detail: 'full'` only when necessary.
- If no query is provided, returns filtered tasks up to limit

---

### moe.get_next_task

Return the next BACKLOG task by order.

**Parameters:**
```typescript
{
  epicId?: string,
  detail?: 'summary' | 'full', // default: 'summary'
  maxDescriptionChars?: number // summary preview budget (default: 240, max: 2000)
}
```

**Returns:**
```typescript
{
  hasNext: boolean,
  detail?: 'summary' | 'full',
  task?: TaskSummary | { id, title, description, definitionOfDone }
}
```

---

### moe.claim_next_task

Claim a task: by id (`taskId`) or the next prioritized task matching `statuses`. Assigns `assignedWorkerId` if provided.

**Parameters:**
```typescript
{
  statuses: string[],
  epicId?: string,
  workerId?: string,
  replaceExisting?: boolean,       // Take over from existing worker
  taskId?: string,                 // Claim this specific task (must be in one of `statuses`)
  preferAdjacentInEpic?: boolean   // default: true — rank candidates in the worker's last epic ahead of others
}
```

When `taskId` is provided the priority/order ranking is bypassed — you get the named task or an error. The task must be in one of the requested `statuses`; if it's already assigned to someone else, pass `replaceExisting: true` to take over.

With `preferAdjacentInEpic` on (default), candidates in the caller's currently-recorded epic (or explicit `epicId`) are ranked ahead of other epics before priority/order — so a worker waking from `wait_for_task` picks up the next adjacent task instead of jumping to an unrelated epic.

**Returns:**
```typescript
{
  hasNext: boolean,
  task?: {
    id,
    epicId,
    title,
    status,
    priority,
    assignedWorkerId,
    reopenCount,
    reopenReason,
    rejectionDetails,
    roleChannelId,
    generalChannelId,
    priorHandoffCount: number       // 0 when no prior handoffs
  },
  reopenWarning?: string,
  chatHint?: string,
  handoffHint?: string,             // present when priorHandoffs exist
  fileCollision?: Array<{ task: string, files: string[] }>,  // advisory only
  nextAction: {
    tool: 'moe.get_context' | 'moe.get_handoff_history' | 'moe.wait_for_task' | 'moe.enter_governance',
    args: object,
    reason: string,
    recommendedSkill?: { name: string, reason: string }
  }
}
```

**Notes:**
- On first claim the daemon stamps `task.metrics.firstClaimAt` (idempotent).
- After the claim, the daemon re-evaluates `task.budget` (warn at 80%, escalate at 100% to `#governors`).
- `fileCollision[]` is populated when the claimed task's normalized `affectedFiles` overlap with any other `WORKING` task — advisory only, the claim still succeeds, and a heads-up is posted to `#workers`.
- When `task.priorHandoffs` is non-empty, `nextAction.tool` is `moe.get_handoff_history` (instead of `moe.get_context`) so the worker reads the handoff before redoing finished work.
- Governors short-circuit: a caller whose team role is `governor` gets `nextAction.tool = "moe.enter_governance"` and never claims a task.

`claim_next_task` is intentionally lean: it does **not** return project rails, epic details, task descriptions, definition of done, task rails, implementation plans, chat history, or memory payloads. Call `moe.get_context` after a successful claim to fetch the full, token-budgeted context.

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

### moe.release_task

Release a task from its assigned worker (clears `assignedWorkerId`, status unchanged). Anyone can call — no ownership check. Use when an agent shuts down without releasing, or when you want to hand a task to a different agent.

**Parameters:**
```typescript
{
  taskId: string,                 // Required
  reason?: string,                // Optional human-readable reason (clamped to 2000 chars)
  handoffNote?: {                 // Optional but strongly recommended
    whatIsDone: string,           // Required if handoffNote present (≤4000 chars)
    whatRemains: string,          // Required if handoffNote present (≤4000 chars)
    pitfalls?: string,            // ≤4000 chars
    openQuestions?: string        // ≤4000 chars
  },
  workerId?: string               // Caller worker ID (auto-injected by proxy)
}
```

**Returns:**
```typescript
{
  success: true,
  taskId: string,
  previousWorkerId: string | null,   // null if task was already unassigned
  status: TaskStatus,                // unchanged
  priorHandoffCount?: number,        // length of priorHandoffs after this release
  message: string,
  warning?: string                   // set when called without handoffNote
}
```

**Side effects:**
- Sets `task.assignedWorkerId = null`.
- When `handoffNote` is provided, builds a `HandoffNote` (with `releasedBy`, `releasedAt`, optional `reason`) and **prepends** it to `task.priorHandoffs` (newest-first, capped at 20).
- Without `handoffNote`, the chat broadcast tags the release `(released without handoff)` and the response includes `warning: "release_task called without handoffNote; next claimer will lack context."`.
- If the released worker exists and `worker.currentTaskId === taskId`, sets the worker to `IDLE` with `currentTaskId = null`.
- Posts the release line to `#general`, `#workers`, and `#governors`.
- Activity event: `WORKER_RELEASED`.

---

### moe.list_workers

List all registered workers with liveness derived from `lastActivityAt`. Use to see which agents are alive and which shut down (potentially still holding task assignments).

**Parameters:**
```typescript
{
  livenessTimeoutMs?: number,  // Workers idle longer than this are reported isAlive=false (default 120000)
  onlyStale?: boolean          // If true, return only stale workers
}
```

**Returns:**
```typescript
{
  workers: Array<{
    workerId: string,
    type: string,
    status: WorkerStatus,
    currentTaskId: string | null,
    currentTaskTitle: string | null,
    lastActivityAt: string,
    secondsSinceLastActivity: number,  // -1 if never recorded
    isAlive: boolean,
    epicId: string | null,
    teamId: string | null
  }>,
  summary: { total, alive, stale, staleWithAssignedTask, livenessTimeoutMs },
  // Present only when stale workers still hold assignments:
  hint?: string,
  staleAssignments?: Array<{ workerId, taskId, taskTitle, secondsSinceLastActivity }>
}
```

`isAlive` is the shared `isWorkerAlive` predicate (`status !== 'DEAD' && lastActivityAt` within the window). `DEAD` workers are excluded from the UI but still listed here (as `isAlive: false`) until pruned.

---

### moe.deregister_worker

Mark a worker `DEAD`, release every task it holds (routed via `nextStatusForRelease`: WORKING→BACKLOG, or →REVIEW if all steps are done; PLANNING/REVIEW/AWAITING_APPROVAL stay put), and post chat-leave messages. Called by the agent wrapper's exit trap on terminal close (`trap … EXIT` in `moe-agent.sh`, top-level `finally` in `moe-agent.ps1`). The default-on worker-liveness sweep calls the same path for hard crashes after the idle timeout. **Idempotent** — repeat calls on an already-`DEAD` worker are no-ops.

**Parameters:**
```typescript
{
  workerId: string,   // Worker ID to deregister
  reason?: string     // Short reason ("terminal_closed", "liveness_timeout", …). Default: "deregistered".
}
```

**Returns:**
```typescript
{
  success: true,
  workerId: string,
  alreadyDead: boolean,       // true if the worker was already DEAD with no task (no-op)
  releasedTaskIds: string[],
  releasedCount: number,
  message: string
}
```

The worker record is retained (status `DEAD`) for post-mortem/idempotency, dropped from the UI immediately (a `WORKER_DELETED` event is emitted and `DEAD` workers are excluded from state snapshots), and pruned by a later stale-worker sweep once it owns nothing.

---

### moe.enter_governance

**Governor-only.** A governor worker transitions into governance mode to watch chat, drift, stale workers, and QA rejections. Sets the worker status to `GOVERNING`, broadcasts presence to `#general` and `#governors`, and returns a `chat_wait` `nextAction` for the multi-channel watch loop.

Non-governor callers are rejected with `NOT_ALLOWED`. Architects on an empty PLANNING queue get a `wait_for_task` nextAction from `moe.claim_next_task`; governance belongs to the governor role.

`moe.claim_next_task` automatically returns this tool as `nextAction` when the caller's team role is `governor` (governors never claim tasks).

**Parameters:**
```typescript
{ workerId: string }
```

**Returns:**
```typescript
{
  success: true,
  workerId: string,
  status: "GOVERNING",
  channels: Array<{ id: string, name: string }>,  // general/architects/workers/qa/governors, those that exist
  governanceDuties: string[],
  nextAction: { tool: "moe.chat_wait", args: { workerId, channels, timeoutMs }, reason: string }
}
```

**Side effects:**
- `worker.status = "GOVERNING"`, `worker.currentTaskId = null`.
- System message in `#general`: `🧭 {workerId} is now governing — @mention them on stuck workers, rejections, or escalations.`
- Same message in `#governors`.
- Activity event: `WORKER_GOVERNING`.

**Auto-push signals.** While a governor's `chat_wait` is blocked on `#governors`, the daemon cross-posts these events so the loop wakes:
- `🚧 {worker} blocked on {taskId}: {reason}` (from `moe.report_blocked`).
- `❌ QA rejected {taskId}: {reason}` (from `moe.qa_reject`).
- `🔓 {worker} released task: {title}` (from `moe.release_task`).
- `⚠️ {worker} stale on {taskId} — last activity {N}s ago` (from the daemon's stale-worker watcher; only fires when at least one governor is online).
- `📋 New plan needed: {title} ({id})` (cross-post of the PLANNING announcement; informational — governors never claim PLANNING tasks).

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

QA rejects a task in REVIEW status, moving it back to WORKING for fixes — or to PLANNING when reopen/DoD thresholds trip.

**Parameters:**
```typescript
{
  taskId: string,
  reason: string,                  // max 2000 chars
  failedDodItems?: string[],       // max 20
  issues?: QAIssue[],              // max 20; type ∈ test_failure|lint|security|missing_feature|regression|other
  workerId?: string
}
```

**Returns:**
```typescript
{
  success: true, taskId, status: "WORKING" | "PLANNING",
  reopenCount, maxReopens, exceededReopenCap: boolean,
  repeatedFailedDodItem?: string,
  reason, rejectionDetails, rejectionHistory: RejectionHistoryEntry[],
  failedDodItems: FailedDodItem[],
  message,
  nextAction
}
```

**Notes:**
- Increments `reopenCount` and `metrics.rejectCount`; sets `reopenReason`.
- Appends a `RejectionHistoryEntry` to `rejectionHistory[]` (newest-first, capped at 20).
- Populates `failedDodItems[]` (append-only, capped at last 100) — every supplied DoD item is recorded with `rejectedAt` + `rejectedBy`.
- **Auto-flip to `PLANNING`** when either:
  - `reopenCount ≥ maxReopens` (default 3 via `MAX_REOPENS_DEFAULT`; per-task override `task.maxReopens`), OR
  - the **same DoD item has failed ≥2 times** in `failedDodItems[]`.
- On auto-flip, posts a heads-up to `#architects`; on every rejection, cross-posts `❌ QA rejected ...` to `#governors`.

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

### moe.get_pending_questions

Return tasks with unanswered human task comments, using bounded defaults so a large backlog cannot flood the agent context.

**Parameters:**
```typescript
{
  epicId?: string,             // Optional epic filter
  limit?: number,              // Task entries to return (default: 10, max: 50)
  maxQuestionsPerTask?: number,// Human comments per task (default: 3, max: 20)
  maxContentChars?: number     // Max chars/question (default: 1000, max: 10000; 0 = full)
}
```

**Returns:**
```typescript
{
  count: number,        // returned task entries
  totalMatches: number, // matching task entries before limit
  tasks: Array<{
    taskId, title, status, epicId, assignedWorkerId,
    questions: Array<{
      commentId, content, timestamp,
      contentTruncated?: boolean,
      contentOriginalLength?: number
    }>,
    totalQuestions: number,
    omittedQuestions: number
  }>,
  pagination: { limit, returned, total, hasMore },
  truncatedQuestions: number,
  hint?: string
}
```

**Notes:**
- Only human comments after the last non-human response are treated as pending.
- Long question content is truncated by default; pass `maxContentChars: 0` only when exact full text is needed.

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
  limit?: number,       // Max messages (default 10, max 200)
  maxContentChars?: number // Max chars/message in response (default 1000, 0 = full)
}
```

**Returns:**
```typescript
{
  messages: Array<ChatMessage & { contentTruncated?: boolean, contentOriginalLength?: number }>,
  cursor: string | null,
  truncated: number
}
```

**Notes:**
- If `workerId` provided without `sinceId`, uses the worker's saved cursor for incremental reads
- After reading, the worker's cursor is automatically updated only for messages returned in the response
- When no `channel` specified, reads up to `limit` messages per channel, merges them by timestamp, and returns the newest global `limit` messages
- In all-channel mode, per-channel cursors and unread counts advance/clear only when doing so cannot skip fetched-but-omitted messages; any channel with omitted fetched messages stays unchanged so those messages remain readable on a later call
- Long message content is truncated by default; pass `maxContentChars: 0` only when exact full text is needed

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

### moe.chat_wait

Long-poll for chat messages mentioning this worker or from humans.

**Parameters:**
```typescript
{
  workerId: string,     // Required: your worker ID
  channels?: string[],  // Optional: channel filter
  timeoutMs?: number,   // Max wait (default 300000, max 600000)
  maxContentChars?: number // Max chars/message in response (default 1000, 0 = full)
}
```

**Returns:**
```typescript
{ hasMessage: true, messages: [ChatMessage], truncated: number }  // on match
{ hasMessage: false, timedOut: true }           // on timeout
{ hasMessage: false, cancelled: true }          // if cancelled
```

**Notes:**
- Follows the same long-poll pattern as `moe.wait_for_task`
- When `channels` is explicitly provided, wakes on **any** message in those channels — the subscription set is the filter (matches the governor `#governors` watch pattern).
- When `channels` is omitted (broad scope), only wakes for messages where `workerId` is in `mentions` or `sender` is `"human"`.
- Cancels any previous wait for the same worker
- Aborts with `{ hasMessage: false, cancelled: true, error }` if a subscribed channel is deleted while waiting

## Cross-Session Memory

Moe has **no native memory tools**. Cross-session knowledge (conventions, gotchas, patterns, decisions, end-of-session handoffs) is provided by the **Serena MCP server**, which the agent launchers inject alongside the `moe` proxy. Use Serena's `list_memories` / `read_memory` / `write_memory` / `edit_memory` / `delete_memory`, backed by a flat per-name markdown store at `.serena/memories/*.md`. See [MEMORY.md](MEMORY.md) for the naming convention and pull-on-start / write-before-finish workflow.

## Governance Control-Plane Tools

### moe.get_handoff_history

Return prior handoff notes + `priorAttempt` for a task. Workers picking up a released task should call this **before** `moe.get_context` so they don't redo finished work — `moe.claim_next_task` advertises this tool in `nextAction` when `priorHandoffs` is non-empty.

**Parameters:**
```typescript
{ taskId: string }
```

**Returns:**
```typescript
{
  taskId: string,
  priorHandoffs: HandoffNote[],    // newest-first
  priorAttempt: PriorAttempt | null
}
```

---

### moe.list_metrics

Return per-task `TaskMetrics` plus an aggregate over the full filtered set. Aggregate is defined (zeroed) even when no tasks match the filter.

**Parameters:**
```typescript
{
  epicId?: string,        // restrict to a single epic
  sinceIso?: string,      // ISO 8601 cutoff; tasks last touched at/after this time
  limit?: number          // cap on per-task entries (default 100, max 1000); aggregate is always over the full filtered set
}
```

**Returns:**
```typescript
{
  aggregate: {
    taskCount, doneCount, avgWallClockMs,
    firstPassApprovalPct,           // 0..100; first-pass = DONE with rejectCount===0
    avgReopenCount,
    totalRejectCount, totalExecutedStepCount
  },
  tasks: Array<{ taskId, epicId, status, title, metrics: TaskMetrics }>,
  totalMatched: number              // size of filtered set before `limit` is applied
}
```

**Notes:**
- Per-task entries are sorted newest-first by `metrics.doneAt → metrics.firstClaimAt → updatedAt → createdAt`.
- `sinceIso` uses the most recent lifecycle timestamp available on each task, so in-flight tasks aren't excluded just because they haven't reached DONE.

---

### moe.request_replan

Worker (or governor) hands the task back to the architect for a fresh plan. Snapshots the current `implementationPlan` + `stepsCompleted` into `task.priorAttempt`, clears the plan, flips the task to `PLANNING`, and cross-posts a `🔁 Replan requested` line to `#architects`. Use when the discovered problem is the plan itself, not a transient blocker (which goes through `moe.report_blocked`).

**Parameters:**
```typescript
{
  taskId: string,
  reason: string,        // max 2000 chars; why the existing plan is unworkable
  stepId?: string,       // optional: step where the plan broke down (annotates chat post)
  workerId?: string
}
```

**Preconditions:**
- Task must be in `WORKING`.
- Caller must own the task (`assertWorkerOwns`).

**Returns:**
```typescript
{
  success: true,
  taskId,
  status: "PLANNING",
  priorAttempt: PriorAttempt,
  message,
  nextAction: { tool: "moe.wait_for_task", args, reason }
}
```

**Side effects:**
- Sets `task.reopenReason = reason` and `task.priorAttempt = { attemptedAt, reason, implementationPlan, stepsCompleted }`.
- Resets `implementationPlan = []` and `stepsCompleted = []`.
- Marks the assigned worker `IDLE` with `currentTaskId = null`.
- Activity event: `TASK_REOPENED`.

---

### moe.set_task_budget

Set or clear the wall-clock budget on a task. Daemon warns at 80% and escalates at 100% in `#governors`. Re-evaluates the budget immediately, so tightening the cap on an in-flight task fires the warning right away if the new threshold has already been crossed.

**Parameters:**
```typescript
{
  taskId: string,
  wallClockMs?: number   // soft cap on first-claim → DONE; omit or 0 to clear
}
```

`wallClockMs` (when not clearing) must be a finite positive number.

**Returns:**
```typescript
{ success: true, taskId, budget: TaskBudget | null }
```

**Notes:**
- Preserves existing `warnedAt`/`escalatedAt` marks when the cap is adjusted upward.

---

### moe.submit_plan_critique

Governor-only. Record a structured critique of a submitted plan. `verdict='block'` flips the task back to `PLANNING` with concerns posted to `#architects`; `verdict='pass'` is informational. **Does not auto-approve** — humans still own approval.

**Parameters:**
```typescript
{
  taskId: string,
  verdict: 'pass' | 'block',
  concerns?: string[],   // max 20 entries, ≤1000 chars each; required when verdict='block'
  workerId?: string
}
```

**Returns:**
```typescript
{
  success: true, taskId, status,
  verdict: 'pass' | 'block',
  concerns: string[],
  planCritiqueResult: { verdict, concerns?, reviewedBy, reviewedAt }
}
```

**Notes:**
- `block` only flips the task back to `PLANNING` when its current status is `AWAITING_APPROVAL` or `WORKING`. If a human has already advanced the task past those, the critique becomes purely advisory.
- On `block`, posts `🚫 plan blocked on <id>` to `#architects` (with bulleted concerns) and a one-line summary to `#governors`. On `pass`, posts `✅ critique passed: <id>` to `#governors`.
- Clears `task.pendingPlanCritique` once a critique lands (idempotent).

---

## Plugin WebSocket Messages

The JetBrains/VS Code plugin talks to the daemon over `/ws` using typed JSON envelopes (`{ type, payload? }`). The full list lives in `packages/moe-daemon/src/server/WebSocketServer.ts`; the entries below cover this session's additions.

### `GET_METRICS` → `METRICS`

Dashboard query for per-epic + project-wide metrics.

**Request:**
```typescript
{ type: 'GET_METRICS', payload?: { epicId?: string, sinceIso?: string } }
```

**Response:**
```typescript
{
  type: 'METRICS',
  payload: {
    firstPassApprovalPct?: number,     // omitted when no DONE tasks
    avgWallClockMs?: number,           // omitted when no completed tasks have wall-clock data
    avgReopenCount?: number,           // omitted on empty task set
    totalCompleted?: number,
    perEpic: Array<{
      epicId: string,
      epicTitle?: string,
      completed: number,
      avgReopenCount?: number,
      avgWallClockMs?: number
    }>
  }
}
```

`sinceIso` must be a parseable ISO 8601 timestamp or the server returns `{ type: 'ERROR', message: 'GET_METRICS sinceIso must be ISO 8601' }`. Optional aggregate fields stay `undefined` (not zero) when nothing has happened yet, so the UI can render empty-state cells.

### `AGENT_TOOL_EVENT` (one-way)

Fire-and-forget telemetry emitted by `@moe/claude-plugin`'s `PostToolUse` hook. The daemon writes one `AGENT_TOOL_EVENT` activity-log entry per message and does not respond.

**Message:**
```typescript
{
  type: 'AGENT_TOOL_EVENT',
  payload: {
    workerId?: string,   // defaults to "unknown"
    tool?: string,       // defaults to "unknown"
    args?: unknown,      // currently ignored by the daemon
    result?: unknown,    // currently ignored by the daemon
    durationMs?: number
  }
}
```
