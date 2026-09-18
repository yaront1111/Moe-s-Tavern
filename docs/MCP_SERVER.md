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

When `task.assignedWorkerId` is `null`, the guards are no-ops for every call without a `workerId`, preserving `--no-auto-claim` interactive flows and the JetBrains plugin `/ws` path (which never carries a `workerId`). They are also no-ops there for `submit_plan`, `qa_approve` and `qa_reject`, with or without a `workerId`.

**Claimed row required.** `start_step`, `complete_step` and `complete_task` refuse a supplied `workerId` on an unassigned row. The refusal is `STATE_CONFLICT` (`-32002`, codeName `TASK_NOT_CLAIMED`), not `NOT_ALLOWED`, because the caller becomes entitled once it claims: it is retryable, and its message names `moe.claim_next_task { taskId, statuses: ["WORKING"], workerId }`. It fires before the other guards (the get_context check included) and before anything is written, so a worker record never points at a row its worker does not hold. See `moe.start_step`.

Three tools are deliberately **guard-exempt** even though the proxy injects `workerId` into them: `moe.get_commit_scope`, `moe.record_commit` and `moe.declare_files`. The wrapper calls the first two **after** the CLI exits — by then QA may already own the REVIEW task, a seat-only `unblock_worker` may have left it unassigned, or the task may be `BLOCKED`/`DONE` — and a governor uses `declare_files` on tasks it never owns. They are allowed in every task status.

`moe.record_candidate` is likewise exempt from the ownership guard and allowed in every task status, for the same post-`complete_task` reason. Instead, the **attempt** fence guards it: a caller whose attempt has been superseded cannot record (see its section).

`moe.record_check_run` has no ownership, status or attempt gate at all: a runner reports checks after `complete_task`, and a report may arrive after the attempt that offered the bytes has closed, when QA may already own the task (no other seat can claim the task while that attempt is still `finalizing`). Binding guards it instead: the named candidate must exist and the reported tree must be exactly that candidate's (see its section).

`moe.record_delivery_receipt` has no ownership, status or attempt gate either: the wrapper reports a landing after `complete_task`, and a replayed report may arrive after its attempt has closed, when QA may already own the task. The candidate is the binding, with at most one receipt per candidate: an identical report replays and writes nothing, and a contradicting one is refused (see its section).

**Close on hand-back.** A write that turns a task's `assignedWorkerId` from a worker into `null` also closes that task's `running` and `reconciling` execution attempts, in the same daemon write path, so a seat that gave its task up keeps no open attempt. That covers the status changes that clear the seat (`qa_reject`, `qa_approve`, `submit_plan`, `request_replan`, a critique `block` flip, a seat-freeing `report_blocked`, `set_task_status`) and the explicit unassigns that change no status (`unblock_worker`'s seat-only arm, `qa_reject`'s park for a human, the sweeps' releases, and a dependency or resource restore that returns the row unassigned because its recorded owner is gone). `release_task` and `deregister_worker` already closed every open attempt of the tasks they release, and still do; worker deletion and the startup purge release by this hand-back rule, so they close `running` and `reconciling` but never another worker's `finalizing` attempt. `deregister_worker` also closes its own worker's `finalizing` attempts, which sit on rows `complete_task` already unassigned. A `finalizing` attempt survives a hand-back: `complete_task` parks its attempt in `finalizing` before its own `WORKING → REVIEW` write clears the seat, and that landing hold ends only through the paths `moe.finalize_attempt` lists under **Every end of a finalizing attempt**. No other seat can own the row meanwhile: `moe.claim_next_task` refuses or skips it (see its **Finalizing hold on the task**). A claim, a kept seat (a resource-parked `report_blocked`, the two `BLOCKED` edges of `set_task_status`, a restore onto the same worker) and a same-worker write close nothing. A close that fails is logged and never fails the tool; the next claim of the row closes a `running` or `reconciling` leftover before opening its own, never another worker's `finalizing` attempt. The closes that ride on the REVIEW self-heal and the blocked-timeout sweep are consequences of those pre-existing, sanctioned releases, not a new idle-based decision. A daemon restart applies the matching rule to attempts already on disk — see `moe.reattach_attempt`.

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

### Tool names on the wire

The daemon registers every tool as `moe.<name>`. What the agent sees depends on its CLI: Claude Code
sanitises to `mcp__moe__moe_<name>`; codex and gemini pass `moe.<name>` through; Grok Build drops any
tool whose name contains a dot, so its launcher runs `moe-proxy` with `MOE_TOOL_NAME_STYLE=underscore`,
which exposes `moe_<name>` in `tools/list` and maps the alias back on `tools/call` (grok then addresses
it as `moe__moe_<name>` through `use_tool`). Regardless of style, the proxy accepts a `moe_<name>` call
and forwards it as `moe.<name>` — no daemon tool is ever spelled with an underscore prefix.

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
    planSizeWarnings?: string[],        // present when the latest submit_plan drew warn-zone size warnings
    verification: { command, exitCode, outputTail?, reportedAt, source: "agent-reported" } | null, // complete_task evidence — QA re-runs the command; always agent-reported (see Verification provenance)
    completionSummary?: string,         // worker's complete_task summary (≤2000 chars) — persisted, no longer discarded
    dependsOn?: string[],               // structural prerequisites (create_task / set_task_dependencies) — gate WORKING-status claims until all are DONE/ARCHIVED
    dependsOnUnmet?: string[],          // the dependsOn subset not yet DONE/ARCHIVED (present alongside dependsOn)
    blockedOnTaskIds?: string[],        // BLOCKED tasks only (with the other blocked* fields): what this row waits on (report_blocked param ∪ ids auto-parsed from the reason) — auto-unblocks when all are DONE/ARCHIVED
    filesModified: string[],            // ASSERTED paths: completed steps' modifiedFiles ?? affectedFiles (complete_task) ∪ non-inferred paths landed via record_commit
    declaredPaths?: string[],           // the full ASSERTED tier (completed steps' modifiedFiles ?? affectedFiles ∪ filesModified ∪ declaredFiles ∪ touchedFiles ∪ non-inferred committed paths) — what the wrapper commits regardless of baseline; NOT just the moe.declare_files list
    inferredPaths?: string[],           // MEASURED-tier paths the wrapper landed; never promoted to asserted
    unattributedPaths?: string[],       // changed paths the last landing could not attribute (reported, never staged) — claim them with moe.declare_files
    commits?: Array<{ sha, treeId?, ref, kind: "completion" | "checkpoint" | "rescue", status?, pushed?, recordedAt, recordedBy, pathCount, inferredCount }>, // bounded projection of task.commits (moe.record_commit)
    lastCommitOutcome?: { outcome: "committed" | "nothing" | "refused" | "failed", kind, code?, sessionId, at },
    landing?: { lastCompletion?: { sha, ref, pushed, recordedAt }, lastCheckpoint?: { sha, recordedAt } },
    rescueRefsHint?: string,            // present when any commit is kind "rescue": how to recover from refs/moe/rescue/<taskId>/*
    epicSiblings?: Array<{ id, title, order, status, landing?: { lastCompletion? }, landed: boolean,
                           verification?: { command, exitCode, reportedAt, source: "agent-reported" } | null, reviewSummary?: string, completionSummary?: string }>,
                                        // same epic, lower order, ≤20 — PLUS every task named by this task's dependsOn/blockedOnTaskIds,
                                        // regardless of the lower-order filter and the 20-cap; landed = a pushed completion commit or
                                        // status REVIEW/DONE. Prerequisite evidence is READ HERE — never via HEAD greps
    isEpicFinal?: boolean,              // highest order among the epic's siblings — the wrapper's qualityGateScope 'epicFinal' rule; wrappers prefer this over their RPC+python fallback
    rejectionHistory?: RejectionHistoryEntry[], // present when non-empty; 5 most recent, newest first
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
  currentCandidate?: Candidate,  // the task's CURRENT candidate — the whole stored record
                                 // (.moe/candidates/<id>.json), not a projection. Selected as the
                                 // last by createdAt then id, the same rule record_candidate lists
                                 // by. Surfaced whenever a candidate exists, at any status; the key
                                 // is OMITTED (never null) when the task has none. QA passes its
                                 // `id` to qa_approve/qa_reject to bind the decision to these bytes.
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

**Reviewed bytes.** `currentCandidate` is the record QA must read before signing off, and its `id` is what `moe.qa_approve` / `moe.qa_reject` bind the decision to. Because it is re-resolved on every call, a reviewer who re-reads a task after the runner recorded a newer candidate sees the new one — and an approval still naming the old one is refused with `CANDIDATE_MISMATCH`. Projects that never call `moe.record_candidate` never see the key.

**Verification provenance.** `task.verification` is the completing agent's own `complete_task` claim, bound to no candidate or tree, so both projections — `task.verification` and a declared prerequisite's `epicSiblings[].verification` — carry `source: "agent-reported"` whatever the stored row says. A row persisted before the label existed, or one hand-edited to claim `runner-observed`, reads the same way. The label is set on a fresh copy and never written back. Absent verification is `null`, and the compact `epicSiblings` projection still omits `outputTail`. Runner-observed results for a candidate's exact tree are a separate record, written with `moe.record_check_run`.

**Commit evidence.** `commits`/`landing`/`lastCommitOutcome` come from the wrapper's `moe.record_commit` reports (the daemon never runs git). A prerequisite task has landed iff `epicSiblings[*].landed` is true — or `git log <branch> --grep 'Moe-Task: <sibling>'` finds it; uncommitted work in a peer's checkout is not a prerequisite. For a `REVIEW` task the `nextAction` reason tells QA to confirm a completion commit is recorded in `task.commits` (`git show <sha>`) before approving. A RESUME context lists `unattributedPaths` with a `moe.declare_files` hint so the resuming session can claim what its predecessor forgot to report.

---

### moe.submit_plan

Submit an implementation plan. Sets task status to `AWAITING_APPROVAL`.

**Parameters:**
```typescript
{
  taskId: string,
  workerId?: string,    // Optional; auto-injected by moe-proxy from MOE_WORKER_ID
  steps: { description: string; affectedFiles?: string[]; newFiles?: string[] }[],
  planningNotes?: { approachesConsidered?, codebaseInsights?, risks?, keyFiles? }
}
```

`affectedFiles` paths must be project-relative (no absolute paths, no `..` traversal); the daemon normalizes separators and deduplicates. At claim time, overlapping affectedFiles across WORKING tasks surface as a `fileCollision` warning on `moe.claim_next_task` — advisory only, the claim still succeeds.

`newFiles` declares the paths a step will **create**. Same normalization and 50-entry cap as `affectedFiles`; the key is omitted from the persisted step when empty.

**Notes:**
- **Enforced rails:** Only `forbiddenPatterns` and global `requiredPatterns` are strictly enforced.
- **Guidance rails:** `epicRails` and `taskRails` are provided as guidance to AI agents but are NOT enforced in plan text. This allows agents to address the intent of rails without requiring verbatim quoting. Humans verify compliance during plan approval.
- On violation, returns JSON-RPC error with `message: "RAIL_VIOLATION"` and `error.data` set to the violation string.
- **Step bounds:** max 100 steps, each `description` ≤10000 chars, each `affectedFiles` and `newFiles` ≤50 entries.
- **Affected-path existence gate:** every `affectedFiles` entry must exist on disk under the project root, unless some step declares it in `newFiles`. A plan citing a path that exists nowhere is rejected with `INVALID_INPUT`, `context.missingPaths`, `context.projectRoot`, and a message teaching both fixes — correct the path (they are relative to the PROJECT ROOT, so `packages/moe-daemon/src/x.ts`, not `src/x.ts`) or declare files this task creates in that step's `newFiles`. The exemption is plan-wide, so a file created in step 1 may be cited by step 2. `newFiles` still count toward the distinct-file total (deduped against `affectedFiles`) and are still scanned by the rails check, so declaring a path new cannot dodge either gate. The check runs after the rails and plan-size gates, and fails open: an unreadable project root, or any stat error other than `ENOENT`/`ENOTDIR`, is treated as "exists".
- **Plan-size gate:** oversized plans are rejected with `CONSTRAINT_VIOLATION` — more than 12 steps or more than 10 *distinct* affected files (union across steps) — with `suggestedAction` pointing at `moe.create_task` ("split the task"). Past the softer thresholds (8 steps / 5 distinct files) the response carries a `warnings: string[]` array instead. Thresholds configurable via `project.json` `settings.taskSizing { warnSteps, maxSteps, warnDistinctFiles, maxDistinctFiles }`.
- Plan submission refreshes `metrics.plannedStepCount`.
- **CONTROL mode side effect:** the daemon posts `📋 Plan ready for critique — <title> (<id>)` to `#governors` with the step count, distinct-file count, any size warnings, a size rubric line, and a DoD preview. If at least one registered governor exists, `task.pendingPlanCritique` is set to record who is expected to weigh in. Critique is informational; humans still own approval.
- **Warn-zone persistence + unsupervised size critique:** warn-zone warnings are persisted as `task.planSizeWarnings` (cleared by a compliant resubmit). With `settings.taskSizing.autoCritique: true`, CONTROL mode, and NO governor online, the daemon auto-blocks a warn-zone plan back to `PLANNING` (verdict recorded as `planCritiqueResult` by `moe-daemon-size-critic`, bounded by the same `critiqueBlockCount` cap as governor blocks; at the cap the task rests in `AWAITING_APPROVAL` with a `🛑 HUMAN DECISION REQUIRED` post). The response's `status` is then `"PLANNING"` and `nextAction` routes to a re-plan via `moe-epic-breakdown`.

**Returns:**
```typescript
{ success: true, taskId, status: "AWAITING_APPROVAL", stepCount, distinctFileCount, newFileCount, planRevision, warnings?: string[], message, nextAction }
```
- `planRevision` is the revision this submission committed (read from the write's own Task, not a later cache read). It is the token a client sends back as `expectedPlanRevision` when it later approves the plan — see [Plan approval — `expectedPlanRevision` compare-and-swap](#plan-approval--expectedplanrevision-compare-and-swap).

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

**Claimed row required.** When the call carries a `workerId`, the task must be assigned to that worker:
- On a `WORKING` task whose `assignedWorkerId` is `null`, the call is refused with `STATE_CONFLICT` (`-32002`, codeName `TASK_NOT_CLAIMED`) before every other guard, including the get_context check. Nothing is written: the step stays `PENDING`, and the caller's worker record (`status`, `currentTaskId`) is not touched. Before this rule the call succeeded and stamped the caller `CODING` on a row it never claimed, with no attempt opened.
- The refusal is retryable. Claim the row with `moe.claim_next_task { taskId, statuses: ["WORKING"], workerId }`, call `moe.get_context` if this worker has not fetched it yet, then retry. The error message names the claim call because `MoeError` context does not cross MCP; in-process callers also get `context.retryable: true` and `context.nextAction`.
- A `workerId` that differs from a set `assignedWorkerId` is still refused with `NOT_ALLOWED`.
- A call without a `workerId` (the JetBrains plugin `/ws` path, legacy clients) keeps the old tolerance.

**Returns:**
```typescript
{ success: true, taskId, stepId, stepNumber, totalSteps }
```

---

### moe.complete_step

Mark a step as `COMPLETED`. Appends `stepId` to `task.stepsCompleted` (de-duplicated).

**Parameters:**
```typescript
{
  taskId: string,
  stepId: string,
  modifiedFiles?: string[],   // EVERY project-relative path this step created or modified — omitting it draws a `warning`
  note?: string,
  workerId?: string
}
```

**Returns:**
```typescript
{
  success: true,
  taskId,
  stepId,
  warning?: string,                   // present when modifiedFiles was omitted: report every touched path
  progress: { completed, total, percentage },
  effectiveDescription: string,       // what the worker was actually told to do (amendment-resolved)
  amended?: {                         // ABSENT unless an amendment is active on the completed step
    amendmentId, reason, amendedBy, amendedAt
  },
  nextStep: { stepId, description } | null   // description is amendment-resolved too
}
```

**Notes:**
- `effectiveDescription` is the amended text when the step has an active amendment (see `moe.amend_plan_step`), otherwise the step's planned `description`. The chat line posted for the completion uses the same text, so a worker following an amendment does not read as plan drift.
- `amended` is omitted entirely (not `false`/`null`) on unamended steps, so existing consumers see an unchanged shape.
- `nextStep.description` and the `nextAction` reason are amendment-resolved as well — the worker is pointed at the amended work, never the superseded work.
- `modifiedFiles` is the worker's positive assertion and feeds the **ASSERTED** attribution tier: the wrapper's post-flight commits every completed step's `modifiedFiles ?? affectedFiles` regardless of what its baseline says. Omitting it returns `warning`. The wrapper can still pick up unreported edits through the TOOL (stream-json harvest, claude only), PLANNED (plan-declared and changed) and MEASURED (undeclared and changed, solo only) tiers — but with another worker active an undeclared, non-tool-written edit stays **unattributed** (reported as `MOE_ATTRIBUTION_UNRESOLVED`, never staged) until someone declares it via `moe.declare_files`.
- **Claimed row required**, the same rule as `moe.start_step`: a `workerId` on an unassigned `WORKING` row is refused with `STATE_CONFLICT` (`TASK_NOT_CLAIMED`) before the get_context check. The step stays `IN_PROGRESS`, nothing is recorded (no `note`, `modifiedFiles`, `stepsCompleted` or step metrics), and the caller's worker record is untouched.

---

### moe.amend_plan_step

**Architect/governor only.** Amend ONE plan step in place — correct or re-scope a step's instructions without a full re-plan. `description` **replaces** the step's instructions (full text, not a delta); the step's original `description` is never mutated, so the audit trail of what was first asked survives.

**Parameters:**
```typescript
{
  taskId: string,        // required
  stepId: string,        // required
  description: string,   // required — FULL replacement instructions (non-empty, ≤5000 chars)
  reason: string,        // required — why; posted to the assigned worker (non-empty, ≤2000 chars)
  workerId?: string      // caller (auto-injected by proxy) — the role gate reads it
}
```

**Notes:**
- **Role gate:** the caller must act as `architect` or `governor`, else `NOT_ALLOWED`. The role is the caller's team role when the team has one, else the role its worker id declares by prefix (`architect-…`/`governor-…`, the launcher's naming — `util/workerRole.ts`), so a seat on a role-less team keeps the role it was launched with. A missing or unknown `workerId` has neither and therefore fails closed — a worker cannot rewrite its own instructions.
- Rejects a `DONE`/`ARCHIVED` task (`INVALID_STATE`) and a step whose status is `COMPLETED` (`INVALID_STATE`, message points at `moe.request_replan` — amending shipped work would rewrite history).
- Rejects the 11th amendment on one step (`NOT_ALLOWED`, max 10): a step amended that many times is a re-plan, so it points at `moe.request_replan` too.
- Appends the amendment to `step.amendments` and sets `step.activeAmendmentId` to it. **Step status is never changed** — a worker mid-step is not reset.
- Best-effort chat: `@{assignedWorkerId} ✏️ step {stepId} amended on {taskId}: {reason}` to `#general` (the mention wakes the worker's wait) and `#workers`. A chat failure never fails a persisted amendment.
- Amendment **approval** flows are deliberately out of scope — an amendment takes effect immediately.

**Returns:**
```typescript
{
  success: true,
  taskId, stepId,
  amendmentId: string,            // "amend-1", "amend-2", …
  amendmentCount: number,         // amendments now on the step
  effectiveDescription: string,   // == the new description
  previousDescription: string,    // what was in force before (original, or the prior amendment)
  message: string
}
```

---

### moe.complete_task

Mark a task as `REVIEW` (complete) and optionally attach a PR link. Requires task to be in `WORKING` status, caller to own the task, every implementation step to be `COMPLETED`, and **verification evidence** from a fresh run of the plan's verification command.

**Parameters:**
```typescript
{
  taskId: string,
  verification: {          // REQUIRED — attestation of a fresh verification run
    command: string,       // the exact command that was run (≤500 chars)
    exitCode: number,      // must be 0 — a non-zero exit code is rejected
    outputTail?: string    // tail of its output (kept to the last 2000 chars)
  },
  prLink?: string,
  summary?: string,        // persisted as task.completionSummary (capped at 2000 chars, like qa_approve's summary)
  currentBranch?: string,  // branch the worker is on; enables the consolidationBranch check
  workerId?: string
}
```

**Notes:**
- **Claimed row required**, the same rule as `moe.start_step`: a `workerId` on an unassigned `WORKING` row is refused with `STATE_CONFLICT` (`TASK_NOT_CLAIMED`) before the step, verification and branch-policy checks, before any open attempt is moved to `finalizing`, and before the `REVIEW` write. The task stays `WORKING` with no verification persisted, and the caller's worker record is untouched.
- Missing/malformed `verification` → `MISSING_REQUIRED`/`INVALID_INPUT`; `exitCode !== 0` → `INVALID_INPUT` telling the worker to fix and re-run before completing.
- `summary` is persisted as `task.completionSummary` (it used to be accepted and silently discarded) and surfaced via `moe.get_context` — both on the task itself and on the `epicSiblings` entries of every dependent task, so a later task can read what its prerequisite actually delivered without grepping HEAD.
- The evidence is persisted as `task.verification` (with `reportedAt`, and `source: "agent-reported"` stamped after validation), and the union of completed steps' `modifiedFiles ?? affectedFiles` seeds `task.filesModified` — the ASSERTED attribution tier the wrapper commits regardless of its baseline; `moe.record_commit` later unions the non-inferred paths it actually landed. Both are surfaced to QA via `moe.get_context`, whose QA guidance is to re-run the command. The daemon never executes the command itself and never runs git.
- **Candidate-less, agent-reported evidence.** `task.verification` names no candidate or tree, so the daemon labels it `source: "agent-reported"` on every write and every read (see **Verification provenance** under `moe.get_context`). There is no `source` input: fields a caller adds inside `verification` are not stored. Validation is unchanged: `command` at most 500 characters, `exitCode` exactly 0, and the tail kept to its last 2000 *characters*, unlike the 16384-byte UTF-8 tail of a `CheckRun`. Runner-observed results for a candidate's exact tree are recorded separately with `moe.record_check_run`.
- **The commit happens after the CLI exits.** `complete_task` only flips the status; the wrapper's post-flight lands the completion commit (`feat|fix(task-<id>): <title>` with `Moe-Task`/`Moe-Kind: completion`/`Moe-Session`/`Moe-Status` trailers), pushes it and reports it via `moe.record_commit` seconds later. A QA that wakes on the REVIEW write can see an empty `task.commits` for that window — `qa_approve` warns (`NO-COMPLETION-COMMIT`) rather than rejecting. If QA raced ahead and the task is already `DONE` when the wrapper looks, the completion commit still lands (`Moe-Status: DONE`).
- **Branch policy** (`settings.consolidationBranch`, a literal branch name or a `*` glob such as `moe/work-*`; case-sensitive, anchored at both ends). Unset or empty disables the check entirely and no `branchPolicy` key appears in the response. When it is set there are three outcomes: `currentBranch` matches → completion proceeds and the response carries `branchPolicy: { pattern, currentBranch, matched: true }`; `currentBranch` does not match → `CONSTRAINT_VIOLATION` whose message starts `BRANCH-POLICY-FAIL:` and names both branches, thrown **before** the task update so the task stays `WORKING` with no verification persisted; `currentBranch` missing or blank → **never blocked**, a one-line warning is posted to `#governors` and the response carries `branchPolicy: { pattern, matched: null, warning }`.
- `currentBranch` is reported by the agent (the CLI), not by the wrapper: the wrapper's landing happens *after* this call, on the branch its safe-branch step picks (a literal `consolidationBranch` doubles as that peel target; otherwise `moe/work-<YYYY-MM-DD>`), and the branch it actually landed on arrives afterwards as `record_commit.ref` / `task.commits[].ref`. That is why an absent `currentBranch` warns instead of failing.

**Returns:**
```typescript
{
  success: true, taskId, status: "REVIEW",
  stats: { stepsCompleted, totalSteps, filesModified, duration },
  branchPolicy?: { pattern: string, currentBranch?: string, matched: boolean | null, warning?: string }
}
```

---

### moe.finalize_attempt

**Runner-called.** Closes a task's execution attempt after the runner has reported its landing outcome, moving the attempt from `finalizing` to `closed`. `complete_task` hands the task to QA but deliberately leaves the attempt **open** in `finalizing`, because the bytes are only landed after the session exits and the wrapper commits them. This tool is the acknowledgement of that artifact boundary, and closing the attempt is what lifts the holds the open attempt imposes (see the notes).

**Parameters:**
```typescript
{
  taskId: string,           // task the attempt belongs to
  attemptId: string,        // the attempt to close, as returned by moe.claim_next_task
  generation?: number,      // fencing token from the same claim; when supplied it must equal the current attempt's
  outcome: 'landed' | 'nothing-to-commit' | 'rescued' | 'failed',   // what the runner's landing actually did
  landedRevision?: string,  // /^[0-9a-f]{40}$/i — REQUIRED when outcome is 'landed', refused as a bare ref name
  workerId?: string,        // worker seat that held the attempt (auto-injected by proxy)
  runnerId?: string         // wrapper/runner session reporting the landing
}
```

**Returns:**
```typescript
{ success: true, attemptId, taskId, generation, phase: "closed", outcome, landedRevision, message }
// landedRevision is null when the runner reported no landing
```

**Notes:**
- **The runner declares the bytes final, not the CLI's exit.** That is the whole point of an explicit operation: an interactive TUI seat stays open long after the work is landed, and a provider mode without one-shot semantics has no exit to infer anything from. Both would otherwise be stuck with an attempt nothing ever closes.
- **Closing lifts EVERY finalizing hold** — `moe.claim_next_task` refuses that worker's next task while it holds a finalizing attempt, and refuses (explicit `taskId`) or skips (ranked pool, and `moe.wait_for_task`) the task for every other seat; `moe.qa_approve` refuses that task's approval while the task has one; and a move of that task into `DONE` or `ARCHIVED` (`moe.set_task_status`, `moe.archive_task`, `moe.archive_epic`, the board) is refused while it has one. None of the holds depends on anything except the presence of a finalizing attempt, so this call is the deterministic way out of all of them. A real close — never the idempotent replay — publishes one `TASK_UPDATED` for the task, which wakes the waiters the hold kept parked.
- **Every refusing hold answers `-32002` / `ATTEMPT_FINALIZING`, and that refusal is NOT fatal.** Its `MoeError.context` carries `{ attemptId, generation, taskId, workerId, retryable: true }`, where `workerId` is the attempt's holder, not the refused caller. Note that **`context` is not forwarded over the MCP wire** (a wire refusal carries `{ code, message, data: { tool, codeName } }` only), so a remote caller keys on `codeName === 'ATTEMPT_FINALIZING'` — or on the message, which names the attempt and says the refusal is retryable. The holder's runner finalizes the attempt and retries; any other refused caller retries after that runner has finalized. Do not escalate.
- **Fenced.** An open attempt goes through `assertAttemptCurrent` with `attemptId`, plus `generation` when supplied, so a `generation` that does not match is refused `ATTEMPT_SUPERSEDED` and closes nothing. A superseded attempt is always `closed`, so it gets the idempotent answer below, not a refusal.
- **Idempotent.** A retry after a lost response is safe: when the attempt is already `closed` the call returns the same successful response and **writes nothing at all** — no second record, no touched `lastPhaseAt`, a byte-identical `.moe/attempts/<id>.json`. The already-closed answer is deliberately evaluated *before* the fence (the fence resolves the current attempt through a helper that ignores closed attempts, and would otherwise refuse the retry as superseded); it is not a fencing bypass, because closing an already-closed attempt changes nothing and every open case still goes through the guard.
- **Only a `finalizing` attempt may be closed here.** A `running` attempt is refused — closing it would hand the seat back with nothing landed, which is the exact race the hold exists to stop. `reconciling` belongs to the recovery slice.
- **The outcome is reported, not recorded.** `outcome` and `landedRevision` are echoed back but are **not** persisted: nothing is added to the `ExecutionAttempt` schema for them, and no activity event is appended. The only broadcast is the `TASK_UPDATED` a real close publishes: the task itself is unchanged, and the event exists so `moe.wait_for_task` waiters and the board see that the boundary ended. The durable landing record is the completion entry `moe.record_commit` writes into `task.commits`, plus the `moe.record_delivery_receipt` receipt of a gated landing. The daemon never consults git about either value, so it has verified neither — it checks `landedRevision`'s shape only.
- Not `blocking`, so dispatch serializes it under the state mutex like every other tool. There is no ownership or status gate: no other seat can claim the row until the attempt is finalized, but the task itself may have moved on (a human `moe.qa_reject` sends it back to `WORKING`), and the attempt fence is still the guard.
- **Escape for a runner that is gone.** Because there is no ownership gate, a governor or human can close an abandoned boundary — a runner killed with no exit trap, or an interactive seat whose window was closed without a post-flight — with `moe.finalize_attempt { taskId, attemptId, generation, outcome: 'failed' }`. That lifts the holds without claiming a landing. Nothing closes such a boundary automatically while its task exists and its worker record is not `DEAD`: the daemon never reads an idle signal for it (see **Every end of a finalizing attempt** below).
  - **Finding one.** The board shows the row's attempt phase as `finalizing`. The record is `.moe/attempts/<attemptId>.json` — read it, never edit it: `grep -l '"phase": "finalizing"' .moe/attempts/*.json` lists every open landing, each file naming its `id`, `taskId`, `workerId` and `generation`. A directed claim sent without a `workerId` — from a plain terminal with `MOE_WORKER_ID` unset, `scripts/moe-call.sh claim_next_task '{"statuses":["<row status>"],"taskId":"<taskId>"}'` — is refused with a message naming the holder, the attempt id and the generation, and writes nothing. A registered governor seat is redirected to `moe.enter_governance` before that check, so a governor reads the record instead.
  - **Before closing it,** confirm that the holder's wrapper is really gone. Closing a live runner's boundary lifts `moe.qa_approve`'s hold while its bytes are still unlanded. A wrapper that exits through its exit trap closes the boundary itself, with `moe.deregister_worker`.
- **Every end of a finalizing attempt.** These paths, and nothing else, close one:
  1. `moe.finalize_attempt` — by the runner, or by a governor or human with `outcome: 'failed'`: the escape above for a runner that vanished (SIGKILL, a closed console window, power loss), found by grepping `.moe/attempts` for `"phase": "finalizing"`.
  2. `moe.deregister_worker` by the attempt's own worker — keyed on the attempt, so it works after the worker record was pruned.
  3. Deletion of the attempt's task (`moe.delete_task`, the board's `DELETE_TASK`, a `moe.delete_epic` cascade), which closes every open attempt of that task before the task file goes.
  4. A daemon restart, when the attempt's task no longer exists (removed outside the daemon).
  5. Removal of the attempt's worker record while that record is `DEAD` — a `moe.deregister_worker` whose own close failed — by the stale-record prune or the startup purge.

  No idle signal ever closes one: a quiet seat keeps its hold, and `lastActivityAt` closes nothing — pruning or purging a record that is not `DEAD`, or releasing another seat's assignment of the row, leaves the attempt `finalizing`. A terminal move cannot strand one either: while the task has a finalizing attempt, `moe.set_task_status`, `moe.archive_task`, `moe.archive_epic` and the board refuse a move into `DONE` or `ARCHIVED` with retryable `-32002` / `ATTEMPT_FINALIZING`, before any write.

**Errors.** Every refusal writes nothing. JSON-RPC code, then `MoeError.codeName`:
- `-32001 TASK_NOT_FOUND`: unknown `taskId`
- `-32001 ATTEMPT_NOT_FOUND`: unknown `attemptId`
- `-32002 ATTEMPT_ID_TASK_MISMATCH`: the attempt exists but belongs to another task
- `-32002 ATTEMPT_SUPERSEDED`: `attemptId`/`generation` is not the task's current attempt
- `-32002 ATTEMPT_NOT_FINALIZING`: the attempt is open but in another phase
- `-32602 INVALID_INPUT`: an outcome outside the vocabulary, a `landedRevision` that is not 40 hex characters, or a `generation` that is not a positive integer
- `-32602 MISSING_REQUIRED`: `taskId`, `attemptId` or `outcome` is absent, or `landedRevision` is absent with `outcome: 'landed'`

---

### moe.reattach_attempt

**Runner-called.** Reattaches a runner to its own execution attempt after a daemon restart, moving the attempt from `reconciling` back to `running` and ending the hold on its task. A restarted daemon cannot see the processes the previous one was watching, so it parks every `running` attempt whose task is still assigned to that attempt's worker in `reconciling` and **holds** the task instead of releasing it (a `running` attempt whose seat already gave its task up is closed instead — see the Notes); this tool is how that hold ends in the good case.

**Parameters:**
```typescript
{
  taskId: string,            // task the attempt belongs to
  workerId: string,          // worker seat that owns the attempt (auto-injected by proxy)
  runnerId: string,          // wrapper/runner session driving the process
  attemptId: string,         // the attempt to reattach, as returned by moe.claim_next_task
  generation: number,        // fencing token from the same claim
  processStartedAt: string,  // the process start time EXACTLY as recorded on the attempt
  host: string               // the host EXACTLY as recorded on the attempt
}
```
All seven are required; `additionalProperties` is `false`.

**Returns:**
```typescript
{ success: true, attemptId, taskId, generation, phase: "running", message }
```

**Notes:**
- **A daemon restart now holds, it does not purge.** This is a deliberate change from the old purge-everything startup. On every start, *before* the worker purge, the daemon moves each `running` attempt whose task still exists and is still assigned to the attempt's worker to `reconciling`, and the purge then **spares** any worker seat that owns a non-closed attempt: its record stays on disk and in the map with its `currentTaskId` intact, and its task stays `WORKING` and assigned rather than being routed through the release path. A `running` attempt whose task is missing, unassigned or assigned to a different worker is **closed** at startup instead (logged at info with the row's current assignee), and so is a `reconciling` attempt an earlier restart parked whose task is in that state now: its seat had already given the task up, so there is no owner to hold the row for, and the purge does not spare that seat for it. A `reconciling` attempt whose task is still assigned to its worker is left exactly as it is, its window still measured from the original park. The deciding fact is the assignment alone, never presence or an idle signal. Previously a restart mid-build deleted the worker and handed live work to the next claimant.
- **`reconciling` means the daemon has lost sight of the execution — not that it thinks the process is alive, and not that it thinks it is dead.** It is the absence of both. Nothing in the hold consults `lastActivityAt` or any other idle signal, in either direction: a quiet build is not evidence of a dead worker.
- **All four identity elements must match exactly**: the attempt id, the `generation`, the recorded `processStartedAt` and the recorded `host`. `processStartedAt` is compared as the **exact stored string**, never parsed to a date — a re-serialised spelling of the same instant is refused, because parsing would silently widen the match. An attempt that recorded no `processStartedAt`/`host` can never be matched.
- **Where the recorded values come from.** The claim that opened the attempt, and nowhere else: `moe.claim_next_task` takes the same `processStartedAt`/`host` pair from the runner as an optional both-or-neither argument and records it verbatim (see its **Runner process identity**). The daemon derives, defaults and normalises nothing, so what this tool compares is exactly what some runner once sent. A claim that sent no pair — every non-runner caller, and every claim made before the pair existed — opens an attempt this tool can never match, which is the `processStartedAt (none recorded)` mismatch below. **The shipped wrappers call it**: their heartbeat sidecar when `moe.heartbeat` answers `attempt-reconciling` for the attempt they pinned, and their main loop right after a claim and right after the CLI exits for any `reconciling` attempt of the seat (see `moe.heartbeat`). An attempt whose claim predates the wrapper sending the pair stays unmatchable and is given up after `reconcileWindowMs` as before.
- **What a match does and does not prove.** Matching narrows **which process** the runner means: it rules out a reused pid, a stale session and another machine. It is **not** evidence that the process is alive — the daemon never probes a process, and nothing may treat these values as proof of liveness. What the match buys is that the seat is not handed to a stranger while its owner may still be mid-build.
- **Two refusals, both by name.** A wrong identity is `-32002` / **`ATTEMPT_IDENTITY_MISMATCH`**. A *competing* claim on a held task — an explicit-`taskId` `moe.claim_next_task` from any worker other than the holder, while the task is still assigned to that holder — is `-32002` / **`ATTEMPT_RECONCILING`**, raised before any eligibility check or assignment write (only a missing task answers `TASK_NOT_FOUND` first), so a refused claim never changes an owner. Unlike the worker-scoped finalizing hold (and like the finalizing hold on the task — see `moe.claim_next_task`), this one is scoped **by task, not by caller**: the whole point is to stop a *different* worker taking a task whose owner is still out there. It is retryable (`context.retryable: true`), and since `MoeError.context` is not forwarded over the wire, the message names the attempt; key on `codeName`.
- **Idempotent.** Reattaching an already-`running` attempt is a successful no-op that writes nothing — a byte-identical `.moe/attempts/<id>.json`, no touched `lastPhaseAt` — so a retry after a lost response is safe.
- **Writes only the attempt.** The task and the worker record are deliberately left alone: the hold's whole claim is that neither was ever disturbed, and writing them here would create a second source of truth for an ownership that never changed.
- Not `blocking`, so dispatch serializes it under the state mutex like every other tool.

