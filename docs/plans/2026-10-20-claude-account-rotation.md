# Claude account rotation: design record and live verification

**Status (2026-10-20):** built and tested in the working tree, not yet committed. This file replaces the first plan for this feature. That plan had a wrapper-owned registry script, a project setting and switching only between launches, and it was dropped in favour of the design below.
**Goal:** Moe runs its claude seats across several Claude subscription (claude.ai) accounts. Seats move to the next account once the active one reaches 90% of any usage window.
**Design:** The daemon owns a machine-level account list. Each account signs in through Claude's own `claude auth login --claudeai`, run in an IDE terminal tab with that account's own `CLAUDE_CONFIG_DIR`. Before every claude launch the wrapper asks the daemon for an account (`moe.lease_account`) and starts the CLI with that account's folder. The CLI's own usage output comes back through `moe.report_account_usage`. When a worker's account is spent, the worker finishes the step it is on and ends its session, and the same task relaunches on the next account.

Contracts: `docs/MCP_SERVER.md` (**Claude Account Rotation**, and the `ADD_ACCOUNT`… WebSocket messages), `docs/SCHEMA.md` (**Claude Accounts**), `docs/CONFIGURATION.md`, `docs/TROUBLESHOOTING.md` (**Claude Account Rotation Issues**).

---

## Anthropic's terms

These are the passages that bear on this setup, quoted from Anthropic's pages:

- Claude Code, Legal and compliance: "Advertised usage limits for Pro and Max plans assume ordinary, individual usage of Claude Code and the Agent SDK." The same page does not prevent "an end user from signing in to the unmodified Claude Code binary with their own Claude subscription". It forbids third parties to "collect, store, or intermediate Claude.ai credentials or session tokens".
- Usage Policy, among prohibited uses: "create multiple accounts, to avoid detection, circumvent product guardrails…", and "Intentionally bypass or interfere with capabilities, restrictions, or guardrails established within our products".
- Consumer Terms: "You may not share your Account login information, Anthropic API key, or Account credentials with anyone else. You also may not make your Account available to anyone else."

What this means here:
- The design respects the credential rules:
  - the claude binary is unmodified;
  - sign-in goes through Anthropic's own flow;
  - Moe never reads, copies or stores a credential.
- It cannot settle the usage question. Rotating several subscriptions so that a fleet of agents keeps running past each account's limit may not count as "ordinary, individual usage", and it could be read as working around usage restrictions.
- If the accounts belong to different people, pooling their logins on one machine also falls under the credential-sharing clause.

**Recommendation:** before rollout, get written confirmation from Anthropic that your setup is allowed. Otherwise, run the agent fleet on API keys (Claude Console) or a Team/Enterprise plan, which are meant for this.

Nothing here works around a limit within an account. Moe only chooses which account a new session uses.

## How it behaves

