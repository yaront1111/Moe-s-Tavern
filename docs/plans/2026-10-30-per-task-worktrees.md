# Per-task git worktrees, landing to main — design

- **Status:** decided (spike task-30066ccdeb6042c3b5c89a7a31833d14). The slices in §8 build against it.
- **Date:** 2026-10-30
- **Epic:** epic-dce3a64f31a44d948f771137a2c0dbed, "Per-task git worktrees: parallel work on shared files, landing to main"
- **Human decision, 2026-10-30:** "everything going to main". The governor's throughput analysis that day found 38 of 49 live rows gated on dependencies, with a longest chain of 16. About 8 of those edges exist only because two tasks share a file. All seats edit one shared checkout, and the wrappers land whole files.

Epic rails (verbatim):

1. Main is only ever updated by a compare-and-swap ref update after the task's gate passes; never force-push or rewrite main's history.
2. Keep scripts/moe-agent.sh and scripts/moe-agent.ps1 in parity; bash scripts/tests/parity-check.sh must pass on every task.
3. The daemon stays the sole writer of .moe/ runtime state; worktrees never contain or write .moe runtime files.
4. Shared-checkout mode keeps working, unchanged, until the epic's final task switches the default.

Vocabulary used throughout:

- **Control checkout:** the project directory the daemon serves (`MOE_PROJECT_PATH`). `.moe/` lives here, along with the IDE project, Serena memories and the seats' wrapper scripts.
- **W:** the task's worktree, `<git top>/.worktrees/<taskId>`.
- **Task branch:** `moe/task/<taskId>`, checked out in W.
- **Target:** the branch a completion lands on (§2). `main` once the epic is rolled out.
- **B / T / M / C:** inside one landing: B is the target tip the landing builds on, T the task-branch tip, M the merged tree, and C the completion commit.

Code citations use `file:function`. Line numbers drift while the wrappers are hot files, so find code by function name or block header.

## 0. Current state

