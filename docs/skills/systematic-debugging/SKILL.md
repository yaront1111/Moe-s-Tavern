---
name: systematic-debugging
description: Use when encountering any bug, test failure, or unexpected behavior, before proposing fixes
---

# Systematic Debugging

## The Iron Law

```
NO FIXES WITHOUT ROOT CAUSE INVESTIGATION FIRST
```

Symptom fixes mask underlying issues and create new bugs. If you haven't completed Phase 1, you cannot propose a fix.

## When To Use

Any bug, test failure, build break, integration issue, or unexpected behaviour. Especially under time pressure — systematic is faster than guess-and-check thrashing.

## The Four Phases

Complete each phase before the next. No skipping.

### Phase 1 — Root Cause Investigation

- Read every error message and stack trace fully. Note line numbers, file paths, error codes.
- Reproduce consistently. Document exact steps. If you can't reproduce, gather more data — don't guess.
- Check recent changes: `git diff`, recent commits, new dependencies, config changes, environmental differences.
- Multi-component systems: instrument every component boundary (log inputs, log outputs, verify env/config propagation, check state per layer). Run once, identify which component breaks, then investigate that one.
- Trace data flow upward: where does the bad value originate? Fix at the source, not the symptom.

### Phase 2 — Pattern Analysis

- Find a working example of the same pattern in this codebase.
- Read reference implementations completely (no skimming).
- List every difference between working and broken — however small. Don't dismiss "that can't matter".
- Map the dependencies, settings, and assumptions the working example needs.

### Phase 3 — Hypothesis & Testing

- State one specific hypothesis: "I think X is the root cause because Y." Write it down.
- Test minimally — the smallest possible change to confirm or refute.
- One variable at a time. Don't bundle fixes.
- Worked? → Phase 4. Didn't work? → Form a NEW hypothesis. Don't pile fixes on top.
- Don't know? Say so. Don't pretend.

### Phase 4 — Implementation

- Write a failing test that reproduces the bug (use `test-driven-development`).
- Apply ONE fix that addresses the root cause. No "while I'm here" improvements.
- Verify: test passes, no other tests broken, issue actually resolved (use `verification-before-completion`).
- If the fix fails: STOP. Count attempts. <3: return to Phase 1 with the new information. ≥3: question the architecture before any further attempt — repeated failures often signal a wrong design, not a missing fix. Discuss with the human.

## Red Flags — STOP and return to Phase 1

- "Quick fix now, investigate later."
- "Just try changing X and see."
- Multiple changes at once.
- "Skip the test, I'll manually verify."
- "It's probably X."
- Proposing solutions before tracing data flow.
- "One more attempt" after 2+ failures.
- Each new fix surfacing a new problem in a different place — architectural smell.

---

## Moe integration

Trigger this skill when:

- A worker repeatedly fails the same step.
- A task lands in `BLOCKED` for a non-trivial reason.
- A `qa_reject` returns bug-shaped `rejectionDetails` (not "missing test" or "missing doc").
- A worker is reopened (`reopenCount > 0`).

Do not propose a fix in `moe.complete_step` until Phase 1 is complete. If you cannot find the root cause, call `moe.report_blocked` with what you investigated — better than a guessed fix that wastes another QA round-trip.
