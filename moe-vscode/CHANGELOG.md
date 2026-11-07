# Changelog

All notable changes to the Moe VS Code extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

VS Code parity with JetBrains and shared client behaviour (epic-aabc654d; see `docs/plans/2026-11-02-vscode-reuse.md`).

### Added
- Task status notifications for Awaiting Approval, Blocked, Review and Done, with a **View Task** action (none for Done). STATE_SNAPSHOT frames and frames before the first snapshot never notify.
- Task detail: a read-only **Delivery** section (candidate, reported check run, required-check verdict, delivery receipt, attempt phase) and a **Release Agent** button with a confirmation, which sends RELEASE_TASK.
- **Claude accounts** view in the Moe sidebar. It shows the rotation (status, 5-hour and weekly usage per account) plus a chips line, and has add, sign in, remove, move up/down, rename and switch-percent actions. Sign-in and sign-out run the daemon's accounts CLI in a "Claude accounts" terminal.
- Agent seats launched from this window are deregistered (DEREGISTER_WORKER, reason `terminal_closed`) when their terminal closes. The deregistration is re-sent at each connect until the daemon acknowledges it. A seat whose shell survives a window reload is kept.
- Settings: an **Enable Agent Teams** checkbox and a read-only **Landing & Gate Policy** section.
- Per-task worktrees (`.worktrees/`) are excluded from file watching and search by default.
- Shared test corpora: the VS Code delivery, blocker, settings-policy, accounts and seat-tracker logic replays the same `moe-jetbrains/src/test/resources/client-*.json` rows as JetBrains, and its labels are checked against `MoeBundle.properties`.

### Changed
- The task board opens as an editor tab ("Moe Task Board") in the column task details open in, instead of filling the narrow sidebar. Showing the sidebar's Task Board entry opens it, **Moe: Open Task Board** and the status bar item bring it forward, and the tab comes back after a window reload.
- Settings no longer edit `autoCreateBranch`, `branchPattern` or `commitPattern`, which no launcher reads. Values already saved in `.moe/project.json` are kept.
- The bundled scripts and docs come from `scripts/bundle-manifest.json`, the same list the JetBrains build reads. The vsix now also ships the remaining `docs/roles` reference files.
- The vsix ships only the esbuild bundle `dist/extension.js`, without the tsc output or `eslint.config.mjs`. CI packages the extension and smoke-tests its bundle on every pull request.

### Removed
- The `moe.agentCommand` and `moe.chat.notifications.soundEnabled` settings, which the extension never read. **Moe: Start Agent** asks which CLI to launch (the last one used is listed first), and **Moe: Open Settings** still edits the project's agent command in `.moe/project.json`.

### Fixed
- The board's **Delete** (card menu) and the Done column's clear button now ask in a VS Code modal and then act, as in JetBrains. Before, both did nothing, because a webview cannot show a confirmation dialog. The clear quotes every Done task it archives (the selected epic, else the whole board), not only the cards the board search shows.
- A deleted chat channel (CHANNEL_DELETED) leaves the channel list and the current selection.
- Chat channel auto-selection matches JetBrains: on first load, or when the selected channel is gone, the view selects the general channel, else the first listed one. A repeated CHANNEL_CREATED frame no longer lists a channel twice.
- Terminal commands refuse every C0 control character and DEL. PowerShell quoting doubles the curly single quotes PowerShell also treats as quotes, so a project path such as `Bob’s work` stays one argument.
- Task detail refreshes its **Delivery** section and **Release Agent** button live while the panel is open, instead of showing the task as it was when the panel opened.
- While disconnected, the **Claude accounts** view keeps the accounts from the last rotation it received: **Sign in** and **Sign out and remove** still run the accounts CLI in the "Claude accounts" terminal, and the list edits come back when the daemon reconnects. With no rotation received yet it shows "Not connected to the Moe daemon.", as JetBrains does.
- On Windows, agent and account terminals always open in Windows PowerShell (`powershell.exe`), whatever the default terminal profile is.
- Each **Prior hand-offs** card in task detail is titled with who released the task, when and why (`#1 released by <worker> (<time>): <reason>`), as in JetBrains. Before, the title was only `#1`, `#2` and so on.
- Plan review and task detail show an amended plan step's current text (the active `moe.amend_plan_step` amendment), with an "Amended by <who>" line whose tooltip keeps the original, as in JetBrains. Before, they showed the original text while **Approve** approved the amended plan.
- After the daemon announces a shutdown (DAEMON_SHUTTING_DOWN, sent on every stop, crashes included), the extension waits for the supervised restart and reconnects. It reads `.moe/daemon.json` again on every try, so it follows a restart to another port. While it waits it never starts a daemon or removes `.moe/daemon.json`, and **Moe: Disconnect from Daemon** or closing the window ends the wait. If the daemon is not back after the 10 retries below (about 4 minutes, as after a deliberate stop), a warning says "The Moe daemon shut down and did not come back.", with **Reconnect**, instead of the connection-failed error. Before, it stayed disconnected until the user reconnected.
- With `moe.autoConnect` on, a first connect that finds no daemon is retried too. Retries back off 5 s, 10 s, 20 s, then 30 s; after 10 of them, the "connection failed after 10 retries" message shows once (it could show twice). Before, retries came every 5 s, and a connect that failed before any socket opened was never retried.
- **Moe: Reconnect to Daemon** waits out a connection attempt still in progress and says "Reconnected to daemon" only once it is connected. Before, a reconnect during a handshake said so and left the extension disconnected.
- Protected execution profile: when **Stop and Replace** runs the installed CLI's `stop` and it exits non-zero (it could not confirm and stop the running daemon), no replacement is started, and an error names the daemon's pid and the exit code. Before, the original refusal was shown again, with no word that the stop had failed.
- Create Task, Create Epic, task Save, Delete and Add Comment, epic Delete, the board's Delete and Done clear, and **Moe: Archive Done Tasks** say so when nothing reached the daemon, and the forms stay open with what was typed. An unsent comment goes back into the comment box if it is still empty. Before, they reported success while disconnected, and Create Task and Create Epic closed and lost the form.
- A daemon refusal, such as a WIP limit, shows as an error message, not only as an Output-channel line. **Reject** on a plan that is no longer awaiting approval, clicked before or while the reason prompt is open, sends nothing and says so.
- Board cards update when only a field they show changes: the description, the epic, the human-review flag, the blocker cause, the reopen and hand-off counts, the plan-critique verdict and concerns, and the elapsed time. Before, the board skipped those updates until something else on the card changed.
- An epic archived while the window is open leaves the cached epic list, so the board filter, Create Task and **Moe: Archive Done Tasks** no longer offer it.
- Chat keeps at most 500 messages per channel, in memory, in the saved view state and on screen, as JetBrains does. Before, the cache grew without bound and was saved whole on every message.
- Chat selects the current channel again after a window reload or a reconnect, which reloads its messages and enables the input. Before, it showed stale messages and the input stayed disabled.
- Chat escapes quotes in message text and ids, so a link in a message cannot add attributes to its `<a>` tag.
- An open Settings form follows settings changed elsewhere (JetBrains, an agent, another window): fields you have not edited show the new values, fields you edited keep yours, and the read-only landing policy refreshes. Before, Save wrote back the values the form opened with and reverted those changes.
- Create Task, Create Epic, Epic Detail and Settings keep what was typed while their tab is in the background.
- On macOS and Linux, the launch line typed into an agent or "Claude accounts" terminal starts with `env`, so it runs in any default shell, fish, tcsh and PowerShell included. Before, its `NAME=value command` form worked only in POSIX shells.
- The extension and the daemon client write to one "Moe" output channel instead of two.
- **Moe: Show Activity Log** shows the reply to its own request, never one meant for the board, and says when the daemon could not read the log.
- A rebuilt Metrics view marks the range it still shows. Before, the 30d chip was marked whatever range was selected.

