import type { ToolDefinition } from './index.js';
import type { StateManager } from '../state/StateManager.js';
import { missingRequired, notFound } from '../util/errors.js';

export function reflectTool(_state: StateManager): ToolDefinition {
  return {
    name: 'moe.reflect',
    description: 'Rate a memory as helpful or unhelpful. Helpful memories gain confidence and surface more often. Unhelpful ones fade over time.',
    inputSchema: {
      type: 'object',
      properties: {
        memoryId: { type: 'string', description: 'The memory ID to rate' },
        helpful: { type: 'boolean', description: 'true if the memory was useful, false if not' },
        workerId: { type: 'string', description: 'Your worker ID' },
      },
      required: ['memoryId', 'helpful', 'workerId'],
      additionalProperties: false,
    },
    handler: async (args, state) => {
      const params = (args || {}) as { memoryId?: string; helpful?: boolean; workerId?: string };

      if (!params.memoryId) throw missingRequired('memoryId');
      if (params.helpful === undefined) throw missingRequired('helpful');
      if (!params.workerId) throw missingRequired('workerId');

      const mm = state.getMemoryManager();
      const result = await mm.recordFeedback(params.memoryId, params.helpful);

      if (!result) throw notFound('Memory', params.memoryId);

      return {
        memoryId: params.memoryId,
        helpful: params.helpful,
        newConfidence: Math.round(result.confidence * 100) / 100,
        message: params.helpful
          ? 'Memory marked as helpful — confidence increased'
          : 'Memory marked as unhelpful — confidence decreased',
      };
    },
  };
}
