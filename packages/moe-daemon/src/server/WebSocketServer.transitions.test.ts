import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer, type Server } from 'http';
import WebSocket from 'ws';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { MoeWebSocketServer } from './WebSocketServer.js';
import { StateManager } from '../state/StateManager.js';
import { McpAdapter } from './McpAdapter.js';
import { setTaskStatusTool, VALID_TRANSITIONS } from '../tools/setTaskStatus.js';
import type { TaskStatus } from '../types/schema.js';

// The board's /ws UPDATE_TASK and moe.set_task_status must judge every move by
// the same table. 53271caf added BACKLOG -> REVIEW to set_task_status only, and
// the /ws copy refused it for months.
const STATUSES = Object.keys(VALID_TRANSITIONS) as TaskStatus[];
const PAIRS = STATUSES.flatMap((from) =>
  STATUSES.filter((to) => to !== from).map((to) => [from, to] as const));
// /ws routes AWAITING_APPROVAL -> WORKING through plan approval, which needs a
// CLIENT_HELLO and the plan-revision token. Only the table verdict is compared there.
const WS_APPROVAL_ROUTE = 'AWAITING_APPROVAL->WORKING';

type Frame = { type: string; message?: string; payload?: { id?: string; status?: string } };
type Verdict = 'ok' | 'table-refused' | 'other-refused';

