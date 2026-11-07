// =============================================================================
// Peer map — every other open task's claim on a path, as the agent wrapper's
// landing sees it. Extracted from moe.get_commit_scope (its `peerDeclared`) so
// moe.complete_task can preview the same contested holds before the session
// exits. get_commit_scope's output is unchanged.
// =============================================================================

import type { StateManager } from '../state/StateManager.js';
import type { Task, Worker } from '../types/schema.js';
import { collectPeerPaths, collectTaskPathTiers, PathSet, tolerantNormalizePath } from './attributionTiers.js';
import { isWorkerAlive, LIVENESS_TIMEOUT_MS } from './workerLiveness.js';
import { findDependencyPath } from '../state/dependencyUnblock.js';
import { listAttempts } from '../state/attemptStore.js';

const TERMINAL_STATUSES = new Set<string>(['DONE', 'ARCHIVED']);

/** One `peerDeclared` entry of moe.get_commit_scope. */
export interface PeerDeclaredEntry {
  path: string;
  taskId: string;
  peerActive: boolean;
  taskIds: string[];
  activeTaskIds: string[];
  editingTaskIds: string[];
}

/**
 * A worker counts as an active peer for the attribution policy when it is not
 * DEAD and either (a) `since` was supplied and it was active at or after
 * `since − 120 s` or registered at/after `since`, or (b) no `since` was given
 * and it is inside the standard presence window (isWorkerAlive).
 */
export function isPeerActive(worker: Worker, nowMs: number, sinceMs: number | null): boolean {
  if (worker.status === 'DEAD') return false;
  if (sinceMs === null) return isWorkerAlive(worker, nowMs);
  const last = Date.parse(worker.lastActivityAt);
  if (Number.isFinite(last) && last >= sinceMs - LIVENESS_TIMEOUT_MS) return true;
  const started = Date.parse(worker.startedAt);
  return Number.isFinite(started) && started >= sinceMs;
}

/**
 * Whether a peer task may have written bytes since `since`: its assignee is an
 * active peer, it has a non-closed attempt, or an attempt changed phase inside
 * the window. Fails closed: no `since` or an unparsable lastPhaseAt is active.
 * A missing or DEAD assignee record is not active by itself.
 */
function peerTaskActive(state: StateManager, other: Task, nowMs: number, sinceMs: number | null): boolean {
  if (sinceMs === null) return true;
  const assignee = other.assignedWorkerId ? state.getWorker(other.assignedWorkerId) : null;
  if (assignee && isPeerActive(assignee, nowMs, sinceMs)) return true;
  return listAttempts(state, other.id).some((attempt) => {
    if (attempt.phase !== 'closed') return true;
    const changed = Date.parse(attempt.lastPhaseAt);
    return !Number.isFinite(changed) || changed >= sinceMs - LIVENESS_TIMEOUT_MS;
  });
}

/**
 * Whether a task that waits on the scoped task has a session that may be writing
 * bytes: its assignee is an active peer, or it holds a non-closed attempt
 * (running, reconciling and finalizing all count as open).
 *
 * Deliberately narrower than peerTaskActive: no fail-closed shortcut when `since`
 * is missing, and no clause for a recent phase change. An idle link has not
 * started, even one whose planning attempt closed inside the window, or any link
 * when `since` is missing. Counting it would reopen task-435683c2: an unstarted
 * link of a serialized chain contesting the link before it. A session that can
 * write bytes always holds a non-closed attempt: claimNextTask's openClaimAttempt
 * opens one per claim and taskStore's closeAttemptsOnHandBack closes it when the
 * seat is cleared. Malformed data fails closed and counts the peer: a non-string
 * assignee id, and an unknown attempt phase (which counts as open). A missing or
 * DEAD owner record is not active by itself.
 */
function dependentMayRun(state: StateManager, other: Task, nowMs: number, sinceMs: number | null): boolean {
  const owner: unknown = other.assignedWorkerId;
  if (owner !== null && owner !== undefined && owner !== '' && typeof owner !== 'string') return true;
  const assignee = typeof owner === 'string' && owner !== '' ? state.getWorker(owner) : null;
  if (assignee && isPeerActive(assignee, nowMs, sinceMs)) return true;
  return listAttempts(state, other.id).some((attempt) => attempt.phase !== 'closed');
}

/**
 * The paths named by the plan steps a task is in the middle of: affectedFiles ∪
 * newFiles ∪ modifiedFiles over every IN_PROGRESS step. A peer's record is
 * worker-typed, so a non-array plan or list is skipped and PathSet drops what it
 * cannot normalise: one peer's junk never fails another task's scope.
 */
