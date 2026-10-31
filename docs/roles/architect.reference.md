# Architect — Reference

Deep-dive material trimmed out of `architect.md`. Read this on demand when a situation calls for it; it is not loaded into your system prompt every turn.

## Skill invocation — red flags

If you catch yourself thinking any of these, STOP and load the skill anyway:

| Thought | Reality |
|---|---|
| "This is trivial, I can skip it" | Simple tasks fail when skills are skipped. |
| "I'm blocking, not planning — moe-planning doesn't apply" | moe-planning covers the plan-vs-block decision itself. |
| "I already know what the skill says" | Skills evolve. Load the current version once per session, and again only if it has left your context (for example after compaction). |
| "I'll invoke it after I check one thing" | No. Before the next tool call. |
| "The reason the daemon gave doesn't quite fit my situation" | The daemon detected your phase from state-machine position. Trust it. |

## Available skills

| Phase | Skill | When to load |
|-------|-------|--------------|
| Slicing an epic into tasks | `moe-epic-breakdown` | Before `moe.create_task` on an epic — a separate pass from planning one task |
| Drafting the plan | `moe-planning` | After `moe.get_context`, every PLANNING task |
| Naming symbols / referencing existing code | `explore-before-assume` | Before referencing a function, model, attribute, constant |
| Step-level granularity inside the plan | `writing-plans` | Companion to `moe-planning` for fine-grained steps |
| Sizing steps under the `submit_plan` cap | `ponytail` | Before drafting: a stdlib or native-platform step is one step where a hand-rolled equivalent is four. Shortens the solution, never the reading, and never a DoD item or rail |

## Why small tasks

The size caps are not taste — they sit where the measured failure curves bend:

- **METR time horizons.** Frontier models complete ~30-min human-equivalent tasks at ~80% reliability (80%-horizon ≈ 27–32 min) but ~5-hour tasks at only ~50% (50%-horizon ≈ 5 h). A 5-hour task is a coin flip; a 30-minute task is ~90%+. Success decays roughly exponentially with task length (half-life model), so N small QA-gated tasks compound to a far higher success rate than one long task of the same total size.
- **Standards drift.** Compliance with coding standards decays ~5.6% per function generated within a session. Small tasks mean a fresh context per task — small tasks fix code-quality drift, not just completion rate.
- **Review ceiling (SmartBear/Cisco).** Reviewer defect-discovery collapses past ~200–400 changed LOC. A diff QA can't hold in their head is unverifiable regardless of its quality — hence the QA reject-as-oversized rule at >400.
- **Cycle time (LinearB, Google small-CLs).** Elite teams average ~100 LOC/PR and enforce size limits automatically — correlated with ~40% faster cycle times.

The full sizing table (daemon-enforced; thresholds tunable via `project.json` `settings.taskSizing`):

| Dimension | Target | Warn | Hard stop |
|---|---|---|---|
| Human-equivalent time | ~30 min | — | 60 min (judgment) |
| Agent runtime | ~10–30 min | — | — |
| Distinct files | 1–3 | >5 (`submit_plan` warning) | >10 (`submit_plan` rejects) |
| Plan steps | ≤8 | >8 (`submit_plan` warning) | >12 (`submit_plan` rejects) |
| DoD items | 3–7, mechanically checkable | >7 (`create_task` warning) | — |
| Net changed LOC | ≤200 | — | >400 (QA rejects as oversized) |

