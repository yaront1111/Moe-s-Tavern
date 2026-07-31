import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ToolTestHarness } from './toolTestHarness.js';
import { qaApproveTool } from './qaApprove.js';

describe('moe.qa_approve', () => {
  const h = new ToolTestHarness();
  beforeEach(() => h.init());
  afterEach(() => { vi.restoreAllMocks(); h.cleanup(); });

  beforeEach(async () => {
    h.setupMoeFolder();
    h.createEpic();
    h.createTask({ id: 'task-1', status: 'REVIEW' });
    await h.state.load();
  });

  it('approves task in REVIEW and moves to DONE', async () => {
    const tool = qaApproveTool(h.state);
    const result = await tool.handler({
      taskId: 'task-1',
      summary: 'All DoD items verified',
    }, h.state) as { success: boolean; status: string };

    expect(result.success).toBe(true);
    expect(result.status).toBe('DONE');

    const task = h.state.getTask('task-1');
    expect(task?.status).toBe('DONE');
  });

  it('throws for missing taskId', async () => {
    const tool = qaApproveTool(h.state);
    await expect(tool.handler({}, h.state)).rejects.toThrow('Missing required field: taskId');
  });

  it('throws for missing or empty summary', async () => {
    const tool = qaApproveTool(h.state);
    await expect(tool.handler({ taskId: 'task-1' }, h.state)).rejects.toThrow('Missing required field: summary');
    await expect(tool.handler({ taskId: 'task-1', summary: '   ' }, h.state)).rejects.toThrow('Missing required field: summary');
    expect(h.state.getTask('task-1')?.status).toBe('REVIEW');
  });

  it('persists the approval summary as reviewSummary', async () => {
    const tool = qaApproveTool(h.state);
    await tool.handler({ taskId: 'task-1', summary: 'Re-ran npx vitest run: 12 passed. All 4 DoD items verified.' }, h.state);
    expect(h.state.getTask('task-1')?.reviewSummary).toBe('Re-ran npx vitest run: 12 passed. All 4 DoD items verified.');
  });

  it('throws for non-REVIEW status', async () => {
    await h.state.updateTask('task-1', { status: 'WORKING' });
    const tool = qaApproveTool(h.state);
    await expect(
      tool.handler({ taskId: 'task-1' }, h.state)
    ).rejects.toThrow('expected REVIEW');
  });

  it('throws for non-existent task', async () => {
    const tool = qaApproveTool(h.state);
    await expect(
      tool.handler({ taskId: 'nonexistent' }, h.state)
    ).rejects.toThrow('Task not found');
  });
});

