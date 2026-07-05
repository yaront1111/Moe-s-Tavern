import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { StateManager } from '../state/StateManager.js';
import { qaRejectTool } from './qaReject.js';
import { claimNextTaskTool } from './claimNextTask.js';
import { MoeError, MoeErrorCode } from '../util/errors.js';
import type { Task, Epic, Project, WorkerStatus } from '../types/schema.js';

// Bounded-escalation + same-DoD-item behavior of moe.qa_reject.
describe('qa_reject bounded escalation', () => {
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
      id: 'epic-1', projectId: 'proj-test', title: '', description: '', architectureNotes: '',
      epicRails: [], status: 'ACTIVE', order: 1,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(moePath, 'epics', 'epic-1.json'), JSON.stringify(epic, null, 2));
    return epic;
  }

  function writeTask(overrides: Partial<Task> = {}): Task {
    const now = new Date().toISOString();
    const task: Task = {
      id: 'task-1', epicId: 'epic-1', title: 't', description: '',
      definitionOfDone: [], taskRails: [], implementationPlan: [],
      status: 'REVIEW', assignedWorkerId: 'qa-a', branch: null, prLink: null,
      reopenCount: 0, reopenReason: null, createdBy: 'HUMAN', parentTaskId: null,
      priority: 'MEDIUM', order: 1, comments: [],
      // Seed the context stamp so the qa_reject context guard passes — the real
      // flow records this via the preflight get_context.
      contextFetchedBy: ['qa-a'],
      createdAt: now, updatedAt: now,
      ...overrides,
    };
    fs.writeFileSync(path.join(moePath, 'tasks', `${task.id}.json`), JSON.stringify(task, null, 2));
    return task;
  }

  async function createWorker(id: string, status: WorkerStatus = 'CODING', currentTaskId: string | null = 'task-1') {
    return state.createWorker({
      id, type: 'CLAUDE', projectId: 'proj-test', epicId: 'epic-1', currentTaskId, status,
    });
  }

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moe-qa-reject-'));
    moePath = path.join(testDir, '.moe');
    state = new StateManager({ projectPath: testDir });
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  type RejectResult = {
    status: string;
    reopenCount: number;
    parkedForHuman: boolean;
    needsHumanReview: boolean;
    exceededReopenCap: boolean;
  };

  it('sends the task back to WORKING below the soft cap', async () => {
    // maxReopens default 3 → reopenCount 0 -> 1 stays WORKING.
    setupMoe(); writeEpic(); writeTask({ reopenCount: 0 });
    await state.load();
    const result = await qaRejectTool(state).handler(
      { taskId: 'task-1', reason: 'fix it', workerId: 'qa-a' }, state,
    ) as RejectResult;
    expect(result.status).toBe('WORKING');
    expect(result.reopenCount).toBe(1);
    expect(result.parkedForHuman).toBe(false);
  });

  it('flips to PLANNING once at the soft cap for a single re-plan', async () => {
    // reopenCount 2 -> 3 == maxReopens (soft cap) → PLANNING.
    setupMoe(); writeEpic(); writeTask({ reopenCount: 2 });
    await state.load();
    const result = await qaRejectTool(state).handler(
      { taskId: 'task-1', reason: 'still broken', workerId: 'qa-a' }, state,
    ) as RejectResult;
    expect(result.status).toBe('PLANNING');
    expect(result.reopenCount).toBe(3);
    expect(result.parkedForHuman).toBe(false);
    expect(result.exceededReopenCap).toBe(true);
  });

  it('parks in REVIEW for a human past the hard cap instead of re-flipping to PLANNING', async () => {
    // reopenCount 3 -> 4 > maxReopens (hard cap) → parked in REVIEW, unassigned.
    setupMoe(); writeEpic(); writeTask({ reopenCount: 3, assignedWorkerId: 'qa-a' });
    await state.load();
    await createWorker('qa-a', 'CODING', 'task-1');

    const result = await qaRejectTool(state).handler(
      { taskId: 'task-1', reason: 're-plan did not help', workerId: 'qa-a' }, state,
    ) as RejectResult;

    expect(result.status).toBe('REVIEW');
    expect(result.parkedForHuman).toBe(true);
    expect(result.needsHumanReview).toBe(true);

    const task = state.getTask('task-1');
    expect(task?.status).toBe('REVIEW');
    expect(task?.needsHumanReview).toBe(true);
    expect(task?.assignedWorkerId).toBeNull();
  });

  it('does not re-flip on repeated rejects past the hard cap (loop is bounded)', async () => {
    // A parked task stays parked; a further reject would require re-ownership,
    // but even the state proves no PLANNING churn: reopenCount 5 -> 6 stays parked.
    setupMoe(); writeEpic(); writeTask({ reopenCount: 5, assignedWorkerId: 'qa-a' });
    await state.load();
    const result = await qaRejectTool(state).handler(
      { taskId: 'task-1', reason: 'again', workerId: 'qa-a' }, state,
    ) as RejectResult;
    expect(result.status).toBe('REVIEW');
    expect(result.parkedForHuman).toBe(true);
  });

  it('excludes a parked REVIEW task from the ranked QA claim pool', async () => {
    setupMoe(); writeEpic();
    writeTask({ status: 'REVIEW', assignedWorkerId: null, needsHumanReview: true });
    await state.load();

    const result = await claimNextTaskTool(state).handler(
      { statuses: ['REVIEW'], workerId: 'qa-b' }, state,
    ) as { hasNext: boolean };
    expect(result.hasNext).toBe(false);
  });

  it('rejects an explicit claim of a parked REVIEW task', async () => {
    setupMoe(); writeEpic();
    writeTask({ status: 'REVIEW', assignedWorkerId: null, needsHumanReview: true });
    await state.load();

    await expect(
      claimNextTaskTool(state).handler(
        { statuses: ['REVIEW'], taskId: 'task-1', workerId: 'qa-b' }, state,
      ),
    ).rejects.toMatchObject({ code: MoeErrorCode.NOT_ALLOWED });
  });

  it('does not flip when the same DoD item is listed twice in ONE rejection', async () => {
    // Dedupe: duplicates within a single payload must NOT fake "failed twice".
    setupMoe(); writeEpic(); writeTask({ reopenCount: 0 });
    await state.load();
    const result = await qaRejectTool(state).handler(
      { taskId: 'task-1', reason: 'x', failedDodItems: ['DoD-X', 'DoD-X'], workerId: 'qa-a' }, state,
    ) as RejectResult;
    expect(result.status).toBe('WORKING');
  });

  it('flips to PLANNING only when the same DoD item fails across two distinct rejects', async () => {
    setupMoe(); writeEpic();
    // Pre-seed one prior failure of DoD-X in the log; a fresh failure of DoD-X
    // is now the second → same-item flip (below the reopen cap).
    writeTask({
      reopenCount: 0,
      failedDodItems: [{ item: 'DoD-X', rejectedAt: new Date().toISOString(), rejectedBy: 'qa-a' }],
    });
    await state.load();
    const result = await qaRejectTool(state).handler(
      { taskId: 'task-1', reason: 'x again', failedDodItems: ['DoD-X'], workerId: 'qa-a' }, state,
    ) as RejectResult;
    expect(result.status).toBe('PLANNING');
  });

  it('does NOT flip when the failed item differs from the prior attempt', async () => {
    setupMoe(); writeEpic();
    writeTask({
      reopenCount: 0,
      failedDodItems: [{ item: 'DoD-X', rejectedAt: new Date().toISOString(), rejectedBy: 'qa-a' }],
    });
    await state.load();
    const result = await qaRejectTool(state).handler(
      { taskId: 'task-1', reason: 'different item', failedDodItems: ['DoD-Y'], workerId: 'qa-a' }, state,
    ) as RejectResult;
    expect(result.status).toBe('WORKING');
  });
});
