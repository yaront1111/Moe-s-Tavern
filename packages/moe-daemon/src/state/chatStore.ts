// =============================================================================
// Chat store - channels, messages, pins, unread counters and decisions
// =============================================================================
//
// Extracted verbatim from StateManager. Free functions over a StateManager
// handle; the maps and mutexes stay on the instance.
//
// Two invariants that a careless move would silently break:
//   - getMessageMutex MUST keep returning the SAME AsyncMutex instance per
//     channelId out of state.messageMutexes. A fresh mutex per call still
//     type-checks and still "works" under light load, while quietly removing
//     the serialization that stops interleaved JSONL appends.
//   - Lock ordering is state.mutex -> per-channel mutex, never the reverse.
//     sendMessage is called while callers already hold state.mutex.
//
// Calls between PUBLIC chat functions go through `state.` on purpose, not as
// direct module calls: the originals dispatched through `this`, so tests (and
// any future subclass) can still intercept them. postSystemMessage -> the
// general channel is the case that caught this - a direct call silently
// bypassed a spy that the original code honoured.
//
// Error handling: readPins and readTailJsonl degrade to an empty result on a
// missing or corrupt file rather than throwing, and the postTo* helpers are
// best-effort - callers across the daemon wrap them in try/catch precisely
// because a chat failure must never block a state transition.

import fs from 'fs';
import path from 'path';
import type { StateManager } from './StateManager.js';
import type { ChatChannel, ChatMessage, Decision, DecisionStatus, PinEntry } from '../types/schema.js';
import { logger } from '../util/logger.js';
import { generateId } from '../util/ids.js';
import { sanitizeString } from '../util/sanitize.js';
import { atomicWriteJson } from '../util/atomicWrite.js';
import { readLastLinesWithMetadata } from '../util/reverseReader.js';
import { parseRawMentions } from '../util/mentionRouter.js';

/** Increment unread count for a worker on a channel. */
/** @internal — reached by the extracted state/* modules; not part of the supported API. */
export function incrementUnread(state: StateManager, workerId: string, channelId: string): void {
  // Guard against routing targets that don't correspond to a registered
  // worker — otherwise we'd accumulate unread entries for ghost IDs forever.
  if (!state.workers.has(workerId)) {
    logger.debug({ workerId, channelId }, 'Skipping unread increment: worker not in registry');
    return;
  }
  let workerMap = state.unreadCounts.get(workerId);
  if (!workerMap) {
    workerMap = new Map();
    state.unreadCounts.set(workerId, workerMap);
  }
  workerMap.set(channelId, (workerMap.get(channelId) || 0) + 1);
}

/** Get unread message summary for a worker. Returns null if no unreads. */
export function getUnreadSummary(state: StateManager, workerId: string): { total: number; channels: Record<string, number> } | null {
  const workerMap = state.unreadCounts.get(workerId);
  if (!workerMap || workerMap.size === 0) return null;
  let total = 0;
  const channels: Record<string, number> = {};
  for (const [channelId, count] of workerMap) {
    if (count > 0) {
      total += count;
      channels[channelId] = count;
    }
  }
  return total > 0 ? { total, channels } : null;
}

/** Clear unread counts for a worker. If channelId provided, clear only that channel. */
export function clearUnread(state: StateManager, workerId: string, channelId?: string): void {
  if (channelId) {
    const workerMap = state.unreadCounts.get(workerId);
    if (workerMap) {
      workerMap.delete(channelId);
      if (workerMap.size === 0) state.unreadCounts.delete(workerId);
    }
  } else {
    state.unreadCounts.delete(workerId);
  }
}

export function getChannel(state: StateManager, channelId: string): ChatChannel | null {
  return state.channels.get(channelId) || null;
}

export function getChannels(state: StateManager): ChatChannel[] {
  return Array.from(state.channels.values()).sort(
    (a, b) => a.createdAt.localeCompare(b.createdAt)
  );
}

