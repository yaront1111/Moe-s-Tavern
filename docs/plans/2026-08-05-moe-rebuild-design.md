# Moe Rebuild - Authoritative System Design

**Status:** Design candidate for independent Moe review. Yaron authorized creation of the adjacent repository and a provisional, contract-neutral Phase 1 foundation on 2026-08-06; that repository now exists at `703e994dacf948e1699bee8eee909040257b0b3f`. This is not a design freeze: design-dependent product semantics remain `HOLD` until the exact-file review is `FREEZE_READY` and Yaron gives an explicit design-freeze `GO`.

**Authority:** This document integrates the rebuild charter, Fable's independent review, and Fable's control-room specification/dependency list. Where an input conflicts with this document, this document is normative for technical semantics. The input documents remain evidence, product detail, and rationale; they are not co-equal backend specifications after freeze.

**Inputs:**

- `docs/plans/2026-08-05-moe-rebuild-charter.md` at SHA-256 `D060273C9B7CA135BC6A453881F92B6AB69F1199CC3E6EA60BCEAE01E318A1B3`
- `docs/plans/2026-08-05-moe-rebuild-fable-review.md` at SHA-256 `DA97DECAAD131A5669449126CD86F2BB67E2DF16CD2370EEB95812D8D30D2D10`
- `docs/plans/2026-08-05-moe-v1-control-room-spec.md` at SHA-256 `C55AF8A9FC7386E6492FD57E34A4B8321ABAAE4E4E08FF38703544B58B0BEF1F`; its D1-D15/C1-C10 items receive the technical rulings in Sections 5, 8, 10-18
- `docs/plans/2026-08-05-moe-best-tool-benchmark-spec.md`, Fable Revision 3 at SHA-256 `F8B84716BFC1FAAB051D698AA9BE353F0D780142D709B7D14496D0B7B65C8885`; it is normative for comparative-evidence estimators, decision rules, and permitted public claims, while this design remains normative for backend semantics and engineering targets
- legacy behavioral baseline `454a6012e955e5d9d37f050330c4a58111be23f4`

**Target:** a new adjacent repository at `D:\projexts\moe-next`. Legacy Moe remains a read-only behavioral oracle and import source. There is no in-place rewrite and no dual-write period.

Normative terms such as **MUST**, **MUST NOT**, **SHOULD**, and **MAY** have their usual requirements meaning. A condition that Moe cannot prove is `UNKNOWN`; it is never silently interpreted as success, zero cost, valid authority, or safe recovery.

---

## 1. Product position and release claim

Moe is a local, auditable workflow control plane for engineering agents:

> A human gives Moe an outcome. Moe creates an approved execution graph, keeps simple work simple, safely fans out work that has earned parallelism, fences stale actors, integrates exact repository changes, verifies them itself, and makes the provenance of every important fact visible.

The differentiator is not a board, worktrees, or the number of agents. Those are available elsewhere. Moe's differentiators are:

1. **Bounded authority:** authenticated sessions, canonical leases, epochs, exact scopes, immutable policies, and transactional checks.
2. **Safe, flow-efficient graph execution:** one node by default; every blocking edge must prove a minimum producer-to-consumer contract; earned fan-out, explicit fan-in, work-conserving fair scheduling, and bounded stale-blocker challenge prevent avoidable serial chains.
3. **Visible proof:** daemon-issued receipts, independent clean-context review, truth classes, and a causal timeline.
4. **Honest recovery:** committed facts survive; stale or corrupt facts become `SUSPECT`, `UNKNOWN`, or `NEEDS_RECONCILIATION`, never invented state.

“Best tool” is not release copy until the comparative suite in Section 20 passes and its evidence is published. A faster run bought with unbounded cost, weaker acceptance, or hidden human work does not pass.

## 2. Freeze rulings

Fable returned seven `KEEP`, three `CHANGE`, and zero `REJECT` verdicts. Codex accepts all ten verdicts, with the precise rulings below.

| # | Topic | Frozen ruling |
|---|---|---|
| 1 | Deployment | **KEEP.** Local-first, one machine, one owner in v1; contracts remain remote-clean. |
| 2 | Core shape | **CHANGE accepted and sharpened.** The graph is canonical, but ordinary work is one node by default—not a manufactured serial task chain. Expansion requires typed dependency proof, pairwise-disjoint write scopes (or explicit proven serialization), a machine-checkable oracle per child, conserved budget, and an honest flow case. Read-only comparison/investigation may parallelize against one pinned snapshot. |
| 3 | Primary UI | **KEEP.** One local web control room; board is the default projection, graph and timeline are alternate projections; JetBrains is the first thin adapter. |
| 4 | State | **KEEP with binding conditions.** Transactional SQLite, sole-process access, versioned events/upcasters, digest-referenced artifacts, default-on scheduled hashed exports, and no Git-tracked live state. |
| 5 | Approval | **CHANGE accepted.** Plans, expansions, and acceptance are manual by default. Risk-tier automation ships in v1 as a per-project, audited, default-off opt-in. There are no global speed modes. |
| 6 | Memory | **CHANGE accepted.** Structured handoffs, decisions, artifacts, notes, and a bounded attempt/dead-end journal ship in v1. Semantic/vector retrieval does not. |
| 7 | Compatibility | **KEEP.** Read-only importer and reconciliation report; no promise of parity with every legacy tool. |
| 8 | Git delivery | **KEEP and strengthen.** Explicit-path, PR/branch-shaped integration; producing lease epoch verified at acceptance; no agent auto-stage/push and never broad `git add -A`. |
| 9 | Graph authority | **KEEP with completed specs.** Agents propose graphs; Moe validates, approves, schedules, integrates, and applies the supersession protocol in Section 10. |
| 10 | Scope boundary | **KEEP.** Workspace isolation is not called a sandbox. Malicious same-user host processes are outside v1 containment; spoofed or stale protocol clients are in scope and fenced. |

One inconsistency is resolved more strictly than the review's informal journey wording: a dedicated integrator does **not** make overlapping parallel write scopes safe. In v1, overlapping write nodes are serialized or the proposal is refused. An integrator is still mandatory at every fan-in because disjoint files can conflict semantically.

### 2.1 Numeric defaults

- Maximum provider slot occupancy per project: **4** `RESERVED|ACTIVE` slots by default across declared host/provider/model/profile dimensions; maximum per goal is also **4**. Both count planners, executors, integrators, verifiers, qualification recovery, reviewers, and read-only agents. Active utilization is separately measured from `effect.activate` to proven terminal/release.
- Maximum expansion depth: **3**, where the goal root is depth `0`; an expansion beneath a worker increments depth by one.
- Maximum direct worker children in one expansion: **6**. The mandatory join/integrator node is not a worker child but still consumes a concurrency slot when it runs.
- Maximum total new nodes in one expansion: **9**: at most six task nodes plus one mandatory integration node, at most one global-verification node, and at most one final-review/completion node. Read-only/helper nodes count among the six; an agent cannot bypass width with a different node label.
- Maximum nodes in one active goal graph: **24**; maximum hard dependency edges: **64**. Organizational/advisory relations do not consume the hard-edge budget but remain subject to input limits.
- Scheduler priority-aging quantum: **8** compatible bypass opportunities per class; default fairness-ticket ceiling `M_d <= 10,000`; reference dispatch-decision bound with available capacity: **1 second**.
- Maximum unsuccessful review rounds: **3** per node, review stage, and revision lineage. Trivial edits do not reset the counter; only a human, reason-bound decision can reset it.
- Same-bug breaker threshold: `max(2, ceil(declaredSiblingCount / 2))` distinct sibling nodes with one exact normalized failure signature, frozen from the approved expansion. No new sibling launch or retry occurs after the threshold; already-running waste is bounded by the concurrency limit.

All are versioned policy values. A raise is scoped to one project or goal, expiring where applicable, reason-required, human-approved, and visible in the timeline.

### 2.2 Binding scope cuts

To fund the correctness additions:

- v1 provider adapters are **Claude first and Codex second**; Gemini is post-v1;
- policy is visible but read-only in the control room; edits are reviewed policy-file changes;
- attempt memory is structured and deterministic, not semantic;
- integration is a first-class role and protocol, not an automated semantic merge engine;
- reviewer calibration has a corpus and eligibility sanity gate, but no broad statistical quality claim until production baselines exist;
- VS Code follows stability of the canonical UI and JetBrains adapter.

## 3. Non-negotiable principles

1. The daemon is the only Moe authority for lifecycle, leases, policy, budgets, integration admission, and proof. A cooperative provider may still perform out-of-scope host effects; those are outside v1 containment and become `OUT_OF_SCOPE_HOST_EFFECT_UNKNOWN`, not a false claim that Moe prevented them.
2. One canonical record represents each authority fact; projections may be rebuilt but never become competing truth.
3. Every mutation authenticates the principal and validates capability, command idempotency, expected version, current lease token/epoch where applicable, and referenced immutable revisions inside one transaction.
4. With authoritative storage intact, acknowledged committed events are never best-effort. Backup restore has an explicit cursor/RPO and never pretends post-cursor events survived media loss.
5. Presence is not authority. Silence is not death. An expired renewal pauses authority as `SUSPECT`; it does not silently reassign work.
6. Approvals bind exact hashes. Carry-forward is an explicit adoption decision, never an implicit reuse of an old approval.
7. Agent-reported output cannot satisfy daemon verification.
8. A worker, integrator, or reviewer cannot widen its scope, budget, privileges, or graph.
9. Readiness is a pure function of durable facts plus exact graph and policy revisions.
10. UI actions come from `nextAllowedCommands`; no UI, IDE, importer, or MCP adapter has a privileged mutation path.
11. Unknown or partial measurement is never zero and never “probably fine.”
12. No correctness depends on a transcript, chat message, process-local timer, file watcher, or broad Git staging operation.
13. Epic containment, prose order, and resource scarcity never become hard execution dependencies; each blocking edge names the minimum typed fact/contract it consumes.

## 4. System boundary and architecture

Moe v1 is a modular monolith with one local daemon and separately supervised agent processes.

```text
Human / JetBrains / MCP clients / local control room
                         |
             generated command/query contracts
                         |
                 authenticated daemon
   +---------------------+----------------------+
   | command application / policy / authorization|
   | graph + lifecycle reducers / scheduler       |
   | leases / budgets / integration / review      |
   | context / evidence / reconciliation          |
   +---------------------+----------------------+
                         |
             one transactional writer
                         |
       SQLite events + projections + outbox
                         |
      +------------------+------------------+
      | runner supervisor | artifact store  |
      | provider adapters | hashed exports  |
      +------------------+------------------+
                         |
      isolated worktrees and provider processes
```

The daemon is the sole process that opens the live database during normal operation. Clients use APIs. Offline `doctor` may open it read-only only after acquiring an OS lock that proves no daemon owns it; a PID file alone is insufficient.

### 4.1 Proposed stack

- TypeScript in strict mode on Node.js 24 LTS.
- pnpm workspace with explicit package boundaries.
- SQLite with a bundled engine at or above `3.51.3`; one short-transaction writer and read snapshots.
- The official stable MCP TypeScript SDK line at implementation freeze; stdio and Streamable HTTP only.
- React-based local control room; generated schemas/clients; cursored event stream.
- Vitest plus a model/property test library, deterministic fake time/process/store testkit, and Playwright journeys.
- Content-addressed local artifact storage and Ed25519-signed/hash-bound export and evidence manifests.

Node 24's built-in `node:sqlite` is still release-candidate API surface as of this design. The storage driver is therefore chosen by a blocking packaging/fault spike, not brand preference. A candidate passes only if it bundles SQLite `>=3.51.3`, supports required transaction/backup primitives, passes Windows/Linux/macOS packaging, exposes its SQLite version to `doctor`, and survives the Phase 2 crash matrix. If no candidate passes, Phase 2 is blocked rather than weakening the storage contract.

### 4.2 Fresh repository layout

```text
moe-next/
  apps/
    daemon/
    control-room/
  packages/
    contracts/        # canonical schemas, errors, generated clients
    core/             # pure reducers, hashes, impact and policy inputs
    store/            # migrations, repositories, event ledger, outbox
    scheduler/        # readiness, graph, leases, budgets, supersession
    runner/           # supervisor, worktrees, providers, verifier
    integration/      # manifests, provenance gates, fan-in workflow
    review/           # clean packages, findings, calibration
    context/          # deterministic package and journal selector
    mcp/              # official SDK adapters
    testkit/          # models, fixtures, fake clock/process/faults
  adapters/
    jetbrains/
    vscode/           # post-v1 stability
  docs/
    adr/
    plans/
    product/
  tests/
    contract/
    property/
    fault/
    security/
    migration/
    integration/
    e2e/
```

Dependencies point inward: adapters depend on contracts; application services depend on pure core ports; core imports no database, UI, MCP, Git, or provider package. No state package imports a command/tool adapter.

## 5. Truth and provenance model

Every important displayed fact carries one origin:

- `OBSERVED`: captured directly by Moe or the OS, such as a process exit or repository tree.
- `AGENT_REPORTED`: asserted by an agent and not independently proven.
- `DAEMON_VERIFIED`: produced by an approved Moe runner/verifier recipe and bound to exact inputs.
- `HUMAN_APPROVED`: an authenticated human decision bound to exact revision hashes.
- `UNKNOWN`: absent, corrupt, stale, incompatible, partial, or irreconcilable evidence.

Truth classes do not automatically upgrade. For example, an agent saying “tests passed” remains `AGENT_REPORTED`; a separate runner receipt creates a new `DAEMON_VERIFIED` fact. An old approved graph does not make a changed graph approved.

Derived facts use a schema-declared rule and expose their input provenance. Generic roll-up precedence is: any required `UNKNOWN` -> `UNKNOWN`; else any `AGENT_REPORTED` -> `AGENT_REPORTED`; else any merely `OBSERVED` -> `OBSERVED`; else all daemon-proof inputs -> `DAEMON_VERIFIED`. `HUMAN_APPROVED` applies only to the fact that a named decision occurred; it never upgrades underlying evidence and an auto-policy decision is `DAEMON_VERIFIED`. A domain schema may declare a more specific rule but cannot produce a stronger class than any required input permits.

The control room shows a text label and icon as well as color. Goal cards, node cards, budget figures, lease facts, approvals, evidence, integration outputs, recovery state, and timeline facts expose their truth class and provenance drill-down.

## 6. Canonical records

### 6.1 Intent and graph

- `Project`: stable repository identity, owner, policy root, supported providers/profiles, local paths, bootstrap manifest, and `BOOTSTRAPPING`, `READY`, `DEGRADED`, or `QUIESCED` lifecycle projection.
- `Goal`: human outcome, success measures, optional predecessor-goal generation, daemon-derived risk assessment, root budget account, optional current proposed graph revision, at most one active graph revision, monotonically increasing `graphEpoch`, aggregate version, `DRAFT`, `EXECUTION_ENABLED`, `CLOSING`, `COMPLETED`, or `CANCELLED` lifecycle, and an orthogonal `RUNNING`, `PAUSE_AFTER_CURRENT_STEP`, or `DRAIN_AND_PAUSE` scheduling control. Exactly one active revision is required while execution-enabled or closing.
- `GraphRevisionContent`: immutable canonical node/edge set, repository base tree, parent revision, completion node, policy revision, decomposition budget, graph hash, and author.
- `GraphRevisionState`: separate `DRAFT`, `PENDING_APPROVAL`, `APPROVED`, `ACTIVE`, `SUPERSEDED`, or `REJECTED` lifecycle projection over immutable content.
- `NodeDefinition`: stable `nodeKey`, objective, criteria IDs, constraints, capability, write/read scopes, resource needs, budget request, plan/verification refs, and join role.
- `PlanRevision`: immutable plan hash, author, parent/rejection lineage, ordered typed steps, affected nodes/criteria, verification recipe references, graph binding, and approval state. A plan edit creates a new revision; delta impact is daemon-computed.
- `PlanningRun`, `PlanningAttempt`, and `PlanningSubmission`: a planning lifecycle bound to a proposal base (none for a first plan, or an exact active/rejected graph hash), goal version, and immutable plan lineage; one immutable provider try per planner claim; and one staged compound `INITIAL|REVISION|EXPANSION` submission whose finalization creates plan plus graph together. A run has no `GraphRevisionContent` until the canonical `plan.propose(kind=...)` submission safely finalizes, and no execution, workspace-write, evidence, or acceptance authority.
- `AcceptanceContract`: immutable obligations applicable to a node kind. A leaf producer may qualify from its own criteria/oracles and policy-required leaf review; integration/global verification/final review apply to their respective downstream nodes and the composite completion node, not circularly to every leaf.
- `DependencyContract`: immutable graph-bound justification for one execution-blocking edge: exact producer artifact/interface, daemon fact, resolved scope collision, or policy rule and hash; exact consumer criterion/precondition and contract hash; minimum qualifying milestone; typed satisfaction predicate; `MONOTONIC` or `REVOCABLE` stability class; exact satisfaction-witness IDs, versions, digests, and consumption horizon; necessity/counterfactual failure; approved-interface/fixture alternative ruling; alternate producers where meaningful; truth/provenance; and invalidation/recheck facts. A predicate is `MONOTONIC` only when its schema proves it cannot become false; uncertainty is `REVOCABLE`. The horizon names the last gate that needs the fact, up to and including atomic goal completion; after that gate a later fact change does not retroactively rewrite history.
- `WorkEdge`: either a hard `ARTIFACT_CONSUMPTION`, `STATE_PRECONDITION`, `SCOPE_SERIALIZATION`, or `POLICY_SEQUENCE` backed by a current `DependencyContract`, or a non-blocking `RELATED`, `CONTAINS`, `CONTEXT`, or `PREFERRED_ORDER` relation. Only hard edges participate in readiness. A resource wait is never fabricated as an edge.
- `PlanQualityAssessment`: graph-bound structural stage count, hard-edge count, semantic transitive reduction, ready-frontier width, structural critical path, blocked-descendant counts, sequential baseline, interface/fixture alternatives, orchestration/handoff cost, and truth-classed duration ranges; unknown duration stays `UNKNOWN`.
- `ExpansionProposal`: all-or-none proposed child graph, admission facts, refusal reasons, and proposed sequential alternative.
- `SupersessionPlan`: exact old/new mapping, per-node disposition, consequence-relevant attempt/step/effect/resource/budget state, `DispositionEquivalenceDigest`, budget disposition, safe-boundary policy, immutable `supersessionPlanHash`, and approval.
- `ScopeResolutionObservation`: daemon-observed canonical path/symlink/junction/submodule/case/repository result bound to exact base/worktree identity, observer version, timestamp/freshness, and digest.
- `RiskAssessment`: daemon-derived maximum tier with immutable rule/fact inputs and policy hash; a caller's risk label is only an advisory hint.

### 6.2 Authority and execution

- `Principal`, `Credential`, `AgentProfileRevision`, `Session`.
- `AssignmentLease`, `WorkspaceLease`, `ResourceLease`, each with token, epoch, state, and exact authority scope.
- `NodeRun`: mutable execution lifecycle projection for one stable active node authority contract; draft planning never mutates one.
- `ExecutionAttempt`: immutable identity for one try, with `startedRevisionHash`; its history is never rewritten.
- `AttemptAuthorityBinding`: effective interval binding an unchanged attempt/lease to an active graph revision and its current graph epoch/binding version; immutable source input provenance is not rewritten by a carry.
- `NodeInputMaterialization` and `NodeInputManifest`: system-owned pre-claim effect/attempt plus its immutable sealed result over the graph base and exact accepted predecessor artifact closure, producer attempts/epochs/adoptions, exact dependency satisfaction-witness IDs/versions/digests, deterministic application order, inherited-path ownership, and resulting `inputTreeDigest`; the worker attempt and candidate bind its digest.
- `NodeResultManifest`: exact input-manifest digest, input tree, authored delta/commit, result tree, inherited-versus-authored path manifest, receipts, and artifact outputs.
- `StepRun`, `ProcessObservation`, `DrainDisposition`, `ContextPackage`, `ExecutionEnvironmentManifest`. A drain disposition stores the complete reason set and a monotonic strongest reason/terminal target; a later stronger authority-ending reason can never be lost to an earlier release request.
- `ProviderRuntimeObservation`: resolved runtime closure, executable/launcher/package paths and digests, reported version, adapter/capability/schema digest, pinning method, platform identity, freshness, and truth; its digest binds quote, attempt, and launch intent.
- `Resource`, `ResourceWaitRequest`, `ResourceReservation`, and `ProviderSlotReservation`: capacity units, fenceability, deterministic fair queue key, all-required acquisition set, `RESERVED|ACTIVE|RELEASED` provider occupancy, lifecycle, and cancellation/restart facts.
- `EffectIntent`, `EffectClaim`, `EffectResult`, and `EffectTombstone`: stable idempotency/ordering/fencing protocol for launch, verification, integration materialization, external resource operations, and delivery.

### 6.3 Proof, integration, and learning

- `ArtifactRef`, `EvidenceRecipeRevision`, `EvidenceRun`, `EvidenceReceipt`.
- `ProjectConfigurationManifest`: immutable, path-neutral effective project settings plus policy/provider/profile/schema versions, `settingsDigest`, and orchestration source SHA. It records no machine-specific physical configuration path; every benchmark or release run binds its digest.
- `RunTelemetryRecord`: one machine-readable per-run record with stop reason, provider/model snapshot, token and step counts, Section 20.5 cost-class measurements, infrastructure outcome, monotonic and wall timestamps, configuration/policy/orchestration hashes, and receipt/artifact references. Missing measurements remain explicit `UNKNOWN`, never zero.
- `SurfaceTimingReceipt`: daemon command-receive/commit cursors plus client render-observation time and environment identity; expansion proposals additionally record policy-input-ready and graph/readiness/allocation commit times. Human think time is a separate observation.
- `IntegrationContract`, `IntegrationAttempt`, immutable `IntegrationInputManifest`, immutable `IntegrationResultManifest`, `IntegrationFinding`.
- `ReviewPolicyRevision`, `ReviewRound`, `ReviewFinding`, `CalibrationCorpusRevision`, `CalibrationRun`, and `ReviewerEligibilityReceipt`; the eligibility receipt binds reviewer independence, calibration corpus/version/result, adjudication role, and the reviewed input digest.
- `AttemptJournalEntry`, `Handoff`, `DecisionNote`.
- `Blocker`: a typed `SEMANTIC_PREREQUISITE`, `DEPENDENCY_DISCOVERY`, `RESOURCE_WAIT`, `POLICY`, `BUDGET`, `EVIDENCE`, `EXTERNAL`, `SAFETY`, `RECONCILIATION`, `REVIEW`, or `UNKNOWN` predicate bound to graph epoch and source fact versions, with affected nodes, owner, truth/provenance, created event, recheck events/time, deadline/escalation, and status. A system `SEMANTIC_PREREQUISITE` names an existing current hard `DependencyContract`; a newly reported prerequisite is only a caller-scoped `DEPENDENCY_DISCOVERY` hold until graph admission. Free prose cannot hold work.
- `IntentionalWait`: explicit owner/reason, typed predicate, affected scope, `recheckAt`/deadline, escalation policy, and graph/fact binding. It is visible and suppresses timer challenges only until new evidence or its recheck boundary.
- `FrontierSnapshot`: content-hashed derived result at an exact event cursor/graph epoch, partitioning nodes into `READY_NOW`, `UNBLOCK_NEXT`, `INTENTIONAL_WAIT`, and `UNSAFE_OR_UNKNOWN` with complete unsatisfied-predicate chains, idle capacity, priorities, slack, and truth.
- `DependencyChallenge`, `UnblockingProposal`, and `ReplanProposal`: deduplicated version-bound challenges/proposals; none silently activates a graph.
- `PlanningHold`: an `EXPANSION_PLANNING`, `REPLAN_REQUIRED`, or `PROOF_REEXECUTE` readiness predicate bound to exact affected node(s), one `PlanningRun`, proposal base, graph epoch, source fingerprint, and `ACTIVE -> RESOLVED|SUPERSEDED|CANCELLED` lifecycle. Creation and clearing are atomic with the corresponding planning/run transition; an active hold cannot disappear on restart or by prose.
- `ApprovalDecision`, `AcceptanceQualification`, `QualificationRecoveryRun`, `CarryForwardDecision`, `PolicyDecision`, `PolicyRevision`. An acceptance event is immutable; its separate `CURRENT|INVALIDATED|SUPERSEDED` qualification projection binds the exact proof and still-applicable horizons, so later invalidation never rewrites the historical `ACCEPTED` phase. A typed recovery is `REQUALIFY` for proof-only invalidation over unchanged verified bytes or `REEXECUTE` when input/result/contract material can no longer be trusted.
- `BudgetAccount`, `BudgetAuthorityBinding`, `BudgetReservation`, `SupersessionFundingReservation`, `PreparedPlanningFence`, `UsageMeasurement`, `BudgetLedgerEntry`. A prepared fence is admission control over exact non-activating planning lineages during one approval generation; it is not execution authority or an opaque blocker.
- `DomainEvent`, `OutboxMessage`, `ConsumerReceipt`, `ReconciliationItem`.
- `BackupGeneration`, `RecoveryAnchor`, `RecoveryIncarnation`, and `DistributionManifest`: one RPO/cursor-bound database/artifact/key-chain backup, one crash-safe non-restored two-slot install journal, one fresh post-restore nonce/signing-key fencing identity, and one source/contract/asset compatibility identity per shipped component. A recovery incarnation is never computed by incrementing a value read from restored bytes.
- `CutoverAttempt`: immutable source manifest plus explicit `PREVIEWED -> QUIESCE_APPROVED -> QUIESCING -> QUIESCED -> IMPORT_VERIFIED -> ACTIVATE_APPROVED -> ACTIVE` or `ABORTED` state, with two distinct step-up decisions.
- `ScheduleCoverageManifest`: versioned source-generated command/outcome, reachable-state, lifecycle/effect transition, race-pair, transaction/effect fault-boundary, and partial-order coverage universe with hit counts; an audited obligation matrix maps every `CORE-I1`…`CORE-I22` predicate and `CORE-S1`…`CORE-S14` oracle to canonical schedules and frozen strata/minima. Schedule identity is the canonical command/outcome/fault-point partial order with irrelevant IDs, timestamps, and seeds removed.

