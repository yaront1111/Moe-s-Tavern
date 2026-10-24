// Category tests for the frozen defect workloads (CQ-M03c). Test-only benchmark
// scaffolding: nothing here runs a benchmark or ranks outcomes. The corrected and
// plausible-wrong candidates below are test-only bytes, so no solution reaches the
// dataset module or a coding snapshot. Every control runs the case's unchanged
// held-out assessment through `node --test` against a fresh coding snapshot.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { DEFECT_WORKLOADS } from './defectWorkloads.js';
import {
  CORPUS_COVERAGE_TAGS, FROZEN_STARTING_COMMIT, SOURCE_REPOSITORY, WORKLOAD_CANDIDATE_ROOT_ENV,
  createAssessmentSnapshot, createCodingSnapshot, digestFiles, digestWorkload, readSnapshotFiles,
  validateWorkloads, type Workload, type WorkloadSnapshotHandle,
} from './workloadSnapshot.js';

type Files = Record<string, string>;
type Edit = readonly [from: string, to: string];

const IDS = [
  'defect-stale-positive-readiness-helper',
  'defect-stale-negative-integer-option',
  'defect-changed-caller-chat-budget',
  'defect-changed-requirements-delivery-policy',
  'defect-recipe-mismatch-platform',
];
const GROUNDING = [
  'packages/moe-daemon/src/delivery/executionProfile.ts',
  'packages/moe-daemon/src/delivery/policy.ts',
  'packages/moe-daemon/src/util/errors.ts',
  'packages/moe-daemon/src/util/taskPayload.ts',
  'packages/moe-daemon/src/tools/getPendingQuestions.ts',
  'packages/moe-daemon/src/util/chatPayload.ts',
  'packages/moe-daemon/src/util/cachedPlanPaths.ts',
];
/** The one stale artifact each case ships: inert data from an earlier session, never imported or read. */
const STALE_ARTIFACTS: Files = {
  'defect-stale-positive-readiness-helper': 'context/stale-notes.md',
  'defect-stale-negative-integer-option': 'context/stale-notes.md',
  'defect-changed-caller-chat-budget': 'context/cached-signatures.json',
  'defect-changed-requirements-delivery-policy': 'context/stale-review-notes.md',
  'defect-recipe-mismatch-platform': 'recipes/verify.json',
};
const PINNED_WORKLOAD_DIGESTS: Files = {
  'defect-stale-positive-readiness-helper': 'sha256:89956a3f4e393e3b2bec64015f1d14c80cc0f565dafcf7f6c93ff21b0400bdd0',
  'defect-stale-negative-integer-option': 'sha256:7a26ee158bbb3910cc88766c49a6abf81944d13bac605240190ac45293057999',
  'defect-changed-caller-chat-budget': 'sha256:8ebb706f66d6bc9878d97813d5693d97c6c8f2afda4e19abaa2ffd90d4b98e82',
  'defect-changed-requirements-delivery-policy': 'sha256:bf3ad5151e9fd7781c4d3dd49f811565865bbf93924d011f986da996b37b8fdd',
  'defect-recipe-mismatch-platform': 'sha256:4eceab41f632257dbf4ff7f5fcb64ac10e0678928cc8940286ffaa6732d6c007',
};
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const OWN_FILES = ['defectWorkloads.ts', 'defectWorkloads.test.ts']
  .map((file) => `packages/moe-daemon/src/benchmarks/${file}`);

// ---------------------------------------------------------------------------
// Control harness
// ---------------------------------------------------------------------------

interface Outcome {
  readonly exitOk: boolean;
  readonly passed: readonly string[];
  readonly failed: readonly string[];
  readonly excerpt: string;
}

const handles: WorkloadSnapshotHandle[] = [];
async function track(created: Promise<WorkloadSnapshotHandle>): Promise<WorkloadSnapshotHandle> {
  const handle = await created;
  handles.push(handle);
  return handle;
}
afterEach(async () => {
  await Promise.all(handles.splice(0).map((handle) => handle.dispose()));
});

function workload(id: string): Workload {
  const found = DEFECT_WORKLOADS.find((w) => w.id === id);
  if (!found) throw new Error(`no defect workload ${id}`);
  return found;
}

function initial(id: string, rel: string): string {
  const text = workload(id).initialFiles[rel];
  if (text === undefined) throw new Error(`${id} has no coding input ${rel}`);
  return text;
}

