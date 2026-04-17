import type { ToolDefinition } from './index.js';
import type { StateManager } from '../state/StateManager.js';
import { notFound, invalidState } from '../util/errors.js';
import { assertWorkerOwns, assertContextFetched } from '../util/enforcement.js';

export function startStepTool(_state: StateManager): ToolDefinition {
  return {
    name: 'moe.start_step',
    description: 'Mark a step as IN_PROGRESS',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string' },
        stepId: { type: 'string' },
        workerId: { type: 'string' }
      },
      required: ['taskId', 'stepId'],
      additionalProperties: false
    },
    handler: async (args, state) => {
      const params = args as { taskId: string; stepId: string; workerId?: string };
      const task = state.getTask(params.taskId);
      if (!task) throw notFound('Task', params.taskId);

      if (task.status !== 'WORKING') {
        throw invalidState('Task', task.status, 'WORKING');
      }

      assertWorkerOwns(task, params.workerId);
      assertContextFetched(task, params.workerId);

      if (!task.implementationPlan || task.implementationPlan.length === 0) {
        throw invalidState('Task', 'no-plan', 'has-plan');
      }

      const stepIndex = task.implementationPlan.findIndex((s) => s.stepId === params.stepId);
      if (stepIndex === -1) throw notFound('Step', params.stepId);

      const step = task.implementationPlan[stepIndex];
      if (step.status !== 'PENDING') {
        throw invalidState('Step', step.status, 'PENDING');
      }

      const steps = task.implementationPlan.map((step) =>
        step.stepId === params.stepId
          ? { ...step, status: 'IN_PROGRESS' as const, startedAt: new Date().toISOString() }
          : step
      );

      const updates: Record<string, unknown> = { implementationPlan: steps, status: 'WORKING' };
      // Set workStartedAt only on the first step start (don't overwrite on subsequent steps)
      if (!task.workStartedAt) {
        updates.workStartedAt = new Date().toISOString();
      }
      await state.updateTask(task.id, updates, 'STEP_STARTED');

      // Update worker status to CODING
      if (task.assignedWorkerId && state.getWorker(task.assignedWorkerId)) {
        await state.updateWorker(task.assignedWorkerId, { status: 'CODING', currentTaskId: task.id });
      }

      return {
        success: true,
        taskId: task.id,
        stepId: params.stepId,
        stepNumber: stepIndex + 1,
        totalSteps: steps.length,
        nextAction: {
          tool: 'moe.complete_step',
          args: { taskId: task.id, stepId: params.stepId, workerId: params.workerId },
          reason: 'Implement the step, run tests, then mark it complete.'
        }
      };
    }
  };
}
