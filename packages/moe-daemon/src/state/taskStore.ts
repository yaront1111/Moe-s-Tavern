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
    status: input.status || 'BACKLOG',
    assignedWorkerId: input.assignedWorkerId || null,
    branch: input.branch || null,
    prLink: input.prLink || null,
    reopenCount: typeof input.reopenCount === 'number' ? Math.max(0, input.reopenCount) : 0,
    reopenReason: input.reopenReason || null,
    createdBy: input.createdBy === 'WORKER' ? 'WORKER' : 'HUMAN',
    parentTaskId: input.parentTaskId || null,
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

export async function updateTask(state: StateManager, taskId: string, updates: Partial<Task>, event?: ActivityEventType): Promise<Task> {
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

  const updated: Task = {
    ...task,
    ...finalUpdates,
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

  if (event) {
    state.appendActivity(event, updates, updated);
  } else {
    state.appendActivity('TASK_UPDATED', updates, updated);
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
