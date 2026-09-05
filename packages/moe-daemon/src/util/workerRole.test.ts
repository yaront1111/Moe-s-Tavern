import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ToolTestHarness } from '../tools/toolTestHarness.js';
import { resolveWorkerRole, roleFromWorkerId, workerHasRole } from './workerRole.js';
import type { TeamRole } from '../types/schema.js';

describe('util/workerRole', () => {
  const h = new ToolTestHarness();
  beforeEach(async () => {
    h.init();
    h.setupMoeFolder();
    await h.state.load();
  });
  afterEach(() => h.cleanup());

  async function addWorker(workerId: string, teamRole?: TeamRole | null): Promise<void> {
    await h.state.createWorker({
      id: workerId, type: 'CLAUDE', projectId: 'proj-test', epicId: null,
      currentTaskId: null, status: 'IDLE',
    });
    if (teamRole === undefined) return;
    const team = await h.state.createTeam(
      teamRole === null ? { name: `${workerId}-team` } : { name: `${workerId}-team`, role: teamRole }
    );
    await h.state.addTeamMember(team.id, workerId);
  }

  it('reads the role a launcher-minted id declares by its prefix', () => {
    expect(roleFromWorkerId('architect-1a2b')).toBe('architect');
    expect(roleFromWorkerId('governor-1a2b')).toBe('governor');
    expect(roleFromWorkerId('worker-1a2b')).toBe('worker');
    expect(roleFromWorkerId('qa-1a2b')).toBe('qa');
    expect(roleFromWorkerId('claude-1a2b')).toBeNull();
    expect(roleFromWorkerId('architects-1a2b')).toBeNull(); // the dash is part of the prefix
    expect(roleFromWorkerId('architect')).toBeNull();
    expect(roleFromWorkerId('')).toBeNull();
  });

  it('a roled team wins over the id prefix — join_team is the operator stating the role', async () => {
    await addWorker('worker-7', 'architect');
    expect(resolveWorkerRole(h.state, 'worker-7')).toBe('architect');
    expect(workerHasRole(h.state, 'worker-7', 'architect', 'governor')).toBe(true);
    expect(workerHasRole(h.state, 'worker-7', 'worker')).toBe(false);
  });

  it('falls back to the id prefix when the seat is on a role-less team', async () => {
    await addWorker('architect-2', null);
    expect(h.state.getTeamForWorker('architect-2')?.role ?? null).toBeNull();
    expect(resolveWorkerRole(h.state, 'architect-2')).toBe('architect');
    expect(workerHasRole(h.state, 'architect-2', 'architect', 'governor')).toBe(true);
  });

  it('falls back to the id prefix when the seat is on no team at all', async () => {
    await addWorker('governor-3');
    expect(resolveWorkerRole(h.state, 'governor-3')).toBe('governor');
    expect(workerHasRole(h.state, 'governor-3', 'governor')).toBe(true);
  });

  it('resolves nothing for an unprefixed id without a roled team, or no id', async () => {
    await addWorker('claude-4', null);
    expect(resolveWorkerRole(h.state, 'claude-4')).toBeNull();
    expect(workerHasRole(h.state, 'claude-4', 'architect', 'governor', 'worker', 'qa')).toBe(false);
    expect(resolveWorkerRole(h.state, '')).toBeNull();
    expect(workerHasRole(h.state, '', 'architect')).toBe(false);
  });

  it('does not need a worker record — the id alone is enough for the prefix fallback', () => {
    expect(resolveWorkerRole(h.state, 'qa-unregistered')).toBe('qa');
  });
});
