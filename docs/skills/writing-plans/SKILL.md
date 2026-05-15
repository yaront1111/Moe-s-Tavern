---
name: writing-plans
description: Use when you have a spec or requirements for a multi-step task, before touching code
---

# Writing Plans

Write plans assuming the engineer has zero context for our codebase. Document everything they need: which files to touch, code blocks per step, exact commands with expected output, what to test.

DRY. YAGNI. TDD. Frequent commits.

## Scope check

If the spec covers multiple independent subsystems, suggest breaking it into one plan per subsystem. Each plan should produce working, testable software on its own.

## File structure

Before defining tasks, map files: which created, which modified, what each is responsible for. Smaller focused files over large ones. Files that change together live together. Follow existing codebase patterns — don't unilaterally restructure.

## Bite-sized tasks

Each step is one action (2-5 minutes):
- Write the failing test
- Run it to confirm it fails
- Write minimal code to pass
- Run again to confirm it passes
- Commit

## Plan header (every plan)

```markdown
# [Feature Name] Implementation Plan
**Goal:** [one sentence]
**Architecture:** [2-3 sentences]
**Tech Stack:** [key technologies]
---
```

## Task structure

```markdown
### Task N: [Component Name]
**Files:**
- Create: `exact/path/to/file.py`
- Modify: `exact/path/existing.py:123-145`
- Test: `tests/exact/path/test.py`

- [ ] Step 1: Write the failing test
  ```python
  def test_specific_behavior(): ...
  ```
- [ ] Step 2: Run test, expect FAIL with "<reason>"
- [ ] Step 3: Write minimal implementation (code block)
- [ ] Step 4: Run test, expect PASS
- [ ] Step 5: Commit (exact `git add` + commit message)
```

## No placeholders

These are plan failures — never write them:
- "TBD", "TODO", "implement later", "fill in details"
- "Add appropriate error handling" / "handle edge cases"
- "Write tests for the above" with no actual test code
- "Similar to Task N" — repeat the code; the engineer may read tasks out of order
- Steps that say what without showing how (code blocks required for code steps)

Every step contains the actual content the engineer needs.

## Self-review

After writing, re-read the spec with fresh eyes:
1. **Coverage:** every requirement maps to a task? List gaps.
2. **Placeholder scan:** any of the failure patterns above? Fix them.
3. **Type consistency:** types and method names match across tasks? `clearLayers()` in Task 3 vs `clearFullLayers()` in Task 7 is a bug.

Fix issues inline. No re-review pass.

---

## Moe integration

In Moe, the architect's plan becomes `implementationPlan.steps` via `moe.submit_plan`. Each step in this skill maps to one Moe step:
- **Title** → step `title`
- **Files** + **code blocks** → step `description` (paste code so the worker doesn't re-derive it)
- **Test files** → step `affectedFiles`
- **Run commands** → in `description` ("Run X, expect Y")

Use `moe-planning` for the higher-level 8-phase template; use this skill for inside-the-step granularity.
