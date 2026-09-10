// =============================================================================
// Task store - task CRUD and lifecycle transitions
// =============================================================================
//
// Extracted verbatim from StateManager. updateTask is the hottest write path in
// the daemon and its statement order is load-bearing: validate and sanitize
// FIRST (so an invalid update throws before anything touches disk), then
// persist, then update the in-memory map, then emit, then append activity.
// Reordering any of those changes what a subscriber sees on a failed write.
//
// The ../tools/* imports below reproduce a PRE-EXISTING state->tools edge that
// came along with the code (submit_plan's SPEED-mode timer and wait_for_task's
// waiter registry). It is why the step-10 cycle guard is scoped to src/state/**.
//
// Calls between public task functions go through `state.` so instance-level
// overrides and test spies still intercept them.

import fs from 'fs';
import path from 'path';
import type { StateManager } from './StateManager.js';
import type { ActivityEventType, Task, TaskComment, TaskPriority, TaskStatus } from '../types/schema.js';
import { logger } from '../util/logger.js';
import { generateId } from '../util/ids.js';
import { invalidInput, MoeError, MoeErrorCode } from '../util/errors.js';
import { sanitizeString, sanitizeStringArray } from '../util/sanitize.js';
import { computeOrderBetween, sortByOrder } from '../util/order.js';
import { buildReopenClearingUpdates } from '../util/reopen.js';
import { cancelSpeedModeTimeout } from '../tools/submitPlan.js';
import { cleanupStaleWaiters } from '../tools/waitForTask.js';
import {
  MAX_COMMENTS_PER_TASK,
  sanitizeImplementationPlan,
  sanitizeStringIdArray,
  trimComments,
} from './validators.js';
import { runDependencyUnblock } from './dependencyUnblock.js';

/** Hard cap on declared dependency ids per task (dependsOn / blockedOnTaskIds). */
export const MAX_TASK_DEPENDENCY_IDS = 20;

const CREATED_BY_VALUES = new Set(['HUMAN', 'WORKER', 'ARCHITECT', 'QA', 'GOVERNOR']);

/**
 * Upper bound of the plan-revision domain — a JS safe integer, which is also
 * what the Kotlin/JSON clients can carry as a Long without truncation.
 */
const MAX_PLAN_REVISION = Number.MAX_SAFE_INTEGER;

/**
 * Read a task's persisted plan revision. An absent stamp is a record written
 * before the field existed and reads as 0. Anything else outside the
 * non-negative safe-integer domain fails CLOSED (no coercion, no reset): a
 * corrupted stamp must not silently pass an approval-freshness comparison.
 */
function decodeStoredPlanRevision(task: Task): number {
  const stored = task.planRevision;
  if (stored === undefined) return 0;
  if (typeof stored !== 'number' || !Number.isSafeInteger(stored) || stored < 0) {
    throw invalidInput(
      'planRevision',
      `stored revision for task ${task.id} is not a non-negative safe integer (got ${String(stored)})`
    );
  }
  return stored;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Structural comparison of two SANITIZED plan/DoD surfaces. Array order is
 * significant (a reordered plan is a different plan), object key insertion
 * order is not (re-serializing the same step is not a mutation). Compares
 * every retained key, so step execution fields and amendment entries count.
 */
function sameSanitizedSurface(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, index) => sameSanitizedSurface(item, b[index]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = Object.keys(a);
    if (keys.length !== Object.keys(b).length) return false;
    return keys.every(
      (key) => Object.prototype.hasOwnProperty.call(b, key) && sameSanitizedSurface(a[key], b[key])
    );
  }
  return false;
}

/**
 * The revision to stamp into this write. Bumps once for a plan submission and
 * once for any write that actually changes the sanitized steps/DoD — a write
 * that does both still advances by one. `undefined` for either field means the
 * caller did not supply it, so it cannot be a change.
 *
 * Error handling: a malformed stored stamp (INVALID_INPUT, via the decode
 * above) and an exhausted counter (STATE_CONFLICT / PLAN_REVISION_EXHAUSTED)
 * both throw BEFORE any persistence, leaving the task exactly as it was.
 */
