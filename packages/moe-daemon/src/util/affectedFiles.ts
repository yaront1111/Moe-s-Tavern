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

// On case-insensitive filesystems (Windows — the daemon's primary target — and
// default macOS) `src/Foo.ts` and `src/foo.ts` are the SAME file. The daemon
// runs locally alongside the repo, so process.platform reflects the FS. Fold
// case only when comparing collisions; the stored/displayed path keeps its
// original casing.
const CASE_INSENSITIVE_FS = process.platform === 'win32' || process.platform === 'darwin';

function collisionKey(path: string): string {
  return CASE_INSENSITIVE_FS ? path.toLowerCase() : path;
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
  // case-folded file key → set of taskIds currently touching it
  const ownership = new Map<string, Set<string>>();
  for (const t of tasks) {
    if (t.id === excludeTaskId) continue;
    if (t.status !== 'WORKING') continue;
    const files = collectTaskAffectedFiles(t);
    for (const f of files) {
      const key = collisionKey(f);
      let owners = ownership.get(key);
      if (!owners) {
        owners = new Set();
        ownership.set(key, owners);
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
 * WORKING task id with the overlapping file list (sorted).
 */
export function computeFileCollisions(
  candidate: Task,
  tasks: Iterable<Task>
): FileCollision[] {
  const candidateFiles = new Set(collectTaskAffectedFiles(candidate));
  if (candidateFiles.size === 0) return [];
  const activeOwnership = collectActiveAffectedFiles(tasks, candidate.id);
  // Group hits by task
  const perTask = new Map<string, Set<string>>();
  for (const file of candidateFiles) {
    const owners = activeOwnership.get(collisionKey(file));
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
