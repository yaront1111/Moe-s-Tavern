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
//     immutable, so it is judged in every status. WHICH check is owed is live
//     until DONE; qa_approve then binds it to task.requiredCheckAtDone, so a
//     later settings edit or epic reshape cannot change what a DONE task owes.
//   - PROTECTED REQUIRED CHECKS apply to a task whose executionContract declares
//     requiredChecks, in every status. Definitions and protected file identity
//     come only from the approved snapshot (readRequiredCheckSnapshot, bound to
//     the current definitions): the current candidate's runner-reported
//     protectedEntries must equal it (a changed, removed or added protected file
//     is held until a new approval revision re-measures it), and each approved
//     command needs its own passing run, matched exactly as the gate's.
//
// Which policy applies is per task (resolveTaskDeliveryPolicy): legacy and
// observe tasks keep the live settings.deliveryPolicy, and a strict task is
// refused until verified-local is certified.
//
// Fail closed: an unreadable record or failed lookup reports the evidence missing.
// Evaluation throws, rather than answers, when the task's policy cannot be
// applied: an unrecognised deliveryPolicy, a malformed execution-policy snapshot
// or executionProfile setting, or a strict task while verified-local is not
// ready. Reading any of those as the default would report unverified work as
// delivered. Recorded, not re-run: the daemon never runs the gate or checks
// records against git, so a record that misreports still counts.
//
// resolveDeliveryPolicy stays the single settings.deliveryPolicy authority. The
// vocabulary (DELIVERY_POLICIES, DEFAULT_DELIVERY_POLICY, isDeliveryPolicy) lives
// in executionProfile.ts so the snapshot decoder shares it without importing the
// evidence stores; it is re-exported here, and executionProfile.ts must never
// import this module.

import type { StateManager } from '../state/StateManager.js';
import type {
  Candidate, DeliveryPolicy, ExecutionPolicySnapshotV2, ProtectedCheckDefinition, Task, TaskCommit, TaskDeliveryEvidence,
} from '../types/schema.js';
import { MoeError, MoeErrorCode, invalidInput } from '../util/errors.js';
import { logger } from '../util/logger.js';
import { listCandidatesForTask, renderGot } from '../state/candidateStore.js';
import { listCheckRunsForCandidate } from '../state/checkRunStore.js';
import { validateExecutionContract } from '../state/validators.js';
import { protectedPaths, readRequiredCheckSnapshot } from './requiredChecks.js';
import {
  DEFAULT_DELIVERY_POLICY,
  DELIVERY_POLICIES,
  assertExecutionProfileReady,
  isDeliveryPolicy,
  readExecutionPolicySnapshot,
  resolveExecutionProfile,
  resolveTaskExecutionProfile,
} from './executionProfile.js';

export { DEFAULT_DELIVERY_POLICY, DELIVERY_POLICIES };

export type StrictDeliveryPolicy = Exclude<DeliveryPolicy, 'legacy'>;

/** The missing-evidence vocabulary. Consumers assert these exact strings, so only this module builds them. */
export const EVIDENCE_TOKENS = {
  completionCommit: 'completion-commit',
  pushedCompletionCommit: 'pushed-completion-commit',
  mergedPullRequest: 'merged-pull-request',
  manualArtifact: 'manual-artifact',
  /** A DONE task's requiredCheckAtDone is neither a command nor null, so the check it owes cannot be read. */
  unreadableRequiredCheck: 'unreadable-required-check',
  /** The task has protected required checks but no snapshot bound to its current definitions. */
  protectedChecksUnapproved: 'protected-checks-unapproved',
  /** The current candidate reports no readable protectedEntries, so drift cannot be judged. */
  protectedChecksUnmeasured: 'protected-checks-unmeasured',
} as const;

export const REQUIRED_CHECK_TOKEN_PREFIX = 'required-check:';
export const PROTECTED_CHECK_CHANGED_PREFIX = 'protected-check-changed:';
/** Changed-path tokens beyond this are summarised as `protected-check-changed:+<n> more`. */
const MAX_CHANGED_TOKENS = 10;

