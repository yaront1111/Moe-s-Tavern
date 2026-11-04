/**
 * chat_who and chat_join take presence from isWorkerAlive, the predicate
 * list_workers reports as isAlive: not DEAD, and active within the window.
 * A just-deregistered seat (DEAD, recent lastActivityAt) is never listed, and a
 * live IDLE seat always is.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToolTestHarness } from './toolTestHarness.js';
import { deregisterWorkerTool } from './deregisterWorker.js';
import { activeChatWaiters } from './chatWait.js';
import { chatWhoTool } from './chatWho.js';
import { chatJoinTool } from './chatJoin.js';
import { listWorkersTool } from './listWorkers.js';

interface WhoEntry { workerId: string; source: string }
interface ListedWorker { workerId: string; isAlive: boolean }

describe('chat_who / chat_join presence follows isWorkerAlive', () => {
  const h = new ToolTestHarness();
  let generalId: string;

  const who = async (args: Record<string, unknown>): Promise<WhoEntry[]> =>
    ((await chatWhoTool(h.state).handler(args, h.state)) as { online: WhoEntry[] }).online;
  const ids = (entries: Array<{ workerId?: string; id?: string }>): string[] =>
    entries.map((e) => (e.workerId ?? e.id) as string).sort();
  const park = (workerId: string): void => {
    activeChatWaiters.set(workerId, {
      resolve: () => {}, unsubscribe: () => {}, timer: setTimeout(() => {}, 60_000),
      channels: new Set([generalId]),
    });
  };

  beforeEach(async () => {
    const fresh = new Date().toISOString();
    const stale = new Date(Date.now() - 5 * 60_000).toISOString();
    h.init(); h.setupMoeFolder(); h.createEpic();
    h.createWorker({ id: 'worker-closed', status: 'CODING', lastActivityAt: fresh });
    h.createWorker({ id: 'worker-idle', status: 'IDLE', lastActivityAt: fresh });
    h.createWorker({ id: 'worker-busy', status: 'CODING', lastActivityAt: fresh });
    h.createWorker({ id: 'worker-stale', status: 'CODING', lastActivityAt: stale });
    h.createWorker({ id: 'worker-joiner', status: 'READING_CONTEXT', lastActivityAt: fresh });
    await h.state.load();
    vi.spyOn(h.state, 'postToRoleChannel').mockResolvedValue(undefined);
    generalId = Array.from(h.state.channels.values()).find((c) => c.type === 'general')!.id;
    for (const id of ['worker-closed', 'worker-idle', 'worker-stale']) {
      h.state.workers.get(id)!.chatCursors = { [generalId]: 'msg-1' };
    }
    await deregisterWorkerTool(h.state).handler({ workerId: 'worker-closed', reason: 'terminal_closed' }, h.state);
    // After the deregister, which may cancel a live waiter itself.
    park('worker-closed');
    park('worker-stale');
  });

  afterEach(() => {
    for (const waiter of activeChatWaiters.values()) clearTimeout(waiter.timer);
    activeChatWaiters.clear();
    h.state.clearEmitter();
    vi.restoreAllMocks();
    h.cleanup();
  });

  it('keeps the deregistered seat DEAD with a recent lastActivityAt (fixture sanity)', () => {
    const dead = h.state.workers.get('worker-closed')!;
    expect(dead.status).toBe('DEAD');
    expect(Date.now() - Date.parse(dead.lastActivityAt)).toBeLessThan(60_000);
  });

  it('chat_who without a channel lists live seats, IDLE included, and no DEAD or stale seat', async () => {
    expect(ids(await who({}))).toEqual(['worker-busy', 'worker-idle', 'worker-joiner']);
  });

  it('chat_who with a channel lists the cursor seat and the parked waiter, never the DEAD one', async () => {
    const online = await who({ channel: '#general' });
    expect(ids(online)).toEqual(['worker-idle', 'worker-stale']);
    const bySource = Object.fromEntries(online.map((o) => [o.workerId, o.source]));
    expect(bySource['worker-idle']).toBe('cursor');
    expect(bySource['worker-stale']).toBe('waiting');
    expect(bySource['worker-closed']).toBeUndefined();
  });

  it('chat_join lists every live seat, IDLE included, and never the DEAD one', async () => {
    const res = await chatJoinTool(h.state).handler(
      { channel: '#general', workerId: 'worker-joiner' }, h.state
    ) as { onlineWorkers: Array<{ id: string }> };
    expect(ids(res.onlineWorkers)).toEqual(['worker-busy', 'worker-idle', 'worker-joiner']);
  });

  it('agrees with list_workers isAlive for the no-channel chat_who and chat_join', async () => {
    const lw = await listWorkersTool(h.state).handler({}, h.state) as { workers: ListedWorker[] };
    const alive = lw.workers.filter((w) => w.isAlive).map((w) => w.workerId).sort();
    expect(lw.workers.find((w) => w.workerId === 'worker-idle')!.isAlive).toBe(true);
    expect(lw.workers.find((w) => w.workerId === 'worker-closed')!.isAlive).toBe(false);
    expect(ids(await who({}))).toEqual(alive);
    const res = await chatJoinTool(h.state).handler(
      { channel: '#general', workerId: 'worker-joiner' }, h.state
    ) as { onlineWorkers: Array<{ id: string }> };
    expect(ids(res.onlineWorkers)).toEqual(alive);
  });
});
