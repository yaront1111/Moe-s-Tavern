// =============================================================================
// workerLifecycle — the SINGLE source of truth for releasing a worker's tasks
// and marking the worker gone. Used by:
//   - the `moe.deregister_worker` MCP tool (graceful: shell trap on terminal close)
//   - claim takeover of a dead-but-present owner
// One code path so every trigger produces an identical, deterministic end state.
// =============================================================================

import type { StateManager } from './StateManager.js';
import type { ExecutionAttempt, LandingRetry, ProjectSettings, Task, TaskStatus, Worker } from '../types/schema.js';
import { logger } from '../util/logger.js';
import { generateId } from '../util/ids.js';
import { completionCommitsForReview } from '../delivery/policy.js';
import { announceAttemptClosed, closeOpenAttempts, listAttempts, setAttemptPhase } from './attemptStore.js';
import { releaseDeregisteredClaims } from './resourceStore.js';

export { isWorkerAlive, LIVENESS_TIMEOUT_MS } from '../util/workerLiveness.js';

const CLAIMABLE_FALLBACK_STATUS: TaskStatus = 'BACKLOG';

export const RELOAD_HOLD_REASON = 'wrapper_restart';
export const RELOAD_HOLD_EXPIRED_REASON = 'reload_hold_expired';
export const DEFAULT_RELOAD_HOLD_MS = 120_000;
export const MAX_RELOAD_HOLD_MS = 1_800_000;

export function resolveReloadHoldMs(settings?: Pick<ProjectSettings, 'reloadHoldMs'>): number {
  const ms = settings?.reloadHoldMs;
  return typeof ms === 'number' && Number.isFinite(ms) && ms >= 0
    ? Math.min(ms, MAX_RELOAD_HOLD_MS)
    : DEFAULT_RELOAD_HOLD_MS;
}

/** Caller holds state.mutex. Propagate a failed clear: resuming with a live deadline is unsafe. */
export async function endReloadHold(state: StateManager, workerId?: string): Promise<void> {
  if (!workerId || state.getWorker(workerId)?.reloadHoldUntil == null) return;
  await state.updateWorker(workerId, { reloadHoldUntil: null });
  logger.info({ workerId }, 'worker returned from reload hold');
}

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
 *   - WORKING           → WORKING while landingRetry is set (nothing landed
 *                         yet, even if every step is already COMPLETED);
 *                         otherwise REVIEW if every step is COMPLETED (don't
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
  task: Pick<Task, 'status' | 'implementationPlan' | 'landingRetry'>,
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
      if (task.landingRetry != null) return 'WORKING';
      return allStepsCompleted(task) ? 'REVIEW' : 'WORKING';
    case 'BLOCKED':
      // A release (restart purge, deregister, manual release_task) must NOT
      // un-block the task: the blocker is still there. It stays BLOCKED and
      // unassigned; the resource grant path (or a human) flips it back to
      // blockedFromStatus, where the next agent claims it. Park still routes
      // to BACKLOG for human triage.
      return context === 'park' ? 'BACKLOG' : 'BLOCKED';
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
      continue; // Still assigned: it keeps its seat, and so its attempt.
    }
    // The seat is given up, so its attempt ends — after the unassign, never
    // before, and whatever status the task was routed to. Logged, not thrown:
    // the release already happened, and the next claim closes a leftover.
    try {
      await closeOpenAttempts(state, task.id);
    } catch (err) {
      logger.warn({ workerId, taskId: task.id, error: err, reason }, 'releaseWorkerTasks: failed to close the released attempt');
    }
  }
  return released;
}

export interface DeregisterResult {
  workerId: string;
  released: ReleaseResult[];
  alreadyDead: boolean;
  held: string[];
  holdUntil?: string;
}

