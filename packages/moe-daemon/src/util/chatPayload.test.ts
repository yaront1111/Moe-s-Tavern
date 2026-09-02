import { describe, it, expect } from 'vitest';
import type { ChatMessage } from '../types/schema.js';
import {
  CHAT_MESSAGE_OVERHEAD_CHARS,
  MAX_CHAT_RESPONSE_CHARS,
  capChatMessagesToResponseBudget,
  chatMessageResponseCost,
} from './chatPayload.js';

function msg(id: string, contentChars: number): ChatMessage {
  return {
    id,
    channel: 'chan-1',
    sender: 'worker-a',
    content: 'x'.repeat(contentChars),
    replyTo: null,
    mentions: [],
    timestamp: '2026-09-02T00:00:00.000Z',
  } as ChatMessage;
}

describe('chat response budget', () => {
  it('counts truncated content, not raw content, toward the cost', () => {
    const big = msg('m1', 10_000);
    // maxContentChars caps what actually ships, so the cost follows it.
    expect(chatMessageResponseCost(big, 100)).toBe(100 + CHAT_MESSAGE_OVERHEAD_CHARS);
    // 0 means "no truncation" — the whole body ships and is charged.
    expect(chatMessageResponseCost(big, 0)).toBe(10_000 + CHAT_MESSAGE_OVERHEAD_CHARS);
  });

  it('cuts a message list at the response ceiling and reports the remainder', () => {
    // 60 messages of 1000 chars each = ~73KB, comfortably over the ceiling.
    const messages = Array.from({ length: 60 }, (_, i) => msg(`m${i}`, 1000));

    const { delivered, dropped } = capChatMessagesToResponseBudget(messages, 0);

    expect(delivered.length).toBeGreaterThan(0);
    expect(dropped.length).toBeGreaterThan(0);
    expect(delivered.length + dropped.length).toBe(60);
    // Nothing is lost: the cut is a partition, and it keeps the OLDEST first so
    // repeated calls walk the backlog forward.
    expect(delivered[0].id).toBe('m0');
    expect(dropped[0].id).toBe(`m${delivered.length}`);

    const shipped = delivered.reduce((n, m) => n + chatMessageResponseCost(m, 0), 0);
    expect(shipped).toBeLessThanOrEqual(MAX_CHAT_RESPONSE_CHARS);
  });

  it('always delivers at least one message, even if it alone exceeds the ceiling', () => {
    // Otherwise a single oversized message wedges the caller forever: the
    // response is refused, the cursor never advances, and every retry re-reads
    // exactly the same message.
    const huge = msg('huge', MAX_CHAT_RESPONSE_CHARS * 3);

    const { delivered, dropped } = capChatMessagesToResponseBudget([huge], 0);

    expect(delivered).toHaveLength(1);
    expect(dropped).toHaveLength(0);
  });

  it('fits more messages when the caller asks for less content per message', () => {
    const messages = Array.from({ length: 60 }, (_, i) => msg(`m${i}`, 2000));

    const verbose = capChatMessagesToResponseBudget(messages, 0).delivered.length;
    const terse = capChatMessagesToResponseBudget(messages, 200).delivered.length;

    expect(terse).toBeGreaterThan(verbose);
  });
});
