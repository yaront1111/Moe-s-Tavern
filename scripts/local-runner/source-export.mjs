// Host-only, read-only export for CQ-R09 (used by CQ-R09c, CQ-R09 final and CQ-C02b): a protected base commit and the
// checkout's dirty bytes become two validateImport manifests (source-snapshot.mjs), so every size, sha256 and digest
// comes from bytes read here. Nothing is written; Git runs only in the daemon's read-only openProjectGit envelope, plus
// core.fsmonitor=false (it may name a hook). Porcelain `git diff` rewrites the index even under --no-optional-locks
// (Git 2.43), so tracked dirt comes from plumbing `diff-index`; a stat-only path it lists is dropped when bytes and mode
// match. `ls-files --others` lists a nested repository as 'name/' and never a FIFO. v1 limits (fail-closed): a directory
// replaced by a file collides in validateImport; a line-ending-only change is not dirty, so the base bytes stand.
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { MAX_IMPORT_BYTES, MAX_IMPORT_ENTRIES, snapshotError, validateImport, validateImportPath } from './source-snapshot.mjs';

// Fixed text only: a message never includes a path, Git output or file bytes.
const MESSAGES = {
  EXPORT_INPUT_INVALID: 'Source export input was invalid.', EXPORT_ENTRY_UNSUPPORTED: 'Source export met an unsupported entry type.',
  EXPORT_REPOSITORY_UNSUPPORTED: 'Source export repository was not a supported checkout root.',
  EXPORT_COMMIT_INVALID: 'Source export commit was not a full commit id in this repository.',
  EXPORT_GIT_FAILED: 'Source export Git command failed, timed out or printed unexpected output.',
  EXPORT_READ_FAILED: 'Source export could not read a worktree file consistently.',
};
const GIT_PREFIX = ['--no-optional-locks', '--no-replace-objects', '-c', 'protocol.allow=never', '-c', 'core.fsmonitor=false'];
const CONTROL_CHAR = /[\u0000-\u001f\u007f]/;
const FULL_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const LS_TREE = /^([0-7]{6}) (blob|commit|tree) ([0-9a-f]{40}|[0-9a-f]{64}) +([0-9]+|-)\t(.+)$/s;
// ignoreBOM keeps a leading U+FEFF, so validateImportPath refuses it instead of the decoder dropping it.
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const READ_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
const gone = error => (['ENOENT', 'ENOTDIR'].includes(error?.code) ? null : Promise.reject(error));
const pathKey = p => (['win32', 'darwin'].includes(process.platform) ? p.toLowerCase() : p);

export function exportError(code) {
  const known = typeof code === 'string' && Object.hasOwn(MESSAGES, code) ? code : 'EXPORT_INPUT_INVALID';
  return Object.assign(new Error(MESSAGES[known]), { code: known });
}

// Re-mints every refusal from its code alone; anything unexpected becomes EXPORT_READ_FAILED.
const fixedError = error => (typeof error?.code === 'string' && error.code.startsWith('SNAPSHOT_') ? snapshotError(error.code)
  : exportError(Object.hasOwn(MESSAGES, String(error?.code)) ? error.code : 'EXPORT_READ_FAILED'));

function records(buffer) {
  if (buffer.length > 0 && buffer.at(-1) !== 0) throw exportError('EXPORT_GIT_FAILED');
  try { return utf8.decode(buffer).split('\0').slice(0, -1); } catch { throw snapshotError('SNAPSHOT_PATH_INVALID'); }
}

// One deadline covers every command; only the canonical root is trusted, and no GIT_* variable is inherited. CQ-R12
// admission adds its own -c options (prefix, before args), environment (over the sanitized one) and failure code.
export function gitRunner(git, root, timeoutMs, { prefix = [], env: extra = {}, fail = () => exportError('EXPORT_GIT_FAILED') } = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')));
  Object.assign(env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_NO_LAZY_FETCH: '1', GIT_TERMINAL_PROMPT: '0' }, extra);
  const deadline = Date.now() + timeoutMs;
  // Resolves stdout on exit 0, or null on exit 1 if allowed. execFile kills the child at the deadline or on overflow.
  return (args, { exit1 = false, input = '', maxBuffer = 64 * 1024 * 1024 } = {}) => new Promise((resolve, reject) => {
    const timeout = deadline - Date.now();
    if (timeout <= 0) throw fail();
    const options = { cwd: root, env, timeout, killSignal: 'SIGKILL', windowsHide: true, encoding: 'buffer', maxBuffer };
    const child = execFile(git, [...GIT_PREFIX, '-c', `safe.directory=${root}`, ...prefix, ...args], options, (error, stdout) => {
      if (!error) resolve(stdout);
      else if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') reject(snapshotError('SNAPSHOT_LIMIT_EXCEEDED'));
      else if (exit1 && error.code === 1 && !error.killed) resolve(null);
      else reject(fail());
    });
    child.stdin.on('error', () => {}).end(input); // A child that exits early fails this write; its exit status decides.
  });
}

