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

(Advanced tuning — see `packages/moe-daemon/src/index.ts` and the util that reads each: port/lock `MOE_SOCKET_TIMEOUT_MS`, `MOE_PORT_CHECK_INTERVAL_MS`, `MOE_PORT_READY_TIMEOUT_MS`, `MOE_LOCK_RETRY_DELAY_MS`, `MOE_LOCK_STALE_TIMEOUT_MS`, `MOE_HTTP_CLOSE_TIMEOUT_MS`; state/limits `MOE_STATE_LOAD_TIMEOUT_MS`, `MOE_MCP_MAX_BATCH_SIZE`, `MOE_MAX_COMMENTS_PER_TASK`, `MOE_MAX_COMMITS_PER_TASK` (cap on `task.commits`, default 50, newest kept); rate limiting `MOE_RATE_LIMIT_ENABLED`, `MOE_RATE_LIMIT_WINDOW_MS`, `MOE_RATE_LIMIT_MAX_REQUESTS`; proposal cleanup `MOE_PROPOSAL_PURGE_INTERVAL_MS`, `MOE_PROPOSAL_PURGE_AGE_MS`, `MOE_PROPOSAL_SNAPSHOT_RETENTION_MS`; log compression `LOG_COMPRESSION_TIMEOUT_MS`.)

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
| `MOE_DISABLE_CHECKPOINT` | Skip `wip(task-<id>)` checkpoint commits for this run (completion commits and rescue refs still land) | Unset | `1` |
| `MOE_ATTRIBUTION` | `declared` forces `settings.attribution.undeclared` to `never` for this run — declared-only landing, no MEASURED paths | Unset | `declared` |
| `GIT_TERMINAL_PROMPT` | **Set by the wrapper** (not read) to `0` for its whole lifetime, so a credential or host-key prompt can never hang a push or a `pull --rebase` retry | `0` (wrapper-set) | — |
| `MOE_POSTFLIGHT_TEST_HOOK_PRE_UPDATE_REF` | Test seam only: a command the landing runs between `commit-tree` and `update-ref` (the harness uses it to force CAS contention with a peer commit) | Unset | `bash peer-commit.sh` |
| `MOE_RESUME_MAX_ATTEMPTS` | CLI relaunches onto an already-held task before escalating + idling | `5` | `3` |
| `MOE_CODEX_REASONING_EFFORT` | `model_reasoning_effort` written to codex config.toml | `xhigh` | `high` |
| `MOE_CODEX_MCP_STARTUP_TIMEOUT_SEC` | `startup_timeout_sec` for the codex `moe` MCP entry (survives supervised daemon restarts) | `120` | `180` |
| `MOE_GROK_MODEL` | Model passed as `-m` to the `grok` CLI when neither `-Model`/`--model` nor `settings.models.{role}` is set; unset = grok's own default (the wrapper never hands its `claude-opus-5` fallback to grok) | Unset | `<model id>` |
| `MOE_GROK_EFFORT` | `--effort <lvl>` for the `grok` CLI; the flag is passed only when this is set | Unset | `high` |
| `MOE_GROK_MCP_STARTUP_TIMEOUT_SEC` | `startup_timeout_sec` for the grok `moe` MCP entry in `.grok/config.toml` (digits only; same daemon-restart race as codex) | `120` | `180` |
| `XAI_API_KEY` | **Read by grok, not by Moe**: API-key auth for the `grok` CLI. A cached `grok login` (`~/.grok/auth.json`) wins when both exist; the wrapper only warns (non-fatal, `[WARN] XAI_API_KEY is not set and ~/.grok/auth.json is missing …`) when neither is present | Unset | `xai-…` |
| `GROK_CLAUDE_MCPS_ENABLED` / `GROK_CURSOR_MCPS_ENABLED` / `GROK_DISABLE_AUTOUPDATER` | **Set by the wrapper** (not read) for the spawned `grok` process: `0` / `0` / `1` — grok must not auto-merge MCP servers from `~/.claude.json`, `.cursor/mcp.json` or the project `.mcp.json` on top of the wrapper-written `.grok/config.toml`, and must not self-update mid-session | `0` / `0` / `1` (wrapper-set) | — |
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
    "refusalCascadeAutoBacklog": true,
    "autoCommit": true,
    "checkpointCommits": true,
    "checkpointPush": true,
    "commitBoardState": true,
    "commitHooks": false,
    "attribution": { "undeclared": "solo", "contested": "commit", "exclude": [] }
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
| `agentCommand` | CLI the agent launchers spawn | `claude` (default), `codex`, `gemini`, `grok` |
| `autoCommit` | Master switch for the wrapper's **land-on-every-exit** post-flight (the wrappers are the only git actors; the daemon never runs git). On: a worker exit at REVIEW/DONE makes a completion commit (`feat(task-<id>): <title>`, or `fix(task-<id>): … (retry after qa_reject #N)` after a reopen) and pushes; every other exit that holds a task (worker/architect/qa — WORKING, BLOCKED, PLANNING, AWAITING_APPROVAL, or a failed status lookup) makes a `wip(task-<id>)` checkpoint; gate/peel/commit failures, ref contention and Ctrl+C teardown go to a rescue ref `refs/moe/rescue/<taskId>/<utc-ts>` (never a branch commit, never pushed). Paths are attributed **per task** from a persisted baseline `<gitdir>/moe/baseline/<taskId>.tsv` (dirty snapshot at pre-flight, pruned after each landing, kept until DONE/ARCHIVED) joined with `moe.get_commit_scope`: ASSERTED (completed-step `modifiedFiles`, `declare_files`, prior commits — committed regardless of baseline), PLANNED (plan-declared, only if changed since baseline), TOOL (stream-json edit harvest), MEASURED (undeclared + changed, per `attribution.undeclared`), BOARD (own task record) are staged; PEER (`MOE_ATTR_PEER_DECLARED`), PREEXISTING (`MOE_ATTR_PREEXISTING` — dirty before the task and untouched, never committed), DENY (`MOE_ATTR_EXCLUDED`) are skipped per path. Staging is `:(literal)` pathspec into a **temp index**, landed with `commit-tree` + `update-ref` CAS (3 attempts) — never `git add -A`/`-u`, never a bare `git commit`, no whole-tree fallback, peers' staged entries survive. Every outcome is reported through `moe.record_commit` into `task.commits`. `false` disables completion, checkpoint and rescue commits alike (logged `[info] settings.autoCommit=false`) | `true` (default) / `false` |
| `checkpointCommits` | `wip(task-<id>): <title> [status=<S> role=<r> cli-exit=<N>]` checkpoint on every non-REVIEW exit of a worker and on every exit of an architect/qa session holding a task; always plumbing (hooks never run). A lingering baseline is landed as a recovery checkpoint (`MOE_CHECKPOINT_RECOVERED`) at the task's next pre-flight | `true` (default) / `false`; `MOE_DISABLE_CHECKPOINT=1` skips per-run |
| `checkpointPush` | Push checkpoint commits to origin (`CHECKPOINT-UNPUSHED task=<id>` in `#general` on failure — a visibility problem, not a loss); `false` keeps them local | `true` (default) / `false` |
| `commitBoardState` | Stage board records with the landing: the task's own `.moe/tasks/<id>.json` always; `.moe/epics/*.json`, `.moe/project.json` and non-live-peer task records when changed this session. Live peers' task records are never staged | `true` (default) / `false` |
| `commitHooks` | `false`: every wrapper commit uses plumbing (temp index + `commit-tree` + `update-ref`) — pre-commit/commit-msg hooks do **not** run; `qualityGate` is the sanctioned gate. `true`: **completion** commits only switch to porcelain `git add -- :(literal)<p>` + `git commit -- <specs>` so hooks run, with a rescue ref (`[reason=commit-failed]`) when a hook rejects; checkpoints and rescues stay plumbing | `false` (default) / `true` |
| `attribution.undeclared` | A changed path no task declared and no tool wrote: `solo` commits it as MEASURED (recorded in `task.inferredPaths`, never promoted to asserted) only when no other worker is live, otherwise reports it as `MOE_ATTRIBUTION_UNRESOLVED` (persisted in `task.unattributedPaths`, never staged); `never` = declared-only; `always` = commit regardless (single-seat projects) | `solo` (default) / `never` / `always`; `MOE_ATTRIBUTION=declared` forces `never` per-run |
| `attribution.contested` | A path this task asserted that another live task also declares: `commit` lands it and records `Moe-Contested: <path> (task-<peer>)` in the commit body; `skip` drops it with `MOE_ATTR_CONTESTED` | `commit` (default) / `skip` |
| `attribution.exclude` | Extra DENY prefixes (project-relative, forward slashes; no absolute paths or `..`) the wrapper never stages, on top of the built-ins: `.moe/**` except board records, `.mcp.json`, `.codex/**`, `.gemini/**`, `.grok/**`, `.claude/agents/**`, `.claude/settings.local.json`, untracked `.serena/**`, `.worktrees/**`, `.moe-worktree*`. In a multi-project repo (the Moe project nested below the git toplevel) the same built-ins are ALSO denied at the repo root — another fleet's `.moe/**` (board records included) is never staged or attributed by this project's tasks | `[]` (default), e.g. `["generated/", "tmp/"]` |
| `qualityGate` | Shell command the worker wrapper runs before the **completion** commit; non-zero exit sends the work to a rescue ref (`rescue(task-<id>): … [reason=gate-failed]` — never the branch, never pushed), keeps the baseline, posts `PUSH-BLOCKED:` to `#general` + the output tail as a task comment, and stops the worker loop | e.g. `"npm run lint && npx tsc --noEmit"`; unset/empty disables; `MOE_DISABLE_QUALITY_GATE=1` skips per-run |
| `qualityGateScope` | When the gate runs: only on the epic's final task (highest `order` among siblings) or on every task | `epicFinal` (default) / `everyTask` |
| `consolidationBranch` | Branch workers must be on when calling `moe.complete_task`; mismatch rejects with `BRANCH-POLICY-FAIL`, a missing `currentBranch` only warns #governors. A **literal** value (no `*`) also doubles as the wrapper's peel target instead of `moe/work-<date>` when it must leave `main`/`master`/detached HEAD (existing non-default branches are still reused, never switched) | Literal name or `*` glob, e.g. `moe/work-*`; case-sensitive; unset/empty disables |
| `taskSizing` | Plan-size thresholds enforced by `moe.submit_plan` (warn past warn values, reject past max values; distinct files = union of step `affectedFiles`). `maxTasksPerEpic` is checked at `moe.create_task` instead and is **advisory** — a warning past the ceiling ("re-slice into sub-epics"), creation never fails. `autoCritique: true` additionally auto-blocks warn-zone plans back to PLANNING in CONTROL mode when no governor is online (capped like governor critique blocks) | `{"warnSteps": 8, "maxSteps": 12, "warnDistinctFiles": 5, "maxDistinctFiles": 10, "maxTasksPerEpic": 40, "autoCritique": false}` (defaults) |
| `pacePerStepMs` | Wall-clock ms budgeted per plan step; `moe.submit_plan` seeds an absent task budget as `stepCount * pacePerStepMs` (an explicit budget arg or an existing task budget wins) | Milliseconds (default: 900000 = 15 min; valid 1000-86400000) |
| `appendOnlyFiles` | Project-relative globs for files every task appends to; claim-time `fileCollision` warnings skip them so real overlaps stay visible. Forward slashes only; supports literal paths, `*` (matches within one path segment) and `**` (crosses directories, and `**/x` also matches `x` at the root). A supplied array **replaces** the default — include `CHANGELOG.md` yourself if you still want it suppressed; `[]` disables suppression entirely | `["CHANGELOG.md"]` (default), e.g. `["CHANGELOG.md", "docs/**/release-notes.md", "docs/*.md"]` |
| `refusalCascadeAutoBacklog` | Auto-park a task to BACKLOG when `moe.release_task` records a 3rd release inside 24h whose `handoffNote.whatIsDone` reports no progress (`nothing` / `none` / `n/a`, or text starting `nothing…` / `no progress…`). Releases that describe real work, and releases with no handoff at all, never count. Omitting the key leaves it **enabled** — only an explicit `false` disables it | `true` (default) / `false` |
| `enableAgentTeams` | Claude Code subagents for spawned agents | `false` (default) / `true` |
| `chatEnabled` | Agent chat system | `true` (default) / `false` |
| `chatMaxAgentHops` | Max agent-to-agent mention hops | Number (default: 4) |
| `models.{role}` | Per-role model override for the `claude` CLI (`--model`) and the `grok` CLI (`-m`; absent, grok falls back to `MOE_GROK_MODEL`, else its own default — the wrapper's `claude-opus-5` fallback is never passed to grok). Ignored by codex/gemini | e.g. `"models": {"worker": "claude-opus-4-8"}` |
| `columnLimits` | Max tasks per board column (UI hint) | e.g. `{"WORKING": 5}` |
| `staleWorkerTimeoutMs` | Silent-worker prune threshold: workers idle past this that own **no** active work are deleted from the worker map; owners of WORKING/PLANNING tasks are preserved (never idle-released) | Milliseconds (default: 1800000 = 30 min) |
| `reviewStaleTimeoutMs` | REVIEW-only exception: a QA owner silent past this has its REVIEW task released (unassigned, stays REVIEW) so another QA can claim it | Milliseconds (default: 1800000 = 30 min) |
| `resources` | Declared shared resources for `moe.acquire_resource` leases, keyed by resource id (`[A-Za-z0-9][A-Za-z0-9._-]{0,63}`). Per resource: `capacity` (concurrent leases, 1-100), `maxLeaseMs` (hard cap on any one lease before the sweep force-releases it — bounds a crashed holder; 60000-604800000 ms) and `description` (≤500 chars). Declaring is **optional**: acquiring an undeclared id auto-creates the resource with the defaults, so declare only to override them or to document the resource. A settings update **replaces** the whole map (removal must be possible). Defaults live in `packages/moe-daemon/src/state/resourceStore.ts` (`DEFAULT_RESOURCE_CAPACITY`, `DEFAULT_MAX_LEASE_MS`) | e.g. `{"benchmark-box": {"capacity": 1, "maxLeaseMs": 86400000, "description": "perf rig"}}`; defaults: capacity 1, maxLeaseMs 86400000 (24h) |

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
├── resources/         # Shared-resource lease state (<resource-id>.json, daemon-written)
├── channels/          # Chat channels
├── messages/          # Chat messages
├── decisions/         # Pinned chat decisions
├── roles/             # Role guides (sha-stamped, auto-upgraded by the daemon)
├── agents/            # Claude Code subagent defs (mirrored to .claude/agents/)
└── skills/            # Vendored skill pack (manifest.json + per-skill dirs)
```

The agent wrapper's landing state lives **outside** `.moe/`, under the repository's git dir: `<gitdir>/moe/baseline/<taskId>.tsv` (per-task dirty-snapshot baseline; `#moe-baseline v1 task=<id> at=<iso> head=<sha>` header, `B`/`U` rows; written at pre-flight, pruned after each landing, deleted when the task is DONE/ARCHIVED) and transient `<gitdir>/moe/idx-<taskId>-<pid>` temp indexes. Rescue snapshots are refs under `refs/moe/rescue/<taskId>/<utc-ts>` (never pushed). `<gitdir>` is `git rev-parse --absolute-git-dir` from the project root.

---

## IDE Plugin Settings

The JetBrains plugin reads settings from project.json but also has IDE-specific preferences:

- **Auto-connect on project open:** Enable/disable automatic connection
- **Notification preferences:** Control which events show notifications
- **Refresh interval:** How often to poll for updates (WebSocket handles real-time)

Access via: Settings > Tools > Moe (when implemented)
