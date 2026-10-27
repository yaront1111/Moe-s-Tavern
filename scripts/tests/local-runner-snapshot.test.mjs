import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync,
  writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { exportSourceSnapshot } from '../local-runner/source-export.mjs';
import {
  CONTROL_SEGMENTS, MAX_IMPORT_BYTES, MAX_IMPORT_ENTRIES, MAX_IMPORT_PATH_BYTES, MAX_IMPORT_SEGMENT_BYTES,
  snapshotError, validateImport, validateImportPath,
} from '../local-runner/source-snapshot.mjs';

const refuses = (fn, expected, label) => assert.throws(fn, error => error?.code === expected, label);
const caught = fn => { try { fn(); } catch (error) { return error; } return assert.fail('expected a refusal'); };
const file = (path, data = Buffer.from('x'), executable = false) => ({ kind: 'file', path, executable, data });
const del = path => ({ kind: 'delete', path });
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const label = value => JSON.stringify(value)?.slice(0, 60) ?? String(value);
const u32 = n => { const out = Buffer.alloc(4); out.writeUInt32BE(n); return out; };
// The documented v1 framing, recomputed independently of the module.
const framedDigest = sorted => sha(Buffer.concat([Buffer.from('moe-source-snapshot-v1\0'), u32(sorted.length),
  ...sorted.flatMap(({ kind, path, executable, data }) => [Buffer.from(kind === 'file' ? 'F' : 'D'), u32(Buffer.byteLength(path)),
    Buffer.from(path), ...(kind === 'file' ? [Buffer.from([executable ? 1 : 0]), u32(data.length), createHash('sha256').update(data).digest()] : [])])]));
const segments = (count, size) => Array(count).fill('c'.repeat(size)).join('/');

test('S0 exports frozen v1 bounds and the operator control-segment list', () => {
  assert.deepEqual([MAX_IMPORT_PATH_BYTES, MAX_IMPORT_SEGMENT_BYTES, MAX_IMPORT_ENTRIES, MAX_IMPORT_BYTES], [1024, 255, 10_000, 268_435_456]);
  assert.deepEqual(CONTROL_SEGMENTS, ['.git', '.gitmodules', '.moe', '.mcp.json', '.claude', '.codex', '.gemini', '.grok', '.worktrees']);
  assert.ok(Object.isFrozen(CONTROL_SEGMENTS));
});

test('S1 validateImportPath returns portable relative paths unchanged', () => {
  const accepted = [
    'src/a.ts', 'README', '.github/workflows/ci.yml', '.gitignore', '.git-blame-ignore-revs', 'foo.git', '.moe-agent.json',
    '.claude-plugin/x', 'con x', 'x~y', 'file~2023-notes.md', 'ab~1cdef.txt', 'longname~1.txt', 'com10', 'docs/caf\u00e9.md',
    `${'a'.repeat(252)}\u20ac`, segments(5, 204),
  ];
  for (const path of accepted) assert.equal(validateImportPath(path), path, label(path));
  assert.equal(Buffer.byteLength(accepted.at(-2)), 255);
  assert.equal(Buffer.byteLength(accepted.at(-1)), 1024);
});

test('S2 unsafe or non-portable paths are refused with SNAPSHOT_PATH_INVALID', () => {
  const invisible = ['\u200c', '\u200d', '\u200e', '\u200f', '\u202a', '\u202e', '\u206a', '\u206f', '\ufeff', '\u200b', '\u2060', '\u061c'];
  const invalid = [
    42, null, undefined, '', '/etc/x', 'a//b', 'a/', './a', 'a/./b', '../a', 'a/..', 'a\\b', 'C:/x',
    ...[...'<>:"|?*'].map(c => `a${c}b`), 'a\u0000b', 'a\u001fb', 'a\u007fb', 'a\u0085b', 'a\u009fb', ...invisible.map(c => `a${c}b`),
    'e\u0301', 'a\ud800', 'a.', 'a ', ' a', 'dir./x', 'dir /x',
    'con', 'PRN', 'aux', 'NUL', 'nul.txt', 'CON.tar.gz', 'COM1', 'LPT9.log', 'COM\u00b9', 'conin$', 'CONOUT$.x', 'a/com1/b', 'CON .txt', 'a/aux  .c',
    ...['COM\u00b2', 'COM\u00b3', 'LPT\u00b2', 'LPT\u00b3'].flatMap(name => [name, `${name}.txt`, `${name} .x`]),
    'GIT~1', 'PROGRA~1', 'GI7EBA~1', 'foo~2.txt', 'a/B~12/c', '~1', 'A~B~1',
    `${'a'.repeat(254)}\u00e9`, `${segments(5, 204)}c`, Array(5).fill('\u00e9'.repeat(127)).join('/'), `.git/${'a'.repeat(1020)}`,
  ];
  for (const path of invalid) refuses(() => validateImportPath(path), 'SNAPSHOT_PATH_INVALID', label(path));
  refuses(() => validateImport([file('ok'), file('../x')]), 'SNAPSHOT_PATH_INVALID', 'entry path');
});

