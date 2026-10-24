// Category tests for the frozen non-routine workloads (CQ-M03e). Test-only benchmark
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
import { NON_ROUTINE_WORKLOADS } from './non-routineWorkloads.js';
import {
  CORPUS_COVERAGE_TAGS, FROZEN_STARTING_COMMIT, SOURCE_REPOSITORY, WORKLOAD_CANDIDATE_ROOT_ENV,
  createAssessmentSnapshot, createCodingSnapshot, digestFiles, digestWorkload, readSnapshotFiles,
  validateWorkloads, type Workload, type WorkloadSnapshotHandle,
} from './workloadSnapshot.js';

type Files = Record<string, string>;
type Edit = readonly [from: string, to: string];

const IDS = [
  'non-routine-cached-lookup-fingerprint',
  'non-routine-stale-negative-export-index',
  'non-routine-chat-pagination-remainder',
  'non-routine-monotonic-attempt-generation',
  'non-routine-cross-role-usage-rollup',
];
const GROUNDING = [
  'packages/moe-daemon/src/util/cachedPlanPaths.ts',
  'docs/plans/2026-10-24-ai-code-quality-and-context.md',
  'packages/moe-daemon/src/util/chatPayload.ts',
  'packages/moe-daemon/src/util/chatBacklog.ts',
  'packages/moe-daemon/src/state/attemptStore.ts',
  'scripts/usage-report.mjs',
];
const PINNED_WORKLOAD_DIGESTS: Files = {
  'non-routine-cached-lookup-fingerprint': 'sha256:fd6ef3d322a706bb3855c23776b7a9c94cf38c5d4f263c9eca5db5b128e5d7b2',
  'non-routine-stale-negative-export-index': 'sha256:c541b6039d603d28b179f0c9c55b308e262a3c211f27e6d11fa5e3c86c3afec8',
  'non-routine-chat-pagination-remainder': 'sha256:bbbf2176047e5fd98fd15fe2e67ba5163f5a98b8378df4c72ef1f94480adca52',
  'non-routine-monotonic-attempt-generation': 'sha256:caa899cf0b4eb1488f98bbe7d132e23fd984448f288632bb415d0a91e26b1c30',
  'non-routine-cross-role-usage-rollup': 'sha256:74272711900a97ac7fa8a24a5605eb08710c0c9cc0de1cab597f9658fb0c9f3f',
};
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const OWN_FILES = ['non-routineWorkloads.ts', 'non-routineWorkloads.test.ts']
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
  const found = NON_ROUTINE_WORKLOADS.find((w) => w.id === id);
  if (!found) throw new Error(`no non-routine workload ${id}`);
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
  /** Prose intendedBehavior must carry: the new behavior and its adversarial examples. */
  readonly requirementPhrases: readonly string[];
  /** Tokens of the corrected implementation that no coding input may contain. */
  readonly solutionMarkers: readonly string[];
  /** The honest provenance label and phrases its note must carry. */
  readonly provenance: readonly [adaptation: string, phrases: readonly string[]];
}

// Case 1: commit-tagged positives (corrected) versus serving cached positives when Git fails (wrong).
const LOOKUP = 'src/pathLookupCache.mjs';
const LOOKUP_HEAD: Edit = ['export function createCachedPathLookup(run) {', `const MAX_ENTRIES = 256;

export function createCachedPathLookup(run) {`];
const LOOKUP_STORE: Edit = [`  // ref + NUL + path, for every path once listed in the cached ref.
  const known = new Set();`, `  // ref + NUL + path -> the commit the path was listed at, oldest first.
  const known = new Map();
  const remember = (key, commit) => {
    known.delete(key);
    known.set(key, commit);
    while (known.size > MAX_ENTRIES) known.delete(known.keys().next().value);
  };`];
