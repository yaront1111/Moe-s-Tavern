import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ToolTestHarness } from './toolTestHarness.js';
import { qaApproveTool } from './qaApprove.js';
import type { TaskCommit } from '../types/schema.js';

describe('moe.qa_approve', () => {
  const h = new ToolTestHarness();
  beforeEach(() => h.init());
  afterEach(() => { vi.restoreAllMocks(); h.cleanup(); });

  beforeEach(async () => {
    h.setupMoeFolder();
    h.createEpic();
    h.createTask({ id: 'task-1', status: 'REVIEW' });
    await h.state.load();
  });

  it('approves task in REVIEW and moves to DONE', async () => {
    const tool = qaApproveTool(h.state);
    const result = await tool.handler({
      taskId: 'task-1',
      summary: 'All DoD items verified',
    }, h.state) as { success: boolean; status: string };

    expect(result.success).toBe(true);
    expect(result.status).toBe('DONE');

    const task = h.state.getTask('task-1');
    expect(task?.status).toBe('DONE');
  });

  it('throws for missing taskId', async () => {
    const tool = qaApproveTool(h.state);
    await expect(tool.handler({}, h.state)).rejects.toThrow('Missing required field: taskId');
  });

  it('throws for missing or empty summary', async () => {
    const tool = qaApproveTool(h.state);
    await expect(tool.handler({ taskId: 'task-1' }, h.state)).rejects.toThrow('Missing required field: summary');
    await expect(tool.handler({ taskId: 'task-1', summary: '   ' }, h.state)).rejects.toThrow('Missing required field: summary');
    expect(h.state.getTask('task-1')?.status).toBe('REVIEW');
  });

  it('persists the approval summary as reviewSummary', async () => {
    const tool = qaApproveTool(h.state);
    await tool.handler({ taskId: 'task-1', summary: 'Re-ran npx vitest run: 12 passed. All 4 DoD items verified.' }, h.state);
    expect(h.state.getTask('task-1')?.reviewSummary).toBe('Re-ran npx vitest run: 12 passed. All 4 DoD items verified.');
  });

  it('throws for non-REVIEW status', async () => {
    await h.state.updateTask('task-1', { status: 'WORKING' });
    const tool = qaApproveTool(h.state);
    await expect(
      tool.handler({ taskId: 'task-1' }, h.state)
    ).rejects.toThrow('expected REVIEW');
  });

  it('throws for non-existent task', async () => {
    const tool = qaApproveTool(h.state);
    await expect(
      tool.handler({ taskId: 'nonexistent' }, h.state)
    ).rejects.toThrow('Task not found');
  });
});

