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
- Auto-initializes `.moe` on first connect if missing. On an existing `.moe` it only creates missing role docs/skills, and it upgrades stale marked copies only right before it starts the daemon itself (the daemon also rewrites them at every start), so a live daemon's newer docs are never downgraded.
- Auto-starts the bundled daemon (or `MOE_DAEMON_COMMAND`/installer shims); kills its process tree on close if it is the last project using that PID.
- UI is Swing-based; no JCEF/webview.

A VS Code / Antigravity extension (`moe-vscode/`) is a secondary client speaking the same `/ws` protocol.

### 2) Moe Daemon (Node.js/TypeScript)

```
packages/moe-daemon/
├── src/index.ts                # CLI entry + supervisor (start/stop/status/doctor/accounts/_run)
├── src/commands/               # doctor (offline health check)
├── src/accounts/               # Claude account list, usage-window math, `accounts` CLI (sign-in runs here, never in the daemon)
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
- **Claude account rotation** (`state/accountStore.ts`):
  - The machine has one account list, `~/.moe/claude-accounts.json`, which every project's daemon shares. The wrapper calls `moe.lease_account` before each claude launch and runs claude with the returned `CLAUDE_CONFIG_DIR`.
  - The wrapper forwards claude's own rate-limit figures through `moe.report_account_usage`. Once a live window reaches the switch percent (90% by default), new launches go to the next signed-in account, and a running worker moves at its next step boundary (`complete_step` `accountSwitch`, `start_step` refusal).
  - The daemon never runs claude and never opens a file inside a Claude config folder. The IDE signs accounts in by running the `accounts` CLI in a terminal. A 2-second watch rebroadcasts `ACCOUNTS_UPDATED` when the list, another daemon's usage writes or the clock change the view.
  - Contracts: `docs/MCP_SERVER.md`, **Claude Account Rotation**.

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
- `PING`, `GET_STATE` (optionally `{ ifBoardVersion }`: every `STATE_SNAPSHOT` frame carries a top-level `boardVersion`; a poll that sends it back gets the payload without `tasks`/`epics` while the board is unchanged)
- `CREATE_TASK` / `UPDATE_TASK` / `DELETE_TASK` / `REORDER_TASK`
- `CREATE_EPIC` / `UPDATE_EPIC` / `DELETE_EPIC`
- `APPROVE_TASK` / `REJECT_TASK` / `REOPEN_TASK`
- `APPROVE_PROPOSAL` / `REJECT_PROPOSAL`, `APPROVE_DECISION` / `REJECT_DECISION`
- `UPDATE_SETTINGS`

Rail proposals transition only from `PENDING`. Repeating the same approval or rejection
returns the unchanged `PROPOSAL_UPDATED` acknowledgment without new persistence,
activity entries or state events. The opposite decision on a resolved proposal returns
`ERROR` with code `-32003`, codeName `NOT_ALLOWED` and the stable message
`[NOT_ALLOWED] resolve proposal not allowed: proposal already resolved`, leaving
the rails and proposal record untouched. These rules concern rail proposals, not chat decisions.

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
├── pins/              # chat pins, one <channelId>.json each (gitignored: they reference message ids that live only in the gitignored messages/)
├── channels/  decisions/
├── roles/             # role guides (sha-stamped, auto-upgraded)
├── agents/            # Claude Code subagent defs (mirrored to .claude/agents/)
└── skills/            # vendored skill pack
```

The daemon is the only writer; all clients send actions to the daemon.

---

## Delivery Path

