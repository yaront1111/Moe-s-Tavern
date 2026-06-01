import type { ToolDefinition } from './index.js';
import type { StateManager } from '../state/StateManager.js';
import { notFound, invalidState } from '../util/errors.js';
import { assertWorkerOwns, assertAllStepsCompleted } from '../util/enforcement.js';

export function completeTaskTool(_state: StateManager): ToolDefinition {
  return {
    name: 'moe.complete_task',
    description: 'Mark a task as complete (move to REVIEW)',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string' },
        prLink: { type: 'string' },
        summary: { type: 'string' },
        workerId: { type: 'string' }
      },
      required: ['taskId'],
      additionalProperties: false
    },
    handler: async (args, state) => {
      const params = args as { taskId: string; prLink?: string; summary?: string; workerId?: string };
      const task = state.getTask(params.taskId);
      if (!task) throw notFound('Task', params.taskId);

      if (task.status !== 'WORKING') {
        throw invalidState('Task', task.status, 'WORKING');
      }
      assertWorkerOwns(task, params.workerId);
      assertAllStepsCompleted(task);

      // Capture the worker to IDLE *after* the task update so a failed updateTask
      // doesn't leave the worker idle while the task is still WORKING (half-applied state).
      const handoffWorkerId = task.assignedWorkerId || params.workerId;

      const now = new Date().toISOString();
      const updated = await state.updateTask(
        task.id,
        { status: 'REVIEW', prLink: params.prLink || task.prLink, completedAt: now, reviewStartedAt: now },
        'TASK_COMPLETED'
      );

      // updateTask clears assignedWorkerId on WORKING -> REVIEW handoff; touchWorker
      // skips missing worker records and never blocks a successfully completed task.
      await state.touchWorker(handoffWorkerId, { status: 'IDLE', currentTaskId: null });

      if (params.prLink) {
        state.appendActivity('PR_OPENED', { prLink: params.prLink }, updated);
      }

      // Post system message to task channel
      try {
        await state.postSystemMessage(task.id, 'Task submitted for review');
      } catch { /* never block tool */ }

      // Safely handle implementationPlan which could be null/undefined or empty
      const implementationPlan = updated.implementationPlan || [];
      const completedSteps = implementationPlan.filter((s) => s.status === 'COMPLETED');
      const modified = completedSteps.flatMap((s) => s.modifiedFiles || s.affectedFiles || []);

      return {
        success: true,
        taskId: updated.id,
        status: 'REVIEW',
        stats: {
          stepsCompleted: completedSteps.length,
          totalSteps: implementationPlan.length,
          filesModified: Array.from(new Set(modified)),
          duration: 'n/a'
        },
        nextAction: {
          tool: 'moe.wait_for_task',
          args: {
            statuses: ['WORKING'],
            workerId: params.workerId,
          },
          reason: 'Task handed to QA. Record a Serena write_memory `task-' + updated.id + '-handoff` note (and any gotcha-<area> learnings) for the next agent, then block until the next task arrives.'
        }
      };
    }
  };
}
