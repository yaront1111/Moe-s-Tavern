import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { ToolTestHarness } from '../tools/toolTestHarness.js';
import type { ResourceState, Task, Worker } from '../types/schema.js';

// A row parked in a resource queue can lose its seat before its turn: the seat
// is freed for other work, or it deregisters and its tasks come back
// unassigned. Granting such a row reserved the slot for a task nobody was
// running, until someone happened to claim it, while live seats queued behind
// it. The grant now passes the row over. Its entry keeps its age, and a row
// BLOCKED on the resource returns to its claim pool unleased.
describe('a queued row no live seat holds', () => {
  const h = new ToolTestHarness();
  const RID = 'box';

  beforeEach(() => {
    h.init();
    h.setupMoeFolder({ schemaVersion: 6 });
    h.createEpic();
    h.createTask({ id: 'task-holder', status: 'WORKING', assignedWorkerId: 'worker-holder', order: 1 });
    h.createWorker({ id: 'worker-holder', status: 'CODING', currentTaskId: 'task-holder' });
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

  /** A task parked BLOCKED on the resource; `seat` registers the worker holding it, null leaves it unassigned. */
  function parkedTask(id: string, order: number, seat: Partial<Worker> & { id: string } | null): void {
    h.createTask({
      id, status: 'BLOCKED', assignedWorkerId: seat?.id ?? null, order,
      blockedResourceId: RID, blockedFromStatus: 'WORKING',
      blockedReason: `Waiting for ${RID}`, blockedAt: new Date().toISOString(),
    });
    if (seat) h.createWorker({ status: 'BLOCKED', currentTaskId: id, ...seat });
  }

  async function queue(taskId: string, workerId: string): Promise<void> {
    await h.state.acquireResource({ resourceId: RID, taskId, workerId });
  }

  function readResource(): ResourceState {
    return JSON.parse(fs.readFileSync(path.join(h.moePath, 'resources', `${RID}.json`), 'utf8'));
  }

  function generalMessages(): string[] {
    return vi.mocked(h.state.postToGeneral).mock.calls.map(([content]) => content);
  }

  function expectClaimableUnleased(taskId: string): void {
    const task = h.state.getTask(taskId) as Task;
    expect(task).toMatchObject({
      status: 'WORKING', assignedWorkerId: null, blockedResourceId: null, blockedReason: null,
      blockedOnTaskIds: null, blockedFromStatus: null, blockedAt: null, priorBlockedReason: `Waiting for ${RID}`,
    });
    expect(h.state.isTaskClaimable(task)).toBe(true);
    expect(readResource().holders.map((lease) => lease.taskId)).not.toContain(taskId);
  }

  it('passes the freed slot to the next live waiter and returns the unheld row to its claim pool', async () => {
    parkedTask('task-unheld', 2, null);
    parkedTask('task-live', 3, { id: 'worker-live' });
    await loadState();
    await queue('task-holder', 'worker-holder');
    await queue('task-unheld', 'worker-gone');
    await queue('task-live', 'worker-live');
    const unheldEntry = readResource().queue.find((entry) => entry.taskId === 'task-unheld');

    const result = await h.state.releaseResource({ resourceId: RID, workerId: 'worker-holder' });

    expect(result.granted.map((lease) => lease.taskId)).toEqual(['task-live']);
    expect(readResource().holders.map((lease) => lease.taskId)).toEqual(['task-live']);
    // The live grantee resumes on its parked seat, exactly as before.
    expect(h.state.getTask('task-live')).toMatchObject({
      status: 'WORKING', assignedWorkerId: 'worker-live', blockedResourceId: null,
    });
    // The unheld row keeps its entry, and with it its age.
    expect(readResource().queue).toEqual([unheldEntry]);
    expectClaimableUnleased('task-unheld');
    expect(generalMessages()).toContainEqual(
      expect.stringContaining(`🟡 Resource ${RID}: task-unheld reached the front of the queue`));
  });

  it('grants the passed-over row at its old place in line once a live seat claims it', async () => {
    parkedTask('task-unheld', 2, null);
    parkedTask('task-live', 3, { id: 'worker-live' });
    parkedTask('task-later', 4, { id: 'worker-later' });
    h.createWorker({ id: 'worker-next' });
    await loadState();
    await queue('task-holder', 'worker-holder');
    await queue('task-unheld', 'worker-gone');
    await queue('task-live', 'worker-live');
    await h.state.releaseResource({ resourceId: RID, workerId: 'worker-holder' });

    // A seat claims the row and re-acquires; a later waiter queues behind it.
    await h.state.updateTask('task-unheld', { assignedWorkerId: 'worker-next' });
    await h.state.updateWorker('worker-next', { status: 'CODING', currentTaskId: 'task-unheld' });
    const again = await h.state.acquireResource({ resourceId: RID, taskId: 'task-unheld', workerId: 'worker-next' });
    expect(again).toMatchObject({ granted: false, position: 1 });
    await queue('task-later', 'worker-later');

    const result = await h.state.releaseResource({ resourceId: RID, workerId: 'worker-live' });

    expect(result.granted.map((lease) => [lease.taskId, lease.workerId])).toEqual([['task-unheld', 'worker-next']]);
    expect(readResource().queue.map((entry) => entry.taskId)).toEqual(['task-later']);
  });

  it('leaves the slot free when only unheld rows wait, and grants a live newcomer directly', async () => {
    parkedTask('task-unheld', 2, null);
    h.createTask({ id: 'task-new', status: 'WORKING', assignedWorkerId: 'worker-new', order: 5 });
    h.createWorker({ id: 'worker-new', status: 'CODING', currentTaskId: 'task-new' });
    await loadState();
    await queue('task-holder', 'worker-holder');
    await queue('task-unheld', 'worker-gone');

    const result = await h.state.releaseResource({ resourceId: RID, workerId: 'worker-holder' });

    expect(result.granted).toEqual([]);
    expect(readResource().holders).toEqual([]);
    expectClaimableUnleased('task-unheld');
    const direct = await h.state.acquireResource({ resourceId: RID, taskId: 'task-new', workerId: 'worker-new' });
    expect(direct.granted).toBe(true);
    expect(readResource().queue.map((entry) => entry.taskId)).toEqual(['task-unheld']);
  });

  it('treats a DEAD seat, or one bound to another task, as no holder', async () => {
    parkedTask('task-dead-seat', 2, { id: 'worker-dead', status: 'DEAD' });
    parkedTask('task-moved-seat', 3, { id: 'worker-moved', status: 'CODING', currentTaskId: 'task-holder' });
    parkedTask('task-live', 4, { id: 'worker-live' });
    await loadState();
    await queue('task-holder', 'worker-holder');
    await queue('task-dead-seat', 'worker-dead');
    await queue('task-moved-seat', 'worker-moved');
    await queue('task-live', 'worker-live');

    const result = await h.state.releaseResource({ resourceId: RID, workerId: 'worker-holder' });

    expect(result.granted.map((lease) => lease.taskId)).toEqual(['task-live']);
    expectClaimableUnleased('task-dead-seat');
    expectClaimableUnleased('task-moved-seat');
    expect(readResource().queue.map((entry) => entry.taskId)).toEqual(['task-dead-seat', 'task-moved-seat']);
  });

  it('keeps an unheld row BLOCKED when its restore cannot be persisted, and the next pass retries', async () => {
    parkedTask('task-unheld', 2, null);
    await loadState();
    await queue('task-holder', 'worker-holder');
    await queue('task-unheld', 'worker-gone');
    const writeEntity = h.state.writeEntity.bind(h.state);
    let failed = false;
    vi.spyOn(h.state, 'writeEntity').mockImplementation(async (kind, id, entity) => {
      if (kind === 'tasks' && id === 'task-unheld' && (entity as Task).status === 'WORKING' && !failed) {
        failed = true;
        throw new Error('Injected task write failure');
      }
      await writeEntity(kind, id, entity);
    });

    const result = await h.state.releaseResource({ resourceId: RID, workerId: 'worker-holder' });

    expect(result.granted).toEqual([]);
    expect(h.state.getTask('task-unheld')).toMatchObject({ status: 'BLOCKED', blockedResourceId: RID });
    expect(readResource().queue.map((entry) => entry.taskId)).toEqual(['task-unheld']);
    await h.state.reapResources();
    expectClaimableUnleased('task-unheld');
  });
});
