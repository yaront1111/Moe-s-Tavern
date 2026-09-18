import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { ToolTestHarness } from './toolTestHarness.js';
import { qaApproveTool } from './qaApprove.js';
import { qaRejectTool } from './qaReject.js';
import { getContextTool } from './getContext.js';
import { MoeError } from '../util/errors.js';
import { getReview, listReviewsForTask, recordReview, type RecordReviewParams } from '../state/reviewStore.js';
import { StateManager } from '../state/StateManager.js';
import type { Candidate, Review, TaskCommit } from '../types/schema.js';
import type { Task } from '../types/schema.js';
import { recordCheckRun } from '../state/checkRunStore.js';
import { evaluateDeliveryEvidence, isEpicFinalTask, requiredCheckToken, resolveDeliveryPolicy, type DeliveryAttestations } from '../delivery/policy.js';

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

  async function seed(commits: TaskCommit[] | undefined, extra: Record<string, unknown> = {}) {
    h.setupMoeFolder();
    h.createEpic();
    h.createTask({ id: 'task-1', status: 'REVIEW', reviewStartedAt, ...(commits ? { commits } : {}), ...extra });
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

  it('ignores a completion commit from a previous attempt on a legacy row with no round marker', async () => {
    // No rejectionHistory and no workStartedAt, so reviewStartedAt is the
    // last-resort anchor and an ancient commit still cannot satisfy the gate.
    await seed([commit({ recordedAt: '2026-08-28T08:00:00.000Z' })]);
    const gov = vi.spyOn(h.state, 'postToRoleChannel').mockResolvedValue(undefined);

    const result = await approve();
    expect(result.warning).toBe(expectedWarning);
    expect(result.commitEvidence.completion).toEqual([]);
    expect(gov).toHaveBeenCalledWith('governors', expect.stringContaining('NO-COMPLETION-COMMIT'));
    expect(h.state.getTask('task-1')!.status).toBe('DONE');
  });

  // Regression: a worker that commits BY HAND calls record_commit before
  // complete_task, so its completion commit is recorded AHEAD of reviewStartedAt.
  // Anchoring the round on reviewStartedAt fired NO-COMPLETION-COMMIT on tasks
  // whose commit was sitting in task.commits. Observed twice in one session on
  // 2026-09-11 (algorun task-407a1aff, commit 55s early; task-d51110af, 2m23s early).
  it('accepts a hand-recorded completion commit landed before reviewStartedAt in the same round', async () => {
    await seed(
      [commit({ recordedAt: '2026-08-28T09:59:05.000Z' })],
      { workStartedAt: '2026-08-28T09:00:00.000Z' }
    );
    const gov = vi.spyOn(h.state, 'postToRoleChannel').mockResolvedValue(undefined);

    const result = await approve();
    expect(result.warning).toBeUndefined();
    expect(result.warnings).toEqual([]);
    expect(result.commitEvidence.completion).toEqual([
      { sha: 'abc1234abc1234', ref: 'moe/work-2026-08-28', pushed: true, recordedAt: '2026-08-28T09:59:05.000Z' },
    ]);
    expect(gov).not.toHaveBeenCalledWith('governors', expect.stringContaining('NO-COMPLETION-COMMIT'));
  });

  it('on a reopened task, accepts this round\'s hand-recorded commit and ignores the previous round\'s', async () => {
    // Round 1 committed at 08:00 then was rejected at 09:30; round 2 committed by
    // hand at 09:59:05, still ahead of the 10:00 reviewStartedAt.
    await seed(
      [
        commit({ sha: 'old1234old1234', recordedAt: '2026-08-28T08:00:00.000Z' }),
        commit({ recordedAt: '2026-08-28T09:59:05.000Z' }),
      ],
      {
        workStartedAt: '2026-08-28T07:00:00.000Z',
        reopenCount: 1,
        rejectionHistory: [{ reason: 'doc defect', rejectedAt: '2026-08-28T09:30:00.000Z', reopenCount: 1 }],
      }
    );
    const gov = vi.spyOn(h.state, 'postToRoleChannel').mockResolvedValue(undefined);

    const result = await approve();
    expect(result.warning).toBeUndefined();
    expect(result.commitEvidence.completion).toEqual([
      { sha: 'abc1234abc1234', ref: 'moe/work-2026-08-28', pushed: true, recordedAt: '2026-08-28T09:59:05.000Z' },
    ]);
    expect(gov).not.toHaveBeenCalledWith('governors', expect.stringContaining('NO-COMPLETION-COMMIT'));
  });

  it('on a reopened task, still warns when only the previous round committed', async () => {
    await seed(
      [commit({ sha: 'old1234old1234', recordedAt: '2026-08-28T08:00:00.000Z' })],
      {
        workStartedAt: '2026-08-28T07:00:00.000Z',
        reopenCount: 1,
        rejectionHistory: [{ reason: 'doc defect', rejectedAt: '2026-08-28T09:30:00.000Z', reopenCount: 1 }],
      }
    );
    const gov = vi.spyOn(h.state, 'postToRoleChannel').mockResolvedValue(undefined);

    const result = await approve();
    expect(result.warning).toBe(expectedWarning);
    expect(result.commitEvidence.completion).toEqual([]);
    expect(gov).toHaveBeenCalledWith('governors', expect.stringContaining('NO-COMPLETION-COMMIT'));
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

  // With additionalProperties false an MCP client can send only what the schema
  // declares, and handler calls bypass the schema, so only inspecting it pins the entry.
  it.each<[string, typeof qaApproveTool, string[]]>([
    ['moe.qa_approve', qaApproveTool, ['taskId', 'summary']],
    ['moe.qa_reject', qaRejectTool, ['taskId', 'reason']],
  ])('%s declares candidateId as an optional string input', (name, factory, required) => {
    const tool = factory(h.state);
    const schema = tool.inputSchema as { properties: Record<string, unknown>; required: string[]; additionalProperties: boolean };

    expect(tool.name).toBe(name);
    expect(schema.properties.candidateId).toMatchObject({ type: 'string' });
    expect(schema.required).toEqual(required);
    expect(schema.additionalProperties).toBe(false);
  });

  // The IDE/human path sends no workerId, and a review must still name who decided.
  it.each<[string, 'approve' | 'reject', string]>([
    ['moe.qa_approve', 'approve', 'DONE'],
    ['moe.qa_reject', 'reject', 'WORKING'],
  ])('%s without a workerId records the review with reviewerId "human"', async (_name, decision, status) => {
    writeCandidate({ id: 'cand-A' });
    await load();
    const args = { taskId: 'task-1', candidateId: 'cand-A' };

    const result = (decision === 'approve'
      ? await qaApproveTool(h.state).handler({ ...args, summary: SUMMARY }, h.state)
      : await qaRejectTool(h.state).handler({ ...args, reason: SUMMARY }, h.state)) as { status: string };

    expect(result.status).toBe(status);
    const reviews = storedReviews();
    expect(reviews.length).toBe(1);
    expect(projectFields(reviews[0], REVIEW_FIELDS)).toEqual({
      taskId: 'task-1', candidateId: 'cand-A', reviewerId: 'human', decision, summary: SUMMARY,
    });
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
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); h.cleanup(); });

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

  const reviewFile = (id: string): string => path.join(h.moePath, 'reviews', `${id}.json`);

  // A reused id is the one way an append-only trail could still be rewritten, so
  // the store refuses it. The label is the exact differingFields list, in order.
  it.each<[string, Partial<RecordReviewParams>]>([
    ['decision, summary', { decision: 'reject', summary: 'rewritten' }],
    ['taskId', { taskId: 'task-2' }],
    ['candidateId', { candidateId: 'cand-B' }],
    ['reviewerId', { reviewerId: 'qa-2' }],
  ])('refuses a same-id review that differs in %s and keeps the first record in memory and on disk', async (differs, change) => {
    const first = await recordReview(h.state, { ...VALID, id: 'review-x' });
    const bytesBefore = fs.readFileSync(reviewFile('review-x'), 'utf8');

    const err = await refusalOf(recordReview(h.state, { ...VALID, id: 'review-x', ...change }));

    expect({ code: err.code, codeName: err.codeName, message: err.message, context: err.context }).toEqual({
      code: -32002,
      codeName: 'REVIEW_IMMUTABLE',
      message: `[REVIEW_IMMUTABLE] Review review-x already exists and differs in ${differs}; reviews are append-only, so a new decision needs a new review id`,
      context: { reviewId: 'review-x', differingFields: differs.split(', ') },
    });
    expect(getReview(h.state, 'review-x')).toEqual(first);
    expect(JSON.parse(bytesBefore)).toEqual(first);
    expect(fs.readFileSync(reviewFile('review-x'), 'utf8')).toBe(bytesBefore);
    expect(h.state.reviews.size).toBe(1);
  });

  it('replays an identical same-id review: the stored copy comes back with its createdAt, and nothing is written', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-11T03:00:00.000Z'));
    const first = await recordReview(h.state, { ...VALID, id: 'review-x' });
    const bytesBefore = fs.readFileSync(reviewFile('review-x'), 'utf8');
    vi.setSystemTime(new Date('2026-09-11T03:05:00.000Z'));
    const write = vi.spyOn(h.state, 'writeEntity');

    const replay = await recordReview(h.state, { ...VALID, id: 'review-x' });

    expect(replay).toEqual(first);
    expect(replay.createdAt).toBe('2026-09-11T03:00:00.000Z');
    expect(write).not.toHaveBeenCalled();
    expect(fs.readFileSync(reviewFile('review-x'), 'utf8')).toBe(bytesBefore);
    // A copy, like every other read: editing the replay cannot edit the stored review.
    (replay as { summary: string }).summary = 'tampered';
    expect(listReviewsForTask(h.state, 'task-1')).toEqual([first]);
  });

  it('loads persisted reviews into a fresh StateManager after a restart, still refusing a reused id', async () => {
    const approve = await recordReview(h.state, { ...VALID, id: 'review-a' });
    const reject = await recordReview(h.state, { ...VALID, id: 'review-b', decision: 'reject', summary: 'DoD item 2 fails' });
    const original = listReviewsForTask(h.state, 'task-1');
    expect(original).toHaveLength(2);

    const restarted = new StateManager({ projectPath: h.testDir });
    await restarted.load();
    try {
      expect(restarted.reviews.size).toBe(2);
      expect(getReview(restarted, 'review-a')).toEqual(approve);
      expect(getReview(restarted, 'review-b')).toEqual(reject);
      expect(listReviewsForTask(restarted, 'task-1')).toEqual(original);
      // The same-id check reads the reloaded map, so a restart cannot reopen the rewrite hole.
      const bytesBefore = fs.readFileSync(reviewFile('review-a'), 'utf8');
      const err = await refusalOf(recordReview(restarted, { ...VALID, id: 'review-a', decision: 'reject' }));
      expect({ code: err.code, codeName: err.codeName }).toEqual({ code: -32002, codeName: 'REVIEW_IMMUTABLE' });
      expect(fs.readFileSync(reviewFile('review-a'), 'utf8')).toBe(bytesBefore);
    } finally {
      restarted.clearEmitter();
    }
  });
});