Operational state is normalized. Human-friendly views are projections. A projection can be deleted and rebuilt without changing authority or history.

## 7. Hashes, approvals, and selective invalidation

Canonical serialization is versioned, locale-independent, path-normalized, and byte-stable across supported operating systems. Each hash states its canonicalizer version.

### 7.1 Hash bundle

- `graphHash`: every node definition hash, hard edge and `DependencyContract`, advisory relation, graph/decomposition limit, repository base tree, policy revision, completion node, and parent revision in canonical order.
- `nodeAuthorityHash` (the recursive execution-contract hash): node objective, criteria, constraints, capability, normalized scopes, resources, budget, plan and verification recipe revisions, repository base tree, applicable policy-slice hash, join/completion linkage, and recursively ordered hard-predecessor edge types, keys, hashes, predicates, and contracts. It excludes mutable status, attempts, timestamps, revision IDs, presentation metadata, actual predecessor result selection, and unrelated/outgoing consumers.
- `inputBindingHash`: exact `nodeAuthorityHash`, `NodeInputManifest` digest/resulting input tree, selected predecessor result/adoption identities, dependency satisfaction-witness IDs/versions/digests, environment-manifest requirements, provider-runtime observation, and source graph/binding epoch. Every attempt, candidate, receipt, and result manifest binds it; a different predecessor result, witness, or runtime/environment closure requires a new attempt/materialization. Carry retains this immutable source hash as provenance while a new `AttemptAuthorityBinding` supplies current graph-epoch fencing.
- `contextDigest`: exact canonical rendered bytes delivered to the adapter plus selected/excluded record manifest, artifact digests, and selector/renderer/adapter-envelope versions.
- `reviewInputDigest`: exact canonical rendered review-package bytes plus graph/plan hashes, integrated tree/diff, evidence receipts, criteria, prior structured findings, artifact digests, and renderer/rubric/adapter-envelope versions.
- `receiptDigest`: canonical runner observation and artifact references.

### 7.2 Approval rule

An `ApprovalDecision` always names the exact revision/hash, scope of approved nodes, applicable policy, criteria, budget, `PlanQualityAssessment`, dependency additions/removals/challenges, actor, and decision reason. A new graph revision always needs a graph-level approval or a recorded policy auto-approval. Old approval bytes are never relabeled as approval of the new graph.

The graph diff computes an impact set deterministically. An unchanged node may reuse work only when its `nodeAuthorityHash` is identical; an attempt additionally requires an identical adopted `inputBindingHash`. A `CarryForwardDecision` then explicitly adopts named plan approvals, attempts, input/result manifests, artifacts, or reviews into the new revision. The adoption records source and target hashes, policy rule, actor, and evidence. Any mismatch, missing dependency, changed applicable policy slice, predecessor result, environment/runtime closure, or unknown canonicalization invalidates carry-forward.

This resolves two source-document conflicts:

1. whole-graph approval remains immutable and invalidated by a new graph;
2. unchanged node work is not discarded, but is adopted through a new atomic binding rather than mutating the old attempt or pretending its original graph never changed.

## 8. Graph and lifecycle semantics

### 8.1 Draft planning and active execution are different authorities

Execution-blocking edges form a DAG. Iteration, tool loops, and causal debugging happen inside a session; retries create new attempts. Organizational epic/parent/child containment is presentation only and **MUST NOT** create execution order. Rejection and re-planning create a new immutable plan and successor draft graph; no active `NodeDefinition`, `NodeRun`, or authority hash is edited in place.

Goal lifecycle is closed: `DRAFT -> EXECUTION_ENABLED` only through initial graph activation; `EXECUTION_ENABLED -> CLOSING` only when the designated completion node **and every execution-bearing run in its required transitive acceptance closure** are terminal `ACCEPTED` with `CURRENT` qualification, every goal-level obligation holds, and no pending draft/supersession remains; `CLOSING -> COMPLETED` only through one atomic zero-authority and current-proof proof; `CLOSING -> EXECUTION_ENABLED` only when any still-required `AcceptanceQualification` input becomes invalid before completion; and `DRAFT|EXECUTION_ENABLED|CLOSING -> CANCELLED` only through authorized cancellation that fences subordinate authority. The invalidation transaction records `PROOF_INVALIDATED`, changes qualification validity, and chooses exactly one daemon-proven recovery: `REQUALIFY` creates a bounded evidence/review/approval `QualificationRecoveryRun` when immutable input/result/contract bytes still verify; `REEXECUTE` creates a `PROOF_REEXECUTE` `PlanningHold` plus successor draft and explicit non-carry disposition when input/result bytes are corrupt, missing, stale, or unknown; a changed contract/criteria/policy slice creates ordinary `CHANGE` supersession. Entering `CLOSING` blocks every new planning, execution, integration, verification, review, step, and effect activation while allowing only renewal, runner observation, safe-boundary drain, reconciliation, evidence/export, qualification invalidation, and cancellation. `CLOSING` is cleanup-only: required work is already accepted. Completion revalidates every still-required receipt/artifact/integration/review/approval/witness input through its horizon and proves zero live planning/execution/review/qualification leases, attempts, processes, effects, resources, provider slots, planning/supersession funding/holds/preparation fences/dispositions, or reconciliation items. If that proof already holds, one command may record `EXECUTION_ENABLED -> CLOSING -> COMPLETED` in the same transaction; otherwise the goal stays visibly `CLOSING`. `COMPLETED` and `CANCELLED` are terminal. `goal.reopen_as_revision` creates a linked successor goal generation and `PlanningRun`; it never moves the old goal backward.

The draft `PlanningRun` relation is:

| From | Command/outcome | To | Required durable effect |
|---|---|---|---|
| `DRAFT` | intent/criteria validated | `READY` | immutable goal intent/proposal base and finite planning budget exist; no graph content is required |
| `READY` | `planning.claim` | `PLANNING` | proposal lease, context, goal version/base, planning budget, provider-slot reservation, and launch intent bind atomically |
| `PLANNING` | safe `planning.release` | `PLANNING` | current `PlanningAttempt` becomes `RELEASED`, lease/provider slot end, exact handoff commits, and the run becomes resumable/unowned |
| owned or `SUSPECT` `PLANNING` | `planning.recover_absent` | unowned resumable `PLANNING` | runner/adapter negative proof fences the lease, proves planner effects/resources absent, terminalizes the crashed attempt, quarantines partial output, and seals an immutable `NO_HANDOFF_RECOVERY` from the last durable context/journal/draft with missing in-memory state `UNKNOWN` |
| unowned resumable `PLANNING` | `planning.claim` | `PLANNING` | a new `PlanningAttempt`, proposal lease, provider slot, context, planning-budget charge, and exact safe-release `Handoff` or `NO_HANDOFF_RECOVERY` bind atomically after proving the prior attempt terminal and no planner effect/resource overlap |
| `PLANNING` with live planner effect/resource | compound `plan.propose(kind=INITIAL|REVISION|EXPANSION)` | `PLANNING` + `SUBMISSION_DRAINING` | immutable `PlanningSubmission` seals, further proposal authority fences, `SUBMISSION_FINALIZE` enters the monotonic drain disposition, and any bound planning hold plus provider slot/resources remain until runner reconciliation |
| non-activating old-epoch `SUBMISSION_DRAINING` with sealed submission awaiting finalization | concurrent `graph.prepare_supersession` | unchanged | preparation returns `PLANNING_SUBMISSION_FINALIZING` and creates no stored plan/reservation/fence; the sealed submission retains its sole canonical finalization path |
| `PLANNING` with no live/unknown planner effect/resource, or `SUBMISSION_DRAINING` at runner-proven boundary | submission validation succeeds | `PLAN_REVIEW` | attempt/effect/resources/slot are proven terminal; one transaction creates the new immutable `PlanRevision` plus `GraphRevisionContent`/state, dependency contracts, and quality assessment |
| expansion submission with direct terminal proof or `SUBMISSION_DRAINING` at runner-proven boundary | core `EXPANSION_REFUSED` | `REJECTED` | stable refusal retained; attempt/effect/resources/slot are proven terminal; any preparation reservation/fence plus `EXPANSION_PLANNING` hold clear atomically; unchanged parent becomes eligible from its exact worker handoff |
| initial/revision submission with direct terminal proof or `SUBMISSION_DRAINING` at runner-proven boundary | core proposal refusal | `REJECTED` | stable findings retained and planning authority terminal; one deduplicated successor `PlanningRun` is created for retry, and an active replan atomically supersedes the old hold and creates the successor-bound hold without an unheld interval; explicit `goal.cancel` remains available |
| `PLAN_REVIEW` | `REVISE_PLAN` | `REJECTED` | findings retained; old draft rejected and successor draft/`PlanningRun` created; any bound hold is superseded/recreated atomically for the successor |
| expansion `PLAN_REVIEW|APPROVED` | `expansion.decline` | `CANCELLED` | decision/proposal retained and unactivated graph state becomes `REJECTED`; finalization already proves no live planner effect/resource/slot; preparation reservation/fence and expansion hold end atomically; unchanged parent becomes eligible from its exact worker handoff |
| `PLAN_REVIEW` | exact plan approval | `APPROVED` | approval binds exact plan/graph/quality/dependency hashes; still no execution authority |
| initial `APPROVED` with no active graph | `graph.approve` | `ACTIVATED` | exact approved identity activates atomically, creates initial runs, and increments `graphEpoch` from zero |
| replacement `APPROVED` with current prepared identity | `graph.supersede` | `ACTIVATED` | complete node/planning dispositions apply, active graph changes atomically, and applicable `NodeRun`/successor-hold records appear |
| initial `PLAN_REVIEW` | compound `graph.approve` | `ACTIVATED` | plan and graph decisions plus activation commit atomically; this is J1's one approval action and needs no supersession reservation |
| expansion `PLAN_REVIEW` with current prepared identity already displayed | compound `graph.approve` | `ACTIVATED` | the click binds the previously displayed prepared identity; plan/graph decisions and `graph.supersede` activation commit atomically as J2's one human approval action |
| expansion `PLANNING` with live/unknown effect/resource | `planning.cancel(ABANDON_EXPANSION)` | `PLANNING` + `CANCEL_DRAINING` | proposal authority fences, stronger cancel drain disposition records, and hold/slot/resource occupancy remain until reconciliation |
| expansion `CANCEL_DRAINING` at runner-proven boundary, or any expansion nonterminal with no live/unknown effect/resource | terminal cancellation | `CANCELLED` | attempt/effect/resources/slot/funding are terminal and any unactivated graph becomes `REJECTED`, then only this bound expansion hold clears and unchanged-parent eligibility restores; initial-goal cancellation uses `goal.cancel`, while an active replan uses `REVISE_PLAN` or explicit goal cancellation and cannot silently drop its safety hold |
| any nonterminal old-epoch run other than the proposal being activated, with no live/unknown effect/resource | replacement activation | `SUPERSEDED` | exact planning disposition fences submission, rejects any unactivated graph, supersedes its hold, and atomically creates a new-epoch successor hold/run only when the originating predicate remains applicable |
| any nonterminal old-epoch run other than the proposal being activated, with a live/unknown effect/resource | replacement activation | `PLANNING` + `SUPERSESSION_DRAINING` | proposal lease/submission fence immediately; `GRAPH_REMOVE_OR_SUPERSESSION` becomes the strongest drain reason; old hold is superseded and any still-applicable predicate receives an atomic new-epoch successor hold/run; terminal proof later moves the old run to `SUPERSEDED` |

An identical-byte plan may be re-presented by exact hash; every changed plan revision changes its `NodeDefinition`/`nodeAuthorityHash` and therefore requires a successor draft graph plus graph approval. For an active goal, `REJECT_PLAN`, a requirements defect, dependency challenge, or replan request holds the affected old run and opens that successor draft. The old run never transitions backward to `PLANNING`; activation carries, changes, or removes it through Section 10.

Every replacement proposal has a complete `PlanningDispositionSet` in addition to node dispositions. It enumerates the activating run plus every other nonterminal `PlanningRun`, `PlanningAttempt`, `PlanningSubmission`, proposal lease/effect/resource/slot, and `PlanningHold` bound to the old `graphEpoch`. Each other run is daemon-classified as `SUPERSEDE_DROP` when its predicate is no longer applicable or `SUPERSEDE_REPLAN` when the predicate still applies to named new-revision nodes. Unknown applicability returns `PLANNING_DISPOSITION_UNKNOWN` before approval/activation. `SUPERSEDE_REPLAN` atomically changes the old hold `ACTIVE -> SUPERSEDED` and creates exactly one deduplicated `ACTIVE` hold plus successor `PlanningRun` bound to the new epoch; the successor cannot claim until the old planner effect/resource/slot is terminal. `SUPERSEDE_DROP` creates no successor hold. In both cases any old staged submission becomes ineligible, business commands fence at activation, and live/unknown external authority drains under the shared monotonic disposition. The stale planner epoch then permits only runner observation, effect/resource reconciliation, safe-boundary recording, budget settlement, and evidence/export; no planner-authored progress, release, retry, submission, or new effect is accepted. Thus activation never leaves an old-epoch ghost hold, abandons a still-applicable safety predicate, or permits two planner effects for the same lineage.

Preparation closes the pre-activation churn window with a durable `PreparedPlanningFence` over every enumerated **non-activating** old-epoch planning lineage. It is not allowed to create that fence while any such lineage has an immutable sealed `PlanningSubmission` in `SUBMISSION_DRAINING` awaiting its runner-proven finalization boundary. Prepare and finalization serialize on the goal version: if finalization commits first, prepare recomputes against the resulting `PLAN_REVIEW|REJECTED` content; if prepare observes the pending submission, it returns `PLANNING_SUBMISSION_FINALIZING` with no prepared record and retries only after finalization. Preparation never cancels, discards, or indefinitely freezes sealed work before approval.

Once current, generated admission rejects `planning.claim`, `plan.propose`, new attempt/effect/resource/budget authority, and pre-activation `effect.activate` for fenced lineages with `SUPERSESSION_PREPARED`; the scheduler cannot autonomously reclaim them. A planner effect already `ACTIVE` at prepare may only renew, emit non-authoritative journal/progress, reach a runner-proven safe release/drain, and reconcile its existing effect/resources/budget. A pre-active intent is tombstoned and released after absence/resource proof. The prepared digest parameterizes only those monotonic terminal/release movements inside the already-bound attempt IDs and frozen upper liability; it never parameterizes a new claim, submission, identity, resource, or spend authority. Execution/integration/verification/review work is not paused by this fence. `graph.release_preparation`, approval rejection, expansion decline, replacement/invalidation/expiry, planning/goal cancellation, or successful activation atomically releases/consumes the fence with its reservation; release keeps the proposal reviewable and recomputes planning readiness. The UI shows affected planners, deadline, and consequence before approval. The disposition set, fence, and all successor identities are approval-hashed and replayed atomically; an unenumerated or class-changing event returns `SUPERSESSION_CONSEQUENCE_CHANGED` with no epoch increment, but ordinary scheduler churn cannot manufacture that event.

The active `NodeRun` relation is:

| From | Command/outcome | To | Required durable effect |
|---|---|---|---|
| `EXECUTION_READY` | execution claim | `EXECUTING` | input manifest, attempt, leases, downstream-proof reservation, confirmed resources, provider-slot reservation, and launch intent commit together |
| `EXECUTING` | safe `work.release` | `EXECUTING` | attempt becomes `RELEASED`, exact handoff commits, run is resumable/unowned |
| unowned resumable `EXECUTING` | successor claim | `EXECUTING` | new attempt/lease binds the same authority and input manifest plus handoff |
| `EXECUTING` | clean candidate plus applicable receipts | `WORK_REVIEW` | result manifest sealed under its `AcceptanceContract` |
| `EXECUTING` | retryable attempt failure | `EXECUTION_READY` | failed attempt retained; budget/loop policy permits a new one |
| `EXECUTING` + `DEPENDENCY_INVALIDATED` still strongest | runner-proven safe boundary | `EXECUTION_READY` | obsolete attempt follows its legal terminal path, result/output are invalidated/quarantined, old input manifest is ineligible, and fresh witness-bound materialization is required; a later stronger cancel/remove follows that stronger terminal `NodeRun` route instead |
| `WORK_REVIEW` | `REJECT_IMPLEMENTATION` | `EXECUTION_READY` | findings carried; next execution is a new attempt |
| `WORK_REVIEW` | proof-only qualification input invalidated while input/result/contract bytes still verify | `WORK_REVIEW` + `PROOF_INVALIDATED` | invalid proof is retained but ineligible; a bounded `REQUALIFY` evidence/review/approval run opens without authoring authority |
| `WORK_REVIEW` | witness or input/result material invalidated | `EXECUTION_READY` | result/review qualification is invalidated, untrusted bytes are quarantined, and a new witness-bound materialization/attempt is required |
| `WORK_REVIEW` | `REJECT_PLAN`/requirements/dependency defect | `WORK_REVIEW` + `REPLAN_REQUIRED` `PlanningHold` | successor draft planning opens atomically with its exact hold; no active authority mutation |
| `WORK_REVIEW` | eligible review plus required acceptance | `ACCEPTED` | exact current proof/approval predicates hold |
| `ACCEPTED` | any still-required qualification input invalidated before completion/horizon | `ACCEPTED` + `PROOF_INVALIDATED` | accepted history is immutable but no longer qualifies current closure; daemon classification opens exactly one `REQUALIFY`, `REEXECUTE`, or ordinary `CHANGE` recovery and completion is forbidden until a new current qualification |
| any nonterminal | authorized cancel/removal/supersession | `CANCELLED` | active authority fenced; terminal reason distinguishes user cancel from supersession |

`CANCELLED` and `ACCEPTED` are terminal phases for that run. Qualification invalidation never moves them backward: proof-only `REQUALIFY` creates a new qualification record over the unchanged verified result, while material `REEXECUTE|CHANGE` uses an explicit successor revision/run disposition. A review lease may release and be reacquired in `WORK_REVIEW` through `review.release|start`; it cannot edit artifacts. Archival is presentation metadata.

Attempt transitions are independently explicit:

- `CREATED -> LEASED -> LAUNCH_REQUESTED`, then provider `effect.activate` atomically commits `LAUNCH_REQUESTED -> RUNNING` with effect `ARMED -> ACTIVE`; `RUNNING` means logical external-effect activation and therefore may precede observed OS spawn/registration;
- `LEASED` or `LAUNCH_REQUESTED -> FAILED | CANCELLED | SUPERSEDED | RELEASED | UNKNOWN` when launch cannot or should not proceed **and every effect/resource is proven absent or released**; `RELEASED` additionally requires a committed safe-release handoff;
- `LEASED|LAUNCH_REQUESTED -> DRAINING` when the provider effect is still pre-active but any confirmed external resource remains active or release is unknown. The transaction tombstones the provider effect and releases its provider slot, but the attempt/`NodeRun` remain held until resource reconciliation;
- `RUNNING -> SUCCEEDED | FAILED | CANCELLED | UNKNOWN` for ordinary outcomes;
- between declared external steps, runner proof permits `RUNNING -> CHECKPOINTED -> RELEASED`; with an active step/effect/resource, release first uses `RUNNING -> DRAINING -> CHECKPOINTED -> RELEASED`;
- any supersession, invalidation, cancel, release, or submission-finalization reason with an active/unknown effect or resource commits `RUNNING -> DRAINING`; a later stronger reason updates disposition without another phase edge;
- `DRAINING -> CHECKPOINTED -> SUCCEEDED | RELEASED | CANCELLED | SUPERSEDED` uses the current monotonic `DrainDisposition`; `SUCCEEDED` is available only to a safely finalized immutable planning submission;
- cancellation with an active step/effect/resource uses `RUNNING -> DRAINING -> CHECKPOINTED -> CANCELLED`; direct `RUNNING -> CANCELLED` requires proof that no active effect/resource remains;
- `RELEASED`, `SUCCEEDED`, `FAILED`, `CANCELLED`, `SUPERSEDED`, and `UNKNOWN` are terminal attempt outcomes. A successor always has a new attempt ID; later discovery is `AttemptReconciliation`, not history rewriting.

`work.release` during an active process is a durable drain request, not an acknowledged safe handoff. Only a `SYSTEM_RUNNER` safe-boundary observation plus resource/effect reconciliation may finish `RELEASED` and make successor claim legal. Planning release follows the same no-overlap principle for its planner effect. Resource-held, between-step, running-step, review, crash, and replay cases are generated tests.

Drain precedence is frozen, persisted, and monotonic while an attempt is nonterminal: `URGENT_REVOKE(70) > GRAPH_REMOVE_OR_SUPERSESSION(60) > GOAL_CANCEL(50) > WORK_CANCEL(40) > DEPENDENCY_INVALIDATED(30) > WORK_RELEASE_OR_PAUSE(20) > SUBMISSION_FINALIZE(10)`. Each request unions its reason into `DrainDisposition`; only a higher rank changes the target, no request removes a reason, and equal-rank ties use stable reason code. Any rank above release invalidates resumable handoff/output eligibility; any rank above submission finalization prevents its proposal from becoming reviewable. The safe-boundary transaction reads the strongest **current** reason after effect/resource reconciliation and maps it to `CANCELLED`, `SUPERSEDED`, `RELEASED`, or planning `SUCCEEDED`. Release -> invalidation/cancel/remove and cancel -> remove are generated in every order around crashes.

Integration has one generated canonical relation:

```text
WAITING_INPUTS <-> HELD
WAITING_INPUTS -> READY -> INTEGRATING
INTEGRATING -> FINDINGS_OPEN -> INTEGRATING
INTEGRATING -> VERIFIED -> REVIEW_READY
INTEGRATING | FINDINGS_OPEN -> FAILED | INVALIDATED | SUPERSEDED
```

Returning from `FINDINGS_OPEN` requires an explicit resolution inside the same material contract; a material contract/criteria/scope change requires a successor revision. Approval state is `PENDING -> DECIDED|WITHDRAWN`, immutable decision `APPROVE|REJECT`, and validity `CURRENT|INVALIDATED|SUPERSEDED`. These generated relations are the only ones used by core, UI, MCP, IDEs, tests, and import.

`QualificationRecoveryRun` is also generated: `PENDING -> READY -> RUNNING`; `RUNNING -> QUALIFIED | FAILED | UNKNOWN`; and `PENDING|READY|RUNNING -> CANCEL_DRAINING -> CANCELLED`, with a direct `PENDING|READY -> CANCELLED` only when every effect/resource is proven absent. Here terminal `FAILED|UNKNOWN|CANCELLED` describes the qualification **result**, not unresolved physical authority: each transition is legal only after every lineage lease/process/effect/resource/provider slot is proven terminal or absent and its budget is settled exactly or by a permitted conservative write-off, with no lineage unit left `RESERVED|QUARANTINED`. If result or process truth is unknown while any authority may remain, the run stays `RUNNING|CANCEL_DRAINING + NEEDS_RECONCILIATION`; it exposes only runner/adapter observe, `effect.reconcile|confirm_absent`, `resource.reconcile`, budget reconciliation, forensic inspection/export, evidence-justified replan, or `goal.cancel`. It cannot become terminal merely because a deadline elapsed.

The run binds the invalid qualification/source fingerprint, exact unchanged input/result/artifact digests, required evidence/review/approval recipe, finite budget, retry lineage, and independence policy, and has no workspace-write or artifact-authoring capability. `qualification.recover` is the canonical claim/start action from `READY`; it binds the read-only recovery lease/effect/budget and reaches `RUNNING` through the same activation fence as other effects. `QUALIFIED` atomically creates a new immutable `CURRENT` `AcceptanceQualification`; it never turns the old record current again. `qualification.retry` from `FAILED|UNKNOWN|CANCELLED` re-verifies all immutable material **and the terminal-authority proof for the complete prior recovery lineage**, consumes one finite retry, and creates a linked new `PENDING` run; it never reopens the terminal run or blindly duplicates an unknown effect. `qualification.replan` is legal only when independent daemon evidence now classifies material as `REEXECUTE` or the contract/criteria/policy slice as `CHANGE`; it creates the exact `PlanningHold`/successor planning route and prevents another qualification retry for that source, atomically fencing/draining an active recovery before its route may clear. `qualification.cancel` fences a nonterminal recovery and drains any effect/resource before `CANCELLED`; because the qualification remains invalid, its postcondition exposes only a still-legal bounded retry, evidence-backed replan, or `goal.cancel`, never silent acceptance. A late result from a reconciled/negatively-proven terminal lineage is deduplicated by effect ID and quarantined; it cannot qualify either the old or retry run. Discovery during any command that a bound material byte/contract is not exact cannot qualify and takes the same deduplicated `REEXECUTE|CHANGE` route. Failed/unknown/cancelled recovery therefore keeps closure held with generated, reason-coded `nextAllowedCommands`, not prose.

