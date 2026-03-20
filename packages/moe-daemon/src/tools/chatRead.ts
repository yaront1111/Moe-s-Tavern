import type { ToolDefinition } from './index.js';
import type { StateManager } from '../state/StateManager.js';
import type { ChatMessage } from '../types/schema.js';
import { invalidInput } from '../util/errors.js';

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
        limit: { type: 'number', description: 'Max messages to return (default 20, max 200)' }
      },
      additionalProperties: false
    },
    handler: async (args, state) => {
      const params = (args || {}) as {
        channel?: string;
        workerId?: string;
        sinceId?: string;
        limit?: number;
      };

      const limit = params.limit !== undefined
        ? Math.min(Math.max(Math.floor(params.limit), 1), 200)
        : 20;

      if (params.limit !== undefined && (typeof params.limit !== 'number' || params.limit < 1)) {
        throw invalidInput('limit', 'must be a positive number');
      }

      let messages: ChatMessage[];
      let sinceId = params.sinceId;
      let fullCursorMap: Record<string, string> | null = null;

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
        // Seed cursor map with existing cursors so empty channels retain theirs
        const existingCursors = params.workerId
          ? (state.getWorker(params.workerId)?.chatCursors || {})
          : {};
        fullCursorMap = { ...existingCursors };
        for (const ch of channels) {
          const chSinceId = params.workerId && !params.sinceId
            ? existingCursors[ch.id]
            : sinceId;
          const chMessages = await state.getMessages(ch.id, { sinceId: chSinceId, limit });
          allMessages.push(...chMessages);
        }
        // Overwrite cursors for channels that have new messages
        for (const msg of allMessages) {
          fullCursorMap[msg.channel] = msg.id;
        }

        messages = allMessages
          .sort((a, b) => a.timestamp.localeCompare(b.timestamp))
          .slice(-limit);
      }

      const cursor = messages.length > 0 ? messages[messages.length - 1].id : sinceId || null;

      // Update worker's chat cursor atomically if workerId provided
      if (params.workerId && messages.length > 0) {
        const cursorUpdates: Record<string, string> = {};
        if (params.channel) {
          cursorUpdates[params.channel] = cursor!;
        } else if (fullCursorMap) {
          Object.assign(cursorUpdates, fullCursorMap);
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
          state.clearUnread(params.workerId);
        }
      }

      return {
        messages,
        cursor
      };
    }
  };
}
