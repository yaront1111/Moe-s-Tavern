# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Moe is an AI Workforce Command Center — IDE plugins + a Node daemon that orchestrate AI agents through a task lifecycle (BACKLOG → PLANNING → AWAITING_APPROVAL → WORKING → REVIEW → DONE). The daemon owns `.moe/` state files and is the **sole writer**; all clients (plugins, agents) talk to it over WebSocket. JetBrains is the primary IDE — implement and test JetBrains changes first; VS Code lags and workers tend to over-index on it, so push back and prioritize JetBrains parity.

```
JetBrains/VS Code Plugin ── ws://…/ws ──▶ Moe Daemon ◀── ws://…/mcp ── moe-proxy ◀── agent CLI (MCP stdio)
                                            │
                                            ▼
                                         .moe/  (source of truth — daemon is sole writer)
```

Roles: **architect** plans (`submit_plan`), **worker** codes per-step, **QA** reviews (`qa_approve`/`qa_reject`), **governor** oversees the fleet (never claims tasks). Humans gate transitions unless approval mode is relaxed.

## Packages

| Path | Lang | Role |
|---|---|---|
| `packages/moe-daemon/` | TS (Node, ESM) | Core daemon: `.moe/` StateManager, FileWatcher (chokidar), WebSocketServer (`/ws` + `/mcp`), McpAdapter, 40+ MCP tools. Self-supervises with crash restart. (Cross-session memory is delegated to the Serena MCP server — see `docs/MEMORY.md`.) |
| `packages/moe-proxy/` | TS (Node, ESM) | MCP stdio shim. Agent CLI speaks MCP over stdio; proxy forwards to the daemon over `ws://127.0.0.1:<port>/mcp` (reconnects, per-message timeouts). |
| `packages/moe-claude-plugin/` | TS (Node, ESM) | Claude Code plugin: slash commands + PostToolUse hook wiring Claude Code into the daemon. |
| `moe-jetbrains/` | Kotlin/Swing | Primary plugin. Bundles daemon+proxy+scripts. Tool window with 6-column board over `/ws`. |
| `moe-vscode/` | TS | VS Code / Antigravity extension (secondary). |

Daemon, proxy, and claude-plugin each build with `tsc` and test with `vitest`. There are **no npm workspaces** — install/build per package. Root `package.json` only has `npm run lint` (role-doc linter).

## Build

```bash
cd packages/moe-daemon && npm install && npm run build   # prebuild generates init + skill files
cd packages/moe-proxy  && npm install && npm run build
cd moe-jetbrains       && ./gradlew buildPlugin           # zip → moe-jetbrains/build/distributions/
cd moe-jetbrains       && ./gradlew runIde                # sandbox IDE for dev
```

Windows full install (daemon + proxy + plugin): `.\scripts\install-all.ps1`

## Run

The daemon default port is **9876** (override `--port` or `MOE_DEFAULT_PORT`; auto-scans the next 50 if taken). Project resolves from `--project`, else `MOE_PROJECT_PATH`, else cwd. Endpoints: `ws://localhost:<port>/ws` (plugins), `ws://localhost:<port>/mcp` (proxy), HTTP `GET /health`.

```bash
node packages/moe-daemon/dist/index.js start  --project <path>   # supervised (auto-restart, exp. backoff)
node packages/moe-daemon/dist/index.js init   --project <path>   # creates .moe/ then starts (keeps running)
node packages/moe-daemon/dist/index.js status --project <path>
node packages/moe-daemon/dist/index.js stop   --project <path>
node packages/moe-daemon/dist/index.js doctor --project <path>   # offline health check; exit 0 = green
node packages/moe-proxy/dist/index.js                            # MCP stdio bridge (agents)
```

`start` runs a supervisor that spawns the real daemon via the internal `_run` command and restarts it on crash (max 5 in 60s, backoff capped at 30s). `doctor` does NOT require a running daemon — it walks `.moe/` checklist probes and exits 1 on any hard fail.

