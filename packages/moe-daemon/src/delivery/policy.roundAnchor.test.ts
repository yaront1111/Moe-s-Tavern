// =============================================================================
// A reopen opens a new work round. set_task_status, StateManager.reopenTask and
// the board's reopen drag record no rejection, so before reopenedAt the round
// stayed anchored on the previous round's start, and the completion commit that
// round landed satisfied the next review: qa_approve stayed silent, a strict
// deliveryPolicy approved, and the unrecorded-landing retry skipped the row.
// buildReopenClearingUpdates stamps reopenedAt for every such path (the
// required-check repair's REVIEW -> WORKING stamps it directly), and
// completionCommitsForReview anchors on the later of it and the newest rejection.
// =============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToolTestHarness } from '../tools/toolTestHarness.js';
import { qaApproveTool } from '../tools/qaApprove.js';
import { setTaskStatusTool } from '../tools/setTaskStatus.js';
import { buildReopenClearingUpdates } from '../util/reopen.js';
import { completionCommitsForReview, evaluateDeliveryEvidence } from './policy.js';
import { applyRepairDecision } from './repairActivation.js';
import type { Task, TaskCommit } from '../types/schema.js';

const ROUND_1_START = '2026-11-05T00:00:00.000Z';

function completion(sha: string, recordedAt: string): TaskCommit {
  return {
    sha, ref: 'refs/heads/moe/work-2026-11-05', kind: 'completion', role: 'worker',
    sessionId: `worker-1@${ROUND_1_START}`, paths: ['src/a.ts'], pushed: true, recordedBy: 'worker-1', recordedAt,
  };
}

const OLD = completion('a1'.repeat(20), '2026-11-05T01:00:00.000Z');
const NEW = completion('b2'.repeat(20), '2026-11-05T03:00:00.000Z');

describe('completionCommitsForReview: the round starts at the later of the newest rejection and the newest reopen', () => {
  const rejected = (rejectedAt: string): Partial<Task> => ({ rejectionHistory: [{ reason: 'r', rejectedAt, reopenCount: 1 }] });

  it.each<[string, Partial<Task>, string[]]>([
    ['a reopen and no rejection', { reopenedAt: '2026-11-05T02:00:00.000Z' }, [NEW.sha]],
    ['a reopen after the newest rejection', { reopenedAt: '2026-11-05T02:00:00.000Z', ...rejected('2026-11-05T00:30:00.000Z') }, [NEW.sha]],
    ['a rejection after the newest reopen', { reopenedAt: '2026-11-05T00:30:00.000Z', ...rejected('2026-11-05T02:00:00.000Z') }, [NEW.sha]],
    ['neither, so the first step start', {}, [OLD.sha, NEW.sha]],
  ])('with %s', (_label, marks, expected) => {
    const counted = completionCommitsForReview({ commits: [OLD, NEW], workStartedAt: ROUND_1_START, ...marks });
    expect(counted.map((c) => c.sha)).toEqual(expected);
  });
});

describe('every reopen stamps reopenedAt, so the previous round\'s completion commit stops counting', () => {
  const h = new ToolTestHarness();
  beforeEach(() => h.init());
  afterEach(() => { vi.restoreAllMocks(); h.cleanup(); });

  const NO_COMMIT = 'NO-COMPLETION-COMMIT: task task-1 has no completion commit recorded yet';
  const HARNESS_SETTINGS = {
    approvalMode: 'CONTROL', speedModeDelayMs: 2000, autoCreateBranch: true,
    branchPattern: 'moe/{epicId}/{taskId}', commitPattern: 'feat({epicId}): {taskTitle}', agentCommand: 'claude',
  };

  /** task-1 DONE after round 1, whose completion commit is recorded. */
  async function seed(settings: Record<string, unknown> = {}): Promise<void> {
    h.setupMoeFolder({ settings: { ...HARNESS_SETTINGS, ...settings } as never });
    h.createEpic();
    h.createTask({
      id: 'task-1', status: 'DONE', workStartedAt: ROUND_1_START, commits: [OLD],
      reviewStartedAt: '2026-11-05T01:00:05.000Z', completedAt: '2026-11-05T01:10:00.000Z',
    });
    await h.state.load();
    vi.spyOn(h.state, 'postToRoleChannel').mockResolvedValue(undefined);
  }

  it('buildReopenClearingUpdates stamps the reopen time', () => {
    const before = new Date().toISOString();
    const { reopenedAt } = buildReopenClearingUpdates({ reopenCount: 0 } as Task);
    expect(typeof reopenedAt).toBe('string');
    expect(reopenedAt! >= before && reopenedAt! <= new Date().toISOString()).toBe(true);
  });

  it('StateManager.reopenTask stamps it', async () => {
    await seed();
    await h.state.reopenTask('task-1', 'regression found');

    const task = h.state.getTask('task-1')!;
    expect(task.reopenedAt).toEqual(expect.any(String));
    expect(completionCommitsForReview(task)).toEqual([]);
  });

  it('after a set_task_status reopen, qa_approve warns when only the previous round committed', async () => {
    await seed();
    await setTaskStatusTool(h.state).handler({ taskId: 'task-1', status: 'WORKING', reason: 'regression found' }, h.state);
    expect(h.state.getTask('task-1')!.reopenedAt).toEqual(expect.any(String));
    await h.state.updateTask('task-1', { status: 'REVIEW', reviewStartedAt: new Date().toISOString() });

    const result = await qaApproveTool(h.state).handler({ taskId: 'task-1', summary: 'verified' }, h.state) as { warning?: string };

    expect(result.warning).toContain(NO_COMMIT);
    expect(h.state.postToRoleChannel).toHaveBeenCalledWith('governors', expect.stringContaining(NO_COMMIT));
  });

  it('a required-check repair reopen (REVIEW back to WORKING) stamps it too', async () => {
    await seed();
    await h.state.updateTask('task-1', { status: 'REVIEW' });
    await applyRepairDecision(h.state, h.state.getTask('task-1')!, {
      action: 'repair', attempt: 1, remaining: 2,
      diagnostics: { checkRunId: 'run-1', candidateId: 'cand-1', command: 'npm test', outcome: 'code-failure', exitCode: 1, excerpt: 'boom', logRefs: ['run-1'] },
    });

    const task = h.state.getTask('task-1')!;
    expect(task.status).toBe('WORKING');
    expect(task.reopenedAt).toEqual(expect.any(String));
    expect(completionCommitsForReview(task)).toEqual([]);
  });

  it('after a reopen, a strict local-branch policy owes a completion commit for the new round', async () => {
    await seed({ deliveryPolicy: 'local-branch' });
    await h.state.reopenTask('task-1', 'regression found');
    await h.state.updateTask('task-1', { status: 'REVIEW', reviewStartedAt: new Date().toISOString() });

    expect(evaluateDeliveryEvidence(h.state, h.state.getTask('task-1')!)).toEqual({
      policy: 'local-branch', satisfied: false, missingEvidence: ['completion-commit'],
    });
  });
});