const LOOKUP_BODY = `      const pending = paths.filter((p) => !known.has(keyOf(ref, p)));
      let commit = null;
      if (pending.length > 0) {
        try {
          commit = await resolveCommit(run, ref);
          for (const p of await listPaths(run, commit, pending)) known.add(keyOf(ref, p));
        } catch {
          return { status: 'unknown', commit: null, found: [], missing: [...paths] };
        }
      }
      const found = paths.filter((p) => known.has(keyOf(ref, p)));
      return { status: 'ok', commit, found, missing: paths.filter((p) => !found.includes(p)) };`;
const lookupBody = (onFailure: string): Edit => [LOOKUP_BODY, `      try {
        const commit = await resolveCommit(run, ref);
        const cached = new Set(paths.filter((p) => known.get(keyOf(ref, p)) === commit));
        const pending = paths.filter((p) => !cached.has(p));
        const listed = new Set(pending.length > 0 ? await listPaths(run, commit, pending) : []);
        for (const p of listed) remember(keyOf(ref, p), commit);
        const found = paths.filter((p) => cached.has(p) || listed.has(p));
        return { status: 'ok', commit, found, missing: paths.filter((p) => !found.includes(p)) };
      } catch {
${onFailure}
      }`];
const LOOKUP_FIXED = patch(initial(IDS[0], LOOKUP), [LOOKUP_HEAD, LOOKUP_STORE, lookupBody(
  "        return { status: 'unknown', commit: null, found: [], missing: [...paths] };",
)]);
const LOOKUP_STALE_FALLBACK = patch(initial(IDS[0], LOOKUP), [LOOKUP_HEAD, LOOKUP_STORE, lookupBody(
  `        // Git is unavailable right now: keep serving the positives already confirmed.
        const found = paths.filter((p) => known.has(keyOf(ref, p)));
        if (found.length === 0) return { status: 'unknown', commit: null, found: [], missing: [...paths] };
        return { status: 'ok', commit: null, found, missing: paths.filter((p) => !found.includes(p)) };`,
)]);

// Case 2: namespace- and fingerprint-scoped answers (corrected) versus reading a failure as empty text (wrong).
const FINDER = 'src/helperFinder.mjs';
const FINDER_BODY = `  // name -> the last answer, found or not.
  const answers = new Map();
  return {
    /** Resolves to { status: 'found', module } (the first module, in order, exporting name) or { status: 'not-found' }. */
    async find(name, modules) {
      if (answers.has(name)) return answers.get(name);
      let answer = { status: 'not-found' };
      for (const module of modules) {
        if (exportsName(await readSource(module), name)) {
          answer = { status: 'found', module };
          break;
        }
      }
      answers.set(name, answer);
      return answer;
    },
  };`;
const finderBody = (read: string): Edit => [FINDER_BODY, `  // name + namespace -> { module } for a positive, or { prints } (module -> SHA-256 of its text) for a negative.
  const answers = new Map();
${read}
  const fingerprint = (text) => createHash('sha256').update(text, 'utf8').digest('hex');
  return {
    async find(name, modules) {
      const namespace = [...new Set(modules)].sort();
      const key = JSON.stringify([name, namespace]);
      try {
        const cached = answers.get(key);
        if (cached && cached.module !== undefined) {
          if (exportsName(await read(cached.module), name)) return { status: 'found', module: cached.module };
        } else if (cached) {
          let unchanged = true;
          for (const module of namespace) {
            if (fingerprint(await read(module)) !== cached.prints.get(module)) unchanged = false;
          }
          if (unchanged) return { status: 'not-found' };
        }
        const prints = new Map();
        for (const module of modules) {
          const text = await read(module);
          prints.set(module, fingerprint(text));
          if (exportsName(text, name)) {
            answers.set(key, { module });
            return { status: 'found', module };
          }
        }
        answers.set(key, { prints });
        return { status: 'not-found' };
      } catch {
        return { status: 'unknown' };
      }
    },
  };`];
const withCrypto = (text: string): string => `import { createHash } from 'node:crypto';\n${text}`;
const FINDER_FIXED = withCrypto(patch(initial(IDS[1], FINDER), [finderBody(
  '  const read = async (module) => String(await readSource(module));',
)]));
const FINDER_UNREADABLE_AS_EMPTY = withCrypto(patch(initial(IDS[1], FINDER), [finderBody(
  `  // An unreadable module exports nothing: read it as empty so one bad file cannot fail the search.
  const read = async (module) => {
    try {
      return String(await readSource(module));
    } catch {
      return '';
    }
  };`,
)]));

