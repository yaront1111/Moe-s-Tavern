// =============================================================================
// Bounded repair policy — CQ-V05 (task-6be626cf)
// =============================================================================
//
// The plan's "Refresh, repair, or replan" rule as a pure decision: repair a code
// failure inside the approved plan, retry infrastructure in a SEPARATE bounded
// budget, escalate (never loop) on a repeated unchanged failure. No IO, no state;
// acting on a decision (re-dispatching the check, routing the task) is CQ-V12's.

import type { CheckOutcome, CheckRun } from '../types/schema.js';
import { invalidInput } from '../util/errors.js';

export interface RepairPolicy {
  /** Repairs after a failing candidate: N failing candidates have spent N-1. */
  readonly maxCodeRepairs: number;
  /** Re-runs of one candidate after an infrastructure failure or timeout. */
  readonly maxInfraRetries: number;
}

export const DEFAULT_REPAIR_POLICY: RepairPolicy = Object.freeze({ maxCodeRepairs: 3, maxInfraRetries: 2 });

const BUDGET_KEYS = ['maxCodeRepairs', 'maxInfraRetries'] as const;
const MAX_BUDGET = 10;

const got = (value: unknown): string =>
  typeof value === 'string' ? JSON.stringify(value.slice(0, 40)) : value !== null && typeof value === 'object' ? 'an object or array' : String(value);

/**
 * The budgets from `settings.repairPolicy`; absent or null gives the defaults.
 * Fail closed, like resolveDeliveryPolicy: a non-object, an unknown key or
 * anything but an integer 0-10 is an INVALID_INPUT naming the field. Pure.
 */
export function resolveRepairPolicy(settings: { repairPolicy?: unknown } | null | undefined): RepairPolicy {
  const raw = settings?.repairPolicy;
  if (raw === undefined || raw === null) return DEFAULT_REPAIR_POLICY;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw invalidInput('settings.repairPolicy', `must be an object with optional ${BUDGET_KEYS.join(' and ')} (got ${got(raw)})`);
  }
  const obj = raw as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!(BUDGET_KEYS as readonly string[]).includes(key)) {
      throw invalidInput(`settings.repairPolicy.${key.slice(0, 40)}`, `unknown key; allowed keys are ${BUDGET_KEYS.join(', ')}`);
    }
  }
  const budget = (key: (typeof BUDGET_KEYS)[number]): number => {
    if (!Object.hasOwn(obj, key)) return DEFAULT_REPAIR_POLICY[key];
    const value = obj[key];
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > MAX_BUDGET) {
      throw invalidInput(`settings.repairPolicy.${key}`, `must be an integer from 0 to ${MAX_BUDGET} (got ${got(value)})`);
    }
    return value;
  };
  return Object.freeze({ maxCodeRepairs: budget('maxCodeRepairs'), maxInfraRetries: budget('maxInfraRetries') });
}

export type RepairRun = Pick<CheckRun, 'id' | 'candidateId' | 'command' | 'exitCode' | 'outcome' | 'outputTail' | 'planRevision' | 'createdAt'>;

export interface RepairInput {
  readonly planRevision: number;
  /** Anything but planRevision needs a replan. */
  readonly approvedPlanRevision?: number;
  /** The task's candidates, oldest first (listCandidatesForTask order): the last is current. */
  readonly candidates: readonly { readonly id: string; readonly treeSha: string }[];
  /** The runs of ONE required check; the caller decides which count (for example authenticated only). */
  readonly runs: readonly RepairRun[];
  readonly policy: RepairPolicy;
}

/** The latest run of the current candidate, for a human who has not opened the log. */
export interface RepairDiagnostics {
  readonly checkRunId: string;
  readonly candidateId: string;
  readonly command: string;
  readonly outcome: CheckOutcome;
  readonly exitCode: number;
  /** The last 20 lines of the output tail, at most 2000 characters. */
  readonly excerpt: string;
  /** Non-passing run ids of this check, newest first, at most 5. */
  readonly logRefs: readonly string[];
}

export type EscalationReason = 'code-repair-budget-exhausted' | 'infra-retry-budget-exhausted' | 'unchanged-candidate' | 'unchanged-failure' | 'non-repairable-outcome';

export type RepairDecision =
  | { readonly action: 'none'; readonly reason: 'passed' | 'awaiting-evidence' }
  | { readonly action: 'repair' | 'retry-infra'; readonly attempt: number; readonly remaining: number; readonly diagnostics: RepairDiagnostics }
  | { readonly action: 'escalate'; readonly reason: EscalationReason; readonly diagnostics: RepairDiagnostics }
  | { readonly action: 'replan'; readonly reason: 'plan-revision-unapproved' };

const EXCERPT_LINES = 20;
const EXCERPT_CHARS = 2000;
const MAX_LOG_REFS = 5;

type Kind = 'passed' | 'code-failure' | 'infra' | 'other';

