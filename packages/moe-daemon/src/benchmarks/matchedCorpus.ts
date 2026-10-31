// =============================================================================
// Frozen matched workload corpus, version 1 (CQ-M03)
// =============================================================================
//
// Test-only benchmark scaffolding: no production module imports this file. It assembles
// the twenty cases of the M03b-e category datasets (five maintenance, defect, refactor
// and non-routine) into one immutable corpus and compares them with a committed freeze
// manifest. Matched arms later start from identical bytes and the same independent
// assessments. The module is pure: no IO, daemon, task or project state, model, network,
// price or rollout control. Snapshot creation and reset stay with the M03a materializer.
//
// Every case is a REDUCED fixture overlay adapted from Moe source at the immutable
// startingCommit (provenance in `source`), never a whole-repository archive; the corpus
// says so in `fidelity`. Held-out assessments are separate data and never reach the
// coding inputs; no corrected or negative-control source lives here at all.
//
// The freeze below is committed literals. Assembly validates the freeze itself, then
// compares the actual data with it case by case and never recomputes the expected
// baseline from the data it checks. A deliberate dataset change must update the category
// pin, the freeze, MATCHED_CORPUS_VERSION when the contract changes, and the docs.
//
// Corpus digest framing: SHA-256 over the UTF-8 bytes "moe-matched-corpus-v1\0" followed
// by JSON.stringify([version, startingCommit, [[id, caseDigest], ...]]) in corpus order,
// rendered "sha256:" + 64 lowercase hex. caseDigest is digestWorkload from M03a.

import { createHash } from 'node:crypto';
import { invalidInput } from '../util/errors.js';
import { DEFECT_WORKLOADS } from './defectWorkloads.js';
import { MAINTENANCE_WORKLOADS } from './maintenanceWorkloads.js';
import { NON_ROUTINE_WORKLOADS } from './non-routineWorkloads.js';
import { REFACTOR_WORKLOADS } from './refactorWorkloads.js';
import {
  CORPUS_COVERAGE_TAGS, digestWorkload, FROZEN_STARTING_COMMIT, validateWorkloads, WORKLOAD_CATEGORIES, WORKLOAD_LIMITS,
  type Workload, type WorkloadCategory,
} from './workloadSnapshot.js';

export const MATCHED_CORPUS_VERSION = 1;
export const MATCHED_CORPUS_FIDELITY = 'reduced-fixture-overlay';

export interface CorpusFreezeCase {
  readonly id: string;
  readonly category: WorkloadCategory;
  readonly digest: string;
}
export interface CorpusFreeze {
  readonly version: number;
  readonly startingCommit: string;
  readonly cases: readonly CorpusFreezeCase[];
  readonly corpusDigest: string;
}
export interface MatchedCase {
  readonly id: string;
  readonly category: WorkloadCategory;
  readonly digest: string;
  readonly workload: Workload;
}
export interface MatchedCorpus {
  readonly version: number;
  readonly startingCommit: string;
  readonly fidelity: typeof MATCHED_CORPUS_FIDELITY;
  readonly digest: string;
  readonly cases: readonly MatchedCase[];
}

const PER_CATEGORY = 5;
const TOTAL = PER_CATEGORY * WORKLOAD_CATEGORIES.length;
const CORPUS_DIGEST_TAG = 'moe-matched-corpus-v1\0';
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const DIGEST_RULE = 'must be "sha256:" followed by 64 lowercase hex characters';
const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_INNER_MESSAGE = 300;

