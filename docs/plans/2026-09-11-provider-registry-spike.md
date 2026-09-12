# Provider registry spike — can launch policy be centralized?

**Date:** 2026-09-11
**Task:** task-dd7397244d9247679f1aebbe780d0475 (Wave 1: one reliable delivery path)
**Status:** decision input. This note is a **recommendation, not a decision**. The task has no dependents; it exists so that whoever decides is deciding on measurement instead of intuition.

## The question

The roadmap calls a typed provider registry the enabling refactor for launcher work, and in the same breath warns against a wholesale launcher rewrite before a vertical slice proves the contract. This spike takes the cheapest possible reading of "prove the contract": transcribe **one** provider's full launch contract into a typed descriptor, pin that descriptor to the scripts with a test, and report what did and did not survive the transcription.

Nothing here changes launcher behaviour. Both wrappers are byte-identical to their state before the spike.

## What was built

| Artifact | Lines | What it is |
|---|---|---|
| `packages/moe-daemon/src/providers/providerDescriptor.ts` | 218 | The descriptor type. Pure types plus two consts. |
| `packages/moe-daemon/src/providers/codexDescriptor.ts` | 460 | codex, transcribed. Pure data. |
| `packages/moe-daemon/src/providers/providerDescriptor.contract.test.ts` | 411 | Pins the descriptor to both scripts. 23 tests. |

The location is **provisional and load-bearing on nothing**. It sits in the daemon package for one reason: TypeScript and vitest already live there. The daemon is state-only, it does not launch agents, and it must not start doing so because a launch type happens to sit in its tree. Nothing outside `src/providers/` imports any of it. Inside, the codex data file imports the type, and the contract test imports both. Where a registry should actually live is an open question this note does not answer.

### Provider chosen: codex

codex was chosen because it exercises all seven facets with evidence already in the repository: two session modes (interactive TUI default, `exec` headless opt-in), real config construction in `.codex/config.toml`, per-platform sandbox argv, a startup timeout, a reasoning-effort key, a tools-approval pin, and a genuine failure classification (`MOE_CLI_ARGV_REJECTED` stops the seat rather than relaunch-looping).

It was deliberately **not** claude. The claude wrappers diverge most, and the spike needed to learn whether a descriptor handles the ordinary case before the hardest one. Exploration did not change that choice.

## 1. What generalized cleanly

Thirty facts are shared: identical in both launchers at the level the descriptor records. Each one is pinned by the contract test, at two different strengths that are worth keeping apart:

- **Emitter-pinned — 18 of the 30.** Every fact the scripts write into `.codex/config.toml` or put on argv, plus the argv probe. The evidence is per-wrapper and can only be satisfied by the line that actually writes the value; 41 of those literals are required by the test, and the requirement is itself asserted so a new config fact cannot skip it. Proven by deleting each of those lines in turn — see the red-proof table below.
- **Branch-present — the other 12.** `cliTypeToken`, the session-mode policy, the four sandbox facts, prompt delivery, resume, polling suppression, and three of the failure facts. Their evidence is a literal that occurs inside the codex branch; that is enough while each occurs once per branch, and it is not claimed to be more. Four of the twelve are weaker still and matched against the whole file, because their evidence genuinely lives outside any provider branch: two of them point at the TUI polling-suppression block that codex, gemini and grok share, one at the `--codex-exec` flag (parsed before any branch), and one at wrapper-level resume. Those four are allowlisted by name and the allowlist's size is asserted.

For two of the thirty the level that matched is the key rather than the value, which section 2 comes back to:

