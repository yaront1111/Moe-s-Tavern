# Moe Memory System

Moe agents keep cross-session memory in a per-project knowledge store. The more agents work on a project, the more shared context accumulates — conventions, gotchas, decisions, and end-of-session handoffs survive between agent runs.

> **What changed:** Moe no longer ships a native knowledge base. The old `moe.remember` / `moe.recall` / `moe.reflect` / `moe.save_session_summary` tools, the `MemoryManager`, the `.moe/memory/` store, BM25 search, confidence scoring, and auto-injection into `moe.get_context` have all been **removed**. Cross-session memory is now delegated to the **Serena MCP server**.

## The Problem

AI agents are stateless. Every session starts from zero. An architect spends minutes exploring the codebase, discovers critical patterns, creates a plan, then the session ends. All that exploration knowledge is lost. The next agent rediscovers the same patterns from scratch. Workers hit the same gotchas. Knowledge is discovered, used, and discarded, over and over.

## The Solution: Serena's Memory Tools

Memory is provided by [Serena](https://github.com/oraios/serena), the same MCP server that gives agents LSP-backed symbol navigation. The agent launchers (`scripts/moe-agent.ps1` / `scripts/moe-agent.sh`) inject Serena — pinned to the project — for the `claude`, `codex`, and `gemini` CLIs. If Serena is not installed, the launchers **no-op** and agents simply run without cross-session memory (everything else still works).

### Where memory lives

A flat, per-name markdown store at:

```
.serena/memories/<topic>.md
```

One topic per file. There is no index file, no JSONL, and no database — just markdown files you can read in a plain editor.

### The tools

Serena exposes five memory tools (all callable by any role):

| Tool | Purpose |
|------|---------|
| `list_memories` | List the names of all stored memory files. |
| `read_memory` | Read one memory file by name. |
| `write_memory` | Create or overwrite a memory file. |
| `edit_memory` | Update part of an existing memory file in place. |
| `delete_memory` | Remove a memory file. |

There is **no BM25 ranking and no auto-injection**. Nothing surfaces in `moe.get_context` automatically. Agents discover what exists by calling `list_memories` and pull the relevant file with `read_memory`. **Naming discipline replaces ranking** — see below.

## Naming Convention

Because there is no search ranking, the file name *is* the index. Agents follow these conventions so the right memory is obvious from `list_memories` alone:

| Pattern | Use For |
|---------|---------|
| `convention-<area>` | Code patterns and style rules (e.g. `convention-state-mutations`) |
| `gotcha-<area>` | Surprising behavior and pitfalls (e.g. `gotcha-filewatcher-debounce`) |
| `pattern-<area>` | Reusable implementation patterns (e.g. `pattern-mcp-tools`) |
| `decision-<area>` | Why something was done a certain way (e.g. `decision-jsonl-over-sqlite`) |
| `task-<taskId>-handoff` | End-of-session handoff for a specific task (replaces `save_session_summary`). |
| `epic-<epicId>-notes` | Cross-task knowledge scoped to an epic. |

Rules of thumb:
- **One topic = one file.** Keep each memory focused on a single subject.
- **Prefer `edit_memory` over near-duplicates.** If a memory on the topic already exists, update it instead of creating `gotcha-foo-2`.
- Keep entries concise and high-signal. Don't record generic progress or obvious completion notes.

## Workflow

### Pull on start

When picking up work, list and read the relevant memories before exploring or planning:

1. `list_memories` to see what knowledge exists.
2. `read_memory` for entries matching your task area (`convention-*`, `gotcha-*`, `pattern-*`, `decision-*`).
3. If you claimed a task that was previously worked on, `read_memory { name: "task-<taskId>-handoff" }` first so you don't redo finished work.

### Write before finish

When you discover something reusable, or before you stop, persist it:

1. During work: `write_memory` (or `edit_memory`) a `convention-*` / `gotcha-*` / `pattern-*` / `decision-*` entry for anything the next agent should know.
2. Before stopping: `write_memory { name: "task-<taskId>-handoff" }` summarizing what you accomplished, what remains, and key findings. **The next agent on this task reads it** — this is the direct replacement for `moe.save_session_summary`.

### Handoff convention (replaces save_session_summary)

There is no longer a dedicated session-summary tool. Instead, end-of-session continuity is a plain memory file named `task-<taskId>-handoff`. Write it before you wait or shut down; the next agent reads it on pickup. Use `epic-<epicId>-notes` for knowledge that spans multiple tasks in an epic.

## Role-Specific Guidance

### Architects
- Before planning: `list_memories` + `read_memory` for relevant `convention-*` / `gotcha-*` / `pattern-*` / `decision-*` entries.
- During exploration: `write_memory` conventions, gotchas, and patterns discovered.
- On plan submission: include `planningNotes` with analysis and reasoning (see below).
- Before waiting: `write_memory { name: "task-<taskId>-handoff" }`.

### Workers
- Before implementing: read relevant memories and the `task-<taskId>-handoff` if one exists, plus `planningNotes`.
- During implementation: `write_memory`/`edit_memory` gotchas and patterns discovered.
- Before completing or stopping: `write_memory { name: "task-<taskId>-handoff" }`.

### QA
- Before reviewing: read relevant memories for known issues.
- During review: `write_memory`/`edit_memory` recurring issue patterns as `gotcha-*` entries.
- Before stopping: `write_memory { name: "task-<taskId>-handoff" }`.

## Architect-to-Worker Handoff (planningNotes)

When architects submit plans, they can include `planningNotes` directly on the task — this is separate from Serena memory and rides on `moe.submit_plan`:

```
moe.submit_plan {
  taskId: "task-xxx",
  steps: [...],
  planningNotes: {
    approachesConsidered: "Evaluated direct file writes vs mutex-protected. Chose mutex to match existing StateManager pattern.",
    codebaseInsights: "All state mutations go through runExclusive(). FileWatcher has 150ms debounce.",
    risks: "Migration might fail on projects with >100 channels due to batch size.",
    keyFiles: ["src/state/StateManager.ts", "src/state/FileWatcher.ts"]
  }
}
```

Workers see `planningNotes` in `moe.get_context` responses, giving them the architect's full reasoning, not just the plan steps.

## Migration from the old native KB

If a project still has a `.moe/memory/knowledge.jsonl` from the previous native memory system, it is simply **no longer read** — the daemon does not auto-delete it. To carry forward high-value knowledge:

1. Open `.moe/memory/knowledge.jsonl` and pick the entries still worth keeping.
2. For each, `write_memory` a corresponding `.serena/memories/<topic>.md` file using the naming convention above (one topic per file).
3. Once migrated, you may delete `.moe/memory/` manually.

## Caveats

- **No auto-surfacing.** Memory never appears in `moe.get_context` automatically; agents must call `list_memories` / `read_memory`. Naming discipline is what makes the right file discoverable.
- **No ranking, confidence, or dedup.** There is no relevance score and no automatic merging. Avoid near-duplicates by preferring `edit_memory`.
- **No-op without Serena.** If Serena is not installed (`uv tool install -p 3.13 serena-agent`), the launchers skip injecting it and agents run without cross-session memory.
