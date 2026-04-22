# Source

Vendored from [`obra/superpowers`](https://github.com/obra/superpowers).

- Upstream path: `skills/brainstorming/SKILL.md`
- Upstream commit: `b55764852ac78870e65c6565fb585b6cd8b3c5c9`
- License: MIT (see `../LICENSE-VENDORED.md`)

## Local modifications

- Removed the Visual Companion section (browser-based mockup tool not part of Moe today; can be re-introduced once the JetBrains/VS Code panes support a similar surface).
- Removed the explicit `frontend-design`, `mcp-builder` skill references (those skills are not part of the Moe skill pack).
- Renamed `docs/superpowers/specs/...` save path to `docs/specs/<task-id>-<slug>.md` in the Moe integration footer (matches this repo's docs convention).
- Re-pointed the next-step skill from `writing-plans` to `moe-planning` (Moe-flavored equivalent).
- Appended `## Moe integration` footer wiring the skill to `moe.chat_send` on the task channel and the `moe.submit_plan` flow.
