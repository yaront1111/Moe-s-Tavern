# Moe Project Context

## Architecture
Moe is an AI Workforce Command Center. Components:
- **Daemon** (Node.js): Manages `.moe/` state files, serves WebSocket endpoints
- **Proxy** (Node.js): Bridges MCP stdio to daemon WebSocket (`/mcp`)
- **Plugin** (Kotlin): JetBrains IDE UI for task board and agent management
- **Agents**: AI workers that interact via MCP tools through the proxy

The `.moe/` folder is the **source of truth**. The daemon is the sole writer.

## Data Access
- **Always call `moe.get_context` first** to load task details, rails, and plan
- Use `moe.list_tasks` to see epic progress and find related tasks
- Use `moe.get_activity_log` to see what happened before (especially after reopens)
- Step notes from previous workers are in `implementationPlan[].note`

## Workflow
```
BACKLOG -> PLANNING -> AWAITING_APPROVAL -> WORKING -> REVIEW -> DONE
```
- Architects create plans (PLANNING -> AWAITING_APPROVAL)
- Humans approve/reject plans
- Workers execute approved plans (WORKING -> REVIEW)
- QA verifies and approves/rejects (REVIEW -> DONE or back to WORKING)

## Constraints
- **Global rails**: Forbidden patterns are enforced (no eval, innerHTML, etc.)
- **Required patterns**: Plans must address error handling and testing
- **Epic/task rails**: Guidance specific to the current work

## Quality Standards
- Run tests before and after changes
- Handle errors explicitly
- Follow existing code conventions
- Track all modified files

## Startup (Do This First)

Before claiming tasks, announce yourself in #general:
1. `moe.chat_channels` — find the channel with `type: "general"`
2. `moe.chat_join { channel: "<id>", workerId: "<your-id>" }`
3. `moe.chat_send { channel: "<id>", workerId: "<your-id>", content: "Online as <role>. Ready to work." }`

## Chat Communication

The project has a `#general` channel for cross-role announcements. Tasks and epics have auto-created channels for task-specific discussion.

### After Claiming a Task
Read the task channel for context (especially on reopened tasks):
```
moe.chat_read { channel: "<channelId from claim>", workerId: "<your-id>" }
```

### Mention Syntax
- `@worker-id` — specific worker
- `@architects` / `@workers` / `@qa` — role groups
- `@all` — all online workers

### Loop Guard
Max 4 agent-to-agent messages per channel before a human must intervene. Do not try to work around this.

### Mention Response Protocol (required)

**When another agent or human tags you** — your workerId appears in the message, or a group you belong to (`@workers`, `@architects`, `@qa`, `@all`) is tagged — you MUST reply via `moe.chat_send` in the same channel before you call any other planned tool.

- Replies are substantive: answer the question, confirm the handoff, or say why you can't. Empty ACKs ("OK", "Got it") are still forbidden.
- The Loop Guard (max 4 agent-to-agent hops per channel) prevents runaway chains — you do not need to add your own throttling.
- If you are mid-step on a task when a reply is required (e.g., `moe.wait_for_task` wakes with `hasChatMessage:true` or preflight shows a `<routed_mentions>` block), finish the current tool call in flight, then reply, then resume.
- Do NOT claim a new task while routed mentions are unanswered.

### Rules
**DO:** Reply when tagged. Read task channel after claiming. Send messages for handoff notes, questions, or clarifications. Ask a question via chat when you need info another agent has.
**DO NOT:** Send progress updates (system posts those). Start casual/unsolicited agent-to-agent threads (the "no multi-turn chatter" rule — this is NOT an excuse to skip a reply when tagged). Send empty acknowledgments ("OK", "Got it").

## Project Memory (Required)

You MUST use the shared knowledge base on every task. This is not optional.

**Required actions every task:**
1. **Recall** — After `moe.get_context`, check `memory.relevant` in the response. Use `moe.recall` for deeper search if needed.
2. **Reflect** — If a surfaced memory was helpful, call `moe.reflect { memoryId, helpful: true }`. If wrong/outdated, `moe.reflect { memoryId, helpful: false }`.
3. **Remember** — When you discover conventions, gotchas, patterns, or decisions, save them with `moe.remember` immediately.
4. **Summarize** — Before calling `moe.wait_for_task`, call `moe.save_session_summary` with what you accomplished and discovered.

**Tools:**
- `moe.remember` — Save a learning (convention, gotcha, pattern, decision, procedure, insight)
- `moe.recall` — Search for specific knowledge beyond what auto-surfaces
- `moe.reflect` — Rate a memory as helpful/unhelpful (improves future relevance)
- `moe.save_session_summary` — Summarize what you did before ending your session

Memories gain confidence when marked helpful, lose it when marked unhelpful. The best knowledge naturally rises to the top over time. See your role doc for specific guidance.
