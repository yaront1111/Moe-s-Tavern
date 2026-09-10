/**
 * System messages must be NEUTRAL for the loop guard.
 *
 * Observed 2026-09-10 in #workers: two seats exchanged seven messages over
 * eighteen minutes, each correctly reporting who held a resource lease, each
 * @-tagging the other, each answering a snapshot that had already expired. With
 * maxHops = 4 the guard should have paused the channel after four. It never
 * fired, because `route()` classified `sender === 'system'` as a human message,
 * and the human path unconditionally resets hopCounts to 0 and clears the
 * pause. On a working channel the daemon's own bookkeeping — checkpoint commit
 * banners, "Step N completed", claim notices, resource grants — arrives about
 * once a minute, which reset the counter faster than the agents could reach the
 * limit. A governor's containment message did not stop the loop either; only
 * the seats running out of things to say did.
 */
import { describe, it, expect } from 'vitest';
import { MentionRouter } from './mentionRouter.js';
import type { ChatMessage, Worker } from '../types/schema.js';

const makeWorker = (id: string, overrides: Partial<Worker> = {}): Worker => ({
  id,
  type: 'CLAUDE',
  projectId: 'proj-test',
  epicId: 'epic-test',
  currentTaskId: null,
  status: 'CODING',
  branch: '',
  modifiedFiles: [],
  startedAt: new Date().toISOString(),
  lastActivityAt: new Date().toISOString(),
  lastError: null,
  errorCount: 0,
  teamId: null,
  ...overrides,
});

const makeMessage = (sender: string, content: string): ChatMessage => ({
  id: 'msg-test',
  channel: 'chan-workers',
  sender,
  content,
  replyTo: null,
  mentions: [],
  timestamp: new Date().toISOString(),
});

const WORKERS = [
  makeWorker('worker-alice'),
  makeWorker('worker-bob'),
  makeWorker('worker-idle', { status: 'IDLE' }),
];

/** The shape of the banners the daemon posts while a channel is working. */
const CHECKPOINT = makeMessage(
  'system',
  '📦 checkpoint commit recorded for task-abc: 725613088aae — 2 path(s), 0 inferred, pushed'
);
const PING = makeMessage('worker-alice', '@worker-bob who holds the gate');

describe('a system message does not resume a channel', () => {
  it('does not reset the hop counter between agent hops', () => {
    const router = new MentionRouter(4);

    // One banner between each agent hop — the real interleaving in #workers.
    for (let hop = 1; hop <= 4; hop += 1) {
      const agent = router.route(PING, WORKERS);
      expect(agent.hopCount).toBe(hop);
      expect(agent.paused).toBe(false);
      router.route(CHECKPOINT, WORKERS);
    }

    // Fifth routable hop exceeds maxHops even though four banners intervened.
    // Before the fix this returned hopCount 1 forever and never paused.
    const fifth = router.route(PING, WORKERS);
    expect(fifth.hopCount).toBe(5);
    expect(fifth.paused).toBe(true);
    expect(fifth.targets).toEqual([]);
  });

  it('does not clear an existing pause', () => {
    const router = new MentionRouter(4);
    for (let i = 0; i <= 4; i += 1) router.route(PING, WORKERS);
    expect(router.getChannelState('chan-workers').paused).toBe(true);

    router.route(CHECKPOINT, WORKERS);

    expect(router.getChannelState('chan-workers').paused).toBe(true);
    expect(router.route(PING, WORKERS).targets).toEqual([]);
  });

  it('reports the channel state it found rather than a fresh one', () => {
    const router = new MentionRouter(4);
    for (let i = 0; i <= 4; i += 1) router.route(PING, WORKERS);

    const banner = router.route(CHECKPOINT, WORKERS);

    expect(banner.paused).toBe(true);
    expect(banner.hopCount).toBe(5);
  });

  it('still delivers the banner on a paused channel', () => {
    // The pause stops agents answering each other. It must not hide a
    // stale-worker alert from the seat that needs to act on it.
    const router = new MentionRouter(4);
    for (let i = 0; i <= 4; i += 1) router.route(PING, WORKERS);

    const broadcast = router.route(CHECKPOINT, WORKERS);
    expect(broadcast.targets).toEqual(['worker-alice', 'worker-bob']);

    // Real banners name a worker WITHOUT an "@" ("⚠️ worker-bob stale on ..."),
    // so they parse to no mentions and broadcast. That is pre-existing routing
    // and this change does not touch it; the arm pins it so the neutral path
    // cannot quietly start swallowing alerts on a paused channel.
    const alert = router.route(
      makeMessage('system', '⚠️ worker-bob stale on task-abc — last activity 281s ago'),
      WORKERS
    );
    expect(alert.targets).toEqual(['worker-alice', 'worker-bob']);
    expect(alert.paused).toBe(true);
  });

  it('honours an explicit @mention in a banner when one is present', () => {
    const router = new MentionRouter(4);

    const addressed = router.route(makeMessage('system', 'grant went to @worker-bob'), WORKERS);

    expect(addressed.targets).toEqual(['worker-bob']);
    expect(addressed.hopCount).toBe(0);
  });

  it('leaves an IDLE worker out of an unaddressed banner, as before', () => {
    const router = new MentionRouter(4);
    expect(router.route(CHECKPOINT, WORKERS).targets).not.toContain('worker-idle');
  });

  it('still lets a human resume the channel', () => {
    // The escape hatch has to keep working, or a paused channel is a dead one.
    const router = new MentionRouter(4);
    for (let i = 0; i <= 4; i += 1) router.route(PING, WORKERS);
    expect(router.getChannelState('chan-workers').paused).toBe(true);

    router.route(makeMessage('human', 'carry on'), WORKERS);

    expect(router.getChannelState('chan-workers').paused).toBe(false);
    expect(router.route(PING, WORKERS)).toMatchObject({ paused: false, hopCount: 1 });
  });
});
