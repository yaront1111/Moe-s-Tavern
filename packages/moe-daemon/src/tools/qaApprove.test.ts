import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { ToolTestHarness } from './toolTestHarness.js';
import { qaApproveTool } from './qaApprove.js';
import { qaRejectTool } from './qaReject.js';
import { getContextTool } from './getContext.js';
import { MoeError } from '../util/errors.js';
import { getReview, listReviewsForTask, recordReview, type RecordReviewParams } from '../state/reviewStore.js';
import type { Candidate, Review, TaskCommit } from '../types/schema.js';

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

  it('get_context omits the currentCandidate key for a task without one, rather than emitting null', async () => {
    await load();

    const context = await getContextTool(h.state).handler(
      { taskId: 'task-1', workerId: 'qa-1' },
      h.state
    ) as Record<string, unknown>;

    expect(Object.keys(context)).not.toContain('currentCandidate');
  });

  it('get_context projects a copy of the whole current candidate, the record QA binds to', async () => {
    writeCandidate({ id: 'cand-A', createdAt: '2026-09-11T03:00:00.000Z' });
    const candB = writeCandidate({ id: 'cand-B', createdAt: '2026-09-11T03:05:00.000Z' });
    await load();
    const tool = getContextTool(h.state);
    const read = async (): Promise<Candidate | undefined> =>
      (await tool.handler({ taskId: 'task-1', workerId: 'qa-1' }, h.state) as { currentCandidate?: Candidate }).currentCandidate;

    const projected = await read();
    expect(projected).toEqual(candB);

    // A copy: editing the response cannot re-point the bytes an approval is checked against.
    (projected as { treeSha: string }).treeSha = 'f'.repeat(40);
    expect(h.state.candidates.get('cand-B')).toEqual(candB);
    expect(await read()).toEqual(candB);
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

  /** The binding warning, exactly as each tool words it. */
  const noReviewedWarning = (tool: 'qa_approve' | 'qa_reject'): string =>
    `NO-REVIEWED-CANDIDATE: task task-1 has current candidate cand-A but ${tool} named none — pass candidateId so the decision is bound to the bytes you actually read`;

  // `null` is the daemon's "omitted" for an optional argument, so it must bind exactly like a missing key.
  it.each<[string, Record<string, unknown>]>([
    ['omitted', {}],
    ['null', { candidateId: null }],
  ])('approves with candidateId %s on a task that has a candidate: bound, plus a NO-REVIEWED-CANDIDATE warning', async (_label, extra) => {
    writeCandidate({ id: 'cand-A' });
    await load();

    const result = await qaApproveTool(h.state).handler(
      { taskId: 'task-1', workerId: 'qa-1', summary: SUMMARY, ...extra },
      h.state
    ) as ApproveResult;

    expect(result.status).toBe('DONE');
    expect(result.warnings).toEqual([COMMIT_WARNING, noReviewedWarning('qa_approve')]);
    // Still bound to the current candidate, so the audit trail stays complete.
    const reviews = storedReviews();
    expect(reviews.length).toBe(1);
    expect(projectFields(reviews[0], REVIEW_FIELDS)).toEqual({
      taskId: 'task-1', candidateId: 'cand-A', reviewerId: 'qa-1', decision: 'approve', summary: SUMMARY,
    });
  });

  it('approves a task with no candidate exactly as before even when a candidateId is named, binding nothing', async () => {
    await load();
    const tool = qaApproveTool(h.state);

    // Malformed input is refused here too, before the no-candidate shortcut: never read as "omitted".
    const blank = await refusalOf(tool.handler(
      { taskId: 'task-1', workerId: 'qa-1', candidateId: '', summary: SUMMARY },
      h.state
    ));
    expect({ code: blank.code, codeName: blank.codeName }).toEqual({ code: -32602, codeName: 'INVALID_INPUT' });

    const result = await tool.handler(
      { taskId: 'task-1', workerId: 'qa-1', candidateId: 'cand-X', summary: SUMMARY },
      h.state
    ) as ApproveResult;

    expect(result.status).toBe('DONE');
    // The adoption rail: exactly the pre-binding result, with no binding warning of any kind.
    expect(result.warning).toBe(COMMIT_WARNING);
    expect(result.warnings).toEqual([COMMIT_WARNING]);
    expect(result.commitEvidence).toEqual({ completion: [], checkpoint: [], rescue: [] });
    expect(result.message).toBe('Task task-1 approved and moved to DONE (WARNING: no completion commit recorded — see warnings)');
    expect(h.state.reviews.size).toBe(0);
    expect(fs.existsSync(path.join(h.moePath, 'reviews'))).toBe(false);
  });

  it.each<[string, Record<string, unknown>]>([
    ['omitted', {}],
    ['null', { candidateId: null }],
  ])('rejects with candidateId %s on a task that has a candidate: bound, with exactly one NO-REVIEWED-CANDIDATE warning', async (_label, extra) => {
    writeCandidate({ id: 'cand-A' });
    await load();

    const result = await qaRejectTool(h.state).handler(
      { taskId: 'task-1', workerId: 'qa-1', reason: 'DoD item 2 fails', ...extra },
      h.state
    ) as { status: string; warnings?: string[] };

    expect(result.status).toBe('WORKING');
    expect(result.warnings).toEqual([noReviewedWarning('qa_reject')]);
    const reviews = storedReviews();
    expect(reviews.length).toBe(1);
    expect(projectFields(reviews[0], REVIEW_FIELDS)).toEqual({
      taskId: 'task-1', candidateId: 'cand-A', reviewerId: 'qa-1', decision: 'reject', summary: 'DoD item 2 fails',
    });
  });

  it.each<[string, Record<string, unknown>]>([
    ['omitted', {}],
    ['cand-X', { candidateId: 'cand-X' }],
  ])('rejects a task with no candidate (candidateId %s) with no warnings key and no review', async (_label, extra) => {
    await load();

    const result = await qaRejectTool(h.state).handler(
      { taskId: 'task-1', workerId: 'qa-1', reason: 'DoD item 2 fails', ...extra },
      h.state
    ) as Record<string, unknown>;

    expect(result.status).toBe('WORKING');
    // The `warnings?` key of the qa_reject result is absent — not [], not null, not undefined-valued.
    expect(Object.keys(result)).not.toContain('warnings');
    expect(h.state.reviews.size).toBe(0);
    expect(fs.existsSync(path.join(h.moePath, 'reviews'))).toBe(false);
  });

  it('refuses a malformed candidateId as INVALID_INPUT rather than coercing it to "omitted"', async () => {
    writeCandidate({ id: 'cand-A' });
    await load();
    const tool = qaApproveTool(h.state);
    const cases: Array<[unknown, string]> = [
      ['   ', 'Invalid candidateId: must be a non-blank string'],
      [42, 'Invalid candidateId: must be a string (got 42)'],
      ['cand A', 'Invalid candidateId: must contain only alphanumeric characters, hyphens, and underscores'],
    ];

    for (const [candidateId, message] of cases) {
      const err = await refusalOf(tool.handler({ taskId: 'task-1', workerId: 'qa-1', candidateId, summary: SUMMARY }, h.state));
      expect({ code: err.code, codeName: err.codeName, message: err.message })
        .toEqual({ code: -32602, codeName: 'INVALID_INPUT', message: `[INVALID_INPUT] ${message}` });
    }

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

// =============================================================================
// reviewStore — the record's own refusals, list order and read copies
// =============================================================================
//
// Called directly: qa_approve/qa_reject only ever hand the store well-formed
// fields, so its refusals and readers are reachable from nowhere else.
describe('reviewStore — refusals, list order and copies', () => {
  const h = new ToolTestHarness();
  beforeEach(async () => {
    h.init();
    h.setupMoeFolder();
    h.createEpic();
    await h.state.load();
  });
  afterEach(() => { vi.useRealTimers(); h.cleanup(); });

  const VALID: RecordReviewParams = {
    taskId: 'task-1',
    candidateId: 'cand-A',
    reviewerId: 'qa-1',
    decision: 'approve',
    summary: 'verified',
  };

  it('refuses each malformed review with its exact code, codeName and message, and writes nothing', async () => {
    const cases: Array<{ input: unknown; codeName: string; message: string }> = [
      { input: { ...VALID, decision: 'maybe' }, codeName: 'INVALID_INPUT', message: 'Invalid decision: must be one of approve, reject (got "maybe")' },
      { input: { ...VALID, reviewerId: '   ' }, codeName: 'INVALID_INPUT', message: 'Invalid reviewerId: must be a non-blank string' },
      { input: { ...VALID, summary: '' }, codeName: 'INVALID_INPUT', message: 'Invalid summary: must be a non-blank string' },
      { input: 'not-a-review', codeName: 'INVALID_INPUT', message: 'Invalid review: must be an object (got "not-a-review")' },
      { input: [VALID], codeName: 'INVALID_INPUT', message: 'Invalid review: must be an object (got a value of type object)' },
      { input: { ...VALID, taskId: undefined }, codeName: 'MISSING_REQUIRED', message: 'Missing required field: taskId' },
    ];

    for (const { input, codeName, message } of cases) {
      const err = await refusalOf(recordReview(h.state, input as RecordReviewParams));
      // MoeError prefixes every message with its codeName.
      expect({ code: err.code, codeName: err.codeName, message: err.message })
        .toEqual({ code: -32602, codeName, message: `[${codeName}] ${message}` });
    }

    expect(h.state.reviews.size).toBe(0);
    expect(fs.existsSync(path.join(h.moePath, 'reviews'))).toBe(false);
  });

  it('lists one task\'s reviews by createdAt then id and leaves other tasks out', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-11T03:00:00.000Z'));
    // Same clock, recorded in REVERSE id order: only the id tie-break can order these two.
    await recordReview(h.state, { ...VALID, id: 'review-b' });
    await recordReview(h.state, { ...VALID, id: 'review-a' });
    await recordReview(h.state, { ...VALID, id: 'review-c', taskId: 'task-2' });
    // Later clock but the LOWEST id: createdAt must outrank the id.
    vi.setSystemTime(new Date('2026-09-11T03:05:00.000Z'));
    await recordReview(h.state, { ...VALID, id: 'review-0', decision: 'reject' });

    const order = (reviews: Review[]): string[] => reviews.map((r) => `${r.id}@${r.createdAt}`);
    expect(order(listReviewsForTask(h.state, 'task-1'))).toEqual([
      'review-a@2026-09-11T03:00:00.000Z',
      'review-b@2026-09-11T03:00:00.000Z',
      'review-0@2026-09-11T03:05:00.000Z',
    ]);
    expect(order(listReviewsForTask(h.state, 'task-2'))).toEqual(['review-c@2026-09-11T03:00:00.000Z']);
    expect(listReviewsForTask(h.state, 'task-none')).toEqual([]);
  });

  it('hands out a copy from every read, so a caller cannot edit a stored review', async () => {
    const recorded = await recordReview(h.state, { ...VALID, id: 'review-a' });
    const original: Review = { ...recorded };
    const tamper = (review: Review): void => { (review as { summary: string }).summary = 'tampered'; };

    tamper(recorded);
    expect(getReview(h.state, 'review-a')).toEqual(original);
    tamper(getReview(h.state, 'review-a')!);
    expect(listReviewsForTask(h.state, 'task-1')).toEqual([original]);
    listReviewsForTask(h.state, 'task-1').forEach(tamper);
    expect(h.state.reviews.get('review-a')).toEqual(original);
    expect(getReview(h.state, 'review-missing')).toBeNull();
  });
});

