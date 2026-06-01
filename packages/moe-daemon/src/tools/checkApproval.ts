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
        taskId: { type: 'string' },
        workerId: { type: 'string', description: 'Caller worker ID (auto-injected by proxy); used to populate nextAction hints.' }
      },
      required: ['taskId'],
      additionalProperties: false
    },
    handler: async (args, state) => {
      const params = args as { taskId: string; workerId?: string };
      const task = state.getTask(params.taskId);
      if (!task) throw notFound('Task', params.taskId);
      await state.touchWorker(params.workerId);

      const approved = task.status === 'WORKING';
      const rejected = task.status === 'PLANNING' && task.reopenReason !== null;

      // nextAction tells the architect what to do given current approval state.
      // wait_for_task accepts an optional workerId, so include it when we have one.
      let nextAction: { tool: string; args?: Record<string, unknown>; reason?: string } | undefined;
      if (approved) {
        nextAction = {
          tool: 'moe.wait_for_task',
          args: params.workerId ? { statuses: ['PLANNING'], workerId: params.workerId } : { statuses: ['PLANNING'] },
          reason: 'Plan approved and handed to the worker queue. Record any reusable planning insight with Serena write_memory, then block until the next PLANNING task arrives.'
        };
      } else if (rejected) {
        nextAction = {
          tool: 'moe.get_context',
          args: { taskId: task.id },
          reason: 'Plan was rejected; re-read context + rejection reason, then submit revised plan.'
        };
      } else if (task.status === 'AWAITING_APPROVAL') {
        nextAction = {
          tool: 'moe.check_approval',
          args: { taskId: task.id },
          reason: 'Plan awaiting human approval; poll again after a short delay.'
        };
      }

      return {
        taskId: task.id,
        approved,
        status: task.status,
        rejected,
        rejectionReason: task.reopenReason || undefined,
        ...(nextAction ? { nextAction } : {})
      };
    }
  };
}
