import type { ToolDefinition } from './index.js';
import type { StateManager } from '../state/StateManager.js';
import type { ChatMessage } from '../types/schema.js';
import { invalidInput, notFound } from '../util/errors.js';
import {
  countTruncatedMessages,
  DEFAULT_CHAT_CONTENT_CHARS,
  MAX_CHAT_CONTENT_CHARS,
  MAX_CHAT_LIMIT,
  MAX_CHAT_RESPONSE_CHARS,
  chatMessageResponseCost,
  truncateChatMessages,
} from '../util/chatPayload.js';

export function chatReadTool(_state: StateManager): ToolDefinition {
  return {
    name: 'moe.chat_read',
    description: 'Read chat messages from a channel with cursor-based pagination. Auto-tracks read position per worker.',
    inputSchema: {
      type: 'object',
      properties: {
        channel: { type: 'string', description: 'Channel id, or name in either "general" or "#general" form (omit to read from all channels)' },
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

      // Callers name a channel the way the role docs and the seat pre-flight
      // prompts do ("#general") at least as often as by id. Resolve the
      // reference ONCE, up front, so the saved cursor, the fetch and the unread
      // clear all key on the same canonical id. A reference that resolves to
      // nothing is refused here: reading an absent channel used to return an
      // empty page, which reads as "this channel is quiet" and is how a seat
      // comes to make a confident false claim about a channel.
      let channelId: string | undefined;
      if (params.channel !== undefined) {
        const channel = state.resolveChannelRef(params.channel);
        if (!channel) throw notFound('Channel', params.channel);
        channelId = channel.id;
      }

      let messages: ChatMessage[];
      let sinceId = params.sinceId;
      let allChannelFetchedMessages: ChatMessage[] = [];

      // If workerId provided and no explicit sinceId, use worker's saved cursor
      if (params.workerId && !sinceId && channelId) {
        const worker = state.getWorker(params.workerId);
        if (worker?.chatCursors) {
          sinceId = worker.chatCursors[channelId];
        }
      }

      if (channelId) {
        // Read from a specific channel
        messages = await state.getMessages(channelId, { sinceId, limit });
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

      // Bound the RESPONSE, not just each message. `maxContentChars` caps one
      // message; without this a 200-message read still overflowed an MCP
      // client's payload limit and the whole result was rejected — measured at
      // ~68KB even with maxContentChars: 1, because metadata dominates. Trim
      // the OLDEST of the window: this read already keeps the newest `limit`
      // messages, and the cursor below points at the newest delivered one, so
      // dropping from the front preserves both the semantics and the cursor.
      // Applied BEFORE the cursor is derived, never after.
      if (messages.length > 1) {
        let used = 0;
        let firstKept = 0;
        for (let i = messages.length - 1; i >= 0; i--) {
          used += chatMessageResponseCost(messages[i], maxContentChars);
          if (used > MAX_CHAT_RESPONSE_CHARS && i < messages.length - 1) {
            firstKept = i + 1;
            break;
          }
        }
        if (firstKept > 0) messages = messages.slice(firstKept);
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
        if (channelId) {
          cursorUpdates[channelId] = cursor!;
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
        if (channelId) {
          state.clearUnread(params.workerId, channelId);
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
