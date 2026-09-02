// =============================================================================
// MentionRouter - @mention routing with per-channel loop guards
// Ported from agentchattr's router.py
// =============================================================================

import type { ChatMessage, Worker, Team } from '../types/schema.js';

export interface RoutingResult {
  targets: string[];   // workerIds to notify
  paused: boolean;     // whether the channel is paused by loop guard
  hopCount: number;    // current hop count for the channel
}

/** Group tokens address many seats at once, so they are position-sensitive. */
const GROUP_TOKENS = new Set(['all', 'architects', 'architect', 'workers', 'worker', 'qa', 'governors', 'governor']);

export function isGroupToken(token: string): boolean {
  return GROUP_TOKENS.has(token.toLowerCase());
}

/**
 * True when this offset sits in the ADDRESSING PREFIX of its line: everything
 * before it on the line is whitespace or other @mentions.
 *
 * Not merely "opens the line" — real address lines stack recipients
 * ("@qa @architects here is the thing"), and only the first would qualify under
 * a strict start-of-line rule. Prose before the token ("and no @all, per your
 * ruling") disqualifies it, which is the case this exists to stop.
 *
 * A markdown quote marker ('>') is NOT skipped, and that is the point: quoting a
 * broadcast in order to DISCUSS it must not re-fire it, which is the same re-arm
 * shape this guard exists to stop. Citing a message is the normal way to talk
 * about one, and `replyTo` already exists for genuine threading, so nothing
 * legitimate needs a group token to address from behind a quote marker.
 * (worker-17a62b7e measured this against the built bundle: "> @all restart
 * incoming" still routed to every seat.)
 */
export function inAddressingPrefix(text: string, atIndex: number): boolean {
  let i = atIndex - 1;
  for (;;) {
    while (i >= 0 && (text[i] === ' ' || text[i] === '\t')) i--;
    if (i < 0 || text[i] === '\n') return true;
    // Walk back over a preceding @token and keep going; anything else is prose.
    let j = i;
    while (j >= 0 && /[\w-]/.test(text[j])) j--;
    if (j >= 0 && text[j] === '@' && j < i) { i = j - 1; continue; }
    return false;
  }
}

/**
 * Blank out fenced code blocks and inline code spans. Mentions inside them are
 * QUOTED, not addressed — see parseMentions for why this matters.
 */
export function stripQuotedSpans(content: string): string {
  return content
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ');
}

