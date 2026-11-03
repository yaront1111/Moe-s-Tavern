import type { ToolDefinition } from './index.js';
import type { StateManager } from '../state/StateManager.js';
import { invalidInput, notFound } from '../util/errors.js';

export function chatUnpinTool(_state: StateManager): ToolDefinition {
  return {
    name: 'moe.chat_unpin',
    description: 'Remove a pinned message from a channel.',
    inputSchema: {
      type: 'object',
      properties: {
        channel: { type: 'string', description: 'Channel id, or name in either "general" or "#general" form' },
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

      const channel = state.resolveChannelRef(params.channel);
      if (!channel) throw notFound('Channel', params.channel);

      await state.unpinMessage(channel.id, params.messageId);
      return { success: true };
    }
  };
}
