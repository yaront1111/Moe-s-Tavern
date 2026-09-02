import { describe, it, expect, beforeEach } from 'vitest';
import { MentionRouter } from './mentionRouter.js';
import type { ChatMessage, Worker, Team } from '../types/schema.js';

function makeMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'msg-test1',
    channel: 'chan-general',
    sender: 'human',
    content: '',
    replyTo: null,
    mentions: [],
    timestamp: new Date().toISOString(),
    ...overrides
  };
}

function makeWorker(id: string, overrides: Partial<Worker> = {}): Worker {
  return {
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
    ...overrides
  };
}

function makeTeam(id: string, role: 'architect' | 'worker' | 'qa' | 'governor' | null, memberIds: string[] = []): Team {
  return {
    id,
    projectId: 'proj-test',
    name: role ? `${role}s` : 'custom',
    role,
    memberIds,
    maxSize: 10,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

describe('MentionRouter', () => {
  let router: MentionRouter;
  const workers = [
    makeWorker('worker-alice'),
    makeWorker('worker-bob'),
    makeWorker('worker-charlie', { status: 'IDLE' })
  ];
  const workerIds = workers.map((w) => w.id);

  beforeEach(() => {
    router = new MentionRouter(4);
  });

  describe('parseMentions', () => {
    it('extracts direct @worker-id mentions', () => {
      const result = router.parseMentions('Hello @worker-alice please help', workerIds);
      expect(result).toEqual(['worker-alice']);
    });

    it('extracts multiple mentions with deduplication', () => {
      const result = router.parseMentions('@worker-alice @worker-bob @worker-alice', workerIds);
      expect(result).toEqual(['worker-alice', 'worker-bob']);
    });

    it('ignores unknown mentions', () => {
      const result = router.parseMentions('@unknown-person hello', workerIds);
      expect(result).toEqual([]);
    });

    it('handles @all group mention', () => {
      const result = router.parseMentions('@all please review', workerIds);
      expect(result).toContain('worker-alice');
      expect(result).toContain('worker-bob');
      expect(result).toContain('worker-charlie');
      expect(result).toHaveLength(3);
    });

    it('returns empty array for empty content', () => {
      expect(router.parseMentions('', workerIds)).toEqual([]);
    });

    it('returns empty array for content without mentions', () => {
      expect(router.parseMentions('hello world', workerIds)).toEqual([]);
    });
  });

  describe('route - human messages', () => {
    it('resets hop counter on human message', () => {
      // First, build up some hops via agent messages
      const agentMsg = makeMessage({
        sender: 'worker-alice',
        content: '@worker-bob help',
        mentions: ['worker-bob']
      });
      router.route(agentMsg, workers);
      router.route(agentMsg, workers);
      expect(router.getChannelState('chan-general').hopCount).toBe(2);

      // Human message resets
      const humanMsg = makeMessage({ sender: 'human', content: 'thanks' });
      router.route(humanMsg, workers);
      expect(router.getChannelState('chan-general').hopCount).toBe(0);
    });

    it('notifies all online workers when human has no @mentions', () => {
      const msg = makeMessage({ sender: 'human', content: 'hello everyone' });
      const result = router.route(msg, workers);
      // Only non-IDLE workers
      expect(result.targets).toContain('worker-alice');
      expect(result.targets).toContain('worker-bob');
      expect(result.targets).not.toContain('worker-charlie'); // IDLE
      expect(result.paused).toBe(false);
    });

    it('notifies specific workers when human uses @mentions', () => {
      const msg = makeMessage({ sender: 'human', content: '@worker-alice do this' });
      const result = router.route(msg, workers);
      expect(result.targets).toEqual(['worker-alice']);
    });

    it('@continue clears paused state', () => {
      // Pause channel by exceeding max hops
      for (let i = 0; i <= 4; i++) {
        router.route(makeMessage({
          sender: 'worker-alice',
          content: `@worker-bob step ${i}`
        }), workers);
      }
      expect(router.getChannelState('chan-general').paused).toBe(true);

      // Human @continue resets
      const continueMsg = makeMessage({ sender: 'human', content: '@continue keep going' });
      router.route(continueMsg, workers);
      expect(router.getChannelState('chan-general').paused).toBe(false);
      expect(router.getChannelState('chan-general').hopCount).toBe(0);
    });
  });

  describe('route - agent messages', () => {
    it('increments hop counter per agent message with mentions', () => {
      const msg = makeMessage({
        sender: 'worker-alice',
        content: '@worker-bob check this'
      });
      const result = router.route(msg, workers);
      expect(result.hopCount).toBe(1);
      expect(result.paused).toBe(false);
      expect(result.targets).toEqual(['worker-bob']);
    });

    it('returns empty targets when agent has no @mentions', () => {
      const msg = makeMessage({
        sender: 'worker-alice',
        content: 'just thinking out loud'
      });
      const result = router.route(msg, workers);
      expect(result.targets).toEqual([]);
    });

    it('prevents self-routing', () => {
      const msg = makeMessage({
        sender: 'worker-alice',
        content: '@worker-alice @worker-bob note to self and bob'
      });
      const result = router.route(msg, workers);
      expect(result.targets).toEqual(['worker-bob']);
      expect(result.targets).not.toContain('worker-alice');
    });

    it('pauses channel after maxHops exceeded', () => {
      const msg = makeMessage({
        sender: 'worker-alice',
        content: '@worker-bob ping'
      });

      // 4 hops allowed (maxHops = 4)
      for (let i = 0; i < 4; i++) {
        const r = router.route(msg, workers);
        expect(r.paused).toBe(false);
      }

      // 5th hop exceeds limit
      const result = router.route(msg, workers);
      expect(result.paused).toBe(true);
      expect(result.targets).toEqual([]);
      expect(result.hopCount).toBe(5);
    });

    it('paused channel returns empty targets for subsequent messages', () => {
      // Exceed max hops
      const msg = makeMessage({
        sender: 'worker-alice',
        content: '@worker-bob ping'
      });
      for (let i = 0; i <= 4; i++) {
        router.route(msg, workers);
      }

      // Subsequent agent messages should be blocked
      const result = router.route(msg, workers);
      expect(result.targets).toEqual([]);
      expect(result.paused).toBe(true);
    });
  });

  describe('resetChannel', () => {
    it('clears hop count and paused state', () => {
      const msg = makeMessage({
        sender: 'worker-alice',
        content: '@worker-bob ping'
      });
      for (let i = 0; i <= 4; i++) {
        router.route(msg, workers);
      }
      expect(router.getChannelState('chan-general').paused).toBe(true);

      router.resetChannel('chan-general');
      expect(router.getChannelState('chan-general')).toEqual({ hopCount: 0, paused: false });
    });
  });

  describe('group mentions with team.role lookup', () => {
    const architectTeam = makeTeam('team-arch', 'architect');
    const workerTeam = makeTeam('team-work', 'worker');
    const qaTeam = makeTeam('team-qa', 'qa');
    const governorTeam = makeTeam('team-gov', 'governor');
    const teams = [architectTeam, workerTeam, qaTeam, governorTeam];

    // Workers with teamIds that DON'T match their name (the key test)
    const teamWorkers = [
      makeWorker('agent-alpha', { teamId: 'team-arch' }),    // architect by team role, not by name
      makeWorker('agent-beta', { teamId: 'team-work' }),     // worker by team role, not by name
      makeWorker('agent-gamma', { teamId: 'team-qa' }),      // qa by team role, not by name
      makeWorker('agent-delta', { teamId: 'team-gov' }),     // governor by team role, not by name
      makeWorker('agent-epsilon', { teamId: null })          // no team
    ];
    const teamWorkerIds = teamWorkers.map((w) => w.id);

    it('@architects resolves via team.role, not ID substring', () => {
      const result = router.parseMentions('@architects please review', teamWorkerIds, teamWorkers, teams);
      expect(result).toEqual(['agent-alpha']);
    });

    it('@workers resolves via team.role, not ID substring', () => {
      const result = router.parseMentions('@workers help needed', teamWorkerIds, teamWorkers, teams);
      expect(result).toEqual(['agent-beta']);
    });

    it('@qa resolves via team.role, not ID substring', () => {
      const result = router.parseMentions('@qa please check', teamWorkerIds, teamWorkers, teams);
      expect(result).toEqual(['agent-gamma']);
    });

    it('@governors resolves via team.role, not ID substring', () => {
      const result = router.parseMentions('@governors worker is stuck', teamWorkerIds, teamWorkers, teams);
      expect(result).toEqual(['agent-delta']);
    });

    it('@governor (singular) also resolves to the governor role', () => {
      const result = router.parseMentions('@governor escalate this', teamWorkerIds, teamWorkers, teams);
      expect(result).toEqual(['agent-delta']);
    });

    it('falls back to ID substring when no teams exist', () => {
      const noTeamWorkers = [
        makeWorker('architect-1'),
        makeWorker('worker-1'),
        makeWorker('qa-reviewer'),
        makeWorker('governor-on-call')
      ];
      const ids = noTeamWorkers.map((w) => w.id);
      const result = router.parseMentions('@architects @workers @qa @governors', ids, noTeamWorkers, []);
      expect(result).toContain('architect-1');
      expect(result).toContain('worker-1');
      expect(result).toContain('qa-reviewer');
      expect(result).toContain('governor-on-call');
    });

    it('route() passes teams for group mention resolution', () => {
      const msg = makeMessage({
        sender: 'human',
        content: '@architects check this'
      });
      const result = router.route(msg, teamWorkers, teams);
      expect(result.targets).toEqual(['agent-alpha']);
    });
  });

  describe('edge cases', () => {
    it('handles empty worker list', () => {
      const msg = makeMessage({ sender: 'human', content: '@worker-alice hello' });
      const result = router.route(msg, []);
      expect(result.targets).toEqual([]);
    });

    it('ignores standalone @ with no identifier following', () => {
      expect(router.parseMentions('email me @ work', workerIds)).toEqual([]);
      expect(router.parseMentions('@', workerIds)).toEqual([]);
      expect(router.parseMentions('@@worker-alice', workerIds)).toEqual([]);
    });

    it('does not match @ inside email-like tokens preceded by a word char', () => {
      const result = router.parseMentions('contact yaron@worker-alice.com', workerIds);
      expect(result).toEqual([]);
    });

    it('still matches mentions adjacent to punctuation', () => {
      expect(router.parseMentions('(@worker-alice) ping', workerIds)).toEqual(['worker-alice']);
      expect(router.parseMentions('hey,@worker-alice!', workerIds)).toEqual(['worker-alice']);
    });

    it('does not double-increment hop counter for repeated mentions in one message', () => {
      const msg = makeMessage({
        sender: 'worker-alice',
        content: '@worker-bob @worker-bob ping'
      });
      const result = router.route(msg, workers);
      expect(result.hopCount).toBe(1);
      expect(result.targets).toEqual(['worker-bob']);
    });

    it('agent messages with no resolvable mentions do not increment hop counter', () => {
      const msg = makeMessage({
        sender: 'worker-alice',
        content: '@nonexistent-worker hello'
      });
      const result = router.route(msg, workers);
      expect(result.targets).toEqual([]);
      expect(result.hopCount).toBe(0);
    });

    it('per-channel isolation', () => {
      const ch1Msg = makeMessage({
        channel: 'chan-1',
        sender: 'worker-alice',
        content: '@worker-bob ping'
      });
      const ch2Msg = makeMessage({
        channel: 'chan-2',
        sender: 'worker-alice',
        content: '@worker-bob ping'
      });

      router.route(ch1Msg, workers);
      router.route(ch1Msg, workers);
      router.route(ch2Msg, workers);

      expect(router.getChannelState('chan-1').hopCount).toBe(2);
      expect(router.getChannelState('chan-2').hopCount).toBe(1);
    });
  });
});

describe('mentions inside quoted spans', () => {
  // Regression, 2026-09-02: a governor wrote "stop using `@all`" to END a
  // broadcast loop and the daemon parsed the quoted token as a real group
  // mention — the message announcing the loop routed to every seat and obliged
  // all of them to reply, becoming another turn of it (msg-642f7e788e9e).
  it('does not route a group token that only appears inside an inline code span', () => {
    const router = new MentionRouter();
    const ids = ['worker-a', 'worker-b'];
    const parsed = router.parseMentions(
      'Stop using `@all` in this channel; the Loop Guard does not throttle `@all`.',
      ids
    );
    expect(parsed).toEqual([]);
  });

  it('still routes a real mention in the same message that quotes one', () => {
    const router = new MentionRouter();
    const ids = ['worker-a', 'worker-b'];
    const parsed = router.parseMentions(
      '@worker-a your read is right — and note `@all` is what caused it.',
      ids
    );
    expect(parsed).toEqual(['worker-a']);
  });

  it('does not route mentions buried in a fenced code block', () => {
    const router = new MentionRouter();
    const ids = ['worker-a'];
    const parsed = router.parseMentions(
      'Example transcript:\n```\n@worker-a did the thing\n```\nNothing to action.',
      ids
    );
    expect(parsed).toEqual([]);
  });
});

describe('group tokens only address from an addressing position', () => {
  const ids = ['worker-a', 'worker-b'];

  // Receipts, 2026-09-02. Quoting alone was not enough: both of these sentences
  // DECLARE that they are not broadcasting, and both routed to fifteen seats.
  it('does not broadcast when the group token is mid-sentence prose', () => {
    const router = new MentionRouter();
    expect(
      router.parseMentions('Not an ack, and no @all, per your ruling.', ids)
    ).toEqual([]);
  });

  it('does not broadcast when the token is named as the subject of discussion', () => {
    const router = new MentionRouter();
    expect(
      router.parseMentions('answering the @all leg of the sixth-axis post', ids)
    ).toEqual([]);
  });

  it('STILL broadcasts when the token opens the message — the deliberate case', () => {
    const router = new MentionRouter();
    const parsed = router.parseMentions('@all daemon restart incoming, checkpoint now.', ids);
    expect(parsed).toEqual(expect.arrayContaining(['worker-a', 'worker-b']));
  });

  it('STILL broadcasts when the token opens a later line', () => {
    const router = new MentionRouter();
    const parsed = router.parseMentions('Context first.\n@all please re-anchor on HEAD.', ids);
    expect(parsed).toEqual(expect.arrayContaining(['worker-a', 'worker-b']));
  });

  it('leaves individual mentions unrestricted anywhere in the body', () => {
    // Naming one seat mid-sentence is normal and cheap; waking every seat is not.
    const router = new MentionRouter();
    expect(
      router.parseMentions('I agree with @worker-a about the root check.', ids)
    ).toEqual(['worker-a']);
  });
});

describe('a quoted broadcast does not re-fire', () => {
  const ids = ['worker-a', 'worker-b'];

  // worker-17a62b7e measured this against the BUILT bundle after the addressing
  // -position fix shipped: '>' was skipped alongside spaces and tabs, so citing
  // an earlier broadcast in order to discuss it broadcast again — the same
  // re-arm shape the guard exists to stop.
  it('does not address from behind a markdown quote marker', () => {
    const router = new MentionRouter();
    expect(
      router.parseMentions('> @all daemon restart incoming, checkpoint now.', ids)
    ).toEqual([]);
  });

  it('does not address from a quote marker on a later line', () => {
    const router = new MentionRouter();
    expect(
      router.parseMentions('Quoting the thread:\n> @all re-anchor on HEAD', ids)
    ).toEqual([]);
  });

  it('CONTROL: the same body without the quote marker still broadcasts', () => {
    // Proves the two arms above fail for the quote marker and not because the
    // fixture is incapable of routing at all.
    const router = new MentionRouter();
    expect(
      router.parseMentions('@all daemon restart incoming, checkpoint now.', ids)
    ).toEqual(expect.arrayContaining(['worker-a', 'worker-b']));
  });
});
