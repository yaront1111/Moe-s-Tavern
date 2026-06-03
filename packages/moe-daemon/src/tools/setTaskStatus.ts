import type { ToolDefinition } from './index.js';
import type { StateManager } from '../state/StateManager.js';
import type { ActivityEventType, TaskStatus } from '../types/schema.js';
import { missingRequired, invalidInput, notFound, notAllowed } from '../util/errors.js';
import { buildReopenClearingUpdates } from '../util/reopen.js';

/**
 * Valid task statuses for validation.
 */
const VALID_STATUSES: TaskStatus[] = [
  'BACKLOG',
  'PLANNING',
  'AWAITING_APPROVAL',
  'WORKING',
  'REVIEW',
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
  REVIEW: ['DONE', 'WORKING', 'BACKLOG', 'PLANNING'],
  DONE: ['BACKLOG', 'WORKING', 'ARCHIVED'],
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

      // Guard the human-approval gate: AWAITING_APPROVAL→WORKING is a plan
      // approval, not a free status flip. The board's APPROVE_TASK path goes
      // through state.approveTask (which stamps planApprovedAt + emits
      // PLAN_APPROVED). A /mcp agent self-approving via this tool must NOT
      // bypass CONTROL-mode human approval. In CONTROL we reject; in the
      // relaxed modes (SPEED/TURBO) we allow it but stamp it as a real plan
      // approval below so metrics/activity stay truthful.
      const isPlanApproval = task.status === 'AWAITING_APPROVAL' && newStatus === 'WORKING';
      if (isPlanApproval) {
        const approvalMode = state.project?.settings?.approvalMode ?? 'CONTROL';
        if (approvalMode === 'CONTROL') {
          throw notAllowed(
            'status transition',
            'AWAITING_APPROVAL→WORKING requires human approval in CONTROL mode — approve from the board (APPROVE_TASK)'
          );
        }
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

      // Determine if this is a reopen (transitioning from a terminal-ish column
      // — REVIEW / DONE / ARCHIVED — back to active work).
      const isReopening = (task.status === 'REVIEW' || task.status === 'DONE' || task.status === 'ARCHIVED') &&
        (newStatus === 'WORKING' || newStatus === 'BACKLOG' || newStatus === 'PLANNING');

      if (params.reason) {
        updates.reopenReason = params.reason;
      }

      // Only increment reopen count when actually reopening a completed/reviewed task
      if (isReopening) {
        updates.reopenCount = task.reopenCount + 1;
        // Reopening invalidates the prior completion — scrub the "done" signals
        // and reset the plan steps via the single shared helper so a reopened
        // task carries no stale timestamps/metrics and can't be vacuously
        // re-completed with every step still marked COMPLETED.
        Object.assign(updates, buildReopenClearingUpdates(task));
      }

      // A relaxed-mode plan approval (reached only when not CONTROL above) is a
      // real approval: stamp planApprovedAt so metrics match the board path.
      if (isPlanApproval) {
        updates.planApprovedAt = new Date().toISOString();
      }

      let event: ActivityEventType | undefined;
      if (isReopening) {
        event = 'TASK_REOPENED';
      } else if (isPlanApproval) {
        event = 'PLAN_APPROVED';
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
