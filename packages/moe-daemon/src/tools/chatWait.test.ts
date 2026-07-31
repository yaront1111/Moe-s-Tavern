import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { StateManager } from '../state/StateManager.js';
import { chatWaitTool, MAX_BURST_MESSAGES, PER_CHANNEL_SCAN_LIMIT, summarizeChatBurst } from './chatWait.js';
import type { ChatMessage, Worker } from '../types/schema.js';

const WORKER_ID = 'worker-wait';
const TIMEOUT_MS = 1000;

interface WaitResult {
  hasMessage: boolean;
  messages?: Array<{ id: string; channel: string; content: string }>;
  truncated?: number;
  hasMore?: boolean;
  timedOut?: boolean;
  cancelled?: boolean;
  error?: string;
}

describe('moe.chat_wait', () => {
  let testDir: string;
  let moePath: string;
  let state: StateManager;
  let channels: Record<string, string>;

  function wait(args: Record<string, unknown>): Promise<WaitResult> {
    return chatWaitTool(state).handler(
      { workerId: WORKER_ID, timeoutMs: TIMEOUT_MS, ...args },
      state
    ) as Promise<WaitResult>;
  }

  /** Post as someone else and return the stored message. */
  async function post(channel: string, content: string, sender = 'human'): Promise<ChatMessage> {
    const { message } = await state.sendMessage({ channel, sender, content });
    return message;
  }

  function cursorFor(channel: string): string | undefined {
    return state.getWorker(WORKER_ID)?.chatCursors?.[channel];
  }

  beforeEach(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moe-chatwait-test-'));
    moePath = path.join(testDir, '.moe');
    for (const dir of ['epics', 'tasks', 'workers', 'proposals', 'teams', 'channels', 'messages']) {
      fs.mkdirSync(path.join(moePath, dir), { recursive: true });
    }
    fs.writeFileSync(path.join(moePath, 'project.json'), JSON.stringify({
      id: 'proj-test',
      name: 'Chat Wait Project',
      rootPath: testDir,
      globalRails: { techStack: [], forbiddenPatterns: [], requiredPatterns: [], formatting: '', testing: '', customRules: [] },
      settings: { approvalMode: 'CONTROL', agentCommand: 'claude' },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }, null, 2));

    const worker: Worker = {
      id: WORKER_ID,
      type: 'CLAUDE',
      projectId: 'proj-test',
      epicId: null,
      currentTaskId: null,
      status: 'IDLE',
      branch: 'main',
      modifiedFiles: [],
      startedAt: new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
      lastError: null,
      errorCount: 0,
    };
    fs.writeFileSync(path.join(moePath, 'workers', `${WORKER_ID}.json`), JSON.stringify(worker, null, 2));

    state = new StateManager({ projectPath: testDir });
    await state.load();
    channels = {};
    for (const channel of state.getChannels()) channels[channel.name] = channel.id;
    expect(channels.general).toBeDefined();
    expect(channels.workers).toBeDefined();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  describe('backfill on entry', () => {
    it('returns a message posted before the call instead of blocking (channel-filtered)', async () => {
      const message = await post(channels.general, 'landed before the wait', 'system');

      const startedAt = Date.now();
      const result = await wait({ channels: [channels.general] });

      expect(result.hasMessage).toBe(true);
      expect(result.timedOut).toBeUndefined();
      expect(result.messages?.map((m) => m.id)).toEqual([message.id]);
      expect(Date.now() - startedAt).toBeLessThan(TIMEOUT_MS);
    });

    it('returns unread backlog posted before the call instead of blocking (no channel filter)', async () => {
      const message = await post(channels.general, `@${WORKER_ID} you have mail`);

      const startedAt = Date.now();
      const result = await wait({});

      expect(result.hasMessage).toBe(true);
      expect(result.messages?.map((m) => m.id)).toEqual([message.id]);
      expect(Date.now() - startedAt).toBeLessThan(TIMEOUT_MS);
    });

    it('returns a five-message burst across two watched channels in one response, oldest first', async () => {
      const posted: ChatMessage[] = [];
      for (const [index, channel] of [
        channels.general, channels.workers, channels.general, channels.workers, channels.general
      ].entries()) {
        posted.push(await post(channel, `burst ${index}`, 'system'));
        await new Promise((resolve) => setTimeout(resolve, 2));
      }

      const result = await wait({ channels: [channels.general, channels.workers] });

      expect(result.hasMessage).toBe(true);
      expect(result.messages?.map((m) => m.id)).toEqual(posted.map((m) => m.id));
      expect(result.hasMore).toBeUndefined();
    });
  });

  describe('burst on wake', () => {
    it('returns every message that arrived, not just the one that woke the waiter', async () => {
      const waitPromise = wait({});
      // Let the (empty) entry drain finish so this exercises the wake path.
      await new Promise((resolve) => setTimeout(resolve, 30));

      // Unrouted chatter: does not wake a broad-scope waiter and does not
      // increment unread — but it IS in the channel the wake drain scans.
      const quiet1 = await post(channels.general, 'unrelated status one', 'system');
      const quiet2 = await post(channels.general, 'unrelated status two', 'system');
      const trigger = await post(channels.general, `@${WORKER_ID} now look`, 'system');

      const result = await waitPromise;

      expect(result.hasMessage).toBe(true);
      expect(result.messages?.map((m) => m.id)).toEqual([quiet1.id, quiet2.id, trigger.id]);
      expect(cursorFor(channels.general)).toBe(trigger.id);
    });

    it('does not advance a cursor past a backlog the drain never scanned', async () => {
      // A human post wakes a broad-scope waiter WITHOUT incrementing unread, so
      // the drain has no channel to scan. Advancing the cursor to that message
      // would strand every earlier message in the channel forever.
      const stranded = await post(channels.general, 'earlier unrouted chatter', 'system');

      const waitPromise = wait({});
      await new Promise((resolve) => setTimeout(resolve, 30));
      const trigger = await post(channels.general, 'human ping with no mention');

      const result = await waitPromise;

      expect(result.messages?.map((m) => m.id)).toEqual([trigger.id]);
      expect(cursorFor(channels.general)).toBeUndefined();
      expect((await state.getMessages(channels.general)).map((m) => m.id)).toContain(stranded.id);
    });
  });

  describe('sinceId catch-up', () => {
    it('overrides the stored cursor and re-delivers older messages', async () => {
      const first = await post(channels.general, 'one', 'system');
      const second = await post(channels.general, 'two', 'system');
      const third = await post(channels.general, 'three', 'system');
      await state.updateWorkerCursors(WORKER_ID, { [channels.general]: third.id });

      const result = await wait({ channels: [channels.general], sinceId: first.id });

      expect(result.messages?.map((m) => m.id)).toEqual([second.id, third.id]);
    });

    it('rejects an empty sinceId', async () => {
      await expect(wait({ channels: [channels.general], sinceId: '' }))
        .rejects.toMatchObject({ context: { field: 'sinceId' } });
    });
  });

  describe('cursor bookkeeping', () => {
    it('advances the cursor to the last delivered message and then has nothing left', async () => {
      const first = await post(channels.general, 'one', 'system');
      const last = await post(channels.general, 'two', 'system');

      const result = await wait({ channels: [channels.general] });
      expect(result.messages?.map((m) => m.id)).toEqual([first.id, last.id]);
      expect(cursorFor(channels.general)).toBe(last.id);

      const followUp = await wait({ channels: [channels.general] });
      expect(followUp).toMatchObject({ hasMessage: false, timedOut: true });
    });

    it('never wakes on or advances past the waiter\'s own posts', async () => {
      await post(channels.general, 'my own note', WORKER_ID);

      const result = await wait({ channels: [channels.general] });

      expect(result).toMatchObject({ hasMessage: false, timedOut: true });
      expect(cursorFor(channels.general)).toBeUndefined();
    });

    it('never advances a cursor to a message that came off the event bus', () => {
      // Unit-level guard on the core both the entry and wake paths share: an
      // off-bus message (buffer/trigger) is DELIVERED but proves nothing about
      // the messages between it and the end of the scan.
      const channel = 'chan-x';
      const message = (id: string, timestamp: string): ChatMessage => ({
        id, channel, sender: 'system', content: id, replyTo: null, mentions: [], timestamp,
      });
      const scanned = [message('m1', '2026-07-31T10:00:00.000Z')];
      const offBus = [message('m2', '2026-07-31T10:00:01.000Z')];

      const burst = summarizeChatBurst(scanned, offBus, {
        partialChannels: new Set([channel]),
        scannedChannels: new Set([channel]),
      });

      expect(burst.messages.map((m) => m.id)).toEqual(['m1', 'm2']);
      expect(burst.cursorUpdates).toEqual({ [channel]: 'm1' });
      expect(burst.fullyDrained).toEqual([]);
      expect(burst.hasMore).toBe(true);
    });

    it('does not advance a partially scanned channel past what the scan read (wake path)', async () => {
      // Regression: the scan pages 50 at a time, so with more than that waiting
      // the trigger is newest by timestamp — letting it set the cursor would
      // strand every message the scan never reached.
      const anchor = await post(channels.general, 'anchor', 'system');
      await state.updateWorkerCursors(WORKER_ID, { [channels.general]: anchor.id });
      const fillers: ChatMessage[] = [];
      for (let i = 0; i < PER_CHANNEL_SCAN_LIMIT + 10; i++) {
        fillers.push(await post(channels.general, `filler ${i}`, 'system'));
      }

      // Broad scope: unrouted fillers neither wake the waiter nor mark unread.
      const waitPromise = wait({});
      await new Promise((resolve) => setTimeout(resolve, 30));
      const trigger = await post(channels.general, `@${WORKER_ID} wake up`, 'system');

      const first = await waitPromise;
      expect(first.messages?.map((m) => m.id)).toContain(trigger.id);
      expect(first.hasMore).toBe(true);
      expect(cursorFor(channels.general)).not.toBe(trigger.id);
      expect(cursorFor(channels.general)).toBe(fillers[PER_CHANNEL_SCAN_LIMIT - 1].id);

      const second = await wait({});
      const delivered = new Set(
        [...(first.messages ?? []), ...(second.messages ?? [])].map((m) => m.id)
      );
      for (const filler of fillers) {
        expect(delivered.has(filler.id)).toBe(true);
      }
      // The trigger repeats — the accepted trade for never skipping a message.
      expect(second.messages?.map((m) => m.id)).toContain(trigger.id);
    });

    it('does not advance a partially scanned channel past what the scan read (entry path)', async () => {
      // Seed a cursor so the scan pages FORWARD from it (an absent cursor makes
      // getMessages return the most recent window instead — a resync, not a page).
      const anchor = await post(channels.general, 'anchor', 'system');
      await state.updateWorkerCursors(WORKER_ID, { [channels.general]: anchor.id });
      const fillers: ChatMessage[] = [];
      for (let i = 0; i < PER_CHANNEL_SCAN_LIMIT + 10; i++) {
        fillers.push(await post(channels.general, `filler ${i}`, 'system'));
      }

      // Slow the scan so the post below is guaranteed to land mid-drain and
      // reach the burst off the event bus rather than through the scan.
      const original = state.getMessages.bind(state);
      vi.spyOn(state, 'getMessages').mockImplementation(async (channelId, opts) => {
        const result = await original(channelId, opts);
        await new Promise((resolve) => setTimeout(resolve, 80));
        return result;
      });

      const waitPromise = wait({ channels: [channels.general] });
      await new Promise((resolve) => setTimeout(resolve, 20));
      const late = await post(channels.general, 'landed during the drain', 'system');

      const first = await waitPromise;
      expect(first.messages?.map((m) => m.id)).toContain(late.id);
      expect(first.hasMore).toBe(true);
      expect(cursorFor(channels.general)).not.toBe(late.id);
      expect(cursorFor(channels.general)).toBe(fillers[PER_CHANNEL_SCAN_LIMIT - 1].id);
    });

    it('caps a burst, reports hasMore, and returns the remainder on the next call', async () => {
      const perChannel = 40;
      expect(perChannel).toBeLessThanOrEqual(PER_CHANNEL_SCAN_LIMIT);
      const watched = [channels.general, channels.workers, channels.architects];
      expect(watched.length * perChannel).toBeGreaterThan(MAX_BURST_MESSAGES);

      const posted: Record<string, ChatMessage[]> = {};
      for (const channel of watched) {
        posted[channel] = [];
        for (let i = 0; i < perChannel; i++) {
          posted[channel].push(await post(channel, `msg ${i}`, 'system'));
        }
      }

      const first = await wait({ channels: watched });
      expect(first.messages).toHaveLength(MAX_BURST_MESSAGES);
      expect(first.hasMore).toBe(true);

      const delivered = first.messages!.map((m) => m.id);
      const lastDeliveredIn = (channel: string) =>
        [...first.messages!].reverse().find((m) => m.channel === channel)?.id;
      for (const channel of watched) {
        expect(cursorFor(channel)).toBe(lastDeliveredIn(channel));
      }

      const remainder = watched
        .flatMap((channel) => posted[channel])
        .filter((m) => !delivered.includes(m.id));
      expect(remainder).toHaveLength(watched.length * perChannel - MAX_BURST_MESSAGES);

      const second = await wait({ channels: watched });
      expect(second.messages?.map((m) => m.id)).toEqual(remainder.map((m) => m.id));
      expect(second.hasMore).toBeUndefined();
    });
  });

  describe('error handling', () => {
    it('delivers readable channels when one channel scan fails', async () => {
      const readable = await post(channels.workers, 'still delivered', 'system');
      await post(channels.general, 'unreadable channel', 'system');

      const original = state.getMessages.bind(state);
      vi.spyOn(state, 'getMessages').mockImplementation(async (channelId, opts) => {
        if (channelId === channels.general) throw new Error('disk on fire');
        return original(channelId, opts);
      });

      const result = await wait({ channels: [channels.general, channels.workers] });

      expect(result.messages?.map((m) => m.id)).toEqual([readable.id]);
      expect(cursorFor(channels.general)).toBeUndefined();
    });

    it('still returns messages when the cursor write fails', async () => {
      const message = await post(channels.general, 'cursor write will fail', 'system');
      vi.spyOn(state, 'updateWorkerCursors').mockRejectedValue(new Error('worker file locked'));

      const result = await wait({ channels: [channels.general] });

      expect(result.hasMessage).toBe(true);
      expect(result.messages?.map((m) => m.id)).toEqual([message.id]);
      expect(cursorFor(channels.general)).toBeUndefined();
    });
  });

  describe('unchanged blocking behaviour', () => {
    it('times out with the documented shape when nothing arrives', async () => {
      const result = await wait({ channels: [channels.general] });
      expect(result).toEqual({ hasMessage: false, timedOut: true });
    });

    it('cancels a previous wait for the same worker', async () => {
      const firstWait = wait({ channels: [channels.general] });
      await new Promise((resolve) => setTimeout(resolve, 30));
      const secondWait = wait({ channels: [channels.general] });

      expect(await firstWait).toEqual({ hasMessage: false, cancelled: true });
      expect(await secondWait).toMatchObject({ hasMessage: false, timedOut: true });
    });

    it('aborts when a watched channel is deleted', async () => {
      const custom = await state.createChannel({ name: 'burst-room', type: 'custom' });
      const waitPromise = wait({ channels: [custom.id] });
      await new Promise((resolve) => setTimeout(resolve, 30));

      await state.deleteChannel(custom.id);

      const result = await waitPromise;
      expect(result.hasMessage).toBe(false);
      expect(result.cancelled).toBe(true);
      expect(result.error).toContain(`Channel ${custom.id} was deleted`);
    });
  });
});
