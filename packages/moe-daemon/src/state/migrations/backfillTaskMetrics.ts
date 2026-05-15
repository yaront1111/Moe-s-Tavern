// =============================================================================
// Task metrics backfill — populates missing firstClaimAt / doneAt / wallClockMs
// from the activity log so projects that ran on older daemons get usable
// metrics on the next start. Idempotent: never overwrites existing fields.
// =============================================================================

import fs from 'fs';
import path from 'path';
import type { StateManager } from '../StateManager.js';
import type { ActivityEvent, Task, TaskMetrics } from '../../types/schema.js';
import { logger } from '../../util/logger.js';

interface ActivityIndex {
  earliestClaim: Map<string, string>;     // taskId -> earliest ISO timestamp signalling first claim
  latestDone: Map<string, string>;        // taskId -> latest ISO timestamp signalling DONE transition
}

/**
 * Stream the activity log line-by-line and bucket the earliest claim-like
 * event and latest DONE-transition event per task. Synchronous read is fine —
 * this only runs once at daemon start.
 */
function indexActivityLog(logPath: string): ActivityIndex {
  const earliestClaim = new Map<string, string>();
  const latestDone = new Map<string, string>();
  if (!fs.existsSync(logPath)) {
    return { earliestClaim, latestDone };
  }

  let raw: string;
  try {
    raw = fs.readFileSync(logPath, 'utf-8');
  } catch (error) {
    logger.debug({ error, logPath }, 'backfillTaskMetrics: activity.log unreadable; skipping');
    return { earliestClaim, latestDone };
  }

  for (const line of raw.split('\n')) {
    if (!line || !line.startsWith('{')) continue;
    let evt: ActivityEvent;
    try {
      evt = JSON.parse(line) as ActivityEvent;
    } catch {
      continue;
    }
    const taskId = typeof evt.taskId === 'string' ? evt.taskId : undefined;
    const ts = typeof evt.timestamp === 'string' ? evt.timestamp : undefined;
    if (!taskId || !ts) continue;

    // Claim-like: an explicit TASK_CLAIMED (future-proofing) OR the first
    // TASK_STARTED (BACKLOG/PLANNING → WORKING) OR a TASK_UPDATED that set
    // assignedWorkerId.  We take the earliest of those signals as firstClaimAt.
    const payload = evt.payload as Record<string, unknown> | undefined;
    const isClaim =
      evt.event === ('TASK_CLAIMED' as ActivityEvent['event']) ||
      evt.event === 'TASK_STARTED' ||
      (evt.event === 'TASK_UPDATED' && payload && typeof payload.assignedWorkerId === 'string');
    if (isClaim) {
      const prior = earliestClaim.get(taskId);
      if (!prior || ts < prior) earliestClaim.set(taskId, ts);
    }

    // DONE: prefer an explicit TASK_STATUS_CHANGED with newStatus=DONE; fall
    // back to QA_APPROVED / TASK_COMPLETED with payload.status === 'DONE'.
    const newStatus = payload && typeof payload.newStatus === 'string'
      ? (payload.newStatus as string)
      : undefined;
    const reachedDone =
      evt.event === ('TASK_STATUS_CHANGED' as ActivityEvent['event']) && newStatus === 'DONE'
        ? true
        : evt.event === 'QA_APPROVED'
          ? true
          : evt.event === 'TASK_COMPLETED' && newStatus === 'DONE';
    if (reachedDone) {
      const prior = latestDone.get(taskId);
      if (!prior || ts > prior) latestDone.set(taskId, ts);
    }
  }

  return { earliestClaim, latestDone };
}

export interface BackfillResult {
  backfilled: number;
}

/**
 * Walk every task; for any with missing firstClaimAt/doneAt fields, derive a
 * value from the activity log. Only fills missing fields. Persists changes via
 * the StateManager so the on-disk task.json files stay in sync.
 */
export async function backfillTaskMetrics(state: StateManager): Promise<BackfillResult> {
  const logPath = path.join(state.moePath, 'activity.log');
  const { earliestClaim, latestDone } = indexActivityLog(logPath);

  let backfilled = 0;
  for (const task of Array.from(state.tasks.values())) {
    const prior: TaskMetrics = task.metrics ?? {};
    const next: TaskMetrics = { ...prior };
    let dirty = false;

    if (!prior.firstClaimAt) {
      const ts = earliestClaim.get(task.id);
      if (ts) {
        next.firstClaimAt = ts;
        dirty = true;
      }
    }

    if (task.status === 'DONE' && !prior.doneAt) {
      const ts = latestDone.get(task.id);
      if (ts) {
        next.doneAt = ts;
        dirty = true;
      }
    }

    if (next.firstClaimAt && next.doneAt && typeof next.wallClockMs !== 'number') {
      const start = Date.parse(next.firstClaimAt);
      const end = Date.parse(next.doneAt);
      if (Number.isFinite(start) && Number.isFinite(end) && end >= start) {
        next.wallClockMs = end - start;
        dirty = true;
      }
    }

    if (dirty) {
      try {
        // Use updateTask (with no event) to persist + emit through the
        // normal channel; never block daemon startup on a single failure.
        await state.updateTask(task.id, { metrics: next });
        backfilled++;
      } catch (error) {
        logger.warn({ taskId: task.id, error }, 'backfillTaskMetrics: failed to persist backfilled metrics');
      }
    }
  }

  return { backfilled };
}

// Exported for tests / diagnostics. Pure function; reads no global state.
export const __testing = { indexActivityLog };
