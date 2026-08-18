import type { ToolDefinition } from './index.js';
import type { StateManager } from '../state/StateManager.js';
import { notFound, missingRequired, invalidInput } from '../util/errors.js';
import { AGENT_CLAIMABLE_STATUSES } from '../util/claimableStatuses.js';
import { recommendSkillFor } from '../util/recommendSkill.js';
import { assertWorkerOwns } from '../util/enforcement.js';
import { findFreshestLiveWorkerByRole } from '../util/workerLiveness.js';
import { RESOURCE_ID_RE } from '../state/resourceStore.js';

const MAX_REASON_LENGTH = 2000;

/** Statuses report_blocked will flip to BLOCKED (the agent-claimable columns). */
const BLOCKABLE_STATUSES = new Set(['PLANNING', 'WORKING', 'REVIEW']);

export function reportBlockedTool(_state: StateManager): ToolDefinition {
  return {
    name: 'moe.report_blocked',
    description: 'Report a task as blocked. Flips the task to BLOCKED (wrapper stops relaunching sessions against the wall) and pages an architect. With resourceId: first tries to acquire the shared resource — if free you get the lease and the task is NOT blocked; if busy the task parks and is auto-unblocked when the lease is granted. A repeat call on an already-BLOCKED task OVERWRITES blockedReason (keeping the original blockedFromStatus/blockedAt) and answers alreadyBlocked:true with reasonUpdated:true; a byte-identical repeat writes nothing, pages nobody, and answers reasonUpdated:false.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string' },
        reason: { type: 'string' },
        needsFrom: { type: 'string' },
        currentStepId: { type: 'string' },
        workerId: { type: 'string' },
        resourceId: { type: 'string', description: 'Shared resource you are waiting on (see moe.acquire_resource). Enables auto-unblock on grant.' }
      },
      required: ['taskId', 'reason'],
      additionalProperties: false
    },
    handler: async (args, state) => {
      const params = (args || {}) as {
        taskId?: string;
        reason?: string;
        needsFrom?: string;
        currentStepId?: string;
        workerId?: string;
        resourceId?: string;
      };

      if (!params.taskId) throw missingRequired('taskId');
      if (!params.reason || params.reason.trim().length === 0) throw missingRequired('reason');
      if (params.reason.length > MAX_REASON_LENGTH) {
        throw invalidInput('reason', `too long (${params.reason.length} chars). Maximum ${MAX_REASON_LENGTH} characters allowed.`);
      }
      if (params.resourceId !== undefined && !RESOURCE_ID_RE.test(params.resourceId)) {
        throw invalidInput('resourceId', 'use 1-64 chars of letters, digits, ".", "_", "-"');
      }

      const task = state.getTask(params.taskId);
      if (!task) throw notFound('Task', params.taskId);

      // Only the assigned worker may report this task as blocked. The "no
      // assigned worker" case is permitted (e.g. plugin/human flow).
      assertWorkerOwns(task, params.workerId, 'moe.report_blocked');

      // Resource path: try the lease FIRST. A free resource means there is no
      // block at all — return the lease and keep working. Runs even for an
      // unassigned task (plugin/human flow): without the queue entry the grant
      // path could never auto-unblock it. The lease is task-keyed; workerId is
      // informational, falling back to 'human' for operator-initiated blocks.
      if (params.resourceId) {
        const acquired = await state.acquireResource({
          resourceId: params.resourceId,
          taskId: task.id,
          workerId: params.workerId || task.assignedWorkerId || 'human',
          note: params.reason,
        });
        if (acquired.granted) {
          return {
            success: true,
            taskId: task.id,
            taskStatus: task.status,
            granted: true,
            lease: acquired.lease,
            message: `Resource ${params.resourceId} was free — lease granted, task NOT blocked. Proceed, then moe.release_resource.`,
          };
        }
      }

      // Flip the task itself to BLOCKED. This is what stops the wrapper churn:
      // claim_next_task keeps answering alreadyAssigned{status:BLOCKED}, which
      // the wrapper reads as "do not relaunch a CLI onto this". Restore target
      // is remembered in blockedFromStatus; the resource grant path (or
      // unblock_worker / set_task_status) flips it back.
      // assignedWorkerId is passed EXPLICITLY: taskStore.updateTask clears the
      // assignment on any status change when the caller omits it, and a BLOCKED
      // task must stay owned — the whole hold/suppression/resume design keys on
      // alreadyAssigned{status:BLOCKED} coming back to the parked worker.
      const flipped = BLOCKABLE_STATUSES.has(task.status);

      // A repeat report on an already-BLOCKED task used to skip every write
      // below while still answering success:true, so a CORRECTION left the
      // stale reason on disk and the next claimer worked from it. Two rules:
      // the correction is durable, and it writes ONLY the reason (plus the
      // resource when one is supplied). Re-running the block update instead
      // would stamp blockedFromStatus:'BLOCKED' -- task.status IS 'BLOCKED' by
      // now -- and unblock_worker would then "restore" the task to BLOCKED
      // forever, trading a stale string for a permanent wedge.
      const alreadyBlocked = task.status === 'BLOCKED';
      const identicalRepeat = alreadyBlocked
        && task.blockedReason === params.reason
        && (params.resourceId === undefined || (task.blockedResourceId ?? null) === params.resourceId);
      const reasonUpdated = flipped || (alreadyBlocked && !identicalRepeat);

      if (flipped) {
        await state.updateTask(task.id, {
          status: 'BLOCKED',
          assignedWorkerId: task.assignedWorkerId,
          blockedReason: params.reason,
          blockedResourceId: params.resourceId ?? null,
          blockedFromStatus: task.status,
          blockedAt: new Date().toISOString(),
        }, 'TASK_BLOCKED');
      } else if (alreadyBlocked && !identicalRepeat) {
        // No status change here, so neither the assignedWorkerId hazard above
        // nor the block bookkeeping applies: this lands a TASK_UPDATED event
        // carrying the corrected reason, which keeps the activity log able to
        // tell a correction apart from the block that opened it.
        await state.updateTask(task.id, {
          blockedReason: params.reason,
          ...(params.resourceId !== undefined ? { blockedResourceId: params.resourceId } : {}),
        });
      }

      // An identical repeat writes nothing anywhere -- no worker churn, no
      // second page. Anything else lets a retrying caller spam #governors.
      if (task.assignedWorkerId && !identicalRepeat) {
        await state.updateWorker(task.assignedWorkerId, { status: 'BLOCKED', lastError: params.reason }, 'WORKER_BLOCKED');
      }

      // Cross-post blocked message to task channel, general, and #governors
      // so the on-call governor's chat_wait wakes on the block event.
      const blockedMsg = alreadyBlocked
        ? `🚧 ${task.assignedWorkerId || 'worker'} UPDATED the block reason on ${task.id}: ${params.reason}`
        : `🚧 ${task.assignedWorkerId || 'worker'} blocked on ${task.id}: ${params.reason}`;

      // Page a real person, not whoever happened to plan the task: the
      // architect with the freshest lastActivityAt inside the liveness window.
      // The blocked worker is excluded because an architect blocked on its own
      // PLANNING task would otherwise page itself and dead-end the escalation —
      // daemon posts use sender 'system', which takes the human routing path
      // and does NOT filter self-mentions the way the agent path does.
      const architect = findFreshestLiveWorkerByRole(
        state.workers.values(),
        state.teams.values(),
        'architect',
        {
          excludeWorkerIds: [task.assignedWorkerId, params.workerId].filter(
            (id): id is string => typeof id === 'string' && id.length > 0
          ),
        }
      );
      // Both forms are routable by MentionRouter: a bare worker id and the
      // `governors` group mention.
      const mentionPrefix = architect ? `@${architect.id} ` : '@governors ';

      // postSystemMessage currently forwards to the general channel, so it stays
      // unprefixed — prefixing both copies would page the same person twice in
      // the same channel. Every post keeps its own try/catch: chat is
      // best-effort and must never fail report_blocked or skip the BLOCKED update.
      if (!identicalRepeat) {
        try { await state.postSystemMessage(task.id, blockedMsg); } catch { /* never block tool */ }
        try { await state.postToGeneral(mentionPrefix + blockedMsg); } catch { /* never block tool */ }
        if (architect) {
          try { await state.postToRoleChannel('architects', mentionPrefix + blockedMsg); } catch { /* never block tool */ }
          // Governors keep full visibility of every block without being paged.
          try { await state.postToRoleChannel('governors', blockedMsg); } catch { /* never block tool */ }
        } else {
          // No live architect: the governors channel is the escalation, so it
          // carries the mention.
          try { await state.postToRoleChannel('governors', mentionPrefix + blockedMsg); } catch { /* never block tool */ }
        }
      }

      // wait_for_task requires both workerId and statuses. Only emit the hint
      // when we can populate them; otherwise omit nextAction to avoid a
      // guaranteed-to-throw suggestion. Same trap on the statuses value:
      // wait_for_task only accepts agent-claimable statuses, so echoing a
      // human-gated one (e.g. AWAITING_APPROVAL while the architect still
      // holds the task) would also be guaranteed to throw — map it to the
      // pool the owner's role actually waits on.
      // On a REPEAT the task's own status is already BLOCKED, which is not
      // agent-claimable, so resolving from it would hint ['WORKING'] even for a
      // task blocked out of REVIEW. The restore target is the honest source.
      const statusForWait = alreadyBlocked ? (task.blockedFromStatus ?? task.status) : task.status;
      const waitStatuses = (AGENT_CLAIMABLE_STATUSES as readonly string[]).includes(statusForWait)
        ? [statusForWait]
        : [statusForWait === 'AWAITING_APPROVAL' ? 'PLANNING' : 'WORKING'];
      // Resource-blocked tasks need no in-session waiting: the wrapper idles
      // (BLOCKED suppresses relaunch) and the grant path auto-unblocks. Ending
      // the session IS the correct next step, so no nextAction is emitted.
      // The guidance must never claim a recording that did not happen -- that
      // is the whole defect this branch exists to close.
      // The wait this hint points at is a wait for YOUR OWN unblock, and
      // nothing else: while you hold a BLOCKED task no other task is claimable
      // by you, so wait_for_task will not offer you one and claim_next_task
      // would refuse it. The old text promised "a different task to pick up",
      // which sent the worker into a wait -> claim -> refuse spin (task-9d5dfec6).
      // Name the same alternative exit the other two tools name.
      const waitHintTail =
        'wait for the unblock of THIS task (resource grant, chat, or moe.unblock_worker) -- ' +
        'wait_for_task will not hand you other work while you hold it. To work something ' +
        'else instead, release this one first with moe.release_task; its blockedReason is preserved.';
      const nextActionReason = identicalRepeat
        ? `Task was already BLOCKED with this exact reason -- NOTHING was recorded. Use moe.add_comment to add detail, then ${waitHintTail}`
        : alreadyBlocked
          ? `Block reason UPDATED on the already-BLOCKED task; ${waitHintTail}`
          : `Block reported; ${waitHintTail}`;
      const nextAction = task.assignedWorkerId && !params.resourceId
        ? {
            tool: 'moe.wait_for_task',
            args: { workerId: task.assignedWorkerId, statuses: waitStatuses },
            reason: nextActionReason,
            recommendedSkill: recommendSkillFor('worker', 'task_blocked')
          }
        : undefined;

      return {
        success: true,
        taskId: task.id,
        taskStatus: flipped ? 'BLOCKED' : task.status,
        // Both flags report what was WRITTEN, never what the status happens to
        // read: taskStatus already printed 'BLOCKED' on the broken no-op path,
        // which is exactly why the silent failure was invisible.
        alreadyBlocked,
        reasonUpdated,
        ...(params.resourceId ? { resourceId: params.resourceId, granted: false } : {}),
        workerStatus: identicalRepeat && task.assignedWorkerId
          ? state.getWorker(task.assignedWorkerId)?.status ?? 'BLOCKED'
          : 'BLOCKED',
        // Who was actually paged — assertable, and readable by a human eyeing
        // the tool output instead of the chat channels.
        notified: identicalRepeat
          ? { target: null, via: 'suppressed-identical-repeat' as const }
          : architect
            ? { target: architect.id, via: 'freshest-live-architect' as const }
            : { target: '@governors', via: 'governors-fallback' as const },
        message: identicalRepeat
          ? 'Task was already BLOCKED with this exact reason -- nothing was written and nobody was re-paged. Use moe.add_comment to add detail.'
          : alreadyBlocked
            ? (architect
                ? `Block reason updated. Pinged ${architect.id} (freshest live architect).`
                : 'Block reason updated. No live architect — escalated to @governors.')
            : architect
              ? `Worker marked as blocked. Pinged ${architect.id} (freshest live architect).`
              : 'Worker marked as blocked. No live architect — escalated to @governors.',
        ...(nextAction ? { nextAction } : {})
      };
    }
  };
}
