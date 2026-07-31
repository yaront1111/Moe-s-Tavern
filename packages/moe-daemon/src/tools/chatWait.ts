import type { ToolDefinition } from './index.js';
import type { StateManager } from '../state/StateManager.js';
import type { ChatMessage } from '../types/schema.js';
import { invalidInput, missingRequired } from '../util/errors.js';
import { logger } from '../util/logger.js';
import { DEFAULT_CHAT_CONTENT_CHARS, MAX_CHAT_CONTENT_CHARS } from '../util/chatPayload.js';
import {
  applyChatDelivery,
  chatBurstResponse,
  collectChatBacklog,
  summarizeChatBurst,
  type ChatBurst,
} from '../util/chatBacklog.js';

// The burst drain itself lives in util/chatBacklog.ts; re-exported here because
// it is part of this tool's documented surface (docs/MCP_SERVER.md).
export {
  collectChatBacklog,
  summarizeChatBurst,
  MAX_BURST_MESSAGES,
  PER_CHANNEL_SCAN_LIMIT,
  type ChatBurst,
} from '../util/chatBacklog.js';

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

interface ChatWaitContext {
  state: StateManager;
  workerId: string;
  channelSet: Set<string> | null;
  sinceId?: string;
  timeoutMs: number;
  maxContentChars: number;
}

/**
 * One long-poll. The ordering here is the correctness core: the subscription is
 * installed SYNCHRONOUSLY before any await, then the backlog is drained, then
 * whatever the subscription buffered meanwhile is merged in. Draining first
 * would drop every message that landed during the drain.
 */
class ChatWaitSession {
  /** Session is over: nothing may resolve again or advance a cursor. */
  private finished = false;
  /** A delivery path owns the outcome; further events only add to the buffer. */
  private claimed = false;
  private entryDrainDone = false;
  private readonly buffered: ChatMessage[] = [];
  private readonly timer: NodeJS.Timeout;
  private unsubscribe: () => void = () => { /* replaced in start() */ };

  constructor(
    private readonly ctx: ChatWaitContext,
    private readonly resolve: (value: unknown) => void
  ) {
    this.timer = setTimeout(() => this.onTimeout(), ctx.timeoutMs);
    if (this.timer.unref) this.timer.unref();
  }

  start(): void {
    this.unsubscribe = this.ctx.state.subscribe((event) => this.onEvent(event));
    activeChatWaiters.set(this.ctx.workerId, {
      // Wrapped so an EXTERNAL resolve (waiter cancellation, disconnect cleanup,
      // stale sweep) finishes the session — otherwise an in-flight drain would
      // keep going and advance cursors for messages nobody received.
      resolve: (value: unknown) => { this.finished = true; this.resolve(value); },
      unsubscribe: () => this.unsubscribe(),
      timer: this.timer,
      channels: this.ctx.channelSet
    });
    void this.drainOnEntry();
  }

  private cleanup(): void {
    clearTimeout(this.timer);
    this.unsubscribe();
    // Only drop OUR registry entry: a cancelled session must not evict the
    // replacement waiter that took its place.
    if (activeChatWaiters.get(this.ctx.workerId)?.timer === this.timer) {
      activeChatWaiters.delete(this.ctx.workerId);
    }
  }

  private onTimeout(): void {
    // Fires even with a delivery in flight: a bounded response beats parking a
    // blocking slot, and `finished` stops that delivery from advancing cursors
    // for messages the caller never got (they stay unread for the next call).
    if (this.finished) return;
    this.finished = true;
    this.cleanup();
    logger.info({ workerId: this.ctx.workerId }, 'Chat wait timed out');
    void this.ctx.state.touchWorker(this.ctx.workerId)
      .catch((error) => logger.warn({ workerId: this.ctx.workerId, error }, 'Failed to refresh worker heartbeat on chat_wait timeout'))
      .finally(() => this.resolve({ hasMessage: false, timedOut: true }));
  }

  /** Take ownership of the outcome, stop listening, then deliver. */
  private async settle(burst: ChatBurst): Promise<void> {
    if (this.finished) return;
    this.finished = true;
    this.cleanup();
    await this.deliver(burst);
  }

