// =============================================================================
// Shared reopen logic — the SINGLE source of truth for scrubbing a task's
// completion signals when it is sent back to active work from a terminal-ish
// column (REVIEW / DONE / ARCHIVED). Used by every reopen path (the
// moe.set_task_status reopen branch, StateManager.reopenTask, and — for the
// step reset — moe.qa_reject) so they can never diverge again.
// =============================================================================

import type { ImplementationStep, Task } from '../types/schema.js';

/**
 * Reset every step to PENDING and drop its execution evidence (timestamps,
 * note, modifiedFiles) so a reopened plan is genuinely re-run rather than
 * re-submitted as already-complete. Optional keys set to undefined are dropped
 * by sanitizeImplementationPlan / JSON serialization, which is the intended
 * clear-on-persist behavior.
 */
export function resetPlanStepsToPending(plan: ImplementationStep[]): ImplementationStep[] {
  return plan.map((s) => ({
    ...s,
    status: 'PENDING' as const,
    startedAt: undefined,
    completedAt: undefined,
    note: undefined,
    modifiedFiles: undefined,
  }));
}

/**
 * Compute the field updates that invalidate a task's prior completion on reopen:
 *  - clear completedAt / reviewStartedAt / reviewCompletedAt (no longer done)
 *  - strip metrics.doneAt / metrics.wallClockMs (the "finished" markers)
 *  - reset the plan steps to PENDING + clear stepsCompleted (enforced rework;
 *    closes the "all-steps-COMPLETED → vacuous complete_task" hole)
 *  - clear the escalation latches (needsHumanReview / critiqueBlockCount) and
 *    the failed-DoD-item log so the reopened task starts a fresh attempt with a
 *    clean budget (a human reopening a parked task un-parks it; the same-item
 *    net counts only within the new attempt, not across the task's whole life)
 *  - clear contextFetchedBy so whoever re-claims the reopened task is FORCED to
 *    call get_context again (assertContextFetched) — i.e. actually re-read the
 *    rejectionDetails/reopenReason instead of resuming on a stale context stamp
 *    and re-doing the same work the same way
 *
 * Returns a Partial<Task> to be merged into the reopen update payload. Does NOT
 * set status / reopenCount / reopenReason — the caller owns those.
 */
export function buildReopenClearingUpdates(task: Task): Partial<Task> {
  const updates: Partial<Task> = {
    completedAt: undefined,
    reviewStartedAt: undefined,
    reviewCompletedAt: undefined,
    needsHumanReview: undefined,
    critiqueBlockCount: undefined,
    failedDodItems: [],
    contextFetchedBy: [],
  };

  if (task.metrics && (task.metrics.doneAt || task.metrics.wallClockMs)) {
    const { doneAt: _doneAt, wallClockMs: _wallClockMs, ...restMetrics } = task.metrics;
    updates.metrics = restMetrics;
  }

  if (Array.isArray(task.implementationPlan) && task.implementationPlan.length > 0) {
    updates.implementationPlan = resetPlanStepsToPending(task.implementationPlan);
    updates.stepsCompleted = [];
  }

  return updates;
}
