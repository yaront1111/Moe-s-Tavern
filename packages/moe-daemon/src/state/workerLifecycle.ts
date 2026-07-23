// =============================================================================
// workerLifecycle — the SINGLE source of truth for releasing a worker's tasks
// and marking the worker gone. Used by:
//   - the `moe.deregister_worker` MCP tool (graceful: shell trap on terminal close)
//   - claim takeover of a dead-but-present owner
// One code path so every trigger produces an identical, deterministic end state.
// =============================================================================

import type { StateManager } from './StateManager.js';
import type { Task, TaskStatus } from '../types/schema.js';
import { logger } from '../util/logger.js';

export { isWorkerAlive, LIVENESS_TIMEOUT_MS } from '../util/workerLiveness.js';

const CLAIMABLE_FALLBACK_STATUS: TaskStatus = 'BACKLOG';

/** True iff the task has an implementation plan and every step is COMPLETED. */
export function allStepsCompleted(task: Pick<Task, 'implementationPlan'>): boolean {
  const plan = Array.isArray(task.implementationPlan) ? task.implementationPlan : [];
  return plan.length > 0 && plan.every((s) => s.status === 'COMPLETED');
}

/**
 * How a release should route the task:
 *   - 'requeue' (default): put the task back where its own role's agents can
 *     claim it. Used by crash cleanup (startup purge, deleteWorker), graceful
 *     deregister, claim takeover of a dead owner, and manual release_task.
 *   - 'park': pull the task OUT of every agent claim pool (PLANNING, WORKING,
 *     and REVIEW all route to BACKLOG) for human triage. Used ONLY by the
 *     blocked-timeout sweep: the blocker is usually environmental (missing
 *     prereq, broken toolchain), so requeueing would make the next agent —
 *     whatever its role — claim it, hit the same wall, block, time out, and
 *     release again — an infinite claim-thrash loop burning tokens.
 */
export type ReleaseContext = 'requeue' | 'park';

/**
 * Decide which status a released task should rest in. The task is currently
 * held by a worker — when we strip the assignment, route it based on what the
 * worker was doing:
 * requeue (default):
 *   - PLANNING          → PLANNING          (next architect picks it up)
 *   - AWAITING_APPROVAL → AWAITING_APPROVAL (human still owns approval)
 *   - REVIEW            → REVIEW            (next QA picks it up)
 *   - WORKING           → REVIEW if every step is already COMPLETED (don't
 *                         discard a dead worker's finished work — hand to QA);
 *                         otherwise stay WORKING so the next worker claims it
 *                         and resumes from the plan's step statuses (plus any
 *                         priorHandoffs an explicit release recorded). Workers
 *                         claim ONLY the WORKING column — BACKLOG is a
 *                         human-triage column no agent claims, so routing
 *                         there strands the task until a human re-triages it.
 * park (blocked-timeout sweep only):
 *   - PLANNING / WORKING / REVIEW → BACKLOG. Every in-flight agent column is
 *                         an agent claim pool under the claim vocabulary, and
 *                         an environmental blocker thrashes whichever pool
 *                         the task returns to — so park pulls it out of ALL
 *                         of them for human triage. Un-park via
 *                         set_task_status (BACKLOG → PLANNING/WORKING/REVIEW
 *                         are all legal transitions).
 *   - AWAITING_APPROVAL → AWAITING_APPROVAL (already human-gated; moving it
 *                         to BACKLOG would silently drop the pending plan).
 * Both contexts:
 *   - DONE / ARCHIVED   → unchanged. Terminal statuses must never be routed
 *                         back to a claimable column: a stale assignee on a
 *                         finished task (explicit-status claim, git-pulled
 *                         .moe/tasks from another machine) would otherwise be
 *                         "released" into BACKLOG and the fleet would redo
 *                         completed work. Release only strips the assignee.
 * Anything else falls back to BACKLOG (unknown status → human triage).
 *
 * This is the ONLY definition of release routing — every release path
 * (checkBlockedTimeouts, deregister, manual release) routes through here.
 */
export function nextStatusForRelease(
  task: Pick<Task, 'status' | 'implementationPlan'>,
  context: ReleaseContext = 'requeue'
): TaskStatus {
  switch (task.status) {
    case 'PLANNING':
      return context === 'park' ? 'BACKLOG' : 'PLANNING';
    case 'AWAITING_APPROVAL':
      return 'AWAITING_APPROVAL';
    case 'REVIEW':
      return context === 'park' ? 'BACKLOG' : 'REVIEW';
    case 'WORKING':
      if (context === 'park') return 'BACKLOG';
      return allStepsCompleted(task) ? 'REVIEW' : 'WORKING';
    case 'DONE':
      return 'DONE';
    case 'ARCHIVED':
      return 'ARCHIVED';
    default:
      return CLAIMABLE_FALLBACK_STATUS;
  }
}

