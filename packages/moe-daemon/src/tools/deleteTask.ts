import type { ToolDefinition } from './index.js';
import type { StateManager } from '../state/StateManager.js';

export function deleteTaskTool(_state: StateManager): ToolDefinition {
  return {
    name: 'moe.delete_task',
    description: 'Delete a task by ID',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'The ID of the task to delete' }
      },
      required: ['taskId'],
      additionalProperties: false
    },
    handler: async (args, state) => {
      const params = (args || {}) as { taskId?: string };

      if (!params.taskId) {
        throw new Error('taskId is required');
      }

      const task = state.getTask(params.taskId);
      if (!task) {
        throw new Error(`Task not found: ${params.taskId}`);
      }

      const deleted = await state.deleteTask(params.taskId);

      return { success: true, task: deleted };
    }
  };
}
