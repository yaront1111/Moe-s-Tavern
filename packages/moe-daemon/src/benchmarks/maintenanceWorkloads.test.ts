// Category tests for the frozen maintenance workloads (CQ-M03b). Test-only benchmark
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
import { MAINTENANCE_WORKLOADS } from './maintenanceWorkloads.js';
import {
  CORPUS_COVERAGE_TAGS, FROZEN_STARTING_COMMIT, SOURCE_REPOSITORY, WORKLOAD_CANDIDATE_ROOT_ENV,
  createAssessmentSnapshot, createCodingSnapshot, digestFiles, digestWorkload, readSnapshotFiles,
  validateWorkloads, type Workload, type WorkloadSnapshotHandle,
} from './workloadSnapshot.js';

type Files = Record<string, string>;
type Edit = readonly [from: string, to: string];

const IDS = [
  'maintenance-truncation-helper-reuse',
  'maintenance-branch-policy-message',
  'maintenance-usage-unknown-format',
  'maintenance-affected-file-caller',
  'maintenance-cached-ref-caller',
];
const GROUNDING = [
  'packages/moe-daemon/src/util/memorySettings.ts',
  'packages/moe-daemon/src/tools/getPendingQuestions.ts',
  'packages/moe-daemon/src/util/branchPolicy.ts',
  'scripts/prompt-cache-usage.mjs',
  'packages/moe-daemon/src/util/affectedFiles.ts',
  'packages/moe-daemon/src/util/cachedPlanPaths.ts',
];
const PINNED_WORKLOAD_DIGESTS: Files = {
  'maintenance-truncation-helper-reuse': 'sha256:7ca24b2f1f427b816d4700d0e1d7fd693ae1ea19fff9fb6bd9641318ac57c8cb',
  'maintenance-branch-policy-message': 'sha256:23fbd55723374c6fefe4ff21521985a0527403e06567cc73103d21dccd373d88',
  'maintenance-usage-unknown-format': 'sha256:e4ccdcdf1b5e0a6c53d7b5ec064ca6599ca37165afc3a81f3ef6881d4eec4647',
  'maintenance-affected-file-caller': 'sha256:8453abf76b28151ad6ba70e2ddd1824aef135c348feba799b01a42a6bce4cc47',
  'maintenance-cached-ref-caller': 'sha256:979820d5b41ee97cc5acbac100ff7ec8a991ecd7de18d270f674250a50a46e68',
};
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const OWN_FILES = ['maintenanceWorkloads.ts', 'maintenanceWorkloads.test.ts']
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
  const found = MAINTENANCE_WORKLOADS.find((w) => w.id === id);
  if (!found) throw new Error(`no maintenance workload ${id}`);
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
  /** The criterion the plausible-wrong variant was written to break. */
  readonly wrongMustFail: string;
  /** Exact criteria the unsolved original fails (at least one intended-change criterion). */
  readonly originalFails: readonly string[];
  /** Exact criteria the plausible-wrong variant fails; includes wrongMustFail. */
  readonly wrongFails: readonly string[];
}

// Case 1: reuse the helper (corrected) versus an inline copy of it (wrong, behaviour identical).
const QUESTION = 'src/compactQuestion.mjs';
const QUESTION_HEAD = 'export function compactQuestion(';
const QUESTION_SLICE = '  return { ...question, content: question.content.slice(0, maxContentChars) };';
const questionReturn = (helper: string): string => `  const content = ${helper}(question.content, maxContentChars);
  return {
    ...question,
    content: content.text,
    contentTruncated: content.truncated,
    contentOriginalLength: question.content.length,
  };`;
