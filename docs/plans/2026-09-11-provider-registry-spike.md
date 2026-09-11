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
| `packages/moe-daemon/src/providers/providerDescriptor.ts` | 195 | The descriptor type. Pure types plus two consts. |
| `packages/moe-daemon/src/providers/codexDescriptor.ts` | 289 | codex, transcribed. Pure data. |
| `packages/moe-daemon/src/providers/providerDescriptor.contract.test.ts` | 297 | Pins the descriptor to both scripts. 20 tests. |

The location is **provisional and load-bearing on nothing**. It sits in the daemon package for one reason: TypeScript and vitest already live there. The daemon is state-only, it does not launch agents, and it must not start doing so because a launch type happens to sit in its tree. Nothing outside `src/providers/` imports any of it. Inside, the codex data file imports the type, and the contract test imports both. Where a registry should actually live is an open question this note does not answer.

### Provider chosen: codex

codex was chosen because it exercises all seven facets with evidence already in the repository: two session modes (interactive TUI default, `exec` headless opt-in), real config construction in `.codex/config.toml`, per-platform sandbox argv, a startup timeout, a reasoning-effort key, a tools-approval pin, and a genuine failure classification (`MOE_CLI_ARGV_REJECTED` stops the seat rather than relaunch-looping).

It was deliberately **not** claude. The claude wrappers diverge most, and the spike needed to learn whether a descriptor handles the ordinary case before the hardest one. Exploration did not change that choice.

## 1. What generalized cleanly

Thirty-one facts are shared. They are identical in both launchers at the level the descriptor records, and the contract test pins each one at the codex construction site of both files. For two of them that level is the key rather than the value, which section 2 comes back to:

- **Session-mode policy.** "Interactive TUI for every role; headless is opt-in per seat" is one shared rule, and the consequence (an interactive seat disables the polling loop) is spelled identically in both wrappers.
- **The exec argv skeleton.** `exec`, `-C <project>`, `--sandbox <mode>` (omitted under `inherit`), `-c approvals_reviewer=user`, and the two per-seat `-c` overrides are the same tokens on both sides.
- **The sandbox vocabulary.** `MOE_CODEX_SANDBOX`, the four accepted modes, the `danger-full-access` default, and the fallback warning sentence are character-for-character the same. This is the single cleanest facet, and not by accident — `parity-check.sh` already pins it.
- **The config key set.** `model_instructions_file`, `model_reasoning_effort`, `project_doc_fallback_filenames`, the three `[mcp_servers.*]` tables, `startup_timeout_sec`, `default_tools_approval_mode = "approve"`, the serena argv, and the three env keys. `developer_instructions` is absent from this list on purpose: its key matches but its value framing does not.
- **Failure classification.** The one real class (`MOE_CLI_ARGV_REJECTED`), its detection (the real argv plus `--help`, probed once per process, matched against the clap parse-error vocabulary), its escalation, its opt-out, and the missing-binary hard error.

That is a real result. The parts of codex launch policy that are *vocabulary* generalize almost perfectly.

## 2. What resisted it

Thirteen facts could not be expressed as a single value. The descriptor encodes each as a per-wrapper pair with a mandatory reason, and the contract test asserts the asymmetry is real — a literal attributed to bash must be absent from the PowerShell wrapper, and vice versa. **Thirteen of 44 transcribed facts diverge, roughly 30%, on the provider picked because it was expected to be the easy one.**

Three of them are behavioural, not cosmetic. These are the ones that matter:

1. **`MOE_DAEMON_HOST` post-discovery upsert — bash only.** The TOML writer runs *before* daemon-host probing in both wrappers, but only the bash wrapper rewrites the config afterwards. A PowerShell run that discovers the host at probe time leaves it out of the written config entirely.
2. **The `[mcp_servers.moe]` proxy command.** PowerShell hardcodes `command = "node"` and always emits `args`. Bash resolves the command, and omits the `args` line altogether when the proxy is a direct executable. The two wrappers can emit *structurally different* MCP blocks for the same project.
3. **The PowerShell argv quote guard.** Under PowerShell below 7.3 every double quote in the prompt is swapped for a single quote before launch. The guard **mutates the prompt text**, so the two wrappers can hand codex different prompt bytes for the same task. Bash needs no analogue.

Two more surfaced only in the adversarial review pass, and they are the most instructive, because both hide behind a key the descriptor had already marked as shared:

4. **TOML value encoding.** The bash writer escapes every string value through `json.dumps`. The PowerShell writer interpolates values raw into a here-string. An operator-set value containing a double quote or a backslash is escaped by one wrapper and written verbatim by the other, which can produce invalid TOML. The keys match; the encoding does not.
5. **Startup-timeout validation.** Both default to 120, but bash parses the variable with python `int()`, which accepts `-5` or ` 42 `, while PowerShell accepts only `^\d+$` and otherwise falls back to 120. The same environment can yield different `startup_timeout_sec` values.

The lesson is general. A descriptor that records *which keys* a launcher writes will look shared long after the *values* have drifted. Any registry that pins keys but not encodings will under-report divergence.

The remaining eight are smaller but still real: both launch banners, the opt-in flag spelling, the `model_instructions_file` argv value (PowerShell forward-slashes the path and emits the override conditionally; bash passes it verbatim and unconditionally), the `developer_instructions` value framing, the owned-section merge matcher form, and the seat instructions file's location and cleanup (bash uses a mode-restricted temp dir and deletes the file after each iteration; PowerShell uses plain `%TEMP%` and never removes it).

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

