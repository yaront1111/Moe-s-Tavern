---
name: regression-check
description: Use before moe.complete_task. Runs the broader test suite (not just the tests you added) to confirm nothing unrelated broke. The goal is zero regressions. Better to find out now than in a QA reject comment.
when_to_use: Worker, after the final implementation step is done, before moe.complete_task.
allowed-tools: Bash, Read
---

# Regression Check

Before `moe.complete_task`, run the broader suite. The goal is zero regressions. Finding out now is cheap; finding out from a `qa_reject` is expensive.

## What to run

The plan should name the suite. If it doesn't, work out from your changes:

| Touched | Run at minimum |
|---------|----------------|
| `packages/moe-daemon/src/...` | `cd packages/moe-daemon && npm test` |
| `packages/moe-proxy/src/...` | `cd packages/moe-proxy && npm test` |
| `moe-jetbrains/src/...` | `cd moe-jetbrains && ./gradlew test` |
| Multi-package or shared types | All of the above |
| Scripts / wrappers | Manually exercise the wrapper end-to-end |
| Docs only | Optional; lint the markdown |

If a project has a `test:all` or `npm run check` script, prefer that — it usually wires lint + type-check + tests in the right order.

## How to read the output

- **All green?** Capture the test count + pass count in your `complete_step` summary as evidence. Don't claim green without numbers.
- **Failures in tests you didn't touch?** That's a regression. Investigate before `complete_task`. Usual suspects: shared util change, type-signature change, fixture / seed dependency, test ordering.
- **Failures in tests you did touch?** Either the test is wrong or the code is wrong. Fix one.
- **Flake?** Run it again. If it's still red on the second run, it's not flake, it's a bug.

## What "broader" means

It's tempting to run only the tests in the package you edited. Don't. Cross-package dependencies are exactly where regressions hide. Specifically:

- Type changes in `schema.ts` ripple through every tool and the plugin.
- Migrations affect `load()` for every existing `.moe/`.
- Wire-protocol changes (new fields in WebSocket / MCP messages) need both ends tested.

## When to skip

- Doc-only changes (formatter / spell-check is enough).
- Pure addition of a new file that nothing imports yet.

For everything else, run it. The 90 seconds you save by skipping is the 4 hours you spend on a `qa_reject` round trip.

## What to put in the complete_step / complete_task summary

Be specific. Not "tests pass" — "342 / 342 tests pass; ran `npm test` in moe-daemon and moe-proxy; type-check clean." Numbers + commands let QA verify quickly without re-running everything.
