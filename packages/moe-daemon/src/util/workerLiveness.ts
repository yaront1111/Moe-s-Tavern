import type { Team, Worker } from '../types/schema.js';

/**
 * The single liveness window for the whole daemon. A worker is "alive" if it
 * has not been marked DEAD and its lastActivityAt is within this window. This
 * is the *presence* timeout (UI/agent display: listWorkers, chat_who) only.
 * NOTE: task claimability does NOT use this window — isTaskClaimable keys on
 * the owner being missing or explicitly DEAD, never on raw idle time (a quiet
 * worker mid-build keeps its task). There is deliberately NO idle-based
 * auto-release: a long-running worker keeps its task until it deregisters,
 * a human releases it, or the daemon restarts.
 */
export const LIVENESS_TIMEOUT_MS = 120_000;

/**
 * The ONE predicate for "is this worker alive". A worker is alive iff (a) it has
 * not been marked DEAD (terminal — deregistered) AND (b) its lastActivityAt is
 * fresher than timeoutMs. Shared by listWorkers, chat_who and the sweeps so
 * presence is computed identically everywhere. Do not re-implement this check
 * inline.
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

export interface FreshestLiveWorkerOptions {
  /** Reference instant for the liveness window. Defaults to `Date.now()`. */
  nowMs?: number;
  /** Liveness window width. Defaults to `LIVENESS_TIMEOUT_MS`. */
  timeoutMs?: number;
  /** Worker ids that must never be returned (e.g. the caller itself). */
  excludeWorkerIds?: string[];
}

/**
 * The most recently active *live* worker holding `role`, or null if there is
 * none. Used to pick a real person to page instead of a deregistered one (see
 * moe.report_blocked, which direct-mentions the freshest live architect and
 * falls back to @governors).
 *
 * Role membership resolves through `worker.teamId`, NOT `team.memberIds`: a
 * worker dropped from memberIds out-of-band still points at its team, and
 * StateManager treats teamId as the single-valued source of truth. Liveness
 * goes through `isWorkerAlive`, the one canonical predicate, so DEAD workers
 * and unparsable `lastActivityAt` values are excluded identically everywhere.
 *
 * Pure over plain iterables — no StateManager import (that would be a cycle)
 * and no clock read when `nowMs` is supplied, so callers can test it exactly.
 * Ties on `lastActivityAt` break to the lexicographically lowest id, so the
 * result never depends on Map insertion order.
 */
export function findFreshestLiveWorkerByRole(
  workers: Iterable<Worker>,
  teams: Iterable<Team>,
  role: string,
  opts: FreshestLiveWorkerOptions = {}
): Worker | null {
  const nowMs = opts.nowMs ?? Date.now();
  const timeoutMs = opts.timeoutMs ?? LIVENESS_TIMEOUT_MS;
  const excluded = new Set(opts.excludeWorkerIds ?? []);

  const roleTeamIds = new Set<string>();
  for (const team of teams) {
    if (team?.role === role) roleTeamIds.add(team.id);
  }
  if (roleTeamIds.size === 0) return null;

  let best: Worker | null = null;
  let bestMs = Number.NEGATIVE_INFINITY;
  for (const worker of workers) {
    if (!worker?.teamId || !roleTeamIds.has(worker.teamId)) continue;
    if (excluded.has(worker.id)) continue;
    if (!isWorkerAlive(worker, nowMs, timeoutMs)) continue;
    // Finite by construction: isWorkerAlive already rejected unparsable values.
    const lastMs = Date.parse(worker.lastActivityAt);
    if (lastMs > bestMs || (lastMs === bestMs && best !== null && worker.id < best.id)) {
      best = worker;
      bestMs = lastMs;
    }
  }
  return best;
}
