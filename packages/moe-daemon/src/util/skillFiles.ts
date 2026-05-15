// =============================================================================
// AUTO-GENERATED — DO NOT EDIT MANUALLY
// Source of truth: docs/skills/**
// Regenerate: npm run generate-skill-files (runs automatically on build)
// =============================================================================

import fs from 'fs';
import path from 'path';
import { atomicWriteText } from './atomicWrite.js';

/**
 * Full content of every SKILL.md (and its SOURCE.md, when vendored), keyed by
 * relative path under .moe/skills/. Auto-generated from docs/skills/.
 */
export const SKILL_FILES: Record<string, string> = {
  'adversarial-self-review/SKILL.md': `---
name: adversarial-self-review
description: Use before calling moe.complete_step on the final step of a task, and again before moe.complete_task. Forces you to read your own diff as an attacker, not an author. Catches concurrency bugs, null-deref, embarrassing assumptions before QA does.
when_to_use: Worker, on the final step of a task, before complete_step or complete_task.
allowed-tools: Read, Grep, Bash(git diff:*), Bash(git log:*)
---

# Adversarial Self-Review

You wrote the code. Now read it like someone who wants to break it.

## The setup

Run \`git diff\` (or \`git diff main...HEAD\` if you've committed). Print the diff. Read it top to bottom *not* as the author who knows what was intended, but as a hostile reviewer who assumes nothing.

## The checklist (run all of them, every time)

Before \`moe.complete_step\` on the final step or \`moe.complete_task\`, walk every item:

### Concurrency
- What happens if this runs twice concurrently? Same user, same request, same record?
- Is there a check-then-act pattern that needs a lock or a transaction?
- Are you mutating shared state (file, cache, in-memory map) without coordination?
- If a status transition: do you need \`SELECT ... FOR UPDATE\` or an equivalent?

### Inputs
- What if the input is null? Empty string? Empty array? Empty object?
- What if it's negative? Zero? \`Infinity\`? \`NaN\`?
- What if it's enormous (1M items, 1GB string, deeply nested)?
- What if it's malformed (wrong type, missing required fields, extra fields)?
- What if it contains injection-shaped chars (\`'\`, \`;\`, \`--\`, \`<script>\`, \`\${\`)?

### Assumptions
- What assumptions am I making about the caller? (Auth? Trusted source? Validated upstream?)
- What assumptions am I making about the environment? (OS? Filesystem? Network? Time zone?)
- What if the file/record I'm reading was deleted between the check and the use? (TOCTOU)
- What if a dependency I'm calling fails / times out / returns partial data?

### Side effects on every exit path
- Do file handles / sockets / listeners / subprocesses get closed on the *error* path, not just success?
- Are partial writes / partial state changes possible if we throw mid-way?
- If we retry, do we double-charge / double-send / double-write?

### Embarrassment test
- If this broke in prod tomorrow and ended up in a postmortem, would I be embarrassed by what I shipped?
- If a senior engineer reviewed this PR cold, what would they ding me for?

## What to do with what you find

For each item that triggers concern:

1. **Real risk?** Fix it now, before \`complete_step\`. A bad fix is better than no fix; an explicit "we'll handle this in follow-up" is better than silence.
2. **Theoretical only?** Note it in the step \`summary\` field on \`complete_step\` so QA knows you considered it.
3. **Genuine unknown?** Pause and ask via \`moe.add_comment\` on the task, or \`moe.report_blocked\` if it changes the design.

## What this catches that tests don't

Tests verify behavior you thought to write. Adversarial review catches behavior you didn't think to write. Concurrency races, null-deref on optional fields, hard-coded category strings instead of the enum that was just added, missing cleanup on error paths — these almost never have a failing test before review, because the author didn't write one. They show up in postmortems instead.

## When to skip

Doc-only changes, single-line config tweaks, trivial typo fixes. For anything touching logic, IO, or state — run the full checklist. It takes three minutes and prevents the kind of bug that costs three days.`,
  'explore-before-assume/SKILL.md': `---
name: explore-before-assume
description: Use before referencing any function, model, method, relationship, constant, or import in a plan or implementation. Verifies things actually exist in the codebase before building on top of them. Eliminates an entire class of hallucinated-API bugs.
when_to_use: Architect during planning before naming symbols in implementationPlan; worker on first start_step before editing unfamiliar code.
allowed-tools: Read, Grep, Glob
---

# Explore Before You Assume

Before referencing a symbol — any symbol — verify it exists. The cheapest bug to prevent is the one you stop yourself from inventing.

## The rule

For every function, class, method, model, attribute, relationship, constant, env var, file path, or import you're about to reference: **grep for it first**. If it doesn't show up, either it doesn't exist or you have the name wrong. Either way, stop and find out before writing a line that depends on it.

## Why this matters

Without this discipline, you will confidently call \`user.clientProfile.accounts\` — a relationship chain that doesn't exist. The code will look right. It will read right. It will fail at runtime, often subtly. Every team that adopts a "verify before you reference" rule eliminates an entire class of bugs immediately.

## The minimum check

For each symbol on your shortlist:

1. **Grep** with \`Grep\` for the name. Look for the *definition*, not just usages.
2. **Read** the file where it's defined. Confirm:
   - It accepts the args you plan to pass.
   - It returns the shape you plan to consume.
   - It's exported / public / reachable from where you'll call it.
3. **Trace one caller** if you're not sure how it's used in practice. Existing call sites are the best documentation.

## When the symbol isn't where you expect

- **Renamed?** Grep for the old name; check \`git log -p --all -S '<oldname>'\` to find the rename.
- **Moved?** Glob for the file by suffix (\`**/User.ts\`, \`**/auth_service.py\`).
- **Removed?** Look at the most recent commit that touched the directory. If it's gone, your plan needs to change — pick the replacement, or \`moe.report_blocked\` if there isn't one.
- **Never existed?** That's the win. Now you know before you've built on top of it.

## Cheap wins that pay back constantly

- For typed languages: read the type signature, not just the function name. Optional vs required, nullable, async vs sync.
- For dynamic languages: read the first 10 lines of the function body. Defaults, early returns, side effects.
- For relationships / ORM: open the model file and confirm the association is declared.
- For env / config: confirm the var is read somewhere and has a default.
- For cross-package imports: confirm the package exports the symbol from its index.

## What to do with what you find

If you're an architect: bake the verified symbol names into the step \`description\` so the worker doesn't re-derive them. If you're a worker: keep your edits scoped to what you've verified — drift creates new unverified symbols, and the cycle starts over.

## When to skip

Trivial doc edits, comment changes, formatting-only steps. If you're not naming a symbol, you don't need to verify one.`,
  'moe-planning/SKILL.md': `---
name: moe-planning
description: Use when an architect is turning a Moe task into an implementation plan via moe.submit_plan. Provides the canonical 8-phase template (plan, explore, tests, minimum impl, verify, document, adversarial review, QA loop) with rules for when to skip phases on trivial tasks.
when_to_use: After moe.get_context returns a PLANNING task, before drafting implementationPlan.steps for moe.submit_plan.
allowed-tools: Read, Grep, Glob, WebFetch
---

# Moe Planning — 8-Phase Plan Template

Your job: turn the task in front of you into an implementation plan that a worker can execute without guessing. Use the 8 phases below as the **default skeleton** for the steps you submit via \`moe.submit_plan\`. Skip phases that genuinely don't apply — but skip *consciously*, not by accident.

## The 8 phases

### Phase 1 — Plan before you touch anything
Read \`task.context\`, \`task.acceptanceCriteria\`, the linked epic rails, and any \`KNOWN_ISSUES.md\`. Build a structured todo list before referencing a single line of code. Size the work: how many files? Cross-cutting? Architectural impact? Use the answer to decide which later phases apply.

### Phase 2 — Explore before you assume
Don't reference a function, model, method, relationship, or constant you haven't grepped for. Hallucinated \`user.clientProfile.accounts\`-style chains are the #1 source of plan-time errors. If the skill \`explore-before-assume\` is available, invoke it now.

### Phase 3 — Plan tests first
For every behavior change, name the test that proves it. Use mutation-resistant assertions: \`assertEquals('completed', $r->status)\` not \`assert($r)\`. Tests that pass when code does nothing are worse than no tests. If the skill \`test-driven-development\` is available, reference it for the worker.

### Phase 4 — Plan the minimum implementation
Each step does one thing. No clever abstractions. No "while we're here." Scope creep is a bug that looks like progress.

### Phase 5 — Plan the regression check
Name the broader test suite the worker will run before \`moe.complete_task\`. If unit tests aren't enough (e.g., integration / smoke), say so explicitly.

### Phase 6 — Plan the documentation
Inline comments only where the *why* is non-obvious. Changelog entry if user-visible. Update \`docs/\` if any contract changes.

### Phase 7 — Plan the adversarial review
Every plan should end with one explicit "self-review" step that runs the checklist:
- What if this runs twice concurrently?
- What if input is null / empty / negative / huge?
- What assumptions am I making that could be wrong?
- Would I be embarrassed if this broke in prod?

### Phase 8 — Plan the QA loop
The worker's job ends at \`moe.complete_task\`. The QA agent reviews and may call \`moe.qa_reject\` with \`rejectionDetails\`. Your plan must hold up under that scrutiny — surface the edge cases and failure modes *in the plan itself* so they don't show up as rejection notes.

## How phases map to plan steps

One step per phase is a fine starting point for non-trivial work. For larger tasks, Phase 4 (minimum implementation) usually expands into multiple steps — one per logical concern. Always:

- Set \`affectedFiles\` tight per step.
- Map every Definition-of-Done item to at least one step.
- State non-obvious design choices in the step \`description\` so the worker doesn't re-derive them.

## When to skip phases

Skip aggressively for genuinely trivial work. A typo fix doesn't need 8 steps.

| Task type | Default skeleton |
|-----------|------------------|
| Doc-only / typo / config tweak | Phases 1, 4, 6 |
| Bug fix, narrow scope, has repro | Phases 1, 3, 4, 5, 7 |
| New feature, single subsystem | Phases 1, 2, 3, 4, 5, 6, 7 |
| Cross-cutting refactor / migration | All 8 phases, multiple steps in 4 |
| Reopened (\`reopenCount > 0\`) | All 8, plus a Phase 0 "address rejectionDetails" step |

## Production concerns to bake in (across all phases)

- Errors: every IO / external call has a real handling path
- Resource cleanup: file handles, sockets, listeners closed on every exit path
- Cross-platform: paths, scripts, line endings (this repo ships on Win/Mac/Linux)
- Security: no command injection, no path traversal, no secrets in logs
- Performance: no obvious O(n²) on growing lists, no synchronous IO in hot loops
- Backwards-compat / migration / feature-flag if risky

## When to bail

If the task conflicts with an existing rail, requires missing prerequisites, or is ambiguous in a way only a human can resolve — call \`moe.report_blocked\` instead of submitting a bad plan.`,
  'moe-qa-loop/SKILL.md': `---
name: moe-qa-loop
description: Use when reviewing a task in REVIEW status as the QA agent. Provides the structured decision flow for moe.qa_approve vs moe.qa_reject, with rejectionDetails that drive a clean fix on the worker side.
when_to_use: QA agent claims a task in REVIEW status; replaces ad-hoc "looks fine to me" reviews.
allowed-tools: Read, Grep, Glob, Bash(git diff:*), Bash(git log:*)
---

# Moe QA Loop

Your job: read the worker's diff and the task's plan, decide if it's done, and either \`moe.qa_approve\` or \`moe.qa_reject\` with actionable details.

## The decision flow

For each task in \`REVIEW\`:

1. **Read \`task.implementationPlan\` and \`task.acceptanceCriteria\`.** Know what was promised.
2. **Read the diff.** \`git diff main...HEAD\` (or against the task's base). Read it adversarially — see the \`adversarial-self-review\` skill for the checklist.
3. **Verify each Definition-of-Done item.** Map every item to evidence in the diff. Missing evidence is a reject.
4. **Spot-check the tests.** Did the worker add tests for the new behavior? Are they mutation-resistant (\`assertEquals('expected', actual)\`, not \`assert(actual)\`)? Are edge cases covered or only the happy path?
5. **Run the regression suite if you can.** If the worker's \`complete_step\` summaries don't include test counts, run the suite yourself.

## Approve when

- Every DoD item has clear evidence in the diff.
- Tests cover the new behavior (happy path + at least one edge case).
- No obvious adversarial-review red flags (concurrency, null-deref, missing cleanup).
- The diff scope matches the plan's scope. No drift, no surprise refactors.

Call \`moe.qa_approve\` with a one-line \`summary\` noting what you verified.

## Reject when

- A DoD item has no corresponding code change.
- Tests are missing or only check the happy path.
- The diff does something the plan didn't promise (scope creep / surprise refactor).
- An adversarial-review red flag is present and ignored.
- A claim made in \`complete_step\` (e.g., "all tests pass") doesn't hold when re-run.

Call \`moe.qa_reject\` with \`rejectionDetails\` that are **specific and actionable**:

> ❌ "Tests are weak."
> ✅ "src/auth/login.ts:42 — \`validateToken\` is tested only with a valid token. Add cases for: expired token, malformed token, missing token, token signed with wrong key."

A good reject:
- Names the file and line.
- Says what's missing or wrong.
- Says what would make it pass — specific enough that the worker doesn't have to guess.

Bad rejects produce ping-pong. Good rejects produce one round-trip.

## What never to do

- **Never move a rejected task to \`BACKLOG\`.** That deprioritizes work the worker is mid-flow on. Use \`moe.qa_reject\` — it routes the task back to \`WORKING\` for the worker to fix.
- **Never approve "with notes."** Either it's done or it's not. If you have notes, reject and let the worker address them.
- **Never re-write the worker's code in your reject message.** Describe the gap, don't fix it for them — they need the practice.

## When you're not sure

If the diff is large or touches an unfamiliar subsystem, before deciding:

- \`Read\` the files the diff touches.
- \`Grep\` for callers of any new public function.
- Check \`task.reopenCount\` — if > 0, look at past \`rejectionDetails\` to see if the same issue is recurring.

If after that you still can't tell — \`moe.add_comment\` on the task asking the worker a specific clarifying question. Don't reject for ambiguity; reject for defect.`,
  'receiving-code-review/SKILL.md': `---
name: receiving-code-review
description: Use when receiving code review feedback, before implementing suggestions, especially if feedback seems unclear or technically questionable - requires technical rigor and verification, not performative agreement or blind implementation
---

# Receiving Code Review

Code review requires technical evaluation, not emotional performance. **Verify before implementing. Ask before assuming. Technical correctness over social comfort.**

## Response pattern

1. **Read** the complete feedback without reacting.
2. **Understand** by restating the requirement in your own words (or asking).
3. **Verify** against codebase reality — open the file, grep for usage.
4. **Evaluate** — technically sound for THIS codebase?
5. **Respond** with technical acknowledgment or reasoned pushback.
6. **Implement** one item at a time, test each.

## Forbidden phrases

NEVER write:
- "You're absolutely right!" / "Great point!" / "Excellent feedback!" / "Thanks for catching that!"
- "Let me implement that now" before verification
- Any gratitude expression

INSTEAD: restate the requirement, ask clarifying questions, push back with technical reasoning, or just start working. Actions > words. If you catch yourself typing "Thanks", delete it.

## Unclear items — STOP

If any item is unclear, do NOT implement anything yet. Ask for clarification on the unclear items first. Items may be related; partial understanding produces wrong implementations.

Wrong: "I'll implement 1,2,3,6 now and ask about 4,5 later."
Right: "I understand 1,2,3,6. Need clarification on 4 and 5 before proceeding."

## When to push back

Push back when:
- Suggestion breaks existing functionality.
- Reviewer lacks full context.
- Violates YAGNI (suggestion targets unused feature).
- Technically incorrect for this stack.
- Legacy/compatibility reasons exist.
- Conflicts with prior architectural decisions.

How: technical reasoning, not defensiveness. Ask specific questions. Reference working tests/code.

## YAGNI check

If a reviewer says "implement properly", grep the codebase for actual usage. If unused, push: "This isn't called. Remove it (YAGNI)?" If used, then implement properly.

## Implementation order

For multi-item feedback:
1. Clarify everything unclear FIRST.
2. Then implement: blocking issues (breaks, security) → simple fixes (typos, imports) → complex fixes (refactoring, logic).
3. Test each fix individually. Verify no regressions.

## Acknowledging correct feedback

State the fix factually:
- "Fixed. [Brief description]."
- "Good catch — [specific issue]. Fixed in [location]."
- Or just fix it and let the code show you heard.

No gratitude. No performative agreement.

## Correcting your own pushback

If you pushed back and were wrong: "You were right — I checked X and it does Y. Implementing now." No long apology, no defending, no over-explaining.

---

## Moe integration

This skill loads when \`nextAction.recommendedSkill = receiving-code-review\` — typically after \`moe.qa_reject\` (task is back in WORKING with \`reopenCount > 0\` and \`rejectionDetails\` populated).

When you receive a QA rejection:

1. **Read all of \`rejectionDetails\` first.** Don't start fixing until you understand every item.
2. **Verify each item against the diff.** If QA points at a file/line, open it and read for yourself.
3. **If an item seems wrong**, push back via \`moe.add_comment\` on the task channel with technical reasoning. Don't silently ignore; don't silently implement.
4. **Implement in priority order** (security/correctness > simple fixes > refactoring). Use one \`moe.start_step\` per item — don't batch unrelated fixes.
5. **After fixes, run regression-check** and put actual results in your \`moe.complete_task\` summary.

Never include performative gratitude in \`moe.add_comment\`. State what you changed.`,
  'receiving-code-review/SOURCE.md': `# Source

Vendored from [\`obra/superpowers\`](https://github.com/obra/superpowers).

- Upstream path: \`skills/receiving-code-review/SKILL.md\`
- Upstream commit: \`b55764852ac78870e65c6565fb585b6cd8b3c5c9\`
- License: MIT (see \`../LICENSE-VENDORED.md\`)

## Local modifications

- Removed personalised "your human partner" / CLAUDE.md framing — generalised to "trusted human reviewer".
- Removed "Strange things are afoot at the Circle K" signal phrase (private convention).
- Removed the GitHub Thread Replies section (Moe's review channel is \`moe.add_comment\`, not GitHub PR threads — captured in the integration footer).
- Appended \`## Moe integration\` footer wiring the skill to \`moe.qa_reject\` recovery, \`rejectionDetails\`, and the \`regression-check\` follow-up.`,
  'regression-check/SKILL.md': `---
name: regression-check
description: Use before moe.complete_task. Runs the broader test suite (not just the tests you added) to confirm nothing unrelated broke. The goal is zero regressions. Better to find out now than in a QA reject comment.
when_to_use: Worker, after the final implementation step is done, before moe.complete_task.
allowed-tools: Bash, Read
---

# Regression Check

Before \`moe.complete_task\`, run the broader suite. The goal is zero regressions. Finding out now is cheap; finding out from a \`qa_reject\` is expensive.

## What to run

The plan should name the suite. If it doesn't, work out from your changes:

| Touched | Run at minimum |
|---------|----------------|
| \`packages/moe-daemon/src/...\` | \`cd packages/moe-daemon && npm test\` |
| \`packages/moe-proxy/src/...\` | \`cd packages/moe-proxy && npm test\` |
| \`moe-jetbrains/src/...\` | \`cd moe-jetbrains && ./gradlew test\` |
| Multi-package or shared types | All of the above |
| Scripts / wrappers | Manually exercise the wrapper end-to-end |
| Docs only | Optional; lint the markdown |

If a project has a \`test:all\` or \`npm run check\` script, prefer that — it usually wires lint + type-check + tests in the right order.

## How to read the output

- **All green?** Capture the test count + pass count in your \`complete_step\` summary as evidence. Don't claim green without numbers.
- **Failures in tests you didn't touch?** That's a regression. Investigate before \`complete_task\`. Usual suspects: shared util change, type-signature change, fixture / seed dependency, test ordering.
- **Failures in tests you did touch?** Either the test is wrong or the code is wrong. Fix one.
- **Flake?** Run it again. If it's still red on the second run, it's not flake, it's a bug.

## What "broader" means

It's tempting to run only the tests in the package you edited. Don't. Cross-package dependencies are exactly where regressions hide. Specifically:

- Type changes in \`schema.ts\` ripple through every tool and the plugin.
- Migrations affect \`load()\` for every existing \`.moe/\`.
- Wire-protocol changes (new fields in WebSocket / MCP messages) need both ends tested.

## When to skip

- Doc-only changes (formatter / spell-check is enough).
- Pure addition of a new file that nothing imports yet.

For everything else, run it. The 90 seconds you save by skipping is the 4 hours you spend on a \`qa_reject\` round trip.

## What to put in the complete_step / complete_task summary

Be specific. Not "tests pass" — "342 / 342 tests pass; ran \`npm test\` in moe-daemon and moe-proxy; type-check clean." Numbers + commands let QA verify quickly without re-running everything.`,
  'systematic-debugging/SKILL.md': `---
name: systematic-debugging
description: Use when encountering any bug, test failure, or unexpected behavior, before proposing fixes
---

# Systematic Debugging

## The Iron Law

\`\`\`
NO FIXES WITHOUT ROOT CAUSE INVESTIGATION FIRST
\`\`\`

Symptom fixes mask underlying issues and create new bugs. If you haven't completed Phase 1, you cannot propose a fix.

## When To Use

Any bug, test failure, build break, integration issue, or unexpected behaviour. Especially under time pressure — systematic is faster than guess-and-check thrashing.

## The Four Phases

Complete each phase before the next. No skipping.

### Phase 1 — Root Cause Investigation

- Read every error message and stack trace fully. Note line numbers, file paths, error codes.
- Reproduce consistently. Document exact steps. If you can't reproduce, gather more data — don't guess.
- Check recent changes: \`git diff\`, recent commits, new dependencies, config changes, environmental differences.
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

- Write a failing test that reproduces the bug (use \`test-driven-development\`).
- Apply ONE fix that addresses the root cause. No "while I'm here" improvements.
- Verify: test passes, no other tests broken, issue actually resolved (use \`verification-before-completion\`).
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
- A task lands in \`BLOCKED\` for a non-trivial reason.
- A \`qa_reject\` returns bug-shaped \`rejectionDetails\` (not "missing test" or "missing doc").
- A worker is reopened (\`reopenCount > 0\`).

Do not propose a fix in \`moe.complete_step\` until Phase 1 is complete. If you cannot find the root cause, call \`moe.report_blocked\` with what you investigated — better than a guessed fix that wastes another QA round-trip.`,
  'systematic-debugging/SOURCE.md': `# Source

Vendored from [\`obra/superpowers\`](https://github.com/obra/superpowers).

- Upstream path: \`skills/systematic-debugging/SKILL.md\`
- Upstream commit: \`b55764852ac78870e65c6565fb585b6cd8b3c5c9\`
- License: MIT (see \`../LICENSE-VENDORED.md\`)

## Local modifications

- Removed the multi-layer codesign example (Apple-specific, distracting in this repo) — kept the abstract instruction.
- Replaced the \`superpowers:test-driven-development\` cross-reference with \`test-driven-development\` (matches our local skill name).
- Removed the "your human partner's Signals You're Doing It Wrong" section (referenced personalised quotes that are out of place here).
- Removed the Supporting Techniques section (the linked sibling files like \`root-cause-tracing.md\` are not vendored).
- Appended \`## Moe integration\` footer wiring the skill to \`moe.set_task_status BLOCKED\`, \`moe.report_blocked\`, and the \`qa_reject\` recovery path.`,
  'test-driven-development/SKILL.md': `---
name: test-driven-development
description: Use when implementing any feature or bugfix, before writing implementation code
---

# Test-Driven Development (TDD)

## The Iron Law

\`\`\`
NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST
\`\`\`

If you wrote code first, delete it and start over. Don't keep it as "reference" — you'll adapt it, which is testing-after, which is not TDD.

## Red-Green-Refactor

### RED — Write a failing test
- One behaviour, clear name (no "and"), real code (mocks only when unavoidable).
- Assert specific values, not truthiness. Mutation-resistant: if a one-character change to production code wouldn't fail a test, the test isn't testing.
  - Bad: \`assert(result)\`, \`expect(items).toBeTruthy()\`, \`expect(fn).not.toThrow()\`
  - Good: \`expect(result.status).toBe('completed')\`, \`expect(items).toEqual(['a','b','c'])\`

### Verify RED — watch it fail (mandatory)
Run the test. Confirm: it fails (not errors), the failure message matches what you expect, it fails because the feature is missing (not a typo).

If it passes, you're testing existing behaviour — fix the test. If it errors, fix the error and re-run until it fails for the right reason.

### GREEN — minimal code
Simplest code that passes. No options bag, no extra branches, no "while I'm here" cleanup.

### Verify GREEN — watch it pass (mandatory)
Test passes, other tests still pass, output pristine. If a test fails: fix the code, not the test.

### REFACTOR — clean up while green
Remove duplication, improve names, extract helpers. No new behaviour. Tests stay green.

## When To Use

Always: new features, bug fixes, refactors, behaviour changes. Exceptions (ask first): throwaway prototypes, generated code, config files. "Just this once" is rationalization.

## Bug-fix Pattern

Bug found → write a failing test that reproduces it → run → see it fail → fix → run → see it pass. Never fix a bug without a test.

## Verification Checklist

- [ ] Every new function/method has a test.
- [ ] Watched each test fail before implementing.
- [ ] Each test failed for the expected reason.
- [ ] Wrote minimal code to pass.
- [ ] All tests pass and output is pristine.
- [ ] Edge cases and errors covered.

If you can't tick all boxes, you skipped TDD — start over.

## When Stuck

| Problem | Move |
|---|---|
| Don't know how to test | Write the wished-for API as the test, then build to it. |
| Test too complicated | Design too complicated — simplify the interface. |
| Need to mock everything | Code too coupled — use dependency injection. |
| Test setup huge | Extract helpers; if still huge, simplify the design. |

---

## Moe integration

- Apply this discipline within each \`moe.start_step\` → implement → \`moe.complete_step\` cycle on test-touching steps.
- The architect should plan the failing test as a separate step before the implementation step (see \`moe-planning\` Phase 3).
- Before \`moe.complete_task\`, pair with \`verification-before-completion\` — capture the actual test-run output (count + pass/fail) in your \`complete_step\` summary so QA has evidence rather than a claim.`,
  'test-driven-development/SOURCE.md': `# Source

Vendored from [\`obra/superpowers\`](https://github.com/obra/superpowers).

- Upstream path: \`skills/test-driven-development/SKILL.md\`
- Upstream commit: \`b55764852ac78870e65c6565fb585b6cd8b3c5c9\`
- License: MIT (see \`../LICENSE-VENDORED.md\`)

## Local modifications

- Added \`## Mutation-Resistant Assertions\` section in the body to align with Moe's adversarial-review discipline (assert specific values, not truthiness).
- Removed the \`## Testing Anti-Patterns\` reference (linked to a sibling file not vendored).
- Appended \`## Moe integration\` footer pointing to \`moe.start_step\` / \`moe.complete_step\` flow and the \`verification-before-completion\` skill.`,
  'using-git-worktrees/SKILL.md': `---
name: using-git-worktrees
description: Use when starting feature work that needs isolation from current workspace or before executing implementation plans - creates isolated git worktrees with smart directory selection and safety verification
---

# Using Git Worktrees

## Overview

Git worktrees create isolated workspaces sharing the same repository, allowing work on multiple branches simultaneously without switching.

**Core principle:** Systematic directory selection + safety verification = reliable isolation.

**Announce at start:** "I'm using the using-git-worktrees skill to set up an isolated workspace."

## Directory Selection Process

Follow this priority order:

### 1. Check Existing Directories

\`\`\`bash
# Check in priority order
ls -d .worktrees 2>/dev/null     # Preferred (hidden)
ls -d worktrees 2>/dev/null      # Alternative
\`\`\`

**If found:** Use that directory. If both exist, \`.worktrees\` wins.

### 2. Check CLAUDE.md

\`\`\`bash
grep -i "worktree.*director" CLAUDE.md 2>/dev/null
\`\`\`

**If preference specified:** Use it without asking.

### 3. Ask User

If no directory exists and no CLAUDE.md preference:

\`\`\`
No worktree directory found. Where should I create worktrees?

1. .worktrees/ (project-local, hidden)
2. ~/.config/moe/worktrees/<project-name>/ (global location)

Which would you prefer?
\`\`\`

## Safety Verification

### For Project-Local Directories (.worktrees or worktrees)

**MUST verify directory is ignored before creating worktree:**

\`\`\`bash
# Check if directory is ignored (respects local, global, and system gitignore)
git check-ignore -q .worktrees 2>/dev/null || git check-ignore -q worktrees 2>/dev/null
\`\`\`

**If NOT ignored:**

1. Add appropriate line to .gitignore
2. Commit the change
3. Proceed with worktree creation

**Why critical:** Prevents accidentally committing worktree contents to repository.

### For Global Directory

No .gitignore verification needed - outside project entirely.

## Creation Steps

### 1. Detect Project Name

\`\`\`bash
project=$(basename "$(git rev-parse --show-toplevel)")
\`\`\`

### 2. Create Worktree

\`\`\`bash
# Determine full path
case $LOCATION in
  .worktrees|worktrees)
    path="$LOCATION/$BRANCH_NAME"
    ;;
  ~/.config/moe/worktrees/*)
    path="~/.config/moe/worktrees/$project/$BRANCH_NAME"
    ;;
esac

# Create worktree with new branch
git worktree add "$path" -b "$BRANCH_NAME"
cd "$path"
\`\`\`

### 3. Run Project Setup

Auto-detect and run appropriate setup:

\`\`\`bash
# Node.js
if [ -f package.json ]; then npm install; fi

# Rust
if [ -f Cargo.toml ]; then cargo build; fi

# Python
if [ -f requirements.txt ]; then pip install -r requirements.txt; fi
if [ -f pyproject.toml ]; then poetry install; fi

# Go
if [ -f go.mod ]; then go mod download; fi
\`\`\`

### 4. Verify Clean Baseline

Run tests to ensure worktree starts clean:

\`\`\`bash
# Examples - use project-appropriate command
npm test
cargo test
pytest
go test ./...
\`\`\`

**If tests fail:** Report failures, ask whether to proceed or investigate.

**If tests pass:** Report ready.

### 5. Report Location

\`\`\`
Worktree ready at <full-path>
Tests passing (<N> tests, 0 failures)
Ready to implement <feature-name>
\`\`\`

## Quick Reference

| Situation | Action |
|-----------|--------|
| \`.worktrees/\` exists | Use it (verify ignored) |
| \`worktrees/\` exists | Use it (verify ignored) |
| Both exist | Use \`.worktrees/\` |
| Neither exists | Check CLAUDE.md → Ask user |
| Directory not ignored | Add to .gitignore + commit |
| Tests fail during baseline | Report failures + ask |
| No package.json/Cargo.toml | Skip dependency install |

## Common Mistakes

### Skipping ignore verification

- **Problem:** Worktree contents get tracked, pollute git status
- **Fix:** Always use \`git check-ignore\` before creating project-local worktree

### Assuming directory location

- **Problem:** Creates inconsistency, violates project conventions
- **Fix:** Follow priority: existing > CLAUDE.md > ask

### Proceeding with failing tests

- **Problem:** Can't distinguish new bugs from pre-existing issues
- **Fix:** Report failures, get explicit permission to proceed

### Hardcoding setup commands

- **Problem:** Breaks on projects using different tools
- **Fix:** Auto-detect from project files (package.json, etc.)

## Red Flags

**Never:**
- Create worktree without verifying it's ignored (project-local)
- Skip baseline test verification
- Proceed with failing tests without asking
- Assume directory location when ambiguous
- Skip CLAUDE.md check

**Always:**
- Follow directory priority: existing > CLAUDE.md > ask
- Verify directory is ignored for project-local
- Auto-detect and run project setup
- Verify clean test baseline

---

## Moe integration

Recommended whenever multiple workers are claiming Moe tasks against the same repository, or when one worker's task touches files another worker is editing.

In Moe specifically:

- **Branch naming:** Use the project's \`branchPattern\` from \`project.settings\` (default \`moe/{epicId}/{taskId}\`). The wrapper pre-flight already creates a branch by this convention; if you're entering a worktree, use the same name so QA can find your work.
- **Don't worktree the \`.moe/\` folder.** The daemon owns \`.moe/\` for the project root — workers in worktrees still talk to the same daemon over the same \`daemon.json\`. Operate on the worktree's source tree, not on a duplicate \`.moe/\`.
- **After completion:** the wrapper post-flight handles commits + branch cleanup. If you created an extra worktree manually, clean it up with \`git worktree remove <path>\`.`,
  'using-git-worktrees/SOURCE.md': `# Source

Vendored from [\`obra/superpowers\`](https://github.com/obra/superpowers).

- Upstream path: \`skills/using-git-worktrees/SKILL.md\`
- Upstream commit: \`b55764852ac78870e65c6565fb585b6cd8b3c5c9\`
- License: MIT (see \`../LICENSE-VENDORED.md\`)

## Local modifications

- Renamed global worktree path from \`~/.config/superpowers/worktrees/...\` to \`~/.config/moe/worktrees/...\`.
- Removed the Integration / Pairs With section (referenced sibling skills not vendored: \`brainstorming → Phase 4\`, \`subagent-driven-development\`, \`executing-plans\`, \`finishing-a-development-branch\`).
- Removed the Example Workflow section (replaced by Moe-flavoured guidance in the integration footer).
- Removed Jesse-specific quote attributions ("Per Jesse's rule…").
- Appended \`## Moe integration\` footer covering branch naming, the \`.moe/\` folder relationship, and post-flight cleanup.`,
  'verification-before-completion/SKILL.md': `---
name: verification-before-completion
description: Use when about to claim work is complete, fixed, or passing, before committing or creating PRs - requires running verification commands and confirming output before making any success claims; evidence before assertions always
---

# Verification Before Completion

## Overview

Claiming work is complete without verification is dishonesty, not efficiency.

**Core principle:** Evidence before claims, always.

**Violating the letter of this rule is violating the spirit of this rule.**

## The Iron Law

\`\`\`
NO COMPLETION CLAIMS WITHOUT FRESH VERIFICATION EVIDENCE
\`\`\`

If you haven't run the verification command in this message, you cannot claim it passes.

## The Gate Function

\`\`\`
BEFORE claiming any status or expressing satisfaction:

1. IDENTIFY: What command proves this claim?
2. RUN: Execute the FULL command (fresh, complete)
3. READ: Full output, check exit code, count failures
4. VERIFY: Does output confirm the claim?
   - If NO: State actual status with evidence
   - If YES: State claim WITH evidence
5. ONLY THEN: Make the claim

Skip any step = lying, not verifying
\`\`\`

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

## Red Flags - STOP

- Using "should", "probably", "seems to"
- Expressing satisfaction before verification ("Great!", "Perfect!", "Done!", etc.)
- About to commit/push/PR without verification
- Trusting agent success reports
- Relying on partial verification
- Thinking "just this once"
- Tired and wanting work over
- **ANY wording implying success without having run verification**

## Rationalization Prevention

| Excuse | Reality |
|--------|---------|
| "Should work now" | RUN the verification |
| "I'm confident" | Confidence ≠ evidence |
| "Just this once" | No exceptions |
| "Linter passed" | Linter ≠ compiler |
| "Agent said success" | Verify independently |
| "I'm tired" | Exhaustion ≠ excuse |
| "Partial check is enough" | Partial proves nothing |
| "Different words so rule doesn't apply" | Spirit over letter |

## Key Patterns

**Tests:**
\`\`\`
✅ [Run test command] [See: 34/34 pass] "All tests pass"
❌ "Should pass now" / "Looks correct"
\`\`\`

**Regression tests (TDD Red-Green):**
\`\`\`
✅ Write → Run (pass) → Revert fix → Run (MUST FAIL) → Restore → Run (pass)
❌ "I've written a regression test" (without red-green verification)
\`\`\`

**Build:**
\`\`\`
✅ [Run build] [See: exit 0] "Build passes"
❌ "Linter passed" (linter doesn't check compilation)
\`\`\`

**Requirements:**
\`\`\`
✅ Re-read plan → Create checklist → Verify each → Report gaps or completion
❌ "Tests pass, phase complete"
\`\`\`

**Agent delegation:**
\`\`\`
✅ Agent reports success → Check VCS diff → Verify changes → Report actual state
❌ Trust agent report
\`\`\`

## Why This Matters

From 24 failure memories:
- Trust gets broken when claims don't match reality.
- Undefined functions ship and crash in prod.
- Missing requirements ship as incomplete features.
- Time wasted on false completion → redirect → rework.
- Honesty is a core value. Performative completion is dishonesty.

## When To Apply

**ALWAYS before:**
- ANY variation of success/completion claims
- ANY expression of satisfaction
- ANY positive statement about work state
- Committing, PR creation, task completion
- Moving to next task
- Delegating to agents

**Rule applies to:**
- Exact phrases
- Paraphrases and synonyms
- Implications of success
- ANY communication suggesting completion/correctness

## The Bottom Line

**No shortcuts for verification.**

Run the command. Read the output. THEN claim the result.

This is non-negotiable.

---

## Moe integration

This skill is the gate before \`moe.complete_step\` (final step) and \`moe.complete_task\`. Before either:

1. Identify the verification command for the step's \`affectedFiles\` (\`npm test\` for daemon/proxy, \`./gradlew test\` for the JetBrains plugin, etc. — see the \`regression-check\` skill).
2. Run it fresh in this turn.
3. Capture the actual output (test count + pass count, exit code) in the \`summary\` field on \`moe.complete_step\` / \`moe.complete_task\`.

QA reviews the summary. A summary that says "all tests pass" with no numbers is a \`qa_reject\` waiting to happen — for good reason. Pair this skill with \`regression-check\` for what to run, and \`adversarial-self-review\` for what else to look at before claiming done.`,
  'verification-before-completion/SOURCE.md': `# Source

Vendored from [\`obra/superpowers\`](https://github.com/obra/superpowers).

- Upstream path: \`skills/verification-before-completion/SKILL.md\`
- Upstream commit: \`b55764852ac78870e65c6565fb585b6cd8b3c5c9\`
- License: MIT (see \`../LICENSE-VENDORED.md\`)

## Local modifications

- Removed two upstream phrases that referenced specific personal-history quotes ("I don't believe you", "you'll be replaced") — the principle stands without the specifics.
- Appended \`## Moe integration\` footer wiring the skill to \`moe.complete_step\` / \`moe.complete_task\` and pointing at sibling skills (\`regression-check\`, \`adversarial-self-review\`).`,
  'writing-plans/SKILL.md': `---
name: writing-plans
description: Use when you have a spec or requirements for a multi-step task, before touching code
---

# Writing Plans

Write plans assuming the engineer has zero context for our codebase. Document everything they need: which files to touch, code blocks per step, exact commands with expected output, what to test.

DRY. YAGNI. TDD. Frequent commits.

## Scope check

If the spec covers multiple independent subsystems, suggest breaking it into one plan per subsystem. Each plan should produce working, testable software on its own.

## File structure

Before defining tasks, map files: which created, which modified, what each is responsible for. Smaller focused files over large ones. Files that change together live together. Follow existing codebase patterns — don't unilaterally restructure.

## Bite-sized tasks

Each step is one action (2-5 minutes):
- Write the failing test
- Run it to confirm it fails
- Write minimal code to pass
- Run again to confirm it passes
- Commit

## Plan header (every plan)

\`\`\`markdown
# [Feature Name] Implementation Plan
**Goal:** [one sentence]
**Architecture:** [2-3 sentences]
**Tech Stack:** [key technologies]
---
\`\`\`

## Task structure

\`\`\`markdown
### Task N: [Component Name]
**Files:**
- Create: \`exact/path/to/file.py\`
- Modify: \`exact/path/existing.py:123-145\`
- Test: \`tests/exact/path/test.py\`

- [ ] Step 1: Write the failing test
  \`\`\`python
  def test_specific_behavior(): ...
  \`\`\`
- [ ] Step 2: Run test, expect FAIL with "<reason>"
- [ ] Step 3: Write minimal implementation (code block)
- [ ] Step 4: Run test, expect PASS
- [ ] Step 5: Commit (exact \`git add\` + commit message)
\`\`\`

## No placeholders

These are plan failures — never write them:
- "TBD", "TODO", "implement later", "fill in details"
- "Add appropriate error handling" / "handle edge cases"
- "Write tests for the above" with no actual test code
- "Similar to Task N" — repeat the code; the engineer may read tasks out of order
- Steps that say what without showing how (code blocks required for code steps)

Every step contains the actual content the engineer needs.

## Self-review

After writing, re-read the spec with fresh eyes:
1. **Coverage:** every requirement maps to a task? List gaps.
2. **Placeholder scan:** any of the failure patterns above? Fix them.
3. **Type consistency:** types and method names match across tasks? \`clearLayers()\` in Task 3 vs \`clearFullLayers()\` in Task 7 is a bug.

Fix issues inline. No re-review pass.

---

## Moe integration

In Moe, the architect's plan becomes \`implementationPlan.steps\` via \`moe.submit_plan\`. Each step in this skill maps to one Moe step:
- **Title** → step \`title\`
- **Files** + **code blocks** → step \`description\` (paste code so the worker doesn't re-derive it)
- **Test files** → step \`affectedFiles\`
- **Run commands** → in \`description\` ("Run X, expect Y")

Use \`moe-planning\` for the higher-level 8-phase template; use this skill for inside-the-step granularity.`,
  'writing-plans/SOURCE.md': `# Source

Vendored from [\`obra/superpowers\`](https://github.com/obra/superpowers).

- Upstream path: \`skills/writing-plans/SKILL.md\`
- Upstream commit: \`b55764852ac78870e65c6565fb585b6cd8b3c5c9\`
- License: MIT (see \`../LICENSE-VENDORED.md\`)

## Local modifications

- Removed the \`superpowers:subagent-driven-development\` / \`superpowers:executing-plans\` execution-handoff section (those are upstream-specific orchestration mechanisms; in Moe the daemon drives execution via \`moe.start_step\` / \`moe.complete_step\`).
- Removed the "Save plans to: docs/superpowers/plans/..." line (Moe's plans live in \`task.implementationPlan\`, not on disk).
- Appended \`## Moe integration\` footer mapping plan structure to \`moe.submit_plan\` step fields and pointing at the Moe-native \`moe-planning\` skill as the higher-level entry point.`
};