- **One list per machine.** `~/.moe/claude-accounts.json` (`MOE_ACCOUNTS_FILE` overrides it) holds the accounts in fill order, each with a label and a sign-in state, plus the machine-wide switch point (`switchAtPercent`, 1–100, default 90). Every project's daemon reads the same list. Each account's login lives in its own folder, `~/.moe/claude-accounts/<id>`. Usage lives in `~/.moe/claude-usage/<id>.json`, so a seat in one project sees usage that seats in another project reported.
- **Sign-in is Claude's own.** **Sign in** in the Accounts tab opens an IDE terminal tab that runs `node <daemon dist>/accounts/cli.js login <id>`. That runs `claude auth login --claudeai` with `CLAUDE_CONFIG_DIR` set to the account's folder and the token and cloud-provider variables removed, then checks `claude auth status --json`. Only the exit code and `authMethod` are read: `claude.ai` makes the account a subscription account, any other method marks it "Not a subscription", and Moe never uses such an account. The daemon process itself never runs claude.
- **Fill-first, sticky.** Each lease returns the account launches are already on while it stays eligible, otherwise the first eligible account in list order. An account is eligible when it is signed in with a subscription, no live usage window (5-hour, weekly, …) is at or above the switch point, and it is not parked after a refusal. A spent account becomes eligible again when its window resets.
- **Switch after the current step (workers).** When a worker's account stops being eligible and another account is free, its next `complete_step` reply carries `accountSwitch` with an `ACCOUNT-SWITCH:` instruction. The worker then ends its session without starting another step. As a backstop, `start_step` refuses with `NOT_ALLOWED` `ACCOUNT-SWITCH:` and the step stays PENDING. The wrapper's normal relaunch leases again and gets the next account, and the new session picks up at the next step. A running step is never interrupted, which is why the switch point leaves 10% headroom.
- **Between sessions (QA).** Worker and QA seats launch a fresh one-shot CLI per task, so a QA seat takes the new account at its next launch.
- **Between tasks (interactive seats).** Architect and governor seats are interactive by default and keep one session across tasks. The wrapper loads the `moe-account-switch` mod into such a claude TUI when its loop relaunches it:
  - The mod adds `acceptsAccountSwitch` to `submit_plan` and `chat_wait`.
  - When the seat holds no task and its account must switch, the daemon answers with `accountSwitch`. The architect gets it right after its plan is recorded. The governor gets it at once, or, while parked in `chat_wait`, as soon as a usage report makes the switch due.
  - The model ends its turn. The mod refuses any further claim or wait, runs `/exit` 10 s after the turn ends, and the wrapper's loop leases again.
  - Hard limits have two independent triggers: the existing main-loop `classic.StopFailure` with `error: 'rate_limit'`, and a usage check at every main-loop `turn.complete`, even if an earlier mod swallows `StopFailure`. Any `$.session.usage().rateLimits` window at **100% or more** marks the session for the same delayed `/exit`; it is not restricted to the 5-hour window or to an error completion.
  - Both triggers require a leased seat (`MOE_WORKER_ID` and `MOE_ACCOUNT_ID`) and ignore subagent ends. A failed environment/usage read leaves the completed turn and switch state unchanged; an already-pending daemon switch needs no usage read. Repeated or racing triggers still schedule only one toast and exit, after the unchanged 10-second delay.

  With `MOE_DISABLE_ACCOUNT_SWITCH_MOD=1`, `--no-loop` or a one-shot launch, a seat moves at its next launch.
- **Daemon restart.** Leases live in daemon memory. A running seat's lease is learned back from its wrapper's next usage report, which names only the account the running claude was launched under.
- **Refused launch.** If the CLI exits non-zero and its last usage sample says `rejected` or overage, the wrapper prints `MOE_ACCOUNT_REFUSED` and relaunches at once on the next account. It keeps the task, spends no resume attempt and adds no back-off. The daemon parks the refused account until its window resets, for at least 5 minutes.
- **Signed out mid-run.** After a failed run the wrapper checks the account's folder. If the login is gone or is not a subscription, it prints `MOE_ACCOUNT_SIGNED_OUT`, reports it, and relaunches on the next account.
- **All spent.** The wrapper prints `MOE_ACCOUNT_WAIT`, holds its task, and asks again at the earliest reset, at least every `MOE_ACCOUNT_RETRY_SEC` (default 300 s).
- **Never in the way.** If the daemon cannot answer, the list is unusable, no account is signed in, or a cloud-provider switch (`CLAUDE_CODE_USE_BEDROCK`/`_VERTEX`/`_FOUNDRY`) is set, claude launches exactly as it did before rotation existed. `MOE_ACCOUNT_ROTATION=off` turns rotation off.
- **Visible.** The PyCharm Accounts tab shows each account's sign-in state, 5-hour and weekly usage and status. A header line reads `Claude: <label> N% (active) · …`, and worker cards add the account's label. Activity events are `ACCOUNT_SWITCHED`, `ACCOUNTS_EXHAUSTED` and `ACCOUNT_SIGNED_OUT`. #governors gets 🔁, ⏸️ (once per episode) and 🔑 posts. VS Code ignores the new messages.
- **Scope.** Only claude launches by `scripts/moe-agent.{sh,ps1}` rotate, and the IDE Agents menu runs these. codex, gemini and grok are untouched.

## Where it lives

