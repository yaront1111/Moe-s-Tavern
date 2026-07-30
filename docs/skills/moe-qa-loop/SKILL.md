---
name: moe-qa-loop
description: Use when reviewing a task in REVIEW status as the QA agent. Provides the structured decision flow for moe.qa_approve vs moe.qa_reject, with rejectionDetails that drive a clean fix on the worker side.
when_to_use: QA agent claims a task in REVIEW status; replaces ad-hoc "looks fine to me" reviews.
allowed-tools: Read, Grep, Glob, Bash(git diff:*), Bash(git log:*)
---

# Moe QA Loop

Your job: read the worker's diff and the task's plan, decide if it's done, and either `moe.qa_approve` or `moe.qa_reject` with actionable details.

## The decision flow

For each task in `REVIEW`:

1. **Read `task.implementationPlan` and `task.definitionOfDone`.** Know what was promised.
2. **Audit the verification evidence.** `moe.get_context` returns `task.verification` — the exact command the worker ran at completion, its exit code, and an output tail — plus `filesModified` and recent `rejectionHistory`. Re-run the command yourself. Missing evidence, a non-zero exit, output that contradicts the claim, or a command that isn't the one the plan named → reject, citing the evidence gap.
3. **Read the diff.** `git diff main...HEAD` (or against the task's base). Read it adversarially — see the `adversarial-self-review` skill for the checklist. Count the size: **>400 net changed LOC is itself grounds to reject** (see "Oversized diffs" below).
4. **Verify each Definition-of-Done item.** Map every item to evidence in the diff. Missing evidence is a reject.
5. **Spot-check the tests.** Did the worker add tests for the new behavior? Are they mutation-resistant (`assertEquals('expected', actual)`, not `assert(actual)`)? Are edge cases covered or only the happy path? Any **deleted or weakened test** in the diff (loosened assertion, skipped case, removed file) that the plan didn't call for is a reject on sight.
6. **Run the regression suite if you can.** If the worker's `complete_step` summaries don't include test counts, run the suite yourself — the one the plan named, at the width the plan named (see below).

## Review depth follows the task's position in its epic

Plans deliberately concentrate the heavy verification at the **end of an epic**, not on every task. Review against what *this* task promised, not against the epic's finish line.

- **Mid-epic task** (sibling tasks come after it — check `moe.list_tasks {epicId}` and compare `order`): the bar is "this slice works and is proven by focused tests." Do **not** reject it for lacking end-to-end coverage, full-suite output, or docs the plan assigned to a later task. That work isn't missing; it's scheduled.
- **Epic-final / hardening task, or a task with no epic siblings**: this is the real gate. Full regression evidence, integration coverage of the epic's whole flow, docs, and a clean adversarial pass are all in scope — and their absence *is* a reject.
- **Any task touching shared types, schema, wire protocol, or migrations**: full regression evidence regardless of position.

Still reject at any position for: a DoD item with no code, tests that pass when the code does nothing, scope creep beyond the plan, an unhandled error path, or a `complete_step` claim that doesn't hold when re-run. Lean scope is not lower quality.

## Oversized diffs are a defect

More than **400 net changed LOC** is legitimate grounds for `moe.qa_reject` on its own, whatever the code quality: review defect-discovery collapses past ~400 changed lines, so a diff that size is unreviewable, and unreviewable means unverifiable. Don't line-edit it — reject with `rejectionDetails` telling the architect to split the task (`moe-epic-breakdown` / SPIDR) and land it as reviewable slices. Target diff size is ≤200 net LOC.

## Approve when

- `task.verification` is present, matches the plan's named command, and re-runs green.
- Every DoD item has clear evidence in the diff.
- Tests cover the new behavior (happy path + at least one edge case) at the depth the plan called for.
- No obvious adversarial-review red flags (concurrency, null-deref, missing cleanup).
- The diff scope matches the plan's scope. No drift, no surprise refactors.

Call `moe.qa_approve` with a `summary` naming what you verified — the commands you re-ran and the DoD items you checked. It is required (the daemon rejects approvals without it) and is persisted on the task as the review audit trail.

## Reject when

- `verification` evidence is missing, its exit code isn't 0, or it doesn't reproduce when you re-run the command.
- A DoD item has no corresponding code change.
- Tests are missing or only check the happy path (for *this* task's behavior — see the depth section above before demanding system-wide coverage from a mid-epic task).
- The diff deletes or weakens existing tests without the plan calling for it.
- The diff exceeds ~400 net changed LOC — reject as oversized, route to a split.
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
- **Never approve "with notes."** Either it's done or it's not. If you have notes, reject and let the worker address them.
- **Never re-write the worker's code in your reject message.** Describe the gap, don't fix it for them — they need the practice.

## When you're not sure

If the diff is large or touches an unfamiliar subsystem, before deciding:

- `Read` the files the diff touches.
- `Grep` for callers of any new public function.
- Check `task.reopenCount` — if > 0, look at past `rejectionDetails` to see if the same issue is recurring.

If after that you still can't tell — `moe.add_comment` on the task asking the worker a specific clarifying question. Don't reject for ambiguity; reject for defect.
