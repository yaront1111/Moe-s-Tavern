/**
 * Channel REFERENCES on the chat tools.
 *
 * The governance pre-flight prompt that scripts/moe-agent.ps1 and
 * scripts/moe-agent.sh inject into every governor seat says, verbatim:
 *
 *   "moe.chat_read #general ... enter the loop: moe.chat_wait with
 *    channels=['#governors','#general'] and a long timeout"
 *
 * Before this fix the daemon refused that exact call with
 *   [INVALID_INPUT] Invalid channels: unknown channel: #governors
 * and moe.chat_read '#general' returned an empty page, which reads as a quiet
 * channel rather than as an unresolved reference. These arms hold the tools to
 * the reference form their own instructions hand out.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { StateManager } from '../state/StateManager.js';
import { activeChatWaiters, chatWaitTool } from './chatWait.js';
import { chatReadTool } from './chatRead.js';
import { chatSendTool } from './chatSend.js';
import { chatWhoTool } from './chatWho.js';
import { chatJoinTool } from './chatJoin.js';
import { chatResyncTool } from './chatResync.js';
import { MoeErrorCode } from '../util/errors.js';
import type { ChatMessage, Worker } from '../types/schema.js';

const WORKER_ID = 'governor-ref';
const TIMEOUT_MS = 1000;

interface WaitResult {
  hasMessage: boolean;
  messages?: Array<{ id: string; channel: string; content: string }>;
  timedOut?: boolean;
}

interface ReadResult {
  messages: Array<{ id: string; channel: string; content: string }>;
}

describe('chat tools accept a channel name as well as an id', () => {
  let testDir: string;
  let state: StateManager;
  let channels: Record<string, string>;

  const wait = (args: Record<string, unknown>): Promise<WaitResult> =>
    chatWaitTool(state).handler({ workerId: WORKER_ID, timeoutMs: TIMEOUT_MS, ...args }, state) as Promise<WaitResult>;
  const read = (args: Record<string, unknown>): Promise<ReadResult> =>
    chatReadTool(state).handler(args, state) as Promise<ReadResult>;
  const send = (args: Record<string, unknown>): Promise<unknown> =>
    chatSendTool(state).handler(args, state);
  const who = async (args: Record<string, unknown>): Promise<Array<{ workerId: string; source: string }>> => {
    const { online } = await chatWhoTool(state).handler(args, state) as {
      online: Array<{ workerId: string; source: string }>;
    };
    return online;
  };
  const join = (args: Record<string, unknown>): Promise<{ channel: string; channelName: string }> =>
    chatJoinTool(state).handler(args, state) as Promise<{ channel: string; channelName: string }>;
  const resync = (args: Record<string, unknown>): Promise<{ messagesCount: number; messages: Array<{ id: string }> }> =>
    chatResyncTool(state).handler(args, state) as Promise<{ messagesCount: number; messages: Array<{ id: string }> }>;
  // The system join lines chat_join has posted for WORKER_ID in a channel.
  const joinLines = async (name: string): Promise<string[]> =>
    (await state.getMessages(channels[name], { limit: 200 }))
      .filter((m) => m.sender === 'system' && m.content === `${WORKER_ID} joined #${name}`)
      .map((m) => m.id);

  const post = async (channel: string, content: string, sender = 'human'): Promise<ChatMessage> => {
    const { message } = await state.sendMessage({ channel, sender, content });
    return message;
  };

  beforeEach(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moe-chatref-test-'));
    const moePath = path.join(testDir, '.moe');
    for (const dir of ['epics', 'tasks', 'workers', 'proposals', 'teams', 'channels', 'messages']) {
      fs.mkdirSync(path.join(moePath, dir), { recursive: true });
    }
    fs.writeFileSync(path.join(moePath, 'project.json'), JSON.stringify({
      id: 'proj-test',
      name: 'Chat Ref Project',
      rootPath: testDir,
      globalRails: { techStack: [], forbiddenPatterns: [], requiredPatterns: [], formatting: '', testing: '', customRules: [] },
      settings: { approvalMode: 'CONTROL', agentCommand: 'claude' },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }, null, 2));

    const worker: Worker = {
      id: WORKER_ID,
      type: 'CLAUDE',
      projectId: 'proj-test',
      epicId: '',
      teamId: null,
      currentTaskId: null,
      status: 'IDLE',
      branch: 'main',
      modifiedFiles: [],
      startedAt: new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
      lastError: null,
      errorCount: 0,
    };
    fs.writeFileSync(path.join(moePath, 'workers', `${WORKER_ID}.json`), JSON.stringify(worker, null, 2));

    state = new StateManager({ projectPath: testDir });
    await state.load();
    channels = {};
    for (const channel of state.getChannels()) channels[channel.name] = channel.id;
    expect(channels.governors).toBeDefined();
    expect(channels.general).toBeDefined();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  describe('moe.chat_wait', () => {
    it('accepts the exact filter the governance pre-flight prompt injects', async () => {
      const message = await post(channels.governors, 'stale-worker alert', 'system');

      // The pre-empted red was thrown by validation, before any delivery.
      const result = await wait({ channels: ['#governors', '#general'] });

      expect(result.messages?.map((m) => m.id)).toEqual([message.id]);
      expect(result.hasMessage).toBe(true);
    });

    it('delivers on a bare name too, and reports the canonical id back', async () => {
      const message = await post(channels.governors, 'qa rejection', 'system');

      const result = await wait({ channels: ['governors'] });

      expect(result.messages?.map((m) => m.channel)).toEqual([channels.governors]);
      expect(result.messages?.map((m) => m.id)).toEqual([message.id]);
    });

    it('does not merely validate the name: an unwatched channel is still filtered out', async () => {
      // Guards the half of the defect a validation-only fix would leave behind —
      // a resolved-looking filter that matches no message.channel and blocks to
      // timeout on a channel that exists and has traffic.
      await post(channels.general, 'not in the governors channel');

      const result = await wait({ channels: ['#governors'] });

      expect(result.hasMessage).toBe(false);
      expect(result.timedOut).toBe(true);
    });

    it('still refuses a channel that does not exist', async () => {
      await expect(wait({ channels: ['#nope'] })).rejects.toThrow('unknown channel: #nope');
    });

    it('refuses an ambiguous name rather than picking one of two channels', async () => {
      // createChannel only rejects a duplicate name within one TYPE, so a custom
      // channel someone names "governors" sits alongside the role channel of the
      // same name — and every governor's '#governors' long-poll becomes ambiguous.
      const twin = await state.createChannel({ name: 'governors', type: 'custom' });
      expect(twin.id).not.toBe(channels.governors);

      await expect(wait({ channels: ['#governors'] })).rejects.toThrow('unknown channel: #governors');
      // The ids themselves stay addressable; only the shared NAME is ambiguous.
      await expect(wait({ channels: [channels.governors] })).resolves.toMatchObject({ hasMessage: false });
    });
  });

  describe('moe.chat_read', () => {
    it('reads a named channel instead of returning an empty page', async () => {
      const message = await post(channels.general, 'governor online');

      const result = await read({ channel: '#general', workerId: WORKER_ID, limit: 10 });

      expect(result.messages.map((m) => m.id)).toEqual([message.id]);
    });

    it('keys the saved cursor on the canonical id, not on the reference', async () => {
      const message = await post(channels.general, 'first');
      await read({ channel: '#general', workerId: WORKER_ID, limit: 10 });

      const cursors = state.getWorker(WORKER_ID)?.chatCursors ?? {};
      expect(cursors[channels.general]).toBe(message.id);
      expect(cursors['#general']).toBeUndefined();

      // A cursor under the reference would re-serve the same message forever;
      // the second read, by ID this time, must see the cursor the first one set.
      const second = await read({ channel: channels.general, workerId: WORKER_ID, limit: 10 });
      expect(second.messages).toEqual([]);
    });

    it('refuses an unresolvable channel instead of reporting it quiet', async () => {
      await expect(read({ channel: '#nope', workerId: WORKER_ID })).rejects.toThrow('Channel');
    });
  });

  describe('moe.chat_send', () => {
    it('stores the message under the canonical channel id', async () => {
      await send({ channel: '#general', content: 'sent by name', workerId: WORKER_ID });

      const stored = await state.getMessages(channels.general, { limit: 10 });
      expect(stored.map((m) => m.content)).toContain('sent by name');
      // A message stored under "#general" belongs to no channel any reader can
      // fetch, so the send would look successful and be invisible.
      expect(stored.every((m) => m.channel === channels.general)).toBe(true);
    });

    it('threads a reply by name against the resolved channel', async () => {
      const parent = await post(channels.general, 'parent');

      await send({ channel: '#general', content: 'child', workerId: WORKER_ID, replyTo: parent.id });

      const stored = await state.getMessages(channels.general, { limit: 10 });
      expect(stored.find((m) => m.content === 'child')?.replyTo).toBe(parent.id);
    });
  });

  describe('moe.chat_who', () => {
    afterEach(() => {
      for (const waiter of activeChatWaiters.values()) clearTimeout(waiter.timer);
      activeChatWaiters.clear();
    });

    it('lists the same seats for a channel id, its bare name and "#name"', async () => {
      await post(channels.general, 'governor online');
      // chat_read saves the cursor under the canonical id: that is the key chat_who matches.
      await read({ channel: channels.general, workerId: WORKER_ID });

      const ids = (await who({ channel: channels.general })).map((o) => o.workerId);
      expect(ids).toEqual([WORKER_ID]);
      expect((await who({ channel: 'general' })).map((o) => o.workerId)).toEqual(ids);
      expect((await who({ channel: '#general' })).map((o) => o.workerId)).toEqual(ids);
      // A channel the seat never read lists nobody: the filter is not a no-op.
      expect(await who({ channel: '#governors' })).toEqual([]);
    });

    it('matches a chat_wait waiter on a name against the canonical ids in its channel set', async () => {
      activeChatWaiters.set(WORKER_ID, {
        resolve: () => {}, unsubscribe: () => {}, timer: setTimeout(() => {}, 60_000),
        channels: new Set([channels.governors]),
      });

      expect((await who({ channel: '#governors' })).map((o) => [o.workerId, o.source]))
        .toEqual([[WORKER_ID, 'waiting']]);
      expect(await who({ channel: '#general' })).toEqual([]);
    });

    it('still lists every online seat when the channel is omitted or empty', async () => {
      expect((await who({})).map((o) => o.workerId)).toEqual([WORKER_ID]);
      expect((await who({ channel: '' })).map((o) => o.workerId)).toEqual([WORKER_ID]);
    });

    it('refuses a channel that does not exist, even for an all-channel waiter', async () => {
      activeChatWaiters.set(WORKER_ID, {
        resolve: () => {}, unsubscribe: () => {}, timer: setTimeout(() => {}, 60_000), channels: null,
      });

      await expect(who({ channel: '#no-such-channel' })).rejects.toMatchObject({ code: MoeErrorCode.NOT_FOUND });
    });

    it('refuses a non-string channel as INVALID_INPUT', async () => {
      await expect(who({ channel: 5 })).rejects.toMatchObject({ code: MoeErrorCode.INVALID_INPUT });
    });
  });

  describe('moe.chat_join', () => {
    it('joins "#general" and posts its join line in #general', async () => {
      const result = await join({ channel: '#general', workerId: WORKER_ID });

      expect(result.channel).toBe(channels.general);
      expect(result.channelName).toBe('general');
      expect(await joinLines('general')).toHaveLength(1);
    });

    it('is idempotent across the id, the bare name and "#name"', async () => {
      // The marker is the same text whichever form joined first, so a join made
      // by id before this change still counts as a membership.
      await join({ channel: channels.general, workerId: WORKER_ID });
      await join({ channel: 'general', workerId: WORKER_ID });
      const third = await join({ channel: '#general', workerId: WORKER_ID });

      expect(third.channel).toBe(channels.general);
      expect(await joinLines('general')).toHaveLength(1);
    });

    it('refuses a channel that does not exist and posts nothing', async () => {
      const before = (await state.getMessages(channels.general, { limit: 200 })).length;

      await expect(join({ channel: '#nope', workerId: WORKER_ID })).rejects.toMatchObject({ code: MoeErrorCode.NOT_FOUND });

      expect((await state.getMessages(channels.general, { limit: 200 })).length).toBe(before);
    });

    it('refuses a non-string channel as INVALID_INPUT', async () => {
      await expect(join({ channel: 5, workerId: WORKER_ID })).rejects.toMatchObject({ code: MoeErrorCode.INVALID_INPUT });
    });
  });

  describe('moe.chat_resync', () => {
    it('resyncs "#general": resets the cursor keyed by the id, then sets it again', async () => {
      const first = await post(channels.general, 'first');
      const second = await post(channels.general, 'second');
      const governorMsg = await post(channels.governors, 'elsewhere');
      await read({ channel: channels.general, workerId: WORKER_ID });
      await read({ channel: channels.governors, workerId: WORKER_ID });
      expect(state.getWorker(WORKER_ID)?.chatCursors?.[channels.general]).toBe(second.id);
      const updateWorker = vi.spyOn(state, 'updateWorker');

      const result = await resync({ workerId: WORKER_ID, channel: '#general' });

      expect(result.messages.map((m) => m.id)).toEqual([first.id, second.id]);
      expect(result.messagesCount).toBe(2);
      // First write clears #general's cursor, keyed by the id; the second sets it again.
      const writes = updateWorker.mock.calls.map((c) => c[1].chatCursors as Record<string, string>);
      expect(writes).toHaveLength(2);
      expect(channels.general in writes[0]).toBe(false);
      expect(writes[0][channels.governors]).toBe(governorMsg.id);
      expect(writes[1][channels.general]).toBe(second.id);
      const cursors = state.getWorker(WORKER_ID)?.chatCursors ?? {};
      expect(cursors[channels.general]).toBe(second.id);
      expect(cursors['#general']).toBeUndefined();
      expect(cursors[channels.governors]).toBe(governorMsg.id);
    });

    it('refuses a channel that does not exist and leaves every cursor alone', async () => {
      await post(channels.general, 'first');
      await read({ channel: channels.general, workerId: WORKER_ID });
      const before = structuredClone(state.getWorker(WORKER_ID)?.chatCursors);
      expect(before?.[channels.general]).toBeDefined();
      const updateWorker = vi.spyOn(state, 'updateWorker');

      await expect(resync({ workerId: WORKER_ID, channel: '#nope' })).rejects.toMatchObject({ code: MoeErrorCode.NOT_FOUND });

      expect(updateWorker).not.toHaveBeenCalled();
      expect(state.getWorker(WORKER_ID)?.chatCursors).toEqual(before);
    });

    it('refuses a non-string channel as INVALID_INPUT', async () => {
      await expect(resync({ workerId: WORKER_ID, channel: 5 })).rejects.toMatchObject({ code: MoeErrorCode.INVALID_INPUT });
    });
  });
});