/** `protected-check-changed:<path>`: a protected path whose blob differs from, is missing from, or was added to the approved snapshot. */
export function protectedCheckChangedToken(path: string): string {
  return `${PROTECTED_CHECK_CHANGED_PREFIX}${path}`;
}

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

/**
 * The project's delivery policy. Absent or null means the default, so a project
 * created before this setting existed behaves exactly as before. Any other value
 * that is not a recognised policy is refused as invalid input — never coerced,
 * never read as the default — so a misspelled strict policy fails loudly.
 */
export function resolveDeliveryPolicy(settings: { deliveryPolicy?: unknown } | null | undefined): DeliveryPolicy {
  const raw = settings?.deliveryPolicy;
  if (raw === undefined || raw === null) return DEFAULT_DELIVERY_POLICY;
  if (isDeliveryPolicy(raw)) return raw;
  throw invalidInput('deliveryPolicy', `must be one of ${DELIVERY_POLICIES.join(', ')} (got ${renderGot(raw)})`);
}

/**
 * The delivery policy that applies to `task`: the one selection qa_approve and
 * evaluateDeliveryEvidence share. Strictness is decided exactly as the CQ-M01c
 * store backstop and CQ-M01e claim admission decide it: the live profile,
 * floored by a stored verified-local snapshot (stale revision or not). A strict
 * task throws EXECUTION_PROFILE_NOT_READY before any policy is read, so neither
 * the live policy, an attestation nor an absent captured policy can stand in for
 * the proof it owes. Legacy and observe tasks get the LIVE resolveDeliveryPolicy;
 * a captured deliveryPolicy is identity only and never consulted. A malformed
 * snapshot or setting throws INVALID_INPUT. Pure: reads only.
 */
export function resolveTaskDeliveryPolicy(
  settings: { executionProfile?: unknown; deliveryPolicy?: unknown } | null | undefined,
  task: Pick<Task, 'executionPolicySnapshot'>,
): DeliveryPolicy {
  assertExecutionProfileReady(resolveTaskExecutionProfile(settings, task.executionPolicySnapshot));
  return resolveDeliveryPolicy(settings);
}

/**
 * Configuration provenance only: the live profile and deliveryPolicy, captured
 * with the caller's canonical Task.planRevision (never derived or defaulted here).
 * Not approval, readiness or delivery evidence: pure, no state, no readiness
 * assertion. Malformed settings or revision throw the existing INVALID_INPUT.
 */
