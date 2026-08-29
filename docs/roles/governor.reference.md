# Governor — Reference

Deep-dive material trimmed out of `governor.md`. Read this on demand when a situation calls for it; it is not loaded into your system prompt every turn.

## Stale-worker handling

The daemon does **not** auto-release WORKING/PLANNING tasks on idle time — a long-running worker keeps its task no matter how quiet it goes. Crash recovery is already layered without you: daemon restart purges all workers and releases their tasks; graceful exits call `moe.deregister_worker` from the wrapper's exit trap; a crashed QA's REVIEW task self-heals after `reviewStaleTimeoutMs` (30 min default); and live CLIs run a heartbeat sidecar that pings `moe.heartbeat` every 60s even during silent local steps. Your job on a ⚠️ alert is triage, not reaping.

**Idle time alone — any amount, any multiple of the presence window — is never grounds for `release_task`.** A stale flag means "no tool call or heartbeat lately," which is compatible with a worker deep in a long build whose sidecar is disabled or past its 2h bound. Releasing such a worker destroys real in-flight work and strands its local state.

What to do instead, in order:

1. **Ping the worker** in `#workers`. Most stale workers answer.
2. **Read the worker record.** `lastError` and `errorCount` are stronger signals than wall-clock silence — `errorCount > 3` with a recent `lastError` is real trouble; quiet-with-no-errors usually is not.
3. **Look for a death signal**: a deregister banner in chat, a wrapper exit, the human confirming the process is gone. No death signal → keep waiting or ask the human.
4. **Release only on a confirmed crash, and with the human's nod.** When you do release, pass a `handoffNote` if any context is recoverable from chat or the task's comments.

## Shared resources

Leases over exclusive-use infrastructure (benchmark box, staging DB) are daemon-owned; your levers:

- **Visibility**: `moe.list_resources` shows every resource — resolved capacity/lease cap, current holders (note/ETA/expiry) and the wait queue in grant order. Use it to spot convoys (a long queue behind one holder) and stale leases nearing expiry.
- **Stuck lease**: `moe.release_resource { resourceId, workerId: <you>, taskId: <holder's task>, force: true }` force-releases another holder's lease and grants the queue onward. Omitting `taskId` with `force: true` clears ALL leases and queue entries — scope it unless you mean that. The reaper already force-releases past `maxLeaseMs` (default 24h) and posts a ⏱️ line to `#governors`, so force is for when the queue can't wait for the cap.
- **Declaration**: tune capacity/lease caps in `.moe/project.json` `settings.resources` — `{ "<id>": { capacity, maxLeaseMs, description } }` (defaults capacity 1, 24h; undeclared ids auto-create with those). A settings update replaces the whole map.
- **Leave resource-blocked tasks alone**: a task BLOCKED with `blockedResourceId` set is waiting legitimately and auto-unblocks on grant — the blocked-timeout sweep deliberately skips parking it. Human-blocked tasks (no resourceId) are the ones your triage playbook applies to.

## Unblocking: seat vs task

Most seats free themselves now: a non-resource `moe.report_blocked` releases the seat at report time (worker → IDLE, task BLOCKED-unassigned), and blocks with `blockedOnTaskIds` or `blockedResourceId` auto-unblock without you. `moe.unblock_worker` is for the leftovers, and it is **seat-only by default**: the worker goes IDLE (and, without `retryTask`, drops the assignment) but its BLOCKED task stays BLOCKED with `blockedReason` intact — the response lists it in `stillBlockedTaskIds`. Freeing a seat is not evidence that the blocker is gone, and the old wipe-the-block behaviour produced RE-BLOCKs: the next claimant walked into the same wall minutes later.

- **Blocker actually resolved** → `moe.unblock_worker { workerId, resolution, resolveBlocks: true }` (restores `blockedFromStatus`, clears every `blocked*` field, returns `unblockedTaskIds`) or, task-only, `moe.set_task_status { taskId, status: <blockedFromStatus> }`.
- **Seat stuck, blocker still real** → bare `unblock_worker`. The task stays BLOCKED-unassigned and is not auto-parked — sweep `moe.list_tasks { status: "BLOCKED" }` each tick and route each one: resource-blocked (leave alone), human-blocked (get the answer, then resolve), or misused as a terminal.
- **BLOCKED misused as a terminal** ("done, blocked by design", every step COMPLETED): the daemon already warned the worker (`ALL_STEPS_COMPLETE`). Ask the worker to `complete_task` with verification, or `set_task_status` → REVIEW yourself when the evidence is already on the task.
- `retryTask: true` without `resolveBlocks` leaves a BLOCKED task untouched (still assigned, still BLOCKED) — for when the same worker should resume once the block clears.
- Git is never a reason to hurry an unblock: the wrapper checkpointed the task's files on the BLOCKED exit and lands any lingering baseline at the next pre-flight, so nothing is stranded while a task waits.

