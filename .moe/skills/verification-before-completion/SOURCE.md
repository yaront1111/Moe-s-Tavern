<!-- moe-generated: sha=7fad5f7094e1 -->

# Source

Vendored from [`obra/superpowers`](https://github.com/obra/superpowers).

- Upstream path: `skills/verification-before-completion/SKILL.md`
- Upstream commit: `b55764852ac78870e65c6565fb585b6cd8b3c5c9`
- License: MIT (see `../LICENSE-VENDORED.md`)

## Local modifications

- Removed two upstream phrases that referenced specific personal-history quotes ("I don't believe you", "you'll be replaced") — the principle stands without the specifics.
- Appended `## Moe integration` footer wiring the skill to `moe.complete_step` / `moe.complete_task` and pointing at sibling skills (`regression-check`, `adversarial-self-review`).
- Replaced the Overview / Iron Law pressure language with a plain statement of the gate, softened "Skip any step = lying", and removed the Red Flags, Rationalization Prevention, Why This Matters, When To Apply and Bottom Line sections (the gate function and the claim/requires tables carry the rule).