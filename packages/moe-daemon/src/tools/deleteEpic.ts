import type { ToolDefinition } from './index.js';
import type { StateManager } from '../state/StateManager.js';
import { missingRequired, notAllowed } from '../util/errors.js';

export function deleteEpicTool(_state: StateManager): ToolDefinition {
  return {
    name: 'moe.delete_epic',
    description: 'Delete an epic and optionally its tasks',
    inputSchema: {
      type: 'object',
      properties: {
        epicId: { type: 'string', description: 'The ID of the epic to delete' },
        cascadeDelete: {
          type: 'boolean',
          description: 'If true, delete all tasks in the epic. If false (default), fail if epic has tasks.',
          default: false
        }
      },
      required: ['epicId'],
      additionalProperties: false
    },
    handler: async (args, state) => {
      const params = (args || {}) as {
        epicId?: string;
        cascadeDelete?: boolean;
      };

      if (!params.epicId) {
        throw missingRequired('epicId');
      }

      const cascadeDelete = params.cascadeDelete ?? false;

      // Check if epic has tasks
      const snapshot = state.getSnapshot();
      const tasksInEpic = snapshot.tasks.filter(t => t.epicId === params.epicId);

      if (tasksInEpic.length > 0 && !cascadeDelete) {
        throw notAllowed(
          'delete epic',
          `Epic "${params.epicId}" has ${tasksInEpic.length} task(s). Set cascadeDelete: true to delete epic and all its tasks, or move/delete tasks first.`
        );
      }

      // deleteEpic in StateManager already handles cascade deletion
      const epic = await state.deleteEpic(params.epicId);

      return {
        success: true,
        deletedEpic: epic,
        deletedTaskCount: tasksInEpic.length
      };
    }
  };
}
