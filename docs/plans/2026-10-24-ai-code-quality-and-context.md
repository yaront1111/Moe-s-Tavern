# AI code quality and context efficiency

## Goal and status

Make an approved Moe task immediately executable: the agent receives the intended behavior, relevant existing code, allowed scope, and required checks. Spend model reasoning on implementation decisions; let Moe handle repeatable planning, context assembly, and verification bookkeeping.

Success means more independently accepted, maintainable changes with less repeated planning, context retrieval, and human repair. A shorter prompt or a green self-reported task is insufficient evidence.

**Repository:** original Moe's Tavern. **Inspected base:** [`7382e1a`](https://github.com/yaront1111/Moe-s-Tavern/commit/7382e1a52143433856d4146f0e70b79c4be3f553). **Status:** CQ-01 is the accompanying launcher fix; all later items below are proposed engineering work. This document does not enable a new runtime profile, create live Moe tasks, or establish measured token savings.

This is a reference plan. Agents should receive the selected task contract and relevant section references, not reread this entire document on every task. It extends the existing [prompt caching plan](2026-09-19-prompt-caching.md) and [Claude efficiency plan](2026-09-26-claude-efficiency.md).

## 1. Build on the current system

| Existing mechanism at the inspected base | Gap to close |
| --- | --- |
| The daemon owns task state, `submit_plan` validates structured steps, and `Task.planRevision` versions the approval surface. | Expose that revision in execution context, extend the approval surface with behavioral requirements, and bind evidence to it. [submitPlan.ts][plan], [schema.ts][schema] |
| `get_context` provides role-scoped context and explicit omissions. | Both launchers reconstruct a smaller payload and discard relevant fields. CQ-01 removes this second projection. [getContext.ts][context], [launcher projection][launchers] |
| Existing prompt transports separate stable instructions from dynamic task context. | Keep that separation while avoiding repeated source discovery and unnecessary planning sessions. [Source][cache-plan] |
| `contextFetchedBy` tracks worker IDs. | It does not prove the current attempt received the current plan revision. Add a revision-bound served-context receipt. [Source][enforcement] |
| Execution attempts, frozen candidates, check runs, reviews, delivery receipts, and delivery policy already exist. | Reuse them for a single revision/candidate-bound completion predicate. [Source][delivery] |
| The optional wrapper quality gate checks a frozen candidate in a detached worktree and uses expected-old ref updates when landing. | Make focused verification explicit for each task in the new profile; distinguish a worktree from process/OS isolation. [Source][gate] |
| Ordinary `record_check_run` callers can supply `source: runner-observed`. | A supplied label is not trusted execution provenance. Separate requests from authenticated runner observations. [Source][record-check] |
| Rails constrain plan text and guide agents. | Add project-native checks against changed code for rules that can be checked deterministically. [Source][rails] |

### CQ-01: preserve context at the launcher boundary

The accompanying code change removes the duplicated Bash and PowerShell field allowlists. The launchers pass the daemon's role-scoped payload into dynamic task context, preserving plan file scope, architecture notes, candidate/evidence fields, and `omitted` metadata. The prompt permits a refresh when context is missing or stale and a full read when an omitted section is needed.

Regression cases exercise the actual launcher sections with rich worker context, rich QA context, and sparse legacy context. They include long strings, Unicode, shell-sensitive characters, and future fields. They preserve the stable system-prefix boundary and existing context-file transport.

Local validation: the three new cases fail against the original scripts and pass against the patch; the complete Linux/Bash launcher test file passes 10/10. Bash syntax, wrapper parity, patch application, and the PowerShell UTF-8 BOM were checked. PowerShell runtime behavior must be established by the existing Windows CI matrix. These are transport tests, not an AI-output quality benchmark.

**Tradeoff:** restoring previously discarded content can increase prompt size. Any further selection and budgeting belongs in the daemon, with visible omissions and required fields preserved. PowerShell retains its existing JSON depth limit of 20; this change does not promise arbitrary-depth or byte-identical JSON transport.

