import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { promisify } from 'node:util';
import { normalizeAffectedFile, pathKey } from './affectedFiles.js';

const execFileAsync = promisify(execFile);
const BUDGET_MS = 2000;
const MAX_BUFFER = 128 * 1024;
const MAX_FAILURE_CHARS = 240;

export interface CachedPlanPaths {
  ref: string;
  commit: string;
  paths: string[];
  warning: string;
}

/** Why the cached ref could not vouch for the paths; submit_plan puts it in its refusal. */
export interface CachedPlanMiss {
  miss: string;
}

/** Only an explicitly configured, literal consolidation branch is evidence. */
export function cachedPlanRef(branch: unknown): string | undefined {
  if (typeof branch !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/.test(branch)
      || branch.includes('..') || branch.includes('//') || branch.endsWith('/')
      || branch.endsWith('.') || branch.split('/').some(p => p.endsWith('.lock'))) return undefined;
  return `refs/remotes/origin/${branch}`;
}

export type PlanPathGitRunner = (args: string[], cwd: string, timeout: number, maxBuffer?: number) => Promise<string>;

export const runGit: PlanPathGitRunner = async (args, cwd, timeout, maxBuffer = MAX_BUFFER) => {
  // Do not inherit a seat's alternate index/repository/config. No shell, hooks,
  // replacement objects, optional locks, global config or network transports.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')));
  Object.assign(env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_NO_LAZY_FETCH: '1', GIT_TERMINAL_PROMPT: '0' });
  try {
    // Global config is deliberately masked, including safe.directory. Trust
    // only this explicitly configured, canonical project for these read-only
    // commands (e.g. a Windows checkout retaining its previous owner's SID).
    // Never write Git config or broaden this to safe.directory=*.
    const result = await execFileAsync('git', ['--no-optional-locks', '--no-replace-objects',
      '-c', 'protocol.allow=never', '-c', `safe.directory=${cwd}`, ...args],
    { cwd, env, timeout, maxBuffer, windowsHide: true });
    return result.stdout;
  } catch (error) {
    // git config returns 1 for no matching keys; every other failure is unknown.
    if (args[0] === 'config' && (error as { code?: unknown }).code === 1) return '';
    throw error;
  }
};

/** One line for a failed step: errno or exit code, the kill signal, else the first stderr line. */
function describeFailure(error: unknown): string {
  const e = (error ?? {}) as { code?: unknown; killed?: unknown; signal?: unknown; stderr?: unknown; message?: unknown };
  if (e.killed) return `killed (${String(e.signal ?? 'timeout')})`;
  const stderr = typeof e.stderr === 'string' ? e.stderr.trim() : '';
  const text = stderr || (typeof e.message === 'string' ? e.message : String(error));
  const code = e.code === undefined || e.code === null || text.startsWith(String(e.code)) ? '' : `${String(e.code)}: `;
  return `${code}${text.split(/\r?\n/)[0]}`.slice(0, MAX_FAILURE_CHARS);
}

/** Shared read-only trust envelope. All commands share one deadline, including setup. */
export async function openProjectGit(projectRoot: string, run: PlanPathGitRunner = runGit, budgetMs = BUDGET_MS) {
  const started = performance.now();
  const deadline = started + budgetMs;
  const failure = (step: string, error: unknown) => new Error(
    `${step}: ${describeFailure(error)} (${Math.round(performance.now() - started)} ms into the ${budgetMs} ms budget)`);
  const realpath = async (name: string, step: string) => {
    try { return await fs.promises.realpath(name); } catch (error) { throw failure(step, error); }
  };
  const root = await realpath(projectRoot, 'realpath');
  // A literal star directory must never become a subtree safe.directory rule.
  if (root.replace(/\\/g, '/').endsWith('/*')) {
    throw new Error(`project root ${root} ends in /*, which Git would read as a subtree trust rule`);
  }
  const git = async (label: string, args: string[], opts?: { maxBuffer?: number }) => {
    try {
      const remaining = Math.floor(deadline - performance.now());
      if (remaining <= 0) throw new Error('budget exhausted before the step started');
      return await run(args, root, remaining, opts?.maxBuffer);
    } catch (error) { throw failure(`git ${label}`, error); }
  };
  const top = (await git('rev-parse --show-toplevel', ['rev-parse', '--show-toplevel'])).trim();
  if (pathKey(await realpath(top, 'realpath of the Git toplevel')) !== pathKey(root)) {
    throw new Error(`Git toplevel ${top} is not the project root ${root}`);
  }
  // Older Git ignores GIT_NO_LAZY_FETCH: reject all hydratable/redirected repos,
  // including included local config, rather than risking an implicit fetch.
  const special = await git('config --get-regexp', ['config', '--local', '--includes', '--get-regexp',
    '^(extensions\\.partialclone|remote\\..*\\.promisor|core\\.worktree)$']);
  if (special.trim()) {
    throw new Error(`local Git config sets ${special.trim().split(/\s+/)[0]}; partial-clone, promisor and core.worktree repositories are never trusted`);
  }
  return git;
}

