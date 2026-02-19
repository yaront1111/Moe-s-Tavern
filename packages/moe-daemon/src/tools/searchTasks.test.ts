import { afterEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { Task } from '../types/schema.js';
import { StateManager } from '../state/StateManager.js';
import { searchTasksTool } from './searchTasks.js';

function setupMoeFolder(testDir: string): string {
  const moePath = path.join(testDir, '.moe');
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
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(moePath, 'project.json'), JSON.stringify(project, null, 2));

  const epic = {
    id: 'epic-1',
    projectId: 'proj-test',
    title: 'Test Epic',
    description: 'Epic description',
    architectureNotes: '',
    epicRails: [],
    status: 'ACTIVE',
    order: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(moePath, 'epics', 'epic-1.json'), JSON.stringify(epic, null, 2));

  return moePath;
}

function createTask(moePath: string, overrides: Partial<Task> & { id: string }): void {
  const now = new Date().toISOString();
  const task: Task = {
    id: overrides.id,
    epicId: 'epic-1',
    title: 'Task',
    description: 'Description',
    definitionOfDone: [],
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
    createdAt: now,
    updatedAt: now,
    comments: [],
    ...overrides,
  };
  fs.writeFileSync(path.join(moePath, 'tasks', `${task.id}.json`), JSON.stringify(task, null, 2));
}

describe('searchTasksTool validation', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it('truncates query to 500 chars and still returns matches', async () => {
    const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moe-search-test-'));
    tempDirs.push(testDir);
    const moePath = setupMoeFolder(testDir);

    createTask(moePath, {
      id: 'task-1',
      title: 'Query cap',
      description: `prefix-${'a'.repeat(500)}-suffix`,
    });

    const state = new StateManager({ projectPath: testDir });
    await state.load();

    const tool = searchTasksTool(state);
    const result = await tool.handler({ query: 'a'.repeat(700) }, state) as {
      tasks: Task[];
      query: string | null;
      totalMatches: number;
    };

    expect(result.query).toHaveLength(500);
    expect(result.totalMatches).toBe(1);
    expect(result.tasks[0]?.id).toBe('task-1');
  });

  it('clamps result limit to 200 max and 1 min', async () => {
    const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moe-search-test-'));
    tempDirs.push(testDir);
    const moePath = setupMoeFolder(testDir);

    for (let i = 1; i <= 250; i++) {
      createTask(moePath, {
        id: `task-${i}`,
        title: `Task ${i}`,
        order: i,
      });
    }

    const state = new StateManager({ projectPath: testDir });
    await state.load();
    const tool = searchTasksTool(state);

    const highLimitResult = await tool.handler({ limit: 999 }, state) as { tasks: Task[] };
    expect(highLimitResult.tasks).toHaveLength(200);

    const lowLimitResult = await tool.handler({ limit: -3 }, state) as { tasks: Task[] };
    expect(lowLimitResult.tasks).toHaveLength(1);
  });

  it('rejects malformed query and limit types', async () => {
    const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moe-search-test-'));
    tempDirs.push(testDir);
    const moePath = setupMoeFolder(testDir);
    createTask(moePath, { id: 'task-1' });

    const state = new StateManager({ projectPath: testDir });
    await state.load();
    const tool = searchTasksTool(state);

    await expect(
      tool.handler({ query: 123 as unknown as string }, state)
    ).rejects.toThrow('Invalid query: must be a string');

    await expect(
      tool.handler({ limit: '10' as unknown as number }, state)
    ).rejects.toThrow('Invalid limit: must be a finite number');
  });
});
