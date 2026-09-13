// Serving-only evidence. Never attach it to a stored Task or write it to disk.
import type { Candidate, CheckRun, DeliveryReceipt, ExecutionAttempt, Task } from '../types/schema.js';
import type { StateManager } from './StateManager.js';
import { listCandidatesForTask } from './candidateStore.js';
import { listCheckRunsForCandidate } from './checkRunStore.js';
import { getDeliveryReceiptForCandidate } from './receiptStore.js';
import { currentAttempt, getAttempt } from './attemptStore.js';
import { logger } from '../util/logger.js';

export interface TaskDelivery {
  currentCandidate?: Pick<Candidate, 'id' | 'treeSha' | 'baseRevision'> & { shortSha: string };
  latestCheckRun?: Pick<CheckRun, 'command' | 'exitCode'>;
  deliveryReceipt?: Pick<DeliveryReceipt, 'target' | 'landedRevision'>;
  attemptPhase?: ExecutionAttempt['phase'];
}

const isSha = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{40}$/i.test(value);
const isString = (value: unknown): value is string => typeof value === 'string';

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
      isSha(c.treeSha) && isSha(c.baseRevision));
  });
}

function checkFor(state: StateManager, task: Task, candidate: Candidate): TaskDelivery['latestCheckRun'] {
  return readEvidence(task.id, 'check', () => {
    const checks = listCheckRunsForCandidate(state, candidate.id);
    const check = valid(checks[checks.length - 1], c => isString(c.command) &&
      Number.isSafeInteger(c.exitCode) && c.treeSha === candidate.treeSha);
    return check ? { command: check.command, exitCode: check.exitCode } : undefined;
  });
}

function receiptFor(state: StateManager, task: Task, candidate: Candidate): TaskDelivery['deliveryReceipt'] {
  return readEvidence(task.id, 'receipt', () => {
    const receipt = valid(getDeliveryReceiptForCandidate(state, candidate.id), r =>
      isString(r.target) && isSha(r.landedRevision));
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
  return {
    ...(candidate ? { currentCandidate: {
      id: candidate.id, treeSha: candidate.treeSha, shortSha: candidate.treeSha.slice(0, 8), baseRevision: candidate.baseRevision,
    } } : {}),
    ...(latestCheckRun ? { latestCheckRun } : {}),
    ...(deliveryReceipt ? { deliveryReceipt } : {}),
    ...(attemptPhase ? { attemptPhase } : {}),
  };
}
