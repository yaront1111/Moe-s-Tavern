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
import type { RailProposal, TaskStatus, Worker } from '../types/schema.js';
import { logger } from '../util/logger.js';
import { isWorkerAlive, nextStatusForRelease } from './workerLifecycle.js';
import { cleanupStaleWaiters } from '../tools/waitForTask.js';

// Copied verbatim from StateManager: the statuses that count as an ACTIVE
// assignment for stale-worker cleanup. Kept in sync by step-9's move.
const ACTIVE_ASSIGNMENT_STATUSES = new Set<TaskStatus>(['PLANNING', 'WORKING', 'REVIEW']);

const DAY_IN_MS = 24 * 60 * 60 * 1000;
export const PROPOSAL_PURGE_AGE_MS = parseInt(process.env.MOE_PROPOSAL_PURGE_AGE_MS || `${7 * DAY_IN_MS}`, 10);
export const PROPOSAL_PURGE_INTERVAL_MS = parseInt(process.env.MOE_PROPOSAL_PURGE_INTERVAL_MS || `${DAY_IN_MS}`, 10);
export const PROPOSAL_SNAPSHOT_RETENTION_MS = parseInt(process.env.MOE_PROPOSAL_SNAPSHOT_RETENTION_MS || `${DAY_IN_MS}`, 10);

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
        if (ACTIVE_ASSIGNMENT_STATUSES.has(owned.status)) {
          await state.updateTask(owned.id, {
            assignedWorkerId: null,
            status: nextStatusForRelease(owned, 'park'),
          }, 'WORKER_TIMEOUT');
        }
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
