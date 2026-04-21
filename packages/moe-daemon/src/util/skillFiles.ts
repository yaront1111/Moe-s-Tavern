// =============================================================================
// AUTO-GENERATED — DO NOT EDIT MANUALLY
// Source of truth: docs/skills/**
// Regenerate: npm run generate-skill-files (runs automatically on build)
// =============================================================================

import fs from 'fs';
import path from 'path';

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
  'brainstorming/SKILL.md': `---
name: brainstorming
description: "You MUST use this before any creative work - creating features, building components, adding functionality, or modifying behavior. Explores user intent, requirements and design before implementation."
---

# Brainstorming Ideas Into Designs

Help turn ideas into fully formed designs and specs through natural collaborative dialogue.

Start by understanding the current project context, then ask questions one at a time to refine the idea. Once you understand what you're building, present the design and get user approval.

<HARD-GATE>
Do NOT invoke any implementation skill, write any code, scaffold any project, or take any implementation action until you have presented a design and the user has approved it. This applies to EVERY project regardless of perceived simplicity.
</HARD-GATE>

## Anti-Pattern: "This Is Too Simple To Need A Design"

Every project goes through this process. A todo list, a single-function utility, a config change — all of them. "Simple" projects are where unexamined assumptions cause the most wasted work. The design can be short (a few sentences for truly simple projects), but you MUST present it and get approval.

## Checklist

You MUST work through these items in order:

1. **Explore project context** — check files, docs, recent commits
2. **Ask clarifying questions** — one at a time, understand purpose/constraints/success criteria
3. **Propose 2-3 approaches** — with trade-offs and your recommendation
4. **Present design** — in sections scaled to their complexity, get user approval after each section
5. **Write design doc** — save it (see Moe integration below for path)
6. **Spec self-review** — quick inline check for placeholders, contradictions, ambiguity, scope (see below)
7. **User reviews written spec** — ask user to review the spec file before proceeding
8. **Transition to implementation** — invoke writing-plans skill to create implementation plan

## Process Flow

\`\`\`dot
digraph brainstorming {
    "Explore project context" [shape=box];
    "Ask clarifying questions" [shape=box];
    "Propose 2-3 approaches" [shape=box];
    "Present design sections" [shape=box];
    "User approves design?" [shape=diamond];
    "Write design doc" [shape=box];
    "Spec self-review\\n(fix inline)" [shape=box];
    "User reviews spec?" [shape=diamond];
    "Invoke writing-plans skill" [shape=doublecircle];

    "Explore project context" -> "Ask clarifying questions";
    "Ask clarifying questions" -> "Propose 2-3 approaches";
    "Propose 2-3 approaches" -> "Present design sections";
    "Present design sections" -> "User approves design?";
    "User approves design?" -> "Present design sections" [label="no, revise"];
    "User approves design?" -> "Write design doc" [label="yes"];
    "Write design doc" -> "Spec self-review\\n(fix inline)";
    "Spec self-review\\n(fix inline)" -> "User reviews spec?";
    "User reviews spec?" -> "Write design doc" [label="changes requested"];
    "User reviews spec?" -> "Invoke writing-plans skill" [label="approved"];
}
\`\`\`

**The terminal state is invoking writing-plans.** Do NOT invoke any other implementation skill from here.

## The Process

**Understanding the idea:**

- Check out the current project state first (files, docs, recent commits)
- Before asking detailed questions, assess scope: if the request describes multiple independent subsystems (e.g., "build a platform with chat, file storage, billing, and analytics"), flag this immediately. Don't spend questions refining details of a project that needs to be decomposed first.
- If the project is too large for a single spec, help the user decompose into sub-projects: what are the independent pieces, how do they relate, what order should they be built? Then brainstorm the first sub-project through the normal design flow. Each sub-project gets its own spec → plan → implementation cycle.
- For appropriately-scoped projects, ask questions one at a time to refine the idea
- Prefer multiple choice questions when possible, but open-ended is fine too
- Only one question per message - if a topic needs more exploration, break it into multiple questions
- Focus on understanding: purpose, constraints, success criteria

**Exploring approaches:**

- Propose 2-3 different approaches with trade-offs
- Present options conversationally with your recommendation and reasoning
- Lead with your recommended option and explain why

**Presenting the design:**

- Once you believe you understand what you're building, present the design
- Scale each section to its complexity: a few sentences if straightforward, up to 200-300 words if nuanced
- Ask after each section whether it looks right so far
- Cover: architecture, components, data flow, error handling, testing
- Be ready to go back and clarify if something doesn't make sense

**Design for isolation and clarity:**

- Break the system into smaller units that each have one clear purpose, communicate through well-defined interfaces, and can be understood and tested independently
- For each unit, you should be able to answer: what does it do, how do you use it, and what does it depend on?
- Can someone understand what a unit does without reading its internals? Can you change the internals without breaking consumers? If not, the boundaries need work.

**Working in existing codebases:**

- Explore the current structure before proposing changes. Follow existing patterns.
- Where existing code has problems that affect the work, include targeted improvements as part of the design - the way a good developer improves code they're working in.
- Don't propose unrelated refactoring. Stay focused on what serves the current goal.

## After the Design

**Spec Self-Review:**
After writing the spec document, look at it with fresh eyes:

1. **Placeholder scan:** Any "TBD", "TODO", incomplete sections, or vague requirements? Fix them.
2. **Internal consistency:** Do any sections contradict each other? Does the architecture match the feature descriptions?
3. **Scope check:** Is this focused enough for a single implementation plan, or does it need decomposition?
4. **Ambiguity check:** Could any requirement be interpreted two different ways? If so, pick one and make it explicit.

Fix any issues inline. No need to re-review — just fix and move on.

**User Review Gate:**
After the spec review loop passes, ask the user to review the written spec before proceeding. Wait for their response. If they request changes, make them and re-run the spec review loop. Only proceed once the user approves.

## Key Principles

- **One question at a time** - Don't overwhelm with multiple questions
- **Multiple choice preferred** - Easier to answer than open-ended when possible
- **YAGNI ruthlessly** - Remove unnecessary features from all designs
- **Explore alternatives** - Always propose 2-3 approaches before settling
- **Incremental validation** - Present design, get approval before moving on
- **Be flexible** - Go back and clarify when something doesn't make sense

---

## Moe integration

When an architect claims a Moe task with sparse \`acceptanceCriteria\` or vague \`description\`:

- **Don't go straight to \`moe.submit_plan\`.** Run this brainstorming process with the human in chat first (use \`moe.chat_send\` on the task channel).
- **Save the design doc** to \`docs/specs/<task-id>-<slug>.md\` (this repo's spec convention) and commit. Reference its path in the first step description of \`implementationPlan\` so the worker has the design context.
- **Then invoke \`moe-planning\` (not the upstream \`writing-plans\` skill)** — \`moe-planning\` is the Moe-flavored equivalent that maps the 8 phases to \`submit_plan\` step lists.

When the task already has clear acceptance criteria and the design space is small, skip brainstorming and go straight to \`moe-planning\`.`,
  'brainstorming/SOURCE.md': `# Source

Vendored from [\`obra/superpowers\`](https://github.com/obra/superpowers).

- Upstream path: \`skills/brainstorming/SKILL.md\`
- Upstream commit: \`b55764852ac78870e65c6565fb585b6cd8b3c5c9\`
- License: MIT (see \`../LICENSE-VENDORED.md\`)

## Local modifications

- Removed the Visual Companion section (browser-based mockup tool not part of Moe today; can be re-introduced once the JetBrains/VS Code panes support a similar surface).
- Removed the explicit \`frontend-design\`, \`mcp-builder\` skill references (those skills are not part of the Moe skill pack).
- Renamed \`docs/superpowers/specs/...\` save path to \`docs/specs/<task-id>-<slug>.md\` in the Moe integration footer (matches this repo's docs convention).
- Re-pointed the next-step skill from \`writing-plans\` to \`moe-planning\` (Moe-flavored equivalent).
- Appended \`## Moe integration\` footer wiring the skill to \`moe.chat_send\` on the task channel and the \`moe.submit_plan\` flow.`,
  'dispatching-parallel-agents/SKILL.md': `---
name: dispatching-parallel-agents
description: Use when facing 2+ independent tasks that can be worked on without shared state or sequential dependencies
---

# Dispatching Parallel Agents

## Overview

You delegate tasks to specialized agents with isolated context. By precisely crafting their instructions and context, you ensure they stay focused and succeed at their task. They should never inherit your session's context or history — you construct exactly what they need. This also preserves your own context for coordination work.

When you have multiple unrelated failures (different test files, different subsystems, different bugs), investigating them sequentially wastes time. Each investigation is independent and can happen in parallel.

**Core principle:** Dispatch one agent per independent problem domain. Let them work concurrently.

## When to Use

\`\`\`dot
digraph when_to_use {
    "Multiple failures?" [shape=diamond];
    "Are they independent?" [shape=diamond];
    "Single agent investigates all" [shape=box];
    "One agent per problem domain" [shape=box];
    "Can they work in parallel?" [shape=diamond];
    "Sequential agents" [shape=box];
    "Parallel dispatch" [shape=box];

    "Multiple failures?" -> "Are they independent?" [label="yes"];
    "Are they independent?" -> "Single agent investigates all" [label="no - related"];
    "Are they independent?" -> "Can they work in parallel?" [label="yes"];
    "Can they work in parallel?" -> "Parallel dispatch" [label="yes"];
    "Can they work in parallel?" -> "Sequential agents" [label="no - shared state"];
}
\`\`\`

**Use when:**
- 3+ test files failing with different root causes
- Multiple subsystems broken independently
- Each problem can be understood without context from others
- No shared state between investigations

**Don't use when:**
- Failures are related (fix one might fix others)
- Need to understand full system state
- Agents would interfere with each other

## The Pattern

### 1. Identify Independent Domains

Group failures by what's broken:
- File A tests: Tool approval flow
- File B tests: Batch completion behavior
- File C tests: Abort functionality

Each domain is independent - fixing tool approval doesn't affect abort tests.

### 2. Create Focused Agent Tasks

Each agent gets:
- **Specific scope:** One test file or subsystem
- **Clear goal:** Make these tests pass
- **Constraints:** Don't change other code
- **Expected output:** Summary of what you found and fixed

### 3. Dispatch in Parallel

\`\`\`typescript
// In Claude Code / AI environment
Task("Fix agent-tool-abort.test.ts failures")
Task("Fix batch-completion-behavior.test.ts failures")
Task("Fix tool-approval-race-conditions.test.ts failures")
// All three run concurrently
\`\`\`

### 4. Review and Integrate

When agents return:
- Read each summary
- Verify fixes don't conflict
- Run full test suite
- Integrate all changes

## Agent Prompt Structure

Good agent prompts are:
1. **Focused** - One clear problem domain
2. **Self-contained** - All context needed to understand the problem
3. **Specific about output** - What should the agent return?

\`\`\`markdown
Fix the 3 failing tests in src/agents/agent-tool-abort.test.ts:

1. "should abort tool with partial output capture" - expects 'interrupted at' in message
2. "should handle mixed completed and aborted tools" - fast tool aborted instead of completed
3. "should properly track pendingToolCount" - expects 3 results but gets 0

These are timing/race condition issues. Your task:

1. Read the test file and understand what each test verifies
2. Identify root cause - timing issues or actual bugs?
3. Fix by:
   - Replacing arbitrary timeouts with event-based waiting
   - Fixing bugs in abort implementation if found
   - Adjusting test expectations if testing changed behavior

Do NOT just increase timeouts - find the real issue.

Return: Summary of what you found and what you fixed.
\`\`\`

## Common Mistakes

**❌ Too broad:** "Fix all the tests" - agent gets lost
**✅ Specific:** "Fix agent-tool-abort.test.ts" - focused scope

**❌ No context:** "Fix the race condition" - agent doesn't know where
**✅ Context:** Paste the error messages and test names

**❌ No constraints:** Agent might refactor everything
**✅ Constraints:** "Do NOT change production code" or "Fix tests only"

**❌ Vague output:** "Fix it" - you don't know what changed
**✅ Specific:** "Return summary of root cause and changes"

## When NOT to Use

**Related failures:** Fixing one might fix others - investigate together first
**Need full context:** Understanding requires seeing entire system
**Exploratory debugging:** You don't know what's broken yet
**Shared state:** Agents would interfere (editing same files, using same resources)

## Key Benefits

1. **Parallelization** - Multiple investigations happen simultaneously
2. **Focus** - Each agent has narrow scope, less context to track
3. **Independence** - Agents don't interfere with each other
4. **Speed** - 3 problems solved in time of 1

## Verification

After agents return:
1. **Review each summary** - Understand what changed
2. **Check for conflicts** - Did agents edit same code?
3. **Run full suite** - Verify all fixes work together
4. **Spot check** - Agents can make systematic errors

---

## Moe integration

Two flavours of "parallel" in Moe:

1. **Within a single agent session** — use the host's subagent tool (e.g., Claude Code's \`Agent\` / \`Task\` tool) to fan out exploration or independent fixes. Same as the upstream pattern above.

2. **Across Moe workers** — use \`moe.create_task\` to fan a large epic out into smaller independent tasks, each claimable by a separate worker. The architect's plan should explicitly call out which tasks can run in parallel (no shared \`affectedFiles\`, no sequential \`blockedBy\` dependencies).

Pair with \`using-git-worktrees\` so concurrent workers don't trample each other's working tree. The daemon serializes all \`.moe/\` writes — but file edits in \`src/\` are the worker's responsibility, and worktrees give you isolation for free.`,
  'dispatching-parallel-agents/SOURCE.md': `# Source

Vendored from [\`obra/superpowers\`](https://github.com/obra/superpowers).

- Upstream path: \`skills/dispatching-parallel-agents/SKILL.md\`
- Upstream commit: \`b55764852ac78870e65c6565fb585b6cd8b3c5c9\`
- License: MIT (see \`../LICENSE-VENDORED.md\`)

## Local modifications

- Removed the "Real Example from Session" + "Real-World Impact" anecdotes (specific to upstream debugging history).
- Appended \`## Moe integration\` footer distinguishing within-session subagent fan-out vs cross-worker fan-out via \`moe.create_task\`, and pointing at \`using-git-worktrees\`.`,
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