/** No outcome keeps passedOn's legacy exit-code rule. An outcome that disagrees with its exit code, or is unrecognised, is 'other': never passed, never repairable. */
function classify(run: RepairRun): Kind {
  switch (run.outcome) {
    case undefined: return run.exitCode === 0 ? 'passed' : 'code-failure';
    case 'passed': return run.exitCode === 0 ? 'passed' : 'other';
    case 'code-failure': return run.exitCode !== 0 ? 'code-failure' : 'other';
    case 'infra-failure':
    case 'timeout': return 'infra';
    default: return 'other';
  }
}

const cmp = (a: string | number, b: string | number): number => (a < b ? -1 : a > b ? 1 : 0);

/** A total order by code unit (createdAt, id, then content), so input order never matters. */
const byAge = (a: RepairRun, b: RepairRun): number =>
  cmp(a.createdAt ?? '', b.createdAt ?? '') || cmp(a.id, b.id) || cmp(a.candidateId, b.candidateId) ||
  cmp(a.exitCode, b.exitCode) || cmp(a.outcome ?? '', b.outcome ?? '') || cmp(a.outputTail, b.outputTail) || cmp(a.command, b.command);

/** This revision's runs (or revision-less legacy ones) on listed candidates, oldest first, one per id. */
function keptRuns({ planRevision, candidates, runs }: RepairInput): RepairRun[] {
  const listed = new Set(candidates.map((c) => c.id));
  const seen = new Set<string>();
  return runs
    .filter((r) => (r.planRevision === undefined || r.planRevision === planRevision) && listed.has(r.candidateId))
    .sort(byAge)
    .filter((r) => !seen.has(r.id) && Boolean(seen.add(r.id)));
}

function excerptOf(tail: string): string {
  const text = tail.trimEnd().split('\n').slice(-EXCERPT_LINES).join('\n').slice(-EXCERPT_CHARS);
  const first = text.charCodeAt(0);
  return first >= 0xdc00 && first <= 0xdfff ? text.slice(1) : text; // never begin on half a surrogate pair
}

function diagnose(run: RepairRun, kept: readonly RepairRun[]): RepairDiagnostics {
  return {
    checkRunId: run.id,
    candidateId: run.candidateId,
    command: run.command,
    outcome: run.outcome ?? (run.exitCode === 0 ? 'passed' : 'code-failure'),
    exitCode: run.exitCode,
    excerpt: excerptOf(run.outputTail),
    logRefs: kept.filter((r) => classify(r) !== 'passed').map((r) => r.id).reverse().slice(0, MAX_LOG_REFS),
  };
}

/**
 * The one next move for the current candidate, from ONE check's runs. Only a run
 * on the current candidate counts, and runs of another plan revision are ignored,
 * so a replan starts a fresh budget. Code and infra failures spend separate
 * budgets: N failing candidates have used N-1 repairs; infra retries are counted
 * on the current candidate alone. A repeated failure or unchanged tree escalates
 * at once, as does any outcome that is neither a pass nor repairable. Pure.
 */
export function decideRepair(input: RepairInput): RepairDecision {
  const { candidates, policy } = input;
  if (input.approvedPlanRevision !== input.planRevision) return { action: 'replan', reason: 'plan-revision-unapproved' };
  const kept = keptRuns(input);
  const latest = new Map<string, RepairRun>();
  for (const run of kept) latest.set(run.candidateId, run);
  const current = candidates[candidates.length - 1];
  const last = current ? latest.get(current.id) : undefined;
  if (!current || !last) return { action: 'none', reason: 'awaiting-evidence' };

  const diagnostics = diagnose(last, kept);
  const escalate = (reason: EscalationReason): RepairDecision => ({ action: 'escalate', reason, diagnostics });
  const spend = (action: 'repair' | 'retry-infra', used: number, max: number, exhausted: EscalationReason): RepairDecision =>
    used >= max ? escalate(exhausted) : { action, attempt: used + 1, remaining: max - used - 1, diagnostics };

  switch (classify(last)) {
    case 'passed': return { action: 'none', reason: 'passed' };
    case 'other': return escalate('non-repairable-outcome');
    case 'infra': {
      const infraRuns = kept.filter((r) => r.candidateId === current.id && classify(r) === 'infra').length;
      return spend('retry-infra', infraRuns - 1, policy.maxInfraRetries, 'infra-retry-budget-exhausted');
    }
    case 'code-failure': {
      const failed = candidates.filter((c) => { const run = latest.get(c.id); return run !== undefined && classify(run) === 'code-failure'; });
      const prev = failed[failed.length - 2];
      const prevRun = prev ? latest.get(prev.id) : undefined;
      if (prev && prev.treeSha === current.treeSha) return escalate('unchanged-candidate');
      if (prevRun && prevRun.exitCode === last.exitCode && prevRun.outputTail === last.outputTail) return escalate('unchanged-failure');
      return spend('repair', failed.length - 1, policy.maxCodeRepairs, 'code-repair-budget-exhausted');
    }
  }
}
