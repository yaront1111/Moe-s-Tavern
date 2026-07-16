<!-- moe-generated: sha=81ea7e05636b -->

# Governor — Reference

Deep-dive material trimmed out of `governor.md`. Read this on demand when a situation calls for it; it is not loaded into your system prompt every turn.

## Stale-worker handling

The daemon does **not** auto-release WORKING/PLANNING tasks on idle time — a long-running worker keeps its task no matter how quiet it goes. Crash recovery is already layered without you: daemon restart purges all workers and releases their tasks; graceful exits call `moe.deregister_worker` from the wrapper's exit trap; a crashed QA's REVIEW task self-heals after `reviewStaleTimeoutMs` (30 min default); and live CLIs run a heartbeat sidecar that pings `moe.heartbeat` every 60s even during silent local steps. Your job on a ⚠️ alert is triage, not reaping.

**Idle time alone — any amount, any multiple of the presence window — is never grounds for `release_task`.** A stale flag means "no tool call or heartbeat lately," which is compatible with a worker deep in a long build whose sidecar is disabled or past its 2h bound. Releasing such a worker destroys real in-flight work and strands its local state.

What to do instead, in order:

1. **Ping the worker** in `#workers`. Most stale workers answer.
2. **Read the worker record.** `lastError` and `errorCount` are stronger signals than wall-clock silence — `errorCount > 3` with a recent `lastError` is real trouble; quiet-with-no-errors usually is not.
3. **Look for a death signal**: a deregister banner in chat, a wrapper exit, the human confirming the process is gone. No death signal → keep waiting or ask the human.
4. **Release only on a confirmed crash, and with the human's nod.** When you do release, pass a `handoffNote` if any context is recoverable from chat or the task's comments.

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
| Second-guess the architect's plan when the worker hasn't actually stalled | You don't own planning. Workers sometimes look slow but are working. | Wait for a self-reported block or a real death signal. |
| Release a worker because it looks idle | Quiet ≠ dead — long builds/tests are silent, and you'll discard the worker's local edits. | Ping first; release only on a confirmed crash with the human's nod. |
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