import type { Task, TaskVerification } from '../types/schema.js';
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
