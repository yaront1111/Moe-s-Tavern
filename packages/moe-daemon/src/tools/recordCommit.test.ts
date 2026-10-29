import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ToolTestHarness } from './toolTestHarness.js';
import { recordCommitTool, resetRecordCommitGovernorRateLimit } from './recordCommit.js';
import { declareFilesTool } from './declareFiles.js';
import { getActivityLogTool } from './getActivityLog.js';
import { getTools } from './index.js';
import { MAX_COMMITS_PER_TASK } from '../state/validators.js';
import { buildReopenClearingUpdates } from '../util/reopen.js';
import { completionCommitsForReview } from '../delivery/policy.js';
import type { TaskCommit } from '../types/schema.js';

interface RecordResult {
  success: boolean;
  taskId: string;
  sha?: string;
  kind: string;
  outcome: string;
  duplicate: boolean;
  commitCount: number;
  filesModified: string[];
  addedPaths: string[];
  warning?: string;
}

const SHA_A = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const SHA_B = 'b2c3d4e5f60718293a4b5c6d7e8f9012345678a1';

describe('moe.record_commit', () => {
  const h = new ToolTestHarness();
  beforeEach(() => { h.init(); resetRecordCommitGovernorRateLimit(); });
  afterEach(() => { vi.restoreAllMocks(); h.cleanup(); });

  const base = {
    taskId: 'task-1',
    outcome: 'committed',
    kind: 'completion',
    role: 'worker',
    workerId: 'worker-1',
    sessionId: 'worker-1@2026-08-28T10:00:00.000Z',
    sha: SHA_A,
    ref: 'moe/work-2026-08-28',
    status: 'REVIEW',
    pushed: true,
  };

  async function record(args: Record<string, unknown> = {}): Promise<RecordResult> {
    return await recordCommitTool(h.state).handler({ ...base, ...args }, h.state) as RecordResult;
  }

  async function seed(taskOverrides: Record<string, unknown> = {}) {
    h.setupMoeFolder();
    h.createEpic();
    h.createTask({ id: 'task-1', status: 'REVIEW', assignedWorkerId: 'qa-1', filesModified: ['src/existing.ts'], ...taskOverrides });
    h.createWorker({ id: 'worker-1', status: 'IDLE', lastActivityAt: '2020-01-01T00:00:00.000Z' });
    await h.state.load();
  }

  it('is registered in getTools()', () => {
    expect(getTools(h.state).map((t) => t.name)).toContain('moe.record_commit');
  });

  it('appends a TaskCommit and unions the non-inferred paths into filesModified', async () => {
    await seed();
    const result = await record({
      treeId: SHA_B,
      paths: ['./src/a.ts', 'src\\b.ts', 'src/measured.ts', 'src/existing.ts'],
      inferredPaths: ['src/measured.ts'],
      touchedPaths: ['src/a.ts', 'src/tool-only.ts'],
      unattributedPaths: ['src/foreign.ts'],
      contested: [{ path: 'src/b.ts', taskId: 'task-peer' }],
      skipped: [{ path: 'src/skip.ts', code: 'MOE_ATTR_PREEXISTING' }],
      cliExitCode: 0,
      message: 'feat(task-1): thing',
    });

    expect(result.success).toBe(true);
    expect(result.duplicate).toBe(false);
    expect(result.commitCount).toBe(1);
    expect(result.sha).toBe(SHA_A);
    expect(result.addedPaths).toEqual(['src/a.ts', 'src/b.ts']);
    expect(result.filesModifiedCount).toBe(3);
    expect(result).not.toHaveProperty('filesModified');
    expect(h.state.getTask('task-1')!.filesModified).toEqual(['src/existing.ts', 'src/a.ts', 'src/b.ts']);

    const task = h.state.getTask('task-1')!;
    const commit = task.commits![0];
    expect(commit).toMatchObject({
      sha: SHA_A,
      treeId: SHA_B,
      ref: 'moe/work-2026-08-28',
      kind: 'completion',
      status: 'REVIEW',
      role: 'worker',
      sessionId: base.sessionId,
      paths: ['src/a.ts', 'src/b.ts', 'src/measured.ts', 'src/existing.ts'],
      inferredPaths: ['src/measured.ts'],
      contested: [{ path: 'src/b.ts', taskId: 'task-peer' }],
      pushed: true,
      recordedBy: 'worker-1',
      message: 'feat(task-1): thing',
    });
    expect(commit.pathsTruncated).toBeUndefined();
    expect(typeof commit.recordedAt).toBe('string');
    // MEASURED never promotes to the asserted tier.
    expect(task.filesModified).not.toContain('src/measured.ts');
    expect(task.inferredPaths).toEqual(['src/measured.ts']);
    expect(task.touchedFiles).toEqual(['src/a.ts', 'src/tool-only.ts']);
    expect(task.unattributedPaths).toEqual(['src/foreign.ts']);
    expect(task.lastCommitOutcome).toMatchObject({ outcome: 'committed', kind: 'completion', sessionId: base.sessionId });
    expect(task.lastCommitOutcome!.code).toBeUndefined();
    // Liveness touch on the caller.
    expect(Date.parse(h.state.getWorker('worker-1')!.lastActivityAt)).toBeGreaterThan(Date.parse('2021-01-01T00:00:00.000Z'));
  });

  it('is idempotent by sha (exact or abbreviated) within a kind and only ever upgrades pushed/treeId', async () => {
    await seed();
    await record({ paths: ['src/a.ts'], pushed: false });
    const dup = await record({ sha: SHA_A.slice(0, 12), paths: ['src/a.ts', 'src/c.ts'], pushed: true, treeId: SHA_B });

    expect(dup.duplicate).toBe(true);
    expect(dup.commitCount).toBe(1);
    expect(dup.addedPaths).toEqual(['src/c.ts']);
    const commit = h.state.getTask('task-1')!.commits![0];
    expect(commit.sha).toBe(SHA_A);
    expect(commit.pushed).toBe(true);
    expect(commit.treeId).toBe(SHA_B);
    // The original entry's paths are history; not rewritten.
    expect(commit.paths).toEqual(['src/a.ts']);

    // A later pushed:false never downgrades.
    await record({ pushed: false });
    expect(h.state.getTask('task-1')!.commits![0].pushed).toBe(true);
  });

  it('records completion of an already checkpointed SHA without rewriting its history', async () => {
    await seed({ reviewStartedAt: '2026-09-27T08:54:00.000Z' });
    vi.spyOn(Date.prototype, 'toISOString').mockReturnValue('2026-09-27T08:34:00.000Z');
    await record({ kind: 'checkpoint', status: 'BLOCKED', pushed: false, paths: ['src/a.ts'] });
    const checkpoint = structuredClone(h.state.getTask('task-1')!.commits![0]);
    expect(completionCommitsForReview(h.state.getTask('task-1')!)).toEqual([]);

    vi.spyOn(Date.prototype, 'toISOString').mockReturnValue('2026-09-27T09:07:00.000Z');
    const completion = await record({ sha: SHA_A.slice(0, 12), paths: ['src/a.ts'], pushed: true });
    expect(completion.duplicate).toBe(false);
    expect(completion.commitCount).toBe(2);
    const commits = h.state.getTask('task-1')!.commits!;
    expect(commits[0]).toEqual(checkpoint);
    expect(commits[1]).toMatchObject({ kind: 'completion', status: 'REVIEW', pushed: true,
      recordedAt: '2026-09-27T09:07:00.000Z', sessionId: base.sessionId });
    expect(completionCommitsForReview(h.state.getTask('task-1')!)).toEqual([commits[1]]);

    // Exact/abbreviated replays merge only their own kind; a stale checkpoint
    // cannot overwrite completion provenance or downgrade its pushed state.
    expect((await record({ sha: SHA_A, pushed: false })).duplicate).toBe(true);
    expect((await record({ kind: 'checkpoint', pushed: false })).duplicate).toBe(true);
    expect(h.state.getTask('task-1')!.commits).toEqual(commits);
  });

  it('does not inherit rescue push or ref evidence when the same SHA is later completed', async () => {
    await seed();
    await record({ kind: 'rescue', ref: 'refs/moe/rescue/task-1/stamp', pushed: true });
    const rescue = structuredClone(h.state.getTask('task-1')!.commits![0]);
    expect(completionCommitsForReview(h.state.getTask('task-1')!)).toEqual([]);
    await record({ pushed: undefined });
    const commits = h.state.getTask('task-1')!.commits!;
    expect(commits).toHaveLength(2);
    expect(commits[0]).toEqual(rescue);
    expect(commits[1].kind).toBe('completion');
    expect(commits[1].ref).toBe(base.ref);
    expect(commits[1].pushed).toBeUndefined();
  });

  it(`caps the ledger at MAX_COMMITS_PER_TASK (${MAX_COMMITS_PER_TASK}), newest kept`, async () => {
    await seed();
    const total = MAX_COMMITS_PER_TASK + 2;
    for (let i = 0; i < total; i++) {
      const sha = (i + 1).toString(16).padStart(8, '0') + 'abcdef01';
      await record({ sha, kind: 'checkpoint', paths: [] });
    }
    const commits = h.state.getTask('task-1')!.commits!;
    expect(commits).toHaveLength(MAX_COMMITS_PER_TASK);
    expect(commits[0].sha).toBe((3).toString(16).padStart(8, '0') + 'abcdef01');
    expect(commits[commits.length - 1].sha).toBe(total.toString(16).padStart(8, '0') + 'abcdef01');
  });

  it('records lastCommitOutcome for refused/failed/nothing without appending a commit', async () => {
    await seed();
    const refused = await record({ outcome: 'refused', sha: undefined, ref: undefined, code: 'MOE_COMMIT_REFUSED_NO_OWNED_PATHS', paths: [] });
    expect(refused.success).toBe(true);
    expect(refused.commitCount).toBe(0);
    expect(refused.sha).toBeUndefined();
    expect(h.state.getTask('task-1')!.commits ?? []).toEqual([]);
    expect(h.state.getTask('task-1')!.lastCommitOutcome).toMatchObject({
      outcome: 'refused', kind: 'completion', code: 'MOE_COMMIT_REFUSED_NO_OWNED_PATHS', sessionId: base.sessionId,
    });
    // Refusal paths are NOT unioned into filesModified.
    expect(h.state.getTask('task-1')!.filesModified).toEqual(['src/existing.ts']);

    await record({ outcome: 'failed', kind: 'checkpoint', sha: undefined, ref: undefined, code: 'MOE_COMMIT_FAILED_REF_CONTENTION', message: 'update-ref lost 3 times' });
    expect(h.state.getTask('task-1')!.lastCommitOutcome).toMatchObject({ outcome: 'failed', kind: 'checkpoint', code: 'MOE_COMMIT_FAILED_REF_CONTENTION' });

    await record({ outcome: 'nothing', kind: 'checkpoint', sha: undefined, ref: undefined, code: 'MOE_COMMIT_NOTHING_TO_COMMIT', unattributedPaths: [] });
    expect(h.state.getTask('task-1')!.lastCommitOutcome).toMatchObject({ outcome: 'nothing', kind: 'checkpoint' });
    expect(h.state.getTask('task-1')!.commits ?? []).toEqual([]);
  });

  it('has no ownership guard and is allowed in DONE and BLOCKED', async () => {
    await seed({ status: 'DONE', assignedWorkerId: null });
    const done = await record({ status: 'DONE' });
    expect(done.success).toBe(true);
    expect(h.state.getTask('task-1')!.status).toBe('DONE');

    await h.state.updateTask('task-1', { status: 'BLOCKED', assignedWorkerId: 'someone-else', blockedReason: 'x', blockedFromStatus: 'WORKING' });
    const blocked = await record({ sha: SHA_B, kind: 'checkpoint', status: 'BLOCKED', workerId: 'worker-1' });
    expect(blocked.success).toBe(true);
    expect(blocked.commitCount).toBe(2);
    const task = h.state.getTask('task-1')!;
    expect(task.status).toBe('BLOCKED');
    expect(task.assignedWorkerId).toBe('someone-else');
    expect(task.blockedReason).toBe('x');
  });

  it('records the caller as recordedBy, or "unknown" when the call carries no workerId', async () => {
    await seed();
    await record({ workerId: undefined });
    expect(h.state.getTask('task-1')!.commits![0].recordedBy).toBe('unknown');
  });

  it('logs TASK_COMMIT_RECORDED to the activity log', async () => {
    await seed();
    await record({ paths: ['src/a.ts'] });
    await h.state.flushActivityLog();
    const log = await getActivityLogTool(h.state).handler({ eventTypes: ['TASK_COMMIT_RECORDED'] }, h.state) as {
      events: Array<{ event: string; taskId?: string }>;
    };
    expect(log.events.find((e) => e.event === 'TASK_COMMIT_RECORDED')?.taskId).toBe('task-1');
  });

  it('posts a task-channel line on every outcome and tolerates chat failures', async () => {
    await seed();
    const sys = vi.spyOn(h.state, 'postSystemMessage').mockRejectedValue(new Error('chat down'));
    const gov = vi.spyOn(h.state, 'postToRoleChannel').mockRejectedValue(new Error('chat down'));

    const ok = await record({ paths: ['src/a.ts'], unattributedPaths: ['src/foreign.ts'] });
    expect(ok.success).toBe(true);
    expect(sys).toHaveBeenCalledWith('task-1', expect.stringContaining('completion commit recorded for task-1'));
    expect(sys).toHaveBeenCalledWith('task-1', expect.stringContaining('MOE_ATTRIBUTION_UNRESOLVED task=task-1: src/foreign.ts'));
    expect(gov).toHaveBeenCalledWith('governors', expect.stringContaining('MOE_ATTRIBUTION_UNRESOLVED task=task-1'));
    expect(h.state.getTask('task-1')!.commits).toHaveLength(1);
  });

  it('rate-limits the #governors alert to once per task per window; the task channel gets every line', async () => {
    await seed();
    const sys = vi.spyOn(h.state, 'postSystemMessage').mockResolvedValue(undefined);
    const gov = vi.spyOn(h.state, 'postToRoleChannel').mockResolvedValue(undefined);

    // A clean committed outcome alerts nobody.
    await record({ paths: ['src/a.ts'] });
    expect(gov).not.toHaveBeenCalled();

    await record({ sha: SHA_B, kind: 'checkpoint', paths: ['src/a.ts'], unattributedPaths: ['src/x.ts'] });
    await record({ outcome: 'refused', sha: undefined, ref: undefined, code: 'MOE_COMMIT_REFUSED_OWNED_PATH_MISSING' });
    expect(gov).toHaveBeenCalledTimes(1);
    expect(gov.mock.calls[0][0]).toBe('governors');
    expect(sys).toHaveBeenCalledTimes(3);

    // A different task has its own window.
    h.createTask({ id: 'task-2', status: 'WORKING' });
    await h.state.load();
    await record({ taskId: 'task-2', outcome: 'failed', sha: undefined, ref: undefined, code: 'MOE_COMMIT_FAILED_REF_CONTENTION' });
    expect(gov).toHaveBeenCalledTimes(2);

    resetRecordCommitGovernorRateLimit();
    await record({ outcome: 'refused', sha: undefined, ref: undefined, code: 'MOE_COMMIT_REFUSED_OWNED_PATH_MISSING' });
    expect(gov).toHaveBeenCalledTimes(3);
  });

  it('announces a landed rescue ref with the MOE_RESCUE_REF line (task channel + governors)', async () => {
    await seed();
    const sys = vi.spyOn(h.state, 'postSystemMessage').mockResolvedValue(undefined);
    const gov = vi.spyOn(h.state, 'postToRoleChannel').mockResolvedValue(undefined);
    const ref = 'refs/moe/rescue/task-1/20260828T100000Z';

    await record({ kind: 'rescue', ref, status: 'WORKING', pushed: false, code: 'gate-failed', paths: ['src/a.ts'] });
    const line = `MOE_RESCUE_REF task=task-1 ref=${ref} sha=${SHA_A} reason=gate-failed`;
    expect(sys).toHaveBeenCalledWith('task-1', expect.stringContaining(line));
    expect(gov).toHaveBeenCalledWith('governors', expect.stringContaining(line));
    expect(h.state.getTask('task-1')!.commits![0]).toMatchObject({ kind: 'rescue', ref, pushed: false });

    // A rescue attempt that found nothing is not an alert.
    gov.mockClear();
    resetRecordCommitGovernorRateLimit();
    await record({ kind: 'rescue', outcome: 'nothing', sha: undefined, ref: undefined, code: 'teardown' });
    expect(gov).not.toHaveBeenCalled();
  });

  it('keeps stored unattributedPaths when the field is omitted and clears them on an explicit []', async () => {
    await seed({ unattributedPaths: ['src/old.ts'] });
    await record({ paths: ['src/a.ts'] });
    expect(h.state.getTask('task-1')!.unattributedPaths).toEqual(['src/old.ts']);
    await record({ sha: SHA_B, kind: 'checkpoint', paths: ['src/a.ts'], unattributedPaths: [] });
    expect(h.state.getTask('task-1')!.unattributedPaths).toEqual([]);
  });

  it('warns on a completion with no paths and drops (not rejects) un-storable paths', async () => {
    await seed();
    const empty = await record({ paths: [] });
    expect(empty.warning).toContain('no paths');

    const junk = await record({ sha: SHA_B, kind: 'checkpoint', paths: ['/abs/x.ts', '../up.ts', 'ok.ts', 42] });
    expect(junk.success).toBe(true);
    expect(junk.warning).toContain('3 path entries dropped');
    expect(h.state.getTask('task-1')!.commits![1].paths).toEqual(['ok.ts']);
  });

  it('flags pathsTruncated past 500 paths', async () => {
    await seed();
    const paths = Array.from({ length: 503 }, (_, i) => `src/gen/file-${i}.ts`);
    const result = await record({ paths });
    expect(result.warning).toContain('truncated');
    const commit = h.state.getTask('task-1')!.commits![0] as TaskCommit;
    expect(commit.paths).toHaveLength(500);
    expect(commit.pathsTruncated).toBe(true);
  });

  it('the ledger and attribution evidence survive a qa_reject reopen (history, not completion evidence)', async () => {
    await seed({ reviewStartedAt: '2026-08-28T10:00:00.000Z', completedAt: '2026-08-28T10:00:00.000Z' });
    await record({ paths: ['src/a.ts'], inferredPaths: [], unattributedPaths: ['src/u.ts'], touchedPaths: ['src/t.ts'] });
    const task = h.state.getTask('task-1')!;
    const clearing = buildReopenClearingUpdates(task);
    for (const key of ['commits', 'filesModified', 'declaredFiles', 'touchedFiles', 'inferredPaths', 'unattributedPaths', 'lastCommitOutcome'] as const) {
      expect(Object.prototype.hasOwnProperty.call(clearing, key)).toBe(false);
    }
    // reviewStartedAt IS cleared, which is what makes an old completion commit stale for qa_approve.
    expect(clearing.reviewStartedAt).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(clearing, 'reviewStartedAt')).toBe(true);
  });

  it('validates required fields and shapes', async () => {
    await seed();
    const tool = recordCommitTool(h.state);
    await expect(tool.handler({ ...base, taskId: undefined }, h.state)).rejects.toThrow('Missing required field: taskId');
    await expect(tool.handler({ ...base, outcome: undefined }, h.state)).rejects.toThrow('Missing required field: outcome');
    await expect(tool.handler({ ...base, outcome: 'maybe' }, h.state)).rejects.toThrow('outcome');
    await expect(tool.handler({ ...base, kind: 'wip' }, h.state)).rejects.toThrow('kind');
    await expect(tool.handler({ ...base, role: '' }, h.state)).rejects.toThrow('Missing required field: role');
    await expect(tool.handler({ ...base, sessionId: undefined }, h.state)).rejects.toThrow('Missing required field: sessionId');
    await expect(tool.handler({ ...base, sha: undefined }, h.state)).rejects.toThrow('Missing required field: sha');
    await expect(tool.handler({ ...base, ref: undefined }, h.state)).rejects.toThrow('Missing required field: ref');
    await expect(tool.handler({ ...base, sha: 'xyz' }, h.state)).rejects.toThrow('sha');
    await expect(tool.handler({ ...base, paths: 'src/a.ts' }, h.state)).rejects.toThrow('paths');
    await expect(tool.handler({ ...base, pushed: 'yes' }, h.state)).rejects.toThrow('pushed');
    await expect(tool.handler({ ...base, cliExitCode: 1.5 }, h.state)).rejects.toThrow('cliExitCode');
    await expect(tool.handler({ ...base, taskId: 'nope' }, h.state)).rejects.toThrow('Task not found');
    // Nothing was written by the rejected calls.
    expect(h.state.getTask('task-1')!.commits).toBeUndefined();
  });

  describe('held contested paths (MOE_CONTESTED_HELD)', () => {
    const UNTOUCHED = (peer: string) => `MOE_ATTR_CONTESTED_UNTOUCHED(${peer})`;
    let sys: ReturnType<typeof vi.spyOn>;
    let gov: ReturnType<typeof vi.spyOn>;

    async function seedSpied(taskOverrides: Record<string, unknown> = {}) {
      await seed(taskOverrides);
      sys = vi.spyOn(h.state, 'postSystemMessage').mockResolvedValue(undefined);
      gov = vi.spyOn(h.state, 'postToRoleChannel').mockResolvedValue(undefined);
    }
    const taskText = () => sys.mock.calls.map((c) => String(c[1])).join('\n');

    it('reports an untouched hold on a committed landing with no unattributed paths, and alerts #governors once', async () => {
      await seedSpied();
      await record({ paths: ['src/a.ts'], skipped: [{ path: 'src/held.ts', code: UNTOUCHED('task-peer') }] });
      const line = taskText().split('\n').find((l) => l.startsWith('MOE_CONTESTED_HELD'));
      expect(line).toContain('MOE_CONTESTED_HELD task=task-1: src/held.ts(task-peer) — ');
      expect(line).toContain('wrapper-observed successful editing tool');
      expect(line).toContain('own assignee session');
      expect(line).toContain('not a shell write');
      expect(line).toContain('legitimately completed or archived');
      expect(line).toContain('declare_files, unblocking or a shell touch alone does not release');
      expect(line).not.toContain('attribution.contested=skip');
      expect(gov).toHaveBeenCalledTimes(1);
      expect(gov).toHaveBeenCalledWith('governors', expect.stringContaining(line!));
    });

    it('reports a strict hold on a nothing outcome with the peer-only remedy, and "?" when no contested entry names the path', async () => {
      await seedSpied();
      await record({
        outcome: 'nothing', kind: 'checkpoint', sha: undefined, ref: undefined, code: 'MOE_COMMIT_NOTHING_TO_COMMIT',
        skipped: [{ path: './src/strict.ts', code: 'MOE_ATTR_CONTESTED' }, { path: 'src/orphan.ts', code: 'MOE_ATTR_CONTESTED' }],
        contested: [{ path: 'src/other.ts', taskId: 'task-x' }, { path: 'src\\strict.ts', taskId: 'task-peer2' }],
      });
      const line = taskText().split('\n').find((l) => l.startsWith('MOE_CONTESTED_HELD'))!;
      expect(line).toContain('MOE_CONTESTED_HELD task=task-1: src/strict.ts(task-peer2), src/orphan.ts(?) — ');
      expect(line).toContain('attribution.contested=skip');
      expect(line).toContain('only resolving or legitimately completing or archiving the peer task releases it');
      expect(line).not.toContain('editing tool');
      expect(line).toContain('never change the policy');
      expect(gov).toHaveBeenCalledWith('governors', expect.stringContaining('MOE_CONTESTED_HELD task=task-1'));
      expect(h.state.getTask('task-1')!.lastCommitOutcome).toMatchObject({ outcome: 'nothing', code: 'MOE_COMMIT_NOTHING_TO_COMMIT' });
    });

    it('reports a hold on refused and failed outcomes too', async () => {
      await seedSpied();
      await record({ outcome: 'refused', sha: undefined, ref: undefined, code: 'MOE_COMMIT_REFUSED_NO_OWNED_PATHS',
        skipped: [{ path: 'src/only.ts', code: UNTOUCHED('task-peer') }] });
      await record({ outcome: 'failed', sha: undefined, ref: undefined, code: 'MOE_COMMIT_FAILED_REF_CONTENTION',
        skipped: [{ path: 'src/only.ts', code: UNTOUCHED('task-peer') }] });
      expect(taskText().match(/MOE_CONTESTED_HELD task=task-1: src\/only\.ts\(task-peer\)/g)).toHaveLength(2);
    });

    it('never reports a contested path that landed (contested entry, no contested skip code)', async () => {
      await seedSpied();
      await record({ paths: ['src/b.ts'], contested: [{ path: 'src/b.ts', taskId: 'task-peer' }] });
      expect(taskText()).not.toContain('MOE_CONTESTED_HELD');
      expect(gov).not.toHaveBeenCalled();
    });

    it.each([
      'MOE_ATTR_PEER_DECLARED', 'MOE_ATTR_PREEXISTING', 'moe_attr_contested', 'MOE_ATTR_CONTESTEDX', 'XMOE_ATTR_CONTESTED',
      'MOE_ATTR_CONTESTED_UNTOUCHED', 'MOE_ATTR_CONTESTED_UNTOUCHED()', 'MOE_ATTR_CONTESTED_UNTOUCHED(peer)',
      'MOE_ATTR_CONTESTED_UNTOUCHED(task-a)x', 'MOE_ATTR_CONTESTED_UNTOUCHED(task-a)(task-b)', 'MOE_ATTR_CONTESTED_UNTOUCHED(task-a b)',
    ])('ignores the near-match or unrelated skip code %s', async (code) => {
      await seedSpied();
      await record({ paths: ['src/a.ts'], skipped: [{ path: 'src/held.ts', code }], contested: [{ path: 'src/held.ts', taskId: 'task-peer' }] });
      expect(taskText()).not.toContain('MOE_CONTESTED_HELD');
      expect(gov).not.toHaveBeenCalled();
    });

    it('ignores malformed skipped entries and still records the landing', async () => {
      await seedSpied();
      const code = UNTOUCHED('task-peer');
      const result = await record({
        paths: ['src/a.ts'],
        skipped: ['src/x.ts', null, [], { code }, { path: 'src/blank.ts', code: '  ' }, { path: 42, code },
          { path: '/etc/x', code }, { path: '../x', code }],
      });
      expect(result.success).toBe(true);
      expect(taskText()).not.toContain('MOE_CONTESTED_HELD');
      expect(gov).not.toHaveBeenCalled();
      expect(h.state.getTask('task-1')!.commits).toHaveLength(1);
    });

    it('shows at most 5 distinct held paths, then +N more', async () => {
      await seedSpied();
      const skipped = Array.from({ length: 7 }, (_, i) => ({ path: `src/h${i}.ts`, code: UNTOUCHED('task-peer') }));
      skipped.push({ path: './src/h0.ts', code: UNTOUCHED('task-other') });
      await record({ paths: ['src/a.ts'], skipped });
      const line = taskText().split('\n').find((l) => l.startsWith('MOE_CONTESTED_HELD'))!;
      expect(line.match(/\(task-peer\)/g)).toHaveLength(5);
      expect(line).toContain('src/h0.ts(task-peer), src/h1.ts(task-peer), src/h2.ts(task-peer), src/h3.ts(task-peer), src/h4.ts(task-peer) … (+2 more) — ');
      expect(line).not.toContain('task-other');
      expect(line).not.toContain('src/h5.ts');
    });

    it('shares the per-task #governors window with every other alert reason', async () => {
      await seedSpied();
      const held = { skipped: [{ path: 'src/held.ts', code: UNTOUCHED('task-peer') }] };
      await record({ paths: ['src/a.ts'], ...held });
      await record({ sha: SHA_B, kind: 'checkpoint', paths: ['src/a.ts'], ...held });
      expect(gov).toHaveBeenCalledTimes(1);
      expect(taskText().match(/MOE_CONTESTED_HELD task=task-1/g)).toHaveLength(2);

      h.createTask({ id: 'task-2', status: 'WORKING' });
      await h.state.load();
      await record({ taskId: 'task-2', paths: ['src/a.ts'], ...held });
      expect(gov).toHaveBeenCalledTimes(2);

      // An unattributed alert for task-1 falls in the held alert's window.
      await record({ sha: SHA_B, kind: 'checkpoint', paths: ['src/a.ts'], unattributedPaths: ['src/u.ts'] });
      expect(gov).toHaveBeenCalledTimes(2);

      resetRecordCommitGovernorRateLimit();
      await record({ paths: ['src/a.ts'], ...held });
      expect(gov).toHaveBeenCalledTimes(3);
    });

    it('a failed chat post never fails the call or changes the stored outcome', async () => {
      await seed();
      vi.spyOn(h.state, 'postSystemMessage').mockRejectedValue(new Error('chat down'));
      const rejected = vi.spyOn(h.state, 'postToRoleChannel').mockRejectedValue(new Error('chat down'));
      const result = await record({ paths: ['src/a.ts'], skipped: [{ path: 'src/held.ts', code: 'MOE_ATTR_CONTESTED' }] });
      expect(result.success).toBe(true);
      expect(rejected).toHaveBeenCalledTimes(1);
      const task = h.state.getTask('task-1')!;
      expect(task.commits).toHaveLength(1);
      expect(task.lastCommitOutcome).toMatchObject({ outcome: 'committed', kind: 'completion' });
    });

    it('leaves the ledger, path unions and response exactly as without the held entries', async () => {
      await seedSpied();
      h.createTask({ id: 'task-2', status: 'REVIEW', assignedWorkerId: 'qa-1', filesModified: ['src/existing.ts'] });
      await h.state.load();
      const args = { paths: ['src/a.ts', 'src/m.ts'], inferredPaths: ['src/m.ts'], unattributedPaths: [],
        contested: [{ path: 'src/held.ts', taskId: 'task-peer' }] };
      const plain = await record({ ...args });
      const withHeld = await record({ ...args, taskId: 'task-2',
        skipped: [{ path: 'src/held.ts', code: 'MOE_ATTR_CONTESTED' }, { path: 'src/h2.ts', code: UNTOUCHED('task-peer') }] });
      expect({ ...withHeld, taskId: 'task-1' }).toEqual(plain);
      const strip = (id: string) => {
        const t = h.state.getTask(id)!;
        const { recordedAt: _r, ...commit } = t.commits![0];
        return { commit, filesModified: t.filesModified, inferredPaths: t.inferredPaths, unattributedPaths: t.unattributedPaths };
      };
      expect(strip('task-2')).toEqual(strip('task-1'));
    });
  });
});

