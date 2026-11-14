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
- Added `## How Many Tests` and reworded two checklist items (2026-11-13): coverage is counted by behaviour and boundary, not by function ("Every new function/method has a test" became one test per behaviour the change adds or alters; "Edge cases and errors covered" became the edge cases and error paths this change adds, each once). Across 800 completion commits on Moe's own board (from 2026-10-01) the medians were 25 changed source lines and 93 changed test lines, with a median test-to-source ratio of 2.1.
- The Moe footer names the `complete_step` field that exists (`note`; there is no `summary`).