export async function createChannel(state: StateManager, opts: {
  name: string;
  type: ChatChannel['type'];
  linkedEntityId?: string;
}): Promise<ChatChannel> {
  return state.mutex.runExclusive(async () => {
    if (!state.project) throw new Error('Project not loaded');

    const name = opts.name?.trim();
    if (!name) throw new Error('Channel name is required');

    const validTypes = ['general', 'role', 'custom'] as const;
    if (!validTypes.includes(opts.type)) {
      throw new Error(`Invalid channel type: ${opts.type}`);
    }

    // Check for duplicate channels (must be inside mutex to prevent TOCTOU race)
    for (const existing of state.channels.values()) {
      if (existing.name === name && existing.type === opts.type) {
        throw new Error('Channel with this name and type already exists');
      }
    }

    const channel: ChatChannel = {
      id: generateId('chan'),
      name,
      type: opts.type,
      linkedEntityId: opts.linkedEntityId ?? null,
      createdAt: new Date().toISOString()
    };

    await state.writeEntity('channels', channel.id, channel);

    // Create empty messages JSONL file
    const messagesDir = path.join(state.moePath, 'messages');
    if (!fs.existsSync(messagesDir)) {
      fs.mkdirSync(messagesDir, { recursive: true });
    }
    const messagesFile = path.join(messagesDir, `${channel.id}.jsonl`);
    fs.writeFileSync(messagesFile, '');

    state.channels.set(channel.id, channel);
    state.emit({ type: 'CHANNEL_CREATED', payload: channel });
    state.appendActivity('CHANNEL_CREATED', { channelId: channel.id, name: channel.name, channelType: channel.type });

    return channel;
  });
}

export async function sendMessage(state: StateManager, opts: {
  channel: string;
  sender: string;
  content: string;
  replyTo?: string;
  decisionId?: string;
}): Promise<{ message: ChatMessage; routingTargets: string[] }> {
  const channel = state.channels.get(opts.channel);
  if (!channel) throw new Error(`Channel not found: ${opts.channel}`);

  const content = opts.content;
  if (!content || typeof content !== 'string') {
    throw new Error('Message content is required');
  }
  if (Buffer.byteLength(content, 'utf-8') > 10240) {
    throw new Error('Message content exceeds 10KB limit');
  }

  // One parser, imported — this used to be a second copy of the router's regex
  // kept in sync by comment, which is how the two drifted apart on quoting.
  const rawMentions = parseRawMentions(content);

  // Compute routing targets via MentionRouter (expands @all, applies loop guards)
  let routingTargets: string[];
  try {
    const allWorkers = Array.from(state.workers.values());
    const allTeams = Array.from(state.teams.values());
    const tempMessage: ChatMessage = {
      id: '', channel: opts.channel, sender: opts.sender,
      content, replyTo: opts.replyTo ?? null, mentions: rawMentions, timestamp: ''
    };
    const routingResult = state.mentionRouter.route(tempMessage, allWorkers, allTeams);
    routingTargets = routingResult.targets;
  } catch {
    // Fall back to raw mentions on MentionRouter errors
    routingTargets = rawMentions;
  }

  const message: ChatMessage = {
    id: generateId('msg'),
    channel: opts.channel,
    sender: opts.sender,
    content,
    replyTo: opts.replyTo ?? null,
    mentions: rawMentions,
    timestamp: new Date().toISOString(),
    ...(opts.decisionId ? { decisionId: opts.decisionId } : {})
  };

  const messagesFile = path.join(state.moePath, 'messages', `${opts.channel}.jsonl`);
  const channelMutex = state.getMessageMutex(opts.channel);
  await channelMutex.runExclusive(async () => {
    try {
      fs.appendFileSync(messagesFile, JSON.stringify(message) + '\n');
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      throw new Error(`Failed to write message: ${err.message}`);
    }
  });

  // Track unread counts for targeted workers (before emit so counts are ready when subscribers wake)
  for (const targetId of routingTargets) {
    if (targetId !== opts.sender) {
      incrementUnread(state, targetId, opts.channel);
    }
  }

  state.emit({ type: 'MESSAGE_CREATED', payload: message, routingTargets });
  state.appendActivity('MESSAGE_CREATED', {
    channelId: opts.channel,
    messageId: message.id,
    sender: opts.sender
  });

  return { message, routingTargets };
}

/**
 * Read up to the last `maxBytes` of a JSONL file. Truncates any partial
 * leading line so callers always receive complete JSON records.
 * TODO: replace with a per-channel offset index for true cursor-based reads.
 */