// repoDir must really be the toplevel, never ending '/*'. No config scope left unmasked (local, worktree, -c: `--local` skips
// config.worktree) may set a partial clone, promisor, core.worktree or filter driver (diff-index runs one). Resolves
// {root, run}; the second argument holds the caller's refusal (unsupported) and its gitRunner options.
export async function openRepository({ repoDir, git, timeoutMs },
  { unsupported = () => exportError('EXPORT_REPOSITORY_UNSUPPORTED'), ...runner } = {}) {
  const root = await realpath(repoDir).catch(() => { throw unsupported(); });
  if (root.replace(/\\/g, '/').endsWith('/*')) throw unsupported();
  const run = gitRunner(git, root, timeoutMs, runner);
  const top = await run(['rev-parse', '--show-toplevel']).then(out => realpath(utf8.decode(out).replace(/\n$/, '')))
    .catch(() => { throw unsupported(); });
  if (pathKey(top) !== pathKey(root)) throw unsupported();
  if (await run(['config', '--includes', '--get-regexp',
    '^(extensions\\.partialclone|remote\\..*\\.promisor|core\\.worktree|filter\\..*)$'], { exit1: true }) !== null) throw unsupported();
  return { root, run };
}

// A tag or tree fails the peel.
async function openCommit({ repoDir, commit, git, timeoutMs }) {
  const { root, run } = await openRepository({ repoDir, git, timeoutMs });
  const peel = async type => {
    const out = await run(['rev-parse', '--verify', '--quiet', '--end-of-options', `${commit}^{${type}}`], { exit1: true });
    const id = out === null ? '' : out.toString('latin1').replace(/\n$/, '');
    if (!FULL_ID.test(id)) throw exportError('EXPORT_COMMIT_INVALID');
    return id;
  };
  if (await peel('commit') !== commit) throw exportError('EXPORT_COMMIT_INVALID');
  return { root, run, tree: await peel('tree') };
}

// Control paths drop before type checks; count and bytes are bounded before any blob is read. Git writes only 100644/100755 blobs.
async function readBase(run, commit, keep) {
  const wanted = [];
  for (const record of records(await run(['ls-tree', '-r', '-z', '-l', '--full-tree', commit]))) {
    const match = LS_TREE.exec(record);
    if (!match) throw exportError('EXPORT_GIT_FAILED');
    const [, mode, type, oid, size, name] = match;
    if (keep(name) === null) continue;
    if (mode === '120000') throw snapshotError('SNAPSHOT_SYMLINK_DENIED');
    if (type !== 'blob') throw exportError('EXPORT_ENTRY_UNSUPPORTED');
    wanted.push({ oid, size: Number(size), path: name, executable: mode === '100755' });
  }
  const total = wanted.reduce((sum, { size }) => sum + size, 0);
  if (wanted.length > MAX_IMPORT_ENTRIES || total > MAX_IMPORT_BYTES) throw snapshotError('SNAPSHOT_LIMIT_EXCEEDED');
  // One cat-file --batch stream must print exactly the requested '<oid> blob <listed size>\n', bytes, LF records.
  const headers = wanted.map(({ oid, size }) => Buffer.from(`${oid} blob ${size}\n`, 'latin1'));
  const maxBuffer = wanted.reduce((sum, { size }, index) => sum + headers[index].length + size + 1, 0);
  const input = wanted.map(({ oid }) => `${oid}\n`).join('');
  const out = maxBuffer && await run(['cat-file', '--batch'], { input, maxBuffer }).catch(() => { throw exportError('EXPORT_GIT_FAILED'); });
  let at = 0;
  return validateImport(wanted.map(({ path: name, executable, size }, index) => {
    const start = at + headers[index].length;
    if (!out.subarray(at, start).equals(headers[index]) || out[start + size] !== 0x0a) throw exportError('EXPORT_GIT_FAILED');
    at = start + size + 1;
    return { kind: 'file', path: name, executable, data: out.subarray(start, start + size) };
  }));
}

