import type { ToolDefinition } from './index.js';
import type { StateManager } from '../state/StateManager.js';
import { missingRequired, notFound, invalidState, invalidInput } from '../util/errors.js';
import { assertWorkerOwns, assertContextFetched } from '../util/enforcement.js';

/** Upper bound on the approval summary — mirrors qa_reject's reason cap. */
const MAX_SUMMARY_CHARS = 2000;

export function qaApproveTool(_state: StateManager): ToolDefinition {
  return {
    name: 'moe.qa_approve',
    description: 'QA approves a task in REVIEW status, moving it to DONE. Requires a summary of what was verified.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'The task ID to approve' },
        summary: { type: 'string', description: 'What was verified: commands re-run, DoD items checked, diff size. Required — an approval without evidence is a rubber stamp.' },
        workerId: { type: 'string', description: 'Caller worker ID (auto-injected by proxy)' }
      },
      required: ['taskId', 'summary'],
      additionalProperties: false
    },
    handler: async (args, state) => {
      const params = (args || {}) as { taskId?: string; summary?: string; workerId?: string };

      if (!params.taskId) {
        throw missingRequired('taskId');
      }

      const task = state.getTask(params.taskId);
      if (!task) {
        throw notFound('Task', params.taskId);
      }

      if (task.status !== 'REVIEW') {
        throw invalidState('Task', task.status, 'REVIEW');
      }

      assertWorkerOwns(task, params.workerId);
      // QA must read the task (DoD + rails + diff) before signing off. This is
      // the last gate — approving blind is the highest-impact way to skip the
      // review workflow. No-ops on the human path (assignedWorkerId null).
      assertContextFetched(task, params.workerId, 'qa_approve');
      // Symmetric with qa_reject's required `reason`: an approval must say what
      // was actually verified (commands re-run, DoD items checked) so DONE
      // tasks carry an audit trail instead of a rubber stamp. Checked after the
      // ownership/context guards so those errors keep precedence.
      if (typeof params.summary !== 'string' || params.summary.trim().length === 0) {
        throw missingRequired('summary');
      }
      if (params.summary.length > MAX_SUMMARY_CHARS) {
        throw invalidInput('summary', `too long (max ${MAX_SUMMARY_CHARS} chars)`);
      }
      const reviewSummary = params.summary.trim();
      const handoffWorkerId = task.assignedWorkerId || params.workerId;

      // Capture metrics: doneAt + wallClockMs (first claim → DONE). If no
      // firstClaimAt was recorded (legacy task), wallClockMs stays undefined.
      const nowIso = new Date().toISOString();
      const priorMetrics = task.metrics ?? {};
      const nextMetrics: typeof priorMetrics = { ...priorMetrics, doneAt: nowIso };
      if (priorMetrics.firstClaimAt) {
        const start = Date.parse(priorMetrics.firstClaimAt);
        const end = Date.parse(nowIso);
        if (Number.isFinite(start) && Number.isFinite(end) && end >= start) {
          nextMetrics.wallClockMs = end - start;
        }
      }

      const updated = await state.updateTask(
        params.taskId,
        // completedAt now means "task finished" — stamped here at DONE, the only
        // true completion point (reviewCompletedAt/metrics.doneAt mark the same
        // moment for review-timing/metrics). Clear the escalation latches so a
        // future reopen of this task starts from a clean budget.
        {
          status: 'DONE',
          completedAt: nowIso,
          reviewCompletedAt: nowIso,
          reviewSummary,
          metrics: nextMetrics,
          needsHumanReview: undefined,
          critiqueBlockCount: undefined,
        },
        'QA_APPROVED'
      );

      // Use the captured assignee because updateTask clears assignedWorkerId on
      // REVIEW -> DONE handoff. touchWorker skips missing worker records.
      await state.touchWorker(handoffWorkerId, { status: 'IDLE', currentTaskId: null });

      // Post system message to task channel
      try {
        await state.postSystemMessage(params.taskId, 'QA approved — task complete');
      } catch { /* never block tool */ }

      return {
        success: true,
        taskId: updated.id,
        status: updated.status,
        summary: reviewSummary,
        message: `Task ${updated.id} approved and moved to DONE`,
        nextAction: {
          tool: 'moe.wait_for_task',
          args: {
            statuses: ['REVIEW'],
            workerId: params.workerId,
          },
          reason: 'Task approved. If the review surfaced a reusable pattern, record it with Serena write_memory (pattern-<area>), then block until the next REVIEW task arrives.'
        }
      };
    }
  };
}
