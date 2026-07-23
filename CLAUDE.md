# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Moe is an AI Workforce Command Center — IDE plugins + a Node daemon that orchestrate AI agents through a task lifecycle (BACKLOG → PLANNING → AWAITING_APPROVAL → WORKING → REVIEW → DONE). The lifecycle has back-edges: `qa_reject` sends REVIEW → WORKING, auto-flipping to PLANNING after 3 reopens or when the same DoD item fails twice; in CONTROL mode a governor plan-critique `block` verdict also flips a task back to PLANNING. JetBrains is the primary IDE — implement and test JetBrains changes first; VS Code lags and workers tend to over-index on it, so push back and prioritize JetBrains parity.

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
| `packages/moe-proxy/` | TS (Node, ESM) | MCP stdio shim. Agent CLI speaks MCP over stdio; proxy forwards to the daemon over `ws://127.0.0.1:<port>/mcp` (reconnects, per-message timeouts). Injects `workerId` (from `MOE_WORKER_ID`, set by the launchers) into every `tools/call` that omits it. |
| `packages/moe-claude-plugin/` | TS (Node, ESM) | Claude Code plugin: slash commands + PostToolUse hook forwarding `moe.*` tool events to the daemon's `/ws` (fire-and-forget, fail-open; opt out `MOE_DISABLE_TOOL_HOOK=1`). The hook shim imports `dist/` (not committed) and swallows errors — src edits are silently inert until `npm run build`. |
| `moe-jetbrains/` | Kotlin/Swing | Primary plugin. Bundles daemon+proxy+scripts+role docs+skills; auto-spawns the daemon on project open (and kills it on close if it's the last project using that PID; override resolution via `MOE_DAEMON_COMMAND`/`MOE_NODE_COMMAND`). Tool window with a 5-column board over `/ws` — AWAITING_APPROVAL is display-mapped into the Planning column, not a column of its own. |
| `moe-vscode/` | TS | VS Code / Antigravity extension (secondary). Also bundles daemon+proxy+scripts and auto-spawns the daemon; registers the bundled proxy as an MCP server on Antigravity. No automated tests (MANUAL_TESTS.md only). |

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

Windows full install (daemon + proxy + JetBrains plugin): `.\scripts\install-all.ps1`

## Run

The daemon default port is **9876** (override `--port` or `MOE_DEFAULT_PORT`; auto-scans the next 50 if taken). It binds `127.0.0.1` unless `--host`/`MOE_BIND_HOST` says otherwise (recorded as `bindHost` in daemon.json when non-loopback). Project resolves from `--project`, else `MOE_PROJECT_PATH`, else cwd. Endpoints: `ws://localhost:<port>/ws` (plugins), `ws://localhost:<port>/mcp` (proxy), HTTP `GET /health`. Clients discover the port from `.moe/daemon.json` (written by the daemon): the proxy retries a missing file for ~5 min (survives supervised restarts) but exits immediately on a project-path mismatch — the check treats `D:\path` and `/mnt/d/path` as the same project, and `MOE_DAEMON_HOST` overrides the proxy's connect host (both exist for **WSL agent mode**: the JetBrains Agents menu toggle "Run Agents in WSL" spawns the daemon with `--host 0.0.0.0` and launches agents via `moe-agent.sh` with `/mnt/` paths; the sh pre-flight detects a Windows-owned daemon.json by its drive-letter projectPath, probes `/health` over loopback then the WSL gateway instead of `kill -0` — a Windows PID is invisible in WSL — and refuses to delete daemon.json or start a duplicate daemon when the probe fails; requires node + the agent CLI installed inside the distro).

```bash
node packages/moe-daemon/dist/index.js start  --project <path>   # supervised (auto-restart, exp. backoff)
node packages/moe-daemon/dist/index.js init   --project <path>   # creates .moe/ then starts (keeps running)
node packages/moe-daemon/dist/index.js status --project <path>
node packages/moe-daemon/dist/index.js stop   --project <path>
node packages/moe-daemon/dist/index.js doctor --project <path>   # offline health check; exit 0 = green
node packages/moe-proxy/dist/index.js                            # MCP stdio bridge (agents)
scripts/moe-call.sh <tool> '<json-args>' --project <path>        # one-shot moe.* tool call from a terminal
```

`start` runs a supervisor that spawns the real daemon via the internal `_run` command and restarts it on crash (max 5 in 60s, backoff capped at 30s). Every daemon (re)start purges ALL worker records and releases their orphaned tasks (`purgeAllWorkers`) — agents must re-register after a restart. `doctor` does NOT require a running daemon — it walks `.moe/` checklist probes and exits 1 on any hard fail.

Launch agents via `scripts/moe-agent.{ps1,sh}` or a full team via `scripts/moe-team.{ps1,sh}`. Pre-flight: daemon autostart, per-CLI MCP-config writes, team/chat join, `claim_next_task` + `get_context` preload, and a `.moe/agents/*.md → .claude/agents/` subagent mirror (gated by `settings.enableAgentTeams`; sets `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`). Skills are NOT synced by the wrapper — the daemon writes `.moe/skills/` at init and agents load them via their host's Skill tool. Post-flight: branch safety + auto-commit/push. Agents run **in the project directory** — except the PowerShell `claude` launch, which runs in the launcher's cwd and binds to the project via `MOE_PROJECT_PATH` + a temp `--mcp-config` (codex/gemini and all `.sh` launches `cd` into the project). The PowerShell launcher spawns claude `--print` one-shot and respawns a fresh CLI per task (`-Interactive` for the TUI; architect/governor default to interactive); **the bash launcher always runs the TUI** (`--print` not implemented there yet, though it has the same per-task respawn loop). Model defaults: `claude-sonnet-5` for all roles (launched with `--effort max`), honored only by the `claude` CLI; codex instead gets `model_reasoning_effort = "xhigh"` written into its config.toml (override via `MOE_CODEX_REASONING_EFFORT`); override the claude model via `-Model`/`--model` or `settings.models.{role}`.

## Test

```bash
cd packages/moe-daemon && npm test                                  # vitest run (all)
cd packages/moe-daemon && npx vitest run src/server/McpAdapter.test.ts   # single file
cd packages/moe-daemon && npx vitest run -t "<test name>"                # single test by name
cd moe-jetbrains       && ./gradlew test                            # plugin unit tests (JUnit 4, headless — a CI merge gate)
bash scripts/tests/postflight.sh                                    # launcher-script harness (daemon-free; .ps1 sibling for PowerShell)
npm run lint                                                        # repo root: role-doc linter (bash script — Git Bash on Windows)
```

Run daemon tests after touching daemon code; run `./gradlew test` after touching Kotlin. Proxy and claude-plugin have their own `npm test`. `npm run lint` enforces a hard 40-line cap on `docs/roles/{architect,worker,qa}.md` (governor + `*.reference.md` exempt) — keep role docs terse, put detail in the `.reference.md` files.

CI (`.github/workflows/ci.yml`, PRs to main): daemon+proxy build + `test:coverage`, JetBrains `buildPlugin` + `./gradlew test`, and a 3-OS build matrix (ubuntu/windows/macos). Root lint and claude-plugin tests are NOT CI-enforced. Daemon changes also trigger a Docker build of `packages/moe-daemon/Dockerfile` (its EXPOSE/healthcheck port 3141 is stale vs the 9876 default — don't "fix" code to match it). Releases are tag-driven: pushing `v*` builds everything, publishes daemon+proxy to npm, attaches the plugin zip + .vsix to a GitHub Release, and publishes to JetBrains Marketplace.

## Working in this repo

- **Never edit `.moe/` files by hand** — go through `moe.*` MCP tools (contracts in `docs/MCP_SERVER.md`). Most of `.moe/` IS tracked in git (project.json, tasks/, roles/, skills/): daemon-driven diffs in `.moe/tasks/*.json` are intentional — commit/review them, don't revert them as junk. Only the runtime subset (daemon.json, activity.log, workers/, memory/, messages/, teams/) is gitignored, as is root `.mcp.json` (machine-local absolute paths — never commit it).
- Commit messages follow Conventional Commits (`feat(scope):`, `fix(scope):`, `chore:` …); releases are SemVer with all package versions synced.
- **Adding/changing daemon MCP tools**: the only registry is `getTools()` in `packages/moe-daemon/src/tools/index.ts` — an unregistered tool is silently invisible to MCP. Tool dispatch is serialized through the global reentrant state mutex (McpAdapter and plugin WS handlers share it); a tool that parks for minutes must set `blocking: true` (currently only `wait_for_task`/`chat_wait`) or it freezes every other tool fleet-wide.
- Worker post-flight auto-commits **and pushes** when a task lands in `REVIEW` (gated by `.moe/project.json` `settings.autoCommit`, default on). Branch safety: it refuses to commit on `main`/`master`, peeling onto a shared `moe/work-<YYYY-MM-DD>` branch first (not branch-per-task; existing non-default branches are reused).
- Approval modes (`CONTROL` default / `SPEED` / `TURBO`), `agentCommand`, `autoCommit`, `models.{role}`, and `enableAgentTeams` live in `.moe/project.json` `settings`.
- Dead-worker handling, three layers: every daemon (re)start purges all worker records and releases their tasks; graceful exits call `moe.deregister_worker` from the wrapper's exit trap (`moe-agent.{sh,ps1}`); and a dead **CLI** under a still-live wrapper (one-shot `--print` exits at end_turn, killing background jobs) self-heals via the wrapper resume path — `claim_next_task` returns `hasNext:false` + `alreadyAssigned` and the wrapper relaunches the CLI onto the held task with a RESUME prompt (cap `MOE_RESUME_MAX_ATTEMPTS`, default 5, then a one-time #general escalation and idle). There is deliberately **no idle-based auto-release for WORKING/PLANNING** (the old 30-min worker-liveness sweep was removed — it yanked tasks off long-running coders): a hard-crashed worker's task stays assigned until daemon restart, `moe.deregister_worker`, or a manual/governor `release_task`. Task claimability keys strictly on the owner being missing from the worker map or explicitly `DEAD` (`isTaskClaimable`) — **never on idle time for WORKING/PLANNING**: a worker quiet past the 120s `isWorkerAlive` presence window (display-only, for `list_workers`/`chat_who`) keeps its task. **REVIEW is the deliberate exception**: a QA owner silent past `reviewStaleTimeoutMs` (default 30 min, same default as `staleWorkerTimeoutMs`; both configurable per-project via `.moe/project.json` `settings`) has its REVIEW task released (unassigned, status stays REVIEW) so another QA can claim it — added because a hard-crashed QA with no graceful deregister isn't `DEAD` and would otherwise strand the task forever. Release routing (`nextStatusForRelease`, shared by every path): WORKING stays WORKING-unassigned so the next worker re-claims and resumes it (workers claim ONLY the WORKING column — BACKLOG is human-gated and invisible to agents), or →REVIEW if every step is already done; PLANNING/REVIEW stay put. The **blocked-timeout sweep is the one 'park' exception**: it routes in-flight tasks (PLANNING/WORKING/REVIEW) → BACKLOG deliberately, because the blocker is usually environmental and requeueing would claim-thrash the next agent into the same wall; humans un-park via `set_task_status` (BACKLOG→PLANNING/WORKING/REVIEW are all legal transitions). `claim_next_task`/`wait_for_task` hard-reject statuses outside PLANNING/WORKING/REVIEW — claiming a human-gated column (BACKLOG/AWAITING_APPROVAL/DONE) used to "succeed" without transitioning status and wedge the worker. `DEAD` workers are dropped from the UI and their records pruned once they own nothing.
- **Heartbeat sidecar** (`moe-agent.{sh,ps1}`): the wrapper blocks synchronously on the CLI subprocess for its whole runtime with zero interleaved activity, and `moe-proxy` opens a fresh connection per RPC call rather than holding one for the CLI's lifetime — so the daemon's only liveness signal is "did this worker call a moe.* tool recently." A long silent local step (a build, a full test run) can outlast `reviewStaleTimeoutMs` even while the CLI is still very much alive and about to call `qa_approve`/`qa_reject`, which would otherwise let the REVIEW self-heal above steal the task out from under a live session. The wrapper runs a background sidecar (PowerShell `Start-Job` / bash backgrounded subshell) alongside the blocking CLI call that pings the no-op `moe.heartbeat` tool on a timer (`MOE_HEARTBEAT_INTERVAL_SEC`, default 60s) to keep `lastActivityAt` fresh, bounded by `MOE_HEARTBEAT_MAX_DURATION_SEC` (default 2h) so a truly-hung CLI still eventually goes stale — this extends the self-heal's patience window, it does not defeat it. Stopped via `Stop-HeartbeatSidecar`/`stop_heartbeat_sidecar` after each CLI invocation, and also from the same Ctrl+C/exit-handler paths as `moe.deregister_worker` (a `Start-Job` child is a real separate process that outlives the wrapper unless explicitly stopped). Opt out via `MOE_DISABLE_HEARTBEAT=1`.
- Skills (`docs/skills/`) are mirrored into `.moe/skills/` at init and loaded per role; daemon `prebuild` regenerates the vendored init/skill file content.
- **MCP servers for spawned agents** are built entirely by `scripts/moe-agent.{ps1,sh}` (the daemon schema has no MCP field), per CLI: `claude` gets a temp `--mcp-config` (PowerShell) or `~/.config/claude/mcp_servers.json` merge + `$PROJECT/.mcp.json` (bash); `codex` gets `.codex/config.toml` (`[mcp_servers.*]`); `gemini` gets `.gemini/settings.json` (`mcpServers`). **All three CLIs** inject the `moe` proxy server **and** a **Serena** server (LSP symbol navigation/editing + project memory) pinned to the project (headless — no dashboard/GUI), giving every role exact cross-file code intelligence and shared memory instead of whole-file reads. Serena's project root is `serenaProject` in `<project>/.moe-agent.json`, else `MOE_SERENA_PROJECT`, else the Moe project root (the override exists for multi-repo workspace roots); its `--context` is `claude-code`/`codex`/`agent` per CLI. Serena is resolved from `MOE_SERENA_PATH` or `%USERPROFILE%\.local\bin\serena.exe`/`~/.local/bin/serena` and **no-ops if not installed** (`uv tool install -p 3.13 serena-agent`); the codex/gemini writers are idempotent (re-runs don't duplicate the `serena` entry). To add more MCP servers for agents, extend these two scripts — there is no other hook.

## Reference

| Doc | Purpose |
|---|---|
| `docs/SCHEMA.md` | Canonical data shapes |
| `docs/MCP_SERVER.md` | MCP tool contracts — near-complete but NOT authoritative (`wait_for_task` and `add_comment` lack contract sections); the authoritative list is `getTools()` in `packages/moe-daemon/src/tools/index.ts` |
| `docs/ARCHITECTURE.md` | System architecture |
| `docs/DEVELOPMENT.md` | Extended build/run guide |
| `docs/CONFIGURATION.md` | Settings + env vars — **stale on env vars** (documents phantom `MOE_PORT`/`MOE_DAEMON_URL`, port 3141); trust the Run section above and `packages/moe-daemon/src/index.ts` instead |
| `docs/roles/{architect,worker,qa,governor}.md` | Agent role guides |
