import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { ToolTestHarness } from '../tools/toolTestHarness.js';
import { claimNextTaskTool } from '../tools/claimNextTask.js';
import { listAttempts, openAttempt, setAttemptPhase } from './attemptStore.js';
import {
  DEFAULT_RECONCILE_WINDOW_MS,
  checkReconcileWindow,
  startReconcileWindowCheck,
  stopReconcileWindowCheck,
} from './sweeps.js';
import { MoeError } from '../util/errors.js';
import type { ExecutionAttempt, ExecutionAttemptPhase, Task } from '../types/schema.js';

// =============================================================================
// The reconcile-window sweep: an attempt parked in `reconciling` must not stay
// there forever.
//
// A daemon restart parks every running attempt in `reconciling` — the daemon
// has lost sight of that execution and holds the task until a runner reattaches
// and proves which process it is talking about. If no runner ever comes back,
// nothing else releases the row: the seat is spared by purgeAllWorkers, the
// claim refusal keeps third parties out, and there is no idle sweep for
// WORKING. This sweep is the bound on that ONE phase.
//
// What these cases pin, and why each exists:
//  - the window is measured from the ATTEMPT's own lastPhaseAt, never from a
//    worker's lastActivityAt. Measuring from worker idle would be exactly the
//    idle-based auto-release for WORKING/PLANNING that two rails forbid, and it
//    would look correct in review.
//  - the filter is the `reconciling` phase EXACTLY. `running` (including a
//    successfully reattached attempt) and `finalizing` are untouched however
//    old they are. A quiet build is still not evidence of a dead worker.
//  - the boundary is a real comparison, so a sweep that always fires fails
//    here rather than passing every past-the-window assertion.
//  - the successor is exactly ONE, and it comes from the store (openAttempt's
//    exclusivity + the generation allocator), not from a counter in the sweep.
// =============================================================================