/** Applies exact text edits; each `from` must occur exactly once, so a stale edit fails loudly. */
function patch(text: string, edits: readonly Edit[]): string {
  return edits.reduce((out, [from, to]) => {
    const parts = out.split(from);
    if (parts.length !== 2) throw new Error(`variant edit matched ${parts.length - 1} times: ${from.slice(0, 60)}`);
    return parts.join(to);
  }, text);
}

/** A FRESH coding snapshot with test-only variant bytes written over its coding inputs. */
async function candidate(w: Workload, overrides: Files = {}): Promise<string> {
  const coding = await track(createCodingSnapshot(w));
  for (const [rel, content] of Object.entries(overrides)) {
    if (!(rel in w.initialFiles)) throw new Error(`variant path ${rel} is not a coding input of ${w.id}`);
    fs.writeFileSync(path.join(coding.root, ...rel.split('/')), content, 'utf8');
  }
  return coding.root;
}

const TAP_RESULT = /^\s*(not ok|ok) \d+ - ([a-z0-9]+(?:-[a-z0-9]+)*): /;
const sorted = (values: Iterable<string>): string[] => [...new Set(values)].sort();

/** Criterion ids from `ok` / `not ok` TAP lines; a SKIP or TODO directive never counts as a pass. */
function parseTap(stdout: string): { passed: string[]; failed: string[] } {
  const passed: string[] = [];
  const failed: string[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const match = TAP_RESULT.exec(line);
    if (!match) continue;
    const skipped = /#\s*(?:SKIP|TODO)\b/i.test(line);
    (match[1] === 'ok' && !skipped ? passed : failed).push(match[2]);
  }
  return { passed: sorted(passed), failed: sorted(failed) };
}

/** Runs the held-out assessment against `candidateRoot` (null = the variable is unset). */
async function runAssessment(w: Workload, candidateRoot: string | null): Promise<Outcome> {
  const assessment = await track(createAssessmentSnapshot(w));
  const tests = Object.keys(w.assessmentFiles).filter((p) => p.endsWith('.test.mjs')).sort();
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_OPTIONS: '' };
  delete env[WORKLOAD_CANDIDATE_ROOT_ENV];
  if (candidateRoot !== null) env[WORKLOAD_CANDIDATE_ROOT_ENV] = candidateRoot;
  const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...tests.map((p) => path.join(...p.split('/')))], {
    cwd: assessment.root, env, encoding: 'utf8', timeout: 60_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true,
  });
  const stdout = typeof result.stdout === 'string' ? result.stdout : '';
  const stderr = typeof result.stderr === 'string' ? result.stderr : '';
  // A spawn error, a signal (including the timeout kill) or a non-zero exit is never a pass.
  const exitOk = result.error === undefined && result.signal === null && result.status === 0;
  const head = `status=${String(result.status)} signal=${String(result.signal)} error=${result.error?.message ?? 'none'}`;
  return { exitOk, ...parseTap(stdout), excerpt: `${head}\n${`${stdout}\n${stderr}`.slice(-3000)}` };
}

const criteriaOf = (w: Workload): string[] => sorted(w.rubric.criteria.map((c) => c.id));
const without = (all: readonly string[], drop: readonly string[]): string[] => all.filter((id) => !drop.includes(id));

// ---------------------------------------------------------------------------
// Test-only candidate variants (never part of a workload object)
// ---------------------------------------------------------------------------

interface Control {
  readonly id: string;
  readonly corrected: Files;
  readonly wrong: Files;
  /** The criterion the plausible-wrong variant was written to break: the trap its stale artifact sets. */
  readonly wrongMustFail: string;
  /** Exact criteria the unsolved original fails (at least one intended-change criterion). */
  readonly originalFails: readonly string[];
  /** Exact criteria the plausible-wrong variant fails; includes wrongMustFail. */
  readonly wrongFails: readonly string[];
}

