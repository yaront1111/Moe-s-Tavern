---
name: moe-planning
description: Use when an architect is turning a Moe task into an implementation plan via moe.submit_plan. Covers planning the simplest change that meets the Definition of Done, writing short steps that say only what the worker cannot read in the code, the planning checklist (read, explore, tests, implementation, verification, docs, self-review), the plan shape per task type, and where the verification gate belongs — once at the end of a task, and at full scope only on the epic's final task.
when_to_use: After moe.get_context returns a PLANNING task, before drafting implementationPlan.steps for moe.submit_plan.
allowed-tools: Read, Grep, Glob, WebFetch
---

# Moe Planning

Your job: turn the task in front of you into a plan a worker can execute without guessing. A good plan describes the simplest change that meets the Definition of Done, in steps that say what the worker needs and cannot read in the code. It is not judged by its length or by how much it anticipates.

## Size triage — before drafting steps

Count before you draft. If an honest plan needs **more than 8 steps or more than 5 distinct files** (the union of every step's `affectedFiles` and `newFiles`), the *task* is too big — no plan fixes that. Do not pad several actions into one step to duck the cap: the step still executes at its real size, and the daemon counts distinct files regardless. `moe.submit_plan` returns `warnings` past 8 steps / 5 distinct files and hard-rejects past 12 steps / 10 distinct files with `CONSTRAINT_VIOLATION` (thresholds: `project.json` `settings.taskSizing`). Right-sized is ≤60 min human-equivalent, 1–3 files, one deliverable.

Oversized means go back to breakdown, not to a denser plan: create smaller sibling tasks via `moe-epic-breakdown` (SPIDR split) and narrow this task to the first slice — or `moe.report_blocked` with the proposed split if the task isn't yours to split. A project or epic rail that forbids splitting wins over this: plan the work as ONE task within the daemon's `taskSizing` limits instead.

## The simplest plan that works — read this before drafting steps

A longer plan is not a safer one. On Moe's own board (726 plans, October–November 2026) the median plan carried 9,700 characters of step text, and the longest quarter of plans was reopened by QA more often than the shortest (16% against 8%). Harder tasks explain part of that gap, but nothing in it says the extra text bought fewer reopens. The worker reads every character of a plan, and QA reads it again.

**Plan the smallest change.** The design is the least code that meets every DoD item. Load `ponytail` before drafting and take its ladder in order: what the repo already has, then the standard library, then a native platform feature, then a dependency already installed, and only then new code. Plan no abstraction, option, flag, migration, fallback or compatibility layer the DoD does not ask for, and nothing "while we're here". Weigh a second approach only when the simple one fails a DoD item or a rail. The ladder shortens the solution, never the reading, and it never trims a DoD item, a rail or the verification step: those are requested work.

**Write only what the worker cannot get elsewhere.** The worker has the repository, the context packet, the rails and its own skills. A step gives it:

- what changes, and in which file or symbol;
- the decision you already made, in a sentence, where the code allows more than one reading;
- what it cannot see in the code: a string a test pins, a path that belongs to another task, a `mem:<name>` to read;
- the behaviors its tests must cover, by name.

Leave out:

- code the worker would write anyway. Quote text only when the exact characters are the contract: a wire shape, a public signature, a pinned phrase;
- anything a rail, a role doc or a skill already tells the worker (keep functions short, handle errors, never edit `.moe/` by hand);
- the same caution in more than one step. Say it once, in the step it applies to;
- an "Error handling:" or "Tests:" line on a step that has no failure path or behavior of its own;
- your exploration: what you read, what you ruled out, how the code came to be this way.

A step is usually a few hundred characters. This one, for an imaginary billing module, is complete:

> In `src/billing/invoice.ts`, make `totalFor(invoice)` skip lines with `voided: true`; today it sums them. Use `isBillable` from `lines.ts` for the check, not a new one. Tests in `invoice.test.ts`: one voided line among billable ones, and an invoice whose lines are all voided (total 0). `invoiceView.test.ts` pins the string "No billable lines", so keep it.

`moe.submit_plan` returns a warning that names each step past 1500 characters. The plan still stands: write the next one shorter, and do not resubmit this one or split a step to get under the number.

`planningNotes` and `executionContract` are optional, field by field. Fill a field when it carries something the steps and the DoD do not, and leave it out when it would paraphrase them: `intendedBehavior` and `acceptanceCriteria` that restate the description and the DoD, `checkRefs` that repeat the verification step's command, `approachesConsidered` unless the worker would otherwise take the approach you rejected. Worth filling when they apply: `sourceAssumptions` and `reuse`, one line per fact you verified with its path (the daemon watches those paths to tell when an approved plan has gone stale), and `requiredChecks` when the task owes protected checks.

## Where the gate goes — read this before drafting steps

Verification is a real cost. Paying it on every step of every task is how a 12-task epic turns into work that is 80% ceremony. Concentrate it instead:

- **Inside a task: the gate is at the end, not on every step.** A step is *implement the thing + write the tests for the thing it changed*. There is exactly **one** adversarial self-review step, and it is the last one. The regression run happens **once**, before `moe.complete_task`. Never emit a "verify" / "review" / "run the suite" step after each implementation step.
- **Inside an epic: the gate is on the last task, not on every task.** Mid-epic tasks build their slice, prove that slice with focused tests, and hand off. The epic's **final** task, the integration-and-hardening task created at breakdown (`moe-epic-breakdown`), is where the full-system check lives: full suite, cross-package integration, docs sweep, adversarial pass over the whole epic diff.

"Lean" does **not** mean sloppy. A mid-epic task still writes real tests for its own behavior, still handles its errors and still goes through QA. Its tests are scoped to what *it* changed, and its verification command is the targeted suite, not the whole system.

### Verification depth by epic position

| Task position | Tests to plan | Verification step to plan |
|---|---|---|
| Mid-epic (any task that isn't the last) | Focused unit tests for the behavior this task changes | The one package's suite, or the single test file — name it, keep it narrow |
| Epic-final, or a standalone task with no epic siblings | The above, plus integration / end-to-end covering the epic's whole flow | Full regression across every affected package + adversarial review of the epic diff |
| Any position, if the task touches shared types, schema, wire protocol, or migrations | Whatever the change needs | Full regression regardless of position — these break things outside the task's blast radius |

If you can't tell where the task sits, read `moe.get_context` → `task.isEpicFinal`. It is true for the epic's designated final task (`epic.finalTaskId`); an epic with no valid designation falls back to the highest `order` among its non-ARCHIVED tasks. No epic siblings → treat it as epic-final.

## What to think through

Work through these in order. They are your checklist, not a list of steps: most of it is thinking you do, and only the part the worker needs reaches the plan.

1. **Read the task.** `task.description`, `task.definitionOfDone`, the epic and task rails, any `KNOWN_ISSUES.md`. `get_context`'s `nextAction.reason` names the global `requiredPatterns`: `moe.submit_plan` refuses a plan whose step text lacks one (case-insensitive substring), and one mention anywhere in the plan satisfies it. Put it in the step it is about, not in every step.
2. **Explore before you assume.** Don't reference a function, model, method, relationship or constant you haven't grepped for: hallucinated `user.clientProfile.accounts`-style chains are the #1 source of plan-time errors. Load `explore-before-assume`. What reaches the plan is correct paths and names, not an account of the search.
3. **Tests.** For every behavior the change adds or alters, name the case that proves it: one per behavior or boundary, not a matrix, with an assertion that fails when the code does nothing (`assertEquals('completed', r.status)`, not `assert(r)`). Scope them to *this* task; end-to-end tests belong to the epic's final task, where the whole flow exists to be tested. If the breakdown created a sibling **test-authoring task** for this behavior, plan against those held-out tests: name the test files, make the verification step "the tests from task-<id> pass unchanged", and never plan a step that edits them — QA rejects a diff that weakens held-out tests.
4. **Implementation.** One step per logical concern, each with the tests for what it changes. Most tasks need one to three, and only this part of the plan grows with the task.
5. **Verification: one step, after the implementation steps.** Name **one exact command**, sized by the table above: `npx vitest run src/server/McpAdapter.test.ts`, not "run the tests". It IS the worker's completion evidence: `moe.complete_task` requires `verification: { command, exitCode, outputTail }` and rejects without it, and QA re-runs the same command to audit. Add what a pass looks like when that is more than exit code 0, and anything the worker could not guess (a slow suite, a required flag, a test already red that is not this task's). The procedure is in the worker's `verification-before-completion` skill; do not restate it.
6. **Docs.** Comments only where the *why* is non-obvious; a changelog entry if the change is user-visible; `docs/` when a contract changes, in the step that changes it. On a big epic the docs sweep waits for the final task, unless this task alone changes a contract someone else is about to build against.
7. **Self-review: one step, last.** Give the scope (this task's diff, or the whole epic diff on the epic's final task) and the two or three things that could really go wrong with *this* change: a second concurrent run, an empty or huge input, an assumption you could not verify. The general checklist is in `adversarial-self-review`, which the worker loads on its final step; do not copy it in.

The verification and self-review steps are a line or two each. On Moe's own board they had grown to about 30% of a plan's text, most of it restating those skills. Do not write QA's likely objections into the steps either: a plan that covers every DoD item and names a real command already holds up.

Always:

- Set `affectedFiles` tight per step.
- Before `moe.submit_plan`, check your files against the plans of open tasks. For each shared file with no dependency path between the two rows, add the edge with `moe.set_task_dependencies`. In `TURBO` approval a plan is claimable the moment it is submitted, so an edge added afterwards can be too late, and two seats then edit one file at once.
- When a Serena memory bears on a step, name it in that step's description as `mem:<name>` (for example `mem:gotcha-moe-doc-generated-artifacts`), so the worker calls read_memory on exactly that memory instead of scanning list_memories.
- Cite only live names, and never another task's `task-<id>-handoff` or `task-<id>-qa-handoff`: QA retires those to `_archive/` at `moe.qa_approve`, and a dependsOn edge holds this task's claim until then, so the worker's read_memory finds nothing (task-62ec51f1's seat, 2026-11-04). Quote the fact the step needs, or cite a `gotcha-`/`pattern-`/`decision-` memory. Serena hides `_archive/` names, and read_memory refuses them.
- Check that every Definition-of-Done item is covered by a step. That is a check you run, not a table to write into the plan.

