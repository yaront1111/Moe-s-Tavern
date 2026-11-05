import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'path';
import { ToolTestHarness } from '../tools/toolTestHarness.js';
import { deregisterWorkerTool } from '../tools/deregisterWorker.js';
import { listAttempts, openAttempt, reconcileRunningAttempts, setAttemptPhase } from './attemptStore.js';
import type { ExecutionAttempt, ExecutionAttemptPhase, ExecutionWorkspaceMode, Task, TaskCommit } from '../types/schema.js';

// =============================================================================
// A worktree worker's runner that ends mid-landing (task-87cba58c, 2026-11-04:
// the IDE closed the seat's tab while its wrapper waited for the land lease)
// leaves its attempt finalizing and nothing published. The close of that
// attempt (moe.deregister_worker, or removing the seat's DEAD record) must route
// the REVIEW row back for a landing retry exactly as an unlanded finalize does,
// instead of leaving it for QA's landed gate to park BLOCKED.
//
// A shared-checkout runner that ends the same way gets the same routing. Its
// plain close used to leave the row for qa_approve, whose legacy commit gate
// only warns, and a DONE task is never pre-flighted again: P2-2.2.2 (sentinal,
// 2026-07-28) sat DONE with commits=[] and its 13 paths dirty for 100 days.
// Every other row keeps the plain close.
// =============================================================================

