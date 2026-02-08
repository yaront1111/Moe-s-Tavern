import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { cancelSpeedModeTimeout, clearAllSpeedModeTimeouts } from './submitPlan.js';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { StateManager } from '../state/StateManager.js';
import { submitPlanTool } from './submitPlan.js';
import type { Task, Epic, Project } from '../types/schema.js';

describe('SPEED mode timeout cancellation', () => {
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
        techStack: [],
        forbiddenPatterns: [],
        requiredPatterns: [],
        formatting: '',
        testing: '',
        customRules: [],
      },
      settings: {
        approvalMode: 'SPEED',
        speedModeDelayMs: 5000,
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
      description: '',
      architectureNotes: '',
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
      description: '',
      definitionOfDone: ['Done'],
      taskRails: [],
      implementationPlan: [],
      status: 'PLANNING',
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

  beforeEach(() => {
    vi.useFakeTimers();
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moe-speed-test-'));
    moePath = path.join(testDir, '.moe');
    state = new StateManager({ projectPath: testDir });
  });

  afterEach(() => {
    clearAllSpeedModeTimeouts();
    vi.useRealTimers();
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('cancelSpeedModeTimeout cancels a tracked timeout', async () => {
    setupMoeFolder();
    createEpic();
    createTask({ id: 'task-speed-1', status: 'PLANNING' });
    await state.load();

    const tool = submitPlanTool(state);
    await tool.handler({
      taskId: 'task-speed-1',
      steps: [{ description: 'Step 1' }],
    }, state);

    // Task should be AWAITING_APPROVAL
    expect(state.getTask('task-speed-1')?.status).toBe('AWAITING_APPROVAL');

    // Cancel the timeout before it fires
    cancelSpeedModeTimeout('task-speed-1');

    // Advance time past the delay
    vi.advanceTimersByTime(6000);

    // Task should still be AWAITING_APPROVAL since timeout was cancelled
    expect(state.getTask('task-speed-1')?.status).toBe('AWAITING_APPROVAL');
  });

  it('clearAllSpeedModeTimeouts cancels all tracked timeouts', async () => {
    setupMoeFolder();
    createEpic();
    createTask({ id: 'task-s1', status: 'PLANNING' });
    createTask({ id: 'task-s2', status: 'PLANNING', order: 2 });
    await state.load();

    const tool = submitPlanTool(state);

    // Submit plans for both tasks (each creates a SPEED mode timeout)
    await tool.handler({ taskId: 'task-s1', steps: [{ description: 'Step 1' }] }, state);
    // task-s1 moved to AWAITING_APPROVAL, need to set task-s2 to PLANNING for submit
    await tool.handler({ taskId: 'task-s2', steps: [{ description: 'Step 1' }] }, state);

    expect(state.getTask('task-s1')?.status).toBe('AWAITING_APPROVAL');
    expect(state.getTask('task-s2')?.status).toBe('AWAITING_APPROVAL');

    // Clear all timeouts (simulating shutdown)
    clearAllSpeedModeTimeouts();

    // Advance time past the delay
    vi.advanceTimersByTime(6000);

    // Both tasks should still be AWAITING_APPROVAL
    expect(state.getTask('task-s1')?.status).toBe('AWAITING_APPROVAL');
    expect(state.getTask('task-s2')?.status).toBe('AWAITING_APPROVAL');
  });

  it('cancelSpeedModeTimeout is a no-op for unknown taskId', () => {
    // Should not throw
    cancelSpeedModeTimeout('nonexistent-task');
  });

  it('timeout auto-approves when not cancelled', async () => {
    setupMoeFolder();
    createEpic();
    createTask({ id: 'task-auto', status: 'PLANNING' });
    await state.load();

    const tool = submitPlanTool(state);
    await tool.handler({
      taskId: 'task-auto',
      steps: [{ description: 'Step 1' }],
    }, state);

    expect(state.getTask('task-auto')?.status).toBe('AWAITING_APPROVAL');

    // Advance time past the delay without cancelling
    await vi.advanceTimersByTimeAsync(6000);

    // Task should now be WORKING (auto-approved)
    expect(state.getTask('task-auto')?.status).toBe('WORKING');
  });
});
