// =============================================================================
// Frozen defect workloads (CQ-M03c), corpus contract version 1
// =============================================================================
//
// Test-only benchmark data: the five defect cases of the CQ-M03 matched corpus,
// validated and deep-frozen at import against workloadSnapshot.ts. No production
// module imports this file.
//
// Each case is a REDUCED or ADAPTED Node ESM overlay of Moe source at
// FROZEN_STARTING_COMMIT (exact changes in each `source.note`), never a
// whole-repository checkout. Each also ships exactly one stale artifact under
// context/ or recipes/: inert data from an "earlier session", synthetic and
// labelled as such, that no fixture module imports and no assessment reads. The
// coding inputs hold only the unsolved original: the corrected and plausible-wrong
// candidates live in defectWorkloads.test.ts, and each held-out assessment is a
// node:test file that imports the candidate from the coding snapshot named by
// WORKLOAD_CANDIDATE_ROOT_ENV.
//
// Fixture files are String.raw templates, so every backslash is the fixture's own
// byte; fixture code uses string concatenation, never a template literal. Template
// line endings normalize to LF, so digests do not depend on the checkout.

import {
  FROZEN_STARTING_COMMIT, SOURCE_REPOSITORY, WORKLOAD_CANDIDATE_ROOT_ENV, validateWorkloads,
  type Workload,
} from './workloadSnapshot.js';

const js = String.raw;
const COMMON = { contractVersion: 1, category: 'defect', startingCommit: FROZEN_STARTING_COMMIT } as const;
const SRC = 'packages/moe-daemon/src/';

const PRELUDE = js`import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.env.${WORKLOAD_CANDIDATE_ROOT_ENV};
if (!root) throw new Error('${WORKLOAD_CANDIDATE_ROOT_ENV} is not set: point it at the candidate coding snapshot');
const candidatePath = (rel) => path.join(root, ...rel.split('/'));
const load = (rel) => import(pathToFileURL(candidatePath(rel)).href);
const sourceOf = (rel) => fs.readFileSync(candidatePath(rel), 'utf8');
`;

const IMPORT_CHECK = js`
// Static reuse check: every name is imported from spec, by name or through a namespace alias.
const importsAll = (text, spec, names) => {
  const named = [...text.matchAll(/import\s*\{([^}]*)\}\s*from\s*(['"])([^'"]+)\2/g)]
    .filter((m) => m[3] === spec).map((m) => m[1]).join(',');
  const aliases = [...text.matchAll(/import\s*\*\s*as\s+([A-Za-z_$][\w$]*)\s+from\s*(['"])([^'"]+)\2/g)]
    .filter((m) => m[3] === spec).map((m) => m[1]);
  return names.every((name) => new RegExp('(?:^|[^\\w$])' + name + '(?:$|[^\\w$])').test(named)
    || aliases.some((alias) => text.includes(alias + '.' + name)));
};
`;

const ERRORS = js`// Reduced from packages/moe-daemon/src/util/errors.ts at the frozen commit: types removed;
// only MoeError, the two codes these modules raise and the invalidInput factory are kept.
export const MoeErrorCode = Object.freeze({ INVALID_INPUT: -32602, NOT_ALLOWED: -32003 });

export class MoeError extends Error {
  constructor(code, message, context, codeName) {
    // Format: [CATEGORY] message
    const resolvedCodeName = codeName || (code === MoeErrorCode.NOT_ALLOWED ? 'NOT_ALLOWED' : 'INVALID_INPUT');
    super('[' + resolvedCodeName + '] ' + message);
    this.name = 'MoeError';
    this.code = code;
    this.codeName = resolvedCodeName;
    this.context = context;
  }
}

export function invalidInput(field, reason) {
  return new MoeError(MoeErrorCode.INVALID_INPUT, 'Invalid ' + field + ': ' + reason, { field, reason }, 'INVALID_INPUT');
}
`;

const EXECUTION_PROFILE = js`// Adapted from packages/moe-daemon/src/delivery/executionProfile.ts at the frozen commit: types
// removed; the policy-snapshot reader and the task-level resolver are dropped. Shared by every
// caller that admits or delivers work under an execution profile.
import { invalidInput, MoeError, MoeErrorCode } from './errors.mjs';

const PROFILES = Object.freeze({
  legacy: true,
  observe: true,
  'verified-local': true,
});
export const EXECUTION_PROFILES = Object.freeze(Object.keys(PROFILES));

function decodeProfile(value, field) {
  if (typeof value === 'string' && Object.prototype.hasOwnProperty.call(PROFILES, value)) return value;
  throw invalidInput(field, 'must be one of: ' + EXECUTION_PROFILES.join(', '));
}

/** Recognizing a requested profile does not certify that its execution path is ready. */
export function resolveExecutionProfile(settings) {
  const raw = settings?.executionProfile;
  return raw === undefined ? 'legacy' : decodeProfile(raw, 'executionProfile');
}

/**
 * Unconditionally unavailable until the stronger execution path is certified.
 * No persisted readiness label, environment flag, or caller assertion grants it.
 */
export function assertExecutionProfileReady(profile) {
  if (decodeProfile(profile, 'executionProfile') !== 'verified-local') return;
  throw new MoeError(
    MoeErrorCode.NOT_ALLOWED,
    'Execution profile verified-local is not ready: protected local isolation, trusted evidence and revision-bound delivery are not certified.',
    {
      executionProfile: 'verified-local',
      missingCapabilities: [
        'protected-host-control-plane',
        'isolated-agent-and-qa-vms',
        'isolated-check-vm',
        'authenticated-runner-evidence',
        'revision-bound-local-delivery',
      ],
    },
    'EXECUTION_PROFILE_NOT_READY',
  );
}
`;

/** One line, so the JSON artifacts can carry it verbatim as a string value. */
const STALE_HEADER = 'Captured from an earlier session; may be outdated. Synthetic stale artifact written for this '
  + 'benchmark case: it is not a copy of any repository file, and no fixture module or acceptance test reads it.';

// -----------------------------------------------------------------------------
// Case 1: stale-positive context claims a readiness helper the shared module lacks
// -----------------------------------------------------------------------------

const ADMISSION = js`// Admission gate: decides whether new work may start under the project's execution profile.
import { isExecutionProfileReady, resolveExecutionProfile } from './executionProfile.mjs';

export function admitTask(settings) {
  const profile = resolveExecutionProfile(settings);
  if (!isExecutionProfileReady(profile)) {
    return { admitted: false, profile, reason: 'EXECUTION_PROFILE_NOT_READY' };
  }
  return { admitted: true, profile };
}
`;

const READINESS_NOTES = js`# Session notes: execution-profile admission

${STALE_HEADER}

- src/executionProfile.mjs exports isExecutionProfileReady(profile). It returns true for legacy
  and observe, and for verified-local once an operator sets MOE_EXECUTION_PROFILE_READY=1 on a
  prepared host.
- src/admission.mjs already calls it; admitTask only needs the refusal details filled in.
`;

