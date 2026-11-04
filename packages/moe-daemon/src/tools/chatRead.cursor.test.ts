import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ToolTestHarness } from './toolTestHarness.js';
import { chatReadTool } from './chatRead.js';
import { chatWaitTool } from './chatWait.js';

// A chat_read with an explicit sinceId is a PEEK: it returns the page but moves
// no stored cursor and clears no unread count. Cursor-mode reads (workerId, no
// sinceId) keep advancing, which chatBudgets/chatWait/chatChannelRef also pin.
const READER = 'worker-reader';
const PEER = 'worker-peer';

interface ReadResult {
  messages: Array<{ id: string; channel: string; content: string }>;
  cursor: string | null;
}

describe('moe.chat_read explicit sinceId is a peek', () => {
  const h = new ToolTestHarness();
  let general: string;
  let workers: string;

  beforeEach(async () => {
    h.init();
    h.setupMoeFolder();
    h.createWorker({ id: READER });
    h.createWorker({ id: PEER });
    await h.state.load();
    general = h.state.getChannels().find((c) => c.name === 'general')!.id;
    workers = h.state.getChannels().find((c) => c.name === 'workers')!.id;
  });
  afterEach(() => h.cleanup());

  const read = (args: Record<string, unknown>) =>
    chatReadTool(h.state).handler(args, h.state) as Promise<ReadResult>;
  const cursorOf = (channel: string) => h.state.getWorker(READER)?.chatCursors?.[channel];
  const unreadIn = (channel: string) => h.state.getUnreadSummary(READER)?.channels[channel] ?? 0;
  const contents = (r: ReadResult, channel?: string) =>
    r.messages.filter((m) => !channel || m.channel === channel).map((m) => m.content);

  /** Post as the peer and return the stored message id. */
  async function post(channel: string, content: string): Promise<string> {
    return (await h.state.sendMessage({ channel, sender: PEER, content })).message.id;
  }
  async function postMany(channel: string, from: number, to: number, prefix: string): Promise<string[]> {
    const ids: string[] = [];
    for (let i = from; i <= to; i++) ids.push(await post(channel, `${prefix}${i}`));
    return ids;
  }

  it('(1) a channel peek keeps the stored cursor, so nothing is re-delivered', async () => {
    const ids = await postMany(general, 1, 6, 'm');
    const first = await read({ workerId: READER, channel: general, limit: 10 });
    expect(contents(first)).toEqual(['m1', 'm2', 'm3', 'm4', 'm5', 'm6']);
    expect(cursorOf(general)).toBe(ids[5]);

    const peek = await read({ workerId: READER, channel: general, sinceId: ids[0], limit: 1 });
    expect(contents(peek)).toEqual(['m2']);
    expect(peek.cursor).toBe(ids[1]);
    expect(cursorOf(general)).toBe(ids[5]);

    expect(contents(await read({ workerId: READER, channel: general, limit: 10 }))).toEqual([]);
    const waited = await chatWaitTool(h.state).handler(
      { workerId: READER, channels: [general], timeoutMs: 1000 }, h.state
    ) as { hasMessage: boolean };
    expect(waited.hasMessage).toBe(false);
  });

  it('(2) a peek leaves the unread count alone; the next cursor read clears it', async () => {
    const ids = await postMany(general, 1, 6, 'm');
    await read({ workerId: READER, channel: general, limit: 10 });
    await post(general, `@${READER} m7`);
    expect(unreadIn(general)).toBe(1);

    const peek = await read({ workerId: READER, channel: general, sinceId: ids[0], limit: 50 });
    expect(contents(peek)).toContain(`@${READER} m7`);
    expect(unreadIn(general)).toBe(1);
    expect(cursorOf(general)).toBe(ids[5]);

    const next = await read({ workerId: READER, channel: general, limit: 50 });
    expect(contents(next)).toEqual([`@${READER} m7`]);
    expect(cursorOf(general)).toBe(next.cursor);
    expect(unreadIn(general)).toBe(0);
  });

  it('(3) a peek ahead of the cursor skips nothing for the next cursor read', async () => {
    const ids = await postMany(general, 1, 2, 'm');
    await read({ workerId: READER, channel: general, limit: 10 });
    expect(cursorOf(general)).toBe(ids[1]);
    const later = await postMany(general, 3, 6, 'm');

    const peek = await read({ workerId: READER, channel: general, sinceId: later[1], limit: 10 });
    expect(contents(peek)).toEqual(['m5', 'm6']);
    expect(cursorOf(general)).toBe(ids[1]);

    const next = await read({ workerId: READER, channel: general, limit: 10 });
    expect(contents(next)).toEqual(['m3', 'm4', 'm5', 'm6']);
  });

  it('(4) an all-channel peek applies the id only to the channel that holds it', async () => {
    const w = await postMany(workers, 1, 5, 'w');
    await read({ workerId: READER, channel: workers, limit: 10 });
    expect(cursorOf(workers)).toBe(w[4]);
    await postMany(workers, 6, 6, 'w');
    await post(workers, `@${READER} w7`);
    await postMany(workers, 8, 20, 'w');
    const g1 = await post(general, 'g1');
    await post(general, 'g2');
    expect(unreadIn(workers)).toBe(1);

    const peek = await read({ workerId: READER, sinceId: g1, limit: 50 });
    // Filter by channel: equal-millisecond timestamps leave cross-channel order unstable.
    expect(contents(peek, workers)).toEqual([
      'w6', `@${READER} w7`, ...Array.from({ length: 13 }, (_, i) => `w${i + 8}`),
    ]);
    expect(contents(peek, general)).toEqual(['g2']);
    expect(cursorOf(workers)).toBe(w[4]);
    expect(cursorOf(general)).toBeUndefined();
    expect(unreadIn(workers)).toBe(1);

    const next = await read({ workerId: READER, channel: workers, limit: 50 });
    expect(contents(next)).toContain(`@${READER} w7`);
    expect(contents(next)).toHaveLength(15);
    expect(unreadIn(workers)).toBe(0);
  });

  it('(5) an anonymous all-channel peek keeps the newest-window fallback', async () => {
    await postMany(workers, 1, 20, 'w');
    const g1 = await post(general, 'g1');
    await post(general, 'g2');

    const peek = await read({ sinceId: g1, limit: 50 });
    expect(contents(peek, workers)).toEqual(Array.from({ length: 20 }, (_, i) => `w${i + 1}`));
    expect(contents(peek, general)).toEqual(['g2']);
  });

  it('(6) the description says a sinceId read is a peek that moves no cursor', () => {
    const tool = chatReadTool(h.state);
    const sinceIdDoc = (tool.inputSchema.properties as Record<string, { description: string }>).sinceId.description;
    for (const text of [tool.description, sinceIdDoc]) {
      expect(text).toMatch(/peek/i);
      expect(text).toMatch(/cursor/i);
    }
  });
});
