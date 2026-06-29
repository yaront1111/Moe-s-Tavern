import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { StateManager } from './StateManager.js';
import { sweepStaleWorkers } from './staleWorkerWatcher.js';
import type { Project, Epic, Task, Worker } from '../types/schema.js';

// Regression coverage for the pre-lock-snapshot race in the worker-liveness
// sweep: the stale/DEAD/BLOCKED/owns-tasks decision is computed from a snapshot
// taken OUTSIDE the mutex, but a worker can recover (heart-beat), go BLOCKED, or
// have its task released by a concurrent deregister before the sweep acquires
// the lock. The sweep must re-validate against the CURRENT record under the lock
// and skip, instead of yanking a now-active worker's in-flight task.
describe('sweepStaleWorkers re-validates under the lock', () => {
  let testDir: string;
  let moePath: string;
  let state: StateManager;

  const STALE_AFTER_MS = 1000;

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
  }

  function writeEpic(): Epic {
    const epic: Epic = {
      id: 'epic-1', projectId: 'proj-test', title: 'E', description: '', architectureNotes: '',
      epicRails: [], status: 'ACTIVE', order: 1,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(moePath, 'epics', 'epic-1.json'), JSON.stringify(epic, null, 2));
    return epic;
  }

  function writeTask(overrides: Partial<Task> = {}): Task {
    const now = new Date().toISOString();
    const task: Task = {
      id: 'task-1', epicId: 'epic-1', title: 'Some task', description: '',
      definitionOfDone: [], taskRails: [], implementationPlan: [],
      status: 'WORKING', assignedWorkerId: 'worker-a', branch: null, prLink: null,
      reopenCount: 0, reopenReason: null, createdBy: 'HUMAN', parentTaskId: null,
      priority: 'MEDIUM', order: 1, comments: [],
      createdAt: now, updatedAt: now,
      ...overrides,
    };
    fs.writeFileSync(path.join(moePath, 'tasks', task.id + '.json'), JSON.stringify(task, null, 2));
    return task;
  }

  function writeWorker(overrides: Partial<Worker> = {}): Worker {
    const now = new Date().toISOString();
    const worker: Worker = {
      id: 'worker-a', type: 'CLAUDE', projectId: 'proj-test', epicId: 'epic-1',
      currentTaskId: 'task-1', status: 'CODING', branch: '', modifiedFiles: [],
      startedAt: now, lastActivityAt: now, lastError: null, errorCount: 0, teamId: null,
      ...overrides,
    };
    fs.writeFileSync(path.join(moePath, 'workers', worker.id + '.json'), JSON.stringify(worker, null, 2));
    return worker;
  }

  /** A lastActivityAt timestamp old enough to look stale. */
  function staleTimestamp(): string {
    return new Date(Date.now() - 60_000).toISOString();
  }

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moe-stale-sweep-'));
    moePath = path.join(testDir, '.moe');
    setupMoe();
    writeEpic();
    state = new StateManager({ projectPath: testDir });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('releases a genuinely stale worker that still owns an active task (baseline)', async () => {
    writeTask({ assignedWorkerId: 'worker-a', status: 'WORKING' });
    writeWorker({ id: 'worker-a', currentTaskId: 'task-1', status: 'CODING', lastActivityAt: staleTimestamp() });
    await state.load();

    const result = await sweepStaleWorkers(state, {
      staleAfterMs: STALE_AFTER_MS,
      dryRun: false,
      now: () => Date.now(),
    });

    expect(result.released).toBe(1);
    expect(state.getWorker('worker-a')!.status).toBe('DEAD');
    const task = state.getTask('task-1')!;
    expect(task.assignedWorkerId).toBeNull();
    expect(task.status).toBe('BACKLOG');
  });

  it('skips a worker that heart-beats between the snapshot and the lock', async () => {
    writeTask({ assignedWorkerId: 'worker-a', status: 'WORKING' });
    writeWorker({ id: 'worker-a', currentTaskId: 'task-1', status: 'CODING', lastActivityAt: staleTimestamp() });
    await state.load();

    // Simulate a heartbeat landing AFTER the pre-lock snapshot but BEFORE the
    // sweep's deregister runExclusive executes: refresh lastActivityAt the first
    // time the sweep tries to take the lock.
    const realRun = state.runExclusive.bind(state);
    let refreshed = false;
    vi.spyOn(state, 'runExclusive').mockImplementation((async (fn: () => Promise<unknown>) => {
      if (!refreshed) {
        refreshed = true;
        await state.updateWorker('worker-a', { status: 'CODING' }); // bumps lastActivityAt to now
      }
      return realRun(fn);
    }) as typeof state.runExclusive);

    const result = await sweepStaleWorkers(state, {
      staleAfterMs: STALE_AFTER_MS,
      dryRun: false,
      now: () => Date.now(),
    });

    expect(result.released).toBe(0);
    const worker = state.getWorker('worker-a')!;
    expect(worker).not.toBeNull();
    expect(worker.status).toBe('CODING');
    const task = state.getTask('task-1')!;
    expect(task.assignedWorkerId).toBe('worker-a');
    expect(task.status).toBe('WORKING');
  });

  it('skips a worker that goes BLOCKED between the snapshot and the lock', async () => {
    writeTask({ assignedWorkerId: 'worker-a', status: 'WORKING' });
    writeWorker({ id: 'worker-a', currentTaskId: 'task-1', status: 'CODING', lastActivityAt: staleTimestamp() });
    await state.load();

    const realRun = state.runExclusive.bind(state);
    let flipped = false;
    vi.spyOn(state, 'runExclusive').mockImplementation((async (fn: () => Promise<unknown>) => {
      if (!flipped) {
        flipped = true;
        await state.updateWorker('worker-a', { status: 'BLOCKED' });
      }
      return realRun(fn);
    }) as typeof state.runExclusive);

    const result = await sweepStaleWorkers(state, {
      staleAfterMs: STALE_AFTER_MS,
      dryRun: false,
      now: () => Date.now(),
    });

    expect(result.released).toBe(0);
    expect(state.getWorker('worker-a')!.status).toBe('BLOCKED');
    const task = state.getTask('task-1')!;
    expect(task.assignedWorkerId).toBe('worker-a');
    expect(task.status).toBe('WORKING');
  });

  it('skips a still-stale worker whose task was released between the snapshot and the lock', async () => {
    writeTask({ assignedWorkerId: 'worker-a', status: 'WORKING' });
    writeWorker({ id: 'worker-a', currentTaskId: 'task-1', status: 'CODING', lastActivityAt: staleTimestamp() });
    await state.load();

    const realRun = state.runExclusive.bind(state);
    let released = false;
    vi.spyOn(state, 'runExclusive').mockImplementation((async (fn: () => Promise<unknown>) => {
      if (!released) {
        released = true;
        // A concurrent deregister already released this worker's only task.
        await state.updateTask('task-1', { assignedWorkerId: null, status: 'BACKLOG' }, 'WORKER_RELEASED');
      }
      return realRun(fn);
    }) as typeof state.runExclusive);

    const result = await sweepStaleWorkers(state, {
      staleAfterMs: STALE_AFTER_MS,
      dryRun: false,
      now: () => Date.now(),
    });

    expect(result.released).toBe(0);
    // Worker is left ALIVE for the Layer-3 prune sweep, not marked DEAD here.
    expect(state.getWorker('worker-a')!.status).toBe('CODING');
  });
});