const ADMISSION_COMMON = js`
const MISSING = [
  'protected-host-control-plane', 'isolated-agent-and-qa-vms', 'isolated-check-vm',
  'authenticated-runner-evidence', 'revision-bound-local-delivery',
];
const REFUSED = { admitted: false, profile: 'verified-local', reason: 'EXECUTION_PROFILE_NOT_READY', missingCapabilities: MISSING };
// Loaded once; a load failure fails each test that needs the module instead of the whole file.
const loaded = await load('src/admission.mjs').then((module) => ({ module }), (error) => ({ error }));
const admission = () => {
  if (loaded.error) throw loaded.error;
  return loaded.module;
};
`;

const ADMISSION_ASSESSMENT = js`${PRELUDE}
delete process.env.MOE_EXECUTION_PROFILE_READY;
${ADMISSION_COMMON}
test('loads-with-frozen-exports: admission.mjs loads against the shared module as it is and exports admitTask', () => {
  assert.equal(typeof admission().admitTask, 'function');
});

test('admits-legacy-observe: an absent, legacy or observe profile is admitted with the resolved profile', () => {
  const { admitTask } = admission();
  assert.deepEqual(admitTask(undefined), { admitted: true, profile: 'legacy' });
  assert.deepEqual(admitTask({}), { admitted: true, profile: 'legacy' });
  assert.deepEqual(admitTask({ executionProfile: 'legacy' }), { admitted: true, profile: 'legacy' });
  assert.deepEqual(admitTask({ executionProfile: 'observe' }), { admitted: true, profile: 'observe' });
});

test('refuses-verified-local: verified-local is refused with the readiness reason and the missing capabilities', () => {
  const { admitTask } = admission();
  assert.deepEqual(admitTask({ executionProfile: 'verified-local' }), REFUSED);
});

test('rejects-malformed-profile: an unrecognised or non-string profile throws the shared invalid-input error', () => {
  const { admitTask } = admission();
  const expected = '[INVALID_INPUT] Invalid executionProfile: must be one of: legacy, observe, verified-local';
  for (const bad of ['Verified-Local', 'verified_local', '', 'strict', 1, null, true]) {
    assert.throws(() => admitTask({ executionProfile: bad }),
      (err) => err.codeName === 'INVALID_INPUT' && err.message === expected, JSON.stringify(bad));
  }
});

test('shared-module-unchanged: executionProfile.mjs keeps its frozen exports and its unconditional refusal', async () => {
  const shared = await load('src/executionProfile.mjs');
  assert.deepEqual(Object.keys(shared).sort(), ['EXECUTION_PROFILES', 'assertExecutionProfileReady', 'resolveExecutionProfile']);
  assert.deepEqual([...shared.EXECUTION_PROFILES], ['legacy', 'observe', 'verified-local']);
  assert.equal(shared.resolveExecutionProfile(undefined), 'legacy');
  for (const profile of ['legacy', 'observe']) assert.equal(shared.assertExecutionProfileReady(profile), undefined);
  assert.throws(() => shared.assertExecutionProfileReady('verified-local'), (err) => err.codeName === 'EXECUTION_PROFILE_NOT_READY'
    && err.code === -32003
    && JSON.stringify(err.context) === JSON.stringify({ executionProfile: 'verified-local', missingCapabilities: MISSING }));
});
`;

const READINESS_ENV_ASSESSMENT = js`${PRELUDE}
// Set BEFORE the candidate loads, so a module that reads the flag at import time sees it too.
process.env.MOE_EXECUTION_PROFILE_READY = '1';
${ADMISSION_COMMON}
test('ignores-readiness-env: verified-local stays refused while MOE_EXECUTION_PROFILE_READY is set', () => {
  const { admitTask } = admission();
  for (const flag of ['1', 'true', 'yes']) {
    process.env.MOE_EXECUTION_PROFILE_READY = flag;
    assert.deepEqual(admitTask({ executionProfile: 'verified-local' }), REFUSED, flag);
  }
  assert.deepEqual(admitTask({ executionProfile: 'observe' }), { admitted: true, profile: 'observe' });
});
`;

const STALE_POSITIVE_READINESS_HELPER = {
  ...COMMON,
  id: 'defect-stale-positive-readiness-helper',
  source: {
    repository: SOURCE_REPOSITORY,
    paths: [`${SRC}delivery/executionProfile.ts`, `${SRC}util/errors.ts`],
    adaptation: 'adapted',
    note: 'Adapted, not verbatim. src/executionProfile.mjs is delivery/executionProfile.ts at the frozen commit with '
      + 'types removed and readExecutionPolicySnapshot/resolveTaskExecutionProfile dropped; decodeProfile, '
      + 'resolveExecutionProfile and the unconditional assertExecutionProfileReady are kept as frozen. src/errors.mjs '
      + 'reduces util/errors.ts to MoeError, two codes and invalidInput. src/admission.mjs is a synthetic caller written '
      + 'for this case. context/stale-notes.md is a synthetic stale artifact: the isExecutionProfileReady export and '
      + 'the MOE_EXECUTION_PROFILE_READY flag it describes never existed at the frozen commit.',
  },
  intendedBehavior: 'admitTask(settings) in src/admission.mjs decides whether new work may start under the '
    + "project's execution profile, and the module currently fails to load. Make it load against "
    + 'src/executionProfile.mjs as it is and behave as follows. An absent executionProfile, legacy and observe '
    + "return { admitted: true, profile } with the resolved profile. verified-local returns { admitted: false, profile: "
    + "'verified-local', reason: 'EXECUTION_PROFILE_NOT_READY', missingCapabilities } carrying the capability list "
    + 'the shared readiness assertion reports, whatever the environment: no flag, label or caller assertion makes it '
    + 'ready. A malformed profile still throws the shared invalid-input error. Do not change '
    + 'src/executionProfile.mjs: its exports and behaviour are shared with other callers. The notes under context/ '
    + 'were captured in an earlier session and may be outdated.',
  initialFiles: {
    'src/errors.mjs': ERRORS,
    'src/executionProfile.mjs': EXECUTION_PROFILE,
    'src/admission.mjs': ADMISSION,
    'context/stale-notes.md': READINESS_NOTES,
  },
  assessmentFiles: { 'acceptance.test.mjs': ADMISSION_ASSESSMENT, 'readiness-env.test.mjs': READINESS_ENV_ASSESSMENT },
  rubric: {
    criteria: [
      { id: 'loads-with-frozen-exports', description: 'admission.mjs loads against the unchanged shared module and exports admitTask.' },
      { id: 'admits-legacy-observe', description: 'An absent, legacy or observe profile returns { admitted: true, profile }.' },
      { id: 'refuses-verified-local', description: 'verified-local returns the exact refusal object with EXECUTION_PROFILE_NOT_READY and the five missing capabilities.' },
      { id: 'ignores-readiness-env', description: 'verified-local stays refused when MOE_EXECUTION_PROFILE_READY is set before import and at call time.' },
      { id: 'rejects-malformed-profile', description: 'An unrecognised or non-string profile throws the shared invalid-input error with its exact message.' },
      { id: 'shared-module-unchanged', description: 'executionProfile.mjs keeps exactly its frozen exports and its unconditional verified-local refusal.' },
    ],
    coverageTags: ['stale-positive-context', 'execution-profile', 'fail-closed'],
  },
  snapshotDigest: 'sha256:a7d0e23a53eeffe7e4e3be9b503f754a1a17f893c68f6c4d7ac3f5ff8acb1ed2',
  assessmentDigest: 'sha256:23cea8d8ca1ee483ae4b2e84f9265b09745e078c3fd1d5f56fd3bafaeb2bc864',
};