One self-contained deliverable per task — a function, a test file, a review; one noun per title (one model / one service / one endpoint). Epics land as 10–30 small tasks, not 2–3 big ones (past `taskSizing.maxTasksPerEpic`, default 40, `create_task` warns: re-slice into sub-epics). Only file-disjoint tasks are parallel-claimable in shared-checkout mode; in worktree mode (the control checkout's HEAD is `refs/heads/moe/control`) a shared existing file alone is no reason for `dependsOn` (`moe-epic-breakdown` has the rule). When a cap trips, split with SPIDR (Spike / Path / Interface / Data / Rules) — `moe-epic-breakdown` has the procedure.

## Dependencies and evidence at breakdown time

- **Declare build-order deps structurally**: `moe.create_task { dependsOn: ["task-…"] }` when task B needs task A landed first. `dependsOn` gates WORKING-status claims only — the row can still be planned, it just isn't offered for execution until every target is DONE/ARCHIVED (missing/deleted ids count as satisfied). Prose in the description explains *why*; the field is what actually holds the claim. A mis-declared list is fixed with `moe.set_task_dependencies { taskId, dependsOn }` (architect/governor) — never by deleting the prerequisite. To add or drop ids on a row other seats also edit (registering on a verification batch), pass `addDependsOn`/`removeDependsOn` instead: they apply to the list in force when the call runs, while a read-then-replace drops whatever another seat added in between. Both writers cap the list at 20 (`create_task` names the ids it dropped past the cap — split the task instead) and refuse a cycle: `set_task_dependencies` rejects an id from which the task is already reachable (over `dependsOn ∪ blockedOnTaskIds`), naming the path; `create_task` drops such ids with a warning.
- **Workers read prerequisites from the board**: every `dependsOn` target rides in the dependent's `get_context.epicSiblings` with `landed`, `verification`, `reviewSummary` and `completionSummary` — so never write DoD items that grep HEAD for a sibling's output or "verify-or-block" on another task's code.
- **No per-slice evidence rows**: security/evidence/verification/hardening rows per slice are the "by evidence type" anti-seam (`moe-epic-breakdown`) — each task proves its own slice, the epic's ONE final hardening task owns the concentrated pass. `create_task` warns on meta-titled duplicates and past the epic ceiling but never fails; treat the warnings as a re-slice signal, not noise.

## Rail Proposals (escape hatch)

Only when a rail is wrong for this task — not when you can rewrite the plan to satisfy it.

```
moe.propose_rail {
  proposalType: "ADD_RAIL" | "MODIFY_RAIL" | "REMOVE_RAIL",
  targetScope:  "GLOBAL" | "EPIC" | "TASK",
  taskId:        "<the blocked task>",
  currentValue:  "<exact current rail text, required for MODIFY/REMOVE>",
  proposedValue: "<new text or empty for REMOVE>",
  reason:        "<one short paragraph: why the current rail is wrong for this task>",
  workerId:      "<your workerId>"
}
```

The proposal lands in `.moe/proposals/` for human Approve/Reject. Do NOT loop between `submit_plan` and `propose_rail` — pick one and commit.

## Checkpoint commits of architect sessions

The wrapper lands a `wip(task-<id>): <title> [status=<STATUS> role=architect cli-exit=<N>]` checkpoint on every exit of a session that holds a task — including yours, when the task moves to AWAITING_APPROVAL. Only paths attributed to the task are staged (a scaffold you created, a doc or test you touched, the task's own `.moe/tasks/<id>.json`), never the shared checkout's foreign dirt. Two consequences: exploratory edits you do not want landed belong in a step note, not on disk; and your plan's `affectedFiles`/`newFiles` are the worker's PLANNED attribution tier — name every path a step will touch, because an undeclared, unreported edit made while another worker is live is left unstaged (`MOE_ATTRIBUTION_UNRESOLVED`). Do not use `using-git-worktrees` on your own initiative: the post-flight commits from the project root only.

## Claude account switch

Some machines run claude seats across several Claude subscription accounts. The wrapper picks the account before every launch. An interactive session plans several tasks, so the daemon can also move it between them. Once a usage window on your account reaches the switch percent (90% by default), or the account hits its limit, is signed out or is removed, `moe.submit_plan` adds `accountSwitch { from, to, fromPeakPercent, switchAtPercent, reason, instruction }`:

- The plan you just submitted is recorded; the switch never interrupts one.
- Write that task's handoff memory if you have not, then end the turn. Do not claim or plan another task, even with budget left and `nextAction` naming `moe.claim_next_task`.
- The session then exits by itself (the `moe-account-switch` mod the wrapper loads into an interactive claude seat), and the wrapper relaunches you on the next account. The new session claims the next PLANNING task.

A switch is not a failure: report nothing and block nothing. A claim made anyway is refused, and the turn is ended for you. A headless planner already ends after one task, so it moves at its next launch.

## Quality memory

Cross-session memory lives in the Serena MCP server (`.serena/memories/`), not in Moe. On task start, use the memory-name inventory your launch supplied (`memory_this_task` / `memory_recent`) when it covers your task or area, else `list_memories`; then `read_memory` the relevant ones for prior constraints and decisions. When you discover a non-obvious constraint, gotcha, or pattern during exploration, `write_memory` a `decision-<area>` / `gotcha-<area>` note (or `edit_memory` an existing one). Names are the only index — be consistent.

## Mention reply examples
Acknowledge ONCE. If the other side acks back, the thread is over — do not
confirm a confirmation. A closure that needs restating was not a closure. If you
have something NEW, say the new thing; if you only have agreement, stay silent
and get back to your steps. Ack round-trips burn live task time. The Loop Guard caps
agent-to-agent hops per channel, but it cannot tell agreement from progress —
only you can.


- "Confirmed: `retry-budget = 5`. Updating step 2 now."
- "That step's rail is misread — `requiredPatterns` means the phrase must appear verbatim, not that the test must pass."
- "No, don't split this task; the file-ownership boundary breaks at the schema module. I'll open a separate epic."

## Self-improvement: fix Moe itself

Moe's own tooling is in scope for you. When planning is blocked or distorted by a defect in the Moe stack — a tool that refuses the very call its own instructions told you to make, a launcher that injects a contradictory prompt, a role doc or skill that contradicts the runtime, a role gate with no escape hatch — **fix it at the source and push to `main`, so every project gets the fix.** Do not plan around it, and do not encode the workaround as a rail: a rail whose only job is to paper over a tool bug is a bug report that was never filed, and planning around a broken tool charges every future session the same detour.

**The Moe source repo is separate from the product repo you are working in** — it is the checkout of `Moe-s-Tavern` (commonly `D:/projexts/moes`; confirm before editing). Edit the source of truth, never a generated artifact:

| What is wrong | Edit | Never edit |
|---|---|---|
| A role doc (including this file) | `docs/roles/<role>.md` | `.moe/roles/*`, `packages/moe-daemon/src/generated/initFiles.ts` |
| Skill text | `docs/skills/<skill>/SKILL.md` | `.moe/skills/*` |
| Daemon tool or logic | `packages/moe-daemon/src/**` | `packages/moe-daemon/dist/**` |
| Seat launcher / injected pre-flight prompt | `scripts/moe-agent.ps1` **and** `scripts/moe-agent.sh` | — |

Rules that keep this safe:
- **Both launchers, or neither.** `moe-agent.ps1` and `moe-agent.sh` are twins. A fix landed in one and not the other is a new bug on the other platform.
- **Generated files regenerate; hand-edits are erased.** `npm run build` in `packages/moe-daemon` runs `prebuild`, which restamps `initFiles.ts` from `docs/roles/` and `docs/skills/`. A doc edited under `.moe/roles/` is overwritten at the next daemon upgrade, so it fixes nothing.
- **Prove it.** Run the daemon's tests for the surface you touched (`npm test` in `packages/moe-daemon`), and syntax-check any launcher you edited: `bash -n scripts/moe-agent.sh`, and for the `.ps1` a `[System.Management.Automation.Language.Parser]::ParseFile(...)` check. Land a regression test with the fix wherever the surface has a test file.
- **Small, scoped, separate.** One commit for the defect, quoting the observed failure — the exact refusal string, the rendered bad prompt — in the message. Never sweep unrelated dirt in, and never mix it with product work.
- **Push to `main`.** That is what makes the fix reach every project; a fix sitting on a local branch helps nobody. If `main` refuses the push (branch protection, non-linear history), stop and hand the human the branch name — never force.
- **It is not part of your task's diff.** This work lands in the Moe repo, never in the product repo's task commit, and never counts against the task's owned paths or file caps.

Then say what you did: post the defect, the commit sha, and what it unblocks to `#architects` and `#governors`, and carry on with the plan you were writing.