## Task dependencies: gating, auto-unblock, and the escape hatch

Two structured fields replaced free-text "BUILD-ORDER BLOCK on task-X" prose:

- **`dependsOn`** (set at `create_task`, prevention): gates **WORKING-status claims only** — `claim_next_task`/`wait_for_task` withhold the row until every target is DONE/ARCHIVED. Planning proceeds regardless; a missing/deleted id counts as satisfied, so a deleted prerequisite can never wedge its dependents. `moe.list_tasks` rows carry `dependsOnUnmet` — that is why a row "isn't being offered".
- **`blockedOnTaskIds`** (set at `report_blocked`, cure): parks an already-claimed task; the daemon auto-unblocks it (status → `blockedFromStatus`, unassigned, claimable by anyone — a still-assigned hold returns to its worker only while that worker exists, is not DEAD and still points at the task) the moment every listed task is DONE/ARCHIVED — event-driven, with a sweep backstop for rows blocked before the upgrade. `report_blocked` also auto-parses `task-…` ids out of the free-text reason, so legacy-style blocks become structured with zero agent effort. Ids that are ALL already DONE/ARCHIVED at report time do **not** block (`dependenciesSatisfied:true`, the worker is told to continue — no claim-thrash), and an id that would close a dependency cycle (over `dependsOn ∪ blockedOnTaskIds`) is dropped with a warning and a `#governors` alert.

Your levers:

