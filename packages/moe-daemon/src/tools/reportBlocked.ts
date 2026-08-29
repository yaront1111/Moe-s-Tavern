import type { ToolDefinition } from './index.js';
import type { StateManager } from '../state/StateManager.js';
import { notFound, missingRequired, invalidInput } from '../util/errors.js';
import { AGENT_CLAIMABLE_STATUSES } from '../util/claimableStatuses.js';
import { recommendSkillFor } from '../util/recommendSkill.js';
import { assertWorkerOwns } from '../util/enforcement.js';
import { findFreshestLiveWorkerByRole } from '../util/workerLiveness.js';
import { RESOURCE_ID_RE } from '../state/resourceStore.js';
import { MAX_TASK_DEPENDENCY_IDS } from '../state/taskStore.js';
import { findDependencyPath, formatDependencyCycle } from '../state/dependencyUnblock.js';

const MAX_REASON_LENGTH = 2000;

/**
 * Task ids embedded in free-text reasons ("BUILD-ORDER BLOCK on task-3f71ba30")
 * are auto-parsed and unioned into blockedOnTaskIds, so legacy-style blocks
 * become structured (and auto-unblockable) with zero agent effort. Only ids
 * that exist on the board are kept. Both edges are anchored: without the
 * lookbehind, "subtask-abcdef" would parse as task-abcdef and record a FALSE
 * dependency whenever that id exists — falsely auto-unblocking a still-walled
 * row when the unrelated task lands, or silently exempting the row from the
 * stale-block alert while it "waits" on a task it never depended on.
 */
const TASK_ID_IN_REASON_RE = /(?<![a-z0-9_-])task-[0-9a-f]{6,}\b/gi;

/** Statuses report_blocked will flip to BLOCKED (the agent-claimable columns). */
const BLOCKABLE_STATUSES = new Set(['PLANNING', 'WORKING', 'REVIEW']);

