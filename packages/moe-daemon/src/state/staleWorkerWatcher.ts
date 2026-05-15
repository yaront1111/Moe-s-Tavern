// =============================================================================
// staleWorkerWatcher — opt-in safety net that auto-releases tasks held by
// idle workers. Off by default; enable with MOE_AUTO_RELEASE_STALE_WORKERS=1.
// Dry-run via MOE_AUTO_RELEASE_DRY_RUN=1 posts the chat banner without
// mutating state, so operators can see the behavior before flipping it on.
// =============================================================================

import type { StateManager } from './StateManager.js';
import type { Task, TaskStatus, Worker } from '../types/schema.js';
import { logger } from '../util/logger.js';

const DEFAULT_INTERVAL_MS = 60_000;
const DEFAULT_STALE_MS = 30 * 60_000;
const CLAIMABLE_FALLBACK_STATUS: TaskStatus = 'BACKLOG';

export interface StaleWorkerWatcherOptions {
  intervalMs?: number;
  staleAfterMs?: number;
  /** When true, post the chat banner but skip the task/worker mutations. */
  dryRun?: boolean;
  /** Override clock for tests. */
  now?: () => number;
}

/**
 * Decide which status a released task should rest in. The task is currently
 * held by a worker — when we strip the assignment, route it to a sensible
 * claimable column based on the role the worker was performing:
 *   - WORKING/REVIEW   → BACKLOG (next worker picks it up)
 *   - PLANNING         → PLANNING (next architect picks it up)
 *   - AWAITING_APPROVAL→ AWAITING_APPROVAL (human still owns approval)
 * Anything else falls back to BACKLOG.
 */
function nextStatusForRelease(currentStatus: TaskStatus): TaskStatus {
  switch (currentStatus) {
    case 'PLANNING':
      return 'PLANNING';
    case 'AWAITING_APPROVAL':
      return 'AWAITING_APPROVAL';
    case 'REVIEW':
      return 'REVIEW';
    case 'WORKING':
      return 'BACKLOG';
    default:
      return CLAIMABLE_FALLBACK_STATUS;
  }
}

interface ReleaseCandidate {
  worker: Worker;
  task: Task;
  secondsStale: number;
}

function findReleaseCandidates(
  state: StateManager,
  staleAfterMs: number,
  nowMs: number
): ReleaseCandidate[] {
  const out: ReleaseCandidate[] = [];
  for (const worker of state.workers.values()) {
    if (!worker.currentTaskId) continue;
    const lastTs = Date.parse(worker.lastActivityAt);
    if (!Number.isFinite(lastTs)) continue;
    const ageMs = nowMs - lastTs;
    if (ageMs < staleAfterMs) continue;
    const task = state.getTask(worker.currentTaskId);
    if (!task) continue;
    // Only release when the task is *actually* assigned to this worker. If
    // the worker thinks they own a task that's already been reassigned, just
    // clear their currentTaskId and skip the chat banner.
    if (task.assignedWorkerId !== worker.id) {
      out.push({ worker, task, secondsStale: Math.floor(ageMs / 1000) });
      continue;
    }
    out.push({ worker, task, secondsStale: Math.floor(ageMs / 1000) });
  }
  return out;
}

/**
 * Run a single sweep of the watcher. Exposed so tests can advance fake
 * timers manually without juggling setInterval handles.
 */
export async function sweepStaleWorkers(
  state: StateManager,
  options: Required<Pick<StaleWorkerWatcherOptions, 'staleAfterMs' | 'dryRun'>> & { now: () => number }
): Promise<{ released: number }> {
  const now = options.now();
  const candidates = findReleaseCandidates(state, options.staleAfterMs, now);
  let released = 0;
  for (const { worker, task, secondsStale } of candidates) {
    const minutes = Math.round(secondsStale / 60);
    const banner = `🔓 auto-released task ${task.id} from stale worker ${worker.id} (idle ${minutes}m)`;
    try {
      await state.postToRoleChannel('workers', banner);
    } catch { /* never block sweep */ }
    try {
      await state.postToRoleChannel('governors', banner);
    } catch { /* never block sweep */ }

    if (options.dryRun) {
      logger.info({ workerId: worker.id, taskId: task.id, secondsStale }, 'stale-worker watcher (dry-run): would release');
      continue;
    }

    try {
      if (task.assignedWorkerId === worker.id) {
        await state.updateTask(task.id, {
          assignedWorkerId: null,
          status: nextStatusForRelease(task.status),
        });
      }
      // Clear currentTaskId on the worker but keep the worker record itself —
      // the operator may want to inspect the worker's lastError/errorCount.
      await state.touchWorker(worker.id, { currentTaskId: null });
      state.appendActivity(
        'WORKER_RELEASED',
        { workerId: worker.id, taskId: task.id, secondsStale, auto: true, source: 'staleWorkerWatcher' },
        task,
        worker
      );
      released++;
      logger.info({ workerId: worker.id, taskId: task.id, secondsStale }, 'stale-worker watcher released task');
    } catch (err) {
      logger.warn({ workerId: worker.id, taskId: task.id, error: err }, 'stale-worker watcher release failed');
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
 * Start the periodic stale-worker watcher. Returns a handle whose `stop()` is
 * safe to call multiple times. The watcher is opt-in: returns a no-op handle
 * unless MOE_AUTO_RELEASE_STALE_WORKERS=1 is set in the environment.
 */
export function startStaleWorkerWatcher(
  state: StateManager,
  opts: StaleWorkerWatcherOptions = {}
): StaleWorkerWatcherHandle {
  const enabled = process.env.MOE_AUTO_RELEASE_STALE_WORKERS === '1';
  const dryRun = process.env.MOE_AUTO_RELEASE_DRY_RUN === '1' || !!opts.dryRun;
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const staleAfterMs = opts.staleAfterMs ?? DEFAULT_STALE_MS;
  const now = opts.now ?? Date.now;

  if (!enabled) {
    return { stop: () => {}, sweep: async () => ({ released: 0 }) };
  }

  logger.info({ intervalMs, staleAfterMs, dryRun }, 'stale-worker watcher started');

  const sweep = () => sweepStaleWorkers(state, { staleAfterMs, dryRun, now });

  const handle = setInterval(() => {
    sweep().catch((err) => logger.warn({ error: err }, 'stale-worker watcher sweep error'));
  }, intervalMs);
  if (typeof (handle as NodeJS.Timeout).unref === 'function') {
    (handle as NodeJS.Timeout).unref();
  }

  return {
    stop: () => clearInterval(handle),
    sweep,
  };
}
