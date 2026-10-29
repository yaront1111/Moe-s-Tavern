# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Moe's Tavern ("Moe" in code; plugin id `com.moe.jetbrains`, npm `moe-*`) is an AI agent task board — IDE plugins + a Node daemon that orchestrate AI agents through a task lifecycle (BACKLOG → PLANNING → AWAITING_APPROVAL → WORKING → REVIEW → DONE). The lifecycle has back-edges: `qa_reject` sends REVIEW → WORKING, auto-flipping to PLANNING after 3 reopens or when the same DoD item fails twice; in CONTROL mode a governor plan-critique `block` verdict also flips a task back to PLANNING. A side-state `BLOCKED` (not agent-claimable; display-mapped into the Working column) parks a PLANNING/WORKING/REVIEW task on an external blocker via `report_blocked` — a non-resource block reported by the assignee (or on an unassigned task) **frees the seat** (task unassigned, worker → IDLE to claim other work; the wrapper checkpointed the bytes at block time), while a `resourceId` block — or a third-party/workerId-less block on an assigned task — keeps the seat parked (grant-return path / never yank a live worker). Auto-unblock back to `blockedFromStatus` is dual: the shared-resource lease grant, or every `blockedOnTaskIds` target reaching DONE/ARCHIVED (`report_blocked` accepts the ids and also auto-parses `task-…` ids from the reason; event-driven with a sweep backstop; ids that are ALL already DONE/ARCHIVED at report time do **not** block — `dependenciesSatisfied:true`, continue; an id that would close a dependency cycle over `dependsOn ∪ blockedOnTaskIds` is dropped with a warning + #governors alert, and `set_task_dependencies` rejects one outright); otherwise `unblock_worker { resolveBlocks: true }` or `set_task_status` clears the block — a plain `unblock_worker` only frees the worker seat (the task stays BLOCKED with its `blockedReason`). JetBrains is the primary IDE — implement and test JetBrains changes first; VS Code lags and workers tend to over-index on it, so push back and prioritize JetBrains parity.

```
JetBrains/VS Code Plugin ── ws://…/ws ──▶ Moe Daemon ◀── ws://…/mcp ── moe-proxy ◀── agent CLI (MCP stdio)
                                            │
                                            ▼
                                         .moe/  (source of truth)
```

The daemon is the sole writer of `.moe/` **runtime state** (tasks, epics, workers, teams, proposals) — agents and humans must never edit `.moe/` by hand; go through `moe.*` MCP tools. The IDE plugins do, however, write to `.moe/` outside that invariant: they scaffold `.moe/` when missing, force-sync bundled role docs/skills into it on connect, and delete `.moe/daemon.json` when stale.

Roles: **architect** plans (`submit_plan`), **worker** codes per-step, **QA** reviews (`qa_approve`/`qa_reject`), **governor** oversees the fleet (never claims tasks). Humans gate transitions unless approval mode is relaxed.

## Packages

