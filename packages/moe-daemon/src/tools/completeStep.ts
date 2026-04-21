import type { ToolDefinition } from './index.js';
import type { StateManager } from '../state/StateManager.js';
import { notFound, invalidState } from '../util/errors.js';
import { assertWorkerOwns } from '../util/enforcement.js';
import { recommendSkillFor } from '../util/recommendSkill.js';

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
        note: { type: 'string' },
        workerId: { type: 'string' }
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
        workerId?: string;
      };

      const task = state.getTask(params.taskId);
      if (!task) throw notFound('Task', params.taskId);

      if (task.status !== 'WORKING') {
        throw invalidState('Task', task.status, 'WORKING');
      }

      assertWorkerOwns(task, params.workerId);

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

      const prevCompleted = Array.isArray(task.stepsCompleted) ? task.stepsCompleted : [];
      const stepsCompleted = prevCompleted.includes(params.stepId)
        ? prevCompleted
        : [...prevCompleted, params.stepId];

      await state.updateTask(
        task.id,
        { implementationPlan: steps, stepsCompleted },
        'STEP_COMPLETED'
      );

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

      const nextAction = nextStep
        ? (() => {
            const desc = (nextStep.description || '').toLowerCase();
            const files = (nextStep.affectedFiles || []).join(' ').toLowerCase();
            const isTestStep = /\btest|spec\b/.test(desc) || /\.(test|spec)\.|tests?\//.test(files);
            const isFinal = steps.indexOf(nextStep) === steps.length - 1;
            return {
              tool: 'moe.start_step',
              args: { taskId: task.id, stepId: nextStep.stepId, workerId: params.workerId },
              reason: `Advance to step ${stepNum + 1}: ${nextStep.description.slice(0, 80)}`,
              recommendedSkill: isFinal
                ? recommendSkillFor('worker', 'final_step')
                : isTestStep
                  ? recommendSkillFor('worker', 'test_step')
                  : undefined
            };
          })()
        : {
            tool: 'moe.complete_task',
            args: { taskId: task.id, workerId: params.workerId },
            reason: 'All steps complete; hand task off to QA via moe.complete_task.',
            recommendedSkill: recommendSkillFor('worker', 'before_complete_task')
          };

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
        ...(chatHint ? { chatHint } : {}),
        nextAction
      };
    }
  };
}
