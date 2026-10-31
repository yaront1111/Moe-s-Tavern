// Materializes one exact commit's committed bytes into a private throwaway directory, so an analyzer (CQ-C03) can
// index immutable input instead of the shared, mutable worktree. Read-only Git only, inside the daemon's envelope
// (openProjectGit trust checks, readOnlyGitEnv/readOnlyGitArgs): rev-parse, ls-tree and ONE `cat-file --batch`
// stream, as R09b's readBase does. Never archive, checkout, checkout-index, read-tree, worktree, --filters or
// --textconv: attributes, smudge filters and eol settings are mutable local state and can run commands.
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openProjectGit, readOnlyGitArgs, readOnlyGitEnv, runGit } from '../util/cachedPlanPaths.js';
import { pathKey } from '../util/affectedFiles.js';
import { invalidInput } from '../util/errors.js';
import { gitExecutable } from '../util/gitExecutable.js';
import { snapshotPathRefusal } from './snapshotManifest.js';

export interface MaterializeLimits { readonly maxFiles: number; readonly maxBytes: number; readonly timeBudgetMs: number }
export const MATERIALIZE_LIMITS: Readonly<MaterializeLimits> = Object.freeze({ maxFiles: 10_000, maxBytes: 67_108_864, timeBudgetMs: 20_000 });
const CEILINGS: Readonly<MaterializeLimits> = Object.freeze({ ...MATERIALIZE_LIMITS, timeBudgetMs: 60_000 });
export interface MaterializedCommit {
  readonly dir: string; readonly commit: string; readonly tree: string; readonly files: number; readonly bytes: number;
  readonly skipped: Readonly<{ control: number; unportable: number; symlink: number; submodule: number }>;
  dispose(): Promise<void>;
}
export type MaterializeResult = { readonly ok: true; readonly materialized: MaterializedCommit } | { readonly ok: false; readonly reason: string };

const FULL_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const LS_TREE = /^([0-7]{6}) (blob|commit|tree) ([0-9a-f]{40}|[0-9a-f]{64}) +([0-9]+|-)\t(.+)$/s;
// Sized from the ceilings, never from caller limits: 10,000 records of a 1024-byte path fit with room to spare.
const LS_TREE_MAX_BYTES = 16 * 1024 * 1024;
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const foldCase = (s: string): string => s.toUpperCase().toLowerCase();
interface Wanted { readonly oid: string; readonly size: number; readonly name: string; readonly executable: boolean }

/** A deterministic refusal; its message is the returned reason (a short code plus at most one detail line). */
class Refusal extends Error {}
const firstLine = (error: unknown): string => (error instanceof Error ? error.message : String(error)).split(/\r?\n/)[0].slice(0, 240);
function refuse(code: string, detail?: unknown): never {
  throw new Refusal(detail === undefined || detail === '' ? code : `${code}: ${firstLine(detail)}`);
}

function readLimits(raw: unknown): MaterializeLimits {
  if (raw === undefined) return MATERIALIZE_LIMITS;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw invalidInput('limits', 'must be an object');
  const out: { -readonly [K in keyof MaterializeLimits]: number } = { ...MATERIALIZE_LIMITS };
  for (const key of Object.keys(raw)) {
    if (!Object.hasOwn(CEILINGS, key)) throw invalidInput(`limits.${key}`, 'is not a materialize limit');
    const ceiling = CEILINGS[key as keyof MaterializeLimits];
    const value: unknown = (raw as Record<string, unknown>)[key];
    if (value === undefined) continue;
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0 || value > ceiling) {
      throw invalidInput(`limits.${key}`, `must be a positive safe integer at most ${ceiling}`);
    }
    out[key as keyof MaterializeLimits] = value;
  }
  return out;
}

// Case-folded twins and file/directory clashes, so the result is the same on every filesystem. With '/' as NUL, the
// lowest code unit, sorting puts each path directly before its descendants: any clash is between neighbours.
function collides(names: readonly string[]): boolean {
  const keys = names.map(name => foldCase(name).replaceAll('/', '\0')).sort();
  return keys.some((key, index) => index > 0 && (key === keys[index - 1] || key.startsWith(`${keys[index - 1]}\0`)));
}

