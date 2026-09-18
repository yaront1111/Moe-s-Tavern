// Serving-only evidence. Never attach it to a stored Task or write it to disk.
import type { Candidate, CheckRun, CheckRunSource, DeliveryReceipt, ExecutionAttempt, Task } from '../types/schema.js';
import type { StateManager } from './StateManager.js';
import { listCandidatesForTask, SHA_RE as CANDIDATE_SHA_RE } from './candidateStore.js';
import { listCheckRunsForCandidate } from './checkRunStore.js';
import { getDeliveryReceiptForCandidate } from './receiptStore.js';
import { currentAttempt, getAttempt } from './attemptStore.js';
import { evaluateDeliveryEvidence, EVIDENCE_TOKENS, REQUIRED_CHECK_TOKEN_PREFIX, requiredCheckCommand } from '../delivery/policy.js';
import { logger } from '../util/logger.js';

export interface TaskDelivery {
  currentCandidate?: Pick<Candidate, 'id' | 'treeSha' | 'baseRevision'> & { shortSha: string };
  /** The LAST run reported on the current candidate, counted or not. A stored source that is not a CheckRunSource is omitted. */
  latestCheckRun?: Pick<CheckRun, 'command' | 'exitCode'> & Partial<Pick<CheckRun, 'source'>>;
  /**
   * delivery/policy.ts on the required check: false while it reports the check
   * missing, true once an owed check is satisfied. Absent under the legacy policy,
   * when no check is owed, or when the policy cannot be read.
   */
  requiredCheckSatisfied?: boolean;
  deliveryReceipt?: Pick<DeliveryReceipt, 'target' | 'landedRevision'>;
  attemptPhase?: ExecutionAttempt['phase'];
}

const isCandidateSha = (value: unknown): value is string => typeof value === 'string' && CANDIDATE_SHA_RE.test(value);
const isLandedRevision = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{40}$/i.test(value);
const isString = (value: unknown): value is string => typeof value === 'string';
const isCheckSource = (value: unknown): value is CheckRunSource => value === 'runner-observed' || value === 'agent-reported';

/** Bad persisted metadata must not take down a board connection. No record is repaired here. */
function readEvidence<T>(taskId: string, kind: string, read: () => T | undefined | null): T | undefined {
  try {
    return read() ?? undefined;
  } catch (error) {
    logger.debug({ taskId, kind, error }, 'Ignoring malformed delivery evidence');
    return undefined;
  }
}

function valid<T>(record: T | undefined | null, predicate: (value: T) => boolean): T | undefined {
  if (record == null) return undefined;
  if (!predicate(record)) throw new Error('Malformed delivery record');
  return record;
}

function candidateFor(state: StateManager, task: Task): Candidate | undefined {
  return readEvidence(task.id, 'candidate', () => {
    const candidates = listCandidatesForTask(state, task.id);
    return valid(candidates[candidates.length - 1], c =>
      isString(c.id) && isString(c.attemptId) && isString(c.createdAt) &&
      isCandidateSha(c.treeSha) && isCandidateSha(c.baseRevision));
  });
}

function checkFor(state: StateManager, task: Task, candidate: Candidate): TaskDelivery['latestCheckRun'] {
  return readEvidence(task.id, 'check', () => {
    const checks = listCheckRunsForCandidate(state, candidate.id);
    const check = valid(checks[checks.length - 1], c => isString(c.command) &&
      Number.isSafeInteger(c.exitCode) && c.treeSha === candidate.treeSha);
    return check ? {
      command: check.command, exitCode: check.exitCode, ...(isCheckSource(check.source) ? { source: check.source } : {}),
    } : undefined;
  });
}

/** Whether a check is owed, decided as policy.ts checkShortfall decides it: a DONE task's snapshot, else the live rule. */
function checkOwed(state: StateManager, task: Task): boolean {
  const snapshot: unknown = task.requiredCheckAtDone;
  if ((task.status === 'DONE' || task.status === 'ARCHIVED') && snapshot !== undefined) {
    return typeof snapshot === 'string' && snapshot.trim() !== '';
  }
  return requiredCheckCommand(state, task) !== null;
}

/** The policy's verdict on the required check, never the latest run's: a pass it does not count reads false. */
function requiredCheckSatisfiedFor(state: StateManager, task: Task): boolean | undefined {
  return readEvidence(task.id, 'required-check', () => {
    const { policy, missingEvidence } = evaluateDeliveryEvidence(state, task);
    if (policy === 'legacy') return undefined;
    if (missingEvidence.some(t => t.startsWith(REQUIRED_CHECK_TOKEN_PREFIX) || t === EVIDENCE_TOKENS.unreadableRequiredCheck)) return false;
    return checkOwed(state, task) ? true : undefined;
  });
}

function receiptFor(state: StateManager, task: Task, candidate: Candidate): TaskDelivery['deliveryReceipt'] {
  return readEvidence(task.id, 'receipt', () => {
    const receipt = valid(getDeliveryReceiptForCandidate(state, candidate.id), r =>
      isString(r.target) && isLandedRevision(r.landedRevision));
    return receipt ? { target: receipt.target, landedRevision: receipt.landedRevision } : undefined;
  });
}

function phaseFor(state: StateManager, task: Task, candidate?: Candidate): TaskDelivery['attemptPhase'] {
  return readEvidence(task.id, 'attempt', () => {
    const attempt = valid(candidate ? getAttempt(state, candidate.attemptId) : currentAttempt(state, task.id), a =>
      a.taskId === task.id && ['running', 'finalizing', 'reconciling', 'closed'].includes(a.phase));
    return attempt?.phase;
  });
}

/** Pure projection over existing stores (except diagnostic logging for corrupt records). */
export function deliveryProjection(state: StateManager, task: Task): TaskDelivery | undefined {
  const candidate = candidateFor(state, task);
  const latestCheckRun = candidate ? checkFor(state, task, candidate) : undefined;
  const deliveryReceipt = candidate ? receiptFor(state, task, candidate) : undefined;
  const attemptPhase = phaseFor(state, task, candidate);
  if (!candidate && !attemptPhase) return undefined;
  const requiredCheckSatisfied = requiredCheckSatisfiedFor(state, task);
  return {
    ...(candidate ? { currentCandidate: {
      id: candidate.id, treeSha: candidate.treeSha, shortSha: candidate.treeSha.slice(0, 8), baseRevision: candidate.baseRevision,
    } } : {}),
    ...(latestCheckRun ? { latestCheckRun } : {}),
    ...(requiredCheckSatisfied === undefined ? {} : { requiredCheckSatisfied }),
    ...(deliveryReceipt ? { deliveryReceipt } : {}),
    ...(attemptPhase ? { attemptPhase } : {}),
  };
}
