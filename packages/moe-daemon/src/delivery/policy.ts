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
//   - STRONG (CQ-V04, verified-local tasks only; unreachable until certified):
//     a required check counts only through trustedPassedOn, an authenticated
//     observation (isAuthenticatedCheckRun, never a moe.record_check_run report)
//     with outcome exactly passed, at the current approved revision, in an
//     environment settings.checkEnvironments lists (read live, so removing an id
//     revokes its evidence), bound to a dispatch naming that check. Each protected
//     definition needs its own dispatch. owedChecks is the frozen list such a task
//     owes; assertCheckDispatchApproved admits only those dispatches. A strong
//     task that owes nothing reports required-checks-undeclared. An architecture
//     check not in the installed form, whether a definition or the gate owes it,
//     runs code the candidate builds, so it never delivers
//     (required-check-untrusted-checker, task-efbf1742). This holds
//     under every deliveryPolicy, legacy (set, absent or null) included: legacy
//     adds no landing evidence and never excuses the checks (task-43088e9b).
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
import { hasControlChar, listCandidatesForTask, renderGot } from '../state/candidateStore.js';
import { listCheckRunsForCandidate } from '../state/checkRunStore.js';
import { getCheckDispatch, isAuthenticatedCheckRun } from '../state/checkObservationStore.js';
import { validateExecutionContract } from '../state/validators.js';
import { protectedPaths, readRequiredCheckSnapshot, untrustedArchitectureChecks } from './requiredChecks.js';
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
  /** A verified-local task owes no required check: no requiredChecks declared and no gate owed. */
  requiredChecksUndeclared: 'required-checks-undeclared',
} as const;

export const REQUIRED_CHECK_TOKEN_PREFIX = 'required-check:';
export const PROTECTED_CHECK_CHANGED_PREFIX = 'protected-check-changed:';
export const UNTRUSTED_CHECKER_PREFIX = 'required-check-untrusted-checker:';
/** The untrusted-checker id for settings.qualityGate. No definition id can take it: ids start alphanumeric, without parentheses. */
const QUALITY_GATE_CHECK_ID = '(qualityGate)';
/** Changed-path tokens beyond this are summarised as `protected-check-changed:+<n> more`. */
const MAX_CHANGED_TOKENS = 10;

/** `protected-check-changed:<path>`: a protected path whose blob differs from, is missing from, or was added to the approved snapshot. */
export function protectedCheckChangedToken(path: string): string {
  return `${PROTECTED_CHECK_CHANGED_PREFIX}${path}`;
}

/** `required-check-untrusted-checker:<id>`: an approved verified-local architecture check not in the installed form. */
export function untrustedCheckerToken(id: string): string {
  return `${UNTRUSTED_CHECKER_PREFIX}${id}`;
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
 * The one epic-final rule. get_context's `task.isEpicFinal` (which the wrapper
 * uses to decide whether an epicFinal-scoped gate runs), requiredCheckCommand and
 * qa_approve's requiredCheckAtDone snapshot all call it; a test pins get_context
 * against it.
 *
 * - A task without an epic is final.
 * - The epic's designated final task (`epic.finalTaskId`, set with
 *   moe.update_epic) is the only final task, while the designation names an
 *   existing, non-ARCHIVED task of the same epic.
 * - Otherwise the highest `order` among the epic's non-ARCHIVED tasks, ties
 *   counting. That fallback drifts: `order` is a per-column sort position that
 *   board drags, set_task_status moves and create_task's max+1 rewrite, which is
 *   why the designation exists.
 */
