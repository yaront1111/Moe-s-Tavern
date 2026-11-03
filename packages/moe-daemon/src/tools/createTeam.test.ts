import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ToolTestHarness } from './toolTestHarness.js';
import { createTeamTool } from './createTeam.js';

describe('moe.create_team', () => {
  const h = new ToolTestHarness();
  beforeEach(() => h.init());
  afterEach(() => { vi.restoreAllMocks(); h.cleanup(); });

  beforeEach(async () => {
    h.setupMoeFolder();
    await h.state.load();
  });

  it('creates a team with role', async () => {
    const tool = createTeamTool(h.state);
    const result = await tool.handler({ name: 'Moe Team', role: 'worker' }, h.state) as {
      team: { id: string; role: string | null };
      created: boolean;
    };

    expect(result.created).toBe(true);
    expect(result.team.role).toBe('worker');
    expect(result.team.id).toBeTruthy();
  });

  it('creates a team without role and is idempotent by name', async () => {
    const tool = createTeamTool(h.state);
    const first = await tool.handler({ name: 'Moe Team' }, h.state) as {
      team: { id: string; role: string | null };
      created: boolean;
    };
    expect(first.created).toBe(true);
    expect(first.team.role).toBeNull();

    const second = await tool.handler({ name: 'Moe Team' }, h.state) as {
      team: { id: string };
      created: boolean;
    };

    expect(second.created).toBe(false);
    expect(second.team.id).toBe(first.team.id);

    await expect(tool.handler({ name: 'Moe Team', maxSize: 0 }, h.state)).rejects.toThrow('maxSize');
  });

  it('rejects invalid team payloads without creating a team', async () => {
    const tool = createTeamTool(h.state);

    await expect(tool.handler({ name: 'Bad Team', role: 'worker', maxSize: 0 }, h.state)).rejects.toThrow('maxSize');
    await expect(tool.handler({ name: 'Bad Team', role: 'manager' }, h.state)).rejects.toThrow('role');

    expect(Array.from(h.state.teams.values()).some(team => team.name === 'Bad Team')).toBe(false);
  });

  it('ignores proxy-injected workerId field', async () => {
    const tool = createTeamTool(h.state);
    const result = await tool.handler({ name: 'InjectTest', workerId: 'worker' }, h.state) as {
      team: { id: string; name: string };
      created: boolean;
    };
    expect(result.team.name).toBe('InjectTest');
    expect(result.created).toBe(true);
  });
});

describe('create_team trims the name before its idempotency lookup', () => {
  const h = new ToolTestHarness();
  beforeEach(() => h.init());
  afterEach(() => { vi.restoreAllMocks(); h.cleanup(); });

  beforeEach(async () => {
    h.setupMoeFolder();
    await h.state.load();
  });

  type Res = { team: { id: string; name: string; role: string | null }; created: boolean };

  it('(t1) a space-padded name returns the existing team', async () => {
    const tool = createTeamTool(h.state);
    const a = await tool.handler({ name: 'Coders ' }, h.state) as Res;
    const b = await tool.handler({ name: 'Coders ' }, h.state) as Res;
    const c = await tool.handler({ name: '  Coders' }, h.state) as Res;

    expect({
      created: [a.created, b.created, c.created],
      sameIds: [b.team.id === a.team.id, c.team.id === a.team.id],
      name: a.team.name,
      size: h.state.teams.size
    }).toEqual({
      created: [true, false, false],
      sameIds: [true, true],
      name: 'Coders',
      size: 1
    });
  });

  it('(t2) a padded role-bound name matches, a roleless create stays separate', async () => {
    const tool = createTeamTool(h.state);
    const first = await tool.handler({ name: 'Gov', role: 'governor' }, h.state) as Res;
    const second = await tool.handler({ name: ' Gov', role: 'governor' }, h.state) as Res;
    const roleless = await tool.handler({ name: ' Gov ' }, h.state) as Res;

    expect(second.created).toBe(false);
    expect(second.team.id).toBe(first.team.id);
    expect(roleless.created).toBe(true);
    expect(roleless.team.id).not.toBe(first.team.id);
    expect(roleless.team.role).toBeNull();
    expect(roleless.team.name).toBe('Gov');
    expect(h.state.teams.size).toBe(2);
  });

  it('(t3) refusals keep their codes and write nothing', async () => {
    const tool = createTeamTool(h.state);

    await expect(tool.handler({ name: '   ' }, h.state)).rejects.toMatchObject({ codeName: 'INVALID_INPUT' });
    await expect(tool.handler({ name: 42 }, h.state)).rejects.toMatchObject({ codeName: 'INVALID_INPUT' });
    await expect(tool.handler({ name: '' }, h.state)).rejects.toMatchObject({ codeName: 'MISSING_REQUIRED' });

    expect(h.state.teams.size).toBe(0);
  });
});

