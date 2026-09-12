// =============================================================================
// Periodic sweeps - blocked timeouts, proposal purge, stale-worker watcher
// =============================================================================
//
// Extracted verbatim from StateManager. Every interval handle stays ON the
// state object (state.blockedTimeoutInterval / proposalPurgeInterval /
// staleWorkerInterval), never in module scope: a module-level handle would be
// shared across StateManager instances, so stop* would clear the wrong timer
// and vitest would hang on a leaked one.
//
// Error handling IS the feature here. These are periodic callbacks with no
// caller to catch for them, so the per-item try/catch that logs and continues
// moved verbatim - one bad task or proposal must not kill the interval for the
// whole fleet.
//
// runBlockedTimeoutSweep routes released tasks through
// nextStatusForRelease(task, 'park'). That argument is load-bearing: a blocked
// task goes to BACKLOG for human triage, NOT back into a claim pool where the
// next agent would walk straight into the same blocker.

import fs from 'fs';
import path from 'path';
import type { StateManager } from './StateManager.js';
import type { ExecutionAttempt, RailProposal, TaskStatus, Worker } from '../types/schema.js';
import { logger } from '../util/logger.js';
import { listAttempts, setAttemptPhase } from './attemptStore.js';
import { isWorkerAlive, nextStatusForRelease } from './workerLifecycle.js';
import { cleanupStaleWaiters } from '../tools/waitForTask.js';
import { cleanupStaleResourceWaiters } from '../tools/waitForResource.js';
import { reapResources } from './resourceStore.js';
import { alertStaleBlocks, runDependencyUnblock } from './dependencyUnblock.js';

// Copied verbatim from StateManager: the statuses that count as an ACTIVE
// assignment for stale-worker cleanup. Kept in sync by step-9's move.
// BLOCKED added with the shared-resource feature — a resource-queued task is
// an active hold (see workerStore.ts).
const ACTIVE_ASSIGNMENT_STATUSES = new Set<TaskStatus>(['PLANNING', 'WORKING', 'REVIEW', 'BLOCKED']);

const DAY_IN_MS = 24 * 60 * 60 * 1000;
export const PROPOSAL_PURGE_AGE_MS = parseInt(process.env.MOE_PROPOSAL_PURGE_AGE_MS || `${7 * DAY_IN_MS}`, 10);
export const PROPOSAL_PURGE_INTERVAL_MS = parseInt(process.env.MOE_PROPOSAL_PURGE_INTERVAL_MS || `${DAY_IN_MS}`, 10);
export const PROPOSAL_SNAPSHOT_RETENTION_MS = parseInt(process.env.MOE_PROPOSAL_SNAPSHOT_RETENTION_MS || `${DAY_IN_MS}`, 10);

/**
 * Default for settings.reconcileWindowMs — 2 hours. Lives here beside the sweep
 * that reads it; StateManager's constructor imports it so there is one value.
 * The reasoning for the size is on that constructor default.
 */
export const DEFAULT_RECONCILE_WINDOW_MS = 2 * 60 * 60 * 1000;

/** Cadence of the reconcile-window pass. Matches the blocked-timeout sweep. */
export const RECONCILE_WINDOW_CHECK_INTERVAL_MS = 300000;

/**
 * Start periodic check for blocked worker timeouts.
 * Runs every 5 minutes by default.
 */
export function startBlockedTimeoutCheck(state: StateManager, intervalMs = 300000): void {
  state.stopBlockedTimeoutCheck();
  // mutex.exit: detach the interval from any held-lock ALS context so the
  // sweep's runExclusive actually acquires the lock (see AsyncMutex.exit).
  state.blockedTimeoutInterval = state.mutex.exit(() => setInterval(() => {
    state.checkBlockedTimeouts().catch((err) => {
      logger.error({ error: err }, 'Error checking blocked worker timeouts');
    });
  }, intervalMs));
  // Don't prevent process exit
  if (state.blockedTimeoutInterval.unref) {
    state.blockedTimeoutInterval.unref();
  }
}

/**
 * Stop the periodic blocked timeout check.
 */