// Symlinks and gitlinks are counted before path checks; refused paths are counted, never written. A path that is
// not valid UTF-8 is unportable (a lossy decode would write a name the commit does not hold).
function classify(listing: Buffer) {
  if (listing.length > 0 && listing.at(-1) !== 0) refuse('git-failed:ls-tree');
  const skipped = { control: 0, unportable: 0, symlink: 0, submodule: 0 };
  const wanted: Wanted[] = [];
  let at = 0;
  while (at < listing.length) {
    const end = listing.indexOf(0, at);
    const match = LS_TREE.exec(listing.toString('latin1', at, end));
    at = end + 1;
    if (!match) refuse('git-failed:ls-tree');
    const [, mode, type, oid, size, raw] = match;
    if (mode === '120000') { skipped.symlink += 1; continue; }
    if (mode === '160000') { skipped.submodule += 1; continue; }
    let name: string | null = null;
    try { name = utf8.decode(Buffer.from(raw, 'latin1')); } catch { /* counted as unportable below */ }
    const refusal = name === null ? 'SNAPSHOT_PATH_INVALID' : snapshotPathRefusal(name);
    if (refusal) { skipped[refusal === 'SNAPSHOT_CONTROL_PATH' ? 'control' : 'unportable'] += 1; continue; }
    if (type !== 'blob' || (mode !== '100644' && mode !== '100755') || size === '-') refuse('git-failed:ls-tree');
    wanted.push({ oid, size: Number(size), name: name as string, executable: mode === '100755' });
  }
  return { skipped, wanted };
}

// One cat-file --batch stream inside the read-only envelope. The stdin 'error' listener comes first: a git that exits
// before reading its input must stay a rejected promise, never an unhandled EPIPE (mem gotcha-local-runner-execfile-stdin).
function catFileBatch(root: string, input: string, timeout: number, maxBuffer: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = execFile(gitExecutable(), readOnlyGitArgs(root, ['cat-file', '--batch']), {
      cwd: root, env: readOnlyGitEnv(), timeout, killSignal: 'SIGKILL', windowsHide: true, encoding: 'buffer', maxBuffer,
    }, (error, stdout) => (error ? reject(error) : resolve(stdout)));
    child.stdin?.on('error', () => {}).end(input);
  });
}

// Every record must be exactly '<oid> blob <listed size>\n', the bytes, then LF. maxBuffer is their exact sum, so a
// longer stream is an overflow error and a shorter one fails a record check.
async function readBlobs(root: string, wanted: readonly Wanted[], remaining: () => number): Promise<Buffer[]> {
  if (wanted.length === 0) return [];
  const headers = wanted.map(({ oid, size }) => Buffer.from(`${oid} blob ${size}\n`, 'latin1'));
  const maxBuffer = wanted.reduce((sum, { size }, index) => sum + headers[index].length + size + 1, 0);
  const input = wanted.map(({ oid }) => `${oid}\n`).join('');
  const out = await catFileBatch(root, input, remaining(), maxBuffer).catch(error => refuse('git-failed:cat-file', error));
  let at = 0;
  return wanted.map(({ size }, index) => {
    const start = at + headers[index].length;
    if (!out.subarray(at, start).equals(headers[index]) || out[start + size] !== 0x0a) refuse('git-failed:cat-file');
    at = start + size + 1;
    return out.subarray(start, start + size);
  });
}

// Exclusive create ('wx') never follows or replaces anything, and no symlink is ever created.
async function writeFiles(dir: string, wanted: readonly Wanted[], blobs: readonly Buffer[], remaining: () => number) {
  const made = new Set<string>();
  for (const [index, { name, executable }] of wanted.entries()) {
    remaining();
    const target = path.join(dir, ...name.split('/'));
    const parent = path.dirname(target);
    try {
      if (!made.has(parent)) { await fs.mkdir(parent, { recursive: true, mode: 0o700 }); made.add(parent); }
      await fs.writeFile(target, blobs[index], { flag: 'wx', mode: executable ? 0o755 : 0o644 });
    } catch (error) { refuse('fs-failed', error); }
  }
}

