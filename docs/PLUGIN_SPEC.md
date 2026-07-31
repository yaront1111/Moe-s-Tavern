# Moe - JetBrains Plugin (Current)

## Overview

The plugin is a Swing-based tool window showing a 5-column task board (AWAITING_APPROVAL tasks display in the Planning column) connected to the Moe daemon over `ws://127.0.0.1:<port>/ws`. It bundles the daemon, proxy, launcher scripts, role docs, and skills; it auto-spawns the daemon on project open and kills it on close if it is the last project using that PID.

JetBrains is the **primary** IDE surface — implement and test here first; the VS Code extension lags behind.

---

## Current Feature Set

**Board**
- Five columns: Backlog, Planning (+ Awaiting Approval overlay), Working, Review, Done
- Epic grouping (`EpicColumn`/`EpicCard`) with an "All Epics" filter; drag/drop updates status + order
- Task cards with status dots; double-click opens the task detail dialog

**Dialogs**
- `TaskDetailDialog` — approve/reject (AWAITING_APPROVAL), reopen (REVIEW/DONE), comments, DoD
- `PlanReviewDialog` — step-by-step plan approval
- `CreateTaskDialog`, `CreateEpicDialog`, `EpicDetailDialog`
- `MoeSettingsDialog` — project settings (approval mode, models, gates)

**Panels (tool window tabs)**
- `ChatPanel` — agent chat channels
- `MetricsPanel` — task/fleet metrics
- `ActivityLogPanel` — activity log tail
- `WorkerPanel` — registered workers + status
- `ProposalPanel` — rail proposals (approve/reject)

**Agents & lifecycle**
- `TerminalAgentLauncher` — Agents menu: launch architect/worker/qa/governor in the IDE terminal, including the "Run Agents in WSL" toggle
- `MoeProjectService` — WS client, daemon spawn/supervision, reconnect
- `MoeProjectRegistry` — multi-project daemon tracking (kills the daemon only when the last project using that PID closes)
- `MoeNotificationService` — IDE notifications ("Moe Notifications" group)
- Auto-initialize `.moe/` when missing; force-sync bundled role docs/skills on connect
- Actions: `InitMoeAction`, `OpenBoardAction`, `CreateTaskAction`, `ApproveTaskAction`, `RejectTaskAction`, `StartAgentAction`

---

## Current Project Structure

```
moe-jetbrains/src/main/kotlin/com/moe/
├── actions/        InitMoe, OpenBoard, CreateTask, ApproveTask, RejectTask, StartAgent
├── listeners/      MoeProjectOpenListener
├── model/          Models.kt
├── services/       MoeProjectService, MoeNotificationService
├── toolwindow/     MoeToolWindowFactory, MoeToolWindowPanel, TaskDetailDialog,
│                   PlanReviewDialog, CreateTaskDialog, CreateEpicDialog,
│                   EpicDetailDialog, MoeSettingsDialog, ChatPanel, MetricsPanel,
│                   ActivityLogPanel, WorkerPanel, ProposalPanel
│   └── board/      TaskCard, TaskColumn, EpicCard, EpicColumn, BoardStyles,
│                   StatusDot, RoundedPanel, WrapLayout
└── util/           MoeJson, MoeProjectInitializer, MoeProjectRegistry,
                    TerminalAgentLauncher, MoeBundle, MoeDuration
```

Bundled resources: daemon `dist/` + `node_modules/`, proxy, `scripts/`, role docs, skills (build hard-fails if daemon/proxy aren't built first).

---

## Runtime Behavior

- Reads daemon port from `.moe/daemon.json`; deletes it when stale.
- UI → daemon messages include: `UPDATE_TASK`, `APPROVE_TASK`, `REJECT_TASK`, `REOPEN_TASK`, `CREATE_TASK`, `DELETE_TASK`, `CREATE_EPIC`, `UPDATE_EPIC`, `DELETE_EPIC`, `UPDATE_SETTINGS`, `APPROVE_PROPOSAL`, `REJECT_PROPOSAL`, `APPROVE_DECISION`, `REJECT_DECISION`.
- Daemon → UI messages include: `STATE_SNAPSHOT`, `TASK_CREATED/UPDATED/DELETED`, `EPIC_CREATED/UPDATED/DELETED`, `WORKER_CREATED/UPDATED/DELETED`, `PROPOSAL_CREATED/UPDATED/DELETED`, `METRICS`, `ACTIVITY_LOG`.
- Board updates are applied incrementally per column.

---

## Settings / Environment

- Prefers the bundled daemon (`daemon/index.js`); `MOE_DAEMON_COMMAND` / `MOE_NODE_COMMAND` override resolution.
- On Windows, also checks installer shims under `Program Files\Moe\moe-daemon`.
- WSL agent mode: the Agents menu toggle spawns the daemon with `--host 0.0.0.0` and launches agents via `moe-agent.sh` with `/mnt/` paths.

---

See `docs/UI_SPEC.md` for the target UX direction beyond what is implemented.