export function stopBlockedTimeoutCheck(state: StateManager): void {
  if (state.blockedTimeoutInterval) {
    clearInterval(state.blockedTimeoutInterval);
    state.blockedTimeoutInterval = undefined;
  }
}

/**
 * Start periodic purge of resolved proposals.
 * Runs every 24 hours by default.
 */
export function startProposalPurgeInterval(state: StateManager, intervalMs = PROPOSAL_PURGE_INTERVAL_MS): void {
  state.stopProposalPurgeInterval();
  // mutex.exit: see startBlockedTimeoutCheck.
  state.proposalPurgeInterval = state.mutex.exit(() => setInterval(() => {
    state.purgeResolvedProposals()
      .then((purgedCount) => {
        if (purgedCount > 0) {
          state.emit({ type: 'STATE_SNAPSHOT', payload: state.getSnapshot() });
        }
      })
      .catch((error) => {
        logger.error({ error }, 'Error purging resolved proposals');
      });
  }, intervalMs));

  // Don't prevent process exit
  if (state.proposalPurgeInterval.unref) {
    state.proposalPurgeInterval.unref();
  }
}

/**
 * Stop periodic resolved proposal purge.
 */
export function stopProposalPurgeInterval(state: StateManager): void {
  if (state.proposalPurgeInterval) {
    clearInterval(state.proposalPurgeInterval);
    state.proposalPurgeInterval = undefined;
  }
}

/**
 * Start periodic stale-worker watcher. Posts ⚠️ alerts to #governors when a
 * worker still holds a task assignment but hasn't pinged in more than the
 * liveness timeout. Silent when no governor is online (avoids log noise in
 * single-architect setups). Default cadence: 60 seconds.
 */
export function startStaleWorkerWatcher(state: StateManager, intervalMs = 60_000, livenessTimeoutMs = 120_000): void {
  state.stopStaleWorkerWatcher();
  // mutex.exit: see startBlockedTimeoutCheck.
  state.staleWorkerInterval = state.mutex.exit(() => setInterval(() => {
    state.checkStaleWorkers(livenessTimeoutMs).catch((err) => {
      logger.error({ error: err }, 'Error checking stale workers');
    });
  }, intervalMs));
  if (state.staleWorkerInterval.unref) {
    state.staleWorkerInterval.unref();
  }
}

export function stopStaleWorkerWatcher(state: StateManager): void {
  if (state.staleWorkerInterval) {
    clearInterval(state.staleWorkerInterval);
    state.staleWorkerInterval = undefined;
  }
}

/**
 * Start the periodic reconcile-window pass. Default cadence: 5 minutes.
 */
export function startReconcileWindowCheck(
  state: StateManager,
  intervalMs = RECONCILE_WINDOW_CHECK_INTERVAL_MS
): void {
  state.stopReconcileWindowCheck();
  // mutex.exit: see startBlockedTimeoutCheck.
  state.reconcileWindowInterval = state.mutex.exit(() => setInterval(() => {
    state.checkReconcileWindow().catch((err) => {
      logger.error({ error: err }, 'Error checking the attempt reconcile window');
    });
  }, intervalMs));
  if (state.reconcileWindowInterval.unref) {
    state.reconcileWindowInterval.unref();
  }
}

export function stopReconcileWindowCheck(state: StateManager): void {
  if (state.reconcileWindowInterval) {
    clearInterval(state.reconcileWindowInterval);
    state.reconcileWindowInterval = undefined;
  }
}

