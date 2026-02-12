import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { StateManager } from '../state/StateManager.js';
import { getContextTool } from './getContext.js';
import { submitPlanTool } from './submitPlan.js';
import { checkApprovalTool } from './checkApproval.js';
import { startStepTool } from './startStep.js';
import { completeStepTool } from './completeStep.js';
import { completeTaskTool } from './completeTask.js';
import { reportBlockedTool } from './reportBlocked.js';
import { listTasksTool } from './listTasks.js';
import { getNextTaskTool } from './getNextTask.js';
import { createTaskTool } from './createTask.js';
import { createEpicTool } from './createEpic.js';
import { createTeamTool } from './createTeam.js';
import { setTaskStatusTool } from './setTaskStatus.js';
import { claimNextTaskTool } from './claimNextTask.js';
import { proposeRailTool } from './proposeRail.js';
import { deleteTaskTool } from './deleteTask.js';
import { updateEpicTool } from './updateEpic.js';
import { deleteEpicTool } from './deleteEpic.js';
import { searchTasksTool } from './searchTasks.js';
import { qaApproveTool } from './qaApprove.js';
import { qaRejectTool } from './qaReject.js';
import { getActivityLogTool } from './getActivityLog.js';
import { unblockWorkerTool } from './unblockWorker.js';
import { addCommentTool } from './addComment.js';
import { getPendingQuestionsTool } from './getPendingQuestions.js';
import type { Task, Epic, Worker, Project, RailProposal } from '../types/schema.js';

