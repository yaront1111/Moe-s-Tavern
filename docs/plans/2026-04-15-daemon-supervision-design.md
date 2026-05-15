# Daemon Self-Supervision + Crash Hardening

**Date:** 2026-04-15
**Status:** Approved

## Problem

The daemon is a plain foreground Node.js process with no auto-restart mechanism. When it dies (system reboot, crash, OOM), nothing brings it back. The only restart path is the JetBrains plugin's `ensureDaemonRunning()` on project open, which is unreliable and had an infinite loop bug.

Additionally, several code paths can crash the daemon unexpectedly:
- Unprotected `fs.writeFileSync` during project normalization
- Fire-and-forget async cleanup that can cause unhandled rejections

## Design

### Self-Supervising Wrapper

The `start` command becomes a lightweight supervisor that spawns the actual daemon as a child process and monitors it.

```
node dist/index.js start --project /path    (supervisor)
  └── node dist/index.js _run --project /path  (actual daemon)
```

**Restart policy:**
- Clean exit (code 0): don't restart (intentional shutdown)
- Crash (non-zero exit or signal kill): restart with exponential backoff
- Backoff: 1s, 2s, 4s, 8s, 16s, 30s (capped at 30s)
- Max 5 restarts within a 60-second window — if exceeded, supervisor exits
- Backoff resets after 60 seconds of stable running

**Signal handling:**
- Supervisor catches SIGTERM/SIGINT and forwards to child
- Waits for child to exit cleanly, then exits itself
- Force-kills child after 10 seconds if it doesn't exit

**daemon.json:**
- Child process writes daemon.json (it knows its own port/PID)
- On child restart, new daemon.json is written with new port/PID
- Supervisor does not write daemon.json

### Crash Vector Fixes

| Fix | File:Line | Description |
|---|---|---|
| Wrap `writeFileSync` | `StateManager.ts:590` | try-catch around project normalization write |
| Handle cleanup errors | `WebSocketServer.ts:110` | `.catch()` on `cleanupMcpWorkers()` |
| Belt-and-suspenders | `WebSocketServer.ts:107,122` | `.catch()` on async handler calls |

## Files Changed

- `packages/moe-daemon/src/index.ts` — `start` becomes supervisor, new `_run` internal command
- `packages/moe-daemon/src/state/StateManager.ts` — try-catch fix
- `packages/moe-daemon/src/server/WebSocketServer.ts` — error handling fixes