/**
 * Close reconciling attempts that no runner ever came back for, and release
 * their tasks for ONE successor each.
 *
 * WHY THIS EXISTS. A daemon restart parks every `running` attempt in
 * `reconciling`: the daemon has lost sight of that execution and holds the task
 * until a runner reattaches and proves which process it is talking about. If no
 * runner ever comes back, nothing else releases the row — the seat is spared by
 * purgeAllWorkers, third parties are refused by the claim guard, and there is
 * deliberately no idle sweep for WORKING. The task would be parked forever.
 *
 * WHAT THIS IS NOT. It is not a death detector, and the window is not evidence
 * of anything. The daemon is state-only and never probes a process; the only
 * authority that can establish a runner stopped is the wrapper's exit trap
 * calling moe.deregister_worker, and that path already closes the attempt
 * immediately (releaseWorkerTasks → closeOpenAttempts, which covers
 * `reconciling` because it is one of OPEN_PHASES). This is only the bound for
 * when no such declaration ever arrives.
 *
 * TWO INVARIANTS THIS SWEEP MUST NEVER BREAK, both of which would look correct
 * in review:
 *  - The filter is the `reconciling` phase EXACTLY — never the task's status. A
 *    reconciling attempt's task is still WORKING, so a status filter would
 *    sweep live rows. `running` (including a successfully reattached attempt)
 *    and `finalizing` are untouched however old they are.
 *  - The clock is the attempt's own `lastPhaseAt` — when it ENTERED the phase —
 *    never a worker's `lastActivityAt`. Measuring from worker idle would
 *    reintroduce the idle-based auto-release for WORKING/PLANNING that a task
 *    rail forbids: a quiet build is not evidence of a dead worker.
 *
 * EXACTLY ONE SUCCESSOR, without a counter here. This sweep never opens an
 * attempt; the next claim does. The store is what makes the successor exactly
 * one: openAttempt refuses a second open attempt for the same task, and the
 * generation allocator takes the max over EVERY prior attempt (closed ones
 * included) + 1, so the successor is strictly greater and a generation is never
 * reissued. A count kept here would be a second source of truth for a rule that
 * already holds.
 *
 * Caller must hold state.mutex (checkReconcileWindow provides it). Returns the
 * attempts it closed.
 */
export async function runReconcileWindowSweep(
  state: StateManager,
  nowMs = Date.now()
): Promise<ExecutionAttempt[]> {
  const closed: ExecutionAttempt[] = [];
  for (const attempt of listAttempts(state)) {
    if (attempt.phase !== 'reconciling') continue;
    const phaseAt = attempt.lastPhaseAt ? Date.parse(attempt.lastPhaseAt) : NaN;
    // An unreadable timestamp is not a licence to release: skip it, exactly as
    // the sweeps above skip a worker whose lastActivityAt will not parse.
    if (Number.isNaN(phaseAt)) continue;
    if (nowMs - phaseAt <= state.reconcileWindowMs) continue;

    // Per-attempt, like every other sweep here: one unwritable record must not
    // stop the pass for the whole fleet. A record that fails to close stays
    // `reconciling` — still non-closed, so its task is still held and a runner
    // reattaching to it still succeeds. Failing in that direction is safe.
    try {
      logger.info(
        { attemptId: attempt.id, taskId: attempt.taskId, lastPhaseAt: attempt.lastPhaseAt },
        'Closing an attempt that sat in reconciling past the window; releasing its task for one successor'
      );
      // CLOSE FIRST, THEN RELEASE. The reverse order leaves a window in which
      // the task is released while its attempt is still `reconciling` — and the
      // claim guard refuses a reconciling row to exactly the third party the
      // release just invited.
      closed.push(await setAttemptPhase(state, attempt.id, 'closed'));

      const task = state.getTask(attempt.taskId);
      // No task (deleted under a stale attempt): the close above is all there
      // is to do, and updateTask would throw NOT_FOUND.
      if (!task) continue;
      // Release ONLY the seat this attempt actually held. A row that has since
      // been handed to somebody else is that worker's live work, and yanking it
      // on the age of a superseded record would be exactly the "never yank a
      // live worker" violation this sweep must not commit. Closing the stale
      // attempt above is still right, and an already-unassigned row (a release
      // that got half-way) still needs its status routed below.
      if (task.assignedWorkerId && task.assignedWorkerId !== attempt.workerId) continue;
      // Context 'requeue', NOT the blocked sweep's 'park': park routes to
      // BACKLOG, which is human-gated and invisible to agents, so it would
      // yield no successor at all. Requeue returns the row to the column the
      // shared routing chooses (WORKING stays WORKING-unassigned, or → REVIEW
      // when every step is already done) where the next claim picks it up.
      await state.updateTask(task.id, {
        assignedWorkerId: null,
        status: nextStatusForRelease(task, 'requeue'),
      }, 'WORKER_TIMEOUT');

      // The status usually does NOT change here (WORKING → WORKING), and
      // updateTask only auto-releases the prior owner on a status change — so
      // clear the seat's back-pointer explicitly, exactly as the REVIEW
      // self-heal above does. A worker record still naming a row it no longer
      // owns reads as busy in list_workers and re-alerts in the stale watcher.
      // Preserve its real lastActivityAt: letting updateWorker stamp a fresh
      // one would resurrect a suspected corpse as "alive" and defeat the
      // Layer-3 prune that removes it once it owns nothing.
      const owner = state.workers.get(attempt.workerId);
      if (owner?.currentTaskId === task.id) {
        await state.updateWorker(owner.id, { currentTaskId: null, lastActivityAt: owner.lastActivityAt });
      }
    } catch (error) {
      logger.error(
        { error, attemptId: attempt.id, taskId: attempt.taskId },
        'Failed to close a reconciling attempt past its window; its task stays held'
      );
    }
  }
  return closed;
}

