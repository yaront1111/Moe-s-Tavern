// =============================================================================
// Dependency auto-unblock — the task-dependency analogue of the resource grant
// path (resourceStore.grantNextLeases). A task BLOCKED with blockedOnTaskIds is
// waiting on other tasks; when every listed prerequisite is DONE/ARCHIVED the
// daemon restores it to blockedFromStatus. That single status write is what
// wakes the fleet: TASK_UPDATED wakes wait_for_task waiters, and (for a legacy
// still-assigned row) the wrapper's next claim poll resumes the held task.
//
// Two entry points, one scan:
//   - event-driven: taskStore.updateTask calls runDependencyUnblock on any
//     transition to DONE/ARCHIVED (covers qa_approve, set_task_status,
//     archive_task/epic, board drags — every path funnels through updateTask);
//   - sweep backstop: runBlockedTimeoutSweep calls the same scan each pass,
//     which is what repairs rows that were blocked BEFORE their prerequisite
//     landed (or before this feature existed, once the ids are backfilled).
//
// Resource-parked rows (blockedResourceId set) are NEVER touched here — their
// unblock is owned by the grant path, and double-restoring would race it.
//
// Callers hold the global state mutex (updateTask callers and the sweep both
// run under it); the module takes no lock of its own. The re-entrancy guard
// exists because the restore writes go back through state.updateTask: a
// restored status is never DONE/ARCHIVED so the hook cannot re-fire off a
// restore, but a hand-edited task file with garbage in blockedFromStatus must
// not be able to build a recursion tower either.

import type { StateManager } from './StateManager.js';
import type { Task, TaskStatus } from '../types/schema.js';
import { logger } from '../util/logger.js';

/** A dependency is satisfied when its task is DONE/ARCHIVED — or gone (deleted ids must not wedge a row forever). */
export function isDependencySatisfied(state: StateManager, taskId: string): boolean {
  const dep = state.getTask(taskId);
  return !dep || dep.status === 'DONE' || dep.status === 'ARCHIVED';
}

/** The subset of `task.dependsOn` not yet satisfied. Empty for tasks with no declared deps. */
export function unmetDependsOn(state: StateManager, task: Pick<Task, 'dependsOn'>): string[] {
  const ids = Array.isArray(task.dependsOn) ? task.dependsOn : [];
  return ids.filter((id) => !isDependencySatisfied(state, id));
}

/** The subset of `task.blockedOnTaskIds` not yet satisfied. */
export function unmetBlockedOnTaskIds(state: StateManager, task: Pick<Task, 'blockedOnTaskIds'>): string[] {
  const ids = Array.isArray(task.blockedOnTaskIds) ? task.blockedOnTaskIds : [];
  return ids.filter((id) => !isDependencySatisfied(state, id));
}

/**
 * Every outgoing dependency edge of a task: dependsOn ∪ blockedOnTaskIds. Both
 * fields gate the same thing (this row cannot progress until the target is
 * DONE/ARCHIVED), so a cycle through either — or a mix — starves identically.
 */
export function dependencyEdges(task: Pick<Task, 'dependsOn' | 'blockedOnTaskIds'>): string[] {
  const out: string[] = [];
  if (Array.isArray(task.dependsOn)) out.push(...task.dependsOn);
  if (Array.isArray(task.blockedOnTaskIds)) out.push(...task.blockedOnTaskIds);
  return out;
}

/**
 * Follow dependency edges (dependsOn ∪ blockedOnTaskIds) from `fromId` and
 * return the path to `targetId` — `[fromId, …, targetId]` — when it is
 * reachable, else null. Adding the edge `targetId → fromId` would close a
 * dependency cycle exactly when this returns a path: the three writers
 * (set_task_dependencies, create_task, report_blocked) all ask this one
 * question before recording an id. Edges OUT of DONE/ARCHIVED rows are not
 * followed — a satisfied prerequisite gates nothing, so no live cycle runs
 * through it (A DONE with dependsOn [B] must not forbid B depending on A).
 * The board lives in memory; an iterative visited-set walk is O(tasks).
 */
export function findDependencyPath(state: StateManager, fromId: string, targetId: string): string[] | null {
  if (fromId === targetId) return [fromId];
  const parent = new Map<string, string | null>([[fromId, null]]);
  const stack: string[] = [fromId];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (id === targetId) {
      const path: string[] = [];
      for (let cur: string | null = id; cur !== null; cur = parent.get(cur) ?? null) path.push(cur);
      return path.reverse();
    }
    const node = state.getTask(id);
    if (!node || node.status === 'DONE' || node.status === 'ARCHIVED') continue;
    for (const next of dependencyEdges(node)) {
      if (parent.has(next)) continue;
      parent.set(next, id);
      stack.push(next);
    }
  }
  return null;
}

