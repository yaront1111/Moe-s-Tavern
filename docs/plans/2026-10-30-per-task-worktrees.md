# Per-task git worktrees, landing to main — design

- **Status:** decided (spike task-30066ccdeb6042c3b5c89a7a31833d14), revised after QA reject 1. The revision adds fail-closed publication (§2.3, §2.6), `.moe/`-free gate worktrees (§2.2 L6, §1.6) and a gated migration landing (§7.3). The slices in §8 build against it.
- **Date:** 2026-10-30
- **Epic:** epic-dce3a64f31a44d948f771137a2c0dbed, "Per-task git worktrees: parallel work on shared files, landing to main"
- **Human decision, 2026-10-30:** "everything going to main". That day 38 of 49 live rows were gated on dependencies (longest chain 16), and about 8 of those edges exist only because two tasks share a file: every seat edits one shared checkout, and the wrappers land whole files.

Epic rails (verbatim):

1. Main is only ever updated by a compare-and-swap ref update after the task's gate passes; never force-push or rewrite main's history.
2. Keep scripts/moe-agent.sh and scripts/moe-agent.ps1 in parity; bash scripts/tests/parity-check.sh must pass on every task.
3. The daemon stays the sole writer of .moe/ runtime state; worktrees never contain or write .moe runtime files.
4. Shared-checkout mode keeps working, unchanged, until the epic's final task switches the default.

Vocabulary:

- **Control checkout:** the project directory the daemon serves (`MOE_PROJECT_PATH`). `.moe/`, the IDE project, the Serena memories and the seats' wrapper scripts live here.
- **W:** the task's worktree, `<git top>/.worktrees/<taskId>`, on its **task branch** `moe/task/<taskId>`.
- **Target:** the branch a completion lands on (§2.7). It is `main` once the epic is rolled out.
- **Remote mode / local mode:** in remote mode the repository has a remote. Local mode means git positively reports none (sh `no_git_remote` / ps1 `Test-MoeNoRemote`); a failed probe counts as remote mode.
- **B / T / M / C:** inside one landing, B is the target tip it builds on, T the task-branch tip, M the merged tree and C the completion commit.

Code citations use `file:function`. Line numbers drift while the wrappers are hot files.

## 0. Current state

