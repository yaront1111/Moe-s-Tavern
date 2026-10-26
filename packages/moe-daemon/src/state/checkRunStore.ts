// =============================================================================
// CheckRun store — what a check reported about one candidate's exact bytes
// =============================================================================
//
// A CheckRun is a command result someone REPORTED against one Candidate: the
// command, its exit code, the end of its output, the runner it names and where
// the report says it came from. Binding the result to the candidate's tree lets
// a later gate ask about exactly those bytes instead of about a task.
//
// RECORDING ONLY. This module never executes the command, never authenticates
// the reporter and never fabricates a candidate. `source` is DECLARED
// provenance: `runner-observed` is what the caller says, not something the
// daemon saw. Recording checks shape, that the candidate exists, that the
// reported tree is the candidate's and that a named attempt is one of the
// candidate's task; whether a stored run satisfies any gate is decided later,
// by policy. The optional execution identities (outcome, planRevision,
// environment, dispatchId, attemptId) are REPORTED too; an absent one leaves no
// key, so a report without them stores exactly the pre-identity shape.
//
// IMMUTABLE BY CONSTRUCTION. This module has NO update and NO delete function,
// and that absence is the rule, not an oversight: a later caller cannot misuse
// a function that does not exist. A candidate accumulates runs, and running a
// check again is a new record under a new id. recordCheckRun refuses a same-id
// report that differs after normalization (CHECK_RUN_IMMUTABLE). Its one
// exception is an identical report, which returns the stored run, createdAt
// included, and writes nothing, so a runner retrying after a crash makes
// progress instead of failing. Readers hand out copies.
//
// Follows the candidateStore pattern: stateless functions taking the state
// handle first, and every mutation assumes THE CALLER HOLDS state.mutex (tool
// dispatch provides it), since the same-id check reads the map, then writes.
// writeEntity runs BEFORE map.set, so a failed write leaves no check run
// anywhere. No activity row and no emit: there is no consumer yet.

import type { StateManager } from './StateManager.js';
import type { Candidate, CheckOutcome, CheckRun, CheckRunSource } from '../types/schema.js';
import { MoeError, MoeErrorCode, invalidInput, missingRequired } from '../util/errors.js';
import { generateId } from '../util/ids.js';
import { validateEntityId } from '../util/sanitize.js';
import { assertAttemptOfTask, caseVariantId, getCandidate, hasControlChar, renderGot, SHA_RE } from './candidateStore.js';

/** The most output a check run keeps: the END of the log, counted in UTF-8 BYTES, not characters. */
export const MAX_CHECK_LOG_BYTES = 16384;

/** The bound complete_task already puts on a verification command. */
const MAX_COMMAND_CHARS = 500;
/** The only two sources a report may declare. A third value is refused, never coerced or defaulted. */
const SOURCES: readonly CheckRunSource[] = ['runner-observed', 'agent-reported'];

/** Every outcome a report may declare. A value outside it is refused, never coerced. */
export const CHECK_OUTCOMES: readonly CheckOutcome[] = ['passed', 'code-failure', 'infra-failure', 'timeout', 'skipped', 'inconclusive'];
const MAX_ENVIRONMENT_CHARS = 255;

/** The optional execution identities. Absent ones are never defaulted or inferred. */
const IDENTITY_FIELDS = ['outcome', 'planRevision', 'environment', 'dispatchId', 'attemptId'] as const;

/** Every recorded field besides the id, which the lookup itself matches, and createdAt, which is the daemon's. */
const RECORDED_FIELDS = [
  'candidateId', 'treeSha', 'command', 'exitCode', 'outputTail', 'runnerId', 'source', ...IDENTITY_FIELDS,
] as const;

/** Each identity is optional: only `undefined` means absent, and a null is refused. */
type CheckRunIdentities = Pick<CheckRun, (typeof IDENTITY_FIELDS)[number]>;

export interface RecordCheckRunParams extends CheckRunIdentities {
  /** Optional. Reuse a crashed report's id so its retry is idempotent; omit it for a generated id. */
  id?: string;
  candidateId: string;
  treeSha: string;
  command: string;
  exitCode: number;
  /** Optional; absent is recorded as ''. Stored as its final MAX_CHECK_LOG_BYTES UTF-8 bytes. */
  outputTail?: string;
  runnerId: string;
  source: CheckRunSource;
}

