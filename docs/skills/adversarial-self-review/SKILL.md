---
name: adversarial-self-review
description: Use before calling moe.complete_step on the final step of a task, and again before moe.complete_task. Forces you to read your own diff as an attacker, not an author. Catches concurrency bugs, null-deref, embarrassing assumptions before QA does.
when_to_use: Worker, on the final step of a task, before complete_step or complete_task.
allowed-tools: Read, Grep, Bash(git diff:*), Bash(git log:*)
---

# Adversarial Self-Review

You wrote the code. Now read it like someone who wants to break it.

## The setup

Run `git diff` (or `git diff main...HEAD` if you've committed). Print the diff. Read it top to bottom *not* as the author who knows what was intended, but as a hostile reviewer who assumes nothing.

## The checklist (run all of them, every time)

Before `moe.complete_step` on the final step or `moe.complete_task`, walk every item:

### Concurrency
- What happens if this runs twice concurrently? Same user, same request, same record?
- Is there a check-then-act pattern that needs a lock or a transaction?
- Are you mutating shared state (file, cache, in-memory map) without coordination?
- If a status transition: do you need `SELECT ... FOR UPDATE` or an equivalent?

### Inputs
- What if the input is null? Empty string? Empty array? Empty object?
- What if it's negative? Zero? `Infinity`? `NaN`?
- What if it's enormous (1M items, 1GB string, deeply nested)?
- What if it's malformed (wrong type, missing required fields, extra fields)?
- What if it contains injection-shaped chars (`'`, `;`, `--`, `<script>`, `${`)?

### Assumptions
- What assumptions am I making about the caller? (Auth? Trusted source? Validated upstream?)
- What assumptions am I making about the environment? (OS? Filesystem? Network? Time zone?)
- What if the file/record I'm reading was deleted between the check and the use? (TOCTOU)
- What if a dependency I'm calling fails / times out / returns partial data?

### Side effects on every exit path
- Do file handles / sockets / listeners / subprocesses get closed on the *error* path, not just success?
- Are partial writes / partial state changes possible if we throw mid-way?
- If we retry, do we double-charge / double-send / double-write?

### Embarrassment test
- If this broke in prod tomorrow and ended up in a postmortem, would I be embarrassed by what I shipped?
- If a senior engineer reviewed this PR cold, what would they ding me for?

## What to do with what you find

For each item that triggers concern:

1. **Real risk?** Fix it now, before `complete_step`. A bad fix is better than no fix; an explicit "we'll handle this in follow-up" is better than silence.
2. **Theoretical only?** Note it in the step `summary` field on `complete_step` so QA knows you considered it.
3. **Genuine unknown?** Pause and ask via `moe.add_comment` on the task, or `moe.report_blocked` if it changes the design.

## What this catches that tests don't

Tests verify behavior you thought to write. Adversarial review catches behavior you didn't think to write. Concurrency races, null-deref on optional fields, hard-coded category strings instead of the enum that was just added, missing cleanup on error paths — these almost never have a failing test before review, because the author didn't write one. They show up in postmortems instead.

## When to skip

Doc-only changes, single-line config tweaks, trivial typo fixes. For anything touching logic, IO, or state — run the full checklist. It takes three minutes and prevents the kind of bug that costs three days.
