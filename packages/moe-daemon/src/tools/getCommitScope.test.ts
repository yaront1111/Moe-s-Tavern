import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ToolTestHarness } from './toolTestHarness.js';
import { getCommitScopeTool } from './getCommitScope.js';
import { getTools } from './index.js';
import { pathKey } from '../util/affectedFiles.js';

interface ScopeResult {
  taskId: string;
  title: string;
  status: string;
  epicId: string;
  reopenCount: number;
  assignedWorkerId: string | null;
  assigneeAlive: boolean;
  asserted: string[];
  planned: string[];
  touchedFiles: string[];
  inferredPaths: string[];
  unattributedPaths: string[];
  peerDeclared: { path: string; taskId: string }[];
  livePeerIds: string[];
  activePeerIds: string[];
  peersActive: boolean;
  alwaysInclude: string[];
  excludePrefixes: string[];
  policy: {
    autoCommit: boolean;
    checkpointCommits: boolean;
    checkpointPush: boolean;
    commitBoardState: boolean;
    commitHooks: boolean;
    undeclared: string;
    contested: string;
  };
}

const sortedKeys = (paths: string[]) => paths.map(pathKey).sort();

describe('moe.get_commit_scope', () => {
  const h = new ToolTestHarness();
  beforeEach(() => h.init());
  afterEach(() => { vi.restoreAllMocks(); h.cleanup(); });

  async function scope(args: Record<string, unknown> = {}): Promise<ScopeResult> {
    return await getCommitScopeTool(h.state).handler({ taskId: 'task-1', ...args }, h.state) as ScopeResult;
  }

  it('is registered in getTools()', () => {
    expect(getTools(h.state).map((t) => t.name)).toContain('moe.get_commit_scope');
  });

  it('splits ASSERTED and PLANNED tiers exactly the way completeTask.ts folds filesModified', async () => {
    h.setupMoeFolder();
    h.createEpic();
    h.createTask({
      id: 'task-1',
      status: 'WORKING',
      assignedWorkerId: 'worker-1',
      implementationPlan: [
        // modifiedFiles wins over affectedFiles for a COMPLETED step …
        { stepId: 's1', description: 'a', status: 'COMPLETED', affectedFiles: ['src/plan-a.ts'], modifiedFiles: ['./src/a.ts'] },
        // … and affectedFiles is the fallback when modifiedFiles is absent;
        // newFiles never reaches the asserted tier (completeTask ignores it).
        { stepId: 's2', description: 'b', status: 'COMPLETED', affectedFiles: ['src\\b.ts'], newFiles: ['src/new-b.ts'] },
        // Non-completed steps are PLANNED only, whatever they declare.
        { stepId: 's3', description: 'c', status: 'IN_PROGRESS', affectedFiles: ['src/c.ts'], newFiles: ['src/new-c.ts'], modifiedFiles: ['src/c-mod.ts'] },
      ],
      filesModified: ['src/fm.ts'],
      declaredFiles: ['src/decl.ts'],
      touchedFiles: ['src/touched.ts'],
      inferredPaths: ['src/measured.ts', 'src/inf2.ts'],
      commits: [{
        sha: 'abc1234', ref: 'moe/work-2026-08-28', kind: 'checkpoint', role: 'worker', sessionId: 'worker-1@t',
        paths: ['src/committed.ts', 'src/measured.ts'], inferredPaths: ['src/measured.ts'],
        recordedBy: 'worker-1', recordedAt: '2026-08-28T00:00:00.000Z',
      }],
    });
    await h.state.load();

    const result = await scope({ workerId: 'worker-1' });

    expect(sortedKeys(result.asserted)).toEqual(sortedKeys([
      'src/a.ts', 'src/b.ts', 'src/fm.ts', 'src/decl.ts', 'src/touched.ts', 'src/committed.ts',
    ]));
    expect(sortedKeys(result.planned)).toEqual(sortedKeys([
      'src/plan-a.ts', 'src/new-b.ts', 'src/c.ts', 'src/new-c.ts', 'src/c-mod.ts', 'src/measured.ts', 'src/inf2.ts',
    ]));
    // Normalized: leading ./ stripped, backslashes forward.
    expect(result.asserted).toContain('src/a.ts');
    expect(result.asserted).toContain('src/b.ts');
    // Tiers never overlap.
    const assertedKeys = new Set(result.asserted.map(pathKey));
    expect(result.planned.some((p) => assertedKeys.has(pathKey(p)))).toBe(false);
    expect(result.touchedFiles).toEqual(['src/touched.ts']);
    expect(result.inferredPaths).toEqual(['src/measured.ts', 'src/inf2.ts']);
    expect(result.status).toBe('WORKING');
    expect(result.assignedWorkerId).toBe('worker-1');
  });

  it('asserted tier matches the filesModified completeTask would compute for the completed steps', async () => {
    h.setupMoeFolder();
    h.createEpic();
    const plan = [
      { stepId: 's1', description: 'a', status: 'COMPLETED' as const, affectedFiles: ['x/one.ts'], modifiedFiles: ['x/one.ts', 'x/extra.ts'] },
      { stepId: 's2', description: 'b', status: 'COMPLETED' as const, affectedFiles: ['x/two.ts'] },
      { stepId: 's3', description: 'c', status: 'PENDING' as const, affectedFiles: ['x/three.ts'] },
    ];
    h.createTask({ id: 'task-1', status: 'WORKING', implementationPlan: plan });
    await h.state.load();

    // Verbatim from completeTask.ts.
    const completeTaskFilesModified = Array.from(new Set(
      plan.filter((s) => s.status === 'COMPLETED').flatMap((s) => s.modifiedFiles || s.affectedFiles || [])
    ));
    const result = await scope();
    expect(sortedKeys(result.asserted)).toEqual(sortedKeys(completeTaskFilesModified));
    expect(sortedKeys(result.planned)).toEqual(sortedKeys(['x/three.ts']));
  });

  it('builds the PEER map from every other open task and excludes DONE/ARCHIVED', async () => {
    h.setupMoeFolder();
    h.createEpic();
    h.createTask({ id: 'task-1', status: 'WORKING', implementationPlan: [
      { stepId: 's1', description: 'a', status: 'PENDING', affectedFiles: ['src/mine.ts'] },
    ] });
    h.createTask({ id: 'task-p1', status: 'WORKING', touchedFiles: ['src/peer-touched.ts'], implementationPlan: [
      { stepId: 's1', description: 'p', status: 'PENDING', affectedFiles: ['src/peer.ts'], newFiles: ['src/peer-new.ts'] },
    ] });
    h.createTask({ id: 'task-p2', status: 'BLOCKED', declaredFiles: ['src/blocked-peer.ts'] });
    h.createTask({ id: 'task-done', status: 'DONE', filesModified: ['src/done.ts'] });
    h.createTask({ id: 'task-arch', status: 'ARCHIVED', filesModified: ['src/archived.ts'] });
    await h.state.load();

    const result = await scope();
    const byPath = new Map(result.peerDeclared.map((e) => [pathKey(e.path), e.taskId]));
    expect(byPath.get(pathKey('src/peer.ts'))).toBe('task-p1');
    expect(byPath.get(pathKey('src/peer-new.ts'))).toBe('task-p1');
    expect(byPath.get(pathKey('src/peer-touched.ts'))).toBe('task-p1');
    expect(byPath.get(pathKey('src/blocked-peer.ts'))).toBe('task-p2');
    expect(byPath.has(pathKey('src/done.ts'))).toBe(false);
    expect(byPath.has(pathKey('src/archived.ts'))).toBe(false);
    // Never its own paths.
    expect(byPath.has(pathKey('src/mine.ts'))).toBe(false);
  });

  it('tolerates un-storable paths in a peer record instead of failing the scope', async () => {
    h.setupMoeFolder();
    h.createEpic();
    h.createTask({ id: 'task-1', status: 'WORKING' });
    h.createTask({ id: 'task-junk', status: 'WORKING', filesModified: ['/abs/path.ts', '../escape.ts', 'ok/fine.ts'] });
    await h.state.load();

    const result = await scope();
    expect(result.peerDeclared.map((e) => e.path)).toEqual(['ok/fine.ts']);
  });

  it('derives livePeerIds from the presence window when no since is given, excluding the caller and DEAD workers', async () => {
    h.setupMoeFolder();
    h.createEpic();
    h.createTask({ id: 'task-1', status: 'WORKING', assignedWorkerId: 'worker-1' });
    const now = Date.now();
    h.createWorker({ id: 'worker-1', status: 'CODING', currentTaskId: 'task-1', lastActivityAt: new Date(now).toISOString() });
    h.createWorker({ id: 'worker-2', status: 'IDLE', lastActivityAt: new Date(now - 30_000).toISOString() });
    h.createWorker({ id: 'worker-3', status: 'IDLE', lastActivityAt: new Date(now - 10 * 60_000).toISOString() });
    h.createWorker({ id: 'worker-dead', status: 'DEAD', lastActivityAt: new Date(now).toISOString() });
    await h.state.load();

    const result = await scope({ workerId: 'worker-1' });
    expect(result.livePeerIds).toEqual(['worker-2']);
    expect(result.activePeerIds).toEqual(['worker-2']);
    expect(result.peersActive).toBe(true);
    expect(result.assigneeAlive).toBe(true);
  });

  it('with since: peers active at/after since−120s or registered after since count', async () => {
    h.setupMoeFolder();
    h.createEpic();
    h.createTask({ id: 'task-1', status: 'WORKING', assignedWorkerId: 'worker-1' });
    const now = Date.now();
    const since = new Date(now - 5 * 60_000).toISOString();
    h.createWorker({ id: 'worker-1', status: 'CODING', currentTaskId: 'task-1', lastActivityAt: new Date(now).toISOString() });
    // 6 min ago: inside since−120s → active for this session.
    h.createWorker({ id: 'worker-recent', status: 'IDLE', lastActivityAt: new Date(now - 6 * 60_000).toISOString(), startedAt: new Date(now - 60 * 60_000).toISOString() });
    // 10 min ago and registered an hour ago → not active this session.
    h.createWorker({ id: 'worker-old', status: 'IDLE', lastActivityAt: new Date(now - 10 * 60_000).toISOString(), startedAt: new Date(now - 60 * 60_000).toISOString() });
    // Registered after since, activity unparsable → counts via registration.
    h.createWorker({ id: 'worker-new', status: 'IDLE', lastActivityAt: 'garbage', startedAt: new Date(now - 60_000).toISOString() });
    await h.state.load();

    const result = await scope({ workerId: 'worker-1', since, phase: 'postflight', sessionId: `worker-1@${since}` });
    expect(result.livePeerIds).toEqual(['worker-new', 'worker-recent']);
    expect(result.peersActive).toBe(true);
  });

  it('reports peersActive:false for a lone assignee and counts an orphan-mode caller as a peer', async () => {
    h.setupMoeFolder();
    h.createEpic();
    h.createTask({ id: 'task-1', status: 'BLOCKED', assignedWorkerId: null });
    h.createWorker({ id: 'worker-1', status: 'IDLE' });
    await h.state.load();

    // Nobody else registered, caller is the assignee-less recoverer → orphan.
    const orphan = await scope({ workerId: 'worker-1' });
    expect(orphan.livePeerIds).toEqual([]);
    expect(orphan.activePeerIds).toEqual(['worker-1']);
    expect(orphan.peersActive).toBe(true);
    expect(orphan.assigneeAlive).toBe(false);

    await h.state.updateTask('task-1', { assignedWorkerId: 'worker-1' });
    const owner = await scope({ workerId: 'worker-1' });
    expect(owner.activePeerIds).toEqual([]);
    expect(owner.peersActive).toBe(false);
  });

  it('lists BOARD paths in alwaysInclude, skipping task records held by live peers; empty when commitBoardState is false', async () => {
    h.setupMoeFolder();
    h.createEpic({ id: 'epic-1' });
    h.createEpic({ id: 'epic-2' });
    h.createTask({ id: 'task-1', status: 'WORKING', assignedWorkerId: 'worker-1' });
    h.createTask({ id: 'task-held', status: 'WORKING', assignedWorkerId: 'worker-2' });
    h.createTask({ id: 'task-free', status: 'DONE', assignedWorkerId: null });
    h.createTask({ id: 'task-stale', status: 'WORKING', assignedWorkerId: 'worker-gone' });
    const now = new Date().toISOString();
    h.createWorker({ id: 'worker-1', status: 'CODING', currentTaskId: 'task-1', lastActivityAt: now });
    h.createWorker({ id: 'worker-2', status: 'CODING', currentTaskId: 'task-held', lastActivityAt: now });
    await h.state.load();

    const result = await scope({ workerId: 'worker-1' });
    expect(result.alwaysInclude).toEqual([
      '.moe/tasks/task-1.json',
      '.moe/project.json',
      '.moe/epics/epic-1.json',
      '.moe/epics/epic-2.json',
      '.moe/tasks/task-free.json',
      '.moe/tasks/task-stale.json',
    ]);

    await h.state.updateSettings({ commitBoardState: false });
    const off = await scope({ workerId: 'worker-1' });
    expect(off.alwaysInclude).toEqual([]);
    expect(off.policy.commitBoardState).toBe(false);
  });

  it('echoes the commit policy with defaults and honours overrides + attribution.exclude', async () => {
    h.setupMoeFolder();
    h.createEpic();
    h.createTask({ id: 'task-1', status: 'WORKING' });
    await h.state.load();

    const defaults = await scope();
    expect(defaults.policy).toEqual({
      autoCommit: true,
      checkpointCommits: true,
      checkpointPush: true,
      commitBoardState: true,
      commitHooks: false,
      undeclared: 'solo',
      contested: 'commit',
    });
    expect(defaults.excludePrefixes).toEqual([]);

    await h.state.updateSettings({
      autoCommit: false,
      checkpointCommits: false,
      checkpointPush: false,
      commitHooks: true,
      attribution: { undeclared: 'always', contested: 'skip', exclude: ['vendor/', './build\\out'] },
    });
    const overridden = await scope();
    expect(overridden.policy).toEqual({
      autoCommit: false,
      checkpointCommits: false,
      checkpointPush: false,
      commitBoardState: true,
      commitHooks: true,
      undeclared: 'always',
      contested: 'skip',
    });
    expect(overridden.excludePrefixes).toEqual(['vendor', 'build/out']);
  });

  it('touches the caller worker and validates its inputs', async () => {
    h.setupMoeFolder();
    h.createEpic();
    h.createTask({ id: 'task-1', status: 'WORKING', assignedWorkerId: 'worker-1' });
    h.createWorker({ id: 'worker-1', status: 'CODING', currentTaskId: 'task-1', lastActivityAt: '2020-01-01T00:00:00.000Z' });
    await h.state.load();

    await scope({ workerId: 'worker-1' });
    expect(Date.parse(h.state.getWorker('worker-1')!.lastActivityAt)).toBeGreaterThan(Date.parse('2020-01-02T00:00:00.000Z'));

    await expect(scope({ taskId: 'nope' })).rejects.toThrow('Task not found');
    await expect(getCommitScopeTool(h.state).handler({}, h.state)).rejects.toThrow('Missing required field: taskId');
    await expect(scope({ phase: 'midflight' })).rejects.toThrow('phase');
    await expect(scope({ since: 'not-a-date' })).rejects.toThrow('since');
  });
});
