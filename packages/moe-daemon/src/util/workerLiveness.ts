import type { Worker } from '../types/schema.js';

/**
 * The single liveness window for the whole daemon. A worker is "alive" if it
 * has not been marked DEAD and its lastActivityAt is within this window. This
 * is the *presence* timeout (UI/agent display: listWorkers, chat_who) — it is
 * deliberately distinct from the more conservative auto-release timeout used by
 * the stale-worker sweep (see RELEASE_AFTER_MS in workerLivenessSweep).
 * NOTE: task claimability does NOT use this window — isTaskClaimable keys on
 * the owner being missing or explicitly DEAD, never on raw idle time (a quiet
 * worker mid-build keeps its task).
 */
export const LIVENESS_TIMEOUT_MS = 120_000;

/**
 * The ONE predicate for "is this worker alive". A worker is alive iff (a) it has
 * not been marked DEAD (terminal — deregistered or liveness-timed-out) AND (b)
 * its lastActivityAt is fresher than timeoutMs. Shared by listWorkers, chat_who
 * and the sweeps so presence is computed identically everywhere. Do not
 * re-implement this check inline.
 */
export function isWorkerAlive(
  worker: Pick<Worker, 'status' | 'lastActivityAt'>,
  nowMs: number = Date.now(),
  timeoutMs: number = LIVENESS_TIMEOUT_MS
): boolean {
  if (worker.status === 'DEAD') return false;
  const last = Date.parse(worker.lastActivityAt);
  if (!Number.isFinite(last)) return false;
  return (nowMs - last) <= timeoutMs;
}
