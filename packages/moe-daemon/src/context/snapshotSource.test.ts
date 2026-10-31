import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { MoeErrorCode } from '../util/errors.js';
import { readRepositorySource, type SourceLimits, type SourceQuery } from './repositorySource.js';
import { readSnapshotSource, type SnapshotRequest } from './snapshotSource.js';

// Fixtures come from the landed R09a/R09b producers, absent in the Docker context (packages/moe-daemon only).
const here = path.dirname(fileURLToPath(import.meta.url));
const runner = path.resolve(here, '../../../../scripts/local-runner');
const hasScripts = fs.existsSync(path.join(runner, 'source-snapshot.mjs'));
const load = async (name: string) => (hasScripts ? import(pathToFileURL(path.join(runner, name)).href) : null);
const r09a = await load('source-snapshot.mjs');

const COMMIT = 'c'.repeat(40); const TREE = 'd'.repeat(40);
const file = (name: string, bytes: string | number[], executable = false) =>
  ({ kind: 'file', path: name, executable, data: Uint8Array.from(typeof bytes === 'string' ? Buffer.from(bytes) : bytes) });
// 70 bytes: a 64-byte cap splits the two-byte e-acute.
const BIG = `${'x'.repeat(63)}éyyyyy`;
const B_TS = 'hello b\r\nnext hello\n';
const BASE = [file('big.txt', BIG), file('bin.dat', 'odd\0\n'), file('docs/x.md', 'hello gone\n'),
  file('latin1.txt', [...Buffer.from('odd caf'), 0xe9, 0x0a]), file('src/a.ts', 'const a = 1; // basetoken\n'), file('src/b.ts', B_TS, true)];
const OVERLAY = [{ kind: 'delete', path: 'docs/x.md' }, file('src/a.ts', 'const a = 2; // hello\n'), file('src/new.ts', 'odd new\n')];
const snapshot = () => Object.freeze({ version: 1, commit: COMMIT, tree: TREE, base: r09a.validateImport(BASE), overlay: r09a.validateImport(OVERLAY), excluded: 0 });
type Snap = ReturnType<typeof snapshot>;

const read = (name: string, id = 'r'): SourceQuery => ({ id, purpose: 'source', op: 'read', path: name });
const search = (literal: string, paths?: string[], id = 's'): SourceQuery => ({ id, purpose: 'caller', op: 'search', literal, ...(paths ? { paths } : {}) });
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const prov = (snap: Snap, layer: 'base' | 'overlay', text: string) => ({ layer, manifest: snap[layer].digest, sha256: sha(text) });
const serve = (queries: SourceQuery[], limits: Partial<SourceLimits> = {}, request: SnapshotRequest = { commit: COMMIT }, snap: unknown = snapshot()) =>
  readSnapshotSource(snap, request, queries, { limits });
const invalid = (field: string) => expect.objectContaining({ code: MoeErrorCode.INVALID_INPUT, context: expect.objectContaining({ field }) });
const ALL = [read('src/b.ts', 'r0'), read('src/a.ts', 'r1'), search('hello')];
afterEach(() => { vi.restoreAllMocks(); });

it.each(['../x', 'a/../b'])('S7 %s throws INVALID_INPUT before any verification', name => {
  expect(() => readSnapshotSource(null, { commit: COMMIT }, [read(name)])).toThrow(invalid('queries[0].path'));
});