function inProgressStepPaths(task: Task): PathSet {
  const paths = new PathSet();
  if (!Array.isArray(task.implementationPlan)) return paths;
  for (const step of task.implementationPlan) {
    if (!step || step.status !== 'IN_PROGRESS') continue;
    for (const list of [step.affectedFiles, step.newFiles, step.modifiedFiles]) {
      if (Array.isArray(list)) paths.addAll(list);
    }
  }
  return paths;
}

/**
 * The stepIds of `task`'s IN_PROGRESS steps that name `path` (affectedFiles,
 * newFiles or modifiedFiles): the steps that make it an editing peer of the
 * path. Tolerates the same worker-typed junk as inProgressStepPaths.
 */
export function inProgressStepsNaming(task: Task, path: string): string[] {
  if (tolerantNormalizePath(path) === null || !Array.isArray(task.implementationPlan)) return [];
  const ids: string[] = [];
  for (const step of task.implementationPlan) {
    if (!step || step.status !== 'IN_PROGRESS') continue;
    const named = new PathSet();
    for (const list of [step.affectedFiles, step.newFiles, step.modifiedFiles]) {
      if (Array.isArray(list)) named.addAll(list);
    }
    if (named.has(path)) ids.push(typeof step.stepId === 'string' ? step.stepId : '?');
  }
  return ids;
}

export function sortedById<T extends { id: string }>(items: Iterable<T>): T[] {
  return Array.from(items).sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Every other open task's declared paths (moe.get_commit_scope `peerDeclared`).
 *
 * Deterministic: tasks visited in id order, first claimant of a path wins
 * taskId; peerActive is an OR over every task contributing the path. taskIds
 * names every contributor (taskId === taskIds[0]); activeTaskIds the ones
 * active by the peerActive rule, so peerActive === (activeTaskIds.length > 0)
 * and a wrapper can name the live cause of a hold, not an idle first claimant;
 * editingTaskIds the ones with an IN_PROGRESS step naming the path that are
 * active (a subset of activeTaskIds), so a wrapper can hold a path a live
 * peer is mid-edit on instead of sweeping its hunks.
 */
export function collectPeerDeclared(state: StateManager, task: Task, nowMs: number, sinceMs: number | null): PeerDeclaredEntry[] {
  const peerByKey = new Map<string, PeerDeclaredEntry>();
  const peerSet = new PathSet();
  // The raw status on purpose: DONE/ARCHIVED here is what frees dependents to
  // be claimed, whatever a strict deliveryPolicy says about evidence.
  const thisTerminal = TERMINAL_STATUSES.has(task.status);
  for (const other of sortedById<Task>(state.tasks.values())) {
    if (other.id === task.id) continue;
    if (TERMINAL_STATUSES.has(other.status)) continue;
    // A peer that waits on THIS task (dependsOn or blockedOnTaskIds, followed
    // transitively) has not run yet while this task is not DONE/ARCHIVED and
    // the peer has no active assignee and no open attempt: dependsOn gates its
    // WORKING claims until this task is DONE. Its plan-declared paths are
    // forward intent, not concurrent edits. Counting them made every link of
    // a serialized chain contest the link before it, and held that task's own
    // diff out of its completion commit. Its ASSERTED paths are evidence of a
    // real edit and still count. Once this task is terminal its dependents are
    // claimable and may be mid-step: in baa704f5, WT-08's QA exit landing
    // committed fa7fece5's half-done scripts/moe-agent.sh under WT-08's id. A
    // dependent with a live session is an ordinary peer, whatever the edges
    // say. findDependencyPath matches a DONE/ARCHIVED target before it skips
    // terminal nodes, so the explicit thisTerminal check is required.
    const waitsOnThis = !thisTerminal
      && !dependentMayRun(state, other, nowMs, sinceMs)
      && findDependencyPath(state, other.id, task.id) !== null;
    const peerPaths = waitsOnThis ? collectTaskPathTiers(other).asserted : collectPeerPaths(other);
    const active = peerTaskActive(state, other, nowMs, sinceMs);
    const editing = active ? inProgressStepPaths(other) : null;
    for (const p of peerPaths) {
      const stored = peerSet.add(p);
      if (stored === null) continue;
      const isEditing = editing?.has(stored) === true;
      const entry = peerByKey.get(stored);
      if (entry) {
        entry.peerActive ||= active;
        entry.taskIds.push(other.id);
        if (active) entry.activeTaskIds.push(other.id);
        if (isEditing) entry.editingTaskIds.push(other.id);
        continue;
      }
      peerByKey.set(stored, {
        path: stored, taskId: other.id, peerActive: active,
        taskIds: [other.id], activeTaskIds: active ? [other.id] : [], editingTaskIds: isEditing ? [other.id] : [],
      });
    }
  }
  return Array.from(peerByKey.values());
}
