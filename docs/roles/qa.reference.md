# QA — Reference

Deep-dive material trimmed out of `qa.md`. Read this on demand; it is not loaded into your system prompt every turn.

## Verification constraints take precedence

Read current project/epic/task rails before running commands. All test and re-run defaults below apply only where those rails permit them, including during a bounded commit wait. A build/test freeze also forbids tiny repro scripts and targeted tests unless explicitly exempted.
- When a rail explicitly defers coverage to a batch, audit that coverage hand-forward; do not author/run forbidden per-task tests or reject solely for the authorized deferral. Retain all other DoD checks and report the deferred behavior as unverified.
- If a required check is prohibited rather than explicitly deferred, use `moe.report_blocked` with the restriction and completed evidence; resume REVIEW when resolved. An environmental restriction is not a code defect, and compilation/static review alone cannot replace required runtime evidence. Never treat an unrun check as passing.

## Skill invocation — red flags

| Thought | Reality |
|---|---|
| "The task looks clean, I'll just approve" | That's exactly when the skill catches the silent failure you missed. |
| "I already know how to review code" | moe-qa-loop enforces the ordering (rails → permitted tests → DoD → diff). Load it. |
| "I'll skim adversarial-self-review mentally" | No — walk the checklist. |

## Available skills

| Phase | Skill | When to load |
|-------|-------|--------------|
| Claiming a task in REVIEW | `moe-qa-loop` | Structured `qa_approve` vs `qa_reject` decision flow + actionable `rejectionDetails` |
| Reading the diff | `adversarial-self-review` | Same checklist the worker should have run — apply it again as the second pair of eyes |
| After the correctness verdict | `ponytail-review` | Complexity-only second pass. Rail/DoD breaches become `rejectionDetails`; taste-only findings go in the approve summary or a follow-up card — never a reject |

## Review order (do not skip)

