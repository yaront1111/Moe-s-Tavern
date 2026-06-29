# ROS 2 Skill: Agent Rules & Decision Frameworks

> **The rule set has been split into five domain-specific files for easier navigation.**
> This file is an index. Load the relevant domain file(s) for your current task.

---

## Rule File Index

| File | Load when... | Key rules |
|---|---|---|
| [RULES-CORE.md](RULES-CORE.md) | **Always** — these rules apply to every command | Rules 0.5, 1, 2, 4, 5, 6, 10, 11, 12, 13; Quick Decision Card; mandatory compliance preamble |
| [RULES-PREFLIGHT.md](RULES-PREFLIGHT.md) | Before **any** action, at session start | Rule 0 (pre-flight introspection + velocity limit sources), Rule 0.1 (session-start steps 0–6), Rule 14 (lifecycle), Rule 15 (publisher/QoS), Rule 19 (QoS pre-flight for publish-until) |
| [RULES-MOTION.md](RULES-MOTION.md) | Any **motion** request | Rule 3 (movement algorithm), Rule 9 (pre-motion check + Nav2 preemption), Rule 17 (REP-103/REP-105), Rule 18 (estop after publish-until), Rules 20–25 (decel zone, timeout recovery, command limits, sequencing, proximity scan); Action Preemption table |
| [RULES-DIAGNOSTICS.md](RULES-DIAGNOSTICS.md) | When something **fails or needs verification** | Rule 7 (failure diagnosis + log-level elevation + executor starvation), Rule 8 (post-action verification table), Rule 16 (multi-step sequencing); Error Recovery Protocols |
| [RULES-REFERENCE.md](RULES-REFERENCE.md) | Looking up a **command** or setting up | Rule 26 (Discord image delivery); Agent Decision Framework Steps 1–5 (intent→command table, sensor types, motion vocabulary); Launch workflow + arg validation; Setup & Environment |

---

## Navigation by Task Type

```
Session start         → RULES-PREFLIGHT.md (Rule 0.1)
Any action            → RULES-PREFLIGHT.md (Rule 0) + RULES-CORE.md (Rules 1, 2, 5)
Motion command        → RULES-MOTION.md (Rules 3, 9, 18) + RULES-PREFLIGHT.md (Rule 19)
Something failed      → RULES-DIAGNOSTICS.md (Rules 7, 8)
Post-action verify    → RULES-DIAGNOSTICS.md (Rule 8)
Multi-step sequence   → RULES-DIAGNOSTICS.md (Rule 16)
"What command do I use for X?" → RULES-REFERENCE.md (Step 1 intent table)
Launch a file         → RULES-REFERENCE.md (Launch Commands & Workflow)
```

---

## Rule Number Index

| Rule | File | Topic |
|---|---|---|
| 0 | RULES-PREFLIGHT.md | Full pre-flight introspection protocol |
| 0.1 | RULES-PREFLIGHT.md | Session-start checks (Steps 0–6) |
| 0.5 | RULES-CORE.md | Never hallucinate commands |
| 1 | RULES-CORE.md | Discover before you act |
| 2 | RULES-CORE.md | ros2-skill is the only interface |
| 3 | RULES-MOTION.md | Movement algorithm |
| 4 | RULES-CORE.md | Infer the goal, resolve the details |
| 5 | RULES-CORE.md | Execute, don't ask |
| 6 | RULES-CORE.md | Minimal reporting |
| 7 | RULES-DIAGNOSTICS.md | Diagnose failures immediately |
| 8 | RULES-DIAGNOSTICS.md | Verify the effect |
| 9 | RULES-MOTION.md | Pre-motion check |
| 10 | RULES-CORE.md | Empty discovery: broaden the search |
| 11 | RULES-CORE.md | Use discovered names verbatim |
| 12 | RULES-CORE.md | Run independent discovery in parallel |
| 13 | RULES-CORE.md | Never reuse stale session state |
| 14 | RULES-PREFLIGHT.md | Lifecycle state before using managed nodes |
| 15 | RULES-PREFLIGHT.md | Publisher/subscriber counts before subscribing |
| 16 | RULES-DIAGNOSTICS.md | Multi-step: complete and verify each step |
| 17 | RULES-MOTION.md | REP-103 (units) + REP-105 (frames) |
| 18 | RULES-MOTION.md | Always estop after publish-until |
| 19 | RULES-PREFLIGHT.md | QoS compatibility before publish-until |
| 20 | RULES-MOTION.md | Deceleration zone auto-compute |
| 21 | RULES-MOTION.md | After publish-until timeout: verify before re-issuing |
| 22 | RULES-MOTION.md | Reject unreasonably large motion commands |
| 23 | RULES-MOTION.md | New command during active motion: stop first |
| 24 | RULES-MOTION.md | Conditional and branching task sequences |
| 25 | RULES-MOTION.md | Proximity sensor discovery before long motions |
| 26 | RULES-REFERENCE.md | Always use discord_tools.py for Discord delivery |
