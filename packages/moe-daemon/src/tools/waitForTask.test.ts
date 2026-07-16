import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { StateManager } from '../state/StateManager.js';
import { activeWaiters, cleanupStaleWaiters, waitForTaskTool } from './waitForTask.js';
import type { Epic, Project, Task, Worker } from '../types/schema.js';

describe('cleanupStaleWaiters', () => {
  afterEach(() => {
    for (const waiter of activeWaiters.values()) {
      clearTimeout(waiter.timer);
    }
    activeWaiters.clear();
    vi.restoreAllMocks();
  });

  it('removes waiters for workers no longer tracked by state', () => {
    const missingResolve = vi.fn();
    const missingUnsubscribe = vi.fn();
    const missingTimer = setTimeout(() => undefined, 60_000);
    missingTimer.unref?.();

    const activeResolve = vi.fn();
    const activeUnsubscribe = vi.fn();
    const activeTimer = setTimeout(() => undefined, 60_000);
    activeTimer.unref?.();

    activeWaiters.set('worker-missing', {
      resolve: missingResolve,
      unsubscribe: missingUnsubscribe,
      timer: missingTimer,
    });
    activeWaiters.set('worker-active', {
      resolve: activeResolve,
      unsubscribe: activeUnsubscribe,
      timer: activeTimer,
    });

    const state = {
      workers: new Map([['worker-active', { id: 'worker-active' }]]),
    } as unknown as StateManager;

    const cleaned = cleanupStaleWaiters(state);

    expect(cleaned).toBe(1);
    expect(missingUnsubscribe).toHaveBeenCalledTimes(1);
    expect(missingResolve).toHaveBeenCalledWith({ hasNext: false, cancelled: true });
    expect(activeWaiters.has('worker-missing')).toBe(false);
    expect(activeWaiters.has('worker-active')).toBe(true);
  });

  it('removes stale waiter even if callback cleanup throws', () => {
    const noisyTimer = setTimeout(() => undefined, 60_000);
    noisyTimer.unref?.();

    activeWaiters.set('worker-stale', {
      resolve: vi.fn(() => {
        throw new Error('resolve failed');
      }),
      unsubscribe: vi.fn(() => {
        throw new Error('unsubscribe failed');
      }),
      timer: noisyTimer,
    });

    const state = { workers: new Map() } as unknown as StateManager;

    const cleaned = cleanupStaleWaiters(state);

    expect(cleaned).toBe(1);
    expect(activeWaiters.has('worker-stale')).toBe(false);
  });
});

