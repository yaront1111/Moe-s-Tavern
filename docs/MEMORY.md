# Moe Memory System

Moe agents build a persistent knowledge base for each project. The more agents work on a project, the smarter they get.

## The Problem

AI agents are stateless. Every session starts from zero. An architect spends minutes exploring the codebase, discovers critical patterns, creates a plan, then the session ends. All that exploration knowledge is lost. The next agent rediscovers the same patterns from scratch. Workers hit the same gotchas. Knowledge is discovered, used, and discarded, over and over.

## The Solution: Three-Layer Memory

```
 LONG-TERM   .moe/memory/knowledge.jsonl
             Conventions, gotchas, patterns, decisions
             BM25-indexed, confidence-scored, self-curating

 MEDIUM-TERM planningNotes on task + session summaries
             Architect reasoning flows to workers and QA
             Session summaries enable agent continuity

 SHORT-TERM  Auto-injected via moe.get_context
             Top 5 relevant memories surface automatically
             Last session summary for task continuity
```

## How It Works

### Agents Save Knowledge

When an agent discovers something worth sharing:

```
moe.remember {
  content: "StateManager uses AsyncMutex.runExclusive() for all state mutations",
  type: "convention",
  workerId: "architect-1",
  files: ["src/state/StateManager.ts"]
}
```

### Knowledge Auto-Surfaces

When any agent calls `moe.get_context`, the system automatically searches the knowledge base using the task title, description, and affected files. The top 5 relevant memories appear in the response:

```json
{
  "task": { ... },
  "memory": {
    "relevant": [
      {
        "id": "mem-abc123",
        "type": "convention",
        "content": "StateManager uses AsyncMutex.runExclusive() for all state mutations",
        "confidence": 1.45
      },
      {
        "id": "mem-def456",
        "type": "gotcha",
        "content": "FileWatcher debounce is 150ms, tests need 200ms wait after file changes",
        "confidence": 1.15
      }
    ],
    "lastSession": {
      "summary": "Previous architect explored concurrency patterns. All mutations use mutex."
    }
  }
}
```

Agents don't have to remember to search, the system does it for them.

### Knowledge Self-Curates

Memories evolve based on agent feedback:

```
moe.reflect { memoryId: "mem-abc123", helpful: true, workerId: "worker-1" }
```

- **Helpful** (+0.15 confidence, cap 2.0): Memory surfaces more prominently
- **Unhelpful** (-0.25 confidence, floor 0.0): Memory fades from results
- Memories below 0.3 confidence are excluded from search results
- At 3000 entries, the lowest-value memories are archived automatically

Over time, the best knowledge rises and bad knowledge disappears. No manual curation needed.

## Memory Types

| Type | Use For | Example |
|------|---------|---------|
| `convention` | Code patterns and style rules | "This project uses guard clauses, not nested if/else" |
| `gotcha` | Surprising behavior and pitfalls | "fs.renameSync fails cross-device on Linux" |
| `pattern` | Reusable implementation patterns | "All MCP tools follow the ToolDefinition pattern in tools/" |
| `decision` | Why something was done a certain way | "Chose JSONL over SQLite for activity log for simplicity" |
| `procedure` | Learned workflows and techniques | "Run tsc before lint, catches more issues faster" |
| `insight` | Cross-task observations | "Tasks in this epic tend to touch StateManager + WebSocketServer together" |

## MCP Tools

### moe.remember

Save knowledge to the project knowledge base.

```
moe.remember {
  content: "...",           // Max 2000 chars
  type: "convention",       // convention | gotcha | pattern | decision | procedure | insight
  workerId: "worker-1",
  tags: ["optional"],       // Auto-generated if omitted
  taskId: "task-xxx",       // Optional context
  files: ["src/foo.ts"]     // Optional related files
}
```

Automatically deduplicates: if >70% similar content exists, merges instead of creating a new entry (confidence is boosted).

### moe.recall

Search for specific knowledge beyond what auto-surfaces in `get_context`.

```
moe.recall {
  query: "mutex concurrency state management",
  types: ["convention", "gotcha"],   // Optional type filter
  files: ["src/state/StateManager.ts"],  // Boosts file-relevant results
  limit: 10
}
```

Uses BM25 ranking with composite scoring: text relevance (45%) + tag match (15%) + file overlap (15%) + recency (10%) + quality (15%).

### moe.reflect

Rate a memory to adjust its future relevance.

```
moe.reflect { memoryId: "mem-xxx", helpful: true, workerId: "worker-1" }
```

### moe.save_session_summary

Save a session wrap-up so the next agent on this task can resume with context.

```
moe.save_session_summary {
  workerId: "worker-1",
  taskId: "task-xxx",
  summary: "Completed 4/6 steps. Key finding: FileWatcher needs 200ms delay in tests."
}
```

## Architect-to-Worker Handoff

When architects submit plans, they can include `planningNotes`:

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

## Role-Specific Guidance

### Architects
- Before planning: check `memory.relevant` in `get_context`
- During exploration: `moe.remember` conventions, gotchas, patterns discovered
- On plan submission: include `planningNotes` with analysis and reasoning
- Before waiting: `moe.save_session_summary`

### Workers
- Before implementing: check `memory.relevant` and `planningNotes`
- Rate recalled memories: `moe.reflect { helpful: true/false }`
- During implementation: `moe.remember` gotchas and procedures discovered
- Before completing: `moe.save_session_summary`

### QA
- Before reviewing: check `memory.relevant` for known issues
- During review: `moe.remember` recurring issue patterns as gotchas
- After review: `moe.save_session_summary`

## Technical Details

### Search Algorithm

The knowledge base uses **BM25** (Okapi) for text ranking, the same algorithm used by Elasticsearch and Apache Lucene. Key features:

- **CamelCase-aware tokenizer**: "StateManager" splits into "state" + "manager"
- **Minimal stemmer**: 10 suffix rules handle common English inflections
- **Stop word removal**: ~100 common English words filtered
- **Composite scoring**: BM25 text relevance + tag match + file path overlap + recency decay (30-day half-life) + confidence/helpfulness

### Storage

- **Format**: JSONL (one JSON object per line) at `.moe/memory/knowledge.jsonl`
- **Index**: Fully in-memory inverted index built on daemon start
- **Persistence**: Appends are immediate; updates debounced (5s) with atomic rename
- **Pruning**: At 3000 entries, lowest-value entries are archived to `knowledge.archive.jsonl`
- **Deduplication**: Content hash + Jaccard similarity (>70% threshold)

### No External Dependencies

The entire memory system is pure TypeScript with zero external dependencies. No vector database, no SQLite, no Redis. The in-memory index handles thousands of entries with sub-millisecond search performance.
