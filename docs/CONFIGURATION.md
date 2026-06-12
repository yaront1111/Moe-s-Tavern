# Configuration Reference

This document covers all configuration options for Moe's Tavern.

---

## Environment Variables

### Daemon Configuration

| Variable | Description | Default | Example |
|----------|-------------|---------|---------|
| `MOE_PROJECT_PATH` | Path to project containing `.moe/` folder | Current directory | `/home/user/myproject` |
| `MOE_DEFAULT_PORT` | WebSocket/HTTP server port (auto-scans upward if taken) | `9876` | `9900` |
| `MOE_PORT_RANGE` | How many ports to scan past the default | `50` | `100` |
| `MOE_SHUTDOWN_TIMEOUT_MS` | Grace period for clean shutdown | `10000` | `5000` |
| `MOE_DISABLE_AUTO_RELEASE` | Disable the dead-worker auto-release sweep | unset | `1` |
| `MOE_AUTO_RELEASE_DRY_RUN` | Log what the sweep would release without acting | unset | `1` |
| `LOG_LEVEL` | Logging verbosity | `info` | `debug`, `warn`, `error` |
| `LOG_MAX_SIZE_MB` | Max activity.log size before rotation | `10` | `5` |
| `LOG_RETENTION_COUNT` | Number of rotated logs to keep | `5` | `3` |

(Advanced port/lock tuning: `MOE_SOCKET_TIMEOUT_MS`, `MOE_PORT_CHECK_INTERVAL_MS`, `MOE_PORT_READY_TIMEOUT_MS`, `MOE_LOCK_RETRY_DELAY_MS`, `MOE_LOCK_STALE_TIMEOUT_MS`, `MOE_HTTP_CLOSE_TIMEOUT_MS` — see `packages/moe-daemon/src/index.ts`.)

### Proxy Configuration

| Variable | Description | Default | Example |
|----------|-------------|---------|---------|
| `MOE_PROJECT_PATH` | Project path (used to locate `.moe/daemon.json`) | Current directory | `/home/user/myproject` |
| `MOE_MESSAGE_TIMEOUT_MS` | Per-message timeout for forwarded MCP calls | `30000` | `60000` |
| `MOE_WORKER_ID` | Worker identity injected into every `tools/call` | Set by agent launchers | `worker-1` |

### Agent Scripts

| Variable | Description | Default | Example |
|----------|-------------|---------|---------|
| `MOE_WORKER_ID` | Worker identifier | Generated per launch | `worker-1` |
| `MOE_SERENA_PATH` | Serena binary for the injected MCP server | `~/.local/bin/serena` | `/opt/serena/serena` |
| `MOE_SERENA_PROJECT` | Serena project root override (multi-repo workspaces) | Moe project root | `/repo/backend` |
| `MOE_NODE_COMMAND` | Node.js executable (JetBrains plugin daemon spawn) | `node` | `/usr/local/bin/node` |
| `MOE_DAEMON_COMMAND` | Daemon start command override (JetBrains plugin) | Auto-detected | `npx moe-daemon` |

---

## Usage Examples

### Windows (PowerShell)

```powershell
# Set environment variables
$env:MOE_PROJECT_PATH = "C:\Projects\MyApp"
$env:LOG_LEVEL = "debug"

# Start daemon
node packages\moe-daemon\dist\index.js start --project $env:MOE_PROJECT_PATH
```

### Mac / Linux (Bash)

```bash
# Set environment variables
export MOE_PROJECT_PATH=/home/user/myproject
export LOG_LEVEL=debug

# Start daemon
node packages/moe-daemon/dist/index.js start --project "$MOE_PROJECT_PATH"
```

### Docker (Optional)

If you are using Docker (not required for most users):

```bash
docker run -e MOE_PROJECT_PATH=/project \
           -e LOG_MAX_SIZE_MB=5 \
           -v /your/project:/project \
           moe-daemon
```

---

## Project Configuration (project.json)

The `.moe/project.json` file contains project-specific settings.