async function materialize(projectRoot: string, commit: string, limits: MaterializeLimits, tmpRoot?: string) {
  const deadline = performance.now() + limits.timeBudgetMs;
  const remaining = () => {
    const left = Math.floor(deadline - performance.now());
    return left > 0 ? left : refuse('timeout');
  };
  const root = await fs.realpath(projectRoot).catch(error => refuse('repository', error));
  const git = await openProjectGit(root, runGit, limits.timeBudgetMs).catch(error => refuse('repository', error));
  const peel = (suffix: string) => git('rev-parse --verify', ['rev-parse', '--verify', '--end-of-options', `${commit}^{${suffix}}`])
    .then(out => out.trim(), error => refuse('commit-invalid', error));
  if (await peel('commit') !== commit) refuse('commit-invalid');
  const tree = await peel('tree');
  if (!FULL_ID.test(tree)) refuse('commit-invalid');
  const listing = await git.head('ls-tree', ['ls-tree', '-r', '-z', '-l', '--full-tree', commit], LS_TREE_MAX_BYTES)
    .catch(error => refuse('git-failed:ls-tree', error));
  if (listing.truncated) refuse('limit-exceeded:files');
  if (listing.exitCode !== 0) refuse('git-failed:ls-tree', listing.stderr);
  const { skipped, wanted } = classify(listing.stdout);
  // Bounds come from the listing, before any blob is read or anything is created.
  if (wanted.length > limits.maxFiles) refuse('limit-exceeded:files');
  const bytes = wanted.reduce((sum, { size }) => sum + size, 0);
  if (bytes > limits.maxBytes) refuse('limit-exceeded:bytes');
  if (collides(wanted.map(({ name }) => name))) refuse('path-collision');
  const base = await fs.realpath(tmpRoot ?? os.tmpdir()).catch(error => refuse('tmp-failed', error));
  const inside = path.relative(pathKey(root), pathKey(base));
  if (inside === '' || (inside !== '..' && !inside.startsWith(`..${path.sep}`) && !path.isAbsolute(inside))) refuse('tmp-inside-project');
  // mkdtemp(3) creates the directory 0700.
  const dir = await fs.mkdtemp(path.join(base, 'moe-materialize-')).catch(error => refuse('tmp-failed', error));
  try {
    await writeFiles(dir, wanted, await readBlobs(root, wanted, remaining), remaining);
  } catch (error) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  let disposed = false;
  const dispose = async () => {
    if (disposed) return;
    await fs.rm(dir, { recursive: true, force: true });
    disposed = true;
  };
  return Object.freeze({ dir, commit, tree, files: wanted.length, bytes, skipped: Object.freeze(skipped), dispose });
}

/**
 * Caller-shape errors (a relative projectRoot or tmpRoot, a commit that is not a full lowercase id, bad limits) throw invalidInput
 * before any IO. Every repository, Git, filesystem or timeout failure returns { ok: false, reason } and removes the
 * private directory first; it never throws.
 */
export async function materializeCommit(projectRoot: string, commit: string,
  options: { limits?: Partial<MaterializeLimits>; tmpRoot?: string } = {}): Promise<MaterializeResult> {
  // A relative root would silently resolve against the daemon's own working directory.
  if (typeof projectRoot !== 'string' || !path.isAbsolute(projectRoot)) throw invalidInput('projectRoot', 'must be an absolute path');
  if (typeof commit !== 'string' || !FULL_ID.test(commit)) throw invalidInput('commit', 'must be a full lowercase commit id');
  const limits = readLimits(options.limits);
  const { tmpRoot } = options;
  if (tmpRoot !== undefined && (typeof tmpRoot !== 'string' || !path.isAbsolute(tmpRoot))) {
    throw invalidInput('tmpRoot', 'must be an absolute path');
  }
  try {
    return { ok: true, materialized: await materialize(projectRoot, commit, limits, tmpRoot) };
  } catch (error) {
    return { ok: false, reason: error instanceof Refusal ? error.message : `failed: ${firstLine(error)}` };
  }
}
