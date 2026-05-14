import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { StateManager, MAX_COMMENTS_PER_TASK } from '../state/StateManager.js';
import { getContextTool } from './getContext.js';
import { submitPlanTool } from './submitPlan.js';
import { checkApprovalTool } from './checkApproval.js';
import { startStepTool } from './startStep.js';
import { completeStepTool } from './completeStep.js';
import { completeTaskTool } from './completeTask.js';
import { reportBlockedTool } from './reportBlocked.js';
import { listTasksTool } from './listTasks.js';
import { getNextTaskTool } from './getNextTask.js';
import { createTaskTool } from './createTask.js';
import { createEpicTool } from './createEpic.js';
import { createTeamTool } from './createTeam.js';
import { setTaskStatusTool } from './setTaskStatus.js';
import { claimNextTaskTool } from './claimNextTask.js';
import { proposeRailTool } from './proposeRail.js';
import { deleteTaskTool } from './deleteTask.js';
import { updateEpicTool } from './updateEpic.js';
import { deleteEpicTool } from './deleteEpic.js';
import { searchTasksTool } from './searchTasks.js';
import { qaApproveTool } from './qaApprove.js';
import { qaRejectTool } from './qaReject.js';
import { getActivityLogTool } from './getActivityLog.js';
import { unblockWorkerTool } from './unblockWorker.js';
import { addCommentTool } from './addComment.js';
import { getPendingQuestionsTool } from './getPendingQuestions.js';
import { chatReadTool } from './chatRead.js';
import { chatResyncTool } from './chatResync.js';
import { chatWaitTool } from './chatWait.js';
import { waitForTaskTool } from './waitForTask.js';
import { initProjectTool } from './initProject.js';
import { saveSessionSummaryTool } from './saveSessionSummary.js';
import { recallTool } from './recall.js';
import { rememberTool } from './remember.js';
import { MoeErrorCode } from '../util/errors.js';
import type { Task, Epic, Worker, Project, RailProposal } from '../types/schema.js';

