// Category tests for the frozen refactor workloads (CQ-M03d). Test-only benchmark
// scaffolding: nothing here runs a benchmark or ranks outcomes. The corrected and
// plausible-wrong candidates below are test-only bytes, so no solution reaches the
// dataset module or a coding snapshot. Every control runs the case's unchanged
// held-out assessment through `node --test` against a fresh coding snapshot.
//
// The refactor rule: the unsolved original passes every behaviour-preservation
// criterion and fails only the structural-intent one; the corrected variant passes
// everything; the plausible-wrong variant keeps the intended structure but changes
// behaviour, so the rubric never rewards a rewrite for its shape alone.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { REFACTOR_WORKLOADS } from './refactorWorkloads.js';
import {
  CORPUS_COVERAGE_TAGS, FROZEN_STARTING_COMMIT, SOURCE_REPOSITORY, WORKLOAD_CANDIDATE_ROOT_ENV,
  createAssessmentSnapshot, createCodingSnapshot, digestFiles, digestWorkload, readSnapshotFiles,
  validateWorkloads, type Workload, type WorkloadSnapshotHandle,
} from './workloadSnapshot.js';

type Files = Record<string, string>;
type Edit = readonly [from: string, to: string];

const IDS = [
  'refactor-usage-counter-normalization',
  'refactor-chat-budget-consolidation',
  'refactor-shared-path-normalization',
  'refactor-detached-snapshot-returns',
  'refactor-utf8-bounded-tail',
];
const SRC = 'packages/moe-daemon/src/';
const GROUNDING = [
  'scripts/prompt-cache-usage.mjs',
  `${SRC}util/chatPayload.ts`,
  `${SRC}util/chatBacklog.ts`,
  `${SRC}tools/chatRead.ts`,
  `${SRC}util/memorySettings.ts`,
  `${SRC}util/affectedFiles.ts`,
  `${SRC}util/cachedPlanPaths.ts`,
  `${SRC}delivery/executionProfile.ts`,
  `${SRC}util/errors.ts`,
  `${SRC}state/checkRunStore.ts`,
  `${SRC}util/enforcement.ts`,
];
const PINNED_WORKLOAD_DIGESTS: Files = {
  'refactor-usage-counter-normalization': 'sha256:0e5ded2721905748e0baba4f30dc755dd4241bc02df81bbce1ae2f0290695c9d',
  'refactor-chat-budget-consolidation': 'sha256:6a03fce4d6ce51d7a7b53268e9d678d142e75cc1e2c45c7429b69334cd07e15a',
  'refactor-shared-path-normalization': 'sha256:a386dfd1f88e0c4ea1e50252155a4f6dbf996a23c03e45f000a52105d7c78758',
  'refactor-detached-snapshot-returns': 'sha256:45fb5a62e4971672dd0727e4453943a7cc889f5c18f8acd48150670b088b0f84',
  'refactor-utf8-bounded-tail': 'sha256:ac866010f854cc7f872e5379505f396800ee9e1d4ccdd7d42221bc263a183ed6',
};
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const OWN_FILES = ['refactorWorkloads.ts', 'refactorWorkloads.test.ts'].map((file) => `${SRC}benchmarks/${file}`);

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
  const found = REFACTOR_WORKLOADS.find((w) => w.id === id);
  if (!found) throw new Error(`no refactor workload ${id}`);
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

const NEW_FILE = /^src\/[a-zA-Z]+\.mjs$/;

/**
 * A FRESH coding snapshot with test-only variant bytes written over its coding inputs.
 * A refactor may add a module, so a variant may also create a new flat src/*.mjs file.
 */