/** Mutex-wrapped entry point for the interval and for direct callers. */
export async function checkReconcileWindow(
  state: StateManager,
  nowMs = Date.now()
): Promise<ExecutionAttempt[]> {
  // Same reasoning as checkBlockedTimeouts: setAttemptPhase and updateTask are
  // themselves lock-free, so without this wrapper the background timer would
  // interleave with tool handlers at an await boundary — and a release racing a
  // reattachment is exactly the lost update this must not have. runExclusive is
  // reentrant, so a direct caller already holding the lock re-enters.
  return state.mutex.runExclusive(() => runReconcileWindowSweep(state, nowMs));
}

/**
 * Walk workers; for each with a stale assignment AND not previously alerted,
 * post a one-line ⚠️ message to #governors. Gated on a governor being alive
 * (alive = lastActivityAt within livenessTimeoutMs, team.role === 'governor').
 */
export async function checkStaleWorkers(state: StateManager, livenessTimeoutMs: number): Promise<void> {
  const now = Date.now();

  // Cheap pre-check: is any governor alive? If not, skip the whole loop.
  let governorAlive = false;
  for (const w of state.workers.values()) {
    const team = w.teamId ? state.teams.get(w.teamId) : null;
    if (team?.role !== 'governor') continue;
    const ts = w.lastActivityAt ? new Date(w.lastActivityAt).getTime() : 0;
    if (ts > 0 && now - ts <= livenessTimeoutMs) {
      governorAlive = true;
      break;
    }
  }
  if (!governorAlive) return;

  const seenKeys = new Set<string>();
  for (const w of state.workers.values()) {
    if (!w.currentTaskId) continue;
    const ts = w.lastActivityAt ? new Date(w.lastActivityAt).getTime() : 0;
    const sinceMs = ts === 0 ? Number.POSITIVE_INFINITY : now - ts;
    if (sinceMs <= livenessTimeoutMs) continue;

    const key = `${w.id}:${w.currentTaskId}`;
    seenKeys.add(key);
    if (state.alertedStaleAssignments.has(key)) continue;

    const secs = sinceMs === Number.POSITIVE_INFINITY ? 'unknown' : Math.floor(sinceMs / 1000) + 's';
    const task = state.getTask(w.currentTaskId);
    const taskTitle = task?.title || w.currentTaskId;
    const alert = `⚠️ ${w.id} stale on ${w.currentTaskId} (${taskTitle}) — last activity ${secs} ago. Quiet ≠ dead (long builds/tests are silent): ping before acting; never release on idle alone.`;
    try { await state.postToRoleChannel('governors', alert); } catch { /* never throw */ }
    state.alertedStaleAssignments.add(key);
  }

  // Clear memoization for assignments that are no longer stale (worker recovered
  // or task reassigned), so future staleness triggers a fresh alert.
  for (const key of state.alertedStaleAssignments) {
    if (!seenKeys.has(key)) state.alertedStaleAssignments.delete(key);
  }
}

/**
 * Scan workers with status=BLOCKED and auto-timeout if lastActivityAt exceeds threshold.
 */
