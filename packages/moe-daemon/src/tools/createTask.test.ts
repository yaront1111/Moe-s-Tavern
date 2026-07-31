import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ToolTestHarness } from './toolTestHarness.js';
import { createTaskTool } from './createTask.js';
import type { Task } from '../types/schema.js';

describe('moe.create_task', () => {
  const h = new ToolTestHarness();
  beforeEach(() => h.init());
  afterEach(() => { vi.restoreAllMocks(); h.cleanup(); });

  beforeEach(async () => {
    h.setupMoeFolder();
    h.createEpic();
    await h.state.load();
  });

  it('creates a new task', async () => {
    const tool = createTaskTool(h.state);
    const result = await tool.handler({
      epicId: 'epic-1',
      title: 'New Task',
      description: 'Task desc',
    }, h.state) as { success: boolean; task: Task };

    expect(result.success).toBe(true);
    expect(result.task.title).toBe('New Task');
    expect(result.task.createdBy).toBe('WORKER');
  });

  it('throws for missing epicId', async () => {
    const tool = createTaskTool(h.state);
    await expect(tool.handler({ title: 'Test' }, h.state)).rejects.toThrow('Missing required field: epicId');
  });

  it('throws for missing title', async () => {
    const tool = createTaskTool(h.state);
    await expect(tool.handler({ epicId: 'epic-1' }, h.state)).rejects.toThrow('Missing required field: title');
  });
});

