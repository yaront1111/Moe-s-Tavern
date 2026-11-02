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

## Gap list (JetBrains → VS Code)

JetBrains is the primary IDE, so each gap is measured against it. Row labels (VSC-n) are resolved to task ids in the slice table below.

| # | What JetBrains has (file) | VS Code at baseline | Row(s) |
|---|---|---|---|
| G1 | Task-status notifications: the TASK_UPDATED/TASK_CREATED branch of `MoeMessageDispatcher` notifies through `MoeNotificationService` on AWAITING_APPROVAL, BLOCKED, REVIEW and DONE | None | VSC-1 |
| G2 | `<root>/.worktrees` excluded from indexing (`util/WorktreeExclusion.kt`) | The file watcher and search crawl every worktree | VSC-2 |
| G3 | Delivery section in task detail (`toolwindow/DeliveryPresentation.kt`) | No type for it and nothing rendered | VSC-3, VSC-8 |
| G4 | One blocker presentation (`toolwindow/TaskBlockerPresentation.kt`) | Two copies (`src/panels/TaskDetailPanel.ts` and `media/board.js`), and no test pins their parity | VSC-4, VSC-9 |
| G5 | Settings edit approvalMode, speedModeDelayMs, agentCommand and enableAgentTeams, and show the effective landing policy read-only (`MoeSettingsDialog.effectivePolicyRows`) | No enableAgentTeams and no policy view; still edits autoCreateBranch, branchPattern and commitPattern, which no launcher reads | VSC-5, VSC-10 |
| G6 | Release Agent (RELEASE_TASK) in task detail and on the card | None | VSC-6, VSC-11 |
| G7 | CHANNEL_DELETED removes the channel | Ignored, so the dead channel stays | VSC-6 |
| G8 | Accounts tab: rotation list; add, sign in, remove, move, rename, switch percent (five senders) | ACCOUNTS_UPDATED dropped, no UI | VSC-7, VSC-12 to VSC-15 |
| G9 | `AgentSeatTracker` deregisters a seat whose terminal closed (DEREGISTER_WORKER with `terminal_closed`, acknowledged by WORKER_DEREGISTERED) | A closed terminal's worker keeps its tasks | VSC-19, VSC-20, VSC-21 |
| G10 | `build.gradle.kts` bundles every `docs/roles` file; `bundle-assets.mjs` bundles three role docs; the two lists are kept by hand | Hand-kept list | VSC-16 |
| G11 | CI packages and smoke-tests the JetBrains zip on PRs | The vsix is packaged only at release; packaging after `npm run compile` ships stale `dist/` tsc output plus `eslint.config.mjs` | VSC-17 |

### Not sliced

| # | Difference | Decision and reason |
|---|---|---|
| D1 | "Run Agents in WSL" toggle | VS Code Remote-WSL runs the extension host inside the distro, so the toggle is moot; a manual check in VSC-18 |
| D2 | Project selector / `MoeProjectRegistry` | VS Code binds a window to `workspaceFolders[0]`; deferred until asked |
| D3 | Stop the spawned daemon when the last project closes (registry refcount) | Needs a human decision, because agent seats share the supervised daemon |
| D4 | Live Activity Log tab | `moe.showActivityLog` opens a log document; accepted difference |
| D5 | Explicit Initialize Moe action | VS Code runs the daemon's `init` on connect when `.moe` is missing; accepted |
| D6 | Keyboard shortcuts | Low value; deferred |
| D7 | PINS_UPDATED and RESOURCE_UPDATED | Neither client handles them; a JetBrains-first follow-up |
| D8 | Bundled `node_modules` ship devDependencies (vitest, typescript, rolldown) in both plugins | A follow-up to VSC-16 |

Notes. JetBrains' `notifyConnectionLost` and `notifyConnectionRestored` are never called, so there is no connection-notification gap to close. Role docs and skills need no VS Code sync: the daemon rewrites `.moe/roles` and `.moe/skills` at every start (`writeInitFiles` and `writeSkillFiles` in `packages/moe-daemon/src/index.ts`).

## Reuse decision

Decision: keep two native UIs (Kotlin/Swing in JetBrains, TypeScript webviews and tree views in VS Code) and share behaviour, not code. Options considered:

