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
const KEEPALIVE_INTERVAL_MS = 60 * 1000; // 60s — bumps worker.lastActivityAt while blocked
const DRAIN_LIMIT_PER_CHANNEL = 50; // safety cap when draining a channel on backfill

export interface ActiveChatWaiter {
  resolve: (value: unknown) => void;
  unsubscribe: () => void;
  timer: NodeJS.Timeout;
  keepalive?: NodeJS.Timeout;
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
    if (waiter.keepalive) {
      try { clearInterval(waiter.keepalive); } catch { /* ignore */ }
    }
    try { waiter.unsubscribe(); } catch { /* ignore */ }
    try { waiter.resolve({ hasMessage: false, cancelled: true }); } catch { /* ignore */ }

    activeChatWaiters.delete(workerId);
    cleaned++;
  }
  return cleaned;
}

/**
 * Drain ALL unread messages across the watched channels for a given worker.
 * Returns a chronologically-sorted batch and the per-channel cursor map that
 * should be persisted after delivery.
 *
 * This is the core of burst-aware chat_wait: when a wake-up arrives, we
 * pull every message since the worker's last cursor — not just the one that
 * triggered the wake — so 5-message bursts never leak past the governor's
 * eyes between successive chat_wait calls.
 *
 * When `channelSet` is null (worker is doing a broad-scope wait), the caller
 * supplies a relevance filter so we don't flood the worker with every chatter
 * from channels they're not watching. When `channelSet` is non-null we trust
 * the channel selection — every message in those channels is relevant by
 * construction.
 */
async function drainUnreadMessages(
  state: StateManager,
  workerId: string,
  channelSet: Set<string> | null,
  sinceIdOverride: string | undefined,
  relevanceFilter: ((m: ChatMessage) => boolean) | null,
  exceptMessageId?: string,
): Promise<{ messages: ChatMessage[]; cursorUpdates: Record<string, string> }> {
  const channels = channelSet
    ? Array.from(channelSet)
    : state.getChannels().map((c) => c.id);

  const worker = state.getWorker(workerId);
  const existingCursors = worker?.chatCursors ?? {};

  const batch: ChatMessage[] = [];
  for (const channelId of channels) {
    // sinceIdOverride is rare (post-reconnect catchup). When set, apply to
    // every channel. Otherwise fall back to the worker's per-channel cursor.
    const sinceId = sinceIdOverride ?? existingCursors[channelId];
    let pulled: ChatMessage[];
    try {
      pulled = await state.getMessages(channelId, { sinceId, limit: DRAIN_LIMIT_PER_CHANNEL });
    } catch {
      // Channel might have been deleted concurrently — skip it.
      continue;
    }
    for (const m of pulled) {
      if (exceptMessageId && m.id === exceptMessageId) continue;
      if (relevanceFilter && !relevanceFilter(m)) continue;
      batch.push(m);
    }
  }

  // Sort chronologically — `timestamp` lexicographic on ISO strings is fine.
  batch.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  // Build cursor map: latest delivered message per channel.
  const cursorUpdates: Record<string, string> = {};
  for (const m of batch) {
    cursorUpdates[m.channel] = m.id;
  }
  return { messages: batch, cursorUpdates };
}

