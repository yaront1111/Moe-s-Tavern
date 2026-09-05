import type { StateManager } from '../state/StateManager.js';
import type { TeamRole } from '../types/schema.js';

/**
 * Worker-id prefixes the launchers mint, mapped to the role they mean. The
 * launcher scripts (scripts/moe-agent.{ps1,sh}) name every seat
 * `<role>-<hex>`, so the prefix is the seat's declared kind.
 */
const ID_PREFIX_ROLES: ReadonlyArray<readonly [string, TeamRole]> = Object.freeze([
  ['architect-', 'architect'],
  ['governor-', 'governor'],
  ['worker-', 'worker'],
  ['qa-', 'qa'],
] as const);

/** The role a worker id declares by its prefix, or null when it declares none. */
export function roleFromWorkerId(workerId: string): TeamRole | null {
  for (const [prefix, role] of ID_PREFIX_ROLES) {
    if (workerId.startsWith(prefix)) return role;
  }
  return null;
}

/**
 * The role a worker acts with, for the role-gated tools (set_task_dependencies,
 * amend_plan_step, submit_plan_critique).
 *
 * A worker record has NO role field of its own — `team.role` is the only place
 * a role is stored — so a seat on a role-less team resolved to NOTHING and every
 * role gate refused it. That is not a rare edge: `createWorker` sets
 * `teamId: null` and `createTeam` accepts `role` as optional, so any team made
 * without one (e.g. a project-named team the launcher registers every seat into)
 * silently strips architects, QA and governors of their role. Measured
 * 2026-09-04: five SPIDR parents shipped with `dependsOn: []` because the
 * planning architect was refused `set_task_dependencies`, and two worker
 * sessions were spent discovering it.
 *
 * So: the team's role wins when it has one — an explicit `join_team` onto a
 * roled team is the operator stating the seat's role, and it must be able to
 * override the id. Only when the team supplies nothing do we fall back to what
 * the id declares.
 *
 * This is a workflow guard, not a security boundary: `join_team` is unauthenticated
 * and any seat may join any team, so the prefix fallback grants nothing a seat
 * could not already grant itself with one call. It exists so the common case —
 * a correctly-named seat on a role-less team — behaves the way the operator meant.
 */
export function resolveWorkerRole(state: StateManager, workerId: string): TeamRole | null {
  if (!workerId) return null;
  const teamRole = state.getTeamForWorker(workerId)?.role;
  if (teamRole) return teamRole;
  return roleFromWorkerId(workerId);
}

/** True when the worker acts with any of the given roles. */
export function workerHasRole(
  state: StateManager,
  workerId: string,
  ...roles: readonly TeamRole[]
): boolean {
  const role = resolveWorkerRole(state, workerId);
  return role !== null && roles.includes(role);
}
