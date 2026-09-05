# Moe Rebuild Charter and Master Plan

**Goal:** Recreate Moe as the best local-first control plane for turning a human engineering goal into graph-scheduled, multi-agent, independently verified repository changes.

**Architecture:** Build a new modular monolith beside legacy Moe. A transactional core owns an immutable/revisioned work graph, fenced agent leases, policy decisions, evidence, and an atomic audit outbox; MCP, the runner, the web control room, and IDE integrations are adapters over the same command/query contracts.

**Proposed stack:** TypeScript on Node.js 24 LTS, SQLite with a patched engine version and transactional outbox, official stable MCP TypeScript SDK, React-based local control room, thin JetBrains and VS Code adapters, pnpm workspace, Vitest plus property/fault tests, and Playwright for user journeys.

---

## Status and start gates

- Charter version: `1`
- Legacy evidence baseline: `454a6012e955e5d9d37f050330c4a58111be23f4`
- Fable start gate: **READY**
- New-repository scaffold gate: **HOLD until Fable review and the product decisions in this charter are accepted by Yaron**
- Legacy code-edit gate: **CLOSED**; legacy Moe is evidence and an import source, not the rewrite base

Fable should start from this file and write only:

`docs/plans/2026-08-05-moe-rebuild-fable-review.md`

No implementation begins merely because the Fable start gate is ready.

## The product thesis

Moe is not primarily a Kanban board, a chat room, or a collection of launcher scripts. Moe is a local, auditable workflow control plane:

> A human defines an engineering outcome. Moe turns it into an approved work graph, safely schedules disposable agents in isolated workspaces, rejects stale or unauthorized actions, collects daemon-issued evidence, integrates results, and shows what is known, reported, verified, and approved.

The five promises are:

1. **One visible truth:** every lifecycle, ownership, approval, and evidence change is transactionally recorded.
2. **Safe parallelism:** a goal can fan out to multiple agents only through a validated graph revision with bounded scope and budget.
3. **Fenced authority:** a stale, restarted, or replaced session cannot mutate a node.
4. **Proof before completion:** `DONE` means repository-bound evidence and the required independent review exist, not that an agent said a command passed.
5. **Human control:** high-impact graph changes, policy changes, force revocations, and acceptance decisions remain inspectable and policy-gated.

## Why this is a rebuild

The current implementation contains valuable behavioral lessons, but its correctness model cannot be repaired cleanly by adding more flags and sweeps:

- Runtime truth is split across per-entity JSON files. One file write is atomic, but a task, worker, resource, and audit event cannot commit together.
- Ownership is mirrored in `Task.assignedWorkerId` and `Worker.currentTaskId`; crash boundaries can split those pointers.
- Ownership checks accept missing identity in legacy paths, while plugin and MCP WebSocket endpoints do not authenticate the caller.
- A single re-entrant process mutex serializes most tools, while blocking tools, timers, and waiter registries use exceptions that have already produced race repairs.
- The audit log is best-effort and may drop an event after the state mutation succeeds.
- Lifecycle rules and protocol types are hand-copied across daemon, JetBrains, VS Code, hooks, and launchers and already disagree.
- The current project has 257 tasks and no active task, yet 24 epics remain `ACTIVE` or `PLANNED`; redundant mutable projections have drifted.
- The current daemon baseline is not fully green: the full run produced 899 passing tests and one repeatable failing PowerShell claim-hook test.
- Delivery logic is embedded in two large platform scripts and both contain broad `git add -A` staging paths.

We preserve the hard-won scenarios. We do not preserve their implementation.

## What we preserve

- Plan-before-code with an explicit human approval boundary.
- Separate planner, executor, reviewer, and supervisor responsibilities.
- Read-before-act context, step progress, handoffs, re-planning, and bounded rejection loops.
- No ownership loss based only on silence; long tests are not proof of death.
- Explicit blockers and shared-resource queues.
- Fresh agent sessions, protected branches, isolated workspaces, and resumability.
- MCP as a first-class integration surface.
- Exact history and honest `UNKNOWN` / `NEEDS_RECONCILIATION` outcomes.
- Regression scenarios encoded by legacy incident commits, including `3d2cb16`, `3563791`, `b30fb6f`, `28a6588`, `53271ca`, and `1aa1546`.

## What we deliberately drop from the new core

