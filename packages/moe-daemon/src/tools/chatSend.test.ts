/**
 * moe.chat_send must say when the loop guard swallowed its routing.
 *
 * Observed 2026-11-07: governor messages naming an architect seat and a worker
 * seat in #architects and #workers came back `routingTargets: []` and nothing
 * else. Both channels had been paused by the loop guard for hours, and the
 * sender could not tell that from a message that named nobody.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ToolTestHarness } from './toolTestHarness.js';
import { chatSendTool } from './chatSend.js';
import { MentionRouter } from '../util/mentionRouter.js';

// Built at runtime, as in mentionRouter.reload.test.ts: no literal at-token here.
const tag = (id: string): string => String.fromCharCode(64) + id;

interface SendResult {
  success: boolean;
  messageId: string;
  routingTargets: string[];
  routingPaused: boolean;
  hint?: string;
}

describe('moe.chat_send reports a loop-guard pause', () => {
  const h = new ToolTestHarness();
  let channel: string;
  let clock: number;

  beforeEach(async () => {
    h.init();
    h.setupMoeFolder();
    h.createWorker({ id: 'worker-a', status: 'CODING' });
    h.createWorker({ id: 'worker-b', status: 'CODING' });
    await h.state.load();
    clock = Date.parse('2026-11-07T12:00:00Z');
    h.state.mentionRouter = new MentionRouter(4, () => clock);
    channel = h.state.getChannels().find((c) => c.name === 'architects')!.id;
  });
  afterEach(() => h.cleanup());

  const send = (workerId: string, content: string) =>
    chatSendTool(h.state).handler({ channel, content, workerId }, h.state) as Promise<SendResult>;
  const ping = (from: string, to: string) => send(from, `${tag(to)} ping`);

  /** Four routed hops, then a fifth that trips the guard (maxHops = 4). */
  async function pauseChannel(): Promise<SendResult> {
    for (let i = 0; i < 4; i += 1) {
      const [from, to] = i % 2 === 0 ? ['worker-a', 'worker-b'] : ['worker-b', 'worker-a'];
      expect(await ping(from, to)).toMatchObject({ routingTargets: [to], routingPaused: false });
    }
    return ping('worker-a', 'worker-b');
  }

  it('reports routingPaused: false and no hint while the channel routes', async () => {
    const result = await ping('worker-a', 'worker-b');

    expect(result).toMatchObject({ success: true, routingTargets: ['worker-b'], routingPaused: false });
    expect(result).not.toHaveProperty('hint');
  });

  it('reports routingPaused: true with a hint when the loop guard refuses an explicit mention', async () => {
    const paused = await pauseChannel();

    expect(paused).toMatchObject({ success: true, routingTargets: [], routingPaused: true });
    expect(paused.hint).toContain('paused routing in #architects (more than 4 agent hops within 2 min)');
    expect(paused.hint).toContain('stored but woke nobody');
    expect(paused.hint).toContain('Routing resumes in 2 min, when the oldest of those hops leaves the window');
    expect(paused.hint).toContain('or as soon as a human posts in #architects');
    expect(paused.hint).toContain("moe.add_comment on the recipient's task reaches them now");
    expect((await h.state.getMessages(channel)).map((m) => m.id)).toContain(paused.messageId);

    // A later post names the time left, counted from the same oldest hop.
    clock += 45_000;
    const later = await ping('worker-b', 'worker-a');
    expect(later).toMatchObject({ routingTargets: [], routingPaused: true });
    expect(later.hint).toContain('Routing resumes in 75 s,');
  });

  it('routes again, unpaused, once the oldest hop ages out of the window', async () => {
    await pauseChannel();
    clock += 120_001;

    const result = await ping('worker-b', 'worker-a');

    expect(result).toMatchObject({ routingTargets: ['worker-a'], routingPaused: false });
    expect(result).not.toHaveProperty('hint');
  });

  it('a human post resumes the channel at once', async () => {
    await pauseChannel();

    expect(await send('human', 'carry on')).toMatchObject({ routingPaused: false });
    expect(await ping('worker-b', 'worker-a')).toMatchObject({ routingTargets: ['worker-a'], routingPaused: false });
  });
});
