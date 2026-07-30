import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { cancelSpeedModeTimeout, clearAllSpeedModeTimeouts, MAX_STEP_DESCRIPTION_CHARS } from './submitPlan.js';
import { MoeError, MoeErrorCode } from '../util/errors.js';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { StateManager } from '../state/StateManager.js';
import { submitPlanTool } from './submitPlan.js';
import type { Task, Epic, Project, WorkerStatus } from '../types/schema.js';

describe('SPEED mode timeout cancellation', () => {
  let testDir: string;
  let moePath: string;
  let state: StateManager;

  function setupMoeFolder(projectOverrides: Partial<Project> = {}) {
    fs.mkdirSync(moePath, { recursive: true });
    fs.mkdirSync(path.join(moePath, 'epics'));
    fs.mkdirSync(path.join(moePath, 'tasks'));
    fs.mkdirSync(path.join(moePath, 'workers'));
    fs.mkdirSync(path.join(moePath, 'proposals'));

    const project = {
      id: 'proj-test',
      name: 'Test Project',
      rootPath: testDir,
      globalRails: {
        techStack: [],
        forbiddenPatterns: [],
        requiredPatterns: [],
        formatting: '',
        testing: '',
        customRules: [],
      },
      settings: {
        approvalMode: 'SPEED',
        speedModeDelayMs: 5000,
        autoCreateBranch: true,
        branchPattern: 'moe/{epicId}/{taskId}',
        commitPattern: 'feat({epicId}): {taskTitle}',
        agentCommand: 'claude',
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...projectOverrides,
    };

    fs.writeFileSync(path.join(moePath, 'project.json'), JSON.stringify(project, null, 2));
    return project;
  }

  function createEpic(overrides: Partial<Epic> = {}): Epic {
    const epic: Epic = {
      id: 'epic-1',
      projectId: 'proj-test',
      title: 'Test Epic',
      description: '',
      architectureNotes: '',
      epicRails: [],
      status: 'ACTIVE',
      order: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...overrides,
    };
    fs.writeFileSync(path.join(moePath, 'epics', `${epic.id}.json`), JSON.stringify(epic, null, 2));
    return epic;
  }

  function createTask(overrides: Partial<Task> = {}): Task {
    const task: Task = {
      id: 'task-1',
      epicId: 'epic-1',
      title: 'Test Task',
      description: '',
      definitionOfDone: ['Done'],
      taskRails: [],
      implementationPlan: [],
      status: 'PLANNING',
      assignedWorkerId: null,
      branch: null,
      prLink: null,
      reopenCount: 0,
      reopenReason: null,
      createdBy: 'HUMAN',
      parentTaskId: null,
      order: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...overrides,
    };
    fs.writeFileSync(path.join(moePath, 'tasks', `${task.id}.json`), JSON.stringify(task, null, 2));
    return task;
  }

  async function createWorker(id: string, status: WorkerStatus = 'PLANNING', currentTaskId: string | null = 'task-1') {
    return state.createWorker({
      id,
      type: 'CLAUDE',
      projectId: 'proj-test',
      epicId: 'epic-1',
      currentTaskId,
      status,
    });
  }

  beforeEach(() => {
    vi.useFakeTimers();
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moe-speed-test-'));
    moePath = path.join(testDir, '.moe');
    state = new StateManager({ projectPath: testDir });
  });

  afterEach(() => {
    clearAllSpeedModeTimeouts();
    vi.useRealTimers();
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('cancelSpeedModeTimeout cancels a tracked timeout', async () => {
    setupMoeFolder();
    createEpic();
    createTask({ id: 'task-speed-1', status: 'PLANNING' });
    await state.load();

    const tool = submitPlanTool(state);
    await tool.handler({
      taskId: 'task-speed-1',
      steps: [{ description: 'Step 1' }],
    }, state);

    // Task should be AWAITING_APPROVAL
    expect(state.getTask('task-speed-1')?.status).toBe('AWAITING_APPROVAL');

    // Cancel the timeout before it fires
    cancelSpeedModeTimeout('task-speed-1');

    // Advance time past the delay
    vi.advanceTimersByTime(6000);

    // Task should still be AWAITING_APPROVAL since timeout was cancelled
    expect(state.getTask('task-speed-1')?.status).toBe('AWAITING_APPROVAL');
  });

  it('clearAllSpeedModeTimeouts cancels all tracked timeouts', async () => {
    setupMoeFolder();
    createEpic();
    createTask({ id: 'task-s1', status: 'PLANNING' });
    createTask({ id: 'task-s2', status: 'PLANNING', order: 2 });
    await state.load();

    const tool = submitPlanTool(state);

    // Submit plans for both tasks (each creates a SPEED mode timeout)
    await tool.handler({ taskId: 'task-s1', steps: [{ description: 'Step 1' }] }, state);
    // task-s1 moved to AWAITING_APPROVAL, need to set task-s2 to PLANNING for submit
    await tool.handler({ taskId: 'task-s2', steps: [{ description: 'Step 1' }] }, state);

    expect(state.getTask('task-s1')?.status).toBe('AWAITING_APPROVAL');
    expect(state.getTask('task-s2')?.status).toBe('AWAITING_APPROVAL');

    // Clear all timeouts (simulating shutdown)
    clearAllSpeedModeTimeouts();

    // Advance time past the delay
    vi.advanceTimersByTime(6000);

    // Both tasks should still be AWAITING_APPROVAL
    expect(state.getTask('task-s1')?.status).toBe('AWAITING_APPROVAL');
    expect(state.getTask('task-s2')?.status).toBe('AWAITING_APPROVAL');
  });

  it('cancelSpeedModeTimeout is a no-op for unknown taskId', () => {
    // Should not throw
    cancelSpeedModeTimeout('nonexistent-task');
  });

  it('rejects submit_plan when workerId does not match assignedWorkerId', async () => {
    setupMoeFolder();
    createEpic();
    createTask({ id: 'task-own', status: 'PLANNING', assignedWorkerId: 'architect-a' });
    await state.load();

    const tool = submitPlanTool(state);
    try {
      await tool.handler({
        taskId: 'task-own',
        workerId: 'architect-b',
        steps: [{ description: 'Step 1' }],
      }, state);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(MoeError);
      expect((err as MoeError).code).toBe(MoeErrorCode.NOT_ALLOWED);
    }
    expect(state.getTask('task-own')?.status).toBe('PLANNING');
  });

  it('accepts submit_plan when workerId matches assignedWorkerId', async () => {
    setupMoeFolder();
    createEpic();
    createTask({ id: 'task-own2', status: 'PLANNING', assignedWorkerId: 'architect-a' });
    await state.load();

    const tool = submitPlanTool(state);
    await tool.handler({
      taskId: 'task-own2',
      workerId: 'architect-a',
      steps: [{ description: 'Step 1' }],
    }, state);
    expect(state.getTask('task-own2')?.status).toBe('AWAITING_APPROVAL');
  });

  it('scrubs failedDodItems on a fresh plan so the same-item net counts only within the new attempt', async () => {
    setupMoeFolder();
    createEpic();
    createTask({
      id: 'task-clear',
      status: 'PLANNING',
      assignedWorkerId: 'architect-a',
      failedDodItems: [{ item: 'DoD-X', rejectedAt: new Date().toISOString(), rejectedBy: 'qa-1' }],
    });
    await state.load();

    const tool = submitPlanTool(state);
    await tool.handler({
      taskId: 'task-clear',
      workerId: 'architect-a',
      steps: [{ description: 'Step 1' }],
    }, state);
    expect(state.getTask('task-clear')?.failedDodItems).toEqual([]);
  });

  it('releases the assigned architect worker after TURBO auto-approval', async () => {
    setupMoeFolder({
      settings: {
        approvalMode: 'TURBO',
        speedModeDelayMs: 5000,
        autoCreateBranch: true,
        branchPattern: 'moe/{epicId}/{taskId}',
        commitPattern: 'feat({epicId}): {taskTitle}',
        agentCommand: 'claude',
        enableAgentTeams: false,
      },
    });
    createEpic();
    createTask({ id: 'task-turbo', status: 'PLANNING', assignedWorkerId: 'architect-a' });
    await state.load();
    await createWorker('architect-a', 'PLANNING', 'task-turbo');

    const tool = submitPlanTool(state);
    const result = await tool.handler({
      taskId: 'task-turbo',
      workerId: 'architect-a',
      steps: [{ description: 'Step 1' }],
    }, state) as { status: string };

    expect(result.status).toBe('WORKING');
    expect(state.getTask('task-turbo')?.assignedWorkerId).toBeNull();
    expect(state.getWorker('architect-a')?.status).toBe('IDLE');
    expect(state.getWorker('architect-a')?.currentTaskId).toBeNull();
  });

  it('releases the assigned architect worker after non-TURBO plan submission', async () => {
    setupMoeFolder({
      settings: {
        approvalMode: 'CONTROL',
        speedModeDelayMs: 5000,
        autoCreateBranch: true,
        branchPattern: 'moe/{epicId}/{taskId}',
        commitPattern: 'feat({epicId}): {taskTitle}',
        agentCommand: 'claude',
        enableAgentTeams: false,
      },
    });
    createEpic();
    createTask({ id: 'task-control', status: 'PLANNING', assignedWorkerId: 'architect-a' });
    await state.load();
    await createWorker('architect-a', 'PLANNING', 'task-control');

    const tool = submitPlanTool(state);
    const result = await tool.handler({
      taskId: 'task-control',
      workerId: 'architect-a',
      steps: [{ description: 'Step 1' }],
    }, state) as { status: string };

    expect(result.status).toBe('AWAITING_APPROVAL');
    expect(state.getTask('task-control')?.assignedWorkerId).toBeNull();
    expect(state.getWorker('architect-a')?.status).toBe('IDLE');
    expect(state.getWorker('architect-a')?.currentTaskId).toBeNull();
  });

  it('does not block plan handoff when the assigned architect worker record is missing', async () => {
    setupMoeFolder({
      settings: {
        approvalMode: 'CONTROL',
        speedModeDelayMs: 5000,
        autoCreateBranch: true,
        branchPattern: 'moe/{epicId}/{taskId}',
        commitPattern: 'feat({epicId}): {taskTitle}',
        agentCommand: 'claude',
        enableAgentTeams: false,
      },
    });
    createEpic();
    createTask({ id: 'task-missing-worker', status: 'PLANNING', assignedWorkerId: 'architect-missing' });
    await state.load();

    const tool = submitPlanTool(state);
    const result = await tool.handler({
      taskId: 'task-missing-worker',
      workerId: 'architect-missing',
      steps: [{ description: 'Step 1' }],
    }, state) as { status: string };

    expect(result.status).toBe('AWAITING_APPROVAL');
    expect(state.getTask('task-missing-worker')?.assignedWorkerId).toBeNull();
    expect(state.getWorker('architect-missing')).toBeNull();
  });

  it('accepts step descriptions longer than 2000 chars up to the cap', async () => {
    setupMoeFolder();
    createEpic();
    createTask({ id: 'task-long-step', status: 'PLANNING' });
    await state.load();

    const tool = submitPlanTool(state);
    await tool.handler({
      taskId: 'task-long-step',
      steps: [{ description: 'x'.repeat(MAX_STEP_DESCRIPTION_CHARS) }],
    }, state);
    expect(state.getTask('task-long-step')?.status).toBe('AWAITING_APPROVAL');
  });

  it('rejects step descriptions over the cap', async () => {
    setupMoeFolder();
    createEpic();
    createTask({ id: 'task-too-long-step', status: 'PLANNING' });
    await state.load();

    const tool = submitPlanTool(state);
    await expect(tool.handler({
      taskId: 'task-too-long-step',
      steps: [{ description: 'x'.repeat(MAX_STEP_DESCRIPTION_CHARS + 1) }],
    }, state)).rejects.toThrow(/description too long/);
    expect(state.getTask('task-too-long-step')?.status).toBe('PLANNING');
  });

  it('timeout auto-approves when not cancelled', async () => {
    setupMoeFolder();
    createEpic();
    createTask({ id: 'task-auto', status: 'PLANNING' });
    await state.load();

    const tool = submitPlanTool(state);
    await tool.handler({
      taskId: 'task-auto',
      steps: [{ description: 'Step 1' }],
    }, state);

    expect(state.getTask('task-auto')?.status).toBe('AWAITING_APPROVAL');

    // Advance time past the delay without cancelling
    await vi.advanceTimersByTimeAsync(6000);

    // The auto-approval persists via real async fs I/O (atomicWriteJsonAsync,
    // which yields the event loop instead of blocking it) and only flips the
    // in-memory status after that write resolves — fake timers don't drive real
    // I/O, so restore real timers and poll until it settles.
    vi.useRealTimers();
    await vi.waitFor(
      () => expect(state.getTask('task-auto')?.status).toBe('WORKING'),
      { timeout: 2000, interval: 20 }
    );
  });
});

describe('plan-size gate', () => {
  let testDir: string;
  let moePath: string;
  let state: StateManager;

  function setupMoeFolder(settingsOverrides: Record<string, unknown> = {}) {
    fs.mkdirSync(moePath, { recursive: true });
    for (const sub of ['epics', 'tasks', 'workers', 'proposals']) {
      fs.mkdirSync(path.join(moePath, sub));
    }
    const project = {
      id: 'proj-test',
      name: 'Test Project',
      rootPath: testDir,
      globalRails: {
        techStack: [], forbiddenPatterns: [], requiredPatterns: [],
        formatting: '', testing: '', customRules: [],
      },
      settings: {
        approvalMode: 'TURBO',
        speedModeDelayMs: 2000,
        autoCreateBranch: false,
        branchPattern: '',
        commitPattern: '',
        agentCommand: 'claude',
        enableAgentTeams: false,
        ...settingsOverrides,
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(moePath, 'project.json'), JSON.stringify(project, null, 2));
  }

  function writeTask(overrides: Record<string, unknown> = {}) {
    const now = new Date().toISOString();
    const task = {
      id: 'task-size', epicId: 'epic-1', title: 'Size gate task', description: '',
      definitionOfDone: ['Done'], taskRails: [], implementationPlan: [],
      status: 'PLANNING', assignedWorkerId: null, branch: null, prLink: null,
      reopenCount: 0, reopenReason: null, createdBy: 'HUMAN', parentTaskId: null,
      priority: 'MEDIUM', order: 1, comments: [], createdAt: now, updatedAt: now,
      ...overrides,
    };
    fs.writeFileSync(path.join(moePath, 'tasks', 'task-size.json'), JSON.stringify(task, null, 2));
  }

  function writeEpic() {
    const epic = {
      id: 'epic-1', projectId: 'proj-test', title: 'Epic', description: '',
      architectureNotes: '', epicRails: [], status: 'ACTIVE', order: 1,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(moePath, 'epics', 'epic-1.json'), JSON.stringify(epic, null, 2));
  }

  function makeSteps(count: number, filesPerStep: string[][] = []) {
    return Array.from({ length: count }, (_, i) => ({
      description: `Step ${i + 1}`,
      ...(filesPerStep[i] ? { affectedFiles: filesPerStep[i] } : {}),
    }));
  }

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moe-plan-size-'));
    moePath = path.join(testDir, '.moe');
    state = new StateManager({ projectPath: testDir });
  });

  afterEach(() => {
    clearAllSpeedModeTimeouts();
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('accepts a plan within bounds with no warnings', async () => {
    setupMoeFolder();
    writeEpic();
    writeTask();
    await state.load();
    const tool = submitPlanTool(state);
    const result = await tool.handler({ taskId: 'task-size', steps: makeSteps(8) }, state) as {
      warnings?: string[]; distinctFileCount: number;
    };
    expect(result.warnings).toBeUndefined();
    expect(result.distinctFileCount).toBe(0);
  });

  it('returns warnings past the warn thresholds', async () => {
    setupMoeFolder();
    writeEpic();
    writeTask();
    await state.load();
    const tool = submitPlanTool(state);
    const result = await tool.handler({
      taskId: 'task-size',
      steps: makeSteps(9, [['a.ts', 'b.ts', 'c.ts'], ['d.ts', 'e.ts', 'f.ts']]),
    }, state) as { warnings?: string[] };
    expect(result.warnings).toBeDefined();
    expect(result.warnings!.length).toBe(2);
    expect(result.warnings![0]).toContain('9 steps');
    expect(result.warnings![1]).toContain('6 distinct files');
  });

  it('hard-rejects a plan past maxSteps with split guidance', async () => {
    setupMoeFolder();
    writeEpic();
    writeTask();
    await state.load();
    const tool = submitPlanTool(state);
    try {
      await tool.handler({ taskId: 'task-size', steps: makeSteps(13) }, state);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(MoeError);
      expect((err as MoeError).code).toBe(MoeErrorCode.CONSTRAINT_VIOLATION);
      expect((err as Error).message).toContain('13 steps (max 12)');
      expect((err as Error).message).toContain('SPIDR');
      expect(((err as MoeError).context as { suggestedAction?: { tool: string } }).suggestedAction?.tool).toBe('moe.create_task');
    }
    expect(state.getTask('task-size')?.status).toBe('PLANNING');
  });

  it('hard-rejects a plan past maxDistinctFiles', async () => {
    setupMoeFolder();
    writeEpic();
    writeTask();
    await state.load();
    const tool = submitPlanTool(state);
    const files = Array.from({ length: 11 }, (_, i) => [`src/f${i}.ts`]);
    try {
      await tool.handler({ taskId: 'task-size', steps: makeSteps(11, files) }, state);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(MoeError);
      expect((err as Error).message).toContain('11 distinct affected files (max 10)');
    }
  });

  it('honors settings.taskSizing overrides', async () => {
    setupMoeFolder({ taskSizing: { warnSteps: 2, maxSteps: 3 } });
    writeEpic();
    writeTask();
    await state.load();
    const tool = submitPlanTool(state);
    try {
      await tool.handler({ taskId: 'task-size', steps: makeSteps(4) }, state);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(MoeError);
      expect((err as Error).message).toContain('4 steps (max 3)');
    }
  });

  it('persists planSizeWarnings on warn and clears them on a compliant resubmit', async () => {
    setupMoeFolder();
    writeEpic();
    writeTask();
    await state.load();
    const tool = submitPlanTool(state);
    await tool.handler({ taskId: 'task-size', steps: makeSteps(9) }, state);
    expect(state.getTask('task-size')?.planSizeWarnings?.length).toBe(1);
    // TURBO auto-approved to WORKING; force back to PLANNING for the resubmit.
    await state.updateTask('task-size', { status: 'PLANNING' });
    await tool.handler({ taskId: 'task-size', steps: makeSteps(4) }, state);
    expect(state.getTask('task-size')?.planSizeWarnings).toBeFalsy();
  });

  it('auto-blocks a warn-zone plan in CONTROL mode with autoCritique on and no governor', async () => {
    setupMoeFolder({ approvalMode: 'CONTROL', taskSizing: { autoCritique: true } });
    writeEpic();
    writeTask();
    await state.load();
    const tool = submitPlanTool(state);
    const result = await tool.handler({ taskId: 'task-size', steps: makeSteps(9) }, state) as {
      status: string; warnings?: string[]; nextAction: { tool: string };
    };
    expect(result.status).toBe('PLANNING');
    expect(result.nextAction.tool).toBe('moe.claim_next_task');
    const task = state.getTask('task-size')!;
    expect(task.status).toBe('PLANNING');
    expect(task.critiqueBlockCount).toBe(1);
    expect(task.planCritiqueResult?.verdict).toBe('block');
    expect(task.planCritiqueResult?.reviewedBy).toBe('moe-daemon-size-critic');
    expect(task.planSizeWarnings?.length).toBe(1);
  });

  it('does not auto-block when autoCritique is off (default)', async () => {
    setupMoeFolder({ approvalMode: 'CONTROL' });
    writeEpic();
    writeTask();
    await state.load();
    const tool = submitPlanTool(state);
    const result = await tool.handler({ taskId: 'task-size', steps: makeSteps(9) }, state) as {
      status: string; warnings?: string[];
    };
    expect(result.status).toBe('AWAITING_APPROVAL');
    expect(result.warnings?.length).toBe(1);
    expect(state.getTask('task-size')?.status).toBe('AWAITING_APPROVAL');
    expect(state.getTask('task-size')?.critiqueBlockCount).toBeUndefined();
  });

  it('stops auto-blocking at the critique cap and rests in AWAITING_APPROVAL', async () => {
    setupMoeFolder({ approvalMode: 'CONTROL', taskSizing: { autoCritique: true } });
    writeEpic();
    writeTask({ critiqueBlockCount: 2 });
    await state.load();
    const tool = submitPlanTool(state);
    const result = await tool.handler({ taskId: 'task-size', steps: makeSteps(9) }, state) as { status: string };
    expect(result.status).toBe('AWAITING_APPROVAL');
    const task = state.getTask('task-size')!;
    expect(task.status).toBe('AWAITING_APPROVAL');
    expect(task.critiqueBlockCount).toBe(2);
  });

  it('records plannedDistinctFileCount in metrics', async () => {
    setupMoeFolder();
    writeEpic();
    writeTask();
    await state.load();
    const tool = submitPlanTool(state);
    await tool.handler({
      taskId: 'task-size',
      steps: makeSteps(3, [['a.ts', 'b.ts'], ['b.ts', 'c.ts']]),
    }, state);
    expect(state.getTask('task-size')?.metrics?.plannedDistinctFileCount).toBe(3);
  });
});
