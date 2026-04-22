# Source

Vendored from [`obra/superpowers`](https://github.com/obra/superpowers).

- Upstream path: `skills/writing-plans/SKILL.md`
- Upstream commit: `b55764852ac78870e65c6565fb585b6cd8b3c5c9`
- License: MIT (see `../LICENSE-VENDORED.md`)

## Local modifications

- Removed the `superpowers:subagent-driven-development` / `superpowers:executing-plans` execution-handoff section (those are upstream-specific orchestration mechanisms; in Moe the daemon drives execution via `moe.start_step` / `moe.complete_step`).
- Removed the "Save plans to: docs/superpowers/plans/..." line (Moe's plans live in `task.implementationPlan`, not on disk).
- Appended `## Moe integration` footer mapping plan structure to `moe.submit_plan` step fields and pointing at the Moe-native `moe-planning` skill as the higher-level entry point.