# Code Review Reception

## Overview

Code review requires technical evaluation, not emotional performance.

**Core principle:** Verify before implementing. Ask before assuming. Technical correctness over social comfort.

## The Response Pattern

\`\`\`
WHEN receiving code review feedback:

1. READ: Complete feedback without reacting
2. UNDERSTAND: Restate requirement in own words (or ask)
3. VERIFY: Check against codebase reality
4. EVALUATE: Technically sound for THIS codebase?
5. RESPOND: Technical acknowledgment or reasoned pushback
6. IMPLEMENT: One item at a time, test each
\`\`\`

## Forbidden Responses

**NEVER:**
- "You're absolutely right!" (performative)
- "Great point!" / "Excellent feedback!" (performative)
- "Let me implement that now" (before verification)

**INSTEAD:**
- Restate the technical requirement
- Ask clarifying questions
- Push back with technical reasoning if wrong
- Just start working (actions > words)

## Handling Unclear Feedback

\`\`\`
IF any item is unclear:
  STOP - do not implement anything yet
  ASK for clarification on unclear items

WHY: Items may be related. Partial understanding = wrong implementation.
\`\`\`

**Example:**
\`\`\`
Reviewer: "Fix 1-6"
You understand 1,2,3,6. Unclear on 4,5.

❌ WRONG: Implement 1,2,3,6 now, ask about 4,5 later
✅ RIGHT: "I understand items 1,2,3,6. Need clarification on 4 and 5 before proceeding."
\`\`\`

## Source-Specific Handling

### From a trusted human reviewer
- Implement after understanding
- Still ask if scope unclear
- No performative agreement
- Skip to action or technical acknowledgment

### From External Reviewers / Bots
\`\`\`
BEFORE implementing:
  1. Check: Technically correct for THIS codebase?
  2. Check: Breaks existing functionality?
  3. Check: Reason for current implementation?
  4. Check: Works on all platforms/versions?
  5. Check: Does reviewer understand full context?

IF suggestion seems wrong:
  Push back with technical reasoning

IF can't easily verify:
  Say so: "I can't verify this without [X]. Should I [investigate/ask/proceed]?"

IF conflicts with prior decisions:
  Stop and discuss before changing direction.
\`\`\`

## YAGNI Check for "Professional" Features

\`\`\`
IF reviewer suggests "implementing properly":
  grep codebase for actual usage

  IF unused: "This endpoint isn't called. Remove it (YAGNI)?"
  IF used: Then implement properly
\`\`\`

## Implementation Order

\`\`\`
FOR multi-item feedback:
  1. Clarify anything unclear FIRST
  2. Then implement in this order:
     - Blocking issues (breaks, security)
     - Simple fixes (typos, imports)
     - Complex fixes (refactoring, logic)
  3. Test each fix individually
  4. Verify no regressions
\`\`\`

## When To Push Back

Push back when:
- Suggestion breaks existing functionality
- Reviewer lacks full context
- Violates YAGNI (unused feature)
- Technically incorrect for this stack
- Legacy/compatibility reasons exist
- Conflicts with architectural decisions

**How to push back:**
- Use technical reasoning, not defensiveness
- Ask specific questions
- Reference working tests/code

## Acknowledging Correct Feedback

When feedback IS correct:
\`\`\`
✅ "Fixed. [Brief description of what changed]"
✅ "Good catch - [specific issue]. Fixed in [location]."
✅ [Just fix it and show in the code]

❌ "You're absolutely right!"
❌ "Great point!"
❌ "Thanks for catching that!"
❌ ANY gratitude expression
\`\`\`

**Why no thanks:** Actions speak. Just fix it. The code itself shows you heard the feedback.

**If you catch yourself about to write "Thanks":** DELETE IT. State the fix instead.

## Gracefully Correcting Your Pushback

If you pushed back and were wrong:
\`\`\`
✅ "You were right - I checked [X] and it does [Y]. Implementing now."
✅ "Verified this and you're correct. My initial understanding was wrong because [reason]. Fixing."

❌ Long apology
❌ Defending why you pushed back
❌ Over-explaining
\`\`\`

State the correction factually and move on.

## Common Mistakes

| Mistake | Fix |
|---------|-----|
| Performative agreement | State requirement or just act |
| Blind implementation | Verify against codebase first |
| Batch without testing | One at a time, test each |
| Assuming reviewer is right | Check if breaks things |
| Avoiding pushback | Technical correctness > comfort |
| Partial implementation | Clarify all items first |
| Can't verify, proceed anyway | State limitation, ask for direction |

## Real Examples

**Performative Agreement (Bad):**
\`\`\`
Reviewer: "Remove legacy code"
❌ "You're absolutely right! Let me remove that..."
\`\`\`

**Technical Verification (Good):**
\`\`\`
Reviewer: "Remove legacy code"
✅ "Checking... build target is 10.15+, this API needs 13+. Need legacy for backward compat. Current impl has wrong bundle ID - fix it or drop pre-13 support?"
\`\`\`

**YAGNI (Good):**
\`\`\`
Reviewer: "Implement proper metrics tracking with database, date filters, CSV export"
✅ "Grepped codebase - nothing calls this endpoint. Remove it (YAGNI)? Or is there usage I'm missing?"
\`\`\`

**Unclear Item (Good):**
\`\`\`
Reviewer: "Fix items 1-6"
You understand 1,2,3,6. Unclear on 4,5.
✅ "Understand 1,2,3,6. Need clarification on 4 and 5 before implementing."
\`\`\`

## The Bottom Line

**External feedback = suggestions to evaluate, not orders to follow.**

Verify. Question. Then implement.

No performative agreement. Technical rigor always.

---

## Moe integration

This skill loads automatically when Moe's \`nextAction\` returns \`recommendedSkill: receiving-code-review\` — typically after \`moe.qa_reject\` (the task is back in \`WORKING\` with \`reopenCount > 0\` and \`rejectionDetails\` populated).

When you receive a QA rejection:

1. **Read all of \`rejectionDetails\` first.** Don't start fixing until you understand every item.
2. **Verify each item against the diff.** If QA points at a file/line, open it and read for yourself.
3. **If an item seems wrong**, push back via \`moe.add_comment\` on the task channel with technical reasoning. Don't silently ignore it; don't silently implement it.
4. **Implement in priority order** (security/correctness > simple fixes > refactoring) and use \`moe.start_step\` per item — don't batch unrelated fixes into one commit.
5. **After fixes, run the regression suite** (\`regression-check\` skill) and put the actual results in your \`moe.complete_task\` summary.

Never include performative gratitude in \`moe.add_comment\` ("thanks for the catch!"). State what you changed.`,
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

