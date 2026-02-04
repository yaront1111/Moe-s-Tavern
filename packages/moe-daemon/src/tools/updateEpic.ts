import type { ToolDefinition } from './index.js';
import type { StateManager } from '../state/StateManager.js';
import type { EpicStatus } from '../types/schema.js';

export function updateEpicTool(_state: StateManager): ToolDefinition {
  return {
    name: 'moe.update_epic',
    description: 'Update an existing epic',
    inputSchema: {
      type: 'object',
      properties: {
        epicId: { type: 'string', description: 'The ID of the epic to update' },
        title: { type: 'string', description: 'New title for the epic' },
        description: { type: 'string', description: 'New description' },
        architectureNotes: { type: 'string', description: 'Architecture notes and technical guidance' },
        epicRails: { type: 'array', items: { type: 'string' }, description: 'Constraints that apply to all tasks in this epic' },
        status: { type: 'string', enum: ['ACTIVE', 'COMPLETED', 'ARCHIVED'], description: 'Epic status' },
        order: { type: 'number', description: 'Display order' }
      },
      required: ['epicId'],
      additionalProperties: false
    },
    handler: async (args, state) => {
      const params = (args || {}) as {
        epicId?: string;
        title?: string;
        description?: string;
        architectureNotes?: string;
        epicRails?: string[];
        status?: EpicStatus;
        order?: number;
      };

      if (!params.epicId) {
        throw new Error('epicId is required');
      }

      const updates: Partial<{
        title: string;
        description: string;
        architectureNotes: string;
        epicRails: string[];
        status: EpicStatus;
        order: number;
      }> = {};

      if (params.title !== undefined) updates.title = params.title;
      if (params.description !== undefined) updates.description = params.description;
      if (params.architectureNotes !== undefined) updates.architectureNotes = params.architectureNotes;
      if (params.epicRails !== undefined) updates.epicRails = params.epicRails;
      if (params.status !== undefined) updates.status = params.status;
      if (params.order !== undefined) updates.order = params.order;

      const epic = await state.updateEpic(params.epicId, updates);

      return { success: true, epic };
    }
  };
}