test('S3 control paths are refused at any depth through paths, files and deletes', () => {
  const control = [
    '.git/config', 'a/.git/HEAD', '.GIT/x', '.gitmodules', 'sub/.Moe/tasks/t.json', '.mcp.json', 'a/.MCP.JSON',
    '.claude/settings.json', '.codex/c.toml', '.gemini/x', '.grok/x', '.worktrees/w/a', '.git/CON', '.g\u0131t/x',
  ];
  for (const path of control) {
    refuses(() => validateImportPath(path), 'SNAPSHOT_CONTROL_PATH', path);
    refuses(() => validateImport([file(path)]), 'SNAPSHOT_CONTROL_PATH', `file ${path}`);
    refuses(() => validateImport([del(path)]), 'SNAPSHOT_CONTROL_PATH', `delete ${path}`);
  }
});

test('S4 control-path lookalikes are refused by either code', () => {
  const either = error => ['SNAPSHOT_PATH_INVALID', 'SNAPSHOT_CONTROL_PATH'].includes(error?.code);
  for (const path of ['.git.', '.git ', 'GIT~1/config', '.g\u200cit', '.gitmodules.', 'x/.MOE /y']) {
    assert.throws(() => validateImportPath(path), either, label(path));
    assert.throws(() => validateImport([file(path)]), either, label(path));
  }
});

test('S5 every symlink entry is refused, wherever it points', () => {
  for (const entry of [{ kind: 'symlink', path: 'a', target: 'b' }, { kind: 'symlink', path: '.git/x', target: '../..' }]) {
    refuses(() => validateImport([file('ok'), entry]), 'SNAPSHOT_SYMLINK_DENIED', entry.path);
  }
});

test('S6 malformed entries and writer-declared identities are refused with SNAPSHOT_ENTRY_INVALID', () => {
  class Entry { constructor() { Object.assign(this, file('a')); } }
  class Bytes extends Uint8Array {}
  const detached = new Uint8Array(4);
  structuredClone(detached.buffer, { transfer: [detached.buffer] });
  const base = file('a');
  const without = key => { const entry = { ...base }; delete entry[key]; return entry; };
  const rows = [
    ['null', null], ['array', []], ['inherited', Object.create({})], ['class instance', new Entry()], ['string', 'a'],
    ['kind dir', { ...base, kind: 'dir' }], ['kind File', { ...base, kind: 'File' }],
    ...['kind', 'path', 'executable', 'data'].map(key => [`missing ${key}`, without(key)]), ['delete missing path', { kind: 'delete' }],
    ...['sha256', 'oid', 'size', 'mode', 'target'].map(key => [`extra ${key}`, { ...base, [key]: 'x' }]),
    ['delete sha256', { ...del('a'), sha256: 'x' }], ['delete data', { ...del('a'), data: new Uint8Array(1) }],
    ['symbol key', { ...base, [Symbol('s')]: 1 }], ['hidden key', Object.defineProperty({ ...base }, 'oid', { value: 'x' })],
    ['executable "true"', { ...base, executable: 'true' }], ['executable 1', { ...base, executable: 1 }],
    ['data string', { ...base, data: 'x' }], ['data ArrayBuffer', { ...base, data: new ArrayBuffer(1) }],
    ['data DataView', { ...base, data: new DataView(new ArrayBuffer(1)) }], ['data Int8Array', { ...base, data: new Int8Array(1) }],
    ['data number[]', { ...base, data: [1] }], ['data subclass', { ...base, data: new Bytes(1) }], ['data detached', { ...base, data: detached }],
    ['throwing getter', { ...base, get path() { throw new Error('boom'); } }],
    ['Float64Array as Uint8Array', { ...base, data: Object.setPrototypeOf(new Float64Array(2), Uint8Array.prototype) }],
  ];
  for (const [name, entry] of rows) refuses(() => validateImport([file('ok'), entry]), 'SNAPSHOT_ENTRY_INVALID', name);
});

