// =============================================================================
// Worker store - worker records, presence and task claimability
// =============================================================================
//
// Extracted verbatim from StateManager.
//
// CLAIMABILITY IS SAFETY-CRITICAL and must not drift. isTaskClaimable keys
// STRICTLY on the owner being missing from the worker map or explicitly DEAD -
// never on idle time for WORKING/PLANNING, because a quiet worker is usually
// mid-build, not gone. isTaskAssignedToInactiveWorker stays a SEPARATE
// display-only signal; conflating the two would let the fleet yank tasks off
// live workers.
//
// updateWorker preserves lastActivityAt on the DEAD transition (so a crashed
// worker is not gifted a fresh heartbeat) and emits WORKER_DELETED rather than
// WORKER_UPDATED. purgeAllWorkers runs on every daemon start and keeps its
// per-worker try/catch: one unwritable record must not abort startup for the
// rest of the fleet.
//
// Import direction: this module imports nextStatusForRelease from
// ./workerLifecycle.js, while workerLifecycle calls back through the `state`
// handle. That keeps the runtime edge one-way.

import fs from 'fs';
import path from 'path';
import type { StateManager } from './StateManager.js';
import type { ActivityEventType, Task, TaskStatus, Worker } from '../types/schema.js';
import { logger } from '../util/logger.js';
import { nextStatusForRelease, isWorkerAlive } from './workerLifecycle.js';
import { withEvictionTombstones } from '../util/teamMembershipHeal.js';

// BLOCKED counts as an active hold: a worker parked on a resource queue still
// owns its task (one-task-per-worker), so claim_next_task keeps returning
// alreadyAssigned for it and the wrapper idles instead of taking second work.
const ACTIVE_ASSIGNMENT_STATUSES = new Set<TaskStatus>(['PLANNING', 'WORKING', 'REVIEW', 'BLOCKED']);

/**
 * A task is exposed as claimable when it is unassigned, or when the recorded
 * assignee is orphaned (no worker record exists). The claim path repairs the
 * orphan before assigning the next worker.
 */
export function isTaskClaimable(state: StateManager, task: Task): boolean {
  return !task.assignedWorkerId || state.isTaskAssignedToInactiveWorker(task);
}

export function isTaskAssignedToMissingWorker(state: StateManager, task: Task): boolean {
  return Boolean(task.assignedWorkerId && !state.workers.has(task.assignedWorkerId));
}

/**
 * Assigned to a worker that is present in the map but has been marked DEAD
 * (graceful deregister). Keyed on the explicit DEAD status, NOT on raw idle
 * time — a worker that is merely quiet (e.g. mid a long build/test,
 * lastActivityAt past the 120s presence window) is still ALIVE and must keep
 * its task. Death is established only by deregister, which already releases
 * the task (null assignedWorkerId). This predicate is a defensive backstop
 * for the rare assigned-to-DEAD race.
 */
export function isTaskAssignedToDeadWorker(state: StateManager, task: Task): boolean {
  if (!task.assignedWorkerId) return false;
  const worker = state.workers.get(task.assignedWorkerId);
  return worker?.status === 'DEAD';
}

/**
 * Assigned to a worker that can no longer act on it — either missing from the
 * map or marked DEAD. The single predicate the claim path and claimability
 * use so a gone owner never blocks a claim. Deliberately does NOT include
 * "alive but idle": reclaiming a quiet-but-live worker's in-flight task would
 * yank it mid-operation. Such a worker is released only when it becomes DEAD.
 */
export function isTaskAssignedToInactiveWorker(state: StateManager, task: Task): boolean {
  return state.isTaskAssignedToMissingWorker(task) || state.isTaskAssignedToDeadWorker(task);
}

export function getTasksAssignedToWorker(state: StateManager, workerId: string): Task[] {
  return Array.from(state.tasks.values()).filter((task) => task.assignedWorkerId === workerId);
}

