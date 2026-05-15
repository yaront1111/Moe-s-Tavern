# Source

Vendored from [`obra/superpowers`](https://github.com/obra/superpowers).

- Upstream path: `skills/systematic-debugging/SKILL.md`
- Upstream commit: `b55764852ac78870e65c6565fb585b6cd8b3c5c9`
- License: MIT (see `../LICENSE-VENDORED.md`)

## Local modifications

- Removed the multi-layer codesign example (Apple-specific, distracting in this repo) — kept the abstract instruction.
- Replaced the `superpowers:test-driven-development` cross-reference with `test-driven-development` (matches our local skill name).
- Removed the "your human partner's Signals You're Doing It Wrong" section (referenced personalised quotes that are out of place here).
- Removed the Supporting Techniques section (the linked sibling files like `root-cause-tracing.md` are not vendored).
- Appended `## Moe integration` footer wiring the skill to `moe.set_task_status BLOCKED`, `moe.report_blocked`, and the `qa_reject` recovery path.
