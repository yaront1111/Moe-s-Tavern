import type { ToolDefinition } from './index.js';
import type { StateManager } from '../state/StateManager.js';
import type { Task, TaskStatus } from '../types/schema.js';
import { missingRequired, notFound, notAllowed } from '../util/errors.js';

/**
 * Statuses from which a ticket can be shelved. Resting statuses always; the
 * two "nothing left to do" in-flight shapes too: PLANNING (the planner found
 * the DoD already met, measured 2026-09-06 when an architect had to BLOCK such
 * a row and page a governor) and BLOCKED (a dead park nobody will revive).
 * A held PLANNING/BLOCKED row may only be archived by its holder or by a caller
 * with no worker identity (a human). AWAITING_APPROVAL / WORKING stay excluded
 * — a worker may own the task; move it to BACKLOG first (set_task_status —
 * release_task keeps a WORKING task in the WORKING column, so releasing is not
 * enough).
 */
export const ARCHIVABLE_FROM: TaskStatus[] = ['BACKLOG', 'REVIEW', 'DONE', 'PLANNING', 'BLOCKED'];
const HOLDER_ONLY_FROM: TaskStatus[] = ['PLANNING', 'BLOCKED'];

export function archiveTaskTool(_state: StateManager): ToolDefinition {
  return {
    name: 'moe.archive_task',
    description:
      'Archive a ticket so it drops out of agent context — list_tasks/search_tasks hide ARCHIVED by default. Allowed from BACKLOG, REVIEW, DONE, and from PLANNING or BLOCKED when nothing is left to do (a held PLANNING/BLOCKED row only by its holder). Not from AWAITING_APPROVAL/WORKING. Idempotent. Un-archive with set_task_status ARCHIVED→BACKLOG.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'The ID of the task to archive' },
        workerId: { type: 'string', description: 'Caller worker ID (auto-injected by proxy); a held PLANNING/BLOCKED row may only be archived by its holder' }
      },
      required: ['taskId'],
      additionalProperties: false
    },
    handler: async (args, state) => {
      const params = (args || {}) as { taskId?: string; workerId?: string };
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
          `Task is ${task.status} (in-flight). Archive is only allowed from ${ARCHIVABLE_FROM.join(', ')}. Move it to BACKLOG first via moe.set_task_status (release_task keeps a WORKING task in the WORKING column).`
        );
      }
      if (HOLDER_ONLY_FROM.includes(task.status) && task.assignedWorkerId
        && params.workerId && params.workerId !== task.assignedWorkerId) {
        throw notAllowed(
          'archive task',
          `Task is ${task.status} and held by ${task.assignedWorkerId}; only that worker (or a human / governor via set_task_status) may archive it.`
        );
      }

      const updates: Partial<Task> = { status: 'ARCHIVED' };
      if (task.status === 'BLOCKED') {
        // Same clear-on-exit as set_task_status: only the operational block
        // fields can be acted on by a later grant/sweep; the prose is kept.
        if (task.blockedReason) updates.priorBlockedReason = task.blockedReason;
        updates.blockedReason = null;
        updates.blockedResourceId = null;
        updates.blockedOnTaskIds = null;
        updates.blockedFromStatus = null;
        updates.blockedAt = null;
      }
      const updated = await state.updateTask(task.id, updates, 'TASK_ARCHIVED');
      return { success: true, taskId: updated.id, status: updated.status };
    }
  };
}