| # | Option | Verdict | Reason |
|---|---|---|---|
| O1 | Host VS Code's webviews in JetBrains through JCEF | Rejected | Maximum reuse, but it rewrites the primary IDE's UI, JCEF is missing in some JetBrains setups, and the epic forbids regressing JetBrains |
| O2 | Shared TypeScript client-core package | Rejected | Only VS Code can consume TypeScript. Type-importing `packages/moe-daemon/src/types/schema.ts` into VS Code was also considered and deferred: `tsconfig` rootDir is `src`, so it changes the emit layout and couples compiles to schema churn |
| O3 | Compute presentation in the daemon and serve it on `/ws` | Deferred | A true single source, but it changes the wire, `docs/SCHEMA.md` and `docs/MCP_SERVER.md`, which are frozen for this epic |
| O4 | Client-neutral golden corpora | **Chosen** | Extends CQ-I06b's `moe-jetbrains/src/test/resources/client-verdicts.json` (27 approval and 23 VM rows today), already read by `ClientVerdictCorpusTest.kt` and by the `moe-vscode` tests `plan-review.test.cjs` and `managed-vm-verdicts.test.cjs`. One JSON file per shared behaviour (`client-delivery`, `client-blocker`, `client-settings-policy`, `client-accounts`, `client-seat-tracker`), each executed by a Kotlin test and a `moe-vscode` test. JetBrains writes it first. A disagreement is fixed or filed, never given a client-specific expectation, and consumer rows never edit the corpus |
| O5 | Shared strings checked at test time | **Chosen** | VS Code labels for corpus keys must equal `MoeBundle.properties`; a generated build-time catalog is deferred |
| O6 | One shared bundle manifest | **Chosen** | `scripts/bundle-manifest.json`, read by both plugin builds (VSC-16) |
| O7 | Shared launcher | Kept | Both plugins already launch seats through the bundled `scripts/moe-agent.{ps1,sh}` |

Criterion: use a corpus when the logic branches or renders text in both clients; a four-status rule like VSC-1's notifications is ported with mirrored tests instead.

## Slice table

Built from `moe.list_tasks` for `epic-aabc654d` on 2026-11-02 (22 rows). "Area" names the gap or the main files the row owns; each row's own plan and `affectedFiles` are authoritative.

