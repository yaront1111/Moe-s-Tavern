import type { ToolDefinition } from './index.js';
import type { StateManager } from '../state/StateManager.js';
import { checkPlanRails } from '../util/rails.js';
import { notFound, invalidState, invalidInput, MoeError, MoeErrorCode } from '../util/errors.js';

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
      if (!task) throw notFound('Task', params.taskId);

      if (task.status !== 'PLANNING') {
        throw invalidState('Task', task.status, 'PLANNING');
      }

      if (!params.steps || params.steps.length === 0) {
        throw invalidInput('steps', 'plan cannot be empty');
      }

      // Validate step count bounds
      if (params.steps.length > 100) {
        throw invalidInput('steps', 'maximum 100 steps allowed');
      }

      // Validate each step has a non-empty description
      for (let i = 0; i < params.steps.length; i++) {
        const step = params.steps[i];
        if (!step.description || typeof step.description !== 'string' || step.description.trim().length === 0) {
          throw invalidInput('steps', `Step ${i + 1} has empty description`);
        }
        if (step.description.length > 2000) {
          throw invalidInput('steps', `Step ${i + 1} description too long (max 2000 chars)`);
        }
        if (step.affectedFiles && step.affectedFiles.length > 50) {
          throw invalidInput('steps', `Step ${i + 1} has too many affected files (max 50)`);
        }
      }

      const epic = state.getEpic(task.epicId);
      const project = state.project;
      if (!project) throw notFound('Project', 'current');

      const planText = params.steps
        .map((step) => `${step.description} ${(step.affectedFiles || []).join(' ')}`)
        .join(' ');

      const railsCheck = checkPlanRails(planText, project.globalRails, epic, task);
      if (!railsCheck.ok) {
        throw new MoeError(MoeErrorCode.CONSTRAINT_VIOLATION, 'Rail violation', { violation: railsCheck.violation });
      }

      const implementationPlan = params.steps.map((step, idx) => ({
        stepId: `step-${idx + 1}`,
        description: step.description,
        status: 'PENDING' as const,
        affectedFiles: step.affectedFiles || []
      }));

      await state.updateTask(task.id, {
        implementationPlan,
        status: 'AWAITING_APPROVAL',
        planSubmittedAt: new Date().toISOString(),
      }, 'PLAN_SUBMITTED');

      const approvalMode = project.settings.approvalMode;
      let finalStatus = 'AWAITING_APPROVAL';
      let message = 'Plan submitted. Awaiting human approval.';

      if (approvalMode === 'TURBO') {
        // Instant auto-approval
        await state.updateTask(task.id, { status: 'WORKING', planApprovedAt: new Date().toISOString() }, 'PLAN_AUTO_APPROVED');
        finalStatus = 'WORKING';
        message = 'Plan auto-approved (TURBO mode). Ready to work.';
      } else if (approvalMode === 'SPEED') {
        // Delayed auto-approval
        const delayMs = project.settings.speedModeDelayMs || 2000;
        setTimeout(async () => {
          try {
            const currentTask = state.getTask(task.id);
            // Only auto-approve if still in AWAITING_APPROVAL (not manually rejected/approved)
            if (currentTask && currentTask.status === 'AWAITING_APPROVAL') {
              await state.updateTask(task.id, { status: 'WORKING' }, 'PLAN_AUTO_APPROVED');
            }
          } catch (error) {
            // Log error via activity log so task doesn't get stuck silently
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            state.appendActivity('TASK_BLOCKED' as import('../types/schema.js').ActivityEventType, {
              error: errorMessage,
              reason: 'SPEED mode auto-approval failed'
            }, state.getTask(task.id) ?? undefined);
          }
        }, delayMs);
        message = `Plan submitted. Auto-approval in ${delayMs}ms (SPEED mode).`;
      }

      return {
        success: true,
        taskId: task.id,
        status: finalStatus,
        stepCount: implementationPlan.length,
        message
      };
    }
  };
}
