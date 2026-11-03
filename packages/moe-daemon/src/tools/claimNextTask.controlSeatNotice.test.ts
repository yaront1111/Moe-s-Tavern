// claim_next_task's two daemon posts that used to page seats for nothing:
//  1. the #workers file-collision heads-up on a REVIEW or PLANNING claim. In
//     worktree mode those seats work in the control checkout and land nothing, so
//     there is nothing to coordinate; a mention-less line in a role channel routes
//     to every busy seat.
//  2. the '<workerId> claimed task: <title>' notice, which parsed @tokens out of
//     the task title.
// The harness is copied from governanceFeatures.test.ts ('collision notice marks
// live peers and pages them'). The at-sign is built at runtime on purpose: no
// source line here may spell one.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { StateManager } from '../state/StateManager.js';
import { claimNextTaskTool } from './claimNextTask.js';
import { openAttempt } from '../state/attemptStore.js';
import type { Epic, Project, Task } from '../types/schema.js';

const AT = String.fromCharCode(64);

type Collision = { task: string; files: string[]; liveAssignee?: string };
type Claimed = { hasNext: boolean; fileCollision?: Collision[] };
type Heard = { channel: string; content: string; mentions: string[]; targets: string[] };

const LIVE_ENTRY: Collision[] = [{ task: 'task-live', files: ['src/foo.ts'], liveAssignee: 'worker-live' }];