| Part | Files |
|---|---|
| Account list, usage math, claude probe, CLI | `packages/moe-daemon/src/accounts/{registry,usageWindows,claudeAuth,cli}.ts` (no daemon imports, so any node can run the CLI) |
| Daemon store, view, leases, step-boundary switch | `src/state/accountStore.ts`; `src/tools/{leaseAccount,reportAccountUsage}.ts` (wrapper-only, listed to no role); `src/tools/{startStep,completeStep}.ts`; `src/server/accountMessages.ts` + `WebSocketServer.ts`; `src/index.ts` (`accounts` command, list watch) |
| Daemon tests | `src/accounts/{registry,usageWindows,cli}.test.ts`, `src/state/accountStore.test.ts`, `src/tools/accountTools.test.ts`, `src/server/accountMessages.test.ts`; `vitest.config.ts` points `MOE_ACCOUNTS_FILE` at a file that does not exist |
| Wrappers | `scripts/moe-account-lease.mjs` (gate, pick, sign-in probe, statusline sample); `scripts/moe-agent.{sh,ps1}`; harnesses `scripts/tests/postflight.{sh,ps1}`, `scripts/tests/parity-check.{sh,ps1}` |
| Interactive seats | `scripts/mods/moe-account-switch/` (the mod and its `register.test.ts`), loaded by the `CLAUDE_CODE_PLUGIN_DIRS` block of `scripts/moe-agent.{sh,ps1}` (tested in `scripts/tests/prompt-cache-launcher.test.mjs`); daemon side `src/tools/{submitPlan,chatWait}.ts` (`acceptsAccountSwitch`) and `idleSwitchFor`/`accountSwitchReply` in `src/state/accountStore.ts` |
| PyCharm plugin | `moe-jetbrains/…/model/Models.kt`, `util/MoeJson.kt`, `services/{MoeMessageDispatcher,MoeCommandSender,MoeProjectService,MoeStateListener}.kt`, `util/TerminalAgentLauncher.kt` (`runAccountsCommand`), `toolwindow/{AccountsPanel,AccountPresentation}.kt`, `MoeToolWindowPanel.kt`, `WorkerPanel.kt`, `MoeBundle.properties`; tests `AccountPresentationTest`, `MoeCommandSenderAccountsTest`, `MoeMessageDispatcherAccountsTest`, `TerminalAgentLauncherTest` |
| VS Code | `moe-vscode/src/services/MoeDaemonClient.ts` ignores `ACCOUNTS_UPDATED` and `ACCOUNT_ADDED` |

## Limitations

- Normal daemon switching at 90% waits for a safe step/task boundary; it does not interrupt work. A hard-limit-ended main turn can instead rotate an interactive seat mid-task: the mod checks any reported window at >=100% independently on `turn.complete`, as well as on a delivered `rate_limit` `classic.StopFailure` (V13). Only leased main-loop seats qualify, and usage-read errors fail open. This requires the `moe-account-switch` mod in a TUI whose loop relaunches it; without the mod it keeps its account until it exits. Work already stopped by the hard limit is not guaranteed to have reached a safe task boundary.
- Usage comes from CLI output that is only partly documented (V1–V3 below). If the format changes, rotation falls back to "no data" and keeps using the current account.
- Parallel seats on one account all count against it. Seats that started below the switch point can carry it past 100% before they reach a step boundary. Lower the switch point if many seats run at once.
- An account is known to be spent only after the CLI reports it, so the first launch on it can be refused once. That case relaunches at once.
- One list per machine, per OS user. Under "Run Agents in WSL" the WSL seats use the Windows list and folders through `/mnt/…` paths. A daemon started inside a WSL distro reads that distro's own `~/.moe`. The daemon merges usage by id, so never reuse an id for a different account.
- An account folder replaces `~/.claude` for that launch (V8). User-level settings, `CLAUDE.md`, agents, skills and plugins have to be added to each account folder by hand.
- An `apiKeyHelper` in a project's `.claude/settings.json` outranks the subscription login, and nothing detects it: rotation then has no effect.
- Which seat holds which account is kept in daemon memory. After a daemon restart, a running seat is not told to switch until its wrapper reports usage again.

## What is documented and what is not

Sources are the Claude Code docs (code.claude.com/docs) and `claude auth login --help`. The live verification below fills in the Result column.

