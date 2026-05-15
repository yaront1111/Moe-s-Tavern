import type { ChatMessage } from '../types/schema.js';
import { truncateForBudget } from './memorySettings.js';

export const DEFAULT_CHAT_CONTENT_CHARS = 1000;
export const DEFAULT_CHAT_CONTEXT_LIMIT = 0;
export const DEFAULT_CHAT_CONTEXT_CHARS = 300;
export const DEFAULT_CHAT_RESYNC_LIMIT = 20;
export const MAX_CHAT_LIMIT = 200;
export const MAX_CHAT_CONTENT_CHARS = 10_000;

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
