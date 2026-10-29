/**
 * Approved-plan reuse assessment (CQ-C07b): reuse an approved plan unchanged, reuse it with a context refresh,
 * or send it back to an architect. Library only: daemon state through the CQ-C07a decoders, committed Git
 * bytes through the read-only trust envelope. Writes no state, schedules nothing, never throws.
 */
import type { PlanReuseDecision, Task } from '../types/schema.js';
import { normalizeAffectedFile } from '../util/affectedFiles.js';
import { openProjectGit, runGit } from '../util/cachedPlanPaths.js';
import { readPlanningEntry, readPlanReuseRecord, readPlanSourceBasis } from './planReuseState.js';

export interface PlanSourcePaths {
  affected: string[];
  created: string[];
  /** One list per executionContract entry; index is 0-based, reasons print index + 1. */
  anchors: { kind: 'sourceAssumptions' | 'reuse'; index: number; paths: string[] }[];
  tooMany: boolean;
}

/** Test seam, read at call time (mirrors requiredCheckGit in delivery/requiredChecks.ts). */
export const planReuseGit = { run: runGit };

export interface TreeEntry { mode: string; type: string; oid: string }
export interface PlanSourceAssessment {
  basisCommit: string;
  headCommit: string;
  basis: Map<string, TreeEntry>;
  head: Map<string, TreeEntry>;
  target?: { baseRevision: string; commit: string | null };
}
export interface PlanReuseResult {
  decision: 'reuse' | 'refresh' | 'reassess';
  reasons: string[];
  changedPaths: string[];
  headCommit?: string;
  candidate?: 'current' | 'revalidate';
}