The consequence is the single most important caveat in this note. **The contract test proves that the descriptor's strings are present at the codex construction sites of the launchers. It does not prove the launchers assemble them in that order, or that the resulting command line matches the descriptor's prose.** No one should read the passing test as argv equality. `scripts/tests/parity-check.sh` has the same ceiling for the same reason; this spike inherits it rather than solving it.

Two further anchoring problems had to be solved before even text presence meant anything:

- **Comments.** Both wrappers document each other. `moe-agent.ps1` names `--codex-exec` in a comment and `moe-agent.sh` names `-CodexExec` in a comment, so raw-text matching would let a divergence assertion succeed against prose. Matching runs against a comment-stripped view. Trailing inline comments still survive stripping.
- **Unrelated occurrences.** Even comment-stripped, whole-file matching turned out to be far weaker than it looks. Of the 65 literals the descriptor declares, **22 also occur outside every codex block** — in the grok config writer, the argument parser or the attribution code. A test matching the whole file would have stayed green with every codex block deleted. The contract test therefore checks presence only inside the codex branches, which it finds by anchoring on each wrapper's own provider dispatch lines. Four facts whose evidence genuinely lives outside any provider branch are allowlisted by name, and the allowlist's size is pinned. **`scripts/tests/parity-check.sh` matches whole files, so it carries exactly this exposure today.**

The test's power was measured rather than assumed, in scratch copies outside the shared checkout:

| Mutation | Whole-file matching | Site-scoped matching |
|---|---|---|
| Delete the codex writer's `[mcp_servers.moe]` line from the PowerShell wrapper, leaving grok's copy in place | **stays green**: the regression is missed | fails, naming the missing table |
| Change a shared literal in the descriptor (`approvals_reviewer=user` to `owner`) | fails | fails |
| Flatten a divergence onto a literal that exists in both wrappers | fails | fails |
| Invent a failure code | fails | fails |

Restoring each mutation returned the suite to green.

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

1. **A migration cannot be verified today.** Without a print-argv mode there is no way to prove that a registry-driven launcher builds the same command line as the one it replaced. Text presence is too weak a check to greenlight moving launch policy out of 11,355 lines of shell. This is the whole argument; the rest is supporting detail.
2. **Centralizing would require picking a winner on five behavioural divergences.** The `MOE_DAEMON_HOST` upsert, the proxy command resolution, the prompt quote guard, the TOML value encoding and the startup-timeout validation genuinely differ in behaviour. A registry that collapses each into one value is a behaviour change wearing a refactor's clothes — and it would ship as "no behaviour change", which is how this kind of work goes wrong.
3. **Building a registry on top of the divergences would freeze them.** Right now they are latent bugs. Encoded as per-wrapper descriptor fields, they become the specification.
4. **The evidence is genuinely mixed, not negative.** Vocabulary generalizes very well; *policy* does not. A registry that only claimed the vocabulary — codes, keys, sandbox modes, banners — would be low-risk and useful. A registry that claimed argv and config construction would be neither, yet.

### Smallest next step that would raise confidence

**Add a print-argv mode to both wrappers** — a flag that resolves the full launch argv and the config it would write, prints them, and exits before spawning anything. It is small, it is symmetric, and it converts every assertion in this spike from "these strings exist in the codex block" to "this is the exact command line, compared against the descriptor".

It is deliberately **not** done here: this task's headline rail is that the wrappers' executed behaviour must not change, and adding a flag means editing both launchers. It belongs in its own task with its own review.

Three follow-ups worth queuing behind it. The first and third are ordered; the second is independent and cheap:

1. **Triage the five behavioural divergences as bugs**, before any registry decides which one is canonical.
2. **Scope `parity-check.sh` the same way the contract test is scoped.** It matches whole files, so a literal that also appears in another provider's block can mask a regression in the block it was meant to guard. This is independent of any registry decision.
3. **Only then** decide whether to transcribe a second provider. If the answer is yes, do **gemini** next, not claude — it is the cheapest way to learn whether the descriptor *shape* survives a second provider, and claude will invalidate the shape if anything will.

### If the decision is to proceed anyway

Proceed vocabulary-first: extend the descriptor to cover codes, config keys, env names and banners for all four providers, and let `parity-check.sh` consume it instead of its hand-maintained lists. That is a real consolidation with a real test behind it, and it does not touch argv construction. Leave argv and config *construction* in the scripts until a print-argv mode exists to check the migration.

## Appendix: verification run for this spike

All run on 2026-09-11.

| Gate | Result |
|---|---|
| `git diff --stat -- scripts/moe-agent.sh scripts/moe-agent.ps1` | empty, before and after the harnesses |
| `npx vitest run src/providers/providerDescriptor.contract.test.ts` | 20 passed, exit 0 |
| `npm --prefix packages/moe-daemon test` | exit 0; 106 files passed and 1 skipped, the skipped one belonging to a concurrent session; the contract test is collected by the normal run |
| `bash scripts/tests/parity-check.sh` | `PASS parity-check.sh`, exit 0, harness unmodified |
| `MOE_POSTFLIGHT_TIMEOUT_SEC=180 bash scripts/tests/postflight.sh` | `PASS postflight.sh`, 25 scenarios, exit 0, harness unmodified |
| `npx tsc --noEmit` in packages/moe-daemon | exit 0 |
