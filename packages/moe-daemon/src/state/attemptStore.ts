// =============================================================================
// Attempt store — durable identity for one execution of one task
// =============================================================================
//
// Every execution of a task gets an ExecutionAttempt record, so a later call can
// be told whether it belongs to the CURRENT attempt or a superseded one. The
// fencing token is `generation`: monotonic per task, starting at 1, allocated as
// (max generation over EVERY prior attempt for that task, closed ones included)
// + 1. It is never derived from how many records currently exist, because a
// deleted record would then reissue a generation that an in-flight caller still
// believes is exclusively its own — which is the exact failure a fencing token
// exists to prevent.
//
// Follows the resourceStore pattern: stateless functions taking the state handle
// first; every mutation assumes THE CALLER HOLDS state.mutex (tool dispatch
// provides it for non-blocking tools). The store cannot enforce that alone — the
// exclusivity check below reads the map and then writes, so two concurrent opens
// for the same task outside the mutex could both pass the check.
//
// Write path per mutation: writeEntity → map.set. Persist BEFORE the record
// becomes visible, so a failed write leaves no attempt anywhere and a crash can
// never expose an attempt that is not on disk. Unlike resourceStore this store
// appends no activity row and emits no event: both would require editing the
// existing ACTIVITY_EVENT_TYPES / StateChangeEvent unions, and there is no
// consumer yet. Claim and release open and close attempts without either; add
// both together with the first consumer (an attempt view on the board).
//
// Recovery is an idempotent re-open, not a file repair: writeEntity is an atomic
// temp-file-and-rename, so a torn half-JSON is not reachable. The reachable
// failure is a record that landed on disk with nothing following it, which is why
// the attempt id is caller-suppliable — re-opening with the same id returns the
// persisted record instead of writing a second one.

import type { StateManager } from './StateManager.js';
import type { ExecutionAttempt, ExecutionAttemptPhase } from '../types/schema.js';
import { MoeError, MoeErrorCode, invalidInput } from '../util/errors.js';
import { generateId } from '../util/ids.js';

/** Shared with the Kotlin/JSON clients' Long; an allocation past this fails closed. */
export const MAX_ATTEMPT_GENERATION = Number.MAX_SAFE_INTEGER;

/** An attempt in any of these phases still owns its task. Only `closed` is terminal. */
const OPEN_PHASES: ReadonlySet<ExecutionAttemptPhase> = new Set<ExecutionAttemptPhase>([
  'running',
  'finalizing',
  'reconciling',
]);

function requireNonBlank(field: string, value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw invalidInput(field, `must be a non-blank string (got ${JSON.stringify(value)})`);
  }
  return value;
}

function conflict(message: string, context: Record<string, unknown>, codeName: string): MoeError {
  return new MoeError(MoeErrorCode.STATE_CONFLICT, message, context, codeName);
}

/**
 * Read a persisted generation, failing closed. A corrupt stored value must not
 * be coerced to 0 or skipped: either would let the next allocation reissue a
 * generation that is already in use.
 */
function decodeStoredGeneration(attempt: ExecutionAttempt): number {
  const stored = attempt.generation;
  if (typeof stored !== 'number' || !Number.isSafeInteger(stored) || stored < 1) {
    throw invalidInput(
      'generation',
      `stored generation for attempt ${attempt.id} is not a positive safe integer (got ${String(stored)})`
    );
  }
  return stored;
}

export function getAttempt(state: StateManager, attemptId: string): ExecutionAttempt | null {
  return state.attempts.get(attemptId) ?? null;
}

/** Attempts in generation order; every attempt when `taskId` is omitted. */
export function listAttempts(state: StateManager, taskId?: string): ExecutionAttempt[] {
  const all = Array.from(state.attempts.values());
  const scoped = taskId === undefined ? all : all.filter((a) => a.taskId === taskId);
  return scoped.sort((a, b) => a.generation - b.generation);
}

/**
 * The task's one non-closed attempt, or null. Exclusivity in openAttempt is what
 * keeps "one" true; if a crash ever left two open, the highest generation is the
 * live one and the caller is told about that one.
 */
