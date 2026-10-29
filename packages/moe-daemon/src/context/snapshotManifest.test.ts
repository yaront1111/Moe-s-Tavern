import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { snapshotPathRefusal, verifySourceSnapshot } from './snapshotManifest.js';

// The landed R09a/R09b modules, absent in the Docker context (packages/moe-daemon only): those rows skip there.
const here = path.dirname(fileURLToPath(import.meta.url));
const runner = path.resolve(here, '../../../../scripts/local-runner');
const hasScripts = fs.existsSync(path.join(runner, 'source-snapshot.mjs'));
const load = async (name: string) => (hasScripts ? import(pathToFileURL(path.join(runner, name)).href) : null);
const r09a = await load('source-snapshot.mjs');
const INVALID = 'SNAPSHOT_PATH_INVALID'; const CONTROL = 'SNAPSHOT_CONTROL_PATH';

const P1: Array<[unknown, string | null]> = [
  ...['a.ts', 'src/x/y.md', '\u00e9.ts', 'a.b.c', 'ABCDEFGH~12.txt', `${'a/'.repeat(511)}ab`, 'a'.repeat(255),
    `${'\u00e9'.repeat(127)}a`].map(p => [p, null] as [string, null]),
  ...['.git', '.git/x', 'a/.GIT/x', '.moe/p.json', 'x/.Moe', '.mcp.json', '.claude/x', '.codex', '.gemini/x', '.grok',
    '.worktrees/a', '.gitmodules', '.g\u0131t', '.git/CON'].map(p => [p, CONTROL] as [string, string]),
  ...[42, '', '..', 'a/../b', './a', 'a/./b', 'a//b', '/a', 'a/', 'a\u005cb', 'a:b', 'a<b', 'a\u0000b', '\u202e.ts',
    '\ufeff.ts', 'a\u200bb', 'a\u061cb', 'a\u009fb', 'CON', 'con.txt', 'a/NUL', 'COM1', 'LPT\u00b9', 'CON .txt',
    'CONIN$', 'PROGRA~1', 'GIT~1', 'a/ABCDE~12.txt', 'a.', 'a ', ' a', 'e\u0301.ts', '\ud800.ts',
    `${'a/'.repeat(511)}abc`, 'a'.repeat(256), '\u00e9'.repeat(128), `${'\u00e9\u00e9/'.repeat(300)}a`].map(p => [p, INVALID] as [unknown, string]),
];

describe('P1 snapshotPathRefusal', () => {
  it.each(P1)('%j -> %s', (input, code) => expect(snapshotPathRefusal(input as string)).toBe(code));
  it.skipIf(!hasScripts)('matches R09a validateImportPath on every row', () => {
    const viaR09a = (input: unknown) => { try { r09a.validateImportPath(input); return null; } catch (error) { return (error as { code: string }).code; } };
    expect(P1.map(([input]) => viaR09a(input))).toEqual(P1.map(([, code]) => code));
  });
});

type Entry = { kind: string; path: string; executable: boolean; size: number; sha256: string; data: Uint8Array };
type LayerIn = { entries: Array<Partial<Entry>>; digest: string };
type Snap = { version: number; commit: string; tree: string; base: LayerIn; overlay: LayerIn; excluded: number };
const sha = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');
const u32 = (value: number) => { const out = Buffer.alloc(4); out.writeUInt32BE(value); return out; };
const file = (name: string, text: string, executable = false) => ({ kind: 'file', path: name, executable, data: new TextEncoder().encode(text) });
const del = (name: string) => ({ kind: 'delete', path: name });
// An independent oracle of R09a's seal: entries sorted by UTF-8 path bytes, sealed, and the layer digest.
function seal(entries: Array<Partial<Entry>>): LayerIn {
  const sorted = [...entries].sort((a, b) => Buffer.compare(Buffer.from(a.path!), Buffer.from(b.path!)));
  const hash = createHash('sha256').update('moe-source-snapshot-v1\0').update(u32(sorted.length));
  return { entries: sorted.map(({ kind, path: name, executable, data }) => {
    hash.update(Buffer.from([kind === 'file' ? 0x46 : 0x44])).update(u32(Buffer.byteLength(name!))).update(name!);
    if (!data) return { kind, path: name };
    hash.update(Buffer.from([executable ? 1 : 0])).update(u32(data.length)).update(Buffer.from(sha(data), 'hex'));
    return { kind, path: name, executable, size: data.length, sha256: sha(data), data };
  }), digest: hash.digest('hex') };
}
const BASE = [file('a.ts', 'a\n'), file('dir/b.sh', '#!\n', true), file('z.md', '')];
const OVERLAY = [file('a.ts', 'A\n'), file('c.ts', 'c', true), del('dir/b.sh')];
const good = (): Snap => structuredClone({ version: 1, commit: 'a'.repeat(40), tree: 'b'.repeat(40), base: seal(BASE), overlay: seal(OVERLAY), excluded: 2 });
const refused = (code: string, layer?: string) => ({ ok: false, code, layer });

