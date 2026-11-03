import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { McpAdapter, type JsonRpcResponse } from '../server/McpAdapter.js';
import { ToolTestHarness } from './toolTestHarness.js';
import { activeResourceWaiters } from './waitForResource.js';

const WORKER = 'worker-waiter';

function resultOf(response: unknown): unknown {
  const r = response as JsonRpcResponse;
  const text = (r.result as { content?: Array<{ text: string }> } | undefined)?.content?.[0]?.text;
  return text ? JSON.parse(text) : r;
}

/** Mirrors the disconnect sequence in WebSocketServer (get, clear, unsubscribe, resolve, delete). */
function disconnectCleanup(workerId: string): void {
  const waiter = activeResourceWaiters.get(workerId);
  if (!waiter) return;
  clearTimeout(waiter.timer);
  waiter.unsubscribe();
  waiter.resolve({ granted: false, cancelled: true });
  activeResourceWaiters.delete(workerId);
}

describe('wait_for_resource: overlapping calls for one worker', () => {
  const h = new ToolTestHarness();
  let adapter: McpAdapter;
  let owners: string[];
  let outcomes: Map<number, unknown>;

  beforeEach(async () => {
    h.init();
    h.setupMoeFolder();
    h.createEpic();
    h.createTask({ id: 'task-holder', status: 'WORKING', assignedWorkerId: 'worker-holder' });
    h.createTask({ id: 'task-waiter', status: 'WORKING', assignedWorkerId: WORKER });
    h.createWorker({ id: 'worker-holder', currentTaskId: 'task-holder' });
    h.createWorker({ id: WORKER, currentTaskId: 'task-waiter' });
    await h.state.load();
    await h.state.acquireResource({ resourceId: 'box', taskId: 'task-holder', workerId: 'worker-holder' });
    adapter = new McpAdapter(h.state);
    owners = [];
    outcomes = new Map();
  });

  afterEach(() => {
    for (const waiter of activeResourceWaiters.values()) {
      clearTimeout(waiter.timer);
      waiter.unsubscribe();
      waiter.resolve({ granted: false, cancelled: true });
    }
    activeResourceWaiters.clear();
    h.cleanup();
  });

  /** Starts a call without awaiting it; its result lands in `outcomes`. */
  function startWait(id: number, timeoutMs: number): Promise<void> {
    return adapter.handle(
      { jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'moe.wait_for_resource',
        arguments: { workerId: WORKER, resourceId: 'box', taskId: 'task-waiter', timeoutMs } } },
      { onWaiterRegistered: (_tool, workerId) => { owners.push(`call${id}:${workerId}`); } },
    ).then((r) => { outcomes.set(id, resultOf(r)); });
  }

  const registered = (n: number) => vi.waitFor(() => expect(owners.length).toBeGreaterThanOrEqual(n), { timeout: 5000, interval: 10 });

  it('the earlier call resolves cancelled and the registry keeps the later waiter', async () => {
    const first = startWait(1, 60_000);
    const second = startWait(2, 60_000); // started with no await: overlaps call 1's pre-park window
    await registered(2);
    await vi.waitFor(() => expect(outcomes.get(1)).toEqual({ granted: false, cancelled: true }), { timeout: 5000, interval: 10 });
    expect(outcomes.has(2)).toBe(false);
    expect(activeResourceWaiters.get(WORKER)).toBeDefined();
    expect(activeResourceWaiters.size).toBe(1);
    disconnectCleanup(WORKER);
    await Promise.all([first, second]);
  }, 15_000);

  it('a disconnect cleanup finds and cancels the live waiter after the earlier call is gone', async () => {
    const first = startWait(1, 60_000);
    const second = startWait(2, 60_000);
    await registered(2);
    await first; // call 1 and its cleanup have run
    expect(activeResourceWaiters.get(WORKER)).toBeDefined();
    disconnectCleanup(WORKER);
    await vi.waitFor(() => expect(outcomes.get(2)).toEqual({ granted: false, cancelled: true }), { timeout: 5000, interval: 10 });
    expect(activeResourceWaiters.size).toBe(0);
    await second;
  }, 15_000);

  it('a replaced waiter\'s own timer never removes the live waiter\'s entry', async () => {
    const first = startWait(1, 1000);
    const second = startWait(2, 60_000);
    await registered(2);
    await vi.waitFor(() => expect(outcomes.get(1)).toBeDefined(), { timeout: 5000, interval: 10 });
    await first;
    expect(activeResourceWaiters.get(WORKER)).toBeDefined();
    expect(outcomes.has(2)).toBe(false);
    disconnectCleanup(WORKER);
    await second;
    expect(outcomes.get(2)).toEqual({ granted: false, cancelled: true });
  }, 15_000);

  it('sequential re-entry still cancels the parked call and parks the new one', async () => {
    const first = startWait(1, 60_000);
    await registered(1);
    const second = startWait(2, 60_000);
    await first;
    expect(outcomes.get(1)).toEqual({ granted: false, cancelled: true });
    await registered(2);
    expect(activeResourceWaiters.get(WORKER)).toBeDefined();
    disconnectCleanup(WORKER);
    await second;
    expect(outcomes.get(2)).toEqual({ granted: false, cancelled: true });
  }, 15_000);
});
