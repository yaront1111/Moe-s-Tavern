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

// ---- migrated from tools.test.ts ----
import { ToolTestHarness } from './toolTestHarness.js';
import { vi } from 'vitest';
import { MAX_COMMENTS_PER_TASK } from '../state/StateManager.js';

describe('Task comments', () => {
  const h = new ToolTestHarness();
  beforeEach(() => h.init());
  afterEach(() => { vi.restoreAllMocks(); h.cleanup(); });

  const makeComments = (count: number) =>
    Array.from({ length: count }, (_, i) => ({
      id: `comment-${i}`,
      author: i % 2 === 0 ? 'human' : 'worker-1',
      content: `Comment ${i}`,
      timestamp: new Date(Date.now() + i).toISOString(),
    }));

  beforeEach(async () => {
    h.setupMoeFolder();
    h.createEpic();
    h.createTask({ id: 'task-1', status: 'WORKING' });
    await h.state.load();
  });

  it('adds a comment to a task', async () => {
    const tool = addCommentTool(h.state);
    const result = await tool.handler({
      taskId: 'task-1',
      content: 'What does this feature do?',
    }, h.state) as { success: boolean; commentId: string; totalComments: number };
    expect(result.success).toBe(true);
    expect(result.totalComments).toBe(1);
    const task = h.state.getTask('task-1');
    expect(task?.comments.length).toBe(1);
    expect(task?.comments[0].content).toBe('What does this feature do?');
    expect(task?.comments[0].author).toBe('agent');
  });

  it('uses workerId as author when provided', async () => {
    const tool = addCommentTool(h.state);
    await tool.handler({
      taskId: 'task-1',
      content: 'Response here',
      workerId: 'worker-123',
    }, h.state);
    const task = h.state.getTask('task-1');
    expect(task?.comments[0].author).toBe('worker-123');
  });

  it('preserves all comments when under limit', async () => {
    await h.state.updateTask('task-1', { comments: makeComments(MAX_COMMENTS_PER_TASK - 1) });
    const tool = addCommentTool(h.state);
    const result = await tool.handler({
      taskId: 'task-1',
      content: 'Newest under limit',
    }, h.state) as { totalComments: number };

    expect(result.totalComments).toBe(MAX_COMMENTS_PER_TASK);
    const task = h.state.getTask('task-1');
    expect(task?.comments.length).toBe(MAX_COMMENTS_PER_TASK);
    expect(task?.comments[0].content).toBe('Comment 0');
    expect(task?.comments.at(-1)?.content).toBe('Newest under limit');
  });

  it('trims oldest comment when adding at limit', async () => {
    await h.state.updateTask('task-1', { comments: makeComments(MAX_COMMENTS_PER_TASK) });
    const tool = addCommentTool(h.state);
    const result = await tool.handler({
      taskId: 'task-1',
      content: 'Newest at limit',
    }, h.state) as { totalComments: number };

    expect(result.totalComments).toBe(MAX_COMMENTS_PER_TASK);
    const task = h.state.getTask('task-1');
    expect(task?.comments.length).toBe(MAX_COMMENTS_PER_TASK);
    expect(task?.comments.some((c) => c.content === 'Comment 0')).toBe(false);
    expect(task?.comments[0].content).toBe('Comment 1');
    expect(task?.comments.at(-1)?.content).toBe('Newest at limit');
  });

  it('trims task with 300 existing comments down to max preserving newest', async () => {
    const task = h.state.getTask('task-1');
    expect(task).toBeTruthy();
    h.state.tasks.set('task-1', {
      ...task!,
      comments: makeComments(300),
    });

    const tool = addCommentTool(h.state);
    const result = await tool.handler({
      taskId: 'task-1',
      content: 'Newest with 300 existing',
    }, h.state) as { totalComments: number };

    expect(result.totalComments).toBe(MAX_COMMENTS_PER_TASK);
    const updatedTask = h.state.getTask('task-1');
    expect(updatedTask?.comments.length).toBe(MAX_COMMENTS_PER_TASK);
    expect(updatedTask?.comments[0].content).toBe('Comment 101');
    expect(updatedTask?.comments.at(-1)?.content).toBe('Newest with 300 existing');
  });

  it('handles null/undefined comments array gracefully', async () => {
    const existing = h.state.getTask('task-1');
    expect(existing).toBeTruthy();
    h.state.tasks.set('task-1', {
      ...existing!,
      comments: null as unknown as Task['comments'],
    });

    const tool = addCommentTool(h.state);
    const result = await tool.handler({
      taskId: 'task-1',
      content: 'Comment on null comments',
    }, h.state) as { totalComments: number };

    expect(result.totalComments).toBe(1);
    const task = h.state.getTask('task-1');
    expect(task?.comments.length).toBe(1);
    expect(task?.comments[0].content).toBe('Comment on null comments');
  });

  it('always preserves newest comments including newly added one', async () => {
    const baseline = makeComments(MAX_COMMENTS_PER_TASK + 25);
    const existing = h.state.getTask('task-1');
    expect(existing).toBeTruthy();
    h.state.tasks.set('task-1', {
      ...existing!,
      comments: baseline,
    });

    const tool = addCommentTool(h.state);
    await tool.handler({
      taskId: 'task-1',
      content: 'Newest preserved',
    }, h.state);

    const task = h.state.getTask('task-1');
    expect(task?.comments.length).toBe(MAX_COMMENTS_PER_TASK);
    expect(task?.comments.some((c) => c.content === 'Comment 0')).toBe(false);
    expect(task?.comments.some((c) => c.content === `Comment ${baseline.length - 1}`)).toBe(true);
    expect(task?.comments.at(-1)?.content).toBe('Newest preserved');
  });

  it('rejects empty content', async () => {
    const tool = addCommentTool(h.state);
    await expect(tool.handler({
      taskId: 'task-1',
      content: '  ',
    }, h.state)).rejects.toThrow();
  });

  it('rejects missing taskId', async () => {
    const tool = addCommentTool(h.state);
    await expect(tool.handler({
      content: 'test',
    }, h.state)).rejects.toThrow();
  });
});