- Per-entity `.moe/*.json` files as the live database.
- Dual task/worker ownership pointers and caller-selected worker identity.
- `replaceExisting`, unrestricted force actions, and missing-identity fail-open behavior.
- Process-local correctness state, a fleet-wide mutation mutex, and tool-name timeout exceptions.
- `BLOCKED`, `needsHumanReview`, and archive as overloaded lifecycle statuses.
- Self-attested command evidence and mtime/size-only workspace signatures.
- Launcher-owned broad staging, committing, and pushing.
- General chat, game-like metrics, rail proposals, `SPEED`/`TURBO`, cloud sync, and full multi-IDE parity in the first release.

Structured node comments, handoffs, decisions, and alerts remain in v1; free-form agent chat can return later if evidence shows it improves outcomes.

## Graph-native execution model

The graph is a product primitive, not a visualization layered over tasks.

```text
Goal / root work item
        |
        v
  Plan graph revision
        |
        +-------------------+
        |                   |
        v                   v
  Node A: backend      Node B: UI         independent worktrees
        |                   |
        +---------+---------+
                  |
                  v
          Node C: integrate
                  |
                  v
          Node D: verify
                  |
                  v
          Node E: independent review
```

### Core graph records

- `Goal`: the human outcome, success measures, risk class, total budget, and root graph revision.
- `WorkNode`: a bounded unit with objective, acceptance criteria, constraints, capability profile, write scope, resource needs, budget, and join policy.
- `WorkEdge`: a typed dependency. Execution-order edges form a DAG.
- `GraphRevision`: an immutable, hashed set of nodes and edges approved as a unit.
- `ExpansionProposal`: a node's request to replace itself with or attach a child subgraph.
- `ExecutionAttempt`: one try by one leased session against one node and graph revision.
- `Artifact`: a typed output passed between nodes without using chat as the workflow bus.

### Dynamic spawning

A Moe node can create work for multiple agents, but an agent never starts unmanaged child processes directly.

1. The owning agent calls `graph.propose_expansion` with child nodes, dependencies, budgets, capabilities, file scopes, and a join node.
2. The core validates acyclicity, scope containment, budget containment, policy, maximum depth, maximum fan-out, and write collisions.
3. Policy either accepts the graph revision, requests human approval, or rejects it with stable reasons.
4. The scheduler atomically leases every ready child to eligible sessions up to project and goal concurrency limits.
5. Each child runs in its own worktree or sandbox. Read scopes may overlap; write scopes are disjoint by default.
6. Overlapping writes force serialization or a dedicated integration node; agents never concurrently edit one shared checkout.
7. The parent becomes satisfied only when its join policy and required evidence are satisfied.

Default v1 safety limits are four concurrent agents per goal, graph depth three, twelve children per expansion, and no unapproved budget increase. These are policy values, not hard-coded scheduler assumptions.

### Graph rules

- Execution-order edges are acyclic. Retries and critique loops create new attempts or revisions, not graph cycles.
- A node is schedulable only when all hard dependencies are accepted, holds are clear, resources are available, and policy allows its capability profile.
- Parent completion is derived from children and join policy; it is never manually toggled.
- Graph edits are immutable revisions. Approval binds to an exact graph hash and becomes invalid if that revision changes.
- Every expansion inherits a remaining budget envelope; children cannot mint cost, time, tokens, privileges, or write scope.
- The scheduler may keep a node single-agent. Parallelism is selected for independent work, not used as a vanity metric.
- Investigation, adversarial review, and comparison nodes may be read-only and run in parallel against the same exact snapshot.
- Integration and final review use independent leases and can require a different principal from the builders.

This matches current practice without treating it as universal proof: orchestrator-worker systems and parallel tool use are effective for decomposable work, while sequential ownership remains preferable for tightly causal debugging.

## Domain model and lifecycle

Durable intent, execution, and presentation are separate.

### Durable records

- `Project`
- `Goal`
- `GraphRevision`, `WorkNode`, `WorkEdge`, `ExpansionProposal`
- `PlanRevision`, `PlanStep`, `ApprovalDecision`
- `Principal`, `AgentProfile`, `Session`
- `AssignmentLease`, `WorkspaceLease`, `ResourceLease`
- `ExecutionAttempt`, `StepRun`
- `EvidenceRun`, `ArtifactRef`
- `ReviewRound`, `ReviewFinding`
- `Blocker`, `Handoff`, `DecisionNote`
- `PolicyRevision`
- `DomainEvent`, `OutboxMessage`

### Node phase

```text
DRAFT -> READY -> PLANNING -> PLAN_REVIEW -> EXECUTION_READY
      -> EXECUTING -> WORK_REVIEW -> ACCEPTED
```

