import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { ToolTestHarness } from '../tools/toolTestHarness.js';
import { acquireResourceTool } from '../tools/acquireResource.js';
import { deregisterWorkerTool } from '../tools/deregisterWorker.js';
import { releaseTaskTool } from '../tools/releaseTask.js';
import type { ResourceLease, ResourceState, Task } from '../types/schema.js';

// A seat that deregisters gives its tasks back, but its task-keyed leases used
// to stay: the slot sat reserved for a row nobody held until maxLeaseMs while
// live seats queued behind it, and a dead seat's queue entry was later granted
// to an unassigned row. A resource declared releaseOnDeregister now lets those
// claims go with the seat; every other resource keeps task-keyed survival.
describe('resource claims of a deregistered seat', () => {
  const h = new ToolTestHarness();
  const holder = { resourceId: 'slot', taskId: 'task-holder', workerId: 'worker-holder' };
  const waiter = { resourceId: 'slot', taskId: 'task-waiter', workerId: 'worker-waiter' };

  beforeEach(() => {
    h.init();
    h.setupMoeFolder({ schemaVersion: 6 });
    h.createEpic();
    h.createTask({ id: holder.taskId, status: 'WORKING', assignedWorkerId: holder.workerId });
    h.createTask({
      id: waiter.taskId, status: 'BLOCKED', assignedWorkerId: waiter.workerId, order: 2,
      blockedResourceId: 'slot', blockedFromStatus: 'WORKING',
      blockedReason: 'Waiting for slot', blockedAt: new Date().toISOString(),
    });
    h.createWorker({ id: holder.workerId, status: 'CODING', currentTaskId: holder.taskId });
    h.createWorker({ id: waiter.workerId, status: 'BLOCKED', currentTaskId: waiter.taskId });
  });

  afterEach(() => {
    h.state.clearEmitter();
    vi.restoreAllMocks();
    h.cleanup();
  });

  /** `slot` opts in; `box` keeps the task-keyed default. Declared through the validated settings path. */
  async function loadState(): Promise<void> {
    await h.state.load();
    await h.state.updateSettings({ resources: { slot: { releaseOnDeregister: true }, box: { capacity: 1 } } });
    vi.spyOn(h.state, 'postToGeneral').mockResolvedValue();
    vi.spyOn(h.state, 'postToRoleChannel').mockResolvedValue();
    vi.spyOn(h.state, 'postSystemMessage').mockResolvedValue();
  }

  function rawResource(id: string): string {
    return fs.readFileSync(path.join(h.moePath, 'resources', `${id}.json`), 'utf8');
  }

  function readResource(id: string): ResourceState {
    return JSON.parse(rawResource(id));
  }

  async function deregister(workerId: string): Promise<void> {
    await deregisterWorkerTool(h.state).handler({ workerId, reason: 'terminal_closed' }, h.state);
  }

  function governorBanners(): string[] {
    return vi.mocked(h.state.postToRoleChannel).mock.calls
      .filter(([role]) => role === 'governors')
      .map(([, content]) => content);
  }

  it('drops a deregistered holder\'s lease and grants the slot to the next waiter', async () => {
    await loadState();
    await h.state.acquireResource(holder);
    await h.state.acquireResource(waiter);
    const activity = vi.spyOn(h.state, 'appendActivity');

    await deregister(holder.workerId);

    expect(readResource('slot').holders.map((lease) => lease.taskId)).toEqual([waiter.taskId]);
    expect(readResource('slot').queue).toEqual([]);
    // The grantee resumes exactly as on a normal release: its parked seat keeps the row.
    expect(h.state.getTask(waiter.taskId)).toMatchObject({
      status: 'WORKING', assignedWorkerId: waiter.workerId, blockedResourceId: null,
    });
    expect(h.state.getWorker(waiter.workerId)!.status).toBe('READING_CONTEXT');
    expect(h.state.getTask(holder.taskId)).toMatchObject({ status: 'WORKING', assignedWorkerId: null });
    expect(activity).toHaveBeenCalledWith('RESOURCE_RELEASED', {
      resourceId: 'slot', taskId: holder.taskId, workerId: holder.workerId, forced: true, reason: 'holder deregistered',
    });
    expect(governorBanners()).toEqual([
      '🔌 worker-holder deregistered (terminal_closed); released 1 task: task-holder→WORKING; '
        + 'dropped 1 resource claim: slot lease (task-holder)',
    ]);
  });

  it('drops a deregistered waiter\'s queue entry and returns its BLOCKED task to the claim pool', async () => {
    await loadState();
    const held = (await h.state.acquireResource(holder)).lease!;
    await h.state.acquireResource(waiter);

    await deregister(waiter.workerId);

    // The live holder's lease is untouched; only the dead seat's entry went.
    expect(readResource('slot').holders).toEqual([held]);
    expect(readResource('slot').queue).toEqual([]);
    const restored = h.state.getTask(waiter.taskId)!;
    expect(restored).toMatchObject({
      status: 'WORKING', assignedWorkerId: null, blockedResourceId: null, blockedReason: null,
      blockedOnTaskIds: null, blockedFromStatus: null, blockedAt: null, priorBlockedReason: 'Waiting for slot',
    });
    expect(h.state.isTaskClaimable(restored)).toBe(true);
    expect(h.state.getWorker(waiter.workerId)!.status).toBe('DEAD');
    expect(governorBanners()).toEqual([
      '🔌 worker-waiter deregistered (terminal_closed); released 1 task: task-waiter→WORKING; '
        + 'dropped 1 resource claim: slot queue (task-waiter)',
    ]);

    // Nothing is left to grant the unassigned row: the freed slot stays free.
    expect((await h.state.releaseResource(holder)).granted).toEqual([]);
    expect(readResource('slot').holders).toEqual([]);
  });

  it('leaves an unflagged resource and its BLOCKED waiter exactly as before', async () => {
    await loadState();
    await h.state.updateTask(waiter.taskId, { blockedResourceId: 'box', blockedReason: 'Waiting for box' });
    await h.state.acquireResource({ ...holder, resourceId: 'box' });
    await h.state.acquireResource({ ...waiter, resourceId: 'box' });
    const before = rawResource('box');

    await deregister(holder.workerId);
    await deregister(waiter.workerId);

    expect(rawResource('box')).toBe(before);
    expect(h.state.getTask(holder.taskId)).toMatchObject({ status: 'WORKING', assignedWorkerId: null });
    expect(h.state.getTask(waiter.taskId)).toMatchObject({
      status: 'BLOCKED', assignedWorkerId: null, blockedResourceId: 'box', blockedFromStatus: 'WORKING',
      blockedReason: 'Waiting for box',
    });
    expect(governorBanners()).toEqual([
      '🔌 worker-holder deregistered (terminal_closed); released 1 task: task-holder→WORKING',
      '🔌 worker-waiter deregistered (terminal_closed); released 1 task: task-waiter→BLOCKED',
    ]);
  });

  it('drops only the flagged lease of a task that holds both kinds', async () => {
    await loadState();
    await h.state.acquireResource({ ...holder, resourceId: 'box' });
    const box = rawResource('box');
    await h.state.acquireResource(holder);

    await deregister(holder.workerId);

    expect(readResource('slot').holders).toEqual([]);
    expect(rawResource('box')).toBe(box);
  });

  it('lets the next claimant resume an unflagged lease that survived deregistration', async () => {
    h.createWorker({ id: 'worker-next' });
    await loadState();
    const original = (await h.state.acquireResource({ ...holder, resourceId: 'box' })).lease!;

    await deregister(holder.workerId);
    await h.state.updateTask(holder.taskId, { assignedWorkerId: 'worker-next' });
    const resumed = await acquireResourceTool(h.state).handler(
      { resourceId: 'box', taskId: holder.taskId, workerId: 'worker-next' }, h.state
    ) as { granted: boolean; lease: ResourceLease };

    // A renewal of the same task-keyed lease — never a new lease or a queue place.
    expect(resumed.granted).toBe(true);
    expect(resumed.lease.acquiredAt).toBe(original.acquiredAt);
    expect(readResource('box').holders.map((lease) => [lease.taskId, lease.workerId]))
      .toEqual([[holder.taskId, 'worker-next']]);
    expect(readResource('box').queue).toEqual([]);
  });

  it('keeps a flagged lease across a CLI respawn, a release_task hand-off and the restart purge', async () => {
    await loadState();
    const original = (await h.state.acquireResource(holder)).lease!;

    // A respawned CLI in the same live seat re-acquires: a renewal.
    const renewed = await acquireResourceTool(h.state).handler(holder, h.state) as { granted: boolean; lease: ResourceLease };
    expect(renewed.granted).toBe(true);
    expect(renewed.lease.acquiredAt).toBe(original.acquiredAt);

    // A live seat's hand-off passes the lease on with the row.
    await releaseTaskTool(h.state).handler({ taskId: holder.taskId, workerId: holder.workerId, reason: 'handoff' }, h.state);
    expect(h.state.getTask(holder.taskId)!.assignedWorkerId).toBeNull();
    expect(readResource('slot').holders.map((lease) => lease.taskId)).toEqual([holder.taskId]);

    // The restart purge is not a deregistration either.
    await h.state.updateTask(holder.taskId, { assignedWorkerId: holder.workerId });
    await h.state.updateWorker(holder.workerId, { lastActivityAt: '2026-01-01T00:00:00.000Z' });
    await h.state.purgeAllWorkers();
    expect(h.state.getWorker(holder.workerId)).toBeNull();
    expect(h.state.getTask(holder.taskId)!.assignedWorkerId).toBeNull();
    expect(readResource('slot').holders.map((lease) => lease.taskId)).toEqual([holder.taskId]);
  });

  it('keeps a task\'s claims and its BLOCKED hold when the restore cannot be persisted', async () => {
    await loadState();
    await h.state.acquireResource(holder);
    await h.state.acquireResource(waiter);
    const before = rawResource('slot');
    const writeEntity = h.state.writeEntity.bind(h.state);
    let failed = false;
    vi.spyOn(h.state, 'writeEntity').mockImplementation(async (kind, id, entity) => {
      if (kind === 'tasks' && id === waiter.taskId && (entity as Task).status === 'WORKING' && !failed) {
        failed = true;
        throw new Error('Injected task write failure');
      }
      await writeEntity(kind, id, entity);
    });

    await deregister(waiter.workerId);

    // Deregistration completes, and the row is not stranded BLOCKED with nothing
    // left to grant it: its queue entry stays, as before this opt-in existed.
    expect(h.state.getWorker(waiter.workerId)!.status).toBe('DEAD');
    expect(rawResource('slot')).toBe(before);
    expect(h.state.getTask(waiter.taskId)).toMatchObject({
      status: 'BLOCKED', assignedWorkerId: null, blockedResourceId: 'slot',
    });
    await h.state.releaseResource(holder);
    expect(h.state.getTask(waiter.taskId)).toMatchObject({ status: 'WORKING', assignedWorkerId: null });
  });

  it('keeps the claims when the drop cannot be persisted', async () => {
    await loadState();
    await h.state.acquireResource(holder);
    await h.state.acquireResource(waiter);
    const before = rawResource('slot');
    const writeEntity = h.state.writeEntity.bind(h.state);
    vi.spyOn(h.state, 'writeEntity').mockImplementation(async (kind, id, entity) => {
      if (kind === 'resources') throw new Error('Injected resource write failure');
      await writeEntity(kind, id, entity);
    });

    await deregister(waiter.workerId);

    // Deregistration completes; the restored row is claimable and the resource
    // is untouched, still bounded by the lease reaper.
    expect(h.state.getWorker(waiter.workerId)!.status).toBe('DEAD');
    expect(rawResource('slot')).toBe(before);
    expect(h.state.isTaskClaimable(h.state.getTask(waiter.taskId)!)).toBe(true);
  });
});
