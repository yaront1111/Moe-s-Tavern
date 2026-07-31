import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ToolTestHarness } from './toolTestHarness.js';
import { listTasksTool } from './listTasks.js';

describe('moe.list_tasks', () => {
  const h = new ToolTestHarness();
  beforeEach(() => h.init());
  afterEach(() => { vi.restoreAllMocks(); h.cleanup(); });

  beforeEach(async () => {
    h.setupMoeFolder();
    h.createEpic({ id: 'epic-1' });
    h.createEpic({ id: 'epic-2', order: 2 });
    h.createTask({ id: 'task-1', epicId: 'epic-1', status: 'BACKLOG' });
    h.createTask({ id: 'task-2', epicId: 'epic-1', status: 'WORKING', order: 2 });
    h.createTask({ id: 'task-3', epicId: 'epic-2', status: 'DONE' });
    await h.state.load();
  });

  it('lists all tasks', async () => {
    const tool = listTasksTool(h.state);
    const result = await tool.handler({}, h.state) as { tasks: Array<{ id: string }> };
    expect(result.tasks.length).toBe(3);
  });

  it('filters by epicId', async () => {
    const tool = listTasksTool(h.state);
    const result = await tool.handler({ epicId: 'epic-1' }, h.state) as { tasks: Array<{ id: string }> };
    expect(result.tasks.length).toBe(2);
    expect(result.tasks.map(t => t.id)).toContain('task-1');
    expect(result.tasks.map(t => t.id)).toContain('task-2');
  });

  it('filters by status', async () => {
    const tool = listTasksTool(h.state);
    const result = await tool.handler({ status: ['BACKLOG'] }, h.state) as { tasks: Array<{ id: string }>; counts: { backlog: number } };
    expect(result.tasks.length).toBe(1);
    expect(result.tasks[0].id).toBe('task-1');
    expect(result.counts.backlog).toBe(1);
  });

  it('returns status counts', async () => {
    const tool = listTasksTool(h.state);
    const result = await tool.handler({}, h.state) as { counts: { backlog: number; inProgress: number; done: number } };
    expect(result.counts.backlog).toBe(1);
    expect(result.counts.inProgress).toBe(1);
    expect(result.counts.done).toBe(1);
  });

  it('paginates task summaries for large task lists', async () => {
    h.createTask({ id: 'task-4', epicId: 'epic-1', status: 'BACKLOG', order: 4, description: 'full description should not be listed' });
    await h.state.load();

    const tool = listTasksTool(h.state);
    const result = await tool.handler({ epicId: 'epic-1', limit: 2, offset: 1 }, h.state) as {
      tasks: Array<{ id: string; description?: string; definitionOfDone?: string[]; planStepCount: number }>;
      pagination: { limit: number; offset: number; returned: number; total: number; hasMore: boolean };
    };

    expect(result.tasks.map(task => task.id)).toEqual(['task-2', 'task-4']);
    expect(result.tasks[0].description).toBeUndefined();
    expect(result.tasks[0].definitionOfDone).toBeUndefined();
    expect(result.tasks[0].planStepCount).toBeGreaterThanOrEqual(0);
    expect(result.pagination).toEqual({
      limit: 2,
      offset: 1,
      returned: 2,
      total: 3,
      hasMore: false,
    });
  });
});

