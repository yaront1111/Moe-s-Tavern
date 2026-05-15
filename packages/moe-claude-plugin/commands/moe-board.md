---
description: Print a compact ASCII Moe board (5 columns x top 5 tasks)
allowed-tools: [mcp__moe__moe_list_tasks]
---

# /moe-board

Show a compact snapshot of the Moe task board.

## Steps

1. Call `moe.list_tasks` once with `{ limit: 500 }` (no status filter) to fetch all tasks.

2. Group tasks by status into five columns: `BACKLOG`, `PLANNING`, `WORKING`, `REVIEW`, `DONE`. Ignore other statuses (`AWAITING_APPROVAL` rolls into `PLANNING`, `ARCHIVED` is skipped).

3. Sort each column by `order` ascending then `priority` descending. Keep at most 5 tasks per column.

4. Print an ASCII table. Truncate titles to ~22 chars and prefix with the short task id (last 6 chars). Example:

   ```
   ┌──────────────┬──────────────┬──────────────┬──────────────┬──────────────┐
   │   BACKLOG    │   PLANNING   │   WORKING    │    REVIEW    │     DONE     │
   ├──────────────┼──────────────┼──────────────┼──────────────┼──────────────┤
   │ a1b2c3 ...   │ ...          │ ...          │ ...          │ ...          │
   │ ...          │              │              │              │              │
   └──────────────┴──────────────┴──────────────┴──────────────┴──────────────┘
     12 backlog   3 planning   2 working   1 review   47 done
   ```

5. Below the board, print one summary line: total per column from `counts`.

## Notes

- Read-only. Never mutate.
- If a column has more than 5 tasks, append "(+N more)" in the cell.
