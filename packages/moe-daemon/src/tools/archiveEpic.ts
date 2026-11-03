import type { ToolDefinition } from './index.js';
import type { StateManager } from '../state/StateManager.js';
import type { Task, TaskStatus } from '../types/schema.js';
import { missingRequired, notFound, notAllowed } from '../util/errors.js';
import { assertNoFinalizingAttempt } from '../state/taskStore.js';
import { archiveUpdates, HOLDER_ONLY_FROM } from './archiveTask.js';

/**
 * In-flight task statuses that block an epic archive — a worker may own them.
 * Everything else (BACKLOG / REVIEW / DONE / already-ARCHIVED) is shelveable.
 */
const IN_FLIGHT: TaskStatus[] = ['PLANNING', 'AWAITING_APPROVAL', 'WORKING'];

/**
 * archive_task's holder-only rule (archiveTask.ts:71-72), applied to every task
 * of the epic before the first write: a BLOCKED row another seat holds (a
 * resource block keeps its seat parked) may only be archived by that holder or
 * by a caller with no workerId (a human). PLANNING never reaches here (IN_FLIGHT).
 */
function assertNoRowHeldByOthers(epicId: string, tasks: Task[], callerId?: string): void {
  const held = tasks.filter((t) => HOLDER_ONLY_FROM.includes(t.status)
    && t.assignedWorkerId && callerId && callerId !== t.assignedWorkerId);
  if (held.length === 0) return;
  throw notAllowed(
    'archive epic',
    `Epic "${epicId}" has ${held.length} BLOCKED task(s) held by another worker (${held
      .map((t) => `${t.id} held by ${t.assignedWorkerId}`)
      .join(', ')}). Only each holder, or a caller with no workerId (a human), may archive them; or move them first via moe.set_task_status.`
  );
}

export function archiveEpicTool(_state: StateManager): ToolDefinition {
  return {
    name: 'moe.archive_epic',
    description:
      'Archive an epic and all its tickets in one shot — every task goes to ARCHIVED and the epic to ARCHIVED, dropping the whole epic out of agent context and the board. Refuses if any task is in-flight (PLANNING/AWAITING_APPROVAL/WORKING) — release or move those first — or, for a caller with a workerId, if a BLOCKED task is held by another worker (archive_task\'s holder-only rule). Idempotent.',
    inputSchema: {
      type: 'object',
      properties: {
        epicId: { type: 'string', description: 'The ID of the epic to archive' },
        workerId: { type: 'string', description: 'Caller worker ID (auto-injected by proxy); recorded as the actor of each TASK_ARCHIVED and of the epic\'s EPIC_UPDATED, and a BLOCKED row held by another worker may only be archived by its holder' }
      },
      required: ['epicId'],
      additionalProperties: false
    },
    handler: async (args, state) => {
      const params = (args || {}) as { epicId?: string; workerId?: string };
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
            .join(', ')}). Move them to BACKLOG first via moe.set_task_status (release_task keeps a WORKING task in the WORKING column, so releasing does not make it archivable).`
        );
      }

      // Same all-or-nothing gate for archive_task's holder-only rule, before the first write.
      assertNoRowHeldByOthers(params.epicId, tasksInEpic, params.workerId);

      // Same all-or-nothing gate for a landing hold: updateTask refuses to shelve
      // a task whose attempt is still finalizing, so check every task before the
      // first write rather than archive the ones ahead of it.
      for (const task of tasksInEpic) {
        if (task.status !== 'ARCHIVED') assertNoFinalizingAttempt(state, task.id);
      }

      // Archive every not-yet-archived task, then the epic. Per-task TASK_ARCHIVED
      // events keep the activity log truthful.
      let archivedTaskCount = 0;
      for (const task of tasksInEpic) {
        if (task.status === 'ARCHIVED') continue;
        // The caller is the event actor (a caller-less call records none), as in archive_task.
        await state.updateTask(task.id, archiveUpdates(task), 'TASK_ARCHIVED', params.workerId);
        archivedTaskCount++;
      }

      const epicWasArchived = epic.status === 'ARCHIVED';
      // The caller is also the actor of the epic's own EPIC_UPDATED; an idempotent re-archive writes nothing.
      const updatedEpic = epicWasArchived ? epic : await state.updateEpic(params.epicId, { status: 'ARCHIVED' }, params.workerId);

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
