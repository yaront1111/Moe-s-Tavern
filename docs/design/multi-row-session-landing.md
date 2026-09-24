# Multi-row sessions: landing every row a seat works, not just the one it launched on

Status: DESIGN, not implemented. Filed 2026-09-24 by governor-22bdbca5 after the
operator asked for "3 tasks before new CLI needed" and, when shown the tradeoff,
chose the enforced option over the doc-only one.

## What the operator wants

One CLI session works up to N rows (N=3 was the ask) instead of exiting after
one. Today a seat does exactly one row per CLI invocation.

## Why the obvious version is wrong

`worker.md` forbids `claim_next_task` inside a session, and that rule is load
bearing. `scripts/moe-agent.sh:7423`:

```sh
LAND_TASK_ID="$PREFLIGHT_TASK_ID"
```

The post-flight lands **the row the wrapper launched on**, always. The wrapper
blocks inside the CLI call for its whole lifetime, so it cannot observe a row
transition and cannot re-run its pre-flight between rows. A session that hops
rows therefore reaches the post-flight holding bytes for rows it will never
land. Measured 2026-09-06: one completion in three reached REVIEW with its bytes
only in the dirty tree.

## What already protects us (measure this before assuming worse)

The failure is **stranded bytes, loudly flagged** — NOT silent misattribution.
`resolve_attribution` runs per `LAND_TASK_ID` (`moe-agent.sh:3702`), and paths
that the landing row neither declared nor wrote are left unstaged with a banner
(`:4908`):

```
MOE_ATTRIBUTION_UNRESOLVED task=<id>:<paths>
```

So rows 2..N do not get committed under row 1's title. Their bytes survive in
the working tree and the seat says so. That is fail-closed, and it is why this
is a feature gap rather than a data-loss defect. Do not "fix" attribution as
part of this work — it is already doing the right thing.

## The design

After the launched row lands, run the SAME landing again, once per other row
this seat owns, each under its own `LAND_TASK_ID`. No new landing machinery: the
landing already keys everything (index, attribution, subject, rescue ref,
receipt) off the `LAND_*` globals.

Enumeration already exists. `reattach_own_attempts` (`moe-agent.sh:2150`) reads
`.moe/attempts/*.json`, filters `workerId == this seat`, and yields
`taskId attemptId generation`. Reuse that shape — do not invent a second source
of truth for "rows this seat touched".

Sketch, sh side:

1. Post-flight lands `PREFLIGHT_TASK_ID` exactly as it does now.
2. Then enumerate this seat's other rows from `.moe/attempts/*.json`, restricted
   to this session (`MOE_SID`) and to attempts not already finalized.
3. For each, set the `LAND_*` globals and re-enter the landing.
4. A row whose attribution yields no paths lands nothing and says so — that is
   the normal case for a row the agent already self-landed.

Baselines need no new writer. `GITDIR/moe/baseline/<taskId>.tsv` is written by
the pre-flight for the launched row only, and "a landing that found no baseline"
is already one of the three legal `landed=1` writers (`baseline_landed_flag`,
see the header comment at `:2499`). A mid-session row simply lands against HEAD.

## Constraints on whoever implements this

- **Both twins or neither.** `moe-agent.ps1` and `moe-agent.sh` are twins; the
  ps1 half is `Invoke-MoeReattachOwnAttempts` and the `$res.Outcome` path. A fix
  in one only is a new bug on the other platform.
- **Cap the row count and make it a setting**, defaulting OFF. A seat that loops
  rows forever never reaches its post-flight at all, which is the failure this
  whole file is about, one level up.
- **The agent must still self-land each row** (QA's existing recipe, `qa.md:8`:
  commit via the measured-attribution path, then `moe.record_commit`). The
  post-flight sweep is the safety net for a forgotten self-land, not the primary
  path. Say this explicitly in `worker.md` when the protocol ships.
- **Order matters.** Land the rows oldest-first so a later row that touched the
  same path does not silently win; the existing per-task attribution decides
  ownership, so a contested path must stay contested, not be resolved by loop
  order.
- **Prove it with a real 3-row session**, not a unit test of the enumerator. The
  acceptance question is "did all three rows reach REVIEW with their own bytes
  under their own ids", and the oracle is `git log` plus each row's
  `task.commits`, not the wrapper's own banner.

## What NOT to do

Do not move the landing into the agent and delete the post-flight. The
post-flight is what survives a crashed CLI, a Ctrl+C and a provider timeout; the
pre-flight recovery path (`moe-agent.sh:123-139`, `finalize_postflight`) depends
on it. In-session self-landing is an addition, never a replacement.

Do not raise `POLL_INTERVAL` frequency as a substitute. It is a separate,
cheaper throughput knob (`moe-agent.sh:209`, 30s) with its own cost: with ~10
seats, 30s to 5s is 6x the claim-poll load on a shared daemon. Decide it on its
own merits.