describe('moe.qa_approve — NO-COMPLETION-COMMIT soft gate', () => {
  const h = new ToolTestHarness();
  beforeEach(() => h.init());
  afterEach(() => { vi.restoreAllMocks(); h.cleanup(); });

  interface ApproveResult {
    success: boolean;
    status: string;
    warning?: string;
    warnings: string[];
    message: string;
    commitEvidence: {
      completion: Array<{ sha: string; ref: string; pushed: boolean | null; recordedAt: string }>;
      checkpoint: Array<{ sha: string }>;
      rescue: Array<{ sha: string }>;
    };
  }

  const reviewStartedAt = '2026-08-28T10:00:00.000Z';
  const expectedWarning = 'NO-COMPLETION-COMMIT: task task-1 has no completion commit recorded yet (the wrapper lands it seconds after REVIEW) — verify task.commits / git log before merging';

  function commit(overrides: Partial<TaskCommit>): TaskCommit {
    return {
      sha: 'abc1234abc1234',
      ref: 'moe/work-2026-08-28',
      kind: 'completion',
      role: 'worker',
      sessionId: 'worker-1@2026-08-28T09:00:00.000Z',
      paths: ['src/a.ts'],
      pushed: true,
      recordedBy: 'worker-1',
      recordedAt: '2026-08-28T10:05:00.000Z',
      ...overrides,
    };
  }

  async function seed(commits: TaskCommit[] | undefined) {
    h.setupMoeFolder();
    h.createEpic();
    h.createTask({ id: 'task-1', status: 'REVIEW', reviewStartedAt, ...(commits ? { commits } : {}) });
    await h.state.load();
  }

  async function approve(): Promise<ApproveResult> {
    return await qaApproveTool(h.state).handler({ taskId: 'task-1', summary: 'verified' }, h.state) as ApproveResult;
  }

  it('warns, posts #governors after the DONE write, and still approves when no completion commit is recorded', async () => {
    await seed(undefined);
    const gov = vi.spyOn(h.state, 'postToRoleChannel').mockImplementation(async () => {
      // Must run AFTER the DONE write has landed.
      expect(h.state.getTask('task-1')!.status).toBe('DONE');
    });

    const result = await approve();
    expect(result.success).toBe(true);
    expect(result.status).toBe('DONE');
    expect(result.warning).toBe(expectedWarning);
    expect(result.warnings).toEqual([expectedWarning]);
    expect(result.message).toContain('WARNING');
    expect(result.commitEvidence).toEqual({ completion: [], checkpoint: [], rescue: [] });
    expect(gov).toHaveBeenCalledWith('governors', expect.stringContaining('NO-COMPLETION-COMMIT: task task-1'));
    expect(h.state.getTask('task-1')!.status).toBe('DONE');
  });

  it('does not warn when a completion commit was recorded at/after reviewStartedAt', async () => {
    await seed([commit({ kind: 'checkpoint', sha: 'ccc1234ccc1234', recordedAt: '2026-08-28T09:30:00.000Z' }), commit({})]);
    const gov = vi.spyOn(h.state, 'postToRoleChannel').mockResolvedValue(undefined);

    const result = await approve();
    expect(result.warning).toBeUndefined();
    expect(result.warnings).toEqual([]);
    expect(result.commitEvidence.completion).toEqual([
      { sha: 'abc1234abc1234', ref: 'moe/work-2026-08-28', pushed: true, recordedAt: '2026-08-28T10:05:00.000Z' },
    ]);
    expect(result.commitEvidence.checkpoint).toHaveLength(1);
    expect(gov).not.toHaveBeenCalledWith('governors', expect.stringContaining('NO-COMPLETION-COMMIT'));
  });

  it('ignores a completion commit from a previous attempt (recorded before reviewStartedAt)', async () => {
    await seed([commit({ recordedAt: '2026-08-28T08:00:00.000Z' })]);
    const gov = vi.spyOn(h.state, 'postToRoleChannel').mockResolvedValue(undefined);

    const result = await approve();
    expect(result.warning).toBe(expectedWarning);
    expect(result.commitEvidence.completion).toEqual([]);
    expect(gov).toHaveBeenCalledWith('governors', expect.stringContaining('NO-COMPLETION-COMMIT'));
    expect(h.state.getTask('task-1')!.status).toBe('DONE');
  });

  it('only checkpoint/rescue commits still warn but are listed as evidence', async () => {
    await seed([
      commit({ kind: 'checkpoint', sha: 'ccc1234ccc1234' }),
      commit({ kind: 'rescue', sha: 'ddd1234ddd1234', ref: 'refs/moe/rescue/task-1/20260828T100000Z', pushed: false }),
    ]);
    vi.spyOn(h.state, 'postToRoleChannel').mockResolvedValue(undefined);

    const result = await approve();
    expect(result.warning).toBe(expectedWarning);
    expect(result.commitEvidence.checkpoint.map((c) => c.sha)).toEqual(['ccc1234ccc1234']);
    expect(result.commitEvidence.rescue.map((c) => c.sha)).toEqual(['ddd1234ddd1234']);
  });

  it('a #governors outage never blocks the approval', async () => {
    await seed(undefined);
    vi.spyOn(h.state, 'postToRoleChannel').mockRejectedValue(new Error('chat down'));

    const result = await approve();
    expect(result.success).toBe(true);
    expect(result.warning).toBe(expectedWarning);
    expect(h.state.getTask('task-1')!.status).toBe('DONE');
  });

  it('does not warn when settings.autoCommit is false (no wrapper commit is expected)', async () => {
    await seed(undefined);
    await h.state.updateSettings({ autoCommit: false });
    const gov = vi.spyOn(h.state, 'postToRoleChannel').mockResolvedValue(undefined);

    const result = await approve();
    expect(result.warning).toBeUndefined();
    expect(result.warnings).toEqual([]);
    expect(gov).not.toHaveBeenCalled();
    expect(h.state.getTask('task-1')!.status).toBe('DONE');
  });
});

