# Moe VS Code Manual Validation Notes

`npm test` runs the automated node:test suite (`tests/*.test.cjs`). It loads the extension's sources under `node:vm` with a fake `vscode` module and replays the shared `moe-jetbrains/src/test/resources/client-*.json` corpora. The gate is `npm run lint && npm run compile && npm test`. The checks below cover what node:test cannot: real VS Code rendering, real terminals and a live daemon. Run them against a running daemon in a project with `.moe/`.

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

## Task status notifications
1. While connected, move a task into AWAITING_APPROVAL, then BLOCKED, then REVIEW, then DONE (through agents, the board, or `scripts/moe-call.sh`).
2. Expected: one notice per transition: "Plan Awaiting Approval", "Task Blocked" (a warning), "Task Ready for Review" and "Task Completed". Each one names the task title. The first three have a **View Task** button; "Task Completed" has none.
3. Click **View Task**. Expected: the Task Detail panel opens on that task.
4. Move a task to PLANNING or WORKING, and save a task without changing its status. Expected: no notice.
5. Run `Moe: Reconnect to Daemon` (or restart the daemon) while tasks sit in REVIEW and DONE. Expected: the reconnect snapshot shows no notice.

## Task detail: Delivery and Release Agent
1. Open the Task Detail panel for a task whose `delivery` carries a candidate, a reported check run and a receipt.
2. Expected: a **Delivery** section after the blocker section, with rows in the JetBrains order. A passed check shows a PASS-styled row, a failed one a FAIL-styled row, and hovering a shortened SHA shows the full value. A task with no delivery evidence shows no section.
3. Open a task with an assigned worker. Expected: a **Release Agent** button. A task with no worker shows none.
4. Click **Release Agent** and dismiss the dialog. Expected: nothing is sent and the task keeps its worker.
5. Click it again and confirm. Expected: the daemon releases the task (`assignedWorkerId` cleared; a WORKING task stays WORKING) with the reason "Released from board", and no success toast appears.
6. Keep the panel open while the task changes: a check run or receipt is recorded, the delivery evidence is cleared, an agent claims the task, or it is released from the board. Expected: the Delivery section and the **Release Agent** button update in place without reopening the panel. The section disappears when the task has no delivery evidence, and the button disappears when no worker is assigned.

## Claude accounts view
1. Open the **Claude accounts** view in the Moe sidebar while connected to a daemon that reports a rotation.
2. Expected: one item per account, `<position>. <label>`, with its status and 5-hour and weekly usage. The tooltip lists the five columns, and the view description shows the `Claude: ...` chips line.
3. Disconnect. Expected: the rows and the chips line stay, from the last rotation the view received. **Sign in** still runs the accounts CLI `login <id>` in the "Claude accounts" terminal, and **Remove...** offers only **Sign out and remove**. **Add...**, **Rename...**, **Move up**, **Move down** and **Set Switch Percent...** are not offered. Reconnect, and the list edits return. A window opened while the daemon is down has no rotation yet, so it shows the single "Not connected to the Moe daemon." item.
4. Change the board, for example by moving a task. Expected: the view re-renders, and relative reset times update.
5. Use the title-bar **Add...**, enter a name and confirm. Expected: a "Claude accounts" terminal opens and runs the daemon's accounts CLI `login <new id>`, so the account can be signed in with a Claude subscription.
6. On an account, run **Sign in**, **Rename...**, **Move up**, **Move down** and **Remove...** (both **Sign out and remove** and **Remove only**), plus the title-bar **Set Switch Percent...**. Expected: each change shows up in the view after the daemon's ACCOUNTS_UPDATED. Sign in and Sign out and remove run in the "Claude accounts" terminal. A move that is not allowed (the first account's Move up) is not offered.
7. Enter a rename with a control character, or a percent outside 1-100. Expected: the input box refuses it and nothing is sent.

## Worktrees stay out of watching and search
1. In a project with a per-task worktree under `.worktrees/<task>`, run a workspace search for a string that exists only inside the worktree.
2. Expected: no result from `.worktrees/`, and Quick Open (Ctrl+P) does not offer worktree files.
3. Expected: the Explorer still lists `.worktrees/` (the extension does not contribute `files.exclude`).

## Agent seats deregister when their terminal closes
1. Run `Moe: Start Agent` → worker, and wait for the seat to appear in `moe.list_workers` and claim a task.
2. Close (kill) that agent's terminal.
3. Expected: the worker is deregistered (reason `terminal_closed`) and its task is released, unassigned and claimable again.
4. Launch a seat, run `Moe: Disconnect from Daemon`, close the seat's terminal, then reconnect. Expected: the deregistration is sent at the reconnect.
5. Launch a seat, then run **Developer: Reload Window** while its terminal keeps running (persistent terminal sessions). Expected: after the reload the seat is NOT deregistered, and closing its terminal afterwards still deregisters it.
6. Open an ordinary terminal (not a Moe seat) and close it. Expected: no worker is deregistered.

## Deleted chat channel
1. Select a non-general channel in the Chat view, then delete that channel on the daemon side.
2. Expected: the channel leaves the list, the selection falls back to the general channel (the first general-type channel in list order), else the first listed channel, as in JetBrains, and nothing can be sent to the deleted one. With no channel left, the view shows "Select a channel to start chatting" and the input stays disabled.

## Windows terminals use Windows PowerShell
1. On native Windows (not Remote-WSL), set `terminal.integrated.defaultProfile.windows` to **Command Prompt** or **Git Bash**. Run `Moe: Start Agent` → worker, and **Sign in** on an account in the **Claude accounts** view. Expected: both terminals open in Windows PowerShell whatever the default profile: the agent terminal runs the `-EncodedCommand` line and its seat registers, and the "Claude accounts" terminal runs the accounts CLI line.

## Remote-WSL (VS Code's answer to JetBrains' "Run Agents in WSL")
1. Install Node.js and the agent CLI inside the WSL distro. From Windows VS Code, open the project with **WSL: Open Folder in WSL** (Remote-WSL).
2. Expected: the extension runs in the WSL extension host. The bundled daemon starts inside the distro with a Linux project path (`/mnt/...` or `/home/...`), `.moe/daemon.json` names that path, and the board connects.
3. Run `Moe: Start Agent` → worker. Expected: the terminal runs the bundled `moe-agent.sh` with bash quoting, not a PowerShell `-EncodedCommand` line, and the seat registers with the daemon.
4. Expected: Claude account sign-in runs the bash form of the accounts CLI line in the WSL terminal.
5. If a Windows-side daemon (for example one JetBrains started) already serves the same project, record whether the extension connects to it. Expected: the agent wrapper's pre-flight in `moe-agent.sh` finds that daemon through `/health` and does not start a second one.
