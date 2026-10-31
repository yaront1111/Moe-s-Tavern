# Plan approval freshness

*Wave 0 · roadmap 2026-09-10 §4 "Fix approval freshness" · parent `task-7265e1fc`, six delivered slices.*

## What changed, and why

Approving a plan used to be a two-word command: "approve this task id". The daemon checked the task's
*status*, never **which plan the human had actually read**. A reviewer could open a plan, an architect could
resubmit or amend it seconds later, and the approve button — still showing the old steps — would approve the
new plan. The JetBrains review dialog made that worse: it built the Definition of Done and the steps once at
open and re-rendered only comments afterwards, so the screen could be stale with no visible sign.

Now every approval carries the revision it reviewed:

| Layer | What it does | Where |
|---|---|---|
| **Stamp** | `task.planRevision` — a daemon-owned monotonic counter over the approval-relevant surface (ordered step ids, instructions, approved file scope, `definitionOfDone` and `executionContract`), bumped inside `taskStore.updateTask`, so every writer is covered: `submit_plan`, `amend_plan_step`, reopen/step resets, `request_replan`, the plugin `UPDATE_TASK` edit | `docs/SCHEMA.md` → `planRevision` |
| **Fence** | A required `expectedPlanRevision` on both approval routes, compared under the state mutex *before* any timer cancellation or write; non-equal is refused with `PLAN_REVISION_MISMATCH` | `docs/MCP_SERVER.md` → "Plan approval — `expectedPlanRevision` compare-and-swap" |
| **Client binding** | Each IDE sends the revision it **rendered**, not the newest one it knows: JetBrains freezes it in `PlanReviewApprovalState`, VS Code seeds it into the review page's `data-plan-revision` and reads it back from the page | `PlanReviewDialog.kt` / `PlanReviewPanel.ts` + `media/planReview.js` |

The three layers are independent on purpose. The stamp alone documents staleness; the fence alone can still be
handed a newer revision by a careless client; the client binding alone can still be overruled by a daemon that
does not compare. Together they make "approved the plan I read" checkable end to end.

## Reproduce it by hand

Both checklists are deterministic — no timing luck required. Use any project with a task in
`AWAITING_APPROVAL`; `<T>` is its task id, `<P>` your project path.

### JetBrains (primary)

1. Open the task's **plan review** dialog. It renders the Definition of Done and steps at revision *N*.
2. From a terminal, change the plan **without touching comments**:
   ```bash
   scripts/moe-call.sh amend_plan_step \
     '{"taskId":"<T>","stepId":"step-1","description":"replacement text","reason":"freshness check","workerId":"architect-manual"}' \
     --project <P>
   ```
   (Editing the Definition of Done from the board is an equally valid trigger; a *comments-only* change is
   deliberately **not** one.)
3. The open dialog latches: **Approve is disabled** and the header shows
   *"Plan changed - close and reopen to review the current plan."* The latch never clears itself — that is
   the point. Nothing was sent to the daemon.
4. Close and reopen the review. It renders revision *N+1*, Approve is live again, and approving succeeds.

To see the daemon side of the same refusal, skip step 3's latch by sending `{"type":"APPROVE_TASK","payload":{"taskId":"<T>","expectedPlanRevision":<N>}}` over `/ws` yourself):
the daemon answers with the `PLAN_REVISION_MISMATCH` `ERROR` frame below and the task stays
`AWAITING_APPROVAL`.

### VS Code (secondary)

1. Open the **Plan Review** panel for `<T>`. The page is served with `data-plan-revision="<N>"` on
   `#reviewRoot`, and its Approve button ships `disabled` — the page is unapprovable until its own script
   runs and validates the seed.
2. Run the same `amend_plan_step` call. The panel's update is debounced (~200 ms) and re-renders the page.
3. A click that was queued at *N* **never silently becomes an approval at *N+1***: the page's `rendered`
   token only moves after a *completed* render, and a render that reports a **different** revision latches
   the button off with a reopen notice instead of upgrading the token.
4. Reopen the review to approve at *N+1*.

## Recovery paths

| Situation | What you see | What to do |
|---|---|---|
| **Stale refusal** from the daemon | `ERROR` frame, `codeName: "PLAN_REVISION_MISMATCH"`, `context.expectedPlanRevision` / `context.currentPlanRevision`; the dialog stays open and usable | Close and reopen the review, read the current plan, approve again |
| **Daemon disconnected** | JetBrains: *"Not connected to the Moe daemon - the approval was not sent."* — nothing was sent, the dialog stays open. VS Code: Approve disables temporarily and re-enables on the next same-revision render | Reconnect; no state changed, retry the approval |
| **Render failed** | JetBrains: *"This plan did not finish rendering, so it cannot be approved."* VS Code: *"The review page could not be refreshed — reopen the review before approving."* | Reopen the review. Both clients fail **closed**: no render, no token, no approval |
| **Comments-only update** | The plan re-renders comments and Approve stays live | Nothing — a comment does not advance the revision, and your token still approves |
| **Task deleted** | JetBrains: *"This task is no longer on the board - close and reopen to review."* | Close the dialog |
| **Status moved off `AWAITING_APPROVAL`** (someone else approved, or it was bounced back to `PLANNING`) | JetBrains: *"This task is no longer awaiting approval - close and reopen to review."*; from the daemon, a plain (non-`MoeError`) refusal naming the current status | Close and reopen; re-review if it came back to you |
| **Unusable revision stamp** (present but malformed) | JetBrains: *"This plan carries an unusable revision stamp and cannot be approved from here."* | Treat as a corrupted record — fix the task JSON; the client deliberately will **not** fall back to approving at `0` |

