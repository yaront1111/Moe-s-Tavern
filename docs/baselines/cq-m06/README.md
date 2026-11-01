# CQ rollout promotion decision

This record decides whether to promote the strong execution profile (`verified-local`) from the CQ-M04c baseline
(n=1, 20 workloads, legacy workflow). It is built from existing evidence only: no agent workload, no pilot batch and
no profile change was run for it. It is not a savings or quality-improvement claim.

Decision: non-promotion

`verified-local` stays disabled. Evidence was read on 2026-11-01 at repository HEAD `b0ca24d8` on
`moe/work-2026-10-24`. Every baseline figure below is derived from `docs/baselines/cq-m04/report.json`, and
`packages/moe-daemon/src/benchmarks/rolloutDecision.test.ts` recomputes each one on every test run.

## Baseline inputs
- Workloads: 20
- Repetitions per workload: 1
- Moe commits: 6eb56809b4038945cfc09f95c3b9138f107dc62f
- Corpus versions: 1
- Workflow: legacy. Role models and efforts are as listed in `report.md`.

## Gates
A promotion needs every gate met. None is. Status words: `unmet` (not satisfied), `unsupported` (a capability
`activationGaps()` still lists as missing).

| Gate | Status | Evidence |
|---|---|---|
| readiness | unmet | `assertExecutionProfileReady('verified-local')` refuses with `EXECUTION_PROFILE_NOT_READY`: no held readiness evaluation grants it. |
| vm | unsupported | `activationGaps()` lists `vm-provisioning-uncertified`. A settings change to `verified-local` is refused (while readiness is unmet the code is `EXECUTION_PROFILE_NOT_READY`) and recorded as a refused `PROJECT_SETTINGS_UPDATED` activation whose `unsupportedCapabilities` names the gap (CQ-M05). |
| check | unsupported | `activationGaps()` lists `check-runner-uncertified`; refused and recorded the same way. |
| client residuals | unmet | `activationGaps()` no longer lists a client gap, because the daemon advertises `verifiedLocal` wire support. CQ-I06 still records open client items: the profile and evidence status UI and the VS Code `latestCheckRun` view have no owner (human decision), and the client tests are headless only. |
| matched pilot | unmet | Not run. It needs a separately approved paid batch on the same corpus digest, caps and role models. |
| retrieval baseline | unmet | sourceRetrievals is unknown in 20 of 20 workloads, so no retrieval comparison can be made against this baseline. |

## Targets
Both targets are the rollout's goals, not results. Pilot values do not exist.

| Target | Baseline (CQ-M04c) | Pilot | Outcome |
|---|---|---|---|
| 50% fewer planner invocations (target) | mean planner sessions per workload: 1 (observed in 20 of 20 workloads) | unmeasured | unmeasured |
| 30% less repeated source retrieval (target) | sourceRetrievals is unknown in 20 of 20 workloads | unmeasured | unmeasurable against this baseline |

Every baseline row has exactly one planner session, so the baseline itself shows no planner reuse. Whether a pilot arm
could show a reduction is untested.

## Accepted-change cost, time and quality (baseline only)
Quality, from the held-out acceptance assessment in `report.json`:
- Accepted: 20
- Rejected: 0
- Not assessed: 0

Cost, from the observed usage counters (incomplete: counters a CLI did not report stay unknown):
- Observed tokens: 38926322 (incomplete)
- Observed tokens per accepted change: 1946316.1
- Reasoning tokens: unknown

Tokens are not monetary cost. No price, billing or per-account figure is derived here.

Time:
- Median end-to-end time: 669869 ms (observed in 20 of 20 workloads)
- Time to first code change: firstCodeChangeMs is unknown in 20 of 20 workloads.

Pilot: unmeasured. Claimed savings: none.

## Platform support
Status words: `certified` means a recorded certification report validated (`validateCertificationReport`), nothing more;
it does not enable `verified-local`. Both reports certified commit `106284b0`, not HEAD, and each has `executionReady`
false. Source: `docs/CERTIFICATION.md` (CQ-R13) and the CQ-I06 completion summary (that task was in review at the time of writing).

| Platform | Status | Evidence |
|---|---|---|
| linux x64 (Ubuntu 24.04 under WSL2, Multipass 1.17.0 snap) | certified | Report sha256 prefix `e793c7c6`, finished 2026-11-01T14:45:57.726Z. |
| win32 x64 (Multipass 1.17.0+win) | certified | Report sha256 prefix `48dd2675`, finished 2026-11-01T14:55:29.922Z. |
| darwin x64 | unsupported | No report and no macOS host (task rail `prop-29ce59fa`); no support is claimed. |
| darwin arm64 | unsupported | Same: no report. |
| any platform, `verified-local` enabled | unsupported | The readiness gate above refuses it everywhere. |
| this host (WSL2 Linux 6.18.33.1, x86_64), probed by this task | not run | Only `uname -a`, `command -v multipass` (`/snap/bin/multipass` present) and `command -v java` (not on PATH) were probed. No certification or VM was run for this record. |
| JetBrains client | not certified | CQ-I06: the Windows Gradle test run passed (29 suites, 544 tests, 0 failures); headless only, no IDE session. |
| VS Code client | not certified | CQ-I06: lint, compile and tests passed (388 tests, 384 pass, 0 fail, 4 Windows-only skips); headless only, no IDE session, and no `latestCheckRun` view. |

Skipped real-VM tests do not certify support.

## What a promotion needs
Each item is a separately approved task:
- Certified readiness: the vm and check capabilities and the platform's hardware, all reported by the readiness holder.
- A matched pilot on the same corpus digest, caps and role models, with retrieval counters recorded in both arms. That
  means a re-run baseline, because this one has none.
- A pilot arm that can reuse planning, because every baseline row has one planner session and the planner target has
  nothing to compare against.
- Quality no worse than this baseline's, judged by the same held-out assessment.

## See also
- [CQ-M04 baseline](../cq-m04/README.md) and its [report](../cq-m04/report.md)
- [Platform certification](../../CERTIFICATION.md)
