import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createServer, Server } from 'http';
import type WebSocket from 'ws';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { MoeWebSocketServer } from './WebSocketServer.js';
import { StateManager } from '../state/StateManager.js';
import { McpAdapter } from './McpAdapter.js';
import { activeWaiters } from '../tools/waitForTask.js';
import { activeChatWaiters } from '../tools/chatWait.js';

// Focused coverage for the M4 fix: activeWaiters / activeChatWaiters are keyed
// globally by workerId, so a short-lived second /mcp connection that reuses a
// parked id must NOT cancel the live waiter owned by the first connection.
describe('WebSocketServer M4 waiter ownership guard', () => {
  let testDir: string;
  let moePath: string;
  let state: StateManager;
  let mcpAdapter: McpAdapter;
  let httpServer: Server;
  let wsServer: MoeWebSocketServer;

  function setupMoeFolder() {
    fs.mkdirSync(moePath, { recursive: true });
    fs.mkdirSync(path.join(moePath, 'epics'));
    fs.mkdirSync(path.join(moePath, 'tasks'));
    fs.mkdirSync(path.join(moePath, 'workers'));
    fs.mkdirSync(path.join(moePath, 'proposals'));

    const project = {
      id: 'proj-test',
      name: 'Test Project',
      rootPath: testDir,
      globalRails: {
        techStack: [],
        forbiddenPatterns: [],
        requiredPatterns: [],
        formatting: '',
        testing: '',
        customRules: [],
      },
      settings: { approvalMode: 'CONTROL', agentCommand: 'claude' },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(moePath, 'project.json'), JSON.stringify(project, null, 2));
  }

  beforeEach(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moe-ws-fixes-'));
    moePath = path.join(testDir, '.moe');
    setupMoeFolder();

    state = new StateManager({ projectPath: testDir });
    await state.load();
    mcpAdapter = new McpAdapter(state);

    httpServer = createServer();
    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', () => resolve()));
    wsServer = new MoeWebSocketServer(httpServer, state, mcpAdapter);
  });

  afterEach(async () => {
    if (wsServer && !wsServer.closed) {
      await wsServer.close();
    }
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    for (const waiter of activeWaiters.values()) clearTimeout(waiter.timer);
    activeWaiters.clear();
    for (const waiter of activeChatWaiters.values()) clearTimeout(waiter.timer);
    activeChatWaiters.clear();
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  type Internals = {
    trackMcpWorker(ws: WebSocket, request: unknown): void;
    cleanupMcpWorkers(ws: WebSocket): Promise<void>;
  };

  it('does not cancel a live wait_for_task waiter when a second ws reusing the same workerId disconnects', async () => {
    const internals = wsServer as unknown as Internals;
    const workerId = 'worker-shared';

    const resolveSpy = vi.fn();
    const unsubscribeSpy = vi.fn();
    const timer = setTimeout(() => {}, 60_000);
    activeWaiters.set(workerId, { resolve: resolveSpy, unsubscribe: unsubscribeSpy, timer });

    // ws1 owns the parked waiter (it issued the wait_for_task call).
    const ws1 = {} as WebSocket;
    internals.trackMcpWorker(ws1, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'moe.wait_for_task', arguments: { statuses: ['WORKING'], workerId } },
    });

    // ws2 is a short-lived connection that reuses the same workerId on a
    // NON-wait tool call (e.g. a one-shot list/touch). It must not own the waiter.
    const ws2 = {} as WebSocket;
    internals.trackMcpWorker(ws2, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'moe.list_tasks', arguments: { workerId } },
    });

    // ws2 disconnecting must NOT touch ws1's live waiter.
    await internals.cleanupMcpWorkers(ws2);
    expect(resolveSpy).not.toHaveBeenCalled();
    expect(unsubscribeSpy).not.toHaveBeenCalled();
    expect(activeWaiters.has(workerId)).toBe(true);

    // ws1 disconnecting cancels the waiter it owns.
    await internals.cleanupMcpWorkers(ws1);
    expect(resolveSpy).toHaveBeenCalledWith({ hasNext: false, cancelled: true });
    expect(unsubscribeSpy).toHaveBeenCalledTimes(1);
    expect(activeWaiters.has(workerId)).toBe(false);
  });

  it('does not cancel a live chat_wait waiter when a second ws reusing the same workerId disconnects', async () => {
    const internals = wsServer as unknown as Internals;
    const workerId = 'worker-shared-chat';

    const resolveSpy = vi.fn();
    const unsubscribeSpy = vi.fn();
    const timer = setTimeout(() => {}, 60_000);
    activeChatWaiters.set(workerId, {
      resolve: resolveSpy,
      unsubscribe: unsubscribeSpy,
      timer,
      channels: null,
    });

    const ws1 = {} as WebSocket;
    internals.trackMcpWorker(ws1, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'moe.chat_wait', arguments: { workerId } },
    });

    const ws2 = {} as WebSocket;
    internals.trackMcpWorker(ws2, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'moe.chat_read', arguments: { workerId, channel: 'general' } },
    });

    await internals.cleanupMcpWorkers(ws2);
    expect(resolveSpy).not.toHaveBeenCalled();
    expect(unsubscribeSpy).not.toHaveBeenCalled();
    expect(activeChatWaiters.has(workerId)).toBe(true);

    await internals.cleanupMcpWorkers(ws1);
    expect(resolveSpy).toHaveBeenCalledWith({ hasMessage: false, cancelled: true });
    expect(unsubscribeSpy).toHaveBeenCalledTimes(1);
    expect(activeChatWaiters.has(workerId)).toBe(false);
  });
});
