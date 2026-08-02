import type { ToolDefinition } from './index.js';
import type { StateManager } from '../state/StateManager.js';
import { missingRequired, invalidInput } from '../util/errors.js';
import { RESOURCE_ID_RE } from '../state/resourceStore.js';

export function releaseResourceTool(_state: StateManager): ToolDefinition {
  return {
    name: 'moe.release_resource',
    description: 'Release your lease on a shared resource (and/or leave its queue). The freed capacity is granted to the next waiter immediately, auto-unblocking its task. Idempotent: releasing a resource you do not hold is a no-op. force=true (governor/human) releases another holder\'s lease.',
    inputSchema: {
      type: 'object',
      properties: {
        resourceId: { type: 'string' },
        workerId: { type: 'string' },
        taskId: { type: 'string', description: 'Limit the release to this task\'s lease/queue entry. Default: everything held by workerId.' },
        force: { type: 'boolean', description: 'Release regardless of ownership (governor/human intervention). With taskId: that lease; without: ALL leases and queue entries.' }
      },
      required: ['resourceId', 'workerId'],
      additionalProperties: false
    },
    handler: async (args, state) => {
      const params = (args || {}) as { resourceId?: string; workerId?: string; taskId?: string; force?: boolean };
      if (!params.resourceId) throw missingRequired('resourceId');
      if (!params.workerId) throw missingRequired('workerId');
      if (!RESOURCE_ID_RE.test(params.resourceId)) {
        throw invalidInput('resourceId', 'use 1-64 chars of letters, digits, ".", "_", "-"');
      }
      await state.touchWorker(params.workerId);

      const result = await state.releaseResource({
        resourceId: params.resourceId,
        workerId: params.workerId,
        taskId: params.taskId,
        force: params.force,
      });

      const releasedIds = result.released.map((l) => l.taskId);
      const grantedIds = result.granted.map((l) => l.taskId);
      return {
        success: true,
        resourceId: params.resourceId,
        released: releasedIds,
        removedFromQueue: result.removedFromQueue.map((q) => q.taskId),
        grantedTo: grantedIds,
        message:
          releasedIds.length === 0 && result.removedFromQueue.length === 0
            ? `Nothing to release on ${params.resourceId} for ${params.taskId ?? params.workerId}.`
            : `Released ${params.resourceId}${grantedIds.length > 0 ? `; granted to ${grantedIds.join(', ')}` : ''}.`,
      };
    }
  };
}