/** A report that passed validation: outputTail is present, UTF-8 normalized and bounded. */
export interface ValidCheckRunParams extends RecordCheckRunParams {
  outputTail: string;
}

export interface RecordCheckRunResult {
  checkRun: CheckRun;
  /** True when an identical report already existed: it was returned and nothing was written. */
  duplicate: boolean;
}

type RawCheckRunParams = { [K in keyof RecordCheckRunParams]?: unknown };

/** Absent (undefined or null) is MISSING_REQUIRED; present but not a string is INVALID_INPUT. */
function requireString(field: string, value: unknown): string {
  if (value === undefined || value === null) throw missingRequired(field);
  if (typeof value !== 'string') throw invalidInput(field, `must be a string (got ${renderGot(value)})`);
  return value;
}

/** A reference to an entity: non-blank and a valid entity id, which also bounds its length. */
function requireEntityRef(field: string, value: unknown): string {
  const text = requireString(field, value);
  if (text.trim() === '') throw invalidInput(field, `must be a non-blank string (got ${renderGot(text)})`);
  return validateEntityId(text, field);
}

function readOptionalId(field: string, value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim() === '') {
    throw invalidInput(field, `must be a non-blank string when supplied (got ${renderGot(value)})`);
  }
  return validateEntityId(value, field);
}

function requireTreeSha(value: unknown): string {
  const text = requireString('treeSha', value);
  if (!SHA_RE.test(text)) {
    throw invalidInput('treeSha', `must be 7-40 hexadecimal characters, as reported by the runner (got ${renderGot(text)})`);
  }
  return text;
}

/** Kept verbatim: never trimmed, so the record says exactly what was reported. */
function requireCommand(value: unknown): string {
  const text = requireString('command', value);
  if (text.trim() === '') throw invalidInput('command', 'must be a non-blank string');
  if (text.length > MAX_COMMAND_CHARS) {
    throw invalidInput('command', `must be ${MAX_COMMAND_CHARS} characters or fewer (got ${text.length})`);
  }
  return text;
}

/** Any signed safe integer. Unlike complete_task, a failing (nonzero, even negative) code is recorded. */
function requireExitCode(value: unknown): number {
  if (value === undefined || value === null) throw missingRequired('exitCode');
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw invalidInput('exitCode', `must be a safe integer (got ${renderGot(value)})`);
  }
  // -0 is the integer 0 and JSON writes it as 0, so memory must hold 0 too or a reload would differ.
  return value === 0 ? 0 : value;
}

function requireSource(value: unknown): CheckRunSource {
  const text = requireString('source', value);
  if (!SOURCES.includes(text as CheckRunSource)) {
    throw invalidInput('source', `must be one of ${SOURCES.join(', ')} (got ${renderGot(text)})`);
  }
  return text as CheckRunSource;
}

/** Coherent with the exit code: `passed` needs 0 and `code-failure` a nonzero code; the rest take it as reported. */
function readOutcome(value: unknown, exitCode: number): CheckOutcome | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !CHECK_OUTCOMES.includes(value as CheckOutcome)) {
    throw invalidInput('outcome', `must be one of ${CHECK_OUTCOMES.join(', ')} when supplied (got ${renderGot(value)})`);
  }
  if (value === 'passed' && exitCode !== 0) throw invalidInput('outcome', `passed requires exitCode 0 (got ${exitCode})`);
  if (value === 'code-failure' && exitCode === 0) throw invalidInput('outcome', 'code-failure requires a nonzero exitCode (got 0)');
  return value as CheckOutcome;
}

function readPlanRevision(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw invalidInput('planRevision', `must be a safe integer of at least 1 when supplied (got ${renderGot(value)})`);
  }
  return value;
}

/** Opaque and kept verbatim: never trimmed or parsed, so it compares exactly. */
function readEnvironment(value: unknown): string | undefined {
  const field = 'environment';
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim() === '') {
    throw invalidInput(field, `must be a non-blank string when supplied (got ${renderGot(value)})`);
  }
  if (value.length > MAX_ENVIRONMENT_CHARS) {
    throw invalidInput(field, `must be ${MAX_ENVIRONMENT_CHARS} characters or fewer (got ${value.length})`);
  }
  if (hasControlChar(value)) throw invalidInput(field, 'must not contain control characters');
  return value;
}

