import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { ToolTestHarness } from '../tools/toolTestHarness.js';
import {
  getCandidate,
  listCandidatesForAttempt,
  listCandidatesForTask,
  recordCandidate,
  type RecordCandidateParams,
} from './candidateStore.js';
import { openAttempt, setAttemptPhase } from './attemptStore.js';
import { StateManager } from './StateManager.js';
import { MoeError } from '../util/errors.js';
import { CURRENT_SCHEMA_VERSION, type Candidate } from '../types/schema.js';

const SHA = { base: 'a1'.repeat(20), otherBase: 'b2'.repeat(20), treeA: 'c3'.repeat(20), treeB: 'd4'.repeat(20) };
const TARGET = 'refs/heads/wave1-pilot';
const T1 = '2026-09-11T03:00:00.000Z';
const T2 = '2026-09-11T03:05:00.000Z';
const T3 = '2026-09-11T03:10:00.000Z';

describe('candidateStore', () => {
  const h = new ToolTestHarness();

  beforeEach(async () => {
    h.init();
    h.setupMoeFolder({ schemaVersion: CURRENT_SCHEMA_VERSION });
    h.createEpic();
    h.createTask({ id: 'task-1', status: 'WORKING', assignedWorkerId: 'worker-1' });
    h.createTask({ id: 'task-2', status: 'WORKING', assignedWorkerId: 'worker-2' });
    await h.state.load();
    const attempt = { workerId: 'worker-1', runnerId: 'runner-1', workspace: 'D:/wt/a' };
    await openAttempt(h.state, { ...attempt, taskId: 'task-1', id: 'attempt-1a' });
    await openAttempt(h.state, { ...attempt, taskId: 'task-2', id: 'attempt-2a' });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    h.state.clearEmitter();
    h.cleanup();
  });

  const base: RecordCandidateParams = {
    attemptId: 'attempt-1a',
    taskId: 'task-1',
    baseRevision: SHA.base,
    treeSha: SHA.treeA,
    deliveryTarget: TARGET,
  };

  const candidatesDir = (): string => path.join(h.moePath, 'candidates');
  const candidateFile = (id: string): string => path.join(candidatesDir(), `${id}.json`);
  const candidateFiles = (): string[] =>
    fs.existsSync(candidatesDir()) ? fs.readdirSync(candidatesDir()).sort() : [];
  const readBytes = (id: string): Buffer => fs.readFileSync(candidateFile(id));
  const readCandidate = (id: string): Candidate => JSON.parse(readBytes(id).toString('utf8')) as Candidate;

  /** Date-only fake clock: faking timers would stall atomicWriteJsonAsync's rename retry. */
  function clockAt(iso: string): void {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(iso));
  }

  async function refusal(promise: Promise<unknown>): Promise<MoeError> {
    try {
      await promise;
    } catch (error) {
      if (error instanceof MoeError) return error;
      throw error;
    }
    throw new Error('expected a MoeError refusal, but the call succeeded');
  }

  /** resourceStore.durability.test.ts style: the first candidate write throws, later ones pass. */
  function failNextCandidateWrite(): void {
    const writeEntity = h.state.writeEntity.bind(h.state);
    let failed = false;
    vi.spyOn(h.state, 'writeEntity').mockImplementation(async (kind, id, entity) => {
      if (kind === 'candidates' && !failed) {
        failed = true;
        throw new Error('Injected candidate write failure');
      }
      await writeEntity(kind, id, entity);
    });
  }

  const ids = (candidates: Candidate[]): string[] => candidates.map((c) => c.id);

  // ---------------------------------------------------------------------------
  // recording and reading back
  // ---------------------------------------------------------------------------

  it('persists one file per candidate carrying exactly the frozen fields', async () => {
    clockAt(T1);
    const result = await recordCandidate(h.state, { ...base, id: 'cand-a' });

    const expected: Candidate = { id: 'cand-a', ...base, createdAt: T1 };
    expect(result).toEqual({ candidate: expected, duplicate: false });
    expect(readCandidate('cand-a')).toEqual(expected);
    expect(Object.keys(readCandidate('cand-a')).sort()).toEqual(
      ['attemptId', 'baseRevision', 'createdAt', 'deliveryTarget', 'id', 'taskId', 'treeSha']
    );
    expect(getCandidate(h.state, 'cand-a')).toEqual(expected);
    expect(candidateFiles()).toEqual(['cand-a.json']);
  });

  it('generates a fresh cand- id when the caller supplies none', async () => {
    const { candidate } = await recordCandidate(h.state, base);
    expect(candidate.id).toMatch(/^cand-[0-9a-f]{32}$/);
    expect(candidateFiles()).toEqual([`${candidate.id}.json`]);
    expect(readCandidate(candidate.id)).toEqual(candidate);
  });

  it('returns null for an unknown candidate and empty lists for unknown keys', () => {
    expect(getCandidate(h.state, 'cand-missing')).toBeNull();
    expect(listCandidatesForTask(h.state, 'task-unknown')).toEqual([]);
    expect(listCandidatesForAttempt(h.state, 'attempt-unknown')).toEqual([]);
  });

  it('lists by task and by attempt in createdAt-then-id order', async () => {
    clockAt(T1);
    await recordCandidate(h.state, { ...base, id: 'cand-z' });
    await setAttemptPhase(h.state, 'attempt-1a', 'closed');
    await openAttempt(h.state, { taskId: 'task-1', workerId: 'w', runnerId: 'r', workspace: 'D:/wt/b', id: 'attempt-1b' });
    clockAt(T2);
    // Inserted m before b with an identical createdAt: only the id tiebreak orders them.
    await recordCandidate(h.state, { ...base, attemptId: 'attempt-1b', id: 'cand-m', treeSha: SHA.treeB });
    await recordCandidate(h.state, { ...base, attemptId: 'attempt-1b', id: 'cand-b', treeSha: SHA.treeA });
    clockAt(T3);
    await recordCandidate(h.state, { ...base, taskId: 'task-2', attemptId: 'attempt-2a', id: 'cand-a' });

    expect(ids(listCandidatesForTask(h.state, 'task-1'))).toEqual(['cand-z', 'cand-b', 'cand-m']);
    expect(ids(listCandidatesForTask(h.state, 'task-2'))).toEqual(['cand-a']);
    expect(ids(listCandidatesForAttempt(h.state, 'attempt-1a'))).toEqual(['cand-z']);
    expect(ids(listCandidatesForAttempt(h.state, 'attempt-1b'))).toEqual(['cand-b', 'cand-m']);
    expect(ids(listCandidatesForAttempt(h.state, 'attempt-2a'))).toEqual(['cand-a']);
  });

  // ---------------------------------------------------------------------------
  // immutability
  // ---------------------------------------------------------------------------

  const changedValue: Record<keyof Omit<RecordCandidateParams, 'id'>, string> = {
    attemptId: 'attempt-2a',
    taskId: 'task-2',
    baseRevision: SHA.otherBase,
    treeSha: SHA.treeB,
    deliveryTarget: 'refs/heads/elsewhere',
  };

  for (const field of Object.keys(changedValue) as Array<keyof typeof changedValue>) {
    it(`refuses a same-id record whose ${field} differs and leaves the stored bytes untouched`, async () => {
      await recordCandidate(h.state, { ...base, id: 'cand-a' });
      const bytesBefore = readBytes('cand-a');
      const inMemoryBefore = getCandidate(h.state, 'cand-a');

      const error = await refusal(
        recordCandidate(h.state, { ...base, id: 'cand-a', [field]: changedValue[field] })
      );

      expect(error.code).toBe(-32002);
      expect(error.codeName).toBe('CANDIDATE_IMMUTABLE');
      expect(error.message).toContain(`differs in ${field}`);
      expect(error.message).toContain('a changed tree needs a new candidate id');
      expect(error.context).toEqual({ candidateId: 'cand-a', differingFields: [field] });
      expect(readBytes('cand-a').equals(bytesBefore)).toBe(true);
      expect(getCandidate(h.state, 'cand-a')).toEqual(inMemoryBefore);
      expect(candidateFiles()).toEqual(['cand-a.json']);
    });
  }

  it('replays a byte-identical re-record idempotently: stored record back, nothing written', async () => {
    clockAt(T1);
    const first = await recordCandidate(h.state, { ...base, id: 'cand-a' });
    const bytesBefore = readBytes('cand-a');
    clockAt(T2);
    const write = vi.spyOn(h.state, 'writeEntity');

    const replay = await recordCandidate(h.state, { ...base, id: 'cand-a' });

    expect(replay).toEqual({ candidate: first.candidate, duplicate: true });
    expect(replay.candidate.createdAt).toBe(T1);
    expect(write).not.toHaveBeenCalled();
    expect(readBytes('cand-a').equals(bytesBefore)).toBe(true);
    expect(candidateFiles()).toEqual(['cand-a.json']);
  });

  it('records a changed tree as a NEW candidate and keeps the old one intact', async () => {
    const first = await recordCandidate(h.state, { ...base, id: 'cand-a' });
    const bytesBefore = readBytes('cand-a');

    const second = await recordCandidate(h.state, { ...base, id: 'cand-b', treeSha: SHA.treeB });

    expect(second.duplicate).toBe(false);
    expect(second.candidate.treeSha).toBe(SHA.treeB);
    expect(readBytes('cand-a').equals(bytesBefore)).toBe(true);
    expect(getCandidate(h.state, 'cand-a')).toEqual(first.candidate);
    expect(ids(listCandidatesForTask(h.state, 'task-1')).sort()).toEqual(['cand-a', 'cand-b']);
    expect(candidateFiles()).toEqual(['cand-a.json', 'cand-b.json']);
  });

  it('hands out copies, so no caller can edit a stored candidate in memory', async () => {
    // The fields are readonly in the type; the casts model a caller that edits anyway.
    const { candidate } = await recordCandidate(h.state, { ...base, id: 'cand-a' });
    (candidate as { treeSha: string }).treeSha = SHA.treeB;
    (getCandidate(h.state, 'cand-a') as { treeSha: string }).treeSha = SHA.treeB;
    (listCandidatesForTask(h.state, 'task-1')[0] as { treeSha: string }).treeSha = SHA.treeB;
    (listCandidatesForAttempt(h.state, 'attempt-1a')[0] as { treeSha: string }).treeSha = SHA.treeB;

    expect(getCandidate(h.state, 'cand-a')!.treeSha).toBe(SHA.treeA);
    expect(h.state.candidates.get('cand-a')!.treeSha).toBe(SHA.treeA);
  });

  it('exports no update, patch or delete path at all', async () => {
    const store = await import('./candidateStore.js');
    expect(Object.keys(store).sort()).toEqual([
      'getCandidate',
      'listCandidatesForAttempt',
      'listCandidatesForTask',
      'recordCandidate',
      'validateCandidateParams',
    ]);
  });

  // ---------------------------------------------------------------------------
  // attempt binding
  // ---------------------------------------------------------------------------

  it('refuses an attempt id that names no attempt, without writing', async () => {
    const error = await refusal(recordCandidate(h.state, { ...base, id: 'cand-a', attemptId: 'attempt-ghost' }));
    expect(error.code).toBe(-32001);
    expect(error.codeName).toBe('ATTEMPT_NOT_FOUND');
    expect(h.state.candidates.size).toBe(0);
    expect(candidateFiles()).toEqual([]);
  });

  it("refuses another task's attempt, without writing", async () => {
    const error = await refusal(recordCandidate(h.state, { ...base, id: 'cand-a', attemptId: 'attempt-2a' }));
    expect(error.code).toBe(-32002);
    expect(error.codeName).toBe('ATTEMPT_ID_TASK_MISMATCH');
    expect(error.context).toEqual({ attemptId: 'attempt-2a', existingTaskId: 'task-2', requestedTaskId: 'task-1' });
    expect(h.state.candidates.size).toBe(0);
    expect(candidateFiles()).toEqual([]);
  });

  // ---------------------------------------------------------------------------
  // input refusals — validated, never coerced, never written
  // ---------------------------------------------------------------------------

  const malformed: Array<[string, Partial<Record<keyof RecordCandidateParams, unknown>>, string, string]> = [
    ['a blank attemptId', { attemptId: '   ' }, 'INVALID_INPUT', 'Invalid attemptId'],
    ['a blank taskId', { taskId: '' }, 'INVALID_INPUT', 'Invalid taskId'],
    ['a blank deliveryTarget', { deliveryTarget: '  ' }, 'INVALID_INPUT', 'Invalid deliveryTarget'],
    ['a padded deliveryTarget', { deliveryTarget: ` ${TARGET}` }, 'INVALID_INPUT', 'Invalid deliveryTarget'],
    ['a deliveryTarget with a newline', { deliveryTarget: `${TARGET}\nX` }, 'INVALID_INPUT', 'Invalid deliveryTarget'],
    ['a deliveryTarget with a NUL', { deliveryTarget: `${TARGET}${String.fromCharCode(0)}` }, 'INVALID_INPUT', 'Invalid deliveryTarget'],
    ['a deliveryTarget with a DEL', { deliveryTarget: `${TARGET}${String.fromCharCode(0x7f)}` }, 'INVALID_INPUT', 'Invalid deliveryTarget'],
    ['an over-long deliveryTarget', { deliveryTarget: `refs/heads/${'x'.repeat(250)}` }, 'INVALID_INPUT', 'Invalid deliveryTarget'],
    ['a non-hex treeSha', { treeSha: 'g'.repeat(40) }, 'INVALID_INPUT', 'Invalid treeSha'],
    ['a 6-char treeSha', { treeSha: 'abc123' }, 'INVALID_INPUT', 'Invalid treeSha'],
    ['a 41-char treeSha', { treeSha: 'a'.repeat(41) }, 'INVALID_INPUT', 'Invalid treeSha'],
    ['a numeric treeSha', { treeSha: 1234567 }, 'INVALID_INPUT', 'Invalid treeSha'],
    ['a non-sha baseRevision', { baseRevision: 'main' }, 'INVALID_INPUT', 'Invalid baseRevision'],
    ['an id with a path separator', { id: '../../escaped' }, 'INVALID_INPUT', 'Invalid id'],
    ['a null id', { id: null }, 'INVALID_INPUT', 'Invalid id'],
    ['a missing treeSha', { treeSha: undefined }, 'MISSING_REQUIRED', 'Missing required field: treeSha'],
    ['a null attemptId', { attemptId: null }, 'MISSING_REQUIRED', 'Missing required field: attemptId'],
    ['a missing deliveryTarget', { deliveryTarget: undefined }, 'MISSING_REQUIRED', 'Missing required field: deliveryTarget'],
  ];

  for (const [label, override, codeName, messagePart] of malformed) {
    it(`refuses ${label} without writing`, async () => {
      const params = { ...base, id: 'cand-a', ...override } as unknown as RecordCandidateParams;
      const error = await refusal(recordCandidate(h.state, params));
      expect(error.code).toBe(-32602);
      expect(error.codeName).toBe(codeName);
      expect(error.message).toContain(messagePart);
      expect(h.state.candidates.size).toBe(0);
      expect(candidateFiles()).toEqual([]);
      expect(fs.existsSync(path.join(h.testDir, 'escaped.json'))).toBe(false);
    });
  }

  // ---------------------------------------------------------------------------
  // durability and reload
  // ---------------------------------------------------------------------------

  it('exposes no candidate anywhere when the write fails, and a retry then records it', async () => {
    failNextCandidateWrite();
    await expect(recordCandidate(h.state, { ...base, id: 'cand-a' })).rejects.toThrow(
      'Injected candidate write failure'
    );
    expect(getCandidate(h.state, 'cand-a')).toBeNull();
    expect(listCandidatesForTask(h.state, 'task-1')).toEqual([]);
    expect(listCandidatesForAttempt(h.state, 'attempt-1a')).toEqual([]);
    expect(candidateFiles()).toEqual([]);

    const retried = await recordCandidate(h.state, { ...base, id: 'cand-a' });
    expect(retried.duplicate).toBe(false);
    expect(readCandidate('cand-a')).toEqual(retried.candidate);
  });

  it('loads persisted candidates into a fresh StateManager after a restart', async () => {
    const a = await recordCandidate(h.state, { ...base, id: 'cand-a' });
    const b = await recordCandidate(h.state, { ...base, id: 'cand-b', treeSha: SHA.treeB });

    const restarted = new StateManager({ projectPath: h.testDir });
    await restarted.load();
    try {
      expect(restarted.candidates.size).toBe(2);
      expect(getCandidate(restarted, 'cand-a')).toEqual(a.candidate);
      expect(listCandidatesForTask(restarted, 'task-1')).toEqual(
        listCandidatesForTask(h.state, 'task-1')
      );
      // Immutability survives the restart: the reloaded record still refuses an edit.
      const error = await refusal(recordCandidate(restarted, { ...base, id: 'cand-b', treeSha: SHA.treeA }));
      expect(error.code).toBe(-32002);
      expect(error.codeName).toBe('CANDIDATE_IMMUTABLE');
      expect(readCandidate('cand-b')).toEqual(b.candidate);
    } finally {
      restarted.clearEmitter();
    }
  });

  it('loads an empty map for a project that has never recorded a candidate', () => {
    expect(h.state.candidates.size).toBe(0);
    expect(fs.existsSync(candidatesDir())).toBe(false);
  });
});
