import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ToolTestHarness } from './toolTestHarness.js';
import { getContextTool } from './getContext.js';

describe('moe.get_context', () => {
  const h = new ToolTestHarness();
  beforeEach(() => h.init());
  afterEach(() => { vi.restoreAllMocks(); h.cleanup(); });

  it('returns project context without task', async () => {
    h.setupMoeFolder();
    await h.state.load();
    const tool = getContextTool(h.state);
    const result = await tool.handler({}, h.state) as { project: { name: string }; task: null };

    expect(result.project.name).toBe('Test Project');
    expect(result.task).toBeNull();
  });

  it('returns task context when taskId provided', async () => {
    h.setupMoeFolder();
    h.createEpic();
    h.createTask();
    await h.state.load();
    const tool = getContextTool(h.state);
    const result = await tool.handler({ taskId: 'task-1' }, h.state) as { task: { id: string }; epic: { id: string } };

    expect(result.task?.id).toBe('task-1');
    expect(result.epic?.id).toBe('epic-1');
  });

  it('throws if project not loaded', async () => {
    const tool = getContextTool(h.state);
    await expect(tool.handler({}, h.state)).rejects.toThrow('not loaded state, expected loaded');
  });

  it('returns worker when task has assignedWorkerId', async () => {
    h.setupMoeFolder();
    h.createEpic();
    h.createWorker({
      id: 'worker-ctx',
      status: 'CODING',
      lastError: 'prev error',
      errorCount: 2,
      chatCursors: { 'chan-heavy': 'msg-heavy' },
    });
    h.createTask({ assignedWorkerId: 'worker-ctx' });
    await h.state.load();
    const tool = getContextTool(h.state);
    const result = await tool.handler({ taskId: 'task-1' }, h.state) as {
      worker: {
        id: string;
        status: string;
        lastError: string | null;
        errorCount: number;
        chatCursors?: unknown;
        branch?: unknown;
        modifiedFiles?: unknown;
      } | null;
    };

    expect(result.worker).not.toBeNull();
    expect(result.worker!.id).toBe('worker-ctx');
    expect(result.worker!.status).toBe('CODING');
    expect(result.worker!.lastError).toBe('prev error');
    expect(result.worker!.errorCount).toBe(2);
    expect(result.worker!.chatCursors).toBeUndefined();
    expect(result.worker!.branch).toBeUndefined();
    expect(result.worker!.modifiedFiles).toBeUndefined();
  });

  it('returns null worker when task has no assignedWorkerId', async () => {
    h.setupMoeFolder();
    h.createEpic();
    h.createTask({ assignedWorkerId: null });
    await h.state.load();
    const tool = getContextTool(h.state);
    const result = await tool.handler({ taskId: 'task-1' }, h.state) as { worker: null };

    expect(result.worker).toBeNull();
  });

  it('returns null worker when no task provided', async () => {
    h.setupMoeFolder();
    await h.state.load();
    const tool = getContextTool(h.state);
    const result = await tool.handler({}, h.state) as { worker: null };

    expect(result.worker).toBeNull();
  });

  it('records contextFetchedBy when workerId provided and task is claimed', async () => {
    h.setupMoeFolder();
    h.createEpic();
    h.createTask({ assignedWorkerId: 'worker-ctx' });
    await h.state.load();
    const tool = getContextTool(h.state);

    await tool.handler({ taskId: 'task-1', workerId: 'worker-ctx' }, h.state);
    expect(h.state.getTask('task-1')?.contextFetchedBy).toEqual(['worker-ctx']);

    // Duplicate call does not produce duplicate entries
    await tool.handler({ taskId: 'task-1', workerId: 'worker-ctx' }, h.state);
    expect(h.state.getTask('task-1')?.contextFetchedBy).toEqual(['worker-ctx']);

    // Different worker is appended
    await tool.handler({ taskId: 'task-1', workerId: 'worker-qa' }, h.state);
    expect(h.state.getTask('task-1')?.contextFetchedBy).toEqual(['worker-ctx', 'worker-qa']);
  });

  it('does not record contextFetchedBy when workerId is missing', async () => {
    const prev = process.env.MOE_WORKER_ID;
    delete process.env.MOE_WORKER_ID;
    try {
      h.setupMoeFolder();
      h.createEpic();
      h.createTask({ assignedWorkerId: 'worker-ctx' });
      await h.state.load();
      const tool = getContextTool(h.state);
      await tool.handler({ taskId: 'task-1' }, h.state);
      expect(h.state.getTask('task-1')?.contextFetchedBy).toBeUndefined();
    } finally {
      if (prev === undefined) delete process.env.MOE_WORKER_ID;
      else process.env.MOE_WORKER_ID = prev;
    }
  });

  it('returns step notes in implementationPlan', async () => {
    h.setupMoeFolder();
    h.createEpic();
    h.createTask({
      implementationPlan: [
        { stepId: 'step-1', description: 'First', status: 'COMPLETED', affectedFiles: ['a.ts'], note: 'Design decision: used factory pattern', modifiedFiles: ['a.ts', 'b.ts'] },
        { stepId: 'step-2', description: 'Second', status: 'PENDING', affectedFiles: [] },
      ],
    });
    await h.state.load();
    const tool = getContextTool(h.state);
    const result = await tool.handler({ taskId: 'task-1' }, h.state) as {
      task: { implementationPlan: Array<{ stepId: string; note?: string; modifiedFiles?: string[] }> };
    };

    const step1 = result.task.implementationPlan.find(s => s.stepId === 'step-1');
    expect(step1?.note).toBe('Design decision: used factory pattern');
    expect(step1?.modifiedFiles).toEqual(['a.ts', 'b.ts']);
  });

  it('does not auto-inject recent chat by default', async () => {
    h.setupMoeFolder();
    h.createEpic();
    h.createTask();
    await h.state.load();
    const general = h.state.getChannels().find((channel) => channel.name === 'general');
    expect(general).toBeDefined();
    await h.state.sendMessage({
      channel: general!.id,
      sender: 'human',
      content: 'Long general chat message '.repeat(80),
    });

    const tool = getContextTool(h.state);
    const result = await tool.handler({ taskId: 'task-1' }, h.state) as {
      chat?: { recentMessages: unknown[] };
    };

    expect(result.chat?.recentMessages ?? []).toEqual([]);
  });

  it('keeps task comments compact in get_context and exposes summary metadata', async () => {
    h.setupMoeFolder();
    h.createEpic();
    h.createTask({
      comments: [
        { id: 'c1', author: 'human', content: 'old comment', timestamp: '2024-01-01T00:00:00Z' },
        { id: 'c2', author: 'human', content: 'A'.repeat(1200), timestamp: '2024-01-01T00:01:00Z' },
        { id: 'c3', author: 'worker-1', content: 'latest comment', timestamp: '2024-01-01T00:02:00Z' },
      ],
    });
    await h.state.load();
    const tool = getContextTool(h.state);

    const compact = await tool.handler({
      taskId: 'task-1',
      commentsLimit: 2,
      commentsMaxChars: 100,
    }, h.state) as {
      task: {
        comments: Array<{
          id: string;
          content: string;
          contentTruncated?: boolean;
          contentOriginalLength?: number;
        }>;
        commentSummary: { total: number; returned: number; omitted: number; truncated: number };
      };
    };

    expect(compact.task.comments.map(comment => comment.id)).toEqual(['c2', 'c3']);
    expect(compact.task.comments[0].content.length).toBeLessThanOrEqual(100);
    expect(compact.task.comments[0].contentTruncated).toBe(true);
    expect(compact.task.comments[0].contentOriginalLength).toBe(1200);
    expect(compact.task.commentSummary).toMatchObject({
      total: 3,
      returned: 2,
      omitted: 1,
      truncated: 1,
    });

    const fullComment = await tool.handler({
      taskId: 'task-1',
      commentsLimit: 1,
      commentsMaxChars: 0,
    }, h.state) as { task: { comments: Array<{ content: string; contentTruncated?: boolean }> } };
    expect(fullComment.task.comments[0].content).toBe('latest comment');
    expect(fullComment.task.comments[0].contentTruncated).toBeUndefined();
  });
});

