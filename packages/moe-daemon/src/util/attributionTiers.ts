// =============================================================================
// Attribution tiers — the SINGLE definition of which paths a task has
// ASSERTED (positive evidence: committed regardless of the pre-task baseline)
// versus merely PLANNED (committed only when changed since the baseline).
// Shared by moe.get_commit_scope (what the wrapper stages) and moe.get_context
// (`declaredPaths`) so the two can never disagree.
//
// ASSERTED = ⋃_{steps COMPLETED}(modifiedFiles ?? affectedFiles)   ← exactly
//            what completeTask.ts folds into task.filesModified today
//          ∪ task.filesModified ∪ task.declaredFiles ∪ task.touchedFiles
//          ∪ ⋃ task.commits[].paths minus that commit's inferredPaths
// PLANNED  = (⋃_{ALL steps}(affectedFiles ∪ newFiles ∪ modifiedFiles)
//            ∪ task.inferredPaths) − ASSERTED
//
// Stored paths are worker-typed (complete_step does no normalization), so
// every entry is canonicalized through normalizeAffectedFile and deduped by
// pathKey; entries that cannot be normalized (absolute, traversal) are DROPPED
// rather than thrown — a peer's junk must never fail another task's scope.
// =============================================================================

import type { ImplementationStep, Task, TaskCommit } from '../types/schema.js';
import { normalizeAffectedFile, pathKey } from './affectedFiles.js';

/** Canonicalize one stored path; null when the daemon would refuse to store it. */
export function tolerantNormalizePath(raw: unknown): string | null {
  try {
    return normalizeAffectedFile(raw);
  } catch {
    return null;
  }
}

/**
 * Insertion-ordered set of project-relative paths keyed by `pathKey` (case-
 * folded on win32/darwin). The first-seen spelling is the one kept.
 */
export class PathSet {
  private readonly byKey = new Map<string, string>();

  /** Add a raw path; returns the stored (normalized) path, or null when dropped. */
  add(raw: unknown): string | null {
    const normalized = tolerantNormalizePath(raw);
    if (normalized === null) return null;
    const key = pathKey(normalized);
    const existing = this.byKey.get(key);
    if (existing !== undefined) return existing;
    this.byKey.set(key, normalized);
    return normalized;
  }

  addAll(raws: Iterable<unknown> | null | undefined): this {
    if (!raws) return this;
    for (const raw of raws) this.add(raw);
    return this;
  }

  has(path: string): boolean {
    const normalized = tolerantNormalizePath(path);
    return normalized !== null && this.byKey.has(pathKey(normalized));
  }

  delete(path: string): void {
    const normalized = tolerantNormalizePath(path);
    if (normalized !== null) this.byKey.delete(pathKey(normalized));
  }

  get size(): number {
    return this.byKey.size;
  }

  values(): string[] {
    return Array.from(this.byKey.values());
  }
}

function planSteps(task: Pick<Task, 'implementationPlan'>): ImplementationStep[] {
  return Array.isArray(task.implementationPlan) ? task.implementationPlan : [];
}

/**
 * The changed-file set completeTask.ts persists as `filesModified`: for every
 * COMPLETED step, `modifiedFiles || affectedFiles || []`. Kept as a separate
 * function so the mirror is auditable line-for-line against completeTask.ts.
 */
export function completedStepFiles(task: Pick<Task, 'implementationPlan'>): string[] {
  return planSteps(task)
    .filter((s) => s.status === 'COMPLETED')
    .flatMap((s) => s.modifiedFiles || s.affectedFiles || []);
}

/** A commit's paths minus the ones it attributed by measurement only. */
export function nonInferredCommitPaths(commit: TaskCommit): string[] {
  const inferred = new PathSet().addAll(commit.inferredPaths);
  const out = new PathSet();
  for (const p of commit.paths || []) {
    const normalized = tolerantNormalizePath(p);
    if (normalized === null || inferred.has(normalized)) continue;
    out.add(normalized);
  }
  return out.values();
}

export interface TaskPathTiers {
  /** Positive evidence — committed regardless of the pre-task baseline. */
  asserted: string[];
  /** Plan-declared only — committed only when changed since the baseline. */
  planned: string[];
}

/** ASSERTED tier for one task (see the header for the exact union). */
export function collectAssertedPaths(task: Task): string[] {
  const set = new PathSet();
  set.addAll(completedStepFiles(task));
  set.addAll(task.filesModified);
  set.addAll(task.declaredFiles);
  set.addAll(task.touchedFiles);
  for (const commit of task.commits || []) {
    set.addAll(nonInferredCommitPaths(commit));
  }
  return set.values();
}

/** Both tiers for one task; `planned` never overlaps `asserted`. */
export function collectTaskPathTiers(task: Task): TaskPathTiers {
  const asserted = collectAssertedPaths(task);
  const assertedSet = new PathSet().addAll(asserted);
  const planned = new PathSet();
  for (const step of planSteps(task)) {
    for (const raw of [...(step.affectedFiles || []), ...(step.newFiles || []), ...(step.modifiedFiles || [])]) {
      const normalized = tolerantNormalizePath(raw);
      if (normalized === null || assertedSet.has(normalized)) continue;
      planned.add(normalized);
    }
  }
  for (const raw of task.inferredPaths || []) {
    const normalized = tolerantNormalizePath(raw);
    if (normalized === null || assertedSet.has(normalized)) continue;
    planned.add(normalized);
  }
  return { asserted, planned: planned.values() };
}

/**
 * Every path another task lays claim to — its asserted AND planned tiers
 * (including touchedFiles). Used to build the PEER map in get_commit_scope.
 */
export function collectPeerPaths(task: Task): string[] {
  const tiers = collectTaskPathTiers(task);
  return new PathSet().addAll(tiers.asserted).addAll(tiers.planned).values();
}

export interface PathUnionResult {
  /** Existing entries verbatim (original spelling kept), then the new ones. */
  merged: string[];
  /** The incoming paths that were not already present (normalized form). */
  added: string[];
}

/**
 * Union already-normalized `incoming` paths into a stored list, deduping by
 * pathKey. Existing entries keep their exact spelling (they may be worker-
 * typed and un-normalized); only genuinely new paths are appended.
 */
export function unionPaths(existing: string[] | null | undefined, incoming: string[]): PathUnionResult {
  const merged: string[] = [];
  const seen = new Set<string>();
  for (const raw of Array.isArray(existing) ? existing : []) {
    if (typeof raw !== 'string' || raw.length === 0) continue;
    const normalized = tolerantNormalizePath(raw);
    const key = pathKey(normalized ?? raw);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(raw);
  }
  const added: string[] = [];
  for (const p of incoming) {
    const key = pathKey(p);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(p);
    added.push(p);
  }
  return { merged, added };
}