test('S7 case-folded duplicates and ancestor paths collide', () => {
  const rows = [
    [file('a.txt'), file('a.txt')], [file('A.txt'), file('a.txt')], [file('\u00df'), file('SS')], [file('x'), del('x')],
    [file('a'), file('a/b')], [file('a/b'), file('a')], [file('A'), file('a/b')], [del('dir'), file('dir/x')], [file('a'), file('A/b/c')],
  ];
  for (const entries of rows) refuses(() => validateImport(entries), 'SNAPSHOT_PATH_COLLISION', entries.map(e => e.path).join(' + '));
  assert.equal(validateImport([file('ab'), file('a/b'), file('a/c')]).entries.length, 3);
});

test('S8 entry-count and byte limits are enforced before elements are read or hashed', () => {
  const sparse = new Array(MAX_IMPORT_ENTRIES + 1);
  for (const index of [0, MAX_IMPORT_ENTRIES]) Object.defineProperty(sparse, index, { get() { throw new Error('element read'); } });
  refuses(() => validateImport(sparse), 'SNAPSHOT_LIMIT_EXCEEDED', 'count');
  const mib = new Uint8Array(1 << 20);
  refuses(() => validateImport(Array.from({ length: 257 }, (_, i) => file(`f${i}`, mib))), 'SNAPSHOT_LIMIT_EXCEEDED', 'bytes');
  // Neither a real Array's own Symbol.species nor a Proxy's shifting length may carry the loop past the bounded count.
  const traps = length => ({
    get: (t, key) => (key === 'length' ? length : file(`p${String(key)}`)), has: () => true, set: () => true, defineProperty: () => true,
  });
  const species = [file('a')];
  species.constructor = { [Symbol.species]: function Fake() { return new Proxy({}, traps(MAX_IMPORT_ENTRIES + 1)); } };
  const growing = [];
  Object.defineProperty(growing, 0, { get: () => { for (let i = 0; i < MAX_IMPORT_ENTRIES; i += 1) growing.push(file(`g${i}`)); return file('a'); } });
  for (const [name, input] of [['species', species], ['growing', growing]]) assert.equal(validateImport(input).entries.length, 1, name);
  let reads = 0;
  for (const length of [{ valueOf: () => (reads++ === 0 ? 0 : MAX_IMPORT_ENTRIES + 1) }, -1, 0.5]) {
    refuses(() => validateImport(new Proxy([], traps(length))), 'SNAPSHOT_INPUT_INVALID', `proxy length ${String(length)}`);
  }
  class Entries extends Array {}
  for (const input of [undefined, null, {}, 'a', new Entries(), Object.setPrototypeOf([], null), { length: 0 }]) {
    refuses(() => validateImport(input), 'SNAPSHOT_INPUT_INVALID', label(input));
  }
});

test('S9 sizes and sha256 come from a private copy that the frozen manifest returns', () => {
  const view = Uint8Array.from([104, 105]);
  const spoof = Uint8Array.from([1, 2, 3]);
  Object.defineProperty(spoof, 'byteLength', { get: () => 0 });
  const bare = Object.assign(Object.create(null), file('n', Buffer.alloc(0)));
  const manifest = validateImport([file('b', view, true), file('s', spoof), del('d'), bare]);
  view[0] = 0;
  spoof[0] = 0;
  const [b, d, n, s] = manifest.entries;
  assert.deepEqual(Object.keys(manifest), ['entries', 'digest']);
  assert.deepEqual(Object.keys(b), ['kind', 'path', 'executable', 'size', 'sha256', 'data']);
  assert.deepEqual([b.kind, b.path, b.executable, b.size, b.sha256], ['file', 'b', true, 2, sha(Buffer.from('hi'))]);
  assert.notEqual(b.data, view);
  assert.deepEqual([...b.data], [104, 105]);
  assert.deepEqual([s.size, s.sha256, [...s.data]], [3, sha(Buffer.from([1, 2, 3])), [1, 2, 3]]);
  assert.deepEqual([n.size, n.sha256], [0, sha(Buffer.alloc(0))]);
  assert.deepEqual(d, { kind: 'delete', path: 'd' });
  for (const value of [manifest, manifest.entries, b, d, n, s]) assert.equal(Object.isFrozen(value), true);
});

