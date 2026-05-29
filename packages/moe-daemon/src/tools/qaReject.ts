import type { ToolDefinition } from './index.js';
import type { StateManager } from '../state/StateManager.js';
import type { QAIssue, QAIssueType, RejectionDetails, RejectionHistoryEntry } from '../types/schema.js';
import { MAX_REOPENS_DEFAULT } from '../types/schema.js';
import { missingRequired, invalidInput, notFound, invalidState } from '../util/errors.js';
import { assertWorkerOwns } from '../util/enforcement.js';

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
      const handoffWorkerId = task.assignedWorkerId || params.workerId;

      // Build rejection details when structured feedback is provided. Reason-only
      // rejections must explicitly clear any stale details from previous cycles.
      let rejectionDetails: RejectionDetails | null = null;
      if (params.failedDodItems?.length || params.issues?.length) {
        rejectionDetails = {};
        if (params.failedDodItems?.length) {
          rejectionDetails.failedDodItems = params.failedDodItems;
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
        ...(params.failedDodItems?.length ? { failedDodItems: params.failedDodItems } : {}),
        ...(params.issues?.length ? { issues: params.issues } : {}),
      };
      const priorHistory = Array.isArray(task.rejectionHistory) ? task.rejectionHistory : [];
      const updatedHistory = [historyEntry, ...priorHistory].slice(0, 20);

      // Auto-flip back to PLANNING when reopen count crosses the cap so the
      // architect picks the task up instead of the worker spinning on the
      // same rejection. Default cap is MAX_REOPENS_DEFAULT (3); per-task
      // overrides via task.maxReopens.
      const maxReopens = typeof task.maxReopens === 'number' && task.maxReopens > 0
        ? task.maxReopens
        : MAX_REOPENS_DEFAULT;
      const exceededCap = newReopenCount >= maxReopens;

      // Append-only failed-DoD-item log. The append happens regardless of
      // reopen cap so the audit trail stays complete; what changes is whether
      // the SAME item has now failed twice in this log — that triggers an
      // immediate PLANNING flip on the assumption the task spec, not the
      // worker, is the problem.
      const priorFailed = Array.isArray(task.failedDodItems) ? task.failedDodItems : [];
      const newFailedEntries = (params.failedDodItems ?? []).map((item) => ({
        item,
        rejectedAt: nowIso,
        rejectedBy: params.workerId || 'qa',
      }));
      const nextFailedItems = [...priorFailed, ...newFailedEntries].slice(-100);

      // Detect same-item-failed-twice: counts every entry across history.
      // Any item present ≥2 times after this rejection forces a PLANNING flip
      // even if reopenCount hasn't crossed the cap.
      const itemCounts = new Map<string, number>();
      for (const entry of nextFailedItems) {
        itemCounts.set(entry.item, (itemCounts.get(entry.item) ?? 0) + 1);
      }
      const repeatedItem = (params.failedDodItems ?? []).find(
        (item) => (itemCounts.get(item) ?? 0) >= 2
      );
      const triggeredBySameItem = !exceededCap && !!repeatedItem;
      const shouldReplan = exceededCap || triggeredBySameItem;
      const nextStatus = shouldReplan ? 'PLANNING' : 'WORKING';

      const priorMetrics = task.metrics ?? {};
      const nextMetrics = {
        ...priorMetrics,
        rejectCount: (priorMetrics.rejectCount ?? 0) + 1,
        reopenCount: newReopenCount,
      };

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
        metrics: nextMetrics,
      };

      const updated = await state.updateTask(
        params.taskId,
        updatePayload,
        'QA_REJECTED'
      );

      // When the cap was crossed, cross-post to #architects with the full
      // history so the architect can re-plan with context, and surface the
      // event in the activity log.
      if (exceededCap) {
        state.appendActivity('TASK_REOPENED', {
          taskId: updated.id,
          reopenCount: newReopenCount,
          maxReopens,
          rejectionHistory: updatedHistory,
          reason: 'maxReopens exceeded; flipped back to PLANNING',
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
      const replanReason = exceededCap
        ? 'reopen cap hit'
        : triggeredBySameItem
          ? `same DoD item failed twice: "${(repeatedItem ?? '').slice(0, 120)}"`
          : null;
      return {
        success: true,
        taskId: updated.id,
        status: updated.status,
        reopenCount: updated.reopenCount,
        maxReopens,
        exceededReopenCap: exceededCap,
        repeatedFailedDodItem: triggeredBySameItem ? repeatedItem : undefined,
        reason: params.reason,
        rejectionDetails,
        rejectionHistory: updatedHistory,
        failedDodItems: updated.failedDodItems ?? nextFailedItems,
        message: replanReason
          ? `Task ${updated.id} rejected and flipped to PLANNING (${replanReason}). Architect will re-plan.`
          : `Task ${updated.id} rejected and moved to ${destination}. Worker should address: ${params.reason}`,
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
