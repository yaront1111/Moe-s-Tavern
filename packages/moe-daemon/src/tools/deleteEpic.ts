import type { ToolDefinition } from './index.js';
import type { StateManager } from '../state/StateManager.js';
import { missingRequired, notAllowed } from '../util/errors.js';
import { workerHasRole } from '../util/workerRole.js';

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
        },
        workerId: { type: 'string', description: 'Caller worker ID (auto-injected by proxy); recorded as the actor of EPIC_DELETED and each cascaded TASK_DELETED. A supplied id must resolve to the architect or governor role; omit it for the human path.' }
      },
      required: ['epicId'],
      additionalProperties: false
    },
    handler: async (args, state) => {
      const params = (args || {}) as {
        epicId?: string;
        cascadeDelete?: boolean;
        workerId?: unknown;
      };

      if (!params.epicId) {
        throw missingRequired('epicId');
      }

      // TOOL_AUDIENCE only filters tools/list, so this tool gates here like
      // set_task_status (task-629ddc99); an absent workerId key is the human path.
      // Runs before the snapshot read, the cascade refusal and any write.
      if (params.workerId !== undefined) {
        const callerId = typeof params.workerId === 'string' ? params.workerId : '';
        if (!workerHasRole(state, callerId, 'architect', 'governor')) {
          throw notAllowed(
            'delete_epic',
            `architect or governor role required (worker ${callerId || '(none)'} is not on an architect or governor team and its id declares neither role); ask a governor in #governors to delete the epic`
          );
        }
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
      const actor = typeof params.workerId === 'string' ? params.workerId : undefined;
      const epic = await state.deleteEpic(params.epicId, actor);

      return {
        success: true,
        deletedEpic: epic,
        deletedTaskCount: tasksInEpic.length
      };
    }
  };
}