`CANCELLED` is terminal. Reopening accepted work creates a linked revision cycle rather than mutating old accepted history.

Blocking is orthogonal. A node remains, for example, `EXECUTING` while its scheduler projection reports `held=true` and lists its unresolved blockers. Archiving is presentation metadata.

### Truth classes

Every important fact shown in the UI carries one of these origins:

- `OBSERVED`: captured directly by Moe or the operating system.
- `AGENT_REPORTED`: asserted by an agent and not independently verified.
- `DAEMON_VERIFIED`: produced by Moe's runner with a signed/hash-bound receipt.
- `HUMAN_APPROVED`: explicitly accepted by an authenticated human.
- `UNKNOWN`: evidence is absent, corrupt, stale, or irreconcilable.

## Ownership, identity, and leases

- The daemon issues principal and session credentials. No mutation accepts an omitted or free-form identity.
- A claim creates one canonical lease row with an opaque token and monotonically increasing fencing epoch.
- Every leased mutation supplies session credential, lease token, epoch, command ID, and expected aggregate version.
- Claim, release, phase change, event append, projection update, and notification enqueue commit in one database transaction.
- A successor lease increments the epoch. Any command from an older epoch is rejected even if the old process is alive.
- Heartbeats renew session presence; they do not independently prove or revoke authority.
- Expiry first marks a lease `SUSPECT`; policy can wait, request human confirmation, or revoke. Silence alone never authorizes a destructive takeover.
- Force revocation is human-privileged, reason-required, scope-limited, and audited.
- Resource leases also carry fencing epochs. An external resource adapter must consume the epoch when the resource can enforce fencing.
- Planner, executor, integrator, and reviewer leases are distinct; policy may require actor independence.

## Persistence and recovery

Use SQLite as a local transactional store behind a storage interface. Use a patched SQLite engine version at or above the fix for the 2026 WAL-reset issue before enabling multi-connection WAL. The driver choice is frozen only after a Windows/Linux/macOS packaging and fault-injection spike.

Every command transaction performs all three actions atomically:

1. append the domain event;
2. update normalized projections;
3. append the notification/outbox record.

Events include event ID, aggregate ID and sequence, schema version, command ID, actor/session, correlation and causation IDs, lease ID and epoch, graph revision hash, timestamp, and payload.

Only declarative, Git-friendly configuration and policy live in the repository. Operational state lives under the OS application-data directory, keyed by a repository project ID. Export is explicit, content-hashed JSONL plus a manifest; a live database is never committed to Git.

Recovery requirements:

- startup integrity check and schema migration in a transaction;
- idempotent command replay by unique `commandId`;
- projection rebuild and outbox replay;
- automatic backup before migration;
- quarantine with `NEEDS_RECONCILIATION` instead of silently skipping corrupt records;
- a doctor command that distinguishes health, degraded operation, and unknown truth.

## Protocol and adapters

There is one generated command/query contract for every client. The web UI and IDE plugins have no privileged alternate mutation path.

### Transport

- Use the official stable MCP TypeScript SDK generation available at implementation freeze; do not build on a pre-alpha SDK line.
- Implement standard MCP stdio for locally spawned clients and standard Streamable HTTP for long-lived clients.
- Keep any stdio bridge stateless and generated from the same SDK/contracts; do not invent a custom MCP-over-WebSocket dialect.
- Use authenticated HTTP commands/queries plus a cursored event stream for the control room.
- Loopback is the default bind. Non-loopback access requires explicit enablement, authenticated sessions, host/origin validation, and transport security.

### Initial command surface

- `session.open`, `session.renew`, `session.close`
- `goal.create`, `goal.get`, `goal.list`
- `graph.get`, `graph.propose`, `graph.approve`, `graph.propose_expansion`
- `work.claim`, `work.renew`, `work.release`, `work.get_context`
- `plan.propose`, `approval.decide`
- `step.start`, `step.finish`
- `blocker.open`, `blocker.resolve`
- `resource.acquire`, `resource.renew`, `resource.release`
- `evidence.run`, `evidence.attach`
- `review.submit`
- `events.read`, `events.wait`

Each mutation uses a shared envelope and returns data, new aggregate version, emitted event IDs, and `nextAllowedCommands`. Errors have stable code, retryability, details, and recovery actions.

## Runner and repository safety

The runner is one typed cross-platform service with provider adapters for Claude, Codex, Gemini, and future agents. Platform differences belong in small process/path adapters, not parallel 2,000-line orchestration scripts.

