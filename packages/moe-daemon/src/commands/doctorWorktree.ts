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
type Git = (args: string[]) => Promise<{ ok: true; out: string } | { ok: false; why: string }>;
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

async function probeControlBranch(git: Git, hard: boolean): Promise<ProbeResult> {
  const read = await git(['symbolic-ref', '-q', 'HEAD']);
  if (!read.ok) return verdict(hard, false, `HEAD is detached or unreadable (${read.why}); need ${CONTROL_REF}`);
  const head = read.out.trim();
  if (head === CONTROL_REF) return verdict(hard, true, `control checkout is on ${CONTROL_REF}`);
  return verdict(hard, false, `control checkout HEAD is ${shown(head)}, not ${CONTROL_REF} (git switch -c moe/control main)`);
}

async function probeTarget(git: Git, settings: Settings | undefined, listed: WorktreeRecord[] | string, hard: boolean): Promise<ProbeResult> {
  const target = resolveWorktreeTarget(settings);
  // cachedPlanRef is the daemon's literal-branch-name rule; it rejects revision syntax such as main~1.
  if (!cachedPlanRef(target)) return verdict(hard, false, `target ${shown(target)} is not a literal branch name`);
  const ref = `refs/heads/${target}`;
  const read = await git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  if (!read.ok) return verdict(hard, false, `target ${target}: ${ref} does not resolve to a commit (${read.why})`);
  if (typeof listed === 'string') return verdict(hard, false, `target ${target}: cannot list worktrees (${listed})`);
  const holders = listed.filter((w) => w.branch === ref).map((w) => shown(w.path));
  if (holders.length === 0) return verdict(hard, true, `target ${target} exists and is not checked out in any worktree`);
  return verdict(hard, false, `target ${target} is checked out at ${holders.join(', ')}; landings update it by ref`);
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
    catch (err) { return { ok: false, why: describeGitFailure(err) }; }
  };
  const version = await probeGitVersion(git, hard);
  const projectRoot = await probeProjectRoot(git, root, hard);
  const control = await probeControlBranch(git, hard);
  const list = await git(['worktree', 'list', '--porcelain', '-z']);
  const listed = list.ok ? (parseWorktreeList(list.out) ?? 'malformed listing') : list.why;
  return [
    ['worktree mode', probe],
    ['worktree git version', version],
    ['worktree project root', projectRoot],
    ['worktree control branch', control],
    ['worktree target', await probeTarget(git, settings, listed, hard)],
    ['worktree quality gate', probeQualityGate(settings, hard)],
    ['worktree stale task worktrees', probeStaleWorktrees(listed, root, moePath, options.now ?? Date.now(), hard)],
  ];
}
