# Moe - JetBrains Plugin (Current)

## Overview

The current plugin is a Swing-based tool window that shows a 6-column task board and connects to the Moe daemon via WebSocket.

This document describes what is implemented now and what is planned next.

---

## Current Feature Set (MVP)

- Tool window titled "Moe" (right side)
- Board with columns: Backlog, Planning, Awaiting Approval, Working, Review, Done
- Drag/drop tasks between columns (updates status + order)
- Task detail dialog (double-click card)
  - Approve/Reject when status is AWAITING_APPROVAL
  - Reopen when status is REVIEW or DONE
- Auto-initialize `.moe/` if missing
- Auto-start daemon when a project opens (bundled daemon or installed command)

---

## Current Project Structure

```
moe-jetbrains/
├── src/main/kotlin/com/moe/
│   ├── actions/
│   │   └── InitMoeAction.kt
│   ├── listeners/
│   │   └── MoeProjectOpenListener.kt
│   ├── model/
│   │   └── Models.kt
│   ├── services/
│   │   └── MoeProjectService.kt
│   ├── toolwindow/
│   │   ├── MoeToolWindowFactory.kt
│   │   ├── MoeToolWindowPanel.kt
│   │   ├── TaskDetailDialog.kt
│   │   └── board/
│   │       ├── TaskCard.kt
│   │       └── TaskColumn.kt
│   └── util/
│       ├── MoeJson.kt
│       └── MoeProjectInitializer.kt
│
└── src/main/resources/META-INF/plugin.xml
```

---

## Runtime Behavior

- Reads daemon port from `.moe/daemon.json`.
- Connects to `ws://127.0.0.1:<port>/ws`.
- Sends `UPDATE_TASK`, `APPROVE_TASK`, `REJECT_TASK`, `REOPEN_TASK` based on UI actions.
- Receives `STATE_SNAPSHOT`, `TASK_UPDATED`, `TASK_CREATED`, `EPIC_UPDATED`, `EPIC_CREATED`.

---

## Settings / Environment

- The plugin prefers a bundled daemon (`daemon/index.js`) if present.
- `MOE_DAEMON_COMMAND` can override how the plugin starts the daemon.
- On Windows, the plugin also checks for installer shims under `Program Files\Moe\moe-daemon`.

---

## Roadmap (Not Yet Implemented)

- Epic CRUD UI
- Task creation UI
- Worker status UI
- Notifications and status bar widget
- Settings panel
- Keyboard shortcuts

See `docs/UI_SPEC.md` for the intended UX direction.
