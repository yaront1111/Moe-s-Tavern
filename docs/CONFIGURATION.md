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
| `MOE_BIND_HOST` | Bind address (recorded as `bindHost` in daemon.json when non-loopback; WSL agent mode uses `0.0.0.0`) | `127.0.0.1` | `0.0.0.0` |
| `MOE_SHUTDOWN_TIMEOUT_MS` | Grace period for clean shutdown | `10000` | `5000` |
| `LOG_LEVEL` | Logging verbosity | `info` | `debug`, `warn`, `error` |
| `LOG_MAX_SIZE_MB` | Max activity.log size before rotation | `10` | `5` |
| `LOG_RETENTION_COUNT` | Number of rotated logs to keep | `5` | `3` |

(Advanced tuning — see `packages/moe-daemon/src/index.ts` and the util that reads each: port/lock `MOE_SOCKET_TIMEOUT_MS`, `MOE_PORT_CHECK_INTERVAL_MS`, `MOE_PORT_READY_TIMEOUT_MS`, `MOE_LOCK_RETRY_DELAY_MS`, `MOE_LOCK_STALE_TIMEOUT_MS`, `MOE_HTTP_CLOSE_TIMEOUT_MS`; state/limits `MOE_STATE_LOAD_TIMEOUT_MS`, `MOE_MCP_MAX_BATCH_SIZE`, `MOE_MAX_COMMENTS_PER_TASK`; rate limiting `MOE_RATE_LIMIT_ENABLED`, `MOE_RATE_LIMIT_WINDOW_MS`, `MOE_RATE_LIMIT_MAX_REQUESTS`; proposal cleanup `MOE_PROPOSAL_PURGE_INTERVAL_MS`, `MOE_PROPOSAL_PURGE_AGE_MS`, `MOE_PROPOSAL_SNAPSHOT_RETENTION_MS`; log compression `LOG_COMPRESSION_TIMEOUT_MS`.)

### Proxy Configuration

| Variable | Description | Default | Example |
|----------|-------------|---------|---------|
| `MOE_PROJECT_PATH` | Project path (used to locate `.moe/daemon.json`) | Current directory | `/home/user/myproject` |
| `MOE_MESSAGE_TIMEOUT_MS` | Per-message timeout for forwarded MCP calls | `30000` | `60000` |
| `MOE_WORKER_ID` | Worker identity injected into every `tools/call` | Set by agent launchers | `worker-1` |
| `MOE_DAEMON_HOST` | Connect-host override (WSL agent mode: reach a Windows-owned daemon via the WSL gateway) | Loopback | `172.29.32.1` |

### Agent Scripts

