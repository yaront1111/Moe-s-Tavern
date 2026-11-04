import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { createServer } from 'http';
import WebSocket from 'ws';
import { ToolTestHarness } from './toolTestHarness.js';
import { listMetricsTool } from './listMetrics.js';
import { setTaskStatusTool } from './setTaskStatus.js';
import { MoeWebSocketServer } from '../server/WebSocketServer.js';
import { McpAdapter } from '../server/McpAdapter.js';
import { buildReopenClearingUpdates } from '../util/reopen.js';
import type { TaskMetrics } from '../types/schema.js';

/**
 * task-fc10f071: only qa_reject kept metrics.reopenCount in step with
 * task.reopenCount. The three non-QA reopen paths (set_task_status,
 * StateManager.reopenTask, the /ws board drag) bump task.reopenCount only, and
 * list_metrics plus both IDE Reopens KPIs read the mirror first, so a row
 * reopened after a QA reject under-counted.
 *
 * Fix: buildReopenClearingUpdates (util/reopen.ts) keeps the mirror at
 * task.reopenCount + 1, and util/metrics.ts reads the canonical task.reopenCount.
 *
 * Hunt repro: /mnt/d/moe-scratch/hunt-1c736204/B/zzHuntB_metricsReopenStale.test.ts
 */
