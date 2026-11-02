# VS Code parity and plugin reuse (epic-aabc654d)

- Epic: `epic-aabc654d`. The human's goal, verbatim: "Make sure our VSCODE is working and we reuse as much as we can between plugins".
- Date: 2026-11-02.
- Written by VSC-0, task `task-a3e414a3dce848e6939081e5cbf941ce`.

## Baseline

Does `moe-vscode` build, test and speak the current daemon wire? Yes to all three, measured in a git-archive snapshot of HEAD. No npm command ran in the shared checkout.

- Snapshot sha: `aacc03ad51cc488a26f15e0575fb0d39cfd73b0a` (`git archive HEAD` of the whole repo, extracted to `/mnt/d/moe-scratch/vsc0-aacc03ad`, deleted afterwards). Environment: `env -i HOME=$HOME PATH=$HOME/.nvm/versions/node/v24.21.0/bin:/usr/local/bin:/usr/bin:/bin`, WSL Linux.

| Step (all in the snapshot) | Command | Exit | Result |
|---|---|---|---|
| DoD gate, `moe-vscode` | `npm ci --no-audit --no-fund && npm test && npm run compile` | 0 | 388 tests, 384 pass, 0 fail, 0 cancelled, 4 skipped (Windows-only); `tsc -p ./` clean |
| Lint, `moe-vscode` | `npm run lint` (`eslint src --ext ts`) | 0 | no findings |
| Daemon build | `npm ci --no-audit --no-fund && npm run build` in `packages/moe-daemon` | 0 | `tsc` clean |
| Proxy build | `npm ci --no-audit --no-fund && npm run build` in `packages/moe-proxy` | 0 | `tsc -p tsconfig.build.json && tsc --noEmit` clean |
| Package | `npm run package` in `moe-vscode` | 0 | `moe-vscode-0.8.0.vsix`, 4105 files, 61.37 MB (64,353,555 bytes) |
| Onboarding smoke | `node scripts/tests/onboarding.mjs <unzipped vsix>/extension/bundled` (run from the repo root) | 0 | `PASS onboarding: fresh init, health, MCP, epic/task, architect claim, plan approval, doctor, restart persistence` |

No test file on HEAD was red, so the peer-checkpoint rerun was not needed.

For comparison, the architect's pre-epic run at `882a4c39f618e61ca6159c360e236e88dd925ee4`: lint 0; compile 0; 388 tests, 384 pass, 4 skip (Windows-only), 0 fail; package OK with 4105 files and 61.37 MB using `--no-dependencies` (an equivalent file set, because `.vscodeignore` drops `node_modules/**`); onboarding PASS. The two runs agree.

**UUID-path finding.** `npm run package` fails from a snapshot whose absolute path contains a UUID-shaped segment, for example a Claude scratchpad directory. npm 12 redacts UUIDs in `npm list` output (it prints `***`), vsce then collects zero files, and the error is a misleading "Extension entrypoint(s) missing". The architect hit this on 2026-11-02. Package from a path without such a segment, such as `/mnt/d/moe-scratch/vsc0-<short sha>`.

### Daemon wire

Lists re-derived from the sources at the snapshot sha with `grep`.

