import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import WebSocket from 'ws';
import { ToolTestHarness } from '../tools/toolTestHarness.js';
import { activeWaiters } from '../tools/waitForTask.js';
import { activeChatWaiters } from '../tools/chatWait.js';
import { activeResourceWaiters } from '../tools/waitForResource.js';
import { McpAdapter } from './McpAdapter.js';
import { MoeWebSocketServer } from './WebSocketServer.js';

const cases = [
  { name: 'moe.wait_for_task', registry: activeWaiters, valid: { statuses: ['REVIEW'] }, invalid: {} },
  { name: 'moe.chat_wait', registry: activeChatWaiters, valid: {}, invalid: { sinceId: 42 } },
  { name: 'moe.wait_for_resource', registry: activeResourceWaiters,
    valid: { resourceId: 'box', taskId: 'task-waiter' }, invalid: { resourceId: 'box' } },
];

describe('MCP waiter registration ownership', () => {
  const h = new ToolTestHarness();
  const clients: WebSocket[] = [];
  let http: Server;
  let server: MoeWebSocketServer;
  let port: number;

  beforeEach(async () => {
    h.init();
    h.setupMoeFolder();
    h.createEpic();
    h.createTask({ id: 'task-holder', status: 'WORKING', assignedWorkerId: 'worker-holder' });
    h.createTask({ id: 'task-waiter', status: 'WORKING', assignedWorkerId: 'worker-waiter' });
    await h.state.load();
    await h.state.acquireResource({ resourceId: 'box', taskId: 'task-holder', workerId: 'worker-holder' });
    http = createServer();
    http.listen(0, '127.0.0.1');
    await once(http, 'listening');
    port = (http.address() as { port: number }).port;
    server = new MoeWebSocketServer(http, h.state, new McpAdapter(h.state));
  });

  afterEach(async () => {
    for (const client of clients.splice(0)) client.terminate();
    await server.close();
    await new Promise<void>(resolve => http.close(() => resolve()));
    for (const { registry } of cases) {
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

  async function connect(): Promise<WebSocket> {
    const client = new WebSocket(`ws://127.0.0.1:${port}/mcp`);
    clients.push(client);
    await once(client, 'open');
    return client;
  }

  function request(name: string, args: Record<string, unknown>, id = 1) {
    return { jsonrpc: '2.0', id, method: 'tools/call',
      params: { name, arguments: { workerId: 'worker-waiter', timeoutMs: 10000, ...args } } };
  }

  async function disconnect(client: WebSocket): Promise<void> {
    const cleanup = vi.spyOn(server as unknown as { cleanupMcpWorkers(ws: WebSocket): Promise<void> },
      'cleanupMcpWorkers');
    const previousCalls = cleanup.mock.calls.length;
    const closed = once(client, 'close');
    client.close();
    await closed;
    await vi.waitFor(() => expect(cleanup.mock.calls.length).toBeGreaterThan(previousCalls));
  }

  it.each(cases)('rejected $name replacement cannot cancel the original socket waiter', async entry => {
    const original = await connect();
    original.send(JSON.stringify(request(entry.name, entry.valid)));
    await vi.waitFor(() => expect(entry.registry.has('worker-waiter')).toBe(true));
    const waiter = entry.registry.get('worker-waiter');
    const rejected = await connect();
    const response = once(rejected, 'message');
    rejected.send(JSON.stringify(request(entry.name, entry.invalid)));
    const [raw] = await response;
    expect(JSON.parse(raw.toString()).error.code).toBe(-32602);

    await disconnect(rejected);
    expect(entry.registry.get('worker-waiter')).toBe(waiter);
    await disconnect(original);
    expect(entry.registry.has('worker-waiter')).toBe(false);
  });

  it.each(cases)('registered $name replacement becomes the sole socket owner', async entry => {
    const original = await connect();
    original.send(JSON.stringify(request(entry.name, entry.valid)));
    await vi.waitFor(() => expect(entry.registry.has('worker-waiter')).toBe(true));
    const oldWaiter = entry.registry.get('worker-waiter');
    const replacement = await connect();
    replacement.send(JSON.stringify(request(entry.name, entry.valid)));
    await vi.waitFor(() => {
      expect(entry.registry.has('worker-waiter')).toBe(true);
      expect(entry.registry.get('worker-waiter')).not.toBe(oldWaiter);
    });
    const newWaiter = entry.registry.get('worker-waiter');

    await disconnect(original);
    expect(entry.registry.get('worker-waiter')).toBe(newWaiter);
    await disconnect(replacement);
    expect(entry.registry.has('worker-waiter')).toBe(false);
  });

  it('an undispatched batch request cannot steal a live socket waiter', async () => {
    const original = await connect();
    original.send(JSON.stringify(request('moe.wait_for_task', { statuses: ['REVIEW'] })));
    await vi.waitFor(() => expect(activeWaiters.has('worker-waiter')).toBe(true));
    const waiter = activeWaiters.get('worker-waiter');
    const batch = await connect();
    batch.send(JSON.stringify([
      request('moe.chat_wait', { workerId: 'worker-batch' }),
      request('moe.wait_for_task', { statuses: ['REVIEW'] }, 2),
    ]));
    await vi.waitFor(() => expect(activeChatWaiters.has('worker-batch')).toBe(true));

    await disconnect(batch);
    expect(activeWaiters.get('worker-waiter')).toBe(waiter);
    expect(activeChatWaiters.has('worker-batch')).toBe(false);
    await disconnect(original);
    expect(activeWaiters.has('worker-waiter')).toBe(false);
  });
});