/** The one mention pattern. chatStore imports this rather than re-declaring it. */
export function parseRawMentions(content: string): string[] {
  if (!content) return [];
  const mentionRegex = /(?<![\w@])@(\w[\w-]*)/g;
  const out: string[] = [];
  let m: RegExpExecArray | null;
  const quoteless = stripQuotedSpans(content);
  while ((m = mentionRegex.exec(quoteless)) !== null) {
    if (!out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

export class MentionRouter {
  private hopCounts = new Map<string, number>();
  private pausedChannels = new Set<string>();
  private readonly maxHops: number;

  constructor(maxHops = 4) {
    this.maxHops = maxHops;
  }

  /**
   * Parse @mentions from message content, matching against known worker IDs.
   * Supports group mentions: @all, @architects, @workers, @qa, @governors
   */
  parseMentions(content: string, knownWorkerIds: string[], workers?: Worker[], teams?: Team[]): string[] {
    if (!content) return [];

    // Mentions inside code spans/blocks are QUOTED, not addressed. Without this
    // you cannot discuss a group token without invoking it: a governor writing
    // "stop using `@all`" broadcast to every seat and obliged all of them to
    // reply — the message announcing the loop became another turn of it
    // (observed 2026-09-02, msg-642f7e788e9e parsed mentions ['worker-...','all']
    // from prose that only ever quoted the token). Strip fenced blocks first,
    // then inline spans, so the offsets of what remains stay independent.
    const quoteless = stripQuotedSpans(content);

    // Match @<id> only when the @ is not preceded by another @ or a word char.
    // This prevents emails (yaron@worker-alice.com) and "@@" injections from
    // being parsed as mentions, while still allowing punctuation/whitespace prefixes.
    const mentionRegex = /(?<![\w@])@(\w[\w-]*)/g;
    const rawMentions: string[] = [];
    let match: RegExpExecArray | null;
    while ((match = mentionRegex.exec(quoteless)) !== null) {
      // A GROUP token only ADDRESSES when it opens the message or a line.
      // Anywhere else it is discussion, and discussion must not broadcast.
      //
      // Quoting alone was not enough. Measured 2026-09-02: a worker wrote
      // "and no @all, per your ruling" — declaring it was NOT broadcasting —
      // and chat_send routed to fifteen seats. Every attempt to close the
      // thread re-armed it, because the topic could not be named without
      // being invoked. Individual @worker-ids are unrestricted: naming one
      // seat mid-sentence is normal and cheap; waking every seat is not.
      if (isGroupToken(match[1]) && !inAddressingPrefix(quoteless, match.index)) continue;
      rawMentions.push(match[1]);
    }

    if (rawMentions.length === 0) return [];

    // Build a map of workerId → team role for group mention resolution
    const workerRoleMap = new Map<string, string>();
    if (workers && teams && teams.length > 0) {
      const teamMap = new Map<string, Team>();
      for (const t of teams) teamMap.set(t.id, t);
      for (const w of workers) {
        if (w.teamId) {
          const team = teamMap.get(w.teamId);
          if (team?.role) workerRoleMap.set(w.id, team.role);
        }
      }
    }

    const result = new Set<string>();

    for (const mention of rawMentions) {
      const lower = mention.toLowerCase();

      if (lower === 'all') {
        // @all → all known workers
        for (const id of knownWorkerIds) result.add(id);
      } else if (
        lower === 'architects' ||
        lower === 'workers' ||
        lower === 'qa' ||
        lower === 'governor' ||
        lower === 'governors'
      ) {
        // Map group mention to team role. 'qa' is its own thing (no plural form
        // in the schema); 'governor' / 'governors' both resolve to the governor
        // role so users can write either.
        const targetRole =
          lower === 'architects'
            ? 'architect'
            : lower === 'workers'
              ? 'worker'
              : lower === 'qa'
                ? 'qa'
                : 'governor';

        // Primary: resolve by team.role lookup
        let matched = false;
        for (const [workerId, role] of workerRoleMap) {
          if (role === targetRole) {
            result.add(workerId);
            matched = true;
          }
        }

        // Fallback: if no teams exist, match by ID substring (backwards compat)
        if (!matched) {
          const searchTerm = targetRole; // 'architect', 'worker', 'qa', or 'governor'
          for (const id of knownWorkerIds) {
            if (id.toLowerCase().includes(searchTerm)) result.add(id);
          }
        }
      } else if (knownWorkerIds.includes(lower)) {
        // Direct worker ID mention (worker IDs are stored lowercase, so
        // match against the lower-cased candidate).
        result.add(lower);
      }
    }

    return Array.from(result);
  }

  /**
   * Route a message — determines which workers should be notified.
   * Messages are always stored regardless of routing result.
   */
  route(message: ChatMessage, allWorkers: Worker[], teams?: Team[]): RoutingResult {
    const knownWorkerIds = allWorkers.map((w) => w.id);
    const isHuman = message.sender === 'human' || message.sender === 'system' ||
      !knownWorkerIds.includes(message.sender);

    if (isHuman) {
      return this.routeHumanMessage(message, allWorkers, knownWorkerIds, teams);
    }

    return this.routeAgentMessage(message, allWorkers, knownWorkerIds, teams);
  }

  private routeHumanMessage(
    message: ChatMessage,
    allWorkers: Worker[],
    knownWorkerIds: string[],
    teams?: Team[]
  ): RoutingResult {
    const channel = message.channel;

    // Human messages always reset hop counter
    this.hopCounts.set(channel, 0);
    this.pausedChannels.delete(channel);

    // @continue also clears paused (already done above, but explicit for clarity)
    if (message.content.toLowerCase().includes('@continue')) {
      this.pausedChannels.delete(channel);
    }

    const mentions = this.parseMentions(message.content, knownWorkerIds, allWorkers, teams);

    if (mentions.length === 0) {
      // No explicit mentions from human → notify all online workers. Skip IDLE
      // (between tasks) and DEAD (deregistered/timed-out, pending prune).
      const onlineWorkers = allWorkers
        .filter((w) => w.status !== 'IDLE' && w.status !== 'DEAD')
        .map((w) => w.id);
      return { targets: onlineWorkers, paused: false, hopCount: 0 };
    }

    return { targets: mentions, paused: false, hopCount: 0 };
  }

  private routeAgentMessage(
    message: ChatMessage,
    allWorkers: Worker[],
    knownWorkerIds: string[],
    teams?: Team[]
  ): RoutingResult {
    const channel = message.channel;
    const hopCount = this.hopCounts.get(channel) ?? 0;

    // If channel is paused, store message but don't route
    if (this.pausedChannels.has(channel)) {
      return { targets: [], paused: true, hopCount };
    }

    const mentions = this.parseMentions(message.content, knownWorkerIds, allWorkers, teams);

    // Filter out self-routing (agent can't trigger itself). Do this BEFORE the
    // hop counter / loop guard: a pure self-mention routes to nobody, so it must
    // not advance the hop counter or pause the channel.
    const targets = mentions.filter((id) => id !== message.sender);

    // Agents must explicitly @mention someone other than themselves to route —
    // no routable targets means no routing and no hop advance.
    if (targets.length === 0) {
      return { targets: [], paused: false, hopCount };
    }

    // Increment hop counter
    const newHopCount = hopCount + 1;
    this.hopCounts.set(channel, newHopCount);

    // Check loop guard
    if (newHopCount > this.maxHops) {
      this.pausedChannels.add(channel);
      return { targets: [], paused: true, hopCount: newHopCount };
    }

    return { targets, paused: false, hopCount: newHopCount };
  }

  /**
   * Reset channel state (for testing or manual reset via @continue).
   */
  resetChannel(channelId: string): void {
    this.hopCounts.delete(channelId);
    this.pausedChannels.delete(channelId);
  }

  /**
   * Get channel state for debugging/testing.
   */
  getChannelState(channelId: string): { hopCount: number; paused: boolean } {
    return {
      hopCount: this.hopCounts.get(channelId) ?? 0,
      paused: this.pausedChannels.has(channelId)
    };
  }
}
