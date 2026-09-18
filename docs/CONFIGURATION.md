# Configuration Reference

This document covers all configuration options for Moe's Tavern.

---

## Environment Variables

### Daemon Configuration

| Variable | Description | Default | Example |
|----------|-------------|---------|---------|
| `MOE_PROJECT_PATH` | Path to project containing `.moe/` folder | Current directory | `/home/user/myproject` |
| `MOE_DEFAULT_PORT` | WebSocket/HTTP server port (auto-scans upward if taken) | `9876` | `9900` |
| `MOE_PORT_RANGE` | How many ports to scan past the default | `50` | `100` |
| `MOE_BIND_HOST` | Bind address (recorded as `bindHost` in daemon.json when non-loopback; WSL agent mode uses `0.0.0.0`) | `127.0.0.1` | `0.0.0.0` |
| `MOE_SHUTDOWN_TIMEOUT_MS` | Grace period for clean shutdown | `10000` | `5000` |
| `LOG_LEVEL` | Logging verbosity | `info` | `debug`, `warn`, `error` |
| `LOG_MAX_SIZE_MB` | Max activity.log size before rotation | `10` | `5` |
| `LOG_RETENTION_COUNT` | Number of rotated logs to keep | `5` | `3` |

(Advanced tuning — see `packages/moe-daemon/src/index.ts` and the util that reads each: port/lock `MOE_SOCKET_TIMEOUT_MS`, `MOE_PORT_CHECK_INTERVAL_MS`, `MOE_PORT_READY_TIMEOUT_MS`, `MOE_LOCK_RETRY_DELAY_MS`, `MOE_LOCK_STALE_TIMEOUT_MS`, `MOE_HTTP_CLOSE_TIMEOUT_MS`; state/limits `MOE_STATE_LOAD_TIMEOUT_MS`, `MOE_MCP_MAX_BATCH_SIZE`, `MOE_MAX_COMMENTS_PER_TASK`, `MOE_MAX_COMMITS_PER_TASK` (cap on `task.commits`, default 50, newest kept); rate limiting `MOE_RATE_LIMIT_ENABLED`, `MOE_RATE_LIMIT_WINDOW_MS`, `MOE_RATE_LIMIT_MAX_REQUESTS`; proposal cleanup `MOE_PROPOSAL_PURGE_INTERVAL_MS`, `MOE_PROPOSAL_PURGE_AGE_MS`, `MOE_PROPOSAL_SNAPSHOT_RETENTION_MS`; log compression `LOG_COMPRESSION_TIMEOUT_MS`.)

### Proxy Configuration

| Variable | Description | Default | Example |
|----------|-------------|---------|---------|
| `MOE_PROJECT_PATH` | Project path (used to locate `.moe/daemon.json`) | Current directory | `/home/user/myproject` |
| `MOE_MESSAGE_TIMEOUT_MS` | Per-message timeout for forwarded MCP calls | `30000` | `60000` |
| `MOE_WORKER_ID` | Worker identity injected into every `tools/call` | Set by agent launchers | `worker-1` |
| `MOE_DAEMON_HOST` | Connect-host override (WSL agent mode: reach a Windows-owned daemon via the WSL gateway) | Loopback | `172.29.32.1` |

### Agent Scripts