/** Caller holds state.mutex. A failed hold write falls back to full deregistration. */
async function beginReloadHold(state: StateManager, worker: Worker, reason: string): Promise<DeregisterResult | null> {
  const ms = resolveReloadHoldMs(state.project?.settings);
  if (reason !== RELOAD_HOLD_REASON || worker.status === 'DEAD' || ms === 0) return null;
  const tasks = state.getActiveTasksAssignedToWorker(worker.id);
  if (tasks.length === 0) return null;
  const held = tasks.map(task => task.id);
  if (worker.reloadHoldUntil != null) {
    return { workerId: worker.id, released: [], alreadyDead: false, held, holdUntil: worker.reloadHoldUntil };
  }
  const holdUntil = new Date(Date.now() + ms).toISOString();
  try {
    await state.updateWorker(worker.id, { reloadHoldUntil: holdUntil });
  } catch (error) {
    logger.warn({ workerId: worker.id, error }, 'deregisterWorker: reload hold write failed; releasing');
    return null;
  }
  const banner = `🔌 ${worker.id} reloading (${reason}); holding ${held.length} task(s) for its relaunch until ${holdUntil}: ${tasks
    .map(task => `${task.id}(${task.status})`).join(', ')}`;
  try { await state.postToRoleChannel('workers', banner); } catch { /* never block */ }
  try { await state.postToRoleChannel('governors', banner); } catch { /* never block */ }
  state.appendActivity('WORKER_DISCONNECTED', {
    workerId: worker.id, reason, releasedTaskIds: [], heldTaskIds: held, holdUntil,
  }, undefined, worker);
  return { workerId: worker.id, released: [], alreadyDead: false, held, holdUntil };
}

/**
 * Close every `finalizing` attempt this worker still holds, keyed on the
 * ATTEMPT's workerId — never on a task assignment or on the worker record.
 *
 * WHY HERE. complete_task parks the attempt in `finalizing` and unassigns the
 * row, and while that attempt is open no other seat may claim the task
 * (util/claimEligibility.ts). Every release path selects by assignment, so none
 * reaches it: without this close, a runner that exits without
 * moe.finalize_attempt would wedge the row. Keyed on the attempt, it still works
 * when the worker record is already gone — a post-flight longer than
 * staleWorkerTimeoutMs lets the record prune delete it mid-landing.
 *
 * WHY IT CANNOT CUT A LANDING SHORT. moe.deregister_worker is sent only from the
 * wrapper's exit and teardown paths — after the landing, its rescue, or its
 * abandonment. It is an explicit end-of-life call, not an idle signal.
 *
 * WHAT IT IS NOT: evidence of a landing. Some exits send it with no finalize
 * before it (the sh EXIT trap before any landing ran, a ps1 console window
 * closed, a finalize whose acknowledgement failed), and the close then lifts
 * qa_approve's hold without an acknowledged landing — exactly what a QA claim's
 * supersede did before the task-scoped hold existed. Under the legacy delivery
 * policy the soft NO-COMPLETION-COMMIT warning is then the only guard; strict
 * policies still refuse the approval. So a worktree attempt whose unassigned
 * REVIEW row has no completion recorded for its round is routed back for a
 * landing retry after its close (retryUnrecordedLanding), as an unlanded
 * finalize routes it, instead of being left for QA's landed gate to park.
 *
 * ALSO THE DEAD-RECORD BACKSTOP. deleteWorker (the stale-record prune) and the
 * startup purge call it for a DEAD record, and only for one. deregister marks
 * the seat DEAD after its own close attempt, so a DEAD record still holding a
 * finalizing attempt is a runner that declared its end and whose close failed —
 * evidence, not silence. A non-DEAD record is removed on lastActivityAt alone,
 * and no idle signal may close an attempt, so those removals close nothing.
 *
 * Each close has its own catch: a failed write is logged, leaves that attempt
 * finalizing for the wrapper's retry (or the next prune or restart), and never
 * fails the caller. A real close announces itself (announceAttemptClosed) so
 * parked waiters wake. Caller must hold state.mutex.
 */
export async function closeOwnFinalizingAttempts(state: StateManager, workerId: string): Promise<void> {
  const held = listAttempts(state).filter((a) => a.workerId === workerId && a.phase === 'finalizing');
  for (const attempt of held) {
    try {
      await setAttemptPhase(state, attempt.id, 'closed');
    } catch (error) {
      logger.warn(
        { workerId, attemptId: attempt.id, taskId: attempt.taskId, error },
        'deregisterWorker: failed to close a finalizing attempt; it stays finalizing for a retry'
      );
      continue;
    }
    announceAttemptClosed(state, attempt.taskId);
    await retryUnrecordedLanding(state, attempt);
  }
}