Goal pause is also explicit. `goal.pause(PAUSE_AFTER_CURRENT_STEP)` atomically blocks every new planner/executor/reviewer/integrator claim, step, and pre-activation effect while allowing lease renewal, runner observations, and the already-declared active step to reach its safe boundary; it then checkpoints/releases authority and fenceable resources. `DRAIN_AND_PAUSE` requests cancellation/drain immediately and holds until non-fenceable effects reconcile. `goal.resume` clears only this scheduling control, recomputes readiness/frontier in its transaction, and never revives terminal work. Pause is a visible intentional control, not a fabricated blocker or phase change.

### 8.2 Readiness and exact predecessor materialization

Moe exposes three distinct predicates rather than one opaque “blocked” bit:

- **logical ready:** every hard `DependencyContract` is currently satisfied and no semantic/policy/evidence/unknown predicate holds;
- **admission ready:** phase/ownership, exact plan, `NodeInputManifest`, context, downstream-proof budget, capability, and risk policy permit a claim;
- **dispatchable:** logical/admission readiness plus all required resources already confirmed `ACTIVE` (or atomically local), one provider slot atomically reservable, and no active lease, pause, supersession, or reconciliation hold.

Only a dispatchable node is in `READY_NOW`. A resource wait never changes the semantic DAG. A failed predecessor names the exact failed contract and descendants plus legal choices—retry predecessor, substitute a compatible approved result, propose a superseding rewire, or cancel—while unrelated work stays eligible.

`UNBLOCK_NEXT` means exactly one current typed predicate/artifact/resource confirmation remains and its producer/recovery command is known. More than one predicate remains fully enumerated but sorts after one-step items. `INTENTIONAL_WAIT` requires a current wait record. Any missing, stale, incompatible, or unresolvable truth is `UNSAFE_OR_UNKNOWN`; UI optimism cannot place it nearer to ready.

After logical dependencies satisfy, one transaction creates a system-owned `NodeInputMaterialization` intent over the exact graph base and ordered predecessor closure. The runner crosses Section 13.1's activation gate, materializes in a clean scratch worktree, and a second transaction revalidates current graph/producer/adoption facts and every dependency satisfaction witness before sealing the `NodeInputManifest`. Order is graph base, then transitive accepted predecessor results in topological/stable-`nodeKey` order, each artifact identity once. The resulting tree, producer attempts/epochs/adoptions, witness versions/digests, and inherited paths are hashed. No worker claim exists during this I/O. A consumer delta is relative to that input tree, not an imaginary base. Fan-in applies the shared closure once, then child-authored deltas; inherited bytes are never re-attributed or double-applied. Conflict, stale adoption, missing bytes, crash, changed predecessor digest, or changed witness invalidates/quarantines the effect and cannot create an attempt.

Every `REVOCABLE` witness is revalidated at materialization seal, executor claim, `effect.activate`, every `step.start`, candidate/result/evidence/integration seal, review/acceptance qualification, and each later gate through its declared consumption horizon. Its source-fact transaction also invalidates affected logical readiness immediately. A pre-claim flip tombstones materialization/launch intent and creates no attempt authority. A post-claim but pre-activation flip atomically tombstones/cancels the pre-active provider effect, releases its provider slot, fences leases, requests confirmed-resource release, settles/quarantines budget, and records `DEPENDENCY_INVALIDATED`. Only when every resource is proven released may `LEASED|LAUNCH_REQUESTED -> SUPERSEDED` and the `NodeRun -> EXECUTION_READY` commit directly; any active/unknown resource instead forces `LEASED|LAUNCH_REQUESTED -> DRAINING`, keeps the run held, and reaches `CHECKPOINTED -> SUPERSEDED` plus `EXECUTION_READY` only after reconciliation. After `effect.activate`, the attempt is already `RUNNING`; a flip upgrades its monotonic drain disposition, allows no new step/candidate/proof/integration/review/acceptance, drains/reconciles active effects/resources, invalidates/quarantines output, and reaches the strongest terminal target before the run becomes eligible. In `WORK_REVIEW` it follows the explicit invalidation edge above. After `ACCEPTED` but before the witness horizon, history remains immutable while its qualification becomes `INVALIDATED` and the general recovery classification below applies. Restored satisfaction always requires a new witness-bound materialization and attempt; a current or accepted attempt cannot adopt a changed witness in place. A `MONOTONIC` witness is exempt only because its registered schema and source operation prove the fact cannot regress.

The same fail-closed rule covers **every** still-required `AcceptanceQualification` input, not only dependency witnesses: approval/reviewer eligibility or validity, evidence freshness/receipt integrity, integration result, artifact/input/result bytes, policy/criteria, and qualification renderer/schema. The invalidation transaction re-verifies immutable bytes and chooses exactly one route. `REQUALIFY` is allowed only when node authority, input/result/artifact bytes, and material contract remain exact; it creates a bounded read-only `QualificationRecoveryRun` and a new qualification record after fresh evidence/review/approval. `REEXECUTE` is mandatory for missing/corrupt/stale/unknown material bytes even when `nodeAuthorityHash` is unchanged; it creates a successor graph/run disposition that explicitly forbids ordinary `CARRY`. Contract/criteria/policy change is ordinary `CHANGE`. Duplicate source notifications deduplicate by qualification/source fingerprint. In `CLOSING`, any route atomically returns the goal to `EXECUTION_ENABLED`; no invalid qualification can remain current or satisfy closure.

Every relevant transaction and replay recomputes readiness, derived holds, the frontier partition, and affected causal chains before commit. Mutable plain-table configuration cannot affect it. `held` derives only from named durable predicates: current blockers/intentional waits; active `PlanningHold`; invalid `AcceptanceQualification` with its bound recovery; `SUBMISSION_DRAINING|CANCEL_DRAINING`; exact `PreparedPlanningFence` membership for planning admission only; pause; `SUSPECT`/drain/reconciliation leases; resource/budget/policy holds; supersession dispositions; and failed join/input contracts. `EXPANSION_PLANNING`, `REPLAN_REQUIRED`, and `PROOF_REEXECUTE` are therefore first-class exact predicates, not labels. A hold is never toggled or kept alive by prose, and a prepared planning fence never holds unrelated execution work.

### 8.3 Anti-blocking planning admission

The planner's objective is lexicographic: preserve safety/acceptance contracts; minimize irreducible hard-edge stages and truth-classed critical-path range; expose useful ready width up to available capacity; then minimize nodes, edges, handoffs, integration/review overhead, and speculative waste. “Linear by default” means **one execution-bearing node** for ordinary work, not permission to turn one job into a long task chain.

Core can prove graph validity, exact submitted-graph structural metrics, and equivalence/redundancy for typed contracts; it cannot prove that an agent discovered the globally optimal decomposition or true duration. Decomposition quality and duration remain truth-classed estimates until fixed-fixture or measured evidence supports them.

Structural stage count is the maximum number of execution-bearing nodes on any hard-edge path after semantic reduction; submitted-graph critical path is that path weighted only by explicitly truth-classed duration ranges. Ready width is the exact count of logically/admission-ready independent nodes at a cursor, while dispatch width additionally respects resources/slots. UI and benchmark never mix these measures.

Every proposed graph runs the following admission pass:

1. reject self-edge, cycle, missing producer/consumer, cross-snapshot input, incompatible contract, stale fact, duplicate contract, and semantically transitively redundant hard edge with stable codes and no partial revision;
2. reject `HARD_DEPENDENCY_UNPROVEN` when an edge lacks its current typed contract; same epic, prose order, same repository, ownership, or resource scarcity is never proof;
3. require the minimum milestone actually consumed. Depending on an entire predecessor's acceptance is invalid when an earlier independently accepted interface/schema/fixture/decision artifact satisfies the consumer;
4. compute a semantic transitive reduction: a direct edge is redundant only when an existing path guarantees the identical input/predicate and invalidation semantics. A direct artifact edge that an intermediate node does not reproduce remains valid;
5. require every execution-bearing node either to be the exact `completionNodeKey` or to be a transitive required predecessor/acceptance obligation of it. Advisory/organizational nodes have no execution authority. An orphan executable node is `COMPLETION_CLOSURE_INCOMPLETE`, never work that can outlive a terminal goal;
6. compare the proposed graph with a one-node/sequential baseline and show hard-edge/stage counts, structural critical path, blocked descendants, ready width, node/handoff overhead, and duration/cost estimates with their truth classes. Unknown estimates never become zero or a speed claim;
7. for every serial edge, record whether an interface/fixture-first slice can safely unlock consumers. A generated stub/fixture must be non-production, hash-bound to an approved interface contract, have producer and consumer conformance recipes, and be replaced/verified during integration; it can enable implementation but never satisfy final production proof;
8. enforce the default goal decomposition budget: at most **24 nodes in one active graph**, **64 hard edges**, expansion depth `3`, child width `6`, and nine nodes per expansion. A raise is an exact `R2` human decision with cost/critical-path impact. An oversized single node may receive decomposition advice or a policy hold, but Moe never invents independence.

Core validates a hard edge's closed kind, exact predicate inputs, producer/consumer compatibility, freshness, and structural redundancy. An agent's semantic “why necessary” remains `AGENT_REPORTED` unless a daemon observation/recipe proves the counterfactual; human approval records the decision but does not upgrade that fact. Generic plan or graph approval **MUST NOT** activate an agent-only hard edge. The proposal must instead (a) obtain a daemon-verifiable witness for the typed consumed contract, (b) receive an edge-specific human decision that conservatively converts the uncertainty into a reason-bound `POLICY_SEQUENCE` and displays its added stages/critical-path cost, or (c) refuse/downgrade the relation to advisory. Auto-policy expansion requires daemon-verifiable dependency inputs. Semantic uncertainty is shown for human review or held `UNKNOWN`, never silently called independent or required.

Admission properties include matched positive controls: removing every edge cannot pass. Each known-required producer/consumer fixture removes one edge at a time and must then fail the consumer's exact input/conformance oracle or readiness predicate; the accepted graph retains the minimum edge. Each false/redundant-edge fixture must reject the unnecessary edge. A planner therefore earns parallelism without gaming ready width by omitting real dependencies.

A structural expansion is auto-policy-eligible only when current scope/oracle/budget/dependency proofs hold and it improves the structural stage/ready-frontier objective after orchestration cost under the configured conservative assessment. If duration benefit is `UNKNOWN`, a human may approve the transparent trade-off; the product may not call it faster. A legitimate irreducible chain remains legal. Dependency challenges and plan rejection always use a successor draft; no optimizer silently edits the active graph.

### 8.4 Blocker challenge, replanning, and frontier scheduling

Staleness means blocker evidence needs re-observation, not that the blocker is false. Every source-fact change/replay atomically re-evaluates matching typed predicates. A false predicate resolves once; a still-true predicate renews with new evidence; expired/unknown evidence remains held and enqueues `blocker.challenge`. Timers merely submit that transactional command. `IntentionalWait` suppresses time-only challenge until `recheckAt`, but new relevant evidence still triggers evaluation.

Graph activation supersedes every old graph-bound blocker/wait projection. The new revision carries one only through an explicit exact predicate/fact adoption and immediately re-evaluates it; an old blocker ID or prose cannot survive edge removal or predecessor substitution as a ghost hold.

A daemon-owned `SEMANTIC_PREREQUISITE` blocker must reference an existing current hard `DependencyContract`; its affected set is derived from that edge's consumer closure, and the blocker reference participates in the same cycle, redundancy, freshness, and completion-closure admission as the graph. `blocker.open` from an agent creates only an `AGENT_REPORTED` `DEPENDENCY_DISCOVERY` self-hold on the caller's currently leased node. It cannot hold a foreign node or invent a runtime edge. Daemon validation either maps it to an already-admitted contract or opens one deduplicated `DependencyChallenge` and bounded successor `PlanningRun`; only approved supersession can create the new cross-node prerequisite. A privileged graph/policy command is required for any cross-node affected set. Mutual hidden holds such as A-on-B plus B-on-A are rejected, not represented outside the DAG.

If an unfinished execution-enabled goal has no active work and no `READY_NOW`/`UNBLOCK_NEXT` node, and no current human, intentional, external, resource, budget, safety, or `UNKNOWN` hold explains it, the same transaction emits `FRONTIER_STALLED`, one deduplicated `REPLAN_REQUIRED` `PlanningHold`, and its bound `PlanningRun`. `replan.propose_unblock` is keyed by graph epoch, stalled-frontier fingerprint, source fact versions, round counter, and reserved planning budget. It may propose edge removal, compatible producer substitution, interface-first slicing, node split/coalescing, or safe sequential fallback. Unchanged evidence cannot emit another proposal; loop exhaustion escalates. Default automation stops at **propose**. The hold clears only with the bound planning terminal/supersession transition. Activation still follows exact risk, approval, and supersession rules; schedule-only auto-approval is opt-in and allowed only when daemon proof shows no change to criteria, scope, budget, recipes, artifact contracts, or authority hashes.

Scheduling is deterministic, project-wide, work-conserving, restart-stable, and starvation-bounded under declared capacity:

The queue's `WorkItem` union is a ready `PlanningRun`, executor `NodeRun`, integration run, verification run, review round, `QualificationRecoveryRun`, or read-only agent request. Each has role-specific admission predicates but shares provider-slot capacity and cross-goal fairness; a planner or requalification flood cannot starve execution or review.

- project policy defines host/provider/model/profile slot dimensions. The default admits at most **four `RESERVED|ACTIVE` provider slots project-wide** and four per goal, counting planners, executors, integrators, verifiers, qualification recovery, reviewers, and read-only agents. Claim atomically creates `RESERVED`; `effect.activate` makes it `ACTIVE`; proven pre-activation cancellation or terminal/release frees it. Active-session utilization is measured only `ACTIVE` through terminal/release. A held/resource-waiting node has no slot reservation, preventing both overbooking and head-of-line capacity waste;
- ordinary selection uses two-level weighted deficit round-robin: first a goal, then one of that goal's eligible role queues. Each ring has positive integer weights `1..16`, unit dispatch charge, base quantum one, a stable next cursor, and deficit capped at its configured weight. At each round boundary Moe freezes an ordered `currentRound` cohort of already-eligible queue IDs/weights. On a visit it tops that queue to its weight, dispatches while unit deficit and eligibility remain, decrements both selected goal and role deficits, then advances when the selected level has no unit deficit/eligible item. Empty/ineligible members accrue no credit and retain zero deficit;
- a newly eligible or re-entering goal/role queue never inserts ahead of an unvisited current-round member. It appends to a durable `nextRound` cohort ordered by first eligibility event and stable queue ID; only after every surviving `currentRound` member has been visited does an atomic round rollover merge that cohort and apply pending weight changes. Defaults are weight one for every goal and for planning, execution, integration, verification, qualification, review, and read-only roles. These rings determine ordinary share, but they are not the starvation proof;
- every continuously dispatchable item also receives a durable `FairnessTicket` bound to one canonical compatible provider-slot dimension `d`, the immutable scheduler-policy/cap revision, continuous-eligibility event, starting priority, bypass counter, and any forced-cohort entry. A **compatible bypass opportunity** is a committed dispatch of another item using a slot in `d` at an instant when this ticket passed every logical/admission/resource predicate and could have consumed that slot. Dispatches on incompatible or unavailable capacity do not count and cannot be used to claim progress. Every claim, release, cancellation, eligibility/cap/weight change, or rollover updates the ticket and both rings in the same transaction. Restart/replay reconstructs them exactly; it never resets promotion, bypass, cursor, or deficit. Loss of dispatchability closes the current continuous segment without erasing accumulated promotion/bypass history; re-entry opens a new segment and can never improve its priority through churn;
- ordinary user priority has exactly four finite classes `P0` (highest) through `P3`. A ticket promotes one class after each eight compatible bypass opportunities; eight further bypasses at `P0` atomically appends it to dimension `d`'s forced cohort. The forced lane is served before both WDRR rings and is FIFO by immutable `forcedCohortEntryEvent`, then `workItemId`; continuous-eligibility age is display evidence, not a key that lets an item forced later jump an existing cohort. A forced ticket that loses dispatchability atomically leaves the active forced cohort; if it later re-enters while still forced it receives a new entry event at the tail. Thus dormant work cannot reserve an ahead position, and a later arrival, recovery rank, goal/role weight change, queue rollover, or remove/re-enter identity cannot move ahead of a continuously dispatchable forced ticket;
- policy must set a hard `M_d`, the maximum simultaneous continuously dispatchable tickets for each compatible dimension, with a default project-wide ceiling of 10,000 across all dimensions. Let `c` be the ticket's remaining eight-bypass promotion buckets, including the final forced threshold. With no `SAFETY_EMERGENCY`, selection occurs within at most `8*c + M_d` compatible bypass/selection opportunities: after at most `8*c` bypasses the ticket is forced, at most `M_d-1` already-forced eligible tickets can remain ahead, and its own selection is one. At forced entry Moe also publishes the tighter exact remainder `F_ahead + 1`. Later arrivals and weight changes cannot increase either value because they append behind the forced ticket; a cap raise cannot admit beyond the old `M_d` until every affected pre-raise ticket is selected, becomes terminal/ineligible, or is migrated to an equal-or-tighter signed deadline. The timeline records every counted opportunity and non-count reason, making the bound replayable rather than inferred from wall time;
- the same aging rule governs each resource queue. A head waiting for one resource/provider never blocks unrelated ready nodes or resource IDs, and all-required acquisition still holds no partial set;
- after any claim/release/prerequisite/resource/supersession transaction or restart, if a slot and dispatchable node exist, the scheduler must commit a claim/effect intent or a stable refusal within the configured dispatch bound. Under the reference release load that bound is **one second**. Every interval with idle capacity records `NO_READY`, `RESOURCE`, `POLICY`, `BUDGET`, `PAUSE`, `UNKNOWN`, or `SCHEDULER_VIOLATION`; there is no unlabeled idle.

Only an active safety/recovery incident may suspend the ordinary fairness bound; it creates a visible `SAFETY_EMERGENCY` capacity hold with owner, evidence, affected slots, and recheck/escalation. “High priority” alone cannot disable aging.

`frontier.get`, `dependency.explain`, and `scheduler.readiness_explain` return an exact cursor/graph epoch, all causal predicates, source facts/truth/freshness, dependency path, resource/capacity state, selection key, and legal recovery commands. They never answer from a stale client-side graph.

### 8.5 Linear default and fan-out admission

A new goal proposes one execution-bearing node unless a validated expansion improves the admitted plan. Write fan-out is admitted only if all four preconditions are daemon-checked:

1. **Scope:** child write scopes are pairwise disjoint under a fresh `ScopeResolutionObservation` over the exact base/input closure after canonical path, symlink/junction, case-folding, submodule, and repository-boundary checks. An explicitly proven overlap may instead use a `SCOPE_SERIALIZATION` contract or remain one node; it cannot masquerade as independence.
2. **Oracle:** every child names an eligible machine-checkable acceptance recipe. It has nonempty criterion/artifact-linked assertions, daemon-controlled argv, bounded timeout/output, policy-reviewed adequacy, and a pre-change negative control where the task is a claimed bug fix. When a negative control is inapplicable, the recipe declares an explicit non-regression/constructive classification. An empty/no-op/always-zero command or reviewer judgment alone is not an oracle.
3. **Budget:** child, contingency, mandatory integration, verification, and review reservations fit the conserved parent envelope with required measurement coverage.
4. **Flow:** every hard edge has a current dependency contract, the goal-wide decomposition budget fits, and the bound `PlanQualityAssessment` shows the sequential baseline and honest structural/estimated benefit.

Read-only nodes may run in parallel only against the same pinned repository/artifact snapshot and have no mutating capability. The sole compound mutator is `plan.propose(kind=EXPANSION)`: after Section 8.1's safe submission finalization, it either creates the plan plus graph together or returns `EXPANSION_REFUSED` with stable reasons and a reviewable one-node or proven-dependency sequential alternative. It creates no child run, lease, budget allocation, blocker, or partial graph. `graph.preview` is a read-only advisory calculation over supplied bytes and can never create or refuse authoritative content.

V1 supports one unambiguous expansion mode: replace the expanded node with a composite child subgraph whose explicit `completionNodeKey` determines the composite outcome and whose required transitive closure contains every execution-bearing child. Ambiguous “attach work but keep the old parent semantics” is deferred. A node rename is remove plus add; Moe performs no heuristic identity matching.

### 8.6 Expansion protocol

A running task may request multiple agents, but it cannot mint them. At a runner-proven safe boundary, `graph.request_expansion` commits the handoff, ends the worker attempt/lease/provider slot as `RELEASED`, creates an exact `EXPANSION_PLANNING` `PlanningHold` on the resumable parent, and opens its bounded `PlanningRun` from the active node/revision with the rationale as `AGENT_REPORTED` input. A planner profile—including the same principal only after that release—must produce the full proposal below. The hold is an exhaustive readiness predicate and remains through planner submission/cancel drain and restart. Only after effect/resource/slot terminal proof may core `EXPANSION_REFUSED`, human `expansion.decline`, or typed `planning.cancel` atomically resolve this hold and make the unchanged parent eligible from its original worker handoff. `REVISE_PLAN` is deliberately different: it supersedes the old hold/run with an exactly bound successor while never leaving the parent unheld. Approved activation supersedes the parent with the composite and resolves the hold in the same transaction. Until activation, there are no child runs, leases, worktrees, reservations, or launches.

1. The leased planner proposes child definitions, exact embedded child/integrator plan revisions, dependency contracts/relations, scopes, oracles, budgets, input/integration contracts, quality assessment, and completion node against its expected planning-run/goal version and proposal-base hash.
2. Core validates canonical hashes, DAG and semantic reduction, containment, goal/expansion limits, capacity, policy, resources, fresh scope/dependency observations, oracle eligibility, input materializability, and budget.
3. Policy returns `ALLOW`, `DENY`, `REQUIRE_HUMAN_APPROVAL`, or `HOLD_UNKNOWN` with matched rule IDs and obligations.
4. One approval binds the complete expansion, dependency/quality diff, embedded child/integrator plans, and immutable graph revision, and transfers child/input/integration/verification/review allocations in one transaction. It never bypasses a child plan.
5. Activation creates ready runs atomically; the project-wide fair scheduler claims children independently up to both project and goal capacity. A child group lease does not exist.
6. Parent completion remains derived from durable child outcomes and the join contract; it cannot be toggled.

One expansion costs at most one human approval. The decision surface shows verified scope, dependency proof and challenged edges, interface-first alternatives, oracle presence, budget coverage, critical-path/frontier before and after, estimate truth, risk, join, and the exact consequence of withholding approval.

## 9. Fan-in and integration contract

Worktrees prevent shared-checkout corruption; they do not prove that independently correct changes form one coherent product. Every fan-out therefore includes one first-class integration node and a budget reserved before any child launches.

### 9.1 Integration contract

An immutable `IntegrationContract` names:

- exact base repository SHA and revision-independent integration semantics; a separate immutable graph-revision binding names the active revision;
- exact required child slots and the v1 `ALL_REQUIRED` join policy;
- accepted artifact types, interface contracts, and predecessor-input closure rules;
- deterministic application order: graph base, union of inherited predecessor artifacts exactly once in topological/`nodeKey` order, then child-authored deltas in topological/`nodeKey` order;
- union of child write scopes plus any separately declared integration-only scope;
- global verification recipes and semantic-coherence criteria;
- integrator independence requirement, budget, and review policy;
- allowed outcomes and repair routing.

### 9.2 Child output admission

Each child produces a `NodeResultManifest` with its exact input manifest/tree, authored commit or canonical delta, result tree, inherited/authored path split, receipts, decisions, and journal references. `integration.accept_output` verifies, inside its transaction:

- the child node is `ACCEPTED` under its leaf `AcceptanceContract` in the active revision or has an explicit unchanged-node adoption; downstream integration/final-review obligations are not prerequisites of leaf qualification;
- the producing attempt and lease epoch were authoritative when output was sealed;
- the attempt's authority binding is current or explicitly carried forward;
- graph base, input closure/tree, authored delta, result tree, artifact, context, graph, plan, and receipt digests match;
- every authored path is in scope, inherited paths have their exact producer identity, and no foreign staged/untracked change is smuggled in;
- every required child oracle has a daemon-issued successful receipt.

A stale epoch, old revision without adoption, out-of-scope path, digest mismatch, or missing receipt creates a structured finding and quarantines that output. It never lands in the integration worktree.

