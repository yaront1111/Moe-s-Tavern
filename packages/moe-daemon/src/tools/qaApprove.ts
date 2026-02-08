import type { ToolDefinition } from './index.js';
import type { StateManager } from '../state/StateManager.js';
import { missingRequired, notFound, invalidState } from '../util/errors.js';

export function qaApproveTool(_state: StateManager): ToolDefinition {
  return {
    name: 'moe.qa_approve',
    description: 'QA approves a task in REVIEW status, moving it to DONE',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'The task ID to approve' },
        summary: { type: 'string', description: 'Summary of QA review (what was verified)' }
      },
      required: ['taskId'],
      additionalProperties: false
    },
    handler: async (args, state) => {
      const params = (args || {}) as { taskId?: string; summary?: string };

      if (!params.taskId) {
        throw missingRequired('taskId');
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
        { status: 'DONE', reviewCompletedAt: new Date().toISOString() },
        'QA_APPROVED'
      );

      return {
        success: true,
        taskId: updated.id,
        status: updated.status,
        summary: params.summary || 'QA approved',
        message: `Task ${updated.id} approved and moved to DONE`
      };
    }
  };
}
