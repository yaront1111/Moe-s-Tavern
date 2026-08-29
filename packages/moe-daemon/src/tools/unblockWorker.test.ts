import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ToolTestHarness } from './toolTestHarness.js';
import { getActivityLogTool } from './getActivityLog.js';
import { unblockWorkerTool } from './unblockWorker.js';
import { AGENT_CLAIMABLE_STATUSES } from '../util/claimableStatuses.js';

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

describe('moe.unblock_worker on a BLOCKED task (seat-only default)', () => {
  const h = new ToolTestHarness();
  beforeEach(() => h.init());
  afterEach(() => { vi.restoreAllMocks(); h.cleanup(); });

  interface UnblockResult {
    success: boolean;
    status: string;
    currentTaskId: string | null;
    resolveBlocks: boolean;
    releasedTaskIds?: string[];
    unblockedTaskIds?: string[];
    stillBlockedTaskIds: string[];
    message: string;
  }

  const blockedAt = '2026-08-28T09:00:00.000Z';

  beforeEach(async () => {
    h.setupMoeFolder();
    h.createEpic();
    h.createTask({
      id: 'task-b',
      status: 'BLOCKED',
      assignedWorkerId: 'worker-1',
      blockedFromStatus: 'REVIEW',
      blockedReason: 'needs the schema decision',
      blockedResourceId: null,
      blockedAt,
    });
    h.createWorker({ id: 'worker-1', status: 'BLOCKED', currentTaskId: 'task-b', lastError: 'needs the schema decision' });
    await h.state.load();
  });

  async function unblock(args: Record<string, unknown> = {}): Promise<UnblockResult> {
    return await unblockWorkerTool(h.state).handler(
      { workerId: 'worker-1', resolution: 'seat freed', ...args }, h.state
    ) as UnblockResult;
  }

  async function events(type: string) {
    await h.state.flushActivityLog();
    const log = await getActivityLogTool(h.state).handler({ eventTypes: [type] }, h.state) as {
      events: Array<{ event: string; taskId?: string; workerId?: string }>;
    };
    return log.events.filter((e) => e.event === type);
  }

  it('default: frees the seat, releases the task unassigned, and keeps it BLOCKED with blockedReason intact', async () => {
    const result = await unblock();

    const task = h.state.getTask('task-b')!;
    expect(task.status).toBe('BLOCKED');
    expect(task.blockedReason).toBe('needs the schema decision');
    expect(task.blockedFromStatus).toBe('REVIEW');
    expect(task.blockedAt).toBe(blockedAt);
    expect(task.assignedWorkerId).toBeNull();
    // BLOCKED is outside AGENT_CLAIMABLE_STATUSES, so nobody re-hits the wall
    // until a human (set_task_status / resolveBlocks:true) clears the block.
    expect(AGENT_CLAIMABLE_STATUSES as readonly string[]).not.toContain(task.status);

    const worker = h.state.getWorker('worker-1')!;
    expect(worker.status).toBe('IDLE');
    expect(worker.currentTaskId).toBeNull();
    expect(worker.lastError).toBeNull();

    expect(result.success).toBe(true);
    expect(result.resolveBlocks).toBe(false);
    expect(result.releasedTaskIds).toEqual(['task-b']);
    expect(result.unblockedTaskIds).toBeUndefined();
    expect(result.stillBlockedTaskIds).toEqual(['task-b']);
    expect(result.message).toContain('task-b remains BLOCKED');
    expect(result.message).toContain('resolveBlocks:true');

    // Routed like every other release — WORKER_RELEASED, never TASK_UNBLOCKED.
    expect((await events('WORKER_RELEASED')).map((e) => e.taskId)).toEqual(['task-b']);
    expect(await events('TASK_UNBLOCKED')).toEqual([]);
  });

  it('retryTask:true without resolveBlocks leaves the BLOCKED task untouched and still assigned', async () => {
    const before = h.state.getTask('task-b')!.updatedAt;
    const result = await unblock({ retryTask: true });

    const task = h.state.getTask('task-b')!;
    expect(task.status).toBe('BLOCKED');
    expect(task.assignedWorkerId).toBe('worker-1');
    expect(task.blockedReason).toBe('needs the schema decision');
    expect(task.updatedAt).toBe(before);
    expect(h.state.getWorker('worker-1')!.currentTaskId).toBe('task-b');
    expect(h.state.getWorker('worker-1')!.status).toBe('IDLE');
    expect(result.releasedTaskIds).toBeUndefined();
    expect(result.stillBlockedTaskIds).toEqual(['task-b']);
  });

  it('resolveBlocks:true restores blockedFromStatus, clears the block bookkeeping and releases the task', async () => {
    const result = await unblock({ resolveBlocks: true, resolution: 'schema decided in #general' });

    const task = h.state.getTask('task-b')!;
    expect(task.status).toBe('REVIEW');
    expect(task.blockedReason).toBeNull();
    expect(task.blockedFromStatus).toBeNull();
    expect(task.blockedAt).toBeNull();
    expect(task.blockedResourceId).toBeNull();
    expect(task.assignedWorkerId).toBeNull();
    expect(AGENT_CLAIMABLE_STATUSES as readonly string[]).toContain(task.status);

    expect(result.resolveBlocks).toBe(true);
    expect(result.unblockedTaskIds).toEqual(['task-b']);
    expect(result.releasedTaskIds).toEqual(['task-b']);
    expect(result.stillBlockedTaskIds).toEqual([]);
    expect((await events('TASK_UNBLOCKED')).map((e) => e.taskId)).toEqual(['task-b']);
  });

  it('resolveBlocks:true + retryTask:true restores the task and keeps it assigned to the worker', async () => {
    const result = await unblock({ resolveBlocks: true, retryTask: true });

    const task = h.state.getTask('task-b')!;
    expect(task.status).toBe('REVIEW');
    expect(task.assignedWorkerId).toBe('worker-1');
    expect(task.blockedReason).toBeNull();
    expect(h.state.getWorker('worker-1')!.currentTaskId).toBe('task-b');
    expect(result.unblockedTaskIds).toEqual(['task-b']);
    expect(result.releasedTaskIds).toBeUndefined();
    expect(result.stillBlockedTaskIds).toEqual([]);
  });
});

