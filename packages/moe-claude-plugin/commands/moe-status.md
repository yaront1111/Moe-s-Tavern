---
description: Show in-flight Moe tasks and connected workers
allowed-tools: [Bash, mcp__moe__moe_list_tasks, mcp__moe__moe_list_workers]
---

# /moe-status

Show what the Moe team is currently doing.

## Steps

1. Call `moe.list_tasks` with `{ status: ["WORKING"] }`. If the tool is unavailable, fall back to running:

   ```bash
   node ${CLAUDE_PLUGIN_ROOT}/dist/cli.js status
   ```

2. Print one line per task in this format:

   ```
   [role] task-id  STATUS — title
   ```

   `role` is derived from the assigned worker id prefix (`architect`, `worker`, `qa`, `governor`, or `?` if unknown).

3. Call `moe.list_workers` and print a short "Connected workers" block:

   ```
   Connected workers:
     - worker-id  status  (last activity Ns ago)
   ```

   Mark stale workers (`isAlive: false`) explicitly.

4. If both calls succeed but return no tasks/workers, say so plainly. Do not invent activity.

5. If the daemon is unreachable, surface the error message verbatim (it includes the suggested fix). Do not try to start the daemon yourself.

## Notes

- This is read-only — never call `moe.claim_next_task`, `moe.set_task_status`, or any mutating tool from this command.
- Output should be compact: under 30 lines for typical projects.
