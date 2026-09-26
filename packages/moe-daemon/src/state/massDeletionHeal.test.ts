// A repo-wide `git clean -fdx` deleted px4swarm's whole gitignored .moe store on
// 2026-09-26 and the FileWatcher reloaded the empty disk over the in-memory board.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { StateManager } from './StateManager.js';
import { healMassDeletion } from './massDeletionHeal.js';

describe('healMassDeletion', () => {
  let testDir: string;
  let moePath: string;
  let state: StateManager;
  const taskIds = Array.from({ length: 10 }, (_, i) => `task-heal${i}`);

  beforeEach(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moe-heal-'));
    moePath = path.join(testDir, '.moe');
    for (const dir of ['epics', 'tasks', 'workers', 'proposals']) fs.mkdirSync(path.join(moePath, dir), { recursive: true });
    const now = new Date().toISOString();
    fs.writeFileSync(path.join(moePath, 'project.json'), JSON.stringify({
      id: 'proj-heal', name: 'Heal', rootPath: testDir,
      globalRails: { techStack: [], forbiddenPatterns: [], requiredPatterns: [], formatting: '', testing: '', customRules: [] },
      settings: { approvalMode: 'CONTROL', speedModeDelayMs: 2000, autoCreateBranch: false, branchPattern: 'moe/{epicId}/{taskId}', commitPattern: 'feat({epicId}): {taskTitle}', agentCommand: 'claude' },
      createdAt: now, updatedAt: now,
    }));
    fs.writeFileSync(path.join(moePath, 'epics', 'epic-heal.json'), JSON.stringify({
      id: 'epic-heal', projectId: 'proj-heal', title: 'E', description: '', architectureNotes: '', epicRails: [],
      status: 'ACTIVE', order: 1, createdAt: now, updatedAt: now,
    }));
    for (const [i, id] of taskIds.entries()) {
      fs.writeFileSync(path.join(moePath, 'tasks', `${id}.json`), JSON.stringify({
        id, epicId: 'epic-heal', title: `Task ${i}`, description: 'd', definitionOfDone: ['x'], taskRails: [],
        implementationPlan: [], status: 'BACKLOG', assignedWorkerId: null, branch: null, prLink: null, reopenCount: 0,
        reopenReason: null, createdBy: 'HUMAN', parentTaskId: null, priority: 'MEDIUM', order: i, comments: [],
        createdAt: now, updatedAt: now,
      }));
    }
    state = new StateManager({ projectPath: testDir });
    await state.load();
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  const onDisk = (id: string) => path.join(moePath, 'tasks', `${id}.json`);

  it('rewrites a wiped store from memory instead of letting a reload empty the board', async () => {
    fs.rmSync(path.join(moePath, 'tasks'), { recursive: true, force: true });
    fs.rmSync(path.join(moePath, 'epics'), { recursive: true, force: true });

    expect(await healMassDeletion(state)).toBe(11);
    for (const id of taskIds) expect(JSON.parse(fs.readFileSync(onDisk(id), 'utf-8')).id).toBe(id);
    expect(fs.existsSync(path.join(moePath, 'epics', 'epic-heal.json'))).toBe(true);

    await state.load(); // what the FileWatcher does next: the board must survive it
    expect(state.tasks.size).toBe(10);
  });

  it('leaves a small deliberate deletion to the normal reload', async () => {
    fs.rmSync(onDisk(taskIds[0]));

    expect(await healMassDeletion(state)).toBe(0);
    expect(fs.existsSync(onDisk(taskIds[0]))).toBe(false);
  });

  it('does nothing when every known entity is on disk', async () => {
    expect(await healMassDeletion(state)).toBe(0);
  });
});
