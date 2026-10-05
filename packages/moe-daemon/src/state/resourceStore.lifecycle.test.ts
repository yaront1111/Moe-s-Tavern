import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { ToolTestHarness } from '../tools/toolTestHarness.js';
import type { ResourceState, TaskStatus, Worker } from '../types/schema.js';

describe('resourceStore lifecycle reconciliation', () => {
  const h = new ToolTestHarness();
  const holder = { resourceId: 'box', taskId: 'task-holder', workerId: 'worker-holder' };
  const waiter = { resourceId: 'box', taskId: 'task-waiter', workerId: 'worker-waiter' };

  beforeEach(() => {
    h.init();
    h.setupMoeFolder({ schemaVersion: 6 });
    h.createEpic();
    h.createTask({ id: holder.taskId, status: 'WORKING', assignedWorkerId: holder.workerId });
    h.createTask({
      id: waiter.taskId, status: 'BLOCKED', assignedWorkerId: waiter.workerId,
      blockedResourceId: 'box', blockedFromStatus: 'WORKING',
      blockedReason: 'Waiting for box', blockedAt: new Date().toISOString(),
    });
  });

  afterEach(() => {
    h.state.clearEmitter();
    vi.restoreAllMocks();
    h.cleanup();
  });

  async function loadState(): Promise<void> {
    await h.state.load();
    vi.spyOn(h.state, 'postToGeneral').mockResolvedValue();
    vi.spyOn(h.state, 'postToRoleChannel').mockResolvedValue();
    vi.spyOn(h.state, 'postSystemMessage').mockResolvedValue();
  }

  function readResource(): ResourceState {
    return JSON.parse(fs.readFileSync(path.join(h.moePath, 'resources', 'box.json'), 'utf8'));
  }

  const inactiveStatuses: Array<TaskStatus | 'deleted'> = ['DONE', 'ARCHIVED', 'BACKLOG', 'AWAITING_APPROVAL', 'deleted'];
  it.each(inactiveStatuses)('normal release skips a queued task that became %s', async (status) => {
    h.createTask({ id: 'task-stale', status: 'WORKING', priority: 'CRITICAL' });
    await loadState();
    await h.state.acquireResource(holder);
    await h.state.acquireResource({ resourceId: 'box', taskId: 'task-stale', workerId: 'worker-stale' });
    await h.state.acquireResource(waiter);
    if (status === 'deleted') await h.state.deleteTask('task-stale');
    else await h.state.updateTask('task-stale', { status });

    const result = await h.state.releaseResource(holder);
    expect(result.granted.map((lease) => lease.taskId)).toEqual([waiter.taskId]);
    expect(readResource().holders.map((lease) => lease.taskId)).toEqual([waiter.taskId]);
    expect(readResource().queue).toEqual([]);
    expect(h.state.getTask(waiter.taskId)!.status).toBe('WORKING');
  });

  it('persists queue cleanup when every waiter became inactive', async () => {
    await loadState();
    await h.state.acquireResource(holder);
    await h.state.acquireResource(waiter);
    await h.state.updateTask(waiter.taskId, { status: 'ARCHIVED' });

    const result = await h.state.releaseResource(holder);
    expect(result.granted).toEqual([]);
    expect(readResource().holders).toEqual([]);
    expect(readResource().queue).toEqual([]);
  });

  it('returns a resource task to the claim pool after its parked worker timed out', async () => {
    h.createWorker({
      id: waiter.workerId, status: 'BLOCKED', currentTaskId: waiter.taskId,
      lastActivityAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    });
    await loadState();
    await h.state.acquireResource(holder);
    await h.state.acquireResource(waiter);
    await h.state.checkBlockedTimeouts();
    expect(h.state.getTask(waiter.taskId)!.status).toBe('BLOCKED');
    expect(h.state.getWorker(waiter.workerId)!.status).toBe('IDLE');
    expect(h.state.getWorker(waiter.workerId)!.currentTaskId).toBeNull();

    await h.state.releaseResource(holder);
    const restored = h.state.getTask(waiter.taskId)!;
    expect(restored.status).toBe('WORKING');
    expect(restored.assignedWorkerId).toBeNull();
    expect(h.state.isTaskClaimable(restored)).toBe(true);
    expect(readResource().holders.map((lease) => lease.taskId)).toEqual([waiter.taskId]);
  });

  const absentOwners: Array<{ name: string; overrides?: Partial<Worker> }> = [
    { name: 'missing' },
    { name: 'dead', overrides: { status: 'DEAD', currentTaskId: waiter.taskId } },
    { name: 'idle with no task', overrides: { status: 'IDLE', currentTaskId: null } },
    { name: 'working elsewhere', overrides: { status: 'CODING', currentTaskId: holder.taskId } },
  ];
  it.each(absentOwners)('does not restore a resource task onto an owner who is $name', async ({ overrides }) => {
    if (overrides) h.createWorker({ id: waiter.workerId, ...overrides });
    await loadState();
    await h.state.acquireResource(holder);
    await h.state.acquireResource(waiter);

    await h.state.releaseResource(holder);
    const restored = h.state.getTask(waiter.taskId)!;
    expect(restored.assignedWorkerId).toBeNull();
    expect(h.state.isTaskClaimable(restored)).toBe(true);
    if (overrides) expect(h.state.getWorker(waiter.workerId)!.currentTaskId).toBe(overrides.currentTaskId);
  });

  it.each(['WORKING', 'PLANNING', 'REVIEW'] as const)('resumes the quiet parked worker with its %s task', async (restoredStatus) => {
    const lastActivityAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    h.createWorker({
      id: waiter.workerId, status: 'BLOCKED', currentTaskId: waiter.taskId,
      lastActivityAt, lastError: 'Waiting for box',
    });
    await loadState();
    await h.state.updateTask(waiter.taskId, { blockedFromStatus: restoredStatus });
    await h.state.acquireResource(holder);
    await h.state.acquireResource(waiter);

    await h.state.releaseResource(holder);
    const restored = h.state.getTask(waiter.taskId)!;
    expect(restored.status).toBe(restoredStatus);
    expect(restored.assignedWorkerId).toBe(waiter.workerId);
    expect(h.state.getWorker(waiter.workerId)).toMatchObject({
      status: 'READING_CONTEXT', lastError: null, lastActivityAt,
    });
    expect(h.state.getWorker(waiter.workerId)!.currentTaskId).toBe(waiter.taskId);
    expect(h.state.isTaskClaimable(restored)).toBe(false);
  });

  it('retries worker-state repair after the task unblock was already persisted', async () => {
    h.createWorker({ id: waiter.workerId, status: 'BLOCKED', currentTaskId: waiter.taskId });
    await loadState();
    await h.state.acquireResource(holder);
    await h.state.acquireResource(waiter);
    const updateWorker = vi.spyOn(h.state, 'updateWorker').mockRejectedValueOnce(new Error('worker write failed'));

    await h.state.releaseResource(holder);
    expect(h.state.getTask(waiter.taskId)!.status).toBe('WORKING');
    expect(h.state.getWorker(waiter.workerId)!.status).toBe('BLOCKED');
    await h.state.grantNextLeases('box');
    expect(h.state.getWorker(waiter.workerId)!.status).toBe('READING_CONTEXT');
    expect(updateWorker).toHaveBeenCalledTimes(2);
    expect(readResource().holders).toHaveLength(1);
  });

  it.each(['CODING', 'BLOCKED'] as const)('does not overwrite a holder with %s activity elsewhere', async (status) => {
    h.createWorker({ id: waiter.workerId, status, currentTaskId: waiter.taskId, lastError: 'other reason' });
    await loadState();
    await h.state.acquireResource(waiter);
    await h.state.updateTask(waiter.taskId, {
      status: status === 'BLOCKED' ? 'BLOCKED' : 'WORKING',
      assignedWorkerId: waiter.workerId,
      blockedResourceId: status === 'BLOCKED' ? 'other-box' : null,
    });
    const original = { ...h.state.getWorker(waiter.workerId)! };
    await h.state.grantNextLeases('box');
    expect(h.state.getWorker(waiter.workerId)).toEqual(original);
  });
});
