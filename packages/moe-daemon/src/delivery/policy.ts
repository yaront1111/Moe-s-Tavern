// =============================================================================
// Delivery policy — what DONE requires, and whether a task's evidence meets it
// =============================================================================
//
// The single authority for settings.deliveryPolicy, and a plain predicate over
// ANY task: moe.qa_approve asks about the task being approved, the dependency
// gate asks about a PREREQUISITE. Both use the token vocabulary built here, so
// neither hand-writes a token and the two cannot disagree.
//
// Two requirements, judged at different times:
//   - LANDING evidence is what the policy names: a completion commit recorded for
//     the review round, one recorded as pushed, an attested merged pull request or
//     an attested manual artifact. It is a DONE-transition requirement, judged
//     for every task not yet DONE or ARCHIVED; the ledger of a finished round is
//     history. (A task moved to DONE outside qa_approve skipped that judgement.)
//   - The REQUIRED CHECK applies when the wrapper would run settings.qualityGate
//     for the task: a CheckRun on the CURRENT candidate, on that candidate's own
//     tree, of the gate command, exit 0, runner-observed. Those records are
//     immutable, so it is judged in every status.
//
// Fail closed: an unreadable record or failed lookup reports the evidence missing.
// The one throw is an unrecognised deliveryPolicy, because reading it as the
// default would report unverified work as delivered. Recorded, not re-run: the
// daemon never runs git or the gate, so a record that misreports still counts.

import type { StateManager } from '../state/StateManager.js';
import type { DeliveryPolicy, Task, TaskCommit, TaskDeliveryEvidence } from '../types/schema.js';
import { MoeError, MoeErrorCode, invalidInput } from '../util/errors.js';
import { logger } from '../util/logger.js';
import { listCandidatesForTask } from '../state/candidateStore.js';
import { listCheckRunsForCandidate } from '../state/checkRunStore.js';

/** Keyed by the type, so the recognised list cannot drift from DeliveryPolicy without a compile error. */
const POLICIES: Record<DeliveryPolicy, true> = {
  legacy: true,
  'local-branch': true,
  'remote-push': true,
  'merged-pull-request': true,
  'manual-artifact': true,
};

/** Every recognised deliveryPolicy, in documentation order. */
export const DELIVERY_POLICIES = Object.keys(POLICIES) as DeliveryPolicy[];

/** What an absent or null setting means: the soft NO-COMPLETION-COMMIT warning, approval always lands. */
export const DEFAULT_DELIVERY_POLICY: DeliveryPolicy = 'legacy';

export type StrictDeliveryPolicy = Exclude<DeliveryPolicy, 'legacy'>;

/** The missing-evidence vocabulary. Consumers assert these exact strings, so only this module builds them. */
export const EVIDENCE_TOKENS = {
  completionCommit: 'completion-commit',
  pushedCompletionCommit: 'pushed-completion-commit',
  mergedPullRequest: 'merged-pull-request',
  manualArtifact: 'manual-artifact',
} as const;

export const REQUIRED_CHECK_TOKEN_PREFIX = 'required-check:';

/** `required-check:<command>`, the command exactly as the wrapper runs it (the trimmed qualityGate). */
export function requiredCheckToken(command: string): string {
  return `${REQUIRED_CHECK_TOKEN_PREFIX}${command}`;
}

/** qa_approve's refusal codeName. -32003, like the dependency gate's DEPENDENCY_EVIDENCE_MISSING. */
export const DELIVERY_EVIDENCE_MISSING = 'DELIVERY_EVIDENCE_MISSING';

/** Bound on an attested reference: the same bound complete_task and CheckRun put on a command. */
export const MAX_ATTESTATION_CHARS = 500;

/** Evidence a reviewer supplies with an approval. Each one satisfies exactly one policy. */
export interface DeliveryAttestations {
  /** A deliverable checked by hand. Satisfies manual-artifact and nothing else. */
  manualArtifact?: string;
  /** A pull request declared merged. Satisfies merged-pull-request and nothing else. */
  mergedPullRequest?: string;
}

export interface DeliveryEvidenceResult {
  policy: DeliveryPolicy;
  satisfied: boolean;
  /** Tokens for exactly what is missing, landing first, then the required check; [] when satisfied. */
  missingEvidence: string[];
}

