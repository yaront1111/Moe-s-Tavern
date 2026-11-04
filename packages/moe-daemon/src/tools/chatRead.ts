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
    description: 'Read chat messages from a channel with cursor-based pagination. Auto-tracks read position per worker. '
      + 'Skips the daemon\'s status lines in #general (system posts that mention nobody) unless includeSystem is true. '
      + 'A read with sinceId is a peek that moves no stored cursor or unread count; in all-channel mode the id applies only '
      + 'to the channel that holds it, and the other channels read from the caller\'s stored cursor. '
      + 'Omit sinceId to read from and advance your cursor.',
    inputSchema: {
      type: 'object',
      properties: {
        channel: { type: 'string', description: 'Channel id, or name in either "general" or "#general" form (omit to read from all channels)' },
        workerId: { type: 'string', description: 'Worker ID for auto-cursor tracking' },
        sinceId: { type: 'string', description: 'Return messages after this message ID. A peek: moves no stored cursor and clears no unread count' },
        limit: { type: 'number', description: 'Max messages to return (default 10, max 200)' },
        maxContentChars: {
          type: 'number',
          description: 'Max chars per message content in the response (default 1000, 0 = full content)'
        },
        includeSystem: {
          type: 'boolean',
          description: 'Also return the daemon\'s status lines in #general (task moved, claimed, step completed...). Default false.'
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
        includeSystem?: boolean;
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
      const hideSystemFeed = params.includeSystem !== true;

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

      // An explicit sinceId makes this read a PEEK: it pages from that id but
      // writes no stored cursor and clears no unread count. Otherwise it would
      // rewind the cursor chat_wait drains from (re-delivering handled
      // messages) or jump past unread ones. An empty string stays cursor mode.
      const explicitSinceId = params.sinceId || undefined;
      const peek = explicitSinceId !== undefined;

      // If workerId provided and no explicit sinceId, use worker's saved cursor
      if (params.workerId && !sinceId && channelId) {
        const worker = state.getWorker(params.workerId);
        if (worker?.chatCursors) {
          sinceId = worker.chatCursors[channelId];
        }
      }

      if (channelId) {
        // Read from a specific channel
        messages = await state.getMessages(channelId, { sinceId, limit, hideSystemFeed });
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
          // An explicit id belongs to ONE channel (collectChatBacklog applies the
          // same rule). Applied to a channel that does not hold it, it would trip
          // getMessages' expired-cursor fallback and return that channel's newest
          // window; those channels read from the caller's stored cursor instead
          // (none without a workerId, which keeps the newest window).
          const chSinceId = explicitSinceId && state.messageExistsInChannel(ch.id, explicitSinceId)
            ? explicitSinceId
            : existingCursors[ch.id];
          const chMessages = await state.getMessages(ch.id, { sinceId: chSinceId, limit, hideSystemFeed });
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

      // Update worker's chat cursor atomically if workerId provided (not on a peek)
      if (params.workerId && !peek && messages.length > 0) {
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
      // by a cursor-mode read; a peek leaves them for the next one
      if (params.workerId && !peek && messages.length > 0) {
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
