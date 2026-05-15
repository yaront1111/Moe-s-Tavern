# Source

Vendored from [`obra/superpowers`](https://github.com/obra/superpowers).

- Upstream path: `skills/receiving-code-review/SKILL.md`
- Upstream commit: `b55764852ac78870e65c6565fb585b6cd8b3c5c9`
- License: MIT (see `../LICENSE-VENDORED.md`)

## Local modifications

- Removed personalised "your human partner" / CLAUDE.md framing — generalised to "trusted human reviewer".
- Removed "Strange things are afoot at the Circle K" signal phrase (private convention).
- Removed the GitHub Thread Replies section (Moe's review channel is `moe.add_comment`, not GitHub PR threads — captured in the integration footer).
- Appended `## Moe integration` footer wiring the skill to `moe.qa_reject` recovery, `rejectionDetails`, and the `regression-check` follow-up.
