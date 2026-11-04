// A repo-wide `git clean -fdx` deleted px4swarm's whole gitignored .moe store on
// 2026-09-26 and the FileWatcher reloaded the empty disk over the in-memory board.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { StateManager } from './StateManager.js';
import { healMassDeletion, MASS_DELETION_FRACTION, MASS_DELETION_MIN } from './massDeletionHeal.js';
import { acquireResource } from './resourceStore.js';
import { openAttempt } from './attemptStore.js';
import type { RailProposal } from '../types/schema.js';

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

// A project on the wrappers' default settings.commitBoardState commits .moe/tasks and
// .moe/epics, so `git clean -fdx` / `git stash --all` removes only the ignored runtime
// dirs. Counted with the board, the loss is 8 of 59 (13.6%): under the combined 20% rule,
// so the FileWatcher's reload used to replace every runtime map with an empty one.
describe('healMassDeletion on a board-tracking project (runtime dirs wiped, board kept)', () => {
  const RUNTIME_DIRS = ['workers', 'teams', 'proposals', 'resources', 'attempts'] as const;
  type RuntimeDir = (typeof RUNTIME_DIRS)[number];
  const taskIds = Array.from({ length: 50 }, (_, i) => `task-board${i}`);
  const workerIds = Array.from({ length: 4 }, (_, i) => `worker-board${i}`);
  const proposalIds = Array.from({ length: 3 }, (_, i) => `proposal-board${i}`);

  let testDir: string;
  let moePath: string;
  let state: StateManager;
  let before: Record<RuntimeDir, Array<[string, unknown]>>;

  // JSON round trip: what a reload returns from disk is the comparison baseline.
  const entriesOf = (dir: RuntimeDir): Array<[string, unknown]> =>
    JSON.parse(JSON.stringify([...(state[dir] as Map<string, unknown>).entries()]));
  const fileOf = (dir: RuntimeDir, id: string) => path.join(moePath, dir, `${id}.json`);

  function proposal(id: string): RailProposal {
    return {
      id, workerId: workerIds[0], taskId: taskIds[0], proposalType: 'ADD_RAIL', targetScope: 'GLOBAL',
      currentValue: null, proposedValue: `Rail ${id}`, reason: 'heal fixture', status: 'PENDING',
      resolvedAt: null, resolvedBy: null, createdAt: new Date().toISOString(),
    };
  }

  beforeEach(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moe-heal-board-'));
    moePath = path.join(testDir, '.moe');
    for (const dir of ['epics', 'tasks']) fs.mkdirSync(path.join(moePath, dir), { recursive: true });
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

    for (const id of workerIds) {
      await state.createWorker({ id, type: 'CLAUDE', projectId: 'proj-heal', epicId: 'epic-heal', currentTaskId: null, status: 'IDLE' });
    }
    await state.createTeam({ name: 'team-heal', role: 'worker' });
    for (const id of proposalIds) await state.createProposal(proposal(id));
    const lease = await acquireResource(state, { resourceId: 'box-heal', taskId: taskIds[0], workerId: workerIds[0] });
    expect(lease.granted).toBe(true);
    await openAttempt(state, { taskId: taskIds[1], workerId: workerIds[1], runnerId: workerIds[1], workspace: testDir });

    before = Object.fromEntries(RUNTIME_DIRS.map((dir) => [dir, entriesOf(dir)])) as typeof before;
    expect(RUNTIME_DIRS.map((dir) => before[dir].length)).toEqual([4, 1, 3, 1, 1]);
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('(w) rewrites every wiped runtime kind from memory so the FileWatcher reload keeps them', async () => {
    for (const dir of RUNTIME_DIRS) fs.rmSync(path.join(moePath, dir), { recursive: true, force: true });

    expect(await healMassDeletion(state)).toBe(10); // 4 workers + 1 team + 3 proposals + 1 resource + 1 attempt
    for (const dir of RUNTIME_DIRS) {
      for (const [id, entity] of before[dir]) {
        expect(JSON.parse(fs.readFileSync(fileOf(dir, id), 'utf-8'))).toEqual(entity);
      }
    }

    await state.load(); // what the FileWatcher does next: the runtime maps must survive it
    for (const dir of RUNTIME_DIRS) expect(entriesOf(dir)).toEqual(before[dir]);
    expect(state.tasks.size).toBe(50);
    expect(state.resources.get('box-heal')?.holders.map((h) => h.taskId)).toEqual([taskIds[0]]);
  });

  it('(x) leaves one deleted worker file to the normal reload', async () => {
    fs.rmSync(fileOf('workers', workerIds[2]));

    expect(await healMassDeletion(state)).toBe(0);
    expect(fs.existsSync(fileOf('workers', workerIds[2]))).toBe(false);

    await state.load();
    expect([...state.workers.keys()].sort()).toEqual(workerIds.filter((id) => id !== workerIds[2]));
    for (const dir of RUNTIME_DIRS.filter((d) => d !== 'workers')) expect(entriesOf(dir)).toEqual(before[dir]);
  });

  it('(y) leaves two deleted proposal files to the normal reload', async () => {
    fs.rmSync(fileOf('proposals', proposalIds[0]));
    fs.rmSync(fileOf('proposals', proposalIds[1]));

    expect(await healMassDeletion(state)).toBe(0);

    await state.load();
    expect([...state.proposals.keys()]).toEqual([proposalIds[2]]);
    for (const dir of RUNTIME_DIRS.filter((d) => d !== 'proposals')) expect(entriesOf(dir)).toEqual(before[dir]);
  });

  it('leaves a lone team and a lone resource whose files were deleted (directories kept) to the normal reload', async () => {
    fs.rmSync(fileOf('teams', before.teams[0][0]));
    fs.rmSync(fileOf('resources', 'box-heal'));

    expect(await healMassDeletion(state)).toBe(0);

    await state.load();
    expect(state.teams.size).toBe(0);
    expect(state.resources.size).toBe(0);
    for (const dir of ['workers', 'proposals', 'attempts'] as const) expect(entriesOf(dir)).toEqual(before[dir]);
  });

  it('never applies the per-kind rule to the board kinds a git checkout changes on purpose', async () => {
    // 11 of 50 tasks is 22% of the tasks but 18.6% of the 59 combined entities.
    for (const id of taskIds.slice(0, 11)) fs.rmSync(path.join(moePath, 'tasks', `${id}.json`));

    expect(await healMassDeletion(state)).toBe(0);

    await state.load();
    expect(state.tasks.size).toBe(39);
  });

  it('(z1) rewrites runtime kinds whose directories are gone though each held fewer than MASS_DELETION_MIN entries', async () => {
    // Only the dirGone clause can fire: each kind is under MASS_DELETION_MIN, and neither is a combined kind.
    const gone = ['resources', 'attempts'] as const;
    for (const dir of gone) {
      expect(before[dir].length).toBeLessThan(MASS_DELETION_MIN);
      fs.rmSync(path.join(moePath, dir), { recursive: true, force: true });
    }

    expect(await healMassDeletion(state)).toBe(2);
    for (const dir of gone) {
      for (const [id, entity] of before[dir]) {
        expect(JSON.parse(fs.readFileSync(fileOf(dir, id), 'utf-8'))).toEqual(entity);
      }
    }

    await state.load();
    for (const dir of RUNTIME_DIRS) expect(entriesOf(dir)).toEqual(before[dir]);
    expect(state.resources.get('box-heal')?.holders.map((h) => h.taskId)).toEqual([taskIds[0]]);
  });

  it('(z2) rewrites a runtime kind that lost MASS_DELETION_MIN and MASS_DELETION_FRACTION of its files, directory kept', async () => {
    // Only the per-kind fraction branch can fire: 3 of 4 workers, dir kept; 3 of 59 combined is 5%.
    const lost = workerIds.slice(0, 3);
    const combinedKnown = state.tasks.size + state.epics.size + state.teams.size + state.workers.size + state.proposals.size;
    expect(lost.length).toBeGreaterThanOrEqual(MASS_DELETION_MIN);
    expect(lost.length).toBeGreaterThanOrEqual(workerIds.length * MASS_DELETION_FRACTION);
    expect(lost.length).toBeLessThan(combinedKnown * MASS_DELETION_FRACTION);
    for (const id of lost) fs.rmSync(fileOf('workers', id));

    expect(await healMassDeletion(state)).toBe(3);
    const was = new Map(before.workers);
    for (const id of lost) expect(JSON.parse(fs.readFileSync(fileOf('workers', id), 'utf-8'))).toEqual(was.get(id));

    await state.load();
    for (const dir of RUNTIME_DIRS) expect(entriesOf(dir)).toEqual(before[dir]);
  });
});
