// CQ-M04 baseline outcome record contract and report builder.
//
// One strict record per frozen workload run (n=1): workload identity, the run
// (Moe commit, timestamps, wall-clock cap, status, per-role cli/model/effort),
// the Moe outcome, the held-out assessment, latency, retrieval and notes. Every
// key is required and no other key is allowed at any level, so prompts, tool
// arguments, secrets and prices cannot ride along. null means unknown and is
// never coerced to 0.
//
// Acceptance comes ONLY from the held-out assessment. The Moe task status, QA
// approvals, rejections and reopen counts are record-only, and token totals
// never change acceptance.

export const BASELINE_RECORD_VERSION = 1;
export const BASELINE_STATUSES = Object.freeze(['completed', 'capped', 'failed', 'aborted']);
export const BASELINE_ROLES = Object.freeze(['architect', 'worker', 'qa']);
export const ASSESSMENT_RESULTS = Object.freeze(['pass', 'fail', 'not-run']);

const CATEGORIES = ['maintenance', 'defect', 'refactor', 'non-routine'];
const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const CONTROL = /[\x00-\x1f\x7f]/;

// Messages name the field path and the rule, never the offending value; an
// unexpected key name is sanitized and cut to 40 characters.
const fail = (at, reason) => { throw new Error(`${at}: ${reason}`.slice(0, 200)); };
const child = (at, key) => {
  const name = String(key).replace(/[^A-Za-z0-9_-]/g, '?').slice(0, 40);
  return at ? `${at}.${name}` : name;
};

function plain(value, at, keys) {
  const proto = value !== null && typeof value === 'object' ? Object.getPrototypeOf(value) : undefined;
  if (Array.isArray(value) || (proto !== Object.prototype && proto !== null)) fail(at || 'record', 'must be a plain object');
  for (const key of Object.keys(value)) if (!keys.includes(key)) fail(child(at, key), 'is not an allowed key');
  for (const key of keys) if (!Object.hasOwn(value, key)) fail(child(at, key), 'is required');
  return value;
}

function text(value, at, max, nullable = false) {
  if (value === null && nullable) return null;
  if (typeof value !== 'string' || !value.trim() || value.length > max || CONTROL.test(value)) {
    fail(at, `must be a non-blank single-line string of at most ${max} characters${nullable ? ' or null' : ''}`);
  }
  return value;
}

function int(value, at, min, nullable = false) {
  if (value === null && nullable) return null;
  if (!Number.isSafeInteger(value) || value < min) fail(at, `must be a safe integer >= ${min}${nullable ? ' or null' : ''}`);
  return value;
}

const counter = (value, at) => int(value, at, 0, true);

function oneOf(value, at, allowed) {
  if (!allowed.includes(value)) fail(at, `must be one of ${allowed.join(', ')}`);
  return value;
}

function pattern(value, at, regex, rule, max = Infinity) {
  if (typeof value !== 'string' || value.length > max || !regex.test(value)) fail(at, rule);
  return value;
}

function list(value, at, min, max) {
  if (!Array.isArray(value) || value.length < min || value.length > max) fail(at, `must be an array of ${min}-${max} entries`);
  return value;
}

function timestamp(value, at) {
  if (typeof value !== 'string' || value.length > 32 || Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) {
    fail(at, 'must be an ISO-8601 UTC timestamp in Date#toISOString form');
  }
  return value;
}

function unique(entries, key, at) {
  const seen = new Set();
  entries.forEach((entry, index) => {
    if (seen.has(entry[key])) fail(`${at}[${index}].${key}`, 'is a duplicate');
    seen.add(entry[key]);
  });
}

function workloadId(value, at, category) {
  const rule = `must be kebab-case, at most 80 characters, prefixed "${category}-"`;
  pattern(value, at, KEBAB, rule, 80);
  if (!value.startsWith(`${category}-`)) fail(at, rule);
  return value;
}

function readWorkload(raw, at) {
  const value = plain(raw, at, ['id', 'category', 'caseDigest', 'snapshotDigest', 'corpusVersion']);
  const category = oneOf(value.category, `${at}.category`, CATEGORIES);
  return { id: workloadId(value.id, `${at}.id`, category), category,
    caseDigest: pattern(value.caseDigest, `${at}.caseDigest`, DIGEST, 'must be "sha256:" followed by 64 lowercase hex characters'),
    snapshotDigest: pattern(value.snapshotDigest, `${at}.snapshotDigest`, DIGEST, 'must be "sha256:" followed by 64 lowercase hex characters'),
    corpusVersion: int(value.corpusVersion, `${at}.corpusVersion`, 1) };
}

function readRole(raw, at) {
  const value = plain(raw, at, ['role', 'cli', 'model', 'effort', 'launches']);
  return { role: oneOf(value.role, `${at}.role`, BASELINE_ROLES), cli: text(value.cli, `${at}.cli`, 64),
    model: text(value.model, `${at}.model`, 128, true), effort: text(value.effort, `${at}.effort`, 32, true),
    launches: counter(value.launches, `${at}.launches`) };
}