function derivePlanRevision(
  task: Task,
  updates: Partial<Task>,
  event: ActivityEventType | undefined
): number {
  const current = decodeStoredPlanRevision(task);
  const planChanged =
    updates.implementationPlan !== undefined &&
    !sameSanitizedSurface(updates.implementationPlan, sanitizeImplementationPlan(task.implementationPlan));
  const dodChanged =
    updates.definitionOfDone !== undefined &&
    !sameSanitizedSurface(updates.definitionOfDone, sanitizeStringArray(task.definitionOfDone, 50, 1000));
  if (event !== 'PLAN_SUBMITTED' && !planChanged && !dodChanged) {
    return current;
  }
  if (current >= MAX_PLAN_REVISION) {
    throw new MoeError(
      MoeErrorCode.STATE_CONFLICT,
      `Plan revision for task ${task.id} is exhausted at ${MAX_PLAN_REVISION} and cannot be advanced`,
      { taskId: task.id, currentRevision: current, maxPlanRevision: MAX_PLAN_REVISION },
      'PLAN_REVISION_EXHAUSTED'
    );
  }
  return current + 1;
}

export async function createTask(state: StateManager, input: Partial<Task>): Promise<Task> {
  if (!state.project) {
    throw new Error('Project not loaded');
  }

  if (!input.epicId) {
    throw new Error('epicId is required');
  }

  // Validate epicId exists
  const targetEpic = state.epics.get(input.epicId);
  if (!targetEpic) {
    throw new Error(`Epic not found: ${input.epicId}`);
  }

  // Refuse to add tasks to an archived epic — mirror archive_epic's gate so a
  // shelved epic stays shelved. Un-archive the epic first.
  if (targetEpic.status === 'ARCHIVED') {
    throw new Error(`Epic is ARCHIVED: ${input.epicId} — un-archive the epic first`);
  }

  // Validate and sanitize inputs using centralized sanitization
  const title = sanitizeString(input.title, 'title', 500, 'Untitled task');
  const description = sanitizeString(input.description, 'description', 10000, '');

  // Validate definitionOfDone using centralized sanitization
  let definitionOfDone = sanitizeStringArray(input.definitionOfDone, 50, 1000);
  if (definitionOfDone.length === 0) {
    definitionOfDone = ['Task completed as described'];
  }

  const now = new Date().toISOString();
  const task: Task = {
    id: generateId('task'),
    epicId: input.epicId,
    title,
    description,
    definitionOfDone,
    taskRails: Array.isArray(input.taskRails) ? input.taskRails.slice(0, 100) : [],
    implementationPlan: sanitizeImplementationPlan(input.implementationPlan),
    // Daemon-owned: a new task starts at 0 whatever the caller passed (and
    // whatever initial plan it shipped with) — the first submission is 1.
    planRevision: 0,
    status: input.status || 'BACKLOG',
    assignedWorkerId: input.assignedWorkerId || null,
    branch: input.branch || null,
    prLink: input.prLink || null,
    reopenCount: typeof input.reopenCount === 'number' ? Math.max(0, input.reopenCount) : 0,
    reopenReason: input.reopenReason || null,
    createdBy: CREATED_BY_VALUES.has(input.createdBy as string) ? input.createdBy! : 'HUMAN',
    parentTaskId: input.parentTaskId || null,
    ...(Array.isArray(input.dependsOn) && input.dependsOn.length > 0
      ? { dependsOn: sanitizeStringIdArray(input.dependsOn).slice(0, MAX_TASK_DEPENDENCY_IDS) }
      : {}),
    priority: (['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'].includes(input.priority as string) ? input.priority : 'MEDIUM') as TaskPriority,
    order: input.order ?? state.nextTaskOrder(input.epicId),
    comments: trimComments(Array.isArray(input.comments) ? input.comments : []),
    hasPendingQuestion: false,
    createdAt: now,
    updatedAt: now
  };

  await state.writeEntity('tasks', task.id, task);
  state.tasks.set(task.id, task);
  state.appendActivity('TASK_CREATED', { title: task.title }, task);
  state.emit({ type: 'TASK_CREATED', payload: task });

  if (task.status === 'PLANNING') {
    const planAnnouncement = `📋 New plan needed: ${task.title} (${task.id}) — claim with moe.claim_next_task {workerId, statuses:["PLANNING"]}`;
    state.postToRoleChannel('architects', planAnnouncement).catch(() => {});
    state.postToRoleChannel('governors', planAnnouncement).catch(() => {});
  }

  return task;
}

