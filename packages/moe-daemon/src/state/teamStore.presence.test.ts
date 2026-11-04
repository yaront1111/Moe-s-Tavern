import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ToolTestHarness } from '../tools/toolTestHarness.js';
import { leaveTeamTool } from '../tools/leaveTeam.js';
import { runBlockedTimeoutSweep } from './sweeps.js';
import type { Team, Worker } from '../types/schema.js';

// A seat's presence (lastActivityAt) comes from its own calls and heartbeats.
// Un-pointing a record from a team is not presence: before this fix,
// removeTeamMember (moe.leave_team, /ws REMOVE_TEAM_MEMBER) and deleteTeam
// (/ws DELETE_TEAM) stamped the write time on it. That postponed a DEAD
// record's stale prune by a full staleWorkerTimeoutMs, and made a quiet live
// seat look alive for the isWorkerAlive window.
const FIXED = '2026-01-01T00:00:00.000Z';

describe('team membership writes do not count as presence', () => {
  const h = new ToolTestHarness();
  let team: Team;

  beforeEach(async () => {
    h.init();
    h.setupMoeFolder();
    await h.state.load();
    team = await h.state.createTeam({ name: 'Workers', maxSize: 5 });
    for (const id of ['w-dead', 'w-idle']) {
      await h.state.createWorker({ id, type: 'CLAUDE', projectId: 'proj-test', epicId: 'epic-1', currentTaskId: null, status: 'IDLE' });
      await h.state.addTeamMember(team.id, id);
      await h.state.updateWorker(id, { lastActivityAt: FIXED });
    }
    // A DEAD flip keeps the stored lastActivityAt, so this record stays at FIXED.
    await h.state.updateWorker('w-dead', { status: 'DEAD' });
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); h.cleanup(); });

  const worker = (id: string): Worker => h.state.getWorker(id)!;
  const expectUnpointedNotTouched = (): void => {
    expect(worker('w-dead')).toMatchObject({ status: 'DEAD', teamId: null, lastActivityAt: FIXED });
    expect(worker('w-idle')).toMatchObject({ status: 'IDLE', teamId: null, lastActivityAt: FIXED });
  };

  it('starts from two members at the fixed time (fixture guard)', () => {
    expect(h.state.getTeam(team.id)!.memberIds).toEqual(['w-dead', 'w-idle']);
    expect(worker('w-dead')).toMatchObject({ status: 'DEAD', teamId: team.id, lastActivityAt: FIXED });
    expect(worker('w-idle')).toMatchObject({ status: 'IDLE', teamId: team.id, lastActivityAt: FIXED });
  });

  it('removeTeamMember keeps each record lastActivityAt and status', async () => {
    await h.state.removeTeamMember(team.id, 'w-dead');
    await h.state.removeTeamMember(team.id, 'w-idle');
    expectUnpointedNotTouched();
    expect(h.state.getTeam(team.id)!.memberIds).toEqual([]);
  });

  it('the moe.leave_team handler keeps them as well', async () => {
    for (const workerId of ['w-dead', 'w-idle']) {
      await leaveTeamTool(h.state).handler({ teamId: team.id, workerId }, h.state);
    }
    expectUnpointedNotTouched();
    expect(h.state.getTeam(team.id)!.memberIds).toEqual([]);
  });

  it('deleteTeam keeps them as well', async () => {
    await h.state.deleteTeam(team.id);
    expectUnpointedNotTouched();
    expect(h.state.getTeam(team.id)).toBeNull();
  });

  it('a leave does not postpone the DEAD record stale prune', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const t0 = Date.parse(FIXED);
    vi.setSystemTime(t0 + 60_000);
    await leaveTeamTool(h.state).handler({ teamId: team.id, workerId: 'w-dead' }, h.state);

    vi.setSystemTime(t0 + h.state.staleWorkerTimeoutMs - 1_000);
    await h.state.mutex.runExclusive(() => runBlockedTimeoutSweep(h.state));
    expect(h.state.getWorker('w-dead')).not.toBeNull();

    vi.setSystemTime(t0 + h.state.staleWorkerTimeoutMs + 1_000);
    await h.state.mutex.runExclusive(() => runBlockedTimeoutSweep(h.state));
    expect(h.state.getWorker('w-dead')).toBeNull();
  });
});