/**
 * Read-only fallback for a stale protected checkout. Call OUTSIDE the state
 * mutex. Nothing is fetched, checked out, staged or accepted on uncertainty.
 * Four bounded subprocesses total, independent of the number of paths. Ref
 * resolution is pinned once; a concurrent ref advance cannot mix two trees.
 * Every refusal names its reason: a silent miss cannot tell a stale ref from
 * a daemon that cannot run Git.
 */
export async function findCachedPlanPaths(
  projectRoot: string, branch: unknown, missing: string[], run: PlanPathGitRunner = runGit,
): Promise<CachedPlanPaths | CachedPlanMiss> {
  const ref = cachedPlanRef(branch);
  if (!ref) {
    const shown = typeof branch === 'string' ? JSON.stringify(branch.slice(0, 80)) : String(branch ?? null);
    return { miss: `consolidationBranch ${shown} is not a literal branch name` };
  }
  if (missing.length === 0 || missing.length > 100 || missing.join('').length > 24000) {
    return { miss: 'the path list is empty or over the 100-path / 24000-character lookup limit' };
  }
  try {
    // Defense in depth: callers pass normalized paths, never pathspecs. The
    // normalizer throws on traversal and absolute paths: those are not normalized.
    const normalized = (p: string) => { try { return normalizeAffectedFile(p) === p; } catch { return false; } };
    if (missing.some(p => !normalized(p) || p.includes('\0'))) {
      return { miss: 'a path is not in normalized project-relative form' };
    }
    const git = await openProjectGit(projectRoot, run);
    const commit = (await git('rev-parse --verify', ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`])).trim();
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(commit)) return { miss: `${ref} did not resolve to a commit id` };
    // ls-tree does not support icase pathspec magic. Cached evidence requires
    // the exact committed spelling, even on Windows; filesystem/collision
    // normalization is unchanged. Never combine global literal/other magic.
    const listing = await git('ls-tree', ['--literal-pathspecs',
      'ls-tree', '-z', '--full-tree', commit, '--', ...missing]);
    if (listing && !listing.endsWith('\0')) return { miss: `unparsable ls-tree output for ${ref}` };
    const keys = new Set<string>();
    for (const entry of listing.split('\0').filter(Boolean)) {
      const match = /^(?:[0-7]{6}) (?:blob|tree|commit) [0-9a-f]{40,64}\t([\s\S]+)$/.exec(entry);
      if (!match) return { miss: `unparsable ls-tree output for ${ref}` };
      keys.add(pathKey(match[1]));
    }
    const paths = missing.filter(p => keys.has(pathKey(p)));
    if (!paths.length) return { miss: `${ref} at ${commit.slice(0, 12)} does not contain them either` };
    return { ref, commit, paths, warning:
      `Stale worktree: paths were found in cached ${ref} at ${commit}, not on disk. ` +
      'This is not proof of remote freshness or task delivery. Use the committed source; do not hide paths in newFiles.' };
  } catch (error) {
    // Missing Git/ref, timeout, oversized output, bad config or unreadable
    // objects preserve the ordinary missing-path rejection. Never fetch.
    return { miss: error instanceof Error ? error.message : describeFailure(error) };
  }
}
