import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { claimNextTaskTool, deriveAttemptPolicySnapshot } from './claimNextTask.js';
import { waitForTaskTool } from './waitForTask.js';
import { ToolTestHarness } from './toolTestHarness.js';
import { getAttempt, listAttempts } from '../state/attemptStore.js';
import { StateManager } from '../state/StateManager.js';
import type { DeliveryPolicy, ExecutionPolicySnapshot, Task } from '../types/schema.js';
import { MoeError } from '../util/errors.js';

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
    // attemptId + generation are the claimed attempt's fencing identity: two
    // scalars beside `task` (task-b6c48bf0), not a context payload.
    expect(Object.keys(result).sort()).toEqual(
      ['attemptId', 'chatHint', 'generation', 'hasNext', 'nextAction', 'task'].sort()
    );
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
    // The hint is the role-default read: "full" in its wording makes agents pass
    // view:"full" and skip the role trim.
    const next = result.nextAction as { tool: string; args: Record<string, unknown>; reason: string };
    expect(next.tool).toBe('moe.get_context');
    expect(next.args).toEqual({ taskId: 'task-2' });
    expect(next.reason).not.toMatch(/full/i);
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

// ---------------------------------------------------------------------------
// dependsOn claim gating: a WORKING candidate whose declared prerequisites are
// not all DONE/ARCHIVED is withheld from the ranked pool and refused on an
// explicit-taskId claim. PLANNING is unaffected; missing ids are satisfied;
// resuming an own-held task stays allowed. The wait_for_task mirror lives in
// waitForTask.test.ts — both read the SAME predicate (util/claimEligibility).
// ---------------------------------------------------------------------------
describe('moe.claim_next_task dependsOn gating', () => {
  const h = new ToolTestHarness();
  beforeEach(() => h.init());
  afterEach(() => { vi.restoreAllMocks(); h.cleanup(); });

  beforeEach(async () => {
    h.setupMoeFolder();
    h.createEpic();
    // Prerequisite in REVIEW (not DONE) so it neither pollutes the WORKING
    // pool nor trips the solo-worker epic+status rule.
    h.createTask({ id: 'task-prereq', status: 'REVIEW', order: 1 });
    h.createTask({ id: 'task-gated', status: 'WORKING', order: 2, dependsOn: ['task-prereq'] });
    h.createTask({ id: 'task-open', status: 'WORKING', order: 3 });
    await h.state.load();
  });

  it('ranked claim skips the gated candidate and hands out the next eligible', async () => {
    const tool = claimNextTaskTool(h.state);
    const result = await tool.handler({
      statuses: ['WORKING'],
      workerId: 'worker-dep',
    }, h.state) as { hasNext: boolean; task: { id: string } };

    expect(result.hasNext).toBe(true);
    // task-gated has the lower order but is withheld.
    expect(result.task.id).toBe('task-open');
    expect(h.state.getTask('task-gated')!.assignedWorkerId).toBeNull();
  });

  it('explicit-taskId claim of a gated WORKING task is refused, naming the unmet ids and the escape hatch', async () => {
    const tool = claimNextTaskTool(h.state);
    await expect(tool.handler({
      statuses: ['WORKING'],
      taskId: 'task-gated',
      workerId: 'worker-dep',
    }, h.state)).rejects.toThrow(/unmet dependencies: task-prereq[\s\S]*set_task_dependencies/);
    expect(h.state.getTask('task-gated')!.assignedWorkerId).toBeNull();
  });

  it('the gate lifts when the prerequisite lands DONE (and ARCHIVED counts too)', async () => {
    await h.state.updateTask('task-prereq', { status: 'DONE' });
    const tool = claimNextTaskTool(h.state);
    const result = await tool.handler({
      statuses: ['WORKING'],
      workerId: 'worker-dep',
    }, h.state) as { hasNext: boolean; task: { id: string } };
    expect(result.task.id).toBe('task-gated');
  });

  it('missing/deleted dependsOn ids count as satisfied', async () => {
    h.createTask({ id: 'task-ghostdep', status: 'WORKING', order: 0, dependsOn: ['task-gone-forever'] });
    await h.state.load();
    const tool = claimNextTaskTool(h.state);
    const result = await tool.handler({
      statuses: ['WORKING'],
      workerId: 'worker-dep',
    }, h.state) as { task: { id: string } };
    expect(result.task.id).toBe('task-ghostdep');
  });

  it('PLANNING claims are NOT dependsOn-gated (planning may proceed before prerequisites land)', async () => {
    h.createTask({ id: 'task-plan-ahead', status: 'PLANNING', order: 5, dependsOn: ['task-prereq'] });
    await h.state.load();
    const tool = claimNextTaskTool(h.state);
    const result = await tool.handler({
      statuses: ['PLANNING'],
      taskId: 'task-plan-ahead',
      workerId: 'architect-dep',
    }, h.state) as { hasNext: boolean; task: { id: string } };
    expect(result.hasNext).toBe(true);
    expect(result.task.id).toBe('task-plan-ahead');
  });

  it('resuming your OWN held dep-gated task stays allowed (deps declared mid-flight must not strand the incumbent)', async () => {
    await h.state.updateTask('task-gated', { assignedWorkerId: 'worker-incumbent' });
    await h.state.createWorker({
      id: 'worker-incumbent', type: 'CLAUDE', projectId: 'proj-test', epicId: 'epic-1',
      currentTaskId: 'task-gated', status: 'CODING',
    });
    const tool = claimNextTaskTool(h.state);
    const result = await tool.handler({
      statuses: ['WORKING'],
      taskId: 'task-gated',
      workerId: 'worker-incumbent',
    }, h.state) as { hasNext: boolean; task: { id: string } };
    expect(result.hasNext).toBe(true);
    expect(result.task.id).toBe('task-gated');
  });
});