Each row was grep-verified on 2026-10-30 against `moe/work-2026-10-24` @ 9fa1fcb3. The last column says what happens in worktree mode: **kept** (unchanged), **changed** (gains a worktree-mode arm; shared mode keeps today's behavior, per rail 4) or **replaced** (not called in worktree mode).

| # | Mechanism | Code today | Worktree mode |
|---|---|---|---|
| 0.1 | Landing entry points | sh `run_landing`, `preflight_landing`, `teardown_rescue`; ps1 `Invoke-MoeLanding`, `Invoke-MoePreflightBaseline`, `Invoke-MoeRecoveryCheck`, `Invoke-MoeTeardownRescue` | changed (§2, §3) |
| 0.2 | Branch policy | sh `peel_target_branch`, `current_branch_name`, `ensure_safe_branch`; ps1 `Ensure-MoeSafeBranch`. `settings.consolidationBranch` (`types/schema.ts` `ProjectSettings`), whose literal `main`/`master` value is the main-direct opt-in (docs/CONFIGURATION.md) | replaced (§2.7) |
| 0.3 | Completion branch check | `tools/completeTask.ts`: a `currentBranch` that does not match `consolidationBranch` is rejected with `BRANCH-POLICY-FAIL` | changed (§2.8) |
| 0.4 | Plumbing landing | sh `land_commit`, `land_plumbing`, `moe_temp_index_build`, `moe_commit_with_hooks`; ps1 `Build-MoeTempIndexTree`, `New-MoeHookedCommit`. Temp index, then `commit-tree`, then an `update-ref` CAS (3 attempts, then `MOE_COMMIT_FAILED_REF_CONTENTION`) | kept for task-branch commits; replaced for the target by §2's merge, push and CAS |
| 0.5 | Attribution | sh `commit_scope`, `resolve_attribution` (python `denied()`), `baseline_*`; ps1 `Get-MoeCommitScope`, `Resolve-MoeAttribution`, `Test-MoeDenyPath`, the `*-MoeBaseline` helpers; daemon `tools/getCommitScope.ts`, `util/attributionTiers.ts` | the tiers and the baseline are replaced; DENY is kept (§3) |
| 0.6 | Owner guard | sh `landing_owner_guard`; ps1 `Get-MoeOwnerGuard` (`assigneeProtected` from `get_commit_scope`) | kept |
| 0.7 | Frozen gate | sh `freeze_candidate`, `run_frozen_gate`, `cleanup_gate_workspace`, `record_candidate_rpc`, `record_check_run_rpc`; ps1 `New-MoeFrozenCandidate`, `Invoke-MoeFrozenGate`, `Remove-MoeGateWorkspace`. This is already a disposable detached-worktree runner (docs/CONFIGURATION.md "Frozen quality-gate candidates") | kept, and fed the merged tree (§2.2) |
| 0.8 | Rescue refs | sh `rescue_ref`, `rescue_ref_from_commit`, `rescue_frozen_tree`; ps1 `Invoke-MoeRescueRef`. Ref name `refs/moe/rescue/<taskId>/<utc-ts>`, never pushed | kept; new reasons (§2.5) |
| 0.9 | Push | sh `push_branch`, `no_git_remote`; ps1 `Push-MoeBranch`, `Test-MoeNoRemote`. A rejected push is announced and never rebased in the shared checkout | changed (§2.2 step 9) |
| 0.10 | Ledger and receipts | sh `record_commit_rpc`, `receipt_journal_*`, `receipt_replay`; ps1 `Send-MoeRecordCommit`, `Invoke-MoeReceiptReplay`; daemon `tools/recordCommit.ts`, `tools/recordDeliveryReceipt.ts`, `<gitdir>/moe/receipt/<taskId>.json` | kept; the `ref` values change (§3.4) |
| 0.11 | Attempts | `tools/claimNextTask.ts` sets `ExecutionAttempt.workspace = state.projectPath` ("no per-attempt workspace is invented"); `tools/finalizeAttempt.ts` `OUTCOMES = landed, nothing-to-commit, rescued, failed`; `tools/reattachAttempt.ts` | changed (§1.8, §2.5) |
| 0.12 | CLI cwd | sh: `(cd "$PROJECT" && …)` for claude and grok, codex `exec -C <project>`, grok `--cwd "$PROJECT"`. ps1: claude runs in the launcher's cwd with `MOE_PROJECT_PATH` plus a temp `--mcp-config`; the other CLIs run under `Push-Location $projectPath` | changed (§5.1) |
| 0.13 | Per-CLI config writers | claude: `$PROJECT/.mcp.json` plus the `~/.config/claude/mcp_servers.json` merge (sh), a temp `--mcp-config` (ps1); `.codex/config.toml`; `.gemini/settings.json`; `.grok/config.toml` plus `~/.grok/trusted_folders.toml`; the `.moe/agents → .claude/agents` mirror; daemon `util/claudeSkills.ts` links `.claude/skills/<name>` into `.moe/skills/` | changed: written into W (§5.2) |
| 0.14 | Serena | root = `serenaProject` in `<project>/.moe-agent.json`, else `MOE_SERENA_PROJECT`, else the project root. `/.serena/` is gitignored, so the 533 memories exist only in the control checkout's `.serena/memories` | changed (§5.3) |
| 0.15 | Hot reload | the loop-top block compares `MOE_WRAPPER_LAUNCH_HASH` (sh `exec`, ps1 in-process supervisor). task-5998f871 (WORKING, epic-be924fb8) adds the committed-bytes gate `wrapper_reload_deferred` / `Test-MoeWrapperReloadDeferred` (Serena `decision-wrapper-reload-committed-bytes`) | kept; §6 depends on it |
| 0.16 | IDE launcher | `moe-jetbrains/.../util/TerminalAgentLauncher.kt` `resolveAgentScript` (the project's `scripts/` first, else the bundled copy); `selectProtectedAgentRuntime` (bundled only) | kept: it resolves the control checkout's scripts (§6.1) |
| 0.17 | Board records | `settings.commitBoardState` (default on, applied in the wrapper's settings read); the BOARD tier lands the task's own `.moe/tasks/<id>.json`, changed epics, `project.json` and non-live peers' records. 590 `.moe/tasks/*.json` are tracked; `.gitignore` covers the runtime subset | replaced in worktree mode (§4) |
| 0.18 | Daemon Git reads | `util/diskState.ts` (`git status --porcelain=v2 --branch` fingerprint); `util/cachedPlanPaths.ts` (pinned `refs/remotes/origin/<consolidationBranch>`) | kept (the branch is the target, §2.7) |
| 0.19 | Daemon watcher | `state/FileWatcher.ts` watches `.moe/` only (depth 1) | unaffected by `.worktrees/` |
| 0.20 | Paths already reserved | `.gitignore` has `.worktrees/` and `/.serena/`; DENY has `.worktrees/**` and `.moe-worktree*` (sh `denied()`, ps1 `Test-MoeDenyPath`) | kept (it is why W lives there, §1.1) |
| 0.21 | Mods | `scripts/mods/moe-compaction-keeper` and `moe-account-switch` read `.moe/` through `MOE_PROJECT_PATH` (falling back to `.`) | kept: `MOE_PROJECT_PATH` stays the control checkout |
| 0.22 | Delivery-path invariant | docs/ARCHITECTURE.md "Delivery Path": the daemon is state-only and never writes git state; the wrapper is the only Git-write actor | kept: every git write below is a wrapper's |

Measured facts the decisions rely on:

- Git is 2.43.0 in WSL and 2.54.0.windows.1 on Windows. `git merge-tree --write-tree` needs 2.38 or later, so both qualify.
- The tracked tree is 1620 files and 31 MB. The longest tracked path is 101 characters.
- `node_modules` is 115 MB (daemon), 93 MB (proxy) and 73 MB (claude-plugin). There are no npm workspaces.
- This project sets no `qualityGate`, so no landing here runs a gate today. `consolidationBranch` is unset, so the peel reuses `moe/work-2026-10-24`.
- `.claude/` is gitignored as a whole, so `.claude/skills` and `.claude/agents` exist only in the control checkout.
