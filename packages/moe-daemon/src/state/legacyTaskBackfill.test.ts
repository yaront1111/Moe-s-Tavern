// A task file written before reopenCount existed (the 2026-02 bug-* imports
// still on the board) loads with reopenCount 0, as createTask defaults it, so
// every reopen path's `reopenCount + 1` stays a number and a human can
// un-archive the row. Like the priority and comments backfills beside it, this
// one is in memory only: load never rewrites a task file.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { StateManager } from './StateManager.js';
import { setTaskStatusTool } from '../tools/setTaskStatus.js';

describe('StateManager.load backfills a legacy reopenCount', () => {
  let testDir: string;
  let moePath: string;
  let state: StateManager;
  const now = new Date().toISOString();
  const taskFile = (id: string) => path.join(moePath, 'tasks', `${id}.json`);
  // The live legacy shape: no reopenCount, definitionOfDone or taskRails keys.
  const writeLegacy = (id: string, extra: Record<string, unknown> = {}) =>
    fs.writeFileSync(taskFile(id), JSON.stringify({
      id, epicId: 'epic-1', title: id, description: '', status: 'ARCHIVED', order: 1, implementationPlan: [],
      createdAt: now, updatedAt: now, assignedWorkerId: null, priority: 'MEDIUM', comments: [], ...extra,
    }, null, 2));

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moe-legacy-backfill-'));
    moePath = path.join(testDir, '.moe');
    for (const sub of ['epics', 'tasks', 'workers', 'proposals']) fs.mkdirSync(path.join(moePath, sub), { recursive: true });
    fs.writeFileSync(path.join(moePath, 'project.json'), JSON.stringify({
      id: 'proj-test', name: 'Test', rootPath: testDir,
      globalRails: { techStack: [], forbiddenPatterns: [], requiredPatterns: [], formatting: '', testing: '', customRules: [] },
      settings: { approvalMode: 'TURBO', speedModeDelayMs: 2000, autoCreateBranch: false, branchPattern: '', commitPattern: '', agentCommand: 'claude' },
      createdAt: now, updatedAt: now,
    }, null, 2));
    fs.writeFileSync(path.join(moePath, 'epics', 'epic-1.json'), JSON.stringify({
      id: 'epic-1', projectId: 'proj-test', title: 'E', description: '', architectureNotes: '',
      epicRails: [], status: 'ACTIVE', order: 1, createdAt: now, updatedAt: now,
    }, null, 2));
    state = new StateManager({ projectPath: testDir });
  });
  afterEach(() => { fs.rmSync(testDir, { recursive: true, force: true }); });

  it('a missing, null or invalid reopenCount loads as 0, a valid one is kept, and no task file is rewritten', async () => {
    const rows: Record<string, Record<string, unknown>> = {
      'task-missing': {}, 'task-null': { reopenCount: null }, 'task-negative': { reopenCount: -1 },
      'task-fraction': { reopenCount: 1.5 }, 'task-string': { reopenCount: '2' }, 'task-kept': { reopenCount: 3 },
    };
    for (const [id, extra] of Object.entries(rows)) writeLegacy(id, extra);
    const before = Object.fromEntries(Object.keys(rows).map((id) => [id, fs.readFileSync(taskFile(id), 'utf8')]));
    await state.load();
    expect(Object.fromEntries(Object.keys(rows).map((id) => [id, state.getTask(id)?.reopenCount]))).toEqual({
      'task-missing': 0, 'task-null': 0, 'task-negative': 0, 'task-fraction': 0, 'task-string': 0, 'task-kept': 3,
    });
    for (const id of Object.keys(rows)) expect(fs.readFileSync(taskFile(id), 'utf8')).toBe(before[id]);
  });

  it.each([['no reopenCount key', {}], ['reopenCount null', { reopenCount: null }]])(
    'set_task_status un-archives a row with %s to BACKLOG and stores reopenCount 1',
    async (_label, extra) => {
      writeLegacy('task-legacy', extra);
      await state.load();
      await setTaskStatusTool(state).handler({ taskId: 'task-legacy', status: 'BACKLOG', reason: 'revive' }, state);
      expect(state.getTask('task-legacy')).toMatchObject({ status: 'BACKLOG', reopenCount: 1, reopenReason: 'revive' });
      expect(JSON.parse(fs.readFileSync(taskFile('task-legacy'), 'utf8'))).toMatchObject({ status: 'BACKLOG', reopenCount: 1 });
    },
  );
});
