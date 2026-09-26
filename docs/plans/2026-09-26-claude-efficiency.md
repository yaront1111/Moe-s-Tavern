# Claude efficiency implementation plan

**Goal:** Reduce old Moe's context overhead and measure Claude usage without lowering model capability or verification requirements.
**Architecture:** Keep the existing CLI/cache transport and task lifecycle. Serialize MCP payloads compactly, offer an explicitly limited status projection, and record allowlisted provider usage receipts in diagnostic logs excluded from wrapper commits outside daemon-owned runtime state. Actual model routing remains disabled pending comparative quality evidence.
**Tech Stack:** TypeScript/Vitest daemon; Node ESM helpers/node:test; PowerShell and Bash launchers.

## Scope and ownership

- Daemon: `src/server/McpAdapter.ts`, `src/tools/getContext.ts`, a focused status projection helper and their tests.
- Usage: `scripts/prompt-cache-usage.mjs`, `scripts/prompt-cache.mjs`, `scripts/usage-receipt.mjs`, focused Node tests.
- Integration: both `scripts/moe-agent` launchers, receipt analysis helper/test, JetBrains/VS Code helper packaging, role and caching documentation.
- Work in the isolated `improve/claude-efficiency-20260926` checkout; preserve foreign shared-checkout changes. No `.moe` runtime writes. No live provider model benchmark or model downgrade.

## 1. Compact MCP output and bounded status reads

1. Run existing adapter/context tests as baseline.
2. Add a failing adapter test that compares parsed nested strings, arrays, empty/null values and Unicode with the handler's value while requiring single-line JSON.
3. Replace only `JSON.stringify(result, null, 2)` with `JSON.stringify(result)`.
4. Add `view: { type: 'string', enum: ['full', 'status'] }` to get_context. Default full retains current semantics. Status contains only identity, task/landing/candidate progress and an explicit full-context refresh instruction; it cannot stand in for a review or authority read.
5. Test absent/invalid view, default full rails/DoD retention, missing task, ownership/reopen and commit/candidate changes. Implement a focused projection helper.
6. Run focused tests, daemon suite and TypeScript compilation.

## 2. Provider usage receipts

1. Add failing tests for disjoint Claude input counters, inclusive Codex cached input, missing/invalid counts, output/reasoning, cumulative result semantics, repeated receipt identity and privacy.
2. Extend the existing console usage report with output and exposed reasoning counters.
3. Introduce `MOE_USAGE_RECEIPT_FILE` and `MOE_USAGE_CONTEXT_JSON`. The latter allowlists taskId, workerId, role, attemptId, launchId, requestedModel and requestedEffort. Receipt logging is optional and fail-open, and contains no prompts/tool output.
4. Append versioned records only from final Claude results or completed Codex turns. Missing final usage is unknown. Retain provider event/session identity, observed model identities where available, and outcome separately from requested configuration.
5. Test actual helper subprocess streams, logging failures, no final event, and unchanged existing stream behavior.

## 3. Launcher and distribution integration

1. Create a unique receipt file/context per provider invocation under `logs/moe-usage/`; exclude that precise directory from wrapper attribution even in repositories without a logs ignore rule. Reset metadata each iteration to avoid attributing resumed/manual tasks to a previous task.
2. Wire the same contract into both launchers. Preserve provider exit codes, attribution events, stable prompt prefixes, role/model/effort and postflight behavior.
3. Exercise real extracted launcher sections using fake provider streams in PowerShell 5.1/7 and Bash, including success/failure and Unicode.
4. Bundle the new receipt helper in JetBrains and VS Code wherever the cache helpers are bundled.
5. Add a read-only receipt report with deduplication, explicit unknown counters and task grouping. Report raw usage and recorded task outcomes; never label API-equivalent cost as a subscription bill or recorded DONE as independent quality proof.

## 4. Agent guidance and verification

1. Teach QA to use status view only while polling, then fetch full context before reviewing. Align worker memory discovery with already preloaded inventories. Preserve every quality/ownership rule.
2. Document receipt scope, incomplete interactive coverage, counter semantics and commands.
3. Run relevant daemon/Node/launcher tests, both shell syntax checks, wrapper parity and role-doc lint. Regenerate managed role sources only in the isolated checkout.
4. Review the combined diff adversarially, including stale metadata, duplicate/cumulative counts, silent omission of requirements and logging failure effects.
5. Deliver a focused commit and exact verification results. Installation/activation requires a separately verified build; do not claim it from source changes.

Quality gate: unchanged model and effort defaults, complete full-context requirements, unchanged completion/QA checks, and no loss of provider output or exit status. Token and subscription savings remain unmeasured until real receipts support them.

## Verification results (2026-09-26)

- Integrated remote `main` at `557f1e2` before final verification; retained the prior local branch-safety commit in merge ancestry.
- Daemon full suite: 126 files, 2,190 tests passed. After final role wording changes: build and 50 adapter/status/generated-role tests passed.
- Launcher/runtime/cache/receipt/session suites: 133 tests passed. Reporter and real attribution suites: 28 tests passed, including root/nested repositories without logs ignore rules and PowerShell 5.1/7/Bash behavior.
- Both wrapper syntax checks, PowerShell parity, role-doc lint and whitespace checks passed.
- JetBrains `buildPlugin` passed. Eight changed packaged scripts matched source bytes. Extracted ZIP onboarding passed through real daemon/proxy init, MCP, plan approval, doctor and restart persistence.
- VS Code bundling and bundled onboarding passed in isolated staging with copied dependencies. Staging avoids the Windows symlink privilege error from this worktree's shared dependency junctions.
- Read-only snapshots of four active tasks measured 176,279 characters for full compact context versus 4,416 for status projections: 97.5% less polling payload in that sample. This does not measure total task tokens, quota savings, or quality equivalence; full context remains required before execution/review.
- Adversarial review fixed silent loss of conflicting receipts and kept Codex stream coverage unconfirmed without closure proof. No provider calls or model downgrades were used for verification. Built artifacts do not establish installation or activation in existing IDE sessions.
