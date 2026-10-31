# Frozen matched workload corpus (CQ-M03)

Contract guide for the twenty frozen workloads that later matched measurement (CQ-M04) starts from. It describes
what is frozen, how it is verified and how to create fresh starting snapshots from it. It does not run anything.

- Code: `packages/moe-daemon/src/benchmarks/matchedCorpus.ts` (assembler and freeze), tests in `matchedCorpus.test.ts`.
- Built on: `workloadSnapshot.ts` (M03a contract, validator, digests, temp snapshots) and the four category
  datasets `maintenanceWorkloads.ts`, `defectWorkloads.ts`, `refactorWorkloads.ts`, `non-routineWorkloads.ts`.
- Test-only scaffolding: no production module imports any of it, and it starts no daemon and mutates no task or
  project state. It makes no model or network call, assumes no prices and contains no rollout control.

## What is frozen

Corpus version `1`, starting commit `35cf53c8444ebe1ca27e68bfbe8c5ca4896bac71`, fidelity
`reduced-fixture-overlay`, corpus digest
`sha256:9d0e42e6a8fe234662b7cfec523180b55989a303485ab9972fbbeb2b13b7be10`.

Each case has: a unique id, a category, the full starting commit, source provenance (`source.paths`, an
adaptation of `reduced` or `adapted`, and a note stating exactly what was dropped or changed), the intended behavior,
the coding inputs (`initialFiles`), a rubric of criteria with coverage tags, and the held-out executable assessment
(`assessmentFiles`, node:test `*.test.mjs`). Per-case digests are pinned in the category tests and again in
`CORPUS_FREEZE`. The order below is the corpus order.

| # | Id | Shared coverage tags | Adaptation |
|---|----|----------------------|------------|
| 1 | maintenance-truncation-helper-reuse | reusable-helper | adapted |
| 2 | maintenance-branch-policy-message | changed-requirements | adapted |
| 3 | maintenance-usage-unknown-format | changed-requirements | reduced |
| 4 | maintenance-affected-file-caller | reusable-helper | adapted |
| 5 | maintenance-cached-ref-caller | changed-caller, recipe-mismatch | reduced |
| 6 | defect-stale-positive-readiness-helper | stale-positive-context | adapted |
| 7 | defect-stale-negative-integer-option | stale-negative-context, reusable-helper | adapted |
| 8 | defect-changed-caller-chat-budget | changed-caller | adapted |
| 9 | defect-changed-requirements-delivery-policy | changed-requirements | adapted |
| 10 | defect-recipe-mismatch-platform | recipe-mismatch | adapted |
| 11 | refactor-usage-counter-normalization | reusable-helper | adapted |
| 12 | refactor-chat-budget-consolidation | - | adapted |
| 13 | refactor-shared-path-normalization | reusable-helper | adapted |
| 14 | refactor-detached-snapshot-returns | - | adapted |
| 15 | refactor-utf8-bounded-tail | reusable-helper | adapted |
| 16 | non-routine-cached-lookup-fingerprint | stale-positive-context | adapted |
| 17 | non-routine-stale-negative-export-index | stale-negative-context | adapted |
| 18 | non-routine-chat-pagination-remainder | reusable-helper | adapted |
| 19 | non-routine-monotonic-attempt-generation | changed-requirements | adapted |
| 20 | non-routine-cross-role-usage-rollup | reusable-helper | reduced |

Every shared tag in `CORPUS_COVERAGE_TAGS` is carried by real fixtures, not labels: stale positive and negative
context cases ship an inert stale artifact (header "may be outdated", synthetic provenance) next to the code, the
changed-caller cases change a caller's call shape, and the defect recipe-mismatch case holds platform-declared argv
data (never a shell string).

## Representativeness limits

- A case is a REDUCED or ADAPTED overlay of one to five small files (mostly Node ESM `.mjs`) derived from Moe source at the
  starting commit. It is never a whole-repository archive and must not be described as one.
- Some fixtures re-introduce a defect or older shape on purpose, and some parts are synthetic. Each case's
  `source.note` says which. Several cases share grounding sources, so twenty cases are not twenty independent
  codebases.
- The held-out rubrics are black-box node:test files plus a few deliberate static structure checks (for example
  reuse of a shared helper). They are an independent assessment of intended behavior, not a general quality metric.
