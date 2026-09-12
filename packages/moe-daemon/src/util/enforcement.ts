import type { Task, TaskVerification } from '../types/schema.js';
// Type-only: erased at compile time, so the enforcement helpers never pull the
// state layer in at runtime and no import cycle can form through it.
import type { StateManager } from '../state/StateManager.js';
import { currentAttempt, listAttempts, MAX_ATTEMPT_GENERATION } from '../state/attemptStore.js';
import { MoeError, MoeErrorCode, invalidInput, missingRequired } from './errors.js';
import { logger } from './logger.js';

// Deprecation warning dedupe: we log at most once per (task, tool) pair per daemon
// lifetime so a misbehaving client doesn't flood the log. The set is bounded so
// a long-running daemon doesn't accumulate one entry per task forever — Map
// preserves insertion order so we can evict the oldest entry on overflow.
const DEPRECATION_WARN_MAX_ENTRIES = 1000;
const deprecationWarned = new Map<string, true>();
function displayToolName(toolName: string): string {
  if (!toolName || toolName === 'unknown') return 'this tool';
  return toolName.startsWith('moe.') ? toolName : `moe.${toolName}`;
}

function warnMissingWorkerId(taskId: string, tool: string): void {
  const key = `${taskId}:${tool}`;
  if (deprecationWarned.has(key)) return;
  if (deprecationWarned.size >= DEPRECATION_WARN_MAX_ENTRIES) {
    // Evict the oldest insertion (FIFO) — sufficient as an LRU approximation
    // given each key is only ever inserted once.
    const oldest = deprecationWarned.keys().next().value;
    if (oldest !== undefined) deprecationWarned.delete(oldest);
  }
  deprecationWarned.set(key, true);
  logger.warn(
    { taskId, tool },
    'workerId missing — ownership check skipped (legacy-client fallback, will become a hard error in a future release)'
  );
}

/**
 * Reject when task is claimed by a different worker.
 * No-op when task.assignedWorkerId is null (preserves --no-auto-claim + plugin /ws flows)
 * or when caller did not supply a workerId (legacy clients — logs a deprecation warning).
 */
export function assertWorkerOwns(task: Task, workerId: string | undefined, toolName = 'unknown'): void {
  if (!task.assignedWorkerId) return;
  if (!workerId) {
    warnMissingWorkerId(task.id, toolName);
    return;
  }
  if (task.assignedWorkerId === workerId) return;
  throw new MoeError(
    MoeErrorCode.NOT_ALLOWED,
    `Task ${task.id} is claimed by ${task.assignedWorkerId}, not ${workerId}`,
    { taskId: task.id, owner: task.assignedWorkerId, caller: workerId },
    'NOT_ALLOWED'
  );
}

// =============================================================================
// Attempt fencing
// =============================================================================
// assertAttemptCurrent refuses a call from an attempt the daemon has already
// superseded, so a zombie waking after reassignment cannot get a daemon mutation
// recorded against the live attempt (it is inert until a tool handler calls it).
// It sits BESIDE assertWorkerOwns: ownership asks "right seat?", currency asks
// "right execution of that seat?", and existing callers pass no attempt identity.
//
// SCOPE, do not soften: this fences DAEMON MUTATIONS ONLY. A superseded CLI can
// still write to a shared workspace, and nothing here prevents that.

/** What a caller presents about its attempt. Both optional: pre-attempt callers send neither. */
export interface AttemptIdentity {
  attemptId?: string;
  /** Fencing token: a positive safe integer. */
  generation?: number;
}

// Same bounded FIFO dedupe as warnMissingWorkerId, in its OWN map so a flood of
// attempt notices can never evict the ownership guard's entries.
const attemptNoticed = new Map<string, true>();
function firstAttemptNotice(key: string): boolean {
  if (attemptNoticed.has(key)) return false;
  if (attemptNoticed.size >= DEPRECATION_WARN_MAX_ENTRIES) {
    const oldest = attemptNoticed.keys().next().value;
    if (oldest !== undefined) attemptNoticed.delete(oldest);
  }
  attemptNoticed.set(key, true);
  return true;
}

/** Bounded rendering of an untrusted value that cannot throw (no String() on objects). */
function renderUntrusted(value: unknown): string {
  if (value === null) return 'null';
  const kind = typeof value;
  if (kind === 'object' || kind === 'function' || kind === 'symbol') return `a value of type ${kind}`;
  const text = kind === 'string' ? JSON.stringify(value) : String(value);
  return text.length > 40 ? `${text.slice(0, 40)}…` : text;
}

/**
 * Refuse a malformed token, never coerce it (the plan-revision token rule). Checks
 * are `!== undefined`, not truthiness: generation 0 and attemptId '' are falsy but
 * SUPPLIED, and must not fall through to the legacy tolerance.
 */
