# moe-daemon

Moe daemon - MCP + WebSocket state manager for AI task orchestration.

## Installation

```bash
npm install -g moe-daemon
```

Or use npx:
```bash
npx moe-daemon start --project /path/to/project
```

## CLI Commands

### Start Daemon

```bash
moe-daemon start --project /path/to/project [--port 9876]
```

Starts the daemon for a project. Creates `.moe/daemon.json` with connection info.

Options:
- `--project, -p` - Project path (required)
- `--port` - Port number (default: auto-detect starting at 9876)

### Check Status

```bash
moe-daemon status --project /path/to/project
```

Shows daemon running status and port.

### Stop Daemon

```bash
moe-daemon stop --project /path/to/project
```

Stops the running daemon.

## Architecture

The daemon serves two WebSocket endpoints:

- `/ws` - For IDE plugins (JetBrains, VS Code)
- `/mcp` - For MCP clients (AI agents via moe-proxy)

The daemon is the sole writer of `.moe/` files. All clients send actions to the daemon.

## Configuration

The daemon reads and writes to the `.moe/` directory:

```
.moe/
├── project.json     # Project metadata
├── daemon.json      # Runtime: { port, pid, startedAt }
├── epics/*.json     # Epic definitions
├── tasks/*.json     # Task definitions
└── activity.log     # Event log
```

## Environment Variables

### Logging
- `MOE_LOG_LEVEL` - Log level (debug, info, warn, error). Default: `info`

### Network Configuration
- `MOE_DEFAULT_PORT` - Default port to start on. Default: `9876`
- `MOE_PORT_RANGE` - Number of ports to try if default is taken. Default: `50`
- `MOE_PROJECT_PATH` - Default project path (can be overridden by --project flag)

### Timeouts (all values in milliseconds)
- `MOE_SOCKET_TIMEOUT_MS` - Timeout for individual socket connections. Default: `200`
- `MOE_PORT_CHECK_INTERVAL_MS` - Interval between port availability checks. Default: `100`
- `MOE_PORT_READY_TIMEOUT_MS` - Total timeout waiting for port to be ready. Default: `5000`
- `MOE_LOCK_RETRY_DELAY_MS` - Delay before retrying when another daemon is starting. Default: `2000`
- `MOE_SHUTDOWN_TIMEOUT_MS` - Maximum time to wait for graceful shutdown. Default: `10000`

## Cross-Platform Support

Works on Windows, Mac, and Linux. Paths are normalized internally.

## License

MIT
