import type { ToolDefinition } from './index.js';
import type { StateManager } from '../state/StateManager.js';
import { notFound } from '../util/errors.js';

export function completeTaskTool(_state: StateManager): ToolDefinition {
  return {
    name: 'moe.complete_task',
    description: 'Mark a task as complete (move to REVIEW)',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string' },
        prLink: { type: 'string' },
        summary: { type: 'string' }
      },
      required: ['taskId'],
      additionalProperties: false
    },
    handler: async (args, state) => {
      const params = args as { taskId: string; prLink?: string; summary?: string };
      const task = state.getTask(params.taskId);
      if (!task) throw notFound('Task', params.taskId);

      const updated = await state.updateTask(
        task.id,
        { status: 'REVIEW', prLink: params.prLink || task.prLink },
        'TASK_COMPLETED'
      );

      if (params.prLink) {
        state.appendActivity('PR_OPENED', { prLink: params.prLink }, updated);
      }

      // Safely handle implementationPlan which could be null/undefined or empty
      const implementationPlan = updated.implementationPlan || [];
      const completedSteps = implementationPlan.filter((s) => s.status === 'COMPLETED');
      const modified = completedSteps.flatMap((s) => s.affectedFiles || []);

      return {
        success: true,
        taskId: updated.id,
        status: 'REVIEW',
        stats: {
          stepsCompleted: completedSteps.length,
          totalSteps: implementationPlan.length,
          filesModified: Array.from(new Set(modified)),
          duration: 'n/a'
        }
      };
    }
  };
}