// Case 3: a cursor at the last delivered message (corrected) versus at the end of the limit window (wrong).
const BACKLOG = 'src/chatBacklog.mjs';
const BACKLOG_IMPORT: Edit = ["import { truncateChatMessages } from './chatPayload.mjs';",
  "import { MAX_CHAT_RESPONSE_CHARS, capChatMessagesToResponseBudget, truncateChatMessages } from './chatPayload.mjs';"];
const withPager = (cursor: string): string => `${patch(initial(IDS[2], BACKLOG), [BACKLOG_IMPORT])}
/** One bounded page after sinceId: { messages, nextCursor, remaining }. */
export function readPage(messages, { sinceId, limit, maxContentChars = 0, budget = MAX_CHAT_RESPONSE_CHARS }) {
  let start = 0;
  if (sinceId !== undefined && sinceId !== null) {
    start = messages.findIndex((message) => message.id === sinceId) + 1;
    if (start === 0) throw new Error('unknown cursor ' + sinceId);
  }
  const batch = messages.slice(start, start + limit);
  const { delivered } = capChatMessagesToResponseBudget(batch, maxContentChars, budget);
${cursor}
  return { messages: truncateChatMessages(delivered, maxContentChars), nextCursor, remaining };
}
`;
const PAGER_FIXED = withPager(`  const nextCursor = delivered.length > 0 ? delivered[delivered.length - 1].id : sinceId ?? null;
  const remaining = messages.length - start - delivered.length;`);
const PAGER_BATCH_CURSOR = withPager(`  // The batch is consumed: the next page starts after its last message.
  const nextCursor = batch.length > 0 ? batch[batch.length - 1].id : sinceId ?? null;
  const remaining = messages.length - start - batch.length;`);

// Case 4: max over a persisted high-water mark and the records (corrected) versus over the records alone (wrong).
const ATTEMPTS = 'src/attemptGenerations.mjs';
const nextGeneration = (highWaterRead: string): Edit => [`/** Next fencing generation for taskId. */
export function nextGeneration(store, taskId) {
  return store.records.filter((record) => record.taskId === taskId).length + 1;
}`, `function decodeGeneration(value, owner) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error('corrupt attempt generation for ' + owner + ': ' + String(value));
  return value;
}

/** Next fencing generation for taskId: one past every generation it was ever issued. */
export function nextGeneration(store, taskId) {
  let max = 0;
${highWaterRead}
  for (const record of store.records) {
    if (record.taskId === taskId) max = Math.max(max, decodeGeneration(record.generation, 'record ' + record.id));
  }
  if (max >= MAX_ATTEMPT_GENERATION) {
    const error = new Error('attempt generations exhausted for task ' + taskId);
    error.code = 'ATTEMPT_GENERATION_EXHAUSTED';
    throw error;
  }
  (store.highWater ??= {})[taskId] = max + 1;
  return max + 1;
}`];
const GENERATIONS_FIXED = patch(initial(IDS[3], ATTEMPTS), [nextGeneration(`  const marks = store.highWater ?? {};
  if (Object.hasOwn(marks, taskId)) max = decodeGeneration(marks[taskId], 'task ' + taskId);`)]);
const GENERATIONS_RECORDS_ONLY = patch(initial(IDS[3], ATTEMPTS), [nextGeneration(
  '  // Every attempt record stays in the store, so the records alone hold the maximum.')]);

