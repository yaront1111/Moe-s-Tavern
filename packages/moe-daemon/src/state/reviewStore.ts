// =============================================================================
// Review store — the audit trail binding a QA decision to the bytes it read
// =============================================================================
//
// A Review says "this reviewer made this call against THIS candidate". It is
// what turns an approval from a status flip into evidence: without the binding,
// an approval issued against one candidate silently blesses whatever the task
// holds by the time it lands.
//
// APPEND-ONLY BY CONSTRUCTION. This module has NO update, patch or delete
// function, and that absence is the rule, not an oversight: a later caller
// cannot misuse a function that does not exist, which is stronger than a
// convention not to call one. A reopened task that is reviewed again gets a
// SECOND record — history is never rewritten, so the trail of who approved what
// stays readable after the fact.
//
// Follows the resourceStore / attemptStore / candidateStore pattern: stateless
// functions taking the state handle first; every mutation assumes THE CALLER
// HOLDS state.mutex (tool dispatch provides it for non-blocking tools).
//
// Write path: writeEntity → map.set. Persist BEFORE the record becomes visible,
// so a failed write leaves no review anywhere — which is what lets qa_approve
// promise that a refused approval moves not one byte. Like candidateStore, no
// activity row and no emit: there is no consumer yet, and both would need edits
// to the ACTIVITY_EVENT_TYPES / StateChangeEvent unions.

import type { StateManager } from './StateManager.js';
import type { Review, ReviewDecision } from '../types/schema.js';
import { MoeError, MoeErrorCode, invalidInput, missingRequired } from '../util/errors.js';
import { generateId } from '../util/ids.js';
import { validateEntityId } from '../util/sanitize.js';
import { listCandidatesForTask } from './candidateStore.js';

/** The only two decisions a review may carry. A third value is refused, never coerced. */
const DECISIONS: readonly ReviewDecision[] = ['approve', 'reject'] as const;

export interface RecordReviewParams {
  /** Optional. Supply an id to make a retry idempotent; omit it for a fresh generated id. */
  id?: string;
  taskId: string;
  candidateId: string;
  reviewerId: string;
  decision: ReviewDecision;
  summary: string;
}

type RawReviewParams = { [K in keyof RecordReviewParams]?: unknown };

/** Bounded rendering of an untrusted value: it cannot throw and cannot flood a message. */
function renderGot(value: unknown): string {
  if (value === null) return 'null';
  const kind = typeof value;
  if (kind === 'object' || kind === 'function' || kind === 'symbol') return `a value of type ${kind}`;
  const text = kind === 'string' ? JSON.stringify(value) : String(value);
  return text.length > 40 ? `${text.slice(0, 40)}…` : text;
}

/** Absent (undefined or null) is MISSING_REQUIRED; present but not a non-blank string is INVALID_INPUT. */
function requireText(field: string, value: unknown): string {
  if (value === undefined || value === null) throw missingRequired(field);
  if (typeof value !== 'string') throw invalidInput(field, `must be a string (got ${renderGot(value)})`);
  if (value.trim() === '') throw invalidInput(field, 'must be a non-blank string');
  return value;
}

/** A reference to a stored entity: non-blank and a valid entity id, which also bounds its length. */
function requireEntityRef(field: string, value: unknown): string {
  return validateEntityId(requireText(field, value), field);
}

function requireDecision(value: unknown): ReviewDecision {
  const text = requireText('decision', value);
  if (!DECISIONS.includes(text as ReviewDecision)) {
    throw invalidInput('decision', `must be one of ${DECISIONS.join(', ')} (got ${renderGot(text)})`);
  }
  return text as ReviewDecision;
}

/** Validate a review's caller-supplied fields, refusing rather than coercing. */
function validateReviewParams(raw: unknown): RecordReviewParams {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw invalidInput('review', `must be an object (got ${renderGot(raw)})`);
  }
  const fields = raw as RawReviewParams;
  return {
    ...(fields.id !== undefined ? { id: requireEntityRef('id', fields.id) } : {}),
    taskId: requireEntityRef('taskId', fields.taskId),
    candidateId: requireEntityRef('candidateId', fields.candidateId),
    // Not an entity ref: the IDE/human approval path records `human`, and a
    // reviewer seat need not have a persisted worker record by the time it signs off.
    reviewerId: requireText('reviewerId', fields.reviewerId),
    decision: requireDecision(fields.decision),
    summary: requireText('summary', fields.summary),
  };
}

const copy = (review: Review): Review => ({ ...review });

/** createdAt, then id: a tie on the clock can never reorder the output. */
function byCreatedAtThenId(a: Review, b: Review): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  return 0;
}