| Variable | Description | Default | Example |
|----------|-------------|---------|---------|
| `MOE_WORKER_ID` | Worker identifier | Generated per launch | `worker-1` |
| `MOE_SERENA_PATH` | Serena binary for the injected MCP server | `~/.local/bin/serena` | `/opt/serena/serena` |
| `MOE_SERENA_PROJECT` | Serena project root override (multi-repo workspaces) | Moe project root | `/repo/backend` |
| `MOE_NODE_COMMAND` | Node.js executable (JetBrains plugin daemon spawn) | `node` | `/usr/local/bin/node` |
| `MOE_DAEMON_COMMAND` | Daemon start command override (JetBrains plugin) | Auto-detected | `npx moe-daemon` |
| `MOE_DAEMON_HOST` | Daemon connect-host override for agents + spawned MCP servers (WSL mode) | Loopback | `172.29.32.1` |
| `MOE_DISABLE_HEARTBEAT` | Skip the heartbeat sidecar that keeps `lastActivityAt` fresh during long silent CLI steps | Unset | `1` |
| `MOE_HEARTBEAT_INTERVAL_SEC` | Heartbeat sidecar ping interval | `60` | `30` |
| `MOE_HEARTBEAT_MAX_DURATION_SEC` | Heartbeat sidecar hard stop (a truly-hung CLI still goes stale) | `7200` | `3600` |
| `MOE_DISABLE_QUALITY_GATE` | Skip `settings.qualityGate` for this run | Unset | `1` |
| `MOE_DISABLE_CHECKPOINT` | Skip `wip(task-<id>)` checkpoint commits for this run (completion commits and rescue refs still land) | Unset | `1` |
| `MOE_ATTRIBUTION` | `declared` forces `settings.attribution.undeclared` to `never` for this run — declared-only landing, no MEASURED paths | Unset | `declared` |
| `GIT_TERMINAL_PROMPT` | **Set by the wrapper** (not read) to `0` for its whole lifetime, so a credential or host-key prompt can never hang a push or a `pull --rebase` retry | `0` (wrapper-set) | — |
| `MOE_POSTFLIGHT_TEST_HOOK_PRE_UPDATE_REF` | Test seam only: a command the landing runs between `commit-tree` and `update-ref` (the harness uses it to force CAS contention with a peer commit) | Unset | `bash peer-commit.sh` |
| `MOE_RESUME_MAX_ATTEMPTS` | CLI relaunches onto an already-held task before escalating + idling | `5` | `3` |
| `MOE_CODEX_REASONING_EFFORT` | `model_reasoning_effort` written to codex config.toml | `xhigh` | `high` |
| `MOE_CODEX_MCP_STARTUP_TIMEOUT_SEC` | `startup_timeout_sec` for the codex `moe` MCP entry (survives supervised daemon restarts) | `120` | `180` |
| `MOE_DISABLE_ARGV_PROBE` | Skip the once-per-process codex argv pre-flight: before the first headless launch the wrapper runs the real launch argv plus `--help` (clap short-circuits before any model call). If the installed codex rejects a flag (`unexpected argument …`, the way `--full-auto` broke in codex-cli 0.147) the wrapper prints `MOE_CLI_ARGV_REJECTED`, escalates to `#general`, and exits — a parse error is permanent for that install, so relaunch-looping cannot help | Unset | `1` |
| `MOE_CODEX_SANDBOX` | `--sandbox <mode>` for the headless `codex exec` launch (opt-in per seat via `-CodexExec`/`--codex-exec`; codex seats are interactive by default): `read-only`, `workspace-write` or `danger-full-access`; `inherit` omits the flag so the merged `~/.codex/config.toml` + `<project>/.codex/config.toml` `sandbox_mode` decides — the wrapper writes none, so with neither set codex runs **read-only**. The default is **full access** for two measured reasons (codex 0.153.4, 2026-09-07): codex 0.148+ refuses every MCP tool it deems approval-worthy (no `readOnlyHint` annotation — all `moe.*` tools) whenever `approval_policy = never` meets a sandbox (`MCP tool call requires approval, but approval policy is never`; a headless worker cannot even `start_step`), and on Windows the unelevated sandbox (`[windows] sandbox = "unelevated"`) cannot spawn a Microsoft Store `pwsh.exe` (`CreateProcessAsUserW failed: 5 (Access is denied.)` on every command; `codex sandbox -- pwsh -NoProfile -Command exit` reproduces it with no model call — install the MSI PowerShell 7 to use a sandbox there); without `[windows] sandbox` at all `workspace-write` silently runs read-only. The wrapper also writes `default_tools_approval_mode = "approve"` on the `moe` and `serena` servers in `<project>/.codex/config.toml` (codex 0.147+; older versions ignore the key), so an explicit `workspace-write`/`read-only` keeps MCP tools working. Approval stays `never` in `exec`: the wrapper also pins `-c approvals_reviewer=user` on the headless seat (an `approvals_reviewer = "auto_review"` in the operator's config would otherwise drop that override, as `--full-auto` used to prevent). The wrapper never passes `--full-auto` — codex-cli 0.147+ rejects it (exit 2 at launch, relaunch loop); an unknown value warns and falls back to the default | `danger-full-access` | `workspace-write` |
| `MOE_GROK_MODEL` | Model passed as `-m` to the `grok` CLI when neither `-Model`/`--model` nor `settings.models.{role}` is set; unset = grok's own default (the wrapper never hands its `claude-opus-5` fallback to grok) | Unset | `<model id>` |
| `MOE_GROK_EFFORT` | `--effort <lvl>` for the `grok` CLI; the flag is passed only when this is set | Unset | `high` |
| `MOE_GROK_MCP_STARTUP_TIMEOUT_SEC` | `startup_timeout_sec` for the grok `moe` MCP entry in `.grok/config.toml` (digits only; same daemon-restart race as codex) | `120` | `180` |
| `MOE_TOOL_NAME_STYLE` | Read by **moe-proxy**: `underscore` exposes every daemon tool `moe.<name>` as `moe_<name>` in `tools/list` and maps the alias back on `tools/call` (grok drops dotted tool names — the server showed as connected with 0 tools). The wrapper pins it in grok's `[mcp_servers.moe.env]`; unset = daemon names verbatim (a `moe_<name>` call is still accepted either way) | Unset | `underscore` |
| `MOE_GROK_MCP_TOOL_TIMEOUT_SEC` | `tool_timeout_sec` for the grok `moe` MCP entry (digits only). Grok's own default is 6000s; a response grok fails to decode is simply lost, so the wrapper pins 120s and the model retries. The three blocking long-polls (`moe_wait_for_task`, `moe_chat_wait`, `moe_wait_for_resource`) keep a fixed 720s `tool_timeouts` override | `120` | `300` |
| `GROK_HOME` | **Read by grok, honoured by the wrapper**: grok's config directory (default `~/.grok`). The wrapper writes the folder-trust entry into `<GROK_HOME>/trusted_folders.toml` when it is set | Unset | `D:\grok-home` |
| `XAI_API_KEY` | **Read by grok, not by Moe**: API-key auth for the `grok` CLI. A cached `grok login` (`~/.grok/auth.json`) wins when both exist; the wrapper only warns (non-fatal, `[WARN] XAI_API_KEY is not set and ~/.grok/auth.json is missing …`) when neither is present | Unset | `xai-…` |
| `GROK_CLAUDE_MCPS_ENABLED` / `GROK_CURSOR_MCPS_ENABLED` / `GROK_DISABLE_AUTOUPDATER` | **Set by the wrapper** (not read) for the spawned `grok` process: `0` / `0` / `1` — grok must not auto-merge MCP servers from `~/.claude.json`, `.cursor/mcp.json` or the project `.mcp.json` on top of the wrapper-written `.grok/config.toml`, and must not self-update mid-session | `0` / `0` / `1` (wrapper-set) | — |
| `MOE_FALLBACK_CLI` | Inject `moe-call.sh` fallback instructions into the agent prompt (rare edge case) | Unset | `1` |
| `MOE_DISABLE_TOOL_HOOK` | Claude plugin: disable the PostToolUse hook that forwards `moe.*` tool events to the daemon | Unset | `1` |

---

## Usage Examples

### Windows (PowerShell)

```powershell
# Set environment variables
$env:MOE_PROJECT_PATH = "C:\Projects\MyApp"
$env:LOG_LEVEL = "debug"

# Start daemon
node packages\moe-daemon\dist\index.js start --project $env:MOE_PROJECT_PATH
```

### Mac / Linux (Bash)

```bash
# Set environment variables
export MOE_PROJECT_PATH=/home/user/myproject
export LOG_LEVEL=debug

# Start daemon
node packages/moe-daemon/dist/index.js start --project "$MOE_PROJECT_PATH"
```

### Docker (Optional)

If you are using Docker (not required for most users):

```bash
docker run -e MOE_PROJECT_PATH=/project \
           -e LOG_MAX_SIZE_MB=5 \
           -v /your/project:/project \
           moe-daemon
```

---

## Project Configuration (project.json)

The `.moe/project.json` file contains project-specific settings.

```json
{
  "id": "proj-abc123",
  "schemaVersion": 2,
  "name": "My Project",
  "rootPath": "/path/to/project",
  "globalRails": {
    "techStack": ["TypeScript", "React"],
    "forbiddenPatterns": ["eval(", "any"],
    "requiredPatterns": [],
    "formatting": "Prettier with 2-space indent",
    "testing": "Jest for unit tests",
    "customRules": ["All API calls must use the httpClient wrapper"]
  },
  "settings": {
    "approvalMode": "CONTROL",
    "speedModeDelayMs": 2000,
    "appendOnlyFiles": ["CHANGELOG.md", "docs/**/release-notes.md"],
    "refusalCascadeAutoBacklog": true,
    "autoCommit": true,
    "checkpointCommits": true,
    "checkpointPush": true,
    "commitBoardState": true,
    "commitHooks": false,
    "attribution": { "undeclared": "solo", "contested": "skip-untouched", "exclude": [] }
  }
}
```

### Settings Reference

The JetBrains settings dialog shows the landing and gate settings below (`autoCommit`,
`checkpointCommits`, `checkpointPush`, `commitBoardState`, `commitHooks`, `consolidationBranch`,
`qualityGate`, `qualityGateScope`, `attribution.undeclared`, `taskSizing`) as **read-only
effective values** under "Landing & Gate Policy", labelled as marked below. A key absent from
`project.json` renders the daemon's default there rather than a blank or `false`. Edit them in
`.moe/project.json`.

| Setting | Description | Values |
|---------|-------------|--------|
| `approvalMode` | How plans are approved | `CONTROL` (manual), `SPEED` (auto after delay), `TURBO` (instant) |
| `speedModeDelayMs` | Delay before auto-approval in SPEED mode | Milliseconds (default: 2000) |
| `autoCreateBranch` | **IGNORED LEGACY — no longer affects landing.** No wrapper creates a branch per task: they peel onto `consolidationBranch` else the shared `moe/work-<YYYY-MM-DD>`, reusing an existing non-default branch. See `autoCommit` and `consolidationBranch` for the real policy. Still accepted and stored, so existing `project.json` files load unchanged | Ignored |
| `branchPattern` | **IGNORED LEGACY — no longer affects landing.** `{epicId}`/`{taskId}` are never expanded and no branch name derives from this. See `consolidationBranch`. Still accepted and stored | Ignored |
| `commitPattern` | **IGNORED LEGACY — no longer affects landing.** Commit subjects are fixed by the wrapper: `feat\|fix(task-<id>): <title>` on completion, `wip(task-<id>): …` on checkpoints. See `autoCommit`. Still accepted and stored | Ignored |
| `agentCommand` | CLI the agent launchers spawn | `claude` (default), `codex`, `gemini`, `grok` |
| `autoCommit` | **Dialog: Auto-commit.** Master switch for the wrapper's **land-on-every-exit** post-flight (the wrappers are the only git actors; the daemon never runs git). On: a worker exit at REVIEW/DONE makes a completion commit (`feat(task-<id>): <title>`, or `fix(task-<id>): … (retry after qa_reject #N)` after a reopen) and pushes; every other exit that holds a task (worker/architect/qa — WORKING, BLOCKED, PLANNING, AWAITING_APPROVAL, or a failed status lookup) makes a `wip(task-<id>)` checkpoint; gate/peel/commit failures, ref contention and Ctrl+C teardown go to a rescue ref `refs/moe/rescue/<taskId>/<utc-ts>` (never a branch commit, never pushed). Paths are attributed **per task** from a persisted baseline `<gitdir>/moe/baseline/<taskId>.tsv` (dirty snapshot at pre-flight, pruned after each landing, kept until DONE/ARCHIVED) joined with `moe.get_commit_scope`: ASSERTED (completed-step `modifiedFiles`, `declare_files`, prior commits — committed regardless of baseline), PLANNED (plan-declared, only if changed since baseline), TOOL (stream-json edit harvest), MEASURED (undeclared + changed, per `attribution.undeclared`), BOARD (own task record) are staged; PEER (`MOE_ATTR_PEER_DECLARED`), PREEXISTING (`MOE_ATTR_PREEXISTING` — dirty before the task and untouched, never committed), DENY (`MOE_ATTR_EXCLUDED`) are skipped per path. Staging is `:(literal)` pathspec into a **temp index**, landed with `commit-tree` + `update-ref` CAS (3 attempts) — never `git add -A`/`-u`, never a bare `git commit` against the shared index, no whole-tree fallback, peers' staged entries survive. Every outcome is reported through `moe.record_commit` into `task.commits`. `false` disables completion, checkpoint and rescue commits alike (logged `[info] settings.autoCommit=false`) | `true` (default) / `false` |
| `checkpointCommits` | **Dialog: Checkpoint commits.** `wip(task-<id>): <title> [status=<S> role=<r> cli-exit=<N>]` checkpoint on every non-REVIEW exit of a worker and on every exit of an architect/qa session holding a task; always plumbing (hooks never run). A lingering baseline is landed as a recovery checkpoint (`MOE_CHECKPOINT_RECOVERED`) at the task's next pre-flight | `true` (default) / `false`; `MOE_DISABLE_CHECKPOINT=1` skips per-run |
| `checkpointPush` | **Dialog: Push checkpoints.** Push checkpoint commits to origin (`CHECKPOINT-UNPUSHED task=<id>` in `#general` on failure — a visibility problem, not a loss); `false` keeps them local | `true` (default) / `false` |
| `commitBoardState` | **Dialog: Commit board state.** Stage board records with the landing: the task's own `.moe/tasks/<id>.json` always; `.moe/epics/*.json`, `.moe/project.json` and non-live-peer task records when changed this session. Live peers' task records are never staged | `true` (default) / `false` |
| `commitHooks` | **Dialog: Commit hooks.** `false`: every wrapper commit uses plumbing (temp index + `commit-tree` + `update-ref`) — pre-commit/commit-msg hooks do **not** run; `qualityGate` is the sanctioned gate. `true`: **completion** commits run ordinary Git hooks with a private index and detached HEAD, using the original working directory and effective hooks directory. The resulting tree and parent must match the validated snapshot before the branch is updated by CAS. Hook rejection or tree mutation refuses landing and creates a rescue ref (`[reason=commit-failed]`); checkpoints and rescues stay plumbing. Hooked completion requires an existing HEAD commit; an unborn branch is refused and rescued | `false` (default) / `true` |
| `attribution.undeclared` | **Dialog: Undeclared-file attribution.** A changed path no task declared and no tool wrote: `solo` commits it as MEASURED (recorded in `task.inferredPaths`, never promoted to asserted) only when no other worker is live, otherwise reports it as `MOE_ATTRIBUTION_UNRESOLVED` (persisted in `task.unattributedPaths`, never staged); `never` = declared-only; `always` = commit regardless (single-seat projects) | `solo` (default) / `never` / `always`; `MOE_ATTRIBUTION=declared` forces `never` per-run |
| `attribution.contested` | A path in this task's ASSERTED or TOOL scope that another nonterminal task also declares: `skip-untouched` requires a TOOL witness from this session's supported editing events (otherwise `MOE_ATTR_CONTESTED_UNTOUCHED(task-<peer>)`); `commit` explicitly permits landing without that witness and records `Moe-Contested: <path> (task-<peer>)` in the commit body; `skip` drops it with `MOE_ATTR_CONTESTED`. The current CLI witness limits are described below. Independently of this policy, a landing source file with a supported literal relative import whose target is absent from the resulting commit is held back with `MOE_ATTR_IMPORTEE_MISSING(<specifier>)` | `skip-untouched` (default) / `commit` / `skip` |
| `attribution.exclude` | Extra DENY prefixes (project-relative, forward slashes; no absolute paths or `..`) the wrapper never stages, on top of the built-ins: `.moe/**` except board records, `.mcp.json`, `.codex/**`, `.gemini/**`, `.grok/**`, `.claude/agents/**`, `.claude/settings.local.json`, untracked `.serena/**`, `.worktrees/**`, `.moe-worktree*`. In a multi-project repo (the Moe project nested below the git toplevel) the same built-ins are ALSO denied at the repo root — another fleet's `.moe/**` (board records included) is never staged or attributed by this project's tasks | `[]` (default), e.g. `["generated/", "tmp/"]` |
| `qualityGate` | **Dialog: Quality gate.** Shell command the worker wrapper runs against each frozen **completion** candidate in a disposable clean checkout, not the shared working directory. The command must prepare its own dependencies; shared helpers, ignored files and `node_modules` are not copied or linked. A new CAS candidate reruns the gate. Non-zero exit or tracked checkout mutation sends the frozen bytes to a rescue ref (`rescue(task-<id>): … [reason=gate-failed]` — never the branch, never pushed), keeps the baseline, posts `PUSH-BLOCKED:` + a task comment, and stops the worker loop. See **Frozen quality-gate candidates** below | e.g. `"npm ci && npm test"`; unset/empty disables; `MOE_DISABLE_QUALITY_GATE=1` skips per-run |
| `qualityGateScope` | **Dialog: Quality gate scope.** When the gate runs: only on the epic's final task (highest `order` among siblings) or on every task | `epicFinal` (default) / `everyTask` |
| `deliveryPolicy` | What `moe.qa_approve` requires before a task may reach DONE, judged from **recorded** evidence (the daemon never runs git or the gate). **`legacy`** is the default, and what an absent or `null` value means. It reproduces today's soft gate exactly: approval always lands, with a `NO-COMPLETION-COMMIT` warning when no completion commit is recorded, so an upgrade changes nothing until a project opts in. Every other value is **strict**: approval is refused with `-32003` / `DELIVERY_EVIDENCE_MISSING`, whose message and `context.missingEvidence` name each missing evidence token. **`local-branch`** needs a completion commit recorded in `task.commits` for this work round (at or after the round's start: the latest rejection, else the first step start, else `reviewStartedAt`, so a commit landed from an earlier round never counts); token `completion-commit`. **`remote-push`** needs such a commit recorded as pushed; token `pushed-completion-commit`, and a local-only commit does not count. **`merged-pull-request`** needs the approval to attest the merged pull request (`qa_approve` `mergedPullRequest`); token `merged-pull-request`, and neither a commit nor a `prLink` counts. **`manual-artifact`** needs the approval to attest the deliverable checked by hand (`qa_approve` `manualArtifact`); token `manual-artifact`, and nothing else stands in for it. Under any strict value, a `qualityGate` the wrapper runs for the task also needs a runner-observed exit-0 `CheckRun` on the task's current candidate and that candidate's tree; token `required-check:<qualityGate>`, built from the trimmed setting (a recorded command that differs from it only by surrounding whitespace still counts, because the PowerShell wrapper records the setting verbatim). The wrapper runs the gate only when `qualityGate` is non-blank, `autoCommit` is on, and `qualityGateScope` is `everyTask` or the task is epic-final. The same evidence gates dependents: under a strict value a `DONE` task without its required check keeps withholding the tasks that name it in `dependsOn` or `blockedOnTaskIds`, and an explicit `claim_next_task` of such a dependent is refused with `-32003` / `DEPENDENCY_EVIDENCE_MISSING`. **Judge time vs delivery time:** `deliveryPolicy` itself is read every time evidence is judged (`legacy` short-circuits to satisfied; a strict value asks a task not yet DONE for its landing token). Which check a task owes is read live until DONE; `qa_approve` then records it as `task.requiredCheckAtDone` (the trimmed gate, or `null` when none was owed) from `autoCommit`, `qualityGate`, `qualityGateScope` and whether the task was epic-final among its non-ARCHIVED siblings. It does so under every policy, `legacy` included, so a later archive, reorder, `qualityGate`/`qualityGateScope`/`autoCommit` edit or switch to a strict policy never changes what a DONE or ARCHIVED task owes. A DONE task without the field (approved before it existed, or moved to DONE by `set_task_status` or the board instead of `qa_approve`) is still judged on the live settings, and so is one that reaches DONE again that way after a reopen, which clears the field; a value that is neither a string nor `null` reports `unreadable-required-check`. The wrapper still decides whether to *run* the gate from the live settings; the daemon only records what was owed at approval. An attestation is stored as `task.deliveryEvidence` with `verifiedDelivery: false`, labelled manual and never reported as verified delivery. **`manual-artifact` is the supported strict path for `autoCommit: false` and no-git projects.** An unrecognised value (a typo, a case variant, a non-string) is refused as invalid input on every approval, never silently read as the default. Set it in `.moe/project.json`; the IDE settings dialogs do not edit it | `legacy` (default) / `local-branch` / `remote-push` / `merged-pull-request` / `manual-artifact` |
| `consolidationBranch` | **Dialog: Landing branch.** Branch workers must be on when calling `moe.complete_task`; mismatch rejects with `BRANCH-POLICY-FAIL`, a missing `currentBranch` only warns #governors. A **literal** value (no `*`) also doubles as the wrapper's peel target instead of `moe/work-<date>` when it must leave `main`/`master`/detached HEAD (existing non-default branches are still reused, never switched) | Literal name or `*` glob, e.g. `moe/work-*`; case-sensitive; unset/empty disables |
| `taskSizing` | **Dialog: Plan size limits.** Plan-size thresholds enforced by `moe.submit_plan` (warn past warn values, reject past max values; distinct files = union of step `affectedFiles`). `maxTasksPerEpic` is checked at `moe.create_task` instead and is **advisory** — a warning past the ceiling ("re-slice into sub-epics"), creation never fails. `autoCritique: true` additionally auto-blocks warn-zone plans back to PLANNING in CONTROL mode when no governor is online (capped like governor critique blocks) | `{"warnSteps": 8, "maxSteps": 12, "warnDistinctFiles": 5, "maxDistinctFiles": 10, "maxTasksPerEpic": 40, "autoCritique": false}` (defaults) |
| `pacePerStepMs` | **DEPRECATED — accepted and ignored.** Fed the removed task time-budget feature: a per-step wall-clock allowance that drove a one-shot 80% warning then a 100% escalation to `#governors`. Its clock measured calendar time from the first claim, so it counted BLOCKED time and fired a false "escalate or wrap up" on any transition out of a long park — the whole feature was removed. `moe.submit_plan` no longer reads this key and writes no task time budget, and nothing else consumes it. Still accepted so an existing `project.json` that sets it keeps loading; the key can be deleted at any time | Ignored (any value has no effect) |
| `appendOnlyFiles` | Project-relative globs for files every task appends to; claim-time `fileCollision` warnings skip them so real overlaps stay visible. Forward slashes only; supports literal paths, `*` (matches within one path segment) and `**` (crosses directories, and `**/x` also matches `x` at the root). A supplied array **replaces** the default — include `CHANGELOG.md` yourself if you still want it suppressed; `[]` disables suppression entirely | `["CHANGELOG.md"]` (default), e.g. `["CHANGELOG.md", "docs/**/release-notes.md", "docs/*.md"]` |
| `refusalCascadeAutoBacklog` | Auto-park a task to BACKLOG when `moe.release_task` records a 3rd release inside 24h whose `handoffNote.whatIsDone` reports no progress (`nothing` / `none` / `n/a`, or text starting `nothing…` / `no progress…`). Releases that describe real work, and releases with no handoff at all, never count. Omitting the key leaves it **enabled** — only an explicit `false` disables it | `true` (default) / `false` |
| `enableAgentTeams` | Claude Code subagents for spawned agents | `false` (default) / `true` |
| `chatEnabled` | Agent chat system | `true` (default) / `false` |
| `chatMaxAgentHops` | Max agent-to-agent mention hops | Number (default: 4) |
| `models.{role}` | Per-role model override for the `claude` CLI (`--model`) and the `grok` CLI (`-m`; absent, grok falls back to `MOE_GROK_MODEL`, else its own default — the wrapper's `claude-opus-5` fallback is never passed to grok). Ignored by codex/gemini | e.g. `"models": {"worker": "claude-opus-4-8"}` |
| `columnLimits` | Max tasks per board column (UI hint) | e.g. `{"WORKING": 5}` |
| `staleWorkerTimeoutMs` | Silent-worker prune threshold: workers idle past this that own **no** active work are deleted from the worker map; owners of WORKING/PLANNING tasks are preserved (never idle-released) | Milliseconds (default: 1800000 = 30 min) |
| `reviewStaleTimeoutMs` | REVIEW-only exception: a QA owner silent past this has its REVIEW task released (unassigned, stays REVIEW) so another QA can claim it | Milliseconds (default: 1800000 = 30 min) |
| `reconcileWindowMs` | Bound on the **`reconciling` attempt phase only**. A daemon restart parks every `running` attempt whose task is still assigned to its worker in `reconciling` — it has lost sight of that process and holds the task until a runner reattaches (an attempt whose seat already gave its task up, whether still `running` or parked by an earlier restart, is closed at startup instead, so nothing holds that row). If none ever does, this is how long the attempt may sit there before the sweep closes it and releases the task for **exactly one** successor (the next claim opens the next generation; the sweep opens nothing). **Not a fourth idle timeout**: it is never consulted for a `running` attempt — including one that reattached successfully — or a `finalizing` one, however long either has been quiet, and it is measured from the attempt's own `lastPhaseAt`, never from any worker's `lastActivityAt`. A quiet build is still not evidence of a dead worker, and there is still no idle-based auto-release for WORKING/PLANNING. `reviewStaleTimeoutMs` above is a separate, unrelated and unchanged mechanism (a REVIEW *owner* going silent). A confirmed death still comes only from the wrapper's exit trap calling `moe.deregister_worker`, which closes the attempt immediately without waiting for this window. Values ≤ 0 are ignored and the default is kept | Milliseconds (default: 7200000 = 2 h) |
| `resources` | Declared shared resources for `moe.acquire_resource` leases, keyed by resource id (`[A-Za-z0-9][A-Za-z0-9._-]{0,63}`). Per resource: `capacity` (concurrent leases, 1-100), `maxLeaseMs` (hard cap on any one lease before the sweep force-releases it — bounds a crashed holder; 60000-604800000 ms) and `description` (≤500 chars). Declaring is **optional**: acquiring an undeclared id auto-creates the resource with the defaults, so declare only to override them or to document the resource. A settings update **replaces** the whole map (removal must be possible). Defaults live in `packages/moe-daemon/src/state/resourceStore.ts` (`DEFAULT_RESOURCE_CAPACITY`, `DEFAULT_MAX_LEASE_MS`) | e.g. `{"benchmark-box": {"capacity": 1, "maxLeaseMs": 86400000, "description": "perf rig"}}`; defaults: capacity 1, maxLeaseMs 86400000 (24h) |

With `commitHooks: true`, differing signing or author settings between the original and
private Git contexts refuse landing with `hooked-commit-config-mismatch` under
`MOE_COMMIT_FAILED`; the changes are parked on a rescue ref. No signing attempt or commit hook
runs in that case. Hooks otherwise run with a detached HEAD.

### Frozen quality-gate candidates

A completion that will run a gate has its attributed private-index tree frozen
and recorded with `record_candidate` before the gate starts. Each CAS retry
against an advanced branch tip creates a new candidate and reruns the gate in a
fresh detached worktree; only a retry whose rebuilt tree AND base both equal the
gated candidate's reuses its passed gate (`[info] qualityGate result reused: …`),
so a new base reruns the gate even on an identical tree. A nested Moe project
runs in the corresponding project subdirectory, using Bash on Unix/Git Bash and
ComSpec `/d /s /c` on Windows. A
completion with no gate to run (`qualityGate` unset, `MOE_DISABLE_QUALITY_GATE=1`,
or the `epicFinal` deferral) records no candidate and its landing does not depend
on attempt identity: it lands exactly as it did before candidates existed.

This is a normal full checkout of the candidate: no dirty checkout helpers,
ignored dependencies, linked `node_modules`, or live runtime directories are
copied. Gate commands must install or prepare their own required dependencies.
Generated untracked outputs remain disposable; no gate output is staged or
copied back. Tracked worktree, index or HEAD mutation refuses landing rather
than incorporating formatter fixes; flags that hide a tracked edit
(`assume-unchanged`, `skip-worktree`) are cleared with one batched
`update-index --stdin` before the check. Cleanup stops owned gate descendants and
removes only the owned checkout and its registration, including on gate failure
and handled interruption; there is no quiet-output kill rule. A checkout that
cannot be removed is reported (`Cannot remove owned qualityGate workspace: …;
cleanup will be retried.`) and retried at the next cleanup point; the landing is
decided by the gate's exit code and the tracked-tree check alone, so a cleanup
failure never turns a passing gate into a refusal or stops the loop.

Each command actually started is reported with `record_check_run`, the exact
candidate/tree, actual exit code, `source: runner-observed` and a final 16 KiB
UTF-8 output tail. A skipped or unstarted command produces no CheckRun. An
eligible no-change completion still runs its gate; no-owned/missing-owned
refusals retain their existing meaning. An unborn branch uses the actual empty
Git tree object as `baseRevision`, with a parentless snapshot and root landing;
the separate hook-enabled unborn refusal remains unchanged.

Candidate evidence belongs to the seat's current attempt. When the pinned attempt
is missing, closed or superseded (for example a governor or human closed it with
`finalize_attempt { outcome: 'failed' }`; a QA claim can no longer close it),
parked in `reconciling`, or was never pinned,
the gate is not run and no CheckRun is recorded: the frozen bytes go to a rescue
ref under `MOE_COMMIT_FAILED_GATE` with the ledger message
`qualityGate not run: candidate evidence unavailable (…)`. Nothing is bypassed
and no gate failed, so there is no `PUSH-BLOCKED:` announcement and the landing
does not stop the worker loop; the task's next session lands the bytes.

A CheckRun is an observed command result, not a delivery receipt (see **Delivery
receipts** below). After landing outcome reporting, `finalize_attempt`
acknowledges the exact attempt's result. The post-flight acknowledges only the
seat's own `finalizing` attempt under the identity pinned at claim time, in
both wrappers. A closed attempt (the daemon closes a seat's attempt when a
seat-freeing `report_blocked` or another hand-back releases the task), a
running, reconciling or missing one, or one that no longer matches the pin is
nothing to acknowledge, so an ordinary checkpoint exit — whose attempt is still
`running` — makes no call and the worker keeps claiming; a reconciling, missing
or mismatched record logs `[finalize] no finalizing attempt for this seat on
task <id>; nothing to acknowledge.` A finalizing attempt with no pinned
identity is never acknowledged and stops the loop, as does an acknowledgement
still unanswered after three identical tries, because the daemon refuses the
seat's next claim while its attempt is finalizing. `autoCommit=false` and no-git
projects create no candidates, checks or gate worktrees; a finalizing attempt
there acknowledges `nothing-to-commit`. Gate opt-out and epic deferral policies
are unchanged. `commitHooks` retains its separate private-index/original-working-
directory contract above.

The acknowledgement carries what the exit actually did with the bytes: `landed`
with the 40-hex commit for a branch commit, `nothing-to-commit` for a no-change
landing and for a deliberate no-git or `autoCommit=false` exit, `rescued` when
the bytes were parked on a rescue ref, and `failed` for a refusal or an
unrescued failure. An interrupted session (Ctrl+C, a terminating error) reports
the same way from its exit path — after the teardown rescue and before
`moe.deregister_worker`, which would otherwise close the attempt with nothing
said. A landing interrupted in its push or ledger record keeps the outcome it
already reached — a branch commit is still `landed`, a no-change landing still
`nothing-to-commit` — and nothing is parked on a rescue ref a second time; a
session interrupted before its landing reached an outcome is `rescued` once the
teardown parks its bytes, and `failed` when there was nothing to park. A pre-flight recovery checkpoint belongs to the
previous session and is never reported as this one's landing.

### Delivery receipts

Every landed gated candidate gets one `moe.record_delivery_receipt`, the
landing's last daemon call (after its ledger row, before `finalize_attempt`):
the target ref, where it pointed before (the CAS base: the candidate's
`baseRevision`, git's zero id on an unborn branch) and after, the landed
revision, and the push result. The push result is `null` when no push was
attempted — a repository with no remote at all now skips the push with
`[info] no git remote configured; push skipped, …` instead of failing it — and
otherwise one line of at most 500 characters (`pushed <branch>`, or
`push failed: ` plus git's first `fatal:`/`error:` line). A receipt is what the
wrapper reported; the daemon verifies nothing about the target. A landing with
no candidate (no gate to run, `autoCommit=false`, no git) records none.

The report is journaled at `<gitdir>/moe/receipt/<taskId>.json` before
`update-ref` can move the target (with `push result unknown: the landing
stopped before its push finished` until the push resolves), rewritten once the
push resolved, and deleted once the daemon holds the receipt. A refused or
unanswered receipt never rolls back, re-lands or stops the loop (`[WARN]
delivery receipt not recorded for candidate …; journal kept at … for the next
pre-flight to replay.`); `DELIVERY_RECEIPT_CONFLICT` means a receipt already
records that candidate, and it is not retried. Right after its pre-flight
claim, which a seat whose attempt is still finalizing gets refused, every seat
replays the journals of tasks no other live session holds: when git shows the
journaled revision on the target (its tip or an ancestor) it re-sends the
journaled report verbatim and, for its own journal only, closes the journaled
attempt as `landed`; when git does not, the ref never moved and the journal is
dropped for the baseline recovery. A crash between the ref move and the receipt
therefore records the one missing receipt and never lands the bytes twice.

### Session touch evidence

The wrapper currently obtains per-session TOOL witnesses only from **Claude one-shot
`stream-json` editing events**, including supported native and Serena editing tools. An editing
call contributes only after its matching successful `tool_result`; a failed call or a call
without a result supplies no witness. Codex, Gemini, Grok and interactive Claude do not
currently supply this witness. Their edits can be real while their session's TOOL set remains
empty. A dirty Git tree, a change since baseline,
`moe.declare_files`, `complete_step.modifiedFiles`, or an earlier session's `touchedFiles` does
not establish a current-session TOOL witness. File declarations and completed-step reports
still contribute to ASSERTED scope.

Under the default `skip-untouched` policy, a contested path without that witness remains held
while another nonterminal task declares it. A peer becoming idle or its CLI exiting does not
by itself remove the declaration. Resolve the task ownership through the normal Moe workflow
until the peer declaration no longer applies, or use an explicitly chosen project policy
appropriate to the reviewed ownership arrangement. `contested: "commit"` is permission to
land a whole contested path, not proof that its hunks belong to one session. Editing a file
again does not establish ownership of the other changes already in it. Uncontested paths
continue to follow the existing ASSERTED, PLANNED and MEASURED rules.

The importee guard checks path presence for supported literal relative imports, including
TypeScript source candidates for emitted `.js`, `.mjs` and `.cjs` specifiers. It does not prove
compiler or runtime validity, resolve computed imports, or replace the project quality gate.

### Rails Reference

| Rail | Description | Example |
|------|-------------|---------|
| `techStack` | Technologies used in project | `["TypeScript", "Node.js"]` |
| `forbiddenPatterns` | Code patterns to avoid | `["console.log", "any"]` |
| `requiredPatterns` | Patterns that must be present | `["use strict"]` |
| `formatting` | Code formatting rules | `"ESLint + Prettier"` |
| `testing` | Testing requirements | `"80% coverage required"` |
| `customRules` | Additional project rules | `["Use dependency injection"]` |

---

## Approval Modes

### CONTROL Mode (Default)

- All plans require manual approval
- Human reviews every implementation plan
- Safest for production codebases

### SPEED Mode

- Auto-approves plans after configurable delay
- Allows time to review and reject if needed
- Good for trusted agents on non-critical work

### TURBO Mode

- Instant auto-approval
- No human review before execution
- Use only for fully trusted scenarios

---

## File Structure

```
.moe/
├── project.json       # Project configuration
├── daemon.json        # Runtime state (auto-generated)
├── activity.log       # Event log
├── epics/             # Epic definitions (epic-*.json)
├── tasks/             # Task definitions (task-*.json)
├── workers/           # Worker registrations (worker-*.json)
├── teams/             # Team definitions
├── proposals/         # Pending proposals (proposal-*.json)
├── resources/         # Shared-resource lease state (<resource-id>.json, daemon-written)
├── channels/          # Chat channels
├── messages/          # Chat messages
├── decisions/         # Pinned chat decisions
├── roles/             # Role guides (sha-stamped, auto-upgraded by the daemon)
├── agents/            # Claude Code subagent defs (mirrored to .claude/agents/)
└── skills/            # Vendored skill pack (manifest.json + per-skill dirs)
```

The agent wrapper's landing state lives **outside** `.moe/`, under the repository's git dir: `<gitdir>/moe/baseline/<taskId>.tsv` (per-task dirty-snapshot baseline; `#moe-baseline v1 task=<id> at=<iso> head=<sha>` header, `B`/`U` rows; written at pre-flight, pruned after each landing, deleted when the task is DONE/ARCHIVED) and transient `<gitdir>/moe/idx-<taskId>-<pid>` temp indexes. Rescue snapshots are refs under `refs/moe/rescue/<taskId>/<utc-ts>` (never pushed). `<gitdir>` is `git rev-parse --absolute-git-dir` from the project root.

---

## IDE Plugin Settings

The JetBrains plugin reads settings from project.json but also has IDE-specific preferences:

- **Auto-connect on project open:** Enable/disable automatic connection
- **Notification preferences:** Control which events show notifications
- **Refresh interval:** How often to poll for updates (WebSocket handles real-time)

Access via: Settings > Tools > Moe (when implemented)