- **Daemon accepts** (`case '…'` in `packages/moe-daemon/src/server/WebSocketServer.ts`): ADD_ACCOUNT, ADD_TASK_COMMENT, ADD_TEAM_MEMBER, AGENT_TOOL_EVENT, APPROVE_DECISION, APPROVE_PROPOSAL, APPROVE_TASK, ARCHIVE_DONE_TASKS, CLIENT_HELLO, CREATE_EPIC, CREATE_TASK, CREATE_TEAM, DELETE_EPIC, DELETE_TASK, DELETE_TEAM, DEREGISTER_WORKER, GET_ACTIVITY_LOG, GET_CHANNELS, GET_DECISIONS, GET_EXECUTION_READINESS, GET_MESSAGES, GET_METRICS, GET_PINS, GET_STATE, MOVE_ACCOUNT, PING, PIN_MESSAGE, REJECT_DECISION, REJECT_PROPOSAL, REJECT_TASK, RELEASE_TASK, REMOVE_ACCOUNT, REMOVE_TEAM_MEMBER, RENAME_ACCOUNT, REOPEN_TASK, REORDER_TASK, SEND_MESSAGE, SET_ACCOUNT_SWITCH_PERCENT, TOGGLE_PIN_DONE, UNPIN_MESSAGE, UPDATE_EPIC, UPDATE_SETTINGS, UPDATE_TASK, UPDATE_TEAM.
- **Daemon broadcasts** (`StateChangeEvent` in `packages/moe-daemon/src/state/StateManager.ts`): ACCOUNTS_UPDATED, CHANNEL_CREATED, CHANNEL_DELETED, DECISION_PROPOSED, DECISION_RESOLVED, EPIC_CREATED, EPIC_DELETED, EPIC_UPDATED, MESSAGE_CREATED, PINS_UPDATED, PROPOSAL_CREATED, PROPOSAL_UPDATED, RESOURCE_UPDATED, SETTINGS_UPDATED, STATE_SNAPSHOT, TASK_CREATED, TASK_DELETED, TASK_UPDATED, TEAM_CREATED, TEAM_DELETED, TEAM_UPDATED, WORKER_CREATED, WORKER_DELETED, WORKER_UPDATED.
- **VS Code sends** (`sendMessage('…'` in `moe-vscode/src/services/MoeDaemonClient.ts`): ADD_TASK_COMMENT, APPROVE_DECISION, APPROVE_PROPOSAL, APPROVE_TASK, ARCHIVE_DONE_TASKS, CREATE_EPIC, CREATE_TASK, DELETE_EPIC, DELETE_TASK, GET_ACTIVITY_LOG, GET_CHANNELS, GET_DECISIONS, GET_MESSAGES, GET_METRICS, GET_PINS, GET_STATE, PING, PIN_MESSAGE, REJECT_DECISION, REJECT_PROPOSAL, REJECT_TASK, REOPEN_TASK, SEND_MESSAGE, TOGGLE_PIN_DONE, UNPIN_MESSAGE, UPDATE_EPIC, UPDATE_SETTINGS, UPDATE_TASK. It also sends CLIENT_HELLO as the socket's first frame, and GET_EXECUTION_READINESS (the `READINESS_REQUEST` constant) before verified-local launches.
- **VS Code handles** (`case '…'` in the same file): ACCOUNTS_UPDATED and ACCOUNT_ADDED (both dropped on purpose), ACTIVITY_LOG, ARCHIVE_DONE_RESULT, CHANNELS, CHANNEL_CREATED, DAEMON_SHUTTING_DOWN, DECISIONS, DECISION_PROPOSED, DECISION_RESOLVED, EPIC_CREATED, EPIC_DELETED, EPIC_UPDATED, ERROR, EXECUTION_READINESS, MESSAGES, MESSAGE_CREATED, MESSAGE_SENT, METRICS, PINS, PIN_CREATED, PIN_REMOVED, PIN_TOGGLED, PONG, PROPOSAL_CREATED, PROPOSAL_UPDATED, SETTINGS_UPDATED, STATE_SNAPSHOT, TASK_CREATED, TASK_DELETED, TASK_UPDATED, TEAM_CREATED, TEAM_DELETED, TEAM_UPDATED, WORKER_CREATED, WORKER_DELETED, WORKER_UPDATED.
- **JetBrains sends** (`MoeCommandSender.kt`, `MoeMessageDispatcher.kt`; GET_STATE is sent from `MoeProjectService.kt`): everything VS Code sends except PING, plus CLIENT_HELLO, GET_EXECUTION_READINESS, RELEASE_TASK, DEREGISTER_WORKER and the five account commands (ADD_ACCOUNT, REMOVE_ACCOUNT, MOVE_ACCOUNT, RENAME_ACCOUNT, SET_ACCOUNT_SWITCH_PERCENT).
- **JetBrains handles** the VS Code list plus CHANNEL_DELETED, WORKER_DEREGISTERED and PROPOSAL_DELETED. The daemon never emits PROPOSAL_DELETED. JetBrains also acts on ACCOUNTS_UPDATED and ACCOUNT_ADDED.
- **Neither client handles** PINS_UPDATED or RESOURCE_UPDATED, although the daemon emits them (`chatStore.ts`, `resourceStore.ts`).
- Both clients speak CLIENT_HELLO and the plan-approval wire with `expectedPlanRevision`.

**Verdict.** VS Code speaks the current wire for everything it implements. Every gap is a missing feature, not a wire break.