/** `[taskId, …path]` rendered as `a → b → a` for error/warning text. */
export function formatDependencyCycle(taskId: string, pathFromDep: string[]): string {
  return [taskId, ...pathFromDep].join(' → ');
}

/** Per-instance re-entrancy guard: a scan must not start another scan. */
const scanning = new WeakSet<StateManager>();

/**
 * Scan every BLOCKED task carrying blockedOnTaskIds (and no blockedResourceId)
 * and restore the ones whose dependencies are now ALL satisfied. Returns the
 * ids of the tasks that were unblocked. Never throws — one bad row must not
 * kill the DONE transition (or sweep pass) that triggered the scan.
 */
export async function runDependencyUnblock(state: StateManager, triggerTaskId?: string): Promise<string[]> {
  if (scanning.has(state)) return [];
  scanning.add(state);
  const unblocked: string[] = [];
  try {
    for (const task of Array.from(state.tasks.values())) {
      if (task.status !== 'BLOCKED') continue;
      // Resource-parked rows are owned by the grant path (grantNextLeases).
      if (task.blockedResourceId) continue;
      const ids = Array.isArray(task.blockedOnTaskIds) ? task.blockedOnTaskIds : [];
      if (ids.length === 0) continue;
      if (unmetBlockedOnTaskIds(state, task).length > 0) continue;

      const restored: TaskStatus = task.blockedFromStatus ?? 'WORKING';
      // Defensive: a hand-edited blockedFromStatus of DONE/ARCHIVED would
      // re-fire the updateTask hook (the WeakSet guard absorbs it, but the
      // restore itself would be nonsense) — route it to WORKING instead.
      const safeRestored: TaskStatus =
        restored === 'DONE' || restored === 'ARCHIVED' || restored === 'BLOCKED' ? 'WORKING' : restored;
      // assignedWorkerId passed explicitly, mirroring grantNextLeases:
      // updateTask would otherwise clear the assignment on the status change.
      // Under seat-freeing the seat is already null (task returns unassigned
      // and claimable). A still-assigned hold (resource-style, third-party
      // block, legacy row) returns to its worker ONLY while that worker still
      // exists, is not DEAD, and its own pointer still names this task — the
      // genuine two-pointer hold. Otherwise the task returns UNASSIGNED:
      // restoring it onto a missing/DEAD/IDLE-with-no-pointer record would
      // make it permanently unclaimable (isTaskClaimable needs the owner
      // missing or DEAD; an IDLE corpse is neither) while the Layer-3 prune
      // refuses to delete a worker that "owns active work" — starvation until
      // a daemon restart, with no alert.
      const owner = task.assignedWorkerId ? state.getWorker(task.assignedWorkerId) : null;
      const restoreTo =
        owner && owner.status !== 'DEAD' && owner.currentTaskId === task.id ? owner.id : null;
      try {
        await state.updateTask(task.id, {
          status: safeRestored,
          assignedWorkerId: restoreTo,
          blockedReason: null,
          blockedResourceId: null,
          blockedOnTaskIds: null,
          blockedFromStatus: null,
          blockedAt: null,
        }, 'TASK_UNBLOCKED');
        unblocked.push(task.id);
        const via = triggerTaskId ? ` (${triggerTaskId} landed)` : ' (dependency sweep)';
        const msg = `🟢 ${task.id} un-blocked → ${safeRestored}: all blockedOnTaskIds [${ids.join(', ')}] are DONE/ARCHIVED${via}.`;
        try { await state.postSystemMessage(task.id, msg); } catch { /* best-effort */ }
        try { await state.postToGeneral(msg); } catch { /* best-effort */ }
      } catch (err) {
        logger.warn({ taskId: task.id, error: err }, 'dependencyUnblock: failed to un-block task');
      }
    }
  } finally {
    scanning.delete(state);
  }
  return unblocked;
}

/**
 * Memo of #governors alerts already posted, keyed `taskId:blockedAt` so a
 * re-block (new blockedAt) alerts again while a standing block alerts once.
 */
const alertedStaleBlocks = new WeakMap<StateManager, Set<string>>();

/** Prerequisite statuses that make no progress on their own — a human must move them. */
const NON_PROGRESSING_STATUSES = new Set<TaskStatus>(['BLOCKED', 'BACKLOG']);

/**
 * Multiplier on state.blockedTimeoutMs for the general age bound on a
 * dependency-waiting block whose prerequisites are still moving: patience for
 * a slow prerequisite, but not forever.
 */
