import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ToolTestHarness } from './toolTestHarness.js';
import { chatReadTool } from './chatRead.js';
import { chatResyncTool } from './chatResync.js';
import { chatSendTool } from './chatSend.js';
import { chatWaitTool } from './chatWait.js';
import { MoeErrorCode } from '../util/errors.js';
import path from 'path';

// These tests deliberately live together rather than in chatRead/chatWait/
// chatResync/chatSend.test.ts, even though the colocated-per-tool layout is the
// norm everywhere else in this directory. Payload truncation and cursor-advance
// budgets are ONE contract exercised through four entry points, and the tests
// split 3/3/1/1 across them — sprayed per-tool, each file would hold 1-3
// orphaned tests and the contract would stop being reviewable in one place.
// Please don't "tidy" this back into per-tool files.
describe('chat token budgets', () => {
  const h = new ToolTestHarness();
  beforeEach(() => h.init());
  afterEach(() => { vi.restoreAllMocks(); h.cleanup(); });

  async function setupChat(): Promise<string> {
    h.setupMoeFolder();
    h.createWorker({ id: 'worker-chat' });
    await h.state.load();
    const general = h.state.getChannels().find((channel) => channel.name === 'general');
    expect(general).toBeDefined();
    return general!.id;
  }

  it('truncates chat_read message content by default and supports full content opt-in', async () => {
    const channel = await setupChat();
    const content = 'A'.repeat(1200);
    await h.state.sendMessage({ channel, sender: 'human', content });

    const tool = chatReadTool(h.state);
    const compact = await tool.handler({ channel }, h.state) as {
      messages: Array<{ content: string; contentTruncated?: boolean; contentOriginalLength?: number }>;
      truncated: number;
    };
    expect(compact.messages[0].content.length).toBeLessThanOrEqual(1000);
    expect(compact.messages[0].contentTruncated).toBe(true);
    expect(compact.messages[0].contentOriginalLength).toBe(1200);
    expect(compact.truncated).toBe(1);

    const full = await tool.handler({ channel, maxContentChars: 0 }, h.state) as {
      messages: Array<{ content: string; contentTruncated?: boolean }>;
      truncated: number;
    };
    expect(full.messages[0].content).toBe(content);
    expect(full.messages[0].contentTruncated).toBeUndefined();
    expect(full.truncated).toBe(0);
  });

  it('does not advance cursors or clear unread for all-channel messages omitted by the global limit', async () => {
    const general = await setupChat();
    const other = await h.state.createChannel({ name: 'handoff', type: 'custom' });
    const oldMessage = await h.state.sendMessage({
      channel: general,
      sender: 'human',
      content: '@worker-chat old general handoff',
    });
    await new Promise((resolve) => setTimeout(resolve, 2));
    const returnedMessage = await h.state.sendMessage({
      channel: other.id,
      sender: 'human',
      content: '@worker-chat newest handoff',
    });
    expect(h.state.getUnreadSummary('worker-chat')?.channels[general]).toBe(1);
    expect(h.state.getUnreadSummary('worker-chat')?.channels[other.id]).toBe(1);

    const tool = chatReadTool(h.state);
    const result = await tool.handler({ workerId: 'worker-chat', limit: 1 }, h.state) as {
      messages: Array<{ id: string; channel: string }>;
    };

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].id).toBe(returnedMessage.message.id);
    expect(result.messages[0].channel).toBe(other.id);

    const worker = h.state.getWorker('worker-chat')!;
    expect(worker.chatCursors?.[other.id]).toBe(returnedMessage.message.id);
    expect(worker.chatCursors?.[general]).toBeUndefined();
    expect(worker.chatCursors?.[general]).not.toBe(oldMessage.message.id);

    const unread = h.state.getUnreadSummary('worker-chat');
    expect(unread?.channels[general]).toBe(1);
    expect(unread?.channels[other.id]).toBeUndefined();
    expect(unread?.total).toBe(1);

    const laterRead = await tool.handler({ workerId: 'worker-chat', limit: 1 }, h.state) as {
      messages: Array<{ id: string; channel: string }>;
    };
    expect(laterRead.messages).toHaveLength(1);
    expect(laterRead.messages[0].id).toBe(oldMessage.message.id);
    expect(laterRead.messages[0].channel).toBe(general);
    expect(h.state.getWorker('worker-chat')?.chatCursors?.[general]).toBe(oldMessage.message.id);
    expect(h.state.getUnreadSummary('worker-chat')).toBeNull();
  });

  it('does not advance a returned channel cursor past earlier fetched messages omitted by the global limit', async () => {
    const general = await setupChat();
    const other = await h.state.createChannel({ name: 'handoff', type: 'custom' });
    const oldGeneral = await h.state.sendMessage({
      channel: general,
      sender: 'human',
      content: '@worker-chat old general note',
    });
    await new Promise((resolve) => setTimeout(resolve, 2));
    const returnedGeneral = await h.state.sendMessage({
      channel: general,
      sender: 'human',
      content: '@worker-chat newer general note',
    });
    await new Promise((resolve) => setTimeout(resolve, 2));
    const returnedOther = await h.state.sendMessage({
      channel: other.id,
      sender: 'human',
      content: '@worker-chat newest other note',
    });

    const tool = chatReadTool(h.state);
    const result = await tool.handler({ workerId: 'worker-chat', limit: 2 }, h.state) as {
      messages: Array<{ id: string; channel: string }>;
    };

    expect(result.messages.map((message) => message.id)).toEqual([
      returnedGeneral.message.id,
      returnedOther.message.id,
    ]);
    expect(h.state.getWorker('worker-chat')?.chatCursors?.[other.id]).toBe(returnedOther.message.id);
    expect(h.state.getWorker('worker-chat')?.chatCursors?.[general]).toBeUndefined();
    expect(h.state.getUnreadSummary('worker-chat')?.channels[general]).toBe(2);
    expect(h.state.getUnreadSummary('worker-chat')?.channels[other.id]).toBeUndefined();

    const laterRead = await tool.handler({ workerId: 'worker-chat', limit: 2 }, h.state) as {
      messages: Array<{ id: string; channel: string }>;
    };
    expect(laterRead.messages.map((message) => message.id)).toEqual([
      oldGeneral.message.id,
      returnedGeneral.message.id,
    ]);
    expect(h.state.getWorker('worker-chat')?.chatCursors?.[general]).toBe(returnedGeneral.message.id);
    expect(h.state.getUnreadSummary('worker-chat')).toBeNull();
  });

  it('keeps chat_resync default payload smaller', async () => {
    const channel = await setupChat();
    for (let i = 0; i < 25; i++) {
      await h.state.sendMessage({ channel, sender: 'human', content: `${i}: ${'B'.repeat(1200)}` });
    }

    const tool = chatResyncTool(h.state);
    const result = await tool.handler({ workerId: 'worker-chat', channel }, h.state) as {
      messagesCount: number;
      messages: Array<{ content: string; contentTruncated?: boolean }>;
      truncated: number;
    };

    expect(result.messagesCount).toBe(20);
    expect(result.messages).toHaveLength(20);
    expect(result.messages[0].content.length).toBeLessThanOrEqual(1000);
    expect(result.messages[0].contentTruncated).toBe(true);
    expect(result.truncated).toBe(20);
  });

  it('chat_wait fires on ANY message in subscribed channels (no mention required)', async () => {
    // Regression: governors call chat_wait with `channels: ["#governors"]`
    // and need to wake on every signal landing in that channel — not just
    // ones that @-mention them. The mention/human filter only applies in
    // the broad-scope (no `channels`) path.
    const channel = await setupChat();
    const tool = chatWaitTool(h.state);
    const waitPromise = tool.handler({
      workerId: 'worker-chat',
      channels: [channel],
      timeoutMs: 1000,
    }, h.state) as Promise<{ hasMessage: boolean; messages?: Array<{ content: string }> }>;

    // Plain status update from a different worker — no @-mention, no human sender.
    await h.state.sendMessage({
      channel,
      sender: 'system',
      content: 'status update from somebody else',
    });
    const result = await waitPromise;

    expect(result.hasMessage).toBe(true);
    expect(result.messages?.[0].content).toBe('status update from somebody else');
  });

  it('refreshes worker lastActivityAt when starting a chat wait', async () => {
    // Regression: chat_wait is a long-poll (up to 10 min) that previously
    // never touched the worker's heartbeat, so a worker legitimately parked
    // in chat_wait would report isAlive=false past the 120s presence window
    // even though it's actively blocked in a moe call — unlike wait_for_task,
    // which touches on entry. Bring chat_wait to parity.
    const channel = await setupChat();
    const before = h.state.getWorker('worker-chat')!.lastActivityAt;
    await new Promise((resolve) => setTimeout(resolve, 10));

    const tool = chatWaitTool(h.state);
    const waitPromise = tool.handler({
      workerId: 'worker-chat',
      channels: [channel],
      timeoutMs: 1000,
    }, h.state) as Promise<{ hasMessage: boolean }>;

    // The heartbeat touch is fire-and-forget (must not delay subscribing —
    // see the comment in chatWait.ts), so give it a tick to land before
    // asserting, independent of the wake/timeout timing below.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(new Date(h.state.getWorker('worker-chat')!.lastActivityAt).getTime())
      .toBeGreaterThan(new Date(before).getTime());

    await h.state.sendMessage({ channel, sender: 'system', content: 'wake up' });
    await waitPromise;
  });

  it('rejects chat_send posting as the reserved "system" sender', async () => {
    // Regression: 'system' must not be impersonable over /mcp — it would let
    // an agent masquerade as the daemon and reset the mentionRouter
    // loop-guard. Daemon internals post via h.state.sendMessage directly.
    const channel = await setupChat();
    const tool = chatSendTool(h.state);

    await expect(
      tool.handler({ channel, content: 'pretending to be the daemon', workerId: 'system' }, h.state)
    ).rejects.toMatchObject({
      code: MoeErrorCode.NOT_ALLOWED,
      context: { operation: 'chat_send as "system"', reason: 'reserved for daemon-internal messages' },
    });

    // No message should have landed in the channel.
    expect(await h.state.getMessages(channel)).toHaveLength(0);
  });

  it('truncates chat_wait wake messages by default', async () => {
    const channel = await setupChat();
    const tool = chatWaitTool(h.state);
    const waitPromise = tool.handler({
      workerId: 'worker-chat',
      channels: [channel],
      timeoutMs: 1000,
      maxContentChars: 25,
    }, h.state) as Promise<{
      hasMessage: boolean;
      messages: Array<{ content: string; contentTruncated?: boolean; contentOriginalLength?: number }>;
      truncated: number;
    }>;

    const content = 'Human unblock details '.repeat(20);
    await h.state.sendMessage({ channel, sender: 'human', content });
    const result = await waitPromise;

    expect(result.hasMessage).toBe(true);
    expect(result.messages[0].content.length).toBeLessThanOrEqual(25);
    expect(result.messages[0].contentTruncated).toBe(true);
    expect(result.messages[0].contentOriginalLength).toBe(content.length);
    expect(result.truncated).toBe(1);
  });
});
