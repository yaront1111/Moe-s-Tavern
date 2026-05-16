import type { ToolDefinition } from './index.js';
import type { StateManager } from '../state/StateManager.js';
import type { Task, TaskPriority, WorkerType } from '../types/schema.js';
import { missingRequired, notAllowed, invalidState, notFound } from '../util/errors.js';
import { recommendSkillFor } from '../util/recommendSkill.js';
import { computeFileCollisions, DEFAULT_APPEND_ONLY_FILES } from '../util/affectedFiles.js';
import { maybeApplyBudgetWarnings } from '../util/budget.js';
import { captureDiskState, compareDiskState } from '../util/gitState.js';

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
        taskId: { type: 'string', description: 'Claim this specific task (must be in one of the requested statuses). Skips priority/order ranking.' },
        preferAdjacentInEpic: {
          type: 'boolean',
          description: 'When true (default), prefer claimable tasks in the worker\'s current/last epic before falling through to global ranking. Lets a worker waiting on wait_for_task pick up the next claimable task in the same epic.'
        }
      },
      required: ['statuses'],
      additionalProperties: false
    },
    handler: async (args, state) => {
      // Use StateManager's mutex to prevent race conditions with plugin assignments
      return state.runExclusive(async () => {
        const params = (args || {}) as {
          statuses?: string[];
          epicId?: string;
          workerId?: string;
          replaceExisting?: boolean;
          taskId?: string;
          preferAdjacentInEpic?: boolean;
        };
        const statuses = params.statuses || [];
        if (statuses.length === 0) {
          throw missingRequired('statuses');
        }

        if (!state.project) {
          throw invalidState('StateManager', 'unloaded', 'loaded');
        }

        // Governors never claim tasks — they oversee. Route them straight to
        // enter_governance. The role is derived from the worker's team, so a
        // fresh first-time caller without a registered worker falls through to
        // the normal claim path (so onboarding doesn't break).
        if (params.workerId) {
          const team = state.getTeamForWorker(params.workerId);
          if (team?.role === 'governor') {
            return {
              hasNext: false,
              nextAction: {
                tool: 'moe.enter_governance',
                args: { workerId: params.workerId },
                reason: 'Governors do not claim tasks. Enter governance to watch chat, drift, and rejections.'
              }
            };
          }
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
          // Compute the worker's preferred epic for adjacency: explicit
          // params.epicId wins, then their currently-recorded epic on the
          // worker entity (set when they last claimed a task in the same
          // wait loop). Default preferAdjacentInEpic to true.
          const preferAdjacent = params.preferAdjacentInEpic !== false;
          let adjacentEpicId: string | undefined = params.epicId;
          if (!adjacentEpicId && preferAdjacent && params.workerId) {
            const w = state.getWorker(params.workerId);
            adjacentEpicId = w?.epicId || undefined;
          }
          tasks = Array.from(state.tasks.values())
            .filter((t) => statuses.includes(t.status))
            .filter((t) => (params.epicId ? t.epicId === params.epicId : true))
            .filter((t) => state.isTaskClaimable(t))
            .sort((a, b) => {
              // When preferAdjacentInEpic is on and a hint epic is set,
              // rank in-epic candidates ahead of out-of-epic. This lets a
              // worker idling on wait_for_task pick up an adjacent task
              // whose dependencies just cleared, rather than dropping back
              // to the global pool.
              if (preferAdjacent && adjacentEpicId) {
                const aIn = a.epicId === adjacentEpicId ? 0 : 1;
                const bIn = b.epicId === adjacentEpicId ? 0 : 1;
                if (aIn !== bIn) return aIn - bIn;
              }
              const pa = PRIORITY_WEIGHT[a.priority] ?? PRIORITY_WEIGHT.MEDIUM;
              const pb = PRIORITY_WEIGHT[b.priority] ?? PRIORITY_WEIGHT.MEDIUM;
              if (pa !== pb) return pa - pb;
              return a.order - b.order;
            });
        }

      if (tasks.length === 0) {
        // No tasks available — block on wait_for_task regardless of role. Architects
        // on an empty PLANNING queue idle here too; governance is owned by the
        // separate governor role (which is short-circuited above before this point).
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
              // Prefer the worker's registered team role over inferring from
              // the requested statuses (a worker may legitimately claim
              // across multiple status sets).
              const team = state.getTeamForWorker(params.workerId);
              const roleLabel = team?.role
                ?? (statuses.includes('PLANNING')
                  ? 'architect'
                  : statuses.includes('REVIEW') ? 'qa' : 'worker');
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

      // Record firstClaimAt the first time a worker picks this task up, so
      // budget/aggregate metrics can compute wall-clock duration. Idempotent:
      // we never overwrite an existing timestamp.
      if (!task.metrics?.firstClaimAt) {
        const nextMetrics = { ...(task.metrics ?? {}), firstClaimAt: new Date().toISOString() };
        try {
          task = await state.updateTask(task.id, { metrics: nextMetrics });
        } catch { /* never block claim */ }
      }

      // Budget warn/escalate checks run on every WORKING-path tool call so
      // crossings get caught the next time the worker touches Moe — no separate
      // scheduler needed.
      task = await maybeApplyBudgetWarnings(state, task);

      // Compute file-collision warnings against every OTHER WORKING task.
      // Advisory only — never blocks the claim. We post a heads-up to
      // #workers if there's any overlap so peers can sync diffs. Honors
      // ProjectSettings.appendOnlyFiles so CHANGELOG.md doesn't drown the
      // signal.
      const appendOnly = state.project!.settings.appendOnlyFiles ?? DEFAULT_APPEND_ONLY_FILES;
      const fileCollision = computeFileCollisions(task, state.tasks.values(), appendOnly);
      if (fileCollision.length > 0) {
        try {
          const summary = fileCollision
            .map((c) => `${c.task}: ${c.files.slice(0, 3).join(', ')}${c.files.length > 3 ? '…' : ''}`)
            .join(' | ');
          await state.postToRoleChannel(
            'workers',
            `⚠️ file collision on ${task.id}: ${summary}`
          );
        } catch { /* never block tool */ }
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

      // Surface a priorHandoffs hint — workers picking up a released task
      // should pull the handoff history before assuming nothing's been done.
      const hasHandoffs = Array.isArray(task.priorHandoffs) && task.priorHandoffs.length > 0;
      const handoffHint = hasHandoffs
        ? `Previous worker(s) left ${task.priorHandoffs!.length} handoff note(s). Call moe.get_handoff_history { taskId: "${task.id}" } before starting.`
        : undefined;

      // Disk-state freshness check — if the most recent handoff stored a
      // diskState signature, recompute it and tell the claimer whether the
      // prior worker's stated conditions still apply. Prevents refusal-cascade
      // on stale assumptions ("280 uncommitted files from prior worker" when
      // the disk is now clean).
      let staleHandoffDiskState = false;
      let diskStateNote: string | undefined;
      if (hasHandoffs) {
        const latestHandoff = task.priorHandoffs![0];
        if (latestHandoff.diskState && state.project?.rootPath) {
          const current = captureDiskState(state.project.rootPath);
          const cmp = compareDiskState(current, latestHandoff.diskState);
          if (cmp === 'changed') {
            staleHandoffDiskState = true;
            diskStateNote =
              `Prior handoff cited ${latestHandoff.diskState.dirtyFileCount ?? '?'} dirty files; ` +
              `current tree has ${current?.dirtyFileCount ?? '?'}. ` +
              `Reassess before refusing — the previously-cited disk state no longer applies.`;
          }
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
          generalChannelId,
          priorHandoffCount: hasHandoffs ? task.priorHandoffs!.length : 0,
        },
        ...(task.reopenCount > 0
          ? {
              reopenWarning: `WARNING: This task was rejected by QA (${task.reopenCount} time(s)). Read reopenReason and rejectionDetails carefully. Fix the identified issues before proceeding.`
            }
          : {}),
        ...(chatHint ? { chatHint } : {}),
        ...(handoffHint ? { handoffHint } : {}),
        ...(staleHandoffDiskState ? { staleHandoffDiskState: true, diskStateNote } : {}),
        ...(fileCollision.length > 0 ? { fileCollision } : {}),
        nextAction: hasHandoffs
          ? {
              tool: 'moe.get_handoff_history',
              args: { taskId: task.id },
              reason: 'This task was released with handoff notes; read them before claiming work.',
            }
          : {
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
