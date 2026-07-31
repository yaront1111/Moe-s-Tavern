import type { ToolDefinition } from './index.js';
import type { StateManager } from '../state/StateManager.js';
import { notFound, missingRequired, invalidInput } from '../util/errors.js';
import { AGENT_CLAIMABLE_STATUSES } from '../util/claimableStatuses.js';
import { recommendSkillFor } from '../util/recommendSkill.js';
import { assertWorkerOwns } from '../util/enforcement.js';
import { findFreshestLiveWorkerByRole } from '../util/workerLiveness.js';

const MAX_REASON_LENGTH = 2000;

export function reportBlockedTool(_state: StateManager): ToolDefinition {
  return {
    name: 'moe.report_blocked',
    description: 'Report a worker as blocked on a task',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string' },
        reason: { type: 'string' },
        needsFrom: { type: 'string' },
        currentStepId: { type: 'string' },
        workerId: { type: 'string' }
      },
      required: ['taskId', 'reason'],
      additionalProperties: false
    },
    handler: async (args, state) => {
      const params = (args || {}) as {
        taskId?: string;
        reason?: string;
        needsFrom?: string;
        currentStepId?: string;
        workerId?: string;
      };

      if (!params.taskId) throw missingRequired('taskId');
      if (!params.reason || params.reason.trim().length === 0) throw missingRequired('reason');
      if (params.reason.length > MAX_REASON_LENGTH) {
        throw invalidInput('reason', `too long (${params.reason.length} chars). Maximum ${MAX_REASON_LENGTH} characters allowed.`);
      }

      const task = state.getTask(params.taskId);
      if (!task) throw notFound('Task', params.taskId);

      // Only the assigned worker may report this task as blocked. The "no
      // assigned worker" case is permitted (e.g. plugin/human flow).
      assertWorkerOwns(task, params.workerId, 'moe.report_blocked');

      if (task.assignedWorkerId) {
        await state.updateWorker(task.assignedWorkerId, { status: 'BLOCKED', lastError: params.reason }, 'WORKER_BLOCKED');
      }

      // Cross-post blocked message to task channel, general, and #governors
      // so the on-call governor's chat_wait wakes on the block event.
      const blockedMsg = `🚧 ${task.assignedWorkerId || 'worker'} blocked on ${task.id}: ${params.reason}`;

      // Page a real person, not whoever happened to plan the task: the
      // architect with the freshest lastActivityAt inside the liveness window.
      // The blocked worker is excluded because an architect blocked on its own
      // PLANNING task would otherwise page itself and dead-end the escalation —
      // daemon posts use sender 'system', which takes the human routing path
      // and does NOT filter self-mentions the way the agent path does.
      const architect = findFreshestLiveWorkerByRole(
        state.workers.values(),
        state.teams.values(),
        'architect',
        {
          excludeWorkerIds: [task.assignedWorkerId, params.workerId].filter(
            (id): id is string => typeof id === 'string' && id.length > 0
          ),
        }
      );
      // Both forms are routable by MentionRouter: a bare worker id and the
      // `governors` group mention.
      const mentionPrefix = architect ? `@${architect.id} ` : '@governors ';

      // postSystemMessage currently forwards to the general channel, so it stays
      // unprefixed — prefixing both copies would page the same person twice in
      // the same channel. Every post keeps its own try/catch: chat is
      // best-effort and must never fail report_blocked or skip the BLOCKED update.
      try { await state.postSystemMessage(task.id, blockedMsg); } catch { /* never block tool */ }
      try { await state.postToGeneral(mentionPrefix + blockedMsg); } catch { /* never block tool */ }
      if (architect) {
        try { await state.postToRoleChannel('architects', mentionPrefix + blockedMsg); } catch { /* never block tool */ }
        // Governors keep full visibility of every block without being paged.
        try { await state.postToRoleChannel('governors', blockedMsg); } catch { /* never block tool */ }
      } else {
        // No live architect: the governors channel is the escalation, so it
        // carries the mention.
        try { await state.postToRoleChannel('governors', mentionPrefix + blockedMsg); } catch { /* never block tool */ }
      }

      // wait_for_task requires both workerId and statuses. Only emit the hint
      // when we can populate them; otherwise omit nextAction to avoid a
      // guaranteed-to-throw suggestion. Same trap on the statuses value:
      // wait_for_task only accepts agent-claimable statuses, so echoing a
      // human-gated one (e.g. AWAITING_APPROVAL while the architect still
      // holds the task) would also be guaranteed to throw — map it to the
      // pool the owner's role actually waits on.
      const waitStatuses = (AGENT_CLAIMABLE_STATUSES as readonly string[]).includes(task.status)
        ? [task.status]
        : [task.status === 'AWAITING_APPROVAL' ? 'PLANNING' : 'WORKING'];
      const nextAction = task.assignedWorkerId
        ? {
            tool: 'moe.wait_for_task',
            args: { workerId: task.assignedWorkerId, statuses: waitStatuses },
            reason: 'Block reported; wait for human to unblock (via chat) or for a different task to pick up.',
            recommendedSkill: recommendSkillFor('worker', 'task_blocked')
          }
        : undefined;

      return {
        success: true,
        taskId: task.id,
        taskStatus: task.status,
        workerStatus: 'BLOCKED',
        // Who was actually paged — assertable, and readable by a human eyeing
        // the tool output instead of the chat channels.
        notified: architect
          ? { target: architect.id, via: 'freshest-live-architect' as const }
          : { target: '@governors', via: 'governors-fallback' as const },
        message: architect
          ? `Worker marked as blocked. Pinged ${architect.id} (freshest live architect).`
          : 'Worker marked as blocked. No live architect — escalated to @governors.',
        ...(nextAction ? { nextAction } : {})
      };
    }
  };
}
