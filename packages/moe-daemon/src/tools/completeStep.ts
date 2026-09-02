import type { ToolDefinition } from './index.js';
import type { StateManager } from '../state/StateManager.js';
import { notFound, invalidState, MoeError, MoeErrorCode } from '../util/errors.js';
import { assertContextFetched, assertWorkerOwns } from '../util/enforcement.js';
import { recommendSkillFor } from '../util/recommendSkill.js';
import { activeAmendment, effectiveStepDescription } from '../util/planAmendments.js';

export function completeStepTool(_state: StateManager): ToolDefinition {
  return {
    name: 'moe.complete_step',
    description: 'Mark a step as COMPLETED. Report EVERY path you created or modified in modifiedFiles — the agent wrapper commits the task from a completed step\'s modifiedFiles (falling back to the step\'s planned affectedFiles), so an omitted list degrades attribution to planned/measured paths and returns a warning.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string' },
        stepId: { type: 'string' },
        modifiedFiles: { type: 'array', items: { type: 'string' }, description: 'Every project-relative path this step created or modified (ASSERTED attribution tier for the auto-commit). Omit nothing.' },
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

      assertWorkerOwns(task, params.workerId, 'moe.complete_step');
      assertContextFetched(task, params.workerId, 'moe.complete_step');

      if (!task.implementationPlan || task.implementationPlan.length === 0) {
        throw invalidState('Task', 'no implementation plan', 'has implementation plan');
      }

      const existingStep = task.implementationPlan.find((s) => s.stepId === params.stepId);
      if (!existingStep) throw notFound('Step', params.stepId);

      if (existingStep.status === 'PENDING') {
        throw new MoeError(
          MoeErrorCode.INVALID_STATE,
          'Step is in PENDING state, expected IN_PROGRESS; call moe.start_step before moe.complete_step',
          {
            entity: 'Step',
            currentState: 'PENDING',
            expectedState: 'IN_PROGRESS',
            nextAction: {
              tool: 'moe.start_step',
              args: { taskId: task.id, stepId: params.stepId, workerId: params.workerId },
            },
          },
          'INVALID_STATE'
        );
      }

      if (existingStep.status !== 'IN_PROGRESS') {
        throw invalidState('Step', existingStep.status, 'IN_PROGRESS');
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

      const priorMetrics = task.metrics ?? {};
      const nextMetrics = {
        ...priorMetrics,
        executedStepCount: (priorMetrics.executedStepCount ?? 0) + 1,
      };

      const updatedTask = await state.updateTask(
        task.id,
        { implementationPlan: steps, stepsCompleted, metrics: nextMetrics },
        'STEP_COMPLETED',
        params.workerId
      );
      await state.touchWorker(task.assignedWorkerId || params.workerId, { status: 'CODING', currentTaskId: task.id });

      // Report the step as the worker was actually instructed to do it: an
      // amended step reads as plan drift if we echo the superseded text.
      const completedDescription = effectiveStepDescription(existingStep);
      const completedAmendment = activeAmendment(existingStep);

      // Post system message to task channel
      const stepNum = steps.findIndex((s) => s.stepId === params.stepId) + 1;
      try {
        await state.postSystemMessage(task.id, `Step ${stepNum} completed: ${completedDescription}`);
      } catch { /* never block tool */ }

      // Attribution warning: the wrapper's ASSERTED tier is built from
      // complete_step.modifiedFiles (falling back to affectedFiles), so a step
      // that reports nothing leaves its real edits to planned/measured
      // attribution — or unattributed when peers are active.
      const modifiedFilesOmitted = !Array.isArray(params.modifiedFiles) || params.modifiedFiles.length === 0;
      const warning = modifiedFilesOmitted
        ? `MODIFIED-FILES-OMITTED: step ${params.stepId} completed without modifiedFiles — the wrapper attributes this task's commit from complete_step.modifiedFiles and fell back to the step's affectedFiles (${(existingStep.affectedFiles || []).length} path(s)). Report every path you created or modified, or declare them with moe.declare_files.`
        : undefined;

      const completed = steps.filter((s) => s.status === 'COMPLETED').length;
      // A step still "remains" if it's PENDING or IN_PROGRESS. start_step allows
      // out-of-order starts, so a PENDING-only scan misses an IN_PROGRESS step
      // and wrongly nudges complete_task — which then rejects via
      // assertAllStepsCompleted (PENDING || IN_PROGRESS both block). Match it here.
      const nextStep = steps.find((s) => s.status === 'PENDING' || s.status === 'IN_PROGRESS');

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

      // Same for what comes next: point the worker at the amended instructions,
      // never the superseded ones.
      const nextDescription = nextStep ? effectiveStepDescription(nextStep) : '';

      const nextAction = nextStep
        ? (() => {
            // An IN_PROGRESS remaining step was started out-of-order; start_step
            // would reject it (PENDING-only). Point the worker at completing it.
            if (nextStep.status === 'IN_PROGRESS') {
              return {
                tool: 'moe.complete_step',
                args: { taskId: task.id, stepId: nextStep.stepId, workerId: params.workerId },
                reason: `Finish in-progress step ${nextStep.stepId}: ${nextDescription.slice(0, 80)}`,
                recommendedSkill: steps.indexOf(nextStep) === steps.length - 1
                  ? recommendSkillFor('worker', 'final_step')
                  : undefined
              };
            }
            const desc = nextDescription.toLowerCase();
            const files = (nextStep.affectedFiles || []).join(' ').toLowerCase();
            const isTestStep = /\btest|spec\b/.test(desc) || /\.(test|spec)\.|tests?\//.test(files);
            const isFinal = steps.indexOf(nextStep) === steps.length - 1;
            return {
              tool: 'moe.start_step',
              args: { taskId: task.id, stepId: nextStep.stepId, workerId: params.workerId },
              reason: `Advance to next pending step ${nextStep.stepId}: ${nextDescription.slice(0, 80)}`,
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
        // What the worker was actually told to do (amended when an amendment is
        // in force, otherwise identical to the planned description).
        effectiveDescription: completedDescription,
        // Absent — not false/null — on unamended steps, so existing consumers
        // see an unchanged response shape.
        ...(completedAmendment
          ? {
              amended: {
                amendmentId: completedAmendment.amendmentId,
                reason: completedAmendment.reason,
                amendedBy: completedAmendment.amendedBy,
                amendedAt: completedAmendment.amendedAt,
              },
            }
          : {}),
        nextStep: nextStep ? { stepId: nextStep.stepId, description: nextDescription } : null,
        ...(chatHint ? { chatHint } : {}),
        ...(warning ? { warning } : {}),
        nextAction
      };
    }
  };
}