// Case 1: refuse through the shared assertion (corrected) versus resurrecting the stale env bypass (wrong).
const ADMISSION = 'src/admission.mjs';
const PROFILE = 'src/executionProfile.mjs';
const ADMISSION_FIXED = patch(initial(IDS[0], ADMISSION), [
  ['import { isExecutionProfileReady, resolveExecutionProfile }', 'import { assertExecutionProfileReady, resolveExecutionProfile }'],
  [`  if (!isExecutionProfileReady(profile)) {
    return { admitted: false, profile, reason: 'EXECUTION_PROFILE_NOT_READY' };
  }`, `  try {
    assertExecutionProfileReady(profile);
  } catch (err) {
    if (err?.codeName !== 'EXECUTION_PROFILE_NOT_READY') throw err;
    return { admitted: false, profile, reason: err.codeName, missingCapabilities: [...err.context.missingCapabilities] };
  }`],
]);
const ADMISSION_ENV_BYPASS = patch(ADMISSION_FIXED, [
  ['import { assertExecutionProfileReady, resolveExecutionProfile }',
    'import { assertExecutionProfileReady, isExecutionProfileReady, resolveExecutionProfile }'],
  ['  try {\n', `  // An operator marks a prepared host ready, so only an unready profile is checked.
  if (isExecutionProfileReady(profile)) return { admitted: true, profile };
  try {
`],
]);
const PROFILE_WITH_READINESS_HELPER = patch(initial(IDS[0], PROFILE), [[`    'EXECUTION_PROFILE_NOT_READY',
  );
}
`, `    'EXECUTION_PROFILE_NOT_READY',
  );
}

/** Admission readiness: verified-local is ready once an operator flags a prepared host. */
export function isExecutionProfileReady(profile) {
  return decodeProfile(profile, 'executionProfile') !== 'verified-local' || process.env.MOE_EXECUTION_PROFILE_READY === '1';
}
`]]);

// Case 2: reuse the shared normalizer (corrected) versus an inline Number/clamp copy (wrong).
const LIST = 'src/listPayload.mjs';
const LIST_IMPORT = "import { DEFAULT_TASK_LIST_LIMIT, DEFAULT_TASK_LIST_OFFSET } from './taskPayload.mjs';";
const LIST_PARSE = `  const limit = parseInt(raw.limit, 10) || DEFAULT_TASK_LIST_LIMIT;
  const offset = parseInt(raw.offset, 10) || DEFAULT_TASK_LIST_OFFSET;`;
const LIST_FIXED = patch(initial(IDS[1], LIST), [
  [LIST_IMPORT, `import {
  DEFAULT_TASK_LIST_LIMIT, DEFAULT_TASK_LIST_OFFSET, MAX_TASK_LIST_LIMIT, normalizeIntegerOption,
} from './taskPayload.mjs';`],
  [LIST_PARSE, `  const limit = normalizeIntegerOption(raw.limit, 'limit', DEFAULT_TASK_LIST_LIMIT, 1, MAX_TASK_LIST_LIMIT);
  const offset = normalizeIntegerOption(raw.offset, 'offset', DEFAULT_TASK_LIST_OFFSET, 0, Number.MAX_SAFE_INTEGER);`],
]);
const LIST_INLINE_CLAMP = patch(initial(IDS[1], LIST), [
  [LIST_IMPORT, `import { DEFAULT_TASK_LIST_LIMIT, DEFAULT_TASK_LIST_OFFSET, MAX_TASK_LIST_LIMIT } from './taskPayload.mjs';

// No shared integer-option normalizer exists, so clamp here.
const clamp = (value, min, max) => Math.max(min, Math.min(max, Math.trunc(value)));`],
  [LIST_PARSE, `  const limit = clamp(Number(raw.limit ?? DEFAULT_TASK_LIST_LIMIT), 1, MAX_TASK_LIST_LIMIT);
  const offset = clamp(Number(raw.offset ?? DEFAULT_TASK_LIST_OFFSET), 0, Number.MAX_SAFE_INTEGER);`],
]);

// Case 3: accept both call shapes (corrected) versus switching the helper to options only (wrong).
const CHAT = 'src/chatPayload.mjs';
const CHAT_DOC = '/**\n * Cut a message list';
const CHAT_HEAD = `export function capChatMessagesToResponseBudget(messages, maxContentChars, budget = MAX_CHAT_RESPONSE_CHARS) {
  let used = 0;`;
const VALIDATE_BUDGET = `  if (typeof maxContentChars !== 'number' || !Number.isFinite(maxContentChars)) {
    throw new TypeError('maxContentChars must be a finite number');
  }
  if (typeof budget !== 'number' || !Number.isFinite(budget) || budget <= 0) {
    throw new TypeError('budget must be a finite number greater than 0');
  }`;
