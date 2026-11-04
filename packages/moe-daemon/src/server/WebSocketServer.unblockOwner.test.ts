// Board moves keep only genuine two-pointer holds, just like set_task_status
// and the automatic unblocks. An IDLE seat with no pointer must not strand work.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer, type Server } from 'http';
import WebSocket from 'ws';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { MoeWebSocketServer } from './WebSocketServer.js';
import { StateManager } from '../state/StateManager.js';
import { McpAdapter } from './McpAdapter.js';

type Frame = { type: string; message?: string; payload?: { id?: string } };

describe('/ws UPDATE_TASK BLOCKED -> blockedFromStatus keeps only a genuine hold', () => {
  let dir: string;
  let state: StateManager;
  let http: Server;
  let wss: MoeWebSocketServer;
  let port = 0;
  const sockets: WebSocket[] = [];
  const now = new Date().toISOString();
  const write = (sub: string, id: string, body: Record<string, unknown>) =>
    fs.writeFileSync(path.join(dir, '.moe', sub, `${id}.json`), JSON.stringify(body));
  const task = (id: string, assignedWorkerId: string) => ({
    id, epicId: 'epic-1', title: id, description: '', definitionOfDone: [], taskRails: [], implementationPlan: [],
    status: 'BLOCKED', assignedWorkerId, branch: null, prLink: null, reopenCount: 0, reopenReason: null,
    createdBy: 'HUMAN', parentTaskId: null, order: 1, createdAt: now, updatedAt: now,
    blockedFromStatus: 'WORKING', blockedAt: now, blockedReason: 'waiting for gpu-box', blockedResourceId: 'gpu-box',
  });
  const worker = (id: string, status: string, currentTaskId: string | null) => ({
    id, type: 'CLAUDE', projectId: 'proj-test', epicId: 'epic-1', currentTaskId, status, teamId: null, branch: 'main',
    modifiedFiles: [], startedAt: now, lastActivityAt: now, lastError: null, errorCount: 0,
  });

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moe-ws-unblock-owner-'));
    for (const sub of ['epics', 'tasks', 'workers', 'proposals']) fs.mkdirSync(path.join(dir, '.moe', sub), { recursive: true });
    fs.writeFileSync(path.join(dir, '.moe', 'project.json'), JSON.stringify({
      id: 'proj-test', name: 'T', rootPath: dir,
      globalRails: { techStack: [], forbiddenPatterns: [], requiredPatterns: [], formatting: '', testing: '', customRules: [] },
      settings: { approvalMode: 'TURBO', speedModeDelayMs: 2000, autoCreateBranch: true, branchPattern: 'moe/{epicId}/{taskId}', commitPattern: 'x', agentCommand: 'claude' },
      createdAt: now, updatedAt: now,
    }));
    write('epics', 'epic-1', { id: 'epic-1', projectId: 'proj-test', title: 'E', description: '', architectureNotes: '', epicRails: [], status: 'ACTIVE', order: 1, createdAt: now, updatedAt: now });
    write('tasks', 'task-ghost', task('task-ghost', 'worker-gone'));
    write('tasks', 'task-corpse', task('task-corpse', 'worker-idle'));
    write('workers', 'worker-idle', worker('worker-idle', 'IDLE', null));
    write('tasks', 'task-dead', task('task-dead', 'worker-dead'));
    write('workers', 'worker-dead', worker('worker-dead', 'DEAD', 'task-dead'));
    write('tasks', 'task-held', task('task-held', 'worker-held'));
    write('workers', 'worker-held', worker('worker-held', 'BLOCKED', 'task-held'));
    write('tasks', 'task-idle-held', task('task-idle-held', 'worker-idle-held'));
    write('workers', 'worker-idle-held', worker('worker-idle-held', 'IDLE', 'task-idle-held'));
    state = new StateManager({ projectPath: dir });
    await state.load();
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

  async function move(taskId: string): Promise<Frame> {
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
    socket.send(JSON.stringify({ type: 'UPDATE_TASK', payload: { taskId, updates: { status: 'WORKING' } } }));
    return until((frame) => frame.type === 'ERROR' || (frame.type === 'TASK_UPDATED' && frame.payload?.id === taskId));
  }

  it('returns the row unassigned and claimable unless its assignee still holds it', async () => {
    const got: Record<string, unknown> = {};
    for (const id of ['task-ghost', 'task-corpse', 'task-dead', 'task-held', 'task-idle-held']) {
      const reply = await move(id);
      const updated = state.getTask(id)!;
      got[id] = {
        reply: reply.type, status: updated.status, assignedWorkerId: updated.assignedWorkerId,
        claimable: state.isTaskClaimable(updated), blockedFromStatus: updated.blockedFromStatus,
      };
    }
    expect(got).toEqual({
      'task-ghost': { reply: 'TASK_UPDATED', status: 'WORKING', assignedWorkerId: null, claimable: true, blockedFromStatus: null },
      'task-corpse': { reply: 'TASK_UPDATED', status: 'WORKING', assignedWorkerId: null, claimable: true, blockedFromStatus: null },
      'task-dead': { reply: 'TASK_UPDATED', status: 'WORKING', assignedWorkerId: null, claimable: true, blockedFromStatus: null },
      'task-held': { reply: 'TASK_UPDATED', status: 'WORKING', assignedWorkerId: 'worker-held', claimable: false, blockedFromStatus: null },
      'task-idle-held': { reply: 'TASK_UPDATED', status: 'WORKING', assignedWorkerId: 'worker-idle-held', claimable: false, blockedFromStatus: null },
    });
  });
});
