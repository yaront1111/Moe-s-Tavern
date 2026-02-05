import type { ToolDefinition } from './index.js';
import type { StateManager } from '../state/StateManager.js';
import type { EpicStatus } from '../types/schema.js';
import { missingRequired } from '../util/errors.js';

export function createEpicTool(_state: StateManager): ToolDefinition {
  return {
    name: 'moe.create_epic',
    description: 'Create a new epic',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        description: { type: 'string' },
        architectureNotes: { type: 'string' },
        epicRails: { type: 'array', items: { type: 'string' } },
        status: { type: 'string' },
        order: { type: 'number' }
      },
      required: ['title'],
      additionalProperties: false
    },
    handler: async (args, state) => {
      const params = (args || {}) as {
        title?: string;
        description?: string;
        architectureNotes?: string;
        epicRails?: string[];
        status?: EpicStatus;
        order?: number;
      };

      if (!params.title) {
        throw missingRequired('title');
      }

      const epic = await state.createEpic({
        title: params.title,
        description: params.description,
        architectureNotes: params.architectureNotes,
        epicRails: params.epicRails,
        status: params.status,
        order: params.order
      });

      return { success: true, epic };
    }
  };
}
