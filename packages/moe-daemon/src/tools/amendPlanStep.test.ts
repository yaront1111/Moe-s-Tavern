import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { StateManager } from '../state/StateManager.js';
import { amendPlanStepTool } from './amendPlanStep.js';
import { getTools } from './index.js';
import {
  MAX_AMENDMENTS_PER_STEP,
  activeAmendment,
  effectiveStepDescription,
  nextAmendmentId,
} from '../util/planAmendments.js';
import type { Epic, ImplementationStep, Project, Task, TaskStatus, TeamRole } from '../types/schema.js';

describe('moe.amend_plan_step', () => {
  let testDir: string;
  let moePath: string;
  let state: StateManager;

  function writePlan(): ImplementationStep[] {
    return [
      { stepId: 'step-1', description: 'Write the parser', status: 'PENDING', affectedFiles: ['src/parse.ts'] },
      { stepId: 'step-2', description: 'Wire the parser up', status: 'IN_PROGRESS', affectedFiles: [] },
      { stepId: 'step-3', description: 'Scaffold the module', status: 'COMPLETED', affectedFiles: [] },
    ];
  }

  function setupMoe(taskStatus: TaskStatus = 'WORKING'): void {
    fs.mkdirSync(moePath, { recursive: true });
    for (const sub of ['epics', 'tasks', 'workers', 'proposals', 'teams', 'channels', 'messages']) {
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

    const epic: Epic = {
      id: 'epic-1', projectId: 'proj-test', title: 'E', description: '', architectureNotes: '',
      epicRails: [], status: 'ACTIVE', order: 1,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(moePath, 'epics', 'epic-1.json'), JSON.stringify(epic, null, 2));

    const now = new Date().toISOString();
    const task: Task = {
      id: 'task-1', epicId: 'epic-1', title: 'Some task', description: '',
      definitionOfDone: [], taskRails: [], implementationPlan: writePlan(),
      status: taskStatus, assignedWorkerId: 'worker-1', branch: null, prLink: null,
      reopenCount: 0, reopenReason: null, createdBy: 'HUMAN', parentTaskId: null,
      priority: 'MEDIUM', order: 1, comments: [],
      createdAt: now, updatedAt: now,
    };
    fs.writeFileSync(path.join(moePath, 'tasks', task.id + '.json'), JSON.stringify(task, null, 2));
  }

  async function addWorker(workerId: string, role: TeamRole | null): Promise<void> {
    await state.createWorker({
      id: workerId, type: 'CLAUDE', projectId: 'proj-test', epicId: 'epic-1',
      currentTaskId: null, status: 'IDLE',
    });
    if (role) {
      let team = Array.from(state.teams.values()).find(t => t.role === role);
      if (!team) team = await state.createTeam({ name: `${role}s`, role });
      await state.addTeamMember(team.id, workerId);
    }
  }

  async function amend(args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const tool = amendPlanStepTool(state);
    return await tool.handler({
      taskId: 'task-1',
      stepId: 'step-1',
      description: 'AMENDED: write the parser with the new grammar',
      reason: 'the grammar changed upstream',
      workerId: 'architect-1',
      ...args,
    }, state) as Record<string, unknown>;
  }

  function step(stepId: string): ImplementationStep {
    return state.getTask('task-1')!.implementationPlan.find(s => s.stepId === stepId)!;
  }

  beforeEach(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moe-amend-step-'));
    moePath = path.join(testDir, '.moe');
    setupMoe();
    state = new StateManager({ projectPath: testDir });
    await state.load();
    await addWorker('architect-1', 'architect');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('is registered in getTools() — an unregistered tool is invisible over MCP', () => {
    expect(getTools(state).map(t => t.name)).toContain('moe.amend_plan_step');
  });

  it('appends the amendment and persists it through the plan sanitizer', async () => {
    const result = await amend();

    expect(result.success).toBe(true);
    expect(result.amendmentId).toBe('amend-1');
    expect(result.amendmentCount).toBe(1);
    expect(result.effectiveDescription).toBe('AMENDED: write the parser with the new grammar');
    expect(result.previousDescription).toBe('Write the parser');

    // Re-read through state.getTask: sanitizeImplementationPlan rebuilds every
    // step from an allowlist, so this is what proves the fields survive a write.
    const amended = step('step-1');
    expect(amended.amendments).toHaveLength(1);
    expect(amended.activeAmendmentId).toBe('amend-1');
    expect(amended.amendments![0]).toMatchObject({
      amendmentId: 'amend-1',
      description: 'AMENDED: write the parser with the new grammar',
      reason: 'the grammar changed upstream',
      amendedBy: 'architect-1',
    });
    expect(amended.amendments![0].amendedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // The original instructions are never rewritten — that is the audit trail.
    expect(amended.description).toBe('Write the parser');
    expect(amended.status).toBe('PENDING');
    // Sibling steps are untouched.
    expect(step('step-2').amendments).toBeUndefined();
  });

  it('lets a governor amend too', async () => {
    await addWorker('governor-1', 'governor');
    const result = await amend({ workerId: 'governor-1' });
    expect(result.amendmentId).toBe('amend-1');
    expect(step('step-1').amendments![0].amendedBy).toBe('governor-1');
  });

  it('rejects a worker-role caller and an anonymous caller', async () => {
    await addWorker('worker-1', 'worker');
    await expect(amend({ workerId: 'worker-1' })).rejects.toThrow(/NOT_ALLOWED|not allowed/i);
    await expect(amend({ workerId: undefined })).rejects.toThrow(/NOT_ALLOWED|not allowed/i);
    await expect(amend({ workerId: 'nobody-at-all' })).rejects.toThrow(/NOT_ALLOWED|not allowed/i);
    expect(step('step-1').amendments).toBeUndefined();
  });

  it('rejects amending a COMPLETED step and names moe.request_replan', async () => {
    await expect(amend({ stepId: 'step-3' })).rejects.toThrow(/moe\.request_replan/);
    expect(step('step-3').amendments).toBeUndefined();
  });

  it('amends an IN_PROGRESS step without touching its status', async () => {
    const result = await amend({ stepId: 'step-2' });
    expect(result.amendmentId).toBe('amend-1');
    expect(step('step-2').status).toBe('IN_PROGRESS');
  });

  it('keeps every amendment and moves activeAmendmentId to the newest', async () => {
    await amend();
    const second = await amend({ description: 'AMENDED AGAIN: use the other grammar', reason: 'reverted upstream' });

    expect(second.amendmentId).toBe('amend-2');
    expect(second.amendmentCount).toBe(2);
    expect(second.previousDescription).toBe('AMENDED: write the parser with the new grammar');

    const amended = step('step-1');
    expect(amended.amendments!.map(a => a.amendmentId)).toEqual(['amend-1', 'amend-2']);
    expect(amended.activeAmendmentId).toBe('amend-2');
    expect(effectiveStepDescription(amended)).toBe('AMENDED AGAIN: use the other grammar');
  });

  it('rejects the amendment past MAX_AMENDMENTS_PER_STEP and steers to request_replan', async () => {
    for (let i = 0; i < MAX_AMENDMENTS_PER_STEP; i++) {
      await amend({ description: `AMENDED ${i}: do the thing`, reason: `round ${i}` });
    }
    expect(step('step-1').amendments).toHaveLength(MAX_AMENDMENTS_PER_STEP);

    await expect(amend()).rejects.toThrow(/moe\.request_replan/);
    expect(step('step-1').amendments).toHaveLength(MAX_AMENDMENTS_PER_STEP);
  });

  it('rejects unknown taskId, unknown stepId, and a finished task', async () => {
    await expect(amend({ taskId: 'task-nope' })).rejects.toThrow(/not found|NOT_FOUND/i);
    await expect(amend({ stepId: 'step-nope' })).rejects.toThrow(/not found|NOT_FOUND/i);

    await state.updateTask('task-1', { status: 'DONE' });
    await expect(amend()).rejects.toThrow(/DONE/);
  });

  it('rejects missing, empty and oversized description/reason', async () => {
    await expect(amend({ description: undefined })).rejects.toThrow(/description/);
    await expect(amend({ reason: undefined })).rejects.toThrow(/reason/);
    await expect(amend({ description: '   ' })).rejects.toThrow(/description/);
    await expect(amend({ reason: '   ' })).rejects.toThrow(/reason/);
    await expect(amend({ description: 'x'.repeat(5001) })).rejects.toThrow(/too long/);
    await expect(amend({ reason: 'x'.repeat(2001) })).rejects.toThrow(/too long/);
    await expect(amend({ description: 42 })).rejects.toThrow(/must be a string/);
    expect(step('step-1').amendments).toBeUndefined();
  });

  it('still persists the amendment when chat posting rejects', async () => {
    vi.spyOn(state, 'postToGeneral').mockRejectedValue(new Error('chat down'));
    vi.spyOn(state, 'postToRoleChannel').mockRejectedValue(new Error('chat down'));

    const result = await amend();

    expect(result.success).toBe(true);
    expect(step('step-1').activeAmendmentId).toBe('amend-1');
  });

  it('mentions the assigned worker so its wait wakes', async () => {
    const posts: string[] = [];
    vi.spyOn(state, 'postToGeneral').mockImplementation(async (content: string) => { posts.push(content); });
    vi.spyOn(state, 'postToRoleChannel').mockResolvedValue(undefined);

    await amend();

    expect(posts[0]).toMatch(/^@worker-1 ✏️ step step-1 amended on task-1: the grammar changed upstream$/);
  });
});

describe('util/planAmendments', () => {
  const base = { description: 'original text' };

  it('returns the original description when there are no amendments', () => {
    expect(effectiveStepDescription(base)).toBe('original text');
    expect(activeAmendment(base)).toBeNull();
    expect(nextAmendmentId(base)).toBe('amend-1');
  });

  it('returns the active amendment description when one is in force', () => {
    const step = {
      ...base,
      amendments: [
        { amendmentId: 'amend-1', description: 'first', reason: 'r', amendedBy: 'a', amendedAt: 'now' },
        { amendmentId: 'amend-2', description: 'second', reason: 'r', amendedBy: 'a', amendedAt: 'now' },
      ],
      activeAmendmentId: 'amend-1',
    };
    expect(effectiveStepDescription(step)).toBe('first');
    expect(activeAmendment(step)?.amendmentId).toBe('amend-1');
    expect(nextAmendmentId(step)).toBe('amend-3');
  });

  it('degrades a dangling activeAmendmentId to the original instead of throwing', () => {
    const step = {
      ...base,
      amendments: [{ amendmentId: 'amend-1', description: 'first', reason: 'r', amendedBy: 'a', amendedAt: 'now' }],
      activeAmendmentId: 'amend-99',
    };
    expect(effectiveStepDescription(step)).toBe('original text');
    expect(activeAmendment(step)).toBeNull();
  });

  it('survives a hand-edited non-array amendments field', () => {
    const step = { ...base, amendments: 'nope' as unknown as [], activeAmendmentId: 'amend-1' };
    expect(effectiveStepDescription(step)).toBe('original text');
    expect(nextAmendmentId(step)).toBe('amend-1');
  });
});
