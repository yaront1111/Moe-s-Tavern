# CLAUDE.md

Guidance for Claude Code working in this repo.

## Project

Moe is an AI Workforce Command Center — a JetBrains/VS Code plugin + Node daemon that orchestrates AI agents through a task lifecycle. The daemon owns `.moe/` state files; clients (plugin, agents) talk to it via WebSocket. JetBrains is the primary IDE — implement and test JetBrains changes first.

```
JetBrains Plugin ── /ws ──▶ Moe Daemon ◀── /mcp ── moe-proxy ◀── agent CLI (MCP stdio)
                              │
                              ▼
                           .moe/  (source of truth — daemon is sole writer)
```

## Build

```bash
cd packages/moe-daemon && npm install && npm run build
cd packages/moe-proxy  && npm install && npm run build
cd moe-jetbrains       && ./gradlew runIde     # JetBrains sandbox
```

Windows full install: `.\scripts\install-all.ps1`

## Run

```bash
node packages/moe-daemon/dist/index.js start  --project <path>
node packages/moe-daemon/dist/index.js status --project <path>
node packages/moe-daemon/dist/index.js stop   --project <path>
node packages/moe-proxy/dist/index.js          # MCP stdio bridge
```

## Working in this repo

- Daemon is the sole writer of `.moe/`. Never edit those files by hand — go through MCP tools.
- Run `npm test` in `packages/moe-daemon` after touching daemon code.
- Workers tend to over-index on VS Code; push back and prioritize JetBrains parity.

## Reference

| Doc | Purpose |
|---|---|
| `docs/SCHEMA.md` | Canonical data shapes |
| `docs/MCP_SERVER.md` | Full MCP tool contracts (the authoritative tool list) |
| `docs/ARCHITECTURE.md` | System architecture |
| `docs/DEVELOPMENT.md` | Extended build/run guide |
| `docs/roles/architect.md`, `worker.md`, `qa.md` | Agent role guides |
