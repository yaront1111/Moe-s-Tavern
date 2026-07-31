import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ToolTestHarness } from './toolTestHarness.js';
import { getActivityLogTool } from './getActivityLog.js';
import { unblockWorkerTool } from './unblockWorker.js';

describe('moe.unblock_worker', () => {
  const h = new ToolTestHarness();
  beforeEach(() => h.init());
  afterEach(() => { vi.restoreAllMocks(); h.cleanup(); });

  beforeEach(async () => {
    h.setupMoeFolder();
    h.createEpic();
    h.createTask({ id: 'task-1', assignedWorkerId: 'worker-1', status: 'WORKING' });
    h.createWorker({
      id: 'worker-1',
      status: 'BLOCKED',
      currentTaskId: 'task-1',
      lastError: 'Need clarification',
    });
    await h.state.load();
  });

  it('clears BLOCKED status to IDLE', async () => {
    const tool = unblockWorkerTool(h.state);
    const result = await tool.handler({
      workerId: 'worker-1',
      resolution: 'Clarification provided',
    }, h.state) as { success: boolean; status: string; currentTaskId: string | null };

    expect(result.success).toBe(true);
    expect(result.status).toBe('IDLE');
    expect(result.currentTaskId).toBeNull();

    const worker = h.state.getWorker('worker-1');
    expect(worker?.status).toBe('IDLE');
    expect(worker?.lastError).toBeNull();
    expect(worker?.currentTaskId).toBeNull();
  });

  it('keeps currentTaskId when retryTask is true', async () => {
    const tool = unblockWorkerTool(h.state);
    const result = await tool.handler({
      workerId: 'worker-1',
      resolution: 'Issue resolved, retrying',
      retryTask: true,
    }, h.state) as { success: boolean; status: string; currentTaskId: string | null; retryTask: boolean };

    expect(result.success).toBe(true);
    expect(result.status).toBe('IDLE');
    expect(result.currentTaskId).toBe('task-1');
    expect(result.retryTask).toBe(true);

    const worker = h.state.getWorker('worker-1');
    expect(worker?.currentTaskId).toBe('task-1');
  });

  it('fails if worker is not BLOCKED', async () => {
    // Create an IDLE worker
    h.createWorker({ id: 'worker-idle', status: 'IDLE' });
    await h.state.load();

    const tool = unblockWorkerTool(h.state);
    await expect(
      tool.handler({ workerId: 'worker-idle', resolution: 'test' }, h.state)
    ).rejects.toThrow('BLOCKED');
  });

  it('fails if worker does not exist', async () => {
    const tool = unblockWorkerTool(h.state);
    await expect(
      tool.handler({ workerId: 'nonexistent', resolution: 'test' }, h.state)
    ).rejects.toThrow('not found');
  });

  it('logs WORKER_UNBLOCKED to activity', async () => {
    const tool = unblockWorkerTool(h.state);
    await tool.handler({
      workerId: 'worker-1',
      resolution: 'Fixed the issue',
    }, h.state);
    await h.state.flushActivityLog();

    const logTool = getActivityLogTool(h.state);
    const result = await logTool.handler({
      eventTypes: ['WORKER_UNBLOCKED'],
    }, h.state) as { events: Array<{ event: string; workerId?: string }> };

    expect(result.events.length).toBeGreaterThanOrEqual(1);
    const unblockEvent = result.events.find(e => e.event === 'WORKER_UNBLOCKED');
    expect(unblockEvent).toBeDefined();
  });
});

