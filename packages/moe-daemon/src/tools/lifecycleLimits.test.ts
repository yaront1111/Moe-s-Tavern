import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ToolTestHarness } from './toolTestHarness.js';
import { setTaskStatusTool } from './setTaskStatus.js';
import type { Project } from '../types/schema.js';

describe('WIP limits', () => {
  const h = new ToolTestHarness();
  beforeEach(() => h.init());
  afterEach(() => { vi.restoreAllMocks(); h.cleanup(); });

  beforeEach(async () => {
    h.setupMoeFolder({
      settings: {
        approvalMode: 'CONTROL',
        speedModeDelayMs: 2000,
        autoCreateBranch: true,
        branchPattern: 'moe/{epicId}/{taskId}',
        commitPattern: 'feat({epicId}): {taskTitle}',
        agentCommand: 'claude',
        columnLimits: { REVIEW: 1 }
      }
    } as Partial<Project>);
    h.createEpic();
    h.createTask({ id: 'task-1', status: 'WORKING' });
    await h.state.load();
  });

  it('blocks transition when WIP limit reached', async () => {
    // Move task-1 to REVIEW first (occupying the 1 slot)
    await h.state.updateTask('task-1', { status: 'REVIEW' });

    // Create a second task in WORKING
    h.createTask({ id: 'task-2', status: 'WORKING', order: 2 });
    await h.state.load();

    const tool = setTaskStatusTool(h.state);
    await expect(
      tool.handler({ taskId: 'task-2', status: 'REVIEW' }, h.state)
    ).rejects.toThrow('WIP limit of 1');
  });

  it('allows transition when under WIP limit', async () => {
    // task-1 is in WORKING, REVIEW column is empty
    const tool = setTaskStatusTool(h.state);
    const result = await tool.handler({
      taskId: 'task-1',
      status: 'REVIEW',
    }, h.state) as { success: boolean };

    expect(result.success).toBe(true);
  });
});


// ---- migrated from tools.test.ts ----
import { listTasksTool } from './listTasks.js';
import { searchTasksTool } from './searchTasks.js';

describe('ARCHIVED status', () => {
  const h = new ToolTestHarness();
  beforeEach(() => h.init());
  afterEach(() => { vi.restoreAllMocks(); h.cleanup(); });

  beforeEach(async () => {
    h.setupMoeFolder();
    h.createEpic();
    h.createTask({ id: 'task-1', status: 'DONE' });
    await h.state.load();
  });

  it('allows DONE to ARCHIVED transition', async () => {
    const tool = setTaskStatusTool(h.state);
    const result = await tool.handler({
      taskId: 'task-1',
      status: 'ARCHIVED',
    }, h.state) as { success: boolean; status: string };
    expect(result.success).toBe(true);
    expect(result.status).toBe('ARCHIVED');
  });

  it('allows ARCHIVED to BACKLOG transition (un-archive)', async () => {
    await h.state.updateTask('task-1', { status: 'ARCHIVED' });
    const tool = setTaskStatusTool(h.state);
    const result = await tool.handler({
      taskId: 'task-1',
      status: 'BACKLOG',
    }, h.state) as { success: boolean; status: string };
    expect(result.success).toBe(true);
    expect(result.status).toBe('BACKLOG');
  });

  it('allows BACKLOG to ARCHIVED transition (shelve stale tickets)', async () => {
    h.createTask({ id: 'task-bl', status: 'BACKLOG' });
    await h.state.load();
    const tool = setTaskStatusTool(h.state);
    const result = await tool.handler({
      taskId: 'task-bl',
      status: 'ARCHIVED',
    }, h.state) as { success: boolean; status: string };
    expect(result.success).toBe(true);
    expect(result.status).toBe('ARCHIVED');
  });

  it('rejects WORKING to ARCHIVED transition (in-flight, not a resting state)', async () => {
    h.createTask({ id: 'task-wk', status: 'WORKING' });
    await h.state.load();
    const tool = setTaskStatusTool(h.state);
    await expect(tool.handler({
      taskId: 'task-wk',
      status: 'ARCHIVED',
    }, h.state)).rejects.toThrow();
  });

  it('listTasks hides archived tasks by default but still counts them', async () => {
    await h.state.updateTask('task-1', { status: 'ARCHIVED' });
    const tool = listTasksTool(h.state);
    const result = await tool.handler({}, h.state) as {
      tasks: Array<{ id: string }>;
      counts: { archived: number };
    };
    expect(result.counts.archived).toBe(1);
    expect(result.tasks.some((t) => t.id === 'task-1')).toBe(false);
  });

  it('listTasks surfaces archived tasks when includeArchived is set', async () => {
    await h.state.updateTask('task-1', { status: 'ARCHIVED' });
    const tool = listTasksTool(h.state);
    const result = await tool.handler({ includeArchived: true }, h.state) as {
      tasks: Array<{ id: string }>;
    };
    expect(result.tasks.some((t) => t.id === 'task-1')).toBe(true);
  });

  it('listTasks surfaces archived tasks when ARCHIVED is named in the status filter', async () => {
    await h.state.updateTask('task-1', { status: 'ARCHIVED' });
    const tool = listTasksTool(h.state);
    const result = await tool.handler({ status: ['ARCHIVED'] }, h.state) as {
      tasks: Array<{ id: string }>;
    };
    expect(result.tasks.some((t) => t.id === 'task-1')).toBe(true);
  });

  it('searchTasks excludes archived tasks by default', async () => {
    await h.state.updateTask('task-1', { status: 'ARCHIVED' });
    const tool = searchTasksTool(h.state);
    const result = await tool.handler({}, h.state) as { tasks: Array<{ id: string }> };
    expect(result.tasks.some((t) => t.id === 'task-1')).toBe(false);
  });

  it('searchTasks can filter by ARCHIVED status', async () => {
    await h.state.updateTask('task-1', { status: 'ARCHIVED' });
    const tool = searchTasksTool(h.state);
    const result = await tool.handler({
      filters: { status: 'ARCHIVED' },
    }, h.state) as { tasks: Task[] };
    expect(result.tasks.length).toBe(1);
    expect(result.tasks[0].id).toBe('task-1');
  });
});

