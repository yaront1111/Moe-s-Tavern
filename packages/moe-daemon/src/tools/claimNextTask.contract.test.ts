import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { claimNextTaskTool } from './claimNextTask.js';
import { waitForTaskTool } from './waitForTask.js';
import { ToolTestHarness } from './toolTestHarness.js';

// Migrated verbatim from tools.test.ts.
//
// This block lives in its OWN file rather than appended into
// claimNextTask.test.ts, because that file hoists a module-wide mock of the
// disk-state signature helper. Such a mock is file-wide, so appending here
// would run all 17 of these tests against a stub returning `undefined`
// instead of the real implementation — and they would still pass, which is
// the dangerous outcome: green for the wrong reason, invisible in a normal
// run. In tools.test.ts these assertions exercised the REAL implementation,
// so keeping them unmocked is what makes this a behaviour-preserving move.
//
// This file therefore mocks nothing and imports no disk-state module; a grep
// for a mock call here must come back empty.

describe('moe.claim_next_task', () => {
  const h = new ToolTestHarness();
  beforeEach(() => h.init());
  afterEach(() => { vi.restoreAllMocks(); h.cleanup(); });

  // Fixtures use WORKING (the worker claim column): BACKLOG is human-gated
  // and no longer agent-claimable — see the vocabulary tests below.
  beforeEach(async () => {
    h.setupMoeFolder();
    h.createEpic();
    h.createTask({ id: 'task-1', status: 'WORKING', order: 2 });
    h.createTask({ id: 'task-2', status: 'WORKING', order: 1 });
    h.createTask({ id: 'task-3', status: 'PLANNING' });
    await h.state.load();
  });

  it('claims next task by status', async () => {
    const tool = claimNextTaskTool(h.state);
    const result = await tool.handler({
      statuses: ['WORKING'],
    }, h.state) as { hasNext: boolean; task: { id: string } };

    expect(result.hasNext).toBe(true);
    expect(result.task.id).toBe('task-2'); // lowest order
  });

  it('keeps claim response lean and defers full context to get_context', async () => {
    const tool = claimNextTaskTool(h.state);
    const result = await tool.handler({
      statuses: ['WORKING'],
      workerId: 'worker-lean',
    }, h.state) as {
      hasNext: boolean;
      task: Record<string, unknown>;
      chatHint?: string;
      nextAction?: unknown;
      project?: unknown;
      epic?: unknown;
      allRails?: unknown;
      memory?: unknown;
    };

    expect(result.hasNext).toBe(true);
    expect(Object.keys(result).sort()).toEqual(['chatHint', 'hasNext', 'nextAction', 'task'].sort());
    expect(Object.keys(result.task).sort()).toEqual([
      'assignedWorkerId',
      'epicId',
      'generalChannelId',
      'id',
      'priorHandoffCount',
      'priority',
      'rejectionDetails',
      'reopenCount',
      'reopenReason',
      'roleChannelId',
      'status',
      'title',
    ].sort());
    expect(result.task.id).toBe('task-2');
    expect(result.task.description).toBeUndefined();
    expect(result.task.definitionOfDone).toBeUndefined();
    expect(result.task.taskRails).toBeUndefined();
    expect(result.task.implementationPlan).toBeUndefined();
    expect(result.project).toBeUndefined();
    expect(result.epic).toBeUndefined();
    expect(result.allRails).toBeUndefined();
    expect(result.memory).toBeUndefined();
  });

  it('assigns workerId to claimed task', async () => {
    const tool = claimNextTaskTool(h.state);
    const result = await tool.handler({
      statuses: ['WORKING'],
      workerId: 'worker-1',
    }, h.state) as { task: { assignedWorkerId: string | null } };

    const task = h.state.getTask('task-2');
    expect(task?.assignedWorkerId).toBe('worker-1');
    expect(result.task.assignedWorkerId).toBe('worker-1');
  });

  it('replaceExisting overrides the epic-status block WITHOUT evicting a bystander worker', async () => {
    // worker-other holds task-active-worker (same epic+status). A ranked claim
    // for a DIFFERENT unassigned task (task-2) with replaceExisting must claim
    // task-2 and LEAVE worker-other on its own task — never yank a bystander.
    h.createTask({
      id: 'task-active-worker',
      status: 'WORKING',
      assignedWorkerId: 'worker-other',
      order: 99,
    });
    h.createWorker({
      id: 'worker-other',
      status: 'READING_CONTEXT',
      currentTaskId: 'task-active-worker',
    });
    await h.state.load();

    const tool = claimNextTaskTool(h.state);
    const result = await tool.handler({
      statuses: ['WORKING'],
      workerId: 'worker-replacement',
      replaceExisting: true,
    }, h.state) as { task: { id: string; assignedWorkerId: string | null } };

    expect(result.task.id).toBe('task-2');
    expect(result.task.assignedWorkerId).toBe('worker-replacement');
    expect(h.state.getTask('task-2')?.assignedWorkerId).toBe('worker-replacement');
    // Bystander is NOT evicted (previously this wrongly nulled its assignment).
    expect(h.state.getTask('task-active-worker')?.assignedWorkerId).toBe('worker-other');
    expect(h.state.getWorker('worker-other')?.currentTaskId).toBe('task-active-worker');
  });

  it('taskId + replaceExisting takes over THAT task from its live owner and idles them', async () => {
    h.createTask({ id: 'task-takeover', status: 'WORKING', assignedWorkerId: 'worker-incumbent', order: 5 });
    h.createWorker({ id: 'worker-incumbent', status: 'READING_CONTEXT', currentTaskId: 'task-takeover' });
    await h.state.load();

    const tool = claimNextTaskTool(h.state);
    const result = await tool.handler({
      statuses: ['WORKING'],
      taskId: 'task-takeover',
      workerId: 'worker-new',
      replaceExisting: true,
    }, h.state) as { hasNext: boolean; task: { id: string; assignedWorkerId: string | null } };

    // The SPECIFIC requested task is taken over (not a bystander), and the claim succeeds.
    expect(result.hasNext).toBe(true);
    expect(result.task.id).toBe('task-takeover');
    expect(result.task.assignedWorkerId).toBe('worker-new');
    expect(h.state.getTask('task-takeover')?.assignedWorkerId).toBe('worker-new');
    // The displaced incumbent is reconciled, not left dangling.
    expect(h.state.getWorker('worker-incumbent')?.currentTaskId).toBeNull();
    expect(h.state.getWorker('worker-incumbent')?.status).toBe('IDLE');
  });

  it('repairs and claims a task assigned to a missing worker', async () => {
    h.createTask({
      id: 'task-orphan-worker',
      status: 'WORKING',
      assignedWorkerId: 'worker-missing',
      order: 0,
    });
    await h.state.load();

    const tool = claimNextTaskTool(h.state);
    const result = await tool.handler({
      statuses: ['WORKING'],
      workerId: 'worker-reclaimer',
    }, h.state) as { hasNext: boolean; task: { id: string; assignedWorkerId: string | null } };

    expect(result.hasNext).toBe(true);
    expect(result.task.id).toBe('task-orphan-worker');
    expect(result.task.assignedWorkerId).toBe('worker-reclaimer');
    expect(h.state.getTask('task-orphan-worker')?.assignedWorkerId).toBe('worker-reclaimer');
  });

  it('wait_for_task treats a task assigned to a missing worker as available', async () => {
    h.createTask({
      id: 'task-wait-orphan',
      status: 'REVIEW',
      assignedWorkerId: 'worker-missing',
      order: 0,
    });
    await h.state.load();

    const tool = waitForTaskTool(h.state);
    const result = await tool.handler({
      statuses: ['REVIEW'],
      workerId: 'worker-waiter',
      timeoutMs: 1000,
    }, h.state) as { hasNext: boolean; task: { id: string }; nextAction: { tool: string } };

    expect(result.hasNext).toBe(true);
    expect(result.task.id).toBe('task-wait-orphan');
    expect(result.nextAction.tool).toBe('moe.claim_next_task');
  });

  it('claims from multiple statuses', async () => {
    const tool = claimNextTaskTool(h.state);
    const result = await tool.handler({
      statuses: ['PLANNING', 'WORKING'],
    }, h.state) as { task: { id: string } };

    // task-2 (WORKING, order 1) comes before task-3 (PLANNING, order 1)
    expect(result.task).toBeDefined();
  });

  it('throws for empty statuses', async () => {
    const tool = claimNextTaskTool(h.state);
    await expect(tool.handler({ statuses: [] }, h.state)).rejects.toThrow('Missing required field: statuses');
  });

  it('returns hasNext=false when no matching tasks', async () => {
    const tool = claimNextTaskTool(h.state);
    const result = await tool.handler({ statuses: ['REVIEW'], workerId: 'worker-none' }, h.state) as {
      hasNext: boolean;
      nextAction: { tool: string; args: { statuses: string[]; workerId: string } };
    };
    expect(result.hasNext).toBe(false);
    expect(Object.keys(result).sort()).toEqual(['hasNext', 'nextAction'].sort());
    expect(result.nextAction.tool).toBe('moe.wait_for_task');
    expect(result.nextAction.args.statuses).toEqual(['REVIEW']);
    expect(result.nextAction.args.workerId).toBe('worker-none');
  });

  it('includes rejection fields when task was reopened', async () => {
    h.createTask({
      id: 'task-reopened',
      status: 'WORKING',
      order: 0,
      reopenCount: 1,
      reopenReason: 'Tests failing in auth module',
      rejectionDetails: {
        failedDodItems: ['Tests pass'],
        issues: [{ type: 'test_failure', description: 'AuthService test fails', file: 'src/auth.test.ts', line: 42 }],
      },
    });
    await h.state.load();

    const tool = claimNextTaskTool(h.state);
    const result = await tool.handler({
      statuses: ['WORKING'],
      workerId: 'worker-reopen',
    }, h.state) as {
      hasNext: boolean;
      task: { reopenCount: number; reopenReason: string; rejectionDetails: { failedDodItems: string[]; issues: Array<{ type: string }> } };
      reopenWarning: string;
    };

    expect(result.hasNext).toBe(true);
    expect(result.task.reopenCount).toBe(1);
    expect(result.task.reopenReason).toBe('Tests failing in auth module');
    expect(result.task.rejectionDetails).not.toBeNull();
    expect(result.task.rejectionDetails.failedDodItems).toEqual(['Tests pass']);
    expect(result.task.rejectionDetails.issues).toHaveLength(1);
    expect(result.task.rejectionDetails.issues[0].type).toBe('test_failure');
    expect(result.reopenWarning).toContain('WARNING');
    expect(result.reopenWarning).toContain('1 time(s)');
  });

  it('omits reopenWarning when task was not reopened', async () => {
    const tool = claimNextTaskTool(h.state);
    const result = await tool.handler({
      statuses: ['WORKING'],
      workerId: 'worker-normal',
    }, h.state) as {
      hasNext: boolean;
      task: { reopenCount: number; reopenReason: string | null; rejectionDetails: null };
      reopenWarning?: string;
    };

    expect(result.hasNext).toBe(true);
    expect(result.task.reopenCount).toBe(0);
    expect(result.task.reopenReason).toBeNull();
    expect(result.task.rejectionDetails).toBeNull();
    expect(result.reopenWarning).toBeUndefined();
  });

  it('claims a specific task when taskId is provided, bypassing priority order', async () => {
    // task-2 has lower order so default claim picks it; with taskId we want task-1 instead.
    const tool = claimNextTaskTool(h.state);
    const result = await tool.handler({
      statuses: ['WORKING'],
      taskId: 'task-1',
      workerId: 'worker-direct',
    }, h.state) as { hasNext: boolean; task: { id: string; assignedWorkerId: string } };

    expect(result.hasNext).toBe(true);
    expect(result.task.id).toBe('task-1');
    expect(result.task.assignedWorkerId).toBe('worker-direct');
    expect(h.state.getTask('task-1')?.assignedWorkerId).toBe('worker-direct');
    // task-2 should still be free
    expect(h.state.getTask('task-2')?.assignedWorkerId).toBeNull();
  });

  it('rejects taskId when task is not in any of the requested statuses', async () => {
    const tool = claimNextTaskTool(h.state);
    // task-3 is PLANNING; we ask for WORKING only
    await expect(tool.handler({
      statuses: ['WORKING'],
      taskId: 'task-3',
    }, h.state)).rejects.toThrow(/PLANNING/);
  });

  it('rejects taskId for unknown task', async () => {
    const tool = claimNextTaskTool(h.state);
    await expect(tool.handler({
      statuses: ['WORKING'],
      taskId: 'task-nope',
    }, h.state)).rejects.toThrow(/not found|NOT_FOUND/i);
  });

  it('rejects taskId already assigned to someone else without replaceExisting', async () => {
    h.createTask({ id: 'task-locked', status: 'WORKING', assignedWorkerId: 'worker-other', order: 99 });
    h.createWorker({ id: 'worker-other', status: 'READING_CONTEXT', currentTaskId: 'task-locked' });
    await h.state.load();
    const tool = claimNextTaskTool(h.state);
    await expect(tool.handler({
      statuses: ['WORKING'],
      taskId: 'task-locked',
      workerId: 'worker-thief',
    }, h.state)).rejects.toThrow(/already assigned/);
  });

  it('rejects human-gated statuses (BACKLOG/AWAITING_APPROVAL/DONE/ARCHIVED) — ranked and by taskId', async () => {
    const tool = claimNextTaskTool(h.state);
    // Ranked claim on a human-gated column
    await expect(tool.handler({
      statuses: ['BACKLOG'],
      workerId: 'worker-vocab',
    }, h.state)).rejects.toThrow(/not agent-claimable/);
    // Mixed arrays are rejected too — one bad status poisons the claim
    await expect(tool.handler({
      statuses: ['WORKING', 'BACKLOG'],
      workerId: 'worker-vocab',
    }, h.state)).rejects.toThrow(/not agent-claimable/);
    // Explicit-taskId claim of a BACKLOG task (the px4swarm wedge:
    // assignment used to succeed with the status stuck in BACKLOG, then
    // start_step rejected with INVALID_STATE forever)
    h.createTask({ id: 'task-backlog-wedge', status: 'BACKLOG', order: 50 });
    await h.state.load();
    await expect(tool.handler({
      statuses: ['BACKLOG'],
      taskId: 'task-backlog-wedge',
      workerId: 'worker-vocab',
    }, h.state)).rejects.toThrow(/not agent-claimable/);
    // Nothing got assigned along the way
    expect(h.state.getTask('task-backlog-wedge')?.assignedWorkerId).toBeNull();
    for (const bad of ['AWAITING_APPROVAL', 'DONE', 'ARCHIVED']) {
      await expect(tool.handler({
        statuses: [bad],
        workerId: 'worker-vocab',
      }, h.state)).rejects.toThrow(/not agent-claimable/);
    }
  });
});