- Every executable node receives an isolated worktree/sandbox, exact base SHA, scoped credentials, context-package digest, and lease.
- The runner records process identity independently of model tool calls.
- Git attribution uses explicit changed paths and exact before/after tree IDs; never `git add -A` across a shared checkout.
- Agents do not push or merge implicitly. Delivery is an explicit, policy-controlled integration command.
- The approved verification recipe is run by Moe, not trusted from agent input.
- An evidence receipt binds command argv, cwd, environment fingerprint, start/end time, exit status, output digest, artifact digests, base/head commit, and dirty-tree digest.
- A node cannot reach `WORK_REVIEW` without the required evidence receipts.
- Reviewer context contains the exact graph, plan, diff, receipts, acceptance criteria, and prior findings.

## Product surface

The canonical v1 UI is a local web control room because a graph, timeline, evidence viewer, and parallel-agent topology should have one implementation. The JetBrains adapter starts/discovers Moe and embeds that UI when supported, with an external-browser fallback. VS Code becomes a thin adapter after the canonical UI is stable.

The primary screen must show, without opening logs:

- the goal graph and critical path;
- ready, running, held, suspect, failed, reviewing, and accepted nodes;
- which principal owns each lease and when it expires;
- child-agent fan-out, join progress, budgets, and resource queues;
- exact plan/graph revision and approval state;
- workspace branch, base/head SHA, write scope, and collision warnings;
- evidence origin and review status;
- last command/error and legal next actions.

## Fresh repository boundary

After the scaffold gate opens, create a new adjacent repository at `D:\projexts\moe-next`. Do not rewrite the current repository in place.

Proposed new layout:

```text
moe-next/
  apps/
    daemon/                 # composition root, health, lifecycle
    control-room/           # canonical graph UI
  packages/
    contracts/              # schemas, generated clients, stable errors
    core/                   # pure graph/lifecycle/policy reducers
    store/                  # SQLite migrations, repositories, outbox
    scheduler/              # readiness, leases, fan-out/fan-in, budgets
    runner/                 # worktrees, processes, verification receipts
    mcp/                    # official SDK adapter and stdio entrypoint
    testkit/                # scenario builders, fake clock/process/store
  adapters/
    jetbrains/
    vscode/
  docs/
    adr/
    plans/
    product/
  tests/
    contract/
    fault/
    integration/
    e2e/
```

The old repository remains readable and runnable for comparison. No dual writes are allowed.

## Delivery phases and gates

Each phase gets its own bite-sized TDD implementation plan before code starts. No phase may hide unfinished correctness behind a later UI phase.

### Phase 0: Product challenge and design freeze

Owners: Fable for independent research; Codex for integration; Yaron for decisions.

Deliverables:

- Fable review at the exact path named in this charter.
- Competitive and current-pattern comparison based on primary sources.
- Five benchmark user journeys and graph UX sketches.
- Final product/non-goal decision record.
- Accepted architecture decision records for graph, storage, identity, evidence, UI, and legacy import.

Exit: Yaron accepts the decision record and authorizes `D:\projexts\moe-next` creation.

### Phase 1: Executable behavioral specification

Owner: Codex.

Create golden scenario tests before production code:

- one-agent plan/approve/build/verify/review;
- dynamic fan-out of three independent nodes and a fan-in integration node;
- overlapping write scopes that serialize instead of racing;
- child failure, retry, and budget exhaustion;
- stale-agent command after reassignment;
- daemon crash between claim and event delivery;
- long silent build without ownership theft;
- resource wait, renewal, expiry, revocation, and fencing;
- plan edit invalidating approval;
- independent reviewer rejection and re-plan;
- corrupt legacy import producing `NEEDS_RECONCILIATION`.

Exit: scenarios fail for the documented missing implementation reasons and contain no legacy imports.

### Phase 2: Core, contracts, and transactional store

Owner: Codex.

Build pure domain reducers, generated schemas, SQLite migrations, command idempotency, aggregate versions, atomic events/projections/outbox, backup, integrity, and projection rebuild.

Exit: domain/property tests and crash-at-every-write-boundary store tests pass.

### Phase 3: Identity, policy, and fenced leases

Owner: Codex; Fable adversarially reviews the UX and recovery messages only.

Build authenticated sessions, RBAC/capabilities, assignment/workspace/resource leases, fencing epochs, renewal, suspect state, scoped human revocation, and policy evaluation.

Exit: randomized stale-session and restart schedules produce zero unauthorized accepted mutations.

