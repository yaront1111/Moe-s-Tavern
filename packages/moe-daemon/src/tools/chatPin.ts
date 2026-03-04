import type { ToolDefinition } from './index.js';
import type { StateManager } from '../state/StateManager.js';
import { invalidInput } from '../util/errors.js';

export function chatPinTool(_state: StateManager): ToolDefinition {
  return {
    name: 'moe.chat_pin',
    description: 'Pin a chat message to a channel. Pinned messages serve as todos or important references.',
    inputSchema: {
      type: 'object',
      properties: {
        channel: { type: 'string', description: 'Channel ID' },
        messageId: { type: 'string', description: 'Message ID to pin' },
        workerId: { type: 'string', description: 'Worker pinning the message' }
      },
      required: ['channel', 'messageId', 'workerId'],
      additionalProperties: false
    },
    handler: async (args, state) => {
      const params = (args || {}) as {
        channel: string;
        messageId: string;
        workerId: string;
      };

      if (!params.channel || typeof params.channel !== 'string') {
        throw invalidInput('channel', 'must be a non-empty string');
      }
      if (!params.messageId || typeof params.messageId !== 'string') {
        throw invalidInput('messageId', 'must be a non-empty string');
      }
      if (!params.workerId || typeof params.workerId !== 'string') {
        throw invalidInput('workerId', 'must be a non-empty string');
      }

      const pin = await state.pinMessage(params.channel, params.messageId, params.workerId);
      return { success: true, pin };
    }
  };
}
