// Corpus-level tests for the frozen matched workload corpus (CQ-M03). Test-only benchmark
// scaffolding: nothing here runs a benchmark, calls a model or ranks outcomes. The category
// tests (M03b-e) keep owning the unsolved / corrected / plausibly-wrong controls; this file
// pins the assembled twenty, the freeze manifest and the safe-reset composition. Every
// expected id and digest below is a committed literal, never derived from the datasets.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DEFECT_WORKLOADS } from './defectWorkloads.js';
import {
  assembleMatchedCorpus, CORPUS_FREEZE, digestCorpus, MATCHED_CORPUS, MATCHED_CORPUS_FIDELITY, MATCHED_CORPUS_VERSION,
  type CorpusFreeze,
} from './matchedCorpus.js';
import { MAINTENANCE_WORKLOADS } from './maintenanceWorkloads.js';
import { NON_ROUTINE_WORKLOADS } from './non-routineWorkloads.js';
import { REFACTOR_WORKLOADS } from './refactorWorkloads.js';
import { CORPUS_COVERAGE_TAGS, digestFiles, digestWorkload, type Workload } from './workloadSnapshot.js';

const FROZEN_COMMIT = '35cf53c8444ebe1ca27e68bfbe8c5ca4896bac71';
const CATEGORIES = ['maintenance', 'defect', 'refactor', 'non-routine'] as const;
const PINNED: ReadonlyArray<readonly [id: string, digest: string]> = [
  ['maintenance-truncation-helper-reuse', 'sha256:7ca24b2f1f427b816d4700d0e1d7fd693ae1ea19fff9fb6bd9641318ac57c8cb'],
  ['maintenance-branch-policy-message', 'sha256:23fbd55723374c6fefe4ff21521985a0527403e06567cc73103d21dccd373d88'],
  ['maintenance-usage-unknown-format', 'sha256:e4ccdcdf1b5e0a6c53d7b5ec064ca6599ca37165afc3a81f3ef6881d4eec4647'],
  ['maintenance-affected-file-caller', 'sha256:8453abf76b28151ad6ba70e2ddd1824aef135c348feba799b01a42a6bce4cc47'],
  ['maintenance-cached-ref-caller', 'sha256:979820d5b41ee97cc5acbac100ff7ec8a991ecd7de18d270f674250a50a46e68'],
  ['defect-stale-positive-readiness-helper', 'sha256:89956a3f4e393e3b2bec64015f1d14c80cc0f565dafcf7f6c93ff21b0400bdd0'],
  ['defect-stale-negative-integer-option', 'sha256:7a26ee158bbb3910cc88766c49a6abf81944d13bac605240190ac45293057999'],
  ['defect-changed-caller-chat-budget', 'sha256:8ebb706f66d6bc9878d97813d5693d97c6c8f2afda4e19abaa2ffd90d4b98e82'],
  ['defect-changed-requirements-delivery-policy', 'sha256:bf3ad5151e9fd7781c4d3dd49f811565865bbf93924d011f986da996b37b8fdd'],
  ['defect-recipe-mismatch-platform', 'sha256:4eceab41f632257dbf4ff7f5fcb64ac10e0678928cc8940286ffaa6732d6c007'],
  ['refactor-usage-counter-normalization', 'sha256:0e5ded2721905748e0baba4f30dc755dd4241bc02df81bbce1ae2f0290695c9d'],
  ['refactor-chat-budget-consolidation', 'sha256:6a03fce4d6ce51d7a7b53268e9d678d142e75cc1e2c45c7429b69334cd07e15a'],
  ['refactor-shared-path-normalization', 'sha256:a386dfd1f88e0c4ea1e50252155a4f6dbf996a23c03e45f000a52105d7c78758'],
  ['refactor-detached-snapshot-returns', 'sha256:45fb5a62e4971672dd0727e4453943a7cc889f5c18f8acd48150670b088b0f84'],
  ['refactor-utf8-bounded-tail', 'sha256:ac866010f854cc7f872e5379505f396800ee9e1d4ccdd7d42221bc263a183ed6'],
  ['non-routine-cached-lookup-fingerprint', 'sha256:fd6ef3d322a706bb3855c23776b7a9c94cf38c5d4f263c9eca5db5b128e5d7b2'],
  ['non-routine-stale-negative-export-index', 'sha256:c541b6039d603d28b179f0c9c55b308e262a3c211f27e6d11fa5e3c86c3afec8'],
  ['non-routine-chat-pagination-remainder', 'sha256:bbbf2176047e5fd98fd15fe2e67ba5163f5a98b8378df4c72ef1f94480adca52'],
  ['non-routine-monotonic-attempt-generation', 'sha256:caa899cf0b4eb1488f98bbe7d132e23fd984448f288632bb415d0a91e26b1c30'],
  ['non-routine-cross-role-usage-rollup', 'sha256:74272711900a97ac7fa8a24a5605eb08710c0c9cc0de1cab597f9658fb0c9f3f'],
];
const IDS = PINNED.map(([id]) => id);
const CORPUS_DIGEST = 'sha256:9d0e42e6a8fe234662b7cfec523180b55989a303485ab9972fbbeb2b13b7be10';
const TAG_CASES: Readonly<Record<string, readonly string[]>> = {
  'reusable-helper': [
    'maintenance-truncation-helper-reuse', 'maintenance-affected-file-caller', 'defect-stale-negative-integer-option',
    'refactor-usage-counter-normalization', 'refactor-shared-path-normalization', 'refactor-utf8-bounded-tail',
    'non-routine-chat-pagination-remainder', 'non-routine-cross-role-usage-rollup',
  ],
  'stale-positive-context': ['defect-stale-positive-readiness-helper', 'non-routine-cached-lookup-fingerprint'],
  'stale-negative-context': ['defect-stale-negative-integer-option', 'non-routine-stale-negative-export-index'],
  'changed-caller': ['maintenance-cached-ref-caller', 'defect-changed-caller-chat-budget'],
  'changed-requirements': [
    'maintenance-branch-policy-message', 'maintenance-usage-unknown-format', 'defect-changed-requirements-delivery-policy',
    'non-routine-monotonic-attempt-generation',
  ],
  'recipe-mismatch': ['maintenance-cached-ref-caller', 'defect-recipe-mismatch-platform'],
};
const STALE_ARTIFACTS: Readonly<Record<string, string>> = {
  'defect-stale-positive-readiness-helper': 'context/stale-notes.md',
  'defect-stale-negative-integer-option': 'context/stale-notes.md',
  'defect-changed-caller-chat-budget': 'context/cached-signatures.json',
  'defect-changed-requirements-delivery-policy': 'context/stale-review-notes.md',
  'defect-recipe-mismatch-platform': 'recipes/verify.json',
};
const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATASET_BY_CATEGORY = {
  maintenance: MAINTENANCE_WORKLOADS, defect: DEFECT_WORKLOADS, refactor: REFACTOR_WORKLOADS, 'non-routine': NON_ROUTINE_WORKLOADS,
} as const;

