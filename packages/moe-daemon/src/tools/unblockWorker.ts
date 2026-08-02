import type { ToolDefinition } from './index.js';
import type { StateManager } from '../state/StateManager.js';
import type { TaskStatus } from '../types/schema.js';
import { missingRequired, notFound, invalidState } from '../util/errors.js';
import { nextStatusForRelease } from '../state/workerLifecycle.js';

export function unblockWorkerTool(_state: StateManager): ToolDefinition {
  return {
    name: 'moe.unblock_worker',
    description: 'Clear BLOCKED status on a worker, setting it back to IDLE',
    inputSchema: {
      type: 'object',
      properties: {
        workerId: { type: 'string', description: 'The worker ID to unblock' },
        resolution: { type: 'string', description: 'What was done to resolve the block' },
        retryTask: {
          type: 'boolean',
          description: 'If true, worker keeps currentTaskId to retry. Default false.'
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
      // blocked-timeout sweep's 'park': unblock_worker means someone explicitly
      // resolved the blocker, so the task goes straight back into its role's
      // claim pool. The sweep parks precisely because nobody resolved it. MCP
      // handlers run under the state mutex, so the worker + task writes stay
      // atomic.
      // A BLOCKED task is un-blocked here regardless of retryTask — this tool
      // IS the human "blocker resolved" lever. Restore blockedFromStatus and
      // clear the block bookkeeping so the sweep/grant paths can't act on
      // stale block state. nextStatusForRelease deliberately keeps BLOCKED
      // tasks BLOCKED on ordinary releases (restart/deregister); this path is
      // the exception because a human asserted the blocker is gone.
      const unblockUpdates = (owned: { blockedFromStatus?: TaskStatus | null }) => ({
        status: (owned.blockedFromStatus ?? 'WORKING') as TaskStatus,
        blockedReason: null,
        blockedResourceId: null,
        blockedFromStatus: null,
        blockedAt: null,
      });

      const releasedTaskIds: string[] = [];
      const unblockedTaskIds: string[] = [];
      for (const owned of state.getActiveTasksAssignedToWorker(params.workerId)) {
        if (owned.status === 'BLOCKED') {
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
          await state.updateTask(owned.id, {
            assignedWorkerId: null,
            status: nextStatusForRelease(owned),
          }, 'WORKER_UNBLOCKED');
          releasedTaskIds.push(owned.id);
        }
      }

      const updated = await state.updateWorker(params.workerId, updates, 'WORKER_UNBLOCKED');

      return {
        success: true,
        workerId: updated.id,
        status: updated.status,
        currentTaskId: updated.currentTaskId,
        resolution: params.resolution,
        retryTask: params.retryTask || false,
        ...(releasedTaskIds.length ? { releasedTaskIds } : {}),
        ...(unblockedTaskIds.length ? { unblockedTaskIds } : {}),
        message: `Worker ${updated.id} unblocked. Resolution: ${params.resolution}`
      };
    }
  };
}