export function isEpicFinalTask(state: StateManager, task: Task): boolean {
  if (!task.epicId) return true;
  const designated = state.getEpic(task.epicId)?.finalTaskId;
  if (typeof designated === 'string' && designated !== '') {
    const final = state.getTask(designated);
    if (final && final.epicId === task.epicId && final.status !== 'ARCHIVED') return task.id === designated;
  }
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
 * tree, of `command`, exit 0, reported as runner-observed. For a verified-local
 * task (`trusted`: its approved environments) trustedPassedOn decides instead. A
 * lookup failure is logged and answers false.
 *
 * `command` is the trimmed setting, and the recorded command is trimmed before the
 * compare. Both wrappers trim settings.qualityGate before they run and record it,
 * but a padded command can still reach this compare: a run the ps1 wrapper recorded
 * before task-8fc35d31, a run from an older wrapper an IDE plugin still bundles,
 * or a direct moe.record_check_run call (checkRunStore keeps `command` as sent).
 * Trimming is safe: no shell sees the padding a hand-edited project.json can carry.
 */
function hasPassingCheck(state: StateManager, task: Task, command: string, trusted: readonly string[] | null): boolean {
  try {
    const candidates = listCandidatesForTask(state, task.id);
    const current = candidates[candidates.length - 1];
    return trusted ? trustedPassedOn(state, task, current, { command }, trusted) : passedOn(state, current, command);
  } catch (err) {
    logger.warn({ err, taskId: task.id }, 'Delivery policy: check evidence unreadable; reporting it missing');
    return false;
  }
}

/** The one passing-run match, shared by the quality gate and protected required checks. May throw. */
function passedOn(state: StateManager, current: Candidate | undefined, command: string): boolean {
  if (!current || typeof current.treeSha !== 'string' || current.treeSha === '') return false;
  return listCheckRunsForCandidate(state, current.id).some((run) =>
    run.candidateId === current.id && run.treeSha === current.treeSha &&
    typeof run.command === 'string' && run.command.trim() === command &&
    run.exitCode === 0 && run.source === 'runner-observed' &&
    // A recorded outcome other than passed never satisfies, even at exit 0: infra
    // failure, timeout, skipped, inconclusive, or an incoherent or unrecognised
    // stored value (fail closed). A row WITHOUT an outcome predates outcomes, or
    // came from a reporter that does not classify, and keeps the exit-code rule:
    // the explicit legacy compatibility. The legacy policy never reaches here.
    (run.outcome === undefined || run.outcome === 'passed'));
}

/**
 * The verified-local pass rule: a run on `current`'s own tree, outcome exactly
 * passed at exit 0, at the task's current approved revision, in an approved
 * environment, authenticated (a stored observation, never a reported run) and
 * bound to a dispatch naming `check`: its command, and its checkId when set.
 * Trust comes only from stored records. May throw.
 */
function trustedPassedOn(state: StateManager, task: Task, current: Candidate | undefined, check: OwedCheck,
  environments: readonly string[]): boolean {
  const revision = task.approvedPlanRevision;
  if (!current || typeof current.treeSha !== 'string' || current.treeSha === '') return false;
  if (typeof revision !== 'number' || task.planRevision !== revision) return false;
  return listCheckRunsForCandidate(state, current.id).some((run) => {
    if (run.candidateId !== current.id || run.treeSha !== current.treeSha || run.exitCode !== 0 || run.outcome !== 'passed' ||
      run.planRevision !== revision || typeof run.environment !== 'string' || !environments.includes(run.environment) ||
      typeof run.dispatchId !== 'string' || !isAuthenticatedCheckRun(state, run)) return false;
    const dispatch = getCheckDispatch(state, run.dispatchId);
    return dispatch !== null && dispatch.command === check.command && (check.checkId === undefined || dispatch.checkId === check.checkId);
  });
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

/** The declared requiredChecks: [] when none are declared, null when they are unreadable (logged). */
function declaredChecks(task: Task): readonly ProtectedCheckDefinition[] | null {
  // Only a declared requiredChecks is judged: other contract damage keeps today's verdict.
  if ((task.executionContract as { requiredChecks?: unknown } | null | undefined)?.requiredChecks === undefined) return [];
  try {
    return validateExecutionContract(task.executionContract)?.requiredChecks ?? [];
  } catch (err) {
    logger.warn({ err, taskId: task.id }, 'Delivery policy: requiredChecks unreadable; reporting them unapproved');
    return null;
  }
}

/**
 * Protected required checks (executionContract.requiredChecks, read by declaredChecks).
 * The definitions and the files they protect come ONLY from the approved snapshot
 * (readRequiredCheckSnapshot), never from candidate data or live settings. The current
 * candidate's runner-reported protectedEntries must equal the snapshot, and each
 * approved command needs its own passing run on that candidate's tree: another command
 * never stands in for it. Under verified-local each definition needs its own, and an
 * architecture check must be the installed form, first (task-efbf1742): a candidate-built
 * checker's pass is never evidence, since unprotected modules it imports can fake it.
 */
function protectedCheckShortfall(state: StateManager, task: Task, defs: readonly ProtectedCheckDefinition[] | null,
  trusted: readonly string[] | null): string[] {
  if (defs === null) return [EVIDENCE_TOKENS.protectedChecksUnapproved];
  if (defs.length === 0) return [];
  const snapshot = readRequiredCheckSnapshot(task);
  if (!snapshot) return [EVIDENCE_TOKENS.protectedChecksUnapproved];
  // Trimmed like qualityGate: the validator keeps padding no shell would see.
  const owed = (passed: (def: ProtectedCheckDefinition) => boolean) =>
    [...new Set(defs.filter((d) => !passed(d)).map((d) => requiredCheckToken(d.command.trim())))];
  const untrusted = trusted ? untrustedArchitectureChecks(defs, snapshot.entries).map(untrustedCheckerToken) : [];
  try {
    const candidates = listCandidatesForTask(state, task.id);
    const current = candidates[candidates.length - 1];
    const roots = protectedPaths(defs).map((p) => p.path);
    const drift = current ? protectedDrift(roots, snapshot.entries, current.protectedEntries) : null;
    const passed = (d: ProtectedCheckDefinition) => (trusted
      ? trustedPassedOn(state, task, current, { checkId: d.id, command: d.command.trim() }, trusted)
      : passedOn(state, current, d.command.trim()));
    return [...untrusted, ...(drift ?? [EVIDENCE_TOKENS.protectedChecksUnmeasured]), ...owed(passed)];
  } catch (err) {
    logger.warn({ err, taskId: task.id }, 'Delivery policy: protected check evidence unreadable; reporting it missing');
    return [...untrusted, EVIDENCE_TOKENS.protectedChecksUnmeasured, ...owed(() => false)];
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
 * The gate command `task` owes, or null for none. Until DONE it is the live
 * requiredCheckCommand. A DONE or ARCHIVED task owes what qa_approve snapshotted
 * (requiredCheckAtDone: a command, or null for none); one without a snapshot falls
 * back to the live rule. undefined when the snapshot is of any other type:
 * unreadable, never read as none owed.
 */
function owedGate(state: StateManager, task: Task): string | null | undefined {
  const snapshot: unknown = task.requiredCheckAtDone;
  if (!LANDING_JUDGED.has(task.status) || snapshot === undefined) return requiredCheckCommand(state, task);
  if (snapshot === null || typeof snapshot === 'string') return snapshot?.trim() || null;
  return undefined;
}

/**
 * The tokens for the gate `task` owes (owedGate), or none. An unreadable snapshot is logged and reported missing:
 * fail closed. Under verified-local the gate is first judged like a definition that protects no files, so a
 * candidate-built checker it runs never delivers (task-efbf1742).
 */
function checkShortfall(state: StateManager, task: Task, trusted: readonly string[] | null): string[] {
  const command = owedGate(state, task);
  if (command === undefined) {
    logger.warn({ taskId: task.id, snapshot: renderGot(task.requiredCheckAtDone) }, 'Delivery policy: requiredCheckAtDone unreadable; reporting the check missing');
    return [EVIDENCE_TOKENS.unreadableRequiredCheck];
  }
  if (command === null) return [];
  const untrusted = trusted ? untrustedArchitectureChecks([{ id: QUALITY_GATE_CHECK_ID, command }]).map(untrustedCheckerToken) : [];
  return hasPassingCheck(state, task, command, trusted) ? untrusted : [...untrusted, requiredCheckToken(command)];
}

/** One check a task owes on its current candidate: an approved protected definition (checkId set) or the gate. */
export interface OwedCheck {
  checkId?: string;
  command: string;
}

/** The approved definitions, only while readRequiredCheckSnapshot binds the snapshot to them. Never throws. */
function approvedDefinitions(task: Task): OwedCheck[] {
  try {
    if (!readRequiredCheckSnapshot(task)) return [];
    return (validateExecutionContract(task.executionContract)?.requiredChecks ?? []).map((d) => ({ checkId: d.id, command: d.command.trim() }));
  } catch {
    return [];
  }
}

/**
 * The frozen list of checks `task` owes on its current candidate: each approved
 * protected definition {checkId, trimmed command} in contract order, then the owed
 * gate {command} unless a definition already runs it. Never throws: an unreadable
 * contract or gate owes nothing here, and evaluateDeliveryEvidence reports it.
 */
export function owedChecks(state: StateManager, task: Task): OwedCheck[] {
  const owed = approvedDefinitions(task);
  const gate = owedGate(state, task);
  if (typeof gate === 'string' && !owed.some((check) => check.command === gate)) owed.push({ command: gate });
  return owed;
}

const MAX_CHECK_ENVIRONMENTS = 50;
const MAX_ENVIRONMENT_CHARS = 255;

/**
 * settings.checkEnvironments, the human-approved check environment ids, verbatim.
 * Absent or null approves none. Anything but an array of at most 50 non-blank
 * strings of at most 255 characters without control characters (the
 * CheckRun.environment rule) is refused as invalid input, never coerced.
 */
export function approvedCheckEnvironments(settings: { checkEnvironments?: unknown } | null | undefined): readonly string[] {
  const raw = settings?.checkEnvironments;
  if (raw === undefined || raw === null) return [];
  const valid = (id: unknown) => typeof id === 'string' && id.trim() !== '' && id.length <= MAX_ENVIRONMENT_CHARS && !hasControlChar(id);
  if (!Array.isArray(raw) || raw.length > MAX_CHECK_ENVIRONMENTS || !raw.every(valid)) {
    throw invalidInput('checkEnvironments', `must be an array of at most ${MAX_CHECK_ENVIRONMENTS} environment ids, each non-blank, ` +
      `at most ${MAX_ENVIRONMENT_CHARS} characters and without control characters (got ${renderGot(raw)})`);
  }
  return [...raw] as string[];
}

/**
 * True when `task`'s own profile is verified-local (the live profile floored by its snapshot). May throw INVALID_INPUT.
 * evaluateDeliveryEvidence and deliveryProjection both read it, so the checks a task owes are decided in one place.
 */
export function isVerifiedLocal(state: StateManager, task: Task): boolean {
  return resolveTaskExecutionProfile(state.project?.settings, task.executionPolicySnapshot) === 'verified-local';
}

/**
 * moe.record_check_dispatch admission for a NEW dispatch of a verified-local task,
 * before anything is written: NOT_ALLOWED CHECK_DEFINITION_NOT_APPROVED unless
 * owedChecks has this exact command with the same checkId (both absent for the
 * gate), then CHECK_ENVIRONMENT_NOT_APPROVED unless settings.checkEnvironments lists
 * the environment (a malformed list is INVALID_INPUT). Legacy and observe tasks, an
 * unknown task and malformed params pass through, so the store answers with its codes.
 */
export function assertCheckDispatchApproved(state: StateManager, params: Record<string, unknown>): void {
  const { taskId, command, checkId, environment } = params;
  if (typeof taskId !== 'string' || typeof command !== 'string' || typeof environment !== 'string') return;
  if (checkId !== undefined && typeof checkId !== 'string') return;
  const task = state.getTask(taskId);
  if (!task || !isVerifiedLocal(state, task)) return;
  if (!owedChecks(state, task).some((check) => check.command === command && check.checkId === checkId)) {
    // Echoed bounded: admission runs before the store validates checkId and command.
    throw new MoeError(MoeErrorCode.NOT_ALLOWED,
      `Task ${taskId} owes no approved check ${checkId === undefined ? '(gate)' : renderGot(checkId)} running ${renderGot(command)}`,
      { taskId }, 'CHECK_DEFINITION_NOT_APPROVED');
  }
  if (!approvedCheckEnvironments(state.project?.settings).includes(environment)) {
    throw new MoeError(MoeErrorCode.NOT_ALLOWED, `Environment ${renderGot(environment)} is not listed in settings.checkEnvironments`,
      { taskId }, 'CHECK_ENVIRONMENT_NOT_APPROVED');
  }
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
 * any write. Under the legacy policy only a verified-local task is judged: its
 * checks are, landing is not, and `policy` still reports 'legacy'.
 */
export function evaluateDeliveryEvidence(state: StateManager, task: Task, attestations: DeliveryAttestations = {}): DeliveryEvidenceResult {
  const policy = resolveTaskDeliveryPolicy(state.project?.settings, task);
  // Verified-local only: its approved environments, read live (a malformed list throws). null keeps today's rule.
  // An empty list is strict, so legacy is excused on `=== null` alone, never on the list's truthiness or length.
  const trusted = isVerifiedLocal(state, task) ? approvedCheckEnvironments(state.project?.settings) : null;
  if (policy === 'legacy' && trusted === null) return { policy, satisfied: true, missingEvidence: [] };
  const defs = declaredChecks(task);
  const undeclared = trusted && defs?.length === 0 && owedGate(state, task) === null ? [EVIDENCE_TOKENS.requiredChecksUndeclared] : [];
  const landing = policy === 'legacy' || LANDING_JUDGED.has(task.status) ? [] : landingShortfall(policy, task, attestations);
  // First-seen order: a command both qualityGate and a protected check owe appears once.
  const missingEvidence = [...new Set([...landing, ...checkShortfall(state, task, trusted),
    ...protectedCheckShortfall(state, task, defs, trusted), ...undeclared])];
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
  [EVIDENCE_TOKENS.requiredChecksUndeclared, 'a verified-local task must owe at least one required check: declare executionContract.requiredChecks or configure the qualityGate it owes'],
]);

/** A readable reason for one missing-evidence token. */
export function describeMissingEvidence(token: string): string {
  if (token.startsWith(REQUIRED_CHECK_TOKEN_PREFIX)) {
    const command = token.slice(REQUIRED_CHECK_TOKEN_PREFIX.length);
    return `no runner-observed exit-0 run of "${command}" is recorded for the current candidate's tree`;
  }
  if (token.startsWith(UNTRUSTED_CHECKER_PREFIX)) {
    // The id comes from the approved snapshot, or names the gate; never from candidate data.
    const id = token.slice(UNTRUSTED_CHECKER_PREFIX.length);
    const check = id === QUALITY_GATE_CHECK_ID ? 'the quality gate (settings.qualityGate)' : `required check ${id}`;
    return `${check} runs the architecture checker from code the candidate builds; ` +
      'under verified-local its command must be exactly the installed `moe-daemon check-architecture ...`, which the runner provisions from the base revision';
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
