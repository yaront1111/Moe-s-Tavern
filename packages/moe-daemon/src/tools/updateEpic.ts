import type { ToolDefinition } from './index.js';
import type { StateManager } from '../state/StateManager.js';
import type { EpicStatus } from '../types/schema.js';
import { invalidInput, missingRequired } from '../util/errors.js';

/**
 * Refuses, before any write, a designation that could never be epic-final: an id
 * naming no task, a task of another epic, or an ARCHIVED task. Blank (clear) and
 * non-string values pass through to validateEpicUpdates, as does a missing epic,
 * which keeps state.updateEpic's `Epic not found` error.
 */
function assertDesignatable(state: StateManager, epicId: string, finalTaskId: unknown): void {
  if (typeof finalTaskId !== 'string' || !state.getEpic(epicId)) return;
  const id = finalTaskId.trim();
  if (id === '') return;
  const task = state.getTask(id);
  if (!task) throw invalidInput('finalTaskId', `names no task: ${id}`);
  if (task.epicId !== epicId) {
    throw invalidInput('finalTaskId', `task ${id} belongs to epic ${task.epicId}, not ${epicId}`);
  }
  if (task.status === 'ARCHIVED') {
    throw invalidInput('finalTaskId', `task ${id} is ARCHIVED and can never be epic-final`);
  }
}

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
        order: { type: 'number', description: 'Display order' },
        finalTaskId: {
          type: 'string',
          description: "Designate the epic's final (integration-and-hardening) task by id. get_context isEpicFinal and the epicFinal quality-gate scope follow it whatever the board order. An empty string clears it, and the epic falls back to the highest order."
        }
      },
      required: ['epicId'],
      additionalProperties: false
    },
    handler: async (args, state) => {
      const raw = (args || {}) as Record<string, unknown>;
      // Proxy auto-injects workerId from MOE_WORKER_ID env into every tools/call;
      // update_epic doesn't use it, so drop it before strict-field validation.
      delete raw.workerId;
      const allowedFields = new Set(['epicId', 'title', 'description', 'architectureNotes', 'epicRails', 'status', 'order', 'finalTaskId']);
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
        finalTaskId?: string;
      };

      if (!params.epicId) {
        throw missingRequired('epicId');
      }
      assertDesignatable(state, params.epicId, params.finalTaskId);

      const updates: Partial<{
        title: string;
        description: string;
        architectureNotes: string;
        epicRails: string[];
        status: EpicStatus;
        order: number;
        finalTaskId: string;
      }> = {};

      if (params.title !== undefined) updates.title = params.title;
      if (params.description !== undefined) updates.description = params.description;
      if (params.architectureNotes !== undefined) updates.architectureNotes = params.architectureNotes;
      if (params.epicRails !== undefined) updates.epicRails = params.epicRails;
      if (params.status !== undefined) updates.status = params.status;
      if (params.order !== undefined) updates.order = params.order;
      if (params.finalTaskId !== undefined) updates.finalTaskId = params.finalTaskId;

      const epic = await state.updateEpic(params.epicId, updates);

      return { success: true, epic };
    }
  };
}
