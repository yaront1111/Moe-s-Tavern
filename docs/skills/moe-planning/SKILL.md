---
name: moe-planning
description: Use when an architect is turning a Moe task into an implementation plan via moe.submit_plan. Provides the canonical 8-phase template (plan, explore, tests, minimum impl, verify, document, adversarial review, QA loop), rules for when to skip phases on trivial tasks, and where the verification gate belongs — once at the end of a task, and at full scope only on the epic's final task.
when_to_use: After moe.get_context returns a PLANNING task, before drafting implementationPlan.steps for moe.submit_plan.
allowed-tools: Read, Grep, Glob, WebFetch
---

# Moe Planning — 8-Phase Plan Template

Your job: turn the task in front of you into an implementation plan that a worker can execute without guessing. Use the 8 phases below as the **default skeleton** for the steps you submit via `moe.submit_plan`. Skip phases that genuinely don't apply — but skip *consciously*, not by accident.

## Where the gate goes — read this before drafting steps

Verification is a real cost. Paying it on every step of every task is how a 12-task epic turns into work that is 80% ceremony. Concentrate it instead:

- **Inside a task: the gate is at the end, not on every step.** A step is *implement the thing + write the tests for the thing it changed*. There is exactly **one** adversarial self-review step, and it is the last one. The regression run happens **once**, before `moe.complete_task`. Never emit a "verify" / "review" / "run the suite" step after each implementation step.
- **Inside an epic: the gate is on the last task, not on every task.** Mid-epic tasks build their slice, prove that slice with focused tests, and hand off. The epic's **final** task is where the full-system check lives: full suite, cross-package integration, docs sweep, adversarial pass over the whole epic diff.

So when you decompose a big epic, **end it with an explicit integration-and-hardening task** (`moe.create_task` with the highest `order`). That task owns the epic's end-to-end verification, its documentation, and its "would I be embarrassed if this shipped" pass. Everything before it stays lean and moves. Decomposing an epic is its own pass with its own skill — `moe-epic-breakdown`; this skill starts once the tasks exist and you're planning one of them.

"Lean" does **not** mean sloppy. Mid-epic tasks still write real tests for their own behavior, still handle errors, still get reviewed by QA. Lean means their tests are scoped to what *they* changed and their verification command is the targeted suite, not the whole system.

### Verification depth by epic position

| Task position | Tests to plan | Verification step to plan |
|---|---|---|
| Mid-epic (any task that isn't the last) | Focused unit tests for the behavior this task changes | The one package's suite, or the single test file — name it, keep it narrow |
| Epic-final, or a standalone task with no epic siblings | The above, plus integration / end-to-end covering the epic's whole flow | Full regression across every affected package + adversarial review of the epic diff |
| Any position, if the task touches shared types, schema, wire protocol, or migrations | Whatever the change needs | Full regression regardless of position — these break things outside the task's blast radius |

If you can't tell where the task sits, `moe.list_tasks {epicId}` and compare `order` against the siblings. No epic siblings → treat it as epic-final.

## The 8 phases

### Phase 1 — Plan before you touch anything
Read `task.context`, `task.acceptanceCriteria`, the linked epic rails, and any `KNOWN_ISSUES.md`. Build a structured todo list before referencing a single line of code. Size the work: how many files? Cross-cutting? Architectural impact? Use the answer to decide which later phases apply.

### Phase 2 — Explore before you assume
Don't reference a function, model, method, relationship, or constant you haven't grepped for. Hallucinated `user.clientProfile.accounts`-style chains are the #1 source of plan-time errors. If the skill `explore-before-assume` is available, invoke it now.

### Phase 3 — Plan tests first
For every behavior change, name the test that proves it. Use mutation-resistant assertions: `assertEquals('completed', $r->status)` not `assert($r)`. Tests that pass when code does nothing are worse than no tests. If the skill `test-driven-development` is available, reference it for the worker.

Scope the tests to *this* task's behavior. Don't plan end-to-end or full-system tests on a mid-epic task — those belong to the epic's final task, where the whole flow actually exists to be tested.

### Phase 4 — Plan the minimum implementation
Each step does one thing. No clever abstractions. No "while we're here." Scope creep is a bug that looks like progress.

### Phase 5 — Plan the regression check, sized to position
Name the suite the worker runs **once**, before `moe.complete_task` — and size it per the table above. Mid-epic: the narrow suite covering this task's slice. Epic-final, standalone, or shared-surface change: the broader suite, named explicitly (which packages, which command). One verification step per task, never one per implementation step.

### Phase 6 — Plan the documentation
Inline comments only where the *why* is non-obvious. Changelog entry if user-visible. Update `docs/` if any contract changes. On a big epic, hold the docs sweep for the final task rather than re-editing the same doc from every task in the epic — unless this task alone changes a contract someone else is about to build against.

### Phase 7 — Plan the adversarial review — one, at the end
Every plan ends with **exactly one** explicit "self-review" step, and it is the final step of the task. Not one per implementation step. On a mid-epic task it is scoped to this task's own diff; on the epic's final task it sweeps the whole epic diff. The checklist:
- What if this runs twice concurrently?
- What if input is null / empty / negative / huge?
- What assumptions am I making that could be wrong?
- Would I be embarrassed if this broke in prod?

### Phase 8 — Plan the QA loop
The worker's job ends at `moe.complete_task`. The QA agent reviews and may call `moe.qa_reject` with `rejectionDetails`. Your plan must hold up under that scrutiny — surface the edge cases and failure modes *in the plan itself* so they don't show up as rejection notes.

## How phases map to plan steps

One step per phase is a fine starting point for non-trivial work. For larger tasks, Phase 4 (minimum implementation) usually expands into multiple steps — one per logical concern. **Only Phase 4 expands.** Phases 5 and 7 are one step each, at the end, no matter how many implementation steps precede them. Always:

- Set `affectedFiles` tight per step.
- Map every Definition-of-Done item to at least one step.
- State non-obvious design choices in the step `description` so the worker doesn't re-derive them.

## When to skip phases

Skip aggressively for genuinely trivial work. A typo fix doesn't need 8 steps.

| Task type | Default skeleton |
|-----------|------------------|
| Doc-only / typo / config tweak | Phases 1, 4, 6 |
| Bug fix, narrow scope, has repro | Phases 1, 3, 4, 5, 7 |
| Mid-epic slice of a larger epic | Phases 1, 2, 3, 4, plus a **narrow** 5 — the epic's final task carries full-scope 5, 6, and 7 |
| New feature, single subsystem (no epic siblings) | Phases 1, 2, 3, 4, 5, 6, 7 |
| Epic-final integration / hardening task | All 8, with 5 and 7 at full-system scope across the epic diff |
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
