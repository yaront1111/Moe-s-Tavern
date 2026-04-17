import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { StateManager } from '../state/StateManager.js';
import { qaApproveTool } from './qaApprove.js';
import { qaRejectTool } from './qaReject.js';
import { MoeError, MoeErrorCode } from '../util/errors.js';
import type { Task, Epic, Project } from '../types/schema.js';

describe('qa_approve / qa_reject ownership enforcement', () => {
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
      createdAt: now, updatedAt: now,
      ...overrides,
    };
    fs.writeFileSync(path.join(moePath, 'tasks', 'task-1.json'), JSON.stringify(task, null, 2));
    return task;
  }

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moe-qa-own-'));
    moePath = path.join(testDir, '.moe');
    state = new StateManager({ projectPath: testDir });
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('qa_approve rejects when a different QA agent attempts to approve', async () => {
    setupMoe(); writeEpic(); writeTask();
    await state.load();
    const tool = qaApproveTool(state);
    try {
      await tool.handler({ taskId: 'task-1', workerId: 'qa-b' }, state);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(MoeError);
      expect((err as MoeError).code).toBe(MoeErrorCode.NOT_ALLOWED);
    }
  });

  it('qa_approve allows human-driven path (assignedWorkerId=null)', async () => {
    setupMoe(); writeEpic(); writeTask({ assignedWorkerId: null });
    await state.load();
    const tool = qaApproveTool(state);
    const result = await tool.handler({ taskId: 'task-1' }, state) as { status: string };
    expect(result.status).toBe('DONE');
  });

  it('qa_approve succeeds when workerId matches', async () => {
    setupMoe(); writeEpic(); writeTask();
    await state.load();
    const tool = qaApproveTool(state);
    const result = await tool.handler({ taskId: 'task-1', workerId: 'qa-a' }, state) as { status: string };
    expect(result.status).toBe('DONE');
  });

  it('qa_reject rejects when a different QA agent attempts to reject', async () => {
    setupMoe(); writeEpic(); writeTask();
    await state.load();
    const tool = qaRejectTool(state);
    try {
      await tool.handler({ taskId: 'task-1', reason: 'nope', workerId: 'qa-b' }, state);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(MoeError);
      expect((err as MoeError).code).toBe(MoeErrorCode.NOT_ALLOWED);
    }
  });

  it('qa_reject succeeds when workerId matches', async () => {
    setupMoe(); writeEpic(); writeTask();
    await state.load();
    const tool = qaRejectTool(state);
    const result = await tool.handler({ taskId: 'task-1', reason: 'needs fixes', workerId: 'qa-a' }, state) as { status: string };
    expect(result.status).toBe('WORKING');
  });

  it('qa_reject allows human-driven path (assignedWorkerId=null)', async () => {
    setupMoe(); writeEpic(); writeTask({ assignedWorkerId: null });
    await state.load();
    const tool = qaRejectTool(state);
    const result = await tool.handler({ taskId: 'task-1', reason: 'needs fixes' }, state) as { status: string };
    expect(result.status).toBe('WORKING');
  });
});