describe('reconcile-window sweep', () => {
  const h = new ToolTestHarness();

  /** Pinned clock. The sweep takes `nowMs`, so no case depends on wall time. */
  const NOW = Date.parse('2026-09-12T12:00:00.000Z');
  const WINDOW = DEFAULT_RECONCILE_WINDOW_MS;

  /** Hours of silence: a long build emits nothing and calls no moe.* tool. */
  const QUIET_FOR_HOURS = new Date(NOW - 3 * 60 * 60 * 1000).toISOString();

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

  function readTaskFile(id: string): Task {
    return JSON.parse(fs.readFileSync(path.join(h.moePath, 'tasks', `${id}.json`), 'utf8')) as Task;
  }

  function attemptFile(id: string): string {
    return path.join(h.moePath, 'attempts', `${id}.json`);
  }

  function readAttemptFile(id: string): ExecutionAttempt {
    return JSON.parse(fs.readFileSync(attemptFile(id), 'utf8')) as ExecutionAttempt;
  }

  /**
   * One WORKING task, one worker holding it, one attempt in `phase` whose
   * lastPhaseAt is `ageMs` old measured against the pinned NOW.
   *
   * Time is controlled by writing the phase timestamp into the past, never by
   * sleeping — the sweep's only clock is that field.
   */
  async function seedHeldTask(opts: {
    phase: ExecutionAttemptPhase;
    ageMs: number;
    workerLastActivityAt?: string;
  }): Promise<ExecutionAttempt> {
    h.createTask({
      id: 'task-L',
      status: 'WORKING',
      assignedWorkerId: 'worker-W',
      implementationPlan: [
        { stepId: 'step-1', description: 'Long quiet build', status: 'IN_PROGRESS', affectedFiles: ['file.ts'] },
      ],
    });
    h.createWorker({
      id: 'worker-W',
      status: 'CODING',
      currentTaskId: 'task-L',
      lastActivityAt: opts.workerLastActivityAt ?? QUIET_FOR_HOURS,
    });
    await h.state.load();

    const attempt = await openAttempt(h.state, {
      id: 'attempt-L-1',
      taskId: 'task-L',
      workerId: 'worker-W',
      runnerId: 'runner-1',
      workspace: h.testDir,
    });
    if (opts.phase !== 'running') {
      await setAttemptPhase(h.state, attempt.id, opts.phase);
    }
    return backdatePhase(attempt.id, opts.ageMs);
  }

  /** Rewrite lastPhaseAt into the past, through the same durable-first order. */
  async function backdatePhase(attemptId: string, ageMs: number): Promise<ExecutionAttempt> {
    const existing = h.state.attempts.get(attemptId);
    if (!existing) throw new Error(`no attempt ${attemptId} to backdate`);
    const updated: ExecutionAttempt = {
      ...existing,
      lastPhaseAt: new Date(NOW - ageMs).toISOString(),
    };
    await h.state.writeEntity('attempts', attemptId, updated);
    h.state.attempts.set(attemptId, updated);
    return updated;
  }

  // ---------------------------------------------------------------------------
  // The give-up arm.
  // ---------------------------------------------------------------------------

  it('closes a reconciling attempt past the window and releases its task', async () => {
    await seedHeldTask({ phase: 'reconciling', ageMs: WINDOW + 1 });

    const closed = await checkReconcileWindow(h.state, NOW);

    expect(closed.map((a) => a.id)).toEqual(['attempt-L-1']);
    // Exact phase string: a truthiness assertion would pass against a sweep
    // that parked the attempt in some other non-reconciling phase.
    expect(h.state.attempts.get('attempt-L-1')?.phase).toBe('closed');
    expect(readAttemptFile('attempt-L-1').phase).toBe('closed');

    // Released into the column the shared routing chooses, NOT parked to
    // BACKLOG: BACKLOG is human-gated and invisible to agents, so a park would
    // never yield the successor this card owes.
    const task = readTaskFile('task-L');
    expect(task.status).toBe('WORKING');
    expect(task.assignedWorkerId).toBeNull();

    // The seat the release just took away must not still name the task: a
    // worker record pointing at a row it no longer owns reads as busy in
    // list_workers and in the stale watcher. Its lastActivityAt is preserved,
    // so the Layer-3 prune still sees the corpse as stale rather than resurrected.
    const owner = h.state.workers.get('worker-W');
    expect(owner?.currentTaskId).toBeNull();
    expect(owner?.lastActivityAt).toBe(QUIET_FOR_HOURS);
  });

  it('leaves a reconciling attempt one millisecond inside the window completely alone', async () => {
    const seeded = await seedHeldTask({ phase: 'reconciling', ageMs: WINDOW - 1 });

    const closed = await checkReconcileWindow(h.state, NOW);

    expect(closed).toEqual([]);
    // Byte-identical: the boundary is a real comparison, not an always-fire.
    expect(readAttemptFile('attempt-L-1')).toEqual(seeded);
    expect(h.state.attempts.get('attempt-L-1')?.phase).toBe('reconciling');
    expect(readTaskFile('task-L').assignedWorkerId).toBe('worker-W');
  });

  // ---------------------------------------------------------------------------
  // The phases this window must never touch. These are the cases that fail if
  // anyone applies the window to a live — or successfully reattached — attempt.
  // ---------------------------------------------------------------------------

  it('never touches a running attempt, however old and however quiet its worker', async () => {
    // A reattached attempt is `running` again. Ten windows of age plus three
    // hours of worker silence is the strongest form of the wrong signal.
    const seeded = await seedHeldTask({ phase: 'running', ageMs: WINDOW * 10 });

    const closed = await checkReconcileWindow(h.state, NOW);

    expect(closed).toEqual([]);
    expect(readAttemptFile('attempt-L-1')).toEqual(seeded);
    expect(h.state.attempts.get('attempt-L-1')?.phase).toBe('running');
    const task = readTaskFile('task-L');
    expect(task.status).toBe('WORKING');
    expect(task.assignedWorkerId).toBe('worker-W');
  });

  it('never touches a finalizing attempt, however old', async () => {
    // finalizing means complete_task is still landing its bytes; its bound
    // belongs to the landing path, not to this window.
    const seeded = await seedHeldTask({ phase: 'finalizing', ageMs: WINDOW * 10 });

    const closed = await checkReconcileWindow(h.state, NOW);

    expect(closed).toEqual([]);
    expect(readAttemptFile('attempt-L-1')).toEqual(seeded);
    expect(h.state.attempts.get('attempt-L-1')?.phase).toBe('finalizing');
    expect(readTaskFile('task-L').assignedWorkerId).toBe('worker-W');
  });

  it('measures from the attempt phase timestamp, never from the worker last activity', async () => {
    // The sibling card's acceptance fixture in one assertion: a worker three
    // hours quiet mid-build, whose attempt entered reconciling seconds ago.
    // A sweep reading lastActivityAt releases this row; this one must not.
    const seeded = await seedHeldTask({
      phase: 'reconciling',
      ageMs: 5000,
      workerLastActivityAt: QUIET_FOR_HOURS,
    });

    const closed = await checkReconcileWindow(h.state, NOW);

    expect(closed).toEqual([]);
    expect(readAttemptFile('attempt-L-1')).toEqual(seeded);
    expect(readTaskFile('task-L').assignedWorkerId).toBe('worker-W');
    expect(h.state.workers.get('worker-W')?.lastActivityAt).toBe(QUIET_FOR_HOURS);
  });

  // ---------------------------------------------------------------------------
  // Exactly one successor.
  // ---------------------------------------------------------------------------

  it('writes nothing and opens nothing on a repeated pass over a closed attempt', async () => {
    await seedHeldTask({ phase: 'reconciling', ageMs: WINDOW + 1 });
    await checkReconcileWindow(h.state, NOW);

    const afterFirst = readAttemptFile('attempt-L-1');
    const afterFirstTask = readTaskFile('task-L');
    const mtimeAfterFirst = fs.statSync(attemptFile('attempt-L-1')).mtimeMs;

    const closedAgain = await checkReconcileWindow(h.state, NOW + WINDOW * 10);

    expect(closedAgain).toEqual([]);
    // No second attempt: the sweep never opens one — the next claim does.
    expect(listAttempts(h.state, 'task-L').map((a) => a.id)).toEqual(['attempt-L-1']);
    expect(readAttemptFile('attempt-L-1')).toEqual(afterFirst);
    expect(fs.statSync(attemptFile('attempt-L-1')).mtimeMs).toBe(mtimeAfterFirst);
    expect(readTaskFile('task-L')).toEqual(afterFirstTask);
  });

  it('yields exactly one successor: one claim takes the next generation, a second is refused', async () => {
    await seedHeldTask({ phase: 'reconciling', ageMs: WINDOW + 1 });
    await checkReconcileWindow(h.state, NOW);

    const claim = claimNextTaskTool(h.state);
    const first = (await claim.handler(
      { statuses: ['WORKING'], taskId: 'task-L', workerId: 'worker-N' },
      h.state
    )) as Record<string, unknown>;

    expect(first.hasNext).toBe(true);
    // Generation is allocated over EVERY prior attempt, closed ones included,
    // so the successor is generation 2 — never a reissued 1.
    expect(first.generation).toBe(2);
    expect(readTaskFile('task-L').assignedWorkerId).toBe('worker-N');

    // A second claimer gets nothing: the row now has a live present owner.
    const second = (await claim.handler(
      { statuses: ['WORKING'], workerId: 'worker-M' },
      h.state
    )) as Record<string, unknown>;
    expect(second.hasNext).toBe(false);

    // And the rule is the STORE's, not the sweep's: opening a second attempt
    // for the same task is refused outright.
    const refused = await openAttempt(h.state, {
      taskId: 'task-L',
      workerId: 'worker-M',
      runnerId: 'runner-M',
      workspace: h.testDir,
    }).then(
      () => {
        throw new Error('expected ATTEMPT_ALREADY_OPEN, but the open resolved');
      },
      (err: unknown) => err
    );
    expect(refused).toBeInstanceOf(MoeError);
    expect((refused as MoeError).codeName).toBe('ATTEMPT_ALREADY_OPEN');

    // One closed original plus one successor. Nothing else.
    const attempts = listAttempts(h.state, 'task-L');
    expect(attempts.map((a) => a.generation)).toEqual([1, 2]);
    expect(attempts.map((a) => a.phase)).toEqual(['closed', 'running']);
  });

  // ---------------------------------------------------------------------------
  // Per-record tolerance and timer hygiene.
  // ---------------------------------------------------------------------------

  it('closes a stale attempt but never yanks a row a different worker now holds', async () => {
    // A dangling reconciling attempt whose task has since been handed to
    // someone else. Closing the stale record is right; releasing the row would
    // yank a live worker, which a rail forbids outright.
    await seedHeldTask({ phase: 'reconciling', ageMs: WINDOW + 1 });
    h.createWorker({ id: 'worker-Z', status: 'CODING', currentTaskId: 'task-L' });
    await h.state.load();
    await h.state.updateTask('task-L', { assignedWorkerId: null });
    await h.state.updateTask('task-L', { assignedWorkerId: 'worker-Z' });

    const closed = await checkReconcileWindow(h.state, NOW);

    expect(closed.map((a) => a.id)).toEqual(['attempt-L-1']);
    expect(readAttemptFile('attempt-L-1').phase).toBe('closed');
    // The current owner keeps its row and its seat.
    expect(readTaskFile('task-L').assignedWorkerId).toBe('worker-Z');
    expect(h.state.workers.get('worker-Z')?.currentTaskId).toBe('task-L');
  });

  it('keeps sweeping after one record it cannot close', async () => {
    await seedHeldTask({ phase: 'reconciling', ageMs: WINDOW + 1 });
    h.createTask({ id: 'task-B', status: 'WORKING', assignedWorkerId: 'worker-B', order: 2 });
    h.createWorker({ id: 'worker-B', status: 'CODING', currentTaskId: 'task-B' });
    await h.state.load();
    const bad = await openAttempt(h.state, {
      id: 'attempt-B-1',
      taskId: 'task-B',
      workerId: 'worker-B',
      runnerId: 'runner-B',
      workspace: h.testDir,
    });
    await setAttemptPhase(h.state, bad.id, 'reconciling');
    await backdatePhase(bad.id, WINDOW + 1);

    // attempt-B-1 is unwritable; attempt-L-1 must still be closed and released.
    const writeEntity = h.state.writeEntity.bind(h.state);
    vi.spyOn(h.state, 'writeEntity').mockImplementation(async (kind, id, entity) => {
      if (kind === 'attempts' && id === 'attempt-B-1') throw new Error('disk full');
      return writeEntity(kind, id, entity);
    });

    const closed = await checkReconcileWindow(h.state, NOW);

    expect(closed.map((a) => a.id)).toEqual(['attempt-L-1']);
    expect(readAttemptFile('attempt-L-1').phase).toBe('closed');
    expect(readTaskFile('task-L').assignedWorkerId).toBeNull();
    // The failed one is left exactly as it was — still held, still reconciling.
    expect(readAttemptFile('attempt-B-1').phase).toBe('reconciling');
    expect(readTaskFile('task-B').assignedWorkerId).toBe('worker-B');
  });

  it('arms one interval and genuinely clears it on stop', async () => {
    await h.state.load();
    // load() arms the sweeps; stop first so this case owns the handle.
    stopReconcileWindowCheck(h.state);
    expect(h.state.reconcileWindowInterval).toBeUndefined();

    startReconcileWindowCheck(h.state, 60_000);
    const armed = h.state.reconcileWindowInterval;
    expect(armed).toBeDefined();

    const clearSpy = vi.spyOn(global, 'clearInterval');
    stopReconcileWindowCheck(h.state);
    expect(clearSpy).toHaveBeenCalledWith(armed);
    expect(h.state.reconcileWindowInterval).toBeUndefined();
  });
});
