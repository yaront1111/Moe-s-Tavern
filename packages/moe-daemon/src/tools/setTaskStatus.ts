import type { ToolDefinition } from './index.js';
import type { StateManager } from '../state/StateManager.js';
import type { ActivityEventType, TaskStatus } from '../types/schema.js';
import { missingRequired, invalidInput, notFound, notAllowed } from '../util/errors.js';

/**
 * Valid task statuses for validation.
 */
const VALID_STATUSES: TaskStatus[] = [
  'BACKLOG',
  'PLANNING',
  'AWAITING_APPROVAL',
  'WORKING',
  'REVIEW',
  'DEPLOYING',
  'DONE',
  'ARCHIVED'
];

/**
 * Defines valid state transitions for tasks.
 * Key is current status, value is array of valid target statuses.
 */
const VALID_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  BACKLOG: ['PLANNING', 'WORKING'],
  PLANNING: ['AWAITING_APPROVAL', 'BACKLOG'],
  AWAITING_APPROVAL: ['WORKING', 'PLANNING'],
  WORKING: ['REVIEW', 'PLANNING', 'BACKLOG'],
  REVIEW: ['DONE', 'DEPLOYING', 'WORKING', 'BACKLOG'],
  DEPLOYING: ['DONE', 'WORKING', 'BACKLOG'],
  DONE: ['BACKLOG', 'WORKING', 'DEPLOYING', 'ARCHIVED'],
  ARCHIVED: ['BACKLOG', 'WORKING']
};

/**
 * Validates if a status transition is allowed.
 */
function isValidTransition(from: TaskStatus, to: TaskStatus): boolean {
  if (from === to) return true; // No-op is always valid
  const allowed = VALID_TRANSITIONS[from];
  return allowed?.includes(to) ?? false;
}

export function setTaskStatusTool(_state: StateManager): ToolDefinition {
  return {
    name: 'moe.set_task_status',
    description: 'Set task status (optionally with a reopen reason)',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string' },
        status: { type: 'string', enum: VALID_STATUSES },
        reason: { type: 'string' }
      },
      required: ['taskId', 'status'],
      additionalProperties: false
    },
    handler: async (args, state) => {
      const params = (args || {}) as { taskId?: string; status?: string; reason?: string };
      if (!params.taskId) {
        throw missingRequired('taskId');
      }
      if (!params.status) {
        throw missingRequired('status');
      }

      // Validate status is a known value
      if (!VALID_STATUSES.includes(params.status as TaskStatus)) {
        throw invalidInput('status', `${params.status} is not valid. Valid statuses are: ${VALID_STATUSES.join(', ')}`);
      }

      const task = state.getTask(params.taskId);
      if (!task) {
        throw notFound('Task', params.taskId);
      }

      // Validate status transition
      const newStatus = params.status as TaskStatus;
      if (!isValidTransition(task.status, newStatus)) {
        throw notAllowed(
          'status transition',
          `${task.status} -> ${newStatus}. Allowed transitions from ${task.status}: ${VALID_TRANSITIONS[task.status].join(', ')}`
        );
      }

      // Enforce WIP column limits
      if (newStatus !== task.status) {
        const columnLimits = state.project?.settings?.columnLimits;
        if (columnLimits && typeof columnLimits[newStatus] === 'number') {
          const limit = columnLimits[newStatus];
          const currentCount = Array.from(state.tasks.values()).filter(t => t.status === newStatus).length;
          if (currentCount >= limit) {
            throw notAllowed(
              'status transition',
              `Column ${newStatus} is at its WIP limit of ${limit}`
            );
          }
        }
      }

      const updates: Partial<typeof task> = {
        status: newStatus
      };

      // Determine if this is a reopen (transitioning from REVIEW, DEPLOYING, or DONE back to work)
      const isReopening = (task.status === 'REVIEW' || task.status === 'DEPLOYING' || task.status === 'DONE') &&
        (newStatus === 'WORKING' || newStatus === 'BACKLOG' || newStatus === 'PLANNING');

      if (params.reason) {
        updates.reopenReason = params.reason;
      }

      // Only increment reopen count when actually reopening a completed/reviewed task
      if (isReopening) {
        updates.reopenCount = task.reopenCount + 1;
      }

      let event: ActivityEventType | undefined;
      if (isReopening) {
        event = 'TASK_REOPENED';
      } else if (newStatus === 'WORKING' && task.status !== 'WORKING') {
        event = 'TASK_STARTED';
      } else if (newStatus === 'DONE') {
        event = 'TASK_COMPLETED';
      }

      const updated = await state.updateTask(params.taskId, updates, event);
      return { success: true, taskId: updated.id, status: updated.status };
    }
  };
}
