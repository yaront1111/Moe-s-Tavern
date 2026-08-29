// =============================================================================
// Resource store — shared-resource leases and their wait queue
// =============================================================================
//
// Daemon-owned admission control for exclusive-use infrastructure (a benchmark
// box, a staging DB): agents acquire or queue via moe.* tools instead of
// per-project marker files + pid probes. Leases are keyed by TASK id, not
// worker id — a lease must survive CLI respawns and the daemon-restart worker
// purge, because the underlying work (a detached multi-hour run) survives them
// too.
//
// Follows the workerStore pattern: stateless functions taking the state handle
// first; every mutation runs under state.mutex (tool dispatch provides it for
// non-blocking tools; wait_for_resource wraps its own mutation sections).
// Write path per mutation: writeEntity → map.set → appendActivity → emit.
//
// The grant path is the whole point: when capacity frees, grantNextLeases
// promotes the best queue entry to a lease and — if that task is BLOCKED on
// this resource — flips it back to blockedFromStatus, which wakes the fleet
// (TASK_UPDATED wakes wait_for_task; the wrapper's next claim poll resumes a
// still-assigned task).

import type { StateManager } from './StateManager.js';
import type {
  ResourceLease,
  ResourceQueueEntry,
  ResourceState,
  TaskPriority,
  TaskStatus,
} from '../types/schema.js';
import { logger } from '../util/logger.js';

export const RESOURCE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export const DEFAULT_RESOURCE_CAPACITY = 1;
/** 24h — generous because real leases cover multi-hour benchmark runs. */
export const DEFAULT_MAX_LEASE_MS = 86_400_000;
const MIN_MAX_LEASE_MS = 60_000;

const PRIORITY_WEIGHT: Record<TaskPriority, number> = {
  CRITICAL: 0,
  HIGH: 1,
  MEDIUM: 2,
  LOW: 3,
};

/** Statuses in which a task legitimately holds or waits on a resource. */
const RESOURCE_ELIGIBLE_STATUSES = new Set<TaskStatus>([
  'PLANNING',
  'WORKING',
  'REVIEW',
  'BLOCKED',
]);

export interface ResourceConfig {
  capacity: number;
  maxLeaseMs: number;
  description?: string;
}

/** Declared settings for a resource id, defaulted + sanitized. Undeclared ids get pure defaults. */
export function resolveResourceConfig(state: StateManager, resourceId: string): ResourceConfig {
  const declared = state.project?.settings?.resources?.[resourceId];
  const capacityRaw = declared?.capacity;
  const capacity =
    typeof capacityRaw === 'number' && Number.isFinite(capacityRaw) && capacityRaw >= 1
      ? Math.floor(capacityRaw)
      : DEFAULT_RESOURCE_CAPACITY;
  const maxLeaseRaw = declared?.maxLeaseMs;
  const maxLeaseMs =
    typeof maxLeaseRaw === 'number' && Number.isFinite(maxLeaseRaw) && maxLeaseRaw >= MIN_MAX_LEASE_MS
      ? Math.floor(maxLeaseRaw)
      : DEFAULT_MAX_LEASE_MS;
  return { capacity, maxLeaseMs, description: declared?.description };
}

export function getResource(state: StateManager, resourceId: string): ResourceState | null {
  return state.resources.get(resourceId) ?? null;
}

function getOrCreateResource(state: StateManager, resourceId: string): ResourceState {
  const existing = state.resources.get(resourceId);
  if (existing) return existing;
  const now = new Date().toISOString();
  const fresh: ResourceState = { id: resourceId, holders: [], queue: [], createdAt: now, updatedAt: now };
  state.resources.set(resourceId, fresh);
  return fresh;
}

async function persistResource(state: StateManager, resource: ResourceState): Promise<void> {
  resource.updatedAt = new Date().toISOString();
  await state.writeEntity('resources', resource.id, resource);
  state.resources.set(resource.id, resource);
  state.emit({ type: 'RESOURCE_UPDATED', payload: resource });
}

