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
| Parallel work isolation | `using-git-worktrees` | When concurrent workers would step on each other |

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