test('S9b a later getter that grows or rewrites an earlier buffer cannot change its admitted identity', () => {
  const resizable = new ArrayBuffer(2, { maxByteLength: 8 });
  const grows = new Uint8Array(resizable);
  grows.set([7, 7]);
  const later = { kind: 'file', get path() { resizable.resize(8); grows.fill(9); return 'z'; }, executable: false, data: Buffer.from('z') };
  const [first] = validateImport([file('a', grows), later]).entries;
  assert.deepEqual([first.size, first.sha256, [...first.data]], [2, sha(Buffer.from([7, 7])), [7, 7]]);
});

test('S9c entries sort by UTF-8 path bytes and the digest follows the documented framing', () => {
  const order = validateImport([file('\u{1F600}'), file('\uff5e'), file('c'), file('B'), del('a')]).entries.map(e => e.path);
  assert.deepEqual(order, ['B', 'a', 'c', '\uff5e', '\u{1F600}']);
  const fixed = [file('a', Buffer.from('x'), true), del('b')];
  const { digest } = validateImport(fixed);
  assert.equal(digest, framedDigest(fixed));
  assert.equal(digest, '19b0254bda7da182b1e0f1d457ae4aca6d8d6fd3be34b21142fb9d3394284457');
  assert.equal(validateImport([]).digest, framedDigest([]));
  assert.deepEqual(validateImport([]).entries, []);
});

test('S9d the digest ignores input order and changes with any byte, path, executable bit or kind', () => {
  const entries = () => [file('src/a.ts', Buffer.from('one'), true), del('old.txt'), file('b', Buffer.from('two'))];
  const { digest } = validateImport(entries());
  assert.equal(validateImport(entries().reverse()).digest, digest);
  const changes = {
    byte: e => { e[0].data = Buffer.from('onE'); }, path: e => { e[1].path = 'old.txT'; },
    executable: e => { e[0].executable = false; }, kind: e => { e[2] = del('b'); },
  };
  for (const [name, change] of Object.entries(changes)) {
    const changed = entries();
    change(changed);
    assert.notEqual(validateImport(changed).digest, digest, name);
  }
});

test('S10 the module is pure, ASCII-only, and its fixed messages never echo input', () => {
  const source = readFileSync(new URL('../local-runner/source-snapshot.mjs', import.meta.url), 'utf8');
  // No literal bidi, invisible or lookalike code point can hide in the gate's source (Trojan Source, CVE-2021-42574).
  assert.deepEqual([...source].filter(c => c.codePointAt(0) > 0x7f).map(c => c.codePointAt(0).toString(16)), [], 'non-ASCII source');
  assert.deepEqual(source.match(/^import .*$/gm), ["import { createHash } from 'node:crypto';"]);
  assert.deepEqual(source.match(/\bfrom\s*['"][^'"]*['"]/g), ["from 'node:crypto'"]);
  for (const banned of ['import(', 'require(', 'process.', 'node:fs', 'child_process']) assert.equal(source.includes(banned), false, banned);
  const marker = 'MARKER-0451';
  const refusals = [
    () => validateImportPath(`${marker}/../x`), () => validateImportPath(`.git/${marker}`), () => validateImport([file(marker), file(marker)]),
    () => validateImport([{ ...file(marker), oid: marker }]), () => validateImport([{ kind: 'symlink', path: marker, target: marker }]),
  ];
  for (const refusal of refusals) {
    const error = caught(refusal);
    assert.equal(error.message.includes(marker), false, error.code);
    assert.equal(error.message, snapshotError(error.code).message, error.code);
  }
  for (const code of ['nope', 'toString', 'constructor', 42]) assert.equal(snapshotError(code).code, 'SNAPSHOT_INPUT_INVALID', String(code));
});

