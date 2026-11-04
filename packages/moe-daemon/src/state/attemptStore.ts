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
// appends no activity row and emits no attempt event: both would require editing
// the existing ACTIVITY_EVENT_TYPES / StateChangeEvent unions, and there is no
// consumer yet. Claim and release open and close attempts without either; add
// both together with the first consumer (an attempt view on the board).
//
// ONE deliberate exception: announceAttemptClosed re-publishes the unchanged
// TASK as TASK_UPDATED when a finalizing boundary ends. While an attempt is
// finalizing no other seat may claim its task, and closing the attempt writes no
// task — so without that one event neither a parked moe.wait_for_task waiter nor
// the board would ever see the hold lift.
//
// Recovery is an idempotent re-open, not a file repair: writeEntity is an atomic
// temp-file-and-rename, so a torn half-JSON is not reachable. The reachable
// failure is a record that landed on disk with nothing following it, which is why
// the attempt id is caller-suppliable — re-opening with the same id returns the
// persisted record instead of writing a second one.
//
// An attempt may carry a configuration identity (executionPolicySnapshot),
// captured once at open, never rewritten, and returned only as detached copies.
// recordContextReceipt writes the latest served get_context receipt onto a
// running attempt through the same write-then-publish path, and
// recordStepCompletion appends strict step-completion evidence the same way.

import type { StateManager } from './StateManager.js';
import type {
  AttemptPresenceKind,
  ExecutionAttempt,
  ExecutionAttemptPhase,
  ExecutionPolicySnapshot,
  ExecutionWorkspaceMode,
  ServedContextReceipt,
  StepCompletionEvidence,
  Task,
} from '../types/schema.js';
// The leaf, and the only policy import allowed here: delivery/policy.ts and
// state/taskStore.ts both import this store, so either would close a cycle.
import { readExecutionPolicySnapshot } from '../delivery/executionProfile.js';
import { validateEnumValue, validateStringValue } from './validators.js';
import { MoeError, MoeErrorCode, invalidInput, notAllowed } from '../util/errors.js';
import { generateId } from '../util/ids.js';
import { logger } from '../util/logger.js';

/** Shared with the Kotlin/JSON clients' Long; an allocation past this fails closed. */
export const MAX_ATTEMPT_GENERATION = Number.MAX_SAFE_INTEGER;

/**
 * The only presence kinds a sidecar may report; anything else is invalid input.
 * Exported so moe.heartbeat's input schema and this store validate against ONE
 * list — a second copy would drift the day a fifth kind is added.
 */
export const ATTEMPT_PRESENCE_KINDS: ReadonlySet<AttemptPresenceKind> = new Set<AttemptPresenceKind>([
  'process',
  'provider',
  'waiting',
  'progress',
]);

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

/**
 * What every exported function hands out: the stored snapshot object never
 * leaves the store, so no caller can rewrite an attempt's identity through an
 * alias. A copy of the raw value, deliberately not validated, so one hand-edited
 * record can never make a read throw. The context receipt and step completions
 * are copied the same way. A record with none of them is returned as it always was.
 */
function detached(attempt: ExecutionAttempt): ExecutionAttempt {
  const { executionPolicySnapshot: snapshot, contextReceipt: receipt, stepCompletions: steps } = attempt;
  if (snapshot === undefined && receipt === undefined && steps === undefined) return attempt;
  return {
    ...attempt,
    ...(snapshot !== undefined ? { executionPolicySnapshot: structuredClone(snapshot) } : {}),
    ...(receipt !== undefined ? { contextReceipt: structuredClone(receipt) } : {}),
    ...(steps !== undefined ? { stepCompletions: structuredClone(steps) } : {}),
  };
}

export function getAttempt(state: StateManager, attemptId: string): ExecutionAttempt | null {
  const attempt = state.attempts.get(attemptId);
  return attempt ? detached(attempt) : null;
}

