import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { StateManager } from '../state/StateManager.js';
import { completeTaskTool } from './completeTask.js';
import { MoeError, MoeErrorCode } from '../util/errors.js';
import type { Task, Epic, Project } from '../types/schema.js';

describe('moe.complete_task ownership + ordering enforcement', () => {
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
      definitionOfDone: [], taskRails: [],
      implementationPlan: [
        { stepId: 'step-1', description: 'first', status: 'COMPLETED', affectedFiles: [] },
      ],
      status: 'WORKING', assignedWorkerId: 'worker-a', branch: null, prLink: null,
      reopenCount: 0, reopenReason: null, createdBy: 'HUMAN', parentTaskId: null,
      priority: 'MEDIUM', order: 1, comments: [],
      createdAt: now, updatedAt: now,
      ...overrides,
    };
    fs.writeFileSync(path.join(moePath, 'tasks', 'task-1.json'), JSON.stringify(task, null, 2));
    return task;
  }

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moe-complete-task-'));
    moePath = path.join(testDir, '.moe');
    state = new StateManager({ projectPath: testDir });
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('rejects when any step is still PENDING', async () => {
    setupMoe();
    writeEpic();
    writeTask({
      implementationPlan: [
        { stepId: 'step-1', description: 'first', status: 'COMPLETED', affectedFiles: [] },
        { stepId: 'step-2', description: 'second', status: 'PENDING', affectedFiles: [] },
      ],
    });
    await state.load();
    const tool = completeTaskTool(state);
    try {
      await tool.handler({ taskId: 'task-1', workerId: 'worker-a' }, state);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(MoeError);
      expect((err as MoeError).code).toBe(MoeErrorCode.NOT_ALLOWED);
      expect((err as Error).message).toContain('1 step');
    }
    expect(state.getTask('task-1')?.status).toBe('WORKING');
  });

  it('rejects when task is not in WORKING state (e.g. already REVIEW)', async () => {
    setupMoe();
    writeEpic();
    writeTask({ status: 'REVIEW' });
    await state.load();
    const tool = completeTaskTool(state);
    try {
      await tool.handler({ taskId: 'task-1', workerId: 'worker-a' }, state);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(MoeError);
      expect((err as MoeError).code).toBe(MoeErrorCode.INVALID_STATE);
    }
  });

  it('rejects when a different worker attempts to complete', async () => {
    setupMoe();
    writeEpic();
    writeTask();
    await state.load();
    const tool = completeTaskTool(state);
    try {
      await tool.handler({ taskId: 'task-1', workerId: 'worker-b' }, state);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(MoeError);
      expect((err as MoeError).code).toBe(MoeErrorCode.NOT_ALLOWED);
    }
  });

  it('moves task to REVIEW when all guards pass', async () => {
    setupMoe();
    writeEpic();
    writeTask();
    await state.load();
    const tool = completeTaskTool(state);
    const result = await tool.handler({ taskId: 'task-1', workerId: 'worker-a' }, state) as { status: string };
    expect(result.status).toBe('REVIEW');
    expect(state.getTask('task-1')?.status).toBe('REVIEW');
  });
});
