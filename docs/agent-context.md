# Moe Project Context

## Architecture
- **Daemon** (Node.js): Owns `.moe/`. Sole writer.
- **Proxy** (Node.js): Bridges MCP stdio ↔ daemon WebSocket.
- **Plugin** (Kotlin / VS Code): IDE UI for the task board.
- **Agents**: AI workers that interact via Moe MCP tools through the proxy.

The `.moe/` folder is the source of truth. NEVER read or write `.moe/` files directly — use the Moe MCP tools (`moe.*`). Bash/grep/python on `.moe/` is a violation.

## Memory tools (Serena MCP — use selectively)
Cross-session memory is provided by the **Serena MCP server** (injected by the agent launchers), backed by a flat per-name markdown store at `.serena/memories/*.md`. There is no auto-injection into `moe.get_context` — call `list_memories` to discover what exists, then `read_memory` what's relevant.
- `list_memories` / `read_memory` — on start, pull memories matching your task area before exploring or planning.
- `write_memory` / `edit_memory` — save high-signal reusable learnings only. Name them `convention-<area>`, `gotcha-<area>`, `pattern-<area>`, or `decision-<area>` (one topic per file; prefer `edit_memory` over near-duplicates). Do not save generic progress or obvious completion notes.
- `write_memory { name: "task-<taskId>-handoff" }` — before `moe.wait_for_task` (or shutting down), write a handoff so the next agent picks up where you left off. This replaces the old session-summary tool.
- `delete_memory` — remove a stale memory file.
- No-op if Serena isn't installed; everything else still works.

## Loop Guard
Max 4 agent-to-agent chat hops per channel before a human must intervene. Don't try to work around it.
