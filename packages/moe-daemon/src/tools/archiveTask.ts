import type { ToolDefinition } from './index.js';
import type { StateManager } from '../state/StateManager.js';
import type { TaskStatus } from '../types/schema.js';
import { missingRequired, notFound, notAllowed } from '../util/errors.js';

/**
 * Resting statuses from which a ticket can be shelved. In-flight states
 * (PLANNING / AWAITING_APPROVAL / WORKING) are deliberately excluded — a worker
 * may own the task; move it to BACKLOG or release it first.
 */
export const ARCHIVABLE_FROM: TaskStatus[] = ['BACKLOG', 'REVIEW', 'DONE'];

export function archiveTaskTool(_state: StateManager): ToolDefinition {
  return {
    name: 'moe.archive_task',
    description:
      'Archive a ticket so it drops out of agent context — list_tasks/search_tasks hide ARCHIVED by default. Allowed from BACKLOG, REVIEW, or DONE (not in-flight states). Idempotent. Un-archive with set_task_status ARCHIVED→BACKLOG.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'The ID of the task to archive' }
      },
      required: ['taskId'],
      additionalProperties: false
    },
    handler: async (args, state) => {
      const params = (args || {}) as { taskId?: string };
      if (!params.taskId) {
        throw missingRequired('taskId');
      }

      const task = state.getTask(params.taskId);
      if (!task) {
        throw notFound('Task', params.taskId);
      }

      // Idempotent: archiving an already-archived task is a no-op success.
      if (task.status === 'ARCHIVED') {
        return { success: true, taskId: task.id, status: 'ARCHIVED', alreadyArchived: true };
      }

      if (!ARCHIVABLE_FROM.includes(task.status)) {
        throw notAllowed(
          'archive task',
          `Task is ${task.status} (in-flight). Archive is only allowed from ${ARCHIVABLE_FROM.join(', ')}. Move it to BACKLOG or release it first.`
        );
      }

      const updated = await state.updateTask(task.id, { status: 'ARCHIVED' }, 'TASK_ARCHIVED');
      return { success: true, taskId: updated.id, status: updated.status };
    }
  };
}