Launch agents via `scripts/moe-agent.{ps1,sh}` (pre-flight workspace+skill sync, post-flight branch safety) or a full team via `scripts/moe-team.{ps1,sh}`. Agents run **in the project directory** — except the PowerShell `claude` launch, which runs in the launcher's cwd and binds to the project only via `MOE_PROJECT_PATH` + the proxy's `--mcp-config` (codex/gemini and all `.sh` launches `cd` into the project). Claude is spawned `--print` one-shot per task (`-Interactive` for the TUI; architect/governor default to interactive); the wrapper polls and respawns a fresh CLI per task. Per-role model default is `claude-opus-4-8`, overridable via `-Model` or `settings.models.{role}`.

## Test

```bash
cd packages/moe-daemon && npm test                                  # vitest run (all)
cd packages/moe-daemon && npx vitest run src/server/McpAdapter.test.ts   # single file
cd packages/moe-daemon && npx vitest run -t "<test name>"                # single test by name
npm run lint                                                        # repo root: role-doc linter
```

Run daemon tests after touching daemon code. Proxy and claude-plugin have their own `npm test`.

## Working in this repo

- **Never edit `.moe/` files by hand** — the daemon is the sole writer. Go through `moe.*` MCP tools (contracts in `docs/MCP_SERVER.md`).
- Worker post-flight auto-commits **and pushes** when a task lands in `REVIEW` (gated by `.moe/project.json` `settings.autoCommit`, default on). Branch safety: it refuses to commit on `main`/`master`, peeling onto a shared `moe/work-<YYYY-MM-DD>` branch first (not branch-per-task; existing non-default branches are reused).
- Approval modes (`CONTROL` default / `SPEED` / `TURBO`) and `agentCommand` live in `.moe/project.json` `settings`.
- Dead-worker handling (default-on): a worker that crashes or closes its terminal has its tasks released automatically. Graceful exits call `moe.deregister_worker` from the wrapper's exit trap (`moe-agent.{sh,ps1}`); hard crashes are caught by the worker-liveness sweep (releases after ~30 min idle, marks the worker `DEAD`). A dead-but-present owner's task is *immediately* claimable (120s presence window via `isWorkerAlive`) so the board self-heals without waiting for the sweep. Release routing: WORKING→BACKLOG, or →REVIEW if every step is already done; the same `nextStatusForRelease` is used by every path (sweep, deregister, manual `release_task`, blocked-timeout). `DEAD` workers are dropped from the UI and pruned by a later sweep. Opt out with `MOE_DISABLE_AUTO_RELEASE=1`; preview with `MOE_AUTO_RELEASE_DRY_RUN=1`.
- Skills (`docs/skills/`) are mirrored into `.moe/skills/` at init and loaded per role; daemon `prebuild` regenerates the vendored init/skill file content.
- **MCP servers for spawned agents** are built entirely by `scripts/moe-agent.{ps1,sh}` (the daemon schema has no MCP field), per CLI: `claude` gets a temp `--mcp-config` (PowerShell) or `~/.config/claude/mcp_servers.json` merge + `$PROJECT/.mcp.json` (bash); `codex` gets `.codex/config.toml` (`[mcp_servers.*]`); `gemini` gets `.gemini/settings.json` (`mcpServers`). **All three CLIs** now inject the `moe` proxy server **and** a **Serena** server (LSP symbol navigation/editing + project memory) **pinned to the project** (`--project <root>`, headless — no dashboard/GUI), giving every role exact cross-file code intelligence and shared memory instead of whole-file reads. Serena's `--context` is `claude-code`/`codex`/`agent` per CLI. Serena is resolved from `MOE_SERENA_PATH` or `%USERPROFILE%\.local\bin\serena.exe`/`~/.local/bin/serena` and **no-ops if not installed** (`uv tool install -p 3.13 serena-agent`); the codex/gemini writers are idempotent (re-runs don't duplicate the `serena` entry). To add more MCP servers for agents, extend these two scripts — there is no other hook.

## Reference

| Doc | Purpose |
|---|---|
| `docs/SCHEMA.md` | Canonical data shapes |
| `docs/MCP_SERVER.md` | Full MCP tool contracts (authoritative tool list) |
| `docs/ARCHITECTURE.md` | System architecture |
| `docs/DEVELOPMENT.md` | Extended build/run guide |
| `docs/CONFIGURATION.md` | Settings + env vars |
| `docs/roles/{architect,worker,qa,governor}.md` | Agent role guides |