// -----------------------------------------------------------------------------
// Case 2: stale-negative context claims no integer-option helper exists
// -----------------------------------------------------------------------------

const TASK_PAYLOAD = js`// Reduced from packages/moe-daemon/src/util/taskPayload.ts at the frozen commit: types removed;
// only the task-list constants and the shared integer-option normalizer are kept. The list and
// pending-question tools normalize their numeric options with it.
import { invalidInput } from './errors.mjs';

export const DEFAULT_TASK_LIST_LIMIT = 100;
export const MAX_TASK_LIST_LIMIT = 500;
export const DEFAULT_TASK_LIST_OFFSET = 0;

export function normalizeIntegerOption(value, field, fallback, min, max) {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw invalidInput(field, 'must be a finite number');
  }
  return Math.max(min, Math.min(max, Math.trunc(value)));
}
`;

const LIST_PAYLOAD = js`// Paging options for the task-list payload.
import { DEFAULT_TASK_LIST_LIMIT, DEFAULT_TASK_LIST_OFFSET } from './taskPayload.mjs';

export function listOptions(raw = {}) {
  const limit = parseInt(raw.limit, 10) || DEFAULT_TASK_LIST_LIMIT;
  const offset = parseInt(raw.offset, 10) || DEFAULT_TASK_LIST_OFFSET;
  return { limit, offset };
}
`;

const INTEGER_OPTION_NOTES = js`# Session notes: list paging options

${STALE_HEADER}

- There is no shared integer-option normalizer yet; each list module parses its own limit and
  offset. parseInt with a default fallback is the usual pattern.
- When adding validation here, clamp limit to 1-500 and offset to 0 or more.
`;

const INTEGER_OPTION_ASSESSMENT = js`${PRELUDE}${IMPORT_CHECK}
const { listOptions } = await load('src/listPayload.mjs');
const payload = await load('src/taskPayload.mjs');
const message = (field) => '[INVALID_INPUT] Invalid ' + field + ': must be a finite number';

test('defaults-when-absent: absent options take the list defaults', () => {
  assert.deepEqual(listOptions(), { limit: 100, offset: 0 });
  assert.deepEqual(listOptions({}), { limit: 100, offset: 0 });
  assert.deepEqual(listOptions({ limit: undefined, offset: undefined }), { limit: 100, offset: 0 });
  assert.deepEqual(listOptions({ limit: 7 }), { limit: 7, offset: 0 });
  assert.deepEqual(listOptions({ offset: 40 }), { limit: 100, offset: 40 });
});

test('clamps-and-truncates: numbers are truncated toward zero and clamped to their ranges', () => {
  const cases = [
    [{ limit: 9999 }, { limit: 500, offset: 0 }],
    [{ limit: 0 }, { limit: 1, offset: 0 }],
    [{ limit: -5 }, { limit: 1, offset: 0 }],
    [{ limit: 2.9 }, { limit: 2, offset: 0 }],
    [{ limit: 500.7 }, { limit: 500, offset: 0 }],
    [{ offset: -3 }, { limit: 100, offset: 0 }],
    [{ offset: 2.7 }, { limit: 100, offset: 2 }],
    [{ offset: 1e20 }, { limit: 100, offset: Number.MAX_SAFE_INTEGER }],
  ];
  for (const [input, expected] of cases) assert.deepEqual(listOptions(input), expected, JSON.stringify(input));
});

test('rejects-non-numbers: a present value that is not a finite number throws the invalid-input error naming the field', () => {
  for (const field of ['limit', 'offset']) {
    for (const bad of ['5', '', null, NaN, Infinity, -Infinity, true, [3], { valueOf: () => 3 }]) {
      assert.throws(() => listOptions({ [field]: bad }),
        (err) => err.codeName === 'INVALID_INPUT' && err.message === message(field), field + '=' + String(bad));
    }
  }
});

test('reuses-integer-option-helper: listPayload.mjs imports normalizeIntegerOption and parses no numbers itself', () => {
  const text = sourceOf('src/listPayload.mjs');
  assert.ok(importsAll(text, './taskPayload.mjs', ['normalizeIntegerOption']), 'normalizeIntegerOption must come from ./taskPayload.mjs');
  assert.ok(/normalizeIntegerOption\s*\(/.test(text), 'listPayload.mjs must call normalizeIntegerOption, not only import it');
  for (const own of ['parseInt', 'parseFloat', 'Number(', 'Math.', 'isFinite', 'isNaN', 'invalidInput']) {
    assert.ok(!text.includes(own), 'listPayload.mjs carries its own number handling: ' + JSON.stringify(own));
  }
  assert.ok(!/\bthrow\b/.test(text), 'listPayload.mjs throws by itself instead of through the helper');
});

test('helper-unchanged: normalizeIntegerOption and the list constants keep their behaviour for other callers', () => {
  assert.deepEqual(Object.keys(payload).sort(),
    ['DEFAULT_TASK_LIST_LIMIT', 'DEFAULT_TASK_LIST_OFFSET', 'MAX_TASK_LIST_LIMIT', 'normalizeIntegerOption']);
  assert.deepEqual([payload.DEFAULT_TASK_LIST_LIMIT, payload.MAX_TASK_LIST_LIMIT, payload.DEFAULT_TASK_LIST_OFFSET], [100, 500, 0]);
  const normalize = payload.normalizeIntegerOption;
  assert.equal(normalize(undefined, 'limit', 10, 1, 50), 10);
  assert.equal(normalize(75, 'limit', 10, 1, 50), 50);
  assert.equal(normalize(-2.5, 'limit', 10, -10, 50), -2);
  assert.equal(normalize(0, 'maxContentChars', 1000, 0, 10000), 0);
  assert.throws(() => normalize('3', 'maxQuestionsPerTask', 3, 1, 20), (err) => err.message === message('maxQuestionsPerTask'));
  assert.throws(() => normalize(null, 'limit', 10, 1, 50), (err) => err.codeName === 'INVALID_INPUT');
});
`;