async function candidate(w: Workload, overrides: Files = {}): Promise<string> {
  const coding = await track(createCodingSnapshot(w));
  for (const [rel, content] of Object.entries(overrides)) {
    if (!(rel in w.initialFiles) && !NEW_FILE.test(rel)) throw new Error(`variant path ${rel} is not allowed for ${w.id}`);
    fs.writeFileSync(path.join(coding.root, ...rel.split('/')), content, { encoding: 'utf8', flag: rel in w.initialFiles ? 'w' : 'wx' });
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
  /** The behaviour-preservation criterion the plausible-wrong variant was written to break. */
  readonly wrongMustFail: string;
  /** The structural-intent criterion: the only one the unsolved original fails. */
  readonly intent: string;
  /** Exact criteria the plausible-wrong variant fails; includes wrongMustFail, never intent. */
  readonly wrongFails: readonly string[];
}

// Case 1: derive formatUsage from normalizeUsage (corrected) versus a derivation that
// checks only the input total for unknown usage (wrong: a codex cached>input prints numbers).
const USAGE = 'src/promptCacheUsage.mjs';
const USAGE_RAW_READS = `  const input = usage?.input_tokens;
  const read = provider === 'claude' ? usage?.cache_read_input_tokens : usage?.cached_input_tokens;
  const write = provider === 'claude' ? usage?.cache_creation_input_tokens : undefined;
  if (!count(input) || !count(read) || (provider === 'claude' ? !count(write) : read > input)) {
    return prefix + ' usage=unknown' + output;
  }
  const total = provider === 'claude' ? input + read + write : input;
  if (!Number.isSafeInteger(total)) return prefix + ' usage=unknown' + output;
  const uncached = provider === 'claude' ? input : input - read;
`;
const usageDerived = (unknown: string): string => `  const { inputTokens: total, cacheReadTokens: read, cacheWriteTokens: write, uncachedInputTokens: uncached } = normalized;
  // Normalized counters are null exactly when the raw ones were unusable or overflowed.
  if (${unknown}) {
    return prefix + ' usage=unknown' + output;
  }
`;
const USAGE_FIXED = patch(initial(IDS[0], USAGE), [
  [USAGE_RAW_READS, usageDerived(`total === null || read === null || (provider === 'claude' && write === null)`)],
]);
const USAGE_INPUT_ONLY = patch(initial(IDS[0], USAGE), [[USAGE_RAW_READS, usageDerived('total === null')]]);

// Case 2: one deliverChatPage helper used by both callers (corrected) versus the same
// helper reporting the last INPUT id as its cursor (wrong: skips omitted messages).
const PAYLOAD = 'src/chatPayload.mjs';
const BACKLOG = 'src/chatBacklog.mjs';
const READ = 'src/chatRead.mjs';
const DELIVERED_CURSOR = '    cursor: delivered.length > 0 ? delivered[delivered.length - 1].id : null,';
const PAYLOAD_FIXED = `${initial(IDS[1], PAYLOAD)}
/**
 * One response page: cap the list at the budget (always at least one message), truncate
 * what is delivered, and report the LAST DELIVERED id so whatever was dropped stays unread.
 */
export function deliverChatPage(messages, maxContentChars, budget = MAX_CHAT_RESPONSE_CHARS) {
  const { delivered, dropped } = capChatMessagesToResponseBudget(messages, maxContentChars, budget);
  const views = truncateChatMessages(delivered, maxContentChars);
  return {
    messages: views,
    dropped,
${DELIVERED_CURSOR}
    truncated: countTruncatedMessages(views),
  };
}
`;
const PAYLOAD_INPUT_CURSOR = patch(PAYLOAD_FIXED, [
  [DELIVERED_CURSOR, '    cursor: messages.length > 0 ? messages[messages.length - 1].id : null,'],
]);
const BACKLOG_FIXED = patch(initial(IDS[1], BACKLOG), [
  ["import { capChatMessagesToResponseBudget, countTruncatedMessages, truncateChatMessages } from './chatPayload.mjs';",
    "import { deliverChatPage } from './chatPayload.mjs';"],
  [`  const capped = capChatMessagesToResponseBudget(counted, maxContentChars, budget);
  const dropped = [...capped.dropped, ...ordered.slice(MAX_BURST_MESSAGES)];`,
  `  const page = deliverChatPage(counted, maxContentChars, budget);
  const dropped = [...page.dropped, ...ordered.slice(MAX_BURST_MESSAGES)];`],
  [`  for (const message of capped.delivered) cursorUpdates[message.channel] = message.id;
  const messages = truncateChatMessages(capped.delivered, maxContentChars);
  return {
    messages,
    cursorUpdates,
    hasMore: dropped.length > 0,
    truncated: countTruncatedMessages(messages),`,
  `  for (const message of page.messages) cursorUpdates[message.channel] = message.id;
  return {
    messages: page.messages,
    cursorUpdates,
    hasMore: dropped.length > 0,
    truncated: page.truncated,`],
]);
const READ_FIXED = patch(initial(IDS[1], READ), [
  ["import { MAX_CHAT_RESPONSE_CHARS, chatMessageResponseCost, truncateChatMessage } from './chatPayload.mjs';",
    "import { MAX_CHAT_RESPONSE_CHARS, deliverChatPage } from './chatPayload.mjs';"],
  [`  let kept = window.length;
  let used = 0;
  for (let i = 0; i < window.length; i++) {
    used += chatMessageResponseCost(window[i], maxContentChars);
    if (used > budget && i > 0) {
      kept = i;
      break;
    }
  }
  const delivered = window.slice(0, kept);
  const messages = delivered.map((message) => truncateChatMessage(message, maxContentChars));
  // The cursor is the newest DELIVERED id, so an omitted message stays unread.
  const cursor = delivered.length > 0 ? delivered[delivered.length - 1].id : sinceId || null;
  return {
    messages,
    cursor,
    omitted: window.length - delivered.length,
    truncated: messages.filter((message) => message.contentTruncated).length,
  };`,
  `  const page = deliverChatPage(window, maxContentChars, budget);
  return {
    messages: page.messages,
    cursor: page.cursor ?? (sinceId || null),
    omitted: page.dropped.length,
    truncated: page.truncated,
  };`],
]);

/** The text from the first `start` through the end of the first `end` after it. */
function section(text: string, start: string, end: string): string {
  const from = text.indexOf(start);
  const to = from < 0 ? -1 : text.indexOf(end, from);
  if (to < 0) throw new Error(`variant section not found: ${start.slice(0, 60)}`);
  return text.slice(from, to + end.length);
}

// Case 3: one shared affectedFiles.mjs (corrected) versus a pathKey that folds case on
// every platform (wrong: linux then reports Src/A.ts and src/a.ts as one file).
const PLAN = 'src/planScope.mjs';
const COLLIDE = 'src/collisions.mjs';
const SHARED = 'src/affectedFiles.mjs';
const PRIVATE_BLOCK = section(initial(IDS[2], PLAN), 'const MAX_PATH_LEN', '  return p;\n}\n');
const sharedPaths = (pathKeyBody: string): string => `// One affected-file path normalizer shared by every caller.
${patch(PRIVATE_BLOCK, [
  ['function invalidInput(', 'export function invalidInput('],
  ['function normalizeEntry(raw, fieldName) {', "export function normalizeAffectedFile(raw, fieldName = 'affectedFiles') {"],
])}
/** The comparison key for a normalized path. */
export function pathKey(p, platform) {
${pathKeyBody}
}
`;
const SHARED_FIXED = sharedPaths("  return platform === 'win32' || platform === 'darwin' ? p.toLowerCase() : p;");
const SHARED_ALWAYS_FOLDS = sharedPaths('  return p.toLowerCase();');
const PLAN_FIXED = patch(initial(IDS[2], PLAN), [
  [PRIVATE_BLOCK, "import { invalidInput, normalizeAffectedFile } from './affectedFiles.mjs';\n"],
  ['normalizeEntry(entry, fieldName)', 'normalizeAffectedFile(entry, fieldName)'],
]);
const COLLIDE_FIXED = patch(initial(IDS[2], COLLIDE), [
  [PRIVATE_BLOCK, "import { normalizeAffectedFile, pathKey } from './affectedFiles.mjs';\n"],
  [`  const caseInsensitive = platform === 'win32' || platform === 'darwin';
  const key = (p) => (caseInsensitive ? p.toLowerCase() : p);`, '  const key = (p) => pathKey(p, platform);'],
  ["normalizeEntry(entry, 'activeFiles')", "normalizeAffectedFile(entry, 'activeFiles')"],
  ["normalizeEntry(entry, 'claimedFiles')", "normalizeAffectedFile(entry, 'claimedFiles')"],
]);

// Case 4: return a fresh three-field literal (corrected) versus validating a JSON deep
// copy (wrong: class instances, an undefined-valued extra key and a Date change verdicts).
const PROFILE = 'src/executionProfile.mjs';
const PROFILE_FIXED = patch(initial(IDS[3], PROFILE), [
  ["  decodeProfile(raw.profile, field + '.profile');", "  const profile = decodeProfile(raw.profile, field + '.profile');"],
  ['  return raw;\n', '  return { version: 1, profile, planRevision };\n'],
]);
const PROFILE_JSON_COPY = patch(initial(IDS[3], PROFILE), [
  ['export function readExecutionPolicySnapshot(raw) {\n  if (raw === undefined) return undefined;\n',
    `export function readExecutionPolicySnapshot(input) {
  if (input === undefined) return undefined;
  // Validate and return a private deep copy, so no caller shares the stored object.
  const raw = input !== null && typeof input === 'object' ? JSON.parse(JSON.stringify(input)) : input;
`],
]);

// Case 5: one boundedUtf8Tail in textBudget.mjs (corrected) versus a raw byte cut that
// can start inside a character (wrong: U+FFFD appears and the byte bound is exceeded).
const BUDGET = 'src/textBudget.mjs';
const CHECK_TAIL = 'src/checkRunTail.mjs';
const SUMMARY = 'src/verificationSummary.mjs';
const utf8Tail = (body: string): string => `${initial(IDS[4], BUDGET)}
/** The final maxBytes UTF-8 bytes of text, never starting inside a character. */
export function boundedUtf8Tail(text, maxBytes) {
  const bytes = Buffer.from(text, 'utf8');
${body}
}
`;
const BUDGET_FIXED = utf8Tail(`  let start = Math.max(0, bytes.length - maxBytes);
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start += 1;
  return bytes.subarray(start).toString('utf8');`);
const BUDGET_RAW_CUT = utf8Tail("  return bytes.length <= maxBytes ? text : bytes.subarray(bytes.length - maxBytes).toString('utf8');");
const TAIL_IMPORT = "import { boundedUtf8Tail } from './textBudget.mjs';\n\n";
const CHECK_TAIL_FIXED = patch(initial(IDS[4], CHECK_TAIL), [
  ['export const MAX_CHECK_LOG_BYTES', `${TAIL_IMPORT}export const MAX_CHECK_LOG_BYTES`],
  [`  const bytes = Buffer.from(value, 'utf8');
  let start = Math.max(0, bytes.length - maxBytes);
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start += 1;
  return bytes.subarray(start).toString('utf8');`, '  return boundedUtf8Tail(value, maxBytes);'],
]);
const SUMMARY_FIXED = patch(initial(IDS[4], SUMMARY), [
  ['export const MAX_VERIFICATION_TAIL_BYTES', `${TAIL_IMPORT}export const MAX_VERIFICATION_TAIL_BYTES`],
  [`    const encoded = Buffer.from(v.outputTail, 'utf8');
    let from = encoded.length > maxBytes ? encoded.length - maxBytes : 0;
    // Never start inside a character: skip UTF-8 continuation bytes.
    while (from < encoded.length && (encoded[from] & 0xc0) === 0x80) from++;
    outputTail = encoded.subarray(from).toString('utf8');`, '    outputTail = boundedUtf8Tail(v.outputTail, maxBytes);'],
]);

const CONTROLS: readonly Control[] = [
  {
    id: IDS[0], corrected: { [USAGE]: USAGE_FIXED }, wrong: { [USAGE]: USAGE_INPUT_ONLY },
    intent: 'single-counter-normalization', wrongMustFail: 'format-output-preserved', wrongFails: ['format-output-preserved'],
  },
  {
    id: IDS[1],
    corrected: { [PAYLOAD]: PAYLOAD_FIXED, [BACKLOG]: BACKLOG_FIXED, [READ]: READ_FIXED },
    wrong: { [PAYLOAD]: PAYLOAD_INPUT_CURSOR, [BACKLOG]: BACKLOG_FIXED, [READ]: READ_FIXED },
    intent: 'single-budget-implementation', wrongMustFail: 'cursor-never-skips-omitted', wrongFails: ['cursor-never-skips-omitted'],
  },
  {
    id: IDS[2],
    corrected: { [SHARED]: SHARED_FIXED, [PLAN]: PLAN_FIXED, [COLLIDE]: COLLIDE_FIXED },
    wrong: { [SHARED]: SHARED_ALWAYS_FOLDS, [PLAN]: PLAN_FIXED, [COLLIDE]: COLLIDE_FIXED },
    intent: 'single-path-normalizer', wrongMustFail: 'collisions-preserved', wrongFails: ['collisions-preserved'],
  },
  {
    id: IDS[3], corrected: { [PROFILE]: PROFILE_FIXED }, wrong: { [PROFILE]: PROFILE_JSON_COPY },
    intent: 'returns-detached', wrongMustFail: 'validation-preserved', wrongFails: ['validation-preserved'],
  },
  {
    id: IDS[4],
    corrected: { [BUDGET]: BUDGET_FIXED, [CHECK_TAIL]: CHECK_TAIL_FIXED, [SUMMARY]: SUMMARY_FIXED },
    wrong: { [BUDGET]: BUDGET_RAW_CUT, [CHECK_TAIL]: CHECK_TAIL_FIXED, [SUMMARY]: SUMMARY_FIXED },
    intent: 'single-tail-helper', wrongMustFail: 'complete-characters',
    wrongFails: ['byte-bound-respected', 'complete-characters', 'tail-output-preserved'],
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

describe('refactor dataset', () => {
  it('validates against the landed contract with the five pinned ids in order', () => {
    expect(validateWorkloads(REFACTOR_WORKLOADS)).toEqual(REFACTOR_WORKLOADS);
    expect(Object.isFrozen(REFACTOR_WORKLOADS)).toBe(true);
    expect(REFACTOR_WORKLOADS.map((w) => w.id)).toEqual(IDS);
    for (const w of REFACTOR_WORKLOADS) {
      expect(w.category).toBe('refactor');
      expect(w.startingCommit).toBe(FROZEN_STARTING_COMMIT);
      expect(w.source.repository).toBe(SOURCE_REPOSITORY);
      expect(['reduced', 'adapted']).toContain(w.source.adaptation);
      expect(w.source.note.length).toBeGreaterThan(80);
      for (const p of w.source.paths) expect(GROUNDING).toContain(p);
    }
    expect(sorted(REFACTOR_WORKLOADS.flatMap((w) => w.source.paths))).toEqual(sorted(GROUNDING));
  });

  it('tags every case behaviour-preserving and the helper extractions reusable-helper', () => {
    const shared: readonly string[] = CORPUS_COVERAGE_TAGS;
    const tags = Object.fromEntries(REFACTOR_WORKLOADS.map((w) => [w.id, w.rubric.coverageTags.filter((t) => shared.includes(t))]));
    expect(tags).toEqual({
      'refactor-usage-counter-normalization': ['reusable-helper'],
      'refactor-chat-budget-consolidation': [],
      'refactor-shared-path-normalization': ['reusable-helper'],
      'refactor-detached-snapshot-returns': [],
      'refactor-utf8-bounded-tail': ['reusable-helper'],
    });
    for (const w of REFACTOR_WORKLOADS) expect(w.rubric.coverageTags, w.id).toContain('behavior-preservation');
  });

  it('names every rubric criterion in exactly one assessment test', () => {
    for (const w of REFACTOR_WORKLOADS) {
      const tests = Object.entries(w.assessmentFiles).filter(([p]) => p.endsWith('.test.mjs')).map(([, text]) => text).join('\n');
      const named = [...tests.matchAll(/^test\('([a-z0-9-]+): /gm)].map((m) => m[1]);
      expect(named.sort(), w.id).toEqual(criteriaOf(w));
      expect(tests).toContain(`process.env.${WORKLOAD_CANDIDATE_ROOT_ENV}`);
    }
  });

  it('pins every per-case workload digest', () => {
    expect(Object.fromEntries(REFACTOR_WORKLOADS.map((w) => [w.id, digestWorkload(w)]))).toEqual(PINNED_WORKLOAD_DIGESTS);
  });
});

describe('held-out separation', () => {
  it('keeps assessments and test-only variants out of the coding inputs', async () => {
    expect(CONTROLS.map((c) => c.id)).toEqual(IDS);
    for (const w of REFACTOR_WORKLOADS) {
      const control = CONTROLS.find((c) => c.id === w.id);
      const heldOut = [
        ...Object.values(w.assessmentFiles), ...Object.values(control?.corrected ?? {}), ...Object.values(control?.wrong ?? {}),
      ];
      for (const input of [...Object.values(w.initialFiles), w.intendedBehavior]) {
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
  it.each(CONTROLS)('$id: original keeps behaviour but misses the intent, corrected passes all, wrong changes behaviour', async (c) => {
    const w = workload(c.id);
    const all = criteriaOf(w);
    expect(all).toContain(c.intent);
    expect(c.wrongFails).toContain(c.wrongMustFail);
    expect(c.wrongFails).not.toContain(c.intent);

    // The original passes every behaviour-preservation criterion and fails only the intent one.
    const original = await runAssessment(w, await candidate(w));
    expect(original.exitOk, original.excerpt).toBe(false);
    expect(original.failed, original.excerpt).toEqual([c.intent]);
    expect(original.passed, original.excerpt).toEqual(without(all, [c.intent]));

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
