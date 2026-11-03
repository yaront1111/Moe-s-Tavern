// task-e977c32b: modeled on tools/reviewLoopActor.test.ts.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { StateManager } from '../state/StateManager.js';
import { flushActivityLog } from '../state/activityLog.js';
import { addCommentTool } from './addComment.js';
import { amendPlanStepTool } from './amendPlanStep.js';
import { releaseTaskTool } from './releaseTask.js';
import { getActivityLogTool } from './getActivityLog.js';
import type { ActivityEvent, ImplementationStep, Task, Worker } from '../types/schema.js';

describe('task-event actor attribution (add_comment, amend_plan_step, release_task)', () => {
  let testDir: string;
  let moePath: string;
  let state: StateManager;
  const actorEvents = ['TASK_COMMENT_ADDED', 'TASK_UPDATED', 'WORKER_RELEASED'];
  const done: ImplementationStep[] = [{ stepId: 'step-1', description: 'only', status: 'COMPLETED', affectedFiles: [] }];
  const rows: Array<[string, string | null, ImplementationStep[]]> = [
    ['task-c', 'worker-a', [{ stepId: 'step-1', description: 'first', status: 'PENDING', affectedFiles: [] }]],
    ['task-rel', 'worker-r', done],
    ['task-fix', null, done],
    ['task-anon', 'worker-s', done],
    ['task-anon-fix', null, done],
  ];

  beforeEach(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moe-task-event-actor-'));
    moePath = path.join(testDir, '.moe');
    for (const sub of ['epics', 'tasks', 'workers', 'proposals', 'teams', 'channels', 'messages']) {
      fs.mkdirSync(path.join(moePath, sub), { recursive: true });
    }
    const now = new Date().toISOString();
    fs.writeFileSync(path.join(moePath, 'project.json'), JSON.stringify({
      id: 'proj-test', schemaVersion: 6, name: 'Test', rootPath: testDir,
      globalRails: { techStack: [], forbiddenPatterns: [], requiredPatterns: [], formatting: '', testing: '', customRules: [] },
      settings: {
        approvalMode: 'TURBO', speedModeDelayMs: 2000, autoCreateBranch: false,
        branchPattern: '', commitPattern: '', agentCommand: 'claude', enableAgentTeams: false,
      },
      createdAt: now, updatedAt: now,
    }));
    fs.writeFileSync(path.join(moePath, 'epics', 'epic-1.json'), JSON.stringify({
      id: 'epic-1', projectId: 'proj-test', title: '', description: '', architectureNotes: '',
      epicRails: [], status: 'ACTIVE', order: 1, createdAt: now, updatedAt: now,
    }));
    for (const [id, assignee, plan] of rows) {
      const task: Task = {
        id, epicId: 'epic-1', title: id, description: '', definitionOfDone: [], taskRails: [],
        implementationPlan: plan, status: 'WORKING', assignedWorkerId: assignee, branch: null, prLink: null,
        reopenCount: 0, reopenReason: null, createdBy: 'HUMAN', parentTaskId: null,
        priority: 'MEDIUM', order: 1, comments: [], createdAt: now, updatedAt: now,
      };
      fs.writeFileSync(path.join(moePath, 'tasks', `${id}.json`), JSON.stringify(task));
      if (!assignee) continue;
      const worker: Worker = {
        id: assignee, type: 'CLAUDE', projectId: 'proj-test', epicId: '', currentTaskId: id,
        status: 'CODING', branch: 'main', modifiedFiles: [], startedAt: now, lastActivityAt: now,
        lastError: null, errorCount: 0, teamId: null,
      };
      fs.writeFileSync(path.join(moePath, 'workers', `${assignee}.json`), JSON.stringify(worker));
    }
    state = new StateManager({ projectPath: testDir });
    await state.load();
  });

  afterEach(async () => {
    await flushActivityLog(state);
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  function actorsOf(event: string, taskId: string): Array<string | null> {
    return state.getActivityLog(200)
      .filter((e) => e.event === event && e.taskId === taskId)
      .map((e) => e.workerId ?? null);
  }

  async function seatEvents(workerId: string): Promise<string[]> {
    const result = await getActivityLogTool(state).handler({ workerId, limit: 100 }, state) as { events: ActivityEvent[] };
    return result.events.filter((e) => actorEvents.includes(e.event)).map((e) => `${e.event} ${e.taskId}`).sort();
  }

  function moveNotices(): string[] {
    const general = state.getChannels().find((channel) => channel.name === 'general');
    if (!general) throw new Error('Missing #general channel');
    return fs.readFileSync(path.join(moePath, 'messages', `${general.id}.jsonl`), 'utf8')
      .split('\n').filter(Boolean).map((line) => (JSON.parse(line) as { content: string }).content)
      .filter((content) => content.includes('Task moved to'));
  }

  it('records the calling seat on each event and names it in the REVIEW notice', async () => {
    await expect(addCommentTool(state).handler({
      taskId: 'task-c', workerId: 'worker-a', content: 'Does step-1 cover the empty list?',
    }, state)).resolves.toMatchObject({ success: true });
    await expect(amendPlanStepTool(state).handler({
      taskId: 'task-c', stepId: 'step-1', workerId: 'architect-z',
      description: 'first, and cover the empty list', reason: 'the empty list was missing',
    }, state)).resolves.toMatchObject({ success: true });
    await expect(releaseTaskTool(state).handler({ taskId: 'task-rel', workerId: 'worker-r' }, state))
      .resolves.toMatchObject({ success: true, status: 'REVIEW', releasedBy: 'worker-r' });
    await expect(releaseTaskTool(state).handler({ taskId: 'task-fix', workerId: 'governor-g' }, state))
      .resolves.toMatchObject({ success: true, status: 'REVIEW' });
    await flushActivityLog(state);

    expect.soft(actorsOf('TASK_COMMENT_ADDED', 'task-c'), 'TASK_COMMENT_ADDED actor').toEqual(['worker-a']);
    expect.soft(actorsOf('TASK_UPDATED', 'task-c'), 'amend TASK_UPDATED actor').toEqual(['architect-z']);
    expect.soft(actorsOf('WORKER_RELEASED', 'task-rel'), 'holder release actor').toEqual(['worker-r']);
    expect.soft(actorsOf('WORKER_RELEASED', 'task-fix'), 'repair release actor').toEqual(['governor-g']);
    const seats: Array<[string, string[]]> = [
      ['worker-a', ['TASK_COMMENT_ADDED task-c']],
      ['architect-z', ['TASK_UPDATED task-c']],
      ['worker-r', ['WORKER_RELEASED task-rel']],
      ['governor-g', ['WORKER_RELEASED task-fix']],
    ];
    for (const [seat, expected] of seats) {
      expect.soft(await seatEvents(seat), `get_activity_log { workerId: ${seat} }`).toEqual(expected);
    }
    expect.soft(moveNotices(), '#general move notices').toEqual([
      'task-rel: Task moved to REVIEW by worker-r',
      'task-fix: Task moved to REVIEW by governor-g',
    ]);
  });

  it('records no actor for caller-less calls and keeps the notice fallback', async () => {
    await expect(addCommentTool(state).handler({ taskId: 'task-c', content: 'posted with no seat id' }, state))
      .resolves.toMatchObject({ success: true });
    await expect(releaseTaskTool(state).handler({ taskId: 'task-anon' }, state))
      .resolves.toMatchObject({ success: true, status: 'REVIEW', releasedBy: 'unknown' });
    await expect(releaseTaskTool(state).handler({ taskId: 'task-anon-fix' }, state))
      .resolves.toMatchObject({ success: true, status: 'REVIEW' });
    await flushActivityLog(state);

    expect.soft(actorsOf('TASK_COMMENT_ADDED', 'task-c'), 'caller-less comment actor').toEqual([null]);
    expect.soft(actorsOf('WORKER_RELEASED', 'task-anon'), 'caller-less release actor').toEqual([null]);
    expect.soft(actorsOf('WORKER_RELEASED', 'task-anon-fix'), 'caller-less repair actor').toEqual([null]);
    for (const seat of ['unknown', 'agent']) {
      expect.soft(await seatEvents(seat), `get_activity_log { workerId: ${seat} }`).toEqual([]);
    }
    expect.soft(moveNotices(), '#general move notices').toEqual([
      'task-anon: Task moved to REVIEW by unknown',
      'task-anon-fix: Task moved to REVIEW by unknown',
    ]);
  });
});
