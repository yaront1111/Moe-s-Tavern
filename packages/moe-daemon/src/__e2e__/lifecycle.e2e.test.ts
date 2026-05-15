// =============================================================================
// End-to-end lifecycle tests.
//
// Spec-mandated: catch lifecycle regressions across the full PLANNING →
// AWAITING_APPROVAL → WORKING → REVIEW → DONE cycle, including the rejection
// path and the auto-flip-to-PLANNING on same-DoD-item-failed-twice.
//
// Decision: we drive the tool handlers directly through the StateManager
// rather than spinning up the HTTP + WebSocket server. The goal here is to
// catch lifecycle regressions, not WS framing — and an in-process daemon
// would force these tests to deal with port allocation, supervisor restart
// loops, and shutdown ordering that the dedicated WebSocketServer tests
// already cover. The trade-off is documented inline so the next maintainer
// doesn't have to re-derive it.
// =============================================================================

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { StateManager } from '../state/StateManager.js';
import { submitPlanTool } from '../tools/submitPlan.js';
import { claimNextTaskTool } from '../tools/claimNextTask.js';
import { startStepTool } from '../tools/startStep.js';
import { completeStepTool } from '../tools/completeStep.js';
import { completeTaskTool } from '../tools/completeTask.js';
import { qaApproveTool } from '../tools/qaApprove.js';
import { qaRejectTool } from '../tools/qaReject.js';
import { setTaskStatusTool } from '../tools/setTaskStatus.js';
import type { Epic, Project, Task } from '../types/schema.js';

