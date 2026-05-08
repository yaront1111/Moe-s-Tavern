import type { ToolDefinition } from './index.js';
import type { StateManager } from '../state/StateManager.js';
import type { Task, TaskPriority, WorkerType } from '../types/schema.js';
import { missingRequired, notAllowed, invalidState, notFound } from '../util/errors.js';
import { recommendSkillFor } from '../util/recommendSkill.js';

const PRIORITY_WEIGHT: Record<TaskPriority, number> = {
  CRITICAL: 0,
  HIGH: 1,
  MEDIUM: 2,
  LOW: 3
};

export function claimNextTaskTool(_state: StateManager): ToolDefinition {
  return {
    name: 'moe.claim_next_task',
    description: 'Claim a task: by id (taskId) or the next prioritized task matching statuses. Assigns workerId if provided.',
    inputSchema: {
      type: 'object',
      properties: {
        statuses: { type: 'array', items: { type: 'string' } },
        epicId: { type: 'string' },
        workerId: { type: 'string' },
        replaceExisting: { type: 'boolean', description: 'Replace existing worker assignment if another worker is active' },
        taskId: { type: 'string', description: 'Claim this specific task (must be in one of the requested statuses). Skips priority/order ranking.' }
      },
      required: ['statuses'],
      additionalProperties: false
    },
    handler: async (args, state) => {
      // Use StateManager's mutex to prevent race conditions with plugin assignments
      return state.runExclusive(async () => {
        const params = (args || {}) as { statuses?: string[]; epicId?: string; workerId?: string; replaceExisting?: boolean; taskId?: string };
        const statuses = params.statuses || [];
        if (statuses.length === 0) {
          throw missingRequired('statuses');
        }

        if (!state.project) {
          throw invalidState('StateManager', 'unloaded', 'loaded');
        }

        let tasks: Task[];
        if (params.taskId) {
          const requested = state.getTask(params.taskId);
          if (!requested) {
            throw notFound('Task', params.taskId);
          }
          if (!statuses.includes(requested.status)) {
            throw invalidState('Task', requested.status, statuses.join('|'));
          }
          if (params.epicId && requested.epicId !== params.epicId) {
            throw notAllowed(
              'claim',
              `Task ${requested.id} belongs to epic ${requested.epicId}, not ${params.epicId}`
            );
          }
          if (!state.isTaskClaimable(requested) && !params.replaceExisting) {
            throw notAllowed(
              'claim',
              `Task ${requested.id} is already assigned to ${requested.assignedWorkerId}. Pass replaceExisting:true to take over.`
            );
          }
          tasks = [requested];
        } else {
          tasks = Array.from(state.tasks.values())
            .filter((t) => statuses.includes(t.status))
            .filter((t) => (params.epicId ? t.epicId === params.epicId : true))
            .filter((t) => state.isTaskClaimable(t))
            .sort((a, b) => {
              const pa = PRIORITY_WEIGHT[a.priority] ?? PRIORITY_WEIGHT.MEDIUM;
              const pb = PRIORITY_WEIGHT[b.priority] ?? PRIORITY_WEIGHT.MEDIUM;
              if (pa !== pb) return pa - pb;
              return a.order - b.order;
            });
        }

      if (tasks.length === 0) {
        // Architect entering an empty PLANNING queue → suggest governance instead of just waiting.
        // Only when the caller is an architect-style claim (PLANNING status) AND a worker entity
        // is already registered (so a fresh first-time caller still gets the original wait_for_task).
        const isArchitectClaim =
          statuses.includes('PLANNING') &&
          !statuses.includes('WORKING') &&
          !statuses.includes('REVIEW');
        const knownWorker = params.workerId ? state.getWorker(params.workerId) : null;

        if (isArchitectClaim && params.workerId && knownWorker) {
          return {
            hasNext: false,
            nextAction: {
              tool: 'moe.enter_governance',
              args: { workerId: params.workerId },
              reason: 'No PLANNING tasks left. Switch to governance: oversee in-flight work via chat until new plans are needed.'
            }
          };
        }

        return {
          hasNext: false,
          nextAction: {
            tool: 'moe.wait_for_task',
            args: { statuses, workerId: params.workerId, epicId: params.epicId },
            reason: 'No claimable task right now; block until one appears.'
          }
        };
      }

      // Try each candidate task in priority order; fall through on concurrency conflicts
      let task = tasks[0];
      let claimed = false;
      for (const candidate of tasks) {
        task = candidate;

        // Enforce single worker per epic constraint - but allow different roles to work in parallel
        if (params.workerId) {
          if (state.isTaskAssignedToMissingWorker(candidate)) {
            await state.updateTask(candidate.id, { assignedWorkerId: null }, 'WORKER_REPLACED');
          }

          const tasksInEpic = Array.from(state.tasks.values())
            .filter((t) =>
              t.epicId === candidate.epicId &&
              t.assignedWorkerId &&
              !state.isTaskAssignedToMissingWorker(t) &&
              t.assignedWorkerId !== params.workerId
            );

          const claimingStatus = candidate.status;
          const activeWorkerOnSameStatus = tasksInEpic.find(
            (t) => t.status === claimingStatus
          );

          if (activeWorkerOnSameStatus && !params.replaceExisting) {
            const claimingWorkerTeam = state.getTeamForWorker(params.workerId);
            if (!claimingWorkerTeam) {
              // Solo worker -> skip this epic's tasks, try next candidate
              continue;
            }
          }

          // If replaceExisting is true, clear the previous worker's assignment
          if (activeWorkerOnSameStatus && params.replaceExisting) {
            await state.updateTask(activeWorkerOnSameStatus.id, { assignedWorkerId: null }, 'WORKER_REPLACED');
          }

          try {
            task = await state.updateTask(candidate.id, { assignedWorkerId: params.workerId });
          } catch (err: unknown) {
            // Optimistic concurrency failure — task was claimed between filter and assign
            if (err instanceof Error && err.message.startsWith('Task already assigned')) {
              continue; // Try next candidate
            }
            throw err; // Unexpected error — propagate
          }

          // Auto-register or update worker entity
          const existingWorker = state.getWorker(params.workerId);
          if (!existingWorker) {
            const workerType: WorkerType = 'CLAUDE';
            await state.createWorker({
              id: params.workerId,
              type: workerType,
              projectId: state.project!.id,
              epicId: candidate.epicId,
              currentTaskId: candidate.id,
              status: 'READING_CONTEXT'
            });

            try {
              const roleLabel = statuses.includes('PLANNING') ? 'architect'
                : statuses.includes('REVIEW') ? 'qa' : 'worker';
              await state.postToGeneral(`${params.workerId} is online (${roleLabel})`);
            } catch { /* never block claim */ }
          } else {
            await state.updateWorker(params.workerId, {
              currentTaskId: candidate.id,
              epicId: candidate.epicId,
              status: 'READING_CONTEXT'
            });
          }
        }

        // Successfully claimed this task
        claimed = true;
        break;
      }

      if (!claimed) {
        return {
          hasNext: false,
          nextAction: {
            tool: 'moe.wait_for_task',
            args: { statuses, workerId: params.workerId, epicId: params.epicId },
            reason: 'All candidate tasks were taken by concurrent workers; wait and retry.'
          }
        };
      }

      // Post system message to #general so the team sees who claimed it
      if (params.workerId) {
        try {
          await state.postToGeneral(`${params.workerId} claimed task: ${task.title}`);
        } catch { /* never block tool */ }
      }

      // Find #general and role channel IDs for the response
      let generalChannelId: string | null = null;
      let roleChannelId: string | null = null;
      const roleLabel = statuses.includes('PLANNING') ? 'architects'
        : statuses.includes('REVIEW') ? 'qa' : 'workers';
      for (const ch of state.channels.values()) {
        if (ch.type === 'general' || ch.name === 'general') {
          generalChannelId = ch.id;
        }
        if (ch.type === 'role' && ch.name === roleLabel) {
          roleChannelId = ch.id;
        }
      }

      // Build chat hint pointing to the role channel
      let chatHint: string | undefined;
      const hintChannel = roleChannelId || generalChannelId;
      if (hintChannel) {
        if (task.reopenCount > 0) {
          chatHint = `REOPENED TASK — check #${roleLabel} for context and coordinate with your team: moe.chat_read { channel: "${hintChannel}", workerId: "${params.workerId || 'your-id'}" }`;
        } else {
          chatHint = `Join #${roleLabel} to coordinate with your team: moe.chat_read { channel: "${hintChannel}", workerId: "${params.workerId || 'your-id'}" }`;
        }
      }

      return {
        hasNext: true,
        task: {
          id: task.id,
          epicId: task.epicId,
          title: task.title,
          status: task.status,
          priority: task.priority,
          assignedWorkerId: task.assignedWorkerId,
          reopenCount: task.reopenCount,
          reopenReason: task.reopenReason,
          rejectionDetails: task.rejectionDetails || null,
          roleChannelId,
          generalChannelId
        },
        ...(task.reopenCount > 0
          ? {
              reopenWarning: `WARNING: This task was rejected by QA (${task.reopenCount} time(s)). Read reopenReason and rejectionDetails carefully. Fix the identified issues before proceeding.`
            }
          : {}),
        ...(chatHint ? { chatHint } : {}),
        nextAction: {
          tool: 'moe.get_context',
          args: { taskId: task.id },
          reason: 'Always fetch full task context (rails, DoD, memory) before acting.',
          // get_context will recommend the role-appropriate skill once it sees task.status,
          // so we don't pre-recommend here unless the task is reopened — the reopen
          // signal is exactly the situation receiving-code-review covers.
          ...(task.reopenCount > 0
            ? { recommendedSkill: recommendSkillFor('worker', 'reopened') }
            : {})
        }
      };
      });
    }
  };
}
