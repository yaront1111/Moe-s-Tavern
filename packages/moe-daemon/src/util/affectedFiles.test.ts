// Append-only file suppression in claim-time collision warnings.
//
// Shared append-only files (CHANGELOG.md and friends) are edited by every task
// in an epic, so they generate permanent fileCollision noise that trains
// workers to ignore the warning. computeFileCollisions filters them out; the
// list is configurable via settings.appendOnlyFiles (a custom array REPLACES
// the default, and `[]` turns suppression off entirely).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { computeFileCollisions, DEFAULT_APPEND_ONLY_FILES, type FileCollision } from './affectedFiles.js';
import { StateManager } from '../state/StateManager.js';
import { claimNextTaskTool } from '../tools/claimNextTask.js';
import type { Project, Epic, Task } from '../types/schema.js';

// Mirrors affectedFiles.ts: collision comparison folds case on Windows/macOS.
const CASE_INSENSITIVE_FS = process.platform === 'win32' || process.platform === 'darwin';

function makeTask(id: string, files: string[], overrides: Partial<Task> = {}): Task {
  const now = new Date().toISOString();
  return {
    id, epicId: 'epic-1', title: id, description: '', definitionOfDone: [], taskRails: [],
    implementationPlan: [{ stepId: 'step-1', description: 'edit', status: 'PENDING', affectedFiles: files }],
    status: 'WORKING', assignedWorkerId: null, branch: null, prLink: null,
    reopenCount: 0, reopenReason: null, createdBy: 'HUMAN', parentTaskId: null,
    priority: 'MEDIUM', order: 1, comments: [], createdAt: now, updatedAt: now,
    ...overrides,
  };
}

/** Candidate vs one other WORKING task. Omitting `patterns` exercises the default. */
function collide(candidateFiles: string[], otherFiles: string[], patterns?: readonly string[]): FileCollision[] {
  const candidate = makeTask('task-cand', candidateFiles);
  const other = makeTask('task-other', otherFiles);
  const tasks = [candidate, other];
  return patterns === undefined
    ? computeFileCollisions(candidate, tasks)
    : computeFileCollisions(candidate, tasks, patterns);
}

