import type { ToolDefinition } from './index.js';
import type { StateManager } from '../state/StateManager.js';
import type { QAIssue, QAIssueType, RejectionDetails, RejectionHistoryEntry } from '../types/schema.js';
import { MAX_REOPENS_DEFAULT } from '../types/schema.js';
import { missingRequired, invalidInput, notFound, invalidState } from '../util/errors.js';
import { assertWorkerOwns, assertContextFetched } from '../util/enforcement.js';
import { resetPlanStepsToPending } from '../util/reopen.js';

const VALID_ISSUE_TYPES: QAIssueType[] = [
  'test_failure', 'lint', 'security', 'missing_feature', 'regression', 'other'
];

export function qaRejectTool(_state: StateManager): ToolDefinition {
  return {
    name: 'moe.qa_reject',
    description: 'QA rejects a task in REVIEW status, moving it back to WORKING for fixes',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'The task ID to reject' },
        reason: {
          type: 'string',
          description: 'Detailed reason for rejection - should reference specific DoD items that failed'
        },
        failedDodItems: {
          type: 'array',
          items: { type: 'string' },
          description: 'Which Definition of Done items failed verification'
        },
        issues: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              type: { type: 'string', enum: VALID_ISSUE_TYPES },
              description: { type: 'string' },
              file: { type: 'string' },
              line: { type: 'number' }
            },
            required: ['type', 'description']
          },
          description: 'Structured list of issues found during review'
        },
        workerId: { type: 'string', description: 'Caller worker ID (auto-injected by proxy)' }
      },
      required: ['taskId', 'reason'],
      additionalProperties: false
    },
    handler: async (args, state) => {
      const params = (args || {}) as {
        taskId?: string;
        reason?: string;
        failedDodItems?: string[];
        issues?: QAIssue[];
        workerId?: string;
      };

      if (!params.taskId) {
        throw missingRequired('taskId');
      }

      if (!params.reason || params.reason.trim().length === 0) {
        throw missingRequired('reason');
      }

      // Validate reason length to prevent excessive data storage
      const MAX_REASON_LENGTH = 2000;
      if (params.reason.length > MAX_REASON_LENGTH) {
        throw invalidInput('reason', `too long (${params.reason.length} chars). Maximum ${MAX_REASON_LENGTH} characters allowed.`);
      }

      // Validate failedDodItems
      if (params.failedDodItems && params.failedDodItems.length > 20) {
        throw invalidInput('failedDodItems', 'too many items (max 20)');
      }

      // Validate issues
      if (params.issues) {
        if (params.issues.length > 20) {
          throw invalidInput('issues', 'too many items (max 20)');
        }
        for (const issue of params.issues) {
          if (!VALID_ISSUE_TYPES.includes(issue.type)) {
            throw invalidInput('issues.type', `invalid type '${issue.type}'. Valid types: ${VALID_ISSUE_TYPES.join(', ')}`);
          }
          if (!issue.description || issue.description.trim().length === 0) {
            throw invalidInput('issues.description', 'cannot be empty');
          }
          if (issue.description.length > 500) {
            throw invalidInput('issues.description', `too long (${issue.description.length} chars). Maximum 500 characters.`);
          }
        }
      }

      const task = state.getTask(params.taskId);
      if (!task) {
        throw notFound('Task', params.taskId);
      }

      if (task.status !== 'REVIEW') {
        throw invalidState('Task', task.status, 'REVIEW');
      }

      assertWorkerOwns(task, params.workerId);
      // QA must read the task before rejecting — a reject without reading the
      // DoD/rails/diff produces a bogus rejectionReason that sends the worker in
      // circles. No-ops on the human path (assignedWorkerId null).
      assertContextFetched(task, params.workerId, 'qa_reject');
      const handoffWorkerId = task.assignedWorkerId || params.workerId;

      // Dedupe + trim the failed-DoD payload up front. Two callers listing the
      // same item twice in ONE rejection must not fake a "same item failed
      // twice" signal — that flip should only fire across two DISTINCT rejects.
      // Every downstream use (history, failed-item log, repeat detection) reads
      // this deduped list rather than the raw params.
      const uniqueFailed = Array.from(
        new Set((params.failedDodItems ?? []).map((s) => s.trim()).filter((s) => s.length > 0))
      );

      // Build rejection details when structured feedback is provided. Reason-only
      // rejections must explicitly clear any stale details from previous cycles.
      let rejectionDetails: RejectionDetails | null = null;
      if (uniqueFailed.length || params.issues?.length) {
        rejectionDetails = {};
        if (uniqueFailed.length) {
          rejectionDetails.failedDodItems = uniqueFailed;
        }
        if (params.issues?.length) {
          rejectionDetails.issues = params.issues;
        }
      }

      // Append to rejectionHistory (newest-first). Capped at 20 entries so
      // a misbehaving task can't unbounded-grow.
      const nowIso = new Date().toISOString();
      const newReopenCount = task.reopenCount + 1;
      const historyEntry: RejectionHistoryEntry = {
        reason: params.reason,
        rejectedAt: nowIso,
        reopenCount: newReopenCount,
        ...(uniqueFailed.length ? { failedDodItems: uniqueFailed } : {}),
        ...(params.issues?.length ? { issues: params.issues } : {}),
      };
      const priorHistory = Array.isArray(task.rejectionHistory) ? task.rejectionHistory : [];
      const updatedHistory = [historyEntry, ...priorHistory].slice(0, 20);

      // Bounded escalation. Two tiers off the reopen cap (default
      // MAX_REOPENS_DEFAULT (3), per-task override via task.maxReopens):
      //   soft cap  (== maxReopens): flip back to PLANNING once so the
      //             architect gets ONE re-plan instead of the worker spinning.
      //   hard cap  (>  maxReopens): the re-plan didn't help either — PARK the
      //             task for a human instead of re-flipping to PLANNING forever.
      // Because reopenCount is monotonic (never reset), a single `>=` test would
      // re-flip to PLANNING on every reject past the cap — an unbounded
      // PLANNING↔WORKING↔REVIEW loop. The hard cap is the terminating tier.
      const maxReopens = typeof task.maxReopens === 'number' && task.maxReopens > 0
        ? task.maxReopens
        : MAX_REOPENS_DEFAULT;
      const softCap = maxReopens;
      const hardCap = maxReopens + 1;
      const reachedHardCap = newReopenCount >= hardCap;
      const reachedSoftCap = !reachedHardCap && newReopenCount >= softCap;

      // Append-only failed-DoD-item log. The append happens regardless of
      // reopen cap so the audit trail stays complete; what changes is whether
      // the SAME item has now failed twice in this log — that triggers an
      // immediate PLANNING flip on the assumption the task spec, not the
      // worker, is the problem.
      const priorFailed = Array.isArray(task.failedDodItems) ? task.failedDodItems : [];
      const newFailedEntries = uniqueFailed.map((item) => ({
        item,
        rejectedAt: nowIso,
        rejectedBy: params.workerId || 'qa',
      }));
      const nextFailedItems = [...priorFailed, ...newFailedEntries].slice(-100);

      // Detect same-item-failed-twice: counts every entry across history.
      // Any item present ≥2 times after this rejection forces a PLANNING flip
      // even if reopenCount hasn't crossed the cap. Uses the deduped payload so
      // duplicates within a single reject can't reach the count on their own.
      const itemCounts = new Map<string, number>();
      for (const entry of nextFailedItems) {
        itemCounts.set(entry.item, (itemCounts.get(entry.item) ?? 0) + 1);
      }
      const repeatedItem = uniqueFailed.find((item) => (itemCounts.get(item) ?? 0) >= 2);
      const triggeredBySameItem = !reachedSoftCap && !reachedHardCap && !!repeatedItem;

      // Destination: hard cap → park in REVIEW (status unchanged, unassigned,
      // flagged for a human); soft cap or same-item → PLANNING; otherwise the
      // worker fixes it in WORKING.
      const shouldReplan = reachedSoftCap || triggeredBySameItem;
      const parkedForHuman = reachedHardCap;
      const nextStatus = parkedForHuman ? 'REVIEW' : shouldReplan ? 'PLANNING' : 'WORKING';

      const priorMetrics = task.metrics ?? {};
      const nextMetrics = {
        ...priorMetrics,
        rejectCount: (priorMetrics.rejectCount ?? 0) + 1,
        reopenCount: newReopenCount,
      };

      // On reject, reset the implementation steps to PENDING so the reopened
      // plan is runnable per-step (start_step requires PENDING) and complete_task
      // cannot vacuously re-submit work with every step still marked COMPLETED.
      // This applies to the WORKING and PLANNING destinations: a WORKING reopen
      // reruns the steps, and a PLANNING auto-flip must not leave an
      // all-COMPLETED plan behind that a later WORKING transition could vacuously
      // complete before the architect resubmits. When PARKED, the task stays in
      // REVIEW awaiting a human — preserve the completed steps (and diff) so the
      // reviewer sees the actual attempt; the human's later reopen scrubs them
      // via buildReopenClearingUpdates.
      const resetSteps =
        !parkedForHuman &&
        Array.isArray(task.implementationPlan) &&
        task.implementationPlan.length > 0;

      const updatePayload: Record<string, unknown> = {
        status: nextStatus,
        reopenCount: newReopenCount,
        reopenReason: params.reason,
        reviewCompletedAt: nowIso,
        // Schema treats rejectionDetails as optional, not nullable. We
        // either write the new structured details or set undefined to clear
        // any stale value from the prior rejection cycle (serializing as a
        // missing key rather than null).
        rejectionDetails: rejectionDetails ?? undefined,
        rejectionHistory: updatedHistory,
        failedDodItems: nextFailedItems,
        // Force a fresh get_context on re-claim: whoever picks the reopened task
        // up (worker on WORKING, architect on PLANNING) must re-read the
        // rejectionReason/rejectionDetails, not resume on a stale context stamp.
        contextFetchedBy: [],
        metrics: nextMetrics,
        // Park for a human: clear the assignee (so no worker owns it) and flag
        // it so the QA claim pool skips it. Status stays REVIEW — inert, not
        // re-flipping to PLANNING — until a human clears the flag.
        ...(parkedForHuman ? { assignedWorkerId: null, needsHumanReview: true } : {}),
        ...(resetSteps
          ? {
              implementationPlan: resetPlanStepsToPending(task.implementationPlan),
              stepsCompleted: [],
            }
          : {}),
      };

      const updated = await state.updateTask(
        params.taskId,
        updatePayload,
        'QA_REJECTED'
      );

      // Escalation messaging, one branch per destination.
      if (parkedForHuman) {
        // Hard cap: reopen budget AND the one architect re-plan are both spent.
        // Stop the loop and hand it to a human — post to BOTH #governors and
        // #architects so whoever is watching sees it.
        state.appendActivity('TASK_REOPENED', {
          taskId: updated.id,
          reopenCount: newReopenCount,
          maxReopens,
          rejectionHistory: updatedHistory,
          reason: 'reopen budget + architect re-plan exhausted; parked in REVIEW for a human',
        }, updated);
        const parkMsg = `🛑 HUMAN INTERVENTION REQUIRED — ${updated.id} exhausted its reopen budget (${newReopenCount}/${maxReopens}) and the architect re-plan. Parked in REVIEW (unassigned), excluded from the QA queue until a human reopens or approves it. Latest: ${updatedHistory
          .slice(0, 3)
          .map((h) => `[#${h.reopenCount}] ${h.reason.slice(0, 80)}`)
          .join(' | ')}`;
        try { await state.postToRoleChannel('governors', parkMsg); } catch { /* never block tool */ }
        try { await state.postToRoleChannel('architects', parkMsg); } catch { /* never block tool */ }
      } else if (reachedSoftCap) {
        // Soft cap: cross-post to #architects with the full history so the
        // architect can re-plan with context, and surface it in the activity log.
        state.appendActivity('TASK_REOPENED', {
          taskId: updated.id,
          reopenCount: newReopenCount,
          maxReopens,
          rejectionHistory: updatedHistory,
          reason: 'reopen cap reached; flipped back to PLANNING for one re-plan',
        }, updated);
        try {
          await state.postToRoleChannel(
            'architects',
            `⚠️ ${updated.id} hit reopen cap (${newReopenCount}/${maxReopens}); flipped to PLANNING for re-plan. Reasons: ${updatedHistory
              .slice(0, 3)
              .map((h) => `[#${h.reopenCount}] ${h.reason.slice(0, 80)}`)
              .join(' | ')}`
          );
        } catch { /* never block tool */ }
      } else if (triggeredBySameItem && repeatedItem) {
        // Same-DoD-item failed twice: structural problem, not worker error.
        // Architect should re-plan with the recurring item highlighted.
        state.appendActivity('TASK_REOPENED', {
          taskId: updated.id,
          reopenCount: newReopenCount,
          maxReopens,
          repeatedFailedDodItem: repeatedItem,
          reason: 'Same DoD item failed twice; flipped back to PLANNING',
        }, updated);
        try {
          await state.postToRoleChannel(
            'architects',
            `⚠️ ${updated.id} flipped to PLANNING — DoD item failed twice: "${repeatedItem.slice(0, 200)}". Re-plan with this item as a focus.`
          );
        } catch { /* never block tool */ }
      }

      // Use the captured assignee because updateTask clears assignedWorkerId on
      // REVIEW -> WORKING handoff. touchWorker skips missing worker records.
      await state.touchWorker(handoffWorkerId, { status: 'IDLE', currentTaskId: null });

      // Post system message to task channel
      try {
        await state.postSystemMessage(params.taskId, `QA rejected: ${params.reason}`);
      } catch { /* never block tool */ }

      // Cross-post structured rejection to #governors so the governor's chat_wait
      // surfaces it. Governor triages: first rejection = let the worker fix in
      // WORKING; repeated rejections on the same DoD item = flip back to PLANNING.
      try {
        const reopenCount = (updated.reopenCount ?? 0);
        const reopenTag = reopenCount > 1 ? ` (reopen #${reopenCount})` : '';
        const reasonSummary = params.reason.length > 200 ? params.reason.slice(0, 200) + '…' : params.reason;
        await state.postToRoleChannel(
          'governors',
          `❌ QA rejected ${params.taskId}${reopenTag}: ${reasonSummary}`
        );
      } catch { /* never block tool */ }

      const destination = shouldReplan ? 'PLANNING' : 'WORKING';
      const replanReason = reachedSoftCap
        ? 'reopen cap reached'
        : triggeredBySameItem
          ? `same DoD item failed twice: "${(repeatedItem ?? '').slice(0, 120)}"`
          : null;
      const message = parkedForHuman
        ? `Task ${updated.id} rejected and PARKED in REVIEW — reopen budget (${newReopenCount}/${maxReopens}) and the architect re-plan are exhausted. A human must reopen or approve it; it is excluded from the QA queue until then.`
        : replanReason
          ? `Task ${updated.id} rejected and flipped to PLANNING (${replanReason}). Architect will re-plan.`
          : `Task ${updated.id} rejected and moved to ${destination}. Worker should address: ${params.reason}`;
      return {
        success: true,
        taskId: updated.id,
        status: updated.status,
        reopenCount: updated.reopenCount,
        maxReopens,
        exceededReopenCap: reachedSoftCap || reachedHardCap,
        parkedForHuman,
        needsHumanReview: updated.needsHumanReview ?? false,
        repeatedFailedDodItem: triggeredBySameItem ? repeatedItem : undefined,
        reason: params.reason,
        rejectionDetails,
        rejectionHistory: updatedHistory,
        failedDodItems: updated.failedDodItems ?? nextFailedItems,
        message,
        nextAction: {
          tool: 'moe.wait_for_task',
          args: {
            statuses: ['REVIEW'],
            workerId: params.workerId,
          },
          reason: 'Rejection recorded on the task. Capture the failure pattern with Serena write_memory (gotcha-<area>) so future work avoids it, then block until the next REVIEW task arrives.'
        }
      };
    }
  };
}
