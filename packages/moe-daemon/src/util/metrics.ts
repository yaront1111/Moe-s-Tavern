// =============================================================================
// Task metrics aggregation
// =============================================================================
//
// Per-task TaskMetrics are populated on the hot path (submit_plan, claim,
// complete_step, qa_approve, qa_reject). This module reads many tasks and
// computes the dashboard-shaped aggregate that `moe.list_metrics` returns.
//
// Aggregate must be defined on empty inputs: a fresh project where nobody has
// finished anything yet still wants a zeroed shape, not an error.

import type { Task, TaskMetrics } from '../types/schema.js';

export interface MetricsAggregate {
  taskCount: number;
  doneCount: number;
  avgWallClockMs: number;
  firstPassApprovalPct: number;   // 0..100
  avgReopenCount: number;
  totalRejectCount: number;
  totalExecutedStepCount: number;
  /** Total agent tool calls across the filtered set; sourced from AGENT_TOOL_EVENT. */
  totalToolCalls: number;
}

export interface PerTaskMetric {
  taskId: string;
  epicId: string;
  status: string;
  title: string;
  metrics: TaskMetrics;
}

/**
 * Return a zeroed aggregate. Callers can use this when no tasks match the
 * filter without sprinkling defaults at the call sites.
 */
export function emptyMetricsAggregate(): MetricsAggregate {
  return {
    taskCount: 0,
    doneCount: 0,
    avgWallClockMs: 0,
    firstPassApprovalPct: 0,
    avgReopenCount: 0,
    totalRejectCount: 0,
    totalExecutedStepCount: 0,
    totalToolCalls: 0,
  };
}

/**
 * Compute aggregate metrics across the given tasks. Tasks without a metrics
 * record are still counted toward taskCount but contribute zero to numeric
 * averages (so a partially-instrumented project still gets a usable number).
 */
export function computeMetricsAggregate(tasks: Task[]): MetricsAggregate {
  if (tasks.length === 0) return emptyMetricsAggregate();

  let doneCount = 0;
  let wallClockSum = 0;
  let wallClockCount = 0;
  let firstPassCount = 0;
  let approvalCount = 0;
  let reopenSum = 0;
  let totalRejectCount = 0;
  let totalExecutedStepCount = 0;
  let totalToolCalls = 0;

  for (const task of tasks) {
    const m = task.metrics ?? {};
    if (task.status === 'DONE') {
      doneCount += 1;
      // first-pass = approved without ever being rejected. Use rejectCount
      // (live counter) rather than reopenCount, which can be reset.
      approvalCount += 1;
      if ((m.rejectCount ?? 0) === 0) firstPassCount += 1;
    }
    if (typeof m.wallClockMs === 'number' && Number.isFinite(m.wallClockMs)) {
      wallClockSum += m.wallClockMs;
      wallClockCount += 1;
    }
    reopenSum += m.reopenCount ?? task.reopenCount ?? 0;
    totalRejectCount += m.rejectCount ?? 0;
    totalExecutedStepCount += m.executedStepCount ?? 0;
    totalToolCalls += m.agentToolCallCount ?? 0;
  }

  return {
    taskCount: tasks.length,
    doneCount,
    avgWallClockMs: wallClockCount > 0 ? Math.round(wallClockSum / wallClockCount) : 0,
    firstPassApprovalPct: approvalCount > 0
      ? Math.round((firstPassCount / approvalCount) * 100)
      : 0,
    avgReopenCount: tasks.length > 0 ? Math.round((reopenSum / tasks.length) * 100) / 100 : 0,
    totalRejectCount,
    totalExecutedStepCount,
    totalToolCalls,
  };
}

/**
 * Filter helpers shared by the tool entry point.
 */
export interface MetricsFilter {
  epicId?: string;
  sinceIso?: string;
}

export function filterTasksForMetrics(tasks: Iterable<Task>, filter: MetricsFilter): Task[] {
  let sinceMs: number | undefined;
  if (filter.sinceIso) {
    const parsed = Date.parse(filter.sinceIso);
    if (Number.isFinite(parsed)) sinceMs = parsed;
  }
  const out: Task[] = [];
  for (const t of tasks) {
    if (filter.epicId && t.epicId !== filter.epicId) continue;
    if (sinceMs !== undefined) {
      // Use the most recent lifecycle timestamp available so newly-claimed
      // tasks aren't excluded just because they haven't reached DONE.
      const ts = t.metrics?.doneAt
        ?? t.metrics?.firstClaimAt
        ?? t.updatedAt
        ?? t.createdAt;
      const tsMs = ts ? Date.parse(ts) : NaN;
      if (!Number.isFinite(tsMs) || tsMs < sinceMs) continue;
    }
    out.push(t);
  }
  return out;
}

export function toPerTaskMetric(task: Task): PerTaskMetric {
  return {
    taskId: task.id,
    epicId: task.epicId,
    status: task.status,
    title: task.title,
    metrics: task.metrics ?? {},
  };
}

export interface EpicDashboardAggregate {
  epicId: string;
  epicTitle?: string;
  completed: number;
  avgReopenCount?: number;
  avgWallClockMs?: number;
}

export interface DashboardAggregate {
  firstPassApprovalPct?: number;
  avgWallClockMs?: number;
  avgReopenCount?: number;
  totalCompleted?: number;
  /** Total agent tool calls across the filtered set; undefined when nothing recorded yet. */
  totalToolCalls?: number;
  perEpic: EpicDashboardAggregate[];
}

/**
 * IDE dashboard shape: drops daemon-internal counters and adds per-epic breakdown.
 * Optional fields stay undefined (not zero) when nothing has happened yet, so the
 * UI can render an empty-state cell instead of misleading "0%".
 */
export function computeDashboardAggregate(
  tasks: Task[],
  getEpicTitle: (epicId: string) => string | undefined
): DashboardAggregate {
  const overall = computeMetricsAggregate(tasks);

  const byEpic = new Map<string, Task[]>();
  for (const t of tasks) {
    const list = byEpic.get(t.epicId);
    if (list) list.push(t);
    else byEpic.set(t.epicId, [t]);
  }

  const perEpic: EpicDashboardAggregate[] = [];
  for (const [epicId, epicTasks] of byEpic) {
    const agg = computeMetricsAggregate(epicTasks);
    perEpic.push({
      epicId,
      epicTitle: getEpicTitle(epicId),
      completed: agg.doneCount,
      avgReopenCount: epicTasks.length > 0 ? agg.avgReopenCount : undefined,
      avgWallClockMs: agg.avgWallClockMs > 0 ? agg.avgWallClockMs : undefined,
    });
  }
  perEpic.sort((a, b) => b.completed - a.completed);

  return {
    firstPassApprovalPct: overall.doneCount > 0 ? overall.firstPassApprovalPct : undefined,
    avgWallClockMs: overall.avgWallClockMs > 0 ? overall.avgWallClockMs : undefined,
    avgReopenCount: tasks.length > 0 ? overall.avgReopenCount : undefined,
    totalCompleted: overall.doneCount,
    totalToolCalls: overall.totalToolCalls > 0 ? overall.totalToolCalls : undefined,
    perEpic,
  };
}