// Case 5: groups deduplicated by durable identity (corrected) versus rows merged per launch (wrong).
const ROLLUP = 'scripts/usageRollup.mjs';
const DURABLE_IDS: readonly Edit[] = [[`    const ids = [];
    // Missing usage belongs to that failed/incomplete launch, never to an older
    // measured cumulative result for a resumed Claude session.
    if (row.scope === 'session' && row.sessionId && !['missing', 'pending'].includes(row.coverage)) {
      ids.push(key(row.provider, 'session', row.sessionId));
    }
    if (row.eventId) ids.push(key(row.provider, row.scope, row.coverage === 'missing' ? 'missing-event' : 'event', row.eventId));
`, `    const ids = durableIds(row);
`], ['export function identifiedGroups(records, stats) {', `/** The provider session and event identities that make two rows the same usage. */
export function durableIds(row) {
  const ids = [];
  // Missing usage belongs to that failed/incomplete launch, never to an older
  // measured cumulative result for a resumed Claude session.
  if (row.scope === 'session' && row.sessionId && !['missing', 'pending'].includes(row.coverage)) {
    ids.push(key(row.provider, 'session', row.sessionId));
  }
  if (row.eventId) ids.push(key(row.provider, row.scope, row.coverage === 'missing' ? 'missing-event' : 'event', row.eventId));
  return ids;
}

export function identifiedGroups(records, stats) {`]];
const withTaskRollup = (groups: string, helper = ''): string => `${patch(initial(IDS[4], ROLLUP), DURABLE_IDS)}${helper}
const roleOf = (group) => group.roles.length === 1 ? group.roles[0] : group.roles.length > 1 ? 'multiple' : 'unknown';

/** One entry per task across providers and roles, deduplicated before summing; the null task sorts last. */
export function rollupByTask(records) {
  const tasks = new Map();
  const entry = (taskId) => {
    if (!tasks.has(taskId)) tasks.set(taskId, { groups: [], unidentifiedRecords: 0 });
    return tasks.get(taskId);
  };
  for (const group of ${groups}) entry(group.taskId).groups.push(group);
  for (const row of records) {
    if (durableIds(row).length === 0) entry(row.taskId || null).unidentifiedRecords++;
  }
  const byRole = (groups) => {
    const roles = new Map();
    for (const group of groups) roles.set(roleOf(group), [...(roles.get(roleOf(group)) ?? []), group]);
    return Object.fromEntries([...roles].map(([role, part]) => [role, aggregate(part)]));
  };
  return [...tasks]
    .sort(([a], [b]) => (a === null ? 1 : b === null ? -1 : a.localeCompare(b)))
    .map(([taskId, { groups, unidentifiedRecords }]) => ({
      taskId, providers: [...new Set(groups.map((group) => group.provider))].sort(), ...aggregate(groups),
      unidentifiedRecords, byRole: byRole(groups),
    }));
}
`;
const ROLLUP_FIXED = withTaskRollup('identifiedGroups(records, newStats())');
const ROLLUP_PER_LAUNCH = withTaskRollup('launchGroups(records)', `
// One launch reports its usage once: merge each launch's rows, and keep rows without a launch apart.
function launchGroups(records) {
  const launches = new Map();
  records.forEach((row, index) => {
    const id = row.launchId ? key(row.provider, row.launchId) : index;
    launches.set(id, [...(launches.get(id) ?? []), row]);
  });
  return [...launches.values()].map((rows) => mergeGroup(rows, newStats()));
}
`);

