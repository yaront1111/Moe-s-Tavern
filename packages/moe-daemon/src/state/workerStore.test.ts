import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { ToolTestHarness } from '../tools/toolTestHarness.js';
import { claimNextTaskTool } from '../tools/claimNextTask.js';
import { openAttempt, reconcileRunningAttempts, setAttemptPhase } from './attemptStore.js';
import { MoeError } from '../util/errors.js';
import type { StateManager } from './StateManager.js';
import type { ExecutionAttempt, Task, Worker } from '../types/schema.js';

// =============================================================================
// The startup restart hold, at the store level.
//
// The end-to-end proof lives in delivery/acceptance.test.ts (a real daemon
// child, a real long-running process, an abrupt SIGKILL). That case cannot
// isolate WHICH rule held the task, so these cases pin each rule directly
// against the store: the reconcile pass, the spared purge, the legacy purge
// that must not regress, and the claim refusal that stops a third party.
//
// Every case asserts exact phase strings and exact code names. A truthiness
// assertion here would pass against a hold that parked the wrong phase.
// =============================================================================

describe('purgeAllWorkers + startup attempt reconciliation', () => {
  const h = new ToolTestHarness();

  beforeEach(() => {
    h.init();
    h.setupMoeFolder({ schemaVersion: 6 });
    h.createEpic();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    h.state.clearEmitter();
    h.cleanup();
  });

  /** Hours of silence: a long build emits nothing and calls no tool. */
  const QUIET_FOR_HOURS = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();

  function workerFile(id: string): string {
    return path.join(h.moePath, 'workers', `${id}.json`);
  }

  function readWorkerFile(id: string): Worker {
    return JSON.parse(fs.readFileSync(workerFile(id), 'utf8')) as Worker;
  }

  function readTaskFile(id: string): Task {
    return JSON.parse(fs.readFileSync(path.join(h.moePath, 'tasks', `${id}.json`), 'utf8')) as Task;
  }

  function readAttemptFile(id: string): ExecutionAttempt {
    return JSON.parse(
      fs.readFileSync(path.join(h.moePath, 'attempts', `${id}.json`), 'utf8')
    ) as ExecutionAttempt;
  }

  /** The exact startup order src/index.ts runs: load, reconcile, purge. */
  async function restartDaemonStartup(): Promise<void> {
    await reconcileRunningAttempts(h.state);
    await h.state.purgeAllWorkers();
  }

  /** One WORKING task owned by one quiet worker, plus an open attempt for it. */
  async function seedOwnedTask(opts: { attemptPhase?: 'running' | 'closed' | null } = {}): Promise<void> {
    h.createTask({
      id: 'task-L',
      status: 'WORKING',
      assignedWorkerId: 'worker-W',
      implementationPlan: [
        { stepId: 'step-1', description: 'Long quiet build', status: 'IN_PROGRESS', affectedFiles: ['file.ts'] },
      ],
    });
    h.createWorker({ id: 'worker-W', status: 'CODING', currentTaskId: 'task-L', lastActivityAt: QUIET_FOR_HOURS });
    await h.state.load();
    const phase = opts.attemptPhase === undefined ? 'running' : opts.attemptPhase;
    if (phase === null) return;
    const attempt = await openAttempt(h.state, {
      id: 'attempt-L-1',
      taskId: 'task-L',
      workerId: 'worker-W',
      runnerId: 'runner-pilot',
      workspace: h.testDir,
    });
    if (phase === 'closed') await setAttemptPhase(h.state, attempt.id, 'closed');
  }

  it('spares a worker that owns a running attempt and holds its task', async () => {
    await seedOwnedTask();

    await restartDaemonStartup();

    // The record survives on disk AND in the map — worker identity is persisted
    // separately from the attempt, so the restart never has to rebuild it.
    expect(fs.existsSync(workerFile('worker-W'))).toBe(true);
    expect(readWorkerFile('worker-W').currentTaskId).toBe('task-L');
    expect(h.state.workers.get('worker-W')?.currentTaskId).toBe('task-L');

    // The task was held, not released: still WORKING, still assigned.
    expect(readTaskFile('task-L').status).toBe('WORKING');
    expect(readTaskFile('task-L').assignedWorkerId).toBe('worker-W');
    expect(h.state.getTask('task-L')?.assignedWorkerId).toBe('worker-W');
  });

  it('parks the running attempt in exactly the reconciling phase, not closed', async () => {
    await seedOwnedTask();

    await restartDaemonStartup();

    expect(readAttemptFile('attempt-L-1').phase).toBe('reconciling');
    expect(h.state.attempts.get('attempt-L-1')?.phase).toBe('reconciling');
    // Exactly one record: the hold issues no successor generation.
    expect(fs.readdirSync(path.join(h.moePath, 'attempts')).sort()).toEqual(['attempt-L-1.json']);
  });

  it('holds a worker quiet for three hours — idle time is never consulted', async () => {
    await seedOwnedTask();
    expect(h.state.workers.get('worker-W')?.lastActivityAt).toBe(QUIET_FOR_HOURS);

    await restartDaemonStartup();

    // Same assertions as the spare case, but the point is the fixture: nothing
    // in the hold may infer death from silence. A quiet build is not a corpse.
    expect(fs.existsSync(workerFile('worker-W'))).toBe(true);
    expect(readTaskFile('task-L').assignedWorkerId).toBe('worker-W');
    expect(readAttemptFile('attempt-L-1').phase).toBe('reconciling');
    expect(readWorkerFile('worker-W').lastActivityAt).toBe(QUIET_FOR_HOURS);
  });

  it('reconciles only running attempts and leaves other phases alone', async () => {
    await seedOwnedTask();
    h.createTask({ id: 'task-F', status: 'REVIEW', assignedWorkerId: 'worker-F' });
    h.createWorker({ id: 'worker-F', status: 'CODING', currentTaskId: 'task-F' });
    await h.state.load();
    const finalizing = await openAttempt(h.state, {
      id: 'attempt-F-1',
      taskId: 'task-F',
      workerId: 'worker-F',
      runnerId: 'runner-pilot',
      workspace: h.testDir,
    });
    await setAttemptPhase(h.state, finalizing.id, 'finalizing');

    const moved = await reconcileRunningAttempts(h.state);

    expect(moved.map((a) => a.id)).toEqual(['attempt-L-1']);
    expect(readAttemptFile('attempt-L-1').phase).toBe('reconciling');
    expect(readAttemptFile('attempt-F-1').phase).toBe('finalizing');
  });

  it('survives an attempt it cannot park: one bad record never aborts startup', async () => {
    await seedOwnedTask();
    const realWrite = h.state.writeEntity.bind(h.state);
    vi.spyOn(h.state, 'writeEntity').mockImplementation(async (...args: Parameters<StateManager['writeEntity']>) => {
      if (args[0] === 'attempts') throw new Error('EPERM: attempt-L-1 is unwritable');
      return realWrite(...args);
    });

    await expect(restartDaemonStartup()).resolves.toBeUndefined();

    // It stayed `running`, which is still non-closed — so the seat is spared and
    // the task held anyway. Failing in this direction is the point.
    vi.restoreAllMocks();
    expect(readAttemptFile('attempt-L-1').phase).toBe('running');
    expect(fs.existsSync(workerFile('worker-W'))).toBe(true);
    expect(readTaskFile('task-L').assignedWorkerId).toBe('worker-W');
  });

  // ---------------------------------------------------------------------------
  // The legacy path: every project that predates attempts must purge exactly as
  // it did before. A regression here strands or duplicates real work.
  // ---------------------------------------------------------------------------

  it('still purges a worker that owns no attempt and releases its task', async () => {
    await seedOwnedTask({ attemptPhase: null });

    await restartDaemonStartup();

    expect(fs.existsSync(workerFile('worker-W'))).toBe(false);
    expect(h.state.workers.has('worker-W')).toBe(false);
    // nextStatusForRelease: an unfinished WORKING task stays WORKING-unassigned
    // so the next worker re-claims and resumes it.
    expect(readTaskFile('task-L').status).toBe('WORKING');
    expect(readTaskFile('task-L').assignedWorkerId).toBe(null);
  });

  it('still purges a worker whose only attempt is already closed', async () => {
    await seedOwnedTask({ attemptPhase: 'closed' });

    await restartDaemonStartup();

    expect(fs.existsSync(workerFile('worker-W'))).toBe(false);
    expect(h.state.workers.has('worker-W')).toBe(false);
    expect(readTaskFile('task-L').assignedWorkerId).toBe(null);
    // A closed attempt is history, not a hold: it stays closed, never reopened.
    expect(readAttemptFile('attempt-L-1').phase).toBe('closed');
  });

  // ---------------------------------------------------------------------------
  // The third-party refusal. The hold is worthless if another worker can simply
  // claim the row while its owner is out there finishing a build.
  // ---------------------------------------------------------------------------

  it('refuses a competing claim on a task whose attempt is reconciling', async () => {
    await seedOwnedTask();
    await restartDaemonStartup();

    const claim = claimNextTaskTool(h.state);
    const refused = await claim
      .handler({ statuses: ['WORKING'], taskId: 'task-L', workerId: 'worker-X' }, h.state)
      .then(
        () => {
          throw new Error('expected a MoeError refusal, but the claim resolved');
        },
        (err: unknown) => err
      );

    expect(refused).toBeInstanceOf(MoeError);
    const err = refused as MoeError;
    expect(err.code).toBe(-32002);
    expect(err.codeName).toBe('ATTEMPT_RECONCILING');
    // MoeError.context is not forwarded over the MCP wire, so the message is
    // all a remote caller sees; it must name the attempt.
    expect(err.message).toContain('attempt-L-1');
    expect(err.context).toEqual({
      attemptId: 'attempt-L-1',
      generation: 1,
      taskId: 'task-L',
      workerId: 'worker-W',
      retryable: true,
    });

    // Refused BEFORE any write: the owner still holds the row.
    expect(readTaskFile('task-L').assignedWorkerId).toBe('worker-W');
    expect(readAttemptFile('attempt-L-1').phase).toBe('reconciling');
  });

  it('does not refuse the attempt owner reclaiming its own held task', async () => {
    await seedOwnedTask();
    await restartDaemonStartup();

    const claim = claimNextTaskTool(h.state);
    const result = (await claim.handler(
      { statuses: ['WORKING'], taskId: 'task-L', workerId: 'worker-W' },
      h.state
    )) as Record<string, unknown>;

    // Whatever the resume path answers, it is not the third-party refusal.
    expect(result).toBeDefined();
    expect(readTaskFile('task-L').assignedWorkerId).toBe('worker-W');
  });
});
