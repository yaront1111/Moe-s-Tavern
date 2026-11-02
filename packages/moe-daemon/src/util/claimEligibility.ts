import type { StateManager } from '../state/StateManager.js';
import type { ExecutionAttempt, Task } from '../types/schema.js';
import { currentAttempt, listAttempts } from '../state/attemptStore.js';
import { unmetDependsOn } from '../state/dependencyUnblock.js';
import {
  assertExecutionProfileReady,
  readExecutionPolicySnapshot,
  resolveTaskExecutionProfile
} from '../delivery/executionProfile.js';
import { ATTEMPT_FINALIZING } from './claimGuards.js';
import { MoeError, MoeErrorCode, invalidInput } from './errors.js';

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
 * EXECUTION-PROFILE ADMISSION (CQ-M01e): why `task` may not be claimed, or
 * null when it may. One predicate for every claim path: claim_next_task's
 * explicit-taskId path THROWS the result before any write, while its ranked
 * pool and wait_for_task's matcher SKIP a non-null row — for the dependsOn
 * gate's reason, a row that is wait-visible but claim-ineligible is the
 * measured wake→claim→refuse spin.
 *
 * The task-level rule is the CQ-M01c store backstop's: the live profile,
 * floored by a stored verified-local task snapshot, so a project rollback
 * cannot lower it. An own-seat resume (the caller is the assignee) continues
 * the execution its own open attempt recorded, so that attempt's snapshot must
 * be ready too. Any other worker's leftover attempt is never consulted: a
 * successor claim records a fresh identity (CQ-M01d).
 *
 * It grants nothing: null is not approval, readiness or trust. No environment
 * flag is read; the leaf's assertExecutionProfileReady stays the only readiness
 * authority. The one caller field read is `executionRoute`, and it can only
 * REFUSE: a verified-local WORKING or REVIEW row is refused to any claim that
 * does not carry 'vm' (EXECUTION_ROUTE_REQUIRED), checked AFTER readiness, so the
 * marker never satisfies or skips readiness or any other claim check. It is a
 * guard against an accidental host run (an older wrapper, a hand-run CLI), not
 * authentication: CQ-M07m/n's wrapper VM route is what sends it. PLANNING rows
 * (architects stay on the host) and legacy/observe rows are never asked for it.
 *
 * Error handling: returns the refusal — EXECUTION_PROFILE_NOT_READY,
 * EXECUTION_ROUTE_REQUIRED, or INVALID_INPUT naming the malformed snapshot or
 * setting (fail closed). Only a non-MoeError propagates. Never writes.
 */
export function executionAdmissionRefusal(
  state: StateManager,
  task: Task,
  workerId?: string,
  executionRoute?: ExecutionRoute
): MoeError | null {
  try {
    const profile = resolveTaskExecutionProfile(state.project?.settings, task.executionPolicySnapshot);
    assertExecutionProfileReady(profile);
    let strict = profile === 'verified-local';
    if (workerId && task.assignedWorkerId === workerId) {
      const own = currentAttempt(state, task.id);
      const recorded = own?.workerId === workerId ? readExecutionPolicySnapshot(own.executionPolicySnapshot) : undefined;
      if (recorded) {
        assertExecutionProfileReady(recorded.profile);
        strict = strict || recorded.profile === 'verified-local';
      }
    }
    if (strict && (task.status === 'WORKING' || task.status === 'REVIEW') && executionRoute !== 'vm') {
      return routeRequiredRefusal(task);
    }
    return null;
  } catch (err: unknown) {
    if (err instanceof MoeError) return err;
    throw err;
  }
}

/** The only value `executionRoute` may carry: the wrapper's Moe VM route (CQ-M07m/n). */
export type ExecutionRoute = 'vm';

/** Codename of the refusal a strict WORKING/REVIEW claim gets without the VM-route marker. */
export const EXECUTION_ROUTE_REQUIRED = 'EXECUTION_ROUTE_REQUIRED';

