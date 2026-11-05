// A board edit takes a task out of BLOCKED or reopens it as the MCP paths do: an
// unblock drops the task's queue entry on the resource it was blocked on
// (set_task_status, unblock_worker), and a reopen stamps reopenedAt itself.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createServer, type Server } from 'http';
import WebSocket from 'ws';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { MoeWebSocketServer } from './WebSocketServer.js';
import { StateManager } from '../state/StateManager.js';
import { McpAdapter } from './McpAdapter.js';

type Frame = { type: string; message?: string; payload?: { id?: string } };

describe('/ws UPDATE_TASK: board unblock and board reopen', () => {
  let dir: string;
  let state: StateManager;
  let http: Server;
  let wss: MoeWebSocketServer;
  let port = 0;
  const sockets: WebSocket[] = [];
  const now = new Date().toISOString();
  const CLIENT_STAMP = '2000-01-01T00:00:00.000Z';
  const write = (sub: string, id: string, body: Record<string, unknown>) =>
    fs.writeFileSync(path.join(dir, '.moe', sub, `${id}.json`), JSON.stringify(body));
  const task = (id: string, status: string, extra: Record<string, unknown> = {}) => ({
    id, epicId: 'epic-1', title: id, description: '', definitionOfDone: [], taskRails: [], implementationPlan: [],
    status, assignedWorkerId: null, branch: null, prLink: null, reopenCount: 0, reopenReason: null,
    createdBy: 'HUMAN', parentTaskId: null, order: 1, createdAt: now, updatedAt: now, ...extra,
  });
  const blockedOnGpu = (from: string) => ({
    blockedFromStatus: from, blockedAt: now, blockedReason: 'waiting for gpu-box', blockedResourceId: 'gpu-box',
  });

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moe-ws-board-unblock-'));
    for (const sub of ['epics', 'tasks', 'workers', 'proposals']) fs.mkdirSync(path.join(dir, '.moe', sub), { recursive: true });
    fs.writeFileSync(path.join(dir, '.moe', 'project.json'), JSON.stringify({
      id: 'proj-test', name: 'T', rootPath: dir,
      globalRails: { techStack: [], forbiddenPatterns: [], requiredPatterns: [], formatting: '', testing: '', customRules: [] },
      settings: { approvalMode: 'TURBO', speedModeDelayMs: 2000, autoCreateBranch: true, branchPattern: 'moe/{epicId}/{taskId}', commitPattern: 'x', agentCommand: 'claude' },
      createdAt: now, updatedAt: now,
    }));
    write('epics', 'epic-1', { id: 'epic-1', projectId: 'proj-test', title: 'E', description: '', architectureNotes: '', epicRails: [], status: 'ACTIVE', order: 1, createdAt: now, updatedAt: now });
    write('tasks', 'task-holder', task('task-holder', 'WORKING', { assignedWorkerId: 'worker-holder' }));
    write('tasks', 'task-blocked', task('task-blocked', 'BLOCKED', blockedOnGpu('WORKING')));
    write('tasks', 'task-blocked-review', task('task-blocked-review', 'BLOCKED', blockedOnGpu('REVIEW')));
    write('tasks', 'task-done', task('task-done', 'DONE', { completedAt: now }));
    write('tasks', 'task-review', task('task-review', 'REVIEW'));
    write('tasks', 'task-working', task('task-working', 'WORKING'));
    state = new StateManager({ projectPath: dir });
    await state.load();
    // gpu-box has one slot: task-holder holds it, and both blocked tasks wait in its queue.
    for (const id of ['task-holder', 'task-blocked', 'task-blocked-review']) {
      await state.acquireResource({ resourceId: 'gpu-box', taskId: id, workerId: id === 'task-holder' ? 'worker-holder' : 'worker-gone' });
    }
    http = createServer();
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', () => resolve()));
    port = (http.address() as { port: number }).port;
    wss = new MoeWebSocketServer(http, state, new McpAdapter(state));
  });

  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.close();
    if (wss && !wss.closed) await wss.close();
    await new Promise<void>((resolve) => http.close(() => resolve()));
    await state.flushActivityLog();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  async function send(taskId: string, updates: Record<string, unknown>): Promise<Frame> {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    sockets.push(socket);
    const frames: Frame[] = [];
    socket.on('message', (data) => frames.push(JSON.parse(data.toString()) as Frame));
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve());
      socket.once('error', reject);
    });
    const until = async (matches: (frame: Frame) => boolean) => {
      for (let i = 0; i < 500; i++) {
        const frame = frames.find(matches);
        if (frame) return frame;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error('no frame');
    };
    await until((frame) => frame.type === 'STATE_SNAPSHOT');
    socket.send(JSON.stringify({ type: 'UPDATE_TASK', payload: { taskId, updates } }));
    return until((frame) => frame.type === 'ERROR' || (frame.type === 'TASK_UPDATED' && frame.payload?.id === taskId));
  }

  const gpu = () => {
    const resource = state.getResource('gpu-box')!;
    return { holders: resource.holders.map((lease) => lease.taskId), queue: resource.queue.map((entry) => entry.taskId) };
  };

  it('a board unblock drops the task\'s queue entry on the resource it was blocked on, never the holder\'s lease', async () => {
    expect(gpu()).toEqual({ holders: ['task-holder'], queue: ['task-blocked', 'task-blocked-review'] });

    expect(await send('task-blocked', { status: 'WORKING' })).toMatchObject({ type: 'TASK_UPDATED' });
    await vi.waitFor(() => expect(gpu()).toEqual({ holders: ['task-holder'], queue: ['task-blocked-review'] }));

    // Blocked from REVIEW, so the move to WORKING takes the board's reopen route.
    expect(await send('task-blocked-review', { status: 'WORKING' })).toMatchObject({ type: 'TASK_UPDATED' });
    await vi.waitFor(() => expect(gpu()).toEqual({ holders: ['task-holder'], queue: [] }));

    expect(['task-blocked', 'task-blocked-review'].map((id) => [state.getTask(id)?.status, state.getTask(id)?.blockedResourceId]))
      .toEqual([['WORKING', null], ['WORKING', null]]);
  });

  it('a board reopen stamps reopenedAt itself, and a reopenedAt the client sends is stripped', async () => {
    const before = new Date().toISOString();
    for (const id of ['task-done', 'task-review']) {
      expect(await send(id, { status: 'WORKING', reopenedAt: CLIENT_STAMP })).toMatchObject({ type: 'TASK_UPDATED' });
      const reopened = state.getTask(id)!;
      expect([id, reopened.status, reopened.reopenCount, (reopened.reopenedAt ?? '') >= before]).toEqual([id, 'WORKING', 1, true]);
    }

    // Not a reopen: the client's stamp never reaches the task.
    expect(await send('task-working', { title: 'renamed', reopenedAt: CLIENT_STAMP })).toMatchObject({ type: 'TASK_UPDATED' });
    expect([state.getTask('task-working')?.title, state.getTask('task-working')?.reopenedAt]).toEqual(['renamed', undefined]);
  });
});
