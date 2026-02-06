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
    // Close all connections
    await new Promise<void>((resolve) => {
      httpServer.close(() => resolve());
    });
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  describe('Plugin endpoint (/ws)', () => {
    it('sends STATE_SNAPSHOT on connection', async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);

      const message = await new Promise<string>((resolve, reject) => {
        ws.on('message', (data) => resolve(data.toString()));
        ws.on('error', reject);
        setTimeout(() => reject(new Error('Timeout')), 5000);
      });

      const parsed = JSON.parse(message);
      expect(parsed.type).toBe('STATE_SNAPSHOT');
      expect(parsed.payload.project.name).toBe('Test Project');
      expect(parsed.payload.tasks.length).toBe(1);

      ws.close();
    });

    it('responds to PING with PONG', async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);

      await new Promise<void>((resolve) => {
        ws.on('open', () => resolve());
      });

      // Skip initial STATE_SNAPSHOT
      await new Promise<void>((resolve) => {
        ws.once('message', () => resolve());
      });

      // Send PING
      ws.send(JSON.stringify({ type: 'PING' }));

      const response = await new Promise<string>((resolve, reject) => {
        ws.on('message', (data) => resolve(data.toString()));
        setTimeout(() => reject(new Error('Timeout')), 5000);
      });

      const parsed = JSON.parse(response);
      expect(parsed.type).toBe('PONG');

      ws.close();
    });

    it('responds to GET_STATE', async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);

      await new Promise<void>((resolve) => {
        ws.on('open', () => resolve());
      });

      // Skip initial STATE_SNAPSHOT
      await new Promise<void>((resolve) => {
        ws.once('message', () => resolve());
      });

      // Request state
      ws.send(JSON.stringify({ type: 'GET_STATE' }));

      const response = await new Promise<string>((resolve, reject) => {
        ws.on('message', (data) => resolve(data.toString()));
        setTimeout(() => reject(new Error('Timeout')), 5000);
      });

      const parsed = JSON.parse(response);
      expect(parsed.type).toBe('STATE_SNAPSHOT');
      expect(parsed.payload.epics.length).toBe(1);

      ws.close();
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

      await new Promise<void>((resolve) => {
        ws.on('open', () => resolve());
      });

      // Skip initial STATE_SNAPSHOT
      await new Promise<void>((resolve) => {
        ws.once('message', () => resolve());
      });

      // Send invalid JSON - should not crash server
      ws.send('not valid json');

      // Server should still respond to valid messages
      ws.send(JSON.stringify({ type: 'PING' }));

      const response = await new Promise<string>((resolve, reject) => {
        ws.on('message', (data) => resolve(data.toString()));
        setTimeout(() => reject(new Error('Timeout')), 5000);
      });

      const parsed = JSON.parse(response);
      expect(parsed.type).toBe('PONG');

      ws.close();
    });
  });
});