describe('V1-V5 verifySourceSnapshot', () => {
  it.skipIf(!hasScripts)('V1 conforms to R09a validateImport and returns a frozen private view', () => {
    const base = r09a.validateImport(BASE); const overlay = r09a.validateImport(OVERLAY);
    expect([base.digest, overlay.digest]).toEqual([seal(BASE).digest, seal(OVERLAY).digest]);
    const result = verifySourceSnapshot({ version: 1, commit: 'c'.repeat(64), tree: 'd'.repeat(64), base, overlay, excluded: 0 });
    if (!result.ok) throw new Error(result.code); const view = result.snapshot;
    expect([view.version, view.commit, view.tree, view.excluded]).toEqual([1, 'c'.repeat(64), 'd'.repeat(64), 0]);
    expect(view.identity).toEqual({ base: base.digest, overlay: overlay.digest });
    expect([...view.base.values()].map(entry => entry.sha256)).toEqual(base.entries.map((entry: Entry) => entry.sha256));
    expect([...view.overlay.values()].map(entry => ('kind' in entry ? entry.kind : entry.sha256)))
      .toEqual(overlay.entries.map((entry: Entry) => entry.sha256 ?? entry.kind));
    expect([view, view.identity, ...view.base.values(), ...view.overlay.values()].every(Object.isFrozen)).toBe(true);
    const a = view.base.get('a.ts')!; base.entries[0].data[0] = 0x7a;
    expect([Buffer.from(a.data).toString(), sha(a.data)]).toEqual(['a\n', a.sha256]);
  });

  const I = 'SNAPSHOT_INPUT_INVALID'; const E = 'SNAPSHOT_ENTRY_INVALID'; const L = 'SNAPSHOT_LIMIT_EXCEEDED';
  const C = 'SNAPSHOT_PATH_COLLISION'; const D = 'SNAPSHOT_DIGEST_MISMATCH'; const S = 'SNAPSHOT_SYMLINK_DENIED';
  const e0 = (s: Snap) => s.base.entries[0];
  const V3: Array<[string, string, (s: Snap) => unknown, string?]> = [
    ['a missing key', I, s => Reflect.deleteProperty(s, 'excluded')], ['an extra key', I, s => Object.assign(s, { extra: 1 })],
    ['version 2', I, s => Object.assign(s, { version: 2 })], ['an uppercase commit', I, s => Object.assign(s, { commit: 'A'.repeat(40) })],
    ['a 40/64 id length mismatch', I, s => Object.assign(s, { tree: 'b'.repeat(64) })], ['ids with a trailing newline', I, s => Object.assign(s, { commit: `${s.commit}\n`, tree: `${s.tree}\n` })],
    ['a String commit', I, s => Object.assign(s, { commit: new String(s.commit) })], ['a String tree', I, s => Object.assign(s, { tree: new String(s.tree) })],
    ...[-1, 1.5, '0'].map(excluded => [`excluded ${excluded}`, I, (s: Snap) => Object.assign(s, { excluded })] as [string, string, (s: Snap) => unknown]),
    ['a class-instance prototype', I, s => Object.setPrototypeOf(s, class Snapshot {}.prototype)],
    ['a layer extra key', I, s => Object.assign(s.base, { extra: 1 }), 'base'], ['subclassed entries', I, s => Object.setPrototypeOf(s.base.entries, class extends Array {}.prototype), 'base'],
    ['array-like entries', I, s => Object.assign(s.base, { entries: Object.setPrototypeOf({ ...s.base.entries, length: 3 }, Array.prototype) }), 'base'],
    ['a digest with a trailing newline', I, s => Object.assign(s.base, { digest: `${s.base.digest}\n` }), 'base'],
    ['10001 entries', L, s => { s.overlay.entries.length = 10_001; }, 'overlay'],
    ['2**28+1 bytes, refused before hashing', L, s => Object.assign(e0(s), { data: new Uint8Array(2 ** 28 + 1), size: 2 ** 28 + 1 }), 'base'],
    ['a missing size', E, s => Reflect.deleteProperty(e0(s), 'size'), 'base'], ['an extra entry key', E, s => Object.assign(e0(s), { mode: 1 }), 'base'],
    ['a size mismatch', E, s => Object.assign(e0(s), { size: 3 }), 'base'], ['executable 1', E, s => Object.assign(e0(s), { executable: 1 }), 'base'],
    ['number-array data', E, s => Object.assign(e0(s), { data: [97, 10] }), 'base'],
    ['a Uint8ClampedArray', E, s => Object.assign(e0(s), { data: new Uint8ClampedArray([97, 10]) }), 'base'],
    ['a Float64Array posing as Uint8Array', E, s => Object.assign(e0(s), { data: Object.setPrototypeOf(new Float64Array(1), Uint8Array.prototype), size: 8 }), 'base'],
    ['an uppercase sha256', E, s => Object.assign(e0(s), { sha256: e0(s).sha256!.toUpperCase() }), 'base'],
    ['a delete in base', E, s => s.base.entries.push(del('zz')), 'base'],
    ['an orphan overlay delete', E, s => s.overlay.entries.push(del('zz')), 'overlay'],
    ['unsorted entries', E, s => s.base.entries.reverse(), 'base'],
    ['an own byteLength spoof', E, s => Object.assign(e0(s), { data: Object.defineProperty(new Uint8Array(5), 'byteLength', { value: 2 }) }), 'base'],
    ['a base symlink', S, s => Object.assign(e0(s), { kind: 'symlink' }), 'base'], ['an overlay symlink', S, s => Object.assign(s.overlay.entries[2], { kind: 'symlink' }), 'overlay'],
    ['a traversal path', INVALID, s => Object.assign(e0(s), { path: 'a/../b' }), 'base'], ['a control path', CONTROL, s => Object.assign(e0(s), { path: '.git/x' }), 'base'],
    ['a repeated path', C, s => s.base.entries.splice(1, 0, e0(s)), 'base'],
    ['a case-folded duplicate', C, s => s.base.entries.unshift({ ...e0(s), path: 'A.ts' }), 'base'],
    ['an ancestor file', C, s => s.base.entries.splice(1, 0, { ...e0(s), path: 'a.ts/x' }), 'base'],
    ['a base file under an overlay file', C, s => Object.assign(s, { overlay: seal([file('dir', '')]) })],
    ['an overlay file under a base file', C, s => Object.assign(s, { overlay: seal([file('z.md/y', '')]) })],
    ['a case-folded overlay twin', C, s => Object.assign(s, { overlay: seal([file('Z.MD', '')]) })],
    ['a flipped byte', 'SNAPSHOT_HASH_MISMATCH', s => { e0(s).data![0] ^= 1; }, 'base'],
    ['a wrong base digest', D, s => Object.assign(s.base, { digest: '0'.repeat(64) }), 'base'],
    ['a flipped executable bit', D, s => Object.assign(e0(s), { executable: true }), 'base'],
    ['a stale overlay digest', D, s => Object.assign(s.overlay, { digest: seal(BASE).digest }), 'overlay'],
  ];
  it('V3 accepts the unmutated fixture', () => expect(verifySourceSnapshot(good()).ok).toBe(true));
  it.each(V3)('V3 refuses %s as %s', (_, code, mutate, layer) => {
    const s = good(); mutate(s);
    expect(verifySourceSnapshot(s)).toEqual(refused(code, layer));
  });

  const trap = (name: string) => new Proxy(good(), { [name]: () => { throw new Error('trap'); } });
  const revoked = Proxy.revocable({}, {}); revoked.revoke();
  it.each([['null', null], ['an array', [good()]], ['a Symbol', Symbol('s')], ['a BigInt', 1n], ['a function', good],
    ...['get', 'ownKeys', 'getPrototypeOf'].map(name => [`a throwing ${name} trap`, trap(name)]), ['a revoked Proxy', revoked.proxy],
  ])('V4 refuses %s without throwing', (_, raw) => expect(verifySourceSnapshot(raw)).toEqual(refused(I)));
  it('V4 maps a throw inside an entry, even of a hostile Proxy, to ENTRY_INVALID', () => {
    const hostile = new Proxy({}, { getPrototypeOf: () => { throw new Error('trap'); } });
    for (const entry of [new Proxy(e0(good()), { get: () => { throw new Error('trap'); } }),
      Object.defineProperty({}, 'kind', { enumerable: true, get: () => { throw hostile; } })]) {
      const s = good(); s.base.entries[0] = entry;
      expect(verifySourceSnapshot(s)).toEqual(refused(E, 'base'));
    }
  });
  it('V4 reads every snapshot, layer and entry property once', () => {
    const s = good(); const reads: Record<string, number> = {};
    const once = (target: object, prefix: string) => Object.entries(target).forEach(([key, value]) => {
      let left = 1;
      Object.defineProperty(target, key, { enumerable: true, get: () => { reads[prefix + key] = (reads[prefix + key] ?? 0) + 1; return left-- > 0 ? value : undefined; } });
    });
    once(e0(s), 'entry.'); once(s.base, 'base.'); once(s, '');
    expect(verifySourceSnapshot(s).ok).toBe(true);
    expect([Object.keys(reads).length, ...new Set(Object.values(reads))]).toEqual([14, 1]);
  });
  it('V5 never copies entries through species and reads a Proxy length once, uncoerced', () => {
    let species = 0; let lengths = 0; let coerced = 0;
    const s = good();
    Object.assign(s.base.entries, { constructor: { [Symbol.species]: function Species() { species += 1; return []; } } });
    s.overlay.entries = new Proxy(s.overlay.entries, { get: (target, key) => (key === 'length' ? (lengths += 1, target.length) : Reflect.get(target, key)) });
    expect(verifySourceSnapshot(s).ok).toBe(true);
    s.overlay.entries = new Proxy([], { get: (target, key) => (key === 'length' ? { valueOf: () => (coerced += 1, 1) } : Reflect.get(target, key)) });
    expect(verifySourceSnapshot(s)).toEqual(refused(I, 'overlay'));
    expect([species, lengths, coerced]).toEqual([0, 1, 0]);
  });
});