/** Queue order: task priority (missing task → MEDIUM), then FIFO. */
function sortedQueue(state: StateManager, queue: ResourceQueueEntry[]): ResourceQueueEntry[] {
  return [...queue].sort((a, b) => {
    const ta = state.tasks.get(a.taskId);
    const tb = state.tasks.get(b.taskId);
    const pa = PRIORITY_WEIGHT[ta?.priority ?? 'MEDIUM'] ?? PRIORITY_WEIGHT.MEDIUM;
    const pb = PRIORITY_WEIGHT[tb?.priority ?? 'MEDIUM'] ?? PRIORITY_WEIGHT.MEDIUM;
    if (pa !== pb) return pa - pb;
    return a.requestedAt.localeCompare(b.requestedAt);
  });
}

/** 1-based queue position for a task, by grant order (priority then FIFO); null when not queued. */
export function getQueuePosition(state: StateManager, resourceId: string, taskId: string): number | null {
  const resource = state.resources.get(resourceId);
  if (!resource) return null;
  const idx = sortedQueue(state, resource.queue).findIndex((q) => q.taskId === taskId);
  return idx === -1 ? null : idx + 1;
}

export interface AcquireParams {
  resourceId: string;
  taskId: string;
  workerId: string;
  note?: string;
  etaMs?: number;
}

export interface AcquireResult {
  granted: boolean;
  resourceId: string;
  lease?: ResourceLease;
  /** 1-based position when queued. */
  position?: number;
  holders: ResourceLease[];
  queueLength: number;
}

/**
 * Grant a lease if capacity is free, else enqueue. Idempotent per taskId:
 * re-acquiring an existing lease renews expiresAt (and note/eta); re-acquiring
 * an existing queue entry refreshes note/eta without losing queue age.
 */
export async function acquireResource(state: StateManager, params: AcquireParams): Promise<AcquireResult> {
  const { resourceId, taskId, workerId } = params;
  const config = resolveResourceConfig(state, resourceId);
  const resource = getOrCreateResource(state, resourceId);
  const now = Date.now();
  const nowIso = new Date(now).toISOString();

  const existingLease = resource.holders.find((h) => h.taskId === taskId);
  if (existingLease) {
    existingLease.workerId = workerId;
    if (params.note !== undefined) existingLease.note = params.note;
    if (params.etaMs !== undefined) existingLease.etaMs = params.etaMs;
    existingLease.expiresAt = new Date(now + config.maxLeaseMs).toISOString();
    await persistResource(state, resource);
    return {
      granted: true,
      resourceId,
      lease: existingLease,
      holders: resource.holders,
      queueLength: resource.queue.length,
    };
  }

  if (resource.holders.length < config.capacity) {
    const lease: ResourceLease = {
      taskId,
      workerId,
      note: params.note,
      etaMs: params.etaMs,
      acquiredAt: nowIso,
      expiresAt: new Date(now + config.maxLeaseMs).toISOString(),
    };
    resource.holders.push(lease);
    // The direct-grant path never needs to sit in the queue; drop any stale
    // entry from an earlier queued attempt.
    resource.queue = resource.queue.filter((q) => q.taskId !== taskId);
    await persistResource(state, resource);
    state.appendActivity('RESOURCE_ACQUIRED', { resourceId, taskId, workerId, note: params.note });
    return { granted: true, resourceId, lease, holders: resource.holders, queueLength: resource.queue.length };
  }

  let entry = resource.queue.find((q) => q.taskId === taskId);
  if (entry) {
    entry.workerId = workerId;
    if (params.note !== undefined) entry.note = params.note;
  } else {
    entry = { taskId, workerId, note: params.note, requestedAt: nowIso };
    resource.queue.push(entry);
    state.appendActivity('RESOURCE_QUEUED', { resourceId, taskId, workerId, note: params.note });
  }
  await persistResource(state, resource);
  const position = sortedQueue(state, resource.queue).findIndex((q) => q.taskId === taskId) + 1;
  return {
    granted: false,
    resourceId,
    position,
    holders: resource.holders,
    queueLength: resource.queue.length,
  };
}

export interface ReleaseParams {
  resourceId: string;
  workerId: string;
  /** Default: every lease whose workerId matches, plus any lease for the worker's currentTaskId. */
  taskId?: string;
  /** Governor/human override: release regardless of ownership. */
  force?: boolean;
}

