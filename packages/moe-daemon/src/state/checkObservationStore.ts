// Check observation store: which check a trusted runner was asked to run (a CheckDispatch, pinned while current)
// and the ONE CheckRun it observed for it (a CheckObservation marker). Trust follows the dispatch binding and the
// channel identity, never caller arguments. RECORDING ONLY and immutable by construction: no update or delete
// function, and an identical same-id replay returns the stored record. The caller holds state.mutex. Every
// refusal precedes the first write, and writeEntity runs before map.set.

import path from 'path';
import type { StateManager } from './StateManager.js';
import type { RunnerIdentity } from '../server/runnerChannel.js';
import type { CheckDispatch, CheckObservation, CheckOutcome, CheckRun } from '../types/schema.js';
import { MoeError, MoeErrorCode, invalidInput, missingRequired, notFound } from '../util/errors.js';
import { generateId } from '../util/ids.js';
import { validateEntityId } from '../util/sanitize.js';
import { caseVariantId, getCandidate, hasControlChar, listCandidatesForTask, renderGot } from './candidateStore.js';
import { recordCheckRun, validateCheckRunParams, type RecordCheckRunParams, type RecordCheckRunResult } from './checkRunStore.js';
import { loadEntities } from './persistence.js';

/** The protected-check id rule of validateRequiredChecks (state/validators.ts). */
const CHECK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** Everything a dispatch's caller determines: a same-id replay must repeat each. */
const REPLAYED_FIELDS = ['taskId', 'candidateId', 'planRevision', 'command', 'checkId', 'environment', 'runnerId'] as const;
/** What an authenticated run must share with its dispatch. */
const BINDING_FIELDS = ['candidateId', 'treeSha', 'command', 'planRevision', 'environment', 'runnerId'] as const;

/** id is optional: reuse it on a retry, or omit it for a generated dispatch- id. */
export type RecordCheckDispatchParams = Omit<CheckDispatch, 'id' | 'treeSha' | 'runnerId' | 'createdAt'> & { id?: string };
/** id is the CheckRun id; an identical retry is idempotent. environment must equal the dispatch's. */
export type RecordCheckObservationParams = Pick<RecordCheckRunParams, 'exitCode' | 'outputTail'> &
  { id: string; dispatchId: string; outcome: CheckOutcome; environment: string };

const conflict = (codeName: string, message: string, context: Record<string, unknown>): MoeError =>
  new MoeError(MoeErrorCode.STATE_CONFLICT, message, context, codeName);
type Maps = { dispatches: Map<string, CheckDispatch>; observations: Map<string, CheckObservation> };
const mapsByState = new WeakMap<StateManager, Maps>();

// Loaded from .moe/checks/{dispatches,observations} on first use per StateManager, so a restart recovers every
// record. Kept here: StateManager.ts is at its size budget (stateModules.test.ts). loadEntities reads only
// top-level *.json, so the check-run load never includes them.
function mapsOf(state: StateManager): Maps {
  let maps = mapsByState.get(state);
  if (!maps) {
    const dir = (kind: string) => path.join(state.moePath, 'checks', kind);
    maps = { dispatches: loadEntities(dir('dispatches')), observations: loadEntities(dir('observations')) };
    mapsByState.set(state, maps);
  }
  return maps;
}

function fieldsOf(raw: unknown): Record<string, unknown> {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw invalidInput('params', `must be an object (got ${renderGot(raw)})`);
  return raw as Record<string, unknown>;
}
function requireString(field: string, value: unknown): string {
  if (value === undefined || value === null) throw missingRequired(field);
  if (typeof value !== 'string') throw invalidInput(field, `must be a string (got ${renderGot(value)})`);
  return value;
}

const requireId = (field: string, value: unknown): string => validateEntityId(requireString(field, value), field);
const requireRunnerId = (runner: unknown): string => validateEntityId((runner as { runnerId?: unknown } | null)?.runnerId, 'runner');

/** Kept verbatim, never trimmed, so it compares exactly. */
function requireText(field: string, value: unknown, max: number): string {
  const text = requireString(field, value);
  if (text.trim() === '' || text.length > max) throw invalidInput(field, `must be non-blank and at most ${max} characters`);
  if (field === 'environment' && hasControlChar(text)) throw invalidInput(field, 'must not contain control characters');
  return text;
}

