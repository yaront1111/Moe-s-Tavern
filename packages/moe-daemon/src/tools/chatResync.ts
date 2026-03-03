import type { ToolDefinition } from './index.js';
import type { StateManager } from '../state/StateManager.js';
import type { ChatMessage } from '../types/schema.js';
import { invalidInput } from '../util/errors.js';

export function chatResyncTool(_state: StateManager): ToolDefinition {
  return {
    name: 'moe.chat_resync',
    description: 'Clear chat cursors and return full message history for resync. Useful when a worker loses context or wants to re-read all messages.',
    inputSchema: {
      type: 'object',
      properties: {
        workerId: { type: 'string', description: 'Worker whose cursors to reset' },
        channel: { type: 'string', description: 'Specific channel to resync (omit for all)' },
        limit: { type: 'number', description: 'Max messages per channel (default 50, max 200)' }
      },
      required: ['workerId'],
      additionalProperties: false
    },
    handler: async (args, state) => {
      const params = (args || {}) as {
        workerId: string;
        channel?: string;
        limit?: number;
      };

      if (!params.workerId || typeof params.workerId !== 'string') {
        throw invalidInput('workerId', 'must be a non-empty string');
      }

      const worker = state.getWorker(params.workerId);
      if (!worker) {
        throw invalidInput('workerId', 'worker not found');
      }

      const limit = params.limit !== undefined
        ? Math.min(Math.max(Math.floor(params.limit), 1), 200)
        : 50;

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

      return {
        success: true,
        messagesCount: messages.length,
        messages,
        cursorsReset: true
      };
    }
  };
}
