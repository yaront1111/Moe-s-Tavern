import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { StateManager } from '../state/StateManager.js';
import { claimNextTaskTool } from './claimNextTask.js';
import { computeDiskStateSignature } from '../util/diskState.js';
import type { Project, Epic, Worker, Task, TeamRole, HandoffNote } from '../types/schema.js';

// Mocked so the flag logic is tested without a git binary; the real subprocess
// path lives in util/diskState.test.ts.
vi.mock('../util/diskState.js', () => ({ computeDiskStateSignature: vi.fn() }));
const mockedSignature = vi.mocked(computeDiskStateSignature);

describe('moe.claim_next_task — role-aware routing', () => {
  let testDir: string;
  let moePath: string;
  let state: StateManager;

  function setupMoe() {
    fs.mkdirSync(moePath, { recursive: true });
    for (const sub of ['epics', 'tasks', 'workers', 'proposals', 'channels', 'messages', 'teams']) {
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

  function writeWorker(id: string, overrides: Partial<Worker> = {}): Worker {
    const now = new Date().toISOString();
    const worker: Worker = {
      id, type: 'CLAUDE', projectId: 'proj-test', epicId: 'epic-1',
      currentTaskId: null, status: 'IDLE', branch: '', modifiedFiles: [],
      startedAt: now, lastActivityAt: now, lastError: null, errorCount: 0, teamId: null,
      ...overrides,
    };
    fs.writeFileSync(path.join(moePath, 'workers', id + '.json'), JSON.stringify(worker, null, 2));
    return worker;
  }

  async function bindWorkerToTeamRole(workerId: string, role: TeamRole): Promise<void> {
    const team = await state.createTeam({ name: `${role}s`, role });
    await state.addTeamMember(team.id, workerId);
  }

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moe-claim-'));
    moePath = path.join(testDir, '.moe');
    setupMoe();
    writeEpic();
    state = new StateManager({ projectPath: testDir });
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('routes a governor straight to enter_governance instead of returning tasks', async () => {
    writeWorker('governor-1');
    await state.load();
    await bindWorkerToTeamRole('governor-1', 'governor');

    const tool = claimNextTaskTool(state);
    const result = await tool.handler(
      { workerId: 'governor-1', statuses: ['PLANNING', 'WORKING', 'REVIEW'] },
      state
    ) as Record<string, unknown>;

    expect(result.hasNext).toBe(false);
    const next = result.nextAction as { tool: string; args: Record<string, unknown> };
    expect(next.tool).toBe('moe.enter_governance');
    expect(next.args.workerId).toBe('governor-1');
  });

  it('architect on empty PLANNING queue gets wait_for_task (no governance recommendation)', async () => {
    writeWorker('architect-1');
    await state.load();
    await bindWorkerToTeamRole('architect-1', 'architect');

    const tool = claimNextTaskTool(state);
    const result = await tool.handler(
      { workerId: 'architect-1', statuses: ['PLANNING'] },
      state
    ) as Record<string, unknown>;

    expect(result.hasNext).toBe(false);
    const next = result.nextAction as { tool: string; args: Record<string, unknown> };
    expect(next.tool).toBe('moe.wait_for_task');
    // Critical regression guard: architects must never get routed to enter_governance.
    expect(next.tool).not.toBe('moe.enter_governance');
  });

  it('worker on empty WORKING queue gets wait_for_task (unchanged)', async () => {
    writeWorker('worker-1');
    await state.load();
    await bindWorkerToTeamRole('worker-1', 'worker');

    const tool = claimNextTaskTool(state);
    const result = await tool.handler(
      { workerId: 'worker-1', statuses: ['WORKING'] },
      state
    ) as Record<string, unknown>;

    expect(result.hasNext).toBe(false);
    const next = result.nextAction as { tool: string };
    expect(next.tool).toBe('moe.wait_for_task');
  });
});

describe('moe.claim_next_task — one task per worker', () => {
  let testDir: string;
  let moePath: string;
  let state: StateManager;

  function setupMoe() {
    fs.mkdirSync(moePath, { recursive: true });
    for (const sub of ['epics', 'tasks', 'workers', 'proposals', 'channels', 'messages', 'teams']) {
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
    const epic: Epic = {
      id: 'epic-1', projectId: 'proj-test', title: 'E', description: '', architectureNotes: '',
      epicRails: [], status: 'ACTIVE', order: 1,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(moePath, 'epics', 'epic-1.json'), JSON.stringify(epic, null, 2));
  }

  function writeWorker(id: string, overrides: Partial<Worker> = {}): Worker {
    const now = new Date().toISOString();
    const worker: Worker = {
      id, type: 'CLAUDE', projectId: 'proj-test', epicId: 'epic-1',
      currentTaskId: null, status: 'CODING', branch: '', modifiedFiles: [],
      startedAt: now, lastActivityAt: now, lastError: null, errorCount: 0, teamId: null,
      ...overrides,
    };
    fs.writeFileSync(path.join(moePath, 'workers', id + '.json'), JSON.stringify(worker, null, 2));
    return worker;
  }

  function writeTask(id: string, overrides: Partial<Task> = {}): Task {
    const now = new Date().toISOString();
    const task: Task = {
      id, epicId: 'epic-1', title: `Task ${id}`, description: '',
      definitionOfDone: ['Done'], taskRails: [], implementationPlan: [],
      status: 'WORKING', assignedWorkerId: null, branch: null, prLink: null,
      reopenCount: 0, reopenReason: null, createdBy: 'HUMAN', parentTaskId: null,
      order: 1, createdAt: now, updatedAt: now,
      ...overrides,
    };
    fs.writeFileSync(path.join(moePath, 'tasks', id + '.json'), JSON.stringify(task, null, 2));
    return task;
  }

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moe-claim-one-'));
    moePath = path.join(testDir, '.moe');
    setupMoe();
    state = new StateManager({ projectPath: testDir });
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('blocks claiming a second task while holding an active one, pointing back to the held task', async () => {
    writeTask('task-held', { status: 'WORKING', assignedWorkerId: 'w-1' });
    writeTask('task-free', { status: 'WORKING', order: 2 });
    writeWorker('w-1', { currentTaskId: 'task-held' });
    await state.load();

    const tool = claimNextTaskTool(state);
    const result = await tool.handler({ workerId: 'w-1', statuses: ['WORKING'] }, state) as Record<string, unknown>;

    expect(result.hasNext).toBe(false);
    expect((result.alreadyAssigned as { taskId: string }).taskId).toBe('task-held');
    const next = result.nextAction as { tool: string; args: Record<string, unknown> };
    expect(next.tool).toBe('moe.get_context');
    expect(next.args.taskId).toBe('task-held');
    // The free task was NOT claimed.
    expect(state.getTask('task-free')!.assignedWorkerId).toBeNull();
  });

  it('blocks an explicit taskId claim of a DIFFERENT task while holding one', async () => {
    writeTask('task-held', { status: 'WORKING', assignedWorkerId: 'w-1' });
    writeTask('task-free', { status: 'WORKING', order: 2 });
    writeWorker('w-1', { currentTaskId: 'task-held' });
    await state.load();

    const tool = claimNextTaskTool(state);
    const result = await tool.handler(
      { workerId: 'w-1', statuses: ['WORKING'], taskId: 'task-free' },
      state
    ) as Record<string, unknown>;

    expect(result.hasNext).toBe(false);
    expect((result.alreadyAssigned as { taskId: string }).taskId).toBe('task-held');
    expect(state.getTask('task-free')!.assignedWorkerId).toBeNull();
  });

  it('allows re-claiming your OWN task by taskId (resume after respawn)', async () => {
    writeTask('task-held', { status: 'WORKING', assignedWorkerId: 'w-1' });
    writeWorker('w-1', { currentTaskId: 'task-held' });
    await state.load();

    const tool = claimNextTaskTool(state);
    const result = await tool.handler(
      { workerId: 'w-1', statuses: ['WORKING'], taskId: 'task-held' },
      state
    ) as { hasNext: boolean; task: { id: string } };

    expect(result.hasNext).toBe(true);
    expect(result.task.id).toBe('task-held');
    expect(state.getTask('task-held')!.assignedWorkerId).toBe('w-1');
  });

  it('a held task in a terminal status does not block a new claim', async () => {
    writeTask('task-done', { status: 'DONE', assignedWorkerId: 'w-1' });
    writeTask('task-free', { status: 'WORKING', order: 2 });
    writeWorker('w-1', { currentTaskId: null, status: 'IDLE' });
    await state.load();

    const tool = claimNextTaskTool(state);
    const result = await tool.handler({ workerId: 'w-1', statuses: ['WORKING'] }, state) as { hasNext: boolean; task: { id: string } };

    expect(result.hasNext).toBe(true);
    expect(result.task.id).toBe('task-free');
  });
});

describe('moe.claim_next_task — stale handoff disk state', () => {
  const STORED = 'v1:9f2c0a1b3d4e5f60718293a4b5c6d7e8f9012345:3:0a1b2c3d4e5f';
  const MOVED = 'v1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:1:ffeeddccbbaa';

  let testDir: string;
  let moePath: string;
  let state: StateManager;

  function setupMoe() {
    fs.mkdirSync(moePath, { recursive: true });
    for (const sub of ['epics', 'tasks', 'workers', 'proposals', 'channels', 'messages', 'teams']) {
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
    const epic: Epic = {
      id: 'epic-1', projectId: 'proj-test', title: 'E', description: '', architectureNotes: '',
      epicRails: [], status: 'ACTIVE', order: 1,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(moePath, 'epics', 'epic-1.json'), JSON.stringify(epic, null, 2));
  }

  function handoff(overrides: Partial<HandoffNote> = {}): HandoffNote {
    return {
      whatIsDone: 'nothing — this file does not compile',
      whatRemains: 'everything',
      releasedBy: 'worker-gone',
      releasedAt: new Date().toISOString(),
      ...overrides,
    };
  }

  function writeTask(id: string, overrides: Partial<Task> = {}): Task {
    const now = new Date().toISOString();
    const task: Task = {
      id, epicId: 'epic-1', title: `Task ${id}`, description: '',
      definitionOfDone: ['Done'], taskRails: [], implementationPlan: [],
      status: 'WORKING', assignedWorkerId: null, branch: null, prLink: null,
      reopenCount: 0, reopenReason: null, createdBy: 'HUMAN', parentTaskId: null,
      order: 1, createdAt: now, updatedAt: now,
      ...overrides,
    };
    fs.writeFileSync(path.join(moePath, 'tasks', id + '.json'), JSON.stringify(task, null, 2));
    return task;
  }

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moe-claim-disk-'));
    moePath = path.join(testDir, '.moe');
    setupMoe();
    state = new StateManager({ projectPath: testDir });
    mockedSignature.mockReset();
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  async function claim(): Promise<Record<string, unknown>> {
    await state.load();
    const tool = claimNextTaskTool(state);
    return await tool.handler({ workerId: 'w-1', statuses: ['WORKING'] }, state) as Record<string, unknown>;
  }

  it('flags a claim whose newest handoff describes a tree that has since moved', async () => {
    mockedSignature.mockResolvedValue(MOVED);
    writeTask('task-1', { priorHandoffs: [handoff({ diskState: STORED })] });

    const result = await claim();

    expect(result.hasNext).toBe(true);
    expect(result.staleHandoffDiskState).toBe(true);
    expect(mockedSignature).toHaveBeenCalledTimes(1);
    expect(mockedSignature).toHaveBeenCalledWith(testDir);
    // The original hint survives; the warning is appended to it.
    expect(result.handoffHint).toMatch(/moe\.get_handoff_history/);
    expect(result.handoffHint).toMatch(/working tree has CHANGED/);
    expect(result.handoffHint).toMatch(/re-verify/i);
  });

  it('omits the flag when the recomputed signature matches the stored one', async () => {
    mockedSignature.mockResolvedValue(STORED);
    writeTask('task-1', { priorHandoffs: [handoff({ diskState: STORED })] });

    const result = await claim();

    expect(result.hasNext).toBe(true);
    expect(result.staleHandoffDiskState).toBeUndefined();
    expect(result.handoffHint).not.toMatch(/CHANGED/);
  });

  it('omits the flag when the recompute fails (silence, never a false alarm)', async () => {
    mockedSignature.mockResolvedValue(undefined);
    writeTask('task-1', { priorHandoffs: [handoff({ diskState: STORED })] });

    const result = await claim();

    expect(result.hasNext).toBe(true);
    expect(result.staleHandoffDiskState).toBeUndefined();
    expect(result.handoffHint).not.toMatch(/CHANGED/);
  });

  it('still returns the claim when the recompute throws', async () => {
    // The claim has already mutated state by the time the signature is
    // recomputed — a throw here must not turn a successful claim into an error.
    mockedSignature.mockRejectedValue(new Error('git exploded'));
    writeTask('task-1', { priorHandoffs: [handoff({ diskState: STORED })] });

    const result = await claim();

    expect(result.hasNext).toBe(true);
    expect(result.staleHandoffDiskState).toBeUndefined();
    expect(state.getTask('task-1')!.assignedWorkerId).toBe('w-1');
  });

  it('compares against the NEWEST handoff only', async () => {
    mockedSignature.mockResolvedValue(STORED);
    writeTask('task-1', {
      priorHandoffs: [handoff({ diskState: STORED }), handoff({ diskState: MOVED })],
    });

    const result = await claim();

    expect(result.staleHandoffDiskState).toBeUndefined();
  });

  it('never shells out when the newest handoff carries no stored signature', async () => {
    writeTask('task-1', { priorHandoffs: [handoff()] });

    const result = await claim();

    expect(result.hasNext).toBe(true);
    expect(result.staleHandoffDiskState).toBeUndefined();
    expect(mockedSignature).toHaveBeenCalledTimes(0);
  });

  it('never shells out on an ordinary claim with no handoffs at all', async () => {
    writeTask('task-1');

    const result = await claim();

    expect(result.hasNext).toBe(true);
    expect(result.staleHandoffDiskState).toBeUndefined();
    expect(result.handoffHint).toBeUndefined();
    expect(mockedSignature).toHaveBeenCalledTimes(0);
  });
});

// ---- migrated from tools.test.ts ----
import { ToolTestHarness } from './toolTestHarness.js';
import { waitForTaskTool } from './waitForTask.js';

describe('moe.claim_next_task', () => {
  const h = new ToolTestHarness();
  beforeEach(() => h.init());
  afterEach(() => { vi.restoreAllMocks(); h.cleanup(); });

  // Fixtures use WORKING (the worker claim column): BACKLOG is human-gated
  // and no longer agent-claimable — see the vocabulary tests below.
  beforeEach(async () => {
    h.setupMoeFolder();
    h.createEpic();
    h.createTask({ id: 'task-1', status: 'WORKING', order: 2 });
    h.createTask({ id: 'task-2', status: 'WORKING', order: 1 });
    h.createTask({ id: 'task-3', status: 'PLANNING' });
    await h.state.load();
  });

  it('claims next task by status', async () => {
    const tool = claimNextTaskTool(h.state);
    const result = await tool.handler({
      statuses: ['WORKING'],
    }, h.state) as { hasNext: boolean; task: { id: string } };

    expect(result.hasNext).toBe(true);
    expect(result.task.id).toBe('task-2'); // lowest order
  });

  it('keeps claim response lean and defers full context to get_context', async () => {
    const tool = claimNextTaskTool(h.state);
    const result = await tool.handler({
      statuses: ['WORKING'],
      workerId: 'worker-lean',
    }, h.state) as {
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
      'priorHandoffCount',
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
    const tool = claimNextTaskTool(h.state);
    const result = await tool.handler({
      statuses: ['WORKING'],
      workerId: 'worker-1',
    }, h.state) as { task: { assignedWorkerId: string | null } };

    const task = h.state.getTask('task-2');
    expect(task?.assignedWorkerId).toBe('worker-1');
    expect(result.task.assignedWorkerId).toBe('worker-1');
  });

  it('replaceExisting overrides the epic-status block WITHOUT evicting a bystander worker', async () => {
    // worker-other holds task-active-worker (same epic+status). A ranked claim
    // for a DIFFERENT unassigned task (task-2) with replaceExisting must claim
    // task-2 and LEAVE worker-other on its own task — never yank a bystander.
    h.createTask({
      id: 'task-active-worker',
      status: 'WORKING',
      assignedWorkerId: 'worker-other',
      order: 99,
    });
    h.createWorker({
      id: 'worker-other',
      status: 'READING_CONTEXT',
      currentTaskId: 'task-active-worker',
    });
    await h.state.load();

    const tool = claimNextTaskTool(h.state);
    const result = await tool.handler({
      statuses: ['WORKING'],
      workerId: 'worker-replacement',
      replaceExisting: true,
    }, h.state) as { task: { id: string; assignedWorkerId: string | null } };

    expect(result.task.id).toBe('task-2');
    expect(result.task.assignedWorkerId).toBe('worker-replacement');
    expect(h.state.getTask('task-2')?.assignedWorkerId).toBe('worker-replacement');
    // Bystander is NOT evicted (previously this wrongly nulled its assignment).
    expect(h.state.getTask('task-active-worker')?.assignedWorkerId).toBe('worker-other');
    expect(h.state.getWorker('worker-other')?.currentTaskId).toBe('task-active-worker');
  });

  it('taskId + replaceExisting takes over THAT task from its live owner and idles them', async () => {
    h.createTask({ id: 'task-takeover', status: 'WORKING', assignedWorkerId: 'worker-incumbent', order: 5 });
    h.createWorker({ id: 'worker-incumbent', status: 'READING_CONTEXT', currentTaskId: 'task-takeover' });
    await h.state.load();

    const tool = claimNextTaskTool(h.state);
    const result = await tool.handler({
      statuses: ['WORKING'],
      taskId: 'task-takeover',
      workerId: 'worker-new',
      replaceExisting: true,
    }, h.state) as { hasNext: boolean; task: { id: string; assignedWorkerId: string | null } };

    // The SPECIFIC requested task is taken over (not a bystander), and the claim succeeds.
    expect(result.hasNext).toBe(true);
    expect(result.task.id).toBe('task-takeover');
    expect(result.task.assignedWorkerId).toBe('worker-new');
    expect(h.state.getTask('task-takeover')?.assignedWorkerId).toBe('worker-new');
    // The displaced incumbent is reconciled, not left dangling.
    expect(h.state.getWorker('worker-incumbent')?.currentTaskId).toBeNull();
    expect(h.state.getWorker('worker-incumbent')?.status).toBe('IDLE');
  });

  it('repairs and claims a task assigned to a missing worker', async () => {
    h.createTask({
      id: 'task-orphan-worker',
      status: 'WORKING',
      assignedWorkerId: 'worker-missing',
      order: 0,
    });
    await h.state.load();

    const tool = claimNextTaskTool(h.state);
    const result = await tool.handler({
      statuses: ['WORKING'],
      workerId: 'worker-reclaimer',
    }, h.state) as { hasNext: boolean; task: { id: string; assignedWorkerId: string | null } };

    expect(result.hasNext).toBe(true);
    expect(result.task.id).toBe('task-orphan-worker');
    expect(result.task.assignedWorkerId).toBe('worker-reclaimer');
    expect(h.state.getTask('task-orphan-worker')?.assignedWorkerId).toBe('worker-reclaimer');
  });

  it('wait_for_task treats a task assigned to a missing worker as available', async () => {
    h.createTask({
      id: 'task-wait-orphan',
      status: 'REVIEW',
      assignedWorkerId: 'worker-missing',
      order: 0,
    });
    await h.state.load();

    const tool = waitForTaskTool(h.state);
    const result = await tool.handler({
      statuses: ['REVIEW'],
      workerId: 'worker-waiter',
      timeoutMs: 1000,
    }, h.state) as { hasNext: boolean; task: { id: string }; nextAction: { tool: string } };

    expect(result.hasNext).toBe(true);
    expect(result.task.id).toBe('task-wait-orphan');
    expect(result.nextAction.tool).toBe('moe.claim_next_task');
  });

  it('claims from multiple statuses', async () => {
    const tool = claimNextTaskTool(h.state);
    const result = await tool.handler({
      statuses: ['PLANNING', 'WORKING'],
    }, h.state) as { task: { id: string } };

    // task-2 (WORKING, order 1) comes before task-3 (PLANNING, order 1)
    expect(result.task).toBeDefined();
  });

  it('throws for empty statuses', async () => {
    const tool = claimNextTaskTool(h.state);
    await expect(tool.handler({ statuses: [] }, h.state)).rejects.toThrow('Missing required field: statuses');
  });

  it('returns hasNext=false when no matching tasks', async () => {
    const tool = claimNextTaskTool(h.state);
    const result = await tool.handler({ statuses: ['REVIEW'], workerId: 'worker-none' }, h.state) as {
      hasNext: boolean;
      nextAction: { tool: string; args: { statuses: string[]; workerId: string } };
    };
    expect(result.hasNext).toBe(false);
    expect(Object.keys(result).sort()).toEqual(['hasNext', 'nextAction'].sort());
    expect(result.nextAction.tool).toBe('moe.wait_for_task');
    expect(result.nextAction.args.statuses).toEqual(['REVIEW']);
    expect(result.nextAction.args.workerId).toBe('worker-none');
  });

  it('includes rejection fields when task was reopened', async () => {
    h.createTask({
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
    await h.state.load();

    const tool = claimNextTaskTool(h.state);
    const result = await tool.handler({
      statuses: ['WORKING'],
      workerId: 'worker-reopen',
    }, h.state) as {
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
    const tool = claimNextTaskTool(h.state);
    const result = await tool.handler({
      statuses: ['WORKING'],
      workerId: 'worker-normal',
    }, h.state) as {
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
    const tool = claimNextTaskTool(h.state);
    const result = await tool.handler({
      statuses: ['WORKING'],
      taskId: 'task-1',
      workerId: 'worker-direct',
    }, h.state) as { hasNext: boolean; task: { id: string; assignedWorkerId: string } };

    expect(result.hasNext).toBe(true);
    expect(result.task.id).toBe('task-1');
    expect(result.task.assignedWorkerId).toBe('worker-direct');
    expect(h.state.getTask('task-1')?.assignedWorkerId).toBe('worker-direct');
    // task-2 should still be free
    expect(h.state.getTask('task-2')?.assignedWorkerId).toBeNull();
  });

  it('rejects taskId when task is not in any of the requested statuses', async () => {
    const tool = claimNextTaskTool(h.state);
    // task-3 is PLANNING; we ask for WORKING only
    await expect(tool.handler({
      statuses: ['WORKING'],
      taskId: 'task-3',
    }, h.state)).rejects.toThrow(/PLANNING/);
  });

  it('rejects taskId for unknown task', async () => {
    const tool = claimNextTaskTool(h.state);
    await expect(tool.handler({
      statuses: ['WORKING'],
      taskId: 'task-nope',
    }, h.state)).rejects.toThrow(/not found|NOT_FOUND/i);
  });

  it('rejects taskId already assigned to someone else without replaceExisting', async () => {
    h.createTask({ id: 'task-locked', status: 'WORKING', assignedWorkerId: 'worker-other', order: 99 });
    h.createWorker({ id: 'worker-other', status: 'READING_CONTEXT', currentTaskId: 'task-locked' });
    await h.state.load();
    const tool = claimNextTaskTool(h.state);
    await expect(tool.handler({
      statuses: ['WORKING'],
      taskId: 'task-locked',
      workerId: 'worker-thief',
    }, h.state)).rejects.toThrow(/already assigned/);
  });

  it('rejects human-gated statuses (BACKLOG/AWAITING_APPROVAL/DONE/ARCHIVED) — ranked and by taskId', async () => {
    const tool = claimNextTaskTool(h.state);
    // Ranked claim on a human-gated column
    await expect(tool.handler({
      statuses: ['BACKLOG'],
      workerId: 'worker-vocab',
    }, h.state)).rejects.toThrow(/not agent-claimable/);
    // Mixed arrays are rejected too — one bad status poisons the claim
    await expect(tool.handler({
      statuses: ['WORKING', 'BACKLOG'],
      workerId: 'worker-vocab',
    }, h.state)).rejects.toThrow(/not agent-claimable/);
    // Explicit-taskId claim of a BACKLOG task (the px4swarm wedge:
    // assignment used to succeed with the status stuck in BACKLOG, then
    // start_step rejected with INVALID_STATE forever)
    h.createTask({ id: 'task-backlog-wedge', status: 'BACKLOG', order: 50 });
    await h.state.load();
    await expect(tool.handler({
      statuses: ['BACKLOG'],
      taskId: 'task-backlog-wedge',
      workerId: 'worker-vocab',
    }, h.state)).rejects.toThrow(/not agent-claimable/);
    // Nothing got assigned along the way
    expect(h.state.getTask('task-backlog-wedge')?.assignedWorkerId).toBeNull();
    for (const bad of ['AWAITING_APPROVAL', 'DONE', 'ARCHIVED']) {
      await expect(tool.handler({
        statuses: [bad],
        workerId: 'worker-vocab',
      }, h.state)).rejects.toThrow(/not agent-claimable/);
    }
  });
});