## 2. Architecture decisions

1. **Keep source and Git authoritative.** Functions, schemas, migrations, tests, and configuration remain ordinary versioned files. Semantic indexes are rebuildable views tied to source snapshots. Use existing Serena/language-service navigation before adding another parser or datastore.
2. **Keep one approval revision.** Extend daemon-owned `Task.planRevision`; do not add an independent contract revision authority. Context packet IDs identify cached content and never grant approval.
3. **Keep existing ownership.** The daemon owns task state; the wrapper owns Git writes. Extend the existing attempt, candidate, check, review, receipt, and delivery machinery.
4. **Use a coherent behavior change as the task unit.** Callers, callees, compatibility handling, and tests may need to change together. Arbitrary file counts or tiny textual edits do not establish atomic correctness.
5. **Use focused checks during implementation and broader checks at integration boundaries.** Shared schema, protocol, migration, or toolchain changes can require broader checks immediately.
6. **Roll out through an explicit project profile.** Preserve legacy behavior until migration is selected. In the stronger profile, missing required evidence blocks verified completion and dependent-task release.
7. **Delay new infrastructure until there is a measured need.** A mandatory graph database, NATS deployment, universal semantic-edit language, or second scheduler is outside this rollout. A future Cordum integration can request work and consume outcomes while Moe remains the declared owner of code admission.

## 3. Remove repeated planning

### Three execution paths

| Path | Eligibility | Planning work |
| --- | --- | --- |
| Reuse an approved plan | The plan is still approved and its relevant source assumptions remain valid. | Zero new planner sessions; do not resubmit the same plan. |
| Instantiate a known recipe | A project-enabled recipe matches checked preconditions and supplies sufficient scope, acceptance criteria, and checks. | Deterministically instantiate an ordinary Moe plan; zero generative planning calls after eligibility passes. |
| Plan new work | Requirements, dependencies, compatibility, scope, or design remain unresolved; or a recipe does not match. | One bounded planning pass with targeted exploration and an explicit uncertainty list. |

At the inspected base, even an identical successful `submit_plan` increments the plan revision. Reusing an approved plan therefore avoids both redundant model work and meaningless approval churn. [Source][plan]

Recipe-generated and revised plans must pass the existing validation and authorization flow: `CONTROL` requires its authorized approval, `SPEED` retains its delayed approval/cancellation behavior, and `TURBO` uses its automatic transition after validation. An internal recipe adapter must have an explicit permitted identity; it must not impersonate an architect or write status directly.

Start with one or two narrow recipes, such as an established documentation correction or a mechanical import repair whose symbols and checks resolve. A recipe defines its version, supported toolchain, required inputs, source preconditions, scope constraints, ordinary plan steps, check references, and fallback reasons. Store it in versioned project configuration; avoid a new workflow language or service.

Check recipe eligibility against current source. Missing symbols, changed check definitions, unavailable analysis, public-interface changes, or migration/security/deployment boundaries outside the recipe cause a concrete fallback to ordinary planning. Recheck scope after the patch; a matching initial request does not authorize an expanded implementation.

### Compact execution contract

Extend the existing plan and definition of done with only the structured information the change needs:

- Observable behavior and acceptance criteria.
- Relevant invariants and compatibility requirements.
- Existing implementation to reuse, or a short reason for introducing another one.
- Known producer/consumer changes and approved file/symbol scope.
- Required verification references and their definition digest.
- Source assumptions and references supporting the plan.

A documentation correction can omit interface migration details. An API change cannot. Approval-relevant edits increment `planRevision` in the same durable task write, invalidate old authorization/evidence associations, and appear in both IDE client contracts. Metadata-only updates do not create revisions. Caller-supplied revisions cannot overwrite daemon authority.

An unrelated source commit should not force a new architectural plan. A changed referenced interface requires refreshed context and reassessment; a changed integration target still requires candidate regeneration/revalidation. Plan approval, context freshness, and execution evidence are separate conditions.

