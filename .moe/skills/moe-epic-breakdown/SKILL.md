---
# moe-generated: sha=6bd5a3cd8ed6
name: moe-epic-breakdown
description: Use when an architect is turning an epic into a set of tasks (moe.create_task), before planning any single one. Covers where to cut the seams, how to size and order tasks, what each task's Definition of Done must carry, and the mandatory final integration-and-hardening task. Distinct from moe-planning, which plans the steps inside one task.
when_to_use: Architect facing an epic with no tasks yet, or an epic whose remaining work needs re-slicing. Run this before moe.create_task; run moe-planning later, per task.
allowed-tools: Read, Grep, Glob, WebFetch
---

# Moe Epic Breakdown

Your job: turn one epic into an ordered set of tasks a fleet can execute mostly in parallel, without stepping on each other and without any single task being unreviewable.

This is the layer **above** `moe-planning`. Breakdown decides *what the tasks are*; `moe-planning` decides *what the steps inside one task are*. Don't do both in one pass — you'll produce tasks shaped like steps.

## Before you cut anything

1. Read `epic.description`, `epic.architectureNotes`, and `epicRails`. The rails constrain the seams: a rail like "all auth endpoints under /api/auth/" is telling you where a boundary already exists.
2. `moe.list_tasks {epicId}` — the epic may already be partly sliced. Never duplicate an existing task; extend or re-order instead.
3. Explore the actual code before naming a seam (`explore-before-assume`). A breakdown built on a module that doesn't exist produces N tasks that all get reopened.

## Where to cut

Cut on **seams that already exist in the code**, in this order of preference:

1. **Module / package boundary** — daemon vs proxy vs plugin. Best seam: independent test suites, independent review.
2. **Layer boundary within a module** — schema/state → tool → wire → UI. Natural dependency order falls out for free.
3. **Contract boundary** — one task defines and lands the type/tool/endpoint, later tasks consume it. The producer goes first and its DoD includes the contract being *usable*, not just *declared*.
4. **Vertical slice of behavior** — one complete user-visible capability end to end. Use when the layers are too entangled to cut horizontally; costs parallelism, buys shippability.

Anti-seams — do **not** cut here:

- **By phase of work.** "Write tests" / "write code" / "write docs" as separate tasks is a step list wearing a task costume. Each task owns its own tests.
- **By file.** Files move. A task scoped to a file becomes a merge conflict with a plan attached.
- **By agent convenience.** Splitting so three workers are busy, when the second and third can't start until the first lands, just adds handoff cost.

## Sizing — hard numbers, not vibes

Target: **≤60 minutes of human-equivalent work per task** — aim for ~30 (≈10–30 min of agent runtime). One self-contained deliverable: a function, a test file, a review. One noun per title: one model, one service, one endpoint. The evidence is one-sided — agents are ~90%+ reliable on 30-minute tasks and a coin flip on 5-hour ones, and review defect-discovery collapses past 400 changed LOC (see `docs/roles/architect.reference.md` → "Why small tasks").

| Dimension | Target | Ceiling |
|---|---|---|
| Human-equivalent time | ~30 min | 60 min |
| Files touched | 1–3 | >5 distinct files warns, >10 rejects at `moe.submit_plan` |
| Plan steps | ≤8 | >8 warns, >12 rejects at `moe.submit_plan` |
| DoD items | 3–7, each mechanically checkable | >7 draws a `moe.create_task` warning |
| Net changed LOC | ≤200 | >400 is QA grounds for reject-as-oversized |

The daemon enforces this downstream (thresholds tunable via `project.json` `settings.taskSizing`): `moe.submit_plan` hard-rejects oversized plans with `CONSTRAINT_VIOLATION`. An undersliced epic doesn't save work — it bounces back here for re-slicing after the architect has already burned a planning pass. **Recalibrate your count upward:** an epic that feels like 2–3 tasks is almost always 10–30 small ones. Foundational/contract tasks first, then vertical slices, ending with the integration-and-hardening task.

Secondary split/merge signals:

| Signal | Action |
|---|---|
| DoD needs more than 7 items | Split it |
| Touches 3+ packages | Split on the package seam, unless it's a single mechanical rename |
| The title needs the word "and" | Usually two tasks — `create_task` warns on it; check whether the halves can land independently |
| It can't be described without describing another unfinished task | Merge them, or make the dependency explicit via `order` |
| Under ~30 minutes of real work | Merge it into its neighbour; per-task overhead (claim, plan, review) exceeds the work |

### SPIDR — the split procedure