const STALE_NEGATIVE_INTEGER_OPTION = {
  ...COMMON,
  id: 'defect-stale-negative-integer-option',
  source: {
    repository: SOURCE_REPOSITORY,
    paths: [`${SRC}util/taskPayload.ts`, `${SRC}tools/getPendingQuestions.ts`, `${SRC}util/errors.ts`],
    adaptation: 'adapted',
    note: 'Adapted, not verbatim. src/taskPayload.mjs reduces util/taskPayload.ts at the frozen commit to the three '
      + 'task-list constants and normalizeIntegerOption (types removed, body as frozen); tools/getPendingQuestions.ts '
      + 'is the frozen caller pattern that normalizes its numeric options with that helper. src/errors.mjs reduces '
      + 'util/errors.ts. src/listPayload.mjs is a synthetic caller with its own parseInt parsing, written for this '
      + 'case. context/stale-notes.md is a synthetic stale artifact: its claim that no shared integer-option '
      + 'normalizer exists is false at the frozen commit.',
  },
  intendedBehavior: 'listOptions(raw) in src/listPayload.mjs parses the task-list paging options; it currently '
    + 'accepts numeric strings, never clamps and silently replaces 0. Fix it so that limit defaults to '
    + 'DEFAULT_TASK_LIST_LIMIT (100) and is truncated toward zero and clamped to [1, MAX_TASK_LIST_LIMIT (500)], and '
    + 'offset defaults to 0 and is truncated and clamped to [0, Number.MAX_SAFE_INTEGER]. An absent (undefined) '
    + 'option takes its default; any other value that is not a finite number (numeric strings such as "5", null, NaN, '
    + "Infinity, booleans, arrays, objects) throws the project's invalid-input error naming the field, exactly "
    + '"[INVALID_INPUT] Invalid limit: must be a finite number" (or offset). Reuse the existing integer-option '
    + 'normalization instead of adding another parser, and keep it unchanged for its other callers. The notes '
    + 'under context/ were captured in an earlier session and may be outdated.',
  initialFiles: {
    'src/errors.mjs': ERRORS,
    'src/taskPayload.mjs': TASK_PAYLOAD,
    'src/listPayload.mjs': LIST_PAYLOAD,
    'context/stale-notes.md': INTEGER_OPTION_NOTES,
  },
  assessmentFiles: { 'acceptance.test.mjs': INTEGER_OPTION_ASSESSMENT },
  rubric: {
    criteria: [
      { id: 'defaults-when-absent', description: 'Absent options take limit 100 and offset 0; present ones are kept.' },
      { id: 'clamps-and-truncates', description: 'Numbers truncate toward zero and clamp: 9999 -> 500, 0 -> 1, 2.9 -> 2, offset -3 -> 0, offset 1e20 -> MAX_SAFE_INTEGER.' },
      { id: 'rejects-non-numbers', description: 'Numeric strings, null, NaN, infinities, booleans, arrays and objects throw the exact invalid-input message naming the field.' },
      { id: 'reuses-integer-option-helper', description: 'listPayload.mjs imports and calls normalizeIntegerOption from ./taskPayload.mjs and has no number parsing, clamping or throwing of its own.' },
      { id: 'helper-unchanged', description: 'normalizeIntegerOption and the task-list constants keep their frozen exports and behaviour.' },
    ],
    coverageTags: ['stale-negative-context', 'reusable-helper', 'input-normalization'],
  },
  snapshotDigest: 'sha256:e9171de0afdc5892580f0a3d8cad0c44ede26654ebf22176ca90acbb0a3d8507',
  assessmentDigest: 'sha256:75070ab7a40cf3471104d773665d8d1eaca33830a7d05467055f77b63b9c643f',
};

// -----------------------------------------------------------------------------
// Case 3: a changed caller passes an options object to a positional helper
// -----------------------------------------------------------------------------

const CHAT_PAYLOAD = js`// Reduced from packages/moe-daemon/src/util/chatPayload.ts at the frozen commit: types removed;
// only the response-budget constants and the two budget helpers are kept.

/** Ceiling on the TOTAL content a single chat response may carry. */
export const MAX_CHAT_RESPONSE_CHARS = 40_000;
/** Approximate serialized overhead of one message's metadata fields. */
export const CHAT_MESSAGE_OVERHEAD_CHARS = 220;

/**
 * How many chars a message will occupy in a response once maxContentChars
 * truncation is applied. maxContentChars <= 0 means "no truncation".
 */
export function chatMessageResponseCost(message, maxContentChars) {
  const contentChars = maxContentChars > 0
    ? Math.min(message.content.length, maxContentChars)
    : message.content.length;
  return contentChars + CHAT_MESSAGE_OVERHEAD_CHARS;
}

/**
 * Cut a message list at the response-size ceiling. Returns the prefix that
 * fits plus what was left behind, so the caller can keep the undelivered tail
 * unread instead of advancing a cursor past it. Always yields at least one
 * message - a single oversized message must still be deliverable, or the
 * caller would spin on it forever.
 */
export function capChatMessagesToResponseBudget(messages, maxContentChars, budget = MAX_CHAT_RESPONSE_CHARS) {
  let used = 0;
  for (let i = 0; i < messages.length; i++) {
    used += chatMessageResponseCost(messages[i], maxContentChars);
    if (used > budget && i > 0) {
      return { delivered: messages.slice(0, i), dropped: messages.slice(i) };
    }
  }
  return { delivered: messages, dropped: [] };
}
`;

const CHAT_READ = js`// Chat read page builder. Changed in this revision: callers now pass the per-message content
// cap and the response budget together, as one options object.
import { capChatMessagesToResponseBudget } from './chatPayload.mjs';

/** One page of a channel: the ids delivered now and the cursor of the first undelivered message. */
export function readPage(messages, options) {
  const { delivered, dropped } = capChatMessagesToResponseBudget(messages, {
    maxContentChars: options.maxContentChars,
    budget: options.budget,
  });
  return { ids: delivered.map((m) => m.id), nextCursor: dropped.length > 0 ? dropped[0].id : null };
}
`;

const CACHED_SIGNATURES = `${JSON.stringify({
  header: STALE_HEADER,
  module: 'src/chatPayload.mjs',
  signatures: {
    chatMessageResponseCost: '(message, maxContentChars: number) => number',
    capChatMessagesToResponseBudget: '(messages, maxContentChars: number, budget?: number) => { delivered, dropped }',
  },
  callers: { 'src/chatRead.mjs': 'passes maxContentChars and budget as positional numbers' },
}, null, 2)}\n`;

