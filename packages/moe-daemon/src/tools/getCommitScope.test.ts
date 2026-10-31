import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ToolTestHarness } from './toolTestHarness.js';
import { getCommitScopeTool } from './getCommitScope.js';
import { getTools } from './index.js';
import { pathKey } from '../util/affectedFiles.js';
import { openAttempt, setAttemptPhase } from '../state/attemptStore.js';

interface ScopeResult {
  taskId: string;
  title: string;
  status: string;
  epicId: string;
  reopenCount: number;
  assignedWorkerId: string | null;
  assigneeAlive: boolean;
  assigneeProtected: boolean;
  finalizingAttempt: { attemptId: string; workerId: string; generation: number } | null;
  asserted: string[];
  declared: string[];
  planned: string[];
  touchedFiles: string[];
  inferredPaths: string[];
  unattributedPaths: string[];
  peerDeclared: {
    path: string; taskId: string; peerActive: boolean; taskIds: string[]; activeTaskIds: string[]; editingTaskIds: string[];
  }[];
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

/** T5: activeTaskIds is an ordered subset of taskIds, editingTaskIds a subset of it, and peerActive is its non-emptiness. */
function expectActiveInvariants(result: ScopeResult): void {
  for (const e of result.peerDeclared) {
    expect(e.taskIds.filter((id) => e.activeTaskIds.includes(id)), `${e.path}: activeTaskIds order/subset`).toEqual(e.activeTaskIds);
    expect(e.editingTaskIds.every((id) => e.activeTaskIds.includes(id)), `${e.path}: editing within active`).toBe(true);
    expect(e.peerActive, `${e.path}: peerActive`).toBe(e.activeTaskIds.length > 0);
  }
}

describe('moe.get_commit_scope', () => {
  const h = new ToolTestHarness();
  beforeEach(() => h.init());
  afterEach(() => { vi.restoreAllMocks(); h.cleanup(); });

  async function scope(args: Record<string, unknown> = {}): Promise<ScopeResult> {
    return await getCommitScopeTool(h.state).handler({ taskId: 'task-1', ...args }, h.state) as ScopeResult;
  }

  async function checked(args: Record<string, unknown> = {}): Promise<ScopeResult> {
    const result = await scope(args);
    expectActiveInvariants(result);
    return result;
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
    // No moe.declare_files on this task: nothing is committed regardless of the baseline.
    expect(result.declared).toEqual([]);
  });

  it('serves the moe.declare_files paths separately as `declared`, a normalized subset of asserted', async () => {
    h.setupMoeFolder();
    h.createEpic();
    h.createTask({
      id: 'task-1',
      status: 'REVIEW',
      implementationPlan: [
        { stepId: 's1', description: 'a', status: 'COMPLETED', affectedFiles: ['src/step.ts'], modifiedFiles: ['src/step.ts'] },
      ],
      // History (filesModified/touched/committed) is asserted but NOT declared:
      // the wrapper commits it only when this task produced the dirty bytes.
      filesModified: ['src/delivered.ts'],
      touchedFiles: ['src/touched.ts'],
      commits: [{
        sha: 'abc1234', ref: 'moe/work-2026-09-30', kind: 'completion', role: 'worker', sessionId: 'worker-1@t',
        paths: ['src/committed.ts'], recordedBy: 'worker-1', recordedAt: '2026-09-30T00:00:00.000Z',
      }],
      // Explicit declarations: worker-typed spellings, a duplicate, and an
      // un-storable entry that must be dropped rather than fail the scope.
      declaredFiles: ['./src/rescued.ts', 'src\\helper.ts', 'src/rescued.ts', '../outside.ts'],
    });
    await h.state.load();

    const result = await scope({ workerId: 'worker-1' });

    expect(result.declared).toEqual(['src/rescued.ts', 'src/helper.ts']);
    const assertedKeys = new Set(result.asserted.map(pathKey));
    for (const p of result.declared) expect(assertedKeys.has(pathKey(p))).toBe(true);
    for (const p of ['src/step.ts', 'src/delivered.ts', 'src/touched.ts', 'src/committed.ts']) {
      expect(assertedKeys.has(pathKey(p))).toBe(true);
      expect(result.declared.map(pathKey)).not.toContain(pathKey(p));
    }
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

  it('ignores the plan-declared paths of a peer that waits on this task, but keeps its asserted ones', async () => {
    // The regression (task-435683c2, 2026-09-11): every link of a serialized
    // chain declares the same shared files in its plan. A downstream link that
    // waits on the landing task cannot have run yet - dependsOn gates its
    // WORKING claims until the landing task is DONE - yet its plan intent was
    // counted as a peer claim, contested the landing task's own edits, and held
    // that task's entire diff out of its completion commit.
    h.setupMoeFolder();
    h.createEpic();
    h.createTask({ id: 'task-1', status: 'REVIEW', implementationPlan: [
      { stepId: 's1', description: 'a', status: 'COMPLETED', affectedFiles: ['src/shared.ts'] },
    ] });
    // Direct dependent: plan declares the same file, and has done no work.
    h.createTask({ id: 'task-d1', status: 'WORKING', dependsOn: ['task-1'], implementationPlan: [
      { stepId: 's1', description: 'd1', status: 'PENDING', affectedFiles: ['src/shared.ts', 'src/d1-plan.ts'] },
    ] });
    // Transitive dependent, through task-d1.
    h.createTask({ id: 'task-d2', status: 'WORKING', dependsOn: ['task-d1'], implementationPlan: [
      { stepId: 's1', description: 'd2', status: 'PENDING', affectedFiles: ['src/d2-plan.ts'] },
    ] });
    // Waits through a runtime block instead of dependsOn, and carries real
    // evidence of an edit (declare_files) alongside plan intent.
    h.createTask({
      id: 'task-d3', status: 'BLOCKED', blockedOnTaskIds: ['task-1'], declaredFiles: ['src/d3-asserted.ts'],
      implementationPlan: [{ stepId: 's1', description: 'd3', status: 'PENDING', affectedFiles: ['src/d3-plan.ts'] }],
    });
    await h.state.load();

    const byPath = new Map((await scope()).peerDeclared.map((e) => [pathKey(e.path), e.taskId]));
    expect(byPath.has(pathKey('src/shared.ts'))).toBe(false);
    expect(byPath.has(pathKey('src/d1-plan.ts'))).toBe(false);
    expect(byPath.has(pathKey('src/d2-plan.ts'))).toBe(false);
    expect(byPath.has(pathKey('src/d3-plan.ts'))).toBe(false);
    // Asserted evidence of a real edit still contests, even from a dependent.
    expect(byPath.get(pathKey('src/d3-asserted.ts'))).toBe('task-d3');
  });

  it('still counts the plan-declared paths of a prerequisite and of an unrelated peer', async () => {
    h.setupMoeFolder();
    h.createEpic();
    h.createTask({ id: 'task-pre', status: 'WORKING', implementationPlan: [
      { stepId: 's1', description: 'pre', status: 'PENDING', affectedFiles: ['src/pre.ts'] },
    ] });
    h.createTask({ id: 'task-1', status: 'WORKING', dependsOn: ['task-pre'], implementationPlan: [
      { stepId: 's1', description: 'a', status: 'PENDING', affectedFiles: ['src/mine.ts'] },
    ] });
    h.createTask({ id: 'task-free', status: 'WORKING', implementationPlan: [
      { stepId: 's1', description: 'f', status: 'PENDING', affectedFiles: ['src/free.ts'] },
    ] });
    await h.state.load();

    const byPath = new Map((await scope()).peerDeclared.map((e) => [pathKey(e.path), e.taskId]));
    // task-1 waits on task-pre, not the other way round, so task-pre's plan is
    // live intent from a task that may be editing right now.
    expect(byPath.get(pathKey('src/pre.ts'))).toBe('task-pre');
    expect(byPath.get(pathKey('src/free.ts'))).toBe('task-free');
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
      contested: 'skip-untouched',
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

    for (const contested of ['commit', 'skip-untouched'] as const) {
      await h.state.updateSettings({ attribution: { contested } });
      expect((await scope()).policy.contested).toBe(contested);
    }
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

  describe('peerDeclared[].peerActive', () => {
    // A wrapper releases a contested path only on a JSON false here: the
    // contesting task cannot have written bytes during the landing session.
    afterEach(() => { vi.useRealTimers(); });

    const flags = (result: ScopeResult) =>
      new Map(result.peerDeclared.map((e) => [pathKey(e.path), { taskId: e.taskId, peerActive: e.peerActive }]));

    function peerTask(id: string, path: string, assignedWorkerId: string | null = null): void {
      h.createTask({ id, status: 'PLANNING', assignedWorkerId, declaredFiles: [path] });
    }

    it('is false for an unassigned peer with no attempts when since is given', async () => {
      h.setupMoeFolder();
      h.createEpic();
      h.createTask({ id: 'task-1', status: 'WORKING', assignedWorkerId: 'worker-1' });
      peerTask('task-idle', 'src/idle.ts');
      await h.state.load();

      const since = new Date(Date.now() - 5 * 60_000).toISOString();
      const byPath = flags(await checked({ workerId: 'worker-1', since }));
      expect(byPath.get(pathKey('src/idle.ts'))).toEqual({ taskId: 'task-idle', peerActive: false });
    });

    it('follows the assignee: active since since-120s is true; older, DEAD or missing is false', async () => {
      h.setupMoeFolder();
      h.createEpic();
      h.createTask({ id: 'task-1', status: 'WORKING', assignedWorkerId: 'worker-1' });
      const now = Date.now();
      const sinceMs = now - 5 * 60_000;
      const hourAgo = new Date(now - 60 * 60_000).toISOString();
      peerTask('task-a', 'src/a.ts', 'worker-recent');
      peerTask('task-b', 'src/b.ts', 'worker-old');
      peerTask('task-c', 'src/c.ts', 'worker-dead');
      peerTask('task-d', 'src/d.ts', 'worker-missing');
      h.createWorker({ id: 'worker-recent', status: 'IDLE', lastActivityAt: new Date(sinceMs - 60_000).toISOString(), startedAt: hourAgo });
      h.createWorker({ id: 'worker-old', status: 'IDLE', lastActivityAt: new Date(sinceMs - 10 * 60_000).toISOString(), startedAt: hourAgo });
      h.createWorker({ id: 'worker-dead', status: 'DEAD', lastActivityAt: new Date(now).toISOString(), startedAt: hourAgo });
      await h.state.load();

      const byPath = flags(await checked({ workerId: 'worker-1', since: new Date(sinceMs).toISOString() }));
      expect(byPath.get(pathKey('src/a.ts'))?.peerActive).toBe(true);
      expect(byPath.get(pathKey('src/b.ts'))?.peerActive).toBe(false);
      expect(byPath.get(pathKey('src/c.ts'))?.peerActive).toBe(false);
      expect(byPath.get(pathKey('src/d.ts'))?.peerActive).toBe(false);
    });

    it('follows the attempts: open, unparsable, or a phase change at/after since-120s is true; an older close is false', async () => {
      h.setupMoeFolder();
      h.createEpic();
      h.createTask({ id: 'task-1', status: 'WORKING', assignedWorkerId: 'worker-1' });
      peerTask('task-open', 'src/open.ts');
      peerTask('task-quiet', 'src/quiet.ts');
      peerTask('task-recent', 'src/recent.ts');
      peerTask('task-slack', 'src/slack.ts');
      peerTask('task-late', 'src/late.ts');
      peerTask('task-stale', 'src/stale.ts');
      peerTask('task-corrupt', 'src/corrupt.ts');
      await h.state.load();

      const now = Date.now();
      const sinceMs = now - 5 * 60_000;
      const attempt = (taskId: string) =>
        openAttempt(h.state, { taskId, workerId: 'worker-gone', runnerId: 'worker-gone', workspace: h.testDir });
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(now - 60 * 60_000);
      await setAttemptPhase(h.state, (await attempt('task-stale')).id, 'closed');
      // A hand-edited close whose lastPhaseAt does not parse fails closed.
      const corrupt = await setAttemptPhase(h.state, (await attempt('task-corrupt')).id, 'closed');
      h.state.attempts.set(corrupt.id, { ...corrupt, lastPhaseAt: 'garbage' });
      // A quiet long build: open for an hour with no phase change, so only its
      // open phase keeps it active; its lastPhaseAt is outside the window.
      await attempt('task-quiet');
      const slack = await attempt('task-slack');
      const late = await attempt('task-late');
      // The 120 s slack before since, as for worker-recent above: a close at
      // since-60s counts, one at since-180s does not.
      vi.setSystemTime(sinceMs - 180_000);
      await setAttemptPhase(h.state, late.id, 'closed');
      vi.setSystemTime(sinceMs - 60_000);
      await setAttemptPhase(h.state, slack.id, 'closed');
      vi.setSystemTime(now - 60_000);
      await attempt('task-open');
      await setAttemptPhase(h.state, (await attempt('task-recent')).id, 'closed');
      vi.useRealTimers();

      const byPath = flags(await checked({ workerId: 'worker-1', since: new Date(sinceMs).toISOString() }));
      expect(byPath.get(pathKey('src/open.ts'))?.peerActive).toBe(true);
      expect(byPath.get(pathKey('src/quiet.ts'))?.peerActive).toBe(true);
      expect(byPath.get(pathKey('src/recent.ts'))?.peerActive).toBe(true);
      expect(byPath.get(pathKey('src/slack.ts'))?.peerActive).toBe(true);
      expect(byPath.get(pathKey('src/late.ts'))?.peerActive).toBe(false);
      expect(byPath.get(pathKey('src/stale.ts'))?.peerActive).toBe(false);
      expect(byPath.get(pathKey('src/corrupt.ts'))?.peerActive).toBe(true);
    });

    it('is true for every entry when no since is given', async () => {
      h.setupMoeFolder();
      h.createEpic();
      h.createTask({ id: 'task-1', status: 'WORKING', assignedWorkerId: 'worker-1' });
      peerTask('task-idle', 'src/idle.ts');
      peerTask('task-gone', 'src/gone.ts', 'worker-missing');
      await h.state.load();

      const result = await checked({ workerId: 'worker-1' });
      expect(result.peerDeclared.map((e) => [e.path, e.peerActive])).toEqual([
        ['src/gone.ts', true],
        ['src/idle.ts', true],
      ]);
    });

    it('ORs over every task contributing a path, keeping the first claimant as taskId', async () => {
      for (const activeId of ['task-p2', 'task-p1']) {
        h.cleanup();
        h.init();
        h.setupMoeFolder();
        h.createEpic();
        h.createTask({ id: 'task-1', status: 'WORKING', assignedWorkerId: 'worker-1' });
        peerTask('task-p1', 'src/shared.ts', activeId === 'task-p1' ? 'worker-live' : null);
        peerTask('task-p2', './src/shared.ts', activeId === 'task-p2' ? 'worker-live' : null);
        h.createWorker({ id: 'worker-live', status: 'CODING', lastActivityAt: new Date().toISOString() });
        await h.state.load();

        const result = await checked({ workerId: 'worker-1', since: new Date(Date.now() - 5 * 60_000).toISOString() });
        expect(result.peerDeclared).toEqual([
          {
            path: 'src/shared.ts', taskId: 'task-p1', peerActive: true, taskIds: ['task-p1', 'task-p2'],
            activeTaskIds: [activeId], editingTaskIds: [],
          },
        ]);
      }
    });
  });

  describe('peerDeclared[].activeTaskIds', () => {
    afterEach(() => { vi.useRealTimers(); });

    const sinceIso = () => new Date(Date.now() - 5 * 60_000).toISOString();

    function setup(): void {
      h.setupMoeFolder();
      h.createEpic();
      h.createTask({ id: 'task-1', status: 'WORKING', assignedWorkerId: 'worker-1' });
      h.createWorker({ id: 'worker-live', status: 'CODING', lastActivityAt: new Date().toISOString() });
    }

    it('T1 with since: an idle first contributor and an active second give taskIds [first, second], activeTaskIds [second]', async () => {
      setup();
      h.createTask({ id: 'task-a-idle', status: 'PLANNING', assignedWorkerId: null, declaredFiles: ['src/shared.ts'] });
      h.createTask({ id: 'task-b-live', status: 'PLANNING', assignedWorkerId: 'worker-live', declaredFiles: ['src/shared.ts'] });
      await h.state.load();

      const result = await checked({ workerId: 'worker-1', since: sinceIso() });
      expect(result.peerDeclared).toEqual([{
        path: 'src/shared.ts', taskId: 'task-a-idle', peerActive: true,
        taskIds: ['task-a-idle', 'task-b-live'], activeTaskIds: ['task-b-live'], editingTaskIds: [],
      }]);
    });

    it('T2 with since: every contributor idle gives activeTaskIds [] and peerActive false', async () => {
      setup();
      h.createTask({ id: 'task-a-idle', status: 'PLANNING', assignedWorkerId: null, declaredFiles: ['src/shared.ts'] });
      h.createTask({ id: 'task-b-idle', status: 'PLANNING', assignedWorkerId: 'worker-missing', declaredFiles: ['src/shared.ts'] });
      await h.state.load();

      const result = await checked({ workerId: 'worker-1', since: sinceIso() });
      expect(result.peerDeclared).toEqual([{
        path: 'src/shared.ts', taskId: 'task-a-idle', peerActive: false,
        taskIds: ['task-a-idle', 'task-b-idle'], activeTaskIds: [], editingTaskIds: [],
      }]);
    });

    it('T3 without since: every contributor is listed, an unassigned one and a missing-worker one included', async () => {
      setup();
      h.createTask({ id: 'task-a-idle', status: 'PLANNING', assignedWorkerId: null, declaredFiles: ['src/shared.ts'] });
      h.createTask({ id: 'task-b-gone', status: 'PLANNING', assignedWorkerId: 'worker-missing', declaredFiles: ['src/shared.ts'] });
      await h.state.load();

      const result = await checked({ workerId: 'worker-1' });
      expect(result.peerDeclared).toEqual([{
        path: 'src/shared.ts', taskId: 'task-a-idle', peerActive: true,
        taskIds: ['task-a-idle', 'task-b-gone'], activeTaskIds: ['task-a-idle', 'task-b-gone'], editingTaskIds: [],
      }]);
    });

    it('T4 with since: an idle IN_PROGRESS contributor sorting first and an active one give active [active] and editing [active]', async () => {
      setup();
      const step = [{ stepId: 's1', description: 's', status: 'IN_PROGRESS', affectedFiles: ['src/shared.ts'] }];
      h.createTask({ id: 'task-a-idle', status: 'WORKING', assignedWorkerId: null, implementationPlan: step } as Parameters<typeof h.createTask>[0]);
      h.createTask({ id: 'task-b-live', status: 'WORKING', assignedWorkerId: 'worker-live', implementationPlan: step } as Parameters<typeof h.createTask>[0]);
      await h.state.load();

      const result = await checked({ workerId: 'worker-1', since: sinceIso() });
      expect(result.peerDeclared).toEqual([{
        path: 'src/shared.ts', taskId: 'task-a-idle', peerActive: true,
        taskIds: ['task-a-idle', 'task-b-live'], activeTaskIds: ['task-b-live'], editingTaskIds: ['task-b-live'],
      }]);
    });

    it('T6 the tool description names activeTaskIds', () => {
      expect(getCommitScopeTool(h.state).description).toContain('activeTaskIds');
    });
  });

  describe('peerDeclared[].taskIds and editingTaskIds', () => {
    // The e67ca0e repro: a TOOL witness released docs/MCP_SERVER.md while a
    // second peer was mid-step on it, and the Moe-Contested trailer named only
    // the first claimant. taskIds names every contributor; editingTaskIds the
    // ones with an IN_PROGRESS step on the path that may be writing right now.
    afterEach(() => { vi.useRealTimers(); });

    const sinceIso = () => new Date(Date.now() - 5 * 60_000).toISOString();
    const editing = (result: ScopeResult, path: string) =>
      result.peerDeclared.find((e) => pathKey(e.path) === pathKey(path))?.editingTaskIds;

    function stepPeer(
      id: string,
      status: 'PENDING' | 'IN_PROGRESS' | 'COMPLETED',
      affectedFiles: unknown,
      overrides: Record<string, unknown> = {}
    ): void {
      h.createTask({
        id,
        status: 'WORKING',
        implementationPlan: [{ stepId: 's1', description: id, status, affectedFiles }],
        ...overrides,
      } as Parameters<typeof h.createTask>[0]);
    }

    function setupLanding(): void {
      h.setupMoeFolder();
      h.createEpic();
      h.createTask({ id: 'task-1', status: 'WORKING', assignedWorkerId: 'worker-1', implementationPlan: [
        { stepId: 's1', description: 'a', status: 'COMPLETED', modifiedFiles: ['docs/MCP_SERVER.md'] },
      ] });
      h.createWorker({ id: 'worker-live', status: 'CODING', lastActivityAt: new Date().toISOString() });
    }

    it("counts a peer's IN_PROGRESS step path, names every contesting task and flags the live mid-step one", async () => {
      setupLanding();
      stepPeer('task-66e8', 'PENDING', ['docs/MCP_SERVER.md']);
      stepPeer('task-9cc1', 'IN_PROGRESS', ['docs/MCP_SERVER.md', 'docs/SCHEMA.md'], { assignedWorkerId: 'worker-live' });
      await h.state.load();

      const result = await checked({ workerId: 'worker-1', since: sinceIso() });
      expect(result.peerDeclared.find((e) => e.path === 'docs/MCP_SERVER.md')).toEqual({
        path: 'docs/MCP_SERVER.md', taskId: 'task-66e8', peerActive: true,
        taskIds: ['task-66e8', 'task-9cc1'], activeTaskIds: ['task-9cc1'], editingTaskIds: ['task-9cc1'],
      });
      expect(result.peerDeclared.find((e) => e.path === 'docs/SCHEMA.md')).toEqual({
        path: 'docs/SCHEMA.md', taskId: 'task-9cc1', peerActive: true,
        taskIds: ['task-9cc1'], activeTaskIds: ['task-9cc1'], editingTaskIds: ['task-9cc1'],
      });
    });

    it('with since: an IN_PROGRESS step is editing only while its task is active', async () => {
      setupLanding();
      stepPeer('task-live', 'IN_PROGRESS', ['src/a.ts'], { assignedWorkerId: 'worker-live' });
      stepPeer('task-idle', 'IN_PROGRESS', ['src/b.ts']);
      stepPeer('task-open', 'IN_PROGRESS', ['src/c.ts']);
      await h.state.load();
      await openAttempt(h.state, { taskId: 'task-open', workerId: 'worker-gone', runnerId: 'worker-gone', workspace: h.testDir });

      const result = await checked({ workerId: 'worker-1', since: sinceIso() });
      expect(editing(result, 'src/a.ts')).toEqual(['task-live']);
      expect(editing(result, 'src/b.ts')).toEqual([]);
      expect(result.peerDeclared.find((e) => e.path === 'src/b.ts')?.taskIds).toEqual(['task-idle']);
      expect(editing(result, 'src/c.ts')).toEqual(['task-open']);
    });

    it('never counts a PENDING or COMPLETED step as editing, even for an active assignee', async () => {
      setupLanding();
      stepPeer('task-pending', 'PENDING', ['src/p.ts'], { assignedWorkerId: 'worker-live' });
      stepPeer('task-done-step', 'COMPLETED', ['src/c.ts'], { assignedWorkerId: 'worker-live' });
      await h.state.load();

      const result = await checked({ workerId: 'worker-1', since: sinceIso() });
      expect(editing(result, 'src/p.ts')).toEqual([]);
      expect(editing(result, 'src/c.ts')).toEqual([]);
      expect(result.peerDeclared.find((e) => e.path === 'src/c.ts')?.taskIds).toEqual(['task-done-step']);
    });

    it('matches the stored spelling of a raw IN_PROGRESS step path', async () => {
      setupLanding();
      stepPeer('task-raw', 'IN_PROGRESS', ['./src\\x.ts'], { assignedWorkerId: 'worker-live' });
      await h.state.load();

      const result = await checked({ workerId: 'worker-1', since: sinceIso() });
      expect(result.peerDeclared.map((e) => [e.path, e.editingTaskIds])).toEqual([['src/x.ts', ['task-raw']]]);
    });

    it('marks only the paths an IN_PROGRESS step names, not the same task\'s other claims', async () => {
      setupLanding();
      stepPeer('task-two', 'IN_PROGRESS', ['src/a.ts'], { assignedWorkerId: 'worker-live', declaredFiles: ['src/b.ts'] });
      await h.state.load();

      const result = await checked({ workerId: 'worker-1', since: sinceIso() });
      expect(editing(result, 'src/a.ts')).toEqual(['task-two']);
      expect(editing(result, 'src/b.ts')).toEqual([]);
    });

    it('lists a task once per path however many spellings it claims, and once across tasks', async () => {
      setupLanding();
      stepPeer('task-a', 'IN_PROGRESS', ['src/a.ts', './src/a.ts', 'src\\a.ts'], {
        assignedWorkerId: 'worker-live', declaredFiles: ['./src/a.ts', 'src\\a.ts'],
      });
      stepPeer('task-b', 'IN_PROGRESS', ['src\\a.ts'], { assignedWorkerId: 'worker-live', filesModified: ['./src/a.ts'] });
      await h.state.load();

      const result = await checked({ workerId: 'worker-1', since: sinceIso() });
      expect(result.peerDeclared).toEqual([{
        path: 'src/a.ts', taskId: 'task-a', peerActive: true, taskIds: ['task-a', 'task-b'],
        activeTaskIds: ['task-a', 'task-b'], editingTaskIds: ['task-a', 'task-b'],
      }]);
    });

    it('fails closed without since: every IN_PROGRESS contributor is editing, an unassigned one included', async () => {
      setupLanding();
      stepPeer('task-unassigned', 'IN_PROGRESS', ['src/a.ts']);
      stepPeer('task-b', 'IN_PROGRESS', ['src/a.ts'], { assignedWorkerId: 'worker-missing' });
      await h.state.load();

      const result = await checked({ workerId: 'worker-1' });
      expect(editing(result, 'src/a.ts')).toEqual(['task-b', 'task-unassigned']);
      expect(result.peerDeclared[0]?.taskIds).toEqual(['task-b', 'task-unassigned']);
    });

    it('keeps the waits-on-this rule: a dependent contributes no entry for a path only its plan names', async () => {
      setupLanding();
      stepPeer('task-dep', 'IN_PROGRESS', ['src/only-plan.ts'], { assignedWorkerId: 'worker-live', dependsOn: ['task-1'] });
      await h.state.load();

      const result = await checked({ workerId: 'worker-1', since: sinceIso() });
      expect(result.peerDeclared).toEqual([]);
    });

    it('does not throw on junk step data and adds no entry for it', async () => {
      setupLanding();
      // newFiles/modifiedFiles are non-arrays; null is the one shape collectTaskPathTiers
      // already tolerates, so this pins that the editing marks add nothing of their own.
      h.createTask({ id: 'task-junk', status: 'WORKING', assignedWorkerId: 'worker-live', declaredFiles: ['ok/declared.ts'],
        implementationPlan: [{
          stepId: 's1', description: 'j', status: 'IN_PROGRESS',
          affectedFiles: ['/abs.ts', '../up.ts', 42, 'ok/fine.ts'], newFiles: null, modifiedFiles: false,
        }] } as unknown as Parameters<typeof h.createTask>[0]);
      h.createTask({ id: 'task-noplan', status: 'WORKING', assignedWorkerId: 'worker-live', declaredFiles: ['ok/np.ts'],
        implementationPlan: 'garbage' } as unknown as Parameters<typeof h.createTask>[0]);
      await h.state.load();

      const result = await checked({ workerId: 'worker-1', since: sinceIso() });
      expect(result.peerDeclared.map((e) => [e.path, e.taskIds, e.editingTaskIds])).toEqual([
        ['ok/declared.ts', ['task-junk'], []],
        ['ok/fine.ts', ['task-junk'], ['task-junk']],
        ['ok/np.ts', ['task-noplan'], []],
      ]);
    });

    it('survives a peer whose step file lists are a number, an object and a string', async () => {
      setupLanding();
      h.createTask({ id: 'task-junk-lists', status: 'WORKING', assignedWorkerId: 'worker-live', declaredFiles: ['ok/peer.ts'],
        implementationPlan: [{
          stepId: 's1', description: 'j', status: 'PENDING',
          newFiles: 7, modifiedFiles: { a: 1 }, affectedFiles: 'src/str.ts',
        }] } as unknown as Parameters<typeof h.createTask>[0]);
      await h.state.load();

      const result = await checked({ workerId: 'worker-1', since: sinceIso() });
      expect(result.peerDeclared.map((e) => [e.path, e.taskIds])).toEqual([
        ['ok/peer.ts', ['task-junk-lists']],
      ]);
    });
  });

  describe('assigneeProtected', () => {
    // A landing session that is not the assignee leaves the task's source paths
    // alone while this is true, and lands only on a JSON false. A quiet build is
    // not a death, so presence (assigneeAlive) must never decide it.
    const STALE = '2020-01-01T00:00:00.000Z';
    const OPEN_PHASES = ['running', 'finalizing', 'reconciling'] as const;

    function ownedTask(id: string, assignedWorkerId: string | null): void {
      h.createTask({ id, status: 'WORKING', assignedWorkerId });
    }

    const open = (taskId: string, workerId: string) =>
      openAttempt(h.state, { taskId, workerId, runnerId: workerId, workspace: h.testDir });

    async function ready(): Promise<void> {
      h.setupMoeFolder();
      h.createEpic();
    }

    it('is false for an unassigned task, even when a former worker left an open attempt on it', async () => {
      await ready();
      ownedTask('task-1', null);
      ownedTask('task-2', null);
      await h.state.load();
      await open('task-1', 'worker-former');

      const result = await scope({ workerId: 'worker-other' });
      expect(result.assignedWorkerId).toBeNull();
      expect(result.assigneeProtected).toBe(false);

      // An empty id patched in memory is unassigned too (isTaskClaimable's reading).
      const task = h.state.tasks.get('task-2')!;
      h.state.tasks.set('task-2', { ...task, assignedWorkerId: '' as unknown as null });
      await open('task-2', 'worker-former');
      expect((await scope({ taskId: 'task-2', workerId: 'worker-other' })).assigneeProtected).toBe(false);
    });

    it('is true for a registered non-DEAD owner however stale its presence; assigneeAlive can be false', async () => {
      await ready();
      ownedTask('task-1', 'worker-fresh');
      ownedTask('task-2', 'worker-stale');
      ownedTask('task-3', 'worker-garbage');
      h.createWorker({ id: 'worker-fresh', status: 'CODING', lastActivityAt: new Date().toISOString() });
      h.createWorker({ id: 'worker-stale', status: 'IDLE', lastActivityAt: STALE });
      h.createWorker({ id: 'worker-garbage', status: 'READING_CONTEXT', lastActivityAt: 'garbage' });
      await h.state.load();

      // A foreign caller, so nothing refreshes the owner's lastActivityAt first.
      const fresh = await scope({ taskId: 'task-1', workerId: 'worker-other' });
      expect([fresh.assigneeAlive, fresh.assigneeProtected]).toEqual([true, true]);
      const stale = await scope({ taskId: 'task-2', workerId: 'worker-other' });
      expect([stale.assigneeAlive, stale.assigneeProtected]).toEqual([false, true]);
      const garbage = await scope({ taskId: 'task-3' });
      expect([garbage.assigneeAlive, garbage.assigneeProtected]).toEqual([false, true]);
    });

    it.each(['IDLE', 'READING_CONTEXT', 'PLANNING', 'AWAITING_APPROVAL', 'CODING', 'BLOCKED', 'GOVERNING'] as const)(
      'is true for a stale owner whose status is %s',
      async (status) => {
        await ready();
        ownedTask('task-1', 'worker-owner');
        h.createWorker({ id: 'worker-owner', status, lastActivityAt: STALE });
        await h.state.load();
        expect((await scope({ workerId: 'worker-other' })).assigneeProtected).toBe(true);
      }
    );

    it('is false for a DEAD owner and for a missing owner when no attempt exists', async () => {
      await ready();
      ownedTask('task-1', 'worker-dead');
      ownedTask('task-2', 'worker-missing');
      h.createWorker({ id: 'worker-dead', status: 'DEAD', lastActivityAt: new Date().toISOString() });
      await h.state.load();

      expect((await scope({ taskId: 'task-1', workerId: 'worker-other' })).assigneeProtected).toBe(false);
      expect((await scope({ taskId: 'task-2', workerId: 'worker-other' })).assigneeProtected).toBe(false);
    });

    describe.each(['DEAD', 'missing'] as const)('a %s owner holding its own attempt', (ownerKind) => {
      it.each(OPEN_PHASES)('is true while the attempt is %s', async (phase) => {
        await ready();
        ownedTask('task-1', 'worker-owner');
        if (ownerKind === 'DEAD') h.createWorker({ id: 'worker-owner', status: 'DEAD' });
        await h.state.load();
        const attempt = await open('task-1', 'worker-owner');
        if (phase !== 'running') await setAttemptPhase(h.state, attempt.id, phase);

        expect((await scope({ workerId: 'worker-other' })).assigneeProtected).toBe(true);
      });

      it('is false once that attempt is closed', async () => {
        await ready();
        ownedTask('task-1', 'worker-owner');
        if (ownerKind === 'DEAD') h.createWorker({ id: 'worker-owner', status: 'DEAD' });
        await h.state.load();
        await setAttemptPhase(h.state, (await open('task-1', 'worker-owner')).id, 'closed');

        expect((await scope({ workerId: 'worker-other' })).assigneeProtected).toBe(false);
      });
    });

    it('ignores attempts that are not an open attempt of this assignee on this task', async () => {
      await ready();
      for (const id of ['task-a', 'task-b', 'task-c', 'task-d']) ownedTask(id, 'worker-owner');
      ownedTask('task-elsewhere', 'worker-someone');
      await h.state.load();

      // (a) only the owner's closed attempt
      await setAttemptPhase(h.state, (await open('task-a', 'worker-owner')).id, 'closed');
      // (b) an open attempt on this task by a different worker
      await open('task-b', 'worker-other');
      // (c) the owner's open attempt, but on a different task
      await open('task-elsewhere', 'worker-owner');
      // (d) the owner's closed attempt, then a foreign open one
      await setAttemptPhase(h.state, (await open('task-d', 'worker-owner')).id, 'closed');
      await open('task-d', 'worker-other');

      for (const taskId of ['task-a', 'task-b', 'task-c', 'task-d']) {
        const result = await scope({ taskId, workerId: 'worker-caller' });
        expect([taskId, result.assigneeProtected]).toEqual([taskId, false]);
      }
    });

    it('is true when the owner holds an open attempt next to a foreign open one, or a corrupt generation', async () => {
      await ready();
      ownedTask('task-1', 'worker-owner');
      ownedTask('task-2', 'worker-owner');
      await h.state.load();
      // openAttempt allows one open attempt per task, so a second open is a
      // hand-edited or crash-damaged store: patch it in directly.
      const first = await open('task-1', 'worker-owner');
      h.state.attempts.set('attempt-foreign', { ...first, id: 'attempt-foreign', workerId: 'worker-other', generation: first.generation + 1 });
      const second = await open('task-2', 'worker-owner');
      h.state.attempts.set(second.id, { ...second, generation: 'garbage' as unknown as number });
      h.state.attempts.set('attempt-foreign-2', { ...second, id: 'attempt-foreign-2', taskId: 'task-2', workerId: 'worker-other', generation: 7 });

      expect((await scope({ taskId: 'task-1', workerId: 'worker-caller' })).assigneeProtected).toBe(true);
      expect((await scope({ taskId: 'task-2', workerId: 'worker-caller' })).assigneeProtected).toBe(true);
    });

    it('fails closed on malformed records instead of throwing', async () => {
      await ready();
      ownedTask('task-1', 'worker-owner');
      ownedTask('task-2', 'worker-nostatus');
      ownedTask('task-3', 'worker-owner');
      h.createWorker({ id: 'worker-nostatus', status: 'IDLE', lastActivityAt: STALE });
      await h.state.load();

      // An unknown, hand-edited phase counts as open.
      const attempt = await open('task-1', 'worker-owner');
      h.state.attempts.set(attempt.id, { ...attempt, phase: 'paused' as unknown as 'running' });
      expect((await scope({ taskId: 'task-1', workerId: 'worker-caller' })).assigneeProtected).toBe(true);

      // A worker record that lost its status is not DEAD.
      const worker = h.state.workers.get('worker-nostatus')!;
      h.state.workers.set('worker-nostatus', { ...worker, status: undefined as unknown as 'IDLE' });
      expect((await scope({ taskId: 'task-2', workerId: 'worker-caller' })).assigneeProtected).toBe(true);

      // A non-string assignee id is unreadable, not "unassigned".
      const task = h.state.tasks.get('task-3')!;
      h.state.tasks.set('task-3', { ...task, assignedWorkerId: 42 as unknown as string });
      expect((await scope({ taskId: 'task-3', workerId: 'worker-caller' })).assigneeProtected).toBe(true);
    });

    it('is independent of the caller (the owner calling last, since a call refreshes its presence)', async () => {
      await ready();
      ownedTask('task-1', 'worker-quiet');
      ownedTask('task-2', 'worker-dead');
      h.createWorker({ id: 'worker-quiet', status: 'CODING', lastActivityAt: STALE });
      h.createWorker({ id: 'worker-dead', status: 'DEAD' });
      await h.state.load();

      for (const [taskId, owner, expected] of [['task-1', 'worker-quiet', true], ['task-2', 'worker-dead', false]] as const) {
        const foreign = await scope({ taskId, workerId: 'worker-other' });
        const absent = await scope({ taskId });
        const self = await scope({ taskId, workerId: owner });
        expect([foreign.assigneeProtected, absent.assigneeProtected, self.assigneeProtected]).toEqual([expected, expected, expected]);
      }
    });

    it('adds only the assigneeProtected and finalizingAttempt keys to the reply', async () => {
      await ready();
      ownedTask('task-1', 'worker-owner');
      h.createWorker({ id: 'worker-owner', status: 'CODING' });
      await h.state.load();

      const result = await scope();
      expect(Object.keys(result).sort()).toEqual([
        'activePeerIds', 'alwaysInclude', 'asserted', 'assignedWorkerId', 'assigneeAlive', 'assigneeProtected',
        'declared', 'epicId', 'excludePrefixes', 'finalizingAttempt', 'inferredPaths', 'livePeerIds', 'peerDeclared', 'peersActive',
        'planned', 'policy', 'reopenCount', 'status', 'taskId', 'title', 'touchedFiles', 'unattributedPaths',
      ].sort());
    });
  });

  describe('finalizingAttempt', () => {
    // The finalizing hold claim_next_task enforces, named whoever holds it, the
    // caller included: the wrapper's owner guard compares workerId to itself.
    const open = (taskId: string, workerId: string) =>
      openAttempt(h.state, { taskId, workerId, runnerId: workerId, workspace: h.testDir });

    beforeEach(async () => {
      h.setupMoeFolder();
      h.createEpic();
      h.createTask({ id: 'task-1', status: 'REVIEW', assignedWorkerId: null });
      h.createTask({ id: 'task-2', status: 'REVIEW', assignedWorkerId: null });
      await h.state.load();
    });

    async function finalizing(taskId = 'task-1', workerId = 'worker-done') {
      const attempt = await open(taskId, workerId);
      return await setAttemptPhase(h.state, attempt.id, 'finalizing');
    }

    it('is null with no attempts, and for running, reconciling and closed attempts', async () => {
      expect((await scope()).finalizingAttempt).toBeNull();
      const attempt = await open('task-1', 'worker-done');
      expect((await scope()).finalizingAttempt).toBeNull();
      await setAttemptPhase(h.state, attempt.id, 'reconciling');
      expect((await scope()).finalizingAttempt).toBeNull();
      await setAttemptPhase(h.state, attempt.id, 'closed');
      expect((await scope()).finalizingAttempt).toBeNull();
    });

    it('names exactly the finalizing attempt, whoever asks', async () => {
      const a = await finalizing();
      const expected = { attemptId: a.id, workerId: 'worker-done', generation: a.generation };

      expect((await scope({ workerId: 'worker-other' })).finalizingAttempt).toStrictEqual(expected);
      expect((await scope()).finalizingAttempt).toStrictEqual(expected);
      expect((await scope({ workerId: 'worker-done' })).finalizingAttempt).toStrictEqual(expected);
      expect((await scope({ taskId: 'task-2' })).finalizingAttempt).toBeNull();
    });

    it('skips malformed finalizing records', async () => {
      const a = await finalizing();
      const named = { attemptId: a.id, workerId: 'worker-done', generation: a.generation };
      expect((await scope()).finalizingAttempt).toStrictEqual(named);

      h.state.attempts.set(a.id, { ...a, workerId: '  ' });
      expect((await scope()).finalizingAttempt).toBeNull();
      h.state.attempts.set(a.id, { ...a, generation: 0 });
      expect((await scope()).finalizingAttempt).toBeNull();
      h.state.attempts.set(a.id, { ...a, generation: 1.5 });
      expect((await scope()).finalizingAttempt).toBeNull();
      h.state.attempts.set(a.id, { ...a, id: '' });
      expect((await scope()).finalizingAttempt).toBeNull();
    });

    it('keeps the highest generation when two are finalizing', async () => {
      const a = await finalizing();
      h.state.attempts.set('attempt-high', { ...a, id: 'attempt-high', workerId: 'worker-high', generation: 9 });
      h.state.attempts.set('attempt-low', { ...a, id: 'attempt-low', workerId: 'worker-low', generation: 2 });

      expect((await scope()).finalizingAttempt).toStrictEqual({
        attemptId: 'attempt-high', workerId: 'worker-high', generation: 9,
      });
    });
  });
});
