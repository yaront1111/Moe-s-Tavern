---
# moe-generated: sha=d8741ba0b7be
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

## Sizing

Target: a task a competent worker finishes in **one session**, producing a diff a reviewer can hold in their head.

| Signal | Action |
|---|---|
| DoD has more than ~6 items | Split it |
| Touches 3+ packages | Split on the package seam, unless it's a single mechanical rename |
| The title needs the word "and" | Usually two tasks — check whether the halves can land independently |
| It can't be described without describing another unfinished task | Merge them, or make the dependency explicit via `order` |
| Under ~30 minutes of real work | Merge it into its neighbour; per-task overhead (claim, plan, review) exceeds the work |

## Ordering and dependencies

`order` is the only dependency signal the runtime has — there is no dependency graph in the schema. So:

- Producers before consumers. If task B imports what task A creates, A gets the lower `order`.
- State the dependency in plain text in B's `description` ("depends on the `SkillMarker` type from task-…"), because nothing enforces it. A worker who claims B early needs to be able to see that.
- Prefer orderings where the first 2–3 tasks are genuinely independent — that's what lets a fleet parallelize at all.
- Tasks land in `BACKLOG` and are human-gated into `PLANNING`; ordering is advice to the human and to the governor, not a lock.

## What every task must carry

- **`definitionOfDone`**: verifiable claims, not intentions. "moe.list_tasks returns tasks filtered by epicId" — not "epic filtering works."
- **Its own tests.** Every task tests its own behavior. This is not deferred to the final task.
- **`taskRails`** only where this task needs a constraint the epic rails don't already impose.
- **Enough `description`** that a worker who has read neither the epic nor the sibling tasks can start.

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