export function currentAttempt(state: StateManager, taskId: string): ExecutionAttempt | null {
  const open = listAttempts(state, taskId).filter((a) => OPEN_PHASES.has(a.phase));
  return open.length === 0 ? null : open[open.length - 1];
}

/** Next generation for a task: max over every prior attempt + 1, never a count. */
function nextGeneration(state: StateManager, taskId: string): number {
  let max = 0;
  for (const attempt of listAttempts(state, taskId)) {
    const generation = decodeStoredGeneration(attempt);
    if (generation > max) max = generation;
  }
  if (max >= MAX_ATTEMPT_GENERATION) {
    throw conflict(
      `Attempt generations for task ${taskId} are exhausted at ${MAX_ATTEMPT_GENERATION} and cannot be advanced`,
      { taskId, currentGeneration: max, maxGeneration: MAX_ATTEMPT_GENERATION },
      'ATTEMPT_GENERATION_EXHAUSTED'
    );
  }
  return max + 1;
}

export interface OpenAttemptParams {
  taskId: string;
  workerId: string;
  runnerId: string;
  workspace: string;
  /**
   * Optional. Supply the id a crashed open used to make this call a repair
   * instead of a duplicate; omit it for a fresh attempt.
   */
  id?: string;
  /** Advisory reattachment hints — never evidence that a process is alive. */
  processStartedAt?: string;
  host?: string;
}

/**
 * The repair case: a persisted record under this id IS the attempt, so it is
 * returned unchanged — no second file, no advanced generation, and NO adoption
 * of the caller's other params (a re-open carrying a different workspace or
 * workerId does not rewrite history; compare the fields yourself if you care).
 * An id holding another task's attempt is a conflict, never a silent adoption.
 */
function repairExisting(
  state: StateManager,
  id: string,
  taskId: string
): ExecutionAttempt | null {
  const existing = state.attempts.get(id);
  if (!existing) return null;
  if (existing.taskId !== taskId) {
    throw conflict(
      `Attempt ${id} already belongs to task ${existing.taskId}, not ${taskId}`,
      { attemptId: id, existingTaskId: existing.taskId, requestedTaskId: taskId },
      'ATTEMPT_ID_TASK_MISMATCH'
    );
  }
  return existing;
}

/**
 * Exclusivity: a live attempt is never overwritten. The refusal carries what the
 * caller needs to decide whether it is the superseded one. Note this is a
 * check-then-act over the in-memory map — it holds only because the caller holds
 * state.mutex (see the header).
 */
function assertNoOpenAttempt(state: StateManager, taskId: string): void {
  const open = currentAttempt(state, taskId);
  if (!open) return;
  throw conflict(
    `Task ${taskId} already has attempt ${open.id} (generation ${open.generation}) in phase ${open.phase}`,
    { taskId, attemptId: open.id, generation: open.generation, phase: open.phase },
    'ATTEMPT_ALREADY_OPEN'
  );
}

/**
 * Open an attempt for a task. In order: repair an existing record with the
 * supplied id, refuse if the task already has a non-closed attempt, then
 * allocate a generation and persist before publishing.
 *
 * Deliberately does NOT require the task to exist. Whether an attempt may
 * outlive its task is policy for the work that wires attempts into
 * claim/complete/release; this store only records what it was told.
 */
export async function openAttempt(
  state: StateManager,
  params: OpenAttemptParams
): Promise<ExecutionAttempt> {
  const taskId = requireNonBlank('taskId', params.taskId);
  const workerId = requireNonBlank('workerId', params.workerId);
  const runnerId = requireNonBlank('runnerId', params.runnerId);
  const workspace = requireNonBlank('workspace', params.workspace);
  const id = params.id === undefined ? generateId('attempt') : requireNonBlank('id', params.id);

  const repaired = repairExisting(state, id, taskId);
  if (repaired) return repaired;
  assertNoOpenAttempt(state, taskId);

  // Allocate and persist. writeEntity validates the id against path traversal,
  // creates .moe/attempts itself, and writes atomically.
  const now = new Date().toISOString();
  const attempt: ExecutionAttempt = {
    id,
    taskId,
    workerId,
    runnerId,
    generation: nextGeneration(state, taskId),
    workspace,
    phase: 'running',
    startedAt: now,
    lastPhaseAt: now,
    ...(params.processStartedAt !== undefined ? { processStartedAt: params.processStartedAt } : {}),
    ...(params.host !== undefined ? { host: params.host } : {}),
  };
  await state.writeEntity('attempts', attempt.id, attempt);
  state.attempts.set(attempt.id, attempt);
  return attempt;
}

