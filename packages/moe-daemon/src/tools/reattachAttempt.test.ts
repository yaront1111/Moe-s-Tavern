import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { ToolTestHarness } from './toolTestHarness.js';
import { reattachAttemptTool } from './reattachAttempt.js';
import { getTools } from './index.js';
import { openAttempt, setAttemptPhase } from '../state/attemptStore.js';
import { MoeError } from '../util/errors.js';
import type { ExecutionAttempt } from '../types/schema.js';

// =============================================================================
// moe.reattach_attempt, at the unit level.
//
// The end-to-end proof is delivery/acceptance.test.ts's restart case (a real
// daemon child, a real long-running process, a real SIGKILL). These cases pin
// what that one cannot reach cheaply: input validation, the by-name refusals,
// and that EVERY refusal is byte-pure on the attempt file.
// =============================================================================

describe('moe.reattach_attempt', () => {
  const h = new ToolTestHarness();
  const STARTED_AT = '2026-09-11T09:15:30.123Z';
  const HOST = 'build-box-7';

  beforeEach(async () => {
    h.init();
    h.setupMoeFolder({ schemaVersion: 6 });
    h.createEpic();
    h.createTask({ id: 'task-L', status: 'WORKING', assignedWorkerId: 'worker-W' });
    h.createTask({ id: 'task-M', status: 'WORKING', assignedWorkerId: 'worker-M' });
    h.createWorker({ id: 'worker-W', status: 'CODING', currentTaskId: 'task-L' });
    await h.state.load();
  });

  afterEach(() => {
    h.state.clearEmitter();
    h.cleanup();
  });

  const tool = () => reattachAttemptTool(h.state);

  const identity = {
    taskId: 'task-L',
    workerId: 'worker-W',
    runnerId: 'runner-pilot',
    attemptId: 'attempt-L-1',
    generation: 1,
    processStartedAt: STARTED_AT,
    host: HOST,
  };

  function attemptFile(id: string): string {
    return path.join(h.moePath, 'attempts', `${id}.json`);
  }

  function readAttempt(id: string): ExecutionAttempt {
    return JSON.parse(fs.readFileSync(attemptFile(id), 'utf8')) as ExecutionAttempt;
  }

  /** A reconciling attempt with the full identity recorded, as a restart leaves it. */
  async function seedReconciling(): Promise<ExecutionAttempt> {
    const attempt = await openAttempt(h.state, {
      id: 'attempt-L-1',
      taskId: 'task-L',
      workerId: 'worker-W',
      runnerId: 'runner-pilot',
      workspace: h.testDir,
      processStartedAt: STARTED_AT,
      host: HOST,
    });
    return setAttemptPhase(h.state, attempt.id, 'reconciling');
  }

  async function refusal(args: Record<string, unknown>): Promise<MoeError> {
    const err = await tool()
      .handler(args, h.state)
      .then(
        () => {
          throw new Error('expected a MoeError refusal, but the call resolved');
        },
        (e: unknown) => e
      );
    expect(err).toBeInstanceOf(MoeError);
    return err as MoeError;
  }

  it('is registered in getTools and is not marked blocking', () => {
    const registered = getTools(h.state).find((t) => t.name === 'moe.reattach_attempt');
    expect(registered).toBeDefined();
    // A blocking tool skips the dispatch mutex and would freeze the fleet if it
    // ever parked; this one never parks.
    expect(registered?.blocking).toBeUndefined();
  });

  it('returns a reconciling attempt to running without touching the task or the worker', async () => {
    await seedReconciling();
    const taskBefore = fs.readFileSync(path.join(h.moePath, 'tasks', 'task-L.json'), 'utf8');
    const workerBefore = fs.readFileSync(path.join(h.moePath, 'workers', 'worker-W.json'), 'utf8');

    const result = (await tool().handler({ ...identity }, h.state)) as Record<string, unknown>;

    expect(result.success).toBe(true);
    expect(result.phase).toBe('running');
    expect(result.generation).toBe(1);
    expect(readAttempt('attempt-L-1').phase).toBe('running');
    // The hold's whole claim is that neither of these ever moved.
    expect(fs.readFileSync(path.join(h.moePath, 'tasks', 'task-L.json'), 'utf8')).toBe(taskBefore);
    expect(fs.readFileSync(path.join(h.moePath, 'workers', 'worker-W.json'), 'utf8')).toBe(workerBefore);
  });

  it('is a byte-identical no-op on an already-running attempt', async () => {
    await seedReconciling();
    await tool().handler({ ...identity }, h.state);
    const bytes = fs.readFileSync(attemptFile('attempt-L-1'), 'utf8');

    const repeat = (await tool().handler({ ...identity }, h.state)) as Record<string, unknown>;

    expect(repeat.success).toBe(true);
    expect(repeat.phase).toBe('running');
    expect(fs.readFileSync(attemptFile('attempt-L-1'), 'utf8')).toBe(bytes);
    expect(fs.readdirSync(path.join(h.moePath, 'attempts')).sort()).toEqual(['attempt-L-1.json']);
  });

  it.each([
    ['processStartedAt', { processStartedAt: '2026-09-11T09:14:30.123Z' }],
    ['host', { host: 'other-box' }],
    ['generation', { generation: 2 }],
  ])('refuses a %s that differs, writing nothing', async (_field, override) => {
    await seedReconciling();
    const bytes = fs.readFileSync(attemptFile('attempt-L-1'), 'utf8');

    const err = await refusal({ ...identity, ...override });

    expect(err.code).toBe(-32002);
    expect(err.codeName).toBe('ATTEMPT_IDENTITY_MISMATCH');
    expect(err.message).toContain('attempt-L-1');
    expect(fs.readFileSync(attemptFile('attempt-L-1'), 'utf8')).toBe(bytes);
    expect(readAttempt('attempt-L-1').phase).toBe('reconciling');
  });

  it('compares the recorded start time as an exact string, not as a date', async () => {
    await seedReconciling();

    // The same instant, re-serialised: a Date-parsing comparison would accept it.
    const err = await refusal({ ...identity, processStartedAt: '2026-09-11T12:15:30.123+03:00' });

    expect(err.codeName).toBe('ATTEMPT_IDENTITY_MISMATCH');
    expect(readAttempt('attempt-L-1').phase).toBe('reconciling');
  });

  it('refuses an attempt that recorded no process start time', async () => {
    const attempt = await openAttempt(h.state, {
      id: 'attempt-L-1',
      taskId: 'task-L',
      workerId: 'worker-W',
      runnerId: 'runner-pilot',
      workspace: h.testDir,
    });
    await setAttemptPhase(h.state, attempt.id, 'reconciling');

    const err = await refusal({ ...identity });

    expect(err.codeName).toBe('ATTEMPT_IDENTITY_MISMATCH');
    expect(readAttempt('attempt-L-1').phase).toBe('reconciling');
  });

  it('does NOT compare workerId or runnerId: claim_next_task records runnerId = workerId', async () => {
    // A real claim-opened attempt stores runnerId = workerId, so comparing the
    // runner's own id would refuse every genuine reattach. Pinned so nobody
    // "tightens" the identity into something no runner can satisfy.
    await openAttempt(h.state, {
      id: 'attempt-L-1',
      taskId: 'task-L',
      workerId: 'worker-W',
      runnerId: 'worker-W',
      workspace: h.testDir,
      processStartedAt: STARTED_AT,
      host: HOST,
    });
    await setAttemptPhase(h.state, 'attempt-L-1', 'reconciling');

    const result = (await tool().handler(
      { ...identity, runnerId: 'runner-session-42' },
      h.state
    )) as Record<string, unknown>;

    expect(result.phase).toBe('running');
  });

  it('refuses an unknown attempt by name', async () => {
    const err = await refusal({ ...identity, attemptId: 'attempt-nope' });
    expect(err.codeName).toBe('ATTEMPT_NOT_FOUND');
  });

  it('refuses an attempt that belongs to another task', async () => {
    await seedReconciling();
    const err = await refusal({ ...identity, taskId: 'task-M' });
    expect(err.codeName).toBe('ATTEMPT_ID_TASK_MISMATCH');
    expect(readAttempt('attempt-L-1').phase).toBe('reconciling');
  });

  it.each([
    ['finalizing' as const],
    ['closed' as const],
  ])('refuses a %s attempt as not reattachable', async (phase) => {
    const attempt = await openAttempt(h.state, {
      id: 'attempt-L-1',
      taskId: 'task-L',
      workerId: 'worker-W',
      runnerId: 'runner-pilot',
      workspace: h.testDir,
      processStartedAt: STARTED_AT,
      host: HOST,
    });
    if (phase === 'closed') await setAttemptPhase(h.state, attempt.id, 'finalizing');
    await setAttemptPhase(h.state, attempt.id, phase);
    const bytes = fs.readFileSync(attemptFile('attempt-L-1'), 'utf8');

    const err = await refusal({ ...identity });

    expect(err.codeName).toBe('ATTEMPT_NOT_REATTACHABLE');
    expect(fs.readFileSync(attemptFile('attempt-L-1'), 'utf8')).toBe(bytes);
  });

  it.each(['taskId', 'workerId', 'runnerId', 'attemptId', 'processStartedAt', 'host'])(
    'refuses a missing %s as invalid input',
    async (field) => {
      await seedReconciling();
      const args: Record<string, unknown> = { ...identity };
      delete args[field];

      const err = await refusal(args);

      expect(err.code).toBe(-32602);
      expect(readAttempt('attempt-L-1').phase).toBe('reconciling');
    }
  );

  it('refuses a non-integer generation as invalid input', async () => {
    await seedReconciling();
    const err = await refusal({ ...identity, generation: 1.5 });
    expect(err.code).toBe(-32602);
    expect(readAttempt('attempt-L-1').phase).toBe('reconciling');
  });
});