| # | Behaviour the design relies on | Status | Checked by | Result |
|---|---|---|---|---|
| D1 | `CLAUDE_CONFIG_DIR` gives each account its own login, settings and history | Documented (Authentication: "To stay signed in to multiple accounts at once… give each account its own configuration directory") | Step 2 | |
| D2 | `claude auth login --claudeai` signs in with a subscription | In `--help` ("Use Claude subscription (default)"). The web CLI reference lists only `--email`, `--sso`, `--console` | Step 2 | |
| D3 | `claude auth status --json` exits 0 when logged in; `authMethod` is `claude.ai` for a subscription | Documented (CLI reference) | Step 2 | |
| D4 | Credentials that outrank a subscription login: `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_API_KEY`, `apiKeyHelper`, `CLAUDE_CODE_OAUTH_TOKEN`, cloud-provider switches | Documented (Authentication precedence) | The CLI and the wrapper strip the three env tokens; a provider switch skips rotation; `apiKeyHelper` is a limitation | |
| D5 | stream-json `rate_limit_event`: `status` (allowed, allowed_warning, rejected), `resetsAt`, `utilization` | Documented (Agent SDK `SDKRateLimitEvent`) | Step 4 | |
| D6 | Statusline input `rate_limits.{five_hour,seven_day}.used_percentage` (0–100) and `resets_at` (epoch s); Pro/Max only, after the first response | Documented (Status line) | Step 7 | |
| D7 | A `-p` session skips onboarding and workspace trust, and connects the project's `.mcp.json` servers without an approval prompt | Documented (Headless) | Step 4 | |
| V1 | `utilization` is a 0–1 fraction | Seen once (0.59); unit not documented | Step 4 | |
| V2 | The CLI emits `rate_limit_event` in ordinary, allowed sessions, and more than once per session | Seen on an allowed session; docs say "when the session encounters a rate limit" | Step 4 | |
| V3 | `rateLimitType`, `unifiedWindows`, `isUsingOverage` | Seen; not documented | Step 4 | |
| V4 | A launch refused at the limit ends with a `rejected` sample and a non-zero exit | Not seen | Step 8 | |
| V5 | First interactive run in a fresh config folder (onboarding, workspace trust, MCP approval) | Not seen | Step 3 | |
| V6 | `--mcp-config` plus an approved `.mcp.json` lists `moe` once in an interactive seat | Not seen | Step 7 | |
| V7 | The statusline `--settings` command works on Windows (quoting, paths with spaces) | Not seen | Step 7 | |
| V8 | Seats work without the operator's user-level `~/.claude` settings, `CLAUDE.md`, agents, skills and plugins | Effect documented (D1); impact on Moe seats not checked | Step 4 | |
| V9 | `claude auth logout` under one `CLAUDE_CONFIG_DIR` signs out only that folder's login | Implied by D1; not seen | Step 6 | |
| V10 | A worker told `ACCOUNT-SWITCH` in `complete_step` ends its session instead of starting the next step | Model behaviour; `start_step` refuses either way | Step 5 | |
| V11 | `$.command.run({ command: 'exit' })` from a mod's timer ends an interactive claude session with exit code 0 | The mod API runs a command as if typed; `/exit` from a mod is not seen | Step 7 | |
| V12 | An interactive architect or governor told `ACCOUNT-SWITCH` ends its turn instead of claiming or waiting again | Model behaviour; the mod refuses the call and ends the turn either way | Step 7 | |
| V13 | At a hard limit, either a delivered main-loop `classic.StopFailure` (`rate_limit`) or the independent main-loop `turn.complete` usage check finds any window at >=100% and schedules one delayed exit, even if an earlier mod swallowed `StopFailure` | Event/usage contracts are documented and version-typed (including API-error completion and percentages above 100). The 2026-10-24 skipped-hook incident is user-reported, not a live observation by this implementation agent | Automated swallowed-hook regression in `hooks/register.test.ts`; a person checks end-to-end exit/relaunch in Step 8 | Automated mock-clock coverage only; real-account end-to-end fallback not verified |
| V14 | A mod's `tool.call` rewrite (`acceptsAccountSwitch: true`) reaches the MCP server as a tool argument | Read in Claude Code 2.1.309: an MCP tool's input schema is a passthrough object, so an extra key is neither refused nor dropped, and a daemon without the parameter ignores it. `claude plugin test` covers the hook, not a live MCP call | Step 7 | |

The design degrades safely when V1–V4 turn out wrong. Without usable samples, the current account simply keeps being used, which is the behaviour before rotation. A refusal that the wrapper misses still parks the account through its `rejected` sample, so the next launch moves on.

## Rules for agents working on this feature

