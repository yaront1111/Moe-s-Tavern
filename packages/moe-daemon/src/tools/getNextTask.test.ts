import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ToolTestHarness } from './toolTestHarness.js';
import { getNextTaskTool } from './getNextTask.js';

describe('moe.get_next_task', () => {
  const h = new ToolTestHarness();
  beforeEach(() => h.init());
  afterEach(() => { vi.restoreAllMocks(); h.cleanup(); });

  beforeEach(async () => {
    h.setupMoeFolder();
    h.createEpic();
    h.createTask({ id: 'task-1', status: 'BACKLOG', order: 2 });
    h.createTask({ id: 'task-2', status: 'BACKLOG', order: 1 });
    h.createTask({ id: 'task-3', status: 'WORKING' });
    await h.state.load();
  });

  it('returns next backlog task sorted by order', async () => {
    const tool = getNextTaskTool(h.state);
    const result = await tool.handler({}, h.state) as {
      hasNext: boolean;
      detail: string;
      task: { id: string; description?: string; definitionOfDone?: string[]; descriptionPreview?: string };
    };
    expect(result.hasNext).toBe(true);
    expect(result.task.id).toBe('task-2'); // order 1 comes first
    expect(result.detail).toBe('summary');
    expect(result.task.description).toBeUndefined();
    expect(result.task.definitionOfDone).toBeUndefined();
    expect(result.task.descriptionPreview).toBeDefined();
  });

  it('supports full next-task detail when explicitly requested', async () => {
    const tool = getNextTaskTool(h.state);
    const result = await tool.handler({ detail: 'full' }, h.state) as {
      hasNext: boolean;
      detail: string;
      task: { id: string; description: string; definitionOfDone: string[]; descriptionPreview?: string };
    };
    expect(result.hasNext).toBe(true);
    expect(result.detail).toBe('full');
    expect(result.task.id).toBe('task-2');
    expect(result.task.description).toBe('Task description');
    expect(result.task.definitionOfDone).toEqual(['Tests pass', 'Code reviewed']);
    expect(result.task.descriptionPreview).toBeUndefined();
  });

  it('filters by epicId', async () => {
    h.createEpic({ id: 'epic-2' });
    h.createTask({ id: 'task-e2', epicId: 'epic-2', status: 'BACKLOG' });
    await h.state.load();

    const tool = getNextTaskTool(h.state);
    const result = await tool.handler({ epicId: 'epic-2' }, h.state) as { task: { id: string } };
    expect(result.task.id).toBe('task-e2');
  });

  it('returns hasNext=false when no backlog tasks', async () => {
    await h.state.updateTask('task-1', { status: 'DONE' });
    await h.state.updateTask('task-2', { status: 'DONE' });
    const tool = getNextTaskTool(h.state);
    const result = await tool.handler({}, h.state) as { hasNext: boolean };
    expect(result.hasNext).toBe(false);
  });
});