/** The committed baseline: category, id and per-case digest in corpus order. */
const FROZEN_CASES: ReadonlyArray<readonly [WorkloadCategory, string, string]> = [
  ['maintenance', 'maintenance-truncation-helper-reuse', 'sha256:7ca24b2f1f427b816d4700d0e1d7fd693ae1ea19fff9fb6bd9641318ac57c8cb'],
  ['maintenance', 'maintenance-branch-policy-message', 'sha256:23fbd55723374c6fefe4ff21521985a0527403e06567cc73103d21dccd373d88'],
  ['maintenance', 'maintenance-usage-unknown-format', 'sha256:e4ccdcdf1b5e0a6c53d7b5ec064ca6599ca37165afc3a81f3ef6881d4eec4647'],
  ['maintenance', 'maintenance-affected-file-caller', 'sha256:8453abf76b28151ad6ba70e2ddd1824aef135c348feba799b01a42a6bce4cc47'],
  ['maintenance', 'maintenance-cached-ref-caller', 'sha256:979820d5b41ee97cc5acbac100ff7ec8a991ecd7de18d270f674250a50a46e68'],
  ['defect', 'defect-stale-positive-readiness-helper', 'sha256:89956a3f4e393e3b2bec64015f1d14c80cc0f565dafcf7f6c93ff21b0400bdd0'],
  ['defect', 'defect-stale-negative-integer-option', 'sha256:7a26ee158bbb3910cc88766c49a6abf81944d13bac605240190ac45293057999'],
  ['defect', 'defect-changed-caller-chat-budget', 'sha256:8ebb706f66d6bc9878d97813d5693d97c6c8f2afda4e19abaa2ffd90d4b98e82'],
  ['defect', 'defect-changed-requirements-delivery-policy', 'sha256:bf3ad5151e9fd7781c4d3dd49f811565865bbf93924d011f986da996b37b8fdd'],
  ['defect', 'defect-recipe-mismatch-platform', 'sha256:4eceab41f632257dbf4ff7f5fcb64ac10e0678928cc8940286ffaa6732d6c007'],
  ['refactor', 'refactor-usage-counter-normalization', 'sha256:0e5ded2721905748e0baba4f30dc755dd4241bc02df81bbce1ae2f0290695c9d'],
  ['refactor', 'refactor-chat-budget-consolidation', 'sha256:6a03fce4d6ce51d7a7b53268e9d678d142e75cc1e2c45c7429b69334cd07e15a'],
  ['refactor', 'refactor-shared-path-normalization', 'sha256:a386dfd1f88e0c4ea1e50252155a4f6dbf996a23c03e45f000a52105d7c78758'],
  ['refactor', 'refactor-detached-snapshot-returns', 'sha256:45fb5a62e4971672dd0727e4453943a7cc889f5c18f8acd48150670b088b0f84'],
  ['refactor', 'refactor-utf8-bounded-tail', 'sha256:ac866010f854cc7f872e5379505f396800ee9e1d4ccdd7d42221bc263a183ed6'],
  ['non-routine', 'non-routine-cached-lookup-fingerprint', 'sha256:fd6ef3d322a706bb3855c23776b7a9c94cf38c5d4f263c9eca5db5b128e5d7b2'],
  ['non-routine', 'non-routine-stale-negative-export-index', 'sha256:c541b6039d603d28b179f0c9c55b308e262a3c211f27e6d11fa5e3c86c3afec8'],
  ['non-routine', 'non-routine-chat-pagination-remainder', 'sha256:bbbf2176047e5fd98fd15fe2e67ba5163f5a98b8378df4c72ef1f94480adca52'],
  ['non-routine', 'non-routine-monotonic-attempt-generation', 'sha256:caa899cf0b4eb1488f98bbe7d132e23fd984448f288632bb415d0a91e26b1c30'],
  ['non-routine', 'non-routine-cross-role-usage-rollup', 'sha256:74272711900a97ac7fa8a24a5605eb08710c0c9cc0de1cab597f9658fb0c9f3f'],
];

export const CORPUS_FREEZE: CorpusFreeze = Object.freeze({
  version: 1,
  startingCommit: '35cf53c8444ebe1ca27e68bfbe8c5ca4896bac71',
  cases: Object.freeze(FROZEN_CASES.map(([category, id, digest]) => Object.freeze({ id, category, digest }))),
  corpusDigest: 'sha256:9d0e42e6a8fe234662b7cfec523180b55989a303485ab9972fbbeb2b13b7be10',
});

/** Corpus identity over the ordered (id, case digest) pairs; see the framing note above. */
export function digestCorpus(cases: ReadonlyArray<{ readonly id: string; readonly digest: string }>): string {
  const rows = cases.map((c) => [c.id, c.digest]);
  const payload = `${CORPUS_DIGEST_TAG}${JSON.stringify([MATCHED_CORPUS_VERSION, FROZEN_STARTING_COMMIT, rows])}`;
  return `sha256:${createHash('sha256').update(payload, 'utf8').digest('hex')}`;
}

// -----------------------------------------------------------------------------
// Errors: bounded, printable ASCII, never file contents
// -----------------------------------------------------------------------------

const bad = (field: string, reason: string): Error => invalidInput(field === '' ? 'matchedCorpus' : `matchedCorpus.${field}`, reason);
/** Quotes a value for a message as printable ASCII, so hidden characters never reach logs raw. */
const quoted = (s: string): string =>
  JSON.stringify(s.slice(0, WORKLOAD_LIMITS.idLength)).replace(/[^\x20-\x7e]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);

