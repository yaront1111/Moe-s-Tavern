import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { StateManager } from '../state/StateManager.js';
import { getContextTool } from './getContext.js';
import { submitPlanTool } from './submitPlan.js';
import { startStepTool } from './startStep.js';
import { completeStepTool } from './completeStep.js';
import { completeTaskTool } from './completeTask.js';
import { qaApproveTool } from './qaApprove.js';
import { MoeError, MoeErrorCode } from '../util/errors.js';
import type { Task, Epic, Project } from '../types/schema.js';

describe('Phase 3 enforcement integration flow', () => {
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
      status: 'PLANNING', assignedWorkerId: null, branch: null, prLink: null,
      reopenCount: 0, reopenReason: null, createdBy: 'HUMAN', parentTaskId: null,
      priority: 'MEDIUM', order: 1, comments: [],
      createdAt: now, updatedAt: now,
      ...overrides,
    };
    fs.writeFileSync(path.join(moePath, 'tasks', 'task-1.json'), JSON.stringify(task, null, 2));
    return task;
  }

  function expectNotAllowed(err: unknown): asserts err is MoeError {
    expect(err).toBeInstanceOf(MoeError);
    expect((err as MoeError).code).toBe(MoeErrorCode.NOT_ALLOWED);
  }

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moe-enforce-int-'));
    moePath = path.join(testDir, '.moe');
    state = new StateManager({ projectPath: testDir });
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('walks a task through the full approved flow with all guards in place', async () => {
    setupMoe();
    writeEpic();
    writeTask({ status: 'PLANNING', assignedWorkerId: 'architect-1' });
    await state.load();

    const submit = submitPlanTool(state);
    const ctx = getContextTool(state);
    const startStep = startStepTool(state);
    const completeStep = completeStepTool(state);
    const completeTask = completeTaskTool(state);
    const qaApprove = qaApproveTool(state);

    // Cross-worker submit_plan is rejected.
    try {
      await submit.handler({
        taskId: 'task-1',
        workerId: 'architect-2',
        steps: [{ description: 'Do a thing' }, { description: 'Do another' }],
      }, state);
      throw new Error('expected throw');
    } catch (err) { expectNotAllowed(err); }

    // Correct architect submits plan (TURBO → WORKING).
    await submit.handler({
      taskId: 'task-1',
      workerId: 'architect-1',
      steps: [{ description: 'Do a thing' }, { description: 'Do another' }],
    }, state);
    expect(state.getTask('task-1')?.status).toBe('WORKING');

    // Reassign task to worker-1 for the coding phase.
    await state.updateTask('task-1', { assignedWorkerId: 'worker-1' });

    // start_step before get_context is rejected.
    try {
      await startStep.handler({ taskId: 'task-1', stepId: 'step-1', workerId: 'worker-1' }, state);
      throw new Error('expected throw');
    } catch (err) {
      expectNotAllowed(err);
      expect((err as Error).message).toContain('moe.get_context');
    }

    // Cross-worker get_context does not enable worker-1.
    await ctx.handler({ taskId: 'task-1', workerId: 'worker-2' }, state);
    try {
      await startStep.handler({ taskId: 'task-1', stepId: 'step-1', workerId: 'worker-1' }, state);
      throw new Error('expected throw');
    } catch (err) { expectNotAllowed(err); }

    // Cross-worker start_step after worker-1 fetches context is still rejected for worker-2.
    await ctx.handler({ taskId: 'task-1', workerId: 'worker-1' }, state);
    try {
      await startStep.handler({ taskId: 'task-1', stepId: 'step-1', workerId: 'worker-3' }, state);
      throw new Error('expected throw');
    } catch (err) { expectNotAllowed(err); }

    // Happy-path start_step + complete_step for step-1.
    await startStep.handler({ taskId: 'task-1', stepId: 'step-1', workerId: 'worker-1' }, state);
    await completeStep.handler({ taskId: 'task-1', stepId: 'step-1', workerId: 'worker-1' }, state);

    // complete_task with a pending step is rejected.
    try {
      await completeTask.handler({ taskId: 'task-1', workerId: 'worker-1' }, state);
      throw new Error('expected throw');
    } catch (err) {
      expectNotAllowed(err);
      expect((err as Error).message).toContain('1 step');
    }

    // Finish step-2 and try complete_task with wrong worker.
    await startStep.handler({ taskId: 'task-1', stepId: 'step-2', workerId: 'worker-1' }, state);
    await completeStep.handler({ taskId: 'task-1', stepId: 'step-2', workerId: 'worker-1' }, state);

    try {
      await completeTask.handler({ taskId: 'task-1', workerId: 'worker-2' }, state);
      throw new Error('expected throw');
    } catch (err) { expectNotAllowed(err); }

    // Owner completes the task.
    await completeTask.handler({ taskId: 'task-1', workerId: 'worker-1' }, state);
    expect(state.getTask('task-1')?.status).toBe('REVIEW');

    // Assign a QA worker and validate QA ownership.
    await state.updateTask('task-1', { assignedWorkerId: 'qa-1' });
    try {
      await qaApprove.handler({ taskId: 'task-1', workerId: 'qa-2' }, state);
      throw new Error('expected throw');
    } catch (err) { expectNotAllowed(err); }

    await qaApprove.handler({ taskId: 'task-1', workerId: 'qa-1' }, state);
    expect(state.getTask('task-1')?.status).toBe('DONE');
    expect(state.getTask('task-1')?.stepsCompleted).toEqual(['step-1', 'step-2']);
  });
});