### Refresh, repair, or replan

| Event | Required response |
| --- | --- |
| A focused check fails within approved behavior and scope | Repair under the current plan, then produce new candidate evidence. |
| An infrastructure operation fails transiently | Retry that operation within a separate bounded budget. |
| Referenced source changes | Refresh affected context; replan only when the plan's assumptions no longer hold. |
| The integration target moves | Regenerate and revalidate the integration candidate. |
| Acceptance criteria, compatibility, required checks, or approved scope materially change | Create a new plan revision and apply the configured approval mode. |
| A recipe precondition fails | Return the reason and use ordinary planning. |
| The same failure repeats without new evidence | Stop the repair loop and escalate the concrete failure. |
| A required fact is unavailable or requirements conflict | Ask the smallest useful question or enter the appropriate blocked state. |

Pilot defaults: zero planner sessions for approved-plan reuse; zero generative planning calls for an eligible recipe; one planning pass plus a targeted follow-up for ordinary new work; at most three local repair attempts before escalation. These are configurable limits, not grounds to accept an incomplete plan. An architecture-heavy epic gets a shared decision set that child tasks reference.

Retain short decisions, assumptions, unresolved questions, and evidence references. Do not store private reasoning transcripts or make every failed test produce another architecture essay.

## 4. Compile useful context once and reuse it safely

Keep `get_context` as the context authority and the launchers as transport. Build a deterministic execution packet from current task state, approved requirements, applicable rails, relevant source, representative patterns, known callers/consumers, configuration wiring, and tests. Use Serena/language services where available and repository search as an explicit fallback.

| Mandatory in the compact packet | Expand on demand |
| --- | --- |
| Task/attempt identity and `planRevision` | Full implementations and additional dependency neighborhoods |
| Intended outcome, acceptance criteria, invariants, and restrictions | Historical discussion and rejected alternatives |
| Current step, approved scope, reuse references, and required check references | Long logs and older reviews |
| Source/candidate references and freshness status | Additional project memories or specialized guidance |
| Missing mandatory facts, analysis limitations, and explicit omissions | Broader search when the initial slice is insufficient |

Do not silently drop required information to meet a token target. If the minimum contract cannot fit, return an explicit expansion or task-restructuring requirement. An initial slice is a navigation aid, not a prohibition on reading more source.

### Cache identity and invalidation

Record repository identity, source snapshot, relevant worktree overlay, path/content hashes, query dependencies, toolchain/analyzer versions, instruction/rail/policy versions, recipe version where used, and `planRevision`. Validate provenance on use; file watchers alone are insufficient.

Invalidate the affected portion when its inputs change. Package configuration can invalidate symbol resolution; lockfile/toolchain changes can invalidate analysis and execution assumptions. Unknown dynamic references remain explicit uncertainty and may require conservative expansion.

**Track negative searches too.** A cached statement that no suitable helper exists becomes stale when another worker adds one. Its provenance includes the searched namespace/query and repository-index generation, not only files returned by the search.

Keep stable role instructions separate from task content. Load specialized guidance and memory bodies when applicable; retain versioned references and compact inventories otherwise. Review instructions that mandate repeated broad exploration so they do not negate the context API's benefit.

### Session deltas and context receipts

Send a delta only when the receiving session has acknowledged its exact base packet. Include the base/result packet IDs, changed fields, new evidence, updated source references, and explicit removals. A fresh process, compaction, uncertain handoff, or missing base requires a complete compact snapshot.

Replace worker-ID-only freshness assumptions with a served-context receipt bound to task, attempt, plan revision, and packet identity, or enforce those identities at the existing step-entry boundary. A receipt proves what was served or acknowledged; it does not prove model understanding. Packet IDs never substitute for plan approval.

## 5. Make code quality observable

The new profile should require evidence for the exact candidate and approved revision before declaring verified completion. Implement this through the shared delivery policy used by QA, dependency readiness, and UI projections.

