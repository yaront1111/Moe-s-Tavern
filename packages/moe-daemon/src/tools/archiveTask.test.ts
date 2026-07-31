import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ToolTestHarness } from './toolTestHarness.js';
import { archiveTaskTool } from './archiveTask.js';

describe('moe.archive_task', () => {
  const h = new ToolTestHarness();
  beforeEach(() => h.init());
  afterEach(() => { vi.restoreAllMocks(); h.cleanup(); });

  beforeEach(async () => {
    h.setupMoeFolder();
    h.createEpic();
    h.createTask({ id: 'task-1', status: 'DONE' });
    await h.state.load();
  });

  it('archives a resting (DONE) ticket', async () => {
    const tool = archiveTaskTool(h.state);
    const result = await tool.handler({ taskId: 'task-1' }, h.state) as { success: boolean; status: string };
    expect(result.success).toBe(true);
    expect(result.status).toBe('ARCHIVED');
    expect(h.state.getTask('task-1')!.status).toBe('ARCHIVED');
  });

  it('archives a stale BACKLOG ticket', async () => {
    h.createTask({ id: 'task-bl', status: 'BACKLOG' });
    await h.state.load();
    const tool = archiveTaskTool(h.state);
    const result = await tool.handler({ taskId: 'task-bl' }, h.state) as { status: string };
    expect(result.status).toBe('ARCHIVED');
  });

  it('refuses to archive an in-flight (WORKING) ticket', async () => {
    h.createTask({ id: 'task-wk', status: 'WORKING' });
    await h.state.load();
    const tool = archiveTaskTool(h.state);
    await expect(tool.handler({ taskId: 'task-wk' }, h.state)).rejects.toThrow();
  });

  it('is idempotent on an already-archived ticket', async () => {
    await h.state.updateTask('task-1', { status: 'ARCHIVED' });
    const tool = archiveTaskTool(h.state);
    const result = await tool.handler({ taskId: 'task-1' }, h.state) as { success: boolean; alreadyArchived?: boolean };
    expect(result.success).toBe(true);
    expect(result.alreadyArchived).toBe(true);
  });

  it('throws for an unknown task', async () => {
    const tool = archiveTaskTool(h.state);
    await expect(tool.handler({ taskId: 'nope' }, h.state)).rejects.toThrow();
  });
});