describe('lifecycle E2E', () => {
  let testDir: string;
  let moePath: string;
  let state: StateManager;

  function setupMoe() {
    fs.mkdirSync(moePath, { recursive: true });
    for (const sub of ['epics', 'tasks', 'workers', 'proposals', 'channels', 'messages', 'teams']) {
      fs.mkdirSync(path.join(moePath, sub));
    }
    const project: Partial<Project> = {
      id: 'proj-e2e',
      schemaVersion: 6,
      name: 'E2E',
      rootPath: testDir,
      globalRails: { techStack: [], forbiddenPatterns: [], requiredPatterns: [], formatting: '', testing: '', customRules: [] },
      settings: {
        approvalMode: 'CONTROL',
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
      id: 'epic-1', projectId: 'proj-e2e', title: 'Epic', description: '', architectureNotes: '',
      epicRails: [], status: 'ACTIVE', order: 1,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(moePath, 'epics', 'epic-1.json'), JSON.stringify(epic, null, 2));
  }

  function writeTask(overrides: Partial<Task> = {}): Task {
    const now = new Date().toISOString();
    const task: Task = {
      id: 'task-e2e', epicId: 'epic-1', title: 'E2E Task', description: 'desc',
      definitionOfDone: ['DoD1', 'DoD2'], taskRails: [], implementationPlan: [],
      status: 'PLANNING', assignedWorkerId: null, branch: null, prLink: null,
      reopenCount: 0, reopenReason: null, createdBy: 'HUMAN', parentTaskId: null,
      priority: 'MEDIUM', order: 1, comments: [],
      createdAt: now, updatedAt: now,
      ...overrides,
    };
    fs.writeFileSync(path.join(moePath, 'tasks', `${task.id}.json`), JSON.stringify(task, null, 2));
    return task;
  }

  async function approveAndClaimWorker(taskId: string, workerId: string): Promise<void> {
    // CONTROL mode plan stays in AWAITING_APPROVAL; auto-approve via setTaskStatus.
    const setStatus = setTaskStatusTool(state);
    await setStatus.handler({ taskId, status: 'WORKING' }, state);
    const claim = claimNextTaskTool(state);
    await claim.handler({ workerId, statuses: ['WORKING'], taskId }, state);
    // Worker also needs to record contextFetchedBy before start_step can run.
    await state.updateTask(taskId, { contextFetchedBy: [workerId] });
  }

  async function workThroughSteps(taskId: string, workerId: string): Promise<void> {
    const task = state.getTask(taskId)!;
    const startStep = startStepTool(state);
    const completeStep = completeStepTool(state);
    for (const step of task.implementationPlan) {
      if (step.status === 'COMPLETED') continue;
      await startStep.handler({ taskId, stepId: step.stepId, workerId }, state);
      await completeStep.handler({ taskId, stepId: step.stepId, workerId }, state);
    }
  }

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moe-e2e-'));
    moePath = path.join(testDir, '.moe');
    state = new StateManager({ projectPath: testDir });
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('runs a clean lifecycle: PLANNING → AWAITING_APPROVAL → WORKING → REVIEW → DONE', async () => {
    setupMoe();
    writeTask();
    await state.load();

    // 1. Architect submits plan → AWAITING_APPROVAL
    const submit = submitPlanTool(state);
    await submit.handler({
      taskId: 'task-e2e',
      steps: [
        { description: 'first', affectedFiles: ['a.ts'] },
        { description: 'second', affectedFiles: ['b.ts'] },
      ],
    }, state);
    expect(state.getTask('task-e2e')!.status).toBe('AWAITING_APPROVAL');

    // 2. Auto-approve → WORKING + claim worker
    await approveAndClaimWorker('task-e2e', 'worker-a');
    expect(state.getTask('task-e2e')!.status).toBe('WORKING');
    expect(state.getTask('task-e2e')!.assignedWorkerId).toBe('worker-a');

    // 3. Worker steps + complete_task
    await workThroughSteps('task-e2e', 'worker-a');
    const completeTask = completeTaskTool(state);
    await completeTask.handler({ taskId: 'task-e2e', workerId: 'worker-a' }, state);
    expect(state.getTask('task-e2e')!.status).toBe('REVIEW');

    // 4. QA claim + approve → DONE
    const claim = claimNextTaskTool(state);
    await claim.handler({ workerId: 'qa-1', statuses: ['REVIEW'], taskId: 'task-e2e' }, state);
    const qaApprove = qaApproveTool(state);
    await qaApprove.handler({ taskId: 'task-e2e', workerId: 'qa-1' }, state);

    const final = state.getTask('task-e2e')!;
    expect(final.status).toBe('DONE');
    const m = final.metrics!;
    expect(m.plannedStepCount).toBe(2);
    expect(m.executedStepCount).toBe(2);
    expect(m.firstClaimAt).toBeDefined();
    expect(m.doneAt).toBeDefined();
    expect(typeof m.wallClockMs).toBe('number');
    expect(m.wallClockMs!).toBeGreaterThanOrEqual(0);
  });

  it('drives a rejection cycle: qa_reject → re-claim → re-complete → qa_approve', async () => {
    setupMoe();
    writeTask();
    await state.load();

    const submit = submitPlanTool(state);
    await submit.handler({
      taskId: 'task-e2e',
      steps: [{ description: 'only', affectedFiles: ['a.ts'] }],
    }, state);
    await approveAndClaimWorker('task-e2e', 'worker-a');
    await workThroughSteps('task-e2e', 'worker-a');

    const completeTask = completeTaskTool(state);
    await completeTask.handler({ taskId: 'task-e2e', workerId: 'worker-a' }, state);

    // QA claim + reject
    const claim = claimNextTaskTool(state);
    await claim.handler({ workerId: 'qa-1', statuses: ['REVIEW'], taskId: 'task-e2e' }, state);
    const qaReject = qaRejectTool(state);
    await qaReject.handler({
      taskId: 'task-e2e',
      reason: 'tests missing',
      failedDodItems: ['DoD1'],
      workerId: 'qa-1',
    }, state);
    expect(state.getTask('task-e2e')!.status).toBe('WORKING');
    expect(state.getTask('task-e2e')!.metrics?.rejectCount).toBe(1);
    expect(state.getTask('task-e2e')!.rejectionHistory).toHaveLength(1);

    // Worker re-claims (reopened step is COMPLETED → no work; just hand back to QA)
    await claim.handler({ workerId: 'worker-a', statuses: ['WORKING'], taskId: 'task-e2e' }, state);
    await state.updateTask('task-e2e', { contextFetchedBy: ['worker-a'] });
    await completeTask.handler({ taskId: 'task-e2e', workerId: 'worker-a' }, state);

    await claim.handler({ workerId: 'qa-1', statuses: ['REVIEW'], taskId: 'task-e2e' }, state);
    const qaApprove = qaApproveTool(state);
    await qaApprove.handler({ taskId: 'task-e2e', workerId: 'qa-1' }, state);
    expect(state.getTask('task-e2e')!.status).toBe('DONE');
    expect(state.getTask('task-e2e')!.metrics?.rejectCount).toBe(1);
    expect(state.getTask('task-e2e')!.rejectionHistory).toHaveLength(1);
  });

  it('auto-flips to PLANNING when the same DoD item fails twice', async () => {
    setupMoe();
    // Bump maxReopens so reopen-cap does NOT trigger before same-item-twice.
    writeTask({ maxReopens: 10 });
    await state.load();

    const submit = submitPlanTool(state);
    await submit.handler({
      taskId: 'task-e2e',
      steps: [{ description: 'only', affectedFiles: ['a.ts'] }],
    }, state);
    await approveAndClaimWorker('task-e2e', 'worker-a');
    await workThroughSteps('task-e2e', 'worker-a');
    const completeTask = completeTaskTool(state);
    await completeTask.handler({ taskId: 'task-e2e', workerId: 'worker-a' }, state);

    const claim = claimNextTaskTool(state);
    const qaReject = qaRejectTool(state);

    // First reject on DoD1 → WORKING
    await claim.handler({ workerId: 'qa-1', statuses: ['REVIEW'], taskId: 'task-e2e' }, state);
    await qaReject.handler({
      taskId: 'task-e2e',
      reason: 'first fail',
      failedDodItems: ['DoD1'],
      workerId: 'qa-1',
    }, state);
    expect(state.getTask('task-e2e')!.status).toBe('WORKING');

    // Worker hands back to QA, second reject on SAME item → auto-flip PLANNING
    await state.updateTask('task-e2e', { status: 'REVIEW', assignedWorkerId: 'qa-1' });
    await qaReject.handler({
      taskId: 'task-e2e',
      reason: 'still fails',
      failedDodItems: ['DoD1'],
      workerId: 'qa-1',
    }, state);

    expect(state.getTask('task-e2e')!.status).toBe('PLANNING');
    expect(state.getTask('task-e2e')!.reopenCount).toBe(2);
  });
});