**Errors.** Every refusal writes nothing and leaves the task, worker and attempt files byte-identical. JSON-RPC code, then `MoeError.codeName`:
- `-32001 ATTEMPT_NOT_FOUND`: unknown `attemptId`
- `-32002 ATTEMPT_ID_TASK_MISMATCH`: the attempt exists but belongs to another task
- `-32002 ATTEMPT_IDENTITY_MISMATCH`: the `generation`, `processStartedAt` or `host` differs from the recorded one, or the attempt recorded neither hint
- `-32002 ATTEMPT_NOT_REATTACHABLE`: the attempt is `closed` (terminal history, seat already given up) or `finalizing` (its bytes are still landing — call `moe.finalize_attempt` instead)
- `-32602 INVALID_INPUT`: a blank field, or a `generation` that is not a positive integer
- `-32602 MISSING_REQUIRED`: any of the seven parameters is absent

---

### moe.get_commit_scope

**Wrapper-called; not for agents.** Returns everything the agent wrapper's post-flight needs to attribute dirty paths to one task: the task's ASSERTED and PLANNED path tiers, every other live task's declared paths (PEER), which peers are active, the DENY/BOARD lists and the resolved commit policy. State-only — the daemon never runs git; the wrapper joins this with its own `git status` snapshot and the persisted per-task baseline (`<gitdir>/moe/baseline/<taskId>.tsv`). Attribution rules and codes: `docs/CONFIGURATION.md` → `autoCommit`, `docs/TROUBLESHOOTING.md` → `MOE_ATTR_*`.

**Parameters:**
```typescript
{
  taskId: string,                          // Required
  workerId?: string,                       // caller (auto-injected by proxy); counted in activePeerIds when it is not the assignee
  sessionId?: string,                      // "<workerId>@<preflight-iso>" — the Moe-Session trailer of the landing commit
  phase?: "preflight" | "postflight",
  since?: string                           // ISO; peers active since this instant (default: the 120s presence window)
}
```