- Never run `claude` with a real Claude config folder. That covers every subcommand: `claude auth login`, `claude auth status`, even `--version`. A real folder means `~/.claude`, anything under `~/.moe/claude-accounts/`, or any `CLAUDE_CONFIG_DIR` you did not create in a temp folder. Tests use a fake claude (`MOE_CLAUDE_BIN` for the daemon CLI, `--command <fake>` for the wrappers), a temp `MOE_ACCOUNTS_FILE`, and a temp `HOME`/`USERPROFILE`.
- Never read, list, copy, print or log a file inside a Claude config folder: credentials, `.claude.json`, settings or history. The code follows the same rule: it creates the empty folder and hands its path to claude.
- From `claude auth status --json`, use only the exit code and `authMethod`. The email and organization it prints are never stored, printed or sent.
- The daemon process never runs claude. The CLI runs in a terminal tab, and the wrappers run the post-failure probe.
- Do not run the live verification. A person runs it.
- No `git add` or `git commit` in a step: the wrappers land the work.

## Live verification (a person runs this)

**Who:** a person at the machine where the logins will live. Every step signs in to a real account, runs claude against a real account folder, or reads what that run shows. Write each outcome in the Result column above. Turn each failure into a task on the Moe board, quoting the line the wrapper printed.

Ground rules:
- Never copy, open or share anything inside an account folder (`~/.moe/claude-accounts/<id>`).
- Do not paste `/status` or `claude auth status` output into Moe chat or a task: it shows the account's email and organization.
- Do not burn usage on purpose to reach a limit. Step 5 forces a switch by lowering the switch point instead.

- [ ] **Step 1: Run every automated check.**

  ```bash
  cd packages/moe-daemon && npm install && npm run build && npm test && cd ../..
  cd packages/moe-proxy && npm install && npm run build && npm test && cd ../..
  node --test scripts/tests/moe-account-lease.test.mjs scripts/tests/prompt-cache-launcher.test.mjs
  CLAUDE_CONFIG_DIR="$(mktemp -d)" claude plugin test scripts/mods/moe-account-switch
  bash scripts/tests/postflight.sh
  bash scripts/tests/parity-check.sh
  cd moe-jetbrains && ./gradlew test buildPlugin && cd ..
  cd moe-vscode && npm test && npm run compile && cd ..
  npm run lint
  ```

  On Windows, also run `pwsh -File scripts/tests/postflight.ps1` and `pwsh -File scripts/tests/parity-check.ps1`. Expect every command to pass.

- [ ] **Step 2: Add and sign in the accounts (checks D1, D2, D3).** Install the plugin and restart PyCharm. In the Moe tool window open **Accounts**. For each account, in the order to use them: **Add…**, type a label, press OK. A terminal tab opens and runs `accounts login acct-N`. Claude opens its claude.ai sign-in page in the browser; sign in with that account. Expect the tab to end with `Signed in: … uses a Claude subscription.` and the row to read **Subscription**. Then press **Check sign-ins**: expect one `subscription` line per account and exit code 0. Without the IDE, the same flow is:

  ```bash
  node packages/moe-daemon/dist/index.js accounts add --label "<who or what>"   # prints acct-N
  node packages/moe-daemon/dist/index.js accounts login acct-N
  node packages/moe-daemon/dist/index.js accounts check
  ```

  A row reading **Not a subscription** means that folder signed in some other way: run **Sign in** again for it.

- [ ] **Step 3: First interactive run per account (checks V5; only if you run interactive seats).** From the project folder, with `CLAUDE_CONFIG_DIR` set to `~/.moe/claude-accounts/acct-N`, run `claude` once per account. Answer the first-run prompts: theme, workspace trust, and approval of the project's `.mcp.json` servers. Run `/usage` and note the 5-hour and weekly percentages for Step 4, then exit. Record in V5 which prompts appeared.

- [ ] **Step 4: One-shot worker on rotation (checks D5, D7, V1, V2, V3, V8).** With the daemon and the plugin running, start a worker from the Agents menu, or run `scripts/moe-agent.sh --role worker --project "$PWD"` (`.ps1` on Windows). Expect `[account] MOE_ACCOUNT_LEASED account=acct-1 usage=…` before the CLI starts. Within about a minute of the seat's first model response:
  - The Accounts tab shows acct-1 **Active, 1 running** and fills its 5-hour column. The header reads `Claude: <acct-1 label> N% (active)`, and the worker card shows the label.
  - `~/.moe/claude-usage/acct-1.json` has a `five_hour` window. It is Moe's own file, with no credential in it.
  - **V1:** N matches the figure `/usage` showed for acct-1, within a point or two. If N is about 100 times too big or too small, the `utilization` unit is wrong.
  - **V2:** during a long task, `sampledAt` in that file moves forward more than once. If it changes only at start and exit, the CLI reports once per session: switching still works, but later.
  - **V3:** once acct-1 has weekly usage, a `seven_day` window appears next to `five_hour`.
  - **D7, V8:** the task runs with no onboarding or trust prompt, and with no permission prompt or missing tool that the same role does not hit under your default `~/.claude`.

