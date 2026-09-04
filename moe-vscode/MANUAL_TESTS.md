# Moe VS Code Manual Validation Notes

No automated VS Code extension test harness exists in this package yet; the current required gate is `npm run compile`. Use these notes for the disconnect/reconnect paths changed by task-76121d08.

## Disconnect stays disconnected
1. Open a workspace with `.moe/` and `moe.autoConnect=true`.
2. Run `Moe: Connect to Daemon` and wait for the status bar to show connected.
3. Run `Moe: Disconnect from Daemon`.
4. Expected: the status changes to disconnected and remains disconnected; no reconnect timer starts until the user runs connect/reconnect.

## User reconnect clears manual disconnect
1. After the previous scenario, run `Moe: Connect to Daemon` or `Moe: Reconnect to Daemon`.
2. Expected: connection attempts are allowed again and successful connection resets reconnect attempts.

## Project mismatch auto-heals
1. Enable `moe.autoConnect=true` and connect to a daemon whose `STATE_SNAPSHOT.project.rootPath` does not match the open workspace.
2. Expected: the extension deletes the stale workspace `.moe/daemon.json`, performs an internal non-manual disconnect, and schedules reconnect/startup instead of remaining disconnected.

## Failed reconnect keeps retrying
1. Enable `moe.autoConnect=true`.
2. Point `moe.daemon.port` at an unused port or stop the daemon after a connected session.
3. Expected: reconnect attempts continue on the timer until `maxReconnectAttempts` is exhausted, including failures that occur before a WebSocket close event.

## send/close race does not throw
1. While connected, trigger UI actions such as Refresh Board or Chat requests.
2. Immediately run Disconnect/Reconnect or stop the daemon.
3. Expected: extension host does not throw; send failures are logged to the Moe output channel and connection state moves to disconnected/reconnecting as appropriate.

## Board renders BLOCKED tasks in the Working column
1. Connect to a daemon whose state contains a task with `status: "BLOCKED"` (waiting on a shared-resource lease or a human).
2. Expected: the card appears in the **Working** column (BLOCKED has no column of its own, mirroring the JetBrains board) with an amber `BLOCKED` chip and an amber left stripe; the card never silently disappears from the board.
3. Expected: the card shows no prev/next nav arrows, and the Task Detail panel's Prev/Next buttons are no-ops for it (BLOCKED is deliberately outside the workflow order).
4. Drag the BLOCKED card and drop it back onto the Working column.
5. Expected: no status change is sent — the task stays BLOCKED (check the daemon activity log / task JSON shows no `WORKING` transition). Dropping it onto a *different* column still moves it explicitly.
6. Flip the task BLOCKED ↔ WORKING on the daemon side while the board stays open.
7. Expected: the card stays in the Working column and the BLOCKED chip appears/disappears with each flip (incremental column diff picks up the status-only change).

## Grok provider launches through the wrapper
1. Run `Moe: Start Agent` → `Start Worker` and pick **Grok** in the provider QuickPick (listed between Gemini and Custom...; on the next run the last-used provider floats to the top with a `Last used` description).
2. Expected: a `Moe Coder` terminal runs `moe-agent.sh ... --command 'grok'` (macOS/Linux) — on Windows the visible line is a `powershell ... -EncodedCommand <base64>` blob, so verify through the wrapper's own output instead; the wrapper prints `Grok MCP config written to: <project>/.grok/config.toml` and `Grok mode: headless (--prompt-file --yolo)` for a worker/qa role (`Grok mode: interactive` for architect/governor). `<project>/.grok/config.toml` contains `[mcp_servers.moe]` and the literal `MOE_WORKER_ID = "${MOE_WORKER_ID:-}"`.
3. Run `Moe: Open Settings`: the Agent Command datalist offers `grok` alongside `claude`, `codex`, `gemini`; saving `grok` round-trips into `.moe/project.json` `settings.agentCommand`.
4. Add a task comment whose author contains `grok` (e.g. `grok-worker-1`): it renders with the agent (green) styling in both the Task Detail and Plan Review panels, live-updated and on initial render alike.
