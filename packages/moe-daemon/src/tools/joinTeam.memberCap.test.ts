import fs from 'fs';
import path from 'path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MoeError, MoeErrorCode } from '../util/errors.js';
import { MAX_TEAM_MEMBERS } from '../util/teamSeats.js';
import { ToolTestHarness } from './toolTestHarness.js';
import { createTeamTool } from './createTeam.js';
import { joinTeamTool } from './joinTeam.js';
import { leaveTeamTool } from './leaveTeam.js';
import type { Team } from '../types/schema.js';

// No team seats more than MAX_TEAM_MEMBERS (10) members. A team's maxSize can
// only lower that, and a team saved with a larger maxSize keeps its members but
// seats no new one.
describe('team member cap', () => {
  const h = new ToolTestHarness();
  afterEach(() => { vi.restoreAllMocks(); h.cleanup(); });

  const join = async (teamId: string, workerId: string): Promise<Team> => {
    const { team } = await (joinTeamTool(h.state).handler({ teamId, workerId }, h.state) as Promise<{ team: Team }>);
    return team;
  };
  const leave = async (teamId: string, workerId: string): Promise<Team> => {
    const { team } = await (leaveTeamTool(h.state).handler({ teamId, workerId }, h.state) as Promise<{ team: Team }>);
    return team;
  };
  const ids = (prefix: string, n: number): string[] => Array.from({ length: n }, (_, i) => `${prefix}-${i + 1}`);

  describe('a default team', () => {
    let team: Team;
    beforeEach(async () => {
      h.init();
      h.setupMoeFolder();
      await h.state.load();
      team = await h.state.createTeam({ name: 'Fleet' });
    });

    const fill = async (): Promise<void> => {
      for (const id of ids('w', MAX_TEAM_MEMBERS)) await join(team.id, id);
    };

    it('defaults maxSize to the cap and seats the 10th member', async () => {
      expect(MAX_TEAM_MEMBERS).toBe(10);
      expect(team.maxSize).toBe(10);
      await fill();
      expect(h.state.getTeam(team.id)!.memberIds).toEqual(ids('w', 10));
    });

    it('refuses the 11th member with TEAM_FULL and writes nothing', async () => {
      await fill();
      const before = structuredClone(h.state.getTeam(team.id)!);
      const events: string[] = [];
      const off = h.state.subscribe((e) => { events.push(e.type); });
      let err: unknown;
      try {
        err = await join(team.id, 'w-11').catch((e: unknown) => e);
      } finally {
        off();
      }
      expect(err).toBeInstanceOf(MoeError);
      expect((err as MoeError).codeName).toBe('TEAM_FULL');
      expect((err as MoeError).code).toBe(MoeErrorCode.INVALID_STATE);
      expect((err as MoeError).message).toContain('Team Fleet is full (max 10 members)');
      expect(h.state.getTeam(team.id)).toEqual(before);
      // The refusal precedes auto-registration: no record, no file, no event.
      expect(h.state.getWorker('w-11')).toBeNull();
      expect(fs.existsSync(path.join(h.moePath, 'workers', 'w-11.json'))).toBe(false);
      expect(events).toEqual([]);
    });

    it('lets a current member re-join the full team without change', async () => {
      await fill();
      const before = h.state.getTeam(team.id)!.memberIds;
      expect((await join(team.id, 'w-3')).memberIds).toEqual(before);
    });

    it('seats a new member once a member leaves', async () => {
      await fill();
      await leave(team.id, 'w-4');
      expect(h.state.getTeam(team.id)!.memberIds).toHaveLength(9);
      const joined = await join(team.id, 'w-11');
      expect(joined.memberIds).toHaveLength(10);
      expect(joined.memberIds).toContain('w-11');
      expect(joined.memberIds).not.toContain('w-4');
    });

    it('refuses a maxSize above the cap at create and at update', async () => {
      const tool = createTeamTool(h.state);
      await expect(tool.handler({ name: 'Big', maxSize: 11 }, h.state)).rejects.toMatchObject({
        codeName: 'INVALID_INPUT',
        message: expect.stringContaining('Invalid maxSize: must be an integer between 1 and 10')
      });
      await expect(h.state.createTeam({ name: 'Big', maxSize: 11 })).rejects.toMatchObject({ codeName: 'INVALID_INPUT' });
      await expect(h.state.updateTeam(team.id, { maxSize: 11 })).rejects.toMatchObject({ codeName: 'INVALID_INPUT' });
      const ten = await tool.handler({ name: 'Ten', maxSize: 10 }, h.state) as { team: Team };
      expect(ten.team.maxSize).toBe(10);
    });
  });

  describe('a team saved with maxSize above the cap', () => {
    const teamId = 'team-legacy';
    const members = ids('m', 12);
    beforeEach(async () => {
      h.init();
      h.setupMoeFolder();
      fs.mkdirSync(path.join(h.moePath, 'teams'), { recursive: true });
      const now = new Date().toISOString();
      const legacy: Team = {
        id: teamId, projectId: 'proj-test', name: 'Legacy', role: null,
        memberIds: members, maxSize: 50, createdAt: now, updatedAt: now
      };
      fs.writeFileSync(path.join(h.moePath, 'teams', `${teamId}.json`), JSON.stringify(legacy, null, 2));
      await h.state.load();
    });

    it('keeps its members but seats no new one', async () => {
      expect(h.state.getTeam(teamId)!.memberIds).toEqual(members);
      await expect(join(teamId, 'w-new')).rejects.toMatchObject({
        codeName: 'TEAM_FULL',
        message: expect.stringContaining('Team Legacy is full (max 10 members)')
      });
      expect(h.state.getTeam(teamId)!.memberIds).toEqual(members);
      // A member's re-join and a rename still work.
      expect((await join(teamId, 'm-5')).memberIds).toEqual(members);
      expect((await h.state.updateTeam(teamId, { name: 'Legacy2' })).memberIds).toEqual(members);
    });

    it('refuses an update that adds a member past the cap, and allows removals', async () => {
      await expect(h.state.updateTeam(teamId, { memberIds: [...members, 'w-new'] })).rejects.toMatchObject({
        codeName: 'INVALID_INPUT',
        message: expect.stringContaining('Invalid memberIds: must not exceed 10 members')
      });
      expect((await h.state.updateTeam(teamId, { memberIds: members.slice(1) })).memberIds).toHaveLength(11);
    });

    it('seats a new member once its members drop below the cap', async () => {
      for (const id of members.slice(0, 3)) await leave(teamId, id);
      expect(h.state.getTeam(teamId)!.memberIds).toHaveLength(9);
      expect((await join(teamId, 'w-new')).memberIds).toEqual([...members.slice(3), 'w-new']);
      await expect(join(teamId, 'w-next')).rejects.toMatchObject({ codeName: 'TEAM_FULL' });
    });
  });
});