- Cases 3 and 11 start from cosmetically identical source (`src/promptCacheUsage.mjs` differs only in a header
  comment and one line wrap). Their intended behavior, rubric ids and assessments differ, so the assembler's
  cosmetic-copy rule keys on starting contents together with assessments, and a test pins exactly this pair.
  Re-pinning one case on a different source would move that case's digests and the corpus digest.

## Digest encoding and the freeze

- Per case: `digestWorkload(workload)` from M03a (`"moe-workload-v1\0"` plus a positional JSON array of every field,
  including `snapshotDigest` and `assessmentDigest`, which each cover all file paths and bytes through
  `digestFiles`).
- Corpus: SHA-256 over the UTF-8 bytes `"moe-matched-corpus-v1\0"` followed by
  `JSON.stringify([version, startingCommit, [[id, caseDigest], ...]])` in corpus order, rendered `sha256:` plus 64
  lowercase hex.
- `CORPUS_FREEZE` holds the committed literals: version, starting commit, the ordered twenty ids with categories and
  digests, and the corpus digest. `assembleMatchedCorpus(sets, freeze = CORPUS_FREEZE)` validates the freeze first,
  then the shape (exactly five per category, in the right category), cross-corpus distinctness, cross-case
  held-out leakage and coverage tags, and finally compares each case with its frozen digest. It never filters a
  missing case and never recomputes the expected baseline from the data it checks. Failures are bounded printable
  ASCII messages that never echo file contents.

Changing any frozen byte is a deliberate version change: update the category pin and test, the per-case digest and
`corpusDigest` in `CORPUS_FREEZE`, `MATCHED_CORPUS_VERSION` when the contract (not just a case) changes, this
document, and rerun the full daemon tests. Producer modules and held-out tests are not edited from the assembler.

## Independent rubric boundary

Matched arms start from identical bytes and are assessed by the same unchanged held-out files. The coding snapshot
holds `initialFiles` only. Assessments, corrected variants and plausibly-wrong negative controls never enter coding
inputs: the dataset modules export only their workload arrays, and variants live as test-only bytes in the category
tests. The assessment snapshot is a separate directory that reads the candidate from the coding snapshot through
`MOE_WORKLOAD_CANDIDATE_ROOT`.

## Creating and resetting snapshots

Snapshots are fresh owned temp directories under the OS temp location. Reset is calling the creator again: nothing
is reset in place, no API takes a destination, and no Git operation is involved, so the working tree is never
touched. `dispose()` removes only the directory the handle created and never follows a link. The example below
uses only the landed APIs and is portable across Windows, macOS and Linux.

```ts
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { MATCHED_CORPUS } from './matchedCorpus.js';
import {
  WORKLOAD_CANDIDATE_ROOT_ENV, createAssessmentSnapshot, createCodingSnapshot, readSnapshotFiles,
} from './workloadSnapshot.js';

for (const { workload } of MATCHED_CORPUS.cases) {
  const coding = await createCodingSnapshot(workload); // starting bytes only
  const held = await createAssessmentSnapshot(workload); // held-out tests only, separate directory
  try {
    // ... an arm edits files under coding.root ...
    const tests = Object.keys(workload.assessmentFiles).filter((p) => p.endsWith('.test.mjs')).sort();
    const run = spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...tests.map((p) => path.join(...p.split('/')))], {
      cwd: held.root, env: { ...process.env, NODE_OPTIONS: '', [WORKLOAD_CANDIDATE_ROOT_ENV]: coding.root },
      encoding: 'utf8', timeout: 60_000,
    });
    const finalBytes = await readSnapshotFiles(coding); // the candidate's result, read back without following links
  } finally {
    await coding.dispose();
    await held.dispose();
  }
}
// Reset a case: createCodingSnapshot(workload) again returns a new directory with the frozen bytes and digest.
```

## What this corpus is not

- Validating or assembling it is not baseline execution and not model-quality evidence. Savings or quality claims
  need matched runs scored by these unchanged rubrics together with human repair and latency.
- Usage, packet and revision correlation that a later run does not report is unknown, never zero overhead.
- Assessments run candidate code in a local node process. This corpus is not VM isolation certification, enables
  nothing in `verified-local`, and is not rollout authorization.
- The epic-wide docs sweep stays with M06; this guide only covers the corpus contract M04 consumes.
