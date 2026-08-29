import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ToolTestHarness } from './toolTestHarness.js';
import { recordCommitTool, resetRecordCommitGovernorRateLimit } from './recordCommit.js';
import { getActivityLogTool } from './getActivityLog.js';
import { getTools } from './index.js';
import { MAX_COMMITS_PER_TASK } from '../state/validators.js';
import { buildReopenClearingUpdates } from '../util/reopen.js';
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
    expect(result.filesModified).toEqual(['src/existing.ts', 'src/a.ts', 'src/b.ts']);

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

  it('is idempotent by sha (exact or abbreviated) and only ever upgrades pushed/treeId', async () => {
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
});
