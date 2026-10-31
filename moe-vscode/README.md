# Moe's Tavern

An AI agent task board for VS Code and Antigravity: run Claude Code, Codex, Gemini CLI and Grok Build through a shared Kanban board with human plan approval.

JetBrains is the primary IDE for Moe's Tavern; this extension is the secondary interface to the same daemon and `.moe/` project state. Full documentation lives in the [repository](https://github.com/yaront1111/Moe-s-Tavern).

## Features

- **Kanban board** — epics and tasks across Backlog, Planning, Approval, Working, Review and Done; blocked tasks stay in Working with a BLOCKED badge
- **Plan approval** — review each implementation plan before code is written (CONTROL mode; SPEED and TURBO relax the gate)
- **Agent launcher** — start architect, worker, QA and governor agents with your chosen CLI
- **Chat and metrics** — agent chat channels with notifications, plus a metrics view
- **Drag & drop** — change task status by dragging between columns
- **Real-time updates** — live sync over WebSocket; the status bar shows the daemon connection
- **Managed VMs** — lists only the local Linux VMs Moe launched and recorded for this project; other VMs are never listed or touched. Provider readiness, execution readiness and verification are separate lines. Refresh, reconcile and cleanup run one at a time. The strong profile (`verified-local`) always shows as unavailable, and the view never changes the execution profile or delivery policy

## Requirements

- Node.js 18+ on PATH (the extension bundles the Moe daemon and MCP proxy and starts them for you)
- One coding CLI installed and signed in: Claude Code, Codex, Gemini CLI or Grok Build

## Getting started

1. Install the extension `yaront1111.moe-vscode` from the VS Code Marketplace or Open VSX.
2. Open your project. If it contains `.moe/`, the extension connects automatically; otherwise run **Moe: Connect to Daemon** to create it.
3. Open the **Moe** view in the activity bar: Task Board, Chat, Metrics and Managed VMs. In Managed VMs, Reconcile needs a ready VM provider (Multipass at its installer's default location); Clean up owned also needs a launched VM row and asks for confirmation.
4. Create an epic and a task, drag the task to **Planning**, then run **Moe: Start Agent** (or **Moe: Start All Agents**).

## Extension settings

| Setting | Default | Description |
|---------|---------|-------------|
| `moe.daemon.host` | `127.0.0.1` | Daemon host address |
| `moe.daemon.port` | `0` | Daemon port (0 = auto-detect from `.moe/daemon.json`) |
| `moe.daemon.autoStart` | `true` | Start the daemon when needed |
| `moe.autoConnect` | `true` | Connect when the workspace contains `.moe` |
| `moe.agentCommand` | `claude` | CLI used to launch agents: `claude`, `codex`, `gemini`, `grok`, or a custom CLI path |
| `moe.chat.notifications.enabled` | `true` | Show notifications for agent chat messages |
| `moe.chat.notifications.mutedChannels` | `[]` | Channel IDs to mute |
| `moe.chat.notifications.soundEnabled` | `true` | Play a sound for new chat messages |

## Commands

`Moe: Connect to Daemon`, `Moe: Disconnect from Daemon`, `Moe: Reconnect to Daemon`, `Moe: Refresh Board`, `Moe: Create Task`, `Moe: Create Epic`, `Moe: Open Task Detail`, `Moe: Open Epic Detail`, `Moe: Review Plan`, `Moe: Archive Done Tasks`, `Moe: Start Agent`, `Moe: Start All Agents`, `Moe: Open Settings`, `Moe: Show Daemon Status`, `Moe: Show Activity Log`, `Moe: Refresh Managed VMs`, `Moe: Reconcile Managed VMs`, `Moe: Clean Up Owned VMs`. The last three are the Managed VMs view's title-bar buttons.

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
