// A comment the daemon writes itself (author 'moe-daemon': landing notes,
// repair diagnostics) is not an answer, so a human question followed only by
// one stays pending on both surfaces, get_pending_questions and wait_for_task
// (task-c8618ccd; hunt 11-03 #11 repro zzHuntB_pendingMasked, ported as (p1)).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ToolTestHarness } from './toolTestHarness.js';
import { getPendingQuestionsTool } from './getPendingQuestions.js';
import { activeWaiters, waitForTaskTool } from './waitForTask.js';
import type { TaskComment } from '../types/schema.js';

const comment = (id: string, author: string, minute: number): TaskComment => ({
  id,
  author,
  content: `${author} wrote ${id}`,
  timestamp: `2026-11-03T10:${String(minute).padStart(2, '0')}:00.000Z`,
});

describe('pending questions skip daemon-authored comments', () => {
  const h = new ToolTestHarness();
  beforeEach(() => h.init());
  afterEach(() => {
    for (const waiter of activeWaiters.values()) clearTimeout(waiter.timer);
    activeWaiters.clear();
    h.cleanup();
  });

  async function load(comments: TaskComment[]): Promise<void> {
    h.setupMoeFolder();
    h.createEpic();
    h.createTask({
      id: 'task-q', status: 'WORKING', assignedWorkerId: 'worker-other', hasPendingQuestion: true, comments,
    } as never);
    h.createWorker({ id: 'worker-1' });
    h.createWorker({ id: 'worker-other' });
    await h.state.load();
  }
  const pending = async () => (await getPendingQuestionsTool(h.state).handler({}, h.state)) as {
    totalMatches: number;
    tasks: Array<{ taskId: string; questions: Array<{ commentId: string }> }>;
  };
  // Nothing is in REVIEW, so wait_for_task either answers at once with the
  // pending question or parks for its 1000 ms floor and times out.
  const waitOnReview = async () => (await waitForTaskTool(h.state).handler(
    { statuses: ['REVIEW'], workerId: 'worker-1', timeoutMs: 1000 }, h.state,
  )) as Record<string, unknown>;

  it('(p1) get_pending_questions still surfaces a human question followed only by a moe-daemon comment', async () => {
    await load([comment('c1', 'human', 0), comment('c2', 'moe-daemon', 5)]);
    const res = await pending();
    expect(res.totalMatches).toBe(1);
    expect(res.tasks[0].questions.map((q) => q.commentId)).toEqual(['c1']);
  });

  it('(p2) wait_for_task surfaces the same question', async () => {
    await load([comment('c1', 'human', 0), comment('c2', 'moe-daemon', 5)]);
    const res = await waitOnReview();
    expect(res.hasPendingQuestion).toBe(true);
    expect(res.taskId).toBe('task-q');
  });

  it('(p3) a real agent comment still answers it, even with a daemon comment after the answer', async () => {
    await load([comment('c1', 'human', 0), comment('c2', 'worker-other', 2), comment('c3', 'moe-daemon', 5)]);
    expect((await pending()).totalMatches).toBe(0);
    const res = await waitOnReview();
    expect(res.hasPendingQuestion).toBeUndefined();
    expect(res.timedOut).toBe(true);
  });

  it('(p4) a daemon comment neither ends nor joins the unanswered run', async () => {
    await load([
      comment('c1', 'human', 0),
      comment('c2', 'worker-other', 1),
      comment('c3', 'human', 2),
      comment('c4', 'moe-daemon', 3),
      comment('c5', 'human', 4),
    ]);
    const res = await pending();
    expect(res.tasks[0].questions.map((q) => q.commentId)).toEqual(['c3', 'c5']);
  });
});
