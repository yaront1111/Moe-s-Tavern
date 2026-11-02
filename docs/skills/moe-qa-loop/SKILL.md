---
name: moe-qa-loop
description: Use when reviewing a task in REVIEW status as the QA agent. Provides the structured decision flow for moe.qa_approve vs moe.qa_reject, with rejectionDetails that drive a clean fix on the worker side.
when_to_use: QA agent claims a task in REVIEW status; replaces ad-hoc "looks fine to me" reviews.
allowed-tools: Read, Grep, Glob, Bash(git diff:*), Bash(git log:*), Bash(git show:*), Bash(git branch:*), Bash(git status:*), Bash(git rev-parse:*), Bash(grep:*)
---

# Moe QA Loop

Your job: read the worker's diff and the task's plan, decide if it's done, and either `moe.qa_approve` or `moe.qa_reject` with actionable details.

## Verification constraints take precedence

Read current project/epic/task rails before running commands. All test and re-run defaults below apply only where those rails permit them, including during a bounded commit wait. A build/test freeze also forbids tiny repro scripts and targeted tests unless explicitly exempted.
- When a rail explicitly defers coverage to a batch, audit that coverage hand-forward; do not author/run forbidden per-task tests or reject solely for the authorized deferral. Retain all other DoD checks and report the deferred behavior as unverified.
- If a required check is prohibited rather than explicitly deferred, use `moe.report_blocked` with the restriction and completed evidence; resume REVIEW when resolved. An environmental restriction is not a code defect, and compilation/static review alone cannot replace required runtime evidence. Never treat an unrun check as passing.

## The decision flow

For each task in `REVIEW`:

