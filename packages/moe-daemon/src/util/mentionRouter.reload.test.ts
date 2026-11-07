/**
 * The chat loop guard (per-channel hop counts and pauses) lives in MentionRouter.
 * StateManager.load() runs on every FileWatcher reload; it used to build a NEW
 * router there, which cleared every pause and hop count with no human message.
 * load() now only re-applies chatMaxAgentHops and chatAgentHopWindowMs to the
 * one router.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ToolTestHarness } from '../tools/toolTestHarness.js';
import { MentionRouter } from './mentionRouter.js';
import { normalizeProject } from '../state/persistence.js';
import { validateSettingsUpdate } from '../state/validators.js';
import type { ChatMessage, ProjectSettings, Worker } from '../types/schema.js';

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

  async function writeSettings(patch: Record<string, unknown>): Promise<void> {
    const file = path.join(h.moePath, 'project.json');
    const project = JSON.parse(fs.readFileSync(file, 'utf8'));
    project.settings = { ...project.settings, ...patch };
    fs.writeFileSync(file, JSON.stringify(project, null, 2));
    await h.state.load();
  }

  async function setMaxHopsSetting(value: number): Promise<void> {
    await writeSettings({ chatMaxAgentHops: value });
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

  it('chatAgentHopWindowMs applies on reload, clamped to its bounds', async () => {
    expect(h.state.mentionRouter.getHopWindowMs()).toBe(120_000);

    await writeSettings({ chatAgentHopWindowMs: 30_000 });
    expect(h.state.mentionRouter.getHopWindowMs()).toBe(30_000);

    await writeSettings({ chatAgentHopWindowMs: 5 });
    expect(h.state.mentionRouter.getHopWindowMs()).toBe(10_000);
  });
});

describe('settings.chatAgentHopWindowMs bounds', () => {
  it.each([
    [undefined, 120_000], ['30000', 120_000], [Number.NaN, 120_000],
    [1, 10_000], [9_999, 10_000], [10_000, 10_000], [600_000, 600_000],
    [86_400_000, 86_400_000], [86_400_001, 86_400_000],
  ])('the project.json sanitizer reads %j as %d', (value, expected) => {
    const project = normalizeProject('/proj', { settings: { chatAgentHopWindowMs: value } as unknown as ProjectSettings });
    expect(project.settings.chatAgentHopWindowMs).toBe(expected);
  });

  it.each([[10_000], [86_400_000]])('a settings update accepts %d', (value) => {
    const project = normalizeProject('/proj', {});
    expect(validateSettingsUpdate(project, { chatAgentHopWindowMs: value }).chatAgentHopWindowMs).toBe(value);
  });

  it.each([[9_999], [86_400_001], [90_000.5], ['120000'], [null]])('a settings update refuses %j', (value) => {
    const project = normalizeProject('/proj', {});
    expect(() => validateSettingsUpdate(project, { chatAgentHopWindowMs: value } as unknown as Partial<ProjectSettings>))
      .toThrow(/chatAgentHopWindowMs/);
  });
});

describe('MentionRouter.setHopWindowMs', () => {
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

  it('applies a shorter window to the hops already recorded', () => {
    let clock = 0;
    const router = new MentionRouter(4, () => clock);
    for (let i = 1; i <= 4; i += 1) router.route(ping(), WORKERS); // the window is full

    router.setHopWindowMs(10_000);

    clock = 10_000; // exactly one (new) window old: still counted
    expect(router.route(ping(), WORKERS)).toMatchObject({ paused: true, hopCount: 5, targets: [] });
    clock = 10_001; // the default 2-minute window would still count them
    expect(router.route(ping(), WORKERS)).toMatchObject({ paused: false, hopCount: 1 });
  });

  it.each([[0], [-1], [Number.NaN], [Number.POSITIVE_INFINITY], [undefined]])(
    'falls back to the 2-minute default for %s',
    (bad) => {
      const router = new MentionRouter(4);
      router.setHopWindowMs(30_000);
      router.setHopWindowMs(bad as number | undefined);
      expect(router.getHopWindowMs()).toBe(120_000);
    }
  );
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
