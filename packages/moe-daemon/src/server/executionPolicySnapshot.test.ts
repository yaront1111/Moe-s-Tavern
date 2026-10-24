// =============================================================================
// CQ-M01c over the real plugin /ws endpoint. A board client can neither forge
// nor erase Task.executionPolicySnapshot (the UPDATE_TASK denylist drops it
// before the store sees it; createTask never copies it), and a strict approval
// is refused with an ERROR frame before any write or broadcast. The snapshot is
// configuration identity only: no case here reads it as approval.
// =============================================================================

import { describe, it, expect, afterEach, vi } from 'vitest';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import WebSocket from 'ws';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { MoeWebSocketServer } from './WebSocketServer.js';
import { McpAdapter } from './McpAdapter.js';
import { StateManager } from '../state/StateManager.js';
import { activeWaiters } from '../tools/waitForTask.js';
import { activeChatWaiters } from '../tools/chatWait.js';

type Row = Record<string, unknown>;

interface Frame {
  type: string;
  payload?: Row;
  message?: string;
  operation?: string;
  code?: number;
  codeName?: string;
  context?: Row;
}

interface Client {
  frames: Frame[];
  send(type: string, payload: Row): void;
  waitFor(match: (frame: Frame) => boolean): Promise<Frame>;
  flush(): Promise<void>;
}

const STRICT = { version: 2, profile: 'verified-local', planRevision: 1, deliveryPolicy: 'local-branch' };
const LEGACY = { version: 2, profile: 'legacy', planRevision: 1, deliveryPolicy: 'legacy' };
const STEP = { stepId: 'step-1', description: 'Do it', status: 'PENDING', affectedFiles: ['file.ts'] };
const NOW = '2026-10-24T12:00:00.000Z';

let testDir = '';
let state: StateManager;
let httpServer: Server | undefined;
let wsServer: MoeWebSocketServer | undefined;
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.close();
  if (wsServer && !wsServer.closed) await wsServer.close();
  const server = httpServer;
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  state?.clearEmitter();
  for (const waiter of activeWaiters.values()) clearTimeout(waiter.timer);
  activeWaiters.clear();
  for (const waiter of activeChatWaiters.values()) clearTimeout(waiter.timer);
  activeChatWaiters.clear();
  vi.restoreAllMocks();
  if (testDir) fs.rmSync(testDir, { recursive: true, force: true });
  testDir = '';
  httpServer = undefined;
  wsServer = undefined;
});

function writeJson(relative: string, value: unknown): void {
  fs.writeFileSync(path.join(testDir, '.moe', relative), JSON.stringify(value, null, 2));
}

/** A temp .moe with one raw task row (strict rows can only exist hand-seeded), served as in production. */
async function boot(task: Row): Promise<void> {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moe-ws-snapshot-'));
  for (const dir of ['epics', 'tasks', 'workers', 'proposals']) {
    fs.mkdirSync(path.join(testDir, '.moe', dir), { recursive: true });
  }
  writeJson('project.json', {
    id: 'proj-test',
    name: 'Test Project',
    rootPath: testDir,
    globalRails: { techStack: [], forbiddenPatterns: [], requiredPatterns: [], formatting: '', testing: '', customRules: [] },
    settings: {
      approvalMode: 'CONTROL',
      speedModeDelayMs: 2000,
      autoCreateBranch: true,
      branchPattern: 'moe/{epicId}/{taskId}',
      commitPattern: 'feat({epicId}): {taskTitle}',
      agentCommand: 'claude',
    },
    createdAt: NOW,
    updatedAt: NOW,
  });
  writeJson('epics/epic-1.json', {
    id: 'epic-1', projectId: 'proj-test', title: 'Test Epic', description: '', architectureNotes: '',
    epicRails: [], status: 'ACTIVE', order: 1, createdAt: NOW, updatedAt: NOW,
  });
  writeJson('tasks/task-1.json', {
    id: 'task-1', epicId: 'epic-1', title: 'Test Task', description: 'Test description', definitionOfDone: [],
    taskRails: [], implementationPlan: [], status: 'WORKING', assignedWorkerId: null, branch: null, prLink: null,
    reopenCount: 0, reopenReason: null, createdBy: 'HUMAN', parentTaskId: null, order: 1, comments: [],
    planRevision: 1, createdAt: NOW, updatedAt: NOW, ...task,
  });
  state = new StateManager({ projectPath: testDir });
  await state.load();
  const server = createServer();
  httpServer = server;
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const ws = new MoeWebSocketServer(server, state, new McpAdapter(state));
  wsServer = ws;
  // The production wiring (index.ts): every state event is broadcast to plugin clients.
  state.setEmitter((event) => ws.broadcast(event));
}