```json
{
  "id": "proj-abc123",
  "schemaVersion": 2,
  "name": "My Project",
  "rootPath": "/path/to/project",
  "globalRails": {
    "techStack": ["TypeScript", "React"],
    "forbiddenPatterns": ["eval(", "any"],
    "requiredPatterns": [],
    "formatting": "Prettier with 2-space indent",
    "testing": "Jest for unit tests",
    "customRules": ["All API calls must use the httpClient wrapper"]
  },
  "settings": {
    "approvalMode": "CONTROL",
    "speedModeDelayMs": 2000,
    "autoCreateBranch": true,
    "branchPattern": "moe/{epicId}/{taskId}",
    "commitPattern": "feat({epicId}): {taskTitle}"
  }
}
```

### Settings Reference

| Setting | Description | Values |
|---------|-------------|--------|
| `approvalMode` | How plans are approved | `CONTROL` (manual), `SPEED` (auto after delay), `TURBO` (instant) |
| `speedModeDelayMs` | Delay before auto-approval in SPEED mode | Milliseconds (default: 2000) |
| `autoCreateBranch` | Automatically create git branches for tasks | `true` / `false` |
| `branchPattern` | Pattern for branch names | Supports `{epicId}`, `{taskId}` |
| `commitPattern` | Pattern for commit messages | Supports `{epicId}`, `{taskTitle}` |
| `agentCommand` | CLI the agent launchers spawn | `claude` (default), `codex`, `gemini` |
| `autoCommit` | Worker post-flight auto-commit + push on REVIEW | `true` (default) / `false` |
| `enableAgentTeams` | Claude Code subagents for spawned agents | `false` (default) / `true` |
| `chatEnabled` | Agent chat system | `true` (default) / `false` |
| `chatMaxAgentHops` | Max agent-to-agent mention hops | Number (default: 4) |
| `models.{role}` | Per-role model override for the `claude` CLI | e.g. `"models": {"worker": "claude-opus-4-8"}` |

### Rails Reference

| Rail | Description | Example |
|------|-------------|---------|
| `techStack` | Technologies used in project | `["TypeScript", "Node.js"]` |
| `forbiddenPatterns` | Code patterns to avoid | `["console.log", "any"]` |
| `requiredPatterns` | Patterns that must be present | `["use strict"]` |
| `formatting` | Code formatting rules | `"ESLint + Prettier"` |
| `testing` | Testing requirements | `"80% coverage required"` |
| `customRules` | Additional project rules | `["Use dependency injection"]` |

---

## Approval Modes

### CONTROL Mode (Default)

- All plans require manual approval
- Human reviews every implementation plan
- Safest for production codebases

### SPEED Mode

- Auto-approves plans after configurable delay
- Allows time to review and reject if needed
- Good for trusted agents on non-critical work

### TURBO Mode

- Instant auto-approval
- No human review before execution
- Use only for fully trusted scenarios

---

## File Structure

```
.moe/
├── project.json       # Project configuration
├── daemon.json        # Runtime state (auto-generated)
├── activity.log       # Event log
├── epics/             # Epic definitions (epic-*.json)
├── tasks/             # Task definitions (task-*.json)
├── workers/           # Worker registrations (worker-*.json)
├── teams/             # Team definitions
├── proposals/         # Pending proposals (proposal-*.json)
├── channels/          # Chat channels
├── messages/          # Chat messages
├── decisions/         # Pinned chat decisions
├── roles/             # Role guides (sha-stamped, auto-upgraded by the daemon)
├── agents/            # Claude Code subagent defs (mirrored to .claude/agents/)
└── skills/            # Vendored skill pack (manifest.json + per-skill dirs)
```

---

## IDE Plugin Settings

The JetBrains plugin reads settings from project.json but also has IDE-specific preferences:

- **Auto-connect on project open:** Enable/disable automatic connection
- **Notification preferences:** Control which events show notifications
- **Refresh interval:** How often to poll for updates (WebSocket handles real-time)

Access via: Settings > Tools > Moe (when implemented)