### 9.3 Integration attempt

`integration.start` is one atomic command transaction after revalidating graph epoch, every exact child result and transitive input, budget, independence, resources, and scope observation. It creates the integration attempt, assignment/workspace/resource reservations, and immutable `IntegrationInputManifest` before external work starts. That manifest contains the active graph binding, graph base, deduplicated inherited-artifact closure, ordered exact child result/delta IDs and digests, producer attempts/epochs/adoptions, deterministic application plan, expected intermediate trees, contract, and input-manifest digest. Input membership cannot change during the attempt.

The integrator is always a distinct principal/profile/session from all child producers and has no child mutating lease. It receives a dedicated worktree from the graph base, materializes the shared predecessor closure once, applies only each child's authored delta in manifest order while checking expected trees, and records child deltas separately from its own integration diff. The same predecessor commit can never be double-applied or attributed to a child.

The integrator MAY resolve implementation-level conflicts inside the declared integration scope. It MUST NOT silently change acceptance criteria, public interface contracts, policy, scopes, or budget. Such a material contract change opens an `IntegrationFinding` and routes to a repair node or new graph revision.

Integration uses only the generated canonical relation in Section 8.1; this section defines no second copy.

At seal, a second transaction creates an immutable `IntegrationResultManifest` referencing the input-manifest digest plus the integrator epoch, final tree, its own diff, resolved findings, global receipts, current dependency-witness set, and current graph/policy. It never mutates the input manifest. The join is satisfied only by that result manifest. A missing, failed, cancelled, or budget-exhausted required child holds the join for re-plan/cancel; cardinality never silently shrinks. No cross-revision join is permitted without explicit carry-forward records for every reused input. Composite/parent acceptance is derived only from its graph-designated `completionNodeKey` reaching `ACCEPTED`; goal completion separately follows the `CLOSING` zero-authority proof in Section 8.1.

`FINDINGS_OPEN` returns to `INTEGRATING` only after each non-material finding has an explicit resolution and the integration worktree is re-observed. Material criteria/interface/scope/policy changes invalidate the attempt and require a new revision. No unresolved finding may enter `VERIFIED`.

### 9.4 Semantic-conflict and same-bug handling

Global recipes and the integrator rubric check interface, behavior, duplication, and cross-child coherence even when files are disjoint. A semantic conflict is expected integration work, not an auto-merge exception.

A failure signature is a canonical hash of verification recipe/check ID, stable failure code/test identifiers, and repository-relative primary path, excluding timestamps, temporary paths, and provider prose. The breaker groups only siblings in the same graph revision. At the policy threshold it atomically:

- emits one breaker event;
- holds unstarted siblings and prevents retries/new launches;
- preserves their reservations and context;
- proposes a superseding revision with one upstream repair predecessor or a sequential re-plan;
- after repair acceptance, rematerializes affected children as new attempts against the repaired base/authority; only records with an identical full recursive hash may carry.

Generic exit codes without a stable check identity do not auto-group; they alert for human triage. Different checks in one file and equal signatures in unrelated goals/revisions are negative controls.

## 10. Immutable revision supersession

Graph revision content is immutable and its generated state relation is `DRAFT -> PENDING_APPROVAL -> APPROVED -> ACTIVE -> SUPERSEDED`, with `DRAFT|PENDING_APPROVAL|APPROVED -> REJECTED` before activation. A state cannot move backward. A draft goal has no active revision; an execution-enabled goal has exactly one.

Initial activation has no fake “old graph.” Compound `graph.approve` records the exact plan and graph decisions—or consumes a separately current exact plan approval—and binds graph/quality/budget/policy hashes plus expected goal version while `Goal=DRAFT` and no active revision exists. One transaction verifies that absence, records the canonical `PENDING_APPROVAL -> APPROVED -> ACTIVE` events (or `APPROVED -> ACTIVE`), increments `graphEpoch` from `0` to `1`, creates initial `NodeRun`/budget bindings and frontier, moves the goal to `EXECUTION_ENABLED`, and writes projections/outbox. A concurrent activation loses by version; a crash yields all or none. Replacement activation instead computes and displays the complete hashed disposition plan below.

### 10.1 Node impact classes

- `ADD`: absent in old revision; create a new run under the new revision.
- `CARRY`: same stable `nodeKey` and identical `nodeAuthorityHash`, with current qualification and every carried input/result byte still verified; preserve phase, attempt, artifacts, and lease through explicit adoption/binding records.
- `REQUALIFY`: same stable key/authority and exact verified input/result/artifact bytes, but a proof-only qualification input is invalid; preserve immutable result history, forbid current acceptance use, and create a bounded qualification-recovery run rather than an executor.
- `REEXECUTE`: same stable key/authority may remain, but input/result/artifact material is missing, corrupt, stale, or unknown; ordinary `CARRY` is forbidden and a successor `NodeRun` generation requires fresh materialization/attempt. This explicit disposition prevents hash equality from adopting untrustworthy bytes.
- `CHANGE`: same key but different authority hash; old work cannot satisfy the new node.
- `REMOVE`: not present in the new revision; old authority ends.

Ambiguous key mapping, unknown canonicalization, or an incomplete/unknown `PlanningDispositionSet` blocks preparation with `SUPERSESSION_MAPPING_UNKNOWN` or `PLANNING_DISPOSITION_UNKNOWN`.

V1 does not stack supersessions. A live old-epoch planner handled by the exact `PlanningDispositionSet` of the activation now being prepared is part of that one supersession, not a pre-existing stack. If any disposition from an earlier supersession is already `DRAINING`, has an unreconciled resource/process/effect, or still owns a historical authority binding, preparation/activation returns `SUPERSESSION_IN_PROGRESS`. A later version may compose dispositions only by enumerating and atomically re-dispositioning every live historical binding; v1 never compares only the latest graph while ignoring older live authority.

### 10.2 Atomic activation

`graph.preview` remains a zero-authority advisory query. The named mutating preparation boundary is `graph.prepare_supersession(expectedGraphEpoch, targetGraphHash, proposalGuardHash)`. It requires a safely finalized replacement proposal and zero non-activating old-epoch sealed submissions awaiting finalization, then recomputes all node and planning dispositions. Pending sealed submission, insufficient/unknown funding, or incomplete disposition truth returns a stable refusal and creates nothing. Otherwise one idempotent transaction stores one immutable `SupersessionPlan`, creates one `HELD` `SupersessionFundingReservation`, installs its exact `PreparedPlanningFence`, and returns the exact approval payload/`supersessionPlanHash`. Reservation, fence, and stored plan are whole-or-none and share one preparation generation. The same command ID/request returns its original result forever; while that generation remains current, another command with the same proposal/guard hash returns the same identities. After its reservation/fence is terminal, a new command creates a new preparation generation and therefore a new approvable hash; it never revives terminal authority. A different request under the same command ID conflicts. Preparation creates no execution/planning lease, activation, or graph-epoch change. A newer prepare first invalidates/refunds/releases the prior unapproved generation atomically. Human/policy approval can bind only this stored prepared identity, never advisory preview bytes. `graph.release_preparation` reversibly invalidates an unconsumed generation and approval, refunds/releases its reservation/fence, and leaves the immutable proposal in review. `graph.supersede` is the distinct activation command and consumes the current approval/prepared identity.

Human/policy approval binds the exact `supersessionPlanHash`: old/new graph hashes, node impacts, the complete `PlanningDispositionSet` and `PreparedPlanningFence`, a parameterized conservative budget-disposition formula and successor funding guard, safe-boundary policy, and a daemon-computed `DispositionEquivalenceDigest`. The prepare transaction holds the exact per-meter minimum required by every mandatory successor allocation without relying on a projected refund from live old work; old work cannot consume it. Exact prepare-time available/reserved/committed/quarantined amounts remain immutable referenced audit evidence. For guarded live meters, the equivalence digest hashes instead the immutable per-meter upper-liability bounds, settlement formula, fully held successor minima/reservation identity, and normalized disposition class, so an in-bound usage delta cannot both change the hash and be called equivalent. For every other field the digest includes every fact capable of changing disposition/adoption: goal lifecycle/scheduling control; each affected `NodeRun`/integration lifecycle; every old-epoch planning run/attempt/submission/hold/lease/effect/resource/slot, fence membership, and proposed successor identity; active attempt/current declared step; result, evidence, integration-result, review, finding, acceptance, and approval IDs plus validity/adoption sets; all applicable hard-contract and dependency-witness versions/digests; blocker, intentional-wait, and replan fingerprints/source versions; risk/policy decisions; lease authority class (`ACTIVE|SUSPECT|DRAINING`); resource epochs/ownership; effect identity and pre-activation/active/terminal/unknown class; and input binding. Renewal deadlines, presence, journal/progress prose, observation timestamps, and in-bound live-meter actuals are excluded only because the bound/formula proves they cannot alter an enumerated consequence. Activation performs one transaction:

1. checks approval, the exact stored prepared-plan hash, expected active revision/`graphEpoch`, current `PreparedPlanningFence`, recomputed equivalence digest and complete `PlanningDispositionSet`, current graph admission/completion closure, dependency/witness freshness, `HELD` funding-reservation identity, and successor budget feasibility. An unenumerated planner identity/submission/hold, disposition-class change, phase/proof/review/approval/blocker/witness change, or usage delta outside the approved conservative liability/funding guard atomically invalidates/refunds/releases the preparation generation and returns `SUPERSESSION_CONSEQUENCE_CHANGED` with its typed delta for a new prepare. Monotonic release/drain inside the prepared planning envelope and usage inside a frozen upper-liability bound proceed only when recomputing the approved formula yields the same normalized dispositions and fully reserved successor minima; benign renew/progress traffic cannot stale approval;
2. increments `graphEpoch` exactly once, marks the old revision `SUPERSEDED`, and marks the new one `ACTIVE`;
3. consumes the `PreparedPlanningFence` into the stale-epoch disposition fence and applies the complete `PlanningDispositionSet`: the activating run becomes `ACTIVATED`; every other old-epoch planner/submission remains fenced by the new epoch, any live/unknown attempt receives `GRAPH_REMOVE_OR_SUPERSESSION` and drains, old holds become `SUPERSEDED`, and each still-applicable predicate receives exactly one new-epoch successor hold/run with no unheld interval;
4. creates `CarryForwardDecision` and `AttemptAuthorityBinding` records for every `CARRY` node;
5. creates new runs/holds for `ADD`, `CHANGE`, and `REEXECUTE` nodes plus bounded qualification runs for `REQUALIFY`;
6. applies removed/changed attempt dispositions and increments epochs where business authority ends. Pre-activation `PENDING|CLAIMED|ARMED` effects that lost desired state are tombstoned; their not-running attempts may become terminal immediately only when every resource is proven absent/released. `LEASED|LAUNCH_REQUESTED|RUNNING` with any active/unknown process, effect, or resource enters `DRAINING`, receives the stronger disposition plus cancellation/reconciliation, and never receives a premature terminal label;
7. consumes the `SupersessionFundingReservation`, atomically closes/opens `BudgetAuthorityBinding` records, and transfers, retains, quarantines, or refunds subtree budget according to the approved formula and measured attempt state without copying an allocation;
8. appends events, projections, effect-cancellation messages, and outbox records atomically.

The `ExecutionAttempt.startedRevisionHash` never changes. Its binding history proves when and why an unchanged attempt became usable by the new revision.

Continual lease renewals, presence, and journal/progress observations concurrent with prepare/approval are a mandatory liveness test: activation succeeds within the dispatch/transaction bound or reports one stable **consequence-changing** hold. Planner claim/submission/hold, acceptance/rejection/review-validity, blocker/witness-source, lifecycle, and budget-usage commits are interleaved at every advisory-preview/prepare/approve/activate boundary; each either remains inside the exact approved parameterized guard or deterministically returns the typed delta. Repeated stale-prepare churn without a changed equivalence digest is a correctness failure.

### 10.3 Per-node disposition

**CARRY:** the lease remains authoritative only because its recursive `nodeAuthorityHash`, adopted `inputBindingHash`, material bytes, and applicable qualification are identical/current. The transaction closes the old binding, opens the new binding, and binds the lease and budget reservation to the new graph revision/`graphEpoch` without changing lease epoch or duplicating allocation. There is no interval with zero or two active authority/budget bindings. An old client binding receives `REVISION_REBOUND` and must refresh before its next command. A running executor may finish the already-started step, but MUST receive a newly rendered context digest before `step.start`; review always gets a regenerated `reviewInputDigest` and new reviewer binding; an integration attempt carries only when its exact input-manifest digest, base, contract, and full input closure are explicitly adopted. Final/composite reviews never carry across a changed graph; only node-local review slices with identical canonical input may be adopted. Events record both the attempt's started revision and current effective revision.

**REQUALIFY / REEXECUTE:** `REQUALIFY` adopts only still-verified material bytes and creates fresh evidence/review/approval authority; it cannot author or silently restore an invalid decision. `REEXECUTE` adopts definitions and trustworthy predecessor facts only, invalidates/quarantines the suspect input/result chain, creates a new `NodeRun` generation and input materialization, and cannot preserve the old accepted qualification/attempt/artifacts as satisfying work. Both are hashed when part of a supersession; their invalid-qualification predicate or `PlanningHold` clears only when the new authority/recovery records exist atomically.

**REMOVE:** activation immediately revokes assignment/workspace/fenceable-resource leases through a privileged direct `ACTIVE|SUSPECT|DRAINING -> REVOKED` edge, increments epochs, tombstones pre-activation `PENDING|CLAIMED|ARMED` effects, and releases a pre-active provider slot. It may mark only an attempt with no running/active/unknown effect **and every resource proven released** directly `SUPERSEDED`. Any `LEASED|LAUNCH_REQUESTED|RUNNING|DRAINING` attempt with a running process, `ACTIVE|UNKNOWN` effect, or unreconciled resource enters/remains `DRAINING`; `GRAPH_REMOVE_OR_SUPERSESSION` upgrades its disposition, invalidates any resumable handoff/output, requests cancel/reconciliation, and quarantines worktree/unintegrated artifacts. A later runner-proven safe-boundary transaction plus effect/resource reconciliation reads that strongest reason and commits `DRAINING -> CHECKPOINTED -> SUPERSEDED`. Crash/replay cannot skip or downgrade those states. Process termination is best-effort; immediate fencing is authoritative, so no post-activation business mutation is accepted even while the attempt truthfully remains `DRAINING`.

**CHANGE with every process/effect/resource proven absent or terminal:** revoke immediately, preserve evidence, create the new node run, and refund only proven unused reservation.

**CHANGE with any running/active/unknown process, effect, or resource:** mark the old attempt/lease `DRAINING`—including a pre-active attempt that only holds an uncertain resource—and the new run `HELD_SUPERSESSION`. A safe boundary is before a not-yet-started provider/step only when every acquired resource is also proven released, the end or cancellation of the already-declared external process/`StepRun`, provider/verifier exit, or completion of the one integration-input-manifest item already being applied with tree/index digest captured. During drain, the agent may report progress/journal/current-step completion, but only a runner/system-authenticated `ProcessObservation` plus adapter/resource reconciliation can commit `safe_boundary.reached`. No agent self-ack releases authority. No new step/process, resource acquisition, tool authority, integration item/admission, phase advancement, review, or acceptance is allowed. The boundary transaction atomically fences assignment/workspace/fenceable resources, quarantines changed integration worktree/output, increments epoch, marks the old attempt `SUPERSEDED`, and keeps the successor held until every non-fenceable resource/effect is reconciled. A deadline does not silently steal authority: if termination/release cannot be proven, the goal remains held for human wait/extend/confirm-revoke/reconcile.

An urgent stop is a separate human-privileged command, reason-required and audited. It does not masquerade as ordinary supersession.

### 10.4 Join and approval effects

- Joins pin exact attempt/artifact IDs, source authority hashes, input/result manifest digests, and adoption records.
- Removed/changed old artifacts cannot satisfy a new join.
- Changed criteria, dependencies, scope, budget, recipe, base snapshot, or applicable policy slice change `nodeAuthorityHash` and invalidate carry-forward.
- Delta approval shows precisely which nodes and approvals are new, carried, invalidated, draining, cancelled, or awaiting reconciliation.
- A crash anywhere in activation replays as the entire transition or none; there is no half-superseded graph.
- Every leased mutation validates the current goal `graphEpoch` and attempt binding version. Old graph-epoch commands are accepted only for the explicitly whitelisted drain operations above.

## 11. Budget and policy contract

Moe budgets conserved resources; it does not display estimates as if they were enforcement. Budget accounting is hierarchical from goal to node to attempt. Before **any** acceptance-bearing executor launches—including linear J1—the transaction protects mandatory verification, eligible review, final acceptance processing, and contingency reserves. Fan-out additionally protects input materialization and integration. Execution spend cannot consume proof required to finish the goal.

### 11.1 Accounts and ledger

`BudgetAccount` has an owner, optional parent, graph revision, version, and `OPEN`, `SETTLING`, `CLOSED`, `CLOSED_WITH_UNKNOWN_LIABILITY`, or `OVERDRAWN` state. Each integer-valued meter has four conserved buckets:

- `AVAILABLE`: authorized and not allocated;
- `RESERVED`: allocated to admitted work but not yet measured as used;
- `QUARANTINED`: possibly used but not completely measured or reconciled;
- `COMMITTED`: measured spend that will not be refunded.

Transfers are double-entry `BudgetLedgerEntry` records:

- child allocation moves parent `AVAILABLE` to child `AVAILABLE`;
- attempt admission moves child `AVAILABLE` to child `RESERVED`;
- exact usage moves `RESERVED` to `COMMITTED`;
- proven unused capacity returns `RESERVED` to `AVAILABLE`;
- uncertain terminal usage moves the unresolved reservation to `QUARANTINED`;
- reconciliation commits measured use and returns only proven remainder;
- closing an unstarted child returns its `AVAILABLE` allocation to the parent.

Accounts store only direct buckets; root roll-ups are derived and never duplicated as spend rows. For each root account, summing the root and every descendant exactly once gives:

```text
AVAILABLE + RESERVED + QUARANTINED + COMMITTED
  = authorized root amount + explicit recorded overrun
```

Every parent/child allocation, return, revision adoption, settlement, and refund is a balanced debit/credit in one transaction, so the subtree equation holds after every ledger event/race. Allocation moves units; it never copies them. A child closes only after returning direct `AVAILABLE` to its current parent binding and reducing direct `RESERVED`/`QUARANTINED` to zero through the settlement rules below. Actual use above a reservation creates explicit overrun liability, sets `OVERDRAWN`, and holds new work; it is not hidden by a negative balance or silently taken from a sibling.

### 11.2 v1 meters and policy limits

Universal exact/hard authority meters are:

- `attempt.count` covers each immutable `PlanningAttempt`, `ExecutionAttempt`, `IntegrationAttempt`, `EvidenceRun`, and `ReviewRound`; it moves `AVAILABLE -> COMMITTED` atomically with successful creation and is never refunded. An aborted all-or-none creation transaction creates neither record nor charge;
- `runner.authorized_ms` from durable lease intervals/deadlines and fenced expiry events;
- `verification.authorized_ms` from durable verifier authority intervals;
- resource lease allocation time from durable lease events.

`runner.authorized_ms` hard enforcement ends Moe authority and initiates process-tree cancellation at the cap. Physical `runner.active_ms`/`verification.active_ms` are observations, not universally exact: supervisor crash, reboot, or unproven termination produces a known lower bound plus quarantined/unknown interval. The workspace/resources stay held. Moe never advertises hard physical runtime unless an adapter/OS job capability proves deadline enforcement and durable clock continuity.

Provider meters, when exposed, include input, output, cache, and reasoning tokens; provider/model list-price `usd_micros`; and actual billed cost only when a billing receipt is correlated to the exact provider run. Integers are used throughout; no floating-point currency or token accounting.

Depth, width, active concurrency, scope, and privilege are non-fungible policy limits rather than spend meters. The default project template bounds each node lineage to three attempts and each attempt to two hours of runner authorized time; both are policy-raisable by an audited human decision. Provider-native turn/time/cost caps are added only when a conforming adapter proves them.

### 11.3 Measurement truth

Every `UsageMeasurement` records meter, integer quantity when known, coverage (`COMPLETE`, `PARTIAL`, `UNKNOWN`), source, provider run ID, source/parser version, sequence, raw receipt digest, and observed interval.

Rules:

- `UNKNOWN` is never converted to zero.
- `PARTIAL` is an exact lower bound; unresolved reservation remains quarantined.
- token-derived price is `LIST_PRICE`, not actual billed cost; price calculation binds an immutable pricebook revision.
- discounts, credits, taxes, subscriptions, and uncorrelated account billing remain unknown.
- a truncated/crashed provider stream is partial or unknown until reconciled.
- quotes are admission estimates and never enter committed spend.
- every budget value in the UI shows coverage and source.

### 11.4 Admission, control, and reconciliation

Before a claim, the provider adapter produces an `AdmissionQuote` bound to a current `ProviderRuntimeObservation`, with upper bounds, coverage, and enforcement capability for each requested hard meter. The actual resolved runtime closure is pinned/re-observed again at launch as Section 13 requires. A hard meter is admissible only with either:

- `NATIVE_CAP`, enforced by the provider/runner before use; or
- `INCREMENTAL_EXACT` plus cancellation before the next chargeable operation.

Terminal-only reporting is post-run accounting, not a hard cap. If project policy demands a hard token or currency ceiling and the adapter cannot enforce it, policy returns `HOLD_UNKNOWN` and the attempt does not launch. If cost is advisory because the provider cannot correlate it, a write fan-out requires a human decision that visibly acknowledges the uncertainty; the policy auto path is unavailable.

Claim, execution/downstream-proof reservations, attempt creation, attempt-count commitment, and lease issuance commit together. Usage counters accept monotonic deltas keyed by provider event ID/sequence. Retry creates a new reservation and attempt-count charge. Supersession refunds only refundable never-started or proven-unused meters; running work settles or quarantines. No child or agent can increase an envelope.

Quarantine has a closed transition set:

1. a complete correlated receipt commits exact use and refunds proven remainder;
2. proof the effect never started refunds every refundable reservation; the already committed `attempt.count` remains spent;
3. when an enforceable upper bound existed but exact use is irrecoverable, `budget.conservative_settle` commits the full reservation as `CONSERVATIVE_WRITE_OFF` and refunds nothing;
4. when no enforceable upper bound existed, conservative settlement still commits the full reservation and additionally creates persistent `UNKNOWN_EXTERNAL_LIABILITY` for possible excess. It is never represented as exact spend.

No account closes with `RESERVED` or `QUARANTINED` units. Exact settlement yields `CLOSED`; the fourth path yields `CLOSED_WITH_UNKNOWN_LIABILITY`. Continuing new work after unknown external liability is an explicit human policy decision and keeps cost truth `UNKNOWN`; it cannot enter auto-approval or a comparative cost claim.

`SupersessionFundingReservation` has one generated lifecycle: `HELD -> CONSUMED | RELEASED | INVALIDATED | EXPIRED`, all terminal. Its sibling `PreparedPlanningFence` has `ACTIVE -> CONSUMED | RELEASED | INVALIDATED | EXPIRED`, also all terminal, with the same preparation generation and terminal cause; neither may exist current without the other and stored `SupersessionPlan`. At most one current generation exists per goal total and names exactly one target revision; `graph.prepare_supersession` obeys the generation idempotency rule above. Exact `graph.supersede` activation consumes both into activation dispositions. `graph.release_preparation`, proposal rejection, expansion decline, or planning/goal cancellation releases/refunds both; a replacement prepare or `SUPERSESSION_CONSEQUENCE_CHANGED` invalidates/refunds/releases them before another can be created; the audited deadline expires them transactionally and invalidates any bound approval. Every terminal planning/revision path enumerates both IDs and performs cleanup atomically. Entry into `CLOSING` refuses while a preparation generation is current rather than silently abandoning it. Crash/replay returns the same transition, and no completed/closed goal may retain either record.

On `CARRY`, activation atomically closes the old `BudgetAuthorityBinding` and opens one new binding to the same reservation/account lineage; no units move or duplicate. `CHANGE`/`REMOVE` settle or quarantine old reservations before new allocations. Subtree conservation is checked across revision boundaries and after replay.

### 11.5 Provider adapter metering contract

Core never branches on provider name. Each version-pinned adapter implements capability probe, quote, launch, normalized event stream, inspect/reconcile, cancel, resume, and doctor operations. Capabilities declare:

- terminal-only versus incremental usage and completeness semantics;
- native caps and cancel-on-reading support;
- stable run identity and resume support;
- project/effect tagging plus complete run enumeration/negative-proof coverage for disaster recovery;
- structured output/parser schema version;
- exact tokenizer availability;
- process-tree termination and recovery support;
- runtime-closure observation and immutable pin/copy/open-handle support;
- error/rate-limit taxonomy.

Adapters preserve raw structured provider output by digest and reject unknown schema versions as `UNKNOWN`. They detect gaps, duplicate/out-of-order events, counter regression, truncation, malformed records, and resume discontinuity. Golden adapter tests cover complete, cancelled, crashed, duplicated, reordered, malformed, truncated, resumed, and version-mismatched streams.