function readRun(raw, at) {
  const value = plain(raw, at, ['moeCommit', 'startedAt', 'endedAt', 'wallClockMs', 'wallClockCapMs', 'status', 'repetition',
    'repetitionsPlanned', 'platform', 'nodeVersion', 'cliVersion', 'roles', 'usageTaskId', 'failureReason']);
  const run = {
    moeCommit: pattern(value.moeCommit, `${at}.moeCommit`, /^[0-9a-f]{40}$/, 'must be 40 lowercase hex characters'),
    startedAt: timestamp(value.startedAt, `${at}.startedAt`), endedAt: timestamp(value.endedAt, `${at}.endedAt`),
    wallClockMs: int(value.wallClockMs, `${at}.wallClockMs`, 0), wallClockCapMs: int(value.wallClockCapMs, `${at}.wallClockCapMs`, 1),
    status: oneOf(value.status, `${at}.status`, BASELINE_STATUSES),
    repetition: int(value.repetition, `${at}.repetition`, 1), repetitionsPlanned: int(value.repetitionsPlanned, `${at}.repetitionsPlanned`, 1),
    platform: text(value.platform, `${at}.platform`, 64), nodeVersion: text(value.nodeVersion, `${at}.nodeVersion`, 64),
    cliVersion: text(value.cliVersion, `${at}.cliVersion`, 128, true),
    roles: list(value.roles, `${at}.roles`, 1, 3).map((role, index) => readRole(role, `${at}.roles[${index}]`)),
    usageTaskId: value.usageTaskId === null ? null
      : pattern(value.usageTaskId, `${at}.usageTaskId`, /^[A-Za-z0-9._-]{1,128}$/, 'must match [A-Za-z0-9._-]{1,128} or be null'),
    failureReason: text(value.failureReason, `${at}.failureReason`, 500, true),
  };
  if (Date.parse(run.endedAt) < Date.parse(run.startedAt)) fail(`${at}.endedAt`, 'must not be before startedAt');
  if (run.repetition > run.repetitionsPlanned) fail(`${at}.repetition`, 'must not exceed repetitionsPlanned');
  if (run.status === 'capped' && run.wallClockMs < run.wallClockCapMs) fail(`${at}.wallClockMs`, 'must reach wallClockCapMs when status is capped');
  if (run.status === 'completed' && run.wallClockMs > run.wallClockCapMs) fail(`${at}.wallClockMs`, 'must not exceed wallClockCapMs when status is completed');
  unique(run.roles, 'role', `${at}.roles`);
  return run;
}

function readAssessment(raw, at) {
  const value = plain(raw, at, ['ran', 'exitCode', 'criteria', 'reason']);
  if (typeof value.ran !== 'boolean') fail(`${at}.ran`, 'must be a boolean');
  if (value.exitCode !== null && !Number.isSafeInteger(value.exitCode)) fail(`${at}.exitCode`, 'must be a safe integer or null');
  const criteria = list(value.criteria, `${at}.criteria`, 0, 32).map((entry, index) => {
    const where = `${at}.criteria[${index}]`;
    const criterion = plain(entry, where, ['id', 'result']);
    return { id: pattern(criterion.id, `${where}.id`, KEBAB, 'must be kebab-case, at most 64 characters', 64),
      result: oneOf(criterion.result, `${where}.result`, ASSESSMENT_RESULTS) };
  });
  unique(criteria, 'id', `${at}.criteria`);
  const assessment = { ran: value.ran, exitCode: value.exitCode, criteria, reason: text(value.reason, `${at}.reason`, 500, true) };
  if (!assessment.ran) {
    if (assessment.exitCode !== null) fail(`${at}.exitCode`, 'must be null when the assessment did not run');
    criteria.forEach((entry, index) => { if (entry.result !== 'not-run') fail(`${at}.criteria[${index}].result`, 'must be not-run when the assessment did not run'); });
    if (assessment.reason === null) fail(`${at}.reason`, 'must explain why the assessment did not run');
  }
  return assessment;
}

const counters = (value, at, keys) => Object.fromEntries(keys.map(key => [key, counter(value[key], `${at}.${key}`)]));
const counterGroup = (raw, at, keys) => counters(plain(raw, at, keys), at, keys);

const freeze = value => {
  if (value !== null && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
};

// Validates one record and returns a detached, deep-frozen copy.
export function readBaselineRecord(raw) {
  const value = plain(raw, '', ['version', 'workload', 'run', 'moeOutcome', 'assessment', 'latency', 'retrieval', 'notes']);
  if (value.version !== BASELINE_RECORD_VERSION) fail('version', `must be ${BASELINE_RECORD_VERSION}`);
  const workload = readWorkload(value.workload, 'workload');
  const run = readRun(value.run, 'run');
  const outcome = plain(value.moeOutcome, 'moeOutcome', ['finalStatus', 'qaApprovals', 'qaRejections', 'reopenCount', 'plannerSessions', 'repairAttempts']);
  const moeOutcome = { finalStatus: text(outcome.finalStatus, 'moeOutcome.finalStatus', 32, true),
    ...counters(outcome, 'moeOutcome', ['qaApprovals', 'qaRejections', 'reopenCount', 'plannerSessions', 'repairAttempts']) };
  return freeze({ version: BASELINE_RECORD_VERSION, workload, run, moeOutcome,
    assessment: readAssessment(value.assessment, 'assessment'),
    latency: counterGroup(value.latency, 'latency', ['firstCodeChangeMs', 'endToEndMs']),
    retrieval: counterGroup(value.retrieval, 'retrieval', ['sourceRetrievals', 'retrievedBytes']),
    notes: list(value.notes, 'notes', 0, 10).map((note, index) => text(note, `notes[${index}]`, 300)) });
}