/** @internal - reached by the extracted state/* modules; not part of the supported API. */
export function hasActiveTaskAssignment(state: StateManager, workerId: string): boolean {
  return state.getTasksAssignedToWorker(workerId).some((task) => ACTIVE_ASSIGNMENT_STATUSES.has(task.status));
}

/** Tasks assigned to a worker that are in an active column (PLANNING/WORKING/REVIEW). */
export function getActiveTasksAssignedToWorker(state: StateManager, workerId: string): Task[] {
  return state.getTasksAssignedToWorker(workerId).filter((task) => ACTIVE_ASSIGNMENT_STATUSES.has(task.status));
}

export async function touchWorker(state: StateManager, workerId?: string | null, updates: Partial<Worker> = {}, event?: ActivityEventType): Promise<Worker | null> {
  if (!workerId) {
    return null;
  }
  // Serialize on the state mutex (reentrant — already-locked callers pass
  // straight through). Blocking tools (wait_for_task / chat_wait) call this
  // from raw timer callbacks with NO lock held; an unlocked read-modify-write
  // here can interleave with a concurrent deregister at the writeEntity await
  // and resurrect the DEAD worker by writing the stale ALIVE record back.
  return state.mutex.runExclusive(async () => {
    if (!state.workers.has(workerId)) {
      return null;
    }
    // Never refresh a DEAD worker's heartbeat: an in-flight tool call must not
    // reset its prune clock (lastActivityAt) and resurrect it in the UI.
    if (state.workers.get(workerId)?.status === 'DEAD') {
      return null;
    }
    try {
      return await state.updateWorker(workerId, updates, event);
    } catch (error) {
      logger.warn({ workerId, error }, 'Failed to refresh worker heartbeat');
      return null;
    }
  });
}

/**
 * Get all workers that are currently assigned to tasks in a specific epic.
 */
export function getWorkersByEpic(state: StateManager, epicId: string): Worker[] {
  const workerIds = new Set<string>();
  for (const task of state.tasks.values()) {
    if (task.epicId === epicId && task.assignedWorkerId) {
      workerIds.add(task.assignedWorkerId);
    }
  }
  return Array.from(workerIds)
    .map((id) => state.workers.get(id))
    .filter((w): w is Worker => w !== undefined);
}

export async function createWorker(state: StateManager, input: {
  id: string;
  type: Worker['type'];
  projectId: string;
  epicId: string;
  currentTaskId: string | null;
  status: Worker['status'];
}): Promise<Worker> {
  // Validate worker doesn't already exist
  if (state.workers.has(input.id)) {
    throw new Error(`Worker already exists: ${input.id}`);
  }

  const now = new Date().toISOString();
  const worker: Worker = {
    id: input.id,
    type: input.type,
    projectId: input.projectId,
    epicId: input.epicId,
    currentTaskId: input.currentTaskId,
    status: input.status,
    branch: '',
    modifiedFiles: [],
    startedAt: now,
    lastActivityAt: now,
    lastError: null,
    errorCount: 0,
    teamId: null
  };

  await state.writeEntity('workers', worker.id, worker);
  state.workers.set(worker.id, worker);
  state.appendActivity('WORKER_CREATED', { workerId: worker.id, type: worker.type }, undefined, worker);
  state.emit({ type: 'WORKER_CREATED', payload: worker });
  return worker;
}