const CONTROLS: readonly Control[] = [
  {
    id: IDS[0], corrected: { [LOOKUP]: LOOKUP_FIXED }, wrong: { [LOOKUP]: LOOKUP_STALE_FALLBACK },
    wrongMustFail: 'fail-closed-on-resolution-error',
    originalFails: ['serves-fresh-positive', 'invalidates-on-fingerprint-change', 'fail-closed-on-resolution-error', 'bounded-cache'],
    wrongFails: ['fail-closed-on-resolution-error'],
    requirementPhrases: ['resolves the ref with resolveCommit exactly once', 'recorded at that same commit',
      'never a cached positive', 'Misses are never cached', 'at most 256 cached positives'],
    solutionMarkers: ['MAX_ENTRIES', 'remember(', 'known.get('],
    provenance: ['adapted', ['src/pathLookupCache.mjs is synthetic', 'injected run(args)']],
  },
  {
    id: IDS[1], corrected: { [FINDER]: FINDER_FIXED }, wrong: { [FINDER]: FINDER_UNREADABLE_AS_EMPTY },
    wrongMustFail: 'read-errors-not-cached',
    originalFails: ['detects-new-export', 'scope-aware-negative', 'detects-removed-export', 'reverifies-cached-positive',
      'read-errors-not-cached'],
    wrongFails: ['read-errors-not-cached'],
    requirementPhrases: ['searched namespace', 'SHA-256 of its current text', "{ status: 'unknown' }",
      'exactly that one readSource call', 'boundedTailX does not match boundedTail'],
    solutionMarkers: ['createHash', 'fingerprint', 'namespace'],
    provenance: ['adapted', ['Synthetic', 'does not exist at the frozen commit', 'Track negative searches too']],
  },
  {
    id: IDS[2], corrected: { [BACKLOG]: PAGER_FIXED }, wrong: { [BACKLOG]: PAGER_BATCH_CURSOR },
    wrongMustFail: 'cursor-is-last-delivered',
    originalFails: ['respects-limit-and-budget', 'cursor-is-last-delivered', 'pages-cover-all-exactly-once',
      'oversized-message-progress', 'rejects-unknown-cursor', 'truncation-flags-preserved'],
    wrongFails: ['cursor-is-last-delivered', 'pages-cover-all-exactly-once', 'oversized-message-progress'],
    requirementPhrases: ['LAST DELIVERED', 'exactly once', 'throws an Error whose message names it',
      'at least one message while any remain', 'Do not change the shared payload helpers'],
    solutionMarkers: ['readPage', 'nextCursor', 'remaining'],
    provenance: ['adapted', ['minimal stand-in', 'one in-memory channel']],
  },
  {
    id: IDS[3], corrected: { [ATTEMPTS]: GENERATIONS_FIXED }, wrong: { [ATTEMPTS]: GENERATIONS_RECORDS_ONLY },
    wrongMustFail: 'survives-deleted-highest',
    originalFails: ['uses-historical-maximum', 'survives-deleted-highest', 'rejects-malformed-stored',
      'exhaustion-fails-closed', 'persists-high-water'],
    wrongFails: ['survives-deleted-highest', 'rejects-malformed-stored', 'exhaustion-fails-closed', 'persists-high-water'],
    requirementPhrases: ['ever issued twice', 'positive safe integer', "'ATTEMPT_GENERATION_EXHAUSTED'",
      'A call that throws changes nothing', 'allocate 6, not 3'],
    solutionMarkers: ['highWater', 'ATTEMPT_GENERATION_EXHAUSTED'],
    provenance: ['adapted', ['rewound', 'superseded count-based allocation']],
  },
  {
    id: IDS[4], corrected: { [ROLLUP]: ROLLUP_FIXED }, wrong: { [ROLLUP]: ROLLUP_PER_LAUNCH },
    wrongMustFail: 'dedupes-durable-identity',
    originalFails: ['dedupes-durable-identity', 'keeps-unidentified-visible', 'preserves-unknown-counters',
      'conflicts-become-unknown', 'per-role-breakdown', 'overflow-unknown'],
    wrongFails: ['dedupes-durable-identity', 'per-role-breakdown'],
    requirementPhrases: ['Deduplicate by durable identity BEFORE summing', 'never merge rows by launchId',
      "'multiple'", 'observedTokens null, never 0', 'unidentifiedRecords'],
    solutionMarkers: ['rollupByTask', 'durableIds', 'byRole'],
    provenance: ['reduced', ['frozen commit', 'normalized rows', 'CQ-M02']],
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

function control(id: string): Control {
  const found = CONTROLS.find((c) => c.id === id);
  if (!found) throw new Error(`no control for ${id}`);
  return found;
}

describe('non-routine dataset', () => {
  it('validates against the landed contract with the five pinned ids in order', () => {
    expect(validateWorkloads(NON_ROUTINE_WORKLOADS)).toEqual(NON_ROUTINE_WORKLOADS);
    expect(Object.isFrozen(NON_ROUTINE_WORKLOADS)).toBe(true);
    expect(NON_ROUTINE_WORKLOADS.map((w) => w.id)).toEqual(IDS);
    expect(CONTROLS.map((c) => c.id)).toEqual(IDS);
    for (const w of NON_ROUTINE_WORKLOADS) {
      expect(w.category).toBe('non-routine');
      expect(w.startingCommit).toBe(FROZEN_STARTING_COMMIT);
      expect(w.source.repository).toBe(SOURCE_REPOSITORY);
      for (const p of w.source.paths) expect(GROUNDING).toContain(p);
    }
    expect(sorted(NON_ROUTINE_WORKLOADS.flatMap((w) => w.source.paths))).toEqual(sorted(GROUNDING));
  });

  it.each(IDS)('%s: labels its provenance honestly', (id) => {
    const { source } = workload(id);
    const [adaptation, phrases] = control(id).provenance;
    expect(source.adaptation).toBe(adaptation);
    for (const phrase of phrases) expect(source.note, phrase).toContain(phrase);
  });

  it('carries the shared corpus coverage tags and the category tags', () => {
    const shared: readonly string[] = CORPUS_COVERAGE_TAGS;
    const tags = Object.fromEntries(NON_ROUTINE_WORKLOADS.map((w) => [w.id, w.rubric.coverageTags.filter((t) => shared.includes(t))]));
    expect(tags).toEqual({
      'non-routine-cached-lookup-fingerprint': ['stale-positive-context'],
      'non-routine-stale-negative-export-index': ['stale-negative-context'],
      'non-routine-chat-pagination-remainder': ['reusable-helper'],
      'non-routine-monotonic-attempt-generation': ['changed-requirements'],
      'non-routine-cross-role-usage-rollup': ['reusable-helper'],
    });
    expect(workload(IDS[4]).rubric.coverageTags).toContain('unknown-preservation');
    expect(workload(IDS[1]).rubric.coverageTags).toContain('cache-invalidation');
  });

  it('names every rubric criterion in exactly one assessment test', () => {
    for (const w of NON_ROUTINE_WORKLOADS) {
      const tests = Object.entries(w.assessmentFiles).filter(([p]) => p.endsWith('.test.mjs')).map(([, text]) => text).join('\n');
      const named = [...tests.matchAll(/^test\('([a-z0-9-]+): /gm)].map((m) => m[1]);
      expect(named.sort(), w.id).toEqual(criteriaOf(w));
      expect(tests).toContain(`process.env.${WORKLOAD_CANDIDATE_ROOT_ENV}`);
    }
  });

  it('pins every per-case workload digest', () => {
    expect(Object.fromEntries(NON_ROUTINE_WORKLOADS.map((w) => [w.id, digestWorkload(w)]))).toEqual(PINNED_WORKLOAD_DIGESTS);
  });
});

describe('requirement independence', () => {
  it.each(IDS)('%s: states the new behavior and adversarial examples, and no coding input hints at the solution', (id) => {
    const w = workload(id);
    const c = control(id);
    expect(w.intendedBehavior).toContain('Adversarial examples');
    for (const phrase of c.requirementPhrases) expect(w.intendedBehavior, phrase).toContain(phrase);
    const corrected = Object.values(c.corrected).join('\n');
    const inputs = Object.values(w.initialFiles).join('\n');
    for (const marker of c.solutionMarkers) {
      expect(corrected, marker).toContain(marker);
      expect(inputs.includes(marker), marker).toBe(false);
    }
  });
});

describe('held-out separation', () => {
  it('keeps assessments and test-only variants out of the coding inputs', async () => {
    for (const w of NON_ROUTINE_WORKLOADS) {
      const c = control(w.id);
      const heldOut = [...Object.values(w.assessmentFiles), ...Object.values(c.corrected), ...Object.values(c.wrong)];
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
  it.each(IDS)('%s: original fails, corrected passes every criterion, plausible-wrong fails for its reason', async (id) => {
    const w = workload(id);
    const c = control(id);
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