// ---------------------------------------------------------------------------
// Mutable copies for rejection tests
// ---------------------------------------------------------------------------

interface RawWorkload {
  contractVersion: number;
  id: string;
  category: string;
  startingCommit: string;
  source: { repository: string; paths: string[]; adaptation: string; note: string };
  intendedBehavior: string;
  initialFiles: Record<string, string>;
  assessmentFiles: Record<string, string>;
  rubric: { criteria: Array<{ id: string; description: string }>; coverageTags: string[] };
  snapshotDigest: string;
  assessmentDigest: string;
}
type Sets = Record<(typeof CATEGORIES)[number], RawWorkload[]>;

const clone = (w: Workload): RawWorkload => structuredClone(w) as unknown as RawWorkload;
const freshSets = (): Sets => Object.fromEntries(CATEGORIES.map((c) => [c, DATASET_BY_CATEGORY[c].map(clone)])) as Sets;
/** Recomputes both file digests so only the corpus freeze (not the shared validator) can notice an edit. */
function reseal(w: RawWorkload): RawWorkload {
  w.snapshotDigest = digestFiles(w.initialFiles);
  w.assessmentDigest = digestFiles(w.assessmentFiles);
  return w;
}
/** A freeze that agrees with `sets`, so the corpus-wide invariants are what rejects the data. */
function freezeFor(sets: Sets): CorpusFreeze {
  const cases = CATEGORIES.flatMap((category) => sets[category].map((w) => ({ id: w.id, category, digest: digestWorkload(w) })));
  return { version: MATCHED_CORPUS_VERSION, startingCommit: FROZEN_COMMIT, cases, corpusDigest: digestCorpus(cases) };
}
const MAX_MESSAGE = 700;
/** The rejection message; always bounded printable ASCII, so file bytes never reach a log. */
function failure(run: () => unknown): string {
  try {
    run();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    expect(message.length).toBeLessThanOrEqual(MAX_MESSAGE);
    expect(message).toMatch(/^[\x20-\x7e]*$/);
    return message;
  }
  throw new Error('expected the corpus assembly to be rejected');
}
const rejects = (sets: unknown, freeze?: CorpusFreeze): string => failure(() => assembleMatchedCorpus(sets, freeze));