function isPlain(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** A plain object holding exactly `keys` (own properties, no extras, no symbols). */
function exactRecord(raw: unknown, field: string, keys: readonly string[]): Record<string, unknown> {
  const holds = isPlain(raw) && Reflect.ownKeys(raw).length === keys.length
    && keys.every((key) => Object.prototype.hasOwnProperty.call(raw, key));
  if (!holds) throw bad(field, `must be a plain object with exactly the keys ${keys.join(', ')}`);
  return raw as Record<string, unknown>;
}

// -----------------------------------------------------------------------------
// The freeze manifest
// -----------------------------------------------------------------------------

function checkFreezeCase(item: unknown, i: number, seen: Set<string>): CorpusFreezeCase {
  const at = `freeze.cases[${i}]`;
  const row = exactRecord(item, at, ['id', 'category', 'digest']);
  const category = WORKLOAD_CATEGORIES[Math.floor(i / PER_CATEGORY)];
  if (row.category !== category) throw bad(`${at}.category`, `must be ${quoted(category)}`);
  const id = row.id;
  if (typeof id !== 'string' || id.length > WORKLOAD_LIMITS.idLength || !id.startsWith(`${category}-`) || !KEBAB.test(id)) {
    throw bad(`${at}.id`, `must be "${category}-" plus lowercase kebab-case`);
  }
  if (seen.has(id)) throw bad(`${at}.id`, 'must be unique');
  seen.add(id);
  if (typeof row.digest !== 'string' || !DIGEST.test(row.digest)) throw bad(`${at}.digest`, DIGEST_RULE);
  return Object.freeze({ id, category, digest: row.digest });
}

/** Validates the baseline itself: shape, order, commit and self-consistent corpus digest. */
function checkFreeze(raw: unknown): CorpusFreeze {
  const f = exactRecord(raw, 'freeze', ['version', 'startingCommit', 'cases', 'corpusDigest']);
  if (f.version !== MATCHED_CORPUS_VERSION) throw bad('freeze.version', `must be ${MATCHED_CORPUS_VERSION}`);
  if (f.startingCommit !== FROZEN_STARTING_COMMIT) throw bad('freeze.startingCommit', `must be the full frozen commit ${FROZEN_STARTING_COMMIT}`);
  if (!Array.isArray(f.cases)) throw bad('freeze.cases', 'must be an array');
  if (f.cases.length !== TOTAL) throw bad('freeze.cases', `must hold exactly ${TOTAL} cases, got ${f.cases.length}`);
  const seen = new Set<string>();
  const cases = f.cases.map((item: unknown, i) => checkFreezeCase(item, i, seen));
  if (typeof f.corpusDigest !== 'string' || !DIGEST.test(f.corpusDigest)) throw bad('freeze.corpusDigest', DIGEST_RULE);
  if (f.corpusDigest !== digestCorpus(cases)) throw bad('freeze.corpusDigest', 'does not match the listed cases');
  return Object.freeze({ version: MATCHED_CORPUS_VERSION, startingCommit: FROZEN_STARTING_COMMIT, cases: Object.freeze(cases), corpusDigest: f.corpusDigest });
}

// -----------------------------------------------------------------------------
// The datasets
// -----------------------------------------------------------------------------

/** The shared validator, with its message folded into a bounded printable-ASCII corpus error. */
function validateCategory(category: WorkloadCategory, set: readonly unknown[]): readonly Workload[] {
  try {
    return validateWorkloads(set);
  } catch (err) {
    const inner = err instanceof Error ? err.message.replace(/^\[[A-Z_]+\] (?:Invalid )?/, '') : 'unreadable workload data';
    throw bad(category, `workloads rejected: ${inner.replace(/[^\x20-\x7e]/g, '?').slice(0, MAX_INNER_MESSAGE)}`);
  }
}

function checkSets(raw: unknown): readonly Workload[] {
  const sets = exactRecord(raw, '', WORKLOAD_CATEGORIES);
  return WORKLOAD_CATEGORIES.flatMap((category) => {
    const set = sets[category];
    if (!Array.isArray(set) || Object.getPrototypeOf(set) !== Array.prototype) throw bad(category, 'must be an array');
    if (set.length !== PER_CATEGORY) throw bad(category, `must hold exactly ${PER_CATEGORY} workloads, got ${set.length}`);
    const workloads = validateCategory(category, set);
    workloads.forEach((w, i) => {
      if (w.category !== category) throw bad(`${category}[${i}].category`, `must be ${quoted(category)}`);
    });
    return workloads;
  });
}

/** Comments and whitespace removed: two sources that differ only cosmetically share this form. */
const squash = (text: string): string => text.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '').replace(/\s+/g, '');
const squashAll = (files: Readonly<Record<string, string>>): string[] => Object.values(files).map(squash).sort();
/** Starting contents plus assessments: cases may share a source file, but not both halves of a task. */
const taskKey = (w: Workload): string =>
  createHash('sha256').update(JSON.stringify([squashAll(w.initialFiles), squashAll(w.assessmentFiles)]), 'utf8').digest('hex');
