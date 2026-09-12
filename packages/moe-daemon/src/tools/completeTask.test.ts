import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { StateManager } from '../state/StateManager.js';
import { completeTaskTool } from './completeTask.js';
import { MoeError, MoeErrorCode } from '../util/errors.js';
import { listAttempts, openAttempt } from '../state/attemptStore.js';
import type { ExecutionAttempt, Task, Epic, Project, ProjectSettings } from '../types/schema.js';

describe('moe.complete_task ownership + ordering enforcement', () => {
  let testDir: string;
  let moePath: string;
  let state: StateManager;

  function setupMoe(settingsOverrides: Partial<ProjectSettings> = {}) {
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
        ...settingsOverrides,
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
      definitionOfDone: [], taskRails: [],
      implementationPlan: [
        { stepId: 'step-1', description: 'first', status: 'COMPLETED', affectedFiles: [] },
      ],
      status: 'WORKING', assignedWorkerId: 'worker-a', branch: null, prLink: null,
      reopenCount: 0, reopenReason: null, createdBy: 'HUMAN', parentTaskId: null,
      priority: 'MEDIUM', order: 1, comments: [],
      createdAt: now, updatedAt: now,
      ...overrides,
    };
    fs.writeFileSync(path.join(moePath, 'tasks', 'task-1.json'), JSON.stringify(task, null, 2));
    return task;
  }

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moe-complete-task-'));
    moePath = path.join(testDir, '.moe');
    state = new StateManager({ projectPath: testDir });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('rejects when any step is still PENDING', async () => {
    setupMoe();
    writeEpic();
    writeTask({
      implementationPlan: [
        { stepId: 'step-1', description: 'first', status: 'COMPLETED', affectedFiles: [] },
        { stepId: 'step-2', description: 'second', status: 'PENDING', affectedFiles: [] },
      ],
    });
    await state.load();
    const tool = completeTaskTool(state);
    try {
      await tool.handler({ taskId: 'task-1', workerId: 'worker-a' }, state);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(MoeError);
      expect((err as MoeError).code).toBe(MoeErrorCode.NOT_ALLOWED);
      expect((err as Error).message).toContain('1 step');
    }
    expect(state.getTask('task-1')?.status).toBe('WORKING');
  });

  it('rejects when task is not in WORKING state (e.g. already REVIEW)', async () => {
    setupMoe();
    writeEpic();
    writeTask({ status: 'REVIEW' });
    await state.load();
    const tool = completeTaskTool(state);
    try {
      await tool.handler({ taskId: 'task-1', workerId: 'worker-a' }, state);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(MoeError);
      expect((err as MoeError).code).toBe(MoeErrorCode.INVALID_STATE);
    }
  });

  it('rejects when a different worker attempts to complete', async () => {
    setupMoe();
    writeEpic();
    writeTask();
    await state.load();
    const tool = completeTaskTool(state);
    try {
      await tool.handler({ taskId: 'task-1', workerId: 'worker-b' }, state);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(MoeError);
      expect((err as MoeError).code).toBe(MoeErrorCode.NOT_ALLOWED);
    }
  });

  it('moves task to REVIEW when all guards pass', async () => {
    setupMoe();
    writeEpic();
    writeTask();
    await state.load();
    const tool = completeTaskTool(state);
    const result = await tool.handler(
      { taskId: 'task-1', workerId: 'worker-a', verification: { command: 'npm test', exitCode: 0, outputTail: '12 passed' } },
      state
    ) as { status: string };
    expect(result.status).toBe('REVIEW');
    expect(state.getTask('task-1')?.status).toBe('REVIEW');
  });

  it('rejects when verification evidence is missing', async () => {
    setupMoe();
    writeEpic();
    writeTask();
    await state.load();
    const tool = completeTaskTool(state);
    try {
      await tool.handler({ taskId: 'task-1', workerId: 'worker-a' }, state);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(MoeError);
      expect((err as MoeError).code).toBe(MoeErrorCode.MISSING_REQUIRED);
      expect((err as Error).message).toContain('verification');
    }
    expect(state.getTask('task-1')?.status).toBe('WORKING');
  });

  it('rejects when the verification command exited non-zero', async () => {
    setupMoe();
    writeEpic();
    writeTask();
    await state.load();
    const tool = completeTaskTool(state);
    try {
      await tool.handler(
        { taskId: 'task-1', workerId: 'worker-a', verification: { command: 'npm test', exitCode: 1 } },
        state
      );
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(MoeError);
      expect((err as MoeError).code).toBe(MoeErrorCode.INVALID_INPUT);
      expect((err as Error).message).toContain('exit 1');
    }
    expect(state.getTask('task-1')?.status).toBe('WORKING');
  });

  it('persists verification evidence and the aggregated filesModified', async () => {
    setupMoe();
    writeEpic();
    writeTask({
      implementationPlan: [
        { stepId: 'step-1', description: 'first', status: 'COMPLETED', affectedFiles: ['a.ts'], modifiedFiles: ['a.ts', 'b.ts'] },
        { stepId: 'step-2', description: 'second', status: 'COMPLETED', affectedFiles: ['b.ts', 'c.ts'] },
      ],
    });
    await state.load();
    const tool = completeTaskTool(state);
    await tool.handler(
      { taskId: 'task-1', workerId: 'worker-a', verification: { command: 'npx vitest run', exitCode: 0, outputTail: 'ok' } },
      state
    );
    const task = state.getTask('task-1');
    expect(task?.verification?.command).toBe('npx vitest run');
    expect(task?.verification?.exitCode).toBe(0);
    expect(task?.verification?.outputTail).toBe('ok');
    expect(task?.verification?.reportedAt).toBeTruthy();
    expect(task?.filesModified).toEqual(['a.ts', 'b.ts', 'c.ts']);
  });

  describe('consolidationBranch policy', () => {
    const PATTERN = 'moe/work-*';
    const VERIFICATION = { command: 'npx vitest run', exitCode: 0, outputTail: 'ok' };

    interface CompleteResult {
      status: string;
      branchPolicy?: { pattern: string; currentBranch?: string; matched: boolean | null; warning?: string };
    }

    async function boot(settings: Partial<ProjectSettings> = { consolidationBranch: PATTERN }) {
      setupMoe(settings);
      writeEpic();
      writeTask();
      await state.load();
      const governorsPost = vi.spyOn(state, 'postToRoleChannel').mockResolvedValue(undefined);
      return { tool: completeTaskTool(state), governorsPost };
    }

    it('completes when the reported branch matches the pattern', async () => {
      const { tool } = await boot();
      const result = await tool.handler(
        { taskId: 'task-1', workerId: 'worker-a', verification: VERIFICATION, currentBranch: 'moe/work-2026-07-31' },
        state
      ) as CompleteResult;

      expect(result.status).toBe('REVIEW');
      expect(result.branchPolicy).toEqual({
        pattern: PATTERN,
        currentBranch: 'moe/work-2026-07-31',
        matched: true,
      });
      expect(state.getTask('task-1')?.status).toBe('REVIEW');
    });

    it('rejects a mismatched branch before touching the task', async () => {
      const { tool } = await boot();
      try {
        await tool.handler(
          { taskId: 'task-1', workerId: 'worker-a', verification: VERIFICATION, currentBranch: 'main' },
          state
        );
        throw new Error('expected throw');
      } catch (err) {
        expect(err).toBeInstanceOf(MoeError);
        expect((err as MoeError).code).toBe(MoeErrorCode.CONSTRAINT_VIOLATION);
        expect((err as MoeError).codeName).toBe('CONSTRAINT_VIOLATION');
        expect((err as Error).message).toContain('BRANCH-POLICY-FAIL');
        expect((err as Error).message).toContain('main');
        expect((err as Error).message).toContain(PATTERN);
        expect((err as MoeError).context).toEqual({ currentBranch: 'main', expectedPattern: PATTERN });
      }

      const task = state.getTask('task-1');
      expect(task?.status).toBe('WORKING');
      expect(task?.verification).toBeFalsy();
    });

    it('warns #governors but does not block when no branch is reported', async () => {
      const { tool, governorsPost } = await boot();
      const result = await tool.handler(
        { taskId: 'task-1', workerId: 'worker-a', verification: VERIFICATION },
        state
      ) as CompleteResult;

      expect(result.status).toBe('REVIEW');
      expect(result.branchPolicy?.matched).toBeNull();
      expect(result.branchPolicy?.warning).toContain('not enforced');
      expect(governorsPost).toHaveBeenCalledTimes(1);
      expect(governorsPost.mock.calls[0][0]).toBe('governors');
      expect(governorsPost.mock.calls[0][1]).toContain(PATTERN);
    });

    it('treats a whitespace-only branch as not reported', async () => {
      const { tool, governorsPost } = await boot();
      const result = await tool.handler(
        { taskId: 'task-1', workerId: 'worker-a', verification: VERIFICATION, currentBranch: '   ' },
        state
      ) as CompleteResult;

      expect(result.status).toBe('REVIEW');
      expect(result.branchPolicy?.matched).toBeNull();
      expect(governorsPost).toHaveBeenCalledTimes(1);
    });

    it('leaves unconfigured projects completely untouched', async () => {
      const { tool, governorsPost } = await boot({});
      const result = await tool.handler(
        { taskId: 'task-1', workerId: 'worker-a', verification: VERIFICATION, currentBranch: 'main' },
        state
      ) as CompleteResult;

      expect(result.status).toBe('REVIEW');
      expect(result.branchPolicy).toBeUndefined();
      expect(governorsPost).toHaveBeenCalledTimes(0);
    });

    it('disables the check when a hand-edited setting is not a string', async () => {
      // project.json can be edited by hand, bypassing validateSettingsUpdate.
      const { tool, governorsPost } = await boot({ consolidationBranch: 42 as unknown as string });
      const result = await tool.handler(
        { taskId: 'task-1', workerId: 'worker-a', verification: VERIFICATION, currentBranch: 'main' },
        state
      ) as CompleteResult;

      expect(result.status).toBe('REVIEW');
      expect(result.branchPolicy).toBeUndefined();
      expect(governorsPost).toHaveBeenCalledTimes(0);
    });

    it('treats a non-string currentBranch as not reported', async () => {
      const { tool, governorsPost } = await boot();
      const result = await tool.handler(
        { taskId: 'task-1', workerId: 'worker-a', verification: VERIFICATION, currentBranch: 7 },
        state
      ) as CompleteResult;

      expect(result.status).toBe('REVIEW');
      expect(result.branchPolicy?.matched).toBeNull();
      expect(governorsPost).toHaveBeenCalledTimes(1);
    });

    it('completes even when the governors warning fails to post', async () => {
      const { tool, governorsPost } = await boot();
      governorsPost.mockRejectedValue(new Error('chat is down'));

      const result = await tool.handler(
        { taskId: 'task-1', workerId: 'worker-a', verification: VERIFICATION },
        state
      ) as CompleteResult;

      expect(result.status).toBe('REVIEW');
      expect(result.branchPolicy?.matched).toBeNull();
      expect(state.getTask('task-1')?.status).toBe('REVIEW');
    });
  });
});