const CHAT_BOTH_SHAPES = patch(initial(IDS[2], CHAT), [
  [CHAT_DOC, `/** Reads (messages, { maxContentChars, budget }) and the legacy (messages, maxContentChars, budget). */
function readBudgetOptions(capOrOptions, legacyBudget) {
  const options = typeof capOrOptions === 'object' && capOrOptions !== null
    ? capOrOptions
    : { maxContentChars: capOrOptions, budget: legacyBudget };
  const maxContentChars = options.maxContentChars;
  const budget = options.budget === undefined ? MAX_CHAT_RESPONSE_CHARS : options.budget;
${VALIDATE_BUDGET}
  return { maxContentChars, budget };
}

${CHAT_DOC}`],
  [CHAT_HEAD, `export function capChatMessagesToResponseBudget(messages, capOrOptions, legacyBudget) {
  const { maxContentChars, budget } = readBudgetOptions(capOrOptions, legacyBudget);
  let used = 0;`],
]);
const CHAT_OPTIONS_ONLY = patch(initial(IDS[2], CHAT), [[CHAT_HEAD, `export function capChatMessagesToResponseBudget(messages, options) {
  const { maxContentChars, budget = MAX_CHAT_RESPONSE_CHARS } = options;
${VALIDATE_BUDGET}
  let used = 0;`]]);

// Case 4: strict decoding and no relaxation (corrected) versus tolerating case and spaces (wrong).
const POLICY = 'src/deliveryPolicy.mjs';
const EFFECTIVE = 'src/effectivePolicy.mjs';
const POLICY_HEADER = '// commit: types removed and reduced to the policy vocabulary and its decoder.\n';
const POLICY_LENIENT = `/** The project's delivery policy. An unrecognised value falls back to the default. */
export function resolveDeliveryPolicy(settings) {
  const raw = settings?.deliveryPolicy;
  if (typeof raw === 'string' && Object.prototype.hasOwnProperty.call(POLICIES, raw)) return raw;
  return DEFAULT_DELIVERY_POLICY;
}`;
const decoder = (doc: string, key: string): string => `/** The project's delivery policy. ${doc} */
export function resolveDeliveryPolicy(settings) {
  const raw = settings?.deliveryPolicy;
  if (raw === undefined || raw === null) return DEFAULT_DELIVERY_POLICY;
${key}  if (typeof key === 'string' && Object.prototype.hasOwnProperty.call(POLICIES, key)) return key;
  throw invalidInput('deliveryPolicy', 'must be one of ' + DELIVERY_POLICIES.join(', '));
}`;
const POLICY_STRICT = patch(initial(IDS[3], POLICY), [
  [POLICY_HEADER, `${POLICY_HEADER}import { invalidInput } from './errors.mjs';\n`],
  [POLICY_LENIENT, decoder('Anything but absent, null or a recognised policy is refused.', '  const key = raw;\n')],
]);
const POLICY_CASE_TOLERANT = patch(initial(IDS[3], POLICY), [
  [POLICY_HEADER, `${POLICY_HEADER}import { invalidInput } from './errors.mjs';\n`],
  [POLICY_LENIENT, decoder('Settings are hand-edited, so case and stray spaces are tolerated.',
    "  const key = typeof raw === 'string' ? raw.trim().toLowerCase() : raw;\n")],
]);
const EFFECTIVE_STRICT = patch(initial(IDS[3], EFFECTIVE), [
  ['import { resolveExecutionProfile }', 'import { assertExecutionProfileReady, resolveExecutionProfile }'],
  [`  const profile = resolveExecutionProfile(settings);
  // observe only watches delivery, so it never enforces a strict policy.
  if (profile === 'observe') return 'legacy';
`, `  // observe never relaxes the live policy, and verified-local is not ready.
  assertExecutionProfileReady(resolveExecutionProfile(settings));
`],
]);

