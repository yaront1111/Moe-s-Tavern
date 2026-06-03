import type { ToolDefinition } from './index.js';
import type { StateManager } from '../state/StateManager.js';
import { missingRequired } from '../util/errors.js';
import { deregisterWorker } from '../state/workerLifecycle.js';

export function deregisterWorkerTool(_state: StateManager): ToolDefinition {
  return {
    name: 'moe.deregister_worker',
    description:
      'Mark a worker OFFLINE, release every task it held, and post chat-leave messages. ' +
      'Called by the agent wrapper shell trap on terminal close (try/finally in moe-agent.ps1, ' +
      'trap EXIT in moe-agent.sh). Idempotent — repeat calls on an already-OFFLINE worker are no-ops.',
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
          message: result.alreadyDead
            ? `${result.workerId} already deregistered`
            : `${result.workerId} deregistered; released ${result.released.length} task(s)`,
        };
      });
    },
  };
}