describe.skipIf(!hasScripts)('V2 the landed R09b producer', () => {
  const roots: string[] = [];
  afterAll(() => roots.forEach(root => fs.rmSync(root, { recursive: true, force: true })));
  it('V2 verifies a real exportSourceSnapshot, and its exact keys hold', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'moe-snapshot-'))); roots.push(root);
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')));
    Object.assign(env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null' });
    const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.test', ...args],
      { cwd: root, env, encoding: 'utf8' }).trim();
    const put = (name: string, text: string) => [fs.mkdirSync(path.join(root, name, '..'), { recursive: true }), fs.writeFileSync(path.join(root, name), text)];
    git('init', '-q'); put('a.ts', 'a\n'); put('dir/b.ts', 'b\n'); git('add', '-A'); git('commit', '-q', '-m', 'base');
    put('a.ts', 'A\n'); fs.rmSync(path.join(root, 'dir', 'b.ts')); put('c.ts', 'c\n'); put('.moe/x.json', '{}');
    const exported = await (await load('source-export.mjs')).exportSourceSnapshot({ repoDir: root, commit: git('rev-parse', 'HEAD') })
      .catch((error: { code?: string }) => { throw new Error(`export failed: ${error.code}`); });
    const result = verifySourceSnapshot(exported);
    if (!result.ok) throw new Error(result.code);
    const { identity, base, overlay, excluded } = result.snapshot;
    expect(identity).toEqual({ base: exported.base.digest, overlay: exported.overlay.digest });
    expect([...base.keys()]).toEqual(['a.ts', 'dir/b.ts']);
    expect([...overlay].map(([name, entry]) => [name, 'kind' in entry ? entry.kind : 'file']))
      .toEqual([['a.ts', 'file'], ['c.ts', 'file'], ['dir/b.ts', 'delete']]);
    expect([excluded, exported.excluded]).toEqual([1, 1]);
    expect(verifySourceSnapshot({ ...structuredClone(exported), extra: 1 })).toEqual(refused('SNAPSHOT_INPUT_INVALID'));
  });
});

it('V6 keeps the module pure and both files ASCII-only', () => {
  const read = (name: string) => fs.readFileSync(path.join(here, name), 'utf8');
  expect([...read('snapshotManifest.ts').matchAll(/^import .* from '([^']+)';$/gm)].map(match => match[1])).toEqual(['node:crypto']);
  expect(read('snapshotManifest.ts')).not.toMatch(/\bfs\b|child_process|process\.env|import\(|require\(/);
  for (const name of ['snapshotManifest.ts', 'snapshotManifest.test.ts']) expect([...read(name)].filter(ch => ch.charCodeAt(0) > 0x7f)).toEqual([]);
});
