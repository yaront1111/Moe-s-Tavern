import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ToolTestHarness } from './toolTestHarness.js';
import { deleteTaskTool } from './deleteTask.js';
import type { Task } from '../types/schema.js';

describe('moe.delete_task', () => {
  const h = new ToolTestHarness();
  beforeEach(() => h.init());
  afterEach(() => { vi.restoreAllMocks(); h.cleanup(); });

  beforeEach(async () => {
    h.setupMoeFolder();
    h.createEpic();
    h.createTask({ id: 'task-1', status: 'BACKLOG' });
    await h.state.load();
  });

  it('deletes a task and returns it', async () => {
    const tool = deleteTaskTool(h.state);
    const result = await tool.handler({ taskId: 'task-1' }, h.state) as { success: boolean; task: Task };

    expect(result.success).toBe(true);
    expect(result.task.id).toBe('task-1');
    expect(h.state.getTask('task-1')).toBeNull();
  });

  it('throws for missing taskId', async () => {
    const tool = deleteTaskTool(h.state);
    await expect(tool.handler({}, h.state)).rejects.toThrow('Missing required field: taskId');
  });

  it('throws for non-existent task', async () => {
    const tool = deleteTaskTool(h.state);
    await expect(tool.handler({ taskId: 'nonexistent' }, h.state)).rejects.toThrow('Task not found: nonexistent');
  });
});