function validateDispatch(raw: unknown, runnerId: string) {
  const f = fieldsOf(raw);
  const id = f.id === undefined ? generateId('dispatch') : validateEntityId(f.id, 'id');
  const taskId = requireId('taskId', f.taskId);
  const candidateId = requireId('candidateId', f.candidateId);
  if (f.planRevision === undefined || f.planRevision === null) throw missingRequired('planRevision');
  if (!Number.isSafeInteger(f.planRevision)) throw invalidInput('planRevision', `must be a safe integer (got ${renderGot(f.planRevision)})`);
  const planRevision = f.planRevision as number;
  const command = requireText('command', f.command, 500);
  if (f.checkId !== undefined && (typeof f.checkId !== 'string' || !CHECK_ID_RE.test(f.checkId))) {
    throw invalidInput('checkId', 'must be 1-64 alphanumeric, dot, underscore or hyphen characters, starting alphanumeric');
  }
  const checkId = f.checkId as string | undefined;
  const environment = requireText('environment', f.environment, 255);
  return { id, taskId, candidateId, planRevision, command, checkId, environment, runnerId };
}

/** The task, and its CURRENT candidate (the last of listCandidatesForTask) at its current approved revision. */
function requireDispatchable(state: StateManager, input: ReturnType<typeof validateDispatch>) {
  const { taskId, candidateId, planRevision } = input;
  const task = state.getTask(taskId);
  if (!task) throw notFound('Task', taskId);
  const candidate = getCandidate(state, candidateId);
  if (!candidate) throw new MoeError(MoeErrorCode.NOT_FOUND, `Candidate not found: ${candidateId}`, { candidateId }, 'CANDIDATE_NOT_FOUND');
  if (candidate.taskId !== taskId) {
    throw conflict('CHECK_DISPATCH_TASK_MISMATCH', `Candidate ${candidateId} belongs to task ${candidate.taskId}, not ${taskId}`,
      { candidateId, existingTaskId: candidate.taskId, requestedTaskId: taskId });
  }
  const currentCandidateId = listCandidatesForTask(state, taskId).at(-1)?.id;
  if (currentCandidateId !== candidateId) {
    throw conflict('CHECK_DISPATCH_NOT_CURRENT', `Candidate ${candidateId} is superseded by ${currentCandidateId}; it never gets a new dispatch`,
      { taskId, candidateId, currentCandidateId });
  }
  // A CheckRun refuses a revision below 1, so a revision-0 dispatch could never be answered.
  if (planRevision < 1 || planRevision !== task.planRevision || planRevision !== task.approvedPlanRevision) {
    throw conflict('CHECK_DISPATCH_REVISION_MISMATCH', `Plan revision ${planRevision} is not task ${taskId}'s current approved revision`,
      { taskId, planRevision, taskPlanRevision: task.planRevision ?? null, approvedPlanRevision: task.approvedPlanRevision ?? null });
  }
  return candidate;
}

/**
 * Refusals in order: runner and params; a differing same-id dispatch (CHECK_DISPATCH_IMMUTABLE), BEFORE
 * currency so a crash retry after supersession still replays; a case-variant id; requireDispatchable.
 */
export async function recordCheckDispatch(state: StateManager, runner: RunnerIdentity, params: RecordCheckDispatchParams):
  Promise<{ dispatch: CheckDispatch; duplicate: boolean }> {
  const input = validateDispatch(params, requireRunnerId(runner));
  const { id } = input, { dispatches } = mapsOf(state), stored = dispatches.get(id);
  if (stored) {
    const differingFields = REPLAYED_FIELDS.filter((field) => stored[field] !== input[field]);
    if (differingFields.length === 0) return { dispatch: { ...stored }, duplicate: true };
    throw conflict('CHECK_DISPATCH_IMMUTABLE', `Check dispatch ${id} already exists and differs in ${differingFields.join(', ')}`,
      { dispatchId: id, differingFields });
  }
  const existing = caseVariantId(dispatches.keys(), id);
  if (existing) {
    throw conflict('CHECK_DISPATCH_ID_CASE_COLLISION', `Check dispatch id ${id} differs only by case from ${existing}, one file on NTFS or APFS`,
      { dispatchId: existing, requestedId: id });
  }
  const { treeSha } = requireDispatchable(state, input), { checkId, environment, runnerId } = input;
  const dispatch: CheckDispatch = {
    id, taskId: input.taskId, candidateId: input.candidateId, treeSha, planRevision: input.planRevision, command: input.command,
    ...(checkId !== undefined ? { checkId } : {}), environment, runnerId, createdAt: new Date().toISOString(),
  };
  await state.writeEntity('checks/dispatches', id, dispatch);
  dispatches.set(id, dispatch);
  return { dispatch: { ...dispatch }, duplicate: false };
}