export async function updateWorker(state: StateManager, workerId: string, updates: Partial<Worker>, event?: ActivityEventType): Promise<Worker> {
  const worker = state.workers.get(workerId);
  if (!worker) {
    throw new Error(`Worker not found: ${workerId}`);
  }

  // Marking a worker DEAD is not "activity" — preserve its real lastActivityAt
  // so staleness/pruning and display stay accurate. Any other update bumps it,
  // unless the caller passes an explicit lastActivityAt (system-side repairs
  // like the REVIEW self-heal, which must not gift a crashed worker a fresh
  // heartbeat and resurrect it as "alive").
  const becomingDead = updates.status === 'DEAD';
  const updated: Worker = {
    ...worker,
    ...updates,
    lastActivityAt: becomingDead
      ? worker.lastActivityAt
      : (updates.lastActivityAt ?? new Date().toISOString())
  };

  await state.writeEntity('workers', workerId, updated);
  state.workers.set(workerId, updated);
  if (event) {
    state.appendActivity(event, updates, undefined, updated);
  }
  // A DEAD worker is dropped from the UI immediately: emit WORKER_DELETED so
  // boards remove it, while the record is retained server-side (idempotent
  // re-deregister + later pruned once it owns nothing). getSnapshot also
  // excludes DEAD workers so reconnects/snapshots never resurface it.
  if (updated.status === 'DEAD') {
    state.emit({ type: 'WORKER_DELETED', payload: updated });
  } else {
    state.emit({ type: 'WORKER_UPDATED', payload: updated });
  }
  return updated;
}

/**
 * Atomically merge cursor updates into a worker's chatCursors.
 * Reads current cursors, merges, and writes back within the mutex.
 */
export async function updateWorkerCursors(state: StateManager, workerId: string, cursorUpdates: Record<string, string>): Promise<void> {
  await state.mutex.runExclusive(async () => {
    const worker = state.workers.get(workerId);
    if (!worker) return; // Silently skip if worker doesn't exist

    const merged = { ...(worker.chatCursors || {}), ...cursorUpdates };
    const updated: Worker = {
      ...worker,
      chatCursors: merged,
      lastActivityAt: new Date().toISOString()
    };

    await state.writeEntity('workers', workerId, updated);
    state.workers.set(workerId, updated);
    state.emit({ type: 'WORKER_UPDATED', payload: updated });
  });
}

/**
 * Delete a worker: remove from memory, disk, clear references on tasks and teams.
 */
export async function deleteWorker(state: StateManager, workerId: string): Promise<void> {
  await state.mutex.runExclusive(async () => {
    const worker = state.workers.get(workerId);
    if (!worker) return;

    // Remove from memory
    state.workers.delete(workerId);

    // Remove from disk
    const filePath = path.join(state.moePath, 'workers', `${workerId}.json`);
    try {
      if (fs.existsSync(filePath)) {
        // Suppress the watcher echo so our own delete doesn't re-trigger load().
        state.fileWatcher?.ignorePath(filePath);
        fs.unlinkSync(filePath);
      }
    } catch (error) {
      logger.error({ error, workerId }, 'Failed to delete worker file');
    }

    // Clear assignedWorkerId on tasks referencing this worker, routing status
    // via nextStatusForRelease (same as purgeAllWorkers): WORKING stays
    // WORKING-unassigned (exactly what workers claim — the launcher status
    // maps are worker→WORKING, architect→PLANNING, qa→REVIEW), or → REVIEW
    // when every step is done so finished work goes to QA, not back to a
    // worker. Route through updateTask (not a hand-rolled write) so
    // TASK_UPDATED is emitted — boards refresh and parked wait_for_task
    // waiters wake for the newly claimable task.
    for (const task of Array.from(state.tasks.values())) {
      if (task.assignedWorkerId !== workerId) continue;
      try {
        await state.updateTask(task.id, {
          assignedWorkerId: null,
          status: nextStatusForRelease(task),
        }, 'WORKER_RELEASED');
      } catch (error) {
        logger.error({ error, taskId: task.id }, 'Failed to update task after worker deletion');
      }
    }

    // Remove from team memberIds, leaving a tombstone. The record (and with it
    // worker.teamId) is gone, so the team is the only place membership can
    // survive an eviction — see util/teamMembershipHeal.ts.
    for (const team of state.teams.values()) {
      if (team.memberIds.includes(workerId)) {
        const updated = {
          ...team,
          memberIds: team.memberIds.filter((id) => id !== workerId),
          formerMemberIds: withEvictionTombstones(team, [workerId]),
          updatedAt: new Date().toISOString()
        };
        state.teams.set(team.id, updated);
        try {
          await state.writeEntity('teams', team.id, updated);
        } catch (error) {
          logger.error({ error, teamId: team.id }, 'Failed to update team after worker deletion');
        }
      }
    }

    // Clean up unread counts for this worker
    state.unreadCounts.delete(workerId);

    state.appendActivity('WORKER_DISCONNECTED', { workerId: worker.id }, undefined, worker);
    state.emit({ type: 'WORKER_DELETED', payload: worker });
  });
}

