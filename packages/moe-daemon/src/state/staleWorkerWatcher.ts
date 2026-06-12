// =============================================================================
// worker-liveness sweep — the SINGLE default-on safety net that auto-releases
// tasks held by workers that have stopped heart-beating (hard crash, OOM,
// killed terminal). It funnels every stale owner through the ONE release path
// (deregisterWorker → release tasks via nextStatusForRelease, mark worker DEAD,
// post chat-leave), so a timed-out worker ends in exactly the same state as a
// gracefully-deregistered one.
//
// On by DEFAULT. Opt OUT with MOE_DISABLE_AUTO_RELEASE=1. Preview without
// mutating via MOE_AUTO_RELEASE_DRY_RUN=1 (posts the banner only).
//
// Note: the release threshold (DEFAULT_RELEASE_AFTER_MS, 30 min) is deliberately
// much larger than the 120s presence window (isWorkerAlive — display only).
// Task claimability never keys on idle time: isTaskClaimable releases a task
// only when its owner is missing from the worker map or explicitly DEAD, so a
// slow-but-live agent mid-operation is never yanked out from under itself.
// This sweep is what establishes DEAD for hard-crashed workers.
// =============================================================================

import type { StateManager } from './StateManager.js';
import { deregisterWorker } from './workerLifecycle.js';
import { logger } from '../util/logger.js';

const DEFAULT_INTERVAL_MS = 60_000;
const DEFAULT_RELEASE_AFTER_MS = 30 * 60_000;

export interface StaleWorkerWatcherOptions {
  intervalMs?: number;
  staleAfterMs?: number;
  /** When true, post the chat banner but skip the task/worker mutations. */
  dryRun?: boolean;
  /** Override clock for tests. */
  now?: () => number;
}

/**
 * Run a single sweep. Exposed so tests can advance fake timers manually without
 * juggling setInterval handles.
 */
export async function sweepStaleWorkers(
  state: StateManager,
  options: Required<Pick<StaleWorkerWatcherOptions, 'staleAfterMs' | 'dryRun'>> & { now: () => number }
): Promise<{ released: number }> {
  const now = options.now();
  let released = 0;

  for (const worker of Array.from(state.workers.values())) {
    // Already gone — nothing to release; the prune sweep removes the record.
    if (worker.status === 'DEAD') continue;
    // BLOCKED workers are waiting on a human (report_blocked). Leave them to
    // checkBlockedTimeouts' dedicated, longer grace period so we don't yank a
    // task mid-escalation and mark the worker DEAD while help is still pending.
    if (worker.status === 'BLOCKED') continue;

    const last = Date.parse(worker.lastActivityAt);
    if (!Number.isFinite(last)) continue;
    const ageMs = now - last;
    if (ageMs < options.staleAfterMs) continue;

    // Only act on workers that actually hold tasks. A stale-but-idle worker is
    // left for the Layer-3 prune sweep; we don't mark it DEAD here.
    const owned = state.getTasksAssignedToWorker(worker.id);
    if (owned.length === 0) continue;

    const minutes = Math.round(ageMs / 60_000);

    if (options.dryRun) {
      const banner = `🔓 (dry-run) would auto-release ${owned.length} task(s) from stale worker ${worker.id} (idle ${minutes}m)`;
      try { await state.postToRoleChannel('workers', banner); } catch { /* never block sweep */ }
      try { await state.postToRoleChannel('governors', banner); } catch { /* never block sweep */ }
      logger.info(
        { workerId: worker.id, ownedTaskIds: owned.map((t) => t.id), minutes },
        'worker-liveness sweep (dry-run): would release'
      );
      continue;
    }

    try {
      // ONE release path: releases every owned task via nextStatusForRelease,
      // marks the worker DEAD (UI drops it), and posts the deregister banner.
      // Wrapped in the state mutex so the sweep's mutations serialize against
      // concurrent MCP tool handlers (which all run under runExclusive). Lock
      // order state→channel is preserved (deregister's chat posts take the
      // channel mutex after), so this cannot deadlock.
      const result = await state.runExclusive(() => deregisterWorker(state, worker.id, 'liveness_timeout'));
      released += result.released.length;
      logger.info(
        { workerId: worker.id, released: result.released.length, minutes },
        'worker-liveness sweep released stale worker'
      );
    } catch (err) {
      logger.warn({ workerId: worker.id, error: err }, 'worker-liveness sweep release failed');
    }
  }

  return { released };
}

export interface StaleWorkerWatcherHandle {
  stop: () => void;
  /** Run a single immediate sweep — exposed for tests. */
  sweep: () => Promise<{ released: number }>;
}

/**
 * Start the periodic worker-liveness sweep. Returns a handle whose `stop()` is
 * safe to call multiple times. Enabled by DEFAULT; returns a no-op handle when
 * MOE_DISABLE_AUTO_RELEASE=1 is set.
 */
export function startWorkerLivenessSweep(
  state: StateManager,
  opts: StaleWorkerWatcherOptions = {}
): StaleWorkerWatcherHandle {
  const disabled = process.env.MOE_DISABLE_AUTO_RELEASE === '1';
  const dryRun = process.env.MOE_AUTO_RELEASE_DRY_RUN === '1' || !!opts.dryRun;
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const staleAfterMs = opts.staleAfterMs ?? DEFAULT_RELEASE_AFTER_MS;
  const now = opts.now ?? Date.now;

  if (disabled) {
    logger.info('worker-liveness sweep disabled via MOE_DISABLE_AUTO_RELEASE=1');
    return { stop: () => {}, sweep: async () => ({ released: 0 }) };
  }

  logger.info({ intervalMs, staleAfterMs, dryRun }, 'worker-liveness sweep started');

  const sweep = () => sweepStaleWorkers(state, { staleAfterMs, dryRun, now });

  const handle = setInterval(() => {
    sweep().catch((err) => logger.warn({ error: err }, 'worker-liveness sweep error'));
  }, intervalMs);
  if (typeof (handle as NodeJS.Timeout).unref === 'function') {
    (handle as NodeJS.Timeout).unref();
  }

  return {
    stop: () => clearInterval(handle),
    sweep,
  };
}
