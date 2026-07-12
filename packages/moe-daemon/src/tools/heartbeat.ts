import type { ToolDefinition } from './index.js';
import type { StateManager } from '../state/StateManager.js';

/**
 * No-op liveness ping. Exists so the agent wrapper can refresh a worker's
 * lastActivityAt from a sidecar process while the CLI subprocess it launched
 * is blocked on a long silent local step (a build, a test run) that makes no
 * moe.* calls of its own. Without this, the REVIEW self-heal sweep (and the
 * 120s isWorkerAlive presence window) can't tell "silently working" apart
 * from "crashed" — both look identical from the daemon's side, since
 * moe-proxy opens a fresh connection per RPC rather than holding one for the
 * CLI's lifetime (see WebSocketServer.cleanupMcpWorkers).
 */
export function heartbeatTool(_state: StateManager): ToolDefinition {
  return {
    name: 'moe.heartbeat',
    description: 'Liveness ping: refreshes the calling worker\'s lastActivityAt with no other side effects. Used by the agent wrapper sidecar during long silent steps; not intended to be called by agents directly.',
    inputSchema: {
      type: 'object',
      properties: {
        workerId: { type: 'string', description: 'Worker to refresh.' }
      },
      required: ['workerId'],
      additionalProperties: false
    },
    handler: async (args, state) => {
      const params = args as { workerId: string };
      // touchWorker no-ops on a missing/DEAD worker record, so a heartbeat
      // racing a legitimate deregister/completion is always safe.
      await state.touchWorker(params.workerId);
      return { ok: true };
    }
  };
}