function validateAttemptIdentity(identity: AttemptIdentity): AttemptIdentity {
  const validated: AttemptIdentity = {};
  const { attemptId, generation } = identity;
  if (attemptId !== undefined) {
    if (typeof attemptId !== 'string' || attemptId.trim() === '') {
      const got = renderUntrusted(attemptId);
      throw invalidInput('attemptIdentity.attemptId', `must be a non-blank string (got ${got})`);
    }
    validated.attemptId = attemptId;
  }
  if (generation !== undefined) {
    // Positive, not merely non-negative: generations start at 1 (schema.ts) and
    // attemptStore refuses a stored value below 1.
    const inDomain = typeof generation === 'number' && Number.isSafeInteger(generation);
    if (!inDomain || generation < 1 || generation > MAX_ATTEMPT_GENERATION) {
      const got = renderUntrusted(generation);
      throw invalidInput('attemptIdentity.generation', `must be a positive safe integer (got ${got})`);
    }
    validated.generation = generation;
  }
  return validated;
}

function describeAttempt(attemptId: string | null, generation: number | null): string {
  if (attemptId === null) return generation === null ? 'none' : `generation ${generation}`;
  return generation === null ? attemptId : `${attemptId} (generation ${generation})`;
}

/**
 * Reject when the caller's attempt is not the CURRENT attempt for this task.
 * Decision order, each part deliberate:
 *  1. No identity (argument absent, or neither field): legacy tolerance, warning
 *     once and only on a claimed task — the assertWorkerOwns/assertContextFetched shape.
 *  2. Validate before use: malformed is invalid input, never a fall-through to 1.
 *  3. NO attempt record for the task: tolerate even with an identity. DO NOT "FIX"
 *     THIS INTO A REFUSAL — a task that never opened an attempt superseded nobody,
 *     and refusing breaks every pre-rollout task once handlers call this guard.
 *     Records that exist but are all CLOSED are refused: that execution is over.
 *  4. EQUALITY, not ordering: a future generation is as wrong as a stale one. Each
 *     presented field is compared to the current attempt, so a self-inconsistent
 *     pair can never pass.
 * No unassigned-task early return (unlike assertWorkerOwns): a caller presenting an
 * identity is an attempt-aware worker, and releasing its task must not let a zombie in.
 * STATE_CONFLICT, not NOT_ALLOWED: a superseded attempt is a state race, not a
 * permission failure. The caller must hold `state.mutex`.
 */
export function assertAttemptCurrent(
  state: StateManager,
  task: Task,
  identity: AttemptIdentity | undefined,
  toolName = 'unknown'
): void {
  const supplied = identity !== undefined && identity !== null;
  if (supplied && (typeof identity !== 'object' || Array.isArray(identity))) {
    throw invalidInput('attemptIdentity', 'must be an object carrying attemptId and/or generation');
  }
  const presented: AttemptIdentity = supplied ? validateAttemptIdentity(identity) : {};
  if (presented.attemptId === undefined && presented.generation === undefined) {
    if (task.assignedWorkerId && firstAttemptNotice(`attempt-missing:${task.id}:${toolName}`)) {
      logger.warn(
        { taskId: task.id, tool: toolName },
        'attempt identity missing — fencing check skipped (legacy-client fallback, will become a hard error once every caller carries an attempt)'
      );
    }
    return;
  }
  if (listAttempts(state, task.id).length === 0) {
    if (firstAttemptNotice(`attempt-unrecorded:${task.id}:${toolName}`)) {
      logger.info(
        { taskId: task.id, tool: toolName, ...presented },
        'task has no attempt record — fencing check skipped (task predates the attempt rollout)'
      );
    }
    return;
  }

  const current = currentAttempt(state, task.id);
  const currentAttemptId = current?.id ?? null;
  const currentGeneration = current?.generation ?? null;
  const callerAttemptId = presented.attemptId ?? null;
  const callerGeneration = presented.generation ?? null;
  const idMatches = callerAttemptId === null || callerAttemptId === currentAttemptId;
  const generationMatches = callerGeneration === null || callerGeneration === currentGeneration;
  if (idMatches && generationMatches) return;
  const currentText = current ? describeAttempt(currentAttemptId, currentGeneration) : 'none (all closed)';
  throw new MoeError(
    MoeErrorCode.STATE_CONFLICT,
    `Superseded attempt refused by ${displayToolName(toolName)} on task ${task.id}: caller presented ` +
      `${describeAttempt(callerAttemptId, callerGeneration)}, current attempt is ${currentText}`,
    { taskId: task.id, currentAttemptId, currentGeneration, callerAttemptId, callerGeneration },
    'ATTEMPT_SUPERSEDED'
  );
}