- **`moe.set_task_dependencies { taskId, dependsOn }`** — the escape hatch (architect/governor-gated). Full replacement, `[]` clears. Use it when a mis-declared `dependsOn` is withholding a row that should run, or to add the dependency an architect forgot. Gating without this tool would let one typo permanently stick a row — that is why it exists; never work around it by deleting the prerequisite task. It **rejects a cycle** (an id from which the edited task is already reachable over `dependsOn ∪ blockedOnTaskIds`), naming the path — two rows waiting on each other would sit claim-gated forever with nothing looking at them.
- **Stale-block alert triage** (`blockedAt`-age line in `#governors`, from the sweep — visibility, not auto-park). Three shapes: (1) no deps and no resource — nothing will auto-clear it: a human question → get the answer, then `unblock_worker { resolveBlocks: true }` / `set_task_status`; actually waiting on another task → have the reason re-filed with the task id (auto-parse structures it) so the auto-unblock takes over; every step COMPLETED → BLOCKED misused as "done", the worker should `complete_task`. (2) dep-waiting, but an unmet prerequisite is itself BLOCKED/BACKLOG (the line shows each dep's status) — the auto-unblock cannot fire until you move the prerequisite: promote the BACKLOG one, unblock the BLOCKED one, or, if it waits back on this row (a cycle), re-plan one side and fix the graph with `set_task_dependencies`. (3) dep-waiting past 2× the blocked timeout with prerequisites still in flight — check they are actually moving.
- Do **not** sweep dependency-blocked or resource-blocked rows into BACKLOG or `resolveBlocks` them "to tidy up" — both auto-clear, and clearing block state by hand throws away the `blockedFromStatus` restore. The exception is the stuck-prerequisite alert above: that row will never auto-clear without a human move.

## Rail proposal patterns

When a rail blocks a task you're trying to unblock, file a proposal. Common patterns:

```
moe.propose_rail {
  proposalType: "MODIFY_RAIL" | "ADD_RAIL" | "REMOVE_RAIL",
  targetScope:  "GLOBAL" | "EPIC" | "TASK",
  taskId:        "<the blocked task>",
  currentValue:  "<exact current rail text, required for MODIFY/REMOVE>",
  proposedValue: "<new text or empty for REMOVE>",
  reason:        "<one short paragraph: why the current rail is wrong>",
  workerId:      "<your workerId>"
}
```

- **MODIFY_RAIL at TASK scope** when a global rail is right in general but wrong for *this* task. Cheapest, lowest blast radius.
- **REMOVE_RAIL at TASK scope** when a rail has become obsolete for the task. Document why in `reason`.
- **ADD_RAIL at EPIC scope** when you notice multiple tasks in the epic violating an implicit invariant. Codify it.
- **MODIFY_RAIL at GLOBAL scope** is the nuclear option. Use only when the rail is genuinely broken across the repo.

Do NOT loop between `propose_rail` and other actions on the same task — propose once, then wait for human decision via `moe.check_approval`.

## Anti-patterns to avoid

| Anti-pattern | Why it's wrong | What to do instead |
|---|---|---|
| Second-guess the architect's plan when the worker hasn't actually stalled | You don't own planning. Workers sometimes look slow but are working. | Wait for a self-reported block or a real death signal. |
| Release a worker because it looks idle | Quiet ≠ dead — long builds/tests are silent, and you'll discard the worker's local edits. | Ping first; release only on a confirmed crash with the human's nod. |
| Flip to PLANNING on every QA rejection | First rejection is usually a worker-side fix. Re-plan is for systemic issues. | Re-plan only after the same DoD item gets rejected twice. |
| Reply to every drift signal with a tool call | The chat log is a tool too. Sometimes the right action is "watch and wait." | Post an acknowledgement; let the worker self-correct first. |
| Use `moe.chat_send` to brainstorm with the architect mid-plan | Architects in PLANNING are in a TUI conversation with the human. Cross-talk derails them. | Wait until the architect submits or use `#general` for non-urgent observations. |
| Call `unblock_worker` to free a seat and expect the task's block to be resolved | The default is seat-only now; the task stays BLOCKED with `blockedReason` — the pre-fix wipe caused RE-BLOCKs. | Pass `resolveBlocks: true` only when the blocker is actually gone; otherwise triage the BLOCKED task separately. |
| Hand-commit a task's stranded sources under your own identity (a `chore(...)` sweep) | Hides attribution, the task record never learns of the commit, and the wrapper already checkpoints every exit. | Read `task.commits` / `refs/moe/rescue/`; `declare_files` the paths onto the task and let its next session land them. |
| Accept BLOCKED as a finished state ("done, blocked by design") | BLOCKED is a wait state; delivered work exists for the fleet only once it goes through `complete_task` and lands. | Ask the worker to `complete_task` with verification, or `set_task_status` → REVIEW when the evidence is on the task. |

## Commit evidence

The wrapper — never the daemon — lands every session's files (completion commit on REVIEW, `wip(task-<id>)` checkpoint otherwise, `refs/moe/rescue/<task>/<ts>` on failure) and reports each attempt via `moe.record_commit`. Read the ledger before touching git:

- `moe.get_context { taskId }` → `commits` (sha, ref, kind, pushed), `landing.lastCompletion`, `lastCommitOutcome` (`committed` / `nothing` / `refused` / `failed` + `MOE_COMMIT_*` code), `unattributedPaths`, `epicSiblings[*].landed`.
- `git log --grep 'Moe-Task: task-<id>' --format='%h %s'` — every wrapper commit carries `Moe-Task` / `Moe-Kind` / `Moe-Session` / `Moe-Status` trailers; `git for-each-ref refs/moe/rescue/task-<id>/` for rescues.
- **`MOE_COMMIT_REFUSED_NO_OWNED_PATHS`**: nothing was attributable — no step reported `modifiedFiles`, no plan paths, no declaration. `moe.declare_files { taskId, paths }` and let the next session land them. **`MOE_COMMIT_REFUSED_OWNED_PATH_MISSING`**: the asserted paths are gone from disk and HEAD (renamed, or edited in a `.worktrees/` checkout the post-flight never sees).
- **`MOE_ATTRIBUTION_UNRESOLVED`** (task channel + rate-limited `#governors`): changed paths nobody declared were left unstaged because another worker was live. Find the owner (`grep -l '<path>' .moe/tasks/*.json`, chat, the session's step notes) and `declare_files` onto that task.
- **Foreign-WIP debris** — dirty paths whose only owner is a DONE task — is `MOE_ATTR_PREEXISTING` for every later task and never swept. Runbook in `docs/TROUBLESHOOTING.md` ("Dirty paths owned only by DONE tasks"): declare onto a live task, or a human `chore(debris:<taskId>)` pathspec commit. Never land it under your own identity as a fleet-wide `chore` commit.
- **`NO-COMPLETION-COMMIT`** from `qa_approve`: usually the post-flight race (the commit lands seconds after REVIEW). Re-check `task.commits` a minute later; if still empty, `lastCommitOutcome` says why. A DONE task with no completion commit is a merge with no reviewed diff — flag it.
- `PUSH FAILED` / `CHECKPOINT-UNPUSHED` are visibility problems (the commit exists locally; `pull --rebase` refuses in a dirty shared checkout), not losses.

## Mention reply examples

- "Saw the stale alert on `worker-foo`. Pinging them in `#workers` first — will report back in one tick."
- "Rejection #2 on same DoD item. Flipping `task-bar` to PLANNING; architect will see it in `#architects`."
- "Rail conflict on `task-baz`: `forbiddenPatterns` blocks `fs.unlink` but the DoD requires deleting temp files. Filing a `propose_rail`."
- "Worker says they're alive, just running a long test. Standing down on the release — re-check in 5 min."

## Quality memory

Cross-session memory lives in the Serena MCP server (`.serena/memories/`), not in Moe. When you spot a recurring failure mode or a subtle invariant the system missed, `write_memory` a `pattern-<area>` note (or `edit_memory` an existing one). Governors own cross-task `epic-<epicId>-notes` — workers see one task at a time; you see the fleet. There is no auto-ranking, so consistent topic names are what make this knowledge findable.
