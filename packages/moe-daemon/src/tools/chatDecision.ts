import type { ToolDefinition } from './index.js';
import type { StateManager } from '../state/StateManager.js';
import { invalidInput } from '../util/errors.js';

export function chatDecisionTool(_state: StateManager): ToolDefinition {
  return {
    name: 'moe.chat_decision',
    description: 'Propose a decision for human approval. Optionally post to a chat channel.',
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'Decision content (what is being proposed)' },
        channel: { type: 'string', description: 'Optional channel ID to post the decision to' },
        workerId: { type: 'string', description: 'Worker proposing the decision' }
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

      const decision = await state.createDecision({
        content: params.content.trim(),
        proposedBy: params.workerId || 'unknown',
        channel: params.channel
      });

      return { success: true, decision };
    }
  };
}
