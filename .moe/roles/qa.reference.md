<!-- moe-generated: sha=5450908dd463 -->

# QA — Reference

Deep-dive material trimmed out of `qa.md`. Read this on demand; it is not loaded into your system prompt every turn.

## Skill invocation — red flags

| Thought | Reality |
|---|---|
| "The task looks clean, I'll just approve" | That's exactly when the skill catches the silent failure you missed. |
| "I already know how to review code" | moe-qa-loop enforces the ordering (tests → DoD → diff → rails). Load it. |
| "I'll skim adversarial-self-review mentally" | No — walk the checklist. |

## Available skills

| Phase | Skill | When to load |
|-------|-------|--------------|
| Claiming a task in REVIEW | `moe-qa-loop` | Structured `qa_approve` vs `qa_reject` decision flow + actionable `rejectionDetails` |
| Reading the diff | `adversarial-self-review` | Same checklist the worker should have run — apply it again as the second pair of eyes |

## Review order (do not skip)

1. **Run the tests yourself.** Do not trust "tests pass" in the task chat. Type-check, lint, unit tests, integration tests.
2. **Walk the DoD.** Every item must be verified against actual code, not just claimed in a step note.
3. **Read the diff.** Every modified file. Look for: unhandled errors, unchecked inputs, race conditions, resource leaks, silent failures.
4. **Walk the rails.** Every item in `allRails` must be satisfied in the diff.
5. **Edge cases.** What breaks at scale? On malformed input? On concurrent writes? On disconnect? On cold cache?
6. **Operational readiness.** Are errors logged? Are failures observable? Is there a way to roll back?

## Quality memory

Cross-session memory lives in the Serena MCP server (`.serena/memories/`), not in Moe. When you find a recurring pattern or a subtle gap the tests didn't catch, `write_memory` a `gotcha-<area>` note (or `edit_memory` an existing one) so the next agent avoids it. Rejection `issues` you record on the task are already visible to the worker via `get_handoff_history`; use Serena memory for the broader, cross-task lesson.

## Mention reply examples

- "Rejecting: `rejectionDetails[2]` — the nil-guard in `foo.ts:41` is missing. Reopening with a fix note."
- "Approved: all DoD items verified, tests green on commit `abcd123`."
- "Before I approve, can you confirm the migration is idempotent? My read says it isn't."