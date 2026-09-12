import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { ToolTestHarness } from './toolTestHarness.js';
import { recordCandidateTool } from './recordCandidate.js';
import { getTools } from './index.js';
import { openAttempt, setAttemptPhase } from '../state/attemptStore.js';
import { MoeError } from '../util/errors.js';
import { CURRENT_SCHEMA_VERSION, type Candidate } from '../types/schema.js';

const SHA = { base: 'a1'.repeat(20), treeA: 'c3'.repeat(20), treeB: 'd4'.repeat(20) };
const TARGET = 'refs/heads/wave1-pilot';
const T1 = '2026-09-11T03:00:00.000Z';
const T2 = '2026-09-11T03:05:00.000Z';
const toolsDir = path.dirname(fileURLToPath(import.meta.url));

interface RecordCandidateResponse {
  success: boolean;
  candidate: Candidate;
  duplicate: boolean;
}

describe('moe.record_candidate', () => {
  const h = new ToolTestHarness();

  beforeEach(async () => {
    h.init();
    h.setupMoeFolder({ schemaVersion: CURRENT_SCHEMA_VERSION });
    h.createEpic();
    h.createTask({ id: 'task-1', status: 'WORKING', assignedWorkerId: 'worker-1' });
    h.createTask({ id: 'task-legacy', status: 'WORKING', assignedWorkerId: 'worker-2' });
    h.createTask({ id: 'task-review', status: 'REVIEW', assignedWorkerId: 'qa-1' });
    h.createWorker({ id: 'worker-1', status: 'CODING', currentTaskId: 'task-1' });
    await h.state.load();
    // attempt-1 (generation 1) was superseded and closed; attempt-2 (generation 2) is current.
    const attempt = { taskId: 'task-1', workerId: 'worker-1', runnerId: 'runner-1', workspace: 'D:/wt' };
    await openAttempt(h.state, { ...attempt, id: 'attempt-1' });
    await setAttemptPhase(h.state, 'attempt-1', 'closed');
    await openAttempt(h.state, { ...attempt, id: 'attempt-2' });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    h.state.clearEmitter();
    h.cleanup();
  });

  const args = {
    id: 'cand-1',
    taskId: 'task-1',
    attemptId: 'attempt-2',
    generation: 2,
    workerId: 'worker-1',
    baseRevision: SHA.base,
    treeSha: SHA.treeA,
    deliveryTarget: TARGET,
  };

  const candidatesDir = (): string => path.join(h.moePath, 'candidates');
  const candidateFile = (id: string): string => path.join(candidatesDir(), `${id}.json`);

  async function call(overrides: Record<string, unknown> = {}): Promise<RecordCandidateResponse> {
    return (await recordCandidateTool(h.state).handler({ ...args, ...overrides }, h.state)) as RecordCandidateResponse;
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

  /** Date-only fake clock: faking timers would stall atomicWriteJsonAsync's rename retry. */
  function clockAt(iso: string): void {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(iso));
  }

  /** Nothing may reach disk: the refusal must come before the write, not after it. */
  function expectNothingWritten(write: ReturnType<typeof vi.spyOn>): void {
    expect(write).not.toHaveBeenCalled();
    expect(fs.existsSync(candidatesDir())).toBe(false);
    expect(h.state.candidates.size).toBe(0);
  }

  it('is registered in getTools() and stays non-blocking, so dispatch serializes it', () => {
    const tool = getTools(h.state).find((t) => t.name === 'moe.record_candidate');
    expect(tool).toBeDefined();
    expect(tool!.blocking ?? false).toBe(false);
  });

  it('records the candidate for the current attempt and returns the stored record', async () => {
    clockAt(T1);
    const result = await call();

    const expected: Candidate = {
      id: 'cand-1',
      attemptId: 'attempt-2',
      taskId: 'task-1',
      baseRevision: SHA.base,
      treeSha: SHA.treeA,
      deliveryTarget: TARGET,
      createdAt: T1,
    };
    expect(result).toEqual({ success: true, candidate: expected, duplicate: false });
    // generation and workerId are fencing inputs of the call, not part of the record.
    expect(JSON.parse(fs.readFileSync(candidateFile('cand-1'), 'utf8'))).toEqual(expected);
  });

  it('has no ownership or status gate: the runner records after QA already holds the REVIEW task', async () => {
    const attempt = { taskId: 'task-review', workerId: 'worker-1', runnerId: 'runner-1', workspace: 'D:/wt' };
    await openAttempt(h.state, { ...attempt, id: 'attempt-r1' });
    await setAttemptPhase(h.state, 'attempt-r1', 'finalizing');

    const result = await call({ id: 'cand-r', taskId: 'task-review', attemptId: 'attempt-r1', generation: 1 });

    expect(result.duplicate).toBe(false);
    expect(result.candidate.taskId).toBe('task-review');
    expect(fs.existsSync(candidateFile('cand-r'))).toBe(true);
  });

  it('accepts the current attempt id without a generation', async () => {
    const result = await call({ generation: undefined });
    expect(result.candidate.attemptId).toBe('attempt-2');
    expect(fs.existsSync(candidateFile('cand-1'))).toBe(true);
  });

  const superseded: Array<[string, Record<string, unknown>, () => Promise<void>]> = [
    ['a superseded attempt id', { attemptId: 'attempt-1', generation: 1 }, async () => {}],
    ['a stale generation on the current attempt id', { attemptId: 'attempt-2', generation: 1 }, async () => {}],
    ['a future generation on the current attempt id', { attemptId: 'attempt-2', generation: 3 }, async () => {}],
    ['an attempt that has since closed', {}, async () => { await setAttemptPhase(h.state, 'attempt-2', 'closed'); }],
  ];

  for (const [label, overrides, arrange] of superseded) {
    it(`refuses ${label} through the fencing guard and writes nothing`, async () => {
      await arrange();
      const write = vi.spyOn(h.state, 'writeEntity');

      const error = await refusal(call(overrides));

      expect(error.code).toBe(-32002);
      expect(error.codeName).toBe('ATTEMPT_SUPERSEDED');
      expect(error.message).toContain('moe.record_candidate');
      expectNothingWritten(write);
    });
  }

  it('refuses an unknown task before fencing or writing', async () => {
    const write = vi.spyOn(h.state, 'writeEntity');
    const error = await refusal(call({ taskId: 'task-ghost' }));
    expect(error.code).toBe(-32001);
    expect(error.codeName).toBe('TASK_NOT_FOUND');
    expectNothingWritten(write);
  });

  it('refuses an attempt the task never opened, even where the guard tolerates a legacy task', async () => {
    const write = vi.spyOn(h.state, 'writeEntity');
    // task-legacy has no attempt record, so assertAttemptCurrent lets the call through;
    // the store still refuses a candidate that names no attempt.
    const error = await refusal(call({ taskId: 'task-legacy', attemptId: 'attempt-ghost', generation: undefined }));
    expect(error.code).toBe(-32001);
    expect(error.codeName).toBe('ATTEMPT_NOT_FOUND');
    expectNothingWritten(write);
  });

  const malformed: Array<[string, unknown, string]> = [
    ['a malformed treeSha', { ...args, treeSha: 'not-a-sha' }, 'INVALID_INPUT'],
    ['a blank deliveryTarget', { ...args, deliveryTarget: '' }, 'INVALID_INPUT'],
    ['a zero generation', { ...args, generation: 0 }, 'INVALID_INPUT'],
    ['a string generation', { ...args, generation: '2' }, 'INVALID_INPUT'],
    ['a null generation', { ...args, generation: null }, 'INVALID_INPUT'],
    ['a malformed sha on a superseded attempt', { ...args, attemptId: 'attempt-1', treeSha: 'xyz' }, 'INVALID_INPUT'],
    ['non-object arguments', 'cand-1', 'INVALID_INPUT'],
    ['a missing attemptId', { ...args, attemptId: undefined }, 'MISSING_REQUIRED'],
  ];

  for (const [label, rawArgs, codeName] of malformed) {
    it(`refuses ${label} as ${codeName} without coercing or writing`, async () => {
      const write = vi.spyOn(h.state, 'writeEntity');
      const error = await refusal(recordCandidateTool(h.state).handler(rawArgs, h.state));
      expect(error.code).toBe(-32602);
      expect(error.codeName).toBe(codeName);
      expectNothingWritten(write);
    });
  }

  it('replays a byte-identical re-record idempotently, so a crash retry is safe', async () => {
    clockAt(T1);
    const first = await call();
    const bytesBefore = fs.readFileSync(candidateFile('cand-1'));
    clockAt(T2);

    const replay = await call();

    expect(replay).toEqual({ success: true, candidate: first.candidate, duplicate: true });
    expect(fs.readFileSync(candidateFile('cand-1')).equals(bytesBefore)).toBe(true);
  });

  it('refuses a changed tree under an existing id as CANDIDATE_IMMUTABLE', async () => {
    await call();
    const bytesBefore = fs.readFileSync(candidateFile('cand-1'));

    const error = await refusal(call({ treeSha: SHA.treeB }));

    expect(error.code).toBe(-32002);
    expect(error.codeName).toBe('CANDIDATE_IMMUTABLE');
    expect(fs.readFileSync(candidateFile('cand-1')).equals(bytesBefore)).toBe(true);
    // The same change under a NEW id is simply a new candidate.
    const next = await call({ id: 'cand-2', treeSha: SHA.treeB });
    expect(next.duplicate).toBe(false);
    expect(fs.readdirSync(candidatesDir()).sort()).toEqual(['cand-1.json', 'cand-2.json']);
  });

  it('never shells out: no child process in the tool or its store', () => {
    for (const file of ['recordCandidate.ts', path.join('..', 'state', 'candidateStore.ts')]) {
      const source = fs.readFileSync(path.join(toolsDir, file), 'utf8');
      expect(source, file).not.toMatch(/child_process|\bexec(Sync|File|FileSync)?\(|\bspawn(Sync)?\(/);
    }
  });
});
