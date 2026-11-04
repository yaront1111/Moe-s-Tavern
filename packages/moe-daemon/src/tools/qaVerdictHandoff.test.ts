// qa_approve and qa_reject idle the seat that held the reviewed row. On an
// unassigned REVIEW row any seat may give the verdict (assertWorkerOwns no-ops
// there), and the caller counts as that seat only when its own currentTaskId is
// the reviewed row: a seat busy on another task keeps its claim (hunt #15,
// /mnt/d/moe-scratch/hunt-928a468d/A/sideLeads.test.ts case 2).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { StateManager } from '../state/StateManager.js';
import { qaApproveTool } from './qaApprove.js';
import { qaRejectTool } from './qaReject.js';
import type { Task, Epic, Project, WorkerStatus } from '../types/schema.js';

type Verdict = 'qa_approve' | 'qa_reject';
// Each verdict with the status it lands an unparked, first-round row in.
const VERDICTS: Array<[Verdict, string]> = [['qa_approve', 'DONE'], ['qa_reject', 'WORKING']];

describe('a QA verdict idles only the seat that held the reviewed row', () => {
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

  // task-1 defaults to the unassigned REVIEW row under review.
  function writeTask(overrides: Partial<Task> = {}): void {
    const now = new Date().toISOString();
    const task: Task = {
      id: 'task-1', epicId: 'epic-1', title: 't', description: '',
      definitionOfDone: ['DoD-A'], taskRails: [], implementationPlan: [],
      status: 'REVIEW', assignedWorkerId: null, branch: null, prLink: null,
      reopenCount: 0, reopenReason: null, createdBy: 'HUMAN', parentTaskId: null,
      priority: 'MEDIUM', order: 1, comments: [], contextFetchedBy: [],
      createdAt: now, updatedAt: now,
      ...overrides,
    };
    fs.writeFileSync(path.join(moePath, 'tasks', `${task.id}.json`), JSON.stringify(task, null, 2));
  }

  const createWorker = (id: string, status: WorkerStatus, currentTaskId: string | null) =>
    state.createWorker({ id, type: 'CLAUDE', projectId: 'proj-test', epicId: 'epic-1', currentTaskId, status });
  const seat = (id: string) => {
    const w = state.getWorker(id)!;
    return { status: w.status, currentTaskId: w.currentTaskId };
  };
  const verdict = (tool: Verdict, workerId?: string) => (tool === 'qa_approve'
    ? qaApproveTool(state).handler({ taskId: 'task-1', summary: 'verified DoD-A', ...(workerId ? { workerId } : {}) }, state)
    : qaRejectTool(state).handler({ taskId: 'task-1', reason: 'DoD-A fails', ...(workerId ? { workerId } : {}) }, state)
  ) as Promise<{ status: string }>;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moe-qa-handoff-'));
    moePath = path.join(testDir, '.moe');
    state = new StateManager({ projectPath: testDir });
  });
  afterEach(() => { fs.rmSync(testDir, { recursive: true, force: true }); });

  it.each(VERDICTS)('%s on an unassigned row leaves a caller that holds another task on its own claim', async (tool, landed) => {
    setupMoe();
    writeTask();
    writeTask({ id: 'task-2', order: 2, assignedWorkerId: 'qa-b', contextFetchedBy: ['qa-b'] });
    await state.load();
    await createWorker('qa-b', 'CODING', 'task-2');

    expect((await verdict(tool, 'qa-b')).status).toBe(landed);
    expect(state.getTask('task-2')!.assignedWorkerId).toBe('qa-b');
    expect(seat('qa-b')).toEqual({ status: 'CODING', currentTaskId: 'task-2' });
  });

  it.each(VERDICTS)('%s on an unassigned row still idles a caller whose own pointer is on that row', async (tool, landed) => {
    setupMoe();
    writeTask();
    await state.load();
    await createWorker('qa-c', 'CODING', 'task-1');

    expect((await verdict(tool, 'qa-c')).status).toBe(landed);
    expect(seat('qa-c')).toEqual({ status: 'IDLE', currentTaskId: null });
  });

  it.each(VERDICTS)('%s with no workerId on an assigned row idles that row\'s assignee and no one else', async (tool, landed) => {
    setupMoe();
    writeTask({ assignedWorkerId: 'qa-a', contextFetchedBy: ['qa-a'] });
    writeTask({ id: 'task-2', order: 2, assignedWorkerId: 'qa-b', contextFetchedBy: ['qa-b'] });
    await state.load();
    await createWorker('qa-a', 'CODING', 'task-1');
    await createWorker('qa-b', 'CODING', 'task-2');

    expect((await verdict(tool)).status).toBe(landed);
    expect(state.getTask('task-1')!.assignedWorkerId).toBeNull();
    expect(seat('qa-a')).toEqual({ status: 'IDLE', currentTaskId: null });
    expect(seat('qa-b')).toEqual({ status: 'CODING', currentTaskId: 'task-2' });
  });
});
