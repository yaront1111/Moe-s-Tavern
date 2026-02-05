# Moe - AI Workforce Command Center

Visual task board for AI agent orchestration with human oversight.

## Features

- **Kanban Board** - View and manage tasks across status columns
- **Drag & Drop** - Change task status by dragging between columns
- **Task Actions** - Approve, reject, or reopen tasks
- **Real-time Updates** - Live sync via WebSocket connection
- **Connection Status** - Status bar indicator for daemon connection

## Requirements

- [Moe daemon](https://github.com/yaront1111/Moe-s-Tavern) running on your project
- Project with `.moe/` folder initialized

## Getting Started

1. Install the extension from VS Code Marketplace
2. Open a project with `.moe/` folder
3. The extension auto-connects to the daemon
4. View the task board in the Moe sidebar

## Extension Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `moe.daemon.host` | `127.0.0.1` | Daemon host address |
| `moe.daemon.port` | `0` | Daemon port (0 = auto-detect) |
| `moe.autoConnect` | `true` | Auto-connect when workspace has .moe |

## Commands

- `Moe: Connect to Daemon` - Connect to the Moe daemon
- `Moe: Disconnect from Daemon` - Disconnect from daemon
- `Moe: Refresh Board` - Refresh the task board

## Status Columns

| Column | Description |
|--------|-------------|
| **Backlog** | Tasks waiting to be planned |
| **Planning** | Tasks being planned by architect agent |
| **Approval** | Plans awaiting human approval |
| **Working** | Tasks being implemented by worker agent |
| **Review** | Tasks awaiting QA review |
| **Done** | Completed tasks |

## Keyboard Shortcuts

The extension does not define default keyboard shortcuts. You can add your own in VS Code's Keyboard Shortcuts settings.

## Known Issues

- Drag and drop may not work in remote workspaces
- WebSocket connection requires daemon running on localhost

## Release Notes

### 0.1.0

Initial release:
- Kanban board with 6 status columns
- Drag-and-drop task status changes
- Task detail view with approve/reject/reopen
- Status bar connection indicator
- Auto-connect on workspace open

## Contributing

Contributions welcome! See [CONTRIBUTING.md](https://github.com/yaront1111/Moe-s-Tavern/blob/main/CONTRIBUTING.md).

## License

MIT - see [LICENSE](https://github.com/yaront1111/Moe-s-Tavern/blob/main/LICENSE).
