import fs from 'fs';
import path from 'path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ToolTestHarness } from './toolTestHarness.js';
import { joinTeamTool } from './joinTeam.js';
import { deregisterWorkerTool } from './deregisterWorker.js';
import { claimNextTaskTool } from './claimNextTask.js';
import { chatWhoTool } from './chatWho.js';
import { listWorkersTool } from './listWorkers.js';
import { activeChatWaiters } from './chatWait.js';
import { listAttempts } from '../state/attemptStore.js';
import type { Team, Worker, WorkerType } from '../types/schema.js';

// The seat's CLI (CLAUDE/CODEX/GEMINI/GROK) is reported by the launcher on
// claim_next_task and join_team. Only an exact, case-sensitive name is kept;
// everything else is recorded as CLAUDE and never refused. An omitted field is
// "not reported": a new record gets CLAUDE and an existing one keeps its type.
const TYPES: WorkerType[] = ['CLAUDE', 'CODEX', 'GEMINI', 'GROK'];
const FROZEN = '2026-10-26T04:44:45.000Z';

describe('moe.join_team records the reported worker type', () => {
  const h = new ToolTestHarness();
  let team: Team;

  beforeEach(async () => {
    h.init();
    h.setupMoeFolder();
    await h.state.load();
    team = await h.state.createTeam({ name: 'Workers' });
  });
  afterEach(() => { vi.restoreAllMocks(); h.cleanup(); });

  const join = (workerId: string, extra: Record<string, unknown> = {}, teamId = team.id) =>
    joinTeamTool(h.state).handler({ teamId, workerId, ...extra }, h.state) as Promise<{ team: Team }>;
  const diskFile = (id: string) => path.join(h.moePath, 'workers', `${id}.json`);
  const onDisk = (id: string) => JSON.parse(fs.readFileSync(diskFile(id), 'utf-8')) as Worker;
  const type = (id: string) => h.state.getWorker(id)?.type;

  /** An existing seat that is already a member of `team`, with its clock frozen. */
  const seed = async (id: string, seatType: WorkerType, overrides: Partial<Worker> = {}) => {
    h.createWorker({ id, type: seatType, ...overrides });
    await h.state.load();
    await join(id);
    await h.state.updateWorker(id, { lastActivityAt: FROZEN });
    return structuredClone(h.state.getWorker(id)!);
  };

  it('declares an optional workerType property', () => {
    const schema = joinTeamTool(h.state).inputSchema as { properties: Record<string, unknown>; required: string[] };
    expect(schema.properties).toHaveProperty('workerType');
    expect(schema.required).toEqual(['teamId', 'workerId']);
  });

  it.each(TYPES)('registers a new seat reporting %s, in memory and on disk', async (reported) => {
    const result = await join('worker-new', { workerType: reported });
    expect(result.team.memberIds).toEqual(['worker-new']);
    expect(type('worker-new')).toBe(reported);
    expect(onDisk('worker-new').type).toBe(reported);
  });

  it.each([
    ['omitted', {}],
    ['lowercase', { workerType: 'codex' }],
    ['capitalised', { workerType: 'Codex' }],
    ['padded', { workerType: ' CODEX' }],
    ['empty', { workerType: '' }],
    ['unknown name', { workerType: 'OPENAI' }],
    ['prototype name', { workerType: 'constructor' }],
    ['null', { workerType: null }],
    ['number', { workerType: 42 }],
    ['boolean', { workerType: true }],
    ['array', { workerType: ['CODEX'] }],
    ['object', { workerType: {} }],
  ])('records a new seat as CLAUDE when workerType is %s, without failing the join', async (_label, extra) => {
    const result = await join('worker-new', extra);
    expect(result.team.memberIds).toEqual(['worker-new']);
    expect(type('worker-new')).toBe('CLAUDE');
    expect(onDisk('worker-new').type).toBe('CLAUDE');
  });

  it('refreshes the type of a busy member on rejoin and changes nothing else', async () => {
    const before = await seed('worker-busy', 'CODEX', { status: 'CODING', currentTaskId: 'task-1', teamId: null });
    await h.state.updateWorkerCursors('worker-busy', { 'chan-1': 'msg-seen' });
    await h.state.updateWorker('worker-busy', { lastActivityAt: FROZEN });
    before.chatCursors = { 'chan-1': 'msg-seen' };

    const after = await join('worker-busy', { workerType: 'GEMINI' });

    expect(after.team.memberIds).toEqual(['worker-busy']);
    expect(h.state.getWorker('worker-busy')).toEqual({ ...before, type: 'GEMINI' });
    expect(onDisk('worker-busy')).toEqual({ ...before, type: 'GEMINI' });
  });

  it('leaves an existing seat byte-identical when a rejoin omits workerType', async () => {
    const before = await seed('worker-codex', 'CODEX');
    await join('worker-codex');
    expect(h.state.getWorker('worker-codex')).toEqual(before);
  });

  it('records an existing seat as CLAUDE when a rejoin reports an unknown name', async () => {
    await seed('worker-codex', 'CODEX');
    await join('worker-codex', { workerType: 'aider' });
    expect(type('worker-codex')).toBe('CLAUDE');
  });

  it('revives a DEAD seat and records the reported type', async () => {
    await join('worker-dead', { workerType: 'CODEX' });
    await deregisterWorkerTool(h.state).handler({ workerId: 'worker-dead', reason: 'wrapper_restart' }, h.state);
    expect(h.state.getWorker('worker-dead')?.status).toBe('DEAD');

    await join('worker-dead', { workerType: 'GROK' });

    expect(h.state.getWorker('worker-dead')?.status).toBe('IDLE');
    expect(type('worker-dead')).toBe('GROK');
  });

  describe('a refused join writes no type', () => {
    it('unknown team, unknown seat: throws and creates no record or file', async () => {
      await expect(join('worker-new', { workerType: 'GROK' }, 'team-missing')).rejects.toThrow('team-missing');
      expect(h.state.getWorker('worker-new')).toBeNull();
      expect(fs.existsSync(diskFile('worker-new'))).toBe(false);
    });

    it('unknown team, existing seat: keeps its type', async () => {
      await seed('worker-codex', 'CODEX');
      await expect(join('worker-codex', { workerType: 'GROK' }, 'team-missing')).rejects.toThrow('team-missing');
      expect(type('worker-codex')).toBe('CODEX');
      expect(onDisk('worker-codex').type).toBe('CODEX');
    });

    it('full team, existing seat: keeps its type', async () => {
      h.createWorker({ id: 'worker-codex', type: 'CODEX' });
      await h.state.load();
      const full = await h.state.createTeam({ name: 'Tiny', maxSize: 1 });
      await join('worker-other', {}, full.id);

      await expect(join('worker-codex', { workerType: 'GROK' }, full.id)).rejects.toThrow('is full');

      expect(type('worker-codex')).toBe('CODEX');
      expect(onDisk('worker-codex').type).toBe('CODEX');
    });
  });

  it('logs and swallows a failed type write: the join still answers and the type is unchanged', async () => {
    await seed('worker-codex', 'CODEX');
    const spy = vi.spyOn(h.state, 'updateWorker').mockRejectedValueOnce(new Error('EBUSY'));

    const result = await join('worker-codex', { workerType: 'GEMINI' });

    expect(spy).toHaveBeenCalledTimes(1);
    expect(result.team.memberIds).toEqual(['worker-codex']);
    expect(type('worker-codex')).toBe('CODEX');
  });
});

