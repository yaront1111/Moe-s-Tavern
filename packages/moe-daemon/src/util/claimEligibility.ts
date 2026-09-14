import type { StateManager } from '../state/StateManager.js';
import type { ExecutionAttempt, Task } from '../types/schema.js';
import { listAttempts } from '../state/attemptStore.js';
import { unmetDependsOn } from '../state/dependencyUnblock.js';
import { ATTEMPT_FINALIZING } from './claimGuards.js';
import { MoeError, MoeErrorCode } from './errors.js';

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
  blockedOnTaskIds?: string[] | null;
}

/**
 * dependsOn gates WORKING-status claims ONLY: a WORKING candidate whose
 * declared prerequisites are not all DONE/ARCHIVED is withheld from both
 * claim_next_task's ranked pool and wait_for_task's matcher (the two MUST stay
 * in lockstep — a task that is wait-visible but claim-ineligible re-creates
 * the wake→claim→refuse spin this module exists to prevent). Planning and
 * review claims are unaffected; missing/deleted ids count as satisfied.
 */
export function isClaimGatedByDependsOn(state: StateManager, task: Task): boolean {
  return task.status === 'WORKING' && unmetDependsOn(state, task).length > 0;
}

/**
 * THE FINALIZING HOLD ON A TASK, as every claim path reads it (task-758423de).
 *
 * complete_task hands the row to QA unassigned but keeps its attempt open in
 * `finalizing` until the worker's runner has landed the bytes and called
 * moe.finalize_attempt. Until then the row belongs to that landing. A claim by
 * any other seat would open its own attempt over it — openClaimAttempt closes
 * whatever is open on ATTEMPT_ALREADY_OPEN — which lifts qa_approve's hold and
 * fences the runner's record_candidate and finalize_attempt out as superseded.
 * So no seat other than the attempt's own worker may claim the row: an
 * explicit-taskId claim is refused (foreignFinalizingRefusal), and
 * claim_next_task's ranked pool and wait_for_task's matcher skip it. Both tools
 * MUST read this one predicate, for the dependsOn gate's reason: a row that is
 * wait-visible but claim-ineligible wakes a waiter into a claim that returns
 * nothing.
 *
 * The attempt's own worker never reaches this rule, because claim_next_task's
 * worker-scoped hold refuses every claim of that worker first. The hold ends
 * through moe.finalize_attempt (its runner, or a governor or human with outcome
 * 'failed') or through its runner's moe.deregister_worker — never on an idle
 * signal.
 */

/**
 * A finalizing record the hold can name. Anything else is skipped, neither
 * trusted nor thrown on: loadEntities admits any JSON that carries an id, and
 * one hand-edited record must not take every claim down or hold a row for a
 * worker nobody can name.
 */
function isHoldingFinalizingAttempt(attempt: ExecutionAttempt): boolean {
  return (
    attempt.phase === 'finalizing' &&
    isNonBlankString(attempt.id) &&
    isNonBlankString(attempt.taskId) &&
    isNonBlankString(attempt.workerId) &&
    Number.isSafeInteger(attempt.generation) &&
    attempt.generation >= 1
  );
}

function isNonBlankString(value: unknown): boolean {
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * Each task's finalizing attempt, keyed by task id. Build it ONCE per claim or
 * match call and hand it to foreignFinalizingAttempt per candidate: listAttempts
 * copies and sorts every record, so a lookup per row would cost
 * O(tasks × attempts). Records arrive in generation order, so a task that somehow
 * holds two keeps the highest.
 */
export function finalizingAttemptsByTask(state: StateManager): Map<string, ExecutionAttempt> {
  const index = new Map<string, ExecutionAttempt>();
  for (const attempt of listAttempts(state)) {
    if (isHoldingFinalizingAttempt(attempt)) index.set(attempt.taskId, attempt);
  }
  return index;
}

/**
 * The task's finalizing attempt when it belongs to a worker other than the
 * caller, else null. A caller without a workerId counts as foreign: such a claim
 * assigns nothing and opens no attempt, so this only turns a read-only peek into
 * a skip or a refusal.
 */
export function foreignFinalizingAttempt(
  index: ReadonlyMap<string, ExecutionAttempt>,
  taskId: string,
  workerId: string | undefined
): ExecutionAttempt | null {
  const attempt = index.get(taskId);
  if (!attempt || attempt.workerId === workerId) return null;
  return attempt;
}

/**
 * The explicit-taskId refusal for a row another worker's landing holds. Same
 * code name and context shape as claimGuards' attemptFinalizingRefusal — a
 * retryable STATE_CONFLICT naming the attempt's holder in context.workerId — but
 * written for the REFUSED seat: that refusal tells its reader to finalize, which
 * is the wrong advice for a QA caller. MoeError.context is not forwarded over the
 * MCP wire, so the message names the attempt and the escape as well.
 */
export function foreignFinalizingRefusal(attempt: ExecutionAttempt): MoeError {
  return new MoeError(
    MoeErrorCode.STATE_CONFLICT,
    `Task ${attempt.taskId} is held by worker ${attempt.workerId}'s attempt ${attempt.id} ` +
      `(generation ${attempt.generation}) in phase finalizing: its bytes are not landed yet, so no ` +
      'other seat may claim it. This is a RETRYABLE refusal (context.retryable) — retry after that ' +
      `worker's runner calls moe.finalize_attempt. If worker ${attempt.workerId} is gone for good, a ` +
      'governor or human closes the boundary with moe.finalize_attempt { taskId, attemptId, ' +
      "generation, outcome: 'failed' }.",
    {
      attemptId: attempt.id,
      generation: attempt.generation,
      taskId: attempt.taskId,
      workerId: attempt.workerId,
      retryable: true,
    },
    ATTEMPT_FINALIZING
  );
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
    blockedOnTaskIds?: string[];
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
  const onTasks = Array.isArray(hold.blockedOnTaskIds) && hold.blockedOnTaskIds.length > 0;
  const why = onResource
    ? ` waiting on resource ${hold.blockedResourceId}`
    : onTasks
      ? ` waiting on task(s) ${hold.blockedOnTaskIds!.join(', ')}`
      : ` (${hold.blockedReason ?? 'needs a human'})`;
  const idle = onResource
    ? 'the resource grant auto-unblocks it'
    : onTasks
      ? 'the daemon auto-unblocks it when those tasks are DONE/ARCHIVED'
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
            blockedResourceId: hold.blockedResourceId ?? undefined,
            ...(Array.isArray(hold.blockedOnTaskIds) && hold.blockedOnTaskIds.length > 0
              ? { blockedOnTaskIds: hold.blockedOnTaskIds }
              : {})
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
