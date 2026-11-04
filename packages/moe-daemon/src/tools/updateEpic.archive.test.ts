import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer, type Server } from 'http';
import WebSocket from 'ws';
import fs from 'fs';
import path from 'path';
import { ToolTestHarness } from './toolTestHarness.js';
import { flushActivityLog } from '../state/activityLog.js';
import { updateEpicTool } from './updateEpic.js';
import { createTaskTool } from './createTask.js';
import { MoeWebSocketServer } from '../server/WebSocketServer.js';
import { McpAdapter } from '../server/McpAdapter.js';
import type { ActivityEvent, TaskStatus } from '../types/schema.js';

type Frame = { type: string; payload?: { title?: string; status?: string } };

// task-625c7cfe: moving an epic to ARCHIVED through moe.update_epic or the board's
// /ws UPDATE_EPIC (both plugins' epic status combo offers Archived) follows
// moe.archive_epic instead of writing the status alone.
describe('update_epic and /ws UPDATE_EPIC status ARCHIVED follow archive_epic', () => {
  const h = new ToolTestHarness();
  let http: Server | null = null;
  let wss: MoeWebSocketServer | null = null;
  const sockets: WebSocket[] = [];

  beforeEach(() => { h.init(); h.setupMoeFolder(); h.createEpic({ id: 'epic-1', status: 'ACTIVE' }); });
  afterEach(async () => {
    for (const s of sockets.splice(0)) s.close();
    if (wss && !wss.closed) await wss.close();
    if (http) { const server = http; await new Promise<void>((r) => server.close(() => r())); }
    wss = null; http = null;
    h.cleanup();
  });

  const read = (kind: 'epics' | 'tasks', id: string): string => fs.readFileSync(path.join(h.moePath, kind, `${id}.json`), 'utf8');
  const update = (args: Record<string, unknown>) => updateEpicTool(h.state).handler({ epicId: 'epic-1', ...args }, h.state);
  async function archivedIds(): Promise<string[]> {
    await flushActivityLog(h.state);
    return h.state.getActivityLog(200).filter((e: ActivityEvent) => e.event === 'TASK_ARCHIVED').map((e) => e.taskId ?? '').sort();
  }
  // Sends one UPDATE_EPIC with the JetBrains EpicDetailDialog Save shape (every field, every time)
  // and resolves with the ERROR frame or the EPIC_UPDATED frame that carries `title` and ARCHIVED.
  async function wsUpdate(title: string): Promise<Frame> {
    const server = createServer();
    http = server;
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    wss = new MoeWebSocketServer(server, h.state, new McpAdapter(h.state));
    const ws = new WebSocket(`ws://127.0.0.1:${(server.address() as { port: number }).port}/ws`);
    sockets.push(ws);
    await new Promise<void>((resolve, reject) => { ws.once('open', () => resolve()); ws.once('error', reject); });
    const reply = new Promise<Frame>((resolve) => {
      ws.on('message', (data) => {
        const frame = JSON.parse(data.toString()) as Frame;
        if (frame.type === 'ERROR' || (frame.type === 'EPIC_UPDATED' && frame.payload?.title === title && frame.payload?.status === 'ARCHIVED')) resolve(frame);
      });
    });
    ws.send(JSON.stringify({ type: 'UPDATE_EPIC', payload: { epicId: 'epic-1', updates: { title, description: '', architectureNotes: '', epicRails: [], status: 'ARCHIVED' } } }));
    return reply;
  }

  it.each(['PLANNING', 'AWAITING_APPROVAL', 'WORKING'] as TaskStatus[])('(m1) update_epic refuses while a task is %s and writes nothing', async (status) => {
    h.createTask({ id: 'task-live', status, assignedWorkerId: 'worker-1' });
    h.createTask({ id: 'task-rest', status: 'BACKLOG', order: 2 });
    await h.state.load();
    const before = [read('epics', 'epic-1'), read('tasks', 'task-live'), read('tasks', 'task-rest')];
    await expect(update({ status: 'ARCHIVED', title: 'Renamed', workerId: 'worker-1' })).rejects.toMatchObject({ codeName: 'NOT_ALLOWED' });
    expect([read('epics', 'epic-1'), read('tasks', 'task-live'), read('tasks', 'task-rest')]).toEqual(before);
    expect(await archivedIds()).toEqual([]);
    // The live row's worker can still file a card into its own epic.
    await expect(createTaskTool(h.state).handler({ epicId: 'epic-1', title: 'bug: found while working', workerId: 'worker-1' }, h.state))
      .resolves.toMatchObject({ success: true });
  });

  it('(m2) update_epic archives a quiescent epic and every task, then applies the other fields', async () => {
    h.createTask({ id: 'task-backlog', status: 'BACKLOG' });
    h.createTask({ id: 'task-review', status: 'REVIEW', order: 2 });
    h.createTask({ id: 'task-done', status: 'DONE', order: 3 });
    h.createTask({ id: 'task-archived', status: 'ARCHIVED', order: 4 });
    await h.state.load();
    await expect(update({ status: 'ARCHIVED', title: 'Renamed', description: 'Shelved', workerId: 'architect-1' }))
      .resolves.toMatchObject({ success: true, epic: { status: 'ARCHIVED', title: 'Renamed', description: 'Shelved' } });
    expect(h.state.getEpic('epic-1')).toMatchObject({ status: 'ARCHIVED', title: 'Renamed', description: 'Shelved' });
    for (const id of ['task-backlog', 'task-review', 'task-done', 'task-archived']) expect(h.state.getTask(id)!.status).toBe('ARCHIVED');
    expect(await archivedIds()).toEqual(['task-backlog', 'task-done', 'task-review']);
  });

  it('(m3) update_epic applies the archive_epic holder rule to a BLOCKED row another worker holds', async () => {
    const now = new Date().toISOString();
    h.createTask({ id: 'task-held', status: 'BLOCKED', assignedWorkerId: 'worker-b', blockedFromStatus: 'WORKING', blockedAt: now, blockedReason: 'waiting on a lease' });
    await h.state.load();
    const before = [read('epics', 'epic-1'), read('tasks', 'task-held')];
    await expect(update({ status: 'ARCHIVED', workerId: 'worker-a' })).rejects.toMatchObject({ codeName: 'NOT_ALLOWED' });
    expect([read('epics', 'epic-1'), read('tasks', 'task-held')]).toEqual(before);
    await update({ status: 'ARCHIVED', workerId: 'worker-b' });
    expect(h.state.getTask('task-held')!.status).toBe('ARCHIVED');
    expect(h.state.getEpic('epic-1')!.status).toBe('ARCHIVED');
  });

  it('(m4) every other update stays a plain write: another status move, and an epic already ARCHIVED', async () => {
    h.createTask({ id: 'task-live', status: 'WORKING', assignedWorkerId: 'worker-1' });
    await h.state.load();
    await update({ status: 'COMPLETED' });
    expect(h.state.getEpic('epic-1')!.status).toBe('COMPLETED');
    await h.state.updateEpic('epic-1', { status: 'ARCHIVED' }); // an epic archived before this fix
    await update({ status: 'ARCHIVED', title: 'Renamed' });
    expect(h.state.getEpic('epic-1')).toMatchObject({ status: 'ARCHIVED', title: 'Renamed' });
    expect(h.state.getTask('task-live')!.status).toBe('WORKING');
    expect(await archivedIds()).toEqual([]);
  });

  it('(m5) update_epic refuses an invalid companion field before any write', async () => {
    h.createTask({ id: 'task-rest', status: 'BACKLOG' });
    await h.state.load();
    const before = [read('epics', 'epic-1'), read('tasks', 'task-rest')];
    await expect(update({ status: 'ARCHIVED', order: -1 })).rejects.toThrow(/order/);
    expect([read('epics', 'epic-1'), read('tasks', 'task-rest')]).toEqual(before);
  });

  it('(w1) /ws UPDATE_EPIC answers an ERROR frame while a task is in flight and writes nothing', async () => {
    h.createTask({ id: 'task-live', status: 'WORKING', assignedWorkerId: 'worker-1' });
    await h.state.load();
    const before = [read('epics', 'epic-1'), read('tasks', 'task-live')];
    expect(await wsUpdate('Test Epic')).toMatchObject({ type: 'ERROR', operation: 'UPDATE_EPIC', codeName: 'NOT_ALLOWED' });
    expect([read('epics', 'epic-1'), read('tasks', 'task-live')]).toEqual(before);
  });

  it('(w2) /ws UPDATE_EPIC archives a quiescent epic and its tasks and applies the other fields', async () => {
    h.createTask({ id: 'task-backlog', status: 'BACKLOG' });
    await h.state.load();
    expect(await wsUpdate('Renamed')).toMatchObject({ type: 'EPIC_UPDATED', payload: { status: 'ARCHIVED', title: 'Renamed' } });
    expect(h.state.getTask('task-backlog')!.status).toBe('ARCHIVED');
    expect(await archivedIds()).toEqual(['task-backlog']);
  });
});
