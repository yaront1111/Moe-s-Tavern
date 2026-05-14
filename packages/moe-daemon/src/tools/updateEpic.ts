import type { ToolDefinition } from './index.js';
import type { StateManager } from '../state/StateManager.js';
import type { EpicStatus } from '../types/schema.js';
import { invalidInput, missingRequired } from '../util/errors.js';

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
        status: { type: 'string', enum: ['PLANNED', 'ACTIVE', 'COMPLETED'], description: 'Epic status' },
        order: { type: 'number', description: 'Display order' }
      },
      required: ['epicId'],
      additionalProperties: false
    },
    handler: async (args, state) => {
      const raw = (args || {}) as Record<string, unknown>;
      // Proxy auto-injects workerId from MOE_WORKER_ID env into every tools/call;
      // update_epic doesn't use it, so drop it before strict-field validation.
      delete raw.workerId;
      const allowedFields = new Set(['epicId', 'title', 'description', 'architectureNotes', 'epicRails', 'status', 'order']);
      for (const field of Object.keys(raw)) {
        if (!allowedFields.has(field)) {
          throw invalidInput(field, 'is not a supported epic update field');
        }
      }

      const params = raw as {
        epicId?: string;
        title?: string;
        description?: string;
        architectureNotes?: string;
        epicRails?: string[];
        status?: EpicStatus;
        order?: number;
      };

      if (!params.epicId) {
        throw missingRequired('epicId');
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