// ---- migrated from tools.test.ts ----
import { ToolTestHarness } from './toolTestHarness.js';

describe('moe.complete_task', () => {
  const h = new ToolTestHarness();
  beforeEach(() => h.init());
  afterEach(() => { vi.restoreAllMocks(); h.cleanup(); });

  beforeEach(async () => {
    h.setupMoeFolder();
    h.createEpic();
    h.createTask({
      status: 'WORKING',
      implementationPlan: [
        { stepId: 'step-1', description: 'Done', status: 'COMPLETED', affectedFiles: ['a.ts', 'b.ts'] },
      ],
    });
    await h.state.load();
  });

  it('moves task to REVIEW', async () => {
    const tool = completeTaskTool(h.state);
    const result = await tool.handler({ taskId: 'task-1', verification: { command: 'npm test', exitCode: 0 } }, h.state) as {
      success: boolean;
      status: string;
      stats: { stepsCompleted: number; filesModified: string[] };
    };

    expect(result.success).toBe(true);
    expect(result.status).toBe('REVIEW');
    expect(result.stats.stepsCompleted).toBe(1);
    expect(result.stats.filesModified).toContain('a.ts');
  });

  it('sets prLink if provided', async () => {
    const tool = completeTaskTool(h.state);
    await tool.handler({ taskId: 'task-1', prLink: 'https://github.com/pr/123', verification: { command: 'npm test', exitCode: 0 } }, h.state);
    const task = h.state.getTask('task-1');
    expect(task?.prLink).toBe('https://github.com/pr/123');
  });

  it('prefers modifiedFiles over affectedFiles in stats (B24)', async () => {
    // Update the existing task to have steps with both modifiedFiles and affectedFiles
    await h.state.updateTask('task-1', {
      implementationPlan: [
        {
          stepId: 'step-1',
          description: 'Step with both fields',
          status: 'COMPLETED',
          affectedFiles: ['planned.ts', 'old.ts'],
          modifiedFiles: ['actual.ts', 'real.ts', 'extra.ts'],
        },
        {
          stepId: 'step-2',
          description: 'Step with only affectedFiles',
          status: 'COMPLETED',
          affectedFiles: ['fallback.ts'],
        },
      ],
    });

    const tool = completeTaskTool(h.state);
    const result = await tool.handler({ taskId: 'task-1', verification: { command: 'npm test', exitCode: 0 } }, h.state) as {
      stats: { filesModified: string[] };
    };

    // Step 1 should use modifiedFiles (not affectedFiles)
    expect(result.stats.filesModified).toContain('actual.ts');
    expect(result.stats.filesModified).toContain('real.ts');
    expect(result.stats.filesModified).toContain('extra.ts');
    expect(result.stats.filesModified).not.toContain('planned.ts');
    expect(result.stats.filesModified).not.toContain('old.ts');
    // Step 2 should fall back to affectedFiles
    expect(result.stats.filesModified).toContain('fallback.ts');
  });
});


