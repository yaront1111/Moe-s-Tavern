// =============================================================================
// moe.amend_plan_step — architect/governor amendment to an approved plan step
// =============================================================================
//
// After a plan is approved, the architect (or a governor) sometimes needs to
// adjust a step's description without rewriting history. Before this tool
// existed, the convention was a free-text comment on the task — which meant
// QA had to dig through comment archeology to figure out what description
// was "in force". Now amendments are structured records on the step itself
// (`step.amendments[]` + `step.activeAmendmentId`), and downstream consumers
// (complete_step, getContext, QA review) resolve the effective description
// instead of the original.
//
// Permissions: only architects and governors may file amendments. Workers and
// QA agents must use moe.add_comment for non-binding observations.

import type { ToolDefinition } from './index.js';
import type { StateManager } from '../state/StateManager.js';
import type { ImplementationStep, StepAmendment } from '../types/schema.js';
import { MAX_AMENDMENTS_PER_STEP } from '../types/schema.js';
import { invalidInput, invalidState, missingRequired, notFound, notAllowed } from '../util/errors.js';

const MAX_AMENDMENT_DESCRIPTION_LEN = 2000;
const MAX_AMENDMENT_RATIONALE_LEN = 2000;

export function amendPlanStepTool(_state: StateManager): ToolDefinition {
  return {
    name: 'moe.amend_plan_step',
    description: 'File a structured amendment to an approved step description. Restricted to architect and governor roles.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string' },
        stepId: { type: 'string' },
        description: { type: 'string', description: 'Replacement description; becomes the effective description downstream.' },
        rationale: { type: 'string', description: 'Optional explanation for the amendment.' },
        workerId: { type: 'string', description: 'Author worker ID (must belong to an architect or governor team).' }
      },
      required: ['taskId', 'stepId', 'description', 'workerId'],
      additionalProperties: false
    },
    handler: async (args, state) => {
      const params = (args || {}) as {
        taskId?: string;
        stepId?: string;
        description?: string;
        rationale?: string;
        workerId?: string;
      };

      if (!params.taskId) throw missingRequired('taskId');
      if (!params.stepId) throw missingRequired('stepId');
      if (!params.workerId) throw missingRequired('workerId');
      if (!params.description || typeof params.description !== 'string' || params.description.trim().length === 0) {
        throw invalidInput('description', 'must be a non-empty string');
      }
      if (params.description.length > MAX_AMENDMENT_DESCRIPTION_LEN) {
        throw invalidInput('description', `too long (max ${MAX_AMENDMENT_DESCRIPTION_LEN} chars)`);
      }
      if (params.rationale !== undefined) {
        if (typeof params.rationale !== 'string') {
          throw invalidInput('rationale', 'must be a string');
        }
        if (params.rationale.length > MAX_AMENDMENT_RATIONALE_LEN) {
          throw invalidInput('rationale', `too long (max ${MAX_AMENDMENT_RATIONALE_LEN} chars)`);
        }
      }

      return state.runExclusive(async () => {
        const task = state.getTask(params.taskId!);
        if (!task) throw notFound('Task', params.taskId!);

        const team = state.getTeamForWorker(params.workerId!);
        const role = team?.role;
        if (role !== 'architect' && role !== 'governor') {
          throw notAllowed(
            'amend_plan_step',
            `Only architects and governors may amend plan steps; worker ${params.workerId} has role ${role ?? 'none'}.`
          );
        }

        if (!task.implementationPlan || task.implementationPlan.length === 0) {
          throw invalidState('Task', 'no implementation plan', 'has implementation plan');
        }
        const stepIdx = task.implementationPlan.findIndex((s) => s.stepId === params.stepId);
        if (stepIdx < 0) throw notFound('Step', params.stepId!);
        const step = task.implementationPlan[stepIdx];

        const existing = step.amendments ?? [];
        if (existing.length >= MAX_AMENDMENTS_PER_STEP) {
          throw invalidState(
            'Step',
            `${existing.length} amendments (max ${MAX_AMENDMENTS_PER_STEP})`,
            `< ${MAX_AMENDMENTS_PER_STEP} amendments`
          );
        }

        const nowIso = new Date().toISOString();
        const amendmentId = `amend-${task.id}-${params.stepId}-${existing.length + 1}`;
        const amendment: StepAmendment = {
          amendmentId,
          authorId: params.workerId!,
          authoredAt: nowIso,
          description: params.description!.trim().slice(0, MAX_AMENDMENT_DESCRIPTION_LEN),
          ...(params.rationale ? { rationale: params.rationale.trim().slice(0, MAX_AMENDMENT_RATIONALE_LEN) } : {}),
          ...(step.activeAmendmentId ? { supersededAmendmentId: step.activeAmendmentId } : {}),
        };

        const nextStep: ImplementationStep = {
          ...step,
          amendments: [amendment, ...existing],
          activeAmendmentId: amendmentId,
        };
        const nextPlan = task.implementationPlan.map((s, i) => (i === stepIdx ? nextStep : s));

        await state.updateTask(task.id, { implementationPlan: nextPlan }, 'STEP_AMENDED');

        try {
          await state.postSystemMessage(
            task.id,
            `📝 Step ${params.stepId} amended by ${params.workerId} (${role}): ${amendment.description.slice(0, 140)}`
          );
        } catch { /* never block tool */ }

        return {
          success: true,
          taskId: task.id,
          stepId: params.stepId,
          amendmentId,
          activeAmendmentId: amendmentId,
          totalAmendments: nextStep.amendments!.length,
          effectiveDescription: amendment.description,
        };
      });
    }
  };
}
