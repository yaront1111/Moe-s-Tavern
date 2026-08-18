import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { StateManager } from '../state/StateManager.js';
import { claimNextTaskTool } from './claimNextTask.js';
import { joinTeamTool } from './joinTeam.js';
import { activeWaiters, waitForTaskTool } from './waitForTask.js';
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

  // --- Block-holding worker: the two tools must answer identically.
  // Filed as task-9d5dfec6 from a measured spin; the claim side already
  // refused, but pointed at moe.list_resources, which cannot clear a
  // non-resource block, and told the worker to end its session while
  // wait_for_task kept offering it work.

  it('a BLOCKED hold refuses the claim and names release_task as the actionable exit', async () => {
    writeTask('task-blocked', { status: 'BLOCKED', assignedWorkerId: 'w-1', blockedReason: 'needs a human' });
    writeTask('task-free', { status: 'WORKING', order: 2 });
    writeWorker('w-1', { currentTaskId: 'task-blocked', status: 'BLOCKED' });
    await state.load();

    const tool = claimNextTaskTool(state);
    const result = await tool.handler({ workerId: 'w-1', statuses: ['WORKING'] }, state) as Record<string, unknown>;

    expect(result.hasNext).toBe(false);
    const assigned = result.alreadyAssigned as { taskId: string; status: string; blockedReason?: string };
    expect(assigned.taskId).toBe('task-blocked');
    expect(assigned.status).toBe('BLOCKED');
    expect(assigned.blockedReason).toBe('needs a human');
    const next = result.nextAction as { tool: string; args: Record<string, unknown>; reason: string };
    expect(next.tool).toBe('moe.release_task');
    expect(next.args).toEqual({ taskId: 'task-blocked', workerId: 'w-1' });
    expect(next.reason).toContain('moe.release_task');
    expect(state.getTask('task-free')!.assignedWorkerId).toBeNull();
  });

  it('wait_for_task and claim_next_task give a block-holding worker the SAME answer', async () => {
    writeTask('task-blocked', { status: 'BLOCKED', assignedWorkerId: 'w-1', blockedReason: 'needs a human' });
    writeTask('task-free', { status: 'WORKING', order: 2 });
    writeWorker('w-1', { currentTaskId: 'task-blocked', status: 'BLOCKED' });
    writeWorker('w-2', { currentTaskId: null, status: 'IDLE' });
    await state.load();

    // Drive BOTH production tools against one board and compare their actual
    // answers. Restating either tool's predicate in the test would leave this
    // green through exactly the drift it exists to catch.
    const waitResult = await waitForTaskTool(state).handler(
      { statuses: ['WORKING'], workerId: 'w-1', timeoutMs: 1000 },
      state
    ) as Record<string, unknown>;
    const claimResult = await claimNextTaskTool(state).handler(
      { workerId: 'w-1', statuses: ['WORKING'] },
      state
    ) as Record<string, unknown>;

    // Neither offers task-free...
    expect(waitResult.hasNext).toBe(false);
    expect(claimResult.hasNext).toBe(false);
    expect(waitResult.task).toBeUndefined();
    // ...and both decline with the identical refusal payload and identical
    // actionable guidance: one predicate, one hint source, two consumers.
    expect(waitResult.alreadyAssigned).toEqual(claimResult.alreadyAssigned);
    expect(waitResult.nextAction).toEqual(claimResult.nextAction);

    // POSITIVE CONTROL: task-free really was claimable and wait-visible to an
    // unencumbered worker on this same board, so the agreement above is a
    // narrowing of the caller-encumbered case and not a dead queue.
    const freeWait = await waitForTaskTool(state).handler(
      { statuses: ['WORKING'], workerId: 'w-2', timeoutMs: 1000 },
      state
    ) as Record<string, unknown>;
    expect(freeWait.hasNext).toBe(true);
    expect((freeWait.task as { id: string }).id).toBe('task-free');

    const freeClaim = await claimNextTaskTool(state).handler(
      { workerId: 'w-2', statuses: ['WORKING'] },
      state
    ) as { hasNext: boolean; task: { id: string } };
    expect(freeClaim.hasNext).toBe(true);
    expect(freeClaim.task.id).toBe('task-free');
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

// ---------------------------------------------------------------------------
// A claimer whose team membership is absent hits the solo epic+status block
// (claimNextTask block (3)) and used to fall through to the genuine-race tail
// message — "all candidates taken" on a visibly full board. These pin the
// truthful refusal, its discrimination from a real race, and the auto-heal
// that stops eviction silently demoting a team member to a solo.
// ---------------------------------------------------------------------------
describe('moe.claim_next_task — team-membership refusal and auto-heal', () => {
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

  function writeWorker(id: string, overrides: Partial<Worker> = {}): void {
    const now = new Date().toISOString();
    const worker: Worker = {
      id, type: 'CLAUDE', projectId: 'proj-test', epicId: 'epic-1',
      currentTaskId: null, status: 'IDLE', branch: '', modifiedFiles: [],
      startedAt: now, lastActivityAt: now, lastError: null, errorCount: 0, teamId: null,
      ...overrides,
    };
    fs.writeFileSync(path.join(moePath, 'workers', id + '.json'), JSON.stringify(worker, null, 2));
  }

  function writeTask(id: string, overrides: Partial<Task> = {}): void {
    const now = new Date().toISOString();
    const task: Task = {
      id, epicId: 'epic-1', title: 'Task ' + id, description: '',
      definitionOfDone: ['Done'], taskRails: [], implementationPlan: [],
      status: 'WORKING', assignedWorkerId: null, branch: null, prLink: null,
      reopenCount: 0, reopenReason: null, createdBy: 'HUMAN', parentTaskId: null,
      order: 1, createdAt: now, updatedAt: now,
      ...overrides,
    };
    fs.writeFileSync(path.join(moePath, 'tasks', id + '.json'), JSON.stringify(task, null, 2));
  }

  /** A full board: one free task, plus a peer holding a DIFFERENT task in the
   *  same epic+status — exactly the shape that arms the solo block. */
  function seedFullBoard(): void {
    writeTask('task-free', { status: 'WORKING', order: 1 });
    writeTask('task-peer', { status: 'WORKING', order: 2, assignedWorkerId: 'w-peer' });
    writeWorker('w-peer', { currentTaskId: 'task-peer', status: 'CODING' });
    writeWorker('w-solo');
  }

  async function claim(workerId = 'w-solo'): Promise<Record<string, unknown>> {
    const tool = claimNextTaskTool(state);
    return await tool.handler({ workerId, statuses: ['WORKING'] }, state) as Record<string, unknown>;
  }

  beforeEach(() => {
    mockedSignature.mockReset();
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moe-claim-team-'));
    moePath = path.join(testDir, '.moe');
    setupMoe();
    state = new StateManager({ projectPath: testDir });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('refuses a teamless claimer with NO_TEAM_MEMBERSHIP and a join_team exit, not the race message', async () => {
    seedFullBoard();
    await state.load();
    expect(state.getTeamForWorker('w-solo')).toBeNull();

    const result = await claim();

    expect(result.hasNext).toBe(false);
    expect(result.code).toBe('NO_TEAM_MEMBERSHIP');
    const next = result.nextAction as { tool: string; args: Record<string, unknown>; reason: string };
    expect(next.tool).toBe('moe.join_team');
    expect(next.args.workerId).toBe('w-solo');
    // The reason must name the rule that actually refused, so a reader stops
    // hunting for a race that never happened.
    expect(next.reason).toMatch(/team/i);
    expect(next.reason).toMatch(/epic/i);
    // The lie itself: the concurrent-claim wording must not appear anywhere.
    expect(JSON.stringify(result)).not.toContain('taken by concurrent workers');
  });

  it('lets a TEAM member claim the same board (teams parallelize an epic+status)', async () => {
    seedFullBoard();
    await state.load();
    const team = await state.createTeam({ name: 'workers', role: 'worker' });
    await state.addTeamMember(team.id, 'w-solo');

    const result = await claim();

    expect(result.hasNext).toBe(true);
    expect((result.task as { id: string }).id).toBe('task-free');
    expect(result.code).toBeUndefined();
  });

  it('still reports a GENUINE concurrent claim as a race, not as a membership miss', async () => {
    seedFullBoard();
    await state.load();
    const team = await state.createTeam({ name: 'workers', role: 'worker' });
    await state.addTeamMember(team.id, 'w-solo');
    // Simulate the optimistic-concurrency loss: another worker assigns the
    // candidate between the ranked filter and our write.
    const realUpdateTask = state.updateTask.bind(state);
    vi.spyOn(state, 'updateTask').mockImplementation(async (taskId, updates, event) => {
      if (taskId === 'task-free' && (updates as { assignedWorkerId?: string }).assignedWorkerId === 'w-solo') {
        throw new Error('Task already assigned to w-other');
      }
      return realUpdateTask(taskId, updates, event);
    });

    const result = await claim();

    expect(result.hasNext).toBe(false);
    expect(result.code).not.toBe('NO_TEAM_MEMBERSHIP');
    const next = result.nextAction as { tool: string; reason: string };
    expect(next.tool).toBe('moe.wait_for_task');
    expect(next.reason).toContain('taken by concurrent workers');
  });

  it('claims successfully once the refused worker joins a team (the documented workaround)', async () => {
    seedFullBoard();
    await state.load();
    const refused = await claim();
    expect(refused.code).toBe('NO_TEAM_MEMBERSHIP');

    const team = await state.createTeam({ name: 'workers', role: 'worker' });
    await joinTeamTool(state).handler({ teamId: team.id, workerId: 'w-solo' }, state);

    const result = await claim();

    expect(result.hasNext).toBe(true);
    expect((result.task as { id: string }).id).toBe('task-free');
  });

  it('auto-heals membership after presence eviction deleted the worker record', async () => {
    seedFullBoard();
    await state.load();
    const team = await state.createTeam({ name: 'workers', role: 'worker' });
    await state.addTeamMember(team.id, 'w-solo');

    // Presence eviction: the stale sweep and the DEAD-worker prune both call
    // deleteWorker, which drops the record (and with it worker.teamId).
    await state.deleteWorker('w-solo');
    expect(state.getWorker('w-solo')).toBeNull();
    expect(state.getTeam(team.id)?.memberIds).not.toContain('w-solo');

    const result = await claim();

    expect(result.hasNext).toBe(true);
    expect((result.task as { id: string }).id).toBe('task-free');
    expect(state.getTeamForWorker('w-solo')?.id).toBe(team.id);
    expect(state.getTeam(team.id)?.memberIds).toContain('w-solo');
  });

  it('never resurrects a worker removed from the team AFTER it was evicted', async () => {
    seedFullBoard();
    await state.load();
    const team = await state.createTeam({ name: 'workers', role: 'worker' });
    await state.addTeamMember(team.id, 'w-solo');
    // Eviction first, so the tombstone really is written...
    await state.deleteWorker('w-solo');
    expect(state.getTeam(team.id)?.formerMemberIds).toContain('w-solo');
    // ...then the deliberate removal, which must retract it. Ordered this way
    // round the assertion below is only reachable if leave_team clears the
    // tombstone: the reverse order never writes one, and passed either way.
    await state.removeTeamMember(team.id, 'w-solo');
    expect(state.getTeam(team.id)?.formerMemberIds).not.toContain('w-solo');

    const result = await claim();

    expect(result.hasNext).toBe(false);
    expect(result.code).toBe('NO_TEAM_MEMBERSHIP');
    expect(state.getTeamForWorker('w-solo')).toBeNull();
  });

  it('auto-heals membership after a startup purge wiped every team roster', async () => {
    seedFullBoard();
    await state.load();
    const team = await state.createTeam({ name: 'workers', role: 'worker' });
    await state.addTeamMember(team.id, 'w-solo');

    await state.purgeAllWorkers();
    expect(state.getWorker('w-solo')).toBeNull();
    expect(state.getTeam(team.id)?.memberIds).toEqual([]);

    // The peer record died with the purge too, so re-seed the live peer that
    // arms the solo block — otherwise the claim would succeed for the wrong
    // reason (nothing left to block it).
    writeWorker('w-peer', { currentTaskId: 'task-peer', status: 'CODING' });
    await state.load();
    await state.updateTask('task-peer', { assignedWorkerId: 'w-peer' });

    const result = await claim();

    expect(result.hasNext).toBe(true);
    expect(state.getTeamForWorker('w-solo')?.id).toBe(team.id);
  });
});
