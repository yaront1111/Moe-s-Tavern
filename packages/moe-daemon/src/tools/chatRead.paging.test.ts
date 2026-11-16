import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ToolTestHarness } from './toolTestHarness.js';
import { chatReadTool } from './chatRead.js';
import { chatMessageResponseCost, DEFAULT_CHAT_CONTENT_CHARS, MAX_CHAT_RESPONSE_CHARS } from '../util/chatPayload.js';
import type { ChatMessage } from '../types/schema.js';

// A chat_read from a position (an explicit sinceId, or the caller's stored
// cursor) pages FORWARD: it returns the oldest messages after that position,
// with no gap, and says when more follow the last one returned (hasMore: true
// plus nextSinceId). The response-size budget cuts the NEWEST end of such a
// page. Regression: the budget trim dropped the OLDEST messages of the page,
// so a 60-message peek in #governors silently skipped the 4 messages right
// after sinceId, and a cursor read advanced the stored cursor past them.
const READER = 'worker-reader';
const PEER = 'worker-peer';

interface ReadResult {
  messages: ChatMessage[];
  cursor: string | null;
  truncated: number;
  hasMore?: boolean;
  nextSinceId?: string;
}

describe('moe.chat_read pages forward without gaps', () => {
  const h = new ToolTestHarness();
  let governors: string;

  beforeEach(async () => {
    h.init();
    h.setupMoeFolder();
    h.createWorker({ id: READER });
    h.createWorker({ id: PEER });
    await h.state.load();
    governors = h.state.resolveChannelRef('#governors')!.id;
  });
  afterEach(() => h.cleanup());

  const read = (args: Record<string, unknown>) =>
    chatReadTool(h.state).handler(args, h.state) as Promise<ReadResult>;
  const ids = (r: ReadResult) => r.messages.map((m) => m.id);
  const cursorOf = (channel: string) => h.state.getWorker(READER)?.chatCursors?.[channel];
  const cost = (r: ReadResult) =>
    r.messages.reduce((n, m) => n + chatMessageResponseCost(m, DEFAULT_CHAT_CONTENT_CHARS), 0);

  async function post(channel: string, content: string): Promise<string> {
    return (await h.state.sendMessage({ channel, sender: PEER, content })).message.id;
  }
  /** Messages of exactly the default per-message cap: 40 of them overflow the response budget. */
  async function postBig(channel: string, count: number): Promise<string[]> {
    const posted: string[] = [];
    for (let i = 1; i <= count; i++) posted.push(await post(channel, `m${i} `.padEnd(DEFAULT_CHAT_CONTENT_CHARS, 'x')));
    return posted;
  }

  it('a peek whose page overflows the budget keeps the oldest messages after sinceId and says more follow', async () => {
    const anchor = await post(governors, 'anchor');
    const after = await postBig(governors, 40);

    const page = await read({ channel: governors, sinceId: anchor, limit: 40 });

    // The budget bound (fewer than limit came back), and it cut the newest end.
    expect(page.messages.length).toBeGreaterThan(0);
    expect(page.messages.length).toBeLessThan(40);
    expect(ids(page)).toEqual(after.slice(0, page.messages.length));
    expect(cost(page)).toBeLessThanOrEqual(MAX_CHAT_RESPONSE_CHARS);
    const last = after[page.messages.length - 1];
    expect(page.hasMore).toBe(true);
    expect(page.nextSinceId).toBe(last);
    expect(page.cursor).toBe(last);
  });

  it('following nextSinceId walks the whole backlog once, and the last page omits hasMore', async () => {
    const anchor = await post(governors, 'anchor');
    const after = await postBig(governors, 40);

    const seen: string[] = [];
    let sinceId = anchor;
    let last: ReadResult | undefined;
    for (let pages = 0; pages < 10; pages++) {
      last = await read({ channel: governors, sinceId, limit: 40 });
      seen.push(...ids(last));
      if (!last.hasMore) break;
      sinceId = last.nextSinceId!;
    }

    expect(seen).toEqual(after);
    expect(last!.hasMore).toBeUndefined();
    expect(last!.nextSinceId).toBeUndefined();
  });

  it('a page that fills limit reports hasMore only when a message follows it', async () => {
    const anchor = await post(governors, 'anchor');
    const after: string[] = [];
    for (let i = 1; i <= 10; i++) after.push(await post(governors, `m${i}`));

    const first = await read({ channel: governors, sinceId: anchor, limit: 5 });
    expect(ids(first)).toEqual(after.slice(0, 5));
    expect(first.hasMore).toBe(true);
    expect(first.nextSinceId).toBe(after[4]);

    // Exactly `limit` messages remain: this page is the end of the channel.
    const second = await read({ channel: governors, sinceId: first.nextSinceId, limit: 5 });
    expect(ids(second)).toEqual(after.slice(5));
    expect(second.hasMore).toBeUndefined();
    expect(second.nextSinceId).toBeUndefined();

    const caughtUp = await read({ channel: governors, sinceId: after[9], limit: 5 });
    expect(caughtUp.messages).toEqual([]);
    expect(caughtUp.hasMore).toBeUndefined();
    expect(caughtUp.nextSinceId).toBeUndefined();
    expect(caughtUp.cursor).toBe(after[9]);
  });

  it('hidden #general feed lines after the page do not count as more', async () => {
    const general = h.state.resolveChannelRef('#general')!.id;
    const anchor = await post(general, 'anchor');
    const after = [await post(general, 'g1'), await post(general, 'g2')];
    await h.state.sendMessage({ channel: general, sender: 'system', content: 'task-1 moved to REVIEW' });

    const page = await read({ channel: general, sinceId: anchor, limit: 2 });
    expect(ids(page)).toEqual(after);
    expect(page.hasMore).toBeUndefined();

    const withFeed = await read({ channel: general, sinceId: anchor, limit: 2, includeSystem: true });
    expect(ids(withFeed)).toEqual(after);
    expect(withFeed.hasMore).toBe(true);
    expect(withFeed.nextSinceId).toBe(after[1]);
  });

  it('a cursor read that overflows the budget advances the stored cursor only to its last returned message', async () => {
    const anchor = await post(governors, 'anchor');
    await read({ workerId: READER, channel: governors, limit: 40 });
    expect(cursorOf(governors)).toBe(anchor);
    const after = await postBig(governors, 40);

    const first = await read({ workerId: READER, channel: governors, limit: 40 });
    expect(first.messages.length).toBeGreaterThan(0);
    expect(first.messages.length).toBeLessThan(40);
    expect(ids(first)).toEqual(after.slice(0, first.messages.length));
    expect(cursorOf(governors)).toBe(after[first.messages.length - 1]);
    expect(first.hasMore).toBe(true);
    expect(first.nextSinceId).toBe(cursorOf(governors));

    const second = await read({ workerId: READER, channel: governors, limit: 40 });
    expect([...ids(first), ...ids(second)]).toEqual(after);
    expect(cursorOf(governors)).toBe(after[39]);
    expect(second.hasMore).toBeUndefined();
  });

  it('a read with no position still keeps the newest window and reports nothing after it', async () => {
    const after = await postBig(governors, 40);

    const page = await read({ channel: governors, limit: 40 });

    expect(page.messages.length).toBeGreaterThan(0);
    expect(page.messages.length).toBeLessThan(40);
    expect(ids(page)).toEqual(after.slice(40 - page.messages.length));
    expect(page.hasMore).toBeUndefined();
    expect(page.nextSinceId).toBeUndefined();
  });

  it('an all-channel read that leaves fetched messages out says hasMore, without a nextSinceId', async () => {
    const general = h.state.resolveChannelRef('#general')!.id;
    const older = await post(general, 'older');
    await new Promise((resolve) => setTimeout(resolve, 2)); // distinct timestamps: the merge sorts on them
    const newer = await post(governors, 'newer');

    const first = await read({ workerId: READER, limit: 1 });
    expect(ids(first)).toEqual([newer]);
    expect(first.hasMore).toBe(true);
    expect(first.nextSinceId).toBeUndefined();

    const second = await read({ workerId: READER, limit: 1 });
    expect(ids(second)).toEqual([older]);
    expect(second.hasMore).toBeUndefined();
  });

  it('an all-channel cursor read cut by the budget never moves a cursor past an unreturned message', async () => {
    const anchor = await post(governors, 'anchor');
    await read({ workerId: READER, channel: governors, limit: 40 });
    const after = await postBig(governors, 40);

    const page = await read({ workerId: READER, limit: 40 });

    expect(page.messages.length).toBeLessThan(40);
    expect(page.hasMore).toBe(true);
    expect(page.nextSinceId).toBeUndefined();
    // Wherever the cursor rests, every message up to it was returned.
    const stored = cursorOf(governors)!;
    const upTo = stored === anchor ? [] : after.slice(0, after.indexOf(stored) + 1);
    expect(upTo.every((id) => ids(page).includes(id))).toBe(true);
  });

  it('the description tells callers about hasMore and nextSinceId', () => {
    const tool = chatReadTool(h.state);
    expect(tool.description).toMatch(/hasMore/);
    expect(tool.description).toMatch(/nextSinceId/);
  });
});
