import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { ToolTestHarness } from './toolTestHarness.js';
import { flushActivityLog } from '../state/activityLog.js';
import { CHAT_READ_WINDOW_BYTES, MESSAGE_SCAN_CHUNK_BYTES } from '../state/chatStore.js';
import { chatSendTool } from './chatSend.js';
import { chatPinTool } from './chatPin.js';
import { chatReadTool } from './chatRead.js';
import { chatWaitTool } from './chatWait.js';
import { MoeError, MoeErrorCode } from '../util/errors.js';
import type { ChatMessage } from '../types/schema.js';

// chat_send's replyTo check and chat_pin look a message up in the WHOLE channel
// log (messageExistsAnywhereInChannel), so a message older than the newest
// CHAT_READ_WINDOW_BYTES can still be replied to and pinned (filed from hunt
// #15, task-a617a035). The explicit-sinceId callers, chat_read's all-channel
// mode and chat_wait's catch-up, keep the windowed messageExistsInChannel: an
// id older than the window must not reach getMessages' expired-cursor fallback.
const WRITER = 'worker-a';
const READER = 'worker-reader';
const PEER = 'worker-peer';

interface Listed { messages: Array<{ id: string; channel: string; content: string }> }

describe('chat lookups of a message older than the newest read window', () => {
  const h = new ToolTestHarness();
  let general: string;
  let workers: string;

  beforeEach(async () => {
    h.init();
    h.setupMoeFolder({ schemaVersion: 6 } as never);
    h.createEpic();
    h.createWorker({ id: WRITER, status: 'CODING' });
    h.createWorker({ id: READER });
    h.createWorker({ id: PEER });
    await h.state.load();
    general = h.state.getChannels().find((c) => c.name === 'general')!.id;
    workers = h.state.getChannels().find((c) => c.name === 'workers')!.id;
  });
  afterEach(async () => {
    await flushActivityLog(h.state);
    h.cleanup();
  });

  const logOf = (channel: string) => path.join(h.moePath, 'messages', `${channel}.jsonl`);
  const send = (args: Record<string, unknown>) =>
    chatSendTool(h.state).handler(args, h.state) as Promise<{ success: boolean; messageId: string; channel: string }>;
  const pin = (args: Record<string, unknown>) => chatPinTool(h.state).handler(args, h.state);
  const read = (args: Record<string, unknown>) => chatReadTool(h.state).handler(args, h.state) as Promise<Listed>;
  const wait = (args: Record<string, unknown>) =>
    chatWaitTool(h.state).handler({ workerId: READER, timeoutMs: 1000, ...args }, h.state) as Promise<Listed>;
  const post = async (channel: string, content: string, sender = PEER) =>
    (await h.state.sendMessage({ channel, sender, content })).message.id;
  const line = (channel: string, id: string, extra: Partial<ChatMessage> = {}) => JSON.stringify({
    id, channel, sender: PEER, content: `filler ${id} `.padEnd(600, '.'), replyTo: null, mentions: [],
    timestamp: new Date().toISOString(), ...extra,
  });

  /** Append later PEER lines past the read window, in the store's own line format; returns the newest id. */
  function pushPastWindow(channel: string): string {
    const lines: string[] = [];
    let bytes = 0;
    while (bytes <= CHAT_READ_WINDOW_BYTES + 64 * 1024) {
      lines.push(line(channel, `msg-filler${String(lines.length).padStart(6, '0')}`));
      bytes += Buffer.byteLength(lines[lines.length - 1]) + 1;
    }
    fs.appendFileSync(logOf(channel), lines.join('\n') + '\n');
    return JSON.parse(lines[lines.length - 1]).id;
  }

  it('(1) only the whole-file lookup finds a message older than the window', async () => {
    const old = await post(general, 'governor ruling: keep X', 'human');
    pushPastWindow(general);
    expect(fs.statSync(logOf(general)).size).toBeGreaterThan(CHAT_READ_WINDOW_BYTES);
    expect(h.state.messageExistsInChannel(general, old)).toBe(false);
    expect(h.state.messageExistsAnywhereInChannel(general, old)).toBe(true);
  });

  it('(2) chat_send accepts a replyTo naming it and stores the reply with that replyTo', async () => {
    const old = await post(general, 'governor ruling: keep X', 'human');
    pushPastWindow(general);
    // chat_send returns { success, messageId, channel, timestamp, routingTargets }, never the message.
    const sent = await send({ channel: general, content: 'ack', replyTo: old, workerId: WRITER });
    expect(sent).toMatchObject({ success: true, channel: general });
    const stored = (await h.state.getMessages(general, { limit: 10 })).find((m) => m.id === sent.messageId);
    expect(stored).toMatchObject({ sender: WRITER, content: 'ack', replyTo: old });
  });

  it('(3) chat_pin pins it', async () => {
    const old = await post(general, 'governor ruling: keep X', 'human');
    pushPastWindow(general);
    await expect(pin({ channel: general, messageId: old, workerId: WRITER })).resolves.toMatchObject({
      success: true,
      pin: { messageId: old, pinnedBy: WRITER, done: false },
    });
    expect(h.state.getPins(general).map((p) => p.messageId)).toEqual([old]);
  });

  it('(4) an id the channel never held is refused: INVALID_INPUT for chat_send, a coded NOT_FOUND for chat_pin', async () => {
    // The ghost ids sit in the scanned bytes, but never as a line's id of THIS channel.
    fs.appendFileSync(logOf(general), line(general, 'msg-holder', { replyTo: 'msg-ghost-reply', mentions: ['msg-ghost-mention'] }) + '\n');
    const elsewhere = await post(workers, 'a message of another channel');
    pushPastWindow(general);

    for (const id of ['msg-never-sent', 'msg-ghost-reply', 'msg-ghost-mention', elsewhere]) {
      await expect(send({ channel: general, content: 'ack', replyTo: id, workerId: WRITER })).rejects.toMatchObject({
        code: MoeErrorCode.INVALID_INPUT,
        codeName: 'INVALID_INPUT',
        context: { field: 'replyTo' },
      });
      const refusal = await pin({ channel: general, messageId: id, workerId: WRITER }).catch((error: unknown) => error);
      expect(refusal).toBeInstanceOf(MoeError);
      expect(refusal).toMatchObject({ code: MoeErrorCode.NOT_FOUND, codeName: 'NOT_FOUND', context: { entity: 'Message', id } });
    }
    expect(h.state.getPins(general)).toEqual([]);
    expect(fs.existsSync(path.join(h.moePath, 'pins', `${general}.json`))).toBe(false);
  });

  it('(5) finds a line that straddles a scan chunk with a split UTF-8 character, past a malformed line', async () => {
    const opening = '{"content":"';
    const target = `${opening}${'✓'.repeat(40)}","id":"msg-straddle","channel":"${general}","sender":"human",`
      + '"replyTo":null,"mentions":[],"timestamp":"2026-11-04T00:00:00.000Z"}';
    // A malformed line pads the log so the first chunk ends one byte into the first ✓ (3 bytes).
    const targetStart = MESSAGE_SCAN_CHUNK_BYTES - Buffer.byteLength(opening) - 1;
    const before = fs.statSync(logOf(general)).size;
    fs.appendFileSync(logOf(general), `${'x'.repeat(targetStart - before - 1)}\n${target}\n`);
    expect(fs.readFileSync(logOf(general)).indexOf(target)).toBe(targetStart);
    pushPastWindow(general);
    expect(h.state.messageExistsInChannel(general, 'msg-straddle')).toBe(false);
    expect(h.state.messageExistsAnywhereInChannel(general, 'msg-straddle')).toBe(true);
  });

  it('(6) chat_read all-channel mode: an explicit sinceId older than the window reads from the stored cursor, no newest-window replay', async () => {
    const old = await post(workers, 'old');
    const newest = pushPastWindow(workers);
    await h.state.updateWorkerCursors(READER, { [workers]: newest });

    const quiet = await read({ workerId: READER, sinceId: old, limit: 50 });
    expect(quiet.messages.filter((m) => m.channel === workers)).toEqual([]);

    const next = await post(workers, 'n1');
    const peek = await read({ workerId: READER, sinceId: old, limit: 50 });
    expect(peek.messages.filter((m) => m.channel === workers).map((m) => m.id)).toEqual([next]);
    expect(h.state.getWorker(READER)?.chatCursors?.[workers]).toBe(newest);
  });

  it('(7) chat_wait: an explicit sinceId older than the window drains from the stored cursor, no newest-window replay', async () => {
    const old = await post(workers, 'old');
    const newest = pushPastWindow(workers);
    await h.state.updateWorkerCursors(READER, { [workers]: newest });
    const next = await post(workers, 'n1');

    const result = await wait({ channels: [workers], sinceId: old });
    expect(result.messages.map((m) => m.id)).toEqual([next]);
  });
});
