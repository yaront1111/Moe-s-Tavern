import type { ToolDefinition } from './index.js';
import type { StateManager } from '../state/StateManager.js';

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
        throw new Error('taskId is required');
      }

      if (!params.reason || params.reason.trim().length === 0) {
        throw new Error('reason is required - explain which DoD items failed and why');
      }

      // Validate reason length to prevent excessive data storage
      const MAX_REASON_LENGTH = 2000;
      if (params.reason.length > MAX_REASON_LENGTH) {
        throw new Error(`reason too long (${params.reason.length} chars). Maximum ${MAX_REASON_LENGTH} characters allowed.`);
      }

      const task = state.getTask(params.taskId);
      if (!task) {
        throw new Error(`Task not found: ${params.taskId}`);
      }

      if (task.status !== 'REVIEW') {
        throw new Error(
          `Task must be in REVIEW status to reject. Current status: ${task.status}`
        );
      }

      const updated = await state.updateTask(
        params.taskId,
        {
          status: 'WORKING',
          reopenCount: task.reopenCount + 1,
          reopenReason: params.reason
        },
        'TASK_REOPENED'
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
