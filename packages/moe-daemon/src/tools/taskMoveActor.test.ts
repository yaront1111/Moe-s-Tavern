import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { StateManager } from '../state/StateManager.js';
import { flushActivityLog } from '../state/activityLog.js';
import { reportBlockedTool } from './reportBlocked.js';
import { requestReplanTool } from './requestReplan.js';
import { archiveTaskTool } from './archiveTask.js';
import { submitPlanCritiqueTool } from './submitPlanCritique.js';
import { getActivityLogTool } from './getActivityLog.js';
import type { ActivityEvent, Task, Worker } from '../types/schema.js';

// task-d981e0b0 threaded the caller into the review loop only. These four tools
// also move a row, and most of those moves clear the assignee, so without the
// caller as updateTask's actor the event had no workerId and #general read
// "by unknown".
describe('task-move actor attribution', () => {
  let testDir: string;
  let moePath: string;
  let state: StateManager;
  const moveEvents = ['TASK_BLOCKED', 'TASK_UPDATED', 'TASK_REOPENED', 'TASK_ARCHIVED'];
  // [taskId, status, assignee]: one row per write under test.
  const rows: Array<[string, Task['status'], string | null]> = [
    ['task-blk', 'WORKING', 'worker-a'], // report_blocked flip, seat-freeing arm
    ['task-fix', 'WORKING', 'worker-d'], // workerId-less park, then the assignee's correction
    ['task-grant', 'WORKING', 'worker-e'], // flip, then a correction riding a FREE resource
    ['task-rpl', 'WORKING', 'worker-b'], // request_replan
    ['task-arc', 'PLANNING', 'architect-c'], // archive_task by the PLANNING holder
    ['task-crit', 'AWAITING_APPROVAL', null], // a governor's block verdict
    ['task-anon', 'BACKLOG', null], // archive_task with no workerId
  ];
  // `${taskId} ${event}` -> actor. null: no workerId was passed, so none is guessed.
  const want: Record<string, string | null> = {
    'task-blk TASK_BLOCKED': 'worker-a',
    'task-fix TASK_BLOCKED': null,
    'task-fix TASK_UPDATED': 'worker-d',
    'task-grant TASK_BLOCKED': 'worker-e',
    'task-grant TASK_UPDATED': 'worker-e',
    'task-rpl TASK_REOPENED': 'worker-b',
    'task-arc TASK_ARCHIVED': 'architect-c',
    'task-crit TASK_UPDATED': 'governor-g',
    'task-anon TASK_ARCHIVED': null,
  };

  beforeEach(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moe-task-move-actor-'));
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
    for (const [id, status, assignee] of rows) {
      const task: Task = {
        id, epicId: 'epic-1', title: id, description: '', definitionOfDone: [], taskRails: [],
        implementationPlan: [{ stepId: 'step-1', description: 'first', status: 'PENDING', affectedFiles: [] }],
        status, assignedWorkerId: assignee, branch: null, prLink: null,
        reopenCount: 0, reopenReason: null, createdBy: 'HUMAN', parentTaskId: null,
        priority: 'MEDIUM', order: 1, comments: [], createdAt: now, updatedAt: now,
      };
      fs.writeFileSync(path.join(moePath, 'tasks', `${id}.json`), JSON.stringify(task));
      if (!assignee) continue;
      const worker: Worker = {
        id: assignee, type: 'CLAUDE', projectId: 'proj-test', epicId: '', currentTaskId: id,
        status: status === 'PLANNING' ? 'PLANNING' : 'CODING', branch: 'main', modifiedFiles: [],
        startedAt: now, lastActivityAt: now, lastError: null, errorCount: 0, teamId: null,
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

  const report = (args: Record<string, unknown>) => reportBlockedTool(state).handler(args, state);

  function generalMoveNotices(): string[] {
    const general = state.getChannels().find((channel) => channel.name === 'general');
    if (!general) throw new Error('Missing #general channel');
    return fs.readFileSync(path.join(moePath, 'messages', `${general.id}.jsonl`), 'utf8')
      .split('\n').filter(Boolean).map((line) => (JSON.parse(line) as { content: string }).content)
      .filter((content) => content.includes('Task moved to'));
  }

  it('records the calling seat on every move and names it in #general', async () => {
    await expect(report({ taskId: 'task-blk', workerId: 'worker-a', reason: 'waiting on the lease owner', blockedOnTaskIds: [] }))
      .resolves.toMatchObject({ success: true, taskStatus: 'BLOCKED', seatFreed: true });
    // A workerId-less (human/plugin) park keeps the hold; the assignee's
    // corrected re-report then frees its seat on the already-BLOCKED row.
    await expect(report({ taskId: 'task-fix', reason: 'owner decision pending', blockedOnTaskIds: [] }))
      .resolves.toMatchObject({ success: true, taskStatus: 'BLOCKED', seatFreed: false });
    await expect(report({ taskId: 'task-fix', workerId: 'worker-d', reason: 'owner decision pending: asked the owner', blockedOnTaskIds: [] }))
      .resolves.toMatchObject({ success: true, alreadyBlocked: true, reasonUpdated: true, seatFreed: true });
    await expect(report({ taskId: 'task-grant', workerId: 'worker-e', reason: 'STALE', blockedOnTaskIds: [] }))
      .resolves.toMatchObject({ success: true, taskStatus: 'BLOCKED', seatFreed: true });
    // bench-box has no holder, so the lease is granted and the correction rides it.
    await expect(report({ taskId: 'task-grant', workerId: 'worker-e', reason: 'CORRECTED', resourceId: 'bench-box' }))
      .resolves.toMatchObject({ success: true, granted: true, alreadyBlocked: true, reasonUpdated: true });
    await expect(requestReplanTool(state).handler({ taskId: 'task-rpl', workerId: 'worker-b', reason: 'plan step 2 names a file that does not exist' }, state))
      .resolves.toMatchObject({ success: true, status: 'PLANNING' });
    await expect(archiveTaskTool(state).handler({ taskId: 'task-arc', workerId: 'architect-c' }, state))
      .resolves.toMatchObject({ success: true, status: 'ARCHIVED' });
    await expect(submitPlanCritiqueTool(state).handler({
      taskId: 'task-crit', workerId: 'governor-g', verdict: 'block', category: 'size', concerns: ['plan exceeds the size cap'],
    }, state)).resolves.toMatchObject({ success: true, status: 'PLANNING', flipped: true });
    await expect(archiveTaskTool(state).handler({ taskId: 'task-anon' }, state))
      .resolves.toMatchObject({ success: true, status: 'ARCHIVED' });
    await flushActivityLog(state);

    const taskIds = new Set(rows.map(([id]) => id));
    const events = state.getActivityLog(500)
      .filter((event) => moveEvents.includes(event.event) && taskIds.has(event.taskId ?? ''));
    const keyOf = (event: ActivityEvent) => `${event.taskId} ${event.event}`;
    expect.soft(events.map(keyOf).sort(), 'Each move event must occur exactly once').toEqual(Object.keys(want).sort());
    expect.soft(Object.fromEntries(events.map((event) => [keyOf(event), event.workerId ?? null])), 'Move event actors')
      .toEqual(want);

    for (const seat of ['worker-a', 'worker-d', 'worker-e', 'worker-b', 'architect-c', 'governor-g']) {
      const result = await getActivityLogTool(state).handler({ workerId: seat, limit: 100 }, state) as { events: ActivityEvent[] };
      const got = result.events.filter((event) => moveEvents.includes(event.event)).map(keyOf).sort();
      const expected = Object.entries(want).filter(([, actor]) => actor === seat).map(([key]) => key).sort();
      expect.soft(got, `get_activity_log { workerId: ${seat} } must return that seat's moves`).toEqual(expected);
    }

    expect.soft(generalMoveNotices().sort(), '#general move lines').toEqual([
      'task-anon: Task moved to ARCHIVED by unknown',
      'task-arc: Task moved to ARCHIVED by architect-c',
      'task-blk: Task moved to BLOCKED by worker-a',
      'task-crit: Task moved to PLANNING by governor-g',
      'task-fix: Task moved to BLOCKED by worker-d',
      'task-grant: Task moved to BLOCKED by worker-e',
      'task-rpl: Task moved to PLANNING by worker-b',
    ]);
  });
});
