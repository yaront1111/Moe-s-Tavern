import { describe, expect, it } from 'vitest';
import type { StateManager } from '../state/StateManager.js';
import { normalizeActivityLogParams, queryActivityLog } from './getActivityLog.js';
import { getPendingQuestionsTool } from './getPendingQuestions.js';

// M5: filtered activity-log pagination must terminate. `hasMore` has to be
// filter-AWARE — folding in the filter-unaware `hasMoreOlderLines` made
// filtered pages report hasMore:true forever on logs longer than the scan
// limit. We model that by mocking getActivityLogWindow to report more raw
// lines (hasMoreOlderLines:true) than the filter actually matches.
describe('M5: getActivityLog filtered pagination terminates', () => {
  function mockState(events: unknown[], hasMoreOlderLines: boolean): StateManager {
    return {
      getActivityLogWindow: () => ({
        events,
        linesRead: 5000,
        hasMoreOlderLines,
      }),
    } as unknown as StateManager;
  }

  function makeEvent(taskId: string) {
    return { event: 'STEP_COMPLETED', taskId, epicId: 'epic-1', workerId: 'w-1', payload: {} };
  }

  it('reports hasMore:false once all matching events fit in the window', () => {
    // 3 matching events, limit 10 → no more matching events beyond the window,
    // even though the raw log has been truncated (hasMoreOlderLines:true).
    const events = [makeEvent('t-1'), makeEvent('t-1'), makeEvent('t-1')];
    const result = queryActivityLog(
      mockState(events, true),
      normalizeActivityLogParams({ taskId: 't-1', limit: 10, offset: 0 })
    );

    expect(result.count).toBe(3);
    expect(result.hasMore).toBe(false);
    expect(result.pagination.hasMore).toBe(false);
    // Truncation is still surfaced via the search metadata, not hasMore.
    expect(result.search.complete).toBe(false);
  });

  it('still reports hasMore:true when more matching events exist beyond the window', () => {
    const events = Array.from({ length: 12 }, () => makeEvent('t-1'));
    const result = queryActivityLog(
      mockState(events, true),
      normalizeActivityLogParams({ taskId: 't-1', limit: 10, offset: 0 })
    );

    expect(result.count).toBe(10);
    expect(result.hasMore).toBe(true);
  });

  it('reports hasMore:false on the last filtered page even with raw truncation', () => {
    const events = Array.from({ length: 12 }, () => makeEvent('t-1'));
    const result = queryActivityLog(
      mockState(events, true),
      normalizeActivityLogParams({ taskId: 't-1', limit: 10, offset: 10 })
    );

    // Page 2 returns the trailing 2 events and must terminate.
    expect(result.count).toBe(2);
    expect(result.hasMore).toBe(false);
  });
});

// L12: get_pending_questions must not surface ARCHIVED tasks by default —
// archiving a task does not clear hasPendingQuestion, so shelved tickets would
// otherwise leak into agent context.
describe('L12: getPendingQuestions excludes ARCHIVED by default', () => {
  function makeTask(id: string, status: string, order: number) {
    return {
      id,
      title: `Task ${id}`,
      status,
      epicId: 'epic-1',
      order,
      assignedWorkerId: null,
      hasPendingQuestion: true,
      comments: [
        { id: `${id}-c1`, author: 'human', content: 'Which approach?', timestamp: '2026-06-29T00:00:00.000Z' },
      ],
    };
  }

  function mockState() {
    return {
      tasks: new Map<string, unknown>([
        ['t-active', makeTask('t-active', 'WORKING', 0)],
        ['t-archived', makeTask('t-archived', 'ARCHIVED', 1)],
      ]),
    } as unknown as StateManager;
  }

  it('omits ARCHIVED tasks when includeArchived is not set', async () => {
    const state = mockState();
    const tool = getPendingQuestionsTool(state);
    const result = (await tool.handler({}, state)) as {
      tasks: Array<{ taskId: string }>;
      totalMatches: number;
    };

    expect(result.tasks.map((t) => t.taskId)).toEqual(['t-active']);
    expect(result.totalMatches).toBe(1);
  });

  it('includes ARCHIVED tasks when includeArchived:true', async () => {
    const state = mockState();
    const tool = getPendingQuestionsTool(state);
    const result = (await tool.handler({ includeArchived: true }, state)) as {
      tasks: Array<{ taskId: string }>;
      totalMatches: number;
    };

    expect(result.tasks.map((t) => t.taskId).sort()).toEqual(['t-active', 't-archived']);
    expect(result.totalMatches).toBe(2);
  });
});
