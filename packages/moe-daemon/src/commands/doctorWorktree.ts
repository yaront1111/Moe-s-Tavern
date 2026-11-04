// Worktree-mode readiness probes for `moe-daemon doctor` (epic-dce3a64f §7.3): hard checks while
// resolveWorktreeMode(settings) is 'on', info while 'off'. Read-only: project.json, task records
// and bounded argv-only Git reads through runGit (masked GIT_* env, no network, no locks).

import fs from 'fs';
import path from 'path';
import { pathKey } from '../util/affectedFiles.js';
import { cachedPlanRef, runGit, type PlanPathGitRunner } from '../util/cachedPlanPaths.js';
import { isSameProjectPath } from '../util/projectPath.js';
import { resolveWorktreeMode, resolveWorktreeTarget } from '../state/validators.js';
import type { ProbeResult } from './doctor.js';

const GIT_TIMEOUT_MS = 2_000;
const GIT_MAX_BUFFER = 128 * 1024;
const CONTROL_REF = 'refs/heads/moe/control';
const STALE_WORKTREE_MS = 24 * 60 * 60_000;
const TASK_ID = /^task-[A-Za-z0-9_-]{1,64}$/;

export interface WorktreeProbeOptions { git?: PlanPathGitRunner; now?: number }
type Settings = Record<string, unknown>;
// code: git's numeric exit status, when it ran and failed (merge-base --is-ancestor answers "no" with 1).
type Git = (args: string[]) => Promise<{ ok: true; out: string } | { ok: false; why: string; code?: number }>;
interface WorktreeRecord { path: string; branch?: string }

const isRecord = (v: unknown): v is Settings => typeof v === 'object' && v !== null && !Array.isArray(v);
const verdict = (hard: boolean, ok: boolean, message: string): ProbeResult =>
  ({ symbol: hard ? (ok ? 'pass' : 'fail') : 'info', message });
const shown = (v: string) => JSON.stringify(v.length > 120 ? `${v.slice(0, 120)}…` : v);

/** The mode line. An unreadable or invalid setting fails; it never silently means 'off'. */
function resolveMode(moePath: string): { settings?: Settings; hard: boolean; probe: ProbeResult } {
  const unknown = (why: string) => ({ hard: false, probe: { symbol: 'fail' as const, message: `${why}; readiness unknown (probes below are info)` } });
  let project: unknown = {};
  try {
    project = JSON.parse(fs.readFileSync(path.join(moePath, 'project.json'), 'utf-8'));
  } catch (err) {
    // Never echo the content: JSON.parse messages quote the input.
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== 'ENOENT') return unknown(code ? `project.json unreadable (${code})` : 'project.json is not valid JSON');
  }
  const settings = isRecord(project) ? project.settings : undefined;
  if (!isRecord(project) || (settings !== undefined && !isRecord(settings))) return unknown('project.json settings is not an object');
  try {
    return resolveWorktreeMode(settings) === 'on'
      ? { settings, hard: true, probe: { symbol: 'pass', message: 'on (the readiness probes below are hard checks)' } }
      : { settings, hard: false, probe: { symbol: 'info', message: 'off (the readiness probes below are informational)' } };
  } catch {
    return { settings, ...unknown("settings.worktreeMode is neither 'off' nor 'on'") };
  }
}

