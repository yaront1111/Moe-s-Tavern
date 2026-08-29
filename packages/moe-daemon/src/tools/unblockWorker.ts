import type { ToolDefinition } from './index.js';
import type { StateManager } from '../state/StateManager.js';
import type { TaskStatus } from '../types/schema.js';
import { missingRequired, notFound, invalidState } from '../util/errors.js';
import { nextStatusForRelease } from '../state/workerLifecycle.js';

export function unblockWorkerTool(_state: StateManager): ToolDefinition {
  return {
    name: 'moe.unblock_worker',
    description: 'Free a BLOCKED worker\'s SEAT: the worker goes back to IDLE and (unless retryTask) its tasks are released/unassigned — a BLOCKED task STAYS BLOCKED with blockedReason intact, exactly like every other release path. Pass resolveBlocks:true to ALSO assert the blocker is gone and restore the worker\'s BLOCKED tasks to blockedFromStatus (clearing blockedReason/blockedAt); moe.set_task_status is the other way to clear a block. With retryTask:true and no resolveBlocks a BLOCKED task is left untouched (still assigned, still BLOCKED).',
    inputSchema: {
      type: 'object',
      properties: {
        workerId: { type: 'string', description: 'The worker ID to unblock' },
        resolution: { type: 'string', description: 'What was done to resolve the block' },
        retryTask: {
          type: 'boolean',
          description: 'If true, worker keeps currentTaskId (and its task assignment) to retry. Default false.'
        },
        resolveBlocks: {
          type: 'boolean',
          description: 'If true, BLOCKED tasks this worker holds are restored to blockedFromStatus and their blocked* fields cleared — the human asserts the blocker is gone. Default false: the task stays BLOCKED (blockedReason kept), only the seat is freed.'
        }
      },
      required: ['workerId', 'resolution'],
      additionalProperties: false
    },
    handler: async (args, state) => {
      const params = (args || {}) as {
        workerId?: string;
        resolution?: string;
        retryTask?: boolean;
        resolveBlocks?: boolean;
      };

      if (!params.workerId) {
        throw missingRequired('workerId');
      }
      if (!params.resolution || params.resolution.trim().length === 0) {
        throw missingRequired('resolution');
      }

      const worker = state.getWorker(params.workerId);
      if (!worker) {
        throw notFound('Worker', params.workerId);
      }

      if (worker.status !== 'BLOCKED') {
        throw invalidState('Worker', worker.status, 'BLOCKED');
      }

      const updates: Record<string, unknown> = {
        status: 'IDLE',
        lastError: null,
      };

      if (!params.retryTask) {
        updates.currentTaskId = null;
      }

      // When the worker is NOT retrying, it no longer owns its task — release any
      // active task it still holds BEFORE nulling its pointer. Otherwise the task
      // is stranded WORKING/assigned to a now-IDLE worker that nothing can free —
      // a permanent orphan. Deliberately 'requeue' (the default), NOT the
      // blocked-timeout sweep's 'park': freeing a seat is not a park. MCP
      // handlers run under the state mutex, so the worker + task writes stay
      // atomic.
      //
      // SEAT-ONLY DEFAULT: a BLOCKED task is routed through nextStatusForRelease
      // exactly like every other release path (restart purge, deregister,
      // release_task), which keeps BLOCKED tasks BLOCKED — the blocker is still
      // there, and governors measurably call this tool to free a wedged SEAT
      // without meaning to declare the blocker gone (the moe-next RE-BLOCK
      // pattern: un-blocked task → next claimer hits the same wall → re-block).
      // `resolveBlocks: true` is the explicit "the human asserts the blocker is
      // gone" lever: restore blockedFromStatus and clear the block bookkeeping
      // so the sweep/grant paths can't act on stale block state.
      const resolveBlocks = params.resolveBlocks === true;
      const unblockUpdates = (owned: { blockedFromStatus?: TaskStatus | null }) => ({
        status: (owned.blockedFromStatus ?? 'WORKING') as TaskStatus,
        blockedReason: null,
        blockedResourceId: null,
        blockedFromStatus: null,
        blockedAt: null,
      });

      const releasedTaskIds: string[] = [];
      const unblockedTaskIds: string[] = [];
      const stillBlockedTaskIds: string[] = [];
      for (const owned of state.getActiveTasksAssignedToWorker(params.workerId)) {
        if (owned.status === 'BLOCKED' && resolveBlocks) {
          // assignedWorkerId is explicit on BOTH arms: updateTask clears the
          // assignment on any status change when the caller omits it, which
          // would strip the retrying worker of the very task it is resuming.
          await state.updateTask(owned.id, {
            ...unblockUpdates(owned),
            assignedWorkerId: params.retryTask ? owned.assignedWorkerId : null,
          }, 'TASK_UNBLOCKED');
          unblockedTaskIds.push(owned.id);
          if (!params.retryTask) releasedTaskIds.push(owned.id);
        } else if (!params.retryTask) {
          // nextStatusForRelease keeps a BLOCKED task BLOCKED (blockedReason,
          // blockedFromStatus and blockedAt untouched); assignedWorkerId must be
          // explicit because the status does not change, so updateTask would
          // not clear it on its own.
          const nextStatus = nextStatusForRelease(owned);
          await state.updateTask(owned.id, {
            assignedWorkerId: null,
            status: nextStatus,
          }, 'WORKER_RELEASED');
          releasedTaskIds.push(owned.id);
          if (nextStatus === 'BLOCKED') stillBlockedTaskIds.push(owned.id);
        } else if (owned.status === 'BLOCKED') {
          // retryTask without resolveBlocks: the task is the wrapper's
          // suppressed hold state (BLOCKED + assigned) and is left exactly as is.
          stillBlockedTaskIds.push(owned.id);
        }
      }

      const updated = await state.updateWorker(params.workerId, updates, 'WORKER_UNBLOCKED');

      const stillBlockedNote = stillBlockedTaskIds.length
        ? ` ${stillBlockedTaskIds.join(', ')} remain${stillBlockedTaskIds.length === 1 ? 's' : ''} BLOCKED (blockedReason kept) — pass resolveBlocks:true or use moe.set_task_status to clear the block.`
        : '';

      return {
        success: true,
        workerId: updated.id,
        status: updated.status,
        currentTaskId: updated.currentTaskId,
        resolution: params.resolution,
        retryTask: params.retryTask || false,
        resolveBlocks,
        ...(releasedTaskIds.length ? { releasedTaskIds } : {}),
        ...(resolveBlocks ? { unblockedTaskIds } : {}),
        stillBlockedTaskIds,
        message: `Worker ${updated.id} seat freed (IDLE).${resolveBlocks ? ` Un-blocked ${unblockedTaskIds.length} task(s).` : ''}${stillBlockedNote} Resolution: ${params.resolution}`
      };
    }
  };
}
