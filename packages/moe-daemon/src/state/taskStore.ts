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
import type { ActivityEventType, ExecutionPolicySnapshot, PlanReuseRecord, RequiredCheckSnapshot, Task, TaskComment, TaskPriority, TaskStatus } from '../types/schema.js';
import {
  assertExecutionProfileReady,
  readExecutionPolicySnapshot,
  resolveTaskExecutionProfile,
} from '../delivery/executionProfile.js';
import { captureExecutionPolicySnapshot } from '../delivery/policy.js';
import { readPlanningEntry, readPlanSourceBasis, validatePlanReuseRecord } from '../context/planReuseState.js';
import { logger } from '../util/logger.js';
import { generateId } from '../util/ids.js';
import { invalidInput, MoeError, MoeErrorCode } from '../util/errors.js';
import { sanitizeString, sanitizeStringArray } from '../util/sanitize.js';
import { effectiveStepDescription } from '../util/planAmendments.js';
import { computeOrderBetween, sortByOrder } from '../util/order.js';
import { buildReopenClearingUpdates } from '../util/reopen.js';
import { nonHolderFinalizingRefusal } from '../util/claimGuards.js';
import { cancelSpeedModeTimeout } from '../tools/submitPlan.js';
import { cleanupStaleWaiters } from '../tools/waitForTask.js';
import {
  MAX_COMMENTS_PER_TASK,
  validateExecutionContract,
  sanitizeImplementationPlan,
  sanitizeStringIdArray,
  trimComments,
} from './validators.js';
import { runDependencyUnblock } from './dependencyUnblock.js';
import { closeHandedBackAttempts, closeOpenAttempts, listAttempts } from './attemptStore.js';
import { nextStatusForRelease } from './workerLifecycle.js';

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
export function decodeStoredPlanRevision(task: Task): number {
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

/**
 * Validate a CALLER-SUPPLIED approval token. Typed `unknown` on purpose: it
 * arrives from an untyped /ws payload, so this is the one place that decides
 * what a token is. Error handling contract: only a non-negative safe integer
 * passes; null, strings, booleans, fractional, negative, unsafe and non-finite
 * values throw INVALID_INPUT. Never coerce, and never degrade a malformed
 * token into an unchecked approval — that would turn a typo into one.
 */
function decodeSuppliedPlanRevision(value: unknown, taskId: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw invalidInput(
      'expectedPlanRevision',
      `approval token for task ${taskId} must be a non-negative safe integer (got ${String(value)}); ` +
        'send the plan revision the approver reviewed'
    );
  }
  return value;
}

function planRevisionMismatch(taskId: string, supplied: number, current: number): MoeError {
  return new MoeError(
    MoeErrorCode.STATE_CONFLICT,
    `Plan for task ${taskId} changed since it was reviewed (approved revision ${supplied}, current revision ${current}). ` +
      'Re-open the plan, review the current revision and approve again.',
    { taskId, expectedPlanRevision: supplied, currentPlanRevision: current },
    'PLAN_REVISION_MISMATCH'
  );
}

/**
 * The approvedPlanRevision an approval write stamps: the revision a human
 * reviewed (PLAN_APPROVED) or a SPEED/TURBO submission committed
 * (PLAN_AUTO_APPROVED), only if it equals the revision this same write commits,
 * so a delayed approval can never authorize a newer plan, DoD or contract. Error handling:
 * INVALID_INPUT for a malformed value, STATE_CONFLICT / PLAN_REVISION_MISMATCH
 * for any other; both throw before any write.
 */