export interface ReleaseResourceResult {
  released: ResourceLease[];
  removedFromQueue: ResourceQueueEntry[];
  granted: ResourceLease[];
}

/**
 * Release lease(s) and/or drop the caller's queue entry, then grant the next
 * eligible waiter(s). Releasing a resource you neither hold nor queue on is a
 * no-op (idempotent), not an error — release paths run from exit traps.
 */
export async function releaseResource(state: StateManager, params: ReleaseParams): Promise<ReleaseResourceResult> {
  const resource = state.resources.get(params.resourceId);
  if (!resource) return { released: [], removedFromQueue: [], granted: [] };

  // Leases are task-keyed so they survive CLI respawns and the restart worker
  // purge — which means the RELEASE path must too: the task's CURRENT assignee
  // owns the lease just as much as the workerId that originally acquired it
  // (a successor wrapper session re-claims the task under a fresh workerId and
  // must be able to release when the run finishes).
  const callerOwns = (owner: { taskId: string; workerId: string }): boolean =>
    owner.workerId === params.workerId ||
    state.tasks.get(owner.taskId)?.assignedWorkerId === params.workerId;
  const matchesCaller = (owner: { taskId: string; workerId: string }): boolean => {
    if (params.force) return params.taskId ? owner.taskId === params.taskId : true;
    if (params.taskId) return owner.taskId === params.taskId && callerOwns(owner);
    return callerOwns(owner);
  };

  const released = resource.holders.filter(matchesCaller);
  const removedFromQueue = resource.queue.filter(matchesCaller);
  if (released.length === 0 && removedFromQueue.length === 0) {
    return { released: [], removedFromQueue: [], granted: [] };
  }

  resource.holders = resource.holders.filter((h) => !released.includes(h));
  resource.queue = resource.queue.filter((q) => !removedFromQueue.includes(q));
  await persistResource(state, resource);
  for (const lease of released) {
    state.appendActivity('RESOURCE_RELEASED', {
      resourceId: params.resourceId,
      taskId: lease.taskId,
      workerId: lease.workerId,
      forced: Boolean(params.force),
    });
  }

  const granted = await grantNextLeases(state, params.resourceId);
  return { released, removedFromQueue, granted };
}

/**
 * Promote queue entries to leases while capacity is free. For each grant whose
 * task is BLOCKED on this resource, flip the task back to blockedFromStatus —
 * that single status write is what un-idles the fleet: TASK_UPDATED wakes
 * wait_for_task waiters, and the wrapper's next claim poll sees a resumable
 * (non-BLOCKED) held task and relaunches the CLI.
 */
export async function grantNextLeases(state: StateManager, resourceId: string): Promise<ResourceLease[]> {
  const resource = state.resources.get(resourceId);
  if (!resource) return [];
  const config = resolveResourceConfig(state, resourceId);
  const granted: ResourceLease[] = [];

  while (resource.holders.length < config.capacity && resource.queue.length > 0) {
    const next = sortedQueue(state, resource.queue)[0];
    resource.queue = resource.queue.filter((q) => q !== next);
    const now = Date.now();
    const lease: ResourceLease = {
      taskId: next.taskId,
      workerId: next.workerId,
      note: next.note,
      acquiredAt: new Date(now).toISOString(),
      expiresAt: new Date(now + config.maxLeaseMs).toISOString(),
    };
    resource.holders.push(lease);
    granted.push(lease);
    state.appendActivity('RESOURCE_GRANTED', { resourceId, taskId: lease.taskId, workerId: lease.workerId });

    const task = state.tasks.get(lease.taskId);
    if (task && task.status === 'BLOCKED' && task.blockedResourceId === resourceId) {
      const restored: TaskStatus = task.blockedFromStatus ?? 'WORKING';
      try {
        // assignedWorkerId passed explicitly: updateTask would otherwise clear
        // the assignment on the status change, and the un-blocked task must
        // return to the SAME parked worker (or stay unassigned-and-claimable
        // if the worker was purged meanwhile).
        await state.updateTask(task.id, {
          status: restored,
          assignedWorkerId: task.assignedWorkerId,
          blockedReason: null,
          blockedResourceId: null,
          blockedOnTaskIds: null,
          blockedFromStatus: null,
          blockedAt: null,
        }, 'TASK_UNBLOCKED');
        const msg = `🟢 Resource ${resourceId} granted to ${task.id} (${lease.workerId}); task un-blocked → ${restored}.`;
        try { await state.postSystemMessage(task.id, msg); } catch { /* best-effort */ }
        try { await state.postToGeneral(msg); } catch { /* best-effort */ }
      } catch (err) {
        logger.warn({ resourceId, taskId: task.id, error: err }, 'grantNextLeases: failed to un-block task');
      }
    } else {
      // Lease granted while the task kept working elsewhere (queued early, no
      // report_blocked yet) — tell the channel so the holder finds out even if
      // it never re-polls acquire_resource.
      const msg = `🟢 Resource ${resourceId} granted to ${lease.taskId} (${lease.workerId}).`;
      try { await state.postToGeneral(msg); } catch { /* best-effort */ }
    }
  }

  if (granted.length > 0) {
    await persistResource(state, resource);
  }
  return granted;
}

