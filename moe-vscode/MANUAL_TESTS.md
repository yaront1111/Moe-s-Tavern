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
2. Point `moe.daemon.port` at an unused port, or open the workspace while no daemon runs and `moe.daemon.autoStart` is off. (A daemon stopped after a connected session ends differently: see step 6 of the next section.)
3. Expected: reconnect attempts continue 5 s, 10 s, 20 s, then every 30 s (the Moe output channel logs each one), including failures that occur before a WebSocket close event and a first connect that found no daemon. After 10 retries, about 4 minutes, one "Moe daemon connection failed after 10 retries." message with a **Reconnect** button appears.

## Reconnect after a daemon restart
1. With `moe.autoConnect=true`, connect to a daemon started with `node packages/moe-daemon/dist/index.js start --project <path>`.
2. Run `stop` for that project, then within a minute or two `start` it again while another process holds its old port (for example `node -e "require('net').createServer().listen(<old port>, '127.0.0.1')"`), so it comes back on another port.
3. Expected: the status bar shows disconnected, then connected on its own once the new daemon writes `.moe/daemon.json`. Between `stop` and `start`, `status` shows that the extension started no daemon of its own, and the extension never deletes `.moe/daemon.json`.
4. Kill the daemon process that `.moe/daemon.json` names (not its supervisor). Expected: the supervisor restarts it and the extension reconnects without a click; afterwards `status` shows one daemon.
5. Repeat step 2 and run `Moe: Disconnect from Daemon` before the `start`. Expected: no retries follow, and the extension stays disconnected after the daemon is back. Closing the window while it waits leaves no retry running either.
6. Run `stop` and leave the daemon stopped. Expected: the same retries (5 s, 10 s, 20 s, then every 30 s), and the extension starts no daemon. After 10 retries, about 4 minutes, one warning, "The Moe daemon shut down and did not come back.", appears with a **Reconnect** button, and no "connection failed" error. **Reconnect** connects as `Moe: Connect to Daemon` does, so with `moe.daemon.autoStart` on it starts the daemon.

## Reconnect during a handshake
1. Run `Moe: Reconnect to Daemon` while the status bar shows connecting (for example right after a daemon restart), or twice in quick succession.
2. Expected: "Reconnected to daemon" appears only when the status bar shows connected; a failed attempt shows "Failed to reconnect: ..." instead.

## Protected profile: a stop that cannot stop the daemon
1. In a protected-profile workspace, start the daemon outside this window (so the extension cannot verify it), then make it unable to answer `/health`, for example by suspending it (`kill -STOP <pid>`).
2. Connect and choose **Stop and Replace** in the refusal dialog.
3. Expected: the installed CLI's `stop` exits 1 and an error says "Protected execution profile: the installed Moe CLI did not stop the running Moe daemon (pid <pid>; stop exited 1), so no replacement was started. Stop that process yourself, then reconnect." `.moe/daemon.json` still names the old pid, no second daemon starts, and no retry follows. Resume the process (`kill -CONT <pid>`) afterwards.

## Daemon refusals reach the user
1. Set a WIP limit the board can hit (for example `columnLimits.WORKING` of 1 with one WORKING task) and drag another task into Working.
2. Expected: an error message carrying the daemon's refusal text, not only an Output-channel line.
3. Open Plan Review on an AWAITING_APPROVAL task and approve that plan elsewhere (JetBrains or `scripts/moe-call.sh`), then click **Reject**. Expected: "This task is no longer awaiting plan approval, so nothing was rejected." and the task stays as it is. Repeat from task detail, and once with the reject reason prompt open while the plan is approved elsewhere.

## Unsent edits stay
1. Open Create Task, Create Epic, a task detail and an epic detail, then stop the daemon so the extension is disconnected.
2. Click Create, Save, Delete and Add Comment (with a comment typed).
3. Expected: a warning per action ("Not connected to Moe daemon — task was not created.", "... task was not saved.", "... comment was not added." and so on), every panel stays open with what was typed, and the comment goes back into the comment box if it is still empty. Reconnect and repeat: each action goes through and its form closes.

