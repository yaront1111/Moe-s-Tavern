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
/**
 * Full pages of skipped lines one drain reads past in a filtered channel to
 * reach a routed line. Each page re-reads up to 1 MB of the channel's tail.
 */
export const MAX_SKIP_PAGES = 10;

const TRUNCATION_HINT =
  'Long chat messages are truncated by default. Use moe.chat_read with maxContentChars: 0 for full content.';

/**
 * moe.chat_wait's one relevance rule, shared by the live wake and the drains.
 * With a channel filter: a watched channel's line, or one routed to the caller.
 * With none: a routed line, or any human line.
 */
export function chatWaitAdmits(channelSet: Set<string> | null, message: ChatMessage, routedToCaller: boolean): boolean {
  if (channelSet) return channelSet.has(message.channel) || routedToCaller;
  return routedToCaller || message.sender === 'human';
}

/**
 * Whether a STORED line was routed to the caller. A stored line keeps raw
 * mentions, never routingTargets, so this rebuilds the router's decision with
 * its own parser (code spans stripped, group tokens only in the addressing
 * prefix, groups resolved by team role), never the raw tokens, and never
 * route(), which moves hop counts and pauses. A line naming seats is routed
 * when it names the caller; one naming none when 'system' or 'human' sent it,
 * as the router broadcasts those to busy seats. An agent line naming nobody
 * routes nowhere, and an unknown (departed) sender does not pass as human.
 *
 * It errs only toward delivering. These count as routed although the live
 * wake may not have been: a line in a loop-guarded (paused) channel, a line
 * sent while the caller was idle, and a parseMentions:false daemon echo
 * (releaseTask's #workers copy), which is stored as a mention-less system line.
 */
function routedToCaller(state: StateManager, workerId: string): (message: ChatMessage) => boolean {
  const workers = Array.from(state.workers.values());
  const teams = Array.from(state.teams.values());
  const ids = workers.map((worker) => worker.id);
  return (message) => {
    if ((message.mentions ?? []).length > 0) {
      const named = state.mentionRouter.parseMentions(message.content, ids, workers, teams);
      if (named.length > 0) return named.includes(workerId);
    }
    return message.sender === 'system' || message.sender === 'human';
  };
}

/** Where a drain's skipped lines let a cursor move. */
export interface SkipCursors {
  /** Deliverable id -> the last skipped id after it, before its channel's next deliverable line. */
  skipAfter?: Map<string, string>;
  /** channelId -> the last skipped id before its first deliverable line (or its last one when none is). */
  skipLead?: Map<string, string>;
}