const CHAT_BUDGET_ASSESSMENT = js`${PRELUDE}
const payload = await load('src/chatPayload.mjs');
const { capChatMessagesToResponseBudget: cap } = payload;
const { readPage } = await load('src/chatRead.mjs');
const message = (id, length) => ({ id, sender: 'worker-1', content: 'x'.repeat(length) });
// Three 50-char messages and one 5-char message.
const MESSAGES = Object.freeze([message('m1', 50), message('m2', 50), message('m3', 50), message('m4', 5)]);
const ids = (list) => list.map((m) => m.id);
const split = (result) => [ids(result.delivered), ids(result.dropped)];
const namesOption = (field) => (err) => err instanceof TypeError && err.message.includes(field);

test('accepts-options-shape: the options object sets the content cap and budget, directly and through readPage', () => {
  assert.deepEqual(split(cap(MESSAGES, { maxContentChars: 10, budget: 700 })), [['m1', 'm2', 'm3'], ['m4']]);
  assert.deepEqual(split(cap(MESSAGES, { maxContentChars: 0, budget: 600 })), [['m1', 'm2'], ['m3', 'm4']]);
  assert.deepEqual(split(cap(MESSAGES, { maxContentChars: 10 })), [['m1', 'm2', 'm3', 'm4'], []]);
  assert.deepEqual(readPage(MESSAGES, { maxContentChars: 10, budget: 700 }), { ids: ['m1', 'm2', 'm3'], nextCursor: 'm4' });
  assert.deepEqual(readPage(MESSAGES, { maxContentChars: 0, budget: 600 }), { ids: ['m1', 'm2'], nextCursor: 'm3' });
});

test('legacy-positional-still-works: positional callers and the cost helper behave exactly as before', () => {
  assert.deepEqual(split(cap(MESSAGES, 10, 700)), [['m1', 'm2', 'm3'], ['m4']]);
  assert.deepEqual(split(cap(MESSAGES, 0, 600)), [['m1', 'm2'], ['m3', 'm4']]);
  assert.deepEqual(split(cap(MESSAGES, 10)), [['m1', 'm2', 'm3', 'm4'], []]);
  assert.deepEqual(split(cap(MESSAGES, -1, 539)), [['m1'], ['m2', 'm3', 'm4']]);
  assert.equal(payload.chatMessageResponseCost(message('a', 50), 10), 230);
  assert.equal(payload.chatMessageResponseCost(message('a', 50), 0), 270);
  assert.deepEqual([payload.CHAT_MESSAGE_OVERHEAD_CHARS, payload.MAX_CHAT_RESPONSE_CHARS], [220, 40000]);
});

test('always-delivers-one: an over-budget first message is still delivered alone', () => {
  const big = message('big', 5000);
  const small = message('small', 1);
  assert.deepEqual(split(cap([big], { maxContentChars: 0, budget: 1 })), [['big'], []]);
  assert.deepEqual(split(cap([big, small], { maxContentChars: 0, budget: 1 })), [['big'], ['small']]);
  assert.deepEqual(readPage([big, small], { maxContentChars: 0, budget: 1 }), { ids: ['big'], nextCursor: 'small' });
});

test('keeps-undelivered-tail: dropped is exactly the undelivered tail, in order, and the input is untouched', () => {
  const list = [...MESSAGES];
  const result = cap(list, { maxContentChars: 10, budget: 460 });
  assert.deepEqual(split(result), [['m1', 'm2'], ['m3', 'm4']]);
  [...result.delivered, ...result.dropped].forEach((m, i) => assert.equal(m, MESSAGES[i]));
  assert.deepEqual(ids(list), ['m1', 'm2', 'm3', 'm4']);
  assert.deepEqual(cap([], { maxContentChars: 10, budget: 460 }), { delivered: [], dropped: [] });
  assert.deepEqual(readPage(MESSAGES, { maxContentChars: 10, budget: 460 }), { ids: ['m1', 'm2'], nextCursor: 'm3' });
});

test('rejects-bad-options: a non-finite content cap or a budget that is not a positive finite number throws a TypeError naming it', () => {
  for (const maxContentChars of ['10', NaN, Infinity, null]) {
    assert.throws(() => cap(MESSAGES, { maxContentChars, budget: 700 }), namesOption('maxContentChars'), String(maxContentChars));
  }
  for (const budget of [0, -1, NaN, Infinity, '700', null]) {
    assert.throws(() => cap(MESSAGES, { maxContentChars: 10, budget }), namesOption('budget'), String(budget));
  }
  assert.throws(() => cap(MESSAGES, '10'), namesOption('maxContentChars'));
  assert.throws(() => cap(MESSAGES, null), namesOption('maxContentChars'));
});
`;

const CHANGED_CALLER_CHAT_BUDGET = {
  ...COMMON,
  id: 'defect-changed-caller-chat-budget',
  source: {
    repository: SOURCE_REPOSITORY,
    paths: [`${SRC}util/chatPayload.ts`],
    adaptation: 'adapted',
    note: 'Adapted, not verbatim. src/chatPayload.mjs reduces util/chatPayload.ts at the frozen commit to '
      + 'MAX_CHAT_RESPONSE_CHARS, CHAT_MESSAGE_OVERHEAD_CHARS, chatMessageResponseCost and '
      + 'capChatMessagesToResponseBudget, with types removed, bodies as frozen and the em dash in one comment written '
      + 'as a hyphen. At the frozen commit every caller passes the helper positional numbers. src/chatRead.mjs is a '
      + 'synthetic changed caller written for this case, and context/cached-signatures.json is a synthetic stale '
      + 'artifact that records the positional signature as the only one.',
  },
  intendedBehavior: 'src/chatRead.mjs is a changed caller: readPage(messages, { maxContentChars, budget }) now passes '
    + 'one options object to capChatMessagesToResponseBudget in src/chatPayload.mjs, which still reads positional '
    + 'numbers, so pages are cut with the wrong limits. Make capChatMessagesToResponseBudget accept both the options '
    + 'object (messages, { maxContentChars, budget }) and the legacy positional form (messages, maxContentChars, '
    + 'budget) that other callers still use, with budget defaulting to MAX_CHAT_RESPONSE_CHARS in both. Validate both '
    + 'values in either form: maxContentChars must be a finite number (0 or less still means no truncation) and '
    + 'budget, when given, a finite number greater than 0; otherwise throw a TypeError whose message names the '
    + 'offending option. Keep the cut semantics: cost per message as chatMessageResponseCost computes it, a cut only '
    + 'when the running total exceeds the budget, at least one message always delivered, and dropped being exactly '
    + 'the undelivered tail in order. The signature index under context/ was captured in an earlier session and '
    + 'may be outdated.',
  initialFiles: {
    'src/chatPayload.mjs': CHAT_PAYLOAD,
    'src/chatRead.mjs': CHAT_READ,
    'context/cached-signatures.json': CACHED_SIGNATURES,
  },
  assessmentFiles: { 'acceptance.test.mjs': CHAT_BUDGET_ASSESSMENT },
  rubric: {
    criteria: [
      { id: 'accepts-options-shape', description: 'The options object sets the cap and budget: exact delivered and dropped ids, directly and through readPage.' },
      { id: 'legacy-positional-still-works', description: 'Positional calls, the cost helper and both constants behave exactly as frozen.' },
      { id: 'always-delivers-one', description: 'An over-budget first message is still delivered alone through the options form.' },
      { id: 'keeps-undelivered-tail', description: 'dropped is the exact undelivered tail by identity and order; the input list is not mutated.' },
      { id: 'rejects-bad-options', description: 'A non-finite cap, or a budget that is not a positive finite number, throws a TypeError naming the option.' },
    ],
    coverageTags: ['changed-caller', 'response-budget', 'backward-compatibility'],
  },
  snapshotDigest: 'sha256:048074df673a8408d102072e6c63f2c5eafd9899a7d9cf5f517583155a2f0e8f',
  assessmentDigest: 'sha256:c6bc7b1a6fe824af6b60becd12164385b661ccac3e453cf6659aa957b02745d4',
};

// -----------------------------------------------------------------------------
// Case 4: changed requirements supersede stale review notes on policy fallbacks
// -----------------------------------------------------------------------------