export async function checkBlockedTimeouts(state: StateManager): Promise<void> {
  // Serialize the worker/task mutations on the SAME mutex every MCP handler
  // uses. updateTask/updateWorker/deleteWorker are themselves lock-free, so
  // without this wrapper this background timer would interleave with handlers
  // at an await boundary — a lost-update / DEAD→IDLE resurrection window.
  // runExclusive is reentrant (AsyncLocalStorage), so the nested deleteWorker
  // re-enters instead of deadlocking.
  await state.mutex.runExclusive(() => runBlockedTimeoutSweep(state));

  // In-memory waiter cleanup mutates no persisted state — keep it outside the
  // lock so it never participates in any state↔channel lock ordering.
  try {
    const staleWaitersCleaned = cleanupStaleWaiters(state);
    if (staleWaitersCleaned > 0) {
      logger.info({ staleWaitersCleaned }, 'Cleaned stale wait_for_task waiters');
    }
  } catch (error) {
    logger.error({ error }, 'Failed to clean stale wait_for_task waiters');
  }
  try {
    const staleResourceWaitersCleaned = cleanupStaleResourceWaiters(state);
    if (staleResourceWaitersCleaned > 0) {
      logger.info({ staleResourceWaitersCleaned }, 'Cleaned stale wait_for_resource waiters');
    }
  } catch (error) {
    logger.error({ error }, 'Failed to clean stale wait_for_resource waiters');
  }
}

