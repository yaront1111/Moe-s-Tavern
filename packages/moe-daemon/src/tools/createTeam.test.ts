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