const DELIVERY_POLICY = js`// Adapted from resolveDeliveryPolicy in packages/moe-daemon/src/delivery/policy.ts at the frozen
// commit: types removed and reduced to the policy vocabulary and its decoder.

/** Every recognised deliveryPolicy, in documentation order. */
const POLICIES = Object.freeze({
  legacy: true,
  'local-branch': true,
  'remote-push': true,
  'merged-pull-request': true,
  'manual-artifact': true,
});
export const DELIVERY_POLICIES = Object.freeze(Object.keys(POLICIES));

/** What an absent or null setting means. */
export const DEFAULT_DELIVERY_POLICY = 'legacy';

/** The project's delivery policy. An unrecognised value falls back to the default. */
export function resolveDeliveryPolicy(settings) {
  const raw = settings?.deliveryPolicy;
  if (typeof raw === 'string' && Object.prototype.hasOwnProperty.call(POLICIES, raw)) return raw;
  return DEFAULT_DELIVERY_POLICY;
}
`;

const EFFECTIVE_POLICY = js`// The delivery policy that applies to new work under the project's execution profile.
import { resolveDeliveryPolicy } from './deliveryPolicy.mjs';
import { resolveExecutionProfile } from './executionProfile.mjs';

export function effectiveDeliveryPolicy(settings) {
  const policy = resolveDeliveryPolicy(settings);
  const profile = resolveExecutionProfile(settings);
  // observe only watches delivery, so it never enforces a strict policy.
  if (profile === 'observe') return 'legacy';
  return policy;
}
`;

const POLICY_REVIEW_NOTES = js`# Review notes: delivery-policy fallbacks

${STALE_HEADER}

- resolveDeliveryPolicy should fall back to legacy for any value it does not recognise, so a
  typo or a different capitalisation in project settings never blocks delivery.
- Under the observe execution profile, report legacy: observe only watches delivery and
  should not enforce a strict policy.
- verified-local can use the configured policy like any other profile.
`;

const DELIVERY_POLICY_ASSESSMENT = js`${PRELUDE}
const { resolveDeliveryPolicy } = await load('src/deliveryPolicy.mjs');
const { effectiveDeliveryPolicy } = await load('src/effectivePolicy.mjs');
const POLICIES = ['legacy', 'local-branch', 'remote-push', 'merged-pull-request', 'manual-artifact'];
const ALLOWED = '[INVALID_INPUT] Invalid deliveryPolicy: must be one of legacy, local-branch, remote-push, '
  + 'merged-pull-request, manual-artifact';
const refusesUnknown = (err) => err.codeName === 'INVALID_INPUT' && typeof err.message === 'string' && err.message.startsWith(ALLOWED);

test('absent-null-default-legacy: an absent or null deliveryPolicy means legacy', () => {
  for (const settings of [undefined, null, {}, { deliveryPolicy: null }, { deliveryPolicy: undefined, executionProfile: 'legacy' }]) {
    assert.equal(effectiveDeliveryPolicy(settings), 'legacy', JSON.stringify(settings));
    assert.equal(resolveDeliveryPolicy(settings), 'legacy', JSON.stringify(settings));
  }
});

test('recognized-values-pass: each recognised policy is returned exactly under an absent or legacy profile', () => {
  for (const policy of POLICIES) {
    assert.equal(resolveDeliveryPolicy({ deliveryPolicy: policy }), policy);
    assert.equal(effectiveDeliveryPolicy({ deliveryPolicy: policy }), policy);
    assert.equal(effectiveDeliveryPolicy({ deliveryPolicy: policy, executionProfile: 'legacy' }), policy);
  }
});

test('unknown-refused: any other value throws the invalid-input error naming the allowed policies', () => {
  const unknown = ['LOCAL-BRANCH', 'Local-Branch', 'Legacy', ' legacy', 'legacy ', '', 'strict', 'local_branch', 0, 1, false, true, {}, ['legacy']];
  for (const bad of unknown) {
    assert.throws(() => resolveDeliveryPolicy({ deliveryPolicy: bad }), refusesUnknown, JSON.stringify(bad));
    for (const executionProfile of [undefined, 'legacy', 'observe']) {
      assert.throws(() => effectiveDeliveryPolicy({ deliveryPolicy: bad, executionProfile }), refusesUnknown, JSON.stringify(bad));
    }
  }
});

test('observe-never-relaxes: the observe profile returns the live policy unchanged', () => {
  for (const policy of POLICIES) assert.equal(effectiveDeliveryPolicy({ deliveryPolicy: policy, executionProfile: 'observe' }), policy);
  assert.equal(effectiveDeliveryPolicy({ executionProfile: 'observe' }), 'legacy');
});

test('verified-local-not-ready: verified-local is refused by the shared readiness assertion, whatever the policy', () => {
  for (const deliveryPolicy of [undefined, 'legacy', 'local-branch']) {
    assert.throws(() => effectiveDeliveryPolicy({ deliveryPolicy, executionProfile: 'verified-local' }),
      (err) => err.codeName === 'EXECUTION_PROFILE_NOT_READY' && err.code === -32003
        && Array.isArray(err.context?.missingCapabilities) && err.context.missingCapabilities.length === 5, String(deliveryPolicy));
  }
  assert.throws(() => effectiveDeliveryPolicy({ executionProfile: 'Verified-Local' }), (err) => err.codeName === 'INVALID_INPUT');
});
`;

