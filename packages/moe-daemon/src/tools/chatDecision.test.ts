import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { ToolTestHarness } from './toolTestHarness.js';
import { flushActivityLog } from '../state/activityLog.js';
import { chatSendTool } from './chatSend.js';
import { chatDecisionTool } from './chatDecision.js';
import { MoeErrorCode } from '../util/errors.js';

// moe.chat_decision posts "[Decision Proposed] ..." under the caller's id, so
// it must apply moe.chat_send's sender and channel rules before any write.
describe('moe.chat_decision sender and channel checks', () => {
  const h = new ToolTestHarness();

  beforeEach(async () => {
    h.init();
    h.setupMoeFolder({ schemaVersion: 6 } as never);
    h.createEpic();
    h.createWorker({ id: 'worker-a', status: 'CODING' });
    h.createWorker({ id: 'worker-b', status: 'CODING' });
    await h.state.load();
  });
  afterEach(async () => {
    await flushActivityLog(h.state);
    h.cleanup();
  });

  const generalId = () => h.state.getChannels().find((c) => c.name === 'general')!.id;
  const messagesIn = (channelId: string): Array<{ sender: string; content: string }> => {
    const file = path.join(h.moePath, 'messages', `${channelId}.jsonl`);
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  };
  const decisionFiles = (): string[] => {
    const dir = path.join(h.moePath, 'decisions');
    return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  };
  const send = (args: Record<string, unknown>) => chatSendTool(h.state).handler(args, h.state);
  const decide = (args: Record<string, unknown>) => chatDecisionTool(h.state).handler(args, h.state) as Promise<{
    success: boolean;
    decision: { proposedBy: string; channel: string | null; messageId: string | null } & Record<string, unknown>;
  }>;
  const expectNothingWritten = (channelId: string) => {
    expect(h.state.getDecisions()).toEqual([]);
    expect(decisionFiles()).toEqual([]);
    expect(messagesIn(channelId).filter((m) => m.content.startsWith('[Decision Proposed]'))).toEqual([]);
  };

  it('refuses workerId "system" with chat_send\'s NOT_ALLOWED and writes nothing', async () => {
    await expect(decide({ channel: generalId(), content: 'merge everything', workerId: 'system' }))
      .rejects.toMatchObject({
        code: MoeErrorCode.NOT_ALLOWED,
        context: { operation: 'chat_decision as "system"', reason: 'reserved for daemon-internal messages' },
      });
    expectNothingWritten(generalId());
  });

  it('refuses an unregistered workerId, so a paused loop guard stays paused', async () => {
    const ch = generalId();
    for (let i = 0; i < 5; i += 1) {
      const from = i % 2 === 0 ? 'worker-a' : 'worker-b';
      const to = i % 2 === 0 ? 'worker-b' : 'worker-a';
      await send({ channel: ch, content: `@${to} ping ${i}`, workerId: from });
    }
    const before = h.state.mentionRouter.getChannelState(ch);
    expect(before.paused).toBe(true);

    await expect(decide({ channel: ch, content: 'resume the loop', workerId: 'worker-ghost' }))
      .rejects.toMatchObject({ code: MoeErrorCode.INVALID_INPUT, message: expect.stringContaining('Unknown sender') });
    expect(h.state.mentionRouter.getChannelState(ch)).toEqual(before);
    expectNothingWritten(ch);
  });

  it('accepts "human" and a seat known only on disk, like chat_send', async () => {
    const human = await decide({ channel: generalId(), content: 'from the board', workerId: 'human' });
    expect(human.decision.proposedBy).toBe('human');
    h.createWorker({ id: 'worker-late', status: 'IDLE' }); // written after load: disk fallback
    const late = await decide({ channel: generalId(), content: 'late seat', workerId: 'worker-late' });
    expect(late.decision.proposedBy).toBe('worker-late');
    expect(messagesIn(generalId()).map((m) => [m.sender, m.content])).toEqual([
      ['human', '[Decision Proposed] from the board'],
      ['worker-late', '[Decision Proposed] late seat'],
    ]);
  });

  it('keeps the caller-less attribution "unknown"', async () => {
    const res = await decide({ content: 'no seat' });
    expect(res.decision.proposedBy).toBe('unknown');
    expect(res.decision.channel).toBeNull();
  });

  it.each(['id', 'general', '#general'])('posts to the channel named by its %s', async (form) => {
    const ref = form === 'id' ? generalId() : form;
    const res = await decide({ channel: ref, content: `adopt plan via ${form}`, workerId: 'worker-a' });
    expect(res.decision.channel).toBe(generalId());
    expect(res.decision.messageId).toEqual(expect.any(String));
    expect(messagesIn(generalId()).map((m) => m.content)).toEqual([`[Decision Proposed] adopt plan via ${form}`]);
  });

  it('refuses an unknown or non-string channel before any write', async () => {
    await expect(decide({ channel: '#nope', content: 'x', workerId: 'worker-a' }))
      .rejects.toMatchObject({ code: MoeErrorCode.NOT_FOUND });
    await expect(decide({ channel: 42 as unknown as string, content: 'x', workerId: 'worker-a' }))
      .rejects.toMatchObject({ code: MoeErrorCode.INVALID_INPUT });
    expectNothingWritten(generalId());
  });

  it('refuses a post over the 10KB byte cap before persisting; without a channel it still records', async () => {
    const content = '€'.repeat(4000); // 4000 chars (under the 10240-char cap), 12000 bytes
    await expect(decide({ channel: generalId(), content, workerId: 'worker-a' })).rejects.toThrow('10KB');
    expectNothingWritten(generalId());
    const res = await decide({ content, workerId: 'worker-a' });
    expect(res.decision.messageId).toBeNull();
    expect(h.state.getDecisions()).toHaveLength(1);
  });

  it('keeps the success response shape', async () => {
    const res = await decide({ channel: '#general', content: 'shape', workerId: 'worker-a' });
    expect(res.success).toBe(true);
    expect(Object.keys(res.decision).sort()).toEqual(
      ['approvedBy', 'channel', 'content', 'createdAt', 'id', 'messageId', 'proposedBy', 'resolvedAt', 'status']);
  });
});