describe.skipIf(!hasScripts)('S1-S17 readSnapshotSource over R09a-sealed layers', () => {
  it.each([
    ['S1 base-only', 'src/b.ts', 'base', B_TS, '100755'] as const,
    ['S2 overlay-modified', 'src/a.ts', 'overlay', 'const a = 2; // hello\n', '100644'] as const,
    ['S3 overlay-added', 'src/new.ts', 'overlay', 'odd new\n', '100644'] as const,
  ])('%s read serves its layer bytes with provenance derived from them', (_name, name, layer, text, mode) => {
    const snap = snapshot();
    const bytes = Buffer.byteLength(text);
    expect(serve([read(name)], {}, undefined, snap).items).toEqual([{ id: 'r', purpose: 'source', op: 'read', path: name, status: 'served',
      mode, size: bytes, content: text, bytes, provenance: prov(snap, layer, text) }]);
  });

  const rows = (status: string, reason: string, ...names: string[]) => names.map(name => [name, status, reason] as [string, string, string]);
  it.each([
    ...rows('missing', 'deleted-in-overlay', 'docs/x.md'),
    ...rows('refused', 'control-path', '.moe/project.json', '.GIT/config', 'src/.git/x'),
    ...rows('refused', 'path-invalid', 'CON.txt', 'a/PROGRA~1/x', 'é.ts'),
    ...rows('refused', 'not-a-file', 'src'), ...rows('missing', 'not-in-manifest', 'src/a.ts/child', 'nope.ts'),
    ...rows('refused', 'binary', 'bin.dat'), ...rows('refused', 'not-utf8', 'latin1.txt'),
  ])('S4-S9 %j is %s/%s and serves nothing', (name, status, reason) => {
    const snap = snapshot();
    const [item] = serve([read(name)], {}, undefined, snap).items;
    expect(item).toMatchObject({ path: name, status, reason, bytes: 0 });
    expect(item.content).toBeUndefined();
    // Only a verified file carries provenance, and only its own layer's: never a base fallback.
    expect(item.provenance).toEqual(['binary', 'not-utf8'].includes(reason) ? expect.objectContaining({ layer: 'base' }) : undefined);
  });

  it('S9 a capped read serves exactly the decodable prefix', () => {
    expect(serve([read('big.txt')], { maxFileBytes: 64 }).items[0])
      .toMatchObject({ status: 'truncated', reason: 'file-byte-cap', size: 70, content: 'x'.repeat(63), bytes: 63 });
  });

  const layer = (snap: Snap, key: 'base' | 'overlay', entries: unknown[], digest = snap[key].digest) => ({ ...snap, [key]: { entries, digest } });
  it.each([
    ['a copied entry with a wrong sha256', 'SNAPSHOT_HASH_MISMATCH', (s: Snap) => layer(s, 'base', [{ ...s.base.entries[0], sha256: '0'.repeat(64) }, ...s.base.entries.slice(1)])],
    ['a wrong layer digest', 'SNAPSHOT_DIGEST_MISMATCH', (s: Snap) => layer(s, 'base', s.base.entries, '0'.repeat(64))],
    ['an overlay entry at .moe/x', 'SNAPSHOT_CONTROL_PATH', (s: Snap) => layer(s, 'overlay', [{ ...file('.moe/x', 'x'), size: 1, sha256: sha('x') }, ...s.overlay.entries])],
    ['a symlink entry', 'SNAPSHOT_SYMLINK_DENIED', (s: Snap) => layer(s, 'overlay', [s.overlay.entries[0], { kind: 'symlink', path: 'link' }, ...s.overlay.entries.slice(1)])],
  ])('S10 %s makes every item unavailable, base-only paths included', (_name, code, mutate) => {
    const result = serve(ALL, {}, undefined, mutate(snapshot()));
    expect(result).toEqual({ manifest: { commit: COMMIT, tree: null, base: null, overlay: null }, complete: false, bytes: 0,
      limitations: ['snapshot-bytes', 'snapshot-unverifiable'],
      items: ALL.map(q => ({ id: q.id, purpose: q.purpose, op: q.op, status: 'unavailable', reason: `snapshot-unverifiable:${code}`, bytes: 0, ...(q.op === 'read' ? { path: q.path } : {}) })) });
  });

  it.each([
    ['commit', { commit: 'e'.repeat(40) }], ['base', { commit: COMMIT, base: 'e'.repeat(64) }], ['overlay', { commit: COMMIT, overlay: 'e'.repeat(64) }],
  ])('S11 a %s mismatch makes every item snapshot-stale and reports the identity received', (_name, request) => {
    const snap = snapshot();
    const result = serve(ALL, {}, request, snap);
    expect(result.manifest).toEqual({ commit: COMMIT, tree: TREE, base: snap.base.digest, overlay: snap.overlay.digest });
    expect(result.items.map(i => [i.status, i.reason, i.bytes, i.content, i.matches])).toEqual(ALL.map(() => ['unavailable', 'snapshot-stale', 0, undefined, undefined]));
    expect([result.complete, result.limitations]).toEqual([false, ['snapshot-bytes', 'snapshot-stale']]);
  });
  it('S11 a matching request serves, and a malformed identity throws', () => {
    const snap = snapshot();
    expect(serve(ALL, {}, { commit: COMMIT, base: snap.base.digest, overlay: snap.overlay.digest }, snap).complete).toBe(true);
    for (const key of ['base', 'overlay']) expect(() => serve(ALL, {}, { commit: COMMIT, [key]: 'E'.repeat(64) })).toThrow(invalid(`request.${key}`));
  });

  it('S12 search serves the merged view in path then line order, each match with its provenance', () => {
    const snap = snapshot();
    const a = prov(snap, 'overlay', 'const a = 2; // hello\n'); const b = prov(snap, 'base', B_TS);
    const result = serve([search('hello'), search('basetoken', undefined, 't'), search('gone', undefined, 'g')], {}, undefined, snap);
    expect(result.items[0]).toEqual({ id: 's', purpose: 'caller', op: 'search', status: 'served', bytes: 63, matches: [
      { path: 'src/a.ts', line: 1, text: 'const a = 2; // hello', provenance: a },
      { path: 'src/b.ts', line: 1, text: 'hello b\r', provenance: b }, { path: 'src/b.ts', line: 2, text: 'next hello', provenance: b }] });
    // Only in the replaced base bytes of src/a.ts, or only in deleted docs/x.md: never matched.
    expect(result.items.slice(1).map(i => [i.status, i.matches])).toEqual([['served', []], ['served', []]]);
    expect([result.complete, result.limitations]).toEqual([true, ['literal-search-only', 'snapshot-bytes']]);
  });

  it.each([
    [['src'], 'served', undefined, 3], [['src/b.ts'], 'served', undefined, 2], [['.moe'], 'refused', 'control-path', 0],
    [['docs/x.md'], 'missing', 'deleted-in-overlay', 0], [['nope'], 'missing', 'scope-not-in-manifest', 0], [['src', 'nope'], 'missing', 'scope-not-in-manifest', 0],
  ])('S13 scope %j is %s/%s with %i matches', (paths, status, reason, count) => {
    const [item] = serve([search('hello', paths)]).items;
    expect([item.status, item.reason, item.matches?.length ?? 0]).toEqual([status, reason, count]);
  });

  it('S14 match and byte caps truncate explicitly; undecodable matched lines are reported, not served', () => {
    const first = { path: 'src/a.ts', line: 1, text: 'const a = 2; // hello' };
    expect(serve([search('hello')], { maxMatches: 1 }).items[0]).toMatchObject({ status: 'truncated', reason: 'match-cap', bytes: 29, matches: [first] });
    expect(serve([search('hello')], { maxSearchBytes: 44 }).items[0]).toMatchObject({ status: 'truncated', reason: 'search-byte-cap', bytes: 29, matches: [first] });
    const snap = snapshot();
    expect(serve([search('odd')], {}, undefined, snap).items[0]).toMatchObject({ status: 'truncated', reason: 'undecodable-match', bytes: 17,
      matches: [{ path: 'src/new.ts', line: 1, text: 'odd new', provenance: prov(snap, 'overlay', 'odd new\n') }] });
  });

  it('S15 the total-byte cap omits later items with their content stripped', () => {
    const [first, second] = serve([read('src/new.ts', 'a'), read('src/b.ts', 'b')], { maxTotalBytes: 8 }).items;
    expect([first.status, first.bytes]).toEqual(['served', 8]);
    expect(second).toMatchObject({ status: 'omitted', reason: 'total-byte-cap', bytes: 0 });
    expect(second.content).toBeUndefined();
  });

  it('S16 one deadline bounds the whole call: a truncated search, then unavailable items, never a throw', () => {
    const snap = snapshot();
    // Call 1 sets the deadline, call 2 admits the search, call 3 scans src/a.ts; from call 4 (src/b.ts) the budget is spent.
    let calls = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => (++calls < 4 ? 0 : 5));
    const result = serve([search('hello', ['src']), read('src/a.ts')], { timeBudgetMs: 1 }, undefined, snap);
    expect(result.items.map(i => [i.status, i.reason, i.matches?.length])).toEqual([['truncated', 'time-budget', 1], ['unavailable', 'time-budget', undefined]]);
  });
  it('S16 the deadline also cuts a scan inside one long file', () => {
    const layer = r09a.validateImport([file('long.txt', `${'x\n'.repeat(4999)}hello\n`)]);
    const snap = { ...snapshot(), base: layer, overlay: r09a.validateImport([]) };
    // Calls 1-3: the deadline, the query and the file; call 4 is the in-file check at line 4096.
    let calls = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => (++calls < 4 ? 0 : 5));
    expect(serve([search('hello')], { timeBudgetMs: 1 }, undefined, snap).items[0]).toMatchObject({ status: 'truncated', reason: 'time-budget', matches: [] });
  });

  it('S17 the module is pure and leaves its inputs untouched', () => {
    const text = fs.readFileSync(path.join(here, 'snapshotSource.ts'), 'utf8');
    expect([...text.matchAll(/^import [\s\S]*? from '([^']+)';$/gm)].map(m => m[1])).toEqual(['../util/errors.js', './repositorySource.js', './snapshotManifest.js']);
    expect(text).not.toMatch(/node:fs|child_process|cachedPlanPaths|process\.env|import\(|require\(/);
    const queries = [read('src/a.ts'), search('hello', ['src'])]; const before = structuredClone(queries);
    serve(queries);
    expect(queries).toEqual(before);
  });
});

describe.skipIf(!hasScripts)('E2E the landed R09b producer against C02', () => {
  const roots: string[] = [];
  afterAll(() => roots.forEach(root => fs.rmSync(root, { recursive: true, force: true })));
  it('serves committed bytes exactly as C02 does and dirty bytes from the overlay', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'moe-snapshot-source-'))); roots.push(root);
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')));
    Object.assign(env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null' });
    const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.test', ...args],
      { cwd: root, env, encoding: 'utf8' }).trim();
    const put = (name: string, text: string) => { fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true }); fs.writeFileSync(path.join(root, name), text); };
    git('init', '-q'); put('keep.ts', 'keep\n'); put('edit.ts', 'v1\n'); put('gone.ts', 'gone\n'); git('add', '-A'); git('commit', '-q', '-m', 'base');
    const commit = git('rev-parse', 'HEAD');
    put('edit.ts', 'v2 dirty\n'); fs.rmSync(path.join(root, 'gone.ts')); put('add.ts', 'added\n'); put('.moe/state.json', '{}');
    const exported = await (await load('source-export.mjs')).exportSourceSnapshot({ repoDir: root, commit })
      .catch((error: { code?: string }) => { throw new Error(`export failed: ${error.code}`); });
    const queries = ['keep.ts', 'edit.ts', 'gone.ts', 'add.ts', '.moe/state.json'].map((name, i) => read(name, `r${i}`));
    const result = readSnapshotSource(exported, { commit, base: exported.base.digest, overlay: exported.overlay.digest }, queries);
    const { oid: _oid, ...committed } = (await readRepositorySource(root, commit, [queries[0]])).items[0];
    const { provenance, ...keep } = result.items[0];
    expect([committed.status, keep]).toEqual(['served', committed]);
    expect(provenance).toEqual({ layer: 'base', manifest: exported.base.digest, sha256: sha('keep\n') });
    const dirty = (text: string) => ({ layer: 'overlay', manifest: exported.overlay.digest, sha256: sha(text) });
    expect(result.items.slice(1).map(i => [i.status, i.reason, i.content, i.provenance])).toEqual([
      ['served', undefined, 'v2 dirty\n', dirty('v2 dirty\n')], ['missing', 'deleted-in-overlay', undefined, undefined],
      ['served', undefined, 'added\n', dirty('added\n')], ['refused', 'control-path', undefined, undefined]]);
    expect(result.manifest).toEqual({ commit, tree: exported.tree, base: exported.base.digest, overlay: exported.overlay.digest });
    expect(exported.excluded).toBe(1);
  });
});
