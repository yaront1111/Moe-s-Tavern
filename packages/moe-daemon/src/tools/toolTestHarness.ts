// =============================================================================
// Shared fixture harness for the per-tool test files split out of the old
// monolithic tools.test.ts. Each test file owns one `ToolTestHarness` instance:
//
//   const h = new ToolTestHarness();
//   beforeEach(() => h.init());
//   afterEach(() => h.cleanup());
//
// Fixture bodies are verbatim from tools.test.ts so behavior is identical.
// =============================================================================

import fs from 'fs';
import path from 'path';
import os from 'os';
import { StateManager } from '../state/StateManager.js';
import type { Task, Epic, Project, Worker } from '../types/schema.js';

export class ToolTestHarness {
  testDir = '';
  moePath = '';
  state!: StateManager;

  init(): void {
    this.testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moe-tools-test-'));
    this.moePath = path.join(this.testDir, '.moe');
    this.state = new StateManager({ projectPath: this.testDir });
  }

  cleanup(): void {
    fs.rmSync(this.testDir, { recursive: true, force: true });
  }

  setupMoeFolder(projectOverrides: Partial<Project> = {}) {
    fs.mkdirSync(this.moePath, { recursive: true });
    fs.mkdirSync(path.join(this.moePath, 'epics'));
    fs.mkdirSync(path.join(this.moePath, 'tasks'));
    fs.mkdirSync(path.join(this.moePath, 'workers'));
    fs.mkdirSync(path.join(this.moePath, 'proposals'));

    const project = {
      id: 'proj-test',
      name: 'Test Project',
      rootPath: this.testDir,
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

    fs.writeFileSync(path.join(this.moePath, 'project.json'), JSON.stringify(project, null, 2));
    // submit_plan rejects affectedFiles that don't exist under the project root
    // unless declared in newFiles; these suites exercise the tool contracts, not
    // the existence gate, so give planned paths a real file on disk.
    fs.writeFileSync(path.join(this.testDir, 'file.ts'), '');
    return project;
  }

  createEpic(overrides: Partial<Epic> = {}): Epic {
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
    fs.writeFileSync(path.join(this.moePath, 'epics', `${epic.id}.json`), JSON.stringify(epic, null, 2));
    return epic;
  }

  createTask(overrides: Partial<Task> = {}): Task {
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
      priority: 'MEDIUM',
      comments: [],
      order: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...overrides,
    };
    fs.writeFileSync(path.join(this.moePath, 'tasks', `${task.id}.json`), JSON.stringify(task, null, 2));
    return task;
  }

  createWorker(overrides: Partial<Worker> = {}): Worker {
    const worker: Worker = {
      id: 'worker-1',
      type: 'CLAUDE',
      projectId: 'proj-test',
      epicId: 'epic-1',
      currentTaskId: null,
      status: 'IDLE',
      teamId: null,
      branch: 'main',
      modifiedFiles: [],
      startedAt: new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
      lastError: null,
      errorCount: 0,
      ...overrides,
    };
    fs.writeFileSync(path.join(this.moePath, 'workers', `${worker.id}.json`), JSON.stringify(worker, null, 2));
    return worker;
  }
}