/** Mutating body of checkBlockedTimeouts; always invoked under state.mutex. */
export async function runBlockedTimeoutSweep(state: StateManager): Promise<void> {
  const now = Date.now();
  for (const worker of state.workers.values()) {
    if (worker.status !== 'BLOCKED') continue;

    const lastActivity = worker.lastActivityAt ? new Date(worker.lastActivityAt).getTime() : 0;
    if (isNaN(lastActivity) || lastActivity === 0) continue;

    if (now - lastActivity > state.blockedTimeoutMs) {
      logger.info({ workerId: worker.id, blockedSince: worker.lastActivityAt }, 'Auto-timing out blocked worker');

      // Release any task this worker still owns BEFORE nulling its
      // currentTaskId. Otherwise the task stays WORKING/assigned to a
      // now-IDLE worker: stale cleanup can't run (the worker still "owns"
      // active work) and no other worker can claim it — a permanent orphan.
      // Context 'park': a blocked-timeout means nobody unblocked this worker
      // for the whole window — the blocker is almost certainly environmental,
      // so requeueing the task would hand the next agent the same wall
      // (claim → block → time out → release → claim…, an infinite thrash
      // loop). Park in-flight tasks (PLANNING/WORKING/REVIEW → BACKLOG) for
      // human triage instead; un-park via set_task_status.
      for (const owned of state.getTasksAssignedToWorker(worker.id)) {
        if (!ACTIVE_ASSIGNMENT_STATUSES.has(owned.status)) continue;
        // A resource-queued BLOCKED task is waiting legitimately — parking it
        // to BACKLOG would lose the auto-unblock-on-grant. Its bound is the
        // lease reaper (maxLeaseMs) plus queue-entry reaping, not this sweep.
        if (owned.status === 'BLOCKED' && owned.blockedResourceId) continue;
        // A dependency-waiting BLOCKED hold (a third-party block on an
        // assigned task, or a legacy still-assigned row — seat-freeing leaves
        // assignee-reported blocks unassigned) keeps its BLOCKED status: its
        // bound is the dependency auto-unblock, which only scans BLOCKED rows,
        // so a park to BACKLOG would strand it past its deps landing. But the
        // SEAT is released — the worker is being timed out as a corpse right
        // below, and a row left assigned to it would be restored by the
        // auto-unblock onto a now-IDLE record: unclaimable (isTaskClaimable
        // needs the owner missing or DEAD) and unprunable (Layer 3 keeps a
        // worker that "owns active work") until a daemon restart.
        if (
          owned.status === 'BLOCKED'
          && Array.isArray(owned.blockedOnTaskIds)
          && owned.blockedOnTaskIds.length > 0
        ) {
          await state.updateTask(owned.id, { assignedWorkerId: null }, 'WORKER_TIMEOUT');
          continue;
        }
        await state.updateTask(owned.id, {
          assignedWorkerId: null,
          status: nextStatusForRelease(owned, 'park'),
        }, 'WORKER_TIMEOUT');
      }

      await state.updateWorker(worker.id, {
        status: 'IDLE',
        lastError: null,
        currentTaskId: null,
      }, 'WORKER_TIMEOUT');
    }
  }

  // REVIEW self-heal: a hard-crashed QA (no graceful deregister) is not DEAD
  // and still "owns" its REVIEW task, so isTaskClaimable stays false and no
  // other QA can pick it up — the task strands (regression window opened when
  // the idle liveness sweep was removed in 3d2cb16). Scoped to REVIEW ONLY
  // (there is no active coding to interrupt there), release a REVIEW task
  // whose owner has gone silent past reviewStaleTimeoutMs. WORKING/PLANNING
  // assignments are deliberately never yanked by staleness — that is exactly
  // what 3d2cb16 fixed (stealing tasks off long-running coders).
  for (const task of state.tasks.values()) {
    if (task.status !== 'REVIEW' || !task.assignedWorkerId) continue;
    const owner = state.workers.get(task.assignedWorkerId);
    // Missing owner → already claimable via isTaskClaimable; DEAD → handled by
    // claim takeover / the record prune. Only act on a present, non-DEAD owner.
    if (!owner || owner.status === 'DEAD') continue;
    const ownerLast = owner.lastActivityAt ? new Date(owner.lastActivityAt).getTime() : 0;
    if (isNaN(ownerLast) || ownerLast === 0) continue;
    if (now - ownerLast <= state.reviewStaleTimeoutMs) continue;

    logger.info(
      { taskId: task.id, workerId: owner.id, lastActivityAt: owner.lastActivityAt },
      'Releasing REVIEW task from stale owner so another QA can claim it'
    );
    // Status stays REVIEW (nextStatusForRelease(REVIEW) === 'REVIEW'); we only
    // clear the assignment. Because there's no status change, updateTask does
    // NOT auto-release the prior owner, so clear its currentTaskId here too
    // (matters when reviewStaleTimeoutMs is set shorter than the stale-worker
    // prune; at the default they're equal and Layer-3 prunes the owner below).
    // Preserve the owner's real lastActivityAt: letting updateWorker stamp a
    // fresh one would resurrect the crashed QA as "alive" and defeat the
    // same-sweep Layer-3 prune this comment promises.
    await state.updateTask(task.id, { assignedWorkerId: null }, 'WORKER_TIMEOUT');
    if (owner.currentTaskId === task.id) {
      await state.updateWorker(owner.id, { currentTaskId: null, lastActivityAt: owner.lastActivityAt });
    }
  }

  // Dependency-unblock backstop: task-keyed (works on UNASSIGNED rows, which
  // the worker-keyed pass above never visits). Restores BLOCKED tasks whose
  // blockedOnTaskIds are all DONE/ARCHIVED — this is what repairs rows whose
  // prerequisite landed before this sweep existed, or while the daemon was
  // down. Resource-parked rows (blockedResourceId) are skipped inside; their
  // bound is the lease reaper below. Never throws.
  try {
    const depUnblocked = await runDependencyUnblock(state);
    if (depUnblocked.length > 0) {
      logger.info({ taskIds: depUnblocked }, 'Dependency sweep un-blocked tasks with satisfied blockedOnTaskIds');
    }
  } catch (error) {
    logger.error({ error }, 'Failed to run dependency-unblock sweep');
  }

  // Visibility (alert only, never auto-park): page #governors once per block
  // instance for resource-less BLOCKED rows past their age line — dep-less
  // rows (no machine on their side), dep-waiting rows whose prerequisite is
  // itself BLOCKED/BACKLOG (a cycle or a parked prerequisite: the auto-unblock
  // cannot fire without a human), and dep-waiting rows past the general bound.
  try {
    await alertStaleBlocks(state, now);
  } catch (error) {
    logger.error({ error }, 'Failed to alert stale blocks');
  }

  // Shared-resource hygiene: force-release leases past their hard cap, drop
  // leases/queue entries whose task left the active statuses, and grant the
  // freed capacity onward. Runs under the same mutex as the rest of the sweep.
  try {
    const reaped = await reapResources(state, now);
    if (reaped > 0) {
      logger.info({ reaped }, 'Reaped stale resource leases/queue entries');
    }
  } catch (error) {
    logger.error({ error }, 'Failed to reap resources');
  }

  // Layer 3: Sweep stale workers whose lastActivityAt exceeds threshold
  let deletedCount = 0;
  for (const worker of Array.from(state.workers.values())) {
    const lastActivity = worker.lastActivityAt ? new Date(worker.lastActivityAt).getTime() : 0;
    if (isNaN(lastActivity) || lastActivity === 0) continue;

    if (now - lastActivity > state.staleWorkerTimeoutMs) {
      if (!isWorkerEligibleForStaleCleanup(state, worker)) {
        const assignedTaskIds = state.getTasksAssignedToWorker(worker.id).map((task) => task.id);
        logger.warn(
          { workerId: worker.id, lastActivityAt: worker.lastActivityAt, status: worker.status, assignedTaskIds },
          'Worker exceeded stale timeout but owns or may own active work; preserving worker and task assignment'
        );
        continue;
      }

      logger.info({ workerId: worker.id, lastActivityAt: worker.lastActivityAt }, 'Deleting stale worker (exceeded timeout)');
      await state.deleteWorker(worker.id);
      deletedCount++;
    }
  }
  if (deletedCount > 0) {
    state.emit({ type: 'STATE_SNAPSHOT', payload: state.getSnapshot() });
  }
}