## [0.8.0] - 2026-09-07

### Added
- Grok Build (xAI) as an agent CLI, alongside Claude Code, Codex and Gemini CLI.
- Task dependencies with automatic unblock when prerequisites finish; shared resources (daemon-managed exclusive leases).

### Changed
- Codex seats are interactive (TUI) by default for every role; `-CodexExec`/`--codex-exec` opts a seat into one-shot headless `codex exec`, which lands a commit per task.
- Marketplace name is now "Moe's Tavern"; the extension id stays `yaront1111.moe-vscode`.
- Launchers land a task-linked commit on every exit (completion or `wip` checkpoint) with rescue refs when landing fails.

### Fixed
- Headless Codex launch for codex-cli 0.147 and later (`--full-auto` removed upstream); the launcher now probes its argv before launching instead of relaunch-looping.
- Headless Codex seats default to `--sandbox danger-full-access` and the launcher pins `default_tools_approval_mode = "approve"` on the `moe` and `serena` MCP servers: codex 0.148 and later rejected every Moe tool call under `approval_policy = never` with a sandbox, and the Windows unelevated sandbox could not start a Store-installed PowerShell 7 (`CreateProcessAsUserW failed: 5`). `MOE_CODEX_SANDBOX` still selects a sandbox explicitly.
- Bash Codex seats get a private per-seat instructions file (`model_instructions_file`) like the PowerShell launcher, so concurrent seats no longer overwrite each other's context.

## [0.6.0] - 2026-04-21

### Added

- 8-phase skill system: 13 curated skills (`.moe/skills/<name>/SKILL.md`) shipped
  inside the .vsix and scaffolded into every Moe project on init.
  - 5 Moe-native: `moe-planning`, `explore-before-assume`,
    `adversarial-self-review`, `regression-check`, `moe-qa-loop`.
  - 8 vendored from `obra/superpowers` (MIT, attributed): TDD,
    verification-before-completion, systematic-debugging, brainstorming,
    writing-plans, receiving-code-review, using-git-worktrees,
    dispatching-parallel-agents.
- Daemon `nextAction.recommendedSkill` populated per phase (planning, test step,
  final step, blocked, reopened, REVIEW, before-complete-task).
- Agent wrapper injects an "Available Skills" index into the system prompt.

### Fixed

- `AntigravityIntegration.ts` proxy lookup path corrected
  (`bundled/proxy/index.js` is the real path; `bundled/proxy/dist/index.js`
  was a dead reference).

## [0.1.0] - 2026-02-05

### Added

- Initial release
- Kanban board sidebar panel with 6 status columns
- Drag-and-drop task status changes
- Task detail view with approve/reject/reopen actions
- WebSocket connection to moe-daemon
- Status bar item showing connection status
- Auto-connect when workspace contains .moe folder
- Extension settings for daemon host/port configuration
