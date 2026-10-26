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
  asserted: string[];
  declared: string[];
  planned: string[];
  touchedFiles: string[];
  inferredPaths: string[];
  unattributedPaths: string[];
  peerDeclared: { path: string; taskId: string; peerActive: boolean }[];
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
      const byPath = flags(await scope({ workerId: 'worker-1', since }));
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

      const byPath = flags(await scope({ workerId: 'worker-1', since: new Date(sinceMs).toISOString() }));
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

      const byPath = flags(await scope({ workerId: 'worker-1', since: new Date(sinceMs).toISOString() }));
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

      const result = await scope({ workerId: 'worker-1' });
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

        const result = await scope({ workerId: 'worker-1', since: new Date(Date.now() - 5 * 60_000).toISOString() });
        expect(result.peerDeclared).toEqual([{ path: 'src/shared.ts', taskId: 'task-p1', peerActive: true }]);
      }
    });
  });
});