- **Session-mode policy.** "Interactive TUI for every role; headless is opt-in per seat" is one shared rule, and the consequence (an interactive seat disables the polling loop) is spelled identically in both wrappers.
- **The exec argv skeleton.** `exec`, `-C <project>`, `--sandbox <mode>` (omitted under `inherit`), `-c approvals_reviewer=user`, and the two per-seat `-c` overrides are the same tokens on both sides.
- **The sandbox vocabulary.** `MOE_CODEX_SANDBOX`, the four accepted modes, the `danger-full-access` default, and the fallback warning sentence are character-for-character the same. This is the single cleanest facet, and not by accident — `parity-check.sh` already pins it.
- **The config key set.** `model_instructions_file`, `model_reasoning_effort`, the three `[mcp_servers.*]` tables, `startup_timeout_sec`, `default_tools_approval_mode = "approve"` on both servers, the serena argv, and the three env keys — of which `MOE_WORKER_ID` is never written into the file at all: the config is shared by every seat on the project, so the worker id rides argv as `-c mcp_servers.moe.env.MOE_WORKER_ID=`. Two keys are absent from this list on purpose. `developer_instructions` matches as a key but not as a value framing, and `project_doc_fallback_filenames` matches on a fresh config but diverges on merge — both belong in section 2.
- **Failure classification.** The one real class (`MOE_CLI_ARGV_REJECTED`), its detection (the real argv plus `--help`, probed once per process, matched against the clap parse-error vocabulary), its escalation, its opt-out, and the missing-binary hard error.

That is a real result. The parts of codex launch policy that are *vocabulary* generalize almost perfectly.

## 2. What resisted it

Fourteen facts could not be expressed as a single value. The descriptor encodes each as a per-wrapper pair with a mandatory reason, and the contract test asserts the asymmetry is real — a literal attributed to bash must be absent from the PowerShell wrapper, and vice versa. **Fourteen of 44 transcribed facts diverge, roughly 32%, on the provider picked because it was expected to be the easy one.**

Five of them are behavioural: the same input produces a different result depending on which wrapper ran. These are the ones that matter.

1. **The `[mcp_servers.moe]` proxy command.** PowerShell hardcodes `command = "node"` and always emits `args`. Bash resolves the command, and omits the `args` line altogether when the proxy is a direct executable. The two wrappers can emit *structurally different* MCP blocks for the same project.
2. **The PowerShell argv quote guard.** Under PowerShell below 7.3 every double quote in the prompt is swapped for a single quote before launch. The guard **mutates the prompt text**, so the two wrappers can hand codex different prompt bytes for the same task. Bash needs no analogue.
3. **TOML value encoding.** The bash writer escapes every operator-controlled string value through `json.dumps`. The PowerShell writer interpolates values raw into a here-string. An operator-set value containing a double quote or a backslash is escaped by one wrapper and written verbatim by the other, which can produce invalid TOML. (Not literally *every* value: `developer_instructions` interpolates the role into the bash here-doc raw. That is safe only because the role is validated against a fixed set at parse time — which is the kind of qualifier a descriptor has to carry, or it states something false.)
4. **Startup-timeout validation.** Both default to 120, but bash parses the variable with python `int()`, which accepts `-5` or ` 42 `, while PowerShell accepts only `^\d+$` and otherwise falls back to 120. The same environment can yield different `startup_timeout_sec` values.
5. **The `project_doc_fallback_filenames` merge fix-up.** Both wrappers write the same two-entry list into a *fresh* config. On an *existing* config they do not agree: bash replaces only the exact string `project_doc_fallback_filenames = ["CLAUDE.md"]`, while PowerShell regex-rewrites any list containing `"CLAUDE.md"`. Re-simulated here by running both replacements over three inputs: on the canonical `project_doc_fallback_filenames = ["CLAUDE.md"]` they agree, but on `["CLAUDE.md", "AGENTS.md"]` and on a no-space `project_doc_fallback_filenames=["CLAUDE.md"]` PowerShell adds `.codex/agent-instructions.md` to both and bash to neither — so on any config that is not written in exactly the canonical form, a codex seat launched by the bash wrapper never picks up the agent instructions doc while its PowerShell twin does.

Items 3, 4 and 5 all hide behind a key the first pass of this descriptor had marked as *shared*, and item 5 was found only after review challenged the transcription. The lesson is general, and it is the most transferable thing in this note. **A descriptor that records *which keys* a launcher writes will look shared long after the *values*, the encodings and the merge rules have drifted.** Any registry that pins keys but not the code that emits them will under-report divergence — which is exactly what the first version of the contract test did, and why it now pins the emitting line.

One further divergence is a **feature asymmetry** rather than a disagreement, and it is worth separating because the first transcription got it wrong and called it a latent PowerShell bug:

