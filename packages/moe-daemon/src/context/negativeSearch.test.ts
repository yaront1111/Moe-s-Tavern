import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import type { GitHeadResult, GitHeadRunner } from '../util/cachedPlanPaths.js';
import { MoeErrorCode } from '../util/errors.js';
import { lookupNegative, negativeSearchKey, recordNegative, repositoryScopeGeneration, snapshotScopeGeneration, type NegativeQuery } from './negativeSearch.js';
import { readRepositorySource, type SourceLimits, type SourceQuery } from './repositorySource.js';
import { SNAPSHOT_CONTROL_SEGMENTS } from './snapshotManifest.js';
import { readSnapshotSource, type SnapshotRequest } from './snapshotSource.js';
import { SourceCache, sourceCacheKey } from './sourceCache.js';

const here = path.dirname(fileURLToPath(import.meta.url));
// Snapshot fixtures come from the landed R09a/R09b producers, absent in the Docker context (packages/moe-daemon only).
const runner = path.resolve(here, '../../../../scripts/local-runner');
const hasScripts = fs.existsSync(path.join(runner, 'source-snapshot.mjs'));
const load = async (name: string) => (hasScripts ? import(pathToFileURL(path.join(runner, name)).href) : null);
const [r09a, r09b] = [await load('source-snapshot.mjs'), await load('source-export.mjs')];
const dirs: string[] = [];
const scratch = (prefix: string) => { const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix))); dirs.push(dir); return dir; };
afterEach(() => { vi.restoreAllMocks(); });
afterAll(() => { for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true }); });
// A temp repository driven by a GIT_*-scrubbed git; commit() writes the files and commits them.
const gitEnv = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_'))), GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@x.test', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@x.test' };
type Repo = ReturnType<typeof repo>;
function repo(sha256 = false) {
  const root = scratch('moe-negative-repo-'), git = (...args: string[]) => execFileSync('git', args, { cwd: root, env: gitEnv, encoding: 'utf8' }).trim();
  const put = (files: Record<string, string>) => { for (const [name, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true }); fs.writeFileSync(path.join(root, name), text); } };
  const rm = (...names: string[]) => { for (const name of names) fs.rmSync(path.join(root, name)); };
  git('init', '-q', ...(sha256 ? ['--object-format=sha256'] : []));
  return { root, git, put, rm, commit: (files: Record<string, string>) => { put(files); git('add', '-A'); git('commit', '-q', '--allow-empty', '-m', 'c'); return git('rev-parse', 'HEAD'); } };
}

const LIT = 'helperFn';
const FILES = { 'src/a.ts': 'const a = 1;\n', 'src/b.ts': 'const b = 2;\n', 'docs/x.md': 'doc\n' };
const search = (paths?: string[], literal = LIT): SourceQuery => ({ id: 's', purpose: 'caller', op: 'search', literal, ...(paths ? { paths } : {}) });
const snapQ: NegativeQuery = { namespace: 'snapshot-literal', literal: LIT, paths: ['src'] };
const repoQ: NegativeQuery = { namespace: 'repository-literal', literal: LIT, paths: ['src'] };
const GEN = 'a'.repeat(64);
const invalid = expect.objectContaining({ code: MoeErrorCode.INVALID_INPUT });