const CHANGED_REQUIREMENTS_DELIVERY_POLICY = {
  ...COMMON,
  id: 'defect-changed-requirements-delivery-policy',
  source: {
    repository: SOURCE_REPOSITORY,
    paths: [`${SRC}delivery/policy.ts`, `${SRC}delivery/executionProfile.ts`, `${SRC}util/errors.ts`],
    adaptation: 'adapted',
    note: 'Adapted, not verbatim. src/deliveryPolicy.mjs reduces delivery/policy.ts at the frozen commit to the policy '
      + 'vocabulary and resolveDeliveryPolicy, types removed. Its lenient fallback (an unrecognised value read as '
      + 'legacy) is synthetic and deliberately re-introduced as the defect: at the frozen commit resolveDeliveryPolicy '
      + 'already refuses any unrecognised value, and its message also echoes the rejected value. '
      + 'src/executionProfile.mjs and src/errors.mjs are the same adaptations of delivery/executionProfile.ts and '
      + 'util/errors.ts as in the stale-positive case. src/effectivePolicy.mjs, with its observe-to-legacy '
      + 'relaxation, is a synthetic caller, and context/stale-review-notes.md is a synthetic stale artifact that '
      + 'recommends those fallbacks.',
  },
  intendedBehavior: 'Requirements changed after the review notes under context/ were written; they may be outdated. '
    + 'effectiveDeliveryPolicy(settings) in src/effectivePolicy.mjs, and resolveDeliveryPolicy(settings) in '
    + 'src/deliveryPolicy.mjs as the single decoder of settings.deliveryPolicy, must now behave as follows. An absent '
    + 'or null deliveryPolicy means legacy. Each of the five recognised policies is returned exactly. Any other value '
    + '(different capitalisation, surrounding spaces, the empty string, unknown names, non-strings) throws the shared '
    + 'invalid-input error whose message starts "[INVALID_INPUT] Invalid deliveryPolicy: must be one of legacy, '
    + 'local-branch, remote-push, merged-pull-request, manual-artifact"; it is never coerced or read as the default. '
    + 'Under an absent, legacy or observe execution profile the policy is returned unchanged: observe never relaxes '
    + 'a strict policy. verified-local is refused through the shared readiness assertion '
    + '(EXECUTION_PROFILE_NOT_READY) instead of returning a policy, and a malformed profile still throws invalid input.',
  initialFiles: {
    'src/errors.mjs': ERRORS,
    'src/executionProfile.mjs': EXECUTION_PROFILE,
    'src/deliveryPolicy.mjs': DELIVERY_POLICY,
    'src/effectivePolicy.mjs': EFFECTIVE_POLICY,
    'context/stale-review-notes.md': POLICY_REVIEW_NOTES,
  },
  assessmentFiles: { 'acceptance.test.mjs': DELIVERY_POLICY_ASSESSMENT },
  rubric: {
    criteria: [
      { id: 'absent-null-default-legacy', description: 'An absent or null deliveryPolicy resolves to legacy in both functions.' },
      { id: 'recognized-values-pass', description: 'Each of the five recognised policies is returned exactly under an absent or legacy profile.' },
      { id: 'unknown-refused', description: 'Case variants, padded or empty strings, unknown names and non-strings throw invalid input naming the allowed policies.' },
      { id: 'observe-never-relaxes', description: 'The observe profile returns the live policy unchanged, strict ones included.' },
      { id: 'verified-local-not-ready', description: 'verified-local throws EXECUTION_PROFILE_NOT_READY with the missing capabilities, whatever the policy.' },
    ],
    coverageTags: ['changed-requirements', 'delivery-policy', 'fail-closed'],
  },
  snapshotDigest: 'sha256:149c04a0e49ba4dcf9b314ab830911a5d215df51ebab78e65de8642cc692e564',
  assessmentDigest: 'sha256:f6aaa4b60281cdd5d7b8e9dda138efe3f0e3332156d0fb6ffe901db5f20dca69',
};

// -----------------------------------------------------------------------------
// Case 5: a stored verification recipe does not fit the declared platform/runtime
// -----------------------------------------------------------------------------