/**
 * The close above ended a landing the daemon has no completion for. On a
 * worktree attempt whose task is in REVIEW, held by no seat, with no completion
 * entry for its current round (completionCommitsForReview, the rule QA's
 * commit gate uses), nothing is known to have published, and QA's landed gate
 * would park the row BLOCKED. Route it as an unlanded finalize would, with
 * reason contention (a reason both launchers' worktree_resume accept), no paths
 * and the task branch as the ref that holds the bytes. Any other row keeps the
 * plain close. Never reads git: a commit the dead runner published unrecorded
 * is settled by the next pre-flight's receipt replay. Never throws: a failed
 * write is logged and leaves the row in REVIEW, and the close stands.
 */
async function retryUnrecordedLanding(state: StateManager, attempt: ExecutionAttempt): Promise<void> {
  try {
    const task = state.getTask(attempt.taskId);
    if (attempt.workspaceMode !== 'worktree' || !task || task.status !== 'REVIEW' || task.assignedWorkerId
      || completionCommitsForReview(task).length > 0) return;
    await routeUnlandedLanding(state, task, attempt,
      { reason: 'contention', paths: [], rescueRef: `refs/heads/moe/task/${task.id}`, targetTip: null },
      attempt.workerId,
      `The runner of ${attempt.workerId} ended mid-landing: attempt ${attempt.id} was closed with no completion recorded for this round.`);
  } catch (error) {
    logger.warn(
      { workerId: attempt.workerId, attemptId: attempt.id, taskId: attempt.taskId, error },
      'closeOwnFinalizingAttempts: failed to route an unrecorded worktree landing for a retry; the row stays in REVIEW'
    );
  }
}

/**
 * Route a worktree landing that published nothing back for a retry: the one
 * definition behind moe.finalize_attempt's 'unlanded' outcome and the
 * finalizing close's routing (closeOwnFinalizingAttempts). One write sets
 * task.landingRetry (count = the prior count + 1) and appends one moe-daemon
 * comment (`note`, when given, opens it). A REVIEW row goes to WORKING,
 * unassigned, keeping reopenCount and its completed steps, or to BLOCKED
 * (unblocking to WORKING) for 'diverged' or the 3rd unlanded landing in a row.
 * A row not in REVIEW keeps its status and assignment. Caller must hold
 * state.mutex.
 */
export async function routeUnlandedLanding(
  state: StateManager,
  task: Task,
  attempt: Pick<ExecutionAttempt, 'id' | 'generation'>,
  unlanded: Omit<LandingRetry, 'count' | 'at'>,
  actor: string,
  note?: string
): Promise<Task> {
  const prior = task.landingRetry?.count;
  const count = (typeof prior === 'number' && Number.isSafeInteger(prior) && prior > 0 ? prior : 0) + 1;
  const at = new Date().toISOString();
  const landingRetry = { ...unlanded, count, at };
  const { reason, paths, rescueRef, targetTip } = landingRetry;
  const status = task.status !== 'REVIEW' ? task.status : reason === 'diverged' || count >= 3 ? 'BLOCKED' : 'WORKING';
  const preview = paths.slice(0, 20).join(', ') || '(none reported)';
  const comment = { id: generateId('comment'), author: 'moe-daemon', timestamp: at,
    content: `${note ? `${note} ` : ''}Landing unlanded (${reason}) ${count} time(s) in a row; attempt ${attempt.id} ` +
      `(generation ${attempt.generation}); paths: ${preview}${paths.length > 20 ? ` (+${paths.length - 20} more)` : ''}; ` +
      `rescue ref: ${rescueRef}; target tip: ${targetTip ?? 'unknown'}; task ${status}.` };
  const routing: Partial<Task> = task.status !== 'REVIEW' ? {} : { status, assignedWorkerId: null,
    ...(status === 'BLOCKED' ? {
      blockedReason: `Landing unlanded (${reason}) ${count} time(s) in a row; ${rescueRef}; reconcile, then move the task to WORKING`,
      blockedResourceId: null, blockedOnTaskIds: null, blockedFromStatus: 'WORKING' as const, blockedAt: at,
    } : {}) };
  return state.updateTask(task.id, { ...routing, landingRetry, comments: [...task.comments, comment] },
    routing.status === 'BLOCKED' ? 'TASK_BLOCKED' : undefined, actor);
}