/**
 * Content for .moe/skills/manifest.json, auto-generated from
 * docs/skills/manifest.json. Used by the agent wrapper to inject a
 * lean "Available Skills" section into the system prompt.
 */
export const SKILL_MANIFEST = `{
  "version": 1,
  "skills": [
    {
      "name": "moe-planning",
      "description": "8-phase plan template for moe.submit_plan (plan → explore → tests → minimum impl → verify → document → adversarial review → QA loop), with skip rules for trivial work.",
      "role": "architect",
      "triggeredBy": ["moe.get_context (PLANNING)", "before moe.submit_plan"]
    },
    {
      "name": "explore-before-assume",
      "description": "Verify every symbol (function, model, attribute, constant) actually exists before referencing it. Eliminates hallucinated-API bugs.",
      "role": "architect|worker",
      "triggeredBy": ["architect during planning", "worker on first start_step in unfamiliar code"]
    },
    {
      "name": "writing-plans",
      "description": "Vendored from superpowers. Multi-step plan structure with checkpoints; output format aligns with moe.submit_plan step lists.",
      "role": "architect",
      "triggeredBy": ["before moe.submit_plan"]
    },
    {
      "name": "test-driven-development",
      "description": "Vendored from superpowers. RED-GREEN-REFACTOR with mutation-resistant assertions (assertEquals, not assert).",
      "role": "worker",
      "triggeredBy": ["start_step on test-touching steps"]
    },
    {
      "name": "verification-before-completion",
      "description": "Vendored from superpowers. Forces running verification commands and confirming output before any complete claim. Evidence before assertions.",
      "role": "worker",
      "triggeredBy": ["before moe.complete_task"]
    },
    {
      "name": "systematic-debugging",
      "description": "Vendored from superpowers. 4-phase root-cause method (root-cause-tracing, defense-in-depth, condition-based-waiting). Use on bugs and test failures, before proposing fixes.",
      "role": "worker",
      "triggeredBy": ["set_task_status BLOCKED", "repeated step failure", "qa_reject for a bug"]
    },
    {
      "name": "adversarial-self-review",
      "description": "Read your own diff as an attacker, not an author. Concurrency / null / embarrassment checklist before final complete_step or complete_task.",
      "role": "worker",
      "triggeredBy": ["final step before complete_step", "before complete_task"]
    },
    {
      "name": "regression-check",
      "description": "Run the broader test suite (not just new tests) before complete_task. Goal: zero regressions, evidence-based summary.",
      "role": "worker",
      "triggeredBy": ["before complete_task"]
    },
    {
      "name": "receiving-code-review",
      "description": "Vendored from superpowers. Adversarial response to QA feedback — verify, don't capitulate; don't perform agreement.",
      "role": "worker",
      "triggeredBy": ["after moe.qa_reject (reopenCount > 0)"]
    },
    {
      "name": "moe-qa-loop",
      "description": "Structured QA review flow: read plan + diff, verify DoD coverage, decide qa_approve vs qa_reject with actionable rejectionDetails.",
      "role": "qa",
      "triggeredBy": ["claim a task in REVIEW status"]
    },
    {
      "name": "using-git-worktrees",
      "description": "Vendored from superpowers. Isolated workspace per feature so parallel workers don't step on each other's .moe/ state.",
      "role": "architect|worker",
      "triggeredBy": ["manual invoke"]
    }
  ]
}`;

