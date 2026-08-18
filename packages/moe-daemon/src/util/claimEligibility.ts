import type { StateManager } from '../state/StateManager.js';
import type { Task } from '../types/schema.js';

/**
 * One definition of "this worker is encumbered", shared by claim_next_task and
 * wait_for_task.
 *
 * The two tools used to answer the same board differently: claim refused a
 * worker holding a BLOCKED task with `alreadyAssigned`, while wait happily
 * offered that worker a foreign task and told it to claim — a wait -> claim ->
 * refuse -> wait spin the wrapper cannot escape, measured twice in one session
 * (task-9d5dfec6). Both tools now read the SAME held-task source
 * (getActiveTasksAssignedToWorker, whose active set includes BLOCKED — see
 * state/workerStore.ts) and emit the SAME guidance, so the two answers cannot
 * drift apart again without a test noticing.
 */

/** Minimum shape needed to describe a blocked hold; a full Task satisfies it. */
export interface BlockedHoldRef {
  id: string;
  blockedReason?: string | null;
  blockedResourceId?: string | null;
}

export interface NextActionHint {
  tool: string;
  args: Record<string, unknown>;
  reason: string;
}

export interface HeldTaskRefusal {
  hasNext: false;
  alreadyAssigned: {
    taskId: string;
    title: string;
    status: string;
    blockedReason?: string;
    blockedResourceId?: string;
  };
  nextAction: NextActionHint;
}

/**
 * The active task blocking this worker from claiming, or null when it is free.
 *
 * `exceptTaskId` is the resume path: re-claiming the task you already hold is
 * sanctioned, so it never blocks itself.
 */
export function blockingHold(
  state: StateManager,
  workerId: string,
  exceptTaskId?: string
): Task | null {
  const held = state
    .getActiveTasksAssignedToWorker(workerId)
    .filter((t) => t.id !== exceptTaskId);
  return held[0] ?? null;
}

/**
 * The one piece of guidance every tool gives a worker holding a BLOCKED task.
 *
 * Names both real exits and explicitly closes the loop that used to send the
 * worker back into wait_for_task: while the hold stands, nothing else is
 * claimable by this worker, so waiting can only produce another refusal.
 * moe.list_resources — the old hint — cannot clear a non-resource block.
 */
export function blockedHoldNextAction(hold: BlockedHoldRef, workerId: string): NextActionHint {
  const onResource = Boolean(hold.blockedResourceId);
  const why = onResource
    ? ` waiting on resource ${hold.blockedResourceId}`
    : ` (${hold.blockedReason ?? 'needs a human'})`;
  const idle = onResource
    ? 'the resource grant auto-unblocks it'
    : 'a human or governor must unblock it';
  return {
    tool: 'moe.release_task',
    args: { taskId: hold.id, workerId },
    reason:
      `You hold ${hold.id} and it is BLOCKED${why}. Do NOT work on it, and do NOT ` +
      `re-enter moe.wait_for_task hoping for different work: while you hold this task ` +
      `nothing else is claimable by you, so wait_for_task will not offer you any. ` +
      `Two workable exits — end your session and let the wrapper idle (${idle}), or ` +
      `call moe.release_task {taskId: "${hold.id}"} to hand it back with its ` +
      `blockedReason intact and free your slot to claim other work.`
  };
}

/**
 * The refusal both tools return to an encumbered caller. Identical payload from
 * either tool by construction — that identity is the property the regression
 * test asserts, and the reason this lives in one place.
 */
export function heldTaskRefusal(hold: Task, workerId: string): HeldTaskRefusal {
  const blocked = hold.status === 'BLOCKED';
  return {
    hasNext: false,
    alreadyAssigned: {
      taskId: hold.id,
      title: hold.title,
      status: hold.status,
      ...(blocked
        ? {
            blockedReason: hold.blockedReason ?? undefined,
            blockedResourceId: hold.blockedResourceId ?? undefined
          }
        : {})
    },
    nextAction: blocked
      ? blockedHoldNextAction(hold, workerId)
      : {
          tool: 'moe.get_context',
          args: { taskId: hold.id, workerId },
          reason:
            `One task per worker: you already hold ${hold.id} (${hold.status}). Resume it, ` +
            `finish it (submit_plan / complete_task / qa_approve / qa_reject), or release it ` +
            `(moe.release_task) before claiming another.`
        }
  };
}