export async function updateTask(state: StateManager, taskId: string, updates: Partial<Task>, event?: ActivityEventType, actorWorkerId?: string): Promise<Task> {
  const task = state.tasks.get(taskId);
  if (!task) {
    throw new Error(`Task not found: ${taskId}`);
  }

  // Sanitize provided fields (B27)
  const sanitized: Partial<Task> = { ...updates };
  // Identity hardening: never let a client-supplied UPDATE_TASK overwrite the
  // immutable id/createdAt. A changed id would diverge the map key from the
  // on-disk filename (map keyed by taskId, written to `${taskId}.json`).
  delete (sanitized as Record<string, unknown>).id;
  delete (sanitized as Record<string, unknown>).createdAt;
  // planRevision is derived below from what this write actually changes. Strip
  // any caller-supplied value (MCP tool, plugin UPDATE_TASK) so a client can
  // neither forge a newer stamp nor reset an older one.
  delete (sanitized as Record<string, unknown>).planRevision;
  if (sanitized.title !== undefined) {
    sanitized.title = sanitizeString(sanitized.title, 'title', 500);
  }
  if (sanitized.description !== undefined) {
    sanitized.description = sanitizeString(sanitized.description, 'description', 10000);
  }
  if (sanitized.priority !== undefined) {
    if (!['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'].includes(sanitized.priority)) {
      throw new Error(`Invalid priority: ${sanitized.priority}`);
    }
  }
  if (sanitized.reopenCount !== undefined) {
    if (typeof sanitized.reopenCount !== 'number' || sanitized.reopenCount < 0 || !Number.isInteger(sanitized.reopenCount)) {
      throw new Error('reopenCount must be a non-negative integer');
    }
  }
  if (sanitized.definitionOfDone !== undefined) {
    sanitized.definitionOfDone = sanitizeStringArray(sanitized.definitionOfDone, 50, 1000);
  }
  if (sanitized.implementationPlan !== undefined) {
    sanitized.implementationPlan = sanitizeImplementationPlan(sanitized.implementationPlan);
  }
  if (sanitized.contextFetchedBy !== undefined) {
    sanitized.contextFetchedBy = sanitizeStringIdArray(sanitized.contextFetchedBy);
  }
  if (sanitized.stepsCompleted !== undefined) {
    sanitized.stepsCompleted = sanitizeStringIdArray(sanitized.stepsCompleted);
  }
  // Dependency id arrays: dedupe/trim like every other id array, capped. A
  // null blockedOnTaskIds is the sanctioned "clear" (the unblock paths write
  // it); dependsOn is cleared with [].
  if (sanitized.dependsOn !== undefined) {
    sanitized.dependsOn = sanitizeStringIdArray(sanitized.dependsOn).slice(0, MAX_TASK_DEPENDENCY_IDS);
  }
  if (sanitized.blockedOnTaskIds !== undefined && sanitized.blockedOnTaskIds !== null) {
    sanitized.blockedOnTaskIds = sanitizeStringIdArray(sanitized.blockedOnTaskIds).slice(0, MAX_TASK_DEPENDENCY_IDS);
  }

  const hasCommentsUpdate = Object.prototype.hasOwnProperty.call(sanitized, 'comments');
  let normalizedUpdates: Partial<Task> = sanitized;
  if (hasCommentsUpdate) {
    const rawComments = (sanitized as Partial<Task> & { comments?: TaskComment[] | null }).comments;
    const rawCommentCount = Array.isArray(rawComments) ? rawComments.length : 0;
    const trimmedComments = trimComments(rawComments);
    if (rawCommentCount > trimmedComments.length) {
      logger.info(
        {
          taskId,
          rawCommentCount,
          trimmedCommentCount: trimmedComments.length,
          droppedCommentCount: rawCommentCount - trimmedComments.length,
          maxCommentsPerTask: MAX_COMMENTS_PER_TASK,
        },
        'Trimmed task comments to configured maximum'
      );
    }
    normalizedUpdates = { ...sanitized, comments: trimmedComments };
  }

  // Optimistic concurrency check: prevent double-assignment
  if (normalizedUpdates.assignedWorkerId && normalizedUpdates.assignedWorkerId !== task.assignedWorkerId) {
    // Re-read from in-memory map to catch races
    const freshTask = state.tasks.get(taskId);
    if (freshTask && freshTask.assignedWorkerId && freshTask.assignedWorkerId !== normalizedUpdates.assignedWorkerId) {
      throw new Error(`Task already assigned to ${freshTask.assignedWorkerId}`);
    }
  }

  // Clear assignedWorkerId on any status change unless the caller explicitly sets a new one.
  // When a task moves between columns, a different agent role should claim it.
  const statusChanged = normalizedUpdates.status !== undefined && normalizedUpdates.status !== task.status;
  const shouldClearWorker = statusChanged && normalizedUpdates.assignedWorkerId === undefined;
  const finalUpdates = shouldClearWorker
    ? { ...normalizedUpdates, assignedWorkerId: null }
    : normalizedUpdates;

  // Derive the plan revision from the sanitized surface, BEFORE any write, so a
  // malformed stored stamp or an exhausted counter refuses the whole update
  // instead of persisting half of it. The stamp travels in the same fresh Task
  // object — and therefore the same writeEntity call — as the plan/DoD it
  // versions, so a reader can never see one without the other.
  const planRevision = derivePlanRevision(task, finalUpdates, event);

  const updated: Task = {
    ...task,
    ...finalUpdates,
    planRevision,
    updatedAt: new Date().toISOString()
  };

  await state.writeEntity('tasks', taskId, updated);
  state.tasks.set(taskId, updated);

  // When a status change drops the task's worker pointer, also release the
  // prior owner: clear its currentTaskId so the two-pointer ownership can't
  // dangle, and flip a task-bound status back to IDLE so the worker is free
  // to claim next (the one-task-per-worker guard keys on task assignment,
  // but a worker left CODING with no task reads as stuck on every board).
  // BLOCKED stays (owned by the report_blocked/unblock flow), DEAD stays
  // (never resurrect), GOVERNING stays (not task-bound).
  if (shouldClearWorker && task.assignedWorkerId) {
    const priorOwner = state.workers.get(task.assignedWorkerId);
    if (priorOwner && priorOwner.currentTaskId === taskId) {
      const TASK_BOUND = new Set(['READING_CONTEXT', 'PLANNING', 'AWAITING_APPROVAL', 'CODING']);
      await state.updateWorker(priorOwner.id, {
        currentTaskId: null,
        ...(TASK_BOUND.has(priorOwner.status) ? { status: 'IDLE' as const } : {}),
      });
    }
  }

  // actorWorkerId is threaded from the tool that knows who called it. Without
  // it every task event was written with no actor and the per-worker audit
  // trail was empty; see appendActivity for why we do not guess the assignee.
  if (event) {
    state.appendActivity(event, updates, updated, undefined, undefined, undefined, actorWorkerId);
  } else {
    state.appendActivity('TASK_UPDATED', updates, updated, undefined, undefined, undefined, actorWorkerId);
  }
  state.emit({ type: 'TASK_UPDATED', payload: updated });

  // Post system message for status changes
  if (updates.status && updates.status !== task.status) {
    const actor = updated.assignedWorkerId || 'unknown';
    state.postSystemMessage(taskId, `Task moved to ${updates.status} by ${actor}`).catch(() => {});

    // When a task lands on PLANNING, ping #architects so an architect on
    // wait_for_task sees it and can claim. Also cross-post to #governors so
    // the governor's chat_wait surfaces the event (informational — governor
    // never claims PLANNING tasks themselves).
    if (updates.status === 'PLANNING') {
      const planAnnouncement = `📋 New plan needed: ${updated.title} (${updated.id}) — claim with moe.claim_next_task {workerId, statuses:["PLANNING"]}`;
      state.postToRoleChannel('architects', planAnnouncement).catch(() => {});
      state.postToRoleChannel('governors', planAnnouncement).catch(() => {});
    }

    // Dependency auto-unblock: a task landing DONE/ARCHIVED may be the last
    // unmet prerequisite of a BLOCKED row. Single hook — every terminal
    // transition (qa_approve, set_task_status, archive_task/epic, board)
    // funnels through this function. runDependencyUnblock never throws and
    // guards its own re-entrancy; the restores it performs are ordinary
    // updateTask calls whose events wake wait_for_task waiters.
    if (updated.status === 'DONE' || updated.status === 'ARCHIVED') {
      try {
        await runDependencyUnblock(state, updated.id);
      } catch (error) {
        logger.warn({ taskId: updated.id, error }, 'Dependency unblock scan failed after terminal transition');
      }
    }
  }

  return updated;
}