export function readTailJsonl(state: StateManager, filePath: string, maxBytes: number): string {
  let fd: number | null = null;
  try {
    fd = fs.openSync(filePath, 'r');
    const stat = fs.fstatSync(fd);
    const size = stat.size;
    if (size === 0) return '';
    const readLen = Math.min(maxBytes, size);
    const buf = Buffer.allocUnsafe(readLen);
    const start = size - readLen;
    fs.readSync(fd, buf, 0, readLen, start);
    let text = buf.toString('utf-8');
    // Drop the first (possibly partial) line if we didn't read from start.
    if (start > 0) {
      const nl = text.indexOf('\n');
      text = nl >= 0 ? text.slice(nl + 1) : '';
    }
    return text;
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
  }
}

export async function getMessages(state: StateManager,
  channelId: string,
  opts?: { sinceId?: string; limit?: number }
): Promise<ChatMessage[]> {
  const channel = state.channels.get(channelId);
  if (!channel) throw new Error(`Channel not found: ${channelId}`);

  const messagesFile = path.join(state.moePath, 'messages', `${channelId}.jsonl`);
  if (!fs.existsSync(messagesFile)) return [];

  // Bound the read to the last 1 MB of the JSONL file to avoid loading
  // arbitrarily large channels into memory.
  // TODO: replace with a per-channel index so old messages remain reachable.
  let raw: string;
  try {
    raw = readTailJsonl(state, messagesFile, 1024 * 1024);
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') return [];
    throw error;
  }

  const lines = raw.split('\n').filter((line) => line.trim());
  const messages: ChatMessage[] = [];
  for (const line of lines) {
    try {
      messages.push(JSON.parse(line) as ChatMessage);
    } catch {
      logger.warn({ channelId, line: line.substring(0, 100) }, 'Skipping malformed message line');
    }
  }

  let result = messages;
  let forwardPaging = false;
  if (opts?.sinceId) {
    const idx = messages.findIndex((m) => m.id === opts.sinceId);
    if (idx >= 0) {
      result = messages.slice(idx + 1);
      forwardPaging = true;
    } else {
      // Cursor expired (older than the bounded window) — surface the full
      // window so clients can resync rather than appearing stuck on empty.
      result = messages;
    }
  }

  const limit = Math.min(Math.max(opts?.limit ?? 50, 1), 200);
  // Forward paging from a known cursor returns the OLDEST slice so repeated
  // reads — each advancing the worker cursor to the last returned id — walk
  // the whole backlog in order. slice(-limit) would jump to the newest and
  // the caller's cursor advance would permanently skip the older backlog
  // (incl @mentions). Fresh reads (no/expired cursor) still return the most
  // recent window.
  return forwardPaging ? result.slice(0, limit) : result.slice(-limit);
}

/**
 * Check if a message exists in a channel's JSONL file.
 * Bounded to the last 1 MB — sufficient for recent-message callers
 * (e.g. pinMessage). Older messages cannot be referenced.
 */
export function messageExistsInChannel(state: StateManager, channelId: string, messageId: string): boolean {
  const messagesFile = path.join(state.moePath, 'messages', `${channelId}.jsonl`);
  if (!fs.existsSync(messagesFile)) return false;

  let raw: string;
  try {
    raw = readTailJsonl(state, messagesFile, 1024 * 1024);
  } catch {
    return false;
  }

  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line) as ChatMessage;
      if (msg.id === messageId) return true;
    } catch {
      continue;
    }
  }
  return false;
}

/**
 * Post a system message to the #general channel.
 * Silently skips if no general channel is found. Never throws.
 */
export async function postSystemMessage(state: StateManager, _entityId: string, content: string): Promise<void> {
  await state.postToGeneral(content);
}

/**
 * Post a system message to the 'general' channel. Never throws.
 */
export async function postToGeneral(state: StateManager, content: string): Promise<void> {
  try {
    let generalChannel: ChatChannel | null = null;
    for (const ch of state.channels.values()) {
      if (ch.type === 'general' || ch.name === 'general') {
        generalChannel = ch;
        break;
      }
    }
    if (!generalChannel) return;
    await state.sendMessage({ channel: generalChannel.id, sender: 'system', content });
  } catch (error) {
    logger.warn({ error }, 'Failed to post to general channel');
  }
}

/**
 * Post a system message to a role channel by name (e.g. 'architects').
 * Silently skips if no matching channel is found. Never throws.
 */
export async function postToRoleChannel(state: StateManager, roleName: string, content: string): Promise<void> {
  try {
    let target: ChatChannel | null = null;
    for (const ch of state.channels.values()) {
      if (ch.type === 'role' && ch.name === roleName) {
        target = ch;
        break;
      }
    }
    if (!target) return;
    await state.sendMessage({ channel: target.id, sender: 'system', content });
  } catch (error) {
    logger.warn({ error, roleName }, 'Failed to post to role channel');
  }
}

