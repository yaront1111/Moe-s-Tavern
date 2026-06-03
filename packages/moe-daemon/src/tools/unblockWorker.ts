import type { ToolDefinition } from './index.js';
import type { StateManager } from '../state/StateManager.js';
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
      // active task it still holds (route to a claimable column) BEFORE nulling
      // its pointer. Otherwise the task is stranded WORKING/assigned to a now-IDLE
      // worker that no sweep can free — a permanent orphan. Mirrors the
      // blocked-timeout release in StateManager.checkBlockedTimeouts. MCP handlers
      // run under the state mutex, so the worker + task writes stay atomic.
      const releasedTaskIds: string[] = [];
      if (!params.retryTask) {
        for (const owned of state.getActiveTasksAssignedToWorker(params.workerId)) {
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
        message: `Worker ${updated.id} unblocked. Resolution: ${params.resolution}`
      };
    }
  };
}
