import type { ToolDefinition } from './index.js';
import type { StateManager } from '../state/StateManager.js';
import { checkPlanRails } from '../util/rails.js';

export function submitPlanTool(_state: StateManager): ToolDefinition {
  return {
    name: 'moe.submit_plan',
    description: 'Submit an implementation plan for a task',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string' },
        steps: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              description: { type: 'string' },
              affectedFiles: { type: 'array', items: { type: 'string' } }
            },
            required: ['description'],
            additionalProperties: false
          }
        }
      },
      required: ['taskId', 'steps'],
      additionalProperties: false
    },
    handler: async (args, state) => {
      const params = args as {
        taskId: string;
        steps: { description: string; affectedFiles?: string[] }[];
      };

      const task = state.getTask(params.taskId);
      if (!task) throw new Error('TASK_NOT_FOUND');

      if (task.status !== 'PLANNING') {
        throw new Error('INVALID_STATUS');
      }

      if (!params.steps || params.steps.length === 0) {
        throw new Error('EMPTY_PLAN');
      }

      // Validate step count bounds
      if (params.steps.length > 100) {
        throw new Error('TOO_MANY_STEPS: Maximum 100 steps allowed');
      }

      // Validate each step has a non-empty description
      for (let i = 0; i < params.steps.length; i++) {
        const step = params.steps[i];
        if (!step.description || typeof step.description !== 'string' || step.description.trim().length === 0) {
          throw new Error(`INVALID_STEP: Step ${i + 1} has empty description`);
        }
        if (step.description.length > 2000) {
          throw new Error(`INVALID_STEP: Step ${i + 1} description too long (max 2000 chars)`);
        }
        if (step.affectedFiles && step.affectedFiles.length > 50) {
          throw new Error(`INVALID_STEP: Step ${i + 1} has too many affected files (max 50)`);
        }
      }

      const epic = state.getEpic(task.epicId);
      const project = state.project;
      if (!project) throw new Error('PROJECT_NOT_FOUND');

      const planText = params.steps
        .map((step) => `${step.description} ${(step.affectedFiles || []).join(' ')}`)
        .join(' ');

      const railsCheck = checkPlanRails(planText, project.globalRails, epic, task);
      if (!railsCheck.ok) {
        const err = new Error('RAIL_VIOLATION');
        (err as Error & { details?: unknown }).details = railsCheck.violation;
        throw err;
      }

      const implementationPlan = params.steps.map((step, idx) => ({
        stepId: `step-${idx + 1}`,
        description: step.description,
        status: 'PENDING' as const,
        affectedFiles: step.affectedFiles || []
      }));

      await state.updateTask(task.id, {
        implementationPlan,
        status: 'AWAITING_APPROVAL'
      }, 'PLAN_SUBMITTED');

      return {
        success: true,
        taskId: task.id,
        status: 'AWAITING_APPROVAL',
        stepCount: implementationPlan.length,
        message: 'Plan submitted. Awaiting human approval.'
      };
    }
  };
}
