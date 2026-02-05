import type { ToolDefinition } from './index.js';
import type { StateManager } from '../state/StateManager.js';
import { notFound } from '../util/errors.js';

export function checkApprovalTool(_state: StateManager): ToolDefinition {
  return {
    name: 'moe.check_approval',
    description: 'Check if a task plan has been approved',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string' }
      },
      required: ['taskId'],
      additionalProperties: false
    },
    handler: async (args, state) => {
      const params = args as { taskId: string };
      const task = state.getTask(params.taskId);
      if (!task) throw notFound('Task', params.taskId);

      return {
        taskId: task.id,
        approved: task.status === 'WORKING',
        status: task.status,
        rejected: task.status === 'PLANNING' && task.reopenReason !== null,
        rejectionReason: task.reopenReason || undefined
      };
    }
  };
}
