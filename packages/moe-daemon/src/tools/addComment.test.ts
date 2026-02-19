import { afterEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { Task } from '../types/schema.js';
import { StateManager } from '../state/StateManager.js';
import { addCommentTool, MAX_TASK_COMMENT_LENGTH } from './addComment.js';

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

  const now = new Date().toISOString();
  const task: Task = {
    id: 'task-1',
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
  };
  fs.writeFileSync(path.join(moePath, 'tasks', 'task-1.json'), JSON.stringify(task, null, 2));

  return moePath;
}

describe('addCommentTool validation', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it('rejects content longer than max allowed length', async () => {
    const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moe-add-comment-test-'));
    tempDirs.push(testDir);
    setupMoeFolder(testDir);

    const state = new StateManager({ projectPath: testDir });
    await state.load();
    const tool = addCommentTool(state);

    await expect(
      tool.handler({
        taskId: 'task-1',
        content: 'x'.repeat(MAX_TASK_COMMENT_LENGTH + 1),
      }, state)
    ).rejects.toThrow(`must be ${MAX_TASK_COMMENT_LENGTH} characters or fewer`);
  });
});