/**
 * Move an attempt to `phase`, stamping lastPhaseAt. `closed` is terminal: any
 * change out of it is refused. No fuller transition table is enforced here on
 * purpose — which phase may follow which is decided by the work that wires
 * attempts into claim/complete/release, and guessing it now would be a contract
 * this store cannot honour.
 */
export async function setAttemptPhase(
  state: StateManager,
  attemptId: string,
  phase: ExecutionAttemptPhase
): Promise<ExecutionAttempt> {
  const id = requireNonBlank('attemptId', attemptId);
  if (!OPEN_PHASES.has(phase) && phase !== 'closed') {
    throw invalidInput('phase', `must be a known attempt phase (got ${JSON.stringify(phase)})`);
  }
  const existing = state.attempts.get(id);
  if (!existing) {
    throw new MoeError(
      MoeErrorCode.NOT_FOUND,
      `Attempt not found: ${id}`,
      { attemptId: id },
      'ATTEMPT_NOT_FOUND'
    );
  }
  // Re-asserting the phase an attempt already holds is a no-op, not a write:
  // lastPhaseAt records when the phase CHANGED, so a repeated call (a retried
  // close from an exit trap) must not churn it.
  if (existing.phase === phase) return existing;
  if (existing.phase === 'closed') {
    throw conflict(
      `Attempt ${id} is closed; its phase cannot change to ${phase}`,
      { attemptId: id, taskId: existing.taskId, phase: existing.phase, requestedPhase: phase },
      'ATTEMPT_CLOSED'
    );
  }
  // Mutate a private copy so a thrown write cannot have altered published state.
  const updated: ExecutionAttempt = { ...existing, phase, lastPhaseAt: new Date().toISOString() };
  await state.writeEntity('attempts', updated.id, updated);
  state.attempts.set(updated.id, updated);
  return updated;
}

/**
 * Close every non-closed attempt of a task. This is the ONE close path: every
 * site that takes a task's seat away (release_task, deregister, worker deletion,
 * the startup purge, a claim evicting the previous owner) calls it, so the rules
 * below exist once. Returns the records it closed, in generation order.
 *
 * - Idempotent: an exit trap and a purge can both fire for the same task, so a
 *   second call finds nothing open and does nothing — no write, no error.
 * - Tolerant: every task created before attempts existed has no record at all,
 *   and releasing one must not start failing. That is simply an empty result.
 * - ALL open attempts, not just currentAttempt(): the caller is giving the seat
 *   up, so none may survive for the task, and currentAttempt() would name only
 *   the highest if a restored backup ever left two open.
 * - Never deletes: generations are allocated over every prior attempt, closed
 *   ones included, so a closed record is the history that keeps the next
 *   generation strictly greater. Each close goes through setAttemptPhase and so
 *   keeps its write-then-publish order: a failed write throws with the attempt
 *   still published as open, and the caller decides whether that is fatal.
 *
 * Like every mutation here, the caller must hold state.mutex.
 */
export async function closeOpenAttempts(
  state: StateManager,
  taskId: string
): Promise<ExecutionAttempt[]> {
  const closed: ExecutionAttempt[] = [];
  for (const attempt of listAttempts(state, taskId)) {
    if (!OPEN_PHASES.has(attempt.phase)) continue;
    closed.push(await setAttemptPhase(state, attempt.id, 'closed'));
  }
  return closed;
}
