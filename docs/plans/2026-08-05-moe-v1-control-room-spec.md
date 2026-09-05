# Moe v1 Control Room — Product & Interaction Specification

- **Author:** Fable (`claude-fable-5`), product/interaction architect for Moe v1. Revision 2 (post adversarial review pass).
- **Inputs:** `docs/plans/2026-08-05-moe-rebuild-charter.md` (charter v1) and `docs/plans/2026-08-05-moe-rebuild-fable-review.md` (both read completely). Codex owns the authoritative technical system design separately; this document neither edits nor depends on that file's current content.
- **Accepted premises (per assignment):** graph-native data model with linear execution by default; board is the default projection; write fan-out must earn approval through disjoint write scopes, machine-checkable child oracles, and budget fit; fan-out cap 6 (policy-raisable with audited reason); a first-class integrator owns every fan-in; risk-tier automation exists in v1 but is per-project opt-in and default-off; the attempt/dead-end journal exists in v1.
- **Scope discipline:** this is a UI/interaction specification only. It contains no implementation code, no mock APIs, no backend schemas. Where it needs a backend behavior the charter and review do not define, it records a dependency (§13) or a conflict requiring a technical ruling (§14) instead of inventing one.

---

## 1. Foundations

### 1.1 Design principles

1. **Board first, graph on demand.** The default projection of a goal is a board. The graph canvas is one toggle away and is the required surface for fan-out topology, join progress, critical path, and supersession moments — not for daily monitoring.
2. **Every fact wears its truth class.** Any datum presented as a fact about work (status, test result, cost, ownership, completion claims, external-effect timestamps) renders inside a fact wrapper (§1.4) carrying one of the five truth-class chips (§3). Facts arrive classified by the daemon; the UI never upgrades, infers, or computes a truth class.
3. **Actions come only from `nextAllowedCommands`.** Every enabled control corresponds to a command the daemon listed as legal for the current aggregate version. The UI hardcodes no lifecycle rules (the legacy `VALID_TRANSITIONS` duplication bug class must be structurally impossible). A visible-but-disabled control always states which precondition fails, using the daemon's stable reason code (§8.1).
4. **Approvals are diffs, decisions are one glance.** Nothing is approved from a summary alone; every approval renders the thing being approved (plan, subgraph, delta, diff) plus the machine-checked preconditions as verified facts. One expansion costs at most one approval.
5. **No optimistic mutations.** The UI shows pending state until the daemon confirms; it never renders a state transition the daemon has not emitted.
6. **Honesty over reassurance.** `UNKNOWN` renders as prominently as success. Degraded modes (event lag, disconnection, doctor-offline) are labeled, never masked.

### 1.2 Vocabulary

Node phases (charter): `DRAFT → READY → PLANNING → PLAN_REVIEW → EXECUTION_READY → EXECUTING → WORK_REVIEW → ACCEPTED`; `CANCELLED` terminal.

Orthogonal state enumerations used by this spec — **expected vocabulary, pending ratification in the technical design (§13-D11)**; only `SUSPECT` and the supersession dispositions are defined by the input documents:

- Lease: `ACTIVE`, `SUSPECT`, `SUPERSEDED`, `RELEASED`.
- Approval: `PENDING`, `APPROVED`, `AUTO_APPROVED`, `REJECTED`, `INVALIDATED`.
- Integration: `WAITING`, `INTEGRATING`, `FINDINGS_OPEN`, `INTEGRATED`.
- Supersession disposition (review, Decision 9a/I8): `REBOUND`, `TO_SAFE_BOUNDARY`, `CANCELLED_BY_SUPERSESSION`.
- Quarantine: `NEEDS_RECONCILIATION`.

Truth classes: `OBSERVED`, `AGENT_REPORTED`, `DAEMON_VERIFIED`, `HUMAN_APPROVED`, `UNKNOWN`.

Two distinct silence datums (never conflated — §13-D13 for field sources):

- **Activity silence** — time since this session's last emitted event. Neutral information; shown on cards as `quiet 41m`. Never implies suspicion.
- **Renewal silence** — time since last lease renewal. Drives `SUSPECT` per policy grace. Shown only in lease contexts.

A **human action** (for the J1 ≤ 3 bar and all counts) is a committed decision command sent to the daemon (create, approve, reject, accept, revoke, resolve). Navigation, inspection, provenance, and filtering are free.

### 1.3 Application shell, layout, and routes

Desktop-first, minimum comfortable width 1200 px, functional to 960 px, narrow mode below 960 px (§4.16).

```text
┌──────┬──────────────────────────────────────────────┬───────────────┐
│ Nav  │  Context bar (goal name · projection tabs ·  │  Inspector    │
│ rail │  budget meter · banner slot)                 │  (right rail, │
│      ├──────────────────────────────────────────────┤  collapsible) │
│ 56px │  Main surface (board / graph / timeline /    │  360-440px    │
│      │  inbox / fleet / …)                          │               │
│      ├──────────────────────────────────────────────┤               │
│      │  Status strip: event cursor · daemon health  │               │
└──────┴──────────────────────────────────────────────┴───────────────┘
```

Nav rail (top→bottom): Goals, Approvals (badge), Runs/Leases, Resources, Health, Policy. Timeline is a goal projection and a drill-down everywhere, not a rail item. The status strip is `cr.shell.statusstrip` (event cursor + daemon health; lag states per §8.6).

Routes (deep-linkable, stable): `/goals`, `/goal/{id}/board|graph|timeline`, `/goal/{id}/node/{nodeId}` (inspector), `/goal/{id}/node/{nodeId}/attempt/{attemptId}` (attempt detail, §10.5), `/approvals`, `/approvals/{decisionId}`, `/runs`, `/resources`, `/evidence/{receiptId}`, `/health`, `/policy`.

### 1.4 Test-ID grammar and conventions

`data-testid="cr.<surface>.<component>[.<qualifier>]"` — stable, human-readable, never derived from display text.

- Surfaces: `goals`, `board`, `graph`, `timeline`, `inspector`, `approvals`, `review`, `runs`, `resources`, `evidence`, `health`, `policy`, `shell`.
- **Command controls:** always `cr.action.<commandName>` with `.` → `-` (e.g. `cr.action.approval-decide.approve`, `cr.action.graph-approve`, `cr.action.blocker-open`). Generated from the `nextAllowedCommands` entry so tests assert legality and presence with one selector family. Controls whose command name is a ⟨TD⟩ placeholder are listed in §13-D1 and their IDs are provisional until the name is ratified.
- **Fact wrapper (makes the truth-class bar testable):** every chip-bearing fact renders as an element `data-testid="cr.fact.<factKind>"` with attribute `data-fact-class="<truth-class>"`. Bar 3 (§12) asserts: every `cr.fact.*` element has a `cr.chip.*` descendant, and no fact-kind renders outside a `cr.fact.*` wrapper (fact kinds enumerated per surface in §2).
- Truth-class chips: `cr.chip.<class>`; opened provenance popover: `cr.chip.provenance`.
- List rows: `cr.<surface>.row.{entityId}`. Banners: `cr.banner.<kind>` — **every `cr.banner.*` is an ARIA live region (§11.1).**
- Other declared IDs are introduced in their owning sections and collected implicitly by the grammar; §12 asserts only IDs declared somewhere in §§1–11.

**Copy-template convention:** in all §8 final copy, `{braced}` tokens are interpolation slots (identifiers, counts, durations, event numbers, epochs, policy rules); everything outside braces is literal, final English.

---

## 2. Information architecture

Template per surface: **Purpose · Data · Entry · Components.**

### 2.1 Goals home (`/goals`)

- **Purpose:** answer "what needs me, what is moving, what is wrong" in one screen.
- **Data:** goal list; per goal: phase distribution (terminated nodes excluded — §5.1 rule), budget meter with basis note (§8.3), pending-approval count, held/SUSPECT/reconciliation badges, last-event age, completion state (§5.3).
- **Entry:** app start; nav rail; goal links from Approvals/Runs/Health rows.
- **Components:** `cr.goals.row.{goalId}`, `cr.goals.create`, `cr.goals.form` (§4.2), `cr.goals.filter`, badges `cr.goals.badge.approvals|held|suspect|reconciliation`. Fact kinds wrapped per §1.4: budget, completion, last-event age.

