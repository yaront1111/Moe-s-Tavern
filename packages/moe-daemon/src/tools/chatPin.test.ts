import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { ToolTestHarness } from './toolTestHarness.js';
import { flushActivityLog } from '../state/activityLog.js';
import { chatSendTool } from './chatSend.js';
import { chatPinTool } from './chatPin.js';
import { chatUnpinTool } from './chatUnpin.js';
import { MoeErrorCode } from '../util/errors.js';

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
});
