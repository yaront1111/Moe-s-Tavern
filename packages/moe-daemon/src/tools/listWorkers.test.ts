import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { StateManager } from '../state/StateManager.js';
import { listWorkersTool } from './listWorkers.js';
import type { Project, Epic, Worker } from '../types/schema.js';

describe('moe.list_workers', () => {
  let testDir: string;
  let moePath: string;
  let state: StateManager;

  function setupMoe() {
    fs.mkdirSync(moePath, { recursive: true });
    for (const sub of ['epics', 'tasks', 'workers', 'proposals']) {
      fs.mkdirSync(path.join(moePath, sub));
    }
    const project: Partial<Project> = {
      id: 'proj-test', schemaVersion: 6, name: 'Test', rootPath: testDir,
      globalRails: { techStack: [], forbiddenPatterns: [], requiredPatterns: [], formatting: '', testing: '', customRules: [] },
      settings: {
        approvalMode: 'TURBO', speedModeDelayMs: 2000, autoCreateBranch: false,
        branchPattern: '', commitPattern: '', agentCommand: 'claude', enableAgentTeams: false,
      },
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
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

  function writeWorker(overrides: Partial<Worker>): void {
    const now = new Date().toISOString();
    const worker: Worker = {
      id: 'w-default', type: 'CLAUDE', projectId: 'proj-test', epicId: 'epic-1',
      currentTaskId: null, status: 'IDLE', branch: '', modifiedFiles: [],
      startedAt: now, lastActivityAt: now, lastError: null, errorCount: 0, teamId: null,
      ...overrides,
    };
    fs.writeFileSync(path.join(moePath, 'workers', worker.id + '.json'), JSON.stringify(worker, null, 2));
  }

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moe-list-workers-'));
    moePath = path.join(testDir, '.moe');
    setupMoe();
    writeEpic();
    state = new StateManager({ projectPath: testDir });
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('reports alive vs stale workers based on lastActivityAt', async () => {
    const fresh = new Date().toISOString();
    const stale = new Date(Date.now() - 10 * 60_000).toISOString();
    writeWorker({ id: 'w-alive', lastActivityAt: fresh, status: 'CODING', currentTaskId: null });
    writeWorker({ id: 'w-dead', lastActivityAt: stale, status: 'CODING', currentTaskId: null });
    await state.load();

    const tool = listWorkersTool(state);
    const result = await tool.handler({}, state) as Record<string, unknown>;

    const workers = result.workers as Array<{ workerId: string; isAlive: boolean }>;
    const alive = workers.find((w) => w.workerId === 'w-alive')!;
    const dead = workers.find((w) => w.workerId === 'w-dead')!;
    expect(alive.isAlive).toBe(true);
    expect(dead.isAlive).toBe(false);

    const summary = result.summary as { alive: number; stale: number; total: number };
    expect(summary.total).toBe(2);
    expect(summary.alive).toBe(1);
    expect(summary.stale).toBe(1);
  });

  it('flags stale workers that still hold task assignments', async () => {
    const stale = new Date(Date.now() - 10 * 60_000).toISOString();
    writeWorker({ id: 'w-zombie', lastActivityAt: stale, status: 'CODING', currentTaskId: 'task-orphan' });
    // Write a task file the worker references so currentTaskTitle resolves
    const now = new Date().toISOString();
    fs.writeFileSync(path.join(moePath, 'tasks', 'task-orphan.json'), JSON.stringify({
      id: 'task-orphan', epicId: 'epic-1', title: 'Orphaned',
      description: '', definitionOfDone: [], taskRails: [], implementationPlan: [],
      status: 'WORKING', assignedWorkerId: 'w-zombie', branch: null, prLink: null,
      reopenCount: 0, reopenReason: null, createdBy: 'HUMAN', parentTaskId: null,
      priority: 'MEDIUM', order: 1, comments: [], createdAt: now, updatedAt: now,
    }));

    await state.load();
    const tool = listWorkersTool(state);
    const result = await tool.handler({}, state) as Record<string, unknown>;

    const stales = result.staleAssignments as Array<{ workerId: string; taskId: string; taskTitle: string }>;
    expect(stales).toHaveLength(1);
    expect(stales[0].workerId).toBe('w-zombie');
    expect(stales[0].taskId).toBe('task-orphan');
    expect(stales[0].taskTitle).toBe('Orphaned');
    expect(typeof result.hint).toBe('string');
  });

  it('respects onlyStale filter', async () => {
    const fresh = new Date().toISOString();
    const stale = new Date(Date.now() - 10 * 60_000).toISOString();
    writeWorker({ id: 'w-alive', lastActivityAt: fresh });
    writeWorker({ id: 'w-dead', lastActivityAt: stale });
    await state.load();

    const tool = listWorkersTool(state);
    const result = await tool.handler({ onlyStale: true }, state) as Record<string, unknown>;
    const workers = result.workers as Array<{ workerId: string }>;
    expect(workers.map((w) => w.workerId)).toEqual(['w-dead']);
  });

  it('rejects negative livenessTimeoutMs', async () => {
    await state.load();
    const tool = listWorkersTool(state);
    await expect(tool.handler({ livenessTimeoutMs: -1 }, state))
      .rejects.toThrow(/livenessTimeoutMs/);
  });
});