  /** Deliver a burst: bookkeeping first, then resolve. Never throws. */
  private async deliver(burst: ChatBurst): Promise<void> {
    try {
      await applyChatDelivery(this.ctx.state, this.ctx.workerId, burst);
      this.resolve(chatBurstResponse(burst, this.ctx.maxContentChars));
    } catch (error) {
      // A blocking tool that never resolves parks the caller for the full
      // timeout and holds a blocking slot — always resolve with something.
      logger.warn({ workerId: this.ctx.workerId, error }, 'chat_wait delivery bookkeeping failed; returning raw messages');
      this.resolve({ hasMessage: true, messages: burst.messages, truncated: 0 });
    }
  }

  private isRelevant(event: { type: string; payload?: unknown; routingTargets?: string[] }): boolean {
    const message = event.payload as ChatMessage;
    if (this.ctx.channelSet) {
      // Caller subscribed to specific channels — the subscription set IS the
      // filter. Any message in those channels is relevant (this matches the
      // governor's "watch #governors for any signal" expectation in
      // docs/roles/governor.md). Don't wake on the worker's OWN posts, though —
      // that returns prematurely in a post-then-wait loop.
      return this.ctx.channelSet.has(message.channel) && message.sender !== this.ctx.workerId;
    }
    // No explicit channel filter — fall back to the conservative mention/human
    // filter so workers in broad-scope chat_wait aren't woken on every chatter.
    const targets = event.routingTargets ?? message.mentions ?? [];
    return targets.includes(this.ctx.workerId) || message.sender === 'human';
  }

  private onEvent(event: { type: string; payload?: unknown; routingTargets?: string[] }): void {
    if (event.type === 'CHANNEL_DELETED') {
      this.onChannelDeleted(event);
      return;
    }
    if (event.type !== 'MESSAGE_CREATED' || this.finished) return;
    if (!this.isRelevant(event)) return;

    const message = event.payload as ChatMessage;
    // Buffer unconditionally: the drain in flight merges the buffer just before
    // it unsubscribes, so a burst landing DURING a drain still ships in one
    // response instead of waiting for the next call.
    this.buffered.push(message);
    // The entry drain merges anything buffered before it finishes.
    if (!this.entryDrainDone || this.claimed) return;

    this.claimed = true;
    logger.info(
      { workerId: this.ctx.workerId, messageId: message.id, sender: message.sender },
      'Chat message received, waking worker'
    );
    // Detached: this callback runs inside state.emit(), which may be inside a
    // tool handler holding the global mutex. Without exiting that async context
    // updateWorkerCursors would short-circuit as reentrant and write unlocked.
    this.ctx.state.detachFromMutexContext(() => { void this.wake(message); });
  }

  private onChannelDeleted(event: { payload?: unknown }): void {
    const deletedChannelId = (event.payload as { id?: string } | undefined)?.id;
    if (!deletedChannelId || !this.ctx.channelSet?.has(deletedChannelId)) return;
    if (this.finished) return;
    this.finished = true;
    this.cleanup();
    logger.info(
      { workerId: this.ctx.workerId, channel: deletedChannelId },
      'Chat wait aborted: subscribed channel was deleted'
    );
    this.resolve({
      hasMessage: false,
      cancelled: true,
      error: `Channel ${deletedChannelId} was deleted while waiting`
    });
  }

  /** Wake path: drain the whole burst, not just the message that woke us. */
  private async wake(trigger: ChatMessage): Promise<void> {
    try {
      // Cursors have not advanced yet, so the trigger is normally re-read here;
      // appending it is the safety net for the case where MESSAGE_CREATED is
      // emitted before the JSONL append is visible to a re-read.
      const drained = await collectChatBacklog(this.ctx.state, this.ctx.workerId, this.ctx.channelSet, this.ctx.sinceId);
      const burst = summarizeChatBurst(
        drained.messages,
        [...this.buffered, trigger],
        { partialChannels: drained.partialChannels, scannedChannels: drained.scannedChannels }
      );
      await this.settle(burst);
    } catch (error) {
      logger.warn({ workerId: this.ctx.workerId, error }, 'chat_wait burst drain failed; returning trigger message only');
      // Nothing scanned: deliver the trigger without moving any cursor, so a
      // failed drain can never skip the backlog behind it.
      await this.settle(summarizeChatBurst([], [trigger], {
        partialChannels: new Set(),
        scannedChannels: new Set(),
      }));
    }
  }

