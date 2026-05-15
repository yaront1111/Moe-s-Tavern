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