| Variable | Description | Default | Example |
|----------|-------------|---------|---------|
| `MOE_WORKER_ID` | Worker identifier | Generated per launch | `worker-1` |
| `MOE_SERENA_PATH` | Serena binary for the injected MCP server | `~/.local/bin/serena` | `/opt/serena/serena` |
| `MOE_SERENA_PROJECT` | Serena project root override (multi-repo workspaces) | Moe project root | `/repo/backend` |
| `MOE_NODE_COMMAND` | Node.js executable (JetBrains plugin daemon spawn) | `node` | `/usr/local/bin/node` |
| `MOE_DAEMON_COMMAND` | Daemon start command override (JetBrains plugin) | Auto-detected | `npx moe-daemon` |
| `MOE_DAEMON_HOST` | Daemon connect-host override for agents + spawned MCP servers (WSL mode) | Loopback | `172.29.32.1` |
| `MOE_DISABLE_HEARTBEAT` | Skip the heartbeat sidecar that keeps `lastActivityAt` fresh during long silent CLI steps | Unset | `1` |
| `MOE_HEARTBEAT_INTERVAL_SEC` | Heartbeat sidecar ping interval | `60` | `30` |
| `MOE_HEARTBEAT_MAX_DURATION_SEC` | Heartbeat sidecar hard stop (a truly-hung CLI still goes stale) | `7200` | `3600` |
| `MOE_DISABLE_QUALITY_GATE` | Skip `settings.qualityGate` for this run | Unset | `1` |
| `MOE_RESUME_MAX_ATTEMPTS` | CLI relaunches onto an already-held task before escalating + idling | `5` | `3` |
| `MOE_CODEX_REASONING_EFFORT` | `model_reasoning_effort` written to codex config.toml | `xhigh` | `high` |
| `MOE_CODEX_MCP_STARTUP_TIMEOUT_SEC` | `startup_timeout_sec` for the codex `moe` MCP entry (survives supervised daemon restarts) | `120` | `180` |
| `MOE_FALLBACK_CLI` | Inject `moe-call.sh` fallback instructions into the agent prompt (rare edge case) | Unset | `1` |
| `MOE_DISABLE_TOOL_HOOK` | Claude plugin: disable the PostToolUse hook that forwards `moe.*` tool events to the daemon | Unset | `1` |

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
    "commitPattern": "feat({epicId}): {taskTitle}",
    "appendOnlyFiles": ["CHANGELOG.md", "docs/**/release-notes.md"],
    "refusalCascadeAutoBacklog": true
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
| `qualityGate` | Shell command the worker wrapper runs before the post-flight auto-commit; non-zero exit blocks commit+push and posts the failure to the task | e.g. `"npm run lint && npx tsc --noEmit"`; unset/empty disables; `MOE_DISABLE_QUALITY_GATE=1` skips per-run |
| `qualityGateScope` | When the gate runs: only on the epic's final task (highest `order` among siblings) or on every task | `epicFinal` (default) / `everyTask` |
| `taskSizing` | Plan-size thresholds enforced by `moe.submit_plan` (warn past warn values, reject past max values; distinct files = union of step `affectedFiles`). `autoCritique: true` additionally auto-blocks warn-zone plans back to PLANNING in CONTROL mode when no governor is online (capped like governor critique blocks) | `{"warnSteps": 8, "maxSteps": 12, "warnDistinctFiles": 5, "maxDistinctFiles": 10, "autoCritique": false}` (defaults) |
| `pacePerStepMs` | Wall-clock ms budgeted per plan step; `moe.submit_plan` seeds an absent task budget as `stepCount * pacePerStepMs` (an explicit budget arg or an existing task budget wins) | Milliseconds (default: 900000 = 15 min; valid 1000-86400000) |
| `appendOnlyFiles` | Project-relative globs for files every task appends to; claim-time `fileCollision` warnings skip them so real overlaps stay visible. Forward slashes only; supports literal paths, `*` (matches within one path segment) and `**` (crosses directories, and `**/x` also matches `x` at the root). A supplied array **replaces** the default — include `CHANGELOG.md` yourself if you still want it suppressed; `[]` disables suppression entirely | `["CHANGELOG.md"]` (default), e.g. `["CHANGELOG.md", "docs/**/release-notes.md", "docs/*.md"]` |
| `refusalCascadeAutoBacklog` | Auto-park a task to BACKLOG when `moe.release_task` records a 3rd release inside 24h whose `handoffNote.whatIsDone` reports no progress (`nothing` / `none` / `n/a`, or text starting `nothing…` / `no progress…`). Releases that describe real work, and releases with no handoff at all, never count. Omitting the key leaves it **enabled** — only an explicit `false` disables it | `true` (default) / `false` |
| `enableAgentTeams` | Claude Code subagents for spawned agents | `false` (default) / `true` |
| `chatEnabled` | Agent chat system | `true` (default) / `false` |
| `chatMaxAgentHops` | Max agent-to-agent mention hops | Number (default: 4) |
| `models.{role}` | Per-role model override for the `claude` CLI | e.g. `"models": {"worker": "claude-opus-4-8"}` |
| `columnLimits` | Max tasks per board column (UI hint) | e.g. `{"WORKING": 5}` |
| `staleWorkerTimeoutMs` | Silent-worker prune threshold: workers idle past this that own **no** active work are deleted from the worker map; owners of WORKING/PLANNING tasks are preserved (never idle-released) | Milliseconds (default: 1800000 = 30 min) |
| `reviewStaleTimeoutMs` | REVIEW-only exception: a QA owner silent past this has its REVIEW task released (unassigned, stays REVIEW) so another QA can claim it | Milliseconds (default: 1800000 = 30 min) |

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