export async function deleteTask(state: StateManager, taskId: string): Promise<Task> {
  const task = state.tasks.get(taskId);
  if (!task) {
    throw new Error(`Task not found: ${taskId}`);
  }

  try {
    cancelSpeedModeTimeout(taskId);
  } catch (error) {
    logger.warn({ taskId, error }, 'Failed to cancel speed mode timeout while deleting task');
  }

  const filePath = path.join(state.moePath, 'tasks', `${taskId}.json`);
  try {
    if (fs.existsSync(filePath)) {
      // Suppress the watcher echo so our own delete doesn't re-trigger load().
      state.fileWatcher?.ignorePath(filePath);
      fs.unlinkSync(filePath);
    }
  } catch (error) {
    const fsError = error as NodeJS.ErrnoException;
    if (fsError.code !== 'ENOENT') {
      throw error;
    }
  }

  state.tasks.delete(taskId);

  // Clear orphaned parentTaskId references (B30)
  for (const t of state.tasks.values()) {
    if (t.parentTaskId === taskId) {
      try {
        const updated = { ...t, parentTaskId: null, updatedAt: new Date().toISOString() };
        state.tasks.set(t.id, updated);
        await state.writeEntity('tasks', t.id, updated);
      } catch (error) {
        logger.warn({ taskId: t.id, parentTaskId: taskId, error }, 'Failed to clear orphaned parentTaskId');
      }
    }
  }

  for (const worker of state.workers.values()) {
    if (worker.currentTaskId === taskId) {
      await state.updateWorker(worker.id, { currentTaskId: null, status: 'IDLE' });
    }
  }

  state.appendActivity('TASK_DELETED', { title: task.title }, task);
  state.emit({ type: 'TASK_DELETED', payload: task });
  return task;
}