describe('moe.claim_next_task records the reported worker type', () => {
  const h = new ToolTestHarness();
  // Each test (and each it.each row) gets a fresh board: a second solo seat on
  // the same epic+status is refused, so rows must not share one.
  beforeEach(async () => {
    h.init();
    h.setupMoeFolder();
    h.createEpic();
    h.createTask({ status: 'PLANNING' });
    await h.state.load();
  });
  afterEach(() => { vi.restoreAllMocks(); h.cleanup(); });

  type Claim = { hasNext: boolean; attemptId?: string; generation?: number; alreadyAssigned?: { taskId: string }; nextAction?: { tool: string } };
  const claim = (workerId: string, extra: Record<string, unknown> = {}) =>
    claimNextTaskTool(h.state).handler({ statuses: ['PLANNING'], workerId, ...extra }, h.state) as Promise<Claim>;
  const NO_WORK = { statuses: ['REVIEW'] };
  const diskFile = (id: string) => path.join(h.moePath, 'workers', `${id}.json`);
  const type = (id: string) => h.state.getWorker(id)?.type;
  const assignments = () => Array.from(h.state.tasks.values()).map((t) => [t.id, t.assignedWorkerId]);

  /** An existing seat, its clock frozen so a presence change shows up as a diff. */
  const seat = async (id: string, seatType: WorkerType, overrides: Partial<Worker> = {}) => {
    h.createWorker({ id, type: seatType, ...overrides });
    await h.state.load();
    await h.state.updateWorker(id, { lastActivityAt: FROZEN });
    return structuredClone(h.state.getWorker(id)!);
  };

  it('declares an optional workerType property', () => {
    const schema = claimNextTaskTool(h.state).inputSchema as { properties: Record<string, unknown>; required: string[] };
    expect(schema.properties).toHaveProperty('workerType');
    expect(schema.required).toEqual(['statuses']);
  });

  it.each(TYPES)('registers a new seat reporting %s, in memory and on disk', async (reported) => {
    const result = await claim('worker-new', { workerType: reported });
    expect(result.hasNext).toBe(true);
    expect(type('worker-new')).toBe(reported);
    expect(JSON.parse(fs.readFileSync(diskFile('worker-new'), 'utf-8')).type).toBe(reported);
  });

  it.each([
    ['omitted', {}],
    ['lowercase', { workerType: 'grok' }],
    ['unknown name', { workerType: 'UNKNOWN' }],
    ['null', { workerType: null }],
    ['number', { workerType: 7 }],
  ])('registers a new seat as CLAUDE when workerType is %s, and the claim still succeeds', async (_label, extra) => {
    expect((await claim('worker-new', extra)).hasNext).toBe(true);
    expect(type('worker-new')).toBe('CLAUDE');
  });

  it('records the reported type on an existing seat that claims', async () => {
    await seat('worker-seat', 'CLAUDE');
    expect((await claim('worker-seat', { workerType: 'GEMINI' })).hasNext).toBe(true);
    expect(h.state.getTask('task-1')?.assignedWorkerId).toBe('worker-seat');
    expect(type('worker-seat')).toBe('GEMINI');
  });

  it('refreshes the type on an explicit resume and on alreadyAssigned, leaving the attempt alone', async () => {
    const first = await claim('worker-seat', { workerType: 'CODEX' });
    expect(first.hasNext).toBe(true);
    const idsBefore = listAttempts(h.state, 'task-1').map((a) => a.id);
    expect(idsBefore).toEqual([first.attemptId]);

    const resumed = await claim('worker-seat', { taskId: 'task-1', workerType: 'GROK' });
    expect(resumed).toMatchObject({ hasNext: true, attemptId: first.attemptId, generation: first.generation });
    expect(h.state.getTask('task-1')?.assignedWorkerId).toBe('worker-seat');
    expect(type('worker-seat')).toBe('GROK');
    const attempts = listAttempts(h.state, 'task-1');
    expect(attempts.map((a) => a.id)).toEqual(idsBefore);

    const held = await claim('worker-seat', { workerType: 'CODEX' });
    expect(held.alreadyAssigned?.taskId).toBe('task-1');
    expect(type('worker-seat')).toBe('CODEX');
    expect(listAttempts(h.state, 'task-1')).toEqual(attempts);
  });

  it('refreshes the type on a no-work claim without any presence change', async () => {
    const before = await seat('worker-seat', 'CLAUDE');
    const result = await claim('worker-seat', { ...NO_WORK, workerType: 'CODEX' });
    expect(result.hasNext).toBe(false);
    expect(result.nextAction?.tool).toBe('moe.wait_for_task');
    expect(h.state.getWorker('worker-seat')).toEqual({ ...before, type: 'CODEX' });
  });

  it('refreshes the type on the governor redirect and assigns nothing', async () => {
    await seat('governor-1', 'CLAUDE');
    const result = await claim('governor-1', { workerType: 'CODEX' });
    expect(result.nextAction?.tool).toBe('moe.enter_governance');
    expect(type('governor-1')).toBe('CODEX');
    expect(assignments()).toEqual([['task-1', null]]);
  });

  it.each([
    ['a successful claim', {}],
    ['a no-work claim', NO_WORK],
  ])('keeps an existing seat\'s type when %s omits workerType', async (_label, extra) => {
    await seat('worker-seat', 'CODEX');
    await claim('worker-seat', extra);
    expect(type('worker-seat')).toBe('CODEX');
  });

  it('writes nothing when the reported type is the one already stored (claims are polled)', async () => {
    const before = await seat('worker-seat', 'CODEX');
    const spy = vi.spyOn(h.state, 'updateWorker');
    await claim('worker-seat', { ...NO_WORK, workerType: 'CODEX' });
    expect(spy).not.toHaveBeenCalled();
    expect(h.state.getWorker('worker-seat')).toEqual(before);
  });

  describe.each(['an existing CODEX seat', 'an unknown seat'])('an invalid invocation by %s', (who) => {
    it.each([
      ['no statuses', { statuses: [] }, 'MISSING_REQUIRED'],
      ['a non-claimable status', { statuses: ['BACKLOG'] }, 'INVALID_INPUT'],
      ['processStartedAt without host', { processStartedAt: '1@t' }, 'INVALID_INPUT'],
      ['a blank host', { processStartedAt: '1@t', host: '  ' }, 'INVALID_INPUT'],
    ])('with %s writes no type and assigns nothing', async (_label, extra, codeName) => {
      const existing = who === 'an existing CODEX seat';
      const before = existing ? await seat('worker-seat', 'CODEX') : null;

      await expect(claim('worker-seat', { workerType: 'GROK', ...extra })).rejects.toMatchObject({ codeName });

      expect(assignments()).toEqual([['task-1', null]]);
      if (before) expect(h.state.getWorker('worker-seat')).toEqual(before);
      else {
        expect(h.state.getWorker('worker-seat')).toBeNull();
        expect(fs.existsSync(diskFile('worker-seat'))).toBe(false);
      }
    });
  });

  describe('a denied claim never creates a record just to hold the type', () => {
    const expectNoSeat = (before: unknown[]) => {
      expect(h.state.getWorker('worker-new')).toBeNull();
      expect(fs.existsSync(diskFile('worker-new'))).toBe(false);
      expect(assignments()).toEqual(before);
    };

    it('when the board has no claimable task', async () => {
      const before = assignments();
      expect((await claim('worker-new', { ...NO_WORK, workerType: 'GEMINI' })).hasNext).toBe(false);
      expectNoSeat(before);
    });

    it('when an explicit task belongs to another live seat', async () => {
      h.createWorker({ id: 'worker-owner', status: 'PLANNING', currentTaskId: 'task-1' });
      h.createTask({ status: 'PLANNING', assignedWorkerId: 'worker-owner' });
      await h.state.load();
      const before = assignments();
      await expect(claim('worker-new', { taskId: 'task-1', workerType: 'GEMINI' })).rejects.toMatchObject({ codeName: 'NOT_ALLOWED' });
      expectNoSeat(before);
    });

    it('when the solo seat is refused because a live seat holds the epic+status', async () => {
      h.createWorker({ id: 'worker-owner', status: 'PLANNING', currentTaskId: 'task-1' });
      h.createTask({ status: 'PLANNING', assignedWorkerId: 'worker-owner' });
      h.createTask({ id: 'task-2', status: 'PLANNING', order: 2 });
      await h.state.load();
      const before = assignments();
      expect((await claim('worker-new', { workerType: 'GEMINI' })).hasNext).toBe(false);
      expectNoSeat(before);
    });
  });

  it('logs and swallows a failed type write: the claim still answers and the type is unchanged', async () => {
    await seat('worker-seat', 'CLAUDE');
    const spy = vi.spyOn(h.state, 'updateWorker').mockRejectedValueOnce(new Error('EBUSY'));

    const result = await claim('worker-seat', { ...NO_WORK, workerType: 'CODEX' });

    expect(spy).toHaveBeenCalledTimes(1);
    expect(result.hasNext).toBe(false);
    expect(type('worker-seat')).toBe('CLAUDE');
  });
});

