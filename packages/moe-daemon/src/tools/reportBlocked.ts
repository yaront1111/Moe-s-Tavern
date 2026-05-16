import type { ToolDefinition } from './index.js';
import type { StateManager } from '../state/StateManager.js';
import { notFound, missingRequired, invalidInput } from '../util/errors.js';
import { recommendSkillFor } from '../util/recommendSkill.js';
import { assertWorkerOwns } from '../util/enforcement.js';

const MAX_REASON_LENGTH = 2000;
const ARCHITECT_LIVENESS_MS = 2 * 60 * 1000; // 2 min — matches listWorkers default

/**
 * Find the architect with the most recent lastActivityAt within the liveness
 * window. Returns null if no architect is awake. Used by reportBlocked so a
 * stale planner doesn't swallow blockers — pings reach whoever is actually on.
 */
function findFreshestAwakeArchitect(state: StateManager): { workerId: string; lastActivityAt: string } | null {
  const nowMs = Date.now();
  let best: { workerId: string; lastActivityAt: string; ms: number } | null = null;
  for (const team of state.teams.values()) {
    if (team.role !== 'architect') continue;
    for (const memberId of team.memberIds) {
      const w = state.getWorker(memberId);
      if (!w) continue;
      const t = Date.parse(w.lastActivityAt);
      if (!Number.isFinite(t)) continue;
      if (nowMs - t > ARCHITECT_LIVENESS_MS) continue;
      if (!best || t > best.ms) {
        best = { workerId: w.id, lastActivityAt: w.lastActivityAt, ms: t };
      }
    }
  }
  return best ? { workerId: best.workerId, lastActivityAt: best.lastActivityAt } : null;
}

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
      // Also direct-mention the freshest awake architect — the original
      // planner may have deregistered, in which case @architects-group
      // routing hits zero targets. Fall back to @governors when no
      // architect is alive.
      const freshArchitect = findFreshestAwakeArchitect(state);
      const routedTo = freshArchitect ? `@${freshArchitect.workerId}` : '@governors';
      const blockedMsg = `🚧 ${task.assignedWorkerId || 'worker'} blocked on ${task.id}: ${params.reason} (cc ${routedTo})`;
      try { await state.postSystemMessage(task.id, blockedMsg); } catch { /* never block tool */ }
      try { await state.postToGeneral(blockedMsg); } catch { /* never block tool */ }
      try { await state.postToRoleChannel('governors', blockedMsg); } catch { /* never block tool */ }

      // wait_for_task requires both workerId and statuses. Only emit the hint
      // when we can populate them; otherwise omit nextAction to avoid a guaranteed-to-throw suggestion.
      const nextAction = task.assignedWorkerId
        ? {
            tool: 'moe.wait_for_task',
            args: { workerId: task.assignedWorkerId, statuses: [task.status] },
            reason: 'Block reported; wait for human to unblock (via chat) or for a different task to pick up.',
            recommendedSkill: recommendSkillFor('worker', 'task_blocked')
          }
        : undefined;

      return {
        success: true,
        taskId: task.id,
        taskStatus: task.status,
        workerStatus: 'BLOCKED',
        message: 'Worker marked as blocked. Human has been notified.',
        routedTo: freshArchitect
          ? { role: 'architect', workerId: freshArchitect.workerId, lastActivityAt: freshArchitect.lastActivityAt }
          : { role: 'governors', workerId: null, lastActivityAt: null },
        ...(nextAction ? { nextAction } : {})
      };
    }
  };
}