### 2.2 Goal board (`/goal/{id}/board`) — default projection

- **Purpose:** daily monitoring with legacy board muscle memory.
- **Data:** nodes of the current revision, folded into five display columns (mapping below); join summary; card facts.
- **Entry:** default target of every goal link; projection tabs.
- **Columns (display mapping, not lifecycle — ratify per §14-C3):** **Plan** (DRAFT, READY, PLANNING, PLAN_REVIEW — sub-badge shows exact phase), **Ready** (EXECUTION_READY; column auto-collapses when empty — §14-C7), **Executing**, **Review** (WORK_REVIEW), **Accepted**. Terminated nodes (CANCELLED, CANCELLED_BY_SUPERSESSION) appear only under the terminated filter (§5.1 rule, global to the goal view).
- **Card content:** node name; exact phase; owner principal + lease chip; steps/progress; activity-silence timer `cr.board.card.silence.{nodeId}` (§1.2); truth-class chip of most recent claim; held badge + blocker name; SUSPECT badge; disposition badge during supersession.
- **Components:** `cr.board.column.{plan|ready|executing|review|accepted}`, `cr.board.card.{nodeId}`, `cr.board.filter.terminated`, `cr.board.joinstrip`.

### 2.3 Graph (`/goal/{id}/graph`)

- **Purpose:** topology moments — fan-out, joins, critical path, expansions, supersession.
- **Data:** current approved revision (hash abbreviated; full via hover/focus popover), nodes with phase/lease/held state, execution-order edges, join policies, ghost proposals, disposition badges.
- **Entry:** projection tab; "view on graph" links from approval details and circuit-breaker banners.
- **Components:** `cr.graph.canvas`, `cr.graph.listview` (accessible parallel list — §11.1), `cr.graph.node.{nodeId}`, `cr.graph.edge.{edgeId}`, `cr.graph.revision`, `cr.graph.ghost.{proposalId}`, `cr.graph.refusal.{proposalId}`, `cr.graph.criticalpath.toggle`, `cr.graph.disposition.{nodeId}`, `cr.graph.revisiondiff`, `cr.graph.minimap`, `cr.graph.legend`. Terminated nodes render hatched under the same goal-view terminated filter.

### 2.4 Timeline (`/goal/{id}/timeline`)

- **Purpose:** forensic truth — the cursored event stream; the J3/J5 surface.
- **Data:** events in sequence order (actor, aggregate, command ID, lease epoch where relevant); rejected commands as first-class rows (§6.5, §8.2); restart gap markers (§13-D3).
- **Entry:** projection tab; every "open in timeline"/"explain" link (`cr.timeline.jump`).
- **Components:** `cr.timeline.list`, `cr.timeline.row.{eventSeq}`, `cr.timeline.row.restart`, `cr.timeline.filter.{node|actor|type}`, `cr.timeline.cursor`, `cr.timeline.jump`.

### 2.5 Node inspector (right rail; `/goal/{id}/node/{nodeId}`)

- **Purpose:** everything about one node.
- **Data:** identity (objective, acceptance criteria, write scope); phase + legal transitions; lease (principal, epoch, expiry, renewal history, both silence datums); plan revision + approval binding; attempts (outcome, receipts, dead-end journal); findings; artifacts; blockers; reopen-loop counter.
- **Entry:** any card/node click; direct route; rows in Runs and Approvals.
- **Components:** `cr.inspector.section.{identity|phase|lease|plan|attempts|findings|artifacts|blockers}`, `cr.inspector.loopcounter`, `cr.inspector.journal.{attemptId}`, `cr.inspector.receipt.{receiptId}`, `cr.inspector.transcript.{attemptId}` (attempt detail only — §10.5), action buttons per §1.4.

### 2.6 Approvals (`/approvals`, `/approvals/{decisionId}`)

- **Purpose:** the single human decision queue.
- **Data:** pending decisions — plan approvals, expansion approvals, acceptance decisions, revocation confirmations, reconciliation choices, escalation decisions (§6.4) — each with risk tier, age, and its idle-consequence line (§8.10); collapsed "decided by policy" group (opt-in projects) with recorded reasons.
- **Entry:** nav rail (badged); inbox badges on goal rows; direct links from cards.
- **Components:** `cr.approvals.pending`, `cr.approvals.item.{decisionId}`, `cr.approvals.item.escalation`, `cr.approvals.auto`, `cr.approvals.precondition.{scopes|oracles|budget|width}`, `cr.approvals.delta.unchanged`, `cr.banner.invalidated`. Detail wireframes §4.7–§4.9.

### 2.7 Runs / leases (`/runs`)

- **Purpose:** fleet view; SUSPECT floats to top.
- **Data:** every session/principal, its lease, epoch, renewal silence + grace remaining, current node, activity silence.
- **Entry:** nav rail; SUSPECT badges on goal rows and cards.
- **Components:** `cr.runs.row.{sessionId}`, `cr.runs.suspect`, `cr.runs.lease.{leaseId}`, revocation controls (§8.2, §9).

### 2.8 Resources (`/resources`)

- **Purpose:** shared-resource queues.
- **Data:** per resource: holder (task-keyed), waiters in priority order, lease expiry.
- **Entry:** nav rail; blocker rows naming a resource.
- **Components:** `cr.resources.row.{resourceId}`, `cr.resources.queue.{resourceId}`, `cr.action.resource-force-release` (⟨TD⟩ name — §13-D1) with modal `cr.resources.releasemodal` (§9).

### 2.9 Evidence (`/evidence/{receiptId}`)

- **Purpose:** one receipt in full; rerun comparison.
- **Data:** argv, cwd, env fingerprint, start/end, exit, output digest + tail, artifact digests, base/head SHAs, dirty-tree digest.
- **Entry:** receipt links from inspector attempts, approval details, review surface, timeline rows.
- **Components:** `cr.evidence.receipt`, `cr.evidence.recipe`, `cr.action.evidence-rerun`, `cr.evidence.compare`.

### 2.10 Health / doctor (`/health`)

- **Purpose:** integrity, quarantine queue, outbox, versions, doctor-offline report.
- **Data:** integrity status; `NEEDS_RECONCILIATION` rows; outbox applied/emitted; schema + SQLite version (≥ 3.51.3 check); backup status; export status slot (§14-C1).
- **Entry:** nav rail; every lag/degraded banner links here; reconciliation badges.
- **Components:** `cr.health.status`, `cr.health.reconciliation.row.{recordId}`, `cr.health.outbox`, `cr.health.versions`, `cr.health.doctor`.

### 2.11 Policy (`/policy`) — read-only in v1

- **Purpose:** inspectable policy revisions; which revision each pending decision was evaluated under.
- **Data:** approval tiers + opt-in state, fan-out limits (cap 6 + audited raises), budget rules, reviewer/integrator independence rules, revision diffs.
- **Entry:** nav rail; "policy {rev}" links on decisions and auto-approval records.
- **Components:** `cr.policy.revision.{revisionId}`, `cr.policy.diff`, banner: "Policy is edited as a reviewed file change; the control room displays and never edits it."

---

## 3. Truth-class visual system

### 3.1 The five chips

Triple-encoded — glyph, short label, color — surviving monochrome, color-vision deficiency, and screen readers. Color is never the only carrier.

| Class | Glyph (outline shape) | Short label | Color token | Meaning line (tooltip/aria) |
|---|---|---|---|---|
| `OBSERVED` | filled circle ● | `OBS` | neutral slate | "Captured directly by Moe or the OS." |
| `AGENT_REPORTED` | rounded speech-square 💬 | `AGT` | amber | "Asserted by an agent; not independently verified." |
| `DAEMON_VERIFIED` | shield-check ▣ | `VER` | green | "Produced by Moe's runner with a hash-bound receipt." |
| `HUMAN_APPROVED` | person-check ◉ | `HUM` | blue | "Explicitly accepted by an authenticated human." |
| `UNKNOWN` | dashed diamond ◇ | `UNK` | high-contrast magenta + dashed border | "Evidence is absent, corrupt, stale, or irreconcilable." |