The currently installed CLIs demonstrate why this is capability-based: Claude exposes structured output and a native maximum-dollar option; Codex exposes JSONL events; Gemini exposes JSON/stream-JSON statistics. Exact fields and semantics remain version-pinned adapter facts, not assumptions baked into core.

### 11.6 Policy evaluation and risk tiers

A policy evaluation returns exactly one of:

- `ALLOW`
- `DENY`
- `REQUIRE_HUMAN_APPROVAL`
- `HOLD_UNKNOWN`

It records the immutable `PolicyRevision` and evaluator version, action, actor, graph/node revision, daemon-derived `RiskAssessment`, exact input fact IDs/truth classes, matched rules, obligations, reason codes, and decision. A caller may send `riskHint`, but core computes the maximum applicable tier from normalized immutable facts and cannot lower it. Missing/unclassifiable facts yield `HOLD_UNKNOWN`. The assessment/rule/fact digest is part of the decision hash.

Composition is fail-closed: `DENY` dominates; required missing evidence yields `HOLD_UNKNOWN`; `REQUIRE_HUMAN_APPROVAL` dominates `ALLOW`; children may tighten but never relax parent policy. A relaxation is a scoped, expiring, human-approved waiver over a named **soft** obligation only.

Auto-approval produces a real `ApprovalDecision` attributed to a daemon-issued `SYSTEM_POLICY` principal `policy:<hash>` with its inputs and reasons. Its truth class is `DAEMON_VERIFIED`, never `HUMAN_APPROVED`; the UI may separately show a `POLICY` actor badge. It is not absence of a decision.

Initial risk classes are:

- `R0`: read-only, snapshot-bound, no external side effect;
- `R1`: isolated writes inside already-approved disjoint scope, complete machine oracle, complete hard-budget coverage, no sensitive credential or network expansion;
- `R2`: new plan/graph scope, external side effect, uncertain metering, integration contract change, or acceptance with material repository impact;
- `R3`: force revocation, policy relaxation, disaster-recovery completion, migration/cutover, protected-branch delivery, non-loopback exposure, or destructive/privileged action.

Manual approval is default for plans, expansions, and acceptance. Project owners MAY opt specific `R0`/`R1` action types into policy approval. `R2` and `R3` are human-only in v1; `R3` is always reason-required with step-up authentication. Auto-acceptance additionally requires all proof and reviewer-eligibility gates. There is no project-wide “approve everything” mode.

The non-waivable safety kernel is authentication/capability, command idempotency/versioning, current lease/graph/binding fencing, DAG/dependency/scope containment, budget conservation/truth, exact artifact/receipt provenance, `ALL_REQUIRED` cardinality, applicable independent-review eligibility, audit atomicity, restore fencing, and the rule that failed/unknown proof cannot become `ACCEPTED`. A waiver cannot weaken `CORE-I1`…`CORE-I22`, turn `UNKNOWN` into verified, include foreign bytes, or accept an ineligible review. Changing criteria or budget requires a new exact revision/allocation; it is not a post-hoc proof waiver.

## 12. Identity, sessions, leases, and presence

### 12.1 Identity

Principals are daemon-issued human, system, or agent identities. Sessions use short-lived credentials bound to principal, profile revision, client type, allowed transports/capabilities, and an OS-local client proof-of-possession key. Caller-selected worker IDs and missing-identity fallback do not exist. A valid stolen bearer value without the client-key signature cannot authorize a command; human approvals and every `R3` action additionally require recent step-up authentication. Credential theft from a malicious same-user host process remains inside the explicit host-threat limitation.

Every authoritative mutation envelope contains:

```text
commandId
requestDigest
session credential
target aggregate and expectedVersion
lease token + epoch + authorityHash when leased
goal graphEpoch + attemptBindingVersion when leased
graph/policy revision references
payload
```

Leased execution commands use the graph-epoch/attempt binding above. Pre-activation planning instead uses a capability-restricted `ProposalLease` bound to `proposalBaseGraphHash|null`, goal expected version, observed graph epoch (zero is legal before first activation), planning-run epoch, and planning budget. It authorizes only context/read, journal/handoff, dependency challenge, and immutable plan/graph proposal; it cannot create a worktree mutation, execution/resource/evidence effect, or acceptance. First-plan and replan paths therefore use the same fenced proposal authority without pretending an active graph exists.

For every authenticated, parsed command—accepted or rejected—the applying transaction writes an idempotency-decision row keyed by project, principal, and `commandId`, with request digest and terminal result/security-event reference. Tombstones live for the project lifetime. The same ID/request returns the original domain result even when state advanced; it is marked historical and omits current `nextAllowedCommands`, forcing a fresh affordance query. Reusing the ID with different bytes returns `IDEMPOTENCY_CONFLICT` and commits no business effect.

`presence.ping` uses a smaller authenticated telemetry envelope with session, ping ID, and client observation only. It has no target aggregate version or lease authority and is not a domain mutation.

### 12.2 Lease state and fencing

Assignment and workspace leases have one canonical row and monotonically increasing epoch:

```text
ACTIVE -> SUSPECT -> ACTIVE
ACTIVE | SUSPECT -> DRAINING -> RELEASED | REVOKED
ACTIVE | SUSPECT | DRAINING -> REVOKED   (privileged removal/urgent revoke)
```

Every authoritative mutation checks token, epoch, authority hash, session, capability, version, and lease state in the applying transaction. A successor or revocation increments epoch. Stale commands have zero domain/outbox effect except an atomic, redacted rejection-security event for authenticated, syntactically valid attempts.

An `ACTIVE` lease must be renewed by a fenced `lease.renew` transaction. It stores server wall deadline, boot ID, and monotonic observation. Defaults are a 90-second renewal window and renewal at one third of the window. A timer has no authority by itself: on due observation it submits transactional `lease.mark_suspect`; replay projects only that durable event. Restart records a new clock/boot observation, reconstructs due timers, and commits overdue suspect events before scheduling. Missing the window marks `SUSPECT`; mutating commands pause, but ownership is not reassigned. The human can wait, extend/renew, or confirm revocation with a reason. Reassignment is possible only after the old epoch is fenced and non-fenceable resources are reconciled.

External resources receive fencing epochs when their adapter can reject stale use. An adapter that cannot fence stays unavailable after uncertain loss until a human proves release; Moe chooses safety over invented liveness.

Resource acquisition never holds a partial set while waiting. Before executor claim, one transaction either reserves capacity units for **all** declared non-provider resources in canonical resource-ID order or reserves none and creates a durable `ResourceWaitRequest`. Queue selection uses Section 8.4's deterministic effective priority, eight-dispatch aging quantum, continuously-eligible interval, stable event sequence, and request ID; a priority change is a separate audited decision. Cancellation/restart preserves eligibility history. A blocked head for one resource cannot block unrelated resource IDs. When capacity is available, rows move to `PENDING_ACQUIRE` with epochs and idempotent effect intents. Each external adapter must confirm the epoch before its resource becomes `ACTIVE`; if any acquisition fails/unknown, confirmed acquisitions are fenced/released and the whole set is held. Only after all are `ACTIVE` may scheduler claim atomically reserve a provider slot and create the provider-launch intent. Release uncertainty is quarantined, and a successor cannot receive capacity until fenceability/reconciliation proves it safe.

### 12.3 Presence is separate

`presence.ping` is authenticated, server-timestamped, idempotent, coalesced operational telemetry. The default client cadence is 10 seconds and daemon batch window is at most one second. An accepted ping updates `lastSeen=max(serverReceivedAt)`; dropped pings promise nothing, and convergence assumes eventual delivery of a later ping. Presence may update only a non-authoritative projection. It MUST NOT renew a lease, change epoch/version/readiness/phase, or make a stale action valid.

The runner sidecar rotates its short-lived session credential before expiry using proof of possession, then sends fenced lease renewal, then presence. Rotation preserves principal/lease/epoch and revokes the old credential. Expiry/rotation/renew races are contract-tested. A long test therefore remains owned without pretending model/tool chatter is liveness.

### 12.4 Release, handoff, and resume

`work.release` validates current authority and stores a bounded truth-classed handoff/checkpoint (completed steps, active process/resource facts, exact input/worktree/context/journal/artifact digests, next safe action). At a runner-proven between-step boundary with every effect/resource proven terminal it atomically finishes the attempt/lease as `RELEASED`; otherwise it commits `DRAINING` plus cancellation/reconciliation intents and reports `releasePending=true`, never “released.” A later stronger drain reason marks the tentative handoff non-resumable before the safe-boundary transaction chooses its terminal target. Only an unchanged strongest `WORK_RELEASE_OR_PAUSE` result makes the run resumable/unowned. If handoff cannot commit, authority remains or becomes `SUSPECT`. A successor claim receives the exact eligible handoff and creates a new attempt/binding; it cannot overlap an old effect/resource. Already-unassigned and terminal releases are idempotent no-ops and can never resurrect terminal work.

## 13. Runner, workspaces, providers, and evidence

### 13.1 Durable external-effect protocol

An outbox/inbox row alone cannot make an OS, Git, provider, adapter, or notification effect exactly once. Every authoritative v1 effect uses a stable `EffectIntent` bound to aggregate, expected graph epoch/lease/input binding, predecessor cursor, desired state, environment/runtime observation where applicable, and effect-specific idempotency key:

```text
PENDING -> CLAIMED -> ARMED -> ACTIVE -> SUCCEEDED | FAILED | UNKNOWN
PENDING | CLAIMED | ARMED -> CANCEL_REQUESTED -> CANCELLED | UNKNOWN
ACTIVE -> CANCEL_REQUESTED -> CANCELLED | UNKNOWN
```

A terminal `EffectTombstone` dominates a **pre-activation** intent. Consumers process causal predecessors per aggregate, then an inert runner wrapper/materializer acquires the effect-specific exclusive lock and prepares without provider/tool/Git/write action. It calls `effect.activate`; that short transaction revalidates intent, graph/lease/binding, desired state, dependency witnesses, resource/runtime observations, and lock identity. For a provider launch it atomically moves effect `ARMED -> ACTIVE` **and owning attempt `LAUNCH_REQUESTED -> RUNNING`**, then returns a one-use activation grant bound to that wrapper. This is the logical start-versus-cancel and not-running-versus-running linearization point, not a claim that a database commit and OS spawn are physically atomic. If cancel/tombstone commits first, activation rejects and the wrapper performs no external action. If activation commits first, any later cancel must treat both effect and attempt as active and drain/reconcile them—even if the physical spawn/write is observed just after the cancel commit. Poison/gap state holds causal dependents; unrelated aggregates continue.

The provider-launch attempt/effect cross-product is generated from this closed table; no reducer invents a missing edge:

| Attempt | Effect | Invalidated/cancelled disposition |
|---|---|---|
| no attempt | pre-materialization intent | tombstone intent; no authority created |
| `LEASED|LAUNCH_REQUESTED`, all resources proven absent/released | `PENDING|CLAIMED|ARMED` | atomically cancel/tombstone effect, fence/release leases/provider slot, settle budget, and terminalize by strongest typed reason; `RELEASED` also requires an exact safe handoff |
| `LEASED|LAUNCH_REQUESTED`, any resource active/unknown | `PENDING|CLAIMED|ARMED` | tombstone provider effect and release provider slot, but enter attempt `DRAINING`; retain resource capacity/`NodeRun` hold until adapter reconciliation, then use strongest disposition |
| `LAUNCH_REQUESTED` | activation command | atomically become attempt `RUNNING` plus effect `ACTIVE`, or neither |
| `RUNNING|DRAINING` | `ACTIVE|CANCEL_REQUESTED|UNKNOWN` | enter/remain `DRAINING`; every later reason monotonically upgrades disposition; runner/adapter proof reconciles effect/resources before `CHECKPOINTED -> SUCCEEDED|RELEASED|SUPERSEDED|CANCELLED` from the strongest current reason |
| terminal attempt | any nonterminal/unknown effect | no resurrection; late system observation may only reconcile/quarantine the effect and budget |

An effect for which Moe cannot place this cooperative gate before the first external action is not eligible for authoritative automatic execution in v1. Any suspected raced physical action is `UNKNOWN`, fenced/quarantined, and never adopted as current merely because its process exists.

After an effect, a stable result is adopted by intent ID. A crash between effect and receipt is safe only when the downstream system is idempotent or the effect has an exclusive lock/result that can be discovered. Otherwise state becomes `UNKNOWN` and requires reconciliation; Moe never chooses between silent loss and duplicate execution while claiming exactly once.

Effect-specific protocols are:

- **Provider launch:** the adapter defines its complete runtime closure. Before `effect.activate`, the wrapper resolves it, compares path/digest/version/capability/schema to the quote-bound `ProviderRuntimeObservation`, and pins it through a content-addressed private copy or platform-proven immutable handle. A mismatch is `PROVIDER_CAPABILITY_CHANGED`/`HOLD_UNKNOWN`; unsupported runtime pinning cannot launch authoritatively. The child inherits the OS-exclusive launch lock (or an OS job proves death) and registers with a one-time bootstrap credential. Duplicate delivery adopts the registered process or exits before provider launch. An uncertain `ARMED`/lock state becomes `SUSPECT` and is never auto-relaunched.
- **Node input materialization:** stable graph/base/ordered-predecessor-closure ID, exclusive scratch-worktree lock, exact intermediate/result trees, and result adoption. Sealing revalidates every producer/adoption; stale input quarantines the scratch tree and triggers no worker claim.
- **Verification:** stable recipe/input ID, exclusive clean-candidate worktree lock, content-addressed output, and result adoption. If completion cannot be proven, do not rerun automatically when the recipe may have side effects; reconcile first.
- **Integration/Git materialization:** stable input-manifest/attempt ID, exclusive integration worktree/target lock, exact resulting tree, and result adoption; stale/tombstoned intent cannot write the candidate branch.
- **External resource:** adapter receives intent ID and fencing epoch; adapter confirmation/result is idempotent or becomes `UNKNOWN` and blocks reuse.
- **Notification:** delivery is at-least-once with a stable notification ID and deduplicating UI/presentation. Moe does not claim physical exactly-once delivery for a non-idempotent third party.

These protocols are contract-tested at every instruction boundary on Windows, Linux, and macOS, including daemon/runner crash, PID reuse, out-of-order cancel/start, effect-before-receipt, and adoption failure.

### 13.2 Workspace rules

- Every mutating attempt receives its own worktree at the exact `NodeInputManifest.inputTreeDigest`, materialized from its base SHA and accepted predecessor closure.
- Canonical scope resolution is captured outside transactions as a hashed observation over the exact base/worktree, bound during claim, and re-observed before provider start, candidate verification, and integration. Case folding, symlinks/junctions, submodules, device/UNC/absolute paths, and repository escapes are fail-closed.
- Provider environments contain only scoped credentials and an allowlisted environment; secret values never enter receipts or context. An `ExecutionEnvironmentManifest` declares toolchain/runtime digests, network policy, caches, external services, registry/user-level inputs, and isolation/hermeticity capabilities.
- Git attribution uses explicit changed paths, before/after trees, and dirty/staged/untracked manifests.
- Agents do not stage broadly, push, merge, or mutate a protected/shared checkout through Moe.
- Workspace isolation is for cooperative agents and attribution. It is not a host security sandbox.
- A detected or suspected direct host effect outside the worktree is `OUT_OF_SCOPE_HOST_EFFECT_UNKNOWN`; Moe fences further authority and exposes containment/reconciliation, but cannot undo or claim prevention without a host sandbox.

Every mutating candidate—including linear J1—is sealed as a `NodeResultManifest` and rematerialized in a **fresh clean candidate worktree** from its exact input tree plus only admitted authored paths. Required verification and review run against that tree. Undeclared candidate/worktree bytes that Moe can enumerate—dirty, staged, untracked, symlinked, or escaped—reject before `WORK_REVIEW`; a receipt that merely records foreign bytes cannot qualify them. Moe does not claim universal detection of global caches, daemons, network responses, registry/tool config, or user-level files. Recipes must declare such inputs and hermeticity capability. An undeclared or unobservable external input lowers coverage to `OBSERVED` or `UNKNOWN`; policy may require a hermetic adapter for high risk. Fan-in applies the same honest rule to each child and integrated result.

### 13.3 Verification receipts

Moe runs an approved, immutable `EvidenceRecipeRevision`. The runner records:

- exact argv array without shell re-parsing;
- cwd, node input/result manifest digests, and allowlisted `ExecutionEnvironmentManifest` fingerprint/coverage;
- provider runtime observation, toolchain, and OS versions/digests;
- start/end monotonic and wall times;
- exit/termination status;
- stdout/stderr and artifact digests with bounded inspectable tails;
- exact base/head commits and before/after/dirty tree digests;
- context, plan, graph, policy, recipe, session, lease, and epoch references.

The canonical receipt is content-hashed and signed by a local Moe evidence key whose key ID/rotation is event-recorded. Artifact bytes live in content-addressed storage, not inline in events. A node cannot enter `WORK_REVIEW` without the current receipts applicable to its `AcceptanceContract`, and cannot become `ACCEPTED` without every proof/review/approval obligation applicable to that node kind. Leaf acceptance does not require the downstream composite integration; integration/completion acceptance does.

Every daemon, control-room asset bundle, MCP bridge, IDE adapter, and provider adapter embeds a signed `DistributionManifest` with source SHA, contract-schema hash, API compatibility range, build/tool versions, and asset digest. Startup handshake refuses incompatible/stale installed artifacts with `DISTRIBUTION_MISMATCH`. Packaging tests rebuild and byte-compare embedded manifests so a fixed source tree cannot silently run an old plugin snapshot.

## 14. Attempt journal and deterministic context

### 14.1 Journal record

An immutable `AttemptJournalEntry` captures one bounded learning:

```text
attempt/node/revision/sequence
kind and stable failureCode
criterion IDs and normalized scope keys
hypothesis or action
observed outcome and why it failed
condition that must change before retry
typed retry predicate over durable fact IDs
evidence references and truth class
base SHA and environment digest
fingerprint, actor, timestamp
active/superseded/contradicted relation
```

Kinds include rejected hypothesis, failed approach, verification failure, tooling failure, environment blocker, invalidated assumption, and partial result. Agent explanations are `AGENT_REPORTED`; daemon-observed failures attach observed facts without inventing a reason.

Bounds are 4 KiB canonical UTF-8 per entry, 24 agent entries per attempt, eight evidence refs and 16 scope keys per entry. Exact duplicate fingerprints collapse only in the active projection into first/last/count; original events remain. Quota exhaustion returns `JOURNAL_LIMIT_REACHED`. Daemon process/verification failures are always retained as bounded domain events; their journal projection has a separate bound and reports an explicit omitted count/digest rather than promising unbounded journal storage.

Fingerprint is a canonical hash of kind, failure code, criteria, primary scope, recipe digest, and compatible base/environment. Prose explaining “what must change” is advisory. An authoritative retry condition is a typed predicate (`factId`, operator, expected version/value/digest) evaluated by the daemon against durable facts. Rewording cannot unlock it. Repeating an active fingerprint without that predicate becoming true creates a policy hold. Correlated sibling fingerprints feed the same-bug breaker.

### 14.2 Context selection

Mandatory context is never truncated: goal/node objective, criteria, constraints/policy revision, graph hash and signed manifest identity, approved plan, the node's exact authority/direct-hard-dependency/input-artifact closure, input tree/lease/epoch/workspace/scope, budget balances/coverage, and legal next commands. The complete project graph remains queryable by cursor/artifact and is not dumped into every provider context; a 10,000-node project therefore does not make a leaf inherently impossible. A planner receives the affected subgraph plus structural summaries and may page exact regions under the same snapshot. Before admission, the adapter declares an exact token limit or conservative total input-byte limit including envelope/reserved output. If neither is trustworthy, policy returns `HOLD_UNKNOWN`; if mandatory closure bytes do not fit, the node is held `CONTEXT_TOO_LARGE`.

Additional selection is deterministic, not vector-based:

1. filter by exact node, ancestor, direct hard dependency, declared artifact/interface key, path scope, criterion, failure code, or policy rule;
2. reject base/revision/environment-incompatible records unless explicitly cross-version;
3. rank unresolved before resolved, then severity, relationship distance, recency, and ID;
4. apply per-section byte limits and record every exclusion reason;
5. render canonical content and persist included IDs, exclusions/reasons, selector/renderer versions, provider-adapter envelope version, exact canonical rendered bytes, bytes, exact token count when available, and omitted counts;
6. compute `contextDigest` over the exact delivered bytes plus the complete manifest/version tuple, and a separate adapter-observed `providerInputDigest` over the final bytes submitted;
7. bind `step.start` to both digests.

Automatic context includes at most eight journal entries and 12 KiB of journal text. Full history remains queryable by ID. Provider-specific exact tokenization is a capability; otherwise Moe enforces the adapter's conservative total-byte bound and labels token count `UNKNOWN`. `context.repackage` may alter optional selection only; mandatory overflow requires a narrower approved graph/plan or a provider with a proven larger limit and creates a new context digest.

Role packages differ:

- planner: prior plan deltas, decisions, findings, and active ancestor/node dead ends;
- executor: current steps, direct dependency contracts/artifacts, latest handoff, compatible dead ends, and prior findings;
- integrator: child manifests/diffs, interface decisions, child dead ends, and integration findings;
- reviewer: the clean package in Section 15 only; no worker transcript, self-assessment, handoff persuasion, or dead-end journal.

## 15. Independent review and calibration

### 15.1 Independence

Review records principal, provider account, profile revision, model family, rubric/prompt revision, session, and all mutating/integration leases held over the artifacts. Default final review requires:

- a principal outside the complete authorship set: goal criteria, graph and plan authors; every builder/integrator; and anyone who materially edited reviewed contracts or bytes;
- a different principal/session/profile from every builder and integrator, and integrator independence from every child producer;
- a dedicated reviewer profile revision;
- no prior mutating lease over reviewed artifacts;
- a daemon-generated clean review package with exact digest;
- current calibration eligibility.

The default level is named honestly `ROLE_SEPARATED_CLEAN_CONTEXT`; it does not claim statistical/model independence merely from fresh UUIDs. Moe records provider account, controller/credential issuance lineage, model family/build identity, profile, and session as separate axes and displays them. `R2`/`R3` policy may require controller/model-family/provider difference or a human. If no eligible reviewer exists, review is `UNKNOWN_REVIEWER_INDEPENDENCE`; Moe never falls back to an author. If a reviewer edits the work, the reviewer joins the authorship set, its approval is invalidated, and a fresh reviewer is required.

### 15.2 Clean review package and outcomes

The package contains criteria/constraints, exact graph and plan hashes, integrated diff/tree, daemon receipts/artifacts, prior structured review findings, and rubric. It excludes worker transcripts, self-assessments, and journals. `reviewInputDigest` hashes the exact canonical rendered bytes, inclusion/exclusion manifest, renderer/rubric/adapter-envelope versions, and artifact digests; the adapter also records final submitted-byte digest. Additional requested evidence changes both package and reviewer binding.

Outcomes are `ACCEPT`, `REJECT_IMPLEMENTATION`, `REJECT_PLAN`, `UNKNOWN_EVIDENCE`, or `ESCALATE`. Each finding names criterion where applicable, severity/category, location, evidence, observed versus expected, and required change.

Implementation rejection follows `WORK_REVIEW -> EXECUTION_READY` and creates a new attempt. Plan/requirements/dependency rejection leaves the old run held in `WORK_REVIEW`, creates a successor draft `PlanningRun`, and requires exact plan/graph approval plus supersession before new execution authority exists; old attempts remain readable. The same finding fingerprint twice escalates to re-plan. Three unsuccessful rounds create a `REVIEW_ESCALATION` blocker and human choices: re-plan, select another eligible reviewer, authorize one more bounded funded round, or cancel. No choice waives the safety kernel, and reaching the cap never auto-accepts.

### 15.3 Calibration

Phase 1 creates a hidden-label, versioned corpus covering missing behavior, subtle regression, concurrency, security/data-loss, stale SHA/receipt, zero-work false green, platform mismatch, scope/policy breach, honest missing-evidence `UNKNOWN`, and known-clean controls.

Each profile/model/prompt/rubric/adapter/tool/context-envelope revision reports severity-weighted recall, precision, false-positive rate, critical misses, correct disposition, provenance-defect catches, honest-unknown rate, latency, and cost. The provider-returned immutable model/build ID is captured when available. A mutable alias without such identity has `MODEL_IDENTITY_PARTIAL`, requires calibration at least every seven days and again on release-evidence day, and cannot support a strong cross-time comparison. Any resolved component change makes calibration stale immediately.

Before a profile can gate production review, it MUST pass a balanced sentinel set: every critical stale-authority, false-proof, data-loss, and malicious-scope case is caught at the correct minimum severity/disposition; every deliberately missing-evidence case returns `UNKNOWN` or escalation; and every designated known-clean control is correctly `ACCEPT` with no fabricated critical/major finding. This blocks an always-reject reviewer. It is a minimum contract sanity gate, not a broad real-world catch-rate claim. Broader numeric quality thresholds are set only after a powered baseline; until then complete stratified results, false positives, and human overturns are reported. Auto-acceptance is unavailable to a stale, partial-identity, or ineligible reviewer.

