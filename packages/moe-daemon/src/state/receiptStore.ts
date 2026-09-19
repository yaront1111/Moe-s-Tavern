// =============================================================================
// Receipt store — where a wrapper says one candidate's bytes landed
// =============================================================================
//
// A DeliveryReceipt records ONE landing of ONE Candidate as the wrapper that
// performed it REPORTED it: the target ref, where that ref pointed before and
// after, the revision that landed there, and the push result when a push was
// required. It exists for crash recovery. A wrapper that dies between moving the
// target ref and recording the landing asks on its next pass whether the
// candidate already landed, and needs an answer that cannot change under it.
//
// REPORTED, NEVER VERIFIED. The daemon is state-only: it performs no landing
// and never checks a receipt against git. Recording checks the shape of each
// field and that the candidate exists, nothing about the target itself, so a
// receipt is not independent proof that the bytes are where it says. Nor does
// it refuse a target other than the candidate's deliveryTarget: refusing a
// landing that already happened would leave a real ref move unrecorded, which
// is the one outcome this store must never produce.
//
// AT MOST ONE RECEIPT PER CANDIDATE, NEVER REWRITTEN. The candidate is the key,
// not a caller-chosen id, because a crash replay re-sends the same report with
// no id. A report for a candidate that already has a receipt either repeats it
// exactly, and the stored receipt comes back with NOTHING written, or it is
// refused by name (DELIVERY_RECEIPT_CONFLICT). Overwriting would erase the
// evidence of a second landing, which is exactly the failure a receipt exists
// to expose. Two receipts for one candidate, which only files placed on disk by
// hand can cause, make "did it land?" unanswerable, so the lookup and the
// recorder both refuse them (DELIVERY_RECEIPT_AMBIGUOUS). This module has NO
// update and NO delete function, and readers hand out copies.
//
// Follows the candidateStore / checkRunStore pattern: stateless functions taking
// the state handle first, and every mutation assumes THE CALLER HOLDS
// state.mutex. Tool dispatch provides it, and moe.record_delivery_receipt takes
// it itself. The store cannot enforce that alone: the one-per-candidate check
// reads the map and then awaits the write, so two unserialized reports could
// both find nothing and write two receipts. writeEntity runs BEFORE map.set, so
// a failed write publishes nothing and a crash cannot expose a receipt that is
// not on disk. No activity row and no emit: there is no consumer yet.

import type { StateManager } from './StateManager.js';
import type { DeliveryReceipt } from '../types/schema.js';
import { MoeError, MoeErrorCode, invalidInput, missingRequired } from '../util/errors.js';
import { generateId } from '../util/ids.js';
import { validateEntityId } from '../util/sanitize.js';
import { getCandidate, renderGot, REVISION_RE } from './candidateStore.js';

/** The longest push result a receipt keeps. A longer one is refused, never truncated, so the record stays verbatim. */
export const MAX_PUSH_RESULT_CHARS = 2000;

/** The bound candidateStore puts on a candidate's deliveryTarget, the ref a receipt's target names. */
const MAX_TARGET_CHARS = 255;

/** Every reported field besides candidateId, which the lookup itself matches, in contract order. */
const RECORDED_FIELDS = ['target', 'targetBefore', 'targetAfter', 'landedRevision', 'pushResult'] as const;

export interface RecordDeliveryReceiptParams {
  candidateId: string;
  target: string;
  targetBefore: string;
  targetAfter: string;
  landedRevision: string;
  /** Optional: absent and null both mean no push was required, and both are recorded as null. */
  pushResult?: string | null;
}

/** A report that passed validation: pushResult is present, and null when no push was required. */
export interface ValidDeliveryReceiptParams extends RecordDeliveryReceiptParams {
  pushResult: string | null;
}

export interface RecordDeliveryReceiptResult {
  receipt: DeliveryReceipt;
  /** True when the candidate's receipt already said exactly this: it was returned and nothing was written. */
  duplicate: boolean;
}