describe('wait_for_task eligibility mirrors claim_next_task (hot-loop regressions)', () => {
  let testDir: string;
  let moePath: string;
  let state: StateManager;

  function setupMoe() {
    fs.mkdirSync(moePath, { recursive: true });
    for (const sub of ['epics', 'tasks', 'workers', 'proposals']) {
      fs.mkdirSync(path.join(moePath, sub));
    }
    const project: Partial<Project> = {
      id: 'proj-test',
      schemaVersion: 6,
      name: 'Test',
      rootPath: testDir,
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
    };
    fs.writeFileSync(path.join(moePath, 'project.json'), JSON.stringify(project, null, 2));
    const epic: Epic = {
      id: 'epic-1', projectId: 'proj-test', title: 'E', description: '', architectureNotes: '',
      epicRails: [], status: 'ACTIVE', order: 1,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(moePath, 'epics', 'epic-1.json'), JSON.stringify(epic, null, 2));
  }

  function writeTask(id: string, overrides: Partial<Task> = {}): void {
    const now = new Date().toISOString();
    const task: Task = {
      id, epicId: 'epic-1', title: `Task ${id}`, description: '',
      definitionOfDone: [], taskRails: [], implementationPlan: [],
      status: 'REVIEW', assignedWorkerId: null, branch: null, prLink: null,
      reopenCount: 0, reopenReason: null, createdBy: 'HUMAN', parentTaskId: null,
      priority: 'MEDIUM', order: 1, comments: [],
      createdAt: now, updatedAt: now,
      ...overrides,
    };
    fs.writeFileSync(path.join(moePath, 'tasks', id + '.json'), JSON.stringify(task, null, 2));
  }

  function writeWorker(id: string, overrides: Partial<Worker> = {}): void {
    const now = new Date().toISOString();
    const worker: Worker = {
      id, type: 'CLAUDE', projectId: 'proj-test', epicId: 'epic-1',
      currentTaskId: null, status: 'IDLE', branch: '', modifiedFiles: [],
      startedAt: now, lastActivityAt: now, lastError: null, errorCount: 0, teamId: null,
      ...overrides,
    };
    fs.writeFileSync(path.join(moePath, 'workers', id + '.json'), JSON.stringify(worker, null, 2));
  }

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moe-wait-for-task-'));
    moePath = path.join(testDir, '.moe');
    setupMoe();
    state = new StateManager({ projectPath: testDir });
  });

  afterEach(() => {
    for (const waiter of activeWaiters.values()) {
      clearTimeout(waiter.timer);
    }
    activeWaiters.clear();
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('does NOT offer a needsHumanReview-parked REVIEW task (claim would refuse it → spin)', async () => {
    writeTask('task-parked', { status: 'REVIEW', assignedWorkerId: null, needsHumanReview: true });
    writeWorker('qa-1');
    await state.load();

    const tool = waitForTaskTool(state);
    const result = await tool.handler(
      { statuses: ['REVIEW'], workerId: 'qa-1', timeoutMs: 1000 },
      state
    ) as Record<string, unknown>;

    expect(result.hasNext).toBe(false);
    expect(result.timedOut).toBe(true);
  });

  it('does NOT surface a pending question on an ARCHIVED task (get_pending_questions filters it → spin)', async () => {
    writeTask('task-archived', {
      status: 'ARCHIVED',
      hasPendingQuestion: true,
      comments: [{ id: 'c1', author: 'human', content: 'still relevant?', timestamp: new Date().toISOString() }],
    } as Partial<Task>);
    writeWorker('worker-1');
    await state.load();

    const tool = waitForTaskTool(state);
    const result = await tool.handler(
      { statuses: ['WORKING'], workerId: 'worker-1', timeoutMs: 1000 },
      state
    ) as Record<string, unknown>;

    expect(result.hasPendingQuestion).toBeUndefined();
    expect(result.timedOut).toBe(true);
  });

  it('DOES surface a pending question with an unanswered human comment on a live task', async () => {
    writeTask('task-live', {
      status: 'WORKING',
      assignedWorkerId: 'worker-other',
      hasPendingQuestion: true,
      comments: [{ id: 'c1', author: 'human', content: 'why this approach?', timestamp: new Date().toISOString() }],
    } as Partial<Task>);
    writeWorker('worker-1');
    writeWorker('worker-other');
    await state.load();

    const tool = waitForTaskTool(state);
    const result = await tool.handler(
      { statuses: ['BACKLOG'], workerId: 'worker-1', timeoutMs: 1000 },
      state
    ) as Record<string, unknown>;

    expect(result.hasPendingQuestion).toBe(true);
    expect(result.taskId).toBe('task-live');
  });

  it('does NOT offer a task blocked by the solo-worker epic+status rule (claim would decline → spin)', async () => {
    // Live worker A holds task-1 (WORKING) in the epic; teamless worker B waits
    // on WORKING. claim_next_task would skip task-2, so wait must not wake B.
    writeTask('task-1', { status: 'WORKING', assignedWorkerId: 'worker-a', order: 1 });
    writeTask('task-2', { status: 'WORKING', assignedWorkerId: null, order: 2 });
    writeWorker('worker-a', { currentTaskId: 'task-1', status: 'CODING' });
    writeWorker('worker-b');
    await state.load();

    const tool = waitForTaskTool(state);
    const result = await tool.handler(
      { statuses: ['WORKING'], workerId: 'worker-b', timeoutMs: 1000 },
      state
    ) as Record<string, unknown>;

    expect(result.hasNext).toBe(false);
    expect(result.timedOut).toBe(true);
  });
});
