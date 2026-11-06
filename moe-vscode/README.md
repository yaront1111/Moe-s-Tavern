# Moe's Tavern

An AI agent task board for VS Code and Antigravity: run Claude Code, Codex, agy, Grok Build and GitHub Copilot CLI through a shared Kanban board with human plan approval.

JetBrains is the primary IDE for Moe's Tavern; this extension is the secondary interface to the same daemon and `.moe/` project state. Full documentation lives in the [repository](https://github.com/yaront1111/Moe-s-Tavern).

## Features

- **Kanban board** — epics and tasks across Backlog, Planning, Approval, Working, Review and Done; blocked tasks stay in Working with a BLOCKED badge and a cause chip (resource wait, dependency wait or external block)
- **Plan approval** — review each implementation plan before code is written (CONTROL mode; SPEED and TURBO relax the gate)
- **Task notifications** — a notice when a task moves into Awaiting Approval, Blocked, Review or Done, with **View Task** (Done has no button); no notice for a reconnect snapshot
- **Task detail** — the blocker section names the cause, what clears it and the prerequisites; a read-only **Delivery** section shows the candidate, check run, receipt and attempt phase the daemon reports; **Release Agent** unassigns the task's agent after a confirmation
- **Agent launcher** — start architect, worker, QA and governor agents with your chosen CLI: Claude Code, Codex, Antigravity, Grok Build or GitHub Copilot CLI. Closing the terminal of an agent this window launched deregisters that worker and releases its tasks; if the daemon is unreachable, it retries at the next connect. Seats still running after a window reload are kept
- **Claude accounts** — the accounts rotation in its own view: usage per account, the switch threshold, and add, sign in, remove, move, rename and switch-percent actions. Sign-in runs the daemon's accounts CLI in a "Claude accounts" terminal
- **Chat and metrics** — agent chat channels with notifications, plus a metrics view; a deleted channel leaves the channel list and the selection
- **Drag & drop** — change task status by dragging between columns
- **Real-time updates** — live sync over WebSocket; the status bar shows the daemon connection
- **Project settings** — **Moe: Open Settings** edits the approval mode, speed-mode delay, agent command and Agent Teams (Claude Code workers only), and shows the effective landing and gate policy from `.moe/project.json` read-only. The branch and commit pattern fields are gone, because no launcher read them
- **Worktrees stay out of the way** — per-task worktrees under `.worktrees/` are excluded from file watching and search by default (`files.watcherExclude`, `search.exclude`); they still show in the Explorer
- **Managed VMs** — lists only the local Linux VMs Moe launched and recorded for this project; other VMs are never listed or touched. Provider readiness, execution readiness and verification are separate lines. Refresh, reconcile and cleanup run one at a time. The strong profile (`verified-local`) always shows as unavailable, and the view never changes the execution profile or delivery policy

## Requirements

- Node.js 22.22+ on PATH (24 LTS recommended; the extension bundles the Moe daemon and MCP proxy and starts them for you)
- One coding CLI installed and signed in: Claude Code, Codex, Antigravity, Grok Build or GitHub Copilot CLI

## Getting started

