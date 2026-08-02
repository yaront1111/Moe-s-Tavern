import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToolTestHarness } from './toolTestHarness.js';
import { waitForResourceTool, activeResourceWaiters, cleanupStaleResourceWaiters } from './waitForResource.js';

/** The handler persists the queue entry (async disk IO) before it registers
 * its waiter, so a single macrotask tick is not enough on a slow box — poll. */
async function waitFor(cond: () => boolean, ms = 5000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('waitFor: condition not met in time');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('moe.wait_for_resource', () => {
  const h = new ToolTestHarness();
  beforeEach(() => h.init());
  afterEach(() => {
    // Resolve any parked waiter so vitest never hangs on a leaked promise.
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
    h.createTask({ id: 'task-1', status: 'WORKING', assignedWorkerId: 'worker-1' });
    h.createTask({ id: 'task-2', status: 'WORKING', assignedWorkerId: 'worker-2' });
    h.createWorker({ id: 'worker-1' });
    h.createWorker({ id: 'worker-2' });
    await h.state.load();
    vi.spyOn(h.state, 'postToGeneral').mockResolvedValue();
    vi.spyOn(h.state, 'postToRoleChannel').mockResolvedValue();
    vi.spyOn(h.state, 'postSystemMessage').mockResolvedValue();
  });

  it('is registered as a blocking tool', () => {
    expect(waitForResourceTool(h.state).blocking).toBe(true);
  });

  it('returns immediately when the resource is free (and takes the lease)', async () => {
    const tool = waitForResourceTool(h.state);
    const result = await tool.handler(
      { resourceId: 'box', taskId: 'task-1', workerId: 'worker-1' }, h.state
    ) as Record<string, unknown>;
    expect(result.granted).toBe(true);
    expect(h.state.getResource('box')!.holders.map((holder) => holder.taskId)).toEqual(['task-1']);
    expect(activeResourceWaiters.size).toBe(0);
  });

  it('parks while busy and wakes when the holder releases', async () => {
    await h.state.acquireResource({ resourceId: 'box', taskId: 'task-1', workerId: 'worker-1' });

    const tool = waitForResourceTool(h.state);
    const pending = tool.handler(
      { resourceId: 'box', taskId: 'task-2', workerId: 'worker-2', timeoutMs: 5000 }, h.state
    ) as Promise<Record<string, unknown>>;

    await waitFor(() => activeResourceWaiters.has('worker-2'));

    await h.state.releaseResource({ resourceId: 'box', workerId: 'worker-1' });
    const result = await pending;
    expect(result.granted).toBe(true);
    expect((result.lease as { taskId: string }).taskId).toBe('task-2');
    expect(activeResourceWaiters.size).toBe(0);
  });

  it('times out with queue position and a re-enter nextAction', async () => {
    await h.state.acquireResource({ resourceId: 'box', taskId: 'task-1', workerId: 'worker-1' });
    const tool = waitForResourceTool(h.state);
    const result = await tool.handler(
      { resourceId: 'box', taskId: 'task-2', workerId: 'worker-2', timeoutMs: 1000 }, h.state
    ) as Record<string, unknown>;
    expect(result.granted).toBe(false);
    expect(result.timedOut).toBe(true);
    expect(result.position).toBe(1);
    expect((result.nextAction as { tool: string }).tool).toBe('moe.wait_for_resource');
    // Still queued — the timeout ends the RPC, not the wait for the lease.
    expect(h.state.getResource('box')!.queue.map((q) => q.taskId)).toEqual(['task-2']);
  });

  it('re-entry cancels and replaces the prior waiter for the same worker', async () => {
    await h.state.acquireResource({ resourceId: 'box', taskId: 'task-1', workerId: 'worker-1' });
    const tool = waitForResourceTool(h.state);
    const first = tool.handler(
      { resourceId: 'box', taskId: 'task-2', workerId: 'worker-2', timeoutMs: 5000 }, h.state
    ) as Promise<Record<string, unknown>>;
    await waitFor(() => activeResourceWaiters.has('worker-2'));
    const second = tool.handler(
      { resourceId: 'box', taskId: 'task-2', workerId: 'worker-2', timeoutMs: 5000 }, h.state
    ) as Promise<Record<string, unknown>>;
    const firstResult = await first;
    expect(firstResult.cancelled).toBe(true);
    await waitFor(() => activeResourceWaiters.has('worker-2'));
    await h.state.releaseResource({ resourceId: 'box', workerId: 'worker-1' });
    const secondResult = await second;
    expect(secondResult.granted).toBe(true);
  });

  it('cleanupStaleResourceWaiters resolves waiters for vanished workers', async () => {
    await h.state.acquireResource({ resourceId: 'box', taskId: 'task-1', workerId: 'worker-1' });
    const tool = waitForResourceTool(h.state);
    const pending = tool.handler(
      { resourceId: 'box', taskId: 'task-2', workerId: 'worker-2', timeoutMs: 5000 }, h.state
    ) as Promise<Record<string, unknown>>;
    await waitFor(() => activeResourceWaiters.has('worker-2'));
    h.state.workers.delete('worker-2');
    const cleaned = cleanupStaleResourceWaiters(h.state);
    expect(cleaned).toBe(1);
    const result = await pending;
    expect(result.cancelled).toBe(true);
  });

  it('validates ownership and inputs', async () => {
    const tool = waitForResourceTool(h.state);
    await expect(tool.handler({ resourceId: 'box', taskId: 'task-1', workerId: 'worker-2' }, h.state)).rejects.toThrow();
    await expect(tool.handler({ resourceId: '!!', taskId: 'task-1', workerId: 'worker-1' }, h.state)).rejects.toThrow(/resourceId/);
    await expect(tool.handler({ resourceId: 'box', taskId: 'task-x', workerId: 'worker-1' }, h.state)).rejects.toThrow(/not found/i);
  });
});
