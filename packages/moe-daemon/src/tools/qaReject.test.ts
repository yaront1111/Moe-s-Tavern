import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { StateManager } from '../state/StateManager.js';
import { qaRejectTool } from './qaReject.js';
import { claimNextTaskTool } from './claimNextTask.js';
import { MoeError, MoeErrorCode } from '../util/errors.js';
import type { Task, Epic, Project, WorkerStatus } from '../types/schema.js';

// Bounded-escalation + same-DoD-item behavior of moe.qa_reject.
describe('qa_reject bounded escalation', () => {
  let testDir: string;
  let moePath: string;
  let state: StateManager;

  function setupMoe() {
    fs.mkdirSync(moePath, { recursive: true });
    for (const sub of ['epics', 'tasks', 'workers', 'proposals']) {
      fs.mkdirSync(path.join(moePath, sub));
    }
    const project: Partial<Project> = {
      id: 'proj-test', schemaVersion: 6, name: 'Test', rootPath: testDir,
      globalRails: { techStack: [], forbiddenPatterns: [], requiredPatterns: [], formatting: '', testing: '', customRules: [] },
      settings: {
        approvalMode: 'TURBO', speedModeDelayMs: 2000, autoCreateBranch: false,
        branchPattern: '', commitPattern: '', agentCommand: 'claude', enableAgentTeams: false,
      },
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(moePath, 'project.json'), JSON.stringify(project, null, 2));
  }

  function writeEpic(): Epic {
    const epic: Epic = {
      id: 'epic-1', projectId: 'proj-test', title: '', description: '', architectureNotes: '',
      epicRails: [], status: 'ACTIVE', order: 1,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(moePath, 'epics', 'epic-1.json'), JSON.stringify(epic, null, 2));
    return epic;
  }

  function writeTask(overrides: Partial<Task> = {}): Task {
    const now = new Date().toISOString();
    const task: Task = {
      id: 'task-1', epicId: 'epic-1', title: 't', description: '',
      definitionOfDone: [], taskRails: [], implementationPlan: [],
      status: 'REVIEW', assignedWorkerId: 'qa-a', branch: null, prLink: null,
      reopenCount: 0, reopenReason: null, createdBy: 'HUMAN', parentTaskId: null,
      priority: 'MEDIUM', order: 1, comments: [],
      // Seed the context stamp so the qa_reject context guard passes — the real
      // flow records this via the preflight get_context.
      contextFetchedBy: ['qa-a'],
      createdAt: now, updatedAt: now,
      ...overrides,
    };
    fs.writeFileSync(path.join(moePath, 'tasks', `${task.id}.json`), JSON.stringify(task, null, 2));
    return task;
  }

  async function createWorker(id: string, status: WorkerStatus = 'CODING', currentTaskId: string | null = 'task-1') {
    return state.createWorker({
      id, type: 'CLAUDE', projectId: 'proj-test', epicId: 'epic-1', currentTaskId, status,
    });
  }

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moe-qa-reject-'));
    moePath = path.join(testDir, '.moe');
    state = new StateManager({ projectPath: testDir });
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  type RejectResult = {
    status: string;
    reopenCount: number;
    parkedForHuman: boolean;
    needsHumanReview: boolean;
    exceededReopenCap: boolean;
  };

  it('sends the task back to WORKING below the soft cap', async () => {
    // maxReopens default 3 → reopenCount 0 -> 1 stays WORKING.
    setupMoe(); writeEpic(); writeTask({ reopenCount: 0 });
    await state.load();
    const result = await qaRejectTool(state).handler(
      { taskId: 'task-1', reason: 'fix it', workerId: 'qa-a' }, state,
    ) as RejectResult;
    expect(result.status).toBe('WORKING');
    expect(result.reopenCount).toBe(1);
    expect(result.parkedForHuman).toBe(false);
  });

  it('flips to PLANNING once at the soft cap for a single re-plan', async () => {
    // reopenCount 2 -> 3 == maxReopens (soft cap) → PLANNING.
    setupMoe(); writeEpic(); writeTask({ reopenCount: 2 });
    await state.load();
    const result = await qaRejectTool(state).handler(
      { taskId: 'task-1', reason: 'still broken', workerId: 'qa-a' }, state,
    ) as RejectResult;
    expect(result.status).toBe('PLANNING');
    expect(result.reopenCount).toBe(3);
    expect(result.parkedForHuman).toBe(false);
    expect(result.exceededReopenCap).toBe(true);
  });

  it('parks in REVIEW for a human past the hard cap instead of re-flipping to PLANNING', async () => {
    // reopenCount 3 -> 4 > maxReopens (hard cap) → parked in REVIEW, unassigned.
    setupMoe(); writeEpic(); writeTask({ reopenCount: 3, assignedWorkerId: 'qa-a' });
    await state.load();
    await createWorker('qa-a', 'CODING', 'task-1');

    const result = await qaRejectTool(state).handler(
      { taskId: 'task-1', reason: 're-plan did not help', workerId: 'qa-a' }, state,
    ) as RejectResult;

    expect(result.status).toBe('REVIEW');
    expect(result.parkedForHuman).toBe(true);
    expect(result.needsHumanReview).toBe(true);

    const task = state.getTask('task-1');
    expect(task?.status).toBe('REVIEW');
    expect(task?.needsHumanReview).toBe(true);
    expect(task?.assignedWorkerId).toBeNull();
  });

  it('does not re-flip on repeated rejects past the hard cap (loop is bounded)', async () => {
    // A parked task stays parked; a further reject would require re-ownership,
    // but even the state proves no PLANNING churn: reopenCount 5 -> 6 stays parked.
    setupMoe(); writeEpic(); writeTask({ reopenCount: 5, assignedWorkerId: 'qa-a' });
    await state.load();
    const result = await qaRejectTool(state).handler(
      { taskId: 'task-1', reason: 'again', workerId: 'qa-a' }, state,
    ) as RejectResult;
    expect(result.status).toBe('REVIEW');
    expect(result.parkedForHuman).toBe(true);
  });

  it('excludes a parked REVIEW task from the ranked QA claim pool', async () => {
    setupMoe(); writeEpic();
    writeTask({ status: 'REVIEW', assignedWorkerId: null, needsHumanReview: true });
    await state.load();

    const result = await claimNextTaskTool(state).handler(
      { statuses: ['REVIEW'], workerId: 'qa-b' }, state,
    ) as { hasNext: boolean };
    expect(result.hasNext).toBe(false);
  });

  it('rejects an explicit claim of a parked REVIEW task', async () => {
    setupMoe(); writeEpic();
    writeTask({ status: 'REVIEW', assignedWorkerId: null, needsHumanReview: true });
    await state.load();

    await expect(
      claimNextTaskTool(state).handler(
        { statuses: ['REVIEW'], taskId: 'task-1', workerId: 'qa-b' }, state,
      ),
    ).rejects.toMatchObject({ code: MoeErrorCode.NOT_ALLOWED });
  });

  it('does not flip when the same DoD item is listed twice in ONE rejection', async () => {
    // Dedupe: duplicates within a single payload must NOT fake "failed twice".
    setupMoe(); writeEpic(); writeTask({ reopenCount: 0 });
    await state.load();
    const result = await qaRejectTool(state).handler(
      { taskId: 'task-1', reason: 'x', failedDodItems: ['DoD-X', 'DoD-X'], workerId: 'qa-a' }, state,
    ) as RejectResult;
    expect(result.status).toBe('WORKING');
  });

  it('flips to PLANNING only when the same DoD item fails across two distinct rejects', async () => {
    setupMoe(); writeEpic();
    // Pre-seed one prior failure of DoD-X in the log; a fresh failure of DoD-X
    // is now the second → same-item flip (below the reopen cap).
    writeTask({
      reopenCount: 0,
      failedDodItems: [{ item: 'DoD-X', rejectedAt: new Date().toISOString(), rejectedBy: 'qa-a' }],
    });
    await state.load();
    const result = await qaRejectTool(state).handler(
      { taskId: 'task-1', reason: 'x again', failedDodItems: ['DoD-X'], workerId: 'qa-a' }, state,
    ) as RejectResult;
    expect(result.status).toBe('PLANNING');
  });

  it('does NOT flip when the failed item differs from the prior attempt', async () => {
    setupMoe(); writeEpic();
    writeTask({
      reopenCount: 0,
      failedDodItems: [{ item: 'DoD-X', rejectedAt: new Date().toISOString(), rejectedBy: 'qa-a' }],
    });
    await state.load();
    const result = await qaRejectTool(state).handler(
      { taskId: 'task-1', reason: 'different item', failedDodItems: ['DoD-Y'], workerId: 'qa-a' }, state,
    ) as RejectResult;
    expect(result.status).toBe('WORKING');
  });
});

