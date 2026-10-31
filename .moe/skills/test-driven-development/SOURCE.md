<!-- moe-generated: sha=9b6db3b6b65b -->

# Source

Vendored from [`obra/superpowers`](https://github.com/obra/superpowers).

- Upstream path: `skills/test-driven-development/SKILL.md`
- Upstream commit: `b55764852ac78870e65c6565fb585b6cd8b3c5c9`
- License: MIT (see `../LICENSE-VENDORED.md`)

## Local modifications

- Added `## Mutation-Resistant Assertions` section in the body to align with Moe's adversarial-review discipline (assert specific values, not truthiness).
- Removed the `## Testing Anti-Patterns` reference (linked to a sibling file not vendored).
- Appended `## Moe integration` footer pointing to `moe.start_step` / `moe.complete_step` flow and the `verification-before-completion` skill.
- Replaced "delete it and start over" (Iron Law and checklist) with: keep an existing implementation (e.g. a resumed session's), write the test, and prove it fails without the change before trusting it.