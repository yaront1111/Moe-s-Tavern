import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ToolTestHarness } from './toolTestHarness.js';
import { listMetricsTool } from './listMetrics.js';

// Ported from the 11-03 hunt repro (task-afe61cc0, zzHuntB_metricsArchived.test.ts)
// for task-83cf11f5. Archiving a delivered task (the IDE's Done-column Clear) kept it
// in avgWallClockMs but dropped it from doneCount and firstPassApprovalPct.
describe('list_metrics counts a delivered-then-archived task as completed', () => {
  const h = new ToolTestHarness();
  beforeEach(() => h.init());
  afterEach(() => h.cleanup());

  type Aggregate = { taskCount: number; doneCount: number; avgWallClockMs: number; firstPassApprovalPct: number };
  const t0 = '2026-11-01T10:00:00.000Z';
  const delivered = { firstClaimAt: t0, doneAt: '2026-11-01T10:00:01.000Z', wallClockMs: 1000, rejectCount: 0 };

  async function aggregate(): Promise<Aggregate> {
    await h.state.load();
    const res = await listMetricsTool(h.state).handler({}, h.state) as { aggregate: Aggregate };
    return res.aggregate;
  }

  it('(p1) counts a delivered-then-archived task consistently across doneCount, firstPass% and avgWallClockMs', async () => {
    h.setupMoeFolder();
    h.createEpic();
    h.createTask({ id: 'task-done', status: 'DONE', order: 1, metrics: delivered });
    h.createTask({ id: 'task-archived', status: 'ARCHIVED', order: 2,
      metrics: { firstClaimAt: t0, doneAt: '2026-11-01T10:00:09.000Z', wallClockMs: 9000, rejectCount: 0 } });
    expect(await aggregate()).toMatchObject({ taskCount: 2, doneCount: 2, avgWallClockMs: 5000, firstPassApprovalPct: 100 });
  });

  it('(p2) a shelved ARCHIVED task that never reached DONE counts in none of them', async () => {
    h.setupMoeFolder();
    h.createEpic();
    h.createTask({ id: 'task-done', status: 'DONE', order: 1, metrics: delivered });
    h.createTask({ id: 'task-shelved', status: 'ARCHIVED', order: 2, metrics: { firstClaimAt: t0, rejectCount: 2 } });
    expect(await aggregate()).toMatchObject({ taskCount: 2, doneCount: 1, avgWallClockMs: 1000, firstPassApprovalPct: 100 });
  });
});
