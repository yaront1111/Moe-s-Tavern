# moe-proxy

Part of [Moe's Tavern](https://github.com/yaront1111/Moe-s-Tavern), an AI agent task board for Claude Code, Codex, Gemini CLI and Grok Build. This package is the MCP stdio proxy an agent CLI speaks to; it forwards every `moe.*` call to the daemon.

## Installation

```bash
npm install -g moe-proxy
```

Or use npx:
```bash
npx moe-proxy
```

## Usage

The proxy connects to the Moe daemon via WebSocket and exposes MCP tools over stdio.

### With Claude Code

Add to `~/.config/claude/mcp_servers.json`:

```json
{
  "moe": {
    "command": "moe-proxy",
    "env": {
      "MOE_PROJECT_PATH": "/path/to/your/project"
    }
  }
}
```

### Direct Usage

```bash
MOE_PROJECT_PATH=/path/to/project moe-proxy
```

Send JSON-RPC 2.0 messages via stdin:

```json
{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"moe.list_tasks","arguments":{}}}
```

## Environment Variables

- `MOE_PROJECT_PATH` - Project path (required)
- `MOE_DAEMON_HOST` - Daemon host (default: 127.0.0.1)
- `MOE_DAEMON_PORT` - Daemon port (default: read from .moe/daemon.json)
- `MOE_SESSION_ID` - The session id the proxy stamps onto the identity tools (see Execution identity)
- `MOE_ATTEMPT_ID` and `MOE_ATTEMPT_GENERATION` - The execution attempt the proxy stamps onto the identity tools; set both or neither
- `MOE_WORKER_TYPE` - The agent CLI the launcher started, added to the registration tools (see Worker type)

## Execution identity

The runner, never the CLI caller, owns the session's execution identity. `scripts/moe-agent.{sh,ps1}` export the three variables above for the seat, and the proxy stamps their values onto the tools below. A blank value counts as unset.

| Env value | Rule |
|-----------|------|
| `MOE_SESSION_ID` | At most 255 characters, no NUL, CR or LF. Sent verbatim as `sessionId`. |
| `MOE_ATTEMPT_ID` + `MOE_ATTEMPT_GENERATION` | Both or neither. `attemptId` matches `[A-Za-z0-9_-]{1,128}`. `generation` is a positive safe integer in plain decimal digits (no sign, no leading zero), sent as a JSON number. |

| Tool | Stamped fields |
|------|----------------|
| `moe.get_context` | `sessionId` |
| `moe.start_step`, `moe.complete_step`, `moe.complete_task` | `attemptId`, `generation`, `sessionId` |
| `moe.qa_approve`, `moe.qa_reject` | `attemptId`, `generation`, `sessionId` |

This holds under every spelling (`moe.x`, `moe_x` and bare `x`) and covers no other tool. A field whose env group is absent is not stamped, and a value the caller presents for it reaches the daemon untouched. Under verified-local the daemon requires QA's own identity on `moe.qa_approve` and `moe.qa_reject` (CQ-V06); under legacy and observe a presented attempt still gets the daemon's `ATTEMPT_SUPERSEDED` freshness check, as `moe.complete_task` does.

A presented field must equal the stamped env value exactly (`===`: `"7"` does not match `7`). Anything else is refused before the call is forwarded, and nothing is mutated or echoed:

- `EXECUTION_IDENTITY_SUBSTITUTED` (JSON-RPC `-32003`): a presented `attemptId`, `generation` or `sessionId` differs from the session's value. Omit the field so the proxy supplies it.
- `EXECUTION_IDENTITY_INVALID` (`-32602`): the env group a tool carries is malformed or partial, or the check hit an unexpected error (it fails closed). A broken attempt group refuses only the tools that carry it, so `moe.get_context` still gets its `sessionId`.

The error carries `error.data = { tool, codeName }`. A JSON-RPC batch is fenced per element, and one refusal drops the whole frame. With no identity env the proxy is the legacy proxy: it adds nothing, the daemon decides, and the line is forwarded byte-for-byte unless another step (alias rename, `workerId`, runner identity or worker type) already rewrote it.

## Worker type

The proxy adds `workerType` from `MOE_WORKER_TYPE` to `moe.claim_next_task` and `moe.join_team`, under every spelling (`moe.x`, `moe_x` and bare `x`). It does so even when the call names its own `workerId`, as the wrapper's pre-flight claim and join always do. No other tool, no `tools/list` and no JSON-RPC batch gets it.

- A blank or unset value adds nothing.
- A `workerType` key the caller already set is forwarded untouched, whatever its value.
- The value is sent verbatim: never trimmed, re-cased or checked.

The launcher (`scripts/moe-agent.{sh,ps1}`) owns the value, the CLI it started. The daemon owns validation (exactly `CLAUDE`, `CODEX`, `GEMINI` or `GROK`; anything else registers as `CLAUDE`) and records or refreshes `worker.type`. See `moe.claim_next_task` and `moe.join_team` in [`docs/MCP_SERVER.md`](../../docs/MCP_SERVER.md). It is registration metadata: unlike the execution identity it is never compared or refused, and it authorizes nothing.

## MCP Tools

| Tool | Description |
|------|-------------|
| `moe.get_context` | Get project context and current task |
| `moe.list_tasks` | List all tasks |
| `moe.claim_next_task` | Claim next available task |
| `moe.submit_plan` | Submit implementation plan |
| `moe.check_approval` | Check if plan is approved |
| `moe.start_step` | Start working on a step |
| `moe.complete_step` | Mark step as complete |
| `moe.complete_task` | Mark task as complete |
| `moe.report_blocked` | Report task is blocked |

## Cross-Platform Support

Works on Windows, Mac, and Linux via npm scripts.

## License

MIT
