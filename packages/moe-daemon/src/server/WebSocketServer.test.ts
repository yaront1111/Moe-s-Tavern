import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createServer, Server } from 'http';
import WebSocket from 'ws';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { MoeWebSocketServer } from './WebSocketServer.js';
import { StateManager } from '../state/StateManager.js';
import { McpAdapter } from './McpAdapter.js';
import { activeWaiters } from '../tools/waitForTask.js';
import { activeChatWaiters } from '../tools/chatWait.js';

describe('MoeWebSocketServer Integration', () => {
  let testDir: string;
  let moePath: string;
  let state: StateManager;
  let mcpAdapter: McpAdapter;
  let httpServer: Server;
  let wsServer: MoeWebSocketServer;
  let port: number;

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
      settings: {
        approvalMode: 'CONTROL',
        speedModeDelayMs: 2000,
        autoCreateBranch: true,
        branchPattern: 'moe/{epicId}/{taskId}',
        commitPattern: 'feat({epicId}): {taskTitle}',
        agentCommand: 'claude',
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    fs.writeFileSync(path.join(moePath, 'project.json'), JSON.stringify(project, null, 2));
  }

  function createEpic(id = 'epic-1') {
    const epic = {
      id,
      projectId: 'proj-test',
      title: 'Test Epic',
      description: 'Test description',
      architectureNotes: '',
      epicRails: [],
      status: 'ACTIVE',
      order: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(moePath, 'epics', `${id}.json`), JSON.stringify(epic, null, 2));
  }

  function createTask(id = 'task-1') {
    const task = {
      id,
      epicId: 'epic-1',
      title: 'Test Task',
      description: 'Test description',
      definitionOfDone: [],
      taskRails: [],
      implementationPlan: [],
      status: 'BACKLOG',
      assignedWorkerId: null,
      branch: null,
      prLink: null,
      reopenCount: 0,
      reopenReason: null,
      createdBy: 'HUMAN',
      parentTaskId: null,
      order: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(moePath, 'tasks', `${id}.json`), JSON.stringify(task, null, 2));
  }

  beforeEach(async () => {
    // Create temp directory (cross-platform)
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moe-ws-test-'));
    moePath = path.join(testDir, '.moe');
    setupMoeFolder();
    createEpic();
    createTask();

    state = new StateManager({ projectPath: testDir });
    await state.load();
    mcpAdapter = new McpAdapter(state);

    // Create HTTP server on random available port
    httpServer = createServer();
    await new Promise<void>((resolve) => {
      httpServer.listen(0, '127.0.0.1', () => {
        const address = httpServer.address();
        if (address && typeof address === 'object') {
          port = address.port;
        }
        resolve();
      });
    });

    wsServer = new MoeWebSocketServer(httpServer, state, mcpAdapter);
  });

  afterEach(async () => {
    // Close all WebSocket connections first, then the HTTP server
    if (wsServer && !wsServer.closed) {
      await wsServer.close();
    }
    await new Promise<void>((resolve) => {
      httpServer.close(() => resolve());
    });
    for (const waiter of activeWaiters.values()) clearTimeout(waiter.timer);
    activeWaiters.clear();
    for (const waiter of activeChatWaiters.values()) clearTimeout(waiter.timer);
    activeChatWaiters.clear();
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  describe('Plugin endpoint (/ws)', () => {
    // Helper: connect and collect messages in order to avoid race conditions.
    // The STATE_SNAPSHOT can arrive before a late-registered handler, so we
    // buffer messages from the start.
    function connectAndCollect(endpoint = '/ws') {
      const ws = new WebSocket(`ws://127.0.0.1:${port}${endpoint}`);
      const messages: string[] = [];
      let waiting: ((msg: string) => void) | null = null;

      ws.on('message', (data) => {
        const msg = data.toString();
        if (waiting) {
          const resolve = waiting;
          waiting = null;
          resolve(msg);
        } else {
          messages.push(msg);
        }
      });

      const ready = new Promise<void>((resolve) => ws.on('open', () => resolve()));

      function nextMessage(timeoutMs = 5000): Promise<string> {
        if (messages.length > 0) {
          return Promise.resolve(messages.shift()!);
        }
        return new Promise<string>((resolve, reject) => {
          waiting = resolve;
          setTimeout(() => { waiting = null; reject(new Error('Timeout')); }, timeoutMs);
        });
      }

      return { ws, ready, nextMessage };
    }

    it('sends STATE_SNAPSHOT on connection', async () => {
      const { ws, nextMessage } = connectAndCollect();

      const message = await nextMessage();
      const parsed = JSON.parse(message);
      expect(parsed.type).toBe('STATE_SNAPSHOT');
      expect(parsed.payload.project.name).toBe('Test Project');
      expect(parsed.payload.tasks.length).toBe(1);

      ws.close();
    });

    it('responds to PING with PONG', async () => {
      const { ws, ready, nextMessage } = connectAndCollect();
      await ready;

      // Skip initial STATE_SNAPSHOT
      await nextMessage();

      // Send PING
      ws.send(JSON.stringify({ type: 'PING' }));

      const response = await nextMessage();
      const parsed = JSON.parse(response);
      expect(parsed.type).toBe('PONG');

      ws.close();
    });

    it('responds to GET_STATE', async () => {
      const { ws, ready, nextMessage } = connectAndCollect();
      await ready;

      // Skip initial STATE_SNAPSHOT
      await nextMessage();

      // Request state
      ws.send(JSON.stringify({ type: 'GET_STATE' }));

      const response = await nextMessage();
      const parsed = JSON.parse(response);
      expect(parsed.type).toBe('STATE_SNAPSHOT');
      expect(parsed.payload.epics.length).toBe(1);

      ws.close();
    });

    it('caps and truncates GET_ACTIVITY_LOG responses', async () => {
      const logPath = path.join(moePath, 'activity.log');
      for (let i = 0; i < 120; i++) {
        fs.appendFileSync(logPath, JSON.stringify({
          id: `evt-ws-${i}`,
          timestamp: new Date(Date.now() + i).toISOString(),
          projectId: 'proj-test',
          event: 'TASK_UPDATED',
          payload: { bigField: 'x'.repeat(5000), index: i },
        }) + '\n');
      }

      const { ws, ready, nextMessage } = connectAndCollect();
      await ready;
      await nextMessage();

      ws.send(JSON.stringify({ type: 'GET_ACTIVITY_LOG', payload: { limit: 999999, maxPayloadChars: 999999 } }));

      const response = await nextMessage();
      const parsed = JSON.parse(response);
      expect(parsed.type).toBe('ACTIVITY_LOG');
      expect(parsed.payload.length).toBeLessThanOrEqual(100);
      expect(parsed.payload[0].payload.bigField.length).toBeLessThanOrEqual(2020);
      expect(parsed.payload[0].payload.bigField).toContain('[truncated]');

      ws.send(JSON.stringify({ type: 'GET_ACTIVITY_LOG', payload: { limit: 1, maxPayloadChars: 0 } }));
      const zeroCapResponse = await nextMessage();
      const zeroCapParsed = JSON.parse(zeroCapResponse);
      expect(zeroCapParsed.type).toBe('ACTIVITY_LOG');
      expect(zeroCapParsed.payload).toHaveLength(1);
      expect(zeroCapParsed.payload[0].payload.bigField.length).toBeLessThanOrEqual(520);
      expect(zeroCapParsed.payload[0].payload.bigField).toContain('[truncated]');

      ws.close();
    });

    it('returns epic lifecycle activity from GET_ACTIVITY_LOG newest-first', async () => {
      const epic = await state.createEpic({ title: 'WS Epic', status: 'ACTIVE', order: 2 });
      await state.updateEpic(epic.id, { title: 'WS Epic Updated', order: 3 });
      await state.flushActivityLog();

      const { ws, ready, nextMessage } = connectAndCollect();
      await ready;
      await nextMessage();

      ws.send(JSON.stringify({
        type: 'GET_ACTIVITY_LOG',
        payload: {
          epicId: epic.id,
          eventTypes: ['EPIC_CREATED', 'EPIC_UPDATED'],
          limit: 10,
          maxPayloadChars: 0,
        },
      }));

      const response = await nextMessage();
      const parsed = JSON.parse(response);
      expect(parsed.type).toBe('ACTIVITY_LOG');
      expect(parsed.payload.map((event: { event: string }) => event.event)).toEqual(['EPIC_UPDATED', 'EPIC_CREATED']);
      expect(parsed.payload.every((event: { epicId?: string }) => event.epicId === epic.id)).toBe(true);

      ws.close();
    });

    it('rejects ADD_TASK_COMMENT payloads over 10K characters', async () => {
      const { ws, ready, nextMessage } = connectAndCollect();
      await ready;

      // Skip initial STATE_SNAPSHOT
      await nextMessage();

      ws.send(JSON.stringify({
        type: 'ADD_TASK_COMMENT',
        payload: {
          taskId: 'task-1',
          content: 'x'.repeat(10_001),
          author: 'human',
        },
      }));

      const response = await nextMessage();
      const parsed = JSON.parse(response);
      expect(parsed.type).toBe('ERROR');
      expect(parsed.message).toContain('10000');

      ws.close();
    });

    it('returns an ERROR for invalid settings updates without persisting them', async () => {
      const { ws, ready, nextMessage } = connectAndCollect();
      await ready;

      await nextMessage();

      ws.send(JSON.stringify({
        type: 'UPDATE_SETTINGS',
        payload: {
          approvalMode: 'CHAOS',
          agentCommand: 'codex',
        },
      }));

      const response = await nextMessage();
      const parsed = JSON.parse(response);
      expect(parsed.type).toBe('ERROR');
      expect(parsed.message).toContain('approvalMode');
      expect(state.project?.settings.approvalMode).toBe('CONTROL');
      expect(state.project?.settings.agentCommand).toBe('claude');

      ws.close();
    });

    it('returns an ERROR for invalid team updates without persisting them', async () => {
      const team = await state.createTeam({ name: 'Workers', role: 'worker', maxSize: 2 });
      const { ws, ready, nextMessage } = connectAndCollect();
      await ready;

      await nextMessage();

      ws.send(JSON.stringify({
        type: 'UPDATE_TEAM',
        payload: {
          teamId: team.id,
          updates: {
            memberIds: ['worker-1', 'worker-1'],
            name: 'Should Not Persist',
          },
        },
      }));

      const response = await nextMessage();
      const parsed = JSON.parse(response);
      expect(parsed.type).toBe('ERROR');
      expect(parsed.message).toContain('memberIds');
      expect(state.getTeam(team.id)?.name).toBe('Workers');

      ws.close();
    });

    it('returns an ERROR for immutable CREATE_TEAM fields without creating a team', async () => {
      const { ws, ready, nextMessage } = connectAndCollect();
      await ready;

      await nextMessage();

      ws.send(JSON.stringify({
        type: 'CREATE_TEAM',
        payload: {
          id: 'team-evil',
          name: 'Injected Team',
          role: 'worker',
        },
      }));

      const response = await nextMessage();
      const parsed = JSON.parse(response);
      expect(parsed.type).toBe('ERROR');
      expect(parsed.message).toContain('id');
      expect(state.getTeamByName('Injected Team')).toBeNull();

      ws.close();
    });

    it('sends DAEMON_SHUTTING_DOWN before closing plugin connections', async () => {
      const { ws, ready, nextMessage } = connectAndCollect();
      await ready;

      // Skip initial STATE_SNAPSHOT
      await nextMessage();

      const socketClosed = new Promise<void>((resolve) => {
        ws.on('close', () => resolve());
      });

      const closePromise = wsServer.close();
      const shutdownMessage = await nextMessage();
      const parsed = JSON.parse(shutdownMessage);

      expect(parsed.type).toBe('DAEMON_SHUTTING_DOWN');

      await closePromise;
      await socketClosed;
    });
  });

  describe('MCP endpoint (/mcp)', () => {
    async function waitUntil(
      predicate: () => boolean,
      description: string,
      timeoutMs = 1000
    ): Promise<void> {
      const startedAt = Date.now();
      while (Date.now() - startedAt < timeoutMs) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(`Timed out waiting for ${description}`);
    }

    it('handles tools/list request', async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/mcp`);

      await new Promise<void>((resolve) => {
        ws.on('open', () => resolve());
      });

      // Send MCP request
      ws.send(JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
      }));

      const response = await new Promise<string>((resolve, reject) => {
        ws.on('message', (data) => resolve(data.toString()));
        setTimeout(() => reject(new Error('Timeout')), 5000);
      });

      const parsed = JSON.parse(response);
      expect(parsed.jsonrpc).toBe('2.0');
      expect(parsed.id).toBe(1);
      expect(parsed.result.tools).toBeDefined();
      expect(Array.isArray(parsed.result.tools)).toBe(true);

      ws.close();
    });

    it('handles tools/call request', async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/mcp`);

      await new Promise<void>((resolve) => {
        ws.on('open', () => resolve());
      });

      // Call list_tasks tool
      ws.send(JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'moe.list_tasks',
          arguments: {},
        },
      }));

      const response = await new Promise<string>((resolve, reject) => {
        ws.on('message', (data) => resolve(data.toString()));
        setTimeout(() => reject(new Error('Timeout')), 5000);
      });

      const parsed = JSON.parse(response);
      expect(parsed.jsonrpc).toBe('2.0');
      expect(parsed.id).toBe(2);
      expect(parsed.result).toBeDefined();

      // Parse the content
      const content = JSON.parse(parsed.result.content[0].text);
      expect(content.tasks.length).toBe(1);
      expect(content.tasks[0].id).toBe('task-1');

      ws.close();
    });

    it('does not start later batched waiters after the MCP socket closes mid-batch', async () => {
      const workerId = 'worker-batch-close';
      const ws = new WebSocket(`ws://127.0.0.1:${port}/mcp`);

      await new Promise<void>((resolve, reject) => {
        ws.on('open', () => resolve());
        ws.on('error', reject);
      });

      ws.send(JSON.stringify([
        {
          jsonrpc: '2.0',
          id: 'wait',
          method: 'tools/call',
          params: {
            name: 'moe.wait_for_task',
            arguments: { statuses: ['WORKING'], workerId, timeoutMs: 60_000 },
          },
        },
        {
          jsonrpc: '2.0',
          id: 'chat',
          method: 'tools/call',
          params: {
            name: 'moe.chat_wait',
            arguments: { workerId, timeoutMs: 60_000 },
          },
        },
      ]));

      await waitUntil(() => activeWaiters.has(workerId), 'wait_for_task waiter registration');

      const closed = new Promise<void>((resolve) => {
        ws.on('close', () => resolve());
      });
      ws.close();
      await closed;

      await waitUntil(() => !activeWaiters.has(workerId), 'wait_for_task disconnect cleanup');
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(activeWaiters.has(workerId)).toBe(false);
      expect(activeChatWaiters.has(workerId)).toBe(false);
    });

    it('tracks worker IDs from batched tools/call requests for disconnect cleanup', async () => {
      const waitResolve = vi.fn();
      const waitUnsubscribe = vi.fn();
      const waitTimer = setTimeout(() => {}, 60_000);
      activeWaiters.set('worker-batch-wait', {
        resolve: waitResolve,
        unsubscribe: waitUnsubscribe,
        timer: waitTimer,
      });

      const chatResolve = vi.fn();
      const chatUnsubscribe = vi.fn();
      const chatTimer = setTimeout(() => {}, 60_000);
      activeChatWaiters.set('worker-batch-chat', {
        resolve: chatResolve,
        unsubscribe: chatUnsubscribe,
        timer: chatTimer,
        channels: null,
      });

      const fakeWs = {} as WebSocket;
      const internals = wsServer as unknown as {
        trackMcpWorker(ws: WebSocket, request: unknown): void;
        cleanupMcpWorkers(ws: WebSocket): Promise<void>;
        mcpWorkerMap: Map<WebSocket, Set<string>>;
      };

      internals.trackMcpWorker(fakeWs, [
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'moe.wait_for_task', arguments: { workerId: 'worker-batch-wait' } },
        },
        { jsonrpc: '2.0', id: 2, method: 'tools/list' },
        {
          jsonrpc: '2.0',
          id: 3,
          method: 'tools/call',
          params: { name: 'moe.chat_wait', arguments: { workerId: 'worker-batch-chat' } },
        },
      ]);

      expect(internals.mcpWorkerMap.get(fakeWs)).toEqual(new Set(['worker-batch-wait', 'worker-batch-chat']));

      await internals.cleanupMcpWorkers(fakeWs);

      expect(activeWaiters.has('worker-batch-wait')).toBe(false);
      expect(waitUnsubscribe).toHaveBeenCalledTimes(1);
      expect(waitResolve).toHaveBeenCalledWith({ hasNext: false, cancelled: true });
      expect(activeChatWaiters.has('worker-batch-chat')).toBe(false);
      expect(chatUnsubscribe).toHaveBeenCalledTimes(1);
      expect(chatResolve).toHaveBeenCalledWith({ hasMessage: false, cancelled: true });
    });
  });

  describe('Error handling', () => {
    it('allows repeated close calls without throwing', async () => {
      await wsServer.close();
      await expect(wsServer.close()).resolves.toBeUndefined();
    });

    it('survives rapid client connect/disconnect cycles', async () => {
      // Simulate multiple rapid connections and disconnections
      // This exercises the error handlers for abrupt disconnects
      for (let i = 0; i < 3; i++) {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
        await new Promise<void>((resolve) => {
          ws.on('open', () => resolve());
          ws.on('error', () => resolve()); // Ignore connection errors
        });
        ws.close();
        await new Promise((r) => setTimeout(r, 50));
      }

      // Server should still work after rapid disconnects
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      const message = await new Promise<string>((resolve, reject) => {
        ws.on('message', (data) => resolve(data.toString()));
        ws.on('error', reject);
        setTimeout(() => reject(new Error('Timeout')), 5000);
      });

      const parsed = JSON.parse(message);
      expect(parsed.type).toBe('STATE_SNAPSHOT');
      ws.close();
    });

    it('handles invalid JSON gracefully', async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      const messages: string[] = [];
      let waiting: ((msg: string) => void) | null = null;

      ws.on('message', (data) => {
        const msg = data.toString();
        if (waiting) {
          const resolve = waiting;
          waiting = null;
          resolve(msg);
        } else {
          messages.push(msg);
        }
      });

      await new Promise<void>((resolve) => ws.on('open', () => resolve()));

      function nextMessage(timeoutMs = 5000): Promise<string> {
        if (messages.length > 0) return Promise.resolve(messages.shift()!);
        return new Promise<string>((resolve, reject) => {
          waiting = resolve;
          setTimeout(() => { waiting = null; reject(new Error('Timeout')); }, timeoutMs);
        });
      }

      // Skip initial STATE_SNAPSHOT
      await nextMessage();

      // Send invalid JSON - should not crash server
      ws.send('not valid json');

      // Server responds with ERROR for invalid JSON, then we send PING
      // Consume the ERROR response first
      const errorMsg = await nextMessage();
      const errorParsed = JSON.parse(errorMsg);
      expect(errorParsed.type).toBe('ERROR');

      // Server should still respond to valid messages
      ws.send(JSON.stringify({ type: 'PING' }));

      const response = await nextMessage();

      const parsed = JSON.parse(response);
      expect(parsed.type).toBe('PONG');

      ws.close();
    });
  });
});