## Overview

Random fixes waste time and create new bugs. Quick patches mask underlying issues.

**Core principle:** ALWAYS find root cause before attempting fixes. Symptom fixes are failure.

**Violating the letter of this process is violating the spirit of debugging.**

## The Iron Law

\`\`\`
NO FIXES WITHOUT ROOT CAUSE INVESTIGATION FIRST
\`\`\`

If you haven't completed Phase 1, you cannot propose fixes.

## When to Use

Use for ANY technical issue:
- Test failures
- Bugs in production
- Unexpected behavior
- Performance problems
- Build failures
- Integration issues

**Use this ESPECIALLY when:**
- Under time pressure (emergencies make guessing tempting)
- "Just one quick fix" seems obvious
- You've already tried multiple fixes
- Previous fix didn't work
- You don't fully understand the issue

**Don't skip when:**
- Issue seems simple (simple bugs have root causes too)
- You're in a hurry (rushing guarantees rework)
- Manager wants it fixed NOW (systematic is faster than thrashing)

## The Four Phases

You MUST complete each phase before proceeding to the next.

### Phase 1: Root Cause Investigation

**BEFORE attempting ANY fix:**

1. **Read Error Messages Carefully**
   - Don't skip past errors or warnings
   - They often contain the exact solution
   - Read stack traces completely
   - Note line numbers, file paths, error codes

2. **Reproduce Consistently**
   - Can you trigger it reliably?
   - What are the exact steps?
   - Does it happen every time?
   - If not reproducible → gather more data, don't guess

3. **Check Recent Changes**
   - What changed that could cause this?
   - Git diff, recent commits
   - New dependencies, config changes
   - Environmental differences

4. **Gather Evidence in Multi-Component Systems**

   **WHEN system has multiple components (CI → build → signing, API → service → database):**

   **BEFORE proposing fixes, add diagnostic instrumentation:**
   \`\`\`
   For EACH component boundary:
     - Log what data enters component
     - Log what data exits component
     - Verify environment/config propagation
     - Check state at each layer

   Run once to gather evidence showing WHERE it breaks
   THEN analyze evidence to identify failing component
   THEN investigate that specific component
   \`\`\`

5. **Trace Data Flow**

   **WHEN error is deep in call stack:**

   - Where does bad value originate?
   - What called this with bad value?
   - Keep tracing up until you find the source
   - Fix at source, not at symptom

### Phase 2: Pattern Analysis

**Find the pattern before fixing:**

1. **Find Working Examples**
   - Locate similar working code in same codebase
   - What works that's similar to what's broken?

2. **Compare Against References**
   - If implementing pattern, read reference implementation COMPLETELY
   - Don't skim - read every line
   - Understand the pattern fully before applying

3. **Identify Differences**
   - What's different between working and broken?
   - List every difference, however small
   - Don't assume "that can't matter"

4. **Understand Dependencies**
   - What other components does this need?
   - What settings, config, environment?
   - What assumptions does it make?

### Phase 3: Hypothesis and Testing

**Scientific method:**

1. **Form Single Hypothesis**
   - State clearly: "I think X is the root cause because Y"
   - Write it down
   - Be specific, not vague

2. **Test Minimally**
   - Make the SMALLEST possible change to test hypothesis
   - One variable at a time
   - Don't fix multiple things at once

3. **Verify Before Continuing**
   - Did it work? Yes → Phase 4
   - Didn't work? Form NEW hypothesis
   - DON'T add more fixes on top

4. **When You Don't Know**
   - Say "I don't understand X"
   - Don't pretend to know
   - Ask for help
   - Research more

### Phase 4: Implementation

**Fix the root cause, not the symptom:**

1. **Create Failing Test Case**
   - Simplest possible reproduction
   - Automated test if possible
   - One-off test script if no framework
   - MUST have before fixing
   - Use the \`test-driven-development\` skill for writing proper failing tests

2. **Implement Single Fix**
   - Address the root cause identified
   - ONE change at a time
   - No "while I'm here" improvements
   - No bundled refactoring

3. **Verify Fix**
   - Test passes now?
   - No other tests broken?
   - Issue actually resolved?

4. **If Fix Doesn't Work**
   - STOP
   - Count: How many fixes have you tried?
   - If < 3: Return to Phase 1, re-analyze with new information
   - **If ≥ 3: STOP and question the architecture (step 5 below)**
   - DON'T attempt Fix #4 without architectural discussion

5. **If 3+ Fixes Failed: Question Architecture**

   **Pattern indicating architectural problem:**
   - Each fix reveals new shared state/coupling/problem in different place
   - Fixes require "massive refactoring" to implement
   - Each fix creates new symptoms elsewhere

   **STOP and question fundamentals:**
   - Is this pattern fundamentally sound?
   - Are we "sticking with it through sheer inertia"?
   - Should we refactor architecture vs. continue fixing symptoms?

   **Discuss with your human partner before attempting more fixes**

   This is NOT a failed hypothesis - this is a wrong architecture.

## Red Flags - STOP and Follow Process

If you catch yourself thinking:
- "Quick fix for now, investigate later"
- "Just try changing X and see if it works"
- "Add multiple changes, run tests"
- "Skip the test, I'll manually verify"
- "It's probably X, let me fix that"
- "I don't fully understand but this might work"
- "Pattern says X but I'll adapt it differently"
- "Here are the main problems: [lists fixes without investigation]"
- Proposing solutions before tracing data flow
- **"One more fix attempt" (when already tried 2+)**
- **Each fix reveals new problem in different place**

**ALL of these mean: STOP. Return to Phase 1.**

**If 3+ fixes failed:** Question the architecture (see Phase 4.5)

## Common Rationalizations

| Excuse | Reality |
|--------|---------|
| "Issue is simple, don't need process" | Simple issues have root causes too. Process is fast for simple bugs. |
| "Emergency, no time for process" | Systematic debugging is FASTER than guess-and-check thrashing. |
| "Just try this first, then investigate" | First fix sets the pattern. Do it right from the start. |
| "I'll write test after confirming fix works" | Untested fixes don't stick. Test first proves it. |
| "Multiple fixes at once saves time" | Can't isolate what worked. Causes new bugs. |
| "Reference too long, I'll adapt the pattern" | Partial understanding guarantees bugs. Read it completely. |
| "I see the problem, let me fix it" | Seeing symptoms ≠ understanding root cause. |
| "One more fix attempt" (after 2+ failures) | 3+ failures = architectural problem. Question pattern, don't fix again. |

## Quick Reference

| Phase | Key Activities | Success Criteria |
|-------|---------------|------------------|
| **1. Root Cause** | Read errors, reproduce, check changes, gather evidence | Understand WHAT and WHY |
| **2. Pattern** | Find working examples, compare | Identify differences |
| **3. Hypothesis** | Form theory, test minimally | Confirmed or new hypothesis |
| **4. Implementation** | Create test, fix, verify | Bug resolved, tests pass |

## When Process Reveals "No Root Cause"

If systematic investigation reveals issue is truly environmental, timing-dependent, or external:

1. You've completed the process
2. Document what you investigated
3. Implement appropriate handling (retry, timeout, error message)
4. Add monitoring/logging for future investigation

**But:** 95% of "no root cause" cases are incomplete investigation.

## Real-World Impact

From debugging sessions:
- Systematic approach: 15-30 minutes to fix
- Random fixes approach: 2-3 hours of thrashing
- First-time fix rate: 95% vs 40%
- New bugs introduced: Near zero vs common

---

## Moe integration

Use this skill when:

- A worker repeatedly fails the same step.
- A task lands in \`BLOCKED\` (set via \`moe.set_task_status\`) for a non-trivial reason.
- A \`qa_reject\` returns with a bug-shaped \`rejectionDetails\` (not a "missing test" or "missing doc").
- A worker is reopened (\`reopenCount > 0\`).

Do not propose a fix in \`moe.complete_step\` until you've completed Phase 1 of this skill. If you cannot find the root cause, call \`moe.report_blocked\` with what you investigated — that's better than a guessed fix that wastes another QA round-trip.

Pair with \`test-driven-development\` for the Phase 4.1 failing-test step, and \`verification-before-completion\` for the Phase 4.3 verify step.`,
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

