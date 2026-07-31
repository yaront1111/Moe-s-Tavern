import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ToolTestHarness } from './toolTestHarness.js';
import { addCommentTool } from './addComment.js';
import { getPendingQuestionsTool } from './getPendingQuestions.js';

describe('moe.get_pending_questions', () => {
  const h = new ToolTestHarness();
  beforeEach(() => h.init());
  afterEach(() => { vi.restoreAllMocks(); h.cleanup(); });

  it('returns empty when no tasks have pending questions', async () => {
    h.setupMoeFolder();
    h.createEpic();
    h.createTask({ id: 'task-1', comments: [] });
    await h.state.load();

    const tool = getPendingQuestionsTool(h.state);
    const result = await tool.handler({}, h.state) as { count: number; tasks: unknown[] };
    expect(result.count).toBe(0);
    expect(result.tasks).toHaveLength(0);
  });

  it('returns task after human comment sets hasPendingQuestion', async () => {
    h.setupMoeFolder();
    h.createEpic();
    h.createTask({
      id: 'task-1',
      hasPendingQuestion: true,
      comments: [
        { id: 'c1', author: 'human', content: 'How should I test this?', timestamp: new Date().toISOString() }
      ]
    });
    await h.state.load();

    const tool = getPendingQuestionsTool(h.state);
    const result = await tool.handler({}, h.state) as {
      count: number;
      tasks: Array<{ taskId: string; questions: Array<{ content: string }> }>;
    };
    expect(result.count).toBe(1);
    expect(result.tasks[0].taskId).toBe('task-1');
    expect(result.tasks[0].questions).toHaveLength(1);
    expect(result.tasks[0].questions[0].content).toBe('How should I test this?');
  });

  it('returns multiple unanswered questions on same task', async () => {
    h.setupMoeFolder();
    h.createEpic();
    h.createTask({
      id: 'task-1',
      hasPendingQuestion: true,
      comments: [
        { id: 'c1', author: 'human', content: 'Question 1?', timestamp: new Date().toISOString() },
        { id: 'c2', author: 'human', content: 'Question 2?', timestamp: new Date().toISOString() }
      ]
    });
    await h.state.load();

    const tool = getPendingQuestionsTool(h.state);
    const result = await tool.handler({}, h.state) as {
      count: number;
      tasks: Array<{ questions: Array<{ content: string }> }>;
    };
    expect(result.count).toBe(1);
    expect(result.tasks[0].questions).toHaveLength(2);
  });

  it('only returns questions after last agent response', async () => {
    h.setupMoeFolder();
    h.createEpic();
    h.createTask({
      id: 'task-1',
      hasPendingQuestion: true,
      comments: [
        { id: 'c1', author: 'human', content: 'Old question', timestamp: '2024-01-01T00:00:00Z' },
        { id: 'c2', author: 'worker-1', content: 'Answer to old question', timestamp: '2024-01-01T00:01:00Z' },
        { id: 'c3', author: 'human', content: 'New question?', timestamp: '2024-01-01T00:02:00Z' }
      ]
    });
    await h.state.load();

    const tool = getPendingQuestionsTool(h.state);
    const result = await tool.handler({}, h.state) as {
      count: number;
      tasks: Array<{ questions: Array<{ content: string }> }>;
    };
    expect(result.count).toBe(1);
    expect(result.tasks[0].questions).toHaveLength(1);
    expect(result.tasks[0].questions[0].content).toBe('New question?');
  });

  it('add_comment clears the hasPendingQuestion flag', async () => {
    h.setupMoeFolder();
    h.createEpic();
    h.createTask({
      id: 'task-1',
      hasPendingQuestion: true,
      comments: [
        { id: 'c1', author: 'human', content: 'A question?', timestamp: new Date().toISOString() }
      ]
    });
    await h.state.load();

    const commentTool = addCommentTool(h.state);
    await commentTool.handler({ taskId: 'task-1', content: 'Q: A question?\nA: Here is the answer.', workerId: 'worker-1' }, h.state);

    const task = h.state.getTask('task-1')!;
    expect(task.hasPendingQuestion).toBe(false);
  });

  it('filters by epicId', async () => {
    h.setupMoeFolder();
    h.createEpic({ id: 'epic-1' });
    h.createEpic({ id: 'epic-2', title: 'Other Epic' });
    h.createTask({
      id: 'task-1',
      epicId: 'epic-1',
      hasPendingQuestion: true,
      comments: [{ id: 'c1', author: 'human', content: 'Q1?', timestamp: new Date().toISOString() }]
    });
    h.createTask({
      id: 'task-2',
      epicId: 'epic-2',
      hasPendingQuestion: true,
      comments: [{ id: 'c2', author: 'human', content: 'Q2?', timestamp: new Date().toISOString() }]
    });
    await h.state.load();

    const tool = getPendingQuestionsTool(h.state);
    const result = await tool.handler({ epicId: 'epic-1' }, h.state) as {
      count: number;
      tasks: Array<{ taskId: string }>;
    };
    expect(result.count).toBe(1);
    expect(result.tasks[0].taskId).toBe('task-1');
  });

  it('limits and truncates pending-question payloads by default with full-content opt-in', async () => {
    h.setupMoeFolder();
    h.createEpic({ id: 'epic-1' });
    h.createTask({
      id: 'task-1',
      order: 1,
      hasPendingQuestion: true,
      comments: [
        { id: 'c1', author: 'human', content: 'A'.repeat(1200), timestamp: '2024-01-01T00:00:00Z' },
        { id: 'c2', author: 'human', content: 'B'.repeat(1200), timestamp: '2024-01-01T00:01:00Z' },
      ],
    });
    h.createTask({
      id: 'task-2',
      order: 2,
      hasPendingQuestion: true,
      comments: [
        { id: 'c3', author: 'human', content: 'C'.repeat(1200), timestamp: '2024-01-01T00:02:00Z' },
      ],
    });
    await h.state.load();

    const tool = getPendingQuestionsTool(h.state);
    const compact = await tool.handler({
      limit: 1,
      maxQuestionsPerTask: 1,
      maxContentChars: 100,
    }, h.state) as {
      count: number;
      totalMatches: number;
      tasks: Array<{
        taskId: string;
        questions: Array<{ content: string; contentTruncated?: boolean; contentOriginalLength?: number }>;
        totalQuestions: number;
        omittedQuestions: number;
      }>;
      pagination: { hasMore: boolean };
      truncatedQuestions: number;
      hint?: string;
    };

    expect(compact.count).toBe(1);
    expect(compact.totalMatches).toBe(2);
    expect(compact.tasks[0].taskId).toBe('task-1');
    expect(compact.tasks[0].questions).toHaveLength(1);
    expect(compact.tasks[0].questions[0].content.length).toBeLessThanOrEqual(100);
    expect(compact.tasks[0].questions[0].contentTruncated).toBe(true);
    expect(compact.tasks[0].questions[0].contentOriginalLength).toBe(1200);
    expect(compact.tasks[0].totalQuestions).toBe(2);
    expect(compact.tasks[0].omittedQuestions).toBe(1);
    expect(compact.pagination.hasMore).toBe(true);
    expect(compact.truncatedQuestions).toBe(1);
    expect(compact.hint).toContain('compact');

    const fullQuestion = await tool.handler({
      limit: 1,
      maxQuestionsPerTask: 1,
      maxContentChars: 0,
    }, h.state) as { tasks: Array<{ questions: Array<{ content: string; contentTruncated?: boolean }> }> };
    expect(fullQuestion.tasks[0].questions[0].content).toHaveLength(1200);
    expect(fullQuestion.tasks[0].questions[0].contentTruncated).toBeUndefined();
  });
});