### Phase 4: Graph scheduler vertical slice

Owner: Codex.

Build graph revisions, cycle/scope/budget validation, readiness projection, atomic claims, dynamic expansion, fan-out/fan-in, collision handling, join policies, and deterministic scheduler tests.

Exit: one goal safely runs three child agents in parallel, integrates them, verifies them, and reaches independent review with a complete event timeline.

### Phase 5: Runner and evidence

Owner: Codex for runner/contracts; Fable may implement provider-neutral UX copy in separately owned files after assignment.

Build isolated worktrees, provider adapters, process/session renewal, context packages, explicit-path Git attribution, verifier execution, artifact storage, receipts, and recovery.

Exit: killing an agent, runner, or daemon at every tested boundary cannot create duplicate ownership, lose an accepted event, stage another node's files, or falsely mark evidence verified.

### Phase 6: Canonical control room

Owner: Fable for product/interaction specification; implementation ownership is assigned by directory before work begins. Codex owns API integration and acceptance tests.

Build graph, node detail, approval, evidence, event timeline, leases/resources, recovery, and settings views against generated contracts.

Exit: all five benchmark journeys pass Playwright tests and every displayed truth class is visible.

### Phase 7: MCP, JetBrains, and legacy import

Owner: Codex for MCP/import; Fable for JetBrains interaction review.

Build official-SDK MCP transports, thin JetBrains adapter, read-only legacy importer, manifests/hashes, reconciliation report, and shadow comparison.

Exit: a copied real project imports with exact counts and hashes; ambiguous assignments are never activated; legacy remains rollback-readable.

### Phase 8: Hardening, comparative benchmark, and cutover

Owners: Codex runs evidence; Fable independently reviews product quality; Yaron authorizes cutover.

Required gates:

```powershell
pnpm lint
pnpm typecheck
pnpm test
pnpm test:contract
pnpm test:fault
pnpm test:integration
pnpm test:e2e
```

Every command must exit `0`. The release record also requires supported-OS packaging results, dependency/SBOM scan, storage integrity and restore drill, security threat-model review, and the benchmark report below.

Exit: explicit human GO. Legacy writes then freeze; migration runs once; no dual-write period follows.

## “Best tool” benchmark

“Best” is a measured claim, not release language. Compare the rebuilt Moe against legacy Moe and current public agent-orchestration workflows on a fixed, versioned suite:

1. one small causal bug that should stay single-agent;
2. one three-way decomposable feature;
3. one feature with intentional file overlap and an integration conflict;
4. one agent crash and one daemon crash;
5. one plan rejection, one implementation rejection, and one requirements-level re-plan;
6. one exclusive-resource queue;
7. one malicious stale/spoofed client;
8. one dynamic graph expansion that tries to exceed budget and scope.

Initial release bars:

- zero invariant violations across 10,000 randomized command/crash schedules;
- zero accepted stale-epoch mutations;
- zero lost committed audit events after restart/replay;
- 100% of accepted nodes have required daemon-verified receipts;
- no foreign-file staging in attribution tests;
- graph and timeline updates visible locally within 500 ms at p95;
- at least 1.8x median wall-clock speedup on the decomposable benchmark with no acceptance-rate regression;
- no more than 10% wall-clock overhead on the deliberately single-agent benchmark;
- every fault produces a stable error and an actionable recovery path.

Cost and token usage are reported beside speed; speed gained only by unbounded spend does not pass.

## Team ownership

### Codex — technical lead and integrator

Codex owns:

- this charter and all accepted architecture decisions;
- legacy archaeology and exact behavioral-oracle tests;
- the fresh repository scaffold;
- core domain, storage, scheduler, identity, leases, policy, protocol, runner, evidence, migration, and integration;
- path ownership assignments, merge order, end-to-end tests, fault testing, and release evidence;
- final truth: no success claim without current command output and exact commit provenance.

Codex must not silently adopt Fable recommendations. It records acceptance, rejection, or modification with reasons.

### Claude/Fable — independent product architect and challenger

Fable's first assignment is read-only research plus one owned document. Fable owns:

- current online comparison of graph and multi-agent orchestration patterns, citing primary sources;
- product positioning and the smallest experience that can honestly be called better;
- graph-control-room information architecture and five user journeys;
- risks of agent fan-out: runaway cost, duplicated work, shared-file collisions, context fragmentation, shallow review, and confusing human control;
- challenge of this charter's recommended defaults and benchmark bars;
- an explicit `KEEP`, `CHANGE`, or `REJECT` verdict for each product decision below.

