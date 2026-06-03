// =============================================================================
// Defensive batch test bundle: covers the load-bearing pieces of the May
// 2026 hardening pass that aren't already exercised by tools.test.ts /
// governanceFeatures.test.ts. Each test stays self-contained so a future
// refactor can split them apart without untangling shared state.
// =============================================================================

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { StateManager } from '../state/StateManager.js';
import { backfillTaskMetrics, __testing as backfillTesting } from '../state/migrations/backfillTaskMetrics.js';
import { sweepStaleWorkers } from '../state/staleWorkerWatcher.js';
import { deregisterWorker, nextStatusForRelease } from '../state/workerLifecycle.js';
import { claimNextTaskTool } from '../tools/claimNextTask.js';
import { deregisterWorkerTool } from '../tools/deregisterWorker.js';
import { unblockWorkerTool } from '../tools/unblockWorker.js';
import { setTaskStatusTool } from '../tools/setTaskStatus.js';
import { getTools } from '../tools/index.js';
import { runDoctor } from '../commands/doctor.js';
import { computeMetricsAggregate, computeDashboardAggregate } from '../util/metrics.js';
import type { ActivityEvent, Epic, Project, Task, Worker } from '../types/schema.js';

function writeProject(moePath: string, settings: Partial<Project> = {}): void {
  fs.mkdirSync(moePath, { recursive: true });
  for (const sub of ['epics', 'tasks', 'workers', 'proposals', 'channels', 'messages', 'teams']) {
    fs.mkdirSync(path.join(moePath, sub));
  }
  const project: Partial<Project> = {
    id: 'proj-defense',
    schemaVersion: 6,
    name: 'Defense',
    rootPath: path.dirname(moePath),
    globalRails: { techStack: [], forbiddenPatterns: [], requiredPatterns: [], formatting: '', testing: '', customRules: [] },
    settings: {
      approvalMode: 'TURBO',
      speedModeDelayMs: 2000,
      autoCreateBranch: false,
      branchPattern: '',
      commitPattern: '',
      agentCommand: 'claude',
      enableAgentTeams: false,
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...settings,
  };
  fs.writeFileSync(path.join(moePath, 'project.json'), JSON.stringify(project, null, 2));
}

function writeEpic(moePath: string): Epic {
  const epic: Epic = {
    id: 'epic-1', projectId: 'proj-defense', title: 'E', description: '', architectureNotes: '',
    epicRails: [], status: 'ACTIVE', order: 1,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(moePath, 'epics', 'epic-1.json'), JSON.stringify(epic, null, 2));
  return epic;
}

function writeTask(moePath: string, overrides: Partial<Task> = {}): Task {
  const now = new Date().toISOString();
  const task: Task = {
    id: 'task-1', epicId: 'epic-1', title: 'T', description: '',
    definitionOfDone: [], taskRails: [], implementationPlan: [],
    status: 'BACKLOG', assignedWorkerId: null, branch: null, prLink: null,
    reopenCount: 0, reopenReason: null, createdBy: 'HUMAN', parentTaskId: null,
    priority: 'MEDIUM', order: 1, comments: [],
    createdAt: now, updatedAt: now,
    ...overrides,
  };
  fs.writeFileSync(path.join(moePath, 'tasks', `${task.id}.json`), JSON.stringify(task, null, 2));
  return task;
}

function writeWorker(moePath: string, overrides: Partial<Worker> = {}): Worker {
  const worker: Worker = {
    id: 'worker-1', type: 'CLAUDE', projectId: 'proj-defense', epicId: 'epic-1',
    currentTaskId: null, status: 'IDLE', branch: 'main', modifiedFiles: [],
    startedAt: new Date().toISOString(), lastActivityAt: new Date().toISOString(),
    lastError: null, errorCount: 0, teamId: null,
    ...overrides,
  };
  fs.writeFileSync(path.join(moePath, 'workers', `${worker.id}.json`), JSON.stringify(worker, null, 2));
  return worker;
}

function appendActivityLine(moePath: string, event: Partial<ActivityEvent>): void {
  const line = JSON.stringify({
    id: `evt-${Math.random().toString(36).slice(2)}`,
    timestamp: new Date().toISOString(),
    projectId: 'proj-defense',
    payload: {},
    ...event,
  }) + '\n';
  fs.appendFileSync(path.join(moePath, 'activity.log'), line);
}

describe('defensive batch', () => {
  let testDir: string;
  let moePath: string;
  let state: StateManager;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moe-defense-'));
    moePath = path.join(testDir, '.moe');
    state = new StateManager({ projectPath: testDir });
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  // -----------------------------------------------------------------------
  // Feature 2: backfillTaskMetrics
  // -----------------------------------------------------------------------
  describe('backfillTaskMetrics', () => {
    it('fills firstClaimAt / doneAt / wallClockMs from the activity log without overwriting', async () => {
      writeProject(moePath);
      writeEpic(moePath);
      writeTask(moePath, {
        id: 'task-bf',
        status: 'DONE',
      });
      writeTask(moePath, {
        id: 'task-bf-keep',
        status: 'DONE',
        metrics: { firstClaimAt: '2026-05-15T00:00:00.000Z', doneAt: '2026-05-15T00:30:00.000Z', wallClockMs: 1800000 },
      });

      // Activity log with TASK_STARTED + QA_APPROVED → covers claim + done
      appendActivityLine(moePath, {
        timestamp: '2026-05-15T10:00:00.000Z',
        taskId: 'task-bf',
        event: 'TASK_STARTED',
      });
      appendActivityLine(moePath, {
        timestamp: '2026-05-15T10:30:00.000Z',
        taskId: 'task-bf',
        event: 'QA_APPROVED',
      });

      await state.load();
      const result = await backfillTaskMetrics(state);
      expect(result.backfilled).toBe(1); // only task-bf got new fields

      const filled = state.getTask('task-bf')!;
      expect(filled.metrics?.firstClaimAt).toBe('2026-05-15T10:00:00.000Z');
      expect(filled.metrics?.doneAt).toBe('2026-05-15T10:30:00.000Z');
      expect(filled.metrics?.wallClockMs).toBe(30 * 60 * 1000);

      // Existing metrics on the other task left alone
      const kept = state.getTask('task-bf-keep')!;
      expect(kept.metrics?.firstClaimAt).toBe('2026-05-15T00:00:00.000Z');
      expect(kept.metrics?.wallClockMs).toBe(1800000);
    });

    it('is silent when the activity log is missing', () => {
      const empty = backfillTesting.indexActivityLog(path.join(moePath, 'activity.log'));
      expect(empty.earliestClaim.size).toBe(0);
      expect(empty.latestDone.size).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // Feature 4: stale-worker watcher
  // -----------------------------------------------------------------------
  describe('stale-worker watcher', () => {
    it('releases tasks held by stale workers and posts to #workers / #governors', async () => {
      writeProject(moePath);
      writeEpic(moePath);
      const oldTs = new Date(Date.now() - 60 * 60_000).toISOString();
      writeTask(moePath, {
        id: 'task-stale',
        status: 'WORKING',
        assignedWorkerId: 'worker-stale',
      });
      writeWorker(moePath, {
        id: 'worker-stale',
        currentTaskId: 'task-stale',
        lastActivityAt: oldTs,
      });
      await state.load();

      const result = await sweepStaleWorkers(state, {
        staleAfterMs: 30 * 60_000,
        dryRun: false,
        now: () => Date.now(),
      });
      expect(result.released).toBe(1);
      const task = state.getTask('task-stale')!;
      expect(task.assignedWorkerId).toBeNull();
      expect(task.status).toBe('BACKLOG');
      const worker = state.getWorker('worker-stale')!;
      expect(worker.currentTaskId).toBeNull();
      // The sweep funnels through the single deregister path: worker → DEAD.
      expect(worker.status).toBe('DEAD');
      // And the released task is now claimable (the orphan is unstuck).
      expect(state.isTaskClaimable(task)).toBe(true);
    });

    it('dry-run posts banner without mutating task or worker', async () => {
      writeProject(moePath);
      writeEpic(moePath);
      const oldTs = new Date(Date.now() - 60 * 60_000).toISOString();
      writeTask(moePath, {
        id: 'task-dry',
        status: 'WORKING',
        assignedWorkerId: 'worker-dry',
      });
      writeWorker(moePath, {
        id: 'worker-dry',
        currentTaskId: 'task-dry',
        lastActivityAt: oldTs,
      });
      await state.load();

      await sweepStaleWorkers(state, {
        staleAfterMs: 30 * 60_000,
        dryRun: true,
        now: () => Date.now(),
      });
      const task = state.getTask('task-dry')!;
      expect(task.assignedWorkerId).toBe('worker-dry');
      expect(task.status).toBe('WORKING');
    });
  });

  // -----------------------------------------------------------------------
  // Feature 4b: dead-worker handling — orphan unstick, deregister, UI removal
  // -----------------------------------------------------------------------
  describe('dead-worker handling', () => {
    const STALE_TS = () => new Date(Date.now() - 5 * 60_000).toISOString(); // > 120s liveness

    it('claimability keys on DEAD/missing, never raw idle: a quiet-but-alive owner keeps its task', async () => {
      writeProject(moePath);
      writeEpic(moePath);
      // Owner marked DEAD → claimable (defensive backstop; release normally already nulls assignment).
      writeTask(moePath, { id: 'task-dead', status: 'WORKING', assignedWorkerId: 'w-dead' });
      writeWorker(moePath, { id: 'w-dead', currentTaskId: 'task-dead', status: 'DEAD', lastActivityAt: new Date().toISOString() });
      // Owner stale (idle > 120s) but still CODING → ALIVE → NOT claimable. This is
      // the safety property: a peer must not steal a worker's in-flight task just
      // because it went quiet during a long build/test.
      writeTask(moePath, { id: 'task-quiet', status: 'WORKING', assignedWorkerId: 'w-quiet' });
      writeWorker(moePath, { id: 'w-quiet', currentTaskId: 'task-quiet', status: 'CODING', lastActivityAt: STALE_TS() });
      // Owner fresh → NOT claimable.
      writeTask(moePath, { id: 'task-live', status: 'WORKING', assignedWorkerId: 'w-live' });
      writeWorker(moePath, { id: 'w-live', currentTaskId: 'task-live', status: 'CODING', lastActivityAt: new Date().toISOString() });
      await state.load();

      expect(state.isTaskClaimable(state.getTask('task-dead')!)).toBe(true);
      expect(state.isTaskClaimable(state.getTask('task-quiet')!)).toBe(false);
      expect(state.isTaskClaimable(state.getTask('task-live')!)).toBe(false);
    });

    it('claim_next_task can take over a task whose owner is marked DEAD', async () => {
      writeProject(moePath);
      writeEpic(moePath);
      writeTask(moePath, { id: 'task-x', status: 'WORKING', assignedWorkerId: 'w-dead' });
      writeWorker(moePath, { id: 'w-dead', currentTaskId: 'task-x', status: 'DEAD', lastActivityAt: STALE_TS() });
      await state.load();

      const claim = claimNextTaskTool(state);
      const res = await claim.handler({ workerId: 'w-new', statuses: ['WORKING'], taskId: 'task-x' }, state) as { hasNext: boolean };
      expect(res.hasNext).toBe(true);
      expect(state.getTask('task-x')!.assignedWorkerId).toBe('w-new');
    });

    it('release routing promotes an all-steps-COMPLETED WORKING task to REVIEW, not BACKLOG', async () => {
      const allDone = { id: 'task-done', status: 'WORKING' as const, assignedWorkerId: 'w-fin', implementationPlan: [
        { stepId: 's1', description: 'a', status: 'COMPLETED' as const, affectedFiles: [] },
        { stepId: 's2', description: 'b', status: 'COMPLETED' as const, affectedFiles: [] },
      ] };
      expect(nextStatusForRelease(allDone)).toBe('REVIEW');
      expect(nextStatusForRelease({ ...allDone, implementationPlan: [{ stepId: 's1', description: 'a', status: 'PENDING' as const, affectedFiles: [] }] })).toBe('BACKLOG');
      expect(nextStatusForRelease({ status: 'WORKING', implementationPlan: [] })).toBe('BACKLOG');
      expect(nextStatusForRelease({ status: 'PLANNING', implementationPlan: [] })).toBe('PLANNING');
      expect(nextStatusForRelease({ status: 'REVIEW', implementationPlan: [] })).toBe('REVIEW');

      // End-to-end through deregister: a dead worker that finished every step
      // hands the work to QA (REVIEW) rather than discarding it to BACKLOG.
      writeProject(moePath);
      writeEpic(moePath);
      writeTask(moePath, { id: 'task-done', status: 'WORKING', assignedWorkerId: 'w-fin', implementationPlan: allDone.implementationPlan });
      writeWorker(moePath, { id: 'w-fin', currentTaskId: 'task-done', status: 'CODING', lastActivityAt: STALE_TS() });
      await state.load();
      await deregisterWorker(state, 'w-fin', 'liveness_timeout');
      expect(state.getTask('task-done')!.status).toBe('REVIEW');
      expect(state.getTask('task-done')!.assignedWorkerId).toBeNull();
    });

    it('deregister_worker tool is registered, releases held tasks, marks DEAD, and is idempotent', async () => {
      writeProject(moePath);
      writeEpic(moePath);
      writeTask(moePath, { id: 'task-d', status: 'WORKING', assignedWorkerId: 'w-1' });
      writeWorker(moePath, { id: 'w-1', currentTaskId: 'task-d', status: 'CODING' });
      await state.load();

      expect(getTools(state).some((t) => t.name === 'moe.deregister_worker')).toBe(true);

      const tool = deregisterWorkerTool(state);
      const r1 = await tool.handler({ workerId: 'w-1', reason: 'terminal_closed' }, state) as { releasedCount: number; alreadyDead: boolean };
      expect(r1.releasedCount).toBe(1);
      expect(r1.alreadyDead).toBe(false);
      expect(state.getTask('task-d')!.assignedWorkerId).toBeNull();
      expect(state.getTask('task-d')!.status).toBe('BACKLOG');
      expect(state.getWorker('w-1')!.status).toBe('DEAD');

      // Repeat call is a no-op.
      const r2 = await tool.handler({ workerId: 'w-1', reason: 'terminal_closed' }, state) as { alreadyDead: boolean; releasedCount: number };
      expect(r2.alreadyDead).toBe(true);
      expect(r2.releasedCount).toBe(0);
    });

    it('DEAD workers are removed from the UI: excluded from snapshot, WORKER_DELETED emitted', async () => {
      writeProject(moePath);
      writeEpic(moePath);
      writeTask(moePath, { id: 'task-u', status: 'WORKING', assignedWorkerId: 'w-u' });
      // Seed an OLD lastActivityAt so we can prove the DEAD transition preserves
      // it (doesn't bump to now) — keeps staleness/pruning accurate.
      const deadSinceTs = STALE_TS();
      writeWorker(moePath, { id: 'w-u', currentTaskId: 'task-u', status: 'CODING', lastActivityAt: deadSinceTs });
      await state.load();

      const events: Array<{ type: string; payload: { id: string } }> = [];
      state.setEmitter((e) => events.push(e as { type: string; payload: { id: string } }));

      await deregisterWorker(state, 'w-u', 'terminal_closed');

      // Retained server-side (idempotency / pruning) ...
      expect(state.getWorker('w-u')!.status).toBe('DEAD');
      // ... with lastActivityAt PRESERVED (not bumped by the DEAD transition) ...
      expect(state.getWorker('w-u')!.lastActivityAt).toBe(deadSinceTs);
      // ... but absent from the UI snapshot ...
      expect(state.getSnapshot().workers.some((w) => w.id === 'w-u')).toBe(false);
      // ... and a removal event was emitted so live boards drop it.
      expect(events.some((e) => e.type === 'WORKER_DELETED' && e.payload.id === 'w-u')).toBe(true);
      expect(events.some((e) => e.type === 'WORKER_UPDATED' && e.payload.id === 'w-u')).toBe(false);
    });

    it('the liveness sweep leaves BLOCKED workers alone (checkBlockedTimeouts owns their longer grace)', async () => {
      writeProject(moePath);
      writeEpic(moePath);
      writeTask(moePath, { id: 'task-b', status: 'WORKING', assignedWorkerId: 'w-b' });
      writeWorker(moePath, { id: 'w-b', currentTaskId: 'task-b', status: 'BLOCKED', lastActivityAt: new Date(Date.now() - 60 * 60_000).toISOString() });
      await state.load();

      const res = await sweepStaleWorkers(state, { staleAfterMs: 30 * 60_000, dryRun: false, now: () => Date.now() });
      expect(res.released).toBe(0);
      // Task still held; worker not yanked or marked DEAD by the sweep.
      expect(state.getTask('task-b')!.assignedWorkerId).toBe('w-b');
      expect(state.getWorker('w-b')!.status).toBe('BLOCKED');
    });
  });

  // -----------------------------------------------------------------------
  // Feature 4c: orphan-release on unblock + reopen completion cleanup
  // -----------------------------------------------------------------------
  describe('unblock + reopen cleanup', () => {
    it('unblock_worker (no retry) releases the held task instead of orphaning it', async () => {
      writeProject(moePath);
      writeEpic(moePath);
      writeTask(moePath, { id: 'task-ub', status: 'WORKING', assignedWorkerId: 'w-ub' });
      writeWorker(moePath, { id: 'w-ub', currentTaskId: 'task-ub', status: 'BLOCKED' });
      await state.load();

      await unblockWorkerTool(state).handler({ workerId: 'w-ub', resolution: 'unblocked by human' }, state);

      const t = state.getTask('task-ub')!;
      expect(t.assignedWorkerId).toBeNull();
      expect(t.status).toBe('BACKLOG');
      expect(state.isTaskClaimable(t)).toBe(true);
      expect(state.getWorker('w-ub')!.status).toBe('IDLE');
      expect(state.getWorker('w-ub')!.currentTaskId).toBeNull();
    });

    it('unblock_worker (retryTask:true) keeps the task assigned for a retry', async () => {
      writeProject(moePath);
      writeEpic(moePath);
      writeTask(moePath, { id: 'task-ub2', status: 'WORKING', assignedWorkerId: 'w-ub2' });
      writeWorker(moePath, { id: 'w-ub2', currentTaskId: 'task-ub2', status: 'BLOCKED' });
      await state.load();

      await unblockWorkerTool(state).handler({ workerId: 'w-ub2', resolution: 'retry', retryTask: true }, state);

      expect(state.getTask('task-ub2')!.assignedWorkerId).toBe('w-ub2');
      expect(state.getWorker('w-ub2')!.currentTaskId).toBe('task-ub2');
    });

    it('set_task_status reopen (DONE→WORKING) clears done-signals and resets steps; firstClaimAt preserved', async () => {
      writeProject(moePath);
      writeEpic(moePath);
      writeTask(moePath, {
        id: 'task-ro', status: 'DONE',
        completedAt: '2026-01-01T00:00:00.000Z',
        reviewCompletedAt: '2026-01-01T00:00:00.000Z',
        metrics: { doneAt: '2026-01-01T00:00:00.000Z', wallClockMs: 1000, firstClaimAt: '2025-12-31T00:00:00.000Z' },
        implementationPlan: [{ stepId: 's1', description: 'a', status: 'COMPLETED', affectedFiles: [], note: 'old', modifiedFiles: ['x.ts'] }],
        stepsCompleted: ['s1'],
      });
      await state.load();

      await setTaskStatusTool(state).handler({ taskId: 'task-ro', status: 'WORKING', reason: 'reopen' }, state);

      const t = state.getTask('task-ro')!;
      expect(t.status).toBe('WORKING');
      expect(t.completedAt).toBeUndefined();
      expect(t.reviewCompletedAt).toBeUndefined();
      expect(t.metrics?.doneAt).toBeUndefined();
      expect(t.metrics?.wallClockMs).toBeUndefined();
      expect(t.metrics?.firstClaimAt).toBe('2025-12-31T00:00:00.000Z');
      expect(t.implementationPlan.every((s) => s.status === 'PENDING')).toBe(true);
      expect(t.implementationPlan[0].note).toBeUndefined();
      expect(t.implementationPlan[0].modifiedFiles).toBeUndefined();
      expect(t.stepsCompleted).toEqual([]);
      expect(t.reopenCount).toBe(1);
    });

    it('set_task_status reopen also fires for ARCHIVED→WORKING (closes the bypass)', async () => {
      writeProject(moePath);
      writeEpic(moePath);
      writeTask(moePath, {
        id: 'task-ar', status: 'ARCHIVED',
        completedAt: '2026-01-01T00:00:00.000Z',
        implementationPlan: [{ stepId: 's1', description: 'a', status: 'COMPLETED', affectedFiles: [] }],
      });
      await state.load();

      await setTaskStatusTool(state).handler({ taskId: 'task-ar', status: 'WORKING' }, state);

      const t = state.getTask('task-ar')!;
      expect(t.status).toBe('WORKING');
      expect(t.completedAt).toBeUndefined();
      expect(t.implementationPlan[0].status).toBe('PENDING');
    });
  });

  // -----------------------------------------------------------------------
  // Feature 5: AGENT_TOOL_EVENT aggregation in metrics
  // -----------------------------------------------------------------------
  describe('agent tool aggregation', () => {
    it('totalToolCalls sums agentToolCallCount across the filtered set', () => {
      const t1 = makeTask('task-1', 'DONE', { agentToolCallCount: 5 });
      const t2 = makeTask('task-2', 'WORKING', { agentToolCallCount: 3 });
      const t3 = makeTask('task-3', 'DONE', {});
      const aggregate = computeMetricsAggregate([t1, t2, t3]);
      expect(aggregate.totalToolCalls).toBe(8);

      const dashboard = computeDashboardAggregate([t1, t2, t3], () => 'epic');
      expect(dashboard.totalToolCalls).toBe(8);
    });

    it('totalToolCalls is 0 when no tasks recorded any tool calls', () => {
      const t = makeTask('task-1', 'DONE', {});
      const aggregate = computeMetricsAggregate([t]);
      expect(aggregate.totalToolCalls).toBe(0);
      const dashboard = computeDashboardAggregate([t], () => 'epic');
      expect(dashboard.totalToolCalls).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // Feature 6: doctor command
  // -----------------------------------------------------------------------
  describe('doctor', () => {
    it('reports OK on a freshly initialized project', async () => {
      writeProject(moePath);
      writeEpic(moePath);
      // Canonical channels expected by doctor
      for (const name of ['general', 'workers', 'architects', 'qa', 'governors']) {
        const id = `chan-${name}`;
        fs.writeFileSync(
          path.join(moePath, 'channels', `${id}.json`),
          JSON.stringify({ id, name, type: name === 'general' ? 'general' : 'role', linkedEntityId: null, createdAt: new Date().toISOString() }, null, 2)
        );
      }
      // Role docs
      for (const f of ['architect.md', 'worker.md', 'qa.md', 'governor.md']) {
        fs.mkdirSync(path.join(moePath, 'roles'), { recursive: true });
        fs.writeFileSync(path.join(moePath, 'roles', f), '# stub');
      }
      const result = await runDoctor(testDir);
      expect(result.exitCode).toBe(0);
      expect(result.output.some((l) => l.includes('[OK] role docs'))).toBe(true);
      expect(result.output.some((l) => l.includes('[OK] canonical channels'))).toBe(true);
    });

    it('fails with exit code 1 when .moe/ is missing', async () => {
      const result = await runDoctor(testDir);
      expect(result.exitCode).toBe(1);
      expect(result.output.some((l) => l.includes('[FAIL] .moe/ presence'))).toBe(true);
    });

    it('fails when canonical channels are missing', async () => {
      writeProject(moePath);
      writeEpic(moePath);
      // Only general — others missing
      fs.writeFileSync(
        path.join(moePath, 'channels', 'chan-general.json'),
        JSON.stringify({ id: 'chan-general', name: 'general', type: 'general', linkedEntityId: null, createdAt: new Date().toISOString() }, null, 2)
      );
      const result = await runDoctor(testDir);
      expect(result.exitCode).toBe(1);
      expect(result.output.some((l) => l.includes('missing channels'))).toBe(true);
    });
  });
});

function makeTask(id: string, status: Task['status'], metricsExtra: Partial<NonNullable<Task['metrics']>>): Task {
  const now = new Date().toISOString();
  return {
    id, epicId: 'epic-1', title: id, description: '',
    definitionOfDone: [], taskRails: [], implementationPlan: [],
    status, assignedWorkerId: null, branch: null, prLink: null,
    reopenCount: 0, reopenReason: null, createdBy: 'HUMAN', parentTaskId: null,
    priority: 'MEDIUM', order: 1, comments: [],
    createdAt: now, updatedAt: now,
    metrics: metricsExtra,
  };
}

// Avoid the `vi` import being treated as unused when the suite skips fake timers.
void vi;