/** The stored records in generation order, for this store's own bookkeeping only. */
function storedAttempts(state: StateManager, taskId?: string): ExecutionAttempt[] {
  const all = Array.from(state.attempts.values());
  const scoped = taskId === undefined ? all : all.filter((a) => a.taskId === taskId);
  return scoped.sort((a, b) => a.generation - b.generation);
}

/** Attempts in generation order; every attempt when `taskId` is omitted. */
export function listAttempts(state: StateManager, taskId?: string): ExecutionAttempt[] {
  return storedAttempts(state, taskId).map(detached);
}

/**
 * The task's one non-closed attempt, or null. Exclusivity in openAttempt is what
 * keeps "one" true; if a crash ever left two open, the highest generation is the
 * live one and the caller is told about that one.
 */
export function currentAttempt(state: StateManager, taskId: string): ExecutionAttempt | null {
  const open = storedAttempts(state, taskId).filter((a) => OPEN_PHASES.has(a.phase));
  return open.length === 0 ? null : detached(open[open.length - 1]);
}

/**
 * How many open (running, finalizing or reconciling) attempts carry this
 * workerId. Read-only, one pass, and it counts attempts whose worker record is
 * gone too: moe.deregister_worker and the restart purge can leave a finalizing
 * attempt behind its pruned worker, so "no worker record" never proves "no
 * open attempt".
 */
export function countOpenAttempts(state: StateManager, workerId: string): number {
  let count = 0;
  for (const attempt of state.attempts.values()) {
    if (attempt.workerId === workerId && OPEN_PHASES.has(attempt.phase)) count += 1;
  }
  return count;
}

