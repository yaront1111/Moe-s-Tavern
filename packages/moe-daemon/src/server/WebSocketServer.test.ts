import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createServer, Server } from 'http';
import WebSocket from 'ws';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { MoeWebSocketServer } from './WebSocketServer.js';
import { StateManager } from '../state/StateManager.js';
import { McpAdapter } from './McpAdapter.js';

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
