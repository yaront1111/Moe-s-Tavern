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
import { chatWaitTool } from './chatWait.js';
import { chatReadTool } from './chatRead.js';
import { chatSendTool } from './chatSend.js';
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
      epicId: null,
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
      await post(channels.general, 'not in the governors channel', 'system');

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
      const message = await post(channels.general, 'governor online', 'system');

      const result = await read({ channel: '#general', workerId: WORKER_ID, limit: 10 });

      expect(result.messages.map((m) => m.id)).toEqual([message.id]);
    });

    it('keys the saved cursor on the canonical id, not on the reference', async () => {
      const message = await post(channels.general, 'first', 'system');
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
      const parent = await post(channels.general, 'parent', 'system');

      await send({ channel: '#general', content: 'child', workerId: WORKER_ID, replyTo: parent.id });

      const stored = await state.getMessages(channels.general, { limit: 10 });
      expect(stored.find((m) => m.content === 'child')?.replyTo).toBe(parent.id);
    });
  });
});