| Quality question | Evidence |
| --- | --- |
| Does the intended behavior work? | A relevant behavior-level check, including the real producer/consumer path where applicable. |
| Does the change integrate with the existing system? | Type/compiler/schema checks and relevant integration coverage. |
| Does it preserve required compatibility? | Explicit compatibility assertions or migration verification. |
| Does it follow enforceable architecture rules? | Project-native dependency/import/lint/schema rules against changed code. |
| Is another implementation justified? | Located reuse candidates and a reviewable decision; similarity alone does not prove harmful duplication. |
| Was this exact code actually checked? | Runner-observed candidate/tree identity, plan revision, check-definition digest, environment, and result. |
| Did the verified code reach the intended destination? | Reconciled delivery evidence for the designated target and outcome. |

A writer can request a check and report diagnostic observations. It cannot mint trusted execution evidence by supplying a `runner-observed` string. The runner's capability/channel must be outside the writer's readable and writable execution boundary. A secret in a shared environment is insufficient.

Reuse the frozen-candidate gate. Distinguish code failure, infrastructure failure, timeout, skipped, and inconclusive outcomes. Return concise diagnostics and relevant excerpts while retaining full logs by reference. Missing or skipped required checks never count as success. Candidate, check-definition, dependency, or relevant environment changes require appropriate fresh evidence.

Independent execution does not make weak assertions sufficient. Review acceptance criteria and check definitions, protect required checks from unilateral weakening, and add negative cases around the specific behavior at risk. Prefer tests that fail for the observed defect or a meaningful regression over tests that simply mirror implementation details.

### Admission and recovery

Require explicit candidate and plan revision on QA approval in the new profile. Legacy omission compatibility remains explicit. Preserve expected-old Git ref updates; a moved target causes regeneration and revalidation. Optional push-time rebases and subsequent merges cannot inherit proof for a different tree automatically.

Make integration intent durable before target mutation, and reconcile Git plus evidence after crashes. Handle duplicate reports idempotently. Do not release dependents while the actual delivery outcome is uncertain. A justified no-change outcome is distinct from an unverified operation.

A detached worktree isolates checkout contents, not host credentials or process capabilities. Describe each runner's actual filesystem, process, network, credential, and resource boundaries. Unsupported required isolation blocks that profile or uses an explicitly approved compatible runner; it must not silently downgrade to host execution. Keep local branch admission, remote branch delivery, and a later merge to `main` as distinct outcomes.

## 6. Ordered implementation work

The IDs below are proposed engineering work, not imported `.moe` task records. Use the existing task tools when scheduling them. Keep each pull request independently reviewable, update both launcher twins when required, and preserve JetBrains/VS Code schema parity.

