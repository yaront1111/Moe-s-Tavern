# CQ-M04 frozen baseline (n=1 execution)

Observed facts of one run of each of the 20 frozen CQ-M03 workloads through the
CQ-M04b driver, plus the CQ-M04 report built from them. Nothing here is a
savings, quality-improvement or statistical-significance claim.

## Configuration
- Human go-ahead: comment-539240c524f64e38aece342d4f31431c (task-e4adf15c84f0433a9457ea5e8968c3de), agent-run in board order.
- Run configuration: comment-700a6a5111ad4a57a3340a2dac0ab586 (task-0ece1a3552944298af911356f149e150): today's model/effort defaults (no `settings.models` pins), one run per workload, 60-minute wall-clock cap per workload, capped runs kept with partial counters, missing counters stay unknown.
- Billing: the shared rotating Claude account pool, comment-a3a791e7133f42d7bae40ac19fd41ebb (timestamp corrected by comment-f057895eaa4b409492ae94b9df01fff4).
- Moe commit under test: `6eb56809b4038945cfc09f95c3b9138f107dc62f` (a `git archive` of the daemon, proxy, scripts and docs; the driver and report code are byte-identical to the later checkout HEAD).
- Corpus version: 1 (`expected.json` holds the per-case digests).
- Run window (UTC): 2026-10-24T17:52:35Z to 2026-10-24T21:54:51Z.
- Platform: WSL2 Linux 6.18.33.1-microsoft-standard, Node v24.21.0, Claude Code 2.1.285 (`/usr/local/bin/claude`, as recorded in every record's `cliVersion`).
- Roles and models: as listed in `report.md` (per-role model and effort are the reported values; unobserved ones stay `unknown`).
- Seats shared the machine and its Claude accounts with the live fleet (load average roughly 6 to 42 during the run). Contention and any account waits count toward the 60-minute cap. No run was capped.

## Batch commands
```
flock -n batch.lock bash batch.sh            # setsid nohup, detached
# per workload id in ids.txt, in manifest order; skipped if a record exists, stop if a run root has no record
npx tsx src/benchmarks/baselineRun.ts --workload <id> --cap-minutes 60 --parent <runs> --moe-commit 6eb56809b4038945cfc09f95c3b9138f107dc62f
```
Environment: every `MOE_*` variable unset except `MOE_ACCOUNTS_FILE` (pinned to the shared registry) and `MOE_SERENA_PATH`; Linux-only PATH plus the claude directory.

## Incidents
- 2026-10-24T16:53Z: the first start was refused before any paid usage because no account registry was configured on this seat (no workload started, no record). Resolved by the human billing decision above; preflight then used a read-only `claude auth status --json` probe (exit status only) on the six listed accounts, all exit 0, registry hash unchanged.
- No failed, aborted or capped runs; no run was repeated or retried; no human-approved exception.
- 20 of 20 records have `run.status = completed`.

## Layout
- `records/<id>.json`: the 20 outcome records, byte-identical to what the driver wrote.
- `usage/<id>/logs/moe-usage/observed.jsonl`: each run's usage receipts, projected onto the receipt writer's allowlisted keys (100 rows; no key was dropped). No prompts, tool arguments, secrets or prices; seat logs, wrapper output and project trees are not archived.
- `expected.json`: the frozen manifest (corpus version, ids, categories, case digests).
- `report.json`, `report.md`: generated report.

## Regeneration
```
node scripts/analyze-baseline.mjs --records docs/baselines/cq-m04/records --project docs/baselines/cq-m04/usage --expected docs/baselines/cq-m04/expected.json --json > docs/baselines/cq-m04/report.json
node scripts/analyze-baseline.mjs --records docs/baselines/cq-m04/records --project docs/baselines/cq-m04/usage --expected docs/baselines/cq-m04/expected.json > docs/baselines/cq-m04/report.md
```
Both reproduce the committed files byte-for-byte (checked by `scripts/tests/usage-report.test.mjs`).

## Statements
- Acceptance comes from the held-out assessments only; Moe task status is record-only.
- Tokens are not cost.
- n=1, so there is no variability estimate.
- No savings, quality-improvement or significance claim is made.
- Retrieval and latency counters the driver could not observe are `unknown`, not 0.