/**
 * Full deregister flow: close the worker's own finalizing attempts, release
 * tasks, mark worker DEAD, drop the released tasks' claims on
 * releaseOnDeregister resources, post chat-leave system messages to every
 * channel the worker had a cursor for, and emit a single banner to #workers /
 * #governors summarizing the cleanup. A wrapper_restart with active tasks
 * instead holds the seat for its relaunch until claim or deadline expiry.
 *
 * Marking the worker DEAD (rather than deleting it) keeps lastError/history for
 * post-mortem and makes repeat calls idempotent; the record prune in
 * runBlockedTimeoutSweep later removes DEAD workers that own nothing (records
 * only — it never touches tasks). The UI drops DEAD workers immediately
 * (updateWorker emits WORKER_DELETED + getSnapshot excludes them).
 *
 * Idempotent: if the worker is already DEAD with no current task, returns
 * { alreadyDead: true, released: [] } and skips chat noise. The finalizing close
 * runs before that answer (and before the missing-record one), so a retry after
 * a failed close is a quiet close-only call.
 */
export async function deregisterWorker(
  state: StateManager,
  workerId: string,
  reason: string
): Promise<DeregisterResult> {
  // FIRST, before either early return: these attempts sit on rows complete_task
  // already unassigned, so nothing below reaches them, and a pruned or
  // already-DEAD record must still end its landing hold.
  await closeOwnFinalizingAttempts(state, workerId);

  const worker = state.getWorker(workerId);
  if (!worker) {
    return { workerId, released: [], alreadyDead: true, held: [] };
  }

  // Already fully deregistered — no-op, no chat spam on repeat calls. Key on
  // authoritative ownership (any task still assigned to this worker), NOT the
  // secondary worker.currentTaskId pointer: if a prior release failed partway
  // and left a dangling assignment, a retry should re-run releaseWorkerTasks.
  // The finalizing close above has already run, so this answer stays quiet.
  if (worker.status === 'DEAD' && state.getTasksAssignedToWorker(workerId).length === 0) {
    return { workerId, released: [], alreadyDead: true, held: [] };
  }

  const hold = await beginReloadHold(state, worker, reason);
  if (hold) return hold;

  const released = await releaseWorkerTasks(state, workerId, reason);

  // Mark worker DEAD. Keep the record (preserves history / lastError) so the
  // record prune can remove it later. updateWorker preserves lastActivityAt on the DEAD
  // transition (so staleness/pruning stays accurate) and emits WORKER_DELETED
  // so the UI removes it.
  try {
    await state.updateWorker(workerId, {
      status: 'DEAD',
      currentTaskId: null,
      ...(worker.reloadHoldUntil != null ? { reloadHoldUntil: null } : {}),
    });
  } catch (err) {
    logger.warn({ workerId, error: err }, 'deregisterWorker: updateWorker failed');
  }

  // Leases stay task-keyed for the next claimant, except on resources declared
  // releaseOnDeregister: those claims leave with the seat, and a task BLOCKED
  // on one comes back claimable. Deregistration only, never a release_task
  // hand-off or the restart purge. After the DEAD mark, so a grant it triggers
  // does not restore a row onto this seat. Never throws.
  const { dropped, restored } = await releaseDeregisteredClaims(state, released.map((r) => r.taskId));
  for (const r of released) r.newStatus = restored.get(r.taskId) ?? r.newStatus;

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
  const droppedSummary = dropped.length === 0
    ? ''
    : `; dropped ${dropped.length} resource claim${dropped.length === 1 ? '' : 's'}: ${dropped
        .map((d) => `${d.resourceId} ${d.claim} (${d.taskId})`)
        .join(', ')}`;
  const banner = `🔌 ${workerId} deregistered (${reason}); ${releasedSummary}${droppedSummary}`;
  try { await state.postToRoleChannel('workers', banner); } catch { /* never block */ }
  try { await state.postToRoleChannel('governors', banner); } catch { /* never block */ }

  state.appendActivity(
    'WORKER_DISCONNECTED',
    {
      workerId,
      reason,
      releasedTaskIds: released.map((r) => r.taskId),
      ...(dropped.length > 0 ? { droppedResourceClaims: dropped } : {}),
    },
    undefined,
    worker
  );

  logger.info({ workerId, reason, released: released.length }, 'worker deregistered');
  return { workerId, released, alreadyDead: false, held: [] };
}
