import type { ChatMessage } from '../types/schema.js';
import { truncateForBudget } from './memorySettings.js';

export const DEFAULT_CHAT_CONTENT_CHARS = 1000;
export const DEFAULT_CHAT_CONTEXT_LIMIT = 0;
export const DEFAULT_CHAT_CONTEXT_CHARS = 300;
export const DEFAULT_CHAT_RESYNC_LIMIT = 20;
export const MAX_CHAT_LIMIT = 200;
export const MAX_CHAT_CONTENT_CHARS = 10_000;
/**
 * Ceiling on the TOTAL content a single chat response may carry.
 *
 * `maxContentChars` bounds one message; nothing bounded the response, so a
 * burst of 100 messages could exceed an MCP client's payload limit and be
 * rejected wholesale — the caller then saw nothing, retried, and got the same
 * oversized window forever. Measured live: `limit: 200, maxContentChars: 1`
 * still returned ~68KB, because per-message metadata alone is ~200 bytes.
 */
export const MAX_CHAT_RESPONSE_CHARS = 40_000;
/** Approximate serialized overhead of one message's metadata fields. */
export const CHAT_MESSAGE_OVERHEAD_CHARS = 220;

/**
 * How many chars a message will occupy in a response once `maxContentChars`
 * truncation is applied. `maxContentChars <= 0` means "no truncation".
 */
export function chatMessageResponseCost(message: ChatMessage, maxContentChars: number): number {
  const contentChars = maxContentChars > 0
    ? Math.min(message.content.length, maxContentChars)
    : message.content.length;
  return contentChars + CHAT_MESSAGE_OVERHEAD_CHARS;
}

/**
 * Cut a message list at the response-size ceiling. Returns the prefix that
 * fits plus what was left behind, so the caller can keep the undelivered tail
 * unread instead of advancing a cursor past it. Always yields at least one
 * message — a single oversized message must still be deliverable, or the
 * caller would spin on it forever.
 */
export function capChatMessagesToResponseBudget<T extends ChatMessage>(
  messages: T[],
  maxContentChars: number,
  budget: number = MAX_CHAT_RESPONSE_CHARS
): { delivered: T[]; dropped: T[] } {
  let used = 0;
  for (let i = 0; i < messages.length; i++) {
    used += chatMessageResponseCost(messages[i], maxContentChars);
    if (used > budget && i > 0) {
      return { delivered: messages.slice(0, i), dropped: messages.slice(i) };
    }
  }
  return { delivered: messages, dropped: [] };
}

export type ChatMessageView = ChatMessage & {
  contentTruncated?: boolean;
  contentOriginalLength?: number;
};

export function truncateChatMessage(message: ChatMessage, maxContentChars: number): ChatMessageView {
  if (maxContentChars <= 0 || message.content.length <= maxContentChars) {
    return message;
  }

  const truncated = truncateForBudget(message.content, maxContentChars);
  return {
    ...message,
    content: truncated.text,
    contentTruncated: truncated.truncated,
    contentOriginalLength: message.content.length,
  };
}

export function truncateChatMessages(messages: ChatMessage[], maxContentChars: number): ChatMessageView[] {
  return messages.map((message) => truncateChatMessage(message, maxContentChars));
}

export function countTruncatedMessages(messages: ChatMessageView[]): number {
  return messages.filter((message) => message.contentTruncated).length;
}