export function captureExecutionPolicySnapshot(
  settings: { executionProfile?: unknown; deliveryPolicy?: unknown } | null | undefined,
  planRevision: number,
): ExecutionPolicySnapshotV2 {
  const captured = { version: 2, profile: resolveExecutionProfile(settings), planRevision, deliveryPolicy: resolveDeliveryPolicy(settings) };
  return readExecutionPolicySnapshot(captured) as ExecutionPolicySnapshotV2;
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
 * on the epic-final task. Read live; qa_approve snapshots it as requiredCheckAtDone.
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
 * tree, of `command`, exit 0, reported as runner-observed. A lookup failure is
 * logged and answers false.
 *
 * `command` is the trimmed setting, and the recorded command is trimmed before the
 * compare. Both wrappers trim settings.qualityGate before they run and record it,
 * but a padded command can still reach this compare: a run the ps1 wrapper recorded
 * before task-8fc35d31, a run from an older wrapper an IDE plugin still bundles,
 * or a direct moe.record_check_run call (checkRunStore keeps `command` as sent).
 * Trimming is safe: no shell sees the padding a hand-edited project.json can carry.
 */
function hasPassingCheck(state: StateManager, taskId: string, command: string): boolean {
  try {
    const candidates = listCandidatesForTask(state, taskId);
    return passedOn(state, candidates[candidates.length - 1], command);
  } catch (err) {
    logger.warn({ err, taskId }, 'Delivery policy: check evidence unreadable; reporting it missing');
    return false;
  }
}

/** The one passing-run match, shared by the quality gate and protected required checks. May throw. */
function passedOn(state: StateManager, current: Candidate | undefined, command: string): boolean {
  if (!current || typeof current.treeSha !== 'string' || current.treeSha === '') return false;
  return listCheckRunsForCandidate(state, current.id).some((run) =>
    run.candidateId === current.id && run.treeSha === current.treeSha &&
    typeof run.command === 'string' && run.command.trim() === command &&
    run.exitCode === 0 && run.source === 'runner-observed');
}

/** True for a path that is, or lies under, one of the protected paths. Exact and case-sensitive, like git. */
function underProtected(roots: readonly string[], file: string): boolean {
  return roots.some((root) => file === root || file.startsWith(`${root}/`));
}

/**
 * Changed-path tokens: every protected path whose candidate oid differs from the
 * approved snapshot, that the candidate lacks, or that the candidate ADDED (a new
 * test under an assertion root). Null when the candidate's entries are unreadable.
 */
function protectedDrift(roots: readonly string[], approved: readonly { path: string; oid: string }[], reported: unknown): string[] | null {
  if (!Array.isArray(reported)) return null;
  const candidate = new Map<string, string>();
  for (const entry of reported as unknown[]) {
    const { path, oid } = (entry ?? {}) as { path?: unknown; oid?: unknown };
    if (typeof path !== 'string' || typeof oid !== 'string' || candidate.has(path)) return null;
    if (underProtected(roots, path)) candidate.set(path, oid);
  }
  const approvedMap = new Map(approved.map((e) => [e.path, e.oid]));
  const paths = [...new Set([...approvedMap.keys(), ...candidate.keys()])]
    .filter((p) => approvedMap.get(p) !== candidate.get(p))
    .sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  const tokens = paths.slice(0, MAX_CHANGED_TOKENS).map(protectedCheckChangedToken);
  if (paths.length > MAX_CHANGED_TOKENS) tokens.push(protectedCheckChangedToken(`+${paths.length - MAX_CHANGED_TOKENS} more`));
  return tokens;
}

/**
 * Protected required checks (executionContract.requiredChecks). The definitions and
 * the files they protect come ONLY from the approved snapshot (readRequiredCheckSnapshot),
 * never from candidate data or live settings. The current candidate's runner-reported
 * protectedEntries must equal the snapshot, and each approved command needs its own
 * passing run on that candidate's tree: another command never stands in for it.
 */
function protectedCheckShortfall(state: StateManager, task: Task): string[] {
  // Only a declared requiredChecks is judged: other contract damage keeps today's verdict.
  if ((task.executionContract as { requiredChecks?: unknown } | null | undefined)?.requiredChecks === undefined) return [];
  let defs: readonly ProtectedCheckDefinition[];
  try {
    defs = validateExecutionContract(task.executionContract)?.requiredChecks ?? [];
  } catch (err) {
    logger.warn({ err, taskId: task.id }, 'Delivery policy: requiredChecks unreadable; reporting them unapproved');
    return [EVIDENCE_TOKENS.protectedChecksUnapproved];
  }
  if (defs.length === 0) return [];
  const snapshot = readRequiredCheckSnapshot(task);
  if (!snapshot) return [EVIDENCE_TOKENS.protectedChecksUnapproved];
  // Trimmed like qualityGate: the validator keeps padding no shell would see.
  const owed = (passed: (command: string) => boolean) =>
    [...new Set(defs.map((d) => d.command.trim()))].filter((c) => !passed(c)).map(requiredCheckToken);
  try {
    const candidates = listCandidatesForTask(state, task.id);
    const current = candidates[candidates.length - 1];
    const roots = protectedPaths(defs).map((p) => p.path);
    const drift = current ? protectedDrift(roots, snapshot.entries, current.protectedEntries) : null;
    return [...(drift ?? [EVIDENCE_TOKENS.protectedChecksUnmeasured]), ...owed((c) => passedOn(state, current, c))];
  } catch (err) {
    logger.warn({ err, taskId: task.id }, 'Delivery policy: protected check evidence unreadable; reporting it missing');
    return [EVIDENCE_TOKENS.protectedChecksUnmeasured, ...owed(() => false)];
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
 * The required-check token `task` is missing, or none. Until DONE the check owed
 * is the live requiredCheckCommand. A DONE or ARCHIVED task owes what qa_approve
 * snapshotted (requiredCheckAtDone: a command, or null for none); one without a
 * snapshot falls back to the live rule. A snapshot of any other type is logged
 * and reported missing: fail closed, never read as none owed.
 */
function checkShortfall(state: StateManager, task: Task): string[] {
  const snapshot: unknown = task.requiredCheckAtDone;
  let command: string | null;
  if (!LANDING_JUDGED.has(task.status) || snapshot === undefined) {
    command = requiredCheckCommand(state, task);
  } else if (snapshot === null || typeof snapshot === 'string') {
    command = snapshot?.trim() || null;
  } else {
    logger.warn({ taskId: task.id, snapshot: renderGot(snapshot) }, 'Delivery policy: requiredCheckAtDone unreadable; reporting the check missing');
    return [EVIDENCE_TOKENS.unreadableRequiredCheck];
  }
  return command !== null && !hasPassingCheck(state, task.id, command) ? [requiredCheckToken(command)] : [];
}

/**
 * Whether `task` satisfies its delivery policy (resolveTaskDeliveryPolicy), and
 * exactly which evidence is missing. A plain predicate over any task: pass
 * `attestations` only when judging an approval that supplies them. Throws rather
 * than answers when the task's policy cannot be applied: an unrecognised
 * deliveryPolicy, a malformed snapshot or setting, or a strict task while
 * verified-local is not ready. Every consumer reads that throw as not satisfied:
 * isDependencySatisfied withholds, describeUnmetDependency names it unjudgeable,
 * deliveryProjection omits requiredCheckSatisfied, and qa_approve refuses before
 * any write.
 */
export function evaluateDeliveryEvidence(state: StateManager, task: Task, attestations: DeliveryAttestations = {}): DeliveryEvidenceResult {
  const policy = resolveTaskDeliveryPolicy(state.project?.settings, task);
  if (policy === 'legacy') return { policy, satisfied: true, missingEvidence: [] };
  const landing = LANDING_JUDGED.has(task.status) ? [] : landingShortfall(policy, task, attestations);
  // First-seen order: a command both qualityGate and a protected check owe appears once.
  const missingEvidence = [...new Set([...landing, ...checkShortfall(state, task), ...protectedCheckShortfall(state, task)])];
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
  [EVIDENCE_TOKENS.unreadableRequiredCheck, 'task.requiredCheckAtDone is neither a command nor null, so the check owed at DONE cannot be judged'],
  [EVIDENCE_TOKENS.protectedChecksUnapproved, 'executionContract.requiredChecks has no approved snapshot bound to its current definitions; moe.submit_plan measures one'],
  [EVIDENCE_TOKENS.protectedChecksUnmeasured, 'the current candidate reports no readable protectedEntries, so its protected check files cannot be compared with the approved snapshot'],
]);

/** A readable reason for one missing-evidence token. */
export function describeMissingEvidence(token: string): string {
  if (token.startsWith(REQUIRED_CHECK_TOKEN_PREFIX)) {
    const command = token.slice(REQUIRED_CHECK_TOKEN_PREFIX.length);
    return `no runner-observed exit-0 run of "${command}" is recorded for the current candidate's tree`;
  }
  if (token.startsWith(PROTECTED_CHECK_CHANGED_PREFIX)) {
    return 'a protected check file differs from the approved snapshot (changed, removed or added); only a new approval revision that re-measures it accepts the change';
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
