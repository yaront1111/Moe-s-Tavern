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

Three tools are deliberately **guard-exempt** even though the proxy injects `workerId` into them: `moe.get_commit_scope`, `moe.record_commit` and `moe.declare_files`. The wrapper calls the first two **after** the CLI exits — by then QA may already own the REVIEW task, a seat-only `unblock_worker` may have left it unassigned, or the task may be `BLOCKED`/`DONE` — and a governor uses `declare_files` on tasks it never owns. They are allowed in every task status.

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
    planSizeWarnings?: string[],        // present when the latest submit_plan drew warn-zone size warnings
    verification: { command, exitCode, outputTail?, reportedAt } | null, // complete_task evidence — QA re-runs the command
    filesModified: string[],            // ASSERTED paths: completed steps' modifiedFiles ?? affectedFiles (complete_task) ∪ non-inferred paths landed via record_commit
    declaredPaths?: string[],           // the full ASSERTED tier (completed steps' modifiedFiles ?? affectedFiles ∪ filesModified ∪ declaredFiles ∪ touchedFiles ∪ non-inferred committed paths) — what the wrapper commits regardless of baseline; NOT just the moe.declare_files list
    inferredPaths?: string[],           // MEASURED-tier paths the wrapper landed; never promoted to asserted
    unattributedPaths?: string[],       // changed paths the last landing could not attribute (reported, never staged) — claim them with moe.declare_files
    commits?: Array<{ sha, treeId?, ref, kind: "completion" | "checkpoint" | "rescue", status?, pushed?, recordedAt, recordedBy, pathCount, inferredCount }>, // bounded projection of task.commits (moe.record_commit)
    lastCommitOutcome?: { outcome: "committed" | "nothing" | "refused" | "failed", kind, code?, sessionId, at },
    landing?: { lastCompletion?: { sha, ref, pushed, recordedAt }, lastCheckpoint?: { sha, recordedAt } },
    rescueRefsHint?: string,            // present when any commit is kind "rescue": how to recover from refs/moe/rescue/<taskId>/*
    epicSiblings?: Array<{ id, title, order, status, landing?: { lastCompletion? }, landed: boolean }>, // same epic, lower order, ≤20; landed = a pushed completion commit or status REVIEW/DONE
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
  planningNotes?: { approachesConsidered?, codebaseInsights?, risks?, keyFiles? },
  budget?: { wallClockMs?: number }  // soft cap on first-claim → DONE
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
- `budget.wallClockMs` (when supplied) must be `> 0`; prior `warnedAt`/`escalatedAt` marks are preserved on resubmits. Plan submission refreshes `metrics.plannedStepCount`.
- **CONTROL mode side effect:** the daemon posts `📋 Plan ready for critique — <title> (<id>)` to `#governors` with the step count, distinct-file count, any size warnings, a size rubric line, and a DoD preview. If at least one registered governor exists, `task.pendingPlanCritique` is set to record who is expected to weigh in. Critique is informational; humans still own approval.
- **Warn-zone persistence + unsupervised size critique:** warn-zone warnings are persisted as `task.planSizeWarnings` (cleared by a compliant resubmit). With `settings.taskSizing.autoCritique: true`, CONTROL mode, and NO governor online, the daemon auto-blocks a warn-zone plan back to `PLANNING` (verdict recorded as `planCritiqueResult` by `moe-daemon-size-critic`, bounded by the same `critiqueBlockCount` cap as governor blocks; at the cap the task rests in `AWAITING_APPROVAL` with a `🛑 HUMAN DECISION REQUIRED` post). The response's `status` is then `"PLANNING"` and `nextAction` routes to a re-plan via `moe-epic-breakdown`.

**Returns:**
```typescript
{ success: true, taskId, status: "AWAITING_APPROVAL", stepCount, distinctFileCount, newFileCount, budget, warnings?: string[], message, nextAction }
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
- **Role gate:** the caller's team role must be `architect` or `governor`, else `NOT_ALLOWED`. A missing or unknown `workerId` has no team and therefore fails closed — a worker cannot rewrite its own instructions.
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
  summary?: string,
  currentBranch?: string,  // branch the worker is on; enables the consolidationBranch check
  workerId?: string
}
```