describe('K1-K3 negative keys', () => {
  it('K1 one key per namespace, literal and scope set; scope order, duplicates and [] vs undefined do not matter', () => {
    const key = negativeSearchKey({ ...snapQ, paths: ['src', 'lib'] });
    expect([negativeSearchKey({ ...snapQ, paths: ['lib', 'src', 'lib'] }), negativeSearchKey({ ...snapQ, paths: [] })]).toEqual([key, negativeSearchKey({ ...snapQ, paths: undefined })]);
    const others = [{ ...snapQ, paths: ['src'] }, { ...snapQ, paths: ['src', 'lib'], literal: 'helperfn' }, { ...repoQ, paths: ['src', 'lib'] }];
    expect(new Set([key, ...others.map(negativeSearchKey)]).size).toBe(4);
  });
  it('K2 the key carries the version, namespace and the provider exclusions, inside the C04 key space', () => {
    expect(negativeSearchKey({ ...snapQ, paths: ['b', 'a'] })).toBe(sourceCacheKey(['negative-search', 1, 'snapshot-literal', LIT, ['a', 'b'], [...SNAPSHOT_CONTROL_SEGMENTS].sort()]));
    expect(negativeSearchKey({ ...repoQ, paths: undefined })).toBe(sourceCacheKey(['negative-search', 1, 'repository-literal', LIT, [], ['gitlinks']]));
  });
  it.each([null, undefined, [[]], { ...snapQ, namespace: 'semantic' }, { ...snapQ, literal: '' }, { ...snapQ, literal: 'a\nb' }, { ...snapQ, literal: 'x'.repeat(201) },
    { ...snapQ, paths: ['../x'] }, { ...snapQ, paths: 'src' }, { ...snapQ, paths: ['src/'] }, { ...snapQ, paths: ['src\\a.ts'] }])('K3 refuses the query %j with INVALID_INPUT everywhere', query => {
    const q = query as NegativeQuery, c = new SourceCache();
    for (const call of [() => negativeSearchKey(q), () => lookupNegative(c, q, GEN), () => recordNegative(c, q, { manifest: { commit: GEN.slice(24) }, items: [], complete: true, limitations: [], bytes: 0 }, GEN)]) expect(call).toThrow(invalid);
  });
});

// Records the C02b zero-match answer for q over snapshot s; verdict() then looks up s and also reports what C02b really answers now.
const zeroIn = (s: unknown, commit: string, q = snapQ, c = new SourceCache()) => {
  const result = readSnapshotSource(s, { commit }, [search(q.paths, q.literal)]);
  expect(result.items.map(i => [i.status, i.reason, i.matches])).toEqual([['served', undefined, []]]);
  expect(recordNegative(c, q, result, snapshotScopeGeneration(s, q.paths))).toEqual({ ok: true });
  return c;
};
const verdict = (c: SourceCache, s: { overlay: { entries: { kind: string; path: string }[] } }, commit: string, q = snapQ) =>
  [lookupNegative(c, q, snapshotScopeGeneration(s, q.paths)), readSnapshotSource(s, { commit }, [search(q.paths, q.literal)]).items[0].matches!.length, s.overlay.entries.map(e => `${e.kind}:${e.path}`)];

describe.skipIf(!hasScripts)('N1-N4, N9 snapshot-literal negatives over real Git and the real R09b export', () => {
  const exported = (r: Repo, commit: string) => r09b.exportSourceSnapshot({ repoDir: r.root, commit });
  it.each([
    ['N0 nothing changed', 'absent', (_r: Repo) => {}, 0, []],
    ['N1 an untracked helper under src', 'stale', (r: Repo) => r.put({ 'src/helper.ts': 'export const helperFn = 1;\n' }), 1, ['file:src/helper.ts']],
    ['N1 an untracked empty file under src', 'stale', (r: Repo) => r.put({ 'src/empty.ts': '' }), 0, ['file:src/empty.ts']],
    ['N2 a deleted file under src', 'stale', (r: Repo) => r.rm('src/b.ts'), 0, ['delete:src/b.ts']],
    ['N3 changed bytes under src', 'stale', (r: Repo) => r.put({ 'src/a.ts': 'const a = helperFn;\n' }), 1, ['file:src/a.ts']],
    ['N3 changed bytes without the literal', 'stale', (r: Repo) => r.put({ 'src/a.ts': 'const a = 9;\n' }), 0, ['file:src/a.ts']],
    ['N4 changes only under docs', 'absent', (r: Repo) => r.put({ 'docs/x.md': 'helperFn\n', 'docs/new.md': 'helperFn\n' }), 0, ['file:docs/new.md', 'file:docs/x.md']],
    ['N4 a sibling srcx/ outside the scope src', 'absent', (r: Repo) => r.put({ 'srcx/helper.ts': 'helperFn\n' }), 0, ['file:srcx/helper.ts']],
  ] as const)('%s: the src negative reads %s', async (_name, expected, change, matches, overlay) => {
    const r = repo(), commit = r.commit(FILES), c = zeroIn(await exported(r, commit), commit);
    change(r);
    expect(verdict(c, await exported(r, commit), commit)).toEqual([expected, matches, overlay]);
  });
  it('N2 a committed delete under src reads stale at the new commit', async () => {
    const r = repo(), commit = r.commit(FILES), c = zeroIn(await exported(r, commit), commit);
    r.rm('src/b.ts'); const next = r.commit({});
    expect(verdict(c, await exported(r, next), next)).toEqual(['stale', 0, []]);
  });
  it('N9 an already-dirty file rewritten with the same porcelain status, size and mtime reads stale', async () => {
    const r = repo(), commit = r.commit({ 'src/a.ts': 'const a = 0;\n' }), file = path.join(r.root, 'src/a.ts');
    const meta = () => { const st = fs.statSync(file); return [r.git('status', '--porcelain=v1'), st.size, st.mtimeMs]; };
    r.put({ 'src/a.ts': 'const v = 1;\n' }); fs.utimesSync(file, 1_700_000_000, 1_700_000_000);
    const before = meta(), c = zeroIn(await exported(r, commit), commit);
    r.put({ 'src/a.ts': 'helperFn(1);\n' }); fs.utimesSync(file, 1_700_000_000, 1_700_000_000);
    expect([before, meta()]).toEqual([['M src/a.ts', 13, 1_700_000_000_000], before]);
    expect(verdict(c, await exported(r, commit), commit)).toEqual(['stale', 1, ['file:src/a.ts']]);
  });
});