// Reads a dirty path below lstat-ed ancestors only: a symlink at or above it is refused, a missing path is null, and the
// opened file must still be the lstat-ed regular file. One byte past its size is read, so a growing file is caught.
async function readWorktree(root, name, ancestors, room) {
  const segments = name.split('/');
  for (let depth = 1; depth < segments.length; depth += 1) {
    const dir = path.join(root, ...segments.slice(0, depth));
    if (!ancestors.has(dir)) ancestors.set(dir, await lstat(dir).catch(gone));
    if (ancestors.get(dir)?.isSymbolicLink()) throw snapshotError('SNAPSHOT_SYMLINK_DENIED');
  }
  const full = path.join(root, ...segments);
  const stat = await lstat(full).catch(gone);
  if (!stat) return null;
  if (stat.isSymbolicLink()) throw snapshotError('SNAPSHOT_SYMLINK_DENIED');
  if (!stat.isFile()) throw exportError('EXPORT_ENTRY_UNSUPPORTED');
  const handle = await open(full, READ_FLAGS);
  try {
    const now = await handle.stat();
    if (!now.isFile() || now.dev !== stat.dev || now.ino !== stat.ino) throw exportError('EXPORT_READ_FAILED');
    if (now.size > room) throw snapshotError('SNAPSHOT_LIMIT_EXCEEDED');
    const data = Buffer.alloc(now.size + 1);
    let filled = 0;
    for (let count = -1; count !== 0 && filled < data.length; filled += count) {
      ({ bytesRead: count } = await handle.read(data, filled, data.length - filled, filled));
    }
    if (filled !== now.size) throw exportError('EXPORT_READ_FAILED');
    return { data: data.subarray(0, filled), mode: now.mode };
  } finally { await handle.close(); }
}

// Dirty paths, deduplicated and validated before any filesystem call (=dirty: no `git status` runs in a nested checkout).
async function readOverlay(run, root, commit, base, keep) {
  const tracked = records(await run(['diff-index', '--name-only', '-z', '--no-renames', '--ignore-submodules=dirty', commit, '--']));
  const others = records(await run(['ls-files', '-z', '--others', '--exclude-standard'])).map(name => name.replace(/\/$/, ''));
  const names = [...new Set([...tracked, ...others])].filter(name => keep(name) !== null);
  if (names.length > MAX_IMPORT_ENTRIES) throw snapshotError('SNAPSHOT_LIMIT_EXCEEDED');
  const committed = new Map(base.entries.map(entry => [entry.path, entry]));
  const ancestors = new Map();
  const entries = [];
  let total = 0;
  for (const name of names) {
    const prior = committed.get(name);
    const read = await readWorktree(root, name, ancestors, MAX_IMPORT_BYTES - total);
    if (!read) { if (prior) entries.push({ kind: 'delete', path: name }); continue; }
    // win32 has no owner-execute bit: a tracked path keeps its committed mode and an untracked one is not executable.
    const executable = process.platform === 'win32' ? prior?.executable === true : (read.mode & 0o100) !== 0;
    if (prior?.executable === executable && Buffer.compare(prior.data, read.data) === 0) continue;
    total += read.data.length;
    entries.push({ kind: 'file', path: name, executable, data: read.data });
  }
  return validateImport(entries);
}

function readInput(input) {
  try {
    const { repoDir, commit, git = 'git', timeoutMs = 120_000 } = input;
    const text = value => typeof value === 'string' && value !== '' && !CONTROL_CHAR.test(value);
    if (text(repoDir) && path.isAbsolute(repoDir) && text(commit) && FULL_ID.test(commit) && text(git)
      && Number.isSafeInteger(timeoutMs) && timeoutMs >= 1 && timeoutMs <= 600_000) return { repoDir, commit, git, timeoutMs };
  } catch { /* refused below */ }
  throw exportError('EXPORT_INPUT_INVALID');
}

// Resolves the frozen SourceSnapshot {version: 1, commit, tree, base, overlay, excluded} or throws one fixed-code
// error (EXPORT_* or a SNAPSHOT_* code of source-snapshot.mjs); never a partial result.
export async function exportSourceSnapshot(input) {
  try {
    const options = readInput(input);
    const { root, run, tree } = await openCommit(options);
    let excluded = 0;
    const keep = name => {
      try { return validateImportPath(name); } catch (error) {
        if (error?.code !== 'SNAPSHOT_CONTROL_PATH') throw error;
        excluded += 1;
        return null;
      }
    };
    const base = await readBase(run, options.commit, keep);
    const overlay = await readOverlay(run, root, options.commit, base, keep);
    return Object.freeze({ version: 1, commit: options.commit, tree, base, overlay, excluded });
  } catch (error) { throw fixedError(error); }
}
