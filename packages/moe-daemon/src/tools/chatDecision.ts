import type { ToolDefinition } from './index.js';
import type { StateManager } from '../state/StateManager.js';
import { invalidInput, notAllowed, notFound } from '../util/errors.js';

export function chatDecisionTool(_state: StateManager): ToolDefinition {
  return {
    name: 'moe.chat_decision',
    description: 'Propose a decision for human approval. Optionally post to a chat channel.',
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'Decision content (what is being proposed)' },
        channel: { type: 'string', description: 'Optional channel to post the decision to: id, or name in either "general" or "#general" form' },
        workerId: { type: 'string', description: 'Worker proposing the decision (a registered worker or "human")' }
      },
      required: ['content'],
      additionalProperties: false
    },
    handler: async (args, state) => {
      const params = (args || {}) as {
        content: string;
        channel?: string;
        workerId?: string;
      };

      if (!params.content || typeof params.content !== 'string' || !params.content.trim()) {
        throw invalidInput('content', 'must be a non-empty string');
      }

      // The post is sent under this id: 'system' would impersonate the daemon,
      // and an unregistered id takes MentionRouter's human path
      // (util/mentionRouter.ts:216-235), which resets the loop guard. Same
      // rule as chat_send; every refusal precedes any write.
      if (params.workerId) {
        if (params.workerId === 'system') {
          throw notAllowed('chat_decision as "system"', 'reserved for daemon-internal messages');
        }
        if (params.workerId !== 'human'
          && !state.getWorker(params.workerId)
          && !state.tryLoadWorkerFromDisk(params.workerId)) {
          throw invalidInput('workerId', 'Unknown sender: workerId must be a registered worker or "human"');
        }
      }

      let channelId: string | undefined;
      if (params.channel !== undefined && params.channel !== null && params.channel !== '') {
        if (typeof params.channel !== 'string') throw invalidInput('channel', 'must be a string');
        const channel = state.resolveChannelRef(params.channel);
        if (!channel) throw notFound('Channel', params.channel);
        channelId = channel.id;
      }

      const decision = await state.createDecision({
        content: params.content.trim(),
        proposedBy: params.workerId || 'unknown',
        channel: channelId
      });

      return { success: true, decision };
    }
  };
}