// CQ-R09b: exportSourceSnapshot against real temporary repositories. Fixture Git ignores the developer's config.
const win32 = process.platform === 'win32';
const fixtureEnv = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key))),
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: win32 ? 'NUL' : '/dev/null' };
const gitIn = (cwd, input, ...args) => execFileSync('git', ['-c', 'user.name=moe', '-c', 'user.email=moe@test', '-c', 'core.autocrlf=false',
  ...args], { cwd, env: fixtureEnv, input, stdio: 'pipe' }).toString().trim();
const git = (cwd, ...args) => gitIn(cwd, '', ...args);
const blob = (cwd, data) => gitIn(cwd, data, 'hash-object', '-w', '--stdin');
const tempDir = (t, prefix) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const put = (dir, files) => Object.entries(files).forEach(([name, data]) => {
  mkdirSync(dirname(join(dir, name)), { recursive: true }); writeFileSync(join(dir, name), data);
});
function repo(t, files, executable) {
  const dir = tempDir(t, 'moe-export-');
  git(dir, 'init', '-q');
  put(dir, files);
  if (executable) chmodSync(join(dir, executable), 0o755);
  git(dir, 'add', '-A');
  if (executable) git(dir, 'update-index', '--chmod=+x', executable);
  git(dir, 'commit', '-q', '--allow-empty', '-m', 'base');
  return { dir, head: git(dir, 'rev-parse', 'HEAD') };
}
const exportAt = (dir, commit = git(dir, 'rev-parse', 'HEAD'), extra = {}) => exportSourceSnapshot({ repoDir: dir, commit, ...extra });
const failsWith = async (promise, code, name) => assert.equal(await promise.then(() => 'resolved', error => error?.code), code, name);
// POSIX only: a git wrapper that logs each argv with its GIT_* environment; an optional case arm rewrites some calls.
function wrapGit(t, arm = '') {
  const dir = tempDir(t, 'moe-gitlog-');
  const log = join(dir, 'log');
  writeFileSync(join(dir, 'git'), `#!/bin/sh\nprintf '%s | %s\\n' "$(env | grep '^GIT_' | sort | tr '\\n' ' ')" "$*" >> '${log}'\n`
    + `case "$*" in ${arm} *) exec git "$@" ;; esac\n`, { mode: 0o755 });
  return { git: join(dir, 'git'), lines: () => readFileSync(log, 'utf8').trim().split('\n'), reset: () => writeFileSync(log, '') };
}

test('E1 base entries carry the committed bytes, sizes and sha256 values, sealed by validateImport', async t => {
  const files = { 'run.sh': '#!/bin/sh\n', 'src/deep/a.txt': 'nested\n', empty: '', 'caf\u00e9 \u00fc.bin': Buffer.from([0, 10, 255, 10, 13]) };
  const { dir, head } = repo(t, files, 'run.sh');
  const snapshot = await exportAt(dir, head);
  const expected = validateImport(Object.entries(files).map(([name, data]) => file(name, Buffer.from(data), name === 'run.sh')));
  assert.deepEqual(Object.keys(snapshot), ['version', 'commit', 'tree', 'base', 'overlay', 'excluded']);
  assert.deepEqual([snapshot.version, snapshot.commit, snapshot.tree, snapshot.excluded], [1, head, git(dir, 'rev-parse', 'HEAD^{tree}'), 0]);
  assert.deepEqual(snapshot.base.entries.map(e => [e.path, e.executable, e.size, e.sha256]),
    expected.entries.map(e => [e.path, e.path === 'run.sh', Buffer.byteLength(files[e.path]), sha(Buffer.from(files[e.path]))]));
  assert.deepEqual([snapshot.base.digest, snapshot.overlay], [expected.digest, validateImport([])]);
  for (const value of [snapshot, snapshot.base, ...snapshot.base.entries]) assert.equal(Object.isFrozen(value), true);
});

