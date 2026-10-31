---
# moe-generated: sha=926cb394474a
name: verification-before-completion
description: Use when about to claim work is complete, fixed, or passing, before committing or creating PRs - requires running verification commands and confirming output before making any success claims; evidence before assertions always
---

# Verification Before Completion

## Overview

A completion claim is only as good as the fresh command output behind it. Before you say something passes, is fixed, or is done, run the command that proves it and read its result.

## The Gate Function

```
BEFORE claiming any status or expressing satisfaction:

1. IDENTIFY: What command proves this claim?
2. RUN: Execute the FULL command (fresh, complete)
3. READ: Full output, check exit code, count failures
4. VERIFY: Does output confirm the claim?
   - If NO: State actual status with evidence
   - If YES: State claim WITH evidence
5. ONLY THEN: Make the claim

A claim without steps 2–4 is a guess, and QA will re-run it.
```

## Common Failures

| Claim | Requires | Not Sufficient |
|-------|----------|----------------|
| Tests pass | Test command output: 0 failures | Previous run, "should pass" |
| Linter clean | Linter output: 0 errors | Partial check, extrapolation |
| Build succeeds | Build command: exit 0 | Linter passing, logs look good |
| Bug fixed | Test original symptom: passes | Code changed, assumed fixed |
| Regression test works | Red-green cycle verified | Test passes once |
| Agent completed | VCS diff shows changes | Agent reports "success" |
| Requirements met | Line-by-line checklist | Tests passing |

## Key Patterns

**Tests:**
```
✅ [Run test command] [See: 34/34 pass] "All tests pass"
❌ "Should pass now" / "Looks correct"
```

**Regression tests (TDD Red-Green):**
```
✅ Write → Run (pass) → Revert fix → Run (MUST FAIL) → Restore → Run (pass)
❌ "I've written a regression test" (without red-green verification)
```

**Build:**
```
✅ [Run build] [See: exit 0] "Build passes"
❌ "Linter passed" (linter doesn't check compilation)
```

**Requirements:**
```
✅ Re-read plan → Create checklist → Verify each → Report gaps or completion
❌ "Tests pass, phase complete"
```

**Agent delegation:**
```
✅ Agent reports success → Check VCS diff → Verify changes → Report actual state
❌ Trust agent report
```

---

## Moe integration

This skill is the gate before `moe.complete_step` (final step) and `moe.complete_task`. Before either:

1. Identify the verification command for the step's `affectedFiles` (`npm test` for daemon/proxy, `./gradlew test` for the JetBrains plugin, etc. — see the `regression-check` skill).
2. Run it fresh in this turn.
3. Submit the run as `moe.complete_task { verification: { command, exitCode: 0, outputTail } }` — the call is rejected without it — and put the counts (tests run / passed) in the `complete_step` note or `complete_task` summary.

QA reviews the summary. A summary that says "all tests pass" with no numbers is a `qa_reject` waiting to happen — for good reason. Pair this skill with `regression-check` for what to run, and `adversarial-self-review` for what else to look at before claiming done.