1. **Read `task.implementationPlan` and `task.definitionOfDone`.** Know what was promised.
2. **Audit the verification evidence.** `moe.get_context` returns `task.verification` — the exact command the worker ran at completion, its exit code, and an output tail — plus `filesModified`, `commits` (the wrapper's recorded landings — sha, ref, kind, pushed), `landing.lastCompletion` and recent `rejectionHistory`. Re-run the command yourself. Missing evidence, a non-zero exit, output that contradicts the claim, or a command that isn't the one the plan named → reject, citing the evidence gap.
**Before the empty-ledger reject, check isolated-clone delivery.** Verify the reported SHA's containment and owned diff against a fresh remote fetch of the intended branch, then repair missing `moe.record_commit` metadata (actual sha/treeId/ref/paths, completion/committed, role, truthful sessionId provenance; pushed=true only with remote evidence). Preserve known original session trailers; disclose a recording-session repair when original provenance is unknown. Never self-land clone-delivered bytes in the shared tree. With no existing delivery, step 3's empty-ledger rule applies. A wrapper's failed branch sync or nothing-to-commit is not proof separately delivered bytes are missing.

3. **Read the diff — the recorded one.** `git show <sha>` for each `task.commits[]` entry of kind `completion` (plus the same session's `checkpoint` entries when the completion is a follow-up), or `git diff <base>..HEAD -- <filesModified>`; `git branch --contains <sha>` confirms it is on the shared branch. Do not review the dirty shared working tree — other sessions' edits live there too. A `task.commits` with no `completion` entry for this round at REVIEW is a bounded wait, not a blocker. Step 2 already re-ran `task.verification` and the tests, and that re-run normally outlasts the wrapper's landing window on its own — so re-poll `moe.get_context` straight after it rather than idling, up to ~2 minutes total. Never sleep-loop, and re-poll and decide before you act. If a completion commit arrives, review that. No self-landing, in either mode (worktree mode: `git rev-parse --symbolic-full-name HEAD` prints exactly `refs/heads/moe/control`; otherwise shared mode): never commit in the control checkout — the agent Git-write guard refuses it with `MOE_AGENT_GIT_REFUSED`, and the wrapper lands the work. With no completion and no isolated delivery after the bounded wait, the landing did not happen: call `moe.qa_reject` citing `task.lastCommitOutcome`, with one `other` issue that starts `Landing gap:` (see "Reject when" and `.moe/roles/qa.reference.md`). A landing-gap reject counts toward the reopen cap like any other, and a re-plan cannot fix a landing gap. Read it adversarially — see the `adversarial-self-review` skill for the checklist. Count the size: **>400 net changed LOC is itself grounds to reject** (see "Oversized diffs" below, including its rail exception).
4. **Verify each Definition-of-Done item.** Map every item to evidence in the diff. Missing evidence is a reject.
5. **Spot-check the tests.** Did the worker add tests for the new behavior? Are they mutation-resistant (`assertEquals('expected', actual)`, not `assert(actual)`)? Are edge cases covered or only the happy path? Any **deleted or weakened test** in the diff (loosened assertion, skipped case, removed file) that the plan didn't call for is a reject on sight.
6. **Run the regression suite if you can.** If the worker's `complete_step` summaries don't include test counts, run the suite yourself — the one the plan named, at the width the plan named (see below).

## Review depth follows the task's position in its epic

Plans deliberately concentrate the heavy verification at the **end of an epic**, not on every task. Review against what *this* task promised, not against the epic's finish line.

- **Mid-epic task** (`moe.get_context` returns `task.isEpicFinal: false`; it follows the epic's designated `finalTaskId`, which a dragged or newly created row does not change, else the highest-`order` fallback): the bar is "this slice works and is proven by focused tests." Do **not** reject it for lacking end-to-end coverage, full-suite output, or docs the plan assigned to a later task. That work isn't missing; it's scheduled.
- **Epic-final / hardening task, or a task with no epic siblings** (`task.isEpicFinal: true`): this is the real gate. Full regression evidence, integration coverage of the epic's whole flow, docs, and a clean adversarial pass are all in scope — and their absence *is* a reject.
- **Any task touching shared types, schema, wire protocol, or migrations**: full regression evidence regardless of position.

Still reject at any position for: a DoD item with no code, tests that pass when the code does nothing, scope creep beyond the plan, an unhandled error path, or a `complete_step` claim that doesn't hold when re-run. Lean scope is not lower quality.

## Oversized diffs are a defect

More than **400 net changed LOC** is legitimate grounds for `moe.qa_reject` on its own, whatever the code quality: review defect-discovery collapses past ~400 changed lines, so a diff that size is unreviewable, and unreviewable means unverifiable. Don't line-edit it — reject with `rejectionDetails` telling the architect to split the task (`moe-epic-breakdown` / SPIDR) and land it as reviewable slices. Target diff size is ≤200 net LOC.

**A rail wins over this section.** When a project or epic rail waives size-based rejection (for example "QA never rejects for size"), never reject or route to a split on size alone. Review the diff on substance at whatever size, name its size in the `qa_approve` summary, and still reject for real defects.

## Approve when

- `task.verification` is present, matches the plan's named command, and re-runs green.
- `task.commits` contains a completion commit recorded for this review round and reachable from the shared branch (with `autoCommit` on; with `autoCommit` off nothing lands automatically: judge `filesModified` on the working tree).
- Every DoD item has clear evidence in the diff.
- Tests cover the new behavior (happy path + at least one edge case) at the depth the plan called for.
- No obvious adversarial-review red flags (concurrency, null-deref, missing cleanup).
- The diff scope matches the plan's scope. No drift, no surprise refactors.

Call `moe.qa_approve` with a `summary` naming what you verified — the commands you re-ran and the DoD items you checked. It is required (the daemon rejects approvals without it) and is persisted on the task as the review audit trail. A `warnings` entry (`NO-COMPLETION-COMMIT`) in the response means you approved without commit evidence — expected only with `autoCommit` off or when you approved inside the post-flight race; otherwise check isolated-delivery metadata first; with neither, reject per step 3 instead of approving. `commitEvidence` in the response is what to cite in your summary.

## Reject when

- `verification` evidence is missing, its exit code isn't 0, or it doesn't reproduce when you re-run the command.
- In either mode: no isolated delivery can be verified and `task.commits` has no `completion` entry for this round after the bounded wait. The landing did not happen. Reject with one issue of type `other` whose description starts `Landing gap:` and cites `task.lastCommitOutcome` (outcome and code; null means nothing was recorded), `task.landingRetry` when present, the rescue entries (`rescueRefsHint`), and the row's still-dirty paths with their remedy (`MOE_CONTESTED_HELD`). Name `failedDodItems` only for items you verified failing, never for the gap alone. Never self-land, and never commit in the control checkout: the reopened row's worker session lands the bytes. Never use a dirty shared-tree observation alone to deny isolated delivery. **A second landing gap is not rejected again:** if `rejectionHistory` (the last 5 entries, with their issues) already holds a `Landing gap:` reject for this row, leave the row in REVIEW with no verdict and no `moe.report_blocked`, and post in #governors the row id, the earlier reject's `rejectedAt`, `task.lastCommitOutcome`, the rescue entries, the still-dirty paths and your verification re-run. Post once per review round (skip it when your escalation for this round is already there and no completion has landed since), then end the session; the governor or a human sets the next status.
- A DoD item has no corresponding code change.
- Tests are missing or only check the happy path (for *this* task's behavior — see the depth section above before demanding system-wide coverage from a mid-epic task).
- The diff deletes or weakens existing tests without the plan calling for it.
- The diff exceeds ~400 net changed LOC — reject as oversized, route to a split (not when a rail waives size-based rejection; see "Oversized diffs").
- The diff does something the plan didn't promise (scope creep / surprise refactor).
- An adversarial-review red flag is present and ignored.
- A claim made in `complete_step` (e.g., "all tests pass") doesn't hold when re-run.

Call `moe.qa_reject` with `rejectionDetails` that are **specific and actionable**:

> ❌ "Tests are weak."
> ✅ "src/auth/login.ts:42 — `validateToken` is tested only with a valid token. Add cases for: expired token, malformed token, missing token, token signed with wrong key."

A good reject:
- Names the file and line.
- Says what's missing or wrong.
- Says what would make it pass — specific enough that the worker doesn't have to guess.

Every reject cites a **failed DoD item, a failing command, or a specific out-of-scope hunk**. Style-only preference is never grounds for rejection.

Bad rejects produce ping-pong. Good rejects produce one round-trip.

## What never to do

- **Never move a rejected task to `BACKLOG`.** That deprioritizes work the worker is mid-flow on. Use `moe.qa_reject` — it routes the task back to `WORKING` for the worker to fix.
- **Never approve with an unmet DoD item or a real defect.** Either it's done or it's not — reject for those. Complexity or taste notes that don't block (see "Second pass: complexity") go in the `qa_approve` summary instead.
- **Never re-write the worker's code in your reject message.** Describe the gap, don't fix it for them — they need the practice.

## Second pass: complexity

Once the verdict is settled on correctness, run `ponytail-review` over the same diff — a complexity-only pass
(`delete:` / `stdlib:` / `native:` / `yagni:` / `shrink:`, one line per finding). Route the findings, don't just list them:

- Breaches a rail or a DoD item → a real `rejectionDetails` entry.
- Leaner but equally correct → the `qa_approve { summary }`, or a follow-up card via `moe.create_task`. Taste is never grounds for a reject (see above), and a needless reopen pushes the task toward the 3-reopen auto-flip back to PLANNING.
- A worker's `ponytail:` comment naming a ceiling and an upgrade path is declared intent. Flag it only if the ceiling is wrong or the corner breaks a DoD item.

## When you're not sure

If the diff is large or touches an unfamiliar subsystem, before deciding:

- `Read` the files the diff touches.
- `Grep` for callers of any new public function.
- Check `task.reopenCount` — if > 0, look at past `rejectionDetails` to see if the same issue is recurring.

If after that you still can't tell — `moe.add_comment` on the task asking the worker a specific clarifying question. Don't reject for ambiguity; reject for defect.
