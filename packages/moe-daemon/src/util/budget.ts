// =============================================================================
// Task budget warn / escalate
// =============================================================================
//
// A task budget caps how long (wall-clock) a task may spend between first claim
// and DONE. We don't enforce — we warn. At 80% of budget we post to #governors
// and mark `budget.warnedAt`. At 100% we post again and mark `budget.escalatedAt`.
// Both notifications are idempotent: re-running the check after a mark is set
// does not re-post or re-mutate.
//
// Callers wire this into the hot path (claim_next_task, start_step,
// complete_step) so the check runs naturally whenever workers touch a task.

import type { StateManager } from '../state/StateManager.js';
import type { ProjectSettings, Task } from '../types/schema.js';

/**
 * Default per-step wall-clock pace (15 min/step). When a plan is submitted
 * without an explicit budget, the daemon seeds `budget.wallClockMs` to
 * `steps.length * pacePerStepMs` so the warn/escalate path uses a calibrated
 * cap instead of an arbitrary default.
 */
export const DEFAULT_PACE_PER_STEP_MS = 15 * 60 * 1000;

/**
 * Compute a default wall-clock budget for a plan with `stepCount` steps.
 * Honors `ProjectSettings.pacePerStepMs` override; falls back to
 * DEFAULT_PACE_PER_STEP_MS otherwise. Returns at least one pace unit so
 * single-step plans don't get a zero budget.
 */
export function defaultBudgetForSteps(stepCount: number, settings?: ProjectSettings): number {
  const pace = (settings?.pacePerStepMs && settings.pacePerStepMs > 0)
    ? settings.pacePerStepMs
    : DEFAULT_PACE_PER_STEP_MS;
  const steps = Math.max(1, Math.floor(stepCount));
  return steps * pace;
}

/**
 * Inspect a task's budget vs elapsed time. If thresholds are newly crossed,
 * patch the task and post notifications. Returns the (possibly mutated) Task
 * — callers can keep using the previous reference if the result is the same
 * (no allocation when nothing crosses).
 *
 * Never throws on chat failures; warn/escalate posts are best-effort.
 */
export async function maybeApplyBudgetWarnings(
  state: StateManager,
  task: Task,
  nowMs: number = Date.now()
): Promise<Task> {
  const budget = task.budget;
  if (!budget || typeof budget.wallClockMs !== 'number' || budget.wallClockMs <= 0) {
    return task;
  }
  const firstClaimAt = task.metrics?.firstClaimAt;
  if (!firstClaimAt) return task;

  const startMs = Date.parse(firstClaimAt);
  if (!Number.isFinite(startMs)) return task;
  const elapsed = nowMs - startMs;
  if (elapsed < 0) return task; // clock skew — ignore

  const warnThreshold = 0.8 * budget.wallClockMs;
  const escalateThreshold = budget.wallClockMs;

  const shouldWarn = !budget.warnedAt && elapsed >= warnThreshold;
  const shouldEscalate = !budget.escalatedAt && elapsed >= escalateThreshold;

  if (!shouldWarn && !shouldEscalate) return task;

  const nextBudget = { ...budget };
  const nowIso = new Date(nowMs).toISOString();
  if (shouldWarn) nextBudget.warnedAt = nowIso;
  if (shouldEscalate) nextBudget.escalatedAt = nowIso;

  let updated: Task;
  try {
    updated = await state.updateTask(task.id, { budget: nextBudget });
  } catch {
    // If the write fails (e.g. task was deleted concurrently) we still don't
    // want to crash the hot path — return the original.
    return task;
  }

  // Best-effort notifications. Use a single template per threshold so the
  // chat-watcher / TUI can pattern-match.
  if (shouldEscalate) {
    try {
      await state.postToRoleChannel(
        'governors',
        `⏰ task ${task.id} (${task.title}) crossed 100% budget (${budget.wallClockMs}ms cap; ~${Math.round(elapsed)}ms elapsed)`
      );
    } catch { /* never block */ }
    if (task.assignedWorkerId) {
      try {
        await state.postToGeneral(
          `@${task.assignedWorkerId} ⏰ task ${task.id} crossed 100% budget — please escalate or wrap up.`
        );
      } catch { /* never block */ }
    }
  } else if (shouldWarn) {
    try {
      await state.postToRoleChannel(
        'governors',
        `⏰ task ${task.id} (${task.title}) at 80% budget (${budget.wallClockMs}ms cap; ~${Math.round(elapsed)}ms elapsed)`
      );
    } catch { /* never block */ }
    if (task.assignedWorkerId) {
      try {
        await state.postToGeneral(
          `@${task.assignedWorkerId} ⏰ task ${task.id} at 80% budget — please update on progress.`
        );
      } catch { /* never block */ }
    }
  }

  return updated;
}