export async function deleteChannel(state: StateManager, channelId: string): Promise<void> {
  await state.mutex.runExclusive(async () => {
    const channel = state.channels.get(channelId);
    if (!channel) throw new Error(`Channel not found: ${channelId}`);

    // Remove channel JSON file (watched — suppress the echo so our own delete
    // doesn't re-trigger a full state.load()).
    const channelFile = path.join(state.moePath, 'channels', `${channelId}.json`);
    try {
      state.fileWatcher?.ignorePath(channelFile);
      fs.unlinkSync(channelFile);
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code !== 'ENOENT') throw error;
    }

    // Remove messages JSONL file (not watched, no echo to suppress)
    const messagesFile = path.join(state.moePath, 'messages', `${channelId}.jsonl`);
    try {
      fs.unlinkSync(messagesFile);
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code !== 'ENOENT') throw error;
    }

    // Remove pins file for this channel (watched — suppress the echo).
    const pinsFile = path.join(state.moePath, 'pins', `${channelId}.json`);
    try {
      if (fs.existsSync(pinsFile)) {
        state.fileWatcher?.ignorePath(pinsFile);
        fs.unlinkSync(pinsFile);
      }
    } catch {
      // Silently ignore if pins file doesn't exist
    }

    state.channels.delete(channelId);
    state.messageMutexes.delete(channelId);
    state.emit({ type: 'CHANNEL_DELETED', payload: channel });
    state.appendActivity('CHANNEL_DELETED', { channelId, name: channel.name });
  });
}

export function getPinsFilePath(state: StateManager, channelId: string): string {
  return path.join(state.moePath, 'pins', `${channelId}.json`);
}

export function readPins(state: StateManager, channelId: string): PinEntry[] {
  try {
    const filePath = getPinsFilePath(state, channelId);
    if (!fs.existsSync(filePath)) return [];
    const data = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(data) as PinEntry[];
  } catch {
    return [];
  }
}

export function writePins(state: StateManager, channelId: string, pins: PinEntry[]): void {
  const pinsDir = path.join(state.moePath, 'pins');
  if (!fs.existsSync(pinsDir)) {
    fs.mkdirSync(pinsDir, { recursive: true });
  }
  atomicWriteJson(getPinsFilePath(state, channelId), pins);
}

export function getPins(state: StateManager, channelId: string): PinEntry[] {
  return readPins(state, channelId);
}

export async function pinMessage(state: StateManager, channelId: string, messageId: string, pinnedBy: string): Promise<PinEntry> {
  return state.mutex.runExclusive(async () => {
    const channel = state.channels.get(channelId);
    if (!channel) throw new Error(`Channel not found: ${channelId}`);

    // Validate messageId exists in channel (scans full JSONL, no limit)
    if (!messageExistsInChannel(state, channelId, messageId)) {
      throw new Error(`Message not found in channel: ${messageId}`);
    }

    const pins = readPins(state, channelId);
    if (pins.some(p => p.messageId === messageId)) {
      throw new Error('Message already pinned');
    }

    const pin: PinEntry = {
      messageId,
      pinnedBy,
      pinnedAt: new Date().toISOString(),
      done: false,
      doneAt: null
    };
    pins.push(pin);
    writePins(state, channelId, pins);
    state.emit({ type: 'PINS_UPDATED', payload: { channel: channelId, pins } });
    state.appendActivity('PIN_CREATED', { channelId, messageId, pinnedBy });
    return pin;
  });
}

export async function unpinMessage(state: StateManager, channelId: string, messageId: string): Promise<void> {
  await state.mutex.runExclusive(async () => {
    const channel = state.channels.get(channelId);
    if (!channel) throw new Error(`Channel not found: ${channelId}`);

    const pins = readPins(state, channelId);
    const idx = pins.findIndex(p => p.messageId === messageId);
    if (idx === -1) throw new Error('Pin not found');

    pins.splice(idx, 1);
    writePins(state, channelId, pins);
    state.emit({ type: 'PINS_UPDATED', payload: { channel: channelId, pins } });
    state.appendActivity('PIN_REMOVED', { channelId, messageId });
  });
}