| Path | Lang | Role |
|---|---|---|
| `packages/moe-daemon/` | TS (Node, ESM) | Core daemon: `.moe/` StateManager, FileWatcher (chokidar), WebSocketServer (`/ws` + `/mcp`), McpAdapter, 40+ MCP tools. Self-supervises with crash restart. (Cross-session memory is delegated to the Serena MCP server — see `docs/MEMORY.md`.) |
| `packages/moe-proxy/` | TS (Node, ESM) | MCP stdio shim. Agent CLI speaks MCP over stdio; proxy forwards to the daemon over `ws://127.0.0.1:<port>/mcp` (reconnects, per-message timeouts). Injects `workerId` (from `MOE_WORKER_ID`, set by the launchers) into every `tools/call` that omits it, and an architect/QA/governor seat's runner identity (`MOE_RUNNER_PROCESS_STARTED_AT`/`MOE_RUNNER_HOST`) into `claim_next_task`, so in-session claims reattach after a daemon restart, plus the launcher's CLI (`MOE_WORKER_TYPE`) as `workerType` on `claim_next_task`/`join_team`, which the daemon records as `worker.type`. It also stamps the session's execution identity (`MOE_SESSION_ID`; `MOE_ATTEMPT_ID` + `MOE_ATTEMPT_GENERATION`, both or neither) onto `get_context`, `start_step`, `complete_step` and `complete_task`, and refuses a caller-substituted or malformed identity (`EXECUTION_IDENTITY_SUBSTITUTED` / `EXECUTION_IDENTITY_INVALID`); see `packages/moe-proxy/README.md`. |
| `packages/moe-claude-plugin/` | TS (Node, ESM) | Claude Code plugin: slash commands + PostToolUse hook forwarding `moe.*` tool events to the daemon's `/ws` (fire-and-forget, fail-open; opt out `MOE_DISABLE_TOOL_HOOK=1`). The hook shim imports `dist/` (not committed) and swallows errors — src edits are silently inert until `npm run build`. |
| `moe-jetbrains/` | Kotlin/Swing | Primary plugin. Bundles daemon+proxy+scripts+role docs+skills; auto-spawns the daemon on project open (and kills it on close if it's the last project using that PID; override resolution via `MOE_DAEMON_COMMAND`/`MOE_NODE_COMMAND`). Tool window with a 5-column board over `/ws` — AWAITING_APPROVAL is display-mapped into the Planning column, not a column of its own. |
| `moe-vscode/` | TS | VS Code / Antigravity extension (secondary). Also bundles daemon+proxy+scripts and auto-spawns the daemon; registers the bundled proxy as an MCP server on Antigravity. `npm test` covers daemon startup; MANUAL_TESTS.md covers IDE interaction. |

Daemon, proxy, and claude-plugin each build with `tsc` and test with `vitest`. There are **no npm workspaces** — install/build per package. Root `package.json` only has `npm run lint` (role-doc linter).

## Build

```bash
cd packages/moe-daemon && npm install && npm run build   # prebuild generates init + skill files
cd packages/moe-proxy  && npm install && npm run build
cd moe-jetbrains       && ./gradlew buildPlugin           # zip → moe-jetbrains/build/distributions/
cd moe-jetbrains       && ./gradlew runIde                # sandbox IDE for dev
cd moe-vscode          && npm install && npm run package  # .vsix via vsce (compile/watch = typecheck only; no build script)
```

Both IDE plugin builds hard-fail unless daemon AND proxy each have `dist/` **and** `node_modules/` — npm install + build both first. Role-doc/skill edits reach IDE users only through a plugin rebuild (they're bundled into the plugin, then force-synced into each project's `.moe/`).

Windows full build (daemon + proxy + JetBrains plugin ZIP): `.\scripts\install-all.ps1 -BuildPlugin`

## Run

The daemon default port is **9876** (override `--port` or `MOE_DEFAULT_PORT`; auto-scans the next 50 if taken). It binds `127.0.0.1` unless `--host`/`MOE_BIND_HOST` says otherwise (recorded as `bindHost` in daemon.json when non-loopback). Project resolves from `--project`, else `MOE_PROJECT_PATH`, else cwd. Endpoints: `ws://localhost:<port>/ws` (plugins), `ws://localhost:<port>/mcp` (proxy), HTTP `GET /health`. Clients discover the port from `.moe/daemon.json` (written by the daemon): the proxy retries a missing file for ~5 min (survives supervised restarts) but exits immediately on a project-path mismatch — the check treats `D:\path` and `/mnt/d/path` as the same project, and `MOE_DAEMON_HOST` overrides the proxy's connect host (both exist for **WSL agent mode**: the JetBrains Agents menu toggle "Run Agents in WSL" spawns the daemon with `--host 0.0.0.0` and launches agents via `moe-agent.sh` with `/mnt/` paths; the sh pre-flight detects a Windows-owned daemon.json by its drive-letter projectPath, probes `/health` over loopback then the WSL gateway instead of `kill -0` — a Windows PID is invisible in WSL — and refuses to delete daemon.json or start a duplicate daemon when the probe fails; requires node + the agent CLI installed inside the distro).

```bash
node packages/moe-daemon/dist/index.js start  --project <path>   # supervised (auto-restart, exp. backoff)
node packages/moe-daemon/dist/index.js init   --project <path>   # creates .moe/ then starts (keeps running)
node packages/moe-daemon/dist/index.js status --project <path>
node packages/moe-daemon/dist/index.js stop   --project <path>
node packages/moe-daemon/dist/index.js doctor --project <path>   # offline health check; exit 0 = green
node packages/moe-daemon/dist/index.js accounts list|add|login <id>|check|remove <id>   # machine's Claude accounts (rotation)
node packages/moe-proxy/dist/index.js                            # MCP stdio bridge (agents)
scripts/moe-call.sh <tool> '<json-args>' --project <path>        # one-shot moe.* tool call from a terminal
```

`start` runs a supervisor that spawns the real daemon via the internal `_run` command and restarts it on crash (max 5 in 60s, backoff capped at 30s). Every daemon (re)start purges the worker records that are neither recently active nor holding an open execution attempt and releases their orphaned tasks (`purgeAllWorkers`) — agents must re-register after a restart; a seat mid-execution keeps its record and its row, held until its wrapper reattaches (see **Dead-worker handling** in `packages/moe-daemon/CLAUDE.md`). `doctor` does NOT require a running daemon — it walks `.moe/` checklist probes and exits 1 on any hard fail. `accounts` manages the machine's Claude subscription accounts for rotation, a machine-level list in `~/.moe/claude-accounts.json` (`MOE_ACCOUNTS_FILE` overrides). Each account is a Claude config folder, signed in with Claude's own `claude auth login --claudeai`. The wrapper leases one account per claude launch and moves to the next at 90% usage: a worker at its next step boundary, and an architect/governor TUI between tasks, through the `moe-account-switch` mod (`scripts/mods/`), which ends the session so the wrapper loop relaunches it. The JetBrains **Accounts** tab drives all of it (see **Claude Account Rotation** in `docs/MCP_SERVER.md`).

Launch agents via `scripts/moe-agent.{ps1,sh}` or a full team via `scripts/moe-team.{ps1,sh}`. Pre-flight: daemon autostart, per-CLI MCP-config writes, team/chat join, `claim_next_task` + `get_context` preload, and a `.moe/agents/*.md → .claude/agents/` subagent mirror (gated by `settings.enableAgentTeams`; sets `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`). Skills are NOT synced by the wrapper — the daemon writes `.moe/skills/` at init and agents load them via their host's Skill tool. Post-flight: branch safety + landing (completion/checkpoint commit, rescue refs — see **Land on every exit** in `scripts/CLAUDE.md`). Agents run **in the project directory** — except the PowerShell `claude` launch, which runs in the launcher's cwd and binds to the project via `MOE_PROJECT_PATH` + a temp `--mcp-config` (codex/gemini/grok and all `.sh` launches `cd` into the project). Both launchers spawn claude `--print` one-shot and respawn a fresh CLI per task (PowerShell `-Interactive` / bash `--interactive` for the TUI; architect/governor default to interactive, worker/qa to one-shot — the per-task fresh context is what resets standards-compliance decay). Per-CLI launch detail (grok/codex argv and sandbox, model and effort defaults) is in `scripts/CLAUDE.md`.

## Test

```bash
cd packages/moe-daemon && npm test                                  # vitest run (all)
cd packages/moe-daemon && npx vitest run src/server/McpAdapter.test.ts   # single file
cd packages/moe-daemon && npx vitest run -t "<test name>"                # single test by name
cd moe-jetbrains       && ./gradlew test                            # plugin unit tests (JUnit 4, headless — a CI merge gate)
cd moe-vscode          && npm test && npm run compile                # startup regression tests + typecheck
bash scripts/tests/postflight.sh                                    # launcher-script harness (daemon-free; .ps1 sibling for PowerShell; MOE_POSTFLIGHT_TIMEOUT_SEC widens the per-wrapper 60s on a slow or busy box)
bash scripts/tests/parity-check.sh                                  # ps1/sh wrapper string parity (codes, banners, settings keys, env names)
npm run lint                                                        # repo root: role-doc linter (bash script — Git Bash on Windows)
```

Run daemon tests after touching daemon code; run `./gradlew test` after touching Kotlin. Proxy and claude-plugin have their own `npm test`. `npm run lint` enforces a hard 40-line cap on `docs/roles/{architect,worker,qa}.md` (governor + `*.reference.md` exempt) — keep role docs terse, put detail in the `.reference.md` files.

CI (`.github/workflows/ci.yml`, PRs to main): role-doc lint, daemon+proxy build + `test:coverage`, Claude plugin build + tests, JetBrains `buildPlugin` + `./gradlew test`, and a 3-OS build matrix (ubuntu/windows/macos) including VS Code typecheck + startup tests. Daemon changes also trigger a Docker build of `packages/moe-daemon/Dockerfile`. Releases are tag-driven: pushing `v*` builds everything, publishes daemon+proxy to npm, attaches the plugin zip + .vsix to a GitHub Release, and publishes to JetBrains Marketplace.

## Working in this repo

- **Never edit `.moe/` files by hand** — go through `moe.*` MCP tools (contracts in `docs/MCP_SERVER.md`). Most of `.moe/` IS tracked in git (project.json, tasks/, roles/, skills/): daemon-driven diffs in `.moe/tasks/*.json` are intentional — commit/review them, don't revert them as junk (the wrapper's landing commits stage the task's own `.moe/tasks/<taskId>.json` as a BOARD path, plus changed `.moe/epics/*.json` / `.moe/project.json` / non-live-peer task records, when `settings.commitBoardState` is on — the default; peers' live task records are never staged). Only the runtime subset (daemon.json, activity.log, workers/, memory/, messages/, teams/, resources/, and the delivery records attempts/, candidates/, checks/, reviews/, receipts/ — never committed; see `docs/ARCHITECTURE.md` Delivery Path) is gitignored, as is root `.mcp.json` (machine-local absolute paths — never commit it).
- Commit messages follow Conventional Commits (`feat(scope):`, `fix(scope):`, `chore:` …); releases are SemVer with all package versions synced.
- **Landing**: the wrappers (`scripts/moe-agent.{ps1,sh}`) are the only Git-write actors and land every task-holding session exit as a completion/checkpoint commit or a rescue ref; the daemon is state-only. Detail: **Land on every exit** in `scripts/CLAUDE.md`.
- Approval modes (`CONTROL` default / `SPEED` / `TURBO`), `agentCommand`, `autoCommit`, `checkpointCommits`, `checkpointPush`, `commitBoardState`, `commitHooks`, `attribution.{undeclared,contested,exclude}`, `qualityGate`, `taskSizing`, `models.{role}`, and `enableAgentTeams` live in `.moe/project.json` `settings`.
- Skills (`docs/skills/`) are mirrored into `.moe/skills/` at init and loaded per role; daemon `prebuild` regenerates the vendored init/skill file content.