describe('/ws UPDATE_TASK and moe.set_task_status share one transition table', () => {
  let dir: string;
  let state: StateManager;
  let http: Server;
  let wss: MoeWebSocketServer;
  let port = 0;
  const sockets: WebSocket[] = [];

  function writeTask(id: string, status: TaskStatus, extra: Record<string, unknown> = {}): void {
    const now = new Date().toISOString();
    fs.writeFileSync(path.join(dir, '.moe', 'tasks', `${id}.json`), JSON.stringify({
      id, epicId: 'epic-1', title: id, description: '', definitionOfDone: [], taskRails: [],
      implementationPlan: [], status, assignedWorkerId: null, branch: null, prLink: null,
      reopenCount: 0, reopenReason: null, createdBy: 'HUMAN', parentTaskId: null, order: 1,
      createdAt: now, updatedAt: now,
      // A BLOCKED exit is judged against blockedFromStatus; WORKING makes every
      // move the table allows out of BLOCKED pass that second gate on both paths.
      ...(status === 'BLOCKED' ? { blockedFromStatus: 'WORKING', blockedAt: now, blockedReason: 'fixture' } : {}),
      ...extra,
    }));
  }

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moe-ws-transitions-'));
    const moe = path.join(dir, '.moe');
    for (const sub of ['epics', 'tasks', 'workers', 'proposals']) fs.mkdirSync(path.join(moe, sub), { recursive: true });
    const now = new Date().toISOString();
    // TURBO with no columnLimits: set_task_status's only other gates (CONTROL
    // plan approval, WIP limits) stay out of the comparison.
    fs.writeFileSync(path.join(moe, 'project.json'), JSON.stringify({
      id: 'proj-test', name: 'T', rootPath: dir,
      globalRails: { techStack: [], forbiddenPatterns: [], requiredPatterns: [], formatting: '', testing: '', customRules: [] },
      settings: { approvalMode: 'TURBO', speedModeDelayMs: 2000, autoCreateBranch: true,
        branchPattern: 'moe/{epicId}/{taskId}', commitPattern: 'x', agentCommand: 'claude' },
      createdAt: now, updatedAt: now,
    }));
    fs.writeFileSync(path.join(moe, 'epics', 'epic-1.json'), JSON.stringify({
      id: 'epic-1', projectId: 'proj-test', title: 'E', description: '', architectureNotes: '',
      epicRails: [], status: 'ACTIVE', order: 1, createdAt: now, updatedAt: now,
    }));
    for (const [from, to] of PAIRS) {
      writeTask(`ws-${from}-${to}`, from);
      writeTask(`mcp-${from}-${to}`, from);
    }
    writeTask('task-backlog', 'BACKLOG');
    writeTask('task-backlog-2', 'BACKLOG');
    writeTask('task-parked-backlog', 'BACKLOG', { needsHumanReview: true });
    writeTask('task-parked-blocked', 'BLOCKED', { needsHumanReview: true, blockedFromStatus: 'REVIEW' });
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

  // A /ws client that buffers every frame, so none is lost between awaits.
  async function connect() {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    sockets.push(socket);
    const frames: Frame[] = [];
    let wake: (() => void) | null = null;
    socket.on('message', (data) => { frames.push(JSON.parse(data.toString()) as Frame); wake?.(); });
    await new Promise<void>((resolve) => socket.once('open', () => resolve()));
    async function waitFor(match: (f: Frame) => boolean, timeoutMs = 5000): Promise<Frame> {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const i = frames.findIndex(match);
        if (i >= 0) return frames.splice(i, 1)[0];
        const left = deadline - Date.now();
        if (left <= 0) throw new Error(`no matching frame within ${timeoutMs}ms`);
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, left);
          wake = () => { clearTimeout(t); wake = null; resolve(); };
        });
      }
    }
    await waitFor((f) => f.type === 'STATE_SNAPSHOT');
    // The direct reply to one UPDATE_TASK: its TASK_UPDATED, or an ERROR.
    async function move(taskId: string, status: string): Promise<Frame> {
      socket.send(JSON.stringify({ type: 'UPDATE_TASK', payload: { taskId, updates: { status } } }));
      return waitFor((f) => f.type === 'ERROR' || (f.type === 'TASK_UPDATED' && f.payload?.id === taskId));
    }
    return { move, waitFor };
  }

  it('gives every (from, to) pair the same table verdict on /ws as on set_task_status', async () => {
    const client = await connect();
    const tool = setTaskStatusTool(state);
    const mismatches: string[] = [];
    for (const [from, to] of PAIRS) {
      const allowed = VALID_TRANSITIONS[from].includes(to);
      let mcp: Verdict = 'ok';
      try {
        await tool.handler({ taskId: `mcp-${from}-${to}`, status: to }, state);
      } catch (err) {
        mcp = (err as Error).message.includes(`${from} -> ${to}. Allowed transitions from ${from}:`)
          ? 'table-refused' : 'other-refused';
      }
      const reply = await client.move(`ws-${from}-${to}`, to);
      const ws: Verdict = reply.type === 'TASK_UPDATED' ? 'ok'
        : reply.message?.startsWith(`Cannot move task from ${from} to ${to}. Allowed:`) ? 'table-refused'
          : 'other-refused';
      const expected: Verdict = allowed ? 'ok' : 'table-refused';
      const wsAgrees = `${from}->${to}` === WS_APPROVAL_ROUTE ? ws !== 'table-refused' : ws === expected;
      const exactText = allowed
        || reply.message === `Cannot move task from ${from} to ${to}. Allowed: ${VALID_TRANSITIONS[from].join(', ')}`;
      if (mcp !== expected || !wsAgrees || !exactText) {
        mismatches.push(`${from} -> ${to}: table ${allowed ? 'allows' : 'refuses'}, set_task_status ${mcp}, /ws ${ws}${reply.message ? ` (${reply.message})` : ''}`);
      }
    }
    expect(mismatches).toEqual([]);
  });

  it('moves a BACKLOG task to REVIEW over /ws, broadcasts it, and still refuses BACKLOG -> DONE', async () => {
    state.setEmitter((event) => wss.broadcast(event));
    const actor = await connect();
    const observer = await connect();

    const reply = await actor.move('task-backlog', 'REVIEW');
    expect(reply).toMatchObject({ type: 'TASK_UPDATED', payload: { id: 'task-backlog', status: 'REVIEW' } });
    expect(state.getTask('task-backlog')?.status).toBe('REVIEW');
    await observer.waitFor((f) => f.type === 'TASK_UPDATED' && f.payload?.id === 'task-backlog' && f.payload?.status === 'REVIEW');

    expect(await actor.move('task-backlog-2', 'DONE')).toMatchObject({
      type: 'ERROR',
      message: 'Cannot move task from BACKLOG to DONE. Allowed: PLANNING, WORKING, REVIEW, ARCHIVED',
    });
    expect(state.getTask('task-backlog-2')?.status).toBe('BACKLOG');
  });

  it.each(['task-parked-backlog', 'task-parked-blocked'])(
    'a /ws move of %s into REVIEW clears needsHumanReview, as set_task_status does',
    async (taskId) => {
      const client = await connect();
      expect(await client.move(taskId, 'REVIEW')).toMatchObject({ type: 'TASK_UPDATED', payload: { status: 'REVIEW' } });
      expect(state.getTask(taskId)?.status).toBe('REVIEW');
      expect(state.getTask(taskId)?.needsHumanReview).toBe(false);
    },
  );
});
