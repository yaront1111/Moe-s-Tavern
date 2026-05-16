// =============================================================================
// Verification evidence — shape checks for complete_task / qa_approve summaries
// =============================================================================
//
// The single biggest lever for "agents finish tasks well without babysitting"
// is forcing them to PROVE what they did. Before this util, both
// complete_task and qa_approve accepted any string (or none) as a summary,
// so a worker could ship "all good" and a QA could approve "looks fine".
// Now the daemon refuses anything that doesn't look like real verification
// output — a command run, a test count, a build result, an inspected file.
//
// The bar is intentionally moderate: shape checks catch the embarrassing
// failure modes (placeholders, one-word summaries) without trying to
// adjudicate whether the worker actually understood what they verified.
// QA is the semantic gate; this util is the syntactic floor.

import { MoeError, MoeErrorCode } from './errors.js';

export const MIN_COMPLETE_TASK_EVIDENCE = 80;
export const MIN_QA_APPROVE_EVIDENCE = 60;
export const MAX_EVIDENCE_LEN = 8000;

/**
 * Lower-cased placeholder phrases the daemon refuses as "evidence". When the
 * normalized text equals one of these or starts with one followed only by
 * punctuation/whitespace, we reject. We don't fuzzy-match inside longer text
 * because a real summary may legitimately include phrases like "everything
 * passed" alongside concrete commands.
 */
const PLACEHOLDER_PHRASES: readonly string[] = [
  'n/a',
  'na',
  'done',
  'ok',
  'okay',
  'lgtm',
  'looks good',
  'looks fine',
  'all good',
  'all done',
  'tests pass',
  'all tests pass',
  'everything passes',
  'verified',
  'approved',
  'qa approved',
  'qa: pass',
  'pass',
  'no issues',
];

/**
 * Heuristic markers that suggest the caller actually ran something. We don't
 * require ALL of these — any one indicates the text isn't a pure platitude.
 * Backticks and slashes catch quoted commands / file paths; digits catch test
 * counts (`554/554 passed`, `0 errors`); keywords cover the verbs that
 * legitimate evidence almost always uses.
 */
const EVIDENCE_MARKERS_RE = /[`/]|\d|\b(ran|run|build|tested|tests?|passed|failed|pass:|fail:|exit\b|stdout|stderr|output|coverage|lint|typecheck|diff|reviewed|inspected|verified that|confirmed)\b/i;

/**
 * Validate an evidence string for completeTask / qaApprove. Throws MoeError
 * with a teaching nextAction when the evidence is missing, too short, a
 * placeholder, or lacks any concrete-execution markers. Returns the
 * normalized (trimmed + clamped) evidence on success.
 */
export function validateVerificationEvidence(
  rawEvidence: unknown,
  caller: 'complete_task' | 'qa_approve',
  fallback?: unknown,
): string {
  const minLen = caller === 'complete_task' ? MIN_COMPLETE_TASK_EVIDENCE : MIN_QA_APPROVE_EVIDENCE;
  const fieldName = caller === 'complete_task' ? 'verificationEvidence' : 'verifiedEvidence';

  // Allow `summary` to act as the evidence carrier for back-compat. Callers
  // can pass either field; we prefer the explicit one when both are set.
  let candidate: unknown = rawEvidence;
  if (candidate === undefined || candidate === null || candidate === '') {
    candidate = fallback;
  }

  if (candidate === undefined || candidate === null) {
    throw new MoeError(
      MoeErrorCode.MISSING_REQUIRED,
      `${caller} requires ${fieldName}: describe what you ran and the result. ` +
      `Example: "Ran \`cd packages/moe-daemon && npm test\` — 554/554 passed in 10.5s. ` +
      `Ran \`npm run build\` — clean. Manually exercised the new tool: amend_plan_step ` +
      `succeeds for governor, rejects worker, hits cap at 10 amendments."`,
      { field: fieldName, caller },
      'MISSING_REQUIRED'
    );
  }
  if (typeof candidate !== 'string') {
    throw new MoeError(
      MoeErrorCode.INVALID_INPUT,
      `${fieldName} must be a string`,
      { field: fieldName, caller },
      'INVALID_INPUT'
    );
  }
  const trimmed = candidate.trim();
  if (trimmed.length === 0) {
    throw new MoeError(
      MoeErrorCode.MISSING_REQUIRED,
      `${caller} requires non-empty ${fieldName}. Describe what you ran and the result.`,
      { field: fieldName, caller },
      'MISSING_REQUIRED'
    );
  }
  if (trimmed.length < minLen) {
    throw new MoeError(
      MoeErrorCode.INVALID_INPUT,
      `${fieldName} too short (${trimmed.length} chars, min ${minLen}). ` +
      `Show the actual command and result, not a one-liner. ` +
      `Example: "Ran \`npm test\` — 554/554 passed. Ran \`npm run build\` — clean. Inspected the diff at <path>."`,
      { field: fieldName, caller, length: trimmed.length, minLength: minLen },
      'INVALID_INPUT'
    );
  }
  if (trimmed.length > MAX_EVIDENCE_LEN) {
    throw new MoeError(
      MoeErrorCode.INVALID_INPUT,
      `${fieldName} too long (${trimmed.length} chars, max ${MAX_EVIDENCE_LEN}). Summarize.`,
      { field: fieldName, caller, length: trimmed.length, maxLength: MAX_EVIDENCE_LEN },
      'INVALID_INPUT'
    );
  }
  const lowered = trimmed.toLowerCase();
  for (const phrase of PLACEHOLDER_PHRASES) {
    if (lowered === phrase) {
      throw new MoeError(
        MoeErrorCode.INVALID_INPUT,
        `${fieldName} ("${trimmed.slice(0, 60)}") looks like a placeholder. ` +
        `Show what command you ran and what it returned. ` +
        `Example: "Ran \`npm test\` — 554/554 passed. Ran \`npm run build\` — clean."`,
        { field: fieldName, caller, placeholder: phrase },
        'INVALID_INPUT'
      );
    }
    // Match "all good." / "lgtm!" / "verified." (placeholder + trailing punct/space)
    if (lowered.length <= phrase.length + 3 && lowered.startsWith(phrase)) {
      const tail = lowered.slice(phrase.length);
      if (/^[\s.!?,;:'"-]*$/.test(tail)) {
        throw new MoeError(
          MoeErrorCode.INVALID_INPUT,
          `${fieldName} ("${trimmed.slice(0, 60)}") looks like a placeholder. ` +
          `Show what command you ran and what it returned.`,
          { field: fieldName, caller, placeholder: phrase },
          'INVALID_INPUT'
        );
      }
    }
  }
  if (!EVIDENCE_MARKERS_RE.test(trimmed)) {
    throw new MoeError(
      MoeErrorCode.INVALID_INPUT,
      `${fieldName} doesn't reference any concrete verification — no command, file path, ` +
      `numeric result, or verb like "ran"/"tested"/"verified"/"inspected". ` +
      `Show the actual command and result.`,
      { field: fieldName, caller, length: trimmed.length },
      'INVALID_INPUT'
    );
  }
  return trimmed;
}
