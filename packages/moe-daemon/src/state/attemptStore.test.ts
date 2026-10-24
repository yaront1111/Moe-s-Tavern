import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { ToolTestHarness } from '../tools/toolTestHarness.js';
import {
  closeHandedBackAttempts,
  closeOpenAttempts,
  currentAttempt,
  getAttempt,
  listAttempts,
  openAttempt,
  reconcileRunningAttempts,
  recordAttemptPresence,
  setAttemptPhase,
  type OpenAttemptParams,
} from './attemptStore.js';
import { StateManager } from './StateManager.js';
import type { ExecutionAttempt, ExecutionAttemptPhase, ExecutionPolicySnapshot } from '../types/schema.js';

describe('attemptStore', () => {
  const h = new ToolTestHarness();

  beforeEach(async () => {
    h.init();
    h.setupMoeFolder({ schemaVersion: 6 });
    h.createEpic();
    h.createTask({ id: 'task-1', status: 'WORKING', assignedWorkerId: 'worker-1' });
    h.createTask({ id: 'task-2', status: 'WORKING', assignedWorkerId: 'worker-2' });
    await h.state.load();
  });

  afterEach(() => {
    h.state.clearEmitter();
    vi.restoreAllMocks();
    h.cleanup();
  });

  const base = { taskId: 'task-1', workerId: 'worker-1', runnerId: 'runner-1', workspace: 'D:/wt/a' };

  function attemptsDir(): string {
    return path.join(h.moePath, 'attempts');
  }

  function attemptFile(id: string): string {
    return path.join(attemptsDir(), `${id}.json`);
  }

  function readAttempt(id: string): ExecutionAttempt {
    return JSON.parse(fs.readFileSync(attemptFile(id), 'utf8')) as ExecutionAttempt;
  }

  function attemptFiles(): string[] {
    return fs.existsSync(attemptsDir()) ? fs.readdirSync(attemptsDir()).sort() : [];
  }

  /** resourceStore.durability.test.ts style: first write for this kind throws, later ones pass. */
  function failNextAttemptWrite(): void {
    const writeEntity = h.state.writeEntity.bind(h.state);
    let failed = false;
    vi.spyOn(h.state, 'writeEntity').mockImplementation(async (kind, id, entity) => {
      if (kind === 'attempts' && !failed) {
        failed = true;
        throw new Error('Injected attempt write failure');
      }
      await writeEntity(kind, id, entity);
    });
  }

  async function openAndClose(id: string): Promise<ExecutionAttempt> {
    const attempt = await openAttempt(h.state, { ...base, id });
    await setAttemptPhase(h.state, attempt.id, 'closed');
    return attempt;
  }

  // ---------------------------------------------------------------------------
  // generation allocation
  // ---------------------------------------------------------------------------

  it('allocates generations 1, 2, 3 for three sequential attempts', async () => {
    const first = await openAndClose('attempt-a');
    const second = await openAndClose('attempt-b');
    const third = await openAndClose('attempt-c');
    expect([first.generation, second.generation, third.generation]).toEqual([1, 2, 3]);
    expect(readAttempt('attempt-c').generation).toBe(3);
  });

  it('takes the maximum, not a count: a fourth attempt after deleting the middle record gets 4', async () => {
    await openAndClose('attempt-a');
    await openAndClose('attempt-b');
    await openAndClose('attempt-c');

    // Simulate the record being gone (pruned/lost) from BOTH disk and memory —
    // an implementation counting existing records would now reissue 3.
    fs.rmSync(attemptFile('attempt-b'));
    h.state.attempts.delete('attempt-b');
    expect(listAttempts(h.state, 'task-1').map((a) => a.generation)).toEqual([1, 3]);

    const fourth = await openAttempt(h.state, { ...base, id: 'attempt-d' });
    expect(fourth.generation).toBe(4);
  });

  it('counts generations per task, so a second task starts again at 1', async () => {
    const first = await openAndClose('attempt-a');
    const other = await openAttempt(h.state, { ...base, taskId: 'task-2', id: 'attempt-t2' });
    expect(first.generation).toBe(1);
    expect(other.generation).toBe(1);
  });

  it('generates an id in the repository shape when none is supplied', async () => {
    const attempt = await openAttempt(h.state, base);
    expect(attempt.id).toMatch(/^attempt-[0-9a-f]{32}$/);
    expect(attemptFiles()).toEqual([`${attempt.id}.json`]);
  });

  // ---------------------------------------------------------------------------
  // exclusivity
  // ---------------------------------------------------------------------------

  for (const phase of ['running', 'finalizing', 'reconciling'] as ExecutionAttemptPhase[]) {
    it(`refuses a second attempt while the current one is ${phase}`, async () => {
      const live = await openAttempt(h.state, { ...base, id: 'attempt-live' });
      if (phase !== 'running') await setAttemptPhase(h.state, live.id, phase);
      const before = readAttempt('attempt-live');
      const bytesBefore = fs.readFileSync(attemptFile('attempt-live'), 'utf8');

      await expect(
        openAttempt(h.state, { ...base, id: 'attempt-second', workerId: 'worker-9' })
      ).rejects.toThrow('[ATTEMPT_ALREADY_OPEN]');

      expect(fs.readFileSync(attemptFile('attempt-live'), 'utf8')).toBe(bytesBefore);
      expect(readAttempt('attempt-live')).toEqual(before);
      expect(listAttempts(h.state, 'task-1')).toEqual([before]);
      expect(attemptFiles()).toEqual(['attempt-live.json']);
    });
  }

  it('names the live attempt, its generation and its phase in the exclusivity refusal', async () => {
    await openAndClose('attempt-a');
    const live = await openAttempt(h.state, { ...base, id: 'attempt-b' });
    await setAttemptPhase(h.state, live.id, 'finalizing');
    await expect(openAttempt(h.state, { ...base, id: 'attempt-c' })).rejects.toThrow(
      'already has attempt attempt-b (generation 2) in phase finalizing'
    );
  });

  it('allows a new attempt once the previous one is closed', async () => {
    await openAndClose('attempt-a');
    const next = await openAttempt(h.state, { ...base, id: 'attempt-b' });
    expect(next.generation).toBe(2);
    expect(currentAttempt(h.state, 'task-1')).toEqual(next);
  });

  // ---------------------------------------------------------------------------
  // idempotent repair
  // ---------------------------------------------------------------------------

  it('re-opening with the same id returns the same record, writes no second file and does not advance the generation', async () => {
    const first = await openAttempt(h.state, { ...base, id: 'attempt-a' });
    const bytesBefore = fs.readFileSync(attemptFile('attempt-a'), 'utf8');

    const repaired = await openAttempt(h.state, {
      ...base,
      id: 'attempt-a',
      workerId: 'worker-successor',
      workspace: 'D:/wt/other',
    });

    expect(repaired).toEqual(first);
    expect(repaired.generation).toBe(1);
    expect(fs.readFileSync(attemptFile('attempt-a'), 'utf8')).toBe(bytesBefore);
    expect(attemptFiles()).toEqual(['attempt-a.json']);
  });

  it('refuses a supplied id that belongs to a different task', async () => {
    await openAttempt(h.state, { ...base, id: 'attempt-a' });
    await expect(
      openAttempt(h.state, { ...base, taskId: 'task-2', id: 'attempt-a' })
    ).rejects.toThrow('[ATTEMPT_ID_TASK_MISMATCH]');
    expect(listAttempts(h.state, 'task-2')).toEqual([]);
    expect(attemptFiles()).toEqual(['attempt-a.json']);
  });

  // ---------------------------------------------------------------------------
  // durability (failure injection)
  // ---------------------------------------------------------------------------

  it('exposes no attempt anywhere when the initial write fails', async () => {
    failNextAttemptWrite();
    await expect(openAttempt(h.state, { ...base, id: 'attempt-a' })).rejects.toThrow(
      'Injected attempt write failure'
    );
    expect(getAttempt(h.state, 'attempt-a')).toBeNull();
    expect(currentAttempt(h.state, 'task-1')).toBeNull();
    expect(fs.existsSync(attemptFile('attempt-a'))).toBe(false);
  });

  it('keeps the old phase on disk and in memory when a phase write fails', async () => {
    const attempt = await openAttempt(h.state, { ...base, id: 'attempt-a' });
    const before = readAttempt('attempt-a');
    failNextAttemptWrite();

    await expect(setAttemptPhase(h.state, attempt.id, 'finalizing')).rejects.toThrow(
      'Injected attempt write failure'
    );

    expect(readAttempt('attempt-a').phase).toBe('running');
    expect(readAttempt('attempt-a')).toEqual(before);
    expect(getAttempt(h.state, 'attempt-a')!.phase).toBe('running');
    expect(getAttempt(h.state, 'attempt-a')).toEqual(before);
  });

  // ---------------------------------------------------------------------------
  // setAttemptPhase
  // ---------------------------------------------------------------------------

  it('stamps lastPhaseAt on a phase change and persists it', async () => {
    const attempt = await openAttempt(h.state, { ...base, id: 'attempt-a' });
    // Fake only Date: faking setTimeout would stall atomicWriteJsonAsync's
    // rename-retry backoff with nothing left to advance it.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(Date.parse(attempt.lastPhaseAt) + 5_000));
    let updated: ExecutionAttempt;
    try {
      updated = await setAttemptPhase(h.state, attempt.id, 'reconciling');
    } finally {
      vi.useRealTimers();
    }

    expect(updated.phase).toBe('reconciling');
    expect(updated.startedAt).toBe(attempt.startedAt);
    expect(Date.parse(updated.lastPhaseAt)).toBeGreaterThan(Date.parse(attempt.lastPhaseAt));
    expect(readAttempt('attempt-a')).toEqual(updated);
  });

  for (const phase of ['running', 'finalizing', 'reconciling'] as ExecutionAttemptPhase[]) {
    it(`refuses to move a closed attempt to ${phase} and changes nothing`, async () => {
      const attempt = await openAndClose('attempt-a');
      const before = readAttempt('attempt-a');
      await expect(setAttemptPhase(h.state, attempt.id, phase)).rejects.toThrow('[ATTEMPT_CLOSED]');
      expect(readAttempt('attempt-a')).toEqual(before);
      expect(getAttempt(h.state, 'attempt-a')).toEqual(before);
    });
  }

  it('treats re-closing a closed attempt as a no-op that writes nothing', async () => {
    const attempt = await openAndClose('attempt-a');
    const before = readAttempt('attempt-a');
    const write = vi.spyOn(h.state, 'writeEntity');

    const again = await setAttemptPhase(h.state, attempt.id, 'closed');

    expect(again).toEqual(before);
    expect(write).not.toHaveBeenCalled();
    expect(readAttempt('attempt-a')).toEqual(before);
  });

  it('refuses a phase change on an unknown attempt id', async () => {
    await expect(setAttemptPhase(h.state, 'attempt-missing', 'closed')).rejects.toThrow(
      '[ATTEMPT_NOT_FOUND]'
    );
  });

  it('refuses an unknown phase value', async () => {
    const attempt = await openAttempt(h.state, { ...base, id: 'attempt-a' });
    await expect(
      setAttemptPhase(h.state, attempt.id, 'paused' as ExecutionAttemptPhase)
    ).rejects.toThrow('[INVALID_INPUT]');
    expect(readAttempt('attempt-a').phase).toBe('running');
  });

  // ---------------------------------------------------------------------------
  // listing and reload
  // ---------------------------------------------------------------------------

  it('lists attempts in generation order and filters by task', async () => {
    const a1 = await openAndClose('attempt-a');
    const a2 = await openAndClose('attempt-b');
    const t2 = await openAttempt(h.state, { ...base, taskId: 'task-2', id: 'attempt-t2' });

    expect(listAttempts(h.state, 'task-1').map((a) => a.id)).toEqual([a1.id, a2.id]);
    expect(listAttempts(h.state, 'task-2').map((a) => a.id)).toEqual([t2.id]);
    expect(listAttempts(h.state).map((a) => a.id).sort()).toEqual(
      [a1.id, a2.id, t2.id].sort()
    );
    expect(listAttempts(h.state, 'task-unknown')).toEqual([]);
  });

  it('returns null from currentAttempt when every attempt for the task is closed', async () => {
    await openAndClose('attempt-a');
    expect(currentAttempt(h.state, 'task-1')).toBeNull();
    expect(currentAttempt(h.state, 'task-2')).toBeNull();
  });

  it('loads persisted attempts into a fresh StateManager after a restart', async () => {
    await openAndClose('attempt-a');
    const closedOnDisk = readAttempt('attempt-a');
    const live = await openAttempt(h.state, { ...base, id: 'attempt-b', host: 'box-1' });

    const restarted = new StateManager({ projectPath: h.testDir });
    await restarted.load();

    expect(restarted.attempts.size).toBe(2);
    expect(getAttempt(restarted, 'attempt-a')).toEqual(closedOnDisk);
    expect(getAttempt(restarted, 'attempt-b')).toEqual(live);
    expect(currentAttempt(restarted, 'task-1')).toEqual(live);
    // The generation survives the restart: it is never reissued.
    await setAttemptPhase(restarted, 'attempt-b', 'closed');
    const next = await openAttempt(restarted, { ...base, id: 'attempt-c' });
    expect(next.generation).toBe(3);
    restarted.clearEmitter();
  });

  it('loads an empty map for a project that has never opened an attempt', async () => {
    expect(h.state.attempts.size).toBe(0);
    expect(fs.existsSync(attemptsDir())).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // input refusals
  // ---------------------------------------------------------------------------

  const blankFields = ['taskId', 'workerId', 'runnerId', 'workspace'] as const;
  for (const field of blankFields) {
    it(`refuses a blank ${field} without writing`, async () => {
      const params: OpenAttemptParams = { ...base, id: 'attempt-a', [field]: '   ' };
      await expect(openAttempt(h.state, params)).rejects.toThrow(
        `[INVALID_INPUT] Invalid ${field}`
      );
      expect(h.state.attempts.size).toBe(0);
      expect(attemptFiles()).toEqual([]);
    });
  }

  it('refuses an id containing a path separator via the entity-id validation', async () => {
    await expect(
      openAttempt(h.state, { ...base, id: '../../escaped' })
    ).rejects.toThrow('[INVALID_INPUT] Invalid entityId');
    expect(h.state.attempts.size).toBe(0);
    expect(fs.existsSync(path.join(h.testDir, 'escaped.json'))).toBe(false);
    expect(fs.existsSync(path.join(h.moePath, 'escaped.json'))).toBe(false);
  });

  it('copies the advisory process hints through only when supplied', async () => {
    const bare = await openAttempt(h.state, { ...base, id: 'attempt-a' });
    expect('processStartedAt' in bare).toBe(false);
    expect('host' in bare).toBe(false);

    await setAttemptPhase(h.state, bare.id, 'closed');
    const hinted = await openAttempt(h.state, {
      ...base,
      id: 'attempt-b',
      processStartedAt: '2026-09-11T00:00:00.000Z',
      host: 'box-1',
    });
    expect(hinted.processStartedAt).toBe('2026-09-11T00:00:00.000Z');
    expect(hinted.host).toBe('box-1');
    expect(readAttempt('attempt-b')).toEqual(hinted);
  });
});

// =============================================================================
// Execution policy snapshot (CQ-M01d). An attempt may carry the configuration
// identity its claim derived: captured once at open, never rewritten by repair,
// phase, presence or close writes, and handed out only as detached copies.
// Opening without one keeps the exact legacy record.
// =============================================================================
describe('attemptStore execution policy snapshot', () => {
  const h = new ToolTestHarness();

  beforeEach(async () => {
    h.init();
    h.setupMoeFolder({ schemaVersion: 6 });
    h.createEpic();
    h.createTask({ id: 'task-1', status: 'WORKING', assignedWorkerId: 'worker-1' });
    await h.state.load();
  });

  afterEach(() => {
    h.state.clearEmitter();
    vi.restoreAllMocks();
    h.cleanup();
  });

  const SNAP: ExecutionPolicySnapshot = { version: 2, profile: 'observe', planRevision: 4, deliveryPolicy: 'local-branch' };
  const STRICT: ExecutionPolicySnapshot = { version: 2, profile: 'verified-local', planRevision: 1, deliveryPolicy: 'local-branch' };
  const base = { taskId: 'task-1', workerId: 'worker-1', runnerId: 'runner-1', workspace: 'D:/wt/a' };
  const LEGACY_KEYS = ['generation', 'id', 'lastPhaseAt', 'phase', 'runnerId', 'startedAt', 'taskId', 'workerId', 'workspace'];

  function attemptFile(id: string): string {
    return path.join(h.moePath, 'attempts', `${id}.json`);
  }

  function fileBytes(id: string): string {
    return fs.readFileSync(attemptFile(id), 'utf8');
  }

  function readAttempt(id: string): ExecutionAttempt {
    return JSON.parse(fileBytes(id)) as ExecutionAttempt;
  }

  function attemptFiles(): string[] {
    const dir = path.join(h.moePath, 'attempts');
    return fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [];
  }

  function hasOwnSnapshot(record: unknown): boolean {
    return Object.prototype.hasOwnProperty.call(record, 'executionPolicySnapshot');
  }

  /** The stored record and its file both still hold `snapshot`. */
  function expectStored(id: string, snapshot: ExecutionPolicySnapshot = SNAP): void {
    expect(h.state.attempts.get(id)!.executionPolicySnapshot).toEqual(snapshot);
    expect(readAttempt(id).executionPolicySnapshot).toEqual(snapshot);
  }

  /** Mutate a handed-out snapshot in place, then replace it outright. */
  function vandalize(record: ExecutionAttempt): void {
    const snapshot = record.executionPolicySnapshot as unknown as Record<string, unknown>;
    snapshot.profile = 'verified-local';
    snapshot.planRevision = 99;
    delete snapshot.deliveryPolicy;
    record.executionPolicySnapshot = { ...STRICT };
  }

  it('S1 persists exactly the snapshot it was given, detached from the input and from the returned record', async () => {
    const input = { ...SNAP };
    const opened = await openAttempt(h.state, { ...base, id: 'attempt-a', executionPolicySnapshot: input });

    expect(opened.executionPolicySnapshot).toEqual(SNAP);
    expectStored('attempt-a');
    const bytes = fileBytes('attempt-a');

    (input as unknown as Record<string, unknown>).profile = 'verified-local';
    expectStored('attempt-a');
    vandalize(opened);
    expectStored('attempt-a');
    expect(getAttempt(h.state, 'attempt-a')!.executionPolicySnapshot).toEqual(SNAP);
    expect(fileBytes('attempt-a')).toBe(bytes);
  });

  it.each([
    ['null', null],
    ['an extra key', { ...SNAP, trusted: true }],
    ['version 3', { ...SNAP, version: 3 }],
    ['v2 without deliveryPolicy', { version: 2, profile: 'observe', planRevision: 4 }],
    ['planRevision -1', { ...SNAP, planRevision: -1 }],
  ])('S2 refuses a malformed snapshot (%s) before any write, consuming no generation', async (_label, bad) => {
    await expect(
      openAttempt(h.state, { ...base, id: 'attempt-bad', executionPolicySnapshot: bad as unknown as ExecutionPolicySnapshot })
    ).rejects.toThrow(/\[INVALID_INPUT\] Invalid executionPolicySnapshot/);

    expect(h.state.attempts.size).toBe(0);
    expect(attemptFiles()).toEqual([]);
    const next = await openAttempt(h.state, { ...base, id: 'attempt-ok', executionPolicySnapshot: SNAP });
    expect(next.generation).toBe(1);
  });

  it('S3 without the param writes the exact legacy record, even for a task that does not exist', async () => {
    const opened = await openAttempt(h.state, { ...base, taskId: 'task-ghost', id: 'attempt-a' });

    expect(Object.keys(readAttempt('attempt-a')).sort()).toEqual(LEGACY_KEYS);
    expect(hasOwnSnapshot(opened)).toBe(false);
    expect(hasOwnSnapshot(h.state.attempts.get('attempt-a'))).toBe(false);
    expect(opened).toEqual(readAttempt('attempt-a'));
  });

  it('S4 a same-id repair returns the persisted record and never adopts the new snapshot', async () => {
    const first = await openAttempt(h.state, { ...base, id: 'attempt-a', executionPolicySnapshot: SNAP });
    const bytes = fileBytes('attempt-a');

    const repaired = await openAttempt(h.state, { ...base, id: 'attempt-a', executionPolicySnapshot: STRICT });

    expect(repaired).toEqual(first);
    expect(repaired.executionPolicySnapshot).toEqual(SNAP);
    expect(repaired.generation).toBe(1);
    expect(fileBytes('attempt-a')).toBe(bytes);
    expectStored('attempt-a');
    expect(attemptFiles()).toEqual(['attempt-a.json']);
  });

  // Every exported function that hands out an attempt, each returning attempt-a.
  const RETURNERS: Array<[string, () => Promise<ExecutionAttempt | null | undefined>]> = [
    ['openAttempt (repair)', () => openAttempt(h.state, { ...base, id: 'attempt-a' })],
    ['getAttempt', async () => getAttempt(h.state, 'attempt-a')],
    ['listAttempts (scoped)', async () => listAttempts(h.state, 'task-1')[0]],
    ['listAttempts (unscoped)', async () => listAttempts(h.state).find((a) => a.id === 'attempt-a')],
    ['currentAttempt', async () => currentAttempt(h.state, 'task-1')],
    ['setAttemptPhase (change)', () => setAttemptPhase(h.state, 'attempt-a', 'finalizing')],
    ['setAttemptPhase (no-op)', () => setAttemptPhase(h.state, 'attempt-a', 'running')],
    ['recordAttemptPresence', () => recordAttemptPresence(h.state, 'attempt-a', 'process')],
    ['closeOpenAttempts', async () => (await closeOpenAttempts(h.state, 'task-1'))[0]],
    ['closeHandedBackAttempts', async () => (await closeHandedBackAttempts(h.state, 'task-1'))[0]],
    ['reconcileRunningAttempts', async () => (await reconcileRunningAttempts(h.state))[0]],
  ];

  it.each(RETURNERS)('S5 %s hands out a detached snapshot and carries it into any record it writes', async (_name, call) => {
    await openAttempt(h.state, { ...base, id: 'attempt-a', executionPolicySnapshot: SNAP });

    const returned = (await call())!;

    expect(returned.id).toBe('attempt-a');
    expect(returned.executionPolicySnapshot).toEqual(SNAP);
    expect(returned).toEqual(readAttempt('attempt-a'));
    expectStored('attempt-a');
    const bytes = fileBytes('attempt-a');
    vandalize(returned);
    expectStored('attempt-a');
    expect(fileBytes('attempt-a')).toBe(bytes);
  });

  it.each(RETURNERS)('S5 %s returns a record opened without a snapshot exactly as before', async (_name, call) => {
    await openAttempt(h.state, { ...base, id: 'attempt-a' });

    const returned = (await call())!;

    expect(returned.id).toBe('attempt-a');
    expect(hasOwnSnapshot(returned)).toBe(false);
    expect(hasOwnSnapshot(h.state.attempts.get('attempt-a'))).toBe(false);
    expect(returned).toEqual(readAttempt('attempt-a'));
    expect(Object.keys(readAttempt('attempt-a')).every((key) => key !== 'executionPolicySnapshot')).toBe(true);
  });

  it('S5 two reads hand out distinct snapshot objects', async () => {
    await openAttempt(h.state, { ...base, id: 'attempt-a', executionPolicySnapshot: SNAP });
    const reads = [
      getAttempt(h.state, 'attempt-a')!,
      getAttempt(h.state, 'attempt-a')!,
      listAttempts(h.state, 'task-1')[0],
      listAttempts(h.state)[0],
      currentAttempt(h.state, 'task-1')!,
    ].map((a) => a.executionPolicySnapshot);

    expect(new Set(reads).size).toBe(reads.length);
    expect(reads.includes(h.state.attempts.get('attempt-a')!.executionPolicySnapshot)).toBe(false);
  });

  it('S6 a restart reloads the snapshot unchanged and parking at startup keeps it', async () => {
    await openAttempt(h.state, { ...base, id: 'attempt-a', executionPolicySnapshot: SNAP });
    const restarted = new StateManager({ projectPath: h.testDir });
    await restarted.load();
    try {
      expect(getAttempt(restarted, 'attempt-a')!.executionPolicySnapshot).toEqual(SNAP);

      const parked = await reconcileRunningAttempts(restarted);

      expect(parked.map((a) => [a.id, a.phase])).toEqual([['attempt-a', 'reconciling']]);
      expect(parked[0].executionPolicySnapshot).toEqual(SNAP);
      expect(readAttempt('attempt-a').phase).toBe('reconciling');
      expect(readAttempt('attempt-a').executionPolicySnapshot).toEqual(SNAP);
    } finally {
      restarted.clearEmitter();
    }
  });

  it('S6 a hand-edited malformed snapshot never makes a read throw, and reads still detach it', async () => {
    await openAttempt(h.state, { ...base, id: 'attempt-a', executionPolicySnapshot: SNAP });
    const raw = { version: 3, nested: { trusted: true } };
    fs.writeFileSync(attemptFile('attempt-a'), JSON.stringify({ ...readAttempt('attempt-a'), executionPolicySnapshot: raw }));
    const restarted = new StateManager({ projectPath: h.testDir });
    await restarted.load();
    try {
      const reads = [
        getAttempt(restarted, 'attempt-a')!,
        listAttempts(restarted, 'task-1')[0],
        listAttempts(restarted)[0],
        currentAttempt(restarted, 'task-1')!,
      ];
      for (const read of reads) expect(read.executionPolicySnapshot).toEqual(raw);

      (reads[0].executionPolicySnapshot as unknown as typeof raw).nested.trusted = false;
      expect(restarted.attempts.get('attempt-a')!.executionPolicySnapshot).toEqual(raw);
    } finally {
      restarted.clearEmitter();
    }
  });

  it('S7 a failed write publishes no attempt, and the retry still gets generation 1 with the snapshot', async () => {
    vi.spyOn(h.state, 'writeEntity').mockRejectedValueOnce(new Error('Injected attempt write failure'));

    await expect(
      openAttempt(h.state, { ...base, id: 'attempt-a', executionPolicySnapshot: SNAP })
    ).rejects.toThrow('Injected attempt write failure');

    expect(getAttempt(h.state, 'attempt-a')).toBeNull();
    expect(h.state.attempts.size).toBe(0);
    expect(attemptFiles()).toEqual([]);
    const retry = await openAttempt(h.state, { ...base, id: 'attempt-a', executionPolicySnapshot: SNAP });
    expect(retry.generation).toBe(1);
    expectStored('attempt-a');
  });
});