test('E2 only a full lowercase commit id and bounded listings are exported; refusals come before any blob is read', async t => {
  const { dir, head } = repo(t, { a: 'a' });
  git(dir, 'tag', '-a', '-m', 'v', 'v1');
  const rejected = [
    [head.slice(0, 7), 'EXPORT_INPUT_INVALID'], ['HEAD', 'EXPORT_INPUT_INVALID'], ['topic', 'EXPORT_INPUT_INVALID'],
    [head.toUpperCase(), 'EXPORT_INPUT_INVALID'], [`${head}\n`, 'EXPORT_INPUT_INVALID'], [git(dir, 'rev-parse', 'HEAD^{tree}'), 'EXPORT_COMMIT_INVALID'],
    [git(dir, 'rev-parse', 'v1'), 'EXPORT_COMMIT_INVALID'], ['f'.repeat(40), 'EXPORT_COMMIT_INVALID'], ['0'.repeat(64), 'EXPORT_COMMIT_INVALID'],
  ];
  for (const [commit, code] of rejected) await failsWith(exportAt(dir, commit), code, commit);
  const inputs = [null, 'x', { repoDir: 'relative', commit: head }, ...[{ git: '' }, { git: 'g\nit' }, { git: 7 }, { timeoutMs: 0 },
    { timeoutMs: 600_001 }, { timeoutMs: 1.5 }, { timeoutMs: '5' }].map(extra => ({ repoDir: dir, commit: head, ...extra }))];
  for (const input of inputs) await failsWith(exportSourceSnapshot(input), 'EXPORT_INPUT_INVALID', label(input));
  if (win32) return; // The rest needs a POSIX git wrapper.
  const logged = wrapGit(t);
  await exportAt(dir, head, { git: logged.git });
  const prefix = `--no-optional-locks --no-replace-objects -c protocol.allow=never -c core.fsmonitor=false -c safe.directory=${dir} `;
  const envelope = `GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 GIT_NO_LAZY_FETCH=1 GIT_TERMINAL_PROMPT=0  | ${prefix}`;
  assert.deepEqual(logged.lines().filter(line => !line.startsWith(envelope)), []);
  assert.ok(logged.lines().some(line => line.endsWith('cat-file --batch')), 'positive control');
  logged.reset();
  for (const [commit] of rejected.slice(-4)) await failsWith(exportAt(dir, commit, { git: logged.git }), 'EXPORT_COMMIT_INVALID', commit);
  // 10,001 listed entries, or 257 entries of 1 MiB each, are refused by the listing alone.
  for (const [count, oid] of [[MAX_IMPORT_ENTRIES + 1, blob(dir, '')], [257, blob(dir, Buffer.alloc(1 << 20))]]) {
    const tree = gitIn(dir, Array.from({ length: count }, (_, i) => `100644 blob ${oid}\tf${i}\n`).join(''), 'mktree');
    await failsWith(exportAt(dir, git(dir, 'commit-tree', tree, '-m', 'big'), { git: logged.git }), 'SNAPSHOT_LIMIT_EXCEEDED', String(count));
  }
  assert.deepEqual(logged.lines().filter(line => line.includes('cat-file')), []);
  // A short, long, foreign, LF-less or failing cat-file stream is refused, as is a malformed or unterminated listing.
  const hostile = ['git "$@" | head -c 45', '{ git "$@"; printf x; }', `sed s/.*/${blob(dir, 'b')}/ | git "$@"`,
    '{ git "$@" | head -c 49; printf x; }', 'git "$@"; exit 3'].map(command => `*cat-file*) ${command} ;;`);
  hostile.push('*ls-tree*) git "$@" | head -c -1 ;;', '*ls-tree*) git "$@" | tr l L ;;');
  for (const arm of hostile) await failsWith(exportAt(dir, head, { git: wrapGit(t, arm).git }), 'EXPORT_GIT_FAILED', arm);
});

test('E3 control paths are left out of base and counted, and a non-portable committed path refuses the export', async t => {
  const { dir, head } = repo(t, { '.moe/x': '1', 'sub/.claude/y': '2', '.MCP.json': '3', '.grok/z': '4', 'keep.txt': 'k' });
  const snapshot = await exportAt(dir, head);
  assert.deepEqual([snapshot.base.entries.map(e => e.path), snapshot.excluded], [['keep.txt'], 4]);
  // The decoder keeps a leading U+FEFF (a listing's first path never silently loses it) and refuses a name that is not UTF-8.
  const bom = repo(t, {});
  put(bom.dir, { '\ufeffbom': 'b' });
  await failsWith(exportAt(bom.dir, bom.head), 'SNAPSHOT_PATH_INVALID', 'BOM');
  gitIn(dir, Buffer.concat([Buffer.from(`100644 ${blob(dir, 'x')}\tb`), Buffer.from([0xff, 10])]), 'update-index', '--index-info');
  git(dir, 'commit', '-q', '-m', 'bad');
  await failsWith(exportAt(dir), 'SNAPSHOT_PATH_INVALID', 'not UTF-8');
});