**Returns:**
```typescript
{
  taskId, title, status, epicId, reopenCount, assignedWorkerId,
  assigneeAlive: boolean,
  asserted: string[],         // ⋃ COMPLETED steps' (modifiedFiles ?? affectedFiles) ∪ task.filesModified ∪ task.declaredFiles ∪ task.touchedFiles ∪ non-inferred commits[].paths
  planned: string[],          // ⋃ ALL steps' (affectedFiles ∪ newFiles ∪ modifiedFiles) ∪ task.inferredPaths, minus asserted
  touchedFiles: string[],
  inferredPaths: string[],
  unattributedPaths: string[],
  peerDeclared: { path: string, taskId: string }[],   // the same union over every OTHER task with status ∉ {DONE, ARCHIVED} —
                              // except a peer that waits on this task (dependsOn ∪ blockedOnTaskIds, transitively) contributes its
                              // asserted paths only: dependsOn gates it from WORKING until this task is DONE, so its plan is intent, not an edit
  livePeerIds: string[],      // workers ≠ caller, not DEAD, lastActivityAt inside the window (or registered since `since`)
  activePeerIds: string[],
  peersActive: boolean,
  alwaysInclude: string[],    // BOARD: .moe/tasks/<taskId>.json (always) + .moe/epics/*.json, .moe/project.json, non-live-peer task records (when commitBoardState)
  excludePrefixes: string[],  // settings.attribution.exclude ONLY, normalized (project-relative, trailing slash stripped). The built-in DENY list (.moe/** except BOARD, .mcp.json, .codex/**, .gemini/**, .grok/**, .claude/agents/**, .claude/settings.local.json, untracked .serena/**, .worktrees/**, .moe-worktree*) is hard-coded wrapper-side and never travels here.
  policy: {
    autoCommit, checkpointCommits, checkpointPush, commitBoardState, commitHooks,
    undeclared: "solo" | "never" | "always",
    contested: "skip-untouched" | "commit" | "skip"
  }
}
```