Each row was grep-verified on 2026-10-30 against `moe/work-2026-10-24`, and re-checked against HEAD 9a5426ac for this revision. The last column says what happens in worktree mode: **kept** (unchanged), **changed** (gains a worktree-mode arm; shared mode keeps today's behavior, rail 4) or **replaced** (not called in worktree mode).

| # | Mechanism | Code today | Worktree mode |
|---|---|---|---|
| 0.1 | Landing entry points | sh `run_landing`, `preflight_landing`, `teardown_rescue`; ps1 `Invoke-MoeLanding`, `Invoke-MoePreflightBaseline`, `Invoke-MoeRecoveryCheck`, `Invoke-MoeTeardownRescue` | changed (§2, §3) |
| 0.2 | Branch policy | sh `peel_target_branch`, `current_branch_name`, `ensure_safe_branch`; ps1 `Ensure-MoeSafeBranch`. `settings.consolidationBranch` (`types/schema.ts` `ProjectSettings`); a literal `main`/`master` value is the main-direct opt-in (docs/CONFIGURATION.md) | replaced (§2.7) |
| 0.3 | Completion branch check | `tools/completeTask.ts` rejects a `currentBranch` that does not match `consolidationBranch` with `BRANCH-POLICY-FAIL` | changed (§2.8) |
| 0.4 | Plumbing landing | sh `land_commit`, `land_plumbing`, `moe_temp_index_build`, `moe_commit_with_hooks`; ps1 `Build-MoeTempIndexTree`, `New-MoeHookedCommit`. Temp index, `commit-tree`, then an `update-ref` CAS (3 attempts, then `MOE_COMMIT_FAILED_REF_CONTENTION`). The hooked commit runs hooks from a `--no-checkout` private worktree, with `GIT_WORK_TREE` set to the shared checkout | kept for task-branch commits. The target moves by §2's merge, publish and mirror steps, and the hook work tree changes (§2.2 L7) |
| 0.5 | Attribution | sh `commit_scope`, `resolve_attribution` (python `denied()`), `baseline_*`; ps1 `Get-MoeCommitScope`, `Resolve-MoeAttribution`, `Test-MoeDenyPath`, the `*-MoeBaseline` helpers; daemon `tools/getCommitScope.ts`, `util/attributionTiers.ts` | tiers and baseline replaced; DENY kept (§3) |
| 0.6 | Owner guard | sh `landing_owner_guard`; ps1 `Get-MoeOwnerGuard` (`assigneeProtected` from `get_commit_scope`) | kept |
| 0.7 | Frozen gate | sh `freeze_candidate`, `run_frozen_gate`, `gate_integrity`, `cleanup_gate_workspace`, `record_candidate_rpc`, `record_check_run_rpc`; ps1 `New-MoeFrozenCandidate`, `Invoke-MoeFrozenGate`, `Test-MoeGateIntegrity`, `Remove-MoeGateWorkspace`. Each gate run gets a disposable detached worktree of the frozen commit (docs/CONFIGURATION.md "Frozen quality-gate candidates"), added with `core.sparseCheckout=false`. It therefore materializes every tracked path, `.moe/tasks` included. The integrity helper clears every skip-worktree bit, then requires a clean `diff-files` | changed: it gates the merged tree and gains a `.moe/`-free worktree arm (§2.2 L6) |
| 0.8 | Rescue refs | sh `rescue_ref`, `rescue_ref_from_commit`, `rescue_frozen_tree`; ps1 `Invoke-MoeRescueRef`. Ref name `refs/moe/rescue/<taskId>/<utc-ts>`, never pushed | kept, with new reasons (§2.5, §2.6) |
| 0.9 | Push | sh `push_branch`; ps1 `Push-MoeBranch`. A failed push is announced and the commit stays local; nothing is rebased in the shared checkout | changed (§2.2 L9) |
| 0.10 | Ledger and receipts | sh `record_commit_rpc`, `receipt_journal_*`, `receipt_replay` (whose `receipt_landed_as` checks containment in the **local** target only); ps1 `Send-MoeRecordCommit`, `Invoke-MoeReceiptReplay`; daemon `tools/recordCommit.ts`, `tools/recordDeliveryReceipt.ts`, `<gitdir>/moe/receipt/<taskId>.json` | kept. The `ref` values change (§3.4), and replay fetches first (§2.6) |
| 0.11 | Attempts | `tools/claimNextTask.ts` sets `ExecutionAttempt.workspace = state.projectPath` ("no per-attempt workspace is invented"); `tools/finalizeAttempt.ts` `OUTCOMES = landed, nothing-to-commit, rescued, failed`; `tools/reattachAttempt.ts` | changed (§1.8, §2.5) |
| 0.12 | CLI cwd | sh: `(cd "$PROJECT" && …)` for claude and grok, codex `exec -C <project>`, grok `--cwd "$PROJECT"`. ps1: claude runs in the launcher's cwd with `MOE_PROJECT_PATH` plus a temp `--mcp-config`; the other CLIs run under `Push-Location $projectPath` | changed (§5.1) |
| 0.13 | Per-CLI config writers | claude: `$PROJECT/.mcp.json` plus the `~/.config/claude/mcp_servers.json` merge (sh), a temp `--mcp-config` (ps1); `.codex/config.toml`; `.gemini/settings.json`; `.grok/config.toml` plus `~/.grok/trusted_folders.toml`; the `.moe/agents → .claude/agents` mirror; daemon `util/claudeSkills.ts` links `.claude/skills/<name>` into `.moe/skills/` | changed: written into W (§5.2) |
| 0.14 | Serena | root = `serenaProject` in `<project>/.moe-agent.json`, else `MOE_SERENA_PROJECT`, else the project root. `/.serena/` is gitignored, so the memories exist only in the control checkout's `.serena/memories` | changed (§5.3) |
| 0.15 | Hot reload | the loop-top block compares `MOE_WRAPPER_LAUNCH_HASH` (sh `exec`, ps1 in-process supervisor). task-5998f871 (epic-be924fb8, landed in 9a5426ac) adds the committed-bytes gate `wrapper_reload_deferred` / `Test-MoeWrapperReloadDeferred` (Serena `decision-wrapper-reload-committed-bytes`) | kept; §6 depends on it |
| 0.16 | IDE launcher | `moe-jetbrains/.../util/TerminalAgentLauncher.kt` `resolveAgentScript` (the project's `scripts/` first, else the bundled copy); `selectProtectedAgentRuntime` (bundled only) | kept: it resolves the control checkout's scripts (§6.1) |
| 0.17 | Board records | `settings.commitBoardState` (default on). The BOARD tier lands the task's own `.moe/tasks/<id>.json`, changed epics, `project.json` and non-live peers' records. 618 `.moe/tasks/*.json` are tracked; `.gitignore` covers the runtime subset | replaced (§4) |
| 0.18 | Daemon Git reads | `util/diskState.ts` (`git status --porcelain=v2 --branch` fingerprint); `util/cachedPlanPaths.ts` (pinned `refs/remotes/origin/<consolidationBranch>`) | kept (the branch is the target, §2.7) |
| 0.19 | Unaffected readers | `state/FileWatcher.ts` watches `.moe/` only (depth 1); the mods `scripts/mods/moe-compaction-keeper` and `moe-account-switch` read `.moe/` through `MOE_PROJECT_PATH`, falling back to `.` | kept: `MOE_PROJECT_PATH` stays the control checkout |
| 0.20 | Paths already reserved | `.gitignore` has `.worktrees/` and `/.serena/`; DENY has `.worktrees/**` and `.moe-worktree*` (sh `denied()`, ps1 `Test-MoeDenyPath`) | kept, which is why W lives there (§1.1) |
| 0.21 | Delivery-path invariant | docs/ARCHITECTURE.md "Delivery Path": the daemon is state-only and never writes git state, and the wrapper is the only Git-write actor | kept: every git write below is a wrapper's |

Measured facts the decisions rely on:

- Git is 2.43.0 in WSL and 2.54.0.windows.1 on Windows. `git merge-tree --write-tree` (2.38) and `fetch --no-write-fetch-head` (2.29) are available on both.
- The tracked tree is 1654 files and 31 MB. The longest tracked path is 101 characters.
- `node_modules` is 115 MB (daemon), 93 MB (proxy) and 73 MB (claude-plugin). There are no npm workspaces.
- This project sets no `qualityGate` (`qualityGateScope` defaults to `epicFinal`), so no landing here runs a gate today. `consolidationBranch` is unset, so the peel reuses `moe/work-2026-10-24`.
- `.claude/` is gitignored as a whole, so `.claude/skills` and `.claude/agents` exist only in the control checkout.

## 1. Worktree location and lifecycle

**Decision.**
1. **Path.** W = `<git top>/.worktrees/<taskId>`, using the full task id. Worktree mode requires the Moe project to be its repository's top level (the wrapper's `MOE_REL` is empty), so the daemon can compute W as `<projectPath>/.worktrees/<taskId>` and every CLI's cwd is W itself. Otherwise a worker seat stops before landing anything with `MOE_WORKTREE_PROJECT_NOT_TOP` (`report_blocked`); nested projects are a known ceiling of this epic. `.worktrees/` is already gitignored and in DENY (§0.20), so a shared-mode seat can never land a W. A full id (37 characters) plus the longest tracked path (101) stays well under 260; on Windows, a W whose absolute path plus 101 would pass 240 characters is refused with `MOE_WORKTREE_PATH_TOO_LONG` unless `core.longpaths` is true.
2. **Branch.** `moe/task/<taskId>`. Its **base** is a commit the target's authority holds: in remote mode `refs/remotes/origin/<target>` after one L4 fetch (§2.2; as last fetched when that fetch fails), in local mode the local target. A stale base is safe, because every landing merges onto a fresh tip.
3. **Who gets one.** Only a **worker** seat holding a WORKING claim. Architect, QA and governor seats stay in the control checkout. QA reviews the landed commit (§2.1); it never needs W.
4. **Creation** happens at the worker pre-flight, after the claim and `get_context` preload, before the CLI launch: `git -C <top> worktree add --lock --reason "moe <taskId>" --no-checkout --no-track -b moe/task/<taskId> W <base>`, then `git -C W sparse-checkout set --no-cone '/*' '!/.moe/'`, then `git -C W read-tree -mu HEAD`. The sparse pattern keeps every `.moe/` path out of W (rail 3). `sparse-checkout set` inside a worktree enables `extensions.worktreeConfig`, so the pattern is per-W and the control checkout stays a full checkout. `--lock` stops a `git worktree prune` from another OS (where W's recorded path does not resolve) from dropping it.
5. **Reuse.** A later session of the same task finds W in `git worktree list --porcelain` (paths normalized: `D:\x` and `/mnt/d/x` compare equal, as the proxy already does). If the recorded path is the other OS's spelling, the wrapper runs `git worktree repair W` first. A registered W is reused as is, dirt included (§3.3 recovers it).
6. **`.moe/` guard, fail closed.** After creation or reuse, `W/.moe` must not exist (a link counts). If it does, the pre-flight prints `MOE_WORKTREE_MOE_PRESENT`, launches no CLI, deletes and commits nothing (not even §3.3's recovery) and calls `report_blocked` with the code, so W waits for a human. A post-flight that finds it still lands, because DENY keeps `.moe/**` out of every commit (§3) and L5b checks M, and prints the code; the next pre-flight then blocks. Removal and the sweep skip such a W (1.7, 1.9). The daemon never learns of W's path for writing; `MOE_PROJECT_PATH` stays the control checkout (§5.1).
7. **Removal.** The **QA wrapper's post-flight**, after `qa_approve` leaves the task DONE, removes W and deletes the task branch when the branch is fully landed, W holds no non-DENY dirt and `W/.moe` does not exist; otherwise it leaves W to the **orphan sweep** (1.9), which owns everything else. "Fully landed" is one test, sh `task_branch_landed` / ps1 `Test-MoeTaskBranchLanded`: `git merge-tree --write-tree refs/heads/<target> moe/task/<taskId>` exits 0 and prints the target's own tree, so merging the branch into the target would change nothing. Ancestry cannot be the test: a completion lands as a new commit on B (§2.2), so T is never an ancestor of the target and `git branch -d` would refuse. The branch is deleted with `-D`, only after this test passes or a rescue ref holds T.
8. **Attempt record.** The claim records the mode and path on the attempt: `ExecutionAttempt.workspaceMode` (`'shared' | 'worktree'`) and `ExecutionAttempt.workspace` = W (it is `state.projectPath` today, §0.11). This pins the mode per task (§7.2).
9. **Orphan sweep.** Any wrapper (any role) runs it at its loop top, at most once per `MOE_WORKTREE_SWEEP_INTERVAL_SEC` (default 3600), under a `mkdir` lock `<gitdir>/moe/worktree/sweep.lock` (stale after 2 h), handling at most 5 worktrees per pass. Candidates are registered worktrees under `.worktrees/` whose task is DONE, ARCHIVED or unknown to the daemon, with no open attempt and no `W/.moe`. Per candidate:
   - Non-DENY dirt in W is committed onto a rescue ref first, and a task branch that is not fully landed gets a rescue ref on its tip (both reason `worktree-orphan`). Unlanded commits are never deleted without one.
   - Then the links are removed (1.10), then `git worktree unlock W` and `git worktree remove --force --force W`, then `git branch -D moe/task/<taskId>`.
   - A directory under `.worktrees/` that git does not list is never deleted: `MOE_WORKTREE_UNREGISTERED`, one `#general` alert per path per day.
10. **Links and Windows removal.** Every link the wrapper makes inside W (§5) is recorded in a manifest, `<gitdir>/moe/worktree/<taskId>.links`, one W-relative path per line. Removal unlinks each one first (sh `rm -- <link>`, ps1 `cmd /c rmdir <link>` for a junction, which removes the junction and never its target), verifies the link is gone, and only then runs `worktree remove`. A `--force` remove that recursed into a junction would delete the control checkout's `.serena/memories` or `.claude/skills`.

**Rejected alternatives.**
- **W outside the repository** (`../<repo>.worktrees/<id>` or a temp dir). It needs a new ignore story for every tool and a path outside the IDE project, and it breaks `/mnt/d` ↔ `D:\` sharing for WSL seats. `.worktrees/` is already reserved.
- **A worktree per session.** It throws away a task's WIP between sessions and re-provisions tooling (§5) every time.
- **Worktrees for QA and architects.** QA reviews landed bytes, and the architect writes nothing but board state. Both would add disk and sweep load for nothing.
- **Excluding `.moe/` with `skip-worktree` bits** instead of sparse checkout. `read-tree -mu`, `reset --hard` and checkout clear those bits and re-materialize the files. A sparse pattern survives them.
- **Warning on `W/.moe` and launching anyway** (the first draft). Rail 3 forbids a worktree that holds `.moe/` files, and a launched seat could keep writing them. Deleting them is no better: they may be the only copy of someone's bytes.
- **Removing W at the worker's completion exit.** QA may reject and send the task back, and the next session would rebuild W and its tooling. DONE is the first moment the bytes are final.

**Code paths replaced.** None in shared mode (rail 4). In worktree mode, `preflight_landing` / `Invoke-MoePreflightBaseline` (§0.1) gain the create/reuse arm, and `claimNextTask.ts` stops hard-coding `workspace = state.projectPath` (§0.11).

**Assumed interfaces.**
- Path `<git top>/.worktrees/<taskId>`; branch `moe/task/<taskId>`; sparse pattern `'/*' '!/.moe/'`.
- `ExecutionAttempt.workspaceMode: 'shared' | 'worktree'`; `ExecutionAttempt.workspace` = W in worktree mode.
- `<gitdir>/moe/worktree/<taskId>.links` (link manifest) and `<gitdir>/moe/worktree/sweep.lock` (sweep lock directory); env `MOE_WORKTREE_SWEEP_INTERVAL_SEC` (default 3600).
- Helper sh `task_branch_landed` / ps1 `Test-MoeTaskBranchLanded`; rescue reason `worktree-orphan`.
- Log codes `MOE_WORKTREE_PROJECT_NOT_TOP`, `MOE_WORKTREE_PATH_TOO_LONG`, `MOE_WORKTREE_CREATE_FAILED`, `MOE_WORKTREE_MOE_PRESENT`, `MOE_WORKTREE_UNREGISTERED`, `MOE_WORKTREE_REMOVE_REFUSED`.

**Error handling.**
- `worktree add`, `sparse-checkout set`, `read-tree` or a cross-OS `worktree repair` fails, or remote mode has no `refs/remotes/origin/<target>` to cut from: `MOE_WORKTREE_CREATE_FAILED` with git's stderr. The wrapper removes a half-made W only if `worktree list` shows it and it holds no commits beyond its base, launches no CLI and calls `report_blocked`. It never falls back to the shared checkout: the attempt is pinned to worktree mode.
- The branch exists but no W is registered (a removed or lost W): W is re-added on the existing branch (`worktree add --lock --no-checkout W moe/task/<taskId>`, no `-b`, then the same sparse and `read-tree` steps), so no commit is lost.
- `W/.moe` exists: 1.6. Nothing is deleted and nothing launches.
- An unlink fails, a link survives it, or `worktree remove` fails (a locked file on Windows): `MOE_WORKTREE_REMOVE_REFUSED`; W stays registered, the branch is kept, and the sweep retries next pass.
- The sweep lock is held, or the daemon cannot be queried for a candidate's task: skip this pass, never wait. An RPC failure never counts as "unknown to the daemon".

## 2. Landing to main

**Decision.**
**2.1 When.** A task lands at the worker's completion exit, as today: the worker calls `complete_task`, the CLI exits, and the post-flight lands. QA therefore reviews a commit that is already on the target, `NO-COMPLETION-COMMIT` keeps its meaning, and `finalize_attempt` still closes the attempt.

**2.2 Sequence.** sh `run_landing` / ps1 `Invoke-MoeLanding` gain a worktree arm. Steps L4-L9 form one **round** (2.3).

| Step | Action |
|---|---|
| L0 | Owner guard (`landing_owner_guard` / `Get-MoeOwnerGuard`), unchanged. |
| L1 | Dirty set of W: `git -C W status --porcelain=v1 -z --untracked-files=all`, minus DENY (§3). |
| L2 | **Task-branch commit.** A temp index read from T, the dirty paths applied with literal pathspecs, `write-tree`, `commit-tree -p T` (plus `-p MERGE_HEAD` only on a completion that passed the marker check, 2.5), then `update-ref refs/heads/moe/task/<taskId> <new> T`, then `git -C W reset -q` so W's own index matches. Afterwards T names the new tip. An empty dirty set skips L2. |
| L3 | **Lease**, on every completion landing while `settings.qualityGate` is set, whether or not this landing's scope runs the gate (with no `qualityGate`, no lease call is made): `acquire_resource` on `git-land-<target>` (the target with every character outside `[A-Za-z0-9._-]` replaced by `-`, cut to 64 characters to fit `RESOURCE_ID_RE`), then `wait_for_resource` until granted, bounded by `MOE_LAND_LEASE_WAIT_SEC` (default 1800). It keeps an ungated peer of this daemon from publishing while a gated landing gates; safety never depends on it (2.3). |
| L4 | **`sync_land_target`** (sh) / **`Sync-MoeLandTarget`** (ps1). Local mode: B = the local target. Remote mode: read the local target as L first, then `git fetch --no-write-fetch-head origin refs/heads/<target>:refs/remotes/origin/<target>` (no `+`), up to 3 tries `MOE_LAND_NET_BACKOFF_SEC` apart, then B = `refs/remotes/origin/<target>`, never the local target. An L that is not an ancestor of B holds commits the remote lacks: `MOE_LAND_TARGET_DIVERGED`. Mirrors only move the local target to commits the remote already held, so a peer's mirror during the fetch cannot fake a divergence. Otherwise the local target is mirrored to B (L10's rule). |
| L5 | **Merge.** `git merge-tree --write-tree -z --name-only B T`. Exit 0 gives M; exit 1 is a conflict (the names follow); anything else fails. M equal to B's tree means nothing is left to land (2.9). This is a squash-rebase: the task's net change replayed onto B as one commit. |
| L5b | **Board guard.** `git diff-tree --quiet B^{tree} M -- .moe` must be clean, else `MOE_WORKTREE_BOARD_PATH` (`failed`, with rescue). W never holds `.moe/` (§1.6), so this only fires on a bug. |
| L6 | **Gate**, when one will run: the existing `freeze_candidate B M` and `run_frozen_gate` (`New-MoeFrozenCandidate`, `Invoke-MoeFrozenGate`) on exactly the tree that will land, with a worktree arm for rail 3 (shared mode keeps today's full checkout, rail 4). The gate worktree is added `--no-checkout`, never with `core.sparseCheckout=false`, then gets 1.4's sparse pattern and `read-tree -mu HEAD`, so no `.moe/` path is materialized. Its integrity helper, sh `gate_integrity_wt` / ps1 `Test-MoeGateIntegrityWorktree`, keeps today's HEAD and `write-tree` checks, clears assume-unchanged and skip-worktree bits only outside `.moe/`, requires a clean `diff-files`, and fails with `MOE_WORKTREE_GATE_INTEGRITY` when `<gate>/.moe` exists before or after the command. The command still runs with `MOE_PROJECT_PATH` = the gate worktree. |
| L7 | **Completion commit.** C = `commit-tree M -p B` with today's message and trailers. With `commitHooks` true, the hooked-commit helper (`moe_commit_with_hooks` / `New-MoeHookedCommit`) runs the hooks with `GIT_WORK_TREE` set to a disposable detached worktree that materializes M under the same sparse pattern (the temp index marks `.moe/` skip-worktree), instead of the shared checkout. Its existing check, which refuses publication when a hook changed the validated tree or parent, keeps every published tree the gated M. |
| L8 | **Receipt journal** (`receipt_journal_write`), naming C, B and the target, before anything is published. |
| L9 | **Publish.** Local mode: `git update-ref refs/heads/<target> C B`; after a lost CAS, a target that contains C is success and anything else ends the round. Remote mode: `git push --porcelain origin C:refs/heads/<target>`, never with any force flag; C's only parent is B, so the remote accepts it only while its target is B or behind it. The flag on the target's line decides: ` `, `*` or `=` is published; `!` is rejected (someone landed first) and ends the round; anything else, a transport error or no line at all, goes to `reconcile_push` / `Resolve-MoePushOutcome` (2.6). `MOE_PUSH_REBASE` is ignored in worktree mode. |
| L10 | **Mirror** (remote mode, after a confirmed publication): `update-ref refs/heads/<target> C <old>`, re-reading `<old>` after a lost CAS, while `<old>` is an ancestor of C; a local target that already contains C needs nothing. A mirror that cannot fast-forward prints `MOE_LAND_MIRROR_SKIPPED` and never fails the landing: C is published, and the next L4 reports the divergence. |
| L11 | **Sync the task branch.** T' = `commit-tree <tree of C> -p T -p C`, then `git -C W -c core.hooksPath=<empty dir> merge --ff-only T'`. The task branch stays fast-forward-only (pushable without force) and contains C, so a reopened task merges from C onward. |
| L12 | `record_commit` (kind `completion`, sha C, ref `refs/heads/<target>`, paths = `git diff --name-only B C`; `pushed: true` only for a publication the remote confirmed, `false` in local mode), then `finalize_attempt` `landed` with landedRevision C. |
| L13 | Control-checkout follow (§6). |
| L14 | Release the L3 lease, also on every failure path and in the exit trap. |

**2.3 Publication and contention.** In remote mode the remote target is the only authority and a non-forced push the only publication point. The local target is a mirror that moves only to commits the remote is known to hold (L4, L10, 2.6): no failed or unconfirmed push ever moves it, and no landing falls back to a local CAS. In local mode the L9 CAS is the publication. A round ends early on a rejected push, a lost local CAS, or a reconcile that proves C absent. A landing runs at most 3 rounds without a gate and 2 with one (each round re-gates the new merge). Exhausting them prints `MOE_COMMIT_FAILED_REF_CONTENTION` and takes the unlanded route with reason `contention`, or `remote` when the last round ended on a transport failure. With a `qualityGate` set, the lease serializes every lander of this project (all share one daemon), so only landers outside this daemon cost a gated landing its rounds. Without one, landers race and the CAS or the push picks the winner, which is safe: QA's race ends without a fork either way (WT-08T). The runbook (§7.3) declares it with `releaseOnDeregister: true` and `maxLeaseMs` 7200000; it guards no dirty host state.

**2.4 Checkpoints.** A non-completion exit runs only L0-L2: the bytes go to the task branch, never to the target. When `checkpointPush` is on, the task branch is pushed with `git push origin moe/task/<taskId>` (no force; L11 keeps it fast-forward). A rejected or failed checkpoint push is announced and changes nothing.

**2.5 The unlanded route** is taken only when nothing was published: a conflict (L5), a gate failure (L6), a diverged target or a failed fetch (L4), or exhausted rounds whose every push was rejected or proven absent.
- `record_commit` records `outcome: failed`, kind `completion`, never `pushed: true`, with the code (`MOE_COMMIT_FAILED_CONFLICT`, `MOE_COMMIT_FAILED_GATE`, `MOE_LAND_TARGET_DIVERGED`, `MOE_LAND_FETCH_FAILED`, `MOE_PUSH_FAILED` or `MOE_COMMIT_FAILED_REF_CONTENTION`). T also gets a rescue ref with the reason (`conflict`, `gate`, `diverged`, `remote`, `contention`), so every parked landing appears in the governor's `MOE_RESCUE_REF` view even though the task branch holds the bytes.
- The wrapper calls `finalize_attempt { outcome: 'unlanded', landedRevision: null, unlandedReason, conflictPaths, rescueRef }`. The new outcome joins today's four.
- The daemon moves the task out of REVIEW: to WORKING, unassigned, `reopenCount` unchanged, or to BLOCKED for `diverged` and from the third consecutive unlanded finalize on (a human reconciles). It sets `Task.landingRetry = { reason, paths, rescueRef, targetTip, count, at }`, posts a task comment, and clears `landingRetry` on the next `landed` finalize.
- **Who resolves it:** the next worker that claims the row. Its pre-flight runs `git -C W -c core.hooksPath=<empty dir> merge --no-commit --no-ff <base>` (base per §1.2) and starts the prompt with `LANDING-CONFLICT: <paths>` (markers in W, MERGE_HEAD set) or `LANDING-RETRY: <reason>` (a clean merge). The worker edits files only: no git commands, no new plan. It removes the markers, re-runs the plan's verification command and calls `complete_task`.
- **Marker check.** Before L2 on a completion with MERGE_HEAD set, the wrapper scans `landingRetry.paths` plus `git -C W diff --name-only --diff-filter=U` for lines starting with `<<<<<<< `, `>>>>>>> ` or equal to `=======`. Any hit prints `MOE_WORKTREE_UNRESOLVED_CONFLICT` and takes the unlanded route again (reason `conflict`). A clean scan commits with MERGE_HEAD as a second parent, then runs `git -C W merge --quit`. A checkpoint during a pending merge commits with one parent and leaves MERGE_HEAD in place, so unresolved markers can never ride a two-parent commit into a landing.

**2.6 Unknown outcomes and teardown.** `reconcile_push` / `Resolve-MoePushOutcome` waits `MOE_LAND_NET_BACKOFF_SEC` (default 5) and repeats L4's fetch. If `refs/remotes/origin/<target>` now contains C, C is published (the server applied it after the client failed): continue at L10. If the fetch succeeds without C, the push failed (`MOE_PUSH_FAILED`) and the round ends. If the fetch fails, the outcome is **unknown**: the wrapper prints `MOE_PUSH_OUTCOME_UNKNOWN`, moves no ref, sends no completion row and no `finalize_attempt`, keeps the receipt journal (push result `push unknown: <detail>`, so a replayed row omits `pushed`) and puts C on a rescue ref with reason `push-unknown`. The attempt stays `finalizing`, so claims, `qa_approve` and DONE refuse with `ATTEMPT_FINALIZING` until the outcome is known.
A signal before L9 abandons the landing, which has published nothing; a signal during L9-L12 is deferred until L12 returns. Every pre-flight runs `receipt_replay` / `Invoke-MoeReceiptReplay` over every journal. Its worktree arm fetches first and runs the unchanged `receipt_landed_as` against `refs/remotes/origin/<target>` instead of the local target (§0.10): contained means mirror (L10) and close as today; fetched but absent means drop the journal and, for an attempt still `finalizing`, re-run L4-L12 in W (2.9); a failed fetch keeps both for the next pre-flight. A seat that never returns falls to today's dead-worker reconcile.

**2.7 Target and branch policy.** The target is `settings.consolidationBranch` when it is a literal branch name (no `*`, `?` or `[`), else `main`. In worktree mode `peel_target_branch` and `ensure_safe_branch` / `Ensure-MoeSafeBranch` are not called (W sits on its task branch, the control checkout on `moe/control`, §6); "never commit on main" is retired, because main moves only through L9 after L6; the `moe/work-<date>` branch is retired (§7); and a target checked out in any worktree (`git worktree list --porcelain`) refuses the landing with `MOE_LAND_TARGET_CHECKED_OUT`, because an `update-ref` would strand that checkout's files. Shared mode keeps all of today's branch policy (rail 4).

**2.8 completeTask.** When the task's attempt is `workspaceMode: 'worktree'`, `checkBranchPolicy` in `completeTask.ts` expects `currentBranch` to be `moe/task/<taskId>` and fails with `BRANCH-POLICY-FAIL` naming that branch otherwise. A missing `currentBranch` keeps today's warning path. Shared mode is unchanged.

**2.9 Crash safety.** Re-landing is idempotent. If C already reached the target, a re-run's L5 merges T into a B that contains C, and M equals B's tree: nothing is left to land. L12 then records what `receipt_landed_as` finds for the journaled C (C itself, or the commit after the journaled B that carries C's `Moe-Session` and `Moe-Kind: completion` trailers); without a journal, or when it finds nothing, the outcome is `nothing`. A crash between L9 and L10 heals at the next L4 of any lander or at the next replay (2.6).

**Rejected alternatives.**
- **Landing on `qa_approve`.** The QA wrapper would land bytes another seat produced, which the owner guard forbids; a conflict found after approval would land a merge QA never reviewed; and `NO-COMPLETION-COMMIT` and the finalizing hold would need new meanings.
- **A local CAS when the fetch or push fails** (the first draft). QA reproduced the fork it allows: A pushed C1, B's fetch and push failed, B moved local main from B0 to C2, and local and remote main diverged. A transport error proves nothing about the remote, so it may only end a round or leave the outcome unknown.
- **A local CAS before the push.** If the push then lost, local main would hold a commit the remote rejected.
- **The lease only on a landing that runs the gate** (the first draft). An ungated peer could publish during every gate and cost the gated landing each of its rounds. **The lease even with no `qualityGate` set**: safety never needs it, and a project without a gate would have to declare a resource just to land.
- **`git rebase` or per-wip `cherry-pick` inside W.** Every checkpoint can conflict on its own, a crash leaves `rebase-merge` state behind, and a rewritten task branch would need a force push. `merge-tree` touches no working tree and is atomic.
- **Merge commits on main.** History would carry every wip checkpoint, and `git log --first-parent main` would no longer be one commit per task.
- **`--force-with-lease`** for the push. It is a strict CAS, but it is a force flag, and rail 1 forbids force pushes. A plain push already rejects a remote that moved.
- **A per-machine file lock instead of the lease.** It would not cover WSL and Windows seats as one queue; the daemon lease does.
- **The gate in a full checkout** (today's `core.sparseCheckout=false`) in worktree mode. It materializes the tracked `.moe/tasks` records in a worktree, against rail 3.

**Code paths replaced.** In worktree mode only: `land_commit` / `land_plumbing` targeting the shared branch (§0.4), `peel_target_branch` and `ensure_safe_branch` / `Ensure-MoeSafeBranch` (§0.2), and `push_branch` / `Push-MoeBranch` for completions (§0.9; checkpoints still use it, against the task branch). Changed by a worktree arm: `run_frozen_gate` / `Invoke-MoeFrozenGate` and its integrity helper (§0.7), the hooked-commit helpers' work tree (§0.4), `receipt_replay` / `Invoke-MoeReceiptReplay` (§0.10), `completeTask.ts` `checkBranchPolicy` (§0.3) and `finalizeAttempt.ts` `OUTCOMES` (§0.11). Kept: `moe_temp_index_build` / `Build-MoeTempIndexTree` (L2), `freeze_candidate`, `receipt_landed_as`, `rescue_ref` / `Invoke-MoeRescueRef`, `record_commit_rpc` and `finalize_attempt_rpc`.

**Assumed interfaces.**
- Target: literal `settings.consolidationBranch`, else `main`. Remote `origin`; tracking ref `refs/remotes/origin/<target>`.
- Helpers sh `sync_land_target`, `reconcile_push`, `gate_integrity_wt`; ps1 `Sync-MoeLandTarget`, `Resolve-MoePushOutcome`, `Test-MoeGateIntegrityWorktree`.
- Lease resource `git-land-<target>`; env `MOE_LAND_LEASE_WAIT_SEC` (default 1800) and `MOE_LAND_NET_BACKOFF_SEC` (default 5).
- `finalize_attempt` outcome `unlanded`, with `unlandedReason: 'conflict' | 'contention' | 'gate' | 'diverged' | 'remote'`, `conflictPaths: string[]` and `rescueRef: string`; `Task.landingRetry: { reason, paths, rescueRef, targetTip, count, at } | null`.
- Prompt prefixes `LANDING-CONFLICT:` and `LANDING-RETRY:`. Rescue reasons: the five unlanded reasons and `push-unknown`. Journal push result `push unknown: <detail>`.
- `completeTask` worktree branch `moe/task/<taskId>`.
- Log codes `MOE_COMMIT_FAILED_REF_CONTENTION` and `MOE_COMMIT_FAILED_GATE` (existing), and new: `MOE_COMMIT_FAILED_CONFLICT`, `MOE_COMMIT_FAILED_LAND_LEASE`, `MOE_LAND_FETCH_FAILED`, `MOE_LAND_TARGET_DIVERGED`, `MOE_LAND_TARGET_CHECKED_OUT`, `MOE_LAND_MIRROR_SKIPPED`, `MOE_PUSH_FAILED`, `MOE_PUSH_OUTCOME_UNKNOWN`, `MOE_WORKTREE_BOARD_PATH`, `MOE_WORKTREE_GATE_INTEGRITY`, `MOE_WORKTREE_UNRESOLVED_CONFLICT`, `MOE_WORKTREE_SYNC_FAILED`.

**Error handling.**
- L2 CAS fails (only another session of the same task can move the task branch, and the owner guard should prevent that): stop, rescue the dirt, `failed`.
- L3: no lease within the bound, or `acquire_resource` errors: `MOE_COMMIT_FAILED_LAND_LEASE`, then the unlanded route with reason `contention`.
- L4: the fetch fails 3 times, a refused non-fast-forward included (a rewritten remote target, or a peer moving the tracking ref mid-fetch, which the next try clears): `MOE_LAND_FETCH_FAILED`, unlanded `remote`. Nothing was pushed, and remote mode never builds on the local target instead. An L that is not an ancestor of B: unlanded `diverged` (BLOCKED).
- L5 exit 1: unlanded `conflict`. Any other non-zero exit: `failed` with rescue. Never resolved automatically.
- L6: the gate fails, its worktree cannot be made sparse, or `MOE_WORKTREE_GATE_INTEGRITY`: unlanded `gate`, the check run recorded as today. Never a fallback to a full checkout.
- L7: a hook fails or changes the tree: `failed` with rescue, as today.
- L9: rejected, or a lost local CAS without C: the round ends (2.3). Any other push result: `reconcile_push` (2.6), where an unknown outcome keeps the attempt `finalizing`.
- L10 cannot fast-forward: `MOE_LAND_MIRROR_SKIPPED`; the landing still counts.
- L11 fails: `MOE_WORKTREE_SYNC_FAILED`; the landing still counts. The next pre-flight retries the sync whenever the last completion commit in `task.commits` is not an ancestor of the task branch.
- L12 RPC fails: the receipt journal replays it (`receipt_replay`), as today.

## 3. Attribution inside a worktree

**Decision.**
1. **Ownership.** W belongs to one task, and only that task's worker sessions run in it (§1.3), so every dirty path in W that DENY does not hold is the task's own. The per-task baseline (`<gitdir>/moe/baseline/<taskId>.tsv`) is not taken, and the ASSERTED, PLANNED, TOOL, MEASURED, PEER, CONTESTED and PREEXISTING tiers are not computed. `modifiedFiles` and `declare_files` stay required daemon inputs (they feed `task.filesModified` and planning), but the wrapper no longer selects paths with them.
2. **DENY stays**, applied to W's dirty set by a worktree-mode variant of the same predicate (sh `denied()`, ps1 `Test-MoeDenyPath`): `denied_wt` / `Test-MoeDenyPathWorktree`. It keeps today's list (`.mcp.json`, `.claude/settings.local.json`, `.claude/agents/**`, `.codex/**`, `.gemini/**`, `.grok/**`, `logs/moe-usage/**`, untracked `.serena/**`, which covers §5.3's memories link and `project.yml` copy, `.worktrees/**`, `.moe-worktree*` and `attribution.exclude`), holds `.moe/**` with **no BOARD exception** (board records never ride a worktree landing, §4), and adds `.claude/skills/**`, the link §5.2 makes in W. A held path prints `MOE_ATTR_EXCLUDED`, as today, and is never committed.
3. **Recovery.** A pre-flight that finds W dirty (a crashed session) and passes the §1.6 guard commits that dirt to the task branch as a checkpoint (L0-L2) and prints the existing `MOE_CHECKPOINT_RECOVERED`. Rescue-ref replay into W is not needed: W is private and persistent, so a crash loses nothing.
4. **Ledger.** `record_commit` gets ref `refs/heads/moe/task/<taskId>` for checkpoints (paths: the L2 dirty set) and `refs/heads/<target>` for completions (paths: `git diff --name-only B C`). It gets empty `inferredPaths` and `unattributedPaths`, and no contested or held fields.
5. **`get_commit_scope`** is still called, for `assigneeProtected` only, so the owner guard (L0) keeps working for zombie or non-assignee sessions. Its tier fields are ignored in worktree mode, and the daemon tool is unchanged.
6. **Control-checkout seats land nothing.** In worktree mode an architect, QA or governor seat's post-flight lands no bytes: the control checkout carries only daemon and human bytes, and board history is §4's snapshot. It records `MOE_COMMIT_NOTHING_TO_COMMIT`, as today's idempotent no-op does.
7. **Stray edits.** A seat in W can still write into the control checkout through an absolute path. At pre-flight the wrapper records the control checkout's dirty non-DENY paths outside `.moe/` (`git -C <control> status --porcelain=v1 -z --untracked-files=all`) in `<gitdir>/moe/worktree/<taskId>.control-dirt`. At post-flight, any path dirty now but absent from that list prints `MOE_WORKTREE_STRAY_EDIT` and becomes one `add_comment` on the task listing up to 20 paths. Those bytes are never landed and never reverted: in worktree mode only humans and the daemon dirty the control checkout, so a human decides.

**Rejected alternatives.**
- **Keeping the tiers in W.** They exist to split one shared tree between seats. In a private tree they can only drop the task's own bytes, as PREEXISTING or MEASURED-under-`solo` would.
- **Landing only the reported `modifiedFiles`.** A forgotten path would silently stay behind in W. The net diff is the truth, and QA reviews it.
- **Dropping `get_commit_scope` entirely.** Without it a stale session of a reassigned task could land into the new owner's branch. The guard costs one RPC.
- **Reverting stray control-checkout edits.** The wrapper cannot prove whose they are. It reports them, it never destroys them.

**Code paths replaced.** In worktree mode (§0.5): `commit_scope` / `Get-MoeCommitScope` tier use, `resolve_attribution` / `Resolve-MoeAttribution`, the `baseline_*` helpers and the `*-MoeBaseline` twins, and the BOARD tier. Kept: `landing_owner_guard` / `Get-MoeOwnerGuard` (§0.6), the DENY predicate and `record_commit_rpc`. Daemon `getCommitScope.ts` and `util/attributionTiers.ts` are unchanged; their tier output is simply not consumed.

**Assumed interfaces.**
- DENY variant sh `denied_wt` / ps1 `Test-MoeDenyPathWorktree`: today's list minus the BOARD exception, plus `.claude/skills/**`.
- `record_commit.ref` values `refs/heads/moe/task/<taskId>` (checkpoint) and `refs/heads/<target>` (completion).
- `<gitdir>/moe/worktree/<taskId>.control-dirt`.
- Log codes `MOE_ATTR_EXCLUDED`, `MOE_CHECKPOINT_RECOVERED` and `MOE_COMMIT_NOTHING_TO_COMMIT` (existing), `MOE_WORKTREE_STRAY_EDIT` (new).

**Error handling.**
- `git -C W status` fails: no landing, `MOE_COMMIT_FAILED_ATTRIBUTION` (existing) recorded as `failed`, W left untouched. The next pre-flight retries.
- The scope RPC fails or answers without a JSON `false`: the owner guard refuses as today (`MOE_COMMIT_REFUSED_OWNER_UNKNOWN`). Nothing moves.
- The control-dirt list cannot be written or read: skip the stray check with one `[WARN]`. It never blocks a landing.
- A recovery checkpoint fails: the dirt stays in W, the session proceeds, and the next exit tries again.

## 4. Board records

**Decision.** Option **(c)**: board history moves off main onto one plumbing-written ref, `refs/moe/board`. Worktree landings never carry a `.moe/` path.
1. **Writer.** After L12 (§2.2) of every worktree-mode completion landing, and after the QA post-flight of every worktree-mode approval, the wrapper snapshots the whole board: `.moe/tasks/`, `.moe/epics/` and `.moe/project.json`, read from the control checkout's working files. Helpers: sh `board_snapshot` / ps1 `Invoke-MoeBoardSnapshot`.
2. **How.** A temp index is read from the current `refs/moe/board` tree (empty when the ref is unborn). Each of those files that parses as JSON is added; a file that does not parse (caught mid-write) keeps its blob from the parent snapshot. Then `write-tree`, then `commit-tree -p <old>` with message `board: <taskId> <status>`, then `update-ref refs/moe/board <new> <old>` (CAS, 3 attempts). A tree equal to the parent's writes nothing.
3. **Push.** Best-effort, `git push origin refs/moe/board:refs/moe/board`, no force. A rejection or transport failure prints `MOE_BOARD_UNPUSHED` and changes nothing: each snapshot holds the whole board, so the next one catches up. The ref is not main, so rail 1 does not apply to it.
4. **Main.** `.moe/tasks/*.json` stays tracked on main, frozen at the flip commit (§7.3). After the flip the daemon's writes leave those files permanently modified in the control checkout. `.moe/roles/` and `.moe/skills/` are in that state today: tracked, rewritten by the plugins, never landed (DENY). Nothing reads the frozen copies on main.
5. **The §6 interplay is removed by construction.** After the flip commit, main never changes a `.moe/` path (L5b refuses), so the control checkout's `merge --ff-only` (§6.2) never has to overwrite a file the daemon keeps dirty.
6. **`settings.commitBoardState`** keeps its key and its default (on). In worktree mode it switches the snapshot on or off; in shared mode it keeps today's BOARD tier.

**Rejected alternatives.**
- **(a) The task's own record rides the landing commit**, read from the control checkout through a temp index. Main would then change `.moe/tasks/<id>.json`, which the daemon keeps dirty in the control checkout, so the control's fast-forward would refuse on every landing. It would also need a W landing to read files outside W, contradicting the §3 private-tree rule.
- **(b) Periodic snapshot commits on main.** They move main without a gate, against rail 1, and they hit the same fast-forward refusal as (a).
- **(c′) Untracking `.moe/tasks` on main** (`git rm --cached` plus `.gitignore`). Every other clone that pulls that commit has its board files deleted from disk by git, which would wipe another machine's daemon state. Freezing them is harmless.
- **(d) No board history at all.** That loses the audit trail the BOARD tier exists for. A ref costs one CAS.

**Code paths replaced.** In worktree mode, the BOARD tier of `resolve_attribution` / `Resolve-MoeAttribution` and the board-path staging in `land_plumbing` / `Build-MoeTempIndexTree` (§0.17: `.moe/tasks/<id>.json`, changed epics, `project.json`). Kept: the daemon's writes, unchanged, and `settings.commitBoardState`.

**Assumed interfaces.**
- Ref `refs/moe/board`; commit message `board: <taskId> <status>`.
- Helpers sh `board_snapshot` / ps1 `Invoke-MoeBoardSnapshot`.
- Log codes `MOE_BOARD_UNPUSHED` and `MOE_BOARD_SNAPSHOT_SKIPPED`.

**Error handling.**
- The CAS loses 3 times, or `write-tree` / `commit-tree` fails: `MOE_BOARD_SNAPSHOT_SKIPPED`. The task's landing is already complete and is not affected; the next snapshot covers the gap.
- A JSON file fails to parse: its parent blob is kept, and the skip is named in the log line. It is never a failure.
- The push fails: `MOE_BOARD_UNPUSHED`, local ref kept.

## 5. Seat tooling per worktree

**Decision.**
1. **Working directory and environment.** Every CLI runs with cwd W in worktree mode: sh `(cd "$W" && …)`, codex `exec -C W`, grok `--cwd W`, and in ps1 `Push-Location W` for **every** CLI, including the claude launch that today runs in the launcher's cwd. `MOE_PROJECT_PATH` stays the control checkout: `moe-proxy` reads `daemon.json` there and exits on a project-path mismatch, and the mods read `.moe/` through it. The wrapper also exports `MOE_WORKTREE_PATH` (W), `MOE_TASK_BRANCH` and `MOE_LAND_TARGET`. The proxy path stays the one the wrapper resolves from its own location (`$ROOT_DIR/packages/moe-proxy/dist/index.js`, the control checkout, §6.1), never from W, which has no `dist/` until it builds one.
2. **Per-CLI config, written into W** by the existing writers called with W as the config root, with `MOE_PROJECT_PATH` = control:
   - claude: `W/.mcp.json` (sh) or the existing temp `--mcp-config` (ps1). An interactive sh seat passes `--mcp-config W/.mcp.json`, as it already does for the project file. An interactive claude seat in W gets its folder-trust grant for W (its git top-level is W); headless seats never see the dialog.
   - codex `W/.codex/config.toml`, gemini `W/.gemini/settings.json`, grok `W/.grok/config.toml`. W is added to `~/.grok/trusted_folders.toml` by the existing trust step. Trust entries for removed worktrees accumulate there; they are inert and the sweep does not edit them.
   - `.claude/agents`: a **copy** of the control checkout's `.moe/agents/*.md` into `W/.claude/agents/` (read from the control checkout, because W has no `.moe/`). `.claude/skills`: a **link** `W/.claude/skills` → `<control>/.claude/skills`, recorded in the link manifest (§1.10). All of these paths are DENY or gitignored (§3.2).
3. **Serena.** When the resolved Serena root is the control checkout (the default), it becomes W, so LSP sees the task's bytes. Memories stay shared through a link `W/.serena/memories` → `<control>/.serena/memories` (recorded in the manifest). The control's `.serena/project.yml` is copied into W with its `project_name` line rewritten to `<name>@<taskId>`, so two roots never register under one name. A `serenaProject` or `MOE_SERENA_PROJECT` override that resolves outside the control checkout is kept as it is and prints `MOE_WORKTREE_SERENA_OUTSIDE` (LSP will not see W's bytes).
4. **node_modules and dist: per W, on demand.** Nothing is linked. At pre-flight the wrapper lists the tracked `package-lock.json` files in W and prints `MOE_WORKTREE_DEPS_MISSING <dir>` for each directory without `node_modules`. The worktree-mode prompt tells the worker to run `npm ci --prefer-offline` (plus `npm run build` where tests need `dist/`) in a package before testing it. This follows the frozen gate's precedent, where gate commands install their own dependencies. Cost: up to 115 + 93 + 73 MB per W when all three packages are installed, removed with W. Upgrade path (out of scope): a link when the lockfiles are byte-identical, which needs a write-through guard first.
5. **Gradle.** The `jetbrains-gradle` lease stays exactly as it is. `moe-jetbrains/build` and `.gradle/` are per W because they sit inside it. W lives on the same drive as the control checkout (`/mnt/d/…` is `D:\…`), so a WSL seat still runs `gradlew.bat` through the Windows path. The Gradle daemon and `~/.gradle` caches are shared, as today.
6. **Disk and cleanup.** W is 31 MB of tracked files plus whatever the worker installs and builds. Everything is removed with W (§1.7-§1.10). No per-W state exists outside W except the link manifest and control-dirt list under `<gitdir>/moe/worktree/`, which removal deletes.
7. **Nested `CLAUDE.md`.** claude in W also loads the control checkout's `CLAUDE.md` files as ancestors of W, so instructions appear twice. Accepted: they are byte-identical at fork time.

**Rejected alternatives.**
- **cwd = control checkout with `--add-dir W`.** Edits would default to the control checkout and §3's ownership rule would break.
- **`MOE_PROJECT_PATH` = W.** The proxy would find no `daemon.json`, and the daemon would see a second project.
- **A Serena root at the control checkout.** LSP would read the control's bytes and edit them, which is exactly the stray-edit case §3.7 warns about.
- **A per-W Serena memory store.** Knowledge written during a task would never reach other seats.
- **Linking `node_modules` to the control checkout.** One `npm install` in W would write through the link into every seat's dependencies. A `worktree remove --force` that missed the unlink would delete the control's `node_modules` on Windows.
- **A shared Gradle build dir.** Two worktrees would overwrite each other's outputs under one lease holder.

**Code paths replaced.** In worktree mode: the cwd and `Push-Location` blocks of every CLI launch (§0.12), and the root argument of the per-CLI config writers and the `.claude/agents` mirror (§0.13). The Serena root resolution (§0.14) gains the control→W mapping. Unchanged: the proxy path resolution, account leasing (keyed on the launch directory), and `TerminalAgentLauncher.kt`.

**Assumed interfaces.**
- Env `MOE_WORKTREE_PATH`, `MOE_TASK_BRANCH`, `MOE_LAND_TARGET`; `MOE_PROJECT_PATH` unchanged.
- Links `W/.claude/skills` and `W/.serena/memories`, both in the manifest; the copies `W/.claude/agents/*.md` and `W/.serena/project.yml` (`project_name: <name>@<taskId>`).
- Log codes `MOE_WORKTREE_SERENA_OUTSIDE`, `MOE_WORKTREE_DEPS_MISSING`, `MOE_WORKTREE_LINK_FAILED`.

**Error handling.**
- A config write into W fails: `MOE_WORKTREE_CREATE_FAILED`, the same route as §1 (no launch, `report_blocked`). A seat without its MCP servers cannot work.
- A link cannot be made (Windows without junction rights, an existing path): `MOE_WORKTREE_LINK_FAILED`. For `.serena/memories` the seat launches without Serena (Serena already no-ops when missing); for `.claude/skills` it launches without skills. Both are warnings, never a silent fallback to the control root.
- `project.yml` is missing in the control checkout: nothing is copied and Serena generates its own on activation.

## 6. Running the wrapper from committed main bytes

**Decision.**
1. **Seats launch only from the control checkout.** The JetBrains launcher already resolves `scripts/` in the project, which is the control checkout (`resolveAgentScript`), or the bundled copy. A wrapper whose own path is inside `<git top>/.worktrees/` refuses to start with `MOE_WRAPPER_IN_WORKTREE`, so a worker in W cannot launch a seat on its own uncommitted wrapper.
2. **The control checkout follows the target on a branch of its own, `moe/control`.** Its follow step, sh `follow_control_checkout` / ps1 `Invoke-MoeControlFollow`, is `git -C <control> -c core.hooksPath=<empty dir> merge --ff-only refs/heads/<target>`. It runs after every landing (L13), at every wrapper loop top **before** the hot-reload check, and in the QA pre-flight after the claim (6.4). `merge --ff-only` moves HEAD and the working files together, so the wrapper file on disk is always the committed bytes HEAD names. In remote mode the local target holds only published commits (§2.3), so seats only ever run published bytes.
3. **Why not check out main itself.** L9's `update-ref` (local mode) or L10's mirror on a checked-out main would move HEAD while the files stayed old. The wrapper file would then read as "uncommitted edits", and task-5998f871's committed-bytes gate (`wrapper_reload_deferred` / `Test-MoeWrapperReloadDeferred`, which compares the file with HEAD) would defer the reload forever. §2.7 refuses to land on a checked-out target for the same reason.
4. **QA reviews what landed.** After the follow, the QA pre-flight checks that the task's completion sha is an ancestor of the control's HEAD. If it is not, the wrapper prints `MOE_CONTROL_CHECKOUT_BEHIND`, launches no CLI and calls `report_blocked` with that reason, so QA never runs checks against bytes other than the landed ones. The reviewed diff is `git diff <sha>^ <sha>`.
5. **Branch states at the follow:**
   - On `moe/control`: follow.
   - On the target at the same commit, or detached at it (a human checkout): `git switch -c moe/control` (or `git switch moe/control` when that branch points at the same commit), then follow.
   - On any other branch (a human's feature branch, or `moe/work-*` because the §7.3 runbook has not run): `MOE_CONTROL_NOT_FOLLOWING`, no follow, one `#general` alert per hour. A **worker** seat whose claim says worktree mode then creates no W: it calls `report_blocked` with that code and stops the seat, so an unprepared flip can never cut W from a stale target or land beside a shared branch. Architect, QA and governor seats only warn. WT-04 enforces the stop (HEAD must be `refs/heads/moe/control`); WT-13 adds the follow and the auto-switch.
6. **Board files.** After the flip commit main never changes `.moe/` (§4.5), so the daemon's constant writes never block the fast-forward.
7. **Out of scope.** Daemon `dist/` rebuilds and restarts after a landed daemon change stay a human step, as today.

**Rejected alternatives.**
- **`git read-tree -m -u <old> <new>` on a checked-out main.** It fails on any landed path dirty in the control, and it leaves HEAD and the index to reconcile by hand.
- **Running the wrapper from a separate `scripts` worktree.** The IDE launcher, the mods and every operator command expect `scripts/` in the project.
- **Following only at seat start.** A long-lived interactive architect or governor seat would run a wrapper days behind main.

**Code paths replaced.** None. New: the follow helper, the `MOE_WRAPPER_IN_WORKTREE` guard and the QA ancestry check. The loop-top hot-reload block (`MOE_WRAPPER_LAUNCH_HASH`, §0.15) and task-5998f871's gate are kept, and the follow is placed before them. The IDE launcher (§0.16) is unchanged.

**Assumed interfaces.**
- Branch `moe/control`; helpers sh `follow_control_checkout` / ps1 `Invoke-MoeControlFollow`.
- task-5998f871e03d4ed5ab21f214073d85b2's `wrapper_reload_deferred` / `Test-MoeWrapperReloadDeferred` (landed in 9a5426ac).
- Log codes `MOE_CONTROL_ADVANCED`, `MOE_CONTROL_CHECKOUT_BEHIND`, `MOE_CONTROL_CHECKOUT_DIVERGED`, `MOE_CONTROL_NOT_FOLLOWING`, `MOE_WRAPPER_IN_WORKTREE`.

**Error handling.**
- `merge --ff-only` refuses because a local edit would be overwritten (a human editing in the control checkout): `MOE_CONTROL_CHECKOUT_BEHIND` with git's file list, one `#general` alert per hour. The control stays put, so seats keep running older but committed wrapper bytes. Landing is unaffected.
- `moe/control` has commits the target lacks (a human committed in the control checkout): `MOE_CONTROL_CHECKOUT_DIVERGED`, alert, no follow. A human lands that commit through a task or resets `moe/control`. The wrapper never resets it.
- The switch to `moe/control` fails: `MOE_CONTROL_NOT_FOLLOWING`, no follow.
- Any follow failure at L13 never turns a landing into a failure: C is on the target by then.

## 7. Migration and rollback

**Decision.**
1. **The flag:** `settings.worktreeMode: 'off' | 'on'`, default `'off'`, validated in `state/validators.ts`, whose exported `resolveWorktreeMode(settings)` is the one place the default lives. The wrappers never read the key: they take the mode from the claim's `workspace` (7.2), so flipping the default is a daemon-only change. There is **no per-seat override**: a shared-mode seat landing on `moe/work-*` next to worktree seats landing on main would split the delivery path. Trials run on a scratch project instead.
2. **Pinned per attempt.** `claim_next_task` copies the setting into `ExecutionAttempt.workspaceMode` and sets `workspace` = W in worktree mode. Both `claim_next_task` and `get_context` expose `workspace: { mode, path, branch, target }`, and the wrapper takes the mode from there, not from a fresh settings read. Two wrapper guards, both ending in `report_blocked` with `MOE_WORKTREE_MODE_MISMATCH`: worktree mode while the task has checkpoints or completions on a ref other than its task branch or the target that the target does not contain (shared-mode bytes); and shared mode while `moe/task/<taskId>` exists and is not fully landed (worktree bytes). When a claim's `workspace` says worktree mode and the seat's git is older than 2.38 (no `merge-tree --write-tree`), the seat creates no W, calls `report_blocked` with `MOE_WORKTREE_UNSUPPORTED_GIT` and stops. The mode is unknown before the claim, so the probe cannot run earlier.
3. **Flip-on runbook** (stop-the-world, human-run, written to `docs/TROUBLESHOOTING.md` by WT-16):
   1. Drain: stop every seat once no task is WORKING or REVIEW with an open attempt. Let each REVIEW land and finalize first.
   2. `git for-each-ref refs/moe/rescue` must show no rescue ref of a live task still waiting for shared-mode recovery. Land or archive those tasks first.
   3. Settings: declare `resources: { "git-land-main": { capacity: 1, maxLeaseMs: 7200000, releaseOnDeregister: true } }` and set a `qualityGate` if none is set (from then on every landing takes the lease, §2.3).
   4. Run the migration landing (below) for `moe/work-2026-10-24`, once the fetched target is an ancestor of the branch (`git merge-base --is-ancestor origin/main moe/work-2026-10-24` holds today; otherwise first merge main into the branch, as for a conflict). C's tree is then the branch tip's, so step 5's switch changes no file and the daemon's dirty `.moe/` files stay as they are. Any stop leaves main untouched (or, for an unknown outcome, settled by the re-run) and the flip waits.
   5. In the control checkout: `git switch -c moe/control main`.
   6. Settings: `worktreeMode: 'on'` and `consolidationBranch: 'main'` (so `cachedPlanPaths.ts` reads `origin/main`). Then `node packages/moe-daemon/dist/index.js doctor` must pass (the WT-16 probes), then restart the seats.

   **The migration landing** (step 4), sh `--land-branch <branch>` / ps1 `-LandBranch <branch>` (WT-10), is how `moe/work-2026-10-24` reaches main. A human decides when and runs it from the control checkout; the wrapper executes it through §2.2's core, so rail 1 holds with no human exception. It takes the L3 lease, then runs rounds of L4 (B = the fetched target), L5 `merge-tree --write-tree B <branch>` (the isolated candidate: no working tree changes), L6 the gate on exactly M, L7 C = `commit-tree M -p B -p <branch tip>`, L9 and L10, and releases the lease (L14). C is one merge commit, so `git log --first-parent main` gains one commit and the branch history stays reachable. It skips L0-L2, L5b (the flip commit is the one main commit that changes `.moe/`, §4.4), L8 and L11-L13, and records no Candidate, CheckRun or ledger row (there is no task); it prints the gate result and C. It always runs `settings.qualityGate`, whatever `qualityGateScope` says, and refuses with `MOE_MIGRATION_NO_GATE` before any fetch when none is set. A conflict stops with `MOE_COMMIT_FAILED_CONFLICT` and the paths; the human merges main into the branch (not main, so rail 1 does not apply) and re-runs. A rejected push starts a new round (2 rounds, then `MOE_COMMIT_FAILED_REF_CONTENTION`). An unknown push outcome stops with `MOE_PUSH_OUTCOME_UNKNOWN`, and a re-run settles it: once main contains the branch, M equals B's tree and the mode exits 0 with `MOE_COMMIT_NOTHING_TO_COMMIT`. The old `moe/work-*` branches stay; Moe never deletes them.
4. **Rollback** (stop-the-world): drain as above, landing every task branch that is not fully landed (preferred) or having the human merge it into the shared branch, which is not main. Then set `worktreeMode: 'off'` and run `git switch -c moe/work-<date> main` in the control checkout (or unset `consolidationBranch` and let the peel run). The sweep removes the remaining worktrees of DONE tasks. A task still pinned to worktree mode hits `MOE_WORKTREE_MODE_MISMATCH` and blocks for a human instead of losing bytes. Rollback never moves main.
5. **Plugins.** JetBrains: the plugin excludes `<project>/.worktrees` from the project model on open, in every mode (the folder is reserved), so the IDE neither indexes N copies of the tree nor offers each worktree as an unregistered VCS root. VS Code: no code change, because search already honours `.gitignore` and the default `files.watcherExclude` already skips `node_modules`; a `docs/` line is the whole change. The board needs no change, because task records are unchanged.
6. **Docs WT-17 and WT-18 update (WT-19 re-checks them):** root `CLAUDE.md` (Landing, Working in this repo), `scripts/CLAUDE.md` (Land on every exit: the worktree arm), `docs/CONFIGURATION.md` (`worktreeMode`, the new env vars), `docs/ARCHITECTURE.md` (Delivery Path), `docs/MCP_SERVER.md` (`finalize_attempt` `unlanded`, the claim/`get_context` `workspace`, `complete_task` branch policy), `docs/SCHEMA.md` (`landingRetry`, `workspaceMode`), and `docs/roles/worker.md` + `worker.reference.md`, whose "work in the project root, never a `.worktrees/` checkout" line must change for worktree mode (within the 40-line lint cap).

**Rejected alternatives.**
- **A per-seat override for trials.** It splits the delivery path (see 7.1). A scratch project is the trial.
- **A live flip with tasks in flight.** A task half on `moe/work-*` and half on a task branch has no single landing story; the drain plus the mismatch guard make that state impossible.
- **A human `git merge` and push of the branch into main** (the first draft). Rail 1 has no human or migration exception, and that main move would skip both the gate and the CAS.
- **Fast-forwarding main to the branch tip.** It is also a CAS, but main's first-parent history would then carry every wip commit of the consolidation branch.
- **A Moe seat starting the migration.** It is a one-time, cross-task decision, so a human starts it and the wrapper only executes it.
- **Defaulting to on before WT-19.** Rail 4.

**Code paths replaced.** None in shared mode. New: the `worktreeMode` setting, `workspaceMode` on the attempt, the `workspace` exposure, the two guards, and the migration mode, which reuses §2's helpers. `claimNextTask.ts`'s fixed `workspace = state.projectPath` (§0.11) gains the worktree arm.

**Assumed interfaces.**
- `settings.worktreeMode: 'off' | 'on'` (default `'off'`); `resolveWorktreeMode(settings)` exported from `state/validators.ts`.
- `ExecutionAttempt.workspaceMode`; `claim_next_task` / `get_context` field `workspace: { mode, path, branch, target }`.
- Wrapper mode sh `--land-branch <branch>` / ps1 `-LandBranch <branch>`.
- Log codes `MOE_WORKTREE_MODE_MISMATCH`, `MOE_WORKTREE_UNSUPPORTED_GIT`, `MOE_MIGRATION_NO_GATE`.
- Resource declaration `settings.resources["git-land-main"]`.

**Error handling.**
- An invalid `worktreeMode` value: rejected by `validators.ts`, as for any setting.
- `workspace` missing from an older daemon's claim: the wrapper treats the task as shared mode. It never guesses worktree mode.
- A mismatch: `MOE_WORKTREE_MODE_MISMATCH`, `report_blocked`, no landing, no deletion.
- The migration landing has no gate, conflicts, fails its gate, cannot get the lease (`MOE_COMMIT_FAILED_LAND_LEASE`) or exhausts its rounds: it stops having published nothing, and the runbook stops at 7.3 step 4. Nothing is flipped until main contains `moe/work-2026-10-24`.

## 8. Slices

Every slice is a row in epic-dce3a64f, depends on this spike (`S` = task-30066ccdeb6042c3b5c89a7a31833d14) and plans against the section it names. `dependsOn` is the binding order; the board's `order` field is advisory and was re-ranked after the rows were created, so this table leaves it out. Slices that edit `scripts/moe-agent.{sh,ps1}` form one `dependsOn` chain (WT-04 → WT-14), because shared mode is still the delivery path while they land and two of them must never hold those files at once. WT-04 and WT-13 also wait for task-5998f871e03d4ed5ab21f214073d85b2, which edits the same wrappers and owns the committed-bytes reload §6 builds on. WT-08T is the held-out test-authoring task for the landing core: WT-08 and WT-09 must pass its files unchanged.

**Revision after QA reject 1.** No row was added or re-created. Each corrected contract reached its row as a task comment naming the revised sections, whose numbers did not change: WT-03, WT-04, WT-07, WT-08T, WT-08, WT-09, WT-10, WT-11, WT-14, WT-16, WT-17, WT-18 and WT-19. Where a comment and its row's description differ, the comment wins. `definitionOfDone` is human-owned, so every correction keeps each row's DoD satisfiable as written: WT-10's "with no qualityGate no lease call is made" is L3's rule, and WT-16's "human-only merge step" is the human-run migration landing. WT-16's runbook names WT-10's `--land-branch`, so its planner adds WT-10 to its `dependsOn`.

The docs sweep is split into WT-17 and WT-18 because one task cannot touch nine docs under the 5-file cap. WT-19, the integration-and-hardening task, re-checks them. New log-code families (`MOE_WORKTREE_`, `MOE_LAND_`, `MOE_CONTROL_`, `MOE_BOARD_`, `MOE_PUSH_`, `MOE_MIGRATION_`, plus the single code `MOE_WRAPPER_IN_WORKTREE`) get added to parity-check's compared families in WT-19. Until then every wrapper slice proves twin parity with its own DoD command. Slices that leave the wrappers alone (WT-01..03 and WT-15..18) still run parity-check for rail 2, on a HEAD snapshot of `scripts/` (`git archive HEAD scripts`), as each slice's self-review comment says.

| Slice | Task id | Seam (§) | Files (≤5) | dependsOn | DoD gist |
|---|---|---|---|---|---|
| WT-01 | task-6cf120a38b344e72b7bab8b9faf806f1 | Daemon contract: `settings.worktreeMode`, `resolveWorktreeMode`, attempt `workspaceMode`/`workspace`, claim `workspace` (§7.1, §7.2, §1.8, §2.7 target rule) | `types/schema.ts`, `state/validators.ts`, `state/validators.test.ts`, `tools/claimNextTask.ts`, `tools/claimNextTask.test.ts` | S | validator accepts only off/on; claim in each mode records and returns `workspace`; literal vs glob target |
| WT-02 | task-e27456ad67b64bc292080ea3a8b92f26 | Daemon: `get_context` `workspace`; `complete_task` worktree branch policy (§2.8, §7.2) | `tools/getContext.ts`, `tools/getContext.test.ts`, `tools/completeTask.ts`, `tools/completeTask.test.ts` | S, WT-01 | get_context echoes the attempt's workspace; worktree attempt requires `moe/task/<id>`; shared unchanged |
| WT-03 | task-9a39bf6a2c4444b4b0799cd16dc2a9f1 | Daemon: `finalize_attempt` `unlanded` (reason `remote` included) and `Task.landingRetry` routing (§2.5) | `tools/finalizeAttempt.ts`, `tools/finalizeAttempt.test.ts`, `types/schema.ts` | S, WT-01 | REVIEW→WORKING unassigned, `remote` like conflict; diverged or 3rd → BLOCKED; landed clears; refused for shared attempts |
| WT-04 | task-c20464ff64ca49fca4371dd9b5194364 | Wrappers: worktree provisioning at worker pre-flight, guards (§1.1-§1.6, §6.5 stop, §7.2 guards) | `scripts/moe-agent.sh`, `scripts/moe-agent.ps1`, `scripts/tests/postflight.sh`, `scripts/tests/postflight.ps1` | S, WT-02, task-5998f871 | locked sparse `--no-track` W without `.moe`; `W/.moe` fails closed: no CLI, nothing deleted or committed (negative case); reuse; re-add on existing branch; git/top/control/mismatch guards |
| WT-05 | task-c4cccb84948c472d93263c9de60fed1d | Wrappers: every CLI launched in W with per-W configs and env (§5.1, §5.2) | same 4 wrapper files | S, WT-04 | cwd W for all CLIs incl. ps1 claude; `MOE_PROJECT_PATH` = control; configs in W; agents copy; grok trust |
| WT-06 | task-042dc0ddb9b64c60a98a567b71723351 | Wrappers: Serena root, memories/skills links, link manifest, deps notice (§5.2-§5.4, §1.10 write side) | same 4 | S, WT-05 | Serena root W; links recorded; renamed `project.yml`; `MOE_WORKTREE_DEPS_MISSING` |
| WT-07 | task-b319b263fada419d9d7de279682dc5f4 | Wrappers: checkpoint landing to the task branch, worktree attribution, recovery, stray edits, control seats land nothing (§2.4, §2.6, §3) | same 4 | S, WT-06 | L0-L2 on the task branch only; DENY variant; recovery checkpoint only after the §1.6 guard; stray comment; no baseline file |
| WT-08T | task-c12f9463b68c44a18cc460a7e9460247 | Held-out acceptance tests for completion landing (§2.2, §2.3, §2.5, §2.6, §2.7, §2.9) | `scripts/tests/worktree-landing.sh`, `scripts/tests/worktree-landing.ps1` (new) | S, WT-04 | ≥12 cases tagged `local`/`remote`, incl. QA's two-seat race, a push applied but unreported, an unknown outcome then replay (git shim on PATH); `--only` filter; red against current code; not in CI yet |
| WT-08 | task-7a4aab5e0bfa48e0978eb76506edfd57 | Wrappers: completion landing, local mode: L4, L5, L5b, L7 (hooks in a sparse work tree), L8, L9 local CAS, L11, L12 (`pushed: false`), rounds, target rules (§2.2, §2.3, §2.7, §2.9) | same 4 wrapper files | S, WT-07, WT-08T | WT-08T `local` cases pass unchanged; a hook that edits a file fails with rescue; postflight + parity green |
| WT-09 | task-0921d6d76a6b40a685077245b19ac639 | Wrappers: remote mode: L4 fetch-only B, L9 push and its classification, `reconcile_push`, unknown outcome, L10 mirror, replay fetch-first, W base from origin (§1.2, §2.2 L4/L9/L10, §2.3, §2.6) | same 4 wrapper files, `.github/workflows/ci.yml` | S, WT-08 | WT-08T `remote` cases pass unchanged; `pushed: true` only when confirmed; no force flag; both test files registered in CI |
| WT-10 | task-5c2e6cdf2494412ca0c2bc40e26d9da3 | Wrappers: land lease, quality gate on M in a `.moe`-free gate worktree, `--land-branch` migration mode (§2.2 L3/L6/L14, §2.3, §7.3) | same 4 wrapper files | S, WT-09 | gate runs on M; lease while a qualityGate is set, none without; a gate writing `.moe/x` publishes nothing; shared gate unchanged; migration clean/conflict/no-gate/re-run cases |
| WT-11 | task-dd1ee586b90d4fc785434454b1423e76 | Wrappers: unlanded route (reason `remote` included) and conflict resume in W (§2.5, §2.6) | same 4 | S, WT-03, WT-10 | rescue + `finalize_attempt unlanded` only when nothing was published; `LANDING-CONFLICT:`/`LANDING-RETRY:`; marker check; MERGE_HEAD rules; merge from the §1.2 base |
| WT-12 | task-06910296f63b4868849dc46cbb38a731 | Wrappers: board snapshots on `refs/moe/board` (§4) | same 4 | S, WT-11 | whole-board CAS snapshot; torn JSON keeps parent blob; unpushed is a warning |
| WT-13 | task-fbe8e3880ddf47dfa8546f220acea770 | Wrappers: control checkout follows the target; QA ancestry check; wrapper-in-worktree guard (§6) | same 4 | S, WT-12, task-5998f871 | ff follow at L13/loop top/QA pre-flight; auto-switch; behind/diverged codes; reload not deferred |
| WT-14 | task-befdddf7e1f047a0ba4f71dd900c9b8f | Wrappers: worktree removal and orphan sweep (§1.7, §1.9, §1.10) | same 4 | S, WT-13 | QA DONE removal; sweep bounds and lock; rescue before delete; junction-safe unlink; a W holding `.moe` is never removed |
| WT-15 | task-fad5ef971b0941b590621aa40702ad4b | JetBrains: exclude `.worktrees` from the project model (§7.5) | new `moe-jetbrains/.../WorktreeExclusion.kt`, `plugin.xml`, a JUnit test | S | folder excluded on open; no unregistered-root prompt; `./gradlew test` green |
| WT-16 | task-48f0b3aaa82c4b938d3a15f3710a66e5 | Daemon: doctor worktree probes and the flip/rollback runbook, migration landing included (§7.3, §7.4) | `commands/doctor.ts`, `commands/doctor.test.ts`, `docs/TROUBLESHOOTING.md` | S, WT-01 (WT-10 to add, see above) | probes git ≥2.38, top-level project, control on `moe/control`, target literal; runbook with no human `git merge` |
| WT-17 | task-cda65eb0efb244efa8a506969bac47f9 | Docs: contract docs (§2, §4, §7) | `docs/MCP_SERVER.md`, `docs/SCHEMA.md`, `docs/CONFIGURATION.md` | S, WT-14, WT-15, WT-16 | every new param/field/key/env/code documented once, `remote` and `MOE_LAND_NET_BACKOFF_SEC` included |
| WT-18 | task-1b2e6fe3ba1343c8ab02271510131155 | Docs: narrative and role docs (§0, §2, §6, §7.6) | `CLAUDE.md`, `scripts/CLAUDE.md`, `docs/ARCHITECTURE.md`, `docs/roles/worker.md`, `docs/roles/worker.reference.md` | S, WT-14, WT-15, WT-16 | worktree arm of "Land on every exit", fail-closed publication included; worker.md line changed; lint passes |
| WT-19 | task-b1ca54f2716442be889a14623eb59983 | **Integration and hardening**: flip the default, close parity, sweep file-only edges, full regression, end-to-end run with QA's race, docs re-check, whole-epic adversarial pass | `state/validators.ts`, `state/validators.test.ts`, `scripts/tests/parity-check.sh`, `scripts/tests/parity-check.ps1`, `docs/CONFIGURATION.md` | every slice above (task-5998f871 transitively via WT-04/WT-13; the daemon caps dependsOn at 20) | see the task and its revision comment |

**File-only dependency sweep (WT-19).** The governor's audit (#governors, msg-e0a9bbff, 2026-10-30 09:59Z, plus a 10:27Z addendum) listed these edges as existing only because the two tasks share a file: V07←01f37ac6, V04c←V08b, RF04←90664db1, RF07←465ee875, RF07←80930ce6, R13←R11e, R13←2cf1c6be, 724e31fa←e7f4026a, and 01f37ac6←e7f4026a. Many will be DONE by then. To re-derive the list for whatever is still open: for each open task's `dependsOn` edge A←B, keep the edge if A's description or plan names anything B produces (a symbol, tool, setting, file B creates); drop it with `moe.set_task_dependencies` only when the sole overlap is a shared existing file. The kept/dropped list goes into WT-19's completion summary.
