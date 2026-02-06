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
import { setTaskStatusTool } from './setTaskStatus.js';
import { claimNextTaskTool } from './claimNextTask.js';
import { proposeRailTool } from './proposeRail.js';
import { deleteTaskTool } from './deleteTask.js';
import { updateEpicTool } from './updateEpic.js';
import { deleteEpicTool } from './deleteEpic.js';
import { searchTasksTool } from './searchTasks.js';
import { qaApproveTool } from './qaApprove.js';
import { qaRejectTool } from './qaReject.js';
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
      await expect(tool.handler({}, state)).rejects.toThrow('Project not loaded');
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
      ).rejects.toThrow('TASK_NOT_FOUND');
    });

    it('throws for wrong task status', async () => {
      await state.updateTask('task-1', { status: 'WORKING' });
      const tool = submitPlanTool(state);
      await expect(
        tool.handler({ taskId: 'task-1', steps: [{ description: 'Step 1' }] }, state)
      ).rejects.toThrow('INVALID_STATUS');
    });

    it('throws for empty plan', async () => {
      const tool = submitPlanTool(state);
      await expect(
        tool.handler({ taskId: 'task-1', steps: [] }, state)
      ).rejects.toThrow('EMPTY_PLAN');
    });

    it('rejects plan with forbidden pattern', async () => {
      const tool = submitPlanTool(state);
      await expect(
        tool.handler({ taskId: 'task-1', steps: [{ description: 'Run rm -rf /' }] }, state)
      ).rejects.toThrow('RAIL_VIOLATION');
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
      await expect(tool.handler({ taskId: 'nonexistent' }, state)).rejects.toThrow('TASK_NOT_FOUND');
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
      ).rejects.toThrow('TASK_NOT_FOUND');
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
      await expect(tool.handler({ title: 'Test' }, state)).rejects.toThrow('epicId is required');
    });

    it('throws for missing title', async () => {
      const tool = createTaskTool(state);
      await expect(tool.handler({ epicId: 'epic-1' }, state)).rejects.toThrow('title is required');
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
      await expect(tool.handler({}, state)).rejects.toThrow('title is required');
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
      ).rejects.toThrow('Invalid status transition');
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
      await expect(tool.handler({ statuses: [] }, state)).rejects.toThrow('statuses is required');
    });

    it('returns hasNext=false when no matching tasks', async () => {
      const tool = claimNextTaskTool(state);
      const result = await tool.handler({ statuses: ['DONE'] }, state) as { hasNext: boolean };
      expect(result.hasNext).toBe(false);
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
      ).rejects.toThrow('TASK_NOT_FOUND');
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
      await expect(tool.handler({}, state)).rejects.toThrow('taskId is required');
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
      await expect(tool.handler({}, state)).rejects.toThrow('epicId is required');
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
      await expect(tool.handler({}, state)).rejects.toThrow('epicId is required');
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
      await expect(tool.handler({}, state)).rejects.toThrow('taskId is required');
    });

    it('throws for non-REVIEW status', async () => {
      await state.updateTask('task-1', { status: 'WORKING' });
      const tool = qaApproveTool(state);
      await expect(
        tool.handler({ taskId: 'task-1' }, state)
      ).rejects.toThrow('Task must be in REVIEW status');
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
      ).rejects.toThrow('taskId is required');
    });

    it('throws for missing reason', async () => {
      const tool = qaRejectTool(state);
      await expect(
        tool.handler({ taskId: 'task-1' }, state)
      ).rejects.toThrow('reason is required');
    });

    it('throws for empty reason', async () => {
      const tool = qaRejectTool(state);
      await expect(
        tool.handler({ taskId: 'task-1', reason: '  ' }, state)
      ).rejects.toThrow('reason is required');
    });

    it('throws for non-REVIEW status', async () => {
      await state.updateTask('task-1', { status: 'DONE' });
      const tool = qaRejectTool(state);
      await expect(
        tool.handler({ taskId: 'task-1', reason: 'test' }, state)
      ).rejects.toThrow('Task must be in REVIEW status');
    });
  });
});
