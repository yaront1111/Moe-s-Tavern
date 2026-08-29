# Worker — Reference

Deep-dive material trimmed out of `worker.md`. Read this on demand; it is not loaded into your system prompt every turn.

## Skill invocation — red flags

| Thought | Reality |
|---|---|
| "This step is trivial, I can skip TDD/explore/etc." | Simple steps fail when skills are skipped. |
| "I already know what this skill says" | Skills evolve. Read the current version. |
| "I'll run adversarial-self-review mentally instead of loading it" | No — load it and walk the checklist. |
| "I can ship without verification-before-completion" | You can't. No complete-claim without fresh evidence. |
| "receiving-code-review is just common sense, I'll just fix the feedback" | That's exactly the failure the skill prevents. Load it first. |

## Available skills

| Phase | Skill | When to load |
|-------|-------|--------------|
| First step in unfamiliar code | `explore-before-assume` | Before referencing any symbol you haven't grepped for |
| Test-touching step | `test-driven-development` | RED-GREEN-REFACTOR with mutation-resistant assertions |
| Stuck on a bug or repeated step failure | `systematic-debugging` | 4-phase root-cause method, before proposing fixes |
| Final step before `complete_step` | `adversarial-self-review` | Read your own diff as an attacker — concurrency, null, embarrassment checklist |
| Before `complete_task` | `regression-check` | Run the broader suite; capture counts in your summary |
| Before `complete_task` | `verification-before-completion` | No completion claim without fresh verification evidence |
| Reopened (`reopenCount > 0`) | `receiving-code-review` | Verify each `rejectionDetails` item against the diff before fixing |
| Human-directed only | `using-git-worktrees` | Only when a human explicitly asks for a worktree. The post-flight commits from the project root only — edits inside `.worktrees/` are invisible to it and you must merge them back by hand |

## Rail Proposals (escape hatch)

If a rail blocks a step and satisfying it would actively break the DoD, default to `moe.report_blocked` so the architect can re-plan. Use `moe.propose_rail` only when the rail itself is wrong (e.g. a `forbiddenPatterns` false positive forcing unsafe workarounds):

```
moe.propose_rail {
  proposalType: "ADD_RAIL" | "MODIFY_RAIL" | "REMOVE_RAIL",
  targetScope:  "GLOBAL" | "EPIC" | "TASK",
  taskId:        "<your claimed task>",
  currentValue:  "<exact current rail text, required for MODIFY/REMOVE>",
  proposedValue: "<new text or empty for REMOVE>",
  reason:        "<one short paragraph: why the rail is wrong for this task>",
  workerId:      "<your workerId>"
}
```

Don't use this to dodge inconvenient rails — adversarial-self-review and receiving-code-review will catch it, and QA will reject. The proposal lands in `.moe/proposals/`; once approved, retry the step.

## Commits, checkpoints and rescue refs

You never run `git commit` for a task. The wrapper lands your work after the CLI exits — on **every** exit, not only on success:

| Exit | What lands | Where |
|---|---|---|
| Task reached REVIEW (or DONE) | `feat(task-<id>): <title>` (or `fix(task-<id>): … (retry after qa_reject #N)`) completion commit, pushed | shared branch (`moe/work-<date>` or the literal `consolidationBranch`) |
| Any other exit — WORKING, BLOCKED, PLANNING, AWAITING_APPROVAL, status lookup failed | `wip(task-<id>): <title> [status=<S> role=<r> cli-exit=<N>]` checkpoint, pushed per `checkpointPush` | shared branch |
| `qualityGate` failed, branch peel failed, commit failed, three CAS losses, Ctrl+C | `rescue(task-<id>): <title> [reason=…]` | `refs/moe/rescue/<taskId>/<ts>` — never a branch, never pushed |

What gets staged is decided per path, never `git add -A`: **ASSERTED** (every completed step's `modifiedFiles`, `moe.declare_files`, paths you already landed) is committed no matter what; **PLANNED** (the plan's `affectedFiles`/`newFiles` you did not report) only if it changed since your session's baseline; **TOOL** (files your Edit/Write tool calls touched — claude only) always; **MEASURED** (undeclared, changed) only when no other worker is live. A peer's declared path, a path that was already dirty before your task, and anything under `.moe/` (except your own task record), `.mcp.json`, `.codex/`, `.gemini/`, `.claude/agents/`, `.worktrees/` are skipped with a `[skip] <path> MOE_ATTR_*` line. Undeclared edits with peers active are reported as `MOE_ATTRIBUTION_UNRESOLVED` and never staged — the next session sees them in `get_context.unattributedPaths` with a `moe.declare_files` hint.

Practical rules:

