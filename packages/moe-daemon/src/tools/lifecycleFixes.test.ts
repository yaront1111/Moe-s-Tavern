import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { StateManager } from '../state/StateManager.js';
import { completeStepTool } from './completeStep.js';
import { setTaskStatusTool } from './setTaskStatus.js';
import { submitPlanCritiqueTool } from './submitPlanCritique.js';
import type { Epic, Project, ProjectSettings, Task, TeamRole, Worker } from '../types/schema.js';

// Covers the lifecycle-tool fixes:
//   L6  completeStep  — IN_PROGRESS steps count as "remaining" (no false complete_task nudge)
//   L30 setTaskStatus — WIP column count excludes ARCHIVED (matches the WS path)
//   M2  submitPlanCritique — non-flipping block must NOT orphan the active worker
describe('lifecycle tool fixes', () => {
  let testDir: string;
  let moePath: string;
  let state: StateManager;

  function setupMoe(settings: Partial<ProjectSettings> = {}) {
    fs.mkdirSync(moePath, { recursive: true });
    for (const sub of ['epics', 'tasks', 'workers', 'proposals', 'channels', 'messages', 'teams']) {
      fs.mkdirSync(path.join(moePath, sub));
    }
    const project: Partial<Project> = {
      id: 'proj-test', schemaVersion: 6, name: 'Test', rootPath: testDir,
      globalRails: { techStack: [], forbiddenPatterns: [], requiredPatterns: [], formatting: '', testing: '', customRules: [] },
      settings: {
        approvalMode: 'TURBO', speedModeDelayMs: 2000, autoCreateBranch: false,
        branchPattern: '', commitPattern: '', agentCommand: 'claude', enableAgentTeams: false,
        ...settings,
      } as ProjectSettings,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
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
      id: 'task-1', epicId: 'epic-1', title: 't', description: '',
      definitionOfDone: [], taskRails: [],
      implementationPlan: [],
      status: 'WORKING', assignedWorkerId: null, branch: null, prLink: null,
      contextFetchedBy: [],
      reopenCount: 0, reopenReason: null, createdBy: 'HUMAN', parentTaskId: null,
      priority: 'MEDIUM', order: 1, comments: [],
      createdAt: now, updatedAt: now,
      ...overrides,
    };
    fs.writeFileSync(path.join(moePath, 'tasks', task.id + '.json'), JSON.stringify(task, null, 2));
    return task;
  }

  function writeWorker(overrides: Partial<Worker> = {}): Worker {
    const now = new Date().toISOString();
    const worker: Worker = {
      id: 'worker-a', type: 'CLAUDE', projectId: 'proj-test', epicId: 'epic-1',
      currentTaskId: null, status: 'IDLE', branch: '', modifiedFiles: [],
      startedAt: now, lastActivityAt: now, lastError: null, errorCount: 0, teamId: null,
      ...overrides,
    };
    fs.writeFileSync(path.join(moePath, 'workers', worker.id + '.json'), JSON.stringify(worker, null, 2));
    return worker;
  }

  async function bindWorkerToTeamRole(workerId: string, role: TeamRole): Promise<void> {
    const team = await state.createTeam({ name: `${role}s`, role });
    await state.addTeamMember(team.id, workerId);
  }

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moe-lifecycle-fix-'));
    moePath = path.join(testDir, '.moe');
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  // ---- L6: completeStep treats IN_PROGRESS as remaining ----------------------
  describe('completeStep counts IN_PROGRESS steps as remaining', () => {
    it('does NOT nudge complete_task when another step is still IN_PROGRESS', async () => {
      setupMoe();
      writeEpic();
      writeTask({
        assignedWorkerId: 'worker-a',
        contextFetchedBy: ['worker-a'],
        implementationPlan: [
          { stepId: 'step-1', description: 'first', status: 'IN_PROGRESS', affectedFiles: [] },
          { stepId: 'step-2', description: 'second', status: 'IN_PROGRESS', affectedFiles: [] },
        ],
      });
      state = new StateManager({ projectPath: testDir });
      await state.load();

      const result = await completeStepTool(state).handler(
        { taskId: 'task-1', stepId: 'step-1', workerId: 'worker-a' },
        state
      ) as Record<string, unknown>;

      // step-2 is still IN_PROGRESS, so it remains and complete_task must NOT be nudged.
      const nextAction = result.nextAction as { tool: string; args: Record<string, unknown> };
      expect(nextAction.tool).toBe('moe.complete_step');
      expect(nextAction.args.stepId).toBe('step-2');
      expect(result.nextStep).toMatchObject({ stepId: 'step-2' });
      expect(result.chatHint).toBeUndefined();
    });

    it('nudges complete_task only when no PENDING/IN_PROGRESS steps remain', async () => {
      setupMoe();
      writeEpic();
      writeTask({
        assignedWorkerId: 'worker-a',
        contextFetchedBy: ['worker-a'],
        implementationPlan: [
          { stepId: 'step-1', description: 'only', status: 'IN_PROGRESS', affectedFiles: [] },
        ],
      });
      state = new StateManager({ projectPath: testDir });
      await state.load();

      const result = await completeStepTool(state).handler(
        { taskId: 'task-1', stepId: 'step-1', workerId: 'worker-a' },
        state
      ) as Record<string, unknown>;

      const nextAction = result.nextAction as { tool: string };
      expect(nextAction.tool).toBe('moe.complete_task');
      expect(result.nextStep).toBeNull();
    });
  });

  // ---- L30: setTaskStatus WIP count excludes ARCHIVED ------------------------
  describe('setTaskStatus WIP limit excludes ARCHIVED tasks', () => {
    it('allows archiving even when an ARCHIVED WIP limit is already met by archived tasks', async () => {
      setupMoe({ columnLimits: { ARCHIVED: 1 } });
      writeEpic();
      writeTask({ id: 'task-arch', status: 'ARCHIVED' });
      writeTask({ id: 'task-1', status: 'REVIEW' });
      state = new StateManager({ projectPath: testDir });
      await state.load();

      // Existing ARCHIVED task count must NOT count toward the ARCHIVED WIP limit.
      const result = await setTaskStatusTool(state).handler(
        { taskId: 'task-1', status: 'ARCHIVED' },
        state
      ) as Record<string, unknown>;

      expect(result.success).toBe(true);
      expect(state.getTask('task-1')!.status).toBe('ARCHIVED');
    });
  });

  // ---- M2: non-flipping block must not orphan the active worker --------------
  describe('submitPlanCritique block does not orphan a worker when the task does not flip', () => {
    it('leaves the active worker owning its task on a non-flippable (REVIEW) block', async () => {
      setupMoe();
      writeEpic();
      writeWorker({ id: 'governor-1', status: 'GOVERNING' });
      writeWorker({ id: 'qa-1', status: 'REVIEWING', currentTaskId: 'task-1' });
      writeTask({ id: 'task-1', status: 'REVIEW', assignedWorkerId: 'qa-1' });
      state = new StateManager({ projectPath: testDir });
      await state.load();
      await bindWorkerToTeamRole('governor-1', 'governor');

      const result = await submitPlanCritiqueTool(state).handler(
        { taskId: 'task-1', verdict: 'block', concerns: ['stale plan'], workerId: 'governor-1' },
        state
      ) as Record<string, unknown>;

      // REVIEW is not flippable: task stays put and the QA worker keeps its task.
      expect(result.status).toBe('REVIEW');
      expect(state.getTask('task-1')!.status).toBe('REVIEW');
      const qa = state.getWorker('qa-1')!;
      expect(qa.currentTaskId).toBe('task-1');
      expect(qa.status).not.toBe('IDLE');
    });

    it('still flips and idles the worker on a flippable (WORKING) block', async () => {
      setupMoe();
      writeEpic();
      writeWorker({ id: 'governor-1', status: 'GOVERNING' });
      writeWorker({ id: 'worker-a', status: 'CODING', currentTaskId: 'task-1' });
      writeTask({ id: 'task-1', status: 'WORKING', assignedWorkerId: 'worker-a' });
      state = new StateManager({ projectPath: testDir });
      await state.load();
      await bindWorkerToTeamRole('governor-1', 'governor');

      const result = await submitPlanCritiqueTool(state).handler(
        { taskId: 'task-1', verdict: 'block', concerns: ['bad approach'], workerId: 'governor-1' },
        state
      ) as Record<string, unknown>;

      expect(result.status).toBe('PLANNING');
      expect(state.getTask('task-1')!.status).toBe('PLANNING');
      const w = state.getWorker('worker-a')!;
      expect(w.currentTaskId).toBeNull();
      expect(w.status).toBe('IDLE');
    });
  });
});
