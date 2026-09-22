---
# moe-generated: sha=1c2e8a9267c5
name: ponytail-review
description: >
  Code review focused exclusively on over-engineering. Finds what to delete:
  reinvented standard library, unneeded dependencies, speculative abstractions,
  dead flexibility. One line per finding: location, what to cut, what replaces
  it. Use when the user says "review for over-engineering", "what can we
  delete", "is this over-engineered", "simplify review", or invokes
  /ponytail-review. Complements correctness-focused review, this one only
  hunts complexity.
when_to_use: QA, as a second pass after moe-qa-loop's correctness review; architect or governor auditing a diff for bloat.
license: MIT
---

Review diffs for unnecessary complexity. One line per finding: location, what
to cut, what replaces it. The diff's best outcome is getting shorter.

## Format

`L<line>: <tag> <what>. <replacement>.`, or `<file>:L<line>: ...` for
multi-file diffs.

Tags:

- `delete:` dead code, unused flexibility, speculative feature. Replacement: nothing.
- `stdlib:` hand-rolled thing the standard library ships. Name the function.
- `native:` dependency or code doing what the platform already does. Name the feature.
- `yagni:` abstraction with one implementation, config nobody sets, layer with one caller.
- `shrink:` same logic, fewer lines. Show the shorter form.

## Examples

❌ "This EmailValidator class might be more complex than necessary, have you
considered whether all these validation rules are needed at this stage?"

✅ `L12-38: stdlib: 27-line validator class. "@" in email, 1 line, real validation is the confirmation mail.`

✅ `L4: native: moment.js imported for one format call. Intl.DateTimeFormat, 0 deps.`

✅ `repo.py:L88: yagni: AbstractRepository with one implementation. Inline it until a second one exists.`

✅ `L52-71: delete: retry wrapper around an idempotent local call. Nothing replaces it.`

✅ `L30-44: shrink: manual loop builds dict. dict(zip(keys, values)), 1 line.`

## Scoring

End with the only metric that matters: `net: -<N> lines possible.`

If there is nothing to cut, say `Lean already. Ship.` and stop.

## Boundaries

Scope: over-engineering and complexity only. Correctness bugs, security holes,
and performance are explicitly out of scope. Route them to a normal review
pass, not this one. A single smoke test or `assert`-based
self-check is the ponytail minimum, not bloat, never flag it for deletion.
Does not apply the fixes, only lists them.
"stop ponytail-review" or "normal mode": revert to verbose review style.

---

## Moe integration

Second pass, never the first. `moe-qa-loop` decides the verdict: DoD coverage,
rails, the re-run of `task.verification.command`, the completion commit in
`task.commits`. Run this pass after that one, on the same diff.

Routing the findings matters more than finding them:

- A finding that **breaches a rail or a DoD item** (a forbidden pattern, a
  dependency the rails ban, a "reuse the existing helper" DoD line) is a real
  `moe.qa_reject` item — put it in `rejectionDetails` with the tag and the
  replacement, same one-line format.
- A finding that is **only** complexity — leaner but equally correct — does not
  block the task. Put the lines in the `qa_approve { summary }`, or file a
  follow-up card with `moe.create_task` (`dependsOn: []`, it lands in BACKLOG
  human-gated). Never reject a task for taste; that is a reopen the reopen
  counter will punish, and 3 reopens auto-flip the task back to PLANNING.
- `net: -<N> lines possible.` goes in the summary either way — it is the
  metric a governor can read across tasks.
- A worker's `ponytail:` comment naming a ceiling and an upgrade path is
  declared intent, not a finding. Flag it only if the ceiling is wrong or the
  corner breaks a DoD item.
- The single `assert`-based self-check or smoke test a task leaves behind is
  the Moe minimum (`complete_task` requires a verification command). Never
  tag it `delete:`.