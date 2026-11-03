import { describe, it, expect } from 'vitest';
import { computeMetricsAggregate, computeDashboardAggregate, filterTasksForMetrics } from './metrics.js';
import type { Task } from '../types/schema.js';

// Pins the wire unit of firstPassApprovalPct: an integer percentage on 0..100.
// Both IDE clients render it as-is, so a drift to a 0..1 ratio (or to 0..10000)
// here silently breaks every dashboard. Only the fields metrics.ts reads are
// populated; the rest of Task is deliberately absent.
const CREATED_AT = '2026-09-10T00:00:00.000Z';
const UPDATED_AT = '2026-09-10T01:00:00.000Z';

function task(id: string, status: string, rejectCount: number): Task {
  return {
    id,
    epicId: 'epic-metrics-fixture',
    title: `fixture ${id}`,
    status,
    createdAt: CREATED_AT,
    updatedAt: UPDATED_AT,
    metrics: { rejectCount },
  } as unknown as Task;
}

const epicTitle = (): string => 'Metrics fixture epic';

describe('computeMetricsAggregate firstPassApprovalPct unit', () => {
  it('reports one first-pass approval out of two DONE tasks as exactly 50', () => {
    const aggregate = computeMetricsAggregate([
      task('task-first-pass', 'DONE', 0),
      task('task-reopened', 'DONE', 1),
    ]);

    expect(aggregate.firstPassApprovalPct).toBe(50);
    expect(aggregate.firstPassApprovalPct).toBeGreaterThanOrEqual(0);
    expect(aggregate.firstPassApprovalPct).toBeLessThanOrEqual(100);
    expect(aggregate.doneCount).toBe(2);
  });

  it('reports zero first-pass approvals out of two DONE tasks as exactly 0', () => {
    const aggregate = computeMetricsAggregate([
      task('task-reopened-a', 'DONE', 1),
      task('task-reopened-b', 'DONE', 3),
    ]);

    expect(aggregate.firstPassApprovalPct).toBe(0);
    expect(aggregate.doneCount).toBe(2);
  });

  it('reports two first-pass approvals out of two DONE tasks as exactly 100', () => {
    const aggregate = computeMetricsAggregate([
      task('task-clean-a', 'DONE', 0),
      task('task-clean-b', 'DONE', 0),
    ]);

    expect(aggregate.firstPassApprovalPct).toBe(100);
    expect(aggregate.doneCount).toBe(2);
  });

  it('keeps a rejected in-flight task out of the approval denominator', () => {
    const aggregate = computeMetricsAggregate([
      task('task-first-pass', 'DONE', 0),
      task('task-reopened', 'DONE', 1),
      task('task-still-working', 'WORKING', 2),
    ]);

    expect(aggregate.firstPassApprovalPct).toBe(50);
    expect(aggregate.doneCount).toBe(2);
    expect(aggregate.taskCount).toBe(3);
  });

  it('reports 0 rather than a ratio when nothing is DONE yet', () => {
    const aggregate = computeMetricsAggregate([task('task-still-working', 'WORKING', 1)]);

    expect(aggregate.firstPassApprovalPct).toBe(0);
    expect(aggregate.doneCount).toBe(0);
  });
});

describe('computeDashboardAggregate firstPassApprovalPct unit', () => {
  it('passes the 0..100 value through unscaled', () => {
    const dashboard = computeDashboardAggregate(
      [task('task-first-pass', 'DONE', 0), task('task-reopened', 'DONE', 1)],
      epicTitle
    );

    expect(dashboard.firstPassApprovalPct).toBe(50);
    expect(dashboard.totalCompleted).toBe(2);
  });

  it('omits the field entirely when nothing is DONE, so the IDE can show its empty state', () => {
    const tasks = [task('task-still-working', 'WORKING', 1)];
    const dashboard = computeDashboardAggregate(tasks, epicTitle);

    // The raw aggregate zeroes it; the dashboard deliberately drops it instead,
    // which is what makes "missing" visually distinct from a real 0% in the IDEs.
    expect(computeMetricsAggregate(tasks).firstPassApprovalPct).toBe(0);
    expect(dashboard.firstPassApprovalPct).toBeUndefined();
    expect(Object.keys(JSON.parse(JSON.stringify(dashboard)))).not.toContain('firstPassApprovalPct');
  });
});