## 16. Persistence, outbox, recovery, and exports

### 16.1 Transactional state

Every authenticated parsed authoritative command transaction records its terminal decision; an accepted business command additionally:

1. validates authentication, authority, idempotency, versions, immutable inputs, and policy;
2. changes normalized authoritative records;
3. appends ordered versioned domain event(s);
4. updates projections;
5. appends outbox record(s);
6. stores the canonical result for command replay;
7. commits once before acknowledgement.

Events contain event/aggregate IDs and sequence, schema/canonicalizer versions, command/request digest, actor/session, correlation/causation, lease/epoch, graph/policy hashes, timestamp, and payload. Lifecycle, graph, lease, approval, evidence, integration, budget, and readiness-affecting policy are event-ledgered. Plain config may not influence readiness.

Event schema evolution and upcasters ship in v1. Unknown future versions fail closed/read-only. Artifacts and large output are digest references. Files are written to a temporary content-addressed staging area, flushed/renamed, and verified before the database references them. Garbage collection is reachability/refcount based across live state, retained event/export generations, and complete backups; an uncertain reference prevents deletion.

Late runner/adapter `ProcessObservation`, usage, cancellation, and reconciliation facts use an authenticated `SYSTEM_RUNNER` path bound to the stable effect intent, not the superseded agent lease. They may settle evidence/budget/recovery state but cannot advance the old node, qualify its output, or bypass current graph fencing.

### 16.2 Outbox and consumers

Event, projection, and outbox rows are atomic. Relay is at-least-once. Inbox receipts deduplicate delivery; Section 13.1's effect state machine, causal predecessor enforcement/current-desired-state check, tombstones, locks/downstream idempotency, and adoption/reconciliation provide effect safety. Launch, verification, integration, and external-resource gates must use those effect-specific protocols. Notifications are only at-least-once with presentation deduplication.

Poison events are quarantined with aggregate/cursor visibility and do not silently skip ordered work. Their causal dependents stay held; unrelated aggregates continue. Unknown consumer state yields `NEEDS_RECONCILIATION`. Authenticated stale-command rejection requires durable audit capacity; if storage is unavailable, no terminal command response is acknowledged and the mutation fails closed. The 100%-timeline gate applies only to committed rejection decisions. Unauthenticated/malformed floods are rate-limited security metrics, not unbounded domain events.

### 16.3 SQLite operation

- sole daemon process during operation;
- one prioritized short-transaction writer; no network/provider/Git/process I/O inside a database transaction;
- read snapshots for queries;
- fenced lease renewal remains transactional;
- non-authoritative presence is coalesced separately so it cannot starve commands;
- startup engine-version, integrity, schema, key, artifact, outbox, and projection checks;
- transactional migration with pre-migration backup and version bump only on commit;
- WAL/checkpoint/backup behavior covered by injected crash, lock, disk-full, corruption, and restore tests.

### 16.4 Recovery truth

With the authoritative database/WAL intact, process restart produces either the whole committed command or none and loses no acknowledged database event. Healthy surviving processes are adopted only when effect lock, activation grant, session, lease epoch, input/workspace, runtime observation, and current desired state reconcile. Otherwise records become `SUSPECT` or `NEEDS_RECONCILIATION` with stable recovery commands. Resume creates a continuation/new attempt as required; history is never edited.

`doctor` reports `HEALTHY`, `DEGRADED`, or `UNKNOWN_TRUTH`; each check has stable check ID, severity, truth class, affected record/effect IDs, evidence, and exact allowed recovery commands. A corrupt record is quarantined, not skipped. Projection rebuild must equal live canonical projections; mismatch blocks mutating startup.

Every event has a global monotonic cursor in addition to aggregate sequence. A subscriber resumes strictly after its acknowledged cursor. If the cursor is absent, pruned, corrupt, or belongs to a different projection generation, the server returns `CURSOR_GAP` with last-good cursor and a signed snapshot digest; it never jumps silently. The control room shows a restart/gap marker, applies one verified snapshot, and resumes from its cursor. Valid committed rejected commands are queryable through the same event API with node/actor/type filters.

### 16.5 Scheduled hashes, backups, and disaster restore

Operational state lives under OS application data keyed by repository project ID. A live DB is never committed. Default-on exports create content-hashed JSONL plus canonical manifest/signature:

- before and after every schema migration;
- after a graph activation, force revocation, node/goal acceptance, or cutover decision;
- hourly while the committed event sequence changed;
- at clean daemon shutdown.

Exports correspond to one committed sequence, are explicitly non-authoritative, and default to a human-readable OS-data export directory. `moe export --to <path>` copies a verified generation on request; Moe never stages it. Retention policy is versioned and preserves migration/cutover generations.

A restorable `BackupGeneration` is stronger than an export: it binds one committed cursor/RPO, database pages/event ledger, every reachable content-addressed artifact/receipt/context/manifest, and the public-key/key-rotation verification chain. Its manifest lists every object/digest/size and is complete only after all bytes verify. The UI and release evidence state that acknowledged events **after that cursor are outside the backup RPO**; a disaster restore does not claim they survived. Missing proof bytes yield `UNKNOWN_TRUTH`; backup/GC tests prove referenced objects cannot be collected and restore never mixes generations.

Restoring after media loss is not ordinary restart. It never derives fencing identity by incrementing restored state. Before installing bytes, the restore controller creates a 256-bit CSPRNG `RecoveryIncarnation` nonce and fresh session/grant signing-key epoch, binds both to the backup-generation digest and restore command ID, and flushes them as `PREPARED` in an OS-protected two-slot `RecoveryAnchor` excluded from the restored payload. It installs the verified backup into the inactive database slot; one SQLite transaction injects that nonce/key epoch, revokes every restored credential/grant, and sets the project `QUIESCED/RECOVERY_REQUIRED`; after database/artifact fsync and verification, one atomic slot switch makes it current and the anchor becomes `INSTALLED`. A crash before the switch exposes no restored authority and resumes the same command/nonce or discards the inactive slot; a new restore command, including a second restore of the same generation, must create a new nonce and key epoch. After total loss of both slots/anchor, startup requires a passing entropy/key-generation check and creates a fresh identity before reading restored authority; entropy/key uncertainty holds recovery. Thus first-restore grants cannot validate after a same-generation second restore.

The `RecoveryAnchor` is bootstrap install metadata, not a second business-state authority: it can only select a fully verified quiesced database slot and bind its nonce/key epoch. The selected database remains the sole source of lifecycle/readiness truth; any anchor/database mismatch refuses mutating startup and exposes only restore inspection/discard/resume for the exact install command.

Before any new effect or lease, Moe inventories project-tagged workspaces, effect locks/wrapper registrations, provider runs, resources, branches/refs, integration targets, and artifact staging that may exist beyond the backup cursor. Each configured effect class must supply a complete enumeration/negative-proof capability over the recovery window, not merely “whatever was found.” Each item is proven absent, cancelled, adopted only to a matching restored intent under the new incarnation, or quarantined as an orphan. If an adapter cannot prove complete inventory or a non-fenceable state is unknown, recovery cannot complete and affected effects remain unavailable; human optimism is not a proof waiver. A post-backup effect with no restored intent can never be invented into current history or automatically repeated. `recovery.complete` is an `R3` decision bound to the incarnation nonce/key epoch, complete inventory/reconciliation digest, and coverage proofs; only then may normal scheduling resume. Disaster tests exercise effects before/after the cursor, repeated same-generation restore, crash at every two-slot install/fsync/switch boundary, stale grants from each incarnation, and every declared inventory blind spot.

## 17. Protocol and stable errors

One source schema generates TypeScript types, JSON Schema, HTTP/MCP bindings, UI clients, fixtures, and documentation. MCP uses official stdio for local spawned clients and standard Streamable HTTP for long-lived clients. The control room uses authenticated HTTP commands/queries plus a resumable cursor stream. No custom MCP-over-WebSocket dialect exists.

The v1 surface is compact by domain, but includes bootstrap and every promised recovery path:

- `project.register|bind_repository|activate|get`, `provider.probe`, `profile.register`, `policy.install|validate`
- `session.open|rotate|renew|close`, `presence.ping`
- `goal.create|get|list|pause|resume|close|cancel|reopen_as_revision`
- `graph.get|preview|request_expansion|prepare_supersession|release_preparation|approve|supersede`, `expansion.decline`
- `planning.claim|release|recover_absent|cancel`, compound `plan.propose(kind=INITIAL|REVISION|EXPANSION)`, `replan.propose_unblock`
- `dependency.explain|challenge`, `frontier.get`, `scheduler.readiness_explain`
- `work.claim|renew|release|resume|get_context|cancel`
- `approval.decide`, `finding.route`
- `step.start|finish|checkpoint`, `journal.append`, `context.repackage`
- `blocker.open|challenge|resolve`, `wait.declare|extend|cancel`, `escalation.decide`
- `lease.mark_suspect|extend|confirm_revoke`
- `resource.request|renew|release|reconcile|confirm_released`
- `budget.get|reconcile|conservative_settle|acknowledge_unknown_liability|propose_raise`
- `evidence.run|get|rerun`, `qualification.recover|retry|replan|cancel`
- `integration.accept_output|start|resolve_finding|submit_finding|seal`
- `review.start|release|submit`
- `effect.observe|activate|adopt_result|confirm_absent|reconcile`, `safe_boundary.observe`
- `quarantine.get|export_forensic|discard`, `reconciliation.get|decide`
- `cutover.preview|quiesce|abort|activate`, `recovery.inspect_external|reconcile_external|complete`
- `events.read|wait`, `doctor.get`, `export.run`

`graph.approve` handles initial/replacement graph and expansion/supersession exact-hash decisions; replacement approval requires the exact stored `graph.prepare_supersession` identity, while `graph.supersede` is its separate activation command. After successful replacement/expansion proposal finalization, a daemon-owned prepare commits **before** the approval action becomes enabled; the inbox displays that exact stored hash, disposition, funding reservation, planning-fence membership/deadline, release action, and consequence payload. The one human click may then combine embedded plan/graph decisions with activation, preserving J1/J2's one approval action without approving an identity created after the click. Initial activation has no old graph and needs no supersession preparation. `approval.decide` is a typed union for standalone plan review/rejection, final acceptance, revocation confirmation, soft-policy waiver, reconciliation, escalation, `CUTOVER_QUIESCE`, and `CUTOVER_ACTIVATE`; each kind has distinct schema/capability/preconditions. Bootstrap `project.activate` is not cutover activation. The UI never routes by a free-form string.

For a proposal-capable `PlanningRun`, generated `nextAllowedCommands` exposes exactly one mutating submit action, `plan.propose(kind=<run kind>)`. `graph.preview` is an optional read-only query and never appears as a submit/refuse action; HTTP, MCP, UI, and IDE use the same generated command ID/schema, so calling two surfaces cannot create duplicate or partial plan/graph content.

### 17.1 Bootstrap journey

On a fresh install, an OS-local owner bootstrap credential performs:

1. `project.register` creates `BOOTSTRAPPING` with stable project ID and owner;
2. `project.bind_repository` records a fresh repository/base/scope observation without modifying it;
3. `provider.probe` creates a `ProviderRuntimeObservation`, proves how its executable/package runtime closure will be pinned, and pins adapter/CLI capabilities; `profile.register` creates planner/worker/integrator/reviewer profiles;
4. `policy.install|validate` loads an immutable default-manual policy, finite goal budget defaults, and safety kernel;
5. `project.activate` verifies store/driver, provider minimum profile, credentials, policy, signing key, artifact/backup paths, and distribution manifests, then moves to `READY`.

Only a `READY` project may accept `goal.create`. Goal creation derives risk from normalized facts, allocates finite planning/goal budget, and creates a `PlanningRun` with no active or proposed graph content. The sole compound `plan.propose(kind=INITIAL)` later creates the immutable plan+graph revision after safe planner finalization; first exact plan/graph approval atomically makes the goal `EXECUTION_ENABLED` with one active revision. Rejected first plans leave no active graph and remain legal.

### 17.2 Recovery commands

Recovery commands are typed, idempotent, and reason-bound when human/privileged. Their proof and postconditions are:

| State | Allowed command | Proof prerequisite | Postcondition |
|---|---|---|---|
| `SUSPECT` lease | `lease.extend` | current human authority plus no successor/revocation | new durable deadline; same epoch |
| `SUSPECT` lease | `lease.confirm_revoke` | step-up `R3` decision and current lease/version | epochs increment; effects tombstoned; resources reconcile before successor |
| crashed planner before handoff | `planning.recover_absent` | fenced/suspect lease plus runner/OS/adapter negative proof for planner process, effect, provider slot, and resources | prior attempt terminal; partial output quarantined; exact `NO_HANDOFF_RECOVERY` record makes the unchanged planning run safely claimable |
| current supersession preparation | `graph.release_preparation` | exact preparation generation/version and no committed activation | approval invalidated if present; reservation refunded, planning-admission fence released, proposal remains immutable/reviewable, readiness recomputed |
| surviving known process | `effect.adopt_result` / `work.resume` | system-observed lock/process/session/workspace/current authority match | existing effect/attempt binding adopted; no duplicate launch |
| uncertain process/effect | `effect.confirm_absent` | runner/OS/adapter negative proof | intent terminal; eligible clean retry may be created |
| uncertain process/effect | `effect.reconcile` | discoverable stable effect/result identity | adopt exact result or remain `UNKNOWN`; never blind retry |
| unknown resource | `resource.reconcile` | adapter epoch/state observation | `ACTIVE`, released, or still held |
| non-fenceable resource | `resource.confirm_released` | step-up human physical confirmation and reason | old epoch closed; successor eligibility is `HUMAN_APPROVED`, not daemon-observed |
| quarantined usage | `budget.reconcile` | complete correlated usage receipt or proof effect never started | exact commit/refund |
| irrecoverable usage | `budget.conservative_settle` | human acknowledgement plus known bound/unknown-liability classification | full reservation committed; no uncertain refund |
| unknown liability | `budget.acknowledge_unknown_liability` | human decision and policy | operational closure may continue; cost stays `UNKNOWN`, auto path disabled |
| quarantined output | `quarantine.export_forensic|discard` | exact object IDs and current reconciliation version | read-only export or reference-safe deletion; never integration admission |
| `CONTEXT_TOO_LARGE` | `context.repackage` | mandatory bytes still intact and optional selector change fits | new exact digest; otherwise command refuses and requires re-plan/provider change |
| `REVIEW_ESCALATION` | `escalation.decide` | choices limited to re-plan, eligible reviewer, one bounded funded round, or cancel | explicit next phase/blocker; no proof waiver |
| `READY` qualification recovery | `qualification.recover` | exact invalid qualification/source fingerprint, unchanged verified material, eligible independent recipe/profile, finite budget, and expected recovery version | read-only recovery lease/effect starts; no workspace-write or artifact-authoring authority |
| `FAILED|UNKNOWN|CANCELLED` qualification recovery | `qualification.retry` | material/contract still exact; every prior-lineage lease/process/effect/resource/slot proven terminal or absent; usage exactly/conservatively settled with no `RESERVED|QUARANTINED` remainder; retry cap/budget available; no sibling recovery/planning route | immutable old run remains terminal; one linked deduplicated `PENDING` recovery is created with no overlapping external authority |
| qualification result/effect authority uncertain | `effect.reconcile|confirm_absent`, `resource.reconcile`, `budget.reconcile|conservative_settle` | authenticated runner/adapter observation or complete negative/usage proof | adopt exact terminal result or close authority honestly; retry stays disabled while any prior-lineage authority is `ACTIVE|UNKNOWN` |
| any nonqualified recovery with material/contract change | `qualification.replan` | daemon classification and exact changed/missing/corrupt/stale/unknown evidence | recovery route closes; exactly one `REEXECUTE` or `CHANGE` successor `PlanningRun`/hold is created atomically |
| nonterminal qualification recovery | `qualification.cancel` | current capability/version; active/unknown effect follows cancel drain and resource reconciliation | run becomes `CANCELLED` only after terminal proof; invalid qualification continues to hold closure and exposes retry/replan/`goal.cancel` as actually legal |
| `NEEDS_RECONCILIATION` | `reconciliation.decide` | doctor-issued case type and allowed action schema | case-specific repair/discard/hold; unknown type has no mutation action |
| drain boundary | `safe_boundary.observe` | `SYSTEM_RUNNER` process/resource observation, never agent assertion | fence/release transaction or continued hold |
| stale blocker | `blocker.challenge` | exact blocker fingerprint, graph epoch, source versions, and due/new evidence | resolved, renewed with evidence, or one deduplicated replan proposal; time alone never releases authority |
| intentional wait | `wait.extend|cancel` | current owner/capability and expected version; cancellation rechecks predicate | new visible recheck boundary or ordinary typed blocker/readiness result |
| restored backup | `recovery.inspect_external|reconcile_external|complete` | fresh recovery nonce/key epoch, two-slot anchor/install proof, backup cursor, project-tagged external inventory, and current evidence | adopt/quarantine/prove absent under the new incarnation; writable effects remain blocked until every case is closed or explicitly held unknown |
| quiesced cutover | `cutover.abort` | activation has not committed and exact quiesce generation is current | candidate discarded and legacy access restored safely |

“Wait” is a query/no-op, not a state mutation. When truth is insufficient, the allowed recovery set may be empty except inspect/export/cancel; “actionable” never means inventing a destructive repair.

Fresh responses contain data, new aggregate version, event IDs/cursor, truth metadata, and `nextAllowedCommands`. An idempotent replay returns the historical result with `requiresAffordanceRefresh=true`; current commands come from a fresh query. Errors contain stable code, retryability, correlation ID, redacted details, and the exact allowed recovery set, which may be empty when no safe mutation is known.

Required stable families include authentication/capability failure, stale lease/epoch, version/idempotency conflict, illegal transition, unproven/redundant dependency, stalled frontier, fan-out refusal by scope/oracle/budget/flow, provider-runtime change, metering unavailable, `PLANNING_SUBMISSION_FINALIZING`, `SUPERSESSION_PREPARED`, superseded authority, integration/input provenance failure, journal/context limit, storage degradation, restore/cutover state, and reconciliation required. Unknown errors fail closed and provide a correlation ID; they do not invent a recovery mutation.

A versioned `ErrorRegistry` is generated with the contracts. For every code it fixes HTTP/MCP mapping, retryability, redaction, required details, valid source states, and exact recovery-command kinds. Tests enumerate the registry against every reducer rejection and control-room copy template; an unmapped backend error renders `UNKNOWN_ERROR` with no mutation affordance. This registry, not UI prose, resolves Fable dependency D2.

## 18. Control-room product contract

The board, graph, and timeline are projections over the same contract data. The board is default because most work should feel linear; the graph earns its place for expansion, fan-in, critical path, supersession, and recovery.

### 18.1 Surfaces

- **Goals home:** phase distribution, project/goal provider capacity, ready width, avoidable-idle/stalled-frontier warning, budget spent/reserved/quarantined/unknown, held/suspect badges, and approvals.
- **Goal board:** columns by planning/execution phase; owner/lease, typed hold, latest truth, structural critical-path/slack status, and durable `EXECUTION_READY` on each card. Organizational groups never imply order.
- **Goal flow/frontier:** exact `READY_NOW`, `UNBLOCK_NEXT`, `INTENTIONAL_WAIT`, and `UNSAFE_OR_UNKNOWN` lanes; idle slots, scheduler selection key, blocked causal chain, blocker age/owner/recheck, and one-click readiness explanation.
- **Goal graph:** DAG plus advisory relations, ghost proposed subgraphs, joins, submitted-graph structural critical path, dependency-proof edge inspector/challenge, lease borders, holds, breaker, input closure, and supersession overlays.
- **Timeline:** cursored causal event stream filtered by aggregate/actor/type; command, epoch, graph revision, correlation, and truth links.
- **Node inspector:** objective/criteria, phase, logical/admission/dispatch readiness, complete dependency/input tree, hold, lease/epoch, scheduler key, plan/approval hashes, attempts, evidence, artifacts, findings, budget, journal, and `nextAllowedCommands`.
- **Approvals inbox:** diff-shaped plan, expansion, supersession, acceptance, revocation, waiver, and cutover decisions with hard-edge additions/removals/proof, stage/ready-width/structural-critical-path before and after, truth-classed estimates, unexplained waits, exact prepared-planning-fence membership/deadline/release action, and what-happens-if-idle.
- **Runs and leases:** sessions, profiles, process/launch state, renewal, suspect/drain state, human recovery actions.
- **Resources:** capacity/holders/epochs/waiters, adapter fencing capability, scoped human release.
- **Evidence viewer:** exact receipt/provenance, diff/tree, output digests/tails, rerun recipe, signature verification.
- **Health/doctor:** engine/schema/integrity, projection, artifact, outbox, adapter, calibration, export, and reconciliation health.
- **Policy:** immutable revision/rule inspection and decision simulation; read-only in v1.

Disabled actions remain visible and name the failed precondition. Buttons are rendered from `nextAllowedCommands`; a client never reconstructs transition rules.

The board deliberately folds lifecycle into five display columns: **Plan** = draft `PlanningRun` states with exact badge; **Ready** = persistent active `EXECUTION_READY` and auto-collapses only when empty; **Executing** = `EXECUTING`; **Review** = `WORK_REVIEW`; **Accepted** = historical `ACCEPTED` with its separate `CURRENT|INVALIDATED|SUPERSEDED` qualification badge. A plan-rejected old run remains visibly held/historical while its separate successor draft appears in Plan. A proof-only `REQUALIFY` stays on the Accepted card as an `INVALIDATED` qualification subpanel showing `PENDING|READY|RUNNING|FAILED|UNKNOWN|CANCEL_DRAINING|CANCELLED|QUALIFIED`, any orthogonal `NEEDS_RECONCILIATION`, recipe/proof/budget/retry lineage, and generated recover/retry/replan/cancel choices. Retry remains visibly disabled with the exact unresolved effect/resource/slot/budget predicate; it never masquerades as a planning draft or invites a blind retry. Only material `REEXECUTE` or contract `CHANGE` also shows the successor draft and exact `PlanningHold` in Plan. `CANCELLED`/superseded historical runs appear under terminated history, not as a ninth execution phase. JetBrains consumes this mapping.

Rejection routing is normative and closes the immutable-authority gap in Fable's unresolved C9 assumption: implementation-only rejection routes `WORK_REVIEW -> EXECUTION_READY`; plan/requirements/dependency rejection holds the old `WORK_REVIEW` run and opens a separate successor draft in the Plan column. Approval/supersession, not a backward phase mutation, creates the next executable run. A human acceptance decline must choose a typed category; it cannot use ambiguous “back to planning.”

`EXECUTION_READY` is a real durable phase even when scheduling moves through it quickly. Goal completion/cancellation are exposed from `Goal.state`; `CLOSING` shows the exact remaining lease/effect/resource/reconciliation predicates and permits only its safe recovery actions. Composite completion derives from the designated completion node, but the goal never renders `COMPLETED` before the zero-authority proof. Activity silence is time since the session's last daemon-observed event; renewal silence is time since the last committed lease renewal. Both are separate labeled facts.

Stale-epoch worktree output remains available only as quarantined forensic bytes. It is never evaluated as a candidate and `integration.accept_output` returns stable stale-producer provenance failure. The default integrator separation is mandatory principal/session/profile independence from child producers; policy may require stronger provider/model/controller separation but cannot weaken the role boundary.

### 18.2 Required journeys

**J1 - small Tuesday bug.** After the one-time project bootstrap journey, one causal bug remains one worker node. Per-goal happy-path human actions are exactly: (1) `goal.create`, (2) exact plan/initial-graph approval, and (3) final acceptance of the verified/reviewed result. Graph canvas is unnecessary. The UI shows exact diff/receipts and total control-plane overhead.

**J2 - safe three-way feature.** One proposal shows three disjoint scopes, child oracles, allocations including integration/review, and one approval. Three workers overlap in time. Goal view shows exact input identities, not only “2/3.” The integrator exposes a seeded semantic conflict, repairs/routes it, runs the global recipe, and hands a clean package to an independent reviewer.

**J3 - crash recovery.** Kill agent/runner/daemon at declared boundaries. Restart shows adopted, suspect, quarantined, and reconciliation records with truth chips. Healthy continuation is one safe action or an already-approved policy action; it creates a traceable continuation/binding, not edited history.

**J4 - rejection and re-plan.** Findings link evidence to required changes. Delta approval shows changed hashes and invalidated/carry-forward nodes. Three-round counter is visible and escalation is explicit. Old plans, attempts, receipts, and reviews remain readable.

**J5 - silent build and stale ghost.** Sidecar renewal preserves a 40-minute build. Separate expiry becomes `SUSPECT`, never silent theft. Human sees wait/extend/confirm-revoke. After reassignment, old-epoch commands and integration output are rejected and visible in the forensic timeline.

**J6 - blocked-chain escape.** A planner proposes disjoint A -> B -> C -> D with no consumed contract. Admission rejects the naked edges and shows the corrected parallel frontier. A valid interface-first variant accepts one schema/fixture milestone, materializes its exact input into three consumers, runs them concurrently, replaces/verifies the fixture at integration, and catches a seeded conformance mismatch. A stale blocker is challenged once, an intentional wait stays visible, and no newer arrival starves an older dispatchable node.

