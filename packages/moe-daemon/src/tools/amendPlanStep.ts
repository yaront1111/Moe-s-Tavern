import type { ToolDefinition } from './index.js';
import type { StateManager } from '../state/StateManager.js';
import type { ImplementationStep, StepAmendment } from '../types/schema.js';
import { invalidInput, invalidState, missingRequired, notAllowed, notFound, MoeError, MoeErrorCode } from '../util/errors.js';
import { MAX_AMENDMENTS_PER_STEP, effectiveStepDescription, nextAmendmentId } from '../util/planAmendments.js';
import { workerHasRole } from '../util/workerRole.js';

const MAX_DESCRIPTION_CHARS = 5000;
const MAX_REASON_CHARS = 2000;

export function amendPlanStepTool(_state: StateManager): ToolDefinition {
  return {
    name: 'moe.amend_plan_step',
    description: 'Architect/governor: amend ONE plan step in place without a full re-plan. `description` REPLACES the step\'s instructions (full text, not a delta); the original is kept for audit and complete_step echoes the effective (amended) text so the worker does not look like it drifted from the plan. Rejects COMPLETED steps and finished tasks — use moe.request_replan when the work already shipped or the whole plan is wrong.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string' },
        stepId: { type: 'string' },
        description: { type: 'string', description: 'Full replacement instructions for the step (not a delta)' },
        reason: { type: 'string', description: 'Why the step is being amended; surfaced to the assigned worker' },
        workerId: { type: 'string', description: 'Caller worker ID (auto-injected by proxy)' }
      },
      required: ['taskId', 'stepId', 'description', 'reason'],
      additionalProperties: false
    },
    handler: async (args, state) => {
      const params = (args || {}) as {
        taskId?: string;
        stepId?: string;
        description?: unknown;
        reason?: unknown;
        workerId?: string;
      };

      if (!params.taskId) throw missingRequired('taskId');
      if (!params.stepId) throw missingRequired('stepId');
      if (params.description === undefined || params.description === null) throw missingRequired('description');
      if (params.reason === undefined || params.reason === null) throw missingRequired('reason');

      if (typeof params.description !== 'string') throw invalidInput('description', 'must be a string');
      if (typeof params.reason !== 'string') throw invalidInput('reason', 'must be a string');
      const description = params.description.trim();
      const reason = params.reason.trim();
      if (description.length === 0) throw invalidInput('description', 'cannot be empty');
      if (description.length > MAX_DESCRIPTION_CHARS) {
        throw invalidInput('description', `too long (${description.length} chars). Maximum ${MAX_DESCRIPTION_CHARS} characters allowed.`);
      }
      if (reason.length === 0) throw invalidInput('reason', 'cannot be empty');
      if (reason.length > MAX_REASON_CHARS) {
        throw invalidInput('reason', `too long (${reason.length} chars). Maximum ${MAX_REASON_CHARS} characters allowed.`);
      }

      // Role gate (mirrors submit_plan_critique): plans belong to architects,
      // and governors oversee them. Role = team role, else the id prefix
      // (util/workerRole). A missing/unknown workerId has neither, so this
      // fails closed — otherwise any worker could rewrite its own
      // instructions and call the result "the plan".
      if (!workerHasRole(state, params.workerId || '', 'architect', 'governor')) {
        throw notAllowed(
          'amend_plan_step',
          `architect or governor role required (worker ${params.workerId || '(none)'} is not on an architect or governor team and its id declares neither role)`
        );
      }

      const task = state.getTask(params.taskId);
      if (!task) throw notFound('Task', params.taskId);
      if (task.status === 'DONE' || task.status === 'ARCHIVED') {
        throw invalidState('Task', task.status, 'an in-flight status (amending finished work has no effect)');
      }

      const plan = Array.isArray(task.implementationPlan) ? task.implementationPlan : [];
      const step = plan.find((s) => s.stepId === params.stepId);
      if (!step) throw notFound('Step', params.stepId);

      if (step.status === 'COMPLETED') {
        throw new MoeError(
          MoeErrorCode.INVALID_STATE,
          `Step ${step.stepId} is already COMPLETED; amending it would rewrite history for work that already shipped. Use moe.request_replan if the plan itself is wrong.`,
          { entity: 'Step', currentState: 'COMPLETED', expectedState: 'PENDING or IN_PROGRESS' },
          'INVALID_STATE'
        );
      }

      const existing = Array.isArray(step.amendments) ? step.amendments : [];
      if (existing.length >= MAX_AMENDMENTS_PER_STEP) {
        throw notAllowed(
          'amend_plan_step',
          `step ${step.stepId} already has ${existing.length} amendments (max ${MAX_AMENDMENTS_PER_STEP}). A step amended this many times is a re-plan — use moe.request_replan.`
        );
      }

      const previousDescription = effectiveStepDescription(step);
      const amendment: StepAmendment = {
        amendmentId: nextAmendmentId(step),
        description,
        reason,
        amendedBy: params.workerId || 'unknown',
        amendedAt: new Date().toISOString(),
      };

      // Append-only: the step's original `description` is never rewritten, so
      // the audit trail of what was first asked survives every amendment.
      const nextSteps: ImplementationStep[] = plan.map((s) =>
        s.stepId === step.stepId
          ? { ...s, amendments: [...existing, amendment], activeAmendmentId: amendment.amendmentId }
          : s
      );

      // No runExclusive here: MCP dispatch already serializes tool handlers on
      // the global state mutex, and re-taking it would only add a nesting layer.
      const updated = await state.updateTask(task.id, { implementationPlan: nextSteps }, 'TASK_UPDATED');

      // Best-effort chat: the @mention wakes the assigned worker's wait. A chat
      // failure must never fail a persisted amendment.
      const mention = task.assignedWorkerId ? `@${task.assignedWorkerId} ` : '';
      const chatMsg = `${mention}✏️ step ${step.stepId} amended on ${task.id}: ${reason}`;
      try { await state.postToGeneral(chatMsg); } catch { /* never block tool */ }
      try { await state.postToRoleChannel('workers', chatMsg); } catch { /* never block tool */ }

      const amendedStep = updated.implementationPlan?.find((s) => s.stepId === step.stepId);
      return {
        success: true,
        taskId: task.id,
        stepId: step.stepId,
        amendmentId: amendment.amendmentId,
        amendmentCount: amendedStep?.amendments?.length ?? existing.length + 1,
        effectiveDescription: amendedStep ? effectiveStepDescription(amendedStep) : description,
        previousDescription,
        message: `Step ${step.stepId} amended (${amendment.amendmentId}). The worker's next complete_step echoes the amended instructions.`,
      };
    }
  };
}
