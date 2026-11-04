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
    // Reopen cap 3 → reopenCount 0 -> 1 stays WORKING.
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

  it('ignores a maxReopens key on the task file: the reopen cap stays 3', async () => {
    // No tool writes task.maxReopens and qa_reject no longer reads it, so a stray
    // key (a hand-edited or legacy file) still loads and cannot move the cap.
    setupMoe(); writeEpic(); writeTask({ reopenCount: 2, maxReopens: 10 } as Partial<Task>);
    await state.load();
    const result = await qaRejectTool(state).handler(
      { taskId: 'task-1', reason: 'still broken', workerId: 'qa-a' }, state,
    ) as RejectResult & { maxReopens: number };
    expect(result.maxReopens).toBe(3);
    expect(result.status).toBe('PLANNING');
    expect(result.exceededReopenCap).toBe(true);
  });

  it('bumps the launch tier one step and the next claim carries it as `launch`', async () => {
    setupMoe(); writeEpic(); writeTask({ tier: 'light' });
    await state.load();
    await qaRejectTool(state).handler({ taskId: 'task-1', reason: 'fix it', workerId: 'qa-a' }, state);
    expect(state.getTask('task-1')?.tier).toBe('standard');

    await createWorker('w-1', 'IDLE', null);
    const claim = await claimNextTaskTool(state).handler(
      { statuses: ['WORKING'], workerId: 'w-1' }, state,
    ) as { hasNext: boolean; launch?: unknown };
    expect(claim.hasNext).toBe(true);
    expect(claim.launch).toEqual({ tier: 'standard', effort: 'xhigh', model: 'claude-opus-5-5', codex: { model: 'gpt-6-astra', effort: 'xhigh' } });

    // A resumed holder gets the same hint on the alreadyAssigned answer.
    const again = await claimNextTaskTool(state).handler(
      { statuses: ['WORKING'], workerId: 'w-1', taskId: undefined }, state,
    ) as { launch?: unknown };
    expect(again.launch).toEqual({ tier: 'standard', effort: 'xhigh', model: 'claude-opus-5-5', codex: { model: 'gpt-6-astra', effort: 'xhigh' } });
  });

  it('escalates a cheap-model attempt: both models back to their defaults, effort one allowed level up', async () => {
    setupMoe(); writeEpic();
    writeTask({ tier: 'light', effort: 'xhigh', model: 'claude-sonnet-5-5', codexModel: 'gpt-6-luna' });
    await state.load();
    await qaRejectTool(state).handler({ taskId: 'task-1', reason: 'fix it', workerId: 'qa-a' }, state);
    const task = state.getTask('task-1');
    expect(task?.tier).toBe('standard');
    expect(task?.effort).toBe('max');
    expect(task?.model).toBe('claude-opus-5-5');
    expect(task?.codexModel).toBe('gpt-6-astra');
  });

  it('sets an unset tier from the plan-size floor before bumping; a parked task keeps its tier', async () => {
    setupMoe(); writeEpic(); writeTask();
    await state.load();
    await qaRejectTool(state).handler({ taskId: 'task-1', reason: 'fix it', workerId: 'qa-a' }, state);
    expect(state.getTask('task-1')?.tier).toBe('standard');

    fs.rmSync(testDir, { recursive: true, force: true });
    setupMoe(); writeEpic(); writeTask({ id: 'task-1', reopenCount: 3, tier: 'light', capReplanAt: '2026-11-04T00:00:00.000Z' });
    state = new StateManager({ projectPath: testDir });
    await state.load();
    await qaRejectTool(state).handler({ taskId: 'task-1', reason: 'still bad', workerId: 'qa-a' }, state);
    expect(state.getTask('task-1')?.tier).toBe('light');
  });

  it('parks in REVIEW for a human past the hard cap instead of re-flipping to PLANNING', async () => {
    // reopenCount 3 -> 4 > maxReopens (hard cap) → parked in REVIEW, unassigned.
    setupMoe(); writeEpic(); writeTask({ reopenCount: 3, assignedWorkerId: 'qa-a', capReplanAt: '2026-11-04T00:00:00.000Z' });
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
    setupMoe(); writeEpic(); writeTask({ reopenCount: 5, assignedWorkerId: 'qa-a', capReplanAt: '2026-11-04T00:00:00.000Z' });
    await state.load();
    const result = await qaRejectTool(state).handler(
      { taskId: 'task-1', reason: 'again', workerId: 'qa-a' }, state,
    ) as RejectResult;
    expect(result.status).toBe('REVIEW');
    expect(result.parkedForHuman).toBe(true);
  });

  // The cap re-plan record (task-77e54ebb). reopenCount is monotonic and the
  // non-QA reopens bump it too (set_task_status REVIEW/DONE -> WORKING, a board
  // drag, REOPEN_TASK), so the hard cap parks a row only once the soft cap's one
  // re-plan is recorded on it (capReplanAt). The first two cases are hunt
  // task-928a468d's hardCapSkipsReplan repro.
  describe('the hard cap parks only after the cap re-plan', () => {
    // Two prior QA rejections, both back to WORKING (reopenCount 1, 2); unassigned until a QA seat claims it.
    const huntRow = (overrides: Partial<Task> = {}) => {
      const now = new Date().toISOString();
      return writeTask({
        definitionOfDone: ['DoD-A'], assignedWorkerId: null, contextFetchedBy: [],
        reopenCount: 2, reopenReason: 'second QA reject',
        rejectionHistory: [
          { reason: 'second QA reject', rejectedAt: now, reopenCount: 2 },
          { reason: 'first QA reject', rejectedAt: now, reopenCount: 1 },
        ],
        metrics: { rejectCount: 2, reopenCount: 2 },
        ...overrides,
      });
    };
    const move = (status: Task['status'], reason?: string) =>
      setTaskStatusTool(state).handler({ taskId: 'task-1', status, ...(reason ? { reason } : {}) }, state);
    // A QA seat claims, reads and rejects, as the wrapper flow does.
    async function qaReviewAndReject(reason = 'QA reject', extra: Record<string, unknown> = {}) {
      await claimNextTaskTool(state).handler({ statuses: ['REVIEW'], workerId: 'qa-a' }, state);
      await getContextTool(state).handler({ taskId: 'task-1', workerId: 'qa-a' }, state);
      return await qaRejectTool(state).handler(
        { taskId: 'task-1', reason, workerId: 'qa-a', ...extra }, state,
      ) as RejectResult & { message: string };
    }
    const reload = async () => { state = new StateManager({ projectPath: testDir }); await state.load(); };

    it('a human REVIEW -> WORKING reopen at reopenCount 2, then the next QA reject: PLANNING (one re-plan), not a park', async () => {
      setupMoe(); writeEpic(); huntRow();
      await state.load();
      await move('WORKING', 'human: also cover the empty-input case'); // reopenCount 2 -> 3
      expect(state.getTask('task-1')!.reopenCount).toBe(3);
      await move('REVIEW');
      const r = await qaReviewAndReject('third QA reject'); // 3 -> 4
      const t = state.getTask('task-1')!;
      expect({
        status: r.status, parkedForHuman: r.parkedForHuman, reopenCount: r.reopenCount,
        everEnteredPlanning: t.planningEntry !== undefined, needsHumanReview: t.needsHumanReview,
      }).toEqual({ status: 'PLANNING', parkedForHuman: false, reopenCount: 4, everEnteredPlanning: true, needsHumanReview: undefined });
      expect(r.message).toContain('flipped to PLANNING');
      expect(typeof t.capReplanAt).toBe('string');
    });

    it('a human DONE -> WORKING reopen of a row with 2 past rejects: its first new QA reject re-plans, not parks', async () => {
      setupMoe(); writeEpic(); huntRow({ status: 'DONE' });
      await state.load();
      await move('WORKING', 'human: regression found after DONE'); // 2 -> 3
      await move('REVIEW');
      const r = await qaReviewAndReject(); // 3 -> 4
      expect({ status: r.status, parkedForHuman: r.parkedForHuman, needsHumanReview: state.getTask('task-1')!.needsHumanReview })
        .toEqual({ status: 'PLANNING', parkedForHuman: false, needsHumanReview: undefined });
    });

    it('after that re-plan, the next QA reject parks the row for a human; the stamp survives a reload', async () => {
      setupMoe(); writeEpic(); huntRow();
      await state.load();
      await move('WORKING', 'human reopen'); // 2 -> 3
      await move('REVIEW');
      expect((await qaReviewAndReject()).status).toBe('PLANNING'); // 3 -> 4: the cap re-plan
      const stamp = state.getTask('task-1')!.capReplanAt;
      expect(typeof stamp).toBe('string');

      await reload();
      expect(state.getTask('task-1')!.capReplanAt).toBe(stamp);
      await move('AWAITING_APPROVAL'); // re-planned, approved and worked: none of these is a reopen
      await move('WORKING');
      await move('REVIEW');
      const r = await qaReviewAndReject('re-plan did not help either'); // 4 -> 5
      const t = state.getTask('task-1')!;
      expect({ status: r.status, parkedForHuman: r.parkedForHuman, needsHumanReview: r.needsHumanReview, reopenCount: r.reopenCount })
        .toEqual({ status: 'REVIEW', parkedForHuman: true, needsHumanReview: true, reopenCount: 5 });
      expect({ assignedWorkerId: t.assignedWorkerId, needsHumanReview: t.needsHumanReview, capReplanAt: t.capReplanAt })
        .toEqual({ assignedWorkerId: null, needsHumanReview: true, capReplanAt: stamp });
    });

    it('a legacy row past the cap with no capReplanAt reads as "no cap re-plan yet": PLANNING, and the stamp is written', async () => {
      setupMoe(); writeEpic(); writeTask({ reopenCount: 3 });
      await state.load();
      expect(state.getTask('task-1')!.capReplanAt).toBeUndefined();
      const r = await qaRejectTool(state).handler({ taskId: 'task-1', reason: 'still bad', workerId: 'qa-a' }, state) as RejectResult;
      expect({ status: r.status, parkedForHuman: r.parkedForHuman, exceededReopenCap: r.exceededReopenCap })
        .toEqual({ status: 'PLANNING', parkedForHuman: false, exceededReopenCap: true });
      expect(typeof state.getTask('task-1')!.capReplanAt).toBe('string');
    });

    it('the soft cap stamps capReplanAt; a same-DoD-item flip below the cap and a WORKING reject do not', async () => {
      setupMoe(); writeEpic(); writeTask({ reopenCount: 2 });
      await state.load();
      const reject = (extra: Record<string, unknown> = {}) =>
        qaRejectTool(state).handler({ taskId: 'task-1', reason: 'x', workerId: 'qa-a', ...extra }, state) as Promise<RejectResult>;
      expect((await reject()).status).toBe('PLANNING'); // 2 -> 3 == maxReopens
      expect(typeof state.getTask('task-1')!.capReplanAt).toBe('string');

      writeTask({ failedDodItems: [{ item: 'DoD-X', rejectedAt: new Date().toISOString(), rejectedBy: 'qa-a' }] });
      await reload();
      expect((await reject({ failedDodItems: ['DoD-X'] })).status).toBe('PLANNING');
      expect(state.getTask('task-1')!.capReplanAt).toBeUndefined();

      writeTask();
      await reload();
      expect((await reject()).status).toBe('WORKING');
      expect(state.getTask('task-1')!.capReplanAt).toBeUndefined();
    });
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
import { setTaskStatusTool } from './setTaskStatus.js';

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

    // A third rejection would reach the reopen cap (3) and flip to PLANNING;
    // this test is about rejectionDetails, so keep it below the cap.
    await h.state.updateTask('task-1', { status: 'REVIEW', reopenCount: 0 });
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