async function connect(): Promise<Client> {
  const port = (httpServer?.address() as AddressInfo).port;
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  sockets.push(socket);
  const frames: Frame[] = [];
  let wake: (() => void) | null = null;
  socket.on('message', (data) => {
    frames.push(JSON.parse(data.toString()) as Frame);
    wake?.();
  });
  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve());
    socket.once('error', reject);
  });
  let cursor = 0;
  async function waitFor(match: (frame: Frame) => boolean, timeoutMs = 5000): Promise<Frame> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const index = frames.findIndex((frame, i) => i >= cursor && match(frame));
      if (index >= 0) {
        cursor = index + 1;
        return frames[index];
      }
      if (Date.now() >= deadline) throw new Error('expected frame never arrived');
      await new Promise<void>((resolve) => {
        wake = resolve;
        setTimeout(resolve, 50);
      });
      wake = null;
    }
  }
  const client: Client = {
    frames,
    send: (type, payload) => socket.send(JSON.stringify({ type, payload })),
    waitFor,
    // PONG is answered synchronously, so once it arrives every frame the server
    // sent before reading the PING has arrived too: one ordered socket.
    flush: async () => {
      socket.send(JSON.stringify({ type: 'PING' }));
      await waitFor((frame) => frame.type === 'PONG');
    },
  };
  await waitFor((frame) => frame.type === 'STATE_SNAPSHOT');
  return client;
}

const fileBytes = (id = 'task-1') => fs.readFileSync(path.join(testDir, '.moe', 'tasks', `${id}.json`), 'utf8');
const fileRow = (id = 'task-1') => JSON.parse(fileBytes(id)) as Row;
const hasSnapshotKey = (value: object) => Object.prototype.hasOwnProperty.call(value, 'executionPolicySnapshot');
const rowUpdates = (client: Client) =>
  client.frames.filter((frame) => frame.type === 'TASK_UPDATED' && frame.payload?.id === 'task-1');

/** Send UPDATE_TASK, wait for its outcome, then flush so the reply and the broadcast are both in. */
async function update(client: Client, updates: Row): Promise<Frame[]> {
  client.send('UPDATE_TASK', { taskId: 'task-1', updates });
  await client.waitFor((frame) => frame.type === 'TASK_UPDATED' || frame.type === 'ERROR');
  await client.flush();
  return rowUpdates(client);
}

/** The stored row, its file and every TASK_UPDATED frame agree on the snapshot (absent = no key). */
function expectSnapshotEverywhere(expected: unknown, frames: Frame[]): void {
  const stored = state.getTask('task-1');
  if (!stored) throw new Error('fixture task missing');
  if (expected === undefined) {
    expect(hasSnapshotKey(stored)).toBe(false);
    expect(hasSnapshotKey(fileRow())).toBe(false);
  } else {
    expect(stored.executionPolicySnapshot).toEqual(expected);
    expect(fileRow().executionPolicySnapshot).toEqual(expected);
  }
  expect(frames.length).toBeGreaterThan(0);
  for (const frame of frames) expect(frame.payload?.executionPolicySnapshot).toEqual(expected);
}

