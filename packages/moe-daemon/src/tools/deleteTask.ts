import type { ToolDefinition } from './index.js';
import type { StateManager } from '../state/StateManager.js';
import { missingRequired, notFound } from '../util/errors.js';

export function deleteTaskTool(_state: StateManager): ToolDefinition {
  return {
    name: 'moe.delete_task',
    description: 'Delete a task by ID',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'The ID of the task to delete' },
        workerId: { type: 'string', description: 'Caller worker ID (auto-injected by proxy); recorded as the actor of TASK_DELETED' }
      },
      required: ['taskId'],
      additionalProperties: false
    },
    handler: async (args, state) => {
      const params = (args || {}) as { taskId?: string; workerId?: string };

      if (!params.taskId) {
        throw missingRequired('taskId');
      }

      const task = state.getTask(params.taskId);
      if (!task) {
        throw notFound('Task', params.taskId);
      }

      const deleted = await state.deleteTask(params.taskId, params.workerId);

      return { success: true, task: deleted };
    }
  };
}
