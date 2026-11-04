// A REVIEW row the qa_reject hard cap parked for a human (needsHumanReview,
// unassigned) is a human's call. claim_next_task already fences it; the verdict
// tools, release_task's unpark and get_context's hint must not open it to an
// agent seat either. The workerId-less human path stays open.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { StateManager } from '../state/StateManager.js';
import { qaRejectTool } from './qaReject.js';
import { qaApproveTool } from './qaApprove.js';
import { claimNextTaskTool } from './claimNextTask.js';
import { releaseTaskTool } from './releaseTask.js';
import { getContextTool } from './getContext.js';
import { MoeErrorCode } from '../util/errors.js';
import type { Task, Epic, Project, WorkerStatus } from '../types/schema.js';

describe('a REVIEW row parked for a human refuses agent seats', () => {
  let testDir: string;
  let moePath: string;
  let state: StateManager;

  function setupMoe() {
    fs.mkdirSync(moePath, { recursive: true });
    for (const sub of ['epics', 'tasks', 'workers', 'proposals']) fs.mkdirSync(path.join(moePath, sub));
    const now = new Date().toISOString();
    const project: Partial<Project> = {
      id: 'proj-test', schemaVersion: 6, name: 'Test', rootPath: testDir,
      globalRails: { techStack: [], forbiddenPatterns: [], requiredPatterns: [], formatting: '', testing: '', customRules: [] },
      settings: {
        approvalMode: 'TURBO', speedModeDelayMs: 2000, autoCreateBranch: false,
        branchPattern: '', commitPattern: '', agentCommand: 'claude', enableAgentTeams: false,
      },
      createdAt: now, updatedAt: now,
    };
    fs.writeFileSync(path.join(moePath, 'project.json'), JSON.stringify(project, null, 2));
    const epic: Epic = {
      id: 'epic-1', projectId: 'proj-test', title: '', description: '', architectureNotes: '',
      epicRails: [], status: 'ACTIVE', order: 1, createdAt: now, updatedAt: now,
    };
    fs.writeFileSync(path.join(moePath, 'epics', 'epic-1.json'), JSON.stringify(epic, null, 2));
  }

  function writeTask(overrides: Partial<Task> = {}): void {
    const now = new Date().toISOString();
    const task: Task = {
      id: 'task-1', epicId: 'epic-1', title: 't', description: '',
      definitionOfDone: ['DoD-A'], taskRails: [], implementationPlan: [],
      status: 'REVIEW', assignedWorkerId: 'qa-a', branch: null, prLink: null,
      reopenCount: 3, reopenReason: null, createdBy: 'HUMAN', parentTaskId: null,
      priority: 'MEDIUM', order: 1, comments: [], contextFetchedBy: ['qa-a'],
      createdAt: now, updatedAt: now,
      ...overrides,
    };
    fs.writeFileSync(path.join(moePath, 'tasks', `${task.id}.json`), JSON.stringify(task, null, 2));
  }

  const createWorker = (id: string, status: WorkerStatus, currentTaskId: string | null) =>
    state.createWorker({ id, type: 'CLAUDE', projectId: 'proj-test', epicId: 'epic-1', currentTaskId, status });
  const taskFile = () => fs.readFileSync(path.join(moePath, 'tasks', 'task-1.json'), 'utf8');
  const verdictFields = () => {
    const t = state.getTask('task-1')!;
    return {
      status: t.status, assignedWorkerId: t.assignedWorkerId, reopenCount: t.reopenCount,
      needsHumanReview: t.needsHumanReview, rejections: t.rejectionHistory?.length ?? 0,
    };
  };
  const PARKED = { status: 'REVIEW', assignedWorkerId: null, reopenCount: 4, needsHumanReview: true, rejections: 1 };

  // The real hard-cap path: reopenCount 3 -> 4 past maxReopens parks the row.
  // qa-b is a QA seat busy on its own claim (task-2); it never claimed or read task-1.
  async function park() {
    setupMoe();
    writeTask();
    writeTask({ id: 'task-2', order: 2, assignedWorkerId: 'qa-b', contextFetchedBy: ['qa-b'], reopenCount: 0 });
    await state.load();
    await createWorker('qa-a', 'CODING', 'task-1');
    await createWorker('qa-b', 'CODING', 'task-2');
    const parked = await qaRejectTool(state).handler(
      { taskId: 'task-1', reason: 're-plan did not help either', workerId: 'qa-a' }, state,
    ) as { status: string; parkedForHuman: boolean };
    expect(parked).toMatchObject({ status: 'REVIEW', parkedForHuman: true });
    expect(verdictFields()).toEqual(PARKED);
    // The existing claim fence, for contrast (an idle seat; qa-b holds task-2).
    await createWorker('qa-c', 'IDLE', null);
    await expect(
      claimNextTaskTool(state).handler({ statuses: ['REVIEW'], taskId: 'task-1', workerId: 'qa-c' }, state),
    ).rejects.toMatchObject({ code: MoeErrorCode.NOT_ALLOWED });
  }

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moe-parked-review-'));
    moePath = path.join(testDir, '.moe');
    state = new StateManager({ projectPath: testDir });
  });
  afterEach(() => { fs.rmSync(testDir, { recursive: true, force: true }); });

  it.each(['qa-b', 'governor-x'])('qa_approve and qa_reject from %s are refused NOT_ALLOWED and change nothing', async (seat) => {
    await park();
    if (seat !== 'qa-b') await createWorker(seat, 'IDLE', null);
    const before = taskFile();
    await expect(qaApproveTool(state).handler({ taskId: 'task-1', summary: 'looks fine', workerId: seat }, state))
      .rejects.toMatchObject({ code: MoeErrorCode.NOT_ALLOWED, codeName: 'NOT_ALLOWED', message: expect.stringContaining('parked for human review') });
    await expect(qaRejectTool(state).handler({ taskId: 'task-1', reason: 'still bad', workerId: seat }, state))
      .rejects.toMatchObject({ code: MoeErrorCode.NOT_ALLOWED, codeName: 'NOT_ALLOWED', message: expect.stringContaining('parked for human review') });
    expect(verdictFields()).toEqual(PARKED);
    expect(taskFile()).toBe(before);
    // No touchWorker on the refused caller: qa-b keeps its own claim.
    expect(state.getWorker('qa-b')).toMatchObject({ status: 'CODING', currentTaskId: 'task-2' });
  });

  it('release_task from a seat is refused NOT_ALLOWED and the row stays parked', async () => {
    await park();
    await createWorker('worker-x', 'IDLE', null);
    const before = taskFile();
    await expect(releaseTaskTool(state).handler(
      { taskId: 'task-1', reason: 'cleanup', handoffNote: { whatIsDone: 'parked review', whatRemains: 'a human decision' }, workerId: 'worker-x' }, state,
    )).rejects.toMatchObject({ code: MoeErrorCode.NOT_ALLOWED, codeName: 'NOT_ALLOWED', message: expect.stringContaining('parked for human review') });
    expect(verdictFields()).toEqual(PARKED);
    expect(taskFile()).toBe(before);
  });

  it('get_context gives a QA seat no qa_approve hint on the parked row', async () => {
    await park();
    const ctx = await getContextTool(state).handler({ taskId: 'task-1', workerId: 'qa-b' }, state) as { nextAction?: { tool?: string } };
    expect(ctx.nextAction?.tool).not.toBe('moe.qa_approve');
    expect(verdictFields()).toEqual(PARKED);
  });

  it('the human path (no workerId) still approves, or releases back into the QA queue', async () => {
    await park();
    const released = await releaseTaskTool(state).handler({ taskId: 'task-1', reason: 'human unpark' }, state) as { success: boolean };
    expect(released.success).toBe(true);
    expect(state.getTask('task-1')!.needsHumanReview).toBe(false);
    await state.updateTask('task-1', { needsHumanReview: true });
    const approved = await qaApproveTool(state).handler({ taskId: 'task-1', summary: 'human reviewed the attempt' }, state) as { status: string };
    expect(approved.status).toBe('DONE');
    expect(state.getTask('task-1')!.needsHumanReview).toBeUndefined();
  });

  it('an unparked unassigned REVIEW row keeps the legacy seat path (only the park is fenced)', async () => {
    setupMoe();
    writeTask({ assignedWorkerId: null, reopenCount: 0, contextFetchedBy: [] });
    await state.load();
    await createWorker('qa-b', 'IDLE', null);
    const ctx = await getContextTool(state).handler({ taskId: 'task-1', workerId: 'qa-b' }, state) as { nextAction?: { tool?: string } };
    expect(ctx.nextAction?.tool).toBe('moe.qa_approve');
    const approved = await qaApproveTool(state).handler({ taskId: 'task-1', summary: 'reviewed', workerId: 'qa-b' }, state) as { status: string };
    expect(approved.status).toBe('DONE');
  });
});
