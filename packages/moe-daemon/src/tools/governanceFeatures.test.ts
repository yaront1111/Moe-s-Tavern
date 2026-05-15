// Tests for the governance-control-plane features added in the May 2026 sprint:
// 1. typed affectedFiles + claim-time collision warnings
// 2. handoff notes on release_task + get_handoff_history
// 3. task metrics auto-population + list_metrics aggregate
// 4. task budgets with warn/escalate thresholds
// 5. plan critique tool with block→PLANNING flip
// 6. failed-DoD-item tracker auto-flipping on same-item-twice

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { StateManager } from '../state/StateManager.js';
import { submitPlanTool } from './submitPlan.js';
import { claimNextTaskTool } from './claimNextTask.js';
import { startStepTool } from './startStep.js';
import { completeStepTool } from './completeStep.js';
import { completeTaskTool } from './completeTask.js';
import { qaApproveTool } from './qaApprove.js';
import { qaRejectTool } from './qaReject.js';
import { releaseTaskTool } from './releaseTask.js';
import { getHandoffHistoryTool } from './getHandoffHistory.js';
import { listMetricsTool } from './listMetrics.js';
import { setTaskBudgetTool } from './setTaskBudget.js';
import { submitPlanCritiqueTool } from './submitPlanCritique.js';
import type { Project, Epic, Task } from '../types/schema.js';