**Notes:**
- Missing/malformed `verification` → `MISSING_REQUIRED`/`INVALID_INPUT`; `exitCode !== 0` → `INVALID_INPUT` telling the worker to fix and re-run before completing.
- The evidence is persisted as `task.verification` (with `reportedAt`), and the union of completed steps' `modifiedFiles ?? affectedFiles` seeds `task.filesModified` — the ASSERTED attribution tier the wrapper commits regardless of its baseline; `moe.record_commit` later unions the non-inferred paths it actually landed. Both are surfaced to QA via `moe.get_context`, whose QA guidance is to re-run the command. The daemon never executes the command itself and never runs git.
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
  peerDeclared: { path: string, taskId: string }[],   // the same union over every OTHER task with status ∉ {DONE, ARCHIVED}
  livePeerIds: string[],      // workers ≠ caller, not DEAD, lastActivityAt inside the window (or registered since `since`)
  activePeerIds: string[],
  peersActive: boolean,
  alwaysInclude: string[],    // BOARD: .moe/tasks/<taskId>.json (always) + .moe/epics/*.json, .moe/project.json, non-live-peer task records (when commitBoardState)
  excludePrefixes: string[],  // settings.attribution.exclude ONLY, normalized (project-relative, trailing slash stripped). The built-in DENY list (.moe/** except BOARD, .mcp.json, .codex/**, .gemini/**, .claude/agents/**, .claude/settings.local.json, untracked .serena/**, .worktrees/**, .moe-worktree*) is hard-coded wrapper-side and never travels here.
  policy: {
    autoCommit, checkpointCommits, checkpointPush, commitBoardState, commitHooks,
    undeclared: "solo" | "never" | "always",
    contested: "commit" | "skip"
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

Report a task as blocked: flips the task to `BLOCKED` (the wrapper stops relaunching sessions against the wall) and pages whoever can actually unblock it. With `resourceId`, first tries to acquire the shared resource — a free resource grants the lease and does **not** block.

**Parameters:**
```typescript
{ taskId: string, reason: string, needsFrom?: string, currentStepId?: string, workerId?: string, resourceId?: string }
```

**Notes:**
- **Task flip:** a task in an agent-claimable column (`PLANNING`/`WORKING`/`REVIEW`) flips to `BLOCKED`, recording `blockedReason`, `blockedResourceId` (when given), `blockedFromStatus` (the pre-block status to restore) and `blockedAt`. This is what stops wrapper churn: `claim_next_task` keeps answering `alreadyAssigned { status: "BLOCKED" }`, which the wrapper reads as "do not relaunch a CLI onto this". Tasks in other statuses keep their status (the worker is still marked `BLOCKED`).
- Updates the assigned worker status to `BLOCKED`.
- **Resource path** (`resourceId` set): the daemon runs the `moe.acquire_resource` grant-or-enqueue FIRST — even for an **unassigned** task (operator/plugin flow; the queue entry's `workerId` falls back to the caller, then the assignee, then `"human"`), because without a queue entry the grant path could never auto-unblock the task. Capacity free → the lease is granted, the task is **not** blocked, and the call returns `{ granted: true, lease }` — proceed, then `moe.release_resource`. Busy → the task blocks as above with `blockedResourceId` set, and the grant path auto-unblocks it (status → `blockedFromStatus`) the moment the lease is granted. `resourceId` must match the resource-id shape (see `## Shared Resources`).
- Only the assigned worker may report a task blocked (`workerId` is auto-injected by the proxy); a `reason` is required and capped at 2000 chars.
- **Ping routing:** the daemon direct-mentions the **architect with the freshest `lastActivityAt` inside the 120s liveness window** (`isWorkerAlive` — so a `DEAD`/deregistered architect is never picked), resolving the role through `worker.teamId`. The blocked worker itself is excluded, so an architect blocked on its own PLANNING task cannot page itself into a dead end. Ties on `lastActivityAt` break to the lowest worker id, so routing is deterministic.
- With **no live architect**, the ping escalates to `@governors` instead.
- Channels: the task/general system copy stays unmentioned (it lands in `#general`, which already receives the mentioned copy — prefixing both would page the same person twice); `#general` gets the mentioned copy; `#architects` additionally gets it when an architect was found; `#governors` always receives the message — unmentioned when an architect was paged (visibility without being paged), mentioned when it *is* the escalation. Every post is best-effort: a chat failure never fails `report_blocked` or skips the `BLOCKED` update.
- `nextAction` is emitted only when the task has an assigned worker **and no `resourceId`**. A resource block deliberately gets **no `nextAction`**: the wrapper idles (`BLOCKED` suppresses relaunch) and the grant path auto-unblocks the task, so ending the session IS the correct next step — there is nothing to wait on in-session.
- **Every plan step already `COMPLETED`, no `resourceId`, and the task blocked out of `WORKING`**: the block still happens, but the response carries `warning: 'ALL_STEPS_COMPLETE: BLOCKED is a wait state, not a terminal — if the work is delivered call moe.complete_task with verification'` and `nextAction` pointing at `moe.complete_task`. REVIEW/PLANNING-origin blocks never warn — `complete_task` is only legal from `WORKING` (a REVIEW-origin block always has all steps completed). Delivered work goes through `complete_task`; `BLOCKED` is never a finish line.
- Un-block routes: the resource grant path (auto), `moe.unblock_worker { resolveBlocks: true }`, or a human `set_task_status`. A bare `moe.unblock_worker` is **seat-only** — the worker goes `IDLE` but the task stays `BLOCKED` with its `blockedReason`. Ordinary releases (daemon restart purge, deregister, `release_task`) keep a `BLOCKED` task `BLOCKED` — the blocker is still there. The wrapper lands a checkpoint commit of the task's files on the BLOCKED exit, so a block never strands bytes.

**Returns:**
```typescript
// Resource path, capacity was free — lease granted, task NOT blocked:
{ success: true, taskId, taskStatus: TaskStatus /* unchanged */, granted: true, lease: ResourceLease, message }

// Blocked:
{
  success: true,
  taskId: string,
  taskStatus: "BLOCKED" | TaskStatus, // "BLOCKED" when flipped; unchanged for non-flippable statuses
  resourceId?: string,                // echoed when resourceId was passed …
  granted?: false,                    // … along with the failed-grant marker
  workerStatus: "BLOCKED",
  notified: {
    target: string,                   // architect worker id, or "@governors"
    via: "freshest-live-architect" | "governors-fallback"
  },
  message: string,                    // names who was pinged
  warning?: string,                   // "ALL_STEPS_COMPLETE: …" when every step is COMPLETED, no resourceId, and the block originated from WORKING
  nextAction?: { tool: "moe.wait_for_task" | "moe.complete_task", ... }   // wait_for_task only when assigned AND not a resource block; complete_task alongside the ALL_STEPS_COMPLETE warning
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
  preferAdjacentInEpic?: boolean   // default: true — rank candidates in the worker's last epic ahead of others
}
```

When `taskId` is provided the priority/order ranking is bypassed — you get the named task or an error. The task must be in one of the requested `statuses`; if it's already assigned to someone else, pass `replaceExisting: true` to take over. Re-claiming a task already assigned to YOU is always allowed (resume path) and needs no `replaceExisting`.

**One task per worker:** a worker already holding an active task (PLANNING/WORKING/REVIEW/BLOCKED) cannot claim another — the call returns `{ hasNext: false, alreadyAssigned: { taskId, title, status } }` with a `nextAction` pointing back at the held task (`get_context`). Finish it (`submit_plan` / `complete_task` / `qa_approve` / `qa_reject`) or `release_task` it first. This also applies to explicit `taskId` claims of a different task.

**BLOCKED hold:** when the held task is `BLOCKED`, `alreadyAssigned` additionally carries `blockedReason` and `blockedResourceId` (each present only when set on the task), and `nextAction` points at `moe.list_resources` instead of `get_context`. A BLOCKED hold is not resumable work — the wrapper reads this status and suppresses the CLI relaunch entirely; a live session should end rather than spin. A set `blockedResourceId` means the daemon auto-unblocks the task the moment its lease is granted (see `## Shared Resources`); no `resourceId` means the block needs a human (`moe.unblock_worker { resolveBlocks: true }` / `set_task_status` — a bare `unblock_worker` only frees the seat). Before idling on a BLOCKED hold the wrapper lands any lingering baseline for the held task as a recovery checkpoint (`MOE_CHECKPOINT_RECOVERED`), so a blocked task's files reach the branch with no CLI launched.

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
    blockedResourceId?: string      // BLOCKED holds only; set = auto-unblocks on lease grant
  },
  nextAction: {
    tool: 'moe.get_context' | 'moe.get_handoff_history' | 'moe.wait_for_task' | 'moe.enter_governance' | 'moe.list_resources',
    args: object,
    reason: string,
    recommendedSkill?: { name: string, reason: string }
  }
}
```

**Notes:**
- On first claim the daemon stamps `task.metrics.firstClaimAt` (idempotent).
- After the claim, the daemon re-evaluates `task.budget` (warn at 80%, escalate at 100% to `#governors`).
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
(`blockedReason`/`blockedResourceId`/`blockedFromStatus`/`blockedAt`) so a
later resource grant or sweep cannot act on stale block state. Activity
events: `TASK_BLOCKED` on entry, `TASK_UNBLOCKED` on exit.

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

