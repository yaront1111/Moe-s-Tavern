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

      const updated = await state.updateTask(
        params.taskId,
        { status: 'DONE', reviewCompletedAt: new Date().toISOString() },
        'QA_APPROVED'
      );

      // Post system message to task channel
      try {
        await state.postSystemMessage(params.taskId, 'QA approved — task complete');
      } catch { /* never block tool */ }

      // Auto-extract memory: approvals encode "what worked." Especially valuable
      // when reopenCount > 0 — the approved fix is now proven, so capture it as
      // a pattern for future workers facing similar rejections.
      if (params.workerId) {
        try {
          const mm = state.getMemoryManager();
          const modified = (updated.implementationPlan || [])
            .filter(s => s.status === 'COMPLETED')
            .flatMap(s => s.modifiedFiles || s.affectedFiles || []);
          const reopenTag = updated.reopenCount > 0 ? `fix-verified-reopen-${updated.reopenCount}` : 'approved-first-pass';
          const summary = (params.summary || '').trim().slice(0, 5000);
          const content = updated.reopenCount > 0
            ? `Fix verified by QA after ${updated.reopenCount} reopen(s): "${updated.title}".${summary ? ' ' + summary : ''}`
            : `Task "${updated.title}" approved by QA on first pass.${summary ? ' ' + summary : ''}`;
          await mm.addEntry({
            workerId: params.workerId,
            type: 'pattern',
            content,
            tags: ['qa-approved', reopenTag],
            files: Array.from(new Set(modified)).slice(0, 20),
            taskId: updated.id,
            epicId: updated.epicId,
          });
        } catch (err) {
          console.warn(`[qaApprove] memory auto-extract failed for ${updated.id}:`, err);
        }
      }

      return {
        success: true,
        taskId: updated.id,
        status: updated.status,
        summary: params.summary || 'QA approved',
        message: `Task ${updated.id} approved and moved to DONE`,
        nextAction: {
          tool: 'moe.save_session_summary',
          args: {
            workerId: params.workerId,
            taskId: updated.id,
            summary: params.summary || `Approved task ${updated.id} on first pass.`
          },
          reason: 'Task approved; record QA findings, then wait_for_task for next REVIEW task.'
        }
      };
    }
  };
}