## Overview

Write the test first. Watch it fail. Write minimal code to pass.

**Core principle:** If you didn't watch the test fail, you don't know if it tests the right thing.

**Violating the letter of the rules is violating the spirit of the rules.**

## When to Use

**Always:**
- New features
- Bug fixes
- Refactoring
- Behavior changes

**Exceptions (ask your human partner):**
- Throwaway prototypes
- Generated code
- Configuration files

Thinking "skip TDD just this once"? Stop. That's rationalization.

## The Iron Law

\`\`\`
NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST
\`\`\`

Write code before the test? Delete it. Start over.

**No exceptions:**
- Don't keep it as "reference"
- Don't "adapt" it while writing tests
- Don't look at it
- Delete means delete

Implement fresh from tests. Period.

## Red-Green-Refactor

\`\`\`dot
digraph tdd_cycle {
    rankdir=LR;
    red [label="RED\\nWrite failing test", shape=box, style=filled, fillcolor="#ffcccc"];
    verify_red [label="Verify fails\\ncorrectly", shape=diamond];
    green [label="GREEN\\nMinimal code", shape=box, style=filled, fillcolor="#ccffcc"];
    verify_green [label="Verify passes\\nAll green", shape=diamond];
    refactor [label="REFACTOR\\nClean up", shape=box, style=filled, fillcolor="#ccccff"];
    next [label="Next", shape=ellipse];

    red -> verify_red;
    verify_red -> green [label="yes"];
    verify_red -> red [label="wrong\\nfailure"];
    green -> verify_green;
    verify_green -> refactor [label="yes"];
    verify_green -> green [label="no"];
    refactor -> verify_green [label="stay\\ngreen"];
    verify_green -> next;
    next -> red;
}
\`\`\`

### RED - Write Failing Test

Write one minimal test showing what should happen.

<Good>
\`\`\`typescript
test('retries failed operations 3 times', async () => {
  let attempts = 0;
  const operation = () => {
    attempts++;
    if (attempts < 3) throw new Error('fail');
    return 'success';
  };

  const result = await retryOperation(operation);

  expect(result).toBe('success');
  expect(attempts).toBe(3);
});
\`\`\`
Clear name, tests real behavior, one thing
</Good>

<Bad>
\`\`\`typescript
test('retry works', async () => {
  const mock = jest.fn()
    .mockRejectedValueOnce(new Error())
    .mockRejectedValueOnce(new Error())
    .mockResolvedValueOnce('success');
  await retryOperation(mock);
  expect(mock).toHaveBeenCalledTimes(3);
});
\`\`\`
Vague name, tests mock not code
</Bad>

**Requirements:**
- One behavior
- Clear name
- Real code (no mocks unless unavoidable)

### Verify RED - Watch It Fail

**MANDATORY. Never skip.**

\`\`\`bash
npm test path/to/test.test.ts
\`\`\`

Confirm:
- Test fails (not errors)
- Failure message is expected
- Fails because feature missing (not typos)

**Test passes?** You're testing existing behavior. Fix test.

**Test errors?** Fix error, re-run until it fails correctly.

### GREEN - Minimal Code

Write simplest code to pass the test.

<Good>
\`\`\`typescript
async function retryOperation<T>(fn: () => Promise<T>): Promise<T> {
  for (let i = 0; i < 3; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i === 2) throw e;
    }
  }
  throw new Error('unreachable');
}
\`\`\`
Just enough to pass
</Good>

<Bad>
\`\`\`typescript
async function retryOperation<T>(
  fn: () => Promise<T>,
  options?: {
    maxRetries?: number;
    backoff?: 'linear' | 'exponential';
    onRetry?: (attempt: number) => void;
  }
): Promise<T> {
  // YAGNI
}
\`\`\`
Over-engineered
</Bad>

Don't add features, refactor other code, or "improve" beyond the test.

### Verify GREEN - Watch It Pass

**MANDATORY.**

\`\`\`bash
npm test path/to/test.test.ts
\`\`\`

Confirm:
- Test passes
- Other tests still pass
- Output pristine (no errors, warnings)

**Test fails?** Fix code, not test.

**Other tests fail?** Fix now.

### REFACTOR - Clean Up

After green only:
- Remove duplication
- Improve names
- Extract helpers

Keep tests green. Don't add behavior.

### Repeat

Next failing test for next feature.

## Good Tests

| Quality | Good | Bad |
|---------|------|-----|
| **Minimal** | One thing. "and" in name? Split it. | \`test('validates email and domain and whitespace')\` |
| **Clear** | Name describes behavior | \`test('test1')\` |
| **Shows intent** | Demonstrates desired API | Obscures what code should do |

## Mutation-Resistant Assertions

Assert specific values, not truthiness. Tests that pass when code does nothing are worse than no tests.

| Bad | Good |
|-----|------|
| \`assert(result)\` | \`assertEquals('completed', result.status)\` |
| \`expect(items).toBeTruthy()\` | \`expect(items).toEqual(['a','b','c'])\` |
| \`expect(fn).not.toThrow()\` | \`expect(fn()).toBe(expectedValue)\` |

If a one-character change to your production code wouldn't make any test fail, your tests aren't doing their job.

## Why Order Matters

**"I'll write tests after to verify it works"**

Tests written after code pass immediately. Passing immediately proves nothing:
- Might test wrong thing
- Might test implementation, not behavior
- Might miss edge cases you forgot
- You never saw it catch the bug

Test-first forces you to see the test fail, proving it actually tests something.

**"I already manually tested all the edge cases"**

Manual testing is ad-hoc. You think you tested everything but:
- No record of what you tested
- Can't re-run when code changes
- Easy to forget cases under pressure
- "It worked when I tried it" ≠ comprehensive

Automated tests are systematic. They run the same way every time.

**"Deleting X hours of work is wasteful"**

Sunk cost fallacy. The time is already gone. Your choice now:
- Delete and rewrite with TDD (X more hours, high confidence)
- Keep it and add tests after (30 min, low confidence, likely bugs)

The "waste" is keeping code you can't trust. Working code without real tests is technical debt.

**"TDD is dogmatic, being pragmatic means adapting"**

TDD IS pragmatic:
- Finds bugs before commit (faster than debugging after)
- Prevents regressions (tests catch breaks immediately)
- Documents behavior (tests show how to use code)
- Enables refactoring (change freely, tests catch breaks)

"Pragmatic" shortcuts = debugging in production = slower.

**"Tests after achieve the same goals - it's spirit not ritual"**

No. Tests-after answer "What does this do?" Tests-first answer "What should this do?"

Tests-after are biased by your implementation. You test what you built, not what's required. You verify remembered edge cases, not discovered ones.

Tests-first force edge case discovery before implementing. Tests-after verify you remembered everything (you didn't).

30 minutes of tests after ≠ TDD. You get coverage, lose proof tests work.

## Common Rationalizations

| Excuse | Reality |
|--------|---------|
| "Too simple to test" | Simple code breaks. Test takes 30 seconds. |
| "I'll test after" | Tests passing immediately prove nothing. |
| "Tests after achieve same goals" | Tests-after = "what does this do?" Tests-first = "what should this do?" |
| "Already manually tested" | Ad-hoc ≠ systematic. No record, can't re-run. |
| "Deleting X hours is wasteful" | Sunk cost fallacy. Keeping unverified code is technical debt. |
| "Keep as reference, write tests first" | You'll adapt it. That's testing after. Delete means delete. |
| "Need to explore first" | Fine. Throw away exploration, start with TDD. |
| "Test hard = design unclear" | Listen to test. Hard to test = hard to use. |
| "TDD will slow me down" | TDD faster than debugging. Pragmatic = test-first. |
| "Manual test faster" | Manual doesn't prove edge cases. You'll re-test every change. |
| "Existing code has no tests" | You're improving it. Add tests for existing code. |

## Red Flags - STOP and Start Over

- Code before test
- Test after implementation
- Test passes immediately
- Can't explain why test failed
- Tests added "later"
- Rationalizing "just this once"
- "I already manually tested it"
- "Tests after achieve the same purpose"
- "It's about spirit not ritual"
- "Keep as reference" or "adapt existing code"
- "Already spent X hours, deleting is wasteful"
- "TDD is dogmatic, I'm being pragmatic"
- "This is different because..."

**All of these mean: Delete code. Start over with TDD.**

## Example: Bug Fix

**Bug:** Empty email accepted

**RED**
\`\`\`typescript
test('rejects empty email', async () => {
  const result = await submitForm({ email: '' });
  expect(result.error).toBe('Email required');
});
\`\`\`

**Verify RED**
\`\`\`bash
$ npm test
FAIL: expected 'Email required', got undefined
\`\`\`

**GREEN**
\`\`\`typescript
function submitForm(data: FormData) {
  if (!data.email?.trim()) {
    return { error: 'Email required' };
  }
  // ...
}
\`\`\`

**Verify GREEN**
\`\`\`bash
$ npm test
PASS
\`\`\`

**REFACTOR**
Extract validation for multiple fields if needed.

## Verification Checklist

Before marking work complete:

- [ ] Every new function/method has a test
- [ ] Watched each test fail before implementing
- [ ] Each test failed for expected reason (feature missing, not typo)
- [ ] Wrote minimal code to pass each test
- [ ] All tests pass
- [ ] Output pristine (no errors, warnings)
- [ ] Tests use real code (mocks only if unavoidable)
- [ ] Edge cases and errors covered

Can't check all boxes? You skipped TDD. Start over.

## When Stuck

| Problem | Solution |
|---------|----------|
| Don't know how to test | Write wished-for API. Write assertion first. Ask your human partner. |
| Test too complicated | Design too complicated. Simplify interface. |
| Must mock everything | Code too coupled. Use dependency injection. |
| Test setup huge | Extract helpers. Still complex? Simplify design. |

## Debugging Integration

Bug found? Write failing test reproducing it. Follow TDD cycle. Test proves fix and prevents regression.

Never fix bugs without a test.

## Final Rule

\`\`\`
Production code → test exists and failed first
Otherwise → not TDD
\`\`\`

No exceptions without your human partner's permission.

---

## Moe integration

In a Moe session:
- Apply this discipline within each \`moe.start_step\` → implement → \`moe.complete_step\` cycle on test-touching steps.
- The architect should plan the failing test as a separate step before the implementation step (see the \`moe-planning\` skill, Phase 3).
- Before \`moe.complete_task\`, pair with the \`verification-before-completion\` skill — capture the actual test run output (count + pass/fail) in your \`complete_step\` summary so QA has evidence rather than a claim.`,
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