describe('moe.chat_who and moe.list_workers project the persisted type', () => {
  const h = new ToolTestHarness();
  const FRESH = new Date().toISOString();
  const STALE = new Date(Date.now() - 10 * 60_000).toISOString();
  const CHAN = 'chan-x';

  beforeEach(async () => {
    h.init();
    h.setupMoeFolder();
    h.createEpic();
    // Distinct status/task per seat, so a field mixed up between entries shows.
    h.createWorker({ id: 'worker-codex', type: 'CODEX', status: 'CODING', currentTaskId: 'task-1', lastActivityAt: FRESH, chatCursors: { [CHAN]: 'msg-1' } });
    h.createWorker({ id: 'worker-gemini', type: 'GEMINI', status: 'IDLE', lastActivityAt: FRESH });
    h.createWorker({ id: 'worker-grok', type: 'GROK', status: 'PLANNING', currentTaskId: 'task-2', lastActivityAt: FRESH, chatCursors: { [CHAN]: 'msg-2' } });
    h.createWorker({ id: 'worker-claude', type: 'CLAUDE', status: 'READING_CONTEXT', lastActivityAt: FRESH });
    h.createWorker({ id: 'worker-stale', type: 'CODEX', lastActivityAt: STALE, chatCursors: { [CHAN]: 'msg-3' } });
    h.createWorker({ id: 'worker-quiet', type: 'GEMINI', lastActivityAt: FRESH });
    h.createWorker({ id: 'worker-elsewhere', type: 'GROK', lastActivityAt: FRESH });
    await h.state.load();
    const wait = (id: string, channels: string[] | null) => activeChatWaiters.set(id, {
      resolve: () => {}, unsubscribe: () => {}, timer: setTimeout(() => {}, 60_000),
      channels: channels ? new Set(channels) : null,
    });
    wait('worker-gemini', [CHAN]);
    wait('worker-grok', [CHAN]);
    wait('worker-claude', null);
    wait('worker-elsewhere', ['chan-other']);
  });
  afterEach(() => {
    for (const waiter of activeChatWaiters.values()) clearTimeout(waiter.timer);
    activeChatWaiters.clear();
    vi.restoreAllMocks();
    h.cleanup();
  });

  const who = async (args: Record<string, unknown>) => {
    const { online } = await chatWhoTool(h.state).handler(args, h.state) as { online: Array<{ workerId: string; type?: string }> };
    return [...online].sort((a, b) => a.workerId.localeCompare(b.workerId));
  };
  const pairs = (online: Array<{ workerId: string; type?: string }>) => online.map((o) => [o.workerId, o.type]);
  const entry = (id: string, source: string) => {
    const w = h.state.getWorker(id)!;
    return { workerId: id, type: w.type, status: w.status, lastActivity: FRESH, currentTaskId: w.currentTaskId, source };
  };

  it('chat_who carries the type on a cursor, a waiting, a both and an all-channels entry', async () => {
    const online = await who({ channel: CHAN });
    expect(pairs(online)).toEqual([
      ['worker-claude', 'CLAUDE'], ['worker-codex', 'CODEX'], ['worker-gemini', 'GEMINI'], ['worker-grok', 'GROK'],
    ]);
    // The full shape: presence and membership fields are exactly as before.
    expect(online).toEqual([
      entry('worker-claude', 'waiting'),
      entry('worker-codex', 'cursor'),
      entry('worker-gemini', 'waiting'),
      entry('worker-grok', 'both'),
    ]);
  });

  it('chat_who without a channel lists every fresh seat once, with its type', async () => {
    const online = await who({});
    expect(pairs(online)).toEqual([
      ['worker-claude', 'CLAUDE'], ['worker-codex', 'CODEX'], ['worker-elsewhere', 'GROK'],
      ['worker-gemini', 'GEMINI'], ['worker-grok', 'GROK'], ['worker-quiet', 'GEMINI'],
    ]);
    expect(online).toEqual(online.map((o) => entry(o.workerId, 'cursor')));
  });

  describe('list_workers', () => {
    const listed = async () => {
      const { workers } = await listWorkersTool(h.state).handler({}, h.state) as { workers: Array<{ workerId: string; type: string }> };
      return Object.fromEntries(workers.map((w) => [w.workerId, w.type]));
    };

    it('reports the type that join_team and claim_next_task recorded, and the new one after a rejoin', async () => {
      const team = await h.state.createTeam({ name: 'Workers' });
      for (const [i, reported] of TYPES.entries()) {
        await joinTeamTool(h.state).handler({ teamId: team.id, workerId: `worker-join-${i}`, workerType: reported }, h.state);
        h.createEpic({ id: `epic-c${i}`, order: 10 + i });
        h.createTask({ id: `task-c${i}`, epicId: `epic-c${i}`, status: 'PLANNING' });
      }
      await h.state.load();
      for (const [i, reported] of TYPES.entries()) {
        const claimed = await claimNextTaskTool(h.state).handler(
          { statuses: ['PLANNING'], epicId: `epic-c${i}`, workerId: `worker-claim-${i}`, workerType: reported }, h.state) as { hasNext: boolean };
        expect(claimed.hasNext).toBe(true);
      }

      const types = await listed();
      TYPES.forEach((reported, i) => {
        expect(types[`worker-join-${i}`]).toBe(reported);
        expect(types[`worker-claim-${i}`]).toBe(reported);
      });

      await joinTeamTool(h.state).handler({ teamId: team.id, workerId: 'worker-join-0', workerType: 'GROK' }, h.state);
      expect((await listed())['worker-join-0']).toBe('GROK');
    });
  });
});
