// =============================================================================
// The one git the daemon runs
// =============================================================================
//
// On Windows libuv looks for a bare command name in the spawn cwd (.com, then
// .exe) before PATH, ignoring NoDefaultCurrentDirectoryInExePath, and resolves
// relative PATH entries against that cwd too. So execFile('git', ..., { cwd:
// <project> }) ran a git.exe committed to the repository as the daemon user
// (measured node 24.16 / libuv 1.52.1). Every daemon git spawn must therefore
// use gitExecutable(). CQ-R01's IDE-side PATH filtering pins the daemon's own
// working directory only, not the cwd of a spawn.

import fs from 'node:fs';
import path from 'node:path';

/** Drive-absolute (`X:\` or `X:/`) or UNC (`\\host`, `//host`). Anything else is cwd-relative to libuv. */
const FULLY_QUALIFIED = /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/])/;

function isRegularFile(file: string): boolean {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/**
 * Absolute path of the git to run. POSIX returns the bare name unprobed
 * (execvp does the PATH lookup). On win32 the first `git.com` / `git.exe` in a
 * fully qualified PATH entry wins, in PATH order and libuv's .com-before-.exe
 * order; blank, relative, drive-relative and root-relative entries are skipped.
 * PATHEXT is not consulted: libuv only runs .com/.exe, and Node refuses a
 * .cmd/.bat without a shell. Throws an ENOENT error on a miss and never falls
 * back to the bare name.
 */
export function resolveGitExecutable(
  platform: NodeJS.Platform,
  pathValue: string,
  isFile: (file: string) => boolean = isRegularFile,
): string {
  if (platform !== 'win32') return 'git';
  for (const raw of pathValue.split(';')) {
    const dir = raw.trim().replace(/^"(.*)"$/, '$1');
    if (!FULLY_QUALIFIED.test(dir)) continue;
    for (const name of ['git.com', 'git.exe']) {
      const candidate = path.win32.join(dir, name);
      if (isFile(candidate)) return candidate;
    }
  }
  throw Object.assign(new Error('git.com or git.exe not found in any fully qualified PATH entry'), { code: 'ENOENT' });
}

let resolved: string | undefined;

/**
 * Lazy and cached on success (a missing git must not break the import, and a
 * later call retries once git is installed). Call it inside the runner's
 * try/async scope so a miss is classified like a spawn ENOENT.
 */
export function gitExecutable(): string {
  return (resolved ??= resolveGitExecutable(process.platform, process.env.PATH ?? ''));
}
