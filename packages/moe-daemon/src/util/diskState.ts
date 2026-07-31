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
 */
export const defaultGitRunner: GitRunner = async (args, cwd) => {
  const { stdout } = await execFileAsync('git', args, {
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