function checkedApprovalRevision(taskId: string, reviewed: unknown, planRevision: number): number {
  const supplied = decodeSuppliedPlanRevision(reviewed, taskId);
  if (supplied !== planRevision) throw planRevisionMismatch(taskId, supplied, planRevision);
  return supplied;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Compare only the instructions and scope that approval authorizes. Sanitizing
 * both sides preserves the existing input bounds; execution evidence and
 * amendment audit/history fields never enter this projection. DoD and the
 * execution contract are compared separately as part of the approval surface.
 */
function approvalPlanSurface(plan: unknown) {
  return sanitizeImplementationPlan(plan).map(step => ({
    stepId: step.stepId,
    originalDescription: step.description,
    effectiveDescription: effectiveStepDescription(step),
    affectedFiles: step.affectedFiles,
    newFiles: step.newFiles ?? [],
  }));
}

/**
 * Structural comparison of canonical plan/DoD/contract surfaces. Array order remains
 * significant; object key insertion order is not a material change.
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
 * once for any write that changes the canonical approval surface/DoD/contract.
 * Combined changes still advance by one. Undefined plan/DoD means unsupplied;
 * an own contract key (even undefined) explicitly replaces or clears it.
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
    !sameSanitizedSurface(approvalPlanSurface(updates.implementationPlan), approvalPlanSurface(task.implementationPlan));
  const dodChanged =
    updates.definitionOfDone !== undefined &&
    !sameSanitizedSurface(updates.definitionOfDone, sanitizeStringArray(task.definitionOfDone, 50, 1000));
  const contractChanged =
    Object.prototype.hasOwnProperty.call(updates, 'executionContract') &&
    !sameSanitizedSurface(updates.executionContract, task.executionContract);
  if (event !== 'PLAN_SUBMITTED' && !planChanged && !dodChanged && !contractChanged) {
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

/**
 * The executionPolicySnapshot a plan submission stores: configuration identity
 * only, never approval, readiness or runner trust. A stored verified-local
 * snapshot is the floor and is kept whole (version, profile and captured
 * deliveryPolicy); only planRevision advances, so neither a project rollback
 * nor a stale revision can downgrade it or fill a v1 one in. There is no policy
 * ranking: anything else captures the live settings. Today the strict
 * progression check refuses every verified-local submission before this runs.
 *
 * Error handling: a malformed stored snapshot or malformed live settings throw
 * INVALID_INPUT, so the submission is refused before any write.
 */
export function planSubmissionSnapshot(
  settings: { executionProfile?: unknown; deliveryPolicy?: unknown } | null | undefined,
  stored: unknown,
  planRevision: number
): ExecutionPolicySnapshot {
  const prior = readExecutionPolicySnapshot(stored);
  const captured = captureExecutionPolicySnapshot(settings, planRevision);
  if (prior?.profile !== 'verified-local') return captured;
  return readExecutionPolicySnapshot({ ...prior, planRevision }) as ExecutionPolicySnapshot;
}

/**
 * Lifecycle rank. A Map, so only its own entries rank: a hand-edited status
 * such as 'constructor' can never rank through an inherited key. BLOCKED and
 * ARCHIVED are never progression targets.
 */
const PROGRESSION_RANK: ReadonlyMap<TaskStatus, number> = new Map<TaskStatus, number>([
  ['BACKLOG', 0],
  ['PLANNING', 1],
  ['AWAITING_APPROVAL', 2],
  ['WORKING', 3],
  ['REVIEW', 4],
  ['DONE', 5],
]);

/** A BLOCKED row stands at its recorded blockedFromStatus; ARCHIVED, an unrecorded block or an unknown status at 0. */
function standing(task: Task): number {
  const at = task.status === 'BLOCKED' ? task.blockedFromStatus : task.status;
  return at ? PROGRESSION_RANK.get(at) ?? 0 : 0;
}

/**
 * Every plan submission is a new progression, and so is a status change to a
 * ranked target above where the row stands. A release is not: the stored row
 * holds a seat, the caller's own update clears it, and the target is exactly
 * nextStatusForRelease (an all-done WORKING row lands in REVIEW). Pass the
 * caller's update, never finalUpdates: that clears the seat on every status
 * change, so each complete_task would look like a hand-back.
 */
function isNewProgression(
  task: Task,
  callerUpdates: Partial<Task>,
  nextStatus: TaskStatus,
  event: ActivityEventType | undefined
): boolean {
  if (event === 'PLAN_SUBMITTED') return true;
  const target = nextStatus === task.status ? undefined : PROGRESSION_RANK.get(nextStatus);
  if (target === undefined || target <= standing(task)) return false;
  const release = Boolean(task.assignedWorkerId)
    && callerUpdates.assignedWorkerId === null
    && nextStatus === nextStatusForRelease(task);
  return !release;
}

/**
 * The strict-progression backstop, run before any write. It grants nothing:
 * passing is not approval, readiness or trust. Only a new progression decodes
 * anything, so reads, metadata, progress, assignment and cleanup/release never
 * touch the snapshot and a bad record cannot wedge them. The profile is the
 * live one floored by a stored verified-local snapshot, stale revision or not.
 * Claim admission and waiters belong to CQ-M01e.
 *
 * Error handling: a malformed snapshot or setting throws INVALID_INPUT and
 * verified-local throws EXECUTION_PROFILE_NOT_READY, both before any write.
 */
function assertProgressionReady(
  state: StateManager,
  task: Task,
  callerUpdates: Partial<Task>,
  nextStatus: TaskStatus,
  event: ActivityEventType | undefined
): void {
  if (!isNewProgression(task, callerUpdates, nextStatus, event)) return;
  assertExecutionProfileReady(resolveTaskExecutionProfile(state.project?.settings, task.executionPolicySnapshot));
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
    // Built field by field, so a caller's executionPolicySnapshot is never
    // copied either: the first plan submission captures it.
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

  // A row created past BACKLOG is a new progression. It has no snapshot yet,
  // so the live profile decides, before any write.
  if ((PROGRESSION_RANK.get(task.status) ?? 0) > 0) {
    assertExecutionProfileReady(resolveTaskExecutionProfile(state.project.settings));
  }

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

/**
 * Close on hand-back. A write that turned a non-null assignedWorkerId into null
 * gave that seat up, so the seat's execution ends here too — at the one
 * chokepoint every hand-back already shares, whether it cleared the seat through
 * the status-change cascade or wrote an explicit null with no status change
 * (qa_reject's park, unblock_worker's seat-only arm, the sweeps' releases, a
 * claim handing back a seat it could not record). Keyed on the before and after
 * assignment, never on shouldClearWorker, which is false for exactly those
 * explicit-null writes. A claim (null to worker), a kept seat and a same-worker
 * write close nothing, and `finalizing` survives by construction
 * (closeHandedBackAttempts spares it): complete_task's own REVIEW write clears
 * its seat while that landing hold is still open.
 *
 * Logged, never thrown: the task write is already durable, so failing the tool
 * now would report an error for a hand-back that happened. The leftover is
 * benign — the next claim of the row closes it before opening its own, and a
 * restart closes a running attempt whose seat no longer holds its task.
 */
async function closeAttemptsOnHandBack(state: StateManager, before: Task, after: Task): Promise<void> {
  if (!before.assignedWorkerId || after.assignedWorkerId) return;
  try {
    await closeHandedBackAttempts(state, after.id);
  } catch (error) {
    logger.error(
      { taskId: after.id, previousWorkerId: before.assignedWorkerId, error },
      'Failed to close the attempt of a handed-back task; the next claim of the row closes it'
    );
  }
}

/**
 * A terminal column may not strand a landing hold. While the task has a
 * finalizing attempt (complete_task's landing, not yet acknowledged), a move
 * into DONE or ARCHIVED is refused with the retryable ATTEMPT_FINALIZING that
 * claimGuards.nonHolderFinalizingRefusal builds, the non-holder refusal
 * qa_approve raises too: nothing ever claims a terminal row, so the hold on it
 * and on its runner's next claim would never end. Only those two columns — a
 * reopen leaves a claimable row whose hold still ends normally. Throws, writes
 * nothing.
 */
export function assertNoFinalizingAttempt(state: StateManager, taskId: string): void {
  const finalizing = listAttempts(state, taskId).find((a) => a.phase === 'finalizing');
  if (!finalizing) return;
  throw nonHolderFinalizingRefusal(
    {
      attemptId: finalizing.id,
      generation: finalizing.generation,
      taskId: finalizing.taskId,
      workerId: finalizing.workerId,
    },
    'moving this task into DONE or ARCHIVED'
  );
}

export async function updateTask(
  state: StateManager, taskId: string, updates: Partial<Task>, event?: ActivityEventType, actorWorkerId?: string,
  daemonOwned?: { requiredCheckSnapshot?: RequiredCheckSnapshot; approvedPlanRevision?: number;
    planSourceBasis?: { commit: string }; planReuse?: PlanReuseRecord },
): Promise<Task> {
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
  // The approval stamp is daemon-owned too: only the daemonOwned argument below
  // writes it, so no caller may forge, null or erase it.
  delete sanitized.approvedPlanRevision;
  // executionPolicySnapshot is daemon-owned as well: only the PLAN_SUBMITTED
  // capture below writes it, so no caller (MCP tool, plugin UPDATE_TASK, a
  // board echo of the whole row) may forge, reset, null or erase it. Deleting
  // the key also keeps an own-key undefined out of the merged row.
  delete (sanitized as Record<string, unknown>).executionPolicySnapshot;
  // Protected file identity has the same ownership: only submit_plan's internal
  // parameter may set/clear it. StateManager's public update signature omits it.
  delete sanitized.requiredCheckSnapshot;
  // Plan-reuse state is daemon-owned: submit_plan's basis (PLAN_SUBMITTED),
  // the PLANNING-entry stamp below and the daemonOwned reuse record are its
  // only writers. A caller value, null included, never reaches the row.
  delete sanitized.planSourceBasis;
  delete sanitized.planningEntry;
  delete sanitized.planReuse;
  // Refused before any write: nothing is persisted, mapped or emitted.
  const reuse = daemonOwned?.planReuse === undefined ? undefined : validatePlanReuseRecord(daemonOwned.planReuse);
  if (Object.prototype.hasOwnProperty.call(sanitized, 'executionContract')) {
    sanitized.executionContract = validateExecutionContract(sanitized.executionContract);
  }
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

  // Every terminal transition funnels through here (set_task_status,
  // archive_task, archive_epic, the board's UPDATE_TASK and ARCHIVE_DONE_TASKS),
  // so this one guard keeps all of them from shelving a landing hold. Before any
  // write, so a refusal changes nothing.
  if (statusChanged && (normalizedUpdates.status === 'DONE' || normalizedUpdates.status === 'ARCHIVED')) {
    assertNoFinalizingAttempt(state, taskId);
  }
  // Strict readiness, also before any write (and before the capture below).
  assertProgressionReady(state, task, normalizedUpdates, normalizedUpdates.status ?? task.status, event);
  // A strict profile may not approve unchecked. Behind the readiness gate
  // above, which still refuses every verified-local progression. Automatic
  // approvals always carry the revision their submission committed (CQ-F05).
  const reviewed = event === 'PLAN_APPROVED' || event === 'PLAN_AUTO_APPROVED' ? daemonOwned?.approvedPlanRevision : undefined;
  if (event === 'PLAN_APPROVED' && reviewed === undefined &&
    resolveTaskExecutionProfile(state.project?.settings, task.executionPolicySnapshot) === 'verified-local') {
    throw invalidInput('expectedPlanRevision', `approval of task ${taskId} under verified-local must name the reviewed plan revision`);
  }

  // Derive the plan revision from the sanitized surface, BEFORE any write, so a
  // malformed stored stamp or an exhausted counter refuses the whole update
  // instead of persisting half of it. The stamp travels in the same fresh Task
  // object — and therefore the same writeEntity call — as the plan/DoD it
  // versions, so a reader can never see one without the other.
  const planRevision = derivePlanRevision(task, finalUpdates, event);
  // Only a plan submission captures the snapshot (planSubmissionSnapshot). It
  // rides in the same fresh object, and so the same writeEntity, as the
  // revision it names: a refused or failed write publishes neither. Approval
  // writes never capture.
  const capture = event === 'PLAN_SUBMITTED'
    ? { executionPolicySnapshot: planSubmissionSnapshot(state.project?.settings, task.executionPolicySnapshot, planRevision) }
    : {};
  // The reviewed revision rides in the same image as the approval it records.
  // Without one the field is untouched: an older number stays as history.
  const stamp = reviewed === undefined
    ? {}
    : { approvedPlanRevision: checkedApprovalRevision(taskId, reviewed, planRevision) };
  // The commit the submitted plan was measured against, with the revision this write commits.
  const basis = event === 'PLAN_SUBMITTED' && daemonOwned?.planSourceBasis
    ? readPlanSourceBasis({ planSourceBasis: { version: 1, commit: daemonOwned.planSourceBasis.commit, planRevision } })
    : undefined;
  if (basis === null) throw invalidInput('planSourceBasis', 'commit must be 40 or 64 lowercase hex');

  const now = new Date().toISOString();
  const updated: Task = {
    ...task,
    ...finalUpdates,
    planRevision,
    ...capture,
    ...stamp,
    updatedAt: now
  };
  if (event === 'PLAN_SUBMITTED' && daemonOwned) {
    if (daemonOwned.requiredCheckSnapshot) updated.requiredCheckSnapshot = daemonOwned.requiredCheckSnapshot;
    else delete updated.requiredCheckSnapshot;
    if (basis) updated.planSourceBasis = basis;
    else delete updated.planSourceBasis;
  }
  if (reuse) updated.planReuse = reuse;
  // How the task last entered PLANNING. Judged on the STORED row: an unblock
  // nulls blockedFromStatus in this same update, and a return from a block
  // taken in PLANNING is not a new entry.
  if (statusChanged && finalUpdates.status === 'PLANNING'
    && !(task.status === 'BLOCKED' && task.blockedFromStatus === 'PLANNING')) {
    const prior = readPlanningEntry(task)?.seq ?? 0;
    updated.planningEntry = { from: task.status, at: now, seq: prior < Number.MAX_SAFE_INTEGER ? prior + 1 : 1 };
  }

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

  // A write that dropped the seat ends that seat's execution (see
  // closeAttemptsOnHandBack). Before emit, so TASK_UPDATED publishes after it.
  await closeAttemptsOnHandBack(state, task, updated);

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
    // Name who moved it: a governor or QA move otherwise read "by unknown",
    // since those rows are unassigned or are being unassigned by the move.
    const actor = actorWorkerId || updated.assignedWorkerId || 'unknown';
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

  // An attempt never outlives its task: finalize_attempt refuses a missing task
  // before it looks the attempt up, so nothing could close one afterwards. Closed
  // FIRST and deliberately not caught, so a failed close changes nothing — not
  // even the SPEED-mode timer — and the caller retries (the close is idempotent).
  await closeOpenAttempts(state, taskId);

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

export async function approveTask(
  state: StateManager,
  taskId: string,
  expectedPlanRevision?: unknown
): Promise<Task> {
  // NOTE: callers MUST hold the StateManager mutex (e.g. via
  // WebSocketServer.withMutex / state.runExclusive) so that the status
  // re-check and updateTask happen atomically. The mutex is non-reentrant,
  // so this method does not acquire it directly.
  const task = state.getTask(taskId);
  if (!task) throw new Error(`Task not found: ${taskId}`);
  if (task.status !== 'AWAITING_APPROVAL') {
    throw new Error(`Cannot approve task in ${task.status} status, must be AWAITING_APPROVAL`);
  }
  // Compare-and-swap on the plan revision the approver actually reviewed. Only
  // the two human /ws routes come here (set_task_status relaxed mode never
  // does, and SPEED/TURBO bind their own revision in submitPlan), and each must
  // name the revision: CQ-F MODIFY_RAIL prop-5e7763ed (human-approved
  // 2026-10-25) deleted revision-less approval, so an omission is refused. This
  // whole block runs before any write, so a refusal cancels no pending timer,
  // mutates no bytes and publishes nothing.
  if (expectedPlanRevision === undefined) {
    throw invalidInput('expectedPlanRevision', `approval of task ${taskId} must name the reviewed plan revision`);
  }
  const reviewed = decodeSuppliedPlanRevision(expectedPlanRevision, taskId);
  // Absent stamp reads as 0, so a legacy row matches an explicit 0; a corrupt
  // stored stamp still fails closed as INVALID_INPUT.
  const current = decodeStoredPlanRevision(task);
  if (reviewed !== current) throw planRevisionMismatch(taskId, reviewed, current);
  // Readiness is checked here too, before the write.
  assertProgressionReady(state, task, {}, 'WORKING', 'PLAN_APPROVED');
  // The reviewed revision travels in the store's private argument, so this one
  // write stamps it beside the approval.
  const updated = await updateTask(
    state, taskId, { status: 'WORKING', planApprovedAt: new Date().toISOString() }, 'PLAN_APPROVED', undefined,
    { approvedPlanRevision: reviewed }
  );
  // Only once the write has landed: a refused or failed approval keeps a pending
  // SPEED timer, whose queued callback re-checks the status under the mutex.
  cancelSpeedModeTimeout(taskId);
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