describe('N5 repository-literal negatives over real Git commits', () => {
  it.each([
    ['an unrelated docs commit', 'absent', { 'docs/y.md': 'helperFn\n' }, [], 0],
    ['a sibling srcx/ commit', 'absent', { 'srcx/h.ts': 'helperFn\n' }, [], 0],
    ['an empty commit', 'absent', {}, [], 0],
    ['a commit adding a helper under src', 'stale', { 'src/helper.ts': 'helperFn\n' }, [], 1],
    ['a commit changing bytes under src', 'stale', { 'src/a.ts': 'const a = 3;\n' }, [], 0],
    ['a commit deleting a file under src', 'stale', {}, ['src/b.ts'], 0],
  ] as const)('N5 %s: the src negative reads %s', async (_name, expected, files, removed, matches) => {
    const r = repo(), first = r.commit(FILES), c = new SourceCache();
    const zero = await readRepositorySource(r.root, first, [search(['src'])]);
    expect(zero.items.map(i => [i.status, i.reason, i.matches])).toEqual([['served', undefined, []]]);
    expect(recordNegative(c, repoQ, zero, await repositoryScopeGeneration(r.root, first, ['src']))).toEqual({ ok: true });
    r.rm(...removed); const next = r.commit(files);
    const now = await readRepositorySource(r.root, next, [search(['src'])]);
    expect([lookupNegative(c, repoQ, await repositoryScopeGeneration(r.root, next, ['src'])), now.items[0].matches!.length]).toEqual([expected, matches]);
  });
  it('N5 a SHA-256 repository: 64-hex entries generate the same way', async () => {
    const r = repo(true), first = r.commit(FILES), c = new SourceCache();
    expect(recordNegative(c, repoQ, await readRepositorySource(r.root, first, [search(['src'])]), await repositoryScopeGeneration(r.root, first, ['src']))).toEqual({ ok: true });
    const later = [r.commit({ 'docs/y.md': 'helperFn\n' }), r.commit({ 'src/helper.ts': 'helperFn\n' })];
    expect([first.length, ...await Promise.all(later.map(async x => lookupNegative(c, repoQ, await repositoryScopeGeneration(r.root, x, ['src']))))]).toEqual([64, 'absent', 'stale']);
  });
});

