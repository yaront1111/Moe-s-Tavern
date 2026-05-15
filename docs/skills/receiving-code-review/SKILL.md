---
name: receiving-code-review
description: Use when receiving code review feedback, before implementing suggestions, especially if feedback seems unclear or technically questionable - requires technical rigor and verification, not performative agreement or blind implementation
---

# Receiving Code Review

Code review requires technical evaluation, not emotional performance. **Verify before implementing. Ask before assuming. Technical correctness over social comfort.**

## Response pattern

1. **Read** the complete feedback without reacting.
2. **Understand** by restating the requirement in your own words (or asking).
3. **Verify** against codebase reality — open the file, grep for usage.
4. **Evaluate** — technically sound for THIS codebase?
5. **Respond** with technical acknowledgment or reasoned pushback.
6. **Implement** one item at a time, test each.

## Forbidden phrases

NEVER write:
- "You're absolutely right!" / "Great point!" / "Excellent feedback!" / "Thanks for catching that!"
- "Let me implement that now" before verification
- Any gratitude expression

INSTEAD: restate the requirement, ask clarifying questions, push back with technical reasoning, or just start working. Actions > words. If you catch yourself typing "Thanks", delete it.

## Unclear items — STOP

If any item is unclear, do NOT implement anything yet. Ask for clarification on the unclear items first. Items may be related; partial understanding produces wrong implementations.

Wrong: "I'll implement 1,2,3,6 now and ask about 4,5 later."
Right: "I understand 1,2,3,6. Need clarification on 4 and 5 before proceeding."

## When to push back

Push back when:
- Suggestion breaks existing functionality.
- Reviewer lacks full context.
- Violates YAGNI (suggestion targets unused feature).
- Technically incorrect for this stack.
- Legacy/compatibility reasons exist.
- Conflicts with prior architectural decisions.

How: technical reasoning, not defensiveness. Ask specific questions. Reference working tests/code.

## YAGNI check

If a reviewer says "implement properly", grep the codebase for actual usage. If unused, push: "This isn't called. Remove it (YAGNI)?" If used, then implement properly.

## Implementation order

For multi-item feedback:
1. Clarify everything unclear FIRST.
2. Then implement: blocking issues (breaks, security) → simple fixes (typos, imports) → complex fixes (refactoring, logic).
3. Test each fix individually. Verify no regressions.

## Acknowledging correct feedback

State the fix factually:
- "Fixed. [Brief description]."
- "Good catch — [specific issue]. Fixed in [location]."
- Or just fix it and let the code show you heard.

No gratitude. No performative agreement.

## Correcting your own pushback

If you pushed back and were wrong: "You were right — I checked X and it does Y. Implementing now." No long apology, no defending, no over-explaining.

---

## Moe integration

This skill loads when `nextAction.recommendedSkill = receiving-code-review` — typically after `moe.qa_reject` (task is back in WORKING with `reopenCount > 0` and `rejectionDetails` populated).

When you receive a QA rejection:

1. **Read all of `rejectionDetails` first.** Don't start fixing until you understand every item.
2. **Verify each item against the diff.** If QA points at a file/line, open it and read for yourself.
3. **If an item seems wrong**, push back via `moe.add_comment` on the task channel with technical reasoning. Don't silently ignore; don't silently implement.
4. **Implement in priority order** (security/correctness > simple fixes > refactoring). Use one `moe.start_step` per item — don't batch unrelated fixes.
5. **After fixes, run regression-check** and put actual results in your `moe.complete_task` summary.

Never include performative gratitude in `moe.add_comment`. State what you changed.
