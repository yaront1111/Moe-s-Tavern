# Source

Vendored from [`obra/superpowers`](https://github.com/obra/superpowers).

- Upstream path: `skills/writing-plans/SKILL.md`
- Upstream commit: `b55764852ac78870e65c6565fb585b6cd8b3c5c9`
- License: MIT (see `../LICENSE-VENDORED.md`)

## Local modifications

- Removed the `superpowers:subagent-driven-development` / `superpowers:executing-plans` execution-handoff section (those are upstream-specific orchestration mechanisms; in Moe the daemon drives execution via `moe.start_step` / `moe.complete_step`).
- Removed the "Save plans to: docs/superpowers/plans/..." line (Moe's plans live in `task.implementationPlan`, not on disk).
- Appended `## Moe integration` footer mapping plan structure to `moe.submit_plan` step fields and pointing at the Moe-native `moe-planning` skill as the higher-level entry point.
- Rewrote "Bite-sized tasks" and the task-structure example: a step is one concern plus its tests (red → green inside the step), plans name one verification command, and plans never contain `git add`/`git commit` (the Moe wrapper commits). Dropped "Frequent commits."
- Replaced the upstream premise (2026-11-13). Upstream writes for an engineer with no context for the codebase and requires a code block in every code step, with code repeated rather than referenced. A Moe worker has the repository, the context packet and its own skills, and plans written to the upstream premise had reached a median of 9,700 characters of step text on Moe's own board (726 plans, October–November 2026). A step now gives the files, the change, the decision made and the test cases by name; code is quoted only where the exact characters are the contract. Removed the plan-header template and the task-structure example (a Moe step is a description plus file lists), replaced them with "What a step contains", and added a "Weight" item to the self-review.
- Corrected the `## Moe integration` mapping: a Moe step has no `title` field; files map to `affectedFiles` (existing paths) and `newFiles` (paths the step creates); the verification command is one step at the end.
