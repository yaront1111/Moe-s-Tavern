---
name: verification-before-completion
description: Use before moe.complete_task, and before any claim that work passes, is fixed or is done. Run the command the plan named (narrow for a mid-epic task, full for the epic's final task) fresh, read its output, and submit that run as the completion evidence. Covers reading a red run, including a red gate you did not cause.
when_to_use: Worker, after the last step and before moe.complete_task; any role about to report that something passes.
---

# Verification Before Completion

A completion claim is only as good as the fresh command output behind it. Before `moe.complete_task`, run the command the plan named, read the result, and submit that run as the evidence. Do it **once, after your last edit**, not after every step.

## The gate

1. **Identify** the command that proves the claim. The plan's verification step names it.
2. **Run** it in full, now. A run from before your last edit says nothing about the code as it stands.
3. **Read** the output: the exit code, the failure count, the names of what failed.
4. **Report what it says.** Green: call `moe.complete_task { verification: { command, exitCode: 0, outputTail } }` (the call is rejected without it) and put the counts in your summary. Not green: say so with the output, then fix it or follow "A red gate you did not cause".

"Should pass now", a clean linter, an earlier run and a subagent's report are not evidence. QA re-runs the same command.

| Claim | What proves it |
|-------|----------------|
| Tests pass | This run's output: 0 failures |
| Bug fixed | The original symptom, tested again |
| A regression test works | It fails with the fix reverted and passes with it restored |
| A subagent finished the job | The diff it left, read by you |
| Every DoD item is met | Each item checked against the diff, not "tests pass" |

## How wide

The plan sizes the gate deliberately. Do not silently widen or narrow it.

- **Mid-epic task** (`moe.get_context` → `task.isEpicFinal` is false): the narrow suite the plan named, which is your package or the test files covering what you changed. You are proving *your slice*; the epic's final task owns the full-system pass.
- **Epic-final task, or a task with no epic** (`task.isEpicFinal` is true): the full run. Every affected package, plus whatever integration or smoke run the plan named.
- **Shared types, schema, wire protocol or a migration**, at any position: the full run. These break code outside the package you edited (both ends of a protocol, every reader of a stored shape), and the epic's final task is too late to find out.
- **Doc-only or config-only change**: the plan's proving command (a linter, a build, a grep) is the whole gate.

If the plan names no command, use the project's own test entry point for the packages you touched, and name the command you chose in your summary.

## Reading a red run

- **Tests you touched fail.** Either the test is wrong or the code is. Fix one.
- **Tests you did not touch fail.** Treat it as your regression until a baseline says otherwise. Usual suspects: a shared helper, a changed signature, a fixture or seed, test ordering. If the same failure happens without your change, see the next section.
- **Flake?** Run it again. Red twice is a bug, not a flake.

## A red gate you did not cause

Another seat can turn your gate red: an uncommitted edit in a shared checkout, a checkpoint that landed tests ahead of their code, a flaky test. That is not a reason to `moe.report_blocked`, and not a reason to add a `dependsOn` on whoever owns the failure. Both park your finished work behind theirs for nothing.

1. Run the gate in a clean clone of the branch tip plus only your own files, so another seat's uncommitted edits cannot reach it.
2. Still red outside your change? Run the same command at the same tip without your files. The same failures there mean they are not yours.
3. If the failure stops the command before your tests run (a type error in someone else's file, say), gate on the last commit where it does not, plus your files, and name that commit in your evidence.
4. File the failure as a `bug:` row if nobody has. Then call `moe.complete_task`. `verification.exitCode` must be 0, so submit a command whose exit reflects your change, such as one that passes when its failing set equals the baseline's.
5. List every run and its failures in your summary. Never describe a red run as green.

Baseline green and red with your files? It's yours: fix it. A project rail that sets a different bar wins over this section.

## The summary

Be specific: "342 / 342 tests pass; ran `npm test` in moe-daemon and moe-proxy; type-check clean", not "tests pass". Commands and counts let QA audit the claim, and a summary with no numbers invites a reject.
