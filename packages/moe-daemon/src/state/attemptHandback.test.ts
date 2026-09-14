import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToolTestHarness } from '../tools/toolTestHarness.js';
import type { ToolDefinition } from '../tools/index.js';
import { acquireResourceTool } from '../tools/acquireResource.js';
import { claimNextTaskTool } from '../tools/claimNextTask.js';
import { completeTaskTool } from '../tools/completeTask.js';
import { getContextTool } from '../tools/getContext.js';
import { qaRejectTool } from '../tools/qaReject.js';
import { reportBlockedTool } from '../tools/reportBlocked.js';
import { setTaskStatusTool } from '../tools/setTaskStatus.js';
import { unblockWorkerTool } from '../tools/unblockWorker.js';
import { listAttempts, openAttempt, reconcileRunningAttempts, setAttemptPhase } from './attemptStore.js';
import { MoeError } from '../util/errors.js';
import type { StateManager } from './StateManager.js';
import type { ExecutionAttemptPhase } from '../types/schema.js';

// =============================================================================
// Close on hand-back: a seat that gives its task up keeps no open attempt.
//
// The 2026-09-13 incident: qa_reject handed a REVIEW row back to WORKING but
// left the QA seat's attempt `running`. A daemon restart parked that orphan in
// `reconciling`, and every explicit claim of the now-unassigned row was refused
// with ATTEMPT_RECONCILING until the reconcile window expired. These cases pin
// each hand-back path, the restart that exposed the leak, and the scope of the
// claim guard. The kept-seat cases pin the other direction: a seat that keeps
// its task keeps its attempt, and complete_task's finalizing hold survives the
// seat clear of its own REVIEW transition.
//
// Assertions read exact [generation, phase] tuples and exact code names. A
// truthiness check would pass against a reused record or the wrong phase.
// =============================================================================

type Phases = Array<[number, ExecutionAttemptPhase]>;

