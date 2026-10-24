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
3. **Read the diff — the recorded one.** The diff is `task.commits` from `get_context`: `git show <sha>` per `completion` entry (the same session's `checkpoint` entries are part of the story too). When `task.commits` is empty, follow **Empty `task.commits` at REVIEW** below — the bounded wait, then the self-landing fallback — rather than reviewing the dirty tree ad hoc. Every modified file. Look for: unhandled errors, unchecked inputs, race conditions, resource leaks, silent failures.
4. **Walk the rails.** Every item in `allRails` must be satisfied in the diff.
5. **Edge cases.** What breaks at scale? On malformed input? On concurrent writes? On disconnect? On cold cache?
6. **Operational readiness.** Are errors logged? Are failures observable? Is there a way to roll back?

## Empty `task.commits` at REVIEW

**First check isolated-clone delivery.** When the worker reports a rail-authorized clone commit, use a fresh remote fetch of the intended branch, verify SHA containment and the actual owned diff, then repair the missing `moe.record_commit` entry. Supply actual sha/treeId/ref/paths, kind=completion, outcome=committed, role, and truthful sessionId provenance; pushed=true requires remote confirmation. Preserve any known original Moe-Session trailer; if the original session is unknown, identify the actual recording session and disclose the repair rather than inventing original provenance. This records existing bytes, not another landing or QA approval. Never self-land clone-delivered bytes in the shared tree. A wrapper branch-sync failure or nothing-to-commit outcome does not negate this independent delivery evidence.

**Fallback scope.** The following self-landing path applies only when no existing delivery is found and current rails permit shared-tree landing. If rails forbid it or ownership cannot be established, preserve the source and escalate the delivery/attribution gap; no duplicate commit, stage-all, discarded peer work, or invented PASS.

**The rule** (with `settings.autoCommit` on, the default). An empty `task.commits` at REVIEW is a bounded wait, not a blocker. Do the work you already owe first — re-run `task.verification` and the tests (item 1 above) — then re-poll `get_context`. That re-run normally outlasts the wrapper's landing window on its own, so this is an ordering rule, not a sleep loop: never idle-spin, and cap the whole thing at up to ~2 minutes total. Re-poll and decide **before** you stage anything; if a completion commit arrives at any point, drop the fallback and review that commit. Only when the bounded wait expires with `task.commits` still empty, no isolated delivery is found, and current rails permit it do you fall back — verify the row on its merits on the working tree and land it yourself with the path recipe below, then `moe.record_commit`, then approve, saying in the `qa_approve` summary that you self-landed after the bounded wait expired. A `NO-COMPLETION-COMMIT` warning after that is a daemon race, not a defect.

**The path recipe (canonical — do not reword).** Stage only the paths measured to be this row's own — per path, `git diff -- <path> | grep '^[+-]' | grep -v '^[+-][+-]' | grep -vi '<row vocabulary>'` must come back EMPTY; a path that also carries a peer's hunks is EXCLUDED whole (the peer's own landing carries it), and partial-hunk staging is a last resort that needs a bare commit — commit with the task trailer, `moe.record_commit`, then approve.

**When the fallback cannot run.** After checking isolated delivery, if the permitted recipe leaves nothing attributable to stage, the delivery remains unproven; an empty or foreign-dirty shared tree alone never disproves a clone-delivered commit. That is a `moe.qa_reject` citing the evidence gap (quote `landing.lastCommitOutcome` when it is `refused`/`failed`), not a self-land. If the commit succeeds but `moe.record_commit` then fails, the commit still stands: cite its sha in the approve summary and name the `record_commit` failure there too, so the ledger gap is visible instead of silent.

**With `settings.autoCommit` false** the wrapper commits, pushes and records nothing, so neither the bounded wait nor the self-landing fallback applies: the worker owns its commit (with a `Moe-Session:` trailer, which is the truthful `sessionId` for a ledger repair) and its `moe.record_commit`. After the isolated-delivery check, hold a row whose `task.commits` is still empty — `moe.qa_reject` it citing the missing delivery; never approve it.

**Why — measured 2026-09-06.** In that measurement, one completion in three reached REVIEW with its bytes only in the dirty tree. A wrapper lands a row only when its CLI process exits on that row, so a session that hopped to another row, or an interactive seat that never exits, can never fire it — an unbounded wait strands those rows forever. Per the governor ruling, `docs/roles/qa.md` (269d3fe, 2026-09-06) supersedes `docs/skills/moe-qa-loop/SKILL.md` (bf3f8fa, 2026-08-29) on this point, and qa.md's path recipe stays canonical. This is the interim rule until the Wave 1 finalize/candidate work lands.

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
