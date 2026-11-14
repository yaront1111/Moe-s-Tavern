---
name: test-driven-development
description: Use when implementing any feature or bugfix, before writing implementation code
---

# Test-Driven Development (TDD)

## The Iron Law

```
NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST
```

If the implementation already exists (you wrote it first, or a resumed session did), don't delete it: write the test, then prove it fails without the change (temporarily break the guarded line) before trusting it.

## Red-Green-Refactor

### RED — Write a failing test
- One behaviour, clear name (no "and"), real code (mocks only when unavoidable).
- Assert specific values, not truthiness. Mutation-resistant: if a one-character change to production code wouldn't fail a test, the test isn't testing.
  - Bad: `assert(result)`, `expect(items).toBeTruthy()`, `expect(fn).not.toThrow()`
  - Good: `expect(result.status).toBe('completed')`, `expect(items).toEqual(['a','b','c'])`

### Verify RED — watch it fail (mandatory)
Run the test. Confirm: it fails (not errors), the failure message matches what you expect, it fails because the feature is missing (not a typo).

If it passes, you're testing existing behaviour — fix the test. If it errors, fix the error and re-run until it fails for the right reason.

### GREEN — minimal code
Simplest code that passes. No options bag, no extra branches, no "while I'm here" cleanup.

### Verify GREEN — watch it pass (mandatory)
Test passes, other tests still pass, output pristine. If a test fails: fix the code, not the test.

### REFACTOR — clean up while green
Remove duplication, improve names, extract helpers. No new behaviour. Tests stay green.

## How Many Tests

A test earns its place by failing for a reason no other test fails for. Write one case per behaviour or boundary the change adds, and put cases that share a shape in one table-driven test. Do not test the language, the framework, or a private helper that a test of the public behaviour already exercises. More cases for a behaviour that is already pinned add reading and run time, not safety.

## When To Use

Always: new features, bug fixes, refactors, behaviour changes. Exceptions (ask first): throwaway prototypes, generated code, config files. "Just this once" is rationalization.

## Bug-fix Pattern

Bug found → write a failing test that reproduces it → run → see it fail → fix → run → see it pass. Never fix a bug without a test.

## Verification Checklist

- [ ] Every behaviour the change adds or alters has a test: one per behaviour or boundary, not one per function.
- [ ] Watched each test fail before implementing.
- [ ] Each test failed for the expected reason.
- [ ] Wrote minimal code to pass.
- [ ] All tests pass and output is pristine.
- [ ] The edge cases and error paths this change adds are covered, each once.

Any unticked box is a gap to close before `complete_step`.

## When Stuck

| Problem | Move |
|---|---|
| Don't know how to test | Write the wished-for API as the test, then build to it. |
| Test too complicated | Design too complicated — simplify the interface. |
| Need to mock everything | Code too coupled — use dependency injection. |
| Test setup huge | Extract helpers; if still huge, simplify the design. |

---

## Moe integration

- Apply this discipline within each `moe.start_step` → implement → `moe.complete_step` cycle on test-touching steps.
- The architect plans each step as the implementation plus the tests for what it changed (see `moe-planning` "Where the gate goes"); RED → GREEN happens inside that step.
- Before `moe.complete_task`, pair with `verification-before-completion` — capture the actual test-run output (count + pass/fail) in your `complete_step` `note` so QA has evidence rather than a claim.
