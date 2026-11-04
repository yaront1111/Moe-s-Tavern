import type { ToolDefinition } from './index.js';
import type { StateManager } from '../state/StateManager.js';
import type { ChatMessage } from '../types/schema.js';
import { invalidInput, notFound } from '../util/errors.js';
import {
  capChatMessagesToResponseBudget,
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
        channel: {
          type: 'string',
          description: 'Specific channel to resync (omit for all). Channel id, or name in either "general" or "#general" form'
        },
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

      // Resolve the channel reference (id, "general" or "#general") BEFORE the
      // first write, so a refused resync clears no cursor. Cursors are keyed by
      // canonical channel id (chat_read and chat_wait store them that way), and
      // getMessages throws an uncoded Error for a channel it does not know.
      let channelId: string | undefined;
      if (params.channel) {
        if (typeof params.channel !== 'string') throw invalidInput('channel', 'must be a string');
        const channel = state.resolveChannelRef(params.channel);
        if (!channel) throw notFound('Channel', params.channel);
        channelId = channel.id;
      }

      // Clear cursors
      const clearedCursors = { ...(worker.chatCursors || {}) };
      if (channelId) {
        delete clearedCursors[channelId];
      } else {
        Object.keys(clearedCursors).forEach(k => delete clearedCursors[k]);
      }
      await state.updateWorker(params.workerId, { chatCursors: clearedCursors });

      // Fetch messages from beginning (no sinceId)
      let messages: ChatMessage[];
      if (channelId) {
        messages = await state.getMessages(channelId, { limit, hideSystemFeed: true });
      } else {
        const channels = state.getChannels();
        const allMessages: ChatMessage[] = [];
        for (const ch of channels) {
          const chMessages = await state.getMessages(ch.id, { limit, hideSystemFeed: true });
          allMessages.push(...chMessages);
        }
        messages = allMessages
          .sort((a, b) => a.timestamp.localeCompare(b.timestamp))
          .slice(-limit);
      }

      // Bound the RESPONSE, not just each message: with maxContentChars: 0 a
      // 200-message window overflowed an MCP client's payload limit. Keep the
      // NEWEST messages that fit (chat_read's trim). The helper keeps the
      // oldest prefix, so run it on the reversed window, and always keeps one
      // message, so a single oversized message still comes back alone. Applied
      // BEFORE the cursors below, which then point at the newest message
      // actually returned, never past one that was dropped.
      messages = capChatMessagesToResponseBudget([...messages].reverse(), maxContentChars)
        .delivered.reverse();

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
