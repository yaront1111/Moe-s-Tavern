import type { ToolDefinition } from './index.js';
import type { StateManager } from '../state/StateManager.js';
import { getQueuePosition } from '../state/resourceStore.js';

export function listResourcesTool(_state: StateManager): ToolDefinition {
  return {
    name: 'moe.list_resources',
    description: 'List every shared resource: declared config, current lease holders (with notes/ETAs/expiry) and the wait queue in grant order. Governors use this to spot convoys, stale leases and merge opportunities.',
    inputSchema: {
      type: 'object',
      properties: {
        workerId: { type: 'string' }
      },
      additionalProperties: false
    },
    handler: async (args, state) => {
      const params = (args || {}) as { workerId?: string };
      if (params.workerId) await state.touchWorker(params.workerId);

      // Union of runtime state and declared-but-idle resources so a declared
      // resource is visible before its first acquire.
      const ids = new Set<string>([
        ...state.resources.keys(),
        ...Object.keys(state.project?.settings?.resources ?? {}),
      ]);

      const resources = Array.from(ids).sort().map((id) => {
        const runtime = state.getResource(id);
        const config = state.resolveResourceConfig(id);
        const queue = (runtime?.queue ?? [])
          .map((q) => ({
            ...q,
            position: getQueuePosition(state, id, q.taskId),
            taskTitle: state.getTask(q.taskId)?.title,
            taskStatus: state.getTask(q.taskId)?.status,
          }))
          .sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
        return {
          id,
          capacity: config.capacity,
          maxLeaseMs: config.maxLeaseMs,
          description: config.description,
          holders: (runtime?.holders ?? []).map((h) => ({
            ...h,
            taskTitle: state.getTask(h.taskId)?.title,
          })),
          queue,
        };
      });

      return { success: true, resources };
    }
  };
}
