import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToolTestHarness } from './toolTestHarness.js';
import type { ToolDefinition } from './index.js';
import { claimNextTaskTool } from './claimNextTask.js';
import { deleteTaskTool } from './deleteTask.js';
import { activeWaiters, waitForTaskTool } from './waitForTask.js';

// task-b7203d89 (hunt #11): a legacy dependent counts a missing dependsOn id as
// satisfied, so delete_task can make it claimable. A parked wait_for_task must
// re-run its match on TASK_DELETED; it re-matched only on TASK_CREATED/UPDATED.
describe('wait_for_task wakes when a delete frees a dependent (task-b7203d89)', () => {
  const h = new ToolTestHarness();

  beforeEach(async () => {
    h.init();
    h.setupMoeFolder();
    h.createEpic();
    h.createTask({ id: 'task-prereq', status: 'PLANNING', order: 1 });
    h.createTask({ id: 'task-dep', status: 'WORKING', dependsOn: ['task-prereq'], order: 2 });
    h.createTask({ id: 'task-other', status: 'PLANNING', order: 3 });
    h.createTask({ id: 'task-gate-a', status: 'PLANNING', order: 4 });
    h.createTask({ id: 'task-gate-b', status: 'PLANNING', order: 5 });
    h.createTask({ id: 'task-dep2', status: 'WORKING', dependsOn: ['task-gate-a', 'task-gate-b'], order: 6 });
    await h.state.load();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const waiter of Array.from(activeWaiters.values())) waiter.unsubscribe();
    activeWaiters.clear();
    h.state.clearEmitter();
    h.cleanup();
  });

  const call = async (tool: ToolDefinition, args: Record<string, unknown>) =>
    (await tool.handler(args, h.state)) as Record<string, unknown>;
  const remove = (taskId: string) => call(deleteTaskTool(h.state), { taskId });
  const tick = () => new Promise((resolve) => setTimeout(resolve, 50));
  // Returns the pending wait inside an object: an async function returning the
  // bare promise would adopt it and block until the wait itself settles.
  const park = async () => {
    const parked = call(waitForTaskTool(h.state), { statuses: ['WORKING'], workerId: 'worker-1', timeoutMs: 3000 });
    await tick();
    expect(activeWaiters.has('worker-1')).toBe(true);
    return { parked };
  };
  const stillParked = async () => {
    await tick();
    expect(activeWaiters.has('worker-1')).toBe(true);
  };

  it('(w1) an unrelated delete re-runs the match but keeps the waiter parked', async () => {
    await park();
    await remove('task-other');
    await stillParked();
  });

  it('(w2) deleting the only unmet prerequisite wakes the waiter with the dependent, which the claim then hands out', async () => {
    const { parked } = await park();
    await remove('task-prereq');
    expect(await parked).toMatchObject({ hasNext: true, task: { id: 'task-dep' }, nextAction: { tool: 'moe.claim_next_task' } });
    const claimed = await call(claimNextTaskTool(h.state), { statuses: ['WORKING'], workerId: 'worker-1' });
    expect(claimed).toMatchObject({ hasNext: true, task: { id: 'task-dep' } });
  }, 15_000);

  it('(w3) deleting one of two unmet prerequisites keeps it parked; deleting the second wakes it', async () => {
    const { parked } = await park();
    await remove('task-gate-a');
    await stillParked();
    await remove('task-gate-b');
    expect(await parked).toMatchObject({ hasNext: true, task: { id: 'task-dep2' } });
  }, 15_000);
});