const MAX_PATHS = 256;
const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const ENTRY = /^(100644|100755|120000|040000|160000) (blob|tree|commit) ([0-9a-f]{40}|[0-9a-f]{64})\t([\s\S]+)$/;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const CONTROLS = /[\u0000-\u001f\u007f-\u009f]/g;
const SPLIT = /[\s,;:()[\]{}<>"'`#]+/;
const EXTENSION = /\.[A-Za-z][A-Za-z0-9]{0,15}$/;
const REPLAN_FROM = new Set(['AWAITING_APPROVAL', 'WORKING', 'REVIEW']);

const unique = (values: Iterable<string>) => [...new Set(values)].sort();
const strings = (value: unknown): string[] =>
  Array.isArray(value) ? Array.from(value as unknown[]).filter((v): v is string => typeof v === 'string') : [];
/** C07a's recordable path rule: normalized, project-relative, no control characters. */
const isPath = (p: string) => { try { return !CONTROL.test(p) && normalizeAffectedFile(p) === p; } catch { return false; } };
const firstLine = (error: unknown) => (error instanceof Error ? error.message : String(error)).split(/\r?\n/)[0].slice(0, 300);

/** Path-like tokens of one prose entry: canonical, and either nested or carrying a dot-extension. */
function anchorPaths(text: unknown): string[] {
  if (typeof text !== 'string') return [];
  const tokens = text.split(SPLIT).map(t => t.replace(/[./]+$/, ''));
  return [...new Set(tokens.filter(t => isPath(t) && (t.includes('/') || EXTENSION.test(t))))];
}

export function planSourcePaths(task: Pick<Task, 'implementationPlan' | 'executionContract'>): PlanSourcePaths {
  const steps: unknown[] = Array.isArray(task.implementationPlan) ? Array.from(task.implementationPlan) : [];
  const field = (key: string) => steps.flatMap(s => strings(s && typeof s === 'object' ? (s as Record<string, unknown>)[key] : []));
  const affected = unique(field('affectedFiles'));
  const created = unique(field('newFiles')).filter(p => !affected.includes(p));
  const contract: unknown = task.executionContract;
  const anchors = (['sourceAssumptions', 'reuse'] as const).flatMap(kind => {
    const list: unknown = contract && typeof contract === 'object' ? (contract as Record<string, unknown>)[kind] : [];
    return (Array.isArray(list) ? Array.from(list as unknown[]) : []).map((text, index) => ({ kind, index, paths: anchorPaths(text) }));
  });
  const all = new Set([...affected, ...created, ...anchors.flatMap(a => a.paths)]);
  return { affected, created, anchors, tooMany: all.size > MAX_PATHS };
}

/** The recorded answer for the current plan, a PLANNING-state verdict, or null. Pure; never throws. */
export function planReuseView(task: Task): { decision: PlanReuseDecision | 'pending'; reasons: string[] } | null {
  try {
    const raw: unknown = task.planRevision;
    const revision = raw === undefined ? 0 : Number.isSafeInteger(raw) && (raw as number) >= 0 ? raw as number : null;
    if (!Array.isArray(task.implementationPlan) || task.implementationPlan.length === 0) return null;
    const record = readPlanReuseRecord(task); const entry = readPlanningEntry(task);
    const planning = task.status === 'PLANNING';
    if (record && revision !== null && record.planRevision === revision && (!planning || record.entrySeq === entry?.seq)) {
      return { decision: record.decision, reasons: [...record.reasons] };
    }
    if (!planning) return null;
    const approved: unknown = task.approvedPlanRevision;
    if (!Number.isSafeInteger(approved) || approved !== revision) return { decision: 'replan', reasons: ['approval-not-current'] };
    if (!entry) return { decision: 'reassess', reasons: ['planning-entry-unknown'] };
    if (REPLAN_FROM.has(entry.from)) return { decision: 'replan', reasons: [`replan-requested-from-${entry.from}`] };
    const basis = readPlanSourceBasis(task);
    if (!basis) return { decision: 'reassess', reasons: ['source-basis-missing'] };
    if (basis.planRevision !== revision) return { decision: 'reassess', reasons: ['source-basis-stale'] };
    return { decision: 'pending', reasons: [] };
  } catch { return null; }
}

/** One entry per requested pathspec, keyed in a Map (repo paths may be prototype names). Throws on anything else. */
function parseTree(listing: string, wanted: Set<string>): Map<string, TreeEntry> {
  const tree = new Map<string, TreeEntry>();
  if (!listing) return tree;
  if (!listing.endsWith('\0')) throw new Error('ls-tree: unterminated output');
  for (const line of listing.slice(0, -1).split('\0')) {
    const m = ENTRY.exec(line);
    if (!m || !wanted.has(m[4]) || tree.has(m[4])) throw new Error('ls-tree: malformed, unrequested or duplicate entry');
    tree.set(m[4], { mode: m[1], type: m[2], oid: m[3] });
  }
  return tree;
}

/** Committed identity of every referenced path at the basis and HEAD. Bounded, read-only; never throws. */
export async function assessPlanSource(projectRoot: string, input: {
  basisCommit: string; paths: PlanSourcePaths; candidate?: { baseRevision: string; deliveryTarget: string };
}): Promise<PlanSourceAssessment | { unavailable: string }> {
  try {
    const { basisCommit, paths, candidate } = input;
    if (paths.tooMany) return { unavailable: `more than ${MAX_PATHS} source paths` };
    if (typeof basisCommit !== 'string' || !COMMIT.test(basisCommit)) return { unavailable: 'basis commit is not 40 or 64 lowercase hex' };
    const git = await openProjectGit(projectRoot, planReuseGit.run, 5000);
    const resolve = async (rev: string) => {
      const commit = (await git('rev-parse --verify', ['rev-parse', '--verify', '--end-of-options', `${rev}^{commit}`])).trim();
      if (!COMMIT.test(commit)) throw new Error(`rev-parse: ${rev} did not resolve to a commit`);
      return commit;
    };
    const headCommit = await resolve('HEAD');
    if (await resolve(basisCommit) !== basisCommit) throw new Error(`basis ${basisCommit} does not resolve to itself`);
    // Invalid plan paths are never pathspecs; decidePlanReuse names them source-path-invalid.
    const union = [...new Set([...paths.affected, ...paths.created, ...paths.anchors.flatMap(a => a.paths)])].filter(isPath);
    // No -r: one entry per existing pathspec, a directory yielding its tree. Git descends into a directory that is an
    // ancestor of another pathspec and prints its children instead, so ancestors are listed in a later layer.
    const list = async (commit: string, specs: string[]): Promise<[string, TreeEntry][]> => {
      if (specs.length === 0) return []; // no pathspec would list the whole tree
      const inner = specs.filter(p => specs.some(q => q.startsWith(`${p}/`)));
      const outer = specs.filter(p => !inner.includes(p));
      const listing = await git('ls-tree', ['--literal-pathspecs', 'ls-tree', '-z', '--full-tree', commit, '--', ...outer],
        { maxBuffer: 1024 * 1024 });
      return [...parseTree(listing, new Set(outer)), ...await list(commit, inner)];
    };
    const basis = new Map(await list(basisCommit, union));
    const assessment: PlanSourceAssessment = { basisCommit, headCommit, basis,
      head: headCommit === basisCommit ? basis : new Map(await list(headCommit, union)) };
    if (candidate) {
      const target: unknown = candidate.deliveryTarget;
      const commit = typeof target !== 'string' || !target || target.startsWith('-') ? null : await resolve(target).catch(() => null);
      assessment.target = { baseRevision: candidate.baseRevision, commit };
    }
    return assessment;
  } catch (error) { return { unavailable: firstLine(error) }; }
}

/** Sorted, deduped and capped at 32, each reason control-free and at most 300 chars (validatePlanReuseRecord's rule). */
function tidy(reasons: string[]): string[] {
  const all = unique(reasons.map(r => r.replace(CONTROLS, '?').slice(0, 300)));
  return all.length > 32 ? [...all.slice(0, 31), `more-reasons:${all.length - 31}`] : all;
}

const same = (a?: TreeEntry, b?: TreeEntry) => a?.mode === b?.mode && a?.oid === b?.oid;
const soft = (r: string) => r.startsWith('affected-file-changed:') || r === 'target-moved' || r === 'target-unresolved';

/** Reuse, refresh or reassess with stable reason codes. The candidate verdict never changes the decision. Never throws. */
export function decidePlanReuse(paths: PlanSourcePaths, assessment: PlanSourceAssessment | { unavailable: string }): PlanReuseResult {
  try {
    if (paths.tooMany) return { decision: 'reassess', reasons: ['too-many-source-paths'], changedPaths: [] };
    if ('unavailable' in assessment) {
      return { decision: 'reassess', reasons: tidy([`source-unavailable: ${assessment.unavailable}`]), changedPaths: [] };
    }
    const { basis, head } = assessment; const reasons: string[] = []; const changed: string[] = [];
    for (const [p, e] of [...basis, ...head]) if (e.mode === '160000') reasons.push(`source-unavailable:gitlink:${p}`);
    for (const p of [...paths.affected, ...paths.created]) if (!isPath(p)) reasons.push(`source-path-invalid:${p}`);
    for (const { kind, index, paths: anchored } of paths.anchors) {
      const present = anchored.filter(p => basis.has(p));
      if (present.length === 0) reasons.push(`assumption-unanchored:${kind}:${index + 1}`);
      for (const p of present) {
        if (!head.has(p)) reasons.push(`assumption-deleted:${p}`);
        else if (!same(basis.get(p), head.get(p))) reasons.push(`assumption-changed:${p}`);
      }
    }
    for (const p of paths.affected.filter(isPath)) {
      if (!basis.has(p)) reasons.push(`affected-file-not-in-basis:${p}`);
      else if (!head.has(p)) reasons.push(`affected-file-deleted:${p}`);
      else if (!same(basis.get(p), head.get(p))) { reasons.push(`affected-file-changed:${p}`); changed.push(p); }
    }
    for (const p of paths.created) if (head.has(p)) reasons.push(`new-file-present:${p}`);
    const target = assessment.target;
    const candidate = !target ? undefined : target.commit !== null && target.commit === target.baseRevision ? 'current' : 'revalidate';
    if (target && candidate === 'revalidate') reasons.push(target.commit === null ? 'target-unresolved' : 'target-moved');
    const decision = reasons.some(r => !soft(r)) ? 'reassess'
      : reasons.some(r => r.startsWith('affected-file-changed:')) ? 'refresh' : 'reuse';
    return { decision, reasons: tidy(reasons), changedPaths: unique(changed).slice(0, 64), headCommit: assessment.headCommit,
      ...(candidate ? { candidate } : {}) };
  } catch (error) {
    return { decision: 'reassess', reasons: tidy([`source-unavailable: ${firstLine(error)}`]), changedPaths: [] };
  }
}
