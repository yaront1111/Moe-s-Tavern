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

import fs from 'node:fs';
import path from 'node:path';
import type { Task } from '../types/schema.js';
import { invalidInput } from './errors.js';

const MAX_PATH_LEN = 500;

// On case-insensitive filesystems (Windows — the daemon's primary target — and
// default macOS) `src/Foo.ts` and `src/foo.ts` are the SAME file. The daemon
// runs locally alongside the repo, so process.platform reflects the FS. Fold
// case only when comparing collisions; the stored/displayed path keeps its
// original casing.
const CASE_INSENSITIVE_FS = process.platform === 'win32' || process.platform === 'darwin';

/**
 * Case-fold a normalized project-relative path for comparison. Exported so
 * every consumer (collision detection here, the submit_plan existence gate)
 * folds with the SAME platform rule instead of inventing a second one.
 */
export function pathKey(p: string): string {
  return CASE_INSENSITIVE_FS ? p.toLowerCase() : p;
}

/** Internal alias kept for readability at the collision call sites. */
const collisionKey = pathKey;

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
 * Resolve normalized project-relative paths against the project root and return
 * the ones that do NOT exist on disk, in input order.
 *
 * Fail-open by design — this backs a submit-time gate, so every uncertainty is
 * resolved as "exists". Error handling rules:
 *   - an empty / unreadable / non-directory `projectRoot` returns `[]` (the
 *     daemon must never reject a plan just because it cannot see the tree)
 *   - only a genuine ENOENT/ENOTDIR counts as missing; any other errno
 *     (EACCES, ELOOP, EPERM, …) is treated as existing so a permission-
 *     restricted tree cannot false-reject a correct plan
 *   - an existing directory counts as existing
 *
 * A path that resolves outside the root is reported as missing (normalization
 * already rejects traversal; this is a second, defensive line).
 *
 * Probes run concurrently — this is called under the state mutex, so it must
 * never serialize N stat calls.
 */
export async function findMissingPaths(projectRoot: string, paths: string[]): Promise<string[]> {
  if (!projectRoot || typeof projectRoot !== 'string' || paths.length === 0) return [];
  let root: string;
  try {
    root = path.resolve(projectRoot);
    const rootStat = await fs.promises.stat(root);
    if (!rootStat.isDirectory()) return [];
  } catch {
    return [];
  }

  // Dedupe with the shared case-folding rule, preserving first-seen order.
  const seen = new Set<string>();
  const candidates: string[] = [];
  for (const p of paths) {
    const key = pathKey(p);
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push(p);
  }

  // A root that IS a filesystem root (`D:\`, `/`) already ends in a separator;
  // appending another would make every real child fail the prefix test and
  // false-reject the whole plan.
  const rootPrefix = root.endsWith(path.sep) ? root : root + path.sep;

  const results = await Promise.all(
    candidates.map(async (p) => {
      const resolved = path.resolve(root, p);
      if (resolved !== root && !resolved.startsWith(rootPrefix)) return true;
      try {
        await fs.promises.access(resolved);
        return false;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        return code === 'ENOENT' || code === 'ENOTDIR';
      }
    })
  );

  return candidates.filter((_, idx) => results[idx]);
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
 * Files every task appends to (changelogs, release notes). Overlapping on them
 * is expected, not a conflict, so they never produce a collision warning —
 * otherwise the warning fires on every claim and workers learn to ignore it.
 * Overridable per-project via `settings.appendOnlyFiles`.
 */
export const DEFAULT_APPEND_ONLY_FILES: readonly string[] = Object.freeze(['CHANGELOG.md']);

/**
 * Compile an append-only glob into an anchored RegExp. Grammar is deliberately
 * tiny (no dependency, no filesystem access — this runs under the claim mutex):
 *   `**\/`  → zero or more leading directories
 *   `**`   → anything, including `/`
 *   `*`    → anything within ONE path segment
 * Every other character is matched literally (regex punctuation escaped).
 * Case folding follows the collision-key policy so `changelog.md` and
 * `CHANGELOG.md` behave the same way here as they do for ownership.
 */
function appendOnlyPatternToRegExp(pattern: string): RegExp {
  // Hand-edited settings may carry Windows separators / a leading `./`.
  const normalized = pattern.replace(/\\/g, '/').replace(/^\.\//, '');
  let source = '';
  for (let i = 0; i < normalized.length; i++) {
    const ch = normalized[i];
    if (ch !== '*') {
      source += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      continue;
    }
    if (normalized[i + 1] === '*') {
      if (normalized[i + 2] === '/') {
        source += '(?:[^/]+/)*'; // `**/` also matches zero directories
        i += 2;
      } else {
        source += '.*';
        i += 1;
      }
    } else {
      source += '[^/]*';
    }
  }
  return new RegExp(`^${source}$`, CASE_INSENSITIVE_FS ? 'i' : '');
}

function compileAppendOnlyMatchers(patterns: readonly string[]): RegExp[] {
  // project.json is hand-editable, so a non-array survives to here despite
  // validateSettingsUpdate. Iterating a string would compile one matcher per
  // CHARACTER — fall back to the default instead of silently mangling it.
  const source = Array.isArray(patterns) ? patterns : DEFAULT_APPEND_ONLY_FILES;
  const matchers: RegExp[] = [];
  for (const pattern of source) {
    if (typeof pattern !== 'string') continue;
    const trimmed = pattern.trim();
    // Same bound settings validation applies, re-checked for hand-edited files.
    if (trimmed.length === 0 || trimmed.length > MAX_PATH_LEN) continue;
    matchers.push(appendOnlyPatternToRegExp(trimmed));
  }
  return matchers;
}

/**
 * Compute per-task file collisions for a candidate. Each entry pairs another
 * WORKING task id with the overlapping file list (sorted).
 *
 * `appendOnlyFiles` globs are dropped from the candidate's file set before
 * ownership lookup, so they never reach the returned warning. Pass `[]` to
 * report every overlap.
 */
export function computeFileCollisions(
  candidate: Task,
  tasks: Iterable<Task>,
  appendOnlyFiles: readonly string[] = DEFAULT_APPEND_ONLY_FILES
): FileCollision[] {
  // Compiled once per computation — patterns are bounded by settings validation.
  const appendOnlyMatchers = compileAppendOnlyMatchers(appendOnlyFiles);
  const candidateFiles = new Set(
    collectTaskAffectedFiles(candidate).filter(
      (file) => !appendOnlyMatchers.some((matcher) => matcher.test(file))
    )
  );
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