Fable must not edit legacy code, `.moe/`, this charter, Git state, or Codex-owned files. Its only initial output is:

`docs/plans/2026-08-05-moe-rebuild-fable-review.md`

After design freeze, Fable may receive a separately owned UI or documentation directory. No shared-file co-authoring is allowed.

### Yaron — product owner

Yaron owns product intent, risk tolerance, cost ceilings, approval policy, the design-freeze decision, and cutover authorization.

## Collaboration and handoff protocol

Every handoff includes:

- objective and acceptance criteria;
- repository, branch/worktree, base SHA, and head SHA;
- exclusively owned paths;
- commands run and complete results;
- artifacts and evidence hashes;
- decisions made and assumptions remaining;
- blockers and exact next action.

Rules:

- one writer owns a path at a time;
- all other agents review from a commit or exact snapshot;
- no `git add -A`, no shared dirty worktree, no hidden stash, no reset of foreign changes;
- graph nodes that can run independently use separate worktrees;
- integration happens in an explicit integration node;
- review is independent from authorship when policy requires it;
- disagreements are written as decision alternatives for Yaron, not resolved by silent implementation drift.

## Product decisions for design freeze

Fable must challenge these recommended defaults; Yaron makes the final call.

1. **Deployment:** local-first, single machine in v1; remote/team service later.
2. **Core shape:** graph-native v1 with bounded dynamic fan-out/fan-in, not a list of tasks.
3. **Primary UI:** one local web control room; JetBrains is the first thin IDE adapter.
4. **State:** transactional database plus hashed exports; no Git-tracked runtime state.
5. **Approval:** manual by default; later automation is policy/risk based, not global `TURBO`.
6. **Memory:** structured handoffs, decisions, artifacts, and scoped notes in v1; semantic retrieval later.
7. **Compatibility:** read-only importer and temporary adapter, not compatibility with every legacy tool.
8. **Git delivery:** explicit integration command; agents never broadly auto-stage/push.
9. **Graph authority:** agents may propose child graphs; Moe validates and schedules them.
10. **Scope boundary:** Moe enforces orchestration authority and workspace isolation; host-wide sandbox enforcement is a later defense layer.

## Fable launch prompt

Give Fable this exact instruction:

```text
Read D:\projexts\moes\docs\plans\2026-08-05-moe-rebuild-charter.md completely.

You are the independent product architect and challenger for a ground-up Moe rebuild. Do not edit legacy code, .moe, Git state, or the charter. Research current graph-based and multi-agent orchestration approaches using primary sources. Challenge whether each proposed capability makes Moe safer, clearer, faster, or merely more complex. Focus especially on a goal spawning multiple parallel agents, dynamic fan-out/fan-in, human control, cost/budget containment, worktree/file collisions, integration, independent review, and the graph UI.

Write exactly one file:
D:\projexts\moes\docs\plans\2026-08-05-moe-rebuild-fable-review.md

The review must contain:
1. a concise competitor/pattern matrix with links and dates;
2. the five most important user journeys and acceptance criteria;
3. a graph/control-room information architecture;
4. failure modes and guardrails for multi-agent spawning;
5. KEEP, CHANGE, or REJECT for each of the ten product decisions;
6. changes to the proposed benchmark and release bars;
7. a final recommended v1 scope and explicit non-goals.

Do not start implementation. End after writing the review and report the exact file path.
```

## References used for this charter

- [MCP standard transports](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports)
- [MCP authorization model](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)
- [Official MCP TypeScript SDK status](https://github.com/modelcontextprotocol/typescript-sdk)
- [Node.js release status](https://nodejs.org/en/about/previous-releases)
- [SQLite transactions](https://www.sqlite.org/lang_transaction.html)
- [SQLite WAL and the 2026 WAL-reset fix](https://www.sqlite.org/wal.html)
- [Anthropic multi-agent orchestrator-worker lessons](https://www.anthropic.com/engineering/multi-agent-research-system)
- [Anthropic long-running agent workflow lessons](https://www.anthropic.com/research/long-running-Claude)
- [OpenAI agent orchestration patterns](https://openai.github.io/openai-agents-python/multi_agent/)
- [LangGraph graph concepts](https://docs.langchain.com/oss/javascript/langgraph/graph-api)
- [JetBrains JCEF support and fallback constraint](https://plugins.jetbrains.com/docs/intellij/embedded-browser-jcef.html)
- [VS Code webview guidance](https://code.visualstudio.com/api/ux-guidelines/webviews)