Chip = glyph + label, minimum hit target 24 px, `aria-label` = class + meaning line + "press Enter for provenance." `UNKNOWN` is the only chip with a dashed border — the most visually distinct state on any screen, in any palette. Auto-approved decisions use a ◉-with-gear variant of `HUMAN_APPROVED`'s family, labeled `POL`, chip `cr.chip.policy-approved` (§8.8; identity semantics per §14-C6).

### 3.2 Provenance on demand

Every chip is interactive (click / Enter). Popover (`cr.chip.provenance`): source event sequence + ID, actor/session, lease epoch (if leased mutation), timestamp, and a typed link — receipt for `DAEMON_VERIFIED`, decision for `HUMAN_APPROVED`/policy variant, originating report event for `AGENT_REPORTED`, integrity finding for `UNKNOWN`. "Open in timeline" → `cr.timeline.jump`.

### 3.3 Placement rules

- A chip appears wherever a **fact claim** renders; every such claim sits in a `cr.fact.*` wrapper (§1.4).
- Pure UI state and daemon-served structural data (node name, an edge) carry no chip and no wrapper.
- Derived/aggregate figures display the class the **daemon assigned to the aggregate**; the UI never computes one (§14-C4).
- A fact whose class the payload omits renders `UNKNOWN` with provenance "class missing from payload" — never silently defaulted upward.

---

## 4. Wireframes (desktop-first, low-fidelity)

Conventions: `[ ]` button, `▾` menu, `▓░` meter, `⚑` held, `⚠` suspect/attention, chips abbreviated `◇UNK ▣VER ●OBS 💬AGT ◉HUM`. Wireframes may abbreviate copy; **§8 strings are canonical** where they overlap.

### 4.1 Goals home

```text
┌ Goals ──────────────────────────────────────────────── [New goal] ┐
│ filter: [all ▾]  search: [        ]                               │
│ ┌───────────────────────────────────────────────────────────────┐ │
│ │ payments-retry-hardening        ▓▓▓░ 62% ($31 of $50 ▣VER)    │ │
│ │ Plan 1 · Exec 2 · Review 1 · Acc 3      ⚠1 approval  ⚑1 held │ │
│ ├───────────────────────────────────────────────────────────────┤ │
│ │ jetbrains-embed-spike           ▓░░░ 12% (basis: wall-clock ●)│ │
│ │ Plan 1 · Exec 1                          last event 2m ago    │ │
│ ├───────────────────────────────────────────────────────────────┤ │
│ │ import-legacy-moes              ◇UNK 2 records quarantined    │ │
│ │ → Health / reconciliation queue                               │ │
│ └───────────────────────────────────────────────────────────────┘ │
└───────────────────────────────────────────────────────────────────┘
```

### 4.2 Goal creation (`cr.goals.form`)

```text
┌ New goal ─────────────────────────────────────────────────────────┐
│ Outcome (one sentence is enough)                                  │
│ [ Fix the stale-port crash in daemon discovery                ]   │
│ Acceptance criteria (optional, one per line)                      │
│ [ daemon restarts cleanly with port taken                     ]   │
│ Budget envelope   [$ 50   ] (default from policy p-14 — §13-D14)  │
│ Risk class        [normal ▾] (from policy)                        │
│                                    [Cancel]  [Create goal]        │
└───────────────────────────────────────────────────────────────────┘
```

Submit routes to `/goal/{id}/board`. Failure renders inline beneath the form per §11.4 (no toast-only errors). Budget and risk fields prefill from policy defaults and remain editable; later edits to the envelope are an audited decision (command ⟨TD⟩ — §13-D1).

### 4.3 Goal board (default projection) with inspector

```text
┌ payments-retry-hardening   [Board] Graph Timeline   $▓▓▓░ 62% ▣  1 approval ▲ ┐
│ PLAN          READY*      EXECUTING        REVIEW       ACCEPTED │ Node:      │
│ ┌──────────┐             ┌─────────────┐  ┌──────────┐ ┌───────┐ │ api-endpnt │
│ │ docs     │             │ api-endpnt  │  │ ui-panel │ │schema │ │ EXECUTING  │
│ │ PLANNING │             │ lease w-3   │  │ rev r-1  │ │ ▣ ◉   │ │ lease w-3  │
│ │ 💬 plan  │             │ epoch 7     │  │ clean-ctx│ └───────┘ │  epoch 7   │
│ │  drafting│             │ renewed 41s │  └──────────┘           │  exp 09:41 │
│ └──────────┘             │ steps 2/3   │                         │ plan a3f ◉ │
│                          │ quiet 41m ● │                         │ receipts 1▣│
│                          └─────────────┘                         │ journal: 1 │
│ join integrate — waiting 2/3 · critical path: api→integrate      │ [blocker.open]│
└──────────────────────────────────────────────────────────────────┴────────────┘
  *READY drawn for legibility; the column auto-collapses when empty (§2.2).
```

Note the J5-critical pairing: `renewed 41s` (renewal silence ≈ 0) beside `quiet 41m` (activity silence) — a healthy lease on a long silent build.

### 4.4 Graph projection

```text
┌ [Board] [Graph] Timeline          revision a3f9c2… ◉ APPROVED   legend ▾ ┐
│                                                                          │
│   (goal) ──► [api-endpnt EXEC ▓2/3]──┐                                   │
│   (goal) ──► [ui-panel  REVIEW r-1] ─┼──► [integrate ⏳2/3] ─► [verify]  │
│   (goal) ──► [docs      PLANNING]  ──┘         │                  │      │
│              ━━━ critical path ━━━━━━━━━━━━━━━━┷━━━► [review] ─► (accept)│
│                                                                          │
│  ghost (pending approval): [perf-bench]--►[integrate]   [Review proposal]│
└──────────────────────────────────────────────────────────────────────────┘
```

### 4.5 Timeline projection

```text
┌ Board Graph [Timeline]   filter: node[api▾] actor[all▾] type[all▾]      ┐
│ #4819 09:41:02  api-endpnt  step.finish (w-3, epoch 7)        ▣ receipt │
│ #4818 09:40:58  REJECTED: step.finish from w-2 epoch 6 < 7    → explain │
│ #4817 09:39:12  lease renewed w-3 (epoch 7) expires 10:09     ●         │
│ #4815 09:31:44  plan approved rev a3f9c2 by yaron             ◉         │
│ cursor: applied #4819 of #4819 · live                                   │
└─────────────────────────────────────────────────────────────────────────┘
```

### 4.6 Approvals inbox

```text
┌ Approvals (1 pending) ──────────────────────────────────────────────────┐
│ ┌ PENDING ────────────────────────────────────────────────────────────┐ │
│ │ ⚠ Expansion: payments-retry-hardening → 3 children   risk: MEDIUM   │ │
│ │   scopes disjoint ▣ · oracles 3/3 ▣ · budget fits ▣   age 4m        │ │
│ │   if idle: children stay unscheduled                    [Open]      │ │
│ └─────────────────────────────────────────────────────────────────────┘ │
│ ▸ Decided by policy (2) — auto-approved under rev q-3 (project opted in)│
└─────────────────────────────────────────────────────────────────────────┘
```

### 4.7 Approval detail — plan (`/approvals/{decisionId}`, J1's second action)

```text
┌ Approve plan · api-endpnt · revision a3f9c2…                 risk NORMAL ┐
│ Objective: POST /retry endpoint with idempotency-key                     │
│ Write scope: src/api/**                                                  │
│ Oracle: pnpm test:contract → exit 0                       ▣ recipe valid │
│ Steps (4):                                                               │
│  1. contract test for idempotency-key header (red)                       │
│  2. handler + storage of key                                             │
│  3. retry semantics on conflict                                          │
│  4. run oracle; attach receipt                                           │
│ if idle: node waits in PLAN_REVIEW; its lease may lapse to SUSPECT       │
│ [Approve plan]   [Reject plan…]                                          │
└──────────────────────────────────────────────────────────────────────────┘
```

Long plans: steps list scrolls within the card; scope/oracle header stays pinned. Reject flow: §8.11.