export async function togglePinDone(state: StateManager, channelId: string, messageId: string): Promise<PinEntry> {
  return state.mutex.runExclusive(async () => {
    const channel = state.channels.get(channelId);
    if (!channel) throw new Error(`Channel not found: ${channelId}`);

    const pins = readPins(state, channelId);
    const pin = pins.find(p => p.messageId === messageId);
    if (!pin) throw new Error('Pin not found');

    pin.done = !pin.done;
    pin.doneAt = pin.done ? new Date().toISOString() : null;
    writePins(state, channelId, pins);
    state.emit({ type: 'PINS_UPDATED', payload: { channel: channelId, pins } });
    state.appendActivity('PIN_TOGGLED', { channelId, messageId, done: pin.done });
    return pin;
  });
}

export function getDecision(state: StateManager, id: string): Decision | null {
  return state.decisions.get(id) || null;
}

export function getDecisions(state: StateManager): Decision[] {
  return Array.from(state.decisions.values()).sort(
    (a, b) => a.createdAt.localeCompare(b.createdAt)
  );
}

export async function createDecision(state: StateManager, opts: {
  content: string;
  proposedBy: string;
  channel?: string;
}): Promise<Decision> {
  // Lock ordering: state.mutex → channelMutex (sendMessage acquires channelMutex internally)
  return state.mutex.runExclusive(async () => {
    const content = sanitizeString(opts.content, 'content', 10240);
    if (!content) throw new Error('Decision content is required');

    const decision: Decision = {
      id: generateId('dec'),
      proposedBy: opts.proposedBy,
      content,
      status: 'proposed',
      approvedBy: null,
      channel: opts.channel ?? null,
      messageId: null,
      createdAt: new Date().toISOString(),
      resolvedAt: null
    };

    const decisionsDir = path.join(state.moePath, 'decisions');
    fs.mkdirSync(decisionsDir, { recursive: true });
    const decisionFile = path.join(decisionsDir, `${decision.id}.json`);
    atomicWriteJson(decisionFile, decision);
    state.decisions.set(decision.id, decision);

    // Post a system message to the channel if provided
    if (opts.channel && state.channels.has(opts.channel)) {
      const { message: msg } = await sendMessage(state, {
        channel: opts.channel,
        sender: opts.proposedBy,
        content: `[Decision Proposed] ${content}`,
        decisionId: decision.id
      });
      decision.messageId = msg.id;
      // Re-write with messageId linked
      atomicWriteJson(decisionFile, decision);
      state.decisions.set(decision.id, decision);
    }

    state.emit({ type: 'DECISION_PROPOSED', payload: decision });
    state.appendActivity('DECISION_PROPOSED', {
      decisionId: decision.id,
      proposedBy: decision.proposedBy,
      content: decision.content
    });

    return decision;
  });
}

export async function approveDecision(state: StateManager, id: string, approvedBy: string): Promise<Decision> {
  const decision = state.decisions.get(id);
  if (!decision) throw new Error(`Decision not found: ${id}`);
  if (decision.status !== 'proposed') throw new Error(`Decision is already ${decision.status}`);

  const updated: Decision = {
    ...decision,
    status: 'approved' as DecisionStatus,
    approvedBy,
    resolvedAt: new Date().toISOString()
  };

  const decisionFile = path.join(state.moePath, 'decisions', `${id}.json`);
  atomicWriteJson(decisionFile, updated);
  state.decisions.set(id, updated);

  state.emit({ type: 'DECISION_RESOLVED', payload: updated });
  state.appendActivity('DECISION_APPROVED', {
    decisionId: id,
    approvedBy
  });

  return updated;
}

export async function rejectDecision(state: StateManager, id: string): Promise<Decision> {
  const decision = state.decisions.get(id);
  if (!decision) throw new Error(`Decision not found: ${id}`);
  if (decision.status !== 'proposed') throw new Error(`Decision is already ${decision.status}`);

  const updated: Decision = {
    ...decision,
    status: 'rejected' as DecisionStatus,
    resolvedAt: new Date().toISOString()
  };

  const decisionFile = path.join(state.moePath, 'decisions', `${id}.json`);
  atomicWriteJson(decisionFile, updated);
  state.decisions.set(id, updated);

  state.emit({ type: 'DECISION_RESOLVED', payload: updated });
  state.appendActivity('DECISION_REJECTED', {
    decisionId: id
  });

  return updated;
}