test('E4 a tracked symlink or submodule refuses the export, unless it sits at a control path', async t => {
  const { dir, head } = repo(t, { a: 'a' });
  const rows = [['120000', blob(dir, 'a'), 'link', 'SNAPSHOT_SYMLINK_DENIED'], ['160000', head, 'sub', 'EXPORT_ENTRY_UNSUPPORTED'],
    ['120000', blob(dir, '..'), '.claude/link']];
  for (const [mode, oid, name, code] of rows) {
    git(dir, 'update-index', '--add', '--cacheinfo', `${mode},${oid},${name}`);
    git(dir, 'commit', '-q', '-m', mode);
    if (code) await failsWith(exportAt(dir), code, mode).then(() => git(dir, 'rm', '-q', '--cached', name));
  }
  // Counted in base and again in the overlay: the index-only link is missing from disk, so diff-index lists it.
  const snapshot = await exportAt(dir);
  assert.deepEqual([snapshot.base.entries.map(e => e.path), snapshot.excluded, snapshot.overlay.entries], [['a'], 2, []]);
});

test('E5 the overlay holds exactly the dirty worktree bytes, leaving out ignored files, control paths and stat-only changes', async t => {
  const { dir, head } = repo(t, { 'mod.txt': 'old', 'del.txt': 'gone', 'same.txt': 's', '.gitignore': 'ignored.log\n', '.moe/state.json': '{}' });
  const clean = await exportAt(dir, head);
  put(dir, { 'mod.txt': 'new\n', 'new/dir/u.txt': 'untracked', 'ignored.log': 'x', 'staged.txt': 'staged', '.moe/state.json': '{"a":1}' });
  rmSync(join(dir, 'del.txt'));
  git(dir, 'add', 'staged.txt');
  git(dir, 'rm', '-q', '--cached', 'mod.txt'); // Now listed by both diff-index and ls-files, but read once.
  utimesSync(join(dir, 'same.txt'), 1e9, 1e9);
  if (!win32) chmodSync(join(dir, 'mod.txt'), 0o755);
  const snapshot = await exportAt(dir, head);
  assert.deepEqual(snapshot.overlay.entries.map(e => [e.path, e.kind, e.executable, e.sha256]), [['del.txt', 'delete', undefined, undefined],
    ['mod.txt', 'file', !win32, sha('new\n')], ['new/dir/u.txt', 'file', false, sha('untracked')], ['staged.txt', 'file', false, sha('staged')]]);
  assert.equal(snapshot.overlay.digest, validateImport([del('del.txt'), file('mod.txt', Buffer.from('new\n'), !win32),
    file('new/dir/u.txt', Buffer.from('untracked')), file('staged.txt', Buffer.from('staged'))]).digest);
  assert.deepEqual([snapshot.base, snapshot.excluded, clean.excluded], [clean.base, 2, 1]);
});