describe('MCP Tools', () => {
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
        techStack: ['typescript'],
        forbiddenPatterns: ['rm -rf'],
        requiredPatterns: [],
        formatting: '',
        testing: '',
        customRules: [],
      },
      settings: {
        approvalMode: 'CONTROL',
        speedModeDelayMs: 2000,
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
      description: 'Epic description',
      architectureNotes: 'Some notes',
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
      description: 'Task description',
      definitionOfDone: ['Tests pass', 'Code reviewed'],
      taskRails: [],
      implementationPlan: [],
      status: 'BACKLOG',
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

  function createWorker(overrides: Partial<Worker> = {}): Worker {
    const worker: Worker = {
      id: 'worker-1',
      type: 'CLAUDE',
      projectId: 'proj-test',
      epicId: 'epic-1',
      currentTaskId: null,
      status: 'IDLE',
      branch: 'main',
      modifiedFiles: [],
      startedAt: new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
      lastError: null,
      errorCount: 0,
      ...overrides,
    };
    fs.writeFileSync(path.join(moePath, 'workers', `${worker.id}.json`), JSON.stringify(worker, null, 2));
    return worker;
  }

  beforeEach(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moe-tools-test-'));
    moePath = path.join(testDir, '.moe');
    state = new StateManager({ projectPath: testDir });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  describe('moe.get_context', () => {
    it('returns project context without task', async () => {
      setupMoeFolder();
      await state.load();
      const tool = getContextTool(state);
      const result = await tool.handler({}, state) as { project: { name: string }; task: null };

      expect(result.project.name).toBe('Test Project');
      expect(result.task).toBeNull();
    });

    it('returns task context when taskId provided', async () => {
      setupMoeFolder();
      createEpic();
      createTask();
      await state.load();
      const tool = getContextTool(state);
      const result = await tool.handler({ taskId: 'task-1' }, state) as { task: { id: string }; epic: { id: string } };

      expect(result.task?.id).toBe('task-1');
      expect(result.epic?.id).toBe('epic-1');
    });

    it('throws if project not loaded', async () => {
      const tool = getContextTool(state);
      await expect(tool.handler({}, state)).rejects.toThrow('not loaded state, expected loaded');
    });

    it('returns worker when task has assignedWorkerId', async () => {
      setupMoeFolder();
      createEpic();
      createWorker({
        id: 'worker-ctx',
        status: 'CODING',
        lastError: 'prev error',
        errorCount: 2,
        chatCursors: { 'chan-heavy': 'msg-heavy' },
      });
      createTask({ assignedWorkerId: 'worker-ctx' });
      await state.load();
      const tool = getContextTool(state);
      const result = await tool.handler({ taskId: 'task-1' }, state) as {
        worker: {
          id: string;
          status: string;
          lastError: string | null;
          errorCount: number;
          chatCursors?: unknown;
          branch?: unknown;
          modifiedFiles?: unknown;
        } | null;
      };

      expect(result.worker).not.toBeNull();
      expect(result.worker!.id).toBe('worker-ctx');
      expect(result.worker!.status).toBe('CODING');
      expect(result.worker!.lastError).toBe('prev error');
      expect(result.worker!.errorCount).toBe(2);
      expect(result.worker!.chatCursors).toBeUndefined();
      expect(result.worker!.branch).toBeUndefined();
      expect(result.worker!.modifiedFiles).toBeUndefined();
    });

    it('returns null worker when task has no assignedWorkerId', async () => {
      setupMoeFolder();
      createEpic();
      createTask({ assignedWorkerId: null });
      await state.load();
      const tool = getContextTool(state);
      const result = await tool.handler({ taskId: 'task-1' }, state) as { worker: null };

      expect(result.worker).toBeNull();
    });

    it('returns null worker when no task provided', async () => {
      setupMoeFolder();
      await state.load();
      const tool = getContextTool(state);
      const result = await tool.handler({}, state) as { worker: null };

      expect(result.worker).toBeNull();
    });

    it('records contextFetchedBy when workerId provided and task is claimed', async () => {
      setupMoeFolder();
      createEpic();
      createTask({ assignedWorkerId: 'worker-ctx' });
      await state.load();
      const tool = getContextTool(state);

      await tool.handler({ taskId: 'task-1', workerId: 'worker-ctx' }, state);
      expect(state.getTask('task-1')?.contextFetchedBy).toEqual(['worker-ctx']);

      // Duplicate call does not produce duplicate entries
      await tool.handler({ taskId: 'task-1', workerId: 'worker-ctx' }, state);
      expect(state.getTask('task-1')?.contextFetchedBy).toEqual(['worker-ctx']);

      // Different worker is appended
      await tool.handler({ taskId: 'task-1', workerId: 'worker-qa' }, state);
      expect(state.getTask('task-1')?.contextFetchedBy).toEqual(['worker-ctx', 'worker-qa']);
    });

    it('does not record contextFetchedBy when workerId is missing', async () => {
      const prev = process.env.MOE_WORKER_ID;
      delete process.env.MOE_WORKER_ID;
      try {
        setupMoeFolder();
        createEpic();
        createTask({ assignedWorkerId: 'worker-ctx' });
        await state.load();
        const tool = getContextTool(state);
        await tool.handler({ taskId: 'task-1' }, state);
        expect(state.getTask('task-1')?.contextFetchedBy).toBeUndefined();
      } finally {
        if (prev === undefined) delete process.env.MOE_WORKER_ID;
        else process.env.MOE_WORKER_ID = prev;
      }
    });

    it('returns step notes in implementationPlan', async () => {
      setupMoeFolder();
      createEpic();
      createTask({
        implementationPlan: [
          { stepId: 'step-1', description: 'First', status: 'COMPLETED', affectedFiles: ['a.ts'], note: 'Design decision: used factory pattern', modifiedFiles: ['a.ts', 'b.ts'] },
          { stepId: 'step-2', description: 'Second', status: 'PENDING', affectedFiles: [] },
        ],
      });
      await state.load();
      const tool = getContextTool(state);
      const result = await tool.handler({ taskId: 'task-1' }, state) as {
        task: { implementationPlan: Array<{ stepId: string; note?: string; modifiedFiles?: string[] }> };
      };

      const step1 = result.task.implementationPlan.find(s => s.stepId === 'step-1');
      expect(step1?.note).toBe('Design decision: used factory pattern');
      expect(step1?.modifiedFiles).toEqual(['a.ts', 'b.ts']);
    });

    it('auto-surfaces memory as compact previews when memoryMode=summary', async () => {
      setupMoeFolder();
      createEpic();
      createTask({ title: 'Auth token task', description: 'Fix auth token validation' });
      await state.load();
      await state.getMemoryManager().addEntry({
        workerId: 'worker-memory',
        type: 'gotcha',
        content: 'Auth token validation failed because expired tokens were accepted without checking exp. Add explicit expiry tests.',
        tags: ['auth'],
      });

      const tool = getContextTool(state);
      const result = await tool.handler({ taskId: 'task-1', memoryMode: 'summary' }, state) as {
        memory: {
          mode: string;
          relevant: Array<{ preview?: string; content?: string; truncated?: boolean }>;
        };
      };

      expect(result.memory.mode).toBe('summary');
      expect(result.memory.relevant).toHaveLength(1);
      expect(result.memory.relevant[0].preview).toContain('Auth token validation');
      expect(result.memory.relevant[0].content).toBeUndefined();
    });

    it('supports disabling memory auto-injection per get_context call', async () => {
      setupMoeFolder();
      createEpic();
      createTask({ title: 'Auth token task', description: 'Fix auth token validation' });
      await state.load();
      await state.getMemoryManager().addEntry({
        workerId: 'worker-memory',
        type: 'gotcha',
        content: 'Auth token validation failed because expired tokens were accepted without checking exp.',
      });
      await state.getMemoryManager().saveSessionSummary({
        workerId: 'worker-memory',
        taskId: 'task-1',
        role: 'worker',
        summary: 'Session summary that should not appear when memory auto-injection is off.',
      });

      const tool = getContextTool(state);
      const result = await tool.handler({ taskId: 'task-1', memoryMode: 'off' }, state) as {
        memory: { mode: string; relevant: unknown[]; lastSession: unknown };
      };

      expect(result.memory.mode).toBe('off');
      expect(result.memory.relevant).toEqual([]);
      expect(result.memory.lastSession).toBeNull();
    });

    it('supports full memory auto-injection when explicitly requested', async () => {
      setupMoeFolder();
      createEpic();
      createTask({ title: 'Auth token task', description: 'Fix auth token validation' });
      await state.load();
      await state.getMemoryManager().addEntry({
        workerId: 'worker-memory',
        type: 'gotcha',
        content: 'Auth token validation failed because expired tokens were accepted without checking exp.',
      });

      const tool = getContextTool(state);
      const result = await tool.handler({
        taskId: 'task-1',
        memoryMode: 'full',
        memoryLimit: 1,
        memoryMaxChars: 1000,
      }, state) as {
        memory: { mode: string; relevant: Array<{ preview?: string; content?: string }> };
      };

      expect(result.memory.mode).toBe('full');
      expect(result.memory.relevant).toHaveLength(1);
      expect(result.memory.relevant[0].content).toContain('expired tokens were accepted');
      expect(result.memory.relevant[0].preview).toBeUndefined();
    });

    it('clamps memoryLimit and keeps summary previews within the total budget', async () => {
      setupMoeFolder();
      createEpic();
      createTask({ title: 'Auth token task', description: 'Fix auth token validation' });
      await state.load();
      const hiddenTail = 'NEVER_LEAK_FULL_MEMORY_BODY';
      const uniqueWords = [
        'albatross brook cedar dune ember frost grove harbor',
        'iris juniper kelp lagoon meadow nectar onyx prairie',
        'quartz river spruce tundra umber violet willow xenon',
        'yarrow zephyr amber basalt copper drift elm fern',
        'garnet heather indigo jasper kiwi lilac maple north',
        'opal pebble quince ridge saffron thistle upland valley',
        'walnut xylem yucca zircon acorn briar clover daisy',
        'eagle flint ginger hazel ivory jade koala larch',
        'marble nickel olive pearl ruby slate topaz ultramarine',
        'velvet wheat orchid pine coral delta birch canyon',
        'desert echo forest glacier hibiscus island jungle karma',
        'lotus magma nebula ocean pollen quarry rainstorm savanna',
      ];
      for (let i = 0; i < 12; i++) {
        await state.getMemoryManager().addEntry({
          workerId: `worker-memory-${i}`,
          type: 'gotcha',
          content: [
            `Auth token validation memory ${i} visible prefix.`,
            uniqueWords[i],
            `${hiddenTail}-${i}`,
          ].join(' '),
          tags: ['auth'],
        });
      }

      const tool = getContextTool(state);
      const result = await tool.handler({
        taskId: 'task-1',
        memoryMode: 'summary',
        memoryLimit: 99,
        memoryMaxChars: 25,
      }, state) as {
        memory: { relevant: Array<{ preview?: string; content?: string; truncated?: boolean }> };
      };

      expect(result.memory.relevant).toHaveLength(10);
      const serialized = JSON.stringify(result.memory.relevant);
      expect(serialized).not.toContain(hiddenTail);
      expect(result.memory.relevant.every(memory => memory.content === undefined)).toBe(true);
      expect(result.memory.relevant.reduce((sum, memory) => sum + (memory.preview?.length ?? 0), 0)).toBeLessThanOrEqual(25);
      expect(result.memory.relevant.some(memory => memory.truncated)).toBe(true);
    });

    it('supports zero memory limits and zero content budget without leaking content', async () => {
      setupMoeFolder();
      createEpic();
      createTask({ title: 'Auth token task', description: 'Fix auth token validation' });
      await state.load();
      await state.getMemoryManager().addEntry({
        workerId: 'worker-memory',
        type: 'gotcha',
        content: 'Auth token validation full memory body should be hidden with zero budgets.',
      });
      await state.getMemoryManager().saveSessionSummary({
        workerId: 'worker-memory',
        taskId: 'task-1',
        role: 'worker',
        summary: 'Session summary should be skipped when memoryLimit is zero.',
      });

      const tool = getContextTool(state);
      const noMemories = await tool.handler({
        taskId: 'task-1',
        memoryLimit: 0,
      }, state) as { memory: { relevant: unknown[]; lastSession: unknown } };

      expect(noMemories.memory.relevant).toEqual([]);
      expect(noMemories.memory.lastSession).toBeNull();

      const zeroContentBudget = await tool.handler({
        taskId: 'task-1',
        memoryMode: 'full',
        memoryLimit: 1,
        memoryMaxChars: 0,
      }, state) as { memory: { relevant: Array<{ content?: string; truncated?: boolean }> } };

      expect(zeroContentBudget.memory.relevant).toHaveLength(1);
      expect(zeroContentBudget.memory.relevant[0].content).toBe('');
      expect(zeroContentBudget.memory.relevant[0].truncated).toBe(true);
    });

    it('caps full-mode lastSession summary with memoryMaxChars', async () => {
      setupMoeFolder();
      createEpic();
      createTask({ title: 'Auth token task', description: 'Fix auth token validation' });
      await state.load();
      await state.getMemoryManager().saveSessionSummary({
        workerId: 'worker-memory',
        taskId: 'task-1',
        role: 'worker',
        summary: 'Long session summary should be truncated by the full-mode memory budget.',
      });

      const tool = getContextTool(state);
      const result = await tool.handler({
        taskId: 'task-1',
        memoryMode: 'full',
        memoryMaxChars: 18,
      }, state) as { memory: { lastSession: { summary: string; truncated?: boolean } } };

      expect(result.memory.lastSession.summary.length).toBeLessThanOrEqual(18);
      expect(result.memory.lastSession.summary).not.toContain('full-mode memory budget');
      expect(result.memory.lastSession.truncated).toBe(true);
    });

    it('rejects invalid memoryMode values', async () => {
      setupMoeFolder();
      createEpic();
      createTask();
      await state.load();
      const tool = getContextTool(state);

      await expect(tool.handler({
        taskId: 'task-1',
        memoryMode: 'verbose',
      }, state)).rejects.toMatchObject({ code: MoeErrorCode.INVALID_INPUT });

      await expect(tool.handler({
        taskId: 'task-1',
        memoryMode: '',
      }, state)).rejects.toMatchObject({ code: MoeErrorCode.INVALID_INPUT });

      await expect(tool.handler({
        taskId: 'task-1',
        memoryLimit: Number.NaN,
      }, state)).rejects.toMatchObject({ code: MoeErrorCode.INVALID_INPUT });

      await expect(tool.handler({
        taskId: 'task-1',
        memoryMaxChars: Number.POSITIVE_INFINITY,
      }, state)).rejects.toMatchObject({ code: MoeErrorCode.INVALID_INPUT });
    });

    it('keeps explicit recall full-content even when get_context summaries are compact', async () => {
      setupMoeFolder();
      createEpic();
      createTask({ title: 'Auth token task', description: 'Fix auth token validation' });
      await state.load();
      const fullContent = 'Auth token validation full memory body with exact remediation details and hidden tail.';
      await state.getMemoryManager().addEntry({
        workerId: 'worker-memory',
        type: 'gotcha',
        content: fullContent,
        tags: ['auth'],
      });

      const contextTool = getContextTool(state);
      const context = await contextTool.handler({
        taskId: 'task-1',
        memoryMode: 'summary',
        memoryMaxChars: 20,
      }, state) as { memory: { relevant: Array<{ preview?: string; content?: string }> } };
      expect(context.memory.relevant[0].content).toBeUndefined();
      expect(context.memory.relevant[0].preview).not.toContain('hidden tail');

      const recall = await recallTool(state).handler({
        query: 'Auth token validation',
        limit: 1,
        minConfidence: 0,
      }, state) as { memories: Array<{ content: string }> };

      expect(recall.memories).toHaveLength(1);
      expect(recall.memories[0].content).toBe(fullContent);
    });

    it('does not auto-inject recent chat by default', async () => {
      setupMoeFolder();
      createEpic();
      createTask();
      await state.load();
      const general = state.getChannels().find((channel) => channel.name === 'general');
      expect(general).toBeDefined();
      await state.sendMessage({
        channel: general!.id,
        sender: 'human',
        content: 'Long general chat message '.repeat(80),
      });

      const tool = getContextTool(state);
      const result = await tool.handler({ taskId: 'task-1' }, state) as {
        chat?: { recentMessages: unknown[] };
      };

      expect(result.chat?.recentMessages ?? []).toEqual([]);
    });

    it('keeps task comments compact in get_context and exposes summary metadata', async () => {
      setupMoeFolder();
      createEpic();
      createTask({
        comments: [
          { id: 'c1', author: 'human', content: 'old comment', timestamp: '2024-01-01T00:00:00Z' },
          { id: 'c2', author: 'human', content: 'A'.repeat(1200), timestamp: '2024-01-01T00:01:00Z' },
          { id: 'c3', author: 'worker-1', content: 'latest comment', timestamp: '2024-01-01T00:02:00Z' },
        ],
      });
      await state.load();
      const tool = getContextTool(state);

      const compact = await tool.handler({
        taskId: 'task-1',
        commentsLimit: 2,
        commentsMaxChars: 100,
      }, state) as {
        task: {
          comments: Array<{
            id: string;
            content: string;
            contentTruncated?: boolean;
            contentOriginalLength?: number;
          }>;
          commentSummary: { total: number; returned: number; omitted: number; truncated: number };
        };
      };

      expect(compact.task.comments.map(comment => comment.id)).toEqual(['c2', 'c3']);
      expect(compact.task.comments[0].content.length).toBeLessThanOrEqual(100);
      expect(compact.task.comments[0].contentTruncated).toBe(true);
      expect(compact.task.comments[0].contentOriginalLength).toBe(1200);
      expect(compact.task.commentSummary).toMatchObject({
        total: 3,
        returned: 2,
        omitted: 1,
        truncated: 1,
      });

      const fullComment = await tool.handler({
        taskId: 'task-1',
        commentsLimit: 1,
        commentsMaxChars: 0,
      }, state) as { task: { comments: Array<{ content: string; contentTruncated?: boolean }> } };
      expect(fullComment.task.comments[0].content).toBe('latest comment');
      expect(fullComment.task.comments[0].contentTruncated).toBeUndefined();
    });
  });

  describe('moe.init_project', () => {
    it('writes memory defaults for newly initialized projects', async () => {
      const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'moe-init-tool-'));
      try {
        const tool = initProjectTool(state);
        await tool.handler({ projectPath, name: 'Init Tool Project' }, state);

        const project = JSON.parse(fs.readFileSync(path.join(projectPath, '.moe', 'project.json'), 'utf-8')) as Project;
        expect(project.settings.memory).toEqual({
          autoInject: 'off',
          maxAutoResults: 1,
          maxAutoChars: 500,
          autoSave: {
            completedTask: false,
            firstPassApproval: false,
            qaRejection: true,
            reopenedApproval: true,
          },
        });
      } finally {
        fs.rmSync(projectPath, { recursive: true, force: true });
      }
    });
  });

  describe('moe.save_session_summary', () => {
    beforeEach(async () => {
      setupMoeFolder();
      createEpic();
      createTask({ id: 'task-1' });
      createWorker({ id: 'worker-1', status: 'CODING', currentTaskId: 'task-1' });
      await state.load();
    });

    it('saves valid summaries only under the sessions directory', async () => {
      const tool = saveSessionSummaryTool(state);

      const result = await tool.handler({
        workerId: 'worker-1',
        taskId: 'task-1',
        summary: 'Finished the implementation.',
      }, state) as { sessionId: string; nextAction: { args: { workerId: string } } };

      expect(result.sessionId).toMatch(/^sess-/);
      expect(result.nextAction.args.workerId).toBe('worker-1');

      const sessionsDir = path.join(moePath, 'memory', 'sessions');
      const files = fs.readdirSync(sessionsDir);
      expect(files).toEqual(['worker-1_task-1.json']);

      const saved = JSON.parse(fs.readFileSync(path.join(sessionsDir, files[0]), 'utf-8')) as {
        workerId: string;
        taskId: string;
        summary: string;
      };
      expect(saved).toMatchObject({
        workerId: 'worker-1',
        taskId: 'task-1',
        summary: 'Finished the implementation.',
      });
    });

    it('rejects traversal-shaped session IDs without writing outside sessions', async () => {
      const tool = saveSessionSummaryTool(state);
      const sessionsDir = path.join(moePath, 'memory', 'sessions');
      const outsideViaWorkerId = path.join(moePath, 'memory', 'evil_task-1.json');

      await expect(tool.handler({
        workerId: '../evil',
        taskId: 'task-1',
        summary: 'malicious',
      }, state)).rejects.toMatchObject({ code: MoeErrorCode.INVALID_INPUT });

      await expect(tool.handler({
        workerId: 'worker-1',
        taskId: 'task/../evil',
        summary: 'malicious',
      }, state)).rejects.toMatchObject({ code: MoeErrorCode.INVALID_INPUT });

      await expect(state.getMemoryManager().saveSessionSummary({
        workerId: '../evil',
        taskId: 'task-1',
        role: 'worker',
        summary: 'malicious',
      })).rejects.toMatchObject({ code: MoeErrorCode.INVALID_INPUT });

      expect(fs.existsSync(outsideViaWorkerId)).toBe(false);
      expect(fs.readdirSync(sessionsDir)).toEqual([]);
    });

    it('rejects syntactically valid but nonexistent worker and task IDs', async () => {
      const tool = saveSessionSummaryTool(state);

      await expect(tool.handler({
        workerId: 'worker-missing',
        taskId: 'task-1',
        summary: 'no worker',
      }, state)).rejects.toMatchObject({ code: MoeErrorCode.NOT_FOUND });

      await expect(tool.handler({
        workerId: 'worker-1',
        taskId: 'task-missing',
        summary: 'no task',
      }, state)).rejects.toMatchObject({ code: MoeErrorCode.NOT_FOUND });

      expect(fs.readdirSync(path.join(moePath, 'memory', 'sessions'))).toEqual([]);
    });

    it('matches last sessions by parsed taskId exactly and skips malformed files', () => {
      const sessionsDir = path.join(moePath, 'memory', 'sessions');
      fs.writeFileSync(path.join(sessionsDir, 'worker-1_task-1.json'), JSON.stringify({
        id: 'sess-task1',
        workerId: 'worker-1',
        taskId: 'task-1',
        role: 'worker',
        summary: 'correct task',
        memoriesCreated: [],
        createdAt: '2026-04-30T00:00:00.000Z',
      }));
      fs.writeFileSync(path.join(sessionsDir, 'worker-1_task-10.json'), JSON.stringify({
        id: 'sess-task10',
        workerId: 'worker-1',
        taskId: 'task-10',
        role: 'worker',
        summary: 'wrong task for task-1',
        memoriesCreated: [],
        createdAt: '2026-04-30T00:01:00.000Z',
      }));
      fs.writeFileSync(path.join(sessionsDir, 'worker-2_task-1.json'), '{not valid json');

      expect(state.getMemoryManager().getLastSession('task-1')?.id).toBe('sess-task1');
      expect(state.getMemoryManager().getLastSession('task-10')?.id).toBe('sess-task10');
    });
  });

  describe('moe.submit_plan', () => {
    beforeEach(async () => {
      setupMoeFolder();
      createEpic();
      createTask({ status: 'PLANNING' });
      await state.load();
    });

    it('submits a valid plan', async () => {
      const tool = submitPlanTool(state);
      const result = await tool.handler({
        taskId: 'task-1',
        steps: [
          { description: 'Step 1', affectedFiles: ['file.ts'] },
          { description: 'Step 2', affectedFiles: [] },
        ],
      }, state) as { success: boolean; status: string; stepCount: number };

      expect(result.success).toBe(true);
      expect(result.status).toBe('AWAITING_APPROVAL');
      expect(result.stepCount).toBe(2);

      const task = state.getTask('task-1');
      expect(task?.status).toBe('AWAITING_APPROVAL');
      expect(task?.implementationPlan.length).toBe(2);
    });

    it('throws for non-existent task', async () => {
      const tool = submitPlanTool(state);
      await expect(
        tool.handler({ taskId: 'nonexistent', steps: [{ description: 'Step 1' }] }, state)
      ).rejects.toThrow('Task not found');
    });

    it('throws for wrong task status', async () => {
      await state.updateTask('task-1', { status: 'WORKING' });
      const tool = submitPlanTool(state);
      await expect(
        tool.handler({ taskId: 'task-1', steps: [{ description: 'Step 1' }] }, state)
      ).rejects.toThrow('expected PLANNING');
    });

    it('throws for empty plan', async () => {
      const tool = submitPlanTool(state);
      await expect(
        tool.handler({ taskId: 'task-1', steps: [] }, state)
      ).rejects.toThrow('plan cannot be empty');
    });

    it('rejects plan with forbidden pattern', async () => {
      const tool = submitPlanTool(state);
      await expect(
        tool.handler({ taskId: 'task-1', steps: [{ description: 'Run rm -rf /' }] }, state)
      ).rejects.toThrow('Rail violation');
    });
  });

  describe('moe.check_approval', () => {
    beforeEach(async () => {
      setupMoeFolder();
      createEpic();
      await state.load();
    });

    it('returns approved=true for WORKING status', async () => {
      createTask({ id: 'task-w', status: 'WORKING' });
      await state.load();
      const tool = checkApprovalTool(state);
      const result = await tool.handler({ taskId: 'task-w' }, state) as { approved: boolean };
      expect(result.approved).toBe(true);
    });

    it('returns approved=false for AWAITING_APPROVAL', async () => {
      createTask({ id: 'task-a', status: 'AWAITING_APPROVAL' });
      await state.load();
      const tool = checkApprovalTool(state);
      const result = await tool.handler({ taskId: 'task-a' }, state) as { approved: boolean; status: string };
      expect(result.approved).toBe(false);
      expect(result.status).toBe('AWAITING_APPROVAL');
    });

    it('returns rejected info when plan was rejected', async () => {
      createTask({ id: 'task-r', status: 'PLANNING', reopenReason: 'Needs more detail' });
      await state.load();
      const tool = checkApprovalTool(state);
      const result = await tool.handler({ taskId: 'task-r' }, state) as { rejected: boolean; rejectionReason: string };
      expect(result.rejected).toBe(true);
      expect(result.rejectionReason).toBe('Needs more detail');
    });

    it('throws for non-existent task', async () => {
      const tool = checkApprovalTool(state);
      await expect(tool.handler({ taskId: 'nonexistent' }, state)).rejects.toThrow('Task not found');
    });

    it('refreshes worker lastActivityAt when checking approval', async () => {
      createTask({ id: 'task-heartbeat-approval', status: 'AWAITING_APPROVAL' });
      await state.load();
      await state.createWorker({
        id: 'worker-approval',
        type: 'CLAUDE',
        projectId: 'proj-test',
        epicId: 'epic-1',
        currentTaskId: 'task-heartbeat-approval',
        status: 'AWAITING_APPROVAL',
      });
      const before = state.getWorker('worker-approval')!.lastActivityAt;
      await new Promise((resolve) => setTimeout(resolve, 10));

      const tool = checkApprovalTool(state);
      await tool.handler({ taskId: 'task-heartbeat-approval', workerId: 'worker-approval' }, state);

      expect(new Date(state.getWorker('worker-approval')!.lastActivityAt).getTime())
        .toBeGreaterThan(new Date(before).getTime());
    });
  });

  describe('moe.start_step', () => {
    beforeEach(async () => {
      setupMoeFolder();
      createEpic();
      createTask({
        status: 'WORKING',
        implementationPlan: [
          { stepId: 'step-1', description: 'First step', status: 'PENDING', affectedFiles: [] },
          { stepId: 'step-2', description: 'Second step', status: 'PENDING', affectedFiles: [] },
        ],
      });
      await state.load();
    });

    it('marks step as IN_PROGRESS', async () => {
      const tool = startStepTool(state);
      const result = await tool.handler({ taskId: 'task-1', stepId: 'step-1' }, state) as { success: boolean; stepNumber: number };

      expect(result.success).toBe(true);
      expect(result.stepNumber).toBe(1);

      const task = state.getTask('task-1');
      expect(task?.implementationPlan[0].status).toBe('IN_PROGRESS');
      expect(task?.implementationPlan[0].startedAt).toBeDefined();
    });

    it('throws for non-existent step', async () => {
      const tool = startStepTool(state);
      await expect(
        tool.handler({ taskId: 'task-1', stepId: 'nonexistent' }, state)
      ).rejects.toThrow('STEP_NOT_FOUND');
    });
  });

  describe('moe.complete_step', () => {
    beforeEach(async () => {
      setupMoeFolder();
      createEpic();
      createTask({
        status: 'WORKING',
        implementationPlan: [
          { stepId: 'step-1', description: 'First', status: 'IN_PROGRESS', affectedFiles: [] },
          { stepId: 'step-2', description: 'Second', status: 'PENDING', affectedFiles: [] },
        ],
      });
      await state.load();
    });

    it('marks step as COMPLETED and returns progress', async () => {
      const tool = completeStepTool(state);
      const result = await tool.handler({ taskId: 'task-1', stepId: 'step-1' }, state) as {
        success: boolean;
        progress: { completed: number; total: number; percentage: number };
        nextStep: { stepId: string } | null;
      };

      expect(result.success).toBe(true);
      expect(result.progress.completed).toBe(1);
      expect(result.progress.total).toBe(2);
      expect(result.progress.percentage).toBe(50);
      expect(result.nextStep?.stepId).toBe('step-2');
    });

    it('rejects completing a PENDING step before start_step', async () => {
      const tool = completeStepTool(state);

      await expect(
        tool.handler({ taskId: 'task-1', stepId: 'step-2' }, state)
      ).rejects.toMatchObject({
        code: MoeErrorCode.INVALID_STATE,
        context: { entity: 'Step', currentState: 'PENDING', expectedState: 'IN_PROGRESS' },
      });
      await expect(
        tool.handler({ taskId: 'task-1', stepId: 'step-2' }, state)
      ).rejects.toThrow('moe.start_step');

      expect(state.getTask('task-1')?.implementationPlan[1].status).toBe('PENDING');
      expect(state.getTask('task-1')?.stepsCompleted).toBeUndefined();
    });

    it('requires claimed workers to fetch context before complete_step', async () => {
      await state.updateTask('task-1', { assignedWorkerId: 'worker-step', contextFetchedBy: [] });
      const tool = completeStepTool(state);

      await expect(
        tool.handler({ taskId: 'task-1', stepId: 'step-1', workerId: 'worker-step' }, state)
      ).rejects.toThrow('before moe.complete_step');
    });

    it('returns null nextStep when all steps done', async () => {
      await state.updateTask('task-1', {
        implementationPlan: [
          { stepId: 'step-1', description: 'First', status: 'IN_PROGRESS', affectedFiles: [] },
        ],
      });
      const tool = completeStepTool(state);
      const result = await tool.handler({ taskId: 'task-1', stepId: 'step-1' }, state) as { nextStep: null };
      expect(result.nextStep).toBeNull();
    });

    it('stores note and modifiedFiles on the step', async () => {
      const tool = completeStepTool(state);
      await tool.handler({
        taskId: 'task-1',
        stepId: 'step-1',
        note: 'Used workaround for edge case',
        modifiedFiles: ['src/foo.ts', 'src/bar.ts'],
      }, state);

      const task = state.getTask('task-1');
      const step = task?.implementationPlan.find(s => s.stepId === 'step-1');
      expect(step?.note).toBe('Used workaround for edge case');
      expect(step?.modifiedFiles).toEqual(['src/foo.ts', 'src/bar.ts']);
    });

    it('does not set note or modifiedFiles when not provided', async () => {
      const tool = completeStepTool(state);
      await tool.handler({ taskId: 'task-1', stepId: 'step-1' }, state);

      const task = state.getTask('task-1');
      const step = task?.implementationPlan.find(s => s.stepId === 'step-1');
      expect(step?.note).toBeUndefined();
      expect(step?.modifiedFiles).toBeUndefined();
    });

    it('refreshes worker lastActivityAt when completing a step', async () => {
      await state.updateTask('task-1', { assignedWorkerId: 'worker-step', contextFetchedBy: ['worker-step'] });
      await state.createWorker({
        id: 'worker-step',
        type: 'CLAUDE',
        projectId: 'proj-test',
        epicId: 'epic-1',
        currentTaskId: 'task-1',
        status: 'CODING',
      });
      const before = state.getWorker('worker-step')!.lastActivityAt;
      await new Promise((resolve) => setTimeout(resolve, 10));

      const tool = completeStepTool(state);
      await tool.handler({ taskId: 'task-1', stepId: 'step-1', workerId: 'worker-step' }, state);

      const worker = state.getWorker('worker-step')!;
      expect(new Date(worker.lastActivityAt).getTime()).toBeGreaterThan(new Date(before).getTime());
      expect(worker.status).toBe('CODING');
      expect(worker.currentTaskId).toBe('task-1');
    });
  });

  describe('moe.complete_task', () => {
    beforeEach(async () => {
      setupMoeFolder();
      createEpic();
      createTask({
        status: 'WORKING',
        implementationPlan: [
          { stepId: 'step-1', description: 'Done', status: 'COMPLETED', affectedFiles: ['a.ts', 'b.ts'] },
        ],
      });
      await state.load();
    });

    it('moves task to REVIEW', async () => {
      const tool = completeTaskTool(state);
      const result = await tool.handler({ taskId: 'task-1' }, state) as {
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
      const tool = completeTaskTool(state);
      await tool.handler({ taskId: 'task-1', prLink: 'https://github.com/pr/123' }, state);
      const task = state.getTask('task-1');
      expect(task?.prLink).toBe('https://github.com/pr/123');
    });

    it('prefers modifiedFiles over affectedFiles in stats (B24)', async () => {
      // Update the existing task to have steps with both modifiedFiles and affectedFiles
      await state.updateTask('task-1', {
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

      const tool = completeTaskTool(state);
      const result = await tool.handler({ taskId: 'task-1' }, state) as {
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

    it('does not auto-save generic completion memory by default', async () => {
      await state.updateTask('task-1', { assignedWorkerId: 'worker-1' });
      const tool = completeTaskTool(state);

      await tool.handler({ taskId: 'task-1', workerId: 'worker-1', summary: 'Routine task completed' }, state);

      expect(state.getMemoryManager().getEntryCount()).toBe(0);
    });

    it('can auto-save generic completion memory when project setting enables it', async () => {
      await state.updateTask('task-1', { assignedWorkerId: 'worker-1' });
      state.project!.settings.memory = {
        autoSave: {
          completedTask: true,
          firstPassApproval: false,
          qaRejection: true,
          reopenedApproval: true,
        },
      };
      const tool = completeTaskTool(state);

      await tool.handler({ taskId: 'task-1', workerId: 'worker-1', summary: 'Reusable completion note' }, state);

      expect(state.getMemoryManager().getEntryCount()).toBe(1);
    });

    it('does not fail completion when enabled memory auto-save throws', async () => {
      await state.updateTask('task-1', { assignedWorkerId: 'worker-1' });
      state.project!.settings.memory = {
        autoSave: { completedTask: true },
      };
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      vi.spyOn(state.getMemoryManager(), 'addEntry').mockRejectedValueOnce(new Error('memory disk full'));
      const tool = completeTaskTool(state);

      await expect(tool.handler({
        taskId: 'task-1',
        workerId: 'worker-1',
        summary: 'Memory write will fail',
      }, state)).resolves.toMatchObject({ success: true, status: 'REVIEW' });
      expect(state.getTask('task-1')?.status).toBe('REVIEW');
    });
  });

  describe('moe.report_blocked', () => {
    beforeEach(async () => {
      setupMoeFolder();
      createEpic();
      createTask({ assignedWorkerId: 'worker-1' });
      createWorker();
      await state.load();
    });

    it('marks worker as blocked', async () => {
      const tool = reportBlockedTool(state);
      const result = await tool.handler({
        taskId: 'task-1',
        reason: 'Need clarification',
      }, state) as { success: boolean; workerStatus: string };

      expect(result.success).toBe(true);
      expect(result.workerStatus).toBe('BLOCKED');

      const worker = state.getWorker('worker-1');
      expect(worker?.status).toBe('BLOCKED');
      expect(worker?.lastError).toBe('Need clarification');
    });

    it('throws for non-existent task', async () => {
      const tool = reportBlockedTool(state);
      await expect(
        tool.handler({ taskId: 'nonexistent', reason: 'test' }, state)
      ).rejects.toThrow('Task not found');
    });
  });

  describe('moe.list_tasks', () => {
    beforeEach(async () => {
      setupMoeFolder();
      createEpic({ id: 'epic-1' });
      createEpic({ id: 'epic-2', order: 2 });
      createTask({ id: 'task-1', epicId: 'epic-1', status: 'BACKLOG' });
      createTask({ id: 'task-2', epicId: 'epic-1', status: 'WORKING', order: 2 });
      createTask({ id: 'task-3', epicId: 'epic-2', status: 'DONE' });
      await state.load();
    });

    it('lists all tasks', async () => {
      const tool = listTasksTool(state);
      const result = await tool.handler({}, state) as { tasks: Array<{ id: string }> };
      expect(result.tasks.length).toBe(3);
    });

    it('filters by epicId', async () => {
      const tool = listTasksTool(state);
      const result = await tool.handler({ epicId: 'epic-1' }, state) as { tasks: Array<{ id: string }> };
      expect(result.tasks.length).toBe(2);
      expect(result.tasks.map(t => t.id)).toContain('task-1');
      expect(result.tasks.map(t => t.id)).toContain('task-2');
    });

    it('filters by status', async () => {
      const tool = listTasksTool(state);
      const result = await tool.handler({ status: ['BACKLOG'] }, state) as { tasks: Array<{ id: string }>; counts: { backlog: number } };
      expect(result.tasks.length).toBe(1);
      expect(result.tasks[0].id).toBe('task-1');
      expect(result.counts.backlog).toBe(1);
    });

    it('returns status counts', async () => {
      const tool = listTasksTool(state);
      const result = await tool.handler({}, state) as { counts: { backlog: number; inProgress: number; done: number } };
      expect(result.counts.backlog).toBe(1);
      expect(result.counts.inProgress).toBe(1);
      expect(result.counts.done).toBe(1);
    });

    it('paginates task summaries for large task lists', async () => {
      createTask({ id: 'task-4', epicId: 'epic-1', status: 'BACKLOG', order: 4, description: 'full description should not be listed' });
      await state.load();

      const tool = listTasksTool(state);
      const result = await tool.handler({ epicId: 'epic-1', limit: 2, offset: 1 }, state) as {
        tasks: Array<{ id: string; description?: string; definitionOfDone?: string[]; planStepCount: number }>;
        pagination: { limit: number; offset: number; returned: number; total: number; hasMore: boolean };
      };

      expect(result.tasks.map(task => task.id)).toEqual(['task-2', 'task-4']);
      expect(result.tasks[0].description).toBeUndefined();
      expect(result.tasks[0].definitionOfDone).toBeUndefined();
      expect(result.tasks[0].planStepCount).toBeGreaterThanOrEqual(0);
      expect(result.pagination).toEqual({
        limit: 2,
        offset: 1,
        returned: 2,
        total: 3,
        hasMore: false,
      });
    });
  });

  describe('moe.create_team', () => {
    beforeEach(async () => {
      setupMoeFolder();
      await state.load();
    });

    it('creates a team with role', async () => {
      const tool = createTeamTool(state);
      const result = await tool.handler({ name: 'Moe Team', role: 'worker' }, state) as {
        team: { id: string; role: string | null };
        created: boolean;
      };

      expect(result.created).toBe(true);
      expect(result.team.role).toBe('worker');
      expect(result.team.id).toBeTruthy();
    });

    it('creates a team without role and is idempotent by name', async () => {
      const tool = createTeamTool(state);
      const first = await tool.handler({ name: 'Moe Team' }, state) as {
        team: { id: string; role: string | null };
        created: boolean;
      };
      expect(first.created).toBe(true);
      expect(first.team.role).toBeNull();

      const second = await tool.handler({ name: 'Moe Team' }, state) as {
        team: { id: string };
        created: boolean;
      };

      expect(second.created).toBe(false);
      expect(second.team.id).toBe(first.team.id);

      await expect(tool.handler({ name: 'Moe Team', maxSize: 0 }, state)).rejects.toThrow('maxSize');
    });

    it('rejects invalid team payloads without creating a team', async () => {
      const tool = createTeamTool(state);

      await expect(tool.handler({ name: 'Bad Team', role: 'worker', maxSize: 0 }, state)).rejects.toThrow('maxSize');
      await expect(tool.handler({ name: 'Bad Team', role: 'manager' }, state)).rejects.toThrow('role');

      expect(Array.from(state.teams.values()).some(team => team.name === 'Bad Team')).toBe(false);
    });

    it('ignores proxy-injected workerId field', async () => {
      const tool = createTeamTool(state);
      const result = await tool.handler({ name: 'InjectTest', workerId: 'worker' }, state) as {
        team: { id: string; name: string };
        created: boolean;
      };
      expect(result.team.name).toBe('InjectTest');
      expect(result.created).toBe(true);
    });
  });

  describe('moe.get_next_task', () => {
    beforeEach(async () => {
      setupMoeFolder();
      createEpic();
      createTask({ id: 'task-1', status: 'BACKLOG', order: 2 });
      createTask({ id: 'task-2', status: 'BACKLOG', order: 1 });
      createTask({ id: 'task-3', status: 'WORKING' });
      await state.load();
    });

    it('returns next backlog task sorted by order', async () => {
      const tool = getNextTaskTool(state);
      const result = await tool.handler({}, state) as {
        hasNext: boolean;
        detail: string;
        task: { id: string; description?: string; definitionOfDone?: string[]; descriptionPreview?: string };
      };
      expect(result.hasNext).toBe(true);
      expect(result.task.id).toBe('task-2'); // order 1 comes first
      expect(result.detail).toBe('summary');
      expect(result.task.description).toBeUndefined();
      expect(result.task.definitionOfDone).toBeUndefined();
      expect(result.task.descriptionPreview).toBeDefined();
    });

    it('supports full next-task detail when explicitly requested', async () => {
      const tool = getNextTaskTool(state);
      const result = await tool.handler({ detail: 'full' }, state) as {
        hasNext: boolean;
        detail: string;
        task: { id: string; description: string; definitionOfDone: string[]; descriptionPreview?: string };
      };
      expect(result.hasNext).toBe(true);
      expect(result.detail).toBe('full');
      expect(result.task.id).toBe('task-2');
      expect(result.task.description).toBe('Task description');
      expect(result.task.definitionOfDone).toEqual(['Tests pass', 'Code reviewed']);
      expect(result.task.descriptionPreview).toBeUndefined();
    });

    it('filters by epicId', async () => {
      createEpic({ id: 'epic-2' });
      createTask({ id: 'task-e2', epicId: 'epic-2', status: 'BACKLOG' });
      await state.load();

      const tool = getNextTaskTool(state);
      const result = await tool.handler({ epicId: 'epic-2' }, state) as { task: { id: string } };
      expect(result.task.id).toBe('task-e2');
    });

    it('returns hasNext=false when no backlog tasks', async () => {
      await state.updateTask('task-1', { status: 'DONE' });
      await state.updateTask('task-2', { status: 'DONE' });
      const tool = getNextTaskTool(state);
      const result = await tool.handler({}, state) as { hasNext: boolean };
      expect(result.hasNext).toBe(false);
    });
  });

  describe('moe.create_task', () => {
    beforeEach(async () => {
      setupMoeFolder();
      createEpic();
      await state.load();
    });

    it('creates a new task', async () => {
      const tool = createTaskTool(state);
      const result = await tool.handler({
        epicId: 'epic-1',
        title: 'New Task',
        description: 'Task desc',
      }, state) as { success: boolean; task: Task };

      expect(result.success).toBe(true);
      expect(result.task.title).toBe('New Task');
      expect(result.task.createdBy).toBe('WORKER');
    });

    it('throws for missing epicId', async () => {
      const tool = createTaskTool(state);
      await expect(tool.handler({ title: 'Test' }, state)).rejects.toThrow('Missing required field: epicId');
    });

    it('throws for missing title', async () => {
      const tool = createTaskTool(state);
      await expect(tool.handler({ epicId: 'epic-1' }, state)).rejects.toThrow('Missing required field: title');
    });
  });

  describe('moe.create_epic', () => {
    beforeEach(async () => {
      setupMoeFolder();
      await state.load();
    });

    it('creates a new epic', async () => {
      const tool = createEpicTool(state);
      const result = await tool.handler({
        title: 'New Epic',
        description: 'Epic desc',
      }, state) as { success: boolean; epic: Epic };

      expect(result.success).toBe(true);
      expect(result.epic.title).toBe('New Epic');
      expect(result.epic.status).toBe('PLANNED');
    });

    it('throws for missing title', async () => {
      const tool = createEpicTool(state);
      await expect(tool.handler({}, state)).rejects.toThrow('Missing required field: title');
    });
  });

  describe('moe.set_task_status', () => {
    beforeEach(async () => {
      setupMoeFolder();
      createEpic();
      createTask({ status: 'BACKLOG' });
      await state.load();
    });

    it('changes task status', async () => {
      const tool = setTaskStatusTool(state);
      const result = await tool.handler({
        taskId: 'task-1',
        status: 'PLANNING',
      }, state) as { success: boolean; status: string };

      expect(result.success).toBe(true);
      expect(result.status).toBe('PLANNING');
    });

    it('validates status transitions', async () => {
      const tool = setTaskStatusTool(state);
      // BACKLOG -> DONE is not valid
      await expect(
        tool.handler({ taskId: 'task-1', status: 'DONE' }, state)
      ).rejects.toThrow('status transition not allowed');
    });

    it('rejects invalid status values', async () => {
      const tool = setTaskStatusTool(state);
      await expect(
        tool.handler({ taskId: 'task-1', status: 'INVALID' }, state)
      ).rejects.toThrow('Invalid status');
    });

    it('increments reopenCount when reopening with reason', async () => {
      await state.updateTask('task-1', { status: 'REVIEW' });
      const tool = setTaskStatusTool(state);
      await tool.handler({
        taskId: 'task-1',
        status: 'WORKING',
        reason: 'Fix needed',
      }, state);

      const task = state.getTask('task-1');
      expect(task?.reopenCount).toBe(1);
      expect(task?.reopenReason).toBe('Fix needed');
    });
  });

  describe('moe.claim_next_task', () => {
    beforeEach(async () => {
      setupMoeFolder();
      createEpic();
      createTask({ id: 'task-1', status: 'BACKLOG', order: 2 });
      createTask({ id: 'task-2', status: 'BACKLOG', order: 1 });
      createTask({ id: 'task-3', status: 'PLANNING' });
      await state.load();
    });

    it('claims next task by status', async () => {
      const tool = claimNextTaskTool(state);
      const result = await tool.handler({
        statuses: ['BACKLOG'],
      }, state) as { hasNext: boolean; task: { id: string } };

      expect(result.hasNext).toBe(true);
      expect(result.task.id).toBe('task-2'); // lowest order
    });

    it('keeps claim response lean and defers full context to get_context', async () => {
      const tool = claimNextTaskTool(state);
      const result = await tool.handler({
        statuses: ['BACKLOG'],
        workerId: 'worker-lean',
      }, state) as {
        hasNext: boolean;
        task: Record<string, unknown>;
        chatHint?: string;
        nextAction?: unknown;
        project?: unknown;
        epic?: unknown;
        allRails?: unknown;
        memory?: unknown;
      };

      expect(result.hasNext).toBe(true);
      expect(Object.keys(result).sort()).toEqual(['chatHint', 'hasNext', 'nextAction', 'task'].sort());
      expect(Object.keys(result.task).sort()).toEqual([
        'assignedWorkerId',
        'epicId',
        'generalChannelId',
        'id',
        'priority',
        'rejectionDetails',
        'reopenCount',
        'reopenReason',
        'roleChannelId',
        'status',
        'title',
      ].sort());
      expect(result.task.id).toBe('task-2');
      expect(result.task.description).toBeUndefined();
      expect(result.task.definitionOfDone).toBeUndefined();
      expect(result.task.taskRails).toBeUndefined();
      expect(result.task.implementationPlan).toBeUndefined();
      expect(result.project).toBeUndefined();
      expect(result.epic).toBeUndefined();
      expect(result.allRails).toBeUndefined();
      expect(result.memory).toBeUndefined();
    });

    it('assigns workerId to claimed task', async () => {
      const tool = claimNextTaskTool(state);
      const result = await tool.handler({
        statuses: ['BACKLOG'],
        workerId: 'worker-1',
      }, state) as { task: { assignedWorkerId: string | null } };

      const task = state.getTask('task-2');
      expect(task?.assignedWorkerId).toBe('worker-1');
      expect(result.task.assignedWorkerId).toBe('worker-1');
    });

    it('returns current assignment data when replacing an existing worker', async () => {
      createTask({
        id: 'task-active-worker',
        status: 'BACKLOG',
        assignedWorkerId: 'worker-other',
        order: 99,
      });
      createWorker({
        id: 'worker-other',
        status: 'READING_CONTEXT',
        currentTaskId: 'task-active-worker',
      });
      await state.load();

      const tool = claimNextTaskTool(state);
      const result = await tool.handler({
        statuses: ['BACKLOG'],
        workerId: 'worker-replacement',
        replaceExisting: true,
      }, state) as { task: { id: string; assignedWorkerId: string | null } };

      expect(result.task.id).toBe('task-2');
      expect(result.task.assignedWorkerId).toBe('worker-replacement');
      expect(state.getTask('task-2')?.assignedWorkerId).toBe('worker-replacement');
      expect(state.getTask('task-active-worker')?.assignedWorkerId).toBeNull();
    });

    it('repairs and claims a task assigned to a missing worker', async () => {
      createTask({
        id: 'task-orphan-worker',
        status: 'WORKING',
        assignedWorkerId: 'worker-missing',
        order: 0,
      });
      await state.load();

      const tool = claimNextTaskTool(state);
      const result = await tool.handler({
        statuses: ['WORKING'],
        workerId: 'worker-reclaimer',
      }, state) as { hasNext: boolean; task: { id: string; assignedWorkerId: string | null } };

      expect(result.hasNext).toBe(true);
      expect(result.task.id).toBe('task-orphan-worker');
      expect(result.task.assignedWorkerId).toBe('worker-reclaimer');
      expect(state.getTask('task-orphan-worker')?.assignedWorkerId).toBe('worker-reclaimer');
    });

    it('wait_for_task treats a task assigned to a missing worker as available', async () => {
      createTask({
        id: 'task-wait-orphan',
        status: 'REVIEW',
        assignedWorkerId: 'worker-missing',
        order: 0,
      });
      await state.load();

      const tool = waitForTaskTool(state);
      const result = await tool.handler({
        statuses: ['REVIEW'],
        workerId: 'worker-waiter',
        timeoutMs: 1000,
      }, state) as { hasNext: boolean; task: { id: string }; nextAction: { tool: string } };

      expect(result.hasNext).toBe(true);
      expect(result.task.id).toBe('task-wait-orphan');
      expect(result.nextAction.tool).toBe('moe.claim_next_task');
    });

    it('claims from multiple statuses', async () => {
      const tool = claimNextTaskTool(state);
      const result = await tool.handler({
        statuses: ['PLANNING', 'BACKLOG'],
      }, state) as { task: { id: string } };

      // task-2 (BACKLOG, order 1) comes before task-3 (PLANNING, order 1)
      expect(result.task).toBeDefined();
    });

    it('throws for empty statuses', async () => {
      const tool = claimNextTaskTool(state);
      await expect(tool.handler({ statuses: [] }, state)).rejects.toThrow('Missing required field: statuses');
    });

    it('returns hasNext=false when no matching tasks', async () => {
      const tool = claimNextTaskTool(state);
      const result = await tool.handler({ statuses: ['DONE'], workerId: 'worker-none' }, state) as {
        hasNext: boolean;
        nextAction: { tool: string; args: { statuses: string[]; workerId: string } };
      };
      expect(result.hasNext).toBe(false);
      expect(Object.keys(result).sort()).toEqual(['hasNext', 'nextAction'].sort());
      expect(result.nextAction.tool).toBe('moe.wait_for_task');
      expect(result.nextAction.args.statuses).toEqual(['DONE']);
      expect(result.nextAction.args.workerId).toBe('worker-none');
    });

    it('includes rejection fields when task was reopened', async () => {
      createTask({
        id: 'task-reopened',
        status: 'WORKING',
        order: 0,
        reopenCount: 1,
        reopenReason: 'Tests failing in auth module',
        rejectionDetails: {
          failedDodItems: ['Tests pass'],
          issues: [{ type: 'test_failure', description: 'AuthService test fails', file: 'src/auth.test.ts', line: 42 }],
        },
      });
      await state.load();

      const tool = claimNextTaskTool(state);
      const result = await tool.handler({
        statuses: ['WORKING'],
        workerId: 'worker-reopen',
      }, state) as {
        hasNext: boolean;
        task: { reopenCount: number; reopenReason: string; rejectionDetails: { failedDodItems: string[]; issues: Array<{ type: string }> } };
        reopenWarning: string;
      };

      expect(result.hasNext).toBe(true);
      expect(result.task.reopenCount).toBe(1);
      expect(result.task.reopenReason).toBe('Tests failing in auth module');
      expect(result.task.rejectionDetails).not.toBeNull();
      expect(result.task.rejectionDetails.failedDodItems).toEqual(['Tests pass']);
      expect(result.task.rejectionDetails.issues).toHaveLength(1);
      expect(result.task.rejectionDetails.issues[0].type).toBe('test_failure');
      expect(result.reopenWarning).toContain('WARNING');
      expect(result.reopenWarning).toContain('1 time(s)');
    });

    it('omits reopenWarning when task was not reopened', async () => {
      const tool = claimNextTaskTool(state);
      const result = await tool.handler({
        statuses: ['BACKLOG'],
        workerId: 'worker-normal',
      }, state) as {
        hasNext: boolean;
        task: { reopenCount: number; reopenReason: string | null; rejectionDetails: null };
        reopenWarning?: string;
      };

      expect(result.hasNext).toBe(true);
      expect(result.task.reopenCount).toBe(0);
      expect(result.task.reopenReason).toBeNull();
      expect(result.task.rejectionDetails).toBeNull();
      expect(result.reopenWarning).toBeUndefined();
    });

    it('claims a specific task when taskId is provided, bypassing priority order', async () => {
      // task-2 has lower order so default claim picks it; with taskId we want task-1 instead.
      const tool = claimNextTaskTool(state);
      const result = await tool.handler({
        statuses: ['BACKLOG'],
        taskId: 'task-1',
        workerId: 'worker-direct',
      }, state) as { hasNext: boolean; task: { id: string; assignedWorkerId: string } };

      expect(result.hasNext).toBe(true);
      expect(result.task.id).toBe('task-1');
      expect(result.task.assignedWorkerId).toBe('worker-direct');
      expect(state.getTask('task-1')?.assignedWorkerId).toBe('worker-direct');
      // task-2 should still be free
      expect(state.getTask('task-2')?.assignedWorkerId).toBeNull();
    });

    it('rejects taskId when task is not in any of the requested statuses', async () => {
      const tool = claimNextTaskTool(state);
      // task-3 is PLANNING; we ask for BACKLOG only
      await expect(tool.handler({
        statuses: ['BACKLOG'],
        taskId: 'task-3',
      }, state)).rejects.toThrow(/PLANNING/);
    });

    it('rejects taskId for unknown task', async () => {
      const tool = claimNextTaskTool(state);
      await expect(tool.handler({
        statuses: ['BACKLOG'],
        taskId: 'task-nope',
      }, state)).rejects.toThrow(/not found|NOT_FOUND/i);
    });

    it('rejects taskId already assigned to someone else without replaceExisting', async () => {
      createTask({ id: 'task-locked', status: 'BACKLOG', assignedWorkerId: 'worker-other', order: 99 });
      createWorker({ id: 'worker-other', status: 'READING_CONTEXT', currentTaskId: 'task-locked' });
      await state.load();
      const tool = claimNextTaskTool(state);
      await expect(tool.handler({
        statuses: ['BACKLOG'],
        taskId: 'task-locked',
        workerId: 'worker-thief',
      }, state)).rejects.toThrow(/already assigned/);
    });
  });

  describe('moe.propose_rail', () => {
    beforeEach(async () => {
      setupMoeFolder();
      createEpic();
      createTask({ assignedWorkerId: 'worker-1' });
      await state.load();
    });

    it('creates a rail proposal', async () => {
      const tool = proposeRailTool(state);
      const result = await tool.handler({
        taskId: 'task-1',
        proposalType: 'ADD_RAIL',
        targetScope: 'GLOBAL',
        proposedValue: 'always use async/await',
        reason: 'Improves readability',
      }, state) as { success: boolean; proposalId: string; status: string };

      expect(result.success).toBe(true);
      expect(result.proposalId).toMatch(/^prop-/);
      expect(result.status).toBe('PENDING');

      expect(state.proposals.size).toBe(1);
    });

    it('throws for non-existent task', async () => {
      const tool = proposeRailTool(state);
      await expect(
        tool.handler({
          taskId: 'nonexistent',
          proposalType: 'ADD_RAIL',
          targetScope: 'TASK',
          proposedValue: 'test',
          reason: 'test',
        }, state)
      ).rejects.toThrow('Task not found');
    });

    it('includes workerId from assigned task', async () => {
      const tool = proposeRailTool(state);
      await tool.handler({
        taskId: 'task-1',
        proposalType: 'MODIFY_RAIL',
        targetScope: 'EPIC',
        currentValue: 'old value',
        proposedValue: 'new value',
        reason: 'Better approach',
      }, state);

      const proposal = Array.from(state.proposals.values())[0];
      expect(proposal.workerId).toBe('worker-1');
      expect(proposal.currentValue).toBe('old value');
    });
  });

  describe('moe.delete_task', () => {
    beforeEach(async () => {
      setupMoeFolder();
      createEpic();
      createTask({ id: 'task-1', status: 'BACKLOG' });
      await state.load();
    });

    it('deletes a task and returns it', async () => {
      const tool = deleteTaskTool(state);
      const result = await tool.handler({ taskId: 'task-1' }, state) as { success: boolean; task: Task };

      expect(result.success).toBe(true);
      expect(result.task.id).toBe('task-1');
      expect(state.getTask('task-1')).toBeNull();
    });

    it('throws for missing taskId', async () => {
      const tool = deleteTaskTool(state);
      await expect(tool.handler({}, state)).rejects.toThrow('Missing required field: taskId');
    });

    it('throws for non-existent task', async () => {
      const tool = deleteTaskTool(state);
      await expect(tool.handler({ taskId: 'nonexistent' }, state)).rejects.toThrow('Task not found: nonexistent');
    });
  });

  describe('moe.update_epic', () => {
    beforeEach(async () => {
      setupMoeFolder();
      createEpic({ id: 'epic-1', title: 'Original Title' });
      await state.load();
    });

    it('updates epic title', async () => {
      const tool = updateEpicTool(state);
      const result = await tool.handler({
        epicId: 'epic-1',
        title: 'Updated Title',
      }, state) as { success: boolean; epic: Epic };

      expect(result.success).toBe(true);
      expect(result.epic.title).toBe('Updated Title');
    });

    it('updates multiple fields', async () => {
      const tool = updateEpicTool(state);
      const result = await tool.handler({
        epicId: 'epic-1',
        description: 'New desc',
        epicRails: ['Rule 1', 'Rule 2'],
        status: 'COMPLETED',
      }, state) as { success: boolean; epic: Epic };

      expect(result.success).toBe(true);
      expect(result.epic.description).toBe('New desc');
      expect(result.epic.epicRails).toEqual(['Rule 1', 'Rule 2']);
      expect(result.epic.status).toBe('COMPLETED');
    });

    it('throws for missing epicId', async () => {
      const tool = updateEpicTool(state);
      await expect(tool.handler({}, state)).rejects.toThrow('Missing required field: epicId');
    });

    it('rejects invalid updates without mutating the epic', async () => {
      const tool = updateEpicTool(state);

      await expect(tool.handler({
        epicId: 'epic-1',
        status: 'BROKEN',
        title: 'Should Not Persist',
      }, state)).rejects.toThrow('status');

      expect(state.getEpic('epic-1')?.title).toBe('Original Title');
    });

    it('rejects unknown epic update fields before applying allowed fields', async () => {
      const tool = updateEpicTool(state);

      await expect(tool.handler({
        epicId: 'epic-1',
        id: 'epic-evil',
        title: 'Should Not Persist',
      }, state)).rejects.toThrow('id');

      expect(state.getEpic('epic-1')?.id).toBe('epic-1');
      expect(state.getEpic('epic-1')?.title).toBe('Original Title');
    });
  });

  describe('moe.delete_epic', () => {
    beforeEach(async () => {
      setupMoeFolder();
      createEpic({ id: 'epic-1' });
      await state.load();
    });

    it('deletes epic without tasks', async () => {
      const tool = deleteEpicTool(state);
      const result = await tool.handler({ epicId: 'epic-1' }, state) as {
        success: boolean;
        deletedEpic: Epic;
        deletedTaskCount: number;
      };

      expect(result.success).toBe(true);
      expect(result.deletedEpic.id).toBe('epic-1');
      expect(result.deletedTaskCount).toBe(0);
    });

    it('throws when epic has tasks and cascadeDelete is false', async () => {
      createTask({ epicId: 'epic-1' });
      await state.load();

      const tool = deleteEpicTool(state);
      await expect(
        tool.handler({ epicId: 'epic-1', cascadeDelete: false }, state)
      ).rejects.toThrow('has 1 task(s)');
    });

    it('deletes epic and tasks when cascadeDelete is true', async () => {
      createTask({ epicId: 'epic-1' });
      await state.load();

      const tool = deleteEpicTool(state);
      const result = await tool.handler({
        epicId: 'epic-1',
        cascadeDelete: true,
      }, state) as { success: boolean; deletedTaskCount: number };

      expect(result.success).toBe(true);
      expect(result.deletedTaskCount).toBe(1);
    });

    it('throws for missing epicId', async () => {
      const tool = deleteEpicTool(state);
      await expect(tool.handler({}, state)).rejects.toThrow('Missing required field: epicId');
    });
  });

  describe('moe.search_tasks', () => {
    beforeEach(async () => {
      setupMoeFolder();
      createEpic();
      createTask({ id: 'task-1', title: 'Fix login bug', description: 'Auth error', status: 'BACKLOG' });
      createTask({ id: 'task-2', title: 'Add feature', description: 'New login feature', status: 'WORKING' });
      createTask({ id: 'task-3', title: 'Update docs', description: 'Documentation update', status: 'DONE' });
      await state.load();
    });

    it('searches by query in title', async () => {
      const tool = searchTasksTool(state);
      const result = await tool.handler({ query: 'login' }, state) as {
        tasks: Task[];
        totalMatches: number;
      };

      expect(result.totalMatches).toBe(2);
      expect(result.tasks.map(t => t.id)).toContain('task-1');
      expect(result.tasks.map(t => t.id)).toContain('task-2');
    });

    it('filters by status', async () => {
      const tool = searchTasksTool(state);
      const result = await tool.handler({
        filters: { status: 'WORKING' },
      }, state) as { tasks: Task[] };

      expect(result.tasks.length).toBe(1);
      expect(result.tasks[0].id).toBe('task-2');
    });

    it('combines query and filters', async () => {
      const tool = searchTasksTool(state);
      const result = await tool.handler({
        query: 'login',
        filters: { status: 'BACKLOG' },
      }, state) as { tasks: Task[] };

      expect(result.tasks.length).toBe(1);
      expect(result.tasks[0].id).toBe('task-1');
    });

    it('respects limit', async () => {
      const tool = searchTasksTool(state);
      const result = await tool.handler({ limit: 1 }, state) as { tasks: Task[] };
      expect(result.tasks.length).toBe(1);
    });

    it('returns compact summaries by default and full tasks only on opt-in', async () => {
      await state.updateTask('task-1', {
        description: 'Long login bug description '.repeat(30),
        implementationPlan: [
          { stepId: 'step-1', description: 'Fix it', status: 'PENDING', affectedFiles: [] },
        ],
      });

      const tool = searchTasksTool(state);
      const compact = await tool.handler({
        query: 'login',
        maxDescriptionChars: 60,
      }, state) as {
        detail: string;
        tasks: Array<{
          id: string;
          description?: string;
          descriptionPreview?: string;
          descriptionTruncated?: boolean;
          implementationPlan?: unknown;
          planStepCount: number;
        }>;
      };
      expect(compact.detail).toBe('summary');
      expect(compact.tasks[0].description).toBeUndefined();
      expect(compact.tasks[0].implementationPlan).toBeUndefined();
      expect(compact.tasks[0].descriptionPreview!.length).toBeLessThanOrEqual(60);
      expect(compact.tasks[0].descriptionTruncated).toBe(true);
      expect(compact.tasks[0].planStepCount).toBe(1);

      const full = await tool.handler({ query: 'login', detail: 'full', limit: 1 }, state) as {
        detail: string;
        tasks: Task[];
      };
      expect(full.detail).toBe('full');
      expect(full.tasks[0].description).toContain('Long login bug description');
      expect(full.tasks[0].implementationPlan).toHaveLength(1);
    });

    it('returns empty array when no matches', async () => {
      const tool = searchTasksTool(state);
      const result = await tool.handler({ query: 'nonexistent' }, state) as { tasks: Task[] };
      expect(result.tasks.length).toBe(0);
    });
  });

  describe('moe.qa_approve', () => {
    beforeEach(async () => {
      setupMoeFolder();
      createEpic();
      createTask({ id: 'task-1', status: 'REVIEW' });
      await state.load();
    });

    it('approves task in REVIEW and moves to DONE', async () => {
      const tool = qaApproveTool(state);
      const result = await tool.handler({
        taskId: 'task-1',
        summary: 'All DoD items verified',
      }, state) as { success: boolean; status: string };

      expect(result.success).toBe(true);
      expect(result.status).toBe('DONE');

      const task = state.getTask('task-1');
      expect(task?.status).toBe('DONE');
    });

    it('throws for missing taskId', async () => {
      const tool = qaApproveTool(state);
      await expect(tool.handler({}, state)).rejects.toThrow('Missing required field: taskId');
    });

    it('throws for non-REVIEW status', async () => {
      await state.updateTask('task-1', { status: 'WORKING' });
      const tool = qaApproveTool(state);
      await expect(
        tool.handler({ taskId: 'task-1' }, state)
      ).rejects.toThrow('expected REVIEW');
    });

    it('throws for non-existent task', async () => {
      const tool = qaApproveTool(state);
      await expect(
        tool.handler({ taskId: 'nonexistent' }, state)
      ).rejects.toThrow('Task not found');
    });

    it('does not auto-save first-pass approval memory by default', async () => {
      await state.updateTask('task-1', { assignedWorkerId: 'qa-1' });
      const tool = qaApproveTool(state);

      await tool.handler({ taskId: 'task-1', workerId: 'qa-1', summary: 'Looks good' }, state);

      expect(state.getMemoryManager().getEntryCount()).toBe(0);
    });

    it('can auto-save first-pass approval memory when project setting enables it', async () => {
      await state.updateTask('task-1', { assignedWorkerId: 'qa-1' });
      state.project!.settings.memory = {
        autoSave: { firstPassApproval: true },
      };
      const tool = qaApproveTool(state);

      await tool.handler({ taskId: 'task-1', workerId: 'qa-1', summary: 'First pass approval worth saving' }, state);

      expect(state.getMemoryManager().getEntryCount()).toBe(1);
    });

    it('auto-saves reopened approval memory by default', async () => {
      await state.updateTask('task-1', {
        assignedWorkerId: 'qa-1',
        reopenCount: 1,
        implementationPlan: [
          { stepId: 'step-1', description: 'Fix', status: 'COMPLETED', affectedFiles: ['fix.ts'] },
        ],
      });
      const tool = qaApproveTool(state);

      await tool.handler({ taskId: 'task-1', workerId: 'qa-1', summary: 'Rejected issue verified fixed' }, state);

      expect(state.getMemoryManager().getEntryCount()).toBe(1);
    });

    it('does not fail approval when enabled memory auto-save throws', async () => {
      await state.updateTask('task-1', { assignedWorkerId: 'qa-1', reopenCount: 1 });
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      vi.spyOn(state.getMemoryManager(), 'addEntry').mockRejectedValueOnce(new Error('memory disk full'));
      const tool = qaApproveTool(state);

      await expect(tool.handler({
        taskId: 'task-1',
        workerId: 'qa-1',
        summary: 'Memory write will fail',
      }, state)).resolves.toMatchObject({ success: true, status: 'DONE' });
      expect(state.getTask('task-1')?.status).toBe('DONE');
    });
  });

  describe('moe.qa_reject', () => {
    beforeEach(async () => {
      setupMoeFolder();
      createEpic();
      createTask({ id: 'task-1', status: 'REVIEW', reopenCount: 0 });
      await state.load();
    });

    it('rejects task and moves back to WORKING', async () => {
      const tool = qaRejectTool(state);
      const result = await tool.handler({
        taskId: 'task-1',
        reason: 'Tests are failing',
      }, state) as { success: boolean; status: string; reopenCount: number };

      expect(result.success).toBe(true);
      expect(result.status).toBe('WORKING');
      expect(result.reopenCount).toBe(1);

      const task = state.getTask('task-1');
      expect(task?.status).toBe('WORKING');
      expect(task?.reopenReason).toBe('Tests are failing');
    });

    it('auto-saves QA rejection memory by default', async () => {
      const tool = qaRejectTool(state);

      await tool.handler({
        taskId: 'task-1',
        reason: 'Tests are failing',
        workerId: 'qa-1',
        issues: [{ type: 'test_failure', description: 'Auth test fails', file: 'auth.test.ts' }],
      }, state);

      expect(state.getMemoryManager().getEntryCount()).toBe(1);
    });

    it('can disable QA rejection auto-memory', async () => {
      state.project!.settings.memory = {
        autoSave: { qaRejection: false },
      };
      const tool = qaRejectTool(state);

      await tool.handler({
        taskId: 'task-1',
        reason: 'Tests are failing',
        workerId: 'qa-1',
        issues: [{ type: 'test_failure', description: 'Auth test fails', file: 'auth.test.ts' }],
      }, state);

      expect(state.getMemoryManager().getEntryCount()).toBe(0);
    });

    it('does not fail rejection when enabled memory auto-save throws', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      vi.spyOn(state.getMemoryManager(), 'addEntry').mockRejectedValueOnce(new Error('memory disk full'));
      const tool = qaRejectTool(state);

      await expect(tool.handler({
        taskId: 'task-1',
        reason: 'Tests are failing',
        workerId: 'qa-1',
        issues: [{ type: 'test_failure', description: 'Auth test fails', file: 'auth.test.ts' }],
      }, state)).resolves.toMatchObject({ success: true, status: 'WORKING', reopenCount: 1 });
      expect(state.getTask('task-1')?.status).toBe('WORKING');
    });

    it('keeps explicit remember unaffected when all auto-save settings are disabled', async () => {
      state.project!.settings.memory = {
        autoSave: {
          completedTask: false,
          firstPassApproval: false,
          qaRejection: false,
          reopenedApproval: false,
        },
      };
      const tool = rememberTool(state);

      const result = await tool.handler({
        workerId: 'qa-1',
        type: 'gotcha',
        content: 'Explicit memory should still persist when auto-save is disabled.',
        taskId: 'task-1',
      }, state) as { wasDuplicate: boolean };

      expect(result.wasDuplicate).toBe(false);
      expect(state.getMemoryManager().getEntryCount()).toBe(1);
    });

    it('increments reopenCount on multiple rejections', async () => {
      await state.updateTask('task-1', { reopenCount: 2 });

      const tool = qaRejectTool(state);
      const result = await tool.handler({
        taskId: 'task-1',
        reason: 'Still failing',
      }, state) as { reopenCount: number };

      expect(result.reopenCount).toBe(3);
    });

    it('throws for missing taskId', async () => {
      const tool = qaRejectTool(state);
      await expect(
        tool.handler({ reason: 'test' }, state)
      ).rejects.toThrow('Missing required field: taskId');
    });

    it('throws for missing reason', async () => {
      const tool = qaRejectTool(state);
      await expect(
        tool.handler({ taskId: 'task-1' }, state)
      ).rejects.toThrow('Missing required field: reason');
    });

    it('throws for empty reason', async () => {
      const tool = qaRejectTool(state);
      await expect(
        tool.handler({ taskId: 'task-1', reason: '  ' }, state)
      ).rejects.toThrow('Missing required field: reason');
    });

    it('throws for non-REVIEW status', async () => {
      await state.updateTask('task-1', { status: 'DONE' });
      const tool = qaRejectTool(state);
      await expect(
        tool.handler({ taskId: 'task-1', reason: 'test' }, state)
      ).rejects.toThrow('expected REVIEW');
    });

    it('stores failedDodItems on rejection', async () => {
      const tool = qaRejectTool(state);
      const result = await tool.handler({
        taskId: 'task-1',
        reason: 'DoD items failed',
        failedDodItems: ['Tests pass', 'Code reviewed'],
      }, state) as { success: boolean; rejectionDetails: { failedDodItems: string[] } };

      expect(result.success).toBe(true);
      expect(result.rejectionDetails.failedDodItems).toEqual(['Tests pass', 'Code reviewed']);

      const task = state.getTask('task-1');
      expect(task?.rejectionDetails?.failedDodItems).toEqual(['Tests pass', 'Code reviewed']);
    });

    it('stores structured issues on rejection', async () => {
      // Reset task to REVIEW for this test
      await state.updateTask('task-1', { status: 'REVIEW' });

      const tool = qaRejectTool(state);
      const result = await tool.handler({
        taskId: 'task-1',
        reason: 'Multiple issues found',
        issues: [
          { type: 'test_failure', description: 'UserService test fails', file: 'src/UserService.test.ts', line: 42 },
          { type: 'security', description: 'Missing input validation' },
        ],
      }, state) as { rejectionDetails: { issues: Array<{ type: string; file?: string }> } };

      expect(result.rejectionDetails.issues).toHaveLength(2);
      expect(result.rejectionDetails.issues[0].type).toBe('test_failure');
      expect(result.rejectionDetails.issues[0].file).toBe('src/UserService.test.ts');

      const task = state.getTask('task-1');
      expect(task?.rejectionDetails?.issues).toHaveLength(2);
    });

    it('works with reason only (backward compat)', async () => {
      await state.updateTask('task-1', { status: 'REVIEW' });

      const tool = qaRejectTool(state);
      const result = await tool.handler({
        taskId: 'task-1',
        reason: 'Simple rejection',
      }, state) as { success: boolean; rejectionDetails: null };

      expect(result.success).toBe(true);
      expect(result.rejectionDetails).toBeNull();
    });

    it('clears stale rejectionDetails after structured details are followed by reason-only rejection', async () => {
      const rejectTool = qaRejectTool(state);

      await rejectTool.handler({
        taskId: 'task-1',
        reason: 'Initial structured rejection',
        failedDodItems: ['Tests pass'],
        issues: [{ type: 'test_failure', description: 'Old failure details', file: 'old.test.ts' }],
      }, state);
      expect(state.getTask('task-1')?.rejectionDetails).toEqual({
        failedDodItems: ['Tests pass'],
        issues: [{ type: 'test_failure', description: 'Old failure details', file: 'old.test.ts' }],
      });

      await state.updateTask('task-1', { status: 'REVIEW' });
      await rejectTool.handler({
        taskId: 'task-1',
        reason: 'Replacement structured rejection',
        failedDodItems: ['New DoD item only'],
      }, state);
      expect(state.getTask('task-1')?.rejectionDetails).toEqual({
        failedDodItems: ['New DoD item only'],
      });

      await state.updateTask('task-1', { status: 'REVIEW' });
      const reasonOnlyResult = await rejectTool.handler({
        taskId: 'task-1',
        reason: 'Reason-only rejection',
      }, state) as { rejectionDetails: null };
      expect(reasonOnlyResult.rejectionDetails).toBeNull();
      expect(state.getTask('task-1')?.rejectionDetails).toBeNull();

      const context = await getContextTool(state).handler({ taskId: 'task-1' }, state) as {
        task: { rejectionDetails: null };
      };
      expect(context.task.rejectionDetails).toBeNull();

      const claim = await claimNextTaskTool(state).handler({
        statuses: ['WORKING'],
        workerId: 'worker-after-reason-only',
      }, state) as { hasNext: boolean; task: { id: string; rejectionDetails: null } };
      expect(claim.hasNext).toBe(true);
      expect(claim.task.id).toBe('task-1');
      expect(claim.task.rejectionDetails).toBeNull();
    });

    it('throws for invalid issue type', async () => {
      await state.updateTask('task-1', { status: 'REVIEW' });

      const tool = qaRejectTool(state);
      await expect(
        tool.handler({
          taskId: 'task-1',
          reason: 'Bad issue type',
          issues: [{ type: 'invalid_type', description: 'test' }],
        }, state)
      ).rejects.toThrow('invalid type');
    });

    it('get_context returns rejectionDetails to worker', async () => {
      // Reject with structured feedback
      const rejectTool = qaRejectTool(state);
      await rejectTool.handler({
        taskId: 'task-1',
        reason: 'Tests fail',
        failedDodItems: ['Tests pass'],
        issues: [{ type: 'test_failure', description: 'Failing test in foo.test.ts' }],
      }, state);

      // Now check get_context as worker
      const ctxTool = getContextTool(state);
      const result = await ctxTool.handler({ taskId: 'task-1' }, state) as {
        task: {
          reopenReason: string;
          rejectionDetails: { failedDodItems: string[]; issues: Array<{ type: string }> };
        };
      };

      expect(result.task.reopenReason).toBe('Tests fail');
      expect(result.task.rejectionDetails.failedDodItems).toEqual(['Tests pass']);
      expect(result.task.rejectionDetails.issues).toHaveLength(1);
      expect(result.task.rejectionDetails.issues[0].type).toBe('test_failure');
    });
  });

  describe('moe.get_activity_log', () => {
    beforeEach(async () => {
      setupMoeFolder();
      createEpic();
      await state.load();
    });

    it('returns empty array when no activity log exists', async () => {
      const tool = getActivityLogTool(state);
      const result = await tool.handler({}, state) as { events: unknown[]; count: number };

      expect(result.events).toEqual([]);
      expect(result.count).toBe(0);
    });

    it('returns events after task operations', async () => {
      // Creating a task generates activity log entries
      createTask({ id: 'task-log-1', status: 'BACKLOG' });
      await state.load();
      await state.updateTask('task-log-1', { status: 'PLANNING' });

      // Flush pending writes
      await state.flushActivityLog();

      const tool = getActivityLogTool(state);
      const result = await tool.handler({}, state) as { events: Array<{ event: string }>; count: number };

      expect(result.count).toBeGreaterThan(0);
      expect(result.events.length).toBeGreaterThan(0);
    });

    it('returns epic lifecycle events newest-first when filtered by epicId', async () => {
      const epic = await state.createEpic({ title: 'Logged Epic', status: 'ACTIVE', order: 5 });
      await state.updateEpic(epic.id, { title: 'Logged Epic Updated', order: 6 });
      await state.flushActivityLog();

      const tool = getActivityLogTool(state);
      const result = await tool.handler({
        epicId: epic.id,
        eventTypes: ['EPIC_CREATED', 'EPIC_UPDATED'],
        limit: 10,
        maxPayloadChars: 0,
      }, state) as {
        events: Array<{ event: string; epicId?: string; payload: Record<string, unknown> }>;
      };

      expect(result.events.map((event) => event.event)).toEqual(['EPIC_UPDATED', 'EPIC_CREATED']);
      expect(result.events.every((event) => event.epicId === epic.id)).toBe(true);
      expect(result.events[0].payload.title).toBe('Logged Epic Updated');
      expect(result.events[1].payload.status).toBe('ACTIVE');
    });

    it('filters by taskId', async () => {
      createTask({ id: 'task-a', status: 'BACKLOG' });
      createTask({ id: 'task-b', status: 'BACKLOG' });
      await state.load();
      await state.updateTask('task-a', { status: 'PLANNING' });
      await state.updateTask('task-b', { status: 'PLANNING' });
      await state.flushActivityLog();

      const tool = getActivityLogTool(state);
      const result = await tool.handler({ taskId: 'task-a' }, state) as {
        events: Array<{ taskId?: string }>;
      };

      for (const event of result.events) {
        expect(event.taskId).toBe('task-a');
      }
    });

    it('filters by eventTypes', async () => {
      createTask({ id: 'task-evt', status: 'PLANNING' });
      await state.load();
      // Submit a plan to create PLAN_SUBMITTED event
      const submitTool = submitPlanTool(state);
      await submitTool.handler({
        taskId: 'task-evt',
        steps: [{ description: 'Test step' }],
      }, state);
      await state.flushActivityLog();

      const tool = getActivityLogTool(state);
      const result = await tool.handler({ eventTypes: ['PLAN_SUBMITTED'] }, state) as {
        events: Array<{ event: string }>;
      };

      for (const event of result.events) {
        expect(event.event).toBe('PLAN_SUBMITTED');
      }
    });

    it('respects limit parameter', async () => {
      // Create multiple tasks to generate activity
      createTask({ id: 'task-l1', status: 'BACKLOG' });
      createTask({ id: 'task-l2', status: 'BACKLOG' });
      createTask({ id: 'task-l3', status: 'BACKLOG' });
      await state.load();
      await state.flushActivityLog();

      const tool = getActivityLogTool(state);
      const result = await tool.handler({ limit: 2 }, state) as { events: unknown[]; count: number };

      expect(result.events.length).toBeLessThanOrEqual(2);
      expect(result.count).toBeLessThanOrEqual(2);
    });

    it('rejects invalid activity log numeric parameters', async () => {
      const tool = getActivityLogTool(state);

      await expect(tool.handler({ limit: Number.POSITIVE_INFINITY }, state)).rejects.toThrow('Invalid limit');
      await expect(tool.handler({ offset: -1 }, state)).rejects.toThrow('Invalid offset');
      await expect(tool.handler({ maxPayloadChars: Number.NaN }, state)).rejects.toThrow('Invalid maxPayloadChars');
    });

    it('caps default limit at 10 when none specified', async () => {
      // Create 15 status transitions to exceed the new default
      for (let i = 1; i <= 15; i++) {
        createTask({ id: `task-d${i}`, status: 'BACKLOG' });
      }
      await state.load();
      for (let i = 1; i <= 15; i++) {
        await state.updateTask(`task-d${i}`, { status: 'PLANNING' });
      }
      await state.flushActivityLog();

      const tool = getActivityLogTool(state);
      const result = await tool.handler({}, state) as { events: unknown[]; count: number };

      expect(result.events.length).toBeLessThanOrEqual(10);
      expect(result.count).toBeLessThanOrEqual(10);
    });

    it('throws if project not loaded', async () => {
      const freshState = new StateManager({ projectPath: testDir });
      const tool = getActivityLogTool(freshState);
      await expect(tool.handler({}, freshState)).rejects.toThrow('not loaded state, expected loaded');
    });
  });

  describe('moe.unblock_worker', () => {
    beforeEach(async () => {
      setupMoeFolder();
      createEpic();
      createTask({ id: 'task-1', assignedWorkerId: 'worker-1', status: 'WORKING' });
      createWorker({
        id: 'worker-1',
        status: 'BLOCKED',
        currentTaskId: 'task-1',
        lastError: 'Need clarification',
      });
      await state.load();
    });

    it('clears BLOCKED status to IDLE', async () => {
      const tool = unblockWorkerTool(state);
      const result = await tool.handler({
        workerId: 'worker-1',
        resolution: 'Clarification provided',
      }, state) as { success: boolean; status: string; currentTaskId: string | null };

      expect(result.success).toBe(true);
      expect(result.status).toBe('IDLE');
      expect(result.currentTaskId).toBeNull();

      const worker = state.getWorker('worker-1');
      expect(worker?.status).toBe('IDLE');
      expect(worker?.lastError).toBeNull();
      expect(worker?.currentTaskId).toBeNull();
    });

    it('keeps currentTaskId when retryTask is true', async () => {
      const tool = unblockWorkerTool(state);
      const result = await tool.handler({
        workerId: 'worker-1',
        resolution: 'Issue resolved, retrying',
        retryTask: true,
      }, state) as { success: boolean; status: string; currentTaskId: string | null; retryTask: boolean };

      expect(result.success).toBe(true);
      expect(result.status).toBe('IDLE');
      expect(result.currentTaskId).toBe('task-1');
      expect(result.retryTask).toBe(true);

      const worker = state.getWorker('worker-1');
      expect(worker?.currentTaskId).toBe('task-1');
    });

    it('fails if worker is not BLOCKED', async () => {
      // Create an IDLE worker
      createWorker({ id: 'worker-idle', status: 'IDLE' });
      await state.load();

      const tool = unblockWorkerTool(state);
      await expect(
        tool.handler({ workerId: 'worker-idle', resolution: 'test' }, state)
      ).rejects.toThrow('BLOCKED');
    });

    it('fails if worker does not exist', async () => {
      const tool = unblockWorkerTool(state);
      await expect(
        tool.handler({ workerId: 'nonexistent', resolution: 'test' }, state)
      ).rejects.toThrow('not found');
    });

    it('logs WORKER_UNBLOCKED to activity', async () => {
      const tool = unblockWorkerTool(state);
      await tool.handler({
        workerId: 'worker-1',
        resolution: 'Fixed the issue',
      }, state);
      await state.flushActivityLog();

      const logTool = getActivityLogTool(state);
      const result = await logTool.handler({
        eventTypes: ['WORKER_UNBLOCKED'],
      }, state) as { events: Array<{ event: string; workerId?: string }> };

      expect(result.events.length).toBeGreaterThanOrEqual(1);
      const unblockEvent = result.events.find(e => e.event === 'WORKER_UNBLOCKED');
      expect(unblockEvent).toBeDefined();
    });
  });

  describe('WIP limits', () => {
    beforeEach(async () => {
      setupMoeFolder({
        settings: {
          approvalMode: 'CONTROL',
          speedModeDelayMs: 2000,
          autoCreateBranch: true,
          branchPattern: 'moe/{epicId}/{taskId}',
          commitPattern: 'feat({epicId}): {taskTitle}',
          agentCommand: 'claude',
          columnLimits: { REVIEW: 1 }
        }
      } as Partial<Project>);
      createEpic();
      createTask({ id: 'task-1', status: 'WORKING' });
      await state.load();
    });

    it('blocks transition when WIP limit reached', async () => {
      // Move task-1 to REVIEW first (occupying the 1 slot)
      await state.updateTask('task-1', { status: 'REVIEW' });

      // Create a second task in WORKING
      createTask({ id: 'task-2', status: 'WORKING', order: 2 });
      await state.load();

      const tool = setTaskStatusTool(state);
      await expect(
        tool.handler({ taskId: 'task-2', status: 'REVIEW' }, state)
      ).rejects.toThrow('WIP limit of 1');
    });

    it('allows transition when under WIP limit', async () => {
      // task-1 is in WORKING, REVIEW column is empty
      const tool = setTaskStatusTool(state);
      const result = await tool.handler({
        taskId: 'task-1',
        status: 'REVIEW',
      }, state) as { success: boolean };

      expect(result.success).toBe(true);
    });
  });

  describe('ARCHIVED status', () => {
    beforeEach(async () => {
      setupMoeFolder();
      createEpic();
      createTask({ id: 'task-1', status: 'DONE' });
      await state.load();
    });

    it('allows DONE to ARCHIVED transition', async () => {
      const tool = setTaskStatusTool(state);
      const result = await tool.handler({
        taskId: 'task-1',
        status: 'ARCHIVED',
      }, state) as { success: boolean; status: string };
      expect(result.success).toBe(true);
      expect(result.status).toBe('ARCHIVED');
    });

    it('allows ARCHIVED to BACKLOG transition (un-archive)', async () => {
      await state.updateTask('task-1', { status: 'ARCHIVED' });
      const tool = setTaskStatusTool(state);
      const result = await tool.handler({
        taskId: 'task-1',
        status: 'BACKLOG',
      }, state) as { success: boolean; status: string };
      expect(result.success).toBe(true);
      expect(result.status).toBe('BACKLOG');
    });

    it('rejects BACKLOG to ARCHIVED transition', async () => {
      createTask({ id: 'task-bl', status: 'BACKLOG' });
      await state.load();
      const tool = setTaskStatusTool(state);
      await expect(tool.handler({
        taskId: 'task-bl',
        status: 'ARCHIVED',
      }, state)).rejects.toThrow();
    });

    it('listTasks includes archived count', async () => {
      await state.updateTask('task-1', { status: 'ARCHIVED' });
      const tool = listTasksTool(state);
      const result = await tool.handler({}, state) as { counts: { archived: number } };
      expect(result.counts.archived).toBe(1);
    });

    it('searchTasks can filter by ARCHIVED status', async () => {
      await state.updateTask('task-1', { status: 'ARCHIVED' });
      const tool = searchTasksTool(state);
      const result = await tool.handler({
        filters: { status: 'ARCHIVED' },
      }, state) as { tasks: Task[] };
      expect(result.tasks.length).toBe(1);
      expect(result.tasks[0].id).toBe('task-1');
    });
  });

  describe('Task comments', () => {
    const makeComments = (count: number) =>
      Array.from({ length: count }, (_, i) => ({
        id: `comment-${i}`,
        author: i % 2 === 0 ? 'human' : 'worker-1',
        content: `Comment ${i}`,
        timestamp: new Date(Date.now() + i).toISOString(),
      }));

    beforeEach(async () => {
      setupMoeFolder();
      createEpic();
      createTask({ id: 'task-1', status: 'WORKING' });
      await state.load();
    });

    it('adds a comment to a task', async () => {
      const tool = addCommentTool(state);
      const result = await tool.handler({
        taskId: 'task-1',
        content: 'What does this feature do?',
      }, state) as { success: boolean; commentId: string; totalComments: number };
      expect(result.success).toBe(true);
      expect(result.totalComments).toBe(1);
      const task = state.getTask('task-1');
      expect(task?.comments.length).toBe(1);
      expect(task?.comments[0].content).toBe('What does this feature do?');
      expect(task?.comments[0].author).toBe('agent');
    });

    it('uses workerId as author when provided', async () => {
      const tool = addCommentTool(state);
      await tool.handler({
        taskId: 'task-1',
        content: 'Response here',
        workerId: 'worker-123',
      }, state);
      const task = state.getTask('task-1');
      expect(task?.comments[0].author).toBe('worker-123');
    });

    it('preserves all comments when under limit', async () => {
      await state.updateTask('task-1', { comments: makeComments(MAX_COMMENTS_PER_TASK - 1) });
      const tool = addCommentTool(state);
      const result = await tool.handler({
        taskId: 'task-1',
        content: 'Newest under limit',
      }, state) as { totalComments: number };

      expect(result.totalComments).toBe(MAX_COMMENTS_PER_TASK);
      const task = state.getTask('task-1');
      expect(task?.comments.length).toBe(MAX_COMMENTS_PER_TASK);
      expect(task?.comments[0].content).toBe('Comment 0');
      expect(task?.comments.at(-1)?.content).toBe('Newest under limit');
    });

    it('trims oldest comment when adding at limit', async () => {
      await state.updateTask('task-1', { comments: makeComments(MAX_COMMENTS_PER_TASK) });
      const tool = addCommentTool(state);
      const result = await tool.handler({
        taskId: 'task-1',
        content: 'Newest at limit',
      }, state) as { totalComments: number };

      expect(result.totalComments).toBe(MAX_COMMENTS_PER_TASK);
      const task = state.getTask('task-1');
      expect(task?.comments.length).toBe(MAX_COMMENTS_PER_TASK);
      expect(task?.comments.some((c) => c.content === 'Comment 0')).toBe(false);
      expect(task?.comments[0].content).toBe('Comment 1');
      expect(task?.comments.at(-1)?.content).toBe('Newest at limit');
    });

    it('trims task with 300 existing comments down to max preserving newest', async () => {
      const task = state.getTask('task-1');
      expect(task).toBeTruthy();
      state.tasks.set('task-1', {
        ...task!,
        comments: makeComments(300),
      });

      const tool = addCommentTool(state);
      const result = await tool.handler({
        taskId: 'task-1',
        content: 'Newest with 300 existing',
      }, state) as { totalComments: number };

      expect(result.totalComments).toBe(MAX_COMMENTS_PER_TASK);
      const updatedTask = state.getTask('task-1');
      expect(updatedTask?.comments.length).toBe(MAX_COMMENTS_PER_TASK);
      expect(updatedTask?.comments[0].content).toBe('Comment 101');
      expect(updatedTask?.comments.at(-1)?.content).toBe('Newest with 300 existing');
    });

    it('handles null/undefined comments array gracefully', async () => {
      const existing = state.getTask('task-1');
      expect(existing).toBeTruthy();
      state.tasks.set('task-1', {
        ...existing!,
        comments: null as unknown as Task['comments'],
      });

      const tool = addCommentTool(state);
      const result = await tool.handler({
        taskId: 'task-1',
        content: 'Comment on null comments',
      }, state) as { totalComments: number };

      expect(result.totalComments).toBe(1);
      const task = state.getTask('task-1');
      expect(task?.comments.length).toBe(1);
      expect(task?.comments[0].content).toBe('Comment on null comments');
    });

    it('always preserves newest comments including newly added one', async () => {
      const baseline = makeComments(MAX_COMMENTS_PER_TASK + 25);
      const existing = state.getTask('task-1');
      expect(existing).toBeTruthy();
      state.tasks.set('task-1', {
        ...existing!,
        comments: baseline,
      });

      const tool = addCommentTool(state);
      await tool.handler({
        taskId: 'task-1',
        content: 'Newest preserved',
      }, state);

      const task = state.getTask('task-1');
      expect(task?.comments.length).toBe(MAX_COMMENTS_PER_TASK);
      expect(task?.comments.some((c) => c.content === 'Comment 0')).toBe(false);
      expect(task?.comments.some((c) => c.content === `Comment ${baseline.length - 1}`)).toBe(true);
      expect(task?.comments.at(-1)?.content).toBe('Newest preserved');
    });

    it('rejects empty content', async () => {
      const tool = addCommentTool(state);
      await expect(tool.handler({
        taskId: 'task-1',
        content: '  ',
      }, state)).rejects.toThrow();
    });

    it('rejects missing taskId', async () => {
      const tool = addCommentTool(state);
      await expect(tool.handler({
        content: 'test',
      }, state)).rejects.toThrow();
    });
  });

  describe('Task timestamps', () => {
    beforeEach(async () => {
      setupMoeFolder();
      createEpic();
      await state.load();
    });

    it('submitPlan sets planSubmittedAt', async () => {
      createTask({ status: 'PLANNING' });
      await state.load();

      const tool = submitPlanTool(state);
      await tool.handler({
        taskId: 'task-1',
        steps: [{ description: 'Step 1' }],
      }, state);

      const task = state.getTask('task-1');
      expect(task?.planSubmittedAt).toBeDefined();
      expect(new Date(task!.planSubmittedAt!).getTime()).not.toBeNaN();
    });

    it('manual approval sets planApprovedAt', async () => {
      createTask({ status: 'AWAITING_APPROVAL', implementationPlan: [
        { stepId: 'step-1', description: 'Step', status: 'PENDING', affectedFiles: [] }
      ]});
      await state.load();

      await state.approveTask('task-1');

      const task = state.getTask('task-1');
      expect(task?.planApprovedAt).toBeDefined();
      expect(task?.status).toBe('WORKING');
    });

    it('first startStep sets workStartedAt but second does not overwrite', async () => {
      createTask({
        status: 'WORKING',
        implementationPlan: [
          { stepId: 'step-1', description: 'First', status: 'PENDING', affectedFiles: [] },
          { stepId: 'step-2', description: 'Second', status: 'PENDING', affectedFiles: [] },
        ],
      });
      await state.load();

      const tool = startStepTool(state);
      await tool.handler({ taskId: 'task-1', stepId: 'step-1' }, state);

      const taskAfterFirst = state.getTask('task-1');
      const firstTimestamp = taskAfterFirst?.workStartedAt;
      expect(firstTimestamp).toBeDefined();

      // Complete first step so second can start
      const completeTool = completeStepTool(state);
      await completeTool.handler({ taskId: 'task-1', stepId: 'step-1' }, state);

      // Start second step
      await tool.handler({ taskId: 'task-1', stepId: 'step-2' }, state);

      const taskAfterSecond = state.getTask('task-1');
      expect(taskAfterSecond?.workStartedAt).toBe(firstTimestamp);
    });

    it('completeTask sets completedAt and reviewStartedAt', async () => {
      createTask({
        status: 'WORKING',
        implementationPlan: [
          { stepId: 'step-1', description: 'Done', status: 'COMPLETED', affectedFiles: [] },
        ],
      });
      await state.load();

      const tool = completeTaskTool(state);
      await tool.handler({ taskId: 'task-1' }, state);

      const task = state.getTask('task-1');
      expect(task?.completedAt).toBeDefined();
      expect(task?.reviewStartedAt).toBeDefined();
      expect(task?.status).toBe('REVIEW');
    });

    it('qaApprove sets reviewCompletedAt', async () => {
      createTask({ status: 'REVIEW' });
      await state.load();

      const tool = qaApproveTool(state);
      await tool.handler({ taskId: 'task-1' }, state);

      const task = state.getTask('task-1');
      expect(task?.reviewCompletedAt).toBeDefined();
      expect(task?.status).toBe('DONE');
    });

    it('qaReject sets reviewCompletedAt', async () => {
      createTask({ status: 'REVIEW' });
      await state.load();

      const tool = qaRejectTool(state);
      await tool.handler({ taskId: 'task-1', reason: 'Needs work' }, state);

      const task = state.getTask('task-1');
      expect(task?.reviewCompletedAt).toBeDefined();
      expect(task?.status).toBe('WORKING');
    });

    it('getContext exposes timestamps', async () => {
      const now = new Date().toISOString();
      createTask({
        status: 'WORKING',
        planSubmittedAt: now,
        planApprovedAt: now,
        workStartedAt: now,
      } as Partial<Task>);
      await state.load();

      const tool = getContextTool(state);
      const result = await tool.handler({ taskId: 'task-1' }, state) as {
        task: {
          planSubmittedAt: string | null;
          planApprovedAt: string | null;
          workStartedAt: string | null;
          completedAt: string | null;
          reviewStartedAt: string | null;
          reviewCompletedAt: string | null;
        };
      };

      expect(result.task.planSubmittedAt).toBe(now);
      expect(result.task.planApprovedAt).toBe(now);
      expect(result.task.workStartedAt).toBe(now);
      expect(result.task.completedAt).toBeNull();
      expect(result.task.reviewStartedAt).toBeNull();
      expect(result.task.reviewCompletedAt).toBeNull();
    });
  });

  describe('moe.get_pending_questions', () => {
    it('returns empty when no tasks have pending questions', async () => {
      setupMoeFolder();
      createEpic();
      createTask({ id: 'task-1', comments: [] });
      await state.load();

      const tool = getPendingQuestionsTool(state);
      const result = await tool.handler({}, state) as { count: number; tasks: unknown[] };
      expect(result.count).toBe(0);
      expect(result.tasks).toHaveLength(0);
    });

    it('returns task after human comment sets hasPendingQuestion', async () => {
      setupMoeFolder();
      createEpic();
      createTask({
        id: 'task-1',
        hasPendingQuestion: true,
        comments: [
          { id: 'c1', author: 'human', content: 'How should I test this?', timestamp: new Date().toISOString() }
        ]
      });
      await state.load();

      const tool = getPendingQuestionsTool(state);
      const result = await tool.handler({}, state) as {
        count: number;
        tasks: Array<{ taskId: string; questions: Array<{ content: string }> }>;
      };
      expect(result.count).toBe(1);
      expect(result.tasks[0].taskId).toBe('task-1');
      expect(result.tasks[0].questions).toHaveLength(1);
      expect(result.tasks[0].questions[0].content).toBe('How should I test this?');
    });

    it('returns multiple unanswered questions on same task', async () => {
      setupMoeFolder();
      createEpic();
      createTask({
        id: 'task-1',
        hasPendingQuestion: true,
        comments: [
          { id: 'c1', author: 'human', content: 'Question 1?', timestamp: new Date().toISOString() },
          { id: 'c2', author: 'human', content: 'Question 2?', timestamp: new Date().toISOString() }
        ]
      });
      await state.load();

      const tool = getPendingQuestionsTool(state);
      const result = await tool.handler({}, state) as {
        count: number;
        tasks: Array<{ questions: Array<{ content: string }> }>;
      };
      expect(result.count).toBe(1);
      expect(result.tasks[0].questions).toHaveLength(2);
    });

    it('only returns questions after last agent response', async () => {
      setupMoeFolder();
      createEpic();
      createTask({
        id: 'task-1',
        hasPendingQuestion: true,
        comments: [
          { id: 'c1', author: 'human', content: 'Old question', timestamp: '2024-01-01T00:00:00Z' },
          { id: 'c2', author: 'worker-1', content: 'Answer to old question', timestamp: '2024-01-01T00:01:00Z' },
          { id: 'c3', author: 'human', content: 'New question?', timestamp: '2024-01-01T00:02:00Z' }
        ]
      });
      await state.load();

      const tool = getPendingQuestionsTool(state);
      const result = await tool.handler({}, state) as {
        count: number;
        tasks: Array<{ questions: Array<{ content: string }> }>;
      };
      expect(result.count).toBe(1);
      expect(result.tasks[0].questions).toHaveLength(1);
      expect(result.tasks[0].questions[0].content).toBe('New question?');
    });

    it('add_comment clears the hasPendingQuestion flag', async () => {
      setupMoeFolder();
      createEpic();
      createTask({
        id: 'task-1',
        hasPendingQuestion: true,
        comments: [
          { id: 'c1', author: 'human', content: 'A question?', timestamp: new Date().toISOString() }
        ]
      });
      await state.load();

      const commentTool = addCommentTool(state);
      await commentTool.handler({ taskId: 'task-1', content: 'Q: A question?\nA: Here is the answer.', workerId: 'worker-1' }, state);

      const task = state.getTask('task-1')!;
      expect(task.hasPendingQuestion).toBe(false);
    });

    it('filters by epicId', async () => {
      setupMoeFolder();
      createEpic({ id: 'epic-1' });
      createEpic({ id: 'epic-2', title: 'Other Epic' });
      createTask({
        id: 'task-1',
        epicId: 'epic-1',
        hasPendingQuestion: true,
        comments: [{ id: 'c1', author: 'human', content: 'Q1?', timestamp: new Date().toISOString() }]
      });
      createTask({
        id: 'task-2',
        epicId: 'epic-2',
        hasPendingQuestion: true,
        comments: [{ id: 'c2', author: 'human', content: 'Q2?', timestamp: new Date().toISOString() }]
      });
      await state.load();

      const tool = getPendingQuestionsTool(state);
      const result = await tool.handler({ epicId: 'epic-1' }, state) as {
        count: number;
        tasks: Array<{ taskId: string }>;
      };
      expect(result.count).toBe(1);
      expect(result.tasks[0].taskId).toBe('task-1');
    });

    it('limits and truncates pending-question payloads by default with full-content opt-in', async () => {
      setupMoeFolder();
      createEpic({ id: 'epic-1' });
      createTask({
        id: 'task-1',
        order: 1,
        hasPendingQuestion: true,
        comments: [
          { id: 'c1', author: 'human', content: 'A'.repeat(1200), timestamp: '2024-01-01T00:00:00Z' },
          { id: 'c2', author: 'human', content: 'B'.repeat(1200), timestamp: '2024-01-01T00:01:00Z' },
        ],
      });
      createTask({
        id: 'task-2',
        order: 2,
        hasPendingQuestion: true,
        comments: [
          { id: 'c3', author: 'human', content: 'C'.repeat(1200), timestamp: '2024-01-01T00:02:00Z' },
        ],
      });
      await state.load();

      const tool = getPendingQuestionsTool(state);
      const compact = await tool.handler({
        limit: 1,
        maxQuestionsPerTask: 1,
        maxContentChars: 100,
      }, state) as {
        count: number;
        totalMatches: number;
        tasks: Array<{
          taskId: string;
          questions: Array<{ content: string; contentTruncated?: boolean; contentOriginalLength?: number }>;
          totalQuestions: number;
          omittedQuestions: number;
        }>;
        pagination: { hasMore: boolean };
        truncatedQuestions: number;
        hint?: string;
      };

      expect(compact.count).toBe(1);
      expect(compact.totalMatches).toBe(2);
      expect(compact.tasks[0].taskId).toBe('task-1');
      expect(compact.tasks[0].questions).toHaveLength(1);
      expect(compact.tasks[0].questions[0].content.length).toBeLessThanOrEqual(100);
      expect(compact.tasks[0].questions[0].contentTruncated).toBe(true);
      expect(compact.tasks[0].questions[0].contentOriginalLength).toBe(1200);
      expect(compact.tasks[0].totalQuestions).toBe(2);
      expect(compact.tasks[0].omittedQuestions).toBe(1);
      expect(compact.pagination.hasMore).toBe(true);
      expect(compact.truncatedQuestions).toBe(1);
      expect(compact.hint).toContain('compact');

      const fullQuestion = await tool.handler({
        limit: 1,
        maxQuestionsPerTask: 1,
        maxContentChars: 0,
      }, state) as { tasks: Array<{ questions: Array<{ content: string; contentTruncated?: boolean }> }> };
      expect(fullQuestion.tasks[0].questions[0].content).toHaveLength(1200);
      expect(fullQuestion.tasks[0].questions[0].contentTruncated).toBeUndefined();
    });
  });

  describe('chat token budgets', () => {
    async function setupChat(): Promise<string> {
      setupMoeFolder();
      createWorker({ id: 'worker-chat' });
      await state.load();
      const general = state.getChannels().find((channel) => channel.name === 'general');
      expect(general).toBeDefined();
      return general!.id;
    }

    it('truncates chat_read message content by default and supports full content opt-in', async () => {
      const channel = await setupChat();
      const content = 'A'.repeat(1200);
      await state.sendMessage({ channel, sender: 'human', content });

      const tool = chatReadTool(state);
      const compact = await tool.handler({ channel }, state) as {
        messages: Array<{ content: string; contentTruncated?: boolean; contentOriginalLength?: number }>;
        truncated: number;
      };
      expect(compact.messages[0].content.length).toBeLessThanOrEqual(1000);
      expect(compact.messages[0].contentTruncated).toBe(true);
      expect(compact.messages[0].contentOriginalLength).toBe(1200);
      expect(compact.truncated).toBe(1);

      const full = await tool.handler({ channel, maxContentChars: 0 }, state) as {
        messages: Array<{ content: string; contentTruncated?: boolean }>;
        truncated: number;
      };
      expect(full.messages[0].content).toBe(content);
      expect(full.messages[0].contentTruncated).toBeUndefined();
      expect(full.truncated).toBe(0);
    });

    it('does not advance cursors or clear unread for all-channel messages omitted by the global limit', async () => {
      const general = await setupChat();
      const other = await state.createChannel({ name: 'handoff', type: 'custom' });
      const oldMessage = await state.sendMessage({
        channel: general,
        sender: 'human',
        content: '@worker-chat old general handoff',
      });
      await new Promise((resolve) => setTimeout(resolve, 2));
      const returnedMessage = await state.sendMessage({
        channel: other.id,
        sender: 'human',
        content: '@worker-chat newest handoff',
      });
      expect(state.getUnreadSummary('worker-chat')?.channels[general]).toBe(1);
      expect(state.getUnreadSummary('worker-chat')?.channels[other.id]).toBe(1);

      const tool = chatReadTool(state);
      const result = await tool.handler({ workerId: 'worker-chat', limit: 1 }, state) as {
        messages: Array<{ id: string; channel: string }>;
      };

      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].id).toBe(returnedMessage.message.id);
      expect(result.messages[0].channel).toBe(other.id);

      const worker = state.getWorker('worker-chat')!;
      expect(worker.chatCursors?.[other.id]).toBe(returnedMessage.message.id);
      expect(worker.chatCursors?.[general]).toBeUndefined();
      expect(worker.chatCursors?.[general]).not.toBe(oldMessage.message.id);

      const unread = state.getUnreadSummary('worker-chat');
      expect(unread?.channels[general]).toBe(1);
      expect(unread?.channels[other.id]).toBeUndefined();
      expect(unread?.total).toBe(1);

      const laterRead = await tool.handler({ workerId: 'worker-chat', limit: 1 }, state) as {
        messages: Array<{ id: string; channel: string }>;
      };
      expect(laterRead.messages).toHaveLength(1);
      expect(laterRead.messages[0].id).toBe(oldMessage.message.id);
      expect(laterRead.messages[0].channel).toBe(general);
      expect(state.getWorker('worker-chat')?.chatCursors?.[general]).toBe(oldMessage.message.id);
      expect(state.getUnreadSummary('worker-chat')).toBeNull();
    });

    it('does not advance a returned channel cursor past earlier fetched messages omitted by the global limit', async () => {
      const general = await setupChat();
      const other = await state.createChannel({ name: 'handoff', type: 'custom' });
      const oldGeneral = await state.sendMessage({
        channel: general,
        sender: 'human',
        content: '@worker-chat old general note',
      });
      await new Promise((resolve) => setTimeout(resolve, 2));
      const returnedGeneral = await state.sendMessage({
        channel: general,
        sender: 'human',
        content: '@worker-chat newer general note',
      });
      await new Promise((resolve) => setTimeout(resolve, 2));
      const returnedOther = await state.sendMessage({
        channel: other.id,
        sender: 'human',
        content: '@worker-chat newest other note',
      });

      const tool = chatReadTool(state);
      const result = await tool.handler({ workerId: 'worker-chat', limit: 2 }, state) as {
        messages: Array<{ id: string; channel: string }>;
      };

      expect(result.messages.map((message) => message.id)).toEqual([
        returnedGeneral.message.id,
        returnedOther.message.id,
      ]);
      expect(state.getWorker('worker-chat')?.chatCursors?.[other.id]).toBe(returnedOther.message.id);
      expect(state.getWorker('worker-chat')?.chatCursors?.[general]).toBeUndefined();
      expect(state.getUnreadSummary('worker-chat')?.channels[general]).toBe(2);
      expect(state.getUnreadSummary('worker-chat')?.channels[other.id]).toBeUndefined();

      const laterRead = await tool.handler({ workerId: 'worker-chat', limit: 2 }, state) as {
        messages: Array<{ id: string; channel: string }>;
      };
      expect(laterRead.messages.map((message) => message.id)).toEqual([
        oldGeneral.message.id,
        returnedGeneral.message.id,
      ]);
      expect(state.getWorker('worker-chat')?.chatCursors?.[general]).toBe(returnedGeneral.message.id);
      expect(state.getUnreadSummary('worker-chat')).toBeNull();
    });

    it('keeps chat_resync default payload smaller', async () => {
      const channel = await setupChat();
      for (let i = 0; i < 25; i++) {
        await state.sendMessage({ channel, sender: 'human', content: `${i}: ${'B'.repeat(1200)}` });
      }

      const tool = chatResyncTool(state);
      const result = await tool.handler({ workerId: 'worker-chat', channel }, state) as {
        messagesCount: number;
        messages: Array<{ content: string; contentTruncated?: boolean }>;
        truncated: number;
      };

      expect(result.messagesCount).toBe(20);
      expect(result.messages).toHaveLength(20);
      expect(result.messages[0].content.length).toBeLessThanOrEqual(1000);
      expect(result.messages[0].contentTruncated).toBe(true);
      expect(result.truncated).toBe(20);
    });

    it('truncates chat_wait wake messages by default', async () => {
      const channel = await setupChat();
      const tool = chatWaitTool(state);
      const waitPromise = tool.handler({
        workerId: 'worker-chat',
        channels: [channel],
        timeoutMs: 1000,
        maxContentChars: 25,
      }, state) as Promise<{
        hasMessage: boolean;
        messages: Array<{ content: string; contentTruncated?: boolean; contentOriginalLength?: number }>;
        truncated: number;
      }>;

      const content = 'Human unblock details '.repeat(20);
      await state.sendMessage({ channel, sender: 'human', content });
      const result = await waitPromise;

      expect(result.hasMessage).toBe(true);
      expect(result.messages[0].content.length).toBeLessThanOrEqual(25);
      expect(result.messages[0].contentTruncated).toBe(true);
      expect(result.messages[0].contentOriginalLength).toBe(content.length);
      expect(result.truncated).toBe(1);
    });
  });
});
