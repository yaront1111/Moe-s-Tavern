import type { ToolDefinition } from './index.js';
import type { StateManager } from '../state/StateManager.js';
import { missingRequired, invalidInput, invalidState } from '../util/errors.js';
import { RESOURCE_ID_RE } from '../state/resourceStore.js';
import type { ResourceLease } from '../types/schema.js';

/** One-line identity of a lease, for precondition-failure messages. */
function describeLease(lease: ResourceLease): string {
  return `${lease.workerId} (task ${lease.taskId}, acquired ${lease.acquiredAt})`;
}

export function releaseResourceTool(_state: StateManager): ToolDefinition {
  return {
    name: 'moe.release_resource',
    description: 'Release your lease on a shared resource (and/or leave its queue). The freed capacity is granted to the next waiter immediately, auto-unblocking its task. Idempotent: releasing a resource you do not hold is a no-op. force=true (governor/human) releases another holder\'s lease — pass ifHolderWorkerId to make that force conditional on the lease still belonging to the holder you measured.',
    inputSchema: {
      type: 'object',
      properties: {
        resourceId: { type: 'string' },
        workerId: { type: 'string' },
        taskId: { type: 'string', description: 'Limit the release to this task\'s lease/queue entry. Default: everything held by workerId. NOTE: taskId scopes a TASK, not a lease generation — the same task\'s lease may since have passed to a different worker. Use ifHolderWorkerId to pin the generation.' },
        force: { type: 'boolean', description: 'Release regardless of ownership (governor/human intervention). With taskId: that lease; without: ALL leases and queue entries.' },
        ifHolderWorkerId: { type: 'string', description: 'Precondition: proceed only if EVERY lease this call would release is still held by this worker — including, under force with no taskId, peer leases the call would also strip. Otherwise nothing is released and the error names the current holder. Guards leases, not queue entries. Use it whenever time passed between reading list_resources and calling this — a human-in-the-loop pause is the common case.' },
        ifAcquiredAt: { type: 'string', description: 'Precondition: proceed only if the targeted lease was acquired at exactly this ISO timestamp (as reported by list_resources). Pins the exact lease generation.' }
      },
      required: ['resourceId', 'workerId'],
      additionalProperties: false
    },
    handler: async (args, state) => {
      const params = (args || {}) as {
        resourceId?: string; workerId?: string; taskId?: string; force?: boolean;
        ifHolderWorkerId?: string; ifAcquiredAt?: string;
      };
      if (!params.resourceId) throw missingRequired('resourceId');
      if (!params.workerId) throw missingRequired('workerId');
      if (!RESOURCE_ID_RE.test(params.resourceId)) {
        throw invalidInput('resourceId', 'use 1-64 chars of letters, digits, ".", "_", "-"');
      }
      await state.touchWorker(params.workerId);

      // ATOMICITY. Nothing can move the lease between this check and the
      // release below, because McpAdapter dispatches every tool without
      // `blocking: true` through `state.runExclusive(invoke)` — and
      // moe.release_resource does not set it. The whole handler, check and
      // release together, runs inside that mutex. That serialization is what
      // makes the precondition sound; do NOT mark this tool `blocking`
      // without replacing the guarantee.
      //
      // Compare-and-swap preconditions. A release is otherwise a blind write:
      // `taskId` bounds the blast radius to one row but asserts nothing about
      // WHICH holder or WHICH acquisition, so a caller acting on a stale
      // list_resources read can tear off a lease that legitimately changed
      // hands in the meantime. These make that a refusal instead.
      if (params.ifHolderWorkerId !== undefined || params.ifAcquiredAt !== undefined) {
        const resource = state.getResource(params.resourceId);
        const holders = resource?.holders ?? [];
        // MUST mirror resourceStore.releaseResource's own `matchesCaller`, or
        // the precondition silently under-covers what the release will strip.
        // The dangerous case is force with NO taskId: the store releases EVERY
        // holder, so filtering to the caller's own leases would validate lease
        // A and let a peer's lease B be torn off unchecked.
        const callerOwns = (l: ResourceLease): boolean =>
          l.workerId === params.workerId ||
          state.getTask(l.taskId)?.assignedWorkerId === params.workerId;
        const targeted = params.force
          ? (params.taskId ? holders.filter((l) => l.taskId === params.taskId) : holders)
          : (params.taskId
              ? holders.filter((l) => l.taskId === params.taskId && callerOwns(l))
              : holders.filter(callerOwns));

        if (targeted.length === 0) {
          const held = holders.length === 0
            ? 'it has no holders'
            : `it is held by ${holders.map(describeLease).join('; ')}`;
          throw invalidState(
            `resource ${params.resourceId}`,
            held,
            `a lease for ${params.taskId ?? params.workerId} matching the stated precondition`
          );
        }

        for (const lease of targeted) {
          if (params.ifHolderWorkerId !== undefined && lease.workerId !== params.ifHolderWorkerId) {
            throw invalidState(
              `resource ${params.resourceId}`,
              `held by ${describeLease(lease)}`,
              `held by ${params.ifHolderWorkerId} (precondition ifHolderWorkerId). The lease changed hands since you read it — re-read list_resources and decide again.`
            );
          }
          if (params.ifAcquiredAt !== undefined && lease.acquiredAt !== params.ifAcquiredAt) {
            throw invalidState(
              `resource ${params.resourceId}`,
              `acquired at ${lease.acquiredAt} by ${lease.workerId}`,
              `acquired at ${params.ifAcquiredAt} (precondition ifAcquiredAt). The lease was re-acquired since you read it — re-read list_resources and decide again.`
            );
          }
        }
      }

      const result = await state.releaseResource({
        resourceId: params.resourceId,
        workerId: params.workerId,
        taskId: params.taskId,
        force: params.force,
      });

      const releasedIds = result.released.map((l) => l.taskId);
      const grantedIds = result.granted.map((l) => l.taskId);
      // Name whose lease was actually torn off. `released` carries task ids only,
      // which hides a forced release of the wrong holder from the caller who did it.
      const releasedHolders = result.released.map((l) => ({
        taskId: l.taskId, workerId: l.workerId, acquiredAt: l.acquiredAt,
      }));
      return {
        success: true,
        resourceId: params.resourceId,
        released: releasedIds,
        releasedHolders,
        removedFromQueue: result.removedFromQueue.map((q) => q.taskId),
        grantedTo: grantedIds,
        message:
          releasedIds.length === 0 && result.removedFromQueue.length === 0
            ? `Nothing to release on ${params.resourceId} for ${params.taskId ?? params.workerId}.`
            : `Released ${params.resourceId}${releasedHolders.length > 0 ? ` (was held by ${releasedHolders.map((l) => l.workerId).join(', ')})` : ''}${grantedIds.length > 0 ? `; granted to ${grantedIds.join(', ')}` : ''}.`,
      };
    }
  };
}
