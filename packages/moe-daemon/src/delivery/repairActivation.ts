// =============================================================================
// Repair decision activation — CQ-V05b (task-66e8d7d1)
// =============================================================================
//
// Acts on CQ-V05's decision (repairPolicy.ts) for each authenticated check
// observation of a verified-local task: the plan's "Refresh, repair, or replan".
// EXISTING transitions only: qa_reject's WORKING reopen shape without its QA
// bookkeeping (no reopenCount, tier, effort or model change: the code-repair
// budget is the bound), and request_replan's PLANNING shape. No scheduler and
// no revision authority: retry-infra is returned to the runner, which
// re-dispatches. Legacy and observe tasks are never judged. verified-local stays
// unavailable, so only a hand-edited strict snapshot reaches this today.

import type { StateManager } from '../state/StateManager.js';
import type { CheckRun, Task } from '../types/schema.js';
import { getCheckDispatch, isAuthenticatedCheckRun } from '../state/checkObservationStore.js';
import { listCandidatesForTask } from '../state/candidateStore.js';
import { listCheckRunsForCandidate } from '../state/checkRunStore.js';
import { decodeStoredPlanRevision } from '../state/taskStore.js';
import { resetPlanStepsToPending } from '../util/reopen.js';
import { generateId } from '../util/ids.js';
import { logger } from '../util/logger.js';
import { isVerifiedLocal } from './policy.js';
import { decideRepair, resolveRepairPolicy, type RepairDecision, type RepairDiagnostics } from './repairPolicy.js';

/**
 * CQ-V05's decision for `run`, from the authenticated runs of the same check (the
 * dispatch's command and checkId) across the task's candidates. Null when the run
 * has no recorded dispatch or task, is not authenticated, belongs to a task that
 * is not verified-local, or is on a candidate that is not the task's latest.
 * On the latest candidate, a decision carrying diagnostics is returned only for
 * the run it names (diagnostics.checkRunId), so a late run never re-targets a
 * repair. A decision without diagnostics (none or replan) is returned even for a
 * late or replayed run on that candidate. That is benign: replan follows the
 * task's plan revision, not the run; checkObservationStore's marker admits one
 * result run per dispatch (another id is CHECK_DISPATCH_ALREADY_OBSERVED); and
 * moe.record_check_observation's activateRepair never applies a decision for a
 * duplicate observation. A malformed setting, snapshot or stored revision throws
 * INVALID_INPUT.
 */
export function decideCheckRepair(state: StateManager, run: CheckRun): { task: Task; decision: RepairDecision } | null {
  const dispatch = run.dispatchId === undefined ? null : getCheckDispatch(state, run.dispatchId);
  const task = dispatch ? state.getTask(dispatch.taskId) : null;
  if (!dispatch || !task || !isAuthenticatedCheckRun(state, run) || !isVerifiedLocal(state, task)) return null;
  const candidates = listCandidatesForTask(state, task.id);
  if (candidates.at(-1)?.id !== run.candidateId) return null;
  const sameCheck = (r: CheckRun): boolean => {
    const d = r.dispatchId === undefined ? null : getCheckDispatch(state, r.dispatchId);
    return d !== null && d.command === dispatch.command && d.checkId === dispatch.checkId && isAuthenticatedCheckRun(state, r);
  };
  const approved = task.approvedPlanRevision;
  const decision = decideRepair({
    planRevision: decodeStoredPlanRevision(task),
    ...(typeof approved === 'number' ? { approvedPlanRevision: approved } : {}),
    candidates: candidates.map(({ id, treeSha }) => ({ id, treeSha })),
    runs: candidates.flatMap((c) => listCheckRunsForCandidate(state, c.id)).filter(sameCheck),
    policy: resolveRepairPolicy(state.project?.settings as unknown as { repairPolicy?: unknown } | undefined),
  });
  if ('diagnostics' in decision && decision.diagnostics.checkRunId !== run.id) return null;
  return { task, decision };
}

async function post(state: StateManager, role: string, content: string, taskId: string): Promise<void> {
  try {
    await state.postToRoleChannel(role, content);
  } catch (error) {
    logger.warn({ taskId, role, error }, 'Repair activation: role-channel post failed; the transition stands');
  }
}

/** The diagnostics comment, appended to the CURRENT row. */
async function comment(state: StateManager, taskId: string, d: RepairDiagnostics, header: string, line: string): Promise<void> {
  const content = [header, line, `Log refs: ${d.logRefs.join(', ')}`, 'Excerpt:', d.excerpt].join('\n');
  const existing = state.getTask(taskId)?.comments ?? [];
  const added = { id: generateId('comment'), author: 'moe-daemon', content, timestamp: new Date().toISOString() };
  await state.updateTask(taskId, { comments: [...existing, added] }, 'TASK_COMMENT_ADDED');
}

/** request_replan's PLANNING payload, for a WORKING or REVIEW task only. */
async function replan(state: StateManager, task: Task): Promise<void> {
  if (task.status !== 'WORKING' && task.status !== 'REVIEW') return;
  const reason = `Plan revision ${decodeStoredPlanRevision(task)} is not approved (approved: ${task.approvedPlanRevision ?? 'none'}); ` +
    'a required check result routed the task to PLANNING.';
  const priorAttempt = { attemptedAt: new Date().toISOString(), reason,
    implementationPlan: task.implementationPlan ?? [], stepsCompleted: task.stepsCompleted ?? [] };
  await state.updateTask(task.id, { status: 'PLANNING', implementationPlan: [], stepsCompleted: [], priorAttempt, reopenReason: reason }, 'TASK_REOPENED');
  await post(state, 'architects', `🔁 ${task.id} routed to PLANNING: ${reason}`, task.id);
}

/**
 * Acts on decideCheckRepair's decision. repair: an unparked REVIEW task returns to
 * WORKING under the same plan revision, plus a diagnostics comment in any status.
 * escalate: the comment and a #governors alert. replan: PLANNING. retry-infra and
 * none: nothing. updateTask releases the previous seat. A failed write throws.
 */
export async function applyRepairDecision(state: StateManager, task: Task, decision: RepairDecision): Promise<void> {
  if (decision.action === 'replan') return replan(state, task);
  if (decision.action !== 'repair' && decision.action !== 'escalate') return;
  const d = decision.diagnostics;
  const header = `Required check ${d.checkRunId} failed on candidate ${d.candidateId}: \`${d.command}\` ${d.outcome} (exit ${d.exitCode}).`;
  if (decision.action === 'escalate') {
    await comment(state, task.id, d, header, `Escalated: ${decision.reason}. No automatic repair follows.`);
    await post(state, 'governors', `⚠️ ${task.id} required check escalated (${decision.reason}): \`${d.command}\` ${d.outcome} ` +
      `on ${d.candidateId}; log refs ${d.logRefs.join(', ')}.`, task.id);
    return;
  }
  const line = `Repair attempt ${decision.attempt}, ${decision.remaining} remaining, under approved plan revision ${task.approvedPlanRevision}.`;
  if (task.status === 'REVIEW' && task.needsHumanReview !== true) {
    await state.updateTask(task.id, { status: 'WORKING', reopenReason: `${header} ${line}`, contextFetchedBy: [],
      implementationPlan: resetPlanStepsToPending(task.implementationPlan ?? []), stepsCompleted: [] }, 'TASK_REOPENED');
  }
  await comment(state, task.id, d, header, line);
}