/** Next generation for a task: max over every prior attempt + 1, never a count. */
function nextGeneration(state: StateManager, taskId: string): number {
  let max = 0;
  for (const attempt of storedAttempts(state, taskId)) {
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
  /** Internal claim-derived identity; omitted preserves the legacy record shape. */
  workspaceMode?: ExecutionWorkspaceMode;
  /**
   * Optional. Supply the id a crashed open used to make this call a repair
   * instead of a duplicate; omit it for a fresh attempt.
   */
  id?: string;
  /** Advisory reattachment hints — never evidence that a process is alive. */
  processStartedAt?: string;
  host?: string;
  /**
   * Internal: the configuration identity the claim path derived from daemon task
   * and project state (tools/claimNextTask.ts deriveAttemptPolicySnapshot). Never
   * an MCP argument, and never approval, readiness or runner trust. Omit it and
   * the record is the legacy shape, with no key at all.
   */
  executionPolicySnapshot?: ExecutionPolicySnapshot;
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
 *
 * A supplied executionPolicySnapshot is decoded strictly into a fresh copy, so
 * a malformed one throws INVALID_INPUT before anything is allocated or written
 * and the caller's object is never stored. A repair never adopts one.
 */
export async function openAttempt(
  state: StateManager,
  params: OpenAttemptParams
): Promise<ExecutionAttempt> {
  const taskId = requireNonBlank('taskId', params.taskId);
  const workerId = requireNonBlank('workerId', params.workerId);
  const runnerId = requireNonBlank('runnerId', params.runnerId);
  const workspace = requireNonBlank('workspace', params.workspace);
  const workspaceMode = params.workspaceMode === undefined ? undefined
    : validateEnumValue(params.workspaceMode, 'workspaceMode', ['shared', 'worktree'] as const);
  const id = params.id === undefined ? generateId('attempt') : requireNonBlank('id', params.id);

  const repaired = repairExisting(state, id, taskId);
  if (repaired) return detached(repaired);
  assertNoOpenAttempt(state, taskId);
  const snapshot = readExecutionPolicySnapshot(params.executionPolicySnapshot);

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
    ...(workspaceMode !== undefined ? { workspaceMode } : {}),
    phase: 'running',
    startedAt: now,
    lastPhaseAt: now,
    ...(params.processStartedAt !== undefined ? { processStartedAt: params.processStartedAt } : {}),
    ...(params.host !== undefined ? { host: params.host } : {}),
    ...(snapshot !== undefined ? { executionPolicySnapshot: snapshot } : {}),
  };
  await state.writeEntity('attempts', attempt.id, attempt);
  state.attempts.set(attempt.id, attempt);
  return detached(attempt);
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
  if (existing.phase === phase) return detached(existing);
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
  return detached(updated);
}

/**
 * Record the latest presence kind a runner's sidecar reported for an attempt.
 *
 * DELIBERATELY NOT setAttemptPhase, AND THIS MUST NOT BE "SIMPLIFIED" INTO IT.
 * The phase setter stamps `lastPhaseAt`, and the reconcile-window sweep
 * (state/sweeps.ts) measures its window from exactly that field. A heartbeat
 * fires every 60 seconds per seat, so routing presence through the phase setter
 * would refresh that clock forever: a reconciling attempt would become immortal
 * and the sweep would silently never fire. Presence therefore writes its own
 * two fields and nothing else — phase, lastPhaseAt, startedAt and the identity
 * hints all come through untouched.
 *
 * What this records is a CLAIM, not evidence: see AttemptPresenceKind. Storing
 * it may not be read anywhere as proof the execution is alive.
 *
 * Keeps the store's one write-then-publish ordering, so a failed write leaves
 * the attempt published exactly as it was. Caller must hold state.mutex.
 */
export async function recordAttemptPresence(
  state: StateManager,
  attemptId: string,
  kind: AttemptPresenceKind
): Promise<ExecutionAttempt> {
  const id = requireNonBlank('attemptId', attemptId);
  // Refused, never stored: an unknown kind that landed on disk would outlive
  // the typo and every later reader would have to guess what it meant.
  if (!ATTEMPT_PRESENCE_KINDS.has(kind)) {
    throw invalidInput(
      'presenceKind',
      `must be one of ${Array.from(ATTEMPT_PRESENCE_KINDS).join(', ')} (got ${JSON.stringify(kind)})`
    );
  }
  const existing = state.attempts.get(id);
  // A named error, not a silent no-op: the caller decides whether a vanished
  // attempt is routine (it is, for a heartbeat) or a real fault.
  if (!existing) {
    throw new MoeError(
      MoeErrorCode.NOT_FOUND,
      `Attempt not found: ${id}`,
      { attemptId: id },
      'ATTEMPT_NOT_FOUND'
    );
  }
  // Mutate a private copy so a thrown write cannot have altered published state.
  const updated: ExecutionAttempt = {
    ...existing,
    presenceKind: kind,
    presenceAt: new Date().toISOString(),
  };
  await state.writeEntity('attempts', updated.id, updated);
  state.attempts.set(updated.id, updated);
  return detached(updated);
}

/** record_commit's sessionId bound. No trim, no truncation, no coercion. */
const SESSION_ID_RULE = { maxLength: 255 };

/** A caller-presented ServedContextReceipt.sessionId. Absent stays absent; null is refused, never "no session". */
export function readContextSessionId(value: unknown): string | undefined {
  return value === undefined ? undefined : validateStringValue(value, 'sessionId', SESSION_ID_RULE);
}

const isText = (v: unknown) => typeof v === 'string' && v.trim() !== '';
const isRevision = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

/** Every receipt field's check, in canonical key order; approvedPlanRevision is the one optional key. */
const RECEIPT_FIELDS: Record<keyof ServedContextReceipt, (v: unknown) => boolean> = {
  id: isText,
  packetId: (v) => typeof v === 'string' && /^sha256:[0-9a-f]{64}$/.test(v),
  taskId: isText,
  attemptId: isText,
  generation: (v) => isRevision(v) && v >= 1,
  workerId: isText,
  sessionId: (v) => validateStringValue(v, 'contextReceipt.sessionId', SESSION_ID_RULE) === v,
  planRevision: isRevision,
  approvedPlanRevision: isRevision,
  view: (v) => v === 'default' || v === 'full',
  servedAt: isText,
};

/**
 * The ONE definition of a valid served-context receipt, used on every write
 * and by every later reader. Strict: the enumerable own key set must match
 * exactly, and anything malformed throws INVALID_INPUT, never coerced. Returns
 * a fresh primitive-only copy in canonical key order.
 */
export function readContextReceipt(value: unknown): ServedContextReceipt | undefined {
  if (value === undefined) return undefined;
  const proto = value !== null && typeof value === 'object' ? Object.getPrototypeOf(value) : undefined;
  if (proto !== Object.prototype && proto !== null) throw invalidInput('contextReceipt', 'must be a plain object');
  const r = value as Record<string, unknown>;
  const own = Object.keys(r);
  const keys = Object.keys(RECEIPT_FIELDS).filter((k) => k !== 'approvedPlanRevision' || own.includes(k));
  if (own.length !== keys.length || !own.every((k) => keys.includes(k))) {
    throw invalidInput('contextReceipt', `must have exactly the keys ${keys.join(', ')}`);
  }
  for (const k of keys) {
    if (!RECEIPT_FIELDS[k as keyof ServedContextReceipt](r[k])) throw invalidInput(`contextReceipt.${k}`, 'is malformed');
  }
  return Object.fromEntries(keys.map((k) => [k, r[k]])) as unknown as ServedContextReceipt;
}

/**
 * Record what get_context is about to serve to a RUNNING attempt's own worker;
 * the latest receipt replaces any earlier one. taskId, attemptId, generation
 * and workerId come from the STORED attempt, never the caller. Every refusal
 * precedes the write. Not setAttemptPhase: every other field, lastPhaseAt
 * included, is carried over. Write-then-publish. Caller must hold state.mutex.
 */
export async function recordContextReceipt(
  state: StateManager,
  p: Pick<ServedContextReceipt, 'attemptId' | 'workerId' | 'sessionId' | 'packetId' | 'planRevision' | 'approvedPlanRevision' | 'view'>
): Promise<ServedContextReceipt> {
  const id = requireNonBlank('attemptId', p.attemptId);
  const existing = state.attempts.get(id);
  if (!existing) throw new MoeError(MoeErrorCode.NOT_FOUND, `Attempt not found: ${id}`, { attemptId: id }, 'ATTEMPT_NOT_FOUND');
  if (existing.phase !== 'running') {
    throw conflict(`Attempt ${id} is ${existing.phase}; a context receipt is recorded only on a running attempt`,
      { attemptId: id, taskId: existing.taskId, phase: existing.phase }, 'ATTEMPT_NOT_RUNNING');
  }
  if (p.workerId !== existing.workerId) throw notAllowed('recordContextReceipt', `attempt ${id} belongs to another worker`);
  const contextReceipt = readContextReceipt({
    id: generateId('ctxreceipt'), packetId: p.packetId, taskId: existing.taskId, attemptId: existing.id,
    generation: decodeStoredGeneration(existing), workerId: existing.workerId, sessionId: p.sessionId,
    planRevision: p.planRevision,
    ...(p.approvedPlanRevision !== undefined ? { approvedPlanRevision: p.approvedPlanRevision } : {}),
    view: p.view, servedAt: new Date().toISOString(),
  }) as ServedContextReceipt;
  const updated: ExecutionAttempt = { ...existing, contextReceipt };
  await state.writeEntity('attempts', id, updated);
  state.attempts.set(id, updated);
  return { ...contextReceipt };
}

const STEP_COMPLETION_KEYS = ['stepId', 'planRevision', 'completedAt'] as const;

/**
 * The ONE definition of valid stored step-completion evidence (CQ-F08). Absent
 * is []. Strict: an array of plain objects with exactly stepId, planRevision
 * and completedAt; anything else throws INVALID_INPUT, never coerced, filtered
 * or dropped. Returns fresh canonical copies.
 */
export function readStepCompletions(value: unknown): StepCompletionEvidence[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw invalidInput('stepCompletions', 'must be an array');
  return value.map((entry: unknown, i) => {
    const proto = entry !== null && typeof entry === 'object' ? Object.getPrototypeOf(entry) : undefined;
    const e = entry as Record<string, unknown>;
    const own = proto === Object.prototype || proto === null ? Object.keys(e) : [];
    if (own.length !== STEP_COMPLETION_KEYS.length || !STEP_COMPLETION_KEYS.every((k) => own.includes(k))
      || !isText(e.stepId) || !isRevision(e.planRevision) || !isText(e.completedAt)) {
      throw invalidInput(`stepCompletions[${i}]`, `must be a plain object with exactly ${STEP_COMPLETION_KEYS.join(', ')}`);
    }
    return { stepId: e.stepId as string, planRevision: e.planRevision, completedAt: e.completedAt as string };
  });
}

/**
 * Append one strict step completion to a RUNNING attempt of the caller's own.
 * The only writer of stepCompletions: no tool argument, UPDATE_TASK payload or
 * claim path can mint evidence. Every refusal, a malformed stored history
 * included, precedes the write; every other field, lastPhaseAt included, is
 * carried over. Write-then-publish. Caller must hold state.mutex.
 * ponytail: append-only and unbounded; bounded in practice by plan steps times
 * replans within one attempt.
 */
export async function recordStepCompletion(
  state: StateManager,
  p: { attemptId: string; workerId: string; stepId: string; planRevision: number }
): Promise<StepCompletionEvidence[]> {
  const id = requireNonBlank('attemptId', p.attemptId);
  const existing = state.attempts.get(id);
  if (!existing) throw new MoeError(MoeErrorCode.NOT_FOUND, `Attempt not found: ${id}`, { attemptId: id }, 'ATTEMPT_NOT_FOUND');
  if (existing.phase !== 'running') {
    throw conflict(`Attempt ${id} is ${existing.phase}; a step completion is recorded only on a running attempt`,
      { attemptId: id, taskId: existing.taskId, phase: existing.phase }, 'ATTEMPT_NOT_RUNNING');
  }
  if (p.workerId !== existing.workerId) throw notAllowed('recordStepCompletion', `attempt ${id} belongs to another worker`);
  const stepCompletions = readStepCompletions([
    ...readStepCompletions(existing.stepCompletions),
    { stepId: p.stepId, planRevision: p.planRevision, completedAt: new Date().toISOString() },
  ]);
  const updated: ExecutionAttempt = { ...existing, stepCompletions };
  await state.writeEntity('attempts', id, updated);
  state.attempts.set(id, updated);
  return structuredClone(stepCompletions);
}

/**
 * Park every `running` attempt whose task is still assigned to its worker in
 * `reconciling`, close every `running` or `reconciling` attempt whose task is
 * not, and report what parked.
 *
 * WHAT `reconciling` MEANS, exactly: the daemon has LOST SIGHT of this
 * execution — it restarted, and the process it was watching is outside its
 * knowledge now — so it holds the task until a runner proves which process it
 * is talking about. That is NOT a belief that the process is alive, and it is
 * not a belief that it is dead either. It is the absence of both. Nothing here
 * consults lastActivityAt or any other idle signal, because a silent build is
 * not evidence of a dead worker: the phase records ignorance, not a verdict.
 *
 * WHICH ATTEMPTS PARK. The hold exists for a seat that still owns its task, so
 * an attempt parks only while its task exists and task.assignedWorkerId is the
 * attempt's own workerId. A `running` attempt whose task is missing, unassigned
 * or assigned to another worker belongs to a seat that already gave the task up
 * — a hand-back that predates closing on hand-back, or a crash between a seat
 * clear and its close. Parking it would hold the row for nobody and make
 * purgeAllWorkers spare a seat that holds no task, so it is CLOSED instead. A
 * `reconciling` attempt an earlier restart parked gets the same test: while its
 * task is still assigned to its worker it is left exactly as it is (the window
 * keeps measuring from the original park), and once it is not, it is an orphan
 * and is closed. The deciding fact is the assignment alone: never presence,
 * never an idle signal.
 *
 * Called once at daemon startup, BEFORE purgeAllWorkers, so the purge can see
 * which seats still own an execution and spare them. `finalizing` belongs to a
 * complete_task that is still landing its bytes and keeps its own hold across
 * the restart — unless its task no longer exists. A task removed outside the
 * daemon (a git checkout of .moe/tasks, a hand deletion) is a structural fact,
 * not an idle signal, and nothing else could close that attempt: finalize_attempt
 * refuses a missing task before it looks the attempt up. So it is closed as an
 * orphan. `closed` is terminal history.
 *
 * Goes through setAttemptPhase like every other mutation, so the store keeps
 * its one write-then-publish ordering and a failed write leaves the attempt
 * published as it was. Caller must hold state.mutex.
 *
 * Per-attempt try/catch for the same reason purgeAllWorkers has one: this runs
 * on EVERY daemon start, and one unwritable record must not abort startup for
 * the whole fleet. A record that fails to park stays `running`, which is still
 * non-closed — so its seat is still spared, its task is still held, and a
 * runner reattaching to it still succeeds. Swallowing here fails in the safe
 * direction; throwing would brick the daemon over one bad file. The close arm
 * fails in a different direction and has its own catch (closeOrphanedAttempt).
 *
 * Returns the PARKED attempts only; a closed orphan, and a hold an earlier
 * restart already parked, are not in the list.
 */
export async function reconcileRunningAttempts(state: StateManager): Promise<ExecutionAttempt[]> {
  const reconciled: ExecutionAttempt[] = [];
  for (const attempt of storedAttempts(state)) {
    if (attempt.phase === 'finalizing') {
      if (!state.getTask(attempt.taskId)) await closeOrphanedAttempt(state, attempt, null);
      continue;
    }
    if (attempt.phase !== 'running' && attempt.phase !== 'reconciling') continue;
    const task = state.getTask(attempt.taskId);
    if (!task || task.assignedWorkerId !== attempt.workerId) {
      await closeOrphanedAttempt(state, attempt, task);
      continue;
    }
    // Already held for its still-assigned owner by an earlier restart.
    if (attempt.phase === 'reconciling') continue;
    try {
      reconciled.push(await setAttemptPhase(state, attempt.id, 'reconciling'));
    } catch (error) {
      logger.error(
        { error, attemptId: attempt.id, taskId: attempt.taskId },
        'Failed to park a running attempt in reconciling during startup; its task stays held'
      );
    }
  }
  return reconciled;
}

/**
 * The startup close for a `running` or `reconciling` attempt whose seat no
 * longer holds its task, and for a `finalizing` one whose task is gone (see
 * reconcileRunningAttempts). Logged at info, with the
 * assignee the row has now, so an operator can see which orphan a restart
 * retired and from whose row.
 *
 * Its own catch and its own message, because a failed close fails in another
 * direction than a failed park: the orphan keeps its phase on a row it does not
 * hold, which is benign. Nothing is held — moe.claim_next_task refuses a third
 * party only while the row is still assigned to the reconciling holder — and
 * the next claim of the row closes the leftover through openClaimAttempt's
 * ATTEMPT_ALREADY_OPEN arm before opening its own. The seat is spared by this
 * one purge only; the next claim or restart retires the attempt. It must never
 * be reported as "its task stays held". A finalizing orphan has no row left to
 * claim: until a later restart retires it, it refuses only its own worker's
 * next claim.
 */
async function closeOrphanedAttempt(
  state: StateManager,
  attempt: ExecutionAttempt,
  task: Task | null
): Promise<void> {
  const context = {
    attemptId: attempt.id,
    taskId: attempt.taskId,
    workerId: attempt.workerId,
    phase: attempt.phase,
    assignedWorkerId: task ? task.assignedWorkerId : null,
    taskFound: task !== null,
  };
  try {
    await setAttemptPhase(state, attempt.id, 'closed');
    logger.info(context, 'Closed an attempt at startup: its task is missing or no longer assigned to its worker');
  } catch (error) {
    logger.error(
      { ...context, error },
      'Failed to close an orphaned attempt during startup; it keeps its phase but holds no task'
    );
  }
}

/**
 * Close every non-closed attempt of a task. This is the close path for the sites
 * that take a task's seat away outright (release_task, deregister, a claim
 * evicting the previous owner) or the task itself (taskStore.deleteTask), so the
 * rules below exist once. A seat hand-back through taskStore.updateTask, and the
 * seat releases of worker deletion and the startup purge, close through
 * closeHandedBackAttempts instead, which spares `finalizing`. The seat sites
 * write through updateTask first, so their explicit call here finds only what
 * that left open. Returns the records it closed, in generation order.
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
  for (const attempt of storedAttempts(state, taskId)) {
    if (!OPEN_PHASES.has(attempt.phase)) continue;
    closed.push(await setAttemptPhase(state, attempt.id, 'closed'));
  }
  return closed;
}

/** The phases a seat hand-back ends. `finalizing` is deliberately absent. */
const HANDED_BACK_PHASES: ReadonlySet<ExecutionAttemptPhase> = new Set<ExecutionAttemptPhase>([
  'running',
  'reconciling',
]);

/**
 * Close the attempts a seat leaves behind when it hands its task back. Called by
 * taskStore.updateTask on every write that turns a non-null assignedWorkerId
 * into null — qa_reject, report_blocked's seat-freeing arm, set_task_status,
 * unblock_worker's seat-only arm, the sweeps' releases, and every other status
 * change or release that drops the assignee — and directly by the seat releases
 * of worker deletion and the startup purge (which writes around updateTask), so
 * a seat that gave its task up keeps no open execution, and a later restart
 * finds nothing of that seat's to park. Returns the records it closed, in
 * generation order.
 *
 * NARROWER THAN closeOpenAttempts ON PURPOSE: it never closes `finalizing`.
 * complete_task parks its attempt in `finalizing` BEFORE its own WORKING→REVIEW
 * write clears the seat, and that hold is the wrapper's landing boundary. It
 * ends ONLY through: moe.finalize_attempt (its runner, or a governor or human
 * with outcome 'failed'); its own worker's moe.deregister_worker; deletion of
 * its task; a daemon restart that finds its task gone; or removal of its
 * worker's DEAD record (the stale-record prune, the startup purge). No idle
 * signal is on that list: a quiet seat keeps its hold. No later claim of the
 * row supersedes it either — claim_next_task refuses or skips a row another
 * worker's landing holds. Closing it at the seat clear would free the worker for
 * its next task while this task's bytes are still unlanded.
 *
 * Otherwise the closeOpenAttempts contracts hold: idempotent, tolerant of a task
 * with no attempt record, never deletes, and each close goes through
 * setAttemptPhase, so a failed write throws with the attempt still published as
 * open. Caller must hold state.mutex.
 */
export async function closeHandedBackAttempts(
  state: StateManager,
  taskId: string
): Promise<ExecutionAttempt[]> {
  const closed: ExecutionAttempt[] = [];
  for (const attempt of storedAttempts(state, taskId)) {
    if (!HANDED_BACK_PHASES.has(attempt.phase)) continue;
    closed.push(await setAttemptPhase(state, attempt.id, 'closed'));
  }
  return closed;
}

/**
 * Tell the board and parked moe.wait_for_task waiters that a task's finalizing
 * boundary has ended — this store's one deliberate event (see the header).
 * While an attempt is finalizing, claim_next_task refuses or skips its task for
 * every seat but the attempt's own worker, and wait_for_task hides it the same
 * way; closing the attempt writes no task, so without this nothing would tell a
 * waiter the hold lifted.
 *
 * Re-publishes the task exactly as it is: no activity row, no updatedAt change,
 * nothing written. A task that no longer exists announces nothing. Call it only
 * AFTER the close's write has published the closed record, so no subscriber can
 * observe the attempt still open; state.emit isolates subscriber errors, so a
 * failing subscriber never fails the caller.
 */
export function announceAttemptClosed(state: StateManager, taskId: string): void {
  const task = state.getTask(taskId);
  if (!task) return;
  state.emit({ type: 'TASK_UPDATED', payload: task });
}
