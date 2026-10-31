/**
 * Daemon-owned plan-reuse facts (CQ-C07a): the commit an approved plan was submitted against, how the
 * task last entered PLANNING, and a recorded reuse assessment. No decision logic. The readers decode
 * untrusted persisted state and never throw. None of these facts is approval, readiness or evidence.
 */
import type { PlanningEntry, PlanReuseDecision, PlanReuseRecord, PlanSourceBasis, Task, TaskStatus } from '../types/schema.js';
import { normalizeAffectedFile } from '../util/affectedFiles.js';
import { openProjectGit, runGit } from '../util/cachedPlanPaths.js';
import { invalidInput, MoeError } from '../util/errors.js';

/** Test seam, read at call time (mirrors requiredCheckGit in delivery/requiredChecks.ts). */
export const planSourceGit = { run: runGit };

const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const TASK_STATUSES: Record<TaskStatus, true> = {
  BACKLOG: true, PLANNING: true, AWAITING_APPROVAL: true, WORKING: true,
  REVIEW: true, BLOCKED: true, DONE: true, ARCHIVED: true,
};
const DECISIONS: Record<PlanReuseDecision, true> = { reuse: true, refresh: true, reassess: true, replan: true };
const RECORD_KEYS = ['version', 'decision', 'planRevision', 'entrySeq', 'reasons', 'assessedAt'];
const RECORD_OPTIONAL = ['basisCommit', 'headCommit', 'changedPaths', 'candidate'];

const isCommit = (v: unknown): v is string => typeof v === 'string' && COMMIT.test(v);
const isCount = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const isIso = (v: unknown): v is string => typeof v === 'string' && ISO.test(v)
  && !Number.isNaN(Date.parse(v)) && new Date(v).toISOString() === v;
const isReason = (v: unknown) => typeof v === 'string' && v.length >= 1 && v.length <= 300 && !CONTROL.test(v);
const isPath = (v: unknown) => {
  try { return typeof v === 'string' && !CONTROL.test(v) && normalizeAffectedFile(v) === v; } catch { return false; }
};

// Each enumerable own field, read exactly once, of a plain object whose enumerable key SET is every required
// key plus only known optional keys (count + hasOwn would let a hidden required key mask an extra one).
function fieldsOf(value: unknown, required: readonly string[], optional: readonly string[] = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return null;
  const own = Object.keys(value);
  if (!required.every(k => own.includes(k)) || !own.every(k => required.includes(k) || optional.includes(k))) return null;
  return new Map(own.map(k => [k, (value as Record<string, unknown>)[k]]));
}

/** A detached copy of an array of at most `max` items that all pass `ok`, else null. */
function listOf(value: unknown, max: number, ok: (v: unknown) => boolean): string[] | null {
  if (!Array.isArray(value) || value.length > max) return null;
  const copy: unknown[] = Array.from(value);
  return copy.every(ok) ? copy as string[] : null;
}

export function readPlanSourceBasis(task: Pick<Task, 'planSourceBasis'>): PlanSourceBasis | null {
  try {
    const f = fieldsOf(task.planSourceBasis, ['version', 'commit', 'planRevision']);
    const commit = f?.get('commit'); const planRevision = f?.get('planRevision');
    return f?.get('version') === 1 && isCommit(commit) && isCount(planRevision)
      ? { version: 1, commit, planRevision } : null;
  } catch { return null; }
}

export function readPlanningEntry(task: Pick<Task, 'planningEntry'>): PlanningEntry | null {
  try {
    const f = fieldsOf(task.planningEntry, ['from', 'at', 'seq']);
    const from = f?.get('from'); const at = f?.get('at'); const seq = f?.get('seq');
    return typeof from === 'string' && Object.hasOwn(TASK_STATUSES, from) && isIso(at) && isCount(seq) && seq >= 1
      ? { from: from as TaskStatus, at, seq } : null;
  } catch { return null; }
}

function decodeRecord(value: unknown): PlanReuseRecord {
  const fail = (reason: string) => invalidInput('planReuse', reason);
  const f = fieldsOf(value, RECORD_KEYS, RECORD_OPTIONAL);
  if (!f) throw fail('expected a plain object with exactly the record keys');
  const decision = f.get('decision'); const planRevision = f.get('planRevision'); const entrySeq = f.get('entrySeq');
  const reasons = listOf(f.get('reasons'), 32, isReason); const assessedAt = f.get('assessedAt');
  if (f.get('version') !== 1) throw fail('version must be 1');
  if (typeof decision !== 'string' || !Object.hasOwn(DECISIONS, decision)) throw fail('unknown decision');
  if (!isCount(planRevision) || !isCount(entrySeq)) throw fail('planRevision and entrySeq must be non-negative safe integers');
  if (!reasons) throw fail('reasons must be 0-32 strings of 1-300 chars without control characters');
  if (!isIso(assessedAt)) throw fail('assessedAt must be a canonical ISO time');
  const record: PlanReuseRecord = { version: 1, decision: decision as PlanReuseDecision, planRevision, entrySeq,
    reasons, assessedAt };
  // Each optional key: valid -> copied, present but invalid -> refused, absent -> left out.
  for (const key of ['basisCommit', 'headCommit'] as const) {
    const commit = f.get(key);
    if (isCommit(commit)) record[key] = commit;
    else if (f.has(key)) throw fail(`${key} must be 40 or 64 lowercase hex`);
  }
  const paths = listOf(f.get('changedPaths'), 64, isPath);
  if (paths) record.changedPaths = paths;
  else if (f.has('changedPaths')) throw fail('changedPaths must be at most 64 normalized repo-relative paths');
  const candidate = f.get('candidate');
  if (candidate === 'current' || candidate === 'revalidate') record.candidate = candidate;
  else if (f.has('candidate')) throw fail('unknown candidate');
  return record;
}

/** The detached, validated record; throws INVALID_INPUT and nothing else. */
export function validatePlanReuseRecord(value: unknown): PlanReuseRecord {
  try { return decodeRecord(value); } catch (error) {
    throw error instanceof MoeError ? error : invalidInput('planReuse', 'the value could not be read');
  }
}

export function readPlanReuseRecord(task: Pick<Task, 'planReuse'>): PlanReuseRecord | null {
  try { return validatePlanReuseRecord(task.planReuse); } catch { return null; }
}

/** HEAD's commit for submit_plan, read outside the state mutex. Null on any failure; never throws. */
export async function capturePlanSourceBasis(projectRoot: string): Promise<{ commit: string } | null> {
  try {
    const git = await openProjectGit(projectRoot, planSourceGit.run, 2000);
    const commit = (await git('rev-parse --verify', ['rev-parse', '--verify', '--end-of-options', 'HEAD^{commit}'])).trim();
    return COMMIT.test(commit) ? { commit } : null;
  } catch { return null; }
}
