import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { StateManager } from '../state/StateManager.js';
import { flushActivityLog } from '../state/activityLog.js';
import { completeTaskTool } from './completeTask.js';
import { qaApproveTool } from './qaApprove.js';
import { qaRejectTool } from './qaReject.js';
import { getActivityLogTool } from './getActivityLog.js';
import { getContextTool } from './getContext.js';
import type { ActivityEvent, Task, Worker } from '../types/schema.js';

describe('review-loop actor attribution', () => {
  let testDir: string;
  let moePath: string;
  let state: StateManager;
  const reviewEvents = ['TASK_COMPLETED', 'QA_REJECTED', 'QA_APPROVED'];

  function writeTaskAndWorkers(now: string) {
    const task: Task = {
      id: 'task-1', epicId: 'epic-1', title: 't', description: '', definitionOfDone: [], taskRails: [],
      implementationPlan: [{ stepId: 'step-1', description: 'first', status: 'COMPLETED', affectedFiles: [] }],
      status: 'WORKING', assignedWorkerId: 'worker-a', branch: null, prLink: null,
      reopenCount: 0, reopenReason: null, createdBy: 'HUMAN', parentTaskId: null,
      priority: 'MEDIUM', order: 1, comments: [], createdAt: now, updatedAt: now,
    };
    fs.writeFileSync(path.join(moePath, 'tasks', 'task-1.json'), JSON.stringify(task));
    for (const id of ['worker-a', 'qa-b']) {
      const worker: Worker = {
        id, type: 'CLAUDE', projectId: 'proj-test', epicId: '',
        currentTaskId: id === 'worker-a' ? 'task-1' : null,
        status: id === 'worker-a' ? 'CODING' : 'IDLE', branch: 'main', modifiedFiles: [],
        startedAt: now, lastActivityAt: now, lastError: null, errorCount: 0, teamId: null,
      };
      fs.writeFileSync(path.join(moePath, 'workers', `${id}.json`), JSON.stringify(worker));
    }
  }

  beforeEach(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moe-review-loop-actor-'));
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
    writeTaskAndWorkers(now);
    state = new StateManager({ projectPath: testDir });
    await state.load();
  });

  afterEach(async () => {
    await flushActivityLog(state);
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  async function assertSeatActivity(workerId: string, expected: string[]) {
    const result = await getActivityLogTool(state).handler({ workerId, limit: 100 }, state) as { events: ActivityEvent[] };
    const events = result.events.map((event) => event.event).filter((event) => reviewEvents.includes(event));
    expect.soft(events.sort(), `get_activity_log must return only ${workerId}'s review-loop events`)
      .toEqual([...expected].sort());
  }

  function assertGeneralNotices() {
    const general = state.getChannels().find((channel) => channel.name === 'general');
    if (!general) throw new Error('Missing #general channel');
    const notices = fs.readFileSync(path.join(moePath, 'messages', `${general.id}.jsonl`), 'utf8')
      .split('\n').filter(Boolean).map((line) => (JSON.parse(line) as { content: string }).content)
      .filter((content) => content.includes('Task moved to'));
    for (const [status, actor] of [['REVIEW', 'worker-a'], ['WORKING', 'qa-b'], ['DONE', 'qa-b']]) {
      expect.soft(notices, `${status} notice must name ${actor}`)
        .toContain(`task-1: Task moved to ${status} by ${actor}`);
    }
    expect.soft(notices.filter((notice) => notice.endsWith('by unknown')), 'No actor-less status notices').toEqual([]);
  }

  it('attributes review-loop events to the caller after the task is unassigned', async () => {
    await expect(completeTaskTool(state).handler({
      taskId: 'task-1', workerId: 'worker-a',
      verification: { command: 'npm test', exitCode: 0, outputTail: '12 passed' },
    }, state)).resolves.toMatchObject({ success: true, status: 'REVIEW' });
    // Stand in for the QA claim, keeping setup events attributable too.
    await state.updateTask('task-1', { assignedWorkerId: 'qa-b' }, undefined, 'qa-b');
    await getContextTool(state).handler({ taskId: 'task-1', workerId: 'qa-b' }, state);
    await expect(qaRejectTool(state).handler({
      taskId: 'task-1', workerId: 'qa-b', reason: 'step-1 misses the DoD edge case',
      rejectionDetails: {
        failedDodItems: ['edge case'],
        issues: [{ type: 'test_failure', description: 'edge case not covered' }],
      },
    }, state)).resolves.toMatchObject({ success: true, status: 'WORKING' });
    await state.updateTask('task-1', { status: 'REVIEW', assignedWorkerId: 'qa-b' }, undefined, 'qa-b');
    await getContextTool(state).handler({ taskId: 'task-1', workerId: 'qa-b' }, state);
    await expect(qaApproveTool(state).handler({
      taskId: 'task-1', workerId: 'qa-b', summary: 'All DoD items verified',
    }, state)).resolves.toMatchObject({ success: true, status: 'DONE' });
    await flushActivityLog(state);

    const events = state.getActivityLog(100).filter((event) => reviewEvents.includes(event.event));
    expect.soft(events.map((event) => event.event).sort(), 'Each review-loop event must occur exactly once')
      .toEqual([...reviewEvents].sort());
    expect.soft(Object.fromEntries(events.map((event) => [event.event, event.workerId])), 'Review-loop event actors')
      .toEqual({ TASK_COMPLETED: 'worker-a', QA_REJECTED: 'qa-b', QA_APPROVED: 'qa-b' });
    await assertSeatActivity('qa-b', ['QA_REJECTED', 'QA_APPROVED']);
    await assertSeatActivity('worker-a', ['TASK_COMPLETED']);
    assertGeneralNotices();
  });
});