  /** Entry path: return any backlog immediately instead of blocking on it. */
  private async drainOnEntry(): Promise<void> {
    let drained: ChatBurst | null = null;
    try {
      drained = await collectChatBacklog(this.ctx.state, this.ctx.workerId, this.ctx.channelSet, this.ctx.sinceId);
    } catch (error) {
      // Fall through to blocking rather than failing the tool.
      logger.warn({ workerId: this.ctx.workerId, error }, 'chat_wait entry drain failed; blocking for new messages');
    }
    if (this.finished) return;
    this.entryDrainDone = true;

    const scanned = drained?.messages ?? [];
    if (scanned.length === 0 && this.buffered.length === 0) return; // nothing waiting — block as before

    this.claimed = true;
    // Recompute from the FINAL delivered list so cursors reflect the merge —
    // and keep the buffered messages tagged as off-bus so they cannot advance a
    // cursor past the part of their channel the scan never reached.
    const burst = summarizeChatBurst(scanned, this.buffered, {
      partialChannels: drained?.partialChannels ?? new Set(),
      scannedChannels: drained?.scannedChannels ?? new Set(),
    });
    logger.info(
      { workerId: this.ctx.workerId, count: burst.messages.length, hasMore: burst.hasMore },
      'chat_wait returning backlog (messages arrived before wait — avoided lost wakeup)'
    );
    await this.settle(burst);
  }
}

interface ChatWaitParams {
  workerId?: string;
  channels?: string[];
  sinceId?: string;
  timeoutMs?: number;
  maxContentChars?: number;
}

function validateChatWaitParams(params: ChatWaitParams, state: StateManager): void {
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
  if (params.sinceId !== undefined && (typeof params.sinceId !== 'string' || !params.sinceId)) {
    throw invalidInput('sinceId', 'must be a non-empty string');
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
}

export function chatWaitTool(_state: StateManager): ToolDefinition {
  return {
    name: 'moe.chat_wait',
    blocking: true,
    description: 'Long-poll for chat messages mentioning this worker or from humans. Returns any unread backlog immediately, otherwise blocks until a message arrives or timeout.',
    inputSchema: {
      type: 'object',
      properties: {
        workerId: { type: 'string', description: 'Your worker ID (messages mentioning you will trigger)' },
        channels: { type: 'array', items: { type: 'string' }, description: 'Optional channel filter' },
        sinceId: { type: 'string', description: 'Explicit catch-up cursor: overrides the stored per-channel cursor' },
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
      const params = (args || {}) as ChatWaitParams;
      validateChatWaitParams(params, state);

      const workerId = params.workerId as string;

      // Cancel any existing chat waiter for this worker
      const existing = activeChatWaiters.get(workerId);
      if (existing) {
        clearTimeout(existing.timer);
        existing.unsubscribe();
        existing.resolve({ hasMessage: false, cancelled: true });
        activeChatWaiters.delete(workerId);
      }

      const timeoutMs = Math.min(
        Math.max(params.timeoutMs || DEFAULT_TIMEOUT_MS, 1000),
        MAX_TIMEOUT_MS
      );
      const maxContentChars = params.maxContentChars !== undefined
        ? Math.min(Math.floor(params.maxContentChars), MAX_CHAT_CONTENT_CHARS)
        : DEFAULT_CHAT_CONTENT_CHARS;

      // Blocking calls must refresh the heartbeat on entry — otherwise a worker
      // legitimately parked here (up to 10 min) reports isAlive=false past the
      // 120s presence window despite being actively blocked in a moe call.
      // Mirrors moe.wait_for_task, the other blocking tool. Fire-and-forget:
      // must not delay the subscription below (any await before subscribing
      // opens a lost-wakeup window).
      void state.touchWorker(workerId)
        .catch((error) => logger.warn({ workerId, error }, 'Failed to refresh worker heartbeat on chat_wait entry'));

      logger.info({ workerId, channels: params.channels, sinceId: params.sinceId, timeoutMs }, 'Worker waiting for chat message');

      return new Promise<unknown>((resolve) => {
        new ChatWaitSession({
          state,
          workerId,
          channelSet: params.channels ? new Set(params.channels) : null,
          sinceId: params.sinceId,
          timeoutMs,
          maxContentChars
        }, resolve).start();
      });
    }
  };
}
