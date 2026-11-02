import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ToolTestHarness } from './toolTestHarness.js';
import { archiveEpicTool } from './archiveEpic.js';
import { setTaskStatusTool } from './setTaskStatus.js';

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

  it('clears a BLOCKED row\'s block fields exactly as archive_task does; un-archiving carries none of them', async () => {
    h.createEpic({ id: 'epic-2' });
    h.createTask({ id: 'task-dep', epicId: 'epic-2', status: 'WORKING' });
    h.createTask({ id: 'task-done', status: 'DONE' });
    h.createTask({
      id: 'task-bk', status: 'BLOCKED', blockedReason: 'needs PostgreSQL', blockedResourceId: 'pg-box',
      blockedOnTaskIds: ['task-dep'], blockedFromStatus: 'WORKING', blockedAt: '2026-09-05T22:22:00.000Z',
    });
    await h.state.load();
    const result = await archiveEpicTool(h.state).handler({ epicId: 'epic-1' }, h.state) as { archivedTaskCount: number };
    expect(result.archivedTaskCount).toBe(2);
    expect(h.state.getTask('task-bk')).toMatchObject({
      status: 'ARCHIVED', priorBlockedReason: 'needs PostgreSQL', blockedReason: null,
      blockedResourceId: null, blockedOnTaskIds: null, blockedFromStatus: null, blockedAt: null,
    });
    const done = h.state.getTask('task-done')!;
    expect(done.status).toBe('ARCHIVED');
    expect(done.priorBlockedReason ?? null).toBeNull();
    await setTaskStatusTool(h.state).handler({ taskId: 'task-bk', status: 'WORKING' }, h.state);
    expect(h.state.getTask('task-bk')).toMatchObject({ status: 'WORKING', blockedOnTaskIds: null, blockedFromStatus: null });
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