describe('UPDATE_TASK cannot forge or erase the snapshot', () => {
  it.each([
    ['a forged STRICT snapshot', STRICT],
    ['an explicit null', null],
  ])('W1 the denylist drops %s before the store sees it', async (_label, forged) => {
    await boot({ executionPolicySnapshot: LEGACY });
    const client = await connect();
    const forwarded = vi.spyOn(state, 'updateTask');

    const frames = await update(client, { title: 'Renamed', executionPolicySnapshot: forged });

    expect(forwarded).toHaveBeenCalledTimes(1);
    const updates = forwarded.mock.calls[0][1] as Row;
    expect(updates.title).toBe('Renamed');
    expect(hasSnapshotKey(updates)).toBe(false);
    expect(state.getTask('task-1')?.title).toBe('Renamed');
    expectSnapshotEverywhere(LEGACY, frames);
  });

  it.each([
    ['deleted', undefined],
    ['replaced', STRICT],
  ])('W2 a full-task echo with the snapshot %s keeps the stored one', async (_label, replacement) => {
    await boot({ executionPolicySnapshot: LEGACY });
    const client = await connect();
    const echo: Row = { ...structuredClone(state.getTask('task-1')), title: 'Echoed' };
    if (replacement === undefined) delete echo.executionPolicySnapshot;
    else echo.executionPolicySnapshot = replacement;

    const frames = await update(client, echo);

    expect(state.getTask('task-1')?.title).toBe('Echoed');
    expectSnapshotEverywhere(LEGACY, frames);
  });

  it('W3 a forged snapshot on a row without one stays absent', async () => {
    await boot({});
    const client = await connect();

    const frames = await update(client, { title: 'Renamed', executionPolicySnapshot: STRICT });

    expect(state.getTask('task-1')?.title).toBe('Renamed');
    expectSnapshotEverywhere(undefined, frames);
  });
});

it('W4 CREATE_TASK never persists a client snapshot or planRevision', async () => {
  await boot({});
  const client = await connect();

  client.send('CREATE_TASK', { epicId: 'epic-1', title: 'Created', executionPolicySnapshot: STRICT, planRevision: 9 });
  const created = await client.waitFor((frame) => frame.type === 'TASK_CREATED' || frame.type === 'ERROR');

  expect(created.type).toBe('TASK_CREATED');
  const payload = created.payload ?? {};
  expect(hasSnapshotKey(payload)).toBe(false);
  expect(payload.planRevision).toBe(0);
  const file = fileRow(String(payload.id));
  expect(hasSnapshotKey(file)).toBe(false);
  expect(file.planRevision).toBe(0);
});

describe('a strict approval is refused before any write', () => {
  const AWAITING = { status: 'AWAITING_APPROVAL', implementationPlan: [STEP] };

  it.each([
    { name: 'APPROVE_TASK without a token', type: 'APPROVE_TASK', payload: { taskId: 'task-1' } },
    { name: 'APPROVE_TASK with the current token', type: 'APPROVE_TASK', payload: { taskId: 'task-1', expectedPlanRevision: 1 } },
    { name: 'the UPDATE_TASK drag to WORKING', type: 'UPDATE_TASK', payload: { taskId: 'task-1', updates: { status: 'WORKING' } } },
  ])('W5 $name answers EXECUTION_PROFILE_NOT_READY', async ({ type, payload }) => {
    await boot({ ...AWAITING, executionPolicySnapshot: STRICT });
    const client = await connect();
    const before = fileBytes();

    client.send(type, payload);
    const error = await client.waitFor((frame) => frame.type === 'ERROR' || frame.type === 'TASK_UPDATED');
    await client.flush();

    expect(error).toMatchObject({ type: 'ERROR', operation: type, code: -32003, codeName: 'EXECUTION_PROFILE_NOT_READY' });
    // Only allowlisted context crosses /ws: the capability list stays server-side.
    expect(error.context).toEqual({ taskId: 'task-1' });
    expect(fileBytes()).toBe(before);
    expect(rowUpdates(client)).toEqual([]);
    expect(state.getTask('task-1')?.status).toBe('AWAITING_APPROVAL');
    expect(state.getTask('task-1')?.planApprovedAt).toBeUndefined();
  });

  it('W5 control: the same approval on a legacy-snapshotted row lands and keeps the snapshot', async () => {
    await boot({ ...AWAITING, executionPolicySnapshot: LEGACY });
    const client = await connect();

    client.send('APPROVE_TASK', { taskId: 'task-1', expectedPlanRevision: 1 });
    const reply = await client.waitFor((frame) => frame.type === 'ERROR' || frame.type === 'TASK_UPDATED');
    await client.flush();

    expect(reply.type).toBe('TASK_UPDATED');
    expect(state.getTask('task-1')?.status).toBe('WORKING');
    expectSnapshotEverywhere(LEGACY, rowUpdates(client));
  });
});