## Overview

Write comprehensive implementation plans assuming the engineer has zero context for our codebase and questionable taste. Document everything they need to know: which files to touch for each task, code, testing, docs they might need to check, how to test it. Give them the whole plan as bite-sized tasks. DRY. YAGNI. TDD. Frequent commits.

Assume they are a skilled developer, but know almost nothing about our toolset or problem domain. Assume they don't know good test design very well.

**Announce at start:** "I'm using the writing-plans skill to create the implementation plan."

## Scope Check

If the spec covers multiple independent subsystems, it should have been broken into sub-project specs during brainstorming. If it wasn't, suggest breaking this into separate plans — one per subsystem. Each plan should produce working, testable software on its own.

## File Structure

Before defining tasks, map out which files will be created or modified and what each one is responsible for. This is where decomposition decisions get locked in.

- Design units with clear boundaries and well-defined interfaces. Each file should have one clear responsibility.
- You reason best about code you can hold in context at once, and your edits are more reliable when files are focused. Prefer smaller, focused files over large ones that do too much.
- Files that change together should live together. Split by responsibility, not by technical layer.
- In existing codebases, follow established patterns. If the codebase uses large files, don't unilaterally restructure - but if a file you're modifying has grown unwieldy, including a split in the plan is reasonable.

This structure informs the task decomposition. Each task should produce self-contained changes that make sense independently.

