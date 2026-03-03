import type { ToolDefinition } from './index.js';
import type { StateManager } from '../state/StateManager.js';
import type { ChatMessage } from '../types/schema.js';
import { missingRequired } from '../util/errors.js';
import { logger } from '../util/logger.js';

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const MAX_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

export interface ActiveChatWaiter {
  resolve: (value: unknown) => void;
  unsubscribe: () => void;
  timer: NodeJS.Timeout;
  channels: Set<string> | null; // null means watching all channels
}

/** Map of workerId -> active chat waiter. Exported for disconnect cleanup. */
export const activeChatWaiters = new Map<string, ActiveChatWaiter>();

/**
 * Remove stale chat waiters for workers that no longer exist.
 */
export function cleanupStaleChatWaiters(state: StateManager): number {
  let cleaned = 0;
  for (const [workerId, waiter] of activeChatWaiters.entries()) {
    if (state.workers.has(workerId)) continue;

    try { clearTimeout(waiter.timer); } catch { /* ignore */ }
    try { waiter.unsubscribe(); } catch { /* ignore */ }
    try { waiter.resolve({ hasMessage: false, cancelled: true }); } catch { /* ignore */ }

    activeChatWaiters.delete(workerId);
    cleaned++;
  }
  return cleaned;
}

export function chatWaitTool(_state: StateManager): ToolDefinition {
  return {
    name: 'moe.chat_wait',
    description: 'Long-poll for chat messages mentioning this worker or from humans. Returns when a relevant message arrives or timeout.',
    inputSchema: {
      type: 'object',
      properties: {
        workerId: { type: 'string', description: 'Your worker ID (messages mentioning you will trigger)' },
        channels: { type: 'array', items: { type: 'string' }, description: 'Optional channel filter' },
        timeoutMs: { type: 'number', description: 'Max wait time in ms (default 300000, max 600000)' }
      },
      required: ['workerId'],
      additionalProperties: false
    },
    handler: async (args, state) => {
      const params = (args || {}) as {
        workerId?: string;
        channels?: string[];
        timeoutMs?: number;
      };

      if (!params.workerId) throw missingRequired('workerId');

      // Cancel any existing chat waiter for this worker
      const existing = activeChatWaiters.get(params.workerId);
      if (existing) {
        clearTimeout(existing.timer);
        existing.unsubscribe();
        existing.resolve({ hasMessage: false, cancelled: true });
        activeChatWaiters.delete(params.workerId);
      }

      const timeoutMs = Math.min(
        Math.max(params.timeoutMs || DEFAULT_TIMEOUT_MS, 1000),
        MAX_TIMEOUT_MS
      );

      const channelSet = params.channels ? new Set(params.channels) : null;
      const workerId = params.workerId;

      logger.info({ workerId, channels: params.channels, timeoutMs }, 'Worker waiting for chat message');

      return new Promise<unknown>((resolve) => {
        const cleanup = () => {
          clearTimeout(timer);
          unsubscribe();
          activeChatWaiters.delete(workerId);
        };

        const timer = setTimeout(() => {
          cleanup();
          logger.info({ workerId }, 'Chat wait timed out');
          resolve({ hasMessage: false, timedOut: true });
        }, timeoutMs);

        if (timer.unref) {
          timer.unref();
        }

        const unsubscribe = state.subscribe((event) => {
          if (event.type !== 'MESSAGE_CREATED') return;

          const message = event.payload as ChatMessage;

          // Filter by channel if specified
          if (channelSet && !channelSet.has(message.channel)) return;

          // Use routing targets (expanded from @all, loop guards applied) for delivery,
          // falling back to raw mentions if routingTargets not present
          const targets = (event as { routingTargets?: string[] }).routingTargets ?? message.mentions ?? [];
          const isRelevant = targets.includes(workerId) ||
            message.sender === 'human';

          if (!isRelevant) return;

          cleanup();
          logger.info({ workerId, messageId: message.id, sender: message.sender }, 'Chat message received, waking worker');
          resolve({ hasMessage: true, messages: [message] });
        });

        activeChatWaiters.set(workerId, { resolve, unsubscribe, timer, channels: channelSet });
      });
    }
  };
}
