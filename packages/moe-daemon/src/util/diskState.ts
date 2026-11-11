// =============================================================================
// Disk-state signature — git-derived fingerprint of the working tree
// =============================================================================
//
// A handoff note describes a tree ("this file does not compile", "the fix is
// half applied"). By the time the next worker claims the task, that tree may be
// gone — someone else committed, or the post-flight auto-commit pushed. This
// helper produces a cheap opaque signature so `claim_next_task` can tell the
// claimer the note may be describing a tree that no longer exists.
//
// TWO INVARIANTS, both load-bearing:
//
//  1. `undefined` means "unknown", NEVER "unchanged". Every failure mode (git
//     not installed, not a repository, timeout, unparsable output) degrades to
//     `undefined`, and every caller must treat that as "no information" — never
//     as evidence the tree is the same. A false "stale" alarm is worse than
//     silence: it teaches workers to ignore the flag.
//
//  2. Callers MUST invoke this OUTSIDE the state mutex. It spawns a git
//     subprocess that can take up to the 3s timeout; tool dispatch is
//     serialized through one global reentrant mutex, so running it under the
//     lock would freeze every tool fleet-wide.

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { gitExecutable } from './gitExecutable.js';
import { pathKey } from './affectedFiles.js';

const execFileAsync = promisify(execFile);

const GIT_TIMEOUT_MS = 3000;
const GIT_MAX_BUFFER = 8 * 1024 * 1024;

/** Runs git with the given args in `cwd` and resolves stdout. Injectable for tests. */
export type GitRunner = (args: string[], cwd: string) => Promise<string>;

/**
 * Real git runner. `execFile` with an args array (never a shell string) so
 * paths with spaces and shell metacharacters are inert on Windows, the
 * daemon's primary platform; `windowsHide` keeps a console window from
 * flashing when the daemon runs under an IDE-spawned process.
 *
 * It spawns the shared absolute git (gitExecutable), never a bare `git` that
 * Windows would look up in `cwd` first. It deliberately does NOT adopt
 * cachedPlanPaths' readOnlyGitEnv/readOnlyGitArgs: masking global/system
 * config (core.excludesFile ignores, Git for Windows' system core.autocrlf)
 * changes which paths `git status` lists, so the equality-only signature
 * would flap and raise false stale alarms (invariant 1) and POSIX behaviour
 * would change. The absolute path already closes the binary-planting vector.
 * A resolution miss rejects here, which computeDiskStateSignature maps to
 * `undefined`.
 */
export const defaultGitRunner: GitRunner = async (args, cwd) => {
  const { stdout } = await execFileAsync(gitExecutable(), args, {
    cwd,
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: GIT_MAX_BUFFER,
    windowsHide: true,
  });
  return stdout;
};

// `--no-optional-locks` keeps the daemon from refreshing the index of a tree a
// worker is actively using. `--porcelain=v2 --branch` is one subprocess for
// both halves of the signature: the `# branch.oid` header gives HEAD, the
// non-header lines give the per-path change list. Untracked mode is left at
// git's default — `-uall` would walk huge build-artifact trees.
const GIT_STATUS_ARGS = ['--no-optional-locks', 'status', '--porcelain=v2', '--branch'];

const BRANCH_OID_PREFIX = '# branch.oid ';

/**
 * Compute an opaque signature of the working tree at `projectPath`.
 *
 * Format: `v1:<head-oid>:<changeCount>:<first 12 hex of sha256(change lines)>`.
 * Only ever compared for equality — no consumer parses the parts.
 *
 * Returns `undefined` on ANY failure. Never throws, never logs.
 */
