import type { ToolDefinition } from './index.js';
import type { StateManager } from '../state/StateManager.js';
import type { ActivityEventType, TaskStatus } from '../types/schema.js';
import { missingRequired, invalidInput, notFound, notAllowed } from '../util/errors.js';
import { buildReopenClearingUpdates } from '../util/reopen.js';
import { recommendSkillFor } from '../util/recommendSkill.js';

/**
 * Valid task statuses for validation.
 */
const VALID_STATUSES: TaskStatus[] = [
  'BACKLOG',
  'PLANNING',
  'AWAITING_APPROVAL',
  'WORKING',
  'REVIEW',
  'BLOCKED',
  'DONE',
  'ARCHIVED'
];

/**
 * Defines valid state transitions for tasks.
 * Key is current status, value is array of valid target statuses.
 */
const VALID_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  // ARCHIVED is reachable from any *resting* status (BACKLOG / REVIEW / DONE) so
  // stale tickets can be shelved out of context — not from in-flight states
  // (PLANNING / AWAITING_APPROVAL / WORKING) where a worker may own the task;
  // move those to BACKLOG first. ARCHIVED → BACKLOG/WORKING un-archives.
  // BACKLOG → REVIEW is the un-park path: the blocked-timeout sweep parks
  // in-flight tasks (including REVIEW) in BACKLOG, and a human restoring a
  // parked review must be able to send it straight back to the QA queue.
  // BLOCKED ↔ the agent-claimable columns: report_blocked (or a human) parks
  // an in-flight task on an external blocker; the resource grant path,
  // unblock_worker { resolveBlocks: true }, or a human (this tool) flips it
  // back — a plain unblock_worker frees only the seat. BLOCKED → BACKLOG is the manual
  // park; BLOCKED is deliberately NOT reachable from human-gated columns
  // (BACKLOG/AWAITING_APPROVAL) — nothing is running there to block.
  BACKLOG: ['PLANNING', 'WORKING', 'REVIEW', 'ARCHIVED'],
  PLANNING: ['AWAITING_APPROVAL', 'BACKLOG', 'BLOCKED'],
  AWAITING_APPROVAL: ['WORKING', 'PLANNING'],
  WORKING: ['REVIEW', 'PLANNING', 'BACKLOG', 'BLOCKED'],
  REVIEW: ['DONE', 'WORKING', 'BACKLOG', 'PLANNING', 'ARCHIVED', 'BLOCKED'],
  BLOCKED: ['WORKING', 'PLANNING', 'REVIEW', 'BACKLOG'],
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

      // BLOCKED is a parking state, not a lifecycle column: exits are judged
      // against the status the task was blocked FROM, or a two-hop
      // PLANNING → BLOCKED → WORKING would launder past gates the direct
      // transition enforces (plan approval, reopen accounting). Returning to
      // blockedFromStatus itself is always fine.
      const effectiveFrom: TaskStatus = task.status === 'BLOCKED'
        ? (task.blockedFromStatus ?? 'WORKING')
        : task.status;
      if (task.status === 'BLOCKED' && newStatus !== 'BLOCKED'
        && newStatus !== effectiveFrom && !isValidTransition(effectiveFrom, newStatus)) {
        throw notAllowed(
          'status transition',
          `BLOCKED -> ${newStatus} would bypass the ${effectiveFrom} gates (task was blocked from ${effectiveFrom}; ${effectiveFrom} -> ${newStatus} is not a legal transition). Un-block to ${effectiveFrom} first.`
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
          // Exclude ARCHIVED tasks from WIP counts — they're not in flight
          // (mirrors the WS APPROVE/move path in WebSocketServer).
          const currentCount = Array.from(state.tasks.values()).filter(t => t.status === newStatus && t.status !== 'ARCHIVED').length;
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

      // Block bookkeeping. Entering BLOCKED via this tool (human/board path —
      // agents use report_blocked) records where to restore to; leaving BLOCKED
      // by any route clears every blocked field so a later grant/sweep cannot
      // act on stale block state. Assignment is preserved EXPLICITLY on both
      // edges (updateTask clears it on any status change when omitted): a
      // parked worker keeps its task through block-and-unblock — except the
      // BLOCKED → BACKLOG park, which keeps the normal clear-on-move semantics.
      if (newStatus === 'BLOCKED' && task.status !== 'BLOCKED') {
        updates.blockedFromStatus = task.status;
        updates.blockedAt = new Date().toISOString();
        updates.assignedWorkerId = task.assignedWorkerId;
        if (params.reason) updates.blockedReason = params.reason;
      } else if (task.status === 'BLOCKED' && newStatus !== 'BLOCKED') {
        updates.blockedReason = null;
        updates.blockedResourceId = null;
        updates.blockedFromStatus = null;
        updates.blockedAt = null;
        // Preserve the parked worker only when the task RETURNS to where it was
        // blocked from; any other exit (park to BACKLOG, reopen to WORKING from
        // a blocked REVIEW) keeps the normal clear-on-move semantics so the
        // right role re-claims it.
        if (newStatus === effectiveFrom) {
          updates.assignedWorkerId = task.assignedWorkerId;
        }
      }

      // Determine if this is a reopen (transitioning from a terminal-ish column
      // — REVIEW / DONE / ARCHIVED — back to active work). Judged against
      // effectiveFrom so a REVIEW task parked in BLOCKED and then sent to
      // WORKING still gets its reopen accounting + completion-signal scrub.
      const isReopening = (effectiveFrom === 'REVIEW' || effectiveFrom === 'DONE' || effectiveFrom === 'ARCHIVED') &&
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
      } else if (newStatus === 'BLOCKED' && task.status !== 'BLOCKED') {
        event = 'TASK_BLOCKED';
      } else if (task.status === 'BLOCKED' && newStatus !== 'BLOCKED') {
        event = 'TASK_UNBLOCKED';
      } else if (newStatus === 'WORKING' && task.status !== 'WORKING') {
        event = 'TASK_STARTED';
      } else if (newStatus === 'DONE') {
        event = 'TASK_COMPLETED';
      }

      const updated = await state.updateTask(params.taskId, updates, event);

      // Hand the acting agent a next step. The reopen path (governor REVIEW→
      // PLANNING flip, human un-park) is the one most likely to strand a task
      // with no guidance: it lands in an actionable column with a cleared
      // context stamp, so the next claimer MUST re-fetch context. Point there
      // and surface the destination-appropriate skill so the workflow resumes.
      let nextAction: Record<string, unknown> | undefined;
      if (isReopening) {
        const reopenSkill = updated.status === 'PLANNING'
          ? recommendSkillFor('architect', 'planning_entry')
          : updated.status === 'WORKING'
            ? recommendSkillFor('worker', 'reopened')
            : undefined;
        nextAction = {
          tool: 'moe.get_context',
          args: { taskId: updated.id },
          reason: `Task reopened (reopen #${updated.reopenCount}). Re-read reopenReason + rejectionDetails via get_context before acting — do not resume the prior attempt blind.`,
          ...(reopenSkill ? { recommendedSkill: reopenSkill } : {}),
        };
      } else if (updated.status === 'PLANNING' || updated.status === 'WORKING' || updated.status === 'REVIEW') {
        nextAction = {
          tool: 'moe.get_context',
          args: { taskId: updated.id },
          reason: `Task moved to ${updated.status}. Fetch full context before acting.`,
        };
      }

      return {
        success: true,
        taskId: updated.id,
        status: updated.status,
        ...(nextAction ? { nextAction } : {}),
      };
    }
  };
}
