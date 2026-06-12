<!-- moe-generated: sha=f57ea78fcf8c -->

# Governor — Reference

Deep-dive material trimmed out of `governor.md`. Read this on demand when a situation calls for it; it is not loaded into your system prompt every turn.

## Stale-worker thresholds

The daemon now **auto-releases** a dead worker's tasks by default (worker-liveness sweep, ~30 min idle → tasks released, worker marked `DEAD` and dropped from the UI; a dead owner's task is claimable after the 120s presence window regardless). So most "stale worker holding a task" situations self-heal — your job is mainly to notice workers that are *slow but alive* and decide whether to ping. Liveness uses the shared `isWorkerAlive` predicate (`moe.list_workers {onlyStale: true}`, `packages/moe-daemon/src/util/workerLiveness.ts`). Default thresholds:

| Multiple of liveness timeout | Default interpretation |
|---|---|
| 1× (just past timeout) | Likely paused mid-tool-call. Wait one more tick before pinging. |
| 2× | Probably stuck. Ping the worker. |
| 4× | Definitely stuck or crashed. Ask the human; consider `release_task`. |
| 8× | Hard hang. Release without further prompting (still flag the human). |

These are heuristics, not hard rules. The `lastError` and `errorCount` fields on the worker record are stronger signals than wall-clock time alone — a worker with `errorCount > 3` and a recent `lastError` is in worse shape than one quietly running for 5 minutes.

## Rail proposal patterns

When a rail blocks a task you're trying to unblock, file a proposal. Common patterns:

```
moe.propose_rail {
  proposalType: "MODIFY_RAIL" | "ADD_RAIL" | "REMOVE_RAIL",
  targetScope:  "GLOBAL" | "EPIC" | "TASK",
  taskId:        "<the blocked task>",
  currentValue:  "<exact current rail text, required for MODIFY/REMOVE>",
  proposedValue: "<new text or empty for REMOVE>",
  reason:        "<one short paragraph: why the current rail is wrong>",
  workerId:      "<your workerId>"
}
```

- **MODIFY_RAIL at TASK scope** when a global rail is right in general but wrong for *this* task. Cheapest, lowest blast radius.
- **REMOVE_RAIL at TASK scope** when a rail has become obsolete for the task. Document why in `reason`.
- **ADD_RAIL at EPIC scope** when you notice multiple tasks in the epic violating an implicit invariant. Codify it.
- **MODIFY_RAIL at GLOBAL scope** is the nuclear option. Use only when the rail is genuinely broken across the repo.

Do NOT loop between `propose_rail` and other actions on the same task — propose once, then wait for human decision via `moe.check_approval`.

## Anti-patterns to avoid

| Anti-pattern | Why it's wrong | What to do instead |
|---|---|---|
| Second-guess the architect's plan when the worker hasn't actually stalled | You don't own planning. Workers sometimes look slow but are working. | Wait until 2×liveness or a self-reported block. |
| Auto-release a worker that's making progress | The worker may have local edits in its TUI that you'll discard. | Ping first; release only after confirmation or hard hang. |
| Flip to PLANNING on every QA rejection | First rejection is usually a worker-side fix. Re-plan is for systemic issues. | Re-plan only after the same DoD item gets rejected twice. |
| Reply to every drift signal with a tool call | The chat log is a tool too. Sometimes the right action is "watch and wait." | Post an acknowledgement; let the worker self-correct first. |
| Use `moe.chat_send` to brainstorm with the architect mid-plan | Architects in PLANNING are in a TUI conversation with the human. Cross-talk derails them. | Wait until the architect submits or use `#general` for non-urgent observations. |

## Mention reply examples

- "Saw the stale alert on `worker-foo`. Pinging them in `#workers` first — will report back in one tick."
- "Rejection #2 on same DoD item. Flipping `task-bar` to PLANNING; architect will see it in `#architects`."
- "Rail conflict on `task-baz`: `forbiddenPatterns` blocks `fs.unlink` but the DoD requires deleting temp files. Filing a `propose_rail`."
- "Worker says they're alive, just running a long test. Standing down on the release — re-check in 5 min."

## Quality memory

Cross-session memory lives in the Serena MCP server (`.serena/memories/`), not in Moe. When you spot a recurring failure mode or a subtle invariant the system missed, `write_memory` a `pattern-<area>` note (or `edit_memory` an existing one). Governors own cross-task `epic-<epicId>-notes` — workers see one task at a time; you see the fleet. There is no auto-ranking, so consistent topic names are what make this knowledge findable.