// CQ-R12 host admission: one candidate, validateImport's frozen manifest (R09's importCandidate), applied to the protected
// base tree (R09b's exportSourceSnapshot().tree) becomes ONE Git tree object in the host repository.
// - Plumbing only: Git objects are written, never a ref, a worktree byte or .git/index (the index is a private
//   GIT_INDEX_FILE). Target branch writes stay in the wrappers' landing, so candidate Moe source cannot replace the active
//   host controller.
// - R09b's envelope (no inherited GIT_*, system and global config masked, no replace objects, protocol.allow=never,
//   core.fsmonitor=false) plus an empty private core.hooksPath, no split or sparse index and hash-object --no-filters; a
//   filter driver, partial clone or core.worktree in any config scope is refused.
// - Nothing from the repository runs: no tests, package scripts or hooks, and git must be absolute, because Windows
//   resolves a bare 'git' against the repository cwd (task-d72fe292).
// executionReady stays false and verified-local stays unavailable. v1 residual: a case variant of a base path is admitted.
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openRepository } from './source-export.mjs';
import { MAX_IMPORT_ENTRIES, snapshotError, validateImport } from './source-snapshot.mjs';

// Fixed text only: a message never includes a path, Git output or file bytes.
const MESSAGES = {
  ADMISSION_INPUT_INVALID: 'Candidate admission input was invalid.',
  ADMISSION_REPOSITORY_UNSUPPORTED: 'Candidate admission repository was not a supported checkout root.',
  ADMISSION_BASE_INVALID: 'Candidate admission base was not a full tree id in this repository.',
  ADMISSION_ENTRY_CONFLICT: 'Candidate admission entry conflicted with the base tree.',
  ADMISSION_GIT_FAILED: 'Candidate admission Git command failed, timed out or printed unexpected output.',
};
const CONTROL_CHAR = /[\u0000-\u001f\u007f]/;
const FULL_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const LS_TREE = /^([0-7]{6}) (?:blob|commit|tree) (?:[0-9a-f]{40}|[0-9a-f]{64})\t(.+)$/s;
const BLOB_MODES = ['100644', '100755'];
// ignoreBOM keeps a leading U+FEFF, so a base path never loses a byte before it is compared.
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const latin1 = buffer => buffer.toString('latin1');
const foldCase = p => (process.platform === 'darwin' ? p.toLowerCase() : p); // path.win32.relative already folds case.
// Every proper '/'-prefix of a path, shortest first.
const parents = name => [...name.matchAll(/\//g)].map(({ index }) => name.slice(0, index));

export function admissionError(code) {
  const known = typeof code === 'string' && Object.hasOwn(MESSAGES, code) ? code : 'ADMISSION_INPUT_INVALID';
  return Object.assign(new Error(MESSAGES[known]), { code: known });
}

// Re-mints every refusal from its code alone; anything unexpected becomes ADMISSION_GIT_FAILED.
const fixedError = error => (typeof error?.code === 'string' && error.code.startsWith('SNAPSHOT_') ? snapshotError(error.code)
  : admissionError(Object.hasOwn(MESSAGES, String(error?.code)) ? error.code : 'ADMISSION_GIT_FAILED'));

// The candidate must be a frozen {entries, digest} that validateImport re-derives from its own bytes entry by entry, so an
// edited sha256 or digest, or a data buffer changed after validation (a TypedArray cannot be frozen), is refused. Only the
// re-derived manifest, whose data are private copies, is used afterwards.
function revalidate(candidate) {
  let claimed;
  try {
    const { entries } = candidate;
    if (Object.getPrototypeOf(candidate) !== Object.prototype || !Object.isFrozen(candidate)
      || Reflect.ownKeys(candidate).sort().join() !== 'digest,entries' || !Array.isArray(entries) || !Object.isFrozen(entries)
      || entries.length > MAX_IMPORT_ENTRIES) throw admissionError('ADMISSION_INPUT_INVALID');
    claimed = Array.from({ length: entries.length }, (_, index) => ({ ...entries[index] })); // Each entry is read once.
  } catch { throw admissionError('ADMISSION_INPUT_INVALID'); }
  const again = validateImport(claimed.map(({ kind, path: name, executable, data }) => (kind === 'file'
    ? { kind, path: name, executable, data } : { kind, path: name })));
  const same = (entry, index) => ['kind', 'path', 'size', 'sha256'].every(key => entry[key] === claimed[index][key]);
  if (again.digest !== candidate.digest || !again.entries.every(same)) throw admissionError('ADMISSION_INPUT_INVALID');
  return again;
}

function readInput(input) {
  try {
    const { repoDir, baseTree, candidate, git, timeoutMs = 120_000 } = input;
    const text = value => typeof value === 'string' && value !== '' && !CONTROL_CHAR.test(value);
    if (text(repoDir) && path.isAbsolute(repoDir) && text(git) && path.isAbsolute(git) && text(baseTree) && FULL_ID.test(baseTree)
      && Number.isSafeInteger(timeoutMs) && timeoutMs >= 1 && timeoutMs <= 600_000) return { repoDir, baseTree, candidate, git, timeoutMs };
  } catch { /* refused below */ }
  throw admissionError('ADMISSION_INPUT_INVALID');
}

// The id length must match the repository's object format, and baseTree must already name a tree object in it.
async function openBase(run, baseTree) {
  const format = latin1(await run(['rev-parse', '--show-object-format'])).replace(/\n$/, '');
  if (!['sha1', 'sha256'].includes(format)) throw admissionError('ADMISSION_GIT_FAILED');
  if (baseTree.length !== (format === 'sha1' ? 40 : 64)) throw admissionError('ADMISSION_BASE_INVALID');
  const peeled = await run(['rev-parse', '--verify', '--quiet', '--end-of-options', `${baseTree}^{tree}`], { exit1: true });
  if (peeled === null || latin1(peeled) !== `${baseTree}\n`) throw admissionError('ADMISSION_BASE_INVALID');
  return format;
}

// path -> mode of every base leaf: blobs, symlinks (120000) and gitlinks (160000).
async function readBase(run, baseTree) {
  const out = await run(['ls-tree', '-r', '-z', '--full-tree', baseTree]);
  if (out.length > 0 && out.at(-1) !== 0) throw admissionError('ADMISSION_GIT_FAILED');
  let records;
  try { records = utf8.decode(out).split('\0').slice(0, -1); } catch { throw admissionError('ADMISSION_GIT_FAILED'); }
  return new Map(records.map(record => {
    const match = LS_TREE.exec(record);
    if (!match) throw admissionError('ADMISSION_GIT_FAILED');
    return [match[2], match[1]];
  }));
}

// update-index --index-info replaces across a directory/file swap silently, so a delete must name a base blob, and a file
// may only replace a base blob or add a path that is neither a base directory nor beneath a base leaf. validateImport
// already refuses a delete above or below a file, so the base itself is what remains around each file.
function checkEntries(base, entries) {
  const dirs = new Set([...base.keys()].flatMap(name => parents(name)));
  for (const { kind, path: name } of entries) {
    const fits = kind === 'delete' ? BLOB_MODES.includes(base.get(name))
      : (!base.has(name) || BLOB_MODES.includes(base.get(name))) && !dirs.has(name) && !parents(name).some(parent => base.has(parent));
    if (!fits) throw admissionError('ADMISSION_ENTRY_CONFLICT');
  }
}

// ONE hash-object over private temp copies (--no-filters: no clean filter, autocrlf, eol or ident conversion, and never a
// worktree path), each printed id checked against Node's own blob hash; then the base, its deletes and the files go into
// the private index, which write-tree turns into the candidate tree. No ref, worktree or .git/index is touched.
async function writeTree(run, temp, format, { baseTree, candidate }) {
  const files = candidate.entries.filter(({ kind }) => kind === 'file');
  const names = files.map((_, index) => path.join(temp, `blob-${index}`));
  for (const [index, { data }] of files.entries()) await writeFile(names[index], data, { mode: 0o600, flag: 'wx' });
  const ids = files.map(({ data }) => createHash(format).update(`blob ${data.length}\0`).update(data).digest('hex'));
  const hashed = await run(['hash-object', '-w', '--no-filters', '--stdin-paths'], { input: names.map(name => `${name}\n`).join('') });
  if (latin1(hashed) !== ids.map(id => `${id}\n`).join('')) throw admissionError('ADMISSION_GIT_FAILED');
  await run(['read-tree', baseTree]);
  const deletes = candidate.entries.filter(({ kind }) => kind === 'delete').map(({ path: name }) => `${name}\0`);
  await run(['update-index', '-z', '--force-remove', '--stdin'], { input: deletes.join('') });
  const records = files.map(({ path: name, executable }, index) => `${executable ? '100755' : '100644'} ${ids[index]}\t${name}\0`);
  await run(['update-index', '-z', '--index-info'], { input: records.join('') });
  const tree = latin1(await run(['write-tree'])).replace(/\n$/, '');
  if (!FULL_ID.test(tree) || tree.length !== baseTree.length) throw admissionError('ADMISSION_GIT_FAILED');
  return tree;
}

// Resolves the frozen {baseTree, tree, digest} or throws one fixed-code error (ADMISSION_* or a SNAPSHOT_* code of
// source-snapshot.mjs); never a partial result. The private temp dir (empty hooks dir, index, blob copies) goes on every path.
export async function admitCandidate(input) {
  let temp = null;
  try {
    const options = readInput(input);
    options.candidate = revalidate(options.candidate);
    // A git binary inside the repository would be repository code: refused before any process runs.
    const [root, binary] = await Promise.all([options.repoDir, options.git].map(file => realpath(file).then(foldCase, () => null)));
    const below = root === null || binary === null ? '..' : path.relative(root, binary);
    const outside = below === '..' || below.startsWith(`..${path.sep}`) || path.isAbsolute(below);
    if (binary === null || !outside) throw admissionError('ADMISSION_INPUT_INVALID');
    temp = await mkdtemp(path.join(tmpdir(), 'moe-admission-'));
    if (CONTROL_CHAR.test(temp)) throw admissionError('ADMISSION_GIT_FAILED'); // hash-object --stdin-paths reads lines
    await mkdir(path.join(temp, 'hooks'));
    const { run } = await openRepository(options, { unsupported: () => admissionError('ADMISSION_REPOSITORY_UNSUPPORTED'),
      fail: () => admissionError('ADMISSION_GIT_FAILED'), env: { GIT_INDEX_FILE: path.join(temp, 'index') },
      prefix: ['-c', `core.hooksPath=${path.join(temp, 'hooks')}`, '-c', 'core.splitIndex=false', '-c', 'index.sparse=false'] });
    const format = await openBase(run, options.baseTree);
    checkEntries(await readBase(run, options.baseTree), options.candidate.entries);
    const tree = await writeTree(run, temp, format, options);
    return Object.freeze({ baseTree: options.baseTree, tree, digest: options.candidate.digest });
  } catch (error) { throw fixedError(error); } finally {
    if (temp !== null) await rm(temp, { recursive: true, force: true }).catch(() => { throw admissionError('ADMISSION_GIT_FAILED'); });
  }
}
