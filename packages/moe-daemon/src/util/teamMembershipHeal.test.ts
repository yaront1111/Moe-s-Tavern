import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { StateManager } from '../state/StateManager.js';
import {
  MAX_TOMBSTONES_PER_TEAM,
  NO_TEAM_MEMBERSHIP,
  findTombstonedTeam,
  healTeamMembership,
  noTeamMembershipRefusal,
  resolveEffectiveTeam,
  withEvictionTombstones,
} from './teamMembershipHeal.js';
import type { Project, Team } from '../types/schema.js';

function team(overrides: Partial<Team> = {}): Team {
  const now = new Date().toISOString();
  return {
    id: 'team-1', projectId: 'proj-test', name: 'workers', role: 'worker',
    memberIds: [], maxSize: 10, createdAt: now, updatedAt: now,
    ...overrides,
  };
}

describe('withEvictionTombstones', () => {
  it('appends an evicted id to a team that carried no tombstones', () => {
    expect(withEvictionTombstones(team(), ['w-1'])).toEqual(['w-1']);
  });

  it('keeps earlier tombstones and appends the new one in order', () => {
    expect(withEvictionTombstones(team({ formerMemberIds: ['w-1'] }), ['w-2', 'w-3']))
      .toEqual(['w-1', 'w-2', 'w-3']);
  });

  it('forgets the oldest tombstones once the cap is reached', () => {
    const full = Array.from({ length: MAX_TOMBSTONES_PER_TEAM }, (_, i) => `w-${i}`);
    const result = withEvictionTombstones(team({ formerMemberIds: full }), ['w-new']);

    expect(result).toHaveLength(MAX_TOMBSTONES_PER_TEAM);
    expect(result[MAX_TOMBSTONES_PER_TEAM - 1]).toBe('w-new');
    expect(result).not.toContain('w-0');
    expect(result[0]).toBe('w-1');
  });

  it('never records the same worker twice', () => {
    expect(withEvictionTombstones(team({ formerMemberIds: ['w-1', 'w-2'] }), ['w-1']))
      .toEqual(['w-2', 'w-1']);
    expect(withEvictionTombstones(team(), ['w-1', 'w-1'])).toEqual(['w-1']);
  });
});

describe('noTeamMembershipRefusal', () => {
  it('carries the stable code, the join_team exit and no race wording', () => {
    const refusal = noTeamMembershipRefusal('w-solo');

    expect(refusal.hasNext).toBe(false);
    expect(refusal.code).toBe('NO_TEAM_MEMBERSHIP');
    expect(NO_TEAM_MEMBERSHIP).toBe('NO_TEAM_MEMBERSHIP');
    expect(refusal.nextAction.tool).toBe('moe.join_team');
    expect(refusal.nextAction.args).toEqual({ workerId: 'w-solo' });
    expect(refusal.nextAction.reason).toContain('w-solo');
    expect(refusal.nextAction.reason).toContain('moe.join_team');
    expect(JSON.stringify(refusal)).not.toContain('taken by concurrent workers');
  });
});