export function getReview(state: StateManager, reviewId: string): Review | null {
  const stored = state.reviews.get(reviewId);
  return stored ? copy(stored) : null;
}

/** Every review recorded for a task, oldest first. Copies, so a caller cannot edit stored state. */
export function listReviewsForTask(state: StateManager, taskId: string): Review[] {
  return Array.from(state.reviews.values())
    .filter((review) => review.taskId === taskId)
    .sort(byCreatedAtThenId)
    .map(copy);
}

/**
 * Append one review. Validates without coercing, then persists BEFORE publishing.
 * createdAt is the daemon's clock, never the caller's. There is no counterpart
 * that edits or removes what this writes.
 */
export async function recordReview(
  state: StateManager,
  params: RecordReviewParams
): Promise<Review> {
  const input = validateReviewParams(params);
  const review: Review = {
    id: input.id ?? generateId('review'),
    taskId: input.taskId,
    candidateId: input.candidateId,
    reviewerId: input.reviewerId,
    decision: input.decision,
    summary: input.summary,
    createdAt: new Date().toISOString(),
  };
  // writeEntity validates the id against path traversal, creates .moe/reviews
  // itself and writes atomically (temp file + rename).
  await state.writeEntity('reviews', review.id, review);
  state.reviews.set(review.id, review);
  return copy(review);
}

// =============================================================================
// Reviewed-candidate binding — shared by qa_approve and qa_reject
// =============================================================================

/**
 * The refusal a QA decision gets when the candidate it names is no longer the
 * task's current one. A STATE_CONFLICT (-32002), the same numeric code the
 * attempt guards reuse: the reviewer did nothing wrong, the bytes simply moved
 * under them. Stable codeName so a client can branch on it without parsing text.
 */
export const CANDIDATE_MISMATCH = 'CANDIDATE_MISMATCH';

export interface ReviewedCandidateBinding {
  /** The candidate a Review must bind to, or undefined when the task has none. */
  candidateId?: string;
  /** Set when the binding is incomplete but the decision still proceeds. Never a refusal. */
  warning?: string;
}

/**
 * Resolve which candidate a QA decision is being made against, refusing when the
 * reviewer read bytes that are no longer current.
 *
 * The decision order is the whole contract, so it is spelled out:
 *   1. No candidate recorded for the task at all → behave exactly as before this
 *      binding existed. Adoption is incremental: a project that never records
 *      candidates must keep working, so this is not a refusal and writes no
 *      Review (there is nothing truthful to bind one to).
 *   2. A candidateId is supplied and differs from the current candidate →
 *      CANDIDATE_MISMATCH, thrown to the caller BEFORE any write.
 *   3. A candidate exists but none was supplied → proceed, with a warning, so
 *      the unbound decision is visible rather than silent.
 *   4. They match → proceed, bound.
 *
 * A candidateId belonging to a DIFFERENT task falls into case 2 automatically:
 * it is compared against THIS task's current candidate, which it cannot equal.
 */
export function resolveReviewedCandidate(
  state: StateManager,
  taskId: string,
  suppliedCandidateId: unknown,
  toolName: string
): ReviewedCandidateBinding {
  const supplied =
    suppliedCandidateId === undefined || suppliedCandidateId === null
      ? undefined
      : requireEntityRef('candidateId', suppliedCandidateId);

  const candidates = listCandidatesForTask(state, taskId);
  const current = candidates.length > 0 ? candidates[candidates.length - 1] : undefined;

  if (!current) {
    return supplied
      ? {
          warning:
            `NO-CANDIDATE-RECORDED: ${toolName} named candidate ${supplied} but task ${taskId} has no candidate ` +
            'recorded, so this decision is not bound to any reviewed bytes',
        }
      : {};
  }

  if (supplied === undefined) {
    return {
      candidateId: current.id,
      warning:
        `NO-REVIEWED-CANDIDATE: task ${taskId} has current candidate ${current.id} but ${toolName} named none — ` +
        'pass candidateId so the decision is bound to the bytes you actually read',
    };
  }

  if (supplied !== current.id) {
    throw new MoeError(
      MoeErrorCode.STATE_CONFLICT,
      `Task ${taskId} has moved on: you reviewed candidate ${supplied}, but its current candidate is ` +
        `${current.id}. Re-read the current candidate (moe.get_context -> currentCandidate) and decide again.`,
      { taskId, expectedCandidateId: supplied, currentCandidateId: current.id, tool: toolName },
      CANDIDATE_MISMATCH
    );
  }

  return { candidateId: current.id };
}
