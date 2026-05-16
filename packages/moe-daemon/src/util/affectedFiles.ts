// =============================================================================
// Affected files — normalization + collision detection
// =============================================================================
//
// Plans declare which files each step will touch. We normalize paths to a
// canonical forward-slash form and reject obviously-invalid ones (absolute
// paths, traversal). At claim time we compare the candidate task's affected
// files against the union from every other WORKING task so a worker can see
// they're about to step on someone else's diff.
//
// Normalization is intentionally minimal: workers paste paths in many forms
// (forward, back, leading `./`). We standardize but don't try to resolve
// against the project root — the daemon doesn't know which subprojects the
// agent considers canonical.

import type { Task } from '../types/schema.js';
import { invalidInput } from './errors.js';

const MAX_PATH_LEN = 500;

/**
 * Default append-only files — every task touches these (CHANGELOG, etc.) so
 * collision alerts on them are pure noise. Overridable via
 * ProjectSettings.appendOnlyFiles (pass [] to disable, or a custom list to
 * extend / replace).
 */
export const DEFAULT_APPEND_ONLY_FILES: readonly string[] = ['CHANGELOG.md'];

/**
 * Match a candidate file against an append-only pattern. Supports either a
 * literal path or a glob with `*` (single segment) or `**` (any depth).
 * Patterns are matched against canonical (normalized) paths.
 */
export function matchesAppendOnlyPattern(file: string, pattern: string): boolean {
  if (pattern === file) return true;
  if (!pattern.includes('*')) return false;
  // Escape regex specials except *, then translate ** -> .* and * -> [^/]*
  const re = '^' + pattern
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '__GLOBSTAR__')
    .replace(/\*/g, '[^/]*')
    .replace(/__GLOBSTAR__/g, '.*') + '$';
  return new RegExp(re).test(file);
}

/** True if the file matches any pattern in the append-only list. */
export function isAppendOnlyFile(file: string, patterns: readonly string[]): boolean {
  for (const p of patterns) {
    if (matchesAppendOnlyPattern(file, p)) return true;
  }
  return false;
}

/**
 * Canonicalize a single affected-file path. Throws `invalidInput` on shapes
 * the daemon refuses to store:
 *   - empty / non-string
 *   - contains `..` segments (traversal)
 *   - absolute Unix path (`/...`)
 *   - absolute Windows path (`C:\...`)
 *   - exceeds MAX_PATH_LEN characters
 *
 * Returns the normalized form: backslashes → forward slashes, leading `./`
 * stripped, trailing whitespace trimmed.
 */
export function normalizeAffectedFile(raw: unknown, fieldName = 'affectedFiles'): string {
  if (typeof raw !== 'string') {
    throw invalidInput(fieldName, 'each entry must be a string');
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw invalidInput(fieldName, 'entry cannot be empty');
  }
  if (trimmed.length > MAX_PATH_LEN) {
    throw invalidInput(fieldName, `entry too long (max ${MAX_PATH_LEN} chars)`);
  }
  // Normalize separators and strip a leading `./`.
  let p = trimmed.replace(/\\/g, '/').replace(/^\.\//, '');
  // Refuse leading slash (absolute Unix path).
  if (p.startsWith('/')) {
    throw invalidInput(fieldName, `paths must be project-relative (got "${raw}")`);
  }
  // Refuse Windows drive letters.
  if (/^[A-Za-z]:\//.test(p)) {
    throw invalidInput(fieldName, `paths must be project-relative (got "${raw}")`);
  }
  // Refuse traversal segments anywhere. (Collapsing `..` is risky because we
  // don't know the project root; safer to reject and ask the agent to normalize.)
  const segments = p.split('/');
  if (segments.some((seg) => seg === '..')) {
    throw invalidInput(fieldName, `path traversal not allowed (got "${raw}")`);
  }
  // Drop `.` segments and empty segments (consecutive slashes).
  p = segments.filter((seg) => seg !== '' && seg !== '.').join('/');
  if (p.length === 0) {
    throw invalidInput(fieldName, `entry resolves to empty path (got "${raw}")`);
  }
  return p;
}

/**
 * Normalize an array of affected files, deduplicating while preserving the
 * first-seen order.
 */
export function normalizeAffectedFiles(raw: unknown, fieldName = 'affectedFiles'): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw invalidInput(fieldName, 'must be an array of strings');
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of raw) {
    const normalized = normalizeAffectedFile(entry, fieldName);
    if (!seen.has(normalized)) {
      seen.add(normalized);
      out.push(normalized);
    }
  }
  return out;
}

/**
 * Collect every affectedFile referenced by tasks currently in WORKING.
 * Filters out the candidate task (so claiming a task you released doesn't
 * report you as colliding with yourself).
 */
export function collectActiveAffectedFiles(
  tasks: Iterable<Task>,
  excludeTaskId: string
): Map<string, Set<string>> {
  // file → set of taskIds currently touching it
  const ownership = new Map<string, Set<string>>();
  for (const t of tasks) {
    if (t.id === excludeTaskId) continue;
    if (t.status !== 'WORKING') continue;
    const files = collectTaskAffectedFiles(t);
    for (const f of files) {
      let owners = ownership.get(f);
      if (!owners) {
        owners = new Set();
        ownership.set(f, owners);
      }
      owners.add(t.id);
    }
  }
  return ownership;
}

/**
 * Pull the deduped affectedFiles for a single task across all its steps.
 */
export function collectTaskAffectedFiles(task: Task): string[] {
  const seen = new Set<string>();
  for (const step of task.implementationPlan || []) {
    for (const f of step.affectedFiles || []) {
      if (typeof f === 'string' && f.length > 0) seen.add(f);
    }
  }
  return Array.from(seen);
}

export interface FileCollision {
  task: string;
  files: string[];
}

/**
 * Compute per-task file collisions for a candidate. Each entry pairs another
 * WORKING task id with the overlapping file list (sorted). Files matching the
 * project's append-only list (CHANGELOG.md etc.) are filtered out before
 * grouping so the team isn't drowned in CHANGELOG-overlap noise.
 */
export function computeFileCollisions(
  candidate: Task,
  tasks: Iterable<Task>,
  appendOnlyPatterns: readonly string[] = DEFAULT_APPEND_ONLY_FILES
): FileCollision[] {
  const allCandidateFiles = collectTaskAffectedFiles(candidate);
  const candidateFiles = new Set(
    allCandidateFiles.filter((f) => !isAppendOnlyFile(f, appendOnlyPatterns))
  );
  if (candidateFiles.size === 0) return [];
  const activeOwnership = collectActiveAffectedFiles(tasks, candidate.id);
  // Group hits by task
  const perTask = new Map<string, Set<string>>();
  for (const file of candidateFiles) {
    const owners = activeOwnership.get(file);
    if (!owners) continue;
    for (const owner of owners) {
      let bucket = perTask.get(owner);
      if (!bucket) {
        bucket = new Set();
        perTask.set(owner, bucket);
      }
      bucket.add(file);
    }
  }
  return Array.from(perTask.entries())
    .map(([task, files]) => ({ task, files: Array.from(files).sort() }))
    .sort((a, b) => a.task.localeCompare(b.task));
}