const copyOf = <T extends object>(stored: T | undefined): T | null => (stored ? { ...stored } : null);
export const getCheckDispatch = (state: StateManager, id: string) => copyOf(mapsOf(state).dispatches.get(id));
export const getCheckObservation = (state: StateManager, dispatchId: string) => copyOf(mapsOf(state).observations.get(dispatchId));

/**
 * The one result of a recorded dispatch, by its runner in its environment, bound ONLY to the dispatch and
 * the runner, even once superseded. The CheckRun goes through the unchanged checkRunStore (its refusals,
 * e.g. CHECK_RUN_IMMUTABLE, propagate) BEFORE the marker, so an identical retry completes a crashed marker.
 */
export async function recordCheckObservation(state: StateManager, runner: RunnerIdentity, params: RecordCheckObservationParams):
  Promise<RecordCheckRunResult> {
  const runnerId = requireRunnerId(runner);
  const f = fieldsOf(params);
  const id = requireId('id', f.id);
  const dispatchId = requireId('dispatchId', f.dispatchId);
  if (f.outcome === undefined || f.outcome === null) throw missingRequired('outcome');
  const { dispatches, observations } = mapsOf(state);
  const dispatch = dispatches.get(dispatchId);
  if (!dispatch) throw new MoeError(MoeErrorCode.NOT_FOUND, `Check dispatch not found: ${dispatchId}`, { dispatchId }, 'CHECK_DISPATCH_NOT_FOUND');
  if (runnerId !== dispatch.runnerId) {
    throw new MoeError(MoeErrorCode.NOT_ALLOWED, `Check dispatch ${dispatchId} belongs to another runner`, { dispatchId }, 'CHECK_RUNNER_MISMATCH');
  }
  if (f.environment !== dispatch.environment) {
    throw conflict('CHECK_ENVIRONMENT_MISMATCH', `Environment ${renderGot(f.environment)} is not dispatch ${dispatchId}'s environment`, { dispatchId });
  }
  const marker = observations.get(dispatchId);
  if (marker && marker.checkRunId !== id) {
    throw conflict('CHECK_DISPATCH_ALREADY_OBSERVED', `Check dispatch ${dispatchId} was already answered by ${marker.checkRunId}`,
      { dispatchId, checkRunId: marker.checkRunId, requestedId: id });
  }
  const { candidateId, treeSha, command, planRevision, environment } = dispatch;
  const result = await recordCheckRun(state, validateCheckRunParams({
    id, candidateId, treeSha, command, exitCode: f.exitCode, outputTail: f.outputTail, runnerId,
    source: 'runner-observed', outcome: f.outcome, planRevision, environment, dispatchId,
  }));
  if (!marker) {
    const observation: CheckObservation = { id: dispatchId, checkRunId: id, runnerId, createdAt: new Date().toISOString() };
    await state.writeEntity('checks/observations', dispatchId, observation);
    observations.set(dispatchId, observation);
  }
  return result;
}

/**
 * True only for a run that IS a stored run (every key equal: a caller-built object never authenticates
 * itself), runner-observed, named with its runner by a marker, with its dispatch's exact binding. A
 * moe.record_check_run run has no marker, so it stays diagnostic. Never throws; fails closed.
 */
export function isAuthenticatedCheckRun(state: StateManager, run: CheckRun): boolean {
  try {
    const stored = state.checkRuns.get(run.id);
    const given = run as unknown as Record<string, unknown>;
    const keys = stored ? (Object.keys(stored) as Array<keyof CheckRun>) : [];
    if (!stored || Object.keys(given).length !== keys.length || !keys.every((k) => Object.hasOwn(given, k) && given[k] === stored[k])) return false;
    if (stored.source !== 'runner-observed' || typeof stored.dispatchId !== 'string') return false;
    const { dispatches, observations } = mapsOf(state);
    const marker = observations.get(stored.dispatchId), dispatch = dispatches.get(stored.dispatchId);
    if (!marker || !dispatch || marker.checkRunId !== stored.id || marker.runnerId !== stored.runnerId) return false;
    return BINDING_FIELDS.every((field) => dispatch[field] === stored[field]);
  } catch {
    return false;
  }
}
