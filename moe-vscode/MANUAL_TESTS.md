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