- [ ] **Step 5: Forced switch at a step boundary (checks V10 and the switch end to end).** Give the worker from Step 4 a task with several steps. While it works, set **Switch to the next account at** in the Accounts tab to a value at or below acct-1's current percent. Expect:
  - the worker's next `complete_step` returns `accountSwitch`, its terminal shows the `ACCOUNT-SWITCH` instruction, and the session ends without starting the next step (V10). If it calls `start_step` anyway, that call fails with `ACCOUNT-SWITCH` and the step stays PENDING;
  - the wrapper relaunches the same task with `[account] MOE_ACCOUNT_SWITCHED from=acct-1 to=acct-2`, then `MOE_ACCOUNT_LEASED account=acct-2`, and the new session starts the next step;
  - the worker card shows acct-2's label, `.moe/activity.log` has an `ACCOUNT_SWITCHED` line, and #governors has a 🔁 post.

  Set the switch point back to 90. The pool stays on acct-2 until acct-2 itself reaches it: that is the intended fill-first behaviour.

- [ ] **Step 6: Sign-out (checks V9).** Select acct-2, press **Sign out**, confirm. The terminal tab runs `accounts logout acct-2`. Expect `Signed out: …` and the row reads **Signed out**. Every other row still reads **Subscription** after **Check sign-ins**, and the check exits 1 only because acct-2 is signed out. A worker on acct-2 gets `accountSwitch` with reason `signed_out` at its next step boundary. Sign acct-2 in again afterwards.

- [ ] **Step 7: Interactive seat (checks D6, V6, V7).** Run `scripts/moe-agent.sh --role architect --project "$PWD"` (architect is interactive by default). Expect the statusline at the bottom of claude to show the account and its usage, and the Accounts tab to update within a minute.
  - **V6:** `/mcp` lists `moe` once, not twice.
  - **V7:** on Windows, run the same with `scripts/moe-agent.ps1`, ideally on a project whose path contains a space. The statusline must render, and the tab must update.
  - **V11, V12, V14 (forced switch):** also start a governor (`--role governor`). With both seats on acct-1, set **Switch to the next account at** to a value at or below acct-1's percent. Expect:
    - The governor's parked `chat_wait` returns `accountSwitch` within seconds (V14: the daemon only answers it for a call the mod marked). The TUI shows `Moe: Claude account <label> is at N% … This session ends in 10 s and restarts on the next account.` and ends its turn without another `chat_wait` (V12).
    - About 10 s later the TUI exits by itself (V11). The tab prints `[account] MOE_ACCOUNT_SWITCHED from=acct-1 to=acct-2`, and the new session re-enters governance with the unread chat still unread.
    - The architect switches the same way after its next `submit_plan`, and the relaunched session claims the next PLANNING task.
    - A seat started with `--no-loop` shows no toast and stays on acct-1.

    Set the switch point back to 90.

- [ ] **Step 8: A real limit, when one happens (checks V4).** Don't force this. When an account genuinely reaches its limit during normal work, look at the wrapper output:
  - **Expected:** `MOE_ACCOUNT_REFUSED account=acct-N exit=…`, then an immediate relaunch on the next account with no `[launch-failure] Backing off`.
  - **If the CLI exits 0 at the limit:** the wrapper does not see a refusal, but its final sample still marks the account `rejected`, so the next launch must show `MOE_ACCOUNT_SWITCHED`. Record which of the two happened.
  - **If every account is spent:** expect `MOE_ACCOUNT_WAIT retry_in=…`. The task stays held, and work resumes at the first reset.
  - **V13, in an architect or governor TUI:** expect the toast `Moe: this Claude account reached its usage limit. This session ends in 10 s …`, then a relaunch with `MOE_ACCOUNT_SWITCHED`. If the TUI stays at the limit with no toast, record what claude showed.

- [ ] **Step 9: WSL agent mode (only if you use "Run Agents in WSL").** Install claude and node inside the distro. With the toggle on, **Sign in** runs the CLI with the distro's node against the Windows list through `/mnt/…` paths. Repeat Step 4 with the toggle on: the lease must name the same accounts, and `MOE_ACCOUNT_LEASED` must appear in the WSL seat's output.