describe('teamMembershipHeal — over a real store', () => {
  let testDir: string;
  let moePath: string;
  let state: StateManager;

  beforeEach(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moe-heal-'));
    moePath = path.join(testDir, '.moe');
    fs.mkdirSync(moePath, { recursive: true });
    for (const sub of ['epics', 'tasks', 'workers', 'proposals', 'channels', 'messages', 'teams']) {
      fs.mkdirSync(path.join(moePath, sub));
    }
    const project: Partial<Project> = {
      id: 'proj-test', schemaVersion: 6, name: 'Test', rootPath: testDir,
      globalRails: { techStack: [], forbiddenPatterns: [], requiredPatterns: [], formatting: '', testing: '', customRules: [] },
      settings: {
        approvalMode: 'TURBO', speedModeDelayMs: 2000, autoCreateBranch: false,
        branchPattern: '', commitPattern: '', agentCommand: 'claude', enableAgentTeams: false,
      },
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(moePath, 'project.json'), JSON.stringify(project, null, 2));
    state = new StateManager({ projectPath: testDir });
    await state.load();
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  async function register(id: string): Promise<void> {
    await state.createWorker({
      id, type: 'CLAUDE', projectId: 'proj-test', epicId: '',
      currentTaskId: null, status: 'IDLE',
    });
  }

  it('finds the team a worker was evicted from, and none for a stranger', async () => {
    await register('w-1');
    const t = await state.createTeam({ name: 'workers', role: 'worker' });
    await state.addTeamMember(t.id, 'w-1');
    await state.deleteWorker('w-1');

    expect(findTombstonedTeam(state, 'w-1')?.id).toBe(t.id);
    expect(findTombstonedTeam(state, 'w-never-seen')).toBeNull();
  });

  it('prefers live membership over a tombstone when resolving eligibility', async () => {
    await register('w-1');
    const evicted = await state.createTeam({ name: 'old', role: 'worker' });
    await state.addTeamMember(evicted.id, 'w-1');
    await state.deleteWorker('w-1');
    await register('w-1');
    const current = await state.createTeam({ name: 'new', role: 'worker' });
    await state.addTeamMember(current.id, 'w-1');

    expect(resolveEffectiveTeam(state, 'w-1')?.id).toBe(current.id);
    // Joining clears the tombstone, so exactly one team can claim the worker.
    expect(findTombstonedTeam(state, 'w-1')).toBeNull();
  });

  it('rejoins an evicted worker once its record is back', async () => {
    await register('w-1');
    const t = await state.createTeam({ name: 'workers', role: 'worker' });
    await state.addTeamMember(t.id, 'w-1');
    await state.deleteWorker('w-1');
    await register('w-1');

    const healed = await healTeamMembership(state, 'w-1');

    expect(healed?.id).toBe(t.id);
    expect(state.getTeamForWorker('w-1')?.id).toBe(t.id);
    expect(state.getTeam(t.id)?.formerMemberIds).toEqual([]);
  });

  it('does nothing when membership is already present', async () => {
    await register('w-1');
    const t = await state.createTeam({ name: 'workers', role: 'worker' });
    await state.addTeamMember(t.id, 'w-1');

    expect(await healTeamMembership(state, 'w-1')).toBeNull();
    expect(state.getTeamForWorker('w-1')?.id).toBe(t.id);
  });

  it('does nothing while the worker record is still missing', async () => {
    await register('w-1');
    const t = await state.createTeam({ name: 'workers', role: 'worker' });
    await state.addTeamMember(t.id, 'w-1');
    await state.deleteWorker('w-1');

    expect(await healTeamMembership(state, 'w-1')).toBeNull();
    // The tombstone survives for the next touch rather than being consumed.
    expect(findTombstonedTeam(state, 'w-1')?.id).toBe(t.id);
  });

  it('refuses to heal into a team that filled up, without throwing', async () => {
    await register('w-1');
    const t = await state.createTeam({ name: 'workers', role: 'worker', maxSize: 1 });
    await state.addTeamMember(t.id, 'w-1');
    await state.deleteWorker('w-1');
    await register('w-2');
    await state.addTeamMember(t.id, 'w-2');
    await register('w-1');

    expect(await healTeamMembership(state, 'w-1')).toBeNull();
    expect(state.getTeamForWorker('w-1')).toBeNull();
    expect(state.getTeam(t.id)?.memberIds).toEqual(['w-2']);
  });

  it('keeps the tombstone when a join into a FULL team is refused', async () => {
    await register('w-1');
    const t = await state.createTeam({ name: 'workers', role: 'worker', maxSize: 1 });
    await state.addTeamMember(t.id, 'w-1');
    await state.deleteWorker('w-1');
    await register('w-2');
    await state.addTeamMember(t.id, 'w-2');
    await register('w-1');

    await expect(state.addTeamMember(t.id, 'w-1')).rejects.toThrow(/is full/);

    // The failed join must not strip the evicted worker's route home.
    expect(findTombstonedTeam(state, 'w-1')?.id).toBe(t.id);
  });

  it('drops the tombstone when a worker deliberately leaves', async () => {
    await register('w-1');
    const t = await state.createTeam({ name: 'workers', role: 'worker' });
    await state.addTeamMember(t.id, 'w-1');
    await state.deleteWorker('w-1');
    await register('w-1');
    await state.removeTeamMember(t.id, 'w-1');

    expect(findTombstonedTeam(state, 'w-1')).toBeNull();
    expect(await healTeamMembership(state, 'w-1')).toBeNull();
    expect(resolveEffectiveTeam(state, 'w-1')).toBeNull();
  });
});
