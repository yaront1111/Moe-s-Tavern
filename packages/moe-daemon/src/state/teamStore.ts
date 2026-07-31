// =============================================================================
// Team store - teams, roles and membership
// =============================================================================
//
// Extracted verbatim from StateManager. Validators are imported straight from
// ./validators.js rather than routed back through the StateManager instance, so
// the runtime import edge points one way (teamStore -> validators).
//
// Calls between public team functions go through `state.` on purpose: the
// originals dispatched through `this`, and a direct module call would silently
// bypass any instance-level override or test spy.
//
// deleteTeam and removeTeamMember mutate worker records through
// state.updateWorker. Their ordering and per-call error handling are load
// bearing: one failed member update must still leave the team write consistent
// and the WORKER_UPDATED emissions in the same sequence.

import fs from 'fs';
import path from 'path';
import type { StateManager } from './StateManager.js';
import type { Team, TeamRole } from '../types/schema.js';
import { logger } from '../util/logger.js';
import { generateId } from '../util/ids.js';
import { validateCreateTeamInput, validateTeamUpdates } from './validators.js';

export function getTeam(state: StateManager, teamId: string): Team | null {
  return state.teams.get(teamId) || null;
}

export function getTeamByNameAndRole(state: StateManager, name: string, role: TeamRole | null): Team | null {
  for (const team of state.teams.values()) {
    if (team.name === name && team.role === role) return team;
  }
  return null;
}

export function getTeamByName(state: StateManager, name: string): Team | null {
  for (const team of state.teams.values()) {
    if (team.name === name) return team;
  }
  return null;
}

export function getTeamForWorker(state: StateManager, workerId: string): Team | null {
  const worker = state.workers.get(workerId);
  if (!worker?.teamId) return null;
  return state.teams.get(worker.teamId) || null;
}

export async function createTeam(state: StateManager, input: { name: string; role?: TeamRole | null; maxSize?: number }): Promise<Team> {
  if (!state.project) throw new Error('Project not loaded');

  const validated = validateCreateTeamInput(input);
  const now = new Date().toISOString();
  const team: Team = {
    id: generateId('team'),
    projectId: state.project.id,
    name: validated.name,
    role: validated.role,
    memberIds: [],
    maxSize: validated.maxSize,
    createdAt: now,
    updatedAt: now
  };

  await state.writeEntity('teams', team.id, team);
  state.teams.set(team.id, team);
  state.appendActivity('TEAM_CREATED', { name: team.name, role: team.role });
  state.emit({ type: 'TEAM_CREATED', payload: team });
  return team;
}

export async function updateTeam(state: StateManager, teamId: string, updates: Partial<Team>): Promise<Team> {
  const team = state.teams.get(teamId);
  if (!team) throw new Error(`Team not found: ${teamId}`);

  const sanitizedUpdates = validateTeamUpdates(team, updates);
  const updated: Team = {
    ...team,
    ...sanitizedUpdates,
    updatedAt: new Date().toISOString()
  };

  await state.writeEntity('teams', teamId, updated);
  state.teams.set(teamId, updated);
  state.appendActivity('TEAM_UPDATED', sanitizedUpdates as Record<string, unknown>);
  state.emit({ type: 'TEAM_UPDATED', payload: updated });
  return updated;
}

export async function deleteTeam(state: StateManager, teamId: string): Promise<Team> {
  const team = state.teams.get(teamId);
  if (!team) throw new Error(`Team not found: ${teamId}`);

  // Clear teamId on every worker that points at this team. Iterate all
  // workers rather than only team.memberIds: a worker whose teamId still
  // references this team but was dropped from memberIds out-of-band would
  // otherwise be left pointing at a now-deleted team.
  for (const worker of state.workers.values()) {
    if (worker.teamId === teamId) {
      await state.updateWorker(worker.id, { teamId: null });
    }
  }

  const filePath = path.join(state.moePath, 'teams', `${teamId}.json`);
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch (error) {
    const fsError = error as NodeJS.ErrnoException;
    if (fsError.code !== 'ENOENT') {
      throw error;
    }
  }
  state.teams.delete(teamId);

  state.appendActivity('TEAM_DELETED', { name: team.name });
  state.emit({ type: 'TEAM_DELETED', payload: team });
  return team;
}

export async function addTeamMember(state: StateManager, teamId: string, workerId: string): Promise<Team> {
  const team = state.teams.get(teamId);
  if (!team) throw new Error(`Team not found: ${teamId}`);

  if (team.memberIds.includes(workerId)) {
    return team; // Already a member, idempotent
  }

  if (team.memberIds.length >= team.maxSize) {
    throw new Error(`Team ${team.name} is full (max ${team.maxSize} members)`);
  }

  // A worker belongs to exactly one team (worker.teamId is single-valued).
  // Remove it from any previous team's memberIds first, otherwise the old
  // team keeps listing it — inflating member counts, "team full" checks, and
  // memberIds-iterating consumers (e.g. submit_plan's governor lookup) that
  // would treat the moved worker as still a member of the old team.
  const worker = state.workers.get(workerId);
  if (worker?.teamId && worker.teamId !== teamId) {
    const oldTeam = state.teams.get(worker.teamId);
    if (oldTeam?.memberIds.includes(workerId)) {
      await state.updateTeam(worker.teamId, {
        memberIds: oldTeam.memberIds.filter((id) => id !== workerId)
      });
    }
  }

  const updated = await state.updateTeam(teamId, {
    memberIds: [...team.memberIds, workerId]
  });

  // Set worker's teamId
  if (worker) {
    await state.updateWorker(workerId, { teamId });
  }

  state.appendActivity('TEAM_MEMBER_ADDED', { teamId, workerId });
  return updated;
}

export async function removeTeamMember(state: StateManager, teamId: string, workerId: string): Promise<Team> {
  const team = state.teams.get(teamId);
  if (!team) throw new Error(`Team not found: ${teamId}`);

  // Repair the worker's teamId pointer FIRST, regardless of the memberIds
  // early-return below. If the memberIds entry was already removed out-of-band
  // (e.g. a half-applied edit) but worker.teamId still points here, the worker
  // would otherwise be permanently trapped in a team it isn't listed in. Only
  // clear when it actually points at the team being left — a worker may be a
  // stale member of this team's memberIds while its real team is another.
  const worker = state.workers.get(workerId);
  if (worker && worker.teamId === teamId) {
    await state.updateWorker(workerId, { teamId: null });
  }

  if (!team.memberIds.includes(workerId)) {
    return team; // Not a member, idempotent (teamId already repaired above)
  }

  const updated = await state.updateTeam(teamId, {
    memberIds: team.memberIds.filter((id) => id !== workerId)
  });

  state.appendActivity('TEAM_MEMBER_REMOVED', { teamId, workerId });
  return updated;
}
