import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { StateManager } from '../state/StateManager.js';
import { claimNextTaskTool } from './claimNextTask.js';
import { joinTeamTool } from './joinTeam.js';
import { activeWaiters, waitForTaskTool } from './waitForTask.js';
import { computeDiskStateSignature } from '../util/diskState.js';
import { releaseTaskTool } from './releaseTask.js';
import { ToolTestHarness } from './toolTestHarness.js';
import { closeOpenAttempts, listAttempts, openAttempt, setAttemptPhase } from '../state/attemptStore.js';
import { MoeError } from '../util/errors.js';
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

  // ---------------------------------------------------------------------
  // REGRESSION 2026-09-12: the governor redirect read `team.role` directly.
  // The launcher registers every seat into ONE project-named team whose role
  // is null, so the read saw nothing, a governor seat fell THROUGH the
  // redirect and claimed a task — work the project's rules say governors
  // never do. The role now resolves through util/workerRole.
  // ---------------------------------------------------------------------
  async function bindWorkerToRolelessTeam(workerId: string): Promise<string> {
    const team = await state.createTeam({ name: 'moe-next' });
    expect(team.role).toBeFalsy(); // the launcher's team shape: no role at all
    await state.addTeamMember(team.id, workerId);
    return team.id;
  }

  function writeWorkingTask(id: string): void {
    const now = new Date().toISOString();
    const task: Task = {
      id, epicId: 'epic-1', title: `Task ${id}`, description: '',
      definitionOfDone: ['Done'], taskRails: [], implementationPlan: [],
      status: 'WORKING', assignedWorkerId: null, branch: null, prLink: null,
      reopenCount: 0, reopenReason: null, createdBy: 'HUMAN', parentTaskId: null,
      order: 1, createdAt: now, updatedAt: now,
    };
    fs.writeFileSync(path.join(moePath, 'tasks', id + '.json'), JSON.stringify(task, null, 2));
  }

  it('routes a governor-prefixed seat on a ROLE-LESS team to enter_governance', async () => {
    writeWorker('governor-noroleteam');
    writeWorkingTask('task-claimable');
    await state.load();
    await bindWorkerToRolelessTeam('governor-noroleteam');

    const tool = claimNextTaskTool(state);
    const result = await tool.handler(
      { workerId: 'governor-noroleteam', statuses: ['PLANNING', 'WORKING', 'REVIEW'] },
      state
    ) as Record<string, unknown>;

    expect(result.hasNext).toBe(false);
    expect((result.nextAction as { tool: string }).tool).toBe('moe.enter_governance');
    // The point of the redirect: a claimable task was sitting right there and
    // the governor did not take it.
    expect(state.getTask('task-claimable')!.assignedWorkerId).toBeNull();
  });

  it('still lets an UNREGISTERED governor-prefixed seat fall through to claim', async () => {
    // The onboarding escape, deliberately keyed on the WORKER RECORD rather
    // than on the role: enter_governance throws NOT_FOUND for an id with no
    // record, so routing this caller there would hand it a next action that
    // immediately refuses. It registers by claiming; the NEXT call is routed.
    writeWorkingTask('task-onboarding');
    await state.load();

    const tool = claimNextTaskTool(state);
    const result = await tool.handler(
      { workerId: 'governor-unregistered', statuses: ['WORKING'] },
      state
    ) as Record<string, unknown>;

    expect(result.hasNext).toBe(true);
    expect(state.getTask('task-onboarding')!.assignedWorkerId).toBe('governor-unregistered');
  });

  it('lets a team-supplied role beat the id prefix in the governor redirect', async () => {
    // An explicit join_team is the operator stating the seat's role, so a
    // governor-NAMED seat the operator put on a worker team claims normally.
    writeWorker('governor-onworkerteam');
    writeWorkingTask('task-for-roled-seat');
    await state.load();
    await bindWorkerToTeamRole('governor-onworkerteam', 'worker');

    const tool = claimNextTaskTool(state);
    const result = await tool.handler(
      { workerId: 'governor-onworkerteam', statuses: ['WORKING'] },
      state
    ) as Record<string, unknown>;

    expect((result.nextAction as { tool: string } | undefined)?.tool).not.toBe('moe.enter_governance');
    expect(result.hasNext).toBe(true);
    expect(state.getTask('task-for-roled-seat')!.assignedWorkerId).toBe('governor-onworkerteam');
  });

  it('names the resolved role in the worker-is-online chat line', async () => {
    // The status-based guess would say "worker" for a WORKING claim, so an
    // architect seat announcing itself is the case where the two disagree —
    // the resolved role must win. An announcement naming the wrong role is a
    // small lie, but it is one the whole board reads.
    writeWorkingTask('task-for-chatline');
    await state.load();
    const posted: string[] = [];
    vi.spyOn(state, 'postToGeneral').mockImplementation(async (content: string) => {
      posted.push(content);
    });

    const tool = claimNextTaskTool(state);
    await tool.handler({ workerId: 'architect-chatline', statuses: ['WORKING'] }, state);

    const online = posted.find((line) => line.includes('is online'));
    expect(online).toBe('architect-chatline is online (architect)');
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

  it('keeps that evicted member VISIBLE to wait_for_task instead of parking it forever', async () => {
    seedFullBoard();
    await state.load();
    const team = await state.createTeam({ name: 'workers', role: 'worker' });
    await state.addTeamMember(team.id, 'w-solo');

    // The same eviction as the claim-side twin above. wait_for_task resolves
    // effective membership but must NOT rejoin -- a read may not mutate the
    // roster -- so live membership really is gone here and only the tombstone
    // keeps the waiter eligible.
    await state.deleteWorker('w-solo');
    expect(state.getTeamForWorker('w-solo')).toBeNull();
    expect(state.getTeam(team.id)?.formerMemberIds).toContain('w-solo');

    // Drive the production tool rather than restating its predicate: this is
    // the only assertion holding waitForTask's eligibility filter to
    // claim_next_task's. Reverting that one resolveEffectiveTeam call back to
    // getTeamForWorker answers { hasNext: false, timedOut: true } here -- the
    // evicted member goes invisible to the queue and parks until the timeout,
    // which is precisely the drift that opened this defect.
    const result = await waitForTaskTool(state).handler(
      { statuses: ['WORKING'], workerId: 'w-solo', timeoutMs: 1000 },
      state
    ) as Record<string, unknown>;

    expect(result.hasNext).toBe(true);
    expect((result.task as { id: string }).id).toBe('task-free');
    expect(result.timedOut).toBeUndefined();
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

    // Age w-solo past the presence window AFTER joining the team (the join
    // refreshes its heartbeat), so the startup purge actually purges it:
    // purgeAllWorkers now KEEPS registrations that are still heartbeating, so a
    // fresh fixture would survive and this scenario would never arise.
    const solo = state.getWorker('w-solo')!;
    state.workers.set('w-solo', {
      ...solo,
      lastActivityAt: new Date(Date.now() - 10 * 60_000).toISOString(),
    });

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

// =============================================================================
// Execution attempts (task-b6c48bf0). A claim that hands a task to a worker
// opens the ExecutionAttempt later calls are fenced against — or, on a genuine
// resume, adopts the one already open — and returns its identity beside the
// task. Every assertion names exact generations and phases: a truthiness check
// passes against a reused record, which is the bug a generation exists to catch.
// =============================================================================
describe('moe.claim_next_task — execution attempts', () => {
  const h = new ToolTestHarness();

  beforeEach(() => {
    h.init();
    h.setupMoeFolder();
    h.createEpic();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    h.cleanup();
  });

  async function claim(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    return await claimNextTaskTool(h.state).handler({ statuses: ['WORKING'], ...args }, h.state) as Record<string, unknown>;
  }

  /** [generation, workerId, phase] for each attempt of the task, in generation order. */
  function attemptsOf(taskId: string): Array<[number, string, string]> {
    return listAttempts(h.state, taskId).map((a) => [a.generation, a.workerId, a.phase]);
  }

  /** The record as persisted, so an attempt that was only published in memory cannot pass. */
  function attemptOnDisk(attemptId: unknown): Record<string, unknown> {
    const file = path.join(h.moePath, 'attempts', `${String(attemptId)}.json`);
    return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  }

  /** A seat given up without closing its attempt: a crash between a release's two writes, or a path that does not close yet. */
  async function leaveAttemptOpen(taskId: string, workerId: string): Promise<string> {
    const attempt = await openAttempt(h.state, { taskId, workerId, runnerId: workerId, workspace: h.testDir });
    return attempt.id;
  }

  it('opens one running generation-1 attempt and returns its identity beside the task', async () => {
    h.createTask({ id: 'task-1', status: 'WORKING' });
    await h.state.load();

    const result = await claim({ workerId: 'worker-1' });

    expect(result.hasNext).toBe(true);
    expect(result.generation).toBe(1);
    expect(typeof result.attemptId).toBe('string');
    const attempts = listAttempts(h.state, 'task-1');
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({
      id: result.attemptId,
      taskId: 'task-1',
      workerId: 'worker-1',
      // The claim knows only the worker and the project: a distinct runner and a
      // per-attempt workspace arrive with the reattachment work.
      runnerId: 'worker-1',
      workspace: h.state.projectPath,
      generation: 1,
      phase: 'running',
    });
    expect(attemptOnDisk(result.attemptId)).toMatchObject({
      id: result.attemptId, taskId: 'task-1', workerId: 'worker-1', generation: 1, phase: 'running',
    });
    // Beside `task`, never inside it: `task` mirrors the persisted row.
    expect(result.task).not.toHaveProperty('attemptId');
    expect(result.task).not.toHaveProperty('generation');
  });

  it('opens generation 2 as a NEW record when the same worker claims again after a release', async () => {
    h.createTask({ id: 'task-1', status: 'WORKING' });
    await h.state.load();

    const first = await claim({ workerId: 'worker-1' });
    await releaseTaskTool(h.state).handler({ taskId: 'task-1', workerId: 'worker-1' }, h.state);
    const second = await claim({ workerId: 'worker-1' });

    expect(first.generation).toBe(1);
    expect(second.generation).toBe(2);
    expect(typeof second.attemptId).toBe('string');
    expect(second.attemptId).not.toBe(first.attemptId);
    expect(attemptsOf('task-1')).toEqual([
      [1, 'worker-1', 'closed'],
      [2, 'worker-1', 'running'],
    ]);
    expect(attemptOnDisk(first.attemptId).phase).toBe('closed');
  });

  it('adopts the open attempt when the holder re-claims its own task, opening nothing new', async () => {
    h.createTask({ id: 'task-1', status: 'WORKING' });
    await h.state.load();
    const first = await claim({ workerId: 'worker-1' });
    expect(typeof first.attemptId).toBe('string');

    const resumed = await claim({ workerId: 'worker-1', taskId: 'task-1' });

    expect(resumed.hasNext).toBe(true);
    expect(resumed.attemptId).toBe(first.attemptId);
    expect(resumed.generation).toBe(1);
    expect(attemptsOf('task-1')).toEqual([[1, 'worker-1', 'running']]);
  });

  it('opens no attempt on the alreadyAssigned refusal', async () => {
    h.createTask({ id: 'task-1', status: 'WORKING' });
    h.createTask({ id: 'task-2', status: 'WORKING', order: 2 });
    await h.state.load();
    await claim({ workerId: 'worker-1', taskId: 'task-1' });
    expect(attemptsOf('task-1')).toEqual([[1, 'worker-1', 'running']]);

    // Idle wrappers poll this path; if it opened an attempt, every poll would burn a generation.
    const refused = await claim({ workerId: 'worker-1' });

    expect(refused.hasNext).toBe(false);
    expect((refused.alreadyAssigned as { taskId: string }).taskId).toBe('task-1');
    expect(refused).not.toHaveProperty('attemptId');
    expect(attemptsOf('task-1')).toEqual([[1, 'worker-1', 'running']]);
    expect(attemptsOf('task-2')).toEqual([]);
  });

  it('leaves no attempt behind when the claim loses the assignment race', async () => {
    h.createTask({ id: 'task-1', status: 'WORKING' });
    await h.state.load();
    // Constructed, never raced (the claimNextTask.race.test.ts idiom): the
    // winner's assignment lands between the loser's eligibility read and its write.
    const realUpdate = h.state.updateTask.bind(h.state);
    let fired = false;
    vi.spyOn(h.state, 'updateTask').mockImplementation(async (...args: Parameters<StateManager['updateTask']>) => {
      if (!fired && args[1].assignedWorkerId === 'worker-loser') {
        fired = true;
        await realUpdate(args[0], { assignedWorkerId: 'worker-winner' });
      }
      return realUpdate(...args);
    });

    await expect(claim({ workerId: 'worker-loser' })).rejects.toMatchObject({ codeName: 'CLAIM_LOST_RACE' });

    expect(h.state.getTask('task-1')!.assignedWorkerId).toBe('worker-winner');
    expect(attemptsOf('task-1')).toEqual([]);
    // POSITIVE CONTROL: the winner then gets generation 1 — the loser burned no
    // generation and left nothing that could refuse the winner's open.
    vi.restoreAllMocks();
    const won = await claim({ workerId: 'worker-winner', taskId: 'task-1' });
    expect(won.generation).toBe(1);
    expect(attemptsOf('task-1')).toEqual([[1, 'worker-winner', 'running']]);
  });

  it('closes an attempt a given-up seat left open, then opens the successor generation', async () => {
    h.createTask({ id: 'task-1', status: 'WORKING' });
    await h.state.load();
    const stale = await leaveAttemptOpen('task-1', 'worker-gone');

    const result = await claim({ workerId: 'worker-1' });

    expect(result.generation).toBe(2);
    expect(result.attemptId).not.toBe(stale);
    expect(attemptsOf('task-1')).toEqual([
      [1, 'worker-gone', 'closed'],
      [2, 'worker-1', 'running'],
    ]);
  });

  it('never adopts its own open attempt when it did not already hold the seat', async () => {
    // Same worker id, but nobody holds the seat: a release whose close failed, or
    // complete_task -> REVIEW -> qa_reject -> WORKING. This claim is a new
    // execution, not a resume, so it must not inherit the old generation.
    h.createTask({ id: 'task-1', status: 'WORKING' });
    await h.state.load();
    const leftover = await leaveAttemptOpen('task-1', 'worker-1');

    const result = await claim({ workerId: 'worker-1' });

    expect(result.generation).toBe(2);
    expect(result.attemptId).not.toBe(leftover);
    expect(attemptsOf('task-1')).toEqual([
      [1, 'worker-1', 'closed'],
      [2, 'worker-1', 'running'],
    ]);
  });

  it('closes the incumbent attempt on a replaceExisting takeover', async () => {
    h.createTask({ id: 'task-1', status: 'WORKING' });
    await h.state.load();
    const incumbent = await claim({ workerId: 'worker-a' });

    const takeover = await claim({ workerId: 'worker-b', taskId: 'task-1', replaceExisting: true });

    expect(incumbent.generation).toBe(1);
    expect(takeover.generation).toBe(2);
    expect(h.state.getTask('task-1')!.assignedWorkerId).toBe('worker-b');
    expect(attemptsOf('task-1')).toEqual([
      [1, 'worker-a', 'closed'],
      [2, 'worker-b', 'running'],
    ]);
  });

  it('ends the incumbent attempt at eviction, even when the takeover then fails to assign', async () => {
    h.createTask({ id: 'task-1', status: 'WORKING' });
    await h.state.load();
    await claim({ workerId: 'worker-a' });
    const writeFailed = new Error('EIO: assignment write failed');
    const realUpdate = h.state.updateTask.bind(h.state);
    vi.spyOn(h.state, 'updateTask').mockImplementation(async (...args: Parameters<StateManager['updateTask']>) => {
      if (args[1].assignedWorkerId === 'worker-b') throw writeFailed;
      return realUpdate(...args);
    });

    await expect(claim({ workerId: 'worker-b', taskId: 'task-1', replaceExisting: true })).rejects.toBe(writeFailed);

    // The incumbent was evicted before the failed write, so its seat is gone —
    // and a row left unassigned must not keep an attempt running.
    expect(h.state.getTask('task-1')!.assignedWorkerId).toBeNull();
    expect(attemptsOf('task-1')).toEqual([[1, 'worker-a', 'closed']]);
  });

  it('closes a dead owner\'s attempt when it clears the seat, even if it then skips the task', async () => {
    h.createTask({ id: 'task-dead', status: 'WORKING', assignedWorkerId: 'worker-dead', order: 1 });
    h.createTask({ id: 'task-peer', status: 'WORKING', assignedWorkerId: 'worker-peer', order: 2 });
    h.createWorker({ id: 'worker-peer', status: 'CODING', currentTaskId: 'task-peer' });
    h.createWorker({ id: 'worker-solo' });
    await h.state.load();
    // worker-dead has no record, so its row is claimable — and its attempt is still open.
    await leaveAttemptOpen('task-dead', 'worker-dead');

    const result = await claim({ workerId: 'worker-solo' });

    // The solo-claim block skipped the row (worker-solo is in no team)...
    expect(result.hasNext).toBe(false);
    expect(result.code).toBe('NO_TEAM_MEMBERSHIP');
    // ...after the claim had already taken the dead owner's seat, so that attempt ended there.
    expect(h.state.getTask('task-dead')!.assignedWorkerId).toBeNull();
    expect(attemptsOf('task-dead')).toEqual([[1, 'worker-dead', 'closed']]);
  });

  it('fails the claim and gives the seat back when the attempt cannot be recorded', async () => {
    h.createTask({ id: 'task-1', status: 'WORKING' });
    await h.state.load();
    const refused = new Error('ENOSPC: no space left for the attempt record');
    const realWrite = h.state.writeEntity.bind(h.state);
    vi.spyOn(h.state, 'writeEntity').mockImplementation(async (...args: Parameters<StateManager['writeEntity']>) => {
      if (args[0] === 'attempts') throw refused;
      return realWrite(...args);
    });

    await expect(claim({ workerId: 'worker-1' })).rejects.toBe(refused);

    // Not left held by an execution the daemon has no record of.
    expect(h.state.getTask('task-1')!.assignedWorkerId).toBeNull();
    expect(attemptsOf('task-1')).toEqual([]);
  });

  it('rethrows the original error when giving the seat back fails too', async () => {
    h.createTask({ id: 'task-1', status: 'WORKING' });
    await h.state.load();
    const refused = new Error('ENOSPC: no space left for the attempt record');
    const realWrite = h.state.writeEntity.bind(h.state);
    vi.spyOn(h.state, 'writeEntity').mockImplementation(async (...args: Parameters<StateManager['writeEntity']>) => {
      if (args[0] === 'attempts') throw refused;
      return realWrite(...args);
    });
    const realUpdate = h.state.updateTask.bind(h.state);
    vi.spyOn(h.state, 'updateTask').mockImplementation(async (...args: Parameters<StateManager['updateTask']>) => {
      if (args[1].assignedWorkerId === null) throw new Error('compensating write failed');
      return realUpdate(...args);
    });

    await expect(claim({ workerId: 'worker-1' })).rejects.toBe(refused);
  });

  it('opens no attempt for a claim that names no worker (nothing is handed to anyone)', async () => {
    h.createTask({ id: 'task-1', status: 'WORKING' });
    await h.state.load();

    const result = await claim({});

    expect(result.hasNext).toBe(true);
    expect(h.state.getTask('task-1')!.assignedWorkerId).toBeNull();
    expect(result).not.toHaveProperty('attemptId');
    expect(attemptsOf('task-1')).toEqual([]);
  });
});

// =============================================================================
// Finalizing attempts (task-5dd49fe2). complete_task holds the owning attempt
// OPEN in the `finalizing` phase instead of closing it, because the wrapper
// only lands the bytes after the CLI exits. Until that boundary is
// acknowledged the seat is not free, so a coding claim from the SAME worker is
// refused. The refusal is THROWN: task-d72d8cc6 reshaped it from the returned
// object this suite originally pinned, because the held-out acceptance case
// requires a MoeError. The retryable rail now travels in context.retryable, so
// a wrapper reads that flag instead of the response shape.
// =============================================================================
describe('moe.claim_next_task — finalizing attempt refusal', () => {
  const h = new ToolTestHarness();

  beforeEach(async () => {
    h.init();
    h.setupMoeFolder();
    h.createEpic();
    // task-1 is the just-completed row: complete_task moved it to REVIEW and
    // the WORKING->REVIEW handoff cleared its assignment, so it is NOT a
    // blockingHold. task-2 is the next piece of work the worker must not start.
    h.createTask({ id: 'task-1', status: 'REVIEW', assignedWorkerId: null });
    h.createTask({ id: 'task-2', status: 'WORKING', assignedWorkerId: null, order: 2 });
    await h.state.load();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    h.cleanup();
  });

  async function claim(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    return await claimNextTaskTool(h.state).handler({ statuses: ['WORKING'], ...args }, h.state) as Record<string, unknown>;
  }

  /** [generation, workerId, phase] for each attempt of the task, in generation order. */
  function attemptsOf(taskId: string): Array<[number, string, string]> {
    return listAttempts(h.state, taskId).map((a) => [a.generation, a.workerId, a.phase]);
  }

  /** The state complete_task leaves behind: an open attempt held in `finalizing`. */
  async function finalizingAttemptFor(workerId: string): Promise<{ id: string; generation: number }> {
    const opened = await openAttempt(h.state, {
      taskId: 'task-1', workerId, runnerId: workerId, workspace: h.testDir,
    });
    const held = await setAttemptPhase(h.state, opened.id, 'finalizing');
    return { id: held.id, generation: held.generation };
  }

  it('refuses a coding claim while that worker has an attempt finalizing', async () => {
    const held = await finalizingAttemptFor('worker-1');

    // Thrown, not returned: the same identity the held-out acceptance case
    // pins. `retryable` in the context is what tells a wrapper to come back
    // rather than escalate — the throw itself carries no such meaning.
    const refused = await claim({ workerId: 'worker-1' }).then(
      () => { throw new Error('expected a MoeError refusal, but the claim resolved'); },
      (err: unknown) => err
    );

    expect(refused).toBeInstanceOf(MoeError);
    const err = refused as MoeError;
    expect(err.code).toBe(-32002);
    expect(err.codeName).toBe('ATTEMPT_FINALIZING');
    expect(err.context).toEqual({
      attemptId: held.id,
      generation: held.generation,
      taskId: 'task-1',
      workerId: 'worker-1',
      retryable: true,
    });
    // The message must name the attempt: MoeError.context is NOT forwarded over
    // the MCP wire, so the message is all a remote caller sees.
    expect(err.message).toContain(held.id);
  });

  it('changes no task owner when it refuses a worker holding a finalizing attempt', async () => {
    await finalizingAttemptFor('worker-1');

    await expect(claim({ workerId: 'worker-1' })).rejects.toThrow(/finalizing/);

    // The refusal fires before ranking and before the assignment write.
    expect(h.state.getTask('task-2')!.assignedWorkerId).toBeNull();
    expect(h.state.getTask('task-2')!.status).toBe('WORKING');
    expect(h.state.getTask('task-1')!.assignedWorkerId).toBeNull();
    expect(attemptsOf('task-2')).toEqual([]);
  });

  it('claims normally when the worker\'s only attempts are closed', async () => {
    await finalizingAttemptFor('worker-1');
    await closeOpenAttempts(h.state, 'task-1');

    const result = await claim({ workerId: 'worker-1' });

    expect(result.hasNext).toBe(true);
    expect((result.task as { id: string }).id).toBe('task-2');
  });

  it('is not blocked by a finalizing attempt belonging to a different worker', async () => {
    await finalizingAttemptFor('worker-2');

    const result = await claim({ workerId: 'worker-1' });

    expect(result.hasNext).toBe(true);
    expect((result.task as { id: string }).id).toBe('task-2');
  });

  it('claims successfully once the finalizing attempt reaches the closed phase', async () => {
    const held = await finalizingAttemptFor('worker-1');
    await expect(claim({ workerId: 'worker-1' })).rejects.toThrow(/finalizing/);

    // The retry the refusal promises — moe.finalize_attempt is what performs
    // this close in production.
    await setAttemptPhase(h.state, held.id, 'closed');
    const retried = await claim({ workerId: 'worker-1' });

    expect(retried.hasNext).toBe(true);
    expect((retried.task as { id: string }).id).toBe('task-2');
    expect(attemptsOf('task-1')).toEqual([[1, 'worker-1', 'closed']]);
  });

  it('keeps today\'s behaviour for a claim that names no worker', async () => {
    await finalizingAttemptFor('worker-1');

    // No worker id, so there is no worker whose seat could be held.
    const result = await claim({});

    expect(result.hasNext).toBe(true);
    expect((result.task as { id: string }).id).toBe('task-2');
  });
});