const POSIX_GIT_ENV = { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
const STORED_RECIPES = `${JSON.stringify({
  header: STALE_HEADER,
  recipes: [
    { id: 'win-pwsh', platform: 'win32', runtime: 'pwsh', argv: ['pwsh', '-NoProfile', '-File', 'scripts/verify.ps1'],
      env: { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: 'NUL' } },
    { id: 'linux-bun', platform: 'linux', runtime: 'bun', argv: ['bun', 'test'], env: POSIX_GIT_ENV },
    { id: 'linux-node', platform: 'linux', runtime: 'node', argv: ['node', '--test'], env: POSIX_GIT_ENV },
  ],
}, null, 2)}\n`;

const VERIFICATION = js`// Runs the project's stored verification recipe through an injected exec(argv, options).
// The argv-only exec contract and the platform-specific GIT_CONFIG_GLOBAL values (NUL on win32,
// /dev/null elsewhere) follow runGit in packages/moe-daemon/src/util/cachedPlanPaths.ts.
//
// recipes: [{ id, platform, runtime, argv, env }]
// env: the host, { platform, runtimes }
// exec: (argv, { env }) => result, the only way anything runs

export function runVerification(recipes, env, exec) {
  const recipe = recipes[0];
  return { action: 'run', id: recipe.id, result: exec(recipe.argv, { env: recipe.env }) };
}
`;

const RECIPE_ASSESSMENT = js`${PRELUDE}
const { runVerification } = await load('src/verification.mjs');
const POSIX_ENV = { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
const WINDOWS_ENV = { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: 'NUL' };
const recipe = (id, platform, runtime, argv, env) => ({ id, platform, runtime, argv, env });
const WIN_PWSH = recipe('win-pwsh', 'win32', 'pwsh', ['pwsh', '-NoProfile', '-File', 'scripts/check.ps1'], WINDOWS_ENV);
const LINUX_BUN = recipe('linux-bun', 'linux', 'bun', ['bun', 'test'], POSIX_ENV);
const LINUX_NODE = recipe('linux-node', 'linux', 'node', ['node', '--test', 'test/'], POSIX_ENV);
const ORDERED = [WIN_PWSH, LINUX_BUN, LINUX_NODE];
const RESULT = Object.freeze({ status: 0 });
// The only runner: it records each call and never starts a process.
const spy = () => {
  const calls = [];
  return { calls, exec: (argv, options) => (calls.push([argv, options]), RESULT) };
};
const ran = (id) => ({ action: 'run', id, result: RESULT });
const refused = (rejected) => ({ action: 'reject', reason: 'NO_COMPATIBLE_RECIPE', rejected });

test('selects-compatible-recipe: the first recipe for this platform runs once with its own argv and env', () => {
  const linux = spy();
  assert.deepEqual(runVerification(ORDERED, { platform: 'linux', runtimes: ['bun', 'node'] }, linux.exec), ran('linux-bun'));
  assert.deepEqual(linux.calls, [[['bun', 'test'], { env: POSIX_ENV }]]);
  const windows = spy();
  assert.deepEqual(runVerification(ORDERED, { platform: 'win32', runtimes: ['pwsh', 'node'] }, windows.exec), ran('win-pwsh'));
  assert.deepEqual(windows.calls, [[['pwsh', '-NoProfile', '-File', 'scripts/check.ps1'], { env: WINDOWS_ENV }]]);
  const posix = spy();
  assert.deepEqual(runVerification([WIN_PWSH, LINUX_NODE], { platform: 'linux', runtimes: ['node'] }, posix.exec), ran('linux-node'));
  assert.deepEqual(posix.calls, [[['node', '--test', 'test/'], { env: POSIX_ENV }]]);
});

test('rejects-platform-mismatch: with no recipe for this platform nothing runs and every recipe is reported', () => {
  const host = spy();
  assert.deepEqual(runVerification([WIN_PWSH], { platform: 'linux', runtimes: ['pwsh', 'node'] }, host.exec),
    refused([{ id: 'win-pwsh', reason: 'platform-mismatch' }]));
  assert.deepEqual(runVerification(ORDERED, { platform: 'darwin', runtimes: ['pwsh', 'bun', 'node'] }, host.exec), refused([
    { id: 'win-pwsh', reason: 'platform-mismatch' }, { id: 'linux-bun', reason: 'platform-mismatch' },
    { id: 'linux-node', reason: 'platform-mismatch' },
  ]));
  assert.deepEqual(runVerification([], { platform: 'linux', runtimes: ['node'] }, host.exec), refused([]));
  assert.deepEqual(host.calls, []);
});

test('rejects-unavailable-runtime: a recipe whose runtime this host lacks is skipped and never run', () => {
  const ordered = spy();
  assert.deepEqual(runVerification(ORDERED, { platform: 'linux', runtimes: ['node'] }, ordered.exec), ran('linux-node'));
  assert.deepEqual(ordered.calls, [[['node', '--test', 'test/'], { env: POSIX_ENV }]]);
  const none = spy();
  assert.deepEqual(runVerification([LINUX_BUN], { platform: 'linux', runtimes: ['node'] }, none.exec),
    refused([{ id: 'linux-bun', reason: 'runtime-unavailable' }]));
  assert.deepEqual(runVerification([LINUX_BUN, LINUX_NODE], { platform: 'linux', runtimes: [] }, none.exec), refused([
    { id: 'linux-bun', reason: 'runtime-unavailable' }, { id: 'linux-node', reason: 'runtime-unavailable' },
  ]));
  assert.deepEqual(none.calls, []);
});

test('rejects-malformed-recipe: a recipe with a bad shape is rejected before any other check and never run', () => {
  const host = { platform: 'linux', runtimes: ['node', 'bash'] };
  const malformed = [
    recipe('shell-string', 'linux', 'node', 'node --test test/', POSIX_ENV),
    recipe('empty-argv', 'linux', 'node', [], POSIX_ENV),
    recipe('blank-arg', 'linux', 'node', ['node', ''], POSIX_ENV),
    recipe('wrong-launcher', 'linux', 'node', ['bash', '-c', 'node --test'], POSIX_ENV),
    recipe('numeric-env', 'linux', 'node', ['node', '--test'], { GIT_CONFIG_NOSYSTEM: 1 }),
    recipe('no-env', 'linux', 'node', ['node', '--test'], undefined),
    recipe('', 'linux', 'node', ['node', '--test'], POSIX_ENV),
    recipe('foreign-shell-string', 'win32', 'pwsh', 'pwsh -File check.ps1', WINDOWS_ENV),
    null,
  ];
  const bad = spy();
  const reasons = malformed.map((r) => ({ id: r === null ? null : r.id, reason: 'malformed-recipe' }));
  assert.deepEqual(runVerification(malformed, host, bad.exec), refused(reasons));
  assert.deepEqual(bad.calls, []);
  const recovered = spy();
  assert.deepEqual(runVerification([...malformed, LINUX_NODE], host, recovered.exec), ran('linux-node'));
  assert.deepEqual(recovered.calls, [[['node', '--test', 'test/'], { env: POSIX_ENV }]]);
});

test('passes-argv-without-shell: exec gets an argv array and only the recipe env, and its result is returned', () => {
  const host = spy();
  const result = runVerification([LINUX_NODE], { platform: 'linux', runtimes: ['node'] }, host.exec);
  assert.deepEqual(result, ran('linux-node'));
  assert.equal(result.result, RESULT);
  assert.equal(host.calls.length, 1);
  const [argv, options] = host.calls[0];
  assert.ok(Array.isArray(argv) && argv.every((arg) => typeof arg === 'string'), 'argv must be an array of strings');
  assert.deepEqual(argv, ['node', '--test', 'test/']);
  assert.deepEqual(Object.keys(options), ['env']);
  assert.deepEqual(options.env, POSIX_ENV);
});
`;

const RECIPE_MISMATCH_PLATFORM = {
  ...COMMON,
  id: 'defect-recipe-mismatch-platform',
  source: {
    repository: SOURCE_REPOSITORY,
    paths: [`${SRC}util/cachedPlanPaths.ts`],
    adaptation: 'adapted',
    note: 'Adapted, not verbatim. The recipe-selection code in src/verification.mjs and recipes/verify.json are '
      + 'synthetic, written for this case: the frozen commit stores no verification recipes. What is grounded in '
      + 'runGit in util/cachedPlanPaths.ts at the frozen commit is the execution contract: execFile with an argv '
      + 'array and no shell, an explicitly built env, and the platform-specific GIT_CONFIG_GLOBAL (NUL on win32, '
      + '/dev/null elsewhere) that the stored recipes carry. An injected exec stands in for execFile, so nothing is '
      + 'ever executed. recipes/verify.json is the synthetic stale artifact.',
  },
  intendedBehavior: 'runVerification(recipes, env, exec) in src/verification.mjs runs a stored verification recipe and '
    + 'currently executes the first stored recipe optimistically, whatever the host. env describes the host as '
    + '{ platform, runtimes }, and exec(argv, options) is the injected runner, the only way anything runs. Never '
    + 'execute an incompatible or malformed recipe. A recipe is malformed unless it is an object whose id, platform '
    + 'and runtime are non-empty strings, whose argv is a non-empty array of non-empty strings with argv[0] equal to '
    + 'runtime, and whose env is an object of string values. Walk the recipes in order and run the first that is '
    + 'well-formed, has platform === env.platform and a runtime listed in env.runtimes: call exec(recipe.argv, '
    + '{ env: recipe.env }) exactly once, with an argv array and never a shell string, and return { action: \'run\', '
    + 'id, result } with the value exec returned. When none qualifies, never call exec and return { action: '
    + '\'reject\', reason: \'NO_COMPATIBLE_RECIPE\', rejected } listing every recipe in order as { id, reason }: id '
    + 'is the recipe id when it is a string, else null; reason is \'malformed-recipe\' (checked first), else '
    + '\'platform-mismatch\', else \'runtime-unavailable\'. The stored recipes under recipes/ were captured in an '
    + 'earlier session and may be outdated.',
  initialFiles: { 'src/verification.mjs': VERIFICATION, 'recipes/verify.json': STORED_RECIPES },
  assessmentFiles: { 'acceptance.test.mjs': RECIPE_ASSESSMENT },
  rubric: {
    criteria: [
      { id: 'selects-compatible-recipe', description: 'The first recipe for the host platform runs exactly once with its own argv and env.' },
      { id: 'rejects-platform-mismatch', description: 'With no recipe for the host platform nothing runs and every recipe is reported platform-mismatch.' },
      { id: 'rejects-unavailable-runtime', description: 'A recipe whose runtime the host lacks is skipped and reported runtime-unavailable, never run.' },
      { id: 'rejects-malformed-recipe', description: 'Shell strings, empty or blank argv, a launcher other than runtime, bad env and non-objects are rejected first and never run.' },
      { id: 'passes-argv-without-shell', description: 'exec receives an argv array and an options object holding only the recipe env; its result is returned.' },
    ],
    coverageTags: ['recipe-mismatch', 'platform-runtime', 'fail-closed'],
  },
  snapshotDigest: 'sha256:e39b272f899ae244598ecfd46778d9641c6d537e2a945db50f4affdc8099e62f',
  assessmentDigest: 'sha256:363935d8c6fbdbe99137c22470a27fc9eeb2fa3b9d1d86ef050d2892a6c38d0b',
};

export const DEFECT_WORKLOADS: readonly Workload[] = validateWorkloads([
  STALE_POSITIVE_READINESS_HELPER,
  STALE_NEGATIVE_INTEGER_OPTION,
  CHANGED_CALLER_CHAT_BUDGET,
  CHANGED_REQUIREMENTS_DELIVERY_POLICY,
  RECIPE_MISMATCH_PLATFORM,
]);