## Subtree guides

Claude Code loads these only when working under that directory; other CLIs should read them directly when touching that code.

- `scripts/CLAUDE.md` — agent launchers (`moe-agent.{sh,ps1}`): per-CLI launch argv/sandbox/model defaults, **Land on every exit** (commit attribution, rescue refs), heartbeat sidecar, MCP servers for spawned agents.
- `packages/moe-daemon/CLAUDE.md` — daemon internals: adding/changing MCP tools (registry, mutex, `blocking`), task-size + verification gates, dead-worker handling (restart purge/hold, reattach, release routing), shared resources.

## Reference

| Doc | Purpose |
|---|---|
| `docs/SCHEMA.md` | Canonical data shapes |
| `docs/MCP_SERVER.md` | MCP tool contracts (every registered tool has a section); the authoritative list is still `getTools()` in `packages/moe-daemon/src/tools/index.ts` |
| `docs/ARCHITECTURE.md` | System architecture |
| `docs/DEVELOPMENT.md` | Extended build/run guide |
| `docs/CONFIGURATION.md` | Settings + env vars reference (source of truth for defaults stays `packages/moe-daemon/src/index.ts`) |
| `docs/TROUBLESHOOTING.md` | Common failure modes + fixes |
| `docs/roles/{architect,worker,qa,governor}.md` | Agent role guides |
