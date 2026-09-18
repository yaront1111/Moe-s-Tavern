import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { ToolTestHarness } from './toolTestHarness.js';
import { reattachAttemptTool } from './reattachAttempt.js';
import { claimNextTaskTool } from './claimNextTask.js';
import { getTools } from './index.js';
import { StateManager } from '../state/StateManager.js';
import { openAttempt, reconcileRunningAttempts, setAttemptPhase } from '../state/attemptStore.js';
import { checkReconcileWindow } from '../state/sweeps.js';
import { MoeError } from '../util/errors.js';
import type { ExecutionAttempt, Task } from '../types/schema.js';

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

// =============================================================================
// The restart path with no seeded attempt (task-bd799955). Every attempt here
// is opened by a real moe.claim_next_task carrying the runner's identity. A
// daemon-only restart then parks it, in the load, park and purge order index.ts
// runs, and only then does the runner come back. Before that card no claim
// recorded an identity, so no production attempt could ever be reattached:
// identityMismatch answered 'processStartedAt (none recorded)' for all of them.
// =============================================================================
describe('moe.reattach_attempt — an attempt a real claim opened, across a daemon-only restart', () => {
  const h = new ToolTestHarness();
  // Shaped like the ps1 wrapper's value, `<pid>@<round-trip UTC start>`: seven
  // fractional digits, which a Date round trip would cut to three.
  const STARTED_AT = '4242@2026-09-18T09:15:30.1234567Z';
  const HOST = 'build-box-7';
  const IDENTITY = { processStartedAt: STARTED_AT, host: HOST };

  beforeEach(async () => {
    h.init();
    h.setupMoeFolder({ schemaVersion: 6 });
    h.createEpic();
    h.createTask({ id: 'task-L', status: 'WORKING' });
    await h.state.load();
  });

  afterEach(() => {
    h.state.clearEmitter();
    h.cleanup();
  });

  const taskFile = () => path.join(h.moePath, 'tasks', 'task-L.json');
  const workerFile = () => path.join(h.moePath, 'workers', 'worker-W.json');
  const attemptFile = (id: string) => path.join(h.moePath, 'attempts', `${id}.json`);
  const readTask = () => JSON.parse(fs.readFileSync(taskFile(), 'utf8')) as Task;
  const readAttempt = (id: string) => JSON.parse(fs.readFileSync(attemptFile(id), 'utf8')) as ExecutionAttempt;

  /** A real claim of task-L by worker-W, carrying whatever identity the runner sends. */
  async function claimWith(identity: Record<string, string>): Promise<{ attemptId: string; generation: number }> {
    const result = (await claimNextTaskTool(h.state).handler(
      { statuses: ['WORKING'], workerId: 'worker-W', ...identity },
      h.state
    )) as Record<string, unknown>;
    expect(result.hasNext).toBe(true);
    return { attemptId: String(result.attemptId), generation: Number(result.generation) };
  }

  /**
   * A daemon-only restart in index.ts's startup order: a fresh StateManager
   * loads .moe/, parks every running attempt whose seat still holds its task,
   * then purges workers. The seat survives the purge because it owns an open
   * attempt, so nothing here asserts that its record is gone.
   */
  async function restartDaemon(): Promise<void> {
    h.state.clearEmitter();
    h.state = new StateManager({ projectPath: h.testDir });
    await h.state.load();
    await h.state.runExclusive(() => reconcileRunningAttempts(h.state));
    await h.state.purgeAllWorkers();
  }

  function reattach(args: Record<string, unknown>): Promise<unknown> {
    return reattachAttemptTool(h.state).handler(
      { taskId: 'task-L', workerId: 'worker-W', runnerId: 'runner-pilot', ...args },
      h.state
    );
  }

  async function refused(args: Record<string, unknown>): Promise<MoeError> {
    const err = await reattach(args).then(
      () => { throw new Error('expected a MoeError refusal, but the reattach resolved'); },
      (e: unknown) => e
    );
    expect(err).toBeInstanceOf(MoeError);
    return err as MoeError;
  }

  /** A clock past the reconcile window, however late in the test the park happened. */
  const pastTheWindow = () => Date.now() + h.state.reconcileWindowMs + 1;

  it('reattaches with the identity its claim recorded, keeps the row, and the window then releases nothing', async () => {
    const { attemptId, generation } = await claimWith(IDENTITY);
    await restartDaemon();
    expect(readAttempt(attemptId).phase).toBe('reconciling');
    expect(readTask().assignedWorkerId).toBe('worker-W');
    const taskBefore = fs.readFileSync(taskFile(), 'utf8');
    const workerBefore = fs.readFileSync(workerFile(), 'utf8');

    const result = await reattach({ attemptId, generation, ...IDENTITY });

    expect(result).toMatchObject({ success: true, attemptId, generation: 1, phase: 'running' });
    expect(readAttempt(attemptId).phase).toBe('running');
    expect(fs.readFileSync(taskFile(), 'utf8')).toBe(taskBefore);
    expect(fs.readFileSync(workerFile(), 'utf8')).toBe(workerBefore);

    // Running again, so no longer reconciling: the give-up has nothing to close.
    expect(await checkReconcileWindow(h.state, pastTheWindow())).toEqual([]);
    expect(readAttempt(attemptId).phase).toBe('running');
    expect(fs.readFileSync(taskFile(), 'utf8')).toBe(taskBefore);
  });

  it.each([
    ['processStartedAt', { processStartedAt: '4242@2026-09-18T09:15:31.1234567Z' }],
    ['host', { host: 'build-box-8' }],
  ])('refuses a %s that differs from what the claim recorded, writing nothing', async (field, override) => {
    const { attemptId, generation } = await claimWith(IDENTITY);
    await restartDaemon();
    const bytes = fs.readFileSync(attemptFile(attemptId), 'utf8');

    const err = await refused({ attemptId, generation, ...IDENTITY, ...override });

    expect(err.codeName).toBe('ATTEMPT_IDENTITY_MISMATCH');
    // The field that differs, never '(none recorded)': the claim did record one.
    expect(err.context).toMatchObject({ field });
    expect(fs.readFileSync(attemptFile(attemptId), 'utf8')).toBe(bytes);
    expect(readAttempt(attemptId).phase).toBe('reconciling');
  });

  it('matches the recorded string exactly: the same instant spelled another way is refused', async () => {
    const offsetSpelling = '2026-09-18T12:15:30.123+03:00';
    const { attemptId, generation } = await claimWith({ processStartedAt: offsetSpelling, host: HOST });
    await restartDaemon();

    // The same instant in UTC. A claim that normalised what it recorded, or a
    // reattach that compared dates, would accept this spelling.
    const err = await refused({ attemptId, generation, processStartedAt: '2026-09-18T09:15:30.123Z', host: HOST });
    expect(err.codeName).toBe('ATTEMPT_IDENTITY_MISMATCH');
    expect(err.context).toMatchObject({ field: 'processStartedAt' });

    const result = await reattach({ attemptId, generation, processStartedAt: offsetSpelling, host: HOST });
    expect(result).toMatchObject({ success: true, phase: 'running' });
  });

  it('leaves an attempt whose claim sent no identity unmatchable after the restart', async () => {
    const { attemptId, generation } = await claimWith({});
    await restartDaemon();

    const err = await refused({ attemptId, generation, ...IDENTITY });

    expect(err.codeName).toBe('ATTEMPT_IDENTITY_MISMATCH');
    expect(err.context).toMatchObject({ field: 'processStartedAt (none recorded)' });
    expect(readAttempt(attemptId).phase).toBe('reconciling');
  });

  it('still gives up a seat that never reattaches: the window closes its attempt and releases the row', async () => {
    const { attemptId } = await claimWith(IDENTITY);
    await restartDaemon();

    const closed = await checkReconcileWindow(h.state, pastTheWindow());

    // A recorded identity buys no extra patience: the window is the only bound.
    expect(closed.map((a) => a.id)).toEqual([attemptId]);
    expect(readAttempt(attemptId).phase).toBe('closed');
    const task = readTask();
    expect(task.assignedWorkerId).toBeNull();
    expect(task.status).toBe('WORKING');
  });
});