/**
 * Content for .moe/skills/LICENSE-VENDORED.md, auto-generated from
 * docs/skills/LICENSE-VENDORED.md. Records attribution for vendored skills.
 */
export const SKILL_LICENSE = `# Vendored Skill Attribution

This directory contains skills adapted from upstream open-source projects. Each vendored skill keeps its original content largely intact, with a small \`## Moe integration\` section appended at the bottom (and, in some cases, light vocabulary adjustments to reference Moe's MCP tools).

## Sources

### \`obra/superpowers\` — MIT License

The following skills are vendored from [obra/superpowers](https://github.com/obra/superpowers) at commit [\`b55764852ac78870e65c6565fb585b6cd8b3c5c9\`](https://github.com/obra/superpowers/commit/b55764852ac78870e65c6565fb585b6cd8b3c5c9):

- \`receiving-code-review/\`
- \`systematic-debugging/\`
- \`test-driven-development/\`
- \`using-git-worktrees/\`
- \`verification-before-completion/\`
- \`writing-plans/\`

Each vendored skill has a \`SOURCE.md\` next to its \`SKILL.md\` recording the upstream path, commit, and any local modifications.

#### Upstream license

\`\`\`
MIT License

Copyright (c) 2025 Jesse Vincent

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
\`\`\`

## Moe-native skills (no vendoring)

The following skills were authored fresh for Moe and are licensed under the project's main license:

- \`moe-planning/\`
- \`explore-before-assume/\`
- \`adversarial-self-review/\`
- \`regression-check/\`
- \`moe-qa-loop/\``;

