/**
 * Burst drain for chat long-polls: read every watched channel from the caller's
 * cursor forward, order and cap the result, and derive exactly the cursor /
 * unread bookkeeping that delivery justifies. Pure of any waiter machinery so
 * both the entry and wake paths of moe.chat_wait can share it.
 */
import type { StateManager } from '../state/StateManager.js';
import type { ChatMessage } from '../types/schema.js';
import { logger } from './logger.js';
import {
  DEFAULT_CHAT_CONTENT_CHARS,
  capChatMessagesToResponseBudget,
  countTruncatedMessages,
  truncateChatMessages,
} from './chatPayload.js';

/** Messages scanned per channel in one drain. */
export const PER_CHANNEL_SCAN_LIMIT = 50;
/** Messages returned in one burst response; the rest stay unread for the next call. */
export const MAX_BURST_MESSAGES = 100;

const TRUNCATION_HINT =
  'Long chat messages are truncated by default. Use moe.chat_read with maxContentChars: 0 for full content.';

/** A drained burst plus the delivery bookkeeping it justifies. */
export interface ChatBurst {
  messages: ChatMessage[];
  /** channelId -> id of the LAST message actually being delivered for it. */
  cursorUpdates: Record<string, string>;
  /** Channels with nothing left behind — safe to clear unread for. */
  fullyDrained: string[];
  /** True when the caps trimmed the burst, so another call has work to do. */
  hasMore: boolean;
  /** Channels that still hold messages this burst did not deliver. */
  partialChannels: Set<string>;
  /** Channels this drain actually read — the only ones a cursor may advance in. */
  scannedChannels: Set<string>;
}

/** What a drain read, for deciding which cursors may move. */
export interface BurstScope {
  /** Scanned channels that may still hold messages this drain did not reach. */
  partialChannels: Set<string>;
  /** Channels the drain actually read. */
  scannedChannels: Set<string>;
}

/**
 * Order, de-duplicate and cap a message pile, then derive the cursor / unread
 * bookkeeping it justifies.
 *
 * `scanned` came from reading the channel; `offBus` arrived as MESSAGE_CREATED
 * events (the wake trigger and anything buffered during the drain). Both are
 * DELIVERED, but only a scanned message may move its channel's cursor: an
 * off-bus message is the newest by timestamp and says nothing about the
 * messages between it and where the scan stopped. Advancing to it would strand
 * everything the scan never reached (a channel with more than
 * PER_CHANNEL_SCAN_LIMIT waiting) — so it is re-delivered on the next call
 * instead, which is the right trade: a duplicate beats a lost message.
 *
 * Cursors are also computed from the DELIVERED slice only, so the burst cap can
 * never advance past a message the caller never saw, and never for a channel
 * outside `scannedChannels`.
 */
export function summarizeChatBurst(
  scanned: ChatMessage[],
  offBus: ChatMessage[],
  scope: BurstScope,
  maxContentChars: number = DEFAULT_CHAT_CONTENT_CHARS
): ChatBurst {
  const { partialChannels, scannedChannels } = scope;
  const scannedIds = new Set(scanned.map((message) => message.id));
  const seen = new Set<string>();
  const deduped: ChatMessage[] = [];
  // Scanned first so a message that is BOTH re-read and buffered keeps its
  // file-order position and counts as scan-sourced.
  for (const message of [...scanned, ...offBus]) {
    if (seen.has(message.id)) continue;
    seen.add(message.id);
    deduped.push(message);
  }
  // Sort on timestamp ONLY, relying on Array#sort being stable. Message ids are
  // random UUIDs (util/ids.ts), so an id tiebreaker would reorder same-
  // millisecond messages within a channel — and the per-channel cursor below
  // would then point past messages that were never delivered.
  deduped.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  // Keep the OLDEST slice, matching getMessages' forward-paging semantics: each
  // call advances the cursor, so repeated calls walk the backlog in order.
  //
  // TWO ceilings, and the size one has to be applied HERE rather than when the
  // response is shaped: cursorUpdates below are derived from `messages`, so
  // trimming later would advance a cursor past a message the caller never
  // received. The count cap alone did not bound the payload — 100 messages of
  // governance prose overflowed the client's limit, the whole response was
  // rejected, and the caller re-read the same window on every retry.
  const counted = deduped.slice(0, MAX_BURST_MESSAGES);
  const countDropped = deduped.slice(MAX_BURST_MESSAGES);
  const capped = capChatMessagesToResponseBudget(counted, maxContentChars);
  const messages = capped.delivered;
  const dropped = [...capped.dropped, ...countDropped];

  const incomplete = new Set(partialChannels);
  for (const message of dropped) incomplete.add(message.channel);

  const cursorUpdates: Record<string, string> = {};
  for (const message of messages) {
    if (!scannedChannels.has(message.channel)) continue;
    if (!scannedIds.has(message.id)) continue;
    cursorUpdates[message.channel] = message.id;
  }
  const fullyDrained = Object.keys(cursorUpdates).filter((channelId) => !incomplete.has(channelId));

  return {
    messages,
    cursorUpdates,
    fullyDrained,
    hasMore: dropped.length > 0 || partialChannels.size > 0,
    partialChannels: incomplete,
    scannedChannels
  };
}