export async function approveTask(state: StateManager, taskId: string): Promise<Task> {
  // NOTE: callers MUST hold the StateManager mutex (e.g. via
  // WebSocketServer.withMutex / state.runExclusive) so that the status
  // re-check and updateTask happen atomically. The mutex is non-reentrant,
  // so this method does not acquire it directly.
  const task = state.getTask(taskId);
  if (!task) throw new Error(`Task not found: ${taskId}`);
  if (task.status !== 'AWAITING_APPROVAL') {
    throw new Error(`Cannot approve task in ${task.status} status, must be AWAITING_APPROVAL`);
  }
  cancelSpeedModeTimeout(taskId);
  const updated = await state.updateTask(taskId, { status: 'WORKING', planApprovedAt: new Date().toISOString() }, 'PLAN_APPROVED');
  return updated;
}

export async function rejectTask(state: StateManager, taskId: string, reason: string): Promise<Task> {
  const task = state.getTask(taskId);
  if (!task) throw new Error(`Task not found: ${taskId}`);
  if (task.status !== 'AWAITING_APPROVAL') {
    throw new Error(`Cannot reject task in ${task.status} status, must be AWAITING_APPROVAL`);
  }
  cancelSpeedModeTimeout(taskId);
  const updated = await state.updateTask(
    taskId,
    { status: 'PLANNING', reopenReason: reason },
    'PLAN_REJECTED'
  );
  return updated;
}

export async function reopenTask(state: StateManager, taskId: string, reason: string): Promise<Task> {
  const task = state.getTask(taskId);
  if (!task) throw new Error(`Task not found: ${taskId}`);
  if (task.status !== 'DONE' && task.status !== 'REVIEW') {
    throw new Error(`Cannot reopen task in ${task.status} status, must be DONE or REVIEW`);
  }
  const updated = await state.updateTask(
    taskId,
    {
      status: 'BACKLOG',
      reopenCount: task.reopenCount + 1,
      reopenReason: reason,
      // Scrub completion signals + reset steps via the same shared helper the
      // MCP set_task_status reopen path uses, so this plugin path can't leave
      // a reopened task advertising stale "done" data / all-COMPLETED steps.
      ...buildReopenClearingUpdates(task),
    },
    'TASK_REOPENED'
  );
  return updated;
}

export async function reorderTask(state: StateManager, taskId: string, beforeId: string | null, afterId: string | null): Promise<Task> {
  const task = state.getTask(taskId);
  if (!task) throw new Error(`Task not found: ${taskId}`);

  const prev = beforeId ? state.getTask(beforeId)?.order ?? null : null;
  const next = afterId ? state.getTask(afterId)?.order ?? null : null;
  const order = computeOrderBetween(prev, next);
  const updated = { ...task, order, updatedAt: new Date().toISOString() };

  await state.writeEntity('tasks', taskId, updated);
  state.tasks.set(taskId, updated);
  state.appendActivity('TASK_UPDATED', { order }, updated);
  state.emit({ type: 'TASK_UPDATED', payload: updated });
  return updated;
}

export function nextTaskOrder(state: StateManager, epicId: string): number {
  const tasks = Array.from(state.tasks.values()).filter((t) => t.epicId === epicId);
  if (tasks.length === 0) return 1;
  return Math.max(...tasks.map((t) => t.order)) + 1;
}