// ---- migrated from tools.test.ts ----
import { ToolTestHarness } from './toolTestHarness.js';
import { vi } from 'vitest';
import { getContextTool } from './getContext.js';

describe('moe.qa_reject', () => {
  const h = new ToolTestHarness();
  beforeEach(() => h.init());
  afterEach(() => { vi.restoreAllMocks(); h.cleanup(); });

  beforeEach(async () => {
    h.setupMoeFolder();
    h.createEpic();
    h.createTask({ id: 'task-1', status: 'REVIEW', reopenCount: 0 });
    await h.state.load();
  });

  it('rejects task and moves back to WORKING', async () => {
    const tool = qaRejectTool(h.state);
    const result = await tool.handler({
      taskId: 'task-1',
      reason: 'Tests are failing',
    }, h.state) as { success: boolean; status: string; reopenCount: number };

    expect(result.success).toBe(true);
    expect(result.status).toBe('WORKING');
    expect(result.reopenCount).toBe(1);

    const task = h.state.getTask('task-1');
    expect(task?.status).toBe('WORKING');
    expect(task?.reopenReason).toBe('Tests are failing');
  });

  it('increments reopenCount on multiple rejections', async () => {
    await h.state.updateTask('task-1', { reopenCount: 2 });

    const tool = qaRejectTool(h.state);
    const result = await tool.handler({
      taskId: 'task-1',
      reason: 'Still failing',
    }, h.state) as { reopenCount: number };

    expect(result.reopenCount).toBe(3);
  });

  it('throws for missing taskId', async () => {
    const tool = qaRejectTool(h.state);
    await expect(
      tool.handler({ reason: 'test' }, h.state)
    ).rejects.toThrow('Missing required field: taskId');
  });

  it('throws for missing reason', async () => {
    const tool = qaRejectTool(h.state);
    await expect(
      tool.handler({ taskId: 'task-1' }, h.state)
    ).rejects.toThrow('Missing required field: reason');
  });

  it('throws for empty reason', async () => {
    const tool = qaRejectTool(h.state);
    await expect(
      tool.handler({ taskId: 'task-1', reason: '  ' }, h.state)
    ).rejects.toThrow('Missing required field: reason');
  });

  it('throws for non-REVIEW status', async () => {
    await h.state.updateTask('task-1', { status: 'DONE' });
    const tool = qaRejectTool(h.state);
    await expect(
      tool.handler({ taskId: 'task-1', reason: 'test' }, h.state)
    ).rejects.toThrow('expected REVIEW');
  });

  it('stores failedDodItems on rejection', async () => {
    const tool = qaRejectTool(h.state);
    const result = await tool.handler({
      taskId: 'task-1',
      reason: 'DoD items failed',
      failedDodItems: ['Tests pass', 'Code reviewed'],
    }, h.state) as { success: boolean; rejectionDetails: { failedDodItems: string[] } };

    expect(result.success).toBe(true);
    expect(result.rejectionDetails.failedDodItems).toEqual(['Tests pass', 'Code reviewed']);

    const task = h.state.getTask('task-1');
    expect(task?.rejectionDetails?.failedDodItems).toEqual(['Tests pass', 'Code reviewed']);
  });

  it('stores structured issues on rejection', async () => {
    // Reset task to REVIEW for this test
    await h.state.updateTask('task-1', { status: 'REVIEW' });

    const tool = qaRejectTool(h.state);
    const result = await tool.handler({
      taskId: 'task-1',
      reason: 'Multiple issues found',
      issues: [
        { type: 'test_failure', description: 'UserService test fails', file: 'src/UserService.test.ts', line: 42 },
        { type: 'security', description: 'Missing input validation' },
      ],
    }, h.state) as { rejectionDetails: { issues: Array<{ type: string; file?: string }> } };

    expect(result.rejectionDetails.issues).toHaveLength(2);
    expect(result.rejectionDetails.issues[0].type).toBe('test_failure');
    expect(result.rejectionDetails.issues[0].file).toBe('src/UserService.test.ts');

    const task = h.state.getTask('task-1');
    expect(task?.rejectionDetails?.issues).toHaveLength(2);
  });

  it('works with reason only (backward compat)', async () => {
    await h.state.updateTask('task-1', { status: 'REVIEW' });

    const tool = qaRejectTool(h.state);
    const result = await tool.handler({
      taskId: 'task-1',
      reason: 'Simple rejection',
    }, h.state) as { success: boolean; rejectionDetails: null };

    expect(result.success).toBe(true);
    expect(result.rejectionDetails).toBeNull();
  });

  it('clears stale rejectionDetails after structured details are followed by reason-only rejection', async () => {
    const rejectTool = qaRejectTool(h.state);

    // Raise the reopen cap so this test (which performs three rejections)
    // doesn't trip the auto-flip-to-PLANNING path that newer qa_reject
    // applies once reopenCount >= maxReopens.
    await h.state.updateTask('task-1', { maxReopens: 10 } as Partial<import('../types/schema.js').Task>);

    await rejectTool.handler({
      taskId: 'task-1',
      reason: 'Initial structured rejection',
      failedDodItems: ['Tests pass'],
      issues: [{ type: 'test_failure', description: 'Old failure details', file: 'old.test.ts' }],
    }, h.state);
    expect(h.state.getTask('task-1')?.rejectionDetails).toEqual({
      failedDodItems: ['Tests pass'],
      issues: [{ type: 'test_failure', description: 'Old failure details', file: 'old.test.ts' }],
    });

    await h.state.updateTask('task-1', { status: 'REVIEW' });
    await rejectTool.handler({
      taskId: 'task-1',
      reason: 'Replacement structured rejection',
      failedDodItems: ['New DoD item only'],
    }, h.state);
    expect(h.state.getTask('task-1')?.rejectionDetails).toEqual({
      failedDodItems: ['New DoD item only'],
    });

    await h.state.updateTask('task-1', { status: 'REVIEW' });
    const reasonOnlyResult = await rejectTool.handler({
      taskId: 'task-1',
      reason: 'Reason-only rejection',
    }, h.state) as { rejectionDetails: null };
    expect(reasonOnlyResult.rejectionDetails).toBeNull();
    // After omit-instead-of-null change: stale details are cleared by
    // dropping the key entirely (schema is optional, not nullable).
    expect(h.state.getTask('task-1')?.rejectionDetails).toBeUndefined();

    const context = await getContextTool(h.state).handler({ taskId: 'task-1' }, h.state) as {
      task: { rejectionDetails: null };
    };
    expect(context.task.rejectionDetails).toBeNull();

    const claim = await claimNextTaskTool(h.state).handler({
      statuses: ['WORKING'],
      workerId: 'worker-after-reason-only',
    }, h.state) as { hasNext: boolean; task: { id: string; rejectionDetails: null } };
    expect(claim.hasNext).toBe(true);
    expect(claim.task.id).toBe('task-1');
    expect(claim.task.rejectionDetails).toBeNull();
  });

  it('throws for invalid issue type', async () => {
    await h.state.updateTask('task-1', { status: 'REVIEW' });

    const tool = qaRejectTool(h.state);
    await expect(
      tool.handler({
        taskId: 'task-1',
        reason: 'Bad issue type',
        issues: [{ type: 'invalid_type', description: 'test' }],
      }, h.state)
    ).rejects.toThrow('invalid type');
  });

  it('get_context returns rejectionDetails to worker', async () => {
    // Reject with structured feedback
    const rejectTool = qaRejectTool(h.state);
    await rejectTool.handler({
      taskId: 'task-1',
      reason: 'Tests fail',
      failedDodItems: ['Tests pass'],
      issues: [{ type: 'test_failure', description: 'Failing test in foo.test.ts' }],
    }, h.state);

    // Now check get_context as worker
    const ctxTool = getContextTool(h.state);
    const result = await ctxTool.handler({ taskId: 'task-1' }, h.state) as {
      task: {
        reopenReason: string;
        rejectionDetails: { failedDodItems: string[]; issues: Array<{ type: string }> };
      };
    };

    expect(result.task.reopenReason).toBe('Tests fail');
    expect(result.task.rejectionDetails.failedDodItems).toEqual(['Tests pass']);
    expect(result.task.rejectionDetails.issues).toHaveLength(1);
    expect(result.task.rejectionDetails.issues[0].type).toBe('test_failure');
  });
});