## Plan shape by task type

| Task type | Plan |
|-----------|------|
| Doc-only / typo / config tweak | One step: the change and the command that proves it (the linter, a build, a grep). No separate verification or self-review step. |
| Bug fix, narrow scope, has repro | The repro test and the fix in one step, then verification and self-review |
| Mid-epic slice of a larger epic | Implementation with focused tests, a **narrow** verification, self-review of this task's own diff — the epic's final task carries the full-scope gate and the docs sweep |
| New feature, single subsystem (no epic siblings) | Implementation, docs where a contract changes, verification, self-review |
| Epic-final integration / hardening task | Integration tests, the docs sweep, full regression, self-review across the epic diff |
| Cross-cutting refactor / migration | Several implementation steps, full regression, self-review |
| Reopened (`reopenCount > 0`) | A first step that addresses each `rejectionDetails` item, then the shape above that fits |

## Production concerns

Check the change against each of these. Write one into a step only where this change touches it; a concern the change does not touch gets no line.

- Errors: every IO / external call the change adds has a real handling path
- Resource cleanup: file handles, sockets, listeners closed on every exit path
- Cross-platform: paths, scripts, line endings (this repo ships on Win/Mac/Linux)
- Security: no command injection, no path traversal, no secrets in logs
- Performance: no obvious O(n²) on growing lists, no synchronous IO in hot loops
- Backwards-compat or a migration, only when existing data or callers would otherwise break

## When to bail

If the task conflicts with an existing rail, requires missing prerequisites, or is ambiguous in a way only a human can resolve — call `moe.report_blocked` instead of submitting a bad plan.
