import type { ToolDefinition } from './index.js';
import type { StateManager } from '../state/StateManager.js';
import type { ChatMessage } from '../types/schema.js';
import { invalidInput, missingRequired } from '../util/errors.js';
import { logger } from '../util/logger.js';
import {
  countTruncatedMessages,
  DEFAULT_CHAT_CONTENT_CHARS,
  MAX_CHAT_CONTENT_CHARS,
  truncateChatMessages,
} from '../util/chatPayload.js';

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
        timeoutMs: { type: 'number', description: 'Max wait time in ms (default 300000, max 600000)' },
        maxContentChars: {
          type: 'number',
          description: 'Max chars per message content in the response (default 1000, 0 = full content)'
        }
      },
      required: ['workerId'],
      additionalProperties: false
    },
    handler: async (args, state) => {
      const params = (args || {}) as {
        workerId?: string;
        channels?: string[];
        timeoutMs?: number;
        maxContentChars?: number;
      };

      if (!params.workerId) throw missingRequired('workerId');
      if (typeof params.workerId !== 'string') {
        throw invalidInput('workerId', 'must be a string');
      }
      if (
        params.maxContentChars !== undefined &&
        (typeof params.maxContentChars !== 'number' || !Number.isFinite(params.maxContentChars) || params.maxContentChars < 0)
      ) {
        throw invalidInput('maxContentChars', 'must be a non-negative finite number');
      }
      if (params.channels !== undefined) {
        if (!Array.isArray(params.channels)) {
          throw invalidInput('channels', 'must be an array of channel IDs');
        }
        for (const ch of params.channels) {
          if (typeof ch !== 'string' || !ch) {
            throw invalidInput('channels', 'each channel ID must be a non-empty string');
          }
          if (!state.getChannel(ch)) {
            throw invalidInput('channels', `unknown channel: ${ch}`);
          }
        }
      }

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
      const maxContentChars = params.maxContentChars !== undefined
        ? Math.min(Math.floor(params.maxContentChars), MAX_CHAT_CONTENT_CHARS)
        : DEFAULT_CHAT_CONTENT_CHARS;

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
          // If a channel this waiter cares about is deleted, resolve with a
          // clear error so the caller doesn't hang on a phantom subscription.
          if (event.type === 'CHANNEL_DELETED') {
            const deletedChannelId = (event.payload as { id?: string } | undefined)?.id;
            if (deletedChannelId && channelSet && channelSet.has(deletedChannelId)) {
              cleanup();
              logger.info(
                { workerId, channel: deletedChannelId },
                'Chat wait aborted: subscribed channel was deleted'
              );
              resolve({
                hasMessage: false,
                cancelled: true,
                error: `Channel ${deletedChannelId} was deleted while waiting`
              });
            }
            return;
          }

          if (event.type !== 'MESSAGE_CREATED') return;

          const message = event.payload as ChatMessage;

          if (channelSet) {
            // Caller subscribed to specific channels — the subscription set
            // IS the filter. Any message in those channels is relevant (this
            // matches the governor's "watch #governors for any signal"
            // expectation in docs/roles/governor.md).
            if (!channelSet.has(message.channel)) return;
          } else {
            // No explicit channel filter — fall back to the conservative
            // mention/human filter so workers in broad-scope chat_wait
            // aren't woken on every chatter.
            const targets = (event as { routingTargets?: string[] }).routingTargets ?? message.mentions ?? [];
            const isRelevant = targets.includes(workerId) || message.sender === 'human';
            if (!isRelevant) return;
          }

          cleanup();
          logger.info({ workerId, messageId: message.id, sender: message.sender }, 'Chat message received, waking worker');
          const messages = truncateChatMessages([message], maxContentChars);
          const truncated = countTruncatedMessages(messages);
          resolve({
            hasMessage: true,
            messages,
            truncated,
            ...(truncated > 0
              ? { hint: 'Long chat messages are truncated by default. Use moe.chat_read with maxContentChars: 0 for full content.' }
              : {})
          });
        });

        activeChatWaiters.set(workerId, { resolve, unsubscribe, timer, channels: channelSet });
      });
    }
  };
}