| Label | Task id | Title | Kind | Wave | dependsOn | Area |
|---|---|---|---|---|---|---|
| VSC-0 | `task-a3e414a3dce848e6939081e5cbf941ce` | Breakdown: audit moe-vscode against JetBrains, decide plugin reuse, slice this epic | doc | 1 | none | this doc |
| VSC-1 | `task-2ef8e36c29f4490884dff27c9f3ed9fb` | VS Code: notify on task status transitions, matching JetBrains | VS Code | 1 | none | G1, `moe-vscode/src` notifications |
| VSC-2 | `task-09e784e5dd214833b8b9df66038941cc` | VS Code: keep per-task worktrees out of file watching and search, matching JetBrains | VS Code | 1 | none | G2, `moe-vscode/package.json` |
| VSC-3 | `task-a5f39d5535404f6e9e59f762c046f5e0` | JetBrains: shared delivery corpus for DeliveryPresentation | JetBrains corpus | 1 | none | G3, `client-delivery.json` |
| VSC-4 | `task-db97dacb7b3843b4a6f747c154123501` | JetBrains: shared blocker corpus for TaskBlockerPresentation | JetBrains corpus | 1 | none | G4, `client-blocker.json` |
| VSC-5 | `task-0f2cc6eb40324b37bafa8be4cf65caa3` | JetBrains: shared landing-policy corpus for the settings dialog | JetBrains corpus | 1 | none | G5, `client-settings-policy.json` |
| VSC-6 | `task-9f6a725ff14c4c08b4acb203884e7ae5` | VS Code client: wire parity with JetBrains (RELEASE_TASK, CHANNEL_DELETED) | VS Code | 1 | none | G6/G7, `MoeDaemonClient.ts`, `extension.ts` |
| VSC-7 | `task-93729f32ef6f408cbd411813c5c93838` | JetBrains: shared accounts corpus for AccountPresentation | JetBrains corpus | 1 | none | G8, `client-accounts.json` |
| VSC-8 | `task-185f728fd79c4658a86b8a0b40a66595` | VS Code: Delivery section in task detail from the shared delivery corpus | VS Code | 2 | VSC-3 | G3, `TaskDetailPanel.ts` |
| VSC-9 | `task-06dda5c1df29433ab4eb5c4230b38581` | VS Code: task detail and board blocker logic pass the shared blocker corpus | VS Code | 2 | VSC-4 | G4, `TaskDetailPanel.ts`, `media/board.js` |
| VSC-10 | `task-743e577af8204d6aa48d11fab01c979d` | VS Code: settings panel parity from the shared landing-policy corpus | VS Code | 2 | VSC-5 | G5, settings panel |
| VSC-11 | `task-e8255fb1ab274ca9bf67d49c34a9635e` | VS Code: Release Agent action in task detail, matching JetBrains | VS Code | 2 | VSC-6 | G6, `TaskDetailPanel.ts` |
| VSC-12 | `task-daf5abdd282a4c46b280eb0a48e74cd9` | VS Code client: Claude account rotation wire, matching JetBrains | VS Code | 2 | VSC-6 | G8, `MoeDaemonClient.ts` |
| VSC-13 | `task-065e4812d96247cc8394b3cd0416475d` | VS Code: AccountPresentation port that passes the shared accounts corpus | VS Code | 3 | VSC-7, VSC-12 | G8, accounts presentation |
| VSC-14 | `task-720f81a6917d4490ab3b5a58c2217ccb` | VS Code: read-only Accounts view in the Moe sidebar | VS Code | 4 | VSC-13 | G8, `package.json`, accounts view |
| VSC-15 | `task-357ed3ae786b4477a39840a7b86a88a6` | VS Code: account actions in the Accounts view, matching JetBrains | VS Code | 5 | VSC-14 | G8, `package.json`, accounts view |
| VSC-16 | `task-6fbd08111de142508fb0402d06f24e3f` | Packaging: one bundle manifest shared by the VS Code and JetBrains builds | packaging | 1 | none | G10, `scripts/bundle-manifest.json`, `bundle-assets.mjs`, `build.gradle.kts` |
| VSC-17 | `task-6a0f0be32acb4dc8b3977f32405277a5` | CI: package the VS Code extension on every PR and smoke-test its bundle | CI | 2 | VSC-16 | G11, `.github/workflows/ci.yml` |
| VSC-18 | `task-43363b5db90940cb8760fe6bfa0fe5ad` | Integration and hardening: VS Code parity and plugin-reuse epic | final | last | all 20 other slices | whole-epic gates, D1 manual check |
| VSC-19 | `task-b3daad343a474830a6bd243991d5353d` | JetBrains: shared seat-tracker corpus for AgentSeatTracker | JetBrains corpus | 1 | none | G9, `client-seat-tracker.json` |
| VSC-20 | `task-7fa27666bdb94325b62c205e3599b165` | VS Code: AgentSeatTracker port with seat wiring that passes the shared seat corpus | VS Code | 2 | VSC-19 | G9, seat tracker |
| VSC-21 | `task-7e7bd0ec91ca488da2858f70cff32f65` | VS Code: deregister agent seats whose terminal closed, matching JetBrains | VS Code | 3 | VSC-20, VSC-6, VSC-1 | G9, `extension.ts` |

Notes on the table:

- **Wave 1** is VSC-1, 2, 3, 4, 5, 6, 7, 16 and 19. They have no dependencies and pairwise-disjoint files, so several coders can claim them at once in shared-checkout mode. At writing, VSC-2 and VSC-19 are DONE and VSC-1 is in REVIEW.
- **Serialization-only edges.** VSC-12 depends on VSC-6, and VSC-21 on VSC-6 and VSC-1, only to serialize edits to `MoeDaemonClient.ts` and `extension.ts` in shared-checkout mode. A governor may drop them after the worktree switch, when a shared file stops being a dependency.
- **Shared files by order.** Rows that share `TaskDetailPanel.ts` (VSC-8, 9, 11) or `package.json` (VSC-2, 14, 15) are sequenced by their `order` values.
- **VSC-18** is the single final integration-and-hardening row, the epic's `finalTaskId`. Its `dependsOn` is capped at 20 entries, so it lists the other 20 slices and VSC-0 (this doc) is not in it.
- **Rails.** The epic rails carry the files-to-avoid list and the JetBrains-first gate (`gradlew.bat test` on native Windows under the jetbrains-gradle lease); no slice plans a file on the avoid list.