// ---------------------------------------------------------------------------
// completionSummary persistence: `summary` used to be accepted and silently
// DISCARDED — the exact gap moe-next's rule 16 measured. Now it lands on the
// task (capped at 2000 chars, truncated — never a rejection).
// ---------------------------------------------------------------------------
describe('moe.complete_task summary persistence', () => {
  const h = new ToolTestHarness();
  beforeEach(() => h.init());
  afterEach(() => { vi.restoreAllMocks(); h.cleanup(); });

  beforeEach(async () => {
    h.setupMoeFolder();
    h.createEpic();
    h.createTask({
      id: 'task-1',
      status: 'WORKING',
      assignedWorkerId: 'worker-a',
      implementationPlan: [
        { stepId: 'step-1', description: 'd', status: 'COMPLETED', affectedFiles: [] },
      ],
    });
    await h.state.load();
  });

  it('persists summary as task.completionSummary and echoes it', async () => {
    const result = await completeTaskTool(h.state).handler({
      taskId: 'task-1',
      workerId: 'worker-a',
      verification: { command: 'npm test', exitCode: 0 },
      summary: '  Landed the parser fix; all 42 tests green.  ',
    }, h.state) as { completionSummary?: string };

    expect(result.completionSummary).toBe('Landed the parser fix; all 42 tests green.');
    expect(h.state.getTask('task-1')!.completionSummary).toBe('Landed the parser fix; all 42 tests green.');
  });

  it('truncates an over-long summary at 2000 chars instead of rejecting the completion', async () => {
    await completeTaskTool(h.state).handler({
      taskId: 'task-1',
      workerId: 'worker-a',
      verification: { command: 'npm test', exitCode: 0 },
      summary: 'x'.repeat(5000),
    }, h.state);

    const stored = h.state.getTask('task-1')!.completionSummary!;
    expect(stored).toHaveLength(2000);
    expect(h.state.getTask('task-1')!.status).toBe('REVIEW');
  });

  it('omits completionSummary entirely when no summary (or a blank one) is sent', async () => {
    await completeTaskTool(h.state).handler({
      taskId: 'task-1',
      workerId: 'worker-a',
      verification: { command: 'npm test', exitCode: 0 },
      summary: '   ',
    }, h.state);

    expect(h.state.getTask('task-1')!.completionSummary).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Finalizing phase (task-5dd49fe2). complete_task must NOT close the artifact
// boundary. It holds the owning attempt OPEN in the `finalizing` phase and
// stops inviting the worker to claim or wait for more work — otherwise a
// session starts task B while task A's bytes are still unlanded, because the
// wrapper only lands after the CLI exits.
//
// Every phase assertion names the exact string: a "not closed" assertion passes
// against a still-`running` attempt and would prove nothing.
// ---------------------------------------------------------------------------
describe('moe.complete_task — finalizing attempt', () => {
  const h = new ToolTestHarness();
  beforeEach(() => h.init());
  afterEach(() => { vi.restoreAllMocks(); h.cleanup(); });

  beforeEach(async () => {
    h.setupMoeFolder();
    h.createEpic();
    h.createTask({
      id: 'task-1',
      status: 'WORKING',
      assignedWorkerId: 'worker-a',
      implementationPlan: [
        { stepId: 'step-1', description: 'd', status: 'COMPLETED', affectedFiles: [] },
      ],
    });
    await h.state.load();
  });

  /** [generation, phase] per attempt, in generation order. */
  function attemptsOf(taskId: string): Array<[number, string]> {
    return listAttempts(h.state, taskId).map((a) => [a.generation, a.phase]);
  }

  /** The record as persisted, so a phase only published in memory cannot pass. */
  function attemptOnDisk(attemptId: string): Record<string, unknown> {
    const file = path.join(h.moePath, 'attempts', `${attemptId}.json`);
    return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  }

  /** The attempt the claim path would have opened for this worker. */
  async function openRunningAttempt(): Promise<ExecutionAttempt> {
    return await openAttempt(h.state, {
      taskId: 'task-1', workerId: 'worker-a', runnerId: 'worker-a', workspace: h.testDir,
    });
  }

  function complete(args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    return completeTaskTool(h.state).handler({
      taskId: 'task-1',
      workerId: 'worker-a',
      verification: { command: 'npm test', exitCode: 0 },
      ...args,
    }, h.state) as Promise<Record<string, unknown>>;
  }

  it('moves the open attempt to the finalizing phase and leaves it open', async () => {
    const attempt = await openRunningAttempt();

    await complete();

    // Exactly one record, still present, in `finalizing` — NOT closed. Closing
    // here would hand the seat straight back, which is the defect.
    expect(attemptsOf('task-1')).toEqual([[1, 'finalizing']]);
    expect(attemptOnDisk(attempt.id).phase).toBe('finalizing');

    // An open attempt does not make the evidence runner-observed: the report is
    // still the agent's own, and no attempt, runner or candidate id is copied in.
    const task = h.state.getTask('task-1')!;
    expect(task.status).toBe('REVIEW');
    expect(task.verification?.source).toBe('agent-reported');
    const expected = { command: 'npm test', exitCode: 0, reportedAt: task.reviewStartedAt, source: 'agent-reported' };
    expect(task.verification).toStrictEqual(expected);
    const onDisk = JSON.parse(fs.readFileSync(path.join(h.moePath, 'tasks', 'task-1.json'), 'utf8')) as Task;
    expect(onDisk.verification).toStrictEqual(expected);
  });

  it('returns a nextAction that names no tool for claiming or waiting on work', async () => {
    await openRunningAttempt();

    const result = await complete();
    const nextAction = result.nextAction as Record<string, unknown>;

    // Asserted on the absent tool field, not on message wording: naming ANY
    // claim/wait tool is the invitation this behaviour exists to remove.
    expect(nextAction).not.toHaveProperty('tool');
    expect(nextAction).not.toHaveProperty('args');
    expect(typeof nextAction.reason).toBe('string');
  });

  it('surfaces the finalizing attempt id and generation with the claim result key names', async () => {
    const attempt = await openRunningAttempt();

    const result = await complete();

    expect(result.attemptId).toBe(attempt.id);
    expect(result.generation).toBe(1);
  });

  it('completes a legacy task carrying no attempt exactly as it does today', async () => {
    // A row created before attempts existed. currentAttempt() yields null; the
    // completion must skip silently rather than throw or change its contract.
    const result = await complete();

    expect(result.success).toBe(true);
    expect(result.status).toBe('REVIEW');
    expect(h.state.getTask('task-1')!.status).toBe('REVIEW');
    expect(listAttempts(h.state, 'task-1')).toEqual([]);
    expect(result).not.toHaveProperty('attemptId');
    expect(result).not.toHaveProperty('generation');
    expect((result.nextAction as { tool?: string }).tool).toBe('moe.wait_for_task');
  });

  it('leaves the attempt running when a completion is rejected', async () => {
    await openRunningAttempt();

    await expect(complete({ verification: { command: 'npm test', exitCode: 1 } }))
      .rejects.toBeInstanceOf(MoeError);
    expect(attemptsOf('task-1')).toEqual([[1, 'running']]);

    await expect(complete({ workerId: 'worker-b' })).rejects.toBeInstanceOf(MoeError);
    expect(attemptsOf('task-1')).toEqual([[1, 'running']]);

    // The rejection left the task untouched too — no half-applied state.
    expect(h.state.getTask('task-1')!.status).toBe('WORKING');
  });
});

// ---------------------------------------------------------------------------
// Legacy verification provenance (task-95a1d08e). complete_task's evidence is
// the completing agent's own claim about a command it says it ran: no
// candidate, CheckRun or runner stands behind it. The stored record says so
// with source 'agent-reported', stamped by the server after validation, so no
// caller (not even one reaching the handler past the MCP schema) can label its
// own report runner-observed. Validation itself is deliberately unchanged.
// ---------------------------------------------------------------------------
describe('moe.complete_task — legacy verification provenance', () => {
  const h = new ToolTestHarness();
  const CONTRACT =
    'moe.complete_task requires verification evidence: { command, exitCode, outputTail? }. ' +
    'Run the verification command the plan named (fresh, in the foreground), then report the exact command, ' +
    'its exit code (must be 0), and the tail of its output.';
  const failedExit = (code: number) =>
    `Invalid verification.exitCode: verification command failed (exit ${code}). Fix the failure and re-run the ` +
    'command before completing — do not complete a task on failing verification.';
  const PENDING_PLAN: Task['implementationPlan'] = [
    { stepId: 'step-1', description: 'd', status: 'COMPLETED', affectedFiles: [] },
    { stepId: 'step-2', description: 'e', status: 'PENDING', affectedFiles: [] },
  ];
  let reloads: StateManager[] = [];

  beforeEach(() => {
    h.init();
    reloads = [];
  });
  afterEach(() => {
    vi.restoreAllMocks();
    // load() arms the periodic sweeps on every instance: stop them all before
    // this test's temporary root is removed.
    for (const reloaded of reloads) reloaded.clearEmitter();
    h.state.clearEmitter();
    h.cleanup();
  });

  /** A legacy row: WORKING, owned by worker-a, with no attempt, candidate, check or .git behind it. */
  async function boot(options: { settings?: Partial<ProjectSettings>; task?: Partial<Task> } = {}): Promise<void> {
    const project = h.setupMoeFolder();
    if (options.settings) {
      const settings = { ...project.settings, ...options.settings };
      fs.writeFileSync(path.join(h.moePath, 'project.json'), JSON.stringify({ ...project, settings }, null, 2));
    }
    h.createEpic();
    h.createTask({
      id: 'task-1',
      status: 'WORKING',
      assignedWorkerId: 'worker-a',
      implementationPlan: [{ stepId: 'step-1', description: 'd', status: 'COMPLETED', affectedFiles: [] }],
      ...options.task,
    });
    await h.state.load();
  }

  const taskFile = () => path.join(h.moePath, 'tasks', 'task-1.json');

  function verificationOnDisk(): unknown {
    return (JSON.parse(fs.readFileSync(taskFile(), 'utf8')) as Partial<Task>).verification;
  }

  /** The verification a freshly started daemon loads from disk. */
  async function verificationAfterReload(): Promise<unknown> {
    const reloaded = new StateManager({ projectPath: h.testDir });
    reloads.push(reloaded);
    await reloaded.load();
    return reloaded.getTask('task-1')?.verification;
  }

  /** Files a fabricated attempt, candidate or check record would have left behind. */
  function recordFiles(kind: 'attempts' | 'candidates' | 'checks'): string[] {
    const dir = path.join(h.moePath, kind);
    return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  }

  function complete(verification: unknown, extra: Record<string, unknown> = {}): Promise<unknown> {
    return completeTaskTool(h.state).handler({ taskId: 'task-1', workerId: 'worker-a', verification, ...extra }, h.state);
  }

  /** What a call was refused with, or 'resolved' when it was not refused. */
  function refusal(call: Promise<unknown>): Promise<unknown> {
    return call.then(() => 'resolved', (err: unknown) => err);
  }

  it.each([
    ['autoCommit absent', undefined],
    ['autoCommit false', false],
  ] as const)('labels a no-attempt, no-candidate, no-git completion agent-reported (%s)', async (_label, autoCommit) => {
    await boot(autoCommit === undefined ? {} : { settings: { autoCommit } });
    // The surface this label exists for: nothing but the agent stands behind the claim.
    expect(fs.existsSync(path.join(h.testDir, '.git'))).toBe(false);
    expect(h.state.project?.settings.autoCommit).toBe(autoCommit);
    expect(listAttempts(h.state, 'task-1')).toEqual([]);
    expect(h.state.candidates.size).toBe(0);

    const before = Date.now();
    const result = await complete({ command: '  npm test  ', exitCode: 0, outputTail: '12 passed' });
    const after = Date.now();

    const task = h.state.getTask('task-1')!;
    expect(task.status).toBe('REVIEW');
    // One server-clock stamp serves both fields.
    const stamp = task.reviewStartedAt as string;
    expect(Date.parse(stamp)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(stamp)).toBeLessThanOrEqual(after);
    expect(task.verification?.reportedAt).toBe(stamp);
    expect(task.verification?.command).toBe('npm test');
    expect(task.verification?.outputTail).toBe('12 passed');
    expect(task.verification?.source).toBe('agent-reported');

    const expected = { command: 'npm test', exitCode: 0, outputTail: '12 passed', reportedAt: stamp, source: 'agent-reported' };
    expect(task.verification).toStrictEqual(expected);
    expect(verificationOnDisk()).toStrictEqual(expected);
    expect(await verificationAfterReload()).toStrictEqual(expected);

    // The legacy result and hint are unchanged, and nothing was recorded to
    // stand behind the claim: no attempt, candidate or check, in memory or on disk.
    expect(result).toStrictEqual({
      success: true,
      taskId: 'task-1',
      status: 'REVIEW',
      stats: { stepsCompleted: 1, totalSteps: 1, filesModified: [], duration: 'n/a' },
      nextAction: { tool: 'moe.wait_for_task', args: { statuses: ['WORKING'], workerId: 'worker-a' }, reason: expect.any(String) },
    });
    expect(listAttempts(h.state, 'task-1')).toEqual([]);
    expect(h.state.candidates.size).toBe(0);
    expect(h.state.checkRuns.size).toBe(0);
    expect(recordFiles('attempts')).toEqual([]);
    expect(recordFiles('candidates')).toEqual([]);
    expect(recordFiles('checks')).toEqual([]);
  });

  it('stamps agent-reported over a source, reportedAt or identity a direct caller smuggles in', async () => {
    await boot();
    // A handler-level caller bypasses the MCP inputSchema, so these keys do arrive.
    await complete({
      command: 'npm test',
      exitCode: 0,
      source: 'runner-observed',
      reportedAt: '1999-01-01T00:00:00.000Z',
      runnerId: 'runner-forged',
      candidateId: 'cand-forged',
    });

    const task = h.state.getTask('task-1')!;
    expect(task.verification?.source).toBe('agent-reported');
    const expected = { command: 'npm test', exitCode: 0, reportedAt: task.reviewStartedAt, source: 'agent-reported' };
    expect(task.verification).toStrictEqual(expected);
    expect(verificationOnDisk()).toStrictEqual(expected);
    expect(await verificationAfterReload()).toStrictEqual(expected);
    expect(h.state.checkRuns.size).toBe(0);
    expect(recordFiles('checks')).toEqual([]);
  });

  it('does not advertise source in the accepted verification schema', () => {
    const { properties } = completeTaskTool(h.state).inputSchema as {
      properties: { verification: { properties: Record<string, unknown>; required: string[]; additionalProperties: boolean } };
    };

    expect(Object.keys(properties.verification.properties)).toEqual(['command', 'exitCode', 'outputTail']);
    expect(properties.verification.required).toEqual(['command', 'exitCode']);
    expect(properties.verification.additionalProperties).toBe(false);
  });

  it.each([
    ['omitted', undefined, undefined],
    ['empty', '', undefined],
    // 2002 UTF-16 units but only about 4 KB of UTF-8, so the CheckRun byte cap
    // would keep every unit. The legacy cap keeps the final 2000 string units,
    // even though that starts on the low half of a surrogate pair.
    ['multibyte, past 2000 units', 'x' + '\u{1F600}'.repeat(1000) + 'y', '\uDE00' + '\u{1F600}'.repeat(999) + 'y'],
  ] as const)('keeps the legacy outputTail semantics (%s)', async (_label, outputTail, storedTail) => {
    await boot();
    await complete({ command: 'npm test', exitCode: 0, ...(outputTail === undefined ? {} : { outputTail }) });

    const task = h.state.getTask('task-1')!;
    expect(task.verification?.outputTail).toBe(storedTail);
    expect(task.verification?.outputTail?.length).toBe(storedTail?.length);
    expect(task.verification?.source).toBe('agent-reported');
    const expected = {
      command: 'npm test',
      exitCode: 0,
      ...(storedTail === undefined ? {} : { outputTail: storedTail }),
      reportedAt: task.reviewStartedAt,
      source: 'agent-reported',
    };
    expect(task.verification).toStrictEqual(expected);
    expect(verificationOnDisk()).toStrictEqual(expected);
    expect(await verificationAfterReload()).toStrictEqual(expected);
  });

  it('accepts a 500-character command, measured before trimming, and stores it trimmed', async () => {
    await boot();
    const command = ' ' + 'a'.repeat(498) + ' ';
    expect(command).toHaveLength(500);

    await complete({ command, exitCode: 0 });

    const task = h.state.getTask('task-1')!;
    expect(task.status).toBe('REVIEW');
    expect(task.verification?.command).toBe('a'.repeat(498));
    expect(task.verification).toStrictEqual({
      command: 'a'.repeat(498), exitCode: 0, reportedAt: task.reviewStartedAt, source: 'agent-reported',
    });
  });

  it.each([
    ['missing evidence', undefined, 'MISSING_REQUIRED', `Missing required field: verification. ${CONTRACT}`],
    ['null evidence', null, 'MISSING_REQUIRED', `Missing required field: verification. ${CONTRACT}`],
    ['array evidence', [], 'INVALID_INPUT', `Invalid verification: must be an object. ${CONTRACT}`],
    ['string evidence', 'npm test', 'INVALID_INPUT', `Invalid verification: must be an object. ${CONTRACT}`],
    ['a blank command', { command: '   ', exitCode: 0 }, 'MISSING_REQUIRED', 'Missing required field: verification.command'],
    ['a non-string command', { command: 42, exitCode: 0 }, 'MISSING_REQUIRED', 'Missing required field: verification.command'],
    // 501 raw characters but 499 once trimmed: the cap is measured before trimming.
    ['a 501-character command', { command: ' ' + 'a'.repeat(499) + ' ', exitCode: 0 }, 'INVALID_INPUT', 'Invalid verification.command: too long (max 500 chars)'],
    ['a fractional exitCode', { command: 'npm test', exitCode: 0.5 }, 'INVALID_INPUT', 'Invalid verification.exitCode: must be an integer exit code'],
    ['a string exitCode', { command: 'npm test', exitCode: '0' }, 'INVALID_INPUT', 'Invalid verification.exitCode: must be an integer exit code'],
    ['a nonzero exitCode', { command: 'npm test', exitCode: 2 }, 'INVALID_INPUT', failedExit(2)],
    ['a non-string outputTail', { command: 'npm test', exitCode: 0, outputTail: 7 }, 'INVALID_INPUT', 'Invalid verification.outputTail: must be a string'],
    ['a null outputTail', { command: 'npm test', exitCode: 0, outputTail: null }, 'INVALID_INPUT', 'Invalid verification.outputTail: must be a string'],
  ])('refuses %s exactly as before and leaves the task untouched', async (_label, verification, codeName, text) => {
    await boot();
    const bytes = fs.readFileSync(taskFile(), 'utf8');

    const err = await refusal(complete(verification));

    expect(err).toBeInstanceOf(MoeError);
    // INVALID_INPUT and MISSING_REQUIRED share one code; codeName tells them apart.
    expect((err as MoeError).code).toBe(MoeErrorCode.INVALID_INPUT);
    expect((err as MoeError).codeName).toBe(codeName);
    expect((err as MoeError).message).toBe(`[${codeName}] ${text}`);
    const task = h.state.getTask('task-1')!;
    expect(task.status).toBe('WORKING');
    expect(task.verification).toBeUndefined();
    expect(fs.readFileSync(taskFile(), 'utf8')).toBe(bytes);
  });

  it.each([
    ['status before ownership', { status: 'REVIEW' }, 'worker-b', MoeErrorCode.INVALID_STATE, 'INVALID_STATE', 'Task is in REVIEW state, expected WORKING'],
    ['ownership before steps', { implementationPlan: PENDING_PLAN }, 'worker-b', MoeErrorCode.NOT_ALLOWED, 'NOT_ALLOWED', 'Task task-1 is claimed by worker-a, not worker-b'],
    ['steps before evidence', { implementationPlan: PENDING_PLAN }, 'worker-a', MoeErrorCode.NOT_ALLOWED, 'NOT_ALLOWED', 'Cannot complete task task-1: 1 step(s) still incomplete'],
    ['evidence before branch policy', {}, 'worker-a', MoeErrorCode.INVALID_INPUT, 'INVALID_INPUT', failedExit(1)],
  ])('keeps guard precedence: %s', async (_label, task, workerId, code, codeName, text) => {
    await boot({ settings: { consolidationBranch: 'moe/work-*' }, task: task as Partial<Task> });
    const bytes = fs.readFileSync(taskFile(), 'utf8');

    // Every later guard would refuse this call too: failing evidence on a mismatched branch.
    const err = await refusal(complete({ command: 'npm test', exitCode: 1 }, { workerId, currentBranch: 'main' }));

    expect(err).toBeInstanceOf(MoeError);
    expect((err as MoeError).code).toBe(code);
    expect((err as MoeError).codeName).toBe(codeName);
    expect((err as MoeError).message).toBe(`[${codeName}] ${text}`);
    expect(h.state.getTask('task-1')!.verification).toBeUndefined();
    expect(fs.readFileSync(taskFile(), 'utf8')).toBe(bytes);
  });

  it('refuses a branch-policy mismatch after valid evidence without persisting a label', async () => {
    await boot({ settings: { consolidationBranch: 'moe/work-*' } });
    const bytes = fs.readFileSync(taskFile(), 'utf8');

    const err = await refusal(complete({ command: 'npm test', exitCode: 0 }, { currentBranch: 'main' }));

    expect(err).toBeInstanceOf(MoeError);
    expect((err as MoeError).codeName).toBe('CONSTRAINT_VIOLATION');
    expect((err as MoeError).context).toEqual({ currentBranch: 'main', expectedPattern: 'moe/work-*' });
    expect(h.state.getTask('task-1')!.status).toBe('WORKING');
    expect(h.state.getTask('task-1')!.verification).toBeUndefined();
    expect(fs.readFileSync(taskFile(), 'utf8')).toBe(bytes);
  });

  it('lets an updateTask failure escape without completing, releasing or labelling the task', async () => {
    await boot();
    const bytes = fs.readFileSync(taskFile(), 'utf8');
    const failure = new Error('disk full');
    vi.spyOn(h.state, 'updateTask').mockRejectedValue(failure);
    const touchWorker = vi.spyOn(h.state, 'touchWorker');

    expect(await refusal(complete({ command: 'npm test', exitCode: 0 }))).toBe(failure);

    const task = h.state.getTask('task-1')!;
    expect(task.status).toBe('WORKING');
    expect(task.assignedWorkerId).toBe('worker-a');
    expect(task.verification).toBeUndefined();
    expect(touchWorker).not.toHaveBeenCalled();
    expect(fs.readFileSync(taskFile(), 'utf8')).toBe(bytes);
  });
});
