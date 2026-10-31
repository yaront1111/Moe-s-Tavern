import type { ToolDefinition } from './index.js';
import type { StateManager } from '../state/StateManager.js';
import { notFound, invalidState, notAllowed } from '../util/errors.js';
import { assertWorkerHoldsTask, assertContextFetched } from '../util/enforcement.js';
import { assertExecutionAuthorized } from '../util/executionAuthorization.js';
import { recommendSkillFor } from '../util/recommendSkill.js';
import { accountSwitchCause, accountSwitchFor } from '../state/accountStore.js';

export function startStepTool(_state: StateManager): ToolDefinition {
  return {
    name: 'moe.start_step',
    description: 'Mark a step as IN_PROGRESS. Under verified-local, entry needs workerId, attemptId, generation and the sessionId that read moe.get_context, with the current plan revision approved; refusals: STEP_ENTRY_IDENTITY_REQUIRED, ATTEMPT_SUPERSEDED, ATTEMPT_NOT_RUNNING, PLAN_REVISION_NOT_APPROVED, CONTEXT_RECEIPT_STALE.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'The task that owns the step' },
        stepId: { type: 'string', description: 'An existing step id from the approved plan' },
        workerId: { type: 'string', description: 'Caller worker ID (auto-injected by proxy)' },
        attemptId: { type: 'string', maxLength: 128, description: 'The attemptId moe.claim_next_task returned. Optional under legacy/observe (a presented one is fenced); required under verified-local.' },
        generation: { type: 'integer', minimum: 1, description: 'The generation moe.claim_next_task returned. Optional under legacy/observe (a presented one is fenced); required under verified-local.' },
        sessionId: { type: 'string', description: 'The sessionId this session passed to moe.get_context. Optional under legacy/observe; required under verified-local.' }
      },
      required: ['taskId', 'stepId'],
      additionalProperties: false
    },
    handler: async (args, state) => {
      const params = args as {
        taskId: string; stepId: string; workerId?: string; attemptId?: unknown; generation?: unknown; sessionId?: unknown;
      };
      const task = state.getTask(params.taskId);
      if (!task) throw notFound('Task', params.taskId);

      if (task.status !== 'WORKING') {
        throw invalidState('Task', task.status, 'WORKING');
      }

      assertWorkerHoldsTask(task, params.workerId, 'moe.start_step');
      assertContextFetched(task, params.workerId, 'moe.start_step');
      // Read-only, before any write below: strict entry needs the current attempt, approval and receipt.
      const { attemptId, generation, sessionId } = params;
      assertExecutionAuthorized(state, task, params.workerId, { attemptId, generation, sessionId }, 'moe.start_step');

      if (!task.implementationPlan || task.implementationPlan.length === 0) {
        throw invalidState('Task', 'no-plan', 'has-plan');
      }

      const stepIndex = task.implementationPlan.findIndex((s) => s.stepId === params.stepId);
      if (stepIndex === -1) throw notFound('Step', params.stepId);

      const step = task.implementationPlan[stepIndex];
      if (step.status !== 'PENDING') {
        throw invalidState('Step', step.status, 'PENDING');
      }

      // The seat's Claude account is spent: stop at this step boundary, and the
      // wrapper's relaunch of the held task runs on the next account.
      const accountSwitch = accountSwitchFor(state, params.workerId ?? task.assignedWorkerId ?? undefined);
      if (accountSwitch) {
        throw notAllowed(
          'moe.start_step',
          `ACCOUNT-SWITCH: ${accountSwitchCause(accountSwitch)}. Do not start step ${params.stepId} in this session; it stays pending. End your session now: Moe relaunches this task on ${accountSwitch.toLabel}, and the new session starts the step.`
        );
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
      const updatedTask = await state.updateTask(task.id, updates, 'STEP_STARTED', params.workerId);

      // Update worker liveness/status to CODING without requiring a worker record to exist.
      await state.touchWorker(task.assignedWorkerId || params.workerId, { status: 'CODING', currentTaskId: task.id });

      // Heuristic: recommend TDD skill on test-touching steps, adversarial-self-review
      // on the final step, ponytail on every other implementation step (that slot
      // used to be empty - a mid-plan step got no recommendation at all). All advisory.
      const desc = (step.description || '').toLowerCase();
      const files = (step.affectedFiles || []).join(' ').toLowerCase();
      const isTestStep = /\btest|spec\b/.test(desc) || /\.(test|spec)\.|tests?\//.test(files);
      const isFinalStep = stepIndex === steps.length - 1;
      const recommendedSkill = isFinalStep
        ? recommendSkillFor('worker', 'final_step')
        : isTestStep
          ? recommendSkillFor('worker', 'test_step')
          : recommendSkillFor('worker', 'implementation_step');

      return {
        success: true,
        taskId: task.id,
        stepId: params.stepId,
        stepNumber: stepIndex + 1,
        totalSteps: steps.length,
        nextAction: {
          tool: 'moe.complete_step',
          args: { taskId: task.id, stepId: params.stepId, workerId: params.workerId },
          reason: 'Implement the step, run tests, then mark it complete.',
          recommendedSkill
        }
      };
    }
  };
}