1. Install the extension `yaront1111.moe-vscode` from the VS Code Marketplace or Open VSX.
2. Open your project. If it contains `.moe/`, the extension connects automatically; otherwise run **Moe: Connect to Daemon** to create it.
3. Open the **Moe** view in the activity bar: Task Board, Chat, Metrics, Managed VMs and Claude accounts. In Managed VMs, Reconcile needs a ready VM provider (Multipass at its installer's default location); Clean up owned also needs a launched VM row and asks for confirmation.
4. Create an epic and a task, drag the task to **Planning**, then run **Moe: Start Agent** (or **Moe: Start All Agents**).

## Extension settings

| Setting | Default | Description |
|---------|---------|-------------|
| `moe.daemon.host` | `127.0.0.1` | Daemon host address |
| `moe.daemon.port` | `0` | Daemon port (0 = auto-detect from `.moe/daemon.json`) |
| `moe.daemon.autoStart` | `true` | Start the daemon when needed |
| `moe.autoConnect` | `true` | Connect when the workspace contains `.moe`, and keep retrying (5 s, 10 s, 20 s, then every 30 s, up to 10 tries) while no daemon answers or after it restarts |
| `moe.chat.notifications.enabled` | `true` | Show notifications for agent chat messages |
| `moe.chat.notifications.mutedChannels` | `[]` | Channel IDs to mute |

## Commands

`Moe: Connect to Daemon`, `Moe: Disconnect from Daemon`, `Moe: Reconnect to Daemon`, `Moe: Refresh Board`, `Moe: Create Task`, `Moe: Create Epic`, `Moe: Open Task Detail`, `Moe: Open Epic Detail`, `Moe: Review Plan`, `Moe: Archive Done Tasks`, `Moe: Start Agent`, `Moe: Start All Agents`, `Moe: Open Settings`, `Moe: Show Daemon Status`, `Moe: Show Activity Log`, `Moe: Refresh Managed VMs`, `Moe: Reconcile Managed VMs`, `Moe: Clean Up Owned VMs`, `Moe: Refresh Claude Accounts`. The three Managed VMs commands are that view's title-bar buttons.

The Claude accounts view adds `Moe Accounts: Add...`, `Moe Accounts: Set Switch Percent...` and `Moe: Refresh Claude Accounts` as title-bar buttons, and `Moe Accounts: Sign in`, `Rename...`, `Move up`, `Move down` and `Remove...` on each account's context menu. The `Moe Accounts` commands are hidden from the Command Palette, and each one is offered only while the daemon allows it.

The extension does not define default keyboard shortcuts.

## Status columns

| Column | Task status |
|--------|-------------|
| **Backlog** | `BACKLOG` — waiting for a human to move it to Planning |
| **Planning** | `PLANNING` — an architect is writing the plan |
| **Approval** | `AWAITING_APPROVAL` — plan waiting for human approval |
| **Working** | `WORKING`, plus `BLOCKED` tasks shown with a badge |
| **Review** | `REVIEW` — QA is checking the result |
| **Done** | `DONE` — archive from the column header |

## Known issues

- Drag and drop may not work in remote workspaces
- The daemon must be reachable at `moe.daemon.host` (localhost by default)
- Clean up owned deletes nothing unless Node.js 22 or later runs the bundled `vm-control.mjs` (it needs the global WebSocket) and the project's daemon is bound to loopback only (127.0.0.1 or ::1, the default); otherwise, including a daemon started with `--host` such as JetBrains' WSL agent mode, it keeps every VM and reports that the daemon could not confirm the attempt is closed

## Release notes

### Unreleased

- Task status notifications, a Delivery section and Release Agent in task detail, matching JetBrains
- Claude accounts view with the rotation and its account actions
- Agent seats are deregistered when their terminal closes
- Settings: Agent Teams toggle and a read-only landing policy; the unused branch and commit pattern fields are removed
- Per-task worktrees are excluded from file watching and search; a deleted chat channel leaves the chat view
- The packaged extension ships only the bundled `dist/extension.js`
- The unused `moe.agentCommand` and `moe.chat.notifications.soundEnabled` settings are removed
- Reconnects on its own after a daemon restart, with backoff; actions taken while disconnected say so and keep their forms; an open Settings form follows changes made elsewhere; POSIX launch lines run in any default shell
- GitHub Copilot CLI supported as an agent CLI: the provider picker and the agent command setting offer it

### 0.8.0

- Headless Codex launch fixed for codex-cli 0.147 and later
- Grok Build (xAI) supported as an agent CLI
- Land on every exit: task-linked completion and checkpoint commits, with rescue refs when landing fails
- Task dependencies with automatic unblock; daemon-managed shared resources

Earlier versions: see [GitHub releases](https://github.com/yaront1111/Moe-s-Tavern/releases).

## Contributing

Contributions welcome! See [CONTRIBUTING.md](https://github.com/yaront1111/Moe-s-Tavern/blob/main/CONTRIBUTING.md).

## License

MIT - see [LICENSE](https://github.com/yaront1111/Moe-s-Tavern/blob/main/LICENSE).