// ---------------------------------------------------------------------------
// The frozen corpus
// ---------------------------------------------------------------------------

describe('frozen matched corpus', () => {
  it('holds exactly twenty cases, five per category, in the pinned order', () => {
    expect(MATCHED_CORPUS.cases.map((c) => c.id)).toEqual(IDS);
    expect(new Set(IDS).size).toBe(20);
    for (const category of CATEGORIES) {
      expect(MATCHED_CORPUS.cases.filter((c) => c.category === category)).toHaveLength(5);
      expect(MATCHED_CORPUS.cases.filter((c) => c.category === category).map((c) => c.workload.id))
        .toEqual(DATASET_BY_CATEGORY[category].map((w) => w.id));
    }
    expect([MATCHED_CORPUS.version, MATCHED_CORPUS_VERSION]).toEqual([1, 1]);
    expect([MATCHED_CORPUS.startingCommit, MATCHED_CORPUS.fidelity]).toEqual([FROZEN_COMMIT, MATCHED_CORPUS_FIDELITY]);
    expect(MATCHED_CORPUS_FIDELITY).toBe('reduced-fixture-overlay');
  });

  it('pins every per-case digest and the corpus digest to committed literals', () => {
    expect(MATCHED_CORPUS.cases.map((c) => [c.id, c.digest])).toEqual(PINNED);
    expect(MATCHED_CORPUS.cases.map((c) => [c.id, digestWorkload(c.workload)])).toEqual(PINNED);
    expect(MATCHED_CORPUS.digest).toBe(CORPUS_DIGEST);
    expect(CORPUS_FREEZE.corpusDigest).toBe(CORPUS_DIGEST);
    expect(CORPUS_FREEZE.cases.map((c) => [c.id, c.digest])).toEqual(PINNED);
    expect(CORPUS_FREEZE.startingCommit).toBe(FROZEN_COMMIT);
    expect(digestCorpus(CORPUS_FREEZE.cases)).toBe(CORPUS_DIGEST);
  });

  it('frames the corpus digest as documented, independent of the assembler implementation', () => {
    const payload = `moe-matched-corpus-v1\0${JSON.stringify([1, FROZEN_COMMIT, PINNED])}`;
    expect(CORPUS_DIGEST).toBe(`sha256:${crypto.createHash('sha256').update(payload, 'utf8').digest('hex')}`);
  });

  it('is the unchanged content of the four category datasets', () => {
    for (const category of CATEGORIES) {
      const cases = MATCHED_CORPUS.cases.filter((c) => c.category === category);
      expect(cases.map((c) => c.workload)).toEqual([...DATASET_BY_CATEGORY[category]]);
    }
  });

  it('roots each case at the full starting commit with provenance, intended behavior and an executable rubric', () => {
    for (const { workload: w } of MATCHED_CORPUS.cases) {
      expect(w.startingCommit, w.id).toBe(FROZEN_COMMIT);
      expect(w.source.repository, w.id).toBe('github.com/yaront1111/Moe-s-Tavern');
      expect(w.source.paths.length, w.id).toBeGreaterThan(0);
      expect(['reduced', 'adapted'], w.id).toContain(w.source.adaptation);
      expect(w.source.note.length, w.id).toBeGreaterThan(40);
      expect(w.intendedBehavior.length, w.id).toBeGreaterThan(80);
      expect(w.rubric.criteria.length, w.id).toBeGreaterThanOrEqual(3);
      expect(Object.keys(w.assessmentFiles).some((p) => p.endsWith('.test.mjs')), w.id).toBe(true);
      expect(w.snapshotDigest, w.id).toBe(digestFiles(w.initialFiles));
      expect(w.assessmentDigest, w.id).toBe(digestFiles(w.assessmentFiles));
    }
  });

  it('has twenty distinct tasks and starting contents, not cosmetic copies', () => {
    const cases = MATCHED_CORPUS.cases.map((c) => c.workload);
    const distinct = (values: readonly string[]): number => new Set(values).size;
    expect(distinct(cases.map((w) => w.snapshotDigest))).toBe(20);
    expect(distinct(cases.map((w) => w.assessmentDigest))).toBe(20);
    expect(distinct(cases.map((w) => w.intendedBehavior.toLowerCase().replace(/\s+/g, ' ')))).toBe(20);
    expect(distinct(cases.map((w) => w.source.note))).toBe(20);
    expect(distinct(cases.flatMap((w) => w.rubric.criteria.map((c) => `${w.id}/${c.id}`)))).toBe(
      cases.reduce((n, w) => n + w.rubric.criteria.length, 0),
    );
  });

  it('shares cosmetically identical starting contents only where the tasks differ, and pins that disclosed pair', () => {
    const squash = (text: string): string => text.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '').replace(/\s+/g, '');
    const groups = new Map<string, string[]>();
    for (const { workload: w } of MATCHED_CORPUS.cases) {
      const key = JSON.stringify(Object.values(w.initialFiles).map(squash).sort());
      groups.set(key, [...(groups.get(key) ?? []), w.id]);
    }
    expect([...groups.values()].filter((ids) => ids.length > 1)).toEqual([
      ['maintenance-usage-unknown-format', 'refactor-usage-counter-normalization'],
    ]);
    const [a, b] = ['maintenance-usage-unknown-format', 'refactor-usage-counter-normalization']
      .map((id) => MATCHED_CORPUS.cases.find((c) => c.id === id)?.workload as Workload);
    expect(a.snapshotDigest).not.toBe(b.snapshotDigest);
    expect(a.assessmentDigest).not.toBe(b.assessmentDigest);
    expect(a.intendedBehavior).not.toBe(b.intendedBehavior);
    expect(a.rubric.criteria.map((c) => c.id)).not.toEqual(b.rubric.criteria.map((c) => c.id));
  });

  it('covers every shared coverage tag through pinned fixture ids', () => {
    expect(Object.keys(TAG_CASES).sort()).toEqual([...CORPUS_COVERAGE_TAGS].sort());
    for (const [tag, ids] of Object.entries(TAG_CASES)) {
      const tagged = MATCHED_CORPUS.cases.filter((c) => c.workload.rubric.coverageTags.includes(tag)).map((c) => c.id);
      expect(tagged, tag).toEqual(ids);
    }
  });

  it('carries real stale-context artifacts and platform-declared argv recipes, not vacuous tags', () => {
    for (const [id, artifact] of Object.entries(STALE_ARTIFACTS)) {
      const text = MATCHED_CORPUS.cases.find((c) => c.id === id)?.workload.initialFiles[artifact];
      expect(text, `${id} ${artifact}`).toContain('may be outdated');
      expect(text, id).toContain('Synthetic stale artifact');
    }
    const recipeCase = MATCHED_CORPUS.cases.find((c) => c.id === 'defect-recipe-mismatch-platform');
    const { recipes } = JSON.parse(recipeCase?.workload.initialFiles['recipes/verify.json'] ?? '{}') as { recipes: Array<Record<string, unknown>> };
    expect(recipes.map((r) => r.platform).sort()).toEqual(['linux', 'linux', 'win32']);
    for (const recipe of recipes) {
      expect(Array.isArray(recipe.argv) && (recipe.argv as unknown[]).every((a) => typeof a === 'string')).toBe(true);
      expect(Object.keys(recipe).filter((k) => /^(shell|command|cmd|script)$/.test(k))).toEqual([]);
    }
  });

  it('is deeply immutable', () => {
    expect(Object.isFrozen(MATCHED_CORPUS) && Object.isFrozen(MATCHED_CORPUS.cases)).toBe(true);
    expect(Object.isFrozen(CORPUS_FREEZE) && Object.isFrozen(CORPUS_FREEZE.cases) && Object.isFrozen(CORPUS_FREEZE.cases[0])).toBe(true);
    const first = MATCHED_CORPUS.cases[0];
    expect([Object.isFrozen(first), Object.isFrozen(first.workload), Object.isFrozen(first.workload.initialFiles)]).toEqual([true, true, true]);
    expect(Reflect.set(first.workload.initialFiles, 'src/extra.mjs', 'x')).toBe(false);
    expect(Reflect.set(MATCHED_CORPUS.cases, '0', first)).toBe(false);
    expect(Reflect.set(MATCHED_CORPUS, 'digest', 'x')).toBe(false);
    expect(Reflect.set(first.workload.rubric.criteria[0], 'id', 'x')).toBe(false);
    expect(Object.keys(first.workload.initialFiles)).not.toContain('src/extra.mjs');
  });

  it('assembles purely: only dataset, digest and error imports, no IO, network, clock or settings', () => {
    const source = fs.readFileSync(path.join(HERE, 'matchedCorpus.ts'), 'utf8');
    const imports = [...source.matchAll(/from '([^']+)'/g)].map((m) => m[1]).sort();
    expect(imports).toEqual([
      '../util/errors.js', './defectWorkloads.js', './maintenanceWorkloads.js', './non-routineWorkloads.js',
      './refactorWorkloads.js', './workloadSnapshot.js', 'node:crypto',
    ]);
    for (const banned of ['node:fs', 'child_process', 'node:net', 'node:http', 'fetch(', 'process.env', 'Date.now', 'Math.random', 'WebSocket']) {
      expect(source.includes(banned), banned).toBe(false);
    }
    for (const file of ['matchedCorpus.ts', 'matchedCorpus.test.ts']) {
      const text = fs.readFileSync(path.join(HERE, file), 'utf8');
      expect(/^[\t\n\x20-\x7e]*$/.test(text), `${file} must be printable ASCII`).toBe(true);
      for (const forbidden of ['ev' + 'al(', 'inner' + 'HTML', 'dangerously' + 'SetInnerHTML', '__pro' + 'to__']) {
        expect(text.includes(forbidden), `${file} ${forbidden}`).toBe(false);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Assembly rejections (every one is an unchanged-datasets-or-freeze violation)
// ---------------------------------------------------------------------------

describe('assembly accepts only the frozen data', () => {
  it('reassembles the unchanged datasets to the same corpus', () => {
    const again = assembleMatchedCorpus(freshSets());
    expect(again.digest).toBe(CORPUS_DIGEST);
    expect(again.cases.map((c) => c.digest)).toEqual(PINNED.map(([, d]) => d));
    expect(again).not.toBe(MATCHED_CORPUS);
  });

  it('rejects a missing case, a missing category, an extra category and malformed input shapes', () => {
    const missing = freshSets();
    missing.defect.pop();
    expect(rejects(missing)).toMatch(/matchedCorpus\.defect: must hold exactly 5 workloads, got 4/);
    const dropped: Partial<Sets> = freshSets();
    delete dropped.refactor;
    expect(rejects(dropped)).toMatch(/matchedCorpus: must be a plain object with exactly the keys/);
    expect(rejects({ ...freshSets(), extra: [] })).toMatch(/matchedCorpus: must be a plain object with exactly the keys/);
    for (const bad of [null, undefined, 'x', 7, [], [freshSets()]]) expect(rejects(bad)).toMatch(/matchedCorpus: must be a plain object/);
    expect(rejects({ ...freshSets(), defect: 'nope' })).toMatch(/matchedCorpus\.defect: must be an array/);
    expect(rejects({ ...freshSets(), defect: [...freshSets().defect.slice(0, 4), 3] })).toMatch(/matchedCorpus\.defect: workloads rejected/);
  });

  it('rejects category imbalance and a workload filed under the wrong category', () => {
    const imbalance = freshSets();
    imbalance.maintenance.push(imbalance.defect.pop() as RawWorkload);
    expect(rejects(imbalance)).toMatch(/matchedCorpus\.maintenance: must hold exactly 5 workloads, got 6/);
    const swapped = freshSets();
    [swapped.maintenance[0], swapped.defect[0]] = [swapped.defect[0], swapped.maintenance[0]];
    expect(rejects(swapped)).toMatch(/matchedCorpus\.maintenance\[0\]\.category: must be "maintenance"/);
  });

  it('rejects duplicate ids within a category and duplicate coding snapshots across categories', () => {
    const duplicateId = freshSets();
    duplicateId.refactor[1] = { ...clone(REFACTOR_WORKLOADS[0]) };
    expect(rejects(duplicateId)).toMatch(/matchedCorpus\.refactor: workloads rejected: .*duplicate workload id/);
    const sameStart = freshSets();
    const copy = clone(MAINTENANCE_WORKLOADS[0]);
    copy.id = 'refactor-copy-of-truncation';
    copy.category = 'refactor';
    sameStart.refactor[0] = copy;
    expect(rejects(sameStart, freezeFor(sameStart))).toMatch(/matchedCorpus\.cases\[10\]: coding snapshot duplicates "maintenance-truncation-helper-reuse"/);
  });

  it('rejects cosmetic copies: comment and whitespace edits, or a restated intended behavior', () => {
    const asRefactor = (source: Workload, id: string): RawWorkload => {
      const copy = clone(source);
      copy.id = id;
      copy.category = 'refactor';
      copy.assessmentFiles['acceptance.test.mjs'] += '\n// assessment variant\n';
      return copy;
    };
    const cosmetic = freshSets();
    const copy = asRefactor(MAINTENANCE_WORKLOADS[0], 'refactor-cosmetic-copy');
    for (const file of Object.keys(copy.initialFiles)) copy.initialFiles[file] = `// cosmetic edit\n${copy.initialFiles[file].replace(/\n/g, '\n\n  ')}\n`;
    copy.intendedBehavior = `${copy.intendedBehavior} (a different sentence)`;
    cosmetic.refactor[0] = reseal(copy);
    expect(rejects(cosmetic, freezeFor(cosmetic))).toMatch(
      /matchedCorpus\.cases\[10\]: starting contents and assessment are a cosmetic copy of "maintenance-truncation-helper-reuse"/,
    );

    const restated = freshSets();
    const same = asRefactor(DEFECT_WORKLOADS[0], 'refactor-restated-behavior');
    same.initialFiles['src/extra.mjs'] = 'export const extra = 1;\n';
    same.intendedBehavior = same.intendedBehavior.toUpperCase().replace(/ /g, '  ');
    restated.refactor[0] = reseal(same);
    expect(rejects(restated, freezeFor(restated))).toMatch(/intended behavior restates "defect-stale-positive-readiness-helper"/);
  });

  it('rejects held-out assessment bytes that reach any case\'s coding inputs', () => {
    const leaked = freshSets();
    leaked.defect[0].initialFiles['notes/extra.txt'] = leaked.maintenance[1].assessmentFiles['acceptance.test.mjs'];
    reseal(leaked.defect[0]);
    expect(rejects(leaked, freezeFor(leaked))).toMatch(/held-out assessment of "maintenance-branch-policy-message" appears in the coding inputs of "defect-stale-positive-readiness-helper"/);
  });

  it('rejects a corpus that loses a required coverage tag', () => {
    const untagged = freshSets();
    for (const w of [untagged.maintenance[4], untagged.defect[4]]) w.rubric.coverageTags = w.rubric.coverageTags.filter((t) => t !== 'recipe-mismatch');
    expect(rejects(untagged, freezeFor(untagged))).toMatch(/matchedCorpus\.coverage: no case carries the "recipe-mismatch" tag/);
  });

  it('rejects changed starting bytes, assessment bytes, rubric, behavior or provenance against the committed freeze', () => {
    const edits: Array<[string, (w: RawWorkload) => void]> = [
      ['initial', (w) => { w.initialFiles['src/branchPolicy.mjs'] += '// changed\n'; reseal(w); }],
      ['assessment', (w) => { w.assessmentFiles['acceptance.test.mjs'] += '// changed\n'; reseal(w); }],
      ['rubric', (w) => { w.rubric.criteria[0].description += ' Changed.'; }],
      ['behavior', (w) => { w.intendedBehavior += ' Changed.'; }],
      ['source-note', (w) => { w.source.note += ' Changed.'; }],
      ['adaptation', (w) => { w.source.adaptation = w.source.adaptation === 'adapted' ? 'reduced' : 'adapted'; }],
      ['tags', (w) => { w.rubric.coverageTags = [...w.rubric.coverageTags, 'extra-tag']; }],
    ];
    for (const [name, edit] of edits) {
      const changed = freshSets();
      edit(changed.maintenance[1]);
      expect(rejects(changed), name).toMatch(
        /matchedCorpus\.freeze\.cases\[1\]: digest of "maintenance-branch-policy-message" changed \(expected sha256:23fbd557[0-9a-f]+, got sha256:[0-9a-f]{64}\)/,
      );
    }
  });

  it('rejects an edit that the shared validator catches, without echoing file contents', () => {
    const secret = 'SECRET-FIXTURE-MARKER-9f31';
    const stale = freshSets();
    stale.maintenance[0].initialFiles['src/textBudget.mjs'] += `// ${secret}\n`;
    const message = rejects(stale);
    expect(message).toMatch(/matchedCorpus\.maintenance: workloads rejected: .*snapshotDigest/);
    expect(message).not.toContain(secret);
    const noRecipe = freshSets();
    const w = noRecipe.refactor[0];
    w.assessmentFiles = { 'acceptance.mjs': w.assessmentFiles['acceptance.test.mjs'] };
    reseal(w);
    expect(rejects(noRecipe)).toMatch(/matchedCorpus\.refactor: workloads rejected: .*\*\.test\.mjs/);
  });

  it('rejects data that only agrees with a rewritten baseline: the default freeze is the committed one', () => {
    const changed = freshSets();
    changed.defect[2].intendedBehavior += ' Changed.';
    expect(rejects(changed)).toMatch(/matchedCorpus\.freeze\.cases\[7\]: digest of "defect-changed-caller-chat-budget" changed/);
    const rebased = assembleMatchedCorpus(changed, freezeFor(changed));
    expect(rebased.digest).not.toBe(CORPUS_DIGEST);
    expect(MATCHED_CORPUS.digest).toBe(CORPUS_DIGEST);
  });

  it('rejects a malformed or inconsistent freeze manifest before comparing any data', () => {
    const base = JSON.parse(JSON.stringify(CORPUS_FREEZE)) as { version: number; startingCommit: string; cases: Array<{ id: string; category: string; digest: string }>; corpusDigest: string };
    const variant = (edit: (f: typeof base) => void): CorpusFreeze => {
      const f = JSON.parse(JSON.stringify(base)) as typeof base;
      edit(f);
      return f as unknown as CorpusFreeze;
    };
    const cases: Array<[RegExp, CorpusFreeze]> = [
      [/freeze\.version: must be 1/, variant((f) => { f.version = 2; })],
      [/freeze\.startingCommit: must be the full frozen commit/, variant((f) => { f.startingCommit = FROZEN_COMMIT.slice(0, 7); })],
      [/freeze\.cases: must hold exactly 20 cases, got 19/, variant((f) => { f.cases.pop(); })],
      [/freeze\.cases\[0\]\.digest: must be "sha256:"/, variant((f) => { f.cases[0].digest = 'sha256:abc'; })],
      [/freeze\.cases\[3\]\.category: must be "maintenance"/, variant((f) => { f.cases[3].category = 'defect'; })],
      [/freeze\.cases\[1\]\.id: must be unique/, variant((f) => { f.cases[1].id = f.cases[0].id; })],
      [/freeze\.corpusDigest: does not match the listed cases/, variant((f) => { f.cases[4].digest = f.cases[3].digest; })],
      [/freeze\.corpusDigest: must be "sha256:"/, variant((f) => { f.corpusDigest = 'nope'; })],
    ];
    for (const [pattern, freeze] of cases) expect(rejects(freshSets(), freeze)).toMatch(pattern);
    expect(failure(() => assembleMatchedCorpus(freshSets(), null as unknown as CorpusFreeze))).toMatch(/matchedCorpus\.freeze: must be a plain object/);
    const reordered = variant((f) => { [f.cases[0], f.cases[1]] = [f.cases[1], f.cases[0]]; });
    reordered.corpusDigest = digestCorpus(reordered.cases);
    expect(rejects(freshSets(), reordered)).toMatch(
      /matchedCorpus\.freeze\.cases\[0\]: frozen id "maintenance-branch-policy-message" does not match "maintenance-truncation-helper-reuse" at this position/,
    );
  });
});
