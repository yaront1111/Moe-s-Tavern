import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { StateManager } from '../state/StateManager.js';
import { startStepTool } from './startStep.js';
import { MoeError, MoeErrorCode } from '../util/errors.js';
import type { Task, Epic, Project } from '../types/schema.js';

describe('moe.start_step ownership + ordering enforcement', () => {
  let testDir: string;
  let moePath: string;
  let state: StateManager;

  function setupMoe() {
    fs.mkdirSync(moePath, { recursive: true });
    for (const sub of ['epics', 'tasks', 'workers', 'proposals']) {
      fs.mkdirSync(path.join(moePath, sub));
    }
    const project: Partial<Project> = {
      id: 'proj-test',
      schemaVersion: 6,
      name: 'Test',
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
        approvalMode: 'TURBO',
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
      id: 'epic-1',
      projectId: 'proj-test',
      title: '',
      description: '',
      architectureNotes: '',
      epicRails: [],
      status: 'ACTIVE',
      order: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(moePath, 'epics', `${epic.id}.json`), JSON.stringify(epic, null, 2));
    return epic;
  }

  function writeTask(overrides: Partial<Task> = {}): Task {
    const now = new Date().toISOString();
    const task: Task = {
      id: 'task-1',
      epicId: 'epic-1',
      title: 't',
      description: '',
      definitionOfDone: [],
      taskRails: [],
      implementationPlan: [
        { stepId: 'step-1', description: 'first', status: 'PENDING', affectedFiles: [] },
      ],
      status: 'WORKING',
      assignedWorkerId: 'worker-a',
      branch: null,
      prLink: null,
      reopenCount: 0,
      reopenReason: null,
      createdBy: 'HUMAN',
      parentTaskId: null,
      priority: 'MEDIUM',
      order: 1,
      comments: [],
      createdAt: now,
      updatedAt: now,
      ...overrides,
    };
    fs.writeFileSync(path.join(moePath, 'tasks', `${task.id}.json`), JSON.stringify(task, null, 2));
    return task;
  }

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moe-start-step-'));
    moePath = path.join(testDir, '.moe');
    state = new StateManager({ projectPath: testDir });
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('rejects when workerId has not fetched context', async () => {
    setupMoe();
    writeEpic();
    writeTask();
    await state.load();

    const tool = startStepTool(state);
    try {
      await tool.handler({ taskId: 'task-1', stepId: 'step-1', workerId: 'worker-a' }, state);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(MoeError);
      expect((err as MoeError).code).toBe(MoeErrorCode.NOT_ALLOWED);
      expect((err as Error).message).toContain('moe.get_context');
    }
  });

  it('rejects when a different worker attempts to start the step', async () => {
    setupMoe();
    writeEpic();
    writeTask({ contextFetchedBy: ['worker-b'] });
    await state.load();

    const tool = startStepTool(state);
    try {
      await tool.handler({ taskId: 'task-1', stepId: 'step-1', workerId: 'worker-b' }, state);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(MoeError);
      expect((err as MoeError).code).toBe(MoeErrorCode.NOT_ALLOWED);
    }
  });

  it('starts the step after context has been fetched by owner', async () => {
    setupMoe();
    writeEpic();
    writeTask({ contextFetchedBy: ['worker-a'] });
    await state.load();

    const tool = startStepTool(state);
    const result = await tool.handler({ taskId: 'task-1', stepId: 'step-1', workerId: 'worker-a' }, state) as { success: boolean };
    expect(result.success).toBe(true);
    const task = state.getTask('task-1');
    const step = task?.implementationPlan[0];
    expect(step?.status).toBe('IN_PROGRESS');
    expect(step?.startedAt).toBeDefined();
    expect(task?.workStartedAt).toBeDefined();
  });

  it('preserves legacy path when workerId is not supplied (null assignedWorkerId)', async () => {
    setupMoe();
    writeEpic();
    writeTask({ assignedWorkerId: null });
    await state.load();

    const tool = startStepTool(state);
    const result = await tool.handler({ taskId: 'task-1', stepId: 'step-1' }, state) as { success: boolean };
    expect(result.success).toBe(true);
  });
});

// ---- migrated from tools.test.ts ----
import { ToolTestHarness } from './toolTestHarness.js';
import { vi } from 'vitest';

describe('moe.start_step', () => {
  const h = new ToolTestHarness();
  beforeEach(() => h.init());
  afterEach(() => { vi.restoreAllMocks(); h.cleanup(); });

  beforeEach(async () => {
    h.setupMoeFolder();
    h.createEpic();
    h.createTask({
      status: 'WORKING',
      implementationPlan: [
        { stepId: 'step-1', description: 'First step', status: 'PENDING', affectedFiles: [] },
        { stepId: 'step-2', description: 'Second step', status: 'PENDING', affectedFiles: [] },
      ],
    });
    await h.state.load();
  });

  it('marks step as IN_PROGRESS', async () => {
    const tool = startStepTool(h.state);
    const result = await tool.handler({ taskId: 'task-1', stepId: 'step-1' }, h.state) as { success: boolean; stepNumber: number };

    expect(result.success).toBe(true);
    expect(result.stepNumber).toBe(1);

    const task = h.state.getTask('task-1');
    expect(task?.implementationPlan[0].status).toBe('IN_PROGRESS');
    expect(task?.implementationPlan[0].startedAt).toBeDefined();
  });

  it('throws for non-existent step', async () => {
    const tool = startStepTool(h.state);
    await expect(
      tool.handler({ taskId: 'task-1', stepId: 'nonexistent' }, h.state)
    ).rejects.toThrow('STEP_NOT_FOUND');
  });
});