const QUESTION_FIXED = patch(initial(IDS[0], QUESTION), [
  [QUESTION_HEAD, `import { truncateForBudget } from './textBudget.mjs';\n\n${QUESTION_HEAD}`],
  [QUESTION_SLICE, questionReturn('truncateForBudget')],
]);
const QUESTION_INLINE_COPY = patch(initial(IDS[0], QUESTION), [
  [QUESTION_HEAD, `// Local copy of the budget helper, so this module needs no extra import.
const ELLIPSIS = String.fromCharCode(0x2026);

function truncate(text, maxChars) {
  if (maxChars <= 0) return { text: '', truncated: text.length > 0 };
  if (text.length <= maxChars) return { text, truncated: false };
  let end = Math.max(0, maxChars - ELLIPSIS.length);
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return { text: text.slice(0, end).trimEnd() + ELLIPSIS, truncated: true };
}

${QUESTION_HEAD}`],
  [QUESTION_SLICE, questionReturn('truncate')],
]);

// Case 2: branch the message on the policy kind; the wrong variant also "simplifies" the matcher.
const POLICY = 'src/branchPolicy.mjs';
const POLICY_FIXED = patch(initial(IDS[1], POLICY), [[
  `'", but this project requires "' + pattern + '". '`,
  `'", but this project requires ' + (pattern.includes('*') ? 'a branch matching "' : 'branch "') + pattern + '". '`,
]]);
const POLICY_UNESCAPED = patch(POLICY_FIXED, [[String.raw`    const source = pattern
      .replace(REGEX_METACHARACTERS, '\\$&')
      .replace(/\\\*/g, '.*')
      .replace(/(?:\.\*)+/g, '.*');`, `    // Simplified: a glob star is just a regex wildcard.
    const source = pattern.split('*').join('.*');`]]);

// Case 3: the new key names with every incomplete input field unknown (corrected) or 0 (wrong).
const USAGE = 'src/promptCacheUsage.mjs';
const USAGE_KEYS: Edit = [
  `' input=' + total + ' read=' + read + ' write=' + (write ?? 'unknown')`,
  `' input=' + total + ' cached=' + read + ' written=' + (write ?? 'unknown')`,
];
const incompleteInput = (fields: string): Edit[] => [
  [`    return prefix + ' usage=unknown' + output;\n  }`, `    return prefix + ${fields} + output;\n  }`],
  [`if (!Number.isSafeInteger(total)) return prefix + ' usage=unknown' + output;`,
    `if (!Number.isSafeInteger(total)) return prefix + ${fields} + output;`],
];
const USAGE_FIXED = patch(initial(IDS[2], USAGE), [
  USAGE_KEYS, ...incompleteInput(`' input=unknown cached=unknown written=unknown uncached=unknown hit=unknown'`),
]);
const USAGE_ZERO_DEFAULTS = patch(initial(IDS[2], USAGE), [USAGE_KEYS, ...incompleteInput(
  `' input=' + (normalized.inputTokens ?? 0) + ' cached=' + (normalized.cacheReadTokens ?? 0)
    + ' written=' + (normalized.cacheWriteTokens ?? 0) + ' uncached=' + (normalized.uncachedInputTokens ?? 0) + ' hit=n/a'`,
)]);