When any cap above is exceeded, split with **SPIDR**. Try each letter in order; take the first that yields independently-landable pieces:

- **S**pike — carve the unknown into its own research task whose deliverable is a written decision, not code.
- **P**ath — split by workflow path: happy path first, each error/edge path its own task.
- **I**nterface — split by surface: one task per endpoint, CLI flag, tool, UI entry point.
- **D**ata — split by data variation: core shape first; each extra format, migration, or edge dataset later.
- **R**ules — split by business rule: land the permissive version, tighten one rule per follow-up task.

## Ordering and dependencies

`order` is the only dependency signal the runtime has — there is no dependency graph in the schema. So:

- Producers before consumers. If task B imports what task A creates, A gets the lower `order`.
- State the dependency in plain text in B's `description` ("depends on the `SkillMarker` type from task-…"), because nothing enforces it. A worker who claims B early needs to be able to see that.
- Prefer orderings where the first 2–3 tasks are genuinely independent — that's what lets a fleet parallelize at all.
- **File-disjoint tasks are the only ones parallel-claimable.** Overlapping `affectedFiles` across WORKING tasks surface as claim-time `fileCollision` warnings. Cut so concurrent-track tasks touch disjoint files; when two tasks must touch the same file, that's a sequencing decision (`order`), not something to talk workers through.
- Tasks land in `BACKLOG` and are human-gated into `PLANNING`; ordering is advice to the human and to the governor, not a lock.

## What every task must carry

- **`definitionOfDone`**: 3–7 items, every one mechanically checkable — a command to run or a test to pass. DoD items double as the worker's stopping conditions. "moe.list_tasks returns tasks filtered by epicId, proven by the new vitest cases" — not "epic filtering works."
- **Its own tests.** Every task tests its own behavior. This is not deferred to the final task.
- **`taskRails`** only where this task needs a constraint the epic rails don't already impose.
- **A four-element `description`** a worker who has read neither the epic nor the sibling tasks can start from: (1) the objective, (2) the concrete deliverable that exists when it's done, (3) explicit NOT-in-scope boundaries, (4) the exact verification command that proves it done. The worker runs that command fresh and submits its result as `moe.complete_task` verification evidence — a task without a named command stalls at completion.

## Separate test authorship from implementation

Agents that own their tests are observed deleting or weakening them when the tests get in the way; held-out tests remove the incentive (separated authorship scores dramatically better on SWE-bench-style evals with near-zero test-hacking). For behavior-heavy slices, cut the pair:

1. A **test-authoring task** at the lower `order`: deliverable is committed acceptance tests for the behavior — red or `.skip`-marked, mutation-resistant assertions, named files. Its DoD: "tests exist, express the acceptance criteria, and fail (or are skipped) against current code."
2. The **implementation task** right after it: DoD includes "the tests from task-<id> pass **unchanged**" — QA rejects on sight if the diff touches those test files (the moe-qa-loop test-integrity check enforces this).

Skip the pair for trivial slices (config, docs, mechanical renames) — two claim/review cycles cost more than the risk. One test-authoring task can also cover several small sibling implementations when they share a surface.

## End the epic with an integration-and-hardening task

Always create one, at the highest `order`, unless the epic is 1–2 tasks total. It exists because verification is concentrated, not smeared — see `moe-planning`'s "Where the gate goes". Mid-epic tasks prove their own slice with focused tests and move on; this task is where the epic actually gets gated.

Its DoD covers what no individual slice could see:

- Full regression across every package the epic touched, green, with numbers.
- Integration / end-to-end coverage of the epic's whole flow — the first point at which that flow exists to be tested.
- The docs sweep for the epic (held back from the individual tasks so the same file isn't re-edited five times).
- An adversarial pass over the **whole epic diff**, looking for what the slices got wrong about each other: contracts drifted between producer and consumer, duplicated helpers, a migration that works alone but not in sequence, error paths that only fail in combination.
- Any deferred cleanup the mid-epic tasks explicitly parked.

If the epic touched shared types, schema, wire protocol, or migrations, say so in this task's description — those get full regression at *every* position, and this task confirms the whole set still composes.

## When not to break down

- The epic is one coherent change (a single bug, one config surface). Make it one task and go.
- Requirements are ambiguous enough that the seams are guesses — `moe.report_blocked`, or ask the human in the REPL. A wrong breakdown is more expensive than a late one: every task inherits the bad seam.

## Handoff

Create the tasks, then stop. Each one gets planned separately — when it reaches `PLANNING` and you claim it, that's when `moe-planning` runs, with the task's epic position already decided here.