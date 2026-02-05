# moe-proxy

MCP stdio proxy for connecting AI agents to the Moe daemon.

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