/** Bounded rendering of an untrusted value: it cannot throw and cannot flood a message. */
function renderGot(value: unknown): string {
  if (value === null) return 'null';
  const kind = typeof value;
  if (kind === 'object' || kind === 'function' || kind === 'symbol') return `a value of type ${kind}`;
  const text = kind === 'string' ? JSON.stringify(value) : String(value);
  return text.length > 40 ? `${text.slice(0, 40)}…` : text;
}

/**
 * The project's delivery policy. Absent or null means the default, so a project
 * created before this setting existed behaves exactly as before. Any other value
 * that is not a recognised policy is refused as invalid input — never coerced,
 * never read as the default — so a misspelled strict policy fails loudly.
 */
export function resolveDeliveryPolicy(settings: { deliveryPolicy?: unknown } | null | undefined): DeliveryPolicy {
  const raw = settings?.deliveryPolicy;
  if (raw === undefined || raw === null) return DEFAULT_DELIVERY_POLICY;
  if (typeof raw === 'string' && Object.prototype.hasOwnProperty.call(POLICIES, raw)) return raw as DeliveryPolicy;
  throw invalidInput('deliveryPolicy', `must be one of ${DELIVERY_POLICIES.join(', ')} (got ${renderGot(raw)})`);
}

/**
 * Completion commits recorded for the task's CURRENT work round: at or after the
 * round's start (the most recent rejection, else the first step start, else
 * reviewStartedAt - see the comment in the body), so a stale earlier-attempt
 * commit never satisfies a later review. Both ISO strings come from
 * toISOString(), so the lexicographic compare is exact. A malformed ledger entry
 * counts for nothing. qa_approve's soft commit gate and the strict delivery
 * policies both count through this one function, so they can never disagree.
 */
export function completionCommitsForReview(
  task: Pick<Task, 'commits' | 'reviewStartedAt' | 'workStartedAt' | 'rejectionHistory'>,
): TaskCommit[] {
  const commits: unknown[] = Array.isArray(task.commits) ? task.commits : [];
  // Anchor on the start of the CURRENT work round, not reviewStartedAt. A worker
  // that commits by hand calls record_commit BEFORE complete_task stamps
  // reviewStartedAt, so a reviewStartedAt anchor misses a commit sitting right
  // there in task.commits. The most recent rejection opens a reopened round
  // (rejectionHistory is newest-first and survives the reopen), else the first
  // step start; reviewStartedAt stays the last resort for a legacy row with
  // neither marker, so it never silently accepts an ancient commit.
  const since = task.rejectionHistory?.[0]?.rejectedAt || task.workStartedAt || task.reviewStartedAt;
  return commits.filter((entry): entry is TaskCommit => {
    if (entry === null || typeof entry !== 'object') return false;
    const commit = entry as Partial<TaskCommit>;
    return commit.kind === 'completion' && (!since || (typeof commit.recordedAt === 'string' && commit.recordedAt >= since));
  });
}

/**
 * Epic-final exactly as get_context computes it (tools/getContext.ts), which is
 * what the wrapper uses to decide whether an epicFinal-scoped gate runs: the
 * highest `order` among the epic's non-ARCHIVED tasks, ties counting, and a task
 * without an epic counting as final. A test pins the two against each other.
 */
export function isEpicFinalTask(state: StateManager, task: Task): boolean {
  if (!task.epicId) return true;
  const own = task.order ?? 0;
  const orders = Array.from(state.tasks.values())
    .filter((t) => t.epicId === task.epicId && t.status !== 'ARCHIVED')
    .map((t) => (typeof t.order === 'number' && Number.isFinite(t.order) ? t.order : 0));
  return own >= Math.max(own, ...orders);
}

/**
 * The gate command a strict policy requires a passing check of, or null when the
 * wrapper would run no gate for this task: the policy must never demand a check
 * no runner produces. Mirrors scripts/moe-agent.{sh,ps1}: the gate runs only on a
 * completion landing (never with autoCommit false), only for a non-blank
 * qualityGate (trimmed), and, unless qualityGateScope is exactly 'everyTask', only
 * on the epic-final task.
 */
