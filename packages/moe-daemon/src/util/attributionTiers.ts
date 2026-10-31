// =============================================================================
// Attribution tiers — the SINGLE definition of which paths a task has
// ASSERTED (positive evidence of ownership) versus merely PLANNED (committed
// only when changed since the baseline). Shared by moe.get_commit_scope (what
// the wrapper stages) and moe.get_context (`declaredPaths`) so the two can
// never disagree.
//
// ASSERTED = ⋃_{steps COMPLETED}(modifiedFiles ?? affectedFiles)   ← exactly
//            what completeTask.ts folds into task.filesModified today
//          ∪ task.filesModified ∪ task.declaredFiles ∪ task.touchedFiles
//          ∪ ⋃ task.commits[].paths minus that commit's inferredPaths
// DECLARED = task.declaredFiles (moe.declare_files) ⊆ ASSERTED: the wrapper
//            commits these regardless of the pre-task baseline. Every other
//            ASSERTED path is history, and the wrapper commits it only when
//            its dirty bytes are this task's (MOE_ATTR_ASSERTED_FOREIGN).
// PLANNED  = (⋃_{ALL steps}(affectedFiles ∪ newFiles ∪ modifiedFiles)
//            ∪ task.inferredPaths) − ASSERTED
//
// Stored paths are worker-typed (complete_step does no normalization), so
// every entry is canonicalized through normalizeAffectedFile and deduped by
// pathKey; entries that cannot be normalized (absolute, traversal) are DROPPED
// rather than thrown — a peer's junk must never fail another task's scope. A
// list field that is not an array contributes nothing: it is never spread, and
// never iterated as characters.
// =============================================================================

import type { ImplementationStep, Task, TaskCommit } from '../types/schema.js';
import { normalizeAffectedFile, pathKey } from './affectedFiles.js';

/** A stored list field read from arbitrary JSON: the array itself, else nothing. */
function asList(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

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

  /** Add every entry of an array; anything that is not an array adds nothing. */
  addAll(raws: unknown): this {
    for (const raw of asList(raws)) this.add(raw);
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
  return asList(task.implementationPlan).filter(isRecord) as unknown as ImplementationStep[];
}

/**
 * The changed-file set completeTask.ts persists as `filesModified`: for every
 * COMPLETED step, `modifiedFiles || affectedFiles || []`. Kept as a separate
 * function so the mirror is auditable line-for-line against completeTask.ts.
 * It agrees with completeTask.ts on every well-formed record; the one
 * difference is junk-only: the selected value contributes nothing when it is
 * not an array (completeTask.ts itself is unchanged).
 */
export function completedStepFiles(task: Pick<Task, 'implementationPlan'>): string[] {
  return planSteps(task)
    .filter((s) => s.status === 'COMPLETED')
    .flatMap((s) => asList(s.modifiedFiles || s.affectedFiles) as string[]);
}

/** A commit's paths minus the ones it attributed by measurement only. */
export function nonInferredCommitPaths(commit: TaskCommit): string[] {
  const inferred = new PathSet().addAll(commit.inferredPaths);
  const out = new PathSet();
  for (const p of asList(commit.paths)) {
    const normalized = tolerantNormalizePath(p);
    if (normalized === null || inferred.has(normalized)) continue;
    out.add(normalized);
  }
  return out.values();
}

export interface TaskPathTiers {
  /** Positive evidence of ownership; only its `collectDeclaredPaths` part is committed regardless of the baseline. */
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
  for (const commit of asList(task.commits)) {
    if (isRecord(commit)) set.addAll(nonInferredCommitPaths(commit as unknown as TaskCommit));
  }
  return set.values();
}

/**
 * The explicit moe.declare_files part of ASSERTED, normalized the same way.
 * The wrapper commits these regardless of its baseline; the rest of ASSERTED
 * only when this task produced the dirty bytes.
 */
export function collectDeclaredPaths(task: Pick<Task, 'declaredFiles'>): string[] {
  return new PathSet().addAll(task.declaredFiles).values();
}

/** Both tiers for one task; `planned` never overlaps `asserted`. */
export function collectTaskPathTiers(task: Task): TaskPathTiers {
  const asserted = collectAssertedPaths(task);
  const assertedSet = new PathSet().addAll(asserted);
  const planned = new PathSet();
  for (const step of planSteps(task)) {
    for (const raw of [...asList(step.affectedFiles), ...asList(step.newFiles), ...asList(step.modifiedFiles)]) {
      const normalized = tolerantNormalizePath(raw);
      if (normalized === null || assertedSet.has(normalized)) continue;
      planned.add(normalized);
    }
  }
  for (const raw of asList(task.inferredPaths)) {
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
