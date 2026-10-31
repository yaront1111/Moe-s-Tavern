import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ToolTestHarness } from './toolTestHarness.js';
import { joinTeamTool } from './joinTeam.js';
import { deregisterWorkerTool } from './deregisterWorker.js';
import { findTombstonedTeam, resolveEffectiveTeam } from '../util/teamMembershipHeal.js';
import type { Team, Worker } from '../types/schema.js';

// A DEAD worker (deregistered by a closed terminal tab or a hot reload) keeps
// its record, and so its seat, until the stale prune. Counting it against
// maxSize left a full team refusing every new seat for about 35 minutes, and
// a seat without a team skips every epic a live worker already holds. A join
// into a full team now evicts the DEAD members first, the way deleteWorker
// does, and is refused only when the live members fill the team.
describe('moe.join_team does not let DEAD members hold seats', () => {
  const h = new ToolTestHarness();
  let team: Team;

  beforeEach(async () => {
    h.init();
    h.setupMoeFolder();
    await h.state.load();
    team = await h.state.createTeam({ name: 'Workers', maxSize: 3 });
  });
  afterEach(() => { vi.restoreAllMocks(); h.cleanup(); });

  const teamNow = (teamId = team.id): Team => h.state.getTeam(teamId)!;
  const worker = (id: string): Worker => h.state.getWorker(id)!;
  const live = (t: Team): string[] => t.memberIds.filter((id) => h.state.getWorker(id)?.status !== 'DEAD');
  // Every successful join keeps both the seats and the live members within maxSize.
  const join = async (workerId: string, teamId = team.id): Promise<Team> => {
    const { team: joined } = await (joinTeamTool(h.state).handler({ teamId, workerId }, h.state) as Promise<{ team: Team }>);
    expect(joined.memberIds.length).toBeLessThanOrEqual(joined.maxSize);
    expect(live(joined).length).toBeLessThanOrEqual(joined.maxSize);
    return joined;
  };
  const deregister = async (workerId: string, reason: string): Promise<void> => {
    await deregisterWorkerTool(h.state).handler({ workerId, reason }, h.state);
  };

  // maxSize 3: w-a, w-b, w-c joined, then w-a and w-b lost their tabs.
  const fullWithTwoDead = async (): Promise<{ a: Worker; b: Worker }> => {
    for (const id of ['w-a', 'w-b', 'w-c']) await join(id);
    await deregister('w-a', 'terminal_closed');
    await deregister('w-b', 'terminal_closed');
    return { a: worker('w-a'), b: worker('w-b') };
  };

  it('evicts the DEAD members to formerMemberIds and seats a new worker in the full team', async () => {
    const { a, b } = await fullWithTwoDead();
    expect(a.status).toBe('DEAD');
    expect(teamNow().memberIds).toEqual(['w-a', 'w-b', 'w-c']);

    const joined = await join('w-new');

    expect(joined.memberIds).toEqual(['w-c', 'w-new']);
    expect(joined.formerMemberIds).toEqual(['w-a', 'w-b']);
    for (const before of [a, b]) {
      const after = worker(before.id);
      expect(after.status).toBe('DEAD');
      expect(after.teamId).toBeNull();
      expect(after.lastActivityAt).toBe(before.lastActivityAt);
    }
    expect(worker('w-new').teamId).toBe(team.id);
  });

  it('still caps the live members at maxSize, and a refused join writes nothing', async () => {
    await fullWithTwoDead();
    await join('w-new');
    await join('w-n2');
    expect(teamNow().memberIds).toEqual(['w-c', 'w-new', 'w-n2']);

    const before = structuredClone(teamNow());
    await expect(join('w-n3')).rejects.toThrow(`Team Workers is full (max 3 members)`);
    expect(teamNow()).toEqual(before);
  });

  it('a DEAD member re-joining under its own id (wrapper_restart) keeps its seat in a full team', async () => {
    const pair = await h.state.createTeam({ name: 'Pair', maxSize: 2 });
    await join('w-x', pair.id);
    await join('w-live', pair.id);
    await deregister('w-x', 'wrapper_restart');
    expect(worker('w-x').status).toBe('DEAD');
    const liveBefore = structuredClone(worker('w-live'));
    const teamBefore = structuredClone(teamNow(pair.id));

    const joined = await join('w-x', pair.id);

    expect(joined.memberIds).toEqual(['w-x', 'w-live']);
    expect(teamNow(pair.id)).toEqual(teamBefore);
    expect(joined.formerMemberIds ?? []).toEqual([]);
    expect(worker('w-x').status).toBe('IDLE');
    expect(worker('w-x').teamId).toBe(pair.id);
    expect(worker('w-live')).toEqual(liveBefore);
    await expect(join('w-other', pair.id)).rejects.toThrow('is full');
  });

  it('evicted members stay on the claim filter and match deleteWorker tombstones', async () => {
    await fullWithTwoDead();
    await join('w-new');

    // The claim filter's own resolver still places the evicted worker on the team.
    expect(h.state.getTeamForWorker('w-a')).toBeNull();
    expect(resolveEffectiveTeam(h.state, 'w-a')?.id).toBe(team.id);

    // A later prune of the evicted record adds no second tombstone.
    await h.state.deleteWorker('w-b');
    expect(teamNow().formerMemberIds).toEqual(['w-a', 'w-b']);
    expect(teamNow().memberIds).toEqual(['w-c', 'w-new']);

    // An evicted worker that joins again, with a seat free, leaves the tombstone.
    const joined = await join('w-a');
    expect(joined.memberIds).toEqual(['w-c', 'w-new', 'w-a']);
    expect(findTombstonedTeam(h.state, 'w-a')).toBeNull();
    expect(worker('w-a').status).toBe('IDLE');
    expect(worker('w-a').teamId).toBe(team.id);
  });

  it('a team below maxSize never evicts a DEAD member', async () => {
    await join('w-a');
    await join('w-b');
    await deregister('w-a', 'terminal_closed');

    const joined = await join('w-c');

    expect(joined.memberIds).toEqual(['w-a', 'w-b', 'w-c']);
    expect(joined.formerMemberIds ?? []).toEqual([]);
    expect(worker('w-a').status).toBe('DEAD');
    expect(worker('w-a').teamId).toBe(team.id);
  });

  it('a DEAD member whose teamId names another team keeps that pointer when evicted', async () => {
    const other = await h.state.createTeam({ name: 'Elsewhere', maxSize: 3 });
    await fullWithTwoDead();
    await h.state.updateWorker('w-a', { teamId: other.id, lastActivityAt: worker('w-a').lastActivityAt });

    await join('w-new');

    expect(teamNow().formerMemberIds).toEqual(['w-a', 'w-b']);
    expect(worker('w-a').teamId).toBe(other.id);
    expect(worker('w-b').teamId).toBeNull();
  });

  it('a member without a worker record is not DEAD and keeps its seat', async () => {
    const pair = await h.state.createTeam({ name: 'Pair', maxSize: 2 });
    await h.state.updateTeam(pair.id, { memberIds: ['w-ghost', 'w-live'] });
    expect(h.state.getWorker('w-ghost')).toBeNull();
    const before = structuredClone(teamNow(pair.id));

    await expect(join('w-new', pair.id)).rejects.toThrow('Team Pair is full (max 2 members)');
    expect(teamNow(pair.id)).toEqual(before);
  });
});
