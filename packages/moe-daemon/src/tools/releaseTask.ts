import type { ToolDefinition } from './index.js';
import type { StateManager } from '../state/StateManager.js';
import { missingRequired, notFound } from '../util/errors.js';

export function releaseTaskTool(_state: StateManager): ToolDefinition {
  return {
    name: 'moe.release_task',
    description: 'Release a task from its assigned worker (clears assignedWorkerId, status unchanged). Anyone can call.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'Task to release' },
        reason: { type: 'string', description: 'Optional human-readable reason' }
      },
      required: ['taskId'],
      additionalProperties: false
    },
    handler: async (args, state) => {
      const params = (args || {}) as { taskId?: string; reason?: string };
      if (!params.taskId) {
        throw missingRequired('taskId');
      }

      return state.runExclusive(async () => {
        const task = state.getTask(params.taskId!);
        if (!task) {
          throw notFound('Task', params.taskId!);
        }

        const previousWorkerId = task.assignedWorkerId;

        if (!previousWorkerId) {
          return {
            success: true,
            taskId: task.id,
            previousWorkerId: null,
            status: task.status,
            message: 'Task already unassigned'
          };
        }

        const updated = await state.updateTask(
          task.id,
          { assignedWorkerId: null },
          'WORKER_RELEASED'
        );

        const worker = state.getWorker(previousWorkerId);
        if (worker && worker.currentTaskId === task.id) {
          await state.updateWorker(previousWorkerId, {
            currentTaskId: null,
            status: 'IDLE'
          });
        }

        const reasonSuffix = params.reason ? ` (${params.reason})` : '';
        const releaseMsg = `🔓 ${previousWorkerId} released task: ${updated.title}${reasonSuffix}`;
        try {
          await state.postToGeneral(releaseMsg);
        } catch { /* never block tool */ }
        try {
          await state.postToRoleChannel('governors', releaseMsg);
        } catch { /* never block tool */ }

        return {
          success: true,
          taskId: updated.id,
          previousWorkerId,
          status: updated.status,
          message: `Task ${updated.id} released from ${previousWorkerId}${reasonSuffix}`
        };
      });
    }
  };
}