type RawReceiptParams = { [K in keyof RecordDeliveryReceiptParams]?: unknown };

/** Absent (undefined or null) is MISSING_REQUIRED; present but not a string is INVALID_INPUT. */
function requireString(field: string, value: unknown): string {
  if (value === undefined || value === null) throw missingRequired(field);
  if (typeof value !== 'string') throw invalidInput(field, `must be a string (got ${renderGot(value)})`);
  return value;
}

/** A reference to a stored entity: non-blank and a valid entity id, which also bounds its length. */
function requireEntityRef(field: string, value: unknown): string {
  const text = requireString(field, value);
  if (text.trim() === '') throw invalidInput(field, `must be a non-blank string (got ${renderGot(text)})`);
  return validateEntityId(text, field);
}

/** True when the text holds a C0 control character (0x00-0x1f) or DEL (0x7f). */
function hasControlChar(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/** The ref as reported, under the rules a candidate's deliveryTarget follows. */
function requireTarget(value: unknown): string {
  const field = 'target';
  const text = requireString(field, value);
  if (text.trim() === '') throw invalidInput(field, 'must be a non-blank string');
  if (text !== text.trim()) throw invalidInput(field, 'must not have leading or trailing whitespace');
  if (hasControlChar(text)) throw invalidInput(field, 'must not contain control characters');
  if (text.length > MAX_TARGET_CHARS) throw invalidInput(field, `must be ${MAX_TARGET_CHARS} characters or fewer`);
  return text;
}

/** Kept verbatim: a valid revision is never case-folded, so the record says exactly what was reported. */
function requireRevision(field: string, value: unknown): string {
  const text = requireString(field, value);
  if (!REVISION_RE.test(text)) {
    throw invalidInput(field, `must be 40 hexadecimal characters, as reported by the wrapper (got ${renderGot(text)})`);
  }
  return text;
}

/** Absent or null means no push was required. A present result is kept verbatim: never trimmed or truncated. */
function readPushResult(value: unknown): string | null {
  const field = 'pushResult';
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    throw invalidInput(field, `must be a string, or null when no push was required (got ${renderGot(value)})`);
  }
  if (value.trim() === '') throw invalidInput(field, 'must be a non-blank string, or null when no push was required');
  if (value.length > MAX_PUSH_RESULT_CHARS) {
    throw invalidInput(field, `must be ${MAX_PUSH_RESULT_CHARS} characters or fewer (got ${value.length})`);
  }
  return value;
}

/**
 * Validate a delivery report, refusing rather than coercing. Exported so the
 * record_delivery_receipt tool refuses malformed input with the rules this
 * store applies: one set of rules, not a second copy in the handler.
 */
export function validateDeliveryReceiptParams(raw: unknown): ValidDeliveryReceiptParams {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw invalidInput('receipt', `must be an object (got ${renderGot(raw)})`);
  }
  const fields = raw as RawReceiptParams;
  return {
    candidateId: requireEntityRef('candidateId', fields.candidateId),
    target: requireTarget(fields.target),
    targetBefore: requireRevision('targetBefore', fields.targetBefore),
    targetAfter: requireRevision('targetAfter', fields.targetAfter),
    landedRevision: requireRevision('landedRevision', fields.landedRevision),
    pushResult: readPushResult(fields.pushResult),
  };
}

const copy = (receipt: DeliveryReceipt): DeliveryReceipt => ({ ...receipt });

export function getDeliveryReceipt(state: StateManager, receiptId: string): DeliveryReceipt | null {
  const stored = state.receipts.get(receiptId);
  return stored ? copy(stored) : null;
}

/**
 * The receipt recorded for a candidate, or null when the candidate never landed.
 * A candidate lands at most once, so more than one receipt naming it is refused
 * rather than resolved: picking one would answer "did it land, and where?" with
 * a guess, and a guess is how a crash replay lands a second time.
 */