/** The identities a report supplied, and ONLY those: an absent one leaves no key at all. */
function readIdentities(fields: RawCheckRunParams, exitCode: number): CheckRunIdentities {
  const outcome = readOutcome(fields.outcome, exitCode);
  const planRevision = readPlanRevision(fields.planRevision);
  const environment = readEnvironment(fields.environment);
  const dispatchId = readOptionalId('dispatchId', fields.dispatchId);
  const attemptId = readOptionalId('attemptId', fields.attemptId);
  return {
    ...(outcome !== undefined ? { outcome } : {}),
    ...(planRevision !== undefined ? { planRevision } : {}),
    ...(environment !== undefined ? { environment } : {}),
    ...(dispatchId !== undefined ? { dispatchId } : {}),
    ...(attemptId !== undefined ? { attemptId } : {}),
  };
}

/**
 * The END of a log, bounded in UTF-8 BYTES — counting characters would overshoot
 * for any multibyte log. Encoding first normalizes malformed input
 * deterministically (a lone surrogate becomes U+FFFD; it was already broken).
 * The cut keeps the final MAX_CHECK_LOG_BYTES bytes, then moves its start past
 * continuation bytes (0b10xxxxxx), so the kept text never begins inside a
 * character and the cut itself never introduces a U+FFFD.
 */
function boundOutputTail(value: unknown): string {
  if (value === undefined) return '';
  if (typeof value !== 'string') {
    throw invalidInput('outputTail', `must be a string when supplied (got ${renderGot(value)})`);
  }
  const bytes = Buffer.from(value, 'utf8');
  let start = Math.max(0, bytes.length - MAX_CHECK_LOG_BYTES);
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start += 1;
  return bytes.subarray(start).toString('utf8');
}

/**
 * Validate a check-run report, refusing rather than coercing, and normalize its
 * output tail. Exported so the record_check_run tool refuses malformed input
 * with the rules this store applies — one set of rules, not a second copy.
 */
export function validateCheckRunParams(raw: unknown): ValidCheckRunParams {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw invalidInput('checkRun', `must be an object (got ${renderGot(raw)})`);
  }
  const fields = raw as RawCheckRunParams;
  const id = readOptionalId('id', fields.id);
  const report: ValidCheckRunParams = {
    ...(id !== undefined ? { id } : {}),
    candidateId: requireEntityRef('candidateId', fields.candidateId),
    treeSha: requireTreeSha(fields.treeSha),
    command: requireCommand(fields.command),
    exitCode: requireExitCode(fields.exitCode),
    outputTail: boundOutputTail(fields.outputTail),
    runnerId: requireEntityRef('runnerId', fields.runnerId),
    source: requireSource(fields.source),
  };
  return { ...report, ...readIdentities(fields, report.exitCode) };
}

const copy = (checkRun: CheckRun): CheckRun => ({ ...checkRun });

/** A stored row's timestamp, or undefined when it has none (or none that is a string). */
function timestampOf(checkRun: CheckRun): string | undefined {
  return typeof checkRun.createdAt === 'string' ? checkRun.createdAt : undefined;
}

/**
 * Rows without a createdAt first (written before the field existed), then
 * createdAt, then id: the order never depends on disk or insertion order.
 */
function byCreatedAtThenId(a: CheckRun, b: CheckRun): number {
  const aTime = timestampOf(a);
  const bTime = timestampOf(b);
  if (aTime !== bTime) {
    if (aTime === undefined) return -1;
    if (bTime === undefined) return 1;
    return aTime < bTime ? -1 : 1;
  }
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  return 0;
}

export function getCheckRun(state: StateManager, checkRunId: string): CheckRun | null {
  const stored = state.checkRuns.get(checkRunId);
  return stored ? copy(stored) : null;
}

/** Every run recorded for one candidate, in deterministic order. Copies, so a caller cannot edit stored state. */
export function listCheckRunsForCandidate(state: StateManager, candidateId: string): CheckRun[] {
  return Array.from(state.checkRuns.values())
    .filter((checkRun) => checkRun.candidateId === candidateId)
    .sort(byCreatedAtThenId)
    .map(copy);
}

/**
 * A run binds to a candidate's bytes, so the candidate must exist and the
 * reported tree must be exactly its tree: the same token, with no prefix match,
 * truncation or case folding. Text is all the daemon can compare — it never
 * runs git, so it cannot tell that two spellings name one tree.
 */