/**
 * Purge all workers at startup. Since the daemon is (re)starting,
 * no workers are connected yet — all existing files are guaranteed stale.
 * Any remaining task assignments are orphaned after the purge, so clear them
 * explicitly with activity events to make the tasks claimable.
 */
export async function purgeAllWorkers(state: StateManager): Promise<void> {
  await state.mutex.runExclusive(async () => {
    const workersDir = path.join(state.moePath, 'workers');
    let deletedCount = 0;

    // Delete all worker files from disk
    try {
      if (fs.existsSync(workersDir)) {
        const files = fs.readdirSync(workersDir).filter((f) => f.endsWith('.json'));
        for (const file of files) {
          try {
            const workerFile = path.join(workersDir, file);
            // Suppress the watcher echo so our own delete doesn't re-trigger load().
            state.fileWatcher?.ignorePath(workerFile);
            fs.unlinkSync(workerFile);
            deletedCount++;
          } catch (error) {
            logger.error({ error, file }, 'Failed to delete worker file during purge');
          }
        }
      }
    } catch (error) {
      logger.error({ error }, 'Failed to read workers directory during purge');
    }

    // Clear workers map
    state.workers.clear();

    // Clear assignedWorkerId references that are now orphaned.
    let clearedAssignments = 0;
    for (const task of state.tasks.values()) {
      if (task.assignedWorkerId && state.isTaskAssignedToMissingWorker(task)) {
        const previousWorkerId = task.assignedWorkerId;
        // Route the status too via nextStatusForRelease: WORKING stays
        // WORKING-unassigned — that IS the claimable state for workers
        // (their claim filter is statuses:["WORKING"]) — or → REVIEW when
        // every step is done, handing finished work to QA. After a daemon
        // restart the relaunched fleet re-claims these tasks and resumes
        // from the plan's step statuses (a crash release records no
        // handoff note) instead of stalling in a human-gated column.
        const updated = {
          ...task,
          assignedWorkerId: null,
          status: nextStatusForRelease(task),
          updatedAt: new Date().toISOString(),
        };
        state.tasks.set(task.id, updated);
        try {
          await state.writeEntity('tasks', task.id, updated);
          state.appendActivity('WORKER_DISCONNECTED', {
            workerId: previousWorkerId,
            reason: 'startup-worker-purge'
          }, updated);
          state.emit({ type: 'TASK_UPDATED', payload: updated });
          clearedAssignments++;
        } catch (error) {
          logger.error({ error, taskId: task.id }, 'Failed to clear orphan task assignedWorkerId during worker purge');
        }
      }
    }

    // Clear stale memberIds from teams; all worker records have been purged.
    // Each cleared id is tombstoned so a returning worker rejoins its own team
    // instead of coming back as a solo — see util/teamMembershipHeal.ts.
    for (const team of state.teams.values()) {
      if (team.memberIds.length === 0) continue;
      const updated = {
        ...team,
        memberIds: [],
        formerMemberIds: withEvictionTombstones(team, team.memberIds),
        updatedAt: new Date().toISOString()
      };
      state.teams.set(team.id, updated);
      try {
        await state.writeEntity('teams', team.id, updated);
        state.emit({ type: 'TEAM_UPDATED', payload: updated });
      } catch (error) {
        logger.error({ error, teamId: team.id }, 'Failed to clear team memberIds during purge');
      }
    }

    if (deletedCount > 0) {
      logger.info({ count: deletedCount, clearedAssignments }, 'Purged stale workers from previous run');
    } else if (clearedAssignments > 0) {
      logger.info({ clearedAssignments }, 'Cleared orphan task assignments during worker purge');
    }
  });
}
