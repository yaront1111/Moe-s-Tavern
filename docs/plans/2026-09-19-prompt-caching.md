# Strict prompt caching implementation plan

**Goal:** Preserve reusable Claude and Codex prompt prefixes in every project launched through Moe and expose measured cache usage.
**Architecture:** Moe runs provider CLIs, which own API caching. Keep stable role instructions separate from private task context, refuse known Claude cache-disable controls before launch, and consume provider usage counters without inventing savings or unsupported Codex settings. Package shared helpers with both IDEs.
**Tech Stack:** PowerShell 5.1/7, Bash, Node ESM, node:test, existing provider contract tests.

1. Reproduce the existing Codex task-context/system-instruction mixing and Claude Windows overflow with tests executing the actual launcher sections. Compare two tasks with identical role text and require identical system bytes while retaining exact task text separately.
2. Add shared policy and usage helpers. Test cache-disable environment/settings refusal, explicit inherited policy, malformed settings, unknown usage, Claude disjoint read/write/input counters, and Codex cached tokens as a subset of input. No model calls are needed.
3. Update both launchers: stable Codex instructions plus a private context file referenced by the user prompt; Claude overflow in a private user-context file; team/known-issue context after stable instructions. Keep task binding and native exit codes intact.
4. Report Claude result usage and Codex headless JSON usage. Test real subprocess streams, malformed events, multiple turns, missing counters, and nonzero child exit codes. Interactive CLIs retain their native usage displays.
5. Bundle helper files in JetBrains and VS Code; update the Codex descriptor to match actual argv. Document default policy, limits, provider-owned retention, and deployment requirements.
6. Run prompt-cache tests, existing taskless/mention/launcher parity checks, daemon provider contract tests and daemon regression tests. Verify unrelated dirty files against the recorded hash baseline. Leave a reviewable uncommitted change; do not publish or restart live agents.

## Execution evidence

- Original source baseline: `021f351c34f895fd6a7924b034af4a5997e413db`. Another live wrapper created `469ed6d` during implementation and included an intermediate version of `scripts/moe-agent.ps1`; use the original baseline when reviewing the complete feature. This session did not commit or push. All 18 initially dirty non-task files retained their original hashes; daemon task records changed independently.
- Focused/runtime/taskless tests: 79 passed, including 18 prompt-cache tests. Provider descriptor contracts: 23 passed. Daemon suite: 123 files / 2,154 tests passed. TypeScript compilation passed.
- Bash and PowerShell parity passed (`LC_ALL=C` for Git Bash's emoji matching). Installed Codex and Claude accepted the cache-related argv in offline help probes.
- Windows PowerShell 5.1 and PowerShell 7 mention provenance: all 10 cases passed in both modes. Bash: all four modes passed with a bounded one-second taskless wait, as did the original baseline under the same setting; an earlier run timed out before launch.
- Isolated real-wrapper Codex lifecycle scenarios passed: PowerShell Z and Bash Z/Z2 (headless/TUI, sandbox settings, rejected argv, failure exit reporting, checkpoint attribution, task-context separation and cleanup). The Command-banner assertions were updated for `--json`.
- The initial full PowerShell lifecycle run stopped in Z; the corrected isolated Z passed. The full Bash lifecycle harness returned failure before the numbered scenarios; its earlier frozen-candidate section is not certified by the focused rerun. Do not report the complete launcher suite as green.
- JetBrains ZIP and VS Code VSIX built; fresh-project onboarding passed against both bundles. Packaged launchers and all three cache helpers were checked against source. No installed IDE copy was updated and no billable model calls or live cache-hit measurements were performed.