describe('governance control-plane features', () => {
  let testDir: string;
  let moePath: string;
  let state: StateManager;

  function setupMoe(approvalMode: 'CONTROL' | 'SPEED' | 'TURBO' = 'TURBO') {
    fs.mkdirSync(moePath, { recursive: true });
    for (const sub of ['epics', 'tasks', 'workers', 'proposals', 'channels', 'messages', 'teams']) {
      fs.mkdirSync(path.join(moePath, sub));
    }
    const project: Partial<Project> = {
      id: 'proj-test',
      schemaVersion: 6,
      name: 'Test',
      rootPath: testDir,
      globalRails: { techStack: [], forbiddenPatterns: [], requiredPatterns: [], formatting: '', testing: '', customRules: [] },
      settings: {
        approvalMode,
        speedModeDelayMs: 2000,
        autoCreateBranch: false,
        branchPattern: '',
        commitPattern: '',
        agentCommand: 'claude',
        enableAgentTeams: false,
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(moePath, 'project.json'), JSON.stringify(project, null, 2));
  }

  function writeEpic(): Epic {
    const epic: Epic = {
      id: 'epic-1', projectId: 'proj-test', title: 'E', description: '', architectureNotes: '',
      epicRails: [], status: 'ACTIVE', order: 1,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(moePath, 'epics', 'epic-1.json'), JSON.stringify(epic, null, 2));
    return epic;
  }

  function writeTask(overrides: Partial<Task> = {}): Task {
    const now = new Date().toISOString();
    const task: Task = {
      id: 'task-1', epicId: 'epic-1', title: 'Test Task', description: 'desc',
      definitionOfDone: ['DoD1', 'DoD2'], taskRails: [], implementationPlan: [],
      status: 'PLANNING', assignedWorkerId: null, branch: null, prLink: null,
      reopenCount: 0, reopenReason: null, createdBy: 'HUMAN', parentTaskId: null,
      priority: 'MEDIUM', order: 1, comments: [],
      createdAt: now, updatedAt: now,
      ...overrides,
    };
    fs.writeFileSync(path.join(moePath, 'tasks', `${task.id}.json`), JSON.stringify(task, null, 2));
    return task;
  }

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moe-gov-'));
    moePath = path.join(testDir, '.moe');
    state = new StateManager({ projectPath: testDir });
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  // ---------------------------------------------------------------------------
  // Feature 1: affectedFiles collision warnings
  // ---------------------------------------------------------------------------
  describe('affectedFiles collision warnings', () => {
    it('normalizes affectedFiles and rejects traversal / absolute paths', async () => {
      setupMoe('TURBO');
      writeEpic();
      writeTask({ id: 'task-norm', status: 'PLANNING' });
      await state.load();
      const tool = submitPlanTool(state);

      // Backslash + leading ./ get normalized
      const ok = await tool.handler({
        taskId: 'task-norm',
        steps: [{ description: 'Edit A', affectedFiles: ['.\\src\\foo.ts', 'src/foo.ts'] }],
      }, state) as { taskId: string };
      const stored = state.getTask(ok.taskId)!;
      expect(stored.implementationPlan[0].affectedFiles).toEqual(['src/foo.ts']);

      // Absolute paths rejected
      writeTask({ id: 'task-abs', status: 'PLANNING' });
      await state.load();
      await expect(
        tool.handler({
          taskId: 'task-abs',
          steps: [{ description: 'X', affectedFiles: ['/etc/passwd'] }],
        }, state)
      ).rejects.toThrow(/project-relative/);

      // Traversal rejected
      writeTask({ id: 'task-trav', status: 'PLANNING' });
      await state.load();
      await expect(
        tool.handler({
          taskId: 'task-trav',
          steps: [{ description: 'X', affectedFiles: ['../leak.ts'] }],
        }, state)
      ).rejects.toThrow(/traversal/);
    });

    it('claiming a task with overlapping files returns a fileCollision warning, does not block', async () => {
      setupMoe('TURBO');
      writeEpic();
      // task-A currently being worked on, touches src/foo.ts
      writeTask({
        id: 'task-A',
        status: 'WORKING',
        assignedWorkerId: 'worker-a',
        implementationPlan: [{
          stepId: 'step-1', description: 'edit foo', status: 'IN_PROGRESS', affectedFiles: ['src/foo.ts'],
        }],
      });
      // task-B is up for grabs and overlaps on src/foo.ts
      writeTask({
        id: 'task-B',
        status: 'WORKING',
        assignedWorkerId: null,
        implementationPlan: [{
          stepId: 'step-1', description: 'also edit foo', status: 'PENDING', affectedFiles: ['src/foo.ts', 'src/bar.ts'],
        }],
      });
      await state.load();

      const claim = claimNextTaskTool(state);
      const result = await claim.handler({
        workerId: 'worker-b',
        statuses: ['WORKING'],
        taskId: 'task-B',
      }, state) as { hasNext: boolean; task: { id: string }; fileCollision?: Array<{ task: string; files: string[] }> };

      expect(result.hasNext).toBe(true);
      expect(result.task.id).toBe('task-B');
      expect(result.fileCollision).toBeDefined();
      expect(result.fileCollision).toHaveLength(1);
      expect(result.fileCollision![0].task).toBe('task-A');
      expect(result.fileCollision![0].files).toEqual(['src/foo.ts']);
    });
  });

  // ---------------------------------------------------------------------------
  // Feature 2: HandoffNote on release_task + get_handoff_history
  // ---------------------------------------------------------------------------
  describe('release_task handoff notes', () => {
    it('appends handoffNote and surfaces it via get_handoff_history; subsequent claim recommends fetching it', async () => {
      setupMoe('TURBO');
      writeEpic();
      writeTask({
        id: 'task-h',
        status: 'WORKING',
        assignedWorkerId: 'worker-a',
        implementationPlan: [{ stepId: 'step-1', description: 's', status: 'IN_PROGRESS', affectedFiles: [] }],
      });
      await state.load();

      const releaseTool = releaseTaskTool(state);
      const releaseResult = await releaseTool.handler({
        taskId: 'task-h',
        workerId: 'worker-a',
        reason: 'context exhausted',
        handoffNote: {
          whatIsDone: 'Refactored auth module',
          whatRemains: 'Wire UI strings',
          pitfalls: 'Watch shared mutable state',
          openQuestions: 'Should we cache tokens?',
        },
      }, state) as { priorHandoffCount: number; warning?: string };
      expect(releaseResult.priorHandoffCount).toBe(1);
      expect(releaseResult.warning).toBeUndefined();

      const histTool = getHandoffHistoryTool(state);
      const hist = await histTool.handler({ taskId: 'task-h' }, state) as {
        priorHandoffs: Array<{ whatIsDone: string; whatRemains: string; pitfalls?: string; releasedBy?: string }>;
      };
      expect(hist.priorHandoffs).toHaveLength(1);
      expect(hist.priorHandoffs[0].whatIsDone).toBe('Refactored auth module');
      expect(hist.priorHandoffs[0].pitfalls).toBe('Watch shared mutable state');
      expect(hist.priorHandoffs[0].releasedBy).toBe('worker-a');

      // Next worker claiming the released task gets a recommendation
      const claim = claimNextTaskTool(state);
      const claimResult = await claim.handler({
        workerId: 'worker-b',
        statuses: ['WORKING'],
        taskId: 'task-h',
      }, state) as {
        handoffHint?: string;
        nextAction: { tool: string };
        task: { priorHandoffCount: number };
      };
      expect(claimResult.handoffHint).toMatch(/get_handoff_history/);
      expect(claimResult.nextAction.tool).toBe('moe.get_handoff_history');
      expect(claimResult.task.priorHandoffCount).toBe(1);
    });

    it('releasing without handoffNote returns a warning but still succeeds', async () => {
      setupMoe('TURBO');
      writeEpic();
      writeTask({
        id: 'task-nh',
        status: 'WORKING',
        assignedWorkerId: 'worker-a',
      });
      await state.load();

      const releaseTool = releaseTaskTool(state);
      const result = await releaseTool.handler({
        taskId: 'task-nh',
        workerId: 'worker-a',
      }, state) as { success: boolean; warning?: string };
      expect(result.success).toBe(true);
      expect(result.warning).toMatch(/without handoffNote/);
      expect(state.getTask('task-nh')!.priorHandoffs).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // Feature 3: task.metrics
  // ---------------------------------------------------------------------------
  describe('task metrics', () => {
    it('populates plannedStepCount / firstClaimAt / executedStepCount / doneAt / wallClockMs across a full lifecycle', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-05-15T00:00:00.000Z'));
      try {
        setupMoe('TURBO');
        writeEpic();
        writeTask({ id: 'task-m', status: 'PLANNING' });
        await state.load();

        // submit_plan -> plannedStepCount
        const submit = submitPlanTool(state);
        await submit.handler({
          taskId: 'task-m',
          steps: [
            { description: 'one', affectedFiles: ['a.ts'] },
            { description: 'two', affectedFiles: ['b.ts'] },
          ],
        }, state);
        expect(state.getTask('task-m')!.metrics?.plannedStepCount).toBe(2);

        // claim -> firstClaimAt
        const claim = claimNextTaskTool(state);
        await claim.handler({ workerId: 'worker-a', statuses: ['WORKING'], taskId: 'task-m' }, state);
        expect(state.getTask('task-m')!.metrics?.firstClaimAt).toBe('2026-05-15T00:00:00.000Z');

        // Simulate get_context call so start_step ownership guard passes
        await state.updateTask('task-m', { contextFetchedBy: ['worker-a'] });

        // start_step + complete_step -> executedStepCount
        const startStep = startStepTool(state);
        const completeStep = completeStepTool(state);
        await startStep.handler({ taskId: 'task-m', stepId: 'step-1', workerId: 'worker-a' }, state);
        await completeStep.handler({ taskId: 'task-m', stepId: 'step-1', workerId: 'worker-a' }, state);
        expect(state.getTask('task-m')!.metrics?.executedStepCount).toBe(1);
        await startStep.handler({ taskId: 'task-m', stepId: 'step-2', workerId: 'worker-a' }, state);
        await completeStep.handler({ taskId: 'task-m', stepId: 'step-2', workerId: 'worker-a' }, state);
        expect(state.getTask('task-m')!.metrics?.executedStepCount).toBe(2);

        // Advance time, complete_task → REVIEW, qa_approve → DONE
        vi.setSystemTime(new Date('2026-05-15T01:00:00.000Z'));
        const completeTask = completeTaskTool(state);
        await completeTask.handler({ taskId: 'task-m', workerId: 'worker-a' }, state);

        // QA claim and approve
        await claim.handler({ workerId: 'qa-1', statuses: ['REVIEW'], taskId: 'task-m' }, state);
        const qaApprove = qaApproveTool(state);
        await qaApprove.handler({ taskId: 'task-m', workerId: 'qa-1' }, state);

        const finalMetrics = state.getTask('task-m')!.metrics!;
        expect(finalMetrics.doneAt).toBe('2026-05-15T01:00:00.000Z');
        expect(finalMetrics.wallClockMs).toBe(60 * 60 * 1000);
      } finally {
        vi.useRealTimers();
      }
    });

    it('list_metrics aggregate returns zeroes when nothing matches the filter', async () => {
      setupMoe('TURBO');
      writeEpic();
      await state.load();
      const tool = listMetricsTool(state);
      const result = await tool.handler({ epicId: 'nonexistent-epic' }, state) as {
        aggregate: { taskCount: number; avgWallClockMs: number; firstPassApprovalPct: number; avgReopenCount: number };
        tasks: unknown[];
      };
      expect(result.aggregate).toEqual({
        taskCount: 0,
        doneCount: 0,
        avgWallClockMs: 0,
        firstPassApprovalPct: 0,
        avgReopenCount: 0,
        totalRejectCount: 0,
        totalExecutedStepCount: 0,
        totalToolCalls: 0,
      });
      expect(result.tasks).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------
  // Feature 4: task.budget — warn at 80%, escalate at 100%, idempotent
  // ---------------------------------------------------------------------------
  describe('task budget', () => {
    it('warns at 80% and escalates at 100%, each only once', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-05-15T00:00:00.000Z'));
      try {
        setupMoe('TURBO');
        writeEpic();
        writeTask({
          id: 'task-b',
          status: 'WORKING',
          assignedWorkerId: 'worker-a',
          contextFetchedBy: ['worker-a'],
          metrics: { firstClaimAt: '2026-05-15T00:00:00.000Z' },
          budget: { wallClockMs: 10_000 },
          implementationPlan: [
            { stepId: 'step-1', description: 's1', status: 'IN_PROGRESS', affectedFiles: [] },
            { stepId: 'step-2', description: 's2', status: 'PENDING', affectedFiles: [] },
          ],
        });
        await state.load();

        const completeStep = completeStepTool(state);

        // At 8s elapsed (80% of 10s) → warnedAt populated
        vi.setSystemTime(new Date('2026-05-15T00:00:08.000Z'));
        await completeStep.handler({ taskId: 'task-b', stepId: 'step-1', workerId: 'worker-a' }, state);
        let b = state.getTask('task-b')!.budget!;
        expect(b.warnedAt).toBeDefined();
        expect(b.escalatedAt).toBeUndefined();
        const firstWarnedAt = b.warnedAt;

        // Re-invoking before 100% does NOT change warnedAt (idempotent)
        const startStep = startStepTool(state);
        vi.setSystemTime(new Date('2026-05-15T00:00:09.000Z'));
        await startStep.handler({ taskId: 'task-b', stepId: 'step-2', workerId: 'worker-a' }, state);
        b = state.getTask('task-b')!.budget!;
        expect(b.warnedAt).toBe(firstWarnedAt);
        expect(b.escalatedAt).toBeUndefined();

        // Past 100% → escalatedAt populated
        vi.setSystemTime(new Date('2026-05-15T00:00:11.000Z'));
        await completeStep.handler({ taskId: 'task-b', stepId: 'step-2', workerId: 'worker-a' }, state);
        b = state.getTask('task-b')!.budget!;
        expect(b.warnedAt).toBe(firstWarnedAt); // unchanged
        expect(b.escalatedAt).toBeDefined();
        const firstEscalatedAt = b.escalatedAt;

        // set_task_budget on top of escalated task does not re-mutate the marks
        const setBudget = setTaskBudgetTool(state);
        await setBudget.handler({ taskId: 'task-b', wallClockMs: 10_000 }, state);
        b = state.getTask('task-b')!.budget!;
        expect(b.escalatedAt).toBe(firstEscalatedAt);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Feature 5: submit_plan_critique
  // ---------------------------------------------------------------------------
  describe('plan critique', () => {
    it('verdict=block flips AWAITING_APPROVAL → PLANNING with concerns; does not auto-approve', async () => {
      setupMoe('CONTROL');
      writeEpic();
      writeTask({ id: 'task-c', status: 'AWAITING_APPROVAL', implementationPlan: [
        { stepId: 'step-1', description: 's', status: 'PENDING', affectedFiles: [] },
      ] });
      await state.load();

      const critique = submitPlanCritiqueTool(state);
      const result = await critique.handler({
        taskId: 'task-c',
        verdict: 'block',
        concerns: ['Missing DB migration', 'No rollback plan'],
        workerId: 'governor-1',
      }, state) as { status: string; planCritiqueResult: { verdict: string; concerns?: string[] } };

      expect(result.status).toBe('PLANNING');
      expect(result.planCritiqueResult.verdict).toBe('block');
      expect(result.planCritiqueResult.concerns).toEqual(['Missing DB migration', 'No rollback plan']);
      expect(state.getTask('task-c')!.status).toBe('PLANNING');
      // Critique does NOT auto-approve — verdict='pass' alone never moves a task to WORKING
    });

    it('verdict=pass records the critique without changing status', async () => {
      setupMoe('CONTROL');
      writeEpic();
      writeTask({ id: 'task-cp', status: 'AWAITING_APPROVAL', implementationPlan: [
        { stepId: 'step-1', description: 's', status: 'PENDING', affectedFiles: [] },
      ] });
      await state.load();

      const critique = submitPlanCritiqueTool(state);
      const result = await critique.handler({
        taskId: 'task-cp',
        verdict: 'pass',
        workerId: 'governor-1',
      }, state) as { status: string; planCritiqueResult: { verdict: string } };

      expect(result.status).toBe('AWAITING_APPROVAL');
      expect(result.planCritiqueResult.verdict).toBe('pass');
      expect(state.getTask('task-cp')!.status).toBe('AWAITING_APPROVAL');
    });

    it('block verdict requires concerns', async () => {
      setupMoe('CONTROL');
      writeEpic();
      writeTask({ id: 'task-cb', status: 'AWAITING_APPROVAL' });
      await state.load();
      const critique = submitPlanCritiqueTool(state);
      await expect(
        critique.handler({ taskId: 'task-cb', verdict: 'block' }, state)
      ).rejects.toThrow(/concerns/);
    });
  });

  // ---------------------------------------------------------------------------
  // Feature 6: failedDodItems same-item-twice auto-flip
  // ---------------------------------------------------------------------------
  describe('failedDodItems tracker', () => {
    it('flips to PLANNING when the same DoD item is rejected twice even before maxReopens', async () => {
      setupMoe('TURBO');
      writeEpic();
      writeTask({
        id: 'task-d',
        status: 'REVIEW',
        assignedWorkerId: 'qa-1',
        maxReopens: 10, // ensure reopen-cap does NOT trigger first
        implementationPlan: [
          { stepId: 'step-1', description: 's', status: 'COMPLETED', affectedFiles: [] },
        ],
        definitionOfDone: ['Tests pass', 'Docs updated'],
      });
      await state.load();

      const reject = qaRejectTool(state);

      // First rejection on "Tests pass"
      await reject.handler({
        taskId: 'task-d',
        reason: 'first fail',
        failedDodItems: ['Tests pass'],
        workerId: 'qa-1',
      }, state);
      expect(state.getTask('task-d')!.status).toBe('WORKING');
      const afterFirst = state.getTask('task-d')!;
      expect(afterFirst.failedDodItems?.map((f) => f.item)).toEqual(['Tests pass']);

      // Worker re-claims, completes, hands to QA again
      await state.updateTask('task-d', { status: 'REVIEW', assignedWorkerId: 'qa-1' });

      // Second rejection on the SAME item → auto-flip to PLANNING
      const result = await reject.handler({
        taskId: 'task-d',
        reason: 'still failing tests',
        failedDodItems: ['Tests pass'],
        workerId: 'qa-1',
      }, state) as { status: string; repeatedFailedDodItem?: string };

      expect(result.status).toBe('PLANNING');
      expect(result.repeatedFailedDodItem).toBe('Tests pass');
      expect(state.getTask('task-d')!.status).toBe('PLANNING');
      // Did NOT hit the reopen cap (maxReopens=10, count=2)
      expect(state.getTask('task-d')!.reopenCount).toBe(2);
    });
  });
});