function assertTreeOfCandidate(state: StateManager, input: ValidCheckRunParams): Candidate {
  const candidate = getCandidate(state, input.candidateId);
  if (!candidate) {
    const { candidateId } = input;
    throw new MoeError(MoeErrorCode.NOT_FOUND, `Candidate not found: ${candidateId}`, { candidateId }, 'CANDIDATE_NOT_FOUND');
  }
  if (candidate.treeSha !== input.treeSha) {
    throw new MoeError(
      MoeErrorCode.STATE_CONFLICT,
      `Check run reports tree ${input.treeSha}, but candidate ${candidate.id} is tree ${candidate.treeSha}; ` +
        'a check run must name the exact tree of the candidate it checked',
      { candidateId: candidate.id, expectedTreeSha: candidate.treeSha, actualTreeSha: input.treeSha },
      'CHECK_RUN_TREE_MISMATCH'
    );
  }
  return candidate;
}

/**
 * The only thing a same-id report may do is repeat itself. Identical in every
 * recorded field after normalization: the stored run comes back unchanged (the
 * crash retry). Any difference is refused and named, because a different
 * result is a different run and needs its own id.
 */
function replayOrRefuse(stored: CheckRun, incoming: ValidCheckRunParams): CheckRun {
  const differingFields = RECORDED_FIELDS.filter((field) => stored[field] !== incoming[field]);
  if (differingFields.length === 0) return copy(stored);
  throw new MoeError(
    MoeErrorCode.STATE_CONFLICT,
    `Check run ${stored.id} already exists and differs in ${differingFields.join(', ')}; ` +
      'check runs are immutable, so a different result needs a new check-run id',
    { checkRunId: stored.id, differingFields },
    'CHECK_RUN_IMMUTABLE'
  );
}

/**
 * Record a check run. In this order, and every refusal writes nothing: validate
 * and normalize without coercing; require the candidate (CANDIDATE_NOT_FOUND);
 * require its exact tree (CHECK_RUN_TREE_MISMATCH); replay or refuse a same-id
 * report (CHECK_RUN_IMMUTABLE); refuse an id that differs from a stored one only
 * by case (CHECK_RUN_ID_CASE_COLLISION); require a named attemptId to be an
 * attempt of the candidate's task (ATTEMPT_NOT_FOUND / ATTEMPT_ID_TASK_MISMATCH:
 * referential integrity only, so a reviewer's attempt or a closed producer
 * attempt is valid); then persist BEFORE publishing. The attempt check follows
 * the replay, so an identical crash retry still gets its stored run. createdAt
 * is the daemon's clock, never the caller's. A failed write propagates to the caller.
 */
export async function recordCheckRun(
  state: StateManager,
  params: RecordCheckRunParams
): Promise<RecordCheckRunResult> {
  const input = validateCheckRunParams(params);
  const candidate = assertTreeOfCandidate(state, input);
  const id = input.id ?? generateId('check');
  const stored = state.checkRuns.get(id);
  if (stored) return { checkRun: replayOrRefuse(stored, input), duplicate: true };
  const existing = caseVariantId(state.checkRuns.keys(), id);
  if (existing) {
    throw new MoeError(
      MoeErrorCode.STATE_CONFLICT,
      `Check run id ${id} differs only by case from the existing check run ${existing}; each record is one file ` +
        '(<id>.json), and NTFS and a default APFS volume treat those two names as the same file, so recording this ' +
        'one would overwrite the other. Supply a distinct id - a stored id keeps the case it was given, and ' +
        'references match it exactly.',
      { checkRunId: existing, requestedId: id },
      'CHECK_RUN_ID_CASE_COLLISION'
    );
  }

  if (input.attemptId !== undefined) assertAttemptOfTask(state, input.attemptId, candidate.taskId);

  // input is the validated report: the recorded fields only, an absent identity leaving no key.
  const { id: _requestedId, ...recorded } = input;
  const checkRun: CheckRun = { id, ...recorded, createdAt: new Date().toISOString() };
  // writeEntity validates the id against path traversal, creates .moe/checks
  // itself and writes atomically (temp file + rename).
  await state.writeEntity('checks', checkRun.id, checkRun);
  state.checkRuns.set(checkRun.id, checkRun);
  return { checkRun: copy(checkRun), duplicate: false };
}