/**
 * Writes the curated skill pack into an existing .moe directory.
 * Skips files that already exist (idempotent — safe to backfill onto
 * existing projects).
 */
export function writeSkillFiles(moePath: string): void {
  const skillsDir = path.join(moePath, 'skills');
  if (!fs.existsSync(skillsDir)) {
    fs.mkdirSync(skillsDir, { recursive: true });
  }

  // Write each skill file (SKILL.md + SOURCE.md per skill directory).
  for (const [relPath, content] of Object.entries(SKILL_FILES)) {
    const fullPath = path.join(skillsDir, relPath);
    const parent = path.dirname(fullPath);
    if (!fs.existsSync(parent)) {
      fs.mkdirSync(parent, { recursive: true });
    }
    if (!fs.existsSync(fullPath)) {
      atomicWriteText(fullPath, content);
    }
  }

  // Write manifest (skip if already exists — user may have customized).
  const manifestPath = path.join(skillsDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    atomicWriteText(manifestPath, SKILL_MANIFEST);
  }

  // Write attribution.
  const licensePath = path.join(skillsDir, 'LICENSE-VENDORED.md');
  if (!fs.existsSync(licensePath) && SKILL_LICENSE) {
    atomicWriteText(licensePath, SKILL_LICENSE);
  }
}
