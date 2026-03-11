import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { StateManager } from '../../state/StateManager.js';
import { waitForApprovalTool } from '../waitForApproval.js';
import type { Task, Epic, Project } from '../../types/schema.js';

describe('moe.wait_for_approval', () => {
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
        forbiddenPatterns: [],
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
      definitionOfDone: ['Tests pass'],
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
      priority: 'MEDIUM',
      order: 1,
      comments: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...overrides,
    };
    fs.writeFileSync(path.join(moePath, 'tasks', `${task.id}.json`), JSON.stringify(task, null, 2));
    return task;
  }

  beforeEach(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moe-wait-approval-test-'));
    moePath = path.join(testDir, '.moe');
    state = new StateManager({ projectPath: testDir });
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('returns approved=true immediately when task is already WORKING', async () => {
    setupMoeFolder();
    createEpic();
    createTask({ id: 'task-1', status: 'WORKING' });
    await state.load();

    const tool = waitForApprovalTool(state);
    const result = await tool.handler({ taskId: 'task-1' }, state) as { approved: boolean; taskId: string };

    expect(result.approved).toBe(true);
    expect(result.taskId).toBe('task-1');
  });

  it('returns rejected=true immediately when task is PLANNING with reopenReason', async () => {
    setupMoeFolder();
    createEpic();
    createTask({ id: 'task-1', status: 'PLANNING', reopenReason: 'Needs more detail' });
    await state.load();

    const tool = waitForApprovalTool(state);
    const result = await tool.handler({ taskId: 'task-1' }, state) as { rejected: boolean; reason: string; taskId: string };

    expect(result.rejected).toBe(true);
    expect(result.reason).toBe('Needs more detail');
    expect(result.taskId).toBe('task-1');
  });

  it('returns status info when task is not in AWAITING_APPROVAL', async () => {
    setupMoeFolder();
    createEpic();
    createTask({ id: 'task-1', status: 'BACKLOG' });
    await state.load();

    const tool = waitForApprovalTool(state);
    const result = await tool.handler({ taskId: 'task-1' }, state) as {
      approved: boolean;
      rejected: boolean;
      timedOut: boolean;
      status: string;
      taskId: string;
    };

    expect(result.approved).toBe(false);
    expect(result.rejected).toBe(false);
    expect(result.timedOut).toBe(false);
    expect(result.status).toBe('BACKLOG');
  });

  it('throws for non-existent task', async () => {
    setupMoeFolder();
    createEpic();
    await state.load();

    const tool = waitForApprovalTool(state);
    await expect(tool.handler({ taskId: 'nonexistent' }, state)).rejects.toThrow('Task not found');
  });

  it('throws for missing taskId', async () => {
    setupMoeFolder();
    await state.load();

    const tool = waitForApprovalTool(state);
    await expect(tool.handler({}, state)).rejects.toThrow('Missing required field: taskId');
  });

  it('resolves with approved=true when task moves to WORKING', async () => {
    setupMoeFolder();
    createEpic();
    createTask({ id: 'task-1', status: 'AWAITING_APPROVAL' });
    await state.load();

    const tool = waitForApprovalTool(state);
    const promise = tool.handler({ taskId: 'task-1', timeoutMs: 5000 }, state) as Promise<{
      approved: boolean;
      taskId: string;
    }>;

    // Simulate approval after a short delay
    setTimeout(async () => {
      await state.approveTask('task-1');
    }, 50);

    const result = await promise;
    expect(result.approved).toBe(true);
    expect(result.taskId).toBe('task-1');
  });

  it('resolves with rejected=true when task moves back to PLANNING', async () => {
    setupMoeFolder();
    createEpic();
    createTask({ id: 'task-1', status: 'AWAITING_APPROVAL' });
    await state.load();

    const tool = waitForApprovalTool(state);
    const promise = tool.handler({ taskId: 'task-1', timeoutMs: 5000 }, state) as Promise<{
      rejected: boolean;
      reason: string;
      taskId: string;
    }>;

    // Simulate rejection after a short delay
    setTimeout(async () => {
      await state.rejectTask('task-1', 'Plan is incomplete');
    }, 50);

    const result = await promise;
    expect(result.rejected).toBe(true);
    expect(result.reason).toBe('Plan is incomplete');
    expect(result.taskId).toBe('task-1');
  });

  it('resolves with timedOut=true when timeout expires', async () => {
    setupMoeFolder();
    createEpic();
    createTask({ id: 'task-1', status: 'AWAITING_APPROVAL' });
    await state.load();

    const tool = waitForApprovalTool(state);
    // Use minimum timeout (1000ms) for fast test
    const result = await tool.handler({ taskId: 'task-1', timeoutMs: 1000 }, state) as {
      timedOut: boolean;
      taskId: string;
    };

    expect(result.timedOut).toBe(true);
    expect(result.taskId).toBe('task-1');
  }, 10000);

  it('ignores updates to other tasks', async () => {
    setupMoeFolder();
    createEpic();
    createTask({ id: 'task-1', status: 'AWAITING_APPROVAL' });
    createTask({ id: 'task-2', status: 'AWAITING_APPROVAL', order: 2 });
    await state.load();

    const tool = waitForApprovalTool(state);
    const promise = tool.handler({ taskId: 'task-1', timeoutMs: 2000 }, state) as Promise<{
      approved?: boolean;
      timedOut?: boolean;
    }>;

    // Approve task-2, not task-1 - should not resolve the waiter
    setTimeout(async () => {
      await state.approveTask('task-2');
    }, 50);

    // Then approve task-1 shortly after
    setTimeout(async () => {
      await state.approveTask('task-1');
    }, 100);

    const result = await promise;
    expect(result.approved).toBe(true);
  }, 10000);
});

describe('agentTeamMode settings normalization', () => {
  let testDir: string;
  let moePath: string;

  function setupMoeFolder(settingsOverrides: Record<string, unknown> = {}) {
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
        techStack: [],
        forbiddenPatterns: [],
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
        ...settingsOverrides,
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    fs.writeFileSync(path.join(moePath, 'project.json'), JSON.stringify(project, null, 2));
  }

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moe-settings-test-'));
    moePath = path.join(testDir, '.moe');
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('defaults agentTeamMode to false when not set', async () => {
    setupMoeFolder();
    const state = new StateManager({ projectPath: testDir });
    await state.load();

    expect(state.project?.settings.agentTeamMode).toBe(false);
  });

  it('preserves agentTeamMode=true when explicitly set', async () => {
    setupMoeFolder({ agentTeamMode: true });
    const state = new StateManager({ projectPath: testDir });
    await state.load();

    expect(state.project?.settings.agentTeamMode).toBe(true);
  });

  it('normalizes non-boolean agentTeamMode to false', async () => {
    setupMoeFolder({ agentTeamMode: 'yes' });
    const state = new StateManager({ projectPath: testDir });
    await state.load();

    expect(state.project?.settings.agentTeamMode).toBe(false);
  });

  it('updates agentTeamMode via updateSettings', async () => {
    setupMoeFolder();
    const state = new StateManager({ projectPath: testDir });
    await state.load();

    expect(state.project?.settings.agentTeamMode).toBe(false);

    await state.updateSettings({ agentTeamMode: true });
    expect(state.project?.settings.agentTeamMode).toBe(true);

    await state.updateSettings({ agentTeamMode: false });
    expect(state.project?.settings.agentTeamMode).toBe(false);
  });
});