/** Pure predicate - takes no state handle because it reads none. */
export function isStaleResolvedProposal(proposal: RailProposal, ageMs: number, nowMs: number): boolean {
  if (proposal.status !== 'APPROVED' && proposal.status !== 'REJECTED') {
    return false;
  }

  if (!proposal.resolvedAt) {
    return false;
  }

  const resolvedAtMs = Date.parse(proposal.resolvedAt);
  if (Number.isNaN(resolvedAtMs)) {
    return false;
  }

  return nowMs - resolvedAtMs > ageMs;
}

export async function purgeResolvedProposals(state: StateManager, nowMs = Date.now()): Promise<number> {
  let purgedCount = 0;
  const proposalEntries = Array.from(state.proposals.entries());

  for (const [proposalId, proposal] of proposalEntries) {
    if (!isStaleResolvedProposal(proposal, PROPOSAL_PURGE_AGE_MS, nowMs)) {
      continue;
    }

    const filePath = path.join(state.moePath, 'proposals', `${proposalId}.json`);
    try {
      if (fs.existsSync(filePath)) {
        // Suppress the watcher echo so our own delete doesn't re-trigger load().
        state.fileWatcher?.ignorePath(filePath);
        fs.unlinkSync(filePath);
      }
    } catch (error) {
      const fsError = error as NodeJS.ErrnoException;
      if (fsError.code !== 'ENOENT') {
        logger.warn({ error, proposalId }, 'Failed to delete stale proposal file');
        continue;
      }
    }

    state.proposals.delete(proposalId);
    state.appendActivity('PROPOSAL_PURGED', {
      proposalId,
      status: proposal.status,
      resolvedAt: proposal.resolvedAt
    });
    purgedCount++;
  }

  return purgedCount;
}

export function isWorkerEligibleForStaleCleanup(state: StateManager, worker: Worker): boolean {
  // A DEAD worker is always prunable: its tasks were released on deregister,
  // and if a release failed mid-way (leaving a dangling assignment), the
  // deleteWorker cascade clears that assignment (task stays put, unassigned →
  // claimable). Without this short-circuit a DEAD worker that still "owns" an
  // active task would never be pruned (hasActiveTaskAssignment would veto it).
  if (worker.status === 'DEAD') return true;
  // Otherwise (the caller has already confirmed the worker is stale past the
  // timeout) prune iff it holds no active task — regardless of status. A
  // crashed, task-less GOVERNING/CODING/PLANNING worker must not linger
  // forever just because its status isn't on a hardcoded allowlist.
  return !state.hasActiveTaskAssignment(worker.id);
}
