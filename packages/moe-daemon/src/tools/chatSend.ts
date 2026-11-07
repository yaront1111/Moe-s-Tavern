import type { ToolDefinition } from './index.js';
import type { StateManager } from '../state/StateManager.js';
import { missingRequired, invalidInput, notFound, notAllowed } from '../util/errors.js';
import { loopGuardPausedHint } from '../util/mentionRouter.js';

export function chatSendTool(_state: StateManager): ToolDefinition {
  return {
    name: 'moe.chat_send',
    description: 'Send a chat message to a channel. Parses @mentions and returns routing info. routingPaused: true (with a hint) means the channel\'s loop guard stored the message but woke nobody.',
    inputSchema: {
      type: 'object',
      properties: {
        channel: { type: 'string', description: 'Channel id, or name in either "general" or "#general" form' },
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

      // Validate sender identity. 'system' is reserved for daemon-internal
      // posts (which go straight through state.sendMessage); accepting it here
      // would let any /mcp agent impersonate the daemon and reset the
      // mentionRouter loop-guard (hopCounts=0, unpause), defeating runaway
      // protection.
      const sender = params.workerId || 'human';
      if (sender === 'system') {
        throw notAllowed('chat_send as "system"', 'reserved for daemon-internal messages');
      }
      if (sender !== 'human') {
        let worker = state.getWorker(sender);
        if (!worker) {
          // Disk fallback: worker file may exist but state hasn't reloaded yet
          worker = state.tryLoadWorkerFromDisk(sender);
        }
        if (!worker) {
          throw invalidInput('workerId', 'Unknown sender: workerId must be a registered worker or "human"');
        }
      }

      const channel = state.resolveChannelRef(params.channel);
      if (!channel) throw notFound('Channel', params.channel);

      // Validate replyTo points to a real message in the same channel, whatever
      // its age (the whole JSONL, not only getMessages' newest window).
      if (params.replyTo) {
        if (typeof params.replyTo !== 'string') {
          throw invalidInput('replyTo', 'must be a string');
        }
        if (!state.messageExistsAnywhereInChannel(channel.id, params.replyTo)) {
          throw invalidInput('replyTo', `message ${params.replyTo} not found in channel ${params.channel}`);
        }
      }

      // channel.id, never the caller's reference: a message stored under
      // "#general" would belong to no channel any reader can fetch.
      const { message, routingTargets, routingPaused, hopCount } = await state.sendMessage({
        channel: channel.id,
        sender,
        content: params.content,
        replyTo: params.replyTo
      });
      if (sender !== 'human') {
        await state.touchWorker(sender);
      }

      return {
        success: true,
        messageId: message.id,
        channel: message.channel,
        timestamp: message.timestamp,
        routingTargets,
        routingPaused,
        ...(routingPaused
          ? {
            hint: `${loopGuardPausedHint(channel.name, hopCount, state.mentionRouter.getHopWindowMs())} ` +
              'moe.add_comment on the recipient\'s task reaches them now.'
          }
          : {})
      };
    }
  };
}