export function chatWaitTool(_state: StateManager): ToolDefinition {
  return {
    name: 'moe.chat_wait',
    description:
      'Long-poll for chat messages. Returns ALL unread messages in the watched channels (not just the wake trigger) so bursts and post-reconnect gaps never get lost. Workers track per-channel cursors automatically; pass sinceId for explicit catchup.',
    inputSchema: {
      type: 'object',
      properties: {
        workerId: { type: 'string', description: 'Your worker ID — required for cursor tracking and relevance filtering.' },
        channels: { type: 'array', items: { type: 'string' }, description: 'Optional channel filter. Omit to watch all channels with mention/human-relevance filtering.' },
        timeoutMs: { type: 'number', description: 'Max wait time in ms (default 300000, max 600000)' },
        maxContentChars: {
          type: 'number',
          description: 'Max chars per message content in the response (default 1000, 0 = full content)'
        },
        sinceId: {
          type: 'string',
          description: 'Optional anchor message ID. When provided, the backfill drains every message after this ID across the watched channels — useful after a daemon reconnect when the auto-cursor is stale.'
        },
        backfillOnEntry: {
          type: 'boolean',
          description: 'When true (default), check for unread messages before blocking and return immediately if any exist. Set false to force pure long-poll semantics.'
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
        sinceId?: string;
        backfillOnEntry?: boolean;
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
      if (params.sinceId !== undefined && (typeof params.sinceId !== 'string' || !params.sinceId)) {
        throw invalidInput('sinceId', 'must be a non-empty string when provided');
      }

      // Cancel any existing chat waiter for this worker
      const existing = activeChatWaiters.get(params.workerId);
      if (existing) {
        clearTimeout(existing.timer);
        if (existing.keepalive) clearInterval(existing.keepalive);
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
      const backfillOnEntry = params.backfillOnEntry !== false;

      // Relevance filter for the no-channel-filter path. When the worker
      // watches "all channels" we don't want to flood them with every chatter;
      // only mentions + human messages count. Mirrors the wake-time filter
      // below so backfill and wake behavior agree.
      const relevanceFilter = channelSet
        ? null
        : (m: ChatMessage) =>
            (m.mentions && m.mentions.includes(workerId)) || m.sender === 'human';

      // ---- ENTRY-TIME BACKFILL --------------------------------------------
      // If the worker has unread messages already waiting, return them now
      // instead of blocking. This is the half of "never miss" that pure
      // long-poll chat_wait got wrong: messages that arrived BEFORE chat_wait
      // was called (post-reconnect, between successive polls) were invisible
      // until an explicit chat_read.
      if (backfillOnEntry) {
        const drained = await drainUnreadMessages(
          state,
          workerId,
          channelSet,
          params.sinceId,
          relevanceFilter,
        );
        if (drained.messages.length > 0) {
          if (Object.keys(drained.cursorUpdates).length > 0) {
            try {
              await state.updateWorkerCursors(workerId, drained.cursorUpdates);
            } catch { /* never block tool */ }
          }
          const messages = truncateChatMessages(drained.messages, maxContentChars);
          const truncated = countTruncatedMessages(messages);
          logger.info(
            { workerId, count: messages.length, source: 'entry-backfill' },
            'Chat wait: backfilled on entry',
          );
          return {
            hasMessage: true,
            messages,
            truncated,
            source: 'backfill',
            ...(truncated > 0
              ? { hint: 'Long chat messages are truncated by default. Use moe.chat_read with maxContentChars: 0 for full content.' }
              : {})
          };
        }
      }

      logger.info({ workerId, channels: params.channels, timeoutMs }, 'Worker waiting for chat message');

      return new Promise<unknown>((resolve) => {
        const cleanup = () => {
          clearTimeout(timer);
          if (keepalive) clearInterval(keepalive);
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

        // Keep the worker registry alive while we block. Without this the
        // 2-min listWorkers cutoff and the 30-min stale-release watcher
        // treat actively-waiting workers as dead. updateWorker auto-bumps
        // lastActivityAt; passing {} is the cheapest possible no-op write.
        let keepalive: NodeJS.Timeout | undefined;
        if (state.workers.has(workerId)) {
          keepalive = setInterval(() => {
            state.updateWorker(workerId, {}).catch(() => {
              // Worker may have been deleted concurrently — swallow.
            });
          }, KEEPALIVE_INTERVAL_MS);
          if (keepalive.unref) keepalive.unref();
        }

        const unsubscribe = state.subscribe(async (event) => {
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

          // Cleanup BEFORE the async drain so we never deliver twice if a
          // second message races in while we're reading from disk.
          cleanup();
          logger.info({ workerId, messageId: message.id, sender: message.sender }, 'Chat message received, draining burst');

          // Drain everything since the worker's cursor (or sinceId override)
          // — bursts of step-completions, parallel @mentions, and route-fanout
          // echoes get surfaced in one batch instead of one-per-call.
          let drained: { messages: ChatMessage[]; cursorUpdates: Record<string, string> };
          try {
            drained = await drainUnreadMessages(
              state,
              workerId,
              channelSet,
              params.sinceId,
              relevanceFilter,
              message.id,
            );
          } catch {
            drained = { messages: [], cursorUpdates: {} };
          }

          // Splice the triggering message in. The drain helper excluded it to
          // avoid duplicates from a possible JSONL flush race, so we add it
          // back explicitly here.
          const allMessages = [...drained.messages, message]
            .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
          // Deduplicate defensively in case the drain happened to include it.
          const seen = new Set<string>();
          const finalMessages = allMessages.filter((m) => {
            if (seen.has(m.id)) return false;
            seen.add(m.id);
            return true;
          });

          const cursorUpdates = { ...drained.cursorUpdates };
          // Cursor for the triggering channel must reflect the trigger if it's
          // the newest message in that channel.
          const channelTail = finalMessages.filter((m) => m.channel === message.channel);
          if (channelTail.length > 0) {
            cursorUpdates[message.channel] = channelTail[channelTail.length - 1].id;
          }
          if (Object.keys(cursorUpdates).length > 0) {
            try {
              await state.updateWorkerCursors(workerId, cursorUpdates);
            } catch { /* never block tool */ }
          }

          const messages = truncateChatMessages(finalMessages, maxContentChars);
          const truncated = countTruncatedMessages(messages);
          resolve({
            hasMessage: true,
            messages,
            truncated,
            source: drained.messages.length > 0 ? 'burst' : 'single',
            ...(truncated > 0
              ? { hint: 'Long chat messages are truncated by default. Use moe.chat_read with maxContentChars: 0 for full content.' }
              : {})
          });
        });

        activeChatWaiters.set(workerId, { resolve, unsubscribe, timer, keepalive, channels: channelSet });
      });
    }
  };
}