## The board opens as an editor tab
1. Click the Moe icon in the activity bar.
2. Expected: the board opens as a "Moe Task Board" editor tab in the first editor column, with the columns across the editor's width, and the sidebar's Task Board entry shows an **Open Task Board** button. Focus stays where it was.
3. Open a task from the board. Expected: the task detail opens as another tab in the same column, and the board tab stays open.
4. Run `Moe: Open Task Board` again, and click the connected status bar item. Expected: each brings the existing board tab forward; no second board tab appears.
5. Close the board tab, then switch the sidebar to Explorer and back to Moe. Expected: the board tab opens again.
6. With the board tab open, run `Developer: Reload Window`. Expected: one board tab comes back, showing the board.

## Board cards update in place
1. Keep the board open while a task's description, epic, human-review flag, blocker, reopen count or plan-critique verdict changes on the daemon side (an agent, JetBrains or `scripts/moe-call.sh`).
2. Expected: the card shows the change at once, without a status change or a board refresh.

## Settings follow changes made elsewhere
1. Run `Moe: Open Settings`, then change the approval mode and agent command from JetBrains (or another VS Code window) and save there.
2. Expected: the open form shows the new values without reopening, and the read-only Landing & Gate Policy section refreshes after a policy change.
3. Type a new agent command in the form, then change the approval mode elsewhere. Expected: the form keeps your agent command and shows the new mode; Save writes both.

## Forms keep what was typed while hidden
1. Open Create Task, Create Epic, an epic detail or Settings, type into it, switch to another editor tab, then back.
2. Expected: the text is still there.

## Launch lines in any default shell (macOS and Linux)
1. Set the default terminal profile to fish, tcsh or PowerShell (`pwsh`). Run `Moe: Start Agent` → worker, and **Sign in** on an account in the **Claude accounts** view.
2. Expected: each line starts with `env` and runs: the seat registers with the daemon, and the accounts CLI starts its login.

## Chat after a reload or a reconnect
1. Select a non-general chat channel, then run **Developer: Reload Window**. Expected: the same channel is selected again, its messages reload and the input is enabled.
2. Disconnect, have an agent post to the channel, then reconnect. Expected: the message shows up without selecting the channel again.
3. Keep the channel open while more than 500 messages are posted to it (a loop of `scripts/moe-call.sh chat_send ...`). Expected: the view shows the newest 500, and a window reload restores no more than that.
4. Post `[docs](https://example.com" style="color:red)` to a channel. Expected: the link text is not red and the link has no `style` attribute (inspect with **Developer: Open Webview Developer Tools**).

## Metrics range after a view rebuild
1. In the Metrics view, pick **7d**, then move the view to another sidebar or the panel (or reload it).
2. Expected: **7d** is still the marked range, and the figures are 7-day figures.

## Activity log
1. Run `Moe: Show Activity Log` while connected. Expected: a document with the latest 50 events opens.
2. Open the board's Activity tab (it asks for 200 events) and run the command again. Expected: the document lists 50 events, and the Activity tab keeps its own 200: neither request is answered with the other's reply.

## Output channel
1. Open the Output panel's channel list. Expected: one "Moe" entry, carrying both the extension's and the daemon client's lines.

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
6. Open a task whose agent is mid-step (a step IN_PROGRESS, e.g. a hung or crashed worker), click **Release Agent** and confirm. Expected: a second modal naming the agent, the step and the task, with a **Force Release Agent** button. Dismiss it: nothing is sent. Repeat and click **Force Release Agent**: the daemon releases the task (`assignedWorkerId` cleared; a WORKING task stays WORKING). If the step completes or the task changes hands while that modal is open, the "Nothing was sent. ..." warning appears and nothing is sent.
7. Click **Release Agent** on a task with no step in progress, have its agent start a step (`moe.start_step`) before you confirm, then confirm. Expected: an error message "Agent was not released: [STEP_LEASE_HELD] ..." carrying the daemon's text, not only an output-channel line.
8. Keep the panel open while the task changes: a check run or receipt is recorded, the delivery evidence is cleared, an agent claims the task, or it is released from the board. Expected: the Delivery section and the **Release Agent** button update in place without reopening the panel. The section disappears when the task has no delivery evidence, and the button disappears when no worker is assigned.

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
