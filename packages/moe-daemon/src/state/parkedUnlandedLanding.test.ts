import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'path';
import { ToolTestHarness } from '../tools/toolTestHarness.js';
import { deregisterWorkerTool } from '../tools/deregisterWorker.js';
import { getTools } from '../tools/index.js';
import { listAttempts, openAttempt, reconcileRunningAttempts, setAttemptPhase } from './attemptStore.js';
import type { ExecutionAttempt, Task } from '../types/schema.js';

// A REVIEW row the qa_reject hard cap parked for a human (needsHumanReview) while a
// worktree landing was still finalizing must stay parked when that landing ends
// unlanded: claim_next_task fences only REVIEW + needsHumanReview, so WORKING would
// hand a human-reserved row to the next worker.
describe('an unlanded landing keeps a row parked for a human in REVIEW', () => {
  const h = new ToolTestHarness();
  const ROUND_START = '2026-11-04T00:00:00.000Z';
  const PLAN = ['step-1', 'step-2'].map((stepId) => ({
    stepId, description: stepId, status: 'COMPLETED' as const, affectedFiles: [],
  }));
  const task = () => h.state.getTask('task-1')!;
  const call = async (name: string, args: Record<string, unknown>) => {
    const tool = getTools(h.state).find((t) => t.name === name)!;
    return await tool.handler(args, h.state) as Record<string, unknown>;
  };

  beforeEach(() => { h.init(); h.setupMoeFolder({ schemaVersion: 6 }); h.createEpic(); });
  afterEach(() => { vi.restoreAllMocks(); h.cleanup(); });

  /** task-1 in REVIEW, parked for a human, every step done, with worker-1's worktree attempt finalizing. */
  async function seed(over: Partial<Task> = {}): Promise<ExecutionAttempt> {
    h.createTask({
      id: 'task-1', status: 'REVIEW', assignedWorkerId: null, reopenCount: 5, needsHumanReview: true,
      implementationPlan: PLAN, stepsCompleted: ['step-1', 'step-2'], workStartedAt: ROUND_START, ...over,
    } as Partial<Task>);
    h.createWorker({ id: 'worker-1', status: 'IDLE', currentTaskId: null });
    h.createWorker({ id: 'worker-2', status: 'IDLE', currentTaskId: null });
    h.createWorker({ id: 'qa-1', status: 'IDLE', currentTaskId: null });
    await h.state.load();
    const opened = await openAttempt(h.state, {
      taskId: 'task-1', workerId: 'worker-1', runnerId: 'worker-1',
      workspace: path.join(h.testDir, '.worktrees', 'task-1'), workspaceMode: 'worktree',
    });
    return setAttemptPhase(h.state, opened.id, 'finalizing');
  }

  async function expectParkedAndUnclaimable(reason: string): Promise<void> {
    expect(task()).toMatchObject({ status: 'REVIEW', assignedWorkerId: null, needsHumanReview: true, reopenCount: 5 });
    expect(task().landingRetry).toMatchObject({ reason, count: 1 });
    expect(task().comments.filter((c) => c.author === 'moe-daemon')).toHaveLength(1);
    const worker = await call('moe.claim_next_task', { statuses: ['WORKING'], workerId: 'worker-2' });
    expect((worker.task as { id?: string } | undefined)?.id).not.toBe('task-1');
    const qa = await call('moe.claim_next_task', { statuses: ['REVIEW'], workerId: 'qa-1' });
    expect((qa.task as { id?: string } | undefined)?.id).not.toBe('task-1');
    await expect(call('moe.claim_next_task', { statuses: ['REVIEW'], taskId: 'task-1', workerId: 'qa-1' }))
      .rejects.toThrow(/parked for human review/);
  }

  it.each(['conflict', 'diverged'])('finalize_attempt unlanded (%s) keeps it REVIEW, unassigned and flagged', async (unlandedReason) => {
    const held = await seed();
    const reply = await call('moe.finalize_attempt', {
      taskId: 'task-1', workerId: 'worker-1', runnerId: 'worker-1', attemptId: held.id, generation: held.generation,
      outcome: 'unlanded', unlandedReason, conflictPaths: ['src/a.ts'], rescueRef: 'refs/moe/rescue/task-1/r1', targetTip: null,
    });
    expect(reply).toMatchObject({ phase: 'closed', taskStatus: 'REVIEW' });
    await expectParkedAndUnclaimable(unlandedReason);
  });

  const CLOSERS: Record<string, () => Promise<void>> = {
    'moe.deregister_worker': async () => {
      await deregisterWorkerTool(h.state).handler({ workerId: 'worker-1', reason: 'terminal_closed' }, h.state);
    },
    'the DEAD-record prune (deleteWorker)': async () => {
      await h.state.updateWorker('worker-1', { status: 'DEAD' });
      await h.state.deleteWorker('worker-1');
    },
    'the startup purge': async () => {
      await h.state.updateWorker('worker-1', { status: 'DEAD' });
      await reconcileRunningAttempts(h.state);
      await h.state.purgeAllWorkers();
    },
  };

  it.each(Object.keys(CLOSERS))('%s keeps it REVIEW, unassigned and flagged', async (closer) => {
    await seed();
    await CLOSERS[closer]();
    expect(listAttempts(h.state, 'task-1').map((a) => a.phase)).toEqual(['closed']);
    await expectParkedAndUnclaimable('contention');
  });

  it('control: the same row without the flag is still routed to WORKING', async () => {
    await seed({ needsHumanReview: undefined, reopenCount: 1 } as Partial<Task>);
    await CLOSERS['moe.deregister_worker']();
    expect(task()).toMatchObject({ status: 'WORKING', assignedWorkerId: null });
  });
});