## Bite-Sized Task Granularity

**Each step is one action (2-5 minutes):**
- "Write the failing test" - step
- "Run it to make sure it fails" - step
- "Implement the minimal code to make the test pass" - step
- "Run the tests and make sure they pass" - step
- "Commit" - step

## Plan Document Header

**Every plan MUST start with this header:**

\`\`\`markdown
# [Feature Name] Implementation Plan

**Goal:** [One sentence describing what this builds]

**Architecture:** [2-3 sentences about approach]

**Tech Stack:** [Key technologies/libraries]

---
\`\`\`

## Task Structure

\`\`\`\`markdown
### Task N: [Component Name]

**Files:**
- Create: \`exact/path/to/file.py\`
- Modify: \`exact/path/to/existing.py:123-145\`
- Test: \`tests/exact/path/to/test.py\`

- [ ] **Step 1: Write the failing test**

\`\`\`python
def test_specific_behavior():
    result = function(input)
    assert result == expected
\`\`\`

- [ ] **Step 2: Run test to verify it fails**

Run: \`pytest tests/path/test.py::test_name -v\`
Expected: FAIL with "function not defined"

- [ ] **Step 3: Write minimal implementation**

\`\`\`python
def function(input):
    return expected
\`\`\`

- [ ] **Step 4: Run test to verify it passes**

Run: \`pytest tests/path/test.py::test_name -v\`
Expected: PASS

- [ ] **Step 5: Commit**

\`\`\`bash
git add tests/path/test.py src/path/file.py
git commit -m "feat: add specific feature"
\`\`\`
\`\`\`\`

## No Placeholders

Every step must contain the actual content an engineer needs. These are **plan failures** — never write them:
- "TBD", "TODO", "implement later", "fill in details"
- "Add appropriate error handling" / "add validation" / "handle edge cases"
- "Write tests for the above" (without actual test code)
- "Similar to Task N" (repeat the code — the engineer may be reading tasks out of order)
- Steps that describe what to do without showing how (code blocks required for code steps)
- References to types, functions, or methods not defined in any task

## Remember
- Exact file paths always
- Complete code in every step — if a step changes code, show the code
- Exact commands with expected output
- DRY, YAGNI, TDD, frequent commits

## Self-Review

After writing the complete plan, look at the spec with fresh eyes and check the plan against it. This is a checklist you run yourself — not a subagent dispatch.

**1. Spec coverage:** Skim each section/requirement in the spec. Can you point to a task that implements it? List any gaps.

**2. Placeholder scan:** Search your plan for red flags — any of the patterns from the "No Placeholders" section above. Fix them.

**3. Type consistency:** Do the types, method signatures, and property names you used in later tasks match what you defined in earlier tasks? A function called \`clearLayers()\` in Task 3 but \`clearFullLayers()\` in Task 7 is a bug.

If you find issues, fix them inline. No need to re-review — just fix and move on. If you find a spec requirement with no task, add the task.

---

## Moe integration

In Moe, the architect's plan is submitted via \`moe.submit_plan\` as \`implementationPlan.steps\`. Each step in this skill maps to one Moe step:

- **Title** → step \`title\`
- **Files** + **code blocks** → step \`description\` (paste the code in the description so the worker doesn't re-derive it)
- **Test files** → step \`affectedFiles\`
- **Run commands** → step \`description\` ("Run X, expect Y")

Use the **Moe-native \`moe-planning\` skill** for the higher-level 8-phase template (plan → explore → tests → … → adversarial review → QA loop). Use this \`writing-plans\` skill for the inside-the-step granularity (RED-GREEN-REFACTOR + commit per logical concern).

The \`moe-planning\` skill is the architect's entry point; \`writing-plans\` is its detail-level companion.`,
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
      "name": "brainstorming",
      "description": "Vendored from superpowers. Socratic questions to refine vague requirements before any plan is written.",
      "role": "architect",
      "triggeredBy": ["task with sparse acceptanceCriteria"]
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
    },
    {
      "name": "dispatching-parallel-agents",
      "description": "Vendored from superpowers. Fan-out for 2+ independent tasks with no shared state or sequential dependencies.",
      "role": "architect",
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

- \`brainstorming/\`
- \`dispatching-parallel-agents/\`
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
      fs.writeFileSync(fullPath, content);
    }
  }

  // Write manifest (skip if already exists — user may have customized).
  const manifestPath = path.join(skillsDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    fs.writeFileSync(manifestPath, SKILL_MANIFEST);
  }

  // Write attribution.
  const licensePath = path.join(skillsDir, 'LICENSE-VENDORED.md');
  if (!fs.existsSync(licensePath) && SKILL_LICENSE) {
    fs.writeFileSync(licensePath, SKILL_LICENSE);
  }
}
