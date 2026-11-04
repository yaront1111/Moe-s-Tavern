import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToolTestHarness } from './toolTestHarness.js';
import { acquireResourceTool } from './acquireResource.js';
import { activeResourceWaiters, waitForResourceTool } from './waitForResource.js';
import type { TaskStatus } from '../types/schema.js';

// grantNextLeases and the lease reaper treat a lease on these rows as invalid;
// the direct acquire/wait grant must refuse them before writing anything.
const INELIGIBLE: Array<[string, TaskStatus]> = [
  ['task-backlog', 'BACKLOG'],
  ['task-awaiting', 'AWAITING_APPROVAL'],
  ['task-done', 'DONE'],
  ['task-archived', 'ARCHIVED'],
];

const refusal = (status: TaskStatus) => ({
  codeName: 'INVALID_STATE',
  message: expect.stringContaining(`is in ${status} state, expected PLANNING/WORKING/REVIEW/BLOCKED`),
});

describe('acquire_resource / wait_for_resource refuse a row no grant path serves', () => {
  const h = new ToolTestHarness();
  beforeEach(() => h.init());
  afterEach(() => {
    for (const [workerId, waiter] of activeResourceWaiters.entries()) {
      clearTimeout(waiter.timer);
      waiter.unsubscribe();
      waiter.resolve({ granted: false, cancelled: true });
      activeResourceWaiters.delete(workerId);
    }
    vi.restoreAllMocks();
    h.cleanup();
  });

  beforeEach(async () => {
    h.setupMoeFolder();
    h.createEpic();
    h.createTask({ id: 'task-live', status: 'WORKING', assignedWorkerId: 'worker-1' });
    for (const [id, status] of INELIGIBLE) h.createTask({ id, status });
    h.createTask({ id: 'task-planning', status: 'PLANNING' });
    h.createTask({ id: 'task-review', status: 'REVIEW' }); // unassigned, as complete_task leaves it
    h.createTask({ id: 'task-blocked', status: 'BLOCKED', blockedFromStatus: 'WORKING' });
    h.createWorker({ id: 'worker-1', status: 'CODING', currentTaskId: 'task-live' });
    h.createWorker({ id: 'worker-x', status: 'IDLE', currentTaskId: null });
    await h.state.load();
    vi.spyOn(h.state, 'postToGeneral').mockResolvedValue();
    vi.spyOn(h.state, 'postToRoleChannel').mockResolvedValue();
    vi.spyOn(h.state, 'postSystemMessage').mockResolvedValue();
  });

  const acquireLive = async () =>
    (await acquireResourceTool(h.state).handler(
      { resourceId: 'box', taskId: 'task-live', workerId: 'worker-1' }, h.state,
    )) as Record<string, unknown>;

  it.each(INELIGIBLE)('(i1) acquire_resource refuses %s (%s) and writes nothing', async (taskId, status) => {
    const touch = vi.spyOn(h.state, 'touchWorker');
    await expect(
      acquireResourceTool(h.state).handler({ resourceId: 'box', taskId, workerId: 'worker-x' }, h.state),
    ).rejects.toMatchObject(refusal(status));
    expect(h.state.getResource('box')).toBeNull();
    expect(touch).not.toHaveBeenCalled();
    expect((await acquireLive()).granted).toBe(true);
  });

  it('(i2) behind a busy holder, a refused row takes no queue entry', async () => {
    expect((await acquireLive()).granted).toBe(true);
    await expect(
      acquireResourceTool(h.state).handler({ resourceId: 'box', taskId: 'task-done', workerId: 'worker-x' }, h.state),
    ).rejects.toMatchObject(refusal('DONE'));
    const box = h.state.getResource('box')!;
    expect(box.holders.map((lease) => lease.taskId)).toEqual(['task-live']);
    expect(box.queue).toEqual([]);
  });

  it('(w1) wait_for_resource refuses a DONE row: no lease, queue entry, waiter or heartbeat', async () => {
    const touch = vi.spyOn(h.state, 'touchWorker');
    await expect(
      waitForResourceTool(h.state).handler(
        { resourceId: 'box', taskId: 'task-done', workerId: 'worker-x', timeoutMs: 1000 }, h.state,
      ),
    ).rejects.toMatchObject(refusal('DONE'));
    expect(h.state.getResource('box')).toBeNull();
    expect(activeResourceWaiters.has('worker-x')).toBe(false);
    expect(touch).not.toHaveBeenCalled();
    expect((await acquireLive()).granted).toBe(true);
  });

  it('(w2) wait_for_resource re-checks the row under the state lock', async () => {
    let unlock!: () => void;
    const gate = new Promise<void>((resolve) => { unlock = resolve; });
    // Hold the lock first, so the call passes its pre-check while the row is
    // still WORKING and then queues behind the status change.
    const holding = h.state.runExclusive(async () => {
      await gate;
      await h.state.updateTask('task-live', { status: 'BACKLOG' });
    });
    const outcome = waitForResourceTool(h.state).handler(
      { resourceId: 'box', taskId: 'task-live', workerId: 'worker-1', timeoutMs: 1000 }, h.state,
    ).catch((error: unknown) => error);
    unlock();
    await holding;
    expect(await outcome).toMatchObject(refusal('BACKLOG'));
    expect(h.state.getResource('box')).toBeNull();
    expect(activeResourceWaiters.has('worker-1')).toBe(false);
  });

  it.each([
    ['task-planning', 'worker-x'],
    ['task-live', 'worker-1'],
    ['task-review', 'worker-x'],
    ['task-blocked', 'worker-x'],
  ])('(e1) acquire_resource still leases to %s', async (taskId, workerId) => {
    const result = (await acquireResourceTool(h.state).handler(
      { resourceId: 'box', taskId, workerId }, h.state,
    )) as Record<string, unknown>;
    expect(result.granted).toBe(true);
    expect(h.state.getResource('box')!.holders.map((lease) => lease.taskId)).toEqual([taskId]);
  });
});
