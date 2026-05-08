import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { StateManager } from '../state/StateManager.js';
import { releaseTaskTool } from './releaseTask.js';
import type { Project, Epic, Task, Worker } from '../types/schema.js';

describe('moe.release_task', () => {
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
      globalRails: { techStack: [], forbiddenPatterns: [], requiredPatterns: [], formatting: '', testing: '', customRules: [] },
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
      id: 'task-1', epicId: 'epic-1', title: 'Some task', description: '',
      definitionOfDone: [], taskRails: [], implementationPlan: [],
      status: 'WORKING', assignedWorkerId: 'worker-a', branch: null, prLink: null,
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
      currentTaskId: 'task-1', status: 'CODING', branch: '', modifiedFiles: [],
      startedAt: now, lastActivityAt: now, lastError: null, errorCount: 0, teamId: null,
      ...overrides,
    };
    fs.writeFileSync(path.join(moePath, 'workers', worker.id + '.json'), JSON.stringify(worker, null, 2));
    return worker;
  }

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moe-release-task-'));
    moePath = path.join(testDir, '.moe');
    setupMoe();
    writeEpic();
    state = new StateManager({ projectPath: testDir });
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('clears assignedWorkerId and sets owning worker IDLE, status preserved', async () => {
    writeTask({ assignedWorkerId: 'worker-a', status: 'WORKING' });
    writeWorker({ id: 'worker-a', currentTaskId: 'task-1', status: 'CODING' });
    await state.load();

    const tool = releaseTaskTool(state);
    const result = await tool.handler({ taskId: 'task-1', reason: 'stuck' }, state) as Record<string, unknown>;

    expect(result.success).toBe(true);
    expect(result.previousWorkerId).toBe('worker-a');
    expect(result.status).toBe('WORKING');

    const task = state.getTask('task-1')!;
    expect(task.assignedWorkerId).toBeNull();
    expect(task.status).toBe('WORKING');

    const worker = state.getWorker('worker-a')!;
    expect(worker.currentTaskId).toBeNull();
    expect(worker.status).toBe('IDLE');
  });

  it('does not modify a worker whose currentTaskId is a different task', async () => {
    writeTask({ id: 'task-1', assignedWorkerId: 'worker-a', status: 'WORKING' });
    // worker is recorded as working a different task
    writeWorker({ id: 'worker-a', currentTaskId: 'task-other', status: 'CODING' });
    await state.load();

    const tool = releaseTaskTool(state);
    await tool.handler({ taskId: 'task-1' }, state);

    const worker = state.getWorker('worker-a')!;
    expect(worker.currentTaskId).toBe('task-other');
    expect(worker.status).toBe('CODING');

    const task = state.getTask('task-1')!;
    expect(task.assignedWorkerId).toBeNull();
  });

  it('is a no-op success when task is already unassigned', async () => {
    writeTask({ assignedWorkerId: null, status: 'PLANNING' });
    await state.load();

    const tool = releaseTaskTool(state);
    const result = await tool.handler({ taskId: 'task-1' }, state) as Record<string, unknown>;

    expect(result.success).toBe(true);
    expect(result.previousWorkerId).toBeNull();
    expect(state.getTask('task-1')!.assignedWorkerId).toBeNull();
  });

  it('throws notFound for unknown taskId', async () => {
    await state.load();
    const tool = releaseTaskTool(state);
    await expect(tool.handler({ taskId: 'task-nope' }, state))
      .rejects.toThrow(/not found|NOT_FOUND/i);
  });

  it('throws missingRequired when taskId is omitted', async () => {
    await state.load();
    const tool = releaseTaskTool(state);
    await expect(tool.handler({}, state)).rejects.toThrow(/taskId/);
  });
});