1. **Run the permitted tests yourself.** Do not trust "tests pass" in the task chat. Type-check, lint, unit tests, integration tests.
2. **Walk the DoD.** Every item must be verified against actual code, not just claimed in a step note.
3. **Read the diff — the recorded one.** The diff is `task.commits` from `get_context`: `git show <sha>` per `completion` entry (the same session's `checkpoint` entries are part of the story too). When `task.commits` has no completion entry for this round, follow **Empty `task.commits` at REVIEW** below — the bounded wait, then a `moe.qa_reject` — rather than reviewing the dirty tree ad hoc. Every modified file. Look for: unhandled errors, unchecked inputs, race conditions, resource leaks, silent failures.
4. **Walk the rails.** Every item in `allRails` must be satisfied in the diff.
5. **Edge cases.** What breaks at scale? On malformed input? On concurrent writes? On disconnect? On cold cache?
6. **Operational readiness.** Are errors logged? Are failures observable? Is there a way to roll back?

## Empty `task.commits` at REVIEW

"Empty" means no `completion` entry in `task.commits` for this review round: a planning or recovered checkpoint does not count, and architect planning checkpoints put one on almost every row.

**First check isolated-clone delivery.** When the worker reports a rail-authorized clone commit, use a fresh remote fetch of the intended branch, verify SHA containment and the actual owned diff, then repair the missing `moe.record_commit` entry. Supply actual sha/treeId/ref/paths, kind=completion, outcome=committed, role, and truthful sessionId provenance; pushed=true requires remote confirmation. Preserve any known original Moe-Session trailer; if the original session is unknown, identify the actual recording session and disclose the repair rather than inventing original provenance. This records existing bytes, not another landing or QA approval. Never self-land clone-delivered bytes in the shared tree. A wrapper branch-sync failure or nothing-to-commit outcome does not negate this independent delivery evidence.

**No self-landing, in either mode.** Worktree mode is on when `git rev-parse --symbolic-full-name HEAD` in your checkout prints exactly `refs/heads/moe/control`; anything else, a git failure included, is shared mode. Do not take the mode from `get_context`'s `workspace`: a QA claim records `shared` even when worktree mode is on. Either way your checkout is the control checkout. In shared mode the workers' bytes sit in it, dirty; in worktree mode they live in the workers' own task worktrees, the control checkout only follows the target, and control seats land nothing. Never commit in the control checkout: the agent Git-write guard refuses an agent CLI's commit or push there, and one from any shell it spawns, with `MOE_AGENT_GIT_REFUSED: the wrapper lands the work`. The wrapper is the only Git-write actor; the guard's override is for a deliberately reviewed human operation, never an agent's landing repair. In worktree mode a commit there would also put `moe/control` ahead of the target, and every later follow would stop with `MOE_CONTROL_CHECKOUT_DIVERGED` until a human lands or resets it. With `settings.autoCommit` off (`get_context` `project.settings`), nothing lands automatically, so there is no ledger to wait for: review `filesModified` on the working tree and decide on merit.

**The rule.** `task.commits` with no completion entry for this round is a bounded wait, not a blocker. Do the work you already owe first — re-run `task.verification` and the tests (item 1 above) — then re-poll `get_context`. That re-run normally outlasts the wrapper's landing window on its own, so this is an ordering rule, not a sleep loop: never idle-spin, and cap the whole thing at up to ~2 minutes total. Re-poll and decide before you act; if a completion commit arrives at any point, review that commit. When the bounded wait expires with no completion entry and no isolated delivery is found, the landing did not happen: reject as below.

**The reject.** Call `moe.qa_reject` with one issue of type `other` whose description starts with `Landing gap:` and cites:
- `task.lastCommitOutcome` (outcome and code; null means nothing was recorded): for example `nothing` for a nothing-to-commit landing, or `refused`/`failed`;
- `task.landingRetry` when `get_context` returns it;
- each rescue entry (`rescueRefsHint`, refs under `refs/moe/rescue/<taskId>/`);
- the row's paths that are still dirty, with any held-path remedy its landing printed (`MOE_CONTESTED_HELD`).

Add a separate issue for any defect your verification re-run found. Name `failedDodItems` only for DoD items you verified failing, never for the landing gap alone, so a repeated gap never counts as the same DoD item failing twice. An empty or foreign-dirty shared tree alone never disproves a clone-delivered commit: after checking isolated delivery, an unproven delivery is this evidence gap, not a verdict on the code. The reject hands the row back to a worker, whose session can close every variant of the gap: its wrapper's pre-flight recovers a rescue ref or a dead session's bytes (`MOE_CHECKPOINT_RECOVERED`), the worker reports its own unattributed paths and re-edits held ones with a tool, and its exit lands the completion. A landing-gap reject counts toward the reopen cap like any other, and a re-plan cannot fix a landing gap.

**A second landing gap.** If `rejectionHistory` (`get_context` returns the last 5 entries with their issues) already holds a `Landing gap:` reject for this row, do not reject again. Leave the row in REVIEW, with no verdict and no `moe.report_blocked`, and post in #governors: the row id, the earlier reject's `rejectedAt`, `task.lastCommitOutcome`, the rescue entries, the still-dirty paths and your verification re-run. Post once per review round: if your escalation for this round is already there and no completion has landed since, skip the post. Then end the session; the governor or a human sets the next status.

**Why — measured 2026-09-06.** In that measurement, one completion in three reached REVIEW with its bytes only in the dirty tree. A wrapper lands a row only when its CLI process exits on that row, so a session that hopped to another row, or an interactive seat that never exits, can never fire it — an unbounded wait strands those rows forever. QA self-landed such rows until the agent Git-write guard (447281cf, 2026-10-30) began refusing every agent commit in the control checkout; the wrapper is the only Git-write actor, so the row goes back to a worker.

## A task whose code spans several commits

**Do not assume the newest commit is the whole diff.** Audit from the task's recorded commit ledger — every `task.commits` entry, `checkpoint` and `rescue` as well as `completion` — and judge the landed bytes against the task's baseline, not against the completion commit alone. `git log --all --oneline --grep 'Moe-Task: <taskId>'` is the cross-check; read `Moe-Kind:` in each body rather than the `feat`/`wip` subject prefix.

**Two situations where a split is legitimate**, both leaving a near-empty `feat(...)` completion whose bytes already landed in an earlier `wip(...) ... recovered` checkpoint:

1. **A genuine crash.** The previous session died (window close, SIGKILL, a box reboot) without landing. The next pre-flight of that task lands its baseline as `MOE_CHECKPOINT_RECOVERED`, and the work continues on top. That recovery path is deliberate — it exists because of the 2026-08-28 lost-code incident.
2. **A cross-host skip.** The owner's live-session marker was written on a host or pid namespace this seat cannot probe (a WSL seat and a Windows seat sharing the checkout through a mount). The wrapper prints `MOE_CHECKPOINT_SKIPPED_LIVE_OWNER ... reason=foreign-host` and refuses to recover; the bytes land later, from a seat that can see that process.

**Not legitimate:** a `role=qa ... recovered` checkpoint carrying a worker's whole implementation while the worker's own completion holds only a board record. The wrapper stands down with `MOE_CHECKPOINT_SKIPPED_LIVE_OWNER ... reason=live` in that case, so seeing it means the live-owner guard regressed — reject and say so.

## Quality memory

Cross-session memory lives in the Serena MCP server (`.serena/memories/`), not in Moe. When you find a recurring pattern or a subtle gap the tests didn't catch, `write_memory` a `gotcha-<area>` note (or `edit_memory` an existing one) so the next agent avoids it. Rejection `issues` you record on the task are already visible to the worker via `get_handoff_history`; use Serena memory for the broader, cross-task lesson.

## Mention reply examples
Acknowledge ONCE. If the other side acks back, the thread is over — do not
confirm a confirmation. A closure that needs restating was not a closure. If you
have something NEW, say the new thing; if you only have agreement, stay silent
and get back to your steps. Ack round-trips burn live task time. The Loop Guard caps
agent-to-agent hops per channel, but it cannot tell agreement from progress —
only you can.


- "Rejecting: `rejectionDetails[2]` — the nil-guard in `foo.ts:41` is missing. Reopening with a fix note."
- "Approved: all DoD items verified, tests green on commit `abcd123`."
- "Before I approve, can you confirm the migration is idempotent? My read says it isn't."
