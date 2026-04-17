import type { Task } from '../types/schema.js';
import { MoeError, MoeErrorCode } from './errors.js';
import { logger } from './logger.js';

// Deprecation warning dedupe: we log at most once per (task, tool) pair per daemon
// lifetime so a misbehaving client doesn't flood the log.
const deprecationWarned = new Set<string>();
function warnMissingWorkerId(taskId: string, tool: string): void {
  const key = `${taskId}:${tool}`;
  if (deprecationWarned.has(key)) return;
  deprecationWarned.add(key);
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
    { taskId: task.id, owner: task.assignedWorkerId, caller: workerId }
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
    `Call moe.get_context for task ${task.id} before moe.start_step`,
    { taskId: task.id, workerId }
  );
}

/**
 * Reject when the implementation plan still has PENDING or IN_PROGRESS steps.
 */
export function assertAllStepsCompleted(task: Task): void {
  const plan = Array.isArray(task.implementationPlan) ? task.implementationPlan : [];
  const remaining = plan.filter(s => s.status !== 'COMPLETED').length;
  if (remaining === 0) return;
  throw new MoeError(
    MoeErrorCode.NOT_ALLOWED,
    `Cannot complete task ${task.id}: ${remaining} step(s) still incomplete`,
    { taskId: task.id, remaining, totalSteps: plan.length }
  );
}
