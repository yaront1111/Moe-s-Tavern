---
name: explore-before-assume
description: Use before referencing any function, model, method, relationship, constant, or import in a plan or implementation. Verifies things actually exist in the codebase before building on top of them. Eliminates an entire class of hallucinated-API bugs.
when_to_use: Architect during planning before naming symbols in implementationPlan; worker on first start_step before editing unfamiliar code.
allowed-tools: Read, Grep, Glob
---

# Explore Before You Assume

Before referencing a symbol — any symbol — verify it exists. The cheapest bug to prevent is the one you stop yourself from inventing.

## The rule

For every function, class, method, model, attribute, relationship, constant, env var, file path, or import you're about to reference: **grep for it first**. If it doesn't show up, either it doesn't exist or you have the name wrong. Either way, stop and find out before writing a line that depends on it.

## Why this matters

Without this discipline, you will confidently call `user.clientProfile.accounts` — a relationship chain that doesn't exist. The code will look right. It will read right. It will fail at runtime, often subtly. Every team that adopts a "verify before you reference" rule eliminates an entire class of bugs immediately.

## The minimum check

For each symbol on your shortlist:

1. **Grep** with `Grep` for the name. Look for the *definition*, not just usages.
2. **Read** the file where it's defined. Confirm:
   - It accepts the args you plan to pass.
   - It returns the shape you plan to consume.
   - It's exported / public / reachable from where you'll call it.
3. **Trace one caller** if you're not sure how it's used in practice. Existing call sites are the best documentation.

## When the symbol isn't where you expect

- **Renamed?** Grep for the old name; check `git log -p --all -S '<oldname>'` to find the rename.
- **Moved?** Glob for the file by suffix (`**/User.ts`, `**/auth_service.py`).
- **Removed?** Look at the most recent commit that touched the directory. If it's gone, your plan needs to change — pick the replacement, or `moe.report_blocked` if there isn't one.
- **Never existed?** That's the win. Now you know before you've built on top of it.

## Cheap wins that pay back constantly

- For typed languages: read the type signature, not just the function name. Optional vs required, nullable, async vs sync.
- For dynamic languages: read the first 10 lines of the function body. Defaults, early returns, side effects.
- For relationships / ORM: open the model file and confirm the association is declared.
- For env / config: confirm the var is read somewhere and has a default.
- For cross-package imports: confirm the package exports the symbol from its index.

## What to do with what you find

If you're an architect: bake the verified symbol names into the step `description` so the worker doesn't re-derive them. If you're a worker: keep your edits scoped to what you've verified — drift creates new unverified symbols, and the cycle starts over.

## When to skip

Trivial doc edits, comment changes, formatting-only steps. If you're not naming a symbol, you don't need to verify one.
