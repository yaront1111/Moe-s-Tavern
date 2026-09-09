import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { MoeWebSocketServer } from './WebSocketServer.js';
import { McpAdapter } from './McpAdapter.js';
import { StateManager } from '../state/StateManager.js';
import { activeWaiters } from '../tools/waitForTask.js';
import { activeChatWaiters } from '../tools/chatWait.js';
import { activeResourceWaiters } from '../tools/waitForResource.js';

describe('WebSocket lifecycle boundaries', () => {
  let projectPath: string;
  let state: StateManager;
  let httpServer: Server;
  let server: MoeWebSocketServer;
  let port: number;
  const clients: WebSocket[] = [];

  beforeEach(async () => {
    projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'moe-ws-lifecycle-'));
    fs.mkdirSync(path.join(projectPath, '.moe'));
    fs.writeFileSync(path.join(projectPath, '.moe/project.json'), JSON.stringify({
      id: 'project-lifecycle', schemaVersion: 6, name: 'Lifecycle tests', rootPath: projectPath,
      settings: { approvalMode: 'CONTROL', agentCommand: 'claude' },
      globalRails: { techStack: [], forbiddenPatterns: [], requiredPatterns: [], customRules: [] },
    }));
    state = new StateManager({ projectPath });
    await state.load();
    httpServer = createServer();
    httpServer.listen(0, '127.0.0.1');
    await once(httpServer, 'listening');
    port = (httpServer.address() as { port: number }).port;
    server = new MoeWebSocketServer(httpServer, state, new McpAdapter(state));
  });

  afterEach(async () => {
    for (const client of clients.splice(0)) client.terminate();
    await server.close();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    for (const registry of [activeWaiters, activeChatWaiters, activeResourceWaiters]) {
      for (const waiter of registry.values()) {
        clearTimeout(waiter.timer);
        waiter.unsubscribe();
        waiter.resolve({ cancelled: true });
      }
      registry.clear();
    }
    vi.restoreAllMocks();
    fs.rmSync(projectPath, { recursive: true, force: true });
  });

  async function connect(endpoint: string): Promise<WebSocket> {
    const client = new WebSocket(`ws://127.0.0.1:${port}/${endpoint}`);
    clients.push(client);
    await once(client, 'open');
    return client;
  }

  it('cancels all parked RPCs before shutdown completes', async () => {
    const epic = await state.createEpic({ title: 'Resource owners' });
    const holder = await state.createTask({ epicId: epic.id, title: 'Holder', status: 'WORKING' });
    const waiting = await state.createTask({ epicId: epic.id, title: 'Waiting', status: 'WORKING' });
    await state.updateTask(waiting.id, { assignedWorkerId: 'worker-resource' });
    await state.acquireResource({ resourceId: 'test-box', taskId: holder.id, workerId: 'worker-holder' });
    const ws = await connect('mcp');
    const calls = [
      { name: 'moe.wait_for_task', arguments: { workerId: 'worker-task', statuses: ['REVIEW'] } },
      { name: 'moe.chat_wait', arguments: { workerId: 'worker-chat' } },
      { name: 'moe.wait_for_resource', arguments: {
        workerId: 'worker-resource', resourceId: 'test-box', taskId: waiting.id,
      } },
    ];
    calls.forEach((params, id) => ws.send(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params })));
    await vi.waitFor(() => {
      expect(activeWaiters.has('worker-task')).toBe(true);
      expect(activeChatWaiters.has('worker-chat')).toBe(true);
      expect(activeResourceWaiters.has('worker-resource')).toBe(true);
    });
    const waiters = [activeWaiters.get('worker-task')!, activeChatWaiters.get('worker-chat')!,
      activeResourceWaiters.get('worker-resource')!];
    const resolves = waiters.map((waiter) => vi.spyOn(waiter, 'resolve'));
    const unsubscribes = waiters.map((waiter) => vi.spyOn(waiter, 'unsubscribe'));

    await Promise.all([server.close(), server.close()]);

    expect(activeWaiters.size).toBe(0);
    expect(activeChatWaiters.size).toBe(0);
    expect(activeResourceWaiters.size).toBe(0);
    resolves.forEach((resolve) => expect(resolve).toHaveBeenCalledWith(expect.objectContaining({ cancelled: true })));
    unsubscribes.forEach((unsubscribe) => expect(unsubscribe).toHaveBeenCalledTimes(1));
    // Socket teardown cancels the RPC, while task-keyed queue membership survives.
    expect(state.getResource('test-box')?.queue.map((entry) => entry.taskId)).toEqual([waiting.id]);
  });

  it.each([null, [], 42, 'PING', {}, { type: 1 }].map((payload) => [payload]))('rejects malformed plugin envelopes: %j', async (payload) => {
    const ws = await connect('ws');
    const messages: unknown[] = [];
    ws.on('message', (raw) => messages.push(JSON.parse(raw.toString())));
    ws.send(JSON.stringify(payload));
    await vi.waitFor(() => expect(messages).toContainEqual({ type: 'ERROR', message: 'Invalid message envelope' }));

    ws.send(JSON.stringify({ type: 'PING' }));
    await vi.waitFor(() => expect(messages).toContainEqual({ type: 'PONG' }));
  });

  it('does not register a waiter when shutdown finishes during heartbeat persistence', async () => {
    let resumeHeartbeat!: () => void;
    let heartbeatStarted!: () => void;
    const heartbeatGate = new Promise<void>((resolve) => { resumeHeartbeat = resolve; });
    const started = new Promise<void>((resolve) => { heartbeatStarted = resolve; });
    vi.spyOn(state, 'touchWorker').mockImplementation(async () => {
      heartbeatStarted();
      await heartbeatGate;
      return null;
    });
    const handle = vi.spyOn(McpAdapter.prototype, 'handle');
    const ws = await connect('mcp');
    ws.send(JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'moe.wait_for_task', arguments: { workerId: 'worker-slow', statuses: ['REVIEW'] } },
    }));
    try {
      await started;
      await server.close();
    } finally {
      resumeHeartbeat();
    }
    let settled = false;
    void handle.mock.results[0].value.then(() => { settled = true; });
    await vi.waitFor(() => expect(settled).toBe(true));
    expect(activeWaiters.has('worker-slow')).toBe(false);
  });

  it('refuses new connections while flushing the shutdown notification', async () => {
    await connect('ws');
    const handle = vi.spyOn(McpAdapter.prototype, 'handle');
    const closing = server.close();
    const lateClient = new WebSocket(`ws://127.0.0.1:${port}/mcp`);
    clients.push(lateClient);
    lateClient.on('open', () => lateClient.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })));
    const codes: number[] = [];
    lateClient.on('close', (code) => codes.push(code));

    await closing;

    expect(handle).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(codes).toEqual([1001]));
  });
});