Fable's separately owned control-room specification may elaborate layouts, copy, accessibility, and Playwright locators, but it may not change these backend semantics.

### 18.3 Accessibility and degraded behavior

- Truth, phase, risk, lease, and error never rely on color alone.
- Every graph operation has keyboard/list equivalents; canvas is not the only path.
- Focus, screen-reader names, reduced motion, zoom, and narrow-window inspector behavior are release-tested.
- Loading displays the last applied cursor and freshness; a disconnected view never looks current.
- Cursor gaps, stale projections, missing provenance, partial budgets, and offline doctor mode are visually explicit.
- No free-form chat, game score, always-on token ticker, or transcript dump appears in v1.

### 18.4 Fable dependency/conflict rulings

The control-room spec's ten recorded conflicts are closed technically as follows: C1 scheduled exports (Section 16.5); C2 derived holds/frontier (8.2-8.4); C3 five-column fold (18.1); C4 aggregate truth rule (5); C5 runner-observed safe boundaries (10.3); C6 `SYSTEM_POLICY` actor with `DAEMON_VERIFIED` truth (11.6); C7 durable `EXECUTION_READY` (18.1); C8 stale output is forensic-only quarantine (18.1); C9 implementation rejection to `EXECUTION_READY`, while plan/requirements/dependency rejection holds the old run and opens a successor draft rather than mutating authority backward (8.1/18.1); C10 mandatory integrator role separation (9.3/18.1).

D1-D15 are covered by the command/recovery registry (17), error registry (17), cursor gaps (16.4), budget sources (11), safe boundary (10), calibration (15), aggregate truth (5), doctor schema (16), lease cadence (12), event filters (16), canonical state tables (8/10/12), test hooks (20), separate silence facts (18), finite bootstrap policy (11/17), and exposed goal state (6/18). Fable retains ownership of its file; after technical freeze it must update the C9 successor-draft routing, anti-blocking frontier/dependency interactions, and any command labels that differ from generated contracts. Until that owned follow-up, this design governs conflicts.

## 19. Security and trust boundary

### 19.1 In scope

- missing, malformed, expired, revoked, stolen/swapped, or replayed session credentials;
- stale lease epoch/version/binding, spoofed identity, reused command IDs, and stale integration artifacts;
- parity of capability checks across HTTP, event stream, MCP stdio, Streamable HTTP, IDE, importer, and human force actions;
- path traversal, symlink/junction/submodule/UNC/device escape, case collision, malicious Git refs, argv/shell/env injection, and oversized inputs;
- Host/Origin/CSRF checks, credential redaction, loopback defaults, rate/backpressure, evidence substitution/tamper, and audit integrity;
- supply-chain lockfile, SBOM, dependency/vulnerability review, and signed release artifacts.

The default versioned input/backpressure limits are tested at `N` and `N+1`: command body 1 MiB; canonical JSON depth 64; individual string 256 KiB (objective/criterion 32 KiB); expansion nine nodes/64 submitted relations subject to the stricter 24-node/64-hard-edge active-goal decomposition budget; 10,000 active nodes and at most 10,000 simultaneously dispatchable `WorkItem` fairness tickets across reference-project goals, plus 1,000,000 retained events before a project capacity raise; four active provider sessions project-wide unless policy safely raises the host/provider dimensions; captured stdout/stderr 16 MiB plus 64 KiB UI tail (larger output streams to a quota-bound artifact); 32 event subscribers and 1,024 waiters per project; 100,000 pending outbox rows before mutating backpressure; accepted presence one per second/session with burst five. A fairness-cap raise uses Section 8.4's drain-or-equal/tighter-deadline transition and cannot retroactively weaken live tickets. Oversize/rate failures are stable, bounded, and never bypass authority. Artifact-store byte quota is mandatory project policy, not an unbounded default.

### 19.2 Network and credentials

Loopback is the only default bind. UI sessions use OS-protected bootstrap material, secure same-site cookies, CSRF token, and strict Host/Origin validation. Credentials never appear in URLs or logs. Non-loopback refuses to start unless a reviewed policy explicitly enables authenticated transport security and allowed origins/hosts.

MCP stdio receives a scoped bootstrap credential from its spawning process. Streamable HTTP uses authenticated sessions and the MCP authorization model. The daemon stores only necessary credential hashes/keys with OS-user permissions; receipt/export signing key rotation is audited.

Release security policy permits no known unwaived exploitable `CRITICAL` or `HIGH` dependency/application finding. Any lower-severity waiver names owner, rationale, compensating control, expiry, and exact affected artifact. Threat-model sign-off enumerates assets, actors, boundaries, entry points, abuse cases, mitigations/tests, out-of-scope host risk, and Yaron's explicit residual-risk acceptance.

### 19.3 Explicitly out of scope

A malicious process already executing as the same OS user can bypass worktrees, inspect memory/files, or attack provider processes. Moe v1 does not claim containment against it. Workspace scope, protocol authority, and integration gates protect cooperative or stale agents and attribution, not the host. Host sandboxing is a later independent defense layer and must never be implied by UI copy.

## 20. Verification and “best tool” benchmark

Two disjoint namespaces are binding: `CORE-I1`…`CORE-I22` and `CORE-S1`…`CORE-S14` below are engineering invariants/scenarios owned by this design; `BENCH-S1`…`BENCH-S14` belong only to the pinned Fable benchmark corpus. Bare `I*` or `S*` identifiers are invalid in manifests, reports, tests, and review findings.

Section 20.4 defines engineering targets and internal release obligations. The pinned benchmark defines the statistical estimators, censoring rules, claim gates, and permit-listed public sentences. When both address one metric, this design supplies the target and the benchmark supplies the comparative verdict; disagreement, incomplete evidence, or an unavailable gate yields `UNKNOWN`, never `PASS`. GA readiness and the benchmark claim ladder are separate axes: GA alone licenses no comparative claim, and “best tool” requires `G-L5` `PASS` with its complete date/corpus/user/cohort scope.

### 20.1 Release invariant ledger

The release record evaluates these named predicates after every generated command/fault boundary and after replay:

1. **CORE-I1 Claim uniqueness:** at most one authoritative assignment/workspace lease per node execution; successor release/claim intervals never overlap; project/provider/goal slots and resource capacity are never exceeded; an all-resource request never holds a partial set while waiting.
2. **CORE-I2 Fencing:** every accepted leased mutation has authenticated matching session/token/current epoch/authority/binding/version/recovery-incarnation; a stale or absent field produces no business effect, and a same-generation repeated restore can never recreate a prior nonce/signing-key epoch.
3. **CORE-I3 Legal lifecycle:** every planning/submission/hold, execution, attempt/drain-disposition, qualification recovery, integration, pause, and cutover transition comes from its canonical relation; blockers and `SUSPECT` cannot smuggle a phase change or mutate active authority backward.
4. **CORE-I4 Proof before acceptance:** a currently qualifying `ACCEPTED` node implies current graph/policy approvals and every exact receipt/artifact/integration/review/witness obligation in that node's `AcceptanceContract`; historical acceptance with `INVALIDATED|SUPERSEDED` qualification cannot satisfy readiness or closure. Proof-only invalidation may only `REQUALIFY` unchanged verified material, a retry cannot overlap unresolved prior recovery authority, material invalidation must `REEXECUTE|CHANGE`, and leaf/composite contracts cannot form a circular prerequisite.
5. **CORE-I5 Durable ordering:** with authoritative DB/WAL intact, every acknowledged event survives exactly once in per-aggregate sequence and rebuilt/live projections match. Disaster restore matches exactly its declared backup cursor/RPO; it never claims later acknowledgements survived.
6. **CORE-I6 Join and goal closure:** readiness/parent state derives from exact required artifacts and join/completion contract; every execution-bearing node is the completion node or inside its required transitive acceptance closure; entry to `CLOSING` implies all such runs terminal `ACCEPTED` with current qualification; and `COMPLETED` additionally implies every still-required qualification input current plus zero live subordinate authority/effect/resource/planning hold/funding/reconciliation. Any pre-completion proof invalidation has exactly one typed legal recovery/closing-escape path. No early join, orphan executable node, interface-first closing deadlock, or projection mismatch may survive a prerequisite transaction/replay.
7. **CORE-I7 Complete derivation:** logical/admission/dispatch readiness, held state—including every exact `PlanningHold`, invalid qualification recovery, and planning drain—causal blocker chain, and frontier rebuild equal stored projections using only immutable/revision-referenced inputs at the same cursor.
8. **CORE-I8 Supersession:** removed nodes accept no post-activation business mutation and removed attempts with any active/unknown effect/resource remain `DRAINING` until proof; stronger drain reasons monotonically replace release/cancel targets and cannot resurrect a handoff; changed/reexecute nodes only accept drain-whitelisted commands until that boundary; unchanged attempts adopt atomically only on exact recursive authority/input binding/material/qualification equality; every consequence-changing lifecycle/proof/review/dependency/blocker/planner/budget fact is stored-prepared-plan-bound; its planning fence admits no new competing claim/submission/effect and terminates with the preparation generation; a parameterized meter delta is accepted only inside its frozen liability/formula and fully held successor minima; every supersession funding reservation reaches one terminal state; benign renew/progress/scheduler traffic cannot livelock activation.
9. **CORE-I9 Command idempotency:** same ID+request returns one result/effect; same ID+different request is a hard conflict.
10. **CORE-I10 Graph/budget containment:** DAG, goal-wide node/edge/depth/width, project/goal concurrency, scope, and conserved budgets hold under races; children cannot mint authority or spend.
11. **CORE-I11 Fan-out gate:** parallel writes are schedulable only with disjoint scopes, per-child machine oracles, budget fit, dependency proof, and admitted flow case; refusal is all-or-none.
12. **CORE-I12 Approval binding:** every approval names exact hashes/scope/criteria/budget/policy/dependency/quality assessment; invalidation and carry-forward sets are exact and explicit.
13. **CORE-I13 Authority parity:** every adapter applies the same identity/capability/independence rules.
14. **CORE-I14 Evidence integrity:** node input/result and integration manifests, content/trees, environment/runtime coverage, recipe, producer epoch, and receipt/signature verify; agent text cannot satisfy a gate.
15. **CORE-I15 Attribution:** only approved explicit paths can enter integration; foreign, escaped, stale, or unproven bytes are quarantined.
16. **CORE-I16 Outbox/effect safety:** atomic event/projection/outbox, causal desired-state checks, pre-activation tombstones, the atomic attempt-`RUNNING`/effect-`ACTIVE` activation edge, runtime pinning, and effect-specific idempotency/locks/adoption prevent stale or duplicate **authoritative** launch/verification/integration/resource/qualification effects; every attempt/effect/resource cross-product has one legal disposition, pre-active resource uncertainty drains rather than terminalizes, no terminal recovery retry exists over unresolved prior authority, active cancellation reconciles under strongest reason, and notification delivery is at-least-once with presentation deduplication.
17. **CORE-I17 Recovery truth:** each injected crash yields whole committed domain transaction or none; restart never fabricates owner/verified/accepted truth and exposes the exact safe recovery set, which may contain only inspect/export/cancel or be empty when no mutation is provably safe.
18. **CORE-I18 Bounded loops/journal:** counters cannot reset through churn; exhaustion escalates; attempt learning survives and is digest-bound into eligible successor context.
19. **CORE-I19 Same-bug breaker:** normalized correlated sibling failures trigger once, prevent post-trigger launches/retries, preserve bounded in-flight waste, and propose a superseding revision with one repair predecessor; children resume only as new/rematerialized attempts against the repaired authority contract, except records whose full hash still carries.
20. **CORE-I20 Presence isolation:** accepted duplicate/reordered/burst presence converges to max server-received time under eventual-delivery assumption; dropped pings promise nothing and presence never changes authority, readiness, aggregate sequence, or command latency beyond its bar.
21. **CORE-I21 Dependency and scheduler integrity:** every hard edge has a current typed contract and is neither cyclic nor semantically redundant; organizational/resource relations cannot hold semantic readiness; semantic blockers and planning holds reference admitted/current authority; every revocable satisfaction witness is input-bound and invalidates active qualification at each named boundary; and under finite capacity/fairness assumptions, persisted WDRR plus compatible-opportunity aging and immutable FIFO forced cohorts ensures neither nested-ring/weight/arrival churn nor newer recovery work starves a continuously dispatchable node or leaves a slot avoidably idle beyond `8*c + M_d`.
22. **CORE-I22 Restore fencing:** a backup restore installs a fresh CSPRNG incarnation nonce and signing-key epoch through the crash-safe two-slot anchor and remains quiesced; neither replay nor repeated restore of the same generation can revive an old grant. It issues no new effect until every configured effect class proves complete post-cursor inventory coverage and each project-tagged workspace/process/provider/resource/Git/artifact state is absent, safely adopted to a restored intent under the new incarnation, or quarantined. Incomplete coverage remains unavailable and cannot be overridden into “safe.”

Additional fan-in and graph predicates require exact node input/result and integration input/result manifests, each inherited artifact applied once, reproducible order/tree, no unresolved finding, no implicit cross-revision input, at most one active graph revision (exactly one for execution-enabled or closing goals), one disposition per old node, monotonically increasing graph epoch, no stacked v1 supersession, and retained old evidence.

### 20.2 Fourteen fixed scenarios

Each scenario pins fixture/base SHA, graph/policy/provider/profile versions, random/fault seed, OS, expected side effects, and exact durable/UI oracles.

1. **CORE-S1 causal bug:** stays linear; one author attempt; exact receipts/review; at most three defined human commands.
2. **CORE-S2 three-way feature:** three disjoint children overlap in time; one expansion approval; integrator catches a seeded cross-child mismatch; global recipe and clean review decide completion.
3. **CORE-S3 overlap/conflict:** parallel overlap is refused; execute the proposed serial alternative; a semantic conflict becomes a structured integrator finding, never an auto-merge.
4. **CORE-S4 crashes:** separately kill planner, worker, qualification recovery, and daemon/runner before/during/after claim, staged compound proposal, safe/no-handoff recovery, every named commit/outbox/effect/lock/registration/artifact boundary, and each attempt/effect/resource cross-product transition. A planner lost before handoff can re-enter only through negative proof plus `NO_HANDOFF_RECOVERY`; provider activation makes attempt `RUNNING` and effect `ACTIVE` together; a pre-active attempt with unknown resource release stays `DRAINING`; an unknown qualification result with possible live authority remains reconciliation-held and cannot retry; prove whole-or-none domain state, adoption/suspect truth, and effect-specific final desired state.
5. **CORE-S5 rejection lineage:** invalid plan, flawed implementation, and requirements change exercise delta approval, dead ends, bounded rounds, selective carry-forward, and supersession.
6. **CORE-S6 exclusive resource:** renew, presence-only, suspect, human revoke, successor grant, and stale adapter use prove capacity/fencing and honest wait behavior.
7. **CORE-S7 hostile stale client:** attack every transport with missing/spoofed/swapped/stale/replayed credentials, versions, command IDs, and artifacts; zero accepted effects; valid stale rejections visible and redacted.
8. **CORE-S8 abusive expansion:** cycles, depth `4`, width `7`, scope escape, over-budget and racing reservations refuse atomically; exact-boundary and audited-raise controls succeed.
9. **CORE-S9 fan-out refusal:** the sole compound `plan.propose(kind=EXPANSION)` with missing child oracle or overlapping scopes produces stable reasons and a sequential alternative, no partial revision/lease/allocation. Stage/refuse/decline/cancel race `ARMED|ACTIVE|UNKNOWN` planner effects, resources, slots, crash, and restart: the exact `EXPANSION_PLANNING` hold keeps the parent non-dispatchable through drain, then terminal proof clears it and resumes the unchanged parent from its worker handoff. `REVISE_PLAN` atomically replaces the bound hold/run and corrected proposal succeeds; `graph.preview` never mutates.
10. **CORE-S10 same-bug convergence:** shared upstream defect triggers once; no post-trigger launch/retry; one superseding revision inserts an upstream repair; children rematerialize against its accepted output before deterministic new attempts; negative signatures do not group.
11. **CORE-S11 mid-flight supersession:** running carried/changed/removed/requalify/reexecute nodes with commands and crash around prepare/approval/activation prove disposition, safe boundary, binding, epochs, and no orphan lease. Two planners for different old-epoch predicates claim/submit/prepare/approve/activate in every meaningful order: the activating lineage activates, every other run/attempt/submission/hold is exactly dropped or rebound, a live planner drains, and unknown applicability refuses without an epoch change. A non-activating sealed submission races prepare before/at/after every finalization boundary: finalization-first is included in the recomputed plan, while pending-submission-first produces `PLANNING_SUBMISSION_FINALIZING` and no reservation/fence/stored plan; no sealed submission is lost or left frozen. After prepare, repeated scheduler claim/release/submit/effect-activate attempts on a fenced non-activating planner all return the stable prepared reason without spending or staling approval; existing active authority may only move monotonically toward release/drain. Release-preparation/expiry/crash restores admission exactly once. `REMOVE` with a pre-active unknown resource or active effect crashes before/after activation, cancel observation, checkpoint, and reconciliation; it stays fenced `DRAINING` until the canonical terminal edge. `release -> dependency invalidation|cancel|REMOVE` and `cancel -> REMOVE` in every order prove monotonic strongest-reason outcome and no resumable handoff revival. Concurrent acceptance/rejection/review-validity, allowed planner release/drain/hold, blocker/witness-source, phase, and per-meter usage changes either remain inside the exact funded disposition guard or force a typed re-prepare. The timeline explains each outcome.
12. **CORE-S12 outbox replay:** duplicate/reorder/crash every lease, launch, verify, resource, notification, and integration delivery; causal desired-state/tombstone and effect protocols yield one authoritative final effect, at-least-once deduplicated notifications, and visible drain/quarantine.
13. **CORE-S13 blocked-chain escape:** submit four disjoint oracle-complete nodes as A -> B -> C -> D; naked/transitively redundant edges refuse and the corrected graph runs up to available four-slot capacity. Positive controls retain an exact consumed interface edge while unrelated work runs. A real accepted schema/fixture predecessor materializes into three consumer input trees, consumers overlap, changed predecessor hashes invalidate them, fan-in applies the predecessor once, and seeded conformance failure is caught. The completion consumer may accept from an early interface milestone, but `CLOSING` waits for the producer's full acceptance. Witness, reviewer eligibility/edit, approval validity, receipt/evidence freshness, and artifact corruption race materialization, claim/activation, review, acceptance, closing, and completion; proof-only defects `REQUALIFY`, material defects `REEXECUTE|CHANGE`, and none qualify stale output. Orphan executable `X`, hidden blocker cycles, stale `PlanningHold` across restart/refusal, upstream failure, intentional wait, continual recovery arrivals, continuous new/empty/re-enter goal and role queues, nested outer/inner rollovers, pending weight changes, older-unforced/later-forced items, fairness-cap raise, restart, noisy goals, resource-blocked heads, and replan-removes-edge races prove `CORE-I4`/`CORE-I6`/`CORE-I7`/`CORE-I21` and J6.
14. **CORE-S14 disaster restore:** take backup at cursor N, execute/tag provider, resource, workspace, integration, Git, and artifact effects on both sides of N, then lose live storage. Restore equals N, installs a fresh nonce/key epoch, rejects old credentials, inventories/quarantines post-N effects, cannot repeat them while unknown, and resumes only after the exact R3 recovery digest. Restore the identical generation again and crash at every anchor/inactive-slot/fsync/switch boundary; each committed install has a distinct incarnation and no grant from either prior incarnation validates.

### 20.3 Test suites

Before production implementation, Phase 1 writes executable scenario/model interfaces. Required suites include:

- pure reducer command/state generation, including goal `CLOSING`/zero-authority/current-proof completion, generic `REQUALIFY|REEXECUTE|CHANGE` invalidation escape and qualification retry/replan/cancel with prior-lineage terminal proof, safe/no-handoff planning successor claims, staged compound proposal drain, prepared planning-admission fencing/release, concurrent old-epoch planner disposition, and expansion decline/resume paths;
- linearizability of claim/renew/revoke/budget/integrate/supersede against the pure model;
- draft-planning/active-execution/release/pause, DAG/join/re-entry/supersession algebra;
- dependency-contract validation, semantic transitive reduction, completion-closure reachability, interface/fixture milestone alternatives, monotonic/revocable witness fencing, blocker scope/cycle admission, and frontier equality;
- node-input/result materialization and fan-in closure deduplication/conflict/stale-adoption;
- path/scope, budget conservation, advisory preview versus mutating prepare parity, parameterized supersession-meter guards, and coupled complete `SupersessionFundingReservation`/`PreparedPlanningFence` lifecycle boundaries/races;
- monotonic-time lease expiry/renew/revoke with clock jumps/reboot/PID reuse;
- command/event/outbox duplicate and reorder idempotency;
- byte-flip canonical hash/approval/evidence binding across OS/locale/line endings;
- every supported event upcast/migration/replay, intact-store restart, and RPO-bound disaster restore/recovery incarnation;
- breaker classifier negative/positive permutations;
- presence loss/burst isolation;
- reviewer independence/invalidation/loop-cap rules plus proof-only requalification versus material reexecution classification;
- journal/context determinism, bounds, secret exclusion, and crash persistence.
- fresh bootstrap/first graph activation/rejected-first-plan and proposal-lease fencing; project/provider/goal slot capacity, resource all-or-none acquisition and pre-active uncertainty, persisted round-cohort WDRR plus compatible-opportunity tickets/FIFO forced lanes across restart/cancel/nested-ring/weight/cap/continuous queue churn, finite priority aging versus continual recovery arrivals, cancellation, deadlock/starvation, pause; and release/handoff/resume atomicity.
- provider runtime auto-update/path-swap between probe, quote, activate, and spawn; only the exact pinned closure may launch.
- distribution-manifest compatibility so stale installed daemon/UI/MCP/IDE/provider assets refuse startup.

Fault injection covers each boundary around transaction begin/writes/commit/ack, WAL/checkpoint/backup/restore/migration, repeated restore of the same backup generation/recovery-incarnation ABA, every recovery-anchor/inactive-database/fsync/slot-switch boundary, disk/permission/lock/corruption, planner/provider/verifier/integrator/qualification-recovery death/hang/truncation, planning handoff/no-handoff and staged-submission recovery, sealed-submission-finalize versus prepare, prepare-fence install/claim/release/expiry/invalidation/consume, the complete owning-attempt x provider-effect x resource-state claim/arm/activate/physical-start/result/ack/cancel/invalidate ordering, qualification UNKNOWN/late-result/retry reconciliation, all drain-reason permutations/upgrades, dependency/blocker/planning-hold/frontier recompute through closing, generic acceptance-proof invalidation, supersession-funding/fence terminalization, scheduler round selection/arrival/empty/re-enter/claim/release/restart, input materialization, worktree/artifact/Git failures, AV locks, case/Unicode/long paths, and stale producers. A kill before response may present immediate transport loss; after restart each catalogued fault must yield whole-or-none durable truth, stable classification, the exact idempotent allowed recovery set (possibly none), and all evidence surviving storage can honestly provide. Total storage loss follows the declared RPO/recovery-incarnation contract, not an impossible timeline guarantee.

Security tests cover Section 19 across all transports and force/import paths. Migration tests cover deterministic byte-preserving import, ambiguity/corruption/security limits, schema crash boundaries, backup/export generations, cutover, and no legacy mutation.

Named legacy incident fixtures are mandatory: terminal release cannot resurrect (`53271ca`); release atomically preserves resumable phase/handoff (`3563791`, `28a6588`); held/human-gated work cannot enter hot claim loops (`1aa1546`); scheduler/timer callbacks reacquire transactional authority rather than inherit re-entrant-lock state (`28a6588`); silent plan/work review is not stolen (`3d2cb16`, `b30fb6f`); and stale installed assets fail the distribution handshake. These fixed fixtures complement, rather than hide inside, broad properties.

### 20.4 Quantitative bars