// Case 5: platform, runtime and shape checks (corrected) versus matching on the platform only (wrong).
const VERIFY = 'src/verification.mjs';
const RUNTIME_CHECK = "  if (!env.runtimes.includes(recipe.runtime)) return 'runtime-unavailable';\n";
const VERIFY_COMPATIBLE = patch(initial(IDS[4], VERIFY), [[`export function runVerification(recipes, env, exec) {
  const recipe = recipes[0];
  return { action: 'run', id: recipe.id, result: exec(recipe.argv, { env: recipe.env }) };
}`, `const isText = (value) => typeof value === 'string' && value.length > 0;

function isWellFormed(recipe) {
  if (typeof recipe !== 'object' || recipe === null) return false;
  const { id, platform, runtime, argv, env } = recipe;
  return isText(id) && isText(platform) && isText(runtime)
    && Array.isArray(argv) && argv.length > 0 && argv.every(isText) && argv[0] === runtime
    && typeof env === 'object' && env !== null && !Array.isArray(env) && Object.values(env).every((v) => typeof v === 'string');
}

/** Why a stored recipe cannot run on this host, or null when it can. The shape is checked first. */
function rejectionOf(recipe, env) {
  if (!isWellFormed(recipe)) return 'malformed-recipe';
  if (recipe.platform !== env.platform) return 'platform-mismatch';
${RUNTIME_CHECK}  return null;
}

export function runVerification(recipes, env, exec) {
  const rejected = [];
  for (const recipe of recipes) {
    const reason = rejectionOf(recipe, env);
    if (reason === null) return { action: 'run', id: recipe.id, result: exec(recipe.argv, { env: recipe.env }) };
    rejected.push({ id: typeof recipe?.id === 'string' ? recipe.id : null, reason });
  }
  return { action: 'reject', reason: 'NO_COMPATIBLE_RECIPE', rejected };
}`]]);
const VERIFY_PLATFORM_ONLY = patch(VERIFY_COMPATIBLE, [[RUNTIME_CHECK, '  // Each platform image ships the runtimes its recipes name.\n']]);

