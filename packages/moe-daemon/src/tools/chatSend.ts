import type { ToolDefinition } from './index.js';
import type { StateManager } from '../state/StateManager.js';
import { missingRequired, invalidInput, notFound } from '../util/errors.js';

export function chatSendTool(_state: StateManager): ToolDefinition {
  return {
    name: 'moe.chat_send',
    description: 'Send a chat message to a channel. Parses @mentions and returns routing info.',
    inputSchema: {
      type: 'object',
      properties: {
        channel: { type: 'string', description: 'Channel ID to send to' },
        content: { type: 'string', description: 'Message text (max 10KB)' },
        workerId: { type: 'string', description: 'Sender worker ID (defaults to "human")' },
        replyTo: { type: 'string', description: 'Message ID to reply to (threading)' }
      },
      required: ['channel', 'content'],
      additionalProperties: false
    },
    handler: async (args, state) => {
      const params = (args || {}) as {
        channel?: string;
        content?: string;
        workerId?: string;
        replyTo?: string;
      };

      if (!params.channel) throw missingRequired('channel');
      if (!params.content) throw missingRequired('content');

      if (typeof params.content !== 'string') {
        throw invalidInput('content', 'must be a string');
      }

      // Validate sender identity
      const sender = params.workerId || 'human';
      if (sender !== 'human' && sender !== 'system') {
        let worker = state.getWorker(sender);
        if (!worker) {
          // Disk fallback: worker file may exist but state hasn't reloaded yet
          worker = state.tryLoadWorkerFromDisk(sender);
        }
        if (!worker) {
          throw invalidInput('workerId', 'Unknown sender: workerId must be a registered worker, "human", or "system"');
        }
      }

      const channel = state.getChannel(params.channel);
      if (!channel) throw notFound('Channel', params.channel);

      const { message, routingTargets } = await state.sendMessage({
        channel: params.channel,
        sender,
        content: params.content,
        replyTo: params.replyTo
      });

      return {
        success: true,
        messageId: message.id,
        channel: message.channel,
        timestamp: message.timestamp,
        routingTargets
      };
    }
  };
}