export function getDeliveryReceiptForCandidate(state: StateManager, candidateId: string): DeliveryReceipt | null {
  const matches = Array.from(state.receipts.values()).filter((receipt) => receipt.candidateId === candidateId);
  if (matches.length === 0) return null;
  if (matches.length > 1) {
    const receiptIds = matches.map((receipt) => receipt.id).sort();
    throw new MoeError(
      MoeErrorCode.STATE_CONFLICT,
      `Candidate ${candidateId} has ${matches.length} delivery receipts (${receiptIds.join(', ')}); ` +
        'a candidate lands at most once, so which receipt records its landing cannot be decided',
      { candidateId, receiptIds },
      'DELIVERY_RECEIPT_AMBIGUOUS'
    );
  }
  return copy(matches[0]);
}

/**
 * A report for a candidate that already has a receipt may only repeat it.
 * Identical in every reported field: the stored receipt comes back unchanged
 * (the crash replay). Any difference is refused and named, never written over,
 * because the stored receipt is the record of what already happened.
 */
function replayOrRefuse(stored: DeliveryReceipt, incoming: ValidDeliveryReceiptParams): DeliveryReceipt {
  const differingFields = RECORDED_FIELDS.filter((field) => stored[field] !== incoming[field]);
  if (differingFields.length === 0) return copy(stored);
  throw new MoeError(
    MoeErrorCode.STATE_CONFLICT,
    `Candidate ${stored.candidateId} already has delivery receipt ${stored.id}, which differs in ${differingFields.join(', ')}; ` +
      'a delivery receipt is never rewritten, so a report that contradicts it is refused',
    { candidateId: stored.candidateId, receiptId: stored.id, differingFields },
    'DELIVERY_RECEIPT_CONFLICT'
  );
}

/** A new receipt binds to a candidate the daemon knows; none is ever created on the caller's behalf. */
function assertCandidateExists(state: StateManager, candidateId: string): void {
  if (getCandidate(state, candidateId)) return;
  throw new MoeError(MoeErrorCode.NOT_FOUND, `Candidate not found: ${candidateId}`, { candidateId }, 'CANDIDATE_NOT_FOUND');
}

/**
 * Record a delivery receipt. The ORDER is the point, and every refusal writes nothing:
 *   1. validate without coercing (INVALID_INPUT / MISSING_REQUIRED);
 *   2. look for the candidate's receipt FIRST: refuse more than one
 *      (DELIVERY_RECEIPT_AMBIGUOUS), return an identical one with duplicate:true,
 *      refuse a contradicting one (DELIVERY_RECEIPT_CONFLICT). This runs before
 *      the candidate check so a replay always reconciles to a recorded landing;
 *   3. only then require the candidate (CANDIDATE_NOT_FOUND);
 *   4. persist BEFORE publishing. A failed write propagates with no receipt
 *      anywhere, so the caller retries instead of assuming the landing is recorded.
 */
export async function recordDeliveryReceipt(
  state: StateManager,
  params: RecordDeliveryReceiptParams
): Promise<RecordDeliveryReceiptResult> {
  const input = validateDeliveryReceiptParams(params);
  const stored = getDeliveryReceiptForCandidate(state, input.candidateId);
  if (stored) return { receipt: replayOrRefuse(stored, input), duplicate: true };
  assertCandidateExists(state, input.candidateId);

  const receipt: DeliveryReceipt = {
    id: generateId('receipt'),
    candidateId: input.candidateId,
    target: input.target,
    targetBefore: input.targetBefore,
    targetAfter: input.targetAfter,
    landedRevision: input.landedRevision,
    pushResult: input.pushResult,
  };
  // writeEntity validates the id against path traversal, creates .moe/receipts
  // itself and writes atomically (temp file + rename).
  await state.writeEntity('receipts', receipt.id, receipt);
  state.receipts.set(receipt.id, receipt);
  return { receipt: copy(receipt), duplicate: false };
}