| Work | Priority / depends on | Main existing surfaces | Acceptance gate |
| --- | --- | --- | --- |
| **CQ-01: preserve daemon context** | P0 / none | `scripts/moe-agent.sh`, `scripts/moe-agent.ps1`, `scripts/tests/prompt-cache-launcher.test.mjs` | Actual launcher regressions fail on the old projection and pass on the fix; Bash and both Windows PowerShell engines retain required fields and prompt transport behavior. |
| **CQ-02: revision-bound contract** | P0 / CQ-01 | `types/schema.ts`, `state/taskStore.ts`, `tools/submitPlan.ts`, `tools/getContext.ts`, step-entry enforcement, WebSocket/client contracts | Expose revision; approval-relevant changes invalidate old authorization; stale context/revision cannot start a step; delayed approval cannot approve a newer unintended revision. |
| **CQ-03A: reuse gathered context** | P1 / CQ-02 | `tools/getContext.ts`, existing semantic navigation, `docs/MEMORY.md` | Surface an existing helper; detect stale positive and negative results; retain mandatory fields; make incomplete analysis visible; serve deltas only against an acknowledged base. |
| **CQ-03B: approved-plan reuse and recipes** | P1 / CQ-02, CQ-03A | `tools/submitPlan.ts`, role sources, versioned project configuration, launcher scheduling | Eligible routine work avoids a planner session; failed preconditions fall back with a reason; all approval modes, ownership, and scope boundaries remain enforced. |
| **CQ-04: focused frozen-candidate checks** | P0 / CQ-02 | Both launchers, `state/candidateStore.ts`, `state/checkRunStore.ts`, `delivery/policy.ts` | Every task in the profile has appropriate required checks; failure/absence/inconclusive results block verified completion; bounded repair reuses the plan and checks corrected candidates. |
| **CQ-05: trusted runner evidence** | P0 / CQ-04 | `tools/recordCheckRun.ts`, `state/checkRunStore.ts`, `server/McpAdapter.ts`, runner boundary, delivery policy | An ordinary agent cannot forge trusted evidence; required definitions cannot be weakened unnoticed; duplicate/crash handling is idempotent; actual isolation guarantees are reported. |
| **CQ-06: revision/candidate-bound review and delivery** | P0 / CQ-02, CQ-04, CQ-05 | `state/reviewStore.ts`, `tools/qaApprove.ts`, `delivery/policy.ts`, delivery/dependency projections, receipts, both launchers | Stale review/check evidence fails; target movement triggers revalidation; crashes between Git update and receipt persistence reconcile without double landing or premature unblock. |
| **CQ-07: checks against architecture and integration** | P1 / CQ-03A, CQ-04 | `util/rails.ts`, plan/check selection, project-native checks, worker/QA role sources | Forbidden imports fail despite compliant plan prose; an unwired consumer fails behavior verification; uncertain dynamic references are not automatically deleted. |
| **CQ-08: matched pilot and rollout** | P0 / baseline begins now; promotion after CQ-02 through CQ-07 | Existing usage receipts, task outcomes, regression fixtures, IDE settings/status | Record quality, human repair, planning, retrieval, latency, and cost together; deliberate stale-evidence and recipe-mismatch cases cannot bypass gates. |

Daemon paths in the table are relative to `packages/moe-daemon/src/`. Client contracts include `server/WebSocketServer.ts`, `moe-vscode/src/types/moe.ts`, and the corresponding JetBrains models and tests. Resolve current paths before implementation; do not create parallel stores solely to match this outline.

### First implementation slice after CQ-01

1. Expose the existing `planRevision` through `get_context` and the relevant client projections, including an explicit compatibility decision for legacy revision defaults.
2. Bind current-context receipt/step entry to revision and attempt; add stale-revision, reassignment, and approval-race regressions.
3. Detect a still-valid approved plan before launching a planner. Resume it without an identical `submit_plan` call, and emit an observable reason when replanning is required.
4. Add one narrow recipe and one context-cache fixture only after the revision boundary is proven.

This slice establishes safe plan reuse before expanding semantic analysis or autonomous verification.

## 7. Measure the whole task

Freeze about 20 representative tasks with starting commits, acceptance criteria, and independent assessment: routine maintenance, defect fixes, refactors, and several deliberately non-routine changes. Include an existing reusable helper, stale context, a changed caller, changed requirements, and recipe mismatch. Match model/tool versions and budgets; repeat where practical and report variability.

| Metric | Why it matters |
| --- | --- |
| Independently accepted changes, escaped regressions, and human repair effort | Actual correctness and maintainability. |
| Planner sessions and planning/replanning output tokens | Whether routine work avoids repeated generative planning. |
| Repeated source bytes/snippets and retrieval calls | Redundant exploration, including work done by context-building agents. |
| Packet size and missing-context expansions | Initial burden and whether trimming merely shifts work to later calls. |
| Total input, cached/uncached input, output, and available reasoning counters | Model usage with provider-specific semantics preserved. |
| Time to first relevant code change and end-to-end accepted delivery time | Startup friction and overall latency. |
| Cost per independently accepted change | Includes failed attempts, planner/context work, verification, and repair. |
| False gate rejections, stale-context detections, and unauthorized completion attempts | Reliability and effectiveness of the control path. |