export function reportBlockedTool(_state: StateManager): ToolDefinition {
  return {
    name: 'moe.report_blocked',
    description: 'Report a task as blocked. Flips the task to BLOCKED (wrapper stops relaunching sessions against the wall) and pages an architect. Non-resource blocks reported by the ASSIGNEE (or on an unassigned task) FREE YOUR SEAT: the task parks unassigned, you go IDLE and claim other work (a third-party/workerId-less block on an assigned task keeps the hold). Declare the tasks you wait on via blockedOnTaskIds (ids in the reason text are auto-parsed too) — the daemon auto-unblocks the task when they are all DONE/ARCHIVED. If EVERY task you name is already DONE/ARCHIVED the task is NOT blocked (dependenciesSatisfied:true — there is nothing to wait on; continue); an id that would close a dependency cycle is dropped with a warning. With resourceId: first tries to acquire the shared resource — if free you get the lease and the task is NOT blocked; if busy the task parks (seat KEPT — the grant returns it to you) and is auto-unblocked when the lease is granted. A repeat call on an already-BLOCKED task OVERWRITES blockedReason and unions new blockedOnTaskIds (keeping the original blockedFromStatus/blockedAt) and answers alreadyBlocked:true with reasonUpdated:true; a byte-identical repeat writes nothing, pages nobody, and answers reasonUpdated:false.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string' },
        reason: { type: 'string' },
        needsFrom: { type: 'string' },
        currentStepId: { type: 'string' },
        workerId: { type: 'string' },
        resourceId: { type: 'string', description: 'Shared resource you are waiting on (see moe.acquire_resource). Enables auto-unblock on grant.' },
        blockedOnTaskIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Task ids this block waits on. The task auto-unblocks when they are all DONE/ARCHIVED. Unknown ids are ignored (reported back); unioned with ids parsed from reason, deduped, capped at 20.'
        }
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
        blockedOnTaskIds?: unknown;
      };

      if (!params.taskId) throw missingRequired('taskId');
      if (!params.reason || params.reason.trim().length === 0) throw missingRequired('reason');
      if (params.reason.length > MAX_REASON_LENGTH) {
        throw invalidInput('reason', `too long (${params.reason.length} chars). Maximum ${MAX_REASON_LENGTH} characters allowed.`);
      }
      if (params.resourceId !== undefined && !RESOURCE_ID_RE.test(params.resourceId)) {
        throw invalidInput('resourceId', 'use 1-64 chars of letters, digits, ".", "_", "-"');
      }
      let suppliedBlockedOnIds: string[] = [];
      if (params.blockedOnTaskIds !== undefined) {
        if (!Array.isArray(params.blockedOnTaskIds)) {
          throw invalidInput('blockedOnTaskIds', 'must be an array of task ids');
        }
        for (const id of params.blockedOnTaskIds) {
          if (typeof id !== 'string') throw invalidInput('blockedOnTaskIds', 'each entry must be a string');
        }
        suppliedBlockedOnIds = (params.blockedOnTaskIds as string[]).map((id) => id.trim()).filter((id) => id.length > 0);
      }

      let task = state.getTask(params.taskId);
      if (!task) throw notFound('Task', params.taskId);

      // Only the assigned worker may report this task as blocked. The "no
      // assigned worker" case is permitted (e.g. plugin/human flow).
      assertWorkerOwns(task, params.workerId, 'moe.report_blocked');

      // Resource path: try the lease FIRST. On a task that is NOT yet blocked a
      // free resource means there is no block at all — return the lease and keep
      // working. Runs even for an unassigned task (plugin/human flow): without
      // the queue entry the grant path could never auto-unblock it. The lease is
      // task-keyed; workerId is informational, falling back to 'human' for
      // operator-initiated blocks.
      if (params.resourceId) {
        const acquired = await state.acquireResource({
          resourceId: params.resourceId,
          taskId: task.id,
          workerId: params.workerId || task.assignedWorkerId || 'human',
          note: params.reason,
        });
        if (acquired.granted) {
          // A grant does NOT unblock an already-BLOCKED task (only the queued
          // grantNextLeases path restores a status), so this return used to drop
          // a correction arriving with a FREE resourceId and then claim "task
          // NOT blocked" about a task the store reads BLOCKED. Re-read rather
          // than reuse the pre-await snapshot: a concurrent unblock would
          // otherwise get a dead blockedReason stamped back onto a running task.
          const current = state.getTask(task.id) ?? task;
          const heldWhileBlocked = current.status === 'BLOCKED';
          // REASON ONLY, never blockedResourceId: that field means "parked in
          // this resource's QUEUE, auto-unblocks on grant", and sweeps.ts (:238)
          // skips the blocked-timeout sweep for any task carrying it. A task
          // HOLDING the lease is in no queue, so no grant is ever coming.
          const grantCorrects = heldWhileBlocked && current.blockedReason !== params.reason;
          if (grantCorrects) await state.updateTask(task.id, { blockedReason: params.reason });
          return {
            success: true,
            taskId: task.id,
            taskStatus: current.status,
            granted: true,
            alreadyBlocked: heldWhileBlocked,
            reasonUpdated: grantCorrects,
            lease: acquired.lease,
            message: heldWhileBlocked
              ? `Resource ${params.resourceId} was free — lease granted, but ${task.id} remains BLOCKED; the lease does not unblock it. ${grantCorrects ? 'Block reason UPDATED.' : 'Same reason as the stored one — nothing written.'}`
              : `Resource ${params.resourceId} was free — lease granted, task NOT blocked. Proceed, then moe.release_resource.`,
          };
        }
        // A queued acquisition crosses an await too; derive results from current task truth.
        task = state.getTask(task.id) ?? task;
      }

      // Structured dependency ids: stored ∪ supplied ∪ auto-parsed-from-reason.
      // Only ids that EXIST on the board are kept (a missing id counts as
      // satisfied anyway, so storing it would be dead weight); the task's own
      // id is never a dependency of itself; capped at MAX_TASK_DEPENDENCY_IDS.
      // Union — a correction must never lose earlier ids. A candidate from
      // which THIS task is already reachable over dependsOn ∪ blockedOnTaskIds
      // is dropped, warned about, and alerted to #governors: recording it
      // would close a dependency cycle nothing could ever auto-unblock (the
      // members never all reach DONE), and the knot would starve silently.
      const flipped = BLOCKABLE_STATUSES.has(task.status);
      const storedBlockedOnIds = Array.isArray(task.blockedOnTaskIds) ? task.blockedOnTaskIds : [];
      const parsedFromReason = (params.reason.match(TASK_ID_IN_REASON_RE) ?? []).map((id) => id.toLowerCase());
      const suppliedSet = new Set(suppliedBlockedOnIds);
      const ignoredBlockedOnIds: string[] = [];
      const droppedCycleBlockedOnIds: string[] = [];
      const warnings: string[] = [];
      const mergedBlockedOnIds: string[] = [...storedBlockedOnIds];
      const seenIds = new Set(storedBlockedOnIds);
      for (const id of [...suppliedBlockedOnIds, ...parsedFromReason]) {
        if (!id || id === task.id || seenIds.has(id)) continue;
        seenIds.add(id);
        if (!state.getTask(id)) {
          // Explicitly supplied unknown ids are reported back; parsed strays
          // (version numbers, deleted rows) are silently skipped.
          if (suppliedSet.has(id)) ignoredBlockedOnIds.push(id);
          continue;
        }
        const cycle = findDependencyPath(state, id, task.id);
        if (cycle) {
          droppedCycleBlockedOnIds.push(id);
          warnings.push(
            `DEPENDENCY_CYCLE: ${id} was NOT recorded — it would close a dependency cycle (${formatDependencyCycle(task.id, cycle)}) that nothing could ever auto-unblock. One side of the loop must be re-planned; page an architect/governor.`
          );
          continue;
        }
        if (mergedBlockedOnIds.length >= MAX_TASK_DEPENDENCY_IDS) break;
        mergedBlockedOnIds.push(id);
      }
      const blockedOnIdsChanged = mergedBlockedOnIds.length !== storedBlockedOnIds.length;

      // A cycle attempt is a fleet-level signal (two rows about to wedge each
      // other) — alert #governors even when nothing else is written below.
      // Best-effort: chat must never fail report_blocked.
      if (droppedCycleBlockedOnIds.length > 0) {
        try {
          await state.postToRoleChannel(
            'governors',
            `⚠️ ${params.workerId || task.assignedWorkerId || 'someone'} tried to block ${task.id} on ${droppedCycleBlockedOnIds.join(', ')}, ` +
            `which already wait(s) on ${task.id} (dependency cycle). The id(s) were dropped; one side of the loop needs a re-plan or moe.set_task_dependencies.`
          );
        } catch { /* never block tool */ }
      }

      // On a FRESH flip, ids that are ALREADY satisfied (DONE/ARCHIVED) are
      // filtered out rather than recorded. Storing them would flip the row
      // BLOCKED with an instantly-satisfied dependency list: the very next
      // dependency scan restores it to WORKING-unassigned, the next worker
      // claims it, hits the same wall, re-blocks — an infinite claim-thrash
      // that also hides the row from the stale-block alert (it carries ids).
      // Filtered ids are reported back so the caller learns its prerequisites
      // already landed. The already-BLOCKED reason-update arm deliberately
      // KEEPS the union (satisfied ids included): that is the backfill path —
      // store the DONE ids and the next dependency sweep repairs the row.
      let satisfiedBlockedOnIds: string[] = [];
      let recordedBlockedOnIds = mergedBlockedOnIds;
      if (flipped) {
        satisfiedBlockedOnIds = mergedBlockedOnIds.filter((id) => {
          const dep = state.getTask(id);
          return !!dep && (dep.status === 'DONE' || dep.status === 'ARCHIVED');
        });
        if (satisfiedBlockedOnIds.length > 0) {
          const satisfied = new Set(satisfiedBlockedOnIds);
          recordedBlockedOnIds = mergedBlockedOnIds.filter((id) => !satisfied.has(id));
        }
      }

      // EVERY named prerequisite already landed and no resource is involved:
      // there is nothing to wait on, so the task is NOT blocked — the exact
      // mirror of the resource arm's "resource was free — lease granted, task
      // NOT blocked". Blocking here is the measured moe-next pattern ("blocks
      // point at tasks that are now DONE and the block still stands") and,
      // with the auto-unblock live, a claim-thrash livelock: flip → next scan
      // restores → next worker claims → same wall → flip. Nothing is written,
      // nobody is paged; the caller is pointed back at the board to read the
      // landed prerequisites' evidence and continue.
      const dependenciesSatisfied =
        flipped && !params.resourceId && mergedBlockedOnIds.length > 0 && recordedBlockedOnIds.length === 0;
      if (dependenciesSatisfied) {
        const seat = params.workerId || task.assignedWorkerId;
        return {
          success: true,
          taskId: task.id,
          taskStatus: task.status,
          blocked: false,
          dependenciesSatisfied: true,
          satisfiedBlockedOnTaskIds: satisfiedBlockedOnIds,
          alreadyBlocked: false,
          reasonUpdated: false,
          ...(ignoredBlockedOnIds.length > 0 ? { ignoredBlockedOnTaskIds: ignoredBlockedOnIds } : {}),
          ...(droppedCycleBlockedOnIds.length > 0 ? { droppedCycleBlockedOnTaskIds: droppedCycleBlockedOnIds } : {}),
          ...(warnings.length > 0 ? { warnings } : {}),
          workerStatus: seat ? state.getWorker(seat)?.status ?? 'IDLE' : 'IDLE',
          notified: { target: null, via: 'not-blocked-dependencies-satisfied' as const },
          message:
            `Every task you named (${satisfiedBlockedOnIds.join(', ')}) is already DONE/ARCHIVED — there is nothing to wait on, ` +
            `so ${task.id} was NOT blocked (status unchanged: ${task.status}) and nobody was paged. Continue the task.`,
          nextAction: {
            tool: 'moe.get_context',
            args: { taskId: task.id, ...(seat ? { workerId: seat } : {}) },
            reason:
              `The prerequisites already landed: read their verification / reviewSummary / completionSummary from ` +
              `get_context.epicSiblings and continue your current step. If something ELSE blocks you, re-file ` +
              `moe.report_blocked with a reason that names the real blocker (omit the landed ids — they are auto-parsed).`,
            recommendedSkill: recommendSkillFor('worker', 'task_blocked')
          }
        };
      }

      // Flip to BLOCKED to stop wrapper churn; blockedFromStatus remembers the
      // restore target used by the resource grant or explicit unblock paths.
      // Seat handling differs by arm:
      //   - RESOURCE block: assignedWorkerId passed EXPLICITLY (updateTask
      //     clears assignment on any status change when omitted) — the grant
      //     path returns the task to the SAME parked worker, and the wrapper's
      //     hold/suppression/resume design keys on alreadyAssigned{BLOCKED}.
      //   - NON-RESOURCE block reported BY THE ASSIGNEE (or on an unassigned
      //     task): the seat is FREED (assignment cleared, worker → IDLE) so
      //     the worker claims other work instead of idling a whole fleet seat
      //     against a wall — safe because the wrapper checkpoints the work at
      //     block time (bf3f8fa), so any worker can resume from the landed
      //     bytes; on auto-unblock the task returns unassigned.
      //   - THIRD-PARTY (workerId-less human/plugin) report on an ASSIGNED
      //     task: keeps the old hold semantics (assignment kept, worker marked
      //     BLOCKED). assertWorkerOwns permits the missing-workerId call, but
      //     freeing a LIVE worker's seat from the outside would unassign the
      //     task under a running session — the auto-unblock would then hand it
      //     to a second worker while the first is still editing the same files.
      const reporterIsAssignee =
        !task.assignedWorkerId
        || (typeof params.workerId === 'string' && params.workerId === task.assignedWorkerId);
      const freeSeat = flipped && !params.resourceId && reporterIsAssignee;
      const prevAssignee = task.assignedWorkerId;

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
        && !blockedOnIdsChanged
        && (params.resourceId === undefined || (task.blockedResourceId ?? null) === params.resourceId);
      const reasonUpdated = flipped || (alreadyBlocked && !identicalRepeat);

      if (flipped) {
        await state.updateTask(task.id, {
          status: 'BLOCKED',
          // Omitted on the seat-freeing arm ON PURPOSE: updateTask then clears
          // the assignment and resets the prior owner's task pointer.
          ...(freeSeat ? {} : { assignedWorkerId: task.assignedWorkerId }),
          blockedReason: params.reason,
          ...(recordedBlockedOnIds.length > 0 ? { blockedOnTaskIds: recordedBlockedOnIds } : {}),
          blockedResourceId: params.resourceId ?? null,
          blockedFromStatus: task.status,
          blockedAt: new Date().toISOString(),
        }, 'TASK_BLOCKED');
      } else if (alreadyBlocked && !identicalRepeat) {
        // No status change here, so neither the assignedWorkerId hazard above
        // nor the block bookkeeping applies: this lands a TASK_UPDATED event
        // carrying the corrected reason, which keeps the activity log able to
        // tell a correction apart from the block that opened it. New dependency
        // ids UNION in — a correction must never lose earlier ids.
        await state.updateTask(task.id, {
          blockedReason: params.reason,
          ...(blockedOnIdsChanged ? { blockedOnTaskIds: mergedBlockedOnIds } : {}),
          ...(params.resourceId !== undefined ? { blockedResourceId: params.resourceId } : {}),
        });
      }

      // Seat handling. Non-resource flip: the seat was freed above — put the
      // prior owner back in the claim pool (IDLE, no task pointer) instead of
      // parking it BLOCKED against its own task. Resource flip / legacy holds:
      // the parked worker is marked BLOCKED as before. An identical repeat
      // writes nothing anywhere -- no worker churn, no second page.
      if (freeSeat && prevAssignee) {
        // Guarded like the updateTask cascade: only null the pointer (and flip
        // IDLE) when it actually references THIS task — or is already null
        // (the cascade above just cleared it). A dangling assignment left by a
        // partial release failure means the worker's pointer references a
        // DIFFERENT task it is actively coding; wiping that pointer and forcing
        // IDLE mid-step is exactly the two-pointer drift this guard prevents.
        const prevWorker = state.getWorker(prevAssignee);
        if (prevWorker && (prevWorker.currentTaskId === task.id || prevWorker.currentTaskId == null)) {
          await state.touchWorker(prevAssignee, { status: 'IDLE', currentTaskId: null });
        }
      } else if (task.assignedWorkerId && !identicalRepeat) {
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
        'wait for the unblock of THIS task (resource grant, chat, moe.unblock_worker { resolveBlocks: true } ' +
        'or moe.set_task_status -- a plain unblock_worker only frees the seat and leaves the task BLOCKED) -- ' +
        'wait_for_task will not hand you other work while you hold it. To work something ' +
        'else instead, release this one first with moe.release_task; its blockedReason is preserved.';
      const nextActionReason = identicalRepeat
        ? `Task was already BLOCKED with this exact reason -- NOTHING was recorded. Use moe.add_comment to add detail, then ${waitHintTail}`
        : alreadyBlocked
          ? `Block reason UPDATED on the already-BLOCKED task; ${waitHintTail}`
          : `Block reported; ${waitHintTail}`;

      // BLOCKED is a wait state, never a terminal. A worker whose plan is fully
      // COMPLETED and who blocks instead of calling complete_task (the measured
      // "done but BLOCKED" stranding) still gets its block recorded — this is
      // warn-only — but is pointed straight at complete_task. Only for a task
      // blocked out of WORKING: complete_task rejects every other status.
      const plan = Array.isArray(task.implementationPlan) ? task.implementationPlan : [];
      const allStepsComplete = plan.length > 0 && plan.every((s) => s.status === 'COMPLETED');
      const deliveredButBlocked = !params.resourceId && allStepsComplete && statusForWait === 'WORKING';
      const warning = deliveredButBlocked
        ? 'ALL_STEPS_COMPLETE: BLOCKED is a wait state, not a terminal — if the work is delivered call moe.complete_task with verification'
        : undefined;

      // Seat-freed blocks point the (now IDLE) worker straight at other work;
      // a repeat on a legacy still-assigned hold keeps the wait-for-own-unblock
      // guidance; resource blocks keep no nextAction (the wrapper idles and the
      // grant path auto-unblocks).
      const seatWorker = prevAssignee || params.workerId;
      const nextAction = deliveredButBlocked
        ? {
            tool: 'moe.complete_task',
            args: { taskId: task.id, workerId: prevAssignee ?? params.workerId },
            reason: `${warning} (the task is BLOCKED; complete_task needs it back in WORKING first — moe.set_task_status, or unblock_worker { resolveBlocks: true } while a worker still holds it, if you cannot clear the block yourself). Otherwise ${waitHintTail}`,
            recommendedSkill: recommendSkillFor('worker', 'before_complete_task')
          }
        : freeSeat && seatWorker
          ? {
              tool: 'moe.claim_next_task',
              args: { workerId: seatWorker, statuses: waitStatuses },
              reason:
                'Block recorded and your seat was FREED: the task is parked BLOCKED and unassigned, you are IDLE. ' +
                (recordedBlockedOnIds.length > 0
                  ? `It auto-unblocks (returning unassigned, claimable by anyone) once ${recordedBlockedOnIds.join(', ')} are DONE/ARCHIVED. `
                  : satisfiedBlockedOnIds.length > 0
                    ? `The task id(s) you named (${satisfiedBlockedOnIds.join(', ')}) are ALREADY DONE/ARCHIVED, so they were NOT recorded as blockers — if they were your only blocker the block is stale (a human/governor clears it via moe.set_task_status); if something else blocks you, re-file with the real blocker ids. `
                    // unblock_worker is deliberately NOT named here: it only
                    // reaches tasks still ASSIGNED to a worker, and the seat
                    // was just freed — set_task_status is the working escape
                    // for an unassigned BLOCKED row.
                    : 'No blockedOnTaskIds were recorded, so a human/governor must clear it via moe.set_task_status (unblock_worker cannot reach an unassigned task) — if it actually waits on other tasks, re-file with blockedOnTaskIds. ') +
                'Claim other work now.',
              recommendedSkill: recommendSkillFor('worker', 'task_blocked')
            }
          : task.assignedWorkerId && !params.resourceId
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
        ...(warning ? { warning } : {}),
        // Both flags report what was WRITTEN, never what the status happens to
        // read: taskStatus already printed 'BLOCKED' on the broken no-op path,
        // which is exactly why the silent failure was invisible.
        alreadyBlocked,
        reasonUpdated,
        ...(params.resourceId ? { resourceId: params.resourceId, granted: false } : {}),
        // What the row now carries: on a fresh flip the satisfied ids were
        // filtered out (see above); on the reason-update arm the full union.
        ...((flipped ? recordedBlockedOnIds : mergedBlockedOnIds).length > 0
          ? { blockedOnTaskIds: flipped ? recordedBlockedOnIds : mergedBlockedOnIds }
          : {}),
        ...(satisfiedBlockedOnIds.length > 0 ? { satisfiedBlockedOnTaskIds: satisfiedBlockedOnIds } : {}),
        ...(ignoredBlockedOnIds.length > 0
          ? { ignoredBlockedOnTaskIds: ignoredBlockedOnIds }
          : {}),
        ...(droppedCycleBlockedOnIds.length > 0 ? { droppedCycleBlockedOnTaskIds: droppedCycleBlockedOnIds } : {}),
        ...(warnings.length > 0 ? { warnings } : {}),
        ...(flipped ? { seatFreed: freeSeat } : {}),
        workerStatus: freeSeat
          ? (prevAssignee ? state.getWorker(prevAssignee)?.status ?? 'IDLE' : 'IDLE')
          : identicalRepeat && task.assignedWorkerId
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
            : freeSeat
              ? (architect
                  ? `Task blocked; seat freed — claim other work. Pinged ${architect.id} (freshest live architect).`
                  : 'Task blocked; seat freed — claim other work. No live architect — escalated to @governors.')
              : architect
                ? `Worker marked as blocked. Pinged ${architect.id} (freshest live architect).`
                : 'Worker marked as blocked. No live architect — escalated to @governors.',
        ...(nextAction ? { nextAction } : {})
      };
    }
  };
}
