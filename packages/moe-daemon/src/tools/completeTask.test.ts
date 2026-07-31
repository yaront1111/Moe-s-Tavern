import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { StateManager } from '../state/StateManager.js';
import { completeTaskTool } from './completeTask.js';
import { MoeError, MoeErrorCode } from '../util/errors.js';
import type { Task, Epic, Project, ProjectSettings } from '../types/schema.js';

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

