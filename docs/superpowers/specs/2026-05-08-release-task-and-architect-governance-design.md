---
date: 2026-05-08
status: approved
authors: yaront1111
---

# Release Task + Architect Governance Mode

Two related additions to the Moe daemon:

1. A new MCP tool `moe.release_task` that unassigns a task from its agent without changing status.
2. A new "governance mode" for architects that activates automatically when no PLANNING tasks remain, lets them oversee in-flight work via chat, and resumes planning when new PLANNING tasks appear.

## Motivation

**Release task.** Today there is no clean way for an agent (or a human) to hand a task back. The only options are (a) `setTaskStatus` (changes status, often wrong), (b) `unblockWorker` (only works from BLOCKED), or (c) editing JSON by hand. Workers stuck on a task they can't progress have no exit ramp; humans can't easily yank a task off an unresponsive agent.

**Architect governance.** After the architect finishes the last PLANNING task, they go idle and stop being useful. But planning produces in-flight work that benefits from continued architect attention: workers hit ambiguities, plans drift, QA rejects things that need re-planning. We want the architect to remain engaged — watching chat, scanning WORKING/REVIEW tasks for drift, and re-planning when needed — until new PLANNING work appears.

## Feature 1 — `moe.release_task`

### Tool contract

```
Name:    moe.release_task
Input:   { taskId: string, reason?: string }
Output:  {
  success: boolean,
  taskId: string,
  previousWorkerId: string | null,
  status: TaskStatus,
  message: string
}
```

### Behavior

1. Look up task by `taskId`. If not found → `notFound('Task', taskId)`.
2. Capture `previousWorkerId = task.assignedWorkerId`.
3. If `previousWorkerId` is null, return `{ success: true, ... message: "Task already unassigned" }` (no-op success).
4. Otherwise, run inside `state.runExclusive` to avoid races with `claim_next_task`:
   - `state.updateTask(taskId, { assignedWorkerId: null }, 'WORKER_RELEASED')`
   - If `state.getWorker(previousWorkerId)` exists and `worker.currentTaskId === taskId`, also `state.updateWorker(previousWorkerId, { currentTaskId: null, status: 'IDLE' })`.
5. Post system message to `#general` via `state.postToGeneral`: `` `${previousWorkerId} released task: ${task.title}${reason ? ` (${reason})` : ''}` ``.
6. Return success payload. Status is **unchanged**.

### Authorization

No authorization check. Anyone — agent, human via plugin, MCP client — can call it. (Decision: kept simple; later restrictions can be layered if abuse appears.)

### Schema additions

- `ActivityEventType` gains `'WORKER_RELEASED'`. Activity log entry shape: `{ type: 'WORKER_RELEASED', taskId, previousWorkerId, reason?, ts }`.

### Tests

`packages/moe-daemon/src/tools/releaseTask.test.ts`:

- Releases an assigned task → `assignedWorkerId` cleared, status preserved.
- Releases a task whose assigned worker has it as `currentTaskId` → worker becomes IDLE with `currentTaskId: null`.
- Releases a task whose assigned worker is on a different task → that worker is **not** modified.
- Releases an already-unassigned task → no-op success, no log entry beyond what was already there.
- Unknown taskId → `notFound`.
- Concurrent release + claim_next_task → exactly one wins (mutex test).

## Feature 2 — Architect Governance Mode

### State changes

- New `WorkerStatus` enum value: `'GOVERNING'`. Plugin board treats it like `IDLE` for layout but renders a distinct badge ("🧭 governing"). For v1, JetBrains/VSCode rendering changes are out of scope — adding the enum is sufficient; existing IDLE rendering will fall through.

### Tool: `moe.enter_governance`

```
Name:    moe.enter_governance
Input:   { workerId: string }
Output:  {
  success: boolean,
  workerId: string,
  status: 'GOVERNING',
  channels: { id: string, name: string }[],
  governanceDuties: string[],
  nextAction: { tool: 'moe.chat_wait', args: {...}, reason: string }
}
```

#### Behavior

