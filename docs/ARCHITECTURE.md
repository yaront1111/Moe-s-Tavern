# Moe - Technical Architecture (Current)

## System Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              DEVELOPER MACHINE                               │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                     JETBRAINS IDE (Plugin)                           │   │
│  │  ┌─────────────────────────────────────────────────────────────┐     │   │
│  │  │   Moe Tool Window (Swing)                                    │     │   │
│  │  │   - 5-column board                                           │     │   │
│  │  │   - drag/drop status                                         │     │   │
│  │  │   - task detail dialog (approve/reject/reopen)               │     │   │
│  │  └─────────────────────────────────────────────────────────────┘     │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                    │ WebSocket (/ws)                       │
│                                    ▼                                        │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                      SUPERVISOR (Auto-restart)                      │   │
│  │   Spawns daemon, restarts on crash (exponential backoff 1s-30s)     │   │
│  │   Max 5 restarts per 60s window. Signal forwarding.                 │   │
│  ├─────────────────────────────────────────────────────────────────────┤   │
│  │                         MOE DAEMON (Node.js)                        │   │
│  │                                                                     │   │
│  │   Interfaces:                     State:                            │   │
│  │   - WebSocket (/ws)               - StateManager (loads .moe/)       │   │
│  │   - WebSocket (/mcp)              - MentionRouter (chat @mentions)   │   │
│  │   - HTTP (/health)                - FileWatcher (watches .moe/)      │   │
│  │                                                                     │   │
│  │   Cross-session memory is delegated to the Serena MCP server.       │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                    │                                        │
│                                    ▼                                        │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                      .moe/ FOLDER (Source of Truth)                 │   │
│  │   project.json  epics/*.json  tasks/*.json  workers/*.json          │   │
│  │   channels/*.json  messages/*.jsonl  proposals/*.json  activity.log │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                    ▲                                        │
│                                    │ WebSocket (/mcp)                       │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                      moe-proxy (MCP stdio)                          │   │
│  │   MCP JSON-RPC over stdio ↔ WebSocket to daemon                      │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Component Architecture

### 1) JetBrains Plugin (Kotlin) — primary IDE

Swing tool window: epic-grouped 5-column board, task/epic/plan dialogs, chat / metrics / activity / worker / proposal panels, settings dialog, IDE notifications, and a terminal agent launcher (incl. WSL mode). Full class inventory: `docs/PLUGIN_SPEC.md`.

Key behaviors:
- Connects to daemon WebSocket at `/ws` (port from `.moe/daemon.json`).
- Auto-initializes `.moe` on first connect if missing; force-syncs bundled role docs/skills.
- Auto-starts the bundled daemon (or `MOE_DAEMON_COMMAND`/installer shims); kills it on close if it is the last project using that PID.
- UI is Swing-based; no JCEF/webview.

A VS Code / Antigravity extension (`moe-vscode/`) is a secondary client speaking the same `/ws` protocol.

### 2) Moe Daemon (Node.js/TypeScript)

```
packages/moe-daemon/
├── src/index.ts                # CLI entry + supervisor (start/stop/status/doctor/_run)
├── src/commands/               # doctor (offline health check)
├── src/server/
│   ├── McpAdapter.ts           # JSON-RPC handler for MCP
│   └── WebSocketServer.ts      # /ws and /mcp endpoints
├── src/state/
│   ├── StateManager.ts         # Loads/writes .moe, mutex-protected (+ extracted modules)
│   ├── FileWatcher.ts          # chokidar watch with debounce
│   └── backfills/              # idempotent start-time backfills (e.g. task metrics)
├── src/migrations/             # project.json schemaVersion migrations
├── src/tools/                  # MCP tools (registry: tools/index.ts getTools())
├── src/generated/              # prebuild output (initFiles/skillFiles)
├── src/util/                   # shared helpers
└── src/types/schema.ts         # Canonical types
```

Key behaviors:
- **Supervisor**: `start` spawns daemon as child process with auto-restart (exponential backoff, max 5 restarts/60s).
- **Port selection**: Picks an available port (default 9876, scans a range of 50) and writes `.moe/daemon.json`.
- **Cross-session memory**: Not handled by the daemon — delegated to the Serena MCP server (injected by the agent launchers). See `docs/MEMORY.md`.
- Watches `.moe` for changes and broadcasts state snapshots.
- Handles plugin actions (create/update/reorder/approve/reject/reopen).

### 3) Moe Proxy (Node.js/TypeScript)

```
packages/moe-proxy/
└── src/index.ts                # MCP stdio → WebSocket bridge
```

Key behaviors:
- Reads `.moe/daemon.json` to discover port.
- Forwards newline-delimited MCP JSON-RPC from stdin to daemon `/mcp`.

---

## Communication Protocols

### Plugin ↔ Daemon (WebSocket /ws)

Server → Plugin events:
- `STATE_SNAPSHOT`
- `TASK_CREATED` / `TASK_UPDATED` / `TASK_DELETED`
- `EPIC_CREATED` / `EPIC_UPDATED` / `EPIC_DELETED`
- `WORKER_CREATED` / `WORKER_UPDATED` / `WORKER_DELETED`
- `PROPOSAL_CREATED` / `PROPOSAL_UPDATED` / `PROPOSAL_DELETED`
- `METRICS`, `ACTIVITY_LOG`

Plugin → Server commands:
- `PING`, `GET_STATE`
- `CREATE_TASK` / `UPDATE_TASK` / `DELETE_TASK` / `REORDER_TASK`
- `CREATE_EPIC` / `UPDATE_EPIC` / `DELETE_EPIC`
- `APPROVE_TASK` / `REJECT_TASK` / `REOPEN_TASK`
- `APPROVE_PROPOSAL` / `REJECT_PROPOSAL`, `APPROVE_DECISION` / `REJECT_DECISION`
- `UPDATE_SETTINGS`

### CLI ↔ Proxy ↔ Daemon (MCP)

MCP JSON-RPC 2.0 over stdio (proxy) → WebSocket `/mcp` (daemon).
See `docs/MCP_SERVER.md` for tool definitions.

---

## File System Layout (.moe)

```
.moe/
├── project.json       # settings + rails (tracked)
├── daemon.json        # runtime port/pid (gitignored)
├── activity.log       # event log + rotations (gitignored)
├── epics/  tasks/  proposals/            # tracked task-state
├── workers/  teams/  messages/  memory/  # runtime (gitignored)
├── attempts/  candidates/  checks/       # delivery records (gitignored; see Delivery Path below)
├── reviews/  receipts/                   # delivery records (gitignored)
├── resources/         # shared-resource leases (gitignored)
├── channels/  decisions/
├── roles/             # role guides (sha-stamped, auto-upgraded)
├── agents/            # Claude Code subagent defs (mirrored to .claude/agents/)
└── skills/            # vendored skill pack
```

The daemon is the only writer; all clients send actions to the daemon.

---

## Delivery Path

Every task carries a plan revision, and a claim that assigns a named worker opens
an ExecutionAttempt (a resume adopts the worker's own). The other four records
exist only for a completion that runs `settings.qualityGate`. The gate is unset
by default, and the wrapper runs it only on a worker's completion landing in a
git repository, when the command is non-blank, `autoCommit` is on,
`qualityGateScope` is `everyTask` or the task is epic-final, and
`MOE_DISABLE_QUALITY_GATE` is not `1`. Two invariants hold the path together:

- **The daemon is state-only.** It never writes git state, lands, pushes or
  runs a gate. Its one git call is a read-only
  `git --no-optional-locks status --porcelain=v2 --branch` that fingerprints the
  working tree for handoff notes (`util/diskState.ts`, from `claim_next_task`
  and `release_task`). Every sha, exit code and landing it stores is what a
  runner *reported*, and each store checks shape and binding, never the
  repository.
- **The wrapper is the only git and process actor.** `scripts/moe-agent.{ps1,sh}`
  freezes the bytes, runs `settings.qualityGate`, moves the branch ref and
  reports each step through a `moe.*` tool.

| Record | Lives in | Written by | Exists for |
|---|---|---|---|
| Plan revision | `task.planRevision` in `tasks/<id>.json` | daemon, on every plan or DoD change (`taskStore.updateTask`) | every task |
| ExecutionAttempt | `attempts/<id>.json` | daemon: opened by `claim_next_task`, moved by `complete_task`, a restart, `reattach_attempt` and `finalize_attempt` | every claim that assigns a named worker |
| Candidate | `candidates/<id>.json` | wrapper, through `record_candidate`, before the gate runs | gated completions only |
| CheckRun | `checks/<id>.json` | wrapper, through `record_check_run`, for each gate command it started | gated completions only |
| Review | `reviews/<id>.json` | daemon, from `qa_approve` / `qa_reject`, bound to the task's current candidate | tasks with a candidate only |
| DeliveryReceipt | `receipts/<id>.json` | wrapper, through `record_delivery_receipt`, after it moved the target ref | gated landings only |

End to end:

1. `claim_next_task` opens attempt generation N (`running`); the generation is
   the fencing token the other attempt tools check.
2. `complete_task` moves the row to REVIEW, unassigned, and the attempt to
   `finalizing`. Until the attempt closes, the worker's next claim, an explicit
   `claim_next_task` of the task by any other seat, `qa_approve` and a move into
   DONE/ARCHIVED are refused with retryable `ATTEMPT_FINALIZING`. The ranked
   pool (the wrappers' only claim path) and `wait_for_task` skip the row
   instead of refusing it.
3. When a gate will run, after the CLI exits the wrapper records the attributed
   tree as a Candidate, runs the gate in a disposable clean checkout of it and
   records the CheckRun.
4. A passing gate lands the tree with a CAS `update-ref`, then the wrapper records
   the commit, the DeliveryReceipt and `finalize_attempt { outcome: 'landed' }`.
   A failing gate never moves the branch: the bytes go to
   `refs/moe/rescue/<taskId>/<utc-ts>`, the ledger says `MOE_COMMIT_FAILED_GATE`,
   and the attempt closes as `rescued`.
5. On a task with a candidate, QA's approval or rejection is recorded as a
   Review bound to the current candidate: naming any other candidate is refused
   `CANDIDATE_MISMATCH`, and naming none binds the current one with a
   `NO-REVIEWED-CANDIDATE` warning.
6. Under a strict `settings.deliveryPolicy`, `delivery/policy.ts` is the one rule
   both gates use: `qa_approve` refuses `DELIVERY_EVIDENCE_MISSING` until the
   landing evidence and the required check exist. A DONE prerequisite without
   its required check holds back its dependents: the ranked pool and
   `wait_for_task` skip a WORKING task that names it in `dependsOn`, only an
   explicit `claim_next_task` of that task is refused
   `DEPENDENCY_EVIDENCE_MISSING`, and a `blockedOnTaskIds` wait on it is not
   auto-unblocked. `dependsOn` never gates a PLANNING or REVIEW claim.

With no gate to run (the default), no Candidate, CheckRun, DeliveryReceipt or
Review is written. The wrapper lands the completion commit directly and reports
it through `record_commit`; that `task.commits` entry is the landing evidence.
`finalize_attempt` then closes the attempt with the landing's outcome
(`nothing-to-commit` when the session landed nothing, as with
`autoCommit: false` or a project outside git), and QA decides with no candidate
to bind.

Every store writes the record file (temp file + rename) before it publishes the
record in memory, so a crash can lose an unpublished write but never expose a
record that is not on disk. A crash between the ref move and the receipt is
replayed from `<gitdir>/moe/receipt/<taskId>.json` by the next pre-flight, which
records the missing receipt and never lands twice. A daemon restart parks a
still-assigned `running` attempt in `reconciling` and holds its row until the
runner reattaches or `reconcileWindowMs` passes. No idle signal releases a
WORKING or PLANNING seat. A REVIEW row is the exception: the REVIEW self-heal
releases one whose owner has been silent past `reviewStaleTimeoutMs` (default
30 min), and that release closes the owner's `running` or `reconciling` attempt.

The five record directories are local runtime state, gitignored like
`resources/` and never committed. The evidence that travels with the repository
is the git commit plus the tracked task fields `commits`, `lastCommitOutcome`,
`completionSummary` and `reviewSummary`. Each record only makes sense in the
clone that wrote it:

- `attempts/`: live fencing and process identity (`generation`, `phase`,
  `host`, `processStartedAt`) for this daemon; stale on any other clone.
- `candidates/`: a runner-reported `treeSha` bound to a local attempt; the
  frozen bytes themselves live in git.
- `checks/`: gate output from a disposable local checkout; the verdict reaches
  the tracked task as the landed commit or the `MOE_COMMIT_FAILED_GATE` entry.
- `reviews/`: an append-only `candidateId` binding for this daemon;
  `qa_approve` already persists `reviewSummary` on the tracked task.
- `receipts/`: crash recovery for this clone's ref move, paired with
  `<gitdir>/moe/receipt/<taskId>.json`, which never leaves the clone; the
  landing itself travels as the commit.

Record shapes: `docs/SCHEMA.md`. Tool contracts: `docs/MCP_SERVER.md`. Settings
and the wrapper side (gate, rescue refs, receipts): `docs/CONFIGURATION.md`.

---

## Data Flow Examples

### Task Status Change (Plugin Drag/Drop)

1. User drags a task card between columns.
2. Plugin sends `UPDATE_TASK` with new `status` and `order`.
3. Daemon writes task file and appends activity log.
4. Daemon broadcasts `TASK_UPDATED`.
5. Plugin updates UI state.

### Plan Approval (Plugin)

1. AI submits plan via MCP tool `moe.submit_plan` (status → AWAITING_APPROVAL).
2. Plugin opens task detail dialog.
3. User clicks Approve.
4. Plugin sends `APPROVE_TASK`.
5. Daemon updates task status → WORKING and broadcasts.

---

## Error Handling (Current)

- Missing `.moe` → plugin initializes or daemon throws on start.
- Invalid JSON files → daemon ignores invalid entities during load.
- WebSocket disconnects → plugin shows status in header.

---

## Performance Notes

- File watcher debounces writes (chokidar awaitWriteFinish).
- State snapshots are full state; diffs are per-event only for updates.