// list_metrics / GET_METRICS sinceIso keeps "tasks last touched at/after this
// time" (task-5d739855): a finished row keys on doneAt, every other row on
// updatedAt. Fixed stamps: filterTasksForMetrics never reads the clock.
describe('filterTasksForMetrics sinceIso window', () => {
  const NOW_MS = Date.parse('2026-11-03T20:00:00.000Z');
  const hoursAgo = (hours: number): string => new Date(NOW_MS - hours * 3_600_000).toISOString();
  const SINCE = hoursAgo(24);

  function row(id: string, status: string, stamps: {
    createdAt: string; updatedAt?: string; firstClaimAt?: string; doneAt?: string;
  }): Task {
    const metrics: Record<string, string> = {};
    if (stamps.firstClaimAt) metrics.firstClaimAt = stamps.firstClaimAt;
    if (stamps.doneAt) metrics.doneAt = stamps.doneAt;
    return {
      id,
      epicId: 'epic-metrics-fixture',
      title: `fixture ${id}`,
      status,
      createdAt: stamps.createdAt,
      updatedAt: stamps.updatedAt,
      metrics,
    } as unknown as Task;
  }
  const kept = (...tasks: Task[]): string[] =>
    filterTasksForMetrics(tasks, { sinceIso: SINCE }).map((t) => t.id);

  it('(w1) keeps WORKING, REVIEW and BLOCKED rows first claimed 48 h ago but touched 1 h ago', () => {
    const stamps = { createdAt: hoursAgo(72), firstClaimAt: hoursAgo(48), updatedAt: hoursAgo(1) };
    expect(kept(
      row('task-working', 'WORKING', stamps),
      row('task-review', 'REVIEW', stamps),
      row('task-blocked', 'BLOCKED', stamps),
    )).toEqual(['task-working', 'task-review', 'task-blocked']);
  });

  it('(w2) leaves out a DONE row done 48 h ago, although it was touched 1 h ago', () => {
    expect(kept(row('task-done-old', 'DONE', {
      createdAt: hoursAgo(72), firstClaimAt: hoursAgo(60), doneAt: hoursAgo(48), updatedAt: hoursAgo(1),
    }))).toEqual([]);
  });

  it('(w3) leaves out a row whose every stamp is 48 h old', () => {
    expect(kept(row('task-stale', 'WORKING', {
      createdAt: hoursAgo(48), firstClaimAt: hoursAgo(48), updatedAt: hoursAgo(48),
    }))).toEqual([]);
  });

  it('(w4) keeps a DONE row done 1 h ago; a legacy row without updatedAt falls back to firstClaimAt, then createdAt', () => {
    expect(kept(
      row('task-done-new', 'DONE', {
        createdAt: hoursAgo(72), firstClaimAt: hoursAgo(60), doneAt: hoursAgo(1), updatedAt: hoursAgo(1),
      }),
      row('task-legacy-claimed', 'WORKING', { createdAt: hoursAgo(72), firstClaimAt: hoursAgo(1) }),
      row('task-legacy-unclaimed', 'BACKLOG', { createdAt: hoursAgo(48) }),
    )).toEqual(['task-done-new', 'task-legacy-claimed']);
  });
});

// Completed means delivered (task-83cf11f5): a DONE row, or an ARCHIVED row that
// reached DONE (qa_approve stamped metrics.doneAt and archiving keeps it). doneCount,
// firstPassApprovalPct, avgWallClockMs and the dashboard's totalCompleted, per-epic
// completed and per-epic avgWallClockMs all count that one set. A shelved ARCHIVED row
// and an in-flight row count in none of them, even with a stale wallClockMs.
describe('delivered set: DONE plus ARCHIVED rows that reached DONE', () => {
  function row(id: string, status: string, epicId: string, metrics: Record<string, unknown>): Task {
    return { id, epicId, title: `fixture ${id}`, status, createdAt: CREATED_AT, updatedAt: UPDATED_AT, metrics } as unknown as Task;
  }
  const DONE_AT = '2026-09-10T00:30:00.000Z';
  const done = row('task-done', 'DONE', 'epic-a', { doneAt: DONE_AT, wallClockMs: 1000, rejectCount: 0 });
  const archivedDone = row('task-archived-done', 'ARCHIVED', 'epic-a', { doneAt: DONE_AT, wallClockMs: 9000, rejectCount: 1 });
  const shelved = row('task-shelved', 'ARCHIVED', 'epic-b', { wallClockMs: 99000, rejectCount: 0 });
  const working = row('task-working', 'WORKING', 'epic-b', { wallClockMs: 50000, rejectCount: 0 });

  it('(d1) doneCount, firstPassApprovalPct and avgWallClockMs count DONE plus archived-after-DONE rows only', () => {
    expect(computeMetricsAggregate([done, archivedDone, shelved, working])).toMatchObject({
      taskCount: 4, doneCount: 2, firstPassApprovalPct: 50, avgWallClockMs: 5000,
    });
  });

  it('(d2) the dashboard totalCompleted and the per-epic completed and avgWallClockMs use the same set', () => {
    const dashboard = computeDashboardAggregate([done, archivedDone, shelved, working], epicTitle);
    expect(dashboard).toMatchObject({ totalCompleted: 2, firstPassApprovalPct: 50, avgWallClockMs: 5000 });
    expect(dashboard.perEpic).toEqual([
      { epicId: 'epic-a', epicTitle: 'Metrics fixture epic', completed: 2, avgReopenCount: 0, avgWallClockMs: 5000 },
      { epicId: 'epic-b', epicTitle: 'Metrics fixture epic', completed: 0, avgReopenCount: 0, avgWallClockMs: undefined },
    ]);
  });

  it('(d3) an ARCHIVED row counts only when its doneAt is a non-blank string', () => {
    expect(computeMetricsAggregate([
      row('task-a', 'ARCHIVED', 'epic-a', { doneAt: DONE_AT }),
      row('task-b', 'ARCHIVED', 'epic-a', { doneAt: '' }),
      row('task-c', 'ARCHIVED', 'epic-a', { doneAt: '  ' }),
      row('task-d', 'ARCHIVED', 'epic-a', { doneAt: 1234 }),
    ]).doneCount).toBe(1);
  });

  it('(d4) only shelved rows: nothing is completed and the dashboard keeps its empty state', () => {
    expect(computeMetricsAggregate([shelved])).toMatchObject({ doneCount: 0, firstPassApprovalPct: 0, avgWallClockMs: 0 });
    const dashboard = computeDashboardAggregate([shelved], epicTitle);
    expect(dashboard.totalCompleted).toBe(0);
    expect(dashboard.firstPassApprovalPct).toBeUndefined();
    expect(dashboard.avgWallClockMs).toBeUndefined();
  });
});