1. Validate `workerId` exists. If not → `notFound('Worker', workerId)`.
2. `state.updateWorker(workerId, { status: 'GOVERNING', currentTaskId: null })`.
3. Auto-join the worker to `#architects`, `#workers`, `#qa`, `#general` (skip any they're already in). Reuses existing `state.addChannelMember` (or equivalent — confirm during implementation).
4. Post system message to `#general`: `` `🧭 ${workerId} is now governing — @mention them on plan questions, drift, or rejections.` ``
5. Post system message to `#architects`: same.
6. Return payload with `governanceDuties`:
   - `"Watch #architects, #workers, #qa, #general for @mentions and questions."`
   - `"Reply to any @mention via moe.chat_send before any other tool call (Mention Response Protocol)."`
   - `"Periodically scan list_tasks {statuses:[WORKING, REVIEW]} for plan drift; nudge workers in chat if drifting."`
   - `"If a new PLANNING task appears (you'll see it announced in #architects), call claim_next_task to resume planning."`
   - `"For QA rejections that require re-planning, use moe.set_task_status to flip the task back to PLANNING."`
7. `nextAction.tool = 'moe.chat_wait'`, args = `{ workerId, channels: [<the four channel ids>], timeoutMs: 60000 }`.

### Auto-trigger from `claim_next_task`

Modify `claimNextTask.ts`. When `statuses` includes `'PLANNING'` (and includes only planning-y statuses, i.e. is an architect-style claim) AND no claimable PLANNING tasks exist:

- If a worker entity exists for `params.workerId` (i.e. they were previously online as an architect), substitute the current `wait_for_task` `nextAction` with:
  ```
  nextAction: {
    tool: 'moe.enter_governance',
    args: { workerId: params.workerId },
    reason: 'No PLANNING tasks left. Switch to governance: oversee in-flight work via chat until new plans are needed.'
  }
  ```
- If `params.workerId` is missing or the worker entity is unknown, retain existing `wait_for_task` behavior. (A first-time caller hasn't established themselves as an architect yet.)

### Auto-resume planning via chat bus

When a task transitions **into** PLANNING status, post to `#architects`:

```
📋 New plan needed: ${task.title} (${task.id}) — claim with moe.claim_next_task {workerId, statuses:["PLANNING"]}
```

Trigger sites:

- `createTask.ts` — when a created task's initial status is PLANNING.
- `setTaskStatus.ts` — when a status transition lands on PLANNING.
- (Anywhere else in the codebase that sets a task to PLANNING — search during implementation.)

The architect's `chat_wait` fires on the new message; they read it; they call `claim_next_task`; the regular planning loop resumes. The daemon does not need a dedicated subscription/wake-up — chat is the bus.

### How agents know the architect is talking

Three layers, mostly already in place:

1. **Governance-entry broadcast** to `#general` (above) — one-time, visible to everyone.
2. **@mentions** — when an architect uses `@worker-id` or a group mention like `@workers` in chat, the existing MentionRouter delivers a `<routed_mentions>` banner to the recipient's next preflight.
3. **Mention Response Protocol** — already enforced by worker/QA role docs (per project memory): tagged agents must reply via `moe.chat_send` before any other tool call.

No new mention-routing code is needed. Verify during implementation that `MentionRouter` already handles the architect → worker mention path; if not, that gap is a separate fix.

### Tests

`packages/moe-daemon/src/tools/enterGovernance.test.ts`:

- Unknown workerId → `notFound`.
- Known architect worker → status becomes `GOVERNING`, `currentTaskId` cleared, joined to all four channels, system messages posted to `#general` and `#architects`, response carries `chat_wait` nextAction with the four channel ids.
- Already in `GOVERNING` → idempotent: still returns success, no duplicate channel-joins, no duplicate broadcast (or: broadcast once per entry — pick "broadcast every entry, idempotent join" for v1, document accordingly).
- Channels missing (fresh project) → tool still succeeds, joining only the channels that exist.

`claimNextTaskTool` test extension:

- PLANNING claim with workerId, no claimable tasks, worker entity exists → response `nextAction.tool === 'moe.enter_governance'`.
- Same conditions but worker entity does **not** exist → response `nextAction.tool === 'moe.wait_for_task'` (existing behavior preserved).

`createTaskTool` / `setTaskStatusTool` test extensions:

- Creating a task with status PLANNING → `#architects` receives the "New plan needed" system message.
- Flipping a task into PLANNING → `#architects` receives the message.
- Flipping a task **out of** PLANNING → no message.

## Files to touch

| File | Change |
|------|--------|
| `packages/moe-daemon/src/tools/releaseTask.ts` | NEW — tool implementation |
| `packages/moe-daemon/src/tools/releaseTask.test.ts` | NEW |
| `packages/moe-daemon/src/tools/enterGovernance.ts` | NEW |
| `packages/moe-daemon/src/tools/enterGovernance.test.ts` | NEW |
| `packages/moe-daemon/src/tools/index.ts` | Register `release_task`, `enter_governance` |
| `packages/moe-daemon/src/tools/claimNextTask.ts` | Empty-PLANNING branch suggests `enter_governance` for known architects |
| `packages/moe-daemon/src/tools/createTask.ts` | On PLANNING creation → broadcast to `#architects` |
| `packages/moe-daemon/src/tools/setTaskStatus.ts` | On transition to PLANNING → broadcast to `#architects` |
| `packages/moe-daemon/src/types/schema.ts` | Add `'WORKER_RELEASED'` event type, `'GOVERNING'` worker status |
| `packages/moe-daemon/src/state/StateManager.ts` | Confirm or add helper for system-posting to a named channel; reuse if present |
| `packages/moe-proxy/...` | Verify tools auto-bridge via JSON-RPC (no allowlist edit usually needed; check) |
| `docs/roles/architect.md` | Add **Governance Mode** section: trigger, duties, dual loop |
| `docs/MCP_SERVER.md` | Document `moe.release_task`, `moe.enter_governance` |
| `docs/SCHEMA.md` | Document `WORKER_RELEASED`, `GOVERNING` |
| `CLAUDE.md` | Add the two tools to the MCP tool list |

## Out of scope (v1)

- Dedicated re-plan tool. v1 uses `set_task_status` back to PLANNING.
- Plugin/VSCode UI changes for the `GOVERNING` badge — IDLE rendering is acceptable until visual treatment is requested.
- Auto plan-drift detection (heuristics on task progress vs plan steps). Architect performs drift checks manually via `list_tasks`.
- Authorization on `release_task`. Currently anyone can release anything.

## Open questions

None. All decisions captured above.
