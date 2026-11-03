import type { ToolDefinition } from './index.js';
import type { StateManager } from '../state/StateManager.js';
import type { PriorAttempt } from '../types/schema.js';
import { missingRequired, invalidInput, notFound, invalidState } from '../util/errors.js';
import { assertWorkerOwns } from '../util/enforcement.js';
import { resolveWorkerRole } from '../util/workerRole.js';

const MAX_REASON_LENGTH = 2000;

/**
 * moe.request_replan — worker (or governor) hands the task back to the
 * architect for a fresh plan. The prior implementation plan + completed
 * step ids are snapshotted into task.priorAttempt so the architect can see
 * what was tried, then the task flips to PLANNING and is cross-posted to
 * #architects.
 *
 * This is the structured escape hatch when moe.report_blocked won't unstick
 * the task (the worker has discovered the plan itself is wrong).
 */
export function requestReplanTool(_state: StateManager): ToolDefinition {
  return {
    name: 'moe.request_replan',
    description: 'Worker requests a fresh plan from the architect. Snapshots prior implementation plan into task.priorAttempt, flips task to PLANNING, pings #architects. Frees the seat: the reply carries sessionHandoff END_SESSION for it, so end the session; do not claim or wait inside it.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string' },
        stepId: { type: 'string', description: 'Optional: step where the plan broke down' },
        reason: { type: 'string', description: 'Why the existing plan is unworkable (max 2000 chars)' },
        workerId: { type: 'string' }
      },
      required: ['taskId', 'reason'],
      additionalProperties: false
    },
    handler: async (args, state) => {
      const params = (args || {}) as {
        taskId?: string;
        stepId?: string;
        reason?: string;
        workerId?: string;
      };

      if (!params.taskId) throw missingRequired('taskId');
      if (!params.reason || params.reason.trim().length === 0) throw missingRequired('reason');
      if (params.reason.length > MAX_REASON_LENGTH) {
        throw invalidInput('reason', `too long (${params.reason.length} chars). Maximum ${MAX_REASON_LENGTH} characters allowed.`);
      }

      const task = state.getTask(params.taskId);
      if (!task) throw notFound('Task', params.taskId);

      // Only WORKING tasks can be sent back for a re-plan — a task in any
      // other column either has no work to preserve or doesn't belong to the
      // worker yet.
      if (task.status !== 'WORKING') {
        throw invalidState('Task', task.status, 'WORKING');
      }

      // Only the assigned worker (or no-worker case) may request a replan.
      assertWorkerOwns(task, params.workerId, 'moe.request_replan');

      const priorAttempt: PriorAttempt = {
        attemptedAt: new Date().toISOString(),
        reason: params.reason,
        implementationPlan: Array.isArray(task.implementationPlan) ? task.implementationPlan : [],
        stepsCompleted: Array.isArray(task.stepsCompleted) ? task.stepsCompleted : [],
      };

      const updated = await state.updateTask(
        task.id,
        {
          status: 'PLANNING',
          implementationPlan: [],
          stepsCompleted: [],
          priorAttempt,
          reopenReason: params.reason,
        },
        'TASK_REOPENED',
        params.workerId
      );

      // Worker is done with this task. A pointer naming a different task means
      // that seat is coding it: resetting it mid-step is the two-pointer drift
      // report_blocked guards against.
      const prevAssignee = task.assignedWorkerId;
      if (prevAssignee) {
        try {
          const prevWorker = state.getWorker(prevAssignee);
          if (prevWorker && (prevWorker.currentTaskId === task.id || prevWorker.currentTaskId == null)) {
            await state.touchWorker(prevAssignee, { status: 'IDLE', currentTaskId: null });
          }
        } catch { /* never block tool */ }
      }

      const stepHint = params.stepId ? ` (broke at step ${params.stepId})` : '';
      const reasonSummary = params.reason.length > 200 ? params.reason.slice(0, 200) + '…' : params.reason;
      // The #general line echoes the agent's reason, so a tag it spells must not
      // page seats (mem:gotcha-plan-step-text-at-tokens-echoed-as-mentions).
      try {
        await state.postSystemMessage(task.id, `Replan requested${stepHint}: ${reasonSummary}`, { parseMentions: false });
      } catch { /* never block tool */ }
      try {
        await state.postToRoleChannel(
          'architects',
          `🔁 Replan requested for ${task.id}${stepHint}: ${reasonSummary} — prior attempt preserved in task.priorAttempt.`
        );
      } catch { /* never block tool */ }

      // Twin of reportBlocked.ts's sessionHandoff (43f6dd55): the seat is freed,
      // so a claim/wait hint would start a second task in a session whose pinned
      // attempt identity makes every start_step fail ATTEMPT_SUPERSEDED. A
      // governor never holds a task, so its replan must not end the governance
      // TUI; a seat whose pointer names another task is not ended either.
      const callerSeat = params.workerId && resolveWorkerRole(state, params.workerId) !== 'governor'
        ? params.workerId : undefined;
      const seatWorker = prevAssignee || callerSeat;
      const seatTaskId = seatWorker ? state.getWorker(seatWorker)?.currentTaskId : undefined;
      const sessionHandoff = seatWorker && !seatTaskId
        ? {
            action: 'END_SESSION', taskId: task.id, workerId: seatWorker,
            reason: 'End this session so the wrapper can checkpoint the task it launched. ' +
              'Do not call moe.claim_next_task or moe.wait_for_task inside this session. ' +
              'A new conversation turn is not a fresh preflight; the next task needs a new wrapper session and baseline. ' +
              'If this is an interactive TUI, return control to its operator so the CLI can exit normally.'
          }
        : undefined;

      return {
        success: true,
        taskId: updated.id,
        status: updated.status,
        priorAttempt,
        message: `Task ${updated.id} flipped to PLANNING; architect will re-plan with priorAttempt context. Seat freed — this response does not start another task session.`,
        ...(sessionHandoff ? { sessionHandoff } : {}),
      };
    }
  };
}