// Case 4: reuse the shared normalizer and pathKey (corrected) versus an own first-only cleanup (wrong).
const DECLARED = 'src/declaredFiles.mjs';
const DECLARED_HEAD = 'export function mergeDeclaredFiles(';
const DECLARED_STUB = "  throw new Error('mergeDeclaredFiles is not implemented');";
const DECLARED_FIXED = patch(initial(IDS[3], DECLARED), [
  [DECLARED_HEAD, `import { normalizeAffectedFile, pathKey } from './affectedFiles.mjs';\n\n${DECLARED_HEAD}`],
  [DECLARED_STUB, `  const added = incoming.map((entry) => normalizeAffectedFile(entry, 'declaredFiles'));
  const seen = new Set(existing.map((p) => pathKey(p, platform)));
  const merged = [...existing];
  for (const p of added) {
    const key = pathKey(p, platform);
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(p);
    }
  }
  return merged;`],
]);
const DECLARED_OWN_CLEANUP = patch(initial(IDS[3], DECLARED), [
  [DECLARED_HEAD, `const BACKSLASH = String.fromCharCode(92);\n\n${DECLARED_HEAD}`],
  [DECLARED_STUB, String.raw`  // Inline cleanup keeps this module self-contained.
  const added = incoming.map((raw) => {
    const p = String(raw).trim().replace(BACKSLASH, '/').replace(/^\.\//, '');
    if (p.startsWith('/') || p.split('/').includes('..')) {
      throw new Error('[INVALID_INPUT] Invalid declaredFiles: path traversal not allowed (got "' + raw + '")');
    }
    return p;
  });
  const seen = new Set(existing.map((p) => p.toLowerCase()));
  const merged = [...existing];
  for (const p of added) {
    if (!seen.has(p.toLowerCase())) {
      seen.add(p.toLowerCase());
      merged.push(p);
    }
  }
  return merged;`],
]);

// Case 5: options plus remote validation (corrected); the wrong variant also lists a glob via for-each-ref.
const CACHED = 'src/cachedPlanPaths.mjs';
const CACHED_RESOLVE = '  const ref = cachedPlanRef(branch, options.remote);';
const CACHED_FIXED = patch(initial(IDS[4], CACHED), [
  [`/** Only an explicitly configured, literal consolidation branch is evidence. */
export function cachedPlanRef(branch) {`, `const SAFE_REMOTE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Only an explicitly configured, literal consolidation branch on a safe remote is evidence. */
export function cachedPlanRef(branch, remote = 'origin') {
  if (typeof remote !== 'string' || !SAFE_REMOTE.test(remote) || remote.includes('..')
      || remote.endsWith('.') || remote.endsWith('.lock')) return undefined;`],
  [`  return 'refs/remotes/origin/' + branch;`, `  return 'refs/remotes/' + remote + '/' + branch;`],
  [`export async function findCachedPlanPaths(branch, missing, run) {
  const ref = cachedPlanRef(branch);`, `export async function findCachedPlanPaths(target, missing, run) {
  const options = typeof target === 'string' ? { branch: target } : target ?? {};
  const branch = options.branch;
${CACHED_RESOLVE}`],
]);
const CACHED_GLOB_LISTING = patch(CACHED_FIXED, [[CACHED_RESOLVE, `  let ref = cachedPlanRef(branch, options.remote);
  if (!ref && typeof branch === 'string' && branch.includes('*')) {
    // A glob policy resolves to its newest matching remote-tracking branch.
    const listed = await run(['for-each-ref', '--count=1', '--sort=-committerdate', '--format=%(refname)',
      'refs/remotes/' + (options.remote ?? 'origin') + '/' + branch]);
    ref = listed.trim() || undefined;
  }`]]);

