import type { ToolDefinition } from './index.js';
import type { StateManager } from '../state/StateManager.js';
import type { ChatMessage } from '../types/schema.js';
import { invalidInput } from '../util/errors.js';
import {
  countTruncatedMessages,
  DEFAULT_CHAT_CONTENT_CHARS,
  MAX_CHAT_CONTENT_CHARS,
  MAX_CHAT_LIMIT,
  truncateChatMessages,
} from '../util/chatPayload.js';

export function chatReadTool(_state: StateManager): ToolDefinition {
  return {
    name: 'moe.chat_read',
    description: 'Read chat messages from a channel with cursor-based pagination. Auto-tracks read position per worker.',
    inputSchema: {
      type: 'object',
      properties: {
        channel: { type: 'string', description: 'Channel ID (omit to read from all channels)' },
        workerId: { type: 'string', description: 'Worker ID for auto-cursor tracking' },
        sinceId: { type: 'string', description: 'Return messages after this message ID' },
        limit: { type: 'number', description: 'Max messages to return (default 10, max 200)' },
        maxContentChars: {
          type: 'number',
          description: 'Max chars per message content in the response (default 1000, 0 = full content)'
        }
      },
      additionalProperties: false
    },
    handler: async (args, state) => {
      const params = (args || {}) as {
        channel?: string;
        workerId?: string;
        sinceId?: string;
        limit?: number;
        maxContentChars?: number;
      };

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
        : 10;
      const maxContentChars = params.maxContentChars !== undefined
        ? Math.min(Math.floor(params.maxContentChars), MAX_CHAT_CONTENT_CHARS)
        : DEFAULT_CHAT_CONTENT_CHARS;

      let messages: ChatMessage[];
      let sinceId = params.sinceId;
      let allChannelFetchedMessages: ChatMessage[] = [];

      // If workerId provided and no explicit sinceId, use worker's saved cursor
      if (params.workerId && !sinceId && params.channel) {
        const worker = state.getWorker(params.workerId);
        if (worker?.chatCursors) {
          sinceId = worker.chatCursors[params.channel];
        }
      }

      if (params.channel) {
        // Read from a specific channel
        messages = await state.getMessages(params.channel, { sinceId, limit });
      } else {
        // Read from all channels, merge and sort by timestamp
        const channels = state.getChannels();
        const allMessages: ChatMessage[] = [];
        // Use each channel's saved cursor independently; cursor updates are
        // computed after the global slice so omitted fetched messages are not skipped.
        const existingCursors = params.workerId
          ? (state.getWorker(params.workerId)?.chatCursors || {})
          : {};
        for (const ch of channels) {
          const chSinceId = params.workerId && !params.sinceId
            ? existingCursors[ch.id]
            : sinceId;
          const chMessages = await state.getMessages(ch.id, { sinceId: chSinceId, limit });
          allMessages.push(...chMessages);
        }

        allChannelFetchedMessages = allMessages.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
        messages = allChannelFetchedMessages
          .slice(-limit);
      }

      const cursor = messages.length > 0 ? messages[messages.length - 1].id : sinceId || null;
      const returnedMessageIds = new Set(messages.map((msg) => msg.id));
      const allChannelChannelsWithOmittedFetchedMessages = new Set(
        allChannelFetchedMessages
          .filter((msg) => !returnedMessageIds.has(msg.id))
          .map((msg) => msg.channel)
      );

      // Update worker's chat cursor atomically if workerId provided
      if (params.workerId && messages.length > 0) {
        const cursorUpdates: Record<string, string> = {};
        if (params.channel) {
          cursorUpdates[params.channel] = cursor!;
        } else {
          for (const msg of messages) {
            if (!allChannelChannelsWithOmittedFetchedMessages.has(msg.channel)) {
              cursorUpdates[msg.channel] = msg.id;
            }
          }
        }
        if (Object.keys(cursorUpdates).length > 0) {
          await state.updateWorkerCursors(params.workerId, cursorUpdates);
        }
      }

      // Clear unread notification counts only when messages were actually read
      if (params.workerId && messages.length > 0) {
        if (params.channel) {
          state.clearUnread(params.workerId, params.channel);
        } else {
          for (const channelId of new Set(messages.map((msg) => msg.channel))) {
            if (!allChannelChannelsWithOmittedFetchedMessages.has(channelId)) {
              state.clearUnread(params.workerId, channelId);
            }
          }
        }
      }
      if (params.workerId) {
        await state.touchWorker(params.workerId);
      }

      const responseMessages = truncateChatMessages(messages, maxContentChars);
      const truncated = countTruncatedMessages(responseMessages);
      return {
        messages: responseMessages,
        cursor,
        truncated,
        ...(truncated > 0
          ? { hint: 'Long chat messages are truncated by default. Re-read with maxContentChars: 0 for full content.' }
          : {})
      };
    }
  };
}