Every task carries a plan revision, and a claim that assigns a named worker opens
an ExecutionAttempt (a resume adopts the worker's own). The other records
exist only for a completion that runs `settings.qualityGate`, or for a check a
trusted runner dispatches (see **The verified-local path** below). The gate is unset
by default, and the wrapper runs it only on a worker's completion landing in a
git repository, when the command is non-blank, `autoCommit` is on,
`qualityGateScope` is `everyTask` or the task is epic-final, and
`MOE_DISABLE_QUALITY_GATE` is not `1` (shared mode; see **Worktree mode** below). Two invariants hold the path together:

- **The daemon is state-only.** It never writes git state, lands, pushes or
  runs a gate. Its Git calls are read-only:
  `git --no-optional-locks status --porcelain=v2 --branch` that fingerprints the
  working tree for handoff notes (`util/diskState.ts`, from `claim_next_task`
  and `release_task`), plus `submit_plan` existence checks against a pinned
  cached `refs/remotes/origin/<consolidationBranch>` (`util/cachedPlanPaths.ts`).
  The latter runs outside the state mutex, never fetches or changes the tree,
  rejects partial clones/redirected roots, and reports stale-worktree provenance
  without claiming remote freshness. Only an explicit literal branch is used;
  missing Git/ref/object evidence retains the missing-path refusal, which names
  the failed check (the Git step, its error and the elapsed time). Cached
  paths use the exact committed spelling (Git tree lookup is case-sensitive).
  Full plan validation is repeated under the mutex before writing. Every delivery sha,
  exit code and landing it stores is what a runner *reported*, and each store checks shape and binding, never the
  repository.
- **The wrapper is the Git-write and landing-process actor.** `scripts/moe-agent.{ps1,sh}`
  freezes the bytes, runs `settings.qualityGate`, moves the branch ref and
  reports each step through a `moe.*` tool.

| Record | Lives in | Written by | Exists for |
|---|---|---|---|
| Plan revision | `task.planRevision` in `tasks/<id>.json` | daemon, on every plan or DoD change (`taskStore.updateTask`) | every task |
| ExecutionAttempt | `attempts/<id>.json` | daemon: opened by `claim_next_task`, moved by `complete_task`, a restart, `reattach_attempt` and `finalize_attempt` | every claim that assigns a named worker |
| Candidate | `candidates/<id>.json` | wrapper, through `record_candidate`, before the gate runs | gated completions only |
| CheckRun | `checks/<id>.json` | wrapper, through `record_check_run`, for each gate command it started; or the daemon, from a trusted runner's `record_check_observation` | gated completions, and dispatched checks |
| CheckDispatch | `checks/dispatches/<id>.json` | trusted runner, through `record_check_dispatch` over `/runner`, before it runs a check | dispatched checks only (no runner dispatches yet) |
| CheckObservation | `checks/observations/<dispatchId>.json` | daemon, from `record_check_observation` over `/runner`: the marker naming the dispatch's one CheckRun | dispatched checks only |
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
   records the CheckRun with its outcome: `passed` only at exit 0 with the
   checkout intact, `code-failure` at a nonzero exit, `inconclusive` when that
   integrity check fails or throws, and `infra-failure` for a gate interrupted
   at teardown.
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
   auto-unblocked. `dependsOn` never gates a PLANNING or REVIEW claim. That is
   the rule for a legacy or observe consumer; a verified-local consumer needs
   more (see **The verified-local path** below).

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
  Its `dispatches/` and `observations/` hold a trusted runner's records, bound
  to this daemon's candidates and runner key.
- `reviews/`: an append-only `candidateId` binding for this daemon;
  `qa_approve` already persists `reviewSummary` on the tracked task.
- `receipts/`: crash recovery for this clone's ref move, paired with
  `<gitdir>/moe/receipt/<taskId>.json`, which never leaves the clone; the
  landing itself travels as the commit.

A task's records live as long as the task: an archived task keeps them all, and
`moe.delete_task` drops the deleted task's candidates, check runs, receipts and
reviews (its closed attempts, and the runner's `dispatches/` and
`observations/`, stay). A record file that will not unlink is skipped by every
reload, which retries the unlink, so the record never comes back. The daemon
reads the directories in full at start; a reload (any watched-file change)
reads only a record file that is new or whose size or mtime changed since it
was read. Per-task and per-candidate lookups go through an index
(`state/recordIndex.ts`) that is rebuilt only after a write, so a board
snapshot no longer scans every store once per task.

### Worktree mode

An unset `settings.worktreeMode` resolves (`resolveWorktreeMode`) to `'on'` when
`qualityGate` is non-blank after trim, else `'off'`, so the default never lands
a gate-less project ungated. While it resolves to `'on'`, `claim_next_task` pins
`workspaceMode: 'worktree'` on the attempt a WORKING claim opens (every other
claim pins `'shared'`), and both
`claim_next_task` and `get_context` expose that attempt's
`workspace: { mode, path, branch, target }` (`resolveAttemptWorkspace`). The
target is a literal `settings.consolidationBranch`, else `main`, and
`complete_task` on a worktree attempt expects branch `moe/task/<taskId>`.

A worker's bytes live in its task worktree `.worktrees/<taskId>` on
`moe/task/<taskId>`, a sparse checkout with no `.moe/`, and its checkpoints land
on that branch only. End-to-end steps 3 and 4 change: a completion lands the
task's net change on the target as ONE squash commit. The wrapper builds the
`git merge-tree` of the target tip and the task branch; while a `qualityGate`
is set, EVERY completion gates exactly that merged tree (`qualityGateScope` is
ignored, and `MOE_DISABLE_QUALITY_GATE=1` fails the landing instead of skipping
it) in a `.moe`-free gate worktree, recording its Candidate and CheckRun as
above. It then writes the receipt journal `<gitdir>/moe/receipt/<taskId>.json`
on every completion before anything is published (a gate-less one has no
Candidate). With no remote, a CAS `update-ref` publishes; in remote mode a
non-forced push to origin is the only publication and the local target is a
mirror. A legacy or observe landing sends no DeliveryReceipt: the
`task.commits` row and the `landed` finalize are the landing evidence. A
strong (verified-local) landing also sends one (**Strong local delivery**
below). A push whose outcome is unknown records no
row and sends no finalize, so the attempt stays `finalizing`, its journal kept,
until a later pre-flight fetches and settles it.

A landing that publishes nothing (a conflict or a marker left in the worktree,
a failed gate, a diverged target or failed fetch, a refused push, an ungranted
land lease, exhausted rounds) puts the task-branch tip on a rescue ref, records
a failed row and closes the attempt `unlanded`; when that rescue ref or row
cannot be written it finalizes nothing and the attempt stays `finalizing`. The
daemon sets `Task.landingRetry` and routes the row from REVIEW back to WORKING,
unassigned, or to BLOCKED for `diverged` or a 3rd consecutive unlanded
landing. The next worker resolves it in its worktree, and the next `landed` or
`nothing-to-commit` finalize clears `landingRetry`. Any other failure (the
target checked out in a worktree, a merged tree that changes `.moe/`) also
publishes nothing: a plain failed row, the attempt closed `failed` (`rescued`
when the bytes went on a rescue ref), the bytes kept on the task branch.

No worktree landing carries `.moe/`: board history goes to `refs/moe/board`,
and the tracked `.moe/tasks` records on the target stay frozen from the switch
on. The control checkout sits on `moe/control` and only fast-forwards to the
target, and QA reviews only commits landed there.

Worktree mode adds daemon state (`workspaceMode`, `workspace`, `landingRetry`
and the `unlanded` outcome) but no daemon git write: provisioning, landing,
rescue refs, board snapshots and the control follow are all the wrapper's.
Shared mode is unchanged. Operator detail: **Land on every exit, worktree
mode** in `scripts/CLAUDE.md` and **Worktree Mode** in
`docs/TROUBLESHOOTING.md`.

### The verified-local path

`verified-local` is refused until the daemon's own readiness evaluation passes:
`assertExecutionProfileReady` (`delivery/executionProfile.ts`) refuses it with
`EXECUTION_PROFILE_NOT_READY` while the held snapshot
(`delivery/readinessHolder.ts`, evaluated at start and every five minutes) is
not ready, and nothing below grants readiness. The capabilities and evidence
ids are in the `executionProfile` row of `docs/CONFIGURATION.md`; the operator
flow is **Activation** in `docs/CERTIFICATION.md`. Legacy and observe tasks
keep the path above unchanged. The pieces below exist so that a strong task
reaches DONE only on evidence its writer cannot mint.

- **Runner channel** (`server/runnerChannel.ts`). `/runner` accepts only a
  loopback connection that presents exactly one `x-moe-runner-key` header equal
  to the project's host key. The key lives at `<MOE_RUNNER_KEY_DIR, else
  ~/.moe/runner-keys>/<first 32 hex of sha256(projectPath)>.key`: 0600 in a 0700
  directory, outside the project tree, provisioned at daemon start (a failure
  leaves `/runner` refusing every connection) and re-read on every upgrade, so a
  rotation takes effect. The `runnerId` is derived from the key; no tool
  argument carries it. Limit: under legacy and observe a host agent runs as the
  same user and can read the key, so no trust is claimed there. Only
  verified-local, whose agents run in guest VMs behind the guest bridge
  (`scripts/local-runner/guest-bridge.mjs` forwards no check, dispatch,
  observation or receipt tool), may treat the channel as trusted.
- **Dispatch, observation, authentication** (`state/checkObservationStore.ts`).
  Before it runs a check, the runner records a CheckDispatch with
  `moe.record_check_dispatch`, and the daemon pins the task's current candidate,
  that candidate's tree and the current approved plan revision. For a
  verified-local task it admits only a check the task owes (`owedChecks`: the
  approved definitions plus the owed gate; else `CHECK_DEFINITION_NOT_APPROVED`)
  in an environment `settings.checkEnvironments` lists (else
  `CHECK_ENVIRONMENT_NOT_APPROVED`). The result arrives as
  `moe.record_check_observation`: the daemon writes the CheckRun from the
  dispatch's binding (candidate, tree, command, revision, environment, runner)
  plus the reported exit code, outcome and tail, and a marker naming it as the
  dispatch's one answer. `isAuthenticatedCheckRun` accepts only such a stored
  run; a `moe.record_check_run` report has no marker and stays diagnostic. Both
  tools refuse `/mcp` with `RUNNER_CHANNEL_REQUIRED` and are hidden from agent
  roles. The host's runner client is `scripts/local-runner/check-dispatch.mjs`
  (see **Local Runner Isolation**). Under the strong profile a worktree
  completion's gate step (L6) runs it on the frozen merged candidate (`commit-tree
  M -p B`) instead of the `qualityGate`, so the host never runs the gate for that
  task (`run_check_dispatch` in `moe-agent.sh`, `Invoke-MoeCheckDispatch` in
  `moe-agent.ps1`). Only `PASS` lands. Any stop fails the landing as
  `MOE_COMMIT_FAILED_GATE` after `[WARN] MOE_CHECK_DISPATCH_REFUSED: <code>`.
  Legacy and observe completions still run the host gate.
- **One pass rule** (`delivery/policy.ts`). `passedOn` (legacy and observe) and
  `trustedPassedOn` (verified-local) are the only pass matches, chosen in the
  same two places (the owed gate and the protected definitions). `qa_approve`,
  the dependency gates and the delivery projection all read them through
  `evaluateDeliveryEvidence`. For a verified-local task a required check counts
  only as an authenticated run on the current candidate's tree, with outcome
  `passed` at exit 0, at the current approved plan revision, in an environment
  still listed, bound to a dispatch naming that check. That holds under every
  `deliveryPolicy`, `legacy` included. A strong task that owes no check reports
  `required-checks-undeclared`. An architecture check that is not in the
  installed form `moe-daemon check-architecture …` reports
  `required-check-untrusted-checker:<id>`, or `(qualityGate)` in place of the
  id for the gate. Protection covers only the entries the approver names: a
  protected wrapper that runs unprotected candidate code (a dist built from
  candidate sources, an unprotected helper or package script) is outside it.
- **Bounded repair** (`delivery/repairPolicy.ts`, `delivery/repairActivation.ts`).
  Each authenticated observation of a verified-local task is judged by
  `decideRepair` under `settings.repairPolicy` and acted on once, never on a
  duplicate, through existing transitions only. A code failure returns an
  unparked REVIEW task to WORKING under the same approved revision. An
  infrastructure failure or timeout goes back to the runner to re-dispatch. An
  exhausted budget or an unchanged failure escalates (a task comment and a
  `#governors` alert), and an unapproved plan revision routes the task to
  PLANNING.
- **Revision- and candidate-bound QA** (`delivery/reviewBinding.ts`). Under
  verified-local, `qa_approve` and `qa_reject` need the reviewer's own running
  attempt, generation and served-context session (the fence `complete_task`
  uses) and the current candidate named explicitly. An approval also needs that
  candidate produced under the current approved revision; a rejection never
  delivers, so a stale-revision candidate can still be rejected. moe-proxy
  stamps the identity onto both tools.
- **Dependency readiness** (`state/dependencyUnblock.ts`). One predicate
  (`dependencyShortfall`, `isDependencySatisfied`, `unmetDependsOn`) takes the
  consumer. A legacy or observe consumer keeps the rule above, where a missing
  or ARCHIVED prerequisite satisfies. A verified-local consumer needs retained
  verified delivery: the prerequisite must exist (`prerequisite-missing`; drop a
  deleted id with `set_task_dependencies`), carry a verified-local snapshot
  (`verified-local-snapshot`), hold an approved review of its current candidate
  (`approved-review`), keep its delivery receipt when ARCHIVED
  (`delivery-receipt`) and satisfy its own evidence. The claim gate,
  `wait_for_task`, the auto-unblock, the stale-block alert, `report_blocked` and
  every `dependsOnUnmet` (`get_context`, `list_tasks`, `search_tasks`,
  `set_task_dependencies`) read it.
- **Strong local delivery** (the wrappers). A wrapper pins the attempt's profile
  and plan revision from its verified attempt record, never from the
  environment. Under verified-local the receipt journal
  `<gitdir>/moe/receipt/<taskId>.json` becomes the landing's durable intent
  (tree, base, plan revision, profile), fsynced and renamed into place before
  `update-ref`, or the landing is refused (`MOE_COMMIT_REFUSED_INTENT_INCOMPLETE`,
  `MOE_COMMIT_REFUSED_INTENT_UNWRITABLE`). An unreconciled journal refuses the
  task's next completion (`MOE_COMMIT_REFUSED_UNRECONCILED_INTENT`). The attempt
  stays `finalizing` until the receipt is recorded
  (`MOE_FINALIZE_DEFERRED_RECEIPT`), which holds `qa_approve` and every claim of
  the task, so nothing reaches DONE and no dependent is released first. A copy
  of the landing on another tree (a rebase) is never adopted as its proof
  (`MOE_DELIVERY_PROOF_NOT_TRANSFERRED`; `MOE_PUSH_REBASE` is ignored). Every
  checkpoint landing, recoveries included, is refused
  (`MOE_COMMIT_REFUSED_STRONG_CHECKPOINT`), so only a verified completion moves
  the target. In worktree mode the strong journal also carries the frozen
  candidate, its tree M, its base B, the plan revision and the profile; once the
  squash commit is published the wrapper sends the completion row, then
  `moe.record_delivery_receipt` from that journal (only after the row is
  acknowledged), then `finalize_attempt` (`wt_land_published`,
  `Complete-MoeWorktreeLanding`). The receipt is candidate-bound and never
  rewritten: an identical replay answers `duplicate: true`, and a contradicting
  one is refused `DELIVERY_RECEIPT_CONFLICT`, which the wrapper warns about once
  and does not retry. The pre-flight replay settles a crash between the ref move,
  the receipt and `finalize_attempt`, in both modes, and drops a strong journal
  only once its attempt is closed. Codes: `scripts/CLAUDE.md`, **Land on every
  exit**.
- **Architecture rules** (`commands/checkArchitecture.ts` over
  `delivery/architectureRules.ts`). `moe-daemon check-architecture --rules
  <repo path> [--base <rev>] [--tree <rev>]`, run from the repository root,
  judges the committed `--tree` (default `HEAD`) against `--base` (default its
  first parent) through bounded read-only Git and committed bytes only. It
  prints one JSON report and exits 0 passed, 1 failed, 2 inconclusive or
  unavailable. It is meant to run as a protected required check. Before
  verified-local can rely on it, the check guest must resolve `moe-daemon` only
  to a trusted install built at the base revision, the `--rules` file needs
  protection, and a multi-commit candidate must be materialized as one commit
  on its `baseRevision`, because a dispatch cannot add a per-candidate `--base`.
- **Acceptance fixtures** (`packages/moe-daemon/src/__acceptance__/`). These
  suites reach tools only through `McpAdapter` (`mcpCall.ts`), as an agent
  does: producer-consumer behaviour, the delivery bypass fixtures (forged,
  stale, missing-check, target-race and receipt-crash) and dependency
  projection agreement. A strict task whose required check is the daemon suite
  should list that directory among its `executionContract.requiredChecks`
  `assertionRoots`, so a candidate cannot weaken the fixtures unnoticed.

Record shapes: `docs/SCHEMA.md`. Tool contracts: `docs/MCP_SERVER.md`. Settings
and the wrapper side (gate, rescue refs, receipts): `docs/CONFIGURATION.md`.

---

## Local Runner Isolation

`scripts/local-runner/` runs agent and check jobs in Moe-owned local Multipass VMs (Ubuntu 24.04). Each module's header
comment is the reference; this is the map. Under `verified-local`, which the daemon admits only while its own readiness
evaluation passes (**The verified-local path** above), worker and QA seats run their jobs in seat VMs (**Seat VM
route** below) and a worktree completion's owed checks run in check VMs (**Check lifecycle**). Legacy and observe seats
never use these modules. Every result still carries `executionReady: false`: no module claims isolation for itself, and
only the daemon's evaluation of a certified report counts.

- **Protected control plane.** Under the protected profile the JetBrains plugin (`util/RuntimeSelectionPolicy.kt`)
  runs only the daemon, proxy and wrapper installed with the plugin and an absolute node outside the project, never the
  project's copies or a PATH lookup, and sets `MOE_RUNTIME_PROTECTED=1`: `moe-agent.{sh,ps1}` and `moe-call.sh` then
  run exactly `MOE_DAEMON_PATH` and `MOE_PROXY_PATH` or refuse. They also start only `claude`, `codex`, `gemini` or
  `grok`, by name, and take that CLI and node (sh also python3) only from an absolute PATH entry outside the project
  (`MOE_PROTECTED_AGENT_COMMAND_REFUSED`, `MOE_PROTECTED_AGENT_CLI_NOT_FOUND`, `MOE_PROTECTED_INTERPRETER_NOT_FOUND`).
  Both export `NoDefaultCurrentDirectoryInExePath=1`, so on Windows cmd.exe (an npm `.cmd` CLI shim, or any cmd.exe
  in the seat) and Node 22+ (libuv 1.48+, which reads the variable from the spawning process) never look a bare name up
  in the current directory, the project. Older Node still does, and no lookup skips a `.`, relative or in-project PATH
  entry. So the agent Git guard's Node program gets git's absolute path, from an absolute PATH entry outside the
  project, and runs `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`; with no such git the guard refuses
  the launch (`MOE_AGENT_GIT_GUARD_FAILED`). The remaining residual is the agent CLI's own bare-name spawns: they
  inherit the variable, but Moe controls neither the CLI's PATH walk nor a CLI runtime that ignores it. Under the marker,
  `moe-agent.sh` and `moe-call.sh` rewrite PATH, before their first bare-name command, to absolute entries outside the
  project. A rewrite that keeps no entry refuses, because an empty PATH makes bash search the current directory.
  So neither they nor the agent CLI they start finds a tool through a `.`, relative or in-project entry.
  Run by path, `moe-call.sh` starts under `/bin/sh` and hands itself to bash using builtins only: under the marker
  exactly `/bin/bash` (a host without it refuses with `MOE_PROTECTED_INTERPRETER_NOT_FOUND`), otherwise `bash` by PATH
  lookup, as the old `#!/usr/bin/env bash` did. A caller that names the interpreter (`bash moe-call.sh`) chooses it, so
  under the marker it must name an absolute bash, or run with the rewritten PATH as the wrappers do.
  `moe-agent.ps1` rewrites PATH the same way before its first bare-name command, keeping only the entries
  `Find-MoeProtectedFile` trusts, so an 8.3, subst, junction or network spelling of the project goes too, and runs
  its WT-13 git check only after that. Both wrappers also export `MOE_PROTECTED_GIT`, the only git their
  worktree-launch and board-snapshot Node programs spawn; without an absolute one those programs fail closed
  (`MOE_WORKTREE_CREATE_FAILED`, `MOE_BOARD_SNAPSHOT_SKIPPED`). On POSIX, ps1 still puts the pinned node's directory
  first on PATH.
  VS Code (`services/MoeDaemonClient.ts`, `util/AgentLauncher.ts`) selects the same way from
  `<extensionPath>/bundled`. Candidate source becomes Git objects only
  (`admission.mjs`); branch writes stay in the wrappers' landing. A guest gets no daemon address: the host session
  (`guest-session.mjs`) forwards its requests, and the runner client (`runner-client.mjs`) dials, only a daemon whose
  own `/health` reports a loopback bind.
- **Owned VM lifecycle** (`lifecycle.mjs`, `vm-control.mjs`). Multipass has no ownership labels, so ownership is an
  owner-only ledger record (`~/.moe/runner-state/<project hash>/vms`, or under `MOE_RUNNER_STATE_DIR`), written before
  launch under a random `moe-vm-<20 hex>` name. Reconcile and cleanup touch recorded names only, delete by exact name,
  and preserve a record whose attempt or job lease is not proven closed. `vm-control.mjs status|reconcile|cleanup
  --project <path>` is the IDE contract. The pinned image, toolchain and agent caches sit beside the ledger in
  `<state root>/<project hash>/images`; on Linux with no `MOE_RUNNER_STATE_DIR` they are in
  `~/moe-runner-cache/<project hash>/images`, since the Multipass snap reads only non-hidden paths under home.
- **Pinned bootstrap and readiness** (`guest-bootstrap.mjs`, `provision.mjs`, `guest-readiness.mjs`). The image is
  verified against its sha256 pin and launched as the verified local file (on Windows as `release:<pin sha256>`, whose
  reported `image_hash` must equal the pin, else `IMAGE_PROVIDER_HASH_MISMATCH`). The cloud-init user-data travels
  only on the launch's stdin and installs the root-owned supervisor, the MCP shim and the locked job identities
  `moe-agent` and `moe-check`. Readiness needs a clean cloud-init `done`, then zero mounts, the installed hashes, the
  credential denied to both identities, locked unprivileged identities and bounded resources.
- **Supervisor modes** (`guest-supervisor.py`, run as root over the guest SSH route; its header defines every code).
  `bridge` runs one agent job with the pinned Node toolchain first on PATH (`/opt/moe/toolchain/bin`), as for a check
  job; `check` runs one approved check, `materialize` copies a snapshot into the workspace, `export` streams the
  workspace's changes back, never an untracked node_modules directory, `verify` compares the workspace with its
  manifest, and `agents`, `toolchain` and `dependencies` install pinned bytes. Exit codes: 0 done, 64 usage, 65 malformed
  input, 66 no workspace, 71 the job could not start, 73 already exists, 74 I/O failure or host EOF, 75 signal,
  76 protocol violation, 77 not root. `check` adds 79 (a protected path lacks its approved blob), 80 (the job changed one),
  81 (the dependency install failed) and
  82 (the candidate's own package files were refused). In the guest a guard starts each job as its locked identity with
  no new privileges and in a fresh PID namespace (a check job also in its own loopback-only network namespace, under
  its rlimits), so no descendant, `setsid` or not, outlives the job.
- **Host-guest transport** (`guest-ssh.mjs`, `guest-stream.mjs`). All eight supervisor modes stream over the in-box
  OpenSSH client at a pinned path, never a PATH lookup: `/usr/bin/ssh` on Linux and macOS,
  `%SystemRoot%\System32\OpenSSH\ssh.exe` on Windows.
  - The argv is fixed: `-F none`, ed25519 only, and no agent, forwarding, PTY or ProxyCommand. The guest's host key is
    pinned through cloud-init `ssh_keys` and checked under `HostKeyAlias=<owned name>`.
  - The address is `multipass info` `ipv4[0]`, read fresh for every stream. A Windows `hcs` install and a WSL `qemu`
    install can both number zone1 `10.97.0.0/24`, so one guest IP can exist on both hosts at once, or be recycled. The
    fresh read plus the HostKeyAlias pin turn either case into ssh exit 255 and a fixed code, never a session with the
    wrong guest.
  - Provisioning writes a fresh per-VM client key to `<home>/.moe/guest-ssh/<name>.key` and the pinned host key line to
    `<name>.known_hosts` (both 0600, never overwritten). Purging the VM removes both. The guest accepts the key only
    for the default user, as `restrict,command="exec /usr/bin/sudo -n /opt/moe/bin/moe-supervisor \"$SSH_ORIGINAL_COMMAND\""`,
    so it starts only supervisor modes. Readiness also checks that neither job identity can read the guest host key
    (`readHostKey`).
  - `multipass exec` now carries only stdin-less queries capped at 64 KiB (`MAX_PROBE_BUFFER`).
  - Why: Multipass 1.17.0 `exec` truncates stdin on Linux, delivers none on Windows (#3749) and stalls Windows stdout
    near 2 MiB (#5478).
  - Error handling: there is no fallback to `exec` stdio or to the host. An unusable route fails closed with a fixed
    code.
- **Seat VM route.** (`agent-seat.mjs`, `seat-capacity.mjs`, and the VM route of both wrappers.) Under verified-local a
  worker or QA seat gets one owned VM for its whole life, never one per job.
  - Start: before it claims anything the wrapper runs `node scripts/local-runner/agent-seat.mjs seat-start --project
    <abs> --worker <id> --runner <pid@token> --host <host>`, which first reclaims this seat's own leftover VM and a
    dead previous incarnation's. The seat then claims with `executionRoute: 'vm'`.
  - Per job: `seat-job` runs a verified sweep of earlier jobs, the root-only guest-supervisor `reset` mode (the
    workspace, its manifest and old session homes), a fresh materialize of the task commit, the job, and the candidate
    import. A worker's candidate is admitted and landed through the wrapper's candidate path; a QA job's must be
    empty. Residue outside the workspace, such as `/tmp`, persists across one seat's jobs.
  - Stop: `seat-stop` deletes the VM through the owned ledger when the seat exits, on every path. A crashed seat's VM
    is reclaimed by cleanup once the daemon shows the seat gone (`moe.get_seat_liveness`).
  - Cap: at most max(1, min(floor(CPUs / 2), floor((RAM - 8 GiB) / 4 GiB))) seat VMs run on the host at once, across
    every project (`hostAgentVmCap`; check VMs never count). Over the cap, `seat-start` answers `SEAT_CAPACITY_FULL`
    (or `SEAT_CAPACITY_LOCK_BUSY`) and exits 75. The seat waits and retries before claiming
    (`MOE_SEAT_CAPACITY_WAIT`) and never falls back to the host.
  - WSL: under verified-local, worker and QA seats run the native PowerShell wrapper with Windows Multipass. JetBrains
    Start Agent picks it even with "Run Agents in WSL" on, and `moe-agent.sh` refuses verified-local inside WSL
    (`MOE_VERIFIED_LOCAL_WSL_UNSUPPORTED`). Architect and governor seats keep their usual launch, WSL included.
  - Credentials: a claude seat sends the leased account's VM credential, read through
    `moe-account-lease.mjs vm-credential <id> <configDir> <claude command>`: a minted VM token when one is stored
    (`accounts vm-token <id>`, optional, valid about a year), else the short-lived access token of the account's own
    host sign-in, read-only from `.credentials.json` in its Claude config folder. It goes to `seat-job` on stdin only
    and reaches the guest only in the job frame, as `CLAUDE_CODE_OAUTH_TOKEN`. The refresh token never leaves the
    host: Moe never uses, sends or writes it, and never writes that file. When 5 minutes or less are left, the host's
    own claude renews the sign-in first (claude's own refresh, under its own lock, as when a host seat starts on that
    account), so host seats keep their sign-in. The access token lasts 8 hours from claude's last renewal and the
    guest cannot renew it, so a job cannot outlive it. The wrapper sends a sign-in token only when at least an hour is
    left. With less, the seat waits with the task held (`MOE_VM_CREDENTIAL_UNAVAILABLE`, reason `short-life`) until
    the host's claude renews the token in its last 5 minutes. A job that still runs past the expiry ends with claude's
    authentication error, and its work lands as for any nonzero exit: a worker's candidate commit, while a QA job
    leaves the row in REVIEW. The next job gets a renewed token. A minted token avoids this. With no usable
    credential, the seat prints `MOE_VM_CREDENTIAL_UNAVAILABLE` with a reason, waits with the task held and never
    falls back to the host. macOS keeps the sign-in in the login Keychain, which Moe does not read, so a macOS host
    needs a minted token. Rotation stays on. A codex seat sends `OPENAI_API_KEY` or `CODEX_API_KEY` from the
    wrapper's own environment, else it stops with `MOE_VM_CREDENTIAL_UNAVAILABLE` before claiming.
  - Only claude and codex run in a seat VM: a gemini or grok worker or QA seat is refused
    (`MOE_VERIFIED_LOCAL_CLI_UNSUPPORTED`), and so is shared mode (`MOE_VERIFIED_LOCAL_SHARED_MODE_UNSUPPORTED`).
- **Check lifecycle** (`check-lifecycle.mjs`, `check-session.mjs`, `check-dispatch.mjs`). Each run gets a fresh VM:
  provisioning and readiness; the pinned Node toolchain and an offline dependency tree, built on the host from the
  approved definition's lockfiles (`toolchain-cache.mjs`, `dependency-cache.mjs`); a copy-only materialization; an
  `npm ci --offline --ignore-scripts --workspaces=false` in the guest, refused before any install when a lockfile
  directory's own `package.json` is missing or linked, differs from the lockfile's root entry or sets overrides, bundling
  or workspaces, or sits beside an `npm-shrinkwrap.json` or `.npmrc` (82, a `code-failure`; a lockfile, cache or install
  fault is 81, an `infra-failure`); the check once, as `moe-check`; `verify` of a passed run's workspace; then the VM
  deleted on every path. The outcome is `passed`, `code-failure`, `infra-failure`, `timeout`,
  `skipped` or `inconclusive`, and it reaches the daemon only over the authenticated `/runner` channel.
- **Environment identity and evidence freshness** (`check-evidence.mjs`). `checkEnvironment` hashes the declared
  `CHECK_BOUNDARIES` with the observed image, supervisor, VM size, toolchain and dependency tree, so changing any of
  them needs new evidence. `evidenceStatus` is `fresh` only when environment, tree, definition digest and plan revision
  all match.
- **Certification** (`certify.mjs`): the operator's native run on real hardware. See [CERTIFICATION.md](CERTIFICATION.md).

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

## Security Notes

- The protected profile's threat model is in [design/protected-profile-threat-model.md](design/protected-profile-threat-model.md).
  Inside it: repository content (including ignored `.moe/` runtime files that a pull can overwrite), guest
  code, browser pages and network peers. Outside it: same-user host processes, host-launched agent seats and
  other local users. A single-user host is assumed.
- On the live daemon, a file under the project, `.moe/daemon.json` included, may add a refusal but never an
  admission. Trust in the live daemon comes from the daemon itself, or from owner-only state outside the
  repository.
- **JetBrains protected state** (`util/ProtectedStateStore.kt`, CQ-RF01 and CQ-RF02). State that must outlive the IDE
  session lives in `<IDE system directory>/moe/protected-state`, never in the repository. The root and each file must
  be owner-only (rwx------ and rw-------, or an ACL whose every entry allows the owner). Each file must be a regular
  file reached without a link, at most 64 KiB, and named by a sha-256. Anything else reads as untrusted, and a root
  inside the project (a `runIde` sandbox) is never written. Per project the store holds:
  - **Daemon provenance.** The pid, start time and supervisor flag of each process this IDE started from the installed
    daemon, with that daemon's real path. Under the protected profile the plugin connects only when the pid
    `.moe/daemon.json` names, or its direct parent supervisor, matches a record by pid and start time. The record
    comes from this session or, after an IDE restart, from the store, and it must name the daemon installed now.
    Records whose process died or whose pid was reused are pruned. Any other daemon is refused: "the running Moe
    daemon (pid N) was not started by this IDE from the installed Moe runtime. Stop it, then use Restart Daemon."
  - **Profile pin.** A project read as `verified-local` is recorded protected. A later legacy or absent declaration
    keeps it protected and asks once per session (**Moe: Execution Profile Downgrade**, default **Keep Protected**).
    An allowed downgrade takes effect after an IDE restart. An unreadable `project.json`, or a pin the IDE would not
    have written, reads as protected. On Windows, a folder pinned under another spelling (subst, mapped drive, share
    or device path) is matched by file identity (task-9a1da6f6). A pin is read even when the store cannot be placed,
    because a read only restricts. The pin is per IDE system directory: another JetBrains product or IDE profile has
    none, like a fresh machine, and follows the declaration as written. A later same-session `verified-local` read
    records the project protected again (task-6d5d3db2). An Allow answered while it declares `verified-local`, or while
    its `project.json` is unreadable, records nothing.
- **Unverified-daemon replacement (JetBrains).** When the protected plugin finds such a daemon it asks first
  (**Moe: Unverified Daemon**, default **Keep It**), because VS Code or a terminal agent may be using it. **Keep It**
  leaves it running, and the plugin stays disconnected. **Stop and Replace** runs the installed CLI's `stop`,
  bounded at 20 s, with `NODE_OPTIONS` and `NODE_PATH` removed and PATH reduced to its protected entries. It then waits
  up to 15 s until the process and its parent have exited and `.moe/daemon.json` is cleared, and only then starts the
  installed daemon and records it. A failed attempt keeps the captured identities, so a retry cannot start a second
  daemon beside a survivor.
- **Restart Daemon on Windows** (`MoeDaemonSupervisor.stopWindowsRestart`, CQ-RF04). A pid that is absent, dead or
  0 is never signalled. Under the protected profile a daemon whose provenance does not verify is not stopped: "Restart
  Daemon did not stop pid N … this IDE did not start it from the installed Moe runtime." Otherwise the plugin runs
  the installed `stop`. When that `stop` exits 1 (it could not verify the pid, so it signalled nothing) and the pid is
  outside this IDE's spawn tree, the plugin signals and starts nothing: "the stop could not verify pid N, which
  .moe/daemon.json names … so it left that process running". Otherwise it then terminates the old process tree, roots first: the supervisor this IDE spawned and,
  under protected, the daemon's genuine parent; under legacy a foreign parent is only watched. The descendants follow,
  within the same bounded wait. A process still running afterwards refuses the new start ("pid N is still running
  after the stop, and it could restart the old one"), and so does a tree a previous attempt could not resolve. A
  second click while a stop is in flight is refused. On other hosts Restart Daemon sends SIGTERM to the daemon.json
  pid (under protected, only to a captured handle whose provenance verifies) and waits up to 15 s for it to exit
  before starting anything; a survivor in this IDE's own spawn tree is killed with that tree, and any other survivor
  refuses ("pid N is still running after the stop…").
- **The daemon CLI's `stop` and `status`** (`packages/moe-daemon/src/index.ts`, task-d6ebe4ab). Both flows above reach
  the old daemon through the installed CLI's `stop`. `stop`, `status` and the `start` gate find it through
  `.moe/daemon.json`, which is repository content, so the CLI dials its `bindHost` only when the literal it resolves to
  is loopback (127.0.0.0/8 or `::1`) or an address that one of this machine's network interfaces holds. A zoned IPv6
  literal such as `fe80::a%eth1` never counts, because its zone picks the link that is dialed: it can reach a peer
  there even when another interface holds that address. The name is resolved once, and that literal is the one
  dialed. Otherwise nothing is probed. While the recorded pid is alive,
  `stop` sends no signal, removes nothing and exits 1: Stop and Replace then starts nothing, and the protected Restart
  Daemon reports that the stop request failed. `status` reports `stopped` with reason `bindHost not local`. A dead
  pid's daemon.json is still removed, and `start` replaces the file as it does any daemon.json it cannot verify.
  Loopback, `0.0.0.0`, `::`, `--host wsl`, and a name or address of a local interface stop as before. For a
  daemon.json from the other side of the WSL boundary, the gateway from the routing table is still probed, and such a
  file is never signalled or removed. A daemon.json whose `pidNamespace` is not the reader's own (a daemon in a
  container, task-da89f620; see `docs/SCHEMA.md`) is judged by `/health` at the local probe address alone, and its pid
  is never signalled: while that answer confirms this project, `status` reports it running, `stop` sends no signal,
  removes nothing and exits 1, `start` refuses a second daemon and `doctor` reports `[OK]`; with no answer it is stale,
  so `status` and `stop` remove it, `start` replaces it and `doctor` warns `(stale)`.
- **VS Code parity** (CQ-RF06, `services/MoeDaemonClient.ts`). Selection takes only `<extensionPath>/bundled` and an
  absolute node outside the project, and fails closed. Windows bases that are not plain local paths are refused with
  the JetBrains words. The state, pin and daemon provenance below are VS Code's own, smaller counterparts of the
  JetBrains ones:
  - **Protected state store** (task-98c81a27). State that must outlive the window lives in the extension's global
    storage under `protected-state` (`extension.ts` calls `useProtectedStateRoot` first in `activate`), never in the
    repository. On POSIX the root must be exactly 0700 and each file 0600, owned by this user. Node has no ACL API, so
    on Windows the per-user global storage is the owner-only boundary. Each file must be a regular file reached
    without a link, at most 64 KiB, and named by 16 hex digits plus `.json`. Anything else reads as untrusted. A root
    that is not provably outside the project is never written.
  - **Profile pin** (task-98c81a27). A project read as `verified-local` is recorded protected. A later legacy or
    absent declaration keeps it protected and asks once per window session, in a modal with **Keep Protected** and
    **Allow Downgrade**. Only Allow Downgrade records legacy, and it takes effect after VS Code restarts. Any other
    answer changes nothing. An unreadable `project.json`, or a pin VS Code would not have written, reads as protected.
    A later `verified-local` read in the same window session records the project protected again (task-0900b936). An
    Allow answered while the project declares `verified-local`, or while its `project.json` is unreadable, records
    nothing.
  - **Spawn provenance** (task-648a5916). A protected start passes the installed daemon a fresh key in
    `MOE_SPAWN_PROOF_KEY` and records the key with that daemon's path. Before the WebSocket opens, VS Code sends a
    fresh `/health` challenge. It connects only when the daemon's `spawnProof` is the HMAC under a key from this
    window, or from the store record that names the daemon installed now. A configured endpoint (the `moe` settings
    `daemon.host` and `daemon.port`, which a trusted workspace's `.vscode/settings.json` can set) is never admitted.
    Any other daemon is refused: "Protected execution profile: the running Moe daemon (pid N) was not started by this
    VS Code from the installed Moe runtime. Stop it, then reconnect." VS Code then stays disconnected and does not
    retry by itself.
  - **Replacement** (RF03 parity). It is offered only for a daemon that `.moe/daemon.json` names, as a modal whose only
    action is **Stop and Replace**. Dismissing the modal keeps the refusal. Stop and Replace runs the installed CLI's
    `stop`, bounded at 20 s. It then waits up to 15 s until the pid has exited and `.moe/daemon.json` is cleared,
    starts the installed daemon with a fresh key, and verifies it again. A failed stop or wait keeps the refusal.
- **Accepted Windows costs** (task-52fb6178, task-08bb7723, task-dd545bf1, task-9a1da6f6). Under the protected
  profile the plugins refuse:
  - a project on a share, a `\\wsl$` path, a device path or a mapped network drive. Clone to an unmapped local drive,
    run the IDE inside the distro for WSL, or stay on the legacy profile;
  - a node or plugin install on a share. Share and device PATH entries are skipped.

  A state root on a share cannot be proved outside the project, so its state is session-only. A dangling or
  trailing-dot root reads as empty, and a downgrade confirmed under an unprovable store is asked again after each
  restart.
- Accepted gaps: the daemon.json port↔pid binding, and the CQ-R08 per-request re-check window. The record
  lists the open follow-ups.
- Plain HTTP `GET /health` answers only a request with no Host header, or one whose Host (port optional) is
  `localhost`, a loopback IP literal, or the IP literal of the address the connection arrived on (for example
  the WSL gateway, or an explicit bind address). Any other Host, every DNS name included, gets 403 with no
  body fields, so a page that points a name at the daemon cannot read it (`server/healthHost.ts`). WebSocket
  upgrades rely on the Origin rule instead. Clients that reach `/health` (`MOE_DAEMON_HOST`, curl) must use an
  IP literal or `localhost`. With `MOE_SPAWN_PROOF_KEY` set by the IDE for a protected spawn, `GET /health?challenge=<64 lowercase hex>` also returns `spawnProof`, the HMAC-SHA256 of the ASCII challenge under that key (never the key itself); any other query returns the plain body.

---

## Error Handling (Current)

- Missing `.moe` → plugin initializes or daemon throws on start.
- Invalid JSON files → daemon ignores invalid entities during load.
- WebSocket disconnects → plugin shows status in header.

---

## Performance Notes

- File watcher debounces writes (chokidar awaitWriteFinish).
- State snapshots are full state; diffs are per-event only for updates.