- `modifiedFiles` on every `complete_step` is the whole game. Omitting it draws a `warning`, and with another worker registered an unreported, non-tool-written edit does not land.
- The shared checkout is dirty by design. `[attribution] <K> pre-session dirty path(s) untouched` is informational; never revert, stash or commit those paths, and never stop because of them — note them in your step note and continue.
- A prerequisite has landed iff `get_context.epicSiblings[*].landed` is true (or `git log <branch> --grep 'Moe-Task: <sibling>'` finds it) — and its evidence (`verification { command, exitCode }`, `reviewSummary`, `completionSummary`) rides on the same `epicSiblings` entry, so read what it delivered from the board, never via HEAD greps. Your task's `dependsOn` targets appear there too, regardless of order. Uncommitted files in a peer's checkout are not a prerequisite; a `report_blocked` on a missing prerequisite passes the sibling id(s) in `blockedOnTaskIds` — the daemon auto-unblocks the task the moment they are all DONE/ARCHIVED, and a non-resource block you report on your own task frees your seat (worker → IDLE, `nextAction` → `claim_next_task`) so you take other work instead of idling on the wall. If every id you name is ALREADY DONE/ARCHIVED the task is not blocked at all (`dependenciesSatisfied:true`, `nextAction` → `get_context`): read their evidence from `epicSiblings` and continue — re-file only if something else blocks you, with a reason that names the real blocker. An id that already waits on your task (a dependency cycle) is dropped with a `DEPENDENCY_CYCLE` warning — page the architect, one side needs a re-plan. Resource blocks (`resourceId`) keep the seat parked — the grant path returns the task to you by design.
- Banners you may see in `#general`: `PUSH-BLOCKED:` (gate failed or status lookup failed — your bytes are in a rescue ref / `status=UNKNOWN` checkpoint; on a gate failure the loop stopped), `PUSH FAILED … do not review until pushed` (committed locally only), `CHECKPOINT-UNPUSHED task=<id>` (checkpoint local only), `MOE_RESCUE_REF task=<id> ref=… reason=…`. Refusals: `MOE_COMMIT_REFUSED_NO_OWNED_PATHS` (nothing attributable — declare paths), `MOE_COMMIT_REFUSED_OWNED_PATH_MISSING` (asserted paths gone from disk and HEAD), `MOE_COMMIT_NOTHING_TO_COMMIT` (already in HEAD; harmless).
- A RESUME prompt that lists rescue refs means an earlier session's landing failed: `git show <ref> --stat` / `git checkout <ref> -- <path>` before redoing work. A lingering baseline is landed automatically before your CLI starts (`MOE_CHECKPOINT_RECOVERED`).
- `moe.record_commit` and `moe.get_commit_scope` are wrapper-called — do not call them yourself. `moe.declare_files { taskId, paths }` is yours to use when you know a path is your edit but it was not reported.
- Git hooks do not run on wrapper commits unless the project sets `commitHooks: true`; `settings.qualityGate` is the sanctioned gate.

## Shared resources (exclusive infra)

When a step needs exclusive-use infrastructure (a benchmark box, a staging DB, a GPU), take a daemon lease instead of hoping nobody else is on it:

1. **Acquire before you touch it**: `moe.acquire_resource { resourceId, taskId, workerId, note }`. Granted → do the work. Undeclared ids auto-create (capacity 1, 24h lease cap); leases are keyed by task, so a CLI respawn or daemon restart doesn't lose yours — re-acquiring just renews it.
2. **Busy → park, never poll**: follow the returned `nextAction` — `moe.report_blocked` with the same `resourceId`. Your task flips to BLOCKED, the wrapper stops relaunching sessions, and the daemon auto-unblocks the task (back to its pre-block status) the moment the lease is granted. Do NOT sit in a loop re-calling `acquire_resource`. For a short wait inside a live session, `moe.wait_for_resource` (blocking, ≤10 min per call) is acceptable; anything longer is report_blocked + end the session.
3. **Release when done**: `moe.release_resource { resourceId, workerId }` — the next waiter unparks immediately. The 24h `maxLeaseMs` auto-expiry is a crash bound, not a substitute for releasing.

## Quality memory

Cross-session memory lives in the Serena MCP server (a flat per-name markdown store, `.serena/memories/`), not in Moe. On task start, `list_memories` and `read_memory` to pick up prior knowledge; before you finish, `write_memory` so the next agent benefits.

Naming convention (keeps a multi-agent fleet's knowledge coherent — one topic, one file):
- `convention-<area>`, `gotcha-<area>`, `pattern-<area>`, `decision-<area>` for reusable knowledge
- `task-<taskId>-handoff` for your end-of-session handoff (the next agent on the task reads it)
- `epic-<epicId>-notes` for cross-task epic knowledge (governor-owned)

Prefer `edit_memory` to append to an existing topic file over creating a near-duplicate. There is no BM25 ranking or auto-injection — this naming discipline is what replaces it, so be consistent.

## Mention reply examples

- "Step 2 is blocked on the `retry-budget` constant — do you want `5` or the env-var fallback?"
- "Confirmed I own task-X; starting step 0 now."
- "Tests are red after step 3; investigating before I `complete_step`."
