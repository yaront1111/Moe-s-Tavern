<!-- moe-generated: sha=f3eacf771b00 -->

# Source

Vendored from [`DietrichGebert/ponytail`](https://github.com/DietrichGebert/ponytail).

- Upstream path: `skills/ponytail/SKILL.md`
- Upstream commit: `e3ba2aa6f1e6f0bc4d69eb09c9f0d0a93af56156`
- License: MIT (see `../LICENSE-VENDORED.md`)

## Local modifications

- Added `when_to_use` frontmatter (Moe skill convention; the daemon and role docs key on it).
- Appended `## Moe integration` footer: the daemon's mid-step `recommendedSkill` hook, the `submit_plan` size gates as the architect-side reason to climb the ladder, the "a step you think is unnecessary is `complete_step { note }` / `report_blocked` / `propose_rail`, never a silent skip" rule, and Moe's `complete_task` verification floor overriding the skill's "trivial one-liners need no test".
- Body otherwise byte-identical to upstream (the ladder, rules, output, intensity table, and "when NOT to be lazy" are unchanged).