const CONTROLS: readonly Control[] = [
  {
    id: IDS[0], corrected: { [ADMISSION]: ADMISSION_FIXED },
    wrong: { [ADMISSION]: ADMISSION_ENV_BYPASS, [PROFILE]: PROFILE_WITH_READINESS_HELPER },
    wrongMustFail: 'ignores-readiness-env',
    originalFails: ['loads-with-frozen-exports', 'admits-legacy-observe', 'refuses-verified-local', 'ignores-readiness-env',
      'rejects-malformed-profile'],
    wrongFails: ['ignores-readiness-env', 'shared-module-unchanged'],
  },
  {
    id: IDS[1], corrected: { [LIST]: LIST_FIXED }, wrong: { [LIST]: LIST_INLINE_CLAMP },
    wrongMustFail: 'rejects-non-numbers',
    originalFails: ['clamps-and-truncates', 'rejects-non-numbers', 'reuses-integer-option-helper'],
    wrongFails: ['rejects-non-numbers', 'reuses-integer-option-helper'],
  },
  {
    id: IDS[2], corrected: { [CHAT]: CHAT_BOTH_SHAPES }, wrong: { [CHAT]: CHAT_OPTIONS_ONLY },
    wrongMustFail: 'legacy-positional-still-works',
    originalFails: ['accepts-options-shape', 'always-delivers-one', 'keeps-undelivered-tail', 'rejects-bad-options'],
    wrongFails: ['legacy-positional-still-works'],
  },
  {
    id: IDS[3], corrected: { [POLICY]: POLICY_STRICT, [EFFECTIVE]: EFFECTIVE_STRICT },
    wrong: { [POLICY]: POLICY_CASE_TOLERANT, [EFFECTIVE]: EFFECTIVE_STRICT },
    wrongMustFail: 'unknown-refused',
    originalFails: ['unknown-refused', 'observe-never-relaxes', 'verified-local-not-ready'],
    wrongFails: ['unknown-refused'],
  },
  {
    id: IDS[4], corrected: { [VERIFY]: VERIFY_COMPATIBLE }, wrong: { [VERIFY]: VERIFY_PLATFORM_ONLY },
    wrongMustFail: 'rejects-unavailable-runtime',
    originalFails: ['selects-compatible-recipe', 'rejects-platform-mismatch', 'rejects-unavailable-runtime',
      'rejects-malformed-recipe'],
    wrongFails: ['rejects-unavailable-runtime'],
  },
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const hashFile = (rel: string): string =>
  crypto.createHash('sha256').update(fs.readFileSync(path.join(REPO_ROOT, ...rel.split('/')))).digest('hex');
const hashWatched = (): Files => Object.fromEntries([...GROUNDING, ...OWN_FILES].map((rel) => [rel, hashFile(rel)]));
let watchedBefore: Files = {};
beforeAll(() => {
  watchedBefore = hashWatched();
});

describe('defect dataset', () => {
  it('validates against the landed contract with the five pinned ids in order', () => {
    expect(validateWorkloads(DEFECT_WORKLOADS)).toEqual(DEFECT_WORKLOADS);
    expect(Object.isFrozen(DEFECT_WORKLOADS)).toBe(true);
    expect(DEFECT_WORKLOADS.map((w) => w.id)).toEqual(IDS);
    for (const w of DEFECT_WORKLOADS) {
      expect(w.category).toBe('defect');
      expect(w.startingCommit).toBe(FROZEN_STARTING_COMMIT);
      expect(w.source.repository).toBe(SOURCE_REPOSITORY);
      expect(['reduced', 'adapted']).toContain(w.source.adaptation);
      expect(w.source.note, w.id).toMatch(/synthetic/i);
      expect(w.source.note, w.id).toContain(STALE_ARTIFACTS[w.id]);
      for (const p of w.source.paths) expect(GROUNDING).toContain(p);
    }
    expect(sorted(DEFECT_WORKLOADS.flatMap((w) => w.source.paths))).toEqual(sorted(GROUNDING));
  });

  it('carries the shared corpus coverage tags in order', () => {
    const shared: readonly string[] = CORPUS_COVERAGE_TAGS;
    const tags = Object.fromEntries(DEFECT_WORKLOADS.map((w) => [w.id, w.rubric.coverageTags.filter((t) => shared.includes(t))]));
    expect(tags).toEqual({
      'defect-stale-positive-readiness-helper': ['stale-positive-context'],
      'defect-stale-negative-integer-option': ['stale-negative-context', 'reusable-helper'],
      'defect-changed-caller-chat-budget': ['changed-caller'],
      'defect-changed-requirements-delivery-policy': ['changed-requirements'],
      'defect-recipe-mismatch-platform': ['recipe-mismatch'],
    });
  });

  it('names every rubric criterion in exactly one assessment test', () => {
    for (const w of DEFECT_WORKLOADS) {
      const tests = Object.entries(w.assessmentFiles).filter(([p]) => p.endsWith('.test.mjs')).map(([, text]) => text).join('\n');
      const named = [...tests.matchAll(/^test\('([a-z0-9-]+): /gm)].map((m) => m[1]);
      expect(named.sort(), w.id).toEqual(criteriaOf(w));
      expect(tests).toContain(`process.env.${WORKLOAD_CANDIDATE_ROOT_ENV}`);
    }
  });

  it('pins every per-case workload digest', () => {
    expect(Object.fromEntries(DEFECT_WORKLOADS.map((w) => [w.id, digestWorkload(w)]))).toEqual(PINNED_WORKLOAD_DIGESTS);
  });
});

describe('stale artifacts', () => {
  it('ships exactly one labelled, inert stale artifact per case that no module or assessment reads', () => {
    for (const w of DEFECT_WORKLOADS) {
      const artifact = STALE_ARTIFACTS[w.id];
      const stale = Object.keys(w.initialFiles).filter((p) => p.startsWith('context/') || p.startsWith('recipes/'));
      expect(stale, w.id).toEqual([artifact]);
      const text = initial(w.id, artifact);
      expect(text, w.id).toContain('earlier session; may be outdated');
      expect(text, w.id).toMatch(/synthetic/i);
      if (artifact.endsWith('.json')) expect(() => JSON.parse(text), w.id).not.toThrow();
      const readers = [
        ...Object.values(w.assessmentFiles),
        ...Object.entries(w.initialFiles).filter(([p]) => p.endsWith('.mjs')).map(([, content]) => content),
      ];
      for (const content of readers) {
        expect(content.includes(artifact) || content.includes(path.posix.basename(artifact)), w.id).toBe(false);
      }
    }
  });

  it.each(CONTROLS)('$id: the corrected variant passes every criterion with the stale artifact deleted', async (c) => {
    const w = workload(c.id);
    const root = await candidate(w, c.corrected);
    fs.rmSync(path.join(root, ...STALE_ARTIFACTS[c.id].split('/')));
    const outcome = await runAssessment(w, root);
    expect(outcome.failed, outcome.excerpt).toEqual([]);
    expect(outcome.passed, outcome.excerpt).toEqual(criteriaOf(w));
    expect(outcome.exitOk, outcome.excerpt).toBe(true);
  }, 120_000);
});

describe('held-out separation', () => {
  it('keeps assessments and test-only variants out of the coding inputs', async () => {
    expect(CONTROLS.map((c) => c.id)).toEqual(IDS);
    for (const w of DEFECT_WORKLOADS) {
      const control = CONTROLS.find((c) => c.id === w.id);
      const heldOut = [
        ...Object.values(w.assessmentFiles), ...Object.values(control?.corrected ?? {}), ...Object.values(control?.wrong ?? {}),
      ];
      for (const input of Object.values(w.initialFiles)) {
        for (const text of heldOut) expect(input.includes(text), w.id).toBe(false);
      }
      const coding = await readSnapshotFiles(await track(createCodingSnapshot(w)));
      expect(Object.keys(coding).filter((p) => p.endsWith('.test.mjs'))).toEqual([]);
      expect({ ...coding }).toEqual({ ...w.initialFiles });
    }
  });

  it.each(IDS)('%s: the assessment fails loudly without a candidate root', async (id) => {
    const outcome = await runAssessment(workload(id), null);
    expect(outcome.exitOk, outcome.excerpt).toBe(false);
    expect(outcome.passed).toEqual([]);
    expect(outcome.excerpt).toContain(`${WORKLOAD_CANDIDATE_ROOT_ENV} is not set`);
  }, 120_000);
});

describe('executable controls against the unchanged rubric', () => {
  it.each(CONTROLS)('$id: original fails, corrected passes every criterion, plausible-wrong fails for its reason', async (c) => {
    const w = workload(c.id);
    const all = criteriaOf(w);
    expect(c.originalFails.length).toBeGreaterThan(0);
    expect(c.wrongFails).toContain(c.wrongMustFail);

    const original = await runAssessment(w, await candidate(w));
    expect(original.exitOk, original.excerpt).toBe(false);
    expect(original.failed, original.excerpt).toEqual(sorted(c.originalFails));
    expect(original.passed, original.excerpt).toEqual(without(all, c.originalFails));

    const corrected = await runAssessment(w, await candidate(w, c.corrected));
    expect(corrected.failed, corrected.excerpt).toEqual([]);
    expect(corrected.passed, corrected.excerpt).toEqual(all);
    expect(corrected.exitOk, corrected.excerpt).toBe(true);

    const wrong = await runAssessment(w, await candidate(w, c.wrong));
    expect(wrong.exitOk, wrong.excerpt).toBe(false);
    expect(wrong.failed, wrong.excerpt).toEqual(sorted(c.wrongFails));
    expect(wrong.passed, wrong.excerpt).toEqual(without(all, c.wrongFails));
  }, 120_000);
});

describe('determinism and reset', () => {
  it.each(IDS)('%s: snapshots read back identically and a new snapshot resets a mutated one', async (id) => {
    const w = workload(id);
    const first = await track(createCodingSnapshot(w));
    const second = await track(createCodingSnapshot(w));
    expect(first.root).not.toBe(second.root);
    const firstFiles = await readSnapshotFiles(first);
    expect(await readSnapshotFiles(second)).toEqual(firstFiles);
    expect(digestFiles({ ...firstFiles })).toBe(w.snapshotDigest);

    const rel = Object.keys(w.initialFiles).sort()[0];
    fs.writeFileSync(path.join(first.root, ...rel.split('/')), 'mutated by a candidate\n', 'utf8');
    expect(digestFiles({ ...(await readSnapshotFiles(first)) })).not.toBe(w.snapshotDigest);
    const reset = await track(createCodingSnapshot(w));
    expect(digestFiles({ ...(await readSnapshotFiles(reset)) })).toBe(w.snapshotDigest);

    const assessment = await track(createAssessmentSnapshot(w));
    expect(digestFiles({ ...(await readSnapshotFiles(assessment)) })).toBe(w.assessmentDigest);
    await first.dispose();
    expect(fs.existsSync(first.root)).toBe(false);
  });
});

describe('source checkout', () => {
  it('keeps both owned files printable ASCII, so no hidden or bidi character hides in a fixture', () => {
    for (const rel of OWN_FILES) {
      const text = fs.readFileSync(path.join(REPO_ROOT, ...rel.split('/')), 'utf8');
      expect(/[^\t\n\r\x20-\x7e]/.exec(text)?.index ?? -1, rel).toBe(-1);
    }
  });

  it('leaves the dataset module, both owned files and the grounding sources byte-identical', () => {
    expect(hashWatched()).toEqual(watchedBefore);
  });
});
