import type { ToolDefinition } from './index.js';
import type { StateManager } from '../state/StateManager.js';
import type { QAIssue, QAIssueType, RejectionDetails } from '../types/schema.js';
import { missingRequired, invalidInput, notFound, invalidState } from '../util/errors.js';
import { assertWorkerOwns } from '../util/enforcement.js';
import { resolveMemorySettings } from '../util/memorySettings.js';
import { logger } from '../util/logger.js';

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

      const updatePayload: Record<string, unknown> = {
        status: 'WORKING',
        reopenCount: task.reopenCount + 1,
        reopenReason: params.reason,
        reviewCompletedAt: new Date().toISOString(),
        rejectionDetails,
      };

      const updated = await state.updateTask(
        params.taskId,
        updatePayload,
        'QA_REJECTED'
      );

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

      // Auto-extract memory for QA rejections by default: they encode concrete,
      // reusable failure patterns. Projects can disable this in settings.memory
      // if the signal/noise ratio is poor.
      const memorySettings = resolveMemorySettings(state.project?.settings);
      if (params.workerId && memorySettings.autoSave.qaRejection) {
        try {
          const mm = state.getMemoryManager();
          const reasonCapped = params.reason.slice(0, 2000);
          const issueSummary = (params.issues || [])
            .slice(0, 10)
            .map((i) => `[${i.type}] ${i.description.slice(0, 500)}${i.file ? ` (${i.file}${i.line ? ':' + i.line : ''})` : ''}`)
            .join('\n');
          const failedDod = (params.failedDodItems || []).slice(0, 10).join('\n').slice(0, 2000);
          const bodyParts = [
            `Task "${updated.title}" was rejected by QA (reopen #${updated.reopenCount}).`,
            `Reason: ${reasonCapped}`,
            failedDod ? `Failed DoD items:\n${failedDod}` : '',
            issueSummary ? `Issues:\n${issueSummary}` : '',
          ].filter(Boolean);
          await mm.addEntry({
            workerId: params.workerId,
            type: 'gotcha',
            content: bodyParts.join('\n\n').slice(0, 5000),
            // epicId stays out of tags — dedicated field handles epic filtering.
            tags: ['qa-rejection'],
            files: Array.from(new Set((params.issues || []).map(i => i.file).filter((f): f is string => !!f))).slice(0, 20),
            taskId: updated.id,
            epicId: updated.epicId,
          });
        } catch (err) {
          logger.warn({
            taskId: updated.id,
            error: err instanceof Error ? err.message : String(err),
          }, 'qaReject memory auto-extract failed');
        }
      }

      return {
        success: true,
        taskId: updated.id,
        status: updated.status,
        reopenCount: updated.reopenCount,
        reason: params.reason,
        rejectionDetails,
        message: `Task ${updated.id} rejected and moved to WORKING. Worker should address: ${params.reason}`,
        nextAction: {
          tool: 'moe.save_session_summary',
          args: {
            workerId: params.workerId,
            taskId: updated.id,
            summary: `Rejected task ${updated.id}: ${params.reason}`
          },
          reason: 'Record your review findings; next QA rotation will benefit.'
        }
      };
    }
  };
}
