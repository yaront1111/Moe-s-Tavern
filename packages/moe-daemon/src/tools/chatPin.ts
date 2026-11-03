import type { ToolDefinition } from './index.js';
import type { StateManager } from '../state/StateManager.js';
import { invalidInput, notAllowed, notFound } from '../util/errors.js';

export function chatPinTool(_state: StateManager): ToolDefinition {
  return {
    name: 'moe.chat_pin',
    description: 'Pin a chat message to a channel. Pinned messages serve as todos or important references.',
    inputSchema: {
      type: 'object',
      properties: {
        channel: { type: 'string', description: 'Channel id, or name in either "general" or "#general" form' },
        messageId: { type: 'string', description: 'Message ID to pin' },
        workerId: { type: 'string', description: 'Worker pinning the message (a registered worker or "human")' }
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

      // workerId becomes pinnedBy in the pins file, PINS_UPDATED and PIN_CREATED, so
      // chat_send's sender rule applies and every refusal precedes the write.
      if (params.workerId === 'system') {
        throw notAllowed('chat_pin as "system"', 'reserved for daemon-internal messages');
      }
      if (params.workerId !== 'human' && !state.getWorker(params.workerId) && !state.tryLoadWorkerFromDisk(params.workerId)) {
        throw invalidInput('workerId', 'Unknown sender: workerId must be a registered worker or "human"');
      }
      const channel = state.resolveChannelRef(params.channel);
      if (!channel) throw notFound('Channel', params.channel);

      const pin = await state.pinMessage(channel.id, params.messageId, params.workerId);
      return { success: true, pin };
    }
  };
}