### moe.archive_task

Archive a single ticket so it drops out of agent context — `list_tasks` and
`search_tasks` hide `ARCHIVED` by default. Allowed from `BACKLOG`, `REVIEW`, or
`DONE`; rejected for in-flight tasks (move to `BACKLOG` or release first).
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
(`PLANNING`/`AWAITING_APPROVAL`/`WORKING`). Idempotent.

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
{ success: true, task, warnings?: string[] }
```

`warnings` carries advisory task-shape feedback: empty `definitionOfDone` (a placeholder was substituted — give every task 3-7 mechanically checkable items), more than 7 DoD items (usually several tasks — split before planning), or a title containing "and" (often two tasks). Advisory only; the hard size gate lives in `moe.submit_plan`.

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

Clear `BLOCKED` status on a worker, setting it back to `IDLE`. **Seat-only by default**: the worker's seat is freed, but a `BLOCKED` task it holds stays `BLOCKED` with `blockedReason`/`blockedResourceId`/`blockedFromStatus`/`blockedAt` intact — freeing a seat is not an assertion that the blocker is gone. Pass `resolveBlocks: true` to also restore the task; that is the human "blocker resolved" lever.

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

Release a task from its assigned worker (clears `assignedWorkerId` and keeps the task claimable in place via `nextStatusForRelease`: WORKING stays WORKING-unassigned so the next worker resumes it via `priorHandoffs`, or →REVIEW if every step is already done; PLANNING/REVIEW/AWAITING_APPROVAL stay put; BLOCKED stays BLOCKED — the blocker is still there, only `moe.unblock_worker { resolveBlocks: true }`, the resource grant path, or `set_task_status` clears it). Anyone can call — no ownership check — but **staleness in `list_workers` is NOT evidence of shutdown**: a quiet worker may be mid-build with its CLI blocked on a long local step. Never release a WORKING/PLANNING task on idle time alone; release only on a confirmed crash (deregister banner, wrapper exit, human confirmation) or an explicit handoff. To pull a task OUT of the agent pool for human triage instead, use `set_task_status` → BACKLOG (the blocked-timeout sweep does this automatically — it *parks* in-flight tasks, PLANNING/WORKING/REVIEW → BACKLOG, so the next agent doesn't claim straight into the same blocker). `release_task` itself parks in exactly one case: the third empty-progress release inside 24h — see **Refusal cascade** below.

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

Mark a worker `DEAD`, release every task it holds (routed via `nextStatusForRelease`: WORKING stays WORKING-unassigned, or →REVIEW if all steps are done; PLANNING/REVIEW/AWAITING_APPROVAL stay put; BLOCKED stays BLOCKED), and post chat-leave messages. Called by the agent wrapper's exit trap on terminal close (`trap … EXIT` in `moe-agent.sh`, top-level `finally` in `moe-agent.ps1`). There is no idle-based auto-release: a hard-crashed worker's task stays assigned until daemon restart, this tool, or `release_task`. **Idempotent** — repeat calls on an already-`DEAD` worker are no-ops.

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
  alreadyDead: boolean,       // true if the worker was already DEAD with no task (no-op)
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

QA approves a task in REVIEW status, moving it to DONE. Requires a `summary` of what was verified — symmetric with `qa_reject`'s required `reason`, so DONE tasks carry an audit trail instead of a rubber stamp. It is also a **soft commit gate**: it warns (never rejects) when no completion commit has been recorded for this review round, and returns the task's commit evidence so QA can cite the sha it actually reviewed.

**Parameters:**
```typescript
{
  taskId: string,
  summary: string,     // REQUIRED — what was verified: commands re-run, DoD items checked (max 2000 chars)
  workerId?: string
}
```

The summary is persisted on the task as `reviewSummary`.

**Returns:**
```typescript
{
  success: true, taskId, status: "DONE", summary, message,
  warning?: string,      // the NO-COMPLETION-COMMIT line, when it fired
  warnings: string[],    // ALWAYS present ([] when clean): "NO-COMPLETION-COMMIT: task <id> has no completion commit recorded yet (the wrapper lands it seconds after REVIEW) — verify task.commits / git log before merging"
  commitEvidence: {      // task.commits split by kind — a 4-FIELD PROJECTION per entry: { sha, ref, pushed: boolean|null, recordedAt }. Full TaskCommit entries (paths, recordedBy, status…) live in task.commits / get_context.
    completion: Array<{ sha, ref, pushed: boolean | null, recordedAt }>,   // only entries recorded at/after task.reviewStartedAt count against the warning
    checkpoint: Array<{ sha, ref, pushed: boolean | null, recordedAt }>,
    rescue: Array<{ sha, ref, pushed: boolean | null, recordedAt }>
  }
}
```

**Notes:**
- **When the warning fires**: `settings.autoCommit !== false` and no `task.commits` entry has `kind: "completion"` recorded at or after `task.reviewStartedAt` (a completion commit from an earlier review round does not count). The same line is posted to `#governors` (best-effort, after the DONE write). With `autoCommit: false` there is no warning — the project opted out of wrapper commits.
- **Race**: the wrapper lands the completion commit and calls `moe.record_commit` *after* the worker's CLI exits, while QA's `wait_for_task` wakes on the REVIEW write itself, so an approval within seconds of REVIEW can legitimately see no commit yet. Wait for the `[OK] Committed completion …` banner / the task-channel record line, then `git show <sha>` — do not review the dirty shared tree.
- **Approval always lands** — the gate is advisory. Reopening (`qa_reject`, `set_task_status`) never clears `task.commits`.
- QA policy: treat the warning as a reject unless you verified HEAD yourself (`docs/roles/qa.md`).

**Errors:**
- `taskId is required`
- `summary` missing/empty → `MISSING_REQUIRED` (checked after ownership/context guards)
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

Liveness ping: refreshes the calling worker's `lastActivityAt` with no other side effects.

**Parameters:**
```typescript
{
  workerId: string      // Required: worker to refresh
}
```

**Returns:**
```typescript
{ ok: true }
```

**Notes:**
- Called by the agent-wrapper heartbeat sidecar during long silent local steps (builds, test runs) so a live CLI isn't mistaken for a stale one; not intended to be called by agents directly
- No-ops safely on a missing or `DEAD` worker record

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
