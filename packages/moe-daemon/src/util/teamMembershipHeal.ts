import type { StateManager } from '../state/StateManager.js';
import type { Team } from '../types/schema.js';

/**
 * Team membership survives the worker record it is stored on.
 *
 * `getTeamForWorker` reads `worker.teamId`, so membership dies whenever the
 * WORKER RECORD dies — the stale sweep, the DEAD-worker prune and the startup
 * purge all call `deleteWorker`/`purgeAllWorkers`, and the claim path then
 * auto-registers the returning worker with `teamId: null`. The worker comes
 * back as a solo with no event to notice, and the solo single-worker-per-
 * epic+status rule starts refusing claims it should allow.
 *
 * The tombstone therefore lives on the TEAM (`Team.formerMemberIds`), which
 * outlives every eviction path. Membership heals on the next touch instead of
 * requiring an agent to spot it and call `moe.join_team` by hand.
 */

/**
 * Stable reason code for a claim refused purely because the claimer has no
 * team membership. Distinct from the concurrent-claim tail so a reader is
 * never sent hunting for a race that did not happen.
 */
export const NO_TEAM_MEMBERSHIP = 'NO_TEAM_MEMBERSHIP';

/**
 * How many evicted members one team remembers. Ids are stable per agent slot,
 * so this is generous in practice; the cap exists so a fleet that rotates ids
 * cannot grow the array on disk without bound. Oldest tombstones drop first —
 * they are the least likely to come back.
 */
export const MAX_TOMBSTONES_PER_TEAM = 200;

/**
 * The team's `formerMemberIds` after `evictedIds` lost their worker records.
 * Pure, order-stable and duplicate-free: an id already tombstoned here keeps
 * one entry, never two.
 */
export function withEvictionTombstones(team: Team, evictedIds: readonly string[]): string[] {
  const evicted: string[] = [];
  for (const id of evictedIds) {
    if (!evicted.includes(id)) evicted.push(id);
  }
  const kept = (team.formerMemberIds ?? []).filter((id) => !evicted.includes(id));
  return [...kept, ...evicted].slice(-MAX_TOMBSTONES_PER_TEAM);
}

/**
 * The team a worker was evicted from, or null. A worker belongs to exactly one
 * team, and `addTeamMember`/`removeTeamMember` clear the tombstone everywhere,
 * so at most one team can carry it.
 */
export function findTombstonedTeam(state: StateManager, workerId: string): Team | null {
  for (const team of state.teams.values()) {
    if (team.formerMemberIds?.includes(workerId)) return team;
  }
  return null;
}

/**
 * Membership as the eligibility rules must see it: the live one, else the
 * tombstone. Read by claim_next_task's solo epic+status block and by
 * wait_for_task's mirror of it, so an evicted team member is neither refused
 * nor made invisible in the window before its record is rebuilt.
 */
export function resolveEffectiveTeam(state: StateManager, workerId: string): Team | null {
  return state.getTeamForWorker(workerId) ?? findTombstonedTeam(state, workerId);
}

/**
 * Restore durable membership for a worker whose record was rebuilt after an
 * eviction. Quiet and idempotent — it does nothing when membership is already
 * present (so a healthy claim emits no join event), and it never throws into
 * the caller: a claim must not fail because healing could not run.
 */
export async function healTeamMembership(state: StateManager, workerId: string): Promise<Team | null> {
  if (state.getTeamForWorker(workerId)) return null;
  const tombstoned = findTombstonedTeam(state, workerId);
  if (!tombstoned) return null;
  // The rejoin writes worker.teamId, which needs the record to exist; the claim
  // path only auto-registers after it wins a task, so heal after that point.
  if (!state.getWorker(workerId)) return null;
  // A team that filled up while the worker was gone keeps its seats: healing
  // must never evict a current member, and must never surface as an error.
  if (tombstoned.memberIds.length >= tombstoned.maxSize) return null;
  try {
    return await state.addTeamMember(tombstoned.id, workerId);
  } catch {
    return null;
  }
}

export interface NoTeamMembershipRefusal {
  hasNext: false;
  code: typeof NO_TEAM_MEMBERSHIP;
  nextAction: {
    tool: 'moe.join_team';
    args: { workerId: string };
    reason: string;
  };
}

/**
 * The truthful refusal for a claimer skipped only by the solo epic+status rule.
 * Names the rule that refused and the one call that clears it; deliberately
 * carries none of the concurrent-claim wording.
 */
export function noTeamMembershipRefusal(workerId: string): NoTeamMembershipRefusal {
  return {
    hasNext: false,
    code: NO_TEAM_MEMBERSHIP,
    nextAction: {
      tool: 'moe.join_team',
      args: { workerId },
      reason:
        `Worker ${workerId} belongs to no team, and every claimable candidate sits in an ` +
        'epic+status a live worker already holds. A team may work one epic+status in parallel; ' +
        'a solo worker may not — so the queue is not empty and nothing raced you, your team ' +
        'membership is missing. Call moe.join_team { workerId, teamId } with your team id ' +
        '(moe.list_teams lists them) and claim again.'
    }
  };
}
