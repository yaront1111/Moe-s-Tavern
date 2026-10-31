// =============================================================================
// Review binding (CQ-V06): what a strict QA decision is bound to
// =============================================================================
//
// Under verified-local a qa_approve or qa_reject is bound to three things, each
// judged by the authority that already owns it, never by a second copy:
//   - the reviewer's OWN running attempt, approved plan revision and served-context
//     receipt: assertExecutionAuthorized, the F07/F08 fence complete_task uses;
//   - the task's CURRENT candidate, named explicitly: resolveReviewedCandidate;
//   - for an approval only, a candidate produced under that approved revision, read
//     from the PRODUCER attempt's snapshot. candidate.attemptId is the producer's
//     provenance and is never compared with the reviewer's attempt.
// A rejection never delivers, so a stale-revision candidate can still be rejected.
// Legacy and observe keep today's behavior exactly, the omission warning included.
// Read-only: every refusal precedes the caller's first write.

import type { StateManager } from '../state/StateManager.js';
import type { Task } from '../types/schema.js';
import { getAttempt } from '../state/attemptStore.js';
import { getCandidate, listCandidatesForTask } from '../state/candidateStore.js';
import { resolveReviewedCandidate, type ReviewedCandidateBinding } from '../state/reviewStore.js';
import { assertExecutionAuthorized } from '../util/executionAuthorization.js';
import { MoeError, MoeErrorCode } from '../util/errors.js';
import { readExecutionPolicySnapshot } from './executionProfile.js';

export type ReviewDecision = 'approve' | 'reject';

/** What a QA caller presents. The identity is untyped on purpose: it arrives from MCP args. */
export interface ReviewBindingParams {
  workerId?: string;
  candidateId?: unknown;
  attemptId?: unknown;
  generation?: unknown;
  sessionId?: unknown;
}

/** The plan revision a candidate was produced under, from its producer attempt's snapshot; null when unreadable. */
function producedRevision(state: StateManager, candidateId: string): number | null {
  try {
    const candidate = getCandidate(state, candidateId);
    const producer = candidate ? getAttempt(state, candidate.attemptId) : null;
    return readExecutionPolicySnapshot(producer?.executionPolicySnapshot)?.planRevision ?? null;
  } catch {
    return null; // A malformed snapshot fails closed: it proves no revision.
  }
}

/**
 * Refuses CANDIDATE_REVISION_STALE unless `candidateId` was produced under
 * `planRevision`, the approved revision. A missing producer attempt or snapshot,
 * or a malformed one, reports candidateRevision null and is refused the same way.
 */
export function assertReviewedCandidateCurrent(state: StateManager, task: Task, candidateId: string, planRevision: number): void {
  const candidateRevision = producedRevision(state, candidateId);
  if (candidateRevision === planRevision) return;
  throw new MoeError(MoeErrorCode.STATE_CONFLICT,
    `Candidate ${candidateId} of task ${task.id} was produced under plan revision ${candidateRevision ?? 'unknown'}, not the ` +
      `approved revision ${planRevision}, so it cannot be approved; reject it so the work is redone under the approved plan.`,
    { taskId: task.id, candidateId, candidateRevision, planRevision }, 'CANDIDATE_REVISION_STALE');
}

/**
 * The candidate a QA decision binds to. Legacy and observe: resolveReviewedCandidate,
 * unchanged. Strict, in order: QA's own execution identity (assertExecutionAuthorized:
 * STEP_ENTRY_IDENTITY_REQUIRED, ATTEMPT_SUPERSEDED, ATTEMPT_NOT_RUNNING,
 * PLAN_REVISION_NOT_APPROVED, CONTEXT_RECEIPT_STALE), then an explicitly named current
 * candidate (REVIEWED_CANDIDATE_REQUIRED, CANDIDATE_MISMATCH), then for an approval
 * that candidate's revision (CANDIDATE_REVISION_STALE). Hold state.mutex.
 */
export function assertReviewBinding(
  state: StateManager, task: Task, params: ReviewBindingParams, decision: ReviewDecision
): ReviewedCandidateBinding {
  const toolName = decision === 'approve' ? 'qa_approve' : 'qa_reject';
  const { workerId, candidateId, attemptId, generation, sessionId } = params;
  const strict = assertExecutionAuthorized(state, task, workerId, { attemptId, generation, sessionId }, `moe.${toolName}`);
  if (!strict) return resolveReviewedCandidate(state, task.id, candidateId, toolName);

  const binding = candidateId === undefined || candidateId === null ? {} : resolveReviewedCandidate(state, task.id, candidateId, toolName);
  if (!binding.candidateId) {
    const candidates = listCandidatesForTask(state, task.id);
    throw new MoeError(MoeErrorCode.MISSING_REQUIRED,
      `${toolName} on verified-local task ${task.id} requires candidateId, the current candidate you reviewed ` +
        '(moe.get_context -> currentCandidate.id); a task with no candidate cannot be reviewed under verified-local.',
      { taskId: task.id, currentCandidateId: candidates[candidates.length - 1]?.id ?? null }, 'REVIEWED_CANDIDATE_REQUIRED');
  }
  if (decision === 'approve') assertReviewedCandidateCurrent(state, task, binding.candidateId, strict.planRevision);
  return binding;
}
