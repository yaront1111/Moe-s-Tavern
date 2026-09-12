// =============================================================================
// Candidate store — the frozen record of the exact bytes a task is offering
// =============================================================================
//
// A Candidate names one fixed set of bytes — a runner-reported treeSha on a
// runner-reported baseRevision, aimed at one deliveryTarget — so review and
// checks can bind to something immutable instead of to a moving working tree.
//
// IMMUTABLE BY CONSTRUCTION. This module has NO update, patch or delete
// function, and that absence is the rule, not an oversight: a later caller
// cannot misuse a function that does not exist. A changed tree is recorded as a
// NEW candidate under a new id. recordCandidate refuses a same-id record that
// differs in any field (CANDIDATE_IMMUTABLE). Its one exception is a
// byte-identical re-record, which returns the stored candidate and writes
// nothing, so a runner retrying after a crash makes progress instead of failing;
// nothing changes, so it is not a mutation. Readers hand out copies, so no
// caller can edit a stored candidate in memory either.
//
// The daemon never runs git. baseRevision and treeSha are recorded exactly as
// the runner reported them and validated for shape only — never observed, never
// verified.
//
// Follows the resourceStore / attemptStore pattern: stateless functions taking
// the state handle first; every mutation assumes THE CALLER HOLDS state.mutex
// (tool dispatch provides it for non-blocking tools). The immutability check
// reads the map and then writes, so it holds only under that mutex.
//
// Write path: writeEntity → map.set. Persist BEFORE the record becomes visible,
// so a failed write leaves no candidate anywhere. Like attemptStore, no activity
// row and no emit: there is no consumer yet, and both would need edits to the
// ACTIVITY_EVENT_TYPES / StateChangeEvent unions.

import type { StateManager } from './StateManager.js';
import type { Candidate } from '../types/schema.js';
import { MoeError, MoeErrorCode, invalidInput, missingRequired } from '../util/errors.js';
import { generateId } from '../util/ids.js';
import { validateEntityId } from '../util/sanitize.js';
import { getAttempt } from './attemptStore.js';

/** The sha shape tools/recordCommit.ts already accepts (7-40 hex) — deliberately the same one. */
const SHA_RE = /^[0-9a-f]{7,40}$/i;
/** The bound tools/recordCommit.ts puts on a ref. */
const MAX_TARGET_CHARS = 255;

/** Every caller-supplied field besides the id, which the lookup itself matches. */
const RECORDED_FIELDS = ['attemptId', 'taskId', 'baseRevision', 'treeSha', 'deliveryTarget'] as const;

export interface RecordCandidateParams {
  /**
   * Optional. Supply the id a crashed record used so the retry is idempotent;
   * omit it for a fresh generated id.
   */
  id?: string;
  attemptId: string;
  taskId: string;
  baseRevision: string;
  treeSha: string;
  deliveryTarget: string;
}

export interface RecordCandidateResult {
  candidate: Candidate;
  /** True when an identical candidate already existed: it was returned and nothing was written. */
  duplicate: boolean;
}

type RawCandidateParams = { [K in keyof RecordCandidateParams]?: unknown };

/** Bounded rendering of an untrusted value: it cannot throw and cannot flood a message. */
function renderGot(value: unknown): string {
  if (value === null) return 'null';
  const kind = typeof value;
  if (kind === 'object' || kind === 'function' || kind === 'symbol') return `a value of type ${kind}`;
  const text = kind === 'string' ? JSON.stringify(value) : String(value);
  return text.length > 40 ? `${text.slice(0, 40)}…` : text;
}

/** Absent (undefined or null) is MISSING_REQUIRED; present but not a string is INVALID_INPUT. */
function requireString(field: string, value: unknown): string {
  if (value === undefined || value === null) throw missingRequired(field);
  if (typeof value !== 'string') throw invalidInput(field, `must be a string (got ${renderGot(value)})`);
  return value;
}

/** A reference to a stored entity: non-blank and a valid entity id, which also bounds its length. */
function requireEntityRef(field: string, value: unknown): string {
  const text = requireString(field, value);
  if (text.trim() === '') throw invalidInput(field, `must be a non-blank string (got ${renderGot(text)})`);
  return validateEntityId(text, field);
}

function requireSha(field: string, value: unknown): string {
  const text = requireString(field, value);
  if (!SHA_RE.test(text)) {
    throw invalidInput(field, `must be 7-40 hexadecimal characters, as reported by the runner (got ${renderGot(text)})`);
  }
  return text;
}

/** True when the text holds a C0 control character (0x00-0x1f) or DEL (0x7f). */
function hasControlChar(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function requireDeliveryTarget(value: unknown): string {
  const field = 'deliveryTarget';
  const text = requireString(field, value);
  if (text.trim() === '') throw invalidInput(field, 'must be a non-blank string');
  if (text !== text.trim()) throw invalidInput(field, 'must not have leading or trailing whitespace');
  if (hasControlChar(text)) throw invalidInput(field, 'must not contain control characters');
  if (text.length > MAX_TARGET_CHARS) throw invalidInput(field, `must be ${MAX_TARGET_CHARS} characters or fewer`);
  return text;
}

function readOptionalId(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim() === '') {
    throw invalidInput('id', `must be a non-blank string when supplied (got ${renderGot(value)})`);
  }
  return validateEntityId(value, 'id');
}