/** A drained burst plus the delivery bookkeeping it justifies. */
export interface ChatBurst extends SkipCursors {
  messages: ChatMessage[];
  /** channelId -> id of the last line delivered for it, or of a skipped line read after it. */
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
export interface BurstScope extends SkipCursors {
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
 * outside `scannedChannels`. Skipped lines the scan read move a cursor too
 * (`scope.skipAfter`/`skipLead`), never past a deliverable line: a channel's
 * delivered scanned lines are always a prefix of its deliverable ones.
 */
export function summarizeChatBurst(
  scanned: ChatMessage[],
  offBus: ChatMessage[],
  scope: BurstScope,
  maxContentChars: number = DEFAULT_CHAT_CONTENT_CHARS
): ChatBurst {
  const { partialChannels, scannedChannels, skipAfter, skipLead } = scope;
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

  // A dropped off-bus line may be one the scan skipped (the live wake judged it
  // from routingTargets), so its channel's cursor must not ride a skip run.
  const noSkip = new Set(dropped.filter((message) => !scannedIds.has(message.id)).map((message) => message.channel));
  const cursorUpdates: Record<string, string> = {};
  for (const message of messages) {
    if (!scannedChannels.has(message.channel)) continue;
    if (!scannedIds.has(message.id)) continue;
    const skip = noSkip.has(message.channel) ? undefined : skipAfter?.get(message.id);
    cursorUpdates[message.channel] = skip ?? message.id;
  }
  for (const [channelId, skipId] of skipLead ?? []) {
    if (scannedChannels.has(channelId) && !noSkip.has(channelId) && !(channelId in cursorUpdates)) {
      cursorUpdates[channelId] = skipId;
    }
  }
  const fullyDrained = Object.keys(cursorUpdates).filter((channelId) => !incomplete.has(channelId));

  return {
    messages,
    cursorUpdates,
    fullyDrained,
    hasMore: dropped.length > 0 || partialChannels.size > 0,
    partialChannels: incomplete,
    scannedChannels,
    skipAfter,
    skipLead
  };
}

/** Channels a drain should scan, given the caller's filter and catch-up cursor. */
function backlogChannelIds(
  state: StateManager,
  workerId: string,
  channelSet: Set<string> | null,
  explicitSinceId?: string
): string[] {
  if (channelSet) {
    // A channel filter selects ambient traffic, not where someone may address
    // the worker: an unread channel holds a line routed to it. Outside the
    // filter the drain delivers only routed lines (chatWaitAdmits).
    const unread = state.getUnreadSummary(workerId);
    return [...new Set([...channelSet, ...Object.keys(unread?.channels ?? {})])];
  }
  // An explicit catch-up must not be gated on unread bookkeeping that a
  // reconnect (or a prior chat_read) already cleared.
  if (explicitSinceId) return state.getChannels().map((channel) => channel.id);
  const unread = state.getUnreadSummary(workerId);
  return unread ? Object.keys(unread.channels) : [];
}

interface DrainContext {
  state: StateManager;
  workerId: string;
  /** The caller's registration time: the floor of a channel it has no position in. */
  startedAt?: string;
  channelSet: Set<string> | null;
  /** chatWaitAdmits over the stored-line routing rule. */
  admits: (message: ChatMessage) => boolean;
}

interface ChannelScan {
  deliver: ChatMessage[];
  /** Same shape as SkipCursors.skipAfter, for this channel only. */
  skipAfter: Map<string, string>;
  skipLeadId?: string;
  /** The last page read was full, so the channel may hold more. */
  partial: boolean;
}

/**
 * Read one channel forward from `sinceId`. A filtered channel (outside the
 * caller's filter, or any channel with none) whose full page held nothing
 * deliverable reads on, up to MAX_SKIP_PAGES, so a routed line behind a long
 * run of other seats' chatter still arrives in this call. Throws on a failed
 * read; the caller then records nothing for the channel.
 */
async function scanChannel(ctx: DrainContext, channelId: string, sinceId: string | undefined): Promise<ChannelScan> {
  const scan: ChannelScan = { deliver: [], skipAfter: new Map(), partial: false };
  const filtered = !ctx.channelSet?.has(channelId);
  let pendingSkip: string | undefined;
  let from = sinceId;
  for (let pages = 1; ; pages++) {
    const page = await ctx.state.getMessages(channelId, { sinceId: from, limit: PER_CHANNEL_SCAN_LIMIT, hideSystemFeed: true });
    // With no position in a channel, getMessages falls back to its newest
    // window, which reaches back before this worker existed. Those messages
    // were routed to the workers registered when they were sent, but their
    // raw group tokens (@all, @workers) still match this worker's role, so a
    // freshly registered worker got paged to answer history. Its backlog
    // starts at registration, except for messages that name it directly (a
    // reused worker id) or whose timestamp does not parse.
    const floor = from ? Number.NaN : Date.parse(ctx.startedAt ?? '');
    const messages = Number.isNaN(floor)
      ? page
      : page.filter((message) =>
        !(Date.parse(message.timestamp) < floor) || (message.mentions ?? []).includes(ctx.workerId));
    scan.partial = messages.length >= PER_CHANNEL_SCAN_LIMIT;
    for (const message of messages) {
      // Own posts (like history under the floor) neither deliver nor move a cursor.
      if (message.sender === ctx.workerId) continue;
      if (!ctx.admits(message)) { pendingSkip = message.id; continue; }
      recordSkip(scan, pendingSkip);
      pendingSkip = undefined;
      scan.deliver.push(message);
    }
    if (!filtered || scan.deliver.length > 0 || page.length < PER_CHANNEL_SCAN_LIMIT || pages >= MAX_SKIP_PAGES) break;
    from = page[page.length - 1].id;
  }
  recordSkip(scan, pendingSkip);
  return scan;
}

/** File a run of skipped lines after the last deliverable line, or as the channel's lead. */
function recordSkip(scan: ChannelScan, skipId: string | undefined): void {
  if (skipId === undefined) return;
  const last = scan.deliver[scan.deliver.length - 1];
  if (last) scan.skipAfter.set(last.id, skipId);
  else scan.skipLeadId = skipId;
}

/**
 * Scan every channel the caller may have backlog in, from its cursor forward.
 *
 * The drain applies the live wake's relevance (chatWaitAdmits): a watched
 * channel delivers every line, and a channel outside the filter (or any channel
 * with no filter) delivers only lines routed to the caller, plus human lines
 * when there is no filter. Lines it reads and skips still move that channel's
 * cursor (skipAfter / skipLead), so no later call delivers them.
 */
export async function collectChatBacklog(
  state: StateManager,
  workerId: string,
  channelSet: Set<string> | null,
  explicitSinceId?: string,
  maxContentChars: number = DEFAULT_CHAT_CONTENT_CHARS
): Promise<ChatBurst> {
  const scope = {
    partialChannels: new Set<string>(),
    scannedChannels: new Set<string>(),
    skipAfter: new Map<string, string>(),
    skipLead: new Map<string, string>(),
  };
  const channelIds = backlogChannelIds(state, workerId, channelSet, explicitSinceId);
  if (channelIds.length === 0) return summarizeChatBurst([], [], scope, maxContentChars);

  const worker = state.getWorker(workerId);
  const isRouted = routedToCaller(state, workerId);
  const ctx: DrainContext = {
    state, workerId, startedAt: worker?.startedAt, channelSet,
    admits: (message) => chatWaitAdmits(channelSet, message, isRouted(message)),
  };
  const raw: ChatMessage[] = [];

  for (const channelId of channelIds) {
    // An explicit catch-up id belongs to ONE channel. Applying it to a channel
    // that does not hold it would trip getMessages' expired-cursor fallback and
    // replay that channel's whole window on every call; those channels keep
    // their stored cursor instead.
    const sinceId = explicitSinceId && state.messageExistsInChannel(channelId, explicitSinceId)
      ? explicitSinceId
      : worker?.chatCursors?.[channelId];
    try {
      const scan = await scanChannel(ctx, channelId, sinceId);
      scope.scannedChannels.add(channelId);
      if (scan.partial) scope.partialChannels.add(channelId);
      raw.push(...scan.deliver);
      for (const [id, skipId] of scan.skipAfter) scope.skipAfter.set(id, skipId);
      if (scan.skipLeadId !== undefined) scope.skipLead.set(channelId, scan.skipLeadId);
    } catch (error) {
      // One unreadable channel must not fail the whole tool; its cursor stays put.
      logger.warn({ workerId, channelId, error }, 'chat_wait skipped an unreadable channel while draining');
    }
  }

  return summarizeChatBurst(raw, [], scope, maxContentChars);
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