describe('N6 only a complete zero-match enumeration is recorded', () => {
  const twice = { 'src/a.ts': 'helperFn 1\nhelperFn 2\n', 'docs/x.md': 'x\n' };
  it.each([
    ['match-cap', ['src'], { maxMatches: 1 }, 'truncated', 'match-cap'],
    ['search-byte-cap', ['src'], { maxSearchBytes: 8 }, 'truncated', 'search-byte-cap'],
    ['total-byte-cap', ['src'], { maxTotalBytes: 1 }, 'omitted', 'total-byte-cap'],
    ['a missing scope', ['nope'], {}, 'missing', 'scope-not-in-manifest'],
  ] as const)('N6 C02 %s is refused with its status and reason', async (_name, paths, limits, status, reason) => {
    const r = repo(), commit = r.commit(twice), c = new SourceCache(), result = await readRepositorySource(r.root, commit, [search([...paths])], { limits });
    expect(result.items.map(i => [i.status, i.reason])).toEqual([[status, reason]]);
    expect([recordNegative(c, { ...repoQ, paths: [...paths] }, result, GEN), c.stats().entries]).toEqual([{ ok: false, reason: `${status}:${reason}` }, 0]);
  });
  it.each([['a directory that is no repository', false, /^repository: /], ['an unknown commit', true, /^manifest: /]])('N6 C02 unavailable for %s is refused', async (_name, isRepo, reason) => {
    const root = isRepo ? repo().root : scratch('moe-negative-plain-'), c = new SourceCache();
    const result = await readRepositorySource(root, 'e'.repeat(40), [search(['src'])]), item = result.items[0];
    expect([item.status, item.reason]).toEqual(['unavailable', expect.stringMatching(reason)]);
    expect([recordNegative(c, repoQ, result, GEN), c.stats().entries]).toEqual([{ ok: false, reason: `unavailable:${item.reason}` }, 0]);
  });
  it('N6 every other non-negative shape is refused and stores nothing', async () => {
    const r = repo(), commit = r.commit(twice), c = new SourceCache();
    const [zero, hit, pair, read] = await Promise.all([[search(['docs'])], [search(['src'])], [search(['docs']), { ...search(['docs']), id: 't' }],
      [{ id: 'r', purpose: 'source', op: 'read', path: 'docs/x.md' } as SourceQuery]].map(qs => readRepositorySource(r.root, commit, qs)));
    const cases: [unknown, NegativeQuery, string | null, string][] = [[{ ...zero, complete: false }, repoQ, GEN, 'incomplete'], [hit, repoQ, GEN, 'not-zero-match'],
      [pair, repoQ, GEN, 'not-single-search'], [read, repoQ, GEN, 'not-single-search'], [{ ...zero, items: [{ ...zero.items[0], reason: 'odd' }] }, repoQ, GEN, 'served:odd'],
      [{ ...zero, items: [{ ...zero.items[0], matches: undefined }] }, repoQ, GEN, 'not-zero-match'], [zero, snapQ, GEN, 'namespace-mismatch'],
      [zero, repoQ, null, 'generation-unknown'], [zero, repoQ, 'A'.repeat(64), 'generation-unknown'], [null, repoQ, GEN, 'not-single-search']];
    for (const [result, q, generation, reason] of cases) expect(recordNegative(c, q, result as never, generation)).toEqual({ ok: false, reason });
    expect([c.stats().entries, recordNegative(c, repoQ, zero, GEN), lookupNegative(c, repoQ, GEN)]).toEqual([0, { ok: true }, 'absent']);
  });

  describe.skipIf(!hasScripts)('C02b refusals', () => {
    const COMMIT = 'c'.repeat(40), TREE = 'd'.repeat(40);
    const file = (name: string, bytes: string | number[]) => ({ kind: 'file', path: name, executable: false, data: Uint8Array.from(typeof bytes === 'string' ? Buffer.from(bytes) : bytes) });
    const snap = () => ({ version: 1, commit: COMMIT, tree: TREE, excluded: 0, overlay: r09a.validateImport([{ kind: 'delete', path: 'docs/x.md' }]),
      base: r09a.validateImport([file('docs/x.md', 'x\n'), ...SRC()]) });
    const SRC = () => [file('src/a.ts', twice['src/a.ts']), file('src/bad.ts', [...Buffer.from('helperFn caf'), 0xe9, 0x0a])];
    const corrupt = () => { const s = snap(); return { ...s, base: { ...s.base, entries: s.base.entries.map((e: object) => ({ ...e, sha256: '0'.repeat(64) })) } }; };
    it.each([
      ['match-cap', ['src/a.ts'], { maxMatches: 1 }, { commit: COMMIT }, snap, 'truncated', 'match-cap'],
      ['search-byte-cap', ['src/a.ts'], { maxSearchBytes: 8 }, { commit: COMMIT }, snap, 'truncated', 'search-byte-cap'],
      ['an undecodable-only match', ['src/bad.ts'], {}, { commit: COMMIT }, snap, 'truncated', 'undecodable-match'],
      ['total-byte-cap', ['src/a.ts'], { maxTotalBytes: 1 }, { commit: COMMIT }, snap, 'omitted', 'total-byte-cap'],
      ['a scope not in the manifest', ['nope'], {}, { commit: COMMIT }, snap, 'missing', 'scope-not-in-manifest'],
      ['a scope deleted in the overlay', ['docs/x.md'], {}, { commit: COMMIT }, snap, 'missing', 'deleted-in-overlay'],
      ['a control scope', ['.moe'], {}, { commit: COMMIT }, snap, 'refused', 'control-path'],
      ['a stale snapshot', ['src'], {}, { commit: COMMIT, base: 'f'.repeat(64) }, snap, 'unavailable', 'snapshot-stale'],
      ['an unverifiable snapshot', ['src'], {}, { commit: COMMIT }, corrupt, 'unavailable', 'snapshot-unverifiable:SNAPSHOT_HASH_MISMATCH'],
    ] as const)('N6 C02b %s is refused with its status and reason', (_name, paths, limits, request, make, status, reason) => {
      const c = new SourceCache(), result = readSnapshotSource(make(), request as SnapshotRequest, [search([...paths])], { limits: limits as Partial<SourceLimits> });
      expect(result.items.map(i => [i.status, i.reason])).toEqual([[status, reason]]);
      expect([recordNegative(c, { ...snapQ, paths: [...paths] }, result, GEN), c.stats().entries]).toEqual([{ ok: false, reason: `${status}:${reason}` }, 0]);
    });
    it('N6 a zero-match search cut by the time budget is partial, never a negative', () => {
      // Call 1 sets the deadline, call 2 admits the search, call 3 (before the first file) finds the budget spent.
      let calls = 0; vi.spyOn(performance, 'now').mockImplementation(() => (++calls < 3 ? 0 : 5));
      const c = new SourceCache(), result = readSnapshotSource(snap(), { commit: COMMIT }, [search(['src'])], { limits: { timeBudgetMs: 1 } });
      expect([result.items.map(i => [i.status, i.reason, i.matches]), recordNegative(c, snapQ, result, GEN), c.stats().entries]).toEqual([[['truncated', 'time-budget', []]], { ok: false, reason: 'truncated:time-budget' }, 0]);
    });
    it('N7 an unverifiable snapshot has no generation, so a recorded negative reads unknown', () => {
      const q = { ...snapQ, literal: 'zzz' }, c = zeroIn(snap(), COMMIT, q);
      expect([snapshotScopeGeneration(corrupt(), ['src']), snapshotScopeGeneration({}, ['src']), lookupNegative(c, q, snapshotScopeGeneration(corrupt(), ['src'])), lookupNegative(c, q, snapshotScopeGeneration(snap(), ['src']))]).toEqual([null, null, 'unknown', 'absent']);
    });
    it('G1 the snapshot generation is the verified scope content: layering, identity and other scopes do not change it', () => {
      const a = snapshotScopeGeneration(snap(), ['src']), moved = { ...snap(), base: r09a.validateImport([file('src/a.ts', 'old\n'), file('src/bad.ts', 'x')]), overlay: r09a.validateImport(SRC()) };
      expect([a, snapshotScopeGeneration(moved, ['src']), snapshotScopeGeneration({ ...snap(), commit: 'e'.repeat(40) }, ['src']), snapshotScopeGeneration(snap(), ['src/a.ts']) === a, snapshotScopeGeneration(snap(), ['src', 'src/a.ts'])]).toEqual([expect.stringMatching(/^[0-9a-f]{64}$/), a, a, false, a]);
    });
  });
});