/**
 * Validate a candidate's caller-supplied fields, refusing rather than coercing.
 * Exported so the record_candidate tool refuses malformed input BEFORE its
 * fencing check and write — one set of rules, not a second copy in the handler.
 */
export function validateCandidateParams(raw: unknown): RecordCandidateParams {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw invalidInput('candidate', `must be an object (got ${renderGot(raw)})`);
  }
  const fields = raw as RawCandidateParams;
  const id = readOptionalId(fields.id);
  return {
    ...(id !== undefined ? { id } : {}),
    attemptId: requireEntityRef('attemptId', fields.attemptId),
    taskId: requireEntityRef('taskId', fields.taskId),
    baseRevision: requireSha('baseRevision', fields.baseRevision),
    treeSha: requireSha('treeSha', fields.treeSha),
    deliveryTarget: requireDeliveryTarget(fields.deliveryTarget),
  };
}

const copy = (candidate: Candidate): Candidate => ({ ...candidate });

/** createdAt, then id: a tie on the clock can never reorder the output. */
function byCreatedAtThenId(a: Candidate, b: Candidate): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  return 0;
}

function listWhere(state: StateManager, keep: (candidate: Candidate) => boolean): Candidate[] {
  return Array.from(state.candidates.values()).filter(keep).sort(byCreatedAtThenId).map(copy);
}

export function getCandidate(state: StateManager, candidateId: string): Candidate | null {
  const stored = state.candidates.get(candidateId);
  return stored ? copy(stored) : null;
}

export function listCandidatesForTask(state: StateManager, taskId: string): Candidate[] {
  return listWhere(state, (candidate) => candidate.taskId === taskId);
}

export function listCandidatesForAttempt(state: StateManager, attemptId: string): Candidate[] {
  return listWhere(state, (candidate) => candidate.attemptId === attemptId);
}

/**
 * The only thing a same-id record may do is repeat itself. Identical in every
 * caller-supplied field: the stored candidate comes back unchanged (the crash
 * retry). Any difference is refused and named, because a changed tree is a
 * different candidate and needs its own id.
 */
function replayOrRefuse(stored: Candidate, incoming: RecordCandidateParams): Candidate {
  const differingFields = RECORDED_FIELDS.filter((field) => stored[field] !== incoming[field]);
  if (differingFields.length === 0) return copy(stored);
  throw new MoeError(
    MoeErrorCode.STATE_CONFLICT,
    `Candidate ${stored.id} already exists and differs in ${differingFields.join(', ')}; ` +
      'candidates are immutable, so a changed tree needs a new candidate id',
    { candidateId: stored.id, differingFields },
    'CANDIDATE_IMMUTABLE'
  );
}

/**
 * A candidate is keyed to an attempt, so the attempt must exist and belong to
 * the task. This is referential integrity only. Whether the attempt is still
 * CURRENT is decided by the fencing guard (util/enforcement.ts
 * assertAttemptCurrent), which the tool runs before reaching this store;
 * repeating that check here would be a second fencing implementation.
 */
function assertAttemptOfTask(state: StateManager, attemptId: string, taskId: string): void {
  const attempt = getAttempt(state, attemptId);
  if (!attempt) {
    throw new MoeError(MoeErrorCode.NOT_FOUND, `Attempt not found: ${attemptId}`, { attemptId }, 'ATTEMPT_NOT_FOUND');
  }
  if (attempt.taskId !== taskId) {
    throw new MoeError(
      MoeErrorCode.STATE_CONFLICT,
      `Attempt ${attemptId} belongs to task ${attempt.taskId}, not ${taskId}`,
      { attemptId, existingTaskId: attempt.taskId, requestedTaskId: taskId },
      'ATTEMPT_ID_TASK_MISMATCH'
    );
  }
}

/**
 * Record a candidate. In order: validate without coercing; replay or refuse a
 * same-id record; require the attempt to exist and belong to the task; then
 * persist BEFORE publishing. createdAt is the daemon's clock, never the caller's.
 */
export async function recordCandidate(
  state: StateManager,
  params: RecordCandidateParams
): Promise<RecordCandidateResult> {
  const input = validateCandidateParams(params);
  const id = input.id ?? generateId('cand');
  const stored = state.candidates.get(id);
  if (stored) return { candidate: replayOrRefuse(stored, input), duplicate: true };
  assertAttemptOfTask(state, input.attemptId, input.taskId);

  const candidate: Candidate = {
    id,
    attemptId: input.attemptId,
    taskId: input.taskId,
    baseRevision: input.baseRevision,
    treeSha: input.treeSha,
    deliveryTarget: input.deliveryTarget,
    createdAt: new Date().toISOString(),
  };
  // writeEntity validates the id against path traversal, creates
  // .moe/candidates itself and writes atomically (temp file + rename).
  await state.writeEntity('candidates', candidate.id, candidate);
  state.candidates.set(candidate.id, candidate);
  return { candidate: copy(candidate), duplicate: false };
}