/**
 * Parse the optional `executionRoute` claim/wait argument: absent stays
 * undefined, exactly 'vm' passes, anything else (including null, '' and 'VM') is
 * INVALID_INPUT. Call it at the top of a handler, before any read-modify-write,
 * so a malformed value writes nothing.
 */
export function parseExecutionRoute(value: unknown): ExecutionRoute | undefined {
  if (value === undefined) return undefined;
  if (value === 'vm') return 'vm';
  throw invalidInput('executionRoute', "must be 'vm' when present");
}

function routeRequiredRefusal(task: Task): MoeError {
  return new MoeError(
    MoeErrorCode.NOT_ALLOWED,
    `Task ${task.id} runs under verified-local: only a VM-route seat may claim it in ${task.status} ` +
      '(claim_next_task executionRoute "vm"). A seat that runs its agent CLI on the host must not claim it.',
    { taskId: task.id, status: task.status, executionProfile: 'verified-local', requiredRoute: 'vm' },
    EXECUTION_ROUTE_REQUIRED
  );
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
 * only through the closes attemptStore.closeHandedBackAttempts lists —
 * moe.finalize_attempt (its runner, or a governor or human with outcome
 * 'failed'), its worker's moe.deregister_worker, deletion of its task, a restart
 * that finds its task gone, or removal of its worker's DEAD record — never on an
 * idle signal.
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
  nextAction?: NextActionHint;
  sessionHandoff?: { action: 'END_SESSION'; taskId: string; workerId: string; reason: string };
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
 * Do not suggest crash recovery to a healthy seat. Non-resource holds can be
 * acknowledged through report_blocked; resource holds stay parked for a grant.
 * Both paths finish this wrapper session before any later claim.
 */
function blockedHoldGuidance(
  hold: BlockedHoldRef, workerId: string
): Pick<HeldTaskRefusal, 'nextAction' | 'sessionHandoff'> {
  if (hold.blockedResourceId) {
    return {
      sessionHandoff: {
        action: 'END_SESSION', taskId: hold.id, workerId,
        reason: `You hold ${hold.id}, BLOCKED on resource ${hold.blockedResourceId}. ` +
          'Save the handoff and end this session so the wrapper can checkpoint and idle until the resource grant. ' +
          'Keep the task, seat and queue intact. Do not work on it or call moe.wait_for_task or ' +
          'moe.claim_next_task for other work inside this session.'
      }
    };
  }
  return {
    nextAction: {
      tool: 'moe.report_blocked',
      args: {
        taskId: hold.id, workerId,
        reason: hold.blockedReason || 'Existing BLOCKED task needs blocker clarification before resuming.',
        ...(hold.blockedOnTaskIds?.length ? { blockedOnTaskIds: hold.blockedOnTaskIds } : {})
      },
      reason: `You hold ${hold.id} and it is BLOCKED. Confirm the blocker still applies before acknowledging it ` +
        '(if resolved, refresh moe.get_context instead). Acknowledge the existing non-resource blocker ' +
        'with moe.report_blocked as the assignee; this frees only your seat, preserving the task block. ' +
        (hold.blockedOnTaskIds?.length
          ? `It auto-unblocks when ${hold.blockedOnTaskIds.join(', ')} are DONE/ARCHIVED with any required delivery evidence. `
          : 'A human or governor must resolve the remaining blocker. ') +
        'Save the handoff first, then obey sessionHandoff: end this session so its wrapper can checkpoint. ' +
        'Do not claim or wait for other work inside the same session, and do not invent or clear a blocker.'
    }
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
    ...(blocked
      ? blockedHoldGuidance(hold, workerId)
      : {
          nextAction: {
            tool: 'moe.get_context',
            args: { taskId: hold.id, workerId },
            reason:
              `One task per worker: you already hold ${hold.id} (${hold.status}). Read its context and resume ` +
              'or finish it (submit_plan / complete_task / qa_approve / qa_reject). If a real blocker prevents ' +
              'progress, save your handoff and use moe.report_blocked with its actual reason and dependencies; ' +
              'then follow sessionHandoff before another claim. Do not fabricate a block just to switch tasks.'
          }
        })
  };
}