export function requiredCheckCommand(state: StateManager, task: Task): string | null {
  const settings: { autoCommit?: unknown; qualityGate?: unknown; qualityGateScope?: unknown } | undefined =
    state.project?.settings;
  if (settings?.autoCommit === false) return null;
  const gate = typeof settings?.qualityGate === 'string' ? settings.qualityGate.trim() : '';
  if (gate === '') return null;
  if (settings?.qualityGateScope !== 'everyTask' && !isEpicFinalTask(state, task)) return null;
  return gate;
}

/**
 * True only for a run on the task's CURRENT candidate (last by createdAt then id,
 * the rule get_context and the review binding share), on that candidate's own
 * tree, of exactly `command`, exit 0, reported as runner-observed. A lookup
 * failure is logged and answers false.
 */
function hasPassingCheck(state: StateManager, taskId: string, command: string): boolean {
  try {
    const candidates = listCandidatesForTask(state, taskId);
    const current = candidates[candidates.length - 1];
    if (!current || typeof current.treeSha !== 'string' || current.treeSha === '') return false;
    return listCheckRunsForCandidate(state, current.id).some((run) =>
      run.candidateId === current.id && run.treeSha === current.treeSha && run.command === command &&
      run.exitCode === 0 && run.source === 'runner-observed');
  } catch (err) {
    logger.warn({ err, taskId }, 'Delivery policy: check evidence unreadable; reporting it missing');
    return false;
  }
}

function hasText(value: string | undefined): boolean {
  return typeof value === 'string' && value.trim() !== '';
}

/** The landing token a strict policy is missing for a task that has not reached DONE, or none. */
function landingShortfall(policy: StrictDeliveryPolicy, task: Task, attested: DeliveryAttestations): string[] {
  switch (policy) {
    case 'local-branch':
      return completionCommitsForReview(task).length > 0 ? [] : [EVIDENCE_TOKENS.completionCommit];
    case 'remote-push':
      return completionCommitsForReview(task).some((c) => c.pushed === true) ? [] : [EVIDENCE_TOKENS.pushedCompletionCommit];
    case 'merged-pull-request':
      return hasText(attested.mergedPullRequest) ? [] : [EVIDENCE_TOKENS.mergedPullRequest];
    case 'manual-artifact':
      return hasText(attested.manualArtifact) ? [] : [EVIDENCE_TOKENS.manualArtifact];
    default: {
      const unknownPolicy: never = policy;
      throw new Error(`Unhandled delivery policy: ${String(unknownPolicy)}`);
    }
  }
}

/** Statuses whose landing evidence was already judged at the DONE transition. */
const LANDING_JUDGED: ReadonlySet<string> = new Set(['DONE', 'ARCHIVED']);

/**
 * Whether `task` satisfies the project's delivery policy, and exactly which
 * evidence is missing. A plain predicate over any task: pass `attestations` only
 * when judging an approval that supplies them. Throws only for an unrecognised
 * deliveryPolicy.
 */
export function evaluateDeliveryEvidence(state: StateManager, task: Task, attestations: DeliveryAttestations = {}): DeliveryEvidenceResult {
  const policy = resolveDeliveryPolicy(state.project?.settings);
  if (policy === 'legacy') return { policy, satisfied: true, missingEvidence: [] };
  const landing = LANDING_JUDGED.has(task.status) ? [] : landingShortfall(policy, task, attestations);
  const command = requiredCheckCommand(state, task);
  const check = command !== null && !hasPassingCheck(state, task.id, command) ? [requiredCheckToken(command)] : [];
  const missingEvidence = [...landing, ...check];
  return { policy, satisfied: missingEvidence.length === 0, missingEvidence };
}

/** Which policy each attestation input can satisfy. */
const ATTESTATION_POLICY: Record<keyof DeliveryAttestations, StrictDeliveryPolicy> = {
  manualArtifact: 'manual-artifact',
  mergedPullRequest: 'merged-pull-request',
};

/**
 * Read qa_approve's attestation inputs, refusing rather than coercing. null counts
 * as omitted. A present value must be a non-blank string of at most
 * MAX_ATTESTATION_CHARS, and it is accepted only under the one policy it can
 * satisfy, so an attestation that would count for nothing is never recorded as if
 * it mattered. Returned trimmed.
 */
