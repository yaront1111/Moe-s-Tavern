import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { StateManager } from './StateManager.js';
import type { Task, Epic, Project } from '../types/schema.js';

describe('Task schema: contextFetchedBy / stepsCompleted round-trip', () => {
  let testDir: string;
  let moePath: string;
  let state: StateManager;

  function setupMoeFolder() {
    fs.mkdirSync(moePath, { recursive: true });
    for (const sub of ['epics', 'tasks', 'workers', 'proposals', 'channels', 'decisions', 'teams']) {
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
        speedModeDelayMs: 5000,
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
      title: 'Test',
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
      id: 'task-rt',
      epicId: 'epic-1',
      title: 'Round-trip',
      description: '',
      definitionOfDone: ['Done'],
      taskRails: [],
      implementationPlan: [],
      status: 'WORKING',
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
      createdAt: now,
      updatedAt: now,
      ...overrides,
    };
    fs.writeFileSync(path.join(moePath, 'tasks', `${task.id}.json`), JSON.stringify(task, null, 2));
    return task;
  }

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moe-schema-rt-'));
    moePath = path.join(testDir, '.moe');
    state = new StateManager({ projectPath: testDir });
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('persists contextFetchedBy and stepsCompleted via updateTask', async () => {
    setupMoeFolder();
    writeEpic();
    writeTask();
    await state.load();

    await state.updateTask('task-rt', {
      contextFetchedBy: ['worker-a', 'worker-b'],
      stepsCompleted: ['step-1', 'step-2'],
    });

    const stored = JSON.parse(fs.readFileSync(path.join(moePath, 'tasks', 'task-rt.json'), 'utf8'));
    expect(stored.contextFetchedBy).toEqual(['worker-a', 'worker-b']);
    expect(stored.stepsCompleted).toEqual(['step-1', 'step-2']);

    const reloaded = new StateManager({ projectPath: testDir });
    await reloaded.load();
    const task = reloaded.getTask('task-rt');
    expect(task?.contextFetchedBy).toEqual(['worker-a', 'worker-b']);
    expect(task?.stepsCompleted).toEqual(['step-1', 'step-2']);
  });

  it('dedupes entries via the sanitizer', async () => {
    setupMoeFolder();
    writeEpic();
    writeTask();
    await state.load();

    await state.updateTask('task-rt', {
      contextFetchedBy: ['worker-a', 'worker-a', 'worker-b'],
      stepsCompleted: ['step-1', 'step-1'],
    });

    const t = state.getTask('task-rt');
    expect(t?.contextFetchedBy).toEqual(['worker-a', 'worker-b']);
    expect(t?.stepsCompleted).toEqual(['step-1']);
  });

  it('loads existing tasks that lack the new fields without error', async () => {
    setupMoeFolder();
    writeEpic();
    writeTask();
    await state.load();
    const task = state.getTask('task-rt');
    expect(task).toBeDefined();
    expect(task?.contextFetchedBy).toBeUndefined();
    expect(task?.stepsCompleted).toBeUndefined();
  });

  it('defends against non-array values loaded from disk', async () => {
    setupMoeFolder();
    writeEpic();
    const now = new Date().toISOString();
    const corrupted = {
      id: 'task-rt',
      epicId: 'epic-1',
      title: 'Corrupt',
      description: '',
      definitionOfDone: ['Done'],
      taskRails: [],
      implementationPlan: [],
      status: 'WORKING',
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
      createdAt: now,
      updatedAt: now,
      contextFetchedBy: 'not-an-array',
      stepsCompleted: { bad: true },
    };
    fs.writeFileSync(path.join(moePath, 'tasks', 'task-rt.json'), JSON.stringify(corrupted, null, 2));
    await state.load();
    const task = state.getTask('task-rt');
    expect(task?.contextFetchedBy).toEqual([]);
    expect(task?.stepsCompleted).toEqual([]);
  });
});
