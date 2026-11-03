import type { ToolDefinition } from './index.js';
import type { StateManager } from '../state/StateManager.js';
import { missingRequired, notAllowed, notFound } from '../util/errors.js';
import { workerHasRole } from '../util/workerRole.js';

export function deleteTaskTool(_state: StateManager): ToolDefinition {
  return {
    name: 'moe.delete_task',
    description: 'Delete a task by ID',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'The ID of the task to delete' },
        workerId: { type: 'string', description: 'Caller worker ID (auto-injected by proxy); recorded as the actor of TASK_DELETED. A supplied id must resolve to the architect or governor role; omit it for the human path.' }
      },
      required: ['taskId'],
      additionalProperties: false
    },
    handler: async (args, state) => {
      const params = (args || {}) as { taskId?: string; workerId?: unknown };

      if (!params.taskId) {
        throw missingRequired('taskId');
      }

      // TOOL_AUDIENCE only filters tools/list, so this tool gates here like
      // set_task_status (task-629ddc99); an absent workerId key is the human path.
      if (params.workerId !== undefined) {
        const callerId = typeof params.workerId === 'string' ? params.workerId : '';
        if (!workerHasRole(state, callerId, 'architect', 'governor')) {
          throw notAllowed(
            'delete_task',
            `architect or governor role required (worker ${callerId || '(none)'} is not on an architect or governor team and its id declares neither role); ask a governor in #governors to delete the row`
          );
        }
      }

      const task = state.getTask(params.taskId);
      if (!task) {
        throw notFound('Task', params.taskId);
      }

      const actor = typeof params.workerId === 'string' ? params.workerId : undefined;
      const deleted = await state.deleteTask(params.taskId, actor);

      return { success: true, task: deleted };
    }
  };
}