/** Channels a drain should scan, given the caller's filter and catch-up cursor. */
function backlogChannelIds(
  state: StateManager,
  workerId: string,
  channelSet: Set<string> | null,
  explicitSinceId?: string
): string[] {
  if (channelSet) return Array.from(channelSet);
  // An explicit catch-up must not be gated on unread bookkeeping that a
  // reconnect (or a prior chat_read) already cleared.
  if (explicitSinceId) return state.getChannels().map((channel) => channel.id);
  const unread = state.getUnreadSummary(workerId);
  return unread ? Object.keys(unread.channels) : [];
}

/**
 * Scan every watched channel from the caller's cursor forward.
 *
 * No mention/human relevance filter is applied: the unread-summary path is
 * already routed, the channelSet path is deliberately "any message in my
 * channels", and an explicit sinceId means "give me everything since X"
 * (stored messages carry RAW mention tokens, so filtering here would drop the
 * group pings a governor is catching up on).
 */
export async function collectChatBacklog(
  state: StateManager,
  workerId: string,
  channelSet: Set<string> | null,
  explicitSinceId?: string,
  maxContentChars: number = DEFAULT_CHAT_CONTENT_CHARS
): Promise<ChatBurst> {
  const channelIds = backlogChannelIds(state, workerId, channelSet, explicitSinceId);
  if (channelIds.length === 0) {
      return summarizeChatBurst([], [], { partialChannels: new Set(), scannedChannels: new Set() }, maxContentChars);
  }

  const worker = state.getWorker(workerId);
  const raw: ChatMessage[] = [];
  const partialChannels = new Set<string>();
  const scannedChannels = new Set<string>();

  for (const channelId of channelIds) {
    const sinceId = explicitSinceId ?? worker?.chatCursors?.[channelId];
    try {
      const messages = await state.getMessages(channelId, { sinceId, limit: PER_CHANNEL_SCAN_LIMIT });
      scannedChannels.add(channelId);
      // A full page means the channel may hold more than this scan returned.
      if (messages.length >= PER_CHANNEL_SCAN_LIMIT) partialChannels.add(channelId);
      for (const message of messages) {
        if (message.sender !== workerId) raw.push(message);
      }
    } catch (error) {
      // One unreadable channel must not fail the whole tool.
      logger.warn({ workerId, channelId, error }, 'chat_wait skipped an unreadable channel while draining');
    }
  }

  return summarizeChatBurst(raw, [], { partialChannels, scannedChannels }, maxContentChars);
}

/** Advance cursors / clear unread for messages actually being delivered. */
export async function applyChatDelivery(
  state: StateManager,
  workerId: string,
  burst: ChatBurst
): Promise<void> {
  if (Object.keys(burst.cursorUpdates).length > 0) {
    try {
      await state.updateWorkerCursors(workerId, burst.cursorUpdates);
    } catch (error) {
      // A duplicate delivery on a failed cursor write beats a lost one.
      logger.warn({ workerId, error }, 'chat_wait failed to advance chat cursors; messages still delivered');
    }
  }
  for (const channelId of burst.fullyDrained) {
    try {
      state.clearUnread(workerId, channelId);
    } catch (error) {
      logger.warn({ workerId, channelId, error }, 'chat_wait failed to clear unread; messages still delivered');
    }
  }
}

/** Shape a burst into the chat_wait success payload. */
export function chatBurstResponse(burst: ChatBurst, maxContentChars: number): unknown {
  const messages = truncateChatMessages(burst.messages, maxContentChars);
  const truncated = countTruncatedMessages(messages);
  return {
    hasMessage: true,
    messages,
    truncated,
    ...(burst.hasMore ? { hasMore: true } : {}),
    ...(truncated > 0 ? { hint: TRUNCATION_HINT } : {})
  };
}