**Notes:**
- No ownership guard and no status restriction — the wrapper calls it at pre-flight and post-flight, including for a task QA already owns, an unassigned `BLOCKED` task, or a `DONE`/`ARCHIVED` task (the wrapper then deletes that task's baseline instead of landing).
- Paths are normalised like `affectedFiles` (`normalizeAffectedFiles`) and deduped by `pathKey` (case-folded on win32/darwin).
- When the RPC fails (older daemon, daemon down) the wrapper falls back to disk — its own `.moe/tasks/<id>.json` plus every other task record — with the policy forced to `undeclared: "never"` and `peersActive: true`: declared-only landing, never a sweep.

**Errors:**
- `taskId is required`
- `Task not found: <taskId>`

---

### moe.record_commit

**Wrapper-called; not for agents.** The post-flight reports every landing attempt here — committed, nothing to commit, refused, or failed — for completion commits, checkpoints and rescue refs. This is the daemon's commit ledger: it is what `qa_approve` audits, what `get_context.commits`/`landing`/`epicSiblings` project, and what `scripts/analyze-task-metrics.mjs --commits` joins against `git log --grep 'Moe-Task:'`.

**Parameters:**
```typescript
{
  taskId: string,
  outcome: "committed" | "nothing" | "refused" | "failed",
  kind: "completion" | "checkpoint" | "rescue",
  sha?: string,                 // /^[0-9a-f]{7,40}$/i — set for outcome "committed"
  treeId?: string,
  ref?: string,                 // branch name, or refs/moe/rescue/<taskId>/<ts> for kind "rescue"
  status?: string,              // task status the wrapper resolved (REVIEW/DONE/WORKING/BLOCKED/…/UNKNOWN)
  role: string,                 // worker | architect | qa
  workerId?: string,
  sessionId: string,            // "<workerId>@<preflight-iso>" — matches the commit's Moe-Session trailer
  cliExitCode?: number,
  pushed?: boolean,
  recoveredBy?: string,         // set when a different worker landed a lingering baseline (recovery checkpoint)
  paths?: string[],             // landed paths (≤500; `pathsTruncated` is recorded past that)
  inferredPaths?: string[],     // MEASURED-tier paths inside `paths`
  touchedPaths?: string[],      // tool-write harvest this session
  unattributedPaths?: string[], // changed-but-unattributed paths (reported, never staged)
  skipped?: { path: string, code: string }[],   // ≤100; code = MOE_ATTR_*
  contested?: { path: string, taskId: string }[],
  code?: string,                // MOE_COMMIT_* code for refused/failed
  message?: string
}
```

**Returns:**
```typescript
{ success: true, taskId, sha?, kind, outcome, duplicate?: boolean, commitCount, filesModified, addedPaths, warning? }
```

**Notes:**
- On `committed`: appends a `TaskCommit` to `task.commits` (idempotent by `sha` → `duplicate: true`; capped at `MAX_COMMITS_PER_TASK`, default 50, newest kept — same env pattern as `MAX_COMMENTS_PER_TASK`), unions `paths − inferredPaths` into `task.filesModified` (returned as `addedPaths`), `inferredPaths` into `task.inferredPaths` (never promoted to asserted), `touchedPaths` into `task.touchedFiles`, and **replaces** `task.unattributedPaths`.
- Every outcome — including `nothing`, `refused` and `failed` — sets `task.lastCommitOutcome = { outcome, kind, code?, sessionId, at }`, so "the wrapper never got here" is distinguishable from "it refused".
- Persisted with activity event `TASK_COMMIT_RECORDED`; refreshes the calling worker's `lastActivityAt`.
- Chat: one line to the task channel for every call; a `#governors` line (rate-limited to once per task per 24h) when `unattributedPaths` is non-empty, `kind` is `rescue`, or `outcome` is not `committed`/`nothing`. Chat failures never fail the record.
- `warning` when `kind === "completion"` and `paths` is empty.
- **Guard-exempt and status-agnostic**: allowed in every task status (`DONE`, `BLOCKED`, unassigned). See **Ownership & Ordering**.

**Errors:**
- `taskId is required` / `Task not found: <taskId>`
- `[INVALID_INPUT]` on a malformed `sha`, an unknown `outcome`/`kind`, or a missing `sessionId`/`role`

---

### moe.record_candidate

**Runner-called.** Freezes the exact bytes a task is offering for delivery as an immutable `Candidate` (docs/SCHEMA.md `## Candidate`), so that review and checks can bind to fixed bytes instead of to a moving working tree. Each candidate is one file at `.moe/candidates/<id>.json`. Check runs (`moe.record_check_run`), review decisions (`moe.qa_approve` / `moe.qa_reject` with `candidateId`) and delivery receipts (`moe.record_delivery_receipt`) bind to it.

**Parameters:**
```typescript
{
  taskId: string,          // must exist
  attemptId: string,       // the task's CURRENT execution attempt
  generation?: number,     // optional fencing token; when supplied it must equal the current attempt's generation
  id?: string,             // optional candidate id, [A-Za-z0-9_-]{1,128}. Supply one so a crash retry is idempotent;
                           // when omitted the daemon generates "cand-<32 hex>"
  baseRevision: string,    // /^[0-9a-f]{7,40}$/i: the commit the bytes were built on, as the runner observed it
  treeSha: string,         // /^[0-9a-f]{7,40}$/i: the tree or commit naming the offered bytes, as the runner observed it
  deliveryTarget: string,  // e.g. "refs/heads/wave1-pilot"; non-blank, no surrounding whitespace or control chars, ≤255 chars
  workerId?: string        // caller (auto-injected by proxy); not stored on the candidate
}
```

**Returns:**
```typescript
{ success: true, candidate: Candidate, duplicate: boolean }
// candidate: the stored record { id, attemptId, taskId, baseRevision, treeSha, deliveryTarget, createdAt }
// duplicate: true when an identical candidate already existed; it is returned unchanged and nothing is written
```

**Notes:**
- **Fenced before anything is written.** The caller's `attemptId`, plus `generation` when supplied, goes through `assertAttemptCurrent`. A superseded or closed attempt is refused and leaves no candidate behind.
- **Immutable.** A candidate is never edited, so a changed tree needs a **new** `id`. Re-recording an existing `id` with any field different is refused (`CANDIDATE_IMMUTABLE`).
- **A byte-identical re-record is idempotent.** Re-recording an existing `id` with identical fields is safe: it returns the existing candidate (`duplicate: true`, original `createdAt`) and writes nothing. A runner that may retry after a crash should therefore choose the `id` itself and reuse it on the retry. If the daemon generated the id, a retry records a second candidate.
- **The shas are runner-reported.** The daemon never consults git about them. It records `baseRevision` and `treeSha` exactly as reported and checks their shape only, and nothing in the record claims the daemon verified them.
- `createdAt` is the daemon's clock. The tool emits no activity event, no chat line and no board broadcast, because nothing consumes one yet.
- **No ownership or status gate.** The runner records after `complete_task`, while its attempt is still `finalizing`. No other seat can claim the row until that attempt is finalized (see `moe.claim_next_task`'s **Finalizing hold on the task**), so the runner's identity stays current through its post-flight; the attempt fence is still the guard. The tool is not `blocking`, so dispatch serializes it under the state mutex like every other tool.

**Errors.** Every refusal writes nothing. Each is listed as JSON-RPC code, then `MoeError.codeName`:
- `-32002 ATTEMPT_SUPERSEDED`: `attemptId` or `generation` is not the task's current attempt (a newer attempt exists, or every attempt is closed)
- `-32001 TASK_NOT_FOUND`: unknown `taskId`
- `-32001 ATTEMPT_NOT_FOUND` / `-32002 ATTEMPT_ID_TASK_MISMATCH`: the attempt does not exist, or belongs to another task. These are reachable only on a task with no attempt records, where the fence has nothing to compare against.
- `-32002 CANDIDATE_IMMUTABLE`: the `id` already exists and a field differs. The message names the differing fields; record the change under a new id.
- `-32602 INVALID_INPUT`: a malformed field, such as a bad sha shape, a blank or padded `deliveryTarget`, an invalid `id`, a `generation` that is not a positive integer, or non-object arguments
- `-32602 MISSING_REQUIRED`: `taskId`, `attemptId`, `baseRevision`, `treeSha` or `deliveryTarget` is absent or `null`

---

### moe.record_check_run

**Runner-called.** Records what a check reported about one frozen `Candidate`'s exact bytes as an immutable `CheckRun` (docs/SCHEMA.md `## CheckRun`), so a later gate can ask about exactly those bytes instead of about a task. Each run is one file at `.moe/checks/<id>.json`. A candidate accumulates runs, grouped by `candidateId`: running a check again is a new record under a new id, and failures stay in the history next to passes. This tool only records; whether a run satisfies any gate is decided later, by policy.

**Parameters:**
```typescript
{
  id?: string,             // optional check-run id, [A-Za-z0-9_-]{1,128}. Supply one and reuse it so a crash retry is idempotent;
                           // when omitted the daemon generates "check-<32 hex>"
  candidateId: string,     // [A-Za-z0-9_-]{1,128}: the Candidate whose bytes were checked; it must already exist
  treeSha: string,         // /^[0-9a-f]{7,40}$/i: the tree the check ran against, as reported; must equal the candidate's treeSha exactly
  command: string,         // the command that was run, verbatim (never trimmed, never run by the daemon); non-blank, ≤500 chars
  exitCode: number,        // any safe integer: zero, positive or negative. A failing run is recorded like a passing one
  outputTail?: string,     // the end of the output, stored as its final 16384 UTF-8 BYTES; absent is stored as ""
  runnerId: string,        // [A-Za-z0-9_-]{1,128}: the runner the report names. Reported, not authenticated; need not be a registered worker
  source: "runner-observed" | "agent-reported", // REQUIRED declared provenance; there is no default
  workerId?: string        // caller (auto-injected by proxy); not evidence, and not stored on the run
}
```

**Returns:**
```typescript
{ success: true, checkRun: CheckRun, duplicate: boolean }
// checkRun: the stored record { id, candidateId, treeSha, command, exitCode, outputTail, runnerId, source, createdAt }
// duplicate: true when an identical run already existed under this id; it is returned unchanged and nothing is written
```

**Example.** A runner reports a FAILING gate under an id it chose:
```json
{
  "id": "check-cand3f9d-gate-1",
  "candidateId": "cand-3f9d2c1b7a6e4d5c8b9a0f1e2d3c4b5a",
  "treeSha": "c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3",
  "command": "node gate.cjs",
  "exitCode": 1,
  "outputTail": "1 failing: expected 0 lint errors, found 3",
  "runnerId": "runner-pilot",
  "source": "runner-observed"
}
```
The run is recorded, so the call succeeds even though the check failed:
```json
{
  "success": true,
  "checkRun": {
    "id": "check-cand3f9d-gate-1",
    "candidateId": "cand-3f9d2c1b7a6e4d5c8b9a0f1e2d3c4b5a",
    "treeSha": "c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3",
    "command": "node gate.cjs",
    "exitCode": 1,
    "outputTail": "1 failing: expected 0 lint errors, found 3",
    "runnerId": "runner-pilot",
    "source": "runner-observed",
    "createdAt": "2026-09-11T03:20:00.000Z"
  },
  "duplicate": false
}
```
Sending the identical report again, for example after a runner crash, returns the same `checkRun` (same `createdAt`) with `"duplicate": true` and writes nothing.

**Notes:**
- **Recorded, not approved.** `success: true` only acknowledges that the run was persisted. A nonzero `exitCode` is acknowledged exactly like a pass. The tool never marks a task `DONE`, never approves a review and never releases a dependent task.
- **`source` is declared provenance.** The daemon never executes `command` and does not authenticate the caller, so `runner-observed` is what the report says, not proof that the command ran or of who ran it. `source` is required, never defaulted, and never inferred from `workerId`.
- **Bound to one candidate's tree.** The candidate must exist and `treeSha` must be exactly its tree, with no prefix match and no case folding. No candidate is created on the caller's behalf, and a run recorded for one candidate or tree is never rebound to another.
- **Immutable, with an idempotent retry.** Re-recording an existing `id` is compared field by field after normalization: the bounded tail, and `""` for an absent one. An identical report returns the stored run (`duplicate: true`, original `createdAt`) and writes nothing. Any difference is refused, so a changed result (another exit code, command, tail or source) is a new run and needs a fresh `id`. If the daemon generated the id, a retry records a second run.
- **Output tail: 16384 UTF-8 bytes, not characters.** The kept portion is the end of the log and always starts on a whole character; malformed input such as a lone UTF-16 surrogate is first normalized to U+FFFD. This bound is deliberately different from `complete_task`'s `verification.outputTail`, which still keeps the last 2000 characters. Details: docs/SCHEMA.md `## CheckRun`.
- `createdAt` is the daemon's clock, never the caller's. The tool emits no activity event, no chat line and no board broadcast.
- **No ownership, status or attempt gate.** The runner reports after `complete_task`, when QA may already hold the `REVIEW` task and the attempt may be closed. The tool is not `blocking`, so dispatch serializes it under the state mutex: two concurrent identical reports make one write and one `duplicate: true`.

**Errors.** Checked in this order, and every refusal writes nothing. Each is listed as JSON-RPC code, then `MoeError.codeName` (sent as `error.data.codeName`):
- `-32602 INVALID_INPUT` / `MISSING_REQUIRED`: a malformed or absent field, such as a missing or differently spelled `source`, a string or fractional `exitCode`, an invalid `id`/`candidateId`/`runnerId`, a `treeSha` that is not 7-40 hex, a blank or over-500-character `command`, a non-string `outputTail`, or non-object arguments. Nothing is coerced.
- `-32001 CANDIDATE_NOT_FOUND`: `candidateId` names no candidate
- `-32002 CHECK_RUN_TREE_MISMATCH`: `treeSha` is not exactly the candidate's tree. The message names both trees.
- `-32002 CHECK_RUN_IMMUTABLE`: the `id` already holds a different run. The message names the differing fields; record the change under a new id.
- A failed write (a full disk, a permission error) reaches the caller as a `-32000` error carrying the write's message. No run is recorded or published, and no success is returned.

---

### moe.record_delivery_receipt

**Wrapper-called; not for agents.** Records where the agent wrapper *reports* one frozen `Candidate`'s bytes landed, as a `DeliveryReceipt` (docs/SCHEMA.md `## DeliveryReceipt`): the target ref, where it pointed before and after the landing, the revision that landed, and the push result when a push was required. Each receipt is one file at `.moe/receipts/<id>.json`, and a candidate has at most one. The receipt exists for crash recovery. A wrapper that dies between moving the target ref and recording the landing re-sends the same report on its next pass, and the answer tells it the landing is already recorded, so it does not land a second time.

**Parameters:**
```typescript
{
  candidateId: string,        // [A-Za-z0-9_-]{1,128}: the Candidate whose bytes landed, and the receipt's key.
                              // A NEW receipt needs the candidate to exist
  target: string,             // the ref landed on, e.g. "refs/heads/wave1-pilot"; non-blank, no surrounding whitespace
                              // or control chars, ≤255 chars. Recorded as reported, even when it is not the candidate's deliveryTarget
  targetBefore: string,       // /^[0-9a-f]{40}$/i: where the target pointed before the landing (git's all-zero id for a new ref)
  targetAfter: string,        // /^[0-9a-f]{40}$/i: where the target pointed after the landing
  landedRevision: string,     // /^[0-9a-f]{40}$/i: the revision that landed; never an abbreviation or a ref name
  pushResult?: string | null, // the push result, verbatim: non-blank, ≤2000 chars. Omit it or send null when no push
                              // was required; both are stored as null
  workerId?: string           // caller (auto-injected by proxy); not evidence, and not stored on the receipt
}
```
There is no `id` parameter. The daemon generates `receipt-<32 hex>`, because the candidate, not an id, identifies the landing.

**Returns:**
```typescript
{ success: true, receipt: DeliveryReceipt, duplicate: boolean }
// receipt: the stored record { id, candidateId, target, targetBefore, targetAfter, landedRevision, pushResult }
// duplicate: false when this call recorded the landing; true when the candidate's receipt already said exactly this,
//            in which case it is returned unchanged and nothing is written
```

**Example.** A wrapper reports a local-branch landing that needed no push:
```json
{
  "candidateId": "cand-3f9d2c1b7a6e4d5c8b9a0f1e2d3c4b5a",
  "target": "refs/heads/wave1-pilot",
  "targetBefore": "0fc21ecd70e45e029c544a19e792d05129adccbb",
  "targetAfter": "b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2",
  "landedRevision": "b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2",
  "pushResult": null
}
```
The first call records it:
```json
{
  "success": true,
  "receipt": {
    "id": "receipt-9b8a7c6d5e4f30211f0e9d8c7b6a5948",
    "candidateId": "cand-3f9d2c1b7a6e4d5c8b9a0f1e2d3c4b5a",
    "target": "refs/heads/wave1-pilot",
    "targetBefore": "0fc21ecd70e45e029c544a19e792d05129adccbb",
    "targetAfter": "b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2",
    "landedRevision": "b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2",
    "pushResult": null
  },
  "duplicate": false
}
```
Sending the identical report again, for example from a wrapper that crashed before it saw that answer, returns the same `receipt` with `"duplicate": true`, and the file keeps its bytes.

**Notes:**
- **`duplicate` is how a replay is recognised.** `false` means this call recorded the landing. `true` means the landing was already recorded and nothing was written. A wrapper must read `duplicate: true` as "already recorded", never as a reason to land again, and must not infer either answer from the mere absence of an error.
- **Idempotent per candidate, never overwritten.** A report for a candidate that already has a receipt is compared with it field by field, where an absent `pushResult` and `null` count as the same. An identical report is the no-op above. Any difference is refused by name (`DELIVERY_RECEIPT_CONFLICT`), and the stored receipt stays exactly as it was: a second landing is what the receipt exists to expose, so a contradicting report never rewrites it. For the same reason a push result cannot be added later to a receipt recorded without one.
- **Reported, not verified.** The daemon reads no ref. It checks each field's shape and that the candidate exists, and verifies nothing about the target itself. A receipt records what the wrapper said about a landing it performed; on its own it is not proof that the bytes are where it says. It does not refuse a `target` other than the candidate's `deliveryTarget`, or a `targetAfter` other than `landedRevision`, because refusing a landing that already happened would leave a real ref move unrecorded.
- **The existing receipt is consulted first.** It is looked up before the candidate itself, so a replay reconciles to a recorded landing even when the candidate record is gone.
- A receipt has no `createdAt`, so a repeated report can leave its file byte-identical. The tool emits no activity event, no chat line and no board broadcast.
- **No ownership, status or attempt gate.** The wrapper lands after `complete_task`, when QA may already hold the `REVIEW` task and the attempt may be closed. The tool is not `blocking`, and its handler also holds the state mutex itself, so two concurrent identical reports make one write and one `duplicate: true`.

**Errors.** Checked in this order, and every refusal writes nothing. Each is listed as JSON-RPC code, then `MoeError.codeName` (sent as `error.data.codeName`):
- `-32602 INVALID_INPUT` / `MISSING_REQUIRED`: a malformed or absent field, such as a revision that is not exactly 40 hex (`HEAD`, an abbreviation, a padded value), a blank or padded `target`, an invalid `candidateId`, a blank, non-string or over-2000-character `pushResult`, or non-object arguments. Nothing is coerced.
- `-32002 DELIVERY_RECEIPT_AMBIGUOUS`: more than one receipt on disk already names the candidate, which only files placed by hand can cause. The message names them, because which one records the landing cannot be decided.
- `-32002 DELIVERY_RECEIPT_CONFLICT`: the candidate's receipt differs from this report. The message names the receipt and the differing fields.
- `-32001 CANDIDATE_NOT_FOUND`: no receipt exists yet and `candidateId` names no candidate
- A failed write (a full disk, a permission error) reaches the caller as a `-32000` error carrying the write's message. No receipt is recorded or published and no success is returned, so the wrapper retries the same report.

---

### moe.declare_files

Assert that paths belong to a task. Unions `paths` into `task.declaredFiles`, which the wrapper treats as the **ASSERTED** attribution tier — the next post-flight of that task commits them regardless of the baseline. This is the governor/worker lever for "these edits are mine, land them" (a path listed in `get_context.unattributedPaths`, a helper file the plan never named, debris a DONE task left dirty) and replaces hand-landed `chore(...)` commits.

**Parameters:**
```typescript
{
  taskId: string,
  paths: string[],      // project-relative, forward slashes; normalised + deduped like affectedFiles
  workerId?: string,    // caller (auto-injected by proxy)
  note?: string         // why — posted to the task channel
}
```

**Returns:**
```typescript
{ success: true, taskId, declaredFiles: string[], addedPaths: string[] }
```

**Notes:**
- No ownership guard: a governor declares onto tasks it never owns. Activity event: `TASK_FILES_DECLARED`.
- Declaring does not commit anything by itself — the assigned agent's next session exit (or the BLOCKED-hold idle path, which lands lingering baselines with no CLI launched) lands it. Declare onto a task that will still get a session; a `DONE` task never runs a post-flight again.
- A declared path that no longer exists on disk and is not in HEAD is reported as `MOE_ATTR_MISSING` at landing, never committed as a deletion.

**Errors:**
- `taskId is required` / `paths is required` (non-empty array)
- `[INVALID_INPUT]` for absolute paths or `..` traversal
- `Task not found: <taskId>`

---

### moe.report_blocked

Report a task as blocked: flips the task to `BLOCKED` and pages whoever can actually unblock it. With `resourceId`, first tries to acquire the shared resource — a free resource grants the lease and does **not** block. With `blockedOnTaskIds` (or task ids in the `reason`), the daemon auto-unblocks the task when every named task lands — and if every named task has **already** landed, the task is not blocked at all (`dependenciesSatisfied: true`). A **non-resource** block reported by the assignee (or on an unassigned task) frees the seat: the worker goes `IDLE` and claims other work instead of idling on its own unblock; a third-party (workerId-less) block on an assigned task keeps the hold.

**Parameters:**
```typescript
{
  taskId: string,
  reason: string,                // required, ≤2000 chars; task-… ids inside it are auto-parsed into blockedOnTaskIds
  needsFrom?: string,
  currentStepId?: string,
  workerId?: string,
  resourceId?: string,           // shared-resource block: grant-or-enqueue; keeps the seat parked (hold+idle)
  blockedOnTaskIds?: string[]    // task ids this row waits on — existing ids, deduped, capped at 20
}
```

**Notes:**
- **Task flip:** a task in an agent-claimable column (`PLANNING`/`WORKING`/`REVIEW`) flips to `BLOCKED`, recording `blockedReason`, `blockedResourceId` (when given), `blockedOnTaskIds` (when given or parsed), `blockedFromStatus` (the pre-block status to restore) and `blockedAt`. Tasks in other statuses keep their status.
- **Task-dependency path** (`blockedOnTaskIds`): only ids that exist on the board are kept (a missing id counts as satisfied anyway, so storing it would be dead weight; supplied unknowns come back in `ignoredBlockedOnTaskIds`), the task's own id is never a dependency of itself, deduped, capped at 20 — and the daemon ALSO auto-parses `task-…` ids out of `reason` and unions them (stored ∪ supplied ∪ parsed; a correction never loses earlier ids), so a legacy free-text "BUILD-ORDER BLOCK on task-X" becomes structured with zero agent effort (on both the flip and the repeat/reason-update arms). The auto-parse is boundary-anchored (`subtask-abcdef` never records `task-abcdef`). The moment every listed task is `DONE`/`ARCHIVED` (a missing/deleted id counts as satisfied; under a strict `settings.deliveryPolicy` a `DONE` task counts only once its required check is recorded, the rule `claim_next_task` applies to `dependsOn`), the daemon auto-unblocks: status → `blockedFromStatus`, all `blocked*` fields cleared, `TASK_UNBLOCKED` + a chat notice; the task returns **unassigned** unless a still-assigned hold's worker still exists, is not `DEAD` and still points at the task (then it returns to that worker). The check is event-driven (every task transition to DONE/ARCHIVED — `qa_approve`, `set_task_status`, archive, board moves), with a sweep backstop that repairs rows blocked before the daemon upgrade.
- **Already-landed prerequisites (fresh flip only):** on a fresh flip, ids that are already `DONE`/`ARCHIVED` are **not** recorded (they come back in `satisfiedBlockedOnTaskIds`; judged exactly as the auto-unblock judges them, so under a strict `settings.deliveryPolicy` a `DONE` id still lacking its required check is recorded and the task blocks on it), and when EVERY candidate id is already landed (and no `resourceId` is involved) the task is **not blocked at all** — the call answers `{ blocked: false, dependenciesSatisfied: true, satisfiedBlockedOnTaskIds }` with `nextAction` → `moe.get_context` (read the prerequisites' evidence from `epicSiblings` and continue), writes nothing and pages nobody. Recording an instantly-satisfied list would be a claim-thrash livelock: flip → the next dependency scan restores it → the next worker claims → same wall → flip. The repeat/reason-update arm on an already-BLOCKED task deliberately keeps the union, satisfied ids included — that is the backfill path (store the DONE ids; the next dependency scan repairs the row).
- **Dependency cycles:** an id from which the reporting task is already reachable over `dependsOn ∪ blockedOnTaskIds` (A waits on B, B waits on A — directly or transitively; edges out of `DONE`/`ARCHIVED` rows are not followed) is **dropped**, reported in `droppedCycleBlockedOnTaskIds`, explained in `warnings[]` (`DEPENDENCY_CYCLE: … (task-A → task-B → task-A)`), and alerted to `#governors` — a cycle's members can never all reach DONE, so nothing could ever auto-unblock it.
- **Stale-block visibility** (sweep, `#governors`, once per block instance — visibility, not auto-park): a resource-less BLOCKED task draws a `blockedAt`-age alert when it has no `blockedOnTaskIds` and is past `blockedTimeoutMs` (nothing will auto-unblock it), when it is past `blockedTimeoutMs` and an unmet prerequisite is itself `BLOCKED`/`BACKLOG` (a cycle or a parked prerequisite — the line names each unmet id with its status), when it is past `blockedTimeoutMs` and an unmet prerequisite is `DONE` but withheld by a strict `settings.deliveryPolicy` (the line names the evidence it lacks, e.g. `task-P [DONE, missing required-check:<qualityGate>]`; no claim moves a `DONE` task, so it clears only once that evidence is recorded or the row is restored), or when it is dep-waiting past 2× `blockedTimeoutMs`.
- **Seat-freeing (non-resource blocks reported by the assignee, or on an unassigned task):** the block releases the seat — `assignedWorkerId → null`, the reporting worker → `IDLE` (its `currentTaskId` is only cleared when it actually points at this task). The response carries **no `nextAction`**: `sessionHandoff` tells the session to end so its wrapper can checkpoint the task, and the seat takes other work from a fresh wrapper pre-flight, never inside the same CLI. Safe because the wrapper checkpoints the task's files at block time (land-on-every-exit), so any worker can resume from the landed bytes; on unblock the task returns **unassigned** to its `blockedFromStatus`, claimable by anyone. The same write closes the freed seat's `running`/`reconciling` attempt (see **Close on hand-back** under Ownership & Ordering), so a later daemon restart has nothing of that seat's to park and cannot hold the unassigned row; a worker wrapper whose pinned attempt reads back `closed` at post-flight treats it as already finalized and keeps its claim loop going. A **resource** block keeps the old hold+idle semantics: the task stays assigned, the worker is marked `BLOCKED`, and the grant path returns the task to the same parked worker by design. A **third-party** block (no `workerId` — a `workerId` that is not the assignee is refused outright) on an **assigned** task keeps the hold too (`seatFreed: false`, worker → `BLOCKED`, `nextAction` → `wait_for_task`): freeing a live worker's seat from the outside would unassign the task under a running session, and the auto-unblock would then hand it to a second worker while the first is still editing the same files.
- **Resource path** (`resourceId` set): the daemon runs the `moe.acquire_resource` grant-or-enqueue FIRST — even for an **unassigned** task (operator/plugin flow; the queue entry's `workerId` falls back to the caller, then the assignee, then `"human"`), because without a queue entry the grant path could never auto-unblock the task. Capacity free → the lease is granted, the task is **not** blocked, and the call returns `{ granted: true, lease }` — proceed, then `moe.release_resource`. Busy → the task blocks as above with `blockedResourceId` set, and the grant path auto-unblocks it (status → `blockedFromStatus`) the moment the lease is granted. `resourceId` must match the resource-id shape (see `## Shared Resources`).
- Only the assigned worker may report a task blocked (`workerId` is auto-injected by the proxy); a `reason` is required and capped at 2000 chars.
- **Ping routing:** the daemon direct-mentions the **architect with the freshest `lastActivityAt` inside the 120s liveness window** (`isWorkerAlive` — so a `DEAD`/deregistered architect is never picked), resolving the role through `worker.teamId`. The blocked worker itself is excluded, so an architect blocked on its own PLANNING task cannot page itself into a dead end. Ties on `lastActivityAt` break to the lowest worker id, so routing is deterministic.
- With **no live architect**, the ping escalates to `@governors` instead.
- Channels: the task/general system copy stays unmentioned (it lands in `#general`, which already receives the mentioned copy — prefixing both would page the same person twice); `#general` gets the mentioned copy; `#architects` additionally gets it when an architect was found; `#governors` always receives the message — unmentioned when an architect was paged (visibility without being paged), mentioned when it *is* the escalation. Every post is best-effort: a chat failure never fails `report_blocked` or skips the `BLOCKED` update.
- `nextAction`: a seat-freed block (`seatFreed: true`) carries none. It answers `sessionHandoff` instead (end this session; never `moe.claim_next_task` or `moe.wait_for_task` inside it, because the next task needs a fresh wrapper pre-flight and baseline) and `blockResolution` (when the task auto-unblocks, or, with no `blockedOnTaskIds` recorded, the human escape via `moe.set_task_status` — a `moe.unblock_worker` cannot reach an unassigned task). A `dependenciesSatisfied` answer points at `moe.get_context` (continue). A third-party hold on an assigned task points at `moe.wait_for_task` for the still-assigned worker. A resource block deliberately gets **no `nextAction`**: the wrapper idles (`BLOCKED` suppresses relaunch) and the grant path auto-unblocks the task, so ending the session IS the correct next step — there is nothing to wait on in-session.
- **Every plan step already `COMPLETED`, no `resourceId`, and the task blocked out of `WORKING`**: the block still happens, but the response carries `warning: 'ALL_STEPS_COMPLETE: BLOCKED is a wait state, not a terminal — resolve the blocker and obtain valid task ownership before moe.complete_task with verification'`, and on a kept seat `nextAction` pointing at `moe.complete_task` (a freed seat gets the warning beside `sessionHandoff`). REVIEW/PLANNING-origin blocks never warn — `complete_task` is only legal from `WORKING` (a REVIEW-origin block always has all steps completed). Delivered work goes through `complete_task`; `BLOCKED` is never a finish line.
- Un-block routes: the resource grant path (auto), the task-dependency path (auto, all `blockedOnTaskIds` DONE/ARCHIVED), `moe.unblock_worker { resolveBlocks: true }`, or a human `set_task_status`. A bare `moe.unblock_worker` is **seat-only** — the worker goes `IDLE` but the task stays `BLOCKED` with its `blockedReason`. Ordinary releases (daemon restart purge, deregister, `release_task`) keep a `BLOCKED` task `BLOCKED` — the blocker is still there. The wrapper lands a checkpoint commit of the task's files on the BLOCKED exit, so a block never strands bytes.

**Returns:**
```typescript
// Resource path, capacity was free — lease granted, task NOT blocked:
{ success: true, taskId, taskStatus: TaskStatus /* unchanged */, granted: true, lease: ResourceLease, message }

// Every named prerequisite already DONE/ARCHIVED (fresh flip, no resourceId) — task NOT blocked, nothing written, nobody paged:
{
  success: true, taskId, taskStatus: TaskStatus /* unchanged */,
  blocked: false, dependenciesSatisfied: true,
  satisfiedBlockedOnTaskIds: string[],   // the landed ids that were named (param ∪ parsed)
  alreadyBlocked: false, reasonUpdated: false,
  ignoredBlockedOnTaskIds?: string[], droppedCycleBlockedOnTaskIds?: string[], warnings?: string[],
  workerStatus: WorkerStatus,
  notified: { target: null, via: "not-blocked-dependencies-satisfied" },
  message: string,
  nextAction: { tool: "moe.get_context", args: { taskId, workerId? }, reason, recommendedSkill? }  // read the prerequisites' evidence from epicSiblings and continue
}

// Blocked:
{
  success: true,
  taskId: string,
  taskStatus: "BLOCKED" | TaskStatus, // "BLOCKED" when flipped; unchanged for non-flippable statuses
  resourceId?: string,                // echoed when resourceId was passed …
  granted?: false,                    // … along with the failed-grant marker
  blockedOnTaskIds?: string[],        // recorded deps: on a fresh flip param ∪ parsed MINUS already-landed ids; on a repeat stored ∪ param ∪ parsed (a correction never loses earlier ids)
  satisfiedBlockedOnTaskIds?: string[], // fresh flip only: named ids already satisfied (DONE/ARCHIVED, judged as the auto-unblock judges them), NOT recorded (the block stands on the unmet ones)
  ignoredBlockedOnTaskIds?: string[], // explicitly supplied ids that don't exist on the board — dropped, not an error (parsed strays are skipped silently)
  droppedCycleBlockedOnTaskIds?: string[], // ids dropped because recording them would close a dependency cycle (also warned + alerted to #governors)
  warnings?: string[],                // "DEPENDENCY_CYCLE: <id> was NOT recorded — … (task-A → task-B → task-A) …"
  seatFreed?: boolean,                // present on a fresh flip: true = assignee/unassigned non-resource block released the seat; false = resource block or third-party block kept it
  workerStatus: "IDLE" | "BLOCKED",   // IDLE when the seat was freed; BLOCKED for resource blocks and third-party holds (hold+idle)
  notified: {
    target: string,                   // architect worker id, or "@governors"
    via: "freshest-live-architect" | "governors-fallback"
  },
  message: string,                    // names who was pinged
  warning?: string,                   // "ALL_STEPS_COMPLETE: …" when every step is COMPLETED, no resourceId, and the block originated from WORKING
  sessionHandoff?: { action: "END_SESSION", taskId, workerId, reason }, // seat freed and its worker holds no other task: end this session so the wrapper checkpoints the task; the next task needs a fresh wrapper pre-flight
  blockResolution?: string,           // seat freed: when the task auto-unblocks (naming the recorded blockedOnTaskIds, and any DONE one still withheld by settings.deliveryPolicy), or, with none recorded, the human escape via moe.set_task_status
  nextAction?: { tool: "moe.wait_for_task" | "moe.complete_task", ... }  // kept seat only: wait_for_task on a third-party hold (the assignee waits on its own unblock); complete_task alongside the ALL_STEPS_COMPLETE warning; absent on a freed seat and on resource blocks
}
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
  includeArchived?: boolean, // default: false — see note
  limit?: number,  // default: 100, max: 500
  offset?: number  // default: 0
}
```

**ARCHIVED tasks are hidden by default** so shelved tickets stay out of agent
context. They are returned only when `includeArchived: true` or when `ARCHIVED`
is named in the `status` filter. `counts.archived` always reflects the true
total regardless, so the existence of archived tickets is never hidden.

**Returns:**
```typescript
{
  epicId: string | null,
  epicTitle: string | null,
  tasks: Array<{
    id, epicId, title, status, priority, order,
    assignedWorkerId, hasWorker, reopenCount, hasPendingQuestion,
    definitionOfDoneCount, planStepCount, completedStepCount,
    blockedOnTaskIds?: string[],  // BLOCKED rows: the tasks this row waits on (auto-unblocks when all are DONE/ARCHIVED)
    dependsOnUnmet?: number       // count of dependsOn targets not yet DONE/ARCHIVED — why a row isn't offered to WORKING claims
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
  includeArchived?: boolean, // default: false — ARCHIVED excluded unless set, or filters.status === 'ARCHIVED'
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

**Agent-claimable columns only:** `statuses` must be a subset of `PLANNING` (architect) / `WORKING` (worker) / `REVIEW` (qa) — matching the launcher status maps in `scripts/moe-agent.{ps1,sh}`. Any other value (`BACKLOG`, `AWAITING_APPROVAL`, `BLOCKED`, `DONE`, `ARCHIVED`) is rejected with `INVALID_INPUT`: those columns are human-gated (or, for `BLOCKED`, waiting on an external blocker) with no agent tool surface, so a claim there could only wedge the worker (assignment succeeds, status never transitions, `start_step`/`submit_plan`/`qa_*` all reject). This applies to explicit `taskId` claims too. To move a task out of a human-gated column, a human or governor uses `set_task_status`. The same restriction applies to `wait_for_task`'s `statuses`.

**Parameters:**
```typescript
{
  statuses: string[],              // subset of PLANNING | WORKING | REVIEW
  epicId?: string,
  workerId?: string,
  replaceExisting?: boolean,       // Take over from existing worker
  taskId?: string,                 // Claim this specific task (must be in one of `statuses`)
  preferAdjacentInEpic?: boolean,  // default: true — rank candidates in the worker's last epic ahead of others
  processStartedAt?: string,       // runner process start time, recorded verbatim on the attempt (send with `host`)
  host?: string                    // host the runner process runs on, recorded verbatim (send with `processStartedAt`)
}
```

When `taskId` is provided the priority/order ranking is bypassed — you get the named task or an error. The task must be in one of the requested `statuses`; if it's already assigned to someone else, pass `replaceExisting: true` to take over. Re-claiming a task already assigned to YOU is always allowed (resume path) and needs no `replaceExisting`.

**Dependency gating (WORKING claims only):** a task whose `dependsOn` targets are not all `DONE`/`ARCHIVED` is excluded from `WORKING`-status claims — it is not offered for execution until its prerequisites land, and an explicit-`taskId` claim of such a task is refused too (re-claiming a task you already hold stays allowed — the resume path). `PLANNING` (and `REVIEW`) claims are unaffected: a task may be planned before its prerequisites finish. A missing/deleted id counts as satisfied, so a removed prerequisite can never wedge its dependents. **Delivery evidence:** under a strict `settings.deliveryPolicy` a `DONE` prerequisite counts only with the evidence that policy requires of it, judged by the same rule as `moe.qa_approve` (for a DONE task: a runner-observed exit-0 `CheckRun` of the required `qualityGate` on its current candidate's own tree). Until that is recorded its dependents stay withheld, and an explicit-`taskId` claim is refused with a thrown `-32003` / `DEPENDENCY_EVIDENCE_MISSING` before any write: `context` is `{ taskId, prerequisiteTaskId, missingEvidence }`, where `missingEvidence` is a token array such as `["required-check:node gate.cjs"]`, and because `context` does not cross the MCP wire the message names the prerequisite and each token with its reason. A prerequisite that has not reached `DONE` keeps the plain `NOT_ALLOWED` unmet-dependencies refusal, which comes first and lists only such ids; an unrecognised `deliveryPolicy` withholds the dependents of every DONE prerequisite and refuses such an explicit claim with `INVALID_INPUT`. `ARCHIVED` still counts as satisfied, and under the default `legacy` policy nothing changes. `moe.list_tasks` rows carry `dependsOnUnmet` so a withheld row is explainable, and `moe.set_task_dependencies` (architect/governor) edits a mis-declared list. This gate *prevents* build-order blocks; a dependency discovered mid-flight goes through `moe.report_blocked { blockedOnTaskIds }` instead, which the same auto-unblock machinery clears.

**One task per worker:** a worker already holding an active task (PLANNING/WORKING/REVIEW/BLOCKED) cannot claim another — the call returns `{ hasNext: false, alreadyAssigned: { taskId, title, status } }` with a `nextAction` pointing back at the held task (`get_context`). Finish it (`submit_plan` / `complete_task` / `qa_approve` / `qa_reject`) or `release_task` it first. This also applies to explicit `taskId` claims of a different task.

**Finalizing hold:** a worker that still holds an execution attempt in the `finalizing` phase cannot claim its next task — the call is **refused with a thrown `-32002` / `ATTEMPT_FINALIZING`** (not a `hasNext: false` answer), raised beside the one-task-per-worker check and before any ranking or assignment write, so a refused claim never changes an owner. `complete_task` leaves that attempt open on purpose: the wrapper only lands the bytes after the CLI exits, so starting task B now would open a second attempt across the first. The refusal is retryable, not fatal (`context.retryable: true`; over the wire, key on `codeName`), and `moe.finalize_attempt` is what clears it (so does its runner's `moe.deregister_worker`, and the other ends `moe.finalize_attempt` lists under **Every end of a finalizing attempt**). This part of the hold is scoped to the calling worker; the task-scoped part follows.

**Finalizing hold on the task:** no seat other than the attempt's own worker may claim a task whose attempt is `finalizing` — until the landing is acknowledged, the row belongs to it. An explicit-`taskId` claim is **refused with a thrown `-32002` / `ATTEMPT_FINALIZING`** right after the needs-human-review check and before the dependency gate, any eviction or any assignment write, so a refused claim writes nothing. Its `context` is `{ attemptId, generation, taskId, workerId, retryable: true }` with `workerId` naming the attempt's holder, and the message tells the caller to retry after that worker's runner calls `moe.finalize_attempt`. A caller without a `workerId` counts as another seat. The ranked pool **skips** such a row instead of refusing it (the wrappers claim only through the pool, where a thrown refusal would read as a dead daemon), and `moe.wait_for_task` skips it by the same predicate. The hold ends when the runner calls `moe.finalize_attempt`, when its runner's `moe.deregister_worker` closes the attempt, or when a governor or human closes an abandoned boundary with `moe.finalize_attempt { taskId, attemptId, generation, outcome: 'failed' }` (its **Escape for a runner that is gone** note says how to find one); its **Every end of a finalizing attempt** note lists the rest — never an idle signal. An interactive (TUI) seat's row therefore stays held until its operator closes the CLI and the wrapper finalizes. This hold is what keeps the runner's fenced `moe.record_candidate` and `moe.finalize_attempt` current through its post-flight: a QA claim used to close the finalizing attempt and open its own generation, so the runner's `moe.record_candidate` was refused as `ATTEMPT_SUPERSEDED`, its `moe.finalize_attempt` found the attempt already closed, and `moe.qa_approve`'s hold was gone. A `running` or `reconciling` leftover on an unassigned row is still closed by the next claim, and a finalizing record without a usable identity (a blank id, task or worker, or a bad generation) holds nothing and is closed the same way.

**Reconciling hold:** an explicit-`taskId` claim of a task whose attempt a daemon restart parked in `reconciling` is **refused with a thrown `-32002` / `ATTEMPT_RECONCILING`** while that task is still assigned to the attempt's worker: its runner may be moments from `moe.reattach_attempt`, and handing the row to anyone else would start a second execution of live work. Like the finalizing hold on the task, it is scoped by task, not by caller, and the holder itself is exempt. It is checked right after the missing-task check (a missing row answers `TASK_NOT_FOUND` first) and before any other eligibility check or write. A reconciling attempt on a row that is **unassigned or assigned to a different worker** holds nothing, so the claim falls through to the ordinary checks: an unassigned row is claimed, its leftover attempt is closed and the successor generation opened — exactly what a ranked claim does — and a row a live worker holds is refused as assigned (`NOT_ALLOWED`). The ranked pool never offers a held row, because its still-assigned owner is spared by the startup purge.

**Runner process identity (optional, both or neither):** a runner may send `processStartedAt` and `host` — the identity of the process it is about to run its CLI in — and the claim records them **verbatim** on the attempt it opens. That is the only place they ever come from: the daemon never probes a process and never derives, defaults or normalises either value, and it never reads them as evidence that anything is alive. They exist so that a later `moe.reattach_attempt` can match the attempt a daemon restart parked against the process that opened it, comparing both as **exact strings** (see that tool). Rules: both or neither — a half identity would record something no reattach could reproduce, since both are compared — and each must be a non-blank string with no control characters, at most 200 characters for `processStartedAt` and 255 for `host`. A supplied-but-malformed value (blank, `null`, a non-string, over-long, or one of the pair without the other) is **refused** with `-32602` / `INVALID_INPUT` naming the field, before any eligibility check, assignment write or attempt open, so a refused claim assigns nobody. Refusing rather than silently dropping is deliberate: a dropped value reads as a successful claim and costs the seat its reattachability hours later, at a restart, with nothing in the log. **Omitting both is fully supported** and is what every non-runner caller does (the IDE board, `scripts/moe-call.sh`, older wrappers): the claim takes exactly the path it always did and writes the same attempt record, byte for byte — that attempt is simply unmatchable by `moe.reattach_attempt`, by design. A **resume never rewrites** what is already recorded: re-claiming a task you already hold adopts the open attempt as it stands, whatever identity the resuming claim presents, so no second process can re-point a live execution at itself. The shipped wrappers (`scripts/moe-agent.{sh,ps1}`) send the pair on every claim they make, including a resume: `processStartedAt` is `<wrapper pid>@<process start token>` (sh: `/proc/<pid>/stat` starttime, else `ps` lstart; ps1: the process `StartTime` in UTC ticks) and `host` the lowercased host name, computed once per wrapper process — the wrapper, not the CLI, because it outlives every CLI respawn. A wrapper that cannot determine both sends neither and says so in one `[WARN]`. A respawned wrapper is a different process and cannot reattach an attempt its predecessor opened; see `moe.heartbeat` for how the wrappers react to a parked attempt.

**BLOCKED hold:** when the held task is `BLOCKED`, `alreadyAssigned` additionally carries `blockedReason`, `blockedResourceId` and `blockedOnTaskIds` (each present only when set on the task), and `nextAction` points at `moe.release_task` instead of `get_context`, spelling out the two workable exits: end the session and let the wrapper idle (the resource grant / dependency auto-unblock / a human clears it), or `moe.release_task { taskId }` to hand the task back with its `blockedReason` intact and free the slot for other work — never re-enter `wait_for_task` hoping for different work (nothing else is claimable while the hold stands). Note that an assignee-reported **non-resource** `report_blocked` frees the seat at report time, so a BLOCKED hold is the resource-block (hold+idle) shape or a third-party (workerId-less) block on an assigned task — an assignee-reported non-resource BLOCKED task is unassigned and simply not offered. A BLOCKED hold is not resumable work — the wrapper reads this status and suppresses the CLI relaunch entirely; a live session should end rather than spin. A set `blockedResourceId` means the daemon auto-unblocks the task the moment its lease is granted (see `## Shared Resources`); a set `blockedOnTaskIds` means it auto-unblocks when every listed task is DONE/ARCHIVED; neither set means the block needs a human (`moe.unblock_worker { resolveBlocks: true }` / `set_task_status` — a bare `unblock_worker` only frees the seat). Before idling on a BLOCKED hold the wrapper lands any lingering baseline for the held task as a recovery checkpoint (`MOE_CHECKPOINT_RECOVERED`), so a blocked task's files reach the branch with no CLI launched.

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
  staleHandoffDiskState?: true,     // the tree moved since the newest handoff was written
  fileCollision?: Array<{ task: string, files: string[] }>,  // advisory only
  alreadyAssigned?: {               // hasNext: false — you already hold an active task
    taskId: string,
    title: string,
    status: TaskStatus,
    blockedReason?: string,         // BLOCKED holds only
    blockedResourceId?: string,     // BLOCKED holds only; set = auto-unblocks on lease grant
    blockedOnTaskIds?: string[]     // BLOCKED holds only; set = auto-unblocks when all are DONE/ARCHIVED
  },
  nextAction: {
    tool: 'moe.get_context' | 'moe.get_handoff_history' | 'moe.wait_for_task' | 'moe.enter_governance' | 'moe.release_task',  // release_task = BLOCKED hold (see above)
    args: object,
    reason: string,
    recommendedSkill?: { name: string, reason: string }
  }
}
```

**Notes:**
- On first claim the daemon stamps `task.metrics.firstClaimAt` (idempotent).
- `fileCollision[]` is populated when the claimed task's normalized `affectedFiles` overlap with any other `WORKING` task — advisory only, the claim still succeeds, and a heads-up is posted to `#workers`. Files matching `settings.appendOnlyFiles` (default `["CHANGELOG.md"]`) are dropped from the comparison first, so shared append-only files don't bury the real overlaps; a task whose only overlap was append-only produces no entry at all. Supplying the setting **replaces** the default list, and `[]` disables the suppression — see docs/CONFIGURATION.md.
- When `task.priorHandoffs` is non-empty, `nextAction.tool` is `moe.get_handoff_history` (instead of `moe.get_context`) so the worker reads the handoff before redoing finished work.
- `staleHandoffDiskState: true` is returned when the newest handoff carries a `diskState` signature (see `moe.release_task`) and a fresh recompute differs — the working tree moved since that note was written, so its claims (especially a refusal or "blocked by" reason) describe a tree that no longer exists and must be re-verified. `handoffHint` gets a matching sentence appended. The flag is **informational**: the daemon takes no automatic action on it. No flag is emitted when the newest handoff has no `diskState`, when the recompute fails, or when the signatures match — and in those cases no git subprocess runs at all unless a stored signature exists, so ordinary polling claims stay free.
- Governors short-circuit: a caller whose team role is `governor` gets `nextAction.tool = "moe.enter_governance"` and never claims a task.

`claim_next_task` is intentionally lean: it does **not** return project rails, epic details, task descriptions, definition of done, task rails, implementation plans, chat history, or memory payloads. Call `moe.get_context` after a successful claim to fetch the full, token-budgeted context.

**Worker Constraint:**
Only one worker can work on tasks of the same status type per epic at a time:
- Architects (PLANNING) and workers (WORKING) can work in parallel on the same epic
- Two workers cannot both claim WORKING tasks in the same epic
- Use `replaceExisting: true` to take over from an existing worker

**Errors:**
- `Epic already has an active worker on <status> tasks: <workerId>` - if another worker is active
- `-32602 INVALID_INPUT`: a malformed runner process identity — a blank, `null`, non-string, control-character-bearing or over-long `processStartedAt`/`host`, or one of the pair sent without the other. Raised before any write.

---

### moe.wait_for_task

Block (long-poll) until a claimable task matching the given `statuses` appears. Returns immediately if one already exists. Does **not** claim the task — call `moe.claim_next_task` after waking.

**Parameters:**
```typescript
{
  statuses: string[],   // Required, non-empty, subset of PLANNING | WORKING | REVIEW
  workerId: string,     // Required: your worker ID (used for cleanup on disconnect)
  epicId?: string,      // Optional epic filter
  timeoutMs?: number    // Max wait in ms (default 300000, clamped to 1000–600000)
}
```

`statuses` is restricted to the agent-claimable columns — the same vocabulary as `claim_next_task`. Waiting on a human-gated column (`BACKLOG`, `AWAITING_APPROVAL`, `BLOCKED`, `DONE`, `ARCHIVED`) is rejected: the waiter would either sleep forever or wake into a claim that is itself rejected.

**Own-task wake:** the caller's own *held* task matches the wait the moment it is in a requested status, even though a held task is not claimable by others. This is the un-block resume path: a session parked on `wait_for_task` while its task sat `BLOCKED` wakes as soon as the resource grant (or a human) flips the task back to `WORKING` — claiming an own-held task is the sanctioned resume (`ownedBySelf`) in `claim_next_task`.

**Returns:**
```typescript
// Task available (immediately, or on a TASK_CREATED/TASK_UPDATED wake):
{ hasNext: true, task: { id, title, status, priority, epicId },
  nextAction: { tool: "moe.claim_next_task", args, reason } }  // claim, then moe.get_context

// A task has an unanswered human question (checked before parking, and on TASK_UPDATED):
{ hasNext: false, hasPendingQuestion: true, taskId,
  nextAction: { tool: "moe.get_pending_questions", args, reason } }

// Chat message for this worker arrived while waiting:
{ hasNext: false, hasChatMessage: true,
  chatMessage: { channel, sender, preview },  // preview = first 200 chars
  nextAction: { tool: "moe.chat_read", args, reason } }

// Timeout elapsed:
{ hasNext: false, timedOut: true,
  nextAction: { tool: "moe.wait_for_task", args, reason } }  // re-enter wait

// Cancelled (superseded wait, MCP client disconnect, or stale-waiter sweep):
{ hasNext: false, cancelled: true }

// Internal failure subscribing to state events:
{ hasNext: false, error: "subscribe_failed" }
```

**Notes:**
- Marked `blocking`: the MCP dispatch layer does **not** wrap it in the global state mutex (it can park for minutes; all other tools stay serialized). Same mechanism as `moe.chat_wait`.
- Only **claimable** tasks match: `assignedWorkerId` is null, or the assigned worker is missing/`DEAD`. Candidates are ranked by priority (`CRITICAL` > `HIGH` > `MEDIUM` > `LOW`), then `order`; the top match is returned.
- **Dependency gating matches `claim_next_task`:** a `WORKING` wait skips a task whose `dependsOn` targets are not all `DONE`/`ARCHIVED` (`PLANNING`/`REVIEW` waits are unaffected; missing/deleted ids count as satisfied). No extra plumbing was needed: the `TASK_UPDATED` fired by a prerequisite's DONE transition re-runs the waiter predicate, so a parked dependent wakes the moment its last prerequisite lands.
- **The finalizing hold matches `claim_next_task` too:** a task whose execution attempt is still `finalizing` under another worker is skipped by the same predicate as the ranked pool (see `moe.claim_next_task`'s **Finalizing hold on the task**), so a QA waiter never wakes into a claim that returns nothing. The hold writes no task when it ends, so the close publishes one `TASK_UPDATED` for the unchanged task — from `moe.finalize_attempt`, from the holder's `moe.deregister_worker`, or from the removal of the holder's `DEAD` record — which re-runs the waiter predicate: a parked QA seat wakes the moment the landing is acknowledged.
- Wake triggers while parked: `TASK_CREATED`/`TASK_UPDATED` producing a claimable match; `TASK_UPDATED` setting `hasPendingQuestion`; `MESSAGE_CREATED` where the message routes to/mentions this worker **or** the sender is `"human"`.
- Refreshes the worker heartbeat on entry and again on timeout, so a parked worker is not treated as idle.
- Calling `wait_for_task` again with the same `workerId` cancels the previous wait (the earlier call resolves `{ hasNext: false, cancelled: true }`). The same cancellation fires on MCP client disconnect and when the stale-waiter sweep finds the worker no longer tracked.

**Errors:**
- `[MISSING_REQUIRED] Missing required field: statuses` — `statuses` absent or empty
- `[INVALID_INPUT] statuses` — any status outside `PLANNING`/`WORKING`/`REVIEW`
- `[MISSING_REQUIRED] Missing required field: workerId`

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

The valid transitions allow `ARCHIVED` from any resting status — `BACKLOG`,
`REVIEW`, or `DONE` — and `ARCHIVED → BACKLOG/WORKING` to un-archive.
`BACKLOG → PLANNING/WORKING/REVIEW` are all legal: `set_task_status` is the
un-park path for tasks the blocked-timeout sweep routed to `BACKLOG` (including
parked reviews, hence `BACKLOG → REVIEW`). In-flight
states (`PLANNING`/`AWAITING_APPROVAL`/`WORKING`) cannot go straight to
`ARCHIVED`. For archiving, prefer the dedicated `moe.archive_task` /
`moe.archive_epic` tools below.

**BLOCKED transitions:** `BLOCKED` is reachable from each agent-claimable
column (`PLANNING`/`WORKING`/`REVIEW` → `BLOCKED`) and exits back to any of
them or to `BACKLOG` (manual park). It is deliberately **not** reachable from
the human-gated columns (`BACKLOG`/`AWAITING_APPROVAL`) — nothing is running
there to block. Block bookkeeping is handled by this tool: entering `BLOCKED`
here (the human/board path — agents use `moe.report_blocked`) records
`blockedFromStatus` and `blockedAt` (plus `blockedReason` from `reason` when
given); leaving `BLOCKED` by any route clears every `blocked*` field
(`blockedReason`/`blockedResourceId`/`blockedOnTaskIds`/`blockedFromStatus`/`blockedAt`)
so a later resource grant, dependency auto-unblock, or sweep cannot act on
stale block state. Activity events: `TASK_BLOCKED` on entry, `TASK_UNBLOCKED`
on exit.

**Attempts:** a transition that clears the assignee closes the task's `running`/`reconciling` attempts in the same write (see **Close on hand-back** under Ownership & Ordering). Entering `BLOCKED`, and returning from `BLOCKED` to `blockedFromStatus`, keep the seat and so keep its attempt. While the task has a `finalizing` attempt (a `complete_task` landing not yet acknowledged), a move into `DONE` or `ARCHIVED` is **refused with retryable `-32002` / `ATTEMPT_FINALIZING`** before any write — nothing ever claims a terminal row, so the hold would never end; retry after `moe.finalize_attempt`. The guard sits in the daemon's one task-write path, so `moe.archive_task`, `moe.archive_epic` and the board refuse the same way; a reopening move (`WORKING`/`PLANNING`/`BACKLOG`/`BLOCKED`) stays legal.

Exits are additionally judged against **`blockedFromStatus`**: leaving
`BLOCKED` to any status other than the one the task was blocked from requires
that `blockedFromStatus → target` be itself a legal transition — a two-hop
`PLANNING → BLOCKED → WORKING` must not launder past the plan-approval gate.
Reopen accounting also keys on `blockedFromStatus` (a blocked `REVIEW` task
sent to `WORKING` increments `reopenCount` and scrubs completion signals like
a direct `REVIEW → WORKING` would). Assignment: entering `BLOCKED` and
returning to `blockedFromStatus` both **preserve** `assignedWorkerId` (the
parked worker keeps its hold); any other exit keeps the normal
clear-on-move semantics. The plugin `/ws` board-move handler enforces the
same rules.

---

### moe.set_task_dependencies

Architect/governor escape hatch: replace a task's `dependsOn` list so a mis-declared dependency can never permanently withhold a row from WORKING claims. `dependsOn` is normally declared at `moe.create_task`; this tool edits it after the fact.

**Parameters:**
```typescript
{
  taskId: string,
  dependsOn: string[],   // full replacement, not a union; [] clears. Existing task ids, deduped, capped at 20, no cycles
  workerId?: string      // caller (auto-injected by proxy); role must resolve to architect or governor
}
```

**Errors:** `[INVALID_INPUT]` for a non-array, a non-string entry, an unknown id, a self-dependency, more than 20 ids, or an id that would close a dependency cycle (`would close a dependency cycle: task-A → task-B → task-A` — the walk follows `dependsOn ∪ blockedOnTaskIds` transitively, ignoring edges out of `DONE`/`ARCHIVED` rows); `[NOT_ALLOWED]` when the caller acts as neither architect nor governor (team role, else the `architect-`/`governor-` id prefix — see `moe.amend_plan_step`); `[NOT_FOUND]` for an unknown `taskId`. Nothing is written on any error.

**Returns:**
```typescript
{
  success: true, taskId,
  dependsOn: string[],           // the list now in force
  previousDependsOn: string[],   // what it replaced
  dependsOnUnmet: number,        // how many of the new targets are not yet DONE/ARCHIVED (0 = claimable now)
  message: string
}
```

**Notes:**
- `dependsOn` gates **WORKING-status claims only** (`claim_next_task`/`wait_for_task`): the task is not offered for execution until every target is `DONE`/`ARCHIVED`. Planning proceeds regardless, and a missing/deleted id counts as satisfied — a deleted prerequisite can never wedge its dependents.
- Withheld rows are explainable: `moe.list_tasks` rows carry `dependsOnUnmet`.
- **Cycles are rejected**, not stored: a `dependsOn` cycle (A→B then B→A, directly or through a longer chain) would leave every member claim-gated forever with nothing — no sweep, no alert, no wrapper path — ever looking at it. This tool is the hard-validation escape hatch, so it throws and names the path; `create_task` and `report_blocked` apply the same check advisorily (drop + warning).
- Distinct from `blockedOnTaskIds` (a `report_blocked` field for dependencies discovered mid-flight): `dependsOn` prevents a bad claim up front; `blockedOnTaskIds` parks an already-claimed task. Both are cleared by the same all-deps-done machinery, and both count as edges for the cycle check.

---

### moe.archive_task

Archive a single ticket so it drops out of agent context — `list_tasks` and
`search_tasks` hide `ARCHIVED` by default. Allowed from `BACKLOG`, `REVIEW`, or
`DONE`; rejected for in-flight tasks (move to `BACKLOG` or release first), and
refused with retryable `-32002` / `ATTEMPT_FINALIZING` while the task has a
`finalizing` attempt (see `moe.set_task_status`).
Idempotent. Un-archive with `set_task_status` `ARCHIVED → BACKLOG`.

**Parameters:**
```typescript
{ taskId: string }
```

**Returns:**
```typescript
{ success: true, taskId, status: "ARCHIVED", alreadyArchived?: true }
```

---

### moe.archive_epic

Archive an epic and all its tickets in one shot: every task → `ARCHIVED` and the
epic → `ARCHIVED`, removing the whole epic from agent context and the board.
Refuses (atomically — nothing changes) if any task is in-flight
(`PLANNING`/`AWAITING_APPROVAL`/`WORKING`), or with retryable `-32002` /
`ATTEMPT_FINALIZING` if any not-yet-archived task has a `finalizing` attempt —
checked for every task before the first write, so nothing is archived.
Idempotent.

**Parameters:**
```typescript
{ epicId: string }
```

**Returns:**
```typescript
{ success: true, epicId, epicStatus: "ARCHIVED", archivedTaskCount: number, totalTasks: number }
```

---

### moe.create_task

Create a new task in an epic. **Guardrails are ALL ADVISORY — creation never hard-fails.** Agents keep creating tasks (a full column must not wedge a rail-mandated spinoff); the board's anti-stuck duty is carried by dependency gating + auto-unblock, not by creation brakes.

**Parameters:**
```typescript
{
  epicId: string,
  title: string,
  description?: string,
  definitionOfDone?: string[],
  taskRails?: string[],
  status?: string,
  priority?: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW",
  parentTaskId?: string,
  order?: number,
  dependsOn?: string[],          // structural prerequisites (unknown ids, ids past the 20 cap, and cycle-closing ids are dropped — each with a warning naming them); gates WORKING-status claims only — see moe.set_task_dependencies
  workerId?: string,             // caller (auto-injected by proxy); resolves the creator's role for createdBy attribution
  createdBy?: "HUMAN" | "WORKER" | "ARCHITECT" | "QA" | "GOVERNOR"
}
```

**Returns:**
```typescript
{ success: true, task, warnings?: string[] }
```

`warnings` carries advisory task-shape feedback — **advisory only, the creation always succeeds**; the hard size gate lives in `moe.submit_plan`:
- empty `definitionOfDone` (a placeholder was substituted — give every task 3-7 mechanically checkable items), more than 7 DoD items (usually several tasks — split before planning), or a title containing "and" (often two tasks);
- **column limit at creation**: creating straight into a column past its `settings.columnLimits` cap warns (the transition path still throws — only creation is softened);
- **meta-row consolidation**: a meta-titled row (`/security|evidence|verif|harden|audit|acceptance|quality|proof|gate/i`) filed into an epic that already has another active (non-DONE) meta-titled row — the warning names the highest-order one as the consolidation target: fold the checks into it instead (the "by evidence type" anti-seam in `moe-epic-breakdown`);
- **epic size ceiling**: the epic now exceeds `settings.taskSizing.maxTasksPerEpic` (default 40) — re-slice into sub-epics;
- **dependsOn hygiene**: ids not on the board are dropped (named), ids past the 20-id cap are dropped (named — `dependsOn capped at 20; dropped: …`, split the task or edit via `moe.set_task_dependencies`), and an id that would close a dependency cycle over `dependsOn ∪ blockedOnTaskIds` is dropped (named, with the path). A fresh id is referenced by nothing yet, so the cycle warning cannot fire today — it exists so all three dependency writers share one rule.

`workerId` (auto-injected by the proxy) resolves the caller's role so agent-created tasks are attributed — `createdBy` records who actually filed the row, not just a `HUMAN`/`WORKER` binary.

Workers file bugs they find outside their step's scope as cards this way instead of fixing them in-line (same `epicId`, `title` prefixed `bug:`, `dependsOn: [<their taskId>]` only when the fix must land after theirs — see `docs/roles/worker.md`): `createdBy` resolves to `WORKER` from the injected `workerId`, and the guardrails above stay advisory, so a full column or a wide epic never blocks the filing.

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
{
  success: true,
  epic,
  nextAction: { tool: "moe.create_task", args: { epicId }, reason, recommendedSkill: { name: "moe-epic-breakdown", reason } }
}
```

The `nextAction` steers the architect into the slicing pass (`moe-epic-breakdown`) before the first `moe.create_task` — small tasks (typically 10-30 per epic, ~30-60 human-minutes, 1-3 files each) ending with an integration-and-hardening task.

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

Delete a task by ID. First closes every open execution attempt of the task, in
any phase — an attempt never outlives its task, because `moe.finalize_attempt`
refuses a missing task. A close that cannot be written fails the call and
changes nothing (the task, its file and any SPEED-mode auto-approval stay);
retry it. The board's `DELETE_TASK` and a `moe.delete_epic`
cascade go through the same path.

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

Clear `BLOCKED` status on a worker, setting it back to `IDLE`. **Seat-only by default**: the worker's seat is freed, but a `BLOCKED` task it holds stays `BLOCKED` with `blockedReason`/`blockedResourceId`/`blockedOnTaskIds`/`blockedFromStatus`/`blockedAt` intact — freeing a seat is not an assertion that the blocker is gone. Pass `resolveBlocks: true` to also restore the task; that is the human "blocker resolved" lever.

**Parameters:**
```typescript
{
  workerId: string,        // Required: the worker ID to unblock
  resolution: string,      // Required: what was done (seat freed / blocker resolved)
  retryTask?: boolean,     // If true, worker keeps currentTaskId to retry (default false)
  resolveBlocks?: boolean  // default false: also restore BLOCKED tasks to blockedFromStatus and clear every blocked* field
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
  resolveBlocks: boolean,
  releasedTaskIds?: string[],    // tasks whose assignment was cleared (absent when retryTask kept them)
  stillBlockedTaskIds: string[], // BLOCKED tasks left BLOCKED (the seat-only default, or retryTask without resolveBlocks)
  unblockedTaskIds?: string[],   // only with resolveBlocks: true — BLOCKED tasks restored to their blockedFromStatus
  message: string
}
```

**Notes:**
- **Default (`resolveBlocks` omitted/false)**: a `BLOCKED` task owned by the worker keeps its status and every `blocked*` field. Without `retryTask` its assignment is cleared via `nextStatusForRelease` (BLOCKED stays BLOCKED-unassigned; activity `WORKER_RELEASED`) and the id appears in both `stillBlockedTaskIds` and `releasedTaskIds`; with `retryTask: true` the task is left completely untouched (still assigned, still `BLOCKED`). Un-park it later with `resolveBlocks: true`, the resource grant path, or `set_task_status`.
- **`resolveBlocks: true`**: the task's status is restored to `blockedFromStatus` (fallback `WORKING`) and every `blocked*` field is cleared so the sweep/grant paths can't act on stale block state; activity `TASK_UNBLOCKED`; the id lands in `unblockedTaskIds` (and in `releasedTaskIds` too when `retryTask` is false).
- **Attempts:** every arm that clears the task's assignment — the seat-only default and `resolveBlocks: true` without `retryTask` — closes the task's `running`/`reconciling` attempts in that write (see **Close on hand-back** under Ownership & Ordering). The seat-only arm changes no status; the unassign alone is what closes. With `retryTask: true` the seat, and its attempt, are kept.
- Non-`BLOCKED` active tasks are released via `nextStatusForRelease` (**requeue**, not park) when `retryTask` is false — the task goes straight back into its role's claim pool.
- Why seat-only is the default: tasks were being **re-blocked** minutes after a governor freed a stuck seat, because the old behaviour wiped `blockedReason` and the next claimant walked into the same wall. Ordinary releases (daemon restart purge, `deregister_worker`, `release_task`) have always kept `BLOCKED` tasks `BLOCKED`; this tool is the exception only when `resolveBlocks: true` is passed.
- Git: the wrapper checkpoints a `BLOCKED` task's files on the BLOCKED exit, and again at the next pre-flight if a baseline lingers, so unblocking never has to worry about stranded bytes.

**Errors:**
- `workerId is required`
- `resolution is required`
- `Worker not found: <workerId>`
- `Worker must be in BLOCKED status` - if worker is not BLOCKED

---

### moe.release_task

Release a task from its assigned worker (clears `assignedWorkerId` and keeps the task claimable in place via `nextStatusForRelease`: WORKING stays WORKING-unassigned so the next worker resumes it via `priorHandoffs`, or →REVIEW if every step is already done; PLANNING/REVIEW/AWAITING_APPROVAL stay put; BLOCKED stays BLOCKED — the blocker is still there, only `moe.unblock_worker { resolveBlocks: true }`, the resource grant path, the dependency auto-unblock (all `blockedOnTaskIds` DONE/ARCHIVED), or `set_task_status` clears it). Anyone can call — no ownership check — but **staleness in `list_workers` is NOT evidence of shutdown**: a quiet worker may be mid-build with its CLI blocked on a long local step. Never release a WORKING/PLANNING task on idle time alone; release only on a confirmed crash (deregister banner, wrapper exit, human confirmation) or an explicit handoff. To pull a task OUT of the agent pool for human triage instead, use `set_task_status` → BACKLOG (the blocked-timeout sweep does this automatically — it *parks* in-flight tasks, PLANNING/WORKING/REVIEW → BACKLOG, so the next agent doesn't claim straight into the same blocker). `release_task` itself parks in exactly one case: the third empty-progress release inside 24h — see **Refusal cascade** below.

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
  status: TaskStatus,                // post-release status (routed via nextStatusForRelease)
  priorHandoffCount?: number,        // length of priorHandoffs after this release
  diskStateCaptured?: true,          // present only when a disk-state signature was stored
  cascadeTriggered?: true,           // present ONLY on the release that parked the task to BACKLOG
  message: string,
  warning?: string                   // set when called without handoffNote
}
```

**Side effects:**
- Sets `task.assignedWorkerId = null` and routes `task.status` via `nextStatusForRelease` (WORKING stays WORKING; all-steps-done → REVIEW). If the task was already unassigned, the only repair applied is the all-steps-done → REVIEW routing (WORKING-unassigned is already the claimable state for workers) — and the call still records the `handoffNote` instead of discarding it.
- **DONE/ARCHIVED tasks are a strict no-op** (any `handoffNote` is ignored with a warning): release must never resurrect finished work into a claimable column.
- Clears `needsHumanReview` when set — `release_task` is one of the documented human unpark paths for a task parked by the `qa_reject` hard cap; after release it re-enters the QA queue.
- When `handoffNote` is provided, builds a `HandoffNote` (with `releasedBy`, `releasedAt`, optional `reason`) and **prepends** it to `task.priorHandoffs` (newest-first, capped at 20).
- When `handoffNote` is provided, the daemon also captures a **disk-state signature** of the working tree (one `git status --porcelain=v2 --branch` run, outside the state mutex) into `handoffNote.diskState`, and echoes `diskStateCaptured: true`. Capture failure (no git, not a repo, timeout) degrades silently: the field is simply absent and no warning is raised. No signature is computed when the call carries no `handoffNote`.
- Without `handoffNote`, the chat broadcast tags the release `(released without handoff)` and the response includes `warning: "release_task called without handoffNote; next claimer will lack context."`.
- If the released worker exists and `worker.currentTaskId === taskId`, sets the worker to `IDLE` with `currentTaskId = null`.
- Posts the release line to `#general`, `#workers`, and `#governors`.
- Activity event: `WORKER_RELEASED`.

**Refusal cascade (the one exception to in-place routing):** three releases inside 24h that all report *no progress* park the task to BACKLOG instead of requeueing it — same reasoning as the blocked-timeout park, since a task no claim can move only claim-thrashes the next agent. Specifics:

- **Qualification comes from the structured `handoffNote.whatIsDone`** on the persisted notes, trimmed and case-folded: exactly `nothing`, `none`, `n/a`, `na`, or text starting `nothing…` / `no progress…`. Any description of real work does not count, so a normal context-switch handoff can never park a task.
- **A release with no `handoffNote` can never count** — without a note, progress is unknown, and unknown is not zero.
- Counting is over the existing newest-first `priorHandoffs` (capped at 20) **including the release being processed**, restricted to entries whose `releasedAt` parses to a finite time inside the 24h ending at this release. Unparseable, future, and older timestamps are skipped.
- Only a **real assigned-worker release** counts. An already-unassigned repair/handoff call is not a claim refusal and never parks the task, and DONE/ARCHIVED/AWAITING_APPROVAL are unaffected (the park reuses the `nextStatusForRelease` `park` routing, which leaves those statuses alone).
- On the triggering release only: `task.status` becomes `BACKLOG`, the response carries `cascadeTriggered: true` and an explanatory `message`, and a dedicated line is posted to `#governors` naming the task, the 3-in-24h threshold, and the human action needed. That post is best-effort like every other release broadcast — a chat failure never fails or rolls back the release. QA counters (`reopenCount` / `reopenReason`) are **not** touched.
- The worker is still released and set `IDLE` exactly as in a normal release. Un-park with `set_task_status` → PLANNING/WORKING/REVIEW.
- Disable with `settings.refusalCascadeAutoBacklog: false` (see docs/CONFIGURATION.md). Omitting the key leaves it enabled.

---

### moe.list_workers

List all registered workers with presence derived from `lastActivityAt`. **Display-only signal**: `isAlive: false` means "no tool call or heartbeat within the window" — which a live worker mid-build routinely exceeds. It is never evidence of shutdown and never grounds to release a task.

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
  // Present only when quiet workers still hold assignments. The hint warns
  // AGAINST releasing on idle (quiet ≠ dead — ping first); staleAssignments
  // is triage data, not a release worklist:
  hint?: string,
  staleAssignments?: Array<{ workerId, taskId, taskTitle, secondsSinceLastActivity }>
}
```

`isAlive` is the shared `isWorkerAlive` predicate (`status !== 'DEAD' && lastActivityAt` within the window). `DEAD` workers are excluded from the UI but still listed here (as `isAlive: false`) until pruned.

---

### moe.deregister_worker

Mark a worker `DEAD`, release every task it holds (routed via `nextStatusForRelease`: WORKING stays WORKING-unassigned, or →REVIEW if all steps are done; PLANNING/REVIEW/AWAITING_APPROVAL stay put; BLOCKED stays BLOCKED), and post chat-leave messages. Called by the agent wrapper's exit trap on terminal close (`trap … EXIT` in `moe-agent.sh`, top-level `finally` in `moe-agent.ps1`). There is no idle-based auto-release: a hard-crashed worker's task stays assigned until daemon restart, this tool, or `release_task`. **Idempotent** — repeat calls on an already-`DEAD` worker are no-ops, apart from the finalizing close below.

**Closes its own finalizing attempts, first.** Before anything else — before the missing-record and already-`DEAD` answers — the call closes every execution attempt in the `finalizing` phase whose `workerId` is this worker. It keys on the attempt, not on a task assignment or the worker record: `complete_task` already unassigned those rows, so no release reaches them, and while such an attempt is open no other seat may claim its task (see `moe.claim_next_task`'s **Finalizing hold on the task**). Without this close, a runner that exits without `moe.finalize_attempt` would wedge the row.
- **A pruned record is covered.** The close still runs when the worker record is already gone — a post-flight longer than `staleWorkerTimeoutMs` lets the record prune delete it mid-landing — and the call then answers `alreadyDead: true`.
- **Each real close publishes one `TASK_UPDATED`** for the unchanged task, which wakes the `moe.wait_for_task` waiters the hold kept parked.
- **A failed close never fails the call.** It is logged and leaves the attempt `finalizing`. The retry is a quiet, close-only call on the now-`DEAD` worker: it still answers `alreadyDead: true`, with no chat line, no activity row and no `WORKER_DELETED`.
- **Why it cannot cut a landing short.** The wrapper sends `moe.deregister_worker` only from its exit and teardown paths — after the landing, its rescue or its abandonment. It is an explicit end-of-life call, not an idle signal.
- **It is not evidence of a landing.** On some exits no `moe.finalize_attempt` precedes it: the sh EXIT trap before any landing ran, a ps1 console window closed, a finalize whose acknowledgement failed. The close then lifts `moe.qa_approve`'s finalizing hold without an acknowledged landing, as a QA claim's supersede did before the hold on the task existed. Under the default `legacy` delivery policy the soft `NO-COMPLETION-COMMIT` warning is then the only guard; a strict `settings.deliveryPolicy` still refuses the approval.
- **Nothing else closes it on a worker's behalf, except removing a `DEAD` record.** Worker deletion, the startup purge and the sweeps release tasks by assignment and by the hand-back rule, which spares a finalizing attempt, so none of them closes one on an idle signal. The one exception is this call's own failure: a failed close leaves the record `DEAD` and still holding the attempt, and removing that `DEAD` record — the stale-record prune or the startup purge — retries the close; a close that fails again keeps the record for the next pass. A runner killed with no exit trap leaves a record that is not `DEAD`, so its row stays held until a governor or human closes the boundary (see `moe.finalize_attempt`'s **Escape for a runner that is gone** and **Every end of a finalizing attempt**).

The daemon-restart purge is no longer unconditional: a worker that owns a non-closed execution attempt is **spared**, so its identity — the worker record, its map entry and its `currentTaskId` — survives the restart and its task is held rather than released (see `moe.reattach_attempt`). Every worker with no attempt, or only closed ones, is purged exactly as before.

**Parameters:**
```typescript
{
  workerId: string,   // Worker ID to deregister
  reason?: string     // Short reason ("terminal_closed", …). Default: "deregistered".
}
```

**Returns:**
```typescript
{
  success: true,
  workerId: string,
  alreadyDead: boolean,       // true if the worker was already DEAD with no task, or its record is gone (no-op apart from the finalizing close)
  releasedTaskIds: string[],
  releasedCount: number,
  message: string
}
```

The worker record is retained (status `DEAD`) for post-mortem/idempotency, dropped from the UI immediately (a `WORKER_DELETED` event is emitted and `DEAD` workers are excluded from state snapshots), and pruned later once it owns nothing.

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
- `🚧 {worker} blocked on {taskId}: {reason}` (from `moe.report_blocked`; the `#governors` copy is prefixed `@governors` only when no live architect could be paged).
- `❌ QA rejected {taskId}: {reason}` (from `moe.qa_reject`).
- `🔓 {worker} released task: {title}` (from `moe.release_task`).
- `🛑 task {id} ({title}) parked to BACKLOG after 3 empty-progress releases in 24h …` (from `moe.release_task`'s refusal cascade; needs human reprioritization).
- `⚠️ {worker} stale on {taskId} ({title}) — last activity {N}s ago. Quiet ≠ dead (long builds/tests are silent): ping before acting; never release on idle alone.` (from the daemon's stale-worker watcher; only fires when at least one governor is online; a presence/triage signal, not a release trigger).
- `📋 New plan needed: {title} ({id})` (cross-post of the PLANNING announcement; informational — governors never claim PLANNING tasks).

---

### moe.qa_approve

QA approves a task in REVIEW status, moving it to DONE. Requires a `summary` of what was verified — symmetric with `qa_reject`'s required `reason`, so DONE tasks carry an audit trail instead of a rubber stamp. Under the default `settings.deliveryPolicy` (`legacy`) it is also a **soft commit gate**: it warns (never rejects) when no completion commit has been recorded for this review round. Under a strict delivery policy it is a **hard evidence gate** instead: an approval whose recorded evidence does not satisfy the policy is refused with `-32003` / `DELIVERY_EVIDENCE_MISSING` (see the delivery evidence gate below). Either way it returns the task's commit evidence so QA can cite the sha it actually reviewed.

**Parameters:**
```typescript
{
  taskId: string,
  summary: string,       // REQUIRED — what was verified: commands re-run, DoD items checked (max 2000 chars)
  candidateId?: string,  // The candidate you actually reviewed — get_context.currentCandidate.id
  manualArtifact?: string,     // deliveryPolicy manual-artifact ONLY: the deliverable you checked by hand (max 500 chars)
  mergedPullRequest?: string,  // deliveryPolicy merged-pull-request ONLY: the pull request you confirmed merged (max 500 chars)
  workerId?: string
}
```

The summary is persisted on the task as `reviewSummary`. Under `manual-artifact` / `merged-pull-request` the attestation is persisted as `task.deliveryEvidence`: `{ kind, reference, verifiedDelivery: false, recordedBy, recordedAt }`. A later approval that needed no attestation clears it.

**Returns:**
```typescript
{
  success: true, taskId, status: "DONE", summary, message,
  deliveryPolicy?: string,   // present only under a strict settings.deliveryPolicy; absent under the default 'legacy'
  deliveryEvidence?: { kind, reference, verifiedDelivery: false, recordedBy, recordedAt },  // the attestation DONE rested on (manual-artifact / merged-pull-request); message then ends "(evidence: <kind> attested by <recordedBy> — NOT verified delivery)"
  warning?: string,      // the NO-COMPLETION-COMMIT line, when it fired
  warnings: string[],    // ALWAYS present ([] when clean): the NO-COMPLETION-COMMIT line "NO-COMPLETION-COMMIT: task <id> has no completion commit recorded yet (the wrapper lands it seconds after REVIEW) — verify task.commits / git log before merging" and/or the NO-REVIEWED-CANDIDATE line (see the candidate gate below)
  commitEvidence: {      // task.commits split by kind — a 4-FIELD PROJECTION per entry: { sha, ref, pushed: boolean|null, recordedAt }. Full TaskCommit entries (paths, recordedBy, status…) live in task.commits / get_context.
    completion: Array<{ sha, ref, pushed: boolean | null, recordedAt }>,   // only entries recorded since this work round began count against the warning (see "When the warning fires")
    checkpoint: Array<{ sha, ref, pushed: boolean | null, recordedAt }>,
    rescue: Array<{ sha, ref, pushed: boolean | null, recordedAt }>
  }
}
```

**Notes:**
- **Reviewed-candidate binding (a hard refusal, unlike the commit gate).** An approval must apply to the bytes the reviewer actually read. Pass `candidateId` — the id from `get_context`'s `currentCandidate` — and if the task has since moved on to a different candidate the call is refused with `-32002` / `CANDIDATE_MISMATCH` **before any write**: no `Review` record, no DONE write, no worker touch, no chat line, a byte-identical task file and candidate files. The refusal's `context` carries `expectedCandidateId` (what you reviewed) and `currentCandidateId` (what the task holds now); re-read the current candidate and decide again. A `candidateId` naming a candidate of a *different* task is a mismatch, not a match. (`MoeError.context` is not forwarded over the MCP wire, so a remote caller reads both ids from the message text.)
- **A `Review` record is persisted for every bound decision**, approve and reject alike: `{ taskId, candidateId, reviewerId, decision, summary }` at `.moe/reviews/<id>.json` (see docs/SCHEMA.md). `reviewerId` is the caller's `workerId`, or `human` on the IDE/human path. It is written *before* the status flip, so a DONE task always carries the record of which bytes were signed off. Reviews are append-only — reviewing a reopened task again appends a second record.
- **Incremental adoption.** A task with **no candidate recorded** behaves exactly as it did before this gate existed, **whether or not `candidateId` is supplied**: the approval lands, no `Review` is written, and `warnings`/`commitEvidence`/`message` are unchanged — a well-formed `candidateId` binds nothing there and adds no warning. When a candidate *does* exist but `candidateId` is omitted, the approval still lands and is still bound to the current candidate, but `warnings` gains `NO-REVIEWED-CANDIDATE: task <id> has current candidate <cand> but qa_approve named none — pass candidateId so the decision is bound to the bytes you actually read`. `candidateId: null` counts as omitted. Any other `candidateId` that is not a valid entity id — blank, not a string, a character outside `[A-Za-z0-9_-]`, or longer than 128 — is refused `-32602` / `INVALID_INPUT` on every path, a task with no candidate included, and is never treated as omitted.
- **Finalizing hold (a hard refusal, unlike the commit gate).** While the task has an execution attempt in the `finalizing` phase, approval is refused with `-32002` / `ATTEMPT_FINALIZING` before any mutation — no DONE write, no worker touch, no chat line, a byte-identical task file. The bytes are not landed yet, so DONE would be premature. The hold is scoped **by task, not by worker**, because the IDE/human approval path carries no `workerId` at all and the REVIEW handoff has already cleared `assignedWorkerId`. It is lifted by `moe.finalize_attempt`, by its runner's `moe.deregister_worker` (which is not evidence of a landing — see that tool), or by the other ends `moe.finalize_attempt` lists under **Every end of a finalizing attempt**, and its `context.retryable` is `true` — retry after the runner finalizes rather than escalating. A QA claim can no longer lift it: while the attempt is `finalizing`, no seat other than its own worker may claim the row (see `moe.claim_next_task`'s **Finalizing hold on the task**). A claim used to close the attempt, which silently dropped this hold and fenced the runner's `moe.record_candidate` out as superseded. See `moe.finalize_attempt`.
- **Delivery evidence gate (a hard refusal under a strict `settings.deliveryPolicy`).** Under the default `legacy` policy none of this applies and the commit gate stays advisory. Under `local-branch`, `remote-push`, `merged-pull-request` or `manual-artifact` (see docs/CONFIGURATION.md), an approval whose recorded evidence does not satisfy the policy is refused with `-32003` / `DELIVERY_EVIDENCE_MISSING` **before any write**: no `Review`, no DONE write, no worker touch, no chat line, and a byte-identical task file.
  - **Precedence.** The finalizing, ownership, context, summary and reviewed-candidate guards all run first.
  - **Refusal shape.** `context` is `{ taskId, deliveryPolicy, missingEvidence }`. `missingEvidence` is an array of tokens: `completion-commit` (no completion commit recorded since this work round began, the rule the warning below uses); `pushed-completion-commit` (none recorded as pushed); `merged-pull-request` or `manual-artifact` (no attestation passed); and `required-check:<qualityGate>` (a gate the wrapper runs for this task has no runner-observed exit-0 `CheckRun` on the task's current candidate and its tree). The token carries the trimmed setting, and a recorded `command` that differs from it only by surrounding whitespace counts.
  - **On the wire.** `MoeError.context` is not forwarded over MCP, so the message names every token with its reason. It adds a hint when `autoCommit` is `false`.
  - **Retry.** A missing commit is usually the post-flight race described below: retry once `task.commits` shows it.
  - **Attestations.** Each one is accepted only under the policy it satisfies, and must be non-blank and at most 500 chars; anything else is `INVALID_INPUT`. It is recorded as `task.deliveryEvidence` with `verifiedDelivery: false`, and it never stands in for another kind of evidence.
  - **Invalid policy.** An unrecognised `deliveryPolicy` value refuses every approval with `INVALID_INPUT`. It never falls back to the default.
  - **Honest boundary.** The gate reads **recorded** evidence and re-runs nothing, so a commit, check or attestation record that misreports what happened still satisfies it.
  - **Shared rule.** The predicate is `evaluateDeliveryEvidence` in `packages/moe-daemon/src/delivery/policy.ts`, exported so a dependency gate judges a DONE prerequisite by the same rule instead of re-deriving it. The two gates cannot disagree. On a DONE task only the required check is re-judged, because landing evidence was already judged at the DONE transition. The dependency gate reads the same predicate: a DONE prerequisite without its required check keeps withholding its dependents from `claim_next_task`, `wait_for_task` and the `blockedOnTaskIds` auto-unblock (`DEPENDENCY_EVIDENCE_MISSING` on an explicit claim; see `moe.claim_next_task`).
- **When the warning fires**: `settings.autoCommit !== false` and no `task.commits` entry has `kind: "completion"` recorded since this work round began: at or after the latest rejection, else the first step start, else `task.reviewStartedAt` (a round opened by `qa_reject` does not count a completion commit landed before it; a reopen by `set_task_status` or the board records no rejection and leaves the round's start where it was, so a completion commit landed before that reopen still counts; one a worker records by hand just before `complete_task` counts too). The same line is posted to `#governors` (best-effort, after the DONE write). With `autoCommit: false` there is no warning — the project opted out of wrapper commits.
- **Race**: the wrapper lands the completion commit and calls `moe.record_commit` *after* the worker's CLI exits, while QA's `wait_for_task` wakes on the REVIEW write itself, so an approval within seconds of REVIEW can legitimately see no commit yet. Wait for the `[OK] Committed completion …` banner / the task-channel record line, then `git show <sha>` — do not review the dirty shared tree.
- **Under `legacy`, approval always lands**: the commit gate is advisory. Reopening (`qa_reject`, `set_task_status`) never clears `task.commits`.
- QA policy: treat the warning as a reject unless you verified HEAD yourself (`docs/roles/qa.md`).

**Errors:**
- `taskId is required`
- `summary` missing/empty → `MISSING_REQUIRED` (checked after ownership/context guards)
- `Task not found: <taskId>`
- `Task must be in REVIEW status to approve`
- `candidateId` is not the task's current candidate → `-32002` / `CANDIDATE_MISMATCH`, with `context.expectedCandidateId` + `context.currentCandidateId`
- a strict `settings.deliveryPolicy` is not satisfied → `-32003` / `DELIVERY_EVIDENCE_MISSING`, with `context.taskId` + `context.deliveryPolicy` + `context.missingEvidence` (a token array; the message names each token)
- `settings.deliveryPolicy` is not a recognised value → `-32602` / `INVALID_INPUT` (`Invalid deliveryPolicy: must be one of legacy, local-branch, remote-push, merged-pull-request, manual-artifact (got …)`)
- `manualArtifact` / `mergedPullRequest` is blank, not a string, over 500 chars, or passed under a policy it cannot satisfy → `-32602` / `INVALID_INPUT`

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
  candidateId?: string,            // The candidate you actually reviewed — get_context.currentCandidate.id
  workerId?: string
}
```

**Returns:**
```typescript
{
  success: true, taskId, status: "WORKING" | "PLANNING",
  reopenCount, maxReopens, exceededReopenCap: boolean,
  repeatedFailedDodItem?: string,
  reason,
  warnings?: string[],             // present ONLY when the NO-REVIEWED-CANDIDATE line fired (see the candidate gate below); otherwise the key is absent, never []
  rejectionDetails, rejectionHistory: RejectionHistoryEntry[],
  failedDodItems: FailedDodItem[],
  message,
  nextAction
}
```

**Notes:**
- **Reviewed-candidate binding — identical to `qa_approve`'s.** Pass the `candidateId` you reviewed; a mismatch against the task's current candidate is refused with `-32002` / `CANDIDATE_MISMATCH` before any write (no `Review`, no status flip, no history entry), carrying `context.expectedCandidateId` + `context.currentCandidateId`. A bound rejection persists a `Review` with `decision: "reject"` and `summary` = the rejection `reason`, written before the status flip. A task with no candidate recorded behaves exactly as before — no `Review` and no `warnings` key — even when a `candidateId` is supplied. An omitted (or `null`) `candidateId` on a task that has one still lands, bound to the current candidate, and `warnings` is exactly one line: `NO-REVIEWED-CANDIDATE: task <id> has current candidate <cand> but qa_reject named none — pass candidateId so the decision is bound to the bytes you actually read`. A malformed `candidateId` is refused `INVALID_INPUT` on every path, as in `qa_approve`.
- Increments `reopenCount` and `metrics.rejectCount`; sets `reopenReason`.
- Appends a `RejectionHistoryEntry` to `rejectionHistory[]` (newest-first, capped at 20).
- Populates `failedDodItems[]` (append-only, capped at last 100) — every supplied DoD item is recorded with `rejectedAt` + `rejectedBy`.
- **Auto-flip to `PLANNING`** when either:
  - `reopenCount ≥ maxReopens` (default 3 via `MAX_REOPENS_DEFAULT`; per-task override `task.maxReopens`), OR
  - the **same DoD item has failed ≥2 times** in `failedDodItems[]`.
- On auto-flip, posts a heads-up to `#architects`; on every rejection, cross-posts `❌ QA rejected ...` to `#governors`.
- **Closes the QA seat's attempt:** the flip clears `assignedWorkerId` (the hard-cap park writes `null` explicitly), and that write closes the task's `running`/`reconciling` attempts (see **Close on hand-back** under Ownership & Ordering). A daemon restart after the rejection therefore has nothing of the QA seat's to park, and an explicit `moe.claim_next_task` of the returned row succeeds with the next generation.

**Errors:**
- `taskId is required`
- `reason is required - explain which DoD items failed and why`
- `Task not found: <taskId>`
- `Task must be in REVIEW status to reject`
- `candidateId` is not the task's current candidate → `-32002` / `CANDIDATE_MISMATCH`, with `context.expectedCandidateId` + `context.currentCandidateId`

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

### moe.add_comment

Add a comment to a task (for questions or responses). This is how agents answer pending human questions surfaced by `moe.get_pending_questions`.

**Parameters:**
```typescript
{
  taskId: string,    // Required: the task ID to comment on
  content: string,   // Required: comment text (trimmed; non-empty, max 10000 chars)
  workerId?: string  // Comment author (defaults to "agent")
}
```

**Returns:**
```typescript
{ success: true, taskId, commentId, totalComments }
```

**Notes:**
- The stored comment is `{ id, author, content, timestamp }`; `content` is trimmed before storage and validation.
- Posting a comment clears `hasPendingQuestion` on the task — it counts as answering the outstanding human question (and stops `moe.wait_for_task` waking for it).
- The task's comment list is bounded: only the most recent `MAX_COMMENTS_PER_TASK` comments are kept (default 200, override via `MOE_MAX_COMMENTS_PER_TASK`); older comments are dropped.
- The update is broadcast as a `TASK_COMMENT_ADDED` event.

**Errors:**
- `[MISSING_REQUIRED] Missing required field: taskId`
- `[MISSING_REQUIRED] Missing required field: content` — `content` absent or empty after trimming
- `[INVALID_INPUT] Invalid content: must be a string` / `[INVALID_INPUT] Invalid content: must be 10000 characters or fewer`
- `[TASK_NOT_FOUND] Task not found: <taskId>` — unknown `taskId`

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

Long-poll for chat messages mentioning this worker or from humans. **Burst-aware**: any unread backlog is returned immediately instead of blocking, and a wake returns everything waiting across the watched channels in one response — not just the message that triggered it.

**Parameters:**
```typescript
{
  workerId: string,     // Required: your worker ID
  channels?: string[],  // Optional: channel filter
  sinceId?: string,     // Optional: explicit catch-up cursor, overrides stored per-channel cursors
  timeoutMs?: number,   // Max wait (default 300000, max 600000)
  maxContentChars?: number // Max chars/message in response (default 1000, 0 = full)
}
```

**Returns:**
```typescript
{ hasMessage: true, messages: [ChatMessage], truncated: number, hasMore?: true }  // on match
{ hasMessage: false, timedOut: true }           // on timeout
{ hasMessage: false, cancelled: true }          // if cancelled
```

**Notes:**
- Follows the same long-poll pattern as `moe.wait_for_task`
- **Backfill on entry**: the caller's per-channel cursors are drained before blocking, so a message that landed between the last `chat_read` and this call comes back immediately. The subscription is installed *before* the drain, so nothing arriving mid-drain is lost.
- **Full burst on wake**: waking re-drains every watched channel and returns the whole burst (up to 100 messages) in one response, ordered oldest-first. `hasMore: true` means the burst was capped and another call has more waiting.
- When `channels` is explicitly provided, wakes on **any** message in those channels — the subscription set is the filter (matches the governor `#governors` watch pattern).
- When `channels` is omitted (broad scope), only wakes for messages where `workerId` is in `mentions` or `sender` is `"human"`. The *drain* applies no such filter: once a channel is in scope it returns everything since the cursor, so group pings stored as raw mention tokens are not silently dropped.
- `sinceId` is an explicit catch-up override: it replaces the stored cursor for every scanned channel and, with no `channels` filter, widens the scan to every channel (a reconnect has usually already cleared the unread bookkeeping the broad-scope scan relies on). A `sinceId` that is unknown in a given channel degrades to that channel's most recent window — useful as a resync, but it can rewind that channel's cursor and re-deliver messages.
- **Cursors advance only for delivered messages the drain actually read.** A capped burst stops the cursor at the last message returned; a channel the drain never scanned moves no cursor at all; and a message delivered straight off the event bus (the wake trigger, or anything that arrived mid-drain) never moves its channel's cursor, because it says nothing about the messages between it and where the scan stopped — a channel with more than 50 waiting would otherwise be skipped. Such a message is simply re-delivered on the next call. Unread counts are cleared only for channels that were fully drained. A failed cursor write is logged and the messages are still returned (a duplicate delivery beats a lost one).
- Cancels any previous wait for the same worker
- Aborts with `{ hasMessage: false, cancelled: true, error }` if a subscribed channel is deleted while waiting

---

### moe.chat_who

List online workers, optionally filtered by channel participation.

**Parameters:**
```typescript
{
  channel?: string      // Optional: channel ID to filter by participation
}
```

**Returns:**
```typescript
{ online: Array<{ workerId, status, lastActivity, currentTaskId, source }> }
```

**Notes:**
- Online = activity within the last 120 seconds (same presence window as `moe.chat_join`)
- With `channel`: includes workers with a chat cursor for the channel **and** workers currently blocked in `moe.chat_wait` watching it; `source` is `cursor`, `waiting`, or `both`
- Without `channel`: returns all online workers

---

### moe.chat_create_channel

Create a custom chat channel for ad-hoc agent coordination.

**Parameters:**
```typescript
{
  name: string          // Required: channel name
}
```

**Returns:**
```typescript
{ success: true, channel }            // created
{ success: false, error }             // e.g. name conflict
```

---

### moe.chat_pin

Pin a chat message to a channel. Pinned messages serve as todos or important references.

**Parameters:**
```typescript
{
  channel: string,      // Required: channel ID
  messageId: string,    // Required: message ID to pin
  workerId: string      // Required: worker pinning the message
}
```

**Returns:**
```typescript
{ success: true, pin }
```

---

### moe.chat_unpin

Remove a pinned message from a channel.

**Parameters:**
```typescript
{
  channel: string,      // Required: channel ID
  messageId: string     // Required: message ID to unpin
}
```

**Returns:**
```typescript
{ success: true }
```

---

### moe.chat_decision

Propose a decision for human approval. Optionally post it to a chat channel.

**Parameters:**
```typescript
{
  content: string,      // Required: what is being proposed
  channel?: string,     // Optional: channel ID to post the decision to
  workerId?: string     // Optional: proposing worker
}
```

**Returns:**
```typescript
{ success: true, decision }
```

---

### moe.chat_resync

Clear chat cursors and return a bounded, token-budgeted message window — for agents resuming after context loss.

**Parameters:**
```typescript
{
  workerId: string,     // Required: worker whose cursors to reset
  channel?: string,     // Optional: specific channel (omit for all)
  limit?: number,       // Max messages per channel (default 20, max 200)
  maxContentChars?: number // Max chars/message in response (default 1000, 0 = full)
}
```

**Returns:**
```typescript
{ success: true, messagesCount, messages, cursorsReset: true, truncated, hint? }
```

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
- `aggregate.firstPassApprovalPct` is an integer **percentage on the 0..100 scale**, not a 0..1 ratio — a first-pass rate of one task in two is emitted as `50`. Clients must render it as-is and must never multiply it by 100 (both IDE plugins once did, showing `5000%`). The same 0..100 unit applies to the `firstPassApprovalPct` in the plugin `GET_METRICS` response.
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

### moe.submit_plan_critique

Governor-only (team role, else the `governor-` worker-id prefix — see `moe.amend_plan_step`; anything else is `NOT_ALLOWED`). Record a structured critique of a submitted plan. `verdict='block'` flips the task back to `PLANNING` with concerns posted to `#architects`; `verdict='pass'` is informational. **Does not auto-approve** — humans still own approval.

**Parameters:**
```typescript
{
  taskId: string,
  verdict: 'pass' | 'block',
  concerns?: string[],   // max 20 entries, ≤1000 chars each; required when verdict='block'
  category?: 'size' | 'correctness' | 'rails' | 'dependency',  // what kind of block this is — expected on block verdicts
  workerId?: string
}
```

**Returns:**
```typescript
{
  success: true, taskId, status,
  verdict: 'pass' | 'block',
  category?: string,     // echoed when supplied
  warning?: string,      // a block verdict without a category draws this (recorded as 'uncategorized')
  concerns: string[],
  planCritiqueResult: { verdict, concerns?, category?, reviewedBy, reviewedAt }
}
```

**Notes:**
- `block` only flips the task back to `PLANNING` when its current status is `AWAITING_APPROVAL` or `WORKING`. If a human has already advanced the task past those, the critique becomes purely advisory.
- `category` makes block verdicts countable (open-ended "add more evidence rows" critiques were unmeasurable). A `block` without a `category` is accepted but draws a warning and is counted as `uncategorized` — WARN-when-missing rather than hard-required, for rollout compatibility with older governors. `pass` verdicts don't need one.
- On `block`, posts `🚫 plan blocked on <id>` to `#architects` (with bulleted concerns) and a one-line summary to `#governors`. On `pass`, posts `✅ critique passed: <id>` to `#governors`.
- Clears `task.pendingPlanCritique` once a critique lands (idempotent).

---

## Shared Resources

Daemon-owned admission control for exclusive-use infrastructure (a benchmark box, a staging DB, a GPU) — replaces per-project marker files + pid probes. Leases are keyed by **task id**, not worker id, so they survive CLI respawns and the daemon-restart worker purge (the underlying work — a detached multi-hour run — survives them too). Runtime state is persisted at `.moe/resources/<id>.json` (daemon sole-writer, like all of `.moe/`).

Resource ids must match `[A-Za-z0-9][A-Za-z0-9._-]{0,63}` (1–64 chars). Acquiring an **undeclared** id auto-creates the resource with the defaults — capacity `1`, `maxLeaseMs` `86400000` (24h; generous because real leases cover multi-hour benchmark runs). Declare overrides in `.moe/project.json` `settings.resources` (see docs/CONFIGURATION.md). The queue is ordered by task priority (`CRITICAL` > `HIGH` > `MEDIUM` > `LOW`; missing task → `MEDIUM`), then FIFO.

The grant path is the point: when capacity frees (release, lease expiry, or reaping), the daemon promotes the best queue entry to a lease — and if that task is `BLOCKED` on the resource (`blockedResourceId` set via `moe.report_blocked`), flips it back to its `blockedFromStatus`, which wakes the fleet (a `🟢` grant line is also posted to the task channel and `#general`). The blocked-timeout sweep also runs a **reap pass** under the same mutex: leases past `expiresAt` are force-released (with a `⏱️` escalation to `#general` + `#governors` — the analogue of the heartbeat sidecar's max-duration cap, bounding a crashed holder), leases/queue entries whose task is gone or left the active statuses (`PLANNING`/`WORKING`/`REVIEW`/`BLOCKED`) are dropped, and freed capacity is granted onward. That sweep deliberately does **not** park a resource-waiting `BLOCKED` task to BACKLOG — it is waiting legitimately, and its bound is the lease reaper, not the blocked timeout.

### moe.acquire_resource

Acquire (or queue for) a lease on a shared resource. Granted immediately if capacity is free; otherwise you are queued FIFO-by-priority.

**Parameters:**
```typescript
{
  resourceId: string,   // 1-64 chars: letters, digits, ".", "_", "-". Undeclared ids auto-create with defaults
  taskId: string,       // Lease owner — leases are task-keyed so they survive CLI restarts
  workerId: string,
  note?: string,        // What you will run (≤500 chars) — shown to queued agents and list_resources
  etaMs?: number        // Your own wall-clock estimate in ms (informational only)
}
```

**Returns:**
```typescript
// Capacity free (or you already hold a lease — renewal):
{ success: true, granted: true, resourceId, lease: ResourceLease, message }

// Busy — queued:
{
  success: true, granted: false, resourceId,
  position: number,       // 1-based, in grant order (priority then FIFO)
  queueLength: number,
  holders: Array<{ taskId, workerId, note?, etaMs?, acquiredAt, expiresAt }>,
  message,
  nextAction: { tool: "moe.report_blocked", args: { taskId, workerId, reason, resourceId }, reason }
}
```

**Notes:**
- Caller must own the task (`assertWorkerOwns`); the task must exist.
- **Idempotent per `taskId`:** re-acquiring an existing lease renews `expiresAt` (now + `maxLeaseMs`) and refreshes `note`/`etaMs`; re-acquiring an existing queue entry refreshes `note` without losing queue age. A direct grant also drops any stale queue entry from an earlier queued attempt.
- `lease.expiresAt` is the hard cap (acquiredAt + `maxLeaseMs`, default 24h): the reap pass force-releases past it, so a crashed holder cannot strand the resource forever. Release explicitly when the run finishes — the cap is a crash bound, not the release mechanism.
- When queued with no other work left on the task, follow the `nextAction`: `moe.report_blocked` with the `resourceId` parks the task (`BLOCKED`), the wrapper stops relaunching sessions, and the daemon auto-unblocks the task the moment the lease is granted. If you DO have non-resource work left, do that first and re-check with another `acquire_resource` call later — never poll in a tight loop.
- Activity events: `RESOURCE_ACQUIRED` on grant, `RESOURCE_QUEUED` on first enqueue.

---

### moe.release_resource

Release your lease on a shared resource (and/or leave its queue). The freed capacity is granted to the next waiter immediately, auto-unblocking its task.

**Parameters:**
```typescript
{
  resourceId: string,
  workerId: string,
  taskId?: string,   // Limit the release to this task's lease/queue entry. Default: everything held by workerId
  force?: boolean    // Governor/human override: release regardless of ownership.
                     // With taskId: that lease; without: ALL leases and queue entries
}
```

**Returns:**
```typescript
{
  success: true,
  resourceId: string,
  released: string[],          // taskIds whose leases were released
  removedFromQueue: string[],  // taskIds dropped from the queue
  grantedTo: string[],         // taskIds granted leases from the freed capacity
  message: string
}
```

**Notes:**
- **Idempotent:** releasing a resource you neither hold nor queue on is a no-op, not an error — release paths run from exit traps.
- **Ownership is task-keyed like the lease itself:** the caller matches a lease/queue entry when its `workerId` equals the recorded one **or** when the caller is the **current assignee of the entry's task** — so a successor wrapper session (fresh `workerId` after a daemon-restart worker purge) that re-claimed the task can release the predecessor's lease.
- The grant runs inline: the next waiter(s) in grant order get leases, and each granted task that is `BLOCKED` on this resource is flipped back to its `blockedFromStatus` (auto-unblock) with a `🟢` post to the task channel and `#general`.
- `force: true` is the governor/human lever for a stuck lease (crashed holder that never released). Without `taskId` it clears **all** leases and queue entries on the resource — scope it with `taskId` unless you mean that.
- Activity events: `RESOURCE_RELEASED` per released lease (with `forced` flag), then `RESOURCE_GRANTED` per grant.

---

### moe.list_resources

List every shared resource: declared config, current lease holders (with notes/ETAs/expiry) and the wait queue in grant order.

**Parameters:**
```typescript
{ workerId?: string }   // Optional; refreshes the caller's heartbeat when present
```

**Returns:**
```typescript
{
  success: true,
  resources: Array<{
    id: string,
    capacity: number,       // resolved: declared or default 1
    maxLeaseMs: number,     // resolved: declared or default 86400000 (24h)
    description?: string,   // from settings.resources
    holders: Array<{ taskId, workerId, note?, etaMs?, acquiredAt, expiresAt, taskTitle? }>,
    queue: Array<{ taskId, workerId, note?, requestedAt, position, taskTitle?, taskStatus? }>
  }>
}
```

**Notes:**
- The listing is the **union** of runtime state and `settings.resources` declarations, so a declared-but-idle resource is visible before its first acquire.
- Resources are sorted by id; each queue is sorted by grant order (priority then FIFO) with a 1-based `position`.
- Governors use this to spot convoys, stale leases and merge opportunities.

---

### moe.wait_for_resource

Block until this task's lease on a shared resource is granted (or the timeout fires). Ensures you are queued first (same grant-or-enqueue semantics as `moe.acquire_resource`), so a bare `wait_for_resource` call is safe.

**Parameters:**
```typescript
{
  resourceId: string,
  taskId: string,
  workerId: string,     // Your worker ID (used for cleanup on disconnect)
  timeoutMs?: number    // Max wait in ms (default 300000, clamped to 1000–600000)
}
```

**Returns:**
```typescript
// Lease granted (immediately, or on a RESOURCE_UPDATED wake):
{ granted: true, resourceId, lease: ResourceLease,
  nextAction: { tool: "moe.release_resource", args, reason } }  // run the work, then release

// Timeout elapsed:
{ granted: false, timedOut: true, resourceId,
  position: number | null,   // current 1-based queue position
  nextAction: { tool: "moe.wait_for_resource", args, reason } } // re-enter wait — or report_blocked to park

// Cancelled (superseded wait, MCP client disconnect, or stale-waiter sweep):
{ granted: false, cancelled: true }

// Internal failure subscribing to state events:
{ granted: false, error: "subscribe_failed" }
```

**Notes:**
- Marked `blocking` — like `moe.wait_for_task` / `moe.chat_wait`, the MCP dispatch layer does **not** wrap it in the global state mutex (it can park for minutes; all other tools stay serialized). It takes the mutex only for the grant-or-enqueue mutation on entry.
- Caller must own the task (`assertWorkerOwns`).
- Calling `wait_for_resource` again with the same `workerId` cancels the previous wait (the earlier call resolves `{ granted: false, cancelled: true }`). The same cancellation fires on MCP client disconnect and when the stale-waiter sweep finds the worker no longer tracked.
- Refreshes the worker heartbeat on entry and again on timeout, so a parked worker is not treated as idle.
- **Prefer `moe.report_blocked` + session exit for waits expected to run hours** — the wrapper idles and the grant path auto-unblocks the task without burning an open session. This tool is for short waits inside a live session.

---

## Liveness & Diagnostics

### moe.get_activity_log

Read the activity log with filtering and pagination — newest first.

**Parameters:**
```typescript
{
  taskId?: string,      // Filter by task
  epicId?: string,      // Filter by epic
  workerId?: string,    // Filter by worker
  eventTypes?: string[],// Filter by event type
  limit?: number,       // Default 10, max 100
  offset?: number,      // Max 10000
  maxPayloadChars?: number // Default 500, max 2000
}
```

**Notes:**
- Filtered queries scan at most 5000 recent lines; older matches are not returned

---

### moe.heartbeat

Presence ping: refreshes the calling worker's `lastActivityAt`, optionally records a presence kind on the seat's open execution attempt, and tells a runner when it must reattach.

**Parameters:**
```typescript
{
  workerId: string           // Required: worker to refresh
  presenceKind?: 'process' | 'provider' | 'waiting' | 'progress'
}
```

`presenceKind` is what the sidecar reports about itself: `process` — the CLI subprocess it launched is still there; `provider` — that process is in a call to its model provider; `waiting` — it is parked waiting for input (a human, an approval); `progress` — it observed the execution actually move (output, a tool call). The latest one wins; it is stored on the attempt as `presenceKind` + `presenceAt`. Any other value is rejected as invalid input rather than stored.

**Returns — acknowledgement:**
```typescript
{ ok: true }
```

**Returns — reattach required:**
```typescript
{
  ok: false,
  reattachRequired: true,
  reason: 'no-worker-record' | 'no-open-attempt' | 'attempt-reconciling',
  reattachWith: 'moe.reattach_attempt',
  attemptId?: string,        // present when an attempt exists (the reconciling case)
  phase?: string
}
```

Exactly three conditions produce it:

| `reason` | Condition |
|---|---|
| `no-worker-record` | No worker record for `workerId` — a daemon restart purged the seat and the runner has not re-registered. Returned before any refresh; nothing is created or resurrected. |
| `no-open-attempt` | The worker exists but owns no open attempt (no current task, the attempt is closed, or the task's open attempt belongs to another seat). |
| `attempt-reconciling` | The seat's attempt is parked in `reconciling` by a restart that lost sight of it. **No presence is recorded on this path** — a runner that has not proven which process it is does not get to look present. |

**Notes:**
- Called by the agent-wrapper heartbeat sidecar during long silent local steps (builds, test runs) so a live CLI isn't mistaken for a stale one; not intended to be called by agents directly
- Reattach-required is a **returned value, never an error**, so a sidecar does not log a routine daemon restart as a failure. Recover with `moe.reattach_attempt`
- **What the shipped wrappers do with it** (`scripts/moe-agent.{sh,ps1}`): on `attempt-reconciling` naming the attempt the wrapper pinned at claim time, the sidecar calls `moe.reattach_attempt` with that attempt id, the generation it pinned (this answer carries none) and the runner identity its claim recorded, and logs one `[reattach]` line. `no-worker-record`, `no-open-attempt` and any other attempt id name nothing that process may reattach: logged once per sidecar, nothing sent. A refusal (`ATTEMPT_IDENTITY_MISMATCH` and friends never heal) is logged once and not asked again; no answer at all is retried at the next ping. The main loop covers what the sidecar cannot see: right after its claim and right after the CLI exits it reattaches any `reconciling` attempt this seat owns. None of it can fail the session
- `lastActivityAt` is still refreshed for a live worker even when the response is reattach-required — a long silent build must keep looking alive either way. Still no-ops safely on a `DEAD` record
- An old-style ping that sends no `presenceKind` behaves exactly as before and writes nothing to the attempt, so an un-upgraded wrapper is safe
- Presence is written without touching the attempt's `lastPhaseAt`. The reconcile-window sweep measures its window from that field, so a 60s ping must never be able to extend it — do not reroute this write through the phase setter
- A presence kind is the sidecar's **claim about itself, not verified liveness**; the daemon probes no process, and it still never infers death from silence

## Plugin WebSocket Messages

The JetBrains/VS Code plugin talks to the daemon over `/ws` using typed JSON envelopes (`{ type, payload? }`). The full list lives in `packages/moe-daemon/src/server/WebSocketServer.ts`; the entries below cover this session's additions.

### Plan approval — `expectedPlanRevision` compare-and-swap

**There is no `moe.approve_task` MCP tool, and none is being added.** Plan approval is a human-gated action that reaches the daemon *only* over `/ws`, through the two messages below. `moe.set_task_status` keeps its existing role/policy and is not an approval route.

Both routes accept an **optional** `expectedPlanRevision`: the `planRevision` the approver actually reviewed. The daemon compares it to the task's current revision under the state mutex, **before** it cancels any pending SPEED timer and before it writes anything, so a refused approval leaves the task byte-identical (same status, `updatedAt`, `planApprovedAt` absence, assignment, activity log, pending auto-approval timer) and publishes nothing.

**`APPROVE_TASK` request:**
```typescript
{ type: 'APPROVE_TASK', payload: { taskId: string, expectedPlanRevision?: number } }
```

**`UPDATE_TASK` request** (the AWAITING_APPROVAL → WORKING drag, e.g. a JetBrains board drop into the Working column — it delegates to the same approval path and still ignores the rest of `updates`):
```typescript
{ type: 'UPDATE_TASK', payload: { taskId: string, updates: { status: 'WORKING' }, expectedPlanRevision?: number } }
```

The token is **command metadata beside `taskId`/`updates`, never a task field.** `planRevision` and `expectedPlanRevision` are both on the `UPDATE_TASK` denylist, so a client that puts either inside `updates` has it stripped: a forged stamp can never be persisted, and a token smuggled through `updates` is never read as the token.

**Token rules**

- **Omitting the key** is the only token-free (legacy, unchecked) approval. JSON cannot carry `undefined`, so omission is the wire signal — an explicit `null` is a *malformed* token, not an omission.
- A supplied token must be a **non-negative safe integer**. `null`, strings (`"3"`), booleans, fractional (`3.5`), negative, unsafe (`Number.MAX_SAFE_INTEGER + 1`), `NaN` and `Infinity` are all refused with `INVALID_INPUT` (`-32602`). There is no coercion and no fallback to the legacy path.
- A **legacy task row with no stored `planRevision`** has effective revision `0`, so an explicit `0` matches it and approves.
- Any **non-equal** revision is refused — a *newer* token is as stale-or-forged as an older one.
- Unchanged and still token-free: **SPEED/TURBO auto-approval** and the **`moe.set_task_status` relaxed-mode** approval. They take the legacy path and are unaffected.

**Mismatch `ERROR` frame** (identical for both routes; `operation` echoes the request type):
```json
{
  "type": "ERROR",
  "message": "[PLAN_REVISION_MISMATCH] Plan for task task-abc123 changed since it was reviewed (approved revision 4, current revision 5). Re-open the plan, review the current revision and approve again.",
  "operation": "APPROVE_TASK",
  "code": -32002,
  "codeName": "PLAN_REVISION_MISMATCH",
  "context": { "taskId": "task-abc123", "expectedPlanRevision": 4, "currentPlanRevision": 5 }
}
```

`message`, `operation` and `context.taskId`/`context.epicId` are the pre-existing fields and are unchanged for every message type. `code` and `codeName` are added **only** when the failure is a `MoeError`; a plain error (an illegal status transition, say) still carries neither. **No other exception context is ever forwarded** — `context` is built from the request payload plus an allowlist of exactly `expectedPlanRevision` and `currentPlanRevision` (finite numbers only), so debugging fields such as `field`/`reason`/paths never reach a client.

A malformed token produces the same shape with `code: -32602` and `codeName: "INVALID_INPUT"`, and no revision numbers in `context`.

> **Two detail-key spellings — parse both.** `PLAN_REVISION_MISMATCH` carries `expectedPlanRevision` + `currentPlanRevision`. The *producer's* separate `PLAN_REVISION_EXHAUSTED` error (a required bump refused at `Number.MAX_SAFE_INTEGER`, see [`docs/SCHEMA.md`](SCHEMA.md)) carries `currentRevision` + `maxPlanRevision` — a different spelling for the same idea. It shipped first and downstream parsers already bind to it, so it was deliberately left alone rather than renamed. Only the mismatch pair crosses the `/ws` error-context allowlist; the exhaustion details stay daemon-side.

Clients get the token from the `planRevision` returned by `moe.submit_plan` (see above) or from the task record in `STATE_SNAPSHOT`/`TASK_UPDATED`. Send back the revision that was **rendered and reviewed**, never a newer value re-read from a cache.

End-to-end behaviour across both IDEs — a human reproduction checklist, the recovery paths, and what this deliberately does *not* fence — is in [`docs/PLAN_APPROVAL_FRESHNESS.md`](PLAN_APPROVAL_FRESHNESS.md).

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
