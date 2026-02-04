import type { ToolDefinition } from './index.js';
import type { StateManager } from '../state/StateManager.js';

export function reportBlockedTool(_state: StateManager): ToolDefinition {
  return {
    name: 'moe.report_blocked',
    description: 'Report a worker as blocked on a task',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string' },
        reason: { type: 'string' },
        needsFrom: { type: 'string' },
        currentStepId: { type: 'string' }
      },
      required: ['taskId', 'reason'],
      additionalProperties: false
    },
    handler: async (args, state) => {
      const params = args as {
        taskId: string;
        reason: string;
        needsFrom?: string;
        currentStepId?: string;
      };

      const task = state.getTask(params.taskId);
      if (!task) throw new Error('TASK_NOT_FOUND');

      if (task.assignedWorkerId) {
        await state.updateWorker(task.assignedWorkerId, { status: 'BLOCKED', lastError: params.reason }, 'WORKER_BLOCKED');
      }

      return {
        success: true,
        taskId: task.id,
        taskStatus: task.status,
        workerStatus: 'BLOCKED',
        message: 'Worker marked as blocked. Human has been notified.'
      };
    }
  };
}