export function readDeliveryAttestations(raw: { manualArtifact?: unknown; mergedPullRequest?: unknown }, policy: DeliveryPolicy): DeliveryAttestations {
  const read: DeliveryAttestations = {};
  for (const field of Object.keys(ATTESTATION_POLICY) as Array<keyof DeliveryAttestations>) {
    const value = raw[field];
    if (value === undefined || value === null) continue;
    if (typeof value !== 'string' || value.trim() === '') {
      throw invalidInput(field, `must be a non-blank string (got ${renderGot(value)})`);
    }
    if (value.length > MAX_ATTESTATION_CHARS) {
      throw invalidInput(field, `must be ${MAX_ATTESTATION_CHARS} characters or fewer (got ${value.length})`);
    }
    if (policy !== ATTESTATION_POLICY[field]) {
      throw invalidInput(field, `is accepted only under deliveryPolicy ${ATTESTATION_POLICY[field]} (this project uses ${policy})`);
    }
    read[field] = value.trim();
  }
  return read;
}

/**
 * The label qa_approve persists when DONE rests on an attestation instead of
 * recorded code delivery, or undefined when it does not. Never verified:
 * verifiedDelivery is the literal false.
 */
export function attestationLabel(policy: DeliveryPolicy, attested: DeliveryAttestations, recordedBy: string, recordedAt: string): TaskDeliveryEvidence | undefined {
  if (policy === 'manual-artifact' && attested.manualArtifact !== undefined) {
    return { kind: 'manual-artifact', reference: attested.manualArtifact, verifiedDelivery: false, recordedBy, recordedAt };
  }
  if (policy === 'merged-pull-request' && attested.mergedPullRequest !== undefined) {
    return { kind: 'merged-pull-request', reference: attested.mergedPullRequest, verifiedDelivery: false, recordedBy, recordedAt };
  }
  return undefined;
}

const TOKEN_REASONS = new Map<string, string>([
  [EVIDENCE_TOKENS.completionCommit, 'no completion commit is recorded for this review round; the wrapper lands it seconds after REVIEW, so retry once task.commits shows it'],
  [EVIDENCE_TOKENS.pushedCompletionCommit, 'no completion commit recorded for this review round is marked pushed; a commit that never reached the remote does not count'],
  [EVIDENCE_TOKENS.mergedPullRequest, 'no merged pull request was attested; pass mergedPullRequest naming it'],
  [EVIDENCE_TOKENS.manualArtifact, 'no manual artifact was attested; pass manualArtifact naming the deliverable you checked'],
]);

/** A readable reason for one missing-evidence token. */
export function describeMissingEvidence(token: string): string {
  if (token.startsWith(REQUIRED_CHECK_TOKEN_PREFIX)) {
    const command = token.slice(REQUIRED_CHECK_TOKEN_PREFIX.length);
    return `no runner-observed exit-0 run of "${command}" is recorded for the current candidate's tree`;
  }
  return TOKEN_REASONS.get(token) ?? 'unrecognised evidence token';
}

/**
 * qa_approve's refusal when a strict policy is not met. The context carries the
 * tokens; MoeError.context never crosses the MCP wire, so the message names each
 * token and its reason as well.
 */
export function deliveryEvidenceRefusal(taskId: string, result: DeliveryEvidenceResult, autoCommitOn: boolean): MoeError {
  const { policy, missingEvidence } = result;
  const reasons = missingEvidence.map((token) => `${token} (${describeMissingEvidence(token)})`).join(', ');
  const commitShaped = missingEvidence.some((t) => t === EVIDENCE_TOKENS.completionCommit || t === EVIDENCE_TOKENS.pushedCompletionCommit);
  const autoCommitNote = !autoCommitOn && commitShaped
    ? '. settings.autoCommit is false, so the wrapper will record no commit: use deliveryPolicy manual-artifact for work delivered by hand'
    : '';
  return new MoeError(
    MoeErrorCode.CONSTRAINT_VIOLATION,
    `Task ${taskId} cannot move to DONE under deliveryPolicy ${policy}: missing delivery evidence ${reasons}${autoCommitNote}`,
    { taskId, deliveryPolicy: policy, missingEvidence },
    DELIVERY_EVIDENCE_MISSING
  );
}