Prompt caching may reduce charged input or latency; it does not remove cached tokens from the active context window. Count work across all participating agents and tools. Missing provider counters remain unknown, and API-equivalent estimates must not be presented as subscription bills. Existing usage receipts are a starting point, not complete outcome attribution. [Source][efficiency-plan]

**Provisional pilot promotion targets:** at least 50% fewer planner invocations and 30% less repeated source retrieval on tasks independently classified as routine; lower median cost and elapsed time per accepted change; no observed increase in escaped regressions or human repair; zero bypasses in stale-revision, changed-requirement, missing-check, and recipe-mismatch fixtures. These are targets, not achieved results. A small pilot provides directional evidence, not statistical proof of universal quality improvement.

## 8. Rollout and completion

1. Land CQ-01 with existing cross-platform CI.
2. Capture a baseline with the existing workflow and usage receipts.
3. Run proposed classification/context selection in observation mode and inspect false matches and missing context.
4. Enable the explicit profile for a small set of supported projects and runners; make its requirements visible in both IDEs.
5. Promote based on matched pilot results. Roll back the profile through a recorded configuration change when needed; preserve historical evidence and do not relabel incomplete work as verified.

The rollout is complete when routine eligible tasks reach implementation without fresh generative planning, source changes invalidate the right context, required behavior checks run against the exact candidate, and review/delivery agree on the same approved revision and destination. Human review effort and independently assessed quality must improve alongside the efficiency metrics.

## Source references

Current-state references below are pinned to the inspected base. Proposed behavior above is not a claim that these mechanisms already exist.

[plan]: https://github.com/yaront1111/Moe-s-Tavern/blob/7382e1a52143433856d4146f0e70b79c4be3f553/packages/moe-daemon/src/tools/submitPlan.ts
[schema]: https://github.com/yaront1111/Moe-s-Tavern/blob/7382e1a52143433856d4146f0e70b79c4be3f553/packages/moe-daemon/src/types/schema.ts
[context]: https://github.com/yaront1111/Moe-s-Tavern/blob/7382e1a52143433856d4146f0e70b79c4be3f553/packages/moe-daemon/src/tools/getContext.ts
[launchers]: https://github.com/yaront1111/Moe-s-Tavern/blob/7382e1a52143433856d4146f0e70b79c4be3f553/scripts/moe-agent.sh#L6469-L6522
[cache-plan]: https://github.com/yaront1111/Moe-s-Tavern/blob/7382e1a52143433856d4146f0e70b79c4be3f553/docs/plans/2026-09-19-prompt-caching.md
[enforcement]: https://github.com/yaront1111/Moe-s-Tavern/blob/7382e1a52143433856d4146f0e70b79c4be3f553/packages/moe-daemon/src/util/enforcement.ts#L230-L249
[delivery]: https://github.com/yaront1111/Moe-s-Tavern/blob/7382e1a52143433856d4146f0e70b79c4be3f553/packages/moe-daemon/src/delivery/policy.ts
[gate]: https://github.com/yaront1111/Moe-s-Tavern/blob/7382e1a52143433856d4146f0e70b79c4be3f553/scripts/moe-agent.sh#L4354-L4537
[record-check]: https://github.com/yaront1111/Moe-s-Tavern/blob/7382e1a52143433856d4146f0e70b79c4be3f553/packages/moe-daemon/src/tools/recordCheckRun.ts
[rails]: https://github.com/yaront1111/Moe-s-Tavern/blob/7382e1a52143433856d4146f0e70b79c4be3f553/packages/moe-daemon/src/util/rails.ts
[efficiency-plan]: https://github.com/yaront1111/Moe-s-Tavern/blob/7382e1a52143433856d4146f0e70b79c4be3f553/docs/plans/2026-09-26-claude-efficiency.md