describe('computeFileCollisions — append-only suppression', () => {
  it('exports an immutable [CHANGELOG.md] default', () => {
    expect(DEFAULT_APPEND_ONLY_FILES).toEqual(['CHANGELOG.md']);
    expect(Object.isFrozen(DEFAULT_APPEND_ONLY_FILES)).toBe(true);
  });

  it('drops the default CHANGELOG.md overlap but keeps real overlaps', () => {
    const result = collide(['CHANGELOG.md', 'src/foo.ts'], ['CHANGELOG.md', 'src/foo.ts']);
    expect(result).toEqual([{ task: 'task-other', files: ['src/foo.ts'] }]);
  });

  it('returns no warning at all when the only overlap is append-only', () => {
    expect(collide(['CHANGELOG.md'], ['CHANGELOG.md', 'src/foo.ts'])).toEqual([]);
  });

  it('suppresses a literal custom path and reports CHANGELOG.md again (replacement, not merge)', () => {
    const result = collide(
      ['CHANGELOG.md', 'docs/notes.md', 'src/foo.ts'],
      ['CHANGELOG.md', 'docs/notes.md', 'src/foo.ts'],
      ['docs/notes.md']
    );
    expect(result).toEqual([{ task: 'task-other', files: ['CHANGELOG.md', 'src/foo.ts'] }]);
  });

  it('restores CHANGELOG.md collisions when the list is empty', () => {
    expect(collide(['CHANGELOG.md'], ['CHANGELOG.md'], [])).toEqual([
      { task: 'task-other', files: ['CHANGELOG.md'] },
    ]);
  });

  it('limits `*` to a single path segment', () => {
    const result = collide(
      ['docs/a.md', 'docs/sub/b.md'],
      ['docs/a.md', 'docs/sub/b.md'],
      ['docs/*.md']
    );
    expect(result).toEqual([{ task: 'task-other', files: ['docs/sub/b.md'] }]);
  });

  it('lets `**` cross directories', () => {
    expect(collide(['docs/sub/b.md', 'src/foo.ts'], ['docs/sub/b.md', 'src/foo.ts'], ['docs/**']))
      .toEqual([{ task: 'task-other', files: ['src/foo.ts'] }]);
  });

  it('matches zero or more leading segments for `**/`', () => {
    const files = ['CHANGELOG.md', 'packages/a/CHANGELOG.md', 'src/foo.ts'];
    expect(collide(files, files, ['**/CHANGELOG.md']))
      .toEqual([{ task: 'task-other', files: ['src/foo.ts'] }]);
  });

  it('treats regex metacharacters as literals', () => {
    // `a+b.md` must not behave like the regex /a+b\.md/ (which matches aab.md),
    // and `.` must not match an arbitrary character.
    const result = collide(
      ['docs/aab.md', 'docs/a+b.md', 'CHANGELOGxmd'],
      ['docs/aab.md', 'docs/a+b.md', 'CHANGELOGxmd'],
      ['docs/a+b.md', 'CHANGELOG.md']
    );
    expect(result).toEqual([{ task: 'task-other', files: ['CHANGELOGxmd', 'docs/aab.md'] }]);
  });

  it('anchors the whole path (no substring matches)', () => {
    const result = collide(['src/CHANGELOG.md.bak'], ['src/CHANGELOG.md.bak']);
    expect(result).toEqual([{ task: 'task-other', files: ['src/CHANGELOG.md.bak'] }]);
  });

  it('follows the platform case policy used for collision keys', () => {
    const result = collide(['changelog.md'], ['changelog.md']);
    expect(result).toEqual(
      CASE_INSENSITIVE_FS ? [] : [{ task: 'task-other', files: ['changelog.md'] }]
    );
  });

  it('accepts backslash-separated patterns from hand-edited settings', () => {
    expect(collide(['docs/notes.md'], ['docs/notes.md'], ['docs\\notes.md'])).toEqual([]);
  });

  it('falls back to the default when a hand-edited setting is not an array', () => {
    // Iterating a string would compile one matcher per character.
    const result = collide(
      ['CHANGELOG.md', 'C', 'src/foo.ts'],
      ['CHANGELOG.md', 'C', 'src/foo.ts'],
      'CHANGELOG.md' as unknown as string[]
    );
    expect(result).toEqual([{ task: 'task-other', files: ['C', 'src/foo.ts'] }]);
  });

  it('ignores non-string and over-long entries instead of throwing', () => {
    const patterns = [null, 42, 'x'.repeat(501), 'src/foo.ts'] as unknown as string[];
    expect(collide(['src/foo.ts', 'CHANGELOG.md'], ['src/foo.ts', 'CHANGELOG.md'], patterns))
      .toEqual([{ task: 'task-other', files: ['CHANGELOG.md'] }]);
  });

  it('collapses repeated `**/` instead of chaining ambiguous stars', () => {
    // Semantics are unchanged: `**/**/x` still matches at any depth, including
    // zero directories.
    expect(collide(['docs/deep/notes.md'], ['docs/deep/notes.md'], ['**/**/notes.md'])).toEqual([]);
    expect(collide(['notes.md'], ['notes.md'], ['**/**/notes.md'])).toEqual([]);
    expect(collide(['notes.txt'], ['notes.txt'], ['**/**/notes.md'])).toEqual([
      { task: 'task-other', files: ['notes.txt'] },
    ]);

    // A pathological pattern must not backtrack: chained `(?:[^/]+/)*` groups
    // would blow up combinatorially here, and this runs under the claim mutex.
    const nested = 'a/'.repeat(30) + 'nope.txt';
    const started = Date.now();
    expect(collide([nested], [nested], ['**/'.repeat(50) + 'x.md'])).toEqual([
      { task: 'task-other', files: [nested] },
    ]);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('keeps ownership grouping, WORKING-only scoping and sorting intact', () => {
    const candidate = makeTask('task-cand', ['CHANGELOG.md', 'src/z.ts', 'src/a.ts']);
    const working = makeTask('task-b', ['CHANGELOG.md', 'src/z.ts', 'src/a.ts']);
    const alsoWorking = makeTask('task-a', ['src/a.ts']);
    const review = makeTask('task-review', ['src/z.ts'], { status: 'REVIEW' });
    const result = computeFileCollisions(candidate, [candidate, working, alsoWorking, review]);
    expect(result).toEqual([
      { task: 'task-a', files: ['src/a.ts'] },
      { task: 'task-b', files: ['src/a.ts', 'src/z.ts'] },
    ]);
  });
});

describe('settings.appendOnlyFiles — validation + claim wiring', () => {
  let testDir: string;
  let moePath: string;
  let state: StateManager;

  function setupMoe() {
    fs.mkdirSync(moePath, { recursive: true });
    for (const sub of ['epics', 'tasks', 'workers', 'proposals', 'channels', 'messages', 'teams']) {
      fs.mkdirSync(path.join(moePath, sub));
    }
    const project: Partial<Project> = {
      id: 'proj-test',
      schemaVersion: 6,
      name: 'Test',
      rootPath: testDir,
      globalRails: { techStack: [], forbiddenPatterns: [], requiredPatterns: [], formatting: '', testing: '', customRules: [] },
      settings: {
        approvalMode: 'TURBO',
        speedModeDelayMs: 0,
        autoCreateBranch: false,
        branchPattern: '',
        commitPattern: '',
        agentCommand: 'claude',
        enableAgentTeams: false,
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(moePath, 'project.json'), JSON.stringify(project, null, 2));
    const epic: Epic = {
      id: 'epic-1', projectId: 'proj-test', title: 'E', description: '', architectureNotes: '',
      epicRails: [], status: 'ACTIVE', order: 1,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(moePath, 'epics', 'epic-1.json'), JSON.stringify(epic, null, 2));
    for (const t of [
      makeTask('task-A', ['CHANGELOG.md', 'docs/notes.md', 'src/foo.ts'], { assignedWorkerId: 'worker-a' }),
      makeTask('task-B', ['CHANGELOG.md', 'docs/notes.md', 'src/foo.ts']),
    ]) {
      fs.writeFileSync(path.join(moePath, 'tasks', `${t.id}.json`), JSON.stringify(t, null, 2));
    }
  }

  async function claimTaskB(workerId: string): Promise<FileCollision[]> {
    const result = await claimNextTaskTool(state).handler(
      { workerId, statuses: ['WORKING'], taskId: 'task-B' },
      state
    ) as { hasNext: boolean; fileCollision?: FileCollision[] };
    expect(result.hasNext).toBe(true);
    return result.fileCollision ?? [];
  }

  beforeEach(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moe-append-only-'));
    moePath = path.join(testDir, '.moe');
    state = new StateManager({ projectPath: testDir });
    setupMoe();
    await state.load();
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('canonicalizes and deduplicates a custom list, persisting it to project.json', async () => {
    await state.updateSettings({ appendOnlyFiles: ['.\\docs\\notes.md', 'docs/notes.md', 'docs/**'] });
    expect(state.project!.settings.appendOnlyFiles).toEqual(['docs/notes.md', 'docs/**']);
    const persisted = JSON.parse(fs.readFileSync(path.join(moePath, 'project.json'), 'utf-8')) as Project;
    expect(persisted.settings.appendOnlyFiles).toEqual(['docs/notes.md', 'docs/**']);
  });

  it('preserves an explicit empty array', async () => {
    await state.updateSettings({ appendOnlyFiles: [] });
    expect(state.project!.settings.appendOnlyFiles).toEqual([]);
  });

  it.each([
    ['a non-array', 'CHANGELOG.md' as unknown],
    ['a non-string entry', [42] as unknown],
    ['an empty entry', ['  '] as unknown],
    ['an absolute posix path', ['/etc/passwd'] as unknown],
    ['an absolute windows path', ['C:\\repo\\CHANGELOG.md'] as unknown],
    ['a traversal pattern', ['../**'] as unknown],
  ])('rejects %s without mutating settings', async (_label, value) => {
    await state.updateSettings({ appendOnlyFiles: ['docs/notes.md'] });
    await expect(
      state.updateSettings({ appendOnlyFiles: value as string[] })
    ).rejects.toThrow(/\[INVALID_INPUT\] Invalid appendOnlyFiles/);
    expect(state.project!.settings.appendOnlyFiles).toEqual(['docs/notes.md']);
    const persisted = JSON.parse(fs.readFileSync(path.join(moePath, 'project.json'), 'utf-8')) as Project;
    expect(persisted.settings.appendOnlyFiles).toEqual(['docs/notes.md']);
  });

  it('survives a hand-edited malformed setting at claim time', async () => {
    // Written straight to project.json, bypassing updateSettings validation.
    const projectFile = path.join(moePath, 'project.json');
    const project = JSON.parse(fs.readFileSync(projectFile, 'utf-8')) as Project;
    (project.settings as unknown as Record<string, unknown>).appendOnlyFiles = 'CHANGELOG.md';
    fs.writeFileSync(projectFile, JSON.stringify(project, null, 2));
    await state.load();

    expect(await claimTaskB('worker-b')).toEqual([
      { task: 'task-A', files: ['docs/notes.md', 'src/foo.ts'] },
    ]);
  });

  it('suppresses only CHANGELOG.md at claim time when the setting is absent', async () => {
    expect(state.project!.settings.appendOnlyFiles).toBeUndefined();
    expect(await claimTaskB('worker-b')).toEqual([
      { task: 'task-A', files: ['docs/notes.md', 'src/foo.ts'] },
    ]);
  });

  it('uses a configured custom list at claim time', async () => {
    await state.updateSettings({ appendOnlyFiles: ['docs/*.md'] });
    expect(await claimTaskB('worker-b')).toEqual([
      { task: 'task-A', files: ['CHANGELOG.md', 'src/foo.ts'] },
    ]);
  });

  it('reports every overlap at claim time when suppression is disabled with []', async () => {
    await state.updateSettings({ appendOnlyFiles: [] });
    expect(await claimTaskB('worker-b')).toEqual([
      { task: 'task-A', files: ['CHANGELOG.md', 'docs/notes.md', 'src/foo.ts'] },
    ]);
  });
});