// =============================================================================
// deliveryPolicy — what DONE requires before qa_approve may land it
// =============================================================================
//
// Every refusal asserts the numeric code AND the exact codeName: -32003 is shared
// with NOT_ALLOWED, so the number alone would not identify DELIVERY_EVIDENCE_MISSING.
// Candidate and check records are written straight into .moe/<kind>/ BEFORE load,
// exactly as their stores leave them, so the gate reads real persisted evidence.

/** The harness project settings. setupMoeFolder REPLACES the whole object when settings are overridden. */
const HARNESS_SETTINGS = {
  approvalMode: 'CONTROL',
  speedModeDelayMs: 2000,
  autoCreateBranch: true,
  branchPattern: 'moe/{epicId}/{taskId}',
  commitPattern: 'feat({epicId}): {taskTitle}',
  agentCommand: 'claude',
} as const;

/** A fixture record at .moe/<kind>/<id>.json, written before state.load(). */
function writeFixtureRecord(h: ToolTestHarness, kind: string, record: { id: string } & Record<string, unknown>): void {
  const dir = path.join(h.moePath, kind);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${record.id}.json`), JSON.stringify(record, null, 2));
}

describe('moe.qa_approve — deliveryPolicy gate', () => {
  const h = new ToolTestHarness();
  beforeEach(() => h.init());
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); h.cleanup(); });

  const REVIEW_STARTED_AT = '2026-09-13T10:00:00.000Z';
  const SUMMARY = 'Re-ran the suite and checked each DoD item against the recorded delivery evidence.';
  const COMMIT_WARNING = 'NO-COMPLETION-COMMIT: task task-1 has no completion commit recorded yet (the wrapper lands it seconds after REVIEW) — verify task.commits / git log before merging';
  const TREE_A = 'c'.repeat(40);

  interface GateResult {
    success: boolean;
    status: string;
    warning?: string;
    warnings: string[];
    message: string;
    deliveryPolicy?: string;
    deliveryEvidence?: Record<string, unknown>;
  }

  function completion(overrides: Partial<TaskCommit> = {}): TaskCommit {
    return {
      sha: 'abc1234abc1234',
      ref: 'moe/work-2026-09-13',
      kind: 'completion',
      role: 'worker',
      sessionId: 'worker-1@2026-09-13T09:00:00.000Z',
      paths: ['src/a.ts'],
      pushed: true,
      recordedBy: 'worker-1',
      recordedAt: '2026-09-13T10:00:05.000Z',
      ...overrides,
    };
  }

  function writeCandidateRecord(id: string, createdAt = '2026-09-13T09:30:00.000Z'): void {
    writeFixtureRecord(h, 'candidates', {
      id,
      attemptId: 'attempt-1',
      taskId: 'task-1',
      baseRevision: 'a'.repeat(40),
      treeSha: TREE_A,
      deliveryTarget: 'refs/heads/wave1-pilot',
      createdAt,
    });
  }

  const taskFile = (): string => path.join(h.moePath, 'tasks', 'task-1.json');
  const readTaskFile = (): Record<string, unknown> =>
    JSON.parse(fs.readFileSync(taskFile(), 'utf8')) as Record<string, unknown>;

  async function seed(settings: Record<string, unknown>, task: Partial<Task> = {}): Promise<void> {
    h.setupMoeFolder({ settings: { ...HARNESS_SETTINGS, ...settings } as never });
    h.createEpic();
    h.createTask({ id: 'task-1', status: 'REVIEW', reviewStartedAt: REVIEW_STARTED_AT, ...task });
    await h.state.load();
    vi.spyOn(h.state, 'postToRoleChannel').mockResolvedValue(undefined);
  }

  function approve(extra: Record<string, unknown> = {}): Promise<GateResult> {
    return qaApproveTool(h.state).handler(
      { taskId: 'task-1', workerId: 'qa-1', summary: SUMMARY, ...extra },
      h.state
    ) as Promise<GateResult>;
  }

  /**
   * The approval must be refused with DELIVERY_EVIDENCE_MISSING naming exactly
   * `missingEvidence`, BEFORE every write: no entity write, no worker touch, no
   * chat line, a byte-identical task file, still REVIEW, and no .moe/reviews.
   */
  async function expectEvidenceRefusal(
    extra: Record<string, unknown>,
    deliveryPolicy: string,
    missingEvidence: string[]
  ): Promise<MoeError> {
    const bytesBefore = fs.readFileSync(taskFile(), 'utf8');
    const write = vi.spyOn(h.state, 'writeEntity');
    const touch = vi.spyOn(h.state, 'touchWorker');
    const system = vi.spyOn(h.state, 'postSystemMessage');

    const err = await refusalOf(approve(extra));

    expect({ code: err.code, codeName: err.codeName, context: err.context }).toEqual({
      code: -32003,
      codeName: 'DELIVERY_EVIDENCE_MISSING',
      context: { taskId: 'task-1', deliveryPolicy, missingEvidence },
    });
    for (const token of missingEvidence) expect(err.message).toContain(token);
    expect(write).not.toHaveBeenCalled();
    expect(touch).not.toHaveBeenCalled();
    expect(system).not.toHaveBeenCalled();
    expect(h.state.postToRoleChannel).not.toHaveBeenCalled();
    expect(fs.readFileSync(taskFile(), 'utf8')).toBe(bytesBefore);
    expect(h.state.getTask('task-1')!.status).toBe('REVIEW');
    expect(fs.existsSync(path.join(h.moePath, 'reviews'))).toBe(false);
    write.mockRestore();
    touch.mockRestore();
    system.mockRestore();
    return err;
  }

  it.each<[string, Record<string, unknown>]>([
    ['absent', {}],
    ['null', { deliveryPolicy: null }],
    ['legacy', { deliveryPolicy: 'legacy' }],
  ])('with deliveryPolicy %s, a task with no completion commit still reaches DONE carrying the soft warning in both places', async (_label, settings) => {
    await seed(settings);

    const result = await approve();

    expect(result.status).toBe('DONE');
    expect(result.warning).toBe(COMMIT_WARNING);
    expect(result.warnings).toEqual([COMMIT_WARNING]);
    expect(result.message).toBe('Task task-1 approved and moved to DONE (WARNING: no completion commit recorded — see warnings)');
    expect(h.state.postToRoleChannel).toHaveBeenCalledWith('governors', expect.stringContaining(COMMIT_WARNING));
    // Nothing new on the default path: no policy key in the result and no label on the task.
    expect(Object.keys(result)).not.toContain('deliveryPolicy');
    expect(Object.keys(result)).not.toContain('deliveryEvidence');
    expect(Object.keys(readTaskFile())).not.toContain('deliveryEvidence');
  });

  it('local-branch hard-refuses a task with no completion commit, names completion-commit, and moves not one byte', async () => {
    writeCandidateRecord('cand-A');
    await seed({ deliveryPolicy: 'local-branch' });

    const err = await expectEvidenceRefusal({ candidateId: 'cand-A' }, 'local-branch', ['completion-commit']);

    // MoeError.context never crosses the MCP wire, so the message itself must carry the evidence.
    expect(err.message).toBe(
      '[DELIVERY_EVIDENCE_MISSING] Task task-1 cannot move to DONE under deliveryPolicy local-branch: missing delivery evidence ' +
        'completion-commit (no completion commit is recorded for this review round; the wrapper lands it seconds after REVIEW, ' +
        'so retry once task.commits shows it)'
    );
  });

  it('local-branch does not count a completion commit recorded before this review round started', async () => {
    await seed({ deliveryPolicy: 'local-branch' }, { commits: [completion({ recordedAt: '2026-09-13T09:59:59.999Z' })] });

    await expectEvidenceRefusal({}, 'local-branch', ['completion-commit']);
  });

  it('local-branch approves once a completion commit is recorded for this review round, pushed or not, and labels nothing', async () => {
    await seed({ deliveryPolicy: 'local-branch' }, { commits: [completion({ pushed: false })] });

    const result = await approve();

    expect(result.status).toBe('DONE');
    expect(result.deliveryPolicy).toBe('local-branch');
    expect(result.warnings).toEqual([]);
    expect(Object.keys(result)).not.toContain('deliveryEvidence');
    expect(Object.keys(readTaskFile())).not.toContain('deliveryEvidence');
  });

  it('local-branch lands on a retry once the wrapper records the completion commit it was still landing', async () => {
    await seed({ deliveryPolicy: 'local-branch' });
    await expectEvidenceRefusal({}, 'local-branch', ['completion-commit']);

    await h.state.updateTask('task-1', { commits: [completion()] });

    expect((await approve()).status).toBe('DONE');
  });

  it.each<[string, Partial<TaskCommit>]>([
    ['pushed: false', { pushed: false }],
    ['pushed never reported', { pushed: undefined }],
  ])('remote-push refuses a completion commit that was recorded but never pushed (%s)', async (_label, change) => {
    await seed({ deliveryPolicy: 'remote-push' }, { commits: [completion(change)] });

    await expectEvidenceRefusal({}, 'remote-push', ['pushed-completion-commit']);
  });

  it('remote-push ignores a pushed commit from an earlier round and approves once this round\'s commit is pushed', async () => {
    const earlierPushed = completion({ sha: 'aaa1111aaa1111', recordedAt: '2026-09-13T09:00:00.000Z' });
    await seed({ deliveryPolicy: 'remote-push' }, { commits: [earlierPushed, completion({ pushed: false })] });
    await expectEvidenceRefusal({}, 'remote-push', ['pushed-completion-commit']);

    // record_commit re-reporting the same sha only ever upgrades pushed to true.
    await h.state.updateTask('task-1', { commits: [earlierPushed, completion({ pushed: true })] });

    const result = await approve();
    expect(result.status).toBe('DONE');
    expect(result.deliveryPolicy).toBe('remote-push');
  });

  it('merged-pull-request refuses without an attested merge, even with a pushed completion commit and a recorded prLink', async () => {
    await seed({ deliveryPolicy: 'merged-pull-request' }, { commits: [completion()], prLink: 'https://example.test/pull/7' });

    await expectEvidenceRefusal({}, 'merged-pull-request', ['merged-pull-request']);
  });

  it('merged-pull-request approves with an attested merged pull request, labelled as attested rather than verified delivery', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-13T11:00:00.000Z'));
    await seed({ deliveryPolicy: 'merged-pull-request' });

    const result = await approve({ mergedPullRequest: '  https://example.test/pull/7  ' });

    const label = {
      kind: 'merged-pull-request',
      reference: 'https://example.test/pull/7',
      verifiedDelivery: false,
      recordedBy: 'qa-1',
      recordedAt: '2026-09-13T11:00:00.000Z',
    };
    expect(result.status).toBe('DONE');
    expect(result.deliveryEvidence).toEqual(label);
    expect(readTaskFile().deliveryEvidence).toEqual(label);
    // No commit is recorded, so the soft warning keeps flowing beside the attestation.
    expect(result.warnings).toEqual([COMMIT_WARNING]);
  });

  it.each<[string, Record<string, unknown>]>([
    ['omitted', {}],
    ['null', { manualArtifact: null }],
  ])('manual-artifact refuses a task with no commit when the artifact is %s', async (_label, extra) => {
    await seed({ deliveryPolicy: 'manual-artifact' });

    await expectEvidenceRefusal(extra, 'manual-artifact', ['manual-artifact']);
  });

  it('manual-artifact does not let a pushed completion commit stand in for the artifact', async () => {
    await seed({ deliveryPolicy: 'manual-artifact' }, { commits: [completion()] });

    await expectEvidenceRefusal({}, 'manual-artifact', ['manual-artifact']);
  });

  it('manual-artifact approves with an attested artifact and persists a manual label that never reads as verified delivery', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-13T11:00:00.000Z'));
    await seed({ deliveryPolicy: 'manual-artifact' });

    const result = await approve({ manualArtifact: 'Signed report at reports/q3.pdf, checked page by page' });

    const label = {
      kind: 'manual-artifact',
      reference: 'Signed report at reports/q3.pdf, checked page by page',
      verifiedDelivery: false,
      recordedBy: 'qa-1',
      recordedAt: '2026-09-13T11:00:00.000Z',
    };
    expect(result.status).toBe('DONE');
    expect(result.deliveryPolicy).toBe('manual-artifact');
    expect(result.deliveryEvidence).toEqual(label);
    expect(h.state.getTask('task-1')!.deliveryEvidence).toEqual(label);
    expect(readTaskFile().deliveryEvidence).toEqual(label);
    expect(result.warnings).toEqual([COMMIT_WARNING]);
    expect(result.message).toBe(
      'Task task-1 approved and moved to DONE (WARNING: no completion commit recorded — see warnings) ' +
        '(evidence: manual-artifact attested by qa-1 — NOT verified delivery)'
    );
  });

  it('clears a stale attestation label when a later approval rested on a recorded commit instead', async () => {
    await seed({ deliveryPolicy: 'local-branch' }, {
      commits: [completion()],
      deliveryEvidence: {
        kind: 'manual-artifact',
        reference: 'an earlier review round',
        verifiedDelivery: false,
        recordedBy: 'qa-0',
        recordedAt: '2026-09-01T00:00:00.000Z',
      },
    });

    const result = await approve();

    expect(result.status).toBe('DONE');
    expect(h.state.getTask('task-1')!.deliveryEvidence).toBeUndefined();
    expect(Object.keys(readTaskFile())).not.toContain('deliveryEvidence');
  });

  it('an autoCommit=false project keeps approving under the default policy, with no warning and no chat line', async () => {
    await seed({ autoCommit: false });

    const result = await approve();

    expect(result.status).toBe('DONE');
    expect(result.warnings).toEqual([]);
    expect(Object.keys(result)).not.toContain('warning');
    expect(h.state.postToRoleChannel).not.toHaveBeenCalled();
  });

  it('an autoCommit=false project delivers by hand under manual-artifact, where a configured qualityGate demands no check because the wrapper runs none', async () => {
    await seed({ autoCommit: false, deliveryPolicy: 'manual-artifact', qualityGate: 'node gate.cjs', qualityGateScope: 'everyTask' });
    await expectEvidenceRefusal({}, 'manual-artifact', ['manual-artifact']);

    const result = await approve({ manualArtifact: 'Deployed by hand: build 1.4.2 on staging' });

    expect(result.status).toBe('DONE');
    expect(result.warnings).toEqual([]);
    expect(readTaskFile().deliveryEvidence).toMatchObject({
      kind: 'manual-artifact',
      reference: 'Deployed by hand: build 1.4.2 on staging',
      verifiedDelivery: false,
    });
  });

  it('an autoCommit=false project under local-branch is refused with a message saying no wrapper commit will come', async () => {
    await seed({ autoCommit: false, deliveryPolicy: 'local-branch' });

    const err = await expectEvidenceRefusal({}, 'local-branch', ['completion-commit']);

    expect(err.message).toContain('settings.autoCommit is false, so the wrapper will record no commit');
  });

  it.each<[string, unknown, string]>([
    ['a misspelling', 'local_branch', '"local_branch"'],
    ['a case variant', 'Local-Branch', '"Local-Branch"'],
    ['an empty string', '', '""'],
    ['a number', 42, '42'],
    ['an object', { strict: true }, 'a value of type object'],
  ])('refuses %s of deliveryPolicy as invalid input instead of reading it as the default', async (_label, deliveryPolicy, shown) => {
    await seed({ deliveryPolicy });
    const bytesBefore = fs.readFileSync(taskFile(), 'utf8');

    const err = await refusalOf(approve());

    expect({ code: err.code, codeName: err.codeName, message: err.message }).toEqual({
      code: -32602,
      codeName: 'INVALID_INPUT',
      message: `[INVALID_INPUT] Invalid deliveryPolicy: must be one of legacy, local-branch, remote-push, merged-pull-request, manual-artifact (got ${shown})`,
    });
    expect(fs.readFileSync(taskFile(), 'utf8')).toBe(bytesBefore);
    expect(h.state.getTask('task-1')!.status).toBe('REVIEW');
  });

  it.each<[string, Record<string, unknown>, Record<string, unknown>, string]>([
    ['a blank manualArtifact', { deliveryPolicy: 'manual-artifact' }, { manualArtifact: '   ' }, 'Invalid manualArtifact: must be a non-blank string (got "   ")'],
    ['a non-string manualArtifact', { deliveryPolicy: 'manual-artifact' }, { manualArtifact: 42 }, 'Invalid manualArtifact: must be a non-blank string (got 42)'],
    ['an over-long mergedPullRequest', { deliveryPolicy: 'merged-pull-request' }, { mergedPullRequest: 'x'.repeat(501) }, 'Invalid mergedPullRequest: must be 500 characters or fewer (got 501)'],
    ['a manualArtifact under local-branch', { deliveryPolicy: 'local-branch' }, { manualArtifact: 'reports/q3.pdf' }, 'Invalid manualArtifact: is accepted only under deliveryPolicy manual-artifact (this project uses local-branch)'],
    ['a mergedPullRequest under manual-artifact', { deliveryPolicy: 'manual-artifact' }, { mergedPullRequest: 'https://example.test/pull/7' }, 'Invalid mergedPullRequest: is accepted only under deliveryPolicy merged-pull-request (this project uses manual-artifact)'],
    ['a manualArtifact under the default policy', {}, { manualArtifact: 'reports/q3.pdf' }, 'Invalid manualArtifact: is accepted only under deliveryPolicy manual-artifact (this project uses legacy)'],
  ])('refuses %s as invalid input and writes nothing', async (_label, settings, extra, message) => {
    await seed(settings, { commits: [completion()] });
    const bytesBefore = fs.readFileSync(taskFile(), 'utf8');

    const err = await refusalOf(approve(extra));

    expect({ code: err.code, codeName: err.codeName, message: err.message }).toEqual({
      code: -32602,
      codeName: 'INVALID_INPUT',
      message: `[INVALID_INPUT] ${message}`,
    });
    expect(fs.readFileSync(taskFile(), 'utf8')).toBe(bytesBefore);
    expect(h.state.getTask('task-1')!.status).toBe('REVIEW');
  });

  it('under a strict policy a configured qualityGate needs a runner-observed pass on the current candidate before DONE', async () => {
    writeCandidateRecord('cand-A');
    await seed(
      { deliveryPolicy: 'local-branch', qualityGate: 'node gate.cjs', qualityGateScope: 'everyTask' },
      { commits: [completion()] }
    );
    await expectEvidenceRefusal({ candidateId: 'cand-A' }, 'local-branch', ['required-check:node gate.cjs']);

    await recordCheckRun(h.state, {
      id: 'check-A-pass',
      candidateId: 'cand-A',
      treeSha: TREE_A,
      command: 'node gate.cjs',
      exitCode: 0,
      runnerId: 'runner-1',
      source: 'runner-observed',
    });

    const result = await approve({ candidateId: 'cand-A' });
    expect(result.status).toBe('DONE');
    expect(result.warnings).toEqual([]);
  });

  it('names every missing piece of evidence at once: the landing first, then the required check', async () => {
    writeCandidateRecord('cand-A');
    await seed({ deliveryPolicy: 'remote-push', qualityGate: 'node gate.cjs', qualityGateScope: 'everyTask' });

    await expectEvidenceRefusal({ candidateId: 'cand-A' }, 'remote-push', ['pushed-completion-commit', 'required-check:node gate.cjs']);
  });

  it('keeps the reviewed-candidate guard ahead of the policy: a superseded candidate is CANDIDATE_MISMATCH even on an invalid policy', async () => {
    writeCandidateRecord('cand-A', '2026-09-13T09:00:00.000Z');
    writeCandidateRecord('cand-B', '2026-09-13T09:05:00.000Z');
    await seed({ deliveryPolicy: 'not-a-policy' });

    const err = await refusalOf(approve({ candidateId: 'cand-A' }));

    expect({ code: err.code, codeName: err.codeName }).toEqual({ code: -32002, codeName: 'CANDIDATE_MISMATCH' });
  });

  it('keeps the missing-summary guard ahead of the evidence gate', async () => {
    await seed({ deliveryPolicy: 'local-branch' });

    const err = await refusalOf(qaApproveTool(h.state).handler({ taskId: 'task-1', workerId: 'qa-1' }, h.state));

    expect({ code: err.code, codeName: err.codeName }).toEqual({ code: -32602, codeName: 'MISSING_REQUIRED' });
  });

  // Handler calls bypass the schema, so only inspecting it pins the two new MCP inputs.
  it('declares manualArtifact and mergedPullRequest as optional string inputs', () => {
    const schema = qaApproveTool(h.state).inputSchema as {
      properties: Record<string, unknown>;
      required: string[];
      additionalProperties: boolean;
    };

    expect(schema.properties.manualArtifact).toMatchObject({ type: 'string' });
    expect(schema.properties.mergedPullRequest).toMatchObject({ type: 'string' });
    expect(schema.required).toEqual(['taskId', 'summary']);
    expect(schema.additionalProperties).toBe(false);
  });
});

// =============================================================================
// delivery/policy.ts — the shared evidence predicate
// =============================================================================
//
// Called directly on a DONE prerequisite modelled on acceptance criterion 2,
// because the dependency gate (task-94f53492) asks about a PREREQUISITE, never
// about the task being approved. Every decoy gets its own case, so a regression
// names the exact lookup that broke instead of failing one opaque scenario.
describe('delivery policy — evaluateDeliveryEvidence', () => {
  const h = new ToolTestHarness();
  beforeEach(() => h.init());
  afterEach(() => { vi.restoreAllMocks(); h.cleanup(); });

  const GATE = 'node gate.cjs';
  const TREE_CURRENT = 'c3'.repeat(20);
  const TREE_OLD = 'd4'.repeat(20);
  const STRICT_SETTINGS = {
    ...HARNESS_SETTINGS,
    deliveryPolicy: 'local-branch',
    autoCommit: true,
    qualityGate: GATE,
    qualityGateScope: 'everyTask',
  };

  /** A stored CheckRun on the prerequisite's current candidate; each decoy overrides what makes it wrong. */
  const run = (id: string, overrides: Record<string, unknown> = {}): { id: string } & Record<string, unknown> => ({
    id,
    candidateId: 'cand-P-current',
    treeSha: TREE_CURRENT,
    command: GATE,
    exitCode: 0,
    outputTail: 'gate ok',
    runnerId: 'runner-pilot',
    source: 'runner-observed',
    ...overrides,
  });
  const RUNNER_PASS = run('check-P-current-runner-pass');
  const FAILED_RUN = run('check-P-current-fail', { exitCode: 1, outputTail: 'gate failed' });
  const OLD_CANDIDATE_PASS = run('check-P-old-pass', { candidateId: 'cand-P-old', treeSha: TREE_OLD });
  const OTHER_TREE_PASS = run('check-P-current-other-tree-pass', { treeSha: TREE_OLD });
  const OTHER_COMMAND_PASS = run('check-P-current-other-command-pass', { command: 'node lint.cjs', outputTail: 'lint ok' });
  const AGENT_REPORTED_PASS = run('check-P-current-agent-pass', { source: 'agent-reported' });

  interface PrerequisiteFixture {
    checks?: Array<{ id: string } & Record<string, unknown>>;
    settings?: Record<string, unknown>;
    task?: Partial<Task>;
    siblings?: Array<Partial<Task>>;
  }

  /** task-P with a current and an older candidate, loaded from disk like the acceptance fixture. */
  async function seedPrerequisite(fixture: PrerequisiteFixture = {}): Promise<Task> {
    const candidate = (id: string, treeSha: string, createdAt: string) => ({
      id,
      attemptId: 'attempt-P-1',
      taskId: 'task-P',
      baseRevision: 'a1'.repeat(20),
      treeSha,
      deliveryTarget: 'refs/heads/wave1-pilot',
      createdAt,
    });
    writeFixtureRecord(h, 'candidates', candidate('cand-P-current', TREE_CURRENT, '2026-09-11T02:00:00.000Z'));
    writeFixtureRecord(h, 'candidates', candidate('cand-P-old', TREE_OLD, '2026-09-11T01:00:00.000Z'));
    for (const check of fixture.checks ?? []) writeFixtureRecord(h, 'checks', check);
    h.setupMoeFolder({ settings: (fixture.settings ?? STRICT_SETTINGS) as never });
    h.createEpic();
    h.createTask({ id: 'task-P', status: 'DONE', order: 1, ...fixture.task });
    for (const sibling of fixture.siblings ?? []) h.createTask(sibling);
    await h.state.load();
    return h.state.getTask('task-P')!;
  }

  it('builds the required-check token byte for byte as acceptance criterion 2 asserts it', () => {
    expect(requiredCheckToken('node gate.cjs')).toBe('required-check:node gate.cjs');
  });

  it('reports exactly the required check for a DONE prerequisite with a failed gate and every decoy, until a runner-observed pass exists', async () => {
    const task = await seedPrerequisite({
      checks: [FAILED_RUN, OLD_CANDIDATE_PASS, OTHER_TREE_PASS, OTHER_COMMAND_PASS, AGENT_REPORTED_PASS],
    });

    expect(evaluateDeliveryEvidence(h.state, task)).toEqual({
      policy: 'local-branch',
      satisfied: false,
      missingEvidence: ['required-check:node gate.cjs'],
    });

    await recordCheckRun(h.state, {
      id: 'check-P-current-runner-pass',
      candidateId: 'cand-P-current',
      treeSha: TREE_CURRENT,
      command: GATE,
      exitCode: 0,
      outputTail: 'gate ok',
      runnerId: 'runner-pilot',
      source: 'runner-observed',
    });

    expect(evaluateDeliveryEvidence(h.state, h.state.getTask('task-P')!)).toEqual({
      policy: 'local-branch',
      satisfied: true,
      missingEvidence: [],
    });
  });

  it.each<[string, { id: string } & Record<string, unknown>]>([
    ['a failed run on the current candidate', FAILED_RUN],
    ['a pass for an older candidate of the same task', OLD_CANDIDATE_PASS],
    ['a pass naming the current candidate on a tree it does not have', OTHER_TREE_PASS],
    ['a pass of a command that is not the required gate', OTHER_COMMAND_PASS],
    ['an agent-reported pass on the right candidate, tree and command', AGENT_REPORTED_PASS],
  ])('does not accept %s as the required check', async (_label, decoy) => {
    const task = await seedPrerequisite({ checks: [decoy] });

    expect(evaluateDeliveryEvidence(h.state, task)).toEqual({
      policy: 'local-branch',
      satisfied: false,
      missingEvidence: ['required-check:node gate.cjs'],
    });
  });

  it('accepts the one matching run on its own: current candidate, its tree, the gate command, exit 0, runner-observed', async () => {
    const task = await seedPrerequisite({ checks: [RUNNER_PASS] });

    expect(evaluateDeliveryEvidence(h.state, task)).toEqual({ policy: 'local-branch', satisfied: true, missingEvidence: [] });
  });

  it('accepts a pass recorded with a padded qualityGate verbatim, as the PowerShell wrapper records it', async () => {
    // A hand-edited project.json can pad the gate. The sh wrapper trims it before
    // running and recording; the ps1 wrapper records it verbatim. No shell sees
    // the padding, so both runs are the gate the policy requires.
    const padded = `  ${GATE}  `;
    const task = await seedPrerequisite({
      settings: { ...STRICT_SETTINGS, qualityGate: padded },
      checks: [run('check-P-current-padded-pass', { command: padded })],
    });

    expect(evaluateDeliveryEvidence(h.state, task)).toEqual({ policy: 'local-branch', satisfied: true, missingEvidence: [] });
  });

  it.each<[string, Record<string, unknown>]>([
    ['an exit code stored as a string', { exitCode: '0' }],
    ['no source', { source: undefined }],
    ['no tree', { treeSha: undefined }],
  ])('does not accept a stored run with %s', async (_label, change) => {
    const task = await seedPrerequisite({ checks: [run('check-P-malformed', change)] });

    expect(evaluateDeliveryEvidence(h.state, task).missingEvidence).toEqual(['required-check:node gate.cjs']);
  });

  it('never matches a run to a malformed current candidate that has no tree of its own', async () => {
    writeFixtureRecord(h, 'candidates', {
      id: 'cand-P-treeless',
      attemptId: 'attempt-P-1',
      taskId: 'task-P',
      baseRevision: 'a1'.repeat(20),
      deliveryTarget: 'refs/heads/wave1-pilot',
      createdAt: '2026-09-11T03:00:00.000Z',
    });
    const task = await seedPrerequisite({ checks: [run('check-P-treeless-pass', { candidateId: 'cand-P-treeless', treeSha: undefined })] });

    expect(evaluateDeliveryEvidence(h.state, task).missingEvidence).toEqual(['required-check:node gate.cjs']);
  });

  it('reports the required check missing, rather than throwing, for a task that has no candidate at all', async () => {
    h.setupMoeFolder({ settings: STRICT_SETTINGS as never });
    h.createEpic();
    h.createTask({ id: 'task-P', status: 'DONE' });
    await h.state.load();

    expect(evaluateDeliveryEvidence(h.state, h.state.getTask('task-P')!)).toEqual({
      policy: 'local-branch',
      satisfied: false,
      missingEvidence: ['required-check:node gate.cjs'],
    });
  });

  it.each<[string, 'candidates' | 'checkRuns']>([
    ['the candidate lookup', 'candidates'],
    ['the check-run lookup', 'checkRuns'],
  ])('fails closed when %s throws: the check is reported missing, never satisfied', async (_label, map) => {
    const task = await seedPrerequisite({ checks: [RUNNER_PASS] });
    vi.spyOn(h.state[map], 'values').mockImplementation(() => {
      throw new Error('records unreadable');
    });

    expect(evaluateDeliveryEvidence(h.state, task)).toEqual({
      policy: 'local-branch',
      satisfied: false,
      missingEvidence: ['required-check:node gate.cjs'],
    });
  });

  it.each<[string, Partial<Task>, string[]]>([
    ['REVIEW', { status: 'REVIEW' }, ['completion-commit', 'required-check:node gate.cjs']],
    ['WORKING', { status: 'WORKING' }, ['completion-commit', 'required-check:node gate.cjs']],
    ['DONE', { status: 'DONE' }, ['required-check:node gate.cjs']],
    ['ARCHIVED', { status: 'ARCHIVED' }, ['required-check:node gate.cjs']],
  ])('judges landing evidence only before the DONE transition, and the required check in every status (%s)', async (_label, task, missing) => {
    const seeded = await seedPrerequisite({ task });

    expect(evaluateDeliveryEvidence(h.state, seeded).missingEvidence).toEqual(missing);
  });

  it.each<[string, Record<string, unknown>]>([
    ['qualityGate is unset', { qualityGate: undefined }],
    ['qualityGate is blank', { qualityGate: '   ' }],
    ['qualityGate is not a string', { qualityGate: 42 }],
    ['autoCommit is false, so the wrapper lands nothing and runs no gate', { autoCommit: false }],
  ])('requires no check when %s', async (_label, change) => {
    const task = await seedPrerequisite({ settings: { ...STRICT_SETTINGS, ...change } });

    expect(evaluateDeliveryEvidence(h.state, task)).toEqual({ policy: 'local-branch', satisfied: true, missingEvidence: [] });
  });

  it('names the required check by the trimmed qualityGate, as the wrapper runs it, and accepts a run of that command', async () => {
    const task = await seedPrerequisite({ settings: { ...STRICT_SETTINGS, qualityGate: '  node gate.cjs\n' } });
    expect(evaluateDeliveryEvidence(h.state, task).missingEvidence).toEqual(['required-check:node gate.cjs']);

    await recordCheckRun(h.state, {
      id: 'check-P-trimmed-pass',
      candidateId: 'cand-P-current',
      treeSha: TREE_CURRENT,
      command: 'node gate.cjs',
      exitCode: 0,
      runnerId: 'runner-pilot',
      source: 'runner-observed',
    });

    expect(evaluateDeliveryEvidence(h.state, h.state.getTask('task-P')!).missingEvidence).toEqual([]);
  });

  it.each<[string, unknown]>([
    ['absent', undefined],
    ['epicFinal', 'epicFinal'],
    ['unrecognised', 'whenever'],
  ])('with qualityGateScope %s only the epic-final task needs the check', async (_label, qualityGateScope) => {
    const midEpic = await seedPrerequisite({
      settings: { ...STRICT_SETTINGS, qualityGateScope },
      siblings: [{ id: 'task-final', status: 'DONE', order: 2 }],
    });
    const final = h.state.getTask('task-final')!;

    expect([isEpicFinalTask(h.state, midEpic), isEpicFinalTask(h.state, final)]).toEqual([false, true]);
    expect(evaluateDeliveryEvidence(h.state, midEpic).missingEvidence).toEqual([]);
    expect(evaluateDeliveryEvidence(h.state, final).missingEvidence).toEqual(['required-check:node gate.cjs']);
  });

  // The wrapper runs the gate on get_context's isEpicFinal, so the policy must never demand a check the runner skipped.
  it('decides epic-final exactly as get_context does, including ties, ARCHIVED tasks and other epics', async () => {
    h.setupMoeFolder({ settings: STRICT_SETTINGS as never });
    h.createEpic();
    h.createEpic({ id: 'epic-2' });
    h.createTask({ id: 'task-low', order: 1, status: 'DONE' });
    h.createTask({ id: 'task-tie-a', order: 5, status: 'DONE' });
    h.createTask({ id: 'task-tie-b', order: 5, status: 'REVIEW' });
    h.createTask({ id: 'task-archived-high', order: 9, status: 'ARCHIVED' });
    h.createTask({ id: 'task-other-epic', epicId: 'epic-2', order: 0, status: 'DONE' });
    await h.state.load();
    const tool = getContextTool(h.state);

    const decisions: Array<[string, boolean, boolean]> = [];
    for (const id of ['task-low', 'task-tie-a', 'task-tie-b', 'task-archived-high', 'task-other-epic']) {
      const context = await tool.handler({ taskId: id, workerId: 'qa-1' }, h.state) as { task: { isEpicFinal: boolean } };
      decisions.push([id, isEpicFinalTask(h.state, h.state.getTask(id)!), context.task.isEpicFinal]);
    }

    expect(decisions).toEqual([
      ['task-low', false, false],
      ['task-tie-a', true, true],
      ['task-tie-b', true, true],
      ['task-archived-high', true, true],
      ['task-other-epic', true, true],
    ]);
  });

  it('under the default policy requires nothing, even for a REVIEW task with no commit and a configured gate', async () => {
    const task = await seedPrerequisite({ settings: { ...STRICT_SETTINGS, deliveryPolicy: undefined }, task: { status: 'REVIEW' } });

    expect(evaluateDeliveryEvidence(h.state, task)).toEqual({ policy: 'legacy', satisfied: true, missingEvidence: [] });
  });

  it.each<[string, DeliveryAttestations, DeliveryAttestations]>([
    ['manual-artifact', { mergedPullRequest: 'https://example.test/pull/7' }, { manualArtifact: 'reports/q3.pdf' }],
    ['merged-pull-request', { manualArtifact: 'reports/q3.pdf' }, { mergedPullRequest: 'https://example.test/pull/7' }],
  ])('lets no attestation stand in for another under %s', async (deliveryPolicy, wrongKind, rightKind) => {
    const task = await seedPrerequisite({
      settings: { ...STRICT_SETTINGS, deliveryPolicy, qualityGate: '' },
      task: { status: 'REVIEW' },
    });

    expect(evaluateDeliveryEvidence(h.state, task, wrongKind)).toEqual({
      policy: deliveryPolicy,
      satisfied: false,
      missingEvidence: [deliveryPolicy],
    });
    expect(evaluateDeliveryEvidence(h.state, task, rightKind)).toEqual({
      policy: deliveryPolicy,
      satisfied: true,
      missingEvidence: [],
    });
  });

  it('throws INVALID_INPUT for an unrecognised deliveryPolicy, so no consumer can read it as satisfied', async () => {
    const task = await seedPrerequisite({ settings: { ...STRICT_SETTINGS, deliveryPolicy: 'strict' } });

    let thrown: unknown;
    try {
      evaluateDeliveryEvidence(h.state, task);
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(MoeError);
    expect({ code: (thrown as MoeError).code, codeName: (thrown as MoeError).codeName }).toEqual({
      code: -32602,
      codeName: 'INVALID_INPUT',
    });
  });

  it.each<[string, unknown, string]>([
    ['absent', undefined, 'legacy'],
    ['null', null, 'legacy'],
    ['legacy', 'legacy', 'legacy'],
    ['local-branch', 'local-branch', 'local-branch'],
    ['remote-push', 'remote-push', 'remote-push'],
    ['merged-pull-request', 'merged-pull-request', 'merged-pull-request'],
    ['manual-artifact', 'manual-artifact', 'manual-artifact'],
  ])('resolves deliveryPolicy %s to %s', (_label, deliveryPolicy, expected) => {
    expect(resolveDeliveryPolicy({ deliveryPolicy })).toBe(expected);
  });

  it('resolves a project without settings to the default policy', () => {
    expect([resolveDeliveryPolicy(undefined), resolveDeliveryPolicy(null)]).toEqual(['legacy', 'legacy']);
  });
});