describe('claim_next_task control-seat notices', () => {
  let testDir: string;
  let moePath: string;
  let state: StateManager;

  function setupMoe(): void {
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
    for (const id of ['epic-1', 'epic-2']) {
      fs.writeFileSync(path.join(moePath, 'epics', `${id}.json`), JSON.stringify({ ...epic, id }, null, 2));
    }
  }

  function writeTask(overrides: Partial<Task>): void {
    const now = new Date().toISOString();
    const task: Task = {
      id: 'task-1', epicId: 'epic-1', title: 'Test Task', description: 'desc',
      definitionOfDone: ['DoD1'], taskRails: [], implementationPlan: [],
      status: 'PLANNING', assignedWorkerId: null, branch: null, prLink: null,
      reopenCount: 0, reopenReason: null, createdBy: 'HUMAN', parentTaskId: null,
      priority: 'MEDIUM', order: 1, comments: [], createdAt: now, updatedAt: now,
      ...overrides,
    };
    fs.writeFileSync(path.join(moePath, 'tasks', `${task.id}.json`), JSON.stringify(task, null, 2));
  }

  const plan = (status: 'COMPLETED' | 'PENDING') => [{
    stepId: 'step-1', description: 'edit foo', status, affectedFiles: ['src/foo.ts'],
  }];

  // A live WORKING peer in its own epic that also names src/foo.ts, and the row
  // the control seat claims, whose completed plan names the same file.
  async function setup(status: 'REVIEW' | 'PLANNING', opts: { title?: string; worktreeMode?: 'on' } = {}): Promise<string> {
    setupMoe();
    const id = status === 'REVIEW' ? 'task-R' : 'task-P';
    writeTask({
      id: 'task-live', epicId: 'epic-2', status: 'WORKING', assignedWorkerId: 'worker-live',
      implementationPlan: plan('PENDING'),
    });
    writeTask({ id, epicId: 'epic-1', status, title: opts.title ?? 'Test Task', implementationPlan: plan('COMPLETED') });
    await state.load();
    await state.createWorker({
      id: 'worker-live', type: 'CLAUDE', projectId: 'proj-test', epicId: 'epic-2',
      currentTaskId: 'task-live', status: 'CODING',
    });
    if (opts.worktreeMode) await state.updateSettings({ worktreeMode: opts.worktreeMode });
    return id;
  }

  async function openPeerAttempt(workspaceMode: 'worktree' | 'shared'): Promise<void> {
    await openAttempt(state, {
      taskId: 'task-live', workerId: 'worker-live', runnerId: 'worker-live',
      workspace: path.join(testDir, '.worktrees', 'task-live'), workspaceMode,
    });
  }

  // Every message the claim posts, in any channel, whatever its wording.
  async function claim(workerId: string, status: 'REVIEW' | 'PLANNING', taskId: string): Promise<{ result: Claimed; heard: Heard[] }> {
    const names = new Map(state.getChannels().map((c) => [c.id, c.name]));
    const heard: Heard[] = [];
    const unsubscribe = state.subscribe((e) => {
      if (e.type !== 'MESSAGE_CREATED') return;
      heard.push({
        channel: names.get(e.payload.channel) ?? e.payload.channel,
        content: e.payload.content, mentions: e.payload.mentions, targets: e.routingTargets ?? [],
      });
    });
    try {
      const result = await claimNextTaskTool(state).handler({ workerId, statuses: [status], taskId }, state) as Claimed;
      return { result, heard };
    } finally {
      unsubscribe();
    }
  }

  const inWorkers = (heard: Heard[]): Heard[] => heard.filter((m) => m.channel === 'workers');

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moe-ctl-seat-'));
    moePath = path.join(testDir, '.moe');
    state = new StateManager({ projectPath: testDir });
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it.each([['worktree' as const], ['shared' as const]])(
    '(a) worktree mode: a REVIEW claim posts no #workers heads-up (peer attempt %s)',
    async (peerMode) => {
      const id = await setup('REVIEW', { worktreeMode: 'on' });
      await openPeerAttempt(peerMode);
      const { result, heard } = await claim('qa-1', 'REVIEW', id);

      expect(result.hasNext).toBe(true);
      expect(inWorkers(heard)).toEqual([]);
      expect(result.fileCollision).toEqual(LIVE_ENTRY);
      expect(state.getTask(id)!.assignedWorkerId).toBe('qa-1');
    }
  );

  it('(b) worktree mode: a PLANNING claim of a row with a plan posts no #workers heads-up', async () => {
    const id = await setup('PLANNING', { worktreeMode: 'on' });
    const { result, heard } = await claim('architect-1', 'PLANNING', id);

    expect(result.hasNext).toBe(true);
    expect(inWorkers(heard)).toEqual([]);
    expect(result.fileCollision).toEqual(LIVE_ENTRY);
    expect(state.getTask(id)!.assignedWorkerId).toBe('architect-1');
  });

  it('(c) worktreeMode unset (off): the same REVIEW claim pages as today', async () => {
    const id = await setup('REVIEW');
    const { result, heard } = await claim('qa-1', 'REVIEW', id);

    expect(result.fileCollision).toEqual(LIVE_ENTRY);
    const notices = inWorkers(heard);
    expect(notices).toHaveLength(1);
    expect(notices[0].mentions).toEqual(['worker-live', 'qa-1']);
    expect(notices[0].content.endsWith('Coordinate before either of you lands.')).toBe(true);
  });

  it('(d) an invalid worktreeMode never fails the claim and keeps the heads-up', async () => {
    const id = await setup('REVIEW');
    (state.project!.settings as Record<string, unknown>).worktreeMode = 'yes';
    const { result, heard } = await claim('qa-1', 'REVIEW', id);

    expect(result.hasNext).toBe(true);
    expect(result.fileCollision).toEqual(LIVE_ENTRY);
    expect(state.getTask(id)!.assignedWorkerId).toBe('qa-1');
    const notices = inWorkers(heard);
    expect(notices).toHaveLength(1);
    expect(notices[0].mentions).toEqual(['worker-live', 'qa-1']);
  });

  it('(e) the claim notice echoes the title without parsing an at-token out of it', async () => {
    const title = `Handle ${AT}mentions in titles`;
    const id = await setup('REVIEW', { title });
    const { heard } = await claim('qa-1', 'REVIEW', id);

    const notices = heard.filter((m) => m.channel === 'general' && m.content.includes('claimed task:'));
    expect(notices).toHaveLength(1);
    expect(notices[0].content).toBe(`qa-1 claimed task: ${title}`);
    expect(notices[0].mentions).toEqual([]);
    expect(notices[0].targets).toEqual([]);
  });
});