// alreadyAssigned surfacing: a legacy BLOCKED hold now names the tasks it
// waits on, and the hold guidance points at the dependency auto-unblock.
describe('moe.claim_next_task blockedOnTaskIds surfacing', () => {
  const h = new ToolTestHarness();
  beforeEach(() => h.init());
  afterEach(() => { vi.restoreAllMocks(); h.cleanup(); });

  it('a held BLOCKED task carries blockedOnTaskIds in the alreadyAssigned refusal', async () => {
    h.setupMoeFolder();
    h.createEpic();
    h.createTask({ id: 'task-prereq', status: 'WORKING', order: 1 });
    h.createTask({
      id: 'task-heldb', status: 'BLOCKED', order: 2,
      assignedWorkerId: 'worker-legacy',
      blockedReason: 'BUILD-ORDER BLOCK on task-prereq',
      blockedOnTaskIds: ['task-prereq'],
      blockedFromStatus: 'WORKING',
      blockedAt: new Date().toISOString(),
    });
    await h.state.load();
    await h.state.createWorker({
      id: 'worker-legacy', type: 'CLAUDE', projectId: 'proj-test', epicId: 'epic-1',
      currentTaskId: 'task-heldb', status: 'BLOCKED',
    });

    const result = await claimNextTaskTool(h.state).handler({
      statuses: ['WORKING'],
      workerId: 'worker-legacy',
    }, h.state) as {
      hasNext: boolean;
      alreadyAssigned: { taskId: string; status: string; blockedOnTaskIds?: string[] };
      nextAction: { reason: string };
    };

    expect(result.hasNext).toBe(false);
    expect(result.alreadyAssigned.taskId).toBe('task-heldb');
    expect(result.alreadyAssigned.blockedOnTaskIds).toEqual(['task-prereq']);
    // The hold guidance names the dependency auto-unblock, not "needs a human".
    expect(result.nextAction.reason).toContain('task-prereq');
    expect(result.nextAction.reason).toContain('auto-unblocks');
  });
});