const CONTROLS: readonly Control[] = [
  {
    id: IDS[0], corrected: { [QUESTION]: QUESTION_FIXED }, wrong: { [QUESTION]: QUESTION_INLINE_COPY },
    wrongMustFail: 'reuses-text-budget-helper',
    originalFails: ['returns-compact-shape', 'keeps-complete-characters', 'reuses-text-budget-helper'],
    wrongFails: ['reuses-text-budget-helper'],
  },
  {
    id: IDS[1], corrected: { [POLICY]: POLICY_FIXED }, wrong: { [POLICY]: POLICY_UNESCAPED },
    wrongMustFail: 'match-semantics-unchanged',
    originalFails: ['literal-policy-message', 'glob-policy-message'],
    wrongFails: ['match-semantics-unchanged'],
  },
  {
    id: IDS[2], corrected: { [USAGE]: USAGE_FIXED }, wrong: { [USAGE]: USAGE_ZERO_DEFAULTS },
    wrongMustFail: 'unknown-input-fields',
    originalFails: ['claude-complete-line', 'codex-complete-line', 'unknown-input-fields', 'zero-total-hit'],
    wrongFails: ['unknown-input-fields'],
  },
  {
    id: IDS[3], corrected: { [DECLARED]: DECLARED_FIXED }, wrong: { [DECLARED]: DECLARED_OWN_CLEANUP },
    wrongMustFail: 'windows-separators',
    originalFails: ['windows-separators', 'platform-case-folding', 'unicode-preserved', 'rejects-traversal', 'reuses-normalizer'],
    wrongFails: ['windows-separators', 'platform-case-folding', 'rejects-traversal', 'reuses-normalizer'],
  },
  {
    id: IDS[4], corrected: { [CACHED]: CACHED_FIXED }, wrong: { [CACHED]: CACHED_GLOB_LISTING },
    wrongMustFail: 'glob-is-not-evidence',
    originalFails: ['accepts-caller-options', 'rejects-unsafe-remote', 'read-only-recipe'],
    wrongFails: ['glob-is-not-evidence'],
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

describe('maintenance dataset', () => {
  it('validates against the landed contract with the five pinned ids in order', () => {
    expect(validateWorkloads(MAINTENANCE_WORKLOADS)).toEqual(MAINTENANCE_WORKLOADS);
    expect(Object.isFrozen(MAINTENANCE_WORKLOADS)).toBe(true);
    expect(MAINTENANCE_WORKLOADS.map((w) => w.id)).toEqual(IDS);
    for (const w of MAINTENANCE_WORKLOADS) {
      expect(w.category).toBe('maintenance');
      expect(w.startingCommit).toBe(FROZEN_STARTING_COMMIT);
      expect(w.source.repository).toBe(SOURCE_REPOSITORY);
      expect(['reduced', 'adapted']).toContain(w.source.adaptation);
      expect(w.source.note.length).toBeGreaterThan(80);
      for (const p of w.source.paths) expect(GROUNDING).toContain(p);
    }
    expect(sorted(MAINTENANCE_WORKLOADS.flatMap((w) => w.source.paths))).toEqual(sorted(GROUNDING));
  });

  it('carries the shared corpus coverage tags', () => {
    const shared: readonly string[] = CORPUS_COVERAGE_TAGS;
    const tags = Object.fromEntries(MAINTENANCE_WORKLOADS.map((w) => [w.id, w.rubric.coverageTags.filter((t) => shared.includes(t))]));
    expect(tags).toEqual({
      'maintenance-truncation-helper-reuse': ['reusable-helper'],
      'maintenance-branch-policy-message': ['changed-requirements'],
      'maintenance-usage-unknown-format': ['changed-requirements'],
      'maintenance-affected-file-caller': ['reusable-helper'],
      'maintenance-cached-ref-caller': ['changed-caller', 'recipe-mismatch'],
    });
  });

  it('names every rubric criterion in exactly one assessment test', () => {
    for (const w of MAINTENANCE_WORKLOADS) {
      const tests = Object.entries(w.assessmentFiles).filter(([p]) => p.endsWith('.test.mjs')).map(([, text]) => text).join('\n');
      const named = [...tests.matchAll(/^test\('([a-z0-9-]+): /gm)].map((m) => m[1]);
      expect(named.sort(), w.id).toEqual(criteriaOf(w));
      expect(tests).toContain(`process.env.${WORKLOAD_CANDIDATE_ROOT_ENV}`);
    }
  });

  it('pins every per-case workload digest', () => {
    expect(Object.fromEntries(MAINTENANCE_WORKLOADS.map((w) => [w.id, digestWorkload(w)]))).toEqual(PINNED_WORKLOAD_DIGESTS);
  });
});

describe('held-out separation', () => {
  it('keeps assessments and test-only variants out of the coding inputs', async () => {
    expect(CONTROLS.map((c) => c.id)).toEqual(IDS);
    for (const w of MAINTENANCE_WORKLOADS) {
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
