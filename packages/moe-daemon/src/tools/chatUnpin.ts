import type { ToolDefinition } from './index.js';
import type { StateManager } from '../state/StateManager.js';
import { invalidInput, notAllowed, notFound } from '../util/errors.js';

export function chatUnpinTool(_state: StateManager): ToolDefinition {
  return {
    name: 'moe.chat_unpin',
    description: 'Remove a pinned message from a channel.',
    inputSchema: {
      type: 'object',
      properties: {
        channel: { type: 'string', description: 'Channel id, or name in either "general" or "#general" form' },
        messageId: { type: 'string', description: 'Message ID to unpin' },
        workerId: { type: 'string', description: 'Worker removing the pin (a registered worker or "human"; omitted means "human")' }
      },
      required: ['channel', 'messageId'],
      additionalProperties: false
    },
    handler: async (args, state) => {
      const params = (args || {}) as {
        channel: string;
        messageId: string;
        workerId?: string;
      };

      if (!params.channel || typeof params.channel !== 'string') {
        throw invalidInput('channel', 'must be a non-empty string');
      }
      if (!params.messageId || typeof params.messageId !== 'string') {
        throw invalidInput('messageId', 'must be a non-empty string');
      }

      if (params.workerId !== undefined && typeof params.workerId !== 'string') {
        throw invalidInput('workerId', 'must be a string');
      }

      // workerId becomes the PIN_REMOVED activity actor, so chat_pin's sender rule applies
      // and every refusal precedes the write. 'system' is refused before the registry lookup.
      const actor = params.workerId || 'human';
      if (actor === 'system') {
        throw notAllowed('chat_unpin as "system"', 'reserved for daemon-internal messages');
      }
      if (actor !== 'human' && !state.getWorker(actor) && !state.tryLoadWorkerFromDisk(actor)) {
        throw invalidInput('workerId', 'Unknown sender: workerId must be a registered worker or "human"');
      }
      const channel = state.resolveChannelRef(params.channel);
      if (!channel) throw notFound('Channel', params.channel);

      await state.unpinMessage(channel.id, params.messageId, actor);
      return { success: true };
    }
  };
}
