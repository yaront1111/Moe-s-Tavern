import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ToolTestHarness } from '../tools/toolTestHarness.js';
import { startStepTool } from '../tools/startStep.js';
import { setTaskStatusTool } from '../tools/setTaskStatus.js';

/**
 * Regression, 2026-09-02: task lifecycle events carried NO workerId. Only
 * WORKER_CREATED had one, so `get_activity_log { workerId: X }` returned that
 * single event for every seat and the per-worker audit trail was empty by
 * construction — a worker that had claimed rows, completed steps, checkpointed
 * and delivered showed one event all day.
 */
describe('activity log records the acting worker', () => {
  const h = new ToolTestHarness();
  beforeEach(() => h.init());
  afterEach(() => { vi.restoreAllMocks(); h.cleanup(); });

  beforeEach(async () => {
    h.setupMoeFolder();
    h.createEpic();
    h.createTask({ status: 'BACKLOG' });
    await h.state.load();
  });

  /** Read what was actually WRITTEN. Spying on appendActivity only proves the
   *  argument was passed; it cannot see whether the event records it. */
  async function writtenEvents(event: string) {
    await h.state.flushActivityLog();
    return h.state.getActivityLogWindow(200).events.filter((e) => e.event === event);
  }

  it('attributes STEP_STARTED to the worker that started it', async () => {
    await h.state.updateTask('task-1', {
      status: 'WORKING',
      assignedWorkerId: 'worker-a',
      contextFetchedBy: ['worker-a'],
      implementationPlan: [{ stepId: 'step-1', description: 's', status: 'PENDING', affectedFiles: [] }],
    });

    await startStepTool(h.state).handler(
      { taskId: 'task-1', stepId: 'step-1', workerId: 'worker-a' }, h.state
    );

    const started = await writtenEvents('STEP_STARTED');
    expect(started.length, 'STEP_STARTED was never written').toBeGreaterThan(0);
    expect(started[started.length - 1].workerId).toBe('worker-a');
  });

  it('attributes a status change to the CALLER, not to the row holder', async () => {
    // The false-attribution guard: a governor moving someone else's row must be
    // recorded as the governor. Inferring the actor from task.assignedWorkerId
    // would name worker-a here, and a wrong name in an audit log is worse than
    // an absent one.
    await h.state.updateTask('task-1', { status: 'REVIEW', assignedWorkerId: 'worker-a' });

    await setTaskStatusTool(h.state).handler(
      { taskId: 'task-1', status: 'WORKING', reason: 'reopened', workerId: 'governor-z' }, h.state
    );

    await h.state.flushActivityLog();
    const all = h.state.getActivityLogWindow(200).events;
    const attributed = all.filter((e) => e.taskId === 'task-1' && e.workerId);
    expect(attributed.length, 'no task-1 event carried an actor').toBeGreaterThan(0);
    expect(attributed[attributed.length - 1].workerId).toBe('governor-z');
    expect(attributed.some((e) => e.workerId === 'worker-a')).toBe(false);
  });
});
