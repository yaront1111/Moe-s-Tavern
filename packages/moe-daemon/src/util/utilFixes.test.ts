import { describe, it, expect } from 'vitest';
import { MentionRouter } from './mentionRouter.js';
import { generateId } from './ids.js';
import type { ChatMessage, Worker } from '../types/schema.js';

function makeWorker(id: string): Worker {
  return {
    id,
    type: 'CLAUDE',
    projectId: 'proj-1',
    epicId: 'epic-1',
    currentTaskId: null,
    status: 'CODING',
    branch: 'main',
    modifiedFiles: [],
    startedAt: new Date().toISOString(),
    lastActivityAt: new Date().toISOString(),
    lastError: null,
    errorCount: 0,
    teamId: null
  } as Worker;
}

function makeMessage(sender: string, content: string): ChatMessage {
  return {
    id: generateId('msg'),
    channel: 'general',
    sender,
    content,
    replyTo: null,
    mentions: [],
    timestamp: new Date().toISOString()
  };
}

describe('L10 mentionRouter self-mention does not pause channel', () => {
  it('does not advance the hop counter or pause on a pure self-mention', () => {
    const router = new MentionRouter(4);
    const workers = [makeWorker('worker-alice'), makeWorker('worker-bob')];

    // Far more self-mentions than maxHops — must never pause or advance hops.
    for (let i = 0; i < 20; i++) {
      const result = router.route(makeMessage('worker-alice', '@worker-alice noting progress'), workers);
      expect(result.paused).toBe(false);
      expect(result.targets).toEqual([]);
      expect(result.hopCount).toBe(0);
    }

    const state = router.getChannelState('general');
    expect(state.paused).toBe(false);
    expect(state.hopCount).toBe(0);
  });

  it('still advances hops and eventually pauses when a non-self target remains', () => {
    const router = new MentionRouter(4);
    const workers = [makeWorker('worker-alice'), makeWorker('worker-bob')];

    // Each routed message mentions a real other target → advances the hop counter.
    let lastPaused = false;
    for (let i = 0; i < 5; i++) {
      const result = router.route(makeMessage('worker-alice', '@worker-bob ping'), workers);
      lastPaused = result.paused;
    }
    // 5 routable hops with maxHops=4 → the 5th must pause.
    expect(lastPaused).toBe(true);
    expect(router.getChannelState('general').paused).toBe(true);
  });
});

describe('L11 generateId uses full-entropy uuid', () => {
  it('emits at least 16 hex chars after the prefix', () => {
    const id = generateId('task');
    expect(id.startsWith('task-')).toBe(true);
    const suffix = id.slice('task-'.length);
    expect(suffix.length).toBeGreaterThanOrEqual(16);
    expect(/^[0-9a-f]+$/.test(suffix)).toBe(true);
  });

  it('does not collide across many generations', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 10000; i++) ids.add(generateId('x'));
    expect(ids.size).toBe(10000);
  });
});