describe('metrics.reopenCount stays in step on a non-QA reopen', () => {
  const h = new ToolTestHarness();
  beforeEach(() => h.init());
  afterEach(() => h.cleanup());

  type Res = {
    aggregate: { avgReopenCount: number };
    tasks: Array<{ taskId: string; metrics: { reopenCount?: number } }>;
  };
  const t0 = '2026-11-01T10:00:00.000Z';
  // A DONE row as one qa_reject then qa_approve leave it.
  const afterOneReject = {
    reopenCount: 1,
    metrics: {
      firstClaimAt: t0,
      doneAt: '2026-11-01T11:00:00.000Z',
      wallClockMs: 3600000,
      rejectCount: 1,
      reopenCount: 1,
    },
  };
  const listMetrics = async (): Promise<Res> =>
    (await listMetricsTool(h.state).handler({}, h.state)) as Res;

  async function seed(overrides: Record<string, unknown> = {}): Promise<void> {
    h.setupMoeFolder();
    h.createEpic();
    h.createTask({ id: 'task-x', status: 'DONE', ...afterOneReject, ...overrides });
    await h.state.load();
  }

  async function expectReopenedTwice(): Promise<void> {
    const stored = h.state.getTask('task-x')!;
    expect(stored.reopenCount).toBe(2);
    expect(stored.metrics?.reopenCount).toBe(2);
    const res = await listMetrics();
    expect(res.aggregate.avgReopenCount).toBe(2);
    expect(res.tasks[0].metrics.reopenCount).toBe(2);
  }

  it('R1 set_task_status DONE -> WORKING', async () => {
    await seed();
    await setTaskStatusTool(h.state).handler(
      { taskId: 'task-x', status: 'WORKING', reason: 'human reopen' },
      h.state,
    );
    await expectReopenedTwice();
  });

  it('R2 StateManager.reopenTask', async () => {
    await seed();
    await h.state.reopenTask('task-x', 'board reopen');
    await expectReopenedTwice();
  });

  it('R3 /ws UPDATE_TASK drag DONE -> WORKING', async () => {
    await seed();
    const httpServer = createServer();
    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', () => resolve()));
    const address = httpServer.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const wss = new MoeWebSocketServer(httpServer, h.state, new McpAdapter(h.state));
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const frames: Array<{ type: string; message?: string }> = [];
    ws.on('message', (data) => frames.push(JSON.parse(data.toString())));
    const until = async (pred: () => boolean): Promise<void> => {
      for (const end = Date.now() + 5000; Date.now() < end; await new Promise((r) => setTimeout(r, 20))) {
        if (pred()) return;
      }
      throw new Error(`timed out; frames: ${frames.map((f) => f.type).join(',')}`);
    };
    try {
      await until(() => frames.some((f) => f.type === 'STATE_SNAPSHOT'));
      ws.send(
        JSON.stringify({
          type: 'UPDATE_TASK',
          payload: { taskId: 'task-x', updates: { status: 'WORKING' } },
        }),
      );
      await until(() => frames.some((f) => f.type === 'TASK_UPDATED' || f.type === 'ERROR'));
      expect(frames.filter((f) => f.type === 'ERROR')).toEqual([]);
      await expectReopenedTwice();
    } finally {
      ws.close();
      await wss.close();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    }
  });

  it('L1 legacy row (mirror 1, canonical 2) reads 2 with no write', async () => {
    await seed({ status: 'ARCHIVED', reopenCount: 2 });
    const file = path.join(h.moePath, 'tasks', 'task-x.json');
    const before = fs.readFileSync(file, 'utf8');
    const res = await listMetrics();
    expect(res.aggregate.avgReopenCount).toBe(2);
    expect(res.tasks[0].metrics.reopenCount).toBe(2);
    // No in-place mutation and no write: the stored mirror and the file stay as filed.
    expect(h.state.getTask('task-x')!.metrics?.reopenCount).toBe(1);
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
  });

  it('E1 a row without a metrics object gets none from a reopen', async () => {
    await seed({ metrics: undefined });
    await setTaskStatusTool(h.state).handler(
      { taskId: 'task-x', status: 'WORKING', reason: 'r' },
      h.state,
    );
    expect(h.state.getTask('task-x')!.metrics).toBeUndefined();
    expect((await listMetrics()).aggregate.avgReopenCount).toBe(2);
  });

  it('E2 a non-object stored metrics never throws in list_metrics', async () => {
    await seed();
    const stored = h.state.getTask('task-x')!;
    h.state.tasks.set('task-x', { ...stored, reopenCount: 3, metrics: 'x' as unknown as TaskMetrics });
    const res = await listMetrics();
    expect(res.aggregate.avgReopenCount).toBe(3);
    expect(res.tasks[0].metrics).toBe('x');
  });

  it('H1 helper: mirror = reopenCount + 1, doneAt/wallClockMs stripped, input untouched', () => {
    h.setupMoeFolder();
    const task = h.createTask({ id: 'task-h', status: 'DONE', ...afterOneReject });
    const before = structuredClone(task);
    expect(buildReopenClearingUpdates(task).metrics).toEqual({
      firstClaimAt: t0,
      rejectCount: 1,
      reopenCount: 2,
    });
    expect(task).toEqual(before);
  });

  it('H2 helper: a metrics object without a mirror gains one', () => {
    h.setupMoeFolder();
    const task = h.createTask({
      id: 'task-h',
      status: 'DONE',
      reopenCount: 0,
      metrics: { firstClaimAt: t0 },
    });
    expect(buildReopenClearingUpdates(task).metrics).toEqual({ firstClaimAt: t0, reopenCount: 1 });
  });

  it('H3 helper: a non-integer reopenCount leaves the mirror as today', () => {
    h.setupMoeFolder();
    const task = h.createTask({ id: 'task-h', status: 'DONE', ...afterOneReject });
    expect(buildReopenClearingUpdates({ ...task, reopenCount: 1.5 }).metrics).toEqual({
      firstClaimAt: t0,
      rejectCount: 1,
      reopenCount: 1,
    });
    expect(
      buildReopenClearingUpdates({
        ...task,
        reopenCount: 1.5,
        metrics: { rejectCount: 1, reopenCount: 1 },
      }).metrics,
    ).toBeUndefined();
  });

  it('H4 helper: a non-object metrics is left as today', () => {
    h.setupMoeFolder();
    const task = h.createTask({ id: 'task-h', status: 'DONE', reopenCount: 1 });
    expect(buildReopenClearingUpdates({ ...task, metrics: 'x' as unknown as TaskMetrics }).metrics).toBeUndefined();
    expect(buildReopenClearingUpdates({ ...task, metrics: [] as unknown as TaskMetrics }).metrics).toBeUndefined();
    expect(buildReopenClearingUpdates({ ...task, metrics: undefined }).metrics).toBeUndefined();
  });
});
