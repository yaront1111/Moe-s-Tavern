import type { ExecutionAttempt, Task } from '../types/schema.js';
import type { StateManager } from '../state/StateManager.js';
import { currentAttempt, readContextReceipt, readContextSessionId, readStepCompletions } from '../state/attemptStore.js';
import { decodeStoredPlanRevision } from '../state/taskStore.js';
import { readExecutionPolicySnapshot, resolveTaskExecutionProfile } from '../delivery/executionProfile.js';
import { assertAttemptCurrent, type AttemptIdentity } from './enforcement.js';
import { MoeError, MoeErrorCode, invalidInput } from './errors.js';

/** release_task's bound: an ATTEMPT_SUPERSEDED refusal echoes the presented id. */
const MAX_ATTEMPT_ID_LEN = 128;

/** What an executing caller presents. Untyped on purpose: it arrives from MCP args. */
export type ExecutionIdentity = { attemptId?: unknown; generation?: unknown; sessionId?: unknown };

/** What a strict authorization binds: the caller's running attempt and the approved revision. */
export type StrictExecution = { attempt: ExecutionAttempt; planRevision: number };

function conflict(message: string, context: Record<string, unknown>, codeName: string): MoeError {
  return new MoeError(MoeErrorCode.STATE_CONFLICT, message, context, codeName);
}

/**
 * Execution authorization (CQ-F07 step entry; CQ-F08 reuses it for step and task
 * completion). Read-only: every refusal precedes any write. Passing grants ENTRY
 * only, never readiness: verified-local stays unavailable at claim and at
 * progression. Returns null for legacy/observe, else the strict binding.
 * Decision order:
 *  1. Every profile: a malformed identity is INVALID_INPUT (never coerced), and a
 *     presented attempt that is superseded, closed or future is ATTEMPT_SUPERSEDED.
 *  2. Strictness: the task's resolved profile, or the open attempt's recorded
 *     snapshot, is verified-local. Malformed fails closed. Legacy/observe return
 *     here with worker-ID-only freshness: the explicit compatibility path.
 *  3. Strict identity: workerId, attemptId, generation and sessionId are required.
 *  4. The open attempt is running and belongs to the caller.
 *  5. Approval identity, from the Task only: approvedPlanRevision === planRevision.
 *  6. Source validity, from the served-context receipt only: bound to this
 *     attempt, generation, worker, session and approved revision.
 * Steps 5 and 6 are separate on purpose: a receipt or packet never grants approval,
 * and a current approval never stands in for a missing or stale receipt. Hold state.mutex.
 */
export function assertExecutionAuthorized(
  state: StateManager, task: Task, workerId: string | undefined, identity: ExecutionIdentity, toolName: string
): StrictExecution | null {
  const { attemptId, generation } = identity;
  if (typeof attemptId === 'string' && attemptId.length > MAX_ATTEMPT_ID_LEN) {
    throw invalidInput('attemptId', `must be at most ${MAX_ATTEMPT_ID_LEN} characters`);
  }
  const sessionId = readContextSessionId(identity.sessionId);
  assertAttemptCurrent(state, task, { attemptId, generation } as AttemptIdentity, toolName);

  const open = currentAttempt(state, task.id);
  const strict = resolveTaskExecutionProfile(state.project?.settings, task.executionPolicySnapshot) === 'verified-local'
    || readExecutionPolicySnapshot(open?.executionPolicySnapshot)?.profile === 'verified-local';
  if (!strict) return null;

  const missing = Object.entries({ workerId: workerId || undefined, attemptId, generation, sessionId })
    .filter(([, value]) => value === undefined).map(([key]) => key);
  if (missing.length > 0) {
    throw new MoeError(MoeErrorCode.MISSING_REQUIRED,
      `${toolName} on verified-local task ${task.id} requires ${missing.join(', ')}: attemptId and generation come from ` +
        'moe.claim_next_task, sessionId from the session that read moe.get_context.',
      { taskId: task.id, missing }, 'STEP_ENTRY_IDENTITY_REQUIRED');
  }
  if (!open || open.phase !== 'running' || open.workerId !== workerId) {
    throw conflict(
      `${toolName} on task ${task.id} needs ${workerId}'s running attempt (found ${open ? `${open.id} ${open.phase}` : 'none'}); ` +
        'reattach or re-claim with moe.claim_next_task, then read moe.get_context.',
      { taskId: task.id, attemptId: open?.id ?? null, phase: open?.phase ?? null }, 'ATTEMPT_NOT_RUNNING');
  }

  const planRevision = decodeStoredPlanRevision(task);
  const approved = task.approvedPlanRevision;
  if (approved !== planRevision) {
    throw conflict(
      `${toolName} on task ${task.id}: plan revision ${planRevision} is not approved (approved: ${approved ?? 'none'}); ` +
        'the changed plan needs re-approval before execution.',
      { taskId: task.id, planRevision, approvedPlanRevision: Number.isSafeInteger(approved) ? approved : null },
      'PLAN_REVISION_NOT_APPROVED');
  }

  const receipt = readContextReceipt(open.contextReceipt);
  const expected = {
    taskId: task.id, attemptId: open.id, generation: open.generation, workerId, sessionId,
    planRevision, approvedPlanRevision: planRevision,
  };
  const stale = receipt
    ? Object.entries(expected).filter(([key, value]) => receipt[key as keyof typeof expected] !== value).map(([key]) => key)
    : ['receipt'];
  if (stale.length > 0) {
    throw conflict(
      `${toolName} on task ${task.id}: this session's served-context receipt is stale (${stale.join(', ')}); ` +
        `call moe.get_context { taskId: "${task.id}", sessionId } from this session, then retry.`,
      { taskId: task.id, attemptId: open.id, stale }, 'CONTEXT_RECEIPT_STALE');
  }
  return { attempt: open, planRevision };
}

/**
 * Completion evidence eligibility (CQ-F08), a third gate separate from approval
 * (the Task) and source validity (the receipt). Read-only. Every plan step needs
 * evidence recorded on the strict binding's attempt under its approved revision;
 * evidence from a superseded attempt or another revision stays recorded but does
 * not count. Malformed evidence fails closed with INVALID_INPUT.
 */
export function assertCompletionEvidenceEligible(task: Task, strict: StrictExecution, toolName: string): void {
  const { attempt, planRevision } = strict;
  const evidence = readStepCompletions(attempt.stepCompletions);
  const steps = (task.implementationPlan ?? []).map((s) => s.stepId)
    .filter((stepId) => !evidence.some((e) => e.stepId === stepId && e.planRevision === planRevision));
  if (steps.length > 0) {
    throw conflict(
      `${toolName} on task ${task.id}: no step evidence for ${steps.join(', ')} on attempt ${attempt.id} at plan revision ` +
        `${planRevision}; any earlier evidence stays recorded but was produced under another attempt or revision. ` +
        'Re-execute those steps through moe.request_replan.',
      { taskId: task.id, attemptId: attempt.id, generation: attempt.generation, planRevision, steps },
      'EXECUTION_EVIDENCE_INELIGIBLE');
  }
}