describe('a finalizing close with no completion recorded routes the landing for a retry', () => {
  const h = new ToolTestHarness();
  const ROUND_START = '2026-11-04T00:00:00.000Z';
  const PLAN = ['step-1', 'step-2'].map((stepId) => ({
    stepId, description: stepId, status: 'COMPLETED' as const, affectedFiles: [],
  }));
  const task = () => h.state.getTask('task-1')!;
  const phases = () => listAttempts(h.state, 'task-1')
    .map((a): [number, ExecutionAttemptPhase] => [a.generation, a.phase]);
  const completion = (recordedAt: string): TaskCommit => ({
    sha: 'c4'.repeat(20), ref: 'refs/heads/moe/work-2026-10-24', kind: 'completion', status: 'REVIEW',
    role: 'worker', sessionId: `worker-1@${ROUND_START}`, paths: ['src/a.ts'], pushed: true,
    recordedBy: 'worker-1', recordedAt,
  });
  /** The ledger row a wrapper's rescue_ref records (kind rescue, the reason in its message). */
  const rescue = (recordedAt: string, reason: string): TaskCommit => {
    const ref = `refs/moe/rescue/task-1/${recordedAt.replace(/[-:]|\.\d+/g, '')}`;
    return {
      sha: 'e6'.repeat(20), ref, kind: 'rescue', status: 'REVIEW', role: 'worker',
      sessionId: `worker-1@${ROUND_START}`, paths: ['src/a.ts', 'src/b.ts'], pushed: false,
      recordedBy: 'worker-1', recordedAt, message: `MOE_RESCUE_REF task=task-1 ref=${ref} sha=${'e6'.repeat(20)} reason=${reason}`,
    };
  };

  beforeEach(() => {
    h.init();
    h.setupMoeFolder({ schemaVersion: 6 });
    h.createEpic();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    h.cleanup();
  });

  /** task-1 in REVIEW, every step done, with worker-1's attempt on it finalizing. */
  async function seed(over: Partial<Task> = {}, mode: ExecutionWorkspaceMode | 'legacy' = 'worktree'): Promise<ExecutionAttempt> {
    h.createTask({
      id: 'task-1', status: 'REVIEW', assignedWorkerId: null, reopenCount: 1,
      implementationPlan: PLAN, stepsCompleted: ['step-1', 'step-2'], workStartedAt: ROUND_START, ...over,
    });
    h.createWorker({ id: 'worker-1', status: 'IDLE', currentTaskId: null });
    await h.state.load();
    const opened = await openAttempt(h.state, {
      taskId: 'task-1', workerId: 'worker-1', runnerId: 'worker-1',
      workspace: path.join(h.testDir, '.worktrees', 'task-1'),
      ...(mode === 'legacy' ? {} : { workspaceMode: mode }),
    });
    return setAttemptPhase(h.state, opened.id, 'finalizing');
  }

  const CLOSERS: Record<string, () => Promise<void>> = {
    'moe.deregister_worker': async () => {
      const result = await deregisterWorkerTool(h.state).handler({ workerId: 'worker-1', reason: 'terminal_closed' }, h.state);
      expect(result).toMatchObject({ success: true, releasedTaskIds: [] });
    },
    'the DEAD-record prune (deleteWorker)': async () => {
      await h.state.updateWorker('worker-1', { status: 'DEAD' });
      await h.state.deleteWorker('worker-1');
      expect(h.state.workers.has('worker-1')).toBe(false);
    },
    'the startup purge': async () => {
      await h.state.updateWorker('worker-1', { status: 'DEAD' });
      await reconcileRunningAttempts(h.state);
      await h.state.purgeAllWorkers();
      expect(h.state.workers.has('worker-1')).toBe(false);
    },
  };

  it.each(Object.keys(CLOSERS))('%s routes an unrecorded REVIEW landing to WORKING with a contention retry', async (closer) => {
    const held = await seed();

    await CLOSERS[closer]();

    expect(phases()).toEqual([[1, 'closed']]);
    expect(task()).toMatchObject({
      status: 'WORKING', assignedWorkerId: null, reopenCount: 1,
      implementationPlan: PLAN, stepsCompleted: ['step-1', 'step-2'],
    });
    expect(task().landingRetry).toEqual({
      reason: 'contention', paths: [], rescueRef: 'refs/heads/moe/task/task-1', targetTip: null,
      count: 1, at: expect.any(String),
    });
    expect(task().comments).toHaveLength(1);
    expect(task().comments[0].author).toBe('moe-daemon');
    for (const text of [held.id, 'worker-1', 'no completion recorded', 'Landing unlanded (contention) 1 time(s)', 'task WORKING']) {
      expect(task().comments[0].content).toContain(text);
    }
  });

  it('a completion recorded before this round started does not count, so the row still routes', async () => {
    await seed({ commits: [completion('2026-11-03T23:59:59.000Z')] });

    await CLOSERS['moe.deregister_worker']();

    expect(task()).toMatchObject({ status: 'WORKING', landingRetry: { reason: 'contention', count: 1 } });
  });

  it('a completion recorded before a reopen (which records no rejection) does not count either', async () => {
    await seed({ commits: [completion('2026-11-04T00:10:00.000Z')], reopenedAt: '2026-11-04T01:00:00.000Z' });

    await CLOSERS['moe.deregister_worker']();

    expect(task()).toMatchObject({ status: 'WORKING', landingRetry: { reason: 'contention', count: 1 } });
  });

  it.each(['shared', 'legacy'] as const)('a %s-checkout attempt routes the row too, naming the task\'s rescue namespace', async (mode) => {
    const held = await seed({}, mode);

    await CLOSERS['moe.deregister_worker']();

    expect(phases()).toEqual([[1, 'closed']]);
    expect(task()).toMatchObject({
      status: 'WORKING', assignedWorkerId: null, reopenCount: 1,
      implementationPlan: PLAN, stepsCompleted: ['step-1', 'step-2'],
    });
    expect(task().landingRetry).toEqual({
      reason: 'contention', paths: [], rescueRef: 'refs/moe/rescue/task-1', targetTip: null,
      count: 1, at: expect.any(String),
    });
    for (const text of [held.id, 'no completion recorded', 'refs/moe/rescue/task-1', 'task WORKING']) {
      expect(task().comments[0].content).toContain(text);
    }
  });

  it('a shared close names the newest rescue ref recorded this round, with its paths and reason', async () => {
    await seed({ commits: [
      rescue('2026-11-03T23:00:00.000Z', 'gate-failed'),
      rescue('2026-11-04T00:20:00.000Z', 'gate-failed'),
      rescue('2026-11-04T00:30:00.000Z', 'teardown'),
    ] }, 'shared');

    await CLOSERS['moe.deregister_worker']();

    expect(task().landingRetry).toEqual({
      reason: 'contention', paths: ['src/a.ts', 'src/b.ts'], rescueRef: 'refs/moe/rescue/task-1/20261104T003000Z',
      targetTip: null, count: 1, at: expect.any(String),
    });
  });

  it('a shared close whose newest rescue this round is a gate failure carries reason gate', async () => {
    await seed({ commits: [rescue('2026-11-04T00:20:00.000Z', 'gate-failed')] }, 'shared');

    await CLOSERS['moe.deregister_worker']();

    expect(task()).toMatchObject({ status: 'WORKING', landingRetry: { reason: 'gate', count: 1 } });
  });

  it('a rescue recorded before this round started is not this round\'s, so the namespace is named', async () => {
    await seed({ commits: [rescue('2026-11-03T23:59:59.000Z', 'teardown')] }, 'shared');

    await CLOSERS['moe.deregister_worker']();

    expect(task().landingRetry).toMatchObject({ rescueRef: 'refs/moe/rescue/task-1', paths: [] });
  });

  const KEPT: Array<[string, Partial<Task>, ExecutionWorkspaceMode | 'legacy']> = [
    ['a REVIEW row with a completion recorded this round', { commits: [completion('2026-11-04T00:10:00.000Z')] }, 'worktree'],
    ['a row no longer in REVIEW', { status: 'WORKING' }, 'worktree'],
    ['a REVIEW row another seat holds', { assignedWorkerId: 'qa-1' }, 'worktree'],
    ['a shared REVIEW row with a completion recorded this round', { commits: [completion('2026-11-04T00:10:00.000Z')] }, 'shared'],
    ['a shared row no longer in REVIEW', { status: 'WORKING' }, 'shared'],
    ['a shared REVIEW row another seat holds', { assignedWorkerId: 'qa-1' }, 'shared'],
  ];

  it.each(KEPT)('keeps the plain close for %s', async (_label, over, mode) => {
    await seed(over, mode);
    const before = { status: task().status, assignedWorkerId: task().assignedWorkerId, comments: task().comments.length };

    await CLOSERS['moe.deregister_worker']();

    expect(phases()).toEqual([[1, 'closed']]);
    expect({ status: task().status, assignedWorkerId: task().assignedWorkerId, comments: task().comments.length }).toEqual(before);
    expect(task().landingRetry).toBeUndefined();
  });

  it('the third unlanded landing in a row is BLOCKED, as an unlanded finalize blocks it', async () => {
    await seed({ landingRetry: {
      reason: 'contention', paths: [], rescueRef: 'refs/moe/rescue/task-1/20261104T000000Z', targetTip: null,
      count: 2, at: ROUND_START,
    } });

    await CLOSERS['moe.deregister_worker']();

    expect(task()).toMatchObject({
      status: 'BLOCKED', assignedWorkerId: null, blockedFromStatus: 'WORKING', reopenCount: 1,
      blockedReason: expect.stringContaining('refs/heads/moe/task/task-1'),
      landingRetry: { reason: 'contention', count: 3 },
    });
  });

  it('a routing write that fails never fails the close: the call succeeds and the row stays in REVIEW', async () => {
    await seed();
    vi.spyOn(h.state, 'updateTask').mockRejectedValueOnce(new Error('EPERM: task record is unwritable'));

    await CLOSERS['moe.deregister_worker']();

    expect(phases()).toEqual([[1, 'closed']]);
    expect(task()).toMatchObject({ status: 'REVIEW', assignedWorkerId: null });
    expect(task().landingRetry).toBeUndefined();
  });
});