const behaviorKey = (w: Workload): string => w.intendedBehavior.toLowerCase().replace(/\s+/g, ' ').trim();

/** Twenty cases must be twenty different tasks: distinct snapshots, assessments and intended behavior, no cosmetic copies. */
function checkDistinct(cases: readonly Workload[]): void {
  const rules: ReadonlyArray<readonly [(w: Workload) => string, string]> = [
    [(w) => w.snapshotDigest, 'coding snapshot duplicates'],
    [(w) => w.assessmentDigest, 'assessment duplicates'],
    [behaviorKey, 'intended behavior restates'],
    [taskKey, 'starting contents and assessment are a cosmetic copy of'],
  ];
  for (const [key, reason] of rules) {
    const seen = new Map<string, string>();
    cases.forEach((w, i) => {
      const first = seen.get(key(w));
      if (first !== undefined) throw bad(`cases[${i}]`, `${reason} ${quoted(first)}`);
      seen.set(key(w), w.id);
    });
  }
}

/** The per-case separation check only sees one case; a held-out file must not reach ANY case's coding inputs. */
function checkLeaks(cases: readonly Workload[]): void {
  const owners = new Map<string, string>();
  for (const w of cases) for (const content of Object.values(w.initialFiles)) owners.set(content, w.id);
  for (const w of cases) {
    for (const content of Object.values(w.assessmentFiles)) {
      const owner = owners.get(content);
      if (owner !== undefined) throw bad('cases', `held-out assessment of ${quoted(w.id)} appears in the coding inputs of ${quoted(owner)}`);
    }
  }
}

function checkCoverage(cases: readonly Workload[]): void {
  for (const tag of CORPUS_COVERAGE_TAGS) {
    if (!cases.some((w) => w.rubric.coverageTags.includes(tag))) throw bad('coverage', `no case carries the ${quoted(tag)} tag`);
  }
}

/** Case-by-case comparison with the committed baseline: nothing is filtered, reordered or re-derived. */
function compareWithFreeze(cases: readonly Workload[], freeze: CorpusFreeze): readonly MatchedCase[] {
  return cases.map((w, i) => {
    const at = `freeze.cases[${i}]`;
    const frozen = freeze.cases[i];
    if (frozen.id !== w.id) throw bad(at, `frozen id ${quoted(frozen.id)} does not match ${quoted(w.id)} at this position`);
    const digest = digestWorkload(w);
    if (digest !== frozen.digest) throw bad(at, `digest of ${quoted(w.id)} changed (expected ${frozen.digest}, got ${digest})`);
    return Object.freeze({ id: w.id, category: w.category, digest, workload: w });
  });
}

/**
 * Assembles and checks a corpus from the four category sets against `freeze` (the committed
 * baseline by default; another baseline is for tests). Throws a bounded INVALID_INPUT error
 * and returns nothing on any deviation. The result is deeply frozen.
 */
export function assembleMatchedCorpus(rawSets: unknown, rawFreeze: unknown = CORPUS_FREEZE): MatchedCorpus {
  const freeze = checkFreeze(rawFreeze);
  const cases = checkSets(rawSets);
  checkDistinct(cases);
  checkLeaks(cases);
  checkCoverage(cases);
  const matched = compareWithFreeze(cases, freeze);
  return Object.freeze({
    version: freeze.version,
    startingCommit: freeze.startingCommit,
    fidelity: MATCHED_CORPUS_FIDELITY,
    digest: freeze.corpusDigest,
    cases: Object.freeze(matched),
  });
}

/** The corpus for the matched-measurement runner (M04). Import fails loudly if any dataset drifted from the freeze. */
export const MATCHED_CORPUS: MatchedCorpus = assembleMatchedCorpus({
  maintenance: MAINTENANCE_WORKLOADS,
  defect: DEFECT_WORKLOADS,
  refactor: REFACTOR_WORKLOADS,
  'non-routine': NON_ROUTINE_WORKLOADS,
});
