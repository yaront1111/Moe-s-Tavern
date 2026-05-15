---
description: Claim the next Moe task for a given role
argument-hint: <architect|worker|qa|governor>
allowed-tools: [Bash, mcp__moe__moe_claim_next_task, mcp__moe__moe_enter_governance, mcp__moe__moe_get_context]
---

# /moe-claim

Claim the next prioritized task for a role.

## Arguments

`$ARGUMENTS` is the role: `architect`, `worker`, `qa`, or `governor`. If empty, ask the user which role to claim as (single short question, then proceed).

## Steps

1. Resolve the role from `$ARGUMENTS`. Normalize case. Reject anything outside the four valid roles with a clear error.

2. Resolve a `workerId`:
   - Use `$MOE_WORKER_ID` if set.
   - Else use `<role>-<random6>` (e.g. `worker-a1b2c3`). Echo the chosen id so the user can re-use it.

3. Dispatch on role:

   | Role | Tool | Args |
   |---|---|---|
   | architect | `moe.claim_next_task` | `{ statuses: ["PLANNING"], workerId }` |
   | worker | `moe.claim_next_task` | `{ statuses: ["WORKING", "BACKLOG"], workerId }` |
   | qa | `moe.claim_next_task` | `{ statuses: ["REVIEW"], workerId }` |
   | governor | `moe.enter_governance` | `{ workerId }` |

   Match the wrapper scripts in `scripts/moe-agent.ps1` / `scripts/moe-agent.sh` for the canonical `statuses` filter per role.

4. If the call returns `hasNext: false`, say "Nothing to claim for `<role>` right now." and stop.

5. If a task was claimed, print:

   ```
   Claimed task-id — title
   Status: STATUS  Worker: <workerId>
   nextAction: <tool> — <reason>
   ```

   Then call the `nextAction.tool` (typically `moe.get_context`) so the user has full context immediately.

## Notes

- Never call a mutating tool besides `moe.claim_next_task` / `moe.enter_governance` from this command.
- If the daemon is unreachable, print the daemon error verbatim and stop.
