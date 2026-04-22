---
name: moe-planning
description: Use when an architect is turning a Moe task into an implementation plan via moe.submit_plan. Provides the canonical 8-phase template (plan, explore, tests, minimum impl, verify, document, adversarial review, QA loop) with rules for when to skip phases on trivial tasks.
when_to_use: After moe.get_context returns a PLANNING task, before drafting implementationPlan.steps for moe.submit_plan.
allowed-tools: Read, Grep, Glob, WebFetch
---

# Moe Planning — 8-Phase Plan Template

Your job: turn the task in front of you into an implementation plan that a worker can execute without guessing. Use the 8 phases below as the **default skeleton** for the steps you submit via `moe.submit_plan`. Skip phases that genuinely don't apply — but skip *consciously*, not by accident.

## The 8 phases

### Phase 1 — Plan before you touch anything
Read `task.context`, `task.acceptanceCriteria`, the linked epic rails, and any `KNOWN_ISSUES.md`. Build a structured todo list before referencing a single line of code. Size the work: how many files? Cross-cutting? Architectural impact? Use the answer to decide which later phases apply.

### Phase 2 — Explore before you assume
Don't reference a function, model, method, relationship, or constant you haven't grepped for. Hallucinated `user.clientProfile.accounts`-style chains are the #1 source of plan-time errors. If the skill `explore-before-assume` is available, invoke it now.

### Phase 3 — Plan tests first
For every behavior change, name the test that proves it. Use mutation-resistant assertions: `assertEquals('completed', $r->status)` not `assert($r)`. Tests that pass when code does nothing are worse than no tests. If the skill `test-driven-development` is available, reference it for the worker.

### Phase 4 — Plan the minimum implementation
Each step does one thing. No clever abstractions. No "while we're here." Scope creep is a bug that looks like progress.

### Phase 5 — Plan the regression check
Name the broader test suite the worker will run before `moe.complete_task`. If unit tests aren't enough (e.g., integration / smoke), say so explicitly.

### Phase 6 — Plan the documentation
Inline comments only where the *why* is non-obvious. Changelog entry if user-visible. Update `docs/` if any contract changes.

### Phase 7 — Plan the adversarial review
Every plan should end with one explicit "self-review" step that runs the checklist:
- What if this runs twice concurrently?
- What if input is null / empty / negative / huge?
- What assumptions am I making that could be wrong?
- Would I be embarrassed if this broke in prod?

### Phase 8 — Plan the QA loop
The worker's job ends at `moe.complete_task`. The QA agent reviews and may call `moe.qa_reject` with `rejectionDetails`. Your plan must hold up under that scrutiny — surface the edge cases and failure modes *in the plan itself* so they don't show up as rejection notes.

## How phases map to plan steps

One step per phase is a fine starting point for non-trivial work. For larger tasks, Phase 4 (minimum implementation) usually expands into multiple steps — one per logical concern. Always:

- Set `affectedFiles` tight per step.
- Map every Definition-of-Done item to at least one step.
- State non-obvious design choices in the step `description` so the worker doesn't re-derive them.

## When to skip phases

Skip aggressively for genuinely trivial work. A typo fix doesn't need 8 steps.

| Task type | Default skeleton |
|-----------|------------------|
| Doc-only / typo / config tweak | Phases 1, 4, 6 |
| Bug fix, narrow scope, has repro | Phases 1, 3, 4, 5, 7 |
| New feature, single subsystem | Phases 1, 2, 3, 4, 5, 6, 7 |
| Cross-cutting refactor / migration | All 8 phases, multiple steps in 4 |
| Reopened (`reopenCount > 0`) | All 8, plus a Phase 0 "address rejectionDetails" step |

## Production concerns to bake in (across all phases)

- Errors: every IO / external call has a real handling path
- Resource cleanup: file handles, sockets, listeners closed on every exit path
- Cross-platform: paths, scripts, line endings (this repo ships on Win/Mac/Linux)
- Security: no command injection, no path traversal, no secrets in logs
- Performance: no obvious O(n²) on growing lists, no synchronous IO in hot loops
- Backwards-compat / migration / feature-flag if risky

## When to bail

If the task conflicts with an existing rail, requires missing prerequisites, or is ambiguous in a way only a human can resolve — call `moe.report_blocked` instead of submitting a bad plan.
