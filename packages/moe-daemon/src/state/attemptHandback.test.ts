import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { ToolTestHarness } from '../tools/toolTestHarness.js';
import type { ToolDefinition } from '../tools/index.js';
import { acquireResourceTool } from '../tools/acquireResource.js';
import { archiveEpicTool } from '../tools/archiveEpic.js';
import { archiveTaskTool } from '../tools/archiveTask.js';
import { claimNextTaskTool } from '../tools/claimNextTask.js';
import { completeTaskTool } from '../tools/completeTask.js';
import { deleteTaskTool } from '../tools/deleteTask.js';
import { deregisterWorkerTool } from '../tools/deregisterWorker.js';
import { finalizeAttemptTool } from '../tools/finalizeAttempt.js';
import { getContextTool } from '../tools/getContext.js';
import { qaApproveTool } from '../tools/qaApprove.js';
import { qaRejectTool } from '../tools/qaReject.js';
import { recordCandidateTool } from '../tools/recordCandidate.js';
import { reportBlockedTool } from '../tools/reportBlocked.js';
import { setTaskStatusTool } from '../tools/setTaskStatus.js';
import { clearAllSpeedModeTimeouts, submitPlanTool } from '../tools/submitPlan.js';
import { unblockWorkerTool } from '../tools/unblockWorker.js';
import { activeWaiters, waitForTaskTool } from '../tools/waitForTask.js';
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
    // A waiter that a failing case left parked must never resolve into the next case.
    for (const waiter of Array.from(activeWaiters.values())) waiter.unsubscribe();
    activeWaiters.clear();
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

  // ---------------------------------------------------------------------------
  // A finalizing landing is not superseded by another seat (task-758423de).
  //
  // complete_task parks the worker's attempt in `finalizing` and unassigns the
  // REVIEW row; the runner records its candidate and finalizes only after the
  // CLI exits. A QA claim of that row used to close the attempt through
  // openClaimAttempt's ATTEMPT_ALREADY_OPEN arm, so qa_approve's hold vanished
  // and the runner's fenced record_candidate was refused as superseded. Until
  // the boundary ends, no seat other than the attempt's own worker may claim it.
  // ---------------------------------------------------------------------------

  describe('a finalizing landing is not superseded by another seat', () => {
    const LANDED = 'b2'.repeat(20);

    interface Landing {
      attemptId: string;
      generation: number;
    }

    /** worker-1 claims and completes task-W: REVIEW, unassigned, generation 1 finalizing. */
    async function completeClaimedRow(): Promise<Landing> {
      await seedClaimedWorkingRow({ implementationPlan: DONE_PLAN });
      const completed = await call(completeTaskTool(h.state), {
        taskId: 'task-W',
        workerId: 'worker-1',
        verification: { command: 'npm test', exitCode: 0 },
      });
      expect(h.state.getTask('task-W')).toMatchObject({ status: 'REVIEW', assignedWorkerId: null });
      expect(phases('task-W')).toEqual([[1, 'finalizing']]);
      expect(completed.generation).toBe(1);
      return { attemptId: completed.attemptId as string, generation: completed.generation as number };
    }

    /** The runner's acknowledgement, sent with the identity complete_task returned. */
    function finalize(landing: Landing, by = 'worker-1', outcome = 'landed'): Promise<Record<string, unknown>> {
      return call(finalizeAttemptTool(h.state), {
        taskId: 'task-W',
        attemptId: landing.attemptId,
        generation: landing.generation,
        workerId: by,
        runnerId: by,
        outcome,
        ...(outcome === 'landed' ? { landedRevision: LANDED } : {}),
      });
    }

    function waitForReview(timeoutMs: number): Promise<Record<string, unknown>> {
      return call(waitForTaskTool(h.state), { statuses: ['REVIEW'], workerId: 'qa-1', timeoutMs });
    }

    /** Non-closed attempts a seat holds anywhere on the board. */
    function openAttemptsOf(workerId: string): Phases {
      return listAttempts(h.state)
        .filter((a) => a.workerId === workerId && a.phase !== 'closed')
        .map((a): [number, ExecutionAttemptPhase] => [a.generation, a.phase]);
    }

    /** Both finalizing holds name the attempt's holder, never the refused caller. */
    function expectHeldForWorker1(err: MoeError, landing: Landing): void {
      expect(err.code).toBe(-32002);
      expect(err.codeName).toBe('ATTEMPT_FINALIZING');
      expect(err.context).toEqual({
        attemptId: landing.attemptId,
        generation: 1,
        taskId: 'task-W',
        workerId: 'worker-1',
        retryable: true,
      });
    }

    /**
     * A claim refused before any write: no task write and no published event.
     * The end state alone cannot show it, because the post-write backstop in
     * openClaimAttempt hands its assignment back and ends in the same state.
     */
    async function refusedWithoutWrites(claimed: () => Promise<unknown>): Promise<MoeError> {
      const updates = vi.spyOn(h.state, 'updateTask');
      const published: string[] = [];
      const unsubscribe = h.state.subscribe((event) => {
        published.push(event.type);
      });
      const err = await refusal(claimed());
      unsubscribe();
      expect(published).toEqual([]);
      expect(updates).not.toHaveBeenCalled();
      updates.mockRestore();
      return err;
    }

    it('refuses a QA claim until the landing is finalized, keeps the runner current and holds qa_approve', async () => {
      const landing = await completeClaimedRow();

      const err = await refusedWithoutWrites(() => claim('task-W', 'qa-1', 'REVIEW'));

      expectHeldForWorker1(err, landing);
      expect(err.message).toContain('held by worker worker-1');
      expect(err.message).toContain(landing.attemptId);
      expect(err.message).toContain('no other seat may claim it');
      expect(err.message).toContain('moe.finalize_attempt');
      expect(h.state.getTask('task-W')?.assignedWorkerId).toBeNull();
      expect(openAttemptsOf('qa-1')).toEqual([]);
      expect(phases('task-W')).toEqual([[1, 'finalizing']]);

      // The runner's post-flight records its candidate with the identity it pinned.
      const recorded = await call(recordCandidateTool(h.state), {
        taskId: 'task-W',
        attemptId: landing.attemptId,
        generation: landing.generation,
        workerId: 'worker-1',
        id: 'cand-1',
        baseRevision: 'a1'.repeat(20),
        treeSha: 'c3'.repeat(20),
        deliveryTarget: 'refs/heads/wave1-pilot',
      });
      expect(recorded.success).toBe(true);
      expect(recorded.candidate).toMatchObject({ id: 'cand-1', taskId: 'task-W', attemptId: landing.attemptId });

      // The hold runs before qa_approve's ownership checks, so it answers first.
      const approval = await refusal(
        call(qaApproveTool(h.state), { taskId: 'task-W', workerId: 'qa-1', summary: 'Approving before the landing is acknowledged.' })
      );
      expectHeldForWorker1(approval, landing);
      expect(h.state.getTask('task-W')?.status).toBe('REVIEW');

      const finalized = await finalize(landing);
      expect(finalized).toMatchObject({ success: true, phase: 'closed', outcome: 'landed', landedRevision: LANDED });
      expect(phases('task-W')).toEqual([[1, 'closed']]);

      const retried = await claimForReview('task-W', 'qa-1');
      expect(retried.hasNext).toBe(true);
      expect(retried.generation).toBe(2);
      expect(phases('task-W')).toEqual([[1, 'closed'], [2, 'running']]);

      const approved = await call(qaApproveTool(h.state), {
        taskId: 'task-W',
        workerId: 'qa-1',
        summary: 'Re-ran npm test after the landing was finalized.',
        candidateId: 'cand-1',
      });
      expect(approved.status).toBe('DONE');
      expect(phases('task-W')).toEqual([[1, 'closed'], [2, 'closed']]);
    });

    it('skips the finalizing row in the ranked pool without throwing, then offers it once finalized', async () => {
      const landing = await completeClaimedRow();

      const skipped = await call(claimNextTaskTool(h.state), { statuses: ['REVIEW'], workerId: 'qa-1' });
      // A claim that names no worker assigns nothing, and it must not report the row either.
      const peeked = await call(claimNextTaskTool(h.state), { statuses: ['REVIEW'] });

      expect(skipped.hasNext).toBe(false);
      expect(skipped.nextAction).toMatchObject({ tool: 'moe.wait_for_task' });
      expect(peeked.hasNext).toBe(false);
      expect(h.state.getTask('task-W')?.assignedWorkerId).toBeNull();
      expect(openAttemptsOf('qa-1')).toEqual([]);
      expect(phases('task-W')).toEqual([[1, 'finalizing']]);

      await finalize(landing);
      const offered = await call(claimNextTaskTool(h.state), { statuses: ['REVIEW'], workerId: 'qa-1' });

      expect(offered.hasNext).toBe(true);
      expect(offered.task).toMatchObject({ id: 'task-W', assignedWorkerId: 'qa-1' });
      expect(offered.generation).toBe(2);
      expect(phases('task-W')).toEqual([[1, 'closed'], [2, 'running']]);
    });

    it('refuses an explicit claim that names no worker, naming the holder and writing nothing', async () => {
      const landing = await completeClaimedRow();

      // The operator recipe for finding a held row: a directed claim sent without a workerId.
      const err = await refusedWithoutWrites(() =>
        call(claimNextTaskTool(h.state), { statuses: ['REVIEW'], taskId: 'task-W' })
      );

      expectHeldForWorker1(err, landing);
      expect(err.message).toContain(`held by worker worker-1's attempt ${landing.attemptId} (generation 1)`);
      expect(h.state.getTask('task-W')?.assignedWorkerId).toBeNull();
      expect(phases('task-W')).toEqual([[1, 'finalizing']]);
    });

    it('keeps a QA waiter parked while the landing is finalizing and wakes it when the boundary ends', async () => {
      const landing = await completeClaimedRow();

      // Waiters are keyed by workerId: the first must resolve before the second starts.
      const idle = await waitForReview(1000);
      expect(idle).toMatchObject({ hasNext: false, timedOut: true });

      const woken = waitForReview(5000);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(activeWaiters.has('qa-1')).toBe(true);

      await finalize(landing);
      const result = await woken;

      expect(result.hasNext).toBe(true);
      expect(result.task).toMatchObject({ id: 'task-W', status: 'REVIEW' });
      expect(activeWaiters.has('qa-1')).toBe(false);
    }, 15_000);

    it('publishes one TASK_UPDATED when a finalize ends the boundary and none on its idempotent replay', async () => {
      const landing = await completeClaimedRow();
      const published: string[] = [];
      h.state.subscribe((event) => {
        if (event.type === 'TASK_UPDATED') published.push(event.payload.id);
      });

      await finalize(landing);
      expect(published).toEqual(['task-W']);

      const replay = await finalize(landing);
      expect(replay).toMatchObject({ success: true, phase: 'closed' });
      expect(published).toEqual(['task-W']);
    });

    it('deregister_worker closes its own finalizing attempt so an exiting runner cannot wedge the row', async () => {
      await completeClaimedRow();

      const result = await call(deregisterWorkerTool(h.state), { workerId: 'worker-1', reason: 'terminal_closed' });

      expect(result).toMatchObject({ success: true, alreadyDead: false, releasedTaskIds: [] });
      expect(phases('task-W')).toEqual([[1, 'closed']]);
      const taken = await claim('task-W', 'qa-1', 'REVIEW');
      expect(taken.hasNext).toBe(true);
      expect(taken.generation).toBe(2);
    });

    it('deregister_worker closes the finalizing attempt even after the worker record was pruned', async () => {
      await completeClaimedRow();
      await h.state.deleteWorker('worker-1');
      expect(h.state.workers.has('worker-1')).toBe(false);
      expect(phases('task-W')).toEqual([[1, 'finalizing']]);

      const result = await call(deregisterWorkerTool(h.state), { workerId: 'worker-1', reason: 'terminal_closed' });

      expect(result).toMatchObject({ success: true, alreadyDead: true, releasedTaskIds: [] });
      expect(phases('task-W')).toEqual([[1, 'closed']]);
    });

    it('closes a DEAD worker finalizing attempt on a retried deregister without chat, activity or worker events', async () => {
      await completeClaimedRow();
      await h.state.updateWorker('worker-1', { status: 'DEAD' });
      const posted = vi.spyOn(h.state, 'postToRoleChannel');
      const activity = vi.spyOn(h.state, 'appendActivity');
      const published: string[] = [];
      h.state.subscribe((event) => {
        published.push(event.type);
      });

      const result = await call(deregisterWorkerTool(h.state), { workerId: 'worker-1', reason: 'terminal_closed' });

      expect(result).toMatchObject({ success: true, alreadyDead: true, releasedTaskIds: [] });
      expect(phases('task-W')).toEqual([[1, 'closed']]);
      expect(posted).not.toHaveBeenCalled();
      expect(activity).not.toHaveBeenCalled();
      expect(published).toEqual(['TASK_UPDATED']);
    });

    it('a deregister whose finalizing close fails still succeeds, and its quiet retry closes the attempt', async () => {
      await completeClaimedRow();
      const realWrite = h.state.writeEntity.bind(h.state);
      vi.spyOn(h.state, 'writeEntity').mockImplementation(async (...args: Parameters<StateManager['writeEntity']>) => {
        if (args[0] === 'attempts') throw new Error('EPERM: attempt record is unwritable');
        return realWrite(...args);
      });

      const first = await call(deregisterWorkerTool(h.state), { workerId: 'worker-1', reason: 'terminal_closed' });

      vi.restoreAllMocks();
      expect(first).toMatchObject({ success: true, alreadyDead: false, releasedTaskIds: [] });
      expect(h.state.getWorker('worker-1')?.status).toBe('DEAD');
      expect(phases('task-W')).toEqual([[1, 'finalizing']]);

      const posted = vi.spyOn(h.state, 'postToRoleChannel');
      const retried = await call(deregisterWorkerTool(h.state), { workerId: 'worker-1', reason: 'terminal_closed' });

      expect(retried).toMatchObject({ success: true, alreadyDead: true, releasedTaskIds: [] });
      expect(posted).not.toHaveBeenCalled();
      expect(phases('task-W')).toEqual([[1, 'closed']]);
    });

    it("leaves another worker's landing hold alone when a different seat deregisters", async () => {
      h.createWorker({ id: 'qa-1' });
      const landing = await completeClaimedRow();

      const result = await call(deregisterWorkerTool(h.state), { workerId: 'qa-1', reason: 'terminal_closed' });

      expect(result).toMatchObject({ success: true, alreadyDead: false, releasedTaskIds: [] });
      expect(phases('task-W')).toEqual([[1, 'finalizing']]);
      expectHeldForWorker1(await refusal(claim('task-W', 'qa-2', 'REVIEW')), landing);
    });

    it('still refuses the attempt owner its next claim with the worker-scoped refusal', async () => {
      h.createTask({ id: 'task-2', status: 'WORKING', order: 2 });
      const landing = await completeClaimedRow();

      const err = await refusal(claim('task-2', 'worker-1', 'WORKING'));

      expectHeldForWorker1(err, landing);
      expect(err.message).toContain('Close the boundary with moe.finalize_attempt');
      expect(h.state.getTask('task-2')?.assignedWorkerId).toBeNull();
      expect(phases('task-2')).toEqual([]);
    });

    it('lets a governor close an abandoned boundary with outcome failed, which wakes a parked QA waiter that can then claim', async () => {
      const landing = await completeClaimedRow();
      const woken = waitForReview(5000);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(activeWaiters.has('qa-1')).toBe(true);

      const closed = await finalize(landing, 'governor-1', 'failed');

      expect(closed).toMatchObject({ success: true, phase: 'closed', outcome: 'failed', landedRevision: null });
      expect(phases('task-W')).toEqual([[1, 'closed']]);
      expect(await woken).toMatchObject({ hasNext: true, task: { id: 'task-W', status: 'REVIEW' } });
      const taken = await claim('task-W', 'qa-1', 'REVIEW');
      expect(taken.hasNext).toBe(true);
      expect(taken.generation).toBe(2);
    }, 15_000);

    it('holds rework after a human qa_reject until the landing is finalized', async () => {
      const landing = await completeClaimedRow();

      const rejected = await call(qaRejectTool(h.state), { taskId: 'task-W', reason: 'DoD item 1 fails' });
      expect(rejected.status).toBe('WORKING');
      expect(h.state.getTask('task-W')).toMatchObject({ status: 'WORKING', assignedWorkerId: null });
      expect(phases('task-W')).toEqual([[1, 'finalizing']]);

      const err = await refusal(claim('task-W', 'worker-2', 'WORKING'));
      expectHeldForWorker1(err, landing);
      expect(err.message).toContain('no other seat may claim it');
      expect(h.state.getTask('task-W')?.assignedWorkerId).toBeNull();
      expect(openAttemptsOf('worker-2')).toEqual([]);

      await finalize(landing, 'worker-1', 'nothing-to-commit');
      const retaken = await claim('task-W', 'worker-2', 'WORKING');
      expect(retaken.hasNext).toBe(true);
      expect(retaken.generation).toBe(2);
      expect(phases('task-W')).toEqual([[1, 'closed'], [2, 'running']]);
    });

    it('never lets a malformed finalizing record hold a row: the next claim supersedes it as before', async () => {
      h.createTask({ id: 'task-X', status: 'REVIEW', implementationPlan: DONE_PLAN });
      await h.state.load();
      const opened = await openAttempt(h.state, {
        taskId: 'task-X',
        workerId: 'worker-1',
        runnerId: 'worker-1',
        workspace: h.testDir,
      });
      const held = await setAttemptPhase(h.state, opened.id, 'finalizing');
      // loadEntities admits any JSON carrying an id, so a hand-edited record can lose its worker.
      h.state.attempts.set(held.id, { ...held, workerId: '' });

      const taken = await claim('task-X', 'qa-1', 'REVIEW');

      expect(taken.hasNext).toBe(true);
      expect(taken.generation).toBe(2);
      expect(phases('task-X')).toEqual([[1, 'closed'], [2, 'running']]);
    });

    // -------------------------------------------------------------------------
    // Every finalizing attempt has a close path (task-686afecb).
    //
    // finalize_attempt and the attempt's own deregister_worker used to be the
    // only ends, so three shapes held the row and its runner forever: a deleted
    // task, a terminal move that shelved the row with the hold still open, and a
    // runner that vanished without its exit trap. No new end reads an idle
    // signal: a quiet seat keeps its hold, and only a DEAD record is evidence.
    // -------------------------------------------------------------------------

    describe('every finalizing attempt has a close path (task-686afecb)', () => {
      /**
       * task-X in REVIEW, assigned to a quiet IDLE qa-1, while worker-1's landing
       * on it is still finalizing. Seeded on disk and opened directly: building
       * the mismatch by clearing a seat through updateTask would close the
       * attempt under test at seeding time.
       */
      async function seedLandingUnderAnotherSeat(): Promise<void> {
        h.createTask({ id: 'task-X', status: 'REVIEW', assignedWorkerId: 'qa-1', implementationPlan: DONE_PLAN });
        h.createWorker({ id: 'qa-1', status: 'IDLE', currentTaskId: 'task-X', lastActivityAt: QUIET_FOR_HOURS });
        await h.state.load();
        const opened = await openAttempt(h.state, {
          taskId: 'task-X',
          workerId: 'worker-1',
          runnerId: 'worker-1',
          workspace: h.testDir,
        });
        await setAttemptPhase(h.state, opened.id, 'finalizing');
      }

      /** What a deregister whose close failed leaves: the seat DEAD, its landing hold still open. */
      async function deadWithLandingHold(): Promise<void> {
        await completeClaimedRow();
        await h.state.updateWorker('worker-1', { status: 'DEAD' });
      }

      it('delete_task closes the finalizing attempt and frees its runner for other work', async () => {
        h.createTask({ id: 'task-2', status: 'WORKING', order: 2 });
        const landing = await completeClaimedRow();
        expectHeldForWorker1(await refusal(claim('task-2', 'worker-1', 'WORKING')), landing);

        await call(deleteTaskTool(h.state), { taskId: 'task-W' });

        expect(h.state.getTask('task-W')).toBeNull();
        expect(phases('task-W')).toEqual([[1, 'closed']]);
        const next = await claim('task-2', 'worker-1', 'WORKING');
        expect(next.hasNext).toBe(true);
        expect(next.task).toMatchObject({ id: 'task-2', assignedWorkerId: 'worker-1' });
        expect(phases('task-2')).toEqual([[1, 'running']]);
      });

      it.each(['running', 'reconciling'] as const)('delete_task closes a %s attempt of the task it deletes', async (phase) => {
        h.createTask({ id: 'task-O', status: 'WORKING', assignedWorkerId: 'worker-1' });
        h.createWorker({ id: 'worker-1', status: 'CODING', currentTaskId: 'task-O' });
        await h.state.load();
        const opened = await openAttempt(h.state, {
          taskId: 'task-O',
          workerId: 'worker-1',
          runnerId: 'worker-1',
          workspace: h.testDir,
        });
        await setAttemptPhase(h.state, opened.id, phase);

        await call(deleteTaskTool(h.state), { taskId: 'task-O' });

        expect(h.state.getTask('task-O')).toBeNull();
        expect(phases('task-O')).toEqual([[1, 'closed']]);
      });

      it('delete_task deletes nothing when the close cannot be written, and its retry finishes the job', async () => {
        await completeClaimedRow();
        const realWrite = h.state.writeEntity.bind(h.state);
        vi.spyOn(h.state, 'writeEntity').mockImplementation(async (...args: Parameters<StateManager['writeEntity']>) => {
          if (args[0] === 'attempts') throw new Error('EPERM: attempt record is unwritable');
          return realWrite(...args);
        });

        await expect(call(deleteTaskTool(h.state), { taskId: 'task-W' })).rejects.toThrow('EPERM');

        vi.restoreAllMocks();
        expect(h.state.getTask('task-W')).toMatchObject({ id: 'task-W', status: 'REVIEW' });
        expect(fs.existsSync(path.join(h.moePath, 'tasks', 'task-W.json'))).toBe(true);
        expect(phases('task-W')).toEqual([[1, 'finalizing']]);

        await call(deleteTaskTool(h.state), { taskId: 'task-W' });
        expect(h.state.getTask('task-W')).toBeNull();
        expect(phases('task-W')).toEqual([[1, 'closed']]);
      });

      it('a delete_task refused by a failed close leaves a SPEED-mode auto-approval armed', async () => {
        const projectFile = path.join(h.moePath, 'project.json');
        const project = JSON.parse(fs.readFileSync(projectFile, 'utf8'));
        project.settings = { ...project.settings, approvalMode: 'SPEED', speedModeDelayMs: 1000 };
        fs.writeFileSync(projectFile, JSON.stringify(project));
        h.createTask({ id: 'task-P', status: 'PLANNING' });
        await h.state.load();
        // A landing still finalizing when its row went back to planning.
        const opened = await openAttempt(h.state, {
          taskId: 'task-P',
          workerId: 'worker-1',
          runnerId: 'worker-1',
          workspace: h.testDir,
        });
        await setAttemptPhase(h.state, opened.id, 'finalizing');
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        try {
          await call(submitPlanTool(h.state), { taskId: 'task-P', steps: [{ description: 'Step 1' }] });
          expect(h.state.getTask('task-P')?.status).toBe('AWAITING_APPROVAL');
          const realWrite = h.state.writeEntity.bind(h.state);
          vi.spyOn(h.state, 'writeEntity').mockImplementation(async (...args: Parameters<StateManager['writeEntity']>) => {
            if (args[0] === 'attempts') throw new Error('EPERM: attempt record is unwritable');
            return realWrite(...args);
          });

          await expect(call(deleteTaskTool(h.state), { taskId: 'task-P' })).rejects.toThrow('EPERM');

          vi.restoreAllMocks();
          await vi.advanceTimersByTimeAsync(1500);
          // The approval persists through real async fs I/O, which fake timers do
          // not drive: back on real timers, poll until it settles.
          vi.useRealTimers();
          await vi.waitFor(() => expect(h.state.getTask('task-P')?.status).toBe('WORKING'), {
            timeout: 2000,
            interval: 20,
          });
        } finally {
          clearAllSpeedModeTimeouts();
          vi.useRealTimers();
        }
      });

      it('a restart closes a finalizing attempt whose task vanished out of band, and the purge then drops the quiet seat', async () => {
        await completeClaimedRow();
        // Removed outside the daemon (a git checkout of .moe/tasks, a hand
        // deletion): no delete_task ran, and finalize_attempt refuses a missing
        // task before it ever looks the attempt up.
        fs.unlinkSync(path.join(h.moePath, 'tasks', 'task-W.json'));
        h.state.tasks.delete('task-W');
        await h.state.updateWorker('worker-1', { lastActivityAt: QUIET_FOR_HOURS });

        await reconcileRunningAttempts(h.state);
        expect(phases('task-W')).toEqual([[1, 'closed']]);

        await h.state.purgeAllWorkers();
        expect(h.state.workers.has('worker-1')).toBe(false);
      });

      it('refuses every move into DONE or ARCHIVED before any write while the landing is finalizing', async () => {
        const landing = await completeClaimedRow();
        const writes = vi.spyOn(h.state, 'writeEntity');
        const published: string[] = [];
        const unsubscribe = h.state.subscribe((event) => {
          published.push(event.type);
        });

        const moves: Array<() => Promise<unknown>> = [
          () => call(setTaskStatusTool(h.state), { taskId: 'task-W', status: 'DONE' }),
          () => call(setTaskStatusTool(h.state), { taskId: 'task-W', status: 'ARCHIVED' }),
          () => call(archiveTaskTool(h.state), { taskId: 'task-W' }),
        ];
        for (const move of moves) {
          expectHeldForWorker1(await refusal(move()), landing);
          expect(writes).not.toHaveBeenCalled();
          expect(published).toEqual([]);
          expect(h.state.getTask('task-W')).toMatchObject({ status: 'REVIEW', assignedWorkerId: null });
        }

        unsubscribe();
        expect(phases('task-W')).toEqual([[1, 'finalizing']]);

        writes.mockRestore();
        await finalize(landing);
        const done = await call(setTaskStatusTool(h.state), { taskId: 'task-W', status: 'DONE' });
        expect(done).toMatchObject({ success: true, status: 'DONE' });
      });

      it('archive_epic refuses before archiving anything while a task of the epic is finalizing', async () => {
        h.createTask({ id: 'task-B', status: 'BACKLOG', order: 2 });
        const landing = await completeClaimedRow();
        // archive_epic walks the tasks in map order. Put the resting sibling
        // first, so a refusal raised only when the loop reached task-W would
        // find the sibling already archived.
        const held = h.state.tasks.get('task-W')!;
        h.state.tasks.delete('task-W');
        h.state.tasks.set('task-W', held);

        expectHeldForWorker1(await refusal(call(archiveEpicTool(h.state), { epicId: 'epic-1' })), landing);

        expect(h.state.getTask('task-B')?.status).toBe('BACKLOG');
        expect(h.state.getTask('task-W')?.status).toBe('REVIEW');
        expect(h.state.getEpic('epic-1')?.status).toBe('ACTIVE');
      });

      it('tells a non-holder moving the row into DONE or ARCHIVED to wait for the runner, never to close the boundary itself', async () => {
        const landing = await completeClaimedRow();

        const refusals = [
          await refusal(call(setTaskStatusTool(h.state), { taskId: 'task-W', status: 'DONE' })),
          await refusal(call(archiveEpicTool(h.state), { epicId: 'epic-1' })),
        ];

        for (const err of refusals) {
          expectHeldForWorker1(err, landing);
          expect(err.message).toContain("is held by worker worker-1's attempt");
          expect(err.message).toContain(`${landing.attemptId} (generation ${landing.generation})`);
          expect(err.message).toContain('moving this task into DONE or ARCHIVED');
          expect(err.message).toContain("wait for that worker's runner to call moe.finalize_attempt");
          expect(err.message).toContain('Do NOT close the boundary to get past this refusal');
          expect(err.message).not.toContain('Close the boundary with moe.finalize_attempt, then retry');
        }
      });

      it('removing a DEAD worker record closes its finalizing attempt and hands the row to QA', async () => {
        await deadWithLandingHold();
        const published: string[] = [];
        h.state.subscribe((event) => {
          if (event.type === 'TASK_UPDATED') published.push(event.payload.id);
        });

        await h.state.deleteWorker('worker-1');

        expect(h.state.workers.has('worker-1')).toBe(false);
        expect(phases('task-W')).toEqual([[1, 'closed']]);
        expect(published).toEqual(['task-W']);
        const taken = await claim('task-W', 'qa-1', 'REVIEW');
        expect(taken.hasNext).toBe(true);
        expect(taken.generation).toBe(2);
      });

      it('keeps a DEAD record whose close fails again, so the next prune retries the close', async () => {
        await deadWithLandingHold();
        const realWrite = h.state.writeEntity.bind(h.state);
        vi.spyOn(h.state, 'writeEntity').mockImplementation(async (...args: Parameters<StateManager['writeEntity']>) => {
          if (args[0] === 'attempts') throw new Error('EPERM: attempt record is unwritable');
          return realWrite(...args);
        });

        await h.state.deleteWorker('worker-1');

        vi.restoreAllMocks();
        expect(h.state.getWorker('worker-1')?.status).toBe('DEAD');
        expect(fs.existsSync(path.join(h.moePath, 'workers', 'worker-1.json'))).toBe(true);
        expect(phases('task-W')).toEqual([[1, 'finalizing']]);

        await h.state.deleteWorker('worker-1');
        expect(h.state.workers.has('worker-1')).toBe(false);
        expect(phases('task-W')).toEqual([[1, 'closed']]);
      });

      it("removing an IDLE assignee's record never closes another worker's finalizing attempt on the task it releases", async () => {
        await seedLandingUnderAnotherSeat();

        await h.state.deleteWorker('qa-1');

        expect(h.state.getTask('task-X')).toMatchObject({ status: 'REVIEW', assignedWorkerId: null });
        expect(phases('task-X')).toEqual([[1, 'finalizing']]);
      });

      it('the startup purge closes a DEAD worker finalizing attempt and drops its record', async () => {
        await deadWithLandingHold();

        await reconcileRunningAttempts(h.state);
        await h.state.purgeAllWorkers();

        expect(phases('task-W')).toEqual([[1, 'closed']]);
        expect(h.state.workers.has('worker-1')).toBe(false);
        expect(fs.existsSync(path.join(h.moePath, 'workers', 'worker-1.json'))).toBe(false);
      });

      it('the startup purge keeps a quiet IDLE worker finalizing attempt and spares its record', async () => {
        await completeClaimedRow();
        await h.state.updateWorker('worker-1', { lastActivityAt: QUIET_FOR_HOURS });
        expect(h.state.getWorker('worker-1')?.status).toBe('IDLE');

        await reconcileRunningAttempts(h.state);
        await h.state.purgeAllWorkers();

        expect(phases('task-W')).toEqual([[1, 'finalizing']]);
        expect(h.state.workers.has('worker-1')).toBe(true);
      });

      it("the startup purge never closes another worker's finalizing attempt on a task whose purged assignee it releases", async () => {
        await seedLandingUnderAnotherSeat();

        await reconcileRunningAttempts(h.state);
        await h.state.purgeAllWorkers();

        expect(h.state.workers.has('qa-1')).toBe(false);
        expect(h.state.getTask('task-X')).toMatchObject({ status: 'REVIEW', assignedWorkerId: null });
        expect(phases('task-X')).toEqual([[1, 'finalizing']]);
      });
    });
  });
});
