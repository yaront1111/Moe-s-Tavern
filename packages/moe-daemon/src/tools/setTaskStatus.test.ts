import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ToolTestHarness } from './toolTestHarness.js';
import { setTaskStatusTool } from './setTaskStatus.js';

describe('moe.set_task_status', () => {
  const h = new ToolTestHarness();
  beforeEach(() => h.init());
  afterEach(() => { vi.restoreAllMocks(); h.cleanup(); });

  beforeEach(async () => {
    h.setupMoeFolder();
    h.createEpic();
    h.createTask({ status: 'BACKLOG' });
    await h.state.load();
  });

  it('changes task status', async () => {
    const tool = setTaskStatusTool(h.state);
    const result = await tool.handler({
      taskId: 'task-1',
      status: 'PLANNING',
    }, h.state) as { success: boolean; status: string };

    expect(result.success).toBe(true);
    expect(result.status).toBe('PLANNING');
  });

  it('validates status transitions', async () => {
    const tool = setTaskStatusTool(h.state);
    // BACKLOG -> DONE is not valid
    await expect(
      tool.handler({ taskId: 'task-1', status: 'DONE' }, h.state)
    ).rejects.toThrow('status transition not allowed');
  });

  it('rejects invalid status values', async () => {
    const tool = setTaskStatusTool(h.state);
    await expect(
      tool.handler({ taskId: 'task-1', status: 'INVALID' }, h.state)
    ).rejects.toThrow('Invalid status');
  });

  it('increments reopenCount when reopening with reason', async () => {
    await h.state.updateTask('task-1', { status: 'REVIEW' });
    const tool = setTaskStatusTool(h.state);
    await tool.handler({
      taskId: 'task-1',
      status: 'WORKING',
      reason: 'Fix needed',
    }, h.state);

    const task = h.state.getTask('task-1');
    expect(task?.reopenCount).toBe(1);
    expect(task?.reopenReason).toBe('Fix needed');
  });
});

