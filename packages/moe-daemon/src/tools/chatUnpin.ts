import type { ToolDefinition } from './index.js';
import type { StateManager } from '../state/StateManager.js';
import { invalidInput } from '../util/errors.js';

export function chatUnpinTool(_state: StateManager): ToolDefinition {
  return {
    name: 'moe.chat_unpin',
    description: 'Remove a pinned message from a channel.',
    inputSchema: {
      type: 'object',
      properties: {
        channel: { type: 'string', description: 'Channel ID' },
        messageId: { type: 'string', description: 'Message ID to unpin' }
      },
      required: ['channel', 'messageId'],
      additionalProperties: false
    },
    handler: async (args, state) => {
      const params = (args || {}) as {
        channel: string;
        messageId: string;
      };

      if (!params.channel || typeof params.channel !== 'string') {
        throw invalidInput('channel', 'must be a non-empty string');
      }
      if (!params.messageId || typeof params.messageId !== 'string') {
        throw invalidInput('messageId', 'must be a non-empty string');
      }

      await state.unpinMessage(params.channel, params.messageId);
      return { success: true };
    }
  };
}
