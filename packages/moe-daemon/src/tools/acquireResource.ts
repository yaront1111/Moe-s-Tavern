import type { ToolDefinition } from './index.js';
import type { StateManager } from '../state/StateManager.js';
import { missingRequired, invalidInput, notFound } from '../util/errors.js';
import { assertWorkerOwns } from '../util/enforcement.js';
import { RESOURCE_ID_RE } from '../state/resourceStore.js';

const MAX_NOTE_LENGTH = 500;

export function acquireResourceTool(_state: StateManager): ToolDefinition {
  return {
    name: 'moe.acquire_resource',
    description: 'Acquire (or queue for) a lease on a shared resource, e.g. an exclusive-use benchmark box. Granted immediately if capacity is free; otherwise you are queued FIFO-by-priority. Idempotent per task: re-calling renews an existing lease. If queued, call moe.report_blocked with the resourceId to park the task — the daemon auto-unblocks it when the lease is granted.',
    inputSchema: {
      type: 'object',
      properties: {
        resourceId: { type: 'string', description: 'Resource name, e.g. "benchmark-box". Undeclared ids are auto-created (capacity 1, 24h max lease).' },
        taskId: { type: 'string', description: 'Task the lease belongs to. Leases are task-keyed so they survive CLI restarts.' },
        workerId: { type: 'string' },
        note: { type: 'string', description: 'What you will run — shown to queued agents and list_resources.' },
        etaMs: { type: 'number', description: 'Your own wall-clock estimate in ms (informational).' }
      },
      required: ['resourceId', 'taskId', 'workerId'],
      additionalProperties: false
    },
    handler: async (args, state) => {
      const params = (args || {}) as {
        resourceId?: string; taskId?: string; workerId?: string; note?: string; etaMs?: number;
      };
      if (!params.resourceId) throw missingRequired('resourceId');
      if (!params.taskId) throw missingRequired('taskId');
      if (!params.workerId) throw missingRequired('workerId');
      if (!RESOURCE_ID_RE.test(params.resourceId)) {
        throw invalidInput('resourceId', 'use 1-64 chars of letters, digits, ".", "_", "-"');
      }
      if (params.note !== undefined && params.note.length > MAX_NOTE_LENGTH) {
        throw invalidInput('note', `too long (${params.note.length} chars). Maximum ${MAX_NOTE_LENGTH}.`);
      }
      if (params.etaMs !== undefined && (!Number.isFinite(params.etaMs) || params.etaMs < 0)) {
        throw invalidInput('etaMs', 'must be a non-negative number of milliseconds');
      }

      const task = state.getTask(params.taskId);
      if (!task) throw notFound('Task', params.taskId);
      assertWorkerOwns(task, params.workerId, 'moe.acquire_resource');
      await state.touchWorker(params.workerId);

      const result = await state.acquireResource({
        resourceId: params.resourceId,
        taskId: params.taskId,
        workerId: params.workerId,
        note: params.note,
        etaMs: params.etaMs,
      });

      if (result.granted) {
        return {
          success: true,
          granted: true,
          resourceId: result.resourceId,
          lease: result.lease,
          message: `Lease on ${result.resourceId} granted to ${params.taskId}. Release it with moe.release_resource when the run finishes — or it auto-releases at ${result.lease?.expiresAt}.`,
        };
      }

      return {
        success: true,
        granted: false,
        resourceId: result.resourceId,
        position: result.position,
        queueLength: result.queueLength,
        holders: result.holders.map((h) => ({
          taskId: h.taskId,
          workerId: h.workerId,
          note: h.note,
          etaMs: h.etaMs,
          acquiredAt: h.acquiredAt,
          expiresAt: h.expiresAt,
        })),
        message: `Resource ${result.resourceId} is busy; you are #${result.position} in the queue.`,
        nextAction: {
          tool: 'moe.report_blocked',
          args: {
            taskId: params.taskId,
            workerId: params.workerId,
            reason: `Waiting for shared resource ${result.resourceId}`,
            resourceId: result.resourceId,
          },
          reason: 'Queued behind the current holder. If you have no other work on this task, park it: report_blocked flips the task to BLOCKED, your wrapper stops relaunching sessions, and the daemon auto-unblocks the task the moment the lease is granted. If you DO have non-resource work left, do that first and re-check with moe.acquire_resource later.',
        },
      };
    }
  };
}