/**
 * Sweep pass (runs under state.mutex from runBlockedTimeoutSweep):
 *   1. drop leases whose task is gone / no longer in an active status;
 *   2. force-release leases past expiresAt (bounds a crashed holder — the
 *      analogue of the heartbeat sidecar's max-duration cap);
 *   3. drop queue entries whose task is gone / no longer in an active status;
 *   4. grant freed capacity to the next waiters.
 * Returns the number of leases/entries removed.
 */
export async function reapResources(state: StateManager, nowMs: number = Date.now()): Promise<number> {
  let reaped = 0;
  for (const resource of state.resources.values()) {
    const expiredLeases: ResourceLease[] = [];
    const orphanedLeases: ResourceLease[] = [];
    for (const lease of resource.holders) {
      const task = state.tasks.get(lease.taskId);
      if (!task || !RESOURCE_ELIGIBLE_STATUSES.has(task.status)) {
        orphanedLeases.push(lease);
        continue;
      }
      const expiresMs = Date.parse(lease.expiresAt);
      if (!Number.isNaN(expiresMs) && nowMs > expiresMs) {
        expiredLeases.push(lease);
      }
    }
    const dropQueue = resource.queue.filter((q) => {
      const task = state.tasks.get(q.taskId);
      return !task || !RESOURCE_ELIGIBLE_STATUSES.has(task.status);
    });

    if (expiredLeases.length === 0 && orphanedLeases.length === 0 && dropQueue.length === 0) continue;

    resource.holders = resource.holders.filter(
      (h) => !expiredLeases.includes(h) && !orphanedLeases.includes(h)
    );
    resource.queue = resource.queue.filter((q) => !dropQueue.includes(q));
    reaped += expiredLeases.length + orphanedLeases.length + dropQueue.length;
    await persistResource(state, resource);

    for (const lease of expiredLeases) {
      state.appendActivity('RESOURCE_LEASE_EXPIRED', {
        resourceId: resource.id,
        taskId: lease.taskId,
        workerId: lease.workerId,
        expiresAt: lease.expiresAt,
      });
      const msg = `⏱️ Resource ${resource.id}: lease held by ${lease.taskId} (${lease.workerId}) exceeded its hard cap and was force-released. If the underlying run is still live, re-acquire or raise settings.resources["${resource.id}"].maxLeaseMs.`;
      try { await state.postToGeneral(msg); } catch { /* best-effort */ }
      try { await state.postToRoleChannel('governors', msg); } catch { /* best-effort */ }
    }
    for (const lease of orphanedLeases) {
      state.appendActivity('RESOURCE_RELEASED', {
        resourceId: resource.id,
        taskId: lease.taskId,
        workerId: lease.workerId,
        forced: true,
        reason: 'task inactive',
      });
    }

    try {
      await grantNextLeases(state, resource.id);
    } catch (err) {
      logger.warn({ resourceId: resource.id, error: err }, 'reapResources: grantNextLeases failed');
    }
  }
  return reaped;
}