export async function computeDiskStateSignature(
  projectPath: string,
  run: GitRunner = defaultGitRunner
): Promise<string | undefined> {
  try {
    const stdout = await run(GIT_STATUS_ARGS, projectPath);
    if (typeof stdout !== 'string' || stdout.length === 0) return undefined;

    const lines = stdout.split('\n').map(l => l.replace(/\r$/, ''));
    let oid: string | undefined;
    const changeLines: string[] = [];
    for (const line of lines) {
      if (line.startsWith('#')) {
        if (oid === undefined && line.startsWith(BRANCH_OID_PREFIX)) {
          const value = line.slice(BRANCH_OID_PREFIX.length).trim();
          if (value.length > 0) oid = value;
        }
        continue;
      }
      if (line.length === 0) continue;
      changeLines.push(line);
    }
    // No HEAD oid means this is not output we understand (not a repo, a
    // truncated read, a future porcelain format) — unknown, not unchanged.
    if (!oid) return undefined;

    const digest = createHash('sha256').update(changeLines.join('\n')).digest('hex');
    return `v1:${oid}:${changeLines.length}:${digest.slice(0, 12)}`;
  } catch {
    // git missing (ENOENT), not a repository (exit 128), timeout/kill, buffer
    // overflow — all indistinguishable to the caller and all mean "unknown".
    return undefined;
  }
}

// -----------------------------------------------------------------------------
// Dirty paths — which of a few named paths the working tree has changed
// -----------------------------------------------------------------------------

/**
 * At most this many paths go to one `git status` call. The list is a pathspec
 * on the command line, and 200 project-relative paths stay far below Windows'
 * 32767-character limit. Paths past the cap are not checked (a caller sees
 * them as not dirty).
 */
export const DIRTY_PATHS_MAX = 200;

/** The text after the `fields`-th space of a porcelain v2 record: its path. */
function porcelainPathAfter(record: string, fields: number): string | null {
  let at = -1;
  for (let i = 0; i < fields; i += 1) {
    at = record.indexOf(' ', at + 1);
    if (at < 0) return null;
  }
  const rest = record.slice(at + 1);
  return rest.length > 0 ? rest : null;
}

/**
 * The entries of `paths` (project-relative, as stored) that git reports
 * changed in the working tree at `projectPath`: modified, staged, deleted,
 * renamed (old and new name), unmerged or untracked. Ignored files never count.
 *
 * One `git status --porcelain=v2 -z` limited to `paths` as literal pathspecs,
 * so it never walks the rest of the tree, and `-z` leaves names unquoted.
 * Porcelain paths are relative to the repository root, so `projectPath` must
 * be that root; from a subdirectory nothing matches (the safe direction).
 *
 * Invariant 1 above applies: `undefined` means unknown (git missing, not a
 * repository, timeout, output not understood), never "clean". Invariant 2
 * too: call it OUTSIDE the state mutex. Never throws.
 */
export async function listDirtyPaths(
  projectPath: string,
  paths: readonly string[],
  run: GitRunner = defaultGitRunner
): Promise<string[] | undefined> {
  try {
    const asked = paths.filter((p) => typeof p === 'string' && p.length > 0).slice(0, DIRTY_PATHS_MAX);
    if (asked.length === 0) return [];
    const stdout = await run(
      ['--literal-pathspecs', '--no-optional-locks', 'status', '--porcelain=v2', '-z', '--untracked-files=all', '--', ...asked],
      projectPath
    );
    if (typeof stdout !== 'string') return undefined;
    const dirty = new Set<string>();
    const records = stdout.split('\0');
    for (let i = 0; i < records.length; i += 1) {
      const record = records[i];
      if (!record || record.startsWith('#')) continue;
      let changed: string | null = null;
      switch (record[0]) {
        case '1': changed = porcelainPathAfter(record, 8); break;
        case '2': {
          // A rename or copy: the original name is the next NUL-separated field.
          changed = porcelainPathAfter(record, 9);
          const original = records[i + 1];
          i += 1;
          if (original) dirty.add(pathKey(original));
          break;
        }
        case 'u': changed = porcelainPathAfter(record, 10); break;
        case '?': changed = record.length > 2 ? record.slice(2) : null; break;
        default: break; // '!' (ignored) and anything newer: not a change we land
      }
      if (changed) dirty.add(pathKey(changed));
    }
    return asked.filter((p) => dirty.has(pathKey(p)));
  } catch {
    return undefined;
  }
}
