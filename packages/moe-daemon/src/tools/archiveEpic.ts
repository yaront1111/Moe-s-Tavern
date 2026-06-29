import type { ToolDefinition } from './index.js';
import type { StateManager } from '../state/StateManager.js';
import type { TaskStatus } from '../types/schema.js';
import { missingRequired, notFound, notAllowed } from '../util/errors.js';

/**
 * In-flight task statuses that block an epic archive — a worker may own them.
 * Everything else (BACKLOG / REVIEW / DONE / already-ARCHIVED) is shelveable.
 */
const IN_FLIGHT: TaskStatus[] = ['PLANNING', 'AWAITING_APPROVAL', 'WORKING'];

export function archiveEpicTool(_state: StateManager): ToolDefinition {
  return {
    name: 'moe.archive_epic',
    description:
      'Archive an epic and all its tickets in one shot — every task goes to ARCHIVED and the epic to ARCHIVED, dropping the whole epic out of agent context and the board. Refuses if any task is in-flight (PLANNING/AWAITING_APPROVAL/WORKING) — release or move those first. Idempotent.',
    inputSchema: {
      type: 'object',
      properties: {
        epicId: { type: 'string', description: 'The ID of the epic to archive' }
      },
      required: ['epicId'],
      additionalProperties: false
    },
    handler: async (args, state) => {
      const params = (args || {}) as { epicId?: string };
      if (!params.epicId) {
        throw missingRequired('epicId');
      }

      const epic = state.getEpic(params.epicId);
      if (!epic) {
        throw notFound('Epic', params.epicId);
      }

      const tasksInEpic = Array.from(state.tasks.values()).filter((t) => t.epicId === params.epicId);

      // Atomic safety gate: refuse the whole operation if any ticket is in-flight,
      // rather than half-archiving and stranding owned work in an archived epic.
      const blocking = tasksInEpic.filter((t) => IN_FLIGHT.includes(t.status));
      if (blocking.length > 0) {
        throw notAllowed(
          'archive epic',
          `Epic "${params.epicId}" has ${blocking.length} in-flight task(s) (${blocking
            .map((t) => `${t.id}:${t.status}`)
            .join(', ')}). Release or move them to BACKLOG first.`
        );
      }

      // Archive every not-yet-archived task, then the epic. Per-task TASK_ARCHIVED
      // events keep the activity log truthful.
      let archivedTaskCount = 0;
      for (const task of tasksInEpic) {
        if (task.status === 'ARCHIVED') continue;
        await state.updateTask(task.id, { status: 'ARCHIVED' }, 'TASK_ARCHIVED');
        archivedTaskCount++;
      }

      const epicWasArchived = epic.status === 'ARCHIVED';
      const updatedEpic = epicWasArchived ? epic : await state.updateEpic(params.epicId, { status: 'ARCHIVED' });

      return {
        success: true,
        epicId: updatedEpic.id,
        epicStatus: updatedEpic.status,
        archivedTaskCount,
        totalTasks: tasksInEpic.length
      };
    }
  };
}