### 4.8 Approval detail — expansion (the ≤ 1-decision surface)

```text
┌ Approve expansion → revision b71e…  (supersedes a3f9…)        risk MEDIUM ┐
│ Subgraph preview:  [api-endpnt] [ui-panel] [docs] ─► [integrate]          │
│ ┌ Preconditions (checked by daemon) ──────────────────────────────────┐   │
│ │ ▣ write scopes disjoint      api: src/api/** · ui: web/panel/** ·   │   │
│ │                              docs: docs/** (no overlap)             │   │
│ │ ▣ child oracles present      api: pnpm test:contract → exit 0 …     │   │
│ │ ▣ budget reserved            $18 of $19 remaining envelope          │   │
│ │ ● fan-out width 3 of 6 cap · depth 2 of 3                           │   │
│ └─────────────────────────────────────────────────────────────────────┘   │
│ Invalidates: nothing (adds child subgraph under node payments-core)       │
│ if idle: children stay unscheduled                                        │
│ [Approve expansion]   [Reject expansion…]                                 │
└───────────────────────────────────────────────────────────────────────────┘
```

Approve control: `cr.action.graph-approve` (the charter's `graph.approve` command; decision-kind routing per §13-D1). Precondition rows: `cr.approvals.precondition.*`.

### 4.9 Approval detail — acceptance (J1's third action)

```text
┌ Accept work · api-endpnt                                    risk NORMAL ┐
│ Diff: 454a601 → 9e12f44 · 3 files, all in scope src/api/**   [open diff]│
│ Receipt ▣ pnpm test:contract · exit 0 · 09:38 · digest 77ab… [receipt]  │
│ Review: r-1 (distinct principal ▣) — "criteria met; retry conflict path │
│   exercised; no scope escapes." findings: 0                             │
│ if idle: work waits in WORK_REVIEW; branch stays unmerged               │
│ [Accept work]   [Decline acceptance…]                                   │
└─────────────────────────────────────────────────────────────────────────┘
```

This is the human acceptance surface — distinct from the agent reviewer's working surface (§10.1) but reusing its diff and receipt components. Decline flow: §8.11. Both accept and decline route via `approval.decide` (decision-kind routing to ratify — §13-D1).

### 4.10 Node inspector (full)

```text
┌ api-endpnt · EXECUTING ────────────────────────────────────────────────┐
│ objective: POST /retry endpoint w/ idempotency-key      scope src/api/**│
│ acceptance: contract tests green; p99 < 120ms in bench                  │
│ ── phase ──  EXECUTING → [blocker.open]  (rendered from daemon)         │
│ ── lease ──  w-3 · epoch 7 · expires 09:41 · renewed 41s ago ·          │
│              quiet 41m ● (activity)                                     │
│ ── plan ──   rev a3f9c2 ◉ approved by yaron 09:31 · valid · reopen 0/3  │
│ ── attempts ─ #2 (current): steps 2/3 · receipts: 1 ▣  [attempt detail] │
│               #1 failed: receipt exit 1 ▣ · journal: "retry loop        │
│               starved connection pool — abandoned queue-based approach" │
│ ── findings ─ none      ── blockers ─ none                              │
│ ── artifacts ─ openapi.diff (digest 9c1…)                               │
│ provenance: created by event #4711 · last event #4819                   │
└─────────────────────────────────────────────────────────────────────────┘
```

### 4.11 Runs / leases

```text
┌ Runs & leases ──────────────────────────────────────────────────────────┐
│ ⚠ SUSPECT ────────────────────────────────────────────────────────────  │
│ │ w-7 · qa-review · node ui-panel · epoch 4 · no renewal 34m           │
│ │ policy: waiting for renewal grace (26m left)                         │
│ │ [Wait]  [Confirm revoke…]  [Extend grace]                            │
│ ACTIVE ──────────────────────────────────────────────────────────────── │
│ │ w-3 · worker · api-endpnt · epoch 7 · renewed 41s ago · quiet 41m ●  │
│ │ w-5 · integrator · (idle, eligible)                                  │
└─────────────────────────────────────────────────────────────────────────┘
```

### 4.12 Resources

```text
┌ Resources ──────────────────────────────────────────────────────────────┐
│ bench-box-1   held by task api-endpnt (lease exp 11:02) ●               │
│   queue: 1. perf-bench (prio 2)  2. soak-test (prio 5)                  │
│   [Force release…]                                                      │
└─────────────────────────────────────────────────────────────────────────┘
```

### 4.13 Evidence receipt

```text
┌ Receipt 9f31… · attempt #2 · api-endpnt ────────────────────────────────┐
│ ▣ DAEMON_VERIFIED                                                       │
│ recipe: pnpm test:contract      cwd: worktrees/api-endpnt               │
│ env fingerprint: node24.1-win11-x64-3fa2…    started 09:38:11 · 47s     │
│ exit 0 · output digest 77ab… [show tail]                                │
│ base 454a601 → head 9e12f44 · dirty-tree digest: clean                  │
│ artifacts: junit.xml (digest 5c9…)                                      │
│ [Re-run recipe]  → §10.4 comparison view                                │
└─────────────────────────────────────────────────────────────────────────┘
```

### 4.14 Health / doctor

```text
┌ Health ─────────────────────────────────────────────────────────────────┐
│ integrity ▣ ok · schema v3 · SQLite 3.53.4 (≥3.51.3 ✓) · backup 07:00 ● │
│ outbox: applied #4819 / emitted #4819 · live                            │
│ NEEDS_RECONCILIATION (2) ◇ ──────────────────────────────────────────── │
│ │ task-0197 imported: owner ambiguous (two claimants in legacy files)  │
│ │   [View report] [Accept imported values] [Discard record]            │
│ │   [Mark for manual repair]                                           │
└─────────────────────────────────────────────────────────────────────────┘
```

### 4.15 Policy (read-only)

```text
┌ Policy · revision p-14 (active since 08-01) ── [diff vs p-13] ──────────┐
│ approvals: manual (risk-tier automation: OFF — opt-in per project)      │
│ fan-out: width cap 6 (no raises recorded) · depth 3 · concurrency 4     │
│ reviewer independence: required · integrator independence: required     │
│ ⓘ Policy is edited as a reviewed file change; this surface never edits. │
└─────────────────────────────────────────────────────────────────────────┘
```

(Auto-approval examples elsewhere in this spec use revision `q-3` on a project that opted in; `p-14` is the default-off fixture.)

### 4.16 Narrow-window behavior (< 960 px)

- Nav rail collapses to icons with tooltips; labels reachable via `?` overlay.
- Inspector becomes a full-height overlay sheet (`Esc` closes; URL semantics unchanged).
- Board columns horizontally scrollable, sticky headers, column-jump menu; card content unchanged.
- Graph gains pinch/scroll zoom + `cr.graph.minimap`; legend collapses.
- Approval details stack preconditions above previews; decision buttons pinned to viewport bottom.
- Tables drop to two-line rows; no column removed, only reflowed.
- Nothing is desktop-only: every action available wide is available narrow.

---

## 5. State / action matrix

The matrix documents what the human **sees** and which commands are **expected** to be legal — it is the oracle for tests; the UI renders whatever `nextAllowedCommands` returns (§1.1-3). Non-charter command names are ⟨TD⟩ (§13-D1).

### 5.1 Node phase (primary)

| Phase | Human sees | Expected legal commands (rendered if returned) |
|---|---|---|
| `DRAFT` | grey card in Plan column, "not yet ready" | edit-intent ⟨TD⟩; node-cancel ⟨TD⟩ |
| `READY` | Plan column, "awaiting planner" | `work.claim` is agent-side; human sees eligibility, not a button |
| `PLANNING` | Plan column, owner + 💬 "plan drafting"; carried rejection findings if re-planning (§6.4) | `blocker.open`; `work.release` (operator, §9 confirm) |
| `PLAN_REVIEW` | Plan column + inbox item (§4.7) | `approval.decide` |
| `EXECUTION_READY` | Ready column, "scheduling…" (often transient — §14-C7) | none for human |
| `EXECUTING` | Executing column: owner, epoch, expiry, renewal + activity silence, steps | `blocker.open`; `work.release` (operator); `step.*` agent-side |
| `WORK_REVIEW` | Review column: reviewer identity, clean-context badge; then acceptance inbox item (§4.9) | `review.submit` agent-side; `approval.decide` for acceptance once review exists |
| `ACCEPTED` | Accepted column, ▣ + ◉ | reopen-as-linked-revision ⟨TD⟩ |
| `CANCELLED` | terminated filter only; inspector readable | none |

**Terminated-filter rule (global to the goal view):** CANCELLED and CANCELLED_BY_SUPERSESSION nodes are excluded by default from board columns, the graph canvas, and goals-home phase counts; the board's `cr.board.filter.terminated` toggle governs all goal-view projections (graph shows them hatched when on).

**Post-rejection routing:** a WORK_REVIEW rejection (agent reviewer) or acceptance decline (human) routes the node to `PLANNING` with findings carried — this is the UI's expected semantic, to ratify in the technical design (§14-C9).

### 5.2 Orthogonal overlays

Overlays compose: a card may show ⚠ and ⚑ together (render order: ⚠ then ⚑); options are the union of what `nextAllowedCommands` returns for the combined state.

| State | Visual | Human options |
|---|---|---|
| `held=true` | ⚑ + blocker name on card; goal-level held count | `blocker.resolve` (§8.9); view blocker |
| Lease `ACTIVE` | owner + epoch + expiry; renewal + activity silence as separate labeled datums | none (normal) |
| Lease `SUSPECT` | ⚠ on card; floats up in Runs; grace countdown | Wait / Confirm-revoke (§8.2, §9) / Extend grace (⟨TD⟩ — §13-D1) — as returned by policy |
| Lease `SUPERSEDED` (old holder) | timeline REJECTED rows + lease history only | none — informational (§8.2) |
| Lease `RELEASED` | card shows "unowned — eligible for claim"; no principal | none (agents claim); operator may re-hold via ⟨TD⟩ if returned |
| Approval `PENDING` | inbox item + badge on entity; idle-consequence line | `approval.decide` / `graph.approve` per kind |
| Approval `APPROVED` | ◉ line on plan section (approver, time); no inbox presence | none (normal) |
| Approval `AUTO_APPROVED` | `POL` chip + "policy {rev}, rule {rule}"; collapsed inbox group | provenance only |
| Approval `REJECTED` | decision moves to decided history with reason; entity per §8.11 (plan → PLANNING with findings; expansion → ghost dismissed + timeline entry) | re-propose is agent-side |
| Approval `INVALIDATED` | struck-through approval + `cr.banner.invalidated` naming superseding revision | delta re-approval (§8.4) |
| Integration `WAITING` | join strip "waiting n/m" | none |
| Integration `INTEGRATING` | integrate node in Executing column with integrator principal + lease | none (normal execution treatment) |
| Integration `FINDINGS_OPEN` | findings count badge on integrate node; finding rows in inspector | finding routing ⟨TD⟩ (repair node / re-plan) |
| Integration `INTEGRATED` | join strip resolves to "integrated ▣" summary linking the integration diff | none |
| Supersession `REBOUND` | brief badge "re-bound to {rev}", then quiet | none |
| Supersession `TO_SAFE_BOUNDARY` | badge "finishing at safe boundary" (definition — §14-C5) | none until boundary |
| Supersession `CANCELLED_BY_SUPERSESSION` | terminated filter; timeline explains | read-only |
| `NEEDS_RECONCILIATION` | ◇ styling everywhere the record appears; excluded from scheduling; Health row | Accept imported values / Discard record / Mark for manual repair (commands ⟨TD⟩; §8.7, §9) |

### 5.3 Goal-level states

| State | Goals-home rendering | Notes |
|---|---|---|
| Active | phase distribution + meters (as §4.1) | default |
| All nodes ACCEPTED | row shows "complete ▣" + completion time | exposure of goal completion state — §13-D15 |
| Cancelled | hidden behind goals filter; readable | goal-cancel command ⟨TD⟩ |
| Contains quarantined records | ◇ badge + Health link (as §4.1 row 3) | scheduling of unaffected nodes continues |

---

## 6. Journey flows and acceptance criteria (J1–J5)

Steps name the surface, whether they cost a **human action** (§1.2), and asserted IDs. Scenario IDs → §12.

### 6.1 J1 — Tuesday bug fix (`CR-J1`) — bar: ≤ 3 human actions

| # | Surface | What happens | Action? |
|---|---|---|---|
| 1 | Goals home → `cr.goals.form` (§4.2) | Create goal; single-node goal; routed to board. No graph editor anywhere. | **1** |
| 2 | Board | Agent claims + plans; card PLANNING with 💬. Inbox badge on plan submission. | — |
| 3 | Plan approval detail (§4.7) | Full plan (steps, scope, oracle); approve. | **2** |
| 4 | Board | EXECUTING (lease, steps); then Review column; then acceptance inbox item. | — |
| 5 | Acceptance detail (§4.9) | Diff + receipt + review summary; accept. | **3** |

Acceptance criteria: exactly the three actions under default policy; `cr.graph.*` never focused (`CR-J1-002`: never mounted); result view shows diff, ▣ receipt exit 0, base/head SHAs; every fact wrapped + chipped; completable from board + inbox alone.

### 6.2 J2 — Three-way fan-out/fan-in (`CR-J2`) — bar: ≤ 1 approval for the expansion

1. Planner proposes expansion → ghost subgraph (`cr.graph.ghost.*`) + inbox item.
2. Expansion detail (§4.8): daemon-checked preconditions (scopes with real path sets, oracle per child, budget reservation, width 3/6, depth 2/3). **One approve** (`cr.action.graph-approve`). Zero if project opted into risk-tier automation — item lands in `cr.approvals.auto` instead.
3. Board: three Executing cards + `cr.board.joinstrip`; Graph: join progress.
4. Children complete → strip 1/3…3/3; integrate node enters `INTEGRATING` with integrator principal (distinct lease; distinct principal because the CR-J2 policy fixture requires integrator independence — §4.15 line).
5. Integrator opens one **semantic-coherence finding** (API and UI children assumed different error-payload shapes at their shared boundary — §4.4's class, invisible to file isolation): `FINDINGS_OPEN`, finding rows in `cr.inspector.section.findings`; never auto-merged.
6. Verify node runs recipe → ▣ receipt; review node (clean context — §10.1); acceptance decision (§4.9).

Acceptance: expansion cost exactly one approval (or zero under opt-in); scope disjointness displayed with path sets; refusal path never entered (that's `CR-S9`); finding visible before any merged result; review surface provably excludes transcripts (`CR-J2-003`); timeline reconstructs spawn→join→integrate with epochs and revision hash.

### 6.3 J3 — Daemon crash and recovery (`CR-J3`)

1. Mid-J2, daemon dies → `cr.banner.disconnected`: "Connection to Moe lost. Reconnecting… Nothing you see is live." All `cr.action.*` disable (not hide).
2. Restart; reconnect; status strip catch-up (§8.6) until applied = emitted.
3. Board re-renders: every lease re-confirmed or ⚠ SUSPECT; nothing silently changed phase; unprovable facts show ◇ with provenance "no post-restart confirmation".
4. Quarantined records (if any) → Health rows (§4.14).
5. Resuming a healthy in-flight node: one click — `cr.action.work-resume` (⟨TD⟩ — §13-D1) in the inspector phase section (also surfaced as a card quick action), label **[Resume work]**; the continuation renders as a new attempt in the attempts list, linked to its predecessor.

Acceptance: zero duplicate ownership rendered at any instant; `AGENT_REPORTED` facts never upgrade across restart; disconnected banner never coexists with enabled `cr.action.*`; timeline shows `cr.timeline.row.restart` gap marker.

### 6.4 J4 — Reject / re-plan / delta re-approval (`CR-J4`)

1. Reviewer rejects with structured findings → node routes to PLANNING (§5.1 routing, §14-C9); findings render in inspector as "carried findings" and preload the re-plan context.
2. New plan revision → inbox. Delta view (§8.4): changed steps expanded, unchanged collapsed (`cr.approvals.delta.unchanged`), `cr.banner.invalidated` naming both revisions.
3. Approve delta (one action). `cr.inspector.loopcounter` shows "reopen 1 of 3".
4. At the policy bound (default 3), no fourth loop: an **escalation decision** (`cr.approvals.item.escalation`) lands in the inbox — title "Escalation: {node} rejected {n} times"; choices as returned (expected: allow one more loop / re-plan from scratch / cancel node — commands ⟨TD⟩); risk tier elevated; idle-consequence: "node stays parked in PLANNING".

Acceptance: delta view never expands the full plan by default; invalidation banner names both revisions; loop counter visible; third rejection yields the escalation item, not a loop; history fully readable.

### 6.5 J5 — Long-silent worker and stale-epoch fencing (`CR-J5`)

1. EXECUTING card: `quiet 41m` (activity silence) beside `renewed 41s` (renewal silence ≈ 0) — **neutral**; no ⚠, no revoke affordance anywhere while the lease is ACTIVE.
2. Renewal silence exceeds policy → ⚠ SUSPECT; Runs row floats up with Wait / Confirm-revoke / Extend-grace and the grace countdown.
3. Operator confirms revocation (§8.2 modal: reason required, scope shown) → successor lease; epoch bump in lease history.
4. Stale process attempts `step.finish` → rejected; Timeline REJECTED row (§4.5) with "explain" (§8.2); node card untouched.

Acceptance: no ownership change without explicit human confirm or a policy rule rendered before it fires; rejected stale command visible with both epochs and "No state was changed."; the silent-but-alive variant (worker completes at minute 45) shows completion normally, zero residue.

---

## 7. Graph interactions

### 7.1 Proposed expansion (ghost)

Dashed ghost subgraph at its parent, labeled proposal ID + "pending approval / pending policy". Click opens §4.8. Ghosts never re-layout approved nodes.

### 7.2 Fan-out refusal

A first-class outcome, not an error toast: `cr.graph.refusal.{proposalId}` card — "Fan-out declined: child `{node}` has no machine-checkable oracle" (or scope-overlap / budget reason, from daemon reason codes) + CTA **[View sequential alternative]** previewing the serialized chain. Refusals also appear in the timeline. Banner family → live region (§11.1).

### 7.3 Join progress

Join nodes render `n/m` with per-child status **glyphs** (phase glyphs, not color dots — §11.1); hover/focus lists children with phases. Join policy (all/quorum) displayed on the node.

### 7.4 Critical path

Toggle highlights the daemon-computed longest dependency chain; non-path elements dim (opacity + weight, not removal, not hue-only).

### 7.5 Same-bug circuit breaker

`cr.banner.circuitbreaker`: "Correlated failures across {n} children — same failing check: `{command}` ({locus}). Fan-out held." Options as returned: serialize children / propose re-decomposition / release hold (reason required, §9). Children show ⚑ with blocker name "circuit breaker".

### 7.6 Integration findings

Integrate node carries a findings badge; opening lists findings with implicated children and the violated coherence claim; each finding links the exact artifacts/diff hunks.

### 7.7 Mid-flight supersession

Revision banner (`cr.banner.revision`): "revision `{new}` supersedes `{old}` — dispositions in progress"; every affected node wears its disposition badge (`cr.graph.disposition.{nodeId}`, §5.2). Revision diff overlay `cr.graph.revisiondiff`: added = solid outline, removed = hatched, changed = double border. Late commands from cancelled nodes appear only as timeline REJECTED rows. Overlay dismissible; banner persists until dispositions settle.

---

## 8. Approval UX and recovery/error copy

All strings final; `{braced}` tokens are interpolation slots (§1.4).

### 8.1 Disabled actions explain themselves

A control from `nextAllowedCommands` is enabled. A control the §5 matrix expects but the daemon did not return renders disabled **only** when the daemon supplies a reason (reason-code registry — §13-D2); tooltip + inline text: "Unavailable: {reason phrase} (`{REASON_CODE}`)." No supplied reason → the control is absent, never disabled-with-guessed-text.

### 8.2 Stale lease, revocation, rejected epoch

- SUSPECT row: **"{session} has not renewed its lease for {duration}. Policy is waiting (grace: {remaining} left). Silence alone never revokes — choose an option or let the grace elapse to escalation."** Post-grace escalation is defined: a **revocation-confirmation decision** lands in the Approvals inbox (§2.6) — nothing auto-revokes.
- Revoke modal (§9 pattern) — title "Revoke lease — {node}": **"Revoke {session}'s lease on `{node}`? This invalidates its authority immediately (epoch advances). Its uncommitted workspace output will be rejected at integration. Reason (required):"** Buttons: **[Revoke lease] [Cancel]**. Records audit event (name ⟨TD⟩ — §13-D1).
- Extend grace: fixed policy increment (shown on the button: "[Extend grace +{increment}]"), no free-form duration; reason optional; command ⟨TD⟩.
- Timeline REJECTED row: **"REJECTED: `{command}` from {session} (epoch {old}; current epoch {new}, held by {holder} since {time}). No state was changed."**
- Explain view (verbatim, both variants): with integration routing (if §14-C8 ratifies it): **"The rejected session should re-fetch context before any further command. Work already in its worktree is not lost: it will be evaluated at integration under its recorded epoch and rejected there if provenance cannot be trusted."** Without: **"The rejected session should re-fetch context before any further command. Its held work is not automatically recovered; an operator can inspect the worktree before it is discarded."**

### 8.3 Budget-source UNKNOWN

Meter segment with ◇: **"Cost basis incomplete: provider `{provider}` did not report token usage for attempt {attempt}. This figure counts wall-clock and attempt-count only. Budget enforcement uses the measured dimensions; unmeasured spend is possible."** Every meter carries a basis line: "basis: provider-reported ▣" / "basis: wall-clock ●" / "basis: mixed".

### 8.4 Delta re-approval

`cr.banner.invalidated`: **"Your approval of `{old}` was invalidated by `{new}` — reviewing only the delta."** Changed items expanded before/after; unchanged collapsed: "{n} steps unchanged — expand" (`cr.approvals.delta.unchanged`). Under the button: **"Approving revision `{new}` (this supersedes your approval of `{old}`)."**

### 8.5 Failed integration provenance

Integrate-node blocked state: **"Integration halted: child `{node}`'s output was produced under lease epoch {old}, but epoch {new} was issued before completion. Provenance cannot be trusted automatically. Options: re-verify the child's output against its receipts, or discard and re-run the child."** (Options rendered only as returned commands.)

### 8.6 Outbox / display lag

Status strip: live → **"Catching up: applied #{applied} of #{emitted}"** (amber) → banner if stalled > 30 s: **"Display is behind the daemon by {n} events and not progressing. Commands remain safe (they validate against current state on the daemon), but what you see is stale. See Health for outbox status."**

### 8.7 Corrupt records and offline doctor

- Reconciliation row: **"`{record}` failed integrity checks during import: {finding}. It is quarantined — it cannot be scheduled and everything derived from it shows UNKNOWN. Choose: [Accept imported values] (records your choice as HUMAN_APPROVED) · [Discard record] · [Mark for manual repair]."** (Canonical labels; §4.14 abbreviations defer to these.)
- Doctor offline (app-wide read-only banner): **"Daemon not running. Doctor opened the database read-only after verifying no process holds it. This report reflects disk state as of {time}. Commands are unavailable in this mode."** Findings render in Health with severity + recovery-action names (report format — §13-D8).

### 8.8 Auto-approval visibility (opt-in projects)

Never silent: each records "decided by policy `{rev}`, rule `{rule}`" with the `POL` chip (§3.1) and full provenance; shown in `cr.approvals.auto` and the goal timeline. Fixture: revision `q-3`, opted-in project (§4.15 note). Opt-in toggling is a policy-file change.

### 8.9 Blocker flows

- `cr.action.blocker-open` modal (`cr.inspector.blockermodal`) — title "Open blocker — {node}": fields Title (required), Shared resource (optional picker from §2.8), Note (optional). Body: **"A blocker holds this node (it keeps its owner and phase) until resolved. If a shared resource is named, resolution follows the resource queue."** Buttons: **[Open blocker] [Cancel]**.
- `cr.action.blocker-resolve` confirm — **"Resolve blocker `{title}` on `{node}`? The node becomes schedulable again. Note (optional):"** Buttons: **[Resolve blocker] [Cancel]**.

### 8.10 Idle-consequence lines (one per decision type, shown on inbox items)

- Plan: "node waits in PLAN_REVIEW; its lease may lapse to SUSPECT."
- Expansion: "children stay unscheduled."
- Acceptance: "work waits in WORK_REVIEW; branch stays unmerged."
- Revocation confirmation: "the lease stays SUSPECT; no takeover occurs."
- Reconciliation: "the record stays quarantined and unschedulable."
- Escalation: "node stays parked in PLANNING."

### 8.11 Reject flows per decision type

Reject buttons open a §9-pattern modal (reason required). Post-reject behavior:

- **Plan reject** — title "Reject plan — {node}"; body: **"The plan returns to its author with your reason as a carried finding. The node returns to PLANNING."** Button **[Reject plan]**.
- **Expansion reject** — title "Reject expansion — {goal}"; body: **"The proposed children are not created. The ghost subgraph is dismissed and the proposal is recorded with your reason."** Button **[Reject expansion]**.
- **Decline acceptance** — title "Decline acceptance — {node}"; body: **"The work is not merged. The node returns to PLANNING with your reason as a carried finding, counting toward its reopen bound ({n} of {bound})."** Button **[Decline acceptance]**. (Same §14-C9 routing ratification.)

---

## 9. Destructive-action modal pattern

Every destructive or authority-changing flow (revoke, force-release, discard record, release circuit-breaker hold, decline acceptance) uses one pattern: the modal states the **concrete scope of effect**, requires a **reason** where §8 says so, names the **audit event** it records ("this records event `{event}` with your identity" — event names ⟨TD⟩ where non-charter), and repeats the **destructive verb on the confirm button** — never "OK". `Esc`/[Cancel] always safe.

---

## 10. Evidence and review UX

### 10.1 The review surface contract (`cr.review.*`)

The independent reviewer's working view — surface `review` (§1.4) — contains exactly: `cr.review.diff`, `cr.review.criteria`, `cr.review.receipts`, `cr.review.findings`, `cr.review.context` (graph/plan) inside `cr.review.surface`. It contains **no transcript elements**: `cr.inspector.transcript.*` must be absent from its DOM (asserted by `CR-J2-003`). Worker self-assessments never render as evidence anywhere.

### 10.2 Diff and provenance

Exact base → head SHAs (clickable, copyable); per-file changed-path list checked against the attempt's declared write scope — out-of-scope files render as flagged rows; dirty-tree digest state. No diff without its SHAs.

### 10.3 Reviewer identity and calibration

Header: reviewer principal; independence line ("distinct principal from builders ▣ — required by policy {rev}"); calibration status: **"Reviewer profile `{profile}` — calibration corpus {version}: reported catch-rate {rate}% (reported, not gating)."** Source — §13-D6; absent data renders ◇ "calibration not yet measured", never blank.

### 10.4 Rerun recipe

`cr.action.evidence-rerun` issues daemon-executed re-verification (`evidence.run` with the stored recipe). Result is a **comparison** (`cr.evidence.compare`): original vs rerun receipts side by side (exit, digests, duration, env fingerprint), drift highlighted. Reruns never overwrite originals (display append-only; storage semantics are Codex's).

### 10.5 Attempt detail (`/goal/{id}/node/{nodeId}/attempt/{attemptId}`)

The only place transcripts exist: attempt header (outcome, receipts, journal entries), then `cr.inspector.transcript.{attemptId}` — collapsed by default, labeled **"💬 AGENT_REPORTED — narrative, not evidence"**. Entry: [attempt detail] links in the inspector attempts section. Never linked from the review surface or acceptance detail.

---

## 11. Accessibility, keyboard, and system states

### 11.1 Accessibility

- No color-only encoding anywhere: truth classes per §3.1; phases carry text; edges use pattern + arrowheads; critical path uses weight + pattern; join-child indicators are phase glyphs (§7.3).
- All interactive elements keyboard-reachable in DOM order matching visual order; focus ring ≥ 2 px; skip-link to main surface. Any "hover" affordance in this spec is hover/focus.
- The graph canvas has a parallel accessible list view (`cr.graph.listview`) with the same nodes/edges/states.
- Contrast ≥ WCAG AA; `prefers-reduced-motion` → instant transitions + announcements.
- **Live regions:** every `cr.banner.*` (disconnected, lag, invalidated, circuitbreaker, revision, refusal) announces politely; the approvals badge announces politely; inline command results use `role="status"` for pending/confirmed and `role="alert"` for failure (§11.4); join-strip changes announce politely at goal level. REJECTED timeline rows never steal focus.

### 11.2 Keyboard map (defaults; remapping is a non-goal)

`g` then `g/b/r/t` — goals / board / graph / timeline · `a` approvals · `j/k` next/prev card or row within a column/list · `h/l` (or ←/→) previous/next board column, preserving row index (DOM order is column-major to match) · `Enter` open inspector/detail · `p` provenance on focused chip · `/` search · `[`/`]` collapse/expand inspector · `Esc` close overlay · `?` help overlay.

### 11.3 Loading, empty, degraded — all primary surfaces

| Surface | Loading | Empty | Degraded |
|---|---|---|---|
| Goals | 3 skeleton rows | "No goals yet. [New goal] — one sentence is enough to start." | lag banner §8.6 |
| Board | column skeletons | per-column hint ("Nothing executing") | last-known cards + lag banner |
| Graph | spinner ≤ 1 s then skeleton nodes | "This goal is a single node — the board says everything. [Back to board]" | frozen canvas + banner |
| Timeline | top-anchored skeleton | "No events match this filter." | cursor row shows gap marker |
| Inspector | section skeletons | — (always has identity once routed) | per-section staleness: sections older than the lag banner's applied-cursor render a thin "as of #{applied}" note |
| Approvals | skeleton item | "Nothing needs you." (deliberately the calmest screen) | items flagged "may be stale" |
| Runs | skeleton rows | "No active sessions. Agents appear here when they open a session." | rows flagged stale + lag banner |
| Resources | skeleton rows | "No shared resources declared. They appear on first acquisition or via policy." | rows flagged stale |
| Evidence | receipt skeleton | — (deep-linked only) | ◇ with retry if receipt fetch fails |
| Health | — | — | never degrades silently; it is the explanation surface |
| Policy | revision skeleton | "No policy revisions loaded." + doctor hint | ◇ "active revision unreadable" + Health link |

### 11.4 Latency feedback

Every command button: in-place pending immediately (`role="status"`); confirmed by the daemon event (500 ms p95 target is the charter's; the UI renders honestly, asserting nothing). > 2 s: inline "still working — the daemon accepted the command (event pending)". Failure: inline error with stable code + recovery action (`role="alert"`); button re-enables. No toast-only errors — errors live where the action was.

---

## 12. Playwright-ready acceptance matrix

Steps assert only IDs declared in §§1–11. **Setup** names the daemon-side fixture each scenario needs; fixture hooks are a dependency (§13-D12).

| Scenario | Covers | Setup (fixture) | Key asserted IDs | Bar |
|---|---|---|---|---|
| `CR-J1-001` | J1 full journey | clean project, default policy | `cr.goals.form`, `cr.action.approval-decide.approve` (plan, acceptance), `cr.evidence.receipt`, `cr.fact.*`/`cr.chip.*` | **≤ 3 human actions**; every `cr.fact.*` has a `cr.chip.*` descendant |
| `CR-J1-002` | Board-only completability | same | route coverage | `cr.graph.canvas` never mounted |
| `CR-J2-001` | Expansion approval | seeded decomposable goal | `cr.graph.ghost.*`, `cr.approvals.precondition.{scopes|oracles|budget|width}`, `cr.action.graph-approve` | **≤ 1 approval per expansion**; scope path sets rendered |
| `CR-J2-002` | Join + integrator + finding | fixture policy: integrator independence ON | `cr.board.joinstrip`, `cr.inspector.section.findings` | finding visible before merged result; integrator lease distinct; integrator principal distinct per fixture policy |
| `CR-J2-003` | Clean-context review | same | `cr.review.surface` + descendants | `cr.review.surface` contains diff/criteria/receipts descendants and zero `cr.inspector.transcript.*`; transcript present, collapsed, in attempt detail |
| `CR-J3-001` | Crash/reconnect | daemon kill/restart harness | `cr.banner.disconnected`, `cr.timeline.row.restart`, `cr.health.outbox` | banner never coexists with enabled `cr.action.*`; no duplicate active lease rendered |
| `CR-J3-002` | Reconciliation queue | seeded corrupt import | `cr.health.reconciliation.row.*` + three §8.7 actions | quarantined record shows `cr.chip.unknown` everywhere it appears |
| `CR-J3-003` | One-click resume | crash with healthy in-flight node | `cr.action.work-resume` | continuation renders as new linked attempt |
| `CR-J4-001` | Delta re-approval | seeded rejection | `cr.banner.invalidated`, `cr.approvals.delta.unchanged` | unchanged collapsed by default; both revision hashes named |
| `CR-J4-002` | Bounded loop | scripted 3 rejections | `cr.inspector.loopcounter`, `cr.approvals.item.escalation` | third rejection yields escalation item, not a fourth loop |
| `CR-J5-001` | Silence ≠ suspicion | active lease + long activity silence | `cr.board.card.silence.*` | no ⚠ and no revoke affordance while lease ACTIVE |
| `CR-J5-002` | SUSPECT → revoke → fence | renewal-silence fixture + stale-client replay | `cr.runs.suspect`, revoke modal, timeline REJECTED row | both epochs + "No state was changed." rendered |
| `CR-S9-001` | Fan-out refusal | proposal missing one child oracle | `cr.graph.refusal.*` + sequential-alternative CTA | refusal is a card with reason code, not a toast |
| `CR-S10-001` | Circuit breaker | fault-injected correlated child failures | `cr.banner.circuitbreaker` | banner names the correlated check; options only from returned commands |
| `CR-S11-001` | Supersession | approve superseding revision mid-flight | `cr.banner.revision`, `cr.graph.disposition.*`, `cr.graph.revisiondiff` | every affected node wears a disposition badge; late commands appear only as timeline REJECTED rows |
| `CR-A11Y-001` | Truth classes w/o color | forced monochrome | `cr.chip.*` | five classes distinguishable by glyph+label+border alone |
| `CR-A11Y-002` | Keyboard journey | as CR-J1 | — | J1's three actions completed keyboard-only (incl. h/l column traversal) |
| `CR-CMD-001` | Command legality | any | every enabled `cr.action.*` | each maps 1:1 to a `nextAllowedCommands` entry in the last query response |
| `CR-LAG-001` | Outbox lag | relay-stall fixture | `cr.shell.statusstrip`, lag banner | stale display labeled; commands not blocked by UI |
| `CR-DOC-001` | Doctor offline | daemon stopped; doctor harness | `cr.health.doctor`, offline banner | zero enabled `cr.action.*` in doctor mode |

Global bars asserted inside every scenario: (1) J1 ≤ 3 human actions; (2) one fan-out proposal ≤ 1 approval; (3) every `cr.fact.*` element has a `cr.chip.*` descendant (the testable form of "every displayed fact has a truth class"); (4) every enabled `cr.action.*` originates from `nextAllowedCommands`.

---

## 13. Non-goals and technical-design dependencies

### 13.1 Non-goals for this spec / v1 UI

No implementation code, component library choice, or visual tokens beyond §3's semantics. No policy editing UI, mobile surface, multi-user presence/RBAC UI, free-form chat, game-like metrics, VS Code surface, drag-authoring of graphs, automated semantic-merge UI, notification/email system, or keyboard remapping. Theming: light/dark + monochrome survival only.

### 13.2 Dependencies on the technical system design (Codex)

- **D1** `nextAllowedCommands` vocabulary + ratification of all ⟨TD⟩ command names used here: edit-intent, node-cancel, goal-cancel, reopen-as-revision, finding routing, reconciliation choices (accept/discard/repair), export trigger, revoke + audit-event name, force-release, extend-grace (+ increment source), work-resume/continuation, budget-envelope edit, escalation choices; **decision-kind routing** — confirm `approval.decide` carries plan, acceptance, revocation-confirmation, reconciliation, and escalation kinds while `graph.approve` carries expansion/revision approval, or name separate commands.
- **D2** Stable reason/error-code registry (drives §8.1 and refusal reasons).
- **D3** Event-stream cursor semantics + restart gap markers (§4.5, §8.6).
- **D4** Budget/cost measurement fields per provider incl. the basis enumeration (§8.3).
- **D5** "Safe boundary" definition for `TO_SAFE_BOUNDARY` (§5.2, §7.7 — see also §14-C5).
- **D6** Calibration metric source + corpus versioning (§10.3).
- **D7** Truth-class assignment for aggregates/roll-ups (§3.3; §14-C4).
- **D8** Doctor report format + severity/recovery-action schema (§8.7).
- **D9** Lease renewal cadence/grace fields exposed to queries (SUSPECT countdowns).
- **D10** Whether rejected commands are queryable per node or only via the event stream (§6.5 rendering).
- **D11** Ratification of the §1.2 orthogonal-state enumerations (lease, approval, integration, supersession).
- **D12** Test-fixture/fault-injection hooks for §12 setups (daemon kill/restart, relay stall, correlated-failure injection, corrupt-import seed, stale-client replay).
- **D13** Field sources for the two silence datums (activity silence = time since session's last event; renewal silence from lease records).
- **D14** Policy-default budget envelope + risk class for goal creation (§4.2).
- **D15** Exposure of goal-level completion/cancellation state (§5.3).

### 13.3 (Moved.) Conflicts live in §14.

## 14. Recorded conflicts requiring a technical ruling (not resolved here)

- **C1** Charter persistence says "Export is explicit"; the review recommends scheduled default-on hashed exports. Health reserves an export-status slot either way.
- **C2** Charter models `held` as a scheduler-projection flag; the review requires holds derivable purely from blocker/lease records. UI consumes `held` + blocker list from queries; derivation is backend semantics.
- **C3** The board's five display columns fold eight phases (§2.2); ratify the folding table so the JetBrains embed matches.
- **C4** Truth class of derived aggregates (min-of-inputs vs daemon-assigned) — §3.3 renders daemon-assigned; rule needs ratification.
- **C5** "Safe boundary" semantics for changed-node supersession (named in the review, undefined in both inputs).
- **C6** Auto-approval actor identity: is policy a `Principal` whose decisions render like human ones with the `POL` chip (§3.1 assumes yes)?
- **C7** Whether `EXECUTION_READY` is observably persistent (Ready column earns existence) or effectively instantaneous (column stays collapsed).
- **C8** Stale-session held-work routing (§8.2): both copy variants are final; which ships depends on whether rejected-epoch worktree output is evaluated at integration.
- **C9** Post-rejection routing: the UI expects WORK_REVIEW rejection and acceptance decline to route the node to `PLANNING` with carried findings (§5.1, §6.4, §8.11); the charter's phase list draws no back-edge — ratify the routing (and its board-column consequence) explicitly.
- **C10** Default integrator-independence policy: §4.15 shows it required and CR-J2-002 pins its fixture ON; whether that is the shipped default or a policy option needs a ruling (charter says integration "can require" a different principal).

## 15. Closing

This specification is implementation-ready for Phase 6 planning: every primary surface has an IA entry (§2), a wireframe (§4), loading/empty/degraded states (§11.3), and state coverage (§5); all three J1 decision surfaces are wireframed (§4.2, §4.7, §4.9); every reject branch, blocker flow, and escalation is specified with final copy (§8); the truth-class bar is mechanically testable via the fact wrapper (§1.4, §12); and everything the UI must not invent is parked in §13 (fifteen dependencies) or §14 (ten conflicts).
