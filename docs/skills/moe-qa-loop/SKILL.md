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

1. **Read `task.implementationPlan` and `task.acceptanceCriteria`.** Know what was promised.
2. **Read the diff.** `git diff main...HEAD` (or against the task's base). Read it adversarially — see the `adversarial-self-review` skill for the checklist.
3. **Verify each Definition-of-Done item.** Map every item to evidence in the diff. Missing evidence is a reject.
4. **Spot-check the tests.** Did the worker add tests for the new behavior? Are they mutation-resistant (`assertEquals('expected', actual)`, not `assert(actual)`)? Are edge cases covered or only the happy path?
5. **Run the regression suite if you can.** If the worker's `complete_step` summaries don't include test counts, run the suite yourself.

## Approve when

- Every DoD item has clear evidence in the diff.
- Tests cover the new behavior (happy path + at least one edge case).
- No obvious adversarial-review red flags (concurrency, null-deref, missing cleanup).
- The diff scope matches the plan's scope. No drift, no surprise refactors.

Call `moe.qa_approve` with a one-line `summary` noting what you verified.

## Reject when

- A DoD item has no corresponding code change.
- Tests are missing or only check the happy path.
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
