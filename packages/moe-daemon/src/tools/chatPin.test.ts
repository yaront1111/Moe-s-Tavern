import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { ToolTestHarness } from './toolTestHarness.js';
import { flushActivityLog } from '../state/activityLog.js';
import { chatSendTool } from './chatSend.js';
import { chatPinTool } from './chatPin.js';
import { chatUnpinTool } from './chatUnpin.js';
import { getActivityLogTool } from './getActivityLog.js';
import { MoeErrorCode } from '../util/errors.js';
import type { ActivityEvent } from '../types/schema.js';

// moe.chat_pin stores its caller as pinnedBy (the pins file, PINS_UPDATED and
// PIN_CREATED), so it applies moe.chat_send's sender rule; both pin tools take
// a channel reference the way chat_send does (id, "general" or "#general").
describe('moe.chat_pin and moe.chat_unpin sender and channel checks', () => {
  const h = new ToolTestHarness();

  beforeEach(async () => {
    h.init();
    h.setupMoeFolder({ schemaVersion: 6 } as never);
    h.createEpic();
    h.createWorker({ id: 'worker-a', status: 'CODING' });
    await h.state.load();
  });
  afterEach(async () => {
    await flushActivityLog(h.state);
    h.cleanup();
  });

  const generalId = () => h.state.getChannels().find((c) => c.name === 'general')!.id;
  const send = (args: Record<string, unknown>) => chatSendTool(h.state).handler(args, h.state);
  const pin = (args: Record<string, unknown>) => chatPinTool(h.state).handler(args, h.state) as Promise<{
    success: boolean;
    pin: { messageId: string; pinnedBy: string };
  }>;
  const unpin = (args: Record<string, unknown>) => chatUnpinTool(h.state).handler(args, h.state);
  const posted = async (content = 'todo: ship it') =>
    (await h.state.sendMessage({ channel: generalId(), sender: 'human', content })).message.id;
  const expectNoPin = () => {
    expect(h.state.getPins(generalId())).toEqual([]);
    expect(fs.existsSync(path.join(h.moePath, 'pins', `${generalId()}.json`))).toBe(false);
  };

  it('(p1) refuses workerId "system" with chat_send\'s NOT_ALLOWED and stores no pin', async () => {
    await expect(send({ channel: generalId(), content: 'x', workerId: 'system' }))
      .rejects.toMatchObject({ code: MoeErrorCode.NOT_ALLOWED });
    const messageId = await posted();
    await expect(pin({ channel: generalId(), messageId, workerId: 'system' })).rejects.toMatchObject({
      code: MoeErrorCode.NOT_ALLOWED,
      codeName: 'NOT_ALLOWED',
      context: { operation: 'chat_pin as "system"', reason: 'reserved for daemon-internal messages' },
    });
    expectNoPin();
  });

  it('(p2) refuses an unregistered workerId with chat_send\'s INVALID_INPUT and stores no pin', async () => {
    await expect(send({ channel: generalId(), content: 'x', workerId: 'worker-ghost' }))
      .rejects.toMatchObject({ code: MoeErrorCode.INVALID_INPUT });
    const messageId = await posted();
    await expect(pin({ channel: generalId(), messageId, workerId: 'worker-ghost' })).rejects.toMatchObject({
      code: MoeErrorCode.INVALID_INPUT,
      codeName: 'INVALID_INPUT',
      message: expect.stringContaining('Unknown sender'),
    });
    expectNoPin();
  });

  it('(p3) still pins as "human", as a registered seat and as a seat known only on disk', async () => {
    const ids = [await posted('a'), await posted('b'), await posted('c')];
    expect((await pin({ channel: generalId(), messageId: ids[0], workerId: 'human' })).pin.pinnedBy).toBe('human');
    expect((await pin({ channel: generalId(), messageId: ids[1], workerId: 'worker-a' })).pin.pinnedBy).toBe('worker-a');
    h.createWorker({ id: 'worker-late', status: 'IDLE' }); // written after load: the disk fallback
    expect((await pin({ channel: generalId(), messageId: ids[2], workerId: 'worker-late' })).pin.pinnedBy).toBe('worker-late');
    expect(h.state.getPins(generalId()).map((p) => [p.messageId, p.pinnedBy])).toEqual([
      [ids[0], 'human'],
      [ids[1], 'worker-a'],
      [ids[2], 'worker-late'],
    ]);
  });

  it.each([
    ['p4', '#general'],
    ['p5', 'general'],
  ])('(%s) pins and unpins by the reference %s, under the canonical channel id', async (_case, ref) => {
    const messageId = await posted();
    await expect(pin({ channel: ref, messageId, workerId: 'worker-a' }))
      .resolves.toMatchObject({ success: true, pin: { messageId, pinnedBy: 'worker-a' } });
    expect(h.state.getPins(generalId()).map((p) => p.messageId)).toEqual([messageId]);
    await expect(unpin({ channel: ref, messageId })).resolves.toEqual({ success: true });
    expect(h.state.getPins(generalId())).toEqual([]);
  });

  it('(p6) chat_pin refuses a channel that does not exist with NOT_FOUND and stores no pin', async () => {
    const messageId = await posted();
    for (const ref of ['chan-missing', '#nope']) {
      await expect(pin({ channel: ref, messageId, workerId: 'worker-a' })).rejects.toMatchObject({
        code: MoeErrorCode.NOT_FOUND,
        codeName: 'NOT_FOUND',
        context: { entity: 'Channel', id: ref },
      });
    }
    expectNoPin();
  });

  it('(p7) chat_unpin refuses a channel that does not exist with NOT_FOUND and keeps the pin', async () => {
    const messageId = await posted();
    await pin({ channel: generalId(), messageId, workerId: 'worker-a' });
    for (const ref of ['chan-missing', '#nope']) {
      await expect(unpin({ channel: ref, messageId })).rejects.toMatchObject({
        code: MoeErrorCode.NOT_FOUND,
        codeName: 'NOT_FOUND',
        context: { entity: 'Channel', id: ref },
      });
    }
    expect(h.state.getPins(generalId()).map((p) => p.messageId)).toEqual([messageId]);
  });

  // task-47c42043: PIN_CREATED and PIN_REMOVED name the caller as the activity event's
  // top-level workerId, the field get_activity_log { workerId } filters on; payloads
  // are unchanged (pinnedBy stays in PIN_CREATED, PIN_REMOVED stays { channelId, messageId }).
  describe('pin events record the caller as actor', () => {
    const events = async (event: string) => {
      await flushActivityLog(h.state);
      return h.state.getActivityLog(500).filter((e) => e.event === event);
    };
    const seat = async (workerId: string) => {
      await flushActivityLog(h.state);
      const r = await getActivityLogTool(h.state).handler(
        { workerId, eventTypes: ['PIN_CREATED', 'PIN_REMOVED'], limit: 100 }, h.state,
      ) as { events: ActivityEvent[] };
      return r.events;
    };

    it('(a1) chat_pin records PIN_CREATED with the caller as workerId and an unchanged payload', async () => {
      const messageId = await posted();
      await pin({ channel: generalId(), messageId, workerId: 'worker-a' });
      const created = await events('PIN_CREATED');
      expect(created.map((e) => e.workerId)).toEqual(['worker-a']);
      expect(created[0].payload).toEqual({ channelId: generalId(), messageId, pinnedBy: 'worker-a' });
    });

    it('(a2) chat_unpin records PIN_REMOVED with the caller as workerId and an unchanged payload', async () => {
      const messageId = await posted();
      await pin({ channel: generalId(), messageId, workerId: 'human' });
      await unpin({ channel: generalId(), messageId, workerId: 'worker-a' });
      const removed = await events('PIN_REMOVED');
      expect(removed.map((e) => e.workerId)).toEqual(['worker-a']);
      expect(removed[0].payload).toEqual({ channelId: generalId(), messageId });
    });

    it('(a3) get_activity_log { workerId } returns exactly the seat\'s pin and unpin events', async () => {
      const [m1, m2] = [await posted('a'), await posted('b')];
      await pin({ channel: generalId(), messageId: m1, workerId: 'worker-a' });
      await pin({ channel: generalId(), messageId: m2, workerId: 'human' });
      await unpin({ channel: generalId(), messageId: m1, workerId: 'worker-a' });
      await unpin({ channel: generalId(), messageId: m2, workerId: 'human' });
      // The log is read newest-first, so compare each seat's events sorted by name.
      const byEvent = async (id: string) => (await seat(id)).map((e) => [e.event, e.payload.messageId]).sort();
      expect(await byEvent('worker-a')).toEqual([
        ['PIN_CREATED', m1],
        ['PIN_REMOVED', m1],
      ]);
      expect(await byEvent('human')).toEqual([
        ['PIN_CREATED', m2],
        ['PIN_REMOVED', m2],
      ]);
    });

    it('(a4) chat_unpin refuses "system" and an unregistered workerId before any write', async () => {
      const messageId = await posted();
      await pin({ channel: generalId(), messageId, workerId: 'worker-a' });
      await expect(unpin({ channel: generalId(), messageId, workerId: 'system' })).rejects.toMatchObject({
        code: MoeErrorCode.NOT_ALLOWED,
        context: { operation: 'chat_unpin as "system"', reason: 'reserved for daemon-internal messages' },
      });
      await expect(unpin({ channel: generalId(), messageId, workerId: 'worker-ghost' })).rejects.toMatchObject({
        code: MoeErrorCode.INVALID_INPUT,
        message: expect.stringContaining('Unknown sender'),
      });
      await expect(unpin({ channel: generalId(), messageId, workerId: 42 })).rejects.toMatchObject({
        code: MoeErrorCode.INVALID_INPUT,
      });
      expect(h.state.getPins(generalId()).map((p) => p.messageId)).toEqual([messageId]);
      expect(await events('PIN_REMOVED')).toEqual([]);
    });

    it('(a5) chat_unpin as "human", and with workerId omitted, record PIN_REMOVED as "human"', async () => {
      const [m1, m2] = [await posted('a'), await posted('b')];
      await pin({ channel: generalId(), messageId: m1, workerId: 'worker-a' });
      await pin({ channel: generalId(), messageId: m2, workerId: 'worker-a' });
      await expect(unpin({ channel: generalId(), messageId: m1, workerId: 'human' })).resolves.toEqual({ success: true });
      await expect(unpin({ channel: generalId(), messageId: m2 })).resolves.toEqual({ success: true });
      expect((await events('PIN_REMOVED')).map((e) => [e.workerId, e.payload.messageId]).sort()).toEqual(
        [['human', m1], ['human', m2]].sort(),
      );
    });

    it('(a6) the board path (state.unpinMessage without an actor) still unpins and records no workerId', async () => {
      const messageId = await posted();
      await pin({ channel: generalId(), messageId, workerId: 'worker-a' });
      await h.state.unpinMessage(generalId(), messageId);
      expect(h.state.getPins(generalId())).toEqual([]);
      const removed = await events('PIN_REMOVED');
      expect(removed).toHaveLength(1);
      expect(removed[0].workerId).toBeUndefined();
      expect(removed[0].payload).toEqual({ channelId: generalId(), messageId });
      expect(await seat('worker-a')).toHaveLength(1); // only its own PIN_CREATED
    });
  });
});
