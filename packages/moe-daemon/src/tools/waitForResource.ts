import type { ToolDefinition } from './index.js';
import type { StateManager } from '../state/StateManager.js';
import { missingRequired, invalidInput, notFound } from '../util/errors.js';
import { assertWorkerOwns } from '../util/enforcement.js';
import { getQueuePosition, RESOURCE_ID_RE } from '../state/resourceStore.js';
import { logger } from '../util/logger.js';

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const MAX_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

interface ActiveResourceWaiter {
  resolve: (value: unknown) => void;
  unsubscribe: () => void;
  timer: NodeJS.Timeout;
}

/** Map of workerId -> active waiter. Exported for disconnect cleanup (WebSocketServer). */
export const activeResourceWaiters = new Map<string, ActiveResourceWaiter>();

/** Remove waiters for workers that no longer exist in memory. Mirrors cleanupStaleWaiters. */
export function cleanupStaleResourceWaiters(state: StateManager): number {
  let cleaned = 0;
  for (const [workerId, waiter] of activeResourceWaiters.entries()) {
    if (state.workers.has(workerId)) continue;
    try { clearTimeout(waiter.timer); } catch (error) {
      logger.warn({ workerId, error }, 'Failed to clear stale resource-waiter timeout');
    }
    try { waiter.unsubscribe(); } catch (error) {
      logger.warn({ workerId, error }, 'Failed to unsubscribe stale resource waiter');
    }
    try { waiter.resolve({ granted: false, cancelled: true }); } catch (error) {
      logger.warn({ workerId, error }, 'Failed to resolve stale resource waiter');
    }
    activeResourceWaiters.delete(workerId);
    cleaned += 1;
  }
  return cleaned;
}

export function waitForResourceTool(_state: StateManager): ToolDefinition {
  return {
    name: 'moe.wait_for_resource',
    blocking: true,
    description: 'Block until this task\'s lease on a shared resource is granted (or the timeout fires). Ensures you are queued first (same semantics as moe.acquire_resource), so a bare wait_for_resource call is safe. Prefer moe.report_blocked + session exit for waits expected to run hours — this tool is for short waits inside a live session.',
    inputSchema: {
      type: 'object',
      properties: {
        resourceId: { type: 'string' },
        taskId: { type: 'string' },
        workerId: { type: 'string', description: 'Your worker ID (used for cleanup on disconnect)' },
        timeoutMs: { type: 'number', description: 'Max wait time in ms (default 300000, max 600000)' }
      },
      required: ['resourceId', 'taskId', 'workerId'],
      additionalProperties: false
    },
    handler: async (args, state) => {
      const params = (args || {}) as { resourceId?: string; taskId?: string; workerId?: string; timeoutMs?: number };
      const { resourceId, taskId, workerId } = params;
      if (!resourceId) throw missingRequired('resourceId');
      if (!taskId) throw missingRequired('taskId');
      if (!workerId) throw missingRequired('workerId');
      if (!RESOURCE_ID_RE.test(resourceId)) {
        throw invalidInput('resourceId', 'use 1-64 chars of letters, digits, ".", "_", "-"');
      }
      const task = state.getTask(taskId);
      if (!task) throw notFound('Task', taskId);
      assertWorkerOwns(task, workerId, 'moe.wait_for_resource');
      await state.touchWorker(workerId);

      // Cancel any existing waiter for this worker (re-entry replaces).
      const existing = activeResourceWaiters.get(workerId);
      if (existing) {
        clearTimeout(existing.timer);
        existing.unsubscribe();
        existing.resolve({ granted: false, cancelled: true });
        activeResourceWaiters.delete(workerId);
      }

      // Blocking tools are dispatched WITHOUT the state mutex — take it for the
      // mutation (grant-or-enqueue), then subscribe lock-free for the park.
      const immediate = await state.runExclusive(() => state.acquireResource({
        resourceId, taskId, workerId,
      }));
      if (immediate.granted) {
        return {
          granted: true,
          resourceId,
          lease: immediate.lease,
          nextAction: {
            tool: 'moe.release_resource',
            args: { resourceId, taskId, workerId },
            reason: 'Lease granted. Run the resource-bound work now, then release so the next waiter unparks.',
          },
        };
      }

      const timeoutMs = Math.min(Math.max(params.timeoutMs || DEFAULT_TIMEOUT_MS, 1000), MAX_TIMEOUT_MS);
      logger.info({ workerId, taskId, resourceId, timeoutMs }, 'Worker waiting for resource');

      return new Promise<unknown>((resolve) => {
        let cleanedUp = false;
        let timer: ReturnType<typeof setTimeout> | null = null;
        let unsubscribe: (() => void) | null = null;

        const cleanup = () => {
          if (cleanedUp) return;
          cleanedUp = true;
          if (timer) clearTimeout(timer);
          if (unsubscribe) {
            try { unsubscribe(); } catch { /* already torn down */ }
          }
          activeResourceWaiters.delete(workerId);
        };

        timer = setTimeout(() => {
          cleanup();
          logger.info({ workerId, resourceId }, 'Wait for resource timed out');
          void state.touchWorker(workerId)
            .catch((error) => logger.warn({ workerId, error }, 'Failed to refresh worker heartbeat on wait_for_resource timeout'))
            .finally(() => {
              resolve({
                granted: false,
                timedOut: true,
                resourceId,
                position: getQueuePosition(state, resourceId, taskId),
                nextAction: {
                  tool: 'moe.wait_for_resource',
                  args: { resourceId, taskId, workerId, timeoutMs },
                  reason: 'Timeout elapsed; re-enter wait to keep listening — or report_blocked to park the task instead of holding a session open.',
                },
              });
            });
        }, timeoutMs);
        if (timer.unref) timer.unref();

        try {
          unsubscribe = state.subscribe((event) => {
            if (event.type !== 'RESOURCE_UPDATED') return;
            if (event.payload.id !== resourceId) return;
            const lease = event.payload.holders.find((h) => h.taskId === taskId);
            if (!lease) return;
            cleanup();
            logger.info({ workerId, taskId, resourceId }, 'Resource granted, waking worker');
            resolve({
              granted: true,
              resourceId,
              lease,
              nextAction: {
                tool: 'moe.release_resource',
                args: { resourceId, taskId, workerId },
                reason: 'Lease granted. Run the resource-bound work now, then release so the next waiter unparks.',
              },
            });
          });
        } catch (err) {
          cleanup();
          logger.error({ workerId, resourceId, err }, 'Failed to subscribe in wait_for_resource');
          resolve({ granted: false, error: 'subscribe_failed' });
          return;
        }

        activeResourceWaiters.set(workerId, {
          resolve,
          unsubscribe: () => cleanup(),
          timer: timer!,
        });
      });
    }
  };
}
