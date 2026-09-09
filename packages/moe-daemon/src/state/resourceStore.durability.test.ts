import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { ToolTestHarness } from '../tools/toolTestHarness.js';
import { DEFAULT_MAX_LEASE_MS } from './resourceStore.js';
import { StateManager } from './StateManager.js';
import type { ResourceState } from '../types/schema.js';

describe('resourceStore persistence failures', () => {
  const h = new ToolTestHarness();

  beforeEach(async () => {
    h.init();
    h.setupMoeFolder({ schemaVersion: 6 });
    h.createEpic();
    h.createTask({ id: 'task-holder', status: 'WORKING', assignedWorkerId: 'worker-holder' });
    h.createTask({
      id: 'task-waiter', status: 'BLOCKED', assignedWorkerId: null,
      blockedResourceId: 'box', blockedFromStatus: 'WORKING',
      blockedReason: 'Waiting for box', blockedAt: new Date().toISOString(),
    });
    await h.state.load();
    vi.spyOn(h.state, 'postToGeneral').mockResolvedValue();
    vi.spyOn(h.state, 'postToRoleChannel').mockResolvedValue();
    vi.spyOn(h.state, 'postSystemMessage').mockResolvedValue();
  });

  afterEach(() => {
    h.state.clearEmitter();
    vi.restoreAllMocks();
    h.cleanup();
  });

  const holder = { resourceId: 'box', taskId: 'task-holder', workerId: 'worker-holder' };
  const waiter = { resourceId: 'box', taskId: 'task-waiter', workerId: 'worker-waiter' };

  function readResource(): ResourceState {
    return JSON.parse(fs.readFileSync(path.join(h.moePath, 'resources', 'box.json'), 'utf8'));
  }

  function failNextResourceWrite(): void {
    const writeEntity = h.state.writeEntity.bind(h.state);
    let failed = false;
    vi.spyOn(h.state, 'writeEntity').mockImplementation(async (kind, id, entity) => {
      if (kind === 'resources' && !failed) {
        failed = true;
        throw new Error('Injected resource write failure');
      }
      await writeEntity(kind, id, entity);
    });
  }

  it('does not expose a new resource when its initial lease write fails', async () => {
    failNextResourceWrite();
    await expect(h.state.acquireResource(holder)).rejects.toThrow('Injected resource write failure');
    expect(h.state.getResource('box')).toBeNull();
    expect(fs.existsSync(path.join(h.moePath, 'resources', 'box.json'))).toBe(false);
  });

  it('preserves the persisted lease when renewal fails', async () => {
    await h.state.acquireResource(holder);
    const before = readResource();
    failNextResourceWrite();
    await expect(h.state.acquireResource({ ...holder, note: 'renewed', workerId: 'worker-successor' }))
      .rejects.toThrow('Injected resource write failure');
    expect(h.state.getResource('box')).toEqual(before);
    expect(readResource()).toEqual(before);
  });

  it('does not announce or retain a queue entry that failed to persist', async () => {
    await h.state.acquireResource(holder);
    const activity = vi.spyOn(h.state, 'appendActivity');
    failNextResourceWrite();
    await expect(h.state.acquireResource(waiter)).rejects.toThrow('Injected resource write failure');
    expect(h.state.getResource('box')!.queue).toEqual([]);
    expect(readResource().queue).toEqual([]);
    expect(activity.mock.calls.filter(([event]) => event === 'RESOURCE_QUEUED')).toEqual([]);
  });

  it('keeps a lease held when release fails to persist', async () => {
    await h.state.acquireResource(holder);
    await h.state.acquireResource(waiter);
    const before = readResource();
    failNextResourceWrite();
    await expect(h.state.releaseResource(holder)).rejects.toThrow('Injected resource write failure');
    expect(h.state.getResource('box')).toEqual(before);
    expect(readResource()).toEqual(before);
    expect(h.state.getTask(waiter.taskId)!.status).toBe('BLOCKED');
  });

  it('keeps an expired lease in memory when the reaper write fails', async () => {
    await h.state.acquireResource(holder);
    const before = readResource();
    failNextResourceWrite();
    await expect(h.state.reapResources(Date.now() + DEFAULT_MAX_LEASE_MS + 1000))
      .rejects.toThrow('Injected resource write failure');
    expect(h.state.getResource('box')).toEqual(before);
    expect(readResource()).toEqual(before);
  });

  async function prepareFreeCapacity(): Promise<void> {
    await h.state.acquireResource(holder);
    await h.state.acquireResource(waiter);
    // Reproduce the durable state between a successful release and its grant.
    const resource = { ...readResource(), holders: [] };
    await h.state.writeEntity('resources', resource.id, resource);
    h.state.resources.set(resource.id, resource);
  }

  it('does not unblock or announce a waiter until its grant is durable', async () => {
    await prepareFreeCapacity();
    const activity = vi.spyOn(h.state, 'appendActivity');
    failNextResourceWrite();
    await expect(h.state.grantNextLeases('box')).rejects.toThrow('Injected resource write failure');
    expect(h.state.getTask(waiter.taskId)!.status).toBe('BLOCKED');
    expect(h.state.getResource('box')!.holders).toEqual([]);
    expect(readResource().holders).toEqual([]);
    expect(activity.mock.calls.filter(([event]) => event === 'RESOURCE_GRANTED')).toEqual([]);
    expect(h.state.postToGeneral).not.toHaveBeenCalled();
  });

  it('persists a grant before publishing its task unblock event', async () => {
    await prepareFreeCapacity();
    const durableOwnersAtUnblock: string[][] = [];
    h.state.setEmitter((event) => {
      if (event.type === 'TASK_UPDATED' && event.payload.id === waiter.taskId && event.payload.status === 'WORKING') {
        durableOwnersAtUnblock.push(readResource().holders.map((lease) => lease.taskId));
      }
    });
    await h.state.grantNextLeases('box');
    expect(durableOwnersAtUnblock).toEqual([[waiter.taskId]]);
  });

  async function restartDaemon(): Promise<void> {
    h.state.clearEmitter();
    h.state = new StateManager({ projectPath: h.testDir });
    await h.state.load();
    vi.spyOn(h.state, 'postToGeneral').mockResolvedValue();
    vi.spyOn(h.state, 'postToRoleChannel').mockResolvedValue();
    vi.spyOn(h.state, 'postSystemMessage').mockResolvedValue();
  }

  it.each([false, true])('retries a failed grant when nothing expired (restart=%s)', async (restart) => {
    await prepareFreeCapacity();
    failNextResourceWrite();
    await expect(h.state.grantNextLeases('box')).rejects.toThrow('Injected resource write failure');
    if (restart) await restartDaemon();
    expect(await h.state.reapResources()).toBe(0);
    expect(readResource().holders.map((lease) => lease.taskId)).toEqual([waiter.taskId]);
    expect(h.state.getTask(waiter.taskId)!.status).toBe('WORKING');
  });

  it.each([false, true])('retries an unblock after its task write failed (restart=%s)', async (restart) => {
    await prepareFreeCapacity();
    const writeEntity = h.state.writeEntity.bind(h.state);
    let failed = false;
    vi.spyOn(h.state, 'writeEntity').mockImplementation(async (kind, id, entity) => {
      if (kind === 'tasks' && id === waiter.taskId && !failed) {
        failed = true;
        throw new Error('Injected task write failure');
      }
      await writeEntity(kind, id, entity);
    });
    await h.state.grantNextLeases('box');
    expect(readResource().holders.map((lease) => lease.taskId)).toEqual([waiter.taskId]);
    expect(h.state.getTask(waiter.taskId)!.status).toBe('BLOCKED');
    if (restart) await restartDaemon();
    expect(await h.state.reapResources()).toBe(0);
    expect(h.state.getTask(waiter.taskId)!.status).toBe('WORKING');
    expect(h.state.getTask(waiter.taskId)!.blockedResourceId).toBeNull();
  });

  it.each(['1970-01-01T00:00:00.000Z', 'invalid'])('does not resume a holder without a valid unexpired lease (%s)', async (expiresAt) => {
    await h.state.acquireResource(waiter);
    const resource = readResource();
    resource.holders[0].expiresAt = expiresAt;
    await h.state.writeEntity('resources', resource.id, resource);
    await restartDaemon();

    await h.state.grantNextLeases('box');
    expect(h.state.getTask(waiter.taskId)!.status).toBe('BLOCKED');
    expect(h.state.postToGeneral).not.toHaveBeenCalled();
  });
});