6. **Daemon-host discovery and the `MOE_DAEMON_HOST` upsert — bash only.** `moe-agent.ps1` never assigns `MOE_DAEMON_HOST`; it only reads it. The only discovery anywhere is the bash cross-boundary WSL probe, which exports the candidate it reaches, and the post-discovery upsert exists to persist exactly that into `[mcp_servers.moe.env]`. A PowerShell run that discovers a host at probe time cannot happen. Both wrappers write a *pre-set* host identically. So there is no winner to pick here — but a registry still has to model "this launcher has a step the other does not", which no single value expresses.

The remaining eight are smaller but still real: both launch banners, the opt-in flag spelling, the `model_instructions_file` argv value (PowerShell forward-slashes the path and emits the override conditionally; bash passes it verbatim and unconditionally), the `developer_instructions` value framing, the owned-section merge matcher form, and the seat instructions file's location and cleanup (bash uses a mode-restricted temp dir and deletes the file after each iteration; PowerShell uses plain `%TEMP%` and never removes it).

### A transcription rule the spike had to learn: follow the code, not the comment

The bash wrapper's cleanup comment claims the EXIT trap also removes the secure temp directory. It does not. `create_secure_temp` caches its path in `SECURE_TEMP_DIR`, but every call site invokes it inside `$(...)`, so the assignment never escapes the subshell: the parent's variable stays empty and `cleanup_temp`'s `rm -rf` is a no-op against an empty path. Each call leaves a `mktemp -d` directory behind. The descriptor records what the code does and names the false comment; **fixing the leak is out of scope here, because it would edit a launcher.** The general point for any future registry: a transcription that trusts comments will encode intentions as if they were behaviour.

### Values computed at runtime, not fixed

The descriptor can name a key but not its value for: the sandbox mode (`MOE_CODEX_SANDBOX`), the reasoning effort (`MOE_CODEX_REASONING_EFFORT`), the MCP startup timeout, the daemon host, the resolved proxy command, the seat instructions path, the project path, the worker id, and the prompt itself. A registry that wanted to *build* argv rather than describe it would have to take all of these as inputs — which is to say the registry would be a function of the environment, not a table.

### Facets with no answer for this provider

Three, each carrying an explicit `unsupported` marker with a reason:

- **Tool event stream — none.** Neither wrapper requests or parses a machine-readable event stream from codex. Whether codex itself could supply one is not established by this spike; the gap is in the wrappers either way. The `stream-json` parser, `MOE_TOOL_WRITES_FILE` and the whole TOOL attribution tier are **claude-only**. A codex seat can therefore never reach the TOOL tier; its paths are attributed ASSERTED, PLANNED or MEASURED only. This is a load-bearing asymmetry in the commit-attribution design that a provider registry would make visible for the first time.
- **Partial messages — none.**
- **CLI session resume — none.** Neither wrapper passes any codex resume flag. Resume is wrapper-level and provider-agnostic (`claim_next_task` returns `hasNext:false` + `alreadyAssigned`, the wrapper relaunches with a RESUME prompt, capped by `MOE_RESUME_MAX_ATTEMPTS`). So resume is not a property of the provider at all, and putting it in a provider registry would be a modelling error.

These markers deliberately carry **no evidence literals**. Text presence cannot prove an absence, and a descriptor that implied otherwise would be lying.

### The decisive limitation: no dry-run mode

**Neither wrapper has a dry-run or print-argv mode.** This was checked, not assumed: a search for `dry-run`, `print-argv`, `show-command`, `noop` and `no-launch` returns zero hits across both files. The only argv introspection that exists anywhere is the codex probe, which appends `--help` to the *real* argv so the CLI short-circuits before any model call — it exists to detect a rejected flag, and prints nothing about the command line.

The consequence is the single most important caveat in this note. **The contract test proves that the descriptor's strings are present at the codex construction sites of the launchers, and that deleting the line which emits any of them turns the suite red. It does not prove the launchers assemble those tokens in that order, or that codex receives the command line the descriptor's prose describes.** No one should read the passing test as argv equality. `scripts/tests/parity-check.sh` has the same ceiling for the same reason; this spike inherits it rather than solving it.

Three further anchoring problems had to be solved before even text presence meant anything. Each was found by measurement, and the third only after review:

- **Comments.** Both wrappers document each other. `moe-agent.ps1` names `--codex-exec` in a comment and `moe-agent.sh` names `-CodexExec` in a comment, so raw-text matching would let a divergence assertion succeed against prose. Matching runs against a comment-stripped view. Trailing inline comments still survive stripping.
- **Unrelated occurrences, elsewhere in the file.** Even comment-stripped, whole-file matching is far weaker than it looks. Of the 68 presence literals the descriptor declares, **23 also occur outside every codex block** — in the grok config writer (which duplicates the codex TOML shape), the argument parser or the attribution code. A test matching the whole file would have stayed green with every codex block deleted. The contract test therefore checks presence only inside the codex branches, found by anchoring on each wrapper's own provider dispatch lines. Four facts whose evidence genuinely lives outside any provider branch are allowlisted by name, and the allowlist's size is pinned. **`scripts/tests/parity-check.sh` matches whole files, so it carries exactly this exposure today.**
- **Unrelated occurrences, *inside the same branch*.** Site scoping is still not enough. The bash codex writer's merge filter repeats its own table names as `startswith("[mcp_servers.moe]")` arguments, and names a python variable `startup_timeout_sec` after the TOML key it computes — all within the codex branch. Deleting the lines that actually *emit* `[mcp_servers.moe]`, `[mcp_servers.moe.env]`, `[mcp_servers.serena]` or the startup timeout left a site-scoped presence test green. PowerShell escaped this only by accident: its merge filter uses escaped regexes, so its bare table headers stay emitter-unique. The fix is per-wrapper `emitterEvidence` — for bash the quoted-with-comma form `"[mcp_servers.moe]",` that only the emitting list entry carries. Even then, **9 of the 38 emitter literals still have copies outside the codex blocks**, in the grok writer; site scoping is what saves those, so the two mechanisms are both load-bearing.

The same trap applies per *session mode*: bash repeats `-c "mcp_servers.moe.env.MOE_WORKER_ID=$WORKER_ID"` at three sites (the interactive launch, the exec launch and the argv probe), so deleting one left the others to satisfy a token-level assertion. Each mode is now pinned to its **whole launch invocation as one literal** — line continuations joined — so dropping a single `-c` from one mode breaks that mode's literal and nothing else covers it.

**Stated rather than hidden.** Three things the pin does *not* reach:

- PowerShell builds one `$codexSeatArgs` array and splats it into both launches, so its two modes cannot be pinned independently. A token dropped there is caught, but not attributed to a mode.
- The twelve branch-present shared facts listed in section 1 — `cliTypeToken`, session-mode policy, the sandbox vocabulary, prompt delivery, resume, polling suppression and three failure facts — are pinned by branch presence only. None of them is written into a config file or onto argv, which is why the requirement stops there.
- Divergent facts are *structurally* required to carry only per-wrapper literals, not emitter-unique ones. In practice the sweep deleted the emitting line of every divergent config fact too — `developer_instructions`, the proxy `command`/`args` lines, the owned-section strip rule and the `project_doc_fallback_filenames` fix-up, in both wrappers — and all of them went red. That is a measurement, not a guarantee the type system enforces.

The test's power was measured rather than assumed, in a throwaway worktree — never in the shared checkout, whose launchers peers' wrapper runs read live.

**Delete-the-emitter sweep.** For every config fact, both launch invocations, both argv probes and the per-seat override builders, the emitting line was deleted and the suite re-run: **46 mutations, 22 in `moe-agent.sh` and 24 in `moe-agent.ps1`, all 46 red.** That includes the five that were green before this pass — `sh:876` `"[mcp_servers.moe]",`, `sh:881` the startup-timeout append, `sh:891` `"[mcp_servers.moe.env]",`, `sh:907` `"[mcp_servers.serena]",` and `sh:5303` the interactive launch's `-c mcp_servers.moe.env.MOE_WORKER_ID=`. **No green rows remain, so there is no config fact this note has to disclose as unpinnable.** Each mutation was restored by `git checkout` with a post-restore diff guard that aborts the sweep on any failure.

**Descriptor-side and control mutations:**

