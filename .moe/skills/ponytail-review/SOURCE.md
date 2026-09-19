<!-- moe-generated: sha=ba346e4990b3 -->

# Source

Vendored from [`DietrichGebert/ponytail`](https://github.com/DietrichGebert/ponytail).

- Upstream path: `skills/ponytail-review/SKILL.md`
- Upstream commit: `e3ba2aa6f1e6f0bc4d69eb09c9f0d0a93af56156`
- License: MIT (see `../LICENSE-VENDORED.md`)

## Local modifications

- Added `when_to_use` frontmatter (Moe skill convention).
- Appended `## Moe integration` footer: run it as a second pass after `moe-qa-loop`, and route findings — rail/DoD breaches into `qa_reject.rejectionDetails`, taste-only findings into the `qa_approve` summary or a follow-up card (a reject for taste burns the reopen counter, and 3 reopens auto-flip the task to PLANNING).
- Body otherwise byte-identical to upstream (tags, examples, scoring, boundaries unchanged).