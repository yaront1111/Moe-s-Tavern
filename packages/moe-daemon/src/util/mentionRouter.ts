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

export class MentionRouter {
  private hopCounts = new Map<string, number>();
  private pausedChannels = new Set<string>();
  private readonly maxHops: number;

  constructor(maxHops = 4) {
    this.maxHops = maxHops;
  }

  /**
   * Parse @mentions from message content, matching against known worker IDs.
   * Supports group mentions: @all, @architects, @workers, @qa
   */
  parseMentions(content: string, knownWorkerIds: string[], workers?: Worker[], teams?: Team[]): string[] {
    if (!content) return [];

    const mentionRegex = /@([\w][\w-]*)/g;
    const rawMentions: string[] = [];
    let match: RegExpExecArray | null;
    while ((match = mentionRegex.exec(content)) !== null) {
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
      } else if (lower === 'architects' || lower === 'workers' || lower === 'qa') {
        // Map group mention to team role
        const targetRole = lower === 'architects' ? 'architect' : lower === 'workers' ? 'worker' : 'qa';

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
          const searchTerm = targetRole; // 'architect', 'worker', or 'qa'
          for (const id of knownWorkerIds) {
            if (id.toLowerCase().includes(searchTerm)) result.add(id);
          }
        }
      } else if (knownWorkerIds.includes(mention)) {
        // Direct worker ID mention
        result.add(mention);
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
      // No explicit mentions from human → notify all online workers
      const onlineWorkers = allWorkers
        .filter((w) => w.status !== 'IDLE')
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

    // Agents must explicitly @mention to route — no mentions means no routing
    if (mentions.length === 0) {
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

    // Filter out self-routing (agent can't trigger itself)
    const targets = mentions.filter((id) => id !== message.sender);

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
