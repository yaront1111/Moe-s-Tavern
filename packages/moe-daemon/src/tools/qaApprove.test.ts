import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { ToolTestHarness } from './toolTestHarness.js';
import { qaApproveTool } from './qaApprove.js';
import { qaRejectTool } from './qaReject.js';
import { MoeError } from '../util/errors.js';
import type { Candidate, TaskCommit } from '../types/schema.js';

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

// =============================================================================
// Reviewed-candidate binding — an approval must apply to the bytes QA read
// =============================================================================
//
// Every refusal here asserts BOTH the numeric code and the exact codeName:
// STATE_CONFLICT (-32002) is shared by the attempt guards and CANDIDATE_IMMUTABLE,
// so the number alone would not tell CANDIDATE_MISMATCH apart from them.
describe('moe.qa_approve — reviewed-candidate binding', () => {
  const h = new ToolTestHarness();
  beforeEach(() => h.init());
  afterEach(() => { vi.restoreAllMocks(); h.cleanup(); });

  const REVIEW_FIELDS = ['taskId', 'candidateId', 'reviewerId', 'decision', 'summary'] as const;
  const SUMMARY = 'Re-ran the suite against the reviewed candidate; all DoD items verified.';
  const COMMIT_WARNING = 'NO-COMPLETION-COMMIT: task task-1 has no completion commit recorded yet (the wrapper lands it seconds after REVIEW) — verify task.commits / git log before merging';

  interface ApproveResult {
    success: boolean;
    status: string;
    warning?: string;
    warnings: string[];
    message: string;
    commitEvidence: { completion: unknown[]; checkpoint: unknown[]; rescue: unknown[] };
  }

  /** A stored Candidate written straight into .moe/candidates, as record_candidate leaves it. */
  function writeCandidate(overrides: Partial<Candidate> & { id: string }): Candidate {
    const candidate: Candidate = {
      attemptId: 'attempt-1',
      taskId: 'task-1',
      baseRevision: 'a'.repeat(40),
      treeSha: 'c'.repeat(40),
      deliveryTarget: 'refs/heads/wave1-pilot',
      createdAt: '2026-09-11T03:00:00.000Z',
      ...overrides,
    };
    const dir = path.join(h.moePath, 'candidates');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${candidate.id}.json`), JSON.stringify(candidate, null, 2));
    return candidate;
  }

  /** Every persisted review. Returns [] when the directory was never created. */
  function storedReviews(): Record<string, unknown>[] {
    const dir = path.join(h.moePath, 'reviews');
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .sort()
      .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as Record<string, unknown>);
  }

  function projectFields(record: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const key of keys) out[key] = record[key];
    return out;
  }

  async function load(): Promise<void> {
    h.setupMoeFolder();
    h.createEpic();
    h.createTask({ id: 'task-1', status: 'REVIEW' });
    await h.state.load();
    vi.spyOn(h.state, 'postToRoleChannel').mockResolvedValue(undefined);
  }

  /** Capture a refusal's exact identity, failing loudly if the call resolved instead. */
  async function refusalOf(call: Promise<unknown>): Promise<MoeError> {
    try {
      await call;
    } catch (err) {
      if (err instanceof MoeError) return err;
      throw err;
    }
    throw new Error('expected a MoeError refusal, but the call resolved');
  }

  it('approves against the current candidate and writes exactly one review bound to it', async () => {
    writeCandidate({ id: 'cand-A' });
    await load();

    const result = await qaApproveTool(h.state).handler(
      { taskId: 'task-1', workerId: 'qa-1', candidateId: 'cand-A', summary: SUMMARY },
      h.state
    ) as ApproveResult;

    expect(result.status).toBe('DONE');
    const reviews = storedReviews();
    expect(reviews.length).toBe(1);
    expect(projectFields(reviews[0], REVIEW_FIELDS)).toEqual({
      taskId: 'task-1',
      candidateId: 'cand-A',
      reviewerId: 'qa-1',
      decision: 'approve',
      summary: SUMMARY,
    });
    expect(typeof reviews[0].createdAt).toBe('string');
    // Bound, so no binding warning — only the pre-existing commit-evidence one.
    expect(result.warnings).toEqual([COMMIT_WARNING]);
  });

  it('refuses a superseded candidate with CANDIDATE_MISMATCH and writes nothing', async () => {
    writeCandidate({ id: 'cand-A', createdAt: '2026-09-11T03:00:00.000Z' });
    writeCandidate({ id: 'cand-B', createdAt: '2026-09-11T03:05:00.000Z' });
    await load();
    const taskFile = path.join(h.moePath, 'tasks', 'task-1.json');
    const bytesBefore = fs.readFileSync(taskFile, 'utf8');

    const err = await refusalOf(qaApproveTool(h.state).handler(
      { taskId: 'task-1', workerId: 'qa-1', candidateId: 'cand-A', summary: SUMMARY },
      h.state
    ));

    expect(err.code).toBe(-32002);
    expect(err.codeName).toBe('CANDIDATE_MISMATCH');
    expect(err.context?.expectedCandidateId).toBe('cand-A');
    expect(err.context?.currentCandidateId).toBe('cand-B');
    // Refused BEFORE every write: the task bytes are untouched and the reviews
    // directory was never even created.
    expect(fs.readFileSync(taskFile, 'utf8')).toBe(bytesBefore);
    expect(h.state.getTask('task-1')!.status).toBe('REVIEW');
    expect(storedReviews()).toEqual([]);
    expect(fs.existsSync(path.join(h.moePath, 'reviews'))).toBe(false);
  });

  it('treats a candidate belonging to a different task as a mismatch, not a match', async () => {
    writeCandidate({ id: 'cand-mine' });
    writeCandidate({ id: 'cand-theirs', taskId: 'task-other', createdAt: '2026-09-11T04:00:00.000Z' });
    await load();

    const err = await refusalOf(qaApproveTool(h.state).handler(
      { taskId: 'task-1', workerId: 'qa-1', candidateId: 'cand-theirs', summary: SUMMARY },
      h.state
    ));

    expect(err.code).toBe(-32002);
    expect(err.codeName).toBe('CANDIDATE_MISMATCH');
    expect(err.context?.expectedCandidateId).toBe('cand-theirs');
    expect(err.context?.currentCandidateId).toBe('cand-mine');
    expect(storedReviews()).toEqual([]);
  });

  it('keeps the pre-binding behaviour exactly when the project records no candidates', async () => {
    await load();

    const result = await qaApproveTool(h.state).handler(
      { taskId: 'task-1', workerId: 'qa-1', summary: SUMMARY },
      h.state
    ) as ApproveResult;

    expect(result.status).toBe('DONE');
    // The adoption rail: warnings, commitEvidence and message all unchanged.
    expect(result.warning).toBe(COMMIT_WARNING);
    expect(result.warnings).toEqual([COMMIT_WARNING]);
    expect(result.commitEvidence).toEqual({ completion: [], checkpoint: [], rescue: [] });
    expect(result.message).toBe('Task task-1 approved and moved to DONE (WARNING: no completion commit recorded — see warnings)');
    // Nothing to bind to, so no review is invented.
    expect(storedReviews()).toEqual([]);
  });

  it('approves an unnamed candidate but adds a NO-REVIEWED-CANDIDATE warning', async () => {
    writeCandidate({ id: 'cand-A' });
    await load();

    const result = await qaApproveTool(h.state).handler(
      { taskId: 'task-1', workerId: 'qa-1', summary: SUMMARY },
      h.state
    ) as ApproveResult;

    expect(result.status).toBe('DONE');
    expect(result.warnings).toEqual([
      COMMIT_WARNING,
      'NO-REVIEWED-CANDIDATE: task task-1 has current candidate cand-A but qa_approve named none — pass candidateId so the decision is bound to the bytes you actually read',
    ]);
    // Still bound to the current candidate, so the audit trail stays complete.
    expect(projectFields(storedReviews()[0], REVIEW_FIELDS).candidateId).toBe('cand-A');
  });

  it('refuses a malformed candidateId rather than coercing it to "omitted"', async () => {
    writeCandidate({ id: 'cand-A' });
    await load();

    const blank = await refusalOf(qaApproveTool(h.state).handler(
      { taskId: 'task-1', workerId: 'qa-1', candidateId: '   ', summary: SUMMARY },
      h.state
    ));
    expect(blank.code).toBe(-32602);
    expect(blank.message).toContain('candidateId');

    const wrongType = await refusalOf(qaApproveTool(h.state).handler(
      { taskId: 'task-1', workerId: 'qa-1', candidateId: 42 as unknown as string, summary: SUMMARY },
      h.state
    ));
    expect(wrongType.code).toBe(-32602);
    expect(wrongType.message).toContain('must be a string');

    expect(h.state.getTask('task-1')!.status).toBe('REVIEW');
    expect(storedReviews()).toEqual([]);
  });

  it('surfaces a failed review write and leaves no review and no DONE behind', async () => {
    writeCandidate({ id: 'cand-A' });
    await load();
    const write = vi.spyOn(h.state, 'writeEntity').mockImplementation(async (kind: string) => {
      if (kind === 'reviews') throw new Error('disk full');
    });

    await expect(qaApproveTool(h.state).handler(
      { taskId: 'task-1', workerId: 'qa-1', candidateId: 'cand-A', summary: SUMMARY },
      h.state
    )).rejects.toThrow('disk full');

    write.mockRestore();
    expect(storedReviews()).toEqual([]);
    expect(h.state.reviews.size).toBe(0);
    expect(h.state.getTask('task-1')!.status).toBe('REVIEW');
  });

  it('records a reject decision against the current candidate and refuses the same mismatch', async () => {
    writeCandidate({ id: 'cand-A', createdAt: '2026-09-11T03:00:00.000Z' });
    writeCandidate({ id: 'cand-B', createdAt: '2026-09-11T03:05:00.000Z' });
    await load();
    const tool = qaRejectTool(h.state);

    const err = await refusalOf(tool.handler(
      { taskId: 'task-1', workerId: 'qa-1', candidateId: 'cand-A', reason: 'DoD item 2 fails' },
      h.state
    ));
    expect(err.code).toBe(-32002);
    expect(err.codeName).toBe('CANDIDATE_MISMATCH');
    expect(err.context?.expectedCandidateId).toBe('cand-A');
    expect(err.context?.currentCandidateId).toBe('cand-B');
    expect(storedReviews()).toEqual([]);
    expect(h.state.getTask('task-1')!.status).toBe('REVIEW');

    await tool.handler(
      { taskId: 'task-1', workerId: 'qa-1', candidateId: 'cand-B', reason: 'DoD item 2 fails' },
      h.state
    );

    const reviews = storedReviews();
    expect(reviews.length).toBe(1);
    expect(projectFields(reviews[0], REVIEW_FIELDS)).toEqual({
      taskId: 'task-1',
      candidateId: 'cand-B',
      reviewerId: 'qa-1',
      decision: 'reject',
      summary: 'DoD item 2 fails',
    });
    expect(h.state.getTask('task-1')!.status).toBe('WORKING');
  });

  it('appends a second review when a reopened task is reviewed again', async () => {
    writeCandidate({ id: 'cand-A' });
    await load();

    await qaRejectTool(h.state).handler(
      { taskId: 'task-1', workerId: 'qa-1', candidateId: 'cand-A', reason: 'needs a fix' },
      h.state
    );
    await h.state.updateTask('task-1', { status: 'REVIEW' });
    await qaApproveTool(h.state).handler(
      { taskId: 'task-1', workerId: 'qa-1', candidateId: 'cand-A', summary: SUMMARY },
      h.state
    );

    // Append-only: the reject record is not rewritten into an approve.
    const decisions = storedReviews().map((r) => r.decision).sort();
    expect(decisions).toEqual(['approve', 'reject']);
    expect(h.state.reviews.size).toBe(2);
  });
});

