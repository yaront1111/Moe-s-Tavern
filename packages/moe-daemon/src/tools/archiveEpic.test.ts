import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ToolTestHarness } from './toolTestHarness.js';
import { archiveEpicTool } from './archiveEpic.js';

describe('moe.archive_epic', () => {
  const h = new ToolTestHarness();
  beforeEach(() => h.init());
  afterEach(() => { vi.restoreAllMocks(); h.cleanup(); });

  beforeEach(async () => {
    h.setupMoeFolder();
    h.createEpic();
    await h.state.load();
  });

  it('archives the epic and all its resting tickets', async () => {
    h.createTask({ id: 'task-1', status: 'DONE' });
    h.createTask({ id: 'task-2', status: 'BACKLOG' });
    await h.state.load();
    const tool = archiveEpicTool(h.state);
    const result = await tool.handler({ epicId: 'epic-1' }, h.state) as {
      success: boolean; epicStatus: string; archivedTaskCount: number; totalTasks: number;
    };
    expect(result.success).toBe(true);
    expect(result.epicStatus).toBe('ARCHIVED');
    expect(result.archivedTaskCount).toBe(2);
    expect(result.totalTasks).toBe(2);
    expect(h.state.getEpic('epic-1')!.status).toBe('ARCHIVED');
    expect(h.state.getTask('task-1')!.status).toBe('ARCHIVED');
    expect(h.state.getTask('task-2')!.status).toBe('ARCHIVED');
  });

  it('refuses when the epic has an in-flight ticket', async () => {
    h.createTask({ id: 'task-1', status: 'WORKING' });
    await h.state.load();
    const tool = archiveEpicTool(h.state);
    await expect(tool.handler({ epicId: 'epic-1' }, h.state)).rejects.toThrow();
    // nothing changed
    expect(h.state.getEpic('epic-1')!.status).not.toBe('ARCHIVED');
  });

  it('archives an empty epic', async () => {
    const tool = archiveEpicTool(h.state);
    const result = await tool.handler({ epicId: 'epic-1' }, h.state) as { archivedTaskCount: number; epicStatus: string };
    expect(result.archivedTaskCount).toBe(0);
    expect(result.epicStatus).toBe('ARCHIVED');
  });

  it('throws for an unknown epic', async () => {
    const tool = archiveEpicTool(h.state);
    await expect(tool.handler({ epicId: 'nope' }, h.state)).rejects.toThrow();
  });
});