/** One bounded line: timeout, missing git, overflow, else the exit code and git's first stderr line. */
function describeGitFailure(err: unknown): string {
  const e = (err ?? {}) as { code?: unknown; killed?: unknown; stderr?: unknown };
  if (e.killed) return `timed out after ${GIT_TIMEOUT_MS} ms`;
  if (e.code === 'ENOENT') return 'git not found';
  if (e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return `output exceeded ${GIT_MAX_BUFFER} bytes`;
  const first = typeof e.stderr === 'string' ? e.stderr.trim().split(/\r?\n/)[0] : '';
  return `${typeof e.code === 'number' ? `exit ${e.code}` : 'failed'}${first ? `: ${first}` : ''}`.slice(0, 200);
}

/** `git worktree list --porcelain -z`: NUL-terminated fields; an empty field ends a record. */
function parseWorktreeList(out: string): WorktreeRecord[] | undefined {
  if (!out.endsWith('\0')) return undefined;
  const records: WorktreeRecord[] = [];
  let current: WorktreeRecord | undefined;
  for (const field of out.slice(0, -1).split('\0')) {
    if (field.startsWith('worktree ')) records.push(current = { path: field.slice(9) });
    else if (field === '') current = undefined;
    else if (!current) return undefined;
    else if (field.startsWith('branch ')) current.branch = field.slice(7);
  }
  return records.length > 0 ? records : undefined;
}

async function probeGitVersion(git: Git, hard: boolean): Promise<ProbeResult> {
  const read = await git(['version']);
  if (!read.ok) return verdict(hard, false, `cannot run git (${read.why})`);
  const m = /^git version (\d+)\.(\d+)/.exec(read.out.trim());
  if (!m) return verdict(hard, false, 'unrecognized `git version` output; need git >= 2.38');
  const ok = Number(m[1]) > 2 || (Number(m[1]) === 2 && Number(m[2]) >= 38);
  return verdict(hard, ok, `git ${m[1]}.${m[2]} ${ok ? 'meets' : 'is older than'} 2.38 (merge-tree --write-tree)`);
}

async function probeProjectRoot(git: Git, root: string, hard: boolean): Promise<ProbeResult> {
  const read = await git(['rev-parse', '--show-toplevel']);
  if (!read.ok) return verdict(hard, false, `not a Git work tree (${read.why})`);
  const top = read.out.trim();
  let realTop = top;
  try { realTop = fs.realpathSync.native(top); } catch { /* compare as printed */ }
  if (top && pathKey(realTop) === pathKey(root)) return verdict(hard, true, 'project is its repository top level');
  return verdict(hard, false, `repository top level is ${shown(top)}, not the project; nested projects cannot use worktree mode`);
}

/** `git merge-base --is-ancestor A B`: true (exit 0), false (exit 1), or why it could not answer. */
async function isAncestor(git: Git, ancestor: string, descendant: string): Promise<boolean | string> {
  const read = await git(['merge-base', '--is-ancestor', ancestor, descendant]);
  if (read.ok) return true;
  return read.code === 1 ? false : read.why;
}

async function probeControlBranch(git: Git, target: string, hard: boolean): Promise<ProbeResult> {
  const read = await git(['symbolic-ref', '-q', 'HEAD']);
  if (!read.ok) return verdict(hard, false, `HEAD is detached or unreadable (${read.why}); need ${CONTROL_REF}`);
  const head = read.out.trim();
  if (head !== CONTROL_REF) {
    return verdict(hard, false, `control checkout HEAD is ${shown(head)}, not ${CONTROL_REF} (git switch -c moe/control ${shown(target)})`);
  }
  // The follow fast-forwards moe/control to the target, so moe/control must be its ancestor (behind or equal is
  // normal between a landing and the follow). A non-literal target is the target line's failure, not this one's.
  if (!cachedPlanRef(target)) return verdict(hard, true, `control checkout is on ${CONTROL_REF}`);
  const follows = await isAncestor(git, CONTROL_REF, `refs/heads/${target}`);
  if (follows === true) return verdict(hard, true, `control checkout is on ${CONTROL_REF}, an ancestor of ${target}`);
  if (follows === false) {
    return verdict(hard, false, `${CONTROL_REF} holds commits ${target} lacks, so the control checkout cannot follow the target `
      + `(MOE_CONTROL_CHECKOUT_DIVERGED) and QA's landed gate stops every claim; reconcile moe/control by hand`);
  }
  return verdict(hard, false, `cannot tell whether ${CONTROL_REF} is an ancestor of ${target} (${follows})`);
}

async function probeTarget(git: Git, target: string, listed: WorktreeRecord[] | string, hard: boolean): Promise<ProbeResult> {
  // cachedPlanRef is the daemon's literal-branch-name rule (it rejects revision syntax such as main~1)
  // and names origin's remote-tracking copy of the target.
  const origin = cachedPlanRef(target);
  if (!origin) return verdict(hard, false, `target ${shown(target)} is not a literal branch name`);
  const ref = `refs/heads/${target}`;
  const read = await git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  if (!read.ok) return verdict(hard, false, `target ${target}: ${ref} does not resolve to a commit (${read.why})`);
  if (typeof listed === 'string') return verdict(hard, false, `target ${target}: cannot list worktrees (${listed})`);
  const holders = listed.filter((w) => w.branch === ref).map((w) => shown(w.path));
  if (holders.length > 0) return verdict(hard, false, `target ${target} is checked out at ${holders.join(', ')}; landings update it by ref`);
  return probeOriginTarget(git, target, ref, origin, hard);
}

/**
 * Remote mode is the launchers' rule: `git remote` prints anything. They then cut every new task worktree from
 * origin's copy of the target and land onto it, so that copy must exist and contain the local target. Doctor
 * never fetches: it reads origin's copy as last fetched.
 */
async function probeOriginTarget(git: Git, target: string, ref: string, origin: string, hard: boolean): Promise<ProbeResult> {
  const remotes = await git(['remote']);
  if (!remotes.ok) return verdict(hard, false, `target ${target}: cannot list remotes (${remotes.why})`);
  if (remotes.out.trim() === '') return verdict(hard, true, `target ${target} exists and is not checked out in any worktree`);
  const cut = await git(['rev-parse', '--verify', '--quiet', `${origin}^{commit}`]);
  if (!cut.ok) {
    return verdict(hard, false, `target ${target}: remote mode cuts every task worktree from ${origin}, which does not resolve `
      + `(${cut.why}), so each worker seat would stop with MOE_WORKTREE_CREATE_FAILED; push ${target} to origin, or fetch it`);
  }
  const contained = await isAncestor(git, ref, origin);
  if (contained === true) return verdict(hard, true, `target ${target} exists, is not checked out in any worktree, and ${origin} contains it`);
  if (contained === false) {
    return verdict(hard, false, `target ${target}: ${ref} holds commits ${origin} lacks, so every landing would stop with `
      + `MOE_LAND_TARGET_DIVERGED; push or reconcile it (fetch first if origin moved elsewhere)`);
  }
  return verdict(hard, false, `target ${target}: cannot tell whether ${ref} is an ancestor of ${origin} (${contained})`);
}

function probeQualityGate(settings: Settings | undefined, hard: boolean): ProbeResult {
  const gate = settings?.qualityGate;
  return typeof gate === 'string' && gate.trim() !== ''
    ? verdict(hard, true, 'settings.qualityGate is set (every worktree landing runs it)')
    : verdict(hard, false, 'settings.qualityGate is not set; every worktree landing requires a gate');
}

/**
 * Tasks carry no archivedAt or terminal-transition time, so updatedAt (the last write)
 * is the age: a conservative lower bound on how long the task has been terminal.
 */
function terminalAge(moePath: string, id: string, now: number): 'stale' | 'recent' | 'unknown' {
  const file = path.join(moePath, 'tasks', `${id}.json`);
  try {
    if (!fs.lstatSync(file).isFile()) return 'unknown';
    const task: unknown = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (!isRecord(task) || task.id !== id) return 'unknown';
    if (task.status !== 'DONE' && task.status !== 'ARCHIVED') return 'recent';
    const at = typeof task.updatedAt === 'string' ? Date.parse(task.updatedAt) : NaN;
    if (!Number.isFinite(at)) return 'unknown';
    return now - at > STALE_WORKTREE_MS ? 'stale' : 'recent';
  } catch {
    return 'unknown';
  }
}

/** Soft only: a stale or unknown task worktree is never a failure, and doctor removes nothing. */
function probeStaleWorktrees(listed: WorktreeRecord[] | string, root: string, moePath: string, now: number, hard: boolean): ProbeResult {
  if (typeof listed === 'string') return { symbol: 'info', message: `skipped: no worktree listing (${listed})` };
  const found = { stale: [] as string[], recent: [] as string[], unknown: [] as string[] };
  for (const record of listed) {
    // Real path, so a .worktrees/<id> link that leaves the project is not one of ours.
    let where = record.path;
    try { where = fs.realpathSync.native(where); } catch { /* another OS's spelling: compare as listed */ }
    const id = path.basename(where);
    if (TASK_ID.test(id) && isSameProjectPath(path.dirname(where), path.join(root, '.worktrees'))) {
      found[terminalAge(moePath, id, now)].push(id);
    }
  }
  const { stale, unknown } = found;
  const unknownNote = unknown.length > 0 ? `${unknown.length} with task age unknown: ${unknown.join(', ')}` : '';
  if (stale.length > 0) {
    return { symbol: hard ? 'warn' : 'info', message: `${stale.length} task worktree${stale.length === 1 ? '' : 's'} `
      + `DONE/ARCHIVED >24h by task updatedAt (the orphan sweep is behind): ${stale.join(', ')}${unknownNote ? `; ${unknownNote}` : ''}` };
  }
  if (unknownNote) return { symbol: 'info', message: `no stale task worktree; ${unknownNote}` };
  return verdict(hard, true, 'no task worktree is DONE/ARCHIVED >24h');
}

export async function probeWorktreeReadiness(
  projectPath: string, moePath: string, options: WorktreeProbeOptions = {},
): Promise<Array<[string, ProbeResult]>> {
  const { settings, hard, probe } = resolveMode(moePath);
  let root = path.resolve(projectPath);
  // Native: on Windows it expands 8.3 short names, as Git's toplevel does.
  try { root = fs.realpathSync.native(root); } catch { /* .moe/ exists, so the path does */ }
  const run = options.git ?? runGit;
  const git: Git = async (args) => {
    // A root ending in /* would make runGit's safe.directory a subtree trust rule.
    if (root.replace(/\\/g, '/').endsWith('/*')) return { ok: false, why: 'project path ends in /*' };
    try { return { ok: true, out: await run(args, root, GIT_TIMEOUT_MS, GIT_MAX_BUFFER) }; }
    catch (err) {
      // execFile's exit status is a number; ENOENT and the maxBuffer code are strings and stay out.
      const code = (err as { code?: unknown } | null)?.code;
      return { ok: false, why: describeGitFailure(err), ...(typeof code === 'number' ? { code } : {}) };
    }
  };
  const version = await probeGitVersion(git, hard);
  const projectRoot = await probeProjectRoot(git, root, hard);
  const target = resolveWorktreeTarget(settings);
  const control = await probeControlBranch(git, target, hard);
  const list = await git(['worktree', 'list', '--porcelain', '-z']);
  const listed = list.ok ? (parseWorktreeList(list.out) ?? 'malformed listing') : list.why;
  return [
    ['worktree mode', probe],
    ['worktree git version', version],
    ['worktree project root', projectRoot],
    ['worktree control branch', control],
    ['worktree target', await probeTarget(git, target, listed, hard)],
    ['worktree quality gate', probeQualityGate(settings, hard)],
    ['worktree stale task worktrees', probeStaleWorktrees(listed, root, moePath, options.now ?? Date.now(), hard)],
  ];
}
