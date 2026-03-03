import type { ToolDefinition } from './index.js';
import type { StateManager } from '../state/StateManager.js';
import { notFound, invalidState } from '../util/errors.js';

export function completeStepTool(_state: StateManager): ToolDefinition {
  return {
    name: 'moe.complete_step',
    description: 'Mark a step as COMPLETED',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string' },
        stepId: { type: 'string' },
        modifiedFiles: { type: 'array', items: { type: 'string' } },
        note: { type: 'string' }
      },
      required: ['taskId', 'stepId'],
      additionalProperties: false
    },
    handler: async (args, state) => {
      const params = args as {
        taskId: string;
        stepId: string;
        modifiedFiles?: string[];
        note?: string;
      };

      const task = state.getTask(params.taskId);
      if (!task) throw notFound('Task', params.taskId);

      if (task.status !== 'WORKING') {
        throw invalidState('Task', task.status, 'WORKING');
      }

      if (!task.implementationPlan || task.implementationPlan.length === 0) {
        throw invalidState('Task', 'no implementation plan', 'has implementation plan');
      }

      const existingStep = task.implementationPlan.find((s) => s.stepId === params.stepId);
      if (!existingStep) throw notFound('Step', params.stepId);

      if (existingStep.status === 'COMPLETED') {
        throw invalidState('Step', 'COMPLETED', 'PENDING or IN_PROGRESS');
      }

      const steps = task.implementationPlan.map((step) =>
        step.stepId === params.stepId
          ? {
              ...step,
              status: 'COMPLETED' as const,
              completedAt: new Date().toISOString(),
              ...(params.note ? { note: params.note } : {}),
              ...(params.modifiedFiles?.length ? { modifiedFiles: params.modifiedFiles } : {}),
            }
          : step
      );

      await state.updateTask(task.id, { implementationPlan: steps }, 'STEP_COMPLETED');

      // Post system message to task channel
      const stepNum = steps.findIndex((s) => s.stepId === params.stepId) + 1;
      try {
        await state.postSystemMessage(task.id, `Step ${stepNum} completed: ${existingStep.description}`);
      } catch { /* never block tool */ }

      const completed = steps.filter((s) => s.status === 'COMPLETED').length;
      const nextStep = steps.find((s) => s.status === 'PENDING');

      // Nudge for QA handoff when all steps are done
      let chatHint: string | undefined;
      if (!nextStep) {
        let generalId: string | null = null;
        for (const ch of state.channels.values()) {
          if (ch.type === 'general' || ch.name === 'general') { generalId = ch.id; break; }
        }
        if (generalId) {
          chatHint = `All steps complete! Before calling moe.complete_task, consider posting handoff notes for QA in #general: moe.chat_send { channel: "${generalId}", content: "<explain non-obvious decisions or workarounds>" }`;
        }
      }

      return {
        success: true,
        taskId: task.id,
        stepId: params.stepId,
        progress: {
          completed,
          total: steps.length,
          percentage: steps.length > 0 ? Math.round((completed / steps.length) * 100) : 0
        },
        nextStep: nextStep ? { stepId: nextStep.stepId, description: nextStep.description } : null,
        ...(chatHint ? { chatHint } : {})
      };
    }
  };
}
