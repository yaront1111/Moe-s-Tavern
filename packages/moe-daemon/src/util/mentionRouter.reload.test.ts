/**
 * The chat loop guard (per-channel hop counts and pauses) lives in MentionRouter.
 * StateManager.load() runs on every FileWatcher reload; it used to build a NEW
 * router there, which cleared every pause and hop count with no human message.
 * load() now only re-applies chatMaxAgentHops to the one router.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ToolTestHarness } from '../tools/toolTestHarness.js';
import { MentionRouter } from './mentionRouter.js';
import type { ChatMessage, Worker } from '../types/schema.js';

// Built at runtime: a literal at-token in a test body is harmless, but keep the
// habit so nothing here can ever be echoed into chat as a mention.
const tag = (id: string): string => String.fromCharCode(64) + id;

describe('the loop guard survives state.load()', () => {
  const h = new ToolTestHarness();
  let channel: string;

  beforeEach(async () => {
    h.init();
    h.setupMoeFolder();
    h.createWorker({ id: 'worker-a', status: 'CODING' });
    h.createWorker({ id: 'worker-b', status: 'CODING' });
    await h.state.load();
    channel = h.state.getChannels().find((c) => c.name === 'workers')!.id;
  });
  afterEach(() => h.cleanup());

  /** One agent-to-agent hop; returns who the daemon routed it to. */
  async function hop(from: string, to: string): Promise<string[]> {
    const sent = await h.state.sendMessage({ channel, sender: from, content: `${tag(to)} ping` });
    return sent.routingTargets;
  }

  /** n alternating hops a->b, b->a, ...; returns each hop's routing targets. */
  async function hops(n: number, start = 0): Promise<string[][]> {
    const out: string[][] = [];
    for (let i = start; i < start + n; i += 1) {
      out.push(i % 2 === 0 ? await hop('worker-a', 'worker-b') : await hop('worker-b', 'worker-a'));
    }
    return out;
  }

  async function setMaxHopsSetting(value: number): Promise<void> {
    const file = path.join(h.moePath, 'project.json');
    const project = JSON.parse(fs.readFileSync(file, 'utf8'));
    project.settings = { ...project.settings, chatMaxAgentHops: value };
    fs.writeFileSync(file, JSON.stringify(project, null, 2));
    await h.state.load();
  }

  it('a paused channel stays paused across state.load()', async () => {
    const first = await hops(5);
    expect(first.slice(0, 4)).toEqual([['worker-b'], ['worker-a'], ['worker-b'], ['worker-a']]);
    expect(first[4]).toEqual([]);

    await h.state.load();

    expect(h.state.mentionRouter.getChannelState(channel)).toEqual({ hopCount: 5, paused: true });
    expect(await hop('worker-a', 'worker-b')).toEqual([]);
  });

  it('hop counts survive a reload and the 5th hop pauses', async () => {
    expect(await hops(4)).toEqual([['worker-b'], ['worker-a'], ['worker-b'], ['worker-a']]);

    await h.state.load();

    expect(h.state.mentionRouter.getChannelState(channel)).toEqual({ hopCount: 4, paused: false });
    expect(await hop('worker-a', 'worker-b')).toEqual([]);
    expect(h.state.mentionRouter.getChannelState(channel).paused).toBe(true);
  });

  it('a lowered chatMaxAgentHops applies on reload', async () => {
    await setMaxHopsSetting(2);

    expect(await hops(2)).toEqual([['worker-b'], ['worker-a']]);
    expect(await hop('worker-a', 'worker-b')).toEqual([]);
    expect(h.state.mentionRouter.getChannelState(channel).paused).toBe(true);
  });

  it('a human message still resets the counter and resumes after a reload', async () => {
    await hops(5);
    await h.state.load();
    expect(h.state.mentionRouter.getChannelState(channel).paused).toBe(true);

    await h.state.sendMessage({ channel, sender: 'human', content: 'carry on' });

    expect(h.state.mentionRouter.getChannelState(channel)).toEqual({ hopCount: 0, paused: false });
    expect(await hop('worker-a', 'worker-b')).toEqual(['worker-b']);
  });
});

describe('MentionRouter.setMaxHops', () => {
  const worker = (id: string): Worker => ({
    id, type: 'CLAUDE', projectId: 'proj-test', epicId: 'epic-test', currentTaskId: null,
    status: 'CODING', branch: '', modifiedFiles: [], startedAt: new Date().toISOString(),
    lastActivityAt: new Date().toISOString(), lastError: null, errorCount: 0, teamId: null,
  });
  const WORKERS = [worker('worker-a'), worker('worker-b')];
  const ping = (): ChatMessage => ({
    id: 'msg-test', channel: 'chan-test', sender: 'worker-a', content: `${tag('worker-b')} ping`,
    replyTo: null, mentions: [], timestamp: new Date().toISOString(),
  });

  it('applies a lower limit to the hops already counted, keeping them', () => {
    const router = new MentionRouter(4);
    for (let i = 1; i <= 3; i += 1) expect(router.route(ping(), WORKERS).paused).toBe(false);

    router.setMaxHops(2);

    const next = router.route(ping(), WORKERS);
    expect(next).toMatchObject({ paused: true, hopCount: 4, targets: [] });
  });

  it.each([[0], [-1], [2.5], [Number.NaN], [undefined]])(
    'falls back to the default limit of 4 for %s',
    (bad) => {
      const router = new MentionRouter(2);
      router.setMaxHops(bad as number | undefined);
      for (let i = 1; i <= 4; i += 1) {
        expect(router.route(ping(), WORKERS)).toMatchObject({ paused: false, hopCount: i });
      }
      expect(router.route(ping(), WORKERS)).toMatchObject({ paused: true, hopCount: 5, targets: [] });
    }
  );
});
