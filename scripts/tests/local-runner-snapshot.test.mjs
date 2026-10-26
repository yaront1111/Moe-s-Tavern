import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
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
