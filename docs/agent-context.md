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
