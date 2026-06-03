import type { ToolDefinition } from './index.js';
import type { StateManager } from '../state/StateManager.js';
import { missingRequired, notFound, invalidState } from '../util/errors.js';
import { assertWorkerOwns } from '../util/enforcement.js';

export function qaApproveTool(_state: StateManager): ToolDefinition {
  return {
    name: 'moe.qa_approve',
    description: 'QA approves a task in REVIEW status, moving it to DONE',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'The task ID to approve' },
        summary: { type: 'string', description: 'Summary of QA review (what was verified)' },
        workerId: { type: 'string', description: 'Caller worker ID (auto-injected by proxy)' }
      },
      required: ['taskId'],
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
        // moment for review-timing/metrics).
        { status: 'DONE', completedAt: nowIso, reviewCompletedAt: nowIso, metrics: nextMetrics },
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
        summary: params.summary || 'QA approved',
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
