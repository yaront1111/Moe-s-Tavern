# Configuration Reference

This document covers all configuration options for Moe's Tavern.

---

## Environment Variables

### Daemon Configuration

| Variable | Description | Default | Example |
|----------|-------------|---------|---------|
| `MOE_PROJECT_PATH` | Path to project containing `.moe/` folder | Current directory | `/home/user/myproject` |
| `MOE_PORT` | WebSocket server port | `3141` | `3142` |
| `LOG_LEVEL` | Logging verbosity | `info` | `debug`, `warn`, `error` |
| `LOG_MAX_SIZE_MB` | Max activity.log size before rotation | `10` | `5` |
| `LOG_RETENTION_COUNT` | Number of rotated logs to keep | `5` | `3` |

### Proxy Configuration

| Variable | Description | Default | Example |
|----------|-------------|---------|---------|
| `MOE_PROJECT_PATH` | Project path (passed to daemon lookup) | Current directory | `/home/user/myproject` |
| `MOE_DAEMON_URL` | Direct daemon WebSocket URL | Auto-detected from daemon.json | `ws://localhost:3141/mcp` |

### Agent Scripts

| Variable | Description | Default | Example |
|----------|-------------|---------|---------|
| `MOE_TASK_ID` | Specific task ID to work on | None (claims next) | `task-abc123` |
| `MOE_WORKER_ID` | Worker identifier | Generated | `worker-1` |
| `MOE_NODE_COMMAND` | Node.js executable path | `node` | `/usr/local/bin/node` |
| `MOE_DAEMON_COMMAND` | Daemon start command | Auto-detected | `npx moe-daemon` |

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
├── epics/             # Epic definitions
│   └── epic-*.json
├── tasks/             # Task definitions
│   └── task-*.json
├── workers/           # Worker registrations
│   └── worker-*.json
└── proposals/         # Pending proposals
    └── proposal-*.json
```

---

## IDE Plugin Settings

The JetBrains plugin reads settings from project.json but also has IDE-specific preferences:

- **Auto-connect on project open:** Enable/disable automatic connection
- **Notification preferences:** Control which events show notifications
- **Refresh interval:** How often to poll for updates (WebSocket handles real-time)

Access via: Settings > Tools > Moe (when implemented)
