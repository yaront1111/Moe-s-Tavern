import { MoeError, MoeErrorCode } from './errors.js';
import type { ImplementationStep, Task } from '../types/schema.js';

/**
 * Ownership guards for the claim/release seam (task-6df8a07b).
 *
 * These live in their own module rather than inside releaseTask.ts or
 * claimNextTask.ts because both tools need the same lease check, and because
 * the two incidents of 2026-08-19 showed the rules are one concern: a row's
 * assignment may only change when the caller is entitled to change it.
 *
 * WHAT WENT WRONG. `taskStore`'s optimistic-concurrency check is truthy-gated
 * on the incoming `assignedWorkerId`, so it guards ASSIGNMENT and is blind to
 * UN-assignment: a release passes `null`, skips the check entirely, and clears
 * whoever happened to hold the row at that instant. An architect's handoff
 * release therefore stripped a live worker twice, mid-step, with nothing raised
 * anywhere — and the banner named the stripped worker as the releaser.
 *
 * The tolerances below are deliberate and mirror `assertWorkerOwns`: an
 * unassigned row is nobody's to lose, and a caller supplying no workerId is the
 * documented human/TUI/plugin crash-recovery path.
 */

/** Caller is not the assignee and did not pass `force`. */
export const RELEASE_NOT_ASSIGNEE = 'RELEASE_NOT_ASSIGNEE';
/** A claim lost a genuine race at the write point; the winner is named. */
export const CLAIM_LOST_RACE = 'CLAIM_LOST_RACE';
/** The row's current step is IN_PROGRESS and its holder is alive. */
export const STEP_LEASE_HELD = 'STEP_LEASE_HELD';

/**
 * The actor recorded when a release carries no caller id.
 *
 * Deliberately not 'board': the caller-less path is reached from the plugin
 * board, the legacy TUI and a bare human CLI call alike, and the daemon
 * verifies none of them. Epic rail 4 — unverifiable evidence stays UNKNOWN and
 * never gains authority — so the record says what is true, that the releaser
 * was not identified. Matches the value releaseTask.ts already writes on the
 * already-unassigned repair path, and carries no agent-id prefix, so it can
 * never be mistaken for a worker/governor/architect.
 */
export const UNIDENTIFIED_RELEASER = 'unknown';

/**
 * The step a worker is mid-way through, or null. A granted `start_step` is what
 * makes the row expensive to lose: the holder may be minutes into a build by
 * the time anything else touches it.
 */
export function inProgressStep(task: Task): ImplementationStep | null {
  const plan = Array.isArray(task.implementationPlan) ? task.implementationPlan : [];
  return plan.find((step) => step?.status === 'IN_PROGRESS') ?? null;
}

/**
 * Refuse to move a row out from under a worker who is mid-step.
 *
 * `force` is the single override, so a row held by a dead worker stays
 * recoverable — the door is explicit and both parties end up in the banner,
 * rather than every caller silently having the power.
 */
export function assertNoLiveLease(task: Task, force: boolean, caller?: string): void {
  if (force) return;
  if (!task.assignedWorkerId) return;
  // Re-claiming your own row is a resume, never a takeover.
  if (caller && task.assignedWorkerId === caller) return;
  const step = inProgressStep(task);
  if (!step) return;
  throw new MoeError(
    MoeErrorCode.NOT_ALLOWED,
    `Task ${task.id} is leased by ${task.assignedWorkerId} with step ${step.stepId} IN_PROGRESS; `
      + 'pass force:true to override a confirmed-dead holder',
    { taskId: task.id, holder: task.assignedWorkerId, stepId: step.stepId, caller },
    STEP_LEASE_HELD
  );
}

/**
 * Refuse a release issued by anyone other than the current assignee.
 *
 * No-op when the row is unassigned (nothing to strip) or when the caller
 * supplied no workerId — the tool's contract is that anyone may call it for
 * confirmed-crash recovery, and tightening that here would break the TUI,
 * plugin and human paths. The lease check above is what protects a mid-step
 * row from those callers.
 */
export function assertReleaseCaller(task: Task, caller: string | undefined, force: boolean): void {
  if (force) return;
  if (!task.assignedWorkerId) return;
  if (!caller) return;
  if (task.assignedWorkerId === caller) return;
  throw new MoeError(
    MoeErrorCode.NOT_ALLOWED,
    `Task ${task.id} is held by ${task.assignedWorkerId}, not ${caller}; `
      + 'pass force:true to release a row you do not hold',
    { taskId: task.id, holder: task.assignedWorkerId, caller },
    RELEASE_NOT_ASSIGNEE
  );
}

/** The refusal a claim owes the loser of a real race, naming who won. */
export function claimLostRace(taskId: string, winner: string, caller: string): MoeError {
  return new MoeError(
    MoeErrorCode.NOT_ALLOWED,
    `Task ${taskId} was claimed by ${winner} while ${caller} was claiming it`,
    { taskId, winner, caller },
    CLAIM_LOST_RACE
  );
}

export interface ReleaseActors {
  /** Who performed the release. */
  readonly actor: string;
  /** Who was holding it, when that is someone other than the actor. */
  readonly strippedFrom: string | null;
}

/**
 * Who to name in the release banner.
 *
 * The defect this replaces rendered `${previousWorkerId} released task`
 * unconditionally, which recorded the VICTIM as the releaser — twice in the
 * durable log, in the shape of worker misconduct. A self-release still renders
 * one actor; a strip renders both, in distinguishable roles.
 */
export function releaseActors(caller: string | undefined, previousWorkerId: string): ReleaseActors {
  if (caller === previousWorkerId) {
    return { actor: previousWorkerId, strippedFrom: null };
  }
  // No caller id, but somebody IS being stripped. Folding this into the
  // self-release branch made the two byte-identical, so a board/TUI/plugin
  // release of a live holder rendered as `worker-a released task` — the same
  // victim-as-releaser line this function exists to eliminate, on the one path
  // that carries no id to name instead. `force` is forwarded from the board
  // (WebSocketServer), so it reaches mid-step holders too.
  if (!caller) {
    return { actor: UNIDENTIFIED_RELEASER, strippedFrom: previousWorkerId };
  }
  return { actor: caller, strippedFrom: previousWorkerId };
}
