# Source

Vendored from [`obra/superpowers`](https://github.com/obra/superpowers).

- Upstream path: `skills/verification-before-completion/SKILL.md`
- Upstream commit: `b55764852ac78870e65c6565fb585b6cd8b3c5c9`
- License: MIT (see `../LICENSE-VENDORED.md`)

## Local modifications

- Removed two upstream phrases that referenced specific personal-history quotes ("I don't believe you", "you'll be replaced") — the principle stands without the specifics.
- Replaced the Overview / Iron Law pressure language with a plain statement of the gate, softened "Skip any step = lying", and removed the Red Flags, Rationalization Prevention, Why This Matters, When To Apply and Bottom Line sections (the gate function and the claim/requires tables carry the rule).
- Merged with Moe's own `regression-check` skill (2026-11-14), which is retired. Both were loaded at the same moment, before `moe.complete_task`, and both said to run the command, read the output and report the counts. From upstream this skill keeps the gate and the claim table, cut to the rows a Moe worker meets. From `regression-check` it takes how wide to run, how to read a red run, "A red gate you did not cause" and the summary rule. The `## Moe integration` footer is folded into the body, which names the `verification` argument of `moe.complete_task` directly.