describe('MCP Tools', () => {
  let testDir: string;
  let moePath: string;
  let state: StateManager;

  function setupMoeFolder(projectOverrides: Partial<Project> = {}) {
    fs.mkdirSync(moePath, { recursive: true });
    fs.mkdirSync(path.join(moePath, 'epics'));
    fs.mkdirSync(path.join(moePath, 'tasks'));
    fs.mkdirSync(path.join(moePath, 'workers'));
    fs.mkdirSync(path.join(moePath, 'proposals'));

    const project = {
      id: 'proj-test',
      name: 'Test Project',
      rootPath: testDir,
      globalRails: {
        techStack: ['typescript'],
        forbiddenPatterns: ['rm -rf'],
        requiredPatterns: [],
        formatting: '',
        testing: '',
        customRules: [],
      },
      settings: {
        approvalMode: 'CONTROL',
        speedModeDelayMs: 2000,
        autoCreateBranch: true,
        branchPattern: 'moe/{epicId}/{taskId}',
        commitPattern: 'feat({epicId}): {taskTitle}',
        agentCommand: 'claude',
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...projectOverrides,
    };

    fs.writeFileSync(path.join(moePath, 'project.json'), JSON.stringify(project, null, 2));
    return project;
  }

  function createEpic(overrides: Partial<Epic> = {}): Epic {
    const epic: Epic = {
      id: 'epic-1',
      projectId: 'proj-test',
      title: 'Test Epic',
      description: 'Epic description',
      architectureNotes: 'Some notes',
      epicRails: [],
      status: 'ACTIVE',
      order: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...overrides,
    };
    fs.writeFileSync(path.join(moePath, 'epics', `${epic.id}.json`), JSON.stringify(epic, null, 2));
    return epic;
  }

  function createTask(overrides: Partial<Task> = {}): Task {
    const task: Task = {
      id: 'task-1',
      epicId: 'epic-1',
      title: 'Test Task',
      description: 'Task description',
      definitionOfDone: ['Tests pass', 'Code reviewed'],
      taskRails: [],
      implementationPlan: [],
      status: 'BACKLOG',
      assignedWorkerId: null,
      branch: null,
      prLink: null,
      reopenCount: 0,
      reopenReason: null,
      createdBy: 'HUMAN',
      parentTaskId: null,
      order: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...overrides,
    };
    fs.writeFileSync(path.join(moePath, 'tasks', `${task.id}.json`), JSON.stringify(task, null, 2));
    return task;
  }

  function createWorker(overrides: Partial<Worker> = {}): Worker {
    const worker: Worker = {
      id: 'worker-1',
      type: 'CLAUDE',
      projectId: 'proj-test',
      epicId: 'epic-1',
      currentTaskId: null,
      status: 'IDLE',
      branch: 'main',
      modifiedFiles: [],
      startedAt: new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
      lastError: null,
      errorCount: 0,
      ...overrides,
    };
    fs.writeFileSync(path.join(moePath, 'workers', `${worker.id}.json`), JSON.stringify(worker, null, 2));
    return worker;
  }

  beforeEach(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moe-tools-test-'));
    moePath = path.join(testDir, '.moe');
    state = new StateManager({ projectPath: testDir });
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  describe('moe.get_context', () => {
    it('returns project context without task', async () => {
      setupMoeFolder();
      await state.load();
      const tool = getContextTool(state);
      const result = await tool.handler({}, state) as { project: { name: string }; task: null };

      expect(result.project.name).toBe('Test Project');
      expect(result.task).toBeNull();
    });

    it('returns task context when taskId provided', async () => {
      setupMoeFolder();
      createEpic();
      createTask();
      await state.load();
      const tool = getContextTool(state);
      const result = await tool.handler({ taskId: 'task-1' }, state) as { task: { id: string }; epic: { id: string } };

      expect(result.task?.id).toBe('task-1');
      expect(result.epic?.id).toBe('epic-1');
    });

    it('throws if project not loaded', async () => {
      const tool = getContextTool(state);
      await expect(tool.handler({}, state)).rejects.toThrow('not loaded state, expected loaded');
    });

    it('returns worker when task has assignedWorkerId', async () => {
      setupMoeFolder();
      createEpic();
      createWorker({ id: 'worker-ctx', status: 'CODING', lastError: 'prev error', errorCount: 2 });
      createTask({ assignedWorkerId: 'worker-ctx' });
      await state.load();
      const tool = getContextTool(state);
      const result = await tool.handler({ taskId: 'task-1' }, state) as {
        worker: { id: string; status: string; lastError: string | null; errorCount: number } | null;
      };

      expect(result.worker).not.toBeNull();
      expect(result.worker!.id).toBe('worker-ctx');
      expect(result.worker!.status).toBe('CODING');
      expect(result.worker!.lastError).toBe('prev error');
      expect(result.worker!.errorCount).toBe(2);
    });

    it('returns null worker when task has no assignedWorkerId', async () => {
      setupMoeFolder();
      createEpic();
      createTask({ assignedWorkerId: null });
      await state.load();
      const tool = getContextTool(state);
      const result = await tool.handler({ taskId: 'task-1' }, state) as { worker: null };

      expect(result.worker).toBeNull();
    });

    it('returns null worker when no task provided', async () => {
      setupMoeFolder();
      await state.load();
      const tool = getContextTool(state);
      const result = await tool.handler({}, state) as { worker: null };

      expect(result.worker).toBeNull();
    });

    it('returns step notes in implementationPlan', async () => {
      setupMoeFolder();
      createEpic();
      createTask({
        implementationPlan: [
          { stepId: 'step-1', description: 'First', status: 'COMPLETED', affectedFiles: ['a.ts'], note: 'Design decision: used factory pattern', modifiedFiles: ['a.ts', 'b.ts'] },
          { stepId: 'step-2', description: 'Second', status: 'PENDING', affectedFiles: [] },
        ],
      });
      await state.load();
      const tool = getContextTool(state);
      const result = await tool.handler({ taskId: 'task-1' }, state) as {
        task: { implementationPlan: Array<{ stepId: string; note?: string; modifiedFiles?: string[] }> };
      };

      const step1 = result.task.implementationPlan.find(s => s.stepId === 'step-1');
      expect(step1?.note).toBe('Design decision: used factory pattern');
      expect(step1?.modifiedFiles).toEqual(['a.ts', 'b.ts']);
    });
  });

  describe('moe.submit_plan', () => {
    beforeEach(async () => {
      setupMoeFolder();
      createEpic();
      createTask({ status: 'PLANNING' });
      await state.load();
    });

    it('submits a valid plan', async () => {
      const tool = submitPlanTool(state);
      const result = await tool.handler({
        taskId: 'task-1',
        steps: [
          { description: 'Step 1', affectedFiles: ['file.ts'] },
          { description: 'Step 2', affectedFiles: [] },
        ],
      }, state) as { success: boolean; status: string; stepCount: number };

      expect(result.success).toBe(true);
      expect(result.status).toBe('AWAITING_APPROVAL');
      expect(result.stepCount).toBe(2);

      const task = state.getTask('task-1');
      expect(task?.status).toBe('AWAITING_APPROVAL');
      expect(task?.implementationPlan.length).toBe(2);
    });

    it('throws for non-existent task', async () => {
      const tool = submitPlanTool(state);
      await expect(
        tool.handler({ taskId: 'nonexistent', steps: [{ description: 'Step 1' }] }, state)
      ).rejects.toThrow('Task not found');
    });

    it('throws for wrong task status', async () => {
      await state.updateTask('task-1', { status: 'WORKING' });
      const tool = submitPlanTool(state);
      await expect(
        tool.handler({ taskId: 'task-1', steps: [{ description: 'Step 1' }] }, state)
      ).rejects.toThrow('expected PLANNING');
    });

    it('throws for empty plan', async () => {
      const tool = submitPlanTool(state);
      await expect(
        tool.handler({ taskId: 'task-1', steps: [] }, state)
      ).rejects.toThrow('plan cannot be empty');
    });

    it('rejects plan with forbidden pattern', async () => {
      const tool = submitPlanTool(state);
      await expect(
        tool.handler({ taskId: 'task-1', steps: [{ description: 'Run rm -rf /' }] }, state)
      ).rejects.toThrow('Rail violation');
    });
  });

  describe('moe.check_approval', () => {
    beforeEach(async () => {
      setupMoeFolder();
      createEpic();
      await state.load();
    });

    it('returns approved=true for WORKING status', async () => {
      createTask({ id: 'task-w', status: 'WORKING' });
      await state.load();
      const tool = checkApprovalTool(state);
      const result = await tool.handler({ taskId: 'task-w' }, state) as { approved: boolean };
      expect(result.approved).toBe(true);
    });

    it('returns approved=false for AWAITING_APPROVAL', async () => {
      createTask({ id: 'task-a', status: 'AWAITING_APPROVAL' });
      await state.load();
      const tool = checkApprovalTool(state);
      const result = await tool.handler({ taskId: 'task-a' }, state) as { approved: boolean; status: string };
      expect(result.approved).toBe(false);
      expect(result.status).toBe('AWAITING_APPROVAL');
    });

    it('returns rejected info when plan was rejected', async () => {
      createTask({ id: 'task-r', status: 'PLANNING', reopenReason: 'Needs more detail' });
      await state.load();
      const tool = checkApprovalTool(state);
      const result = await tool.handler({ taskId: 'task-r' }, state) as { rejected: boolean; rejectionReason: string };
      expect(result.rejected).toBe(true);
      expect(result.rejectionReason).toBe('Needs more detail');
    });

    it('throws for non-existent task', async () => {
      const tool = checkApprovalTool(state);
      await expect(tool.handler({ taskId: 'nonexistent' }, state)).rejects.toThrow('Task not found');
    });
  });

  describe('moe.start_step', () => {
    beforeEach(async () => {
      setupMoeFolder();
      createEpic();
      createTask({
        status: 'WORKING',
        implementationPlan: [
          { stepId: 'step-1', description: 'First step', status: 'PENDING', affectedFiles: [] },
          { stepId: 'step-2', description: 'Second step', status: 'PENDING', affectedFiles: [] },
        ],
      });
      await state.load();
    });

    it('marks step as IN_PROGRESS', async () => {
      const tool = startStepTool(state);
      const result = await tool.handler({ taskId: 'task-1', stepId: 'step-1' }, state) as { success: boolean; stepNumber: number };

      expect(result.success).toBe(true);
      expect(result.stepNumber).toBe(1);

      const task = state.getTask('task-1');
      expect(task?.implementationPlan[0].status).toBe('IN_PROGRESS');
      expect(task?.implementationPlan[0].startedAt).toBeDefined();
    });

    it('throws for non-existent step', async () => {
      const tool = startStepTool(state);
      await expect(
        tool.handler({ taskId: 'task-1', stepId: 'nonexistent' }, state)
      ).rejects.toThrow('STEP_NOT_FOUND');
    });
  });

  describe('moe.complete_step', () => {
    beforeEach(async () => {
      setupMoeFolder();
      createEpic();
      createTask({
        status: 'WORKING',
        implementationPlan: [
          { stepId: 'step-1', description: 'First', status: 'IN_PROGRESS', affectedFiles: [] },
          { stepId: 'step-2', description: 'Second', status: 'PENDING', affectedFiles: [] },
        ],
      });
      await state.load();
    });

    it('marks step as COMPLETED and returns progress', async () => {
      const tool = completeStepTool(state);
      const result = await tool.handler({ taskId: 'task-1', stepId: 'step-1' }, state) as {
        success: boolean;
        progress: { completed: number; total: number; percentage: number };
        nextStep: { stepId: string } | null;
      };

      expect(result.success).toBe(true);
      expect(result.progress.completed).toBe(1);
      expect(result.progress.total).toBe(2);
      expect(result.progress.percentage).toBe(50);
      expect(result.nextStep?.stepId).toBe('step-2');
    });

    it('returns null nextStep when all steps done', async () => {
      await state.updateTask('task-1', {
        implementationPlan: [
          { stepId: 'step-1', description: 'First', status: 'IN_PROGRESS', affectedFiles: [] },
        ],
      });
      const tool = completeStepTool(state);
      const result = await tool.handler({ taskId: 'task-1', stepId: 'step-1' }, state) as { nextStep: null };
      expect(result.nextStep).toBeNull();
    });

    it('stores note and modifiedFiles on the step', async () => {
      const tool = completeStepTool(state);
      await tool.handler({
        taskId: 'task-1',
        stepId: 'step-1',
        note: 'Used workaround for edge case',
        modifiedFiles: ['src/foo.ts', 'src/bar.ts'],
      }, state);

      const task = state.getTask('task-1');
      const step = task?.implementationPlan.find(s => s.stepId === 'step-1');
      expect(step?.note).toBe('Used workaround for edge case');
      expect(step?.modifiedFiles).toEqual(['src/foo.ts', 'src/bar.ts']);
    });

    it('does not set note or modifiedFiles when not provided', async () => {
      const tool = completeStepTool(state);
      await tool.handler({ taskId: 'task-1', stepId: 'step-1' }, state);

      const task = state.getTask('task-1');
      const step = task?.implementationPlan.find(s => s.stepId === 'step-1');
      expect(step?.note).toBeUndefined();
      expect(step?.modifiedFiles).toBeUndefined();
    });
  });

  describe('moe.complete_task', () => {
    beforeEach(async () => {
      setupMoeFolder();
      createEpic();
      createTask({
        status: 'WORKING',
        implementationPlan: [
          { stepId: 'step-1', description: 'Done', status: 'COMPLETED', affectedFiles: ['a.ts', 'b.ts'] },
        ],
      });
      await state.load();
    });

    it('moves task to REVIEW', async () => {
      const tool = completeTaskTool(state);
      const result = await tool.handler({ taskId: 'task-1' }, state) as {
        success: boolean;
        status: string;
        stats: { stepsCompleted: number; filesModified: string[] };
      };

      expect(result.success).toBe(true);
      expect(result.status).toBe('REVIEW');
      expect(result.stats.stepsCompleted).toBe(1);
      expect(result.stats.filesModified).toContain('a.ts');
    });

    it('sets prLink if provided', async () => {
      const tool = completeTaskTool(state);
      await tool.handler({ taskId: 'task-1', prLink: 'https://github.com/pr/123' }, state);
      const task = state.getTask('task-1');
      expect(task?.prLink).toBe('https://github.com/pr/123');
    });
  });

  describe('moe.report_blocked', () => {
    beforeEach(async () => {
      setupMoeFolder();
      createEpic();
      createTask({ assignedWorkerId: 'worker-1' });
      createWorker();
      await state.load();
    });

    it('marks worker as blocked', async () => {
      const tool = reportBlockedTool(state);
      const result = await tool.handler({
        taskId: 'task-1',
        reason: 'Need clarification',
      }, state) as { success: boolean; workerStatus: string };

      expect(result.success).toBe(true);
      expect(result.workerStatus).toBe('BLOCKED');

      const worker = state.getWorker('worker-1');
      expect(worker?.status).toBe('BLOCKED');
      expect(worker?.lastError).toBe('Need clarification');
    });

    it('throws for non-existent task', async () => {
      const tool = reportBlockedTool(state);
      await expect(
        tool.handler({ taskId: 'nonexistent', reason: 'test' }, state)
      ).rejects.toThrow('Task not found');
    });
  });

  describe('moe.list_tasks', () => {
    beforeEach(async () => {
      setupMoeFolder();
      createEpic({ id: 'epic-1' });
      createEpic({ id: 'epic-2', order: 2 });
      createTask({ id: 'task-1', epicId: 'epic-1', status: 'BACKLOG' });
      createTask({ id: 'task-2', epicId: 'epic-1', status: 'WORKING', order: 2 });
      createTask({ id: 'task-3', epicId: 'epic-2', status: 'DONE' });
      await state.load();
    });

    it('lists all tasks', async () => {
      const tool = listTasksTool(state);
      const result = await tool.handler({}, state) as { tasks: Array<{ id: string }> };
      expect(result.tasks.length).toBe(3);
    });

    it('filters by epicId', async () => {
      const tool = listTasksTool(state);
      const result = await tool.handler({ epicId: 'epic-1' }, state) as { tasks: Array<{ id: string }> };
      expect(result.tasks.length).toBe(2);
      expect(result.tasks.map(t => t.id)).toContain('task-1');
      expect(result.tasks.map(t => t.id)).toContain('task-2');
    });

    it('filters by status', async () => {
      const tool = listTasksTool(state);
      const result = await tool.handler({ status: ['BACKLOG'] }, state) as { tasks: Array<{ id: string }>; counts: { backlog: number } };
      expect(result.tasks.length).toBe(1);
      expect(result.tasks[0].id).toBe('task-1');
      expect(result.counts.backlog).toBe(1);
    });

    it('returns status counts', async () => {
      const tool = listTasksTool(state);
      const result = await tool.handler({}, state) as { counts: { backlog: number; inProgress: number; done: number } };
      expect(result.counts.backlog).toBe(1);
      expect(result.counts.inProgress).toBe(1);
      expect(result.counts.done).toBe(1);
    });
  });

  describe('moe.create_team', () => {
    beforeEach(async () => {
      setupMoeFolder();
      await state.load();
    });

    it('creates a team with role', async () => {
      const tool = createTeamTool(state);
      const result = await tool.handler({ name: 'Moe Team', role: 'worker' }, state) as {
        team: { id: string; role: string | null };
        created: boolean;
      };

      expect(result.created).toBe(true);
      expect(result.team.role).toBe('worker');
      expect(result.team.id).toBeTruthy();
    });

    it('creates a team without role and is idempotent by name', async () => {
      const tool = createTeamTool(state);
      const first = await tool.handler({ name: 'Moe Team' }, state) as {
        team: { id: string; role: string | null };
        created: boolean;
      };
      expect(first.created).toBe(true);
      expect(first.team.role).toBeNull();

      const second = await tool.handler({ name: 'Moe Team' }, state) as {
        team: { id: string };
        created: boolean;
      };

      expect(second.created).toBe(false);
      expect(second.team.id).toBe(first.team.id);
    });
  });

  describe('moe.get_next_task', () => {
    beforeEach(async () => {
      setupMoeFolder();
      createEpic();
      createTask({ id: 'task-1', status: 'BACKLOG', order: 2 });
      createTask({ id: 'task-2', status: 'BACKLOG', order: 1 });
      createTask({ id: 'task-3', status: 'WORKING' });
      await state.load();
    });

    it('returns next backlog task sorted by order', async () => {
      const tool = getNextTaskTool(state);
      const result = await tool.handler({}, state) as { hasNext: boolean; task: { id: string } };
      expect(result.hasNext).toBe(true);
      expect(result.task.id).toBe('task-2'); // order 1 comes first
    });

    it('filters by epicId', async () => {
      createEpic({ id: 'epic-2' });
      createTask({ id: 'task-e2', epicId: 'epic-2', status: 'BACKLOG' });
      await state.load();

      const tool = getNextTaskTool(state);
      const result = await tool.handler({ epicId: 'epic-2' }, state) as { task: { id: string } };
      expect(result.task.id).toBe('task-e2');
    });

    it('returns hasNext=false when no backlog tasks', async () => {
      await state.updateTask('task-1', { status: 'DONE' });
      await state.updateTask('task-2', { status: 'DONE' });
      const tool = getNextTaskTool(state);
      const result = await tool.handler({}, state) as { hasNext: boolean };
      expect(result.hasNext).toBe(false);
    });
  });

  describe('moe.create_task', () => {
    beforeEach(async () => {
      setupMoeFolder();
      createEpic();
      await state.load();
    });

    it('creates a new task', async () => {
      const tool = createTaskTool(state);
      const result = await tool.handler({
        epicId: 'epic-1',
        title: 'New Task',
        description: 'Task desc',
      }, state) as { success: boolean; task: Task };

      expect(result.success).toBe(true);
      expect(result.task.title).toBe('New Task');
      expect(result.task.createdBy).toBe('WORKER');
    });

    it('throws for missing epicId', async () => {
      const tool = createTaskTool(state);
      await expect(tool.handler({ title: 'Test' }, state)).rejects.toThrow('Missing required field: epicId');
    });

    it('throws for missing title', async () => {
      const tool = createTaskTool(state);
      await expect(tool.handler({ epicId: 'epic-1' }, state)).rejects.toThrow('Missing required field: title');
    });
  });

  describe('moe.create_epic', () => {
    beforeEach(async () => {
      setupMoeFolder();
      await state.load();
    });

    it('creates a new epic', async () => {
      const tool = createEpicTool(state);
      const result = await tool.handler({
        title: 'New Epic',
        description: 'Epic desc',
      }, state) as { success: boolean; epic: Epic };

      expect(result.success).toBe(true);
      expect(result.epic.title).toBe('New Epic');
      expect(result.epic.status).toBe('PLANNED');
    });

    it('throws for missing title', async () => {
      const tool = createEpicTool(state);
      await expect(tool.handler({}, state)).rejects.toThrow('Missing required field: title');
    });
  });

  describe('moe.set_task_status', () => {
    beforeEach(async () => {
      setupMoeFolder();
      createEpic();
      createTask({ status: 'BACKLOG' });
      await state.load();
    });

    it('changes task status', async () => {
      const tool = setTaskStatusTool(state);
      const result = await tool.handler({
        taskId: 'task-1',
        status: 'PLANNING',
      }, state) as { success: boolean; status: string };

      expect(result.success).toBe(true);
      expect(result.status).toBe('PLANNING');
    });

    it('validates status transitions', async () => {
      const tool = setTaskStatusTool(state);
      // BACKLOG -> DONE is not valid
      await expect(
        tool.handler({ taskId: 'task-1', status: 'DONE' }, state)
      ).rejects.toThrow('status transition not allowed');
    });

    it('rejects invalid status values', async () => {
      const tool = setTaskStatusTool(state);
      await expect(
        tool.handler({ taskId: 'task-1', status: 'INVALID' }, state)
      ).rejects.toThrow('Invalid status');
    });

    it('increments reopenCount when reopening with reason', async () => {
      await state.updateTask('task-1', { status: 'REVIEW' });
      const tool = setTaskStatusTool(state);
      await tool.handler({
        taskId: 'task-1',
        status: 'WORKING',
        reason: 'Fix needed',
      }, state);

      const task = state.getTask('task-1');
      expect(task?.reopenCount).toBe(1);
      expect(task?.reopenReason).toBe('Fix needed');
    });
  });

  describe('moe.claim_next_task', () => {
    beforeEach(async () => {
      setupMoeFolder();
      createEpic();
      createTask({ id: 'task-1', status: 'BACKLOG', order: 2 });
      createTask({ id: 'task-2', status: 'BACKLOG', order: 1 });
      createTask({ id: 'task-3', status: 'PLANNING' });
      await state.load();
    });

    it('claims next task by status', async () => {
      const tool = claimNextTaskTool(state);
      const result = await tool.handler({
        statuses: ['BACKLOG'],
      }, state) as { hasNext: boolean; task: { id: string } };

      expect(result.hasNext).toBe(true);
      expect(result.task.id).toBe('task-2'); // lowest order
    });

    it('assigns workerId to claimed task', async () => {
      const tool = claimNextTaskTool(state);
      await tool.handler({
        statuses: ['BACKLOG'],
        workerId: 'worker-1',
      }, state);

      const task = state.getTask('task-2');
      expect(task?.assignedWorkerId).toBe('worker-1');
    });

    it('claims from multiple statuses', async () => {
      const tool = claimNextTaskTool(state);
      const result = await tool.handler({
        statuses: ['PLANNING', 'BACKLOG'],
      }, state) as { task: { id: string } };

      // task-2 (BACKLOG, order 1) comes before task-3 (PLANNING, order 1)
      expect(result.task).toBeDefined();
    });

    it('throws for empty statuses', async () => {
      const tool = claimNextTaskTool(state);
      await expect(tool.handler({ statuses: [] }, state)).rejects.toThrow('Missing required field: statuses');
    });

    it('returns hasNext=false when no matching tasks', async () => {
      const tool = claimNextTaskTool(state);
      const result = await tool.handler({ statuses: ['DONE'] }, state) as { hasNext: boolean };
      expect(result.hasNext).toBe(false);
    });

    it('includes rejection fields when task was reopened', async () => {
      createTask({
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
      await state.load();

      const tool = claimNextTaskTool(state);
      const result = await tool.handler({
        statuses: ['WORKING'],
        workerId: 'worker-reopen',
      }, state) as {
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
      const tool = claimNextTaskTool(state);
      const result = await tool.handler({
        statuses: ['BACKLOG'],
        workerId: 'worker-normal',
      }, state) as {
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
  });

  describe('moe.propose_rail', () => {
    beforeEach(async () => {
      setupMoeFolder();
      createEpic();
      createTask({ assignedWorkerId: 'worker-1' });
      await state.load();
    });

    it('creates a rail proposal', async () => {
      const tool = proposeRailTool(state);
      const result = await tool.handler({
        taskId: 'task-1',
        proposalType: 'ADD_RAIL',
        targetScope: 'GLOBAL',
        proposedValue: 'always use async/await',
        reason: 'Improves readability',
      }, state) as { success: boolean; proposalId: string; status: string };

      expect(result.success).toBe(true);
      expect(result.proposalId).toMatch(/^prop-/);
      expect(result.status).toBe('PENDING');

      expect(state.proposals.size).toBe(1);
    });

    it('throws for non-existent task', async () => {
      const tool = proposeRailTool(state);
      await expect(
        tool.handler({
          taskId: 'nonexistent',
          proposalType: 'ADD_RAIL',
          targetScope: 'TASK',
          proposedValue: 'test',
          reason: 'test',
        }, state)
      ).rejects.toThrow('Task not found');
    });

    it('includes workerId from assigned task', async () => {
      const tool = proposeRailTool(state);
      await tool.handler({
        taskId: 'task-1',
        proposalType: 'MODIFY_RAIL',
        targetScope: 'EPIC',
        currentValue: 'old value',
        proposedValue: 'new value',
        reason: 'Better approach',
      }, state);

      const proposal = Array.from(state.proposals.values())[0];
      expect(proposal.workerId).toBe('worker-1');
      expect(proposal.currentValue).toBe('old value');
    });
  });

  describe('moe.delete_task', () => {
    beforeEach(async () => {
      setupMoeFolder();
      createEpic();
      createTask({ id: 'task-1', status: 'BACKLOG' });
      await state.load();
    });

    it('deletes a task and returns it', async () => {
      const tool = deleteTaskTool(state);
      const result = await tool.handler({ taskId: 'task-1' }, state) as { success: boolean; task: Task };

      expect(result.success).toBe(true);
      expect(result.task.id).toBe('task-1');
      expect(state.getTask('task-1')).toBeNull();
    });

    it('throws for missing taskId', async () => {
      const tool = deleteTaskTool(state);
      await expect(tool.handler({}, state)).rejects.toThrow('Missing required field: taskId');
    });

    it('throws for non-existent task', async () => {
      const tool = deleteTaskTool(state);
      await expect(tool.handler({ taskId: 'nonexistent' }, state)).rejects.toThrow('Task not found: nonexistent');
    });
  });

  describe('moe.update_epic', () => {
    beforeEach(async () => {
      setupMoeFolder();
      createEpic({ id: 'epic-1', title: 'Original Title' });
      await state.load();
    });

    it('updates epic title', async () => {
      const tool = updateEpicTool(state);
      const result = await tool.handler({
        epicId: 'epic-1',
        title: 'Updated Title',
      }, state) as { success: boolean; epic: Epic };

      expect(result.success).toBe(true);
      expect(result.epic.title).toBe('Updated Title');
    });

    it('updates multiple fields', async () => {
      const tool = updateEpicTool(state);
      const result = await tool.handler({
        epicId: 'epic-1',
        description: 'New desc',
        epicRails: ['Rule 1', 'Rule 2'],
        status: 'COMPLETED',
      }, state) as { success: boolean; epic: Epic };

      expect(result.success).toBe(true);
      expect(result.epic.description).toBe('New desc');
      expect(result.epic.epicRails).toEqual(['Rule 1', 'Rule 2']);
      expect(result.epic.status).toBe('COMPLETED');
    });

    it('throws for missing epicId', async () => {
      const tool = updateEpicTool(state);
      await expect(tool.handler({}, state)).rejects.toThrow('Missing required field: epicId');
    });
  });

  describe('moe.delete_epic', () => {
    beforeEach(async () => {
      setupMoeFolder();
      createEpic({ id: 'epic-1' });
      await state.load();
    });

    it('deletes epic without tasks', async () => {
      const tool = deleteEpicTool(state);
      const result = await tool.handler({ epicId: 'epic-1' }, state) as {
        success: boolean;
        deletedEpic: Epic;
        deletedTaskCount: number;
      };

      expect(result.success).toBe(true);
      expect(result.deletedEpic.id).toBe('epic-1');
      expect(result.deletedTaskCount).toBe(0);
    });

    it('throws when epic has tasks and cascadeDelete is false', async () => {
      createTask({ epicId: 'epic-1' });
      await state.load();

      const tool = deleteEpicTool(state);
      await expect(
        tool.handler({ epicId: 'epic-1', cascadeDelete: false }, state)
      ).rejects.toThrow('has 1 task(s)');
    });

    it('deletes epic and tasks when cascadeDelete is true', async () => {
      createTask({ epicId: 'epic-1' });
      await state.load();

      const tool = deleteEpicTool(state);
      const result = await tool.handler({
        epicId: 'epic-1',
        cascadeDelete: true,
      }, state) as { success: boolean; deletedTaskCount: number };

      expect(result.success).toBe(true);
      expect(result.deletedTaskCount).toBe(1);
    });

    it('throws for missing epicId', async () => {
      const tool = deleteEpicTool(state);
      await expect(tool.handler({}, state)).rejects.toThrow('Missing required field: epicId');
    });
  });

  describe('moe.search_tasks', () => {
    beforeEach(async () => {
      setupMoeFolder();
      createEpic();
      createTask({ id: 'task-1', title: 'Fix login bug', description: 'Auth error', status: 'BACKLOG' });
      createTask({ id: 'task-2', title: 'Add feature', description: 'New login feature', status: 'WORKING' });
      createTask({ id: 'task-3', title: 'Update docs', description: 'Documentation update', status: 'DONE' });
      await state.load();
    });

    it('searches by query in title', async () => {
      const tool = searchTasksTool(state);
      const result = await tool.handler({ query: 'login' }, state) as {
        tasks: Task[];
        totalMatches: number;
      };

      expect(result.totalMatches).toBe(2);
      expect(result.tasks.map(t => t.id)).toContain('task-1');
      expect(result.tasks.map(t => t.id)).toContain('task-2');
    });

    it('filters by status', async () => {
      const tool = searchTasksTool(state);
      const result = await tool.handler({
        filters: { status: 'WORKING' },
      }, state) as { tasks: Task[] };

      expect(result.tasks.length).toBe(1);
      expect(result.tasks[0].id).toBe('task-2');
    });

    it('combines query and filters', async () => {
      const tool = searchTasksTool(state);
      const result = await tool.handler({
        query: 'login',
        filters: { status: 'BACKLOG' },
      }, state) as { tasks: Task[] };

      expect(result.tasks.length).toBe(1);
      expect(result.tasks[0].id).toBe('task-1');
    });

    it('respects limit', async () => {
      const tool = searchTasksTool(state);
      const result = await tool.handler({ limit: 1 }, state) as { tasks: Task[] };
      expect(result.tasks.length).toBe(1);
    });

    it('returns empty array when no matches', async () => {
      const tool = searchTasksTool(state);
      const result = await tool.handler({ query: 'nonexistent' }, state) as { tasks: Task[] };
      expect(result.tasks.length).toBe(0);
    });
  });

  describe('moe.qa_approve', () => {
    beforeEach(async () => {
      setupMoeFolder();
      createEpic();
      createTask({ id: 'task-1', status: 'REVIEW' });
      await state.load();
    });

    it('approves task in REVIEW and moves to DONE', async () => {
      const tool = qaApproveTool(state);
      const result = await tool.handler({
        taskId: 'task-1',
        summary: 'All DoD items verified',
      }, state) as { success: boolean; status: string };

      expect(result.success).toBe(true);
      expect(result.status).toBe('DONE');

      const task = state.getTask('task-1');
      expect(task?.status).toBe('DONE');
    });

    it('throws for missing taskId', async () => {
      const tool = qaApproveTool(state);
      await expect(tool.handler({}, state)).rejects.toThrow('Missing required field: taskId');
    });

    it('throws for non-REVIEW status', async () => {
      await state.updateTask('task-1', { status: 'WORKING' });
      const tool = qaApproveTool(state);
      await expect(
        tool.handler({ taskId: 'task-1' }, state)
      ).rejects.toThrow('expected REVIEW');
    });

    it('throws for non-existent task', async () => {
      const tool = qaApproveTool(state);
      await expect(
        tool.handler({ taskId: 'nonexistent' }, state)
      ).rejects.toThrow('Task not found');
    });
  });

  describe('moe.qa_reject', () => {
    beforeEach(async () => {
      setupMoeFolder();
      createEpic();
      createTask({ id: 'task-1', status: 'REVIEW', reopenCount: 0 });
      await state.load();
    });

    it('rejects task and moves back to WORKING', async () => {
      const tool = qaRejectTool(state);
      const result = await tool.handler({
        taskId: 'task-1',
        reason: 'Tests are failing',
      }, state) as { success: boolean; status: string; reopenCount: number };

      expect(result.success).toBe(true);
      expect(result.status).toBe('WORKING');
      expect(result.reopenCount).toBe(1);

      const task = state.getTask('task-1');
      expect(task?.status).toBe('WORKING');
      expect(task?.reopenReason).toBe('Tests are failing');
    });

    it('increments reopenCount on multiple rejections', async () => {
      await state.updateTask('task-1', { reopenCount: 2 });

      const tool = qaRejectTool(state);
      const result = await tool.handler({
        taskId: 'task-1',
        reason: 'Still failing',
      }, state) as { reopenCount: number };

      expect(result.reopenCount).toBe(3);
    });

    it('throws for missing taskId', async () => {
      const tool = qaRejectTool(state);
      await expect(
        tool.handler({ reason: 'test' }, state)
      ).rejects.toThrow('Missing required field: taskId');
    });

    it('throws for missing reason', async () => {
      const tool = qaRejectTool(state);
      await expect(
        tool.handler({ taskId: 'task-1' }, state)
      ).rejects.toThrow('Missing required field: reason');
    });

    it('throws for empty reason', async () => {
      const tool = qaRejectTool(state);
      await expect(
        tool.handler({ taskId: 'task-1', reason: '  ' }, state)
      ).rejects.toThrow('Missing required field: reason');
    });

    it('throws for non-REVIEW status', async () => {
      await state.updateTask('task-1', { status: 'DONE' });
      const tool = qaRejectTool(state);
      await expect(
        tool.handler({ taskId: 'task-1', reason: 'test' }, state)
      ).rejects.toThrow('expected REVIEW');
    });

    it('stores failedDodItems on rejection', async () => {
      const tool = qaRejectTool(state);
      const result = await tool.handler({
        taskId: 'task-1',
        reason: 'DoD items failed',
        failedDodItems: ['Tests pass', 'Code reviewed'],
      }, state) as { success: boolean; rejectionDetails: { failedDodItems: string[] } };

      expect(result.success).toBe(true);
      expect(result.rejectionDetails.failedDodItems).toEqual(['Tests pass', 'Code reviewed']);

      const task = state.getTask('task-1');
      expect(task?.rejectionDetails?.failedDodItems).toEqual(['Tests pass', 'Code reviewed']);
    });

    it('stores structured issues on rejection', async () => {
      // Reset task to REVIEW for this test
      await state.updateTask('task-1', { status: 'REVIEW' });

      const tool = qaRejectTool(state);
      const result = await tool.handler({
        taskId: 'task-1',
        reason: 'Multiple issues found',
        issues: [
          { type: 'test_failure', description: 'UserService test fails', file: 'src/UserService.test.ts', line: 42 },
          { type: 'security', description: 'Missing input validation' },
        ],
      }, state) as { rejectionDetails: { issues: Array<{ type: string; file?: string }> } };

      expect(result.rejectionDetails.issues).toHaveLength(2);
      expect(result.rejectionDetails.issues[0].type).toBe('test_failure');
      expect(result.rejectionDetails.issues[0].file).toBe('src/UserService.test.ts');

      const task = state.getTask('task-1');
      expect(task?.rejectionDetails?.issues).toHaveLength(2);
    });

    it('works with reason only (backward compat)', async () => {
      await state.updateTask('task-1', { status: 'REVIEW' });

      const tool = qaRejectTool(state);
      const result = await tool.handler({
        taskId: 'task-1',
        reason: 'Simple rejection',
      }, state) as { success: boolean; rejectionDetails: null };

      expect(result.success).toBe(true);
      expect(result.rejectionDetails).toBeNull();
    });

    it('throws for invalid issue type', async () => {
      await state.updateTask('task-1', { status: 'REVIEW' });

      const tool = qaRejectTool(state);
      await expect(
        tool.handler({
          taskId: 'task-1',
          reason: 'Bad issue type',
          issues: [{ type: 'invalid_type', description: 'test' }],
        }, state)
      ).rejects.toThrow('invalid type');
    });

    it('get_context returns rejectionDetails to worker', async () => {
      // Reject with structured feedback
      const rejectTool = qaRejectTool(state);
      await rejectTool.handler({
        taskId: 'task-1',
        reason: 'Tests fail',
        failedDodItems: ['Tests pass'],
        issues: [{ type: 'test_failure', description: 'Failing test in foo.test.ts' }],
      }, state);

      // Now check get_context as worker
      const ctxTool = getContextTool(state);
      const result = await ctxTool.handler({ taskId: 'task-1' }, state) as {
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

  describe('moe.get_activity_log', () => {
    beforeEach(async () => {
      setupMoeFolder();
      createEpic();
      await state.load();
    });

    it('returns empty array when no activity log exists', async () => {
      const tool = getActivityLogTool(state);
      const result = await tool.handler({}, state) as { events: unknown[]; count: number };

      expect(result.events).toEqual([]);
      expect(result.count).toBe(0);
    });

    it('returns events after task operations', async () => {
      // Creating a task generates activity log entries
      createTask({ id: 'task-log-1', status: 'BACKLOG' });
      await state.load();
      await state.updateTask('task-log-1', { status: 'PLANNING' });

      // Flush pending writes
      await state.flushActivityLog();

      const tool = getActivityLogTool(state);
      const result = await tool.handler({}, state) as { events: Array<{ event: string }>; count: number };

      expect(result.count).toBeGreaterThan(0);
      expect(result.events.length).toBeGreaterThan(0);
    });

    it('filters by taskId', async () => {
      createTask({ id: 'task-a', status: 'BACKLOG' });
      createTask({ id: 'task-b', status: 'BACKLOG' });
      await state.load();
      await state.updateTask('task-a', { status: 'PLANNING' });
      await state.updateTask('task-b', { status: 'PLANNING' });
      await state.flushActivityLog();

      const tool = getActivityLogTool(state);
      const result = await tool.handler({ taskId: 'task-a' }, state) as {
        events: Array<{ taskId?: string }>;
      };

      for (const event of result.events) {
        expect(event.taskId).toBe('task-a');
      }
    });

    it('filters by eventTypes', async () => {
      createTask({ id: 'task-evt', status: 'PLANNING' });
      await state.load();
      // Submit a plan to create PLAN_SUBMITTED event
      const submitTool = submitPlanTool(state);
      await submitTool.handler({
        taskId: 'task-evt',
        steps: [{ description: 'Test step' }],
      }, state);
      await state.flushActivityLog();

      const tool = getActivityLogTool(state);
      const result = await tool.handler({ eventTypes: ['PLAN_SUBMITTED'] }, state) as {
        events: Array<{ event: string }>;
      };

      for (const event of result.events) {
        expect(event.event).toBe('PLAN_SUBMITTED');
      }
    });

    it('respects limit parameter', async () => {
      // Create multiple tasks to generate activity
      createTask({ id: 'task-l1', status: 'BACKLOG' });
      createTask({ id: 'task-l2', status: 'BACKLOG' });
      createTask({ id: 'task-l3', status: 'BACKLOG' });
      await state.load();
      await state.flushActivityLog();

      const tool = getActivityLogTool(state);
      const result = await tool.handler({ limit: 2 }, state) as { events: unknown[]; count: number };

      expect(result.events.length).toBeLessThanOrEqual(2);
      expect(result.count).toBeLessThanOrEqual(2);
    });

    it('throws if project not loaded', async () => {
      const freshState = new StateManager({ projectPath: testDir });
      const tool = getActivityLogTool(freshState);
      await expect(tool.handler({}, freshState)).rejects.toThrow('not loaded state, expected loaded');
    });
  });

  describe('moe.unblock_worker', () => {
    beforeEach(async () => {
      setupMoeFolder();
      createEpic();
      createTask({ id: 'task-1', assignedWorkerId: 'worker-1', status: 'WORKING' });
      createWorker({
        id: 'worker-1',
        status: 'BLOCKED',
        currentTaskId: 'task-1',
        lastError: 'Need clarification',
      });
      await state.load();
    });

    it('clears BLOCKED status to IDLE', async () => {
      const tool = unblockWorkerTool(state);
      const result = await tool.handler({
        workerId: 'worker-1',
        resolution: 'Clarification provided',
      }, state) as { success: boolean; status: string; currentTaskId: string | null };

      expect(result.success).toBe(true);
      expect(result.status).toBe('IDLE');
      expect(result.currentTaskId).toBeNull();

      const worker = state.getWorker('worker-1');
      expect(worker?.status).toBe('IDLE');
      expect(worker?.lastError).toBeNull();
      expect(worker?.currentTaskId).toBeNull();
    });

    it('keeps currentTaskId when retryTask is true', async () => {
      const tool = unblockWorkerTool(state);
      const result = await tool.handler({
        workerId: 'worker-1',
        resolution: 'Issue resolved, retrying',
        retryTask: true,
      }, state) as { success: boolean; status: string; currentTaskId: string | null; retryTask: boolean };

      expect(result.success).toBe(true);
      expect(result.status).toBe('IDLE');
      expect(result.currentTaskId).toBe('task-1');
      expect(result.retryTask).toBe(true);

      const worker = state.getWorker('worker-1');
      expect(worker?.currentTaskId).toBe('task-1');
    });

    it('fails if worker is not BLOCKED', async () => {
      // Create an IDLE worker
      createWorker({ id: 'worker-idle', status: 'IDLE' });
      await state.load();

      const tool = unblockWorkerTool(state);
      await expect(
        tool.handler({ workerId: 'worker-idle', resolution: 'test' }, state)
      ).rejects.toThrow('BLOCKED');
    });

    it('fails if worker does not exist', async () => {
      const tool = unblockWorkerTool(state);
      await expect(
        tool.handler({ workerId: 'nonexistent', resolution: 'test' }, state)
      ).rejects.toThrow('not found');
    });

    it('logs WORKER_UNBLOCKED to activity', async () => {
      const tool = unblockWorkerTool(state);
      await tool.handler({
        workerId: 'worker-1',
        resolution: 'Fixed the issue',
      }, state);
      await state.flushActivityLog();

      const logTool = getActivityLogTool(state);
      const result = await logTool.handler({
        eventTypes: ['WORKER_UNBLOCKED'],
      }, state) as { events: Array<{ event: string; workerId?: string }> };

      expect(result.events.length).toBeGreaterThanOrEqual(1);
      const unblockEvent = result.events.find(e => e.event === 'WORKER_UNBLOCKED');
      expect(unblockEvent).toBeDefined();
    });
  });

  describe('DEPLOYING status and WIP limits', () => {
    beforeEach(async () => {
      setupMoeFolder({
        settings: {
          approvalMode: 'CONTROL',
          speedModeDelayMs: 2000,
          autoCreateBranch: true,
          branchPattern: 'moe/{epicId}/{taskId}',
          commitPattern: 'feat({epicId}): {taskTitle}',
          agentCommand: 'claude',
          columnLimits: { DEPLOYING: 1 }
        }
      } as Partial<Project>);
      createEpic();
      createTask({ id: 'task-1', status: 'REVIEW' });
      await state.load();
    });

    it('allows REVIEW -> DEPLOYING transition', async () => {
      const tool = setTaskStatusTool(state);
      const result = await tool.handler({
        taskId: 'task-1',
        status: 'DEPLOYING',
      }, state) as { success: boolean; status: string };

      expect(result.success).toBe(true);
      expect(result.status).toBe('DEPLOYING');
    });

    it('allows DEPLOYING -> DONE transition', async () => {
      await state.updateTask('task-1', { status: 'DEPLOYING' });
      const tool = setTaskStatusTool(state);
      const result = await tool.handler({
        taskId: 'task-1',
        status: 'DONE',
      }, state) as { success: boolean; status: string };

      expect(result.success).toBe(true);
      expect(result.status).toBe('DONE');
    });

    it('allows DEPLOYING -> WORKING reopen transition', async () => {
      await state.updateTask('task-1', { status: 'DEPLOYING' });
      const tool = setTaskStatusTool(state);
      const result = await tool.handler({
        taskId: 'task-1',
        status: 'WORKING',
        reason: 'Deploy failed',
      }, state) as { success: boolean; status: string };

      expect(result.success).toBe(true);
      expect(result.status).toBe('WORKING');

      const task = state.getTask('task-1');
      expect(task?.reopenCount).toBe(1);
      expect(task?.reopenReason).toBe('Deploy failed');
    });

    it('allows DONE -> DEPLOYING transition', async () => {
      await state.updateTask('task-1', { status: 'DONE' });
      const tool = setTaskStatusTool(state);
      const result = await tool.handler({
        taskId: 'task-1',
        status: 'DEPLOYING',
      }, state) as { success: boolean; status: string };

      expect(result.success).toBe(true);
      expect(result.status).toBe('DEPLOYING');
    });

    it('blocks transition when WIP limit reached', async () => {
      // Move task-1 to DEPLOYING first (occupying the 1 slot)
      await state.updateTask('task-1', { status: 'DEPLOYING' });

      // Create a second task in REVIEW
      createTask({ id: 'task-2', status: 'REVIEW', order: 2 });
      await state.load();

      const tool = setTaskStatusTool(state);
      await expect(
        tool.handler({ taskId: 'task-2', status: 'DEPLOYING' }, state)
      ).rejects.toThrow('WIP limit of 1');
    });

    it('allows transition when under WIP limit', async () => {
      // task-1 is in REVIEW, DEPLOYING column is empty
      const tool = setTaskStatusTool(state);
      const result = await tool.handler({
        taskId: 'task-1',
        status: 'DEPLOYING',
      }, state) as { success: boolean };

      expect(result.success).toBe(true);
    });

    it('treats missing columnLimits as no limit', async () => {
      // Create a state without columnLimits
      const noLimitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moe-nolimit-'));
      const noLimitMoePath = path.join(noLimitDir, '.moe');
      fs.mkdirSync(noLimitMoePath, { recursive: true });
      fs.mkdirSync(path.join(noLimitMoePath, 'epics'));
      fs.mkdirSync(path.join(noLimitMoePath, 'tasks'));
      fs.mkdirSync(path.join(noLimitMoePath, 'workers'));
      fs.mkdirSync(path.join(noLimitMoePath, 'proposals'));
      fs.writeFileSync(path.join(noLimitMoePath, 'project.json'), JSON.stringify({
        id: 'proj-nolimit',
        name: 'No Limit Project',
        rootPath: noLimitDir,
        schemaVersion: 4,
        globalRails: { techStack: [], forbiddenPatterns: [], requiredPatterns: [], formatting: '', testing: '', customRules: [] },
        settings: { approvalMode: 'CONTROL', speedModeDelayMs: 2000, autoCreateBranch: true, branchPattern: '', commitPattern: '', agentCommand: 'claude' }
      }, null, 2));
      const epic: Epic = { id: 'epic-nl', projectId: 'proj-nolimit', title: 'E', description: '', architectureNotes: '', epicRails: [], status: 'ACTIVE', order: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      fs.writeFileSync(path.join(noLimitMoePath, 'epics', 'epic-nl.json'), JSON.stringify(epic, null, 2));
      const task: Task = { id: 'task-nl', epicId: 'epic-nl', title: 'T', description: '', definitionOfDone: ['done'], taskRails: [], implementationPlan: [], status: 'REVIEW', assignedWorkerId: null, branch: null, prLink: null, reopenCount: 0, reopenReason: null, createdBy: 'HUMAN', parentTaskId: null, priority: 'MEDIUM', order: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      fs.writeFileSync(path.join(noLimitMoePath, 'tasks', 'task-nl.json'), JSON.stringify(task, null, 2));

      const nlState = new StateManager({ projectPath: noLimitDir });
      await nlState.load();

      const tool = setTaskStatusTool(nlState);
      const result = await tool.handler({
        taskId: 'task-nl',
        status: 'DEPLOYING',
      }, nlState) as { success: boolean };

      expect(result.success).toBe(true);
      fs.rmSync(noLimitDir, { recursive: true, force: true });
    });

    it('listTasks includes deploying count', async () => {
      await state.updateTask('task-1', { status: 'DEPLOYING' });
      const tool = listTasksTool(state);
      const result = await tool.handler({}, state) as { counts: { deploying: number } };
      expect(result.counts.deploying).toBe(1);
    });

    it('searchTasks can filter by DEPLOYING status', async () => {
      await state.updateTask('task-1', { status: 'DEPLOYING' });
      const tool = searchTasksTool(state);
      const result = await tool.handler({
        filters: { status: 'DEPLOYING' },
      }, state) as { tasks: Task[] };

      expect(result.tasks.length).toBe(1);
      expect(result.tasks[0].id).toBe('task-1');
    });
  });

  describe('ARCHIVED status', () => {
    beforeEach(async () => {
      setupMoeFolder();
      createEpic();
      createTask({ id: 'task-1', status: 'DONE' });
      await state.load();
    });

    it('allows DONE to ARCHIVED transition', async () => {
      const tool = setTaskStatusTool(state);
      const result = await tool.handler({
        taskId: 'task-1',
        status: 'ARCHIVED',
      }, state) as { success: boolean; status: string };
      expect(result.success).toBe(true);
      expect(result.status).toBe('ARCHIVED');
    });

    it('allows ARCHIVED to BACKLOG transition (un-archive)', async () => {
      await state.updateTask('task-1', { status: 'ARCHIVED' });
      const tool = setTaskStatusTool(state);
      const result = await tool.handler({
        taskId: 'task-1',
        status: 'BACKLOG',
      }, state) as { success: boolean; status: string };
      expect(result.success).toBe(true);
      expect(result.status).toBe('BACKLOG');
    });

    it('rejects BACKLOG to ARCHIVED transition', async () => {
      createTask({ id: 'task-bl', status: 'BACKLOG' });
      await state.load();
      const tool = setTaskStatusTool(state);
      await expect(tool.handler({
        taskId: 'task-bl',
        status: 'ARCHIVED',
      }, state)).rejects.toThrow();
    });

    it('listTasks includes archived count', async () => {
      await state.updateTask('task-1', { status: 'ARCHIVED' });
      const tool = listTasksTool(state);
      const result = await tool.handler({}, state) as { counts: { archived: number } };
      expect(result.counts.archived).toBe(1);
    });

    it('searchTasks can filter by ARCHIVED status', async () => {
      await state.updateTask('task-1', { status: 'ARCHIVED' });
      const tool = searchTasksTool(state);
      const result = await tool.handler({
        filters: { status: 'ARCHIVED' },
      }, state) as { tasks: Task[] };
      expect(result.tasks.length).toBe(1);
      expect(result.tasks[0].id).toBe('task-1');
    });
  });

  describe('Task comments', () => {
    beforeEach(async () => {
      setupMoeFolder();
      createEpic();
      createTask({ id: 'task-1', status: 'WORKING' });
      await state.load();
    });

    it('adds a comment to a task', async () => {
      const tool = addCommentTool(state);
      const result = await tool.handler({
        taskId: 'task-1',
        content: 'What does this feature do?',
      }, state) as { success: boolean; commentId: string; totalComments: number };
      expect(result.success).toBe(true);
      expect(result.totalComments).toBe(1);
      const task = state.getTask('task-1');
      expect(task?.comments.length).toBe(1);
      expect(task?.comments[0].content).toBe('What does this feature do?');
      expect(task?.comments[0].author).toBe('agent');
    });

    it('uses workerId as author when provided', async () => {
      const tool = addCommentTool(state);
      await tool.handler({
        taskId: 'task-1',
        content: 'Response here',
        workerId: 'worker-123',
      }, state);
      const task = state.getTask('task-1');
      expect(task?.comments[0].author).toBe('worker-123');
    });

    it('rejects empty content', async () => {
      const tool = addCommentTool(state);
      await expect(tool.handler({
        taskId: 'task-1',
        content: '  ',
      }, state)).rejects.toThrow();
    });

    it('rejects missing taskId', async () => {
      const tool = addCommentTool(state);
      await expect(tool.handler({
        content: 'test',
      }, state)).rejects.toThrow();
    });
  });

  describe('Task timestamps', () => {
    beforeEach(async () => {
      setupMoeFolder();
      createEpic();
      await state.load();
    });

    it('submitPlan sets planSubmittedAt', async () => {
      createTask({ status: 'PLANNING' });
      await state.load();

      const tool = submitPlanTool(state);
      await tool.handler({
        taskId: 'task-1',
        steps: [{ description: 'Step 1' }],
      }, state);

      const task = state.getTask('task-1');
      expect(task?.planSubmittedAt).toBeDefined();
      expect(new Date(task!.planSubmittedAt!).getTime()).not.toBeNaN();
    });

    it('manual approval sets planApprovedAt', async () => {
      createTask({ status: 'AWAITING_APPROVAL', implementationPlan: [
        { stepId: 'step-1', description: 'Step', status: 'PENDING', affectedFiles: [] }
      ]});
      await state.load();

      await state.approveTask('task-1');

      const task = state.getTask('task-1');
      expect(task?.planApprovedAt).toBeDefined();
      expect(task?.status).toBe('WORKING');
    });

    it('first startStep sets workStartedAt but second does not overwrite', async () => {
      createTask({
        status: 'WORKING',
        implementationPlan: [
          { stepId: 'step-1', description: 'First', status: 'PENDING', affectedFiles: [] },
          { stepId: 'step-2', description: 'Second', status: 'PENDING', affectedFiles: [] },
        ],
      });
      await state.load();

      const tool = startStepTool(state);
      await tool.handler({ taskId: 'task-1', stepId: 'step-1' }, state);

      const taskAfterFirst = state.getTask('task-1');
      const firstTimestamp = taskAfterFirst?.workStartedAt;
      expect(firstTimestamp).toBeDefined();

      // Complete first step so second can start
      const completeTool = completeStepTool(state);
      await completeTool.handler({ taskId: 'task-1', stepId: 'step-1' }, state);

      // Start second step
      await tool.handler({ taskId: 'task-1', stepId: 'step-2' }, state);

      const taskAfterSecond = state.getTask('task-1');
      expect(taskAfterSecond?.workStartedAt).toBe(firstTimestamp);
    });

    it('completeTask sets completedAt and reviewStartedAt', async () => {
      createTask({
        status: 'WORKING',
        implementationPlan: [
          { stepId: 'step-1', description: 'Done', status: 'COMPLETED', affectedFiles: [] },
        ],
      });
      await state.load();

      const tool = completeTaskTool(state);
      await tool.handler({ taskId: 'task-1' }, state);

      const task = state.getTask('task-1');
      expect(task?.completedAt).toBeDefined();
      expect(task?.reviewStartedAt).toBeDefined();
      expect(task?.status).toBe('REVIEW');
    });

    it('qaApprove sets reviewCompletedAt', async () => {
      createTask({ status: 'REVIEW' });
      await state.load();

      const tool = qaApproveTool(state);
      await tool.handler({ taskId: 'task-1' }, state);

      const task = state.getTask('task-1');
      expect(task?.reviewCompletedAt).toBeDefined();
      expect(task?.status).toBe('DONE');
    });

    it('qaReject sets reviewCompletedAt', async () => {
      createTask({ status: 'REVIEW' });
      await state.load();

      const tool = qaRejectTool(state);
      await tool.handler({ taskId: 'task-1', reason: 'Needs work' }, state);

      const task = state.getTask('task-1');
      expect(task?.reviewCompletedAt).toBeDefined();
      expect(task?.status).toBe('WORKING');
    });

    it('getContext exposes timestamps', async () => {
      const now = new Date().toISOString();
      createTask({
        status: 'WORKING',
        planSubmittedAt: now,
        planApprovedAt: now,
        workStartedAt: now,
      } as Partial<Task>);
      await state.load();

      const tool = getContextTool(state);
      const result = await tool.handler({ taskId: 'task-1' }, state) as {
        task: {
          planSubmittedAt: string | null;
          planApprovedAt: string | null;
          workStartedAt: string | null;
          completedAt: string | null;
          reviewStartedAt: string | null;
          reviewCompletedAt: string | null;
        };
      };

      expect(result.task.planSubmittedAt).toBe(now);
      expect(result.task.planApprovedAt).toBe(now);
      expect(result.task.workStartedAt).toBe(now);
      expect(result.task.completedAt).toBeNull();
      expect(result.task.reviewStartedAt).toBeNull();
      expect(result.task.reviewCompletedAt).toBeNull();
    });
  });

  describe('moe.get_pending_questions', () => {
    it('returns empty when no tasks have pending questions', async () => {
      setupMoeFolder();
      createEpic();
      createTask({ id: 'task-1', comments: [] });
      await state.load();

      const tool = getPendingQuestionsTool(state);
      const result = await tool.handler({}, state) as { count: number; tasks: unknown[] };
      expect(result.count).toBe(0);
      expect(result.tasks).toHaveLength(0);
    });

    it('returns task after human comment sets hasPendingQuestion', async () => {
      setupMoeFolder();
      createEpic();
      createTask({
        id: 'task-1',
        hasPendingQuestion: true,
        comments: [
          { id: 'c1', author: 'human', content: 'How should I test this?', timestamp: new Date().toISOString() }
        ]
      });
      await state.load();

      const tool = getPendingQuestionsTool(state);
      const result = await tool.handler({}, state) as {
        count: number;
        tasks: Array<{ taskId: string; questions: Array<{ content: string }> }>;
      };
      expect(result.count).toBe(1);
      expect(result.tasks[0].taskId).toBe('task-1');
      expect(result.tasks[0].questions).toHaveLength(1);
      expect(result.tasks[0].questions[0].content).toBe('How should I test this?');
    });

    it('returns multiple unanswered questions on same task', async () => {
      setupMoeFolder();
      createEpic();
      createTask({
        id: 'task-1',
        hasPendingQuestion: true,
        comments: [
          { id: 'c1', author: 'human', content: 'Question 1?', timestamp: new Date().toISOString() },
          { id: 'c2', author: 'human', content: 'Question 2?', timestamp: new Date().toISOString() }
        ]
      });
      await state.load();

      const tool = getPendingQuestionsTool(state);
      const result = await tool.handler({}, state) as {
        count: number;
        tasks: Array<{ questions: Array<{ content: string }> }>;
      };
      expect(result.count).toBe(1);
      expect(result.tasks[0].questions).toHaveLength(2);
    });

    it('only returns questions after last agent response', async () => {
      setupMoeFolder();
      createEpic();
      createTask({
        id: 'task-1',
        hasPendingQuestion: true,
        comments: [
          { id: 'c1', author: 'human', content: 'Old question', timestamp: '2024-01-01T00:00:00Z' },
          { id: 'c2', author: 'worker-1', content: 'Answer to old question', timestamp: '2024-01-01T00:01:00Z' },
          { id: 'c3', author: 'human', content: 'New question?', timestamp: '2024-01-01T00:02:00Z' }
        ]
      });
      await state.load();

      const tool = getPendingQuestionsTool(state);
      const result = await tool.handler({}, state) as {
        count: number;
        tasks: Array<{ questions: Array<{ content: string }> }>;
      };
      expect(result.count).toBe(1);
      expect(result.tasks[0].questions).toHaveLength(1);
      expect(result.tasks[0].questions[0].content).toBe('New question?');
    });

    it('add_comment clears the hasPendingQuestion flag', async () => {
      setupMoeFolder();
      createEpic();
      createTask({
        id: 'task-1',
        hasPendingQuestion: true,
        comments: [
          { id: 'c1', author: 'human', content: 'A question?', timestamp: new Date().toISOString() }
        ]
      });
      await state.load();

      const commentTool = addCommentTool(state);
      await commentTool.handler({ taskId: 'task-1', content: 'Q: A question?\nA: Here is the answer.', workerId: 'worker-1' }, state);

      const task = state.getTask('task-1')!;
      expect(task.hasPendingQuestion).toBe(false);
    });

    it('filters by epicId', async () => {
      setupMoeFolder();
      createEpic({ id: 'epic-1' });
      createEpic({ id: 'epic-2', title: 'Other Epic' });
      createTask({
        id: 'task-1',
        epicId: 'epic-1',
        hasPendingQuestion: true,
        comments: [{ id: 'c1', author: 'human', content: 'Q1?', timestamp: new Date().toISOString() }]
      });
      createTask({
        id: 'task-2',
        epicId: 'epic-2',
        hasPendingQuestion: true,
        comments: [{ id: 'c2', author: 'human', content: 'Q2?', timestamp: new Date().toISOString() }]
      });
      await state.load();

      const tool = getPendingQuestionsTool(state);
      const result = await tool.handler({ epicId: 'epic-1' }, state) as {
        count: number;
        tasks: Array<{ taskId: string }>;
      };
      expect(result.count).toBe(1);
      expect(result.tasks[0].taskId).toBe('task-1');
    });
  });
});
