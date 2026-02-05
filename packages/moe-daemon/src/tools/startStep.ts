import type { ToolDefinition } from './index.js';
import type { StateManager } from '../state/StateManager.js';
import { notFound, invalidState } from '../util/errors.js';

export function startStepTool(_state: StateManager): ToolDefinition {
  return {
    name: 'moe.start_step',
    description: 'Mark a step as IN_PROGRESS',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string' },
        stepId: { type: 'string' }
      },
      required: ['taskId', 'stepId'],
      additionalProperties: false
    },
    handler: async (args, state) => {
      const params = args as { taskId: string; stepId: string };
      const task = state.getTask(params.taskId);
      if (!task) throw notFound('Task', params.taskId);

      if (!task.implementationPlan || task.implementationPlan.length === 0) {
        throw invalidState('Task', 'no-plan', 'has-plan');
      }

      const stepIndex = task.implementationPlan.findIndex((s) => s.stepId === params.stepId);
      if (stepIndex === -1) throw notFound('Step', params.stepId);

      const steps = task.implementationPlan.map((step) =>
        step.stepId === params.stepId
          ? { ...step, status: 'IN_PROGRESS' as const, startedAt: new Date().toISOString() }
          : step
      );

      await state.updateTask(task.id, { implementationPlan: steps, status: 'WORKING' }, 'STEP_STARTED');

      return {
        success: true,
        taskId: task.id,
        stepId: params.stepId,
        stepNumber: stepIndex + 1,
        totalSteps: steps.length
      };
    }
  };
}