export const DEPENDENCY_WAIT_ALERT_MULTIPLIER = 2;

/**
 * Visibility pass for stale blocks (resource-parked rows excluded — the lease
 * reaper bounds those). Three classes draw one line in #governors per block
 * instance; alert ONLY — never auto-park, the un-park decision is human triage
 * (set_task_status / unblock paths / promote the prerequisite):
 *   - dep-less rows past blockedTimeoutMs: no machine is on their side, nothing
 *     will ever auto-unblock them;
 *   - dep-waiting rows past blockedTimeoutMs whose unmet prerequisite is itself
 *     BLOCKED or BACKLOG: the auto-unblock cannot fire until a human moves the
 *     prerequisite — this is what makes a block cycle (A waits on B, B waits on
 *     A) or a BACKLOG-parked prerequisite visible instead of silently eternal;
 *   - dep-waiting rows past DEPENDENCY_WAIT_ALERT_MULTIPLIER × blockedTimeoutMs
 *     regardless: the general age bound.
 * Rows whose deps are all satisfied are skipped — runDependencyUnblock (which
 * the sweep runs first) owns them.
 */
export async function alertStaleBlocks(state: StateManager, nowMs: number = Date.now()): Promise<number> {
  let memo = alertedStaleBlocks.get(state);
  if (!memo) {
    memo = new Set<string>();
    alertedStaleBlocks.set(state, memo);
  }

  const liveKeys = new Set<string>();
  let alerted = 0;
  for (const task of state.tasks.values()) {
    if (task.status !== 'BLOCKED') continue;
    if (task.blockedResourceId) continue;
    const blockedAtMs = task.blockedAt ? Date.parse(task.blockedAt) : NaN;
    if (Number.isNaN(blockedAtMs)) continue;
    const ageMs = nowMs - blockedAtMs;
    if (ageMs <= state.blockedTimeoutMs) continue;
    const ageMin = Math.floor(ageMs / 60_000);

    const deps = Array.isArray(task.blockedOnTaskIds) ? task.blockedOnTaskIds : [];
    let alert: string;
    if (deps.length === 0) {
      alert =
        `⚠️ ${task.id} (${task.title}) has been BLOCKED ${ageMin}m with no blockedOnTaskIds and no resource — ` +
        `nothing will auto-unblock it. Reason: ${task.blockedReason ?? '(none recorded)'}. ` +
        `Triage: moe.set_task_status to restore it, or re-file the block with blockedOnTaskIds if it waits on other tasks.`;
    } else {
      const unmet = unmetBlockedOnTaskIds(state, task);
      if (unmet.length === 0) continue;
      const described = unmet.map((id) => `${id} [${state.getTask(id)?.status ?? 'missing'}]`);
      const stuck = unmet.filter((id) => {
        const dep = state.getTask(id);
        return !!dep && NON_PROGRESSING_STATUSES.has(dep.status);
      });
      if (stuck.length > 0) {
        alert =
          `⚠️ ${task.id} (${task.title}) has been BLOCKED ${ageMin}m waiting on ${described.join(', ')} — ` +
          `prerequisite(s) ${stuck.join(', ')} are BLOCKED/BACKLOG and will not progress on their own, so the ` +
          `auto-unblock cannot fire (a BLOCKED prerequisite that waits back on this task is a dependency cycle; ` +
          `a BACKLOG one needs a human promote). Triage: unblock/promote the prerequisite, moe.set_task_status ` +
          `to restore this row, or re-file the block with the real blocker ids.`;
      } else if (ageMs > DEPENDENCY_WAIT_ALERT_MULTIPLIER * state.blockedTimeoutMs) {
        alert =
          `⚠️ ${task.id} (${task.title}) has been BLOCKED ${ageMin}m waiting on ${described.join(', ')} — ` +
          `still unmet past ${DEPENDENCY_WAIT_ALERT_MULTIPLIER}× the blocked timeout. It auto-unblocks when they are all ` +
          `DONE/ARCHIVED; check the prerequisites are actually moving, or moe.set_task_status to restore this row.`;
      } else {
        continue;
      }
    }

    const key = `${task.id}:${task.blockedAt}`;
    liveKeys.add(key);
    if (memo.has(key)) continue;

    try {
      await state.postToRoleChannel('governors', alert);
      memo.add(key);
      alerted++;
    } catch { /* never throw from a sweep */ }
  }

  // Drop memo entries for blocks that resolved (or re-blocked under a new
  // blockedAt) so a future stale block alerts fresh.
  for (const key of memo) {
    if (!liveKeys.has(key)) memo.delete(key);
  }
  return alerted;
}