describe('moe.declare_files contested-hold caveat', () => {
  const h = new ToolTestHarness();
  beforeEach(async () => {
    h.init();
    h.setupMoeFolder();
    h.createEpic();
    h.createTask({ id: 'task-1', status: 'WORKING' });
    await h.state.load();
  });
  afterEach(() => { vi.restoreAllMocks(); h.cleanup(); });

  async function declare(paths: string[]) {
    return await declareFilesTool(h.state).handler({ taskId: 'task-1', paths }, h.state) as {
      declaredFiles: string[]; addedPaths: string[]; alreadyDeclared: string[]; message: string;
    };
  }

  it('the tool description says declaring does not release a contested hold', () => {
    const { description } = declareFilesTool(h.state);
    expect(description).toContain('regardless of the pre-task baseline');
    expect(description).toContain('does not override a contested hold');
    expect(description).toContain('MOE_ATTR_CONTESTED_UNTOUCHED(<peer>)');
    expect(description).toContain('MOE_CONTESTED_HELD');
  });

  it('unions exactly as before and the new-path message carries the caveat', async () => {
    const first = await declare(['src/a.ts']);
    expect(first.message).toContain('unless another open task also declares one (a contested hold; declaring does not release it)');
    const second = await declare(['src/a.ts', 'src/b.ts']);
    expect(second.declaredFiles).toEqual(['src/a.ts', 'src/b.ts']);
    expect(second.addedPaths).toEqual(['src/b.ts']);
    expect(second.alreadyDeclared).toEqual(['src/a.ts']);
    expect(second.message).toBe('Declared 1 new path(s) on task-1; the wrapper commits them under the task on its next exit unless another open task also declares one (a contested hold; declaring does not release it).');
    const repeat = await declare(['src/b.ts']);
    expect(repeat.message).toBe('All 1 path(s) were already declared on task-1.');
    expect(h.state.getTask('task-1')!.declaredFiles).toEqual(['src/a.ts', 'src/b.ts']);
  });
});