- Phase 1 generates the finite `ScheduleCoverageManifest` from the versioned command/result schemas, canonical lifecycle relations, effect protocols, transaction/fault registry, and dependency/scheduler/recovery contracts; authors cannot shrink that source-derived universe. The build fails if any generated command outcome, reachable lifecycle/effect edge, registered fault boundary, or `CORE-I1`…`CORE-I22` / `CORE-S1`…`CORE-S14` obligation lacks a mapped schedule. Shared-state races include frozen mandatory two-event and applicable three-or-more-event partial-order strata, including advisory-preview/sealed-submission-finalize/prepare-fence/claim/release/expiry/approval/activation and concurrent old-epoch planners; staged proposal/planning-hold/drain/refusal; dependency fact/claim/effect/resource; competing drain reasons; qualification recover/UNKNOWN/reconcile/late-result/retry/replan/cancel/closing/completion; scheduler nested-round/new-arrival/weight-change/forced-entry/cap-transition/restart; and restore install/incarnation. Schedule identity canonicalizes actor/item roles, commands, outcomes, fault points, and happens-before edges while excluding random IDs, wall timestamps, and seed labels, so irrelevant variation cannot inflate uniqueness. Release requires 100% obligation/transition/boundary coverage, every frozen stratum minimum, **and then** at least **10,000 unique persisted canonical schedules**; the count is not a substitute for coverage. The generator version, source map, manifest hash, identities, seeds, hits, and minimized failures are published and `CORE-I1`…`CORE-I22` have zero violations.
- Zero accepted stale-epoch mutations and 100% of authenticated syntactically valid stale rejection decisions whose audit transaction was committed/acknowledged present in the redacted timeline; audit-unavailable transport failures are unacknowledged and counted separately.
- With intact authoritative storage, zero lost acknowledged events and zero stale/duplicate authoritative launch/verification/integration/resource effects under their declared protocols. Disaster restore equals its published cursor/RPO and passes `CORE-S14`; notifications are at-least-once and render once per stable ID.
- 100% of accepted nodes satisfy the proof/integration/review/approval obligations applicable to their exact `AcceptanceContract`.
- Zero qualification-retry attempts create authority while any prior-lineage lease/effect/resource/provider slot is active or unknown; every such command is stably disabled/refused until reconciliation, and every late terminal-lineage result is deduplicated/quarantined rather than adopted.
- Zero foreign/escaped/stale-path inclusion across attribution tests.
- Anti-blocking corpus: zero unsupported/redundant hard edges admitted; false-dependency fixtures have structural critical-path inflation `approved fixture stages / known-minimum fixture stages = 1.0`; valid dependency controls retain every required edge; no inherited predecessor artifact is applied twice.
- Under the reference load, zero avoidable-idle intervals exceed the one-second dispatch bound. Every continuously dispatchable item meets Section 8.4's persisted bound of at most `8*c + M_d` compatible dispatch opportunities and, after forced entry, the exact `F_ahead + 1` remainder. Evidence records ticket/dimension/cap revision, every counted bypass or excluded incompatible opportunity, forced-entry order, restart, nested goal/role rollover, arrival/re-entry, weight change, and cap-transition input; blocked heads consume no provider slot, later forced entrants cannot jump, continual recovery arrivals cannot pass a forced cohort, and one noisy goal cannot starve another.
- Prerequisite/blocker/supersession commit or replay updates frontier and causal blocked projection in the same transaction and matching browser DOM within the UI latency bar. An unexplained stalled frontier emits at most one deduplicated challenge/replan proposal within one dispatch bound; unchanged evidence emits no repeat.
- While a supersession preparation is current, 100% of new claim/submission/effect-activation attempts for its enumerated non-activating planning lineages return `SUPERSESSION_PREPARED` without creating an attempt, slot, effect, resource, or spend. Under a continuous scheduler-claim storm, the displayed unchanged prepared approval still activates within the command/UI latency bars; release/invalidation/expiry restores planning admission in the same committed transition.
- Every plan/expansion approval reports hard-edge/stage counts, structural critical path, ready width, blocked descendants, orchestration/handoff cost, unexplained waits, and estimate truth before/after. Duration `UNKNOWN` remains `UNKNOWN`; Moe makes no global decomposition-optimality claim.
- On each supported OS, the preregistration names exact machine/CPU/disk/OS SKU and background-load recipe, caps Moe to four logical CPUs and 16 GiB RAM, and cannot change after RC begins. With 10,000 nodes, 1,000,000 events, four active sessions, 10-second presence and a 10x burst over at least 10,000 updates: command commit-to-matching browser DOM p95 `<=500 ms`, p99 `<=1 s`, zero unhandled cursor gaps; presence raises durable-command p95 by at most 10% and never beyond 500 ms. These are engineering SLOs; the benchmark's `G-UI` tolerance-bound rule decides comparative evidence.
- Over at least 10,000 valid auto-policy proposals under that load, committed proposal through committed graph/readiness/budget allocations to schedulable children p95 `<=2 s`; human think time is reported separately and post-click processing obeys the UI bar. This is an engineering SLO measured by `G-expand`, which is reported but is not itself a claim-ladder rung.
- Comparative engineering targets are `1.8x` decomposable speedup, no critical-severity quality regression, cost no greater than `5.0x` control, and single-agent orchestration-added time no greater than `max(0.10 * control_time, 2 seconds)` with at most three happy-path human commands. They do not define estimators or license claims.
- Comparative verdicts come exclusively from the pinned benchmark's `G-L3-speed`, `G-L3-accept`, `G-L3-cost`, `G-L4-quality`, `G-overhead`, and applicable higher-rung intersection-union rules, including its frozen constants, power, censoring, competing-risk/RMST, non-inferiority, confidence-bound, tolerance-bound, multiplicity, and all-runs cost rules. Missing, conflicting, or cross-basis evidence yields `UNKNOWN`; failures/rejections are never discarded or replaced by a design-local timeout convention.
- Every adapter/version passes capability and malformed/truncated stream tests; every supported SQLite package reports engine `>=3.51.3` in `doctor`.
- Reviewer release report publishes the complete stratified calibration results and passes all critical contract sentinels; broader efficacy remains honestly labeled until powered.
- Restore drill, the Section 19 no-unwaived-critical/high vulnerability gate, complete threat-model sign-off, supported-OS packaging, and every repository gate exit `0`.

Reference hardware, provider/model, network, cache, task fixtures, pricebook, sample/power calculation, and raw run records are frozen before measurement. A benchmark may not discard failed or rejected runs to improve results.

### 20.5 Benchmark integration boundary

The implementation closes the pinned benchmark's T-D1…T-D10 dependencies without giving the benchmark authority over backend semantics:

| Dependency | Binding implementation contract |
|---|---|
| T-D1 | Every provider adapter emits `UsageMeasurement` rows using exactly `PROVIDER_REPORTED_COMPLETE`, `PROVIDER_REPORTED_PARTIAL`, `DERIVED_LIST_PRICE`, `SUBSCRIPTION_QUOTA`, `ACTUAL_BILLED`, or `UNKNOWN`. Unsupported is `UNKNOWN`; incomplete evidence remains `PROVIDER_REPORTED_PARTIAL` with its measured lower bound and never masquerades as complete. Gate-specific conservative imputation or rejection is exclusively the benchmark's rule. |
| T-D2 | `RunTelemetryRecord` is the machine-readable per-run record and binds stop reason, counts, infrastructure class, timestamps, model/runtime snapshot, configuration and source hashes, receipts, and artifacts. |
| T-D3 | Versioned generic local-only fault/replay hooks address the registered fault boundaries consumed by both `CORE-S4`/`CORE-S7`/`CORE-S11`/`CORE-S12` and `BENCH-S4`/`BENCH-S7`/`BENCH-S11`/`BENCH-S12`. They are unavailable to normal provider clients and cannot weaken production checks. |
| T-D4 | `EvidenceRecipeRevision`, `EvidenceRun`, and `EvidenceReceipt` bind oracle reruns, exact inputs, environment/runtime, result, and manifests; agent text never satisfies an oracle. |
| T-D5 | `ProjectConfigurationManifest` supplies the path-neutral effective configuration, `settingsDigest`, and orchestration SHA. No benchmark record depends on a physical settings path. |
| T-D6 | `SurfaceTimingReceipt` separates server receipt/commit, client render, and human-think observations so response time and system latency cannot be conflated. Cross-process timing either uses one external observer or binds event/cursor identities plus measured clock-offset uncertainty; if that uncertainty cannot support the bar, latency is `UNKNOWN`. |
| T-D7 | Expansion timing records the required outer interval from committed proposal through committed graph/readiness/budget allocation to schedulable children, plus policy-input-ready, validation, allocation, and projection subsegments for diagnosis. Manual think time is excluded; no inner subsegment may replace the outer verdict interval. |
| T-D8 | A headless invariant checker consumes the source-generated `ScheduleCoverageManifest` and evaluates all `CORE-I1`…`CORE-I22` and `CORE-S1`…`CORE-S14` obligations over authoritative state, events, artifacts, receipts, and recovery evidence. An incomplete universe or missing evidence is `UNKNOWN`; a proven violation is `FAIL`. |
| T-D9 | Deterministic development-fixture generation, base-SHA recording, sealed-manifest tooling, reserved-domain/invalid-credential emission, and pre-run scanning are versioned and reproducible. Development fixtures are always `DEVELOPMENT_ONLY` / `NOT_CONFIRMATORY`; confirmatory `BENCH-*` corpus generation and sealing occur only after implementation commit freeze under the benchmark's independent-author/contamination rules. |
| T-D10 | `ReviewerEligibilityReceipt` exposes independence, calibration, adjudication, and reviewed-input metadata needed by the blinded-quality protocol. |

Every campaign binds the exact design, benchmark, implementation, checker, manifest, fixture-generator, analysis-script, settings, policy, provider/model/runtime, and pricebook digests. The benchmark's pre-freeze namespace/reference audit is a release prerequisite. A missing or mismatched binding makes the affected gate `UNKNOWN`, not inferred from GA status.

## 21. Legacy import and cutover

1. Freeze and name the legacy baseline; rerun legacy characterization. The previously observed `899` passing plus one PowerShell hook failure is a host snapshot, not a rebuild dependency or current green claim.
2. Build a read-only importer. Before import, hash every source file and emit a manifest; never change source content or mtime intentionally.
3. Preserve raw source digests/blobs and import provenance. Map lifecycle and `BLOCKED` to phase plus orthogonal blocker.
4. Never activate a legacy assignment/resource claim. Import it as historical/suspended and require an authenticated new lease.
5. Treat best-effort legacy activity as untrusted history, not authoritative v2 events. Legacy epic/task containment, prose order, and `dependsOn`-style links import only as historical `CONTAINS|RELATED` evidence; none becomes a hard edge, blocker, or hold without a new typed `DependencyContract` and the current approval path.
6. Report exact counts, unknown fields, dangling refs, cycles, split ownership, corrupt/invalid bytes, and case/path conflicts. Ambiguity becomes `NEEDS_RECONCILIATION`, never a guess.
7. Re-import of identical bytes is canonical and idempotent: imported IDs, ordering, provenance times (source time or manifest-defined deterministic sentinel), and canonical event payloads derive from source digests/manifest, not wall-clock import time. Identical bytes produce identical canonical DB/export hashes; an interrupted import commits wholly or not at all.
8. Shadow comparison reads copied/frozen snapshots and emits mismatches; it never dual-writes or mutates legacy.
9. `cutover.preview` creates `PREVIEWED` from the exact source/process/writer/access inventory and proposed lock/snapshot procedure; it has no stopping authority.
10. **`GO_QUIESCE`:** `approval.decide(CUTOVER_QUIESCE)` is a step-up `R3` decision over that preview. `cutover.quiesce` consumes it, transitions through `QUIESCE_APPROVED -> QUIESCING -> QUIESCED`, enumerates/stops and disables every known legacy daemon, launcher, IDE/plugin writer, watcher, and scheduled start; proves no listed process/open write handle remains; applies an OS-enforced deny-write lock; captures an immutable snapshot; and obtains identical complete file manifests twice at least 10 seconds apart. Any mismatch/unknown writer holds or `cutover.abort` restores the pre-cutover access state.
11. Import reads only that locked snapshot. Exact counts/hashes, replay, complete backup generation, distribution manifests, adapters, and restore drill move the attempt to `IMPORT_VERIFIED`. No v2 production authority exists yet.
12. **`GO_ACTIVATE`:** a second distinct `approval.decide(CUTOVER_ACTIVATE)` step-up decision binds the quiesce generation, frozen manifest, verified import head, distribution set, and restore result. `cutover.activate` consumes it and one transaction moves `ACTIVATE_APPROVED -> ACTIVE` while writing the v2 activation marker/project state. Only then may the first v2 authoritative command run.
13. Before `cutover.activate` commits, `cutover.abort` removes the candidate and safely unfreezes legacy writers/access. After the first v2 command, automatic state rollback is not promised; recovery proceeds in v2 or a separately designed reverse migration. Legacy remains locked/readable for forensics, and no hidden dual write masks this boundary.

## 22. Delivery phases, ownership, and gates

Every phase receives a separate bite-sized TDD implementation plan. No phase may hide a missing correctness contract behind later UI work.

### Phase 0 - challenge, independent review, and freeze

- **Codex:** this integrated technical design and rulings.
- **Fable:** completed the independent market/product review and control-room specification; is separately assigned `docs/plans/2026-08-05-moe-best-tool-benchmark-spec.md` for independent product/benchmark validity, with no implementation authority.
- **Moe reviewer:** read-only adversarial design check at the exact handoff in Section 24.
- **Yaron:** resolves any reported blocker and gives explicit design-freeze/scaffold `GO`.

Exit: accepted design, reconciled control-room and benchmark measurement contracts, no unresolved correctness blocker, and authorization to create `D:\projexts\moe-next`.

### Phase 1 - executable behavioral specification

Codex owns testkit/contracts for `CORE-S1`…`CORE-S14`, `CORE-I1`…`CORE-I22`, the schedule coverage manifest, pure models, provider golden streams, reviewer calibration corpus, legacy fixtures, and fault/security catalogs. Phase 1 also runs blocking pinned-version feasibility spikes for SQLite candidates and Claude/Codex adapters. Adapter methods report typed `UNSUPPORTED`; help text is not capability proof. The minimum linear-slice profile requires structured versioned output capture, stable Moe effect identity/activation gate, pinned runtime closure, cwd/process observation, cancellation/fencing behavior, raw-event preservation, and crash reconciliation into proven result or `UNKNOWN`. Token caps, provider resume, billing, or incremental usage remain optional capabilities and cannot be assumed. Production code does not satisfy tests yet; failures must name missing behavior rather than import legacy implementation. Every Phase 1 fixture is `DEVELOPMENT_ONLY` / `NOT_CONFIRMATORY`; confirmatory `BENCH-*` corpus bytes remain absent and are sealed only after the implementation commit freeze required by the pinned benchmark.

Exit: complete deterministic failing specifications and published fixture hashes.

### Phase 2 - contracts, pure core, transactional store

Build canonical schemas/hash/impact functions, planning/execution/cutover reducers, chosen SQLite driver/migrations, idempotency, events/upcasters, projections, outbox/inbox, artifact staging, cursor/RPO backups/exports, recovery incarnation/inventory, integrity and replay.

Exit: reducer/property, crash-at-every-write, upcast, projection, backup/restore, and storage-driver gates pass.

### Phase 3 - identity, policy, budgets, and fenced leases

Build credentials/capabilities, four-outcome policy, approval/risk tiers, conserved budget ledger/meter coverage, assignment/workspace/resource leases, presence split, suspect/drain/revoke, and transport parity.

Exit: randomized concurrency/restart schedules accept no unauthorized mutation, mint no budget, and show honest unknown/recovery.

### Phase 4 - usable linear vertical slice

Build a single-node immutable graph, draft proposal lease, durable runner/`effect.activate` protocol, runtime-pinned **Claude only**, exact input/result manifest and clean candidate, protected downstream-proof budgets, verifier/receipts, journal/context, safe release/resume, clean review/calibration, bootstrap, minimal board/node/approval/evidence/doctor surfaces, and recovery commands on primary Windows. Phase 4 admission returns typed `UNSUPPORTED` for any graph containing more than one execution-bearing node; no naive task DAG can become de facto behavior. Multi-node activation remains unavailable until Phase 5's anti-blocking admission, input materialization, integration, and `CORE-S13`/property gates pass.

Exit: Foundation Preview passes J1, J3, J4 and hostile-client/release-handoff incident fixtures on Windows+Claude. It is explicitly not yet the graph/fan-out or “best tool” release.

### Phase 5 - anti-blocking graph, fair scheduling, fan-in, and supersession

Build typed dependency contracts/challenges, plan-quality and semantic-reduction admission, interface-first predecessor materialization, three-level readiness/frontier/explain, typed blocker/intentional-wait invalidation, bounded replan proposal, project/provider/goal work-conserving fair scheduler, multi-node revisions/hashes, safe expansion/refusal, all-required integration with closure deduplication, same-bug breaker, graph epoch, consequence-equivalent supersession, carry/drain/remove dispositions, and delta approval over the proven runner.

Exit: Graph Beta passes `CORE-S2`, `CORE-S3`, and `CORE-S8`…`CORE-S13` plus graph/dependency/frontier/scheduler/input/integration/budget/supersession property suites with complete timelines on the primary environment.

### Phase 6 - canonical control room

Fable owns the accepted product/interaction specification in an exclusively assigned documentation path. UI implementation ownership is assigned by directory before edits; Codex owns generated API integration and journey acceptance tests. No shared-file co-authoring.

Exit: J1-J6 pass Playwright/accessibility/latency tests; every dependency/frontier/idle/wait fact has truth/provenance and every action is contract-derived.

### Phase 7 - portability, Codex, MCP, JetBrains, and legacy importer

Codex owns MCP/import/provider seam; Fable reviews JetBrains interaction. Add the Codex adapter, supported Linux/macOS packages and effect tests, official stable transports, thin JetBrains start/discover/embed/browser fallback, deterministic read-only import, reconciliation, and shadow comparison.

Exit: copied real projects import with exact hashes/counts, ambiguity never activates, and legacy bytes remain unchanged/readable.

### Phase 8 - hardening, comparative evidence, and cutover

Run all repository, property, schedule-coverage, fault, security, migration, `CORE-S14` disaster-restore, packaging, SBOM, and quantitative gates. Fable independently reviews product/benchmark validity; Moe independently reviews evidence; Yaron authorizes cutover.

Expected repository gates are:

```powershell
pnpm lint
pnpm typecheck
pnpm test
pnpm test:contract
pnpm test:property
pnpm test:fault
pnpm test:security
pnpm test:migration
pnpm test:integration
pnpm test:e2e
```

Every command exits `0`, and the release record binds the exact source commit, tool versions, configuration/policy hashes, fixtures, seeds, full results, and artifact digests. Cutover uses the two distinct Section 21 decisions: `GO_QUIESCE` freezes/snapshots legacy, then `GO_ACTIVATE` enables v2 only after import/restore verification.

The delivery is therefore incremental rather than a big bang: **Foundation Preview** (Windows+Claude linear J1/J3/J4), **Graph Beta** (safe anti-blocking planning/fan-out/fan-in and J6), **Portability Beta** (Codex, all supported OSes, JetBrains/import), then **v1 GA** only after all `CORE-I1`…`CORE-I22` / `CORE-S1`…`CORE-S14` engineering gates and the pinned benchmark's applicable comparative gates. Earlier labels make no GA or “best” claim.

### 22.1 Path ownership

- Codex: contracts, core, store, scheduler, runner, integration, review, context, MCP, import, technical ADRs, testkit, fault/security/release evidence.
- Fable: exclusive ownership of the control-room and best-tool benchmark specification files plus independent UX/benchmark review; no shared implementation file without a new exclusive assignment.
- Moe reviewer: read-only review/evidence role until separately authorized; no edits to implementation or either owner's files.
- Yaron: product intent, policy/risk/cost raises, design freeze, privileged waivers, and cutover.

Every handoff names objective/criteria, repository/worktree, base/head SHA, exclusive paths, commands/results, artifact hashes, decisions/assumptions, blockers, and exact next action. No `git add -A`, hidden stash, reset of foreign work, or silent merge.

## 23. Explicit non-goals for v1

- cloud sync, team/remote multi-machine scheduling, high availability, or multi-user RBAC;
- host-level malicious-agent sandboxing;
- automatic semantic merge or conflict-free fan-in claims;
- semantic/vector memory, learned retrieval/ranking, or transcript-as-memory;
- general agent chat, channels, game metrics, global speed/turbo modes;
- Gemini/provider marketplace, ACP, plugin ecosystem, or mobile monitoring;
- VS Code parity before canonical UI/JetBrains stability;
- mutable policy editor in the UI;
- legacy write-back, dual writes, or compatibility with every old MCP tool;
- implicit staging/push/merge or Git-tracked live operational state;
- general `ANY`/`QUORUM` repository-change joins in v1; repository-change fan-in is `ALL_REQUIRED`.

## 24. Design-freeze checklist and Moe review handoff

The design candidate is complete only when its independent review answers every item:

- one authoritative state/identity/lease/budget/integration path;
- draft planning cannot mutate active execution authority; release/resume has a legal non-overlap path;
- graph/dependency/input hashes, recursive authority, impact, adoption, and supersession are deterministic;
- every hard edge proves its minimum typed contract; epic containment/resource waits cannot serialize work;
- predecessor artifacts materialize once into exact consumer inputs and once at fan-in;
- blocker invalidation, ready frontier, project-wide capacity, fairness/aging, and avoidable-idle bounds are executable;
- write fan-out refusal and all-required fan-in are unambiguous;
- budget source, coverage, quarantine, and hard enforcement cannot call unknown zero;
- review independence/calibration cannot silently self-approve;
- effect activation/cancel and duplicate delivery have explicit linearization/idempotency boundaries without claiming physical DB/OS atomicity;
- intact-store crash recovery and RPO-bound disaster restore are distinct and favor honest hold/unknown over guessed liveness;
- every numeric bar has a boundary, load, oracle, and evidence record;
- v1/non-goals and Codex/Fable/Moe/Yaron ownership do not overlap;
- no implementation or scaffold is implied by accepting a review assignment.

Give the independent Moe reviewer this exact instruction after this file is present:

```text
Read these files completely:
D:\projexts\moes\docs\plans\2026-08-05-moe-rebuild-design.md
D:\projexts\moes\docs\plans\2026-08-05-moe-rebuild-charter.md
D:\projexts\moes\docs\plans\2026-08-05-moe-rebuild-fable-review.md
D:\projexts\moes\docs\plans\2026-08-05-moe-v1-control-room-spec.md

If this independently assigned file exists by review time, read it completely as measurement/product input, not as co-equal backend authority:
D:\projexts\moes\docs\plans\2026-08-05-moe-best-tool-benchmark-spec.md

Perform a read-only adversarial design review. The authoritative target is the rebuild-design file. Check anti-blocking dependency proof, interface-first input materialization, blocker invalidation, frontier/work-conserving fairness, graph/fan-out/fan-in, immutable planning/supersession, identity/effect activation, budget truth, integration provenance, reviewer independence/calibration, dead-end context, storage/outbox/disaster recovery, protocol parity, threat boundary, migration, benchmarks, and ownership. Try to construct counterexamples that violate `CORE-I1`…`CORE-I22`, confuse `CORE-*` with `BENCH-*`, or make a release/claim bar unfalsifiable.

Do not implement anything. Do not edit legacy code, .moe, Git state, or any source document. Write exactly one file:
D:\projexts\moes\docs\plans\2026-08-05-moe-rebuild-moe-review.md

Classify findings BLOCKER, MAJOR, MINOR, or NOTE. Each non-note finding must cite exact design lines, give a concrete failing sequence, name the violated invariant, and propose the smallest contract-level correction. End with FREEZE_READY or NOT_FREEZE_READY, the exact output path, SHA-256, and confirmation that no other file/Git state changed. Stop after that review.
```

After a `FREEZE_READY` review (or documented resolution of every blocker/major) Yaron may authorize the new repository. Until then:

- Fable control-room specification: **COMPLETED; technical follow-up required only after freeze in its exclusive file**;
- Fable best-tool benchmark specification: **ASSIGNED in its exclusive file; no implementation authority**;
- Moe independent review: **READY when this file is handed over**;
- `D:\projexts\moe-next` scaffold: **HOLD**;
- implementation: **HOLD**;
- legacy edits/migration: **CLOSED**.

## 25. Primary references

The full dated competitor/pattern matrix is retained in Fable's review. Load-bearing platform references for this design are:

- [MCP standard transports](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports)
- [MCP authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)
- [Official MCP TypeScript SDK status](https://github.com/modelcontextprotocol/typescript-sdk)
- [Node.js release status](https://nodejs.org/en/about/previous-releases)
- [Node.js 24 SQLite API status](https://nodejs.org/download/release/latest-v24.x/docs/api/sqlite.html)
- [SQLite transactions](https://www.sqlite.org/lang_transaction.html)
- [SQLite WAL and WAL-reset fix](https://www.sqlite.org/wal.html)
- [Anthropic multi-agent orchestrator-worker lessons](https://www.anthropic.com/engineering/multi-agent-research-system)
- [Anthropic long-running workflow lessons](https://www.anthropic.com/research/long-running-Claude)
- [Dask task-graph ordering and parallelism policy](https://docs.dask.org/en/stable/order.html)
- [Apache Airflow deferrable work frees idle worker capacity](https://airflow.apache.org/docs/apache-airflow/stable/authoring-and-scheduling/deferring.html)
- [Ninja explicit, implicit, and order-only dependency semantics](https://ninja-build.org/manual.html)
- [OpenAI agent orchestration patterns](https://openai.github.io/openai-agents-python/multi_agent/)
- [LangGraph graph API](https://docs.langchain.com/oss/javascript/langgraph/graph-api)
- [JetBrains JCEF support/fallback](https://plugins.jetbrains.com/docs/intellij/embedded-browser-jcef.html)
- [Gemini CLI headless structured output](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/headless.md)

---

**Freeze decision:** this document recommends `GO` for independent Moe review and the separate Fable control-room specification, and `HOLD` for repository creation or implementation until Yaron accepts the reviewed design.
