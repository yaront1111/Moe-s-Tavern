import type { ToolDefinition } from './index.js';
import type { StateManager } from '../state/StateManager.js';
import type { TaskPriority } from '../types/schema.js';
import { invalidInput, missingRequired, notAllowed, notFound } from '../util/errors.js';
import { workerHasRole } from '../util/workerRole.js';

const PRIORITIES: readonly TaskPriority[] = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];

/**
 * moe.set_task_priority — the governor's lever on claim order. Priority is set
 * at create_task and editable on the board, but no agent tool could change it,
 * so a governor watching the fleet work the wrong rows first could only ask a
 * human. claim_next_task, wait_for_task and resource queues all read priority
 * live, so the new value ranks from the next claim on; it never preempts a
 * task that is already assigned.
 */
export function setTaskPriorityTool(_state: StateManager): ToolDefinition {
  return {
    name: 'moe.set_task_priority',
    description: 'Governor-only: set a task\'s priority (CRITICAL, HIGH, MEDIUM or LOW). claim_next_task and wait_for_task offer higher-priority tasks first, and resource queues grant by priority, so the change applies from the next claim; a task that is already assigned keeps its seat. Setting the current priority again changes nothing.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'The task to re-prioritize' },
        priority: { type: 'string', enum: [...PRIORITIES], description: 'The new priority' },
        workerId: { type: 'string', description: 'Caller worker ID (auto-injected by proxy); must be on a governor team.' }
      },
      required: ['taskId', 'priority'],
      additionalProperties: false
    },
    handler: async (args, state) => {
      const params = (args || {}) as {
        taskId?: string;
        priority?: unknown;
        workerId?: string;
      };
      if (!params.taskId) throw missingRequired('taskId');
      if (params.priority === undefined) throw missingRequired('priority');
      if (!PRIORITIES.includes(params.priority as TaskPriority)) {
        throw invalidInput('priority', `must be one of: ${PRIORITIES.join(', ')}`);
      }
      const priority = params.priority as TaskPriority;

      // Role gate (mirrors submit_plan_critique): priority decides which row
      // the whole fleet claims next. Role = team role, else the `governor-` id
      // prefix (util/workerRole); a missing workerId has neither.
      if (!workerHasRole(state, params.workerId || '', 'governor')) {
        throw notAllowed(
          'set_task_priority',
          `governor role required (worker ${params.workerId || '(none)'} is not on a governor team and its id is not governor-prefixed)`
        );
      }

      const task = state.getTask(params.taskId);
      if (!task) throw notFound('Task', params.taskId);

      const previous = task.priority;
      if (params.workerId) {
        await state.touchWorker(params.workerId);
      }
      if (previous === priority) {
        return {
          success: true,
          taskId: task.id,
          priority,
          previousPriority: previous,
          changed: false,
          message: `${task.id} is already ${priority}; nothing changed.`
        };
      }

      const updated = await state.updateTask(task.id, { priority }, 'TASK_PRIORITY_SET', params.workerId);
      try {
        await state.postSystemMessage(
          task.id,
          `🎯 ${params.workerId} set priority on ${task.id}: ${previous} → ${priority}`
        );
      } catch { /* never block tool */ }

      return {
        success: true,
        taskId: updated.id,
        priority: updated.priority,
        previousPriority: previous,
        changed: true,
        message: `Priority of ${task.id} set to ${priority} (was ${previous}). Claims rank by priority first, so this applies from the next claim; a task that is already assigned keeps its seat.`
      };
    }
  };
}
