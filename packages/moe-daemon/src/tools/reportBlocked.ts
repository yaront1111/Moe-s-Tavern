import type { ToolDefinition } from './index.js';
import type { StateManager } from '../state/StateManager.js';
import { notFound } from '../util/errors.js';
import { recommendSkillFor } from '../util/recommendSkill.js';

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
      if (!task) throw notFound('Task', params.taskId);

      if (task.assignedWorkerId) {
        await state.updateWorker(task.assignedWorkerId, { status: 'BLOCKED', lastError: params.reason }, 'WORKER_BLOCKED');
      }

      // Cross-post blocked message to task channel and general channel
      const blockedMsg = `${task.assignedWorkerId || 'worker'} blocked on ${task.id}: ${params.reason}`;
      try { await state.postSystemMessage(task.id, blockedMsg); } catch { /* never block tool */ }
      try { await state.postToGeneral(blockedMsg); } catch { /* never block tool */ }

      // wait_for_task requires both workerId and statuses. Only emit the hint
      // when we can populate them; otherwise omit nextAction to avoid a guaranteed-to-throw suggestion.
      const nextAction = task.assignedWorkerId
        ? {
            tool: 'moe.wait_for_task',
            args: { workerId: task.assignedWorkerId, statuses: [task.status] },
            reason: 'Block reported; wait for human to unblock (via chat) or for a different task to pick up.',
            recommendedSkill: recommendSkillFor('worker', 'task_blocked')
          }
        : undefined;

      return {
        success: true,
        taskId: task.id,
        taskStatus: task.status,
        workerStatus: 'BLOCKED',
        message: 'Worker marked as blocked. Human has been notified.',
        ...(nextAction ? { nextAction } : {})
      };
    }
  };
}
