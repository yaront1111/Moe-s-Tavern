import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ToolTestHarness } from './toolTestHarness.js';
import { checkApprovalTool } from './checkApproval.js';

describe('moe.check_approval', () => {
  const h = new ToolTestHarness();
  beforeEach(() => h.init());
  afterEach(() => { vi.restoreAllMocks(); h.cleanup(); });

  beforeEach(async () => {
    h.setupMoeFolder();
    h.createEpic();
    await h.state.load();
  });

  it('returns approved=true for WORKING status', async () => {
    h.createTask({ id: 'task-w', status: 'WORKING' });
    await h.state.load();
    const tool = checkApprovalTool(h.state);
    const result = await tool.handler({ taskId: 'task-w' }, h.state) as { approved: boolean };
    expect(result.approved).toBe(true);
  });

  it('returns approved=false for AWAITING_APPROVAL', async () => {
    h.createTask({ id: 'task-a', status: 'AWAITING_APPROVAL' });
    await h.state.load();
    const tool = checkApprovalTool(h.state);
    const result = await tool.handler({ taskId: 'task-a' }, h.state) as { approved: boolean; status: string };
    expect(result.approved).toBe(false);
    expect(result.status).toBe('AWAITING_APPROVAL');
  });

  it('returns rejected info when plan was rejected', async () => {
    h.createTask({ id: 'task-r', status: 'PLANNING', reopenReason: 'Needs more detail' });
    await h.state.load();
    const tool = checkApprovalTool(h.state);
    const result = await tool.handler({ taskId: 'task-r' }, h.state) as { rejected: boolean; rejectionReason: string };
    expect(result.rejected).toBe(true);
    expect(result.rejectionReason).toBe('Needs more detail');
  });

  it('throws for non-existent task', async () => {
    const tool = checkApprovalTool(h.state);
    await expect(tool.handler({ taskId: 'nonexistent' }, h.state)).rejects.toThrow('Task not found');
  });

  it('refreshes worker lastActivityAt when checking approval', async () => {
    h.createTask({ id: 'task-heartbeat-approval', status: 'AWAITING_APPROVAL' });
    await h.state.load();
    await h.state.createWorker({
      id: 'worker-approval',
      type: 'CLAUDE',
      projectId: 'proj-test',
      epicId: 'epic-1',
      currentTaskId: 'task-heartbeat-approval',
      status: 'AWAITING_APPROVAL',
    });
    const before = h.state.getWorker('worker-approval')!.lastActivityAt;
    await new Promise((resolve) => setTimeout(resolve, 10));

    const tool = checkApprovalTool(h.state);
    await tool.handler({ taskId: 'task-heartbeat-approval', workerId: 'worker-approval' }, h.state);

    expect(new Date(h.state.getWorker('worker-approval')!.lastActivityAt).getTime())
      .toBeGreaterThan(new Date(before).getTime());
  });
});

