import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ToolTestHarness } from './toolTestHarness.js';
import { setTaskStatusTool } from './setTaskStatus.js';

describe('moe.set_task_status', () => {
  const h = new ToolTestHarness();
  beforeEach(() => h.init());
  afterEach(() => { vi.restoreAllMocks(); h.cleanup(); });

  beforeEach(async () => {
    h.setupMoeFolder();
    h.createEpic();
    h.createTask({ status: 'BACKLOG' });
    await h.state.load();
  });

  it('changes task status', async () => {
    const tool = setTaskStatusTool(h.state);
    const result = await tool.handler({
      taskId: 'task-1',
      status: 'PLANNING',
    }, h.state) as { success: boolean; status: string };

    expect(result.success).toBe(true);
    expect(result.status).toBe('PLANNING');
  });

  it('validates status transitions', async () => {
    const tool = setTaskStatusTool(h.state);
    // BACKLOG -> DONE is not valid
    await expect(
      tool.handler({ taskId: 'task-1', status: 'DONE' }, h.state)
    ).rejects.toThrow('status transition not allowed');
  });

  it('rejects invalid status values', async () => {
    const tool = setTaskStatusTool(h.state);
    await expect(
      tool.handler({ taskId: 'task-1', status: 'INVALID' }, h.state)
    ).rejects.toThrow('Invalid status');
  });

  it('increments reopenCount when reopening with reason', async () => {
    await h.state.updateTask('task-1', { status: 'REVIEW' });
    const tool = setTaskStatusTool(h.state);
    await tool.handler({
      taskId: 'task-1',
      status: 'WORKING',
      reason: 'Fix needed',
    }, h.state);

    const task = h.state.getTask('task-1');
    expect(task?.reopenCount).toBe(1);
    expect(task?.reopenReason).toBe('Fix needed');
  });

  describe('BLOCKED transitions', () => {
    it('WORKING → BLOCKED preserves the assignment and records the restore target', async () => {
      await h.state.updateTask('task-1', { status: 'WORKING', assignedWorkerId: 'worker-1' });
      const tool = setTaskStatusTool(h.state);
      await tool.handler({ taskId: 'task-1', status: 'BLOCKED', reason: 'waiting on infra' }, h.state);
      const task = h.state.getTask('task-1')!;
      expect(task.status).toBe('BLOCKED');
      expect(task.assignedWorkerId).toBe('worker-1');
      expect(task.blockedFromStatus).toBe('WORKING');
      expect(task.blockedReason).toBe('waiting on infra');
    });

    it('BLOCKED → blockedFromStatus restores the parked worker and clears bookkeeping', async () => {
      await h.state.updateTask('task-1', { status: 'WORKING', assignedWorkerId: 'worker-1' });
      const tool = setTaskStatusTool(h.state);
      await tool.handler({ taskId: 'task-1', status: 'BLOCKED' }, h.state);
      await tool.handler({ taskId: 'task-1', status: 'WORKING' }, h.state);
      const task = h.state.getTask('task-1')!;
      expect(task.status).toBe('WORKING');
      expect(task.assignedWorkerId).toBe('worker-1');
      expect(task.blockedFromStatus).toBeNull();
      expect(task.blockedReason).toBeNull();
      expect(task.blockedAt).toBeNull();
    });

    it('rejects two-hop laundering: PLANNING → BLOCKED → WORKING must not bypass plan approval', async () => {
      await h.state.updateTask('task-1', { status: 'PLANNING' });
      const tool = setTaskStatusTool(h.state);
      await tool.handler({ taskId: 'task-1', status: 'BLOCKED' }, h.state);
      // PLANNING → WORKING is not a legal direct transition, so the BLOCKED
      // hop must not make it one.
      await expect(
        tool.handler({ taskId: 'task-1', status: 'WORKING' }, h.state)
      ).rejects.toThrow(/blocked from PLANNING/);
      // Returning to where it was blocked from is always fine.
      await tool.handler({ taskId: 'task-1', status: 'PLANNING' }, h.state);
      expect(h.state.getTask('task-1')!.status).toBe('PLANNING');
    });

    it('BLOCKED(from REVIEW) → WORKING still counts as a reopen and clears the assignment', async () => {
      await h.state.updateTask('task-1', { status: 'REVIEW', assignedWorkerId: 'qa-1' });
      const tool = setTaskStatusTool(h.state);
      await tool.handler({ taskId: 'task-1', status: 'BLOCKED' }, h.state);
      await tool.handler({ taskId: 'task-1', status: 'WORKING', reason: 'unblocked, needs rework' }, h.state);
      const task = h.state.getTask('task-1')!;
      expect(task.status).toBe('WORKING');
      expect(task.reopenCount).toBe(1);
      // Cross-status exit keeps clear-on-move: the QA owner must not stay
      // assigned to a WORKING task.
      expect(task.assignedWorkerId).toBeNull();
    });

    it('BLOCKED → BACKLOG park clears the assignment', async () => {
      await h.state.updateTask('task-1', { status: 'WORKING', assignedWorkerId: 'worker-1' });
      const tool = setTaskStatusTool(h.state);
      await tool.handler({ taskId: 'task-1', status: 'BLOCKED' }, h.state);
      await tool.handler({ taskId: 'task-1', status: 'BACKLOG' }, h.state);
      const task = h.state.getTask('task-1')!;
      expect(task.status).toBe('BACKLOG');
      expect(task.assignedWorkerId).toBeNull();
      expect(task.blockedFromStatus).toBeNull();
    });
  });

  // --------------------------------------------------------------------------
  // Regression: unblocking must not destroy the reason the task was parked for.
  // --------------------------------------------------------------------------
  it('archives blockedReason into priorBlockedReason when leaving BLOCKED', async () => {
    await h.state.updateTask('task-1', {
      status: 'BLOCKED',
      blockedFromStatus: 'PLANNING',
      blockedReason: 'waiting on an external prerequisite',
      blockedOnTaskIds: ['task-9'],
      blockedAt: '2026-09-01T00:00:00.000Z',
    });

    const tool = setTaskStatusTool(h.state);
    await tool.handler({ taskId: 'task-1', status: 'PLANNING' }, h.state);

    const task = h.state.getTask('task-1')!;
    // The prose survives...
    expect(task.priorBlockedReason).toBe('waiting on an external prerequisite');
    // ...while every field a later grant/sweep could act on is still cleared.
    expect(task.blockedReason).toBeNull();
    expect(task.blockedOnTaskIds).toBeNull();
    expect(task.blockedFromStatus).toBeNull();
    expect(task.blockedAt).toBeNull();
  });

  // --------------------------------------------------------------------------
  // Regression: a task parked with needsHumanReview stayed unclaimable after a
  // human moved it, because only WORKING/BACKLOG/PLANNING cleared the latch —
  // so the natural "put it back in the QA queue" move (-> REVIEW) left the row
  // fenced out of claim_next_task while the board showed it as normal REVIEW.
  // --------------------------------------------------------------------------
  it('clears needsHumanReview when a human moves the parked task back to REVIEW', async () => {
    await h.state.updateTask('task-1', { status: 'REVIEW', needsHumanReview: true });

    const tool = setTaskStatusTool(h.state);
    await tool.handler({ taskId: 'task-1', status: 'REVIEW' }, h.state);

    expect(h.state.getTask('task-1')!.needsHumanReview).toBe(false);
  });

  it('clears needsHumanReview when a human reopens the parked task to WORKING', async () => {
    await h.state.updateTask('task-1', { status: 'REVIEW', needsHumanReview: true });

    const tool = setTaskStatusTool(h.state);
    await tool.handler({ taskId: 'task-1', status: 'WORKING', reason: 'reopened' }, h.state);

    // The reopen path strips the latch entirely rather than setting it false.
    // Both representations unfence the row: claim_next_task and wait_for_task
    // gate on `needsHumanReview === true`, so what matters is only that it is
    // no longer true. Asserted against that guard, not against a shape.
    expect(h.state.getTask('task-1')!.needsHumanReview).toBeUndefined();
    expect(h.state.getTask('task-1')!.needsHumanReview).not.toBe(true);
  });
});