## Boundaries — what this does *not* fence

Stated plainly so the feature is not read as universal:

- **Omission is refused.** An omitted `expectedPlanRevision` is refused `INVALID_INPUT` (`-32602`) on both `/ws`
  routes before any write (CQ-F04b); an explicit `0` still approves a stamp-less row, and approvals already
  recorded without a stamp stay as history, never upgraded or inferred as checked. The `verified-local` omission
  guard on a `PLAN_APPROVED` write sits behind `EXECUTION_PROFILE_NOT_READY`.
- **Every client entry point sends the rendered revision.** JetBrains: the plan review dialog (also opened by
  `ApproveTaskAction`) and the board, task-detail and board-drop approvals through `BoardApproval`
  (`MoeToolWindowPanel`, `TaskDetailDialog`). VS Code: `PlanReviewPanel`, `TaskDetailPanel` and
  `BoardViewProvider`, from the revision their page rendered (CQ-F04c, CQ-F04d).
- **SPEED / TURBO approve the revision their own submission committed.** TURBO stamps it with the approval. A
  SPEED timer approves only the revision it was armed for, and the approval write re-checks it; if the plan, DoD
  or contract has changed it **withholds** (no task write, one `#general` notice naming both revisions) and the
  row waits for a human approval of the current revision or a resubmission. A daemon restart re-arms the row
  bound to its snapshot's revision, so it never approves a newer one.
- **A human approval cancels a pending SPEED timer only after its own write lands.** A refused or failed approval
  leaves the timer armed. A callback already queued behind the state mutex can approve only the revision it was
  armed for, and the approval write re-checks it.
- **`moe.set_task_status` relaxed-mode approval** keeps its existing role/policy, is token-free and records no
  `approvedPlanRevision` stamp.
- **There is no `moe.approve_task` MCP tool**, and none was added — approval reaches the daemon only over
  `/ws`.

## Consumption under `verified-local`

A stamped approval is consumed, not just recorded: under an effective `verified-local` profile,
`moe.start_step`, `moe.complete_step` and `moe.complete_task` require `Task.approvedPlanRevision` to equal the
current `planRevision` (`PLAN_REVISION_NOT_APPROVED`). An `amend_plan_step`, or a DoD or contract edit, on a
`WORKING` strict task therefore blocks further step entry and completion until a human re-approves the current
revision. Execution progress never changes the revision. A served-context receipt never grants approval, and
`verified-local` itself stays unavailable (`EXECUTION_PROFILE_NOT_READY`); legacy and observe tasks are unchanged.

## Error contract

Both approval routes (`APPROVE_TASK` and the `AWAITING_APPROVAL → WORKING` `UPDATE_TASK` drag) answer a stale
token with the same frame; `operation` echoes the request type:

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

A malformed token (`null`, `"4"`, `4.5`, negative, unsafe, `NaN`) is the same shape with `code: -32602`,
`codeName: "INVALID_INPUT"` and **no** revision numbers in `context`. Full rules in `docs/MCP_SERVER.md`.

> **Two spellings, on purpose.** A client that parses *both* revision errors meets two detail keys for the
> current value: the producer's `PLAN_REVISION_EXHAUSTED` (a bump refused at `Number.MAX_SAFE_INTEGER`) ships
> **`currentRevision`** alongside `maxPlanRevision`, while `PLAN_REVISION_MISMATCH` ships
> **`currentPlanRevision`** alongside `expectedPlanRevision`. The exhaustion key shipped first and downstream
> parsers already bind to it, so renaming either one would be a breaking change for a purely cosmetic gain.
> Parse both; do not assume one spelling. (Only the mismatch pair crosses the `/ws` error-context allowlist —
> `PLAN_REVISION_EXHAUSTED` details are daemon-side.)

## Evidence map

The parent's five Definition-of-Done items and the test that proves each:

| Definition of Done | Proven by |
|---|---|
| `task.planRevision` exists in `docs/SCHEMA.md` and is bumped by `submit_plan` | `packages/moe-daemon/src/tools/submitPlan.test.ts` — the 36-test `planRevision` group; `docs/SCHEMA.md` → `### planRevision` |
| A stale `expectedPlanRevision` returns a structured error and leaves the task `AWAITING_APPROVAL`; omission is refused `INVALID_INPUT` | `packages/moe-daemon/src/server/planApproval.test.ts` (both routes, malformed/forgery/SPEED-timer) |
| JetBrains sends `expectedPlanRevision` and cannot approve a plan it has not rendered | `moe-jetbrains/src/test/kotlin/com/moe/…/PlanApprovalContractTest.kt` (18) + `PlanReviewApprovalStateTest.kt` (32) |
| The VS Code approve command sends `expectedPlanRevision` | `moe-vscode/tests/plan-approval-client.test.cjs` (28) + `moe-vscode/tests/plan-review.test.cjs` (33) |
| `./gradlew test` and daemon `npm test` green | The full-feature gate recorded on the parent task's `verification` |
| SPEED/TURBO stamp and withhold the revision their submission committed | `packages/moe-daemon/src/tools/automaticApprovalRevision.test.ts` |
| Strict step entry consumes the approval and a served-context receipt | `packages/moe-daemon/src/tools/startStepAuthorization.test.ts` |
| Strict step and task completion need the approval, a receipt and current-attempt evidence | `packages/moe-daemon/src/tools/completionAuthorization.test.ts` |

Cases no single slice could own — two live sockets, all three revision writers, the one-bump rule end to end,
durability across a daemon restart, and a legacy stamp-less row invalidated by a wire edit — live in
`packages/moe-daemon/src/server/planApproval.integration.test.ts` (15 tests).