// =============================================================================
// Attempt policy snapshot (CQ-M01d). A claim that opens a NEW attempt records
// the configuration identity derived from daemon state alone: the task's stored
// snapshot (a verified-local one is a floor) and the live project settings, at
// the task's planRevision. A resume keeps its original attempt untouched, a
// successor records a fresh identity, and claim arguments are never adopted.
// Like the rest of this file it mocks nothing: failure is a real malformed
// record, and update_settings has no deliveryPolicy key, so that half of a
// settings change is a hand edit (the CQ-M01c precedent).
// =============================================================================
describe('moe.claim_next_task attempt policy snapshot', () => {
  const h = new ToolTestHarness();
  beforeEach(() => {
    h.init();
    h.setupMoeFolder();
    h.createEpic();
  });
  afterEach(() => {
    h.state.clearEmitter();
    h.cleanup();
  });

  const LEGACY_AT_2: ExecutionPolicySnapshot = { version: 2, profile: 'legacy', planRevision: 2, deliveryPolicy: 'legacy' };
  const OBSERVE_LOCAL_AT_2: ExecutionPolicySnapshot = { version: 2, profile: 'observe', planRevision: 2, deliveryPolicy: 'local-branch' };
  const STRICT: ExecutionPolicySnapshot = { version: 2, profile: 'verified-local', planRevision: 1, deliveryPolicy: 'local-branch' };
  const HISTORICAL = {
    id: 'attempt-hist',
    taskId: 'task-snap',
    workerId: 'worker-a',
    runnerId: 'worker-a',
    generation: 1,
    workspace: '/old/checkout',
    phase: 'running',
    startedAt: '2026-09-01T00:00:00.000Z',
    lastPhaseAt: '2026-09-01T00:00:00.000Z',
  };

  type ClaimResult = { hasNext: boolean; attemptId: string; generation: number; task: Record<string, unknown> };

  /** Raw task JSON (and optionally raw attempt records) on disk, then load. */
  async function seed(task: Record<string, unknown> = {}, attempts: Array<Record<string, unknown>> = []): Promise<void> {
    h.createTask({ id: 'task-snap', status: 'WORKING', planRevision: 2, ...task } as Partial<Task>);
    if (attempts.length > 0) fs.mkdirSync(path.join(h.moePath, 'attempts'), { recursive: true });
    for (const attempt of attempts) {
      fs.writeFileSync(path.join(h.moePath, 'attempts', `${String(attempt.id)}.json`), JSON.stringify(attempt, null, 2));
    }
    await h.state.load();
  }

  async function claim(workerId: string, extra: Record<string, unknown> = {}): Promise<ClaimResult> {
    return await claimNextTaskTool(h.state).handler(
      { statuses: ['WORKING'], taskId: 'task-snap', workerId, ...extra },
      h.state
    ) as ClaimResult;
  }

  async function setSettings(executionProfile: 'legacy' | 'observe', deliveryPolicy: string): Promise<void> {
    h.state.project!.settings.deliveryPolicy = deliveryPolicy as DeliveryPolicy;
    await h.state.updateSettings({ executionProfile });
  }

  function fileBytes(attemptId: string): string {
    return fs.readFileSync(path.join(h.moePath, 'attempts', `${attemptId}.json`), 'utf8');
  }

  function readAttempt(attemptId: string): Record<string, unknown> {
    return JSON.parse(fileBytes(attemptId)) as Record<string, unknown>;
  }

  function taskOf(overrides: Record<string, unknown>): Task {
    return { ...h.state.getTask('task-snap')!, ...overrides } as Task;
  }

  it.each([
    ['default settings', null, LEGACY_AT_2],
    ['observe + local-branch settings', ['observe', 'local-branch'] as const, OBSERVE_LOCAL_AT_2],
  ])('C1 under %s a real claim persists the derived snapshot, unchanged after a restart', async (_label, settings, expected) => {
    await seed();
    if (settings) await setSettings(settings[0], settings[1]);

    const result = await claim('worker-a');

    expect(result.generation).toBe(1);
    expect(readAttempt(result.attemptId).executionPolicySnapshot).toEqual(expected);
    expect(getAttempt(h.state, result.attemptId)!.executionPolicySnapshot).toEqual(expected);
    const restarted = new StateManager({ projectPath: h.testDir });
    await restarted.load();
    try {
      expect(getAttempt(restarted, result.attemptId)!.executionPolicySnapshot).toEqual(expected);
    } finally {
      restarted.clearEmitter();
    }
  });

  it('C2 an own-seat resume keeps the original attempt and snapshot through changed and even malformed settings', async () => {
    await seed();
    const first = await claim('worker-a');
    const bytes = fileBytes(first.attemptId);

    await setSettings('observe', 'remote-push');
    const resumed = await claim('worker-a');
    h.state.project!.settings.deliveryPolicy = 'local-brnach' as DeliveryPolicy;
    const resumedAgain = await claim('worker-a');

    for (const result of [resumed, resumedAgain]) {
      expect(result.attemptId).toBe(first.attemptId);
      expect(result.generation).toBe(1);
    }
    expect(fileBytes(first.attemptId)).toBe(bytes);
    expect(readAttempt(first.attemptId).executionPolicySnapshot).toEqual(LEGACY_AT_2);
    expect(listAttempts(h.state, 'task-snap')).toHaveLength(1);
  });

  it('C3 a successor after a release records generation 2 with a fresh identity and leaves generation 1 as it was', async () => {
    await seed();
    const first = await claim('worker-a');
    await setSettings('observe', 'local-branch');
    await h.state.updateTask('task-snap', { assignedWorkerId: null });
    const closedBytes = fileBytes(first.attemptId);

    const successor = await claim('worker-b');

    expect(successor.generation).toBe(2);
    expect(successor.attemptId).not.toBe(first.attemptId);
    expect(readAttempt(successor.attemptId).executionPolicySnapshot).toEqual(OBSERVE_LOCAL_AT_2);
    expect(readAttempt(first.attemptId)).toMatchObject({ generation: 1, phase: 'closed', executionPolicySnapshot: LEGACY_AT_2 });
    expect(fileBytes(first.attemptId)).toBe(closedBytes);
  });

  it('C3 a successor that closes a historical leftover records a fresh identity and never backfills the leftover', async () => {
    await seed({}, [HISTORICAL]);
    await setSettings('observe', 'local-branch');

    const successor = await claim('worker-b');

    expect(successor.generation).toBe(2);
    expect(readAttempt(successor.attemptId).executionPolicySnapshot).toEqual(OBSERVE_LOCAL_AT_2);
    const leftover = readAttempt('attempt-hist');
    expect(leftover.phase).toBe('closed');
    expect('executionPolicySnapshot' in leftover).toBe(false);
  });

  it('C4 resuming a historical open attempt returns it as it was, with no snapshot backfilled', async () => {
    await seed({ assignedWorkerId: 'worker-a' }, [HISTORICAL]);
    await h.state.createWorker({
      id: 'worker-a', type: 'CLAUDE', projectId: 'proj-test', epicId: 'epic-1',
      currentTaskId: 'task-snap', status: 'CODING',
    });
    const bytes = fileBytes('attempt-hist');

    const resumed = await claim('worker-a');

    expect(resumed.attemptId).toBe('attempt-hist');
    expect(resumed.generation).toBe(1);
    expect(fileBytes('attempt-hist')).toBe(bytes);
    expect(Object.prototype.hasOwnProperty.call(getAttempt(h.state, 'attempt-hist'), 'executionPolicySnapshot')).toBe(false);
  });

  it.each([
    ['a forged STRICT snapshot', { executionPolicySnapshot: STRICT }],
    ['a forged legacy snapshot', { executionPolicySnapshot: { version: 2, profile: 'legacy', planRevision: 9, deliveryPolicy: 'remote-push' } }],
    ['profile and deliveryPolicy', { profile: 'legacy', deliveryPolicy: 'remote-push' }],
  ])('C5 a claim carrying %s records only the derived snapshot and keeps its response shape', async (_label, injected) => {
    await seed();
    await setSettings('observe', 'local-branch');

    const result = await claim('worker-a', injected);

    expect(readAttempt(result.attemptId).executionPolicySnapshot).toEqual(OBSERVE_LOCAL_AT_2);
    expect(Object.keys(result).sort()).toEqual(['attemptId', 'chatHint', 'generation', 'hasNext', 'nextAction', 'task'].sort());
    expect(result.task).not.toHaveProperty('executionPolicySnapshot');
    const schema = claimNextTaskTool(h.state).inputSchema as { properties: Record<string, unknown> };
    expect(Object.keys(schema.properties)).not.toContain('executionPolicySnapshot');
  });

  it('C6 a STRICT task snapshot is the floor under rolled-back legacy settings, at the task revision', async () => {
    await seed();
    const task = taskOf({ executionPolicySnapshot: STRICT, planRevision: 3 });

    const derived = deriveAttemptPolicySnapshot(h.state, task);

    expect(derived).toStrictEqual({ version: 2, profile: 'verified-local', planRevision: 3, deliveryPolicy: 'local-branch' });
    expect(derived).not.toBe(task.executionPolicySnapshot);
    expect(task.executionPolicySnapshot).toEqual(STRICT);
  });

  it('C6 a v1 verified-local task snapshot stays v1 at the task revision', async () => {
    await seed();
    await setSettings('observe', 'remote-push');
    const task = taskOf({ executionPolicySnapshot: { version: 1, profile: 'verified-local', planRevision: 1 }, planRevision: 3 });

    expect(deriveAttemptPolicySnapshot(h.state, task)).toStrictEqual({ version: 1, profile: 'verified-local', planRevision: 3 });
  });

  it.each([
    ['absent', undefined],
    ['legacy', { version: 2, profile: 'legacy', planRevision: 1, deliveryPolicy: 'legacy' }],
    ['observe', { version: 2, profile: 'observe', planRevision: 1, deliveryPolicy: 'manual-artifact' }],
    ['v1 observe', { version: 1, profile: 'observe', planRevision: 1 }],
  ])('C6 an %s task snapshot gives the live settings', async (_label, snapshot) => {
    await seed();
    await setSettings('observe', 'remote-push');

    expect(deriveAttemptPolicySnapshot(h.state, taskOf({ executionPolicySnapshot: snapshot, planRevision: 5 })))
      .toStrictEqual({ version: 2, profile: 'observe', planRevision: 5, deliveryPolicy: 'remote-push' });
  });

  it('C6 an absent planRevision reads as 0', async () => {
    await seed();
    const task = taskOf({});
    delete (task as { planRevision?: number }).planRevision;

    expect(deriveAttemptPolicySnapshot(h.state, task))
      .toStrictEqual({ version: 2, profile: 'legacy', planRevision: 0, deliveryPolicy: 'legacy' });
  });

  it.each([
    ['a null planRevision', { planRevision: null }, null],
    ['a null planRevision under a STRICT floor', { planRevision: null, executionPolicySnapshot: STRICT }, null],
    ['a -1 planRevision', { planRevision: -1 }, null],
    ["a '3' planRevision", { planRevision: '3' }, null],
    ['a malformed task snapshot', { executionPolicySnapshot: { version: 3 } }, null],
    ['a malformed executionProfile setting', {}, { executionProfile: 'turbo' }],
    ['a malformed deliveryPolicy setting', {}, { deliveryPolicy: 'local-brnach' }],
  ])('C6 %s throws INVALID_INPUT', async (_label, overrides, settings) => {
    await seed();
    if (settings) Object.assign(h.state.project!.settings, settings);

    expect(() => deriveAttemptPolicySnapshot(h.state, taskOf(overrides))).toThrow(MoeError);
    expect(() => deriveAttemptPolicySnapshot(h.state, taskOf(overrides))).toThrow('[INVALID_INPUT]');
  });

  it.each([
    ['a malformed stored task snapshot', { executionPolicySnapshot: { version: 3 } }, null],
    ['a malformed deliveryPolicy setting', {}, 'local-brnach'],
  ])('C7 a fresh claim of a row with %s is refused, records no attempt and hands the seat back', async (_label, task, deliveryPolicy) => {
    await seed(task);
    if (deliveryPolicy) h.state.project!.settings.deliveryPolicy = deliveryPolicy as DeliveryPolicy;

    await expect(claim('worker-a')).rejects.toThrow('[INVALID_INPUT]');

    expect(listAttempts(h.state, 'task-snap')).toEqual([]);
    expect(fs.existsSync(path.join(h.moePath, 'attempts'))
      ? fs.readdirSync(path.join(h.moePath, 'attempts'))
      : []).toEqual([]);
    expect(h.state.getTask('task-snap')!.assignedWorkerId).toBeNull();
    const onDisk = JSON.parse(fs.readFileSync(path.join(h.moePath, 'tasks', 'task-snap.json'), 'utf8')) as Task;
    expect(onDisk.assignedWorkerId).toBeNull();
  });
});
