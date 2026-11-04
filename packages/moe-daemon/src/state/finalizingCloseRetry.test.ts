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
// instead of leaving it for QA's landed gate to park BLOCKED. Every other row
// keeps the plain close.
// =============================================================================

describe('a finalizing close with no completion recorded routes a worktree landing for a retry', () => {
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

  const KEPT: Array<[string, Partial<Task>, ExecutionWorkspaceMode | 'legacy']> = [
    ['a REVIEW row with a completion recorded this round', { commits: [completion('2026-11-04T00:10:00.000Z')] }, 'worktree'],
    ['a shared-mode attempt', {}, 'shared'],
    ['an attempt with no recorded mode', {}, 'legacy'],
    ['a row no longer in REVIEW', { status: 'WORKING' }, 'worktree'],
    ['a REVIEW row another seat holds', { assignedWorkerId: 'qa-1' }, 'worktree'],
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
