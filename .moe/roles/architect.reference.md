<!-- moe-generated: sha=4cc7254d0592 -->

# Architect — Reference

Deep-dive material trimmed out of `architect.md`. Read this on demand when a situation calls for it; it is not loaded into your system prompt every turn.

## Skill invocation — red flags

If you catch yourself thinking any of these, STOP and load the skill anyway:

| Thought | Reality |
|---|---|
| "This is trivial, I can skip it" | Simple tasks fail when skills are skipped. |
| "I'm blocking, not planning — moe-planning doesn't apply" | moe-planning covers the plan-vs-block decision itself. |
| "I already know what the skill says" | Skills evolve. Read the current version. |
| "I'll invoke it after I check one thing" | No. Before the next tool call. |
| "The reason the daemon gave doesn't quite fit my situation" | The daemon detected your phase from state-machine position. Trust it. |

## Available skills

| Phase | Skill | When to load |
|-------|-------|--------------|
| Drafting the plan | `moe-planning` | After `moe.get_context`, every PLANNING task |
| Naming symbols / referencing existing code | `explore-before-assume` | Before referencing a function, model, attribute, constant |
| Step-level granularity inside the plan | `writing-plans` | Companion to `moe-planning` for fine-grained steps |

## Rail Proposals (escape hatch)

Only when a rail is wrong for this task — not when you can rewrite the plan to satisfy it.

```
moe.propose_rail {
  proposalType: "ADD_RAIL" | "MODIFY_RAIL" | "REMOVE_RAIL",
  targetScope:  "GLOBAL" | "EPIC" | "TASK",
  taskId:        "<the blocked task>",
  currentValue:  "<exact current rail text, required for MODIFY/REMOVE>",
  proposedValue: "<new text or empty for REMOVE>",
  reason:        "<one short paragraph: why the current rail is wrong for this task>",
  workerId:      "<your workerId>"
}
```

The proposal lands in `.moe/proposals/` for human Approve/Reject. Do NOT loop between `submit_plan` and `propose_rail` — pick one and commit.

## Quality memory

Cross-session memory lives in the Serena MCP server (`.serena/memories/`), not in Moe. On task start, `list_memories` / `read_memory` to pick up prior constraints and decisions. When you discover a non-obvious constraint, gotcha, or pattern during exploration, `write_memory` a `decision-<area>` / `gotcha-<area>` note (or `edit_memory` an existing one). Names are the only index — be consistent.

## Mention reply examples

- "Confirmed: `retry-budget = 5`. Updating step 2 now."
- "That step's rail is misread — `requiredPatterns` means the phrase must appear verbatim, not that the test must pass."
- "No, don't split this task; the file-ownership boundary breaks at the schema module. I'll open a separate epic."