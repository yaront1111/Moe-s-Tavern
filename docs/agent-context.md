# Moe Project Context

## Architecture
- **Daemon** (Node.js): Owns `.moe/`. Sole writer.
- **Proxy** (Node.js): Bridges MCP stdio ↔ daemon WebSocket.
- **Plugin** (Kotlin / VS Code): IDE UI for the task board.
- **Agents**: AI workers that interact via Moe MCP tools through the proxy.

The `.moe/` folder is the source of truth. NEVER read or write `.moe/` files directly — use the Moe MCP tools (`moe.*`). Bash/grep/python on `.moe/` is a violation.

## Memory tools (use selectively)
- `get_context.memory.relevant` is compact by default. Call `moe.recall` only when a preview looks useful.
- `moe.remember` — save high-signal reusable learnings only (convention, gotcha, pattern, decision). Do not save generic progress or obvious completion notes.
- `moe.reflect { memoryId, helpful: true|false }` — rate a surfaced memory; raises/lowers its future-recall confidence.
- `moe.save_session_summary` — call before `moe.wait_for_task` so the next agent picks up where you left off.

## Loop Guard
Max 4 agent-to-agent chat hops per channel before a human must intervene. Don't try to work around it.
