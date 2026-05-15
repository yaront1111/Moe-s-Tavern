import type { ToolDefinition } from './index.js';
import type { StateManager } from '../state/StateManager.js';
import type { ChatMessage } from '../types/schema.js';
import { invalidInput } from '../util/errors.js';
import {
  countTruncatedMessages,
  DEFAULT_CHAT_CONTENT_CHARS,
  DEFAULT_CHAT_RESYNC_LIMIT,
  MAX_CHAT_CONTENT_CHARS,
  MAX_CHAT_LIMIT,
  truncateChatMessages,
} from '../util/chatPayload.js';

export function chatResyncTool(_state: StateManager): ToolDefinition {
  return {
    name: 'moe.chat_resync',
    description: 'Clear chat cursors and return a bounded, token-budgeted message window for resync.',
    inputSchema: {
      type: 'object',
      properties: {
        workerId: { type: 'string', description: 'Worker whose cursors to reset' },
        channel: { type: 'string', description: 'Specific channel to resync (omit for all)' },
        limit: { type: 'number', description: 'Max messages per channel (default 20, max 200)' },
        maxContentChars: {
          type: 'number',
          description: 'Max chars per message content in the response (default 1000, 0 = full content)'
        }
      },
      required: ['workerId'],
      additionalProperties: false
    },
    handler: async (args, state) => {
      const params = (args || {}) as {
        workerId: string;
        channel?: string;
        limit?: number;
        maxContentChars?: number;
      };

      if (!params.workerId || typeof params.workerId !== 'string') {
        throw invalidInput('workerId', 'must be a non-empty string');
      }

      const worker = state.getWorker(params.workerId);
      if (!worker) {
        throw invalidInput('workerId', 'worker not found');
      }

      if (params.limit !== undefined && (typeof params.limit !== 'number' || !Number.isFinite(params.limit) || params.limit < 1)) {
        throw invalidInput('limit', 'must be a positive number');
      }
      if (
        params.maxContentChars !== undefined &&
        (typeof params.maxContentChars !== 'number' || !Number.isFinite(params.maxContentChars) || params.maxContentChars < 0)
      ) {
        throw invalidInput('maxContentChars', 'must be a non-negative finite number');
      }

      const limit = params.limit !== undefined
        ? Math.min(Math.max(Math.floor(params.limit), 1), MAX_CHAT_LIMIT)
        : DEFAULT_CHAT_RESYNC_LIMIT;
      const maxContentChars = params.maxContentChars !== undefined
        ? Math.min(Math.floor(params.maxContentChars), MAX_CHAT_CONTENT_CHARS)
        : DEFAULT_CHAT_CONTENT_CHARS;

      // Clear cursors
      const clearedCursors = { ...(worker.chatCursors || {}) };
      if (params.channel) {
        delete clearedCursors[params.channel];
      } else {
        Object.keys(clearedCursors).forEach(k => delete clearedCursors[k]);
      }
      await state.updateWorker(params.workerId, { chatCursors: clearedCursors });

      // Fetch messages from beginning (no sinceId)
      let messages: ChatMessage[];
      if (params.channel) {
        messages = await state.getMessages(params.channel, { limit });
      } else {
        const channels = state.getChannels();
        const allMessages: ChatMessage[] = [];
        for (const ch of channels) {
          const chMessages = await state.getMessages(ch.id, { limit });
          allMessages.push(...chMessages);
        }
        messages = allMessages
          .sort((a, b) => a.timestamp.localeCompare(b.timestamp))
          .slice(-limit);
      }

      // Update cursors to latest message per channel
      const newCursors: Record<string, string> = { ...clearedCursors };
      for (const msg of messages) {
        newCursors[msg.channel] = msg.id;
      }
      await state.updateWorker(params.workerId, { chatCursors: newCursors });

      const responseMessages = truncateChatMessages(messages, maxContentChars);
      const truncated = countTruncatedMessages(responseMessages);
      return {
        success: true,
        messagesCount: messages.length,
        messages: responseMessages,
        cursorsReset: true,
        truncated,
        ...(truncated > 0
          ? { hint: 'Long chat messages are truncated by default. Re-run with maxContentChars: 0 for full content.' }
          : {})
      };
    }
  };
}