/**
 * Reject when caller has not previously invoked moe.get_context for this task.
 * No-op when workerId is missing (legacy — logs deprecation) or assignedWorkerId is null (human/plugin path).
 */
export function assertContextFetched(task: Task, workerId: string | undefined, toolName = 'unknown'): void {
  if (!workerId) {
    if (task.assignedWorkerId) warnMissingWorkerId(task.id, toolName);
    return;
  }
  if (!task.assignedWorkerId) return;
  const fetched = Array.isArray(task.contextFetchedBy) ? task.contextFetchedBy : [];
  if (fetched.includes(workerId)) return;
  throw new MoeError(
    MoeErrorCode.NOT_ALLOWED,
    `Call moe.get_context for task ${task.id} before ${displayToolName(toolName)}`,
    { taskId: task.id, workerId },
    'NOT_ALLOWED'
  );
}

/**
 * Reject when the implementation plan still has PENDING or IN_PROGRESS steps.
 */
export function assertAllStepsCompleted(task: Task): void {
  const plan = Array.isArray(task.implementationPlan) ? task.implementationPlan : [];
  // An empty plan must NOT pass vacuously — a task with no recorded steps has no
  // verifiable work and cannot be "completed". Submit a plan first.
  if (plan.length === 0) {
    throw new MoeError(
      MoeErrorCode.NOT_ALLOWED,
      `Cannot complete task ${task.id}: it has no implementation plan. Submit a plan (and execute its steps) before completing.`,
      { taskId: task.id, remaining: 0, totalSteps: 0 },
      'NOT_ALLOWED'
    );
  }
  const remaining = plan.filter(s => s.status !== 'COMPLETED').length;
  if (remaining === 0) return;
  throw new MoeError(
    MoeErrorCode.NOT_ALLOWED,
    `Cannot complete task ${task.id}: ${remaining} step(s) still incomplete`,
    { taskId: task.id, remaining, totalSteps: plan.length },
    'NOT_ALLOWED'
  );
}

/** Upper bound on verification.command — a payload guard, not a style limit. */
export const MAX_VERIFICATION_COMMAND_CHARS = 500;
/** verification.outputTail is truncated (not rejected) past this length. */
export const MAX_VERIFICATION_OUTPUT_CHARS = 2000;

const VERIFICATION_CONTRACT =
  'moe.complete_task requires verification evidence: { command, exitCode, outputTail? }. ' +
  'Run the verification command the plan named (fresh, in the foreground), then report the exact command, ' +
  'its exit code (must be 0), and the tail of its output.';

/**
 * Validate + normalize the verification evidence required by complete_task.
 * A non-zero exit code is rejected outright — completing a task on a failing
 * verification is exactly the claim-without-evidence this gate exists to stop.
 * Returns the object to persist (caller stamps reportedAt).
 */
export function assertVerificationEvidence(
  verification: unknown
): Omit<TaskVerification, 'reportedAt'> {
  if (verification === undefined || verification === null) {
    throw new MoeError(
      MoeErrorCode.MISSING_REQUIRED,
      `Missing required field: verification. ${VERIFICATION_CONTRACT}`,
      { field: 'verification' },
      'MISSING_REQUIRED'
    );
  }
  if (typeof verification !== 'object' || Array.isArray(verification)) {
    throw invalidInput('verification', `must be an object. ${VERIFICATION_CONTRACT}`);
  }
  const v = verification as { command?: unknown; exitCode?: unknown; outputTail?: unknown };
  if (typeof v.command !== 'string' || v.command.trim().length === 0) {
    throw missingRequired('verification.command');
  }
  if (v.command.length > MAX_VERIFICATION_COMMAND_CHARS) {
    throw invalidInput('verification.command', `too long (max ${MAX_VERIFICATION_COMMAND_CHARS} chars)`);
  }
  if (typeof v.exitCode !== 'number' || !Number.isInteger(v.exitCode)) {
    throw invalidInput('verification.exitCode', 'must be an integer exit code');
  }
  if (v.exitCode !== 0) {
    throw invalidInput(
      'verification.exitCode',
      `verification command failed (exit ${v.exitCode}). Fix the failure and re-run the command before completing — do not complete a task on failing verification.`
    );
  }
  if (v.outputTail !== undefined && typeof v.outputTail !== 'string') {
    throw invalidInput('verification.outputTail', 'must be a string');
  }
  const outputTail =
    typeof v.outputTail === 'string' && v.outputTail.length > 0
      ? v.outputTail.slice(-MAX_VERIFICATION_OUTPUT_CHARS)
      : undefined;
  return {
    command: v.command.trim(),
    exitCode: v.exitCode,
    ...(outputTail !== undefined ? { outputTail } : {}),
  };
}
