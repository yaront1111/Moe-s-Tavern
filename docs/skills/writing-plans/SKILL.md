---
name: writing-plans
description: Use when you have a spec or requirements for a multi-step task, before touching code
---

# Writing Plans

Write each step for an engineer who has the repository open and will read the code the step touches. Give them what the code cannot: which files, what changes, the decision already made, and the command that proves it.

DRY. YAGNI. TDD.

## Scope check

If the spec covers multiple independent subsystems, suggest breaking it into one plan per subsystem. Each plan should produce working, testable software on its own.

## File structure

Before defining steps, map files: which created, which modified, what each is responsible for. Smaller focused files over large ones. Files that change together live together. Follow existing codebase patterns — don't unilaterally restructure.

## Bite-sized steps

Each step implements one concern together with the tests for what it changed. Inside the step the worker runs the red → green cycle (see `test-driven-development`); the plan names one verification command for the whole task. The agent wrapper commits — plans never contain `git add`/`git commit`.

## What a step contains

- **Files:** the exact paths it modifies and creates.
- **The change:** one or two sentences, plus the decision behind it where the code allows more than one reading.
- **Tests:** the cases that must exist, by name ("rejects an empty id", "keeps order on a tie"), not their code.
- **What the code does not show:** a string a test pins, a file another task owns, a constraint from the spec.

Quote code only when the exact characters are the contract: a wire shape, a public signature, a pinned phrase, a command. The engineer writes the rest against the code as it stands that day, which a block written at planning time cannot track.

## No placeholders

These are plan failures — never write them:
- "TBD", "TODO", "implement later", "fill in details"
- "Add appropriate error handling" / "handle edge cases": name the failure path or the edge case, or leave the line out
- "Write tests for the above" with no cases named
- An implementation step that names no file

"Same change as step 2, in `other/file.py`" is fine: describe it once and point at it.

## Self-review

After writing, re-read the spec with fresh eyes:
1. **Coverage:** every requirement maps to a step? List gaps.
2. **Placeholder scan:** any of the failure patterns above? Fix them.
3. **Name consistency:** types and method names match across steps? `clearLayers()` in step 3 vs `clearFullLayers()` in step 7 is a bug.
4. **Weight:** delete every sentence the engineer would get from reading the file, and every caution that appears twice.

Fix issues inline. No re-review pass.

---

## Moe integration

In Moe, the architect's plan becomes `implementationPlan.steps` via `moe.submit_plan`. Each step in this skill maps to one Moe step:
- **The change**, **tests** and **what the code does not show** → step `description`, usually a few hundred characters (`moe.submit_plan` warns past 1500)
- **Files** → `affectedFiles` for paths that exist, `newFiles` for paths the step creates
- **The verification command** → its own step, once, at the end ("Run X, expect Y")

Load `moe-planning` first: it decides the plan's shape and where the verification gate goes. This skill covers what goes inside one step.