export interface ReleaseResult {
  taskId: string;
  previousStatus: TaskStatus;
  newStatus: TaskStatus;
}

/**
 * Release every task currently assigned to a worker. Used both directly by
 * `moe.deregister_worker` and by the stale watcher. Does NOT touch the worker
 * record — caller decides whether to mark DEAD, leave chat, etc.
 *
 * Iterates `state.tasks` rather than relying on `worker.currentTaskId` so we
 * also catch tasks where the assignment got out of sync.
 */
export async function releaseWorkerTasks(
  state: StateManager,
  workerId: string,
  reason: string,
  context: ReleaseContext = 'requeue'
): Promise<ReleaseResult[]> {
  const released: ReleaseResult[] = [];
  for (const task of state.tasks.values()) {
    if (task.assignedWorkerId !== workerId) continue;
    const prevStatus = task.status;
    const nextStatus = nextStatusForRelease(task, context);
    try {
      await state.updateTask(
        task.id,
        { assignedWorkerId: null, status: nextStatus },
        'WORKER_RELEASED'
      );
      released.push({ taskId: task.id, previousStatus: prevStatus, newStatus: nextStatus });
    } catch (err) {
      logger.warn({ workerId, taskId: task.id, error: err, reason }, 'releaseWorkerTasks: failed to release task');
    }
  }
  return released;
}

export interface DeregisterResult {
  workerId: string;
  released: ReleaseResult[];
  alreadyDead: boolean;
}

/**
 * Full deregister flow: release tasks, mark worker DEAD, post chat-leave
 * system messages to every channel the worker had a cursor for, and emit a
 * single banner to #workers / #governors summarizing the cleanup.
 *
 * Marking the worker DEAD (rather than deleting it) keeps lastError/history for
 * post-mortem and makes repeat calls idempotent; the record prune in
 * runBlockedTimeoutSweep later removes DEAD workers that own nothing (records
 * only — it never touches tasks). The UI drops DEAD workers immediately
 * (updateWorker emits WORKER_DELETED + getSnapshot excludes them).
 *
 * Idempotent: if the worker is already DEAD with no current task, returns
 * { alreadyDead: true, released: [] } and skips chat noise.
 */
export async function deregisterWorker(
  state: StateManager,
  workerId: string,
  reason: string
): Promise<DeregisterResult> {
  const worker = state.getWorker(workerId);
  if (!worker) {
    return { workerId, released: [], alreadyDead: true };
  }

  // Already fully deregistered — no-op, no chat spam on repeat calls. Key on
  // authoritative ownership (any task still assigned to this worker), NOT the
  // secondary worker.currentTaskId pointer: if a prior release failed partway
  // and left a dangling assignment, a retry should re-run releaseWorkerTasks.
  if (worker.status === 'DEAD' && state.getTasksAssignedToWorker(workerId).length === 0) {
    return { workerId, released: [], alreadyDead: true };
  }

  const released = await releaseWorkerTasks(state, workerId, reason);

  // Mark worker DEAD. Keep the record (preserves history / lastError) so the
  // record prune can remove it later. updateWorker preserves lastActivityAt on the DEAD
  // transition (so staleness/pruning stays accurate) and emits WORKER_DELETED
  // so the UI removes it.
  try {
    await state.updateWorker(workerId, {
      status: 'DEAD',
      currentTaskId: null,
    });
  } catch (err) {
    logger.warn({ workerId, error: err }, 'deregisterWorker: updateWorker failed');
  }

  // Post chat-leave system messages to every channel this worker has touched.
  const cursorChannelIds = Object.keys(worker.chatCursors ?? {});
  for (const channelId of cursorChannelIds) {
    const channel = state.getChannel(channelId);
    if (!channel) continue;
    try {
      await state.sendMessage({
        channel: channelId,
        sender: 'system',
        content: `${workerId} left (${reason})`,
      });
    } catch (err) {
      logger.debug({ workerId, channelId, error: err }, 'deregisterWorker: chat-leave message failed');
    }
  }

  // One summary banner to #workers + #governors with the release list.
  const releasedSummary = released.length === 0
    ? `(no tasks held)`
    : `released ${released.length} task${released.length === 1 ? '' : 's'}: ${released
        .map((r) => `${r.taskId}→${r.newStatus}`)
        .join(', ')}`;
  const banner = `🔌 ${workerId} deregistered (${reason}); ${releasedSummary}`;
  try { await state.postToRoleChannel('workers', banner); } catch { /* never block */ }
  try { await state.postToRoleChannel('governors', banner); } catch { /* never block */ }

  state.appendActivity(
    'WORKER_DISCONNECTED',
    { workerId, reason, releasedTaskIds: released.map((r) => r.taskId) },
    undefined,
    worker
  );

  logger.info({ workerId, reason, released: released.length }, 'worker deregistered');
  return { workerId, released, alreadyDead: false };
}
