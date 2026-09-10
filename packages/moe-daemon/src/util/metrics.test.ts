import { describe, it, expect } from 'vitest';
import { computeMetricsAggregate, computeDashboardAggregate } from './metrics.js';
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