describe('attempt close on hand-back', () => {
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

  /** Hours of silence, so the restart purge cannot keep a seat on its heartbeat alone. */
  const QUIET_FOR_HOURS = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
  const DONE_PLAN = [
    { stepId: 'step-1', description: 'Implement it', status: 'COMPLETED' as const, affectedFiles: ['file.ts'] },
  ];

  function phases(taskId: string): Phases {
    return listAttempts(h.state, taskId).map((a): [number, ExecutionAttemptPhase] => [a.generation, a.phase]);
  }

  async function call(tool: ToolDefinition, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    return (await tool.handler(args, h.state)) as Record<string, unknown>;
  }

  function claim(taskId: string, workerId: string, status: string): Promise<Record<string, unknown>> {
    return call(claimNextTaskTool(h.state), { statuses: [status], taskId, workerId });
  }

  async function refusal(pending: Promise<unknown>): Promise<MoeError> {
    const outcome = await pending.then(
      () => null,
      (err: unknown) => err
    );
    expect(outcome).toBeInstanceOf(MoeError);
    return outcome as MoeError;
  }

  /** A WORKING row claimed by worker-1, so it carries exactly one running attempt. */
  async function seedClaimedWorkingRow(extra: { implementationPlan?: typeof DONE_PLAN } = {}): Promise<void> {
    h.createTask({ id: 'task-W', status: 'WORKING', ...extra });
    await h.state.load();
    const claimed = await claim('task-W', 'worker-1', 'WORKING');
    expect(claimed.generation).toBe(1);
  }

  /** QA claims a REVIEW row and reads its context, as qa_reject requires. */
  async function claimForReview(taskId: string, qaId: string): Promise<Record<string, unknown>> {
    const claimed = await claim(taskId, qaId, 'REVIEW');
    await call(getContextTool(h.state), { taskId, workerId: qaId });
    return claimed;
  }

  // ---------------------------------------------------------------------------
  // Hand-back paths: each one gives the seat up, so the seat's attempt ends.
  // ---------------------------------------------------------------------------

  it('qa_reject closes the QA seat attempt when it hands the row back to WORKING', async () => {
    h.createTask({ id: 'task-R', status: 'REVIEW', implementationPlan: DONE_PLAN });
    await h.state.load();
    const claimed = await claimForReview('task-R', 'qa-1');
    expect(claimed.generation).toBe(1);

    const rejected = await call(qaRejectTool(h.state), { taskId: 'task-R', reason: 'DoD item 1 fails', workerId: 'qa-1' });

    expect(rejected.status).toBe('WORKING');
    expect(h.state.getTask('task-R')?.assignedWorkerId).toBeNull();
    expect(h.state.getWorker('qa-1')?.status).toBe('IDLE');
    expect(phases('task-R')).toEqual([[1, 'closed']]);
  });

  it('report_blocked closes the attempt of the seat it frees', async () => {
    await seedClaimedWorkingRow();

    await call(reportBlockedTool(h.state), { taskId: 'task-W', workerId: 'worker-1', reason: 'Upstream API is down' });

    expect(h.state.getTask('task-W')).toMatchObject({ status: 'BLOCKED', assignedWorkerId: null });
    expect(h.state.getWorker('worker-1')?.status).toBe('IDLE');
    expect(phases('task-W')).toEqual([[1, 'closed']]);
  });

  it('report_blocked on a busy resource keeps the seat and leaves its attempt running', async () => {
    h.createTask({ id: 'task-holder', status: 'WORKING', order: 2 });
    await seedClaimedWorkingRow();
    const held = await call(acquireResourceTool(h.state), {
      resourceId: 'bench-box',
      taskId: 'task-holder',
      workerId: 'worker-holder',
    });
    expect(held.granted).toBe(true);

    const parked = await call(reportBlockedTool(h.state), {
      taskId: 'task-W',
      workerId: 'worker-1',
      reason: 'Waiting for bench-box',
      resourceId: 'bench-box',
    });

    expect(parked.granted).toBe(false);
    expect(h.state.getTask('task-W')).toMatchObject({
      status: 'BLOCKED',
      assignedWorkerId: 'worker-1',
      blockedResourceId: 'bench-box',
    });
    expect(h.state.getWorker('worker-1')?.status).toBe('BLOCKED');
    expect(phases('task-W')).toEqual([[1, 'running']]);
  });

  it('set_task_status closes the attempt when a status change clears the seat', async () => {
    await seedClaimedWorkingRow();

    await call(setTaskStatusTool(h.state), { taskId: 'task-W', status: 'BACKLOG', reason: 'Parked by a human' });

    expect(h.state.getTask('task-W')).toMatchObject({ status: 'BACKLOG', assignedWorkerId: null });
    expect(phases('task-W')).toEqual([[1, 'closed']]);
  });

  it('set_task_status keeps the seat and its running attempt across both BLOCKED edges', async () => {
    await seedClaimedWorkingRow();

    await call(setTaskStatusTool(h.state), { taskId: 'task-W', status: 'BLOCKED', reason: 'Waiting on ops' });
    expect(h.state.getTask('task-W')).toMatchObject({ status: 'BLOCKED', assignedWorkerId: 'worker-1' });
    expect(phases('task-W')).toEqual([[1, 'running']]);

    await call(setTaskStatusTool(h.state), { taskId: 'task-W', status: 'WORKING' });
    expect(h.state.getTask('task-W')).toMatchObject({ status: 'WORKING', assignedWorkerId: 'worker-1' });
    expect(phases('task-W')).toEqual([[1, 'running']]);
  });

  it('unblock_worker closes the attempt when it frees the seat of a task that stays BLOCKED', async () => {
    await seedClaimedWorkingRow();
    await call(setTaskStatusTool(h.state), { taskId: 'task-W', status: 'BLOCKED', reason: 'Waiting on ops' });
    await h.state.updateWorker('worker-1', { status: 'BLOCKED' });

    await call(unblockWorkerTool(h.state), { workerId: 'worker-1', resolution: 'Seat freed for other work' });

    expect(h.state.getTask('task-W')).toMatchObject({ status: 'BLOCKED', assignedWorkerId: null });
    expect(phases('task-W')).toEqual([[1, 'closed']]);
  });

  it('a close that fails never fails the hand-back: the write stands and the attempt stays running', async () => {
    await seedClaimedWorkingRow();
    const realWrite = h.state.writeEntity.bind(h.state);
    vi.spyOn(h.state, 'writeEntity').mockImplementation(async (...args: Parameters<StateManager['writeEntity']>) => {
      if (args[0] === 'attempts') throw new Error('EPERM: attempt record is unwritable');
      return realWrite(...args);
    });

    await call(setTaskStatusTool(h.state), { taskId: 'task-W', status: 'BACKLOG', reason: 'Parked by a human' });

    vi.restoreAllMocks();
    expect(h.state.getTask('task-W')).toMatchObject({ status: 'BACKLOG', assignedWorkerId: null });
    expect(phases('task-W')).toEqual([[1, 'running']]);
  });

  it('complete_task hands the row to QA without closing its finalizing attempt', async () => {
    await seedClaimedWorkingRow({ implementationPlan: DONE_PLAN });

    await call(completeTaskTool(h.state), {
      taskId: 'task-W',
      workerId: 'worker-1',
      verification: { command: 'npm test', exitCode: 0 },
    });

    expect(h.state.getTask('task-W')).toMatchObject({ status: 'REVIEW', assignedWorkerId: null });
    expect(phases('task-W')).toEqual([[1, 'finalizing']]);
  });

  // ---------------------------------------------------------------------------
  // The incident itself, end to end, in the daemon's own startup order.
  // ---------------------------------------------------------------------------

  it('2026-09-13 incident: a QA-rejected row is claimable by explicit id after a daemon restart', async () => {
    h.createTask({ id: 'task-R', status: 'REVIEW', implementationPlan: DONE_PLAN });
    await h.state.load();
    // Generation 1 was the worker's execution, already closed when QA took the row.
    const first = await openAttempt(h.state, {
      taskId: 'task-R',
      workerId: 'worker-1',
      runnerId: 'worker-1',
      workspace: h.testDir,
    });
    await setAttemptPhase(h.state, first.id, 'closed');
    const qaClaim = await claimForReview('task-R', 'qa-1');
    expect(qaClaim.generation).toBe(2);
    await call(qaRejectTool(h.state), { taskId: 'task-R', reason: 'DoD item 2 fails', workerId: 'qa-1' });
    expect(h.state.getTask('task-R')).toMatchObject({ status: 'WORKING', assignedWorkerId: null });

    // The restart, in src/index.ts order. The QA seat is long quiet, so only an
    // open attempt could make the purge spare it.
    await h.state.updateWorker('qa-1', { lastActivityAt: QUIET_FOR_HOURS });
    await reconcileRunningAttempts(h.state);
    await h.state.purgeAllWorkers();

    const retaken = await claim('task-R', 'worker-2', 'WORKING');

    expect(retaken.hasNext).toBe(true);
    expect(retaken.generation).toBe(3);
    expect(phases('task-R')).toEqual([[1, 'closed'], [2, 'closed'], [3, 'running']]);
    expect(h.state.getTask('task-R')?.assignedWorkerId).toBe('worker-2');
    expect(listAttempts(h.state).filter((a) => a.workerId === 'qa-1' && a.phase !== 'closed')).toEqual([]);
    expect(h.state.workers.has('qa-1')).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // The claim guard holds a row for its owner, never for a seat that left it.
  // Rows are seeded unassigned or assigned directly, never by clearing a seat
  // through updateTask, which would itself close the attempt under test.
  // ---------------------------------------------------------------------------

  async function seedReconcilingRow(assignedWorkerId: string | null): Promise<void> {
    h.createTask({ id: 'task-O', status: 'WORKING', assignedWorkerId });
    if (assignedWorkerId) h.createWorker({ id: assignedWorkerId, status: 'CODING', currentTaskId: 'task-O' });
    await h.state.load();
    const parked = await openAttempt(h.state, {
      taskId: 'task-O',
      workerId: 'qa-1',
      runnerId: 'qa-1',
      workspace: h.testDir,
    });
    await setAttemptPhase(h.state, parked.id, 'reconciling');
  }

  it('an explicit claim of an unassigned row closes its orphaned reconciling attempt and opens the successor', async () => {
    await seedReconcilingRow(null);

    const taken = await claim('task-O', 'worker-2', 'WORKING');

    expect(taken.hasNext).toBe(true);
    expect(taken.generation).toBe(2);
    expect(phases('task-O')).toEqual([[1, 'closed'], [2, 'running']]);
    expect(h.state.getTask('task-O')?.assignedWorkerId).toBe('worker-2');
  });

  it('refuses a row assigned to a different worker as assigned, not as reconciling', async () => {
    await seedReconcilingRow('worker-9');

    const err = await refusal(claim('task-O', 'worker-2', 'WORKING'));

    expect(err.codeName).toBe('NOT_ALLOWED');
    expect(err.message).toContain('already assigned to worker-9');
    expect(phases('task-O')).toEqual([[1, 'reconciling']]);
  });

  it('still refuses a third party while the row is assigned to the reconciling holder', async () => {
    await seedReconcilingRow('qa-1');

    const err = await refusal(claim('task-O', 'worker-2', 'WORKING'));

    expect(err.codeName).toBe('ATTEMPT_RECONCILING');
    expect(h.state.getTask('task-O')?.assignedWorkerId).toBe('qa-1');
    expect(phases('task-O')).toEqual([[1, 'reconciling']]);
  });
});
