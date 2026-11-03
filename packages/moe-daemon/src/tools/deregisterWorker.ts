import type { ToolDefinition } from './index.js';
import type { StateManager } from '../state/StateManager.js';
import { missingRequired } from '../util/errors.js';
import { deregisterWorker } from '../state/workerLifecycle.js';

export function deregisterWorkerTool(_state: StateManager): ToolDefinition {
  return {
    name: 'moe.deregister_worker',
    description:
      'Deregister a worker: FIRST close every attempt of this worker still in the finalizing phase (keyed on the attempt, ' +
      'so it works even after the worker record was pruned, and an exiting runner cannot wedge its row), then release every ' +
      'task it held (dropping their leases and queue entries on resources declared releaseOnDeregister), mark the record DEAD (kept, not deleted) and post chat-leave messages. ' +
      'Called by the agent wrapper shell trap on terminal close (try/finally in moe-agent.ps1, ' +
      'trap EXIT in moe-agent.sh). Idempotent — a repeat call on a DEAD worker that holds no task is a quiet ' +
      'close-only retry: it retries a failed finalizing close and posts nothing. ' +
      'A non-DEAD seat holding an active task with reason wrapper_restart instead keeps its tasks for settings.reloadHoldMs ' +
      '(default 2 minutes, 0 disables), until its next claim or the reload-hold expiry sweep.',
    inputSchema: {
      type: 'object',
      properties: {
        workerId: { type: 'string', description: 'Worker ID to deregister' },
        reason: { type: 'string', description: 'Short reason ("terminal_closed", "crashed", etc.). Default: "deregistered".' },
      },
      required: ['workerId'],
      additionalProperties: false,
    },
    handler: async (args, state) => {
      const params = (args || {}) as { workerId?: string; reason?: string };
      if (!params.workerId) throw missingRequired('workerId');
      const reason = (params.reason ?? 'deregistered').slice(0, 200);

      return state.runExclusive(async () => {
        const result = await deregisterWorker(state, params.workerId!, reason);
        return {
          success: true,
          workerId: result.workerId,
          alreadyDead: result.alreadyDead,
          releasedTaskIds: result.released.map((r) => r.taskId),
          releasedCount: result.released.length,
          heldTaskIds: result.held,
          ...(result.holdUntil !== undefined ? { holdUntil: result.holdUntil } : {}),
          message: result.held.length > 0
            ? `${result.workerId} reloading; holding ${result.held.length} task(s) for its relaunch until ${result.holdUntil}`
            : result.alreadyDead
              ? `${result.workerId} already deregistered`
              : `${result.workerId} deregistered; released ${result.released.length} task(s)`,
        };
      });
    },
  };
}
