import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { McpAdapter, type JsonRpcRequest, type JsonRpcResponse } from './McpAdapter.js';
import { ToolTestHarness } from '../tools/toolTestHarness.js';
import { activeWaiters } from '../tools/waitForTask.js';
import { activeResourceWaiters } from '../tools/waitForResource.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

function resultOf(response: JsonRpcResponse | JsonRpcResponse[] | null): unknown {
  const single = Array.isArray(response) ? response[0] : response;
  const result = single?.result as { content?: Array<{ text: string }> } | undefined;
  return result?.content?.[0] ? JSON.parse(result.content[0].text) : response;
}

describe('MCP cancellation during waiter setup', () => {
  const h = new ToolTestHarness();
  let adapter: McpAdapter;
  let connected: boolean;

  beforeEach(async () => {
    h.init();
    h.setupMoeFolder();
    h.createEpic();
    h.createTask({ id: 'task-holder', status: 'WORKING', assignedWorkerId: 'worker-holder' });
    h.createTask({ id: 'task-waiter', status: 'WORKING', assignedWorkerId: 'worker-waiter' });
    h.createWorker({ id: 'worker-waiter' });
    await h.state.load();
    adapter = new McpAdapter(h.state);
    connected = true;
  });

  afterEach(() => {
    for (const registry of [activeWaiters, activeResourceWaiters]) {
      for (const waiter of registry.values()) {
        clearTimeout(waiter.timer);
        waiter.unsubscribe();
        waiter.resolve({ cancelled: true });
      }
      registry.clear();
    }
    vi.restoreAllMocks();
    h.cleanup();
  });

  function call(name: string, args: Record<string, unknown>, batch = false) {
    const request: JsonRpcRequest = {
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name, arguments: { workerId: 'worker-waiter', timeoutMs: 1000, ...args } },
    };
    return adapter.handle(batch ? [request] : request, { shouldContinue: () => connected });
  }

  it.each([false, true])('does not park a task wait after disconnect during heartbeat (batch=%s)', async batch => {
    const touch = deferred();
    vi.spyOn(h.state, 'touchWorker').mockImplementation(async () => { await touch.promise; return null; });
    const pending = call('moe.wait_for_task', { statuses: ['REVIEW'] }, batch);
    connected = false;
    touch.resolve();

    expect(resultOf(await pending)).toEqual({ hasNext: false, cancelled: true });
    expect(activeWaiters.size).toBe(0);
  });

  it('does not acquire a resource after disconnect during heartbeat', async () => {
    const touch = deferred();
    vi.spyOn(h.state, 'touchWorker').mockImplementation(async () => { await touch.promise; return null; });
    const pending = call('moe.wait_for_resource', { resourceId: 'box', taskId: 'task-waiter' });
    connected = false;
    touch.resolve();

    expect(resultOf(await pending)).toEqual({ granted: false, cancelled: true });
    expect(h.state.getResource('box')).toBeNull();
    expect(activeResourceWaiters.size).toBe(0);
  });

  it('does not acquire a resource after disconnect while awaiting the mutex', async () => {
    const releaseMutex = deferred();
    const enteredMutex = deferred();
    vi.spyOn(h.state, 'touchWorker').mockResolvedValue(null);
    vi.spyOn(h.state, 'runExclusive').mockImplementation(async fn => {
      enteredMutex.resolve();
      await releaseMutex.promise;
      return fn();
    });
    const pending = call('moe.wait_for_resource', { resourceId: 'box', taskId: 'task-waiter' });
    await enteredMutex.promise;
    connected = false;
    releaseMutex.resolve();

    expect(resultOf(await pending)).toEqual({ granted: false, cancelled: true });
    expect(h.state.getResource('box')).toBeNull();
  });

  it('does not park after disconnect during resource persistence', async () => {
    await h.state.acquireResource({ resourceId: 'box', taskId: 'task-holder', workerId: 'worker-holder' });
    const persisted = deferred();
    const releasePersist = deferred();
    const acquire = h.state.acquireResource.bind(h.state);
    vi.spyOn(h.state, 'acquireResource').mockImplementation(async args => {
      const result = await acquire(args);
      persisted.resolve();
      await releasePersist.promise;
      return result;
    });
    const pending = call('moe.wait_for_resource', { resourceId: 'box', taskId: 'task-waiter' });
    await persisted.promise;
    connected = false;
    releasePersist.resolve();

    expect(resultOf(await pending)).toEqual({ granted: false, cancelled: true });
    expect(activeResourceWaiters.size).toBe(0);
    expect(h.state.getResource('box')?.queue.map(entry => entry.taskId)).toEqual(['task-waiter']);
  });
});
