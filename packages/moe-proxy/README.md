# moe-proxy

Part of [Moe's Tavern](https://github.com/yaront1111/Moe-s-Tavern), an AI agent task board for Claude Code, Codex, Antigravity and Grok Build. This package is the MCP stdio proxy an agent CLI speaks to; it forwards every `moe.*` call to the daemon.

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

Send one message per line. The proxy refuses a JSON-RPC batch (a JSON array) and forwards none of it: each request in the batch gets a `-32600` error, all in one array, or one null-id error when the batch holds no request. Its per-message steps (`workerId`, timeouts, the shutdown drain, execution identity) read single messages, so a batch would otherwise reach the daemon without them.

## Environment Variables

- `MOE_PROJECT_PATH` - Project path, where the proxy reads `.moe/daemon.json` (default: the current directory)
- `MOE_DAEMON_HOST` - Daemon host (default: 127.0.0.1)
- `MOE_WORKER_ID` - Launcher-set. The seat's worker id, added as `workerId` to every `tools/call` that omits one, and to `tools/list` so the daemon lists only the tools for the seat's role. `moe.get_activity_log` never gets it, because its `workerId` is a filter. A blank value counts as unset
- `MOE_RUNNER_PROCESS_STARTED_AT` and `MOE_RUNNER_HOST` - Launcher-set, for architect, QA and governor seats only. The runner identity, added as `processStartedAt` and `host` to a `moe.claim_next_task` that names neither key, so a task claimed inside the session can be reattached after a daemon restart. Both must be non-blank, or neither is sent
- `MOE_SESSION_ID` - The session id the proxy stamps onto the identity tools (see Execution identity)
- `MOE_ATTEMPT_ID` and `MOE_ATTEMPT_GENERATION` - The execution attempt the proxy stamps onto the identity tools; set both or neither
- `MOE_WORKER_TYPE` - The agent CLI the launcher started, added to the registration tools (see Worker type)
- `MOE_BLOCKING_TIMEOUT_MS` - The per-request deadline of `moe.wait_for_task`, `moe.chat_wait` and `moe.wait_for_resource` (default: 660000)
- `MOE_MESSAGE_TIMEOUT_MS` - The per-request deadline of every other request; when it passes, the proxy answers that request with a `Request timed out` error (default: 30000). It also bounds the WebSocket handshake, to at most 10 seconds (see Reconnects)
- `MOE_TOOL_NAME_STYLE` - Launcher-set for grok. `underscore` exposes each `moe.<name>` tool as `moe_<name>` in `tools/list` and maps the alias back on `tools/call`, for clients that drop dotted tool names. Any other value, or none, keeps the daemon's names
- `MOE_PROXY_ONESHOT_DEADLINE_MS` - Wrapper-only. An absolute bound for one call, in Unix epoch milliseconds, covering connect, queue, send and the EOF drain (see One-shot calls). Blank means unset; any other value that is not plain decimal digits forming a safe integer fails closed (one null-id error, exit 1, no connection)

The daemon port always comes from `.moe/daemon.json`; no environment variable overrides it.

## Reconnects

The proxy keeps retrying, for up to 5 minutes, while the daemon is down or restarting:

- `.moe/daemon.json` is missing, cannot be read for a moment (`ENOENT`, `EBUSY`, `EPERM` or `EACCES`, as when a restart replaces it on Windows), or is not complete JSON yet. A file that names another project, is over 64 KiB, or holds invalid connection details still ends the proxy at once.
- The daemon refuses the connection, or accepts it but does not answer the WebSocket handshake within `MOE_MESSAGE_TIMEOUT_MS` (at most 10 seconds), as a frozen daemon does.

A message written while no connection is open waits in a queue (at most 100) and is sent once one opens. A request in the queue gets the same `Request timed out` error when its deadline (`MOE_MESSAGE_TIMEOUT_MS`, or `MOE_BLOCKING_TIMEOUT_MS` for the three blocking tools) passes, and is then never sent. Requests already sent when a connection drops get a `Connection to daemon lost` error at once.

## One-shot calls

The wrappers' RPC helpers pipe one bare `tools/call` into a fresh proxy and close stdin. In a session that never sent `initialize`, stdin EOF does not cut short a request the proxy has already sent to the daemon: it finishes up to its own deadline (`MOE_MESSAGE_TIMEOUT_MS`, or `MOE_BLOCKING_TIMEOUT_MS` for the three blocking tools), the same deadline it gets without EOF. It fails at once if the daemon socket is lost. A message still queued, because no daemon connection is open, keeps the 2-second drain, so a call to an unreachable daemon returns quickly. Initialized MCP sessions keep the 2-second drain for every request, and SIGINT/SIGTERM cap any drain at 2 seconds.

The proxy exits 0 only after its stdout has drained, so a reader that starts late still gets all of a reply bigger than the OS pipe buffer (about 64 KiB on Linux). A reader that stops reading gets 2 seconds; then the proxy exits 1, because the reply may be incomplete. A reader that closes the pipe (EPIPE) gets exit 1, as before.

When `MOE_PROXY_ONESHOT_DEADLINE_MS` passes, the proxy writes one `Proxy deadline exceeded (MOE_PROXY_ONESHOT_DEADLINE_MS)` error for each pending request id (one null-id error when none is pending, as before the first connect) and exits 1. No late success follows.

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

The error carries `error.data = { tool, codeName }`. A JSON-RPC batch is fenced per element, and one refusal drops the whole frame; a batch that passes the fence is still refused (see Usage). With no identity env the proxy is the legacy proxy: it adds nothing, the daemon decides, and the line is forwarded byte-for-byte unless another step (alias rename, `workerId`, runner identity or worker type) already rewrote it.

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
