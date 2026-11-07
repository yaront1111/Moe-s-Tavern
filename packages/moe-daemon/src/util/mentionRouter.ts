// =============================================================================
// MentionRouter - @mention routing with per-channel loop guards
// Ported from agentchattr's router.py
// =============================================================================

import type { ChatMessage, Worker, Team, ProjectSettings } from '../types/schema.js';

export interface RoutingResult {
  targets: string[];   // workerIds to notify
  paused: boolean;     // whether the channel is paused by loop guard
  hopCount: number;    // agent hops in the channel's window (when paused, the refused one too)
}

/** settings.chatAgentHopWindowMs default (2 min): only agent hops this recent count. */
const DEFAULT_AGENT_HOP_WINDOW_MS = 120_000;

/** A duration for a hint: minutes from 2 min up (to 0.1), else whole seconds (never "0 s"). */
function roughly(ms: number): string {
  return ms >= 120_000 ? `${+(ms / 60_000).toFixed(1)} min` : `${Math.max(1, Math.round(ms / 1000))} s`;
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
  /**
   * Clock readings of each channel's ROUTED agent hops, oldest first. Only the
   * ones inside the last hopWindowMs count, and there are never more than
   * maxHops of them: the hop that would exceed the limit is refused, not stored.
   */
  private hopTimes = new Map<string, number[]>();
  /** Channels where a hop was refused; the pause holds while the window is still full. */
  private pausedChannels = new Set<string>();
  private maxHops: number;
  private hopWindowMs = DEFAULT_AGENT_HOP_WINDOW_MS;
  private readonly now: () => number;

  /** `now` is the clock (epoch ms) the hop window is measured on; tests inject their own. */
  constructor(maxHops = 4, now: () => number = () => Date.now()) {
    this.maxHops = maxHops;
    this.now = now;
  }

  /**
   * Re-apply the configured hop limit without touching hop counts or pauses.
   * StateManager.load() runs on every FileWatcher reload; it used to build a new
   * router there, which cleared every pause with no human message. Anything but
   * an integer >= 1 means the default 4, so a missing or hand-edited setting
   * neither disables the guard nor wedges every channel.
   */
  setMaxHops(maxHops: number | undefined): void {
    this.maxHops = Number.isInteger(maxHops) && (maxHops as number) >= 1 ? (maxHops as number) : 4;
  }

  /**
   * Re-apply the sliding window, keeping recorded hops and pauses. Anything but
   * a positive finite number means the 2-minute default; the setting's bounds
   * (10 s to 24 h) are enforced where project.json is read and updated.
   */
  setHopWindowMs(windowMs: number | undefined): void {
    this.hopWindowMs = Number.isFinite(windowMs) && (windowMs as number) > 0
      ? (windowMs as number)
      : DEFAULT_AGENT_HOP_WINDOW_MS;
  }

  /** The sliding window in force. */
  getHopWindowMs(): number {
    return this.hopWindowMs;
  }

  /** Both loop-guard settings at once; StateManager.load() calls this on every reload. */
  applySettings(settings: Pick<ProjectSettings, 'chatMaxAgentHops' | 'chatAgentHopWindowMs'> | undefined): void {
    this.setMaxHops(settings?.chatMaxAgentHops);
    this.setHopWindowMs(settings?.chatAgentHopWindowMs);
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

    // The daemon's own bookkeeping is NEITHER a human resuming the channel nor
    // an agent taking a hop, so it routes neutrally. It used to take the human
    // path, which clears the hop count and the pause — and on a working
    // channel a checkpoint banner, a "Step N completed", a claim notice or a
    // resource grant lands every minute or so, so the loop guard was being
    // reset faster than agents could reach maxHops and could effectively never
    // fire on exactly the busy channel it exists to protect.
    if (message.sender === 'system') {
      return this.routeSystemMessage(message, allWorkers, knownWorkerIds, teams);
    }

    const isHuman = message.sender === 'human' || !knownWorkerIds.includes(message.sender);

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
    this.hopTimes.delete(channel);
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

  /**
   * System messages: delivered, but with no effect on the loop guard.
   *
   * Targets are chosen exactly as before — explicit mentions if the banner has
   * any, otherwise every non-IDLE, non-DEAD worker — so a stale-worker alert
   * still reaches its seats even while the channel is paused. A pause exists to
   * stop agents answering each other, not to hide the daemon's own warnings.
   * What it must NOT do is record a hop, drop one or lift a pause: only a human
   * (an explicit @continue included) resumes a channel at once; otherwise its
   * hops age out of the window on their own schedule.
   */
  private routeSystemMessage(
    message: ChatMessage,
    allWorkers: Worker[],
    knownWorkerIds: string[],
    teams?: Team[]
  ): RoutingResult {
    const mentions = this.parseMentions(message.content, knownWorkerIds, allWorkers, teams);
    const targets = mentions.length > 0
      ? mentions
      : allWorkers
          .filter((w) => w.status !== 'IDLE' && w.status !== 'DEAD')
          .map((w) => w.id);

    return { targets, ...this.getChannelState(message.channel) };
  }

  private routeAgentMessage(
    message: ChatMessage,
    allWorkers: Worker[],
    knownWorkerIds: string[],
    teams?: Team[]
  ): RoutingResult {
    const channel = message.channel;
    const now = this.now();

    // A sliding window, not a lifetime cap. Only a human post used to reset the
    // count, so in an all-agent fleet #architects and #workers paused for good
    // after about ten coordination mentions spread over hours, and seats parked
    // in chat_wait were never woken by an @mention there again (observed
    // 2026-11-07). Now only the routed hops of the last hopWindowMs count:
    // steady coordination never fills the window, fast ping-pong does, and a
    // pause lifts by itself once the oldest hop in the window ages out.
    const { hops, paused } = this.stateAt(channel, now);
    if (!paused) this.pausedChannels.delete(channel);

    // If channel is paused, store message but don't route. Not a hop either,
    // so a seat that keeps retrying cannot extend the pause.
    if (paused) {
      return { targets: [], paused: true, hopCount: hops.length + 1 };
    }

    const mentions = this.parseMentions(message.content, knownWorkerIds, allWorkers, teams);

    // Filter out self-routing (agent can't trigger itself). Do this BEFORE the
    // hop counter / loop guard: a pure self-mention routes to nobody, so it must
    // not advance the hop counter or pause the channel.
    const targets = mentions.filter((id) => id !== message.sender);

    // Agents must explicitly @mention someone other than themselves to route —
    // no routable targets means no routing and no hop advance.
    if (targets.length === 0) {
      return { targets: [], paused: false, hopCount: hops.length };
    }

    // Check loop guard: the window already holds maxHops routed hops, so this
    // one exceeds it. Refuse it and pause, but do not record it: recorded, it
    // would still fill the window after the oldest hop aged out, so the next
    // post would be refused too and the pause would outlast its hint.
    if (hops.length >= this.maxHops) {
      this.pausedChannels.add(channel);
      return { targets: [], paused: true, hopCount: hops.length + 1 };
    }

    hops.push(now);
    this.hopTimes.set(channel, hops);
    return { targets, paused: false, hopCount: hops.length };
  }

  /**
   * Reset channel state (for testing or manual reset via @continue).
   */
  resetChannel(channelId: string): void {
    this.hopTimes.delete(channelId);
    this.pausedChannels.delete(channelId);
  }

  /**
   * Get channel state for debugging/testing. A pure read: it records nothing.
   */
  getChannelState(channelId: string): { hopCount: number; paused: boolean } {
    const { hops, paused } = this.stateAt(channelId, this.now());
    return { hopCount: hops.length + (paused ? 1 : 0), paused };
  }

  /**
   * The hint for a send the loop guard refused: why nobody woke, and when the
   * channel routes again. Without it a paused channel read exactly like a
   * message that named nobody: chat_send answered `routingTargets: []` alone.
   */
  pausedHint(channelId: string, channelName: string): string {
    const now = this.now();
    const { hops } = this.stateAt(channelId, now);
    // There is room for one more hop once only maxHops - 1 of these are left.
    const freeing = hops.length - this.maxHops;
    const resumesIn = freeing >= 0 ? hops[freeing] + this.hopWindowMs - now : 0;
    return `The loop guard paused routing in #${channelName} (more than ${this.maxHops} agent hops within ` +
      `${roughly(this.hopWindowMs)}): this message is stored but woke nobody. Routing resumes in ${roughly(resumesIn)}, ` +
      `when the oldest of those hops leaves the window, or as soon as a human posts in #${channelName}; ` +
      'posting again here does not delay it.';
  }

  /** The channel at `now`: its routed hops inside the window, and whether a refusal still holds. */
  private stateAt(channel: string, now: number): { hops: number[]; paused: boolean } {
    const cutoff = now - this.hopWindowMs;
    const hops = (this.hopTimes.get(channel) ?? []).filter((t) => t >= cutoff).slice(-(this.maxHops + 1));
    return { hops, paused: this.pausedChannels.has(channel) && hops.length >= this.maxHops };
  }
}