| Mutation | Result |
|---|---|
| Change a shared literal in the descriptor (`approvals_reviewer=user` → `owner`) | red — shared-presence assertion |
| Reintroduce `--full-auto` into `moe-agent.sh` | red — forbidden-token *and* emitter assertions |
| Flatten the `daemonHostUpsert` divergence into a shared fact | red — fact-count and emitter assertions |
| Swap a divergent fact's bash-only literal for one present in both wrappers | red — asymmetry assertion |
| Invent a failure code | red — negative-direction assertion |
| Delete `emitterEvidence` from a config fact | red — the new requirement bites |
| **Control:** weaken the test back to whole-file matching, then delete the PowerShell codex `[mcp_servers.moe]` line (grok's copy remains) | **stays green** — which is what proves site scoping is still load-bearing |

Restoring each mutation returned the suite to green, and both launcher blobs were verified byte-identical afterwards.

## 3. What extending this would cost

The two scripts together are **11,355 lines** (6,141 bash + 5,214 PowerShell). Footprint of the remaining providers, by comment-stripped mention count:

| Provider | bash | PowerShell | Transcription difficulty |
|---|---|---|---|
| codex (done) | 69 | 75 | baseline — one task |
| gemini | 33 | 55 | easiest; the thinnest surface of the four |
| grok | 72 | 108 | hardest by volume |
| claude | 39 | 28 | hardest by structure, despite the smallest footprint |

**claude is the hard case, and mention count hides it.** Its two wrappers deliver MCP config by *structurally different mechanisms*: the bash wrapper merges `~/.config/claude/mcp_servers.json` and writes the project `.mcp.json`, while the PowerShell wrapper writes a temp file and passes `--mcp-config`. It is also the only provider that runs in the launcher's own working directory in one wrapper, while every other launch path either changes into the project or passes it with `-C` or `--cwd`. And it is the only provider with an event stream, which drags the `stream-json` parser, `MOE_TOOL_WRITES_FILE` and the TOOL attribution tier into any descriptor that claims to cover it.

**grok is hard by accumulated exception.** It carries constraints no other provider has: dotted MCP tool names are silently dropped so the proxy must expose `moe_<name>`, folder trust must be pre-granted in `trusted_folders.toml` or the MCP servers never spawn, its project config may carry *only* `[mcp_servers.*]`/`[plugins]`/`[permission]`/`[mcp]` tables, `${VAR:-default}` is expanded per process so the worker id is written literally, three auto-merge environment variables must be disabled, and the blocking long-polls need per-tool timeout overrides. Each of those is a field no other provider uses.

Honest estimate, transcription only: **gemini ≈ 0.75×, grok ≈ 1.5–2×, claude ≈ 2–3×** the codex effort, so roughly **4–6 more tasks of the same size** to describe all four providers. That buys documentation and a regression test. It changes no behaviour.

The migration itself — making the scripts *consume* the registry instead of building launch policy inline — is a different and much larger number, and it is the thing the roadmap actually wants. This spike deliberately did not estimate it, because the divergences above mean it cannot be scoped until they are resolved.

## 4. Recommendation

**Against starting a staged migration now. For one narrow prerequisite first.**

The reasoning, in order of weight:

1. **A migration cannot be verified today.** Without a print-argv mode there is no way to prove that a registry-driven launcher builds the same command line as the one it replaced. This spike pushed text matching about as far as it goes — the emitting line of every config fact and every launch invocation now turns the suite red when deleted — and that is still only evidence that the *scripts say* these things, never that codex *receives* them. It would not catch a reordered flag, a token that never reaches the child process, or a value that is right in the source and wrong after expansion. Too weak to greenlight moving launch policy out of 11,355 lines of shell. This is the whole argument; the rest is supporting detail.
2. **Centralizing would require picking a winner on five behavioural divergences, plus a decision on one feature asymmetry.** The proxy command resolution, the prompt quote guard, the TOML value encoding, the startup-timeout validation and the `project_doc_fallback_filenames` merge genuinely differ in behaviour; the bash-only daemon-host discovery is a step one wrapper simply does not have. A registry that collapses each into one value is a behaviour change wearing a refactor's clothes — and it would ship as "no behaviour change", which is how this kind of work goes wrong.
3. **Building a registry on top of the divergences would freeze them.** Right now they are latent bugs. Encoded as per-wrapper descriptor fields, they become the specification.
4. **The evidence is genuinely mixed, not negative.** Vocabulary generalizes very well; *policy* does not. A registry that only claimed the vocabulary — codes, keys, sandbox modes, banners — would be low-risk and useful. A registry that claimed argv and config construction would be neither, yet.

### Smallest next step that would raise confidence

**Add a print-argv mode to both wrappers** — a flag that resolves the full launch argv and the config it would write, prints them, and exits before spawning anything. It is small, it is symmetric, and it converts every assertion in this spike from "these strings exist in the codex block" to "this is the exact command line, compared against the descriptor".

It is deliberately **not** done here: this task's headline rail is that the wrappers' executed behaviour must not change, and adding a flag means editing both launchers. It belongs in its own task with its own review.

Three follow-ups worth queuing behind it. The first and third are ordered; the second is independent and cheap:

1. **Triage the five behavioural divergences as bugs**, before any registry decides which one is canonical — and decide separately whether the PowerShell wrapper should grow daemon-host discovery, which is a product question, not a refactor one. Two further defects surfaced in transcription and are deliberately *not* fixed here, because both would edit a launcher: the leaked `mktemp -d` directory per `create_secure_temp` call (and its false cleanup comment), and the PowerShell seat instructions file that is written to plain `%TEMP%` and never removed.
2. **Scope `parity-check.sh` the same way the contract test is scoped, and pin its literals to emitters.** It matches whole files, so a literal that also appears in another provider's block can mask a regression in the block it was meant to guard — and even scoped, a bare TOML key is satisfied by the merge filter that strips it. Both holes were measured here. This is independent of any registry decision.
3. **Only then** decide whether to transcribe a second provider. If the answer is yes, do **gemini** next, not claude — it is the cheapest way to learn whether the descriptor *shape* survives a second provider, and claude will invalidate the shape if anything will.

### If the decision is to proceed anyway

Proceed vocabulary-first: extend the descriptor to cover codes, config keys, env names and banners for all four providers, and let `parity-check.sh` consume it instead of its hand-maintained lists. That is a real consolidation with a real test behind it, and it does not touch argv construction. Leave argv and config *construction* in the scripts until a print-argv mode exists to check the migration.

## Appendix: verification run for this spike

All run on 2026-09-11. The second block is the re-verification after review found the two blind spots in section 2.

| Gate | Result |
|---|---|
| `git hash-object scripts/moe-agent.sh scripts/moe-agent.ps1` | `f64bdb88272f01b5904ea895211e0730c5e23716` / `f456b7d14e05c42307e6dd515863a8cdfaf367e2` — unchanged from the pre-spike baseline, in the checkout and in the mutation worktree |
| `git diff --stat -- scripts/moe-agent.sh scripts/moe-agent.ps1` | empty, before and after the harnesses and after every mutation |
| `npx vitest run src/providers/providerDescriptor.contract.test.ts` | 23 passed, exit 0 |
| `npm --prefix packages/moe-daemon test` | exit 0; 109 files passed and 1 skipped, 1,460 tests passed and 6 skipped |
| `npx vitest list --filesOnly` | the contract test is 1 of the 110 files the default config collects — it runs in the normal suite, not only by an explicit path, and adds no test runner |
| `bash scripts/tests/parity-check.sh` | `PASS parity-check.sh`, exit 0, harness unmodified |
| `MOE_POSTFLIGHT_TIMEOUT_SEC=300 bash scripts/tests/postflight.sh` | `PASS postflight.sh`, 25 commit-scope scenarios, exit 0, harness unmodified |
| `npx tsc --noEmit` in packages/moe-daemon | exit 0 |
| Mutation sweep, throwaway worktree | 46 delete-the-emitter mutations red, 7 descriptor/launcher mutations behaving as tabulated above |

The two harnesses were run sequentially, `parity-check` then `postflight`, with `MOE_POSTFLIGHT_TIMEOUT_SEC=300` — the default 60s per wrapper flakes on a box running the fleet's own suites, and the heartbeat-sidecar check is the first to go. The log contains zero `FAIL` lines; the four case-insensitive `fail` matches are scenario *titles* (Q, V, R, X) about gate, status-lookup, peel and hook failures, not failures of the harness.
