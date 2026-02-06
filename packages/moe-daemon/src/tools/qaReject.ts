import type { ToolDefinition } from './index.js';
import type { StateManager } from '../state/StateManager.js';
import { missingRequired, invalidInput, notFound, invalidState } from '../util/errors.js';

export function qaRejectTool(_state: StateManager): ToolDefinition {
  return {
    name: 'moe.qa_reject',
    description: 'QA rejects a task in REVIEW status, moving it back to WORKING for fixes',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'The task ID to reject' },
        reason: {
          type: 'string',
          description: 'Detailed reason for rejection - should reference specific DoD items that failed'
        }
      },
      required: ['taskId', 'reason'],
      additionalProperties: false
    },
    handler: async (args, state) => {
      const params = (args || {}) as { taskId?: string; reason?: string };

      if (!params.taskId) {
        throw missingRequired('taskId');
      }

      if (!params.reason || params.reason.trim().length === 0) {
        throw missingRequired('reason');
      }

      // Validate reason length to prevent excessive data storage
      const MAX_REASON_LENGTH = 2000;
      if (params.reason.length > MAX_REASON_LENGTH) {
        throw invalidInput('reason', `too long (${params.reason.length} chars). Maximum ${MAX_REASON_LENGTH} characters allowed.`);
      }

      const task = state.getTask(params.taskId);
      if (!task) {
        throw notFound('Task', params.taskId);
      }

      if (task.status !== 'REVIEW') {
        throw invalidState('Task', task.status, 'REVIEW');
      }

      const updated = await state.updateTask(
        params.taskId,
        {
          status: 'WORKING',
          reopenCount: task.reopenCount + 1,
          reopenReason: params.reason
        },
        'QA_REJECTED'
      );

      return {
        success: true,
        taskId: updated.id,
        status: updated.status,
        reopenCount: updated.reopenCount,
        reason: params.reason,
        message: `Task ${updated.id} rejected and moved to WORKING. Worker should address: ${params.reason}`
      };
    }
  };
}