describe('N7, N8 an unknown generation or a lost entry is unknown, never absent', () => {
  const answer = (o: Partial<GitHeadResult>): GitHeadRunner => async () => ({ stdout: Buffer.alloc(0), truncated: false, exitCode: 0, stderr: '', ...o });
  it('N7 every Git failure, overflow or unparsable listing has no generation, so the negative reads unknown', async () => {
    const r = repo(), commit = r.commit(FILES), c = new SourceCache(), real = await repositoryScopeGeneration(r.root, commit, ['src']);
    expect(recordNegative(c, repoQ, await readRepositorySource(r.root, commit, [search(['src'])]), real)).toEqual({ ok: true });
    const heads: GitHeadRunner[] = [async () => { throw new Error('boom'); }, answer({ exitCode: 128 }), answer({ truncated: true }),
      answer({ stdout: Buffer.from('garbage\0') }), answer({ stdout: Buffer.from(`100644 blob ${'a'.repeat(40)}\tsrc/a.ts`) })];
    const generations = [...await Promise.all(heads.map(head => repositoryScopeGeneration(r.root, commit, ['src'], { head }))),
      await repositoryScopeGeneration(r.root, commit, ['src'], { run: async () => { throw new Error('no git'); } }), await repositoryScopeGeneration(r.root, 'e'.repeat(40), ['src']),
      await repositoryScopeGeneration(scratch('moe-negative-plain-'), commit, ['src'])];
    expect([real, ...generations]).toEqual([expect.stringMatching(/^[0-9a-f]{64}$/), ...Array(8).fill(null)]);
    expect([lookupNegative(c, repoQ, null), lookupNegative(c, repoQ, real)]).toEqual(['unknown', 'absent']);
    await expect(repositoryScopeGeneration(r.root, 'HEAD', ['src'])).rejects.toThrow(invalid);
  });
  it('N8 a cache miss, clear(), restart, eviction or malformed entry reads unknown', () => {
    const c = new SourceCache({ maxEntries: 1 }), key = negativeSearchKey(repoQ), zero = { manifest: { commit: 'e'.repeat(40) }, items: [{ ...search(['src']), status: 'served', matches: [], bytes: 0 }], complete: true, limitations: ['committed-bytes-only'], bytes: 0 };
    const reads = [lookupNegative(c, repoQ, GEN)];
    recordNegative(c, repoQ, zero as never, GEN); reads.push(lookupNegative(c, repoQ, GEN), lookupNegative(new SourceCache(), repoQ, GEN));
    c.clear(); reads.push(lookupNegative(c, repoQ, GEN));
    recordNegative(c, repoQ, zero as never, GEN); recordNegative(c, { ...repoQ, literal: 'other' }, zero as never, GEN); reads.push(lookupNegative(c, repoQ, GEN));
    for (const bad of [{ version: 1, key: 'x', namespace: 'repository-literal', generation: GEN }, { version: 2, generation: GEN }, { version: 1, generation: GEN, namespace: 'snapshot-literal' }, { version: 1, namespace: 'repository-literal' }, GEN]) { c.set(key, bad); reads.push(lookupNegative(c, repoQ, GEN)); }
    expect(reads).toEqual(['unknown', 'absent', ...Array(8).fill('unknown')]);
  });
  it('N10 freshness comes only from content: the module imports no filesystem, watcher or status source', () => {
    const text = fs.readFileSync(path.join(here, 'negativeSearch.ts'), 'utf8');
    expect([...text.matchAll(/from '([^']+)'/g)].map(m => m[1]).filter(m => /fs|chokidar|watch|child_process|state\//i.test(m))).toEqual([]);
    expect([...text.matchAll(/'(ls-tree|status|diff|diff-index|log|show)'/g)].map(m => m[1])).toEqual(['ls-tree', 'ls-tree']);
  });
});