test('E6 a symlink at or above a dirty path, or a non-regular one, refuses the export without reading through it',
  { skip: win32 && 'needs POSIX symlinks and FIFOs' }, async t => {
    // A followed link to the FIFO would be refused as EXPORT_ENTRY_UNSUPPORTED, and dir -> . would read f.txt.
    const fifo = at => execFileSync('mkfifo', [at]);
    const swap = (name, make) => dir => { rmSync(join(dir, name), { recursive: true }); make(join(dir, name)); };
    const rows = [
      ['untracked symlink', 'SNAPSHOT_SYMLINK_DENIED', dir => symlinkSync('pipe', join(dir, 'ln'))],
      ['file replaced by a symlink', 'SNAPSHOT_SYMLINK_DENIED', swap('f.txt', at => symlinkSync('pipe', at))],
      // The link is ignored, so only the tracked dir/f.txt below it is listed.
      ['ignored link over a tracked directory', 'SNAPSHOT_SYMLINK_DENIED', swap('dir', at => symlinkSync('.', at))],
      ['file replaced by a FIFO', 'EXPORT_ENTRY_UNSUPPORTED', swap('f.txt', fifo)],
      ['untracked nested repository', 'EXPORT_ENTRY_UNSUPPORTED', dir => git(dir, 'init', '-q', 'nested')],
      ['staged gitlink over a checkout Git cannot open', 'EXPORT_ENTRY_UNSUPPORTED', dir => put(dir, { 'sub/.git': 'gitdir: x\n' })
        ?? git(dir, 'update-index', '--add', '--cacheinfo', `160000,${'1'.repeat(40)},sub`)],
      ['untracked FIFO (Git never lists one)', 'resolved', () => {}],
    ];
    for (const [name, code, dirty] of rows) {
      const { dir, head } = repo(t, { 'f.txt': 'f', 'dir/f.txt': 'g' });
      put(dir, { '.gitignore': '/dir\n' });
      fifo(join(dir, 'pipe'));
      dirty(dir);
      await failsWith(exportAt(dir, head), code, name);
    }
  });

test('E7 Git runs in the read-only envelope: no replace objects, no inherited GIT_* state, toplevel repositories only', async t => {
  const { dir, head } = repo(t, { 'a.txt': 'original' });
  const other = repo(t, { 'a.txt': 'other' });
  git(dir, 'replace', blob(dir, 'original'), blob(dir, 'replaced'));
  assert.equal(git(dir, 'cat-file', 'blob', blob(dir, 'original')), 'replaced', 'the replacement is live outside the envelope');
  const inherited = { GIT_DIR: join(other.dir, '.git'), GIT_WORK_TREE: other.dir, GIT_INDEX_FILE: join(other.dir, '.git', 'index') };
  const saved = Object.keys(inherited).map(key => [key, process.env[key]]);
  Object.assign(process.env, inherited);
  const restore = ([key, value]) => (value === undefined ? delete process.env[key] : Object.assign(process.env, { [key]: value }));
  const snapshot = await exportAt(dir, head).finally(() => saved.forEach(restore));
  assert.deepEqual([snapshot.base.entries.map(e => Buffer.from(e.data).toString()), snapshot.overlay.entries], [['original'], []]);
  mkdirSync(join(dir, 'sub'));
  for (const repoDir of [join(dir, 'sub'), join(dir, 'missing'), tempDir(t, 'moe-norepo-')]) {
    await failsWith(exportSourceSnapshot({ repoDir, commit: head }), 'EXPORT_REPOSITORY_UNSUPPORTED', repoDir);
  }
  for (const [key, value] of [['extensions.partialclone', 'o'], ['remote.o.promisor', 'true'], ['core.worktree', dir], ['filter.x.clean', 'cat']]) {
    git(dir, 'config', key, value);
    await failsWith(exportAt(dir, head), 'EXPORT_REPOSITORY_UNSUPPORTED', key);
    git(dir, 'config', '--unset', key);
  }
});

test('E8 an export writes nothing to the repository and runs no fsmonitor hook', async t => {
  const { dir, head } = repo(t, { 'a.txt': 'a', 'b.txt': 'b' });
  for (const args of [['tag', 'v1'], ['pack-refs', '--all'], ['branch', 'loose']]) git(dir, ...args);
  const marker = join(tempDir(t, 'moe-hook-'), 'ran');
  if (!win32) {
    writeFileSync(`${marker}.sh`, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
    git(dir, 'config', 'core.fsmonitor', `${marker}.sh`);
    git(dir, 'status');
    rmSync(marker); // Throws unless the hook ran outside the envelope.
  }
  put(dir, { 'a.txt': 'changed', 'u.txt': 'u' });
  utimesSync(join(dir, 'b.txt'), 1e9, 1e9); // A stat-only change is what makes porcelain git diff rewrite the index.
  const files = () => readdirSync(join(dir, '.git'), { recursive: true }).sort()
    .map(name => [name, statSync(join(dir, '.git', name)).isFile() ? sha(readFileSync(join(dir, '.git', name))) : 'dir']);
  const before = files();
  const { overlay } = await exportAt(dir, head);
  assert.deepEqual([overlay.entries.map(e => e.path), files(), existsSync(marker)], [['a.txt', 'u.txt'], before, false]);
});
