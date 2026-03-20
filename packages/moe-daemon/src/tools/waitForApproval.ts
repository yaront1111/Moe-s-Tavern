import type { ToolDefinition } from './index.js';
import type { StateManager } from '../state/StateManager.js';
import { notFound, missingRequired } from '../util/errors.js';
import { logger } from '../util/logger.js';

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const MAX_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

export function waitForApprovalTool(_state: StateManager): ToolDefinition {
  return {
    name: 'moe.wait_for_approval',
    description: 'Block until a task in AWAITING_APPROVAL is approved or rejected. Returns immediately if the task is already WORKING (approved) or PLANNING with reopenReason (rejected).',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'The task ID to wait for approval on' },
        timeoutMs: { type: 'number', description: 'Max wait time in ms (default 300000, max 600000)' }
      },
      required: ['taskId'],
      additionalProperties: false
    },
    handler: async (args, state) => {
      const params = (args || {}) as { taskId?: string; timeoutMs?: number };
      const taskId = params.taskId;
      if (!taskId) {
        throw missingRequired('taskId');
      }

      const task = state.getTask(taskId);
      if (!task) throw notFound('Task', taskId);

      // Already approved - return immediately
      if (task.status === 'WORKING') {
        return { approved: true, taskId };
      }

      // Already rejected (back to PLANNING with a reason) - return immediately
      if (task.status === 'PLANNING' && task.reopenReason !== null) {
        return { rejected: true, reason: task.reopenReason, taskId };
      }

      // If not in AWAITING_APPROVAL, return current status
      if (task.status !== 'AWAITING_APPROVAL') {
        return { approved: false, rejected: false, timedOut: false, status: task.status, taskId };
      }

      const timeoutMs = Math.min(
        Math.max(params.timeoutMs || DEFAULT_TIMEOUT_MS, 1000),
        MAX_TIMEOUT_MS
      );

      logger.info({ taskId, timeoutMs }, 'Waiting for task approval');

      return new Promise<unknown>((resolve) => {
        const cleanup = () => {
          clearTimeout(timer);
          unsubscribe();
        };

        const timer = setTimeout(() => {
          cleanup();
          logger.info({ taskId }, 'Wait for approval timed out');
          resolve({ timedOut: true, taskId });
        }, timeoutMs);

        // Don't prevent process exit
        if (timer.unref) {
          timer.unref();
        }

        const unsubscribe = state.subscribe((event) => {
          if (event.type !== 'TASK_UPDATED') return;
          if (event.payload.id !== taskId) return;

          const updatedTask = event.payload;

          // Approved - task moved to WORKING
          if (updatedTask.status === 'WORKING') {
            cleanup();
            logger.info({ taskId }, 'Task approved');
            resolve({ approved: true, taskId });
            return;
          }

          // Rejected - task moved back to PLANNING
          if (updatedTask.status === 'PLANNING') {
            cleanup();
            logger.info({ taskId, reason: updatedTask.reopenReason }, 'Task rejected');
            resolve({ rejected: true, reason: updatedTask.reopenReason, taskId });
            return;
          }
        });
      });
    }
  };
}
