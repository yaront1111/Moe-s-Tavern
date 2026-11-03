// updateWorkerCursors is the cursor write behind every cursor-mode chat_read and
// chat_wait delivery. For a DEAD record it must behave like touchWorker and
// updateWorker's DEAD arm: persist the cursor, but keep lastActivityAt (the prune
// clock) and never re-publish the seat as WORKER_UPDATED.
import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToolTestHarness } from '../tools/toolTestHarness.js';
import { deregisterWorkerTool } from '../tools/deregisterWorker.js';
import { chatReadTool } from '../tools/chatRead.js';
import { chatWaitTool } from '../tools/chatWait.js';
import { updateWorkerCursors } from './workerStore.js';

type Ev = { type: string; payload?: { id?: string; status?: string; chatCursors?: Record<string, string>; lastActivityAt?: string } };

describe('updateWorkerCursors', () => {
  const h = new ToolTestHarness();
  const workerId = 'worker-gone';
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  let events: Ev[] = [];
  let workersChannelId = '';

  const workerUpdates = (): Ev[] =>
    events.filter((e) => e.type === 'WORKER_UPDATED' && e.payload?.id === workerId);
  const onDisk = (): { chatCursors?: Record<string, string>; lastActivityAt: string } =>
    JSON.parse(fs.readFileSync(path.join(h.moePath, 'workers', `${workerId}.json`), 'utf8'));

  beforeEach(async () => {
    events = [];
    h.init();
    h.setupMoeFolder();
    h.createEpic();
    // startedAt in the past: chat_wait treats messages before it as history.
    h.createWorker({ id: workerId, status: 'IDLE', startedAt: twoHoursAgo, lastActivityAt: twoHoursAgo });
    await h.state.load();
    h.state.setEmitter((e: unknown) => { events.push(e as Ev); });
    vi.spyOn(h.state, 'postToRoleChannel').mockResolvedValue(undefined);
    workersChannelId = Array.from(h.state.channels.values()).find((c) => c.name === 'workers')!.id;
  });
  afterEach(() => {
    h.state.clearEmitter();
    vi.restoreAllMocks();
    h.cleanup();
  });

  async function deregisterAndPost(): Promise<string> {
    await deregisterWorkerTool(h.state).handler({ workerId, reason: 'terminal_closed' }, h.state);
    const dead = h.state.getWorker(workerId)!;
    expect(dead.status).toBe('DEAD');
    expect(dead.lastActivityAt).toBe(twoHoursAgo);
    const { message } = await h.state.sendMessage({ channel: workersChannelId, sender: 'human', content: 'anyone still on task-1?' });
    events.length = 0;
    return message.id;
  }

  async function expectDeadUntouched(messageId: string): Promise<void> {
    const after = h.state.getWorker(workerId)!;
    expect(after.status).toBe('DEAD');
    expect(after.lastActivityAt).toBe(twoHoursAgo);
    expect(workerUpdates()).toEqual([]);
    // The advanced cursor is persisted, in memory and on disk, so a revival is not re-delivered.
    expect(after.chatCursors?.[workersChannelId]).toBe(messageId);
    const disk = onDisk();
    expect(disk.chatCursors?.[workersChannelId]).toBe(messageId);
    expect(disk.lastActivityAt).toBe(twoHoursAgo);
    // The Layer-3 prune still comes due.
    h.state.staleWorkerTimeoutMs = 30 * 60 * 1000;
    await h.state.checkBlockedTimeouts();
    expect(h.state.getWorker(workerId)).toBeNull();
  }

  it('1. a DEAD worker reading chat keeps its prune clock, stays off the board, and is still pruned', async () => {
    const messageId = await deregisterAndPost();
    const read = await chatReadTool(h.state).handler({ channel: '#workers', workerId }, h.state) as { messages: Array<{ id: string }> };
    expect(read.messages.map((m) => m.id)).toEqual([messageId]);
    await expectDeadUntouched(messageId);
  });

  it('2. a chat_wait backlog delivery to a DEAD worker does the same', async () => {
    const messageId = await deregisterAndPost();
    const res = await chatWaitTool(h.state).handler(
      { workerId, channels: [workersChannelId], timeoutMs: 2000 },
      h.state
    ) as { hasMessage: boolean; messages?: Array<{ id: string }> };
    expect(res.hasMessage).toBe(true);
    expect(res.messages?.map((m) => m.id)).toEqual([messageId]);
    await expectDeadUntouched(messageId);
  });

  it('3. a live worker still merges the cursor, refreshes lastActivityAt and emits one WORKER_UPDATED', async () => {
    await updateWorkerCursors(h.state, workerId, { 'chan-earlier': 'msg-earlier' });
    events.length = 0;
    const { message } = await h.state.sendMessage({ channel: workersChannelId, sender: 'human', content: 'hello' });
    events.length = 0;

    // Direct call: chat_read also heartbeats via touchWorker, a second, separate WORKER_UPDATED.
    await updateWorkerCursors(h.state, workerId, { [workersChannelId]: message.id });

    const after = h.state.getWorker(workerId)!;
    expect(after.chatCursors).toEqual({ 'chan-earlier': 'msg-earlier', [workersChannelId]: message.id });
    expect(Date.parse(after.lastActivityAt)).toBeGreaterThan(Date.parse(twoHoursAgo));
    const updates = workerUpdates();
    expect(updates).toHaveLength(1);
    expect(updates[0].payload?.chatCursors).toEqual(after.chatCursors);
    expect(updates[0].payload?.lastActivityAt).toBe(after.lastActivityAt);
  });

  it('4. an unknown worker is a silent skip: no file written, nothing emitted', async () => {
    await expect(updateWorkerCursors(h.state, 'worker-nobody', { c: 'm' })).resolves.toBeUndefined();
    expect(fs.existsSync(path.join(h.moePath, 'workers', 'worker-nobody.json'))).toBe(false);
    expect(h.state.getWorker('worker-nobody')).toBeNull();
    expect(events).toEqual([]);
  });
});
